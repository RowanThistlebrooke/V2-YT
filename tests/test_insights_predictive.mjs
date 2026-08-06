// Standalone verification of insights.html's predictive engine logic
// (weight projection, sleep debt, burnout risk). insights.html has no
// module exports (browser-global IIFE), so this duplicates the exact
// functions to test them in isolation — same approach as
// test_insights_bottleneck.mjs.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertClose(actual, expected, label, eps) {
  eps = eps == null ? 0.01 : eps;
  if (typeof actual === 'number' && Math.abs(actual - expected) <= eps) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected ~', expected, '\n  actual:  ', actual); }
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

const WEIGHT_MIN_POINTS = 3;
const TARGET_SLEEP_HOURS = 8;
const BURNOUT_TREND_DIFF = { stress: 0.5, sleepQuality: 0.5, consistency: 0.15 };

function computeLinearTrend(points, windowDays) {
  const cutoff = windowDays != null ? Date.now() - windowDays * 86400000 : -Infinity;
  const pts = (points || [])
    .filter(p => p && typeof p.t === 'number' && typeof p.v === 'number' && !isNaN(p.t) && p.t >= cutoff)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 86400000);
  const ys = pts.map(p => p.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const lastX = xs[xs.length - 1];
  return { slopePerDay: slope, currentEstimate: slope * lastX + intercept, n };
}

function weightEntriesToPoints(entries) {
  return (entries || [])
    .filter(e => e && e.dateKey && typeof e.weight === 'number')
    .map(e => ({ t: new Date(e.dateKey).getTime(), v: e.weight }))
    .filter(p => !isNaN(p.t));
}

function computeWeightProjection(weightEntries, windowDays, projectDays) {
  const trend = computeLinearTrend(weightEntriesToPoints(weightEntries), windowDays);
  if (!trend || trend.n < WEIGHT_MIN_POINTS) return null;
  return {
    currentEstimate: trend.currentEstimate,
    slopePerDay: trend.slopePerDay,
    slopePerWeek: trend.slopePerDay * 7,
    projectedValue: trend.currentEstimate + trend.slopePerDay * projectDays,
    projectDays,
    n: trend.n,
  };
}

function computeSleepDebt(dayRows, targetHours) {
  targetHours = targetHours == null ? TARGET_SLEEP_HOURS : targetHours;
  const nights = (dayRows || []).filter(r => typeof r.sleepHours === 'number');
  if (!nights.length) return null;
  const totalDebt = nights.reduce((a, r) => a + Math.max(0, targetHours - r.sleepHours), 0);
  return { totalDebt, nights: nights.length, targetHours, avgDebtPerNight: totalDebt / nights.length };
}

function computeBurnoutRisk(dayRows) {
  const recent = (dayRows || []).slice(0, 7);
  const prior = (dayRows || []).slice(7, 14);
  function avgField(rows, field) {
    const vals = rows.map(r => r[field]).filter(v => v != null);
    return vals.length ? avg(vals) : null;
  }
  const recentStress = avgField(recent, 'outcomeStress');
  const priorStress = avgField(prior, 'outcomeStress');
  const recentSleepQ = avgField(recent, 'sleepQuality');
  const priorSleepQ = avgField(prior, 'sleepQuality');
  const recentConsistency = avgField(recent, 'consistencyRate');
  const priorConsistency = avgField(prior, 'consistencyRate');

  const signals = [];
  if (recentStress != null && priorStress != null && (recentStress - priorStress) >= BURNOUT_TREND_DIFF.stress) {
    signals.push('stress has been trending up this week');
  }
  if (recentSleepQ != null && priorSleepQ != null && (priorSleepQ - recentSleepQ) >= BURNOUT_TREND_DIFF.sleepQuality) {
    signals.push('sleep quality has been trending down this week');
  }
  if (recentConsistency != null && priorConsistency != null && (priorConsistency - recentConsistency) >= BURNOUT_TREND_DIFF.consistency) {
    signals.push('habit/to-do consistency has slipped this week');
  }

  const comparisonsAvailable = [
    recentStress != null && priorStress != null,
    recentSleepQ != null && priorSleepQ != null,
    recentConsistency != null && priorConsistency != null,
  ].filter(Boolean).length;
  if (!comparisonsAvailable) return { level: 'Unknown', signals: [], insufficientData: true };

  const level = signals.length >= 2 ? 'Elevated' : signals.length === 1 ? 'Moderate' : 'Low';
  return { level, signals, insufficientData: false };
}

function computeTimeToGoal(trend, targetValue) {
  if (!trend || targetValue == null || isNaN(targetValue)) return null;
  const diff = targetValue - trend.currentEstimate;
  if (Math.abs(diff) < 1e-9) return { reached: true, onTrack: true, daysNeeded: 0 };
  if (trend.slopePerDay === 0 || Math.sign(trend.slopePerDay) !== Math.sign(diff)) {
    return { reached: false, onTrack: false, daysNeeded: null };
  }
  const daysNeeded = diff / trend.slopePerDay;
  return { reached: false, onTrack: true, daysNeeded, etaDate: new Date(Date.now() + daysNeeded * 86400000) };
}

// ==================== computeLinearTrend ====================
{
  const dayMs = 86400000;
  const t0 = Date.now() - 10 * dayMs;
  // Perfectly linear: value increases by 1 per day, starting at 100.
  const points = [];
  for (let i = 0; i < 10; i++) points.push({ t: t0 + i * dayMs, v: 100 + i });
  const trend = computeLinearTrend(points, 60);
  assertTrue(!!trend, 'a clean linear series produces a trend');
  assertClose(trend.slopePerDay, 1, 'slope is correctly recovered as 1/day');
  assertClose(trend.currentEstimate, 109, 'currentEstimate lands on the trend line at the last point');

  const tooFew = computeLinearTrend([{ t: Date.now(), v: 5 }], 60);
  assertEq(tooFew, null, 'a single point is not enough to fit a trend');

  const outOfWindow = computeLinearTrend([{ t: Date.now() - 200 * dayMs, v: 1 }, { t: Date.now() - 190 * dayMs, v: 2 }], 30);
  assertEq(outOfWindow, null, 'points entirely outside the trailing window are excluded, leaving too few');
}

// ==================== weightEntriesToPoints ====================
{
  const points = weightEntriesToPoints([
    { dateKey: '2026-01-01', weight: 180 },
    { dateKey: '2026-01-05', weight: 179 },
    { bad: 'entry' },
    { dateKey: '2026-01-10' },
  ]);
  assertEq(points.length, 2, 'only well-formed entries with a numeric weight are converted');
  assertEq(points[0].v, 180, 'weight value is carried through as v');
}

// ==================== computeWeightProjection ====================
{
  const dayMs = 86400000;
  const base = new Date();
  const entries = [];
  // Losing 0.1 lb/day over 10 entries -> -0.7 lb/week.
  for (let i = 0; i < 10; i++) {
    const d = new Date(base.getTime() - (9 - i) * dayMs);
    const dateKey = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    entries.push({ dateKey, weight: 180 - i * 0.1 });
  }
  const projection = computeWeightProjection(entries, 45, 30);
  assertTrue(!!projection, 'enough weigh-ins produce a projection');
  assertClose(projection.slopePerWeek, -0.7, 'losing weight produces a negative slope per week', 0.05);
  assertTrue(projection.projectedValue < projection.currentEstimate, 'a losing trend projects a lower value 30 days out');

  const tooFewEntries = computeWeightProjection(entries.slice(0, 2), 45, 30);
  assertEq(tooFewEntries, null, 'fewer than the minimum weigh-ins returns no projection');
}

// ==================== computeSleepDebt ====================
{
  const rows = [
    { sleepHours: 6 }, { sleepHours: 7 }, { sleepHours: 8.5 }, { sleepHours: 5 }, { sleepHours: null },
  ];
  const debt = computeSleepDebt(rows, 8);
  assertTrue(!!debt, 'nights with sleep data produce a debt result');
  assertEq(debt.nights, 4, 'only nights with a logged sleepHours count, nulls are excluded');
  assertClose(debt.totalDebt, 2 + 1 + 0 + 3, 'debt sums (target - actual) per night, floored at 0 for oversleep nights');
  assertClose(debt.avgDebtPerNight, 6 / 4, 'avgDebtPerNight is totalDebt / nights with data');

  const noData = computeSleepDebt([{ sleepHours: null }], 8);
  assertEq(noData, null, 'no logged nights at all returns null rather than a fake zero');
}

// ==================== computeBurnoutRisk ====================
{
  // Recent 7 days: high stress, low sleep quality, low consistency.
  // Prior 7 days: low stress, high sleep quality, high consistency.
  const recent = [];
  for (let i = 0; i < 7; i++) recent.push({ outcomeStress: 4, sleepQuality: 2, consistencyRate: 0.3 });
  const prior = [];
  for (let i = 0; i < 7; i++) prior.push({ outcomeStress: 2, sleepQuality: 4, consistencyRate: 0.8 });
  const risk = computeBurnoutRisk(recent.concat(prior));
  assertEq(risk.level, 'Elevated', 'all three signals worsening together is flagged Elevated');
  assertEq(risk.signals.length, 3, 'all three individual signals are reported');

  // Only stress rising, everything else flat.
  const recent2 = [];
  for (let i = 0; i < 7; i++) recent2.push({ outcomeStress: 4, sleepQuality: 3, consistencyRate: 0.6 });
  const prior2 = [];
  for (let i = 0; i < 7; i++) prior2.push({ outcomeStress: 2, sleepQuality: 3, consistencyRate: 0.6 });
  const risk2 = computeBurnoutRisk(recent2.concat(prior2));
  assertEq(risk2.level, 'Moderate', 'exactly one worsening signal is Moderate, not Elevated');

  // Nothing worsening.
  const flat = [];
  for (let i = 0; i < 14; i++) flat.push({ outcomeStress: 3, sleepQuality: 3, consistencyRate: 0.6 });
  const risk3 = computeBurnoutRisk(flat);
  assertEq(risk3.level, 'Low', 'stable weeks report Low risk');
  assertEq(risk3.signals.length, 0, 'no signals are listed when nothing is trending worse');

  // No data at all.
  const risk4 = computeBurnoutRisk([]);
  assertTrue(risk4.insufficientData === true, 'no data at all is reported as insufficient rather than a fake Low');
  assertEq(risk4.level, 'Unknown', 'insufficient data reports an Unknown level rather than guessing Low');
}

const DRIFT_RECENT_DAYS = 14;
const DRIFT_BASELINE_DAYS = 60;
const DRIFT_MIN_SAMPLES = 7;
const DRIFT_RELATIVE_DROP = 0.25;
const DRIFT_MIN_METRICS = 2;

const DRIFT_METRICS = [
  { field: 'workoutDone', get: r => r.factors.workoutDone ? 1 : 0, phrase: (r, b) => 'workouts (' + Math.round(r * 100) + '% of days vs ' + Math.round(b * 100) + '% before)' },
  { field: 'habitRate', get: r => r.habitRate, phrase: (r, b) => 'habit completion (' + Math.round(r * 100) + '% vs ' + Math.round(b * 100) + '% before)' },
  { field: 'todoRate', get: r => r.todoRate, phrase: (r, b) => 'to-do completion (' + Math.round(r * 100) + '% vs ' + Math.round(b * 100) + '% before)' },
  { field: 'sleepQuality', get: r => r.sleepQuality, phrase: (r, b) => 'sleep quality (' + r.toFixed(1) + '/5 vs ' + b.toFixed(1) + '/5 before)' },
];

function computeDrift(dayRows) {
  const recent = dayRows.slice(0, DRIFT_RECENT_DAYS);
  const baseline = dayRows.slice(DRIFT_RECENT_DAYS, DRIFT_BASELINE_DAYS);
  const drifted = [];
  DRIFT_METRICS.forEach(m => {
    const recentVals = recent.map(m.get).filter(v => v != null);
    const baselineVals = baseline.map(m.get).filter(v => v != null);
    if (recentVals.length < DRIFT_MIN_SAMPLES || baselineVals.length < DRIFT_MIN_SAMPLES) return;
    const recentAvg = avg(recentVals), baselineAvg = avg(baselineVals);
    if (!(baselineAvg > 0)) return;
    const relDrop = (baselineAvg - recentAvg) / baselineAvg;
    if (relDrop >= DRIFT_RELATIVE_DROP) {
      drifted.push({ field: m.field, recentAvg, baselineAvg, relDrop, phrase: m.phrase(recentAvg, baselineAvg) });
    }
  });
  drifted.sort((a, b) => b.relDrop - a.relDrop);
  return drifted;
}

// ==================== computeTimeToGoal ====================
{
  const risingTrend = { slopePerDay: 10, currentEstimate: 1000 };
  const result = computeTimeToGoal(risingTrend, 1500);
  assertTrue(!!result && result.onTrack, 'a target above current value with a rising trend is on track');
  assertClose(result.daysNeeded, 50, 'days needed is (target - current) / slopePerDay');
  assertTrue(result.etaDate instanceof Date, 'an eta date is produced');

  const fallingTrend = { slopePerDay: -0.2, currentEstimate: 180 };
  const weightResult = computeTimeToGoal(fallingTrend, 170);
  assertTrue(!!weightResult && weightResult.onTrack, 'a target below current value with a falling trend is on track (weight loss)');
  assertClose(weightResult.daysNeeded, 50, 'days needed works the same way for a decreasing metric');

  const wrongDirection = computeTimeToGoal(risingTrend, 500);
  assertTrue(!!wrongDirection && !wrongDirection.onTrack, 'a target below current value while the trend is rising is reported as not on track');
  assertEq(wrongDirection.daysNeeded, null, 'not-on-track results have no daysNeeded');

  const already = computeTimeToGoal(risingTrend, 1000);
  assertTrue(!!already && already.reached, 'a target equal to the current value is reported as already reached');

  assertEq(computeTimeToGoal(null, 100), null, 'no trend at all returns null rather than a fake result');
  assertEq(computeTimeToGoal(risingTrend, null), null, 'no target value returns null');
}

// ==================== computeDrift ====================
{
  function mkRow(workoutDone, habitRate, sleepQuality) {
    return { factors: { workoutDone }, habitRate, todoRate: null, sleepQuality };
  }

  // A real drift: workouts and habit completion both stop in the most recent 14 days,
  // after 46 days of consistent baseline (index 14..59).
  {
    const dayRows = [];
    for (let i = 0; i < 14; i++) dayRows.push(mkRow(false, 0, null));
    for (let i = 14; i < 60; i++) dayRows.push(mkRow(true, 1, null));
    const drifted = computeDrift(dayRows);
    assertTrue(drifted.length >= 2, 'both workouts and habit completion are flagged as drifted');
    assertTrue(drifted.some(d => d.field === 'workoutDone'), 'workout rate is one of the drifted metrics');
    assertTrue(drifted.some(d => d.field === 'habitRate'), 'habit rate is one of the drifted metrics');
  }

  // No drift: recent matches baseline throughout.
  {
    const dayRows = [];
    for (let i = 0; i < 60; i++) dayRows.push(mkRow(true, 1, 4));
    assertEq(computeDrift(dayRows).length, 0, 'no metrics are flagged when recent matches baseline');
  }

  // Only one metric drifting is reported, but that alone isn't a full "drift" (DRIFT_MIN_METRICS check
  // belongs to the caller, computeDriftInsight-equivalent — this just verifies computeDrift's own count).
  {
    const dayRows = [];
    for (let i = 0; i < 14; i++) dayRows.push(mkRow(false, 1, null)); // only workouts drop
    for (let i = 14; i < 60; i++) dayRows.push(mkRow(true, 1, null));
    const drifted = computeDrift(dayRows);
    assertEq(drifted.length, 1, 'only the workout metric alone is flagged as drifted');
    assertTrue(drifted.length < DRIFT_MIN_METRICS, 'a single drifted metric is below the multi-metric threshold used for a real alert');
  }

  // Too few samples on one side excludes a nullable metric rather than guessing
  // (workoutDone is never null itself, so this exercises habitRate/sleepQuality instead).
  {
    const dayRows = [];
    for (let i = 0; i < 60; i++) dayRows.push(mkRow(true, null, null));
    // Only 2 of the 14 recent days have a real habitRate logged — below DRIFT_MIN_SAMPLES.
    dayRows[0].habitRate = 0.1;
    dayRows[1].habitRate = 0.1;
    for (let i = 14; i < 60; i++) dayRows[i].habitRate = 1;
    const drifted = computeDrift(dayRows);
    assertTrue(!drifted.some(d => d.field === 'habitRate'), 'habitRate is excluded when the recent window has too few real data points, even though the baseline is well-sampled');
  }
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
