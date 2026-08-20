-- Two more MVP fields on toolkit_items:
--   pre_buy_program — Excel col A (Pre-Buy Program), e.g. "F27 HL Buy"
--   spec_template   — Excel col AC (Item Category spec template),
--                     e.g. "Case Sleeve w/Header - Standard"
ALTER TABLE toolkit_items
  ADD COLUMN IF NOT EXISTS pre_buy_program text,
  ADD COLUMN IF NOT EXISTS spec_template   text;

COMMENT ON COLUMN toolkit_items.pre_buy_program IS 'Buy-window identifier from Excel col A (e.g. "F27 HL Buy")';
COMMENT ON COLUMN toolkit_items.spec_template   IS 'Standard-spec template name from Excel col AC (e.g. "Case Sleeve w/Header - Standard")';

CREATE INDEX IF NOT EXISTS idx_toolkit_items_pre_buy_program ON toolkit_items(pre_buy_program);
CREATE INDEX IF NOT EXISTS idx_toolkit_items_spec_template   ON toolkit_items(spec_template);
