// Weekly Schedule System — Google Calendar projection, pure logic.
// No DOM, no fetch, no OAuth: this module only computes what SHOULD exist
// on Google Calendar given the current schedule model, and what payloads
// to send. The actual network calls (executeSyncPlan's caller, in
// schedule.html) reuse the browser's own already-connected Google token —
// the same one calendar.html already reads — never a server-side one.
//
// Design: one recurring dashboard block maps to ONE recurring Google
// event (native RRULE), not one event per date. Editing/disabling a block
// updates/deletes that single event, which Google itself then reflects
// across every future occurrence — matching "updating a recurring block
// must update its linked Google events safely" without our own fan-out.
// A one-day override maps to a Google "instance exception" (a PATCH
// against that one occurrence's own instance id), so it can never leak
// into any other occurrence.

import { addDaysToKey, dayOfWeekFor, SCHEDULE_TIMEZONE } from './schedule-model.js';

const RRULE_DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const MANAGED_BY_DASHBOARD_MARKER = '[Managed by the dashboard Weekly Schedule — edits made directly in Google may be overwritten on the next sync.]';

// The first date on/after profile.effectiveStart whose weekday is in
// block.days — used as the recurring event's own DTSTART. block.days is
// never empty (normalizeBlock rejects that), so this always resolves
// within one week.
export function firstOccurrenceDateKey(block, profile) {
  for (let i = 0; i < 7; i++) {
    const candidate = addDaysToKey(profile.effectiveStart, i);
    if (block.days.includes(dayOfWeekFor(candidate))) return candidate;
  }
  return profile.effectiveStart;
}

// A block using the extended 24:00+ marker (e.g. Friday's "Sleep target"
// at midnight) actually lands on the FOLLOWING calendar date once rolled
// over — DTSTART must be that real instant, so BYDAY has to describe the
// weekday the instant actually falls on, not the nominal day the block is
// grouped under on the dashboard, or Google's RRULE engine would be asked
// to recur on a weekday that never matches its own DTSTART.
function rolloverDayOffset(hhmm) {
  const hours = Number(String(hhmm).split(':')[0]);
  return hours >= 24 ? Math.floor(hours / 24) : 0;
}

export function buildRecurrenceRule(block, profile) {
  const offset = rolloverDayOffset(block.start);
  const byday = block.days.slice().sort((a, b) => a - b).map(d => RRULE_DAY_CODES[(d + offset) % 7]).join(',');
  let rule = 'RRULE:FREQ=WEEKLY;BYDAY=' + byday;
  if (profile.effectiveEnd) rule += ';UNTIL=' + profile.effectiveEnd.replace(/-/g, '') + 'T235959Z';
  return [rule];
}

// A block's own start/end can use the extended 24:00+ marker (Friday's
// "Sleep target" at midnight, for instance) to stay attached to the day it
// conceptually belongs to. Google has no such convention — 24:00 has to
// become 00:00 the FOLLOWING calendar date instead.
export function normalizeExtendedTime(dateKey, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (h >= 24) return { dateKey: addDaysToKey(dateKey, Math.floor(h / 24)), time: String(h % 24).padStart(2, '0') + ':' + String(m).padStart(2, '0') };
  return { dateKey, time: hhmm };
}

function isoLocal(dateKey, hhmm) { return dateKey + 'T' + hhmm + ':00'; }

// A zero-duration "milestone" block (e.g. "Wake up") has no real end time
// to send Google — Calendar requires end > start, so it gets a minimal
// 5-minute visual duration rather than being rejected or misrepresented
// as a real block of time.
function minimalEndIfInstant(block) {
  if (block.start !== block.end) return block.end;
  const [h, m] = block.start.split(':').map(Number);
  const total = h * 60 + m + 5;
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
}

export function blockToGoogleEvent(block, profile) {
  const anchorDate = firstOccurrenceDateKey(block, profile);
  const startAt = normalizeExtendedTime(anchorDate, block.start);
  const endAt = normalizeExtendedTime(anchorDate, minimalEndIfInstant(block));
  const tz = profile.timezone || SCHEDULE_TIMEZONE;
  const payload = {
    summary: block.title,
    description: [block.notes || '', MANAGED_BY_DASHBOARD_MARKER].filter(Boolean).join('\n\n'),
    start: { dateTime: isoLocal(startAt.dateKey, startAt.time), timeZone: tz },
    end: { dateTime: isoLocal(endAt.dateKey, endAt.time), timeZone: tz },
    recurrence: buildRecurrenceRule(block, profile),
  };
  if (block.location) payload.location = block.location;
  return payload;
}

export function appointmentToGoogleEvent(appt) {
  const endTime = appt.end && appt.end !== appt.start ? appt.end : minimalEndIfInstant({ start: appt.start, end: appt.start });
  const payload = {
    summary: appt.title,
    description: [appt.notes || '', MANAGED_BY_DASHBOARD_MARKER].filter(Boolean).join('\n\n'),
    start: { dateTime: isoLocal(appt.date, appt.start), timeZone: SCHEDULE_TIMEZONE },
    end: { dateTime: isoLocal(appt.date, endTime), timeZone: SCHEDULE_TIMEZONE },
  };
  if (appt.location) payload.location = appt.location;
  return payload;
}

// Stable signature of exactly the fields Google needs to know about — NOT
// a cryptographic hash, just a deterministic string so "did anything
// Google-relevant change since the last successful push" is a plain
// string comparison instead of a full re-diff.
export function blockContentSignature(block) {
  return JSON.stringify({ title: block.title, start: block.start, end: block.end, days: block.days, location: block.location || '', notes: block.notes || '' });
}
export function appointmentContentSignature(appt) {
  return JSON.stringify({ title: appt.title, date: appt.date, start: appt.start, end: appt.end, location: appt.location || '', notes: appt.notes || '' });
}

// Computes exactly what needs to happen against Google to bring it back
// in sync with the current model — pure and side-effect-free, so both the
// preview modal (never touches the network) and the real push (executes
// each planned action) read from the exact same plan. Only enabled
// profiles' blocks are considered; a disabled profile (like the
// university placeholder) never contributes a create.
export function planSyncActions(model) {
  const actions = [];
  (model.profiles || []).filter(p => p.enabled).forEach(profile => {
    profile.blocks.forEach(block => {
      const signature = blockContentSignature(block);
      if (!block.enabled) {
        if (block.googleEventId) {
          actions.push({ kind: 'delete', target: 'block', profileId: profile.id, blockId: block.id, googleEventId: block.googleEventId, label: block.title });
        }
        return;
      }
      if (!block.googleEventId) {
        actions.push({ kind: 'create', target: 'block', profileId: profile.id, blockId: block.id, payload: blockToGoogleEvent(block, profile), signature, label: block.title });
      } else if (block.googleContentSignature !== signature) {
        actions.push({ kind: 'update', target: 'block', profileId: profile.id, blockId: block.id, googleEventId: block.googleEventId, payload: blockToGoogleEvent(block, profile), signature, label: block.title });
      }
    });
  });
  (model.appointments || []).forEach(appt => {
    const signature = appointmentContentSignature(appt);
    if (!appt.googleEventId) {
      actions.push({ kind: 'create', target: 'appointment', appointmentId: appt.id, payload: appointmentToGoogleEvent(appt), signature, label: appt.title });
    } else if (appt.googleContentSignature !== signature) {
      actions.push({ kind: 'update', target: 'appointment', appointmentId: appt.id, googleEventId: appt.googleEventId, payload: appointmentToGoogleEvent(appt), signature, label: appt.title });
    }
  });
  return actions;
}

function findBlock(model, blockId) {
  for (const profile of model.profiles || []) {
    const block = profile.blocks.find(b => b.id === blockId);
    if (block) return { block, profile };
  }
  return null;
}

// One-day overrides map to a Google "instance exception" — a PATCH
// against that single occurrence's own instance id, which the caller
// resolves via events.instances (never hand-constructed) — so this only
// ever plans an action once the base recurring block already has a
// googleEventId; overrides on a not-yet-synced block still apply purely
// on the dashboard until the block itself is pushed.
export function planOverrideActions(model, dateKey) {
  const actions = [];
  const forDate = (model.overrides || {})[dateKey];
  if (!forDate) return actions;
  const applied = new Set(forDate.appliedBlockIds || []);
  (forDate.disabledBlockIds || []).forEach(blockId => {
    if (applied.has(blockId)) return;
    const found = findBlock(model, blockId);
    if (!found || !found.block.googleEventId) return;
    actions.push({ kind: 'cancel-instance', target: 'override', blockId, googleEventId: found.block.googleEventId, dateKey, label: found.block.title });
  });
  Object.keys(forDate.modifiedBlocks || {}).forEach(blockId => {
    if (applied.has(blockId)) return;
    const found = findBlock(model, blockId);
    if (!found || !found.block.googleEventId) return;
    const mod = forDate.modifiedBlocks[blockId];
    actions.push({ kind: 'move-instance', target: 'override', blockId, googleEventId: found.block.googleEventId, dateKey, start: mod.start, end: mod.end, timezone: found.profile.timezone || SCHEDULE_TIMEZONE, label: found.block.title });
  });
  return actions;
}

export function planAllOverrideActions(model) {
  return Object.keys(model.overrides || {}).reduce((all, dateKey) => all.concat(planOverrideActions(model, dateKey)), []);
}

// Pure reducer: applies the outcome of having attempted a batch of planned
// actions back onto the model — a partial failure (some actions succeeded,
// others didn't) still commits every successful result rather than an
// all-or-nothing rollback, and every failed one gets a recoverable,
// retry-able error status instead of silently staying stale.
export function applySyncResults(model, results) {
  const next = JSON.parse(JSON.stringify(model));
  results.forEach(result => {
    if (result.target === 'block') {
      const found = findBlock(next, result.blockId);
      if (!found) return;
      if (result.ok) {
        if (result.kind === 'delete') {
          found.block.googleEventId = null;
          found.block.googleContentSignature = null;
          found.block.googleSyncStatus = 'idle';
          found.block.googleSyncError = null;
        } else {
          found.block.googleEventId = result.googleEventId || found.block.googleEventId;
          found.block.googleContentSignature = result.signature;
          found.block.googleSyncStatus = 'synced';
          found.block.googleSyncError = null;
        }
      } else {
        found.block.googleSyncStatus = 'error';
        found.block.googleSyncError = result.error || 'Sync failed';
      }
    } else if (result.target === 'appointment') {
      const appt = (next.appointments || []).find(a => a.id === result.appointmentId);
      if (!appt) return;
      if (result.ok) {
        appt.googleEventId = result.googleEventId || appt.googleEventId;
        appt.googleContentSignature = result.signature;
        appt.syncStatus = 'synced';
        appt.syncError = null;
      } else {
        appt.syncStatus = 'error';
        appt.syncError = result.error || 'Sync failed';
      }
    } else if (result.target === 'override' && result.ok) {
      // A failed override action is intentionally left unmarked — it
      // simply gets re-planned and retried on the next sync, same as a
      // failed block/appointment action.
      const forDate = next.overrides[result.dateKey];
      if (!forDate) return;
      if (!forDate.appliedBlockIds.includes(result.blockId)) forDate.appliedBlockIds.push(result.blockId);
    }
  });
  return next;
}
