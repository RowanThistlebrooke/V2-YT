// Standalone verification of search.html's indexing/search logic. search.html
// has no module exports (browser-global IIFE), so this duplicates the exact
// normalizer/search functions to test them in isolation, mirroring this
// repo's established approach for testing embedded-HTML pure logic without a
// DOM (see test_rest_timer_logic.mjs, test_notes_mood_chart.mjs).

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

function normalizeNotes(data) {
  const items = (data && data['notes:items']) || [];
  return items.map(n => ({
    type: 'Note', icon: '📝', title: n.title || 'Untitled',
    snippet: (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    ts: n.updatedAt || 0, href: 'notes.html',
    searchText: (n.title || '') + ' ' + (n.body || ''),
  }));
}

function normalizeTodos(data) {
  const out = [];
  ((data && data['recur:defs']) || []).forEach(d => out.push({
    type: 'Recurring', icon: '🔁', title: d.name,
    snippet: d.freq ? ('Repeats ' + d.freq) : '', ts: 0, href: 'main.html', searchText: d.name || '',
  }));
  ((data && data['habits:defs']) || []).forEach(h => out.push({
    type: 'Habit', icon: '✅', title: h.name, snippet: '', ts: 0, href: 'main.html', searchText: h.name || '',
  }));
  Object.keys(data || {}).forEach(k => {
    if (k.indexOf('goals:') !== 0) return;
    const dateKey = k.slice('goals:'.length);
    (data[k] || []).forEach(g => {
      if (!g || !g.text) return;
      out.push({
        type: 'To-do', icon: g.done ? '✔️' : '⬜', title: g.text,
        snippet: dateKey + (g.done ? ' · done' : ''),
        ts: new Date(dateKey).getTime() || 0, href: 'main.html', searchText: g.text,
      });
    });
  });
  return out;
}

function normalizeReading(data) {
  const items = (data && data['reading:items']) || [];
  return items.map(it => ({
    type: 'Reading', icon: it.audiobook ? '🎧' : '📖', title: it.title || 'Untitled',
    snippet: [it.author, it.notes].filter(Boolean).join(' — ').slice(0, 140),
    ts: 0, href: 'reading.html',
    searchText: [it.title, it.author, it.notes].filter(Boolean).join(' '),
  }));
}

function normalizeFinance(data) {
  const out = [];
  ((data && data.purchases) || []).forEach(p => out.push({
    type: 'Purchase', icon: '🧾', title: p.name || '(unnamed)',
    snippet: [p.date, p.category].filter(Boolean).join(' · '),
    ts: p.ts || 0, href: 'finance.html', searchText: [p.name, p.category].filter(Boolean).join(' '),
  }));
  ((data && data.subs) || []).forEach(s => out.push({
    type: 'Subscription', icon: '🔄', title: s.name || '(unnamed)',
    snippet: s.renewal ? ('Renews ' + s.renewal) : '', ts: 0, href: 'finance.html', searchText: s.name || '',
  }));
  ((data && data.wishlist) || []).forEach(w => out.push({
    type: 'Wishlist', icon: '⭐', title: w.name || '(unnamed)', snippet: '',
    ts: w.ts || 0, href: 'finance.html', searchText: w.name || '',
  }));
  ((data && data.incoming_orders) || []).forEach(o => out.push({
    type: 'Order', icon: '📦', title: o.name || '(unnamed)', snippet: '',
    ts: o.ts || 0, href: 'finance.html', searchText: o.name || '',
  }));
  return out;
}

function normalizeBusiness(data) {
  const out = [];
  ((data && data['biz:affiliate:commitments']) || []).forEach(c => out.push({
    type: 'Commitment', icon: '🤝', title: c.label || '(unnamed)', snippet: 'Affiliate',
    ts: 0, href: 'business.html', searchText: c.label || '',
  }));
  ((data && data['biz:editing:clients']) || []).forEach(c => out.push({
    type: 'Client', icon: '👤', title: c.name || '(unnamed)',
    snippet: [c.contact, c.deliverablesDesc].filter(Boolean).join(' — ').slice(0, 140),
    ts: 0, href: 'business.html', searchText: [c.name, c.contact, c.deliverablesDesc].filter(Boolean).join(' '),
  }));
  return out;
}

function buildSearchIndex(rowsByKey) {
  return []
    .concat(normalizeNotes(rowsByKey.notes))
    .concat(normalizeTodos(rowsByKey.goals))
    .concat(normalizeReading(rowsByKey.reading))
    .concat(normalizeFinance(rowsByKey.finance))
    .concat(normalizeBusiness(rowsByKey.business));
}

function searchIndex(index, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return index
    .filter(item => (item.searchText || '').toLowerCase().indexOf(q) !== -1)
    .sort((a, b) => {
      const aTitle = (a.title || '').toLowerCase().indexOf(q) !== -1 ? 1 : 0;
      const bTitle = (b.title || '').toLowerCase().indexOf(q) !== -1 ? 1 : 0;
      if (aTitle !== bTitle) return bTitle - aTitle;
      return (b.ts || 0) - (a.ts || 0);
    })
    .slice(0, 100);
}

// ==================== normalizers ====================
{
  const notes = normalizeNotes({ 'notes:items': [{ id: 'n1', title: 'Grocery run', body: 'milk eggs bread', updatedAt: 100 }] });
  assertEq(notes.length, 1, 'one note produces one search item');
  assertEq(notes[0].type, 'Note', 'notes are tagged with type Note');
  assertTrue(notes[0].searchText.includes('milk'), 'note body is included in searchable text');

  const todos = normalizeTodos({
    'recur:defs': [{ name: 'Gym', freq: 'daily' }],
    'habits:defs': [{ name: 'Read' }],
    'goals:2026-01-01': [{ text: 'Buy milk', done: false }, { text: 'Call bank', done: true }],
  });
  assertEq(todos.length, 4, 'recurring + habit + two goal items all become search items');
  assertTrue(todos.some(t => t.type === 'Recurring' && t.title === 'Gym'), 'a recurring item is included');
  assertTrue(todos.some(t => t.type === 'To-do' && t.title === 'Buy milk'), 'a dated to-do is included');
  assertTrue(normalizeTodos({ 'goals:2026-01-01': [{ done: true }] }).length === 0, 'a goal entry with no text is skipped rather than producing a blank result');

  const reading = normalizeReading({ 'reading:items': [{ title: 'Sapiens', author: 'Harari', audiobook: true }] });
  assertEq(reading[0].icon, '🎧', 'an audiobook gets the headphone icon instead of the book icon');

  const finance = normalizeFinance({
    purchases: [{ name: 'Coffee', category: 'Food', ts: 5 }],
    subs: [{ name: 'Netflix', renewal: '2026-02-01' }],
    wishlist: [{ name: 'Bike' }],
    incoming_orders: [{ name: 'Desk' }],
  });
  assertEq(finance.length, 4, 'all four finance sub-domains contribute items');
  assertTrue(finance.some(f => f.type === 'Subscription' && f.snippet.includes('Renews')), 'a subscription snippet mentions its renewal date');

  const business = normalizeBusiness({
    'biz:affiliate:commitments': [{ id: 'c1', label: 'Post 3x/week' }],
    'biz:editing:clients': [{ name: 'Acme Co', contact: 'jane@acme.com' }],
  });
  assertEq(business.length, 2, 'a commitment and a client both become search items');
}

// ==================== buildSearchIndex + searchIndex ====================
{
  const rowsByKey = {
    notes: { 'notes:items': [{ title: 'Trip planning', body: 'Thinking about Japan in the spring', updatedAt: 200 }] },
    goals: { 'goals:2026-03-01': [{ text: 'Book flights to Japan', done: false }] },
    reading: { 'reading:items': [{ title: 'Musashi', author: 'Yoshikawa' }] },
    finance: { purchases: [{ name: 'JR Rail Pass', ts: 300 }] },
    business: {},
  };
  const index = buildSearchIndex(rowsByKey);
  assertEq(index.length, 4, 'every domain\'s items are merged into one flat index');

  const results = searchIndex(index, 'japan');
  assertEq(results.length, 2, 'a query matches items across different domains (note + to-do)');
  assertTrue(results.every(r => r.searchText.toLowerCase().includes('japan')), 'every returned result actually contains the query');

  const empty = searchIndex(index, '');
  assertEq(empty, [], 'an empty query returns no results rather than the entire index');

  const none = searchIndex(index, 'zzz_no_such_thing');
  assertEq(none, [], 'a query with no matches returns an empty array');

  // Title-match ranking: a title hit should outrank a snippet-only hit.
  const rankIndex = [
    { title: 'Something else', snippet: '', ts: 0, searchText: 'something else mentions coffee in passing' },
    { title: 'Coffee run', snippet: '', ts: 0, searchText: 'coffee run' },
  ];
  const ranked = searchIndex(rankIndex, 'coffee');
  assertEq(ranked[0].title, 'Coffee run', 'a title match ranks above a match that only appears in the snippet/body text');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
