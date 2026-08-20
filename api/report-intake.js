/**
 * POST /api/report-intake — Vercel Serverless Function.
 *
 * Request:  { session_id: uuid, message: string, requester_user_id: uuid }
 * Response: { reply, submitted, request_id, session_id, bailed }
 *
 * Runs a Claude tool-use loop with one tool, `submit_report_request`.
 * The intake agent asks ≤3 clarifying questions, then submits a row to
 * report_requests with status='pending'. Conversation turns are persisted
 * to chat_messages so the admin can replay the Q&A.
 *
 * Mirrors api/chat.js closely; the differences:
 *   1. Different system prompt (prompts/report-intake.md).
 *   2. Different tools (one local executor for the queue insert).
 *   3. Requires requester_user_id every turn so the executor knows which
 *      demo_users row to denormalize email/name from.
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const { getSupabase } = require('./_lib/supabase');

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '..', 'prompts', 'report-intake.md'),
  'utf8',
);

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
const MAX_ITERATIONS = 6;
const MAX_MESSAGE_BYTES = 4096;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TOOL_DEFINITIONS = [
  {
    name: 'submit_report_request',
    description:
      "Submit the report request to the queue once you have a clear title and description. After calling this, your text response should be a brief confirmation (one sentence). Call this exactly once per conversation.",
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short headline-style title, 80 chars or fewer.',
          maxLength: 80,
        },
        description: {
          type: 'string',
          description:
            'Full description of what the requester wants to see. Specific enough that the builder agent can produce the report without follow-up.',
        },
        suggested_filters: {
          type: 'object',
          description:
            'Scope hints captured from the conversation. Leave any field empty/missing if the requester did not specify it.',
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
            "Free-form notes for the builder agent: chart preferences, audience hint, comparison hints, any assumptions you made on the requester's behalf. Empty string if none.",
        },
      },
      required: ['title', 'description', 'suggested_filters', 'notes_for_builder'],
      additionalProperties: false,
    },
  },
];

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let session_id, message, requester_user_id;
  try {
    ({ session_id, message, requester_user_id } = parseAndValidate(req.body));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const supabase = getSupabase();

    // Look up the demo user — this denormalizes email/name onto the
    // queue row and also validates that the requester id is a real seed.
    const { data: requester, error: reqErr } = await supabase
      .from('demo_users')
      .select('id, display_name, email')
      .eq('id', requester_user_id)
      .single();
    if (reqErr || !requester) {
      return res.status(400).json({ error: 'Unknown requester_user_id' });
    }

    await supabase
      .from('chat_sessions')
      .upsert({ id: session_id }, { onConflict: 'id', ignoreDuplicates: true });

    const history = await loadHistory(supabase, session_id);

    await supabase.from('chat_messages').insert({
      session_id,
      role: 'user',
      content: { text: message },
    });

    const messages = [
      ...historyToClaudeMessages(history),
      { role: 'user', content: message },
    ];

    const { replyText, submitted, finishedNormally } = await runIntakeLoop({
      anthropic: getAnthropic(),
      messages,
      supabase,
      session_id,
      requester,
    });

    await supabase.from('chat_messages').insert({
      session_id,
      role: 'assistant',
      content: { text: replyText, submitted: submitted ? submitted.id : null },
    });

    return res.status(200).json({
      session_id,
      reply: replyText,
      submitted: !!submitted,
      request_id: submitted ? submitted.id : null,
      bailed: !finishedNormally,
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic rate limit — try again shortly.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfiguration: invalid Claude API key.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[report-intake] Anthropic API error:', err.status, err.message);
      return res.status(502).json({ error: `Claude API error (${err.status}).` });
    }
    console.error('[report-intake] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
}

handler.config = { maxDuration: 45 };

module.exports = handler;

function parseAndValidate(body) {
  let payload = body;
  if (typeof body === 'string') {
    try { payload = JSON.parse(body); } catch { throw new Error('Request body is not valid JSON.'); }
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Request body must be a JSON object.');
  }
  const { session_id, message, requester_user_id } = payload;
  if (typeof session_id !== 'string' || !UUID_RE.test(session_id)) {
    throw new Error('session_id must be a UUID string.');
  }
  if (typeof requester_user_id !== 'string' || !UUID_RE.test(requester_user_id)) {
    throw new Error('requester_user_id must be a UUID string.');
  }
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error('message must be a non-empty string.');
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    throw new Error(`message exceeds ${MAX_MESSAGE_BYTES} bytes.`);
  }
  return { session_id, message, requester_user_id };
}

async function loadHistory(supabase, session_id) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role, content, created_at')
    .eq('session_id', session_id)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) {
    console.error('[report-intake] history load failed:', error.message);
    return [];
  }
  return (data || []).reverse();
}

function historyToClaudeMessages(history) {
  return history
    .filter((row) => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role, content: row.content?.text || '' }))
    .filter((m) => m.content && m.content.length > 0);
}

async function runIntakeLoop({ anthropic, messages, supabase, session_id, requester }) {
  const system = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ];

  let submitted = null;

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      return {
        replyText: extractText(response.content),
        submitted,
        finishedNormally: true,
      };
    }

    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        if (block.name === 'submit_report_request' && !submitted) {
          try {
            submitted = await insertRequestRow({
              supabase,
              session_id,
              requester,
              input: block.input,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify({ ok: true, request_id: submitted.id }),
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error submitting request: ${err.message}`,
              is_error: true,
            });
          }
        } else {
          // Double-submit or unknown tool — return an error so the model
          // closes out with a confirmation message instead of looping.
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Already submitted. Reply with a brief confirmation and stop.',
            is_error: true,
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const tail = extractText(response.content);
    return {
      replyText:
        tail ||
        `I had to stop early (stop reason: ${response.stop_reason}). Please try again.`,
      submitted,
      finishedNormally: false,
    };
  }

  return {
    replyText:
      "I couldn't finalize the request in a reasonable number of turns. Please try again with a clearer description of what you want.",
    submitted,
    finishedNormally: false,
  };
}

async function insertRequestRow({ supabase, session_id, requester, input }) {
  const { title, description, suggested_filters, notes_for_builder } = input || {};
  if (!title || !description) {
    throw new Error('title and description are required');
  }
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
    },
    status: 'pending',
  };
  const { data, error } = await supabase
    .from('report_requests')
    .insert(row)
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function extractText(content) {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
