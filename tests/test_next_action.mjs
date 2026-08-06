import { completeRecommendedAction, formatClock, selectRecommendedAction, timeToMinutes } from '../next-action.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

assertEq(timeToMinutes('09:30'), 570, '24-hour time converts to minutes');
assertEq(timeToMinutes('25:00'), null, 'invalid hours are rejected');
assertEq(timeToMinutes('noon'), null, 'non-time values are rejected');
assertEq(formatClock('00:05'), '12:05 AM', 'midnight formats correctly');
assertEq(formatClock('13:15'), '1:15 PM', 'afternoon time formats correctly');

const now = 12 * 60;
const goals = [
  { text: 'Leverage work', leverage: true },
  { text: 'Past appointment', time: '10:00' },
  { text: 'Upcoming call', time: '14:00' },
];
assertEq(selectRecommendedAction(goals, now, {}).title, 'Past appointment', 'an overdue timed item outranks the leverage task');
assertEq(selectRecommendedAction(goals.slice(0, 1), now, { streak: 4 }).kind, 'leverage', 'the leverage task is next when nothing is overdue');
assertTrue(selectRecommendedAction(goals.slice(0, 1), now, { streak: 4 }).reason.includes('4-day'), 'leverage reason explains the active streak');
assertEq(selectRecommendedAction([{ text: 'Later', time: '17:00' }, { text: 'First open' }], now, {}).title, 'Later', 'the next upcoming scheduled task beats an untimed fallback');
assertEq(selectRecommendedAction([{ text: 'Queued', queued: true }, { text: 'Other' }], now, {}).kind, 'queued', 'a queued item beats an ordinary untimed item');
assertEq(selectRecommendedAction([{ text: 'Done', done: true }], now, {}), null, 'all-complete days return no recommendation');
assertEq(selectRecommendedAction([], now, {}), null, 'an empty day returns no recommendation');

const original = [{ text: 'Keep immutable' }, { text: 'Complete me' }];
const completed = completeRecommendedAction(original, 1, 12345);
assertEq(original[1].done, undefined, 'completion does not mutate the input list');
assertEq(completed[1].done, true, 'completion marks the selected item done');
assertEq(completed[1].doneAt, 12345, 'completion records the supplied timestamp');
assertEq(completeRecommendedAction(original, 99, 1), original, 'an invalid index returns an equivalent list');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
