import handler, { callClaude } from '../api/telegram-webhook.js';

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

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  // ---- callClaude: a tool_use turn followed by a final text turn ----
  {
    let call = 0;
    const seenRequests = [];
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [{ data: {} }] };
      if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1 } }) };
      if (u.includes('api.anthropic.com')) {
        call++;
        seenRequests.push(JSON.parse(opts.body));
        if (call === 1) {
          return {
            ok: true,
            json: async () => ({
              stop_reason: 'tool_use',
              usage: { input_tokens: 500, output_tokens: 50 },
              content: [
                { type: 'text', text: 'Sure, logging that now.' },
                { type: 'tool_use', id: 'tu_1', name: 'log_purchase', input: { name: 'Coffee', amount: 5, currency: 'USD' } },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 600, output_tokens: 20 }, content: [{ type: 'text', text: 'Done — logged $5 coffee.' }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };

    const result = await callClaude('sk-test', { finance: {} }, 'log a $5 coffee');
    assertEq(result.text, 'Done — logged $5 coffee.', 'callClaude returns the final text after a tool_use round-trip');
    assertEq(call, 2, 'exactly two Anthropic calls: one that requested the tool, one with the tool result');
    assertEq(result.usage, { inputTokens: 1100, outputTokens: 70, cacheWriteTokens: 0, cacheReadTokens: 0 }, 'usage is summed across BOTH Anthropic calls in the round-trip, not just the final one');
    const secondReq = seenRequests[1];
    const toolResultMsg = secondReq.messages[secondReq.messages.length - 1];
    assertEq(toolResultMsg.role, 'user', 'the tool result is sent back as a user-role message per the Messages API tool-use protocol');
    const toolResultBlock = toolResultMsg.content[0];
    assertEq(toolResultBlock.type, 'tool_result', 'tool result block has the correct type');
    assertEq(toolResultBlock.tool_use_id, 'tu_1', 'tool result references the correct tool_use_id');
    const parsedResult = JSON.parse(toolResultBlock.content);
    assertEq(parsedResult.ok, true, 'the actual log_purchase tool ran for real and reported success back to Claude');
  }

  // ---- callClaude: a tool that throws is reported back as a failed tool_result, not an uncaught crash ----
  {
    let call = 0;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) throw new Error('supabase is down');
      if (u.includes('api.anthropic.com')) {
        call++;
        if (call === 1) {
          return { ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_2', name: 'mark_gym_done', input: {} }] }) };
        }
        const body = JSON.parse(opts.body);
        const toolResultBlock = body.messages[body.messages.length - 1].content[0];
        const parsed = JSON.parse(toolResultBlock.content);
        assertEq(parsed.ok, false, 'a thrown error inside a tool executor is caught and surfaced as {ok:false, reason} rather than crashing the loop');
        assertTrue(parsed.reason.includes('supabase is down'), 'the failure reason includes the underlying error message');
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: "Couldn't reach the database, sorry." }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const result = await callClaude('sk-test', {}, 'mark gym done');
    assertEq(result.text, "Couldn't reach the database, sorry.", 'callClaude still returns a coherent final reply after a tool failure');
  }

  // ---- callClaude: prior conversation history is included ahead of the new user turn ----
  {
    let seenReq = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('api.anthropic.com')) {
        seenReq = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Got it.' }] }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const priorHistory = [
      { role: 'user', content: 'my dog\'s name is Rex' },
      { role: 'assistant', content: 'Got it, I\'ll remember Rex.' },
    ];
    await callClaude('sk-test', {}, 'what\'s my dog\'s name?', priorHistory);
    assertEq(seenReq.messages.length, 3, 'prior history (2 turns) plus the new user turn = 3 messages sent');
    assertEq(seenReq.messages[0], priorHistory[0], 'first prior turn passed through unchanged');
    assertEq(seenReq.messages[1], priorHistory[1], 'second prior turn passed through unchanged');
    assertEq(seenReq.messages[2], { role: 'user', content: 'what\'s my dog\'s name?' }, 'the new message is appended after prior history');

    // No history passed at all (e.g. first-ever message, or a fresh conversation) still works.
    const result = await callClaude('sk-test', {}, 'hello');
    assertEq(seenReq.messages.length, 1, 'with no prior history, only the new message is sent');
    assertEq(result.text, 'Got it.', 'callClaude still returns the reply text normally');
  }

  // ---- full handler end-to-end: real Telegram message -> tool call -> reply sent to Telegram ----
  {
    process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
    process.env.TELEGRAM_CHAT_ID = '555';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    const rows = { goals: {} };
    let anthropicCalls = 0;
    let sentText = null;
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
      if (u.includes('api.anthropic.com')) {
        anthropicCalls++;
        if (anthropicCalls === 1) {
          return { ok: true, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_3', name: 'add_todo', input: { text: 'Buy milk' } }] }) };
        }
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Added "Buy milk" to your list.' }] }) };
      }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'shh-secret' }, body: { message: { chat: { id: 555 }, text: 'add buy milk to my list' } } }, res);
    assertEq(res._status, 200, 'full end-to-end handler returns 200');
    assertEq(sentText, 'Added "Buy milk" to your list.', 'the reply actually sent to Telegram matches Claude\'s final text');
    const todosKey = Object.keys(rows.goals).find(k => k.startsWith('goals:'));
    assertTrue(!!todosKey && rows.goals[todosKey].some(g => g.text === 'Buy milk'), 'the to-do was genuinely written to the (fake) Supabase row, not just claimed in the reply text');

    // Conversation memory: this exchange should now be persisted...
    const mem = rows['telegram-memory'] && rows['telegram-memory'].history;
    assertTrue(Array.isArray(mem) && mem.length === 2, 'the exchange was persisted to the telegram-memory row (user turn + assistant turn)');
    assertEq(mem[0], { role: 'user', content: 'add buy milk to my list' }, 'persisted history stores the raw user text, not the tool-use scaffolding');
    assertEq(mem[1], { role: 'assistant', content: 'Added "Buy milk" to your list.' }, 'persisted history stores the final assistant reply text');

    // ...and a SECOND message should have that history available to it.
    let secondReqMessages = null;
    anthropicCalls = 0;
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
      if (u.includes('api.anthropic.com')) {
        anthropicCalls++;
        secondReqMessages = JSON.parse(opts.body).messages;
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Milk it is.' }] }) };
      }
      if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res2 = mockRes();
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'shh-secret' }, body: { message: { chat: { id: 555 }, text: 'what did I just ask you to add?' } } }, res2);
    assertEq(secondReqMessages.length, 3, 'the second message\'s request includes the prior exchange (2 messages) plus the new one');
    assertEq(secondReqMessages[0].content, 'add buy milk to my list', 'the earlier user message is genuinely remembered, not a wiped slate');
    assertEq(rows['telegram-memory'].history.length, 4, 'memory now holds both exchanges (4 messages total)');
  }

  // ---- conversation memory is capped, keeping only the most recent turns ----
  {
    process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
    process.env.TELEGRAM_CHAT_ID = '555';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    // Seed 24 messages (12 exchanges) of prior history, more than the cap.
    const longHistory = [];
    for (let i = 0; i < 12; i++) {
      longHistory.push({ role: 'user', content: 'old message ' + i });
      longHistory.push({ role: 'assistant', content: 'old reply ' + i });
    }
    const rows = { goals: {}, 'telegram-memory': { history: longHistory } };
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
      if (u.includes('api.anthropic.com')) {
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'newest reply' }] }) };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'shh-secret' }, body: { message: { chat: { id: 555 }, text: 'newest message' } } }, res);
    const stored = rows['telegram-memory'].history;
    assertEq(stored.length, 20, 'history is capped at 20 messages rather than growing unbounded');
    assertEq(stored[stored.length - 1], { role: 'assistant', content: 'newest reply' }, 'the newest exchange is kept');
    assertEq(stored[0].content, 'old message 3', 'the oldest entries are the ones dropped, keeping the most recent turns');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
