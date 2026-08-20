/**
 * POST /api/internal/build-hook — Supabase Database Webhook receiver.
 *
 * Configure in Supabase Dashboard → Database → Webhooks:
 *   Table:    report_requests
 *   Events:   INSERT
 *   Type:     HTTP Request
 *   URL:      https://your-deployment.example.com/api/internal/build-hook
 *   Method:   POST
 *   Headers:  x-internal-trigger: <INTERNAL_TRIGGER_SECRET>
 *
 * Payload shape Supabase sends:
 *   { type: 'INSERT', table: 'report_requests', schema: 'public',
 *     record: { id, status, ... }, old_record: null }
 *
 * Behavior: verifies the shared secret, then POSTs to /api/admin/report-build
 * with the same trigger header to fire the build. Returns 200 quickly (within
 * Supabase's webhook timeout) so the dashboard reports a successful delivery.
 *
 * Reliability note: the build POST is intentionally *not* awaited — the build
 * takes 30–60s and Supabase's webhook timeout is ~5s. The build endpoint
 * uses auto_build_attempted_at as a dedup guard, so even if the hourly cron
 * later picks up the same row, it'll no-op cleanly.
 */

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Shared-secret auth
  const rawHeader = req.headers['x-internal-trigger'];
  // If Supabase sends the header twice, Node represents it as an array — string
  // comparison would fail. Detect this case explicitly.
  const headerIsArray = Array.isArray(rawHeader);
  const triggerHeader = (rawHeader == null ? '' : rawHeader.toString());
  const triggerSecret = process.env.INTERNAL_TRIGGER_SECRET;
  if (!triggerSecret) {
    console.error('[build-hook] INTERNAL_TRIGGER_SECRET not set — refusing all hooks');
    return res.status(500).json({ error: 'Server misconfigured: no trigger secret' });
  }
  if (triggerHeader !== triggerSecret) {
    // Non-leaky diagnostic: enough to tell us what's wrong without exposing the secret.
    // Returns only lengths, first/last char EQUALITY (booleans, not the chars themselves),
    // and whitespace presence. Cannot be used to reconstruct either value.
    return res.status(401).json({
      error: 'Invalid trigger secret',
      diagnostic: {
        header_present: !!rawHeader,
        header_is_array: headerIsArray,
        header_len: triggerHeader.length,
        secret_len: triggerSecret.length,
        first_char_matches: triggerHeader.length > 0 && triggerSecret.length > 0 && triggerHeader[0] === triggerSecret[0],
        last_char_matches: triggerHeader.length > 0 && triggerSecret.length > 0 && triggerHeader[triggerHeader.length - 1] === triggerSecret[triggerSecret.length - 1],
        header_has_whitespace: /\s/.test(triggerHeader),
        secret_has_whitespace: /\s/.test(triggerSecret),
        header_after_trim_len: triggerHeader.trim().length,
        secret_after_trim_len: triggerSecret.trim().length,
        match_after_trim: triggerHeader.trim() === triggerSecret.trim(),
      },
    });
  }

  // Parse Supabase webhook payload
  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Only act on INSERTs into report_requests with status=pending
  if (payload.type !== 'INSERT' || payload.table !== 'report_requests') {
    return res.status(200).json({ ok: true, ignored: 'event not INSERT report_requests' });
  }
  const record = payload.record;
  if (!record || !record.id) {
    return res.status(400).json({ error: 'Webhook payload missing record.id' });
  }
  if (record.status !== 'pending') {
    return res.status(200).json({ ok: true, ignored: `status=${record.status}` });
  }
  if (record.auto_build_attempted_at) {
    return res.status(200).json({ ok: true, ignored: 'already attempted' });
  }

  const baseUrl = resolveBaseUrl(req);
  const buildUrl = `${baseUrl}/api/admin/report-build`;

  // We used to fire-and-forget the fetch here, but Vercel terminates the
  // worker before the dangling Promise is flushed — so the build POST
  // never actually went out. AWAIT the fetch instead, with a short
  // AbortController timeout: report-build's claim PATCH (which sets
  // auto_build_attempted_at + status='in_progress') happens in the first
  // ~500ms of its execution, so a 6-second client-side wait is plenty.
  // After we abort, report-build keeps running in its own Vercel instance
  // up to its own maxDuration (300s) — the AbortController only cancels
  // the client-side connection, not the server-side handler.
  //
  // Supabase's webhook timeout is ~5s, so it may mark THIS delivery as
  // failed cosmetically. That's fine — what matters is the DB state, and
  // by the time Supabase gives up, the claim is already written.
  let buildKickoffStatus = null;
  let buildKickoffError = null;
  try {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 6000);
    const r = await fetch(buildUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-trigger': triggerSecret,
      },
      body: JSON.stringify({ request_id: record.id }),
      signal: ac.signal,
    });
    clearTimeout(tid);
    buildKickoffStatus = r.status;
    const text = await r.text().catch(() => '');
    console.log(`[build-hook] report-build kickoff returned ${r.status} for ${record.id}: ${text.slice(0, 200)}`);
  } catch (err) {
    // AbortError is expected if report-build takes longer than 6s — the
    // build is still running server-side, we just stopped waiting.
    buildKickoffError = err.name === 'AbortError'
      ? 'client timeout (6s) — build continues server-side'
      : err.message;
    console.log(`[build-hook] report-build kickoff: ${buildKickoffError}`);
  }

  return res.status(200).json({
    ok: true,
    triggered: true,
    request_id: record.id,
    build_url: buildUrl,
    build_kickoff_status: buildKickoffStatus,
    build_kickoff_error: buildKickoffError,
  });
}

handler.config = { maxDuration: 30 };

module.exports = handler;

function resolveBaseUrl(req) {
  // PREFER the incoming request's host header. When the webhook calls us
  // at the public production URL, host = production URL — which is what we
  // want to forward to. `process.env.VERCEL_URL` is deployment-specific
  // (preview-style URL like your-deployment-abc123-….vercel.app) and
  // is protected by Vercel's Deployment Protection auth wall — calls to it
  // return 401, silently breaking fire-and-forget hops.
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (host) return `${proto}://${host}`;
  // Last-resort fallback when there's no request context
  return process.env.PUBLIC_BASE_URL || 'https://your-deployment.example.com';
}
