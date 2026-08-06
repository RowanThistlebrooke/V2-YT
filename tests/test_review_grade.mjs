// Standalone verification of review.html's period grade — the single letter
// (A+ … F) put on a whole week or month, built from the same per-domain
// stats the recap cards underneath it already show, so the grade can never
// disagree with the numbers next to it.
//
// review.html is a browser-global IIFE with no module exports, so this
// duplicates the pure functions verbatim — same approach as
// test_player_rating.mjs / test_year_review.mjs.

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const GYM_SESSIONS_PER_WEEK = 4;

function letterForScore(s) {
  if (s >= 97) return 'A+'; if (s >= 93) return 'A'; if (s >= 90) return 'A-';
  if (s >= 87) return 'B+'; if (s >= 83) return 'B'; if (s >= 80) return 'B-';
  if (s >= 77) return 'C+'; if (s >= 73) return 'C'; if (s >= 70) return 'C-';
  if (s >= 67) return 'D+'; if (s >= 63) return 'D'; if (s >= 60) return 'D-';
  return 'F';
}
function gradeBlurb(letter) {
  const c = letter.charAt(0);
  if (c === 'A') return 'Exceptional period — this is the standard to hold.';
  if (c === 'B') return 'Strong period. A couple of areas away from an A.';
  if (c === 'C') return 'Middling — the basics happened, the edge didn\'t.';
  if (c === 'D') return 'Slipped. Pick one area below and rebuild from it.';
  return 'Rough period. Reset with the single easiest habit first.';
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// The real function takes `days` and calls the page's stat helpers. Those
// helpers are exercised by their own tests, so this harness injects their
// already-computed results directly — the thing under test here is the
// weighting, exclusion and letter mapping.
function computePeriodGradeFrom(stats, dayCount) {
  const n = dayCount || 1;
  const parts = [];
  const add = (label, ratio, weight) => { if (ratio != null && isFinite(ratio)) parts.push({ label, ratio: clamp01(ratio), weight }); };

  if (stats.peak) add('energy', stats.peak.avg / 100, 15);
  if (stats.habits) add('habits', stats.habits.rate / 100, 20);
  if (stats.todos) add('to-dos', stats.todos.rate / 100, 15);
  if (stats.gym) add('training', stats.gym.sessions / (n * GYM_SESSIONS_PER_WEEK / 7), 20);
  if (stats.supplements) add('supplements', stats.supplements.rate / 100, 10);
  if (stats.water) add('water', stats.water.rate / 100, 10);
  if (stats.business && stats.business.rate != null) add('commitments', stats.business.rate / 100, 15);

  if (!parts.length) return null;
  let sum = 0, wt = 0;
  parts.forEach(p => { sum += p.ratio * p.weight; wt += p.weight; });
  const score = Math.round((sum / wt) * 100);
  return { score, letter: letterForScore(score), parts };
}

// ==================== letter boundaries ====================
{
  assertEq(letterForScore(100), 'A+', 'a perfect period is an A+');
  assertEq(letterForScore(97), 'A+', 'boundaries are inclusive at the bottom edge');
  assertEq(letterForScore(96), 'A', 'one point below the A+ cutoff is an A');
  assertEq(letterForScore(93), 'A', 'the A band starts at 93');
  assertEq(letterForScore(90), 'A-', 'and A- at 90');
  assertEq(letterForScore(89), 'B+', 'dropping below 90 leaves the A band entirely');
  assertEq(letterForScore(80), 'B-', 'B- floors the B band at 80');
  assertEq(letterForScore(70), 'C-', 'C- floors the C band at 70');
  assertEq(letterForScore(60), 'D-', 'D- floors the D band at 60');
  assertEq(letterForScore(59), 'F', 'anything under 60 is an F');
  assertEq(letterForScore(0), 'F', 'a zero period is an F, not a crash');

  // Every score in range must map to something, and the mapping must never
  // improve as the score drops.
  const order = ['F','D-','D','D+','C-','C','C+','B-','B','B+','A-','A','A+'];
  let ok = true, prevIdx = -1;
  for (let s = 0; s <= 100; s++) {
    const idx = order.indexOf(letterForScore(s));
    if (idx < 0 || idx < prevIdx) { ok = false; break; }
    prevIdx = idx;
  }
  assertTrue(ok, 'the letter never gets better as the score gets worse, across the whole 0-100 range');
}

// ==================== weighting + exclusion ====================
{
  assertEq(computePeriodGradeFrom({}, 7), null, 'a period with nothing tracked at all has no grade rather than an F');

  const perfect = computePeriodGradeFrom({
    peak: { avg: 100 }, habits: { rate: 100 }, todos: { rate: 100 },
    gym: { sessions: 4 }, supplements: { rate: 100 }, water: { rate: 100 },
    business: { rate: 100 },
  }, 7);
  assertEq(perfect.score, 100, 'maxing every tracked domain scores 100');
  assertEq(perfect.letter, 'A+', 'and grades A+');

  const zero = computePeriodGradeFrom({
    peak: { avg: 0 }, habits: { rate: 0 }, todos: { rate: 0 },
    gym: { sessions: 0 }, supplements: { rate: 0 }, water: { rate: 0 },
  }, 7);
  assertEq(zero.score, 0, 'a completely blank week across tracked domains scores 0');
  assertEq(zero.letter, 'F', 'and grades F');

  // The fairness rule: untracked domains are excluded, not zeroed.
  const habitsOnly = computePeriodGradeFrom({ habits: { rate: 90 } }, 7);
  assertEq(habitsOnly.score, 90, 'with only habits tracked, the grade reflects habits alone rather than being dragged down by six missing domains');
  assertEq(habitsOnly.letter, 'A-', 'so a strong week at the one thing you track still grades well');

  // Weight check: habits (20) should move the needle more than water (10).
  const strongHabits = computePeriodGradeFrom({ habits: { rate: 100 }, water: { rate: 0 } }, 7);
  const strongWater = computePeriodGradeFrom({ habits: { rate: 0 }, water: { rate: 100 } }, 7);
  assertTrue(strongHabits.score > strongWater.score, 'a heavier-weighted domain (habits) affects the grade more than a lighter one (water)');
  assertEq(strongHabits.score + strongWater.score, 100, 'and the two complementary cases sum to a full 100 between them');
}

// ==================== training normalizes to period length ====================
{
  // 4 sessions in a 7-day week is full marks…
  const week = computePeriodGradeFrom({ gym: { sessions: 4 } }, 7);
  assertEq(week.score, 100, '4 sessions in a week is full marks on training');
  // …but the same 4 sessions across a 28-day month clearly is not.
  const month = computePeriodGradeFrom({ gym: { sessions: 4 } }, 28);
  assertEq(month.score, 25, 'the same 4 sessions spread over a month scores a quarter — the target scales with period length');
  assertEq(computePeriodGradeFrom({ gym: { sessions: 16 } }, 28).score, 100, '16 sessions in a 28-day month is full marks');
  assertEq(computePeriodGradeFrom({ gym: { sessions: 40 } }, 7).score, 100, 'wildly overshooting the training target is capped at 100, never above');
}

// ==================== business only counts when it has a rate ====================
{
  // businessStat returns revenue with a null rate when there are no daily
  // commitments configured — revenue alone isn't a completion percentage,
  // so it must not be folded into the grade as one.
  const noRate = computePeriodGradeFrom({ habits: { rate: 80 }, business: { revenue: 5000, rate: null } }, 7);
  assertEq(noRate.score, 80, 'business revenue with no commitment rate is left out of the grade rather than being invented as a percentage');
  const withRate = computePeriodGradeFrom({ habits: { rate: 80 }, business: { revenue: 5000, rate: 40 } }, 7);
  assertTrue(withRate.score < noRate.score, 'once commitments ARE tracked, missing them genuinely lowers the grade');
}

// ==================== weakest-area callout ====================
{
  const g = computePeriodGradeFrom({
    habits: { rate: 90 }, water: { rate: 20 }, supplements: { rate: 85 },
  }, 7);
  const worst = g.parts.slice().sort((a, b) => a.ratio - b.ratio)[0];
  assertEq(worst.label, 'water', 'the weakest tracked area is identified for the callout under the grade');
  assertEq(Math.round(worst.ratio * 100), 20, 'and reported at its real percentage');
}

// ==================== blurbs ====================
{
  assertTrue(gradeBlurb('A+').length > 0 && gradeBlurb('A+') === gradeBlurb('A-'), 'every grade in a band shares that band\'s blurb');
  assertTrue(gradeBlurb('F') !== gradeBlurb('A'), 'a failing period reads differently than a great one');
  ['A+','A','A-','B+','B','B-','C+','C','C-','D+','D','D-','F'].forEach(l => {
    if (!gradeBlurb(l)) { fail++; console.log('FAIL: no blurb for grade ' + l); }
  });
  pass++; console.log('PASS: every possible letter grade has a blurb');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
