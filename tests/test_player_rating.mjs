// Standalone verification of player.html's rating engine — the FIFA/2K-style
// Player Card. Two independent halves are tested here:
//
//   LEVEL / XP  — cumulative, monotonic, derived by counting everything ever
//                 logged. Must never be able to go down.
//   OVR / attrs — current form over a rolling 30-day window, 1-99, where a
//                 domain with no data at all is EXCLUDED from the average
//                 rather than counted as a zero.
//
// player.html is a browser-global IIFE with no module exports, so this
// duplicates the pure functions verbatim to test them in isolation — same
// approach as test_sleep_tracker.mjs / test_insights_bottleneck.mjs.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const WINDOW_DAYS = 30;
const NW_WINDOW_DAYS = 90;
const WLT_MIN_POINTS = 3;
const WLT_MONTHLY_TARGET = 0.03;
const NW_AGE_MEDIANS = [
  { maxAge: 34, median: 39000 },
  { maxAge: 44, median: 135600 },
  { maxAge: 54, median: 247200 },
  { maxAge: 64, median: 364500 },
  { maxAge: 74, median: 409900 },
  { maxAge: Infinity, median: 334700 },
];
const WLT_PEER_MULTIPLE_FOR_MAX = 2;
const T = {
  gymSessions: 16, nutritionDays: 24, sleepHours: 8, revenueDays: 8,
  readingDays: 12, skillSessions: 12, noteEntries: 8, mistakeEntries: 3,
};
const ATTRS = [
  { key: 'PHY', weight: 20 }, { key: 'VIT', weight: 18 }, { key: 'DIS', weight: 20 },
  { key: 'HUS', weight: 14 }, { key: 'WLT', weight: 12 }, { key: 'MND', weight: 16 },
];
const XP_SOURCES = [
  { id: 'workouts', per: 40 }, { id: 'leverage', per: 20 }, { id: 'commitments', per: 15 },
  { id: 'skills', per: 12 }, { id: 'reading', per: 12 }, { id: 'mistakes', per: 10 },
  { id: 'nights', per: 10 }, { id: 'habits', per: 8 }, { id: 'meals', per: 8 },
  { id: 'notes', per: 6 }, { id: 'water', per: 6 }, { id: 'supplements', per: 6 },
  { id: 'weighins', per: 5 }, { id: 'checkins', per: 5 },
];

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round(150 * Math.pow(level - 1, 1.6));
}
function levelForXp(xp) {
  const total = Math.max(0, Math.floor(xp || 0));
  let level = 1;
  while (xpForLevel(level + 1) <= total) level++;
  const floor = xpForLevel(level);
  const ceil = xpForLevel(level + 1);
  const span = ceil - floor;
  return { level, total, into: total - floor, need: span, remaining: ceil - total, pct: span > 0 ? clamp01((total - floor) / span) : 0 };
}
function ratingFromRatio(ratio) { return Math.max(1, Math.min(99, Math.round(clamp01(ratio) * 99))); }
function tierForOvr(ovr) {
  if (ovr >= 90) return 'Icon';
  if (ovr >= 85) return 'Elite';
  if (ovr >= 80) return 'World Class';
  if (ovr >= 72) return 'Quality';
  if (ovr >= 62) return 'Solid';
  if (ovr >= 50) return 'Developing';
  return 'Rebuilding';
}
function blend(parts) {
  const live = parts.filter(p => p && p.ratio != null);
  if (!live.length) return null;
  let sum = 0, wt = 0;
  live.forEach(p => { sum += clamp01(p.ratio) * p.weight; wt += p.weight; });
  return { ratio: wt > 0 ? sum / wt : 0, parts: live };
}
function overallFromAttrs(attrs) {
  const live = ATTRS.filter(a => attrs[a.key] != null);
  if (!live.length) return null;
  let sum = 0, wt = 0;
  live.forEach(a => { sum += attrs[a.key] * a.weight; wt += a.weight; });
  return Math.round(sum / wt);
}
function dayKeysBack(days, now) {
  const out = [];
  const cursor = new Date(now);
  for (let i = 0; i < days; i++) { out.push(dateToKey(cursor)); cursor.setDate(cursor.getDate() - 1); }
  return out;
}
function computeMonthlyGrowthRate(history, windowDays, now) {
  if (!Array.isArray(history)) return null;
  const cutoff = now - windowDays * 86400000;
  const pts = history.filter(h => h && typeof h.t === 'number' && typeof h.v === 'number' && h.t >= cutoff)
    .slice().sort((a, b) => a.t - b.t);
  if (pts.length < WLT_MIN_POINTS) return null;
  const t0 = pts[0].t;
  const xs = pts.map(p => (p.t - t0) / 86400000);
  const ys = pts.map(p => p.v);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0), sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0), sumXX = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return null;
  const slopePerDay = (n * sumXY - sumX * sumY) / denom;
  const base = ys[ys.length - 1];
  if (Math.abs(base) < 0.01) return null;
  return (slopePerDay * 30.44) / Math.abs(base);
}
function netWorthPeerMedian(age) {
  if (typeof age !== 'number' || !(age > 0)) return null;
  const bracket = NW_AGE_MEDIANS.find(b => age <= b.maxAge);
  return bracket ? bracket.median : null;
}
function latestNetWorth(history) {
  if (!Array.isArray(history) || !history.length) return null;
  const pts = history.filter(h => h && typeof h.t === 'number' && typeof h.v === 'number');
  if (!pts.length) return null;
  return pts.reduce((latest, p) => (p.t > latest.t ? p : latest)).v;
}
function computeXpCounts(d) {
  const c = {};
  c.workouts = Object.keys(d.workoutDone || {}).filter(k => (d.workoutDone || {})[k]).length;
  const lev = d.leverageStats || {};
  c.leverage = Math.max(0, Number(lev.completedCount) || 0);
  let commits = 0;
  const commitLog = d.bizCommitLog || {};
  Object.keys(commitLog).forEach(id => { commits += Object.keys(commitLog[id] || {}).filter(k => commitLog[id][k]).length; });
  const delivery = d.bizDelivery || {};
  Object.keys(delivery).forEach(id => { commits += Object.keys(delivery[id] || {}).filter(k => (delivery[id][k] || 0) > 0).length; });
  c.commitments = commits;
  c.skills = (d.skillSessions || []).length;
  let readingSessions = 0;
  (d.readingItems || []).forEach(it => { readingSessions += ((it && it.sessions) || []).length; });
  c.reading = readingSessions;
  c.mistakes = (d.mistakes || []).length;
  c.nights = Object.keys(d.nights || {}).length;
  let habitChecks = 0;
  const hlog = d.habitsLog || {};
  Object.keys(hlog).forEach(id => { habitChecks += Object.keys(hlog[id] || {}).filter(k => hlog[id][k]).length; });
  c.habits = habitChecks;
  const mealDays = {};
  (d.calEntries || []).forEach(e => { if (e && e.dateKey) mealDays[e.dateKey] = true; });
  c.meals = Object.keys(mealDays).length;
  c.notes = (d.notes || []).length;
  const wlogs = (d.water && d.water.logs) || {};
  c.water = Object.keys(wlogs).filter(k => (wlogs[k] || 0) > 0).length;
  const taken = d.stackTaken || {};
  c.supplements = Object.keys(taken).filter(k => Object.keys(taken[k] || {}).some(id => taken[k][id])).length;
  c.weighins = (d.weights || []).length;
  c.checkins = (d.checkins || []).length;
  return c;
}
function computeLifetimeXp(counts) {
  let total = 0;
  const rows = [];
  XP_SOURCES.forEach(s => {
    const n = Math.max(0, Number(counts[s.id]) || 0);
    if (!n) return;
    const xp = n * s.per;
    total += xp;
    rows.push({ id: s.id, count: n, per: s.per, xp });
  });
  rows.sort((a, b) => b.xp - a.xp);
  return { total, rows };
}
function computeAttributes(d, now) {
  const keys = dayKeysBack(WINDOW_DAYS, now);
  const keySet = {};
  keys.forEach(k => { keySet[k] = true; });
  const startMs = new Date(keys[keys.length - 1] + 'T00:00:00').getTime();
  const out = {};

  const coach = d.coach;
  const gymConfigured = !!(coach && Array.isArray(coach.splitRotation) && coach.splitRotation.length);
  const sessions = keys.filter(k => (d.workoutDone || {})[k]).length;
  const mealDayset = {};
  (d.calEntries || []).forEach(e => { if (e && keySet[e.dateKey]) mealDayset[e.dateKey] = true; });
  const mealDays = Object.keys(mealDayset).length;
  out.PHY = blend([
    gymConfigured ? { key: 'gym', ratio: sessions / T.gymSessions, weight: 65 } : null,
    (d.calEntries || []).length ? { key: 'food', ratio: mealDays / T.nutritionDays, weight: 35 } : null,
  ]);

  const nights = d.nights || {};
  const nightRows = keys.map(k => nights[k]).filter(Boolean);
  const hrs = nightRows.map(n => n.sleepHours).filter(v => typeof v === 'number');
  const qual = nightRows.map(n => n.sleepQuality).filter(v => typeof v === 'number');
  let sleepPart = null;
  if (hrs.length || qual.length) {
    const avgH = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null;
    const avgQ = qual.length ? qual.reduce((a, b) => a + b, 0) / qual.length : null;
    const sub = blend([
      avgH != null ? { ratio: avgH / T.sleepHours, weight: 60 } : null,
      avgQ != null ? { ratio: avgQ / 5, weight: 40 } : null,
    ]);
    const coverage = clamp01(nightRows.length / (WINDOW_DAYS * 0.6));
    sleepPart = { key: 'sleep', ratio: sub.ratio * coverage, weight: 45 };
  }
  let waterPart = null;
  const water = d.water;
  if (water && water.profile && water.profile.weightKg) {
    const p = water.profile;
    const wKg = water.weightUnit === 'lb' ? (p.weightKg || 0) / 2.20462 : (p.weightKg || 0);
    const base = wKg * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caff = Math.max(0, (water.caffeineMgPerDay || 0) - 200) * 1.5;
    let adjust = 0; if (p.sex === 'm') adjust += 200; if ((p.age || 0) >= 50) adjust += 100;
    let unitMl = 1;
    if (water.unit === 'bottle') unitMl = water.bottleMl || 500;
    else if (water.unit === 'glass') unitMl = water.glassMl || 250;
    else if (water.unit === 'oz') unitMl = 30;
    const targetUnits = Math.ceil((base + exercise + caff + adjust) / unitMl);
    if (targetUnits > 0) {
      let done = 0;
      keys.forEach(k => { done += ((water.logs || {})[k]) || 0; });
      waterPart = { key: 'water', ratio: done / (targetUnits * WINDOW_DAYS), weight: 30 };
    }
  }
  let suppPart = null;
  const stackItems = d.stackItems || [];
  if (stackItems.length) {
    let done = 0;
    keys.forEach(k => { const t = (d.stackTaken || {})[k] || {}; done += stackItems.filter(it => t[it.id]).length; });
    suppPart = { key: 'supplements', ratio: done / (stackItems.length * WINDOW_DAYS), weight: 25 };
  }
  out.VIT = blend([sleepPart, waterPart, suppPart]);

  let habitPart = null;
  const hdefs = d.habitsDefs || [];
  if (hdefs.length) {
    let done = 0;
    keys.forEach(k => { done += hdefs.filter(h => (d.habitsLog || {})[h.id] && d.habitsLog[h.id][k]).length; });
    habitPart = { key: 'habits', ratio: done / (hdefs.length * WINDOW_DAYS), weight: 60 };
  }
  let levPart = null;
  const lev = d.leverageStats || {};
  if ((Number(lev.setCount) || 0) > 0) {
    levPart = { key: 'leverage', ratio: (Number(lev.completedCount) || 0) / lev.setCount, weight: 40 };
  }
  out.DIS = blend([habitPart, levPart]);

  const commitments = d.bizCommitments || [];
  const retainers = (d.bizClients || []).filter(c => c && c.billingType === 'retainer' && c.dailyDeliverables > 0);
  let cDone = 0, cTotal = 0;
  keys.forEach(k => {
    commitments.forEach(c => { cTotal++; if ((d.bizCommitLog || {})[c.id] && d.bizCommitLog[c.id][k]) cDone++; });
    retainers.forEach(c => { cTotal++; const n = ((d.bizDelivery || {})[c.id] || {})[k] || 0; if (n >= c.dailyDeliverables) cDone++; });
  });
  const revDays = {};
  (d.bizRevenue || []).forEach(r => { if (r && keySet[r.date] && (Number(r.amount) || 0) > 0) revDays[r.date] = true; });
  (d.bizPayments || []).forEach(p => { if (p && keySet[p.date] && (Number(p.amount) || 0) > 0) revDays[p.date] = true; });
  const revCount = Object.keys(revDays).length;
  out.HUS = blend([
    cTotal > 0 ? { key: 'commitments', ratio: cDone / cTotal, weight: 70 } : null,
    ((d.bizRevenue || []).length || (d.bizPayments || []).length) ? { key: 'revenue', ratio: revCount / T.revenueDays, weight: 30 } : null,
  ]);

  let peerPart = null;
  const age = (d.water && d.water.profile && d.water.profile.age) || null;
  const currentNw = latestNetWorth(d.nwHistory);
  const peerMedian = netWorthPeerMedian(age);
  if (currentNw != null && peerMedian) {
    const peerRatio = clamp01(currentNw / (peerMedian * WLT_PEER_MULTIPLE_FOR_MAX));
    const pctOfMedian = Math.round((currentNw / peerMedian) * 100);
    peerPart = { key: 'peer', label: pctOfMedian + '% of typical net worth for your age (Fed SCF 2022 median)', ratio: peerRatio, weight: 60 };
  }

  let trendPart = null;
  const rate = computeMonthlyGrowthRate(d.nwHistory, NW_WINDOW_DAYS, now);
  if (rate != null) {
    const trendRatio = clamp01((rate / WLT_MONTHLY_TARGET + 1) / 2);
    trendPart = { key: 'networth', ratio: trendRatio, weight: 40 };
  }

  out.WLT = blend([peerPart, trendPart]);

  const readDays = {};
  (d.readingItems || []).forEach(it => {
    ((it && it.sessions) || []).forEach(s => { if (s && s.date && keySet[s.date]) readDays[s.date] = true; });
  });
  const rDays = Object.keys(readDays).length;
  const skillN = (d.skillSessions || []).filter(s => s && typeof s.ts === 'number' && s.ts >= startMs).length;
  const noteN = (d.notes || []).filter(n => n && typeof n.ts === 'number' && n.ts >= startMs).length;
  const mistN = (d.mistakes || []).filter(m => m && typeof m.ts === 'number' && m.ts >= startMs).length;
  out.MND = blend([
    (d.readingItems || []).length ? { key: 'reading', ratio: rDays / T.readingDays, weight: 35 } : null,
    (d.skillSessions || []).length ? { key: 'skills', ratio: skillN / T.skillSessions, weight: 30 } : null,
    (d.notes || []).length ? { key: 'notes', ratio: noteN / T.noteEntries, weight: 20 } : null,
    (d.mistakes || []).length ? { key: 'mistakes', ratio: mistN / T.mistakeEntries, weight: 15 } : null,
  ]);

  return out;
}
function computeRating(d, now) {
  const raw = computeAttributes(d, now);
  const ratings = {};
  ATTRS.forEach(a => { ratings[a.key] = raw[a.key] ? ratingFromRatio(raw[a.key].ratio) : null; });
  const ovr = overallFromAttrs(ratings);
  return { raw, ratings, ovr, tier: ovr == null ? null : tierForOvr(ovr) };
}

// ==================== XP curve / levels ====================
{
  assertEq(xpForLevel(1), 0, 'level 1 is the floor and costs nothing');
  assertEq(xpForLevel(2), 150, 'level 2 costs a small, quickly-reachable amount');
  assertTrue(xpForLevel(10) > xpForLevel(9), 'the curve is strictly increasing');
  assertTrue((xpForLevel(11) - xpForLevel(10)) > (xpForLevel(3) - xpForLevel(2)),
    'later levels cost more than early ones — early wins come fast, later ones mean something');

  assertEq(levelForXp(0).level, 1, 'zero XP is level 1, not level 0');
  assertEq(levelForXp(149).level, 1, 'just under the level-2 threshold is still level 1');
  assertEq(levelForXp(150).level, 2, 'hitting the threshold exactly levels you up');
  assertEq(levelForXp(-500).level, 1, 'a nonsense negative XP total floors at level 1 rather than going negative');

  const l = levelForXp(200);
  assertEq(l.level, 2, '200 XP sits inside level 2');
  assertEq(l.into, 50, 'progress into the current level is measured from that level\'s floor');
  assertEq(l.need, xpForLevel(3) - xpForLevel(2), 'the bar spans this level\'s floor to the next level\'s floor');
  assertEq(l.into + l.remaining, l.need, 'progress plus remaining always equals the full bar');
  assertTrue(l.pct > 0 && l.pct < 1, 'a partially-completed level reports a fractional bar');

  // The whole point of the level half: it can never regress.
  let prevLevel = 0;
  for (let xp = 0; xp < 20000; xp += 137) {
    const lv = levelForXp(xp).level;
    if (lv < prevLevel) { fail++; console.log('FAIL: level went DOWN as XP increased at xp=' + xp); prevLevel = -1; break; }
    prevLevel = lv;
  }
  if (prevLevel >= 0) { pass++; console.log('PASS: level never decreases as XP grows — progression is strictly monotonic'); }
}

// ==================== Lifetime XP counting ====================
{
  const d = {
    workoutDone: { '2026-07-01': true, '2026-07-03': true, '2026-07-05': false },
    leverageStats: { completedCount: 4, setCount: 9 },
    bizCommitLog: { c1: { '2026-07-01': true, '2026-07-02': true } },
    bizDelivery: { k1: { '2026-07-01': 3, '2026-07-02': 0 } },
    skillSessions: [{ ts: 1 }, { ts: 2 }],
    readingItems: [{ sessions: [{ date: '2026-07-01' }, { date: '2026-07-02' }] }, { sessions: [] }],
    mistakes: [{ ts: 1 }],
    nights: { '2026-07-01': {}, '2026-07-02': {} },
    habitsLog: { h1: { '2026-07-01': true, '2026-07-02': true }, h2: { '2026-07-01': true } },
    calEntries: [{ dateKey: '2026-07-01' }, { dateKey: '2026-07-01' }, { dateKey: '2026-07-02' }],
    notes: [{ ts: 1 }, { ts: 2 }, { ts: 3 }],
    water: { logs: { '2026-07-01': 5, '2026-07-02': 0 } },
    stackTaken: { '2026-07-01': { s1: true }, '2026-07-02': {} },
    weights: [{ dateKey: '2026-07-01', weight: 80 }],
    checkins: [{ ts: 1 }, { ts: 2 }],
  };
  const c = computeXpCounts(d);
  assertEq(c.workouts, 2, 'only truthy workout-done days count, not falsy entries');
  assertEq(c.leverage, 4, 'leverage XP uses the lifetime completed tally (raw to-do history is deleted on rollover)');
  assertEq(c.commitments, 3, 'commitments count checked affiliate days plus days with a nonzero delivery');
  assertEq(c.reading, 2, 'reading counts sessions across every book, skipping ones with none');
  assertEq(c.habits, 3, 'habit check-ins are counted across every habit');
  assertEq(c.meals, 2, 'food counts DISTINCT days logged, not individual entries');
  assertEq(c.water, 1, 'a day logged with zero water does not count as hydrated');
  assertEq(c.supplements, 1, 'a day with nothing actually taken does not count');

  const xp = computeLifetimeXp(c);
  const expected = 2 * 40 + 4 * 20 + 3 * 15 + 2 * 12 + 2 * 12 + 1 * 10 + 2 * 10 + 3 * 8 + 2 * 8 + 3 * 6 + 1 * 6 + 1 * 6 + 1 * 5 + 2 * 5;
  assertEq(xp.total, expected, 'total XP is the sum of every source times its own per-unit rate');
  assertTrue(xp.rows.length > 0 && xp.rows[0].xp >= xp.rows[xp.rows.length - 1].xp, 'the breakdown is sorted biggest-contributor first');
  assertTrue(!xp.rows.some(r => r.count === 0), 'sources you have zero of are left out of the breakdown entirely');

  assertEq(computeLifetimeXp(computeXpCounts({})).total, 0, 'a totally empty dashboard is 0 XP, not a crash');
  assertEq(levelForXp(computeLifetimeXp(computeXpCounts({})).total).level, 1, 'a brand-new user starts at Level 1');
}

// ==================== ratingFromRatio / tiers ====================
{
  assertEq(ratingFromRatio(1), 99, 'hitting the full target maxes the attribute at 99');
  assertEq(ratingFromRatio(0), 1, 'zero performance floors at 1 rather than 0 — a card still shows a number');
  assertEq(ratingFromRatio(0.5), 50, 'half the target reads as roughly 50 — the scale is honest, not flattering');
  assertEq(ratingFromRatio(3), 99, 'overshooting the target is capped at 99, never above');
  assertEq(ratingFromRatio(-2), 1, 'a negative ratio clamps to the floor instead of going negative');

  assertEq(tierForOvr(95), 'Icon', 'a 95 overall is the top tier');
  assertEq(tierForOvr(85), 'Elite', 'tier boundaries are inclusive at the bottom edge');
  assertEq(tierForOvr(84), 'World Class', 'one below a boundary drops to the tier beneath');
  assertEq(tierForOvr(62), 'Solid', 'mid-table maps to Solid');
  assertEq(tierForOvr(10), 'Rebuilding', 'a very low overall reads as Rebuilding, not a insult');
}

// ==================== blend / overall weighting ====================
{
  assertEq(blend([]), null, 'blending nothing returns null rather than a fake zero');
  assertEq(blend([null, null]), null, 'blending only-absent parts returns null');
  assertEq(blend([{ ratio: 1, weight: 50 }, { ratio: 0, weight: 50 }]).ratio, 0.5, 'equal weights average evenly');
  assertEq(blend([{ ratio: 1, weight: 90 }, { ratio: 0, weight: 10 }]).ratio, 0.9, 'weights actually bias the blend');
  // The fairness rule: a missing sub-part renormalizes rather than scoring 0.
  assertEq(blend([{ ratio: 0.8, weight: 60 }, null]).ratio, 0.8,
    'a missing sub-part renormalizes over what IS present instead of dragging the score down');
  assertEq(blend([{ ratio: 5, weight: 100 }]).ratio, 1, 'an out-of-range part is clamped before blending');

  assertEq(overallFromAttrs({}), null, 'no rated attributes at all means no OVR');
  assertEq(overallFromAttrs({ PHY: 80, VIT: 80, DIS: 80, HUS: 80, WLT: 80, MND: 80 }), 80, 'all-equal attributes give that exact OVR');
  // DIS is weighted 20 vs WLT's 12, so the same swing matters more on DIS.
  const disHeavy = overallFromAttrs({ PHY: 50, VIT: 50, DIS: 90, HUS: 50, WLT: 50, MND: 50 });
  const wltHeavy = overallFromAttrs({ PHY: 50, VIT: 50, DIS: 50, HUS: 50, WLT: 90, MND: 50 });
  assertTrue(disHeavy > wltHeavy, 'a heavier-weighted attribute (Discipline) moves OVR more than a lighter one (Wealth)');
  assertEq(overallFromAttrs({ PHY: 90, VIT: null, DIS: null, HUS: null, WLT: null, MND: null }), 90,
    'with only one attribute rated, OVR equals it — unrated domains are excluded, not counted as zero');
}

// ==================== computeAttributes over the rolling window ====================
const NOW = new Date('2026-07-20T12:00:00').getTime();
function keysBack(n) { return dayKeysBack(n, NOW); }

{
  // A domain you've never set up must not be rated at all.
  const empty = computeAttributes({}, NOW);
  ATTRS.forEach(a => assertEq(empty[a.key], null, 'an untouched dashboard leaves ' + a.key + ' unrated rather than scoring it 0'));
  assertEq(computeRating({}, NOW).ovr, null, 'a totally empty dashboard has no OVR at all');
  assertEq(computeRating({}, NOW).tier, null, 'and therefore no tier');
}

{
  // PHY — gym only, exactly at target.
  const done = {};
  keysBack(16).forEach(k => { done[k] = true; });
  const r = computeAttributes({ coach: { splitRotation: ['push', 'pull'] }, workoutDone: done }, NOW);
  assertEq(ratingFromRatio(r.PHY.ratio), 99, 'hitting the 16-session target in the window maxes Physical');

  const half = {};
  keysBack(8).forEach(k => { half[k] = true; });
  assertEq(ratingFromRatio(computeAttributes({ coach: { splitRotation: ['a'] }, workoutDone: half }, NOW).PHY.ratio), 50,
    'half the training target reads as ~50');

  // Sessions outside the 30-day window must not count.
  const stale = {};
  dayKeysBack(400, NOW).slice(60).forEach(k => { stale[k] = true; });
  assertEq(computeAttributes({ coach: { splitRotation: ['a'] }, workoutDone: stale }, NOW).PHY.ratio, 0,
    'workouts older than the 30-day window do not prop up current form');

  // No coach configured at all -> gym contributes nothing, food alone rates it.
  const foodOnly = computeAttributes({ calEntries: keysBack(24).map(k => ({ dateKey: k })) }, NOW);
  assertEq(ratingFromRatio(foodOnly.PHY.ratio), 99, 'with no training plan set up, Physical rates on nutrition alone rather than being dragged to zero');
}

{
  // VIT — sleep coverage guard: two perfect nights should NOT read as elite.
  const twoGood = { nights: {} };
  keysBack(2).forEach(k => { twoGood.nights[k] = { sleepHours: 8, sleepQuality: 5 }; });
  const sparse = computeAttributes(twoGood, NOW);
  assertTrue(ratingFromRatio(sparse.VIT.ratio) < 25,
    'two perfect nights out of thirty does not read as elite vitality — coverage is scaled in');

  const full = { nights: {} };
  keysBack(WINDOW_DAYS).forEach(k => { full.nights[k] = { sleepHours: 8, sleepQuality: 5 }; });
  assertEq(ratingFromRatio(computeAttributes(full, NOW).VIT.ratio), 99, 'a full window of 8h/5-star nights maxes Vitality');

  const halfHours = { nights: {} };
  keysBack(WINDOW_DAYS).forEach(k => { halfHours.nights[k] = { sleepHours: 4, sleepQuality: 5 }; });
  assertTrue(computeAttributes(halfHours, NOW).VIT.ratio < computeAttributes(full, NOW).VIT.ratio,
    'sleeping half as long lowers Vitality even with perfect self-rated quality');
}

{
  // DIS — habits + leverage follow-through.
  const defs = [{ id: 'h1' }, { id: 'h2' }];
  const log = { h1: {}, h2: {} };
  keysBack(WINDOW_DAYS).forEach(k => { log.h1[k] = true; log.h2[k] = true; });
  const perfect = computeAttributes({ habitsDefs: defs, habitsLog: log, leverageStats: { completedCount: 10, setCount: 10 } }, NOW);
  assertEq(ratingFromRatio(perfect.DIS.ratio), 99, 'every habit every day plus every leverage task finished maxes Discipline');

  const habitsOnly = computeAttributes({ habitsDefs: defs, habitsLog: log }, NOW);
  assertEq(ratingFromRatio(habitsOnly.DIS.ratio), 99,
    'with no leverage tasks ever set, Discipline rates on habits alone rather than being halved');

  const mixed = computeAttributes({ habitsDefs: defs, habitsLog: log, leverageStats: { completedCount: 0, setCount: 10 } }, NOW);
  assertTrue(mixed.DIS.ratio < perfect.DIS.ratio, 'never finishing the leverage task you set pulls Discipline down');
}

{
  // WLT — net worth trend. Now a least-squares regression across every
  // logged point (same math as finance.html's own Net Worth Forecast)
  // rather than a raw first-vs-last delta, and it takes a genuinely
  // sustained +3%/mo to max out — not a single lucky snapshot.
  const day = 86400000;
  function linearNwHistory(monthlyRate, base, daysAgoList) {
    const slopePerDay = monthlyRate * base / 30.44;
    return daysAgoList.map(daysAgo => ({ t: NOW - daysAgo * day, v: base - slopePerDay * daysAgo }));
  }

  const flat = computeAttributes({ nwHistory: linearNwHistory(0, 10000, [89, 60, 30, 1]) }, NOW);
  assertEq(ratingFromRatio(flat.WLT.ratio), 50, 'a genuinely flat trend across several points sits mid-table rather than reading as a failure');

  const up = computeAttributes({ nwHistory: linearNwHistory(WLT_MONTHLY_TARGET, 10000, [89, 60, 30, 1]) }, NOW);
  assertEq(ratingFromRatio(up.WLT.ratio), 99, 'a sustained +3%/mo trend across several points maxes Wealth');

  const halfUp = computeAttributes({ nwHistory: linearNwHistory(WLT_MONTHLY_TARGET / 2, 10000, [89, 60, 30, 1]) }, NOW);
  assertEq(ratingFromRatio(halfUp.WLT.ratio), 74, 'half the target growth rate reads well below max, not maxed');

  const down = computeAttributes({ nwHistory: linearNwHistory(-WLT_MONTHLY_TARGET, 10000, [89, 60, 30, 1]) }, NOW);
  assertEq(ratingFromRatio(down.WLT.ratio), 1, 'a sustained -3%/mo trend bottoms it out');

  // The actual fix: a single volatile spike (a crypto swing, a one-time
  // deposit) logged right before the rating is computed must not alone max
  // out Wealth the way a naive first-vs-last comparison would have.
  const noisy = computeAttributes({ nwHistory: [
    { t: NOW - 90 * day, v: 10000 },
    { t: NOW - 70 * day, v: 10010 },
    { t: NOW - 50 * day, v: 10005 },
    { t: NOW - 30 * day, v: 9995 },
    { t: NOW - 1 * day, v: 11000 }, // a +10% one-day jump — under the OLD first-vs-last algorithm this exact shape maxed Wealth at 99
  ] }, NOW);
  assertTrue(ratingFromRatio(noisy.WLT.ratio) < 99,
    'the same +10% swing that used to max out Wealth under the old two-point comparison no longer maxes it once the flat history in between is factored in via regression');

  assertEq(computeAttributes({ nwHistory: [{ t: NOW - day, v: 10000 }] }, NOW).WLT, null,
    'a single data point cannot establish a trend, so Wealth stays unrated');
  assertEq(computeAttributes({ nwHistory: [{ t: NOW - 60 * day, v: 10000 }, { t: NOW - day, v: 11000 }] }, NOW).WLT, null,
    'even two points showing a big swing is not enough on its own anymore — at least 3 points are required before calling it a real trend');
  assertEq(computeAttributes({ nwHistory: linearNwHistory(0.05, 1, [200, 190, 180]) }, NOW).WLT, null,
    'history entirely outside the 90-day window leaves Wealth unrated rather than reporting ancient growth');
}

{
  // WLT — net worth vs. age peers, blended 60/40 with the trend above.
  const day = 86400000;
  const waterAge = (age) => ({ profile: { age } });
  function linearNwHistory(monthlyRate, base, daysAgoList) {
    const slopePerDay = monthlyRate * base / 30.44;
    return daysAgoList.map(daysAgo => ({ t: NOW - daysAgo * day, v: base - slopePerDay * daysAgo }));
  }

  // Peer signal alone (no trend data — a single snapshot isn't enough to
  // fit a trend, but is enough to compare against the age-bracket median).
  const atMedian = computeAttributes({ water: waterAge(30), nwHistory: [{ t: NOW - day, v: 39000 }] }, NOW);
  assertEq(ratingFromRatio(atMedian.WLT.ratio), 50, 'sitting at exactly the age-bracket median (2x-for-max scale) rates squarely mid-table');

  const doubleMedian = computeAttributes({ water: waterAge(30), nwHistory: [{ t: NOW - day, v: 78000 }] }, NOW);
  assertEq(ratingFromRatio(doubleMedian.WLT.ratio), 99, '2x the age-bracket median (under-35 bracket) maxes the peer signal');

  const wayBelow = computeAttributes({ water: waterAge(30), nwHistory: [{ t: NOW - day, v: 0 }] }, NOW);
  assertEq(ratingFromRatio(wayBelow.WLT.ratio), 1, '$0 net worth bottoms out the peer signal rather than crashing on it');

  // Different age brackets pick a different median for the same net worth.
  const midCareer = computeAttributes({ water: waterAge(50), nwHistory: [{ t: NOW - day, v: 247200 }] }, NOW);
  assertEq(ratingFromRatio(midCareer.WLT.ratio), 50, 'the 45-54 bracket\'s own median is used for a 50-year-old, not the under-35 figure');

  const veryOld = computeAttributes({ water: waterAge(90), nwHistory: [{ t: NOW - day, v: 334700 }] }, NOW);
  assertEq(ratingFromRatio(veryOld.WLT.ratio), 50, 'ages above the oldest named bracket (74) fall into the 75+ bucket rather than going unmatched');

  // No age on file at all (or age not yet set in po_water_v1) — peer part
  // is excluded, not treated as a zero, mirroring this file's fairness
  // rule everywhere else.
  const noAgeButTrending = computeAttributes({ nwHistory: linearNwHistory(WLT_MONTHLY_TARGET, 10000, [89, 60, 30, 1]) }, NOW);
  assertEq(ratingFromRatio(noAgeButTrending.WLT.ratio), 99, 'with no age on file, Wealth falls back to the trend signal alone rather than going unrated');
  assertEq(noAgeButTrending.WLT.parts.length, 1, 'only the trend part is present when age is missing');

  // Blend: a strong peer standing plus a weak trend should land between the
  // two pure-signal ratings, not collapse to either extreme.
  const blended = computeAttributes({
    water: waterAge(30),
    nwHistory: [
      { t: NOW - 90 * day, v: 78000 },
      { t: NOW - 60 * day, v: 78000 },
      { t: NOW - 30 * day, v: 78000 },
      { t: NOW - 1 * day, v: 78000 }, // flat trend (ratio 50) + 2x-median peer standing (ratio 99)
    ],
  }, NOW);
  assertEq(blended.WLT.parts.length, 2, 'both peer and trend parts are present when age and enough history are both available');
  // peerRatio 1.0 (60wt) + trendRatio 0.5 (40wt) -> blended ratio 0.8 -> round(0.8*99) = 79.
  assertEq(ratingFromRatio(blended.WLT.ratio), 79, 'a maxed peer standing blended with a flat trend lands between the two, weighted 60/40 toward the peer comparison');

  assertEq(computeAttributes({ water: waterAge(0), nwHistory: [{ t: NOW - day, v: 10000 }] }, NOW).WLT, null,
    'an invalid/zero age is treated the same as no age at all — no peer part, and with too little history for a trend either, Wealth stays unrated');

  // Age present but NO net-worth history logged at all (not even one
  // point) — the peer part has nothing to compare, and there's obviously
  // no trend either, so Wealth stays unrated rather than defaulting to 0.
  assertEq(computeAttributes({ water: waterAge(30) }, NOW).WLT, null,
    'an age on file with zero net-worth history logged leaves Wealth unrated, not scored as a failure');
}

// ---- Tests: age-bracket boundaries (each bracket's own median applies
// exactly at its edges, with no gap or overlap between brackets) ----

{
  const waterAge = (age) => ({ profile: { age } });
  const day = 86400000;
  const at2xMedian = (median) => [{ t: NOW - day, v: median * 2 }];

  // Bracket edges: 34 is the top of the <35 bracket, 35 the bottom of 35-44.
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(34), nwHistory: at2xMedian(39000) }, NOW).WLT.ratio), 99,
    'age 34 (top of the under-35 bracket) uses the under-35 median');
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(35), nwHistory: at2xMedian(135600) }, NOW).WLT.ratio), 99,
    'age 35 (bottom of the 35-44 bracket) already uses the 35-44 median, not the under-35 one');

  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(44), nwHistory: at2xMedian(135600) }, NOW).WLT.ratio), 99,
    'age 44 (top of the 35-44 bracket) uses the 35-44 median');
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(45), nwHistory: at2xMedian(247200) }, NOW).WLT.ratio), 99,
    'age 45 (bottom of the 45-54 bracket) already uses the 45-54 median');

  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(54), nwHistory: at2xMedian(247200) }, NOW).WLT.ratio), 99,
    'age 54 (top of the 45-54 bracket) uses the 45-54 median');
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(55), nwHistory: at2xMedian(364500) }, NOW).WLT.ratio), 99,
    'age 55 (bottom of the 55-64 bracket) already uses the 55-64 median');

  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(64), nwHistory: at2xMedian(364500) }, NOW).WLT.ratio), 99,
    'age 64 (top of the 55-64 bracket) uses the 55-64 median');
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(65), nwHistory: at2xMedian(409900) }, NOW).WLT.ratio), 99,
    'age 65 (bottom of the 65-74 bracket) already uses the 65-74 median');

  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(74), nwHistory: at2xMedian(409900) }, NOW).WLT.ratio), 99,
    'age 74 (top of the 65-74 bracket, the last NAMED bracket) uses the 65-74 median');
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(75), nwHistory: at2xMedian(334700) }, NOW).WLT.ratio), 99,
    'age 75 is the first age to fall into the 75+ bucket, using its own (lower) median');
  assertEq(ratingFromRatio(computeAttributes({ water: waterAge(140), nwHistory: at2xMedian(334700) }, NOW).WLT.ratio), 99,
    'an implausibly old age still resolves into the 75+ bucket rather than falling through unmatched');
}

// ---- Tests: negative and extreme net worth don't break the rating ----

{
  const waterAge = (age) => ({ profile: { age } });
  const day = 86400000;

  const deepDebt = computeAttributes({ water: waterAge(30), nwHistory: [{ t: NOW - day, v: -50000 }] }, NOW);
  assertEq(ratingFromRatio(deepDebt.WLT.ratio), 1, 'negative net worth (net debt) bottoms out the peer signal at 1 rather than going negative or crashing');
  assertTrue(Number.isFinite(deepDebt.WLT.ratio), 'the ratio itself stays a finite number even with negative net worth');

  const billionaire = computeAttributes({ water: waterAge(30), nwHistory: [{ t: NOW - day, v: 50000000000 }] }, NOW);
  assertEq(ratingFromRatio(billionaire.WLT.ratio), 99, 'an extreme net worth clamps at 99 rather than overflowing or breaking the scale');
  assertTrue(Number.isFinite(billionaire.WLT.ratio), 'the ratio stays finite for an extreme value');

  // A trend computed off a near-zero base is rejected by
  // computeMonthlyGrowthRate itself (division-by-near-zero guard), so only
  // the peer part should be live here — confirms the two signals don't
  // interact badly at extreme/edge values.
  const nearZero = computeAttributes({
    water: waterAge(30),
    nwHistory: [
      { t: NOW - 90 * day, v: 0.001 },
      { t: NOW - 60 * day, v: 0.001 },
      { t: NOW - 30 * day, v: 0.001 },
      { t: NOW - 1 * day, v: 0.001 },
    ],
  }, NOW);
  assertEq(nearZero.WLT.parts.length, 1, 'a near-zero net worth base excludes the unreliable trend calculation, leaving only the peer comparison');
}

// ==================== computeMonthlyGrowthRate directly ====================
{
  const day = 86400000;
  assertEq(computeMonthlyGrowthRate([], NW_WINDOW_DAYS, NOW), null, 'no history at all returns null, not a crash');
  assertEq(computeMonthlyGrowthRate([{ t: NOW, v: 100 }, { t: NOW, v: 200 }], NW_WINDOW_DAYS, NOW), null,
    'fewer than WLT_MIN_POINTS samples is not enough to fit a real trend');
  assertEq(computeMonthlyGrowthRate([{ t: NOW - day, v: 100 }, { t: NOW - day, v: 100 }, { t: NOW - day, v: 100 }], NW_WINDOW_DAYS, NOW), null,
    'every sample landing at the exact same timestamp cannot fit a slope');
  assertEq(computeMonthlyGrowthRate([{ t: NOW - 2 * day, v: 0 }, { t: NOW - day, v: 0 }, { t: NOW, v: 0 }], NW_WINDOW_DAYS, NOW), null,
    'a net worth of ~zero cannot express a meaningful percentage rate');

  const rate = computeMonthlyGrowthRate(
    [{ t: NOW - 60 * day, v: 10000 }, { t: NOW - 30 * day, v: 10500 }, { t: NOW - 1 * day, v: 11000 }],
    NW_WINDOW_DAYS, NOW
  );
  assertTrue(rate > 0, 'genuinely rising values across three real points produce a positive rate');
}

{
  // MND — reading/skills/notes/mistakes, each optional.
  const readingOnly = computeAttributes({ readingItems: [{ sessions: keysBack(12).map(k => ({ date: k })) }] }, NOW);
  assertEq(ratingFromRatio(readingOnly.MND.ratio), 99, 'reading on the target number of days maxes Mind when nothing else is tracked');

  const skillsOnly = computeAttributes({ skillSessions: Array.from({ length: 12 }, () => ({ ts: NOW - 86400000 })) }, NOW);
  assertEq(ratingFromRatio(skillsOnly.MND.ratio), 99, 'skill practice alone can carry Mind too');

  const oldSkills = computeAttributes({ skillSessions: Array.from({ length: 12 }, () => ({ ts: NOW - 200 * 86400000 })) }, NOW);
  assertEq(oldSkills.MND.ratio, 0, 'practice from months ago does not count toward current form');
}

// ==================== computeRating end-to-end ====================
{
  const defs = [{ id: 'h1' }];
  const log = { h1: {} };
  keysBack(WINDOW_DAYS).forEach(k => { log.h1[k] = true; });
  const gym = {};
  keysBack(16).forEach(k => { gym[k] = true; });

  const strong = computeRating({
    coach: { splitRotation: ['a'] }, workoutDone: gym,
    habitsDefs: defs, habitsLog: log,
  }, NOW);
  assertEq(strong.ratings.PHY, 99, 'a strong training block rates Physical at 99');
  assertEq(strong.ratings.DIS, 99, 'and perfect habits rate Discipline at 99');
  assertEq(strong.ratings.VIT, null, 'untracked Vitality stays null');
  assertEq(strong.ovr, 99, 'OVR reflects only the rated attributes, so it reads 99 rather than being diluted by unrated ones');
  assertEq(strong.tier, 'Icon', 'and the tier follows the OVR');

  // Same person, but now also tracking sleep badly — OVR should drop.
  const withBadSleep = computeRating({
    coach: { splitRotation: ['a'] }, workoutDone: gym,
    habitsDefs: defs, habitsLog: log,
    nights: (() => { const n = {}; keysBack(WINDOW_DAYS).forEach(k => { n[k] = { sleepHours: 4, sleepQuality: 2 }; }); return n; })(),
  }, NOW);
  assertTrue(withBadSleep.ovr < strong.ovr, 'starting to track a domain you are doing badly at genuinely lowers your OVR');
  assertTrue(withBadSleep.ratings.VIT != null && withBadSleep.ratings.VIT < 50, 'and that domain rates poorly on its own');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
