import {
  firstOccurrenceDateKey, buildRecurrenceRule, normalizeExtendedTime,
  blockToGoogleEvent, appointmentToGoogleEvent, blockContentSignature, appointmentContentSignature,
  planSyncActions, planOverrideActions, planAllOverrideActions, applySyncResults,
} from '../schedule-google.js';
import { buildDefaultScheduleModel, normalizeScheduleModel } from '../schedule-model.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

const model = buildDefaultScheduleModel();
const summer = model.profiles.find(p => p.id === 'summer-2026');
const gym = summer.blocks.find(b => b.id.endsWith('0830-gym'));
const satWake = summer.blocks.find(b => b.id.endsWith('sat:0900-wake'));
const friSleep = summer.blocks.find(b => b.id.endsWith('fri:2400-sleep'));
const monWake = summer.blocks.find(b => b.id.endsWith('mon-wed:0700-wake'));

// ==================== firstOccurrenceDateKey ====================
{
  assertEq(firstOccurrenceDateKey(gym, summer), '2026-07-29', 'Mon/Tue/Wed block finds Wed 7/29 (effectiveStart itself) as its first occurrence');
  assertEq(firstOccurrenceDateKey(satWake, summer), '2026-08-01', 'a Saturday-only block finds the first Saturday on/after effectiveStart');
  const mondayOnlyProfile = { effectiveStart: '2026-08-01' }; // a Saturday
  assertEq(firstOccurrenceDateKey({ days: [1] }, mondayOnlyProfile), '2026-08-03', 'a Monday-only block starting from a Saturday correctly rolls forward to the next Monday');
}

// ==================== buildRecurrenceRule ====================
{
  assertEq(buildRecurrenceRule(gym, summer), ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE;UNTIL=20260831T235959Z'], 'RRULE includes sorted BYDAY and the profile\'s UNTIL bound');
  assertEq(buildRecurrenceRule(satWake, summer), ['RRULE:FREQ=WEEKLY;BYDAY=SA;UNTIL=20260831T235959Z'], 'a single-day block yields a single-day BYDAY');
  const openEnded = { ...summer, effectiveEnd: null };
  assertEq(buildRecurrenceRule(gym, openEnded), ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE'], 'an open-ended profile (no effectiveEnd) omits UNTIL entirely rather than fabricating one');
  assertEq(buildRecurrenceRule(friSleep, summer), ['RRULE:FREQ=WEEKLY;BYDAY=SA;UNTIL=20260831T235959Z'], 'a Friday-nominal block using the 24:00 marker rolls its BYDAY to Saturday — the weekday its DTSTART instant actually lands on');
}

// ==================== normalizeExtendedTime ====================
{
  assertEq(normalizeExtendedTime('2026-07-31', '21:00'), { dateKey: '2026-07-31', time: '21:00' }, 'a normal time stays on the same calendar date');
  assertEq(normalizeExtendedTime('2026-07-31', '24:00'), { dateKey: '2026-08-01', time: '00:00' }, 'the extended 24:00 marker rolls to 00:00 the NEXT calendar date');
}

// ==================== blockToGoogleEvent ====================
{
  const ev = blockToGoogleEvent(gym, summer);
  assertEq(ev.summary, 'Gym', 'event summary matches the block title');
  assertEq(ev.start, { dateTime: '2026-07-29T08:30:00', timeZone: 'America/New_York' }, 'a ranged block\'s start uses its real start time with the profile timezone');
  assertEq(ev.end, { dateTime: '2026-07-29T09:30:00', timeZone: 'America/New_York' }, 'a ranged block\'s end uses its real end time');
  assertTrue(ev.description.includes('Managed by the dashboard'), 'the event description flags itself as dashboard-managed');

  const wakeEv = blockToGoogleEvent(monWake, summer);
  assertEq(wakeEv.start.dateTime, '2026-07-29T07:00:00', 'a milestone block starts at its exact minute');
  assertEq(wakeEv.end.dateTime, '2026-07-29T07:05:00', 'a milestone block gets a minimal 5-minute visual end rather than a zero-duration event');

  const sleepEv = blockToGoogleEvent(friSleep, summer);
  // Friday's "Sleep target" sits at the exact midnight boundary — that
  // instant IS the start of the next calendar date, so 24:00 on 7/31
  // correctly becomes 00:00 on 8/1, never a literal (invalid) "24:00:00".
  assertEq(sleepEv.start.dateTime, '2026-08-01T00:00:00', 'a block using the extended 24:00 marker lands on the midnight instant of the FOLLOWING calendar date');
  assertTrue(!sleepEv.start.dateTime.includes('24:00'), 'the 24:00 marker itself is never literally sent as "24:00:00" (invalid ISO)');

  const withLocation = blockToGoogleEvent({ ...gym, location: 'Equinox' }, summer);
  assertEq(withLocation.location, 'Equinox', 'a location is passed through when present');
  assertTrue(!('location' in blockToGoogleEvent(gym, summer)), 'no location field is sent at all when the block has none, rather than an empty string');
}

// ==================== appointmentToGoogleEvent ====================
{
  const appt = { title: 'Dentist', date: '2026-08-06', start: '12:00', end: '12:30', location: '', notes: '' };
  const ev = appointmentToGoogleEvent(appt);
  assertEq(ev.start, { dateTime: '2026-08-06T12:00:00', timeZone: 'America/New_York' }, 'a one-off appointment has no recurrence, just a plain start');
  assertTrue(!('recurrence' in ev), 'an appointment event never carries a recurrence field');
  const pointAppt = { title: 'Call', date: '2026-08-06', start: '09:00', end: '09:00' };
  assertEq(appointmentToGoogleEvent(pointAppt).end.dateTime, '2026-08-06T09:05:00', 'a point-in-time appointment also gets a minimal visual duration');
}

// ==================== content signatures ====================
{
  const sigA = blockContentSignature(gym);
  const sigB = blockContentSignature({ ...gym });
  assertEq(sigA, sigB, 'two structurally-identical blocks produce the same signature');
  const changed = blockContentSignature({ ...gym, title: 'Gym session' });
  assertTrue(changed !== sigA, 'changing the title changes the signature');
  const sameExceptId = blockContentSignature({ ...gym, id: 'totally-different-id', enabled: false });
  assertEq(sameExceptId, sigA, 'the signature ignores id/enabled — only Google-relevant fields participate');
}

// ==================== planSyncActions ====================
{
  const fresh = buildDefaultScheduleModel();
  const plan = planSyncActions(fresh);
  assertEq(plan.length, fresh.profiles.find(p => p.id === 'summer-2026').blocks.length, 'a never-synced model plans exactly one create per enabled block');
  assertTrue(plan.every(a => a.kind === 'create'), 'every planned action on a fresh model is a create');

  const syncedOnce = normalizeScheduleModel({
    ...fresh,
    profiles: fresh.profiles.map(p => p.id !== 'summer-2026' ? p : {
      ...p, blocks: p.blocks.map(b => b.id === gym.id
        ? { ...b, googleEventId: 'gcal-abc', googleContentSignature: blockContentSignature(b) }
        : b),
    }),
  });
  const planAfterSync = planSyncActions(syncedOnce);
  assertTrue(!planAfterSync.some(a => a.blockId === gym.id), 'a block already synced with a matching signature is skipped — no redundant update');
  assertEq(planAfterSync.length, plan.length - 1, 'exactly one fewer action once one block is marked in-sync');

  const changedAfterSync = normalizeScheduleModel({
    ...syncedOnce,
    profiles: syncedOnce.profiles.map(p => p.id !== 'summer-2026' ? p : {
      ...p, blocks: p.blocks.map(b => b.id === gym.id ? { ...b, title: 'Gym (updated)' } : b),
    }),
  });
  const planAfterEdit = planSyncActions(changedAfterSync);
  const gymAction = planAfterEdit.find(a => a.blockId === gym.id);
  assertEq(gymAction.kind, 'update', 'editing an already-synced block plans an update, not a fresh create');
  assertEq(gymAction.googleEventId, 'gcal-abc', 'the update targets the block\'s existing Google event id');

  const disabledSynced = normalizeScheduleModel({
    ...syncedOnce,
    profiles: syncedOnce.profiles.map(p => p.id !== 'summer-2026' ? p : {
      ...p, blocks: p.blocks.map(b => b.id === gym.id ? { ...b, enabled: false } : b),
    }),
  });
  const planAfterDisable = planSyncActions(disabledSynced);
  const deleteAction = planAfterDisable.find(a => a.blockId === gym.id);
  assertEq(deleteAction.kind, 'delete', 'disabling an already-synced block plans a delete of its Google event');

  const disabledNeverSynced = normalizeScheduleModel({
    ...fresh,
    profiles: fresh.profiles.map(p => p.id !== 'summer-2026' ? p : {
      ...p, blocks: p.blocks.map(b => b.id === gym.id ? { ...b, enabled: false } : b),
    }),
  });
  assertTrue(!planSyncActions(disabledNeverSynced).some(a => a.blockId === gym.id), 'disabling a block that was NEVER synced plans nothing at all — there is no Google event to delete');

  const disabledProfileModel = normalizeScheduleModel({ ...fresh, profiles: fresh.profiles.map(p => ({ ...p, enabled: false })) });
  assertEq(planSyncActions(disabledProfileModel), [], 'a model with no enabled profiles at all plans zero actions');

  const withAppt = normalizeScheduleModel({ ...fresh, appointments: [{ id: 'a1', title: 'Dentist', date: '2026-08-06', start: '12:00', end: '12:30' }] });
  const apptPlan = planSyncActions(withAppt);
  const apptAction = apptPlan.find(a => a.appointmentId === 'a1');
  assertEq(apptAction.kind, 'create', 'a never-synced appointment plans a create');
  assertEq(apptAction.target, 'appointment', 'the appointment action is tagged target:appointment, distinct from blocks');
}

// ==================== planOverrideActions / planAllOverrideActions ====================
{
  const fresh = buildDefaultScheduleModel();
  const unsynced = normalizeScheduleModel({ ...fresh, overrides: { '2026-08-04': { disabledBlockIds: [], modifiedBlocks: { [gym.id]: { start: '10:00', end: '11:00' } } } } });
  assertEq(planOverrideActions(unsynced, '2026-08-04'), [], 'an override on a block that was never synced to Google plans nothing yet — it still applies purely on the dashboard');

  const synced = normalizeScheduleModel({
    ...fresh,
    profiles: fresh.profiles.map(p => p.id !== 'summer-2026' ? p : { ...p, blocks: p.blocks.map(b => b.id === gym.id ? { ...b, googleEventId: 'gcal-gym' } : b) }),
    overrides: {
      '2026-08-04': { disabledBlockIds: [], modifiedBlocks: { [gym.id]: { start: '10:00', end: '11:00' } } },
      '2026-08-05': { disabledBlockIds: [gym.id], modifiedBlocks: {} },
    },
  });
  const moveActions = planOverrideActions(synced, '2026-08-04');
  assertEq(moveActions.length, 1, 'a move override on a synced block plans exactly one action');
  assertEq(moveActions[0].kind, 'move-instance', 'a modified-time override plans a move-instance action');
  assertEq(moveActions[0].googleEventId, 'gcal-gym', 'the move-instance action references the recurring event\'s own id (instance resolution happens at execution time)');
  assertEq(moveActions[0].start, '10:00', 'the move-instance action carries the overridden start time');

  const cancelActions = planOverrideActions(synced, '2026-08-05');
  assertEq(cancelActions[0].kind, 'cancel-instance', 'a disabled-for-one-day override plans a cancel-instance action');

  const allActions = planAllOverrideActions(synced);
  assertEq(allActions.length, 2, 'planAllOverrideActions aggregates every override date in the model');
}

// ==================== applySyncResults ====================
{
  const fresh = buildDefaultScheduleModel();
  const results = [
    { target: 'block', blockId: gym.id, ok: true, kind: 'create', googleEventId: 'gcal-1', signature: blockContentSignature(gym) },
    { target: 'block', blockId: satWake.id, ok: false, error: 'Google 500: server error' },
  ];
  const applied = applySyncResults(fresh, results);
  const appliedGym = applied.profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === gym.id);
  assertEq(appliedGym.googleEventId, 'gcal-1', 'a successful create writes back the new googleEventId');
  assertEq(appliedGym.googleSyncStatus, 'synced', 'a successful create marks the block synced');
  const appliedSat = applied.profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === satWake.id);
  assertEq(appliedSat.googleSyncStatus, 'error', 'a failed action marks that block (and only that block) as errored');
  assertEq(appliedSat.googleSyncError, 'Google 500: server error', 'the failure reason is preserved for a retry/inspection UI');
  assertTrue(applied.profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === monWake.id).googleSyncStatus === 'idle', 'a block with no result in this batch is left completely untouched — a partial batch does not reset unrelated items');

  const deleteResult = [{ target: 'block', blockId: gym.id, ok: true, kind: 'delete' }];
  const afterDelete = applySyncResults(applied, deleteResult);
  const deletedGym = afterDelete.profiles.find(p => p.id === 'summer-2026').blocks.find(b => b.id === gym.id);
  assertEq(deletedGym.googleEventId, null, 'a successful delete clears the stored googleEventId');
  assertEq(deletedGym.googleSyncStatus, 'idle', 'a successful delete resets sync status back to idle, ready to be recreated if re-enabled');

  const apptResults = [{ target: 'appointment', appointmentId: 'a1', ok: true, kind: 'create', googleEventId: 'gcal-appt-1', signature: 'sig' }];
  const withAppt = normalizeScheduleModel({ ...fresh, appointments: [{ id: 'a1', title: 'Dentist', date: '2026-08-06', start: '12:00' }] });
  const appliedAppt = applySyncResults(withAppt, apptResults).appointments.find(a => a.id === 'a1');
  assertEq(appliedAppt.googleEventId, 'gcal-appt-1', 'a successful appointment sync writes back its googleEventId');
  assertEq(appliedAppt.syncStatus, 'synced', 'a successful appointment sync marks it synced');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
