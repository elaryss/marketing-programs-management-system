-- Pre-Buy Window setup fields (user's Toolkit_Schema.xlsx rows 82-93) live
-- on toolkit_items. These are per-item decisions made at the pre-buy stage.
ALTER TABLE toolkit_items
  ADD COLUMN IF NOT EXISTS site_moq numeric,
  ADD COLUMN IF NOT EXISTS portal_price numeric,
  ADD COLUMN IF NOT EXISTS estimated_budget_spend numeric,
  ADD COLUMN IF NOT EXISTS site_setup_comments text;

COMMENT ON COLUMN toolkit_items.site_moq IS 'MOQ chosen based on vendor quote (Pre-Buy Window Setup)';
COMMENT ON COLUMN toolkit_items.portal_price IS 'Selected Production Price * 1.0675, unless manually adjusted';
COMMENT ON COLUMN toolkit_items.estimated_budget_spend IS 'Portal Price * Site MOQ';
COMMENT ON COLUMN toolkit_items.site_setup_comments IS 'ABC comments at pre-buy window setup time';
