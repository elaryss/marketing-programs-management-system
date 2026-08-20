/**
 * POST /api/admin/report-build — Vercel Serverless Function.
 *
 * Request:  { request_id }
 * Auth:     EITHER
 *             - Authorization: Bearer <supabase session>   (manual admin click)
 *             - x-internal-trigger: <INTERNAL_TRIGGER_SECRET>  (webhook / cron)
 *
 * Loads the report_requests row + its intake Q&A transcript, then runs a
 * Claude tool-use loop with get_schema + run_sql + a forced submit_built_report
 * tool. Tracks cost via response.usage on every Claude call and persists
 * build_cost_usd on the row regardless of outcome. Sets auto_built=true when
 * the trigger header was used (so the admin UI can show the "auto" badge).
 *
 * The internal-trigger path also acts as a dedup guard via auto_build_attempted_at:
 * if the row's attempt timestamp is already set, the call is a no-op so a
 * webhook + cron race resolves cleanly (the loser just returns 200 with
 * already_attempted=true).
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { getSupabase } = require('../_lib/supabase');
const { TOOL_DEFINITIONS: BASE_TOOLS, executeTool } = require('../_lib/tools');

// Behavior prompt (phases, visual vocabulary, submit format, conduct rules)
// + domain glossary (canonical data-interpretation reference — disambiguation
// map, vocabulary, anti-patterns). Concatenated at cold start so the builder
// reads both. The glossary wins on conflict for data meaning; the behavior
// prompt wins for behavior/output. See prompts/domain-glossary.md.
const SYSTEM_PROMPT = [
  fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'report-builder.md'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'domain-glossary.md'), 'utf8'),
].join('\n\n---\n\n');

let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('Missing CLAUDE_API_KEY env var');
  // interleaved-thinking-2025-05-14: lets Claude emit thinking blocks BETWEEN
  // tool calls within the same turn. The builder loop is now think → run_sql
  // → think about the result → run_sql → … → submit, instead of pre-planning
  // every query upfront. This is the structural support for the phased prompt
  // (see prompts/report-builder.md).
  anthropicClient = new Anthropic({
    apiKey,
    defaultHeaders: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
  });
  return anthropicClient;
}

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_ITERATIONS = 14;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sonnet 4.6 pricing per token. Output covers both regular completion tokens
// and adaptive-thinking tokens — Anthropic bills them at the same rate.
const PRICING = {
  input:          3.0e-6,   // $3.00 / M
  cache_creation: 3.75e-6,  // $3.75 / M (input × 1.25)
  cache_read:     0.30e-6,  // $0.30 / M
  output:         15.0e-6,  // $15.00 / M
};

const SUBMIT_TOOL = {
  name: 'submit_built_report',
  description:
    'Submit the finished report. Call this exactly once when you are done querying and writing. After this call your turn ends — do not return prose.',
  input_schema: {
    type: 'object',
    properties: {
      report_html: {
        type: 'string',
        description:
          'Self-contained HTML block (<div class="report-body">…</div>) with headers, prose, and one or more data tables. No <script>/<html>/<head>/<body>. Sanitized by DOMPurify on the viewer page.',
      },
      report_narrative: {
        type: 'string',
        description:
          'Markdown story/reflection on what the data shows. Multi-paragraph, ≤400 words. Factual interpretation only — no speculation, no recommendations.',
      },
      report_queries: {
        type: 'array',
        description: 'Array of {label, sql, row_count} for the queries you actually ran. For admin transparency.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            sql: { type: 'string' },
            row_count: { type: 'integer' },
          },
          required: ['label', 'sql'],
          additionalProperties: false,
        },
      },
      report_filters_spec: {
        type: 'object',
        description: 'Filters that were applied when building this report.',
        properties: {
          year: { type: 'array', items: { type: 'string' } },
          brand: { type: 'string' },
          category: { type: 'string' },
          wave: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    required: ['report_html', 'report_narrative', 'report_queries', 'report_filters_spec'],
    additionalProperties: false,
  },
};

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getSupabase();

  // ── Auth: accept either Bearer (manual) or x-internal-trigger (webhook/cron) ──
  const triggerHeader = (req.headers['x-internal-trigger'] || '').toString();
  const triggerSecret = process.env.INTERNAL_TRIGGER_SECRET;
  const isInternal = !!triggerHeader && !!triggerSecret && triggerHeader === triggerSecret;

  if (!isInternal) {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing bearer token (or invalid internal trigger)' });
    const { data: { user }, error: authErr } = await supabase.auth.getUser(m[1]);
    if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });
  }

  // Parse body
  let request_id;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    request_id = body.request_id;
    if (typeof request_id !== 'string' || !UUID_RE.test(request_id)) {
      return res.status(400).json({ error: 'request_id must be a UUID' });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  let claimedAutoBuild = false;

  try {
    // ── Load the row ──
    const { data: request, error: reqErr } = await supabase
      .from('report_requests')
      .select('*')
      .eq('id', request_id)
      .single();
    if (reqErr || !request) return res.status(404).json({ error: 'Request not found' });
    if (request.status === 'approved_sent') {
      return res.status(409).json({ error: 'Already approved + sent.' });
    }

    // ── Dedup guard for auto-triggered builds ──
    // If this is internal (webhook or cron) and the row has already been
    // attempted, return success without rerunning. Lets webhook + cron race
    // safely — one wins, the other is a quiet no-op.
    if (isInternal) {
      if (request.auto_build_attempted_at) {
        return res.status(200).json({ ok: true, already_attempted: true, request_id });
      }
      if (request.status !== 'pending') {
        return res.status(200).json({ ok: true, skipped_status: request.status, request_id });
      }

      // Atomic claim: only one caller succeeds. Other callers see no row.
      const { data: claimed, error: claimErr } = await supabase
        .from('report_requests')
        .update({
          status: 'in_progress',
          auto_build_attempted_at: new Date().toISOString(),
          auto_built: true,
        })
        .eq('id', request_id)
        .eq('status', 'pending')
        .is('auto_build_attempted_at', null)
        .select()
        .maybeSingle();

      if (claimErr) throw new Error('Claim failed: ' + claimErr.message);
      if (!claimed) {
        // Another caller beat us to it.
        return res.status(200).json({ ok: true, claim_lost: true, request_id });
      }
      claimedAutoBuild = true;
    } else {
      // Manual admin build — concurrency guard: refuse if the row is already
      // mid-build. Multiple parallel workers on the same row clobber each
      // other and double the Anthropic spend. Atomic claim via
      // WHERE status='pending' ensures only one manual click wins.
      const { data: claimed, error: claimErr } = await supabase
        .from('report_requests')
        .update({ status: 'in_progress' })
        .eq('id', request_id)
        .eq('status', 'pending')
        .select('id')
        .maybeSingle();

      if (claimErr) throw new Error('Claim failed: ' + claimErr.message);
      if (!claimed) {
        // Row wasn't pending — already building, ready_for_review, etc.
        return res.status(409).json({
          error: `Cannot build: row status is "${request.status}". If a build is stuck, reset the row in the DB first.`,
          current_status: request.status,
        });
      }
    }

    // ── Intake transcript ──
    let transcript = [];
    if (request.intake_session_id) {
      const { data } = await supabase
        .from('chat_messages')
        .select('role, content, created_at')
        .eq('session_id', request.intake_session_id)
        .order('created_at', { ascending: true });
      transcript = data || [];
    }

    // ── Compose the agent's first message ──
    const transcriptText = transcript
      .map(m => `[${m.role.toUpperCase()}] ${m.content?.text || ''}`)
      .join('\n\n');
    const userMessage = [
      `# Report Request`,
      ``,
      `**Title:** ${request.title}`,
      ``,
      `**Description:**`,
      request.description,
      ``,
      `**Captured scope (intake_filters):**`,
      '```json',
      JSON.stringify(request.intake_filters || {}, null, 2),
      '```',
      ``,
      `**Intake Q&A transcript:**`,
      transcriptText || '_no transcript_',
      ``,
      `---`,
      ``,
      `Plan your queries, run them, then call \`submit_built_report\` with the finished artifact. Single submission only.`,
    ].join('\n');

    // ── Run the loop ──
    const tools = [...BASE_TOOLS, SUBMIT_TOOL];
    const result = await runBuildLoop({
      anthropic: getAnthropic(),
      tools,
      userMessage,
    });

    if (!result.submission) {
      // Loop ended without a submit_built_report call. Persist the cost we
      // burned, the bail reason, and restore status to pending so a retry
      // is possible. admin_notes gets a structured forensic trail so we
      // can debug without re-running the build.
      const bailNote = `[build bailed @ ${new Date().toISOString()}] reason=${result.bailReason || 'unknown'} iterations=${result.iterations} sql_calls=${result.toolTrace.filter(t => t.tool === 'run_sql').length} cost=$${round4(result.totalCost)}`;
      await supabase
        .from('report_requests')
        .update({
          status: 'pending',
          build_cost_usd: round4(result.totalCost),
          admin_notes: bailNote,
        })
        .eq('id', request_id);
      return res.status(502).json({
        error: 'Builder agent did not submit a report. Restored to pending. ' + (result.bailReason || ''),
        cost_usd: round4(result.totalCost),
        iterations: result.iterations,
      });
    }

    const { report_html, report_narrative, report_queries, report_filters_spec } = result.submission;

    const { error: updateErr } = await supabase
      .from('report_requests')
      .update({
        status: 'ready_for_review',
        report_html,
        report_narrative,
        report_queries,
        report_filters_spec,
        built_at: new Date().toISOString(),
        build_cost_usd: round4(result.totalCost),
      })
      .eq('id', request_id);
    if (updateErr) throw new Error(updateErr.message);

    // ══════════════════════════════════════════════════════════════
    // REPORT REVIEW HOOK — safe to delete this whole block.
    // Fire-and-forget call to /api/admin/report-review when the
    // auto_review_enabled toggle is on. Wrapped so any failure
    // (settings table missing, reviewer endpoint deleted, network
    // hiccup, anything) is logged and swallowed — the build path
    // is never affected.
    //
    // To kill the auto-review at runtime: flip the toggle in the
    // admin UI (writes app_settings.auto_review_enabled = false).
    // To remove the feature entirely: delete this block.
    // ══════════════════════════════════════════════════════════════
    try {
      const { data: settings } = await supabase
        .from('app_settings')
        .select('auto_review_enabled')
        .eq('id', 1)
        .single();
      if (settings?.auto_review_enabled && process.env.INTERNAL_TRIGGER_SECRET) {
        const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
        const baseUrl = host
          ? `${proto}://${host}`
          : (process.env.PUBLIC_BASE_URL || 'https://your-deployment.example.com');
        // Same trap as build-hook → report-build: a pure fire-and-forget
        // fetch gets cut off when Vercel terminates this worker after
        // res.json(). Use the same AbortController-await pattern — give
        // the review endpoint ~6s to spin up and start its work, then
        // abort the client connection. The review continues running in
        // its own Vercel instance up to its own maxDuration (120s).
        try {
          const ac = new AbortController();
          const tid = setTimeout(() => ac.abort(), 6000);
          const r = await fetch(`${baseUrl}/api/admin/report-review`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-internal-trigger': process.env.INTERNAL_TRIGGER_SECRET,
            },
            body: JSON.stringify({ request_id }),
            signal: ac.signal,
          });
          clearTimeout(tid);
          console.log(`[report-build] auto-review kickoff returned ${r.status} for ${request_id}`);
        } catch (err) {
          const msg = err.name === 'AbortError'
            ? 'client timeout (6s) — review continues server-side'
            : (err?.message || err);
          console.warn('[report-build] auto-review fetch:', msg);
        }
      }
    } catch (hookErr) {
      console.warn('[report-build] auto-review hook skipped:', hookErr?.message || hookErr);
    }
    // ══════════════════════════════════════════════════════════════
    // END REPORT REVIEW HOOK
    // ══════════════════════════════════════════════════════════════

    return res.status(200).json({
      ok: true,
      request_id,
      cost_usd: round4(result.totalCost),
      iterations: result.iterations,
      auto_built: claimedAutoBuild,
      tool_trace_summary: result.toolTrace.map(t => ({ tool: t.tool, is_error: t.is_error })),
    });
  } catch (err) {
    // Recovery: push the row back to pending so it isn't stuck in_progress.
    // Best-effort; ignore failures.
    try {
      await supabase
        .from('report_requests')
        .update({ status: 'pending' })
        .eq('id', request_id)
        .eq('status', 'in_progress');
    } catch (_) {}

    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic rate limit — try again shortly.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfiguration: invalid Claude API key.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[report-build] Anthropic API error:', err.status, err.message);
      return res.status(502).json({ error: `Claude API error (${err.status}).` });
    }
    console.error('[report-build] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

handler.config = { maxDuration: 300 };

module.exports = handler;

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function costOf(usage) {
  if (!usage) return 0;
  return (
    (usage.input_tokens || 0) * PRICING.input +
    (usage.cache_creation_input_tokens || 0) * PRICING.cache_creation +
    (usage.cache_read_input_tokens || 0) * PRICING.cache_read +
    (usage.output_tokens || 0) * PRICING.output
  );
}

function round4(n) {
  return Math.round((Number(n) || 0) * 10_000) / 10_000;
}

async function runBuildLoop({ anthropic, tools, userMessage }) {
  const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: userMessage }];
  const toolTrace = [];
  let submission = null;
  let totalCost = 0;
  let iterations = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations = i + 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      // 4096 was set to save cost while debugging — but with interleaved
      // thinking the agent burns part of its per-call output budget on
      // between-tool thinking blocks, and then runs out when it goes to
      // emit the final submit_built_report HTML. Smoke test: iter=4
      // bailed with stop_reason=max_tokens after 2 sql_calls. Raising to
      // 16000 gives ample room for thinking + tool_use + a ~12 KB report.
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system,
      tools,
      messages,
    });

    totalCost += costOf(response.usage);
    messages.push({ role: 'assistant', content: response.content });

    // Diagnostic — surfaces in Vercel function logs so we can see per-iteration
    // timing + token usage when investigating slow builds.
    console.log(
      `[report-build] iter=${i + 1} stop=${response.stop_reason} ` +
      `in=${response.usage?.input_tokens || 0} ` +
      `cache_r=${response.usage?.cache_read_input_tokens || 0} ` +
      `cache_w=${response.usage?.cache_creation_input_tokens || 0} ` +
      `out=${response.usage?.output_tokens || 0} ` +
      `cost_total=$${totalCost.toFixed(4)}`,
    );

    if (response.stop_reason === 'end_turn') {
      return {
        submission,
        toolTrace,
        totalCost,
        iterations,
        bailReason: submission ? '' : 'end_turn without submit',
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        if (block.name === 'submit_built_report') {
          if (submission) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Already submitted. Stop now.',
              is_error: true,
            });
          } else {
            submission = block.input;
            toolTrace.push({
              tool: block.name,
              input_size: JSON.stringify(block.input).length,
              is_error: false,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ ok: true, message: 'Submitted. End your turn.' }),
            });
          }
          continue;
        }
        const { is_error, content } = await executeTool(block.name, block.input);
        toolTrace.push({ tool: block.name, input: block.input, is_error });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content,
          ...(is_error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    return {
      submission,
      toolTrace,
      totalCost,
      iterations,
      bailReason: `stop_reason=${response.stop_reason}`,
    };
  }

  return { submission, toolTrace, totalCost, iterations, bailReason: 'iteration cap hit' };
}
