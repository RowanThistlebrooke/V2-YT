// ============================================================
// GET  /api/integrations/google?path=/calendars/primary/events&timeMin=...   (Authorization: Bearer <access_token>)
//      Proxies to https://www.googleapis.com/calendar/v3<path> — needed
//      because Google's Calendar API doesn't send CORS headers for
//      browser-direct requests in this flow.
// POST /api/integrations/google   { refresh_token }
//      Exchanges a refresh_token for a new access_token via Google's
//      OAuth endpoint (access tokens expire after ~1 hour).
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

async function handleRefresh(req, res) {
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
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
    if (!r.ok) return res.status(500).json({ error: 'refresh failed: ' + text });
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON response from Google' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
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
