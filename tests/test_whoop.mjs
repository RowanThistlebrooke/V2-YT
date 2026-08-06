import handler from '../api/whoop.js';

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
  const origEnv = { ...process.env };
  process.env.WHOOP_CLIENT_ID = 'whoop-client-1';
  process.env.WHOOP_CLIENT_SECRET = 'whoop-secret-1';

  // ---- OPTIONS preflight ----
  {
    const res = mockRes();
    await handler({ method: 'OPTIONS', headers: {}, query: {} }, res);
    assertEq(res._status, 204, 'OPTIONS returns 204');
  }

  // ---- OAuth callback: told apart from the data proxy by ?code/?error ----
  {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: { error: 'access_denied' } }, res);
    assertEq(res._status, 400, 'a ?error= param on the callback is surfaced as a 400');

    global.fetch = async () => ({
      ok: true,
      text: async () => JSON.stringify({ access_token: 'wtok', refresh_token: 'wrefresh', expires_in: 3600 }),
    });
    let redirected = null;
    const res2 = mockRes();
    res2.writeHead = (status, headers) => { redirected = { status, headers }; };
    await handler({ method: 'GET', headers: { host: 'example.com' }, query: { code: 'auth-code-1' } }, res2);
    assertEq(redirected.status, 302, 'a successful callback redirects (302) back to health.html');
    assertTrue(redirected.headers.Location.startsWith('/health.html#'), 'redirects to /health.html with tokens in the hash: ' + redirected.headers.Location);
    assertTrue(redirected.headers.Location.includes('whoop_access=wtok'), 'the access token is carried in the redirect hash');
  }

  // ---- data proxy: a GET with no code/error and a ?path= falls through here ----
  {
    const res = mockRes();
    await handler({ method: 'GET', headers: {}, query: { path: '/recovery' } }, res);
    assertEq(res._status, 401, 'missing bearer token on the data proxy is 401');

    const res2 = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer user-tok' }, query: {} }, res2);
    assertEq(res2._status, 400, 'missing ?path= is a 400');

    let seenUrl = null, seenAuth = null;
    global.fetch = async (url, opts) => {
      seenUrl = String(url);
      seenAuth = opts.headers.Authorization;
      return { status: 200, text: async () => '{"recovery_score":80}' };
    };
    const res3 = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer user-tok' }, query: { path: '/recovery', limit: '1' } }, res3);
    assertTrue(seenUrl.includes('/developer/v2/recovery'), 'proxies to the v2 WHOOP API for a non-cycle path: ' + seenUrl);
    assertTrue(seenUrl.includes('limit=1'), 'forwards extra query params (besides path) to WHOOP');
    assertEq(seenAuth, 'Bearer user-tok', "forwards the caller's own bearer token to WHOOP, not a server secret");

    global.fetch = async (url) => { seenUrl = String(url); return { status: 200, text: async () => '{}' }; };
    const res4 = mockRes();
    await handler({ method: 'GET', headers: { authorization: 'Bearer user-tok' }, query: { path: '/cycle' } }, res4);
    assertTrue(seenUrl.includes('/developer/v1/cycle'), 'cycle stays on the v1 WHOOP API: ' + seenUrl);
  }

  // ---- token refresh (POST) ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: {}, query: {} }, res);
    assertEq(res._status, 400, 'missing refresh_token in body is a 400');

    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ access_token: 'new-access', expires_in: 3600 }) });
    const res2 = mockRes();
    await handler({ method: 'POST', headers: {}, body: { refresh_token: 'old-refresh' }, query: {} }, res2);
    assertEq(res2._status, 200, 'a valid refresh returns 200');
    assertEq(res2._body.access_token, 'new-access', 'the refreshed access token is returned');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
