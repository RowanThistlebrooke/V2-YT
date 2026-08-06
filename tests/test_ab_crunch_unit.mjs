// Directly evals the REAL CONFIG + normalize()/buildDefaultExercises() source
// straight out of gym.html (not a reimplementation, and not a stale manual
// snapshot of it either — extracted fresh from the file on every run) inside
// a small VM sandbox, so this tests the exact migration logic that ships,
// without the flakiness of waiting on the app's own incidental saveState()
// calls in a browser.
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

// ---- extract a balanced-brace block starting at the first '{' after `marker` ----
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

// ---- Scenario 1: brand-new user (empty state) ----
{
  const s = normalize({});
  const ab = s.exercises.filter(e => e.name === 'Ab crunch machine');
  assertEq(ab.length, 3, 'fresh install: exactly 3 "Ab crunch machine" entries (default seed + patch don\'t double up)');
  assertEq(ab.map(e => e.day).sort(), ['legs', 'lower', 'push'], 'fresh install: assigned to push/legs/lower');
  assertTrue(s.patchesApplied.indexOf('ab_crunch_machine_2026_07') !== -1, 'fresh install: patch pre-marked as applied');
}

// ---- Scenario 2: existing user, already configVersion 2, predates this patch (no patchesApplied field at all) ----
{
  const priorExercises = buildDefaultExercises().filter(e => e.name !== 'Ab crunch machine');
  const benchPress = priorExercises.find(e => e.name === 'Barbell bench press');
  const priorState = {
    configVersion: CONFIG_VERSION,
    days: CONFIG.days.slice(),
    exercises: priorExercises,
    logs: { [benchPress.id]: [{ weight: 82.5, reps: 6, ts: 1752600000000 }] },
    gyms: CONFIG.gyms.slice(),
    // no patchesApplied field at all -- simulates state saved before this patch existed
  };
  const s = normalize(JSON.parse(JSON.stringify(priorState)));
  const ab = s.exercises.filter(e => e.name === 'Ab crunch machine');
  assertEq(ab.length, 3, 'existing pre-patch user: patch adds exactly 3 entries');
  assertEq(ab.map(e => e.day).sort(), ['legs', 'lower', 'push'], 'existing pre-patch user: assigned to push/legs/lower');

  const bench = s.exercises.find(e => e.name === 'Barbell bench press');
  assertTrue(!!bench, 'existing exercises (Barbell bench press) untouched by the patch');
  // Logs are migrated from the old id key to the new name key (see the
  // name_keyed_logs_2026_08 patch in normalize()), so the history now
  // lives under exerciseLogKey(bench), not the raw exercise id.
  assertEq(s.logs[exerciseLogKey(bench)], [{ weight: 82.5, reps: 6, ts: 1752600000000 }], 'previously logged weight/rep history survives the name-key migration — not orphaned by an id change');

  // ---- Scenario 2b: normalize again on the already-patched state -> idempotent ----
  const s2 = normalize(JSON.parse(JSON.stringify(s)));
  const ab2 = s2.exercises.filter(e => e.name === 'Ab crunch machine');
  assertEq(ab2.length, 3, 'running normalize() again does not duplicate the patch (still exactly 3)');

  // ---- Scenario 2c: user deletes it on purpose -> must not silently come back ----
  const afterDelete = JSON.parse(JSON.stringify(s2));
  afterDelete.exercises = afterDelete.exercises.filter(e => e.name !== 'Ab crunch machine');
  const s3 = normalize(afterDelete);
  const ab3 = s3.exercises.filter(e => e.name === 'Ab crunch machine');
  assertEq(ab3.length, 0, 'deleting the exercise on purpose sticks across a subsequent normalize() call');
}

// ---- Scenario 3: correctly absent from pull/upper (the alternating placement) ----
{
  const s = normalize({});
  const pullHasIt = s.exercises.some(e => e.name === 'Ab crunch machine' && (e.day === 'pull' || e.day === 'upper'));
  assertTrue(!pullHasIt, 'Ab crunch machine correctly absent from pull/upper days');
  const allComm = s.exercises.filter(e => e.name === 'Ab crunch machine').every(e => e.gym === 'comm');
  assertTrue(allComm, 'all 3 entries use gym:"comm", matching every other default exercise');
}

// ---- Scenario 4: an OLD user on a stale configVersion goes through the full reset path, still ends up with exactly 3 (not 6) ----
{
  const staleState = { configVersion: 1, days: [{ id: 'push', name: 'Push' }], exercises: [{ id: 'old1', name: 'Old thing', gym: 'comm', day: 'push' }], logs: {} };
  const s = normalize(staleState);
  const ab = s.exercises.filter(e => e.name === 'Ab crunch machine');
  assertEq(ab.length, 3, 'a full CONFIG_VERSION reset (old stale state) also ends up with exactly 3, not 6');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
