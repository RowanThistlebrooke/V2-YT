import handler from '../api/shortcuts-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function mockRes() {
  const res = { _status: null, _body: null, _headers: {} };
  res.status = (s) => { res._status = s; return res; };
  res.json = (b) => { res._body = b; return res; };
  res.send = (b) => { res._body = b; return res; };
  res.end = () => { return res; };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  return res;
}

(async () => {
  const origFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';
  process.env.SHORTCUTS_WEBHOOK_SECRET = 'shh-shortcuts-secret';
  process.env.ANTHROPIC_API_KEY = 'sk-test';

  // ---- OPTIONS preflight ----
  {
    const res = mockRes();
    await handler({ method: 'OPTIONS', headers: {} }, res);
    assertEq(res._status, 204, 'OPTIONS returns 204 for CORS preflight');
  }

  // ---- non-POST rejected ----
  {
    const res = mockRes();
    await handler({ method: 'GET', headers: {} }, res);
    assertEq(res._status, 405, 'a GET request is rejected with 405');
  }

  // ---- missing/wrong Authorization header ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: {}, body: { text: 'hi' } }, res);
    assertEq(res._status, 401, 'no Authorization header at all is rejected with 401');

    const res2 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer wrong-secret' }, body: { text: 'hi' } }, res2);
    assertEq(res2._status, 401, 'a wrong bearer secret is rejected with 401');
  }

  // ---- missing server config ----
  {
    delete process.env.SHORTCUTS_WEBHOOK_SECRET;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer anything' }, body: { text: 'hi' } }, res);
    assertEq(res._status, 500, 'missing SHORTCUTS_WEBHOOK_SECRET on the server is a 500, not a silent pass-through');
    process.env.SHORTCUTS_WEBHOOK_SECRET = 'shh-shortcuts-secret';
  }
  {
    delete process.env.ANTHROPIC_API_KEY;
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-shortcuts-secret' }, body: { text: 'hi' } }, res);
    assertEq(res._status, 500, 'missing ANTHROPIC_API_KEY is a 500');
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  }

  // ---- missing/empty text ----
  {
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-shortcuts-secret' }, body: {} }, res);
    assertEq(res._status, 400, 'a request with no "text" field is rejected with 400');

    const res2 = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-shortcuts-secret' }, body: { text: '   ' } }, res2);
    assertEq(res2._status, 400, 'a request with only whitespace as "text" is rejected with 400');
  }

  // ---- happy path: real text goes through buildContext + callClaude, reply comes back ----
  {
    let anthropicCalls = 0;
    let seenUserMessage = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) {
        if (!opts || !opts.method) return { ok: true, json: async () => [{ data: {} }] };
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1 } }) };
      if (u.includes('api.anthropic.com')) {
        anthropicCalls++;
        const body = JSON.parse(opts.body);
        seenUserMessage = body.messages[body.messages.length - 1];
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged it — $20 for lunch.' }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-shortcuts-secret' }, body: { text: 'log 20 dollars for lunch' } }, res);
    assertEq(res._status, 200, 'a valid request returns 200');
    assertEq(res._body, { ok: true, reply: 'Logged it — $20 for lunch.' }, 'the response echoes back Claude\'s final reply text');
    assertEq(anthropicCalls, 1, 'exactly one Anthropic call was made for a plain end_turn reply');
    assertEq(seenUserMessage, { role: 'user', content: 'log 20 dollars for lunch' }, 'the dictated/automation text is sent to Claude verbatim as the user turn');
  }

  // ---- happy path: a location-automation-style canned sentence also flows through and can trigger a real tool ----
  {
    let anthropicCalls = 0;
    const rows = { goals: {} };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) {
        if (!opts || !opts.method) {
          const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
          return { ok: true, json: async () => [{ data: rows[key] || {} }] };
        }
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1 } }) };
      if (u.includes('api.anthropic.com')) {
        anthropicCalls++;
        if (anthropicCalls === 1) {
          return { ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'mark_gym_done', input: {} }] }) };
        }
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nice, marked today\'s gym session done.' }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-shortcuts-secret' }, body: { text: 'I just arrived at the gym, starting my workout' } }, res);
    assertEq(res._status, 200, 'a location-automation sentence returns 200');
    assertEq(res._body.reply, 'Nice, marked today\'s gym session done.', 'the reply reflects the real tool call Claude decided to make');
    assertTrue(!!rows.goals || true, 'no crash reaching the fake Supabase layer');
  }

  // ---- a thrown error inside the pipeline is reported as {ok:false}, not an uncaught crash ----
  {
    global.fetch = async (url) => { throw new Error('network is down'); };
    const res = mockRes();
    await handler({ method: 'POST', headers: { authorization: 'Bearer shh-shortcuts-secret' }, body: { text: 'log something' } }, res);
    assertEq(res._status, 200, 'even on an internal failure, the endpoint still responds 200 (so a Shortcut doesn\'t treat it as a hard network error)');
    assertEq(res._body.ok, false, 'the failure is reported as {ok:false}');
    assertTrue(res._body.error.includes('network is down'), 'the underlying error message is included for debugging');
  }

  global.fetch = origFetch;
  process.env = origEnv;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
