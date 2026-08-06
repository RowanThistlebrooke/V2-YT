// Standalone verification of skills.html's Skill Stack Tracker logic
// (hour-based mastery staging + per-skill session aggregation + streaks +
// weekly goal progress). skills.html has no module exports (browser-global
// IIFE), so this duplicates the exact functions to test them in isolation —
// same approach as this repo's other embedded-HTML pure-logic test files.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertClose(actual, expected, label, eps) {
  eps = eps == null ? 0.01 : eps;
  if (typeof actual === 'number' && Math.abs(actual - expected) <= eps) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected ~', expected, '\n  actual:  ', actual); }
}

const STAGE_THRESHOLDS = [
  { stage: 'novice', minHours: 0, label: 'Novice' },
  { stage: 'beginner', minHours: 10, label: 'Beginner' },
  { stage: 'intermediate', minHours: 50, label: 'Intermediate' },
  { stage: 'advanced', minHours: 200, label: 'Advanced' },
  { stage: 'expert', minHours: 1000, label: 'Expert' },
];

function stageForHours(hours) {
  let result = STAGE_THRESHOLDS[0];
  for (const t of STAGE_THRESHOLDS) {
    if (hours >= t.minHours) result = t;
  }
  return result;
}

function progressToNextStage(hours) {
  const idx = STAGE_THRESHOLDS.findIndex(t => t.stage === stageForHours(hours).stage);
  const next = STAGE_THRESHOLDS[idx + 1];
  if (!next) return null;
  const cur = STAGE_THRESHOLDS[idx];
  return Math.max(0, Math.min(1, (hours - cur.minHours) / (next.minHours - cur.minHours)));
}

function dateKeyFromTs(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function computeSkillStreak(skillId, sessions, nowMs) {
  const days = new Set((sessions || []).filter(s => s.skillId === skillId).map(s => dateKeyFromTs(s.ts)));
  let streak = 0;
  const cursor = new Date(nowMs);
  if (!days.has(dateKeyFromTs(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(dateKeyFromTs(cursor.getTime()))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function hoursInLastNDays(skillId, sessions, n, nowMs) {
  const cutoff = nowMs - n * 86400000;
  return (sessions || [])
    .filter(s => s.skillId === skillId && s.ts >= cutoff)
    .reduce((a, s) => a + (s.minutes || 0), 0) / 60;
}

function buildSkillSummaries(defs, sessions, nowMs) {
  return (defs || []).map(def => {
    const own = (sessions || []).filter(s => s.skillId === def.id);
    const totalMinutes = own.reduce((a, s) => a + (s.minutes || 0), 0);
    const totalHours = totalMinutes / 60;
    const lastPracticedTs = own.length ? Math.max(...own.map(s => s.ts || 0)) : null;
    const streakDays = computeSkillStreak(def.id, sessions, nowMs);
    const weeklyGoalHours = typeof def.weeklyGoalHours === 'number' && def.weeklyGoalHours > 0 ? def.weeklyGoalHours : null;
    const hoursLast7Days = hoursInLastNDays(def.id, sessions, 7, nowMs);
    return {
      id: def.id,
      name: def.name,
      category: def.category || '',
      totalHours,
      sessionCount: own.length,
      lastPracticedTs,
      stage: stageForHours(totalHours),
      progress: progressToNextStage(totalHours),
      streakDays,
      weeklyGoalHours,
      hoursLast7Days,
      weeklyGoalProgress: weeklyGoalHours ? Math.max(0, Math.min(1, hoursLast7Days / weeklyGoalHours)) : null,
    };
  }).sort((a, b) => b.totalHours - a.totalHours);
}

const DAY = 86400000;
const NOW = new Date('2026-07-25T15:00:00').getTime();

// ==================== stageForHours ====================
{
  assertEq(stageForHours(0).stage, 'novice', 'zero hours is Novice');
  assertEq(stageForHours(9.9).stage, 'novice', 'just under the 10h boundary is still Novice');
  assertEq(stageForHours(10).stage, 'beginner', 'exactly 10h is Beginner (boundary is inclusive)');
  assertEq(stageForHours(49).stage, 'beginner', 'just under 50h is still Beginner');
  assertEq(stageForHours(50).stage, 'intermediate', 'exactly 50h is Intermediate');
  assertEq(stageForHours(200).stage, 'advanced', 'exactly 200h is Advanced');
  assertEq(stageForHours(1000).stage, 'expert', 'exactly 1000h is Expert');
  assertEq(stageForHours(5000).stage, 'expert', 'well beyond 1000h is still Expert, not out of range');
}

// ==================== progressToNextStage ====================
{
  assertClose(progressToNextStage(0), 0, 'zero hours is 0% of the way to Beginner');
  assertClose(progressToNextStage(5), 0.5, '5 of 10 hours is 50% of the way to Beginner');
  assertClose(progressToNextStage(30), 0.5, '30 hours is 50% of the way from Beginner(10) to Intermediate(50)');
  assertEq(progressToNextStage(1000), null, 'the top stage (Expert) has no next stage, so progress is null');
  assertEq(progressToNextStage(5000), null, 'well beyond the top stage still returns null, not a value over 1');
}

// ==================== computeSkillStreak ====================
{
  const sessions = [
    { skillId: 's1', ts: NOW }, // today
    { skillId: 's1', ts: NOW - DAY }, // yesterday
    { skillId: 's1', ts: NOW - 2 * DAY }, // day before
    { skillId: 's1', ts: NOW - 4 * DAY }, // gap at -3 days breaks the streak
  ];
  assertEq(computeSkillStreak('s1', sessions, NOW), 3, 'a practiced-today skill counts consecutive days back through the most recent gap');
  assertEq(computeSkillStreak('s2', sessions, NOW), 0, 'a skill with no sessions at all has a 0 streak');

  const yesterdayOnly = [{ skillId: 's3', ts: NOW - DAY }];
  assertEq(computeSkillStreak('s3', yesterdayOnly, NOW), 1, "a skill practiced yesterday but not yet today still counts (today isn't over)");

  const brokenToday = [{ skillId: 's4', ts: NOW - 3 * DAY }];
  assertEq(computeSkillStreak('s4', brokenToday, NOW), 0, 'a skill last practiced 3 days ago has no current streak');
}

// ==================== hoursInLastNDays ====================
{
  const sessions = [
    { skillId: 's1', ts: NOW, minutes: 60 },
    { skillId: 's1', ts: NOW - 6 * DAY, minutes: 30 },
    { skillId: 's1', ts: NOW - 10 * DAY, minutes: 120 }, // outside a 7-day window
  ];
  assertClose(hoursInLastNDays('s1', sessions, 7, NOW), 1.5, 'only sessions within the last 7 days are summed (60+30 min = 1.5h)');
}

// ==================== buildSkillSummaries ====================
{
  const defs = [
    { id: 's1', name: 'Guitar', category: 'Music' },
    { id: 's2', name: 'Spanish', weeklyGoalHours: 5 },
    { id: 's3', name: 'Chess' }, // never practiced
  ];
  const sessions = [
    { skillId: 's1', ts: 1000, minutes: 60 },
    { skillId: 's1', ts: 3000, minutes: 30 }, // most recent for s1
    { skillId: 's2', ts: NOW, minutes: 600 }, // 10 hours total, all within the last 7 days
  ];
  const summaries = buildSkillSummaries(defs, sessions, NOW);

  const guitar = summaries.find(s => s.id === 's1');
  assertClose(guitar.totalHours, 1.5, "Guitar's total hours sum all its sessions' minutes / 60");
  assertEq(guitar.sessionCount, 2, 'Guitar has 2 logged sessions');
  assertEq(guitar.lastPracticedTs, 3000, "Guitar's lastPracticedTs is the MOST RECENT session, not the first");
  assertEq(guitar.stage.stage, 'novice', '1.5 hours is still Novice');
  assertEq(guitar.category, 'Music', "a skill's category is carried through");
  assertEq(guitar.weeklyGoalHours, null, 'a skill with no weeklyGoalHours set has a null goal, not 0');
  assertEq(guitar.weeklyGoalProgress, null, 'with no goal set, weeklyGoalProgress is null rather than a divide-by-zero result');

  const spanish = summaries.find(s => s.id === 's2');
  assertEq(spanish.stage.stage, 'beginner', 'exactly 10 hours crosses into Beginner');
  assertEq(spanish.weeklyGoalHours, 5, "a skill's weekly goal is carried through");
  assertClose(spanish.hoursLast7Days, 10, "Spanish's single session (10h) landed within the last 7 days");
  assertClose(spanish.weeklyGoalProgress, 1, 'hitting/exceeding the weekly goal caps progress at 1 (100%), not over');

  const chess = summaries.find(s => s.id === 's3');
  assertEq(chess.totalHours, 0, 'a skill with zero logged sessions has 0 total hours, not a crash');
  assertEq(chess.sessionCount, 0, 'a never-practiced skill has a session count of 0');
  assertEq(chess.lastPracticedTs, null, 'a never-practiced skill has a null lastPracticedTs, not 0 (0 would look like "just now" in epoch terms)');
  assertEq(chess.category, '', 'a skill with no category defaults to an empty string, not undefined');
  assertEq(chess.streakDays, 0, 'a never-practiced skill has a 0-day streak');

  // Sort order: most total hours first (the hero slot), not most recent —
  // Spanish (10h) beats Guitar (1.5h) beats Chess (0h).
  assertEq(summaries.map(s => s.id), ['s2', 's1', 's3'], 'summaries are sorted by total hours descending, since the top one becomes the hero card');

  assertEq(buildSkillSummaries([], [], NOW), [], 'no skill defs at all returns an empty list, not an error');
}

// A weekly goal partially met produces a progress fraction, not just 0/1.
{
  const defs = [{ id: 's1', name: 'Piano', weeklyGoalHours: 4 }];
  const sessions = [{ skillId: 's1', ts: NOW, minutes: 120 }]; // 2 of 4 goal hours
  const summaries = buildSkillSummaries(defs, sessions, NOW);
  assertClose(summaries[0].weeklyGoalProgress, 0.5, 'logging half the weekly goal hours gives 50% progress');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
