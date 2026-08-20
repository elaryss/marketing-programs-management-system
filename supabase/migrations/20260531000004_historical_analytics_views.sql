-- =====================================================================
-- Historical Analytics Views
-- Powers the Historical Analytics dashboard + notebook.
-- Marketing Operations Analyst persona: workflow & ordering patterns,
-- spend over time / by brand, cancellation analysis.
--
-- Source-of-truth view is v_item_outcomes (one row per toolkit_item).
-- All other views aggregate from it so totals never diverge.
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_item_outcomes  —  one row per toolkit_item with derived season,
--                     outcome bucket, and joined dimensions.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_item_outcomes CASCADE;

CREATE VIEW v_item_outcomes AS
SELECT
  i.id                              AS toolkit_item_id,
  i.pos_number,
  p.id                              AS program_id,
  p.name                            AS program_name,
  b.id                              AS brand_id,
  b.name                            AS brand_name,
  b.category                        AS brand_category,
  it.name                           AS item_type,
  i.category::text                  AS item_category,
  v.name                            AS vendor_name,
  i.lead_time,
  i.standard_or_custom,
  i.new_or_rerun,
  i.country_code,

  -- Time dimensions derived from pre_buy_program (e.g. "F26 HL Buy")
  i.pre_buy_program,
  COALESCE(substring(i.pre_buy_program from '^(F\d+)'),     'Unknown') AS fiscal_year,
  COALESCE(substring(i.pre_buy_program from 'F\d+\s+(\w+)'),'Unknown') AS buy_wave,

  -- Pre-buy + final-status classification
  i.pre_buy_status,
  os_f.status                       AS final_status_raw,
  CASE
    WHEN i.pre_buy_status = 'removed'             THEN 'removed_prebuy'
    WHEN i.pre_buy_status = 'POD'                 THEN 'pod_prebuy'
    WHEN i.pre_buy_status = 'Post on ABC Merch'   THEN 'abc_merch_prebuy'
    WHEN os_f.status ILIKE 'Approved%'            THEN 'approved'
    WHEN os_f.status ILIKE 'Cancel - POD%'        THEN 'cancel_pod'
    WHEN os_f.status ILIKE 'Cancel%'              THEN 'cancel_cancelled'
    WHEN os_f.status ILIKE 'Part of a Kit%'       THEN 'part_of_kit'
    WHEN os_f.status ILIKE 'Inventory%'           THEN 'inventory_fulfilled'
    WHEN os_f.status ILIKE 'Requot%'              THEN 'requoting'
    -- In this dataset "fulfilled from inventory" is captured on the REVISED snapshot
    -- as status='inventory' / 'Inventory' / 'use inventory' / 'ok- inventory'.
    -- Items end there: they don't get a final snapshot because no production happens.
    WHEN os_f.id IS NULL AND os_rev.status ILIKE '%inventory%' THEN 'inventory_fulfilled'
    WHEN os_f.id IS NULL AND os_rq.id IS NOT NULL THEN 'in_flight_requoting'
    WHEN os_f.id IS NULL                          THEN 'no_outcome'
    ELSE 'unknown'
  END                                AS final_outcome,

  -- Inventory signal (orthogonal to outcome — Approved items may also
  -- have partial inventory fulfillment).
  (COALESCE(os_f.inventory_qty, 0)    > 0) AS inventory_partial,
  (COALESCE(os_f.inventory_spend, 0)  > 0) AS inventory_spend_partial,

  -- Money (NULL-safe at aggregation time)
  -- Note: in this dataset budget_spend is populated on the 'revised' snapshot,
  --   not 'original' (original only carries the initial ordered_qty estimate).
  os_o.ordered_qty                    AS ordered_qty_original,
  os_rev.budget_spend                 AS budget_spend,
  os_rq.production_price              AS unit_price_requote,
  os_f.final_production_qty           AS final_production_qty,
  os_f.final_production_spend         AS final_production_spend,
  os_f.inventory_qty                  AS final_inventory_qty,
  os_f.inventory_spend                AS final_inventory_spend,
  os_f.sales_budget_spend             AS final_sales_budget_spend,
  os_f.plus_minus_moq                 AS final_plus_minus_moq
FROM toolkit_items i
JOIN      programs        p     ON p.id  = i.program_id
LEFT JOIN brands          b     ON b.id  = p.brand_id
LEFT JOIN item_types      it    ON it.id = i.item_type_id
LEFT JOIN vendors         v     ON v.id  = i.vendor_id
LEFT JOIN order_snapshots os_o   ON os_o.toolkit_item_id   = i.id AND os_o.snapshot_type   = 'original'
LEFT JOIN order_snapshots os_rev ON os_rev.toolkit_item_id = i.id AND os_rev.snapshot_type = 'revised'
LEFT JOIN order_snapshots os_rq  ON os_rq.toolkit_item_id  = i.id AND os_rq.snapshot_type  = 'requote'
LEFT JOIN order_snapshots os_f   ON os_f.toolkit_item_id   = i.id AND os_f.snapshot_type   = 'final';

COMMENT ON VIEW v_item_outcomes IS
  'One row per toolkit_item with brand/program/vendor/category joined, season parsed from pre_buy_program, and an 11-value final_outcome bucket. Source of truth for all v_* analytics views.';


-- ---------------------------------------------------------------------
-- v_prebuy_funnel  —  workflow & ordering patterns
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_prebuy_funnel CASCADE;

CREATE VIEW v_prebuy_funnel AS
SELECT
  fiscal_year,
  buy_wave,
  pre_buy_status,
  final_outcome,
  COUNT(*)                                              AS item_count,
  COALESCE(SUM(final_production_spend), 0)::numeric     AS final_spend,
  COALESCE(SUM(budget_spend),  0)::numeric     AS budget_spend,
  COALESCE(SUM(final_inventory_spend),  0)::numeric     AS inventory_spend
FROM v_item_outcomes
GROUP BY fiscal_year, buy_wave, pre_buy_status, final_outcome;


-- ---------------------------------------------------------------------
-- v_spend_by_brand_season  —  brand × fiscal year totals
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_spend_by_brand_season CASCADE;

CREATE VIEW v_spend_by_brand_season AS
SELECT
  brand_id,
  brand_name,
  brand_category,
  fiscal_year,
  COUNT(*)                                                                       AS item_count,
  COUNT(*) FILTER (WHERE pre_buy_status = 'include')                             AS items_included,
  COUNT(*) FILTER (WHERE final_outcome = 'approved')                             AS items_approved,
  COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod'))     AS items_cancelled,
  COUNT(*) FILTER (WHERE inventory_spend_partial)                                AS items_inventory_partial,
  COALESCE(SUM(budget_spend), 0)::numeric                               AS budget_spend,
  COALESCE(SUM(final_production_spend), 0)::numeric                              AS actual_spend,
  COALESCE(SUM(final_inventory_spend),  0)::numeric                              AS inventory_spend,
  (COALESCE(SUM(final_production_spend),0) - COALESCE(SUM(budget_spend),0))::numeric AS variance_abs
FROM v_item_outcomes
WHERE brand_name IS NOT NULL
GROUP BY brand_id, brand_name, brand_category, fiscal_year;


-- ---------------------------------------------------------------------
-- v_spend_by_vendor_season  —  vendor × fiscal year totals
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_spend_by_vendor_season CASCADE;

CREATE VIEW v_spend_by_vendor_season AS
SELECT
  vendor_name,
  fiscal_year,
  COUNT(*)                                                                   AS item_count,
  COUNT(*) FILTER (WHERE final_outcome = 'approved')                         AS items_approved,
  COUNT(*) FILTER (WHERE final_outcome = 'cancel_pod')                       AS items_pod_swapped,
  COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod')) AS items_cancelled,
  COALESCE(SUM(final_production_spend), 0)::numeric                          AS actual_spend,
  COALESCE(SUM(budget_spend),  0)::numeric                          AS budget_spend
FROM v_item_outcomes
WHERE vendor_name IS NOT NULL
GROUP BY vendor_name, fiscal_year;


-- ---------------------------------------------------------------------
-- v_cancellation_by_dimension  —  cancel rates sliced by brand / item_type
--   / vendor / lead_time / item_category. Single shape, dimension_type tells
--   the consumer which slice they're looking at.
-- ---------------------------------------------------------------------
DROP VIEW IF EXISTS v_cancellation_by_dimension CASCADE;

CREATE VIEW v_cancellation_by_dimension AS
SELECT 'brand'::text AS dimension_type,
       brand_name    AS dimension_value,
       fiscal_year,
       COUNT(*)                                                                                   AS total_items,
       COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod'))                 AS cancelled_items,
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_cancelled')                                 AS true_cancels,
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_pod')                                       AS pod_swaps,
       COALESCE(SUM(final_production_spend) FILTER (
         WHERE final_outcome IN ('cancel_cancelled','cancel_pod')), 0)::numeric                   AS cancelled_spend
FROM v_item_outcomes
WHERE brand_name IS NOT NULL
GROUP BY brand_name, fiscal_year

UNION ALL
SELECT 'item_type', item_type, fiscal_year,
       COUNT(*),
       COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod')),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_cancelled'),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_pod'),
       COALESCE(SUM(final_production_spend) FILTER (
         WHERE final_outcome IN ('cancel_cancelled','cancel_pod')), 0)::numeric
FROM v_item_outcomes
WHERE item_type IS NOT NULL
GROUP BY item_type, fiscal_year

UNION ALL
SELECT 'vendor', vendor_name, fiscal_year,
       COUNT(*),
       COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod')),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_cancelled'),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_pod'),
       COALESCE(SUM(final_production_spend) FILTER (
         WHERE final_outcome IN ('cancel_cancelled','cancel_pod')), 0)::numeric
FROM v_item_outcomes
WHERE vendor_name IS NOT NULL
GROUP BY vendor_name, fiscal_year

UNION ALL
SELECT 'lead_time', COALESCE(lead_time, 'Unknown'), fiscal_year,
       COUNT(*),
       COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod')),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_cancelled'),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_pod'),
       COALESCE(SUM(final_production_spend) FILTER (
         WHERE final_outcome IN ('cancel_cancelled','cancel_pod')), 0)::numeric
FROM v_item_outcomes
GROUP BY lead_time, fiscal_year

UNION ALL
SELECT 'item_category', item_category, fiscal_year,
       COUNT(*),
       COUNT(*) FILTER (WHERE final_outcome IN ('cancel_cancelled','cancel_pod')),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_cancelled'),
       COUNT(*) FILTER (WHERE final_outcome = 'cancel_pod'),
       COALESCE(SUM(final_production_spend) FILTER (
         WHERE final_outcome IN ('cancel_cancelled','cancel_pod')), 0)::numeric
FROM v_item_outcomes
GROUP BY item_category, fiscal_year;


-- ---------------------------------------------------------------------
-- Grants — views inherit RLS from underlying tables; authenticated role
-- already has SELECT on toolkit_items / order_snapshots / programs.
-- Explicit GRANT keeps the dashboard's anon role happy if anon ever gets
-- read access in future.
-- ---------------------------------------------------------------------
GRANT SELECT ON v_item_outcomes              TO authenticated, anon;
GRANT SELECT ON v_prebuy_funnel              TO authenticated, anon;
GRANT SELECT ON v_spend_by_brand_season      TO authenticated, anon;
GRANT SELECT ON v_spend_by_vendor_season     TO authenticated, anon;
GRANT SELECT ON v_cancellation_by_dimension  TO authenticated, anon;
