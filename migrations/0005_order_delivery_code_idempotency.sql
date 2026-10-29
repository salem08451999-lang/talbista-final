-- Add per-order delivery codes and idempotency keys without deleting or rebuilding orders.
ALTER TABLE orders ADD COLUMN delivery_code INTEGER NOT NULL DEFAULT 0
  CHECK (delivery_code = 0 OR delivery_code BETWEEN 1000 AND 9999);
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

-- Give existing orders a valid code while preserving their IDs, state, and history.
UPDATE orders
SET delivery_code = ABS(RANDOM() % 9000) + 1000
WHERE delivery_code = 0;

-- A key can be present on new customer orders only; multiple legacy/store rows may remain NULL.
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_key_unique
  ON orders(idempotency_key);

-- Any legacy/alternate insert that omits the code receives a random four-digit code.
CREATE TRIGGER IF NOT EXISTS orders_delivery_code_autogenerate
AFTER INSERT ON orders
WHEN NEW.delivery_code = 0
BEGIN
  UPDATE orders
  SET delivery_code = ABS(RANDOM() % 9000) + 1000
  WHERE id = NEW.id;
END;
