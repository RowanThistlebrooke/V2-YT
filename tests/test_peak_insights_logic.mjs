// Standalone verification of peak.html's correlation-insight algorithms.
// peak.html has no module exports (browser-global IIFE), so this duplicates
// the exact logic from computeCaffeineSleepInsight()/computeSleepStressInsight()
// verbatim, mirroring this repo's established approach for testing
// gym.html/peak.html's pure logic without a DOM (see test_rest_timer_logic.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const INSIGHT_MIN_SAMPLES = 5;
function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dateToKey(dt);
}

function computeCaffeineSleepInsight(cafLogs, morning) {
  const lateCaffeineDays = new Set();
  (cafLogs || []).forEach(l => {
    if (!l.ts) return;
    const d = new Date(l.ts);
    if (d.getHours() >= 14) lateCaffeineDays.add(dateToKey(d));
  });
  const withLate = [], withoutLate = [];
  Object.keys(morning || {}).forEach(dateKey => {
    const q = morning[dateKey] && morning[dateKey].sleepQuality;
    if (!q) return;
    const prevDay = shiftDateKey(dateKey, -1);
    (lateCaffeineDays.has(prevDay) ? withLate : withoutLate).push(q);
  });
  if (withLate.length < INSIGHT_MIN_SAMPLES || withoutLate.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgWith: avg(withLate), avgWithout: avg(withoutLate), nWith: withLate.length, nWithout: withoutLate.length };
}

function computeSleepStressInsight(morning, checkins) {
  const stressByDay = {};
  (checkins || []).forEach(c => {
    if (!c.stress || !c.dateKey) return;
    (stressByDay[c.dateKey] = stressByDay[c.dateKey] || []).push(c.stress);
  });
  const goodSleepStress = [], poorSleepStress = [];
  Object.keys(morning || {}).forEach(dateKey => {
    const q = morning[dateKey] && morning[dateKey].sleepQuality;
    const dayStress = stressByDay[dateKey];
    if (!q || !dayStress || !dayStress.length) return;
    const dayAvgStress = avg(dayStress);
    if (q >= 4) goodSleepStress.push(dayAvgStress);
    else if (q <= 2) poorSleepStress.push(dayAvgStress);
  });
  if (goodSleepStress.length < INSIGHT_MIN_SAMPLES || poorSleepStress.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgGood: avg(goodSleepStress), avgPoor: avg(poorSleepStress), nGood: goodSleepStress.length, nPoor: poorSleepStress.length };
}

// Generalizes the caffeine/sleep and sleep/stress pattern above to a
// different life domain (gym days) — see the equivalent functions in
// peak.html for the full rationale comment.
function computeGymCheckinInsight(doneDays, checkins, checkinField) {
  const byDay = {};
  (checkins || []).forEach(c => {
    if (!c[checkinField] || !c.dateKey) return;
    (byDay[c.dateKey] = byDay[c.dateKey] || []).push(c[checkinField]);
  });
  const withGym = [], withoutGym = [];
  Object.keys(byDay).forEach(dateKey => {
    const dayAvg = avg(byDay[dateKey]);
    ((doneDays || {})[dateKey] ? withGym : withoutGym).push(dayAvg);
  });
  if (withGym.length < INSIGHT_MIN_SAMPLES || withoutGym.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgWith: avg(withGym), avgWithout: avg(withoutGym), nWith: withGym.length, nWithout: withoutGym.length };
}
function computeGymSleepInsight(doneDays, morning) {
  const withGym = [], withoutGym = [];
  Object.keys(morning || {}).forEach(dateKey => {
    const q = morning[dateKey] && morning[dateKey].sleepQuality;
    if (!q) return;
    const prevDay = shiftDateKey(dateKey, -1);
    ((doneDays || {})[prevDay] ? withGym : withoutGym).push(q);
  });
  if (withGym.length < INSIGHT_MIN_SAMPLES || withoutGym.length < INSIGHT_MIN_SAMPLES) return null;
  return { avgWith: avg(withGym), avgWithout: avg(withoutGym), nWith: withGym.length, nWithout: withoutGym.length };
}

// ---- helpers to build test fixtures ----
function keyDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return dateToKey(d); }
function tsAt(daysAgo, hour) { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0); return d.getTime(); }

// ==================== computeCaffeineSleepInsight ====================
{
  assertEq(computeCaffeineSleepInsight([], {}), null, 'returns null with no data at all');

  // Fewer than INSIGHT_MIN_SAMPLES (5) days on one side -> null.
  const morningSmall = {};
  [0, 1, 2].forEach(n => { morningSmall[keyDaysAgo(n)] = { sleepQuality: 3 }; });
  assertEq(computeCaffeineSleepInsight([], morningSmall), null, 'returns null when below the minimum sample size on the "without" side');

  // 5 poor-sleep days each preceded by late caffeine, 5 good-sleep days preceded by none.
  const morning = {};
  [0, 1, 2, 3, 4].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 2 }; });
  [5, 6, 7, 8, 9].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 5 }; });
  const cafLogs = [1, 2, 3, 4, 5].map(n => ({ ts: tsAt(n, 15) })); // 3pm, precedes days 0-4
  const result = computeCaffeineSleepInsight(cafLogs, morning);
  assertTrue(!!result, 'returns a result once both sides have >= 5 samples');
  assertEq(result.avgWith, 2, 'average sleep quality on late-caffeine-preceded days is correct');
  assertEq(result.avgWithout, 5, 'average sleep quality on non-late-caffeine days is correct');
  assertEq(result.nWith, 5, 'sample count for the "with" side is correct');
  assertEq(result.nWithout, 5, 'sample count for the "without" side is correct');

  // Caffeine logged before 2pm must NOT count as "late".
  const earlyOnly = [1, 2, 3, 4, 5].map(n => ({ ts: tsAt(n, 9) }));
  const noLateResult = computeCaffeineSleepInsight(earlyOnly, morning);
  assertEq(noLateResult, null, 'caffeine logged only before 2pm produces no "late caffeine" days, so there aren\'t enough samples on that side');

  // Entries with no ts, or non-numeric ts, are safely ignored.
  const junkLogs = [{ ts: null }, {}, { ts: tsAt(1, 15) }, { ts: tsAt(2, 15) }, { ts: tsAt(3, 15) }, { ts: tsAt(4, 15) }, { ts: tsAt(5, 15) }];
  assertTrue(!!computeCaffeineSleepInsight(junkLogs, morning), 'malformed caffeine log entries are safely skipped, not crashed on');
}

// ==================== computeSleepStressInsight ====================
{
  assertEq(computeSleepStressInsight({}, []), null, 'returns null with no data at all');

  const morning = {};
  [0, 1, 2, 3, 4].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 1 }; });
  [5, 6, 7, 8, 9].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 5 }; });
  const checkins = [];
  [0, 1, 2, 3, 4].forEach(n => checkins.push({ dateKey: keyDaysAgo(n), stress: 5 }));
  [5, 6, 7, 8, 9].forEach(n => checkins.push({ dateKey: keyDaysAgo(n), stress: 1 }));
  const result = computeSleepStressInsight(morning, checkins);
  assertTrue(!!result, 'returns a result once both sides have >= 5 samples');
  assertEq(result.avgPoor, 5, 'average stress on poor-sleep (<=2) days is correct');
  assertEq(result.avgGood, 1, 'average stress on good-sleep (>=4) days is correct');

  // A sleepQuality of exactly 3 (neither good nor poor) must be excluded from both buckets.
  const morningWithMiddle = Object.assign({}, morning);
  morningWithMiddle[keyDaysAgo(10)] = { sleepQuality: 3 };
  const checkinsWithMiddle = checkins.concat([{ dateKey: keyDaysAgo(10), stress: 3 }]);
  const resultMiddle = computeSleepStressInsight(morningWithMiddle, checkinsWithMiddle);
  assertEq(resultMiddle.nGood, 5, 'a sleepQuality of exactly 3 is not counted as "good" (>=4 only)');
  assertEq(resultMiddle.nPoor, 5, 'a sleepQuality of exactly 3 is not counted as "poor" (<=2 only)');

  // A day with multiple check-ins averages its own stress values first.
  const morningMulti = {};
  [0, 1, 2, 3, 4].forEach(n => { morningMulti[keyDaysAgo(n)] = { sleepQuality: 1 }; });
  [5, 6, 7, 8, 9].forEach(n => { morningMulti[keyDaysAgo(n)] = { sleepQuality: 5 }; });
  const checkinsMulti = [];
  [0, 1, 2, 3, 4].forEach(n => {
    checkinsMulti.push({ dateKey: keyDaysAgo(n), stress: 4 });
    checkinsMulti.push({ dateKey: keyDaysAgo(n), stress: 6 }); // day average = 5, matching the single-checkin scenario above
  });
  [5, 6, 7, 8, 9].forEach(n => checkinsMulti.push({ dateKey: keyDaysAgo(n), stress: 1 }));
  const resultMulti = computeSleepStressInsight(morningMulti, checkinsMulti);
  assertEq(resultMulti.avgPoor, 5, 'multiple check-ins on the same day are averaged before being folded into the overall comparison');
}

// ==================== computeGymCheckinInsight ====================
{
  assertEq(computeGymCheckinInsight({}, [], 'feeling'), null, 'returns null with no data at all');

  const doneDays = {};
  [0, 1, 2, 3, 4].forEach(n => { doneDays[keyDaysAgo(n)] = true; });
  const checkins = [];
  [0, 1, 2, 3, 4].forEach(n => checkins.push({ dateKey: keyDaysAgo(n), feeling: 5, stress: 1 }));
  [5, 6, 7, 8, 9].forEach(n => checkins.push({ dateKey: keyDaysAgo(n), feeling: 2, stress: 4 }));

  const feelingResult = computeGymCheckinInsight(doneDays, checkins, 'feeling');
  assertTrue(!!feelingResult, 'returns a result once both sides have >= 5 samples');
  assertEq(feelingResult.avgWith, 5, 'average feeling on gym days is correct');
  assertEq(feelingResult.avgWithout, 2, 'average feeling on rest days is correct');
  assertEq(feelingResult.nWith, 5, 'sample count for gym days is correct');
  assertEq(feelingResult.nWithout, 5, 'sample count for rest days is correct');

  const stressResult = computeGymCheckinInsight(doneDays, checkins, 'stress');
  assertEq(stressResult.avgWith, 1, 'average stress on gym days is correct, using the same bucketing with a different check-in field');
  assertEq(stressResult.avgWithout, 4, 'average stress on rest days is correct');

  // Below the minimum sample size on one side -> null.
  const fewDoneDays = {};
  [0, 1].forEach(n => { fewDoneDays[keyDaysAgo(n)] = true; });
  const fewCheckins = [0, 1, 2, 3, 4, 5, 6].map(n => ({ dateKey: keyDaysAgo(n), feeling: 3 }));
  assertEq(computeGymCheckinInsight(fewDoneDays, fewCheckins, 'feeling'), null, 'returns null when below the minimum sample size on the gym-days side (only 2 gym days)');

  // A day with a workout logged but no check-in at all contributes to neither bucket.
  const doneDaysExtra = Object.assign({}, doneDays);
  doneDaysExtra[keyDaysAgo(20)] = true; // no matching check-in entry
  const sameResult = computeGymCheckinInsight(doneDaysExtra, checkins, 'feeling');
  assertEq(sameResult.nWith, 5, 'a gym day with no check-in logged does not inflate the sample count');
}

// ==================== computeGymSleepInsight ====================
{
  assertEq(computeGymSleepInsight({}, {}), null, 'returns null with no data at all');

  // Gym on days 1-5 (yesterday relative to each morning entry on days 0-4); rest on days 6-10 (yesterday of mornings 5-9).
  const doneDays = {};
  [1, 2, 3, 4, 5].forEach(n => { doneDays[keyDaysAgo(n)] = true; });
  const morning = {};
  [0, 1, 2, 3, 4].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 5 }; }); // morning after a gym-day evening (prevDay = n+1, which is in doneDays)
  [6, 7, 8, 9, 10].forEach(n => { morning[keyDaysAgo(n)] = { sleepQuality: 2 }; }); // morning after a rest-day evening

  const result = computeGymSleepInsight(doneDays, morning);
  assertTrue(!!result, 'returns a result once both sides have >= 5 samples');
  assertEq(result.avgWith, 5, 'average sleep quality the morning after a gym day is correct');
  assertEq(result.avgWithout, 2, 'average sleep quality the morning after a rest day is correct');
  assertEq(result.nWith, 5, 'sample count for post-gym-day nights is correct');
  assertEq(result.nWithout, 5, 'sample count for post-rest-day nights is correct');

  // A morning entry with no sleepQuality logged is safely skipped.
  const morningWithGap = Object.assign({}, morning);
  morningWithGap[keyDaysAgo(20)] = { sleepQuality: null };
  assertEq(computeGymSleepInsight(doneDays, morningWithGap).nWith + computeGymSleepInsight(doneDays, morningWithGap).nWithout, 10, 'a morning entry with no sleepQuality value does not get counted on either side');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
