import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { greetingFor, readAppearance, statusFor } from '../command-center.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = readFileSync(path.join(root, 'command-center.css'), 'utf8');

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ---- readAppearance: defaults match the design reference itself ----
global.localStorage = {
  store: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  clear() { this.store = {}; },
};

global.localStorage.clear();
assertEq(readAppearance(), { tone: 'callsign', consoleStyle: 'terminal', railContent: 'schedule_signals' }, 'with nothing saved, appearance defaults match the design reference (callsign + terminal)');

global.localStorage.setItem('cc_appearance_v1', JSON.stringify({ tone: 'friendly', consoleStyle: 'cards', railContent: 'alerts_activity' }));
assertEq(readAppearance(), { tone: 'friendly', consoleStyle: 'cards', railContent: 'alerts_activity' }, 'a saved preference is read back as-is');

global.localStorage.setItem('cc_appearance_v1', JSON.stringify({ tone: 'not-a-real-tone', consoleStyle: 'also-fake' }));
assertEq(readAppearance(), { tone: 'callsign', consoleStyle: 'terminal', railContent: 'schedule_signals' }, 'an unrecognized/corrupt value falls back to the safe default rather than propagating garbage');

global.localStorage.setItem('cc_appearance_v1', 'not json');
assertEq(readAppearance(), { tone: 'callsign', consoleStyle: 'terminal', railContent: 'schedule_signals' }, 'unparsable localStorage does not throw, falls back to defaults');

// ---- greetingFor: callsign is a fixed identifier, not a time-of-day greeting ----
// Verified against the actual rendered design reference (not just the .dc.html
// source): the header always reads "JARVIS // FERNANDO-OS" under callsign tone,
// with no variation by hour. Only friendly tone varies with the clock.
assertEq(greetingFor('friendly', 8), 'Good morning, Fernando', 'friendly tone at 8am matches the original greeting copy exactly');
assertEq(greetingFor('friendly', 14), 'Good afternoon, Fernando', 'friendly tone at 2pm matches the original greeting copy exactly');
assertEq(greetingFor('friendly', 20), 'Good evening, Fernando', 'friendly tone at 8pm matches the original greeting copy exactly');
assertEq(greetingFor('friendly', 2), 'Still up, Fernando', 'friendly tone at 2am matches the original greeting copy exactly');
assertEq(greetingFor('callsign', 8), 'JARVIS // FERNANDO-OS', 'callsign tone at 8am is the fixed identifier, not a time-based phrase');
assertEq(greetingFor('callsign', 20), 'JARVIS // FERNANDO-OS', 'callsign tone at 8pm is identical to 8am — it never varies by hour');

// ---- statusFor: callsign is also fixed regardless of alert count, matching
// the reference (it showed "ALL SYSTEMS SYNCED — STANDING BY" with 2 active
// alerts) — the Alerts panel already surfaces the count, so this line
// doesn't restate it under callsign tone. Friendly tone keeps the original
// alert-aware phrasing unchanged. ----
assertEq(statusFor('callsign', 0), 'ALL SYSTEMS SYNCED — STANDING BY', 'callsign status with zero alerts');
assertEq(statusFor('callsign', 2), 'ALL SYSTEMS SYNCED — STANDING BY', 'callsign status is unchanged even with active alerts, matching the reference');
assertEq(statusFor('friendly', 0), 'All systems nominal', 'friendly status with zero alerts matches the original copy exactly');
assertEq(statusFor('friendly', 1), '1 signal need attention', 'friendly status singular alert wording matches the pre-existing (unchanged) copy exactly');
assertEq(statusFor('friendly', 3), '3 signals need attention', 'friendly status is alert-count-aware, matching the original copy exactly');

// ---- kicker never changes with tone — confirmed against the rendered
// design reference, which shows "COMMAND CENTER · ONLINE" even under
// callsign tone. Only the greeting line and status line vary. ----
assertTrue(/<div class="cc-kicker" id="ccKicker">Command Center · Online<\/div>/.test(html), 'the kicker stays static text — command-center.js does not touch it at all');
assertTrue(!/kickerFor/.test(readFileSync(path.join(root, 'command-center.js'), 'utf8')), 'no leftover kicker-tone-switching logic remains in command-center.js');

// ---- 3-rail layout ----
assertTrue(html.includes('id="ccRailLeft"') && html.includes('id="ccRailRight"') && html.includes('class="cc-main"'), 'the page has a left rail, center column, and right rail');
assertTrue(html.includes('id="ccScheduleSection"') && html.includes('id="ccSignalsSection"') && html.includes('id="ccBrowseSection"'), 'left-rail sections are individually addressable so applyRailContent can move them');
assertTrue(html.includes('id="ccAlertsPanel"') && html.includes('id="ccConsolePanel"'), 'right-rail panels are individually addressable so applyRailContent can move them');
assertTrue(css.includes('.cc-grid') && /grid-template-columns:\s*260px/.test(css), 'the 3-column rail grid is defined');
assertTrue(/@media\(max-width:980px\)\s*\{\s*\.cc-grid\s*\{\s*grid-template-columns:1fr/.test(css.replace(/\n\s*/g, '')), 'the 3-column rail collapses to a single stacked column on narrower screens');

// ---- Browse: vertical rail list, not the old bento grid ----
assertTrue(html.includes('cc-browse-list') && html.includes('cc-browse-item'), 'Browse renders as a vertical rail list');
assertTrue(!html.includes('class="bento"') && !/class="tile big"/.test(html), 'the old bento/tile grid markup was actually replaced, not left dangling alongside the new list');
assertTrue(html.includes('href="hub-today.html"') && html.includes('href="hub-body.html"') && html.includes('href="hub-money.html"') && html.includes('href="hub-reflect.html"') && html.includes('href="hub-insights.html"'), 'all five hub destinations are still linked from the new Browse list');

// ---- AI Core: tabs, globe decoration, real 7-day trace (no fabricated data) ----
assertTrue(html.includes('id="coreTabToday"') && html.includes('id="coreTabJarvis"'), 'the AI Core card exposes Today/Jarvis tabs');
assertTrue(html.includes('id="coreJarvisPanel"') && /id="coreJarvisPanel"[^>]*hidden/.test(html), 'the Jarvis panel starts hidden — Today is the default view on load');
assertTrue(html.includes('cc-jarvis-btn" disabled'), 'the Jarvis "Tap to talk" button ships disabled — it is a placeholder, not a working feature');
assertTrue(html.includes('id="scoreTrace"'), 'the AI Core card has a trend trace element');
assertTrue(html.includes('SCORE_HISTORY_KEY') && html.includes('cc_score_history_v1'), 'score history is persisted under its own key rather than recomputed/fabricated');
assertTrue(html.includes('Building your trend'), 'with fewer than two real data points the trace admits it is still building rather than drawing fake bars');
assertTrue(css.includes('.cc-core-globe'), 'the AI Core ring has the decorative wireframe-globe styling');

// ---- Settings toggles still wired, still live, still persisted ----
assertTrue(html.includes('id="toneSeg"') && html.includes('id="consoleStyleSeg"') && html.includes('id="railContentSeg"'), 'Settings exposes all three appearance toggles');
assertTrue(html.includes("appearance-changed"), 'toggling an appearance setting notifies the Command Center to re-render live, not just on next reload');
assertTrue(/function open\(\)\s*\{[^}]*paintAppearanceSegs/.test(html), 'opening Settings paints the appearance segmented controls’ active state, not just after the first click');
assertTrue(css.includes('.cc-core-panel[hidden]'), 'hidden AI Core panels are actually hidden — a bare .cc-core-panel{display:flex} rule alone would beat the UA [hidden] stylesheet default at equal specificity');

// ---- Console/Recent-activity terminal format: "[HH:MM] category · detail",
// ending in one persistent "> standing by…" prompt row (not one cursor per
// entry, which the earlier version had). ----
assertTrue(css.includes('.cc-console-time') && css.includes('.cc-console-cat') && css.includes('.cc-console-desc'), 'the terminal console format has dedicated time/category/description styling');
assertTrue(css.includes('.cc-console-prompt-row'), 'the terminal console ends in a persistent standing-by prompt row, not a cursor glued to every entry');
assertTrue(/prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.cc-console-(row|cursor)/.test(css.replace(/\n/g, ' ')), 'the terminal console cursor/rows respect prefers-reduced-motion');

// ---- Last-sync indicator and the bottom Command Bar trigger ----
assertTrue(html.includes('id="ccLastSync"') && html.includes('LAST_SYNC_KEY'), 'a real last-sync timestamp is tracked and rendered, not a fabricated one');
assertTrue(html.includes('id="ccCmdBarBottom"') && html.includes('data-command-open'), 'the persistent bottom command-bar trigger reuses the existing data-command-open wiring rather than a bespoke open path');

// ---- WHOOP Recovery signal reuses real data, never fabricates a number ----
const commandCenterJs = readFileSync(path.join(root, 'command-center.js'), 'utf8');
assertTrue(commandCenterJs.includes('whoop_last_stats_v1'), 'the Recovery signal reads the real cached WHOOP stats rather than inventing a number');
assertTrue(html.includes("localStorage.setItem('whoop_last_stats_v1'"), 'the WHOOP sync path actually persists whStats for the home screen to read');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
