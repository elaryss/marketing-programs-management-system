-- =====================================================================
-- Add auto-build columns to report_requests
--
-- Adds the bookkeeping the auto-build pipeline needs:
--   • auto_built              — true when the build was triggered by the
--                               webhook or hourly cron, not a manual admin
--                               click. Lets the admin queue UI display
--                               which rows were built automatically.
--   • build_cost_usd          — actual cost of the Claude calls during the
--                               build, computed from response.usage on
--                               each iteration with Sonnet 4.6 pricing.
--                               Visible as a chip in the admin queue.
--                               $1 is a visual flag, not a hard cap
--                               (build runs to completion regardless —
--                               per user decision).
--   • auto_build_attempted_at — set the moment auto-build claims a row.
--                               Acts as a dedup guard so webhook + cron
--                               races no-op the loser. NULL means
--                               auto-build has never tried; admin manual
--                               builds do NOT touch this field.
-- =====================================================================

ALTER TABLE report_requests
  ADD COLUMN auto_built              boolean       NOT NULL DEFAULT false,
  ADD COLUMN build_cost_usd          numeric(8,4),
  ADD COLUMN auto_build_attempted_at timestamptz;

-- Index supports the cron's "find pending unattempted rows" sweep
CREATE INDEX idx_report_requests_auto_build_pending
  ON report_requests(created_at)
  WHERE status = 'pending' AND auto_build_attempted_at IS NULL;
