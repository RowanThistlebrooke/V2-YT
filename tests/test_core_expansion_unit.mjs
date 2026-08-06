// Directly evals the REAL CONFIG + normalize()/buildDefaultExercises() source
// straight out of gym.html (same extraction approach as
// test_ab_crunch_unit.mjs) so this tests the exact core_expansion_2026_08
// migration logic that ships, not a reimplementation of it.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function extractBlock(src, marker) {
  const markerIdx = src.indexOf(marker);
  if (markerIdx < 0) throw new Error('marker not found in gym.html: ' + marker);
  const braceIdx = src.indexOf('{', markerIdx);
  let depth = 0;
  for (let i = braceIdx; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(markerIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces extracting: ' + marker);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gymSrc = fs.readFileSync(path.join(__dirname, '..', 'gym.html'), 'utf8');

const configSrc = extractBlock(gymSrc, 'const CONFIG = ') + ';';
const buildDefaultExercisesSrc = extractBlock(gymSrc, 'function buildDefaultExercises() ');
const exerciseLogKeySrc = extractBlock(gymSrc, 'function exerciseLogKey(ex) ');
const normalizeSrc = extractBlock(gymSrc, 'function normalize(s) ');
const configVersionMatch = /const CONFIG_VERSION = (\d+);/.exec(gymSrc);
if (!configVersionMatch) throw new Error('CONFIG_VERSION not found in gym.html');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  configSrc + '\n' +
  'const CONFIG_VERSION = ' + configVersionMatch[1] + ';\n' +
  buildDefaultExercisesSrc + '\n' +
  exerciseLogKeySrc + '\n' +
  normalizeSrc + '\n' +
  'this.__normalize = normalize; this.__CONFIG = CONFIG; this.__CONFIG_VERSION = CONFIG_VERSION; this.__buildDefaultExercises = buildDefaultExercises; this.__exerciseLogKey = exerciseLogKey;',
  sandbox
);
const { __normalize: normalize, __CONFIG: CONFIG, __CONFIG_VERSION: CONFIG_VERSION, __buildDefaultExercises: buildDefaultExercises, __exerciseLogKey: exerciseLogKey } = sandbox;

const NEW_CORE = {
  push: 'Cable woodchopper',
  pull: 'Hanging leg raise',
  legs: 'Weighted decline sit-up',
  upper: 'Russian twist (dumbbell)',
  lower: 'Cable crunch',
};

// ---- Scenario 1: brand-new user (empty state) ----
{
  const s = normalize({});
  Object.keys(NEW_CORE).forEach(day => {
    const matches = s.exercises.filter(e => e.name === NEW_CORE[day] && e.day === day);
    assertEq(matches.length, 1, 'fresh install: exactly one "' + NEW_CORE[day] + '" on ' + day + ' (default seed + patch don\'t double up)');
  });
  assertTrue(s.patchesApplied.indexOf('core_expansion_2026_08') !== -1, 'fresh install: core_expansion patch pre-marked as applied');
  // Every day now carries at least one core movement, not just push/legs/lower.
  const dayIds = CONFIG.days.map(d => d.id);
  dayIds.forEach(day => {
    const isCore = ex => /crunch|sit-up|leg raise|woodchopper|russian twist/i.test(ex.name);
    assertTrue(s.exercises.some(e => e.day === day && isCore(e)), day + ' has at least one core exercise after the expansion');
  });
}

// ---- Scenario 2: existing user, already configVersion current, predates this patch ----
{
  const priorExercises = buildDefaultExercises().filter(e => !Object.values(NEW_CORE).includes(e.name));
  const benchPress = priorExercises.find(e => e.name === 'Barbell bench press');
  const priorState = {
    configVersion: CONFIG_VERSION,
    days: CONFIG.days.slice(),
    exercises: priorExercises,
    logs: { [benchPress.id]: [{ weight: 82.5, reps: 6, ts: 1752600000000 }] },
    gyms: CONFIG.gyms.slice(),
    patchesApplied: ['ab_crunch_machine_2026_07'],
  };
  const s = normalize(JSON.parse(JSON.stringify(priorState)));
  Object.keys(NEW_CORE).forEach(day => {
    const matches = s.exercises.filter(e => e.name === NEW_CORE[day] && e.day === day);
    assertEq(matches.length, 1, 'existing pre-patch user: patch adds exactly one "' + NEW_CORE[day] + '" on ' + day);
  });

  const bench = s.exercises.find(e => e.name === 'Barbell bench press');
  assertTrue(!!bench, 'existing exercises (Barbell bench press) untouched by the patch');
  assertEq(s.logs[exerciseLogKey(bench)], [{ weight: 82.5, reps: 6, ts: 1752600000000 }], 'previously logged history is untouched by an unrelated patch');

  // ---- Scenario 2b: normalize again on the already-patched state -> idempotent ----
  const s2 = normalize(JSON.parse(JSON.stringify(s)));
  Object.keys(NEW_CORE).forEach(day => {
    const matches = s2.exercises.filter(e => e.name === NEW_CORE[day] && e.day === day);
    assertEq(matches.length, 1, 'running normalize() again does not duplicate ' + NEW_CORE[day]);
  });

  // ---- Scenario 2c: user deletes one on purpose -> must not silently come back ----
  const afterDelete = JSON.parse(JSON.stringify(s2));
  afterDelete.exercises = afterDelete.exercises.filter(e => e.name !== 'Hanging leg raise');
  const s3 = normalize(afterDelete);
  const hangingLeg = s3.exercises.filter(e => e.name === 'Hanging leg raise');
  assertEq(hangingLeg.length, 0, 'deleting a patched core exercise on purpose sticks across a subsequent normalize() call');
}

// ---- Scenario 3: fields on the new bodyweight core exercise are correct ----
{
  const s = normalize({});
  const hangingLeg = s.exercises.find(e => e.name === 'Hanging leg raise');
  assertTrue(!!hangingLeg && hangingLeg.bw === true, 'Hanging leg raise is marked bodyweight (bw: true)');
  const woodchopper = s.exercises.find(e => e.name === 'Cable woodchopper');
  assertTrue(!!woodchopper && woodchopper.gym === 'comm', 'Cable woodchopper uses gym:"comm", matching every other default exercise');
}

// ---- Scenario 4: a stale configVersion user goes through the full reset path, still ends up with exactly one of each (not two) ----
{
  const staleState = { configVersion: 1, days: [{ id: 'push', name: 'Push' }], exercises: [{ id: 'old1', name: 'Old thing', gym: 'comm', day: 'push' }], logs: {} };
  const s = normalize(staleState);
  Object.keys(NEW_CORE).forEach(day => {
    const matches = s.exercises.filter(e => e.name === NEW_CORE[day] && e.day === day);
    assertEq(matches.length, 1, 'a full CONFIG_VERSION reset (old stale state) also ends up with exactly one "' + NEW_CORE[day] + '", not two');
  });
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
