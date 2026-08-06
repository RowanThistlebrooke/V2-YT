// Coverage for life-timeline.js — every domain adapter, the merge/sort/
// precision rules, the dedup id scheme, and the day-summary generator.
// See docs/LIFE_TIMELINE_PLAN.md for the design this implements.

import {
  adaptWorkouts, adaptBodyWeight, adaptMeals, adaptPurchases, adaptNetWorthActivity,
  adaptBusinessRevenue, adaptLeverageHistory, adaptHabitCheckins, adaptPeakCheckins,
  adaptNotes, adaptAppointments, adaptTelegramActions,
  mergeAndSort, filterByRange, filterByDomains, searchEntries, buildDaySummary,
} from '../life-timeline.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(condition, label) {
  if (condition) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}

// ==================== adaptWorkouts ====================
{
  const pcData = {
    po_coach_v1: {
      exercises: [{ name: 'Bench Press', bw: false }, { name: 'Pull-ups', bw: true }],
      logs: {
        'name:bench press': [
          { date: '2026-07-01T10:00:00.000Z', weight: 135, reps: 8 },
          { date: '2026-07-08T10:00:00.000Z', weight: 145, reps: 8 },
          { date: '2026-07-15T10:00:00.000Z', weight: 140, reps: 8 },
        ],
        'name:pull-ups': [
          { date: '2026-07-02T10:00:00.000Z', weight: 0, reps: 10 },
        ],
      },
    },
  };
  const out = adaptWorkouts(pcData);
  assertEq(out.length, 4, 'adaptWorkouts emits one entry per logged set across all exercises');
  const bench = out.filter(e => e.title.startsWith('Bench Press')).sort((a, b) => a.ts - b.ts);
  assertEq(bench[0].isPR, false, 'the very first-ever set for an exercise is not flagged as a new PR');
  assertEq(bench[1].isPR, true, 'a heavier estimated-1RM set is flagged as a new best');
  assertEq(bench[2].isPR, false, 'a lighter set than the existing best is not flagged as a new best');
  assertTrue(out.every(e => e.domain === 'workout' && e.precision === 'exact' && e.sourcePage === 'gym.html'), 'every workout entry carries the expected domain/precision/source');
  assertEq(out.find(e => e.title.includes('Pull-ups')).title, 'Pull-ups · 10 reps', 'bodyweight exercises render reps-only, not weight × reps');

  const unknownExercise = adaptWorkouts({ po_coach_v1: { exercises: [], logs: { 'name:deadlift': [{ date: '2026-07-01T10:00:00.000Z', weight: 200, reps: 5 }] } } });
  assertEq(unknownExercise[0].title, 'deadlift · 200 × 5', 'a log with no matching exercise definition falls back to the log key as a name');

  const badDate = adaptWorkouts({ po_coach_v1: { exercises: [], logs: { 'name:x': [{ date: 'not-a-date', weight: 10, reps: 5 }] } } });
  assertEq(badDate.length, 0, 'a set with an unparsable date is dropped rather than emitted with a garbage timestamp');

  assertEq(adaptWorkouts({}).length, 0, 'adaptWorkouts tolerates missing po_coach_v1 entirely');
}

// ==================== adaptBodyWeight ====================
{
  const out = adaptBodyWeight({ po_coach_weights: [{ dateKey: '2026-07-10', weight: 180 }, { weight: 181 }, null] });
  assertEq(out.length, 1, 'adaptBodyWeight drops entries missing a dateKey');
  assertEq(out[0], {
    id: 'bodyweight:2026-07-10', domain: 'bodyweight', ts: null, dateKey: '2026-07-10', precision: 'day',
    title: 'Weigh-in · 180', summary: '', sourcePage: 'gym.html', deepLink: 'gym.html', isPR: false,
  }, 'adaptBodyWeight produces the exact expected TimelineEntry shape');
}

// ==================== adaptMeals ====================
{
  const out = adaptMeals({
    'cal:entries': [
      { id: 'm1', ts: 1751000000000, items: [{ name: 'Chicken' }, { name: 'Rice' }], calories: 620 },
      { id: 'm2', dateKey: '2026-07-05', items: [], calories: 300 },
      { id: 'm3' },
    ],
  });
  assertEq(out.length, 2, 'adaptMeals drops entries with no timestamp AND no dateKey to fall back on');
  assertEq(out[0].precision, 'exact', 'a meal with a real ts gets exact precision');
  assertEq(out[0].title, 'Chicken, Rice', 'meal titles join item names');
  assertEq(out[1].precision, 'day', 'a meal with only a dateKey (no ts) is honestly day-precision');
  assertEq(out[1].title, 'Meal logged', 'a meal with no item names falls back to a generic title');
}

// ==================== adaptPurchases / adaptNetWorthActivity ====================
{
  const purchases = adaptPurchases({ purchases: [{ id: 'p1', date: '2026-07-04', name: 'Desk', entered_amount: 200, entered_currency: 'USD' }, { id: 'p2' }] });
  assertEq(purchases.length, 1, 'adaptPurchases drops purchases with no date');
  assertEq(purchases[0].precision, 'day', 'purchases are always day-precision, never borrowing ts');
  assertEq(purchases[0].dateKey, '2026-07-04', 'a purchase’s own date field wins over any logged ts');

  const nw = adaptNetWorthActivity({ 'nw:activity': [{ ts: 1751000000000, kind: 'add', name: 'Brokerage', delta: 500 }, { kind: 'edit', name: 'x' }] });
  assertEq(nw.length, 1, 'adaptNetWorthActivity drops rows with no numeric ts');
  assertEq(nw[0].title, 'Added Brokerage', 'add-kind rows render an Added title');
  assertEq(nw[0].summary, '+500', 'a positive delta is shown with an explicit plus sign');
}

// ==================== adaptBusinessRevenue ====================
{
  const out = adaptBusinessRevenue({
    'biz:affiliate:revenue': [{ id: 'r1', ts: 1751000000000, amount: 40 }],
    'biz:editing:payments': [{ id: 'pay1', date: '2026-07-06', amount: 300, note: 'Client A' }],
  });
  assertEq(out.length, 2, 'adaptBusinessRevenue merges affiliate revenue and editing payments into one list');
  assertEq(out[0].precision, 'exact', 'a revenue row with only a ts is exact precision');
  assertEq(out[1].precision, 'day', 'a payment row with an explicit date field is day precision, not exact');
  assertEq(out[1].title, 'Payment received · Client A', 'payment titles include the note when present');
}

// ==================== adaptLeverageHistory / adaptHabitCheckins ====================
{
  const leverage = adaptLeverageHistory({ leverage_stats_v1: { history: [{ date: '2026-07-01', done: true, text: 'Ship PR' }, { date: '2026-07-02', done: false, text: 'Skipped' }] } });
  assertEq(leverage.length, 1, 'adaptLeverageHistory only surfaces completed leverage-task days');
  assertEq(leverage[0].title, 'Leverage task done · Ship PR', 'leverage entries include the task text');

  const habits = adaptHabitCheckins({
    'habits:defs': [{ id: 'h1', name: 'Stretch' }],
    'habits:log': { h1: { '2026-07-01': true, '2026-07-02': false }, h2: { '2026-07-01': true } },
  });
  assertEq(habits.length, 2, 'adaptHabitCheckins only counts true check-in days, across known and unknown habit ids');
  assertTrue(habits.some(e => e.title === 'Stretch checked in'), 'a known habit id resolves to its defined name');
  assertTrue(habits.some(e => e.title === 'Habit checked in'), 'an unknown habit id falls back to a generic label rather than throwing');
}

// ==================== adaptPeakCheckins ====================
{
  const out = adaptPeakCheckins({ 'peak:checkins': [{ id: 'c1', ts: 1751000000000, feeling: 4, note: 'Good day' }, { id: 'c2', dateKey: '2026-07-03' }, { id: 'c3' }] });
  assertEq(out.length, 2, 'adaptPeakCheckins drops check-ins with neither ts nor dateKey');
  assertEq(out[0].title, 'Check-in · feeling 4/5', 'a check-in with a feeling score includes it in the title');
  assertEq(out[1].title, 'Check-in', 'a check-in with no feeling score falls back to a bare title');
}

// ==================== adaptNotes ====================
{
  const out = adaptNotes({ 'notes:items': [{ id: 'n1', title: 'Ideas', body: 'Line one\n\n  line two  ', updatedAt: 1751000000000 }, { id: 'n2', body: 'no title', updatedAt: 1751000001000 }, { id: 'n3', title: 'No timestamp' }] });
  assertEq(out.length, 2, 'adaptNotes drops notes with no numeric updatedAt');
  assertEq(out[0].summary, 'Line one line two', 'note summaries collapse whitespace like the shared search index does');
  assertEq(out[1].title, 'Untitled note', 'a note with no title falls back to Untitled note');
}

// ==================== adaptAppointments ====================
{
  const out = adaptAppointments({
    'schedule:model_v1': {
      appointments: [
        { id: 'a1', date: '2026-07-10', start: '14:30', end: '15:00', title: 'Dentist', location: 'Clinic' },
        { id: 'a2', date: '2026-07-11' },
      ],
    },
  });
  assertEq(out.length, 1, 'adaptAppointments requires both a date and a start time');
  assertEq(out[0].precision, 'exact', 'an appointment composed from date+start is exact precision');
  assertEq(out[0].summary, '14:30–15:00 · Clinic', 'appointment summaries include the time range and location');
}

// ==================== adaptTelegramActions ====================
{
  const out = adaptTelegramActions([{ id: 't1', ts: 1751000000000, description: 'logged a workout set' }, { id: 't2', ts: 1751000001000, row: 'purchases' }, { id: 't3' }]);
  assertEq(out.length, 2, 'adaptTelegramActions drops rows with no numeric ts');
  assertEq(out[0].title, 'Assistant: logged a workout set', 'a description is used verbatim when present');
  assertEq(out[1].title, 'Assistant: updated purchases', 'a row name is used to synthesize a title when no description is present');
  assertEq(out[0].deepLink, null, 'Telegram-originated entries have no in-dashboard deep link');
}

// ==================== dedup id scheme ====================
{
  const ids = []
    .concat(adaptWorkouts({ po_coach_v1: { exercises: [], logs: { 'name:x': [{ date: '2026-07-01T10:00:00.000Z', weight: 10, reps: 5 }] } } }).map(e => e.id))
    .concat(adaptBodyWeight({ po_coach_weights: [{ dateKey: '2026-07-01', weight: 180 }] }).map(e => e.id))
    .concat(adaptMeals({ 'cal:entries': [{ id: 'x', dateKey: '2026-07-01', items: [] }] }).map(e => e.id))
    .concat(adaptPurchases({ purchases: [{ id: 'x', date: '2026-07-01', name: 'Item' }] }).map(e => e.id))
    .concat(adaptNetWorthActivity({ 'nw:activity': [{ ts: 1751000000000, kind: 'add' }] }).map(e => e.id))
    .concat(adaptLeverageHistory({ leverage_stats_v1: { history: [{ date: '2026-07-01', done: true }] } }).map(e => e.id))
    .concat(adaptNotes({ 'notes:items': [{ id: 'x', updatedAt: 1751000000000 }] }).map(e => e.id))
    .concat(adaptAppointments({ 'schedule:model_v1': { appointments: [{ id: 'x', date: '2026-07-01', start: '09:00' }] } }).map(e => e.id))
    .concat(adaptTelegramActions([{ id: 'x', ts: 1751000000000 }]).map(e => e.id));
  assertEq(new Set(ids).size, ids.length, 'every domain’s id prefix keeps ids unique even when the underlying source ids collide (all "x")');

  const twoLogsOfSameSet = adaptWorkouts({ po_coach_v1: { exercises: [], logs: { 'name:x': [{ date: '2026-07-01T10:00:00.000Z', weight: 10, reps: 5 }] }, extra: 1 } });
  assertEq(twoLogsOfSameSet.length, 1, 'a single logged set produces exactly one timeline entry (no duplication from re-reading the log)');
}

// ==================== mergeAndSort ====================
{
  const merged = mergeAndSort([
    [{ id: 'e1', domain: 'note', ts: null, dateKey: '2026-07-01', precision: 'day' }],
    [{ id: 'e2', domain: 'note', ts: 1751000005000, dateKey: '2026-07-02', precision: 'exact' }],
    [{ id: 'e3', domain: 'note', ts: 1751000001000, dateKey: '2026-07-02', precision: 'exact' }],
    [{ id: 'e4', domain: 'note', ts: null, dateKey: '2026-07-02', precision: 'day' }],
  ]);
  assertEq(merged.map(e => e.id), ['e4', 'e2', 'e3', 'e1'], 'mergeAndSort orders newest day first, day-only entries before timed entries within a day, and timed entries newest-first');
  assertEq(mergeAndSort([]).length, 0, 'mergeAndSort tolerates an empty list of lists');
}

// ==================== filterByRange / filterByDomains ====================
{
  const entries = [
    { id: 'a', domain: 'note', dateKey: '2026-07-01' },
    { id: 'b', domain: 'workout', dateKey: '2026-07-05' },
    { id: 'c', domain: 'note', dateKey: '2026-07-10' },
  ];
  assertEq(filterByRange(entries, '2026-07-02', '2026-07-08').map(e => e.id), ['b'], 'filterByRange is inclusive on both ends and excludes outside the window');
  assertEq(filterByDomains(entries, ['note']).map(e => e.id), ['a', 'c'], 'filterByDomains keeps only the requested domains');
  assertEq(filterByDomains(entries, []).length, 3, 'filterByDomains with an empty selection is a no-op, not a filter-everything');
  assertEq(filterByDomains(entries, null).length, 3, 'filterByDomains tolerates a null domain list');
}

// ==================== searchEntries ====================
{
  const entries = [
    { id: 'a', title: 'Bench Press · 135 × 8', summary: 'New best for this exercise' },
    { id: 'b', title: 'Dentist', summary: '14:30–15:00' },
  ];
  assertEq(searchEntries(entries, 'bench').map(e => e.id), ['a'], 'searchEntries matches case-insensitively against the title');
  assertEq(searchEntries(entries, 'new best').map(e => e.id), ['a'], 'searchEntries also matches against the summary');
  assertEq(searchEntries(entries, '').length, 2, 'an empty query returns every entry unfiltered');
  assertEq(searchEntries(entries, '   ').length, 2, 'a whitespace-only query is treated as empty');
}

// ==================== buildDaySummary ====================
{
  const summary = buildDaySummary([
    { domain: 'workout' }, { domain: 'workout' }, { domain: 'meal' }, { domain: 'note' },
  ]);
  assertEq(summary, '2 workouts · 1 meal · 1 note', 'buildDaySummary pluralizes counts above one and keeps singular counts singular');
  assertEq(buildDaySummary([]), '', 'buildDaySummary on an empty day returns an empty string rather than a stray separator');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
