// =============================================================
// Lightweight XP/level/achievement layer, dropped in on any page with:
//     <script src="gamify.js" defer></script>
// Exposes window.Gamify = { awardXP, getState, levelFromXP, ... }.
//
// State lives in localStorage only ('gamify:state') — deliberately NOT
// wired into this app's Supabase sync (each page's sync.js integration
// whitelists specific keys per Supabase row, e.g. main.html's
// ['habits:defs','habits:log','recur:defs'] or gym.html's PC_SYNCED_KEYS;
// gamification spans several of those rows, not one, so bolting it onto
// any single existing sync list would be the wrong owner for it). That
// means XP/level/badges are per-device for now, not synced across your
// phone and laptop — a known, honest limitation for this first version,
// not an oversight.
//
// Callers award XP by calling Gamify.awardXP('action_type') right where
// something gets marked done — see main.html's to-do checkbox and
// gym.html's workout/stretch/bodyweight handlers for real examples. Each
// call is a one-way "you did the thing" award: it's the CALLER's job to
// only invoke it on the transition into "done" (checking, not
// unchecking), so toggling something on and off repeatedly can't farm XP.
// =============================================================
(function () {
  'use strict';

  const KEY = 'gamify:state';

  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && typeof s === 'object') return Object.assign({ totalXP: 0, counts: {}, log: [], badges: [] }, s);
    } catch (e) {}
    return { totalXP: 0, counts: {}, log: [], badges: [] };
  }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }

  // How much XP each tracked action is worth. Roughly scaled by how much
  // real-world effort/time the action represents — a full gym session is
  // worth much more than logging one set.
  const XP_RULES = {
    complete_todo: 5,
    mark_habit_done: 8,
    mark_gym_done: 20,
    mark_exercise_done: 5,
    log_workout_set: 2,
    mark_stretch_done: 10,
    log_body_weight: 5,
    log_reading_session: 10,
    log_cardio_session: 15,
  };

  // Cumulative XP required to REACH each level (level 1 starts at 0).
  // Deliberately steeper than linear (50*n*(n+1)) so early levels come
  // quickly (motivating early on) while later ones take real sustained
  // effort — level 2 needs 100 XP, level 5 needs 1,500, level 10 needs
  // 5,500.
  function xpThreshold(level) { return 50 * level * (level + 1); }
  function levelFromXP(xp) {
    let level = 1;
    while (xp >= xpThreshold(level)) level++;
    return level;
  }
  function xpIntoLevel(xp, level) { return xp - (level > 1 ? xpThreshold(level - 1) : 0); }
  function xpNeededForNextLevel(level) { return xpThreshold(level) - (level > 1 ? xpThreshold(level - 1) : 0); }

  // Each badge is checked against the FULL state after an award — order
  // doesn't matter, `check` just needs to be a pure function of state.
  const BADGES = [
    { id: 'first_step',  label: 'First Step',        emoji: '🌱', desc: 'Complete your first tracked action', check: (s) => s.log.length >= 1 },
    { id: 'century',     label: 'Century',            emoji: '💯', desc: 'Earn 100 total XP', check: (s) => s.totalXP >= 100 },
    { id: 'half_k',      label: 'Getting Serious',    emoji: '⚡', desc: 'Earn 500 total XP', check: (s) => s.totalXP >= 500 },
    { id: 'grand',       label: 'Grand',              emoji: '🏅', desc: 'Earn 1,000 total XP', check: (s) => s.totalXP >= 1000 },
    { id: 'gym_10',      label: 'Iron Regular',       emoji: '💪', desc: 'Log 10 gym days', check: (s) => (s.counts.mark_gym_done || 0) >= 10 },
    { id: 'gym_50',      label: 'Iron Veteran',       emoji: '🏋️', desc: 'Log 50 gym days', check: (s) => (s.counts.mark_gym_done || 0) >= 50 },
    { id: 'habit_25',    label: 'Creature of Habit',  emoji: '🔁', desc: 'Complete 25 habits/to-dos', check: (s) => ((s.counts.complete_todo || 0) + (s.counts.mark_habit_done || 0)) >= 25 },
    { id: 'stretch_20',  label: 'Bendy',              emoji: '🧘', desc: 'Complete 20 full stretch routines', check: (s) => (s.counts.mark_stretch_done || 0) >= 20 },
    { id: 'reader_10',   label: 'Bookworm',           emoji: '📚', desc: 'Log 10 reading sessions', check: (s) => (s.counts.log_reading_session || 0) >= 10 },
    { id: 'level_5',     label: 'Level 5',            emoji: '⭐', desc: 'Reach level 5', check: (s) => levelFromXP(s.totalXP) >= 5 },
    { id: 'level_10',    label: 'Level 10',           emoji: '🌟', desc: 'Reach level 10', check: (s) => levelFromXP(s.totalXP) >= 10 },
  ];

  function awardXP(actionType) {
    const amount = XP_RULES[actionType];
    if (!amount) return null;
    const s = load();
    const prevLevel = levelFromXP(s.totalXP);
    s.totalXP = (s.totalXP || 0) + amount;
    s.counts[actionType] = (s.counts[actionType] || 0) + 1;
    s.log.push({ ts: Date.now(), actionType, amount });
    if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
    const newLevel = levelFromXP(s.totalXP);
    const newBadges = [];
    BADGES.forEach((b) => {
      if (!s.badges.includes(b.id) && b.check(s)) { s.badges.push(b.id); newBadges.push(b); }
    });
    save(s);
    const result = { xpGained: amount, totalXP: s.totalXP, level: newLevel, leveledUp: newLevel > prevLevel, newBadges: newBadges };
    showToast(result);
    return result;
  }

  // -------- minimal self-contained toast UI (same self-injecting pattern topbar.js uses) --------
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
.gamify-toast-stack { position: fixed; left: 50%; bottom: max(18px, env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 9999; display: flex; flex-direction: column; gap: 6px; align-items: center; pointer-events: none; }
.gamify-toast { font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif; font-size: 13px; font-weight: 600; color: #0a0a0b; background: #FAFAFA; border-radius: 999px; padding: 9px 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.35); opacity: 0; transform: translateY(8px); transition: opacity 0.2s ease, transform 0.2s ease; white-space: nowrap; }
.gamify-toast.on { opacity: 1; transform: translateY(0); }
.gamify-toast.xp { background: #6BE3A4; }
.gamify-toast.level { background: #7DD3FC; }
.gamify-toast.badge { background: #F2C063; }
`;
    document.head.appendChild(style);
  }
  function getStack() {
    let el = document.querySelector('.gamify-toast-stack');
    if (!el) {
      el = document.createElement('div');
      el.className = 'gamify-toast-stack';
      document.body.appendChild(el);
    }
    return el;
  }
  function pushToast(text, cls, delayMs) {
    injectStyles();
    setTimeout(() => {
      const stack = getStack();
      const t = document.createElement('div');
      t.className = 'gamify-toast ' + cls;
      t.textContent = text;
      stack.appendChild(t);
      requestAnimationFrame(() => t.classList.add('on'));
      setTimeout(() => {
        t.classList.remove('on');
        setTimeout(() => t.remove(), 250);
      }, 2200);
    }, delayMs);
  }
  function showToast(result) {
    if (!result || typeof document === 'undefined') return;
    let delay = 0;
    pushToast('+' + result.xpGained + ' XP', 'xp', delay);
    if (result.leveledUp) { delay += 400; pushToast('🎉 Level up! Now level ' + result.level, 'level', delay); }
    (result.newBadges || []).forEach((b) => {
      delay += 400;
      pushToast(b.emoji + ' New badge: ' + b.label, 'badge', delay);
    });
  }

  window.Gamify = {
    awardXP: awardXP,
    getState: load,
    levelFromXP: levelFromXP,
    xpIntoLevel: xpIntoLevel,
    xpNeededForNextLevel: xpNeededForNextLevel,
    BADGES: BADGES,
    XP_RULES: XP_RULES,
    showToast: showToast,
  };
})();
