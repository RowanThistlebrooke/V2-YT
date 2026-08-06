// Coverage for prediction-center.js — every duplicated forecasting function
// plus the card-assembly logic. Each duplicated function is checked against
// known inputs so a future edit that silently diverges from its source page
// (gym.html/finance.html/insights-recovery.html/insights-adherence.html) is
// caught here. See docs/PREDICTION_CENTER_PLAN.md for the design this
// implements.

import {
  trajCompute, computeNwScenarios, dateKeyFromDate, lastNDateKeys, buildDayRows,
  computeSleepDebt, computeBurnoutRisk, computeOverallAdherence, computeAdherenceTrend,
  buildWeightCard, buildNetWorthCard, buildSleepCard, buildAdherenceCard, buildScheduleCard, buildAllCards,
} from '../prediction-center.js';

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

function daysAgoKey(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKeyFromDate(d);
}

// ==================== trajCompute (weight) ====================
{
  assertEq(trajCompute([{ dateKey: daysAgoKey(10), weight: 100 }, { dateKey: daysAgoKey(5), weight: 99 }], null), null, 'trajCompute refuses below the 3-entry minimum');

  const losing = [
    { dateKey: daysAgoKey(30), weight: 100 },
    { dateKey: daysAgoKey(20), weight: 98.6 },
    { dateKey: daysAgoKey(10), weight: 97.2 },
    { dateKey: daysAgoKey(0), weight: 95.8 },
  ];
  const r = trajCompute(losing, 90);
  assertTrue(!!r, 'trajCompute returns a result with enough entries');
  assertTrue(r.scenarios.typical < 0, 'a losing trend has a negative median weekly rate');
  assertTrue(r.scenarios.slow > r.scenarios.fast, 'for a losing trend, "slow" (closer to zero) is greater than "fast" (further from zero)');
  assertTrue(r.etas.typical instanceof Date, 'an ETA is projected when the scenario direction matches the goal direction');

  const flat = [
    { dateKey: daysAgoKey(20), weight: 100 },
    { dateKey: daysAgoKey(10), weight: 100 },
    { dateKey: daysAgoKey(0), weight: 100 },
  ];
  const rFlat = trajCompute(flat, 90); // goal is a gain, but trend is flat
  assertEq(rFlat.etas.typical, null, 'a flat/zero-rate scenario never gets a fabricated ETA');

  const wrongWay = trajCompute(losing, 200); // goal higher than current, but trend is losing
  assertEq(wrongWay.etas.typical, null, 'an ETA is refused when the scenario is trending the wrong direction for the goal');
}

// ==================== computeNwScenarios (net worth) ====================
{
  assertEq(computeNwScenarios([{ t: Date.now(), v: 1000 }, { t: Date.now(), v: 1000 }], 180, null), null, 'computeNwScenarios refuses below the 3-snapshot minimum');

  const now = Date.now();
  const day = 86400000;
  const growing = [
    { t: now - 60 * day, v: 10000 },
    { t: now - 30 * day, v: 11000 },
    { t: now, v: 12200 },
  ];
  const r = computeNwScenarios(growing, 180, null);
  assertTrue(!!r, 'computeNwScenarios returns a result with enough snapshots');
  assertTrue(r.scenarios.typical > 0, 'a growing net worth has a positive median monthly rate');
  assertTrue(r.scenarios.fast > r.scenarios.slow, 'for a growing trend, "fast" is a larger rate than "slow"');
  assertEq(computeNwScenarios(growing, 1, null), null, 'a window shorter than the data span can filter out enough points to fall below the minimum again');
}

// ==================== dateKeyFromDate / lastNDateKeys ====================
{
  assertEq(lastNDateKeys(3).length, 3, 'lastNDateKeys returns exactly n keys');
  assertEq(lastNDateKeys(3)[0], dateKeyFromDate(new Date()), 'lastNDateKeys starts with today');
}

// ==================== buildDayRows ====================
{
  const dateKey = daysAgoKey(1);
  const rowsByKey = {
    sleep: { 'sleep:nights': { [dateKey]: { sleepHours: 6.5, sleepQuality: 3 } } },
    peak: { 'peak:checkins': [{ dateKey, feeling: 4, stress: 2 }] },
    caffeine: { 'caf:logs': [] },
    goals: {
      'habits:defs': [{ id: 'h1', name: 'Stretch' }],
      'habits:log': { h1: { [dateKey]: true } },
      ['goals:' + dateKey]: [{ text: 'Task', done: true }],
    },
  };
  const rows = buildDayRows(rowsByKey, [dateKey]);
  assertEq(rows.length, 1, 'buildDayRows returns one row per requested date key');
  assertEq(rows[0].sleepHours, 6.5, 'sleep hours come through from sleep:nights');
  assertEq(rows[0].habitRate, 1, 'habit rate is 1 when the single defined habit was checked in');
  assertEq(rows[0].todoRate, 1, 'todo rate is 1 when the single goal for the day was done');
  assertEq(rows[0].consistencyRate, 1, 'consistency rate averages habit and todo rate');

  const emptyRows = buildDayRows({}, [dateKey]);
  assertEq(emptyRows[0].sleepHours, null, 'buildDayRows tolerates a completely empty rowsByKey');
}

// ==================== computeSleepDebt / computeBurnoutRisk ====================
{
  const rows = [
    { sleepHours: 6, sleepQuality: 3, outcomeStress: 3, consistencyRate: 0.5 },
    { sleepHours: 7, sleepQuality: 4, outcomeStress: 2, consistencyRate: 0.8 },
  ];
  const debt = computeSleepDebt(rows, 8);
  assertEq(debt.nights, 2, 'computeSleepDebt counts only nights with a logged sleepHours value');
  assertEq(debt.totalDebt, 3, 'computeSleepDebt sums (target - actual) deficits: (8-6) + (8-7) = 3');
  assertEq(computeSleepDebt([{ sleepQuality: 3 }], 8), null, 'computeSleepDebt returns null when no row has a numeric sleepHours');

  const noComparison = computeBurnoutRisk([{ outcomeStress: 3 }]);
  assertEq(noComparison, { level: 'Unknown', signals: [], insufficientData: true }, 'computeBurnoutRisk reports Unknown/insufficientData rather than guessing with no comparable prior window');

  const recent = Array.from({ length: 7 }, () => ({ outcomeStress: 4, sleepQuality: 2, consistencyRate: 0.3 }));
  const prior = Array.from({ length: 7 }, () => ({ outcomeStress: 2, sleepQuality: 4, consistencyRate: 0.8 }));
  const elevated = computeBurnoutRisk(recent.concat(prior));
  assertEq(elevated.level, 'Elevated', 'stress up + sleep quality down + consistency down all at once triggers Elevated (3 signals)');
  assertEq(elevated.signals.length, 3, 'all three signals fire when every threshold is crossed');
}

// ==================== computeOverallAdherence / computeAdherenceTrend ====================
{
  const rows = [{ consistencyRate: 1 }, { consistencyRate: 0.5 }, { consistencyRate: null }];
  const overall = computeOverallAdherence(rows);
  assertEq(overall, { rate: 0.75, n: 2 }, 'computeOverallAdherence averages only rows with a non-null consistencyRate');
  assertEq(computeOverallAdherence([]), null, 'computeOverallAdherence returns null with no rows');

  const recentGood = Array.from({ length: 5 }, () => ({ consistencyRate: 0.9 }));
  const priorBad = Array.from({ length: 5 }, () => ({ consistencyRate: 0.3 }));
  const trend = computeAdherenceTrend(recentGood.concat(priorBad), 5);
  assertTrue(!!trend, 'computeAdherenceTrend returns a result once both windows meet the minimum sample size');
  assertTrue(trend.diff > 0, 'an improving recent window against a worse prior window produces a positive diff');
  assertEq(computeAdherenceTrend(recentGood, 5), null, 'computeAdherenceTrend refuses when the prior window has no samples at all');
}

// ==================== Card builders ====================
{
  const weightCard = buildWeightCard({ po_coach_weights: [{ dateKey: daysAgoKey(1), weight: 80 }] });
  assertEq(weightCard.type, 'weight', 'buildWeightCard tags itself correctly');
  assertEq(weightCard.confidence, 'unavailable', 'the weight card does NOT claim banded confidence when there is not enough data for a real result — no false confidence');
  assertEq(weightCard.result, null, 'the weight card honestly reports no result below the minimum data volume, rather than a fabricated single point');
  assertEq(weightCard.sourcePage, 'gym.html', 'the weight card links back to its real source page');

  const weightCardWithData = buildWeightCard({
    po_coach_weights: [
      { dateKey: daysAgoKey(30), weight: 90 },
      { dateKey: daysAgoKey(15), weight: 89 },
      { dateKey: daysAgoKey(0), weight: 88 },
    ],
  });
  assertEq(weightCardWithData.confidence, 'banded', 'the weight card DOES claim banded confidence once there is enough data to actually back Slow/Typical/Fast');
  assertTrue(!!weightCardWithData.result, 'the well-populated weight card has a real result object');

  const nwCard = buildNetWorthCard({});
  assertEq(nwCard.type, 'networth', 'buildNetWorthCard tags itself correctly');
  assertEq(nwCard.confidence, 'unavailable', 'the net worth card does NOT claim banded confidence with no history at all');
  assertEq(nwCard.result, null, 'the net worth card returns no result with no history at all');

  const sleepCard = buildSleepCard({});
  assertEq(sleepCard.confidence, 'unavailable', 'the sleep card reports "unavailable" confidence rather than banded/point when there is no data at all');
  assertTrue(sleepCard.assumptions.includes('not a projection'), 'the sleep card assumptions text is explicit that debt is a current status, not a forecast');

  const adherenceCard = buildAdherenceCard({});
  assertEq(adherenceCard.confidence, 'unavailable', 'the adherence card reports "unavailable" with no data');

  const scheduleCard = buildScheduleCard();
  assertEq(scheduleCard.type, 'schedule', 'the schedule card is present');
  assertEq(scheduleCard.confidence, 'unavailable', 'the schedule card is honestly marked unavailable');
  assertTrue(!!scheduleCard.reason, 'the schedule card explains WHY it is unavailable rather than silently vanishing');

  const all = buildAllCards({});
  assertEq(all.map(c => c.type), ['weight', 'networth', 'sleep', 'adherence', 'schedule'], 'buildAllCards returns every card type in the fixed documented order');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
