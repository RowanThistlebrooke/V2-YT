// Standalone verification of finance.html's Net Worth Trajectory logic
// (percentile-based Slow/Typical/Fast scenario projection, same approach
// as gym.html's Weight Trajectory — see test_gym_weight_trajectory.mjs).
// finance.html has no module exports (browser-global IIFE), so this
// duplicates the exact functions to test them in isolation.

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

const NW_TRAJ_MIN_SNAPSHOTS = 3;

function nwPercentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function nwMonthlyRates(points) {
  const rates = [];
  for (let i = 1; i < points.length; i++) {
    const days = (points[i].t - points[i - 1].t) / 86400000;
    if (days <= 0) continue;
    rates.push(((points[i].v - points[i - 1].v) / days) * 30.44);
  }
  return rates;
}

function computeNwScenarios(history, windowDays, goal, nowMs) {
  if (!Array.isArray(history) || history.length < NW_TRAJ_MIN_SNAPSHOTS) return null;
  const cutoff = windowDays ? nowMs - windowDays * 86400000 : -Infinity;
  const windowed = history.filter(p => p.t >= cutoff).sort((a, b) => a.t - b.t);
  if (windowed.length < NW_TRAJ_MIN_SNAPSHOTS) return null;

  const rates = nwMonthlyRates(windowed).sort((a, b) => a - b);
  if (!rates.length) return null;
  const median = nwPercentile(rates, 0.5);
  const p25 = nwPercentile(rates, 0.25);
  const p75 = nwPercentile(rates, 0.75);
  const isShrinking = median <= 0;
  const slowRate = isShrinking ? p75 : p25;
  const fastRate = isShrinking ? p25 : p75;
  const current = windowed[windowed.length - 1].v;

  const scenarios = { slow: slowRate, typical: median, fast: fastRate };
  const etas = {};
  if (goal != null && !isNaN(goal)) {
    Object.keys(scenarios).forEach(key => {
      const rate = scenarios[key];
      const diff = goal - current;
      if (rate === 0 || Math.sign(rate) !== Math.sign(diff)) { etas[key] = null; return; }
      const monthsNeeded = diff / rate;
      etas[key] = new Date(nowMs + monthsNeeded * 30.44 * 86400000);
    });
  }
  return { windowed, current, scenarios, etas, goal };
}

const DAY = 86400000;

// ---- Tests ----

assertNull(computeNwScenarios([{ t: 0, v: 1000 }, { t: DAY, v: 1010 }], 180, 5000, DAY), 'fewer than 3 snapshots returns null');

// Growing net worth, uniform monthly rate.
{
  const t0 = new Date('2026-01-01').getTime();
  const history = [
    { t: t0, v: 10000 },
    { t: t0 + 30 * DAY, v: 11000 }, // +1000/mo
    { t: t0 + 60 * DAY, v: 12000 }, // +1000/mo
    { t: t0 + 90 * DAY, v: 13000 }, // +1000/mo
  ];
  const now = t0 + 90 * DAY;
  const result = computeNwScenarios(history, 180, 20000, now);
  // 1000 raw delta over a 30-day spacing, normalized to a 30.44-day month: 1000 * 30.44/30 = 1014.67.
  assertClose(result.scenarios.typical, 1014.67, 0.5, 'uniform growth: typical monthly rate matches the steady increase (normalized to a 30.44-day month)');
  assertClose(result.scenarios.slow, 1014.67, 0.5, 'uniform growth: slow rate matches (no variance in this fixture)');
  assertTrue(result.etas.typical instanceof Date, 'a goal above current value in the growth direction produces an ETA');
}

// Growing net worth with variance — slow should be the smaller positive
// rate (closer to zero), fast the larger positive rate.
{
  const t0 = new Date('2026-01-01').getTime();
  const history = [
    { t: t0, v: 10000 },
    { t: t0 + 30 * DAY, v: 10200 }, // +200/mo (slow month)
    { t: t0 + 60 * DAY, v: 11200 }, // +1000/mo (fast month)
    { t: t0 + 90 * DAY, v: 11800 }, // +600/mo
  ];
  const now = t0 + 90 * DAY;
  const result = computeNwScenarios(history, 180, 20000, now);
  assertTrue(result.scenarios.slow < result.scenarios.fast, 'growing with variance: slow rate is smaller (closer to zero) than fast rate');
  assertTrue(result.scenarios.typical <= result.scenarios.fast && result.scenarios.typical >= result.scenarios.slow, 'growing with variance: typical sits between slow and fast');
}

// Shrinking net worth — direction flips: slow is the LESS-negative rate,
// fast is the MORE-negative one.
{
  const t0 = new Date('2026-01-01').getTime();
  const history = [
    { t: t0, v: 20000 },
    { t: t0 + 30 * DAY, v: 19500 }, // -500/mo
    { t: t0 + 60 * DAY, v: 18000 }, // -1500/mo
    { t: t0 + 90 * DAY, v: 17200 }, // -800/mo
  ];
  const now = t0 + 90 * DAY;
  const result = computeNwScenarios(history, 180, 10000, now);
  assertTrue(result.scenarios.slow > result.scenarios.fast, 'shrinking net worth: slow rate is less negative than fast rate');
}

// A goal below current value with a positive (growing) trend should not
// get a false "reached in the past" ETA treated as a real projection —
// direction mismatch guard.
{
  const t0 = new Date('2026-01-01').getTime();
  const history = [
    { t: t0, v: 10000 },
    { t: t0 + 30 * DAY, v: 10500 },
    { t: t0 + 60 * DAY, v: 11000 },
  ];
  const now = t0 + 60 * DAY;
  const result = computeNwScenarios(history, 180, 5000, now); // goal is BELOW current, trend is growing
  assertNull(result.etas.typical, 'a goal already behind a growing trend is not projected as a false forward ETA');
}

// Old snapshots outside the window are excluded.
{
  const t0 = new Date('2025-01-01').getTime();
  const recentStart = new Date('2026-01-01').getTime();
  const history = [
    { t: t0, v: 500 }, // over a year stale
    { t: recentStart, v: 10000 },
    { t: recentStart + 30 * DAY, v: 10500 },
    { t: recentStart + 60 * DAY, v: 11000 },
  ];
  const now = recentStart + 60 * DAY;
  const result = computeNwScenarios(history, 180, 20000, now);
  assertEq(result.windowed.length, 3, 'a snapshot from over a year ago is excluded from the 180-day window');
  assertEq(result.current, 11000, 'current value is the most recent IN-WINDOW snapshot, not skewed by the stale one');
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---\n');
if (fail > 0) process.exit(1);
