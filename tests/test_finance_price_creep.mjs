// Standalone verification of finance.html's subscription price-creep logic.
// finance.html has no module exports (browser-global IIFE), so this
// duplicates monthlyEquivalent()/priceCreepInfo() verbatim, mirroring this
// repo's established approach for testing gym.html/peak.html's pure logic
// without a DOM (see test_peak_insights_logic.mjs, test_rest_timer_logic.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function monthlyEquivalent(item) {
  const a = Number(item.amount) || 0;
  if (item.period === 'yearly') return a / 12;
  if (item.period === 'weekly') return a * 4.345;
  return a;
}

const PRICE_CREEP_MIN_PCT = 3;
function priceCreepInfo(it) {
  if (!Array.isArray(it.priceHistory) || it.priceHistory.length < 1) return null;
  const first = it.priceHistory[0];
  if (!first || !(first.amountCHF > 0)) return null;
  const deltaCHF = it.amount - first.amountCHF;
  const pct = (deltaCHF / first.amountCHF) * 100;
  if (pct < PRICE_CREEP_MIN_PCT) return null;
  return { pct, deltaCHF, sinceTs: first.ts };
}

// ==================== monthlyEquivalent ====================
{
  assertEq(monthlyEquivalent({ amount: 10, period: 'monthly' }), 10, 'monthly period returns the amount as-is');
  assertEq(monthlyEquivalent({ amount: 120, period: 'yearly' }), 10, 'yearly period divides by 12');
  assertEq(Math.round(monthlyEquivalent({ amount: 10, period: 'weekly' }) * 100) / 100, 43.45, 'weekly period multiplies by 4.345 (average weeks/month)');
  assertEq(monthlyEquivalent({ amount: 'not a number', period: 'monthly' }), 0, 'a non-numeric amount safely falls back to 0 rather than NaN');
}

// ==================== priceCreepInfo ====================
{
  assertEq(priceCreepInfo({ amount: 10 }), null, 'no priceHistory at all -> null, not a crash');
  assertEq(priceCreepInfo({ amount: 10, priceHistory: [] }), null, 'an empty priceHistory array -> null');

  // No real change yet — current amount matches the first recorded point.
  const noChange = priceCreepInfo({ amount: 10, priceHistory: [{ amountCHF: 10, ts: 1000 }] });
  assertEq(noChange, null, 'current amount equal to the first tracked amount -> no creep reported');

  // A real increase above the noise threshold.
  const upResult = priceCreepInfo({ amount: 11, priceHistory: [{ amountCHF: 10, ts: 1000 }] });
  assertTrue(!!upResult, 'a genuine price increase returns a result');
  assertEq(upResult.pct, 10, '10 -> 11 is correctly computed as a 10% increase');
  assertEq(Math.round(upResult.deltaCHF * 100) / 100, 1, 'deltaCHF reflects the absolute CHF increase');
  assertEq(upResult.sinceTs, 1000, 'sinceTs reflects the timestamp of the FIRST tracked point, not the latest');

  // A tiny/noise-level increase under the minimum threshold is not reported.
  const tinyChange = priceCreepInfo({ amount: 10.2, priceHistory: [{ amountCHF: 10, ts: 1000 }] });
  assertEq(tinyChange, null, 'a sub-3% increase (rounding/float noise) is not flagged as creep');

  // A DECREASE in price is never flagged as "creep" (creep is specifically about increases).
  const decreased = priceCreepInfo({ amount: 8, priceHistory: [{ amountCHF: 10, ts: 1000 }] });
  assertEq(decreased, null, 'a price decrease is never reported as price creep');

  // Multiple history entries — comparison is always against the FIRST (original), not the most recent prior price.
  const multiHistory = priceCreepInfo({
    amount: 15,
    priceHistory: [{ amountCHF: 10, ts: 1000 }, { amountCHF: 12, ts: 2000 }, { amountCHF: 13, ts: 3000 }],
  });
  assertEq(multiHistory.pct, 50, 'with multiple price-history points, the percentage is always relative to the ORIGINAL first-tracked price (10 -> 15 = 50%), not the most recent prior point');
  assertEq(multiHistory.sinceTs, 1000, 'sinceTs is always the original tracking date, regardless of how many price changes happened since');

  // A malformed first entry (zero/negative/missing amountCHF) is handled safely.
  assertEq(priceCreepInfo({ amount: 10, priceHistory: [{ amountCHF: 0, ts: 1000 }] }), null, 'a zero baseline amount is safely ignored rather than dividing by zero');
  assertEq(priceCreepInfo({ amount: 10, priceHistory: [{ ts: 1000 }] }), null, 'a missing amountCHF field on the first entry is handled without crashing');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
