// Standalone verification of gym.html's rest-timer algorithm. gym.html has
// no module exports (browser-global IIFE), so this duplicates the exact
// logic from computeRest()/classifyExerciseForRest() to test it in
// isolation, mirroring this repo's established approach for testing
// gym.html/main.html's pure logic without a DOM.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function estimate1RM(w, r) { if (r < 2) return w; return w * (1 + r / 30); }

const REST_COMPOUND_RE = /\b(squat|deadlift|bench|press|row|pull.?up|pull.?down|chin.?up|dip|clean|snatch|lunge|thrust|overhead|rdl|romanian|step.?up|hip thrust)\b/i;
const REST_ISOLATION_RE = /\b(curl|extension|raise|fly|flye|push.?down|kickback|calf|crunch|pec.?deck)\b/i;
function classifyExerciseForRest(name) {
  const n = String(name || '');
  if (REST_COMPOUND_RE.test(n)) return 'compound';
  if (REST_ISOLATION_RE.test(n)) return 'isolation';
  return 'neutral';
}
function computeRest(ex, weight, reps, priorLogs) {
  let base, tierLabel;
  if (reps <= 5) { base = 180; tierLabel = 'Strength range'; }
  else if (reps <= 9) { base = 120; tierLabel = 'Strength-hypertrophy'; }
  else if (reps <= 15) { base = 75; tierLabel = 'Hypertrophy range'; }
  else { base = 45; tierLabel = 'Endurance range'; }

  const cls = classifyExerciseForRest(ex.name);
  if (cls === 'compound') base += 25;
  else if (cls === 'isolation') base -= 15;

  let intensityLabel = '';
  if (!ex.bw && weight > 0 && priorLogs && priorLogs.length) {
    const bestPrior = Math.max.apply(null, priorLogs.map(l => estimate1RM(l.weight, l.reps)));
    const thisEffort = estimate1RM(weight, reps);
    const intensity = bestPrior > 0 ? thisEffort / bestPrior : 1;
    if (intensity >= 0.95) { base += 45; intensityLabel = ' · near your best effort'; }
    else if (intensity >= 0.85) { base += 20; intensityLabel = ' · heavy set'; }
    else if (intensity < 0.6) { base -= 20; intensityLabel = ' · light set'; }
  }

  const seconds = Math.max(30, Math.min(300, Math.round(base / 5) * 5));
  const clsLabel = cls === 'compound' ? ' · compound lift' : (cls === 'isolation' ? ' · isolation move' : '');
  return { seconds: seconds, reason: tierLabel + clsLabel + intensityLabel };
}

// ---- classification ----
assertEq(classifyExerciseForRest('Barbell Back Squat'), 'compound', 'squat classified as compound');
assertEq(classifyExerciseForRest('Deadlift'), 'compound', 'deadlift classified as compound');
assertEq(classifyExerciseForRest('Bench Press'), 'compound', 'bench press classified as compound');
assertEq(classifyExerciseForRest('Lat Pulldown (wide grip)'), 'compound', 'lat pulldown classified as compound');
assertEq(classifyExerciseForRest('Pull-up'), 'compound', 'pull-up (hyphenated) classified as compound');
assertEq(classifyExerciseForRest('Bicep Curl'), 'isolation', 'bicep curl classified as isolation');
assertEq(classifyExerciseForRest('Leg Extension'), 'isolation', 'leg extension classified as isolation');
assertEq(classifyExerciseForRest('Lateral Raise'), 'isolation', 'lateral raise classified as isolation');
assertEq(classifyExerciseForRest('Standing Calf Raise'), 'isolation', 'calf raise classified as isolation');
assertEq(classifyExerciseForRest('Farmer Carry'), 'neutral', 'an unrecognized exercise name is neutral, not misclassified');

// ---- rep-range base tiers (neutral exercise, no prior history so no intensity adjustment) ----
assertEq(computeRest({ name: 'Farmer Carry' }, 100, 5, []).seconds, 180, '5 reps -> strength range base (180s)');
assertEq(computeRest({ name: 'Farmer Carry' }, 100, 8, []).seconds, 120, '8 reps -> strength-hypertrophy base (120s)');
assertEq(computeRest({ name: 'Farmer Carry' }, 100, 12, []).seconds, 75, '12 reps -> hypertrophy base (75s)');
assertEq(computeRest({ name: 'Farmer Carry' }, 100, 20, []).seconds, 45, '20 reps -> endurance base (45s)');
assertTrue(computeRest({ name: 'Farmer Carry' }, 100, 5, []).reason.includes('Strength range'), 'reason string reflects the rep-range tier');

// ---- compound vs isolation adjustment at the same rep count ----
const compoundRest = computeRest({ name: 'Barbell Squat' }, 100, 8, []).seconds;
const isolationRest = computeRest({ name: 'Leg Extension' }, 100, 8, []).seconds;
const neutralRest = computeRest({ name: 'Farmer Carry' }, 100, 8, []).seconds;
assertTrue(compoundRest > neutralRest, 'a compound lift gets MORE rest than a neutral exercise at the same reps');
assertTrue(isolationRest < neutralRest, 'an isolation move gets LESS rest than a neutral exercise at the same reps');
assertTrue(compoundRest > isolationRest, 'compound rest exceeds isolation rest at equal reps');

// ---- intensity relative to this exercise's own history ----
const priorLogs = [{ weight: 100, reps: 8 }]; // e1RM ≈ 126.7
const nearMax = computeRest({ name: 'Farmer Carry' }, 125, 2, priorLogs); // e1RM ≈ 133.3, intensity > 0.95
const baseline = computeRest({ name: 'Farmer Carry' }, 100, 2, []); // no history at all -> no intensity adjustment
assertTrue(nearMax.seconds > baseline.seconds, 'a set near the all-time best effort gets more rest than one with no history to compare against');
assertTrue(nearMax.reason.includes('near your best effort'), 'reason string calls out a near-max effort');

const lightSet = computeRest({ name: 'Farmer Carry' }, 40, 8, priorLogs); // e1RM ≈ 50.7, intensity well under 0.6
assertTrue(lightSet.seconds < computeRest({ name: 'Farmer Carry' }, 100, 8, []).seconds, 'a light set (well under known best) gets LESS rest than the unadjusted base');
assertTrue(lightSet.reason.includes('light set'), 'reason string calls out a light set');

// ---- bodyweight exercises skip the intensity adjustment (no weight tracked) ----
const bwResult = computeRest({ name: 'Pull-up', bw: true }, 0, 8, [{ weight: 0, reps: 8 }]);
assertTrue(!bwResult.reason.includes('effort') && !bwResult.reason.includes('heavy') && !bwResult.reason.includes('light'), 'bodyweight exercises get no intensity-based label (no weight to compare)');
assertTrue(bwResult.seconds > 0, 'bodyweight exercises still get a sensible rest time from reps + compound classification alone');

// ---- bounds: never below 30s, never above 300s (5 min) regardless of stacked adjustments ----
const maxCase = computeRest({ name: 'Deadlift' }, 500, 3, [{ weight: 400, reps: 3 }]); // strength range + compound + near-max, all stacking up
assertTrue(maxCase.seconds <= 300, 'rest time never exceeds the 5-minute cap even when every factor stacks toward "more rest"');
const minCase = computeRest({ name: 'Cable Kickback' }, 5, 25, [{ weight: 50, reps: 25 }]); // endurance + isolation + light, all stacking down
assertTrue(minCase.seconds >= 30, 'rest time never drops below the 30-second floor even when every factor stacks toward "less rest"');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
