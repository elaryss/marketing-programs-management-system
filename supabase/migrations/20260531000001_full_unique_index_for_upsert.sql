-- Convert the partial unique index on (program_id, pos_number) to a full
-- one so it can participate in ON CONFLICT (program_id, pos_number) upserts
-- from PostgREST. Postgres treats NULLs as distinct by default in unique
-- indexes, so rows with NULL pos_number still won't conflict with each other.
DROP INDEX IF EXISTS uniq_toolkit_items_program_pos;
CREATE UNIQUE INDEX uniq_toolkit_items_program_pos
  ON toolkit_items(program_id, pos_number);
