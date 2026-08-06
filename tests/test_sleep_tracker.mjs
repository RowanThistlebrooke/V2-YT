// Standalone verification of sleep.html's tracking logic: duration derived
// from clock times or from a live "pending bedtime" tap, the sleep streak,
// and the recent-nights average. sleep.html has no module exports
// (browser-global IIFE), so this duplicates the exact functions to test
// them in isolation, matching this repo's established convention.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertNull(actual, label) {
  if (actual === null) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected: null\n  actual:  ', JSON.stringify(actual)); }
}
function assertClose(actual, expected, tol, label) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected ~:', expected, '\n  actual:   ', actual); }
}

const MAX_TRACKED_SLEEP_HOURS = 16;

function parseClockHours(hhmm) {
  if (!hhmm) return null;
  const parts = hhmm.split(':').map(Number);
  if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
  return parts[0] + parts[1] / 60;
}

function durationFromClocks(bedClock, wakeClock) {
  const bed = parseClockHours(bedClock), wake = parseClockHours(wakeClock);
  if (bed == null || wake == null) return null;
  let dur = wake - bed;
  if (dur <= 0) dur += 24;
  return Math.round(dur * 10) / 10;
}

function durationFromPending(bedTs, nowMs) {
  if (bedTs == null) return null;
  const hours = (nowMs - bedTs) / 3600000;
  if (hours <= 0 || hours > MAX_TRACKED_SLEEP_HOURS) return null;
  return Math.round(hours * 10) / 10;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKeyFromDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayKey(nowMs) { return dateKeyFromDate(new Date(nowMs != null ? nowMs : Date.now())); }
function lastNDateKeys(n, nowMs) {
  const out = [];
  const d = new Date(nowMs != null ? nowMs : Date.now());
  for (let i = 0; i < n; i++) { out.push(dateKeyFromDate(d)); d.setDate(d.getDate() - 1); }
  return out;
}

function sleepStreak(nights, nowMs) {
  const days = new Set(Object.keys(nights || {}).filter(k => nights[k] && nights[k].sleepHours != null));
  let streak = 0;
  const cursor = new Date(nowMs != null ? nowMs : Date.now());
  if (!days.has(dateKeyFromDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dateKeyFromDate(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

function avgField(nights, dateKeys, field) {
  const vals = dateKeys.map(k => nights[k] && nights[k][field]).filter(v => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const DAY = 86400000;
const NOW = new Date('2026-07-25T15:00:00').getTime();

// ==================== parseClockHours ====================
{
  assertClose(parseClockHours('23:30'), 23.5, 0.001, 'a clock time parses to decimal hours');
  assertClose(parseClockHours('07:15'), 7.25, 0.001, 'minutes convert to a fraction of an hour');
  assertNull(parseClockHours(''), 'an empty string is not a valid clock time');
  assertNull(parseClockHours(null), 'a null clock time does not throw');
}

// ==================== durationFromClocks ====================
{
  assertClose(durationFromClocks('23:00', '07:00'), 8, 0.001, 'a bedtime before midnight and a wake after it spans the night correctly');
  assertClose(durationFromClocks('01:00', '09:30'), 8.5, 0.001, 'a bedtime after midnight (already "tomorrow") still computes correctly');
  assertClose(durationFromClocks('22:00', '06:15'), 8.3, 0.001, 'quarter-hour precision is preserved (rounded to the nearest 0.1h)');
  assertNull(durationFromClocks(null, '07:00'), 'a missing bedtime returns null rather than a bogus duration');
  assertNull(durationFromClocks('23:00', null), 'a missing wake time returns null rather than a bogus duration');
}

// ==================== durationFromPending ====================
{
  const bedTs = NOW - 8 * 3600000;
  assertClose(durationFromPending(bedTs, NOW), 8, 0.001, 'elapsed time since a pending bedtime tap computes the tracked duration');
  assertNull(durationFromPending(null, NOW), 'no pending bedtime returns null');
  assertNull(durationFromPending(NOW + 3600000, NOW), 'a bedtime somehow in the future (clock skew) does not report negative sleep');
  assertNull(durationFromPending(NOW - 20 * 3600000, NOW), 'a pending bedtime older than the max-tracked-hours cap is treated as stale, not a false 20h "sleep"');
  assertClose(durationFromPending(NOW - MAX_TRACKED_SLEEP_HOURS * 3600000 + 60000, NOW), MAX_TRACKED_SLEEP_HOURS, 0.05, 'just under the cap still tracks normally');
}

// ==================== sleepStreak ====================
{
  const nights = {
    [todayKey(NOW)]: { sleepHours: 7 },
    [todayKey(NOW - DAY)]: { sleepHours: 8 },
    [todayKey(NOW - 2 * DAY)]: { sleepHours: 6.5 },
    [todayKey(NOW - 4 * DAY)]: { sleepHours: 7 }, // gap at -3 days breaks the streak
  };
  assertEq(sleepStreak(nights, NOW), 3, 'a night logged today counts consecutive nights back through the most recent gap');

  const yesterdayOnly = { [todayKey(NOW - DAY)]: { sleepHours: 7 } };
  assertEq(sleepStreak(yesterdayOnly, NOW), 1, "a night logged yesterday but not yet tonight still counts (tonight isn't over)");

  assertEq(sleepStreak({}, NOW), 0, 'no nights logged at all is a 0 streak, not a crash');

  const brokenToday = { [todayKey(NOW - 3 * DAY)]: { sleepHours: 7 } };
  assertEq(sleepStreak(brokenToday, NOW), 0, 'a night last logged 3 days ago has no current streak');
}

// ==================== lastNDateKeys ====================
{
  const keys = lastNDateKeys(3, NOW);
  assertEq(keys, [todayKey(NOW), todayKey(NOW - DAY), todayKey(NOW - 2 * DAY)], 'lastNDateKeys returns today first, most-recent-first');
}

// ==================== avgField ====================
{
  const nights = {
    a: { sleepHours: 7, sleepQuality: 4 },
    b: { sleepHours: 8, sleepQuality: null },
    c: { sleepHours: null, sleepQuality: 3 },
  };
  assertClose(avgField(nights, ['a', 'b', 'c'], 'sleepHours'), 7.5, 0.001, 'avgField averages only the nights with a real value for that field');
  assertClose(avgField(nights, ['a', 'b', 'c'], 'sleepQuality'), 3.5, 0.001, 'avgField works independently per field');
  assertNull(avgField({}, ['x', 'y'], 'sleepHours'), 'no matching data at all returns null, not NaN');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
