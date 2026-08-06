import handler, { activeDateKey } from '../api/telegram-webhook.js';

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
  return res;
}

function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const m = u.match(/key=eq\.([^&]+)/);
        const key = decodeURIComponent(m[1]);
        return { ok: true, json: async () => [{ data: rows[key] || {} }] };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        rows[body.key] = body.data;
        return { ok: true, json: async () => ({}) };
      }
    }
    throw new Error('unexpected fetch: ' + u);
  }
  return { rows, fetchStub };
}

function buildCalls() {
  const calls = { sendMessage: [], answerCallbackQuery: [], editMessageReplyMarkup: [], editMessageText: [] };
  const record = (name) => async (url, opts) => {
    calls[name].push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  return { calls, record };
}

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';
  process.env.TELEGRAM_CHAT_ID = '555';

  const headers = { 'x-telegram-bot-api-secret-token': 'shh-secret' };

  // ==================== a "Done" tap on a matching item ====================
  {
    const key = 'goals:' + activeDateKey();
    const fake = makeFakeSupabase({ goals: { [key]: [{ text: 'Gym', done: false }] } });
    const { calls, record } = buildCalls();
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('sendMessage')) return record('sendMessage')(url, opts);
      if (u.includes('answerCallbackQuery')) return record('answerCallbackQuery')(url, opts);
      if (u.includes('editMessageReplyMarkup')) return record('editMessageReplyMarkup')(url, opts);
      if (u.includes('editMessageText')) return record('editMessageText')(url, opts);
      return fake.fetchStub(url, opts);
    };

    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { callback_query: { id: 'cb1', data: 'done:Gym', message: { chat: { id: 555 }, message_id: 42, text: 'Gym — the weights aren\'t lifting themselves' } } },
    }, res);

    assertEq(res._status, 200, 'callback handler returns 200');
    assertTrue(fake.rows.goals[key].find(g => g.text === 'Gym').done, 'tapping Done actually marks the matching goals entry done');
    assertEq(calls.answerCallbackQuery.length, 1, 'answerCallbackQuery is called exactly once (clears the tap spinner)');
    assertEq(calls.answerCallbackQuery[0].callback_query_id, 'cb1', 'the correct callback_query_id is answered');
    assertTrue(calls.answerCallbackQuery[0].text.includes('Marked done'), 'the toast confirms the action succeeded');
    assertEq(calls.editMessageReplyMarkup.length, 1, 'the inline keyboard is stripped from the original message on success');
    assertEq(calls.editMessageReplyMarkup[0].reply_markup, { inline_keyboard: [] }, 'the keyboard is cleared (empty array), not left in place');
    assertEq(calls.editMessageText.length, 1, 'the original message text is edited to reflect completion');
    assertTrue(calls.editMessageText[0].text.includes('✅ Marked done'), 'the edited text includes a done confirmation');
    assertTrue(calls.editMessageText[0].text.startsWith('Gym — the weights'), 'the edited text preserves the original message content');
    assertEq(calls.sendMessage.length, 0, 'no separate chat message is sent — feedback is via the toast + edited message only');
  }

  // ==================== a "Done" tap on a fuzzy-matched not-yet-materialized recurring item ====================
  {
    const key = 'goals:' + activeDateKey();
    const fake = makeFakeSupabase({ goals: { 'recur:defs': [{ id: 'r1', name: 'Skin care (AM)', freq: 'daily' }], [key]: [] } });
    const { calls, record } = buildCalls();
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('answerCallbackQuery')) return record('answerCallbackQuery')(url, opts);
      if (u.includes('editMessageReplyMarkup')) return record('editMessageReplyMarkup')(url, opts);
      if (u.includes('editMessageText')) return record('editMessageText')(url, opts);
      return fake.fetchStub(url, opts);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { callback_query: { id: 'cb2', data: 'done:Skin care', message: { chat: { id: 555 }, message_id: 43, text: 'Still haven\'t done skin care' } } },
    }, res);
    assertTrue(fake.rows.goals[key].some(g => g.text === 'Skin care (AM)' && g.done), 'a truncated/fuzzy callback_data name still matches and materializes the real recurring item');
  }

  // ==================== a "Done" tap that finds no match ====================
  {
    const key = 'goals:' + activeDateKey();
    const fake = makeFakeSupabase({ goals: { [key]: [] } });
    const { calls, record } = buildCalls();
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('sendMessage')) return record('sendMessage')(url, opts);
      if (u.includes('answerCallbackQuery')) return record('answerCallbackQuery')(url, opts);
      if (u.includes('editMessageReplyMarkup')) return record('editMessageReplyMarkup')(url, opts);
      if (u.includes('editMessageText')) return record('editMessageText')(url, opts);
      return fake.fetchStub(url, opts);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { callback_query: { id: 'cb3', data: 'done:Nonexistent Thing', message: { chat: { id: 555 }, message_id: 44, text: 'Nonexistent Thing — still undone' } } },
    }, res);
    assertEq(res._status, 200, 'a no-match callback still returns 200 (not an error response)');
    assertEq(calls.answerCallbackQuery.length, 1, 'the tap is still answered even when nothing matched');
    assertTrue(!calls.answerCallbackQuery[0].text.includes('Marked done'), 'the toast does not falsely claim success');
    assertEq(calls.editMessageReplyMarkup.length, 0, 'the keyboard is left in place (not cleared) when the action failed, so it can be retried');
    assertEq(calls.editMessageText.length, 0, 'the message text is left untouched when the action failed');
  }

  // ==================== unknown callback_data prefix ====================
  {
    const { calls, record } = buildCalls();
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('answerCallbackQuery')) return record('answerCallbackQuery')(url, opts);
      throw new Error('unexpected fetch for unknown callback data: ' + u);
    };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { callback_query: { id: 'cb4', data: 'snooze:Gym', message: { chat: { id: 555 }, message_id: 45, text: 'Gym' } } },
    }, res);
    assertEq(res._status, 200, 'an unrecognized callback_data prefix still returns 200');
    assertEq(calls.answerCallbackQuery.length, 1, 'an unrecognized callback is still answered, clearing the spinner');
    assertTrue(res._body.ignored === 'unknown callback data', 'the response reports it was ignored as unrecognized');
  }

  // ==================== unauthorized chat id ====================
  {
    let anyCall = false;
    global.fetch = async () => { anyCall = true; throw new Error('should not be called for an unauthorized chat'); };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { callback_query: { id: 'cb5', data: 'done:Gym', message: { chat: { id: 999 }, message_id: 46, text: 'Gym' } } },
    }, res);
    assertEq(res._status, 200, 'an unauthorized chat id on a callback still gets a 200 (no Telegram retry storm)');
    assertTrue(!anyCall, 'no Telegram or Supabase call is made at all for an unauthorized chat id');
  }

  // ==================== setup not complete (TELEGRAM_CHAT_ID unset) ====================
  {
    delete process.env.TELEGRAM_CHAT_ID;
    let anyCall = false;
    global.fetch = async () => { anyCall = true; throw new Error('should not be called before setup is complete'); };
    const res = mockRes();
    await handler({
      method: 'POST', headers,
      body: { callback_query: { id: 'cb6', data: 'done:Gym', message: { chat: { id: 12345 }, message_id: 47, text: 'Gym' } } },
    }, res);
    assertEq(res._status, 200, 'a callback before setup is complete still gets a 200');
    assertTrue(!anyCall, 'no calls are made for a callback query before TELEGRAM_CHAT_ID is configured');
    process.env.TELEGRAM_CHAT_ID = '555';
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
