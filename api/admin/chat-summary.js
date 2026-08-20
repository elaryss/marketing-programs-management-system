/**
 * Admin endpoint: chat-usage summaries.
 *
 * POST /api/admin/chat-summary       body: { days }   → generate + persist + return
 * GET  /api/admin/chat-summary                        → list past summaries (no body)
 * GET  /api/admin/chat-summary?id=<uuid>              → return one full summary
 *
 * Auth: caller must send `Authorization: Bearer <access_token>` from a
 * signed-in Supabase session. The token is verified server-side against
 * Supabase Auth; admin gating is implicit (only signed-in users hit the
 * admin page, which is where the call comes from).
 */
const Anthropic = require('@anthropic-ai/sdk');

const { getSupabase } = require('../_lib/supabase');
const { generateSummary } = require('../_lib/chat-summary');

const MAX_DAYS = 90;
const LIST_LIMIT = 50;

let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('Missing CLAUDE_API_KEY env var');
  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

async function handler(req, res) {
  const supabase = getSupabase();

  // --- Auth: verify the caller's Supabase session token ---
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });
  const token = m[1];
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  try {
    if (req.method === 'GET') {
      // Support ?id=… for the single-row fetch (used by the inline-expand UI).
      const url = new URL(req.url, 'http://x');
      const id = url.searchParams.get('id');
      if (id) {
        const { data, error } = await supabase
          .from('chat_summaries')
          .select('*')
          .eq('id', id)
          .single();
        if (error) return res.status(404).json({ error: error.message });
        return res.status(200).json(data);
      }
      const { data, error } = await supabase
        .from('chat_summaries')
        .select(
          'id, generated_at, window_days, window_start, window_end, session_count, message_count, user_turn_count, model',
        )
        .order('generated_at', { ascending: false })
        .limit(LIST_LIMIT);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ summaries: data || [] });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const days = Number.isFinite(+body.days) ? Math.floor(+body.days) : 7;
      if (days < 1 || days > MAX_DAYS) {
        return res.status(400).json({ error: `days must be between 1 and ${MAX_DAYS}` });
      }

      const { markdown, stats } = await generateSummary({
        supabase,
        anthropic: getAnthropic(),
        daysBack: days,
      });

      if (!markdown) {
        return res.status(200).json({
          empty: true,
          message: 'No chat activity in the window. Nothing to summarize.',
          stats,
        });
      }

      const { data: inserted, error: insertErr } = await supabase
        .from('chat_summaries')
        .insert({
          window_days: days,
          window_start: stats.windowStart,
          window_end: stats.windowEnd,
          session_count: stats.sessionCount,
          message_count: stats.messageCount,
          user_turn_count: stats.userTurnCount,
          summary_markdown: markdown,
          model: stats.model,
          generated_by: user.id,
        })
        .select()
        .single();
      if (insertErr) return res.status(500).json({ error: insertErr.message });

      return res.status(200).json(inserted);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Anthropic rate limit — try again shortly.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Server misconfiguration: invalid Claude API key.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[admin/chat-summary] Anthropic API error:', err.status, err.message);
      return res.status(502).json({ error: `Claude API error (${err.status}).` });
    }
    console.error('[admin/chat-summary] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

handler.config = { maxDuration: 60 };

module.exports = handler;
