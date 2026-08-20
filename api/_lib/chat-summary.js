/**
 * Shared chat-usage summarizer.
 *
 * Pulls chat_messages from the last `daysBack` days, builds a digest, and
 * asks Claude for a themed report. Used by both the CLI script
 * (scripts/weekly_chat_summary.js) and the admin endpoint
 * (api/admin/chat-summary.js) so prompt + digest logic stays in one place.
 */

const MODEL_DEFAULT = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

async function generateSummary({ supabase, anthropic, daysBack = 7, model = MODEL_DEFAULT }) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - daysBack * 24 * 60 * 60 * 1000);

  const { data: rows, error } = await supabase
    .from('chat_messages')
    .select('session_id, role, content, created_at')
    .gte('created_at', windowStart.toISOString())
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Supabase: ${error.message}`);

  const baseStats = {
    messageCount: rows?.length || 0,
    sessionCount: 0,
    userTurnCount: 0,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    daysBack,
    model,
  };

  if (!rows || !rows.length) {
    return { markdown: null, stats: baseStats };
  }

  // Group by session, preserving chronological insertion order.
  const sessions = new Map();
  for (const row of rows) {
    if (!sessions.has(row.session_id)) sessions.set(row.session_id, []);
    sessions.get(row.session_id).push(row);
  }
  const userTurnCount = rows.filter((r) => r.role === 'user').length;

  // Build the digest. Assistant replies are truncated — we mostly care about
  // what was asked and whether it landed, not the full answer text.
  const blocks = [];
  let i = 1;
  for (const [, msgs] of sessions) {
    const lines = [`### Session ${i++} (${msgs[0].created_at.slice(0, 10)})`];
    for (const m of msgs) {
      const text = (m.content?.text || '').trim();
      if (!text) continue;
      if (m.role === 'user') {
        lines.push(`USER: ${text}`);
      } else {
        const truncated = text.length > 400 ? text.slice(0, 400) + ' [...]' : text;
        lines.push(`AGENT: ${truncated}`);
      }
    }
    blocks.push(lines.join('\n'));
  }
  const digest = blocks.join('\n\n');

  const prompt = `You are reviewing ${daysBack} days of chat logs from an internal marketing-analytics tool used by ABC's Pre-Buy team. Users ask a chat agent questions about pre-buy POS marketing spend, sourcing status, and ordering data.

Below are the transcripts (one session per block, oldest first). Produce a tight markdown report covering:

1. **Top themes** — what kinds of questions are users asking? Group by topic (e.g. "spend by brand", "MOQ vs ordered quantity", "vendor comparisons", "status of the buy"). For each theme give a short label, the count of distinct sessions that asked about it, and one verbatim example question.
2. **Dead-ends and friction** — where did the agent struggle? Look for the bail message ("I couldn't finish this in a reasonable number of steps"), repeated rephrasing within a session, error replies, or the user expressing dissatisfaction. Quote the failing question when useful.
3. **Candidate canned reports** — based on the themes, what 3-5 pre-built reports would save users from typing the same question repeatedly? For each, name it, describe what it shows in one sentence, and reference the theme it serves.

Keep the whole thing under one page. Do not walk through sessions individually — focus on patterns across the window. If activity is too thin to draw conclusions, say so plainly instead of padding.

---

${digest}`;

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });

  const markdown = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return {
    markdown,
    stats: {
      ...baseStats,
      sessionCount: sessions.size,
      userTurnCount,
    },
  };
}

module.exports = { generateSummary };
