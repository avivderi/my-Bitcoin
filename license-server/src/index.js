import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

import { loadOrGenerateKeys } from './keys.js';
import db from './db.js';
import { generateId } from './utils.js';
import authRouter    from './routes/auth.js';
import licenseRouter from './routes/license.js';
import billingRouter, { stripeWebhookHandler, billingSuccessPage, billingCancelPage } from './routes/billing.js';
import adminRouter   from './routes/admin.js';

// ── RSA key pair must be loaded before any route signs a token ───────────────
loadOrGenerateKeys();

const app      = express();
const PORT     = process.env.PORT     ?? 3456;
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

// ── Stripe webhook: raw body MUST be registered before express.json() ──────────
// Stripe requires the raw Buffer to verify the webhook signature.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhookHandler);

// ── Body parsing (all other routes) ─────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Session (only used during the ~10s Google OAuth round-trip) ───────────────
app.use(session({
  secret:            process.env.SESSION_SECRET ?? 'change-me-in-production',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge:   5 * 60 * 1000, // 5 minutes — just enough for OAuth
  },
}));

function getAdminEmails() {
  const raw = process.env.ADMIN_EMAILS || '';
  return raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

// ── Passport: Google OAuth 2.0 ────────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  `${BASE_URL}/auth/google/callback`,
  },
  (_accessToken, _refreshToken, profile, done) => {
    try {
      const email = (profile.emails?.[0]?.value ?? '').trim().toLowerCase();
      const adminEmails = getAdminEmails();
      const isAdmin = adminEmails.includes(email) ? 1 : 0;

      let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(profile.id);

      if (!user) {
        const userId      = generateId('usr');
        const displayName = profile.displayName ?? '';

        db.prepare(`
          INSERT INTO users (id, google_id, email, display_name, is_admin, created_at)
          VALUES (?, ?, ?, ?, ?, unixepoch())
        `).run(userId, profile.id, email, displayName, isAdmin);

        // Every new user starts on the free tier (Phase 2 will add Stripe upgrades)
        db.prepare(`
          INSERT INTO subscriptions
            (id, user_id, tier, status, max_hours_per_day, created_at, updated_at)
          VALUES (?, ?, 'free', 'active', 2, unixepoch(), unixepoch())
        `).run(generateId('sub'), userId);

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      } else {
        // Update is_admin status on every login (supports revoking via ADMIN_EMAILS)
        db.prepare(`
          UPDATE users SET is_admin = ?, email = ?, display_name = ? WHERE id = ?
        `).run(isAdmin, email, profile.displayName ?? user.display_name, user.id);
        user.is_admin = isAdmin;
        user.email = email;
      }

      return done(null, user);
    } catch (err) {
      return done(err);
    }
  },
));

// Store only the user's internal ID in the session cookie
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  done(null, user ?? false);
});

app.use(passport.initialize());
app.use(passport.session());

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',         authRouter);
app.use('/api/license',  licenseRouter);
app.use('/api/billing',  billingRouter);
app.use('/api/admin',    adminRouter);

// Browser-facing pages opened after Stripe checkout redirect
app.get('/billing/success', billingSuccessPage);
app.get('/billing/cancel',  billingCancelPage);

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', service: 'license-server', ts: new Date().toISOString() }),
);

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[license-server] Listening on ${BASE_URL}`);
  console.log(`[license-server] Login URL:   ${BASE_URL}/auth/google`);
  console.log(`[license-server] Public key:  ${BASE_URL}/api/license/public-key`);
  console.log(`[license-server] Plans:        ${BASE_URL}/api/billing/plans`);
  console.log(`[license-server] Webhook:      ${BASE_URL}/api/billing/webhook`);
});
