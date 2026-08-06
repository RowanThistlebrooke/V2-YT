import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildDailyBrief, getBriefPeriod } from '../daily-brief.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const css = read('command-center.css');
const commandCenter = read('command-center.js');

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

assertEq(getBriefPeriod(new Date(2026, 6, 29, 10).getTime()), 'morning', '10 AM uses the daily briefing state');
assertEq(getBriefPeriod(new Date(2026, 6, 29, 20).getTime()), 'evening', '8 PM uses the evening debrief state');
assertEq(getBriefPeriod(new Date(2026, 6, 29, 2).getTime()), 'evening', 'late night stays in the closing state');

const empty = buildDailyBrief({ todayKey: '2026-07-29', goalsByDate: {} }, new Date(2026, 6, 29, 9).getTime());
assertEq(empty.coverage, { connected: 0, total: 6, confidence: 'Building context' }, 'empty data reports honest source coverage');
assertTrue(empty.title.length > 0 && empty.summary.length > 0, 'empty data still produces a useful brief');
assertEq(empty.items.length, 3, 'empty data offers three setup actions instead of a blank panel');

const morning = buildDailyBrief({
  todayKey: '2026-07-29', goalsByDate: {},
  goals: [{ text: 'Ship proposal' }],
  action: { title: 'Ship proposal', reason: 'Highest leverage task.', href: 'main.html', kind: 'leverage' },
  schedule: [{ title: 'Client call', time: '11:00', isNext: true, href: 'google.html' }],
  sleepNights: { '2026-07-29': { sleepHours: 6.2, sleepQuality: 3 } },
  waterProgress: { done: 1, total: 8, ratio: 0.125 },
  alertCount: 2,
  streak: { days: 4, label: 'Read' },
  trend: { monthly: 100 }, workoutDays: {},
}, new Date(2026, 6, 29, 9).getTime());
assertEq(morning.period, 'morning', 'morning model selects the planning brief');
assertTrue(morning.title.includes('Ship proposal'), 'the morning headline protects the selected action');
assertEq(morning.items.map(item => item.label), ['Next move', 'Recovery', 'Watch'], 'morning brief ranks action, constrained recovery, and alerts first');
assertEq(morning.coverage.confidence, 'High confidence', 'five or more connected systems earn high confidence');

const evening = buildDailyBrief({
  todayKey: '2026-07-29',
  goalsByDate: { '2026-07-30': [{ text: 'Train' }, { text: 'Review budget' }] },
  goals: [{ text: 'A', done: true }, { text: 'B', done: true }],
  schedule: [], sleepNights: {}, alertCount: 0,
  waterProgress: { done: 5, total: 8, ratio: 0.625 }, streak: { days: 0 }, workoutDays: {}, trend: null,
}, new Date(2026, 6, 29, 21).getTime());
assertTrue(evening.title.includes('every objective'), 'a completed day receives a positive closing headline');
assertEq(evening.items.map(item => item.label), ['Day progress', 'Hydration', 'Tomorrow'], 'evening brief prioritizes completion, hydration, and tomorrow setup');
assertTrue(evening.summary.includes('2 objectives'), 'evening summary includes tomorrow’s staged work');

for (const id of ['ccBriefLabel', 'ccBriefPeriod', 'ccBriefConfidence', 'ccBriefTitle', 'ccBriefSummary', 'ccBriefItems']) {
  assertTrue(html.includes('id="' + id + '"'), id + ' is wired into the Command Center');
}
assertTrue(commandCenter.includes("import { buildDailyBrief } from './daily-brief.js'"), 'the Command Center consumes the pure brief module');
assertTrue(commandCenter.includes('model.dailyBrief = buildDailyBrief'), 'the brief refreshes with the existing Command Center model');
assertTrue(css.includes('.cc-brief-items') && css.includes('@media(max-width:480px)'), 'the Daily Brief includes responsive styling');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
