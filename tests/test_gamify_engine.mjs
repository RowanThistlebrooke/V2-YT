// Standalone verification of gamify.js's XP/level/badge logic. gamify.js
// is a browser-global script (window.Gamify) with no module exports, and
// its actual load()/save() go through localStorage — this duplicates the
// pure decision logic verbatim (level curve, badge checks, and the award
// transition itself reworked to take/return a plain state object instead
// of touching localStorage), same DOM-free approach used throughout this
// repo's other browser-only pages.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const XP_RULES = {
  complete_todo: 5,
  mark_habit_done: 8,
  mark_gym_done: 20,
  mark_exercise_done: 5,
  log_workout_set: 2,
  mark_stretch_done: 10,
  log_body_weight: 5,
  log_reading_session: 10,
  log_cardio_session: 15,
};

function xpThreshold(level) { return 50 * level * (level + 1); }
function levelFromXP(xp) {
  let level = 1;
  while (xp >= xpThreshold(level)) level++;
  return level;
}
function xpIntoLevel(xp, level) { return xp - (level > 1 ? xpThreshold(level - 1) : 0); }
function xpNeededForNextLevel(level) { return xpThreshold(level) - (level > 1 ? xpThreshold(level - 1) : 0); }

const BADGES = [
  { id: 'first_step',  label: 'First Step',        check: (s) => s.log.length >= 1 },
  { id: 'century',     label: 'Century',            check: (s) => s.totalXP >= 100 },
  { id: 'half_k',      label: 'Getting Serious',    check: (s) => s.totalXP >= 500 },
  { id: 'grand',       label: 'Grand',              check: (s) => s.totalXP >= 1000 },
  { id: 'gym_10',      label: 'Iron Regular',       check: (s) => (s.counts.mark_gym_done || 0) >= 10 },
  { id: 'gym_50',      label: 'Iron Veteran',       check: (s) => (s.counts.mark_gym_done || 0) >= 50 },
  { id: 'habit_25',    label: 'Creature of Habit',  check: (s) => ((s.counts.complete_todo || 0) + (s.counts.mark_habit_done || 0)) >= 25 },
  { id: 'stretch_20',  label: 'Bendy',              check: (s) => (s.counts.mark_stretch_done || 0) >= 20 },
  { id: 'reader_10',   label: 'Bookworm',           check: (s) => (s.counts.log_reading_session || 0) >= 10 },
  { id: 'level_5',     label: 'Level 5',            check: (s) => levelFromXP(s.totalXP) >= 5 },
  { id: 'level_10',    label: 'Level 10',           check: (s) => levelFromXP(s.totalXP) >= 10 },
];

function freshState() { return { totalXP: 0, counts: {}, log: [], badges: [] }; }
function awardXPToState(s, actionType) {
  const amount = XP_RULES[actionType];
  if (!amount) return null;
  const prevLevel = levelFromXP(s.totalXP);
  s.totalXP = (s.totalXP || 0) + amount;
  s.counts[actionType] = (s.counts[actionType] || 0) + 1;
  s.log.push({ ts: Date.now(), actionType, amount });
  const newLevel = levelFromXP(s.totalXP);
  const newBadges = [];
  BADGES.forEach((b) => {
    if (!s.badges.includes(b.id) && b.check(s)) { s.badges.push(b.id); newBadges.push(b); }
  });
  return { xpGained: amount, totalXP: s.totalXP, level: newLevel, leveledUp: newLevel > prevLevel, newBadges };
}

// ==================== level curve ====================
{
  assertEq(levelFromXP(0), 1, 'starts at level 1 with 0 XP');
  assertEq(levelFromXP(99), 1, 'just under the level-2 threshold is still level 1');
  assertEq(levelFromXP(100), 2, 'exactly 100 XP reaches level 2 (50*1*2=100)');
  assertEq(levelFromXP(299), 2, 'just under the level-3 threshold (300) is still level 2');
  assertEq(levelFromXP(300), 3, 'exactly 300 XP reaches level 3 (50*2*3=300)');
  assertEq(xpThreshold(5), 1500, 'level 5 needs 1,500 cumulative XP (50*5*6)');
  assertEq(xpThreshold(10), 5500, 'level 10 needs 5,500 cumulative XP (50*10*11)');

  assertEq(xpIntoLevel(150, 2), 50, '150 total XP at level 2 is 50 XP into that level (150-100)');
  assertEq(xpIntoLevel(50, 1), 50, 'level 1 has no prior threshold to subtract — XP-into-level equals total XP');
  assertEq(xpNeededForNextLevel(1), 100, 'level 1 needs 100 XP to reach level 2');
  assertEq(xpNeededForNextLevel(2), 200, 'level 2 needs 200 MORE XP to reach level 3 (300-100)');
}

// ==================== awardXPToState: basic accumulation ====================
{
  const s = freshState();
  const r1 = awardXPToState(s, 'complete_todo');
  assertEq(r1.xpGained, 5, 'complete_todo awards 5 XP');
  assertEq(s.totalXP, 5, 'total XP accumulates correctly');
  assertEq(s.counts.complete_todo, 1, 'action counts are tracked per action type');

  const r2 = awardXPToState(s, 'mark_gym_done');
  assertEq(r2.xpGained, 20, 'mark_gym_done awards 20 XP');
  assertEq(s.totalXP, 25, 'total XP accumulates ACROSS different action types');

  const unknown = awardXPToState(s, 'not_a_real_action');
  assertEq(unknown, null, 'an unrecognized action type awards nothing and does not crash');
  assertEq(s.totalXP, 25, 'total XP is unaffected by an unrecognized action');
}

// ==================== leveling up ====================
{
  const s = freshState();
  // Get to 95 XP (just under the level-2 threshold of 100) without gym (avoid badge noise for this check).
  for (let i = 0; i < 19; i++) awardXPToState(s, 'complete_todo'); // 19*5=95
  assertEq(levelFromXP(s.totalXP), 1, 'still level 1 at 95 XP');
  const levelUpResult = awardXPToState(s, 'complete_todo'); // 100
  assertEq(levelUpResult.leveledUp, true, 'the award that crosses the threshold reports leveledUp: true');
  assertEq(levelUpResult.level, 2, 'the new level is correctly reported');

  const noLevelUp = awardXPToState(s, 'complete_todo'); // 105, still level 2
  assertEq(noLevelUp.leveledUp, false, 'a subsequent award that does not cross a new threshold reports leveledUp: false');
}

// ==================== badges ====================
{
  const s = freshState();
  const first = awardXPToState(s, 'complete_todo');
  assertTrue(first.newBadges.some(b => b.id === 'first_step'), 'the very first tracked action unlocks the "First Step" badge');

  const second = awardXPToState(s, 'complete_todo');
  assertTrue(!second.newBadges.some(b => b.id === 'first_step'), 'an already-unlocked badge is never awarded a second time');

  // Century badge at exactly 100 total XP.
  for (let i = 0; i < 18; i++) awardXPToState(s, 'complete_todo'); // now at 20 actions * 5 = 100
  assertEq(s.totalXP, 100, 'sanity: total XP is exactly 100 at this point');
  assertTrue(s.badges.includes('century'), 'the Century badge (100 XP) unlocks automatically once crossed, even without a dedicated check call');

  // Gym-count badge.
  const s2 = freshState();
  for (let i = 0; i < 10; i++) awardXPToState(s2, 'mark_gym_done');
  assertTrue(s2.badges.includes('gym_10'), 'Iron Regular (10 gym days) unlocks at exactly 10 gym-done awards');
  assertTrue(!s2.badges.includes('gym_50'), 'Iron Veteran (50 gym days) does NOT unlock early at only 10');

  // habit_25 counts BOTH complete_todo and mark_habit_done toward the same badge.
  const s3 = freshState();
  for (let i = 0; i < 15; i++) awardXPToState(s3, 'complete_todo');
  for (let i = 0; i < 10; i++) awardXPToState(s3, 'mark_habit_done');
  assertTrue(s3.badges.includes('habit_25'), 'Creature of Habit counts complete_todo and mark_habit_done together toward the same 25-action badge');

  // Multiple badges can unlock from a single award (e.g. crossing both a
  // level threshold and an XP milestone in the same call).
  const s4 = freshState();
  for (let i = 0; i < 4; i++) awardXPToState(s4, 'mark_gym_done'); // 80 XP
  const multiResult = awardXPToState(s4, 'mark_gym_done'); // 100 XP, level 2, AND century, in one call
  assertTrue(multiResult.newBadges.some(b => b.id === 'century'), 'a single award can unlock the Century badge');
  assertTrue(multiResult.leveledUp, 'the SAME award that unlocks a badge can also level up, in one call');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
