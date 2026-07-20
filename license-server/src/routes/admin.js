import express from 'express';
import Stripe from 'stripe';
import db from '../db.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Apply requireAdmin middleware to ALL admin routes
router.use(requireAdmin);

// Helper: get Stripe instance if key exists
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY.includes('REPLACE_ME')) {
    return null;
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

// ── GET /api/admin/users ──────────────────────────────────────────────────────
// Paginated list of all registered users and their current subscription tier/status.
router.get('/users', (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset ?? '0', 10) || 0, 0);

  const total = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  const users = db.prepare(`
    SELECT 
      u.id, 
      u.email, 
      u.display_name, 
      u.is_admin, 
      u.created_at,
      COALESCE(s.tier, 'free') AS tier,
      COALESCE(s.status, 'active') AS status
    FROM users u
    LEFT JOIN subscriptions s ON s.user_id = u.id AND s.id = (
      SELECT id FROM subscriptions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1
    )
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    users: users.map(u => ({
      ...u,
      is_admin: Boolean(u.is_admin),
    })),
    total,
    limit,
    offset,
  });
});

// ── GET /api/admin/revenue ────────────────────────────────────────────────────
// Real-time financial summary directly from Stripe's API.
router.get('/revenue', async (_req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.json({
        configured: false,
        message: 'STRIPE_SECRET_KEY is not configured',
        balance: null,
        recent_charges: [],
      });
    }

    const [balance, charges] = await Promise.all([
      stripe.balance.retrieve(),
      stripe.charges.list({ limit: 10 }),
    ]);

    res.json({
      configured: true,
      balance: {
        available: balance.available,
        pending:   balance.pending,
        livemode:  balance.livemode,
      },
      recent_charges: charges.data.map(c => ({
        id:          c.id,
        amount:      c.amount,
        currency:    c.currency,
        status:      c.status,
        paid:        c.paid,
        customer:    c.customer,
        created:     c.created,
        description: c.description,
      })),
    });
  } catch (err) {
    console.error('[admin/revenue]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
