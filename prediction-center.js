import { dateKeyFromDate, lastNDateKeys, buildDayRows } from './correlation-lab.js';
export { dateKeyFromDate, lastNDateKeys, buildDayRows } from './correlation-lab.js';

// Shared, side-effect-free Prediction Center module. Pure data
// transformation only — no DOM, no storage, no network — so
// prediction-center.html and its tests share the exact same logic. See
// docs/PREDICTION_CENTER_PLAN.md for the full design rationale.
//
// Every function below is a verbatim duplicate of a function that already
// ships on another page (source file:line cited above each one). Consolidate
// existing forecasting logic — reuse verified math, never invent new
// forecasting algorithms for this page. This module creates ZERO new storage
// keys and performs ZERO writes; it only reads data other pages already own.

// ---------- Weight trajectory (gym.html:3585-3636 trajPercentile/trajWeeklyRates/trajCompute) ----------
const TRAJ_WINDOW_DAYS = 90;
const TRAJ_MIN_ENTRIES = 3;

function wtParseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function trajPercentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function trajWeeklyRates(entries) {
  const rates = [];
  for (let i = 1; i < entries.length; i++) {
    const days = (wtParseKey(entries[i].dateKey) - wtParseKey(entries[i - 1].dateKey)) / 86400000;
    if (days <= 0) continue;
    rates.push(((entries[i].weight - entries[i - 1].weight) / days) * 7);
  }
  return rates;
}

export function trajCompute(entries, goal) {
  const cutoff = Date.now() - TRAJ_WINDOW_DAYS * 86400000;
  const windowed = entries.filter(e => wtParseKey(e.dateKey).getTime() >= cutoff);
  if (windowed.length < TRAJ_MIN_ENTRIES) return null;

  const rates = trajWeeklyRates(windowed).sort((a, b) => a - b);
  if (!rates.length) return null;
  const median = trajPercentile(rates, 0.5);
  const p25 = trajPercentile(rates, 0.25);
  const p75 = trajPercentile(rates, 0.75);
  const isLosing = median <= 0;
  const slowRate = isLosing ? p75 : p25;
  const fastRate = isLosing ? p25 : p75;
  const current = windowed[windowed.length - 1].weight;

  const scenarios = { slow: slowRate, typical: median, fast: fastRate };
  const etas = {};
  if (goal != null && !isNaN(goal)) {
    Object.keys(scenarios).forEach(key => {
      const rate = scenarios[key];
      const diff = goal - current;
      if (rate === 0 || Math.sign(rate) !== Math.sign(diff)) { etas[key] = null; return; }
      const weeksNeeded = diff / rate;
      etas[key] = new Date(Date.now() + weeksNeeded * 7 * 86400000);
    });
  }
  return { windowed, current, scenarios, etas, goal };
}

// ---------- Net worth trajectory (finance.html:2925-2971 nwPercentile/nwMonthlyRates/computeNwScenarios) ----------
const NW_TRAJ_MIN_SNAPSHOTS = 3;
const FORECAST_WINDOW_DAYS = 180;

function nwPercentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function nwMonthlyRates(points) {
  const rates = [];
  for (let i = 1; i < points.length; i++) {
    const days = (points[i].t - points[i - 1].t) / 86400000;
    if (days <= 0) continue;
    rates.push(((points[i].v - points[i - 1].v) / days) * 30.44);
  }
  return rates;
}

export function computeNwScenarios(history, windowDays, goal) {
  if (!Array.isArray(history) || history.length < NW_TRAJ_MIN_SNAPSHOTS) return null;
  const cutoff = windowDays ? Date.now() - windowDays * 86400000 : -Infinity;
  const windowed = history.filter(p => p.t >= cutoff).sort((a, b) => a.t - b.t);
  if (windowed.length < NW_TRAJ_MIN_SNAPSHOTS) return null;

  const rates = nwMonthlyRates(windowed).sort((a, b) => a - b);
  if (!rates.length) return null;
  const median = nwPercentile(rates, 0.5);
  const p25 = nwPercentile(rates, 0.25);
  const p75 = nwPercentile(rates, 0.75);
  const isShrinking = median <= 0;
  const slowRate = isShrinking ? p75 : p25;
  const fastRate = isShrinking ? p25 : p75;
  const current = windowed[windowed.length - 1].v;

  const scenarios = { slow: slowRate, typical: median, fast: fastRate };
  const etas = {};
  if (goal != null && !isNaN(goal)) {
    Object.keys(scenarios).forEach(key => {
      const rate = scenarios[key];
      const diff = goal - current;
      if (rate === 0 || Math.sign(rate) !== Math.sign(diff)) { etas[key] = null; return; }
      const monthsNeeded = diff / rate;
      etas[key] = new Date(Date.now() + monthsNeeded * 30.44 * 86400000);
    });
  }
  return { windowed, current, scenarios, etas, goal };
}

// ---------- Shared day-row builder (correlation-lab.js) ----------
function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// ---------- Sleep debt + Burnout risk (insights-recovery.html:224-269) ----------
const TARGET_SLEEP_HOURS = 8;
const BURNOUT_TREND_DIFF = { stress: 0.5, sleepQuality: 0.5, consistency: 0.15 };

export function computeSleepDebt(dayRows, targetHours) {
  targetHours = targetHours == null ? TARGET_SLEEP_HOURS : targetHours;
  const nights = (dayRows || []).filter(r => typeof r.sleepHours === 'number');
  if (!nights.length) return null;
  const totalDebt = nights.reduce((a, r) => a + Math.max(0, targetHours - r.sleepHours), 0);
  const avgHours = avg(nights.map(r => r.sleepHours));
  return { totalDebt, nights: nights.length, targetHours, avgDebtPerNight: totalDebt / nights.length, avgHours };
}

export function computeBurnoutRisk(dayRows) {
  const recent = (dayRows || []).slice(0, 7);
  const prior = (dayRows || []).slice(7, 14);
  function avgField(rows, field) {
    const vals = rows.map(r => r[field]).filter(v => v != null);
    return vals.length ? avg(vals) : null;
  }
  const recentStress = avgField(recent, 'outcomeStress');
  const priorStress = avgField(prior, 'outcomeStress');
  const recentSleepQ = avgField(recent, 'sleepQuality');
  const priorSleepQ = avgField(prior, 'sleepQuality');
  const recentConsistency = avgField(recent, 'consistencyRate');
  const priorConsistency = avgField(prior, 'consistencyRate');

  const signals = [];
  if (recentStress != null && priorStress != null && (recentStress - priorStress) >= BURNOUT_TREND_DIFF.stress) {
    signals.push('stress has been trending up this week');
  }
  if (recentSleepQ != null && priorSleepQ != null && (priorSleepQ - recentSleepQ) >= BURNOUT_TREND_DIFF.sleepQuality) {
    signals.push('sleep quality has been trending down this week');
  }
  if (recentConsistency != null && priorConsistency != null && (priorConsistency - recentConsistency) >= BURNOUT_TREND_DIFF.consistency) {
    signals.push('habit/to-do consistency has slipped this week');
  }

  const comparisonsAvailable = [
    recentStress != null && priorStress != null,
    recentSleepQ != null && priorSleepQ != null,
    recentConsistency != null && priorConsistency != null,
  ].filter(Boolean).length;
  if (!comparisonsAvailable) return { level: 'Unknown', signals: [], insufficientData: true };

  const level = signals.length >= 2 ? 'Elevated' : signals.length === 1 ? 'Moderate' : 'Low';
  return {
    level, signals, insufficientData: false,
    recentStress, priorStress, recentSleepQ, priorSleepQ, recentConsistency, priorConsistency,
  };
}

// ---------- Habit/goal completion (insights-adherence.html:135-148) ----------
const ADHERENCE_TREND_RECENT_DAYS = 14;
const ADHERENCE_TREND_MIN_SAMPLES = 5;

export function computeOverallAdherence(dayRows) {
  const vals = (dayRows || []).map(r => r.consistencyRate).filter(v => v != null);
  if (!vals.length) return null;
  return { rate: avg(vals), n: vals.length };
}

export function computeAdherenceTrend(dayRows, recentDays) {
  recentDays = recentDays || ADHERENCE_TREND_RECENT_DAYS;
  const recentVals = (dayRows || []).slice(0, recentDays).map(r => r.consistencyRate).filter(v => v != null);
  const priorVals = (dayRows || []).slice(recentDays).map(r => r.consistencyRate).filter(v => v != null);
  if (recentVals.length < ADHERENCE_TREND_MIN_SAMPLES || priorVals.length < ADHERENCE_TREND_MIN_SAMPLES) return null;
  const recentAvg = avg(recentVals), priorAvg = avg(priorVals);
  return { recentAvg, priorAvg, diff: recentAvg - priorAvg };
}

// ---------- Card assembly ----------
// Builds the fixed-order card list Prediction Center renders. Each card is
// self-describing (type, confidence framing, source) so the UI layer does no
// interpretation of its own — every card here already carries everything
// §2 of the design doc requires being shown.

export function buildWeightCard(pcData) {
  const state = (pcData && pcData['po_coach_v1']) || {};
  const entries = (pcData && pcData['po_coach_weights']) || [];
  const goal = (pcData && pcData['po_coach_weight_goal']) || null;
  const result = trajCompute(entries.filter(e => e && e.dateKey && typeof e.weight === 'number'), goal);
  return {
    type: 'weight',
    title: 'Weight',
    confidence: result ? 'banded' : 'unavailable',
    horizonDays: TRAJ_WINDOW_DAYS,
    sourcePage: 'gym.html',
    deepLink: 'gym.html',
    dataVolume: entries.length,
    minDataVolume: TRAJ_MIN_ENTRIES,
    result,
    assumptions: 'Slow/Typical/Fast bands are the 25th/50th/75th percentile of weekly rate-of-change over the trailing ' + TRAJ_WINDOW_DAYS + ' days, not a single straight-line guess.',
  };
}

export function buildNetWorthCard(financeData) {
  const history = (financeData && financeData['nw:history']) || [];
  const result = computeNwScenarios(history, FORECAST_WINDOW_DAYS, null);
  return {
    type: 'networth',
    title: 'Net Worth',
    confidence: result ? 'banded' : 'unavailable',
    horizonDays: FORECAST_WINDOW_DAYS,
    sourcePage: 'finance.html',
    deepLink: 'finance.html',
    dataVolume: history.length,
    minDataVolume: NW_TRAJ_MIN_SNAPSHOTS,
    result,
    assumptions: 'Slow/Typical/Fast bands are the 25th/50th/75th percentile of monthly rate-of-change over the trailing ' + FORECAST_WINDOW_DAYS + ' days.',
  };
}

export function buildSleepCard(rowsByKey) {
  const dateKeys = lastNDateKeys(14);
  const dayRows = buildDayRows(rowsByKey, dateKeys);
  const debt = computeSleepDebt(dayRows, TARGET_SLEEP_HOURS);
  const burnout = computeBurnoutRisk(dayRows);
  return {
    type: 'sleep',
    title: 'Sleep Debt & Burnout Risk',
    confidence: debt ? 'point-estimate' : 'unavailable',
    horizonDays: 14,
    sourcePage: 'insights-recovery.html',
    deepLink: 'insights-recovery.html',
    dataVolume: debt ? debt.nights : 0,
    minDataVolume: 1,
    debt, burnout,
    assumptions: 'Sleep debt is an accumulated total against an ' + TARGET_SLEEP_HOURS + 'h/night target over the trailing 14 days — a current status, not a projection. Burnout risk compares the last 7 days against the 7 before that and reports a category (Low/Moderate/Elevated), not a numeric forecast.',
  };
}

export function buildAdherenceCard(rowsByKey) {
  const dateKeys = lastNDateKeys(28);
  const dayRows = buildDayRows(rowsByKey, dateKeys);
  const overall = computeOverallAdherence(dayRows);
  const trend = computeAdherenceTrend(dayRows, ADHERENCE_TREND_RECENT_DAYS);
  return {
    type: 'adherence',
    title: 'Habit & Goal Completion',
    confidence: trend ? 'trend' : 'unavailable',
    horizonDays: ADHERENCE_TREND_RECENT_DAYS,
    sourcePage: 'insights-adherence.html',
    deepLink: 'insights-adherence.html',
    dataVolume: overall ? overall.n : 0,
    minDataVolume: ADHERENCE_TREND_MIN_SAMPLES * 2,
    overall, trend,
    assumptions: 'Shown as a recent-vs-prior directional trend (last ' + ADHERENCE_TREND_RECENT_DAYS + ' days vs. the ' + ADHERENCE_TREND_RECENT_DAYS + ' before that), not an extrapolated forecast — no rate-of-change math for this metric exists yet.',
  };
}

export function buildScheduleCard() {
  return {
    type: 'schedule',
    title: 'Schedule Adherence',
    confidence: 'unavailable',
    sourcePage: 'schedule.html',
    deepLink: 'schedule.html',
    reason: 'No adherence/reconciliation-rate calculation exists yet for the Weekly Schedule System — showing one here would mean inventing new forecasting math, which is out of scope for this page.',
  };
}

// Fixed order per docs/PREDICTION_CENTER_PLAN.md §3.
export function buildAllCards(data) {
  return [
    buildWeightCard(data.pcData || {}),
    buildNetWorthCard(data.financeData || {}),
    buildSleepCard(data.rowsByKey || {}),
    buildAdherenceCard(data.rowsByKey || {}),
    buildScheduleCard(),
  ];
}
