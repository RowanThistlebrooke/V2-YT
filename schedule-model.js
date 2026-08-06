// Weekly Schedule System — pure data model and normalization logic.
// No DOM, no storage, no network: schedule.html, the Telegram assistant
// (future PR), and tests all share this exact module so "what's my
// schedule right now" never disagrees between surfaces.
//
// Schema v1 shape (see normalizeScheduleModel):
//   {
//     schemaVersion, timezone,
//     profiles: [{ id, name, timezone, effectiveStart, effectiveEnd, enabled,
//                  placeholder, blocks: [{ id, days, start, end, category,
//                  title, location, notes, enabled, googleEventId,
//                  googleSyncStatus, googleSyncError }] }],
//     overrides: { '<dateKey>': { disabledBlockIds: [...], modifiedBlocks: { blockId: { start, end } } } },
//     appointments: [{ id, date, start, end, title, location, notes,
//                      googleEventId, syncStatus, syncError }],
//   }
//
// Migration behavior: normalizeScheduleModel() is the single entry point
// for reading any persisted or remote copy of this model. An older/missing
// schemaVersion is upgraded one step at a time inside migrate(); nothing
// else in this file (or any consumer) should read a raw model directly.

export const SCHEDULE_SCHEMA_VERSION = 1;
export const SCHEDULE_TIMEZONE = 'America/New_York';

export const CATEGORIES = ['health', 'travel', 'work', 'study', 'business', 'creative', 'meals', 'recovery', 'free'];

export const CATEGORY_COLORS = {
  health: '#6BE3A4',
  travel: '#7DD3FC',
  work: '#F2C063',
  study: '#C4B5FD',
  business: '#FBBC05',
  creative: '#F783AC',
  meals: '#FF9F6B',
  recovery: '#22D3F5',
  free: '#94A3B8',
};

export const CATEGORY_LABELS = {
  health: 'Health', travel: 'Travel', work: 'Work', study: 'Study',
  business: 'Business', creative: 'Creative', meals: 'Meals', recovery: 'Recovery', free: 'Free time',
};

// ==================== time helpers ====================

// Accepts 'HH:MM' where HH may run 0-24 (24:00 means midnight at the END
// of the block's own day, not the start of the next one) so a Friday/
// Saturday routine that runs past midnight stays attached to the day it
// conceptually belongs to instead of spilling into the next day's column.
export function parseTimeToMinutes(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (min < 0 || min > 59) return null;
  if (h < 0 || h > 24) return null;
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

export function minutesToTime(total) {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  const h = Math.floor(total / 60), m = Math.round(total % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Formats for display, wrapping a 24:00+ "extended" minute value back into
// a normal 12-hour clock face (1440 -> 12:00 AM) — the wrap only affects
// the label, never the stored/sort value.
export function formatTime12(total) {
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return '';
  const wrapped = ((total % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60), m = wrapped % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

// Pure calendar-date day-of-week (0=Sun..6=Sat) that never depends on the
// host's local timezone — dateKey is a plain calendar date, not an
// instant, so anchoring it at UTC midnight is only ever used to read back
// the weekday, never to compute a real timestamp.
export function dayOfWeekFor(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const d = new Date(dateKey + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

export function addDaysToKey(dateKey, days) {
  const d = new Date(dateKey + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ==================== normalization ====================

function asString(v, fallback) { return typeof v === 'string' && v ? v : fallback; }
function asBool(v, fallback) { return typeof v === 'boolean' ? v : fallback; }

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id, null);
  const title = asString(raw.title, null);
  const start = parseTimeToMinutes(raw.start);
  const end = parseTimeToMinutes(raw.end);
  if (!id || !title || start == null || end == null || end < start) return null;
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'free';
  const days = Array.isArray(raw.days) ? raw.days.filter(d => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  if (!days.length) return null;
  return {
    id, title, category, days: [...new Set(days)].sort(),
    start: raw.start.trim(), end: raw.end.trim(),
    location: asString(raw.location, ''),
    notes: asString(raw.notes, ''),
    enabled: asBool(raw.enabled, true),
    googleEventId: asString(raw.googleEventId, null),
    googleSyncStatus: asString(raw.googleSyncStatus, 'idle'),
    googleSyncError: asString(raw.googleSyncError, null),
    // A stable signature of the fields that matter to Google (title/time/
    // days/location/notes) as of the last successful push — lets
    // schedule-google.js's planSyncActions() tell "never synced" apart
    // from "synced, but this field changed since" apart from "already in
    // sync, nothing to do" without re-reading Google on every check.
    googleContentSignature: asString(raw.googleContentSignature, null),
  };
}

function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id, null);
  const name = asString(raw.name, null);
  const effectiveStart = /^\d{4}-\d{2}-\d{2}$/.test(raw.effectiveStart || '') ? raw.effectiveStart : null;
  if (!id || !name || !effectiveStart) return null;
  const effectiveEnd = /^\d{4}-\d{2}-\d{2}$/.test(raw.effectiveEnd || '') ? raw.effectiveEnd : null;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks.map(normalizeBlock).filter(Boolean) : [];
  return {
    id, name, effectiveStart, effectiveEnd,
    timezone: asString(raw.timezone, SCHEDULE_TIMEZONE),
    enabled: asBool(raw.enabled, true),
    placeholder: asBool(raw.placeholder, false),
    blocks,
  };
}

function normalizeAppointment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = asString(raw.id, null);
  const title = asString(raw.title, null);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : null;
  const start = parseTimeToMinutes(raw.start);
  if (!id || !title || !date || start == null) return null;
  const end = parseTimeToMinutes(raw.end);
  return {
    id, title, date,
    start: raw.start.trim(),
    end: end != null && end >= start ? raw.end.trim() : raw.start.trim(),
    location: asString(raw.location, ''),
    notes: asString(raw.notes, ''),
    googleEventId: asString(raw.googleEventId, null),
    syncStatus: asString(raw.syncStatus, 'local'),
    syncError: asString(raw.syncError, null),
    googleContentSignature: asString(raw.googleContentSignature, null),
  };
}

function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).forEach(dateKey => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    const entry = raw[dateKey];
    if (!entry || typeof entry !== 'object') return;
    const disabledBlockIds = Array.isArray(entry.disabledBlockIds)
      ? entry.disabledBlockIds.filter(id => typeof id === 'string' && id)
      : [];
    const modifiedBlocks = {};
    if (entry.modifiedBlocks && typeof entry.modifiedBlocks === 'object') {
      Object.keys(entry.modifiedBlocks).forEach(blockId => {
        const mod = entry.modifiedBlocks[blockId];
        if (!mod || typeof mod !== 'object') return;
        const start = parseTimeToMinutes(mod.start);
        const end = parseTimeToMinutes(mod.end);
        if (start == null || end == null || end < start) return;
        modifiedBlocks[blockId] = { start: mod.start.trim(), end: mod.end.trim() };
      });
    }
    // Which block ids' Google-side instance exception has already been
    // applied for this date — lets schedule-google.js's planOverrideActions
    // stop re-planning an override as "pending" forever once it has
    // actually landed on Google (re-applying it would be harmless/
    // idempotent, but would never let the pending count reach zero).
    const appliedBlockIds = Array.isArray(entry.appliedBlockIds) ? entry.appliedBlockIds.filter(id => typeof id === 'string' && id) : [];
    if (disabledBlockIds.length || Object.keys(modifiedBlocks).length) {
      out[dateKey] = { disabledBlockIds, modifiedBlocks, appliedBlockIds };
    }
  });
  return out;
}

function migrate(raw) {
  // v1 is the current baseline — nothing to migrate yet. Future versions
  // should add "if (version < N) { ... }" steps here, one at a time, so
  // a model can walk forward from any prior version without a rewrite.
  return raw && typeof raw === 'object' ? raw : {};
}

export function normalizeScheduleModel(raw) {
  const migrated = migrate(raw);
  const profiles = Array.isArray(migrated.profiles) ? migrated.profiles.map(normalizeProfile).filter(Boolean) : [];
  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timezone: asString(migrated.timezone, SCHEDULE_TIMEZONE),
    profiles,
    overrides: normalizeOverrides(migrated.overrides),
    appointments: Array.isArray(migrated.appointments) ? migrated.appointments.map(normalizeAppointment).filter(Boolean) : [],
  };
}

// ==================== summer-2026 seed data ====================

function block(id, days, start, end, category, title, extra) {
  return Object.assign({ id, days, start, end, category, title, location: '', notes: '', enabled: true, googleEventId: null, googleSyncStatus: 'idle', googleSyncError: null }, extra || {});
}

function buildSummer2026Blocks() {
  const MWW = [1, 2, 3]; // Monday, Tuesday, Wednesday share everything but the evening focus block
  const shared = [
    block('summer-2026:mon-wed:0700-wake', MWW, '07:00', '07:00', 'health', 'Wake up'),
    block('summer-2026:mon-wed:0710-walk', MWW, '07:10', '07:40', 'health', 'Morning walk'),
    block('summer-2026:mon-wed:0740-breakfast', MWW, '07:40', '08:15', 'meals', 'Breakfast, shower, and gym preparation'),
    block('summer-2026:mon-wed:0815-walktogym', MWW, '08:15', '08:30', 'travel', 'Walk to gym'),
    block('summer-2026:mon-wed:0830-gym', MWW, '08:30', '09:30', 'health', 'Gym'),
    block('summer-2026:mon-wed:0930-traintopark', MWW, '09:30', '10:00', 'travel', 'Train to Central Park via 96th Street'),
    block('summer-2026:mon-wed:1000-park', MWW, '10:00', '12:30', 'health', 'Central Park walk'),
    block('summer-2026:mon-wed:1230-trainhome', MWW, '12:30', '13:10', 'travel', 'Train home'),
    block('summer-2026:mon-wed:1310-lunch', MWW, '13:10', '14:00', 'meals', 'Lunch, shower, and recovery'),
    block('summer-2026:mon-wed:1400-preptowork', MWW, '14:00', '15:00', 'travel', 'Prepare and travel to work'),
    block('summer-2026:mon-wed:1500-work', MWW, '15:00', '18:00', 'work', 'Work and commute home'),
    block('summer-2026:mon-wed:1800-dinner', MWW, '18:00', '19:00', 'meals', 'Dinner and decompression'),
    block('summer-2026:mon-wed:2100-free', MWW, '21:00', '22:00', 'free', 'Free time'),
    block('summer-2026:mon-wed:2200-windown', MWW, '22:00', '23:00', 'recovery', 'Prepare for tomorrow and wind down'),
    block('summer-2026:mon-wed:2300-sleep', MWW, '23:00', '23:00', 'recovery', 'Sleep target'),
  ];
  const eveningFocus = [
    block('summer-2026:mon:1900-focus', [1], '19:00', '21:00', 'study', 'Studying / university preparation'),
    block('summer-2026:tue:1900-focus', [2], '19:00', '21:00', 'business', 'Business development'),
    block('summer-2026:wed:1900-focus', [3], '19:00', '21:00', 'creative', 'Creative work and personal projects'),
  ];
  const thursday = [
    block('summer-2026:thu:0700-wake', [4], '07:00', '07:00', 'health', 'Wake up'),
    block('summer-2026:thu:0710-walk', [4], '07:10', '07:40', 'health', 'Morning walk'),
    block('summer-2026:thu:0740-breakfast', [4], '07:40', '08:15', 'meals', 'Breakfast, shower, and gym preparation'),
    block('summer-2026:thu:0815-walktogym', [4], '08:15', '08:30', 'travel', 'Walk to gym'),
    block('summer-2026:thu:0830-gym', [4], '08:30', '09:30', 'health', 'Gym'),
    block('summer-2026:thu:0930-walkhome', [4], '09:30', '09:45', 'travel', 'Walk home'),
    block('summer-2026:thu:0945-recoverymeal', [4], '09:45', '10:30', 'recovery', 'Shower and recovery meal'),
    block('summer-2026:thu:1030-study', [4], '10:30', '12:00', 'study', 'Study block'),
    block('summer-2026:thu:1200-bizcreative', [4], '12:00', '13:00', 'business', 'Business or creative work'),
    block('summer-2026:thu:1300-lunch', [4], '13:00', '14:00', 'meals', 'Lunch and free time'),
    block('summer-2026:thu:1400-preptowork', [4], '14:00', '15:00', 'travel', 'Prepare and travel to work'),
    block('summer-2026:thu:1500-work', [4], '15:00', '20:00', 'work', 'Work and commute home'),
    block('summer-2026:thu:2000-dinner', [4], '20:00', '21:00', 'meals', 'Dinner, shower, and decompression'),
    block('summer-2026:thu:2100-lightstudy', [4], '21:00', '22:00', 'study', 'Light studying or preparation'),
    block('summer-2026:thu:2200-winddown', [4], '22:00', '23:00', 'free', 'Free time and wind-down'),
    block('summer-2026:thu:2300-sleep', [4], '23:00', '23:00', 'recovery', 'Sleep target'),
  ];
  const friday = [
    block('summer-2026:fri:0700-wake', [5], '07:00', '07:00', 'health', 'Wake up'),
    block('summer-2026:fri:0710-walk', [5], '07:10', '07:40', 'health', 'Morning walk'),
    block('summer-2026:fri:0740-breakfast', [5], '07:40', '08:15', 'meals', 'Breakfast, shower, and gym preparation'),
    block('summer-2026:fri:0815-walktogym', [5], '08:15', '08:30', 'travel', 'Walk to gym'),
    block('summer-2026:fri:0830-gym', [5], '08:30', '09:30', 'health', 'Gym'),
    block('summer-2026:fri:0930-traintopark', [5], '09:30', '10:00', 'travel', 'Train to Central Park'),
    block('summer-2026:fri:1000-park', [5], '10:00', '12:30', 'health', 'Central Park walk'),
    block('summer-2026:fri:1230-trainhome', [5], '12:30', '13:10', 'travel', 'Train home'),
    block('summer-2026:fri:1310-lunch', [5], '13:10', '14:00', 'meals', 'Lunch and shower'),
    block('summer-2026:fri:1400-preptowork', [5], '14:00', '15:00', 'travel', 'Prepare and travel to work'),
    block('summer-2026:fri:1500-work', [5], '15:00', '20:00', 'work', 'Work and commute home'),
    block('summer-2026:fri:2000-dinner', [5], '20:00', '21:00', 'meals', 'Dinner and decompression'),
    block('summer-2026:fri:2100-free', [5], '21:00', '24:00', 'free', 'Free, social, or recovery time'),
    block('summer-2026:fri:2400-sleep', [5], '24:00', '24:00', 'recovery', 'Sleep target'),
  ];
  const saturday = [
    block('summer-2026:sat:0900-wake', [6], '09:00', '09:00', 'health', 'Wake up'),
    block('summer-2026:sat:0910-walk', [6], '09:10', '09:40', 'health', 'Morning walk'),
    block('summer-2026:sat:0940-breakfast', [6], '09:40', '10:30', 'meals', 'Breakfast and shower'),
    block('summer-2026:sat:1030-deepwork', [6], '10:30', '12:30', 'business', 'Business or creative deep work'),
    block('summer-2026:sat:1230-lunch', [6], '12:30', '13:30', 'meals', 'Lunch and free time'),
    block('summer-2026:sat:1330-preptowork', [6], '13:30', '14:30', 'travel', 'Prepare and travel to work'),
    block('summer-2026:sat:1500-work', [6], '15:00', '20:00', 'work', 'Work and commute home'),
    block('summer-2026:sat:2000-dinner', [6], '20:00', '21:00', 'meals', 'Dinner and decompression'),
    block('summer-2026:sat:2100-review', [6], '21:00', '22:00', 'business', 'Weekly review, appointments, and next-week planning'),
    block('summer-2026:sat:2200-free', [6], '22:00', '24:00', 'free', 'Free or social time'),
    block('summer-2026:sat:2400-sleep', [6], '24:00', '24:00', 'recovery', 'Sleep target'),
  ];
  return [...shared, ...eveningFocus, ...thursday, ...friday, ...saturday];
}

export function buildSummer2026Profile() {
  return {
    id: 'summer-2026',
    name: 'Summer 2026',
    timezone: SCHEDULE_TIMEZONE,
    effectiveStart: '2026-07-29',
    effectiveEnd: '2026-08-31',
    enabled: true,
    placeholder: false,
    blocks: buildSummer2026Blocks(),
  };
}

// Disabled on purpose: university starts in September but Fernando hasn't
// supplied real class times yet. This profile exists so the assistant and
// dashboard have somewhere to point ("your university schedule isn't set
// up yet") without ever inventing or auto-activating class times.
export function buildUniversity2026Placeholder() {
  return {
    id: 'university-2026',
    name: 'University 2026 (not yet configured)',
    timezone: SCHEDULE_TIMEZONE,
    effectiveStart: '2026-09-01',
    effectiveEnd: null,
    enabled: false,
    placeholder: true,
    blocks: [],
  };
}

export function buildDefaultScheduleModel() {
  return normalizeScheduleModel({
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timezone: SCHEDULE_TIMEZONE,
    profiles: [buildSummer2026Profile(), buildUniversity2026Placeholder()],
    overrides: {},
    appointments: [],
  });
}

// ==================== active profile / resolved-day queries ====================

// If more than one enabled profile's date range covers dateKey (shouldn't
// normally happen), the one with the latest effectiveStart wins as the
// more specific/most recent choice.
export function selectActiveProfile(model, dateKey) {
  if (!model || !Array.isArray(model.profiles)) return null;
  const candidates = model.profiles.filter(p => p.enabled
    && dateKey >= p.effectiveStart
    && (!p.effectiveEnd || dateKey <= p.effectiveEnd));
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (a.effectiveStart < b.effectiveStart ? 1 : -1))[0];
}

function applyOverridesToBlocks(blocks, dateKey, overrides) {
  const forDate = (overrides && overrides[dateKey]) || null;
  if (!forDate) return blocks.map(b => ({ ...b, isOverridden: false }));
  const disabled = new Set(forDate.disabledBlockIds || []);
  return blocks
    .filter(b => !disabled.has(b.id))
    .map(b => {
      const mod = forDate.modifiedBlocks && forDate.modifiedBlocks[b.id];
      if (!mod) return { ...b, isOverridden: false };
      return { ...b, start: mod.start, end: mod.end, isOverridden: true };
    });
}

// Resolves everything that should render on dateKey: the active profile's
// recurring blocks (Sunday naturally yields none, since no seeded profile
// schedules day 0) with that date's overrides applied, plus any
// appointments on that date — sorted into one timeline, blocks and
// appointments clearly tagged so the UI never conflates them.
export function resolveScheduleForDate(model, dateKey) {
  const dow = dayOfWeekFor(dateKey);
  if (dow == null) return [];
  const profile = selectActiveProfile(model, dateKey);
  const recurring = profile
    ? applyOverridesToBlocks(profile.blocks.filter(b => b.enabled && b.days.includes(dow)), dateKey, model.overrides)
    : [];
  const resolvedBlocks = recurring.map(b => ({
    kind: 'block',
    id: b.id,
    category: b.category,
    title: b.title,
    start: b.start,
    end: b.end,
    startMinutes: parseTimeToMinutes(b.start),
    endMinutes: parseTimeToMinutes(b.end),
    location: b.location,
    notes: b.notes,
    isOverridden: b.isOverridden,
    profileId: profile ? profile.id : null,
    googleEventId: b.googleEventId,
    googleSyncStatus: b.googleSyncStatus,
  }));
  const appointments = (model.appointments || [])
    .filter(a => a.date === dateKey)
    .map(a => ({
      kind: 'appointment',
      id: a.id,
      category: 'appointment',
      title: a.title,
      start: a.start,
      end: a.end,
      startMinutes: parseTimeToMinutes(a.start),
      endMinutes: parseTimeToMinutes(a.end),
      location: a.location,
      notes: a.notes,
      isOverridden: false,
      profileId: null,
      googleEventId: a.googleEventId,
      googleSyncStatus: a.syncStatus,
    }));
  return resolvedBlocks.concat(appointments).sort((x, y) => {
    if (x.startMinutes !== y.startMinutes) return x.startMinutes - y.startMinutes;
    return x.kind === y.kind ? 0 : (x.kind === 'block' ? -1 : 1);
  });
}

// current: the resolved item whose [start,end) contains nowMinutes (a
// zero-duration "milestone" item is only ever current at its exact
// minute). next: the first item whose start is strictly after nowMinutes.
export function currentAndNextForDate(resolved, nowMinutes) {
  const list = Array.isArray(resolved) ? resolved : [];
  let current = null, next = null;
  for (const item of list) {
    const isInstant = item.endMinutes === item.startMinutes;
    if (isInstant ? item.startMinutes === nowMinutes : (item.startMinutes <= nowMinutes && nowMinutes < item.endMinutes)) {
      current = current || item;
    }
    if (item.startMinutes > nowMinutes && !next) next = item;
  }
  return { current, next };
}
