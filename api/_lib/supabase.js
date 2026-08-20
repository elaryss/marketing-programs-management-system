/**
 * Server-side Supabase client (service role) for the chat API.
 *
 * Never imported from the browser — lives under /api which Vercel only
 * runs server-side. The service role bypasses RLS, which is what we want
 * for chat_sessions / chat_messages writes; the chat_run_sql RPC has its
 * own SELECT-only guardrail regardless of which role calls it.
 */
const { createClient } = require('@supabase/supabase-js');

let cached = null;

function getSupabase() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Set both in Vercel env vars.',
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

module.exports = { getSupabase };
