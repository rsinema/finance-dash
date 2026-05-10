-- Plaid item = one bank connection (one access_token).
CREATE TABLE IF NOT EXISTS plaid_items (
  item_id           TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL,
  institution_id    TEXT,
  institution_name  TEXT,
  cursor            TEXT,
  last_synced_at    INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  item_id     TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  official_name TEXT,
  type        TEXT,
  subtype     TEXT,
  mask        TEXT,
  currency    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accounts_item ON accounts(item_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                     TEXT PRIMARY KEY,
  account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount                 REAL NOT NULL,
  iso_currency_code      TEXT,
  date                   TEXT NOT NULL,
  authorized_date        TEXT,
  name                   TEXT NOT NULL,
  merchant_name          TEXT,
  pending                INTEGER NOT NULL DEFAULT 0,
  plaid_category         TEXT,
  category               TEXT,
  confidence             REAL,
  classification_source  TEXT,
  needs_review           INTEGER NOT NULL DEFAULT 0,
  reviewed_at            INTEGER,
  deleted_at             INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_category_date ON transactions(category, date);
CREATE INDEX IF NOT EXISTS idx_tx_review ON transactions(needs_review) WHERE needs_review = 1;
CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant_name);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);

CREATE TABLE IF NOT EXISTS merchant_rules (
  merchant_key TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  confidence   REAL NOT NULL,
  source       TEXT NOT NULL,
  sample_name  TEXT,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  added        INTEGER NOT NULL DEFAULT 0,
  modified     INTEGER NOT NULL DEFAULT 0,
  removed      INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_log_item ON sync_log(item_id, started_at DESC);
