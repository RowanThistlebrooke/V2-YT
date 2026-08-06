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
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';

  // ---- auth / validation ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: { publicToken: 'pt-1' }, query: { action: 'exchange-token' } }, res);
    assertEq(res._status, 401, 'missing auth is 401');

    const res2 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, body: {}, query: { action: 'exchange-token' } }, res2);
    assertEq(res2._status, 400, 'missing publicToken is a 400');
  }

  // ---- missing service role key ----
  {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, body: { publicToken: 'pt-1' }, query: { action: 'exchange-token' } }, res);
    assertEq(res._status, 500, 'missing SUPABASE_SERVICE_ROLE_KEY is a 500');
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-key';
  }

  // ---- happy path: exchanges the public token and stores the real access_token server-side only ----
  {
    let exchangeBody = null, writeUrl = null, writeBody = null, writeHeaders = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/item/public_token/exchange')) {
        exchangeBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ access_token: 'access-sandbox-xyz', item_id: 'item-1' }) };
      }
      if (u.includes('/rest/v1/plaid_items')) {
        writeUrl = u; writeBody = JSON.parse(opts.body); writeHeaders = opts.headers;
        return { ok: true, json: async () => ({}) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' },
      body: { publicToken: 'public-sandbox-abc', institutionName: 'Chase' },
      query: { action: 'exchange-token' },
    }, res);
    assertEq(res._status, 200, 'a valid exchange returns 200');
    assertEq(res._body, { ok: true, institutionName: 'Chase' }, 'the institution name is echoed back for display');
    assertEq(exchangeBody.public_token, 'public-sandbox-abc', 'the public token is sent to Plaid for exchange');
    assertTrue(writeUrl.includes('on_conflict=id'), 'the Supabase write upserts on id (single-row table), not a blind insert');
    assertEq(writeBody.access_token, 'access-sandbox-xyz', 'the real access_token from Plaid is what gets stored');
    assertEq(writeBody.institution_name, 'Chase', 'the institution name is stored alongside the token');
    assertEq(writeBody.cursor, null, 'a fresh connection resets the sync cursor to null');
    assertEq(writeHeaders.Authorization, 'Bearer fake-service-key', 'the write uses the SERVICE ROLE key, not the anon key');
  }

  // ---- Plaid exchange itself fails ----
  {
    global.fetch = async (url) => {
      if (String(url).includes('/item/public_token/exchange')) return { ok: false, json: async () => ({ error_message: 'invalid public_token' }) };
      throw new Error('unexpected fetch: ' + url);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-plaid-secret' }, body: { publicToken: 'bad-token' }, query: { action: 'exchange-token' } }, res);
    assertEq(res._status, 200, 'a Plaid exchange failure still responds 200');
    assertEq(res._body, { ok: false, error: 'invalid public_token' }, 'the Plaid error message is surfaced, and nothing gets written since we never reach the Supabase call');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
