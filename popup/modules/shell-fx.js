// LIT popup module: shell-fx.
//
// App-shell polish. Patterns borrowed from phone systems and media apps,
// drawn entirely with LIT's own tokens:
//
//   island      A status pill in the top bar (#island-host) showing the active
//               goal's "3/5" with a tiny ring. It morphs open for a moment on
//               a log, a met goal, a focus session, or a buddy nudge. A click
//               shows today, this week, and the streak.
//   mini player A focus-session player at the end of the board
//               (#miniplayer-host), docked to the bottom while a session is
//               on: undo, play/pause, +1, and a length menu. The session lives
//               in chrome.storage.local['lit_focus'] so it survives closing
//               the popup; background/service-worker.js mirrors it into the
//               'lit-focus' alarm and announces the end.
//   skeleton    Shimmering placeholders in #widgets-host until the first render.
//   double-tap  Two quick taps on the ring (#ring-wrap) log one, with a burst.
//   ambient     A soft time-of-day glow behind the counter card.
//   swipe       A sideways trackpad swipe or drag on the counter card moves to
//               the next or previous goal.
//
// Each feature has a switch in Settings > Extras (module prefs 'island',
// 'miniPlayer', 'doubleTap', 'ambient', 'swipeGoals'; all on by default).
// Talks to the popup only through window.LitPopup (see popup/bridge.js). The
// pure helpers load in node for test/shell-fx.test.js.
//
//   lit_focus = {
//     status: 'idle' | 'running' | 'paused' | 'done',
//     length: minutes,
//     startedAt: epoch ms | null,
//     endsAt: epoch ms | null,     the deadline while running
//     remaining: ms                 authoritative while paused
//   }

const LitShellFx = (() => {
  'use strict';

  const FOCUS_KEY = 'lit_focus';
  const FOCUS_LENGTHS = [25, 45, 60];
  const DEFAULT_LENGTH = 25;
  const MAX_LENGTH = 180;
  const MINUTE = 60000;
  // A finished session reads as idle again after this long.
  const DONE_LINGER_MS = 30 * MINUTE;
  const NUDGE_WINDOW_MS = 20 * MINUTE;
  const ISLAND_HOLD_MS = 2500;
  const STATUSES = ['idle', 'running', 'paused', 'done'];
  const FEATURE_KEYS = ['island', 'miniPlayer', 'doubleTap', 'ambient', 'swipeGoals'];
  const ISLAND_PRIORITY = { 'goal-met': 3, nudge: 2, 'focus-done': 2, log: 1, undo: 1, focus: 1 };

  // ---------------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------------
  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function finite(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function clampLength(n) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v) || v <= 0) return DEFAULT_LENGTH;
    return Math.min(MAX_LENGTH, v);
  }

  function idleFocus(length) {
    const L = clampLength(length);
    return { status: 'idle', length: L, startedAt: null, endsAt: null, remaining: L * MINUTE };
  }

  // Tolerates a missing, malformed, or half-written record.
  function normalizeFocus(raw) {
    if (!raw || typeof raw !== 'object') return idleFocus(DEFAULT_LENGTH);
    const length = clampLength(raw.length);
    const full = length * MINUTE;
    const status = STATUSES.indexOf(raw.status) >= 0 ? raw.status : 'idle';
    const startedAt = finite(raw.startedAt);
    const endsAt = finite(raw.endsAt);
    const remaining = finite(raw.remaining);
    if (status === 'running') {
      if (endsAt === null) return idleFocus(length);
      return {
        status,
        length,
        startedAt: startedAt !== null ? startedAt : endsAt - full,
        endsAt,
        remaining: Math.max(0, Math.min(full, remaining !== null ? remaining : full))
      };
    }
    if (status === 'paused') {
      const left = Math.max(0, Math.min(full, remaining !== null ? remaining : full));
      if (left <= 0) return { status: 'done', length, startedAt, endsAt: null, remaining: 0 };
      return { status, length, startedAt, endsAt: null, remaining: left };
    }
    if (status === 'done') return { status, length, startedAt, endsAt, remaining: 0 };
    return idleFocus(length);
  }

  // The status as of `now`: a running session past its deadline is done, and
  // a session that ended a while ago reads as idle again.
  function focusStatus(state, now) {
    const s = state || idleFocus();
    if (s.status === 'running') {
      if (s.endsAt > now) return 'running';
      return now - s.endsAt > DONE_LINGER_MS ? 'idle' : 'done';
    }
    if (s.status === 'done') return s.endsAt !== null && s.endsAt !== undefined && now - s.endsAt > DONE_LINGER_MS ? 'idle' : 'done';
    return s.status === 'paused' ? 'paused' : 'idle';
  }

  // Milliseconds left, always derived from the clock, never counted down.
  function focusRemaining(state, now) {
    const s = state || idleFocus();
    switch (focusStatus(s, now)) {
      case 'running': return Math.max(0, s.endsAt - now);
      case 'paused': return Math.max(0, num(s.remaining));
      case 'done': return 0;
      default: return clampLength(s.length) * MINUTE;
    }
  }

  function focusProgress(state, now) {
    const st = focusStatus(state, now);
    if (st === 'idle') return 0;
    if (st === 'done') return 1;
    const full = clampLength(state && state.length) * MINUTE;
    return Math.max(0, Math.min(1, 1 - focusRemaining(state, now) / full));
  }

  function focusStart(state, now, length) {
    const L = clampLength(length !== undefined ? length : state && state.length);
    return { status: 'running', length: L, startedAt: now, endsAt: now + L * MINUTE, remaining: L * MINUTE };
  }

  function focusPause(state, now) {
    if (focusStatus(state, now) !== 'running') return state;
    return { status: 'paused', length: state.length, startedAt: state.startedAt, endsAt: null, remaining: focusRemaining(state, now) };
  }

  function focusResume(state, now) {
    if (focusStatus(state, now) !== 'paused') return state;
    return { status: 'running', length: state.length, startedAt: state.startedAt, endsAt: now + state.remaining, remaining: state.remaining };
  }

  // Play/pause: pause a running session, resume a paused one, otherwise start
  // a fresh one of the chosen length.
  function focusToggle(state, now) {
    const st = focusStatus(state, now);
    if (st === 'running') return focusPause(state, now);
    if (st === 'paused') return focusResume(state, now);
    return focusStart(state, now);
  }

  function focusStop(state) {
    return idleFocus(state && state.length);
  }

  // Picking a length restarts a running session at the new length, resets a
  // paused one to it, and otherwise just sets it for the next play.
  function focusSetLength(state, length, now) {
    const L = clampLength(length);
    const st = focusStatus(state, now);
    if (st === 'running') return focusStart(state, now, L);
    if (st === 'paused') return { status: 'paused', length: L, startedAt: null, endsAt: null, remaining: L * MINUTE };
    return idleFocus(L);
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(num(ms) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function minutesText(ms) {
    const total = Math.max(0, num(ms));
    if (total < MINUTE) return total > 0 ? 'under a minute' : 'no time';
    const m = Math.ceil(total / MINUTE);
    return m + (m === 1 ? ' minute' : ' minutes');
  }

  function focusLine(state, now) {
    const st = focusStatus(state, now);
    const clock = formatClock(focusRemaining(state, now));
    if (st === 'running') return clock + ' left';
    if (st === 'paused') return 'Paused, ' + clock + ' left';
    if (st === 'done') return 'Session done';
    return clampLength(state && state.length) + ' min focus';
  }

  function tally(count, goal) {
    const c = Math.max(0, Math.floor(num(count)));
    const g = Math.max(1, Math.floor(num(goal)) || 1);
    return { count: c, goal: g, text: c + ' of ' + g };
  }

  // The mini player's second line: "3 of 5 today · 18:42 left".
  function playerSub(d, state, now) {
    return tally(d && d.count, d && d.goal).text + ' today · ' + focusLine(state, now);
  }

  function playButton(state, now) {
    const st = focusStatus(state, now);
    const L = clampLength(state && state.length);
    if (st === 'running') return { icon: 'pause', label: 'Pause the focus session' };
    if (st === 'paused') return { icon: 'play', label: 'Resume the focus session' };
    if (st === 'done') return { icon: 'play', label: 'Start another ' + L + ' minute focus session' };
    return { icon: 'play', label: 'Start a ' + L + ' minute focus session' };
  }

  function capitalize(s) {
    const t = String(s || '').trim();
    return t ? t[0].toUpperCase() + t.slice(1) : t;
  }

  // What the open island says. title and sub are its two short lines; text
  // is the whole sentence for screen readers and tooltips. say: worth
  // announcing (the counter already announces plain logs).
  function islandMessage(kind, d) {
    const x = d || {};
    const t = tally(x.count, x.goal);
    switch (kind) {
      case 'log': {
        const unit = capitalize(x.unitOne) || 'One';
        return { kind, icon: 'plus', title: '+1 ' + unit, sub: t.text + ' today', text: '+1 ' + unit + ' · ' + t.text, say: false };
      }
      case 'undo':
        return { kind, icon: 'undo', title: 'Took one back', sub: t.text + ' today', text: 'Took one back · ' + t.text, say: false };
      case 'goal-met':
        return { kind, icon: 'lock', title: 'Locked in', sub: 'for today', text: 'Locked in for today', say: true };
      case 'focus': {
        const left = formatClock(x.remainingMs) + ' left';
        const title = x.paused ? 'Focus paused' : 'Focus session';
        return { kind, icon: 'focus', title, sub: left, text: title + ' · ' + left, say: false };
      }
      case 'focus-done':
        return { kind, icon: 'focus', title: 'Session done', sub: 'Stretch and sip', text: 'Focus session done. Stretch and grab some water.', say: true };
      case 'nudge':
        if (x.kind === 'break') return { kind, icon: 'cup', title: 'Stretch break', sub: 'Stand up a minute', text: 'Time for a stretch break', say: true };
        return { kind, icon: 'drop', title: 'Water break', sub: 'Time for a sip', text: 'Time for a water break', say: true };
      default:
        return null;
    }
  }

  // The resting pill: "3/5", the ring fraction, and a clock while a focus
  // session is on.
  function islandRest(d) {
    const x = d || {};
    const t = tally(x.count, x.goal);
    const st = x.focusStatus;
    const live = st === 'running' || st === 'paused';
    let aria = 'Today at a glance: ' + t.text + (x.unitMany ? ' ' + x.unitMany : '') + '.';
    if (st === 'running') aria += ' Focus session, ' + minutesText(x.focusRemaining) + ' left.';
    if (st === 'paused') aria += ' Focus session paused.';
    return {
      label: t.count + '/' + t.goal,
      pct: Math.min(1, t.count / t.goal),
      met: t.count >= t.goal,
      timer: live ? formatClock(x.focusRemaining) : '',
      paused: st === 'paused',
      aria
    };
  }

  // What the island does when a moment arrives while another is showing.
  // show: the message to display now (null keeps the current one); queue:
  // what waits its turn (at most two, one per kind).
  function islandSchedule(current, queue, incoming) {
    if (!incoming) return { show: null, queue: (queue || []).slice() };
    const rest = (queue || []).filter(m => m && m.kind !== incoming.kind);
    if (!current) return { show: incoming, queue: rest };
    if (current.kind === incoming.kind) return { show: incoming, queue: rest };
    // The goal message already covers the log that met it.
    if (incoming.kind === 'log' && current.kind === 'goal-met') return { show: null, queue: rest };
    const pi = ISLAND_PRIORITY[incoming.kind] || 0;
    const pc = ISLAND_PRIORITY[current.kind] || 0;
    if (pi >= pc) return { show: incoming, queue: rest };
    return { show: null, queue: rest.concat([incoming]).slice(-2) };
  }

  // The summary under the island: today, this week, the streak, and the
  // focus session when one is on.
  function islandSummary(d) {
    const x = d || {};
    const t = tally(x.count, x.goal);
    const week = Math.max(0, Math.floor(num(x.week)));
    const weekly = Math.max(0, Math.floor(num(x.weekly)));
    const streak = Math.max(0, Math.floor(num(x.streak)));
    let focus = null;
    if (x.focusStatus === 'running') focus = 'Focus session · ' + formatClock(x.focusRemaining) + ' left';
    else if (x.focusStatus === 'paused') focus = 'Focus paused · ' + formatClock(x.focusRemaining) + ' left';
    else if (x.focusStatus === 'done') focus = 'Focus session done';
    return {
      today: t.text,
      week: weekly > 0 ? week + ' of ' + weekly : String(week),
      streak: streak > 0 ? streak + (streak === 1 ? ' day' : ' days') : 'Fresh start',
      focus
    };
  }

  // A buddy nudge from the worker worth showing: recent, and not shown yet.
  function nudgeToShow(session, nowMs, seenAt) {
    const n = session && session.lastNudge;
    if (!n || typeof n !== 'object') return null;
    const at = num(n.at);
    if (!at || at <= num(seenAt)) return null;
    if (nowMs - at > NUDGE_WINDOW_MS || at > nowMs + MINUTE) return null;
    return n.kind === 'break' ? 'break' : 'water';
  }

  // A press counts as a tap when it barely moved and was not held.
  function isTap(down, up, opts) {
    const o = Object.assign({ move: 10, ms: 450 }, opts);
    if (!down || !up) return false;
    const dt = num(up.t) - num(down.t);
    if (dt < 0 || dt > o.ms) return false;
    return Math.hypot(num(up.x) - num(down.x), num(up.y) - num(down.y)) <= o.move;
  }

  function isDoubleTap(prev, cur, opts) {
    const o = Object.assign({ ms: 320, slop: 28 }, opts);
    if (!prev || !cur) return false;
    const dt = num(cur.t) - num(prev.t);
    if (dt <= 0 || dt > o.ms) return false;
    return Math.hypot(num(cur.x) - num(prev.x), num(cur.y) - num(prev.y)) <= o.slop;
  }

  // Feed it each tap; it answers true on the second of a quick pair. A third
  // tap starts a new pair.
  function createTapGate(opts) {
    let last = null;
    return {
      tap(p) {
        if (last && isDoubleTap(last, p, opts)) {
          last = null;
          return true;
        }
        last = p;
        return false;
      },
      reset() { last = null; }
    };
  }

  function timePhase(hour) {
    const n = Number(hour);
    if (!Number.isFinite(n)) return 'midday';
    const h = ((Math.floor(n) % 24) + 24) % 24;
    if (h >= 5 && h < 11) return 'morning';
    if (h >= 11 && h < 17) return 'midday';
    if (h >= 17 && h < 21) return 'evening';
    return 'night';
  }

  // +1 for the next goal, -1 for the previous one, 0 for neither. A drag
  // moving left means next (the content follows the finger); a wheel delta
  // to the right means next (the content scrolls left).
  function swipeDirection(dx, dy, opts) {
    const o = Object.assign({ threshold: 48, ratio: 1.5, source: 'drag' }, opts);
    const ax = Math.abs(num(dx));
    const ay = Math.abs(num(dy));
    if (ax < o.threshold || ax < o.ratio * ay) return 0;
    const sign = num(dx) > 0 ? 1 : -1;
    return o.source === 'wheel' ? sign : -sign;
  }

  // Whether a pointer that has moved this far should start a sideways drag.
  function dragIntent(dx, dy, slop) {
    const ax = Math.abs(num(dx));
    return ax >= (slop || 10) && ax > 1.3 * Math.abs(num(dy));
  }

  // How far the counter follows the finger: loosely toward a neighbor, with
  // a firm rubber band at the first or last goal.
  function dragOffset(dx, hasNeighbor) {
    const d = num(dx);
    const v = hasNeighbor ? d * 0.5 : d * 0.18;
    const cap = hasNeighbor ? 70 : 24;
    return Math.max(-cap, Math.min(cap, v));
  }

  function wheelPixels(delta, mode) {
    const d = num(delta);
    if (mode === 1) return d * 16;
    if (mode === 2) return d * 400;
    return d;
  }

  // One goal change per trackpad gesture: deltas add up until they cross the
  // threshold, then the gate stays shut until the wheel goes quiet (momentum
  // events included). Mostly vertical scrolling never trips it.
  function createWheelGate(opts) {
    const o = Object.assign({ threshold: 60, ratio: 1.5, idleMs: 240 }, opts);
    let sx = 0;
    let sy = 0;
    let last = -Infinity;
    let locked = false;
    return {
      feed(ev) {
        const t = num(ev && ev.t);
        if (t - last > o.idleMs) {
          sx = 0;
          sy = 0;
          locked = false;
        }
        last = t;
        if (locked) return 0;
        sx += num(ev && ev.dx);
        sy += num(ev && ev.dy);
        const dir = swipeDirection(sx, sy, { threshold: o.threshold, ratio: o.ratio, source: 'wheel' });
        if (dir) locked = true;
        return dir;
      },
      reset() {
        sx = 0;
        sy = 0;
        last = -Infinity;
        locked = false;
      }
    };
  }

  // The goal a swipe lands on, or null at either end (no wrap-around).
  function neighborGoal(ids, activeId, dir) {
    const list = (ids || []).filter(Boolean);
    const i = list.indexOf(activeId);
    if (i < 0 || !dir) return null;
    const j = i + (dir > 0 ? 1 : -1);
    return j >= 0 && j < list.length ? list[j] : null;
  }

  // Dark or white text for a goal color (same rule as the popup's tabs).
  function readableOn(color) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!m) return '#FFFFFF';
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const n = parseInt(hex, 16);
    const lin = c => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.208 ? '#202124' : '#FFFFFF';
  }

  const pure = {
    FOCUS_KEY,
    FOCUS_LENGTHS,
    DEFAULT_LENGTH,
    FEATURE_KEYS,
    NUDGE_WINDOW_MS,
    ISLAND_HOLD_MS,
    normalizeFocus,
    focusStatus,
    focusRemaining,
    focusProgress,
    focusStart,
    focusPause,
    focusResume,
    focusToggle,
    focusStop,
    focusSetLength,
    formatClock,
    minutesText,
    focusLine,
    playerSub,
    playButton,
    islandMessage,
    islandRest,
    islandSchedule,
    islandSummary,
    nudgeToShow,
    isTap,
    isDoubleTap,
    createTapGate,
    timePhase,
    swipeDirection,
    dragIntent,
    dragOffset,
    wheelPixels,
    createWheelGate,
    neighborGoal,
    readableOn
  };

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof LitPopup !== 'undefined') {
    try {
      setupShell();
    } catch (e) {
      console.warn('[LIT] shell effects did not start', e);
    }
  }
  return pure;

  // ---------------------------------------------------------------------------
  // The popup side. Everything below runs only in the popup page.
  // ---------------------------------------------------------------------------
  function setupShell() {
    const LP = LitPopup;
    const $ = id => document.getElementById(id);
    const on = key => LP.modulePref(key, true) !== false;
    const clock = () => Date.now();
    const stamp = e => (e && typeof e.timeStamp === 'number' && e.timeStamp > 0 ? e.timeStamp : (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
    const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
    const SKIP_GESTURE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="switch"], [contenteditable="true"], .buddy';

    const ICONS = {
      plus: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      undo: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M5.5 4 2.5 7l3 3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
      lock: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M5.2 7.4V5.6a2.8 2.8 0 0 1 5.6 0v1.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><rect x="3.4" y="7" width="9.2" height="6.8" rx="1.9" fill="currentColor"/></svg>',
      focus: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><circle cx="8" cy="9" r="5.1" stroke="currentColor" stroke-width="1.6"/><path d="M8 6.5V9l1.6 1.2M6.4 1.9h3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      drop: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 2.2c2.4 3 4 5.1 4 7.1a4 4 0 0 1-8 0c0-2 1.6-4.1 4-7.1Z" fill="currentColor"/></svg>',
      cup: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M3 6h7.6v3.4A3.6 3.6 0 0 1 7 13H6.6A3.6 3.6 0 0 1 3 9.4V6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M10.6 7.2h.9a1.7 1.7 0 0 1 0 3.4h-1.2M5.4 2.4v1.6M8.2 2.4v1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
      play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5.6 3.4v9.2a.7.7 0 0 0 1.1.6l6.8-4.6a.7.7 0 0 0 0-1.2L6.7 2.8a.7.7 0 0 0-1.1.6Z" fill="currentColor"/></svg>',
      pause: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="4" y="3.2" width="2.9" height="9.6" rx="1" fill="currentColor"/><rect x="9.1" y="3.2" width="2.9" height="9.6" rx="1" fill="currentColor"/></svg>',
      check: '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false"><path d="m3 7.4 2.6 2.6L11 4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      stop: '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><rect x="3.2" y="3.2" width="7.6" height="7.6" rx="1.6" fill="currentColor"/></svg>',
      bigLock: '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M10.4 15V11a5.6 5.6 0 0 1 11.2 0v4" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path fill="currentColor" fill-rule="evenodd" d="M9.6 14h12.8a3.6 3.6 0 0 1 3.6 3.6v7.2a3.6 3.6 0 0 1-3.6 3.6H9.6A3.6 3.6 0 0 1 6 24.8v-7.2A3.6 3.6 0 0 1 9.6 14Zm6.4 3.4a2.2 2.2 0 0 0-1.1 4.1l-.4 3h3l-.4-3a2.2 2.2 0 0 0-1.1-4.1Z"/></svg>',
      miniLock: '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M3.9 5.6V4.2a2.1 2.1 0 0 1 4.2 0v1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="2.6" y="5.2" width="6.8" height="5.2" rx="1.4" fill="currentColor"/></svg>',
      spark: '<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"><path d="M6 0.6 7.2 4.8 11.4 6 7.2 7.2 6 11.4 4.8 7.2 0.6 6 4.8 4.8Z" fill="currentColor"/></svg>'
    };

    let api = null;
    let focus = idleFocus(DEFAULT_LENGTH);
    let focusLoaded = false;
    let shownStatus = null;
    let tick = null;
    let seenNudgeAt = 0;
    const pending = [];

    // ----- Skeleton: tiny, built at load, gone on the first render ----------
    let skeleton = null;
    let skeletonFallback = null;
    let offSkeleton = () => {};

    function buildSkeleton() {
      if (LP.isReady) return;
      const host = $('widgets-host');
      if (!host || host.children.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'fx-skel';
      wrap.setAttribute('aria-hidden', 'true');
      ['wide', 'half', 'half'].forEach(size => {
        const card = document.createElement('div');
        card.className = 'fx-skel-card fx-skel-' + size;
        card.innerHTML = '<i class="fx-skel-line fx-skel-head"></i><i class="fx-skel-line"></i><i class="fx-skel-line fx-skel-short"></i>';
        wrap.appendChild(card);
      });
      host.appendChild(wrap);
      host.setAttribute('aria-busy', 'true');
      const card = $('counter-card');
      if (card) card.classList.add('fx-loading');
      skeleton = wrap;
      offSkeleton = LP.on('render', removeSkeleton);
      // A popup that never renders must not shimmer forever.
      skeletonFallback = setTimeout(removeSkeleton, 8000);
    }

    function removeSkeleton() {
      clearTimeout(skeletonFallback);
      offSkeleton();
      if (skeleton) skeleton.remove();
      skeleton = null;
      const host = $('widgets-host');
      if (host) host.removeAttribute('aria-busy');
      const card = $('counter-card');
      if (card) card.classList.remove('fx-loading');
    }

    buildSkeleton();

    // ----- Settings > Extras ------------------------------------------------
    [
      ['island', 'Status pill', 'A small pill at the top with today\'s count and quick updates.'],
      ['miniPlayer', 'Focus player', 'A focus timer at the bottom of the board, with Undo and +1.'],
      ['doubleTap', 'Double-tap the ring to log', 'Two quick taps on the ring log one. The Log button still works.'],
      ['ambient', 'Time-of-day glow', 'A soft color behind the counter that follows the time of day.'],
      ['swipeGoals', 'Swipe between goals', 'Swipe the counter sideways to move to the next goal.']
    ].forEach(([key, label, hint]) => {
      LP.addSetting({
        id: 'fx-' + key,
        label,
        hint,
        get: () => on(key),
        set: async next => {
          await LP.setModulePref(key, !!next);
          applyAll();
        }
      });
    });

    function hasStorage() {
      return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
    }

    function start() {
      bindGestures();
      applyAll();
      if (hasStorage() && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onStorage);
      document.addEventListener('visibilitychange', onVisibility);
      readFocus(state => {
        focus = state;
        focusLoaded = true;
        pending.splice(0).forEach(([k, d]) => islandEvent(k, d));
        maybeNudge(api.buddySession);
        renderFocus();
        syncTick();
      });
    }

    function applyAll() {
      if (!api) return;
      applyIsland();
      applyPlayer();
      applyAmbient();
      applySwipe();
      applyDoubleTap();
      syncTick();
    }

    // ----- Focus session state ----------------------------------------------
    function readFocus(done) {
      if (!hasStorage()) { done(idleFocus()); return; }
      try {
        chrome.storage.local.get([FOCUS_KEY], r => done(normalizeFocus(r && r[FOCUS_KEY])));
      } catch (e) {
        done(idleFocus());
      }
    }

    function writeFocus(state) {
      if (!hasStorage()) return;
      try {
        chrome.storage.local.set({ [FOCUS_KEY]: state }, () => {
          if (chrome.runtime && chrome.runtime.lastError) api.oops('The focus session did not save. Please try again.', chrome.runtime.lastError);
        });
      } catch (e) {
        api.oops('The focus session did not save. Please try again.', e);
      }
    }

    function setFocus(next) {
      focus = normalizeFocus(next);
      writeFocus(focus);
      renderFocus();
      syncTick();
    }

    function onStorage(changes, area) {
      if (area !== 'local' || !changes) return;
      if (changes[FOCUS_KEY]) {
        const next = normalizeFocus(changes[FOCUS_KEY].newValue);
        if (JSON.stringify(next) !== JSON.stringify(focus)) {
          focus = next;
          renderFocus();
          syncTick();
        }
      }
      const sessionKey = typeof LitBuddy !== 'undefined' && LitBuddy.SESSION_KEY ? LitBuddy.SESSION_KEY : 'lit_buddy_session';
      if (changes[sessionKey]) maybeNudge(changes[sessionKey].newValue);
    }

    function maybeNudge(session) {
      if (!api || (api.prefs && api.prefs.buddyEnabled === false)) return;
      const kind = nudgeToShow(session, clock(), seenNudgeAt);
      if (!kind) return;
      seenNudgeAt = num(session.lastNudge.at);
      islandEvent('nudge', { kind });
    }

    // Every surface that shows the session, plus the moments when its status
    // changes (started, paused, finished, ended).
    function renderFocus(t) {
      const now = t || clock();
      if (focusLoaded) {
        const st = focusStatus(focus, now);
        if (st !== shownStatus) {
          const from = shownStatus;
          shownStatus = st;
          focusTransition(from, st);
        }
      }
      renderIsland(now);
      renderPlayer(now);
    }

    function focusTransition(from, to) {
      const detail = { length: focus.length, endsAt: focus.endsAt };
      if (to === 'running' && from !== 'running') {
        islandEvent('focus');
        LP.emit('fx:focus-start', detail);
      } else if (to === 'paused' && from === 'running') {
        LP.emit('fx:focus-pause', detail);
      } else if (to === 'done' && from === 'running') {
        islandEvent('focus-done');
        LP.emit('fx:focus-done', detail);
      } else if (to === 'idle' && from && from !== 'idle') {
        LP.emit('fx:focus-stop', detail);
      }
    }

    // One timer at most: a timeout chain aligned to the clock's second
    // boundary, only while a session runs, the popup is visible, and
    // something shows it.
    function needTick() {
      return !!api && !document.hidden && !!(island.el || player.root) && focusStatus(focus, clock()) === 'running';
    }

    function syncTick() {
      if (!needTick()) {
        clearTimeout(tick);
        tick = null;
        return;
      }
      if (tick) return;
      const left = focusRemaining(focus, clock());
      tick = setTimeout(() => {
        tick = null;
        renderFocus();
        syncTick();
      }, (left % 1000 || 1000) + 30);
    }

    function onVisibility() {
      if (!document.hidden && api) renderFocus();
      syncTick();
    }

    // ----- Status island ----------------------------------------------------
    const island = { host: null, el: null, rest: null, live: null, panel: null, sr: null, current: null, queue: [], hold: null, gap: null, open: false, ro: null, raf: 0, restKey: '' };

    function applyIsland() {
      const host = $('island-host');
      if (!host) return;
      if (!on('island')) {
        teardownIsland();
        return;
      }
      if (!island.el) buildIsland(host);
      renderIsland();
    }

    function buildIsland(host) {
      island.host = host;
      host.classList.add('fx-island-host');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fx-island';
      btn.id = 'fx-island';
      btn.dataset.mode = 'rest';
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-controls', 'fx-island-panel');
      btn.innerHTML =
        '<span class="fx-island-rest" aria-hidden="true">' +
          '<svg class="fx-island-ring" viewBox="0 0 20 20" focusable="false"><circle class="fx-ir-track" cx="10" cy="10" r="7"/><circle class="fx-ir-fill" cx="10" cy="10" r="7" pathLength="100" stroke-dasharray="0 100"/></svg>' +
          '<span class="fx-island-count"></span>' +
          '<span class="fx-island-timer" hidden><i></i><span class="fx-island-clock"></span></span>' +
        '</span>' +
        '<span class="fx-island-live" aria-hidden="true">' +
          '<span class="fx-island-icon"></span>' +
          '<span class="fx-island-lines"><span class="fx-island-title"></span><span class="fx-island-sub"></span></span>' +
        '</span>';
      const panel = document.createElement('div');
      panel.className = 'fx-island-panel';
      panel.id = 'fx-island-panel';
      panel.hidden = true;
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', 'Today at a glance');
      panel.innerHTML =
        '<div class="fx-panel-head"><span class="fx-panel-icon" aria-hidden="true"></span><span class="fx-panel-name"></span></div>' +
        '<dl class="fx-panel-stats">' +
          '<div><dt>Today</dt><dd data-k="today"></dd></div>' +
          '<div><dt>This week</dt><dd data-k="week"></dd></div>' +
          '<div><dt>Streak</dt><dd data-k="streak"></dd></div>' +
        '</dl>' +
        '<div class="fx-panel-focus" hidden><span class="fx-panel-focus-icon" aria-hidden="true">' + ICONS.focus + '</span><span class="fx-panel-focus-text"></span></div>';
      const sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.setAttribute('aria-live', 'polite');
      host.appendChild(btn);
      host.appendChild(panel);
      host.appendChild(sr);
      Object.assign(island, {
        el: btn,
        rest: btn.querySelector('.fx-island-rest'),
        live: btn.querySelector('.fx-island-live'),
        panel,
        sr,
        restKey: ''
      });
      btn.addEventListener('click', togglePanel);
      if (typeof ResizeObserver === 'function') {
        island.ro = new ResizeObserver(() => sizeIslandSoon());
        island.ro.observe(host);
      }
    }

    function teardownIsland() {
      closePanel(false);
      clearTimeout(island.hold);
      clearTimeout(island.gap);
      if (island.raf) cancelAnimationFrame(island.raf);
      if (island.ro) island.ro.disconnect();
      if (island.host) {
        island.host.textContent = '';
        island.host.classList.remove('fx-island-host');
      }
      Object.assign(island, { host: null, el: null, rest: null, live: null, panel: null, sr: null, current: null, queue: [], hold: null, gap: null, open: false, ro: null, raf: 0, restKey: '' });
    }

    function renderIsland(t) {
      if (!island.el || !api) return;
      const m = api.activeMetric;
      if (!m) return;
      const now = t || clock();
      const st = focusStatus(focus, now);
      const left = focusRemaining(focus, now);
      const rest = islandRest({ count: api.todayFor(m), goal: api.goalFor(m), unitMany: api.displayUnit(m, 2), focusStatus: st, focusRemaining: left });
      const fill = island.el.querySelector('.fx-ir-fill');
      fill.setAttribute('stroke-dasharray', (rest.pct * 100).toFixed(1) + ' 100');
      fill.style.opacity = rest.pct > 0 ? '1' : '0';
      island.el.querySelector('.fx-island-count').textContent = rest.label;
      const timer = island.el.querySelector('.fx-island-timer');
      timer.hidden = !rest.timer;
      timer.classList.toggle('is-paused', rest.paused);
      island.el.querySelector('.fx-island-clock').textContent = rest.timer;
      island.el.classList.toggle('is-met', rest.met);
      island.el.setAttribute('aria-label', rest.aria);
      if (island.current && island.current.kind === 'focus') {
        const msg = messageFor('focus');
        if (msg) fillLive(msg);
      }
      if (island.open) renderPanel(now);
      // Re-measure only when the resting content changes shape.
      const key = rest.label + '|' + rest.timer.length;
      if (key !== island.restKey) {
        island.restKey = key;
        if (!island.current) sizeIslandSoon();
      }
    }

    function sizeIslandSoon() {
      if (!island.el) return;
      if (island.raf) cancelAnimationFrame(island.raf);
      island.raf = requestAnimationFrame(() => {
        island.raf = 0;
        sizeIsland();
      });
    }

    // Width follows the content, never wider than the slot between the brand
    // and the icons, so the top bar never reflows.
    function sizeIsland() {
      if (!island.el || !island.host) return;
      const layer = island.el.dataset.mode === 'live' ? island.live : island.rest;
      const avail = Math.max(30, island.host.clientWidth);
      layer.style.width = 'max-content';
      const natural = Math.ceil(layer.getBoundingClientRect().width);
      layer.style.width = '';
      island.el.style.width = Math.min(avail, Math.max(30, natural)) + 'px';
    }

    function messageFor(kind, d) {
      if (!api) return null;
      const x = d || {};
      const m = x.metric || api.activeMetric;
      if (kind === 'log' || kind === 'undo') {
        if (!m) return null;
        return islandMessage(kind, {
          count: x.count !== undefined ? x.count : api.todayFor(m),
          goal: x.goal !== undefined ? x.goal : api.goalFor(m),
          unitOne: api.displayUnit(m, 1)
        });
      }
      if (kind === 'focus') {
        const now = clock();
        return islandMessage('focus', { remainingMs: focusRemaining(focus, now), paused: focusStatus(focus, now) === 'paused' });
      }
      return islandMessage(kind, x);
    }

    function islandEvent(kind, detail) {
      if (!api || !focusLoaded) {
        if (pending.length < 4) pending.push([kind, detail]);
        return;
      }
      if (!island.el) return;
      const msg = messageFor(kind, detail);
      if (!msg) return;
      if (msg.say && island.sr) island.sr.textContent = msg.text;
      // The open summary already shows the numbers.
      if (island.open) return;
      const plan = islandSchedule(island.current, island.queue, msg);
      island.queue = plan.queue;
      if (plan.show) showLive(plan.show);
    }

    function fillLive(msg) {
      island.live.querySelector('.fx-island-icon').innerHTML = ICONS[msg.icon] || '';
      island.live.querySelector('.fx-island-title').textContent = msg.title;
      island.live.querySelector('.fx-island-sub').textContent = msg.sub;
      island.el.title = msg.text;
    }

    function showLive(msg) {
      if (!island.el) return;
      clearTimeout(island.hold);
      clearTimeout(island.gap);
      island.current = msg;
      fillLive(msg);
      island.el.dataset.mode = 'live';
      island.el.dataset.kind = msg.kind;
      sizeIsland();
      island.hold = setTimeout(endLive, ISLAND_HOLD_MS);
    }

    function endLive() {
      island.current = null;
      if (!island.el) return;
      island.el.dataset.mode = 'rest';
      delete island.el.dataset.kind;
      island.el.removeAttribute('title');
      sizeIsland();
      const next = island.queue.shift();
      if (next) {
        island.gap = setTimeout(() => {
          const fresh = next.kind === 'focus' ? messageFor('focus') : next;
          if (fresh && !island.open) showLive(fresh);
        }, 420);
      }
    }

    function togglePanel() {
      if (island.open) closePanel(true);
      else openPanel();
    }

    function openPanel() {
      if (!island.el || !api) return;
      closeMenu(false);
      clearTimeout(island.hold);
      clearTimeout(island.gap);
      island.current = null;
      island.queue = [];
      island.el.dataset.mode = 'rest';
      delete island.el.dataset.kind;
      island.el.removeAttribute('title');
      sizeIsland();
      island.open = true;
      renderPanel(clock());
      island.panel.hidden = false;
      positionPanel();
      island.el.setAttribute('aria-expanded', 'true');
      island.el.classList.add('is-open');
      document.addEventListener('pointerdown', onPanelOutside, true);
      document.addEventListener('keydown', onPanelKey, true);
    }

    function closePanel(returnFocus) {
      if (!island.open) return;
      island.open = false;
      if (island.panel) island.panel.hidden = true;
      if (island.el) {
        island.el.setAttribute('aria-expanded', 'false');
        island.el.classList.remove('is-open');
        if (returnFocus) island.el.focus();
      }
      document.removeEventListener('pointerdown', onPanelOutside, true);
      document.removeEventListener('keydown', onPanelKey, true);
    }

    function onPanelOutside(e) {
      if (island.host && !island.host.contains(e.target)) closePanel(false);
    }

    function onPanelKey(e) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closePanel(true);
    }

    // Centered under the pill, kept inside the popup.
    function positionPanel() {
      const p = island.panel;
      const hr = island.host.getBoundingClientRect();
      const w = p.offsetWidth;
      const vw = document.documentElement.clientWidth || window.innerWidth || 380;
      let left = hr.left + hr.width / 2 - w / 2;
      left = Math.max(8, Math.min(vw - 8 - w, left));
      p.style.left = Math.round(left - hr.left) + 'px';
    }

    function renderPanel(t) {
      if (!island.panel || !api) return;
      const m = api.activeMetric;
      if (!m) return;
      const now = t || clock();
      const s = api.stats || {};
      const sum = islandSummary({
        count: api.todayFor(m),
        goal: api.goalFor(m),
        week: (s.weekToDate && s.weekToDate[m.id]) || 0,
        weekly: m.weeklyGoal || 0,
        streak: api.streakFor(m),
        focusStatus: focusStatus(focus, now),
        focusRemaining: focusRemaining(focus, now)
      });
      const icon = island.panel.querySelector('.fx-panel-icon');
      icon.innerHTML = api.iconFor(m) || '';
      icon.style.background = m.color || '';
      icon.style.color = readableOn(m.color);
      island.panel.querySelector('.fx-panel-name').textContent = m.name || '';
      island.panel.querySelector('[data-k="today"]').textContent = sum.today;
      island.panel.querySelector('[data-k="week"]').textContent = sum.week;
      island.panel.querySelector('[data-k="streak"]').textContent = sum.streak;
      const row = island.panel.querySelector('.fx-panel-focus');
      row.hidden = !sum.focus;
      row.querySelector('.fx-panel-focus-text').textContent = sum.focus || '';
    }

    // ----- Mini player ------------------------------------------------------
    const player = { host: null, root: null, art: null, title: null, sub: null, play: null, prev: null, next: null, len: null, menu: null, bar: null, fill: null, artKey: '', playIcon: '', menuOpen: false };

    function applyPlayer() {
      const host = $('miniplayer-host');
      if (!host) return;
      if (!on('miniPlayer')) {
        teardownPlayer();
        return;
      }
      if (!player.root) buildPlayer(host);
      renderPlayer();
    }

    function buildPlayer(host) {
      const root = document.createElement('section');
      root.className = 'fx-player';
      root.setAttribute('aria-label', 'Focus session');
      root.innerHTML =
        '<div class="fx-player-art" aria-hidden="true"></div>' +
        '<div class="fx-player-meta"><div class="fx-player-title"></div><div class="fx-player-sub"></div></div>' +
        '<div class="fx-player-controls">' +
          '<button type="button" class="fx-pbtn fx-prev" aria-label="Undo last" title="Undo last">' + ICONS.undo + '</button>' +
          '<button type="button" class="fx-pbtn fx-play"></button>' +
          '<button type="button" class="fx-pbtn fx-next">' + ICONS.plus + '</button>' +
          '<div class="fx-len-wrap">' +
            '<button type="button" class="fx-pbtn fx-len" aria-haspopup="menu" aria-expanded="false" aria-controls="fx-len-menu"></button>' +
            '<div class="fx-menu" id="fx-len-menu" role="menu" aria-label="Focus length" hidden></div>' +
          '</div>' +
        '</div>' +
        '<div class="fx-player-bar" role="progressbar" aria-label="Focus session progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>';
      const menu = root.querySelector('.fx-menu');
      FOCUS_LENGTHS.forEach(n => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', 'false');
        b.dataset.len = String(n);
        b.innerHTML = '<span class="fx-menu-check">' + ICONS.check + '</span>';
        b.appendChild(document.createTextNode(n + ' minutes'));
        menu.appendChild(b);
      });
      const sep = document.createElement('div');
      sep.className = 'fx-menu-sep';
      sep.setAttribute('role', 'separator');
      menu.appendChild(sep);
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.setAttribute('role', 'menuitem');
      stop.dataset.act = 'stop';
      stop.innerHTML = '<span class="fx-menu-check">' + ICONS.stop + '</span>';
      stop.appendChild(document.createTextNode('End session'));
      menu.appendChild(stop);
      host.appendChild(root);
      Object.assign(player, {
        host,
        root,
        art: root.querySelector('.fx-player-art'),
        title: root.querySelector('.fx-player-title'),
        sub: root.querySelector('.fx-player-sub'),
        play: root.querySelector('.fx-play'),
        prev: root.querySelector('.fx-prev'),
        next: root.querySelector('.fx-next'),
        len: root.querySelector('.fx-len'),
        menu,
        bar: root.querySelector('.fx-player-bar'),
        fill: root.querySelector('.fx-player-bar span'),
        artKey: '',
        playIcon: '',
        menuOpen: false
      });
      player.prev.addEventListener('click', () => { if (api) api.undoLast(); });
      player.next.addEventListener('click', () => { if (api) api.logOne(); });
      player.play.addEventListener('click', () => setFocus(focusToggle(focus, clock())));
      player.len.addEventListener('click', () => (player.menuOpen ? closeMenu(true) : openMenu()));
      menu.addEventListener('click', onMenuClick);
      menu.addEventListener('keydown', onMenuKey);
    }

    function teardownPlayer() {
      closeMenu(false);
      if (player.root) player.root.remove();
      if (player.host) player.host.classList.remove('fx-docked');
      Object.assign(player, { host: null, root: null, art: null, title: null, sub: null, play: null, prev: null, next: null, len: null, menu: null, bar: null, fill: null, artKey: '', playIcon: '', menuOpen: false });
    }

    function renderPlayer(t) {
      if (!player.root || !api) return;
      const m = api.activeMetric;
      if (!m) return;
      const now = t || clock();
      const st = focusStatus(focus, now);
      const artKey = m.id + '|' + m.color + '|' + m.icon;
      if (artKey !== player.artKey) {
        player.artKey = artKey;
        player.root.style.setProperty('--tracker', m.color || 'var(--accent)');
        player.root.style.setProperty('--on-tracker', readableOn(m.color));
        player.art.innerHTML = api.iconFor(m) || '';
      }
      player.title.textContent = m.name || '';
      player.sub.textContent = playerSub({ count: api.todayFor(m), goal: api.goalFor(m) }, focus, now);
      const pb = playButton(focus, now);
      if (pb.icon !== player.playIcon) {
        player.playIcon = pb.icon;
        player.play.innerHTML = ICONS[pb.icon];
      }
      player.play.setAttribute('aria-label', pb.label);
      player.play.title = pb.label;
      const unit = api.displayUnit(m, 1);
      player.next.setAttribute('aria-label', 'Log one more ' + unit);
      player.next.title = '+1 ' + capitalize(unit);
      player.len.textContent = focus.length + 'm';
      player.len.setAttribute('aria-label', 'Focus length: ' + focus.length + ' minutes');
      player.len.title = 'Focus length';
      const pct = Math.round(focusProgress(focus, now) * 1000) / 1000;
      player.fill.style.transform = 'scaleX(' + pct + ')';
      player.bar.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
      player.root.dataset.status = st;
      player.host.classList.toggle('fx-docked', st !== 'idle');
      if (player.menuOpen) syncMenu();
    }

    function menuItems() {
      return player.menu ? Array.from(player.menu.querySelectorAll('button')).filter(b => !b.hidden) : [];
    }

    function syncMenu() {
      const st = focusStatus(focus, clock());
      player.menu.querySelectorAll('[data-len]').forEach(b => b.setAttribute('aria-checked', String(Number(b.dataset.len) === focus.length)));
      const stop = player.menu.querySelector('[data-act="stop"]');
      stop.hidden = st === 'idle';
      player.menu.querySelector('.fx-menu-sep').hidden = st === 'idle';
    }

    function openMenu() {
      if (!player.menu) return;
      closePanel(false);
      player.menuOpen = true;
      syncMenu();
      player.menu.hidden = false;
      player.len.setAttribute('aria-expanded', 'true');
      const checked = player.menu.querySelector('[aria-checked="true"]') || menuItems()[0];
      if (checked) checked.focus();
      document.addEventListener('pointerdown', onMenuOutside, true);
    }

    function closeMenu(returnFocus) {
      if (!player.menuOpen) return;
      player.menuOpen = false;
      if (player.menu) player.menu.hidden = true;
      if (player.len) {
        player.len.setAttribute('aria-expanded', 'false');
        if (returnFocus) player.len.focus();
      }
      document.removeEventListener('pointerdown', onMenuOutside, true);
    }

    function onMenuOutside(e) {
      const wrap = player.len && player.len.parentNode;
      if (wrap && !wrap.contains(e.target)) closeMenu(false);
    }

    function onMenuClick(e) {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.len) setFocus(focusSetLength(focus, Number(b.dataset.len), clock()));
      else if (b.dataset.act === 'stop') setFocus(focusStop(focus));
      closeMenu(true);
    }

    function onMenuKey(e) {
      const items = menuItems();
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      } else if (e.key === 'Tab') {
        closeMenu(false);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const next = items[(i + step + items.length) % items.length];
        if (next) next.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const next = e.key === 'Home' ? items[0] : items[items.length - 1];
        if (next) next.focus();
      }
    }

    // ----- Ambient glow -----------------------------------------------------
    function applyAmbient() {
      const card = $('counter-card');
      if (!card) return;
      let glow = card.querySelector(':scope > .fx-ambient');
      if (!on('ambient')) {
        if (glow) glow.remove();
        card.classList.remove('fx-ambient-on');
        return;
      }
      if (!glow) {
        glow = document.createElement('div');
        glow.className = 'fx-ambient';
        glow.setAttribute('aria-hidden', 'true');
        card.insertBefore(glow, card.firstChild);
      }
      card.classList.add('fx-ambient-on');
      const phase = timePhase(new Date().getHours());
      if (glow.dataset.phase !== phase) glow.dataset.phase = phase;
    }

    // ----- Gestures: double-tap the ring, swipe the counter -----------------
    const tapGate = createTapGate();
    const wheelGate = createWheelGate();
    let gesture = null;
    let gesturesBound = false;
    let wheelBound = false;

    function counterMain() {
      const card = $('counter-card');
      return card ? card.querySelector('.counter-main') : null;
    }

    function goalIds() {
      return api ? (api.visibleMetrics || []).map(m => m.id) : [];
    }

    function activeId() {
      const m = api && api.activeMetric;
      return m ? m.id : null;
    }

    function bindGestures() {
      const card = $('counter-card');
      if (!card || gesturesBound) return;
      gesturesBound = true;
      card.addEventListener('pointerdown', onDown);
      card.addEventListener('pointermove', onMove);
      card.addEventListener('pointerup', onUp);
      card.addEventListener('pointercancel', onCancel);
    }

    function applySwipe() {
      const card = $('counter-card');
      if (!card) return;
      const want = on('swipeGoals');
      card.classList.toggle('fx-swipe-on', want);
      if (want && !wheelBound) {
        card.addEventListener('wheel', onWheel, { passive: true });
        wheelBound = true;
      } else if (!want && wheelBound) {
        card.removeEventListener('wheel', onWheel, { passive: true });
        wheelBound = false;
        wheelGate.reset();
      }
      if (!want && gesture && gesture.dragging) snapBack();
    }

    function applyDoubleTap() {
      const ring = $('ring-wrap');
      if (!ring) return;
      const want = on('doubleTap');
      ring.classList.toggle('fx-dtap-on', want);
      if (!want) {
        tapGate.reset();
        ring.querySelectorAll('.fx-tap-burst').forEach(n => n.remove());
      }
    }

    function onDown(e) {
      if (!api || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (api.openModalId) return;
      const target = e.target;
      const blocked = !!(target && target.closest && target.closest(SKIP_GESTURE));
      const ring = $('ring-wrap');
      const g = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        t: stamp(e),
        ring: !blocked && on('doubleTap') && !!ring && ring.contains(target),
        swipe: !blocked && on('swipeGoals') && goalIds().length > 1,
        dragging: false,
        dx: 0,
        dy: 0
      };
      gesture = g.ring || g.swipe ? g : null;
    }

    function onMove(e) {
      const g = gesture;
      if (!g || e.pointerId !== g.id) return;
      g.dx = e.clientX - g.x;
      g.dy = e.clientY - g.y;
      if (!g.dragging) {
        if (g.swipe && dragIntent(g.dx, g.dy)) {
          g.dragging = true;
          const card = $('counter-card');
          try { card.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
          card.classList.add('fx-dragging');
        } else if (Math.abs(g.dy) > 10 && Math.abs(g.dy) > Math.abs(g.dx)) {
          // A vertical move is a scroll, never a swipe.
          g.swipe = false;
          if (!g.ring) gesture = null;
          return;
        }
      }
      if (g.dragging) followDrag(g.dx);
    }

    function onUp(e) {
      const g = gesture;
      if (!g || e.pointerId !== g.id) return;
      gesture = null;
      if (g.dragging) {
        tapGate.reset();
        finishDrag(g.dx, g.dy);
        return;
      }
      const up = { x: e.clientX, y: e.clientY, t: stamp(e) };
      if (g.ring && isTap(g, up)) {
        if (tapGate.tap(up)) doubleTap(up.x, up.y);
      } else {
        tapGate.reset();
      }
    }

    function onCancel(e) {
      const g = gesture;
      if (!g || (e && e.pointerId !== g.id)) return;
      gesture = null;
      tapGate.reset();
      if (g.dragging) snapBack();
    }

    function followDrag(dx) {
      const main = counterMain();
      if (!main || (api && api.reduceMotion)) return;
      const has = !!neighborGoal(goalIds(), activeId(), dx < 0 ? 1 : -1);
      main.style.transition = 'none';
      main.style.transform = 'translateX(' + dragOffset(dx, has).toFixed(1) + 'px)';
    }

    function clearDrag() {
      const card = $('counter-card');
      if (card) card.classList.remove('fx-dragging');
      const main = counterMain();
      const from = main ? main.style.transform : '';
      if (main) {
        main.style.transform = '';
        main.style.transition = '';
      }
      return { main, from };
    }

    function snapBack() {
      const { main, from } = clearDrag();
      if (main && from && api && !api.reduceMotion && typeof main.animate === 'function') {
        main.animate([{ transform: from }, { transform: 'none' }], { duration: 340, easing: SPRING });
      }
    }

    function finishDrag(dx, dy) {
      const dir = swipeDirection(dx, dy, { source: 'drag' });
      const target = dir ? neighborGoal(goalIds(), activeId(), dir) : null;
      if (!target) {
        snapBack();
        return;
      }
      clearDrag();
      switchGoal(target, dir);
    }

    function onWheel(e) {
      if (!api || !on('swipeGoals') || e.ctrlKey || api.openModalId) return;
      if (goalIds().length < 2) return;
      const dir = wheelGate.feed({ dx: wheelPixels(e.deltaX, e.deltaMode), dy: wheelPixels(e.deltaY, e.deltaMode), t: stamp(e) });
      if (!dir) return;
      const target = neighborGoal(goalIds(), activeId(), dir);
      if (target) switchGoal(target, dir);
      else bounce(dir);
    }

    function switchGoal(id, dir) {
      api.selectGoal(id);
      const main = counterMain();
      if (!main || api.reduceMotion || typeof main.animate !== 'function') return;
      main.animate([
        { transform: 'translateX(' + (dir > 0 ? 28 : -28) + 'px)', opacity: 0.35 },
        { transform: 'none', opacity: 1 }
      ], { duration: 300, easing: EASE });
    }

    // At the first or last goal: a small nudge that says "nothing further".
    function bounce(dir) {
      const main = counterMain();
      if (!main || api.reduceMotion || typeof main.animate !== 'function') return;
      main.animate([
        { transform: 'none' },
        { transform: 'translateX(' + (dir > 0 ? -10 : 10) + 'px)' },
        { transform: 'none' }
      ], { duration: 320, easing: EASE });
    }

    function doubleTap(x, y) {
      if (!api) return;
      const ring = $('ring-wrap');
      if (ring && !api.reduceMotion) burstAt(ring, x, y);
      api.logOne();
    }

    // A padlock pops where the ring was tapped and small locks and sparks
    // fly out from it, once.
    function burstAt(ring, cx, cy) {
      const r = ring.getBoundingClientRect();
      const b = document.createElement('div');
      b.className = 'fx-tap-burst';
      b.setAttribute('aria-hidden', 'true');
      b.style.left = Math.round(cx - r.left) + 'px';
      b.style.top = Math.round(cy - r.top) + 'px';
      let html = '<span class="fx-tap-lock">' + ICONS.bigLock + '</span>';
      for (let i = 0; i < 8; i++) {
        const angle = i * 45 + (i % 2 ? 14 : -6);
        const dist = 30 + (i % 3) * 9;
        html += '<i style="--a:' + angle + 'deg;--r:' + dist + 'px;--d:' + ((i % 4) * 28) + 'ms">' + (i % 2 ? ICONS.spark : ICONS.miniLock) + '</i>';
      }
      b.innerHTML = html;
      ring.appendChild(b);
      setTimeout(() => b.remove(), 950);
    }

    // ----- Events (last, so every binding above exists) ---------------------
    LP.on('render', () => {
      if (!api) return;
      renderIsland();
      renderPlayer();
      applyAmbient();
    });
    LP.on('log', d => islandEvent('log', d));
    LP.on('undo', d => islandEvent('undo', d));
    LP.on('goal-met', d => islandEvent('goal-met', d));
    LP.on('modal', d => {
      if (d && d.open) {
        closePanel(false);
        closeMenu(false);
      }
    });
    LP.whenReady(a => {
      api = a;
      start();
    });
  }
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LitShellFx;
