import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'license.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode: better concurrent reads; foreign keys enforced
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    google_id    TEXT UNIQUE NOT NULL,
    email        TEXT NOT NULL,
    display_name TEXT,
    is_admin     INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id),
    tier              TEXT NOT NULL DEFAULT 'free'
                        CHECK(tier IN ('free','basic','pro')),
    status            TEXT NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','canceled','expired')),
    max_hours_per_day INTEGER NOT NULL DEFAULT 2,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Short-lived codes shown to the user after Google OAuth (90 second TTL)
  CREATE TABLE IF NOT EXISTS one_time_codes (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    code       TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );

  -- Long-lived refresh tokens stored by the desktop app (30-day TTL, rotated on use)
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    token_hash TEXT UNIQUE NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Indexes for hot query paths
  CREATE INDEX IF NOT EXISTS idx_otc_code       ON one_time_codes(code);
  CREATE INDEX IF NOT EXISTS idx_rtk_hash       ON refresh_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_sub_user       ON subscriptions(user_id);

  -- Phase 2: Stripe billing tables

  -- Maps internal user_id → Stripe customer_id (1:1)
  CREATE TABLE IF NOT EXISTS stripe_customers (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT UNIQUE NOT NULL REFERENCES users(id),
    stripe_customer_id TEXT UNIQUE NOT NULL,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Idempotency log: every processed Stripe webhook event ID is stored here.
  -- If Stripe re-delivers an event, we skip it immediately.
  CREATE TABLE IF NOT EXISTS stripe_events (
    stripe_event_id TEXT PRIMARY KEY,
    event_type      TEXT NOT NULL,
    processed_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_stripe_cus_user ON stripe_customers(user_id);
  CREATE INDEX IF NOT EXISTS idx_stripe_cus_id   ON stripe_customers(stripe_customer_id);
`);

// Idempotent migration for existing SQLite databases
try {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
} catch {
  // Column already exists — ignore
}

export default db;
