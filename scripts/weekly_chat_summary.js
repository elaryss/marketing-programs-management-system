/**
 * Weekly chat usage summary — CLI.
 *
 * Pulls the last N days of chat_messages, sends them to Claude, writes a
 * themed summary to reports/weekly/chat-summary-YYYY-MM-DD.md, and also
 * persists the run to the chat_summaries table so it shows up in the
 * admin UI's "Chat Usage" tab.
 *
 * Run: node scripts/weekly_chat_summary.js [--days 7]
 *
 * Requires CLAUDE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
 * (same vars the live chat backend uses).
 */
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// Minimal .env loader — avoids pulling in dotenv for one script.
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
})();

const { getSupabase } = require('../api/_lib/supabase');
const { generateSummary } = require('../api/_lib/chat-summary');

const DAYS = (() => {
  const i = process.argv.indexOf('--days');
  const n = i >= 0 ? parseInt(process.argv[i + 1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 7;
})();

async function main() {
  const supabase = getSupabase();
  const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

  console.log(`Pulling chat_messages for last ${DAYS} days ...`);
  const { markdown, stats } = await generateSummary({ supabase, anthropic, daysBack: DAYS });

  console.log(
    `  ${stats.messageCount} messages · ${stats.sessionCount} sessions · ${stats.userTurnCount} user turns`,
  );

  if (!markdown) {
    console.log('No chat activity in the window. Nothing to summarize.');
    return;
  }

  // Persist to DB so the admin UI sees it too.
  const { data: inserted, error: insertErr } = await supabase
    .from('chat_summaries')
    .insert({
      window_days: DAYS,
      window_start: stats.windowStart,
      window_end: stats.windowEnd,
      session_count: stats.sessionCount,
      message_count: stats.messageCount,
      user_turn_count: stats.userTurnCount,
      summary_markdown: markdown,
      model: stats.model,
    })
    .select('id')
    .single();
  if (insertErr) {
    console.warn(`  (warn) DB insert failed: ${insertErr.message} — continuing with file write`);
  } else {
    console.log(`  Saved to chat_summaries (id: ${inserted.id})`);
  }

  // Also write to a markdown file for offline reading.
  const outDir = path.join(__dirname, '..', 'reports', 'weekly');
  fs.mkdirSync(outDir, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const outPath = path.join(outDir, `chat-summary-${dateStr}.md`);

  const header =
    `# Chat usage summary — ${dateStr}\n\n` +
    `**Window:** last ${DAYS} days · **Messages:** ${stats.messageCount} · ` +
    `**Sessions:** ${stats.sessionCount} · **User turns:** ${stats.userTurnCount}\n\n---\n\n`;

  fs.writeFileSync(outPath, header + markdown + '\n');
  console.log(`Wrote ${path.relative(path.join(__dirname, '..'), outPath)}`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
