// Streak calculations returned by mark_gym_done, mark_habit_done, and
// mark_stretch_done — mirrors the exact "forgiving" streak rule (today
// counts if done, else fall back to yesterday) already used by the
// dashboard's own 🔥 streak counters on the Main and Gym tabs.
import { TOOL_EXECUTORS } from '../api/telegram-webhook.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
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

// Plain UTC calendar-date keys, N days before "today" — matches plainDateKey()
// under REMINDER_TIMEZONE=UTC (set below), computed dynamically so this test
// never goes stale or hits a timezone edge case.
function plainKeyDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
// 6am-boundary "active date" keys, N days before "today" — under
// REMINDER_TIMEZONE=UTC, this collapses to the same plain calendar date
// arithmetic as long as the real UTC hour is >= 6 when this test runs
// (guarded below rather than assumed).
function activeKeyDaysAgo(n) {
  const d = new Date();
  if (d.getUTCHours() < 6) d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCDate(d.getUTCDate() - n);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

(async () => {
  const origFetch = global.fetch;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'fake-anon-key';
  process.env.REMINDER_TIMEZONE = 'UTC';

  // Guard against the 6am-boundary edge case (real UTC time between
  // midnight and 6am shifts activeKeyDaysAgo's anchor by a day relative to
  // a naive "now"). Only the habit-streak block below depends on this.
  const safeForActiveDateTests = new Date().getUTCHours() >= 6;

  // ==================== mark_gym_done streak ====================
  {
    const fake = makeFakeSupabase({
      'po-coach': {
        po_coach_workout_done: {
          [plainKeyDaysAgo(1)]: 'x',
          [plainKeyDaysAgo(2)]: 'x',
        },
      },
    });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.mark_gym_done();
    assertEq(result.ok, true, 'mark_gym_done returns ok');
    assertEq(result.streak, 3, 'marking today done extends a 2-day prior streak to 3 (today + yesterday + the day before)');
  }

  // ==================== mark_gym_done streak broken by a gap ====================
  {
    const fake = makeFakeSupabase({
      'po-coach': {
        // yesterday is a gap — only 2 days ago was done.
        po_coach_workout_done: { [plainKeyDaysAgo(2)]: 'x' },
      },
    });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.mark_gym_done();
    assertEq(result.streak, 1, 'a gap at yesterday resets the streak to just today (1), not counting the day before the gap');
  }

  // ==================== mark_habit_done streak ====================
  if (safeForActiveDateTests) {
    const fake = makeFakeSupabase({
      goals: {
        'habits:defs': [{ id: 'h1', name: 'Meditate' }],
        'habits:log': { h1: { [activeKeyDaysAgo(1)]: true, [activeKeyDaysAgo(2)]: true, [activeKeyDaysAgo(3)]: true } },
      },
    });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.mark_habit_done({ habit: 'meditate' });
    assertEq(result.ok, true, 'mark_habit_done returns ok');
    assertEq(result.streak, 4, 'marking today done extends a 3-day prior habit streak to 4');

    // A different habit on the same goals row must have its own independent streak.
    const fake2 = makeFakeSupabase({
      goals: {
        'habits:defs': [{ id: 'h1', name: 'Meditate' }, { id: 'h2', name: 'Journal' }],
        'habits:log': { h1: { [activeKeyDaysAgo(1)]: true }, h2: {} },
      },
    });
    global.fetch = fake2.fetchStub;
    const result2 = await TOOL_EXECUTORS.mark_habit_done({ habit: 'journal' });
    assertEq(result2.streak, 1, 'a habit with no prior history starts its own streak at 1, unaffected by a sibling habit\'s streak');
  }

  // ==================== mark_stretch_done routine streak ====================
  {
    const items = [{ id: 'am1', name: 'Cat-Cow' }, { id: 'am2', name: 'Chin tucks' }];
    // Whole routine (both items) was completed on each of the last 2 days.
    const log = {
      am1: { [plainKeyDaysAgo(1)]: true, [plainKeyDaysAgo(2)]: true },
      am2: { [plainKeyDaysAgo(1)]: true, [plainKeyDaysAgo(2)]: true },
    };
    const fake = makeFakeSupabase({ 'po-coach': { 'stretch:am:items': items, 'stretch:log': log } });
    global.fetch = fake.fetchStub;

    // Marking only ONE item today does not complete the whole routine yet —
    // streak should NOT count today, falling back to the 2-day prior streak.
    const partial = await TOOL_EXECUTORS.mark_stretch_done({ routine: 'am', item: 'cat' });
    assertEq(partial.streak, 2, 'marking just one item does not complete today\'s routine, so the streak still reflects only the 2 fully-completed prior days');

    // Now mark the whole routine (no item specified) -> today becomes complete too.
    const full = await TOOL_EXECUTORS.mark_stretch_done({ routine: 'am' });
    assertEq(full.streak, 3, 'completing the full routine today extends the streak to 3');
  }

  // ==================== mark_stretch_done: a gap breaks the routine streak ====================
  {
    const items = [{ id: 'pm1', name: 'Couch stretch' }];
    const log = {
      // 2 days ago done, yesterday is a gap.
      pm1: { [plainKeyDaysAgo(2)]: true },
    };
    const fake = makeFakeSupabase({ 'po-coach': { 'stretch:pm:items': items, 'stretch:log': log } });
    global.fetch = fake.fetchStub;
    const result = await TOOL_EXECUTORS.mark_stretch_done({ routine: 'pm' });
    assertEq(result.streak, 1, 'a gap at yesterday resets the PM routine streak to just today');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
