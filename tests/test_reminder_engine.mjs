import handler, {
  effectiveTimeMinutes, shouldSendNow, composeSingleMessage, computeOneOffTimedUndone,
  computeUntimedGoalsUndone, computeHabitsUndone,
  shouldSendFeelingCheckin, computeUndone,
} from '../api/send-reminders.js';

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
  return res;
}
function minToHM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
// Freezes new Date()/Date.now() to a fixed instant (real args still parse
// normally — only the no-arg "current time" form is overridden). The
// "full handler integration" section below builds several scenarios
// relative to "now" (an overdue item's time, a bedtime 3h out, a bedtime
// already passed, etc.) — those all assumed a comfortably-midday real time
// and broke twice near real UTC midnight (a margin clamped to 0 lost its
// safety buffer against jitter, and a wrapped-past-midnight bedtime looked
// like it had already passed hours ago). Freezing removes this whole class
// of flakiness instead of chasing more margin edge cases.
function freezeClockAt(hour, minute) {
  const OrigDate = global.Date;
  const real = new OrigDate();
  const fixedMs = OrigDate.UTC(real.getUTCFullYear(), real.getUTCMonth(), real.getUTCDate(), hour, minute, 0, 0);
  class FrozenDate extends OrigDate {
    constructor(...args) { if (args.length === 0) super(fixedMs); else super(...args); }
    static now() { return fixedMs; }
  }
  global.Date = FrozenDate;
  return () => { global.Date = OrigDate; };
}
function nowMinUtc() {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === 'hour').value) % 24;
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}

(async () => {
  const origFetch = global.fetch;
  const BEDTIME = 23 * 60; // 23:00 -> 1380 minutes

  // ============================================================
  // effectiveTimeMinutes — pure, no clock involved
  // ============================================================
  {
    const eff = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20');
    assertTrue(Math.abs(eff - 18 * 60) <= 10, 'explicit time honored within jitter bounds (+/-10min): got ' + eff);

    const effAM = effectiveTimeMinutes('Skin care (AM)', null, BEDTIME, '2026-07-20');
    assertTrue(Math.abs(effAM - 8 * 60) <= 10, 'no explicit time + "(AM)" in name defaults near 8:00am: got ' + effAM);

    const effPM = effectiveTimeMinutes('Skin care (PM)', null, BEDTIME, '2026-07-20');
    assertTrue(Math.abs(effPM - (BEDTIME - 30)) <= 10, 'no explicit time + "(PM)" in name defaults near 30min before bedtime: got ' + effPM + ' vs bedtime-30=' + (BEDTIME - 30));

    const effGeneric = effectiveTimeMinutes('Clean up room (no time set)', null, BEDTIME, '2026-07-20');
    assertTrue(Math.abs(effGeneric - 9 * 60) <= 10, 'a generic name with no explicit time and no AM/PM hint defaults near 9:00am (GENERIC_ITEM_DEFAULT_MIN), same as any other item — no more null/catch-all special case: got ' + effGeneric);

    const effDeterministic1 = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20');
    const effDeterministic2 = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20');
    assertEq(effDeterministic1, effDeterministic2, 'same (name, time, bedtime, date) always produces the same jittered result — reproducible, not truly random');

    const effDifferentDay = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-21');
    assertTrue(Math.abs(effDifferentDay - 18 * 60) <= 10, 'a different date still stays within jitter bounds (may differ from another day, still bounded): got ' + effDifferentDay);

    // ---- sleep-quality gating: a poor night's sleep pushes a gym reminder later ----
    const gymNormal = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20', null);
    const gymPoorSleep = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20', 1);
    // Same name+date -> identical jitter component on both sides, so the
    // delay itself should come out to exactly 90, not just "roughly".
    assertEq(gymPoorSleep - gymNormal, 90, 'a poor-sleep night (quality 1) delays the gym reminder by exactly 90 minutes: normal=' + gymNormal + ' delayed=' + gymPoorSleep);

    const gymSleepQuality2 = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20', 2);
    assertEq(gymSleepQuality2 - gymNormal, 90, 'sleep quality exactly at the poor threshold (2) still delays the reminder by exactly 90 minutes');

    const gymOkSleep = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20', 3);
    assertEq(gymOkSleep, gymNormal, 'sleep quality above the poor threshold (3) does not delay the gym reminder at all');

    const gymGreatSleep = effectiveTimeMinutes('Gym', '18:00', BEDTIME, '2026-07-20', 5);
    assertEq(gymGreatSleep, gymNormal, 'great sleep (5) does not delay the gym reminder');

    // Non-gym items must be completely unaffected by sleep quality, even when poor.
    const readingNormal = effectiveTimeMinutes('Read', '20:00', BEDTIME, '2026-07-20', null);
    const readingPoorSleep = effectiveTimeMinutes('Read', '20:00', BEDTIME, '2026-07-20', 1);
    assertEq(readingPoorSleep, readingNormal, 'a non-gym item (Read) is completely unaffected by poor sleep quality');

    // "workout"/"lift" keywords also count as gym items, not just the literal word "gym".
    const workoutPoorSleep = effectiveTimeMinutes('Evening workout', '18:00', BEDTIME, '2026-07-20', 1);
    const workoutNormal = effectiveTimeMinutes('Evening workout', '18:00', BEDTIME, '2026-07-20', null);
    assertTrue(workoutPoorSleep > workoutNormal, '"workout" in the name is recognized as a gym item too, not just the literal word "gym"');
  }

  // ============================================================
  // shouldSendNow — pure decision logic
  // ============================================================
  {
    assertEq(shouldSendNow(null, 100, 120, BEDTIME), false, 'not due before its effective time (now=100 < eff=120)');
    assertEq(shouldSendNow(null, 120, 120, BEDTIME), true, 'due exactly at its effective time with no prior state (first reminder)');
    assertEq(shouldSendNow(null, 200, 120, BEDTIME), true, 'due any time after its effective time with no prior state');

    const justReminded = { count: 1, lastMinutes: 200 };
    assertEq(shouldSendNow(justReminded, 210, 120, BEDTIME), false, 'not due again 10 min after being reminded (renag interval is 90 min)');
    assertEq(shouldSendNow(justReminded, 200 + 90, 120, BEDTIME), true, 'due again exactly at the 90-minute renag interval');
    assertEq(shouldSendNow(justReminded, 200 + 200, 120, BEDTIME), true, 'due again well past the renag interval');

    assertEq(shouldSendNow(null, BEDTIME, 120, BEDTIME), false, 'never due once now has reached bedtime, even with no prior state');
    assertEq(shouldSendNow(justReminded, BEDTIME + 30, 120, BEDTIME), false, 'stops nagging past bedtime even if still undone');
  }

  // ============================================================
  // composeSingleMessage — varies by nag count, deterministic
  // ============================================================
  {
    const first = composeSingleMessage('Gym', '2026-07-20', 0);
    const again = composeSingleMessage('Gym', '2026-07-20', 0);
    assertEq(first, again, 'same (name, date, count) always composes the same message');
    assertTrue(first.toLowerCase().includes('gym'), 'composed message actually mentions the item name: "' + first + '"');

    const variants = new Set([0, 1, 2, 3, 4, 5].map(c => composeSingleMessage('Gym', '2026-07-20', c)));
    assertTrue(variants.size > 1, 'different nag counts produce at least some varied phrasing (not the identical line every re-nag)');
  }

  // ============================================================
  // computeOneOffTimedUndone
  // ============================================================
  {
    const goalsData = {
      'goals:2026-07-20': [
        { text: 'Buy milk', done: false, time: '11:00' },
        { text: 'Already done thing', done: true, time: '12:00' },
        { text: 'No time set', done: false },
        { text: 'Gym', done: false, time: '18:00' }, // matches a recur def name below — should be excluded
      ],
    };
    const defs = [{ id: 'r1', name: 'Gym', freq: 'daily' }];
    const result = computeOneOffTimedUndone(goalsData, '2026-07-20', defs);
    assertEq(result, [{ name: 'Buy milk', time: '11:00' }], 'only surfaces undone, timed, non-recurring one-off goals');
  }

  // ============================================================
  // computeUntimedGoalsUndone — plain to-dos with no time at all, previously
  // invisible to the whole reminder engine
  // ============================================================
  {
    const goalsData = {
      'goals:2026-07-20': [
        { text: 'Call the dentist', done: false },
        { text: 'Already done thing', done: true },
        { text: 'Buy milk', done: false, time: '11:00' }, // has a time -> handled by computeOneOffTimedUndone instead
        { text: 'Gym', done: false }, // matches a recur def name below — should be excluded, already covered as a recurring item
      ],
    };
    const defs = [{ id: 'r1', name: 'Gym', freq: 'daily' }];
    const result = computeUntimedGoalsUndone(goalsData, '2026-07-20', defs);
    assertEq(result, [{ name: 'Call the dentist', time: null }], 'only surfaces undone, untimed, non-recurring one-off goals');
    assertEq(computeUntimedGoalsUndone({}, '2026-07-20', defs), [], 'no goals data at all does not throw, just returns empty');
  }

  // ============================================================
  // computeHabitsUndone — main.html's separate Daily Habits tracker, also
  // previously invisible to the whole reminder engine
  // ============================================================
  {
    const goalsData = {
      'habits:defs': [
        { id: 'h1', name: 'Cold shower' },
        { id: 'h2', name: 'No sugar' },
        { id: 'h3', name: 'Journal' },
      ],
      'habits:log': {
        h1: { '2026-07-20': true },
        h2: { '2026-07-19': true }, // done yesterday, not today -> still undone today
      },
    };
    const result = computeHabitsUndone(goalsData, '2026-07-20');
    assertEq(result, [{ name: 'No sugar', time: null }, { name: 'Journal', time: null }], 'only habits not checked off for today\'s exact date key are undone');
    assertEq(computeHabitsUndone({}, '2026-07-20'), [], 'no habits data at all does not throw, just returns empty');
    assertEq(computeHabitsUndone({ 'habits:defs': [{ id: 'h1', name: 'Cold shower' }], 'habits:log': { h1: { '2026-07-20': true } } }, '2026-07-20'), [], 'a fully-done habit list returns empty');
  }

  // ============================================================
  // Full handler integration
  // ============================================================
  // Frozen at a comfortably-midday UTC time so every scenario below (an
  // overdue item, a bedtime hours out, a bedtime already passed, a generic
  // item's default GENERIC_ITEM_DEFAULT_MIN window, the 9am-bedtime
  // feeling-checkin window) is always constructible and always
  // deterministic, regardless of the real time this suite happens to run at.
  const unfreeze = freezeClockAt(14, 0);
  const nowMin = nowMinUtc();
  const pastTime = minToHM(Math.max(0, nowMin - 45));
  const bedtimeFuture = minToHM(Math.min(1439, nowMin + 180));
  // Pin the morning briefing's fire time safely past every "now" used in
  // this block (the clock is frozen, so this stays out of range for all of
  // the full-handler tests below) — otherwise it fires unprompted alongside
  // whatever single message each test is actually checking for.
  process.env.MORNING_BRIEFING_TIME = '23:59';

  // peakData defaults to a just-now check-in so the independent periodic
  // feeling-check-in reminder (tested separately below) never fires inside
  // tests that are really about something else.
  function fakeSupabase({ recurDefs = [], oneOffGoals = [], goalsExtra = {}, stateRow = null, peakData = { 'peak:checkins': [{ ts: Date.now() }] } } = {}) {
    let writtenState = null;
    const sentPayloads = [];
    // Upserts (POST /rest/v1/app_state?on_conflict=key) carry the row key
    // inside the JSON body, not the URL query string — only GET reads use
    // `?key=eq.<key>`. Check the method + body, not the URL, for writes.
    const fetchStub = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && u.includes('/rest/v1/app_state')) {
        const body = JSON.parse(opts.body);
        if (body.key === 'reminder_state') writtenState = body.data;
        return { ok: true, json: async () => ({}) };
      }
      if (u.includes('key=eq.goals')) {
        return { ok: true, json: async () => [{ data: Object.assign({ 'recur:defs': recurDefs, ['goals:' + '__ignored__']: [] }, goalsExtra) }] };
      }
      if (u.includes('key=eq.reminder_state')) {
        return { ok: true, json: async () => (stateRow ? [{ data: stateRow }] : []) };
      }
      if (u.includes('key=eq.peak')) {
        return { ok: true, json: async () => (peakData ? [{ data: peakData }] : []) };
      }
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      if (u.includes('sendMessage')) {
        sentPayloads.push(JSON.parse(opts.body));
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      throw new Error('unexpected fetch: ' + u);
    };
    return { fetchStub, getWrittenState: () => writtenState, getSentPayloads: () => sentPayloads };
  }

  // ---- an item whose time has passed and never reminded today: fires an individual message ----
  {
    process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = '123';
    process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon';
    process.env.REMINDER_TIMEZONE = 'UTC';
    process.env.BEDTIME_LOCAL = bedtimeFuture;
    delete process.env.CRON_SECRET;

    // goalsData needs today's actual dateKey (6am boundary in UTC) — reconstruct precisely like the handler does.
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();

    const { fetchStub, getWrittenState, getSentPayloads } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: pastTime }],
    });
    global.fetch = fetchStub;
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._status, 200, 'handler returns 200');
    assertEq(res._body.sent, true, 'an overdue item triggers a send');
    assertEq(res._body.results.length, 1, 'exactly one individual reminder sent');
    assertEq(res._body.results[0].name, 'Gym', 'correct item named in the result');
    const written = getWrittenState();
    assertTrue(!!written && !!written[todayKey6amActual] && written[todayKey6amActual].Gym && written[todayKey6amActual].Gym.count === 1, 'reminder state persisted with count=1 after the first send: ' + JSON.stringify(written));

    const sent = getSentPayloads();
    assertEq(sent.length, 1, 'exactly one Telegram sendMessage call made');
    assertTrue(!!sent[0].reply_markup, 'an individual item reminder carries an inline keyboard');
    assertEq(sent[0].reply_markup.inline_keyboard, [[{ text: '✅ Done', callback_data: 'done:Gym' }]], 'the keyboard is a single "Done" button whose callback_data names the exact item');
  }

  // ---- a poor night's sleep delays the gym reminder past "now", so it's not due yet even though it normally would be ----
  {
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const todayPlainNow = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    // Gym at 13:00, "now" frozen at 14:00 -> normally overdue by an hour. A
    // poor-sleep night (+90min delay) pushes its effective time to ~14:30-
    // 14:40, which is still in the future, so it must NOT fire yet.
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: '13:00' }] } }] };
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: { 'peak:checkins': [{ ts: Date.now() }] } }] };
      if (u.includes('key=eq.sleep')) return { ok: true, json: async () => [{ data: { 'sleep:nights': { [todayPlainNow]: { sleepQuality: 1 } } } }] };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, false, 'a gym reminder that would normally be overdue is correctly held back after a poor-sleep night');

    // Sanity check: the SAME setup without the poor sleepQuality DOES fire, proving the delay (not some other bug) is what suppressed it above.
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: '13:00' }] } }] };
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: { 'peak:checkins': [{ ts: Date.now() }] } }] }; // no sleep logged
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      if (u.includes('sendMessage')) return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      throw new Error('unexpected fetch: ' + u);
    };
    const resWithoutSleepData = mockRes();
    await handler({ headers: {} }, resWithoutSleepData);
    assertEq(resWithoutSleepData._body.sent, true, 'the same overdue gym reminder DOES fire when there\'s no sleep-quality data to gate on, confirming the earlier suppression was really the sleep-delay logic');
  }

  // ---- same item, reminded again immediately (before renag interval): does NOT re-send ----
  {
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const stateRow = { [todayKey6amActual]: { Gym: { count: 1, lastMinutes: nowMin - 5 } } };
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: pastTime }] } }] };
      if (u.includes('key=eq.reminder_state')) return { ok: true, json: async () => [{ data: stateRow }] };
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: { 'peak:checkins': [{ ts: Date.now() }] } }] };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, false, 'already-reminded-recently item does not trigger a second send within the renag window');
  }

  // ---- past bedtime: no sends at all, even for a never-reminded overdue item ----
  {
    process.env.BEDTIME_LOCAL = minToHM(Math.max(0, nowMin - 60)); // bedtime already passed
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: { 'recur:defs': [{ id: 'r1', name: 'Gym', freq: 'daily', days: null, autoSource: null, time: pastTime }] } }] };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, false, 'nothing sends once the current time is past bedtime');
    process.env.BEDTIME_LOCAL = bedtimeFuture;
  }

  // ---- CRON_SECRET gating still works ----
  {
    process.env.CRON_SECRET = 'shh';
    global.fetch = async () => { throw new Error('should not fetch anything before auth check'); };
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._status, 401, 'missing Authorization header is rejected with 401 when CRON_SECRET is set');
    delete process.env.CRON_SECRET;
  }

  // ---- a generic (no-time, no AM/PM) recurring item gets its own
  // individual message, not bundled with anything else — and re-nags on
  // its own per-item cooldown same as a timed item ----
  {
    process.env.CRON_SECRET && delete process.env.CRON_SECRET;
    process.env.BEDTIME_LOCAL = bedtimeFuture; // clock is frozen at 14:00, past GENERIC_ITEM_DEFAULT_MIN (9am), so this item's default time has already arrived
    const { fetchStub, getWrittenState, getSentPayloads } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Clean up room', freq: 'daily', days: null, autoSource: null, time: null }],
    });
    global.fetch = fetchStub;
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, true, 'a generic untimed item is due on its own, defaulting near GENERIC_ITEM_DEFAULT_MIN');
    assertEq(res._body.results.length, 1, 'exactly one message sent for the one undone item');
    assertEq(res._body.results[0].name, 'Clean up room', 'the result names the item directly, same as any individual timed reminder — no separate catch-all tag');
    assertTrue(!!getSentPayloads()[0].reply_markup, 'a generic item still gets its own single-item Done button, same as a timed item (no more bundled-digest exception)');
    const written = getWrittenState();
    const todayKey6amActual = Object.keys(written)[0];
    assertEq(written[todayKey6amActual]['Clean up room'].lastMinutes, nowMin, 'per-item state persisted under the item\'s own name, same shape as a timed item');

    // Second tick right away (same nowMin, well within the re-nag cooldown): should NOT resend.
    const { fetchStub: fetchStub2 } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Clean up room', freq: 'daily', days: null, autoSource: null, time: null }],
      stateRow: written[todayKey6amActual] ? { [todayKey6amActual]: written[todayKey6amActual] } : null,
    });
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.reminder_state') && (!opts || opts.method !== 'POST')) return { ok: true, json: async () => [{ data: written }] };
      return fetchStub2(url, opts);
    };
    const res2 = mockRes();
    await handler({ headers: {} }, res2);
    assertEq(res2._body.sent, false, 'does not resend within the 90-minute re-nag cooldown');

    // Third tick, past the RENAG_INTERVAL_MIN cooldown: fires again.
    const { fetchStub: fetchStub3 } = fakeSupabase({
      recurDefs: [{ id: 'r1', name: 'Clean up room', freq: 'daily', days: null, autoSource: null, time: null }],
      stateRow: { [todayKey6amActual]: { 'Clean up room': { count: 1, lastMinutes: nowMin - 91 } } },
    });
    global.fetch = fetchStub3;
    const res3 = mockRes();
    await handler({ headers: {} }, res3);
    assertEq(res3._body.sent, true, 're-nags again once RENAG_INTERVAL_MIN has passed since it last fired, same cadence as a timed item');
  }

  // ---- multiple undone generic items (untimed recurring item, untimed
  // to-do, undone habit) each become their OWN separate message rather than
  // one bundled digest — but critically, only ONE goes out per tick even
  // though all three are simultaneously due, so they drip out across
  // separate ticks instead of arriving as a burst of texts within the same
  // minute (which would read exactly like the old bundled digest even
  // though the messages are technically separate) ----
  {
    process.env.CRON_SECRET && delete process.env.CRON_SECRET;
    process.env.BEDTIME_LOCAL = bedtimeFuture;
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const goalsExtra = {
      ['goals:' + todayKey6amActual]: [{ text: 'Call the dentist', done: false }],
      'habits:defs': [{ id: 'h1', name: 'Cold shower' }],
      'habits:log': {},
    };
    const recurDefs = [{ id: 'r1', name: 'Water plants', freq: 'daily', days: null, autoSource: null, time: null }];

    // Tick 1: all three undone, nothing sent yet today -> only the first one goes out.
    const { fetchStub, getWrittenState, getSentPayloads } = fakeSupabase({ recurDefs, goalsExtra });
    global.fetch = fetchStub;
    const res = mockRes();
    await handler({ headers: {} }, res);
    assertEq(res._body.sent, true, 'three separately-undone generic items are all due at once');
    assertEq(res._body.results.length, 1, 'only ONE result this tick, even with three items simultaneously due');
    assertEq(getSentPayloads().length, 1, 'only one Telegram message actually went out this tick — the rest wait for a later tick');
    assertTrue(!!getSentPayloads()[0].reply_markup, 'the one message sent still carries its own Done button');
    const firstSent = res._body.results[0].name;
    let written = getWrittenState();
    const stateAfterTick1 = written[todayKey6amActual];
    assertEq(Object.keys(stateAfterTick1), [firstSent], 'state only records the one item actually sent, not the other two still waiting');

    // Tick 2: same underlying undone items, but now with tick 1's state carried forward -> a DIFFERENT one goes out.
    const { fetchStub: fetchStub2, getWrittenState: getWrittenState2, getSentPayloads: getSentPayloads2 } = fakeSupabase({
      recurDefs, goalsExtra, stateRow: { [todayKey6amActual]: stateAfterTick1 },
    });
    global.fetch = fetchStub2;
    const res2 = mockRes();
    await handler({ headers: {} }, res2);
    assertEq(res2._body.results.length, 1, 'still only one send on the next tick');
    const secondSent = res2._body.results[0].name;
    assertTrue(secondSent !== firstSent, 'the second tick picks a DIFFERENT undone item than the first tick already sent: ' + firstSent + ' vs ' + secondSent);
    written = getWrittenState2();
    const stateAfterTick2 = written[todayKey6amActual];

    // Tick 3: both prior sends carried forward -> the last remaining item finally goes out.
    const { fetchStub: fetchStub3 } = fakeSupabase({
      recurDefs, goalsExtra, stateRow: { [todayKey6amActual]: stateAfterTick2 },
    });
    global.fetch = fetchStub3;
    const res3 = mockRes();
    await handler({ headers: {} }, res3);
    assertEq(res3._body.results.length, 1, 'still only one send on the third tick');
    const thirdSent = res3._body.results[0].name;
    assertEq([firstSent, secondSent, thirdSent].sort(), ['Call the dentist', 'Cold shower', 'Water plants'], 'across three ticks, all three distinct items eventually each got their own separate message');
  }

  // ============================================================
  // shouldSendFeelingCheckin — pure, no clock involved
  // ============================================================
  {
    const BED = 23 * 60;
    assertEq(shouldSendFeelingCheckin(null, 8 * 60, BED, null), false, 'not due before 9am even with nothing else going on');
    assertEq(shouldSendFeelingCheckin(null, 10 * 60, BED, null), true, 'due mid-morning with no prior check-ins/prompts at all');
    assertEq(shouldSendFeelingCheckin(null, BED, BED, null), false, 'never due once at/past bedtime');

    const recentCheckin = { 'peak:checkins': [{ ts: Date.now() - 30 * 60 * 1000 }] }; // 30 min ago
    assertEq(shouldSendFeelingCheckin(recentCheckin, 12 * 60, BED, null), false, 'suppressed by a real check-in logged within the interval, even with no prior prompt');

    const oldCheckin = { 'peak:checkins': [{ ts: Date.now() - 5 * 60 * 60 * 1000 }] }; // 5 hours ago
    assertEq(shouldSendFeelingCheckin(oldCheckin, 12 * 60, BED, null), true, 'a check-in older than the interval (4h) does not suppress a new prompt');

    assertEq(shouldSendFeelingCheckin(null, 12 * 60, BED, { lastMinutes: 12 * 60 - 60 }), false, 'suppressed by a prompt already sent within the interval, even with no real check-in');
    assertEq(shouldSendFeelingCheckin(null, 12 * 60, BED, { lastMinutes: 12 * 60 - 241 }), true, 'due again once the prompt interval (4h) has fully elapsed since the last prompt');
  }

  // ============================================================
  // peak_morning autoSource via computeUndone
  // ============================================================
  {
    const todayKey6amActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      if (d.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const todayPlainActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate());
    })();
    const goalsData = { 'recur:defs': [{ id: 'rc10', name: 'Morning Check-In', freq: 'daily', days: null, autoSource: 'peak_morning' }] };
    const fetchers = { goalsData, healthData: {}, gymData: {}, businessData: {}, readingData: {}, todayKey6am: todayKey6amActual, todayPlain: todayPlainActual, dow: new Date().getDay(), utcToday: new Date().toISOString().slice(0, 10) };

    const notDoneYet = await computeUndone(Object.assign({}, fetchers, { sleepData: {} }));
    assertEq(notDoneYet, ['Morning Check-In'], 'Morning Check-In is undone when sleep:nights has no entry for today');

    const alreadyDone = await computeUndone(Object.assign({}, fetchers, { sleepData: { 'sleep:nights': { [todayPlainActual]: { wakeTime: '07:30', ts: Date.now() } } } }));
    assertEq(alreadyDone, [], 'Morning Check-In is NOT undone once sleep:nights has today\'s entry (peak_morning autoSource correctly wired)');
  }

  // ==================== food/weight autoSource ====================
  {
    const todayPlainActual = (() => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    })();
    const goalsData = {
      'recur:defs': [
        { id: 'rcf', name: 'Log a meal', freq: 'daily', days: null, autoSource: 'food' },
        { id: 'rcw', name: 'Log weight', freq: 'daily', days: null, autoSource: 'weight' },
      ],
    };
    const baseFetchers = { goalsData, healthData: {}, gymData: {}, businessData: {}, readingData: {}, sleepData: {}, todayKey6am: todayPlainActual, todayPlain: todayPlainActual, dow: new Date().getDay(), utcToday: new Date().toISOString().slice(0, 10) };

    const neitherLogged = await computeUndone(baseFetchers);
    assertEq(neitherLogged.sort(), ['Log a meal', 'Log weight'], 'both food and weight are undone when nothing has been logged today');

    const foodLogged = await computeUndone(Object.assign({}, baseFetchers, {
      healthData: { 'cal:entries': [{ id: 'e1', dateKey: todayPlainActual, calories: 500 }] },
    }));
    assertEq(foodLogged, ['Log weight'], 'a meal entry dated today satisfies the food autoSource, leaving only weight undone');

    const weightLogged = await computeUndone(Object.assign({}, baseFetchers, {
      gymData: { po_coach_weights: [{ dateKey: todayPlainActual, weight: 180 }] },
    }));
    assertEq(weightLogged, ['Log a meal'], 'a weigh-in dated today satisfies the weight autoSource, leaving only food undone');

    const bothLogged = await computeUndone(Object.assign({}, baseFetchers, {
      healthData: { 'cal:entries': [{ id: 'e1', dateKey: todayPlainActual }] },
      gymData: { po_coach_weights: [{ dateKey: todayPlainActual, weight: 180 }] },
    }));
    assertEq(bothLogged, [], 'both undone items clear once both are logged for today');

    const staleFoodEntry = await computeUndone(Object.assign({}, baseFetchers, {
      healthData: { 'cal:entries': [{ id: 'e0', dateKey: '2020-01-01' }] },
    }));
    assertEq(staleFoodEntry.sort(), ['Log a meal', 'Log weight'], 'a meal logged on a past date does not satisfy today\'s food autoSource');
  }

  // ============================================================
  // Full handler: feeling check-in fires and is tracked in state
  // ============================================================
  {
    process.env.CRON_SECRET && delete process.env.CRON_SECRET;
    process.env.BEDTIME_LOCAL = bedtimeFuture; // comfortably in the future, per the earlier nowMin/bedtimeFuture setup
    let sentBody = null;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes('key=eq.goals')) return { ok: true, json: async () => [{ data: {} }] };
      if (u.includes('key=eq.peak')) return { ok: true, json: async () => [{ data: {} }] }; // no check-ins logged at all today
      if (u.includes('key=eq.reminder_state')) return { ok: true, json: async () => [] };
      if (opts && opts.method === 'POST' && u.includes('/rest/v1/app_state')) return { ok: true, json: async () => ({}) };
      if (u.includes('/rest/v1/app_state')) return { ok: true, json: async () => [] };
      if (u.includes('sendMessage')) { sentBody = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
      throw new Error('unexpected fetch: ' + u);
    };
    const res = mockRes();
    await handler({ headers: {} }, res);
    // The clock is frozen at 14:00 UTC (see freezeClockAt above), always
    // within the 9am-bedtime window, so this is now unconditional rather
    // than dependent on whatever real time this suite happens to run at.
    assertEq(res._body.sent, true, 'a feeling check-in prompt sends when nothing has been logged today and it is past 9am');
    assertTrue(!!sentBody && sentBody.length > 0, 'the feeling check-in message actually has content');
    assertTrue(res._body.results.some(r => r.name === '__feeling_checkin__'), 'the result is tagged distinctly as the feeling check-in');
  }

  unfreeze();
  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
