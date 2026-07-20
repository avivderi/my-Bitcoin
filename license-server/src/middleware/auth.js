import jwt from 'jsonwebtoken';
import { getPublicKey } from '../keys.js';

/**
 * Express middleware: verifies the RS256 JWT in the Authorization header.
 * On success, sets req.user to the decoded payload and calls next().
 * On failure, returns 401.
 */
export function requireJwt(req, res, next) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization: Bearer <token> header' });
  }

  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, getPublicKey(), { algorithms: ['RS256'] });
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired access token' });
  }
}
