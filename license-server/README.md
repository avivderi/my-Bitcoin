# License Server

Standalone licensing and subscription backend for the Bitcoin Mining Dashboard SaaS.  
Handles Google OAuth login, issues RS256-signed JWTs, and manages refresh token rotation.

> **Phase scope:** Account creation + subscription management only.  
> Stripe payments (Phase 2), mining-app integration (Phase 3), and hour-limit enforcement (Phase 4) are out of scope here.

---

## Architecture overview

```
Desktop app                    License Server                    Google OAuth
    │                               │                                 │
    │── opens browser ─────────────▶│ GET /auth/google ───────────────▶│
    │                               │◀─ Google redirects ─────────────│
    │                               │  (find/create user in SQLite)    │
    │◀── browser shows OTC page ───│                                  │
    │    (user copies 8-char code)  │                                  │
    │                               │                                  │
    │── POST /api/license/token ───▶│  (validates OTC, signs JWT)      │
    │◀── { access_token,           │                                  │
    │      refresh_token } ─────────│                                  │
    │                               │                                  │
    │  (1 hour later, silently...)  │                                  │
    │── POST /api/license/refresh ─▶│  (rotates refresh token)         │
    │◀── { access_token,           │                                  │
    │      refresh_token } ─────────│                                  │
```

### Token design

| Token | TTL | Algorithm | Stored where |
|-------|-----|-----------|--------------|
| JWT (access token) | 1 hour | **RS256** — private key signs, app verifies with public key only | In memory / app state |
| Refresh token | 30 days | Opaque random — SHA-256 hash stored in DB | App local storage |
| One-time code | 90 seconds | 8-char alphanumeric | DB, single-use |

**RS256 rationale:** The app verifies tokens using only the public key (`GET /api/license/public-key`). The private key never leaves the server. Distributing a shared secret (HS256) in desktop software is trivially reversible and would let anyone forge valid tokens.

### JWT payload

```json
{
  "sub":               "usr_3f8a1c...",
  "google_id":         "109876543210",
  "email":             "user@example.com",
  "display_name":      "Aviv D.",
  "tier":              "free",
  "max_hours_per_day": 2,
  "status":            "active",
  "iat":               1721460000,
  "exp":               1721463600,
  "jti":               "tok_a1b2c3..."
}
```

- **`max_hours_per_day`** — Phase 4 reads this directly from the token without a DB call.
- **`jti`** — unique token ID; reserved for future revocation (Phase 4+).
- **`status`** — `active | canceled | expired`; Phase 4 rejects non-active immediately.

---

## Setup

### 1. Install dependencies

```bash
cd license-server
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your real values (see section below)
```

### 3. Google OAuth setup (Google Cloud Console)

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Authorized redirect URIs — add:
   - Development: `http://localhost:3456/auth/google/callback`
   - Production: `https://license.yourdomain.com/auth/google/callback`
5. Copy **Client ID** and **Client Secret** into your `.env`

> ⚠️ Do NOT add `http://127.0.0.1:...` loopback URIs — the current flow redirects through your server, not direct to the desktop app.

### 4. RSA key pair

Generated **automatically** on first startup in `keys/private.pem` and `keys/public.pem`.  
The private key is `chmod 600`. **Back up `keys/private.pem` securely** — losing it invalidates all issued tokens.

```
keys/
├── private.pem   ← server-only, never distribute
└── public.pem    ← safe to bundle in the desktop app
```

### 5. Run

```bash
# Development (auto-restarts on file change)
npm run dev

# Production
npm start
```

---

## API reference

### `GET /auth/google`
Redirect the user's browser here to start login. No parameters.

### `GET /auth/google/callback`
Handled by the server (Google redirects here). Returns an HTML page with the one-time code.

### `POST /api/license/token`
Exchange a one-time code for an access token + refresh token.

**Request:**
```json
{ "code": "ABCD1234" }
```

**Response:**
```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "a3f9...",
  "refresh_expires_in": 2592000
}
```

**Errors:** `400 code is required` | `401 Invalid or expired code`

### `POST /api/license/refresh`
Exchange a refresh token for a new token pair. **Rotates the refresh token** — the old one is immediately revoked.

**Request:**
```json
{ "refresh_token": "a3f9..." }
```

**Response:** Same shape as `/token`.

**Errors:** `400 refresh_token is required` | `401 Invalid or expired refresh token`

### `GET /api/license/public-key`
Returns the RSA public key in PEM format. The desktop app should fetch this once at startup to verify JWTs locally.

### `GET /health`
Returns `{ "status": "ok" }`.

---

## Testing (no Google credentials needed)

```bash
npm test
```

The smoke test creates a fake user directly in SQLite, exercises the full OTC→JWT→refresh flow, verifies the JWT payload shape, confirms refresh token rotation, and cleans up after itself.

---

## Database

SQLite file at `data/license.db`. Tables:

| Table | Purpose |
|-------|---------|
| `users` | Google-linked accounts |
| `subscriptions` | Tier + hour limit per user |
| `one_time_codes` | 90-second single-use codes from OAuth flow |
| `refresh_tokens` | 30-day rotating tokens stored by the app |

---

## Security notes

- Private key never leaves `keys/` and is excluded from git via `.gitignore`
- Refresh tokens are stored as SHA-256 hashes — a DB breach doesn't expose usable tokens
- One-time codes are single-use and expire in 90 seconds
- Sessions exist only during the OAuth round-trip (~5 min max TTL) and are destroyed after the code is shown
- Phase 4 should add `jti`-based JWT revocation for immediate cancellation enforcement
