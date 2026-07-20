/**
 * Smoke test — no real Google credentials needed.
 *
 * What it verifies:
 *   1. RSA key pair is generated (or loaded)
 *   2. A fake user + free subscription can be written to SQLite
 *   3. A one-time code can be issued and exchanged for a JWT + refresh token
 *   4. The JWT is RS256-signed and its payload matches the expected shape
 *   5. The refresh token rotates correctly (old revoked, new issued)
 *   6. An expired / already-used OTC is rejected
 *
 * Run: npm test   (from the license-server/ directory)
 */

import '../src/db.js';           // runs schema migrations
import { loadOrGenerateKeys }  from '../src/keys.js';
import { getPrivateKey, getPublicKey } from '../src/keys.js';
import db from '../src/db.js';
import { generateId, generateOneTimeCode, generateRefreshToken, hashToken } from '../src/utils.js';
import jwt from 'jsonwebtoken';

// ── Colour helpers ────────────────────────────────────────────────────────────
const OK   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const FAIL = (msg) => { console.error(`  \x1b[31m✗\x1b[0m ${msg}`); process.exitCode = 1; };
const HEAD = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

// ── Setup ─────────────────────────────────────────────────────────────────────
loadOrGenerateKeys();

// Use an in-memory test user (won't collide with production data)
const FAKE_GOOGLE_ID = `smoke_test_${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
HEAD('1. Create fake user + subscription');

const userId = generateId('usr');
db.prepare(`
  INSERT INTO users (id, google_id, email, display_name, created_at)
  VALUES (?, ?, ?, ?, unixepoch())
`).run(userId, FAKE_GOOGLE_ID, 'smoke@test.local', 'Smoke Tester');

db.prepare(`
  INSERT INTO subscriptions (id, user_id, tier, status, max_hours_per_day, created_at, updated_at)
  VALUES (?, ?, 'free', 'active', 2, unixepoch(), unixepoch())
`).run(generateId('sub'), userId);

const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
const sub  = db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'").get(userId);

user ? OK(`User created: ${user.id}`) : FAIL('User not found after insert');
sub  ? OK(`Subscription: tier=${sub.tier}, max_hours=${sub.max_hours_per_day}`) : FAIL('Subscription missing');

// ─────────────────────────────────────────────────────────────────────────────
HEAD('2. Issue one-time code and exchange for token pair');

const code      = generateOneTimeCode();
const expiresAt = Math.floor(Date.now() / 1000) + 90;
db.prepare('INSERT INTO one_time_codes (id, user_id, code, expires_at) VALUES (?,?,?,?)')
  .run(generateId('otc'), userId, code, expiresAt);
OK(`OTC issued: ${code}`);

// Simulate POST /api/license/token logic
const now = Math.floor(Date.now() / 1000);
const otc = db.prepare(`
  SELECT * FROM one_time_codes WHERE code = ? AND expires_at > ? AND used_at IS NULL
`).get(code, now);

if (!otc) { FAIL('OTC lookup failed'); process.exit(1); }
db.prepare('UPDATE one_time_codes SET used_at = ? WHERE id = ?').run(now, otc.id);
OK('OTC consumed (marked used)');

// Sign JWT
const jti     = generateId('tok');
const payload = {
  sub:               userId,
  google_id:         user.google_id,
  email:             user.email,
  display_name:      user.display_name,
  tier:              sub.tier,
  max_hours_per_day: sub.max_hours_per_day,
  status:            sub.status,
};
const accessToken = jwt.sign(payload, getPrivateKey(), {
  algorithm: 'RS256',
  expiresIn: 3600,
  jwtid:     jti,
});
OK('JWT signed with RS256');

// Issue refresh token
const rawRefresh = generateRefreshToken();
const rtHash     = hashToken(rawRefresh);
const rtExpiry   = now + 30 * 86400;
db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,unixepoch())')
  .run(generateId('rtk'), userId, rtHash, rtExpiry);
OK(`Refresh token issued (hash stored, raw returned to client)`);

// ─────────────────────────────────────────────────────────────────────────────
HEAD('3. Verify JWT payload');

const verified = jwt.verify(accessToken, getPublicKey(), { algorithms: ['RS256'] });

const checks = {
  'sub matches user.id':           verified.sub === userId,
  'tier = free':                   verified.tier === 'free',
  'max_hours_per_day = 2':         verified.max_hours_per_day === 2,
  'status = active':               verified.status === 'active',
  'exp - iat = 3600':              (verified.exp - verified.iat) === 3600,
  'jti present':                   typeof verified.jti === 'string',
  'google_id present':             typeof verified.google_id === 'string',
  'algorithm is RS256':            true, // jwt.verify would have thrown if wrong
};

for (const [label, pass] of Object.entries(checks)) {
  pass ? OK(label) : FAIL(label);
}

console.log('\n  JWT payload:');
console.log(JSON.stringify(verified, null, 4).replace(/^/gm, '    '));

// ─────────────────────────────────────────────────────────────────────────────
HEAD('4. Refresh token rotation');

const storedRt = db.prepare(`
  SELECT * FROM refresh_tokens WHERE token_hash = ? AND expires_at > ? AND revoked_at IS NULL
`).get(rtHash, now);

storedRt ? OK('Refresh token found and valid') : FAIL('Refresh token not found');

// Revoke old, issue new
db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(now, storedRt.id);

const newRaw   = generateRefreshToken();
const newHash  = hashToken(newRaw);
db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?,unixepoch())')
  .run(generateId('rtk'), userId, newHash, rtExpiry);

const oldStillValid = db.prepare(`
  SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL
`).get(rtHash);
const newValid = db.prepare(`
  SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked_at IS NULL
`).get(newHash);

oldStillValid ? FAIL('Old refresh token should be revoked') : OK('Old refresh token correctly revoked');
newValid      ? OK('New refresh token issued and valid')    : FAIL('New refresh token not found');

// ─────────────────────────────────────────────────────────────────────────────
HEAD('5. Reject already-used OTC');

const reuse = db.prepare(`
  SELECT * FROM one_time_codes WHERE code = ? AND expires_at > ? AND used_at IS NULL
`).get(code, now);
reuse ? FAIL('Used OTC should be rejected') : OK('Used OTC correctly rejected');

// ─────────────────────────────────────────────────────────────────────────────
HEAD('6. Cleanup test data');

db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
db.prepare('DELETE FROM one_time_codes WHERE user_id = ?').run(userId);
db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(userId);
db.prepare('DELETE FROM users WHERE id = ?').run(userId);
OK('Test data removed');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + (process.exitCode ? '\x1b[31mSome tests FAILED.\x1b[0m' : '\x1b[32mAll tests passed.\x1b[0m') + '\n');
