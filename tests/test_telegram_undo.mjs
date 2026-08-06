// undo_last_action: patchRow() transparently snapshots the pre-mutation
// state of whichever row it just touched into independent action-history rows,
// and repeated undo calls can step backward through recent changes.
import { TOOL_EXECUTORS } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function makeFakeSupabase(seed) {
  const rows = JSON.parse(JSON.stringify(seed || {}));
  const updatedAt = {};
  let writeCounter = 0;
  async function fetchStub(url, opts) {
    const u = String(url);
    if (u.includes('/rest/v1/app_state')) {
      if (!opts || !opts.method || opts.method === 'GET') {
        const like = u.match(/key=like\.([^&]+)/);
        if (like) {
          const prefix = decodeURIComponent(like[1]).replace(/\*$/, '');
          const descending = u.includes('order=updated_at.desc');
          const limit = Number((u.match(/[?&]limit=(\d+)/) || [])[1] || 100);
          const matches = Object.keys(rows).filter(key => key.startsWith(prefix)).map(key => ({
            key, data: JSON.parse(JSON.stringify(rows[key])), updated_at: updatedAt[key] || 0,
          })).sort((a, b) => descending ? b.updated_at - a.updated_at : a.updated_at - b.updated_at);
          return { ok: true, json: async () => matches.slice(0, limit) };
        }
        const m = u.match(/key=eq\.([^&]+)/);
        const key = decodeURIComponent(m[1]);
        return { ok: true, json: async () => Object.hasOwn(rows, key) ? [{ data: JSON.parse(JSON.stringify(rows[key])) }] : [] };
      }
      if (opts.method === 'POST') {
        const body = JSON.parse(opts.body);
        const unique = String(opts.headers && opts.headers.Prefer || '').includes('ignore-duplicates');
        if (unique && Object.hasOwn(rows, body.key)) return { ok: true, json: async () => [] };
        rows[body.key] = body.data;
        updatedAt[body.key] = ++writeCounter;
        return { ok: true, json: async () => unique ? [body] : {} };
      }
      if (opts.method === 'DELETE') {
        const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
        if (!Object.hasOwn(rows, key)) return { ok: true, json: async () => [] };
        const prior = rows[key];
        delete rows[key];
        delete updatedAt[key];
        return { ok: true, json: async () => [{ key, data: JSON.parse(JSON.stringify(prior)) }] };
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

  // ==================== nothing to undo yet ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.undo_last_action();
    assertEq(result.ok, false, 'undo_last_action reports failure when nothing has been done yet');
  }

  // ==================== undoing a purchase log ====================
  {
    const fake = makeFakeSupabase({ finance: { purchases: [{ name: 'Existing', amount: 10 }] } });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.log_purchase({ name: 'Accidental purchase', amount: 999, currency: 'USD' });
    assertEq(fake.rows.finance.purchases.length, 2, 'the purchase was actually logged');

    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, true, 'undo_last_action succeeds');
    assertEq(fake.rows.finance.purchases, [{ name: 'Existing', amount: 10 }], 'the finance row is reverted to exactly its state before the accidental purchase — the existing entry survives, the new one is gone');
  }

  // ==================== undo reverts whichever row was touched most recently, across different tools ====================
  {
    const fake = makeFakeSupabase({
      'po-coach': { po_coach_workout_done: {} },
      goals: { 'habits:defs': [{ id: 'h1', name: 'Meditate' }], 'habits:log': {} },
    });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.mark_gym_done();
    assertTrue(Object.keys(fake.rows['po-coach'].po_coach_workout_done).length === 1, 'gym marked done');

    await TOOL_EXECUTORS.mark_habit_done({ habit: 'meditate' });
    assertTrue(Object.keys(fake.rows.goals['habits:log'].h1 || {}).length === 1, 'habit marked done');

    // Only the LAST action (mark_habit_done, touching 'goals') should be undone — mark_gym_done's change to 'po-coach' must survive.
    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, true, 'undo_last_action succeeds');
    assertEq(Object.keys(fake.rows.goals['habits:log'].h1 || {}).length, 0, 'the habit mark (the most recent action) was undone');
    assertTrue(Object.keys(fake.rows['po-coach'].po_coach_workout_done).length === 1, 'the earlier gym mark (a different row) is untouched by undoing the habit action');
  }

  // ==================== undo steps backward through multiple recent actions ====================
  {
    const fake = makeFakeSupabase({ notes: { 'notes:items': [] } });
    global.fetch = fake.fetchStub;

    const first = await TOOL_EXECUTORS.undo_last_action(); // consume the leftover state from the prior test block? No — fresh fake, so nothing yet.
    assertEq(first.ok, false, 'a fresh session with no actions yet has nothing to undo');

    await TOOL_EXECUTORS.add_note({ body: 'Note A' });
    await TOOL_EXECUTORS.add_note({ body: 'Note B' });
    assertEq(fake.rows.notes['notes:items'].length, 2, 'both notes were added');

    const undo1 = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo1.ok, true, 'first undo succeeds');
    assertEq(fake.rows.notes['notes:items'].length, 1, 'only the most recent note (B) is removed by undo — A remains');
    assertEq(fake.rows.notes['notes:items'][0].body, 'Note A', 'the remaining note is the older one');

    // Calling undo again steps back through the bounded history and removes Note A too.
    const undo2 = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo2.ok, true, 'a second consecutive undo steps backward through the history');
    assertEq(fake.rows.notes['notes:items'].length, 0, 'the second undo restores the state from before Note A');

    const undo3 = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo3.ok, false, 'undo reports nothing left after the history has been exhausted');
  }

  // ==================== a failed tool call does not overwrite the undo snapshot ====================
  {
    const fake = makeFakeSupabase({ goals: { 'recur:defs': [], [`goals:x`]: [] } });
    global.fetch = fake.fetchStub;

    await TOOL_EXECUTORS.add_todo({ text: 'A real todo' });
    const mismatchResult = await TOOL_EXECUTORS.mark_todo_done({ text: 'nonexistent thing entirely' });
    assertEq(mismatchResult.ok, false, 'the mark_todo_done call itself fails (no match)');

    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, true, 'undo is still available');
    assertEq(undo.undone, 'Updated to-dos/habits/recurring items', 'undo reverts the last SUCCESSFUL action (adding the todo), not overwritten by the failed mark_todo_done call');
  }

  // ==================== history is bounded rather than growing forever ====================
  {
    const fake = makeFakeSupabase({ notes: { 'notes:items': [] } });
    global.fetch = fake.fetchStub;
    for (let i = 1; i <= 25; i++) await TOOL_EXECUTORS.add_note({ body: 'Note ' + i });
    assertEq(Object.keys(fake.rows).filter(key => key.startsWith('telegram-action:')).length, 20, 'undo history keeps at most the 20 newest dashboard changes');
    for (let i = 0; i < 20; i++) await TOOL_EXECUTORS.undo_last_action();
    assertEq(fake.rows.notes['notes:items'].length, 5, 'the retained history can undo exactly the latest 20 changes');
    const exhausted = await TOOL_EXECUTORS.undo_last_action();
    assertEq(exhausted.ok, false, 'older changes beyond the retention limit are not accidentally undone');
  }

  // ==================== concurrent changes cannot overwrite each other's undo records ====================
  {
    const fake = makeFakeSupabase({ notes: { 'notes:items': [] } });
    global.fetch = fake.fetchStub;
    await Promise.all([
      TOOL_EXECUTORS.add_note({ body: 'Concurrent A' }),
      TOOL_EXECUTORS.add_note({ body: 'Concurrent B' }),
    ]);
    assertEq(Object.keys(fake.rows).filter(key => key.startsWith('telegram-action:')).length, 2, 'simultaneous dashboard writes retain two independent undo records');
  }

  // ==================== undo refuses to overwrite a newer dashboard edit ====================
  {
    const fake = makeFakeSupabase({ notes: { 'notes:items': [] } });
    global.fetch = fake.fetchStub;
    await TOOL_EXECUTORS.add_note({ body: 'Bot note' });
    fake.rows.notes['notes:items'].push({ id: 'manual', body: 'Newer dashboard edit' });

    const undo = await TOOL_EXECUTORS.undo_last_action();
    assertEq(undo.ok, false, 'undo declines when the same dashboard section has changed since the bot action');
    assertEq(undo.stale, true, 'the declined undo is identified as stale rather than missing');
    assertTrue(fake.rows.notes['notes:items'].some(note => note.body === 'Newer dashboard edit'), 'the newer dashboard edit remains untouched');
    assertEq(Object.keys(fake.rows).filter(key => key.startsWith('telegram-action:')).length, 0, 'the unsafe undo record is removed so it cannot be retried later');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
