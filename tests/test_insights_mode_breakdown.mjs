// Standalone verification of insights.html's Mode Breakdown (Alter Ego
// system) logic — passively classifying each day into one of a fixed set
// of modes from data already logged (sleep, stress/feeling, workouts,
// habit/to-do completion), never from manual self-tagging. insights.html
// has no module exports (browser-global IIFE), so this duplicates the
// exact functions to test them in isolation — same approach as
// test_insights_bottleneck.mjs / test_insights_predictive.mjs.

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

function mkRow(overrides) {
  return Object.assign({
    outcomeFeeling: null, outcomeStress: null, sleepQuality: null, sleepHours: null,
    habitRate: null, todoRate: null, consistencyRate: null,
    factors: { workoutDone: false },
  }, overrides);
}

function dayHasModeSignal(dayRow) {
  return dayRow.sleepQuality != null || dayRow.outcomeStress != null || dayRow.outcomeFeeling != null
    || dayRow.habitRate != null || dayRow.todoRate != null || !!dayRow.factors.workoutDone;
}

function classifyDayMode(dayRow) {
  if ((dayRow.sleepQuality != null && dayRow.sleepQuality <= 2) || (dayRow.outcomeStress != null && dayRow.outcomeStress >= 4)) {
    return 'redline';
  }
  if (dayRow.factors.workoutDone) return 'recovery';
  if ((dayRow.habitRate != null && dayRow.habitRate >= 0.8) || (dayRow.todoRate != null && dayRow.todoRate >= 0.8)) {
    return 'beast';
  }
  return 'steady';
}

function computeModeBreakdown(dayRows) {
  const counts = { redline: 0, recovery: 0, beast: 0, steady: 0 };
  let total = 0;
  (dayRows || []).forEach(r => {
    if (!dayHasModeSignal(r)) return;
    counts[classifyDayMode(r)]++;
    total++;
  });
  if (!total) return null;
  const rates = {};
  Object.keys(counts).forEach(k => { rates[k] = counts[k] / total; });
  return { counts, rates, total };
}

function computeCurrentMode(dayRows) {
  for (let i = 0; i < (dayRows || []).length; i++) {
    if (dayHasModeSignal(dayRows[i])) return classifyDayMode(dayRows[i]);
  }
  return null;
}

// ==================== classifyDayMode ====================
{
  assertEq(classifyDayMode(mkRow({ sleepQuality: 1 })), 'redline', 'very poor sleep quality alone is Redline');
  assertEq(classifyDayMode(mkRow({ outcomeStress: 5 })), 'redline', 'very high stress alone is Redline');
  assertEq(classifyDayMode(mkRow({ sleepQuality: 1, factors: { workoutDone: true } })), 'redline', 'Redline takes priority over a logged workout');
  assertEq(classifyDayMode(mkRow({ factors: { workoutDone: true } })), 'recovery', 'a workout day with no rough signal is Recovery');
  assertEq(classifyDayMode(mkRow({ habitRate: 0.9 })), 'beast', 'high habit completion alone is Beast');
  assertEq(classifyDayMode(mkRow({ todoRate: 0.85 })), 'beast', 'high to-do completion alone is Beast');
  assertEq(classifyDayMode(mkRow({ habitRate: 0.9, factors: { workoutDone: true } })), 'recovery', 'Recovery (workout) takes priority over Beast-level habit completion');
  assertEq(classifyDayMode(mkRow({ habitRate: 0.5, todoRate: 0.5 })), 'steady', 'moderate completion with nothing standing out is Steady');
  assertEq(classifyDayMode(mkRow({})), 'steady', 'a completely empty row still classifies as Steady (dayHasModeSignal is the gate, not this function)');
}

// ==================== dayHasModeSignal / computeModeBreakdown ====================
{
  // 10 days: 3 redline, 2 recovery, 2 beast, 3 steady — plus 5 fully-unlogged days that must be excluded.
  const dayRows = [];
  for (let i = 0; i < 3; i++) dayRows.push(mkRow({ sleepQuality: 1 }));
  for (let i = 0; i < 2; i++) dayRows.push(mkRow({ factors: { workoutDone: true } }));
  for (let i = 0; i < 2; i++) dayRows.push(mkRow({ habitRate: 0.9 }));
  for (let i = 0; i < 3; i++) dayRows.push(mkRow({ habitRate: 0.5, todoRate: 0.5 }));
  for (let i = 0; i < 5; i++) dayRows.push(mkRow({})); // fully unlogged

  const breakdown = computeModeBreakdown(dayRows);
  assertTrue(!!breakdown, 'a mix of real and empty days still produces a breakdown');
  assertEq(breakdown.total, 10, 'fully-unlogged days (no signal at all) are excluded from the total, not counted as Steady');
  assertEq(breakdown.counts.redline, 3, 'redline count matches');
  assertEq(breakdown.counts.recovery, 2, 'recovery count matches');
  assertEq(breakdown.counts.beast, 2, 'beast count matches');
  assertEq(breakdown.counts.steady, 3, 'steady count matches (only the real steady days, not the unlogged ones)');
  assertClose(breakdown.rates.redline, 0.3, 'redline rate is counts/total over only the real days');

  assertEq(computeModeBreakdown([]), null, 'no day rows at all returns null');
  assertEq(computeModeBreakdown([mkRow({})]), null, 'a single fully-unlogged day returns null rather than a fake 100% Steady');
}

// ==================== computeCurrentMode ====================
{
  // Most-recent-first: today has no data logged yet, yesterday was a workout day.
  const dayRows = [mkRow({}), mkRow({ factors: { workoutDone: true } }), mkRow({ sleepQuality: 1 })];
  assertEq(computeCurrentMode(dayRows), 'recovery', 'skips a fully-unlogged most-recent day and reports the most recent day that actually has data');

  assertEq(computeCurrentMode([mkRow({}), mkRow({})]), null, 'no real signal anywhere in the window returns null rather than guessing Steady');
  assertEq(computeCurrentMode([]), null, 'an empty dayRows array returns null');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
