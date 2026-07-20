import express from 'express';
import Stripe from 'stripe';
import db from '../db.js';
import { generateId } from '../utils.js';
import { PLANS, planFromPriceId } from '../plans.js';
import { requireJwt } from '../middleware/auth.js';

const router = express.Router();

// ── Lazy Stripe client (fails clearly if key missing) ────────────────────────
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured in .env');
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

const baseUrl = () => process.env.BASE_URL ?? 'http://localhost:3456';

// ── GET /api/billing/plans ────────────────────────────────────────────────────
// Public — no auth. Desktop app calls this to render the upgrade UI.
router.get('/plans', (_req, res) => {
  const plans = Object.values(PLANS).map(({ tier, label, max_hours_per_day, amount_cents, currency }) => ({
    tier,
    label,
    max_hours_per_day,
    amount_cents,
    currency,
    unlimited: max_hours_per_day === 24,
  }));
  res.json({ plans });
});

// ── POST /api/billing/checkout ────────────────────────────────────────────────
// Protected. Desktop app sends its JWT; response contains a Stripe checkout URL
// to open in the user's browser.
router.post('/checkout', requireJwt, async (req, res) => {
  const { tier } = req.body ?? {};
  const plan = PLANS[tier];

  if (!plan?.price_id) {
    const paidTiers = Object.values(PLANS).filter(p => p.price_id).map(p => p.tier);
    return res.status(400).json({ error: `tier must be one of: ${paidTiers.join(', ')}` });
  }

  const userId = req.user.sub;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  try {
    const stripe = getStripe();
    const stripeCustomerId = await getOrCreateStripeCustomer(stripe, userId, user);

    const session = await stripe.checkout.sessions.create({
      customer:      stripeCustomerId,
      mode:          'subscription',
      line_items:    [{ price: plan.price_id, quantity: 1 }],
      success_url:   `${baseUrl()}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:    `${baseUrl()}/billing/cancel`,
      // Embed user_id so webhook can resolve it even if customer lookup fails
      metadata:               { user_id: userId },
      subscription_data:      { metadata: { user_id: userId } },
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[billing/checkout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/portal ──────────────────────────────────────────────────
// Protected. Returns a Stripe Customer Portal URL (cancel, see invoices, etc).
router.post('/portal', requireJwt, async (req, res) => {
  const userId = req.user.sub;
  const stored = db.prepare('SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ?').get(userId);

  if (!stored) {
    return res.status(404).json({ error: 'No billing account found — subscribe first.' });
  }

  try {
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
      customer:   stored.stripe_customer_id,
      return_url: `${baseUrl()}/billing/success`,
    });
    res.json({ portal_url: portal.url });
  } catch (err) {
    console.error('[billing/portal]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/billing/webhook (raw body — mounted in index.js before JSON parser)
export async function stripeWebhookHandler(req, res) {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).send('Webhook secret not configured');
  }

  // Verify Stripe signature against the raw body
  let event;
  try {
    event = Stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.warn('[webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature error: ${err.message}`);
  }

  // Idempotency guard — Stripe may deliver events more than once
  const seen = db.prepare('SELECT 1 FROM stripe_events WHERE stripe_event_id = ?').get(event.id);
  if (seen) {
    console.log(`[webhook] Duplicate event skipped: ${event.id}`);
    return res.json({ received: true });
  }

  try {
    await handleEvent(event);
    db.prepare('INSERT INTO stripe_events (stripe_event_id, event_type, processed_at) VALUES (?, ?, unixepoch())')
      .run(event.id, event.type);
    res.json({ received: true });
  } catch (err) {
    console.error(`[webhook] Error handling ${event.type}:`, err.message);
    res.status(500).send('Handler error');
  }
}

// ── Webhook event dispatcher ──────────────────────────────────────────────────
async function handleEvent(event) {
  const stripe = getStripe();

  switch (event.type) {

    case 'checkout.session.completed': {
      const session = event.data.object;
      if (session.mode !== 'subscription') break;

      const stripeSubId = session.subscription;
      const stripeSub   = await stripe.subscriptions.retrieve(stripeSubId);
      const priceId     = stripeSub.items.data[0]?.price?.id;
      const plan        = planFromPriceId(priceId) ?? PLANS.free;

      const userId = resolveUserId(session.customer, session.metadata?.user_id);
      if (!userId) { console.warn('[webhook] checkout.session.completed: unknown customer', session.customer); break; }

      applySubscriptionUpdate(userId, plan, 'active');
      console.log(`[webhook] checkout.session.completed → user ${userId} upgraded to ${plan.tier}`);
      break;
    }

    case 'customer.subscription.updated': {
      const stripeSub = event.data.object;
      const status    = stripeSub.status;

      const userId = resolveUserId(stripeSub.customer, stripeSub.metadata?.user_id);
      if (!userId) break;

      if (status === 'past_due') {
        // ⚠️  Product decision: warn only, no downgrade until Stripe sends `deleted`
        console.warn(`[webhook] past_due for user ${userId} — no action taken, waiting for Stripe retry schedule`);
        break;
      }

      if (status === 'active') {
        const priceId = stripeSub.items.data[0]?.price?.id;
        const plan    = planFromPriceId(priceId) ?? PLANS.free;
        applySubscriptionUpdate(userId, plan, 'active');
        console.log(`[webhook] subscription.updated → user ${userId} now on ${plan.tier}`);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      // Stripe's retry schedule fully exhausted — now downgrade to free
      const stripeSub = event.data.object;
      const userId    = resolveUserId(stripeSub.customer, stripeSub.metadata?.user_id);
      if (!userId) break;

      applySubscriptionUpdate(userId, PLANS.free, 'canceled');
      console.log(`[webhook] subscription.deleted → user ${userId} downgraded to free`);
      break;
    }

    default:
      console.log(`[webhook] Unhandled event type (ignored): ${event.type}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve our internal user_id from a Stripe customer ID.
 * Falls back to the metadata user_id we embed at checkout creation.
 */
function resolveUserId(stripeCustomerId, metadataUserId) {
  const stored = db.prepare('SELECT user_id FROM stripe_customers WHERE stripe_customer_id = ?')
    .get(stripeCustomerId);
  return stored?.user_id ?? metadataUserId ?? null;
}

/**
 * Update the active subscription row, or insert one if none exists.
 * This is the single place that mutates subscription state.
 */
function applySubscriptionUpdate(userId, plan, status) {
  const existing = db.prepare("SELECT id FROM subscriptions WHERE user_id = ? AND status = 'active'")
    .get(userId);

  if (existing) {
    db.prepare(`
      UPDATE subscriptions
      SET tier = ?, status = ?, max_hours_per_day = ?, updated_at = unixepoch()
      WHERE id = ?
    `).run(plan.tier, status, plan.max_hours_per_day, existing.id);
  } else {
    db.prepare(`
      INSERT INTO subscriptions (id, user_id, tier, status, max_hours_per_day, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(generateId('sub'), userId, plan.tier, status, plan.max_hours_per_day);
  }
}

/**
 * Get an existing Stripe customer for this user, or create one.
 */
async function getOrCreateStripeCustomer(stripe, userId, user) {
  const existing = db.prepare('SELECT stripe_customer_id FROM stripe_customers WHERE user_id = ?')
    .get(userId);
  if (existing) return existing.stripe_customer_id;

  const customer = await stripe.customers.create({
    email:    user.email,
    name:     user.display_name ?? undefined,
    metadata: { user_id: userId },
  });

  db.prepare('INSERT INTO stripe_customers (id, user_id, stripe_customer_id, created_at) VALUES (?, ?, ?, unixepoch())')
    .run(generateId('cus'), userId, customer.id);

  return customer.id;
}

// ── Minimal browser pages (opened after Stripe redirect) ──────────────────────
export function billingSuccessPage(_req, res) {
  res.send(infoPage('✅', 'Payment Successful', 'Your subscription is now active. You can close this tab and return to the Mining Dashboard.', '#22c55e'));
}

export function billingCancelPage(_req, res) {
  res.send(infoPage('❌', 'Payment Cancelled', 'No charge was made. You can close this tab and upgrade again any time.', '#ef4444'));
}

function infoPage(icon, title, body, color) {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><title>${title}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0a0a0a;color:#e0e0e0;min-height:100vh;
         display:flex;align-items:center;justify-content:center}
    .card{background:#111;border:1px solid #222;border-radius:20px;
          padding:48px 40px;max-width:440px;width:90%;text-align:center}
    .icon{font-size:52px;margin-bottom:16px}
    h1{font-size:22px;font-weight:600;color:${color};margin-bottom:12px}
    p{color:#888;line-height:1.7;font-size:15px}
  </style></head>
  <body><div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div></body></html>`;
}

export default router;
