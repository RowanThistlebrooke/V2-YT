import { buildGoogleContext, buildContext } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function clearGoogleEnv() {
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'].forEach(k => delete process.env[k]);
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-key';

  // ---- Google not configured at all (no client id/secret) -> silently omitted, no fetch calls ----
  {
    clearGoogleEnv();
    global.fetch = async (url) => { throw new Error('should not fetch anything: ' + url); };
    const result = await buildGoogleContext();
    assertEq(result, null, 'buildGoogleContext returns null with no crash when GOOGLE_CLIENT_ID/SECRET are unset');
  }

  // ---- configured, but no tokens row exists yet (never connected) -> null, no crash ----
  {
    clearGoogleEnv();
    process.env.GOOGLE_CLIENT_ID = 'cid';
    process.env.GOOGLE_CLIENT_SECRET = 'csecret';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    global.fetch = async (url) => {
      if (String(url).includes('google_tokens')) return { ok: true, json: async () => [] };
      throw new Error('should not reach Google APIs with no tokens: ' + url);
    };
    const result = await buildGoogleContext();
    assertEq(result, null, 'no google_tokens row yet -> returns null, never calls Google APIs');
  }

  // ---- valid, non-expired tokens -> fetches calendar/gmail/drive and returns the summarized shape ----
  {
    let requestedUrls = [];
    global.fetch = async (url, opts) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('google_tokens') && (!opts || !opts.method)) {
        return { ok: true, json: async () => [{ access: 'valid-access', refresh: 'r1', expires: Date.now() + 3600e3 }] };
      }
      if (u.includes('calendar/v3')) {
        return { ok: true, json: async () => ({ items: [{ summary: 'Dentist', start: { dateTime: new Date().toISOString() } }] }) };
      }
      if (u.includes('labels/UNREAD')) return { ok: true, json: async () => ({ messagesUnread: 2 }) };
      if (u.includes('messages?q=is:unread')) return { ok: true, json: async () => ({ messages: [{ id: 'm1' }, { id: 'm2' }] }) };
      if (u.includes('messages/m1')) return { ok: true, json: async () => ({ payload: { headers: [{ name: 'Subject', value: 'Hi' }, { name: 'From', value: 'Bob <b@x.com>' }] } }) };
      if (u.includes('messages/m2')) return { ok: true, json: async () => ({ payload: { headers: [{ name: 'Subject', value: 'Yo' }, { name: 'From', value: 'Sue <s@x.com>' }] } }) };
      if (u.includes('drive/v3')) return { ok: true, json: async () => ({ files: [{ name: 'Resume.pdf', modifiedTime: '2026-01-01T00:00:00Z' }] }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await buildGoogleContext();
    assertTrue(!!result, 'valid tokens produce a non-null google context');
    assertEq(result.calendarEventsToday[0].title, 'Dentist', 'calendar event title comes through');
    assertEq(result.gmailUnreadCount, 2, 'gmail unread count comes through');
    assertTrue(result.gmailRecentSubjects.some(m => m.subject === 'Hi' && m.from === 'Bob'), 'gmail recent subject/sender parsed and From header stripped of <email>');
    assertEq(result.driveRecentFiles[0].name, 'Resume.pdf', 'drive recent file name comes through');
    assertTrue(!requestedUrls.some(u => u.includes('SUPABASE_ANON_KEY') || false), 'sanity: no accidental anon key leakage in URLs');

    // buildContext() should fold this in as context.google
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [{ data: {} }] };
      if (u.includes('google_tokens') && (!opts || !opts.method)) return { ok: true, json: async () => [{ access: 'valid-access', refresh: 'r1', expires: Date.now() + 3600e3 }] };
      if (u.includes('calendar/v3') || u.includes('labels/UNREAD') || u.includes('drive/v3')) return { ok: true, json: async () => ({ items: [], messagesUnread: 0, files: [] }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const full = await buildContext();
    assertTrue('google' in full, 'buildContext() includes a "google" key when tokens are present and valid');
  }

  // ---- expired access token WITH a refresh token -> refreshes via Google, writes the new tokens back, still returns data ----
  {
    let wroteBack = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('google_tokens') && (!opts || !opts.method)) {
        return { ok: true, json: async () => [{ access: 'stale-access', refresh: 'r1', expires: Date.now() - 1000 }] };
      }
      if (u.includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'fresh-access', expires_in: 3600 }) };
      }
      if (u.includes('google_tokens') && opts && opts.method === 'POST') {
        wroteBack = JSON.parse(opts.body);
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('calendar/v3') || u.includes('labels/UNREAD') || u.includes('drive/v3')) return { ok: true, json: async () => ({ items: [], messagesUnread: 0, files: [] }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await buildGoogleContext();
    assertTrue(!!result, 'expired-but-refreshable tokens still produce a valid context');
    assertTrue(!!wroteBack, 'the refreshed access token gets written back to the google_tokens table');
    assertEq(wroteBack.access, 'fresh-access', 'the NEW access token is what gets written back');
    assertEq(wroteBack.refresh, 'r1', 'the original refresh token is preserved (Google does not reissue one on a plain refresh)');
  }

  // ---- expired access token with NO refresh token -> gracefully returns null, no crash ----
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('google_tokens') && (!opts || !opts.method)) {
        return { ok: true, json: async () => [{ access: 'stale-access', refresh: '', expires: Date.now() - 1000 }] };
      }
      throw new Error('should not call Google refresh or APIs with no refresh token: ' + u);
    };
    const result = await buildGoogleContext();
    assertEq(result, null, 'expired token with no refresh token available returns null instead of throwing');
  }

  // ---- one Google API (say, Drive) failing degrades to empty data for just that piece, not a total failure ----
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('google_tokens') && (!opts || !opts.method)) return { ok: true, json: async () => [{ access: 'a', refresh: 'r', expires: Date.now() + 3600e3 }] };
      if (u.includes('calendar/v3')) return { ok: true, json: async () => ({ items: [{ summary: 'Standup', start: { dateTime: new Date().toISOString() } }] }) };
      if (u.includes('labels/UNREAD')) return { ok: true, json: async () => ({ messagesUnread: 0 }) };
      if (u.includes('drive/v3')) throw new Error('Drive is down');
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await buildGoogleContext();
    assertTrue(!!result, 'a single failing Google API (Drive) does not take down the whole context');
    assertEq(result.calendarEventsToday[0].title, 'Standup', 'calendar data still comes through when only Drive failed');
    assertEq(result.driveRecentFiles, [], 'the failing piece (Drive) degrades to an empty list rather than throwing');
  }

  // ---- a refresh-token exchange failure (e.g. revoked/invalid) is caught, returns null instead of crashing ----
  {
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('google_tokens') && (!opts || !opts.method)) return { ok: true, json: async () => [{ access: 'stale', refresh: 'revoked-refresh', expires: Date.now() - 1000 }] };
      if (u.includes('oauth2.googleapis.com/token')) return { ok: true, json: async () => ({ error: 'invalid_grant' }) };
      throw new Error('should not reach any Google data API when the refresh itself failed: ' + u);
    };
    const result = await buildGoogleContext();
    assertEq(result, null, 'a failed token refresh (e.g. revoked access) is caught and returns null, not an uncaught throw');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
