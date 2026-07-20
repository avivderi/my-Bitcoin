import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, '..', 'keys');
const PRIVATE_PATH = path.join(KEYS_DIR, 'private.pem');
const PUBLIC_PATH  = path.join(KEYS_DIR, 'public.pem');

let _privateKey = null;
let _publicKey  = null;

/**
 * Call once at startup. Loads keys from disk, or generates a fresh RSA-2048
 * pair if none exist yet. The private key is chmod 600 (owner-read-only).
 */
export function loadOrGenerateKeys() {
  fs.mkdirSync(KEYS_DIR, { recursive: true });

  if (fs.existsSync(PRIVATE_PATH) && fs.existsSync(PUBLIC_PATH)) {
    _privateKey = fs.readFileSync(PRIVATE_PATH, 'utf8');
    _publicKey  = fs.readFileSync(PUBLIC_PATH,  'utf8');
    console.log('[keys] Loaded existing RSA-2048 key pair from keys/');
  } else {
    console.log('[keys] No key pair found — generating RSA-2048 key pair...');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    _privateKey = privateKey;
    _publicKey  = publicKey;
    // Restrict private key file to owner-only read
    fs.writeFileSync(PRIVATE_PATH, privateKey, { mode: 0o600 });
    fs.writeFileSync(PUBLIC_PATH,  publicKey,  { mode: 0o644 });
    console.log('[keys] Key pair saved to keys/ (private.pem is mode 600)');
  }
}

/** Returns the RSA private key PEM — used ONLY on the server to sign JWTs. */
export function getPrivateKey() {
  if (!_privateKey) throw new Error('Keys not loaded — call loadOrGenerateKeys() first');
  return _privateKey;
}

/** Returns the RSA public key PEM — safe to share with desktop clients. */
export function getPublicKey() {
  if (!_publicKey) throw new Error('Keys not loaded — call loadOrGenerateKeys() first');
  return _publicKey;
}
