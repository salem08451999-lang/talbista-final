-- Additive only: preserve existing orders, users, notifications and financial records.
ALTER TABLE orders ADD COLUMN delivery_code_hmac TEXT;
ALTER TABLE orders ADD COLUMN delivery_code_iv TEXT;
ALTER TABLE orders ADD COLUMN delivery_code_ciphertext TEXT;
ALTER TABLE orders ADD COLUMN delivery_code_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_code_locked_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN delivery_code_verified_at INTEGER;
ALTER TABLE orders ADD COLUMN driver_assigned_at INTEGER;
ALTER TABLE orders ADD COLUMN driver_on_the_way_at INTEGER;
ALTER TABLE orders ADD COLUMN driver_arrived_destination_at INTEGER;
ALTER TABLE orders ADD COLUMN assigned_reminder_enqueued_at INTEGER;
ALTER TABLE orders ADD COLUMN destination_reminder_enqueued_at INTEGER;

CREATE TABLE IF NOT EXISTS order_chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  sender_role TEXT NOT NULL CHECK(sender_role IN ('CUSTOMER','STORE','DRIVER')),
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS order_chat_messages_order ON order_chat_messages(order_id,id);

CREATE TABLE IF NOT EXISTS order_reminder_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  reminder_type TEXT NOT NULL CHECK(reminder_type IN ('ASSIGNED_NO_PROGRESS','ARRIVED_NOT_DELIVERED')),
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE(order_id,reminder_type,user_id)
);
CREATE INDEX IF NOT EXISTS order_reminder_outbox_pending ON order_reminder_outbox(delivered_at,created_at,id);

ALTER TABLE notifications ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
ALTER TABLE fcm_outbox ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS fcm_outbox_dedupe ON fcm_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Record stage start times for orders already in either reminder-eligible state.
UPDATE orders
SET driver_assigned_at=(
  SELECT MAX(h.at) FROM order_status_history h
  WHERE h.order_id=orders.id AND h.status='DRIVER_ASSIGNED'
)
WHERE status='DRIVER_ASSIGNED' AND driver_assigned_at IS NULL;
UPDATE orders
SET driver_arrived_destination_at=(
  SELECT MAX(h.at) FROM order_status_history h
  WHERE h.order_id=orders.id AND h.status='DRIVER_ARRIVED_DESTINATION'
)
WHERE status='DRIVER_ARRIVED_DESTINATION' AND driver_arrived_destination_at IS NULL;
