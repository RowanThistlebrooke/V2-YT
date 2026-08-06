// Shared, side-effect-free search normalization used by search.html today
// and the Phase 1 command bar later. Keep this module free of DOM, network,
// and storage access so every consumer searches the exact same index shape.

export function normalizeNotes(data) {
  const items = (data && data['notes:items']) || [];
  return items.map(n => ({
    type: 'Note', icon: '📝', title: n.title || 'Untitled',
    snippet: (n.body || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    ts: n.updatedAt || 0, href: 'notes.html',
    searchText: (n.title || '') + ' ' + (n.body || ''),
  }));
}

export function normalizeTodos(data) {
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

export function normalizeReading(data) {
  const items = (data && data['reading:items']) || [];
  return items.map(it => ({
    type: 'Reading', icon: it.audiobook ? '🎧' : '📖', title: it.title || 'Untitled',
    snippet: [it.author, it.notes].filter(Boolean).join(' — ').slice(0, 140),
    ts: 0, href: 'reading.html',
    searchText: [it.title, it.author, it.notes].filter(Boolean).join(' '),
  }));
}

export function normalizeFinance(data) {
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

export function normalizeBusiness(data) {
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

export function buildSearchIndex(rowsByKey) {
  return []
    .concat(normalizeNotes(rowsByKey.notes))
    .concat(normalizeTodos(rowsByKey.goals))
    .concat(normalizeReading(rowsByKey.reading))
    .concat(normalizeFinance(rowsByKey.finance))
    .concat(normalizeBusiness(rowsByKey.business));
}

// Title matches rank above snippet-only matches; recency breaks ties
// within a rank. Items with no timestamp sort after dated entries.
export function searchIndex(index, query) {
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
