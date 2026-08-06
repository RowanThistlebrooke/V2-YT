// Coverage for correlation-lab.js: the shared day-row builder, corrected
// sleep-session caffeine attribution, Pearson correlation, sample/variance
// safeguards, lag scan, fixed metric catalog, and result assembly.

import {
  MIN_CORRELATION_SAMPLES, METRIC_CATALOG, CORRELATION_PRESETS,
  dateKeyFromDate, lastNDateKeys, shiftDateKey, lateCaffeineSleepSessionDays,
  buildDayRows, pearsonCorrelation, scanLaggedCorrelations, strengthForCorrelation,
  buildCorrelationResult, seriesForMetric,
} from '../correlation-lab.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(condition, label) {
  if (condition) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}
function series(values, startDate) {
  const start = startDate || '2026-01-01';
  return values.map((value, index) => ({ dateKey: shiftDateKey(start, index), value }));
}

// ==================== date helpers ====================
{
  const anchor = new Date(2026, 0, 15, 12, 0, 0);
  assertEq(lastNDateKeys(3, anchor), ['2026-01-15', '2026-01-14', '2026-01-13'], 'lastNDateKeys is deterministic when given an anchor date');
  assertEq(shiftDateKey('2026-01-31', 1), '2026-02-01', 'shiftDateKey crosses month boundaries with local calendar math');
  assertEq(dateKeyFromDate(new Date(2026, 6, 4)), '2026-07-04', 'dateKeyFromDate zero-pads month and day');
}

// ==================== Pearson fixtures ====================
{
  const sparse = seriesForMetric([
    { dateKey: '2026-01-01', sleepHours: 8 },
    { dateKey: '2026-01-02', sleepHours: null },
    { dateKey: '2026-01-03' },
  ], 'sleepHours');
  assertEq(sparse.length, 1, 'missing metric days are excluded rather than converted to zero');
  assertEq(sparse[0].value, 8, 'recorded metric values survive sparse-series extraction');
}

{
  const a = series([1, 2, 3, 4, 5, 6, 7, 8]);
  const positive = pearsonCorrelation(a, series([2, 4, 6, 8, 10, 12, 14, 16]));
  assertEq(positive.status, 'ok', 'Pearson returns a result at the eight-day minimum');
  assertTrue(Math.abs(positive.r - 1) < 1e-12, 'perfectly correlated series produce r = 1');
  assertEq(positive.strength, 'Very strong', 'r = 1 is bucketed as very strong');

  const negative = pearsonCorrelation(a, series([16, 14, 12, 10, 8, 6, 4, 2]));
  assertTrue(Math.abs(negative.r + 1) < 1e-12, 'perfectly anti-correlated series produce r = -1');

  const unrelated = pearsonCorrelation(a, series([1, -1, -1, 1, 1, -1, -1, 1]));
  assertTrue(Math.abs(unrelated.r) < 1e-12, 'a hand-balanced fixture produces r = 0');
  assertEq(unrelated.strength, 'Negligible', 'r = 0 is bucketed as negligible');
}

// ==================== safeguards ====================
{
  const tooSmall = pearsonCorrelation(series([1, 2, 3, 4, 5, 6, 7]), series([2, 4, 6, 8, 10, 12, 14]));
  assertEq(tooSmall.status, 'insufficient', 'fewer than eight overlapping days is refused');
  assertEq(tooSmall.minSamples, MIN_CORRELATION_SAMPLES, 'the refusal reports the documented minimum');

  const constantA = pearsonCorrelation(series(Array(8).fill(5)), series([1, 2, 3, 4, 5, 6, 7, 8]));
  assertEq(constantA.status, 'zero-variance', 'a constant metric is refused instead of returning 0 or NaN');
  assertEq(constantA.constant, 'a', 'the zero-variance result identifies the first metric as constant');

  assertEq(strengthForCorrelation(0.29), 'Weak', 'the weak threshold ends below 0.30');
  assertEq(strengthForCorrelation(0.3), 'Moderate', '0.30 begins the moderate bucket');
  assertEq(strengthForCorrelation(-0.7), 'Very strong', 'strength uses absolute r and 0.70 begins very strong');
}

// ==================== lag scan ====================
{
  const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8];
  const a = series(values);
  const b = values.map((value, index) => ({ dateKey: shiftDateKey('2026-01-01', index + 2), value }));
  const scan = scanLaggedCorrelations(a, b);
  assertEq(scan.results.map(result => result.lagDays), [-3, -2, -1, 0, 1, 2, 3], 'lag scan covers every offset from -3 through +3');
  assertEq(scan.best.lagDays, 2, 'lag scan finds that the second metric follows the first by two days');
  assertTrue(Math.abs(scan.best.r - 1) < 1e-12, 'the correct lag reconstructs a perfect relationship');
}

// ==================== corrected caffeine sleep-session attribution ====================
{
  const beforeMidnight = new Date(2026, 0, 1, 23, 0).getTime();
  const afterMidnight = new Date(2026, 0, 2, 2, 0).getTime();
  const midday = new Date(2026, 0, 2, 12, 0).getTime();
  const days = lateCaffeineSleepSessionDays([{ ts: beforeMidnight }, { ts: afterMidnight }, { ts: midday }]);
  assertEq(Array.from(days), ['2026-01-02'], 'before- and after-midnight late caffeine both map to the Jan 2 wake-up session while midday does not');
}

// ==================== shared buildDayRows superset ====================
{
  const wakeDate = '2026-01-02';
  const previousEvening = new Date(2026, 0, 1, 23, 0).getTime();
  const sameDayMorning = new Date(2026, 0, 2, 9, 0).getTime();
  const rows = buildDayRows({
    sleep: { 'sleep:nights': { [wakeDate]: { sleepHours: 6.5, sleepQuality: 3 } } },
    peak: { 'peak:checkins': [{ dateKey: wakeDate, feeling: 4, stress: 2 }] },
    caffeine: { 'caf:logs': [{ ts: previousEvening, mg: 95 }, { ts: sameDayMorning, mg: 80 }] },
    goals: {
      'habits:defs': [{ id: 'h1', name: 'Read' }, { id: 'h2', name: 'Journal' }],
      'habits:log': { h1: { [wakeDate]: true }, h2: {} },
      ['goals:' + wakeDate]: [{ done: true }, { done: false }],
    },
    'po-coach': {
      po_coach_workout_done: { [wakeDate]: '2026-01-02T15:00:00.000Z' },
      'stretch:am:items': [{ id: 'am1' }, { id: 'am2' }],
      'stretch:pm:items': [{ id: 'pm1' }],
      'stretch:log': { am1: { [wakeDate]: true }, am2: { [wakeDate]: true }, pm1: {} },
    },
    finance: { purchases: [{ id: 'p1', date: wakeDate, entered_amount: 12.5 }, { id: 'p2', date: wakeDate, entered_amount: 7.5 }] },
  }, [wakeDate]);

  const row = rows[0];
  assertEq(rows.length, 1, 'buildDayRows returns one superset row per requested date');
  assertEq(row.sleepHours, 6.5, 'sleep hours survive the extraction');
  assertEq(row.sleepQuality, 3, 'sleep quality survives the extraction');
  assertEq(row.outcomeFeeling, 4, 'feeling survives the extraction');
  assertEq(row.outcomeStress, 2, 'stress survives the extraction');
  assertEq(row.habitRate, 0.5, 'habit completion rate survives the extraction');
  assertEq(row.todoRate, 0.5, 'to-do completion rate survives the extraction');
  assertEq(row.consistencyRate, 0.5, 'combined consistency remains available to Recovery and Prediction Center');
  assertEq(row.workoutDone, 1, 'workout completion is exposed as a numeric binary metric');
  assertEq(row.factors.workoutDone, true, 'workout completion remains available under factors for legacy Insights pages');
  assertEq(row.lateCaffeine, 1, 'the Correlation Lab late-caffeine metric uses sleep-session attribution');
  assertEq(row.factors.lateCaffeine, true, 'legacy factor consumers receive the corrected late-caffeine value');
  assertEq(row.caffeineMg, 80, 'daily caffeine dose uses the dose logged on the metric calendar day');
  assertEq(row.spending, 20, 'daily purchase amount sums entered_amount values');
  assertTrue(Math.abs(row.stretchRate - (2 / 3)) < 1e-12, 'stretch completion is the share of configured AM/PM items completed that day');
  assertTrue(Number.isFinite(row.nightScore), 'Night Score is derived on the same shared row');
  assertEq(row.factors.goodSleepQuality, false, 'Patterns receives its good-sleep factor');
  assertEq(row.factors.poorSleepQuality, false, 'Triggers and Patterns receive the poor-sleep factor');
  assertEq(row.factors.lowSleepHours, false, 'Triggers and Patterns receive the low-sleep-hours factor');
  assertEq(row.factors.lowHabitRate, false, 'Triggers and Patterns receive the low-habit factor');
  assertEq(row.factors.lowTodoRate, false, 'Triggers and Patterns receive the low-to-do factor');

  const empty = buildDayRows({}, [wakeDate])[0];
  assertEq(empty.sleepHours, null, 'the shared builder tolerates completely empty storage');
  assertEq(empty.workoutDone, null, 'untracked workouts are null rather than a fabricated no-workout history');
  assertEq(empty.caffeineMg, null, 'untracked caffeine is null rather than a fabricated zero-dose history');
  assertEq(empty.spending, null, 'untracked spending is null rather than a fabricated zero-spend history');
  assertEq(empty.stretchRate, null, 'stretch completion is unavailable without configured stretches');
}

// ==================== catalog, presets, and assembled result ====================
{
  const ids = METRIC_CATALOG.map(metric => metric.id);
  ['sleepHours', 'sleepQuality', 'workoutDone', 'caffeineMg', 'lateCaffeine', 'nightScore', 'outcomeFeeling', 'outcomeStress', 'habitRate', 'todoRate', 'spending', 'stretchRate']
    .forEach(id => assertTrue(ids.includes(id), 'metric catalog includes ' + id));
  assertEq(CORRELATION_PRESETS.length, 4, 'all four required presets are present');
  assertTrue(CORRELATION_PRESETS.find(preset => preset.id === 'stretching-pain').caveat.includes('no dedicated pain'), 'stretching preset labels stress as a proxy rather than inventing pain data');

  const days = series([0, 1, 0, 1, 0, 1, 0, 1], '2026-02-01').map((point, index) => ({
    dateKey: point.dateKey,
    lateCaffeine: point.value,
    nightScore: point.value ? 50 : 90,
  }));
  const result = buildCorrelationResult(days, 'lateCaffeine', 'nightScore');
  assertEq(result.status, 'ok', 'result assembly computes a supported metric pair');
  assertTrue(result.direction.includes('tends to go down'), 'result assembly gives the negative direction in plain language');
  assertTrue(result.caveats.some(caveat => caveat.includes('built into the score')), 'the circular Night Score/caffeine relationship is disclosed');
  assertTrue(result.disclaimer.includes('does not prove'), 'every assembled result carries the correlation-not-causation disclaimer');
  assertEq(buildCorrelationResult(days, 'nightScore', 'nightScore').status, 'invalid', 'selecting the same metric twice is refused');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
