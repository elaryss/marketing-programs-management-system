-- Seasons as a first-class entity.
--
-- Replaces the freetext `toolkit_items.pre_buy_program` string with a real
-- table so we can attach status (Planning → Sourcing → Production →
-- Fulfillment → Complete) and a single global "default" flag that the
-- Toolkit Manager uses to scope its initial load.
--
-- The freetext `pre_buy_program` column stays on `toolkit_items` for
-- transition + import-script compatibility. A BEFORE trigger keeps
-- `season_id` in sync from the freetext value via name lookup, so
-- existing importers keep working without changes (as long as the
-- matching season row exists in the new table — admin creates it once).

-- ---------------------------------------------------------------------
-- ENUM (chronological lifecycle order)
-- ---------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE season_status AS ENUM (
    'Planning', 'Sourcing', 'Production', 'Fulfillment', 'Complete'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------
-- seasons
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seasons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,
  status       season_status NOT NULL DEFAULT 'Planning',
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  seasons             IS 'Buy seasons (e.g. "F27 HL Buy") with lifecycle status and a single global default for toolkit-manager scoping.';
COMMENT ON COLUMN seasons.name        IS 'Human-readable season identifier, matches the freetext value in toolkit_items.pre_buy_program.';
COMMENT ON COLUMN seasons.status      IS 'Workflow stage. Informational today; reserved for automation hooks (auto-email, report-gen) later.';
COMMENT ON COLUMN seasons.is_default  IS 'Marks the season Toolkit Manager pre-loads on entry. Only one row may be true (enforced by partial unique index).';

-- Only one row can have is_default = true at a time
CREATE UNIQUE INDEX IF NOT EXISTS seasons_only_one_default
  ON seasons (is_default) WHERE is_default = true;

-- updated_at touch trigger
CREATE OR REPLACE FUNCTION touch_seasons_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_touch_seasons_updated_at ON seasons;
CREATE TRIGGER trg_touch_seasons_updated_at
  BEFORE UPDATE ON seasons
  FOR EACH ROW EXECUTE FUNCTION touch_seasons_updated_at();

-- ---------------------------------------------------------------------
-- toolkit_items.season_id (FK)
-- ---------------------------------------------------------------------
ALTER TABLE toolkit_items
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_toolkit_items_season_id ON toolkit_items(season_id);

-- ---------------------------------------------------------------------
-- BACKFILL — turn DISTINCT pre_buy_program values into season rows
-- ---------------------------------------------------------------------
INSERT INTO seasons (name, status)
SELECT DISTINCT pre_buy_program, 'Planning'::season_status
FROM toolkit_items
WHERE pre_buy_program IS NOT NULL AND pre_buy_program <> ''
ON CONFLICT (name) DO NOTHING;

-- Link existing items to their season by name match
UPDATE toolkit_items ti
SET season_id = s.id
FROM seasons s
WHERE ti.pre_buy_program = s.name
  AND ti.season_id IS NULL;

-- ---------------------------------------------------------------------
-- Sync trigger — keep season_id aligned with pre_buy_program on writes
-- so existing import scripts (which set pre_buy_program freetext) get
-- season_id auto-resolved by name lookup.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_toolkit_season_id() RETURNS trigger AS $$
BEGIN
  IF NEW.pre_buy_program IS NOT NULL AND NEW.pre_buy_program <> '' THEN
    IF NEW.season_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.pre_buy_program IS DISTINCT FROM OLD.pre_buy_program) THEN
      SELECT id INTO NEW.season_id FROM seasons WHERE name = NEW.pre_buy_program;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_toolkit_season_id ON toolkit_items;
CREATE TRIGGER trg_sync_toolkit_season_id
  BEFORE INSERT OR UPDATE OF pre_buy_program, season_id ON toolkit_items
  FOR EACH ROW EXECUTE FUNCTION sync_toolkit_season_id();

-- ---------------------------------------------------------------------
-- toolkit_wide view — extend with season_id, season_status, season_is_default
--
-- DROP + CREATE rather than OR REPLACE because the live view may have
-- pre_buy_program / spec_template inserted at positions not matching the
-- migration definition (CREATE OR REPLACE requires identical column order).
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS toolkit_wide;
CREATE VIEW toolkit_wide AS
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
  -- Selected quote
  v.name                              AS selected_vendor,
  vq.moq                              AS selected_moq,
  vq.production_price                 AS selected_production_price,
  vq.shipping_cost                    AS selected_shipping_cost,
  vq.tariff                           AS selected_tariff,
  vq.total_unit_price                 AS selected_total_unit_price,
  -- Operational
  i.country_code,
  i.lead_time,
  i.new_or_rerun,
  i.pre_buy_status,
  i.ims_job_no,
  i.abc_po_no,
  -- Season (joined name when FK present, freetext fallback otherwise)
  COALESCE(s.name, i.pre_buy_program) AS pre_buy_program,
  i.spec_template,
  i.season_id,
  s.status                            AS season_status,
  s.is_default                        AS season_is_default
FROM toolkit_items i
JOIN      programs       p   ON p.id  = i.program_id
LEFT JOIN brands         b   ON b.id  = p.brand_id
LEFT JOIN item_types     it  ON it.id = i.item_type_id
LEFT JOIN paper_specs    ps  ON ps.toolkit_item_id = i.id
LEFT JOIN vendor_quotes  vq  ON vq.id = i.selected_quote_id
LEFT JOIN quote_batches  qb  ON qb.id = vq.quote_batch_id
LEFT JOIN vendors        v   ON v.id  = qb.vendor_id
LEFT JOIN seasons        s   ON s.id  = i.season_id;

-- ---------------------------------------------------------------------
-- RLS — same permissive auth-all pattern as other reference tables
-- ---------------------------------------------------------------------
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY seasons_auth_all ON seasons
    FOR ALL TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
