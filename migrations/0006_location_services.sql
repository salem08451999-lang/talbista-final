-- Add location, route-pricing and service-eligibility fields without rebuilding existing tables.
ALTER TABLE orders ADD COLUMN pickup_name TEXT;
ALTER TABLE orders ADD COLUMN dropoff_name TEXT;
ALTER TABLE orders ADD COLUMN route_distance_m INTEGER;
ALTER TABLE orders ADD COLUMN max_price INTEGER;
ALTER TABLE orders ADD COLUMN customer_offer_price INTEGER;
ALTER TABLE orders ADD COLUMN female_driver_only INTEGER NOT NULL DEFAULT 0 CHECK (female_driver_only IN (0,1));
ALTER TABLE orders ADD COLUMN private_ride INTEGER NOT NULL DEFAULT 0 CHECK (private_ride IN (0,1));

-- Legacy and pending drivers remain unknown until a self-declared application or admin entry supplies a gender.
ALTER TABLE drivers ADD COLUMN gender TEXT NOT NULL DEFAULT 'unknown' CHECK (gender IN ('unknown','female','male'));
ALTER TABLE driver_applications ADD COLUMN gender TEXT NOT NULL DEFAULT 'unknown' CHECK (gender IN ('unknown','female','male'));

CREATE INDEX IF NOT EXISTS orders_service_dispatch_idx
  ON orders(status, female_driver_only, private_ride, created);

-- Per-customer estimate budget limits accidental/excessive calls to the upstream routing service.
CREATE TABLE IF NOT EXISTS location_estimate_rate_limits (
  user_id INTEGER NOT NULL,
  minute_bucket INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, minute_bucket)
);
