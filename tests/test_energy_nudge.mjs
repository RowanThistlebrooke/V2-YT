// Standalone verification of api/send-reminders.js's reactive low-energy
// nudge — the simplified server-side port of caffeine.html's energy model
// (circadian curve + lunch dip + sleep pressure + morning bump + caffeine
// decay/boost) used to decide "is energy dipping right now, and would
// caffeine/nicotine actually help." Imports the real exported functions
// rather than duplicating them, since they're already pure and exported.

import {
  computeCurrentEnergy, shouldSendEnergyNudge, composeEnergyNudge,
} from '../api/send-reminders.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }
function assertClose(actual, expected, tol, label) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected ~:', expected, '\n  actual:   ', actual); }
}

const HOUR = 3600000;

// ==================== computeCurrentEnergy ====================
{
  const now = new Date('2026-07-25T00:00:00').getTime(); // just a reference epoch
  const noCaf = computeCurrentEnergy([], 8, 15, now); // mid-afternoon, no caffeine at all
  assertEq(noCaf.activeCaffeineMg, 0, 'no caffeine logs at all means zero active caffeine');
  assertTrue(noCaf.energy >= 0 && noCaf.energy <= 100, 'energy is always clamped to a 0-100 range');

  const freshCoffee = computeCurrentEnergy([{ mg: 95, ts: now }], 8, 15, now);
  assertTrue(freshCoffee.activeCaffeineMg > 90, 'a dose logged at the exact current moment is still ~fully active');
  assertTrue(freshCoffee.energy > noCaf.energy, 'active caffeine measurably raises the energy score vs none at all');

  const oldCoffee = computeCurrentEnergy([{ mg: 95, ts: now - 10 * HOUR }], 8, 15, now + 10 * HOUR);
  assertTrue(oldCoffee.activeCaffeineMg < 10, 'caffeine from 10 hours ago (2 half-lives) has mostly decayed away');

  const twoDoses = computeCurrentEnergy([{ mg: 95, ts: now }, { mg: 50, ts: now }], 8, 15, now);
  assertClose(twoDoses.activeCaffeineMg, 145, 0.01, 'multiple simultaneous doses sum their active caffeine');
}

// ==================== shouldSendEnergyNudge ====================
{
  const now = Date.now();
  const lowEnergyNoCaffeine = { energy: 30, activeCaffeineMg: 0 };
  assertTrue(shouldSendEnergyNudge(lowEnergyNoCaffeine, 10 * 60, null, now, null), 'low energy, no caffeine on board, no cooldown, no recent log -> due');

  const highEnergy = { energy: 70, activeCaffeineMg: 0 };
  assertTrue(!shouldSendEnergyNudge(highEnergy, 10 * 60, null, now, null), 'energy above the low threshold never nudges, regardless of caffeine');

  const lowEnergyHighCaffeine = { energy: 30, activeCaffeineMg: 80 };
  assertTrue(!shouldSendEnergyNudge(lowEnergyHighCaffeine, 10 * 60, null, now, null), 'low energy but already caffeinated -> more caffeine would not help, so no nudge');

  const recentLog = now - 30 * 60000; // 30 minutes ago
  assertTrue(!shouldSendEnergyNudge(lowEnergyNoCaffeine, 10 * 60, recentLog, now, null), 'a stimulant logged 30 minutes ago is too recent to suggest another one yet');

  const oldEnoughLog = now - 100 * 60000; // 100 minutes ago, past the 90-min gap
  assertTrue(shouldSendEnergyNudge(lowEnergyNoCaffeine, 10 * 60, oldEnoughLog, now, null), 'a stimulant logged 100 minutes ago has cleared the minimum gap');

  const activeCooldown = { lastMinutes: 10 * 60 - 30 }; // nudged 30 minutes ago
  assertTrue(!shouldSendEnergyNudge(lowEnergyNoCaffeine, 10 * 60, null, now, activeCooldown), 'still within the 2-hour nudge cooldown -> suppressed');

  const expiredCooldown = { lastMinutes: 10 * 60 - 130 }; // nudged 130 minutes ago
  assertTrue(shouldSendEnergyNudge(lowEnergyNoCaffeine, 10 * 60, null, now, expiredCooldown), 'past the 2-hour cooldown -> due again');

  assertTrue(!shouldSendEnergyNudge(lowEnergyNoCaffeine, 7 * 60, null, now, null), 'before the 8am floor, never nudges regardless of how low energy reads');
  assertTrue(shouldSendEnergyNudge(lowEnergyNoCaffeine, 8 * 60, null, now, null), 'exactly at the 8am floor is allowed');
}

// ==================== composeEnergyNudge ====================
{
  const msg = composeEnergyNudge({ energy: 32.4, activeCaffeineMg: 5 });
  assertTrue(msg.includes('32'), 'the composed message includes the rounded current energy score');
  assertTrue(msg.toLowerCase().includes('caffeine') || msg.toLowerCase().includes('coffee'), 'mentions caffeine as an option');
  assertTrue(msg.toLowerCase().includes('zyn') || msg.toLowerCase().includes('nicotine'), 'mentions nicotine as an option too, not just caffeine');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
