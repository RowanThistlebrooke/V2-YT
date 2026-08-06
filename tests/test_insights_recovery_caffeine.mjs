// Verifies insights-recovery.html's late-caffeine fix: a caffeine log is
// "late" relative to whichever SLEEP SESSION it falls in the evening
// before, not the calendar date it happens to be logged on. sleep:nights
// is keyed by the WAKE-UP date, so the old code (checking "late caffeine
// logged on the wake-up date itself") checked the wrong day — caffeine at
// 11pm the night before (the common case) landed on the prior calendar
// date and was invisible, silently awarding a false clean-caffeine boost.
//
// insights-recovery.html has no module exports (browser-global IIFE), so
// this duplicates the exact functions to test them in isolation, mirroring
// this repo's established approach for testing embedded-HTML pure logic
// without a DOM. It deliberately reuses the SAME timestamps as
// tests/test_telegram_sleep_recap.mjs's equivalent cases (adjusted for
// this page running in local/browser time rather than an explicit tz())
// so both surfaces can be checked against the same scenarios.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- Duplicated from insights-recovery.html ----
function pad2(n) { return String(n).padStart(2, '0'); }
function dateKeyFromDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function nextDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const cursor = new Date(y, m - 1, d);
  cursor.setDate(cursor.getDate() + 1);
  return dateKeyFromDate(cursor);
}
const LATE_CAFFEINE_EVENING_HOUR = 14;
const LATE_CAFFEINE_MORNING_HOUR = 6;
function lateCaffeineSleepSessionDays(cafLogs) {
  const days = new Set();
  (cafLogs || []).forEach(l => {
    if (!l || !l.ts) return;
    const d = new Date(l.ts);
    const h = d.getHours();
    const dateKey = dateKeyFromDate(d);
    if (h >= LATE_CAFFEINE_EVENING_HOUR) days.add(nextDateKey(dateKey));
    else if (h < LATE_CAFFEINE_MORNING_HOUR) days.add(dateKey);
  });
  return days;
}

// This test process's local TZ (set by the CI runner / this sandbox) is
// used implicitly via `new Date(ts).getHours()`, exactly like the real
// page does in a browser — so timestamps here are constructed as LOCAL
// Date field values (not epoch ms), keeping the test independent of
// whatever TZ the runner happens to be in.

// ---- Tests: the exact bug — caffeine the evening before must be caught ----

{
  const wakeUpDate = '2026-03-10';
  const eveningBefore = new Date(2026, 2, 9, 23, 0).getTime(); // 2026-03-09 23:00 local
  const days = lateCaffeineSleepSessionDays([{ ts: eveningBefore }]);
  assertTrue(days.has(wakeUpDate), 'caffeine logged the evening before a wake-up (11pm the prior night) is caught as late for that wake-up\'s sleep session — the exact bug this fix addresses');
}

{
  // The OLD bug's exact failure mode, made explicit: checking the
  // caffeine's own log date against the wake-up date directly would find
  // NO match, since the log's own date is the day before.
  const eveningBefore = new Date(2026, 2, 9, 23, 0).getTime();
  const days = lateCaffeineSleepSessionDays([{ ts: eveningBefore }]);
  assertTrue(!days.has('2026-03-09'), 'the late-caffeine flag lands on the NEXT day\'s sleep session, not the caffeine log\'s own calendar date (that would be the old, wrong day)');
}

{
  // After midnight, before a typical wake-up: still counts against the
  // same session.
  const earlyMorning = new Date(2026, 2, 10, 2, 0).getTime(); // 2am
  const days = lateCaffeineSleepSessionDays([{ ts: earlyMorning }]);
  assertTrue(days.has('2026-03-10'), 'caffeine logged after midnight but before a typical wake-up counts as late for that same day\'s session');
}

{
  // Ordinary daytime caffeine (mid-morning through early afternoon) is not
  // late for anything.
  const midday = new Date(2026, 2, 10, 10, 0).getTime();
  const days = lateCaffeineSleepSessionDays([{ ts: midday }]);
  assertEq([...days], [], 'ordinary daytime caffeine (10am) is not flagged as late for any sleep session');
}

{
  // Exactly at the 2pm boundary counts as late (>=), one minute before does not.
  const exactly2pm = new Date(2026, 2, 10, 14, 0).getTime();
  const oneMinuteBefore = new Date(2026, 2, 10, 13, 59).getTime();
  assertTrue(lateCaffeineSleepSessionDays([{ ts: exactly2pm }]).has('2026-03-11'), 'exactly 2:00pm is already "late" (inclusive boundary)');
  assertTrue(!lateCaffeineSleepSessionDays([{ ts: oneMinuteBefore }]).has('2026-03-11'), '1:59pm is not yet "late"');
}

{
  // Exactly at the 6am boundary is no longer "late" (the early-morning
  // window is [midnight, 6am) — exclusive at the top).
  const exactly6am = new Date(2026, 2, 10, 6, 0).getTime();
  const oneMinuteBefore6am = new Date(2026, 2, 10, 5, 59).getTime();
  assertTrue(!lateCaffeineSleepSessionDays([{ ts: exactly6am }]).has('2026-03-10'), '6:00am is no longer part of the "still last night" window');
  assertTrue(lateCaffeineSleepSessionDays([{ ts: oneMinuteBefore6am }]).has('2026-03-10'), '5:59am is still part of the "still last night" window');
}

// ---- Tests: nextDateKey (pure) ----

assertEq(nextDateKey('2026-01-31'), '2026-02-01', 'nextDateKey rolls over a month boundary');
assertEq(nextDateKey('2026-12-31'), '2027-01-01', 'nextDateKey rolls over a year boundary');
assertEq(nextDateKey('2028-02-28'), '2028-02-29', 'nextDateKey lands on the leap day in a leap year');

// ---- Tests: multiple caffeine logs across several nights don't collide ----

{
  const logs = [
    { ts: new Date(2026, 5, 1, 22, 0).getTime() },  // late June 1 -> flags June 2
    { ts: new Date(2026, 5, 3, 1, 0).getTime() },    // early June 3 -> flags June 3
    { ts: new Date(2026, 5, 5, 9, 0).getTime() },    // daytime June 5 -> flags nothing
  ];
  const days = lateCaffeineSleepSessionDays(logs);
  assertEq([...days].sort(), ['2026-06-02', '2026-06-03'], 'multiple caffeine logs across several days each resolve to their own correct sleep-session date, with no cross-contamination');
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---\n');
if (fail > 0) process.exit(1);
