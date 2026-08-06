// Shared, side-effect-free day-level analytics for the Insights suite and
// Correlation Lab. Pure data transformation only — no DOM, storage, or
// network access — so every consumer and the tests use the same logic.
// See docs/CORRELATION_LAB_PLAN.md for the metric and math contracts.

export const MIN_CORRELATION_SAMPLES = 8;
export const MIN_LAG_DAYS = -3;
export const MAX_LAG_DAYS = 3;

function avg(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

export function dateKeyFromDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

export function shiftDateKey(dateKey, days) {
  const parts = String(dateKey || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  const cursor = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(cursor.getTime())) return null;
  cursor.setDate(cursor.getDate() + days);
  return dateKeyFromDate(cursor);
}

export function nextDateKey(dateKey) {
  return shiftDateKey(dateKey, 1);
}

export function lastNDateKeys(count, fromDate) {
  const out = [];
  const cursor = fromDate instanceof Date ? new Date(fromDate.getTime()) : new Date();
  for (let i = 0; i < count; i++) {
    out.push(dateKeyFromDate(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }
  return out;
}

// sleep:nights uses the WAKE-UP date. A dose at/after 14:00 therefore
// belongs to the next date key, while a dose before 06:00 still belongs to
// the sleep session ending that same morning. This is the corrected PR #154
// behavior and replaces the two stale calendar-day implementations.
const LATE_CAFFEINE_EVENING_HOUR = 14;
const LATE_CAFFEINE_MORNING_HOUR = 6;

export function lateCaffeineSleepSessionDays(caffeineLogs) {
  const days = new Set();
  (caffeineLogs || []).forEach(log => {
    if (!log || !Number.isFinite(Number(log.ts))) return;
    const date = new Date(Number(log.ts));
    const hour = date.getHours();
    const dateKey = dateKeyFromDate(date);
    if (hour >= LATE_CAFFEINE_EVENING_HOUR) days.add(nextDateKey(dateKey));
    else if (hour < LATE_CAFFEINE_MORNING_HOUR) days.add(dateKey);
  });
  return days;
}

export function computeNightScore(dayRow, caffeineTracked) {
  if (!dayRow || (dayRow.sleepHours == null && dayRow.sleepQuality == null)) return null;
  const parts = [];
  if (dayRow.sleepHours != null) parts.push({ weight: 35, ratio: Math.min(1, dayRow.sleepHours / 8) });
  if (dayRow.sleepQuality != null) parts.push({ weight: 35, ratio: dayRow.sleepQuality / 5 });
  if (caffeineTracked) parts.push({ weight: 30, ratio: dayRow.factors && dayRow.factors.lateCaffeine ? 0 : 1 });
  const weightTotal = parts.reduce((sum, part) => sum + part.weight, 0);
  const weightedSum = parts.reduce((sum, part) => sum + part.ratio * part.weight, 0);
  return weightTotal ? Math.round((weightedSum / weightTotal) * 100) : null;
}

function indexCheckinsByDate(checkins) {
  const feelingByDay = {};
  const stressByDay = {};
  (checkins || []).forEach(checkin => {
    if (!checkin || !checkin.dateKey) return;
    const feeling = finiteNumber(checkin.feeling);
    const stress = finiteNumber(checkin.stress);
    if (feeling != null) (feelingByDay[checkin.dateKey] = feelingByDay[checkin.dateKey] || []).push(feeling);
    if (stress != null) (stressByDay[checkin.dateKey] = stressByDay[checkin.dateKey] || []).push(stress);
  });
  return { feelingByDay, stressByDay };
}

function sumByCalendarDate(items, getDateKey, getValue) {
  const totals = {};
  (items || []).forEach(item => {
    const dateKey = getDateKey(item);
    const value = finiteNumber(getValue(item));
    if (!dateKey || value == null) return;
    totals[dateKey] = (totals[dateKey] || 0) + value;
  });
  return totals;
}

function stretchCompletionForDate(gymData, dateKey) {
  const definitions = []
    .concat(Array.isArray(gymData['stretch:am:items']) ? gymData['stretch:am:items'] : [])
    .concat(Array.isArray(gymData['stretch:pm:items']) ? gymData['stretch:pm:items'] : []);
  const uniqueIds = Array.from(new Set(definitions.map(item => item && item.id).filter(Boolean)));
  if (!uniqueIds.length) return null;
  const log = gymData['stretch:log'] || {};
  const done = uniqueIds.filter(id => log[id] && log[id][dateKey]).length;
  return done / uniqueIds.length;
}

// Superset of the fields used by insights-recovery, -triggers, -patterns,
// -adherence, -drift, -mode, Prediction Center, and Correlation Lab.
export function buildDayRows(rowsByKey, dateKeys) {
  const source = rowsByKey || {};
  const peakData = source.peak || {};
  const sleepData = source.sleep || {};
  const caffeineData = source.caffeine || {};
  const goalsData = source.goals || {};
  const gymData = source['po-coach'] || {};
  const financeData = source.finance || {};

  const morning = sleepData['sleep:nights'] || {};
  const checkins = peakData['peak:checkins'] || [];
  const caffeineLogs = caffeineData['caf:logs'] || [];
  const caffeineTracked = caffeineLogs.length > 0;
  const habitDefs = goalsData['habits:defs'] || [];
  const habitLog = goalsData['habits:log'] || {};
  const doneDays = gymData['po_coach_workout_done'] || {};
  const workoutTracked = Object.keys(doneDays).length > 0;
  const purchases = financeData.purchases || [];

  const { feelingByDay, stressByDay } = indexCheckinsByDate(checkins);
  const lateCaffeineDays = lateCaffeineSleepSessionDays(caffeineLogs);
  const caffeineByDay = sumByCalendarDate(
    caffeineLogs,
    log => log && Number.isFinite(Number(log.ts)) ? dateKeyFromDate(new Date(Number(log.ts))) : null,
    log => log && log.mg,
  );
  const spendingByDay = sumByCalendarDate(
    purchases,
    purchase => purchase && purchase.date,
    // entered_amount is the source-of-truth requested by the plan. Older
    // rows can predate that field, so their normalized amount is a fallback.
    purchase => purchase && (purchase.entered_amount != null ? purchase.entered_amount : purchase.amount),
  );
  const spendingTracked = purchases.length > 0;

  return (dateKeys || []).map(dateKey => {
    const feelings = feelingByDay[dateKey];
    const stresses = stressByDay[dateKey];
    const morningEntry = morning[dateKey];
    const sleepQuality = morningEntry ? finiteNumber(morningEntry.sleepQuality) : null;
    const sleepHours = morningEntry ? finiteNumber(morningEntry.sleepHours) : null;
    const habitTotal = habitDefs.length;
    const habitDone = habitTotal ? habitDefs.filter(habit => habit && habitLog[habit.id] && habitLog[habit.id][dateKey]).length : 0;
    const habitRate = habitTotal ? habitDone / habitTotal : null;
    const goalsToday = Array.isArray(goalsData['goals:' + dateKey]) ? goalsData['goals:' + dateKey] : [];
    const todoRate = goalsToday.length ? goalsToday.filter(goal => goal && goal.done).length / goalsToday.length : null;
    const consistencyParts = [habitRate, todoRate].filter(value => value != null);
    const stretchRate = stretchCompletionForDate(gymData, dateKey);
    const workoutDone = !!doneDays[dateKey];

    const row = {
      dateKey,
      outcomeFeeling: feelings && feelings.length ? avg(feelings) : null,
      outcomeStress: stresses && stresses.length ? avg(stresses) : null,
      sleepQuality,
      sleepHours,
      habitRate,
      todoRate,
      consistencyRate: consistencyParts.length ? avg(consistencyParts) : null,
      workoutDone: workoutTracked ? (workoutDone ? 1 : 0) : null,
      caffeineMg: caffeineTracked ? (caffeineByDay[dateKey] || 0) : null,
      lateCaffeine: caffeineTracked ? (lateCaffeineDays.has(dateKey) ? 1 : 0) : null,
      spending: spendingTracked ? (spendingByDay[dateKey] || 0) : null,
      stretchRate,
      factors: {
        goodSleepQuality: sleepQuality != null ? sleepQuality >= 4 : null,
        poorSleepQuality: sleepQuality != null ? sleepQuality <= 2 : null,
        lowSleepHours: sleepHours != null ? sleepHours < 6.5 : null,
        workoutDone,
        lateCaffeine: lateCaffeineDays.has(dateKey),
        highHabitRate: habitRate != null ? habitRate >= 0.8 : null,
        lowHabitRate: habitRate != null ? habitRate < 0.5 : null,
        highTodoRate: todoRate != null ? todoRate >= 0.8 : null,
        lowTodoRate: todoRate != null ? todoRate < 0.4 : null,
        stretchDone: stretchRate != null ? stretchRate >= 1 : null,
      },
    };
    row.nightScore = computeNightScore(row, caffeineTracked);
    return row;
  });
}

export const METRIC_CATALOG = Object.freeze([
  { id: 'sleepHours', label: 'Sleep hours', group: 'Sleep & recovery', source: 'sleep:nights', unit: 'h', decimals: 1 },
  { id: 'sleepQuality', label: 'Sleep quality', group: 'Sleep & recovery', source: 'sleep:nights', unit: '/5', decimals: 1 },
  { id: 'nightScore', label: 'Night Score', group: 'Sleep & recovery', source: 'Derived from sleep + caffeine', unit: '/100', decimals: 0 },
  { id: 'workoutDone', label: 'Workout completed', group: 'Movement', source: 'po_coach_workout_done', binary: true, decimals: 0 },
  { id: 'stretchRate', label: 'Stretch completion', group: 'Movement', source: 'stretch:log', percent: true, decimals: 0 },
  { id: 'caffeineMg', label: 'Caffeine dose', group: 'Stimulants', source: 'caf:logs', unit: ' mg', decimals: 0 },
  { id: 'lateCaffeine', label: 'Late caffeine', group: 'Stimulants', source: 'caf:logs', binary: true, decimals: 0 },
  { id: 'outcomeFeeling', label: 'Feeling', group: 'Mood', source: 'peak:checkins', unit: '/5', decimals: 1 },
  { id: 'outcomeStress', label: 'Stress', group: 'Mood', source: 'peak:checkins', unit: '/5', decimals: 1 },
  { id: 'habitRate', label: 'Habit completion', group: 'Follow-through', source: 'habits:defs + habits:log', percent: true, decimals: 0 },
  { id: 'todoRate', label: 'To-do completion', group: 'Follow-through', source: 'goals:<date>', percent: true, decimals: 0 },
  { id: 'spending', label: 'Daily purchases', group: 'Money', source: 'purchases', unit: '', decimals: 2 },
]);

export const CORRELATION_PRESETS = Object.freeze([
  { id: 'sleep-workout', label: 'Sleep vs workout', metricA: 'sleepHours', metricB: 'workoutDone' },
  { id: 'caffeine-recovery', label: 'Caffeine vs recovery', metricA: 'lateCaffeine', metricB: 'nightScore', caveat: 'Night Score already includes a late-caffeine component, so part of this relationship is built into the score.' },
  { id: 'spending-mood', label: 'Spending vs mood', metricA: 'spending', metricB: 'outcomeFeeling' },
  { id: 'stretching-pain', label: 'Stretching vs pain proxy', metricA: 'stretchRate', metricB: 'outcomeStress', caveat: 'Using self-reported stress as a proxy; no dedicated pain tracking exists yet.' },
]);

export function metricById(metricId) {
  return METRIC_CATALOG.find(metric => metric.id === metricId) || null;
}

export function seriesForMetric(dayRows, metricId) {
  if (!metricById(metricId)) return [];
  return (dayRows || []).map(row => ({ dateKey: row && row.dateKey, value: row && row[metricId] }))
    .filter(point => point.dateKey && point.value != null && Number.isFinite(Number(point.value)))
    .map(point => ({ dateKey: point.dateKey, value: Number(point.value) }));
}

export function strengthForCorrelation(r) {
  const magnitude = Math.abs(r);
  if (magnitude < 0.1) return 'Negligible';
  if (magnitude < 0.3) return 'Weak';
  if (magnitude < 0.5) return 'Moderate';
  if (magnitude < 0.7) return 'Strong';
  return 'Very strong';
}

function pairedValues(seriesA, seriesB, lagDays) {
  const bByDate = new Map();
  (seriesB || []).forEach(point => {
    if (point && point.dateKey && Number.isFinite(Number(point.value))) bByDate.set(point.dateKey, Number(point.value));
  });
  const pairs = [];
  (seriesA || []).forEach(point => {
    if (!point || !point.dateKey || !Number.isFinite(Number(point.value))) return;
    const bDateKey = shiftDateKey(point.dateKey, lagDays);
    if (!bDateKey || !bByDate.has(bDateKey)) return;
    pairs.push({ dateKey: point.dateKey, bDateKey, a: Number(point.value), b: bByDate.get(bDateKey) });
  });
  return pairs.sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}

export function correlationAtLag(seriesA, seriesB, lagDays, options) {
  const minSamples = options && options.minSamples != null ? options.minSamples : MIN_CORRELATION_SAMPLES;
  const pairs = pairedValues(seriesA, seriesB, lagDays || 0);
  const dateRange = pairs.length ? { start: pairs[0].dateKey, end: pairs[pairs.length - 1].dateKey } : null;
  if (pairs.length < minSamples) {
    return { status: 'insufficient', lagDays: lagDays || 0, n: pairs.length, minSamples, dateRange, reason: 'Need at least ' + minSamples + ' overlapping days; found ' + pairs.length + '.' };
  }

  const aMean = avg(pairs.map(pair => pair.a));
  const bMean = avg(pairs.map(pair => pair.b));
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  pairs.forEach(pair => {
    const aDelta = pair.a - aMean;
    const bDelta = pair.b - bMean;
    covariance += aDelta * bDelta;
    varianceA += aDelta * aDelta;
    varianceB += bDelta * bDelta;
  });

  if (varianceA === 0 || varianceB === 0) {
    const constant = varianceA === 0 && varianceB === 0 ? 'both' : varianceA === 0 ? 'a' : 'b';
    return { status: 'zero-variance', lagDays: lagDays || 0, n: pairs.length, minSamples, dateRange, constant, reason: 'Not enough variation to compute a correlation.' };
  }

  const r = covariance / Math.sqrt(varianceA * varianceB);
  return {
    status: 'ok', lagDays: lagDays || 0, n: pairs.length, minSamples, dateRange,
    r: Math.max(-1, Math.min(1, r)),
    strength: strengthForCorrelation(r),
  };
}

export function pearsonCorrelation(seriesA, seriesB, options) {
  return correlationAtLag(seriesA, seriesB, 0, options);
}

export function scanLaggedCorrelations(seriesA, seriesB, options) {
  const minLag = options && options.minLag != null ? options.minLag : MIN_LAG_DAYS;
  const maxLag = options && options.maxLag != null ? options.maxLag : MAX_LAG_DAYS;
  const results = [];
  for (let lag = minLag; lag <= maxLag; lag++) results.push(correlationAtLag(seriesA, seriesB, lag, options));
  const valid = results.filter(result => result.status === 'ok');
  valid.sort((left, right) => {
    const strengthDiff = Math.abs(right.r) - Math.abs(left.r);
    if (Math.abs(strengthDiff) > 1e-12) return strengthDiff;
    const distanceDiff = Math.abs(left.lagDays) - Math.abs(right.lagDays);
    return distanceDiff || left.lagDays - right.lagDays;
  });
  return { results, best: valid[0] || null };
}

export function directionDescription(metricA, metricB, r) {
  if (!metricA || !metricB || !Number.isFinite(r)) return '';
  if (Math.abs(r) < 0.1) return 'No clear linear direction between ' + metricA.label + ' and ' + metricB.label + '.';
  return 'As ' + metricA.label.toLowerCase() + ' goes up, ' + metricB.label.toLowerCase() + ' tends to go ' + (r > 0 ? 'up' : 'down') + '.';
}

export function buildCorrelationResult(dayRows, metricAId, metricBId, options) {
  const metricA = metricById(metricAId);
  const metricB = metricById(metricBId);
  if (!metricA || !metricB) return { status: 'invalid', reason: 'Choose two metrics from the supported catalog.' };
  if (metricA.id === metricB.id) return { status: 'invalid', reason: 'Choose two different metrics.' };

  const seriesA = seriesForMetric(dayRows, metricA.id);
  const seriesB = seriesForMetric(dayRows, metricB.id);
  const lagScan = scanLaggedCorrelations(seriesA, seriesB, options);
  const zeroLag = lagScan.results.find(result => result.lagDays === 0) || pearsonCorrelation(seriesA, seriesB, options);
  const caveats = [];
  const pair = new Set([metricA.id, metricB.id]);
  if (pair.has('nightScore') && (pair.has('lateCaffeine') || pair.has('caffeineMg'))) {
    caveats.push('Night Score already includes a late-caffeine component, so part of this relationship is built into the score.');
  }
  if (pair.has('stretchRate') && pair.has('outcomeStress')) {
    caveats.push('Self-reported stress is being used as a proxy because there is no dedicated pain tracker.');
  }

  return {
    status: zeroLag.status,
    reason: zeroLag.reason || null,
    metricA,
    metricB,
    zeroLag,
    bestLag: lagScan.best,
    lags: lagScan.results,
    seriesCounts: { a: seriesA.length, b: seriesB.length },
    direction: zeroLag.status === 'ok' ? directionDescription(metricA, metricB, zeroLag.r) : '',
    caveats,
    disclaimer: 'Correlation shows that two tracked metrics moved together; it does not prove that one caused the other.',
  };
}
