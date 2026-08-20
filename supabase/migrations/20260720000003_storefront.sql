-- =====================================================================
-- Storefront (customer-facing shopping page)
--
-- Adds the backend for site/shop.html: an optional product image per item,
-- customer accounts (kept distinct from ops staff), shipping addresses,
-- orders + order lines, and a read model (v_shop_items) that exposes only
-- items in a season whose status is 'Buy Window' and that have a portal price.
--
-- Unlike the permissive "authenticated can do everything" ops tables, the new
-- customer tables use STRICT, per-customer RLS: a shopper can see and write
-- only their own profile / addresses / orders (customer_id = auth.uid()).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Optional product photo on toolkit_items. Nullable — the storefront card
-- falls back to a category placeholder tile when this is empty.
-- ---------------------------------------------------------------------
ALTER TABLE toolkit_items
  ADD COLUMN IF NOT EXISTS shop_image_url text;

COMMENT ON COLUMN toolkit_items.shop_image_url IS
  'Optional product image URL shown on the customer storefront (site/shop.html). NULL → category placeholder.';

-- ---------------------------------------------------------------------
-- customer_profiles — one row per storefront account, keyed to the Supabase
-- auth user. Upserted by the shop on first successful sign-in.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name   text,
  company     text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- shipping_addresses — a customer's saved ship-to locations.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shipping_addresses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label        text,                       -- "HQ", "Store #482", ...
  recipient    text NOT NULL,
  line1        text NOT NULL,
  line2        text,
  city         text NOT NULL,
  region       text,                       -- state / province
  postal_code  text,
  country      text NOT NULL DEFAULT 'US',
  phone        text,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipping_addresses_customer ON shipping_addresses(customer_id);

-- ---------------------------------------------------------------------
-- orders — one per checkout. ship_to snapshots the address at purchase time
-- so later edits to shipping_addresses never rewrite order history.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no     bigint GENERATED ALWAYS AS IDENTITY,   -- human-friendly number
  customer_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  season_id    uuid REFERENCES seasons(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'submitted',     -- submitted / processing / shipped / cancelled
  ship_to      jsonb,                                 -- address snapshot
  subtotal     numeric,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_season   ON orders(season_id);

-- ---------------------------------------------------------------------
-- order_items — line items. unit_price / description snapshot the values at
-- purchase time (portal_price can change later).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  toolkit_item_id       uuid REFERENCES toolkit_items(id) ON DELETE SET NULL,
  qty                   numeric NOT NULL,
  unit_price            numeric,               -- portal_price at purchase
  line_total            numeric,               -- qty * unit_price
  description_snapshot  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- updated_at touch triggers (reuse the existing set_updated_at() from initial schema)
DROP TRIGGER IF EXISTS trg_customer_profiles_updated_at ON customer_profiles;
CREATE TRIGGER trg_customer_profiles_updated_at
  BEFORE UPDATE ON customer_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_shipping_addresses_updated_at ON shipping_addresses;
CREATE TRIGGER trg_shipping_addresses_updated_at
  BEFORE UPDATE ON shipping_addresses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_updated_at ON orders;
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- v_shop_items — storefront read model. Items in a 'Buy Window' season that
-- have a portal price. security_invoker so the caller's RLS on the underlying
-- catalog tables applies (matches toolkit_wide).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_shop_items
WITH (security_invoker = true) AS
SELECT
  i.id                 AS toolkit_item_id,
  i.item_description,
  i.description_extended,
  b.name               AS brand_name,
  i.category           AS item_category,
  it.name              AS item_type,
  i.portal_price,
  i.site_moq,
  i.uom,
  i.shop_image_url,
  p.name               AS program_name,
  s.id                 AS season_id,
  s.name               AS season_name
FROM toolkit_items i
JOIN      programs   p  ON p.id  = i.program_id
LEFT JOIN brands     b  ON b.id  = p.brand_id
LEFT JOIN item_types it ON it.id = i.item_type_id
JOIN      seasons    s  ON s.id  = i.season_id
WHERE s.status = 'Buy Window'
  AND i.portal_price IS NOT NULL;

GRANT SELECT ON v_shop_items TO authenticated;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY — strict, per-customer.
-- ---------------------------------------------------------------------
ALTER TABLE customer_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipping_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items        ENABLE ROW LEVEL SECURITY;

-- customer_profiles: a user manages only their own profile row.
DROP POLICY IF EXISTS customer_profiles_own ON customer_profiles;
CREATE POLICY customer_profiles_own ON customer_profiles
  FOR ALL TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- shipping_addresses: own rows only.
DROP POLICY IF EXISTS shipping_addresses_own ON shipping_addresses;
CREATE POLICY shipping_addresses_own ON shipping_addresses
  FOR ALL TO authenticated
  USING (customer_id = auth.uid())
  WITH CHECK (customer_id = auth.uid());

-- orders: own rows only.
DROP POLICY IF EXISTS orders_own ON orders;
CREATE POLICY orders_own ON orders
  FOR ALL TO authenticated
  USING (customer_id = auth.uid())
  WITH CHECK (customer_id = auth.uid());

-- order_items: reachable only through an order the customer owns.
DROP POLICY IF EXISTS order_items_own ON order_items;
CREATE POLICY order_items_own ON order_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.customer_id = auth.uid()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM orders o WHERE o.id = order_items.order_id AND o.customer_id = auth.uid()
  ));

-- NOTE: ops-side visibility of customer orders is intentionally NOT granted to
-- browser `authenticated` here (that would break customer isolation). A future
-- internal "Orders" admin view should read via the server-only service_role key.
