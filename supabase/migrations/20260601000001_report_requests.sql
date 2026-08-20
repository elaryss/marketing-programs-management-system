-- =====================================================================
-- Report request queue + demo users
--
-- Adds the schema for the "Request new report" flow:
--   1. demo_users      — tiny seed table (2 rows) that stands in for real
--                        end-user identity until Supabase auth covers the
--                        requester role. Anon SELECT so the picker can
--                        populate without a session.
--   2. report_requests — queue rows that the admin reviews + approves.
--                        Holds the original ask, the intake Q&A pointer,
--                        and the builder agent's output (HTML + narrative
--                        + queries + filter spec) once built.
--
-- Consumed by:
--   • POST /api/report-intake      → inserts a pending row
--   • Admin Report Queue tab       → lists + transitions rows
--   • POST /api/admin/report-build → fills the builder output columns
--   • POST /api/admin/report-approve + /api/admin/send-report-email.py
--                                  → marks approved_sent + sends email
--   • site/report.html?id=<uuid>   → renders the saved report
-- =====================================================================

CREATE TABLE demo_users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  email        text NOT NULL,
  role_label   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE report_request_status AS ENUM (
  'pending',
  'in_progress',
  'ready_for_review',
  'approved_sent',
  'rejected'
);

CREATE TABLE report_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Requester identity (demo only; swap to auth.users when real auth lands)
  requester_user_id   uuid REFERENCES demo_users(id) ON DELETE SET NULL,
  requester_email     text NOT NULL,
  requester_name      text,

  -- Original ask, captured by the intake agent
  title               text NOT NULL,
  description         text NOT NULL,
  intake_session_id   uuid,
  intake_filters      jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Queue state
  status              report_request_status NOT NULL DEFAULT 'pending',

  -- Builder output (null until status >= ready_for_review)
  report_html         text,
  report_narrative    text,
  report_queries      jsonb,
  report_filters_spec jsonb,
  built_at            timestamptz,

  -- Admin review
  reviewed_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  email_sent_at       timestamptz,
  admin_notes         text
);

CREATE INDEX idx_report_requests_status  ON report_requests(status, created_at DESC);
CREATE INDEX idx_report_requests_created ON report_requests(created_at DESC);

-- RLS — matches the rest of the project: the password gate is the real
-- boundary, so policies are permissive within authenticated; anon gets
-- the bits the public report.html page needs.
ALTER TABLE demo_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY du_read_auth ON demo_users FOR SELECT TO authenticated USING (true);
CREATE POLICY du_read_anon ON demo_users FOR SELECT TO anon          USING (true);

CREATE POLICY rr_all_auth  ON report_requests FOR ALL    TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY rr_read_anon ON report_requests FOR SELECT TO anon          USING (true);

-- Seed two demo users. Both deliver to the same demo inbox —
-- distinguish the personas by display_name + role_label in the UI, not
-- by separate inboxes. Change these later in Supabase Studio if real
-- owners need to differ.
INSERT INTO demo_users (display_name, email, role_label) VALUES
  ('Demo Brand User', 'demo.brand@example.com', 'Brand Manager (Demo)'),
  ('Demo Ops User',   'demo.ops@example.com', 'Ops Lead (Demo)');
