// Standalone verification of finance.html's debt payoff calculator logic.
// finance.html has no module exports (browser-global IIFE), so this
// duplicates simulatePayoff()/monthsToLabel() verbatim, mirroring this
// repo's established approach for testing gym.html/peak.html's pure logic
// without a DOM (see test_peak_insights_logic.mjs, test_finance_price_creep.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const PAYOFF_MAX_MONTHS = 600;
function simulatePayoff(debts, extraMonthly, strategy) {
  const working = debts.map(d => ({ id: d.id, balance: Number(d.balance) || 0, apr: Number(d.apr) || 0, minPayment: Number(d.minPayment) || 0 }))
    .filter(d => d.balance > 0.01);
  if (!working.length) return { months: 0, totalInterest: 0, payoffOrder: [], maxedOut: false };
  const order = (strategy === 'avalanche')
    ? working.slice().sort((a, b) => b.apr - a.apr)
    : working.slice().sort((a, b) => a.balance - b.balance);
  let months = 0, totalInterest = 0;
  const payoffOrder = [];
  const extra = Math.max(0, Number(extraMonthly) || 0);
  while (working.some(d => d.balance > 0.01) && months < PAYOFF_MAX_MONTHS) {
    months++;
    order.forEach(refD => {
      const d = working.find(w => w.id === refD.id);
      if (!d || d.balance <= 0.01) return;
      const interest = d.balance * (d.apr / 100 / 12);
      totalInterest += interest;
      d.balance += interest;
    });
    let slack = extra;
    order.forEach(refD => {
      const d = working.find(w => w.id === refD.id);
      if (!d) return;
      if (d.balance <= 0.01) { slack += refD.minPayment; return; }
      const pay = Math.min(refD.minPayment, d.balance);
      d.balance -= pay;
    });
    for (const refD of order) {
      if (slack <= 0) break;
      const d = working.find(w => w.id === refD.id);
      if (!d || d.balance <= 0.01) continue;
      const pay = Math.min(slack, d.balance);
      d.balance -= pay;
      slack -= pay;
    }
    order.forEach(refD => {
      const d = working.find(w => w.id === refD.id);
      if (d && d.balance <= 0.01 && !payoffOrder.includes(refD.id)) payoffOrder.push(refD.id);
    });
  }
  return { months, totalInterest, payoffOrder, maxedOut: months >= PAYOFF_MAX_MONTHS };
}
function monthsToLabel(months) {
  const y = Math.floor(months / 12), m = months % 12;
  const parts = [];
  if (y) parts.push(y + (y === 1 ? ' year' : ' years'));
  if (m || !y) parts.push(m + (m === 1 ? ' month' : ' months'));
  return parts.join(', ');
}

// ==================== basic single-debt payoff ====================
{
  // 0% APR, $1200 balance, $100/mo -> exactly 12 months, no interest.
  const result = simulatePayoff([{ id: 'a', balance: 1200, apr: 0, minPayment: 100 }], 0, 'avalanche');
  assertEq(result.months, 12, 'a 0% APR debt paid at exactly its monthly rate finishes in the expected number of months');
  assertEq(Math.round(result.totalInterest), 0, 'no interest accrues at 0% APR');
  assertEq(result.payoffOrder, ['a'], 'the single debt appears in the payoff order once cleared');
  assertEq(result.maxedOut, false, 'a normal payoff is not flagged as maxed out');

  // No debts at all -> trivially instant, no crash.
  assertEq(simulatePayoff([], 500, 'avalanche'), { months: 0, totalInterest: 0, payoffOrder: [], maxedOut: false }, 'an empty debt list returns an immediate, trivial result');

  // Already-paid-off debts (balance 0) are filtered out, not simulated.
  assertEq(simulatePayoff([{ id: 'a', balance: 0, apr: 5, minPayment: 50 }], 0, 'avalanche').months, 0, 'a debt with a zero balance is treated as already paid off');
}

// ==================== avalanche vs snowball ordering ====================
{
  const debts = [
    { id: 'small-high-apr', balance: 500, apr: 25, minPayment: 25 },
    { id: 'big-low-apr', balance: 5000, apr: 4, minPayment: 100 },
  ];
  const avalanche = simulatePayoff(debts, 200, 'avalanche');
  const snowball = simulatePayoff(debts, 200, 'snowball');
  assertEq(avalanche.payoffOrder[0], 'small-high-apr', 'avalanche pays off the HIGHEST-APR debt first, regardless of balance size');
  assertEq(snowball.payoffOrder[0], 'small-high-apr', 'snowball pays off the SMALLEST-BALANCE debt first — happens to be the same debt here, but for the opposite reason');
  assertTrue(avalanche.totalInterest <= snowball.totalInterest, 'avalanche never accrues MORE total interest than snowball for the same debts/extra payment (it is the interest-optimal ordering)');
}

{
  // A case where avalanche and snowball genuinely disagree: the small
  // balance is NOT the high-APR one.
  const debts = [
    { id: 'small-low-apr', balance: 500, apr: 4, minPayment: 25 },
    { id: 'big-high-apr', balance: 5000, apr: 25, minPayment: 100 },
  ];
  const avalanche = simulatePayoff(debts, 300, 'avalanche');
  const snowball = simulatePayoff(debts, 300, 'snowball');
  assertEq(avalanche.payoffOrder[0], 'big-high-apr', 'avalanche targets the high-APR debt first even though it has the larger balance');
  assertEq(snowball.payoffOrder[0], 'small-low-apr', 'snowball targets the small-balance debt first even though it has the lower APR');
  assertTrue(avalanche.totalInterest < snowball.totalInterest, 'when the orderings genuinely differ, avalanche strictly saves interest vs snowball');
}

// ==================== freed-up minimum payments roll into the extra pool ====================
{
  // Two debts, no extra payment at all — once the first is paid off, its
  // minimum payment should roll onto the second (real snowball/avalanche
  // behavior), not just vanish.
  const debts = [
    { id: 'a', balance: 100, apr: 0, minPayment: 100 }, // pays off in month 1
    { id: 'b', balance: 1000, apr: 0, minPayment: 50 },
  ];
  const withRollover = simulatePayoff(debts, 0, 'avalanche');
  // Without rollover this would take 20 months (1000/50); with the freed
  // 100/mo added to b starting month 2, it should finish meaningfully sooner.
  assertTrue(withRollover.months < 20, 'a freed-up minimum payment from an early payoff rolls into the next debt, finishing faster than 1000/50=20 months (' + withRollover.months + ' months)');
}

// ==================== an unpayable configuration is capped, not infinite ====================
{
  // Interest (10%/12 * 10000 ≈ 83/mo) exceeds the minimum payment (50/mo)
  // with zero extra — balance grows forever.
  const result = simulatePayoff([{ id: 'a', balance: 10000, apr: 10, minPayment: 50 }], 0, 'avalanche');
  assertEq(result.maxedOut, true, 'a debt whose minimum payment does not even cover monthly interest is flagged as maxed out rather than looping forever');
  assertEq(result.months, PAYOFF_MAX_MONTHS, 'the simulation stops at the month cap');
}

// ==================== monthsToLabel ====================
{
  assertEq(monthsToLabel(0), '0 months', 'zero months has no year component');
  assertEq(monthsToLabel(1), '1 month', 'singular "month" for exactly 1');
  assertEq(monthsToLabel(11), '11 months', 'under a year is months-only');
  assertEq(monthsToLabel(12), '1 year', 'exactly 12 months is "1 year" with no trailing "0 months"');
  assertEq(monthsToLabel(13), '1 year, 1 month', 'a year plus one month is both parts, both singular');
  assertEq(monthsToLabel(25), '2 years, 1 month', 'plural "years" once past 1');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
