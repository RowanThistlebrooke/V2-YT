export const ALERT_STATE_KEY = 'command_center_alerts_v1';

export function normalizeAlertState(value) {
  const input = value && typeof value === 'object' ? value : {};
  const source = input.dismissed && typeof input.dismissed === 'object' ? input.dismissed : {};
  const dismissed = {};
  Object.keys(source).forEach(id => {
    const timestamp = Number(source[id]);
    if (Number.isFinite(timestamp) && timestamp > 0) dismissed[id] = timestamp;
  });
  return { version: 1, dismissed };
}

export function dismissAlert(state, alertId, dismissedAt) {
  const current = normalizeAlertState(state);
  if (!alertId) return current;
  return {
    version: 1,
    dismissed: { ...current.dismissed, [alertId]: dismissedAt == null ? Date.now() : dismissedAt },
  };
}

export function reconcileAlertState(state, activeIds) {
  const current = normalizeAlertState(state);
  const active = new Set(activeIds || []);
  const dismissed = {};
  Object.keys(current.dismissed).forEach(id => { if (active.has(id)) dismissed[id] = current.dismissed[id]; });
  const changed = Object.keys(dismissed).length !== Object.keys(current.dismissed).length;
  return { state: { version: 1, dismissed }, changed };
}

export function visibleAlerts(alerts, state) {
  const current = normalizeAlertState(state);
  return (Array.isArray(alerts) ? alerts : []).filter(alert => alert && alert.id && !current.dismissed[alert.id]);
}
