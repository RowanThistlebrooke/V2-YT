const SIGNAL_TOTAL = 6;

function plural(count, singular, pluralForm) {
  return count + ' ' + (count === 1 ? singular : (pluralForm || singular + 's'));
}

function latestSleepEntry(nights) {
  const source = nights && typeof nights === 'object' ? nights : {};
  const key = Object.keys(source).filter(date => source[date]).sort().slice(-1)[0];
  return key ? { dateKey: key, ...source[key] } : null;
}

function nextDateKey(dateKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.getUTCFullYear() + '-' + String(next.getUTCMonth() + 1).padStart(2, '0') + '-' + String(next.getUTCDate()).padStart(2, '0');
}

function sourceCoverage(data, latestSleep) {
  const sources = [
    Array.isArray(data.goals) && data.goals.length > 0,
    Array.isArray(data.schedule) && data.schedule.length > 0,
    !!latestSleep,
    !!(data.waterProgress && Number.isFinite(Number(data.waterProgress.total))),
    !!(data.streak && Number(data.streak.days) > 0) || !!(data.workoutDays && data.todayKey && data.workoutDays[data.todayKey]),
    !!data.trend,
  ];
  const connected = sources.filter(Boolean).length;
  return {
    connected,
    total: SIGNAL_TOTAL,
    confidence: connected >= 5 ? 'High confidence' : connected >= 3 ? 'Medium confidence' : 'Building context',
  };
}

function addCandidate(list, candidate) {
  if (!candidate || !candidate.title) return;
  list.push({ tone: 'neutral', ...candidate });
}

function selectItems(candidates) {
  const seen = new Set();
  return candidates
    .sort((a, b) => b.priority - a.priority)
    .filter(item => {
      const key = item.label + ':' + item.href;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3)
    .map(({ priority, ...item }) => item);
}

export function getBriefPeriod(now) {
  const hour = new Date(now == null ? Date.now() : now).getHours();
  return hour >= 5 && hour < 18 ? 'morning' : 'evening';
}

export function buildDailyBrief(input, now) {
  const data = input || {};
  const timestamp = now == null ? Date.now() : now;
  const period = getBriefPeriod(timestamp);
  const goals = Array.isArray(data.goals) ? data.goals : [];
  const completed = goals.filter(goal => goal && goal.done).length;
  const remaining = goals.filter(goal => goal && !goal.done).length;
  const latestSleep = latestSleepEntry(data.sleepNights);
  const sleepHours = latestSleep && Number(latestSleep.sleepHours) > 0 ? Number(latestSleep.sleepHours) : null;
  const schedule = Array.isArray(data.schedule) ? data.schedule : [];
  const upcoming = schedule.find(item => item && !item.done && item.isNext) || schedule.find(item => item && !item.done);
  const water = data.waterProgress || null;
  const alertCount = Math.max(0, Number(data.alertCount) || 0);
  const tomorrowKey = nextDateKey(data.todayKey);
  const tomorrowGoals = tomorrowKey && data.goalsByDate && Array.isArray(data.goalsByDate[tomorrowKey]) ? data.goalsByDate[tomorrowKey] : [];
  const coverage = sourceCoverage(data, latestSleep);
  const candidates = [];

  if (period === 'morning') {
    if (data.action) {
      addCandidate(candidates, {
        priority: 100, tone: data.action.kind === 'overdue' ? 'critical' : 'active', icon: '→', label: 'Next move',
        title: data.action.title, detail: data.action.reason || 'Protect one clear win before adding more.', href: data.action.href || 'main.html',
      });
    } else if (goals.length && remaining === 0) {
      addCandidate(candidates, { priority: 100, tone: 'good', icon: '✓', label: 'Priorities', title: 'Today’s objectives are complete', detail: 'Keep the board clear or plan the next meaningful block.', href: 'main.html' });
    } else {
      addCandidate(candidates, { priority: 100, icon: '+', label: 'Next move', title: 'Set one objective for today', detail: 'One clear outcome gives the Command Center something useful to protect.', href: 'main.html' });
    }

    if (sleepHours != null) {
      addCandidate(candidates, {
        priority: sleepHours < 7 ? 90 : 55, tone: sleepHours < 7 ? 'warn' : 'good', icon: '◐', label: 'Recovery',
        title: sleepHours.toFixed(1).replace('.0', '') + ' hours logged',
        detail: sleepHours < 7 ? 'Keep the first work block focused and leave recovery room later.' : 'Your sleep base supports a normal workload today.', href: 'sleep.html',
      });
    } else {
      addCandidate(candidates, { priority: 35, icon: '◐', label: 'Recovery', title: 'Log last night’s sleep', detail: 'Sleep adds context to today’s workload and recovery guidance.', href: 'sleep.html' });
    }

    if (alertCount) addCandidate(candidates, { priority: 85, tone: 'warn', icon: '!', label: 'Watch', title: plural(alertCount, 'signal') + ' need attention', detail: 'Clear the most urgent one before it competes with your main priority.', href: '#ccAlerts' });
    if (upcoming) addCandidate(candidates, { priority: 72, tone: 'active', icon: '◷', label: 'Schedule', title: upcoming.title, detail: upcoming.time ? 'Next scheduled block · ' + upcoming.time : 'Next item on today’s schedule.', href: upcoming.href || 'main.html' });
    if (water) addCandidate(candidates, { priority: water.ratio < 0.5 ? 68 : 38, tone: water.ratio < 0.5 ? 'warn' : 'good', icon: '◒', label: 'Hydration', title: water.done + ' of ' + water.total + ' logged', detail: water.ratio < 0.5 ? 'An early drink is the fastest controllable improvement.' : 'Hydration is moving with the day.', href: 'health.html#water' });
    else addCandidate(candidates, { priority: 25, icon: '◒', label: 'Hydration', title: 'Set your hydration profile', detail: 'A target lets the brief track pacing instead of guessing.', href: 'health.html#water' });

    const title = data.action
      ? 'Protect the next win: ' + data.action.title
      : goals.length && remaining === 0 ? 'The board is clear—choose what deserves the extra room' : 'Give today one clear target';
    const summary = [
      sleepHours != null ? (sleepHours < 7 ? 'Recovery is constrained after ' + sleepHours.toFixed(1).replace('.0', '') + ' hours of sleep.' : 'You have ' + sleepHours.toFixed(1).replace('.0', '') + ' hours of sleep logged.') : 'Recovery context is waiting on a sleep log.',
      schedule.length ? plural(schedule.length, 'scheduled block') + ' ' + (schedule.length === 1 ? 'is' : 'are') + ' on the board.' : 'Your schedule is open right now.',
    ].join(' ');
    return { period, eyebrow: 'Daily briefing', title, summary, items: selectItems(candidates), coverage };
  }

  addCandidate(candidates, {
    priority: 100, tone: goals.length && completed === goals.length ? 'good' : remaining ? 'warn' : 'neutral', icon: goals.length && completed === goals.length ? '✓' : '◎', label: 'Day progress',
    title: goals.length ? completed + ' of ' + goals.length + ' objectives complete' : 'No objectives were set today',
    detail: remaining ? plural(remaining, 'item') + ' still open—finish one or move it deliberately.' : goals.length ? 'The day’s task board is clear.' : 'A quick review can still capture what mattered.', href: 'main.html',
  });
  if (data.action) addCandidate(candidates, { priority: 90, tone: data.action.kind === 'overdue' ? 'critical' : 'active', icon: '→', label: 'Open loop', title: data.action.title, detail: 'Close it now or move it intentionally so it does not become tomorrow’s noise.', href: data.action.href || 'main.html' });
  if (alertCount) addCandidate(candidates, { priority: 86, tone: 'warn', icon: '!', label: 'Watch', title: plural(alertCount, 'signal') + ' still active', detail: 'Review the alert list before ending the day.', href: '#ccAlerts' });
  if (water) addCandidate(candidates, { priority: water.ratio < 1 ? 80 : 48, tone: water.ratio < 0.75 ? 'warn' : 'good', icon: '◒', label: 'Hydration', title: water.done + ' of ' + water.total + ' logged', detail: water.ratio < 1 ? 'You are ' + Math.max(0, water.total - water.done) + ' short of today’s target.' : 'Today’s hydration target is covered.', href: 'health.html#water' });
  if (tomorrowGoals.length) addCandidate(candidates, { priority: 75, tone: 'active', icon: '↗', label: 'Tomorrow', title: plural(tomorrowGoals.length, 'objective') + ' already staged', detail: 'Tomorrow has a starting point; keep the first block realistic.', href: 'main.html' });
  else addCandidate(candidates, { priority: 58, icon: '+', label: 'Tomorrow', title: 'Stage tomorrow’s first objective', detail: 'A prepared first move lowers friction in the morning.', href: 'main.html' });
  if (sleepHours != null && sleepHours < 7) addCandidate(candidates, { priority: 70, tone: 'warn', icon: '◐', label: 'Recovery', title: 'Recovery deserves the final word', detail: 'Recent sleep was under seven hours; protect tonight’s wind-down.', href: 'sleep.html' });

  const title = goals.length && completed === goals.length
    ? 'Strong close: every objective is complete'
    : remaining ? 'Close the day with ' + plural(remaining, 'open loop') : 'Close the loop and stage tomorrow';
  const progressSentence = goals.length ? completed + ' of ' + goals.length + ' objectives are complete.' : 'There was no task board to score today.';
  const tomorrowSentence = tomorrowGoals.length ? plural(tomorrowGoals.length, 'objective') + ' already ' + (tomorrowGoals.length === 1 ? 'waits' : 'wait') + ' for tomorrow.' : 'Tomorrow still needs a first objective.';
  return { period, eyebrow: 'Evening debrief', title, summary: progressSentence + ' ' + tomorrowSentence, items: selectItems(candidates), coverage };
}
