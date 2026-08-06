import handler from '../api/plaid.js';

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
  process.env.PLAID_SYNC_SECRET = 'shh-plaid-secret';
  process.env.PLAID_CLIENT_ID = 'client123';
  process.env.PLAID_SECRET = 'plaid-secret-abc';

  // ---- method/auth guards ----
  {
    const res = mockRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    assertEq(res._status, 204, 'OPTIONS returns 204');
    const res2 = mockRes();
    await handler({ method: 'GET', headers: {} }, res2);
    assertEq(res2._status, 405, 'GET is rejected with 405');
    const res3 = mockRes();
    await handler({ method: 'POST', headers: {}, query: { action: 'link-token' } }, res3);
    assertEq(res3._status, 401, 'missing Authorization header is 401');
    const res4 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong' }, query: { action: 'link-token' } }, res4);
    assertEq(res4._status, 401, 'wrong bearer secret is 401');
  }

  // ---- missing server config ----
  {
    delete process.env.PLAID_CLIENT_ID;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'link-token' } }, res);
    assertEq(res._status, 500, 'missing PLAID_CLIENT_ID is a 500');
    process.env.PLAID_CLIENT_ID = 'client123';
  }

  // ---- happy path: defaults to sandbox, requests a link_token ----
  {
    delete process.env.PLAID_ENV;
    let seenUrl = null, seenBody = null;
    global.fetch = async (url, opts) => {
      seenUrl = String(url);
      seenBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ link_token: 'link-sandbox-token-1', expiration: '2026-01-01T00:00:00Z' }) };
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'link-token' } }, res);
    assertEq(res._status, 200, 'a valid request returns 200');
    assertEq(res._body, { ok: true, linkToken: 'link-sandbox-token-1' }, 'the link token is returned under linkToken');
    assertTrue(seenUrl.includes('sandbox.plaid.com'), 'defaults to the Plaid SANDBOX host when PLAID_ENV is unset: ' + seenUrl);
    assertEq(seenBody.client_id, 'client123', 'the request carries the configured client_id');
    assertEq(seenBody.products, ['transactions'], 'the transactions product is requested');
  }

  // ---- PLAID_ENV=production routes to the production host ----
  {
    process.env.PLAID_ENV = 'production';
    let seenUrl = null;
    global.fetch = async (url) => { seenUrl = String(url); return { ok: true, json: async () => ({ link_token: 'lt' }) }; };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'link-token' } }, res);
    assertTrue(seenUrl.includes('production.plaid.com'), 'PLAID_ENV=production routes to the production Plaid host: ' + seenUrl);
    delete process.env.PLAID_ENV;
  }

  // ---- Plaid itself returns an error ----
  {
    global.fetch = async () => ({ ok: false, json: async () => ({ error_message: 'invalid client_id' }) });
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, query: { action: 'link-token' } }, res);
    assertEq(res._status, 200, 'a Plaid-side error still responds 200 (not a hard failure)');
    assertEq(res._body, { ok: false, error: 'invalid client_id' }, 'the Plaid error message is surfaced');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
