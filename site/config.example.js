/*
 * Toolkit Manager site config — template.
 *
 * Setup:
 *   1. Copy this file to `site/config.local.js`  (which is gitignored)
 *   2. Fill in your Supabase project URL and anon (publishable) key
 *      from Supabase Studio → Project Settings → API Keys
 *   3. Reload the page
 *
 * The `config.local.js` file MUST NOT be committed. It is in .gitignore.
 *
 * Honest note on threat model: the anon key still reaches the browser at
 * runtime, so anyone using the page can read it from DevTools. Splitting it
 * into this file keeps it out of git history; it is NOT the same as the
 * key being secret. For real secrecy you need a backend proxy.
 */
window.APP_CONFIG = {
  SUPABASE_URL:  "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON: "your-anon-publishable-key-here",
};
