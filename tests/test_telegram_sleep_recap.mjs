// The wake-up Sleep Recap ports insights-recovery.html's Night Score
// formula exactly (computeNightScore/tierForNightScore) so a number read
// out over Telegram always matches what the dashboard's own gauge would
// show for the same night — these tests pin that formula down directly,
// then verify buildSleepRecap()'s formatting/trend/tip logic on top of it,
// and finally that execLogMorningCheckin actually wires a `recap` into its
// tool result end to end.
import {
  TOOL_EXECUTORS, computeNightScore, tierForNightScore, formatSleepDuration,
  buildSleepRecap, dateKeyFor, hourFor, plainDateKey,
  dayKeysBackFrom, nextDateKey, lateCaffeineSleepSessionDays,
} from '../api/telegram-webhook.js';

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
        const key = decodeURIComponent(u.match(/key=eq\.([^&]+)/)[1]);
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

  // ==================== computeNightScore (pinned against insights-recovery.html's formula) ====================
  {
    process.env.REMINDER_TIMEZONE = 'UTC';
    assertEq(computeNightScore(null, null, false, false), null, 'no hours and no quality logged scores as null, not zero');
    // 8h/8h target -> ratio 1, weight 35; quality 5/5 -> ratio 1, weight 35;
    // caffeine untracked -> that 30-weight part is excluded entirely, so the
    // remaining two parts (70 total weight) are renormalized to 100.
    assertEq(computeNightScore(8, 5, false, false), 100, 'a full 8h + perfect quality scores 100 when caffeine is not tracked at all');
    // Same inputs, but caffeine IS tracked and no late caffeine -> all three
    // parts present, still all ratio 1 -> still 100.
    assertEq(computeNightScore(8, 5, false, true), 100, 'a full night stays 100 once caffeine is tracked and none was late');
    // Late caffeine drags the caffeine part's ratio to 0: (35+35+0)/100 = 70.
    assertEq(computeNightScore(8, 5, true, true), 70, 'late caffeine costs exactly its 30-point weight');
    // Half the target hours (4/8 = 0.5 ratio), perfect quality, caffeine untracked:
    // (35*0.5 + 35*1) / 70 * 100 = 75.
    assertEq(computeNightScore(4, 5, false, false), 75, 'partial sleep hours scale linearly against the 8h target');
    // Hours-only (no quality logged): only the hours part counts, fully renormalized.
    assertEq(computeNightScore(8, null, false, false), 100, 'hours alone can still produce a full score if quality was not logged');
    assertEq(computeNightScore(6, null, false, false), 75, 'hours alone scale correctly with no quality part diluting it (6/8 = 75)');
    // Oversleeping doesn't push the ratio above 1 (Math.min(1, ...)).
    assertEq(computeNightScore(11, 5, false, false), 100, 'sleep hours are capped at the target ratio, not rewarded for oversleeping');
  }

  // ==================== tierForNightScore tier boundaries ====================
  {
    assertEq(tierForNightScore(100), 'Restorative night', '100 is Restorative');
    assertEq(tierForNightScore(85), 'Restorative night', '85 is the Restorative floor');
    assertEq(tierForNightScore(84), 'Solid night', '84 falls just short of Restorative');
    assertEq(tierForNightScore(65), 'Solid night', '65 is the Solid floor');
    assertEq(tierForNightScore(64), 'Rough night', '64 falls just short of Solid');
    assertEq(tierForNightScore(45), 'Rough night', '45 is the Rough floor');
    assertEq(tierForNightScore(44), 'Wrecked night', '44 falls into Wrecked');
    assertEq(tierForNightScore(0), 'Wrecked night', '0 is Wrecked');
  }

  // ==================== formatSleepDuration ====================
  {
    assertEq(formatSleepDuration(null), null, 'no hours formats as null, not "0h"');
    assertEq(formatSleepDuration(8), '8h', 'a whole number of hours omits the minutes segment');
    assertEq(formatSleepDuration(7.5), '7h 30m', 'a half hour formats with minutes');
    assertEq(formatSleepDuration(6.25), '6h 15m', 'a quarter hour rounds cleanly');
    assertEq(formatSleepDuration(0.98), '0h 59m', 'sub-hour durations still format sensibly');
  }

  // ==================== dateKeyFor / hourFor (timezone-aware, mirrors tzNow()/plainDateKey()) ====================
  {
    process.env.REMINDER_TIMEZONE = 'America/New_York';
    // 2026-01-15T04:30:00Z is 2026-01-14 23:30 in New York (EST, UTC-5) —
    // both the date AND the hour must roll back across the UTC day boundary.
    const ts = Date.UTC(2026, 0, 15, 4, 30);
    assertEq(dateKeyFor(ts), '2026-01-14', 'dateKeyFor converts to the configured timezone, not UTC, across a day boundary');
    assertEq(hourFor(ts), 23, 'hourFor converts to the configured timezone, not UTC, across a day boundary');
    process.env.REMINDER_TIMEZONE = 'UTC';
  }

  // ==================== buildSleepRecap ====================
  {
    process.env.REMINDER_TIMEZONE = 'UTC';
    const today = plainDateKey();

    assertEq(buildSleepRecap({}, today, { sleepHours: null, sleepQuality: null }, {}), null, 'no score means no recap at all — nothing to relay');

    const fullNight = buildSleepRecap(
      { [today]: { sleepHours: 8, sleepQuality: 5 } }, today, { sleepHours: 8, sleepQuality: 5 }, {},
    );
    assertTrue(fullNight.includes('Score 100 (Restorative night)'), 'a perfect first-ever-logged night reports a 100 score with its tier');
    assertTrue(fullNight.includes('8h'), 'the recap states the duration');
    assertTrue(fullNight.includes('Quality 5/5'), 'the recap states the quality rating');
    assertTrue(!fullNight.includes('💡'), 'a maxed-out score does not get a nagging tip');
    assertTrue(!fullNight.includes('night avg'), 'a single-night history does not claim a multi-night trend');

    // A full, CONSECUTIVE 7-night history ending on a fixed date (not
    // plainDateKey(), which moves with the real clock) so the trailing-
    // window math is exercised against a known, controllable "today".
    const fixedToday = '2026-01-07';
    const nights = {};
    ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06'].forEach((k) => {
      nights[k] = { sleepHours: 6, sleepQuality: 3 }; // consistent below-target nights
    });
    nights[fixedToday] = { sleepHours: 5, sleepQuality: 2 }; // tonight is the worst of the bunch
    const trended = buildSleepRecap(nights, fixedToday, nights[fixedToday], {});
    assertTrue(/7-night avg: \d+/.test(trended), 'a full 7-night history reports the trend average');
    assertTrue(!trended.includes('of 7 nights logged'), 'a FULL 7-night window omits the partial-coverage caveat entirely');
    assertTrue(trended.includes('Sleep debt this week:'), 'a multi-night history reports running sleep debt against the 8h target');
    assertTrue(trended.includes('💡'), 'a below-target night gets an actionable tip');

    // Tip targets whichever factor is weakest: hours vs quality vs caffeine.
    const hoursWeak = buildSleepRecap({}, today, { sleepHours: 4, sleepQuality: 5 }, {});
    assertTrue(hoursWeak.includes('closer to 8h'), 'when hours are the weak point, the tip is about hours');

    const qualityWeak = buildSleepRecap({}, today, { sleepHours: 8, sleepQuality: 2 }, {});
    assertTrue(qualityWeak.includes('quality was the biggest drag'), 'when quality is the weak point, the tip is about quality');

    // The night that ends in a wake-up (and check-in) ON 2026-01-20 is the
    // one that started the EVENING BEFORE — so late caffeine that actually
    // dented it is timestamped 2026-01-19, not 2026-01-20 itself.
    const lateCaffeineTs = Date.UTC(2026, 0, 19, 20, 0); // 20:00 UTC Jan 19 — the evening leading into the Jan 20 sleep session
    const caffeineWeak = buildSleepRecap(
      {}, '2026-01-20', { sleepHours: 8, sleepQuality: 5 },
      { 'caf:logs': [{ ts: lateCaffeineTs }] },
    );
    assertTrue(caffeineWeak.includes('Caffeine after 2pm'), 'when late caffeine (evening before) is the weak point, the tip calls it out');

    // Caffeine logged, but not late -> the caffeine part scores full and
    // isn't blamed even though it's the only other tracked factor. Hours
    // low enough (4h) that the score still lands under 85 even with a
    // perfect caffeine factor included, so the tip logic actually fires.
    const earlyCaffeineTs = Date.UTC(2026, 0, 20, 12, 0); // 12:00 UTC on the wake-up day itself, before 14:00 — plain daytime caffeine, not late for anything
    const caffeineOk = buildSleepRecap(
      {}, '2026-01-20', { sleepHours: 4, sleepQuality: 5 },
      { 'caf:logs': [{ ts: earlyCaffeineTs }] },
    );
    assertTrue(caffeineOk.includes('closer to 8h') && !caffeineOk.includes('Caffeine'), 'early caffeine does not get blamed for a low score — hours still is');
  }

  // ==================== Bug fix: late caffeine evaluated against the RIGHT night ====================
  {
    process.env.REMINDER_TIMEZONE = 'UTC';
    // The exact bug: caffeine logged at 11pm the night before a wake-up
    // used to be invisible, because the old code checked whether caffeine
    // was logged ON the wake-up date itself, not the evening leading into
    // it. This must now be caught.
    const beforeMidnightTs = Date.UTC(2026, 2, 9, 23, 0); // 2026-03-09 23:00 UTC
    const beforeMidnight = buildSleepRecap(
      {}, '2026-03-10', { sleepHours: 8, sleepQuality: 5 },
      { 'caf:logs': [{ ts: beforeMidnightTs }] },
    );
    assertTrue(beforeMidnight.includes('Caffeine after 2pm'), 'caffeine logged before midnight (the prior evening) is correctly caught as late for the sleep session that follows — no false clean-caffeine boost');

    // Caffeine logged just AFTER midnight, still before a typical wake-up,
    // must ALSO count against that same session — it's still "overnight
    // before you woke up."
    const afterMidnightTs = Date.UTC(2026, 2, 10, 2, 0); // 2026-03-10 02:00 UTC — 2am, same calendar day as the wake-up
    const afterMidnight = buildSleepRecap(
      {}, '2026-03-10', { sleepHours: 8, sleepQuality: 5 },
      { 'caf:logs': [{ ts: afterMidnightTs }] },
    );
    assertTrue(afterMidnight.includes('Caffeine'), 'caffeine logged after midnight but before a typical wake-up still counts as late for that session');

    // Daytime caffeine on the wake-up day itself (well after any
    // reasonable wake-up, well before that evening) is genuinely unrelated
    // to the sleep session that already happened — must NOT be flagged.
    const middayTs = Date.UTC(2026, 2, 10, 10, 0); // 10am
    const midday = buildSleepRecap(
      {}, '2026-03-10', { sleepHours: 4, sleepQuality: 5 },
      { 'caf:logs': [{ ts: middayTs }] },
    );
    assertTrue(!midday.includes('Caffeine'), 'ordinary daytime caffeine on the wake-up day itself is not blamed for the sleep that already happened');
  }

  // ==================== Bug fix: 7-night average is the actual trailing 7 calendar days ====================
  {
    process.env.REMINDER_TIMEZONE = 'UTC';
    const today = '2026-02-10';

    // The exact bug: nights scattered across an unbounded date range used
    // to get pulled into a "7-night average" just because they were the 7
    // most recently EXISTING keys — even if they were months apart. Two
    // ancient nights plus today must NOT produce a misleading "7-night avg".
    const scattered = {
      '2025-06-01': { sleepHours: 3, sleepQuality: 1 }, // ancient, terrible night — must not drag down "this week"
      '2025-09-15': { sleepHours: 3, sleepQuality: 1 },
      [today]: { sleepHours: 8, sleepQuality: 5 },
    };
    const scatteredRecap = buildSleepRecap(scattered, today, scattered[today], {});
    assertTrue(!/7-night avg/.test(scatteredRecap), 'two nights from months ago plus tonight is only 1 REAL night in the trailing window — not enough for any kind of average, so the line is omitted entirely rather than misleadingly built from scattered history');

    // Missing nights within the real window are represented honestly: a
    // partial window reports exactly how many of the 7 nights had data.
    const partial = {
      [today]: { sleepHours: 8, sleepQuality: 5 },
      '2026-02-09': { sleepHours: 7, sleepQuality: 4 },
      '2026-02-08': { sleepHours: 6, sleepQuality: 3 },
      // 2026-02-07, 02-06, 02-05, 02-04 are all missing entirely.
    };
    const partialRecap = buildSleepRecap(partial, today, partial[today], {});
    assertTrue(partialRecap.includes('7-night avg:') && partialRecap.includes('(3 of 7 nights logged)'), 'a partial window honestly states how many of the 7 nights actually had data, not a silent full-week claim');

    // A full, gapless 7-night window omits the coverage caveat — it IS a
    // true 7-night average, and says so cleanly.
    const full = {};
    dayKeysBackFrom(today, 7).forEach((k) => { full[k] = { sleepHours: 7, sleepQuality: 4 }; });
    const fullRecap = buildSleepRecap(full, today, full[today], {});
    assertTrue(fullRecap.includes('7-night avg:') && !fullRecap.includes('of 7 nights logged'), 'a genuinely complete 7-night window reports a clean average with no partial-coverage caveat');

    // Exactly one logged night (today) is NOT enough to call anything an
    // "average" — the trend line is omitted, distinguishing "not enough
    // data" from a real (even partial) average.
    const onlyToday = { [today]: { sleepHours: 8, sleepQuality: 5 } };
    const onlyTodayRecap = buildSleepRecap(onlyToday, today, onlyToday[today], {});
    assertTrue(!/night avg/.test(onlyTodayRecap), 'a single logged night is "not enough data" for a trend, not a 1-night "average"');

    // Consecutive-nights sanity check: a run of exactly 4 real, adjacent
    // nights inside the window reports "4 of 7", matching the real count.
    const consecutive = {};
    ['2026-02-10', '2026-02-09', '2026-02-08', '2026-02-07'].forEach((k) => { consecutive[k] = { sleepHours: 7, sleepQuality: 4 }; });
    const consecutiveRecap = buildSleepRecap(consecutive, today, consecutive[today], {});
    assertTrue(consecutiveRecap.includes('(4 of 7 nights logged)'), 'a run of exactly 4 consecutive real nights inside the window is reported as 4 of 7, not silently rounded or miscounted');
  }

  // ==================== dayKeysBackFrom / nextDateKey (pure helpers) ====================
  {
    assertEq(dayKeysBackFrom('2026-01-07', 7), ['2026-01-07', '2026-01-06', '2026-01-05', '2026-01-04', '2026-01-03', '2026-01-02', '2026-01-01'], 'dayKeysBackFrom returns the anchor date first, then walks backward one real calendar day at a time');
    assertEq(dayKeysBackFrom('2026-03-02', 5), ['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27', '2026-02-26'], 'dayKeysBackFrom correctly rolls back across a month boundary (non-leap Feb)');
    assertEq(dayKeysBackFrom('2028-03-01', 2), ['2028-03-01', '2028-02-29'], 'dayKeysBackFrom correctly lands on Feb 29 in a leap year');
    assertEq(nextDateKey('2026-01-31'), '2026-02-01', 'nextDateKey rolls over a month boundary');
    assertEq(nextDateKey('2026-12-31'), '2027-01-01', 'nextDateKey rolls over a year boundary');
    assertEq(nextDateKey('2028-02-28'), '2028-02-29', 'nextDateKey lands on the leap day in a leap year');
  }

  // ==================== lateCaffeineSleepSessionDays / DST boundaries ====================
  {
    process.env.REMINDER_TIMEZONE = 'America/New_York';
    // US spring-forward 2026: 2026-03-08 02:00 EST -> 03:00 EDT. A caffeine
    // log logged well before that transition, in the evening, must still
    // resolve to the correct NEXT calendar day's sleep session — the DST
    // jump itself must not shift which civil date it lands on.
    const springEveningTs = Date.UTC(2026, 2, 7, 23, 0); // 2026-03-07 18:00 EST (UTC-5, before the transition)
    const springDays = lateCaffeineSleepSessionDays([{ ts: springEveningTs }]);
    assertTrue(springDays.has('2026-03-08'), 'an evening caffeine log the day before spring-forward still resolves to the correct next-day sleep session');

    // US fall-back 2026: 2026-11-01 02:00 EDT -> 01:00 EST (the 1-2am hour
    // repeats). An early-morning caffeine log around that repeated hour
    // must still land on a sane, single calendar date rather than
    // duplicating or skipping a day.
    const fallMorningTs = Date.UTC(2026, 10, 1, 6, 30); // 2026-11-01 01:30 EST (UTC-5, after "falling back")
    const fallDays = lateCaffeineSleepSessionDays([{ ts: fallMorningTs }]);
    assertEq([...fallDays], ['2026-11-01'], 'an early-morning caffeine log during a fall-back-affected hour resolves to exactly one sane calendar date');

    process.env.REMINDER_TIMEZONE = 'UTC';
  }

  // ==================== execLogMorningCheckin wires a real recap into its tool result ====================
  {
    const fake = makeFakeSupabase({});
    global.fetch = fake.fetchStub;
    process.env.REMINDER_TIMEZONE = 'UTC';
    const result = await TOOL_EXECUTORS.log_morning_checkin({ sleep_hours: 8, sleep_quality: 5 });
    assertEq(result.ok, true, 'log_morning_checkin still succeeds with the recap wiring in place');
    assertTrue(typeof result.recap === 'string' && result.recap.includes('Score 100'), 'the tool result carries a real computed recap, not a placeholder');

    const freshFake = makeFakeSupabase({}); // a separate row — no prior entry to inherit sleepHours/sleepQuality from
    global.fetch = freshFake.fetchStub;
    const empty = await TOOL_EXECUTORS.log_morning_checkin({ wake_time: '07:00' });
    assertEq(empty.recap, null, 'a check-in with neither hours nor quality logged (only wake_time, nothing prior to inherit) carries no recap');
  }

  global.fetch = origFetch;
  console.log('\n---', pass, 'passed,', fail, 'failed ---');
  process.exit(fail > 0 ? 1 : 0);
})();
