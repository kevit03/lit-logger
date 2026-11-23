// The buddy: a small character that lives in the LIT popup. It cheers when
// you log, celebrates the goal, naps on rest days, and during a long run of
// applying nudges you to take a break and drink some water.
//
// This file holds the parts every context shares, all pure:
//   session   A "session" is a run of logging with no gap longer than
//             SESSION_GAP_MIN. The service worker updates it on every new
//             entry and keeps it in chrome.storage.local[SESSION_KEY].
//   nudges    When a break or a glass of water is due, given the session and
//             the person's settings.
//   lines     What the buddy says. Warm, short, never scolding.
//   svg       The character itself, with mood parts CSS can show and hide.
//
// The service worker shows nudges as notifications; the popup shows the
// buddy and its speech bubble.
const LitBuddy = (() => {
  const SESSION_KEY = 'lit_buddy_session';
  const SESSION_GAP_MIN = 45;
  const MIN = 60 * 1000;
  const SNOOZE_MIN = 30;

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  // A new entry at nowMs: continue the session, or start a fresh one after a
  // long enough gap (which also counts as having had a break).
  function recordActivity(state, nowMs) {
    const s = state && typeof state === 'object' ? state : null;
    if (!s || !num(s.last) || nowMs - num(s.last) > SESSION_GAP_MIN * MIN) {
      return { start: nowMs, last: nowMs, breakAt: 0, waterAt: 0, snoozeUntil: 0 };
    }
    return Object.assign({}, s, { last: Math.max(num(s.last), nowMs) });
  }

  // Minutes since the session started, or 0 when it has gone quiet.
  function activeMinutes(state, nowMs) {
    if (!state || !num(state.start) || nowMs - num(state.last) > SESSION_GAP_MIN * MIN) return 0;
    return Math.max(0, Math.floor((nowMs - num(state.start)) / MIN));
  }

  // Minutes counted from the later of the session start and the last break.
  function sinceBreak(state, nowMs) {
    const from = Math.max(num(state.start), num(state.breakAt));
    return Math.max(0, Math.floor((nowMs - from) / MIN));
  }

  function waterEvery(prefs) {
    const b = num(prefs && prefs.breakReminderMin);
    return b > 0 ? Math.max(30, Math.round(b / 2)) : 45;
  }

  // 'break', 'water', or null. A break nudge covers water too, so it resets
  // the water clock.
  function nudgeDue(state, nowMs, prefs) {
    const p = prefs || {};
    if (p.buddyEnabled === false || !state) return null;
    if (num(state.snoozeUntil) > nowMs) return null;
    if (!activeMinutes(state, nowMs)) return null;
    const breakMin = num(p.breakReminderMin);
    if (breakMin > 0 && sinceBreak(state, nowMs) >= breakMin) return 'break';
    if (p.waterReminder !== false) {
      const every = waterEvery(p);
      const from = Math.max(num(state.start), num(state.breakAt), num(state.waterAt));
      if ((nowMs - from) / MIN >= every) return 'water';
    }
    return null;
  }

  // When the next nudge could come due, for scheduling an alarm; null if the
  // buddy has nothing to say for this session.
  function nextNudgeAt(state, prefs) {
    const p = prefs || {};
    if (p.buddyEnabled === false || !state || !num(state.start)) return null;
    const times = [];
    const breakMin = num(p.breakReminderMin);
    if (breakMin > 0) times.push(Math.max(num(state.start), num(state.breakAt)) + breakMin * MIN);
    if (p.waterReminder !== false) times.push(Math.max(num(state.start), num(state.breakAt), num(state.waterAt)) + waterEvery(p) * MIN);
    if (!times.length) return null;
    const at = Math.max(Math.min.apply(null, times), num(state.snoozeUntil));
    // Past the quiet gap the session is over; nothing to schedule.
    return at - num(state.last) > SESSION_GAP_MIN * MIN ? null : at;
  }

  function markNudged(state, kind, nowMs) {
    const s = Object.assign({}, state);
    if (kind === 'break') { s.breakAt = nowMs; s.waterAt = nowMs; }
    if (kind === 'water') s.waterAt = nowMs;
    return s;
  }

  function snooze(state, nowMs, minutes) {
    return Object.assign({}, state, { snoozeUntil: nowMs + (minutes || SNOOZE_MIN) * MIN });
  }

  // ----- Lines ----------------------------------------------------------------
  function pick(list, seed) {
    const i = Math.abs(Math.floor(num(seed))) % list.length;
    return list[i];
  }

  function durationText(mins) {
    if (mins < 60) return mins + ' minutes';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return (h === 1 ? 'an hour' : h + ' hours') + (m >= 10 ? ' and ' + m + ' minutes' : '');
  }

  const lines = {
    greeting(hour, name) {
      if (hour < 5) return 'Up late? Go easy on yourself tonight.';
      if (hour < 12) return 'Morning! What is one thing we can send today?';
      if (hour < 17) return 'Afternoon check-in. Want to knock one out?';
      if (hour < 21) return 'Evening. One more, or call it a day? Both are fine.';
      return 'Winding down? Rest counts too.';
    },
    progress(count, goal, unit) {
      const left = Math.max(0, goal - count);
      if (left === 1) return 'One more ' + unitOne(unit) + ' and today is locked in.';
      return count + ' down, ' + left + ' to go. Nice rhythm.';
    },
    cheer(seed) {
      return pick(['Logged! Love to see it.', 'Another one. You are on a roll.', 'Nice. That one counts.', 'Yes! Keep it going.', 'Boom. Logged.'], seed);
    },
    goalMet(seed) {
      return pick(['Locked in for today! Proud of you.', 'Goal hit. Anything more is a bonus.', 'Today is done and dusted. Go do something fun.'], seed);
    },
    rest() {
      return 'Rest day. I am napping too. See you tomorrow.';
    },
    breakNudge(mins) {
      return 'You have been at it for ' + durationText(mins) + '. Stand up, stretch, and refill your water.';
    },
    water() {
      return 'Quick sip of water? Your brain does better hydrated.';
    },
    breakThanks() {
      return 'Good call. I will be here when you get back.';
    },
    taps: [
      'Hi! I am cheering for you.',
      'Tip: double-click a goal tab to rename it.',
      'Remember to follow up on last week\'s applications.',
      'Tailoring one line of your resume goes a long way.',
      'Tip: Alt+Shift+A logs an application from any page.',
      'A no is just not the match. Onward.',
      'Shoulders down, deep breath. You have got this.',
      'Tip: the gear on any card lets you rename and recolor it.'
    ]
  };

  function unitOne(unit) {
    const u = String(unit || 'one');
    return u.endsWith('s') ? u.slice(0, -1) : u;
  }

  // ----- The character ---------------------------------------------------------
  // A little padlock friend. Mood parts carry classes the popup's CSS toggles
  // with data-mood on the wrapper: idle, happy, cheer, sleepy, thirsty.
  //
  // It also carries a rig for the roaming buddy (popup/modules/buddy-roam.*):
  //   .buddy-rig       wraps the whole character; squash, stretch, and lean
  //   .buddy-legs      two legs (.buddy-leg-l/-r, a .buddy-shin and a foot)
  //                    that swing from the hips at RIG.hipL / RIG.hipR
  //   .buddy-arms      two small arms (.buddy-arm-l/-r) that pivot at the
  //                    shoulders for walking, waving, and cheering
  //   .buddy-face      eyes, cheeks, and mouth, so the gaze can shift
  //   .buddy-mouth-o   an open mouth for yawning
  // Those parts start with display="none", so anywhere without the roaming
  // CSS the buddy looks exactly as before: the seated feet
  // (.buddy-foot-still) stand in for the legs.
  const RIG = {
    viewW: 44,
    viewH: 48,
    feetY: 47.1,          // where the roaming feet touch the ground
    hipL: [15, 37.5],
    hipR: [29, 37.5],
    shoulderL: [8.6, 29.6],
    shoulderR: [35.4, 29.6]
  };

  function svg() {
    return '<svg class="buddy-svg" viewBox="0 0 44 48" aria-hidden="true" focusable="false">' +
      '<g class="buddy-rig">' +
      '<g class="buddy-legs" display="none">' +
        '<g class="buddy-leg buddy-leg-l"><path class="buddy-shin" d="M15 37.5v6" fill="none" stroke-width="2.8" stroke-linecap="round"/><ellipse class="buddy-foot" cx="14.6" cy="44.9" rx="3.9" ry="2.2"/></g>' +
        '<g class="buddy-leg buddy-leg-r"><path class="buddy-shin" d="M29 37.5v6" fill="none" stroke-width="2.8" stroke-linecap="round"/><ellipse class="buddy-foot" cx="29.4" cy="44.9" rx="3.9" ry="2.2"/></g>' +
      '</g>' +
      '<g class="buddy-arms" display="none" fill="none" stroke-width="2.6" stroke-linecap="round">' +
        '<path class="buddy-arm buddy-arm-l" d="M8.6 29.6q-3.6 1.4-4.7 5.6"/>' +
        '<path class="buddy-arm buddy-arm-r" d="M35.4 29.6q3.6 1.4 4.7 5.6"/>' +
      '</g>' +
      '<g class="buddy-body-g">' +
        '<path class="buddy-shackle" d="M14.5 19v-5a7.5 7.5 0 0 1 15 0v5" fill="none" stroke-width="3.2" stroke-linecap="round"/>' +
        '<rect class="buddy-body" x="7" y="17.5" width="30" height="24" rx="9"/>' +
        '<ellipse class="buddy-foot buddy-foot-still" cx="15" cy="42.5" rx="4" ry="2.2"/>' +
        '<ellipse class="buddy-foot buddy-foot-still" cx="29" cy="42.5" rx="4" ry="2.2"/>' +
        '<g class="buddy-face">' +
        '<g class="buddy-eyes buddy-eyes-open"><ellipse cx="16.5" cy="28" rx="2.1" ry="2.6"/><ellipse cx="27.5" cy="28" rx="2.1" ry="2.6"/>' +
          '<circle class="buddy-glint" cx="17.2" cy="27.1" r="0.7"/><circle class="buddy-glint" cx="28.2" cy="27.1" r="0.7"/></g>' +
        '<g class="buddy-eyes buddy-eyes-happy" fill="none" stroke-width="1.8" stroke-linecap="round"><path d="M14.3 28.6q2.2-3 4.4 0"/><path d="M25.3 28.6q2.2-3 4.4 0"/></g>' +
        '<g class="buddy-eyes buddy-eyes-closed" fill="none" stroke-width="1.8" stroke-linecap="round"><path d="M14.3 28.4h4.4"/><path d="M25.3 28.4h4.4"/></g>' +
        '<circle class="buddy-cheek" cx="12.6" cy="32.2" r="2"/><circle class="buddy-cheek" cx="31.4" cy="32.2" r="2"/>' +
        '<path class="buddy-mouth" d="M19.5 33q2.5 2.2 5 0" fill="none" stroke-width="1.7" stroke-linecap="round"/>' +
        '<ellipse class="buddy-mouth-o" cx="22" cy="34.3" rx="2.1" ry="2.5" display="none"/>' +
        '</g>' +
      '</g>' +
      '</g>' +
      '<g class="buddy-extra buddy-sparkles"><path d="M4 12l1 2.4L7.4 15 5 16l-1 2.4L3 16 .6 15 3 14.4z"/><path d="M39 7l.8 1.8 1.8.7-1.8.7-.8 1.8-.8-1.8-1.8-.7 1.8-.7z"/></g>' +
      '<g class="buddy-extra buddy-zz" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M33 6h4l-4 4.5h4"/><path d="M38.5 1h2.6l-2.6 3h2.6"/></g>' +
      '<path class="buddy-extra buddy-drop" d="M40 18c0 0-3.6 4.3-3.6 6.6a3.6 3.6 0 0 0 7.2 0C43.6 22.3 40 18 40 18Z"/>' +
    '</svg>';
  }

  return {
    SESSION_KEY,
    SESSION_GAP_MIN,
    SNOOZE_MIN,
    recordActivity,
    activeMinutes,
    sinceBreak,
    nudgeDue,
    nextNudgeAt,
    markNudged,
    snooze,
    durationText,
    lines,
    RIG,
    svg
  };
})();

if (typeof self !== 'undefined') self.LitBuddy = LitBuddy;
if (typeof module !== 'undefined' && module.exports) module.exports = LitBuddy;
