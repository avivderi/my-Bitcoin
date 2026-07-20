import crypto from 'crypto';

/**
 * Generate a URL-safe prefixed ID.
 * Example: generateId('usr') → 'usr_3f8a1c2b9e7d4a6f'
 */
export function generateId(prefix = '') {
  const raw = crypto.randomBytes(12).toString('hex');
  return prefix ? `${prefix}_${raw}` : raw;
}

/**
 * Generate an 8-character uppercase one-time code.
 * Uses an unambiguous alphabet (no 0/O, 1/I confusion).
 */
export function generateOneTimeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const byte of bytes) code += chars[byte % chars.length];
  return code;
}

/**
 * Generate a cryptographically random refresh token (opaque, 40 bytes hex).
 */
export function generateRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

/**
 * SHA-256 hash a token before storing it in the DB.
 * The raw token is given to the client; only the hash lives in the DB.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Minimal HTML escaping for values interpolated into the success page.
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
