// Pure recommendation logic for the Command Center. This module reads no
// storage and touches no DOM so the homepage and tests share one ranking rule.

export function timeToMinutes(value) {
  if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [hours, minutes] = value.split(':').map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function formatClock(value) {
  const total = timeToMinutes(value);
  if (total == null) return '';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return hour12 + ':' + String(minutes).padStart(2, '0') + ' ' + suffix;
}

export function selectRecommendedAction(goals, nowMinutes, leverageStats) {
  const list = Array.isArray(goals) ? goals : [];
  const pending = list
    .map((goal, index) => ({ goal, index }))
    .filter(item => item.goal && item.goal.text && !item.goal.done);

  if (!pending.length) return null;

  const timed = pending
    .map(item => ({ ...item, minutes: timeToMinutes(item.goal.time) }))
    .filter(item => item.minutes != null)
    .sort((a, b) => a.minutes - b.minutes);
  const overdue = timed.find(item => item.minutes < nowMinutes);
  if (overdue) {
    return {
      kind: 'overdue',
      index: overdue.index,
      title: overdue.goal.text,
      time: overdue.goal.time,
      eyebrow: 'Needs attention',
      reason: 'Scheduled for ' + formatClock(overdue.goal.time) + ' and still open.',
      href: 'main.html',
    };
  }

  const leverage = pending.find(item => item.goal.leverage);
  if (leverage) {
    const streak = leverageStats && Number(leverageStats.streak) > 0
      ? ' Protect your ' + Number(leverageStats.streak) + '-day follow-through streak.'
      : ' This is the one task you marked as highest leverage.';
    return {
      kind: 'leverage',
      index: leverage.index,
      title: leverage.goal.text,
      time: leverage.goal.time || null,
      eyebrow: 'Leverage pick',
      reason: streak.trim(),
      href: 'main.html',
    };
  }

  const upcoming = timed.find(item => item.minutes >= nowMinutes);
  const queued = pending.find(item => item.goal.queued);
  const fallback = upcoming || queued || pending[0];
  const reason = upcoming
    ? 'Next scheduled item at ' + formatClock(upcoming.goal.time) + '.'
    : queued
      ? 'Queued for your next productive window.'
      : 'First open item on today\'s list.';
  return {
    kind: upcoming ? 'scheduled' : queued ? 'queued' : 'todo',
    index: fallback.index,
    title: fallback.goal.text,
    time: fallback.goal.time || null,
    eyebrow: upcoming ? 'Up next' : queued ? 'Queued action' : 'Next action',
    reason,
    href: 'main.html',
  };
}

export function completeRecommendedAction(goals, index, completedAt) {
  const list = Array.isArray(goals) ? goals.map(goal => ({ ...goal })) : [];
  if (!list[index] || list[index].done) return list;
  list[index].done = true;
  list[index].doneAt = completedAt == null ? Date.now() : completedAt;
  return list;
}
