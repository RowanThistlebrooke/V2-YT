// Standalone verification of insights.html's "Reality vs Plan" adherence
// logic (overall adherence %, adherence trend, most-skipped habits).
// insights.html has no module exports (browser-global IIFE), so this
// duplicates the exact functions to test them in isolation — same approach
// as test_insights_bottleneck.mjs / test_insights_predictive.mjs.

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

const ADHERENCE_TREND_RECENT_DAYS = 14;
const ADHERENCE_TREND_MIN_SAMPLES = 5;
const MOST_SKIPPED_MIN_DAYS = 7;

function computeOverallAdherence(dayRows) {
  const vals = (dayRows || []).map(r => r.consistencyRate).filter(v => v != null);
  if (!vals.length) return null;
  return { rate: avg(vals), n: vals.length };
}

function computeAdherenceTrend(dayRows, recentDays) {
  recentDays = recentDays || ADHERENCE_TREND_RECENT_DAYS;
  const recentVals = (dayRows || []).slice(0, recentDays).map(r => r.consistencyRate).filter(v => v != null);
  const priorVals = (dayRows || []).slice(recentDays).map(r => r.consistencyRate).filter(v => v != null);
  if (recentVals.length < ADHERENCE_TREND_MIN_SAMPLES || priorVals.length < ADHERENCE_TREND_MIN_SAMPLES) return null;
  const recentAvg = avg(recentVals), priorAvg = avg(priorVals);
  return { recentAvg, priorAvg, diff: recentAvg - priorAvg };
}

function computeHabitAdherence(goalsData, dateKeys) {
  const habitDefs = (goalsData && goalsData['habits:defs']) || [];
  const habitLog = (goalsData && goalsData['habits:log']) || {};
  if (!dateKeys || dateKeys.length < MOST_SKIPPED_MIN_DAYS) return [];
  return habitDefs
    .map(h => {
      const done = dateKeys.filter(dk => habitLog[h.id] && habitLog[h.id][dk]).length;
      return { id: h.id, name: h.name, rate: done / dateKeys.length, n: dateKeys.length };
    })
    .sort((a, b) => a.rate - b.rate);
}

// ==================== computeOverallAdherence ====================
{
  const dayRows = [{ consistencyRate: 0.8 }, { consistencyRate: 0.4 }, { consistencyRate: null }, { consistencyRate: 0.6 }];
  const result = computeOverallAdherence(dayRows);
  assertTrue(!!result, 'days with any consistencyRate produce a result');
  assertClose(result.rate, 0.6, 'rate averages only the non-null days');
  assertEq(result.n, 3, 'n counts only days with real data, excluding nulls');

  assertEq(computeOverallAdherence([]), null, 'no day rows at all returns null');
  assertEq(computeOverallAdherence([{ consistencyRate: null }]), null, 'all-null day rows returns null rather than a fake 0');
}

// ==================== computeAdherenceTrend ====================
{
  const dayRows = [];
  for (let i = 0; i < 14; i++) dayRows.push({ consistencyRate: 0.3 }); // recent: worse
  for (let i = 0; i < 20; i++) dayRows.push({ consistencyRate: 0.7 }); // prior: better
  const trend = computeAdherenceTrend(dayRows);
  assertTrue(!!trend, 'enough samples on both sides produces a trend');
  assertClose(trend.recentAvg, 0.3, 'recentAvg covers the first ADHERENCE_TREND_RECENT_DAYS rows');
  assertClose(trend.priorAvg, 0.7, 'priorAvg covers everything after that');
  assertClose(trend.diff, -0.4, 'diff is recentAvg - priorAvg, negative when adherence has fallen');

  const tooFewPrior = computeAdherenceTrend(dayRows.slice(0, 16));
  assertEq(tooFewPrior, null, 'fewer than the minimum samples on the prior side returns null');

  const sparseRecent = [{ consistencyRate: 0.5 }, { consistencyRate: 0.5 }];
  for (let i = 0; i < 12; i++) sparseRecent.push({ consistencyRate: null });
  const tooFewRecent = computeAdherenceTrend(sparseRecent.concat(dayRows.slice(14)));
  assertEq(tooFewRecent, null, 'fewer than the minimum samples on the recent side returns null');
}

// ==================== computeHabitAdherence ====================
{
  const dateKeys = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'];
  const goalsData = {
    'habits:defs': [{ id: 'h1', name: 'Meditate' }, { id: 'h2', name: 'Read' }, { id: 'h3', name: 'Journal' }],
    'habits:log': {
      h1: { '2026-01-01': true, '2026-01-02': true, '2026-01-03': true, '2026-01-04': true, '2026-01-05': true, '2026-01-06': true, '2026-01-07': true },
      h2: { '2026-01-01': true },
      // h3 has no log entries at all -> 0%
    },
  };
  const ranked = computeHabitAdherence(goalsData, dateKeys);
  assertEq(ranked.length, 3, 'every defined habit is included, even ones with zero completions');
  assertEq(ranked[0].id, 'h3', 'the least-completed habit (Journal, 0%) is ranked first (worst-first)');
  assertEq(ranked[0].rate, 0, 'a habit with no logged completions has a rate of exactly 0, not null');
  assertEq(ranked[1].id, 'h2', 'the middling habit (Read, 1/7) is ranked second');
  assertClose(ranked[1].rate, 1 / 7, 'rate is completions / total window days');
  assertEq(ranked[2].id, 'h1', 'the fully-completed habit (Meditate, 7/7) is ranked last (best)');
  assertEq(ranked[2].rate, 1, 'a fully completed habit has a rate of 1');

  assertEq(computeHabitAdherence({}, dateKeys), [], 'no habit defs at all returns an empty ranking, not an error');
  assertEq(computeHabitAdherence(goalsData, dateKeys.slice(0, 3)), [], 'too few days of window history returns an empty ranking rather than an unreliable one');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
