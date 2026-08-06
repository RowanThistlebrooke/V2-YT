import handler, {
  shouldSendMorningBriefing, composeMorningBriefing,
  computeCaffeineSleepInsight, computeGymCheckinInsight, computeActionableInsight,
  computeDriftDayRows, computeDrift, computeDriftInsight,
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

// Same Date-freezing trick used in test_reminder_engine.mjs — avoids any
// midnight-boundary flakiness around the real clock.
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

(async () => {
  const origFetch = global.fetch;

  // ==================== shouldSendMorningBriefing (pure) ====================
  {
    assertEq(shouldSendMorningBriefing(6 * 60, 7 * 60, 23 * 60, null), false, 'not due before the briefing time');
    assertEq(shouldSendMorningBriefing(7 * 60, 7 * 60, 23 * 60, null), true, 'due exactly at the briefing time');
    assertEq(shouldSendMorningBriefing(9 * 60, 7 * 60, 23 * 60, null), true, 'due any time after the briefing time, same day');
    assertEq(shouldSendMorningBriefing(9 * 60, 7 * 60, 23 * 60, true), false, 'not due again once already sent today');
    assertEq(shouldSendMorningBriefing(23 * 60, 7 * 60, 23 * 60, null), false, 'not due once bedtime has arrived, even if never sent');
  }

  // ==================== composeMorningBriefing (pure) ====================
  {
    const empty = composeMorningBriefing([], null, 0);
    assertTrue(empty.includes('clean slate'), 'an empty today-list gets a distinct "nothing today" line');

    const withItems = composeMorningBriefing(['Gym', 'Read 20 pages'], null, 0);
    assertTrue(withItems.includes('- Gym') && withItems.includes('- Read 20 pages'), 'lists every undone item today');
    assertTrue(!withItems.includes('sleep'), 'no sleep line at all when sleepQuality is null');

    const poorSleep = composeMorningBriefing(['Gym'], 2, 0);
    assertTrue(poorSleep.includes('2/5') && poorSleep.toLowerCase().includes('rough one'), 'a poor logged sleep quality gets an explicit callout');

    const goodSleep = composeMorningBriefing(['Gym'], 4, 0);
    assertTrue(goodSleep.includes('4/5') && !goodSleep.toLowerCase().includes('rough one'), 'a decent sleep quality is mentioned without the "rough one" callout');

    const withSubs = composeMorningBriefing([], null, 1);
    assertTrue(withSubs.includes('1 subscription renewal') && !withSubs.includes('renewals'), 'singular phrasing for exactly one upcoming renewal');
    const withMultiSubs = composeMorningBriefing([], null, 3);
    assertTrue(withMultiSubs.includes('3 subscription renewals'), 'plural phrasing for multiple upcoming renewals');
    const noSubs = composeMorningBriefing([], null, 0);
    assertTrue(!noSubs.toLowerCase().includes('renewal'), 'no renewal line at all when nothing is due');
  }

  // ==================== correlation insight functions (pure) ====================
  {
    function mkTs(y, m, d, h) { return new Date(y, m - 1, d, h, 0, 0).getTime(); }
    function dk(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

    // ---- caffeine/sleep ----
    {
      const cafLogs = [];
      const morning = {};
      // 6 days with late (>=2pm) caffeine the day before -> worse sleep next morning
      for (let i = 0; i < 6; i++) {
        const day = 1 + i;
        cafLogs.push({ ts: mkTs(2026, 1, day, 15) }); // 3pm
        morning[dk(2026, 1, day + 1)] = { sleepQuality: 2 };
      }
      // 6 days with no late caffeine -> better sleep next morning
      for (let i = 0; i < 6; i++) {
        const day = 20 + i;
        morning[dk(2026, 1, day + 1)] = { sleepQuality: 4 };
      }
      const insight = computeCaffeineSleepInsight({ 'caf:logs': cafLogs }, { 'sleep:nights': morning });
      assertTrue(!!insight, 'enough samples on both sides produces a caffeine/sleep insight');
      assertEq(insight.avgWith, 2, 'average sleep quality after late caffeine');
      assertEq(insight.avgWithout, 4, 'average sleep quality without late caffeine');

      const tooFew = computeCaffeineSleepInsight(
        { 'caf:logs': [{ ts: mkTs(2026, 1, 1, 15) }] },
        { 'sleep:nights': { [dk(2026, 1, 2)]: { sleepQuality: 2 } } }
      );
      assertEq(tooFew, null, 'below the minimum sample size on either side returns null');

      const earlyOnly = computeCaffeineSleepInsight(
        { 'caf:logs': [{ ts: mkTs(2026, 1, 1, 9) }] }, // 9am, not "late"
        { 'sleep:nights': {} }
      );
      assertEq(earlyOnly, null, 'caffeine before 2pm is not counted as "late"');
    }

    // ---- gym/checkin ----
    {
      const doneDays = {};
      const checkins = [];
      for (let i = 0; i < 6; i++) {
        const dateKey = dk(2026, 2, 1 + i);
        doneDays[dateKey] = true;
        checkins.push({ dateKey, feeling: 5, stress: 1 });
      }
      for (let i = 0; i < 6; i++) {
        const dateKey = dk(2026, 2, 20 + i);
        checkins.push({ dateKey, feeling: 2, stress: 4 });
      }
      const gymData = { po_coach_workout_done: doneDays };
      const peakData = { 'peak:checkins': checkins };
      const feelingInsight = computeGymCheckinInsight(gymData, peakData, 'feeling');
      assertTrue(!!feelingInsight, 'enough samples on both sides produces a feeling insight');
      assertEq(feelingInsight.avgWith, 5, 'average feeling on gym days');
      assertEq(feelingInsight.avgWithout, 2, 'average feeling on non-gym days');

      const stressInsight = computeGymCheckinInsight(gymData, peakData, 'stress');
      assertEq(stressInsight.avgWith, 1, 'average stress on gym days');
      assertEq(stressInsight.avgWithout, 4, 'average stress on non-gym days');
    }

    // ---- computeActionableInsight priority + gating ----
    {
      const cafLogs = [];
      const morning = {};
      for (let i = 0; i < 6; i++) {
        cafLogs.push({ ts: mkTs(2026, 3, 1 + i, 15) });
        morning[dk(2026, 3, 2 + i)] = { sleepQuality: 2 };
      }
      for (let i = 0; i < 6; i++) morning[dk(2026, 3, 21 + i)] = { sleepQuality: 4 };
      const caffeineData = { 'caf:logs': cafLogs };
      const sleepData = { 'sleep:nights': morning };

      const line = computeActionableInsight(caffeineData, sleepData, {}, {}, false);
      assertTrue(!!line && line.toLowerCase().includes('caffeine'), 'caffeine/sleep pattern surfaces as an actionable line');

      const none = computeActionableInsight({}, {}, {}, {}, false);
      assertEq(none, null, 'no insight at all when there is not enough history either way');

      // Gym/mood pattern, but a workout is already logged today -> no nudge.
      const doneDays = {}; const checkins = [];
      for (let i = 0; i < 6; i++) { const dateKey = dk(2026, 4, 1 + i); doneDays[dateKey] = true; checkins.push({ dateKey, feeling: 5 }); }
      for (let i = 0; i < 6; i++) { const dateKey = dk(2026, 4, 20 + i); checkins.push({ dateKey, feeling: 2 }); }
      const gymData = { po_coach_workout_done: doneDays };
      const peakData2 = { 'peak:checkins': checkins };
      const suppressed = computeActionableInsight({}, {}, peakData2, gymData, true);
      assertEq(suppressed, null, 'gym/mood nudge is suppressed once a workout is already logged today');
      const shown = computeActionableInsight({}, {}, peakData2, gymData, false);
      assertTrue(!!shown && shown.toLowerCase().includes('workout'), 'gym/mood nudge shows when no workout is logged yet today');
    }
  }

  // ==================== drift detection (pure) ====================
  {
    function datesBack(n, todayPlain) {
      const [y, m, d] = todayPlain.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      const out = [];
      for (let i = 0; i < n; i++) {
        out.push(dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0'));
        dt.setDate(dt.getDate() - 1);
      }
      return out;
    }

    const todayPlain = '2026-03-15';
    const dateKeys = datesBack(60, todayPlain); // most-recent-first, index 0 = today

    // ---- computeDriftDayRows ----
    {
      const goalsData = {
        'habits:defs': [{ id: 'h1' }, { id: 'h2' }],
        'habits:log': { h1: { [dateKeys[0]]: true } },
      };
      goalsData['goals:' + dateKeys[0]] = [{ text: 'a', done: true }, { text: 'b', done: false }];
      const gymData = { po_coach_workout_done: { [dateKeys[0]]: true } };
      const sleepData = { 'sleep:nights': { [dateKeys[0]]: { sleepQuality: 3 } } };
      const rows = computeDriftDayRows(dateKeys.slice(0, 2), goalsData, gymData, sleepData);
      assertEq(rows[0].workoutDone, 1, 'a logged workout day is 1');
      assertEq(rows[1].workoutDone, 0, 'a day with no logged workout is 0');
      assertEq(rows[0].habitRate, 0.5, 'habitRate reflects 1 of 2 habits done');
      assertEq(rows[0].todoRate, 0.5, 'todoRate reflects 1 of 2 to-dos done');
      assertEq(rows[0].sleepQuality, 3, 'sleepQuality is carried through from the morning entry');
      assertEq(rows[1].sleepQuality, null, 'a day with no morning entry has a null sleepQuality');
    }

    // ---- a real drift: workouts + habit completion both stop recently ----
    {
      const goalsData = { 'habits:defs': [{ id: 'h1' }], 'habits:log': { h1: {} } };
      const gymData = { po_coach_workout_done: {} };
      const sleepData = { 'sleep:nights': {} };
      // Baseline (days 14-59 back, 46 days): workout and habit done every day.
      for (let i = 14; i < 60; i++) {
        gymData.po_coach_workout_done[dateKeys[i]] = true;
        goalsData['habits:log'].h1[dateKeys[i]] = true;
      }
      // Recent (days 0-13): neither logged at all.
      const dayRows = computeDriftDayRows(dateKeys, goalsData, gymData, sleepData);
      const drifted = computeDrift(dayRows);
      assertTrue(drifted.length >= 2, 'both workouts and habit completion are flagged as drifted');
      assertTrue(drifted.some(d => d.field === 'workoutDone'), 'workout rate is one of the drifted metrics');
      assertTrue(drifted.some(d => d.field === 'habitRate'), 'habit rate is one of the drifted metrics');

      const insight = computeDriftInsight(dayRows);
      assertTrue(!!insight && insight.toLowerCase().includes('drifted'), 'a real multi-metric drift produces a one-line insight');
    }

    // ---- no drift: recent matches baseline ----
    {
      const goalsData = { 'habits:defs': [{ id: 'h1' }], 'habits:log': { h1: {} } };
      const gymData = { po_coach_workout_done: {} };
      const sleepData = { 'sleep:nights': {} };
      dateKeys.forEach(k => { gymData.po_coach_workout_done[k] = true; goalsData['habits:log'].h1[k] = true; });
      const dayRows = computeDriftDayRows(dateKeys, goalsData, gymData, sleepData);
      assertEq(computeDrift(dayRows).length, 0, 'no metrics are flagged when recent matches baseline');
      assertEq(computeDriftInsight(dayRows), null, 'no insight at all when nothing has drifted');
    }

    // ---- only one metric drifting: not enough on its own to call it "drift" ----
    {
      const goalsData = { 'habits:defs': [{ id: 'h1' }], 'habits:log': { h1: {} } };
      const gymData = { po_coach_workout_done: {} };
      const sleepData = { 'sleep:nights': {} };
      for (let i = 14; i < 60; i++) { gymData.po_coach_workout_done[dateKeys[i]] = true; goalsData['habits:log'].h1[dateKeys[i]] = true; }
      // Habit completion stays intact through the recent window too; only workouts drop.
      for (let i = 0; i < 14; i++) goalsData['habits:log'].h1[dateKeys[i]] = true;
      const dayRows = computeDriftDayRows(dateKeys, goalsData, gymData, sleepData);
      const drifted = computeDrift(dayRows);
      assertEq(drifted.length, 1, 'only the workout metric alone is flagged as drifted');
      assertEq(computeDriftInsight(dayRows), null, 'a single drifted metric alone does not produce an insight (avoids single-metric noise)');
    }

    // ---- too few samples on either side ----
    {
      const goalsData = {}; const gymData = { po_coach_workout_done: {} }; const sleepData = { 'sleep:nights': {} };
      gymData.po_coach_workout_done[dateKeys[0]] = true;
      gymData.po_coach_workout_done[dateKeys[1]] = true;
      gymData.po_coach_workout_done[dateKeys[20]] = true;
      const dayRows = computeDriftDayRows(dateKeys, goalsData, gymData, sleepData);
      assertEq(computeDrift(dayRows).length, 0, 'too few logged days on either side of a metric excludes it rather than guessing');
    }
  }

  // ==================== composeMorningBriefing driftInsight param ====================
  {
    const withDrift = composeMorningBriefing(['Gym'], null, 0, null, 'Test drift line.');
    assertTrue(withDrift.includes('🌊 Test drift line.'), 'a drift insight is appended as its own line');
    const withoutDrift = composeMorningBriefing(['Gym'], null, 0, null, null);
    assertTrue(!withoutDrift.includes('🌊'), 'no drift line at all when none is passed');
    const withBoth = composeMorningBriefing(['Gym'], null, 0, 'Actionable line.', 'Drift line.');
    assertTrue(withBoth.includes('💡 Actionable line.') && withBoth.includes('🌊 Drift line.'), 'both insight lines can appear together, each on its own line');
  }

  // ==================== composeMorningBriefing actionableInsight param ====================
  {
    const withInsight = composeMorningBriefing(['Gym'], null, 0, 'Test insight line.');
    assertTrue(withInsight.includes('💡 Test insight line.'), 'an actionable insight is appended as its own line');
    const withoutInsight = composeMorningBriefing(['Gym'], null, 0, null);
    assertTrue(!withoutInsight.includes('💡'), 'no insight line at all when none is passed');
  }

  // ==================== full handler integration ====================
  {
    const unfreeze = freezeClockAt(8, 0); // 08:00 UTC — past the default 07:00 briefing time, well before bedtime
    try {
      process.env.TELEGRAM_BOT_TOKEN = 'tok'; process.env.TELEGRAM_CHAT_ID = '123';
      process.env.SUPABASE_URL = 'https://fake.supabase.co'; process.env.SUPABASE_ANON_KEY = 'anon';
      process.env.REMINDER_TIMEZONE = 'UTC';
      process.env.BEDTIME_LOCAL = '23:59';
      delete process.env.MORNING_BRIEFING_TIME; // exercise the 07:00 default
      delete process.env.CRON_SECRET;

      let sentText = null;
      let writtenState = null;
      const rows = {
        goals: { 'recur:defs': [{ name: 'Gym', freq: 'daily' }] },
        sleep: { 'sleep:nights': {} },
        // __energy_nudge__ pre-cooled-down — this test is about the morning
        // briefing, and 8am with no caffeine logged is exactly the kind of
        // moment the reactive low-energy nudge is designed to fire in.
        reminder_state: { [new Date().toISOString().slice(0, 10)]: { __energy_nudge__: { lastMinutes: 8 * 60 } } },
      };
      global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.includes('/rest/v1/app_state')) {
          if (!opts || !opts.method) {
            // The inactivity-nudge check's all-rows query has no "key=eq."
            // filter at all — return no rows, which keeps
            // computeDaysSinceActivity/shouldSendInactivityNudge a no-op so
            // this integration test stays focused on the morning briefing.
            const m = u.match(/key=eq\.([^&]+)/);
            if (!m) return { ok: true, json: async () => [] };
            const key = decodeURIComponent(m[1]);
            return { ok: true, json: async () => [{ data: rows[key] || null }] };
          }
          const body = JSON.parse(opts.body);
          rows[body.key] = body.data;
          if (body.key === 'reminder_state') writtenState = body.data;
          return { ok: true, json: async () => ({}) };
        }
        if (u.includes('sendMessage')) { sentText = JSON.parse(opts.body).text; return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) }; }
        throw new Error('unexpected fetch: ' + u);
      };

      const res = mockRes();
      await handler({ headers: {} }, res);
      assertEq(res._status, 200, 'full handler returns 200');
      assertEq(res._body.sent, true, 'full handler sends the morning briefing once its time has arrived');
      assertTrue(!!sentText && sentText.includes('Gym'), 'the briefing message lists the undone recurring item for today');
      assertTrue(res._body.results.some(r => r.name === '__morning_briefing__'), 'result is tagged distinctly as the morning briefing');
      assertTrue(!!writtenState && Object.values(writtenState)[0].__morning_briefing__ === true, 'the sent flag is persisted so it does not repeat');

      // A second tick the same day must NOT resend.
      const res2 = mockRes();
      sentText = null;
      await handler({ headers: {} }, res2);
      assertEq(res2._body.sent, false, 'a second tick the same day does not resend the briefing');
      assertEq(sentText, null, 'no message was actually sent the second time');
    } finally {
      unfreeze();
    }
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
