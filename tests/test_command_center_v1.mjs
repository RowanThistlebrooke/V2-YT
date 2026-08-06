import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildAlerts, buildRecentActivity, buildSchedule, computeBestStreak,
  computeBurnoutRisk, computeNetWorthTrend, computeWaterProgress, nextRenewal,
} from '../command-center.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'command-center.css'), 'utf8');
const topbar = readFileSync(path.join(root, 'topbar.js'), 'utf8');
const commandCenter = readFileSync(path.join(root, 'command-center.js'), 'utf8');

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const now = new Date(2026, 6, 28, 19, 0, 0).getTime();
const waterState = {
  unit: 'bottle', bottleMl: 500, weightUnit: 'kg', caffeineMgPerDay: 200,
  profile: { weightKg: 75, activityHrsPerWeek: 5, sex: 'm', age: 25 },
  logs: { '2026-07-28': 2 },
};
const water = computeWaterProgress(waterState, now);
assertEq(water.done, 2, 'water progress reads today\'s existing log');
assertTrue(water.total > water.done, 'water progress calculates an existing-profile target');

const streak = computeBestStreak(
  [{ id: 'read', name: 'Read' }],
  { read: { '2026-07-26': true, '2026-07-27': true, '2026-07-28': true } },
  { '2026-07-27': true }, now,
);
assertEq(streak, { days: 3, label: 'Read' }, 'the longest habit/workout streak wins');

const trend = computeNetWorthTrend([{ t: now - 10 * 86400000, v: 1000 }, { t: now, v: 1100 }], now);
assertTrue(trend.monthly > 300 && trend.monthly < 310, 'net-worth trend projects the existing history slope monthly');

const schedule = buildSchedule(
  [{ text: 'Morning', time: '09:00', done: true }, { text: 'Evening gym', time: '20:00' }],
  { calendarEventsToday: [{ title: 'Dinner', time: '8:30 PM' }] }, now,
);
assertEq(schedule.length, 3, 'schedule merges timed goals and cached Google Calendar events');
assertTrue(schedule.find(item => item.title === 'Evening gym').isNext, 'the next upcoming parseable event receives the now marker');

const renewal = nextRenewal({ renewal: '2026-07-30', period: 'monthly' }, now);
assertEq(renewal.days, 2, 'subscription renewal distance is calculated from calendar-day boundaries');

const burnout = computeBurnoutRisk({
  checkins: [
    ...Array.from({ length: 7 }, (_, i) => ({ dateKey: 'recent-' + i, stress: 5 })),
  ],
  sleepNights: {}, habitDefs: [], habitLog: {}, goalsByDate: {},
}, now);
assertEq(burnout.level, 'Low', 'missing comparable prior history does not fabricate burnout risk');

const alerts = buildAlerts({
  goals: [{ text: 'Missed call', time: '10:00', done: false }, { text: 'Second miss', time: '11:00', done: false }],
  water: waterState,
  subscriptions: [{ name: 'Music', renewal: '2026-07-30', period: 'monthly' }],
  burnout: { level: 'Elevated', signals: ['stress is trending up', 'sleep is trending down'] },
}, now);
assertEq(alerts[0].level, 'critical', 'critical overdue work ranks before warning alerts');
assertTrue(alerts.some(item => item.title.includes('more scheduled item')), 'multiple overdue tasks collapse into one summary instead of flooding the panel');
assertTrue(alerts.some(item => item.title.includes('Hydration')), 'low evening hydration creates a warning');
assertTrue(alerts.some(item => item.title.includes('Music')), 'near subscription renewal creates a warning');
assertTrue(alerts.some(item => item.title.includes('Burnout')), 'elevated burnout creates a warning');

const activity = buildRecentActivity({
  goalsByDate: { '2026-07-28': [{ text: 'Plan', doneAt: 50 }] },
  notes: [{ title: 'Idea', updatedAt: 100 }], reading: [], financeActivity: [], checkins: [],
});
assertEq(activity[0].title, 'Idea', 'recent activity is ordered newest first');
assertEq(activity[1].title, 'Completed Plan', 'completed goals enter the activity feed');

for (const id of ['ccGreeting', 'scoreCard', 'ccAction', 'ccSchedule', 'ccSignals', 'ccAlerts', 'ccActivity', 'focusMode']) {
  assertTrue(html.includes('id="' + id + '"'), id + ' is present in the Command Center markup');
}
assertTrue(html.includes('href="hub-today.html"') && html.includes('href="hub-insights.html"'), 'the existing Browse navigation remains present');
assertTrue(css.includes('@media(max-width:480px)'), 'the Command Center defines a 480px mobile tier');
assertTrue(css.includes('body.focus-mode-open .topbar') && css.includes('body.focus-mode-open .bottombar'), 'Focus Mode hides both shared navigation bars');
assertTrue(topbar.includes('command-bar.js') && topbar.includes('topbarCommand'), 'topbar loads and exposes the Command Bar');
assertTrue(!topbar.includes('isCommandBarPage'), 'Phase 2 removes the Phase 1 Command Bar allowlist');
assertTrue(html.includes("appKey: 'goals'") && html.includes("syncedPrefixes: ['goals:']"), 'the homepage uses the shared goals cloud-sync path');
assertTrue(html.includes("syncedKeys: ['habits:defs', 'habits:log', 'recur:defs', 'leverage_stats_v1']"), 'the homepage declares the exact same goals sync scope as main.html');
assertTrue(!commandCenter.includes('pushGoalList') && !commandCenter.includes('/rest/v1/app_state?key=eq.goals'), 'task completion does not use a competing full-row write path');
assertTrue(!/SCORE_SOURCE_APP_KEYS[^;]*['"]caffeine['"]/.test(html), 'the homepage does not fetch an unused caffeine app row');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
