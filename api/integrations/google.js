// ============================================================
// GET  /api/integrations/google?path=/calendars/primary/events&timeMin=...   (Authorization: Bearer <access_token>)
//      Proxies to https://www.googleapis.com/calendar/v3<path> — needed
//      because Google's Calendar API doesn't send CORS headers for
//      browser-direct requests in this flow.
// POST /api/integrations/google   { refresh_token }
//      Exchanges a refresh_token for a new access_token via Google's
//      OAuth endpoint (access tokens expire after ~1 hour).
// POST /api/integrations/google   { store_token: true, email, refresh_token }
//      Stores the refresh token server-side in Supabase (key: google_tokens_secure).
//      Refresh tokens are never in client sync payloads — only the server holds them.
// POST /api/integrations/google   { refresh_by_email: true, email }
//      Looks up the stored refresh token for this email from Supabase, performs
//      token refresh, returns { access_token, expires_in }. Lets Device B get a
//      fresh access token without ever having done OAuth itself.
//
// Combined into one file (data-proxy + token-refresh both for Google
// Calendar) to match the WHOOP/Strava integration pattern.
//
// Gated by APP_SECRET (see api/_lib/security.js) if configured — without
// it, GET is an open relay to the Calendar API for anyone with their own
// bearer token, and POST is a free token-refresh service using OUR
// client secret.
// ============================================================
import { requireAppSecret } from '../_lib/security.js';

// Proxy a request (any method) to the Google Calendar / OAuth2 API.
// Called for GET requests and for POST/PATCH requests that have a `path`
// query param (e.g. creating a calendar event). Token-refresh POSTs
// (no `path` param) are handled separately in handleRefresh().
async function handleData(req, res, method) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  const path = (req.query && req.query.path) || '';
  if (!path || !path.startsWith('/')) return res.status(400).json({ error: 'path required (must start with /)' });

  const fwd = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k !== 'path') fwd.set(k, String(v));
  }
  const qs = fwd.toString();
  // Route by path prefix:
  //   /userinfo                              → OAuth2 userinfo endpoint
  //   /users/{id}/(messages|threads|labels|drafts|profile|history|settings|watch)
  //                                          → Gmail API (gmail.googleapis.com/gmail/v1)
  //   everything else (incl. /users/me/calendarList) → Google Calendar API
  const isGmailPath = /^\/users\/[^/]+\/(messages|threads|labels|drafts|profile|history|settings|watch)/.test(path);
  const baseUrl = path === '/userinfo'
    ? 'https://www.googleapis.com/oauth2/v3'
    : isGmailPath
      ? 'https://gmail.googleapis.com/gmail/v1'
      : 'https://www.googleapis.com/calendar/v3';
  const url = baseUrl + path + (qs ? '?' + qs : '');

  const fetchOpts = {
    method: method || req.method,
    headers: { 'Authorization': auth, 'Accept': 'application/json' },
  };
  if (method !== 'GET' && req.body) {
    const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    fetchOpts.body = bodyStr;
    fetchOpts.headers['Content-Type'] = 'application/json';
  }

  try {
    const r = await fetch(url, fetchOpts);
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

async function doOAuthRefresh(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('server not configured');
  const form = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: clientId, client_secret: clientSecret,
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form,
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Google OAuth error ' + r.status + ': ' + text);
  return JSON.parse(text);
}

async function getSupaTokens(supaUrl, serviceKey) {
  const hdrs = { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey };
  const r = await fetch(supaUrl + '/rest/v1/app_state?key=eq.google_tokens_secure&select=data', { headers: hdrs });
  if (!r.ok) return {};
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) ? rows[0].data : {};
}

async function setSupaTokens(supaUrl, serviceKey, data) {
  const hdrs = {
    'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey,
    'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates',
  };
  await fetch(supaUrl + '/rest/v1/app_state', {
    method: 'POST', headers: hdrs, body: JSON.stringify({ key: 'google_tokens_secure', data }),
  });
}

async function handleRefresh(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  // Store token server-side (called by calendar.html after OAuth)
  if (body && body.store_token) {
    const { email, refresh_token: rt, scope } = body;
    if (!email || !rt) return res.status(400).json({ error: 'email and refresh_token required' });
    const supaUrl = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !sk) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const existing = await getSupaTokens(supaUrl, sk);
      await setSupaTokens(supaUrl, sk, Object.assign({}, existing, { [email]: { rt, scope: scope || '' } }));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'store failed: ' + (e && e.message ? e.message : String(e)) });
    }
  }

  // List connected accounts: emails + scopes only, never tokens
  if (body && body.list_accounts) {
    const supaUrl = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !sk) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const store = await getSupaTokens(supaUrl, sk);
      const accounts = Object.keys(store).map((email) => ({
        email, scope: (store[email] && typeof store[email] === 'object') ? (store[email].scope || '') : '',
      }));
      return res.status(200).json({ accounts });
    } catch (e) {
      return res.status(500).json({ error: 'list failed: ' + (e && e.message ? e.message : String(e)) });
    }
  }

  // Refresh by email (cross-device: looks up server-stored refresh token)
  if (body && body.refresh_by_email) {
    const { email } = body;
    if (!email) return res.status(400).json({ error: 'email required' });
    const supaUrl = process.env.SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supaUrl || !sk) return res.status(503).json({ error: 'Supabase not configured' });
    try {
      const store = await getSupaTokens(supaUrl, sk);
      const entry = store[email];
      const rt = entry && typeof entry === 'object' ? entry.rt : entry;
      if (!rt) return res.status(404).json({ error: 'no stored token for ' + email + ' — reconnect in Calendar' });
      const data = await doOAuthRefresh(rt);
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e && e.message ? e.message : String(e) });
    }
  }

  // Standard refresh with explicit refresh_token
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });
  try {
    const data = await doOAuthRefresh(refresh);
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-App-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireAppSecret(req, res)) return;

  if (req.method === 'GET') return handleData(req, res, 'GET');
  // POST with a `path` param = forwarded event write (create/update).
  // POST without `path` = token refresh.
  if (req.method === 'POST' && req.query && req.query.path) return handleData(req, res, 'POST');
  if (req.method === 'POST') return handleRefresh(req, res);
  if (req.method === 'PATCH' && req.query && req.query.path) return handleData(req, res, 'PATCH');
  if (req.method === 'DELETE' && req.query && req.query.path) return handleData(req, res, 'DELETE');
  return res.status(405).json({ error: 'method not allowed' });
}
