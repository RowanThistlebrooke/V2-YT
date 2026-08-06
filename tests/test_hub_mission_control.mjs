// Standalone verification of hub-today.html's Mission Control stat logic.
// hub-today.html is a browser-only page with no module exports, so this
// duplicates the pure decision logic verbatim (streaks, net-worth trend,
// energy-signal pick, next-up pick) — same DOM-free approach used
// throughout this repo's other browser-only pages.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function activeDate6am() { const d = new Date(); if (d.getHours() < 6) d.setDate(d.getDate() - 1); return d; }

// ---- streaks ----
function isDone(log, habitId, dayKey) { return !!(log[habitId] && log[habitId][dayKey]); }
function streakFor(log, habitId) {
  let streak = 0;
  const cursor = activeDate6am();
  if (!isDone(log, habitId, dateToKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (isDone(log, habitId, dateToKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}
function gymWorkoutStreak(doneDays) {
  let streak = 0;
  const cursor = new Date();
  if (!doneDays[dateToKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
  while (doneDays[dateToKey(cursor)]) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}
function bestStreak(defs, log, doneDays) {
  let best = 0, label = '';
  defs.forEach(h => { const s = streakFor(log, h.id); if (s > best) { best = s; label = h.name; } });
  const gymS = gymWorkoutStreak(doneDays);
  if (gymS > best) { best = gymS; label = 'Workouts'; }
  return { days: best, label: label };
}

// ---- net worth trend (verbatim from finance.html) ----
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

// ---- energy signal ----
function timeAgo(ts, nowTs) {
  const mins = Math.round(((nowTs != null ? nowTs : Date.now()) - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.round(hrs / 24) + 'd ago';
}
function pickEnergySignal(checkins, morning, todayKPlain, nowTs) {
  const dayStart = new Date(nowTs != null ? nowTs : Date.now());
  dayStart.setHours(0, 0, 0, 0);
  const todays = (checkins || []).filter(c => c.ts >= dayStart.getTime()).sort((a, b) => a.ts - b.ts);
  const last = todays[todays.length - 1];
  if (last && (last.feeling != null || last.stress != null)) {
    const parts = [];
    if (last.feeling != null) parts.push('Feeling ' + last.feeling + '/5');
    if (last.stress != null) parts.push('Stress ' + last.stress + '/5');
    return { text: parts.join(' · '), sub: timeAgo(last.ts, nowTs) };
  }
  const m = morning && morning[todayKPlain];
  if (m && m.sleepQuality) {
    return { text: 'Slept ' + (m.sleepHours ? m.sleepHours + 'h' : '—') + ' · quality ' + m.sleepQuality + '/5', sub: 'this morning' };
  }
  return null;
}

// ---- next up ----
function fmtTime12(hhmm) {
  const parts = hhmm.split(':');
  const h = Number(parts[0]), m = Number(parts[1]);
  const ap = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + pad2(m) + ' ' + ap;
}
function nextUpPick(goals, nowHM) {
  const undone = (goals || []).filter(g => !g.done);
  if (!undone.length) return null;
  const timed = undone.filter(g => g.time).sort((a, b) => a.time.localeCompare(b.time));
  const upcoming = timed.find(g => g.time >= nowHM);
  return upcoming || timed[0] || undone[0];
}

// ==================== streaks ====================
{
  const todayK = dateToKey(activeDate6am());
  const y = activeDate6am(); y.setDate(y.getDate() - 1);
  const yKey = dateToKey(y);
  const y2 = activeDate6am(); y2.setDate(y2.getDate() - 2);
  const y2Key = dateToKey(y2);

  const log = { h1: { [todayK]: true, [yKey]: true, [y2Key]: true } };
  assertEq(streakFor(log, 'h1'), 3, 'a habit done today + 2 prior consecutive days streaks at 3');
  assertEq(streakFor(log, 'missing'), 0, 'an untracked habit id streaks at 0, not a crash');

  const logGapToday = { h1: { [yKey]: true, [y2Key]: true } };
  assertEq(streakFor(logGapToday, 'h1'), 2, 'not-yet-done today still counts yesterday backward (forgiving rule)');

  const logBroken = { h1: { [todayK]: true } };
  assertEq(streakFor(logBroken, 'h1'), 1, 'a broken streak before today only counts the unbroken tail');

  const defs = [{ id: 'h1', name: 'Read' }, { id: 'h2', name: 'Meditate' }];
  const doneDays = {};
  const best = bestStreak(defs, log, doneDays);
  assertEq(best, { days: 3, label: 'Read' }, 'bestStreak picks the longest of multiple habits');

  const gymDoneDays = { [dateToKey(new Date())]: true };
  const bestWithGym = bestStreak([], {}, gymDoneDays);
  assertEq(bestWithGym, { days: 1, label: 'Workouts' }, 'bestStreak falls back to the gym streak when it is longer/only one present');
}

// ==================== net worth trend ====================
{
  assertEq(computeNetWorthTrend([], 180), null, 'empty history returns null rather than a misleading number');
  assertEq(computeNetWorthTrend([{ t: Date.now(), v: 100 }], 180), null, 'a single data point cannot fit a trend line');

  const now = Date.now();
  const hist = [
    { t: now - 30 * 86400000, v: 1000 },
    { t: now - 15 * 86400000, v: 1150 },
    { t: now, v: 1300 },
  ];
  const trend = computeNetWorthTrend(hist, 180);
  assertTrue(trend !== null, 'a real upward history fits a trend');
  assertTrue(trend.monthlyRate > 0, 'a rising net worth history reports a positive monthly rate: ' + trend.monthlyRate);
  assertEq(trend.currentValue, 1300, 'currentValue is the most recent history point');
}

// ==================== energy signal ====================
{
  const now = Date.now();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const checkins = [{ ts: todayStart.getTime() + 3600000, feeling: 4, stress: 2 }];
  const signal = pickEnergySignal(checkins, {}, '2026-01-01', now);
  assertEq(signal.text, 'Feeling 4/5 · Stress 2/5', 'a real today check-in renders feeling+stress');

  const oldCheckins = [{ ts: now - 3 * 86400000, feeling: 5, stress: 1 }];
  const morning = { '2026-01-01': { sleepHours: 7.5, sleepQuality: 4 } };
  const fallback = pickEnergySignal(oldCheckins, morning, '2026-01-01', now);
  assertEq(fallback.text, 'Slept 7.5h · quality 4/5', 'no check-in today falls back to logged sleep quality');

  const nothing = pickEnergySignal([], {}, '2026-01-01', now);
  assertEq(nothing, null, 'no check-in and no morning entry returns null rather than a fabricated value');

  assertEq(timeAgo(now - 5 * 60000, now), '5m ago', 'timeAgo formats minutes');
  assertEq(timeAgo(now - 3 * 3600000, now), '3h ago', 'timeAgo formats hours');
}

// ==================== next up ====================
{
  assertEq(nextUpPick([], '09:00'), null, 'no goals at all returns null');
  assertEq(nextUpPick([{ text: 'Done thing', done: true }], '09:00'), null, 'all-done goals returns null');

  const goals = [
    { text: 'Morning walk', done: false, time: '07:00' },
    { text: 'Team call', done: false, time: '14:00' },
    { text: 'No time item', done: false },
  ];
  assertEq(nextUpPick(goals, '09:00').text, 'Team call', 'picks the next still-upcoming timed item, skipping ones already past');
  assertEq(nextUpPick(goals, '23:00').text, 'Morning walk', 'when every timed item is already past, falls back to the earliest timed one');

  const untimedOnly = [{ text: 'Just do it', done: false }];
  assertEq(nextUpPick(untimedOnly, '09:00').text, 'Just do it', 'an item with no time at all is still picked when nothing timed exists');

  assertEq(fmtTime12('07:00'), '7:00 AM', 'fmtTime12 formats a morning time');
  assertEq(fmtTime12('14:30'), '2:30 PM', 'fmtTime12 formats an afternoon time');
  assertEq(fmtTime12('00:05'), '12:05 AM', 'fmtTime12 handles midnight-hour correctly');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
