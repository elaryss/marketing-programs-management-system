-- =====================================================================
-- Chat agent schema — sessions, messages, report templates, run-SQL RPC
--
-- Powers the /chat surface and floating widget. The Vercel Serverless
-- Function api/chat.js loads/persists messages here and calls
-- chat_run_sql() as a guarded SELECT-only window into the toolkit data.
--
-- Loaded into Supabase via: supabase db push  (or paste into SQL Editor)
-- =====================================================================

-- ---------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------

CREATE TABLE chat_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  -- Free-form payload:
  --   user      → { text }
  --   assistant → { text, html?, report_html?, chart_spec?, tool_calls? }
  --   tool      → { name, input, output }
  content     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);

-- Pre-canned report library. Each row is one analyst-facing template
-- that the agent can run (or the user can pick directly from the UI).
CREATE TABLE report_templates (
  id              text PRIMARY KEY,           -- slug, e.g. 'vendor-price-by-item'
  name            text NOT NULL,
  description     text,
  -- JSON Schema describing required params and their types.
  -- Shape: { "params": { "<name>": { "type": "...", "required": true, "description": "..." } } }
  params_schema   jsonb NOT NULL DEFAULT '{"params": {}}'::jsonb,
  -- Named placeholders use :param syntax (e.g. SELECT ... WHERE brand_id = :brand_id).
  -- Substitution happens in api/_lib/tools.js via safe quoting before being
  -- handed to chat_run_sql().
  sql_template    text NOT NULL,
  -- Optional Chart.js spec template (chart_type, data mapping, options).
  default_chart   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- TRIGGERS — reuse set_updated_at() from the initial migration
-- ---------------------------------------------------------------------

CREATE TRIGGER trg_report_templates_updated_at
  BEFORE UPDATE ON report_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Bump session.last_active_at every time a new message lands.
CREATE OR REPLACE FUNCTION bump_chat_session_activity() RETURNS trigger AS $$
BEGIN
  UPDATE chat_sessions SET last_active_at = now() WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_chat_messages_bump_session
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION bump_chat_session_activity();

-- ---------------------------------------------------------------------
-- chat_run_sql — guarded read-only window into the toolkit data
--
-- Accepts a single SELECT (or WITH ... SELECT) statement, rejects
-- multi-statements / comments / semicolons mid-query, caps results at
-- 500 rows, and aborts after 5s. Returns jsonb array of result rows.
-- SECURITY DEFINER so RLS doesn't block analytical reads.
-- ---------------------------------------------------------------------

-- POSIX bracket expressions everywhere — no regex backslashes. Earlier
-- versions used \s / \b and broke when the migration body round-tripped
-- through JSON transport (the \b was JSON-decoded as a literal backspace).
-- [[:space:]] is whitespace, [[:>:]] is end-of-word. Same semantics, no
-- escape-tax.
CREATE OR REPLACE FUNCTION chat_run_sql(query text)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $func$
DECLARE
  cleaned  text;
  result   jsonb;
BEGIN
  -- Trim trailing whitespace + a single optional trailing semicolon so the
  -- common Claude habit of "SELECT ...;" doesn't trip the no-semicolon guard.
  cleaned := regexp_replace(query, '[[:space:]]*;?[[:space:]]*$', '');

  IF cleaned !~* '^[[:space:]]*(select|with)[[:>:]]' THEN
    RAISE EXCEPTION 'only SELECT / WITH ... SELECT statements are allowed';
  END IF;

  -- After trimming, ANY remaining ; / -- / /* indicates injection-style chaining.
  -- Character class for `*` avoids backslash escaping.
  IF cleaned ~ '[;]|--|/[*]' THEN
    RAISE EXCEPTION 'multi-statement or comment tokens are not allowed';
  END IF;

  -- 5-second cap per call (overrides any session default).
  PERFORM set_config('statement_timeout', '5000', true);

  -- Wrap in a CTE so the caller's own LIMIT/ORDER BY stay intact while we
  -- still enforce a hard ceiling of 500 rows on the outside.
  EXECUTE format(
    'WITH q AS (%s)
     SELECT coalesce(jsonb_agg(row_to_json(t)), ''[]''::jsonb)
       FROM (SELECT * FROM q LIMIT 500) t',
    cleaned
  ) INTO result;

  RETURN result;
END;
$func$;

-- The server (api/chat.js) calls this with the service role. Also granted
-- to `authenticated` for future per-user auth scenarios and ad-hoc Studio
-- debugging. NOT granted to `anon` — the browser-exposed anon key should
-- not be able to probe the database with arbitrary SELECTs, even guarded
-- ones.
GRANT EXECUTE ON FUNCTION chat_run_sql(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY — match the permissive capstone posture
-- ---------------------------------------------------------------------

ALTER TABLE chat_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages     ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_templates  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['chat_sessions', 'chat_messages', 'report_templates'] LOOP
    EXECUTE format('CREATE POLICY %I_auth_all ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true);', t, t);
  END LOOP;
END $$;

-- Allow the service role (used by api/chat.js) to read/write without RLS friction.
-- service_role bypasses RLS by default in Supabase, but spelling it out here
-- makes the policy story explicit for future readers.
