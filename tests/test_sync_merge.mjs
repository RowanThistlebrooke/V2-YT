// sync.js is a browser-global IIFE (no module exports), loaded via
// <script src="sync.js"> — same convention as the other browser-only pages
// in this repo, so mergeForPush's logic is mirrored here verbatim rather
// than imported. Keep this in sync with the real implementation in sync.js
// if that function ever changes.
function mergeForPush(local, remote, lastKnown, matches) {
  const merged = Object.assign({}, remote);
  for (const k of Object.keys(local)) {
    if (JSON.stringify(local[k]) !== JSON.stringify(lastKnown[k])) merged[k] = local[k];
  }
  for (const k of Object.keys(lastKnown)) {
    if (!matches(k) || k in local) continue;
    if (JSON.stringify(remote[k]) === JSON.stringify(lastKnown[k])) delete merged[k];
  }
  return merged;
}

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}

const scopeMatches = (k) => k === 'po_water_v1' || k === 'stack:items';

// ==================== mergeForPush (pure logic) ====================
{
  // The actual bug: the Telegram assistant logs water directly on the
  // server between this browser's last pull and its next push. This
  // browser never touched po_water_v1 locally (its copy still equals what
  // it last knew was synced), so the merge must keep the server's newer
  // value instead of stomping it with the stale local copy.
  const lastKnown = { po_water_v1: { logs: { '2026-07-28': 2 } }, 'stack:items': [] };
  const remote = { po_water_v1: { logs: { '2026-07-28': 3 } }, 'stack:items': [] }; // bot bumped it to 3
  const local = { po_water_v1: { logs: { '2026-07-28': 2 } }, 'stack:items': [] }; // browser's stale copy
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    { po_water_v1: { logs: { '2026-07-28': 3 } }, 'stack:items': [] },
    'a key untouched locally keeps the server\'s newer value instead of being overwritten by a stale local copy'
  );
}

{
  // A real local edit (differs from lastKnown) still wins and reaches the server.
  const lastKnown = { po_water_v1: { logs: { '2026-07-28': 2 } } };
  const remote = { po_water_v1: { logs: { '2026-07-28': 2 } } };
  const local = { po_water_v1: { logs: { '2026-07-28': 3 } } }; // user tapped +1 in the app
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    { po_water_v1: { logs: { '2026-07-28': 3 } } },
    'a key actually changed locally overwrites the server as normal'
  );
}

{
  // Both changed the same key independently since the last sync — local wins
  // (last-write-wins for genuine concurrent edits, same as before this fix).
  const lastKnown = { po_water_v1: { logs: { '2026-07-28': 2 } } };
  const remote = { po_water_v1: { logs: { '2026-07-28': 5 } } }; // bot bumped it
  const local = { po_water_v1: { logs: { '2026-07-28': 3 } } }; // user also tapped +1 locally
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    { po_water_v1: { logs: { '2026-07-28': 3 } } },
    'a key genuinely changed on both sides since the last sync falls back to last-write-wins'
  );
}

{
  // Deleting a key locally (e.g. clearing all logs) propagates when the
  // server side hasn't moved that key on without us.
  const lastKnown = { 'stack:items': [{ id: 1 }] };
  const remote = { 'stack:items': [{ id: 1 }] };
  const local = {}; // key removed from localStorage
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    {},
    'an in-scope key deleted locally, unchanged remotely, propagates as a deletion'
  );
}

{
  // Someone else changed a key we're about to delete locally — their newer
  // value wins instead of our deletion silently destroying it.
  const lastKnown = { 'stack:items': [{ id: 1 }] };
  const remote = { 'stack:items': [{ id: 1 }, { id: 2 }] }; // added elsewhere since our last sync
  const local = {}; // we think it should be deleted, based on our stale copy
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    { 'stack:items': [{ id: 1 }, { id: 2 }] },
    'a key changed remotely since our last sync is not clobbered by a stale local deletion'
  );
}

{
  // First-ever push (no prior sync baseline) sends everything local as-is.
  const lastKnown = {};
  const remote = {};
  const local = { po_water_v1: { logs: { '2026-07-28': 1 } } };
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    { po_water_v1: { logs: { '2026-07-28': 1 } } },
    'the first push ever (empty lastKnown) sends all local keys untouched'
  );
}

{
  // A field outside this page's sync scope, present only on the server
  // (written by a sibling page sharing the same row), is left untouched.
  const lastKnown = { po_water_v1: { logs: {} }, 'other:unrelated:field': 'x' };
  const remote = { po_water_v1: { logs: {} }, 'other:unrelated:field': 'x' };
  const local = { po_water_v1: { logs: {} } }; // this page's own collect() never sees the unrelated field
  assertEq(
    mergeForPush(local, remote, lastKnown, scopeMatches),
    { po_water_v1: { logs: {} }, 'other:unrelated:field': 'x' },
    'a field outside this page\'s own sync scope is preserved untouched, not deleted'
  );
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
if (fail > 0) process.exit(1);
