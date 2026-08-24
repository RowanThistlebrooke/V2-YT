// =============================================================
// Persistent dashboard top bar.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// It self-injects HTML + CSS, reads progress from the same
// localStorage keys the dashboard's tabs already use, and a
// water "+1" button writes to localStorage and (if configured)
// pushes a merged update to the Supabase health row so the
// new bottle appears on every device within ~1 second.
// =============================================================
(function () {
  'use strict';

  // -------- Supabase config (same project as the rest of the dashboard) --------
  // For your audience's standalone, replace these with placeholders
  // and have them paste their own values, just like the other pages.
  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // Credentials come exclusively from /api/config → window.DASH_* at load time.

  // -------- CSS --------
  // Themes are applied by setting data-theme="X" on <html>.
  // Each theme overrides the shared CSS custom properties used by every
  // page, so a single attribute flip changes the whole visual language.
  // Default (no data-theme attribute) = the original dark/mint design.
  const css = `
[data-theme="midnight"] {
  --theme-bg: #08080f; --theme-bg2: #0c0c18;
  --theme-accent: #A78BFA; --theme-accent2: #818CF8;
  --theme-success: #A78BFA; --theme-warning: #FBBF24; --theme-danger: #F87171;
}
[data-theme="warm"] {
  --theme-bg: #0a0806; --theme-bg2: #120e09;
  --theme-accent: #F59E0B; --theme-accent2: #FCD34D;
  --theme-success: #D97706; --theme-warning: #F59E0B; --theme-danger: #EF4444;
}
[data-theme="minimal"] {
  --theme-bg: #000000; --theme-bg2: #080808;
  --theme-accent: #FAFAFA; --theme-accent2: #C0C0C0;
  --theme-success: #E0E0E0; --theme-warning: #A0A0A0; --theme-danger: #808080;
}
[data-theme="midnight"] body, [data-theme="warm"] body, [data-theme="minimal"] body {
  background: var(--theme-bg);
}
[data-theme] .topbar, [data-theme] .bottombar {
  background: var(--theme-bg, #0a0a0b);
}
[data-theme] .gm-card, [data-theme] .tile, [data-theme] .coach-panel,
[data-theme] .modal, [data-theme] .po-modal {
  background: color-mix(in srgb, var(--theme-bg2, rgba(255,255,255,0.04)) 90%, transparent);
}
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; justify-content: flex-end; align-items: center;
  gap: 8px;
  padding: max(10px, env(safe-area-inset-top)) 14px 8px;
  background: #0a0a0b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.topbar-water-wrap {
  display: flex; align-items: stretch;
}
.topbar-water-pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 14px;
  background: rgba(125, 211, 252, 0.08);
  border: 1px solid rgba(125, 211, 252, 0.16);
  border-right: none;
  border-radius: 12px 0 0 12px;
  text-decoration: none;
  color: #FAFAFA;
  -webkit-tap-highlight-color: transparent;
}
.topbar-water-pill .topbar-pill-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #7DD3FC; flex-shrink: 0;
}
.topbar-water-pill.warn .topbar-pill-dot { background: #fbbf24; }
.topbar-water-pill.miss .topbar-pill-dot {
  background: #ff8a8a;
  animation: topbar-miss-pulse 1.6s ease-in-out infinite;
}
@keyframes topbar-miss-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.5); }
  50%      { box-shadow: 0 0 0 5px rgba(239, 68, 68, 0); }
}
.topbar-pill-count {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px; font-weight: 700;
  color: #FAFAFA;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.topbar-water-add {
  width: 44px;
  border: 1px solid rgba(125, 211, 252, 0.16);
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.28), rgba(110, 231, 183, 0.28));
  color: #FFFFFF;
  font-family: inherit; font-size: 20px; font-weight: 700; line-height: 1;
  cursor: pointer;
  border-radius: 0 12px 12px 0;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, transform 0.10s;
}
.topbar-water-add:active { transform: scale(0.94); }
.topbar-water-add.flash {
  background: linear-gradient(180deg, rgba(125, 211, 252, 0.7), rgba(110, 231, 183, 0.7));
}
.topbar-finance-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.topbar-finance-btn:hover { background: rgba(255, 255, 255, 0.08); }
.topbar-finance-icon {
  font-size: 20px; line-height: 1;
  filter: grayscale(100%) brightness(1.4);
  opacity: 0.85;
}

/* Bottom tab bar — Instagram-style */
.bottombar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; justify-content: space-around; align-items: stretch;
  padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  background: #0a0a0b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.bottombar-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px;
  padding: 6px 0 4px;
  text-decoration: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.04em;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.15s;
}
.bottombar-tab-icon {
  font-size: 24px; line-height: 1;
  filter: grayscale(100%) brightness(1.2);
  opacity: 0.55;
  transition: opacity 0.15s, filter 0.15s, transform 0.10s;
}
.bottombar-tab.active {
  color: #FAFAFA;
}
.bottombar-tab.active .bottombar-tab-icon {
  filter: grayscale(100%) brightness(1.6);
  opacity: 1;
}
.bottombar-tab:active .bottombar-tab-icon { transform: scale(0.92); }

/* ===== Your Coach — JARVIS-styled floating widget, present on every
   page. Same mint/cyan HUD palette as the boot animation, so it reads
   as the same "system" everywhere rather than a generic chat bubble. ===== */
.coach-fab {
  position: fixed; z-index: 70;
  right: 14px; bottom: calc(82px + env(safe-area-inset-bottom));
  width: 54px; height: 54px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: radial-gradient(circle at 35% 30%, #0c1411 0%, #050706 70%);
  border: 1.5px solid rgba(110,231,183,0.45);
  box-shadow: 0 0 16px rgba(110,231,183,0.35), 0 6px 18px rgba(0,0,0,0.5);
  cursor: pointer; -webkit-tap-highlight-color: transparent;
  animation: coachPulse 2.6s ease-in-out infinite;
}
.coach-fab svg { width: 24px; height: 24px; color: #6EE7B7; filter: drop-shadow(0 0 4px rgba(110,231,183,0.7)); }
.coach-fab.has-insight::after {
  content: ''; position: absolute; top: 2px; right: 2px; width: 10px; height: 10px;
  border-radius: 50%; background: #67E8F9; box-shadow: 0 0 6px rgba(103,232,249,0.9);
}
@keyframes coachPulse { 0%,100% { box-shadow: 0 0 16px rgba(110,231,183,0.35), 0 6px 18px rgba(0,0,0,0.5); } 50% { box-shadow: 0 0 26px rgba(110,231,183,0.6), 0 6px 18px rgba(0,0,0,0.5); } }

.coach-panel-bg { position: fixed; inset: 0; z-index: 80; display: none; align-items: flex-end; justify-content: center; background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); }
.coach-panel-bg.show { display: flex; }
.coach-panel {
  width: 100%; max-width: 480px; max-height: 78vh; min-height: 360px;
  display: flex; flex-direction: column;
  background: #06090a; border: 1px solid rgba(110,231,183,0.3);
  border-bottom: none; border-radius: 20px 20px 0 0;
  box-shadow: 0 -10px 50px rgba(0,0,0,0.6), 0 0 30px rgba(110,231,183,0.08);
  padding: 14px 16px max(14px, env(safe-area-inset-bottom));
}
.coach-head { display: flex; align-items: center; gap: 10px; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid rgba(110,231,183,0.15); }
.coach-ring { width: 26px; height: 26px; flex-shrink: 0; }
.coach-ring circle { fill: none; stroke: #6EE7B7; }
.coach-ring .cr-outer { stroke-width: 1.3; stroke-dasharray: 3 5; opacity: 0.6; animation: coachSpin 6s linear infinite; transform-origin: 13px 13px; }
.coach-ring .cr-inner { stroke-width: 1.6; stroke: #67E8F9; opacity: 0.85; animation: coachSpin 3.5s linear infinite reverse; transform-origin: 13px 13px; }
@keyframes coachSpin { to { transform: rotate(360deg); } }
.coach-title { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #eafff6; text-shadow: 0 0 8px rgba(110,231,183,0.6); }
.coach-sub { font-family: ui-monospace, monospace; font-size: 9.5px; letter-spacing: 0.08em; color: rgba(110,231,183,0.5); margin-top: 1px; }
.coach-head-spacer { flex: 1; }
.coach-voice-toggle, .coach-close { width: 30px; height: 30px; border-radius: 9px; border: 1px solid rgba(110,231,183,0.25); background: rgba(110,231,183,0.06); color: #8eeebf; font-size: 14px; cursor: pointer; flex-shrink: 0; }
.coach-voice-toggle.on { background: rgba(110,231,183,0.22); color: #eafff6; }
.coach-feed { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px 2px 10px; }
.coach-msg { max-width: 88%; font-size: 13.5px; line-height: 1.5; }
.coach-msg.user { align-self: flex-end; color: #d8d6cf; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 9px 13px; }
.coach-msg.coach { align-self: flex-start; color: #c9f7e3; background: rgba(110,231,183,0.05); border: 1px solid rgba(110,231,183,0.25); border-left: 3px solid #6EE7B7; border-radius: 0 12px 12px 12px; padding: 9px 13px; white-space: pre-wrap; }
.coach-msg.coach.proactive { border-left-color: #67E8F9; border-color: rgba(103,232,249,0.3); }
.coach-input-row { display: flex; gap: 8px; margin-top: 8px; }
.coach-input { flex: 1; min-width: 0; background: rgba(255,255,255,0.03); border: 1px solid rgba(110,231,183,0.2); color: #eafff6; border-radius: 11px; padding: 11px 13px; font-family: inherit; font-size: 13.5px; outline: none; }
.coach-input:focus { border-color: rgba(110,231,183,0.5); }
.coach-input::placeholder { color: rgba(255,255,255,0.3); }
.coach-send, .coach-mic, .coach-attach { width: 42px; flex-shrink: 0; border: 0; border-radius: 11px; cursor: pointer; font-size: 16px; }
.coach-send { background: #6EE7B7; color: #04140d; }
.coach-mic { background: rgba(110,231,183,0.08); color: #8eeebf; border: 1px solid rgba(110,231,183,0.2); }
.coach-mic.listening { background: #67E8F9; color: #04140d; }
.coach-attach { background: rgba(110,231,183,0.08); color: #8eeebf; border: 1px solid rgba(110,231,183,0.2); }
.coach-attach.has-file { background: rgba(110,231,183,0.22); color: #6EE7B7; border-color: rgba(110,231,183,0.5); }
.coach-attach-preview { display: none; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 4px; background: rgba(110,231,183,0.07); border: 1px solid rgba(110,231,183,0.2); border-radius: 9px; font-size: 12px; color: #8eeebf; }
.coach-attach-preview.show { display: flex; }
.coach-attach-preview img { width: 36px; height: 36px; object-fit: cover; border-radius: 5px; flex-shrink: 0; }
.coach-attach-preview .attach-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coach-attach-remove { background: none; border: none; color: rgba(110,231,183,0.5); cursor: pointer; font-size: 14px; flex-shrink: 0; padding: 0 2px; }
.coach-dots { display: inline-flex; gap: 4px; } .coach-dots i { width: 5px; height: 5px; border-radius: 50%; background: #6EE7B7; opacity: 0.4; animation: coachDot 1.2s ease-in-out infinite; }
.coach-dots i:nth-child(2) { animation-delay: 0.2s; } .coach-dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes coachDot { 0%,100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 1; transform: scale(1.3); } }

/* Push page content above the fixed bottom bar */
body.has-bottombar {
  padding-bottom: calc(72px + env(safe-area-inset-bottom)) !important;
}

@media (max-width: 480px) {
  .topbar { padding-left: 10px; padding-right: 10px; gap: 6px; }
  .topbar-water-pill { padding: 8px 11px; gap: 6px; }
  .topbar-pill-count { font-size: 12px; }
  .topbar-water-add { width: 40px; font-size: 18px; }
  .topbar-finance-btn { width: 40px; height: 38px; }
  .topbar-finance-icon { font-size: 18px; }
  .bottombar-tab-icon { font-size: 22px; }
  .bottombar-tab { font-size: 10px; }
}

/* === Global mobile lockdown ===
   1) Hide the right-side scrollbar on phones (iOS uses overlay scrollbars anyway).
   2) Stop iOS auto-text-size-adjust.
   3) touch-action: pan-y prevents pinch-zoom while still allowing vertical scroll.
   4) overscroll-behavior on every common modal class stops scroll chaining —
      scrolling inside a settings popup won't drag the page behind it.
   5) When body has .topbar-modal-open, the page can't scroll at all (locked).
*/
html, body {
  -webkit-text-size-adjust: 100%;
}
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer {
  overscroll-behavior: contain;
}
body.topbar-modal-open {
  overflow: hidden;
  touch-action: none;
}
/* On phones, blow the modals up to full screen and let them be the only
   scrolling element. Way less "is this scrolling the page or the modal?"
   confusion. */
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal {
    width: 100% !important;
    max-width: 100% !important;
    max-height: 100vh !important;
    height: 100vh !important;
    border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
  }
}
/* ── Gmail confirmation card ── */
.gmail-confirm-card { background: rgba(110,231,183,0.04); border: 1px solid rgba(110,231,183,0.3); border-radius: 10px; padding: 12px; margin-top: 4px; }
.gmail-confirm-label { font-size: 11px; color: rgba(110,231,183,0.65); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
.gmail-confirm-field { font-size: 12.5px; color: #b8e8d0; margin-bottom: 4px; }
.gmail-confirm-field b { color: rgba(110,231,183,0.55); }
.gmail-confirm-body { font-size: 12.5px; color: #c9f7e3; background: rgba(0,0,0,0.25); border-radius: 6px; padding: 8px 10px; margin: 8px 0; white-space: pre-wrap; max-height: 150px; overflow-y: auto; }
.gmail-confirm-actions { display: flex; gap: 8px; margin-top: 10px; }
.gmail-btn { padding: 7px 15px; border-radius: 7px; border: 1px solid; cursor: pointer; font-size: 12px; font-weight: 600; transition: background 0.15s; }
.gmail-send { background: rgba(110,231,183,0.15); color: #6EE7B7; border-color: rgba(110,231,183,0.4); }
.gmail-send:hover:not(:disabled) { background: rgba(110,231,183,0.3); }
.gmail-cancel { background: rgba(255,255,255,0.04); color: rgba(200,200,200,0.6); border-color: rgba(255,255,255,0.12); }
.gmail-cancel:hover:not(:disabled) { background: rgba(255,255,255,0.1); }
.gmail-btn:disabled { opacity: 0.4; cursor: default; }
`;

  // -------- HTML --------
  const topbarHtml = `
<header class="topbar" id="topbar" role="navigation" aria-label="Quick actions">
  <div class="topbar-water-wrap">
    <a href="health.html#water" class="topbar-water-pill" id="topbarWater" aria-label="Water progress">
      <span class="topbar-pill-dot"></span>
      <span class="topbar-pill-count" id="topbarWaterCount">0/0</span>
    </a>
    <button class="topbar-water-add" id="topbarWaterAdd" aria-label="Log one drink" type="button">+</button>
  </div>
  <a href="finance.html" class="topbar-finance-btn" id="topbarFinance" aria-label="Finance">
    <span class="topbar-finance-icon">📊</span>
  </a>
</header>
`;

  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="index.html" class="bottombar-tab" data-page="main">
    <span class="bottombar-tab-icon">🏠</span>
    <span>Main</span>
  </a>
  <a href="health.html" class="bottombar-tab" data-page="health">
    <span class="bottombar-tab-icon">💊</span>
    <span>Health</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="fitness">
    <span class="bottombar-tab-icon">💪</span>
    <span>Fitness</span>
  </a>
</nav>
`;

  const coachHtml = `
<button class="coach-fab" id="coachFab" aria-label="Open Your Coach" type="button">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>
</button>
<div class="coach-panel-bg" id="coachPanelBg">
  <div class="coach-panel">
    <div class="coach-head">
      <svg class="coach-ring" viewBox="0 0 26 26"><circle class="cr-outer" cx="13" cy="13" r="11"/><circle class="cr-inner" cx="13" cy="13" r="7"/></svg>
      <div>
        <div class="coach-title">Your Coach</div>
        <div class="coach-sub" id="coachSub">SYSTEMS NOMINAL</div>
      </div>
      <div class="coach-head-spacer"></div>
      <button class="coach-voice-toggle" id="coachRescan" type="button" title="Redo status sweep" aria-label="Redo status sweep">↻</button>
      <button class="coach-voice-toggle" id="coachVoiceToggle" type="button" title="Read replies aloud" aria-label="Toggle spoken replies">🔊</button>
      <button class="coach-close" id="coachClose" type="button" aria-label="Close">✕</button>
    </div>
    <div class="coach-feed" id="coachFeed"></div>
    <div class="coach-attach-preview" id="coachAttachPreview">
      <img id="coachAttachThumb" src="" alt="" style="display:none">
      <span class="attach-name" id="coachAttachName"></span>
      <button class="coach-attach-remove" id="coachAttachRemove" type="button" title="Remove attachment">✕</button>
    </div>
    <div class="coach-input-row">
      <input class="coach-input" id="coachInput" placeholder="Ask your coach…" autocomplete="off">
      <input type="file" id="coachFileInput" accept="image/*,.txt,.md,.markdown,.json,.csv,.py,.js,.ts,.html,.css" style="display:none">
      <button class="coach-attach" id="coachAttach" type="button" title="Attach file (image, markdown, text…)" aria-label="Attach file">📎</button>
      <button class="coach-mic" id="coachMic" type="button" aria-label="Speak">🎙️</button>
      <button class="coach-send" id="coachSend" type="button" aria-label="Send">→</button>
    </div>
  </div>
</div>
`;

  // Pages where we suppress the app chrome: finance has its own internal
  // 4-tab bottom nav and self-contained back button.
  function isFinancePage() {
    const p = (window.location.pathname || '').toLowerCase();
    return p.endsWith('/finance.html') || p.endsWith('finance.html');
  }
  // When the water tracker is iframed inside health.html, the embedded
  // page shouldn't render its own chrome again.
  function isEmbedded() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function shouldShowChrome() {
    return !isFinancePage() && !isEmbedded();
  }
  function currentPageKey() {
    const p = (window.location.pathname || '').toLowerCase();
    if (p.endsWith('health.html')) return 'health';
    if (p.endsWith('gym.html')) return 'fitness';
    return 'main'; // index.html, /, or anything else falls back to main
  }

  function injectStyleAndHTML() {
    if (document.getElementById('topbar') || document.getElementById('bottombar')) return;
    if (!shouldShowChrome()) return;

    const style = document.createElement('style');
    style.id = 'topbar-style';
    style.textContent = css;
    document.head.appendChild(style);

    const topWrap = document.createElement('div');
    topWrap.innerHTML = topbarHtml.trim();
    document.body.insertBefore(topWrap.firstChild, document.body.firstChild);

    const bottomWrap = document.createElement('div');
    bottomWrap.innerHTML = bottombarHtml.trim();
    document.body.appendChild(bottomWrap.firstChild);

    // Highlight the active bottom tab.
    const active = currentPageKey();
    document.querySelectorAll('.bottombar-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-page') === active);
    });

    // Reserve room above the fixed bottom bar so page content can scroll
    // past it without being hidden.
    document.body.classList.add('has-bottombar');

    // Coach widget has two top-level fixed elements (fab + panel) — just
    // append the container itself rather than unwrapping; both children
    // are position:fixed so the wrapper has zero visual footprint.
    const coachWrap = document.createElement('div');
    coachWrap.innerHTML = coachHtml.trim();
    document.body.appendChild(coachWrap);
    try { initCoach(); } catch (e) { console.error('[coach]', e); }
  }

  // ===== DATE HELPERS =====
  function activeDateKey() {
    const now = new Date();
    const d = new Date(now);
    if (now.getHours() < 6) d.setDate(d.getDate() - 1);
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }
  function calendarDateKey() {
    const d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  // ===== PROGRESS READERS (read-only, called on every render) =====
  function getGoalsProgress() {
    const key = 'goals:' + activeDateKey();
    let goals = [];
    try { goals = JSON.parse(localStorage.getItem(key)) || []; } catch (e) {}
    const total = Array.isArray(goals) ? goals.length : 0;
    const done = total ? goals.filter(g => g && g.done).length : 0;
    return { done, total };
  }

  function getStackProgress() {
    let items = [];
    try { items = JSON.parse(localStorage.getItem('stack:items')) || []; } catch (e) {}
    let taken = {};
    try { taken = JSON.parse(localStorage.getItem('stack:taken:' + activeDateKey())) || {}; } catch (e) {}
    const total = Array.isArray(items) ? items.length : 0;
    const done = total ? items.filter(i => i && taken[i.id]).length : 0;
    return { done, total };
  }

  function getWaterProgress() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!state) return { done: 0, total: 0 };
    const todayKey = calendarDateKey();
    const done = (state.logs || {})[todayKey] || 0;
    const p = state.profile || { weightKg: 75 };
    // p.weightKg is always stored as true kilograms regardless of the
    // display unit (see po-water.html's computeTargetMl) — no further
    // conversion needed here.
    const base = (p.weightKg || 0) * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caffeine = Math.max(0, (state.caffeineMgPerDay || 0) - 200) * 1.5;
    const subs = (state.substances || []).reduce((s, x) => {
      const dose = (x && x.dose != null ? x.dose : (x && x.defaultDose)) || 0;
      return s + Math.max(0, dose * ((x && x.mlPerUnit) || 0));
    }, 0);
    let adjust = 0;
    if (p.sex === 'm') adjust += 200;
    if ((p.age || 0) >= 50) adjust += 100;
    const totalMl = base + exercise + caffeine + subs + adjust;
    let unitVol;
    if (state.unit === 'glass') unitVol = state.glassMl || 250;
    else if (state.unit === 'oz') unitVol = 30;
    else if (state.unit === 'ml') unitVol = 1;
    else unitVol = state.bottleMl || 500;
    const total = Math.max(1, Math.ceil(totalMl / unitVol));
    return { done, total };
  }

  function classifyStatus(done, total) {
    if (total === 0) return 'idle';
    if (done >= total) return 'good';
    if (done >= total * 0.5) return 'warn';
    // Past 6pm and still under half → flag as missed
    const h = new Date().getHours();
    if (h >= 18 && done < total * 0.5) return 'miss';
    return 'warn';
  }

  function setPillStatus(pillEl, status) {
    pillEl.classList.remove('good', 'warn', 'miss');
    if (status === 'warn' || status === 'miss') pillEl.classList.add(status);
  }

  function render() {
    const waterEl = document.getElementById('topbarWater');
    if (!waterEl) return; // not injected yet

    const w = getWaterProgress();
    const countEl = document.getElementById('topbarWaterCount');
    if (countEl) countEl.textContent = w.total ? w.done + '/' + w.total : '0/0';
    setPillStatus(waterEl, classifyStatus(w.done, w.total));
  }

  // ===== WATER TRACKER (+1 button, works from any page) =====
  function defaultWaterState() {
    return {
      unit: 'bottle', bottleMl: 500, glassMl: 250, weightUnit: 'lb',
      profile: { weightKg: 75, age: 25, sex: 'm', activityHrsPerWeek: 5 },
      caffeineMgPerDay: 200, substances: [], logs: {}
    };
  }

  async function pushWaterMergedToSupabase(localWater) {
    // Only do this when we're NOT on the health page — health page
    // has its own sync that already detects the localStorage change.
    if (window.location.pathname.endsWith('/health.html') ||
        window.location.pathname.endsWith('health.html')) return;

    const secret = window.DASH_APP_SECRET || '';
    try {
      // po_water_v1 lives under appKey:'profile' (not 'health') — see Invariant §8
      const readRes = await fetch('/api/db?key=profile', {
        headers: { 'X-App-Secret': secret },
      });
      const readJson = readRes.ok ? await readRes.json() : {};
      const current = (readJson && readJson.data) || {};
      const merged = Object.assign({}, current, { po_water_v1: localWater });
      await fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
        body: JSON.stringify({ key: 'profile', data: merged }),
      });
    } catch (e) { /* offline — local change will sync next time user visits health */ }
  }

  function addWater() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!state || typeof state !== 'object') state = defaultWaterState();
    state.logs = state.logs || {};
    const k = calendarDateKey();
    state.logs[k] = (state.logs[k] || 0) + 1;
    try { localStorage.setItem('po_water_v1', JSON.stringify(state)); } catch (e) { console.warn('[Topbar] localStorage.setItem po_water_v1 failed', e); }
    render();

    const btn = document.getElementById('topbarWaterAdd');
    if (btn) {
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 220);
    }

    pushWaterMergedToSupabase(state);
  }

  // ===== MOBILE GESTURE LOCKDOWN (modal fullscreen) =====
  // Belt-and-suspenders zoom prevention — iOS Safari sometimes ignores
  // user-scalable=no, so we also kill the gesture events directly.
  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    // Also kill the iOS double-tap-to-zoom on any tap.
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }

  // Watch every known modal-bg / overlay class — when any one of them
  // gets `.show` or `.is-open`, lock the body scroll. When the last
  // one closes, unlock.
  function startModalLock() {
    const MODAL_SELECTORS = [
      '.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam'
    ];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) {
            return true;
          }
        }
      }
      return false;
    }
    function sync() {
      document.body.classList.toggle('topbar-modal-open', anyOpen());
    }
    const observer = new MutationObserver(sync);
    // Observe class changes anywhere in body — modal toggles are rare so
    // a global subtree observer is cheap.
    observer.observe(document.body, {
      attributes: true, attributeFilter: ['class'], subtree: true
    });
    sync();
  }

  // ===== API USAGE / SPEND LOGGING =====
  // Every AI proxy endpoint (ai-chat, vision-tool, nova, scan) returns its
  // Anthropic token usage as response headers (see api/_lib/security.js
  // setUsageHeaders) without changing their JSON body contracts. Pages
  // that call those endpoints read those headers and call this to log an
  // entry here, so spend can be estimated in one place (the index.html
  // settings panel) regardless of which module made the call.
  const USAGE_KEY = 'apiusage:log';
  // source is a short module name ('gym', 'finance', 'nova', 'marathon', 'coach', etc.)
  // so the settings page can break down spending by module.
  window.logApiUsage = function (inputTokens, outputTokens, model, source) {
    if (!inputTokens && !outputTokens) return;
    let log = [];
    try { log = JSON.parse(localStorage.getItem(USAGE_KEY)) || []; } catch (e) {}
    log.push({ ts: Date.now(), model: model || 'claude-opus-4-8', inputTokens: Number(inputTokens) || 0, outputTokens: Number(outputTokens) || 0, source: source || 'other' });
    if (log.length > 500) log = log.slice(log.length - 500);
    try {
      localStorage.setItem(USAGE_KEY, JSON.stringify(log));
    } catch (e) {
      // Storage full — keep only the last 100 entries and retry once
      try { localStorage.setItem(USAGE_KEY, JSON.stringify(log.slice(-100))); } catch (_) {}
    }

    // Budget alert: check if this month's spend has crossed the user's
    // configured threshold. Runs after every logged call so the warning
    // appears immediately rather than only when the settings page is open.
    try {
      const budgetStr = localStorage.getItem('settings:monthly_budget');
      if (budgetStr) {
        const budget = parseFloat(budgetStr);
        if (budget > 0) {
          const PRICES = { 'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-opus-4-8': { in: 5, out: 25 } };
          const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
          const monthSpend = log.filter(e => e.ts >= monthStart.getTime()).reduce((s, e) => {
            const p = PRICES[e.model] || PRICES['claude-opus-4-8'];
            return s + (e.inputTokens / 1e6) * p.in + (e.outputTokens / 1e6) * p.out;
          }, 0);
          const pct = monthSpend / budget;
          if (pct >= 1 && localStorage.getItem('settings:budget_alerted') !== 'over') {
            localStorage.setItem('settings:budget_alerted', 'over');
            showBudgetAlert('Budget exceeded — monthly AI spend ($' + monthSpend.toFixed(2) + ') is over your $' + budget.toFixed(2) + ' limit. Conservation mode recommended.', 'danger');
          } else if (pct >= 0.8 && localStorage.getItem('settings:budget_alerted') !== '80' && localStorage.getItem('settings:budget_alerted') !== 'over') {
            localStorage.setItem('settings:budget_alerted', '80');
            showBudgetAlert('Heads-up — AI spend this month is $' + monthSpend.toFixed(2) + ' (80%+ of your $' + budget.toFixed(2) + ' budget).', 'warn');
          }
        }
      }
    } catch (e) { console.warn('[Topbar] Budget alert calculation failed', e); }
  };
  if (window.initCloudSync) {
    window.initCloudSync({ appKey: 'apiusage', syncedKeys: [USAGE_KEY] });
  }

  // Shows a dismissible top-of-page banner for budget warnings.
  // Uses a simple fixed bar rather than a modal so it doesn't interrupt work.
  function showBudgetAlert(msg, level) {
    if (document.getElementById('budget-alert-bar')) return; // one at a time
    const bar = document.createElement('div');
    bar.id = 'budget-alert-bar';
    const bg = level === 'danger' ? 'rgba(255,107,107,0.15)' : 'rgba(242,192,99,0.12)';
    const border = level === 'danger' ? 'rgba(255,107,107,0.4)' : 'rgba(242,192,99,0.35)';
    const color = level === 'danger' ? '#FF8A8A' : '#F2C063';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:' + bg + ';border-bottom:1px solid ' + border + ';font-family:-apple-system,sans-serif;font-size:12.5px;font-weight:600;color:' + color + ';';
    bar.innerHTML = '<span>' + msg + ' <a href="settings.html" style="color:inherit;text-decoration:underline;margin-left:6px">View settings →</a></span><button onclick="this.parentNode.remove()" style="border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer;padding:0 4px;line-height:1">×</button>';
    document.body.insertBefore(bar, document.body.firstChild);
  }

  // ===== COACH (AI assistant, present on every page) =====
  // Lives in topbar.js (not a separate page) so it's always available.
  // Proactively surfaces something noteworthy once per day (cached in localStorage by date),
  // persists chat history across sessions so follow-ups have full context.
  function initCoach() {
    const fab = document.getElementById('coachFab');
    const panelBg = document.getElementById('coachPanelBg');
    const feed = document.getElementById('coachFeed');
    const input = document.getElementById('coachInput');
    if (!fab || !panelBg) return;

    // ===== COACH — DASHBOARD DATA (payload sent to AI) =====
    function dashboardData() {
      const SKIP = new Set([
        'strava_tokens_v1','whoop_tokens_v1','google_accounts_v1','brain:obs_creds',
        'canvas_creds_v1','apiusage:log','data-theme','coach_voice_on','nova_voice_on',
        'settings:budget_alerted','settings:conservation_mode','settings:model',
        'settings:theme','settings:monthly_budget',
        'google_last_sync','canvas_last_sync','strava_last_sync','whoop_last_sync','gmail_last_sync',
        'finance_active_tab','po_coach_units_migrated_lb_v1',
        'wish-hero-pct-num','app_secret',
      ]);
      const SKIP_PFX = ['photo_','google_tokens','tpl:','coach_proactive','coach_chat_history','nova_chat_history'];
      // Redact values that look like API keys — long opaque alphanumeric strings
      // that serve no purpose in the AI context and risk being flagged or leaked.
      const API_KEY_RE = /^(sk-|xi-|sb_|xai-|Bearer |ghp_|eyJ)/;
      const LOOKS_LIKE_KEY = (v) => typeof v === 'string' &&
        (API_KEY_RE.test(v) || (v.length > 40 && /^[A-Za-z0-9_\-]{40,}$/.test(v)));
      const now = Date.now();
      const out = {};

      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (SKIP.has(k) || SKIP_PFX.some(p => k.startsWith(p))) continue;
        let v;
        try { v = JSON.parse(localStorage.getItem(k)); } catch (_) { v = localStorage.getItem(k); }
        if (typeof v === 'string' && v.startsWith('data:')) continue; // base64 blob
        if (LOOKS_LIKE_KEY(v)) continue; // redact API-key-shaped strings

        if (k === 'marathon_plan_v1' && v && Array.isArray(v.entries)) {
          // Include all completed entries (full history for trend analysis)
          // + all future planned entries (so coach knows upcoming schedule).
          // Slim each entry to avoid token bloat.
          // Never pass raw date strings — Claude re-derives day-of-week from them
          // and gets relative timing wrong (Invariant §5). Use precomputed when/daysAgo.
          const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
          const slim = (e) => {
            const entryDay = new Date(e.date + 'T00:00');
            const daysAgo = Math.round((todayMidnight - entryDay) / 86400000);
            const when = daysAgo === 0 ? 'today'
              : daysAgo === 1 ? 'yesterday'
              : daysAgo > 1  ? daysAgo + ' days ago'
              : daysAgo === -1 ? 'tomorrow'
              : Math.abs(daysAgo) + ' days from now';
            // date is included for COACH_ACTION write ops only — coach must still
            // use `when` to describe timing in replies (not re-derive from date).
            return { when, daysAgo, date:e.date, type:e.type, label:e.label,
              plannedDistanceMi:e.plannedDistanceMi, completed:e.completed,
              actualDistanceMi:e.actualDistanceMi };
          };
          // Use todayMidnight (not Date.now()) so today's entry lands in upcoming,
          // not past — otherwise coach can't find today's scheduled run in entries_upcoming.
          const tmMs = todayMidnight.getTime();
          const past = v.entries.filter(e => new Date(e.date + 'T00:00').getTime() < tmMs).map(slim);
          const future = v.entries.filter(e => new Date(e.date + 'T00:00').getTime() >= tmMs).map(slim);
          // Precompute last_logged_run: most recent past non-rest entry with completion evidence.
          // Enrich with Strava GPS data for the same date so the coach gets accurate
          // distance/pace instead of manually-entered plan values.
          const stravaRaw = (function() {
            try { return JSON.parse(localStorage.getItem('strava_activities_v1') || '[]'); } catch (_) { return []; }
          })();
          const lastLoggedBase = past
            .filter(e => e.type !== 'rest' && (e.completed === true || (e.actualDistanceMi && e.actualDistanceMi > 0)))
            .sort((a, b) => b.date.localeCompare(a.date))[0] || null;
          let lastLoggedRun = lastLoggedBase;
          if (lastLoggedBase) {
            const stravaMatch = stravaRaw.find(function(a) { return a.date === lastLoggedBase.date; });
            if (stravaMatch) {
              const totalSec = stravaMatch.paceSecPerMi ? Math.round(stravaMatch.paceSecPerMi) : null;
              const pace = totalSec ? Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0') + '/mi' : null;
              lastLoggedRun = Object.assign({}, lastLoggedBase, {
                strava_distanceMi: stravaMatch.distanceMi,
                strava_pace: pace,
                strava_name: stravaMatch.name,
                strava_durationMin: stravaMatch.movingSec ? Math.round(stravaMatch.movingSec / 60) : null,
              });
            }
          }
          // entries_recent_history: last 30 past entries newest-first (trimmed for AI context)
          const recentPast = past.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
          // entries_upcoming: explicitly sorted chronological, cap 90 (covers 3 months — enough for Toledo Sep 20).
          // 30 was too few: entries beyond day 30 (late August, September) were invisible, hiding race week/taper.
          const futureSorted = future.slice().sort((a, b) => a.date.localeCompare(b.date)).slice(0, 90);
          // Precompute race countdown so coach doesn't re-derive from raw raceDate (Invariant §5)
          let raceCountdownDays = null, raceWhen = null;
          if (v.raceDate) {
            const raceDay = new Date(v.raceDate + 'T00:00');
            raceCountdownDays = Math.round((raceDay - todayMidnight) / 86400000);
            raceWhen = raceCountdownDays === 0 ? 'today' : raceCountdownDays === 1 ? 'tomorrow'
              : raceCountdownDays > 0 ? raceCountdownDays + ' days from now' : Math.abs(raceCountdownDays) + ' days ago';
          }
          out[k] = { ...v, entries_recent_history: recentPast, entries_upcoming: futureSorted, last_logged_run: lastLoggedRun, race_countdown_days: raceCountdownDays, race_when: raceWhen };
          delete out[k].entries; // replaced by split arrays above
        } else if (k === 'notes:items' && Array.isArray(v)) {
          out[k] = v.slice(0, 25).map(n => ({ title:n.title, category:n.category,
            body:(n.body||'').slice(0,150), pinned:n.pinned }));
        } else if (k === 'brain:obs_notes' && Array.isArray(v)) {
          out[k] = v.slice(0, 12).map(n => ({ path:n.path, body:(n.body||'').slice(0,80) }));
        } else if (k === 'strava_activities_v1' && Array.isArray(v)) {
          const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
          // Strava API returns newest-first; slice(0,30) = 30 most recent.
          // slice(-30) was a bug: it gave the 30 oldest, hiding recent runs.
          out[k] = v.slice(0, 30).map(a => {
            const actDay = a.date ? new Date(a.date.slice(0,10) + 'T00:00:00') : null;
            const daysAgo = actDay ? Math.round((todayMidnight - actDay) / 86400000) : null;
            const when = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : daysAgo != null ? daysAgo + ' days ago' : 'unknown';
            // Format pace as MM:SS/mi to match what Strava displays — decimal minutes
            // (e.g. 9.08) don't match the app (9:05) and confuse the coach.
            let pace = null;
            if (a.paceSecPerMi) {
              const totalSec = Math.round(a.paceSecPerMi);
              pace = Math.floor(totalSec / 60) + ':' + String(totalSec % 60).padStart(2, '0') + '/mi';
            }
            return { name: a.name, type: a.type, when, date: a.date,
              distanceMi: a.distanceMi,
              durationMin: a.movingSec ? Math.round(a.movingSec / 60) : null,
              pace };
          });
        } else if (k === 'google_calendars_v3' && v && typeof v === 'object') {
          // keep calendar list but drop the cached events array to avoid huge dumps
          const slim = {};
          for (const id of Object.keys(v)) slim[id] = { name:v[id].name, color:v[id].color, enabled:v[id].enabled };
          out[k] = slim;
        } else if (k === 'internship:opportunities' && Array.isArray(v)) {
          out[k] = v.slice(0, 20).map(o => ({ company:o.company, role:o.role,
            status:o.status, deadline:o.deadline }));
        } else if (k === 'nw:history' && Array.isArray(v)) {
          out[k] = v.slice(-6);
        } else if (k === 'po_coach_v1' && v && typeof v === 'object') {
          // Slim the gym state: keep exercises/days/gyms, but restrict logs to
          // the most recent 60 entries per exercise (enough for trend analysis).
          const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days
          const slimLogs = {};
          if (v.logs && typeof v.logs === 'object') {
            Object.keys(v.logs).forEach(exId => {
              const arr = (v.logs[exId] || []).filter(l => l && l.date && l.date >= cutoff);
              if (arr.length) slimLogs[exId] = arr.slice(-10).map(l => ({ date: l.date.slice(0, 10), sets: l.sets, weight: l.weight, reps: l.reps }));
            });
          }
          // Compute today's gym split from splitRotation + splitAnchor so coach
          // doesn't have to figure out day-of-week arithmetic itself.
          let todayGymSplit = null;
          try {
            const rot = v.splitRotation;
            const anch = v.splitAnchor;
            if (rot && rot.length && anch && anch.date) {
              const [ay, am, ad] = anch.date.split('-').map(Number);
              const anchorDay = new Date(ay, am - 1, ad);
              const todayDay = new Date(); todayDay.setHours(0, 0, 0, 0);
              const diffDays = Math.round((todayDay - anchorDay) / 86400000);
              const idx = ((anch.index + diffDays) % rot.length + rot.length) % rot.length;
              const splitName = rot[idx];
              const matchDay = Array.isArray(v.days) && v.days.find(function(d) {
                return d.name && d.name.toLowerCase() === splitName.toLowerCase();
              });
              const exercises = matchDay && Array.isArray(matchDay.exercises)
                ? matchDay.exercises.map(function(exId) {
                    const ex = Array.isArray(v.exercises) && v.exercises.find(function(e) { return e.id === exId; });
                    return ex ? ex.name : exId;
                  })
                : [];
              todayGymSplit = { split: splitName, isRest: /^rest\b/i.test(splitName), exercises };
            }
          } catch (e) { /* leave null */ }
          out[k] = { exercises: v.exercises, days: v.days, gyms: v.gyms, logs: slimLogs, today_gym_split: todayGymSplit };
        } else if (k === 'google_cal_events_v1' && Array.isArray(v)) {
          // Already slimmed with precomputed when strings — cap to 30 upcoming events
          out[k] = v.slice(0, 30);
        } else if (k === 'gmail_summary_v1' && v && typeof v === 'object') {
          // Slim gmail data: pass unread count, top 10 threads (subject/from/when/snippet),
          // and up to 5 shipping threads. Drop full email bodies and raw dates.
          out[k] = {
            unreadCount: v.unreadCount || 0,
            threads: (v.threads || []).slice(0, 10).map(function(t) {
              return { subject: t.subject, from: t.from, when: t.when, snippet: (t.snippet || '').slice(0, 120), isUnread: t.isUnread, isImportant: t.isImportant, id: t.id };
            }),
            shipping: (v.shipping || []).slice(0, 5).map(function(t) {
              return { subject: t.subject, from: t.from, when: t.when, snippet: (t.snippet || '').slice(0, 160) };
            }),
          };
        } else if (k === 'po_water_v1' && v && typeof v === 'object') {
          // Precompute hydration summary — raw logs make coach pick wrong date (Invariant §5).
          // Passing all date-keyed log entries is the same as passing raw Strava dates: the AI
          // has to guess which key is "today" and gets it wrong. Slim to precomputed fields.
          const wToday = (function() {
            const d = new Date(); if (d.getHours() < 6) d.setDate(d.getDate() - 1);
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          })();
          const wLogs = v.logs || {};
          const wTodayBottles = wLogs[wToday] || 0;
          const wp = v.profile || {};
          const wBase = (wp.weightKg || 0) * 35;
          const wExercise = (wp.activityHrsPerWeek || 0) / 7 * 500;
          const wCaffeine = Math.max(0, (v.caffeineMgPerDay || 0) - 200) * 1.5;
          let wAdjust = 0;
          if (wp.sex === 'm') wAdjust += 200;
          if ((wp.age || 0) >= 50) wAdjust += 100;
          const wTotalMl = wBase + wExercise + wCaffeine + wAdjust;
          let wUnitVol = v.bottleMl || 500;
          if (v.unit === 'glass') wUnitVol = v.glassMl || 250;
          else if (v.unit === 'oz') wUnitVol = 30;
          else if (v.unit === 'ml') wUnitVol = 1;
          const wTarget = Math.max(1, Math.ceil(wTotalMl / wUnitVol));
          const wUnit = v.unit || 'bottle';
          const wTm = new Date(); wTm.setHours(0,0,0,0);
          const wRecent = [];
          for (let di = 0; di < 7; di++) {
            const dd = new Date(wTm.getTime() - di * 86400000);
            const dk = dd.getFullYear() + '-' + String(dd.getMonth()+1).padStart(2,'0') + '-' + String(dd.getDate()).padStart(2,'0');
            if (wLogs[dk] != null) {
              wRecent.push({ when: di === 0 ? 'today' : di === 1 ? 'yesterday' : di + ' days ago', [wUnit + 's']: wLogs[dk] });
            }
          }
          out[k] = { today_bottles: wTodayBottles, today_target: wTarget, today_pct: Math.round(wTodayBottles / wTarget * 100), unit: wUnit, recent_7d: wRecent };
        } else if (k === 'po_coach_weights' && Array.isArray(v)) {
          out[k] = v.slice(-20);
        } else if ((k === 'po_coach_photos' || k === 'po_coach_inbody') && v) {
          out[k] = '[photos omitted for size]';
        } else if (typeof v === 'string' && v.length > 4000) {
          out[k] = v.slice(0, 400) + '…';
        } else if (k.startsWith('goals:') && Array.isArray(v)) {
          // Annotate snoozed goals so the coach knows to exclude them from briefings.
          // A goal with snoozedUntil in the future must not appear in counts or alerts.
          const gToday = (function() {
            const d = new Date();
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          })();
          out[k] = v.map(function(g) {
            if (g && g.snoozedUntil && g.snoozedUntil > gToday) return Object.assign({}, g, { snoozed: true });
            return g;
          });
        } else {
          out[k] = v;
        }
      }

      // Push notification status — read from browser API at call time (not in localStorage)
      if (typeof Notification !== 'undefined') {
        out['push_notifications'] = {
          permission: Notification.permission, // 'granted' | 'denied' | 'default'
          // Schedule is in ET (UTC-4 summer / UTC-5 winter). Crons run in UTC.
          schedule: [
            { type: 'morning check-in',         time: '8:00 AM ET',  utc: '0 12 * * *' },
            { type: 'reminders (goals/chores)',  time: '9:00 AM ET',  utc: '0 13 * * *' },
            { type: 'nutrition log',             time: '4:00 PM ET',  utc: '0 20 * * *' },
            { type: 'training (marathon)',        time: '5:00 PM ET',  utc: '0 21 * * *' },
            { type: 'skincare routine',           time: '10:00 PM ET', utc: '0 2 * * *'  },
          ]
        };
      }

      // Final guard: trim until under 40 KB.
      // marathon_plan_v1 is protected — the coach needs entry dates/types to emit
      // valid write ops. Trim everything else first (by descending size), then
      // reduce marathon's entries_upcoming to 20 (from 90) before trimming it entirely.
      let json = JSON.stringify(out);
      if (json.length > 40000) {
        const otherKeys = Object.keys(out)
          .filter(k => k !== 'marathon_plan_v1')
          .sort((a,b) => JSON.stringify(out[b]).length - JSON.stringify(out[a]).length);
        for (const k of otherKeys) {
          out[k] = '[trimmed]';
          json = JSON.stringify(out);
          if (json.length <= 40000) break;
        }
      }
      // Still over? Shrink marathon entries_upcoming before nuking it entirely.
      if (json.length > 40000 && out['marathon_plan_v1'] && out['marathon_plan_v1'].entries_upcoming) {
        out['marathon_plan_v1'] = Object.assign({}, out['marathon_plan_v1'],
          { entries_upcoming: out['marathon_plan_v1'].entries_upcoming.slice(0, 20) });
        json = JSON.stringify(out);
      }
      if (json.length > 40000 && out['marathon_plan_v1']) {
        out['marathon_plan_v1'] = '[trimmed]';
      }
      return out;
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function addMsg(role, text, proactive, save) {
      const el = document.createElement('div');
      el.className = 'coach-msg ' + role + (proactive ? ' proactive' : '');
      el.textContent = text;
      feed.appendChild(el);
      feed.scrollTop = feed.scrollHeight;
      if (save !== false) persistMsg(role, text, proactive);
      return el;
    }

    function loadChatHistory() {
      try {
        const arr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
        msgArr = arr.slice(); // seed in-memory authority from localStorage
        arr.forEach(m => {
          addMsg(m.role, m.text, m.proactive, false);
          // Rebuild AI context from non-proactive messages
          if (!m.proactive) {
            chatHistory.push({ role: m.role === 'coach' ? 'assistant' : 'user', content: m.text });
          }
        });
        if (chatHistory.length > MAX_CTX) chatHistory.splice(0, chatHistory.length - MAX_CTX);
      } catch (e) {}
    }

    function addLoading() {
      const el = document.createElement('div');
      el.className = 'coach-msg coach';
      el.innerHTML = '<span class="coach-dots"><i></i><i></i><i></i></span>';
      feed.appendChild(el);
      feed.scrollTop = feed.scrollHeight;
      return el;
    }

    // Compute fresh on every call, using the same 6 AM rollover as activeDateKey()
    // so the date the coach states always matches the date keys used for goals/supplements/water.
    function coachTodayLabel() {
      const now = new Date();
      const d = new Date(now);
      if (now.getHours() < 6) d.setDate(d.getDate() - 1);
      return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    }
    function CHAT_SYS() {
      let memory = '';
      if (Array.isArray(memArr) && memArr.length) {
        memory = '\n\nPERSISTENT USER INSTRUCTIONS — always follow these, they override defaults and never expire:\n' +
          memArr.map(function(x, i) { return (i + 1) + '. ' + x; }).join('\n');
      }
      return "You are the user's personal AI system — sophisticated, precise, and authoritative, like J.A.R.V.I.S. " +
        "You have full access to their life-tracking data. Today is " + coachTodayLabel() + ". " +
        "Your replies are delivered via ElevenLabs TTS in voice mode — " +
        "never disclaim or reference being text-only. Rules: " +
        "Never repeat prior statements. Never re-introduce yourself. " +
        "Never restate data the user already knows. " +
        "Answer concisely and precisely — one to two sentences, or a tight bullet list. " +
        "Be formal and professional. Build naturally on conversation history. " +
        "If more information is needed, ask one focused question. " +
        "KEY DATA NOTES: goals:YYYY-MM-DD is [{text,done}] — done=true means ALREADY COMPLETED, never treat completed goals as outstanding. " +
        "po_coach_workout_done={YYYY-MM-DD:true} tracks logged gym sessions. " +
        "po_coach_v1.today_gym_split = {split:'Push',isRest:false,exercises:['Bench Press',...]} — precomputed for today, use it directly. " +
        "strava_activities_v1 entries have 'when' (precomputed, use verbatim) and 'pace' formatted as MM:SS/mi (matches Strava display exactly). " +
        "marathon_plan_v1.entries_upcoming includes today (daysAgo=0) and future entries. entries_recent_history has past entries newest-first. " +
        "last_logged_run may have strava_distanceMi and strava_pace (GPS-accurate, MM:SS/mi) — always prefer these over plan values when present. " +
        "\n\nMODULE WRITE ACCESS — YOU ARE NOT READ-ONLY: You have FULL write access to the user's goals, marathon plan, Google Calendar, water/hydration, and Gmail. " +
        "NEVER tell the user you 'can only read' any of these systems. Always emit the appropriate block. " +
        "Append one or more [COACH_ACTION:{...}] blocks (valid JSON, no line breaks inside) at the END of your reply. Multiple blocks allowed. Always confirm in text what you changed.\n" +
        "CALENDAR (module:\"calendar\"): You CAN add events to the user's Google Calendar. Timezone: " + ((typeof Intl !== 'undefined') ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'America/New_York') + ". If time/date is unclear, ask first.\n" +
        " • Add event: {\"module\":\"calendar\",\"op\":\"add_event\",\"title\":\"Event name\",\"datetime\":\"YYYY-MM-DDTHH:MM:00\",\"durationMinutes\":60,\"notificationMinutes\":15}\n" +
        "MARATHON (module:\"marathon\"): entries have a `date` field (YYYY-MM-DD) — use it to target write ops, but describe timing with `when` in your reply.\n" +
        " • Update entry: {\"module\":\"marathon\",\"op\":\"update_entry\",\"date\":\"YYYY-MM-DD\",\"set\":{\"type\":\"easy|long|speed|tempo|rest|cross|race|other\",\"label\":\"Short label\",\"plannedDistanceMi\":6.0}}\n" +
        " • Move entry: {\"module\":\"marathon\",\"op\":\"move_entry\",\"fromDate\":\"YYYY-MM-DD\",\"toDate\":\"YYYY-MM-DD\",\"type\":\"easy\",\"label\":\"Easy 6mi\",\"plannedDistanceMi\":6.0} — always include type/label/distance as fallback if fromDate entry is missing\n" +
        " • Add entry: {\"module\":\"marathon\",\"op\":\"add_entry\",\"date\":\"YYYY-MM-DD\",\"type\":\"easy\",\"label\":\"Easy 6mi\",\"plannedDistanceMi\":6.0}\n" +
        " • Remove entry: {\"module\":\"marathon\",\"op\":\"remove_entry\",\"date\":\"YYYY-MM-DD\"}\n" +
        " • Set race date: {\"module\":\"marathon\",\"op\":\"set_race\",\"raceDate\":\"YYYY-MM-DD\"}\n" +
        " • Replace full plan: {\"module\":\"marathon\",\"op\":\"replace_plan\",\"entries\":[...]} — clears ALL existing entries and writes a new set. Use for the FIRST batch when generating a fresh plan. Keep to ≤20 entries per block to avoid response truncation. Optional: \"raceDate\":\"YYYY-MM-DD\", \"goalSec\":integer.\n" +
        " • Append entries (additive batch): {\"module\":\"marathon\",\"op\":\"append_entries\",\"entries\":[...]} — adds entries WITHOUT clearing existing ones. Use for subsequent batches (weeks 2+) after replace_plan. Keep to ≤20 entries per block. Same entry schema as replace_plan.\n" +
        " LARGE PLAN RULE: Never try to write a full multi-week plan in one block — responses will be truncated. Instead: batch 1 = replace_plan(entries ≤20), batch 2 = append_entries(next ≤20), etc. Tell the user how many batches you will send and ask them to confirm each one is saved before sending the next.\n" +
        "GOALS (module:\"goals\"): today's date for goals is " + (function(){ const d=new Date(); if(d.getHours()<6)d.setDate(d.getDate()-1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })() + ".\n" +
        " • Add goal: {\"module\":\"goals\",\"op\":\"add\",\"text\":\"Goal text\",\"date\":\"YYYY-MM-DD\"}\n" +
        " • Complete goal: {\"module\":\"goals\",\"op\":\"complete\",\"text\":\"Exact goal text\",\"date\":\"YYYY-MM-DD\"}\n" +
        " • Remove goal: {\"module\":\"goals\",\"op\":\"remove\",\"text\":\"Exact goal text\",\"date\":\"YYYY-MM-DD\"}\n" +
        " • Update goal: {\"module\":\"goals\",\"op\":\"update\",\"oldText\":\"Old text\",\"newText\":\"New text\",\"date\":\"YYYY-MM-DD\"}\n" +
        " • Snooze goal (hide from briefings/alerts until a date): {\"module\":\"goals\",\"op\":\"snooze\",\"text\":\"partial or full goal text (substring match)\",\"date\":\"YYYY-MM-DD\",\"until\":\"YYYY-MM-DD\"}\n" +
        " • Unsnooze goal: {\"module\":\"goals\",\"op\":\"unsnooze\",\"text\":\"Goal text\",\"date\":\"YYYY-MM-DD\"}\n" +
        "HYDRATION NOTE: po_water_v1 in dashboard data is pre-slimmed to {today_bottles, today_target, today_pct, unit, recent_7d}. Use today_bottles/today_target directly — never try to read raw date keys from logs.\n" +
        "WATER (module:\"water\"): You CAN update the user's hydration log (po_water_v1). Today's date for water is " + (function(){ const d=new Date(); if(d.getHours()<6)d.setDate(d.getDate()-1); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })() + ".\n" +
        " • Set bottles for a date: {\"module\":\"water\",\"op\":\"set\",\"date\":\"YYYY-MM-DD\",\"bottles\":8}\n" +
        " • Add bottles to a date: {\"module\":\"water\",\"op\":\"add\",\"date\":\"YYYY-MM-DD\",\"bottles\":2}\n" +
        "GMAIL (module:\"gmail\"): Read access via gmail_summary_v1 in dashboard data. To draft/send an email, emit a [COACH_ACTION] with op:\"send\" — a confirmation card appears and the email is NOT sent until the user clicks Send.\n" +
        " • Draft/send: {\"module\":\"gmail\",\"op\":\"send\",\"to\":\"name@domain.com\",\"subject\":\"Subject line\",\"body\":\"Full email body text\",\"cc\":\"optional\",\"threadId\":\"optional thread id for replies\"}\n" +
        "GMAIL RULES: Always write the full email body — do not truncate or summarize. If recipient, subject, or key content is unclear, ask before emitting. Do not mention the confirmation step in your reply text — it appears automatically.\n" +
        "CRITICAL WRITE RULE: Whenever the user asks you to change, update, add, remove, move, reschedule, edit, modify, suppress, delete, or log ANYTHING — you MUST emit a [COACH_ACTION:{...}] block in the same reply. " +
        "Do NOT say 'I've noted that', 'I'll remember that', or 'those live in systems I can only read' — those statements are WRONG. The change is NOT saved unless you emit the block. " +
        "If the details are ambiguous, ask ONE clarifying question before emitting. Never emit for read-only questions (show me, what is, tell me about)." +
        memory +
        "\n\nDashboard data as JSON:\n";
    }
    function PROACTIVE_SYS() {
      let prevBriefing = '';
      try {
        const hist = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
        // Collect ALL previous proactive briefings to build a full picture of what's been said
        const prevProactives = hist.filter(function(m) { return m.proactive && m.role === 'coach'; }).slice(-3);
        if (prevProactives.length) {
          prevBriefing = '\n\nPREVIOUS BRIEFINGS (do NOT repeat any point already covered unless it has materially changed — no updates, no reminders of what you already said, no restating pending items):\n' +
            prevProactives.map(function(m, i) { return 'Briefing ' + (i + 1) + ': ' + m.text; }).join('\n---\n');
        }
      } catch (e) {}
      const todayGoalsKey = 'goals:' + activeDateKey();
      return "You are a sophisticated AI system delivering the user's comprehensive daily briefing. Today is " + coachTodayLabel() + ". " +
        "This runs ONCE per day — be thorough. Cover every section that has relevant data. Be concise within each section but don't skip anything meaningful.\n\n" +
        "REQUIRED SECTIONS (in order, skip only if truly no data):\n\n" +
        "1. TODAY'S GOALS — Read '" + todayGoalsKey + "'. Bullet-list every item where done=false. " +
        "If all done, say 'All goals complete ✓'. If key missing/empty, say 'No goals set for today.'\n\n" +
        "2. TRAINING — " +
        "TODAY'S MARATHON: check marathon_plan_v1.entries_upcoming for the entry with daysAgo=0 (today). If present and type!='rest', state the workout. " +
        "TODAY'S GYM: check po_coach_v1.today_gym_split — if isRest=false, state the split name and exercises. " +
        "LAST RUN: use marathon_plan_v1.last_logged_run. If it has strava_distanceMi/strava_pace fields, use those — they are GPS-accurate Strava values. " +
        "Fall back to actualDistanceMi/plannedDistanceMi only if no strava fields. Use 'when' verbatim. " +
        "If last_logged_run is null, use the most recent strava_activities_v1 entry (pace is already MM:SS/mi format). " +
        "NEVER report a multi-week running gap if marathon plan entries_upcoming has a run today/recently or last_logged_run exists. " +
        "RACE: use marathon_plan_v1.race_when (precomputed) for countdown — do NOT calculate from raceDate yourself. Note upcoming key workouts (long runs, tempo, race) from entries_upcoming this week.\n\n" +
        "3. HEALTH & HABITS — Supplement stack status (stack:items + stack:taken). " +
        "Hydration: po_water_v1 is pre-slimmed — use today_bottles vs today_target (both already in your unit). Compute pct from today_pct. " +
        "Any caffeine notes from caf:logs. Skip if nothing to report.\n\n" +
        "4. CALENDAR — Upcoming events from google_cal_events_v1 (today and tomorrow). Skip if none.\n\n" +
        "5. EMAIL — From gmail_summary_v1: unread count, any important/starred threads needing action, and any shipping emails (packages in transit or arriving soon). Skip entirely if inbox is clear or no gmail data.\n\n" +
        "6. ALERTS — Any genuinely critical items not covered above: overdue deadlines, missed targets, upcoming race countdown, health flags. 1-3 bullets max. Skip entirely if nothing stands out.\n\n" +
        "DATA RULES: " +
        "(1) done=true = COMPLETED — never list as outstanding. " +
        "(2) strava/marathon 'when' is precomputed — use verbatim, never recalculate. " +
        "(3) po_coach_workout_done {YYYY-MM-DD:true} = gym session logged. " +
        "(4) No-repeat rule: any item from a previous briefing that hasn't materially changed must be omitted. " +
        "(5) snoozed:true = goal is snoozed (hidden) until its snoozedUntil date — NEVER list in goal counts, task bullets, or alerts. Treat as if it does not exist." +
        prevBriefing;
    }

    // ===== COACH — HISTORY PERSISTENCE =====
    const HIST_KEY = 'coach_chat_history';
    const MAX_SAVED = 80;   // visual messages kept in localStorage
    const MAX_CTX   = 40;   // AI context turns (user+assistant pairs)
    // In-memory authority for coach history. null = not yet loaded.
    // Protects against applyRemote overwriting localStorage with a stale server
    // snapshot within the 250ms debounce window between a user message and the push.
    let msgArr = null;

    // In-memory authority for persistent coach instructions.
    // Loaded from localStorage at init; always used as the source of truth
    // for CHAT_SYS() so applyRemote cannot silently clear instructions mid-session.
    let memArr = (function() {
      try { return JSON.parse(localStorage.getItem('coach_memory') || '[]'); } catch (e) { return []; }
    })();

    function todayDateStr() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }
    function proactiveDayKey() { return 'coach_proactive_' + todayDateStr(); }

    // Frees localStorage space by trimming accumulated ephemeral and archival data.
    // Safe to call at any time — only touches data that is either re-generatable
    // or already backed up to the server.
    //
    // Trimming order (safest → most impactful):
    //   1. All coach_proactive_* keys — ephemeral flags, regenerate next scan
    //   2. coach_chat_history → 15 messages — synced to server, will be restored
    //   3. goals_history_v1 → 14 days — local archive (not synced), oldest days dropped
    //   4. po_coach_inbody_img_* older than 90 days — local-only JPEG base64 blobs;
    //      the scan metadata (po_coach_inbody) is synced, only the raw image is lost
    function pruneOldStorage() {
      // 1. Old coach_proactive_* keys (keep today's so the scan doesn't re-fire)
      const todayPKey = proactiveDayKey();
      const toDelete = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('coach_proactive_') && k !== todayPKey) toDelete.push(k);
      }
      toDelete.forEach(function(k) { try { localStorage.removeItem(k); } catch (_) {} });

      // 2. Trim coach_chat_history to 15 most recent messages (synced, will restore)
      try {
        const hist = JSON.parse(localStorage.getItem('coach_chat_history') || '[]');
        if (hist.length > 15) localStorage.setItem('coach_chat_history', JSON.stringify(hist.slice(-15)));
      } catch (_) {}

      // 3. Trim goals_history_v1 to last 14 days (local archive only)
      try {
        const hist = JSON.parse(localStorage.getItem('goals_history_v1') || '[]');
        if (hist.length > 14) localStorage.setItem('goals_history_v1', JSON.stringify(hist.slice(0, 14)));
      } catch (_) {}

      // 4. Delete inbody scan images older than 90 days (local-only base64 JPEGs —
      //    the largest single source of localStorage bloat; scan metadata stays intact)
      try {
        const cutoff90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        const scans = JSON.parse(localStorage.getItem('po_coach_inbody') || '[]');
        scans.forEach(function(s) {
          if (s && s.id && s.dateKey && s.dateKey < cutoff90) {
            try { localStorage.removeItem('po_coach_inbody_img_' + s.id); } catch (_) {}
          }
        });
      } catch (_) {}
    }
    window.pruneOldStorage = pruneOldStorage; // exposed so other pages can call it on quota error

    function persistMsg(role, text, proactive) {
      // Append to in-memory authority first — this survives applyRemote overwrites.
      if (!msgArr) msgArr = [];
      msgArr.push({ role, text, proactive: !!proactive, ts: Date.now() });
      if (msgArr.length > MAX_SAVED) msgArr.splice(0, msgArr.length - MAX_SAVED);

      // Write to localStorage — if quota is exceeded, prune old data and retry once.
      let wrote = false;
      for (let attempt = 0; attempt < 2 && !wrote; attempt++) {
        try {
          localStorage.setItem(HIST_KEY, JSON.stringify(msgArr));
          wrote = true;
        } catch (_) {
          if (attempt === 0) {
            pruneOldStorage(); // delete accumulated coach_proactive_* keys
            if (msgArr.length > 20) msgArr.splice(0, msgArr.length - 20); // trim history in half
          }
        }
      }
      if (!wrote) {
        addMsg('coach', '⚠ Could not save message — storage may be full.', true, false);
        return;
      }

      // Immediate push without keepalive. keepalive is limited to 64 KB by browsers;
      // once the history grows past that limit the request is silently dropped.
      const secret = window.DASH_APP_SECRET || '';
      const snapshot = msgArr.slice();
      fetch('/api/db', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
        body: JSON.stringify({ key: 'coach', data: { 'coach_chat_history': snapshot } })
      }).catch(function() {
        // sync.js debounced push will retry on the next setItem call.
        addMsg('coach', '⚠ Cloud save failed — message is stored locally and will retry.', true, false);
      });
    }

    // Conversation history sent to the AI — rebuilt from localStorage on load.
    const chatHistory = [];
    function DATA_SYS() { return CHAT_SYS() + JSON.stringify(dashboardData()); }

    // attachment: { type:'image'|'text', mediaType?:string, data:string, name:string }
    async function callAI(system, userText, addToHistory, attachment) {
      // Build the content for this message — multimodal when an attachment is present.
      let userContent;
      let historyText = userText; // what we store in chatHistory (text-only, no base64 blobs)
      if (attachment) {
        if (attachment.type === 'image') {
          userContent = [
            { type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data } },
            { type: 'text', text: userText || 'Please describe and analyze this image.' },
          ];
          historyText = '[Attached image: ' + attachment.name + ']\n' + (userText || '');
        } else {
          // Text/markdown/code — prepend as a fenced block so Claude sees the full content
          userContent = '--- FILE: ' + attachment.name + ' ---\n' + attachment.data + '\n--- END FILE ---\n\n' + (userText || 'Please analyze the file above.');
          historyText = '[Attached file: ' + attachment.name + ']\n' + (userText || '');
        }
      } else {
        userContent = userText;
      }
      const msgs = addToHistory
        ? [...chatHistory, { role: 'user', content: userContent }]
        : [{ role: 'user', content: userContent }];
      const res = await fetch('/api/ai/ai-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-secret': (window.DASH_APP_SECRET || '') },
        body: JSON.stringify({
          system,
          model: window.getPreferredModel ? window.getPreferredModel() : 'claude-opus-4-8',
          conservation: window.isConservationMode ? window.isConservationMode() : false,
          hasAttachment: !!attachment,
          messages: msgs,
        }),
      });
      if (window.logApiUsage) window.logApiUsage(res.headers.get('X-Usage-Input-Tokens'), res.headers.get('X-Usage-Output-Tokens'), res.headers.get('X-Usage-Model'), 'coach');
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || 'Something went wrong.');
      const reply = json.text || '(no response)';
      if (addToHistory) {
        chatHistory.push({ role: 'user', content: historyText }); // store text summary, not the full base64 blob
        chatHistory.push({ role: 'assistant', content: reply });
        if (chatHistory.length > MAX_CTX) chatHistory.splice(0, chatHistory.length - MAX_CTX);
      }
      return reply;
    }

    // ===== COACH — DATA PRIMING (fetches server rows into localStorage before AI calls) =====
    async function primeCoachData() {
      const secret = window.DASH_APP_SECRET || '';
      // On main.html, goals: keys are actively managed by initCloudSync — writing
      // stale server data here would race with user edits and wipe newly added goals.
      // Skip goals: on this page; initCloudSync already keeps them current.
      const onGoalsPage = /\/(main\.html)?$/.test(window.location.pathname);
      const rows = ['goals', 'health', 'profile', 'marathon', 'caffeine', 'gym'];
      await Promise.allSettled(rows.map(async function(rowKey) {
        try {
          const r = await fetch('/api/db?key=' + encodeURIComponent(rowKey), {
            headers: { 'X-App-Secret': secret }
          });
          if (!r.ok) return;
          const json = await r.json();
          if (!json || !json.data) return;
          const PROTECT_MS = 5 * 60 * 1000; // 5 minutes
          Object.entries(json.data).forEach(function([k, v]) {
            if (k.startsWith('coach_')) return; // never overwrite coach state from other rows
            // Skip goals on main.html (initCloudSync owns them) OR if coach wrote goals
            // recently this session (guards against primeCoachData restoring stale server
            // data after a push that completed but hasn't propagated, or after a push failure).
            if (k.startsWith('goals:') && (onGoalsPage || (_coachLastGoalsWrite > 0 && Date.now() - _coachLastGoalsWrite < PROTECT_MS))) return;
            if (k === 'marathon_plan_v1') {
              // Primary guard: if coach wrote this plan recently this session, don't overwrite.
              // _coachLastMarathonWrite is set BEFORE the push await so this covers the
              // window where primeCoachData's fetch returns while the push is in-flight.
              if (_coachLastMarathonWrite > 0 && Date.now() - _coachLastMarathonWrite < PROTECT_MS) return;
              // Secondary guard: if local has a timestamp and server is older or missing one,
              // keep local. Use >= (not >) so same-timestamp local isn't overwritten.
              try {
                const localPlan = JSON.parse(localStorage.getItem('marathon_plan_v1') || 'null');
                const serverPlan = typeof v === 'object' ? v : JSON.parse(v);
                if (localPlan && localPlan.updatedAt) {
                  if (!serverPlan || !serverPlan.updatedAt || localPlan.updatedAt >= serverPlan.updatedAt) {
                    return; // local is same age or newer — don't overwrite
                  }
                }
              } catch (_) {}
            }
            if (k === 'po_water_v1') {
              // Merge water logs instead of overwriting — take max per date key so that
              // bottles logged on this device this session are not replaced by a stale
              // server snapshot (the server may lag if the 401 bug prevented pushes).
              const serverData = (typeof v === 'object' && v !== null) ? v : (function() { try { return JSON.parse(v); } catch(_) { return {}; } }());
              let localData;
              try { localData = JSON.parse(localStorage.getItem('po_water_v1')); } catch(_) {}
              if (localData && localData.logs && serverData && serverData.logs) {
                const mergedLogs = Object.assign({}, serverData.logs);
                Object.entries(localData.logs).forEach(function([dk, cnt]) {
                  mergedLogs[dk] = Math.max(mergedLogs[dk] || 0, cnt);
                });
                const merged = Object.assign({}, serverData, localData, { logs: mergedLogs });
                try { localStorage.setItem(k, JSON.stringify(merged)); } catch(e) { console.warn('[Coach] primeCoachData po_water_v1 merge failed', e); }
              } else {
                // No local logs to protect — write server data as-is
                try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch(e) { console.warn('[Coach] primeCoachData setItem failed for', k, e); }
              }
              return;
            }
            try {
              localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
            } catch (e) { console.warn('[Coach] primeCoachData setItem failed for', k, e); }
          });
        } catch (e) { console.warn('[Coach] primeCoachData fetch failed', e); }
      }));

      // ── Refresh Strava activities (throttled: once per 30 min) ──
      // strava_activities_v1 is local-only — only updated when marathon.html is open.
      // Refreshing here ensures the coach always has current run data regardless
      // of whether the user has visited the marathon page recently.
      const stravaLastSync = parseInt(localStorage.getItem('strava_last_sync') || '0', 10);
      if (Date.now() - stravaLastSync > 30 * 60 * 1000) {
        await primeStravaActivities(secret);
      }

      // ── Refresh Gmail summary (throttled: once per 15 min) ──
      // gmail_summary_v1 is local-only. Refreshed here so coach always has
      // current inbox/shipping data without requiring a visit to mail.html.
      const gmailLastSync = parseInt(localStorage.getItem('gmail_last_sync') || '0', 10);
      if (Date.now() - gmailLastSync > 15 * 60 * 1000) {
        await loadGmailSummary(secret);
      }
    }

    async function primeStravaActivities(secret) {
      try {
        let t;
        try { t = JSON.parse(localStorage.getItem('strava_tokens_v1')); } catch(_) {}
        if (!t || !t.access) return; // not connected to Strava
        // Refresh access token if it's about to expire
        if (t.expires && Date.now() > t.expires - 60000) {
          try {
            const rr = await fetch('/api/integrations/strava', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
              body: JSON.stringify({ refresh_token: t.refresh }),
            });
            const jj = await rr.json();
            if (jj.access_token) {
              t = { access: jj.access_token, refresh: jj.refresh_token || t.refresh,
                    expires: jj.expires_at ? jj.expires_at * 1000 : Date.now() + 21600000 };
              try { localStorage.setItem('strava_tokens_v1', JSON.stringify(t)); } catch(_) {}
            }
          } catch (e) { console.warn('[Coach] Strava token refresh failed', e); }
        }
        const params = new URLSearchParams({ path: '/athlete/activities', per_page: '60' });
        const r = await fetch('/api/integrations/strava?' + params.toString(), {
          headers: { 'Authorization': 'Bearer ' + t.access, 'Accept': 'application/json', 'X-App-Secret': secret },
        });
        if (!r.ok) { console.warn('[Coach] Strava activities fetch failed:', r.status); return; }
        const acts = await r.json();
        const runs = (Array.isArray(acts) ? acts : [])
          .filter(function(a) { return /run/i.test(a.type || a.sport_type || ''); })
          .map(function(a) {
            const distanceMi = (a.distance || 0) / 1609.344;
            const movingSec = a.moving_time || 0;
            return {
              id: a.id,
              date: (a.start_date_local || a.start_date || '').slice(0, 10),
              distanceMi: +distanceMi.toFixed(2),
              movingSec: movingSec,
              paceSecPerMi: distanceMi > 0 ? movingSec / distanceMi : null,
              type: a.type || a.sport_type || 'Run',
              name: a.name || '',
            };
          });
        try { localStorage.setItem('strava_activities_v1', JSON.stringify(runs)); } catch(e) { console.warn('[Coach] Strava write failed', e); }
        localStorage.setItem('strava_last_sync', String(Date.now()));
      } catch (e) { console.warn('[Coach] primeStravaActivities failed', e); }
    }

    // ===== COACH — GMAIL SUMMARY LOADER =====
    // Fetches recent inbox threads (excluding promotions/social) and identifies shipping
    // emails. Stores result in gmail_summary_v1 for coach and mail.html.
    // Requires google_accounts_v1 token with gmail.readonly scope.
    async function loadGmailSummary(secret) {
      try {
        let accounts;
        try { accounts = JSON.parse(localStorage.getItem('google_accounts_v1') || '[]'); } catch (_) {}
        if (!accounts || !accounts.length) return;
        let account = accounts[0];
        // Only block if scope is explicitly set and doesn't include gmail.readonly.
        // Legacy accounts without a stored scope field get through (same logic as hasGmailScope() in mail.html).
        if (account.scope && !account.scope.includes('gmail.readonly')) return;

        // Refresh token if expiring soon
        if (account.expires && Date.now() > account.expires - 60000) {
          try {
            const rr = await fetch('/api/integrations/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
              body: JSON.stringify({ refresh_token: account.refresh }),
            });
            const jj = await rr.json();
            if (jj.access_token) {
              account = Object.assign({}, account, { access: jj.access_token, expires: Date.now() + (jj.expires_in || 3500) * 1000 });
              accounts[0] = account;
              try { localStorage.setItem('google_accounts_v1', JSON.stringify(accounts)); } catch (_) {}
            }
          } catch (e) { console.warn('[Gmail] token refresh failed', e); }
        }

        const gHdr = { 'Authorization': 'Bearer ' + account.access, 'X-App-Secret': secret };

        // Fetch up to 20 primary inbox messages (no promotions/social/updates)
        const listParams = new URLSearchParams({ path: '/users/me/messages', maxResults: '20', q: 'in:inbox -category:promotions -category:social -category:updates' });
        const listR = await fetch('/api/integrations/google?' + listParams, { headers: gHdr });
        if (!listR.ok) { console.warn('[Gmail] messages list failed:', listR.status); return; }
        const listData = await listR.json();
        const msgIds = ((listData.messages) || []).slice(0, 14).map(function(m) { return m.id; });
        if (!msgIds.length) {
          try { localStorage.setItem('gmail_summary_v1', JSON.stringify({ fetchedAt: Date.now(), threads: [], shipping: [], unreadCount: 0 })); } catch(_) {}
          localStorage.setItem('gmail_last_sync', String(Date.now()));
          return;
        }

        const todayMid = new Date(); todayMid.setHours(0, 0, 0, 0);
        function whenFromDate(d) {
          if (!d || isNaN(d)) return 'unknown';
          const days = Math.round((todayMid - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
          return days === 0 ? 'today' : days === 1 ? 'yesterday' : days > 1 ? days + ' days ago' : 'today';
        }
        function parseName(raw) {
          raw = (raw || '').trim();
          const m = raw.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
          return m ? m[1].trim() : raw.replace(/<[^>]+>/, '').trim() || raw.split('@')[0];
        }
        function parseEmail(raw) { const m = (raw || '').match(/<([^>]+)>/); return m ? m[1] : (raw || '').trim(); }

        // Batch-fetch message metadata in parallel
        const metaResults = await Promise.allSettled(msgIds.map(async function(id) {
          const p = new URLSearchParams({ path: '/users/me/messages/' + id, format: 'metadata' });
          p.append('metadataHeaders', 'Subject');
          p.append('metadataHeaders', 'From');
          p.append('metadataHeaders', 'Date');
          const r = await fetch('/api/integrations/google?' + p, { headers: gHdr });
          if (!r.ok) return null;
          const msg = await r.json();
          const hdrs = {};
          ((msg.payload && msg.payload.headers) || []).forEach(function(h) { hdrs[h.name] = h.value; });
          const fromRaw = hdrs['From'] || '';
          const subject = (hdrs['Subject'] || '(no subject)').slice(0, 120);
          const snippet = (msg.snippet || '').slice(0, 200);
          const dateObj = hdrs['Date'] ? new Date(hdrs['Date']) : null;
          const isUnread = ((msg.labelIds) || []).includes('UNREAD');
          const isImportant = ((msg.labelIds) || []).includes('IMPORTANT');
          const isShipping = /shipped|tracking number|your order|out for delivery|package|dispatched|estimated delivery/i.test(subject + ' ' + snippet);
          return {
            id: msg.id,
            threadId: msg.threadId || msg.id,
            subject,
            from: parseName(fromRaw),
            fromEmail: parseEmail(fromRaw),
            when: whenFromDate(dateObj),
            snippet,
            isUnread,
            isImportant,
            isShipping,
          };
        }));

        const threads = metaResults.map(function(r) { return r.status === 'fulfilled' ? r.value : null; }).filter(Boolean);
        const shipping = threads.filter(function(t) { return t.isShipping; });
        const summary = { fetchedAt: Date.now(), threads, shipping, unreadCount: threads.filter(function(t) { return t.isUnread; }).length };
        try { localStorage.setItem('gmail_summary_v1', JSON.stringify(summary)); } catch(e) { console.warn('[Gmail] write failed', e); }
        localStorage.setItem('gmail_last_sync', String(Date.now()));

        // Push compact gmail_alerts to Supabase so push-send.js cron can surface
        // important/unread email counts in morning and reminders notifications.
        const importantUnread = threads.filter(function(t) { return t.isImportant && t.isUnread; });
        const gmailAlerts = {
          unreadCount: summary.unreadCount,
          importantCount: importantUnread.length,
          shippingCount: shipping.length,
          topImportant: importantUnread.slice(0, 3).map(function(t) { return { from: t.from, subject: t.subject, when: t.when }; }),
          updatedAt: Date.now(),
        };
        fetch('/api/db', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret || window.DASH_APP_SECRET || '' },
          body: JSON.stringify({ key: 'gmail_alerts', data: gmailAlerts }),
        }).catch(function(e) { console.warn('[Gmail] alerts push failed', e); });

        return summary;
      } catch (e) { console.warn('[Gmail] loadGmailSummary failed', e); }
    }
    window.loadGmailSummary = loadGmailSummary;

    let busy = false;
    // Timestamps of last successful coach writes this session.
    // primeCoachData() uses these to avoid overwriting local changes with stale server data.
    let _coachLastGoalsWrite = 0;
    let _coachLastMarathonWrite = 0;

    // In-memory marathon plan buffer for multi-action sequences.
    // When the coach sends replace_plan + append_entries in one reply, they execute
    // sequentially. Between calls, sync.js's 30-second applyRemote poll can overwrite
    // localStorage with a stale server snapshot (before the push propagates), causing
    // action 2 to read the wrong base. _pendingMarathonPlan holds the accumulated
    // plan in memory across all actions in one ask() invocation. It is set to null
    // after the sequential loop in ask() completes so each reply starts fresh.
    let _pendingMarathonPlan = null;

    // ── Attachment state ──────────────────────────────────────────────────────
    // pendingAttachment: { type:'image'|'text', mediaType?:string, data:string, name:string }
    let pendingAttachment = null;

    function clearAttachment() {
      pendingAttachment = null;
      const preview = document.getElementById('coachAttachPreview');
      const attachBtn = document.getElementById('coachAttach');
      const fileInput = document.getElementById('coachFileInput');
      if (preview) preview.classList.remove('show');
      if (attachBtn) attachBtn.classList.remove('has-file');
      if (fileInput) fileInput.value = '';
    }

    async function ask(text) {
      text = (text || '').trim();
      const hasAttach = !!pendingAttachment;
      if ((!text && !hasAttach) || busy) return;

      // Shortcut: any message with a redo-intent word AND a scan-target word re-runs the
      // proactive scan without sending to the AI. Bypasses the once-per-day guard.
      const RESCAN_INTENT = /\b(redo|rerun|re-?run|refresh|reset|restart|run again|again|recheck|rescan|re-?scan)\b/i;
      const RESCAN_TARGET = /\b(scan|sweep|brief(ing)?|status|proactive|morning|daily|check.?in)\b/i;
      if (RESCAN_INTENT.test(text) && RESCAN_TARGET.test(text)) {
        busy = true;
        addMsg('user', text);
        input.value = '';
        try {
          try { localStorage.removeItem(proactiveDayKey()); } catch (_) {}
          localStorage.removeItem('strava_last_sync');
          await primeCoachData();
          await runProactiveScan();
        } finally {
          busy = false;
        }
        return;
      }

      // Capture and clear attachment before any await so a second send can't reuse it
      const attachment = pendingAttachment;
      clearAttachment();

      busy = true;
      const displayText = attachment ? '[📎 ' + attachment.name + ']' + (text ? '\n' + text : '') : text;
      addMsg('user', displayText);  // persists user message
      input.value = '';

      // Detect explicit user instructions and persist them as permanent rules
      // that survive beyond the MAX_CTX window and across sessions/devices.
      // Pattern matches any message that contains an instruction directive anywhere.
      const INSTR_RE = /\b(always|never|remember that|from now on|going forward|make sure you|please always|please never|stop doing|don't |do not |i want you to|i need you to|i'd like you to|you should always|you should never|change your|keep in mind|note that|for future|in the future|every time|each time|ignore |skip |until august|until sept|until oct|until nov|until dec|until jan|until feb|until march|until april|until may|until june|until july)\b/i;
      if (INSTR_RE.test(text)) {
        try {
          if (!memArr.includes(text)) {
            memArr.push(text);
            if (memArr.length > 20) memArr.splice(0, memArr.length - 20);
            try {
              localStorage.setItem('coach_memory', JSON.stringify(memArr));
            } catch (quota) {
              pruneOldStorage();
              try { localStorage.setItem('coach_memory', JSON.stringify(memArr)); } catch (e2) {
                console.warn('[Coach] coach_memory save failed after prune', e2);
              }
            }
            // Immediately push to server so it survives localStorage clears
            const secret = window.DASH_APP_SECRET || '';
            fetch('/api/db', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
              body: JSON.stringify({ key: 'coach', data: { 'coach_memory': memArr, 'coach_chat_history': msgArr || [] } })
            }).catch(function(e) { console.warn('[Coach] memory push failed', e); });
          }
        } catch (e) { console.warn('[Coach] coach_memory save failed', e); }
      }
      const loading = addLoading();
      try {
        let reply = await callAI(DATA_SYS(), text, true, attachment);
        loading.remove();

        // ── Calendar write action: [CALENDAR_ADD:{...}] ──
        const CAL_RE = /\[CALENDAR_ADD:([\s\S]*?)\]/;
        const calMatch = reply.match(CAL_RE);
        if (calMatch) {
          reply = reply.replace(CAL_RE, '').trim();
          addGoogleCalendarEvent(JSON.parse(calMatch[1])).then(function(result) {
            if (result.ok) addMsg('coach', '📅 Added to your calendar.', false);
            else addMsg('coach', '⚠ Could not add to calendar: ' + result.error, false);
          }).catch(function(e) { addMsg('coach', '⚠ Calendar error: ' + (e.message || String(e)), false); });
        }

        // ── Module write actions: one or more [COACH_ACTION:{...}] blocks ──
        // Cannot use a simple lazy regex like /\[COACH_ACTION:([\s\S]*?)\]/ because
        // the JSON payload can contain ] characters (e.g. replace_plan's entries array).
        // Bracket-depth parsing finds the matching ] regardless of nested brackets.
        function extractCoachActions(text) {
          const PREFIX = '[COACH_ACTION:';
          const hits = [];
          let i = 0;
          while (i < text.length) {
            const s = text.indexOf(PREFIX, i);
            if (s === -1) break;
            let depth = 0, j = s, end = -1;
            while (j < text.length) {
              if (text[j] === '[') depth++;
              else if (text[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
              j++;
            }
            if (end === -1) break; // unterminated block — stop
            hits.push(text.slice(s + PREFIX.length, end));
            i = end + 1;
          }
          return hits;
        }
        function stripCoachActions(text) {
          const PREFIX = '[COACH_ACTION:';
          let out = '';
          let i = 0;
          while (i < text.length) {
            const s = text.indexOf(PREFIX, i);
            if (s === -1) { out += text.slice(i); break; }
            out += text.slice(i, s);
            let depth = 0, j = s, end = -1;
            while (j < text.length) {
              if (text[j] === '[') depth++;
              else if (text[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
              j++;
            }
            i = end === -1 ? text.length : end + 1;
          }
          return out.trim();
        }
        const actionJsons = extractCoachActions(reply);
        if (actionJsons.length) {
          reply = stripCoachActions(reply);
          // Execute actions SEQUENTIALLY (not in parallel) so each action reads the
          // localStorage state that the PREVIOUS action already wrote. Parallel execution
          // (Promise.allSettled + .map) causes all actions to read the same stale base,
          // then race to write — last write wins and earlier changes are silently lost.
          // This is especially critical for replace_plan + append_entries batches where
          // action 2 must see action 1's entries in localStorage before it appends.
          const results = [];
          _pendingMarathonPlan = null; // start each reply with a clean buffer
          for (const json of actionJsons) {
            let res;
            try {
              const trimmed = json.trim();
              let parsed;
              try {
                parsed = JSON.parse(trimmed);
              } catch (parseErr) {
                // Log raw JSON so we can diagnose AI formatting issues (unquoted keys, double-braces, etc.)
                console.warn('[Coach] COACH_ACTION parse error. Raw (first 400 chars):', JSON.stringify(trimmed.slice(0, 400)));
                // Repair attempt: AI sometimes emits JS-style objects with unquoted property names
                // e.g. {module:"marathon"} instead of {"module":"marathon"}
                const fixed = trimmed.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
                try {
                  parsed = JSON.parse(fixed);
                  console.warn('[Coach] COACH_ACTION repaired by quoting unquoted property names');
                } catch (_) {
                  throw new Error('Invalid action JSON: ' + (parseErr.message || String(parseErr)));
                }
              }
              res = await executeCoachAction(parsed);
            }
            catch (e) { res = { ok: false, error: e.message || String(e) }; }
            results.push({ status: 'fulfilled', value: res });
          }
          _pendingMarathonPlan = null; // release memory; next ask() starts fresh
          const errs = results.filter(function(r) { return r.status === 'rejected' || (r.value && !r.value.ok && !r.value.pendingConfirm); })
            .map(function(r) { return r.reason ? r.reason.message : (r.value && r.value.error) || 'unknown error'; });
          const hasPending = results.some(function(r) { return r.status === 'fulfilled' && r.value && r.value.pendingConfirm; });
          if (errs.length) {
            // Prepend error before reply so it can't be missed — AI may have said "I've done it!" above
            addMsg('coach', '🚫 ' + errs.length + (errs.length === 1 ? ' change' : ' changes') + ' could not be saved:\n• ' + errs.join('\n• ') + (reply ? '\n\n' + reply : ''), false);
          } else if (hasPending) {
            addMsg('coach', reply || 'Review the draft below.', false);
            speak(reply);
            addMsg('coach', 'Review the draft above — click Send to confirm, or Cancel to discard.', false);
          } else {
            addMsg('coach', (reply || 'Done.') + '\n\n✅ All changes saved.', false);
            speak(reply);
          }
        } else {
          addMsg('coach', reply, false);  // persists coach reply
          speak(reply);
        }
      } catch (e) {
        loading.textContent = '⚠ ' + (e.message || 'Could not reach your coach.');
      }
      busy = false;
    }

    // ===== COACH — GOOGLE CALENDAR WRITE =====
    // Creates a calendar event using stored Google OAuth tokens (google_accounts_v1).
    // Requires calendar.events scope — if the user only has readonly, this returns
    // a 403 and tells them to reconnect in calendar.html with the new scope.
    async function addGoogleCalendarEvent(opts) {
      try {
        var accounts = [];
        try { accounts = JSON.parse(localStorage.getItem('google_accounts_v1') || '[]'); } catch (_) {}
        if (!accounts.length) return { ok: false, error: 'No Google account connected — go to Calendar and connect your account first.' };
        var account = accounts[0];
        var secret = window.DASH_APP_SECRET || '';
        // Refresh token if expired (expires has <60s left)
        if (account.expires && Date.now() > account.expires - 60000) {
          try {
            var rr = await fetch('/api/integrations/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
              body: JSON.stringify({ refresh_token: account.refresh }),
            });
            var jj = await rr.json();
            if (jj.access_token) {
              account = Object.assign({}, account, { access: jj.access_token, expires: Date.now() + (jj.expires_in || 3500) * 1000 });
              accounts[0] = account;
              try { localStorage.setItem('google_accounts_v1', JSON.stringify(accounts)); } catch (_) {}
            }
          } catch (e) { console.warn('[Coach] calendar token refresh failed', e); }
        }
        var tz = (typeof Intl !== 'undefined') ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'America/New_York';
        var startDt = opts.datetime; // e.g. "2026-07-25T14:30:00"
        var durMs = (opts.durationMinutes || 60) * 60000;
        // Compute end time as local ISO string (same format as start, no Z)
        var startObj = new Date(startDt);
        var endObj = new Date(startObj.getTime() + durMs);
        function pad(n) { return String(n).padStart(2, '0'); }
        var endDt = endObj.getFullYear() + '-' + pad(endObj.getMonth()+1) + '-' + pad(endObj.getDate())
          + 'T' + pad(endObj.getHours()) + ':' + pad(endObj.getMinutes()) + ':00';
        var event = {
          summary: opts.title,
          description: opts.description || '',
          start: { dateTime: startDt, timeZone: opts.timezone || tz },
          end:   { dateTime: endDt,   timeZone: opts.timezone || tz },
          reminders: {
            useDefault: false,
            overrides: [{ method: 'popup', minutes: opts.notificationMinutes != null ? opts.notificationMinutes : 15 }],
          },
        };
        var r = await fetch('/api/integrations/google?path=/calendars/primary/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + account.access, 'X-App-Secret': secret },
          body: JSON.stringify(event),
        });
        var j = await r.json();
        if (r.ok) return { ok: true };
        if (r.status === 403) return { ok: false, error: 'Calendar write permission denied. Go to Calendar → disconnect your Google account → reconnect to grant write access.' };
        return { ok: false, error: (j && j.error && j.error.message) ? j.error.message : JSON.stringify(j).slice(0, 120) };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }
    window.addGoogleCalendarEvent = addGoogleCalendarEvent;

    // ===== COACH — GMAIL SEND WITH CONFIRMATION =====
    // Coach emits [COACH_ACTION:{module:'gmail',op:'send',...}].
    // executeCoachAction calls showGmailConfirmation() instead of sending immediately.
    // User must click "Send" to confirm — prevents accidental sends.

    function buildRawEmail(to, subject, body, replyToMsgId) {
      const lines = [
        'To: ' + to,
        'Subject: ' + subject,
        'Content-Type: text/plain; charset=UTF-8',
        'MIME-Version: 1.0',
        ...(replyToMsgId ? ['In-Reply-To: ' + replyToMsgId, 'References: ' + replyToMsgId] : []),
        '',
        body,
      ];
      const raw = lines.join('\r\n');
      // Base64url encode (RFC 4648 §5: + → -, / → _, no padding)
      const b64 = typeof btoa !== 'undefined'
        ? btoa(unescape(encodeURIComponent(raw)))
        : Buffer.from(raw).toString('base64');
      return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    async function sendGmailNow(draft, secret) {
      let accounts;
      try { accounts = JSON.parse(localStorage.getItem('google_accounts_v1') || '[]'); } catch (_) {}
      if (!accounts || !accounts.length) return { ok: false, error: 'No Google account connected.' };
      let account = accounts[0];
      if (!account.scope || !account.scope.includes('gmail.send')) {
        return { ok: false, error: 'No gmail.send permission. Go to Calendar → reconnect your Google account.' };
      }
      // Refresh if expiring
      if (account.expires && Date.now() > account.expires - 60000) {
        try {
          const rr = await fetch('/api/integrations/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
            body: JSON.stringify({ refresh_token: account.refresh }),
          });
          const jj = await rr.json();
          if (jj.access_token) {
            account = Object.assign({}, account, { access: jj.access_token, expires: Date.now() + (jj.expires_in || 3500) * 1000 });
            accounts[0] = account;
            try { localStorage.setItem('google_accounts_v1', JSON.stringify(accounts)); } catch (_) {}
          }
        } catch (e) { console.warn('[Gmail] send token refresh failed', e); }
      }
      try {
        const rawB64 = buildRawEmail(draft.to, draft.subject, draft.body, draft.replyToMsgId || null);
        const sendPath = '/users/me/messages/send' + (draft.threadId ? '?threadId=' + draft.threadId : '');
        const r = await fetch('/api/integrations/google?path=' + encodeURIComponent('/users/me/messages/send'), {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + account.access, 'Content-Type': 'application/json', 'X-App-Secret': secret },
          body: JSON.stringify({ raw: rawB64, ...(draft.threadId ? { threadId: draft.threadId } : {}) }),
        });
        const j = await r.json().catch(function() { return {}; });
        if (r.ok) return { ok: true };
        if (r.status === 403) return { ok: false, error: 'Gmail send permission denied — reconnect Google account in Calendar.' };
        return { ok: false, error: (j && j.error && j.error.message) || ('Gmail API error ' + r.status) };
      } catch (e) { return { ok: false, error: e && e.message ? e.message : String(e) }; }
    }

    function showGmailConfirmation(draft) {
      function escH(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
      const secret = window.DASH_APP_SECRET || '';
      const card = document.createElement('div');
      card.className = 'coach-msg coach';
      card.innerHTML =
        '<div class="gmail-confirm-card">' +
        '<div class="gmail-confirm-label">✉ Email draft — confirm before sending</div>' +
        '<div class="gmail-confirm-field"><b>To:</b> ' + escH(draft.to) + '</div>' +
        (draft.cc ? '<div class="gmail-confirm-field"><b>CC:</b> ' + escH(draft.cc) + '</div>' : '') +
        '<div class="gmail-confirm-field"><b>Subject:</b> ' + escH(draft.subject) + '</div>' +
        '<div class="gmail-confirm-body">' + escH(draft.body) + '</div>' +
        '<div class="gmail-confirm-actions">' +
        '<button class="gmail-btn gmail-send">📤 Send</button>' +
        '<button class="gmail-btn gmail-cancel">✕ Cancel</button>' +
        '</div></div>';
      feed.appendChild(card);
      feed.scrollTop = feed.scrollHeight;

      card.querySelector('.gmail-send').addEventListener('click', async function() {
        const btns = card.querySelectorAll('.gmail-btn');
        btns.forEach(function(b) { b.disabled = true; });
        this.textContent = '⟳ Sending…';
        const result = await sendGmailNow(draft, secret);
        if (result.ok) {
          card.querySelector('.gmail-confirm-card').innerHTML = '<div style="color:#6EE7B7;font-size:13px">📤 Email sent to ' + escH(draft.to) + '</div>';
          // Invalidate Gmail cache so next open shows the sent thread
          localStorage.removeItem('gmail_last_sync');
        } else {
          btns.forEach(function(b) { b.disabled = false; });
          card.querySelector('.gmail-send').textContent = '📤 Send';
          const errEl = document.createElement('div');
          errEl.style.cssText = 'color:#f87171;font-size:12px;margin-top:6px';
          errEl.textContent = '⚠ ' + result.error;
          card.querySelector('.gmail-confirm-actions').after(errEl);
        }
      });

      card.querySelector('.gmail-cancel').addEventListener('click', function() {
        card.querySelector('.gmail-confirm-card').innerHTML = '<div style="color:rgba(200,200,200,0.4);font-size:12px">Cancelled.</div>';
      });
    }
    window.showGmailConfirmation = showGmailConfirmation;
    window.sendGmailNow = sendGmailNow;

    // ===== COACH — MODULE WRITE ACTIONS =====
    // Executes a single structured action emitted by the coach in a [COACH_ACTION:{...}] block.
    // Writes directly to localStorage and pushes to the server so changes persist immediately.
    async function executeCoachAction(act) {
      const secret = window.DASH_APP_SECRET || '';
      try {
        // ── Marathon plan ─────────────────────────────────────────────
        if (act.module === 'marathon') {
          // Use the in-memory buffer if available (set by a previous action in this ask() call).
          // This prevents sync.js's applyRemote from corrupting the accumulated plan between
          // sequential actions — action 2 reads what action 1 wrote, not stale localStorage.
          let plan = _pendingMarathonPlan;
          if (!plan) {
            try { plan = JSON.parse(localStorage.getItem('marathon_plan_v1')); } catch (_) {}
          }
          if (!plan || typeof plan !== 'object') plan = { raceDate: null, distanceMi: 26.2188, goalSec: null, paceUnit: 'mi', entries: [] };
          if (!Array.isArray(plan.entries)) plan.entries = [];

          function mDow(dateStr) {
            const d = new Date(dateStr + 'T12:00:00');
            return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
          }

          if (act.op === 'update_entry') {
            let entry = plan.entries.find(function(e) { return e.date === act.date; });
            if (!entry) {
              entry = { id: 'm_' + Date.now(), date: act.date, weekNumber: null,
                dayOfWeek: mDow(act.date), type: 'other', label: '', plannedDistanceMi: null, completed: false };
              plan.entries.push(entry);
              plan.entries.sort(function(a,b) { return a.date.localeCompare(b.date); });
            }
            Object.assign(entry, act.set || {});

          } else if (act.op === 'move_entry') {
            // Exact match first; then ±1 day fuzzy (handles timezone off-by-one issues where
            // the coach picks a date from dashboardData that's shifted by a day).
            var entry = plan.entries.find(function(e) { return e.date === act.fromDate; });
            if (!entry) {
              var fromTs = new Date(act.fromDate + 'T12:00:00').getTime();
              entry = plan.entries.find(function(e) {
                return Math.abs(new Date(e.date + 'T12:00:00').getTime() - fromTs) <= 86400000;
              });
            }
            if (entry) {
              // Remove from old date position, place at toDate
              plan.entries = plan.entries.filter(function(e) { return e !== entry; });
              entry.date = act.toDate; entry.dayOfWeek = mDow(act.toDate);
              // Carry over any override fields the coach supplied (type, label, distance)
              if (act.type) entry.type = act.type;
              if (act.label) entry.label = act.label;
              if (act.plannedDistanceMi != null) entry.plannedDistanceMi = act.plannedDistanceMi;
              plan.entries.push(entry);
            } else if (act.type || act.label) {
              // No source entry found but coach supplied enough info to create one at toDate
              plan.entries.push({ id: 'm_' + Date.now(), date: act.toDate, weekNumber: act.weekNumber || null,
                dayOfWeek: mDow(act.toDate), type: act.type || 'other', label: act.label || '',
                plannedDistanceMi: act.plannedDistanceMi || null, completed: false });
            } else {
              // No source entry found — create a placeholder at toDate so the intent
              // is honored even when the plan doesn't have the exact fromDate yet.
              // Coach can immediately update it if type/label is missing.
              plan.entries.push({ id: 'm_' + Date.now(), date: act.toDate, weekNumber: act.weekNumber || null,
                dayOfWeek: mDow(act.toDate), type: act.type || 'other',
                label: act.label || (act.type ? act.type.charAt(0).toUpperCase() + act.type.slice(1) + ' run' : 'Run'),
                plannedDistanceMi: act.plannedDistanceMi || null, completed: false });
            }
            plan.entries.sort(function(a,b) { return a.date.localeCompare(b.date); });

          } else if (act.op === 'add_entry') {
            plan.entries.push({ id: 'm_' + Date.now(), date: act.date, weekNumber: act.weekNumber || null,
              dayOfWeek: mDow(act.date), type: act.type || 'other', label: act.label || '',
              plannedDistanceMi: act.plannedDistanceMi || null, completed: false });
            plan.entries.sort(function(a,b) { return a.date.localeCompare(b.date); });

          } else if (act.op === 'remove_entry') {
            plan.entries = plan.entries.filter(function(e) { return e.date !== act.date; });

          } else if (act.op === 'set_race') {
            if (act.raceDate) plan.raceDate = act.raceDate;
            if (act.goalSec != null) plan.goalSec = act.goalSec;

          } else if (act.op === 'replace_plan') {
            // Atomically replaces all entries with a fresh set — use when generating
            // a new training plan from scratch so old entries don't persist alongside new ones.
            if (!Array.isArray(act.entries)) return { ok: false, error: 'replace_plan requires an entries array' };
            plan.entries = act.entries.map(function(e, idx) {
              return { id: 'm_' + (Date.now() + idx), date: e.date, weekNumber: e.weekNumber || null,
                dayOfWeek: mDow(e.date), type: e.type || 'other', label: e.label || '',
                plannedDistanceMi: e.plannedDistanceMi || null, notes: e.notes || null, completed: false };
            });
            plan.entries.sort(function(a, b) { return a.date.localeCompare(b.date); });
            if (act.raceDate) plan.raceDate = act.raceDate;
            if (act.goalSec != null) plan.goalSec = act.goalSec;

          } else if (act.op === 'append_entries') {
            // Additive batch: adds multiple entries without clearing existing ones.
            // Use this for subsequent batches after replace_plan when the full plan
            // is too large to fit in a single AI reply without truncation.
            if (!Array.isArray(act.entries)) return { ok: false, error: 'append_entries requires an entries array' };
            act.entries.forEach(function(e, idx) {
              plan.entries.push({ id: 'm_' + (Date.now() + idx), date: e.date, weekNumber: e.weekNumber || null,
                dayOfWeek: mDow(e.date), type: e.type || 'other', label: e.label || '',
                plannedDistanceMi: e.plannedDistanceMi || null, notes: e.notes || null, completed: false });
            });
            plan.entries.sort(function(a, b) { return a.date.localeCompare(b.date); });

          } else {
            return { ok: false, error: 'Unknown marathon op: ' + act.op };
          }

          // Stamp updatedAt so marathon.html's onApplied can reject a stale server snapshot
          plan.updatedAt = Date.now();
          try { localStorage.setItem('marathon_plan_v1', JSON.stringify(plan)); } catch (e) { console.warn('[Coach] marathon write failed', e); }
          // Keep the in-memory buffer in sync so subsequent actions in this ask() call
          // read the accumulated plan (not stale localStorage from an applyRemote poll).
          _pendingMarathonPlan = plan;
          // Set session guard immediately after localStorage write — BEFORE the push await.
          // primeCoachData() may return concurrent server data while the push is in-flight;
          // setting this now ensures the guard is active for any concurrent primeCoachData forEach.
          _coachLastMarathonWrite = Date.now();
          const marathonPushBody = JSON.stringify({ key: 'marathon', data: { 'marathon_plan_v1': plan } });
          const marathonPushOpts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret }, body: marathonPushBody };
          let mRes;
          try {
            mRes = await fetch('/api/db', marathonPushOpts);
          } catch (e) {
            console.warn('[Coach] marathon push failed, retrying', e);
            try { await new Promise(function(r) { setTimeout(r, 1500); }); mRes = await fetch('/api/db', marathonPushOpts); }
            catch (e2) { return { ok: false, error: 'Network error — plan updated locally but did not reach the server. Try again.' }; }
          }
          if (!mRes || !mRes.ok) {
            return { ok: false, error: 'Server error (' + (mRes ? mRes.status : '?') + ') saving marathon plan. Changes are local only — try again.' };
          }
          // Notify marathon.html (if open in same window) to re-render immediately
          // rather than waiting for the next 30-second sync poll.
          try { window.dispatchEvent(new CustomEvent('coach:marathon:updated', { detail: { updatedAt: plan.updatedAt } })); } catch (_) {}
          return { ok: true };
        }

        // ── Goals ─────────────────────────────────────────────────────
        if (act.module === 'goals') {
          function todayForGoals() {
            const d = new Date(); if (d.getHours() < 6) d.setDate(d.getDate() - 1);
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          }
          const dateStr = act.date || todayForGoals();
          const key = 'goals:' + dateStr;
          let goals = [];
          try { goals = JSON.parse(localStorage.getItem(key) || '[]'); if (!Array.isArray(goals)) goals = []; } catch (_) {}

          if (act.op === 'add') {
            goals.push({ id: 'g_' + Date.now(), text: act.text, done: false, createdAt: Date.now() });
          } else if (act.op === 'complete') {
            var g = goals.find(function(g) { return g.text === act.text || g.id === act.id; });
            if (!g) return { ok: false, error: 'Goal "' + act.text + '" not found for ' + dateStr };
            g.done = true;
          } else if (act.op === 'remove') {
            var before = goals.length;
            goals = goals.filter(function(g) { return g.text !== act.text && g.id !== act.id; });
            if (goals.length === before) return { ok: false, error: 'Goal "' + act.text + '" not found for ' + dateStr };
          } else if (act.op === 'update') {
            var gu = goals.find(function(g) { return g.id === act.id || g.text === act.oldText; });
            if (!gu) return { ok: false, error: 'Goal not found for ' + dateStr };
            if (act.newText) gu.text = act.newText; if (act.done !== undefined) gu.done = act.done;
          } else if (act.op === 'snooze') {
            // Find by exact text/id, then fall back to case-insensitive substring match
            // so "ignore math 223" matches "MATH 223 homework assignment"
            var gs = goals.find(function(g) { return g.text === act.text || g.id === act.id; });
            if (!gs && act.text) {
              var needle = act.text.toLowerCase();
              gs = goals.find(function(g) { return g.text && g.text.toLowerCase().includes(needle); });
            }
            if (!gs) return { ok: false, error: 'Goal matching "' + act.text + '" not found for ' + dateStr };
            gs.snoozedUntil = act.until || '2099-01-01';
          } else if (act.op === 'unsnooze') {
            var gus = goals.find(function(g) { return g.text === act.text || g.id === act.id; });
            if (!gus && act.text) {
              var nueedle = act.text.toLowerCase();
              gus = goals.find(function(g) { return g.text && g.text.toLowerCase().includes(nueedle); });
            }
            if (gus) delete gus.snoozedUntil;
          } else {
            return { ok: false, error: 'Unknown goals op: ' + act.op };
          }

          try { localStorage.setItem(key, JSON.stringify(goals)); } catch (e) { console.warn('[Coach] goals write failed', e); }
          // Push the COMPLETE goals snapshot so the server row is never partially overwritten.
          // Sending only { [key]: goals } would replace the entire goals row with one date key,
          // and the next applyRemote on any page would delete all other goal dates.
          const allGoalsData = {};
          for (let gi = 0; gi < localStorage.length; gi++) {
            const gk = localStorage.key(gi);
            if (gk && gk.startsWith('goals:')) {
              try { allGoalsData[gk] = JSON.parse(localStorage.getItem(gk) || '[]'); } catch (_) { allGoalsData[gk] = []; }
            }
          }
          const goalsPushBody = JSON.stringify({ key: 'goals', data: allGoalsData });
          const goalsPushOpts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret }, body: goalsPushBody };
          // Set session guard before await so concurrent primeCoachData can't overwrite mid-push
          _coachLastGoalsWrite = Date.now();
          let gRes;
          try {
            gRes = await fetch('/api/db', goalsPushOpts);
          } catch (e) {
            console.warn('[Coach] goals push failed, retrying', e);
            try { await new Promise(function(r) { setTimeout(r, 1500); }); gRes = await fetch('/api/db', goalsPushOpts); }
            catch (e2) { return { ok: false, error: 'Network error — goal updated locally but did not reach the server. Try again.' }; }
          }
          if (!gRes || !gRes.ok) {
            return { ok: false, error: 'Server error (' + (gRes ? gRes.status : '?') + ') saving goals. Changes are local only — try again.' };
          }
          return { ok: true };
        }

        // ── Calendar ──────────────────────────────────────────────
        if (act.module === 'calendar') {
          if (act.op === 'add_event') {
            return addGoogleCalendarEvent({
              title: act.title,
              datetime: act.datetime,
              durationMinutes: act.durationMinutes || 60,
              notificationMinutes: act.notificationMinutes !== undefined ? act.notificationMinutes : 15,
            });
          }
          return { ok: false, error: 'Unknown calendar op: ' + act.op };
        }

        // ── Water / hydration ─────────────────────────────────────
        if (act.module === 'water') {
          function todayWater() {
            const d = new Date(); if (d.getHours() < 6) d.setDate(d.getDate() - 1);
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
          }
          let water = {};
          try { water = JSON.parse(localStorage.getItem('po_water_v1') || '{}'); } catch (_) {}
          if (!water.logs) water.logs = {};
          const waterDate = act.date || todayWater();
          if (act.op === 'set') {
            water.logs[waterDate] = Math.max(0, Number(act.bottles) || 0);
          } else if (act.op === 'add') {
            water.logs[waterDate] = (water.logs[waterDate] || 0) + (Number(act.bottles) || 1);
          } else {
            return { ok: false, error: 'Unknown water op: ' + act.op };
          }
          try { localStorage.setItem('po_water_v1', JSON.stringify(water)); } catch (e) { console.warn('[Coach] water write failed', e); }
          let wRes;
          try { wRes = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret }, body: JSON.stringify({ key: 'profile', data: { po_water_v1: water } }) }); }
          catch (e) { console.warn('[Coach] water push failed', e); return { ok: false, error: 'Network error saving hydration — updated locally, try again.' }; }
          if (!wRes || !wRes.ok) return { ok: false, error: 'Server error (' + (wRes ? wRes.status : '?') + ') saving hydration.' };
          return { ok: true };
        }

        // ── Gmail ────────────────────────────────────────────────
        if (act.module === 'gmail') {
          if (act.op === 'send') {
            if (!act.to || !act.subject || !act.body) return { ok: false, error: 'Gmail send requires: to, subject, body' };
            // Show confirmation card — do NOT send yet. User must click "Send".
            showGmailConfirmation({ to: act.to, subject: act.subject, body: act.body, cc: act.cc || null, threadId: act.threadId || null });
            return { ok: true, pendingConfirm: true };
          }
          return { ok: false, error: 'Unknown gmail op: ' + act.op };
        }

        return { ok: false, error: 'Unknown module: ' + act.module };
      } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    }

    // ===== COACH — PROACTIVE SCAN (once-per-day briefing) =====
    async function runProactiveScan() {
      if (window.isConservationMode && window.isConservationMode()) {
        addMsg('coach', 'Conservation mode is on, so I skipped the automatic scan — ask me anything directly instead.', true);
        return;
      }
      const loading = addLoading();
      try {
        const text = await callAI(PROACTIVE_SYS() + JSON.stringify(dashboardData()), 'Scan everything and tell me what is most worth knowing right now.', false);
        loading.remove();
        // Set the proactive key BEFORE addMsg so the daily gate is locked even if
        // chat history save fails (full localStorage). Retry once on quota.
        let savedKey = false;
        try { localStorage.setItem(proactiveDayKey(), '1'); savedKey = true; } catch (_) {}
        if (!savedKey) { pruneOldStorage(); try { localStorage.setItem(proactiveDayKey(), '1'); } catch (e) { console.warn('[Coach] proactive key save failed', e); } }
        addMsg('coach', text, true);  // persists to chat history
        // Prune old day keys to avoid localStorage bloat
        try {
          const todayKey = proactiveDayKey();
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('coach_proactive_') && k !== todayKey) localStorage.removeItem(k);
          }
        } catch (e) { console.warn('[Coach] proactive key pruning failed', e); }
        speak(text);
      } catch (e) {
        loading.remove();
        addMsg('coach', '⚠ Status scan failed — ' + (e.message || 'network error') + '. You can ask me directly.', true, false);
      }
    }

    let historyLoaded = false;

    function openPanel() {
      panelBg.classList.add('show');
      fab.classList.remove('has-insight');
      // History loading is once-per-session (avoids redundant DOM rebuilds).
      if (!historyLoaded) {
        historyLoaded = true;
        loadChatHistory();
      }
      // Proactive scan runs once per day — on the first panel open after the key is absent.
      if (!localStorage.getItem(proactiveDayKey())) {
        // Force-refresh Strava before the daily scan so it always has today's run data.
        localStorage.removeItem('strava_last_sync');
        primeCoachData().then(function() { runProactiveScan(); });
      } else {
        primeCoachData(); // still refresh data even when no scan needed
      }
      setTimeout(() => input.focus(), 80);
    }
    function closePanel() {
      panelBg.classList.remove('show');
      if (_voiceEl) { _voiceEl.pause(); _voiceEl.src = ''; }
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    }

    fab.addEventListener('click', openPanel);
    document.getElementById('coachClose').addEventListener('click', closePanel);
    panelBg.addEventListener('click', (e) => { if (e.target === panelBg) closePanel(); });

    // Show the insight dot if today's scan hasn't run yet
    if (!localStorage.getItem(proactiveDayKey())) fab.classList.add('has-insight');

    // ===== COACH — VOICE =====
    // Pre-unlock an HTMLAudioElement during a user gesture so it can be reused
    // for TTS later — even after async gaps. iOS Safari blocks AudioContext.resume()
    // when called outside a gesture, but a pre-played Audio element stays unlocked.
    let _voiceEl = null;
    function unlockAudio() {
      if (_voiceEl) return;
      try {
        _voiceEl = new Audio();
        // Minimal silent WAV (44 bytes) — just enough to unlock the element on iOS.
        _voiceEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        _voiceEl.volume = 0;
        _voiceEl.play().then(() => { _voiceEl.pause(); _voiceEl.volume = 1; }).catch(() => {});
      } catch (_) {}
    }

    document.getElementById('coachRescan').addEventListener('click', async function() {
      if (busy) return;
      busy = true;
      try {
        try { localStorage.removeItem(proactiveDayKey()); } catch (_) {}
        localStorage.removeItem('strava_last_sync');
        await primeCoachData();
        await runProactiveScan();
      } finally {
        busy = false;
      }
    });

    let voiceOn = false;
    const voiceToggle = document.getElementById('coachVoiceToggle');
    try { voiceOn = localStorage.getItem('coach_voice_on') === '1'; } catch (e) { console.warn('[Coach] voice_on read failed', e); }
    voiceToggle.classList.toggle('on', voiceOn);
    voiceToggle.addEventListener('click', () => {
      unlockAudio();
      voiceOn = !voiceOn;
      voiceToggle.classList.toggle('on', voiceOn);
      try { localStorage.setItem('coach_voice_on', voiceOn ? '1' : '0'); } catch (e) { console.warn('[Coach] voice_on save failed', e); }
      if (voiceOn) {
        // Speak the most recent coach message so the user gets immediate audio feedback.
        const lastCoachMsg = [...feed.querySelectorAll('.coach-msg.coach')].pop();
        if (lastCoachMsg) speak(lastCoachMsg.textContent);
      } else {
        if (_voiceEl) { _voiceEl.pause(); _voiceEl.src = ''; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();
      }
    });

    fab.addEventListener('click', unlockAudio);
    document.getElementById('coachSend').addEventListener('click', () => { unlockAudio(); ask(input.value); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { unlockAudio(); ask(input.value); } });

    // ── File attachment wiring ────────────────────────────────────────────────
    const attachBtn = document.getElementById('coachAttach');
    const fileInput = document.getElementById('coachFileInput');
    const attachPreview = document.getElementById('coachAttachPreview');
    const attachThumb = document.getElementById('coachAttachThumb');
    const attachName = document.getElementById('coachAttachName');
    const attachRemove = document.getElementById('coachAttachRemove');

    attachBtn.addEventListener('click', () => fileInput.click());
    attachRemove.addEventListener('click', clearAttachment);

    fileInput.addEventListener('change', function() {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      const MAX_IMAGE = 5 * 1024 * 1024;  // 5 MB
      const MAX_TEXT  = 500 * 1024;       // 500 KB
      const isImage = file.type.startsWith('image/');

      if (isImage && file.size > MAX_IMAGE) {
        addMsg('coach', '⚠ Image too large — max 5 MB.', false);
        fileInput.value = '';
        return;
      }
      if (!isImage && file.size > MAX_TEXT) {
        addMsg('coach', '⚠ File too large — max 500 KB for text files.', false);
        fileInput.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = function(ev) {
        if (isImage) {
          // Strip the data:image/xxx;base64, prefix — Claude needs just the base64
          const dataUrl = ev.target.result;
          const comma = dataUrl.indexOf(',');
          const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
          pendingAttachment = { type: 'image', mediaType: file.type, data: b64, name: file.name };
          attachThumb.src = dataUrl;
          attachThumb.style.display = '';
        } else {
          pendingAttachment = { type: 'text', data: ev.target.result, name: file.name };
          attachThumb.style.display = 'none';
        }
        attachName.textContent = file.name;
        attachPreview.classList.add('show');
        attachBtn.classList.add('has-file');
        input.focus();
      };
      reader.onerror = function() {
        addMsg('coach', '⚠ Could not read file — try again.', false);
        fileInput.value = '';
      };
      if (isImage) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
    function speak(text) {
      if (!voiceOn || !text) return;
      const clean = text.replace(/\*\*/g, '').replace(/^[-•*]\s+/gm, '').trim();
      if (!clean) return;
      if (window.DASH_ELEVENLABS_ENABLED) {
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        fetch('/api/elevenlabs-tts', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-app-secret': (window.DASH_APP_SECRET || '') },
          body: JSON.stringify({ text: clean }),
        }).then(r => {
          if (!r.ok) return r.json().catch(() => ({})).then(b => { throw new Error(b.error || ('ElevenLabs ' + r.status)); });
          return r.arrayBuffer();
        }).then(buf => {
          if (!buf || !voiceOn) return;
          const blob = new Blob([buf], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          const cleanup = () => URL.revokeObjectURL(url);
          const onPlayErr = (err) => {
            cleanup();
            console.warn('[coach voice]', err.message);
            addMsg('coach', '⚠ Voice error: ' + err.message + ' — check browser volume and permissions.', false);
          };
          if (_voiceEl) {
            // Reuse the pre-unlocked element — changing src on an already-played
            // Audio element bypasses iOS autoplay restrictions entirely.
            _voiceEl.pause();
            _voiceEl.src = url;
            _voiceEl.volume = 1;
            _voiceEl.onended = cleanup;
            _voiceEl.play().catch(onPlayErr);
          } else {
            // Fallback: no gesture was captured before speak() was called.
            const a = new Audio(url);
            a.onended = cleanup;
            a.play().catch(onPlayErr);
          }
        }).catch(err => {
          console.warn('[coach voice]', err.message);
          addMsg('coach', '⚠ Voice error: ' + err.message, false);
        });
        return;
      }
      if (!window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean);
      u.rate = 0.95;
      u.pitch = 0.85;
      u.lang = 'en-GB';
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.lang === 'en-GB' && /male|daniel|george|oliver|arthur/i.test(v.name))
                     || voices.find(v => v.lang === 'en-GB')
                     || voices.find(v => /daniel|george/i.test(v.name));
      if (preferred) u.voice = preferred;
      window.speechSynthesis.speak(u);
    }

    const micBtn = document.getElementById('coachMic');
    // Whisper (OpenAI) transcription via MediaRecorder is significantly more
    // accurate than the browser's SpeechRecognition and also works on iOS
    // (which doesn't support SpeechRecognition at all). We prefer it when
    // OPENAI_API_KEY is configured, fall back to SpeechRecognition otherwise.
    if (window.DASH_OPENAI_ENABLED && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      let recorder = null, chunks = [];
      micBtn.addEventListener('click', async () => {
        if (recorder && recorder.state === 'recording') {
          recorder.stop(); return;
        }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          chunks = [];
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
          recorder.onstop = async () => {
            micBtn.classList.remove('listening');
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            const reader = new FileReader();
            reader.onload = async () => {
              const base64 = reader.result.split(',')[1];
              micBtn.textContent = '⟳'; // transcribing indicator
              try {
                const res = await fetch('/api/whisper-transcribe', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', 'x-app-secret': (window.DASH_APP_SECRET || '') },
                  body: JSON.stringify({ audio: base64, mimeType: blob.type }),
                });
                const json = await res.json();
                if (json.text) { input.value = json.text; input.focus(); }
              } catch (e) {}
              micBtn.textContent = '🎙️';
            };
            reader.readAsDataURL(blob);
          };
          recorder.start();
          micBtn.classList.add('listening');
        } catch (e) { micBtn.classList.remove('listening'); }
      });
    } else {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        micBtn.style.display = 'none';
      } else {
        const recognizer = new SR();
        recognizer.lang = 'en-US'; recognizer.interimResults = false; recognizer.maxAlternatives = 1;
        let listening = false;
        recognizer.onresult = (e) => { const said = e.results && e.results[0] && e.results[0][0] && e.results[0][0].transcript; if (said) input.value = said; };
        recognizer.onend = () => { listening = false; micBtn.classList.remove('listening'); };
        recognizer.onerror = () => { listening = false; micBtn.classList.remove('listening'); };
        micBtn.addEventListener('click', () => {
          if (listening) { recognizer.stop(); return; }
          listening = true; micBtn.classList.add('listening');
          try { recognizer.start(); } catch (e) { listening = false; micBtn.classList.remove('listening'); }
        });
      }
    }

    // Sync coach conversation history to the cloud so it survives cache clears
    // and cross-device opens. coach_proactive_* keys are intentionally NOT synced —
    // they are ephemeral per-day flags that must be local-only so that:
    //   a) a fresh session always re-runs the scan with the current prompt code, and
    //   b) build upgrades that fix the scan can take effect the same day.
    //
    // onApplied is intentionally a no-op. applyRemote() could fire at ANY time
    // (30 s poll or slow init fetch) and overwrites localStorage with server state.
    // If we then cleared feed.innerHTML, any message the user was typing or had just
    // sent would vanish — the feed wipe was exactly what caused "deleting
    // conversations as I enter a question". The init() pre-populates localStorage
    // before the user can open the panel, so history is always current on open.
    if (window.initCloudSync) {
      window.initCloudSync({
        appKey: 'coach',
        syncedKeys: ['coach_chat_history', 'coach_memory'],
        onApplied: function() {
          // ── Merge coach_memory: union of server + local, never drop either side ──
          // applyRemote overwrote coach_memory with whatever the server had, but
          // the user may have added new instructions locally since the last push.
          // We union both sets (dedup by text) and write back + push.
          try {
            const serverMem = JSON.parse(localStorage.getItem('coach_memory') || '[]');
            const localMem = memArr || [];
            if (localMem.length > 0) {
              const serverSet = new Set(serverMem.map(function(x) { return x; }));
              const merged = serverMem.slice();
              localMem.forEach(function(x) { if (!serverSet.has(x)) merged.push(x); });
              if (merged.length !== serverMem.length) {
                // Local had entries the server didn't — push the merged set
                memArr = merged.slice(-20);
                try { localStorage.setItem('coach_memory', JSON.stringify(memArr)); } catch (_) {}
                const secret = window.DASH_APP_SECRET || '';
                fetch('/api/db', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
                  body: JSON.stringify({ key: 'coach', data: { 'coach_memory': memArr, 'coach_chat_history': msgArr || [] } })
                }).catch(function(e) { console.warn('[Coach] onApplied memory push failed', e); });
              } else {
                memArr = serverMem;
              }
            } else {
              memArr = serverMem;
            }
          } catch (e) { console.warn('[Coach] onApplied memory merge failed', e); }

          // ── Merge chat history: local wins if ahead ──
          if (msgArr !== null) {
            // applyRemote just overwrote localStorage with the server snapshot.
            // Compare lengths to decide who is ahead.
            let serverArr = [];
            try { serverArr = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) {}

            if (msgArr.length > serverArr.length) {
              // We have local messages the server doesn't know about yet.
              // Restore in-memory state and push so the server catches up.
              try { localStorage.setItem(HIST_KEY, JSON.stringify(msgArr)); } catch (e) { console.warn('[Coach] onApplied HIST_KEY restore failed', e); }
              const secret = window.DASH_APP_SECRET || '';
              fetch('/api/db', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-App-Secret': secret },
                body: JSON.stringify({ key: 'coach', data: { 'coach_chat_history': msgArr, 'coach_memory': memArr || [] } })
              }).catch(function(e) { console.warn('[Coach] onApplied restore push failed', e); });
            } else if (serverArr.length > msgArr.length) {
              // Server has more messages (another device added history).
              // Adopt server state so we stay in sync.
              msgArr = serverArr;
            }
            // Equal length: no conflict, nothing to do.
          } else if (historyLoaded && feed.children.length === 0) {
            // Panel opened before server data arrived — load from what applyRemote wrote.
            loadChatHistory();
          }
        }
      });
    }

    // Clear today's proactive scan flag whenever the prompt build version changes.
    // This ensures bug fixes to the scan (e.g. strava date wording) take effect
    // the same day rather than waiting until midnight for a new proactive key.
    //
    // IMPORTANT: pruneOldStorage() runs first to free space before the setItem.
    // If coach_prompt_build fails to save (quota), the version check fires on every
    // page load → proactiveDayKey() is deleted → scan re-runs infinitely.
    pruneOldStorage();
    const COACH_PROMPT_BUILD = '2026-07-27-v4';
    if (localStorage.getItem('coach_prompt_build') !== COACH_PROMPT_BUILD) {
      try { localStorage.removeItem(proactiveDayKey()); } catch (e) { console.warn('[Coach] proactive key remove failed', e); }
      // Retry once on quota — pruneOldStorage() should have freed space above,
      // but retry guards against edge cases where prune couldn't free enough.
      let savedBuild = false;
      try { localStorage.setItem('coach_prompt_build', COACH_PROMPT_BUILD); savedBuild = true; } catch (_) {}
      if (!savedBuild) {
        pruneOldStorage();
        try { localStorage.setItem('coach_prompt_build', COACH_PROMPT_BUILD); } catch (e) { console.warn('[Coach] coach_prompt_build save failed after prune', e); }
      }
    }
  }

  // ===== BOOT — GOAL ROLLOVER + INIT =====
  // Roll undone goals from past days into today on every page load,
  // not just when main.html is open. Mirrors the rollover() logic in main.html.
  function rolloverGoals() {
    try {
      const now = new Date();
      // Before 6 AM still counts as "yesterday" (same as main.html logic).
      const ref = new Date(now);
      if (now.getHours() < 6) ref.setDate(ref.getDate() - 1);
      const todayStr = ref.getFullYear() + '-' + String(ref.getMonth() + 1).padStart(2, '0') + '-' + String(ref.getDate()).padStart(2, '0');
      const todayK = 'goals:' + todayStr;

      // Collect all past goal keys first (safe to delete after).
      const pastKeys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('goals:') && k.slice('goals:'.length) < todayStr) pastKeys.push(k);
      }
      if (!pastKeys.length) return;

      let todayGoals;
      try { todayGoals = JSON.parse(localStorage.getItem(todayK)) || []; } catch { todayGoals = []; }
      if (!Array.isArray(todayGoals)) todayGoals = [];
      const seen = new Set(todayGoals.map(g => g.text));

      let changed = false;
      pastKeys.forEach(k => {
        let old;
        try { old = JSON.parse(localStorage.getItem(k)) || []; } catch { old = []; }
        if (!Array.isArray(old)) { localStorage.removeItem(k); return; }
        // Archive this day to history before deleting it (upsert so a second
        // rollover run after sync always reflects the latest server state).
        if (old.length) {
          try {
            const dateStr = k.slice('goals:'.length);
            let hist; try { hist = JSON.parse(localStorage.getItem('goals_history_v1')) || []; } catch { hist = []; }
            if (!Array.isArray(hist)) hist = [];
            const hIdx = hist.findIndex(h => h.date === dateStr);
            if (hIdx !== -1) {
              hist[hIdx] = { date: dateStr, goals: old };
            } else {
              hist.unshift({ date: dateStr, goals: old });
              if (hist.length > 90) hist.length = 90;
            }
            localStorage.setItem('goals_history_v1', JSON.stringify(hist));
          } catch {}
        }
        old.forEach(g => {
          if (g && !g.done && g.text && !seen.has(g.text)) {
            todayGoals.push({ text: g.text, done: false });
            seen.add(g.text);
            changed = true;
          }
        });
        localStorage.removeItem(k);
      });
      if (changed) localStorage.setItem(todayK, JSON.stringify(todayGoals));
    } catch {}
  }

  function boot() {
    if (window.pruneOldStorage) window.pruneOldStorage(); // clean accumulated ephemeral keys on every load
    rolloverGoals();
    injectStyleAndHTML();
    const btn = document.getElementById('topbarWaterAdd');
    if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); addWater(); });
    render();
    lockGestures();
    startModalLock();

    // Re-render when localStorage changes from another tab/window OR when
    // the page becomes visible (sync may have pulled in the background).
    window.addEventListener('storage', render);
    window.addEventListener('focus', render);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

    // Periodic refresh so counts stay current after midnight rollover etc.
    setInterval(render, 30 * 1000);

    // ---- Push-notification registration (silently, no permission prompt
    // unless the user has already granted Notification permission) ----
    // Only runs once per page session, only when the VAPID public key is
    // configured. Doesn't ask for permission itself — permission prompts are
    // triggered by an explicit user action (a "Enable notifications" button
    // in the settings panel), which stores the user's choice separately.
    // Here we just register the service worker unconditionally (needed for
    // offline-support basics too) and subscribe to push if permission is
    // already 'granted', or if the user just granted it.
    if ('serviceWorker' in navigator) {
      // Register the SW unconditionally (needed for offline basics too).
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
      // Use .ready (not the register promise) so subscribe() runs only once
      // a service worker is actually active — register() resolves while the
      // SW may still be in 'installing' state, which causes subscribe() to
      // fail silently and leaves Supabase with no subscription on record.
      navigator.serviceWorker.ready.then((reg) => {
        const vapidPublicKey = window.DASH_VAPID_PUBLIC_KEY;
        if (!vapidPublicKey || Notification.permission !== 'granted') return;
        // Always call subscribe() so an expired subscription is auto-replaced.
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }).then(sub => savePushSub(sub)).catch(() => {});
      }).catch(() => {});
    }

    function savePushSub(sub) {
      fetch('/api/push-subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-secret': (window.DASH_APP_SECRET || '') },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      }).catch(() => {});
    }
  }

  // ---- Expose helper for requesting push permission (used by settings panel) ----
  // Apply the saved theme immediately — runs BEFORE paint so there's no
  // flash of the wrong theme. Setting data-theme on <html> lets the CSS
  // rules injected above cascade to every element on the page.
  function applyTheme() {
    try {
      const t = localStorage.getItem('settings:theme') || 'default';
      if (t && t !== 'default') document.documentElement.setAttribute('data-theme', t);
      else document.documentElement.removeAttribute('data-theme');
    } catch (e) { console.warn('[Topbar] applyTheme failed', e); }
  }
  applyTheme();
  window.applyTheme = applyTheme; // expose so settings.html can call it live

  // Returns the Claude model string the user has chosen in Settings.
  // Pages pass this to the server so responses use the right tier.
  // Falls back to Opus (the current default) if nothing is saved.
  window.getPreferredModel = function () {
    try { return localStorage.getItem('settings:model') || 'claude-opus-4-8'; } catch (e) { return 'claude-opus-4-8'; }
  };

  // Conservation mode reduces AI spend by skipping background-initiated
  // calls (proactive scans, auto-classifications) and capping response length.
  window.isConservationMode = function () {
    try { return localStorage.getItem('settings:conservation_mode') === '1'; } catch (e) { return false; }
  };

  // Converts a VAPID base64url public key string to the Uint8Array format
  // required by pushManager.subscribe(). Without this, some browsers (older
  // Chrome, Safari) silently reject the subscription with a DOMException.
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function getDeviceId() {
    let id = localStorage.getItem('dash_device_id');
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : (Math.random().toString(36).slice(2) + Date.now().toString(36));
      localStorage.setItem('dash_device_id', id);
    }
    return id;
  }

  // Saves subscription to Supabase, tagged with a stable per-device ID.
  // push-subscribe deduplicates by deviceId so re-subscribing replaces the
  // old endpoint instead of adding a ghost entry for the same device.
  function saveSub(sub) {
    return fetch('/api/push-subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-secret': (window.DASH_APP_SECRET || '') },
      body: JSON.stringify({ subscription: sub.toJSON(), deviceId: getDeviceId() }),
    }).then((r) => {
      if (!r.ok) return r.json().catch(() => ({})).then(e => { throw new Error('subscribe API ' + r.status + (e && e.error ? ': ' + e.error : '')); });
      return r.json();
    });
  }

  window.ensurePushSubscription = function () {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return Promise.reject(new Error('Push not supported.'));
    }
    const vapidPublicKey = window.DASH_VAPID_PUBLIC_KEY;
    if (!vapidPublicKey) return Promise.reject(new Error('VAPID key not configured.'));
    if (Notification.permission !== 'granted') return Promise.reject(new Error('Permission not granted.'));
    return navigator.serviceWorker.ready.then((reg) => {
      return reg.pushManager.getSubscription().then((existing) => {
        if (existing) return saveSub(existing);
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) })
          .then(saveSub);
      });
    });
  };

  window.requestPushPermission = function () {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return Promise.reject(new Error('Push notifications not supported in this browser.'));
    }
    const vapidPublicKey = window.DASH_VAPID_PUBLIC_KEY;
    if (!vapidPublicKey) {
      return Promise.reject(new Error('VAPID_PUBLIC_KEY not configured in Vercel env vars yet.'));
    }
    return Notification.requestPermission().then((permission) => {
      if (permission !== 'granted') throw new Error('Permission denied.');
      return navigator.serviceWorker.ready;
    }).then((reg) => {
      // Always unsubscribe first so we get a guaranteed-fresh endpoint.
      // getSubscription() can return a stale object whose endpoint has
      // already been invalidated by the push service (410 Gone) — re-saving
      // that dead endpoint causes silent send failures. A fresh subscribe()
      // always returns a live endpoint from the push service.
      return reg.pushManager.getSubscription()
        .then(existing => existing ? existing.unsubscribe().catch(() => {}) : Promise.resolve())
        .then(() => reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        }));
    }).then(saveSub);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
