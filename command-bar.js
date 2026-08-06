import { buildSearchIndex, searchIndex } from './search-index.js';

const NAV_ITEMS = [
  { type: 'Navigate', icon: '🏠', title: 'Today', snippet: 'Goals, schedule, and fitness', href: 'hub-today.html', searchText: 'today goals schedule fitness main' },
  { type: 'Navigate', icon: '⚡', title: 'Body', snippet: 'Health, recovery, water, and sleep', href: 'hub-body.html', searchText: 'body health recovery water sleep caffeine gym' },
  { type: 'Navigate', icon: '💰', title: 'Money & Growth', snippet: 'Finance, business, and learning', href: 'hub-money.html', searchText: 'money finance business learning reading' },
  { type: 'Navigate', icon: '🪞', title: 'Reflect', snippet: 'Nova, notes, and reviews', href: 'hub-reflect.html', searchText: 'reflect nova notes review journal' },
  { type: 'Navigate', icon: '🧭', title: 'Insights', snippet: 'Patterns, recovery, and drift', href: 'hub-insights.html', searchText: 'insights patterns recovery drift analytics' },
  { type: 'Navigate', icon: '🕰️', title: 'Life Timeline', snippet: 'Everything you\'ve logged, in one feed', href: 'life-timeline.html', searchText: 'life timeline history feed activity log everything all events' },
  { type: 'Navigate', icon: '🔮', title: 'Prediction Center', snippet: 'Weight, net worth, sleep debt forecasts', href: 'prediction-center.html', searchText: 'prediction center forecast forecasting weight net worth sleep debt burnout adherence trajectory' },
  { type: 'Navigate', icon: '🔗', title: 'Correlation Lab', snippet: 'Compare tracked metrics and time lags', href: 'correlation-lab.html', searchText: 'correlation lab pearson relationship metrics lag sleep caffeine workout mood spending stretching' },
  { type: 'Navigate', icon: '🗓️', title: 'Weekly Schedule', snippet: 'Your Mon–Sat routine, hour by hour', href: 'schedule.html', searchText: 'weekly schedule routine timeline calendar blocks summer university' },
  { type: 'Navigate', icon: '⚙️', title: 'Dashboard settings', snippet: 'Profile, WHOOP, and backup', href: 'index.html#settings', searchText: 'settings profile whoop backup data export' },
];

export function isCommandBarPath(pathname) {
  const clean = String(pathname || '').toLowerCase().split('/').pop();
  return !clean || !clean.includes('.') || clean.endsWith('.html');
}

export function buildRowsByKey(snapshot) {
  const source = snapshot || {};
  const rows = { notes: {}, goals: {}, reading: {}, finance: {}, business: {} };
  Object.keys(source).forEach(key => {
    if (key === 'notes:items') rows.notes[key] = source[key];
    if (key === 'recur:defs' || key === 'habits:defs' || key.indexOf('goals:') === 0) rows.goals[key] = source[key];
    if (key === 'reading:items') rows.reading[key] = source[key];
    if (['purchases', 'subs', 'wishlist', 'incoming_orders'].includes(key)) rows.finance[key] = source[key];
    if (key.indexOf('biz:') === 0) rows.business[key] = source[key];
  });
  return rows;
}

export function buildCommandResults(index, query) {
  const q = String(query || '').trim();
  if (!q) return NAV_ITEMS.slice(0, 6);
  const nav = NAV_ITEMS.filter(item => item.searchText.toLowerCase().includes(q.toLowerCase()));
  return nav.concat(searchIndex(index || [], q)).slice(0, 12);
}

function readStorageSnapshot() {
  const snapshot = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    try { snapshot[key] = JSON.parse(localStorage.getItem(key)); } catch (e) {}
  }
  return snapshot;
}

function boot() {
  if (!isCommandBarPath(window.location.pathname) || document.getElementById('commandBarBg')) return;

  const style = document.createElement('style');
  style.id = 'command-bar-style';
  style.textContent = `
.command-bar-bg{position:fixed;inset:0;z-index:var(--z-command-bar,100);display:none;align-items:flex-start;justify-content:center;padding:12vh 18px 24px;background:rgba(1,5,9,.78);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.command-bar-bg.show{display:flex}.command-bar{width:min(680px,100%);overflow:hidden;border:1px solid var(--hud-line);border-radius:var(--radius-lg,20px);background:rgba(5,15,23,.98);box-shadow:var(--shadow-md),0 0 50px rgba(var(--hud-rgb),.14);animation:commandBarIn .18s ease-out}
@keyframes commandBarIn{from{opacity:0;transform:translateY(-8px) scale(.99)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.command-bar{animation:none}}
.command-bar-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid var(--hud-line-soft)}
.command-bar-icon{color:var(--hud);font-size:18px}.command-bar-input{min-width:0;flex:1;border:0!important;outline:0!important;background:transparent!important;color:var(--text-primary);font:600 16px var(--font);box-shadow:none!important}.command-bar-key{padding:3px 7px;border:1px solid var(--hud-line);border-radius:6px;color:var(--text-tertiary);font:10px var(--font-mono)}
.command-bar-results{max-height:min(56vh,440px);overflow-y:auto;padding:8px}.command-bar-result{display:flex;align-items:center;gap:12px;width:100%;padding:11px 12px;border:1px solid transparent;border-radius:var(--radius-sm,10px);color:inherit;text-align:left;text-decoration:none;background:transparent}.command-bar-result.is-active{background:rgba(var(--hud-rgb),.09);border-color:var(--hud-line)}.command-bar-result-icon{width:24px;text-align:center;font-size:18px}.command-bar-result-body{min-width:0;flex:1}.command-bar-result-title{color:var(--text-primary);font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.command-bar-result-sub{margin-top:2px;color:var(--text-tertiary);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.command-bar-result-type{color:var(--hud);font:9px var(--font-mono);letter-spacing:.08em;text-transform:uppercase}.command-bar-empty{padding:28px 18px;text-align:center;color:var(--text-tertiary);font-size:13px}
.command-bar-fab{position:fixed;z-index:var(--z-topbar,40);top:max(12px,env(safe-area-inset-top));right:14px;width:42px;height:42px;border:1px solid var(--hud-line,rgba(34,211,245,.2));border-radius:12px;background:rgba(3,9,14,.86);color:var(--hud,#22D3F5);font:700 13px var(--font-mono,monospace);box-shadow:var(--shadow-sm,0 4px 12px rgba(0,0,0,.25));cursor:pointer;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
@media(max-width:480px){.command-bar-bg{padding:0;align-items:stretch}.command-bar{width:100%;height:100%;border:0;border-radius:0;padding-top:max(8px,env(safe-area-inset-top))}.command-bar-results{max-height:none;height:calc(100vh - 68px);padding-bottom:env(safe-area-inset-bottom)}}`;
  document.head.appendChild(style);

  if (!document.querySelector('[data-command-open]')) {
    const fallback = document.createElement('button');
    fallback.className = 'command-bar-fab';
    fallback.type = 'button';
    fallback.dataset.commandOpen = 'true';
    fallback.setAttribute('aria-label', 'Open command bar');
    fallback.title = 'Search · ⌘K';
    fallback.textContent = '⌘K';
    document.body.appendChild(fallback);
  }

  const bg = document.createElement('div');
  bg.className = 'command-bar-bg modal-bg';
  bg.id = 'commandBarBg';
  bg.innerHTML = '<section class="command-bar" role="dialog" aria-modal="true" aria-label="Command bar">'
    + '<div class="command-bar-head"><span class="command-bar-icon">⌕</span>'
    + '<input class="command-bar-input" id="commandBarInput" autocomplete="off" placeholder="Search or jump anywhere…" aria-controls="commandBarResults" aria-autocomplete="list">'
    + '<span class="command-bar-key">ESC</span></div>'
    + '<div class="command-bar-results" id="commandBarResults" role="listbox"></div></section>';
  document.body.appendChild(bg);

  const input = document.getElementById('commandBarInput');
  const resultsEl = document.getElementById('commandBarResults');
  let index = [];
  let results = [];
  let activeIndex = 0;
  let previousFocus = null;

  function rebuildIndex() {
    index = buildSearchIndex(buildRowsByKey(readStorageSnapshot()));
  }
  function paint() {
    results = buildCommandResults(index, input.value);
    activeIndex = Math.max(0, Math.min(activeIndex, results.length - 1));
    resultsEl.innerHTML = '';
    if (!results.length) {
      resultsEl.innerHTML = '<div class="command-bar-empty">No matching commands or dashboard items.</div>';
      input.removeAttribute('aria-activedescendant');
      return;
    }
    results.forEach((item, i) => {
      const a = document.createElement('a');
      a.className = 'command-bar-result' + (i === activeIndex ? ' is-active' : '');
      a.id = 'commandBarResult' + i;
      a.href = item.href;
      a.setAttribute('role', 'option');
      a.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
      const icon = document.createElement('span'); icon.className = 'command-bar-result-icon'; icon.textContent = item.icon || '→';
      const body = document.createElement('span'); body.className = 'command-bar-result-body';
      const title = document.createElement('span'); title.className = 'command-bar-result-title'; title.textContent = item.title;
      const sub = document.createElement('span'); sub.className = 'command-bar-result-sub'; sub.textContent = item.snippet || item.type;
      const type = document.createElement('span'); type.className = 'command-bar-result-type'; type.textContent = item.type;
      body.append(title, sub); a.append(icon, body, type); resultsEl.appendChild(a);
    });
    input.setAttribute('aria-activedescendant', 'commandBarResult' + activeIndex);
  }
  function open() {
    previousFocus = document.activeElement;
    rebuildIndex(); activeIndex = 0; input.value = ''; paint();
    bg.classList.add('show'); document.body.classList.add('command-bar-open');
    requestAnimationFrame(() => input.focus());
  }
  function close() {
    bg.classList.remove('show'); document.body.classList.remove('command-bar-open');
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  }
  function activate() {
    const item = results[activeIndex];
    if (item) window.location.href = item.href;
  }

  input.addEventListener('input', () => { activeIndex = 0; paint(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = (activeIndex + 1) % Math.max(1, results.length); paint(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = (activeIndex - 1 + Math.max(1, results.length)) % Math.max(1, results.length); paint(); }
    else if (event.key === 'Enter') { event.preventDefault(); activate(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  bg.addEventListener('click', event => { if (event.target === bg) close(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' && bg.classList.contains('show')) {
      const focusable = [input].concat(Array.from(resultsEl.querySelectorAll('a')));
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); bg.classList.contains('show') ? close() : open(); }
    else if (event.key === 'Escape' && bg.classList.contains('show')) close();
  });
  document.addEventListener('command-bar:open', open);
  document.querySelectorAll('[data-command-open]').forEach(button => button.addEventListener('click', open));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
