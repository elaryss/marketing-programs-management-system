-- =====================================================================
-- Initial schema for Marketing Program Management System
-- Module 3 (Execution) — toolkit, quotes, orders, assets
--
-- Loaded into Supabase via: supabase db push  (or paste into SQL Editor)
-- =====================================================================

-- Supabase has pgcrypto enabled by default; gen_random_uuid() is available.
-- If running outside Supabase, uncomment:
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------

CREATE TYPE program_status AS ENUM (
  'draft',
  'brief_in_progress',
  'vendor_briefing',
  'quotes_received',
  'buy_window_open',
  'buy_window_closed',
  'in_production',
  'complete'
);

CREATE TYPE item_category AS ENUM ('paper', 'display', 'premium');

CREATE TYPE quote_status AS ENUM ('open', 'selected', 'rejected', 'expired');

CREATE TYPE snapshot_type AS ENUM ('original', 'revised', 'requote', 'final');

CREATE TYPE asset_kind AS ENUM (
  'image',
  'spec_sheet',
  'quote_pdf',
  'proof',
  'final_art',
  'order_report',
  'other'
);

-- ---------------------------------------------------------------------
-- REFERENCE / LOOKUP TABLES
-- ---------------------------------------------------------------------

CREATE TABLE brands (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL UNIQUE,
  code                  text UNIQUE,
  category              text,                  -- PRM / LUX
  price_tier            text,                  -- Entry / Mid / Premium / Luxury
  target_audience       text,
  competitors           text,
  varietals             text,
  notes                 text,
  ai_research_summary   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE programs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id                 uuid REFERENCES brands(id) ON DELETE RESTRICT,
  name                     text NOT NULL,
  code                     text UNIQUE,
  focus_period             text,
  focus_period_code        text,
  shipping_wave            text,                -- Nov/Dec / Jan/Feb / Nov/Feb
  category                 text,                -- PRM / LUX
  theme                    text,
  status                   program_status NOT NULL DEFAULT 'draft',
  buy_window_open_date     date,
  buy_window_close_date    date,
  ship_date                date,
  -- AI research fields (populated by Brief Research Agent)
  ai_research_status       text,
  ai_market_research       text,
  ai_trend_summary         text,
  ai_competitive_context   text,
  ai_timeline_suggestions  text,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE item_types (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL UNIQUE,    -- "Case Sleeve", "Necker", "Gift Box", ...
  code                text UNIQUE,
  sub_category        text,
  element_zone        text,                    -- Display-DSP / Print-PRT / Premium-PRE
  default_category    item_category,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     text NOT NULL UNIQUE,
  email                    text,
  sourcing_responsibility  text,               -- ABC / IMS / JMS / Heard
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE countries (
  iso_code  text PRIMARY KEY,                  -- "US", "CN", "MX"
  name      text NOT NULL
);

CREATE TABLE pos_codes (
  code      text PRIMARY KEY,
  label     text,
  metadata  jsonb
);

CREATE TABLE ims_codes (
  code      text PRIMARY KEY,
  label     text,
  metadata  jsonb
);

CREATE TABLE srp3_codes (
  code      text PRIMARY KEY,
  label     text,
  metadata  jsonb
);

-- ---------------------------------------------------------------------
-- CORE OPERATIONAL TABLE — toolkit_items
-- One row per element in a program. Mirrors Excel "Toolkit - Sourcing" tab
-- but normalized: specs, quotes, orders, and assets are child tables.
-- ---------------------------------------------------------------------

CREATE TABLE toolkit_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id               uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  item_type_id             uuid REFERENCES item_types(id) ON DELETE SET NULL,

  -- Section 1 — Core Identification
  pos_number               text,                                  -- e.g., BVS27000PRT
  pos_code                 text REFERENCES pos_codes(code),
  shipping_wave            text,
  category                 item_category NOT NULL DEFAULT 'paper',

  -- Section 2 — Item Definition
  item_description         text,
  description_extended     text,
  sourcing_description     text,
  item_sub_category        text,
  standard_or_custom       text,                                  -- Standard / Custom

  -- Section 5 — Production & Commercials (item-level; quote tiers live in vendor_quotes)
  pack_out_qty             numeric,
  uom                      text,                                  -- CT / PK / RL / PD

  -- Section 8 — Operational Tracking
  vendor_id                uuid REFERENCES vendors(id) ON DELETE SET NULL,
  buyer                    text,
  country_code             text REFERENCES countries(iso_code),
  lead_time                text,                                  -- Long / Short
  new_or_rerun             text,                                  -- New / Rerun
  rerun_sku_no             text,
  inventory_available      boolean,
  pre_buy_status           text,                                  -- include / removed / POD

  -- Section 7 — Selected quote (Financial Outputs derive from this)
  selected_quote_id        uuid,                                  -- FK added below (forward ref)

  -- Section 10 — System Integration Fields
  ims_job_no               text,
  abc_po_no                text,
  ims_code                 text REFERENCES ims_codes(code),
  srp3_code                text REFERENCES srp3_codes(code),
  website_description      text,

  -- AI-suggested-by-agent metadata
  ai_suggested             boolean NOT NULL DEFAULT false,
  ai_element_notes         text,
  ai_reference_examples    text,
  ai_image_references      text,
  ai_research_status       text,

  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- SPECS — category-specific child tables (1:1 with toolkit_items)
-- Only paper for now. Add display_specs / premium_specs when needed.
-- ---------------------------------------------------------------------

CREATE TABLE paper_specs (
  toolkit_item_id      uuid PRIMARY KEY REFERENCES toolkit_items(id) ON DELETE CASCADE,
  flat_size            text,
  finished_size        text,
  material             text,
  coated_uncoated      text,
  same_different_art   text,
  num_colors           text,
  coating              text,
  finishing            text,
  collating            text,
  flat_dimensions      text,
  assembled_dimensions text,
  additional_specs     text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- VENDOR QUOTES — two-table model
-- quote_batches: one row per (vendor, item, quote-event). Holds shared
--   info like lead time, payment terms, source email.
-- vendor_quotes: one row per MOQ tier within a batch (1, 2, 3, ...).
-- ---------------------------------------------------------------------

CREATE TABLE quote_batches (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  toolkit_item_id         uuid NOT NULL REFERENCES toolkit_items(id) ON DELETE CASCADE,
  vendor_id               uuid NOT NULL REFERENCES vendors(id) ON DELETE RESTRICT,

  lead_time_days          int,
  payment_terms           text,
  validity_period         text,
  notes                   text,

  -- Provenance — where this quote came from (email parser, manual entry, etc.)
  source                  text,                  -- 'email' / 'manual' / 'pdf'
  source_email_subject    text,
  source_message_id       text,
  parse_confidence        numeric,               -- 0–1, from Quote Parser Agent
  ambiguities             text,

  status                  quote_status NOT NULL DEFAULT 'open',

  received_at             timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_batch_id      uuid NOT NULL REFERENCES quote_batches(id) ON DELETE CASCADE,

  tier_label          text,                      -- "MOQ 1", "MOQ 2", "Quote Option 4"
  tier_number         int,                       -- for sort

  moq                 numeric,                   -- minimum order qty
  qty_uom             numeric,                   -- order qty in pack units
  qty_eaches          numeric,                   -- order qty in individual units

  production_price    numeric,                   -- per UOM
  shipping_cost       numeric,                   -- per UOM (per-unit assumption locked 2026-05-27)
  tariff              numeric,                   -- per UOM

  -- Stored generated column: production_price + tariff + shipping_cost (NULL-safe).
  -- Recalculates automatically; readable in queries like any column.
  total_unit_price    numeric GENERATED ALWAYS AS (
    COALESCE(production_price, 0) +
    COALESCE(tariff, 0) +
    COALESCE(shipping_cost, 0)
  ) STORED,

  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Now that vendor_quotes exists, wire up the selected-quote FK on toolkit_items.
ALTER TABLE toolkit_items
  ADD CONSTRAINT toolkit_items_selected_quote_fk
  FOREIGN KEY (selected_quote_id) REFERENCES vendor_quotes(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- ORDER SNAPSHOTS — Original / Revised / Final audit trail
-- One row per snapshot per item. snapshot_type distinguishes the stage.
-- ---------------------------------------------------------------------

CREATE TABLE order_snapshots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  toolkit_item_id          uuid NOT NULL REFERENCES toolkit_items(id) ON DELETE CASCADE,
  snapshot_type            snapshot_type NOT NULL,

  -- Quantities
  ordered_qty              numeric,
  ordered_uom              text,
  requote_qty              numeric,                -- only used on 'requote' snapshots
  final_production_qty     numeric,                -- only used on 'final' snapshots
  sales_demand_qty         numeric,
  inventory_qty            numeric,

  -- Money
  budget_spend             numeric,
  investment_in_moq        numeric,
  production_price         numeric,                -- price at the time of this snapshot
  final_sales_price        numeric,                -- with tax (final only)
  final_production_spend   numeric,
  sales_budget_spend       numeric,
  inventory_spend          numeric,

  -- Flags
  plus_minus_moq           numeric,                -- +/- against MOQ at this point

  -- Status & notes specific to this snapshot
  status                   text,
  notes                    text,

  created_at               timestamptz NOT NULL DEFAULT now()
);

-- A toolkit item can only have one of each snapshot type (Original, Revised, Final).
-- Requote can repeat — drop it from the unique constraint.
CREATE UNIQUE INDEX uniq_one_snapshot_per_type
  ON order_snapshots (toolkit_item_id, snapshot_type)
  WHERE snapshot_type IN ('original', 'revised', 'final');

-- ---------------------------------------------------------------------
-- ASSETS — images, PDFs, docs, order reports
-- Files live in Supabase Storage; this table holds the URL + metadata.
-- ---------------------------------------------------------------------

CREATE TABLE assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Polymorphic-ish: an asset attaches to ONE of these. Exactly one FK should be set.
  toolkit_item_id   uuid REFERENCES toolkit_items(id) ON DELETE CASCADE,
  program_id        uuid REFERENCES programs(id) ON DELETE CASCADE,
  quote_batch_id    uuid REFERENCES quote_batches(id) ON DELETE CASCADE,

  kind              asset_kind NOT NULL,
  storage_bucket    text NOT NULL DEFAULT 'toolkit-assets',
  storage_path      text NOT NULL,               -- e.g., "BVS27000PRT/header_card.pdf"
  filename          text,
  mime_type         text,
  size_bytes        bigint,
  caption           text,
  sort_order        int DEFAULT 0,

  uploaded_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT assets_one_parent CHECK (
    (toolkit_item_id IS NOT NULL)::int +
    (program_id IS NOT NULL)::int +
    (quote_batch_id IS NOT NULL)::int = 1
  )
);

-- ---------------------------------------------------------------------
-- INDEXES — for the queries you'll actually run
-- ---------------------------------------------------------------------

CREATE INDEX idx_programs_brand           ON programs(brand_id);
CREATE INDEX idx_programs_status          ON programs(status);

CREATE INDEX idx_toolkit_items_program    ON toolkit_items(program_id);
CREATE INDEX idx_toolkit_items_vendor     ON toolkit_items(vendor_id);
CREATE INDEX idx_toolkit_items_type       ON toolkit_items(item_type_id);
CREATE INDEX idx_toolkit_items_category   ON toolkit_items(category);
CREATE INDEX idx_toolkit_items_pos        ON toolkit_items(pos_number);

CREATE INDEX idx_qb_item                  ON quote_batches(toolkit_item_id);
CREATE INDEX idx_qb_vendor                ON quote_batches(vendor_id);
CREATE INDEX idx_qb_status                ON quote_batches(status);
CREATE INDEX idx_vq_batch                 ON vendor_quotes(quote_batch_id);
CREATE INDEX idx_vq_price                 ON vendor_quotes(total_unit_price);

CREATE INDEX idx_snapshots_item           ON order_snapshots(toolkit_item_id);
CREATE INDEX idx_snapshots_type           ON order_snapshots(snapshot_type);

CREATE INDEX idx_assets_item              ON assets(toolkit_item_id);
CREATE INDEX idx_assets_program           ON assets(program_id);
CREATE INDEX idx_assets_quote             ON assets(quote_batch_id);

-- Full-text search across toolkit item descriptions
CREATE INDEX idx_toolkit_items_fts ON toolkit_items
  USING gin (to_tsvector('english',
    coalesce(item_description, '') || ' ' ||
    coalesce(description_extended, '') || ' ' ||
    coalesce(sourcing_description, '')
  ));

-- ---------------------------------------------------------------------
-- UPDATED_AT TRIGGER — keeps updated_at fresh on every UPDATE
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_brands_updated_at         BEFORE UPDATE ON brands         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_programs_updated_at       BEFORE UPDATE ON programs       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_toolkit_items_updated_at  BEFORE UPDATE ON toolkit_items  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_paper_specs_updated_at    BEFORE UPDATE ON paper_specs    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_quote_batches_updated_at  BEFORE UPDATE ON quote_batches  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- VIEW — wide "toolkit row" shape for Excel export
-- Recreates the flat Excel feel by joining items + paper_specs + selected
-- quote + latest snapshot. Use this to power your Excel/TSV export endpoint.
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW toolkit_wide AS
SELECT
  i.id                                AS toolkit_item_id,
  p.name                              AS program_name,
  p.focus_period,
  p.shipping_wave                     AS program_shipping_wave,
  b.name                              AS brand_name,
  b.category                          AS brand_category,
  i.pos_number,
  i.category                          AS item_category,
  it.name                             AS item_type,
  it.element_zone,
  i.item_description,
  i.description_extended,
  i.sourcing_description,
  i.standard_or_custom,
  -- Paper specs (NULL for non-paper items)
  ps.flat_size,
  ps.finished_size,
  ps.material,
  ps.coated_uncoated,
  ps.num_colors,
  ps.coating,
  ps.finishing,
  ps.collating,
  -- Production
  i.pack_out_qty,
  i.uom,
  -- Selected quote (the "Financial Outputs" section)
  v.name                              AS selected_vendor,
  vq.moq                              AS selected_moq,
  vq.production_price                 AS selected_production_price,
  vq.shipping_cost                    AS selected_shipping_cost,
  vq.tariff                           AS selected_tariff,
  vq.total_unit_price                 AS selected_total_unit_price,
  -- Operational tracking
  i.country_code,
  i.lead_time,
  i.new_or_rerun,
  i.pre_buy_status,
  i.ims_job_no,
  i.abc_po_no
FROM toolkit_items i
JOIN programs p           ON p.id = i.program_id
LEFT JOIN brands b        ON b.id = p.brand_id
LEFT JOIN item_types it   ON it.id = i.item_type_id
LEFT JOIN paper_specs ps  ON ps.toolkit_item_id = i.id
LEFT JOIN vendor_quotes vq ON vq.id = i.selected_quote_id
LEFT JOIN quote_batches qb ON qb.id = vq.quote_batch_id
LEFT JOIN vendors v        ON v.id = qb.vendor_id;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Permissive policies for now (solo-user capstone). Tighten before any
-- external sharing — see commented "stricter" examples at the bottom.
-- ---------------------------------------------------------------------

ALTER TABLE brands           ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_types       ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors          ENABLE ROW LEVEL SECURITY;
ALTER TABLE countries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ims_codes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE srp3_codes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE toolkit_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_specs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_batches    ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_quotes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets           ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read/write everything (capstone-scale default).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'brands','programs','item_types','vendors','countries','pos_codes',
    'ims_codes','srp3_codes','toolkit_items','paper_specs','quote_batches',
    'vendor_quotes','order_snapshots','assets'
  ] LOOP
    EXECUTE format('CREATE POLICY %I_auth_all ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);', t, t);
  END LOOP;
END $$;

-- When you're ready to tighten (e.g. brand stakeholders can only read their own brand's data):
--
-- CREATE POLICY programs_brand_read ON programs FOR SELECT TO authenticated
--   USING ( brand_id IN (SELECT brand_id FROM user_brand_access WHERE user_id = auth.uid()) );
--
-- CREATE POLICY toolkit_items_brand_read ON toolkit_items FOR SELECT TO authenticated
--   USING ( program_id IN (
--     SELECT id FROM programs WHERE brand_id IN
--       (SELECT brand_id FROM user_brand_access WHERE user_id = auth.uid())
--   ));

-- ---------------------------------------------------------------------
-- STORAGE BUCKETS — run these in Supabase Studio's Storage UI, or via:
--   supabase storage create-bucket toolkit-assets --public=false
--   supabase storage create-bucket order-reports --public=false
-- ---------------------------------------------------------------------
