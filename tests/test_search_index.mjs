import {
  normalizeNotes,
  normalizeTodos,
  normalizeReading,
  normalizeFinance,
  normalizeBusiness,
  buildSearchIndex,
  searchIndex,
} from '../search-index.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(condition, label) {
  if (condition) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}

// ==================== direct normalizer coverage ====================
{
  const notes = normalizeNotes({
    'notes:items': [{ title: '', body: 'Line one\n  line two', updatedAt: 42 }],
  });
  assertEq(notes[0].title, 'Untitled', 'notes without a title keep the established Untitled fallback');
  assertEq(notes[0].snippet, 'Line one line two', 'note snippets collapse whitespace exactly once');
  assertEq(notes[0].href, 'notes.html', 'note results retain their destination');

  const todos = normalizeTodos({
    'recur:defs': [{ name: 'Stretch', freq: 'daily' }],
    'habits:defs': [{ name: 'Journal' }],
    'goals:2026-07-28': [{ text: 'Ship Phase 0', done: false }, null, { done: true }],
  });
  assertEq(todos.length, 3, 'recurring items, habits, and valid dated goals are indexed');
  assertTrue(todos.every(item => item.href === 'main.html'), 'every to-do-domain result retains the Main destination');

  const reading = normalizeReading({
    'reading:items': [{ title: 'Deep Work', author: 'Cal Newport', notes: 'Focus systems', audiobook: false }],
  });
  assertEq(reading[0].icon, '📖', 'page-tracked books use the book icon');
  assertTrue(reading[0].searchText.includes('Focus systems'), 'reading notes remain searchable after extraction');

  const finance = normalizeFinance({
    purchases: [{ name: 'Coffee', category: 'Food', ts: 20 }],
    subs: [{ name: 'Music', renewal: '2026-08-01' }],
    wishlist: [{ name: 'Camera', ts: 10 }],
    incoming_orders: [{ name: 'Keyboard', ts: 15 }],
  });
  assertEq(finance.map(item => item.type), ['Purchase', 'Subscription', 'Wishlist', 'Order'], 'finance domains keep their stable result ordering');
  assertTrue(finance.every(item => item.href === 'finance.html'), 'every finance result retains the Finance destination');

  const business = normalizeBusiness({
    'biz:affiliate:commitments': [{ label: 'Publish three videos' }],
    'biz:editing:clients': [{ name: 'Acme', contact: 'Jordan', deliverablesDesc: 'Weekly edit' }],
  });
  assertEq(business.length, 2, 'affiliate commitments and editing clients are both indexed');
  assertTrue(business[1].searchText.includes('Weekly edit'), 'client deliverable details remain searchable');
}

// ==================== shared index behavior ====================
{
  const rows = {
    notes: { 'notes:items': [{ title: 'Coffee research', body: 'beans', updatedAt: 10 }] },
    goals: { 'goals:2026-07-28': [{ text: 'Buy coffee filters', done: false }] },
    reading: { 'reading:items': [{ title: 'Tea handbook', notes: 'mentions coffee' }] },
    finance: { purchases: [{ name: 'Coffee grinder', category: 'Home', ts: 30 }] },
    business: {},
  };
  const index = buildSearchIndex(rows);
  assertEq(index.length, 4, 'buildSearchIndex combines every configured domain');

  const results = searchIndex(index, 'coffee');
  assertEq(results.map(item => item.title), ['Buy coffee filters', 'Coffee grinder', 'Coffee research', 'Tea handbook'], 'title matches rank first and recency breaks title-match ties');
  assertEq(searchIndex(index, '   '), [], 'blank queries never dump the full private index');
  assertEq(searchIndex(index, 'no-match'), [], 'unmatched queries return an empty list');

  const many = Array.from({ length: 125 }, (_, i) => ({ title: 'Item ' + i, searchText: 'shared', ts: i }));
  assertEq(searchIndex(many, 'shared').length, 100, 'results retain the established 100-item safety cap');
  assertEq(searchIndex(many, 'shared')[0].title, 'Item 124', 'equally ranked results remain newest-first');
}

// ==================== empty-state compatibility ====================
{
  assertEq(normalizeNotes(null), [], 'notes tolerate an empty row');
  assertEq(normalizeTodos(null), [], 'to-dos tolerate an empty row');
  assertEq(normalizeReading(null), [], 'reading tolerates an empty row');
  assertEq(normalizeFinance(null), [], 'finance tolerates an empty row');
  assertEq(normalizeBusiness(null), [], 'business tolerates an empty row');
  assertEq(buildSearchIndex({}), [], 'a brand-new dashboard builds an empty index without crashing');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
