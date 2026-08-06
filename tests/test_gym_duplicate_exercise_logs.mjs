// Verifies the fix for exercise-log fragmentation: gym.html and
// api/telegram-webhook.js used to key state.logs by a day-template
// exercise's own id, so the same physical exercise repeated across
// multiple days (e.g. an "Ab crunch machine" on Push/Legs/Lower) had a
// separate, fragmented history per day instead of one real progression
// history. gym.html has no module exports (browser-global IIFE), so this
// duplicates the exact functions to test them in isolation, mirroring
// this repo's established approach for testing embedded-HTML pure logic
// without a DOM.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- Duplicated from gym.html ----
function exerciseLogKey(ex) { return 'name:' + String((ex && ex.name) || '').trim().toLowerCase(); }

function uniqueExercisesByLogKey(exercises) {
  const seen = new Set();
  const out = [];
  (exercises || []).forEach(ex => {
    const key = exerciseLogKey(ex);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ex);
  });
  return out;
}

function migrateLogsToNameKeys(s) {
  const merged = {};
  s.exercises.forEach(ex => {
    const oldLogs = s.logs[ex.id];
    if (!oldLogs || !oldLogs.length) return;
    const key = exerciseLogKey(ex);
    merged[key] = (merged[key] || []).concat(oldLogs);
    delete s.logs[ex.id];
  });
  Object.keys(merged).forEach(key => {
    const existing = s.logs[key] || [];
    s.logs[key] = existing.concat(merged[key]).sort((a, b) => new Date(a.date) - new Date(b.date));
  });
  return s;
}

// ---- Tests: exerciseLogKey ----

assertEq(exerciseLogKey({ name: 'Ab Crunch Machine' }), 'name:ab crunch machine', 'the key is lowercased');
assertEq(exerciseLogKey({ name: '  Bench Press  ' }), 'name:bench press', 'the key is trimmed');
assertEq(
  exerciseLogKey({ id: 'ex_1', name: 'Ab crunch machine', day: 'push' }),
  exerciseLogKey({ id: 'ex_2', name: 'Ab crunch machine', day: 'legs' }),
  'two different day-template entries with the same name share the same log key regardless of id/day'
);

// ---- Tests: uniqueExercisesByLogKey ----

{
  const exercises = [
    { id: 'ex_1', name: 'Ab crunch machine', day: 'push' },
    { id: 'ex_2', name: 'Ab crunch machine', day: 'legs' },
    { id: 'ex_3', name: 'Ab crunch machine', day: 'lower' },
    { id: 'ex_4', name: 'Bench Press', day: 'push' },
  ];
  const unique = uniqueExercisesByLogKey(exercises);
  assertEq(unique.length, 2, 'three same-named entries collapse to one representative, plus the distinct one');
  assertEq(unique[0].id, 'ex_1', 'the FIRST occurrence is kept as the representative entry');
  assertEq(unique[1].id, 'ex_4', 'a differently-named entry is kept as its own representative');
}

// ---- Tests: migration merges + chronologically re-sorts fragmented history ----

{
  const s = {
    exercises: [
      { id: 'ex_1', name: 'Ab crunch machine', day: 'push' },
      { id: 'ex_2', name: 'Ab crunch machine', day: 'legs' },
      { id: 'ex_3', name: 'Bench Press', day: 'push' },
    ],
    logs: {
      ex_1: [{ weight: 40, reps: 12, date: '2026-07-01T12:00:00.000Z' }],
      ex_2: [{ weight: 45, reps: 10, date: '2026-06-15T12:00:00.000Z' }],
      ex_3: [{ weight: 135, reps: 8, date: '2026-07-01T12:00:00.000Z' }],
    },
  };
  migrateLogsToNameKeys(s);
  const key = exerciseLogKey({ name: 'Ab crunch machine' });
  assertEq(Object.keys(s.logs).sort(), ['name:ab crunch machine', 'name:bench press'], 'old id-keyed entries are removed, replaced by name keys');
  assertEq(s.logs[key].length, 2, 'logs previously scattered across two day-template ids are merged into one bucket');
  assertEq(s.logs[key][0].weight, 45, 'the earlier (June) set from the "legs" copy sorts first');
  assertEq(s.logs[key][1].weight, 40, 'the later (July) set from the "push" copy sorts second, not lost or duplicated');
}

{
  // Migration merging INTO an already-name-keyed bucket (e.g. re-running
  // after a prior partial migration, or a name key that also happens to
  // collide with a pre-existing id) must not drop existing entries.
  const s = {
    exercises: [{ id: 'ex_1', name: 'Squat', day: 'legs' }],
    logs: {
      ex_1: [{ weight: 225, reps: 5, date: '2026-07-10T12:00:00.000Z' }],
      'name:squat': [{ weight: 220, reps: 5, date: '2026-07-03T12:00:00.000Z' }],
    },
  };
  migrateLogsToNameKeys(s);
  assertEq(s.logs['name:squat'].length, 2, 'a pre-existing name-keyed bucket is merged with, not overwritten by, the migrated id-keyed logs');
  assertEq(s.logs['name:squat'][0].weight, 220, 'chronological order is preserved across the merge');
}

// ---- Tests: exercise deletion preserves shared history ----

function deleteExercise(s, removedId) {
  const removedEx = s.exercises.find(e => e.id === removedId);
  const removedKey = removedEx ? exerciseLogKey(removedEx) : null;
  const hasOtherSameNameEntry = removedEx && s.exercises.some(e => e.id !== removedId && exerciseLogKey(e) === removedKey);
  s.exercises = s.exercises.filter(e => e.id !== removedId);
  if (removedKey && !hasOtherSameNameEntry) delete s.logs[removedKey];
  return { hasOtherSameNameEntry };
}

{
  const key = exerciseLogKey({ name: 'Ab crunch machine' });
  const s = {
    exercises: [
      { id: 'ex_1', name: 'Ab crunch machine', day: 'push' },
      { id: 'ex_2', name: 'Ab crunch machine', day: 'legs' },
    ],
    logs: { [key]: [{ weight: 40, reps: 12, date: '2026-07-01T12:00:00.000Z' }] },
  };
  const { hasOtherSameNameEntry } = deleteExercise(s, 'ex_1');
  assertTrue(hasOtherSameNameEntry, 'deleting one duplicate-named entry detects that another one still exists');
  assertTrue(!!s.logs[key], 'shared log history survives because the "legs" copy still uses it');
  assertEq(s.exercises.length, 1, 'only the deleted day-template entry itself is removed');
}

{
  const key = exerciseLogKey({ name: 'Leg Press' });
  const s = {
    exercises: [{ id: 'ex_1', name: 'Leg Press', day: 'legs' }],
    logs: { [key]: [{ weight: 300, reps: 10, date: '2026-07-01T12:00:00.000Z' }] },
  };
  const { hasOtherSameNameEntry } = deleteExercise(s, 'ex_1');
  assertTrue(!hasOtherSameNameEntry, 'deleting the ONLY entry with this name finds no surviving duplicate');
  assertTrue(!s.logs[key], 'its log history is cleared since nothing else references it anymore');
}

// ---- Tests: api/telegram-webhook.js's execLogWorkoutSet write path uses the same name key ----
// (duplicated insertion logic from execLogWorkoutSet, since that file has
// no exports either — this checks it lands in the SAME bucket gym.html
// would read/write for the same exercise.)

function insertLoggedSet(state, ex, weight, reps, when) {
  state.logs = state.logs || {};
  const logKey = exerciseLogKey(ex);
  const arr = state.logs[logKey] || [];
  const entry = { weight, reps, date: when.toISOString() };
  let insertAt = arr.length;
  for (let i = 0; i < arr.length; i++) {
    if (new Date(arr[i].date).getTime() > when.getTime()) { insertAt = i; break; }
  }
  arr.splice(insertAt, 0, entry);
  state.logs[logKey] = arr;
  return state;
}

{
  const state = { logs: {} };
  const pushCopy = { id: 'ex_1', name: 'Ab Crunch Machine', day: 'push' };
  const legsCopy = { id: 'ex_2', name: 'ab crunch machine', day: 'legs' };
  insertLoggedSet(state, pushCopy, 40, 12, new Date('2026-07-01T12:00:00.000Z'));
  insertLoggedSet(state, legsCopy, 45, 10, new Date('2026-07-05T12:00:00.000Z'));
  const key = exerciseLogKey(pushCopy);
  assertEq(Object.keys(state.logs), [key], 'a Telegram-logged set for one day-template copy lands in the same shared bucket as another day\'s copy of the same exercise');
  assertEq(state.logs[key].length, 2, 'both sets accumulate in the shared bucket rather than fragmenting by day');
}

{
  const state = { logs: {} };
  const ex = { id: 'ex_1', name: 'Squat', day: 'legs' };
  insertLoggedSet(state, ex, 225, 5, new Date('2026-07-10T12:00:00.000Z'));
  insertLoggedSet(state, ex, 200, 5, new Date('2026-07-03T12:00:00.000Z')); // backdated
  const key = exerciseLogKey(ex);
  assertEq(state.logs[key][0].weight, 200, 'a backdated Telegram-logged set is inserted in chronological order, not just appended');
  assertEq(state.logs[key][1].weight, 225, 'the later set stays after the backdated one');
}

// ---- Tests: renaming an exercise migrates its history (duplicated from
// the exModalSave handler's rename-migration logic) ----

function renameExercise(state, id, newName) {
  const ex = state.exercises.find(e => e.id === id);
  const oldKey = exerciseLogKey(ex);
  const hadOtherSameNameEntry = state.exercises.some(e => e.id !== id && exerciseLogKey(e) === oldKey);
  ex.name = newName;
  const newKey = exerciseLogKey(ex);
  if (newKey !== oldKey && !hadOtherSameNameEntry && state.logs[oldKey] && state.logs[oldKey].length) {
    const existing = state.logs[newKey] || [];
    state.logs[newKey] = existing.concat(state.logs[oldKey]).sort((a, b) => new Date(a.date) - new Date(b.date));
    delete state.logs[oldKey];
  }
  return { hadOtherSameNameEntry };
}

{
  // The common case: renaming the ONLY exercise with this name carries its
  // full history over to the new name, rather than silently orphaning it.
  const oldKey = exerciseLogKey({ name: 'Leg Press' });
  const state = {
    exercises: [{ id: 'ex_1', name: 'Leg Press', day: 'legs' }],
    logs: { [oldKey]: [{ weight: 300, reps: 10, date: '2026-07-01T12:00:00.000Z' }] },
  };
  renameExercise(state, 'ex_1', 'Leg Press Machine');
  const newKey = exerciseLogKey({ name: 'Leg Press Machine' });
  assertTrue(!state.logs[oldKey], 'the old name\'s log bucket no longer exists after a rename');
  assertEq(state.logs[newKey], [{ weight: 300, reps: 10, date: '2026-07-01T12:00:00.000Z' }], 'the full history moved intact to the new name\'s bucket');
}

{
  // Renaming into a name that ALREADY has its own history (e.g. renaming
  // "Bench Press" into "Barbell bench press", an existing exercise) merges
  // rather than overwrites.
  const oldKey = exerciseLogKey({ name: 'Bench Press' });
  const newKey = exerciseLogKey({ name: 'Barbell bench press' });
  const state = {
    exercises: [{ id: 'ex_1', name: 'Bench Press', day: 'push' }],
    logs: {
      [oldKey]: [{ weight: 135, reps: 8, date: '2026-07-05T12:00:00.000Z' }],
      [newKey]: [{ weight: 130, reps: 8, date: '2026-07-01T12:00:00.000Z' }],
    },
  };
  renameExercise(state, 'ex_1', 'Barbell bench press');
  assertEq(state.logs[newKey].length, 2, 'renaming into an existing name merges histories rather than overwriting the destination');
  assertEq(state.logs[newKey][0].weight, 130, 'the merged history stays chronologically sorted');
  assertEq(state.logs[newKey][1].weight, 135, 'the more recent set stays after the older one post-merge');
}

{
  // Renaming ONE of several duplicate-named entries: the shared history
  // stays with the other day-template copies still using the old name —
  // it must not be duplicated into the renamed entry, since that would
  // fork one person's real history into two places.
  const key = exerciseLogKey({ name: 'Ab crunch machine' });
  const state = {
    exercises: [
      { id: 'ex_1', name: 'Ab crunch machine', day: 'push' },
      { id: 'ex_2', name: 'Ab crunch machine', day: 'legs' },
    ],
    logs: { [key]: [{ weight: 40, reps: 12, date: '2026-07-01T12:00:00.000Z' }] },
  };
  const { hadOtherSameNameEntry } = renameExercise(state, 'ex_1', 'Ab crunch machine v2');
  assertTrue(hadOtherSameNameEntry, 'detects that another day-template entry still used the old name');
  assertTrue(!!state.logs[key], 'the shared history under the old name survives for the still-named entry');
  const newKey = exerciseLogKey({ name: 'Ab crunch machine v2' });
  assertTrue(!state.logs[newKey], 'the renamed entry does NOT inherit a copy of history it never logged itself');
}

{
  // A rename that only changes casing/whitespace maps to the SAME
  // exerciseLogKey, so there is nothing to migrate — must be a no-op, not
  // an unnecessary merge-with-itself.
  const key = exerciseLogKey({ name: 'Squat' });
  const state = {
    exercises: [{ id: 'ex_1', name: 'Squat', day: 'legs' }],
    logs: { [key]: [{ weight: 225, reps: 5, date: '2026-07-01T12:00:00.000Z' }] },
  };
  renameExercise(state, 'ex_1', '  SQUAT  ');
  assertEq(Object.keys(state.logs), [key], 'a casing/whitespace-only rename keeps using the same normalized key');
  assertEq(state.logs[key].length, 1, 'no duplication occurs from a same-key rename');
}

// ---- Tests: capitalization variants share history end-to-end ----

{
  const state = { logs: {} };
  const variantA = { id: 'ex_1', name: 'BENCH PRESS', day: 'push' };
  const variantB = { id: 'ex_2', name: 'bench press', day: 'upper' };
  const variantC = { id: 'ex_3', name: 'Bench Press', day: 'pull' };
  insertLoggedSet(state, variantA, 100, 10, new Date('2026-07-01T12:00:00.000Z'));
  insertLoggedSet(state, variantB, 105, 8, new Date('2026-07-03T12:00:00.000Z'));
  insertLoggedSet(state, variantC, 110, 6, new Date('2026-07-05T12:00:00.000Z'));
  assertEq(Object.keys(state.logs).length, 1, 'three differently-capitalized spellings of the same exercise all share one log bucket');
  assertEq(state.logs[exerciseLogKey(variantA)].length, 3, 'all three logged sets landed in that one shared bucket');
}

// ---- Tests: empty histories don't crash the aggregate helpers ----

{
  const exercises = [
    { id: 'ex_1', name: 'Untouched Exercise', day: 'push' },
    { id: 'ex_2', name: 'Also Untouched', day: 'legs' },
  ];
  assertEq(uniqueExercisesByLogKey(exercises).length, 2, 'exercises with no logged history at all still pass through uniqueness filtering cleanly');
  const state = { exercises, logs: {} };
  const removed = deleteExercise(state, 'ex_1');
  assertTrue(!removed.hasOtherSameNameEntry, 'deleting a never-logged exercise reports no surviving duplicate');
  assertEq(state.logs, {}, 'deleting a never-logged exercise leaves an already-empty logs object untouched, no crash');
}

console.log('\n--- ' + pass + ' passed, ' + fail + ' failed ---\n');
if (fail > 0) process.exit(1);
