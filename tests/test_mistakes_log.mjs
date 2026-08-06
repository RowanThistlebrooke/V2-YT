// Standalone verification of mistakes.html's Mistake/Risk Log analytics
// (clean-streak-since-last-Major, category breakdown, severity mix, and the
// recurring-threads word-frequency detector). mistakes.html has no module
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

const STOPWORDS = new Set([
  'the','and','that','this','have','with','from','were','been','would','could',
  'should','about','again','after','before','because','just','really','when',
  'then','than','also','very','much','more','some','what','which','their',
  'there','these','those','being','doing','into','onto','over','under','still',
  'even','only','them','they','your','mine','ours','said','told','went','done',
  'didnt','wasnt','wont','cant','dont','isnt','youre','myself','something',
  'anything','everything','nothing','around','always','never','probably',
  'actually','basically','literally','kind','sort','like','know','think',
  'time','times','day','days','week','weeks','instead','again','back','made',
  'make','doesnt','wasn','didn','couldn','shouldn','wouldn',
]);

function daysSinceLastSeverity(items, severity, nowMs) {
  const matches = (items || []).filter(i => i.severity === severity);
  if (!matches.length) return null;
  const mostRecentTs = Math.max.apply(null, matches.map(i => i.ts || 0));
  return Math.floor((nowMs - mostRecentTs) / 86400000);
}

function categoryBreakdown(items) {
  const counts = {};
  (items || []).forEach(i => {
    const cat = i.category || 'Other';
    counts[cat] = (counts[cat] || 0) + 1;
  });
  const total = (items || []).length;
  return Object.keys(counts)
    .map(category => ({ category, count: counts[category], pct: total ? counts[category] / total : 0 }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

function severityBreakdown(items) {
  const counts = { minor: 0, moderate: 0, major: 0 };
  (items || []).forEach(i => {
    const sev = i.severity || 'moderate';
    if (counts[sev] != null) counts[sev]++;
  });
  return counts;
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractCommonThreads(items, topN) {
  const freq = {};
  (items || []).forEach(item => {
    const words = new Set(tokenize((item.description || '') + ' ' + (item.lesson || '')));
    words.forEach(w => {
      if (w.length < 4 || STOPWORDS.has(w)) return;
      freq[w] = (freq[w] || 0) + 1;
    });
  });
  return Object.keys(freq)
    .map(word => ({ word, count: freq[word] }))
    .filter(t => t.count >= 2)
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, topN || 8);
}

const DAY = 86400000;
const NOW = new Date('2026-07-25T15:00:00').getTime();

// ==================== daysSinceLastSeverity ====================
{
  assertNull(daysSinceLastSeverity([], 'major', NOW), 'no entries at all returns null (no major ever logged)');
  assertNull(daysSinceLastSeverity([{ severity: 'minor', ts: NOW }], 'major', NOW), 'entries exist but none are Major returns null');

  const items = [
    { severity: 'major', ts: NOW - 10 * DAY },
    { severity: 'major', ts: NOW - 3 * DAY }, // most recent major
    { severity: 'minor', ts: NOW }, // ignored, wrong severity
  ];
  assertEq(daysSinceLastSeverity(items, 'major', NOW), 3, 'picks days since the MOST RECENT major, not the oldest');
  assertEq(daysSinceLastSeverity(items, 'major', NOW - 3 * DAY), 0, 'a major logged today reports 0 days since');
}

// ==================== categoryBreakdown ====================
{
  const items = [
    { category: 'Financial' },
    { category: 'Financial' },
    { category: 'Health' },
    { category: undefined }, // defaults to Other
  ];
  const result = categoryBreakdown(items);
  assertEq(result[0], { category: 'Financial', count: 2, pct: 0.5 }, 'Financial (2 of 4) sorts first with a 50% share');
  assertTrue(result.some(r => r.category === 'Other' && r.count === 1), 'a missing category defaults to "Other" rather than being dropped');
  assertEq(categoryBreakdown([]), [], 'no entries returns an empty breakdown, not an error');
}

// ==================== severityBreakdown ====================
{
  const items = [
    { severity: 'minor' }, { severity: 'minor' },
    { severity: 'moderate' },
    { severity: 'major' },
    { severity: undefined }, // defaults to moderate
  ];
  assertEq(severityBreakdown(items), { minor: 2, moderate: 2, major: 1 }, 'a missing severity defaults to moderate, matching the form default');
  assertEq(severityBreakdown([]), { minor: 0, moderate: 0, major: 0 }, 'no entries gives all-zero counts, not undefined');
}

// ==================== tokenize ====================
{
  assertEq(tokenize("Didn't budget for it — spent too much!"), ['didn\'t', 'budget', 'for', 'it', 'spent', 'too', 'much'], 'punctuation is stripped but apostrophes inside words survive');
  assertEq(tokenize(''), [], 'empty text tokenizes to an empty array, not [""]');
  assertEq(tokenize(null), [], 'null text does not throw, tokenizes to empty');
}

// ==================== extractCommonThreads ====================
{
  const items = [
    { description: 'Impulse bought something again, overspent on gadgets.', lesson: 'Need a cooling-off period before big purchases.' },
    { description: 'Impulse decision to skip the gym and it snowballed.', lesson: 'Impulse choices compound fast.' },
    { description: 'Overspent on a night out with friends.', lesson: 'Should have set a budget beforehand.' },
    { description: 'A calm, uneventful day, nothing notable.', lesson: '' },
  ];
  const threads = extractCommonThreads(items, 8);
  const words = threads.map(t => t.word);
  assertTrue(words.includes('impulse'), '"impulse" recurs across 2 separate entries and surfaces as a thread');
  assertTrue(words.includes('overspent'), '"overspent" recurs across 2 separate entries and surfaces as a thread');
  assertTrue(!words.includes('night'), 'a word appearing in only one entry does not count as a recurring thread');

  const impulseThread = threads.find(t => t.word === 'impulse');
  assertEq(impulseThread.count, 2, 'impulse is counted once per ENTRY, not once per occurrence within an entry (entry 2 says "impulse" twice)');

  assertEq(extractCommonThreads([], 8), [], 'no entries returns no threads');

  // A single entry repeating a word many times must not fabricate a
  // "recurring" pattern on its own — it should only ever count as 1.
  const single = [{ description: 'stress stress stress stress stress', lesson: '' }];
  assertEq(extractCommonThreads(single, 8), [], 'one entry repeating a word internally still only counts once, so it never clears the >=2 threshold alone');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
