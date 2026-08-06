import handler, { TOOL_EXECUTORS, activeDateKey, plainDateKey } from '../api/telegram-webhook.js';

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

// In-memory fake Supabase app_state table, keyed by row key, shared across
// a test's fetch stub so read-modify-write tool calls actually round-trip.
function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('api.anthropic.com')) throw new Error('unexpected anthropic call in this test');
    if (u.includes('open.er-api.com')) return { ok: true, json: async () => ({ rates: { USD: 1.1, EUR: 1.0, GBP: 0.9, DOP: 65 } }) };
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
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  // ---- log_purchase: no matching account -> logs with no link ----
  {
    const fake = makeFakeSupabase({ finance: { purchases: [] } });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.log_purchase({ name: 'Groceries', amount: 20, currency: 'USD' });
    assertEq(result.fromAccount, null, 'log_purchase with no from_account match: no account link');
    const p = fake.rows.finance.purchases[0];
    assertTrue(!!p && p.name === 'Groceries', 'log_purchase created a purchases entry');
    assertEq(p.entered_currency, 'USD', 'entered_currency stored correctly');
    assertEq(Math.round(p.amount * 100) / 100, Math.round((20 / 1.1) * 100) / 100, 'amount converted to CHF base using the fetched USD rate');
    assertEq(p.fromCat, null, 'fromCat null when no account matched');
  }

  // ---- log_purchase: matching account -> deducts + logs activity, preserves sibling nw:* keys ----
  {
    const fake = makeFakeSupabase({
      finance: { purchases: [], 'nw:bank': [{ name: 'Checking', amount: 1000 }], 'nw:cash': [{ name: 'Wallet', amount: 50 }], nw_currency: 'USD' },
    });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.log_purchase({ name: 'Rent', amount: 100, currency: 'USD', from_account: 'checking' });
    assertEq(result.fromAccount, 'Checking', 'log_purchase matches account name case-insensitively');
    const expectedDeducted = 1000 - 100 / 1.1;
    assertTrue(Math.abs(fake.rows.finance['nw:bank'][0].amount - expectedDeducted) < 0.001, 'matched account correctly deducted using the fetched USD rate');
    assertEq(fake.rows.finance['nw:cash'][0].amount, 50, 'sibling nw:cash account left untouched');
    assertEq(fake.rows.finance.nw_currency, 'USD', 'unrelated sibling key (nw_currency) preserved through the read-merge-write');
    assertTrue(fake.rows.finance['nw:activity'].length === 1 && Math.abs(fake.rows.finance['nw:activity'][0].delta - (-100 / 1.1)) < 0.001, 'activity log entry created with correct negative delta');
  }

  // ---- add_todo / mark_todo_done round-trip, preserving sibling goals:<key> data under 'goals' row ----
  {
    const key = 'goals:' + activeDateKey();
    const fake = makeFakeSupabase({ goals: { 'recur:defs': [{ id: 'r1', name: 'Gym' }], [key]: [{ text: 'Existing item', done: false }] } });
    global.fetch = fake.fetchStub;
    await TOOL_EXECUTORS.add_todo({ text: 'Call the dentist' });
    assertTrue(fake.rows.goals[key].some(g => g.text === 'Call the dentist' && g.done === false), 'add_todo appended a new undone item to today\'s list');
    assertTrue(fake.rows.goals[key].some(g => g.text === 'Existing item'), 'add_todo preserved the pre-existing item');
    assertTrue(Array.isArray(fake.rows.goals['recur:defs']) && fake.rows.goals['recur:defs'].length === 1, 'add_todo preserved the unrelated recur:defs sibling key');

    const doneResult = await TOOL_EXECUTORS.mark_todo_done({ text: 'dentist' });
    assertEq(doneResult.ok, true, 'mark_todo_done matches by partial text');
    const item = fake.rows.goals[key].find(g => g.text === 'Call the dentist');
    assertEq(item.done, true, 'mark_todo_done set done:true on the matched item');
    assertTrue(typeof item.doneAt === 'number', 'mark_todo_done stamped doneAt');

    const missResult = await TOOL_EXECUTORS.mark_todo_done({ text: 'nonexistent thing' });
    assertEq(missResult.ok, false, 'mark_todo_done reports failure (not a thrown error) when nothing matches');
  }

  // ---- add_todo: one-off future-dated reminders (e.g. "remind me to renew my passport in 3 months") ----
  {
    const todayKey = 'goals:' + activeDateKey();
    const fake = makeFakeSupabase({ goals: { [todayKey]: [] } });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.add_todo({ text: 'Renew passport', date: '2026-10-22', time: '09:00' });
    assertEq(r1.ok, true, 'add_todo accepts a future date');
    assertEq(r1.date, '2026-10-22', 'reports back the date it was added under');
    assertTrue(!fake.rows.goals[todayKey].some(g => g.text === 'Renew passport'), 'the future reminder was NOT added to today\'s list');
    const futureList = fake.rows.goals['goals:2026-10-22'];
    assertTrue(Array.isArray(futureList) && futureList.length === 1, 'a new goals:<date> key was created for the future date');
    assertEq(futureList[0], { text: 'Renew passport', done: false, time: '09:00' }, 'the future entry matches calendar.html\'s own addDayItem() shape exactly');

    // A second future reminder for the same date appends, doesn't overwrite.
    await TOOL_EXECUTORS.add_todo({ text: 'Pack for the trip', date: '2026-10-22' });
    assertEq(fake.rows.goals['goals:2026-10-22'].length, 2, 'a second reminder on the same future date appends rather than overwriting');
    assertTrue(!('time' in fake.rows.goals['goals:2026-10-22'][1]), 'no time field is added when none was given');

    const badDate = await TOOL_EXECUTORS.add_todo({ text: 'Bad date test', date: 'next tuesday' });
    assertEq(badDate.ok, false, 'an unparseable natural-language date string (not computed to YYYY-MM-DD by the caller) is rejected rather than silently misfiling the reminder');
    assertTrue(!fake.rows.goals[todayKey].some(g => g.text === 'Bad date test'), 'the rejected item was not added anywhere');
  }

  // ---- mark_todo_done falls back to recur:defs when a recurring item hasn't
  // been materialized into today's list yet (main.html hasn't been opened
  // today, so its client-side injectRecurringToday() hasn't run) ----
  {
    const key = 'goals:' + activeDateKey();
    const fake = makeFakeSupabase({
      goals: {
        'recur:defs': [
          { id: 'r1', name: 'Skin care (AM)', freq: 'daily', time: '08:00' },
          { id: 'r2', name: 'Take out trash', freq: 'days', days: [] }, // never scheduled
        ],
        [key]: [],
      },
    });
    global.fetch = fake.fetchStub;

    const result = await TOOL_EXECUTORS.mark_todo_done({ text: 'skin care' });
    assertEq(result.ok, true, 'mark_todo_done finds a not-yet-materialized recurring item by fuzzy name');
    assertEq(result.matched, 'Skin care (AM)', 'reports the actual recurring item name matched');
    const materialized = fake.rows.goals[key].find(g => g.text === 'Skin care (AM)');
    assertTrue(!!materialized, 'the recurring item was materialized into today\'s goals list');
    assertEq(materialized.done, true, 'the materialized item is marked done');
    assertEq(materialized.time, '08:00', 'the recurring item\'s time carries over when materialized');

    // Calling it again shouldn't create a second duplicate entry.
    const result2 = await TOOL_EXECUTORS.mark_todo_done({ text: 'skin care' });
    assertEq(result2.ok, true, 'marking an already-done recurring item again still succeeds');
    const skinCareEntries = fake.rows.goals[key].filter(g => g.text === 'Skin care (AM)');
    assertEq(skinCareEntries.length, 1, 'no duplicate entry created on a second call');

    // A recur item scheduled for no days at all should NOT be found/materialized.
    const notScheduled = await TOOL_EXECUTORS.mark_todo_done({ text: 'trash' });
    assertEq(notScheduled.ok, false, 'a recurring item not scheduled for today is not matched or materialized');
    assertTrue(!fake.rows.goals[key].some(g => g.text === 'Take out trash'), 'unscheduled recurring item was not added to today\'s list');
  }

  // ---- log_water: increments today's count, preserves substance list and profile ----
  {
    const fake = makeFakeSupabase({ health: { po_water_v1: { unit: 'bottle', bottleMl: 500, profile: { weightKg: 80 }, logs: { '2020-01-01': 3 } } } });
    global.fetch = fake.fetchStub;
    const r1 = await TOOL_EXECUTORS.log_water({});
    assertEq(r1.todayCount, 1, 'log_water defaults to +1 when no count given');
    const r2 = await TOOL_EXECUTORS.log_water({ count: 2 });
    assertEq(r2.todayCount, 3, 'log_water accumulates across calls');
    assertEq(fake.rows.health.po_water_v1.profile.weightKg, 80, 'log_water preserved the profile sub-object');
    assertEq(fake.rows.health.po_water_v1.logs['2020-01-01'], 3, 'log_water preserved unrelated historical log entries');
  }

  // ---- mark_supplement_taken: matches by name, stores a timestamp keyed by item id under the 6am-boundary key ----
  {
    const fake = makeFakeSupabase({ health: { 'stack:items': [{ id: 'custom_1', name: 'Creatine' }, { id: 'm1', name: 'Caffeine' }] } });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.mark_supplement_taken({ name: 'creatine' });
    assertEq(result.matched, 'Creatine', 'mark_supplement_taken matches case-insensitively');
    const takenKey = 'stack:taken:' + activeDateKey();
    assertTrue(typeof fake.rows.health[takenKey].custom_1 === 'number', 'mark_supplement_taken stores a numeric timestamp keyed by item id');
    assertTrue(!('m1' in fake.rows.health[takenKey]), 'mark_supplement_taken does not mark unrelated items as taken');
  }

  // ---- mark_gym_done: writes an ISO timestamp (not a bare boolean) under the plain date key, own po-coach row ----
  {
    const fake = makeFakeSupabase({ 'po-coach': { po_coach_workout_done: {}, po_coach_weights: { squat: 100 } } });
    global.fetch = fake.fetchStub;
    await TOOL_EXECUTORS.mark_gym_done();
    const key = plainDateKey();
    assertTrue(typeof fake.rows['po-coach'].po_coach_workout_done[key] === 'string' && fake.rows['po-coach'].po_coach_workout_done[key].includes('T'), 'mark_gym_done stores an ISO timestamp string, matching gym.html\'s own format');
    assertEq(fake.rows['po-coach'].po_coach_weights.squat, 100, 'mark_gym_done preserved the unrelated po_coach_weights sibling key');
  }

  // ---- webhook handler: security gating ----
  {
    process.env.TELEGRAM_BOT_TOKEN = 'bot123:ABC';
    process.env.TELEGRAM_WEBHOOK_SECRET = 'shh-secret';
    process.env.TELEGRAM_CHAT_ID = '555';
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    global.fetch = async () => { throw new Error('should not be called'); };

    let res = mockRes();
    await handler({ method: 'POST', headers: {}, body: { message: { chat: { id: 555 }, text: 'hi' } } }, res);
    assertEq(res._status, 401, 'wrong/missing X-Telegram-Bot-Api-Secret-Token header is rejected with 401');

    res = mockRes();
    let sentTo = null;
    global.fetch = async (url, opts) => {
      if (String(url).includes('sendMessage')) { sentTo = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch: ' + url);
    };
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'shh-secret' }, body: { message: { chat: { id: 999 }, text: 'hi' } } }, res);
    assertEq(sentTo, null, 'a message from an unauthorized chat id is silently ignored (no reply sent)');
    assertEq(res._status, 200, 'unauthorized chat id still gets a 200 (no Telegram retry storm)');
  }

  // ---- webhook handler: first-contact chat_id discovery when TELEGRAM_CHAT_ID unset ----
  {
    delete process.env.TELEGRAM_CHAT_ID;
    let sentTo = null;
    global.fetch = async (url, opts) => {
      if (String(url).includes('sendMessage')) { sentTo = JSON.parse(opts.body); return { ok: true, json: async () => ({ ok: true }) }; }
      throw new Error('unexpected fetch (should not reach Claude/Supabase during discovery): ' + url);
    };
    const res = mockRes();
    await handler({ method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'shh-secret' }, body: { message: { chat: { id: 12345 }, text: 'hello' } } }, res);
    assertTrue(!!sentTo && sentTo.text.includes('12345'), 'first-contact reply includes the chat id for setup, with no Claude/Supabase call made');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
