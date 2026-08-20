-- =====================================================================
-- Report Reviewer Agent — auto-review feature
--
-- Adds:
--   • app_settings        — single-row settings table. Holds the
--                           auto_review_enabled toggle. Designed so the
--                           reviewer feature can be disconnected at
--                           runtime (flip the bool) or removed entirely
--                           (drop this table + the review_* columns; no
--                           other code depends on them).
--   • report_requests.review_*  columns to persist the reviewer agent's
--                           verdict. All nullable — if the feature is
--                           disabled or the reviewer fails, the row just
--                           has NULLs and the admin queue + report
--                           viewer fall back to "Not reviewed".
--
-- Consumed by:
--   • POST /api/admin/report-review   → writes review_* columns
--   • POST /api/admin/report-build    → reads auto_review_enabled,
--                                       fires fetch to /report-review
--                                       at end of successful build
--   • GET/PATCH /api/admin/settings   → reads/updates app_settings
--   • Admin queue UI                  → toggle + verdict chip
--   • site/report.html                → expandable findings panel
--
-- DISCONNECT GUIDE: to fully remove the reviewer feature, in order:
--   1. Flip auto_review_enabled = false (UI toggle, instant kill-switch)
--   2. Delete api/admin/report-review.js + prompts/report-reviewer.md
--   3. Remove the "REPORT REVIEW HOOK" block at end of report-build.js
--   4. Drop these columns + this table:
--      ALTER TABLE report_requests DROP COLUMN review_verdict,
--        DROP COLUMN review_score, DROP COLUMN review_findings,
--        DROP COLUMN review_cost_usd, DROP COLUMN reviewed_by_agent_at;
--      DROP TABLE app_settings;
-- =====================================================================

CREATE TABLE app_settings (
  id                   integer PRIMARY KEY CHECK (id = 1),
  auto_review_enabled  boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Seed the one allowed row. The CHECK constraint above means there can
-- only ever be id=1; updates target this row by id.
INSERT INTO app_settings (id, auto_review_enabled) VALUES (1, false);

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Permissive read for authenticated; writes go through the serverless
-- function with service role, which bypasses RLS.
CREATE POLICY app_settings_read_auth ON app_settings
  FOR SELECT TO authenticated USING (true);

ALTER TABLE report_requests
  ADD COLUMN review_verdict        text,                 -- 'pass' | 'warn' | 'fail'
  ADD COLUMN review_score          numeric(3,1),         -- 1.0 - 5.0 overall avg
  ADD COLUMN review_findings       jsonb,                -- full structured output from submit_review
  ADD COLUMN review_cost_usd       numeric(8,4),
  ADD COLUMN reviewed_by_agent_at  timestamptz;

-- Index: lets the admin queue filter / sort by review state cheaply
CREATE INDEX idx_report_requests_review_verdict
  ON report_requests(review_verdict)
  WHERE review_verdict IS NOT NULL;
