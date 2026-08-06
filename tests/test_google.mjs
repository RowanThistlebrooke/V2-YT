import handler from '../api/google.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  res.send = (b) => { res._body = b; return res; };
  res.end = () => { return res; };
  res.setHeader = () => {};
  return res;
}

(async () => {
  const origFetch = global.fetch;
  process.env.GOOGLE_SYNC_SECRET = 'sync-secret-123';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key-xyz';

  // ---- method dispatch ----
  // Since api/google.js also serves the OAuth callback, any GET (this
  // consolidated file's rewrites route ALL google-* paths here — see
  // vercel.json) is treated as a callback attempt rather than a 405; the
  // action query param only matters for POST. Missing ?code/?error just
  // surfaces as a 400, which is what a genuine callback with a bad/absent
  // code would also produce.
  {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: { action: 'token-sync' } }, res);
    assertEq(res._status, 400, 'GET with no code/error falls through to the callback handler and 400s on the missing code');
  }

  // ---- missing/wrong secret rejected ----
  {
    let res = mockRes();
    await handler({ method: 'POST', headers: {}, body: {}, query: { action: 'token-sync' } }, res);
    assertEq(res._status, 401, 'missing Authorization header is rejected with 401');

    res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong-secret' }, body: { access: 'tok' }, query: { action: 'token-sync' } }, res);
    assertEq(res._status, 401, 'wrong secret is rejected with 401');
  }

  // ---- missing access token rejected ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer sync-secret-123' }, body: {}, query: { action: 'token-sync' } }, res);
    assertEq(res._status, 400, 'missing access token in body is rejected with 400');
  }

  // ---- successful write uses the SERVICE ROLE key, never the public anon key ----
  {
    let captured = null;
    global.fetch = async (url, opts) => { captured = { url: String(url), opts }; return { ok: true, json: async () => ({}) }; };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer sync-secret-123' }, body: { access: 'access-tok', refresh: 'refresh-tok', expires: 12345 }, query: { action: 'token-sync' } }, res);
    assertEq(res._status, 200, 'valid write returns 200');
    assertTrue(captured.url.includes('/rest/v1/google_tokens'), 'writes to the dedicated google_tokens table, not app_state');
    assertEq(captured.opts.headers.apikey, 'service-role-key-xyz', 'uses SUPABASE_SERVICE_ROLE_KEY as the apikey header — NOT the public anon key');
    assertEq(captured.opts.headers.Authorization, 'Bearer service-role-key-xyz', 'uses SUPABASE_SERVICE_ROLE_KEY as the bearer token too');
    const sentBody = JSON.parse(captured.opts.body);
    assertEq(sentBody.id, 1, 'always writes to the single fixed row id=1 (single-user table)');
    assertEq(sentBody.access, 'access-tok', 'access token forwarded correctly');
    assertEq(sentBody.refresh, 'refresh-tok', 'refresh token forwarded correctly');
    assertEq(sentBody.expires, 12345, 'expires forwarded correctly');
  }

  // ---- Supabase write failure surfaces a clear error, not a silent 200 ----
  {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'db error' });
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer sync-secret-123' }, body: { access: 'a' }, query: { action: 'token-sync' } }, res);
    assertEq(res._status, 500, 'a failed Supabase write surfaces as a 500, not a false success');
  }

  // ---- OAuth callback (GET) ----
  {
    process.env.GOOGLE_CLIENT_ID = 'client-id-1';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret-1';

    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: { error: 'access_denied' } }, res);
    assertEq(res._status, 400, 'a ?error= param on the callback is surfaced as a 400');

    global.fetch = async (url, opts) => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: 'gtok', refresh_token: 'grefresh', expires_in: 3600 }),
    });
    let redirected = null;
    const res2 = mockRes();
    res2.writeHead = (status, headers) => { redirected = { status, headers }; };
    await handler({ method: 'GET', headers: { host: 'example.com' }, query: { code: 'auth-code-1' } }, res2);
    assertEq(redirected.status, 302, 'a successful callback redirects (302) back to google.html');
    assertTrue(redirected.headers.Location.startsWith('/google.html#'), 'redirects to /google.html with tokens in the hash, not a query string: ' + redirected.headers.Location);
    assertTrue(redirected.headers.Location.includes('google_access=gtok'), 'the access token is carried in the redirect hash');
  }

  // ---- token refresh (POST, no action query needed but harmless if present) ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: {}, query: { action: 'refresh' } }, res);
    assertEq(res._status, 400, 'missing refresh_token in body is a 400');

    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ access_token: 'new-access', expires_in: 3600 }) });
    const res2 = mockRes();
    await handler({ method: 'POST', headers: {}, body: { refresh_token: 'old-refresh' }, query: { action: 'refresh' } }, res2);
    assertEq(res2._status, 200, 'a valid refresh returns 200');
    assertEq(res2._body.access_token, 'new-access', 'the refreshed access token is returned');

    global.fetch = async () => ({ ok: false, text: async () => 'invalid_grant' });
    const res3 = mockRes();
    await handler({ method: 'POST', headers: {}, body: { refresh_token: 'stale-refresh' }, query: { action: 'refresh' } }, res3);
    assertEq(res3._status, 401, 'a rejected refresh_token (expired/revoked) surfaces as 401, telling the client to reconnect');
  }

  // ---- unknown POST action ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: {}, query: {} }, res);
    assertEq(res._status, 400, 'a POST with no recognized action is rejected with 400');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
