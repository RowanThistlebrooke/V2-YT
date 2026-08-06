// Standalone verification of gym.html's Weight Trajectory logic (percentile
// based Slow/Typical/Fast scenario projection). gym.html has no module
// exports (browser-global IIFE), so this duplicates the exact functions to
// test them in isolation, mirroring this repo's established approach for
// testing embedded-HTML pure logic without a DOM.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertNull(actual, label) { assertTrue(actual === null, label); }
function assertClose(actual, expected, tol, label) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected ~:', expected, '\n  actual:   ', actual); }
}

function wtParseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function trajPercentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function trajWeeklyRates(entries) {
  const rates = [];
  for (let i = 1; i < entries.length; i++) {
    const days = (wtParseKey(entries[i].dateKey) - wtParseKey(entries[i - 1].dateKey)) / 86400000;
    if (days <= 0) continue;
    rates.push(((entries[i].weight - entries[i - 1].weight) / days) * 7);
  }
  return rates;
}

const TRAJ_MIN_ENTRIES = 3;

function trajCompute(entries, goal, windowDays, nowMs) {
  const cutoff = nowMs - windowDays * 86400000;
  const windowed = entries.filter(e => wtParseKey(e.dateKey).getTime() >= cutoff);
  if (windowed.length < TRAJ_MIN_ENTRIES) return null;

  const rates = trajWeeklyRates(windowed).sort((a, b) => a - b);
  if (!rates.length) return null;
  const median = trajPercentile(rates, 0.5);
  const p25 = trajPercentile(rates, 0.25);
  const p75 = trajPercentile(rates, 0.75);
  const isLosing = median <= 0;
  const slowRate = isLosing ? p75 : p25;
  const fastRate = isLosing ? p25 : p75;
  const current = windowed[windowed.length - 1].weight;

  const scenarios = { slow: slowRate, typical: median, fast: fastRate };
  const etas = {};
  if (goal != null && !isNaN(goal)) {
    Object.keys(scenarios).forEach(key => {
      const rate = scenarios[key];
      const diff = goal - current;
      if (rate === 0 || Math.sign(rate) !== Math.sign(diff)) { etas[key] = null; return; }
      const weeksNeeded = diff / rate;
      etas[key] = new Date(nowMs + weeksNeeded * 7 * 86400000);
    });
  }
  return { windowed, current, scenarios, etas, goal };
}

// ---- Tests ----

assertNull(trajCompute([{ dateKey: '2026-01-01', weight: 80 }], 75, 90, Date.now()), 'fewer than 3 entries in window returns null');

// Perfectly linear decline: every scenario should agree exactly.
{
  const entries = [
    { dateKey: '2026-01-01', weight: 85 },
    { dateKey: '2026-01-08', weight: 84.3 },
    { dateKey: '2026-01-15', weight: 83.6 },
    { dateKey: '2026-01-22', weight: 82.9 },
  ];
  const now = new Date('2026-01-22T00:00:00').getTime();
  const result = trajCompute(entries, 78, 90, now);
  assertClose(result.scenarios.slow, -0.7, 0.001, 'perfectly linear decline: slow rate matches the uniform weekly drop');
  assertClose(result.scenarios.typical, -0.7, 0.001, 'perfectly linear decline: typical rate matches the uniform weekly drop');
  assertClose(result.scenarios.fast, -0.7, 0.001, 'perfectly linear decline: fast rate matches the uniform weekly drop');
  assertTrue(result.etas.typical instanceof Date, 'a goal in the direction of travel produces a projected ETA date');
}

// Losing weight: slow scenario should be the LESS-negative (closer to
// zero) rate, fast should be the MORE-negative one — not just whichever
// percentile index happens to be picked blindly.
{
  const entries = [
    { dateKey: '2026-01-01', weight: 90 },
    { dateKey: '2026-01-08', weight: 89.5 }, // -0.5/wk (slow week)
    { dateKey: '2026-01-15', weight: 88.0 }, // -1.5/wk (fast week)
    { dateKey: '2026-01-22', weight: 87.2 }, // -0.8/wk (typical-ish)
  ];
  const now = new Date('2026-01-22T00:00:00').getTime();
  const result = trajCompute(entries, 80, 90, now);
  assertTrue(result.scenarios.slow > result.scenarios.fast, 'losing weight: slow rate is less negative (smaller magnitude) than fast rate');
  assertTrue(result.scenarios.typical <= result.scenarios.slow && result.scenarios.typical >= result.scenarios.fast, 'losing weight: typical rate sits between slow and fast');
}

// Gaining weight (bulking): direction flips — slow should be the smaller
// positive rate, fast the larger positive rate.
{
  const entries = [
    { dateKey: '2026-01-01', weight: 70 },
    { dateKey: '2026-01-08', weight: 70.3 }, // +0.3/wk
    { dateKey: '2026-01-15', weight: 71.0 }, // +0.7/wk
    { dateKey: '2026-01-22', weight: 71.6 }, // +0.6/wk
  ];
  const now = new Date('2026-01-22T00:00:00').getTime();
  const result = trajCompute(entries, 80, 90, now);
  assertTrue(result.scenarios.slow < result.scenarios.fast, 'gaining weight: slow rate is the smaller positive rate, fast is larger');
}

// A goal on the WRONG side of the current trend (e.g. still trying to
// lose while the trend is flat/gaining) should not be projected as a
// false ETA — same "direction must match" guard as the original
// insights.html computeTimeToGoal.
{
  const entries = [
    { dateKey: '2026-01-01', weight: 80 },
    { dateKey: '2026-01-08', weight: 80.2 },
    { dateKey: '2026-01-15', weight: 80.4 },
    { dateKey: '2026-01-22', weight: 80.6 },
  ];
  const now = new Date('2026-01-22T00:00:00').getTime();
  const result = trajCompute(entries, 75, 90, now); // goal is LOWER, trend is rising
  assertNull(result.etas.typical, 'a goal in the opposite direction of the trend is not projected (no false ETA)');
}

// Entries outside the window are excluded from both the rate calculation
// and the "current" weight.
{
  const entries = [
    { dateKey: '2025-01-01', weight: 100 }, // far outside any reasonable window
    { dateKey: '2026-01-01', weight: 85 },
    { dateKey: '2026-01-08', weight: 84 },
    { dateKey: '2026-01-15', weight: 83 },
  ];
  const now = new Date('2026-01-15T00:00:00').getTime();
  const result = trajCompute(entries, 78, 90, now);
  assertEq(result.windowed.length, 3, 'an entry from over a year ago is excluded from the 90-day window');
  assertEq(result.current, 83, 'current weight is the most recent IN-WINDOW entry, not skewed by the stale one');
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---\n');
if (fail > 0) process.exit(1);
