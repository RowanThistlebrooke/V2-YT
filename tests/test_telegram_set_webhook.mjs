import handler from '../api/telegram-set-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) {
  if (cond) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}
function mockRes() {
  const res = { _status: null, _body: null };
  res.status = status => { res._status = status; return res; };
  res.json = body => { res._body = body; return res; };
  return res;
}

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'setup-secret';

  {
    let called = false;
    global.fetch = async () => { called = true; throw new Error('should not call Telegram'); };
    const res = mockRes();
    await handler({ query: { secret: 'wrong' }, headers: { host: 'example.vercel.app' } }, res);
    assertEq(res._status, 401, 'an incorrect setup secret is rejected');
    assertEq(called, false, 'an incorrect setup secret never calls Telegram');
    assertEq(res._body, { error: 'unauthorized' }, 'the rejection does not echo secret setup instructions');
  }

  {
    const requests = [];
    global.fetch = async (url, opts) => {
      requests.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    const res = mockRes();
    await handler({
      query: { secret: 'setup-secret' },
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'fern.example.com' },
    }, res);
    assertEq(res._status, 200, 'successful setup returns 200');
    assertEq(requests.length, 2, 'setup registers both the webhook and command menu');
    assertTrue(requests[0].url.endsWith('/setWebhook'), 'the first Telegram call registers the webhook');
    assertEq(requests[0].body.url, 'https://fern.example.com/api/telegram-webhook', 'the webhook uses the live deployment host');
    assertTrue(requests[1].url.endsWith('/setMyCommands'), 'the second Telegram call registers bot commands');
    assertEq(requests[1].body.commands.map(item => item.command), ['today', 'recent', 'undo', 'status', 'help'], 'the Telegram menu contains every supported command');
    assertEq(res._body.commandsRegistered, true, 'the response confirms command registration');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
