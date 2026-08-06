import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(path.join(root, 'design-system.css'), 'utf8');
const searchPage = readFileSync(path.join(root, 'search.html'), 'utf8');
const ccCss = readFileSync(path.join(root, 'command-center.css'), 'utf8');
const commandBarJs = readFileSync(path.join(root, 'command-bar.js'), 'utf8');

let pass = 0, fail = 0;
function assertTrue(condition, label) {
  if (condition) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label); }
}

for (const token of [
  '--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6', '--space-7', '--space-8',
  '--radius-sm', '--radius-md', '--radius-lg', '--radius-full',
  '--shadow-sm', '--shadow-md', '--shadow-glow',
  '--z-topbar', '--z-command-bar', '--z-modal', '--z-lock',
]) {
  assertTrue(css.includes(token + ':'), token + ' is defined in the shared design system');
}

for (const selector of ['a:focus-visible', 'button:focus-visible', 'input:focus-visible', 'select:focus-visible', 'textarea:focus-visible']) {
  assertTrue(css.includes(selector), selector + ' receives a shared keyboard focus treatment');
}

assertTrue(css.includes('@media (prefers-reduced-motion: reduce)'), 'the shared design system has a reduced-motion mode');
for (const futureComponent of ['.cc-ai-core', '.cc-alert', '.cc-activity-item', '.cc-now-marker', '.command-bar', '.focus-mode']) {
  assertTrue(css.includes(futureComponent), futureComponent + ' is covered before its Phase 1 animation ships');
}

assertTrue(searchPage.includes('type="module"'), 'search.html loads its wiring as a browser module');
assertTrue(searchPage.includes("from './search-index.js'"), 'search.html consumes the extracted shared search module');
assertTrue(!searchPage.includes('function normalizeNotes('), 'search.html no longer carries a second inline copy of search normalization');
assertTrue(searchPage.includes('window.__searchLogic'), 'the existing browser debug/test hook remains available');

// Bug regression: design-system.css's shared reduced-motion block resets
// .cc-ai-core, but that CANNOT reach a more specific descendant selector
// like `.cc-ai-core.score-card .hud-ring` (defined in command-center.css) —
// CSS specificity beats source order, so the breathing animation kept
// running under prefers-reduced-motion even though `.cc-ai-core` was
// textually "covered" above. The override has to live next to the more
// specific rule it needs to beat, in command-center.css itself.
{
  const ccReducedMotionBlock = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\}\s*\}/.exec(ccCss);
  assertTrue(!!ccReducedMotionBlock, 'command-center.css has its own reduced-motion override (not relying solely on the shared, lower-specificity one)');
  if (ccReducedMotionBlock) {
    assertTrue(ccReducedMotionBlock[1].includes('.cc-ai-core.score-card .hud-ring'), 'the override targets the exact same high-specificity selector the breathing animation is declared on');
    assertTrue(ccReducedMotionBlock[1].includes('animation: none'), 'the override actually disables the animation, not just re-declares duration');
  }
}

// Same category of bug: command-bar.js injects its own <style> tag at
// runtime, which lands AFTER design-system.css in the cascade — an
// unconditional `.command-bar { animation: commandBarIn ... }` inside that
// SAME injected block has equal specificity to the shared reduced-motion
// rule and wins by being later, regardless of the media query matching.
// The fix has to be self-contained within command-bar.js's own injected
// CSS rather than relying on load order against an external stylesheet.
assertTrue(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.command-bar\s*\{\s*animation:\s*none/.test(commandBarJs), 'command-bar.js\'s own injected stylesheet self-contains a reduced-motion override for its entrance animation, independent of external stylesheet load order');

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
