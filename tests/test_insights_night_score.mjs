// Standalone verification of insights.html's Night Score logic — the
// evening/night counterpart to index.html's Today Score. insights.html has
// no module exports (browser-global IIFE), so this duplicates the exact
// functions to test them in isolation — same approach as
// test_insights_bottleneck.mjs / test_insights_predictive.mjs.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

const NIGHT_SCORE_TARGET_HOURS = 8;
const NIGHT_SCORE_WINDOW_DAYS = 7;

function tierForNightScore(s) {
  if (s >= 85) return 'Restorative night';
  if (s >= 65) return 'Solid night';
  if (s >= 45) return 'Rough night';
  return 'Wrecked night';
}

function computeNightScore(dayRow, caffeineTracked) {
  if (dayRow.sleepHours == null && dayRow.sleepQuality == null) return null;
  const parts = [];
  if (dayRow.sleepHours != null) parts.push({ weight: 35, ratio: Math.min(1, dayRow.sleepHours / NIGHT_SCORE_TARGET_HOURS) });
  if (dayRow.sleepQuality != null) parts.push({ weight: 35, ratio: dayRow.sleepQuality / 5 });
  if (caffeineTracked) parts.push({ weight: 30, ratio: dayRow.factors.lateCaffeine ? 0 : 1 });
  const weightTotal = parts.reduce((a, p) => a + p.weight, 0);
  const weightedSum = parts.reduce((a, p) => a + p.ratio * p.weight, 0);
  return Math.round((weightedSum / weightTotal) * 100);
}

function computeNightScoreTrend(dayRows, caffeineTracked, windowDays) {
  const scores = dayRows.slice(0, windowDays).map(r => computeNightScore(r, caffeineTracked)).filter(s => s != null);
  if (!scores.length) return null;
  return { latest: scores[0], avg: avg(scores), n: scores.length };
}

// ==================== tierForNightScore ====================
{
  assertEq(tierForNightScore(90), 'Restorative night', 'a 90 score is Restorative');
  assertEq(tierForNightScore(85), 'Restorative night', 'the boundary (85) is Restorative, inclusive');
  assertEq(tierForNightScore(84), 'Solid night', 'just under the boundary (84) is Solid');
  assertEq(tierForNightScore(45), 'Rough night', 'the lower boundary (45) is Rough, inclusive');
  assertEq(tierForNightScore(10), 'Wrecked night', 'a very low score is Wrecked');
}

// ==================== computeNightScore ====================
{
  // Perfect night: full target sleep hours, perfect quality, no late caffeine, caffeine tracked.
  const perfect = { sleepHours: 8, sleepQuality: 5, factors: { lateCaffeine: false } };
  assertEq(computeNightScore(perfect, true), 100, 'a perfect night with caffeine tracked scores 100');

  // Same night, but caffeine usage is never tracked at all -> that dimension is dropped entirely,
  // not scored as a penalty or a bonus.
  assertEq(computeNightScore(perfect, false), 100, 'dropping the untracked caffeine dimension does not change a perfect score');

  // Late caffeine logged, everything else perfect, caffeine IS tracked -> dimension counts against it.
  const lateCaf = { sleepHours: 8, sleepQuality: 5, factors: { lateCaffeine: true } };
  const lateCafScore = computeNightScore(lateCaf, true);
  assertTrue(lateCafScore < 100, 'late caffeine drags the score down when caffeine is actually tracked');
  assertEq(lateCafScore, Math.round((35 + 35) / 100 * 100), 'late caffeine contributes 0 of its 30-weight share, scoring exactly the remaining 70/100 of weight earned in full');

  // Oversleeping (more than target hours) is capped at 1.0 ratio, not rewarded further.
  const oversleep = { sleepHours: 11, sleepQuality: 5, factors: { lateCaffeine: false } };
  assertEq(computeNightScore(oversleep, true), 100, 'sleep hours beyond the target are capped, not scored above 100');

  // Only sleep quality logged (no hours), perfect quality + no late caffeine -> still 100
  // even with only 2 of 3 possible dimensions present (missing dimensions are dropped, not zeroed).
  const perfectQualityOnly = { sleepHours: null, sleepQuality: 5, factors: { lateCaffeine: false } };
  assertEq(computeNightScore(perfectQualityOnly, true), 100, 'perfect quality plus no late caffeine nets 100 with only 2 of 3 dimensions present');

  // Only sleep quality logged, imperfect (4/5), caffeine untracked -> the ONLY dimension counted
  // is quality itself, so the score is exactly that ratio.
  const partialQualityOnly = { sleepHours: null, sleepQuality: 4, factors: { lateCaffeine: false } };
  assertEq(computeNightScore(partialQualityOnly, false), 80, 'with only sleep quality present and caffeine untracked, the score is exactly the quality ratio (4/5 = 80)');

  // No sleep data logged at all -> no night score, regardless of caffeine.
  assertEq(computeNightScore({ sleepHours: null, sleepQuality: null, factors: { lateCaffeine: false } }, true), null, 'no sleep hours or quality logged at all returns null rather than a fake score');
}

// ==================== computeNightScoreTrend ====================
{
  const dayRows = [];
  // Most-recent-first: last night was rough (poor sleep), the 6 nights before were solid.
  dayRows.push({ sleepHours: 5, sleepQuality: 2, factors: { lateCaffeine: true } });
  for (let i = 0; i < 6; i++) dayRows.push({ sleepHours: 8, sleepQuality: 5, factors: { lateCaffeine: false } });
  // An 8th day beyond the 7-night window that should NOT affect the trend.
  dayRows.push({ sleepHours: 1, sleepQuality: 1, factors: { lateCaffeine: true } });

  const trend = computeNightScoreTrend(dayRows, true, NIGHT_SCORE_WINDOW_DAYS);
  assertTrue(!!trend, 'a mix of logged nights produces a trend');
  assertEq(trend.n, 7, 'only the windowDays most recent nights are counted, not the whole array');
  assertTrue(trend.latest < trend.avg, "last night's rough score is below the 7-night average pulled up by better nights");

  assertEq(computeNightScoreTrend([{ sleepHours: null, sleepQuality: null, factors: { lateCaffeine: false } }], true, 7), null, 'no logged nights at all in the window returns null');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
