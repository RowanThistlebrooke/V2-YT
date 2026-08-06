// ============================================================
// Consolidated Google endpoint — combines what used to be three separate
// files (google-callback.js, google-refresh.js, google-token-sync.js)
// into one, so they count as a SINGLE Vercel Serverless Function instead
// of three. Vercel's Hobby plan caps a deployment at 12 functions; this
// repo's api/ directory was over that cap and every deploy was failing
// outright with exceeded_serverless_functions_per_deployment (see
// vercel.json rewrites, which keep the original /api/google-callback,
// /api/google-refresh, and /api/google-token-sync URLs working unchanged
// for every existing caller and for the redirect_uri already registered
// in the Google Cloud OAuth client).
//
// The callback is told apart from the two POST actions by request shape
// (GET with ?code=/?error=), so its rewrite can point here with NO
// destination query string — that avoids any dependence on whether
// Vercel merges a rewrite destination's own query string with the
// incoming one, which matters here because Google's redirect carries a
// real ?code=&state= that must not be lost. The two POST actions
// (refresh / token-sync) never receive an incoming query string from
// their callers, so their rewrites safely add ?action=... in the
// destination to tell them apart.
//
// Env vars required on Vercel:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   from the Google Cloud OAuth client
//   SUPABASE_URL                             same one already used everywhere
//   SUPABASE_SERVICE_ROLE_KEY                for token-sync only — see below
//   GOOGLE_SYNC_SECRET                       for token-sync only — see below
// ============================================================

async function handleCallback(req, res) {
  const code = req.query && req.query.code;
  const errorParam = req.query && req.query.error;
  if (errorParam) return res.status(400).send('Google auth error: ' + errorParam);
  if (!code) return res.status(400).send('Missing code parameter.');

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  // ALWAYS derive the redirect from the live host, same reasoning as
  // whoop's callback — Google sends the browser back to whatever
  // redirect_uri was used at login (this exact origin), so deriving it
  // here guarantees a match regardless of any env var.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = proto + '://' + host + '/api/google-callback';
  if (!clientId || !clientSecret) {
    return res.status(500).send('Server not configured (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      return res.status(500).send('Google token exchange failed: ' + text);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return res.status(500).send('Google returned non-JSON: ' + text);
    }
    const access = json.access_token || '';
    const refresh = json.refresh_token || '';
    const expiresIn = json.expires_in || 3600;
    const hash = new URLSearchParams({
      google_access: access,
      google_refresh: refresh,
      google_expires: String(Date.now() + expiresIn * 1000),
    }).toString();
    res.writeHead(302, { Location: '/google.html#' + hash });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected error: ' + (e && e.message ? e.message : String(e)));
  }
}

async function handleRefresh(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured' });

  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) {
      // A refresh_token going bad (expired after 7 days in OAuth
      // "Testing" mode, or revoked) surfaces here as invalid_grant —
      // the client treats this as "needs to reconnect".
      return res.status(401).json({ error: 'refresh failed: ' + text });
    }
    try { return res.status(200).json(JSON.parse(text)); }
    catch (e) { return res.status(500).json({ error: 'non-JSON response from Google' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
  }
}

// Write-only: google.html calls this every time it saves a fresh Google
// OAuth token (initial connect or a refresh), so the Telegram assistant
// (api/telegram-webhook.js — runs server-side, no browser involved) has a
// copy to work with.
//
// Tokens are stored in a DEDICATED Supabase table (google_tokens) with Row
// Level Security enabled and NO policies granted to the public anon key —
// only the service_role key (used here only, never shipped to the browser)
// can read or write it. This is deliberately separate from the app_state
// table everything else syncs through: that table's anon key is public
// (embedded in the site's JS), which is an acceptable trade-off for to-do
// text or workout logs but not for a live Google credential that can read
// actual Gmail/Calendar/Drive content.
//
// One-time setup (run once in the Supabase SQL editor):
//   create table if not exists google_tokens (
//     id int primary key default 1,
//     access text, refresh text, expires bigint,
//     updated_at timestamptz default now()
//   );
//   alter table google_tokens enable row level security;
//   -- No policies added on purpose — this blocks the anon key entirely;
//   -- only the service_role key (which bypasses RLS) can touch this table.
async function handleTokenSync(req, res) {
  const secret = process.env.GOOGLE_SYNC_SECRET;
  if (!secret) return res.status(500).json({ error: 'GOOGLE_SYNC_SECRET not configured' });
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + secret) return res.status(401).json({ error: 'unauthorized' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured' });

  const { access, refresh, expires } = req.body || {};
  if (!access) return res.status(400).json({ error: 'missing access token' });

  const r = await fetch(supabaseUrl + '/rest/v1/google_tokens?on_conflict=id', {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ id: 1, access, refresh: refresh || '', expires: expires || null, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) return res.status(500).json({ error: 'write failed: ' + r.status + ' ' + (await r.text()) });
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return res.status(204).end();
  }
  if (req.method === 'GET') {
    return handleCallback(req, res);
  }
  if (req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    const action = req.query && req.query.action;
    if (action === 'token-sync') return handleTokenSync(req, res);
    if (action === 'refresh') return handleRefresh(req, res);
    return res.status(400).json({ error: 'unknown action' });
  }
  return res.status(405).json({ error: 'method not allowed' });
}
