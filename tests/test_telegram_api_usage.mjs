import handler, { buildContext, plainDateKey } from '../api/telegram-webhook.js';

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
    if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1 } }) };
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

(async () => {
  const origFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';
  delete process.env.ANTHROPIC_INPUT_PRICE_PER_MTOK;
  delete process.env.ANTHROPIC_OUTPUT_PRICE_PER_MTOK;

  const headers = { 'x-telegram-bot-api-secret-token': 'shh-secret' };

  // ==================== no usage recorded yet -> buildContext omits apiUsage entirely ====================
  {
    const fake = makeFakeSupabase({ goals: {} });
    global.fetch = fake.fetchStub;
    const context = await buildContext();
    assertTrue(!('apiUsage' in context), 'buildContext does not include an apiUsage key before any usage has ever been recorded');
  }

  // ==================== a real exchange persists usage, buildContext then reports it ====================
  {
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
      if (u.includes('api.anthropic.com')) {
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 2_000_000, output_tokens: 100_000 }, content: [{ type: 'text', text: 'Hey there.' }] }) };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };

    const res = mockRes();
    await handler({ method: 'POST', headers, body: { message: { chat: { id: 555 }, text: 'hi' } } }, res);
    assertEq(res._status, 200, 'the exchange itself still succeeds normally');

    const usageRow = rows['telegram-usage'];
    assertTrue(!!usageRow, 'a telegram-usage row is written after a real Claude exchange');
    assertEq(usageRow.totalCalls, 1, 'total call count is 1 after the first exchange');
    assertEq(usageRow.totalInputTokens, 2_000_000, 'total input tokens recorded correctly');
    assertEq(usageRow.totalOutputTokens, 100_000, 'total output tokens recorded correctly');
    const today = plainDateKey();
    assertTrue(!!usageRow.byDate[today], 'today\'s date bucket exists');
    assertEq(usageRow.byDate[today].calls, 1, 'today\'s bucket has 1 call');
    assertEq(usageRow.byDate[today].inputTokens, 2_000_000, 'today\'s bucket has the correct input tokens');

    // buildContext should now surface a summarized apiUsage.
    const context = await buildContext();
    assertTrue('apiUsage' in context, 'buildContext now includes apiUsage after a real exchange was recorded');
    // Default pricing: $3/MTok input, $15/MTok output -> 2M in * $3 + 0.1M out * $15 = $6 + $1.5 = $7.50
    assertEq(context.apiUsage.today.estimatedCostUSD, 7.5, 'today\'s estimated cost matches the default per-token pricing');
    assertEq(context.apiUsage.today.calls, 1, 'today\'s call count comes through in the summary');
    assertEq(context.apiUsage.allTime.calls, 1, 'all-time call count matches after just one exchange');
    assertEq(context.apiUsage.allTime.estimatedCostUSD, 7.5, 'all-time cost matches today\'s cost after just one exchange');
    assertEq(context.apiUsage.last30Days.calls, 1, 'last-30-days call count includes today\'s exchange');
  }

  // ==================== a second exchange accumulates on top of the first, doesn't overwrite ====================
  {
    const rows = { goals: {}, 'telegram-usage': { byDate: { [plainDateKey()]: { inputTokens: 2_000_000, outputTokens: 100_000, calls: 1 } }, totalInputTokens: 2_000_000, totalOutputTokens: 100_000, totalCalls: 1 } };
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
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 500_000, output_tokens: 25_000 }, content: [{ type: 'text', text: 'Second reply.' }] }) };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { message: { chat: { id: 555 }, text: 'another question' } } }, res);
    assertEq(res._status, 200, 'the second exchange succeeds');
    const usageRow = rows['telegram-usage'];
    assertEq(usageRow.totalCalls, 2, 'total call count accumulates rather than resetting');
    assertEq(usageRow.totalInputTokens, 2_500_000, 'total input tokens accumulate across exchanges');
    assertEq(usageRow.byDate[plainDateKey()].calls, 2, 'the same-day bucket accumulates rather than being overwritten');
  }

  // ==================== old day buckets are pruned so this doesn't grow forever ====================
  {
    const oldDate = '2020-01-01'; // far more than 90 days ago relative to any real test run date
    const rows = { goals: {}, 'telegram-usage': { byDate: { [oldDate]: { inputTokens: 1000, outputTokens: 100, calls: 1 } }, totalInputTokens: 1000, totalOutputTokens: 100, totalCalls: 1 } };
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
        return { ok: true, json: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: 'Reply.' }] }) };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { message: { chat: { id: 555 }, text: 'hi again' } } }, res);
    assertEq(res._status, 200, 'the exchange succeeds');
    const usageRow = rows['telegram-usage'];
    assertTrue(!(oldDate in usageRow.byDate), 'a day bucket far outside the retention window is pruned on the next write');
    assertTrue(plainDateKey() in usageRow.byDate, 'today\'s bucket is still present after pruning');
    // totals are cumulative and NOT reduced by pruning the daily breakdown — pruning only affects the per-day detail.
    assertEq(usageRow.totalCalls, 2, 'the running total is unaffected by pruning old daily detail');
  }

  // ==================== a failed Anthropic call never reaches recordApiUsage (no usage to record) ====================
  {
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
      if (u.includes('api.anthropic.com')) return { ok: false, status: 500, text: async () => 'server error' };
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { message: { chat: { id: 555 }, text: 'hi' } } }, res);
    assertTrue(!('telegram-usage' in rows), 'no usage row is written when the Anthropic call itself failed');
  }

  // ==================== custom pricing env vars are honored ====================
  {
    process.env.ANTHROPIC_INPUT_PRICE_PER_MTOK = '1';
    process.env.ANTHROPIC_OUTPUT_PRICE_PER_MTOK = '5';
    const rows = { goals: {}, 'telegram-usage': { byDate: { [plainDateKey()]: { inputTokens: 1_000_000, outputTokens: 1_000_000, calls: 1 } }, totalInputTokens: 1_000_000, totalOutputTokens: 1_000_000, totalCalls: 1 } };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('/rest/v1/app_state')) {
        if (!opts || !opts.method) {
          const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
          return { ok: true, json: async () => [{ data: rows[key] || {} }] };
        }
      }
      throw new Error('unexpected fetch: ' + u);
    };
    const context = await buildContext();
    // 1M input * $1/MTok + 1M output * $5/MTok = $1 + $5 = $6
    assertEq(context.apiUsage.today.estimatedCostUSD, 6, 'custom ANTHROPIC_INPUT_PRICE_PER_MTOK/ANTHROPIC_OUTPUT_PRICE_PER_MTOK env vars change the cost estimate');
    delete process.env.ANTHROPIC_INPUT_PRICE_PER_MTOK;
    delete process.env.ANTHROPIC_OUTPUT_PRICE_PER_MTOK;
  }

  // ==================== prompt-cache tokens are tracked and priced separately from plain input tokens ====================
  {
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
      if (u.includes('api.anthropic.com')) {
        const sentBody = JSON.parse(opts.body);
        assertTrue(Array.isArray(sentBody.system), 'the system prompt is sent as blocks, not one concatenated string');
        assertTrue(sentBody.system[0].cache_control && sentBody.system[0].cache_control.type === 'ephemeral', 'the static SYS block carries a cache_control marker');
        assertTrue(!sentBody.system[1].cache_control, 'the dynamic dashboard-data block is NOT marked for caching (it changes every call)');
        assertTrue(sentBody.tools[sentBody.tools.length - 1].cache_control && sentBody.tools[sentBody.tools.length - 1].cache_control.type === 'ephemeral', 'the tools schema carries a cache_control marker on its last entry');
        assertEq(sentBody.model, 'claude-haiku-4-5-20251001', 'the Telegram assistant calls the cheaper Haiku model, not Sonnet');
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'end_turn',
            usage: { input_tokens: 50, output_tokens: 100, cache_creation_input_tokens: 8_600, cache_read_input_tokens: 0 },
            content: [{ type: 'text', text: 'Hey there.' }],
          }),
        };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { message: { chat: { id: 555 }, text: 'first message, cold cache' } } }, res);
    assertEq(res._status, 200, 'the exchange succeeds');
    const usageRow = rows['telegram-usage'];
    assertEq(usageRow.totalCacheWriteTokens, 8_600, 'cache-write tokens (a cold cache) are recorded separately from plain input tokens');
    assertEq(usageRow.totalCacheReadTokens, 0, 'no cache-read tokens yet on a cold cache');
    const context = await buildContext();
    // 50 in * $3/MTok + 100 out * $15/MTok + 8600 cache-write * ($3 * 1.25)/MTok
    // = 0.00015 + 0.0015 + 0.03225 = 0.0339 -> rounds to 0.03
    assertEq(context.apiUsage.today.estimatedCostUSD, 0.03, 'a cache WRITE is costed at a premium over plain input tokens, not ignored or treated as free');
  }

  // ==================== a warm cache read is billed at a steep discount, not the full input rate ====================
  {
    const rows = { goals: {}, 'telegram-usage': { byDate: {}, totalInputTokens: 0, totalOutputTokens: 0, totalCacheWriteTokens: 0, totalCacheReadTokens: 0, totalCalls: 0 } };
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
        return {
          ok: true,
          json: async () => ({
            stop_reason: 'end_turn',
            usage: { input_tokens: 50, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 8_600 },
            content: [{ type: 'text', text: 'Hey again.' }],
          }),
        };
      }
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers, body: { message: { chat: { id: 555 }, text: 'second message, warm cache' } } }, res);
    assertEq(res._status, 200, 'the exchange succeeds');
    const context = await buildContext();
    // 50 in * $3/MTok + 100 out * $15/MTok + 8600 cache-read * ($3 * 0.1)/MTok
    // = 0.00015 + 0.0015 + 0.00258 = 0.00423 -> rounds to 0.0
    assertEq(context.apiUsage.today.estimatedCostUSD, 0, 'a cache READ is billed at a steep discount, so a warm-cache exchange costs a fraction of a cold one');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
