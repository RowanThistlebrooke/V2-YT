// Standalone verification of insights.html's day-dataset + bottleneck/pattern
// detector logic. insights.html has no module exports (browser-global IIFE),
// so this duplicates the exact functions to test them in isolation, mirroring
// this repo's established approach for testing embedded-HTML pure logic
// without a DOM (see test_rest_timer_logic.mjs, test_notes_mood_chart.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const WINDOW_DAYS = 60;
const MIN_SAMPLES = 5;
const MEANINGFUL_DIFF = 0.4;

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateKeyFromDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function lastNDateKeys(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) { out.push(dateKeyFromDate(d)); d.setDate(d.getDate() - 1); }
  return out;
}

const FACTOR_LABELS = {
  goodSleepQuality: 'good sleep quality (4-5/5)',
  poorSleepQuality: 'poor sleep quality (1-2/5)',
  lowSleepHours: 'under 6.5 hours of sleep',
  workoutDone: 'a workout day',
  lateCaffeine: 'caffeine at/after 2pm',
  highHabitRate: 'high habit completion (80%+)',
  lowHabitRate: 'low habit completion (under 50%)',
  highTodoRate: 'high to-do completion (80%+)',
  lowTodoRate: 'low to-do completion (under 40%)',
};

function buildDayRows(rowsByKey, dateKeys) {
  const peakData = rowsByKey.peak || {};
  const sleepData = rowsByKey.sleep || {};
  const morning = sleepData['sleep:nights'] || {};
  const checkins = peakData['peak:checkins'] || [];
  const gymData = rowsByKey['po-coach'] || {};
  const doneDays = gymData['po_coach_workout_done'] || {};
  const caffeineData = rowsByKey.caffeine || {};
  const cafLogs = caffeineData['caf:logs'] || [];
  const goalsData = rowsByKey.goals || {};
  const habitDefs = goalsData['habits:defs'] || [];
  const habitLog = goalsData['habits:log'] || {};

  const feelingByDay = {}, stressByDay = {};
  checkins.forEach(c => {
    if (!c || !c.dateKey) return;
    if (c.feeling) (feelingByDay[c.dateKey] = feelingByDay[c.dateKey] || []).push(c.feeling);
    if (c.stress) (stressByDay[c.dateKey] = stressByDay[c.dateKey] || []).push(c.stress);
  });

  const lateCaffeineDays = new Set();
  cafLogs.forEach(l => {
    if (!l || !l.ts) return;
    const d = new Date(l.ts);
    if (d.getHours() >= 14) lateCaffeineDays.add(dateKeyFromDate(d));
  });

  return dateKeys.map(dateKey => {
    const feelings = feelingByDay[dateKey], stresses = stressByDay[dateKey];
    const morningEntry = morning[dateKey];
    const sleepQuality = morningEntry ? morningEntry.sleepQuality : null;
    const sleepHours = morningEntry ? morningEntry.sleepHours : null;
    const habitTotal = habitDefs.length;
    const habitDone = habitTotal ? habitDefs.filter(h => habitLog[h.id] && habitLog[h.id][dateKey]).length : 0;
    const habitRate = habitTotal ? habitDone / habitTotal : null;
    const goalsToday = goalsData['goals:' + dateKey] || [];
    const todoRate = goalsToday.length ? goalsToday.filter(g => g.done).length / goalsToday.length : null;
    const consistencyParts = [habitRate, todoRate].filter(v => v != null);

    return {
      dateKey,
      outcomeFeeling: feelings && feelings.length ? avg(feelings) : null,
      outcomeStress: stresses && stresses.length ? avg(stresses) : null,
      sleepQuality: sleepQuality != null ? sleepQuality : null,
      sleepHours: sleepHours != null ? sleepHours : null,
      habitRate: habitRate,
      todoRate: todoRate,
      consistencyRate: consistencyParts.length ? avg(consistencyParts) : null,
      factors: {
        goodSleepQuality: sleepQuality != null ? sleepQuality >= 4 : null,
        poorSleepQuality: sleepQuality != null ? sleepQuality <= 2 : null,
        lowSleepHours: sleepHours != null ? sleepHours < 6.5 : null,
        workoutDone: !!doneDays[dateKey],
        lateCaffeine: lateCaffeineDays.has(dateKey),
        highHabitRate: habitRate != null ? habitRate >= 0.8 : null,
        lowHabitRate: habitRate != null ? habitRate < 0.5 : null,
        highTodoRate: todoRate != null ? todoRate >= 0.8 : null,
        lowTodoRate: todoRate != null ? todoRate < 0.4 : null,
      },
    };
  });
}

function computeFactorEffect(dayRows, factorKey, outcomeKey) {
  const withF = [], withoutF = [];
  dayRows.forEach(d => {
    const f = d.factors[factorKey], o = d[outcomeKey];
    if (f == null || o == null) return;
    (f ? withF : withoutF).push(o);
  });
  if (withF.length < MIN_SAMPLES || withoutF.length < MIN_SAMPLES) return null;
  const avgWith = avg(withF), avgWithout = avg(withoutF);
  const rawDiff = avgWith - avgWithout;
  const goodnessDiff = outcomeKey === 'outcomeStress' ? -rawDiff : rawDiff;
  return { factorKey, outcome: outcomeKey === 'outcomeStress' ? 'stress' : 'feeling', avgWith, avgWithout, goodnessDiff, nWith: withF.length, nWithout: withoutF.length };
}

function computeAllEffects(dayRows) {
  const results = [];
  Object.keys(FACTOR_LABELS).forEach(factorKey => {
    ['outcomeFeeling', 'outcomeStress'].forEach(outcomeKey => {
      const effect = computeFactorEffect(dayRows, factorKey, outcomeKey);
      if (effect && Math.abs(effect.goodnessDiff) >= MEANINGFUL_DIFF) results.push(effect);
    });
  });
  results.sort((a, b) => Math.abs(b.goodnessDiff) - Math.abs(a.goodnessDiff));
  return results;
}

function computeBottleneck(dayRows) {
  const effects = computeAllEffects(dayRows);
  const negative = effects.filter(e => e.goodnessDiff < 0);
  return negative.length ? negative[0] : null;
}

function buildLaggedDayRows(dayRows) {
  const out = [];
  for (let i = 0; i < dayRows.length - 1; i++) {
    out.push({
      dateKey: dayRows[i].dateKey,
      outcomeFeeling: dayRows[i].outcomeFeeling,
      outcomeStress: dayRows[i].outcomeStress,
      factors: dayRows[i + 1].factors,
    });
  }
  return out;
}

function computeEmotionalTriggers(dayRows) {
  return computeAllEffects(buildLaggedDayRows(dayRows)).filter(e => e.goodnessDiff < 0);
}

// ==================== lastNDateKeys / dateKeyFromDate ====================
{
  const keys = lastNDateKeys(5);
  assertEq(keys.length, 5, 'returns exactly N date keys');
  assertEq(keys[0], dateKeyFromDate(new Date()), 'the first key is today');
  const uniq = new Set(keys);
  assertEq(uniq.size, 5, 'all returned dates are distinct (no duplicate days)');
}

// ==================== buildDayRows ====================
{
  const rowsByKey = {
    peak: {
      'peak:checkins': [
        { dateKey: '2026-01-01', feeling: 4, stress: 2 },
        { dateKey: '2026-01-01', feeling: 5 },
      ],
    },
    sleep: {
      'sleep:nights': { '2026-01-02': { sleepQuality: 2, sleepHours: 5.5 } },
    },
    'po-coach': { po_coach_workout_done: { '2026-01-01': true } },
    caffeine: { 'caf:logs': [{ ts: new Date(2026, 0, 1, 15, 0).getTime() }] },
    goals: {
      'habits:defs': [{ id: 'h1' }, { id: 'h2' }],
      'habits:log': { h1: { '2026-01-01': true } },
      'goals:2026-01-01': [{ text: 'a', done: true }, { text: 'b', done: false }],
    },
  };
  const rows = buildDayRows(rowsByKey, ['2026-01-01', '2026-01-02']);
  const day1 = rows.find(r => r.dateKey === '2026-01-01');
  assertEq(day1.outcomeFeeling, 4.5, 'feeling checkins for a day are averaged');
  assertEq(day1.outcomeStress, 2, 'a single stress checkin is used as-is');
  assertEq(day1.factors.workoutDone, true, 'a logged workout day is detected');
  assertEq(day1.factors.lateCaffeine, true, 'a 3pm caffeine log counts as late');
  assertEq(day1.factors.highTodoRate, false, 'a 50% to-do completion day is not "high" (needs 80%+)');
  assertEq(day1.factors.lowTodoRate, false, 'a 50% to-do completion day is not "low" either (needs under 40%)');

  const day2 = rows.find(r => r.dateKey === '2026-01-02');
  assertEq(day2.factors.poorSleepQuality, true, 'sleep quality 2 counts as poor');
  assertEq(day2.factors.lowSleepHours, true, '5.5 hours counts as low');
  assertEq(day2.factors.workoutDone, false, 'a day with no logged workout is false, not null');
  assertEq(day2.outcomeFeeling, null, 'a day with no checkins has a null outcome rather than 0');

  assertEq(day1.habitRate, 0.5, 'raw habitRate is exposed (1 of 2 habits done)');
  assertEq(day1.todoRate, 0.5, 'raw todoRate is exposed (1 of 2 to-dos done)');
  assertEq(day1.consistencyRate, 0.5, 'consistencyRate averages habitRate and todoRate');
  assertEq(day2.sleepQuality, 2, 'raw sleepQuality is exposed');
  assertEq(day2.sleepHours, 5.5, 'raw sleepHours is exposed');
  assertEq(day2.consistencyRate, 0, 'a day with defined habits but none completed has a consistencyRate of 0, not null (habitRate is a real 0, not missing data)');
}

// ==================== computeFactorEffect ====================
{
  // 6 workout days with high feeling, 6 non-workout days with low feeling.
  const dayRows = [];
  for (let i = 0; i < 6; i++) dayRows.push({ dateKey: 'w' + i, outcomeFeeling: 4.5, outcomeStress: 2, factors: { workoutDone: true } });
  for (let i = 0; i < 6; i++) dayRows.push({ dateKey: 'n' + i, outcomeFeeling: 2.5, outcomeStress: 4, factors: { workoutDone: false } });

  const feelingEffect = computeFactorEffect(dayRows, 'workoutDone', 'outcomeFeeling');
  assertTrue(!!feelingEffect, 'enough samples on both sides produces an effect');
  assertEq(feelingEffect.goodnessDiff, 2, 'workout days average 2.0 higher feeling -> positive goodnessDiff (factor helps)');

  const stressEffect = computeFactorEffect(dayRows, 'workoutDone', 'outcomeStress');
  assertEq(stressEffect.goodnessDiff, 2, 'workout days average LOWER stress -> still a positive goodnessDiff (lower stress is normalized as "better")');

  const tooFew = computeFactorEffect(dayRows.slice(0, 8), 'workoutDone', 'outcomeFeeling');
  assertTrue(!!tooFew === false || tooFew === null, 'below the minimum sample size on one side returns null');
}

// ==================== computeAllEffects / computeBottleneck ====================
{
  const dayRows = [];
  // Late caffeine correlates with WORSE feeling (a real limiter).
  for (let i = 0; i < 6; i++) dayRows.push({ dateKey: 'lc' + i, outcomeFeeling: 2, outcomeStress: null, factors: { lateCaffeine: true, workoutDone: false } });
  for (let i = 0; i < 6; i++) dayRows.push({ dateKey: 'nc' + i, outcomeFeeling: 4, outcomeStress: null, factors: { lateCaffeine: false, workoutDone: false } });

  const effects = computeAllEffects(dayRows);
  assertTrue(effects.length >= 1, 'at least one meaningful effect is found');
  assertEq(effects[0].factorKey, 'lateCaffeine', 'the strongest effect is ranked first');

  const bottleneck = computeBottleneck(dayRows);
  assertTrue(!!bottleneck, 'a negative effect (a real limiter) is found');
  assertEq(bottleneck.factorKey, 'lateCaffeine', 'late caffeine is correctly identified as the bottleneck (its presence hurts)');
  assertTrue(bottleneck.goodnessDiff < 0, 'the bottleneck effect is reported with a negative goodnessDiff (presence hurts)');
}

// ==================== computeBottleneck: no negative effects ====================
{
  // Only a POSITIVE factor (workout helps) — nothing is actively a "limiter".
  const dayRows = [];
  for (let i = 0; i < 6; i++) dayRows.push({ dateKey: 'w' + i, outcomeFeeling: 4.5, outcomeStress: null, factors: { workoutDone: true } });
  for (let i = 0; i < 6; i++) dayRows.push({ dateKey: 'n' + i, outcomeFeeling: 2.5, outcomeStress: null, factors: { workoutDone: false } });
  const bottleneck = computeBottleneck(dayRows);
  assertEq(bottleneck, null, 'a purely positive pattern (nothing actively hurting) reports no bottleneck');
}

// ==================== buildLaggedDayRows / computeEmotionalTriggers ====================
{
  // 13 most-recent-first day rows, designed so every consecutive (today, yesterday)
  // pair lands in one of two clean buckets: yesterday had late caffeine -> today's
  // feeling is poor (2); yesterday had no late caffeine -> today's feeling is good (4).
  const dayRows = [];
  for (let i = 0; i <= 12; i++) {
    const outcomeFeeling = i <= 5 ? 2 : (i <= 11 ? 4 : null);
    const lateCaffeine = (i >= 1 && i <= 6) ? true : (i >= 7 && i <= 12) ? false : undefined;
    dayRows.push({ dateKey: 'd' + i, outcomeFeeling, outcomeStress: null, factors: { lateCaffeine } });
  }

  const lagged = buildLaggedDayRows(dayRows);
  assertEq(lagged.length, 12, 'produces N-1 lagged rows from N day rows');
  assertEq(lagged[0].factors.lateCaffeine, true, "a lagged row's factors come from the PRECEDING day, not the same day");
  assertEq(lagged[0].outcomeFeeling, 2, "a lagged row's outcome stays the day's own outcome, not the preceding day's");

  const triggers = computeEmotionalTriggers(dayRows);
  assertTrue(triggers.length >= 1, 'a real day-ahead trigger is found');
  assertEq(triggers[0].factorKey, 'lateCaffeine', 'late caffeine the day before is identified as the trigger');
  assertTrue(triggers[0].goodnessDiff < 0, "a trigger's goodnessDiff is always negative (the prior factor makes the next day worse)");
  assertTrue(triggers.every(t => t.goodnessDiff < 0), 'computeEmotionalTriggers only ever returns negative effects, never positive ones');

  assertEq(computeEmotionalTriggers([{ dateKey: 'x', outcomeFeeling: 3, outcomeStress: null, factors: {} }]), [], 'a single day row (nothing to lag against) returns no triggers');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
