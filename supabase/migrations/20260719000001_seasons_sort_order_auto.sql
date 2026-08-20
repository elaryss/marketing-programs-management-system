-- Make seasons.sort_order self-assigning instead of hand-typed.
--
-- Background: sort_order was originally populated by a one-time UPDATE list
-- (see 20260603000001_seasons_sort_order.sql). Every season added afterwards
-- had to be numbered by hand in Admin, which produced collisions (F28 SM/HL
-- reused F27's 10/11) and out-of-order rows. This migration derives the value
-- from the season name so no one enters it manually again.
--
-- Scheme (unchanged): chronological by fiscal year, then Summer (SM) ->
-- Holiday (HL) -> Spring (SP) within each FY.
--   sort_order = (FY - 24) * 3 + {SM:1, HL:2, SP:3}
-- FY 24 is the epoch (first fiscal year in the system) so F24 SM stays at 1
-- and the "#" column keeps small, readable numbers. Names that don't match the
-- convention fall back to 999 (sorted to the end).

CREATE OR REPLACE FUNCTION seasons_compute_sort_order(season_name text)
RETURNS int
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  fy          int;
  season_idx  int;
BEGIN
  IF season_name IS NULL THEN
    RETURN 999;
  END IF;

  -- Fiscal year: "F27 ..." -> 27
  fy := (substring(season_name FROM 'F(\d{2})'))::int;
  IF fy IS NULL THEN
    RETURN 999;
  END IF;

  -- Season within the FY. Accept the two-letter codes and the full words.
  IF season_name ~* '\m(SM|Summer)\M' THEN
    season_idx := 1;
  ELSIF season_name ~* '\m(HL|Holiday)\M' THEN
    season_idx := 2;
  ELSIF season_name ~* '\m(SP|Spring)\M' THEN
    season_idx := 3;
  ELSE
    RETURN 999;
  END IF;

  RETURN (fy - 24) * 3 + season_idx;
END;
$$;

COMMENT ON FUNCTION seasons_compute_sort_order(text) IS
  'Derives seasons.sort_order from the season name: (FY-24)*3 + {SM:1,HL:2,SP:3}. Returns 999 for names that do not match the convention.';

CREATE OR REPLACE FUNCTION seasons_set_sort_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.sort_order := seasons_compute_sort_order(NEW.name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seasons_sort_order ON seasons;
CREATE TRIGGER trg_seasons_sort_order
  BEFORE INSERT OR UPDATE OF name ON seasons
  FOR EACH ROW
  EXECUTE FUNCTION seasons_set_sort_order();

-- Backfill: recompute every existing row. Fixes the F28 SM/HL collisions with
-- F27 and re-sorts F29 into place.
UPDATE seasons SET sort_order = seasons_compute_sort_order(name);
