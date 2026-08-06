import { buildCommandResults, buildRowsByKey, isCommandBarPath } from '../command-bar.js';
import { buildSearchIndex } from '../search-index.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

for (const path of ['/', '/index.html', '/hub-today.html', '/hub-body.html', '/hub-money.html', '/hub-reflect.html', '/hub-insights.html', '/gym.html', '/finance.html', '/nova-lite.html', '/search.html']) {
  assertTrue(isCommandBarPath(path), path + ' is inside the global Command Bar rollout');
}
assertEq(isCommandBarPath('/api/config.js'), false, 'non-page API files remain outside the Command Bar rollout');

const rows = buildRowsByKey({
  'notes:items': [{ title: 'Project Nova', body: 'Ideas', updatedAt: 3 }],
  'goals:2026-01-02': [{ text: 'Ship Nova', done: false }],
  'habits:defs': [{ name: 'Read' }],
  'reading:items': [{ title: 'Dune' }],
  purchases: [{ name: 'Desk', ts: 2 }],
  'biz:editing:clients': [{ name: 'Acme' }],
  'po_water_v1': { logs: {} },
});
assertEq(Object.keys(rows.notes), ['notes:items'], 'notes are routed into the notes search domain');
assertTrue(rows.goals['goals:2026-01-02'].length === 1, 'dated goals are routed into the goals search domain');
assertTrue(!('po_water_v1' in rows.finance), 'unrelated storage keys are excluded');

const index = buildSearchIndex(rows);
const nova = buildCommandResults(index, 'nova');
const novaData = nova.filter(item => item.type !== 'Navigate');
assertEq(novaData.length, 2, 'one query finds a note and a to-do across domains');
assertTrue(novaData.every(item => item.title.toLowerCase().includes('nova')), 'the cross-domain Nova results are relevant');
assertTrue(nova.some(item => item.href === 'hub-reflect.html'), 'matching navigation commands can appear beside data results');

const blank = buildCommandResults(index, '');
assertEq(blank.length, 6, 'an empty command bar shows six navigation shortcuts');
assertTrue(blank.every(item => item.type === 'Navigate'), 'empty-state shortcuts are navigation commands');
assertTrue(buildCommandResults(index, 'body').some(item => item.href === 'hub-body.html'), 'navigation commands participate in search');
assertEq(buildCommandResults(index, 'zzz-no-match'), [], 'an unmatched query returns no results');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
