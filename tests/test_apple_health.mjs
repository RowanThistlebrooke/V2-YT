import { extractSnapshot, buildNextState } from '../api/apple-health-ingest.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- extractSnapshot ----
assertEq(
  extractSnapshot({ steps: 8000, sleepHours: 7.5, notARealField: 99, weightKg: 'not a number' }),
  { steps: 8000, sleepHours: 7.5 },
  'extractSnapshot keeps only recognized numeric fields, drops unknown keys and non-numbers'
);
assertEq(extractSnapshot({}), {}, 'extractSnapshot on an empty body returns an empty snapshot');
assertEq(extractSnapshot(null), {}, 'extractSnapshot tolerates a null body');

// ---- buildNextState: fresh state (no existing row) ----
{
  const next = buildNextState(null, { steps: 8000 }, '2026-07-18');
  assertEq(next.latest.steps, 8000, 'buildNextState (fresh): latest.steps set correctly');
  assertEq(next.latest.date, '2026-07-18', 'buildNextState (fresh): latest.date set correctly');
  assertTrue(typeof next.latest.receivedAt === 'string', 'buildNextState (fresh): latest.receivedAt is set');
  assertEq(next.history['2026-07-18'], { steps: 8000 }, 'buildNextState (fresh): history entry created for the date');
}

// ---- buildNextState: merging a second field into the SAME day (e.g. steps sent in the morning, sleep sent at night) ----
{
  const existing = { history: { '2026-07-18': { steps: 8000 } } };
  const next = buildNextState(existing, { sleepHours: 7.5 }, '2026-07-18');
  assertEq(next.history['2026-07-18'], { steps: 8000, sleepHours: 7.5 },
    'buildNextState merges a same-day update into the existing entry instead of overwriting sibling fields');
  assertEq(next.latest, { steps: 8000, sleepHours: 7.5, date: '2026-07-18', receivedAt: next.latest.receivedAt },
    'buildNextState: "latest" is the FULL accumulated merge for the day, not just this POST\'s fields — otherwise a steps-only send would make sleep vanish from the card');
}

// ---- buildNextState: overwriting the SAME field on the SAME day (re-send) updates in place ----
{
  const existing = { history: { '2026-07-18': { steps: 8000 } } };
  const next = buildNextState(existing, { steps: 8500 }, '2026-07-18');
  assertEq(next.history['2026-07-18'], { steps: 8500 }, 'buildNextState: re-sending the same field for the same day overwrites the old value');
}

// ---- buildNextState: a different day gets its own separate entry ----
{
  const existing = { history: { '2026-07-17': { steps: 6000 } } };
  const next = buildNextState(existing, { steps: 8000 }, '2026-07-18');
  assertEq(next.history['2026-07-17'], { steps: 6000 }, 'buildNextState: existing days are preserved untouched');
  assertEq(next.history['2026-07-18'], { steps: 8000 }, 'buildNextState: a new day gets its own entry');
}

// ---- buildNextState: pruning to the most recent 60 days ----
{
  const history = {};
  for (let i = 0; i < 65; i++) {
    const d = new Date(2026, 0, 1 + i);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    history[key] = { steps: i };
  }
  const next = buildNextState({ history }, { steps: 9999 }, '2026-03-08');
  const keys = Object.keys(next.history);
  assertTrue(keys.length <= 60, 'buildNextState prunes history to at most 60 days, got ' + keys.length);
  assertTrue(!('2026-01-01' in next.history), 'buildNextState: oldest days are the ones pruned away');
}

// ---- buildNextState: a backfill POST for a PAST date does not clobber "latest" with stale data ----
{
  const existing = { history: { '2026-07-18': { steps: 9000, sleepHours: 7 } } };
  const next = buildNextState(existing, { steps: 4000 }, '2026-07-15'); // late backfill for an earlier day
  assertEq(next.latest.date, '2026-07-18', 'buildNextState: "latest" still points at the most recent day, not the backfilled day');
  assertEq(next.latest.steps, 9000, 'buildNextState: "latest" values come from the most recent day, unaffected by an older backfill');
  assertEq(next.history['2026-07-15'], { steps: 4000 }, 'buildNextState: the backfilled day is still recorded correctly in history');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
