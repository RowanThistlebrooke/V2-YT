import { TOOL_EXECUTORS, plainDateKey } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

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

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  const todayKey = plainDateKey();

  // ==================== log_food_entry ====================
  {
    const fake = makeFakeSupabase({ health: { 'cal:entries': [] } });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.log_food_entry({ name: 'Chicken burrito bowl', calories: 650, protein: 45, carbs: 60, fat: 20 });
    assertEq(r1.ok, true, 'log_food_entry returns ok');
    const entries = fake.rows.health['cal:entries'];
    assertEq(entries.length, 1, 'one entry created');
    assertEq(entries[0].calories, 650, 'calories stored');
    assertEq(entries[0].protein, 45, 'protein stored');
    assertEq(entries[0].carbs, 60, 'carbs stored');
    assertEq(entries[0].fat, 20, 'fat stored');
    assertEq(entries[0].dateKey, todayKey, 'entry dated using the plain calendar date convention, matching health.html\'s calDateKey()');
    assertEq(entries[0].photo, null, 'no photo on a chat-logged entry');
    assertEq(entries[0].items, [{ name: 'Chicken burrito bowl', calories: 650, protein: 45, carbs: 60, fat: 20 }], 'items array matches health.html\'s manual-entry shape exactly');
    assertTrue(typeof entries[0].ts === 'number', 'entry has a numeric ts');

    // Macros default to 0 when omitted, calories still required.
    const r2 = await TOOL_EXECUTORS.log_food_entry({ name: 'Black coffee', calories: 5 });
    assertEq(r2.ok, true, 'log_food_entry works with just a name + calories');
    const secondEntry = fake.rows.health['cal:entries'][1];
    assertEq(secondEntry.protein, 0, 'protein defaults to 0 when omitted');
    assertEq(secondEntry.carbs, 0, 'carbs defaults to 0 when omitted');
    assertEq(secondEntry.fat, 0, 'fat defaults to 0 when omitted');

    // Logging twice must append, never overwrite (multiple meals/day).
    assertEq(fake.rows.health['cal:entries'].length, 2, 'a second food entry appends rather than overwriting the first');
  }

  // ==================== log_caffeine ====================
  {
    const fake = makeFakeSupabase({ caffeine: { 'caf:logs': [] } });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.log_caffeine({ name: 'Red Bull (8.4 oz)', mg: 80 });
    assertEq(r1.ok, true, 'log_caffeine returns ok');
    let logs = fake.rows.caffeine['caf:logs'];
    assertEq(logs.length, 1, 'one caffeine log entry created');
    assertEq(logs[0].n, 'Red Bull (8.4 oz)', 'name stored');
    assertEq(logs[0].mg, 80, 'mg stored');
    assertEq(logs[0].e, '⚡', 'energy drink name classified with the energy-drink emoji');
    assertTrue(typeof logs[0].ts === 'number', 'entry has a numeric ts (decay calculations in peak.html/caffeine.html rely on this)');
    assertTrue(logs[0].id.startsWith('c'), 'id uses the same "c"-prefixed id scheme as caffeine.html\'s own logDrink()');

    await TOOL_EXECUTORS.log_caffeine({ name: 'Green tea', mg: 28 });
    logs = fake.rows.caffeine['caf:logs'];
    assertEq(logs.length, 2, 'a second caffeine entry appends');
    assertEq(logs[1].e, '🍵', 'tea classified with the tea emoji');

    await TOOL_EXECUTORS.log_caffeine({ name: 'Espresso shot', mg: 64.7 });
    assertEq(fake.rows.caffeine['caf:logs'][2].mg, 65, 'mg is rounded to a whole number, matching caffeine.html\'s own logDrink()');

    await TOOL_EXECUTORS.log_caffeine({ name: 'Random supplement scoop', mg: 200 });
    assertEq(fake.rows.caffeine['caf:logs'][3].e, '💊', 'a supplement/pre-workout name gets the pill emoji');
  }

  // ==================== log_nicotine ====================
  {
    const fake = makeFakeSupabase({ caffeine: {} });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.log_nicotine({ name: 'Zyn 6mg (Wintergreen)', mg: 6 });
    assertEq(r1.ok, true, 'log_nicotine returns ok');
    const logs = fake.rows.caffeine['nic:logs'];
    assertEq(logs.length, 1, 'one nicotine log entry created');
    assertEq(logs[0].n, 'Zyn 6mg (Wintergreen)', 'name stored');
    assertEq(logs[0].mg, 6, 'mg stored');
    assertEq(logs[0].e, '🟣', 'nicotine entries use the same purple-dot emoji as caffeine.html\'s own logPouch()');
    assertTrue(logs[0].id.startsWith('n'), 'id uses the same "n"-prefixed id scheme as caffeine.html\'s own logPouch()');

    // Caffeine and nicotine logs must be independent arrays on the same row.
    await TOOL_EXECUTORS.log_caffeine({ name: 'Coffee', mg: 95 });
    assertEq(fake.rows.caffeine['nic:logs'].length, 1, 'logging caffeine afterward does not disturb the nicotine log');
    assertEq(fake.rows.caffeine['caf:logs'].length, 1, 'and the caffeine log is correctly separate too');
  }

  // ==================== add_note ====================
  {
    const fake = makeFakeSupabase({ notes: { 'notes:items': [{ id: 'n_old', title: 'Existing', body: 'keep me', updatedAt: 1 }] } });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.add_note({ title: 'Landlord', body: 'Called about the lease renewal, wants a response by Friday' });
    assertEq(r1.ok, true, 'add_note returns ok');
    const notes = fake.rows.notes['notes:items'];
    assertEq(notes.length, 2, 'new note appended, existing note preserved');
    assertTrue(notes.some(n => n.id === 'n_old'), 'pre-existing note untouched');
    const added = notes.find(n => n.id !== 'n_old');
    assertEq(added.title, 'Landlord', 'title stored');
    assertEq(added.body, 'Called about the lease renewal, wants a response by Friday', 'body stored');
    assertTrue(typeof added.updatedAt === 'number', 'updatedAt is a numeric timestamp, matching notes.html\'s own shape');

    // Title is optional.
    const r2 = await TOOL_EXECUTORS.add_note({ body: 'Just a body, no title' });
    assertEq(r2.ok, true, 'add_note works with no title');
    const untitled = fake.rows.notes['notes:items'].find(n => n.body === 'Just a body, no title');
    assertEq(untitled.title, '', 'title defaults to empty string when omitted, matching notes.html\'s own blank-title handling');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
