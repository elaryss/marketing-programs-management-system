/**
 * GET /api/internal/auto-build-cron — Vercel Cron backstop.
 *
 * Runs on the schedule defined in vercel.json (`0 * * * *` — hourly, top of
 * the hour). Catches any report_requests rows that the Supabase webhook
 * missed — finds rows with status='pending' AND auto_build_attempted_at IS
 * NULL, and fires the builder for each (one per tick, sequentially, so we
 * never pile up Anthropic calls).
 *
 * Auth: Vercel cron requests carry an `Authorization: Bearer $CRON_SECRET`
 * header when CRON_SECRET is set in env, OR an `x-vercel-cron-signature`
 * header for newer schedules. We accept either, plus the internal trigger
 * secret for manual invocation during testing.
 *
 * Limits: builds at most CRON_MAX_PER_RUN rows per tick (default 3). Beyond
 * that, the next hour's tick picks up the rest. Keeps a single tick under
 * the 60s function timeout in the worst case.
 */
const { getSupabase } = require('../_lib/supabase');

const MAX_PER_RUN = Math.max(1, parseInt(process.env.CRON_MAX_PER_RUN || '3', 10));

async function handler(req, res) {
  // Accept GET (Vercel cron) and POST (manual test). Reject other methods.
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: accept Vercel's cron-signature header, OR a Bearer matching
  // CRON_SECRET, OR our internal trigger secret (lets you hit the endpoint
  // manually during testing).
  const cronSignature = req.headers['x-vercel-cron-signature'];
  const triggerHeader = (req.headers['x-internal-trigger'] || '').toString();
  const auth = req.headers.authorization || '';
  const cronSecret = process.env.CRON_SECRET;
  const triggerSecret = process.env.INTERNAL_TRIGGER_SECRET;

  const isVercelCron = !!cronSignature;
  const isCronBearer = cronSecret && auth === `Bearer ${cronSecret}`;
  const isInternal = triggerSecret && triggerHeader === triggerSecret;

  if (!isVercelCron && !isCronBearer && !isInternal) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = getSupabase();
  const baseUrl = resolveBaseUrl(req);

  // Find pending rows that haven't been auto-built yet
  const { data: rows, error: selErr } = await supabase
    .from('report_requests')
    .select('id, created_at, title')
    .eq('status', 'pending')
    .is('auto_build_attempted_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);

  if (selErr) {
    console.error('[auto-build-cron] select failed:', selErr.message);
    return res.status(500).json({ error: selErr.message });
  }

  if (!rows || rows.length === 0) {
    return res.status(200).json({ ok: true, found: 0, triggered: [] });
  }

  if (!triggerSecret) {
    console.error('[auto-build-cron] INTERNAL_TRIGGER_SECRET not set — cannot trigger builds');
    return res.status(500).json({ error: 'Server misconfigured: no trigger secret' });
  }

  // Fire builds sequentially so a single tick won't fan out into 14 parallel
  // Anthropic calls. The build endpoint dedups via auto_build_attempted_at —
  // safe if the webhook fired in the same window.
  const triggered = [];
  for (const row of rows) {
    try {
      const resp = await fetch(`${baseUrl}/api/admin/report-build`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-trigger': triggerSecret,
        },
        body: JSON.stringify({ request_id: row.id }),
      });
      const data = await resp.json().catch(() => ({}));
      triggered.push({
        id: row.id,
        status: resp.status,
        ok: !!data.ok,
        already_attempted: !!data.already_attempted,
        claim_lost: !!data.claim_lost,
        cost_usd: data.cost_usd,
      });
    } catch (err) {
      console.warn(`[auto-build-cron] build POST failed for ${row.id}: ${err.message}`);
      triggered.push({ id: row.id, error: err.message });
    }
  }

  return res.status(200).json({
    ok: true,
    found: rows.length,
    triggered,
  });
}

handler.config = { maxDuration: 60 };

module.exports = handler;

function resolveBaseUrl(req) {
  // PREFER host header over VERCEL_URL (which is deployment-specific and
  // protected by Vercel's Deployment Protection — calls to it return 401).
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (host) return `${proto}://${host}`;
  return process.env.PUBLIC_BASE_URL || 'https://your-deployment.example.com';
}
