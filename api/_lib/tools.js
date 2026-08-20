/**
 * Tool definitions + executors for the chat agent.
 *
 * Two tool sets:
 *   - Base (get_schema, run_sql) — available on every surface.
 *   - Widget-only (submit_report_request) — only exposed when surface='widget'.
 *     Lets the floating Ask AI widget hand a long-list question off to admin
 *     by inserting into report_requests, instead of dumping a 78-row table
 *     into the transcript. Mirrors api/report-intake.js's submit logic.
 */
const { SCHEMA } = require('./schema');
const { getSupabase } = require('./supabase');

// ---------------------------------------------------------------------
// Tool definitions — Anthropic tool_use JSON Schema
// ---------------------------------------------------------------------

const GET_SCHEMA_DEF = {
  name: 'get_schema',
  description:
    "Returns the toolkit database schema as JSON: 8 base tables, the toolkit_wide denormalized view, and 5 pre-aggregated analytical views (v_item_outcomes, v_prebuy_funnel, v_spend_by_brand_season, v_spend_by_vendor_season, v_cancellation_by_dimension), plus status enums and analyst hints. Call this once at the start of a session to orient yourself before writing SQL. It's free — no DB hit.",
  input_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

const RUN_SQL_DEF = {
  name: 'run_sql',
  description:
    "Run a read-only SELECT (or WITH ... SELECT) against the Supabase toolkit database. Returns a JSON array of result rows. Guardrails: SELECT-only, no multi-statements, no comments, hard cap of 500 rows, 5s statement timeout. Prefer the toolkit_wide view for cross-cutting questions; join base tables when you need columns the view doesn't expose. Do not end your query with a semicolon (it's allowed, but unnecessary).",
  input_schema: {
    type: 'object',
    properties: {
      sql: {
        type: 'string',
        description:
          'A single SELECT or WITH...SELECT statement. No semicolons mid-query, no comments (-- or /* */).',
      },
    },
    required: ['sql'],
    additionalProperties: false,
  },
};

const SUBMIT_REPORT_REQUEST_DEF = {
  name: 'submit_report_request',
  description:
    "Hand off the user's question to admin as a custom report request. Use this ONLY in the widget surface, and ONLY after the user has explicitly asked you to send it to admin (e.g., 'yes send it', 'file that as a report', 'send to admin'). After calling this, your reply should be one short confirmation sentence — nothing else. Call at most once per conversation.",
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short headline-style title for the report, 80 chars or fewer.',
        maxLength: 80,
      },
      description: {
        type: 'string',
        description:
          'Full description of what the requester wants to see. Self-contained enough that the report builder can produce it without follow-up. Include the natural-language question and any context you already gathered in the chat.',
      },
      suggested_filters: {
        type: 'object',
        description:
          'Scope hints captured from the conversation or the active filter chips. Omit fields the user did not specify.',
        properties: {
          year: {
            type: 'array',
            items: { type: 'string' },
            description: "Fiscal years like ['F25','F26','F27']. Empty array if not specified.",
          },
          brand: {
            type: 'string',
            description: 'Specific brand name. Empty string if not specified.',
          },
          category: {
            type: 'string',
            description: "'paper', 'display', 'premium', or empty string.",
          },
          wave: {
            type: 'string',
            description: "'HL', 'SM', 'SP', or empty string.",
          },
        },
        additionalProperties: false,
      },
      notes_for_builder: {
        type: 'string',
        description:
          'Free-form notes for the report builder: chart preferences, audience hint, comparison hints, any assumptions you made. Empty string if none.',
      },
    },
    required: ['title', 'description', 'suggested_filters', 'notes_for_builder'],
    additionalProperties: false,
  },
};

const BASE_TOOL_DEFINITIONS = [GET_SCHEMA_DEF, RUN_SQL_DEF];

// Back-compat export: callers that don't care about surface get the base set.
const TOOL_DEFINITIONS = BASE_TOOL_DEFINITIONS;

function getToolDefinitions(surface) {
  if (surface === 'widget') {
    return [...BASE_TOOL_DEFINITIONS, SUBMIT_REPORT_REQUEST_DEF];
  }
  return BASE_TOOL_DEFINITIONS;
}

// ---------------------------------------------------------------------
// Executors — one async function per tool name. Each returns either a
// string (passed straight to Claude as tool_result content) or an object
// (JSON-stringified before being passed back).
// ---------------------------------------------------------------------

async function executeGetSchema() {
  return SCHEMA;
}

async function executeRunSql({ sql }) {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new Error('sql must be a non-empty string');
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('chat_run_sql', { query: sql });
  if (error) {
    // Surface DB error message to Claude so it can correct its SQL — these
    // are guardrail violations ("only SELECT allowed", "syntax error", etc.),
    // not server bugs.
    throw new Error(`chat_run_sql: ${error.message}`);
  }
  // data is the jsonb array returned by the RPC. Summarize if it's large
  // (the server-side cap is 500 rows, but each row can still be wide).
  return summarizeRows(data);
}

// If the result is large, return a head/tail summary instead of the full
// payload. Keeps tool_result blocks under the 50 KB-ish ceiling without
// losing the row count.
function summarizeRows(rows) {
  if (!Array.isArray(rows)) return rows;
  const json = JSON.stringify(rows);
  if (json.length <= 40_000) {
    return { row_count: rows.length, rows };
  }
  return {
    row_count: rows.length,
    note: `Result was ${json.length} bytes — only the first 20 and last 20 rows are returned here. Use a more selective query (extra WHERE clauses or aggregations) to see specific rows.`,
    rows_head: rows.slice(0, 20),
    rows_tail: rows.slice(-20),
  };
}

// submit_report_request needs caller state (session_id, requester identity)
// which the SQL tools don't, so executors take an optional `context` arg.
// `context` is `{ supabase, session_id, requester }` when surface='widget',
// or {} otherwise. Existing executors ignore it.
async function executeSubmitReportRequest(input, context) {
  if (!context || !context.supabase || !context.requester || !context.session_id) {
    throw new Error(
      'submit_report_request is only available in the widget surface — no requester is configured for this session.',
    );
  }
  const { title, description, suggested_filters, notes_for_builder } = input || {};
  if (!title || !description) {
    throw new Error('title and description are required');
  }
  const { supabase, session_id, requester } = context;
  const row = {
    requester_user_id: requester.id,
    requester_email: requester.email,
    requester_name: requester.display_name,
    title: String(title).slice(0, 80),
    description: String(description),
    intake_session_id: session_id,
    intake_filters: {
      ...(suggested_filters || {}),
      notes_for_builder: notes_for_builder || '',
      source: 'widget',
    },
    status: 'pending',
  };
  const { data, error } = await supabase
    .from('report_requests')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return { ok: true, request_id: data.id };
}

const EXECUTORS = {
  get_schema: executeGetSchema,
  run_sql: executeRunSql,
  submit_report_request: executeSubmitReportRequest,
};

// ---------------------------------------------------------------------
// Dispatcher — used by the chat handler's tool-use loop. Catches errors
// and returns a tool_result-shaped object with is_error=true.
// ---------------------------------------------------------------------

async function executeTool(name, input, context = {}) {
  const fn = EXECUTORS[name];
  if (!fn) {
    return { is_error: true, content: `Unknown tool: ${name}` };
  }
  try {
    const result = await fn(input || {}, context);
    const content = typeof result === 'string' ? result : JSON.stringify(result);
    // Hard cap individual tool results at 50 KB so context doesn't explode
    // even if summarizeRows misses something.
    const capped =
      content.length > 50_000
        ? content.slice(0, 50_000) + '\n...[truncated at 50 KB]'
        : content;
    return { is_error: false, content: capped };
  } catch (err) {
    return { is_error: true, content: `Error: ${err.message}` };
  }
}

module.exports = { TOOL_DEFINITIONS, getToolDefinitions, executeTool };
