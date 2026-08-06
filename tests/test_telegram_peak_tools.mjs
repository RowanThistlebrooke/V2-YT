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

  // ==================== log_morning_checkin ====================
  // (stores to the 'sleep' row now — see sleep.html, which owns this data
  // as its own dedicated page instead of it living inside peak.html)
  {
    const fake = makeFakeSupabase({ sleep: {} });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.log_morning_checkin({ wake_time: '06:45', rhr: 52, sleep_hours: 7.5, sleep_quality: 4 });
    assertEq(r1.ok, true, 'log_morning_checkin returns ok');
    const stored1 = fake.rows.sleep['sleep:nights'][todayKey];
    assertEq(stored1.wakeTime, '06:45', 'morning check-in stores wakeTime');
    assertEq(stored1.rhr, 52, 'morning check-in stores rhr');
    assertEq(stored1.sleepHours, 7.5, 'morning check-in stores sleepHours');
    assertEq(stored1.sleepQuality, 4, 'morning check-in stores sleepQuality');

    // Partial follow-up call should preserve fields not mentioned this time.
    const r2 = await TOOL_EXECUTORS.log_morning_checkin({ sleep_quality: 5 });
    assertEq(r2.ok, true, 'second partial morning check-in call returns ok');
    const stored2 = fake.rows.sleep['sleep:nights'][todayKey];
    assertEq(stored2.wakeTime, '06:45', 'partial update preserves previously-set wakeTime');
    assertEq(stored2.rhr, 52, 'partial update preserves previously-set rhr');
    assertEq(stored2.sleepHours, 7.5, 'partial update preserves previously-set sleepHours');
    assertEq(stored2.sleepQuality, 5, 'partial update overwrites only the field actually provided');

    // sleep_quality clamps to the 1-5 range.
    const fake2 = makeFakeSupabase({ sleep: {} });
    global.fetch = fake2.fetchStub;
    await TOOL_EXECUTORS.log_morning_checkin({ sleep_quality: 9 });
    assertEq(fake2.rows.sleep['sleep:nights'][todayKey].sleepQuality, 5, 'sleep_quality clamps above range down to 5');
    await TOOL_EXECUTORS.log_morning_checkin({ sleep_quality: 0 });
    assertEq(fake2.rows.sleep['sleep:nights'][todayKey].sleepQuality, 1, 'sleep_quality clamps below range up to 1');
  }

  // ==================== log_bedtime + tracked sleep on log_morning_checkin ====================
  {
    const fake = makeFakeSupabase({ sleep: {} });
    global.fetch = fake.fetchStub;

    const bed = await TOOL_EXECUTORS.log_bedtime({});
    assertEq(bed.ok, true, 'log_bedtime returns ok');
    assertTrue(!!fake.rows.sleep['sleep:pendingBedtime'] && typeof fake.rows.sleep['sleep:pendingBedtime'].ts === 'number', 'log_bedtime stores a pending bedtime timestamp');

    // Simulate real elapsed time by backdating the stored pending timestamp
    // directly (rather than actually sleeping for the test to pass).
    fake.rows.sleep['sleep:pendingBedtime'].ts = Date.now() - 7.5 * 3600000;

    const wake = await TOOL_EXECUTORS.log_morning_checkin({});
    assertEq(wake.ok, true, 'log_morning_checkin returns ok when closing out a tracked bedtime');
    assertEq(wake.trackedFromBedtime, true, 'result flags that sleep hours came from a tracked bedtime, not a manual estimate');
    assertEq(wake.entry.sleepHours, 7.5, 'sleep hours computed from the real elapsed time between log_bedtime and log_morning_checkin');
    assertTrue(/^\d{2}:\d{2}$/.test(wake.entry.wakeTime), 'wake time is auto-filled from the current moment when tracked, matching the HH:MM format');
    assertTrue(!('sleep:pendingBedtime' in fake.rows.sleep), 'the pending bedtime is cleared once closed out by a check-in');

    // An explicit sleep_hours from the user overrides tracking, even if a bedtime was pending.
    const fake2 = makeFakeSupabase({ sleep: {} });
    global.fetch = fake2.fetchStub;
    await TOOL_EXECUTORS.log_bedtime({});
    fake2.rows.sleep['sleep:pendingBedtime'].ts = Date.now() - 6 * 3600000;
    const overridden = await TOOL_EXECUTORS.log_morning_checkin({ sleep_hours: 9 });
    assertEq(overridden.trackedFromBedtime, false, 'an explicitly stated sleep_hours is not overwritten by tracking');
    assertEq(overridden.entry.sleepHours, 9, 'the user-stated sleep_hours value wins over the tracked elapsed time');
    assertTrue(!('sleep:pendingBedtime' in fake2.rows.sleep), 'the pending bedtime is still cleared even when it was not the one used');

    // A stale pending bedtime (way too long ago — a forgotten wake-up, not a real night) is ignored, not trusted.
    const fake3 = makeFakeSupabase({ sleep: {} });
    global.fetch = fake3.fetchStub;
    await TOOL_EXECUTORS.log_bedtime({});
    fake3.rows.sleep['sleep:pendingBedtime'].ts = Date.now() - 40 * 3600000; // 40 hours ago
    const stale = await TOOL_EXECUTORS.log_morning_checkin({});
    assertEq(stale.trackedFromBedtime, false, 'an implausibly long pending bedtime (40h) is not trusted as real tracked sleep');
    assertEq(stale.entry.sleepHours, null, 'no bogus sleep hours value is logged from a stale pending bedtime');
    assertTrue(!('sleep:pendingBedtime' in fake3.rows.sleep), 'the stale pending bedtime is still cleared so it cannot pollute a later night');

    // No pending bedtime at all -> unchanged, pre-existing behavior.
    const fake4 = makeFakeSupabase({ sleep: {} });
    global.fetch = fake4.fetchStub;
    const noTracking = await TOOL_EXECUTORS.log_morning_checkin({ wake_time: '07:00', sleep_hours: 8 });
    assertEq(noTracking.trackedFromBedtime, false, 'with no pending bedtime at all, behaves exactly like a normal manual check-in');
    assertEq(noTracking.entry.wakeTime, '07:00', 'manual wake_time is respected with no tracking involved');

    // log_bedtime backfill via an explicit `at`.
    const fake5 = makeFakeSupabase({ sleep: {} });
    global.fetch = fake5.fetchStub;
    const backfilled = await TOOL_EXECUTORS.log_bedtime({ at: '2026-01-01T23:30:00.000Z' });
    assertEq(backfilled.ok, true, 'log_bedtime accepts an explicit backfilled `at` timestamp');
    assertEq(fake5.rows.sleep['sleep:pendingBedtime'].ts, new Date('2026-01-01T23:30:00.000Z').getTime(), 'the backfilled timestamp is stored exactly as given');

    const badTime = await TOOL_EXECUTORS.log_bedtime({ at: 'not a real date' });
    assertEq(badTime.ok, false, 'an unparseable `at` value is rejected rather than silently storing garbage');
  }

  // ==================== log_feeling_checkin ====================
  {
    const fake = makeFakeSupabase({ peak: {} });
    global.fetch = fake.fetchStub;

    const rejected = await TOOL_EXECUTORS.log_feeling_checkin({});
    assertEq(rejected.ok, false, 'log_feeling_checkin rejects when both feeling and stress are missing');
    assertEq((fake.rows.peak['peak:checkins'] || []).length, 0, 'rejected call does not create an entry');

    const r1 = await TOOL_EXECUTORS.log_feeling_checkin({ feeling: 4, stress: 2, note: 'good morning' });
    assertEq(r1.ok, true, 'log_feeling_checkin returns ok with valid input');
    let list = fake.rows.peak['peak:checkins'];
    assertEq(list.length, 1, 'first feeling check-in creates one entry');
    assertEq(list[0].feeling, 4, 'first entry stores feeling');
    assertEq(list[0].stress, 2, 'first entry stores stress');
    assertEq(list[0].note, 'good morning', 'first entry stores note');
    assertEq(list[0].dateKey, todayKey, 'entry is dated using the plain calendar date convention');

    // Only one of feeling/stress provided is still valid.
    const r2 = await TOOL_EXECUTORS.log_feeling_checkin({ stress: 5 });
    assertEq(r2.ok, true, 'log_feeling_checkin accepts stress-only input');
    list = fake.rows.peak['peak:checkins'];
    assertEq(list.length, 2, 'stress-only check-in appends a second entry');
    assertEq(list[1].feeling, null, 'stress-only entry has null feeling');
    assertEq(list[1].stress, 5, 'stress-only entry stores stress');

    // Multiple check-ins in the same day must create separate entries, never overwrite.
    await TOOL_EXECUTORS.log_feeling_checkin({ feeling: 2 });
    list = fake.rows.peak['peak:checkins'];
    assertEq(list.length, 3, 'a third same-day check-in appends rather than overwriting');
    assertTrue(new Set(list.map(c => c.id)).size === 3, 'each check-in gets a distinct id');
  }

  // ==================== add_recurring_item ====================
  {
    const fake = makeFakeSupabase({ goals: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily' }] } });
    global.fetch = fake.fetchStub;

    const r1 = await TOOL_EXECUTORS.add_recurring_item({ name: 'Morning Check-In', time: '08:00', auto_source: 'peak_morning' });
    assertEq(r1.ok, true, 'add_recurring_item returns ok for a new name');
    let defs = fake.rows.goals['recur:defs'];
    assertEq(defs.length, 2, 'new item is appended to existing defs');
    const added = defs.find(d => d.name === 'Morning Check-In');
    assertTrue(!!added, 'the new item is findable by name');
    assertEq(added.freq, 'daily', 'freq defaults to "daily" when not "days"');
    assertEq(added.autoSource, 'peak_morning', 'a recognized auto_source is stored as-is');
    assertEq(added.time, '08:00', 'time is stored as provided');

    // Duplicate name (case-insensitive) is rejected.
    const dup = await TOOL_EXECUTORS.add_recurring_item({ name: 'morning check-in' });
    assertEq(dup.ok, false, 'add_recurring_item rejects a case-insensitive duplicate name');
    assertEq(fake.rows.goals['recur:defs'].length, 2, 'rejected duplicate does not add another entry');

    // freq: 'days' with a days array is respected and filtered.
    const r2 = await TOOL_EXECUTORS.add_recurring_item({ name: 'Weigh-In', freq: 'days', days: [1, 3, 5, 9, -1, 2.5] });
    assertEq(r2.ok, true, 'add_recurring_item accepts freq "days"');
    defs = fake.rows.goals['recur:defs'];
    const weighIn = defs.find(d => d.name === 'Weigh-In');
    assertEq(weighIn.freq, 'days', 'freq "days" is respected');
    assertEq(weighIn.days, [1, 3, 5], 'days array is filtered to valid integers 0-6 only');

    // Unrecognized auto_source falls back to null rather than storing garbage.
    const r3 = await TOOL_EXECUTORS.add_recurring_item({ name: 'Random Task', auto_source: 'not_a_real_source' });
    assertEq(r3.ok, true, 'add_recurring_item still succeeds with an unrecognized auto_source');
    defs = fake.rows.goals['recur:defs'];
    const randomTask = defs.find(d => d.name === 'Random Task');
    assertEq(randomTask.autoSource, null, 'unrecognized auto_source falls back to null');

    // No freq/days at all -> plain daily item with no autoSource.
    const r4 = await TOOL_EXECUTORS.add_recurring_item({ name: 'Read Bible' });
    assertEq(r4.ok, true, 'add_recurring_item works with just a name');
    defs = fake.rows.goals['recur:defs'];
    const plain = defs.find(d => d.name === 'Read Bible');
    assertEq(plain.freq, 'daily', 'a bare name defaults to daily freq');
    assertEq(plain.days, null, 'a bare name has null days');
    assertEq(plain.autoSource, null, 'a bare name has null autoSource');
    assertEq(plain.time, null, 'a bare name has null time when not provided');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
