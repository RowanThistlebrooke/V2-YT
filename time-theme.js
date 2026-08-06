// Shared, timezone-aware day/night state. The browser's resolved IANA zone is
// used so every page shifts at the user's local wall-clock time without a new
// preference or storage contract.

export function getZonedHour(now, timeZone) {
  const date = new Date(now == null ? Date.now() : now);
  const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number((parts.find(part => part.type === 'hour') || {}).value);
    return Number.isFinite(hour) ? hour : date.getHours();
  } catch (e) {
    return date.getHours();
  }
}

export function getTimeTheme(now, timeZone) {
  const hour = getZonedHour(now, timeZone);
  const theme = hour >= 6 && hour < 18 ? 'day' : 'night';
  const daypart = hour < 5 ? 'late-night' : hour < 8 ? 'morning' : hour < 18 ? 'day' : hour < 22 ? 'evening' : 'night';
  return { hour, theme, daypart };
}

export function applyTimeTheme(doc, now, timeZone) {
  if (!doc || !doc.documentElement) return null;
  const state = getTimeTheme(now, timeZone);
  doc.documentElement.dataset.timeTheme = state.theme;
  doc.documentElement.dataset.daypart = state.daypart;
  const themeMeta = doc.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', state.theme === 'day' ? '#07131d' : '#03060a');
  return state;
}

function boot() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const paint = () => {
    const state = applyTimeTheme(document, Date.now(), zone);
    window.dispatchEvent(new CustomEvent('time-theme-changed', { detail: state }));
  };
  paint();
  setInterval(paint, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) paint(); });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
