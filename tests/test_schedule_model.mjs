import {
  SCHEDULE_SCHEMA_VERSION, CATEGORIES,
  parseTimeToMinutes, minutesToTime, formatTime12, dayOfWeekFor, addDaysToKey,
  normalizeScheduleModel, buildSummer2026Profile, buildUniversity2026Placeholder,
  buildDefaultScheduleModel, selectActiveProfile, resolveScheduleForDate, currentAndNextForDate,
} from '../schedule-model.js';

let pass = 0, fail = 0;
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log('PASS:', label); }
  else { fail++; console.log('FAIL:', label, '\n  expected:', e, '\n  actual:  ', a); }
}
function assertTrue(cond, label) { if (cond) { pass++; console.log('PASS:', label); } else { fail++; console.log('FAIL:', label); } }

// ==================== time helpers ====================
{
  assertEq(parseTimeToMinutes('07:00'), 420, 'parses a normal HH:MM');
  assertEq(parseTimeToMinutes('00:00'), 0, 'parses midnight');
  assertEq(parseTimeToMinutes('24:00'), 1440, 'parses the extended end-of-day marker');
  assertEq(parseTimeToMinutes('24:01'), null, '24:01 is rejected — 24:00 is only valid with zero minutes');
  assertEq(parseTimeToMinutes('25:00'), null, 'hours beyond 24 are rejected');
  assertEq(parseTimeToMinutes('07:60'), null, 'minutes beyond 59 are rejected');
  assertEq(parseTimeToMinutes('7:5'), null, 'single-digit minutes are rejected (not zero-padded)');
  assertEq(parseTimeToMinutes(''), null, 'empty string is rejected');
  assertEq(parseTimeToMinutes(null), null, 'null is rejected, not coerced');
  assertEq(parseTimeToMinutes(420), null, 'a raw number (not a string) is rejected');
  assertEq(parseTimeToMinutes('09:10'), 550, '10-minute-boundary time parses correctly');
  assertEq(parseTimeToMinutes('13:15'), 795, '15-minute-boundary time parses correctly');
  assertEq(parseTimeToMinutes('14:30'), 870, '30-minute-boundary time parses correctly');
  assertEq(parseTimeToMinutes('09:40'), 580, '40-minute-boundary time parses correctly');

  assertEq(minutesToTime(420), '07:00', 'formats whole hours back to HH:MM');
  assertEq(minutesToTime(550), '09:10', 'formats a 10-minute-boundary value back to HH:MM');
  assertEq(minutesToTime(-5), null, 'negative minutes format as null rather than a garbled string');

  assertEq(formatTime12(420), '7:00 AM', 'formats a morning time as 12-hour clock');
  assertEq(formatTime12(0), '12:00 AM', 'formats midnight as 12:00 AM');
  assertEq(formatTime12(720), '12:00 PM', 'formats noon as 12:00 PM');
  assertEq(formatTime12(1380), '11:00 PM', 'formats 23:00 as 11:00 PM');
  assertEq(formatTime12(1440), '12:00 AM', 'wraps the extended 24:00 marker back to a normal 12:00 AM label');

  assertEq(dayOfWeekFor('2026-07-29'), 3, '2026-07-29 is a Wednesday (day 3)');
  assertEq(dayOfWeekFor('2026-08-02'), 0, '2026-08-02 is a Sunday (day 0)');
  assertEq(dayOfWeekFor('2026-07-27'), 1, '2026-07-27 is a Monday (day 1)');
  assertEq(dayOfWeekFor('not-a-date'), null, 'a malformed date key yields null rather than throwing');
  assertEq(dayOfWeekFor(null), null, 'a null date key yields null');

  assertEq(addDaysToKey('2026-07-29', 1), '2026-07-30', 'addDaysToKey steps forward a day');
  assertEq(addDaysToKey('2026-07-31', 1), '2026-08-01', 'addDaysToKey rolls across a month boundary');
  assertEq(addDaysToKey('2026-07-29', -1), '2026-07-28', 'addDaysToKey steps backward a day');
}

// ==================== normalization / malformed data ====================
{
  const empty = normalizeScheduleModel(null);
  assertEq(empty, { schemaVersion: SCHEDULE_SCHEMA_VERSION, timezone: 'America/New_York', profiles: [], overrides: {}, appointments: [] }, 'normalizing null yields a safe empty model, not a throw');
  assertEq(normalizeScheduleModel(undefined).profiles, [], 'normalizing undefined yields an empty profiles array');
  assertEq(normalizeScheduleModel('garbage').profiles, [], 'normalizing a non-object yields an empty profiles array');

  const droppedBlock = normalizeScheduleModel({
    profiles: [{
      id: 'p1', name: 'P1', effectiveStart: '2026-01-01', enabled: true,
      blocks: [
        { id: 'b1', days: [1], start: '07:00', end: '08:00', category: 'health', title: 'Good block' },
        { id: 'b2', days: [1], start: '07:00', title: 'Missing end time' },
        { id: 'b3', days: [1], start: '09:00', end: '08:00', category: 'health', title: 'End before start' },
        { id: 'b4', days: [], start: '07:00', end: '08:00', category: 'health', title: 'No days at all' },
        { title: 'No id' },
        null,
        'not an object',
      ],
    }],
  });
  assertEq(droppedBlock.profiles[0].blocks.map(b => b.id), ['b1'], 'malformed blocks (missing time, inverted range, no days, no id) are dropped, valid ones survive');

  const unknownCategory = normalizeScheduleModel({
    profiles: [{ id: 'p1', name: 'P1', effectiveStart: '2026-01-01', enabled: true, blocks: [{ id: 'b1', days: [1], start: '07:00', end: '08:00', category: 'nonsense', title: 'X' }] }],
  });
  assertEq(unknownCategory.profiles[0].blocks[0].category, 'free', 'an unrecognized category falls back to free rather than being rejected outright');

  const droppedProfile = normalizeScheduleModel({ profiles: [{ id: 'p1', name: 'no effectiveStart' }, null, 42] });
  assertEq(droppedProfile.profiles, [], 'a profile missing effectiveStart (or otherwise malformed) is dropped entirely');

  const overridesMalformed = normalizeScheduleModel({
    overrides: {
      '2026-08-05': { disabledBlockIds: ['x', 42, null], modifiedBlocks: { good: { start: '20:00', end: '22:00' }, bad: { start: '25:00', end: '22:00' } } },
      'not-a-date': { disabledBlockIds: ['x'] },
      '2026-08-06': {},
    },
  });
  assertEq(Object.keys(overridesMalformed.overrides), ['2026-08-05'], 'overrides keyed by a non-date or with no real content are dropped');
  assertEq(overridesMalformed.overrides['2026-08-05'].disabledBlockIds, ['x'], 'non-string entries in disabledBlockIds are filtered out');
  assertEq(Object.keys(overridesMalformed.overrides['2026-08-05'].modifiedBlocks), ['good'], 'a modifiedBlocks entry with an invalid time range is dropped');

  const apptMalformed = normalizeScheduleModel({
    appointments: [
      { id: 'a1', title: 'Dentist', date: '2026-08-06', start: '12:00' },
      { id: 'a2', title: 'Missing date', start: '12:00' },
      { title: 'Missing id', date: '2026-08-06', start: '12:00' },
    ],
  });
  assertEq(apptMalformed.appointments.map(a => a.id), ['a1'], 'appointments missing required fields are dropped, valid ones survive');
  assertEq(apptMalformed.appointments[0].end, '12:00', 'an appointment with no end time defaults its end to its start (point-in-time)');
}

// ==================== active profile selection / effective-date boundaries ====================
{
  const model = buildDefaultScheduleModel();
  assertEq(selectActiveProfile(model, '2026-07-28'), null, 'the day before the summer profile\'s effectiveStart selects no profile');
  assertTrue(selectActiveProfile(model, '2026-07-29').id === 'summer-2026', 'effectiveStart itself is inclusive');
  assertTrue(selectActiveProfile(model, '2026-08-31').id === 'summer-2026', 'effectiveEnd itself is inclusive');
  assertEq(selectActiveProfile(model, '2026-09-01'), null, 'the day after effectiveEnd selects no profile — the university placeholder stays disabled');
  assertEq(selectActiveProfile(model, '2027-01-01'), null, 'a date far outside any profile selects nothing');

  const overlap = normalizeScheduleModel({
    profiles: [
      { id: 'older', name: 'Older', effectiveStart: '2026-01-01', enabled: true, blocks: [] },
      { id: 'newer', name: 'Newer', effectiveStart: '2026-06-01', enabled: true, blocks: [] },
    ],
  });
  assertEq(selectActiveProfile(overlap, '2026-07-01').id, 'newer', 'when two enabled profiles overlap, the one with the later effectiveStart wins');
}

// ==================== Monday-Saturday recurrence + Sunday exclusion ====================
{
  const model = buildDefaultScheduleModel();
  const summer = model.profiles.find(p => p.id === 'summer-2026');
  const daysCovered = new Set();
  summer.blocks.forEach(b => b.days.forEach(d => daysCovered.add(d)));
  assertEq([...daysCovered].sort(), [1, 2, 3, 4, 5, 6], 'the summer profile covers Monday through Saturday and nothing else');
  assertTrue(!daysCovered.has(0), 'Sunday (day 0) is never covered by any summer block');

  ['2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01'].forEach(d => {
    assertTrue(resolveScheduleForDate(model, d).length > 0, 'Wed/Thu/Fri/Sat each resolve a non-empty schedule: ' + d);
  });
  assertEq(resolveScheduleForDate(model, '2026-08-02'), [], 'Sunday resolves to zero blocks even while the summer profile is active');
}

// ==================== hourly / partial-hour rendering ====================
{
  const model = buildDefaultScheduleModel();
  const wed = resolveScheduleForDate(model, '2026-07-29');
  const gym = wed.find(b => b.id.endsWith('0830-gym'));
  assertEq([gym.start, gym.end], ['08:30', '09:30'], 'an on-the-hour block resolves its exact start/end');
  const walk = wed.find(b => b.id.endsWith('0710-walk'));
  assertEq([walk.start, walk.end], ['07:10', '07:40'], 'a 10-minute-boundary block resolves correctly');
  const trainHome = wed.find(b => b.id.endsWith('1230-trainhome'));
  assertEq([trainHome.start, trainHome.end], ['12:30', '13:10'], 'a 30/40-minute-boundary block resolves correctly');
}

// ==================== date-specific overrides (one-day only) ====================
{
  const base = buildDefaultScheduleModel();
  const tuesdayBlockId = 'summer-2026:tue:1900-focus';
  const overridden = normalizeScheduleModel({
    ...base,
    overrides: { '2026-08-04': { disabledBlockIds: [], modifiedBlocks: { [tuesdayBlockId]: { start: '20:00', end: '22:00' } } } },
  });
  const thisTuesday = resolveScheduleForDate(overridden, '2026-08-04');
  const nextTuesday = resolveScheduleForDate(overridden, '2026-08-11');
  const moved = thisTuesday.find(b => b.id === tuesdayBlockId);
  assertEq([moved.start, moved.end], ['20:00', '22:00'], 'a date-specific override moves the block only on the overridden date');
  assertTrue(moved.isOverridden, 'the moved block is flagged as overridden for the UI');
  const untouched = nextTuesday.find(b => b.id === tuesdayBlockId);
  assertEq([untouched.start, untouched.end], ['19:00', '21:00'], 'the following Tuesday keeps the original recurring time — the override did not leak forward');
  assertTrue(!untouched.isOverridden, 'the untouched occurrence is not flagged as overridden');

  const thursdayParkless = 'summer-2026:thu:1030-study'; // stand-in recurring block to disable for one Thursday
  const disabledForADay = normalizeScheduleModel({
    ...base,
    overrides: { '2026-07-30': { disabledBlockIds: [thursdayParkless], modifiedBlocks: {} } },
  });
  const thatThursday = resolveScheduleForDate(disabledForADay, '2026-07-30');
  const nextThursday = resolveScheduleForDate(disabledForADay, '2026-08-06');
  assertTrue(!thatThursday.some(b => b.id === thursdayParkless), 'a disabled-for-one-date block is skipped that day');
  assertTrue(nextThursday.some(b => b.id === thursdayParkless), 'the same block still appears on a different occurrence — disabling did not touch the recurring definition');
}

// ==================== appointments overlay without hiding routine blocks ====================
{
  const withAppt = normalizeScheduleModel({
    ...buildDefaultScheduleModel(),
    appointments: [{ id: 'appt-1', title: 'Dentist', date: '2026-07-30', start: '12:00', end: '12:30' }],
  });
  const resolved = resolveScheduleForDate(withAppt, '2026-07-30');
  assertTrue(resolved.some(b => b.kind === 'block'), 'routine blocks are still present alongside an appointment');
  const appt = resolved.find(b => b.kind === 'appointment');
  assertTrue(!!appt && appt.title === 'Dentist', 'the appointment appears in the resolved timeline, clearly tagged kind:appointment');
  const idx = resolved.findIndex(b => b.id === 'appt-1');
  assertTrue(resolved[idx - 1].start <= '12:00' && resolved[idx + 1].start >= '12:00', 'the appointment is sorted into the timeline by its start time, not appended at the end');
}

// ==================== current / next block ====================
{
  const model = buildDefaultScheduleModel();
  const wed = resolveScheduleForDate(model, '2026-07-29');
  const at835 = currentAndNextForDate(wed, 8 * 60 + 35);
  assertEq(at835.current.title, 'Gym', 'nowMinutes inside a ranged block selects it as current');
  assertEq(at835.next.title, 'Train to Central Park via 96th Street', 'the next block after the current one is the very next start time');

  const atWake = currentAndNextForDate(wed, 7 * 60);
  assertEq(atWake.current.title, 'Wake up', 'an instantaneous milestone block is current only at its exact minute');
  const oneMinuteAfterWake = currentAndNextForDate(wed, 7 * 60 + 1);
  assertTrue(!oneMinuteAfterWake.current || oneMinuteAfterWake.current.title !== 'Wake up', 'the instantaneous milestone is no longer current one minute later');

  const lateNight = currentAndNextForDate(wed, 23 * 60 + 30);
  assertEq(lateNight.next, null, 'after the last block of the day, next is null rather than wrapping to tomorrow');

  const fri = resolveScheduleForDate(model, '2026-07-31');
  const extended = currentAndNextForDate(fri, 23 * 60 + 30);
  assertEq(extended.current.title, 'Free, social, or recovery time', 'a block using the extended 24:00 end marker is still current right up until midnight');
}

// ==================== September profile handoff (no invented university schedule) ====================
{
  const uni = buildUniversity2026Placeholder();
  assertEq(uni.enabled, false, 'the university placeholder ships disabled');
  assertEq(uni.blocks, [], 'the university placeholder has zero blocks — no invented class times');
  assertEq(uni.placeholder, true, 'the university profile is explicitly flagged as a placeholder for UI messaging');

  const model = buildDefaultScheduleModel();
  assertEq(resolveScheduleForDate(model, '2026-09-15'), [], 'September dates resolve to an empty schedule rather than a fabricated one, since the placeholder never auto-activates');
  const forced = normalizeScheduleModel({ ...model, profiles: model.profiles.map(p => p.id === 'university-2026' ? { ...p, enabled: true } : p) });
  assertTrue(selectActiveProfile(forced, '2026-09-15').id === 'university-2026', 'explicitly enabling the placeholder does make it selectable — the guard is "disabled by default", not "impossible to enable"');
  assertEq(resolveScheduleForDate(forced, '2026-09-15'), [], 'even once enabled, the placeholder still contributes zero blocks until Fernando supplies real ones');
}

// ==================== summer data spot-checks against the approved schedule ====================
{
  const profile = buildSummer2026Profile();
  assertEq(profile.effectiveStart, '2026-07-29', 'summer profile starts July 29, 2026');
  assertEq(profile.effectiveEnd, '2026-08-31', 'summer profile ends August 31, 2026');
  assertEq(profile.timezone, 'America/New_York', 'summer profile is anchored to America/New_York');
  assertTrue(CATEGORIES.includes('business') && CATEGORIES.includes('creative') && CATEGORIES.includes('study'), 'all evening-focus categories are valid categories');

  const byDay = d => profile.blocks.filter(b => b.days.includes(d));
  assertEq(byDay(1).find(b => b.title.includes('Studying')).category, 'study', 'Monday evening focus is studying/university prep');
  assertEq(byDay(2).find(b => b.title.includes('Business development')).category, 'business', 'Tuesday evening focus is business development');
  assertEq(byDay(3).find(b => b.title.includes('Creative work')).category, 'creative', 'Wednesday evening focus is creative work');
  assertTrue(!byDay(4).some(b => b.title.includes('Central Park')), 'Thursday has no Central Park block');
  assertTrue(!byDay(6).some(b => b.category === 'health' && b.title === 'Gym'), 'Saturday has no gym block');
  assertEq(byDay(6).find(b => b.title === 'Wake up').start, '09:00', 'Saturday wake-up is later (9 AM) than the weekday 7 AM');
}

console.log('\n---', pass, 'passed,', fail, 'failed ---');
process.exit(fail > 0 ? 1 : 0);
