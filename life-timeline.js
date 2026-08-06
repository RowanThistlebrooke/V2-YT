// Shared, side-effect-free Life Timeline aggregation. Pure data
// transformation only — no DOM, no storage, no network — so life-timeline.html
// and its tests share the exact same logic. See docs/LIFE_TIMELINE_PLAN.md
// for the full design rationale.
//
// Every adapter below turns one domain's existing storage shape into the
// common TimelineEntry shape:
//   { id, domain, ts, dateKey, precision, title, summary, sourcePage,
//     deepLink, isPR }
// `ts` is epoch ms when the source has a real moment, else null.
// `dateKey` ('YYYY-MM-DD') is ALWAYS present. `precision` is 'exact' or
// 'day' — never faked to force a day-only entry onto the ts axis.
//
// This module creates ZERO new storage keys and performs ZERO writes.
// It only reads data other pages already own.

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKeyFromTs(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// ---------- Workouts + derived PRs (gym.html) ----------
// Mirrors gym.html's own estimate1RM() exactly, so "new best" detection
// here agrees with what gym.html itself would show for the same log.
function estimate1RM(w, r) { if (r < 2) return w; return w * (1 + r / 30); }

export function adaptWorkouts(pcData) {
  const state = (pcData && pcData['po_coach_v1']) || {};
  const logs = state.logs || {};
  const exercises = state.exercises || [];
  // One representative exercise per log key, for its display name/bw flag —
  // logs are shared across every day-template entry with the same name
  // (see PR #152), so this avoids emitting the same set once per duplicate.
  const exByKey = {};
  exercises.forEach(ex => {
    const key = 'name:' + String((ex && ex.name) || '').trim().toLowerCase();
    if (!exByKey[key]) exByKey[key] = ex;
  });

  const out = [];
  Object.keys(logs).forEach(key => {
    const ex = exByKey[key] || { name: key.replace(/^name:/, ''), bw: false };
    const sorted = (logs[key] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    let bestSoFar = -Infinity;
    sorted.forEach((l, i) => {
      const score = ex.bw ? l.reps : estimate1RM(l.weight, l.reps);
      const isPR = score > bestSoFar && i > 0; // the very first-ever set isn't a "new" record, just the start
      if (score > bestSoFar) bestSoFar = score;
      const ts = new Date(l.date).getTime();
      if (!Number.isFinite(ts)) return;
      const setStr = ex.bw ? (l.reps + ' reps') : (l.weight + ' × ' + l.reps);
      out.push({
        id: 'workout:' + key + ':' + l.date,
        domain: 'workout', ts, dateKey: dateKeyFromTs(ts), precision: 'exact',
        title: ex.name + ' · ' + setStr,
        summary: isPR ? 'New best for this exercise' : '',
        sourcePage: 'gym.html', deepLink: 'gym.html', isPR,
      });
    });
  });
  return out;
}

export function adaptBodyWeight(pcData) {
  const entries = (pcData && pcData['po_coach_weights']) || [];
  return entries.filter(e => e && e.dateKey).map(e => ({
    id: 'bodyweight:' + e.dateKey,
    domain: 'bodyweight', ts: null, dateKey: e.dateKey, precision: 'day',
    title: 'Weigh-in · ' + e.weight,
    summary: '', sourcePage: 'gym.html', deepLink: 'gym.html', isPR: false,
  }));
}

// ---------- Meals (health.html) ----------
export function adaptMeals(healthData) {
  const entries = (healthData && healthData['cal:entries']) || [];
  return entries.filter(e => e && e.id).map(e => {
    const names = (e.items || []).map(it => it.name).filter(Boolean).join(', ');
    const hasTs = typeof e.ts === 'number';
    return {
      id: 'meal:' + e.id,
      domain: 'meal', ts: hasTs ? e.ts : null,
      dateKey: e.dateKey || (hasTs ? dateKeyFromTs(e.ts) : null),
      precision: hasTs ? 'exact' : 'day',
      title: names || 'Meal logged',
      summary: (e.calories != null ? e.calories + ' cal' : ''),
      sourcePage: 'health.html', deepLink: 'health.html', isPR: false,
    };
  }).filter(e => e.dateKey);
}

// ---------- Purchases + net worth activity (finance.html) ----------
// `date` (the purchase's own YYYY-MM-DD field, user-editable/backdatable)
// is the true event date; `ts` is only "when this row was logged" and can
// disagree with `date` for a backdated entry, so `date` wins for dateKey
// and this stays day-precision rather than borrowing ts's false precision.
export function adaptPurchases(financeData) {
  const arr = (financeData && financeData['purchases']) || [];
  return arr.filter(p => p && p.id && p.date).map(p => ({
    id: 'purchase:' + p.id,
    domain: 'purchase', ts: null, dateKey: p.date, precision: 'day',
    title: p.name || 'Purchase',
    summary: (p.entered_amount != null ? p.entered_amount + ' ' + (p.entered_currency || '') : ''),
    sourcePage: 'finance.html', deepLink: 'finance.html', isPR: false,
  }));
}

export function adaptNetWorthActivity(financeData) {
  const arr = (financeData && financeData['nw:activity']) || [];
  return arr.filter(a => a && typeof a.ts === 'number').map((a, i) => ({
    id: 'networth:' + a.ts + ':' + i,
    domain: 'networth', ts: a.ts, dateKey: dateKeyFromTs(a.ts), precision: 'exact',
    title: (a.kind === 'delete' ? 'Removed ' : a.kind === 'edit' ? 'Updated ' : 'Added ') + (a.name || a.cat || 'net worth item'),
    summary: (a.delta != null ? (a.delta > 0 ? '+' : '') + a.delta : ''),
    sourcePage: 'finance.html', deepLink: 'finance.html', isPR: false,
  }));
}

// ---------- Business revenue/payments (business.html) ----------
export function adaptBusinessRevenue(businessData) {
  const out = [];
  ((businessData && businessData['biz:affiliate:revenue']) || []).forEach(r => {
    if (!r || !r.id) return;
    const hasTs = typeof r.ts === 'number';
    out.push({
      id: 'business:revenue:' + r.id,
      domain: 'business', ts: hasTs ? r.ts : null,
      dateKey: r.date || (hasTs ? dateKeyFromTs(r.ts) : null),
      precision: hasTs && r.date == null ? 'exact' : 'day',
      title: 'Affiliate revenue' + (r.note ? ' · ' + r.note : ''),
      summary: (r.amount != null ? '+' + r.amount : ''),
      sourcePage: 'business.html', deepLink: 'business.html', isPR: false,
    });
  });
  ((businessData && businessData['biz:editing:payments']) || []).forEach(p => {
    if (!p || !p.id) return;
    const hasTs = typeof p.ts === 'number';
    out.push({
      id: 'business:payment:' + p.id,
      domain: 'business', ts: hasTs ? p.ts : null,
      dateKey: p.date || (hasTs ? dateKeyFromTs(p.ts) : null),
      precision: hasTs && p.date == null ? 'exact' : 'day',
      title: 'Payment received' + (p.note ? ' · ' + p.note : ''),
      summary: (p.amount != null ? '+' + p.amount : ''),
      sourcePage: 'business.html', deepLink: 'business.html', isPR: false,
    });
  });
  return out.filter(e => e.dateKey);
}

// ---------- Tasks (leverage) + habits (main.html) ----------
// goals:<date> keys are deleted by main.html's rollover() once the day
// passes, so per-todo history genuinely does not exist beyond today — the
// only durable daily-task signal is the single Leverage Task per day
// (capped history) and the habit check-in grid. See LIFE_TIMELINE_PLAN.md §1.
export function adaptLeverageHistory(goalsData) {
  const stats = (goalsData && goalsData['leverage_stats_v1']) || {};
  const history = stats.history || [];
  return history.filter(h => h && h.date && h.done).map(h => ({
    id: 'task:leverage:' + h.date,
    domain: 'task', ts: null, dateKey: h.date, precision: 'day',
    title: 'Leverage task done · ' + (h.text || ''),
    summary: '', sourcePage: 'main.html', deepLink: 'main.html', isPR: false,
  }));
}

export function adaptHabitCheckins(goalsData) {
  const defs = (goalsData && goalsData['habits:defs']) || [];
  const log = (goalsData && goalsData['habits:log']) || {};
  const nameById = {};
  defs.forEach(d => { if (d && d.id) nameById[d.id] = d.name; });
  const out = [];
  Object.keys(log).forEach(habitId => {
    const days = log[habitId] || {};
    Object.keys(days).forEach(dateKey => {
      if (!days[dateKey]) return;
      out.push({
        id: 'habit:' + habitId + ':' + dateKey,
        domain: 'habit', ts: null, dateKey, precision: 'day',
        title: (nameById[habitId] || 'Habit') + ' checked in',
        summary: '', sourcePage: 'main.html', deepLink: 'main.html', isPR: false,
      });
    });
  });
  return out;
}

// ---------- Peak check-ins (peak.html) ----------
export function adaptPeakCheckins(peakData) {
  const arr = (peakData && peakData['peak:checkins']) || [];
  return arr.filter(c => c && c.id).map(c => {
    const hasTs = typeof c.ts === 'number';
    return {
      id: 'checkin:' + c.id,
      domain: 'checkin', ts: hasTs ? c.ts : null,
      dateKey: c.dateKey || (hasTs ? dateKeyFromTs(c.ts) : null),
      precision: hasTs ? 'exact' : 'day',
      title: 'Check-in' + (c.feeling != null ? ' · feeling ' + c.feeling + '/5' : ''),
      summary: c.note || '',
      sourcePage: 'peak.html', deepLink: 'peak.html', isPR: false,
    };
  }).filter(e => e.dateKey);
}

// ---------- Notes (notes.html) ----------
export function adaptNotes(notesData) {
  const items = (notesData && notesData['notes:items']) || [];
  return items.filter(n => n && n.id && typeof n.updatedAt === 'number').map(n => ({
    id: 'note:' + n.id,
    domain: 'note', ts: n.updatedAt, dateKey: dateKeyFromTs(n.updatedAt), precision: 'exact',
    title: n.title || 'Untitled note',
    summary: (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    sourcePage: 'notes.html', deepLink: 'notes.html', isPR: false,
  }));
}

// ---------- Schedule appointments (schedule.html) ----------
// An appointment's start time is a real, meaningful moment (not just "when
// this was logged"), so this is 'exact' precision, composed from date+start
// rather than borrowed from a ts field the model doesn't have.
export function adaptAppointments(scheduleData) {
  const model = (scheduleData && scheduleData['schedule:model_v1']) || {};
  const appts = model.appointments || [];
  return appts.filter(a => a && a.id && a.date && a.start).map(a => {
    const ts = new Date(a.date + 'T' + a.start + ':00').getTime();
    return {
      id: 'appointment:' + a.id,
      domain: 'appointment', ts: Number.isFinite(ts) ? ts : null,
      dateKey: a.date, precision: Number.isFinite(ts) ? 'exact' : 'day',
      title: a.title || 'Appointment',
      summary: a.start + (a.end ? '–' + a.end : '') + (a.location ? ' · ' + a.location : ''),
      sourcePage: 'schedule.html', deepLink: 'schedule.html', isPR: false,
    };
  });
}

// ---------- Telegram assistant actions ----------
// These rows live directly in Supabase under telegram-action:<id>, outside
// every page's normal syncedKeys pull — see §2 of the design doc for why
// this adapter takes an already-fetched array rather than a storage blob
// like the others.
export function adaptTelegramActions(actionRows) {
  return (actionRows || []).filter(a => a && a.id && typeof a.ts === 'number').map(a => ({
    id: 'telegram:' + a.id,
    domain: 'telegram', ts: a.ts, dateKey: dateKeyFromTs(a.ts), precision: 'exact',
    title: 'Assistant: ' + (a.description || (a.row ? 'updated ' + a.row : 'action')),
    summary: '', sourcePage: 'Telegram', deepLink: null, isPR: false,
  }));
}

// ---------- Merge, sort, filter, search, summarize ----------

// Exact-precision entries sort by real ts within a day; day-only entries
// have no real position to interleave at, so they render first within
// their day (a fixed, predictable position) rather than being scattered
// unpredictably among timed entries they can't actually be ordered against.
export function mergeAndSort(entryLists) {
  const all = [].concat(...entryLists);
  return all.sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1; // newest day first
    if (a.precision !== b.precision) return a.precision === 'day' ? -1 : 1;
    if (a.precision === 'exact') return (b.ts || 0) - (a.ts || 0);
    return 0;
  });
}

export function filterByRange(entries, fromKey, toKey) {
  return entries.filter(e => e.dateKey >= fromKey && e.dateKey <= toKey);
}

export function filterByDomains(entries, domains) {
  if (!domains || !domains.length) return entries;
  const set = new Set(domains);
  return entries.filter(e => set.has(e.domain));
}

// Same substring-match approach as search-index.js's searchIndex(), for
// consistency across the dashboard's two search surfaces.
export function searchEntries(entries, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(e => ((e.title || '') + ' ' + (e.summary || '')).toLowerCase().indexOf(q) !== -1);
}

const DOMAIN_SUMMARY_LABEL = {
  workout: 'workout', bodyweight: 'weigh-in', meal: 'meal', purchase: 'purchase',
  networth: 'net worth update', business: 'business event', task: 'leverage task',
  habit: 'habit check-in', checkin: 'check-in', note: 'note', appointment: 'appointment',
  telegram: 'assistant action',
};

// A plain template over counts already available post-aggregation — not a
// new inference engine, just "how many of each thing happened this day."
export function buildDaySummary(dayEntries) {
  const counts = {};
  dayEntries.forEach(e => { counts[e.domain] = (counts[e.domain] || 0) + 1; });
  return Object.keys(counts)
    .map(domain => counts[domain] + ' ' + DOMAIN_SUMMARY_LABEL[domain] + (counts[domain] === 1 ? '' : 's'))
    .join(' · ');
}
