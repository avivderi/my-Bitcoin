/**
 * license.mjs — License client for the Bitcoin Mining Dashboard
 *
 * Responsibilities:
 *   • First-run login: opens browser URL, prompts for one-time code via stdin
 *   • Startup refresh: exchanges stored refresh_token for a fresh JWT
 *   • Background refresh: silently refreshes every 55 min (5 min before 1h expiry)
 *   • Local JWT verification: RS256 signature checked against server public key
 *   • license.json: persists ONLY { refresh_token, tier, max_hours_per_day,
 *                   status, last_verified_at } — access_token NEVER touches disk
 *
 * Usage (from stratum-miner.mjs):
 *   import { initLicense, getLicenseInfo } from './license.mjs';
 *   await initLicense();          // must complete before pool connection
 *   getLicenseInfo()              // returns { tier, max_hours_per_day, status }
 */

import fs from 'fs';
import https from 'https';
import http from 'http';
import readline from 'readline';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────
const LICENSE_FILE   = path.join(__dirname, 'license.json');
const LICENSE_TMP    = path.join(__dirname, 'license.json.tmp');

// Resolved at runtime from process.env (already loaded by stratum-miner.mjs)
const serverUrl = () => (process.env.LICENSE_SERVER_URL || 'http://localhost:3456').replace(/\/$/, '');

// Access token lives ONLY in memory — never written to disk
let _accessToken     = null;
let _publicKeyPem    = null;
let _refreshTimer    = null;
let _lastKnownInfo   = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/** Returns the current license info from the in-memory JWT payload. */
export function getLicenseInfo() {
  if (!_accessToken) {
    if (_lastKnownInfo) return { ..._lastKnownInfo };
    return { tier: 'unknown', max_hours_per_day: 0, status: 'unknown' };
  }
  try {
    // Decode without verifying — payload was already verified on receipt
    const payload = jwt.decode(_accessToken);
    return {
      tier:              payload?.tier              ?? 'unknown',
      max_hours_per_day: payload?.max_hours_per_day ?? 0,
      status:            payload?.status            ?? 'unknown',
    };
  } catch {
    if (_lastKnownInfo) return { ..._lastKnownInfo };
    return { tier: 'unknown', max_hours_per_day: 0, status: 'unknown' };
  }
}

/**
 * Main entry point. Call once on startup before connecting to the pool.
 * Resolves when we have a valid in-memory access_token.
 */
export async function initLicense() {
  console.log('🔑 [License] Initializing license client...');

  const stored = loadLicenseFile();

  // 1. Fetch and cache the server's RSA public key (soft-fail if stored license exists)
  const pubKeyOk = await fetchPublicKey(!!stored?.refresh_token);
  if (!pubKeyOk && stored?.refresh_token) {
    console.warn('⚠️  [License] Could not reach license server at startup.');
    console.warn('   Mining will continue with last-known license tier.');
    _lastKnownInfo = {
      tier:              stored.tier,
      max_hours_per_day: stored.max_hours_per_day,
      status:            stored.status,
    };
    _accessToken = null;
    scheduleBackgroundRefresh();
    const info = getLicenseInfo();
    console.log(`✅ [License] Authenticated (offline mode) — Tier: ${info.tier}, Max hours/day: ${info.max_hours_per_day === 24 ? 'unlimited' : info.max_hours_per_day}`);
    return;
  }

  // 2. Attempt refresh from stored token, fall back to fresh login
  if (stored?.refresh_token) {
    const ok = await attemptRefresh(stored.refresh_token, /*isStartup=*/true);
    if (!ok) {
      console.log('⚠️  [License] Stored refresh token expired or revoked — starting fresh login...');
      await runLoginFlow();
    }
  } else {
    await runLoginFlow();
  }

  // 3. Schedule background refresh every 55 minutes
  scheduleBackgroundRefresh();

  const info = getLicenseInfo();
  console.log(`✅ [License] Authenticated — Tier: ${info.tier}, Max hours/day: ${info.max_hours_per_day === 24 ? 'unlimited' : info.max_hours_per_day}`);
}

// ─── Public key ──────────────────────────────────────────────────────────────

async function fetchPublicKey(allowSoftFail = false) {
  const url = `${serverUrl()}/api/license/public-key`;
  let lastErr;
  // Retry up to 4 times with exponential backoff before giving up
  for (let attempt = 0, wait = 2000; attempt < 4; attempt++, wait = Math.min(wait * 2, 16000)) {
    try {
      const pem = await httpGet(url);
      if (!pem.includes('BEGIN PUBLIC KEY')) throw new Error('Response does not look like a PEM public key');
      _publicKeyPem = pem;
      console.log(`🔐 [License] RSA public key fetched from ${url}`);
      return true;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        console.warn(`⚠️  [License] Public key fetch failed (attempt ${attempt + 1}/4): ${err.message} — retrying in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }
  if (allowSoftFail) {
    return false;
  }
  throw new Error(`[License] Could not fetch public key from license server: ${lastErr?.message}. Is license-server running at ${serverUrl()}?`);
}

// ─── Login flow (first-run or after refresh token expiry) ────────────────────

async function runLoginFlow() {
  const loginUrl = `${serverUrl()}/auth/google`;

  console.log('\n──────────────────────────────────────────────────────');
  console.log('  🔑  License Server Login Required');
  console.log('──────────────────────────────────────────────────────');
  console.log(`  1. Open this URL in your browser:\n\n     ${loginUrl}\n`);
  console.log('  2. Sign in with Google.');
  console.log('  3. Copy the 8-character code shown on the page.');
  console.log('  4. Paste it below (code expires in 90 seconds).');
  console.log('──────────────────────────────────────────────────────\n');

  const code = await promptUser('  Enter code: ');

  if (!code || code.trim().length === 0) {
    throw new Error('[License] No code entered — cannot authenticate.');
  }

  const result = await exchangeCode(code.trim().toUpperCase());
  await storeAndVerify(result);
}

function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ─── Token exchange ───────────────────────────────────────────────────────────

async function exchangeCode(code) {
  const url = `${serverUrl()}/api/license/token`;
  const body = JSON.stringify({ code });
  const raw = await httpPost(url, body);
  const data = JSON.parse(raw);
  if (data.error) throw new Error(`[License] Token exchange failed: ${data.error}`);
  if (!data.access_token || !data.refresh_token) throw new Error('[License] Server returned incomplete token response');
  return data;
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

/**
 * Attempt a refresh using the given refresh_token.
 * Returns true on success, false on auth failure (expired/revoked).
 * Throws on unexpected network errors.
 * @param {string} refreshToken
 * @param {boolean} isStartup - if true, network errors are treated as soft failures
 */
async function attemptRefresh(refreshToken, isStartup = false) {
  const url = `${serverUrl()}/api/license/refresh`;
  try {
    const raw = await httpPost(url, JSON.stringify({ refresh_token: refreshToken }));
    const data = JSON.parse(raw);

    if (data.error) {
      // 401-class errors: refresh token is invalid/expired → need re-login
      console.warn(`⚠️  [License] Refresh rejected by server: ${data.error}`);
      return false;
    }
    if (!data.access_token || !data.refresh_token) {
      console.warn('[License] Refresh response missing tokens');
      return false;
    }

    await storeAndVerify(data);
    return true;
  } catch (err) {
    if (isStartup) {
      // On startup, treat network failure as soft: keep old stored values, try connecting
      console.warn(`⚠️  [License] Could not reach license server at startup: ${err.message}`);
      console.warn('   Mining will continue with last-known license tier. Re-auth will retry on next start.');
      // Load stored tier/status into memory so getLicenseInfo() works
      const stored = loadLicenseFile();
      if (stored) {
        _lastKnownInfo = {
          tier:              stored.tier,
          max_hours_per_day: stored.max_hours_per_day,
          status:            stored.status,
        };
        _accessToken = null; // will be null until next successful refresh
      }
      return true; // Don't fall to login flow — server may just be unreachable
    }
    throw err; // Background refresh: let caller handle
  }
}

// ─── Store tokens + verify JWT ────────────────────────────────────────────────

/**
 * Receives a { access_token, refresh_token, ... } response,
 * verifies the access_token's RS256 signature, caches it in memory,
 * and persists the refresh_token (and plan metadata) to license.json.
 *
 * access_token is NEVER written to disk.
 */
async function storeAndVerify(tokenResponse) {
  const { access_token, refresh_token } = tokenResponse;

  // Ensure we have a public key (should always be true after initLicense)
  if (!_publicKeyPem) await fetchPublicKey();

  // Verify RS256 signature — rejects if tampered, wrong algorithm, or expired
  let payload;
  try {
    payload = jwt.verify(access_token, _publicKeyPem, { algorithms: ['RS256'] });
  } catch (err) {
    throw new Error(`[License] JWT verification failed: ${err.message}`);
  }

  // Store access_token in memory only
  _accessToken = access_token;

  _lastKnownInfo = {
    tier:              payload.tier,
    max_hours_per_day: payload.max_hours_per_day,
    status:            payload.status,
  };

  // Persist plan metadata + refresh_token to disk (atomic write)
  const licenseData = {
    refresh_token,
    tier:              payload.tier,
    max_hours_per_day: payload.max_hours_per_day,
    status:            payload.status,
    last_verified_at:  Math.floor(Date.now() / 1000),
  };

  try {
    fs.writeFileSync(LICENSE_TMP, JSON.stringify(licenseData, null, 2));
    fs.renameSync(LICENSE_TMP, LICENSE_FILE);
  } catch (err) {
    console.error(`❌ [License] Failed to write license.json: ${err.message}`);
    // Non-fatal — we still have a valid in-memory token
  }
}

// ─── Background refresh loop ─────────────────────────────────────────────────

function scheduleBackgroundRefresh() {
  // Clear any existing timer (e.g. re-init after login flow)
  if (_refreshTimer) clearTimeout(_refreshTimer);

  // Refresh 5 minutes before the 1-hour expiry = every 55 minutes
  const REFRESH_INTERVAL_MS = 55 * 60 * 1000;

  _refreshTimer = setTimeout(async function doRefresh() {
    const stored = loadLicenseFile();
    if (!stored?.refresh_token) {
      console.warn('⚠️  [License] Background refresh: no refresh_token in license.json — skipping');
      _refreshTimer = setTimeout(doRefresh, REFRESH_INTERVAL_MS);
      return;
    }

    // Use the same exponential backoff pattern as the pool's scheduleReconnect:
    // start at 2s, double each failure, cap at 30s, reset on success
    let wait = 2000;
    let succeeded = false;

    for (let attempt = 1; attempt <= 4 && !succeeded; attempt++) {
      try {
        const ok = await attemptRefresh(stored.refresh_token);
        if (ok) {
          succeeded = true;
          console.log('🔄 [License] Background token refresh successful');
        } else {
          // Server explicitly rejected token — re-login needed (don't crash miner)
          console.warn('⚠️  [License] Background refresh token was rejected. User must re-authenticate on next restart.');
          break;
        }
      } catch (err) {
        console.warn(`⚠️  [License] Background refresh attempt ${attempt}/4 failed: ${err.message}`);
        if (attempt < 4) {
          console.warn(`   Retrying in ${wait / 1000}s...`);
          await sleep(wait);
          wait = Math.min(wait * 2, 30000);
        } else {
          console.warn('⚠️  [License] All refresh retry attempts exhausted. Keeping last-known tier. Will retry in 55 min.');
        }
      }
    }

    // Schedule next refresh regardless of success/failure
    _refreshTimer = setTimeout(doRefresh, REFRESH_INTERVAL_MS);
  }, REFRESH_INTERVAL_MS);

  // Ensure the timer doesn't block process exit
  if (_refreshTimer.unref) _refreshTimer.unref();
}

// ─── license.json helpers ─────────────────────────────────────────────────────

function loadLicenseFile() {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8'));
    if (!data.refresh_token) return null;
    return data;
  } catch {
    return null;
  }
}

// ─── HTTP helpers (no extra dependencies — uses Node built-in http/https) ────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        // Treat 401 as a soft error (invalid token) rather than throwing
        if (res.statusCode === 401) {
          // Resolve with error payload so caller can check data.error
          resolve(data);
        } else if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after 10s`));
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
