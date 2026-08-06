// Standalone verification of year-review.html's stat logic. The page is
// browser-only with no module exports, so this duplicates the pure
// functions verbatim — the domain stats reused from review.html (spot-
// checked here, already covered more thoroughly by that page's own use)
// and the new functions this page introduced (sleep, net-worth change,
// longest-streak-in-range).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function stripTime(d) { const c = new Date(d); c.setHours(0, 0, 0, 0); return c; }
function daysList(start, end) {
  const days = []; const cur = new Date(start); const e = new Date(end);
  while (cur <= e) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
  return days;
}

// ---- reused domain stats (verbatim) ----
function habitsStat(days, storeGet) {
  const defs = storeGet('habits:defs') || [];
  if (!defs.length) return null;
  const log = storeGet('habits:log') || {};
  let done = 0;
  days.forEach(d => { const k = dateToKey(d); defs.forEach(h => { if (log[h.id] && log[h.id][k]) done++; }); });
  const possible = defs.length * days.length;
  return { done, possible, rate: possible ? Math.round(done / possible * 100) : 0 };
}
function gymStat(days, storeGet) {
  const doneDaysMap = storeGet('po_coach_workout_done');
  if (!doneDaysMap) return null;
  const sessions = days.filter(d => doneDaysMap[dateToKey(d)]).length;
  const weights = storeGet('po_coach_weights') || [];
  const keys = new Set(days.map(dateToKey));
  const inRange = weights.filter(w => keys.has(w.dateKey)).slice().sort((a, b) => a.dateKey < b.dateKey ? -1 : 1);
  let weightDelta = null;
  if (inRange.length >= 2) weightDelta = Math.round((inRange[inRange.length - 1].weight - inRange[0].weight) * 10) / 10;
  return { sessions, days: days.length, weightDelta };
}

// ---- new for this page ----
function sleepStat(days, storeGet) {
  const morning = storeGet('sleep:nights') || {};
  const keys = new Set(days.map(dateToKey));
  const entries = Object.keys(morning).filter(k => keys.has(k) && morning[k].sleepHours != null);
  if (!entries.length) return null;
  const avgHours = entries.reduce((a, k) => a + morning[k].sleepHours, 0) / entries.length;
  const qualityEntries = entries.filter(k => morning[k].sleepQuality != null);
  const avgQuality = qualityEntries.length ? qualityEntries.reduce((a, k) => a + morning[k].sleepQuality, 0) / qualityEntries.length : null;
  return {
    avgHours: Math.round(avgHours * 10) / 10,
    avgQuality: avgQuality != null ? Math.round(avgQuality * 10) / 10 : null,
    loggedDays: entries.length, totalDays: days.length,
  };
}
function netWorthChangeStat(hist, windowStartMs) {
  const pts = hist.filter(p => p.t >= windowStartMs);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  if (pts.length < 2) return { current: last.v, change: null };
  return { current: last.v, change: Math.round((last.v - pts[0].v) * 100) / 100 };
}
function longestConsecutiveRun(days, isDoneOnDay) {
  let best = 0, cur = 0;
  days.forEach(d => { if (isDoneOnDay(d)) { cur++; if (cur > best) best = cur; } else cur = 0; });
  return best;
}
function longestHabitStreak(days, storeGet) {
  const defs = storeGet('habits:defs') || [];
  if (!defs.length) return null;
  const log = storeGet('habits:log') || {};
  let best = 0, label = '';
  defs.forEach(h => {
    const run = longestConsecutiveRun(days, d => !!(log[h.id] && log[h.id][dateToKey(d)]));
    if (run > best) { best = run; label = h.name; }
  });
  if (!best) return null;
  return { days: best, label };
}
function longestGymStreak(days, storeGet) {
  const doneDaysMap = storeGet('po_coach_workout_done');
  if (!doneDaysMap) return null;
  const best = longestConsecutiveRun(days, d => !!doneDaysMap[dateToKey(d)]);
  if (!best) return null;
  return { days: best };
}

function mockStore(data) { return (k) => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null); }

// ==================== window construction ====================
{
  const today = stripTime(new Date());
  const windowStart = stripTime(today); windowStart.setDate(windowStart.getDate() - 364);
  const days = daysList(windowStart, today);
  assertEq(days.length, 365, 'a trailing 364-day-back window plus today is exactly 365 days');
  assertEq(dateToKey(days[days.length - 1]), dateToKey(today), 'the window ends on today');
}

// ==================== reused stats sanity ====================
{
  const today = stripTime(new Date());
  const days = daysList(new Date(today.getTime() - 6 * 86400000), today); // 7 days for a quick check
  const k0 = dateToKey(days[0]), k6 = dateToKey(days[6]);
  const store = mockStore({
    'habits:defs': [{ id: 'h1', name: 'Read' }],
    'habits:log': { h1: { [k0]: true, [k6]: true } },
  });
  const h = habitsStat(days, store);
  assertEq(h, { done: 2, possible: 7, rate: 29 }, 'habitsStat counts done check-ins against total possible across the range');
  assertEq(habitsStat(days, mockStore({})), null, 'habitsStat returns null when there are no habit defs at all');

  const gymStore = mockStore({
    po_coach_workout_done: { [k0]: true, [k6]: true },
    po_coach_weights: [{ dateKey: k0, weight: 180 }, { dateKey: k6, weight: 178 }],
  });
  const g = gymStat(days, gymStore);
  assertEq(g, { sessions: 2, days: 7, weightDelta: -2 }, 'gymStat counts sessions and computes a weight delta across the range');
}

// ==================== sleep ====================
{
  const today = stripTime(new Date());
  const days = daysList(new Date(today.getTime() - 2 * 86400000), today);
  const k0 = dateToKey(days[0]), k1 = dateToKey(days[1]);
  const store = mockStore({ 'sleep:nights': { [k0]: { sleepHours: 7, sleepQuality: 4 }, [k1]: { sleepHours: 8, sleepQuality: 3 } } });
  const s = sleepStat(days, store);
  assertEq(s, { avgHours: 7.5, avgQuality: 3.5, loggedDays: 2, totalDays: 3 }, 'sleepStat averages hours and quality across logged nights only');
  assertEq(sleepStat(days, mockStore({})), null, 'sleepStat returns null with no morning entries at all');
}

// ==================== net worth change ====================
{
  const now = Date.now();
  const windowStartMs = now - 30 * 86400000;
  assertEq(netWorthChangeStat([], windowStartMs), null, 'no history at all returns null');
  const single = netWorthChangeStat([{ t: now, v: 5000 }], windowStartMs);
  assertEq(single, { current: 5000, change: null }, 'a single point in the window reports current value with a null change (nothing to compare against)');
  const hist = [{ t: now - 20 * 86400000, v: 4000 }, { t: now, v: 4500 }];
  assertEq(netWorthChangeStat(hist, windowStartMs), { current: 4500, change: 500 }, 'two points in the window compute a real change');
  const outOfWindow = [{ t: now - 400 * 86400000, v: 100 }, { t: now, v: 4500 }];
  assertEq(netWorthChangeStat(outOfWindow, windowStartMs), { current: 4500, change: null }, 'a point older than the window is excluded from the comparison');
}

// ==================== longest streak in range ====================
{
  const days = [];
  for (let i = 0; i < 10; i++) days.push(new Date(2026, 0, i + 1));
  const doneSet = new Set([1, 2, 3, 4, 7, 8].map(d => dateToKey(new Date(2026, 0, d))));
  const run = longestConsecutiveRun(days, d => doneSet.has(dateToKey(d)));
  assertEq(run, 4, 'longestConsecutiveRun finds the longest unbroken run, not just the most recent one (4-day run beats the later 2-day run)');

  const store = mockStore({
    'habits:defs': [{ id: 'h1', name: 'Read' }, { id: 'h2', name: 'Meditate' }],
    'habits:log': {
      h1: Object.fromEntries([1, 2, 3].map(d => [dateToKey(new Date(2026, 0, d)), true])),
      h2: Object.fromEntries([1, 2, 3, 4, 5].map(d => [dateToKey(new Date(2026, 0, d)), true])),
    },
  });
  assertEq(longestHabitStreak(days, store), { days: 5, label: 'Meditate' }, 'longestHabitStreak picks the habit with the longest unbroken run across all of them');
  assertEq(longestHabitStreak(days, mockStore({})), null, 'longestHabitStreak returns null with no habit defs');

  const gymStore = mockStore({ po_coach_workout_done: Object.fromEntries([1, 2, 3, 4].map(d => [dateToKey(new Date(2026, 0, d)), true])) });
  assertEq(longestGymStreak(days, gymStore), { days: 4 }, 'longestGymStreak finds the best unbroken run in the window');
  assertEq(longestGymStreak(days, mockStore({})), null, 'longestGymStreak returns null with no workout-done data at all');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
