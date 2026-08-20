-- =====================================================================
-- Seed: report_templates
--
-- Pre-canned report library shown in the chat's left rail. The agent
-- (api/_lib/tools.js → run_report_template) substitutes :param values
-- before handing the query to chat_run_sql().
--
-- Loaded into Supabase via: psql -f scripts/seed_report_templates.sql
-- (or paste into SQL Editor). Safe to re-run — uses ON CONFLICT DO UPDATE.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. vendor-price-by-item
--    Tiered vendor pricing for a given item type. Shows MOQ tiers across
--    every vendor that quoted, sorted cheapest first.
-- ---------------------------------------------------------------------
INSERT INTO report_templates (id, name, description, params_schema, sql_template, default_chart)
VALUES (
  'vendor-price-by-item',
  'Vendor price comparison by item type',
  'Side-by-side tiered pricing across every vendor that quoted a given item type. Cheapest tier-1 vendor on top.',
  $${
    "params": {
      "item_type": {"type": "string", "required": true, "description": "Item type name, e.g. ''Necker'' or ''Case Sleeve''"}
    }
  }$$::jsonb,
  $$SELECT
       it.name              AS item_type,
       v.name               AS vendor,
       vq.tier_label,
       vq.moq,
       vq.production_price,
       vq.shipping_cost,
       vq.tariff,
       vq.total_unit_price,
       qb.lead_time_days,
       qb.status            AS quote_status
     FROM vendor_quotes vq
     JOIN quote_batches qb  ON qb.id = vq.quote_batch_id
     JOIN toolkit_items ti  ON ti.id = qb.toolkit_item_id
     JOIN item_types it     ON it.id = ti.item_type_id
     JOIN vendors v         ON v.id = qb.vendor_id
     WHERE it.name = :item_type
       AND qb.status IN ('open', 'selected')
     ORDER BY vq.tier_number, vq.total_unit_price$$,
  $${"chart_type": "bar", "x": "vendor", "y": "total_unit_price", "group_by": "tier_label"}$$::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  sql_template = EXCLUDED.sql_template,
  default_chart = EXCLUDED.default_chart;

-- ---------------------------------------------------------------------
-- 2. programs-by-status
--    Count + list of programs grouped by lifecycle status. Quick
--    "what's in flight right now" answer.
-- ---------------------------------------------------------------------
INSERT INTO report_templates (id, name, description, params_schema, sql_template, default_chart)
VALUES (
  'programs-by-status',
  'Programs by status',
  'How many programs are in each lifecycle stage right now, and which ones.',
  $${"params": {}}$$::jsonb,
  $$SELECT
       p.status,
       count(*)                                AS program_count,
       string_agg(p.name, ', ' ORDER BY p.name) AS programs
     FROM programs p
     GROUP BY p.status
     ORDER BY array_position(
       ARRAY['draft','brief_in_progress','vendor_briefing','quotes_received',
             'buy_window_open','buy_window_closed','in_production','complete']::program_status[],
       p.status
     )$$,
  $${"chart_type": "bar", "x": "status", "y": "program_count"}$$::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  sql_template = EXCLUDED.sql_template,
  default_chart = EXCLUDED.default_chart;

-- ---------------------------------------------------------------------
-- 3. toolkit-items-missing-quotes
--    Items in active programs that don't have any quote yet — the
--    "what's blocking the buy window" list.
-- ---------------------------------------------------------------------
INSERT INTO report_templates (id, name, description, params_schema, sql_template, default_chart)
VALUES (
  'toolkit-items-missing-quotes',
  'Toolkit items missing quotes',
  'Items in non-complete programs with zero quote batches. Surface the sourcing gaps.',
  $${"params": {}}$$::jsonb,
  $$SELECT
       p.name                AS program,
       b.name                AS brand,
       ti.pos_number,
       it.name               AS item_type,
       ti.item_description,
       ti.category,
       coalesce(v.name, '—') AS planned_vendor
     FROM toolkit_items ti
     JOIN programs p          ON p.id = ti.program_id
     LEFT JOIN brands b       ON b.id = p.brand_id
     LEFT JOIN item_types it  ON it.id = ti.item_type_id
     LEFT JOIN vendors v      ON v.id = ti.vendor_id
     WHERE p.status <> 'complete'
       AND NOT EXISTS (
         SELECT 1 FROM quote_batches qb
         WHERE qb.toolkit_item_id = ti.id
       )
     ORDER BY p.name, ti.pos_number$$,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  sql_template = EXCLUDED.sql_template,
  default_chart = EXCLUDED.default_chart;

-- ---------------------------------------------------------------------
-- 4. moq-risk
--    Items whose ordered qty is within :threshold_pct of the selected
--    vendor's MOQ — i.e. close to cancellation territory.
-- ---------------------------------------------------------------------
INSERT INTO report_templates (id, name, description, params_schema, sql_template, default_chart)
VALUES (
  'moq-risk',
  'MOQ risk report',
  'Items whose ordered quantity is within a configurable % of MOQ. Defaults to 15% buffer.',
  $${
    "params": {
      "threshold_pct": {"type": "number", "required": false, "description": "Risk buffer as a percent (default 15)"}
    }
  }$$::jsonb,
  $$SELECT
       p.name                                          AS program,
       b.name                                          AS brand,
       ti.pos_number,
       it.name                                         AS item_type,
       v.name                                          AS vendor,
       os.ordered_qty,
       vq.moq,
       round(((os.ordered_qty - vq.moq) / NULLIF(vq.moq, 0) * 100)::numeric, 1) AS pct_over_moq,
       vq.total_unit_price,
       os.budget_spend
     FROM order_snapshots os
     JOIN toolkit_items ti     ON ti.id = os.toolkit_item_id
     JOIN programs p           ON p.id = ti.program_id
     LEFT JOIN brands b        ON b.id = p.brand_id
     LEFT JOIN item_types it   ON it.id = ti.item_type_id
     JOIN vendor_quotes vq     ON vq.id = ti.selected_quote_id
     JOIN quote_batches qb     ON qb.id = vq.quote_batch_id
     JOIN vendors v            ON v.id = qb.vendor_id
     WHERE os.snapshot_type IN ('original', 'revised')
       AND vq.moq IS NOT NULL
       AND os.ordered_qty IS NOT NULL
       AND os.ordered_qty <= vq.moq * (1 + COALESCE(:threshold_pct, 15) / 100.0)
     ORDER BY pct_over_moq NULLS FIRST, p.name$$,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  sql_template = EXCLUDED.sql_template,
  default_chart = EXCLUDED.default_chart;

-- ---------------------------------------------------------------------
-- 5. quote-price-trend
--    Average tier-1 unit price per vendor per month. Shows whether a
--    vendor is trending up/down over time.
-- ---------------------------------------------------------------------
INSERT INTO report_templates (id, name, description, params_schema, sql_template, default_chart)
VALUES (
  'quote-price-trend',
  'Quote price trend by vendor',
  'Avg tier-1 unit price per vendor per month. Optionally filter to one item type.',
  $${
    "params": {
      "item_type": {"type": "string", "required": false, "description": "Optional item type filter, e.g. ''Necker''"}
    }
  }$$::jsonb,
  $$SELECT
       date_trunc('month', qb.received_at)::date AS month,
       v.name                                     AS vendor,
       round(avg(vq.total_unit_price)::numeric, 4) AS avg_unit_price,
       count(*)                                    AS quote_count
     FROM vendor_quotes vq
     JOIN quote_batches qb  ON qb.id = vq.quote_batch_id
     JOIN vendors v         ON v.id = qb.vendor_id
     JOIN toolkit_items ti  ON ti.id = qb.toolkit_item_id
     LEFT JOIN item_types it ON it.id = ti.item_type_id
     WHERE vq.tier_number = 1
       AND (:item_type IS NULL OR it.name = :item_type)
     GROUP BY 1, 2
     ORDER BY 1, 2$$,
  $${"chart_type": "line", "x": "month", "y": "avg_unit_price", "group_by": "vendor"}$$::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  sql_template = EXCLUDED.sql_template,
  default_chart = EXCLUDED.default_chart;

-- ---------------------------------------------------------------------
-- 6. program-rollup
--    Single-program overview: items, vendors, total est cost. The
--    "give me a one-pager on Program X" report.
-- ---------------------------------------------------------------------
INSERT INTO report_templates (id, name, description, params_schema, sql_template, default_chart)
VALUES (
  'program-rollup',
  'Program rollup',
  'Single-program overview: items, vendors, status, estimated total spend.',
  $${
    "params": {
      "program_name": {"type": "string", "required": true, "description": "Program name, e.g. ''BV Fall''"}
    }
  }$$::jsonb,
  $$SELECT
       p.name                                        AS program,
       p.status,
       p.focus_period,
       count(ti.id)                                  AS toolkit_item_count,
       count(DISTINCT qb.vendor_id)                  AS distinct_vendors,
       count(*) FILTER (WHERE ti.selected_quote_id IS NULL) AS items_without_selected_quote,
       round(sum(
         coalesce(vq.total_unit_price, 0) *
         coalesce(os.ordered_qty, vq.moq, 0)
       )::numeric, 2)                                AS estimated_total_spend
     FROM programs p
     LEFT JOIN toolkit_items ti     ON ti.program_id = p.id
     LEFT JOIN vendor_quotes vq     ON vq.id = ti.selected_quote_id
     LEFT JOIN quote_batches qb     ON qb.id = vq.quote_batch_id
     LEFT JOIN order_snapshots os   ON os.toolkit_item_id = ti.id
                                    AND os.snapshot_type = 'original'
     WHERE p.name = :program_name
     GROUP BY p.id, p.name, p.status, p.focus_period$$,
  NULL
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  params_schema = EXCLUDED.params_schema,
  sql_template = EXCLUDED.sql_template,
  default_chart = EXCLUDED.default_chart;

COMMIT;
