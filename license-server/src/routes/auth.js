import express from 'express';
import passport from 'passport';
import db from '../db.js';
import { generateId, generateOneTimeCode, escapeHtml } from '../utils.js';

const router = express.Router();
const OTC_TTL_SECONDS = 90;

// ── GET /auth/google ─────────────────────────────────────────────────────────
// Desktop app opens this URL in the user's default browser.
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account',   // force account picker even if already signed in
}));

// ── GET /auth/google/callback ────────────────────────────────────────────────
// Google redirects here after the user consents.
router.get('/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/error' }),
  (req, res) => {
    const user = req.user;

    // Issue a short-lived one-time code
    const code      = generateOneTimeCode();
    const expiresAt = Math.floor(Date.now() / 1000) + OTC_TTL_SECONDS;

    db.prepare(`
      INSERT INTO one_time_codes (id, user_id, code, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(generateId('otc'), user.id, code, expiresAt);

    // Fetch subscription tier for display only
    const sub = db.prepare(`
      SELECT tier, max_hours_per_day FROM subscriptions
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).get(user.id);

    // Session no longer needed — destroy it immediately
    req.logout(() => {});

    res.send(buildSuccessPage(
      escapeHtml(user.display_name || user.email),
      code,
      sub?.tier ?? 'free',
      sub?.max_hours_per_day ?? 2,
      OTC_TTL_SECONDS,
    ));
  },
);

// ── GET /auth/error ──────────────────────────────────────────────────────────
router.get('/error', (_req, res) => {
  res.status(401).send(`<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><title>Login Failed</title>
    <style>
      body{font-family:sans-serif;background:#0a0a0a;color:#e0e0e0;
           display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
      .box{text-align:center}h2{color:#ef4444}p{color:#888;margin-top:8px}
    </style></head>
    <body><div class="box"><h2>❌ Login Failed</h2>
    <p>Please close this tab and try again.</p></div></body></html>`);
});

// ── Success page HTML ────────────────────────────────────────────────────────
function buildSuccessPage(name, code, tier, hours, ttl) {
  const tierColor = { free: '#6b7280', basic: '#3b82f6', pro: '#f59e0b' }[tier] ?? '#6b7280';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login Successful — Mining Dashboard</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0a0a0a;color:#e0e0e0;min-height:100vh;
         display:flex;align-items:center;justify-content:center}
    .card{background:#111;border:1px solid #222;border-radius:20px;
          padding:48px 40px;max-width:460px;width:90%;text-align:center;
          box-shadow:0 0 60px rgba(0,0,0,.6)}
    .icon{font-size:52px;margin-bottom:16px}
    h1{font-size:22px;font-weight:600;color:#fff;margin-bottom:6px}
    .sub{color:#666;font-size:14px;margin-bottom:28px}
    .badge{display:inline-block;border-radius:20px;padding:4px 16px;
           font-size:12px;font-weight:700;letter-spacing:.08em;
           text-transform:uppercase;margin-bottom:32px;
           background:${tierColor}22;color:${tierColor};border:1px solid ${tierColor}55}
    .label{font-size:11px;letter-spacing:.12em;color:#555;
           text-transform:uppercase;margin-bottom:10px}
    .code-wrap{background:#0d0d0d;border:2px solid #f59e0b;border-radius:12px;
               padding:22px;margin-bottom:10px;position:relative}
    .code{font-family:'Courier New',monospace;font-size:38px;font-weight:800;
          letter-spacing:.3em;color:#f59e0b;user-select:all}
    .copy-btn{background:#1a1a1a;border:1px solid #2a2a2a;color:#aaa;
              border-radius:8px;padding:8px 22px;cursor:pointer;font-size:13px;
              transition:all .15s;margin-bottom:8px}
    .copy-btn:hover{background:#222;color:#fff;border-color:#444}
    .copied{color:#22c55e;font-size:12px;min-height:18px;margin-bottom:20px}
    .timer{font-size:13px;color:#555;margin-bottom:28px}
    .timer span{font-weight:600;color:#f59e0b}
    .hint{font-size:13px;color:#555;line-height:1.7}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
    .expiring{animation:pulse 1s infinite;color:#ef4444 !important}
  </style>
</head>
<body>
<div class="card">
  <div class="icon">✅</div>
  <h1>Welcome, ${name}!</h1>
  <p class="sub">Google account verified successfully.</p>
  <span class="badge">${tier} plan · ${hours}h / day</span>

  <p class="label">Paste this code into the app</p>
  <div class="code-wrap" id="codeWrap">
    <div class="code" id="codeEl">${code}</div>
  </div>
  <button class="copy-btn" onclick="copyCode()">📋 Copy Code</button>
  <div class="copied" id="copiedMsg"></div>
  <p class="timer">Expires in <span id="countdown">${ttl}</span> seconds</p>

  <p class="hint">
    Switch back to the Mining Dashboard app<br>
    and paste this code where prompted.<br>
    You may then close this browser tab.
  </p>
</div>
<script>
  const raw = '${code}';
  let t = ${ttl};
  const cd = document.getElementById('countdown');
  const wrap = document.getElementById('codeWrap');
  const codeEl = document.getElementById('codeEl');

  const timer = setInterval(() => {
    t--;
    cd.textContent = t;
    if (t <= 15) { cd.classList.add('expiring'); }
    if (t <= 0) {
      clearInterval(timer);
      cd.textContent = 'EXPIRED';
      wrap.style.borderColor = '#ef4444';
      codeEl.style.color = '#ef4444';
    }
  }, 1000);

  function copyCode() {
    navigator.clipboard.writeText(raw).then(() => {
      const el = document.getElementById('copiedMsg');
      el.textContent = '✓ Copied to clipboard!';
      setTimeout(() => { el.textContent = ''; }, 2500);
    });
  }
</script>
</body>
</html>`;
}

export default router;
