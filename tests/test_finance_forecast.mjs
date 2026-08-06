// Standalone verification of finance.html's net worth forecasting logic.
// finance.html has no module exports (browser-global IIFE), so this
// duplicates computeNetWorthTrend()/projectDateToReach()/
// nextRoundMilestone()/purchaseImpactDays() verbatim, mirroring this repo's
// established approach for testing gym.html/peak.html/finance.html's pure
// logic without a DOM (see test_finance_price_creep.mjs, test_finance_debt_payoff.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function computeNetWorthTrend(history, windowDays) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const cutoff = windowDays ? Date.now() - windowDays * 86400000 : -Infinity;
  const pts = history.filter(p => p.t >= cutoff);
  if (pts.length < 2) return null;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 86400000);
  const ys = pts.map(p => p.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0), sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0), sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slopePerDay = (n * sumXY - sumX * sumY) / denom;
  return { slopePerDay, monthlyRate: slopePerDay * 30.44, currentValue: ys[ys.length - 1], samples: n, windowStartT: pts[0].t };
}
function projectDateToReach(currentValue, monthlyRate, targetValue) {
  if (!(monthlyRate > 0)) return null;
  if (targetValue <= currentValue) return { months: 0, date: new Date() };
  const monthsNeeded = (targetValue - currentValue) / monthlyRate;
  const d = new Date();
  d.setDate(d.getDate() + Math.round(monthsNeeded * 30.44));
  return { months: monthsNeeded, date: d };
}
function nextRoundMilestone(currentValue) {
  if (!(currentValue > 0)) return 10000;
  const magnitude = Math.pow(10, Math.floor(Math.log10(currentValue)));
  const step = magnitude / 2;
  return Math.ceil((currentValue + 1) / step) * step;
}
function purchaseImpactDays(amount, monthlyRate) {
  if (!(monthlyRate > 0) || !(amount > 0)) return null;
  const dailyRate = monthlyRate / 30.44;
  return Math.round(amount / dailyRate);
}

function daysAgo(n) { return Date.now() - n * 86400000; }

// ==================== computeNetWorthTrend ====================
{
  assertEq(computeNetWorthTrend(null), null, 'null history -> null, not a crash');
  assertEq(computeNetWorthTrend([]), null, 'empty history -> null');
  assertEq(computeNetWorthTrend([{ t: Date.now(), v: 1000 }]), null, 'a single data point cannot fit a trend line');

  // A clean, perfectly linear +1000/day trend over 10 days.
  const linear = [];
  for (let i = 9; i >= 0; i--) linear.push({ t: daysAgo(i), v: 10000 + (9 - i) * 1000 });
  const trend = computeNetWorthTrend(linear, 180);
  assertTrue(!!trend, 'a real trend is computed for genuinely linear data');
  assertTrue(Math.abs(trend.slopePerDay - 1000) < 1, 'the fitted slope matches the actual per-day rate (~1000/day): got ' + trend.slopePerDay);
  assertTrue(Math.abs(trend.monthlyRate - 30440) < 100, 'monthlyRate is slopePerDay * 30.44');
  assertEq(trend.currentValue, 19000, 'currentValue is the most recent data point in the window');
  assertEq(trend.samples, 10, 'samples counts every point within the window');

  // A flat/declining trend produces a negative or zero slope, not a crash.
  const declining = [];
  for (let i = 9; i >= 0; i--) declining.push({ t: daysAgo(i), v: 10000 - (9 - i) * 500 });
  const decliningTrend = computeNetWorthTrend(declining, 180);
  assertTrue(decliningTrend.slopePerDay < 0, 'a declining net worth history produces a negative slope');

  // Points outside the window are excluded from the fit.
  const withOldOutlier = [{ t: daysAgo(400), v: -1000000 }].concat(linear); // a wildly different old point, way outside a 180-day window
  const windowedTrend = computeNetWorthTrend(withOldOutlier, 180);
  assertEq(windowedTrend.samples, 10, 'a data point older than the window is excluded from the fit, not just from display');
  assertTrue(Math.abs(windowedTrend.slopePerDay - 1000) < 1, 'the excluded outlier does not skew the fitted slope');
}

// ==================== projectDateToReach ====================
{
  assertEq(projectDateToReach(1000, 0, 5000), null, 'a zero monthly rate cannot project forward');
  assertEq(projectDateToReach(1000, -500, 5000), null, 'a negative (declining) monthly rate cannot project forward');
  assertEq(projectDateToReach(5000, 1000, 3000).months, 0, 'a target already below the current value needs 0 months');

  const proj = projectDateToReach(10000, 1000, 13000);
  assertEq(proj.months, 3, '(13000-10000)/1000 = 3 months needed');
  const expectedDate = new Date();
  expectedDate.setDate(expectedDate.getDate() + Math.round(3 * 30.44));
  assertEq(proj.date.toDateString(), expectedDate.toDateString(), 'the projected date is months-needed * ~30.44 days from now');
}

// ==================== nextRoundMilestone ====================
{
  assertEq(nextRoundMilestone(0), 10000, 'a zero/negative current value falls back to a sane default milestone');
  assertEq(nextRoundMilestone(47000), 50000, '47,000 rounds up to the next 5,000-scale milestone (50,000)');
  assertEq(nextRoundMilestone(470000), 500000, 'the same rounding logic scales up correctly at higher magnitudes');
  assertEq(nextRoundMilestone(4700), 5000, 'and scales down correctly at lower magnitudes');
  assertTrue(nextRoundMilestone(50000) > 50000, 'a value already exactly on a round number still projects to the NEXT one, not itself');
}

// ==================== purchaseImpactDays ====================
{
  assertEq(purchaseImpactDays(1000, 0), null, 'no impact estimate when there is no positive monthly rate');
  assertEq(purchaseImpactDays(0, 1000), null, 'a zero/negative purchase amount has no meaningful impact to report');
  // monthlyRate 30440 -> dailyRate 1000 -> a 5000 purchase costs ~5 days.
  assertEq(purchaseImpactDays(5000, 30440), 5, 'a purchase costing 5x the daily savings rate delays the timeline by ~5 days');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
