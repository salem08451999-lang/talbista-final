-- All changes in this migration are additive. The existing User primary key, phone,
-- PBKDF2 password hash and createdAt columns are intentionally preserved.
ALTER TABLE "User" ADD COLUMN "name" TEXT;
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "User" ADD COLUMN "active" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "User" ADD COLUMN "photo" TEXT;

CREATE TABLE IF NOT EXISTS drivers (
  user_id INTEGER PRIMARY KEY,
  car TEXT, model TEXT, year INTEGER, color TEXT, plate TEXT, docs TEXT,
  available INTEGER NOT NULL DEFAULT 0, outstanding REAL NOT NULL DEFAULT 0,
  last_offer INTEGER NOT NULL DEFAULT 0, rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_n INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0,
  lat REAL, lng REAL, loc_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS drv_geo ON drivers(available,lat,lng);

CREATE TABLE IF NOT EXISTS driver_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, phone TEXT NOT NULL, password_hash TEXT,
  car TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL,
  color TEXT NOT NULL, plate TEXT NOT NULL, id_document TEXT, license_document TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING', submitted_at INTEGER NOT NULL,
  decision_by INTEGER, decided_at INTEGER, decision_note TEXT, approved_user_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS driver_app_pending_phone ON driver_applications(phone) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER, exp INTEGER);
CREATE TABLE IF NOT EXISTS session_contexts (token TEXT PRIMARY KEY, role TEXT);
CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, service_id INTEGER,
  pickup TEXT, dropoff TEXT, details TEXT, urgent INTEGER, status TEXT, driver_id INTEGER,
  agreed_price REAL, created INTEGER, confirmed INTEGER NOT NULL DEFAULT 0,
  proposed_price REAL, price_status TEXT NOT NULL DEFAULT 'NONE', kind TEXT NOT NULL DEFAULT 'CUSTOMER',
  contact TEXT, order_value REAL, is_paid INTEGER NOT NULL DEFAULT 0, delivery_fee REAL,
  notes TEXT, pickup_lat REAL, pickup_lng REAL, dropoff_lat REAL, dropoff_lng REAL,
  delivery_price REAL, price_source TEXT, commission INTEGER, order_type TEXT NOT NULL DEFAULT 'NO_PURCHASE',
  loyalty_reward_id INTEGER, is_demo INTEGER NOT NULL DEFAULT 0, price_expires INTEGER
);
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id,id);
CREATE INDEX IF NOT EXISTS orders_driver_status ON orders(driver_id,status,id);
CREATE INDEX IF NOT EXISTS orders_status_created ON orders(status,created,id);

CREATE TABLE IF NOT EXISTS order_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, status TEXT, actor INTEGER, at INTEGER);
CREATE INDEX IF NOT EXISTS osh_order ON order_status_history(order_id,id);
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, driver_id INTEGER, status TEXT, expires INTEGER, distance_m REAL);
CREATE INDEX IF NOT EXISTS offers_driver_status ON offers(driver_id,status,expires);
CREATE INDEX IF NOT EXISTS offers_order_status ON offers(order_id,status);
CREATE TABLE IF NOT EXISTS ratings (order_id INTEGER PRIMARY KEY, driver_id INTEGER, customer_id INTEGER, stars INTEGER, comment TEXT);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, at INTEGER, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,id);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, driver_id INTEGER, order_id INTEGER,
  kind TEXT, urgent INTEGER, base REAL, pct REAL, amount REAL, balance_after REAL, admin_id INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS cash_handovers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER, status TEXT, requested INTEGER,
  amount REAL, confirmed_at INTEGER, admin_id INTEGER
);
CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, actor INTEGER, action TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v REAL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS stores (user_id INTEGER PRIMARY KEY, store_name TEXT, manager_name TEXT, address TEXT, activity_type TEXT, lat REAL, lng REAL);
CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, order_id INTEGER, message TEXT, created INTEGER, status TEXT);

CREATE TABLE IF NOT EXISTS ledger_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, kind TEXT, order_id INTEGER, driver_id INTEGER,
  reason TEXT, source TEXT, actor_id INTEGER, approver_id INTEGER, request_id TEXT UNIQUE,
  corrects_txn_id INTEGER, meta TEXT
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, txn_id INTEGER, seq INTEGER, account TEXT,
  driver_id INTEGER, order_id INTEGER, amount INTEGER, at INTEGER
);
CREATE INDEX IF NOT EXISTS le_drv ON ledger_entries(driver_id,account,id);
CREATE INDEX IF NOT EXISTS le_ord ON ledger_entries(order_id);
CREATE INDEX IF NOT EXISTS le_txn ON ledger_entries(txn_id);
CREATE INDEX IF NOT EXISTS lt_drv ON ledger_txns(driver_id,id);
CREATE TABLE IF NOT EXISTS driver_accounts (driver_id INTEGER PRIMARY KEY, alert_since INTEGER, notified TEXT NOT NULL DEFAULT '', reconciled_at INTEGER);
CREATE TABLE IF NOT EXISTS settings_text (k TEXT PRIMARY KEY, v TEXT, updated_by INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS order_price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, price REAL, at INTEGER, actor_id INTEGER, reason TEXT);

CREATE TRIGGER IF NOT EXISTS lt_nu BEFORE UPDATE ON ledger_txns BEGIN SELECT RAISE(ABORT,'ledger immutable'); END;
CREATE TRIGGER IF NOT EXISTS lt_nd BEFORE DELETE ON ledger_txns BEGIN SELECT RAISE(ABORT,'ledger immutable'); END;
CREATE TRIGGER IF NOT EXISTS le_nu BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT,'ledger immutable'); END;
CREATE TRIGGER IF NOT EXISTS le_nd BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT,'ledger immutable'); END;
CREATE TRIGGER IF NOT EXISTS l_nu BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'ledger immutable'); END;
CREATE TRIGGER IF NOT EXISTS l_nd BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'ledger immutable'); END;

CREATE TABLE IF NOT EXISTS fcm_tokens (token TEXT PRIMARY KEY, user_id INTEGER, created INTEGER, channel_v INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS fcm_outbox (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL, token TEXT NOT NULL, payload TEXT NOT NULL,
  kind TEXT NOT NULL, created INTEGER NOT NULL, expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER, last_error TEXT
);
CREATE INDEX IF NOT EXISTS fcm_outbox_due ON fcm_outbox(status,next_attempt,created);
CREATE INDEX IF NOT EXISTS fcm_outbox_lease ON fcm_outbox(status,lease_until);
CREATE TABLE IF NOT EXISTS idempotency_requests (
  key TEXT PRIMARY KEY, user_id INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
  response TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idem_created ON idempotency_requests(created);
CREATE TABLE IF NOT EXISTS diagnostic_reports (
  report_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, role TEXT NOT NULL, created INTEGER NOT NULL,
  platform TEXT NOT NULL, app_version TEXT NOT NULL, category TEXT NOT NULL, code TEXT NOT NULL,
  route TEXT NOT NULL, http_status INTEGER, online INTEGER, push_ready INTEGER,
  retry_attempted INTEGER, retry_succeeded INTEGER
);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER, created INTEGER);
CREATE TABLE IF NOT EXISTS violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER, order_id INTEGER, reason TEXT, fine REAL,
  created INTEGER, blocked_until INTEGER, status TEXT, admin_id INTEGER,
  cancelled_by INTEGER, cancelled_at INTEGER, cancel_note TEXT
);

CREATE TABLE IF NOT EXISTS loyalty_settings (
  id INTEGER PRIMARY KEY CHECK(id=1), store_orders_required INTEGER NOT NULL DEFAULT 100,
  customer_orders_required INTEGER NOT NULL DEFAULT 10, store_free_start TEXT NOT NULL DEFAULT '14:00',
  store_free_end TEXT NOT NULL DEFAULT '19:00', updated_by INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS loyalty_progress (
  owner_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, progress INTEGER NOT NULL DEFAULT 0,
  cycle INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(owner_kind,owner_id)
);
CREATE TABLE IF NOT EXISTS loyalty_events (
  order_id INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id INTEGER NOT NULL,
  completed_at INTEGER NOT NULL, counted INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS loyalty_events_owner ON loyalty_events(owner_kind,owner_id,completed_at);
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_kind TEXT NOT NULL, owner_id INTEGER NOT NULL,
  reward_type TEXT NOT NULL, cycle INTEGER NOT NULL, status TEXT NOT NULL, earned_at INTEGER NOT NULL,
  reserved_order_id INTEGER UNIQUE, redeemed_at INTEGER, window_start INTEGER, window_end INTEGER,
  used_orders INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_kind,owner_id,reward_type,cycle)
);
CREATE INDEX IF NOT EXISTS loyalty_rewards_owner ON loyalty_rewards(owner_kind,owner_id,status);
CREATE TABLE IF NOT EXISTS loyalty_driver_credits (order_id INTEGER PRIMARY KEY, driver_id INTEGER NOT NULL, amount INTEGER NOT NULL, txn_id INTEGER NOT NULL, created_at INTEGER NOT NULL);

INSERT OR IGNORE INTO settings(k,v) VALUES
  ('auto_dispatch',1),('offer_timeout',60),('violation_fine',10),('violation_block_hours',24),
  ('max_active_orders',2),('location_max_age',600),('commission_normal',3),('commission_urgent',6),
  ('custody_warn',50),('custody_cap',100),('settle_days',7),('approval_threshold',200);
INSERT OR IGNORE INTO settings_text(k,v,updated_by,updated_at) VALUES
  ('android_latest_version','1.0.0',NULL,unixepoch()),
  ('android_minimum_version','1.0.0',NULL,unixepoch()),
  ('android_store_url','https://play.google.com/store/apps/details?id=ly.talbista.app',NULL,unixepoch()),
  ('ios_latest_version','1.0.0',NULL,unixepoch()),
  ('ios_minimum_version','1.0.0',NULL,unixepoch()),
  ('ios_store_url','',NULL,unixepoch()),
  ('update_message','يتوفر تحديث جديد لتطبيق طلبيستا. حدّث التطبيق للاستفادة من التحسينات.',NULL,unixepoch());
INSERT OR IGNORE INTO loyalty_settings(id,store_orders_required,customer_orders_required,store_free_start,store_free_end)
  VALUES(1,100,10,'14:00','19:00');
INSERT INTO services(name,active)
  SELECT 'شراء من مطعم',1 WHERE NOT EXISTS(SELECT 1 FROM services);
INSERT INTO services(name,active)
  SELECT 'شراء من محل',1 WHERE (SELECT COUNT(*) FROM services)=1;
INSERT INTO services(name,active)
  SELECT 'استلام أمانة/طرد',1 WHERE (SELECT COUNT(*) FROM services)=2;
INSERT INTO services(name,active)
  SELECT 'توصيل مستندات',1 WHERE (SELECT COUNT(*) FROM services)=3;
INSERT INTO services(name,active)
  SELECT 'مشوار خاص',1 WHERE (SELECT COUNT(*) FROM services)=4;
INSERT INTO services(name,active)
  SELECT 'مهمة أخرى',1 WHERE (SELECT COUNT(*) FROM services)=5;
