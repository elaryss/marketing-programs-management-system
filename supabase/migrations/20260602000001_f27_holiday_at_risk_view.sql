-- v_f27_holiday_at_risk
-- Flat row-per-item view for the F27 Holiday At-Risk Monitor page.
-- Source: toolkit_items joined to revised order snapshots + brand division (PRM/LUX).
-- investment_in_moq is computed here because the column on order_snapshots is null
-- across the import (status is set, but the dollar gap was never backfilled).

CREATE OR REPLACE VIEW public.v_f27_holiday_at_risk
WITH (security_invoker = true) AS
SELECT
  ti.id                                       AS item_id,
  ti.pos_number,
  ti.item_description,
  b.category::text                            AS division,
  b.name                                      AS brand,
  INITCAP(ti.category::text)                  AS category,
  ti.site_moq,
  ti.portal_price,
  os.ordered_qty,
  os.budget_spend,
  os.plus_minus_moq,
  CASE
    WHEN os.status ILIKE '%risk%' AND ti.site_moq IS NOT NULL AND ti.site_moq > os.ordered_qty
      THEN (ti.site_moq - os.ordered_qty) * ti.portal_price
  END                                         AS investment_in_moq,
  os.status
FROM public.toolkit_items ti
JOIN public.programs p        ON p.id = ti.program_id
JOIN public.brands   b        ON b.id = p.brand_id
JOIN public.order_snapshots os ON os.toolkit_item_id = ti.id AND os.snapshot_type = 'revised'
WHERE ti.pre_buy_program = 'F27 HL Buy';

GRANT SELECT ON public.v_f27_holiday_at_risk TO anon, authenticated;
