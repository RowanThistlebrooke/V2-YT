import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dismissAlert, normalizeAlertState, reconcileAlertState, visibleAlerts } from '../alert-state.js';
import { getTimeTheme, getZonedHour } from '../time-theme.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const topbar = read('topbar.js');
const commandBar = read('command-bar.js');
const commandCenter = read('command-center.js');
const design = read('design-system.css');
const index = read('index.html');
const gym = read('gym.html');
const water = read('po-water.html');

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n expected:', expected, '\n actual:', actual); }
}
function assertTrue(value, label) { if (value) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

assertEq(getZonedHour(Date.UTC(2026, 6, 28, 14), 'UTC'), 14, 'timezone helper reads wall-clock hours through Intl');
assertEq(getTimeTheme(Date.UTC(2026, 6, 28, 14), 'UTC').theme, 'day', 'daytime selects the lifted HUD palette');
assertEq(getTimeTheme(Date.UTC(2026, 6, 28, 23), 'UTC').theme, 'night', 'late hours select the night HUD palette');

const dismissed = dismissAlert(null, 'water:2026-07-28', 100);
assertEq(dismissed, { version: 1, dismissed: { 'water:2026-07-28': 100 } }, 'dismissing an alert creates the versioned state shape');
assertEq(visibleAlerts([{ id: 'water:2026-07-28' }, { id: 'burnout:2026-07-28' }], dismissed).map(item => item.id), ['burnout:2026-07-28'], 'dismissed alerts are filtered from the active feed');
const reconciled = reconcileAlertState({ version: 1, dismissed: { old: 10, active: 20 } }, ['active']);
assertEq(reconciled.state.dismissed, { active: 20 }, 'resolved conditions prune stale dismissals so future recurrences can appear');
assertTrue(reconciled.changed, 'pruning reports a state change for sync');
assertEq(normalizeAlertState({ dismissed: { bad: 'nope', good: 5 } }).dismissed, { good: 5 }, 'invalid persisted timestamps are ignored');

assertTrue(!topbar.includes('isCommandBarPage') && topbar.includes("loadSharedModule('command-bar.js'"), 'topbar loads the Command Bar without a page allowlist');
assertTrue(topbar.includes("loadSharedModule('time-theme.js'"), 'topbar activates the shared day/night state');
assertTrue(commandBar.includes('command-bar-fab'), 'pages with standalone chrome receive a persistent mobile search trigger');
for (const file of readdirSync(root).filter(file => file.endsWith('.html'))) {
  assertTrue(read(file).includes('topbar.js'), file + ' participates in the global Command Bar rollout');
  assertTrue(read(file).includes('design-system.css'), file + ' can render the shared day/night atmosphere');
}

const legacyTokens = ['--bg-card', '--text-1', '--text-2', '--text-3', '--text-4', '--border', '--border-strong', '--accent', '--good', '--warn', '--bad', '--info'];
assertTrue(gym.includes('design-system.css') && water.includes('design-system.css'), 'Gym and Water load the shared design system');
for (const token of legacyTokens) {
  assertTrue(!gym.includes('var(' + token + ')') && !water.includes('var(' + token + ')'), token + ' is no longer consumed by Gym or Water');
}
assertTrue(design.includes('html[data-time-theme="day"]') && design.includes('--surface-card'), 'shared CSS defines time-aware surfaces');

assertTrue(index.includes("appKey: 'alerts'") && index.includes("syncedKeys: ['command_center_alerts_v1']"), 'alert dismissals use a dedicated race-safe sync row');
assertTrue(commandCenter.includes('data-alert-dismiss') && commandCenter.includes('reconcileAlertState'), 'the Command Center renders dismissal controls and reconciles resolved alerts');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
