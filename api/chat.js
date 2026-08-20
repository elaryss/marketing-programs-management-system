/**
 * POST /api/chat — Vercel Serverless Function.
 *
 * Request:  { session_id: uuid, message: string }
 * Response: { reply, tool_trace, session_id }
 *
 * Runs a Claude tool-use loop against the toolkit Supabase database via
 * the `get_schema` and `run_sql` tools. Persists the conversation in
 * chat_sessions / chat_messages so the next turn can pick up history.
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { getSupabase } = require('./_lib/supabase');
const { getToolDefinitions, executeTool } = require('./_lib/tools');

// ---------------------------------------------------------------------
// Module-scope cache for cold-start cost.
// ---------------------------------------------------------------------

// Behavior prompt (persona, audience, output format, conduct rules) +
// domain glossary (canonical data-interpretation reference — disambiguation
// map, vocabulary, anti-patterns). Concatenated at cold start so the agent
// always reads both. The glossary wins on conflict for data meaning; the
// behavior prompt wins for behavior/output. See prompts/domain-glossary.md.
const SYSTEM_PROMPT = [
  fs.readFileSync(path.join(__dirname, '..', 'prompts', 'chat-agent.md'), 'utf8'),
  fs.readFileSync(path.join(__dirname, '..', 'prompts', 'domain-glossary.md'), 'utf8'),
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
const HISTORY_LIMIT = 20;
const MAX_ITERATIONS = 10;
const MAX_MESSAGE_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let session_id, message, surface, requester_user_id;
  try {
    ({ session_id, message, surface, requester_user_id } = parseAndValidate(req.body));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const supabase = getSupabase();

    // Widget surface: look up the requester so submit_report_request can
    // denormalize their identity onto the queue row. Missing requester just
    // disables the submit tool — the widget can still answer questions.
    let requester = null;
    if (surface === 'widget' && requester_user_id) {
      const { data, error } = await supabase
        .from('demo_users')
        .select('id, display_name, email')
        .eq('id', requester_user_id)
        .single();
      if (error || !data) {
        return res.status(400).json({ error: 'Unknown requester_user_id' });
      }
      requester = data;
    }

    // 1. Ensure the session row exists (upsert by id so first-message ergo
    //    no separate create-session call from the client).
    await supabase
      .from('chat_sessions')
      .upsert({ id: session_id }, { onConflict: 'id', ignoreDuplicates: true });

    // 2. Load history (last N messages, oldest first).
    const history = await loadHistory(supabase, session_id);

    // 3. Persist the user turn (raw message, no Surface header — that's an
    //    in-flight decoration, not part of what the user actually typed).
    await supabase.from('chat_messages').insert({
      session_id,
      role: 'user',
      content: { text: message },
    });

    // 4. Decorate the in-flight message with the surface header so the
    //    prompt's Surface modes section can branch on it. Only the current
    //    turn needs the header — history messages already had the same
    //    surface for that session, but the prompt only consults the latest.
    const decoratedMessage = `[Surface: ${surface}]\n${message}`;

    // 5. Run the Claude tool-use loop.
    const messages = [
      ...historyToClaudeMessages(history),
      { role: 'user', content: decoratedMessage },
    ];

    const toolContext = { supabase, session_id, requester };
    const tools = getToolDefinitions(surface);

    const { replyText, toolTrace, finishedNormally, submittedRequestId } =
      await runToolLoop({ anthropic: getAnthropic(), messages, tools, toolContext });

    // 6. Persist the assistant turn.
    await supabase.from('chat_messages').insert({
      session_id,
      role: 'assistant',
      content: { text: replyText, tool_calls: toolTrace },
    });

    return res.status(200).json({
      session_id,
      reply: replyText,
      tool_trace: toolTrace,
      bailed: !finishedNormally,
      submitted_request_id: submittedRequestId || null,
    });
  } catch (err) {
    // Typed-exception classification (per the claude-api skill — no string
    // matching on messages).
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic rate limit — try again shortly.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfiguration: invalid Claude API key.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[chat] Anthropic API error:', err.status, err.message);
      return res.status(502).json({ error: `Claude API error (${err.status}).` });
    }
    console.error('[chat] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
}

// Vercel function config — give the tool-use loop room to finish.
// Hobby tier caps at 10s (the loop will sometimes blow through that);
// Pro/Team plans honor this value up to 300s.
handler.config = { maxDuration: 60 };

module.exports = handler;

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

const VALID_SURFACES = new Set(['widget', 'custom_report']);

function parseAndValidate(body) {
  // Vercel auto-parses JSON bodies for the Node runtime, but accept a string
  // body too just in case.
  let payload = body;
  if (typeof body === 'string') {
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error('Request body is not valid JSON.');
    }
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }
  const { session_id, message, surface, requester_user_id } = payload;
  if (typeof session_id !== 'string' || !UUID_RE.test(session_id)) {
    throw new Error('session_id must be a UUID string.');
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('message must be a non-empty string.');
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
  }
  // Default to 'custom_report' for back-compat with any caller that hasn't
  // been updated yet — that keeps the existing table-rich behavior.
  const resolvedSurface = surface == null ? 'custom_report' : surface;
  if (!VALID_SURFACES.has(resolvedSurface)) {
    throw new Error(`surface must be one of: ${[...VALID_SURFACES].join(', ')}`);
  }
  let resolvedRequester = null;
  if (requester_user_id != null) {
    if (typeof requester_user_id !== 'string' || !UUID_RE.test(requester_user_id)) {
      throw new Error('requester_user_id must be a UUID string.');
    }
    resolvedRequester = requester_user_id;
  }
  return {
    session_id,
    message,
    surface: resolvedSurface,
    requester_user_id: resolvedRequester,
  };
}

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------

async function loadHistory(supabase, session_id) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', session_id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    console.error('[chat] history load failed:', error.message);
    return [];
  }
  return (data || []).reverse();
}

// Turn persisted rows into Claude MessageParam[]. For assistant rows we
// only kept the plain text (no thinking signatures, no tool_use blocks)
// — that's lossy on purpose: replaying full tool traces would balloon
// context and the agent doesn't need its prior reasoning verbatim to
// answer the next turn.
function historyToClaudeMessages(history) {
  return history
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({
      role: row.role,
      content: row.content?.text || '',
    }))
    .filter((m) => m.content && m.content.length > 0);
}

// ---------------------------------------------------------------------
// Tool-use loop
// ---------------------------------------------------------------------

async function runToolLoop({ anthropic, messages, tools, toolContext }) {
  const toolTrace = [];
  let submittedRequestId = null;

  // cache_control on the last (only) system block caches tools + system
  // together. Each turn within a session hits the same cached prefix.
  const system = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' },
    },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system,
      tools,
      messages,
    });

    // Append the assistant turn verbatim — preserves thinking signatures
    // and tool_use blocks so the next turn can attach tool_results by id.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      return {
        replyText: extractText(response.content),
        toolTrace,
        finishedNormally: true,
        submittedRequestId,
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        // Guard against the model calling submit_report_request twice in
        // one conversation — the second call short-circuits with an error
        // so the model closes out with a brief confirmation.
        if (block.name === 'submit_report_request' && submittedRequestId) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Already submitted. Reply with a brief confirmation and stop.',
            is_error: true,
          });
          toolTrace.push({
            tool: block.name,
            input: block.input,
            output: 'Already submitted.',
            is_error: true,
          });
          continue;
        }
        const { is_error, content } = await executeTool(
          block.name,
          block.input,
          toolContext,
        );
        if (!is_error && block.name === 'submit_report_request') {
          try {
            const parsed = JSON.parse(content);
            if (parsed && parsed.request_id) submittedRequestId = parsed.request_id;
          } catch (_) {
            // Non-JSON content for this tool means executor returned the
            // raw string — uncommon, but don't crash the loop.
          }
        }
        toolTrace.push({
          tool: block.name,
          input: block.input,
          output: content,
          is_error,
        });
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

    // Any other stop_reason (max_tokens, refusal, pause_turn) — bail
    // gracefully rather than loop.
    const tail = extractText(response.content);
    return {
      replyText:
        tail ||
        `I had to stop early (stop reason: ${response.stop_reason}). Try a narrower question.`,
      toolTrace,
      finishedNormally: false,
      submittedRequestId,
    };
  }

  // Hit the iteration cap.
  return {
    replyText:
      "I couldn't finish this in a reasonable number of steps. Try breaking it into a narrower question — for example, ask about one program or one item type at a time.",
    toolTrace,
    finishedNormally: false,
    submittedRequestId,
  };
}

function extractText(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
