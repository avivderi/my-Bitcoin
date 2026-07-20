/**
 * Plan definitions — single source of truth.
 *
 * To change prices:
 *   1. Update amount_cents here (informational display only).
 *   2. Update the price in your Stripe dashboard.
 *   3. Update STRIPE_PRICE_BASIC / STRIPE_PRICE_PRO in .env to match the new price ID.
 *
 * max_hours_per_day = 24 is used as the "unlimited" sentinel for Pro
 * (you physically cannot mine more than 24 h/day, so Phase 4 treats 24 as no limit).
 */

export const PLANS = {
  free: {
    tier:              'free',
    label:             'Free',
    max_hours_per_day: 2,
    amount_cents:      0,
    currency:          'usd',
    price_id:          null,  // no Stripe price — free tier never goes through checkout
  },
  basic: {
    tier:              'basic',
    label:             'Basic',
    max_hours_per_day: 8,
    amount_cents:      500,   // $5.00/month — informational; Stripe price is authoritative
    currency:          'usd',
    price_id:          process.env.STRIPE_PRICE_BASIC ?? null,
  },
  pro: {
    tier:              'pro',
    label:             'Pro',
    max_hours_per_day: 24,    // sentinel = unlimited
    amount_cents:      1200,  // $12.00/month
    currency:          'usd',
    price_id:          process.env.STRIPE_PRICE_PRO ?? null,
  },
};

/**
 * Look up a plan by Stripe price ID.
 * Returns null if the price ID is unknown (caller should fall back to free).
 */
export function planFromPriceId(priceId) {
  if (!priceId) return null;
  return Object.values(PLANS).find(p => p.price_id === priceId) ?? null;
}

/** List of tiers that require a paid Stripe subscription. */
export const PAID_TIERS = ['basic', 'pro'];
