-- Existing tables are intentionally preserved. Store tables are additive.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  user_id TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  username TEXT,
  telegram_time TEXT NOT NULL,
  age TEXT NOT NULL,
  contact TEXT NOT NULL,
  reason TEXT NOT NULL,
  availability TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_applications_pending
ON applications(user_id, status);

CREATE TABLE IF NOT EXISTS store_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  username TEXT,
  first_name TEXT,
  kind TEXT NOT NULL DEFAULT 'purchase',
  prefix TEXT NOT NULL,
  months INTEGER NOT NULL,
  amount_rub INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  starts_at TEXT,
  expires_at TEXT,
  reminder_before_sent INTEGER NOT NULL DEFAULT 0,
  reminder_after_sent INTEGER NOT NULL DEFAULT 0,
  related_order_id INTEGER,
  rejection_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_store_orders_user ON store_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_store_orders_status ON store_orders(status);
CREATE INDEX IF NOT EXISTS idx_store_orders_expiry ON store_orders(status, expires_at);

CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  username TEXT,
  target_username TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL,
  photo_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at);
