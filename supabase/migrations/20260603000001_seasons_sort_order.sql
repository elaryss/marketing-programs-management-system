-- Display order for seasons. Lower = earlier. Chronological by FY, then
-- Summer (SM) → Holiday (HL) → Spring (SP) within each FY. Adding this as
-- a real column (instead of regex-parsing the name in JS) so it's
-- authoritative and editable from Admin.
ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 999;

COMMENT ON COLUMN seasons.sort_order IS 'Display order in dropdowns and admin lists. Lower = earlier. Chronological by FY, then Summer (SM) → Holiday (HL) → Spring (SP) within each FY.';

UPDATE seasons SET sort_order = 1 WHERE name = 'F25 SM Buy';
UPDATE seasons SET sort_order = 2 WHERE name = 'F25 HL Buy';
UPDATE seasons SET sort_order = 3 WHERE name = 'F25 SP Buy';
UPDATE seasons SET sort_order = 4 WHERE name = 'F26 SM Buy';
UPDATE seasons SET sort_order = 5 WHERE name = 'F26 HL Buy';
UPDATE seasons SET sort_order = 6 WHERE name = 'F26 SP Buy';
UPDATE seasons SET sort_order = 7 WHERE name = 'F27 SM Buy';
UPDATE seasons SET sort_order = 8 WHERE name = 'F27 HL Buy';
UPDATE seasons SET sort_order = 9 WHERE name = 'F27 SP Buy';
