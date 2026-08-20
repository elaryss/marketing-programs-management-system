/**
 * GET / PATCH  /api/admin/settings — single-row app_settings.
 *
 * GET   → returns { auto_review_enabled, updated_at }.
 * PATCH → updates the settings row. Body: { auto_review_enabled: boolean }.
 *
 * Auth: Authorization: Bearer <supabase session>. Any signed-in user
 * can read + write — the password gate is the real boundary, same
 * pattern as the rest of /admin.
 *
 * DISCONNECT GUIDE: this endpoint exists only to drive the auto-review
 * toggle. If the reviewer feature is removed, delete this file along
 * with prompts/report-reviewer.md + api/admin/report-review.js + the
 * REPORT REVIEW HOOK block in report-build.js, and drop the
 * app_settings table.
 */
const { getSupabase } = require('../_lib/supabase');

async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = getSupabase();

  // Bearer auth — same pattern as other admin endpoints.
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(m[1]);
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' });

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('app_settings')
        .select('auto_review_enabled, updated_at')
        .eq('id', 1)
        .single();
      if (error) throw new Error(error.message);
      return res.status(200).json(data);
    }

    // PATCH
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    const patch = {};
    if (typeof body.auto_review_enabled === 'boolean') {
      patch.auto_review_enabled = body.auto_review_enabled;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update. Expected: auto_review_enabled (boolean).' });
    }
    patch.updated_at = new Date().toISOString();
    patch.updated_by = user.id;

    const { data, error } = await supabase
      .from('app_settings')
      .update(patch)
      .eq('id', 1)
      .select('auto_review_enabled, updated_at')
      .single();
    if (error) throw new Error(error.message);

    return res.status(200).json(data);
  } catch (err) {
    console.error('[settings] error:', err);
    return res.status(500).json({ error: err.message || 'Internal error.' });
  }
}

module.exports = handler;
