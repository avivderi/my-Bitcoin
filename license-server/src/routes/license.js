import express from 'express';
import jwt from 'jsonwebtoken';
import db from '../db.js';
import { getPrivateKey, getPublicKey } from '../keys.js';
import { generateId, generateRefreshToken, hashToken } from '../utils.js';

const router = express.Router();
const ACCESS_TOKEN_TTL  = 60 * 60;          // 1 hour in seconds
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

// ── Helper: load active subscription for a user ──────────────────────────────
function getActiveSubscription(userId) {
  return db.prepare(`
    SELECT * FROM subscriptions
    WHERE user_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(userId);
}

// ── Helper: build signed JWT + issue fresh refresh token ─────────────────────
function issueTokenPair(user) {
  const sub = getActiveSubscription(user.id);
  if (!sub && !user.is_admin) throw new Error('No active subscription for user');

  const isAdmin = Boolean(user.is_admin);
  const jti = generateId('tok');

  // JWT payload — override tier and max_hours_per_day for admin users
  const payload = {
    sub:               user.id,
    google_id:         user.google_id,
    email:             user.email,
    display_name:      user.display_name ?? '',
    tier:              isAdmin ? 'admin'  : sub.tier,
    max_hours_per_day: isAdmin ? 24       : sub.max_hours_per_day,
    status:            isAdmin ? 'active' : sub.status,
    // iat and exp are added automatically by jsonwebtoken
  };

  const accessToken = jwt.sign(payload, getPrivateKey(), {
    algorithm: 'RS256',
    expiresIn: ACCESS_TOKEN_TTL,
    jwtid:     jti,
  });

  // Opaque refresh token: raw goes to client, hash stored in DB
  const raw       = generateRefreshToken();
  const tokenHash = hashToken(raw);
  const expiresAt = Math.floor(Date.now() / 1000) + REFRESH_TOKEN_TTL;

  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, unixepoch())
  `).run(generateId('rtk'), user.id, tokenHash, expiresAt);

  return {
    access_token:      accessToken,
    token_type:        'Bearer',
    expires_in:        ACCESS_TOKEN_TTL,
    refresh_token:     raw,
    refresh_expires_in: REFRESH_TOKEN_TTL,
  };
}

// ── POST /api/license/token ──────────────────────────────────────────────────
// Exchange a one-time code (from the OAuth success page) for a token pair.
router.post('/token', (req, res) => {
  const { code } = req.body ?? {};

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'code is required' });
  }

  const now = Math.floor(Date.now() / 1000);
  const otc = db.prepare(`
    SELECT * FROM one_time_codes
    WHERE code = ? AND expires_at > ? AND used_at IS NULL
  `).get(code.trim().toUpperCase(), now);

  if (!otc) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // Mark code as consumed (one-time use)
  db.prepare('UPDATE one_time_codes SET used_at = ? WHERE id = ?')
    .run(now, otc.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(otc.user_id);
  if (!user) return res.status(500).json({ error: 'User record not found' });

  try {
    return res.json(issueTokenPair(user));
  } catch (err) {
    console.error('[license/token]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/license/refresh ────────────────────────────────────────────────
// Exchange a refresh token for a new token pair (token rotation).
// The old refresh token is revoked immediately; a new one is returned.
router.post('/refresh', (req, res) => {
  const { refresh_token } = req.body ?? {};

  if (!refresh_token || typeof refresh_token !== 'string') {
    return res.status(400).json({ error: 'refresh_token is required' });
  }

  const now       = Math.floor(Date.now() / 1000);
  const tokenHash = hashToken(refresh_token);

  const stored = db.prepare(`
    SELECT * FROM refresh_tokens
    WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL
  `).get(tokenHash, now);

  if (!stored) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  // Revoke the old token before issuing a new one (rotation prevents reuse)
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?')
    .run(now, stored.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(stored.user_id);
  if (!user) return res.status(500).json({ error: 'User record not found' });

  try {
    return res.json(issueTokenPair(user));
  } catch (err) {
    console.error('[license/refresh]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/license/public-key ──────────────────────────────────────────────
// Desktop app fetches this once at startup to verify JWTs locally.
// No auth required — this is intentionally public.
router.get('/public-key', (_req, res) => {
  res.type('text/plain').send(getPublicKey());
});

export default router;
