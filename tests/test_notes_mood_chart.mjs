// Standalone verification of notes.html's mood-trend logic. notes.html has
// no module exports (browser-global IIFE), so this duplicates the exact
// logic from scoreNoteText()/computeMoodByDay() to test it in isolation,
// mirroring this repo's established approach for testing embedded-HTML
// pure logic without a DOM (see test_rest_timer_logic.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const MOOD_POSITIVE_WORDS = ['happy', 'grateful', 'thankful', 'excited', 'proud', 'calm', 'relieved', 'hopeful',
  'love', 'loved', 'great', 'good', 'amazing', 'wonderful', 'accomplished', 'energized', 'motivated', 'peaceful',
  'joy', 'joyful', 'confident', 'optimistic', 'content', 'blessed', 'excellent', 'fantastic', 'fun', 'glad',
  'relaxed', 'strong'];
const MOOD_NEGATIVE_WORDS = ['sad', 'anxious', 'anxiety', 'stressed', 'stress', 'angry', 'mad', 'frustrated',
  'frustrating', 'tired', 'exhausted', 'worried', 'worry', 'overwhelmed', 'lonely', 'alone', 'hopeless', 'awful',
  'bad', 'terrible', 'hate', 'hurt', 'scared', 'afraid', 'guilty', 'ashamed', 'depressed', 'upset', 'annoyed',
  'miserable', 'crying', 'cried', 'fear', 'panic', 'disappointed'];

function scoreNoteText(text) {
  const words = (text || '').toLowerCase().match(/[a-z']+/g) || [];
  let pos = 0, neg = 0;
  words.forEach(w => {
    if (MOOD_POSITIVE_WORDS.indexOf(w) !== -1) pos++;
    else if (MOOD_NEGATIVE_WORDS.indexOf(w) !== -1) neg++;
  });
  if (pos + neg === 0) return null;
  return (pos - neg) / (pos + neg);
}

function moodDateKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function computeMoodByDay(notes) {
  const byDay = {};
  notes.forEach(n => {
    const score = scoreNoteText((n.title || '') + ' ' + (n.body || ''));
    if (score == null) return;
    const key = moodDateKey(n.updatedAt);
    (byDay[key] = byDay[key] || []).push(score);
  });
  return Object.keys(byDay).sort().map(date => ({
    date, score: byDay[date].reduce((a, b) => a + b, 0) / byDay[date].length,
  }));
}

// ==================== scoreNoteText ====================
{
  assertEq(scoreNoteText('I am so happy and grateful today'), 1, 'all-positive text scores +1');
  assertEq(scoreNoteText('I feel so sad and exhausted'), -1, 'all-negative text scores -1');
  assertEq(scoreNoteText('happy but also stressed'), 0, 'one positive + one negative word cancels out to 0');
  assertEq(scoreNoteText(''), null, 'empty text has no signal');
  assertEq(scoreNoteText('Buy milk, call the bank, fix the sink'), null, 'a plain to-do list with no sentiment words has no signal');
  assertEq(scoreNoteText('HAPPY happy Happy'), 1, 'matching is case-insensitive');
  assertTrue(scoreNoteText('grateful grateful sad') > 0, 'weighting reflects word counts, not just presence');
}

// ==================== computeMoodByDay ====================
{
  const ts1 = new Date(2026, 0, 1, 9, 0).getTime();
  const ts2 = new Date(2026, 0, 1, 21, 0).getTime(); // same day, later
  const ts3 = new Date(2026, 0, 2, 9, 0).getTime();
  const notes = [
    { title: '', body: 'happy and grateful', updatedAt: ts1 },
    { title: '', body: 'sad', updatedAt: ts2 }, // same day as ts1 -> averages with it
    { title: '', body: 'buy milk', updatedAt: ts3 }, // no signal -> excluded entirely
  ];
  const byDay = computeMoodByDay(notes);
  assertEq(byDay.length, 1, 'a day with no sentiment-bearing notes contributes no point at all');
  assertEq(byDay[0].date, '2026-01-01', 'the one remaining day is the one with actual signal');
  assertTrue(Math.abs(byDay[0].score - 0) < 1e-9, 'two notes the same day average to a single score (1 and -1 -> 0)');

  assertEq(computeMoodByDay([]), [], 'no notes at all produces no points');
  assertEq(computeMoodByDay([{ title: '', body: 'todo list', updatedAt: ts1 }]), [], 'notes with zero sentiment signal produce no points');

  // Chronological ordering across multiple days.
  const multi = [
    { title: '', body: 'terrible day', updatedAt: new Date(2026, 1, 3).getTime() },
    { title: '', body: 'wonderful day', updatedAt: new Date(2026, 1, 1).getTime() },
    { title: '', body: 'good day', updatedAt: new Date(2026, 1, 2).getTime() },
  ];
  const days = computeMoodByDay(multi);
  assertEq(days.map(d => d.date), ['2026-02-01', '2026-02-02', '2026-02-03'], 'points come back sorted chronologically regardless of note order');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
