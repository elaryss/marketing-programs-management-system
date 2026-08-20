/**
 * POST /api/admin/report-review — Vercel Serverless Function.
 *
 * Reviews a built report against the 4-criterion rubric in
 * prompts/report-reviewer.md and writes the verdict to the row's
 * review_* columns. Runs a small Claude tool-use loop (get_schema +
 * run_sql + forced submit_review) capped at 4 iterations and 3 SQL
 * calls so cost stays bounded (~$0.05–0.15/review).
 *
 * Request:  { request_id }
 * Auth:     EITHER
 *             - Authorization: Bearer <supabase session>   (manual re-review)
 *             - x-internal-trigger: <INTERNAL_TRIGGER_SECRET>  (auto after build)
 *
 * On success: writes review_verdict, review_score, review_findings,
 * review_cost_usd, reviewed_by_agent_at on the report_requests row.
 * Does NOT change `status` — review is metadata; the admin still
 * decides whether to approve / reject / edit.
 *
 * On failure (bail / Anthropic error): writes review_cost_usd if any
 * was incurred, leaves the rest NULL. The row is unaffected; the UI
 * shows "Not reviewed" and the admin can re-review manually.
 *
 * DISCONNECT GUIDE: deleting this file is safe. The fire-and-forget
 * hook in api/admin/report-build.js will fail silently (it's wrapped
 * in try/catch). The admin queue + report viewer treat NULL review_*
 * columns as "Not reviewed" and render no panel.
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { getSupabase } = require('../_lib/supabase');
const { TOOL_DEFINITIONS: BASE_TOOLS, executeTool } = require('../_lib/tools');

// Behavior prompt + domain glossary, same pattern as the builder.
// The glossary wins for data interpretation; this prompt wins for
// review behavior, scoring rubric, and output format.
const SYSTEM_PROMPT = [
  fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'report-reviewer.md'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'domain-glossary.md'), 'utf8'),
].join('\n\n---\n\n');

let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('Missing CLAUDE_API_KEY env var');
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const MAX_ITERATIONS = 4;
const MAX_SQL_CALLS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sonnet 4.6 pricing — identical to builder. Kept local rather than
// shared so this module stays deletable in one file delete.
const PRICING = {
  input:          3.0e-6,
  cache_creation: 3.75e-6,
  cache_read:     0.30e-6,
  output:         15.0e-6,
};

const SUBMIT_TOOL = {
  name: 'submit_review',
  description:
    'Submit the review verdict. Call exactly once when you are done scoring. After this call your turn ends — do not return prose.',
  input_schema: {
    type: 'object',
    properties: {
      scores: {
        type: 'object',
        properties: {
          faithful_to_ask:        { type: 'integer', minimum: 1, maximum: 5 },
          data_supports_story:    { type: 'integer', minimum: 1, maximum: 5 },
          story_layout_coherence: { type: 'integer', minimum: 1, maximum: 5 },
          format_hygiene:         { type: 'integer', minimum: 1, maximum: 5 },
        },
        required: ['faithful_to_ask', 'data_supports_story', 'story_layout_coherence', 'format_hygiene'],
        additionalProperties: false,
      },
      rationale: {
        type: 'object',
        description: 'One sentence per criterion (≤ 30 words each) explaining the score.',
        properties: {
          faithful_to_ask:        { type: 'string' },
          data_supports_story:    { type: 'string' },
          story_layout_coherence: { type: 'string' },
          format_hygiene:         { type: 'string' },
        },
        required: ['faithful_to_ask', 'data_supports_story', 'story_layout_coherence', 'format_hygiene'],
        additionalProperties: false,
      },
      flags: {
        type: 'array',
        description: 'Specific issues found. Each tied to one criterion.',
        items: {
          type: 'object',
          properties: {
            criterion: {
              type: 'string',
              enum: ['faithful_to_ask', 'data_supports_story', 'story_layout_coherence', 'format_hygiene'],
            },
            severity: { type: 'string', enum: ['minor', 'major'] },
            detail:   { type: 'string' },
          },
          required: ['criterion', 'severity', 'detail'],
          additionalProperties: false,
        },
      },
      suggestions: {
        type: 'array',
        description: 'Ranked actions for the admin (≤ 5). Each is one imperative sentence.',
        items: { type: 'string' },
        maxItems: 5,
      },
      verdict:       { type: 'string', enum: ['pass', 'warn', 'fail'] },
      overall_score: { type: 'number', minimum: 1, maximum: 5 },
    },
    required: ['scores', 'rationale', 'flags', 'suggestions', 'verdict', 'overall_score'],
    additionalProperties: false,
  },
};

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getSupabase();

  // ── Auth: Bearer (manual re-review) OR x-internal-trigger (auto) ──
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

  try {
    // ── Load the row ──
    const { data: request, error: reqErr } = await supabase
      .from('report_requests')
      .select('*')
      .eq('id', request_id)
      .single();
    if (reqErr || !request) return res.status(404).json({ error: 'Request not found' });
    if (!request.report_html) {
      return res.status(409).json({ error: 'Cannot review: report has not been built yet.' });
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

    // ── Compose the reviewer's input ──
    const transcriptText = transcript
      .map(m => `[${m.role.toUpperCase()}] ${m.content?.text || ''}`)
      .join('\n\n');

    const queriesBlock = (request.report_queries || [])
      .map((q, i) => `### Query ${i + 1} — ${q.label || '(no label)'}\n\nrows: ${q.row_count ?? '?'}\n\n\`\`\`sql\n${q.sql}\n\`\`\``)
      .join('\n\n');

    const userMessage = [
      `# Report to review`,
      ``,
      `## The ask`,
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
      `## The built report`,
      ``,
      `**report_filters_spec (the scope the builder claims it applied):**`,
      '```json',
      JSON.stringify(request.report_filters_spec || {}, null, 2),
      '```',
      ``,
      `**report_narrative:**`,
      request.report_narrative || '_no narrative_',
      ``,
      `**report_html:**`,
      '```html',
      request.report_html,
      '```',
      ``,
      `---`,
      ``,
      `## Build trace — queries the builder actually ran`,
      ``,
      queriesBlock || '_no queries recorded_',
      ``,
      `---`,
      ``,
      `Read it all, run at most 3 spot-check queries on load-bearing claims, then call \`submit_review\` exactly once. Do not rewrite the report.`,
    ].join('\n');

    // ── Run the review loop ──
    const tools = [...BASE_TOOLS, SUBMIT_TOOL];
    const result = await runReviewLoop({
      anthropic: getAnthropic(),
      tools,
      userMessage,
    });

    // Persist cost regardless of outcome.
    const baseUpdate = { review_cost_usd: round4(result.totalCost) };

    if (!result.submission) {
      // Reviewer bailed without a submit_review call. Save cost,
      // leave verdict NULL so the UI shows "Not reviewed". Admin
      // can hit "Re-review" to retry.
      await supabase.from('report_requests').update(baseUpdate).eq('id', request_id);
      return res.status(502).json({
        error: 'Reviewer did not submit a verdict. ' + (result.bailReason || ''),
        cost_usd: round4(result.totalCost),
        iterations: result.iterations,
      });
    }

    const { verdict, overall_score, scores, rationale, flags, suggestions } = result.submission;
    const scoreRounded = round1(overall_score);

    const { error: updateErr } = await supabase
      .from('report_requests')
      .update({
        ...baseUpdate,
        review_verdict: verdict,
        review_score: scoreRounded,
        review_findings: { scores, rationale, flags, suggestions, sql_calls: result.sqlCalls },
        reviewed_by_agent_at: new Date().toISOString(),
      })
      .eq('id', request_id);
    if (updateErr) throw new Error(updateErr.message);

    // ══════════════════════════════════════════════════════════════
    // AUTO-APPROVE HOOK — safe to delete this whole block.
    // When the verdict is good enough (pass OR overall_score ≥ 4)
    // AND the auto_review_enabled toggle is still on AND the row
    // isn't already approved, fire-and-forget call to
    // /api/admin/report-approve to send the email.
    //
    // The toggle re-check matters: an admin may have flipped it off
    // between the build firing and the review completing. If it's
    // off now, we just write the verdict and stop — the admin will
    // approve manually.
    //
    // To disable auto-approve while keeping auto-review:
    //   - quickest: comment out this block and redeploy
    //   - or: add a second toggle column to app_settings later
    // ══════════════════════════════════════════════════════════════
    const passesThreshold = verdict === 'pass' || scoreRounded >= 4;
    if (passesThreshold && process.env.INTERNAL_TRIGGER_SECRET && request.status !== 'approved_sent') {
      try {
        const { data: settings } = await supabase
          .from('app_settings')
          .select('auto_review_enabled')
          .eq('id', 1)
          .single();
        if (settings?.auto_review_enabled) {
          const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
          const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
          const baseUrl = host
            ? `${proto}://${host}`
            : (process.env.PUBLIC_BASE_URL || 'https://your-deployment.example.com');
          const adminNote = `[auto-approved by reviewer: ${verdict} ${scoreRounded}/5 @ ${new Date().toISOString()}]`;
          // Same fire-and-forget trap as build → review: dangling fetch
          // gets cut off when Vercel freezes this worker after res.json().
          // Await the kickoff with a short AbortController timeout — the
          // approve endpoint flips the row + sends email in its own
          // instance up to its maxDuration.
          try {
            const ac = new AbortController();
            const tid = setTimeout(() => ac.abort(), 6000);
            const r = await fetch(`${baseUrl}/api/admin/report-approve`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-trigger': process.env.INTERNAL_TRIGGER_SECRET,
              },
              body: JSON.stringify({
                request_id,
                action: 'approve',
                admin_notes: adminNote,
              }),
              signal: ac.signal,
            });
            clearTimeout(tid);
            console.log(`[report-review] auto-approve kickoff returned ${r.status} for ${request_id}`);
          } catch (err) {
            const msg = err.name === 'AbortError'
              ? 'client timeout (6s) — approve continues server-side'
              : (err?.message || err);
            console.warn('[report-review] auto-approve fetch:', msg);
          }
        }
      } catch (hookErr) {
        console.warn('[report-review] auto-approve hook skipped:', hookErr?.message || hookErr);
      }
    }
    // ══════════════════════════════════════════════════════════════
    // END AUTO-APPROVE HOOK
    // ══════════════════════════════════════════════════════════════

    return res.status(200).json({
      ok: true,
      request_id,
      verdict,
      score: scoreRounded,
      cost_usd: round4(result.totalCost),
      iterations: result.iterations,
      sql_calls: result.sqlCalls,
      auto_approve_fired: passesThreshold,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic rate limit — try again shortly.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfiguration: invalid Claude API key.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[report-review] Anthropic API error:', err.status, err.message);
      return res.status(502).json({ error: `Claude API error (${err.status}).` });
    }
    console.error('[report-review] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

handler.config = { maxDuration: 120 };

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

function round4(n) { return Math.round((Number(n) || 0) * 10_000) / 10_000; }
function round1(n) { return Math.round((Number(n) || 0) * 10) / 10; }

async function runReviewLoop({ anthropic, tools, userMessage }) {
  const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];
  const messages = [{ role: 'user', content: userMessage }];
  let submission = null;
  let totalCost = 0;
  let iterations = 0;
  let sqlCalls = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations = i + 1;
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      // No thinking, low effort — this is a structured judgment task.
      output_config: { effort: 'low' },
      system,
      tools,
      messages,
    });

    totalCost += costOf(response.usage);
    messages.push({ role: 'assistant', content: response.content });

    console.log(
      `[report-review] iter=${i + 1} stop=${response.stop_reason} ` +
      `sql_calls=${sqlCalls} ` +
      `in=${response.usage?.input_tokens || 0} ` +
      `cache_r=${response.usage?.cache_read_input_tokens || 0} ` +
      `out=${response.usage?.output_tokens || 0} ` +
      `cost_total=$${totalCost.toFixed(4)}`,
    );

    if (response.stop_reason === 'end_turn') {
      return {
        submission,
        totalCost,
        iterations,
        sqlCalls,
        bailReason: submission ? '' : 'end_turn without submit',
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        if (block.name === 'submit_review') {
          if (submission) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Already submitted. Stop now.',
              is_error: true,
            });
          } else {
            submission = block.input;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ ok: true, message: 'Verdict recorded. End your turn.' }),
            });
          }
          continue;
        }
        if (block.name === 'run_sql') {
          if (sqlCalls >= MAX_SQL_CALLS) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `SQL budget exhausted (${MAX_SQL_CALLS} calls max). Submit your verdict now with what you have.`,
              is_error: true,
            });
            continue;
          }
          sqlCalls++;
        }
        const { is_error, content } = await executeTool(block.name, block.input);
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
      totalCost,
      iterations,
      sqlCalls,
      bailReason: `stop_reason=${response.stop_reason}`,
    };
  }

  return { submission, totalCost, iterations, sqlCalls, bailReason: 'iteration cap hit' };
}
