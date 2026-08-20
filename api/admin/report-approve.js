/**
 * POST /api/admin/report-approve — Vercel Serverless Function.
 *
 * Request:  { request_id, action: 'approve'|'reject', admin_notes? }
 * Auth:     EITHER
 *             - Authorization: Bearer <supabase session>   (manual admin click)
 *             - x-internal-trigger: <INTERNAL_TRIGGER_SECRET>  (auto-approve
 *                                   from the reviewer agent on a passing verdict)
 *
 * On approve: status → approved_sent, set reviewed_by/reviewed_at, then
 * call /api/admin/send-report-email to deliver the email. On reject:
 * status → rejected, capture admin_notes. Either action no-ops if the row
 * is already in a terminal state, returning the current state to the UI.
 *
 * When the internal trigger is used (auto-approve from reviewer), there is
 * no human user identity, so reviewed_by is left null. The reviewer passes
 * an admin_notes string like "[auto-approved by reviewer: pass 4.8/5]" so
 * the admin queue UI can show what happened.
 */
const { getSupabase } = require('../_lib/supabase');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getSupabase();

  // Auth: Bearer (manual admin) OR x-internal-trigger (reviewer auto-approve).
  // Token is used downstream to call send-report-email when present; the
  // internal-trigger path falls back to the shared secret for that hop too.
  const triggerHeader = (req.headers['x-internal-trigger'] || '').toString();
  const triggerSecret = process.env.INTERNAL_TRIGGER_SECRET;
  const isInternal = !!triggerHeader && !!triggerSecret && triggerHeader === triggerSecret;

  let user = null;
  let token = null;
  if (!isInternal) {
    const auth = req.headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing bearer token (or invalid internal trigger)' });
    token = m[1];
    const { data: { user: u }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !u) return res.status(401).json({ error: 'Invalid session' });
    user = u;
  }

  // Parse body
  let request_id, action, admin_notes;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    request_id = body.request_id;
    action = body.action;
    admin_notes = body.admin_notes || null;
    if (typeof request_id !== 'string' || !UUID_RE.test(request_id)) {
      return res.status(400).json({ error: 'request_id must be a UUID' });
    }
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: "action must be 'approve' or 'reject'" });
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    const { data: request, error: reqErr } = await supabase
      .from('report_requests')
      .select('id, status, requester_email, report_html')
      .eq('id', request_id)
      .single();
    if (reqErr || !request) return res.status(404).json({ error: 'Request not found' });

    if (action === 'reject') {
      // Reject is not supported on the internal-trigger path — the reviewer
      // never rejects, only auto-approves. Block to be explicit.
      if (isInternal) {
        return res.status(403).json({ error: 'Internal trigger may not reject.' });
      }
      const { error: updErr } = await supabase
        .from('report_requests')
        .update({
          status: 'rejected',
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          admin_notes,
        })
        .eq('id', request_id);
      if (updErr) throw new Error(updErr.message);
      return res.status(200).json({ ok: true, action: 'reject', request_id });
    }

    // action === 'approve'
    if (!request.report_html) {
      return res.status(409).json({ error: 'Cannot approve — report has not been built yet.' });
    }
    if (request.status === 'approved_sent') {
      return res.status(200).json({ ok: true, action: 'approve', request_id, already_sent: true });
    }

    // Mark approved first (set reviewed_at), then attempt email.
    // reviewed_by stays NULL on the internal-trigger path — there's no
    // human user identity. The admin_notes string carries the audit trail.
    const { error: updErr } = await supabase
      .from('report_requests')
      .update({
        status: 'approved_sent',
        reviewed_by: user?.id || null,
        reviewed_at: new Date().toISOString(),
        admin_notes,
      })
      .eq('id', request_id);
    if (updErr) throw new Error(updErr.message);

    // Best-effort email send. If it fails, the row stays approved_sent but
    // email_sent_at remains null. We also persist the error to admin_notes so
    // it's diagnosable via SQL without having to dig through Vercel logs.
    let email_sent = false;
    let email_error = null;
    let email_status_code = null;
    try {
      const baseUrl = resolveBaseUrl(req);
      // Use the shared internal-trigger secret for server-to-server auth
      // rather than forwarding the user's Bearer token. The Python
      // sb.auth.get_user() call was returning 401 even with a valid token —
      // probably a supabase-py version quirk. The shared secret is more
      // reliable for internal hops and doesn't depend on user identity.
      const triggerSecret = process.env.INTERNAL_TRIGGER_SECRET || '';
      const internalHeaders = { 'Content-Type': 'application/json' };
      if (triggerSecret) {
        internalHeaders['x-internal-trigger'] = triggerSecret;
      } else {
        // Fallback if the secret isn't configured: forward the user token
        internalHeaders['Authorization'] = `Bearer ${token}`;
      }
      const resp = await fetch(`${baseUrl}/api/admin/send-report-email`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify({ request_id }),
      });
      email_status_code = resp.status;
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data?.ok) {
        email_sent = true;
      } else {
        email_error = data?.error || `email endpoint returned ${resp.status}`;
      }
    } catch (e) {
      email_error = e.message || String(e);
    }

    // Persist the email outcome so we can debug post-hoc without Vercel log access.
    // Failure case overwrites admin_notes with the diagnostic; success case clears it.
    const diagnosticNote = email_sent
      ? null
      : `[email send failed @ ${new Date().toISOString()}] HTTP ${email_status_code || 'no-status'}: ${email_error || 'unknown'}`;
    if (diagnosticNote || admin_notes !== null) {
      await supabase
        .from('report_requests')
        .update({ admin_notes: diagnosticNote || admin_notes })
        .eq('id', request_id);
    }

    return res.status(200).json({
      ok: true,
      action: 'approve',
      request_id,
      email_sent,
      email_status_code,
      ...(email_error ? { email_error } : {}),
    });
  } catch (err) {
    console.error('[report-approve] Unexpected error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

handler.config = { maxDuration: 30 };

module.exports = handler;

// Derive the base URL for internal fetches. Vercel sets VERCEL_URL on each
// deployment; locally (vercel dev) it's missing and we fall back to host.
function resolveBaseUrl(req) {
  // PREFER host header over VERCEL_URL — VERCEL_URL is deployment-specific
  // (preview-style URL) and protected by Vercel's Deployment Protection.
  // The host header gives us the production URL the user hit.
  const proto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString();
  if (host) return `${proto}://${host}`;
  return process.env.PUBLIC_BASE_URL || 'https://your-deployment.example.com';
}
