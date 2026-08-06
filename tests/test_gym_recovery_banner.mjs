// Standalone verification of gym.html's recovery-adaptive banner logic.
// gym.html has no module exports (browser-global IIFE) and loadRecoverySignal
// itself does a live fetch()/localStorage read that isn't meaningfully
// testable outside a browser (covered instead by a manual Playwright smoke
// test across three scenarios) — but the actual THRESHOLD/classification
// decisions and the banner text composition are pure and worth locking in
// precisely, duplicated verbatim, same approach as this repo's other
// DOM-free pure-logic tests.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const RECOVERY_WHOOP_POOR_THRESHOLD = 33;
const RECOVERY_SLEEP_QUALITY_POOR_THRESHOLD = 2;
function classifyWhoopRecovery(score) { return { source: 'whoop', value: Math.round(score), poor: score < RECOVERY_WHOOP_POOR_THRESHOLD }; }
function classifySleepQuality(q) { return { source: 'sleep', value: q, poor: q <= RECOVERY_SLEEP_QUALITY_POOR_THRESHOLD }; }
function renderRecoveryBannerText(signal) {
  if (!signal || !signal.poor) return null;
  const label = signal.source === 'whoop'
    ? ('WHOOP recovery is ' + signal.value + '% today')
    : ("last night's sleep was rough (" + signal.value + '/5)');
  return '⚠️ ' + label + ' — maybe trim volume/intensity today, or take it easy.';
}

// ==================== WHOOP recovery classification ====================
{
  assertEq(classifyWhoopRecovery(10).poor, true, 'a low WHOOP recovery score (10%) is classified as poor');
  assertEq(classifyWhoopRecovery(32).poor, true, 'a score just under the threshold (32%) is poor');
  assertEq(classifyWhoopRecovery(33).poor, false, 'the threshold itself (33%) is NOT poor — strictly less-than, matching WHOOP\'s own red-zone convention');
  assertEq(classifyWhoopRecovery(80).poor, false, 'a high recovery score (80%) is not poor');
  assertEq(classifyWhoopRecovery(45.7).value, 46, 'a fractional WHOOP score is rounded to the nearest whole percent for display');
}

// ==================== manual sleep-quality classification ====================
{
  assertEq(classifySleepQuality(1).poor, true, 'sleepQuality 1 is poor');
  assertEq(classifySleepQuality(2).poor, true, 'sleepQuality 2 (the threshold) IS poor — at/below, matching SLEEP_POOR_THRESHOLD in api/send-reminders.js');
  assertEq(classifySleepQuality(3).poor, false, 'sleepQuality 3 is not poor');
  assertEq(classifySleepQuality(5).poor, false, 'sleepQuality 5 is not poor');
}

// ==================== banner text composition ====================
{
  assertEq(renderRecoveryBannerText(null), null, 'no signal at all produces no banner text');
  assertEq(renderRecoveryBannerText({ source: 'whoop', value: 80, poor: false }), null, 'a non-poor signal produces no banner text, even if present');

  const whoopText = renderRecoveryBannerText({ source: 'whoop', value: 22, poor: true });
  assertTrue(whoopText.includes('WHOOP recovery is 22%'), 'a poor WHOOP signal produces text mentioning the actual percentage: "' + whoopText + '"');
  assertTrue(whoopText.includes('trim volume/intensity'), 'the banner is suggestion-only phrasing, not a command');

  const sleepText = renderRecoveryBannerText({ source: 'sleep', value: 1, poor: true });
  assertTrue(sleepText.includes('1/5'), 'a poor sleep-quality signal produces text mentioning the actual rating: "' + sleepText + '"');
  assertTrue(!sleepText.includes('WHOOP'), 'the sleep-based fallback never mentions WHOOP when that\'s not the actual source');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
