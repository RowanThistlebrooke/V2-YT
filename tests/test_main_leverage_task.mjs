// Standalone verification of main.html's Daily Leverage Task logic: the
// exactly-one-per-day toggle, the day-rollover history/streak folding (the
// only point where a past day's pick is still readable before rollover()
// deletes that day's key for good), the follow-through rate, and the
// time-of-day urgency banding. main.html has no module exports (plain
// inline script), so this duplicates the exact functions to test them in
// isolation — same approach as insights.html's test_insights_*.mjs files.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertNull(actual, label) {
  if (actual === null) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected: null\n  actual:  ', JSON.stringify(actual)); }
}

function toggleLeverageTask(list, idx) {
  if (!list[idx]) return list;
  const turningOn = !list[idx].leverage;
  list.forEach(g => { delete g.leverage; });
  if (turningOn) list[idx].leverage = true;
  return list;
}

const LEVERAGE_HISTORY_MAX = 14;

function processLeverageHistoryDay(stats, dateStr, dayGoals) {
  const s = {
    streak: stats.streak || 0,
    completedCount: stats.completedCount || 0,
    setCount: stats.setCount || 0,
    history: (stats.history || []).slice(),
    lastProcessedDate: stats.lastProcessedDate || '',
  };
  if (!dayGoals.length) { s.lastProcessedDate = dateStr; return s; }

  const leverageGoal = dayGoals.find(g => g.leverage);
  if (!leverageGoal) {
    s.streak = 0;
    s.history.push({ date: dateStr, text: null, done: false });
  } else {
    s.setCount += 1;
    if (leverageGoal.done) { s.streak += 1; s.completedCount += 1; }
    else { s.streak = 0; }
    s.history.push({ date: dateStr, text: leverageGoal.text, done: !!leverageGoal.done });
  }
  if (s.history.length > LEVERAGE_HISTORY_MAX) s.history = s.history.slice(-LEVERAGE_HISTORY_MAX);
  s.lastProcessedDate = dateStr;
  return s;
}

function leverageFollowThroughRate(stats) {
  if (!stats || !stats.setCount) return null;
  return stats.completedCount / stats.setCount;
}

function leverageUrgency(nowHour, wakeHour, sleepHour) {
  const span = sleepHour - wakeHour;
  const elapsed = Math.max(0, Math.min(span, nowHour - wakeHour));
  const frac = span > 0 ? elapsed / span : 0;
  if (frac < 0.4) return 'calm';
  if (frac < 0.75) return 'building';
  return 'urgent';
}

const EMPTY_STATS = { streak: 0, completedCount: 0, setCount: 0, history: [], lastProcessedDate: '' };

// ==================== toggleLeverageTask ====================
{
  const list = [{ text: 'a' }, { text: 'b' }, { text: 'c' }];
  toggleLeverageTask(list, 1);
  assertEq(list.map(g => !!g.leverage), [false, true, false], 'marking an item with none previously set turns just that one on');
}

{
  const list = [{ text: 'a' }, { text: 'b', leverage: true }, { text: 'c' }];
  toggleLeverageTask(list, 1);
  assertEq(list.map(g => !!g.leverage), [false, false, false], 'clicking the already-active item toggles it off, leaving none active');
}

{
  const list = [{ text: 'a' }, { text: 'b', leverage: true }, { text: 'c' }];
  toggleLeverageTask(list, 2);
  assertEq(list.map(g => !!g.leverage), [false, false, true], 'marking a different item clears the previous pick, keeping exactly one active');
}

{
  const list = [{ text: 'a' }];
  const result = toggleLeverageTask(list, 5);
  assertEq(result, list, 'an out-of-range index is a no-op and returns the list unchanged');
  assertEq(list[0].leverage, undefined, 'no item gains a leverage flag from an out-of-range index');
}

{
  const list = [];
  const result = toggleLeverageTask(list, 0);
  assertEq(result, [], 'an empty list is a no-op, not a crash');
}

// ==================== processLeverageHistoryDay ====================
{
  const s1 = processLeverageHistoryDay(EMPTY_STATS, '2026-07-01', []);
  assertEq(s1, { streak: 0, completedCount: 0, setCount: 0, history: [], lastProcessedDate: '2026-07-01' },
    'a day with no goals logged at all does not penalize the streak, just advances the watermark');
}

{
  const day1 = [{ text: 'Ship the feature', leverage: true, done: true }, { text: 'other' }];
  const s1 = processLeverageHistoryDay(EMPTY_STATS, '2026-07-01', day1);
  assertEq(s1.streak, 1, 'a completed leverage task starts the streak at 1');
  assertEq(s1.completedCount, 1, 'a completed leverage task increments completedCount');
  assertEq(s1.setCount, 1, 'designating a leverage task increments setCount regardless of completion');
  assertEq(s1.history, [{ date: '2026-07-01', text: 'Ship the feature', done: true }], 'the completed task is recorded in history');

  const day2 = [{ text: 'Write the report', leverage: true, done: true }];
  const s2 = processLeverageHistoryDay(s1, '2026-07-02', day2);
  assertEq(s2.streak, 2, 'a second consecutive completed day extends the streak to 2');
  assertEq(s2.setCount, 2, 'setCount accumulates across days');
}

{
  // A leverage task was designated but never finished — streak resets, but
  // it still counts toward setCount (it WAS designated, just not done).
  const day = [{ text: 'Clean the garage', leverage: true, done: false }];
  const stats = { streak: 3, completedCount: 3, setCount: 3, history: [], lastProcessedDate: '2026-07-04' };
  const result = processLeverageHistoryDay(stats, '2026-07-05', day);
  assertEq(result.streak, 0, 'an undone leverage task resets the streak to 0');
  assertEq(result.setCount, 4, 'an undone leverage task still counts as having been designated');
  assertEq(result.completedCount, 3, 'completedCount does not increment for an undone task');
}

{
  // Goals existed that day but none were ever starred as the leverage task —
  // this is the "never picked one" miss, distinct from "picked one, didn't finish."
  const day = [{ text: 'Reply to emails', done: true }, { text: 'Read 10 pages', done: false }];
  const stats = { streak: 5, completedCount: 5, setCount: 5, history: [], lastProcessedDate: '2026-07-04' };
  const result = processLeverageHistoryDay(stats, '2026-07-05', day);
  assertEq(result.streak, 0, 'a day with goals but no designated leverage task breaks the streak');
  assertEq(result.setCount, 5, 'setCount is untouched when no leverage task was ever designated that day');
  assertEq(result.history[result.history.length - 1], { date: '2026-07-05', text: null, done: false },
    'a never-designated day is recorded in history with a null text, distinguishing it from a missed-but-picked day');
}

{
  // History is capped so it never grows unbounded across months of use.
  let stats = EMPTY_STATS;
  for (let i = 0; i < 20; i++) {
    stats = processLeverageHistoryDay(stats, '2026-07-' + String(i + 1).padStart(2, '0'), [{ text: 'x', leverage: true, done: true }]);
  }
  assertEq(stats.history.length, LEVERAGE_HISTORY_MAX, 'history is capped at LEVERAGE_HISTORY_MAX even after many days');
  assertEq(stats.history[stats.history.length - 1].date, '2026-07-20', 'the cap keeps the MOST RECENT days, dropping the oldest');
}

// ==================== leverageFollowThroughRate ====================
{
  assertNull(leverageFollowThroughRate({ setCount: 0, completedCount: 0 }), 'no leverage tasks ever designated returns null, not a divide-by-zero 0');
  assertNull(leverageFollowThroughRate(null), 'a missing stats object does not throw, returns null');
  assertEq(leverageFollowThroughRate({ setCount: 4, completedCount: 3 }), 0.75, '3 of 4 designated tasks completed is a 75% follow-through rate');
}

// ==================== leverageUrgency ====================
{
  assertEq(leverageUrgency(9, 8, 24), 'calm', 'early in the waking day (9am of an 8am-midnight span) is calm');
  assertEq(leverageUrgency(14.4, 8, 24), 'building', 'just past the 40% mark of the day is building urgency');
  assertEq(leverageUrgency(19, 8, 24), 'building', 'mid-evening, under 75% elapsed, is still building not urgent');
  assertEq(leverageUrgency(21, 8, 24), 'urgent', 'past 75% of the waking day elapsed is urgent');
  assertEq(leverageUrgency(6, 8, 24), 'calm', 'a time before the wake hour clamps to 0% elapsed rather than going negative');
  assertEq(leverageUrgency(30, 8, 24), 'urgent', 'a time past the sleep hour clamps to 100% elapsed rather than exceeding it');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
