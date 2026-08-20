-- =====================================================================
-- chat_summaries — persisted output of the weekly chat-usage report.
--
-- Each row is one run of the summarizer. The admin UI lists rows here
-- and renders summary_markdown on click. Written by the new admin
-- endpoint api/admin/chat-summary.js and the CLI scripts/weekly_chat_summary.js.
-- =====================================================================

CREATE TABLE chat_summaries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generated_at      timestamptz NOT NULL DEFAULT now(),
  window_days       int         NOT NULL,
  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,
  session_count     int         NOT NULL,
  message_count     int         NOT NULL,
  user_turn_count   int         NOT NULL,
  summary_markdown  text        NOT NULL,
  model             text,
  -- Nullable so CLI runs (no logged-in user) can still insert.
  generated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_chat_summaries_generated_at ON chat_summaries(generated_at DESC);

ALTER TABLE chat_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_summaries_auth_all
  ON chat_summaries FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
