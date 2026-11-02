-- Migration 0006 already added drivers.gender, driver_applications.gender, and route metadata.
-- Preserve legacy 'unknown' values; only new driver applications require self-declared gender.
ALTER TABLE orders ADD COLUMN requested_gender TEXT CHECK (requested_gender IS NULL OR requested_gender IN ('male','female'));
-- Prices are stored as integer milli-dinars, matching the existing ledger/order money model.
ALTER TABLE orders ADD COLUMN final_price INTEGER;
CREATE TABLE IF NOT EXISTS geocode_cache (
  query TEXT PRIMARY KEY,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drivers_gender ON drivers(gender);
CREATE INDEX IF NOT EXISTS idx_orders_requested_gender ON orders(status,requested_gender);
