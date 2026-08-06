// ============================================================
// Consolidated WHOOP endpoint — combines what used to be three separate
// files (whoop-callback.js, whoop-refresh.js, whoop-data.js) into one, so
// they count as a SINGLE Vercel Serverless Function instead of three.
// Vercel's Hobby plan caps a deployment at 12 functions; this repo's api/
// directory was over that cap and every deploy was failing outright with
// exceeded_serverless_functions_per_deployment (see vercel.json rewrites,
// which keep the original /api/whoop-callback, /api/whoop-refresh, and
// /api/whoop-data URLs working unchanged for every existing caller and
// for the redirect_uri already registered in the WHOOP developer dashboard).
//
// The three actions are told apart by request shape, not by a query
// param, specifically so the rewrite for /api/whoop-callback and
// /api/whoop-data can point here with NO destination query string —
// that avoids any dependence on whether Vercel merges a rewrite
// destination's own query string with the incoming one:
//   - GET with ?code= or ?error=  -> OAuth callback (WHOOP's own redirect)
//   - GET with anything else      -> data proxy (?path=... from the app)
//   - POST                        -> token refresh
//
// Env vars required on Vercel:
//   WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET   from the WHOOP developer dashboard
// ============================================================

async function handleCallback(req, res) {
  const code = req.query && req.query.code;
  const errorParam = req.query && req.query.error;
  if (errorParam) return res.status(400).send('WHOOP auth error: ' + errorParam);
  if (!code) return res.status(400).send('Missing code parameter.');

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  // ALWAYS derive the redirect from the live host. WHOOP sends the browser
  // back to whatever redirect_uri was used at login (i.e. this exact origin),
  // so deriving it here guarantees the token-exchange redirect_uri matches
  // the authorize redirect_uri — regardless of any env var.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const redirectUri = proto + '://' + host + '/api/whoop-callback';
  if (!clientId || !clientSecret) {
    return res.status(500).send('Server not configured (missing WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET).');
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      return res.status(500).send('WHOOP token exchange failed: ' + text);
    }
    let json;
    try { json = JSON.parse(text); } catch (e) {
      return res.status(500).send('WHOOP returned non-JSON: ' + text);
    }
    const access = json.access_token || '';
    const refresh = json.refresh_token || '';
    const expiresIn = json.expires_in || 3600;
    const hash = new URLSearchParams({
      whoop_access: access,
      whoop_refresh: refresh,
      whoop_expires: String(Date.now() + expiresIn * 1000),
    }).toString();
    res.writeHead(302, { Location: '/health.html#' + hash });
    res.end();
  } catch (e) {
    res.status(500).send('Unexpected error: ' + (e && e.message ? e.message : String(e)));
  }
}

async function handleRefresh(req, res) {
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured' });

  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'offline',
    });
    const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) return res.status(500).json({ error: 'refresh failed: ' + text });
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON response from WHOOP' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
  }
}

async function handleData(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  const path = (req.query && req.query.path) || '';
  if (!path || !path.startsWith('/')) return res.status(400).json({ error: 'path required (must start with /)' });

  // Forward all query params except `path` itself
  const fwd = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k !== 'path') fwd.set(k, String(v));
  }
  const qs = fwd.toString();
  // WHOOP moved most endpoints to v2; cycle is still on v1.
  const base = path.startsWith('/cycle')
    ? 'https://api.prod.whoop.com/developer/v1'
    : 'https://api.prod.whoop.com/developer/v2';
  const url = base + path + (qs ? '?' + qs : '');

  try {
    const r = await fetch(url, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' },
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return res.status(204).end();
  }
  if (req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    const hasCode = req.query && (req.query.code || req.query.error);
    return hasCode ? handleCallback(req, res) : handleData(req, res);
  }
  if (req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    return handleRefresh(req, res);
  }
  return res.status(405).json({ error: 'method not allowed' });
}
