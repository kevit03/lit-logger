// LIT popup.
//
// Sections, top to bottom: helpers, modal plumbing, theme, solve timer,
// account chip, data loading, tracker tabs, counter card, weekly recap,
// widgets (renderers, grid drag, picker, settings), token popover, tracker
// settings, details form, search, settings sheet, exports, startup.
//
// Everything that persists goes through TrackerStorage (logs, trackers,
// preferences) or WidgetLayout (the widget grid); this file only renders and
// wires events.
document.addEventListener('DOMContentLoaded', async () => {
  const el = id => document.getElementById(id);

  let metrics = [];
  let stats = null;
  let activeMetricId = 'jobs';
  let currentUser = null;
  let widgetItems = [];
  let prefs = Object.assign({}, TrackerStorage.PREF_DEFAULTS);

  // Job entries for the pipeline, recent list, and response widgets. Fetched
  // once per data load and shared by every widget that needs them.
  let jobsCache = null;
  let pipelineFilter = null;
  // The pipeline widget whose stage counts are open for editing, if any.
  let pipelineEditing = null;

  // Async renders race; each key keeps only its newest result.
  const asyncTokens = {};
  const bumpToken = key => (asyncTokens[key] = (asyncTokens[key] || 0) + 1);

  // Today's count per tracker as last rendered, to notice a goal being hit.
  const lastToday = {};

  // Motion is off when the OS asks for reduced motion or the user turned it
  // off in LIT (prefs.reduceMotion, when present). Recomputed on every
  // prefs load by applyAppearance().
  const osReducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let reduceMotion = osReducedMotion;
  const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const STATUSES = TrackerStorage.STATUSES;
  const UNIVERSAL_ORIGINS = ['*://*/*'];

  function errMsg(err) {
    return err && err.message ? err.message : 'unknown error';
  }

  // Friendly error copy. The raw error goes to the console for debugging;
  // the person sees what happened in plain words and what to do next.
  function oops(message, err) {
    if (err) console.warn('[LIT]', message, err);
    showStatus(message, 'error');
  }

  // ----- Coach copy (shared/coach-copy.js), with local fallbacks so the
  // popup never breaks if that file is missing or a function changes. -----
  const Coach = typeof LitCopy !== 'undefined' ? LitCopy : null;
  function coach(fn, args, fallback) {
    try {
      if (Coach && typeof Coach[fn] === 'function') {
        const value = Coach[fn].apply(Coach, args || []);
        if (value !== undefined && value !== null && value !== '') return value;
      }
    } catch (e) {
      console.warn('[LIT] coach copy failed:', fn, e);
    }
    return typeof fallback === 'function' ? fallback() : fallback;
  }
  function voice() {
    return (prefs && prefs.coachVoice) || 'coach';
  }
  const has = (obj, fn) => !!obj && typeof obj[fn] === 'function';

  // Popup-only UI memory (celebrations already played today, the setup
  // checklist, the tip dismissed today). Kept in chrome.storage.local under
  // a key this file owns, never in synced prefs.
  const UI_KEY = 'lit_popup_ui';
  let ui = {};
  function loadUiState() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([UI_KEY], r => {
          ui = (r && r[UI_KEY] && typeof r[UI_KEY] === 'object') ? r[UI_KEY] : {};
          resolve(ui);
        });
      } catch (e) {
        resolve(ui);
      }
    });
  }
  function saveUiState(patch) {
    ui = Object.assign({}, ui, patch);
    try { chrome.storage.local.set({ [UI_KEY]: ui }); } catch (e) { /* best effort */ }
  }
  function todayStr() {
    return TrackerStorage.getLocalDateStr();
  }

  // Single transient status / error line, announced via aria-live. An
  // optional action ({ label, run }) adds one inline button, used for Undo.
  let statusTimer = null;
  function showStatus(message, tone, action) {
    const line = el('status-line');
    if (!line) return;
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    line.classList.remove('status-error', 'status-ok');
    if (!message) {
      line.textContent = '';
      line.classList.add('hidden');
      return;
    }
    line.textContent = message;
    if (action && action.label && typeof action.run === 'function') {
      const btn = make('button', 'status-action', action.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        showStatus('');
        action.run();
      });
      line.appendChild(document.createTextNode(' '));
      line.appendChild(btn);
    }
    line.classList.remove('hidden');
    if (tone) line.classList.add(tone === 'error' ? 'status-error' : 'status-ok');
    statusTimer = setTimeout(() => {
      line.textContent = '';
      line.classList.add('hidden');
      line.classList.remove('status-error', 'status-ok');
    }, action ? 10000 : 6000);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function statusOf(log) {
    return TrackerStorage.normalizeStatus(log && log.status) || 'applied';
  }

  function statusMeta(id) {
    return STATUSES.find(s => s.id === id) || STATUSES[0];
  }

  function shortDate(dateStr, withYear) {
    const d = TrackerStorage.parseLocalDateToNoon(dateStr);
    return d.toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
  }

  // "Today", "Yesterday", "3d ago", then a date.
  function relativeDate(dateStr) {
    const n = TrackerStorage.daysBetween(dateStr, TrackerStorage.getLocalDateStr());
    if (n <= 0) return 'Today';
    if (n === 1) return 'Yesterday';
    if (n < 30) return n + 'd ago';
    return shortDate(dateStr, n > 300);
  }

  // Picks a readable foreground for text on a solid fill of the given color.
  // Tracker colors are user-chosen, so amber and other light fills must get
  // dark text rather than the white that suits blue.
  function readableTextOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#ffffff';
    const n = parseInt(m[1], 16);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.208 ? '#202124' : '#ffffff';
  }

  function setTrackerColor(node, color) {
    node.style.setProperty('--tracker', color || '#1a73e8');
    node.style.setProperty('--on-tracker', readableTextOn(color));
  }

  function metricById(id) {
    return metrics.find(m => m.id === id) || null;
  }

  function unitSingular(metric) {
    return displayUnit(metric, 1);
  }

  // What a goal counts, for display: the built-in jobs goal stores 'jobs'
  // but reads as "applications".
  function displayUnit(metric, n) {
    const raw = metric ? (metric.id === 'jobs' && (!metric.unit || metric.unit === 'jobs' || metric.unit === 'items') ? 'applications' : (metric.unit || 'items')) : 'items';
    return coach('unitFor', [raw, n], () => (n === 1 ? raw.replace(/s$/, '') : raw));
  }

  // Goals the person chose to show. Starter goals they did not pick carry
  // hidden: true and stay out of the tabs (nothing is deleted).
  function visibleMetrics() {
    const list = metrics.filter(m => !m.hidden);
    return list.length ? list : metrics.slice(0, 1);
  }

  function goalFor(metric) {
    return metric.dailyGoal || TrackerStorage.defaultGoalFor(metric.id);
  }

  // ---------------------------------------------------------------------------
  // Modal plumbing: Escape to close, Tab trapped inside, focus restored
  // ---------------------------------------------------------------------------
  let openModalEl = null;
  let modalReturnFocusEl = null;

  function focusableIn(container) {
    const nodes = container.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, n => !n.disabled && n.offsetParent !== null);
  }

  function openModal(modal, firstFieldId) {
    if (!modal) return;
    closeProfileMenu();
    modalReturnFocusEl = document.activeElement;
    openModalEl = modal;
    modal.classList.remove('hidden');
    bridgeEmit('modal', { open: true, id: modal.id });
    const preferred = firstFieldId ? el(firstFieldId) : null;
    const target = (preferred && preferred.offsetParent !== null) ? preferred : focusableIn(modal)[0];
    if (target) target.focus();
  }

  function closeModal(modal) {
    const target = modal || openModalEl;
    if (!target) return;
    closeTokenPopover(false);
    const wasOpen = !target.classList.contains('hidden');
    target.classList.add('hidden');
    if (target === openModalEl) {
      openModalEl = null;
      if (modalReturnFocusEl && typeof modalReturnFocusEl.focus === 'function' && modalReturnFocusEl.isConnected) {
        modalReturnFocusEl.focus();
      }
      modalReturnFocusEl = null;
    }
    // After the reference clears, so listeners see openModalId === null.
    if (wasOpen) bridgeEmit('modal', { open: false, id: target.id });
  }

  document.addEventListener('keydown', (e) => {
    if (!openModalEl) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal(openModalEl);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = focusableIn(openModalEl);
    if (items.length === 0) return;
    const firstItem = items[0];
    const lastItem = items[items.length - 1];
    if (!openModalEl.contains(document.activeElement)) {
      e.preventDefault();
      firstItem.focus();
    } else if (e.shiftKey && document.activeElement === firstItem) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  });

  // Clicking the dimmed backdrop dismisses any modal
  ['new-metric-modal', 'metric-settings-modal', 'email-signin-modal', 'add-widget-modal', 'widget-settings-modal', 'settings-modal', 'share-modal'].forEach(id => {
    const modal = el(id);
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    }
  });

  el('current-date-text').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------
  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('pt-dark', isDark);
    el('theme-toggle-btn').setAttribute('aria-label', isDark ? 'Switch to light theme' : 'Switch to dark theme');
    el('theme-segmented').querySelectorAll('[data-theme-value]').forEach(btn => {
      btn.setAttribute('aria-checked', btn.dataset.themeValue === (isDark ? 'dark' : 'light') ? 'true' : 'false');
    });
  }

  // Accent, comfort mode, and motion live on <html> so every token and rule
  // can key off them. Called after every prefs load or change.
  const ACCENTS = ['coral', 'sage', 'ocean', 'plum', 'amber', 'slate'];
  const ACCENT_HEX = {
    coral: ['#E0674B', '#F07A5E'], sage: ['#5E9270', '#7FB291'], ocean: ['#3B7EA1', '#5FA3C7'],
    plum: ['#8A5A9E', '#B285C6'], amber: ['#C9821F', '#E3A54A'], slate: ['#3D4A5C', '#A9B6C8']
  };
  function accentId() {
    return ACCENTS.includes(prefs.accent) ? prefs.accent : 'coral';
  }
  // Northern-hemisphere seasons by month; the Seasonal style follows them.
  function currentSeason(d) {
    const m = (d || new Date()).getMonth();
    if (m === 11 || m <= 1) return 'winter';
    if (m <= 4) return 'spring';
    if (m <= 7) return 'summer';
    return 'autumn';
  }

  function applyAppearance() {
    const root = document.documentElement;
    root.dataset.accent = accentId();
    const style = prefs.themeStyle || 'warm';
    root.dataset.style = style;
    if (style === 'seasonal') root.dataset.season = currentSeason();
    else delete root.dataset.season;
    root.dataset.comfort = prefs.comfortMode ? 'on' : 'off';
    reduceMotion = osReducedMotion || prefs.reduceMotion === true;
    if (reduceMotion) root.dataset.motion = 'reduce';
    else delete root.dataset.motion;
  }

  async function setTheme(theme) {
    applyTheme(theme);
    await TrackerStorage.setTheme(theme);
    notifyCalendarTabs();
  }

  el('theme-toggle-btn').addEventListener('click', () => {
    setTheme(document.body.classList.contains('pt-dark') ? 'light' : 'dark');
  });

  el('theme-segmented').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-value]');
    if (btn) setTheme(btn.dataset.themeValue);
  });

  // ---------------------------------------------------------------------------
  // Solve timer
  // ---------------------------------------------------------------------------
  // The countdown is persisted as a DEADLINE in chrome.storage.local rather
  // than held as a decrementing counter. Closing the popup tears down this
  // script's context outright, so a counter would die with it. A deadline keeps
  // running while the popup is shut and is recovered, still correct, the next
  // time it opens. background/service-worker.js watches this same key and
  // mirrors it into chrome.alarms so zero is announced even with everything
  // closed.
  const TIMER_KEY = 'pt_timer_popup';
  const MAX_TIMER_SECONDS = 86400;
  const MAX_LAPS = 50;
  const IDLE_TIMER = {
    status: 'idle',
    targetSeconds: 0,
    endsAt: null,
    remainingSeconds: 0,
    finishedAt: null,
    laps: [],
    updatedAt: 0
  };

  let timerState = Object.assign({}, IDLE_TIMER);
  let timerTick = null;
  let announcedFinishAt = null;
  let timerInputAtFocus = null;

  const timerInput = el('timer-input');
  const timerToggleBtn = el('timer-toggle-btn');
  const timerLapBtn = el('timer-lap-btn');

  function isTimerRunning() {
    return timerState.status === 'running';
  }

  // Remaining time is always derived, never accumulated. Chrome throttles
  // interval callbacks hard in unfocused contexts, so a tick-based count drifts
  // badly; a clock reading cannot.
  function timerRemaining(now) {
    if (timerState.status === 'running' && timerState.endsAt) {
      return Math.max(0, Math.round((timerState.endsAt - (now || Date.now())) / 1000));
    }
    return Math.max(0, timerState.remainingSeconds || 0);
  }

  function getElapsedSeconds() {
    if (timerState.targetSeconds <= 0) return 0;
    return Math.max(0, timerState.targetSeconds - timerRemaining());
  }

  function normalizeTimerRecord(raw) {
    if (!raw || typeof raw !== 'object' || !raw.status) return Object.assign({}, IDLE_TIMER, { laps: [] });
    return {
      status: raw.status,
      targetSeconds: Math.max(0, parseInt(raw.targetSeconds, 10) || 0),
      endsAt: Number.isFinite(raw.endsAt) ? raw.endsAt : null,
      remainingSeconds: Math.max(0, parseInt(raw.remainingSeconds, 10) || 0),
      finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
      laps: Array.isArray(raw.laps) ? raw.laps.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 0).slice(-MAX_LAPS) : [],
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
    };
  }

  function readStoredTimer() {
    return new Promise(resolve => {
      chrome.storage.local.get([TIMER_KEY], result => {
        if (chrome.runtime.lastError) {
          resolve(Object.assign({}, IDLE_TIMER, { laps: [] }));
          return;
        }
        resolve(normalizeTimerRecord(result && result[TIMER_KEY]));
      });
    });
  }

  // Writing the record is what arms or cancels the background alarm. The
  // service worker watches this key, so the popup never has to message it.
  function persistTimer(next) {
    timerState = Object.assign({ laps: [] }, next, { updatedAt: Date.now() });
    renderTimer();
    return new Promise(resolve => {
      chrome.storage.local.set({ [TIMER_KEY]: timerState }, () => resolve(true));
    });
  }

  function mmss(seconds) {
    return TrackerStorage.formatSecondsToMMSS(seconds);
  }

  // One render for every surface of the widget: the time, the status word,
  // the progress track, the preset highlight, the toggle, and the laps.
  function renderTimer() {
    if (!timerInput || !timerToggleBtn) return;
    const running = isTimerRunning();
    const remaining = timerRemaining();
    const target = timerState.targetSeconds;
    const finished = timerState.status === 'finished';
    const state = running ? 'running'
      : finished ? 'finished'
      : (timerState.status === 'paused' ? 'paused' : (remaining > 0 ? 'armed' : 'idle'));

    el('leetcode-timer-widget').dataset.state = state;
    el('timer-status').textContent = {
      idle: 'Set a length',
      armed: 'Ready',
      running: 'Running',
      paused: 'Paused',
      finished: 'Time is up'
    }[state];

    timerToggleBtn.textContent = running ? 'Pause' : (finished ? 'Restart' : 'Start');
    // Space toggles the timer when nothing else has focus; say so on hover.
    timerToggleBtn.title = timerToggleBtn.textContent + ' (Space)';
    timerToggleBtn.setAttribute('aria-keyshortcuts', 'Space');
    timerToggleBtn.classList.toggle('running', running);
    timerToggleBtn.disabled = state === 'idle';
    timerLapBtn.disabled = !running;

    // Never fight the user for the field while they are editing it.
    if (document.activeElement !== timerInput) timerInput.value = mmss(remaining);
    timerInput.classList.toggle('timer-expired', finished);

    const pct = target > 0 ? Math.min(100, Math.max(0, ((target - remaining) / target) * 100)) : 0;
    el('timer-progress').style.width = pct + '%';

    document.querySelectorAll('.timer-preset').forEach(btn => {
      const seconds = (parseInt(btn.dataset.minutes, 10) || 0) * 60;
      btn.classList.toggle('is-active', target === seconds && target > 0);
    });

    renderLaps();
  }

  function renderLaps() {
    const list = el('timer-laps');
    const laps = timerState.laps || [];
    list.classList.toggle('hidden', laps.length === 0);
    const sig = laps.join(',');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.textContent = '';
    for (let i = laps.length - 1; i >= 0; i--) {
      const li = make('li');
      li.appendChild(make('span', 'lap-n', 'Lap ' + (i + 1)));
      li.appendChild(make('span', '', mmss(laps[i])));
      li.appendChild(make('span', 'lap-split', '+' + mmss(laps[i] - (i > 0 ? laps[i - 1] : 0))));
      list.appendChild(li);
    }
  }

  // Repaint only. Correctness lives in the deadline, so a missed or throttled
  // tick costs nothing but a stale pixel.
  function startRenderTick() {
    if (timerTick) return;
    timerTick = setInterval(() => {
      if (!isTimerRunning()) {
        stopRenderTick();
        return;
      }
      if (timerRemaining() <= 0) {
        finalizeTimer();
        return;
      }
      renderTimer();
    }, 250);
  }

  function stopRenderTick() {
    if (timerTick) {
      clearInterval(timerTick);
      timerTick = null;
    }
  }

  // A short chime, only while the popup is open to hear it.
  function playChime() {
    if (!prefs.timerSound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      [[0, 880], [0.22, 880], [0.44, 1046.5]].forEach(([t, freq]) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.2);
      });
      setTimeout(() => { try { ctx.close(); } catch (e) { /* already closed */ } }, 1200);
    } catch (e) {
      // Audio is a nicety.
    }
  }

  function announceFinished(finishedAt) {
    // The popup and the service worker can both notice zero. Announce once.
    if (announcedFinishAt === finishedAt) return;
    announcedFinishAt = finishedAt;
    playChime();
    showStatus('Time is up. Log the problem to save the full solve time, or press Reset.', 'error');
  }

  async function finalizeTimer() {
    stopRenderTick();
    const finishedAt = timerState.endsAt || Date.now();
    await persistTimer({
      status: 'finished',
      targetSeconds: timerState.targetSeconds,
      endsAt: null,
      remainingSeconds: 0,
      finishedAt,
      laps: timerState.laps
    });
    announceFinished(finishedAt);
  }

  async function startTimer() {
    if (isTimerRunning()) return;
    const remaining = timerRemaining();
    if (remaining <= 0) {
      showStatus('Type a countdown length in the timer box first, for example 25:00.', 'error');
      timerInput.focus();
      timerInput.select();
      return;
    }
    announcedFinishAt = null;
    await persistTimer({
      status: 'running',
      targetSeconds: timerState.targetSeconds > 0 ? timerState.targetSeconds : remaining,
      endsAt: Date.now() + remaining * 1000,
      remainingSeconds: remaining,
      finishedAt: null,
      laps: timerState.laps
    });
    startRenderTick();
  }

  async function pauseTimer() {
    if (!isTimerRunning()) return;
    const remaining = timerRemaining();
    stopRenderTick();
    await persistTimer({
      status: 'paused',
      targetSeconds: timerState.targetSeconds,
      endsAt: null,
      remainingSeconds: remaining,
      finishedAt: null,
      laps: timerState.laps
    });
  }

  async function resetTimer() {
    stopRenderTick();
    announcedFinishAt = null;
    await persistTimer({
      status: 'idle',
      targetSeconds: timerState.targetSeconds,
      endsAt: null,
      remainingSeconds: timerState.targetSeconds,
      finishedAt: null,
      laps: []
    });
  }

  // Called once a solve has been logged: the countdown has served its purpose
  // and must not keep running or fire an alarm afterwards.
  async function clearTimerAfterLog() {
    stopRenderTick();
    announcedFinishAt = null;
    await persistTimer(Object.assign({}, IDLE_TIMER, { laps: [] }));
  }

  async function armTimer(seconds) {
    stopRenderTick();
    announcedFinishAt = null;
    await persistTimer({
      status: 'idle',
      targetSeconds: seconds,
      endsAt: null,
      remainingSeconds: seconds,
      finishedAt: null,
      laps: []
    });
  }

  // +5m / +10m: extends a running countdown in place, or adds to an armed or
  // paused one. After a finish it arms a fresh countdown of that length.
  async function nudgeTimer(minutes) {
    const add = minutes * 60;
    if (!add) return;
    if (isTimerRunning()) {
      await persistTimer(Object.assign({}, timerState, {
        endsAt: timerState.endsAt + add * 1000,
        targetSeconds: Math.min(MAX_TIMER_SECONDS, timerState.targetSeconds + add)
      }));
      return;
    }
    if (timerState.status === 'finished') {
      await armTimer(add);
      return;
    }
    const remaining = timerRemaining();
    await persistTimer(Object.assign({}, timerState, {
      targetSeconds: Math.min(MAX_TIMER_SECONDS, Math.max(timerState.targetSeconds, remaining) + add),
      remainingSeconds: Math.min(MAX_TIMER_SECONDS, remaining + add),
      endsAt: null,
      finishedAt: null
    }));
  }

  async function lapTimer() {
    if (!isTimerRunning()) return;
    const laps = (timerState.laps || []).concat([getElapsedSeconds()]).slice(-MAX_LAPS);
    await persistTimer(Object.assign({}, timerState, { laps }));
  }

  // Recovers whatever the countdown did while the popup was closed.
  async function hydrateTimer() {
    timerState = await readStoredTimer();
    if (timerState.status === 'running' && timerRemaining() <= 0) {
      // Finished while closed: the worker's notification already announced
      // it, so close it out quietly.
      announcedFinishAt = timerState.endsAt;
      await finalizeTimer();
      return;
    }
    if (timerState.status === 'finished' && timerState.finishedAt) {
      announcedFinishAt = timerState.finishedAt;
    }
    renderTimer();
    if (isTimerRunning()) startRenderTick();
  }

  // The service worker writes 'finished' when the alarm fires. If the popup
  // happens to be open at that moment, pick the change up live.
  TrackerStorage.onTimerChanged(TIMER_KEY, (record) => {
    const next = normalizeTimerRecord(record);
    if (next.updatedAt === timerState.updatedAt) return;
    timerState = next;
    renderTimer();
    if (isTimerRunning()) startRenderTick(); else stopRenderTick();
    if (next.status === 'finished' && next.finishedAt) announceFinished(next.finishedAt);
  });

  function formatSolveTimeString(sec) {
    if (sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m > 0 && s > 0) return `Solve time: ${m}m ${s}s`;
    if (m > 0) return `Solve time: ${m}m`;
    return `Solve time: ${s}s`;
  }

  // Start, pause, or after a finished countdown, run the same length again.
  async function toggleTimer() {
    if (isTimerRunning()) { pauseTimer(); return; }
    if (timerState.status === 'finished') await resetTimer();
    startTimer();
  }

  timerToggleBtn.addEventListener('click', toggleTimer);
  timerLapBtn.addEventListener('click', lapTimer);
  el('timer-reset-btn').addEventListener('click', () => resetTimer());

  document.querySelectorAll('.timer-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const minutes = parseInt(btn.dataset.minutes, 10) || 0;
      if (minutes > 0) armTimer(minutes * 60);
    });
  });

  document.querySelectorAll('.timer-nudge').forEach(btn => {
    btn.addEventListener('click', () => nudgeTimer(parseInt(btn.dataset.minutes, 10) || 0));
  });

  timerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') timerInput.blur();
  });

  // Focusing the field freezes its display, so a bare click-then-click-away
  // would otherwise blur a stale value and re-arm the countdown, wiping the
  // elapsed progress. Only a genuine edit re-arms.
  timerInput.addEventListener('focus', () => {
    timerInputAtFocus = timerInput.value;
  });

  timerInput.addEventListener('blur', () => {
    const atFocus = timerInputAtFocus;
    timerInputAtFocus = null;
    if (atFocus !== null && timerInput.value === atFocus) {
      renderTimer();
      return;
    }
    const raw = timerInput.value.trim();
    const parsed = TrackerStorage.parseStringToSeconds(timerInput.value);
    if (parsed === 0 && raw !== '' && !/^0+([:.]0+)*$/.test(raw)) {
      showStatus('Could not read "' + raw + '" as a time. Use mm:ss, for example 25:00.', 'error');
    }
    armTimer(parsed);
  });

  function renderAlertToggles() {
    el('timer-sound-btn').setAttribute('aria-pressed', prefs.timerSound ? 'true' : 'false');
    el('timer-desktop-btn').setAttribute('aria-pressed', prefs.timerDesktop ? 'true' : 'false');
    el('sound-switch').setAttribute('aria-checked', prefs.timerSound ? 'true' : 'false');
    el('desktop-switch').setAttribute('aria-checked', prefs.timerDesktop ? 'true' : 'false');
    el('reminder-switch').setAttribute('aria-checked', prefs.reminderEnabled ? 'true' : 'false');
    el('reminder-time-row').classList.toggle('hidden', !prefs.reminderEnabled);
    if (document.activeElement !== el('reminder-time')) el('reminder-time').value = prefs.reminderTime || '14:30';
  }

  async function setPref(patch, message) {
    try {
      prefs = await TrackerStorage.setPrefs(patch);
    } catch (err) {
      oops('That setting did not save. Please try again.', err);
      return;
    }
    renderAlertToggles();
    applyAppearance();
    renderCoachSettings();
    if (metrics.length && stats) renderUI();
    if (message) showStatus(message, 'ok');
  }

  el('timer-sound-btn').addEventListener('click', () => setPref({ timerSound: !prefs.timerSound }, prefs.timerSound ? 'Timer sound off.' : 'Timer sound on.'));
  el('timer-desktop-btn').addEventListener('click', () => setPref({ timerDesktop: !prefs.timerDesktop }, prefs.timerDesktop ? 'Desktop alerts off.' : 'Desktop alerts on.'));
  el('sound-switch').addEventListener('click', () => setPref({ timerSound: !prefs.timerSound }));
  el('desktop-switch').addEventListener('click', () => setPref({ timerDesktop: !prefs.timerDesktop }));
  el('reminder-switch').addEventListener('click', () => {
    if (!prefs.reminderEnabled) markSetup('checkin');
    setPref({ reminderEnabled: !prefs.reminderEnabled }, prefs.reminderEnabled ? 'Check-in reminder off.' : 'Check-in reminder on. LIT will nudge you once a day.');
  });
  el('reminder-time').addEventListener('change', (e) => {
    const value = e.target.value;
    if (/^\d{2}:\d{2}$/.test(value)) setPref({ reminderTime: value }, 'Check-in moved to ' + value + '.');
  });

  // ---------------------------------------------------------------------------
  // Account chip and menu
  // ---------------------------------------------------------------------------
  // Plain "Saved" states instead of system status words.
  const SYNC_TEXT = {
    active: 'Saved to your account',
    offline: 'Saved on this computer for now',
    expired: 'Sign in again to keep saving to your account',
    out: 'Saved on this computer',
    local: 'Profile on this computer'
  };

  // 'google' when this build has real Google sign-in, otherwise 'local':
  // a named profile kept on this computer only.
  function signInMode() {
    try {
      if (has(TrackerAuth, 'signInMode')) return TrackerAuth.signInMode() === 'local' ? 'local' : 'google';
    } catch (e) { /* fall through */ }
    return 'google';
  }
  function isLocalUser(user) {
    return !!(user && user.email && (user.provider === 'local' || /@local$/.test(user.email)));
  }
  function accountName(user) {
    if (!user || !user.email) return '';
    return isLocalUser(user) ? (user.name || user.email.replace(/@local$/, '')) : user.email;
  }

  function syncState() {
    if (!currentUser || !currentUser.email) return 'out';
    if (isLocalUser(currentUser)) return 'local';
    if (currentUser.sessionExpired) return 'expired';
    return navigator.onLine === false ? 'offline' : 'active';
  }

  const PERSON_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" aria-hidden="true" focusable="false"><circle cx="10" cy="7" r="3.2" stroke="currentColor" stroke-width="1.6"/><path d="M3.8 16.5a6.2 6.2 0 0 1 12.4 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // Google profile photo when OAuth supplied one, otherwise the initial.
  function renderAvatar(node, user) {
    node.textContent = '';
    node.classList.remove('has-initial');
    if (!user || !user.email) {
      node.innerHTML = PERSON_SVG;
      return;
    }
    const initial = () => {
      node.textContent = (user.name || user.email)[0].toUpperCase();
      node.classList.add('has-initial');
    };
    if (user.picture) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = user.picture;
      img.addEventListener('error', () => { node.textContent = ''; initial(); });
      node.appendChild(img);
      return;
    }
    initial();
  }

  function renderAuth() {
    const signedIn = !!(currentUser && currentUser.email);
    const state = syncState();
    const chip = el('profile-chip');
    chip.classList.toggle('signed-in', signedIn);
    const local = signInMode() === 'local';
    const outHint = local ? 'Use a profile on this computer' : 'Sign in to keep your streak on every computer';
    const who = accountName(currentUser);
    chip.setAttribute('aria-label', signedIn ? (isLocalUser(currentUser) ? 'Profile ' : 'Account ') + who + ', ' + SYNC_TEXT[state] : outHint);
    chip.title = signedIn ? who + ' · ' + SYNC_TEXT[state] : outHint;
    el('chip-label').textContent = signedIn ? '' : (local ? 'Profile' : 'Sign in');
    const signinText = el('menu-signin').querySelector('.menu-item-text');
    if (signinText) {
      signinText.firstElementChild.textContent = local ? 'Use a profile on this computer' : 'Sign in with Google';
      signinText.lastElementChild.textContent = local ? 'Keeps your entries apart from anyone else here' : 'Keep your streak on every computer';
    }
    el('menu-switch').querySelector('span').textContent = isLocalUser(currentUser) ? 'Switch profile' : 'Switch account';
    el('sync-dot').dataset.state = state;
    el('menu-sync-dot').dataset.state = state;
    renderAvatar(el('account-badge'), currentUser);
    renderAvatar(el('menu-avatar'), currentUser);
    el('account-email').textContent = signedIn ? who : 'Not signed in';
    el('account-sub').textContent = SYNC_TEXT[state];
    el('menu-signin').classList.toggle('hidden', signedIn);
    el('menu-switch').classList.toggle('hidden', !signedIn);
    el('account-signout-btn').classList.toggle('hidden', !signedIn);
  }

  window.addEventListener('online', renderAuth);
  window.addEventListener('offline', renderAuth);

  const profile = el('profile');
  let hoverTimer = null;

  function openProfileMenu(viaClick) {
    profile.classList.add(viaClick ? 'open' : 'hover-open');
    el('profile-chip').setAttribute('aria-expanded', 'true');
  }

  function closeProfileMenu() {
    profile.classList.remove('open', 'hover-open');
    el('profile-chip').setAttribute('aria-expanded', 'false');
  }

  profile.addEventListener('mouseenter', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => openProfileMenu(false), 80);
  });
  profile.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      profile.classList.remove('hover-open');
      if (!profile.classList.contains('open')) el('profile-chip').setAttribute('aria-expanded', 'false');
    }, 180);
  });

  el('profile-chip').addEventListener('click', () => {
    if (profile.classList.contains('open')) {
      closeProfileMenu();
      return;
    }
    openProfileMenu(true);
    const first = profile.querySelector('.menu-item:not(.hidden)');
    if (first) first.focus();
  });

  profile.addEventListener('keydown', (e) => {
    if (!profile.classList.contains('open') && !profile.classList.contains('hover-open')) return;
    const items = Array.from(profile.querySelectorAll('.menu-item:not(.hidden)'));
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      closeProfileMenu();
      el('profile-chip').focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      (items[i + 1] || items[0]).focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      (items[i - 1] || items[items.length - 1]).focus();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!profile.contains(e.target)) closeProfileMenu();
  }, true);

  el('profile-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    closeProfileMenu();
    const action = item.dataset.action;
    if (action === 'signin') signIn();
    else if (action === 'switch') switchAccount();
    else if (action === 'signout') signOut();
    else if (action === 'settings') openSettings();
    else if (action === 'export-csv') exportData('csv');
    else if (action === 'export-json') exportData('json');
    else if (action === 'copy-md') exportData('md');
  });

  // Entries logged while signed out stay under the signed-out account. Note
  // how many there were before signing in, so the popup can offer to bring
  // them into the account afterwards.
  function rememberSignedOutEntries() {
    if (currentUser && currentUser.email) return;
    const n = (stats && stats.totalLogs) || 0;
    if (n > 0) saveUiState({ signedOutCount: n });
  }

  async function afterSignIn() {
    const user = await TrackerAuth.getCurrentUser().catch(() => null);
    if (user && user.email && ui.signedOutCount > 0 && has(TrackerStorage, 'mergeSignedOutEntries')) {
      saveUiState({ mergeOfferFor: user.email });
    }
    showStatus(isLocalUser(user)
      ? 'Profile ready. What you log now is kept under ' + accountName(user) + '.'
      : 'Signed in. Your streak now follows you to every computer.', 'ok');
    await loadData();
  }

  // The sign-in dialog doubles as "Use a profile on this computer" when the
  // build has no Google sign-in: it then takes a plain name.
  function openProfileDialog(mode) {
    const local = mode === 'local';
    el('email-signin-title').textContent = local ? 'Use a profile on this computer' : 'Sign in with your Google email';
    el('email-signin-hint').textContent = local
      ? 'LIT keeps a separate set of entries for each profile on this computer. Nothing is sent anywhere.'
      : 'Signing in keeps your streak on every computer where you use Chrome.';
    el('email-signin-label').textContent = local ? 'Your name' : 'Your Google email';
    const input = el('email-signin-input');
    input.type = local ? 'text' : 'email';
    input.placeholder = local ? 'e.g. Sam' : 'you@gmail.com';
    input.autocomplete = local ? 'given-name' : 'email';
    input.value = '';
    el('email-signin-form').dataset.mode = local ? 'local' : 'google';
    openModal(el('email-signin-modal'), 'email-signin-input');
  }

  async function signIn() {
    rememberSignedOutEntries();
    if (signInMode() === 'local') {
      openProfileDialog('local');
      return;
    }
    try {
      // Never let auth.js fall back to window.prompt: an MV3 popup can close
      // under that dialog. Unpaired builds get our own dialog instead.
      await TrackerAuth.signInWithGoogle(undefined, { allowPrompt: false });
    } catch (err) {
      if (err && err.code === 'EMAIL_REQUIRED') {
        openProfileDialog(err.mode === 'local' ? 'local' : 'google');
        return;
      }
      oops('Sign-in did not finish. Please try again.', err);
      return;
    }
    await afterSignIn();
  }

  async function signOut(quiet) {
    try {
      await TrackerAuth.signOut();
    } catch (err) {
      oops('Sign-out did not finish. Please try again.', err);
      return false;
    }
    if (!quiet) showStatus('Signed out. You are seeing what was saved on this computer.', 'ok');
    await loadData();
    return true;
  }

  // "Your earlier entries are safe": shown once after signing in when there
  // were entries from signed-out use, until merged or put off.
  function renderMergeCard() {
    const card = el('merge-card');
    const email = currentUser && currentUser.email;
    const show = !!email && ui.mergeOfferFor === email && has(TrackerStorage, 'mergeSignedOutEntries');
    card.classList.toggle('hidden', !show);
    if (show) {
      const n = ui.signedOutCount || 0;
      el('merge-body').textContent = 'You logged ' + (n === 1 ? 'one' : n) + ' before signing in. ' + (n === 1 ? 'It is' : 'They are') + ' still saved on this computer.';
    }
  }

  el('merge-btn').addEventListener('click', async () => {
    const email = currentUser && currentUser.email;
    if (!email || !has(TrackerStorage, 'mergeSignedOutEntries')) return;
    const btn = el('merge-btn');
    btn.disabled = true;
    let result;
    try {
      result = await TrackerStorage.mergeSignedOutEntries(email);
    } catch (err) {
      btn.disabled = false;
      oops('Those entries could not be moved just now. They are still safe. Please try again.', err);
      return;
    }
    btn.disabled = false;
    saveUiState({ mergeOfferFor: null, signedOutCount: 0 });
    const moved = (result && result.moved) || 0;
    showStatus(moved > 0
      ? 'Done. ' + moved + (moved === 1 ? ' entry is' : ' entries are') + ' now part of this account.'
      : 'All set. Everything was already in this account.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  el('merge-later-btn').addEventListener('click', () => {
    saveUiState({ mergeOfferFor: null });
    renderMergeCard();
    showStatus('No problem. Your earlier entries stay safe on this computer.', 'ok');
  });

  async function switchAccount() {
    if (await signOut(true)) signIn();
  }

  // Direct email sign-in dialog (unpacked builds with no GCP client paired)
  el('email-signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const local = el('email-signin-form').dataset.mode === 'local';
    const value = el('email-signin-input').value;
    try {
      if (local && has(TrackerAuth, 'signInLocal')) await TrackerAuth.signInLocal(value);
      else await TrackerAuth.signInWithEmail(value);
    } catch (err) {
      oops(local ? 'Type a name for this profile, like your first name.' : 'That email did not work. Check it and try again.', err);
      el('email-signin-input').focus();
      return;
    }
    closeModal(el('email-signin-modal'));
    await afterSignIn();
  });

  el('close-email-signin-modal').addEventListener('click', () => closeModal(el('email-signin-modal')));
  el('cancel-email-signin-btn').addEventListener('click', () => closeModal(el('email-signin-modal')));

  function notifyCalendarTabs() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ url: '*://calendar.google.com/*' }, (tabs) => {
        (tabs || []).forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'PT_REFRESH' }).catch(() => {});
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  // Storage events, sign-in, and button handlers can all ask for a reload at
  // once; they collapse into one in flight plus at most one queued.
  let loadPromise = null;
  let loadQueued = false;

  function loadData() {
    if (loadPromise) {
      loadQueued = true;
      return loadPromise;
    }
    loadPromise = doLoad().catch(err => {
      oops('LIT could not load your progress just now. Close and reopen the popup to try again.', err);
    }).finally(() => {
      loadPromise = null;
      if (loadQueued) {
        loadQueued = false;
        loadData();
      }
    });
    return loadPromise;
  }

  async function doLoad() {
    currentUser = await TrackerAuth.getCurrentUser();
    const [m, s, w, p] = await Promise.all([
      TrackerStorage.getMetrics(),
      TrackerStorage.getStats(),
      WidgetLayout.load(),
      TrackerStorage.getPrefs(),
      loadCardData()
    ]);
    metrics = m;
    stats = s;
    widgetItems = w;
    prefs = p;
    jobsCache = null;
    applyAppearance();
    renderAuth();
    renderAlertToggles();
    renderUI();
    renderDigest();
    renderMergeCard();
    checkMilestones();
  }

  function getJobs() {
    if (!jobsCache) {
      const cache = { logs: null, promise: null };
      // Newest application date first; entries logged for the same day keep
      // storage's newest-logged-first order. A backfilled entry sorts by the
      // day it happened, not the day it was typed in.
      cache.promise = TrackerStorage.getLogs({ metricId: 'jobs' }).then(logs => {
        const order = new Map(logs.map((l, i) => [l.id, i]));
        const sorted = logs.slice().sort((a, b) => (a.date === b.date ? order.get(a.id) - order.get(b.id) : (a.date < b.date ? 1 : -1)));
        cache.logs = sorted;
        return sorted;
      });
      jobsCache = cache;
    }
    return jobsCache;
  }

  // Runs fn(logs) now if the job entries are loaded, or once they arrive
  // (unless the widget re-rendered or went away meanwhile).
  function withJobs(body, key, fn) {
    const cache = getJobs();
    if (cache.logs) {
      fn(cache.logs);
      return;
    }
    const token = bumpToken(key);
    cache.promise.then(logs => {
      if (asyncTokens[key] !== token || !body.isConnected) return;
      fn(logs);
    }).catch(err => oops('Your applications could not load just now. Reopen the popup to try again.', err));
  }

  function renderUI() {
    const shown = visibleMetrics();
    const current = (metricById(activeMetricId) && !metricById(activeMetricId).hidden ? metricById(activeMetricId) : null) || shown[0] || metrics[0];
    if (!current) return;
    activeMetricId = current.id;
    setTrackerColor(el('counter-card'), current.color);
    renderTabs();
    renderCounter(current);
    renderHeadline(current);
    renderBuddy(current);
    renderStreak(current);
    renderWeekStrip(current);
    renderLock(current);
    renderSetup();
    renderTip();
    renderWidgets();
    bridgeEmit('render', { metric: current });
  }

  function bridgeEmit(name, detail) {
    if (typeof LitPopup !== 'undefined') LitPopup.emit(name, detail);
  }

  function todayFor(metric) {
    if (stats.todayCount && stats.todayCount[metric.id] !== undefined) return stats.todayCount[metric.id] || 0;
    return (stats.today && stats.today[metric.id]) || 0;
  }

  function goalMetFor(metric) {
    if (stats.goalMet && typeof stats.goalMet[metric.id] === 'boolean') return stats.goalMet[metric.id];
    return todayFor(metric) >= goalFor(metric);
  }

  function streakFor(metric) {
    return (stats.streaks && stats.streaks[metric.id]) || 0;
  }

  // Daily-state headline under the date, in the chosen coach voice.
  // ---------------------------------------------------------------------------
  // The buddy: a small character beside the counter with a speech bubble.
  // It reacts to logging, celebrates the goal, naps on rest days, and repeats
  // the service worker's break and water nudges with a "Taking a break" button.
  // ---------------------------------------------------------------------------
  let buddyOverride = null;
  let buddyCheerSoon = false;
  let buddyTapIndex = 0;
  let buddyTimer = null;

  function buddyOn() {
    return prefs.buddyEnabled !== false && typeof LitBuddy !== 'undefined';
  }

  function setBuddy(text, mood, action) {
    const box = el('buddy');
    box.dataset.mood = mood || 'idle';
    el('buddy-text').textContent = text;
    const btn = el('buddy-action');
    btn.classList.toggle('hidden', !action);
    if (action) {
      btn.textContent = action.label;
      btn.onclick = action.run;
    } else {
      btn.onclick = null;
    }
  }

  function buddyLine(current) {
    const now = Date.now();
    const L = LitBuddy.lines;
    const count = todayFor(current);
    const goal = goalFor(current);
    const s = buddySession;
    // A nudge from the worker in the last 20 minutes, or one due right now.
    const recent = s && s.lastNudge && now - s.lastNudge.at < 20 * 60 * 1000 ? s.lastNudge : null;
    const due = !recent && s ? LitBuddy.nudgeDue(s, now, prefs) : null;
    const kind = recent ? recent.kind : due;
    if (kind) {
      const mins = recent ? recent.minutes : LitBuddy.activeMinutes(s, now);
      return {
        text: kind === 'break' ? L.breakNudge(Math.max(1, mins)) : L.water(),
        mood: 'thirsty',
        action: { label: kind === 'break' ? 'Taking a break' : 'Done', run: buddyTakeBreak }
      };
    }
    if (stats && stats.restToday && count === 0) return { text: L.rest(), mood: 'sleepy' };
    if (count >= goal) return { text: L.goalMet(dayIndex()), mood: 'happy' };
    if (count > 0) return { text: L.progress(count, goal, displayUnit(current, 2)), mood: 'idle' };
    return { text: L.greeting(new Date().getHours(), prefs.buddyName), mood: 'idle' };
  }

  function renderBuddy(current) {
    const box = el('buddy');
    if (!box) return;
    box.classList.toggle('hidden', !buddyOn());
    if (!buddyOn() || !current) return;
    const btn = el('buddy-btn');
    if (!btn.firstChild) btn.innerHTML = LitBuddy.svg();
    btn.setAttribute('aria-label', (prefs.buddyName || 'Lockie') + ', your buddy. Tap for a tip.');
    btn.title = prefs.buddyName || 'Lockie';
    if (buddyCheerSoon) {
      buddyCheerSoon = false;
      const met = todayFor(current) >= goalFor(current);
      buddyOverride = { text: met ? LitBuddy.lines.goalMet(Date.now()) : LitBuddy.lines.cheer(Date.now()), mood: 'cheer', until: Date.now() + 4000 };
      clearTimeout(buddyTimer);
      buddyTimer = setTimeout(() => { buddyOverride = null; renderBuddy(metricById(activeMetricId)); }, 4100);
    }
    if (buddyOverride && buddyOverride.until > Date.now()) {
      setBuddy(buddyOverride.text, buddyOverride.mood, buddyOverride.action);
      return;
    }
    const line = buddyLine(current);
    setBuddy(line.text, line.mood, line.action);
  }

  function buddyTakeBreak() {
    const now = Date.now();
    if (buddySession && typeof LitBuddy !== 'undefined') {
      buddySession = LitBuddy.markNudged(buddySession, 'break', now);
      buddySession.lastNudge = null;
      const local = storageArea('local');
      if (local) local.set({ [LitBuddy.SESSION_KEY]: buddySession });
    }
    buddyOverride = { text: LitBuddy.lines.breakThanks(), mood: 'happy', until: now + 5000 };
    clearTimeout(buddyTimer);
    buddyTimer = setTimeout(() => { buddyOverride = null; renderBuddy(metricById(activeMetricId)); }, 5100);
    renderBuddy(metricById(activeMetricId));
  }

  el('buddy-btn').addEventListener('click', () => {
    if (!buddyOn()) return;
    const taps = LitBuddy.lines.taps;
    const text = taps[buddyTapIndex % taps.length];
    buddyTapIndex += 1;
    buddyOverride = { text, mood: 'cheer', until: Date.now() + 5000 };
    clearTimeout(buddyTimer);
    buddyTimer = setTimeout(() => { buddyOverride = null; renderBuddy(metricById(activeMetricId)); }, 5100);
    renderBuddy(metricById(activeMetricId));
  });

  function renderHeadline(current) {
    const count = todayFor(current);
    const goal = goalFor(current);
    el('day-headline').textContent = coach('headline', [{ count, goal, voice: voice() }], () => {
      if (count >= goal) return 'Locked in for today.';
      if (count === 0) return 'Ready when you are';
      const left = goal - count;
      return 'Nice, that\'s ' + count + '. ' + left + ' more locks it in.';
    });
    const goingFor = (prefs.goingFor || '').trim();
    el('going-for').classList.toggle('hidden', !goingFor);
    el('going-for-text').textContent = goingFor;
    el('going-for').title = goingFor ? 'Going for ' + goingFor : '';
  }

  // Streak pill: flame in three sizes, a grey ember at zero, freezes, rest.
  let flameFlickered = false;
  function renderStreak(current) {
    const days = streakFor(current);
    const restToday = !!stats.restToday && !goalMetFor(current);
    const freeze = stats.freezes && stats.freezes[current.id];
    const available = freeze ? Math.max(0, parseInt(freeze.available, 10) || 0) : 0;
    const usedOn = freeze && Array.isArray(freeze.usedOn) ? freeze.usedOn : [];
    const weekAgo = TrackerStorage.addDays ? TrackerStorage.addDays(todayStr(), -7) : '';
    const freezeUsed = usedOn.some(d => d >= weekAgo);
    const pill = el('streak-pill');
    const size = days <= 0 ? 0 : (days < 7 ? 1 : (days < 30 ? 2 : 3));
    pill.dataset.size = String(size);
    pill.classList.toggle('resting', restToday);
    let label;
    if (restToday) label = days > 0 ? days + (days === 1 ? ' day' : ' days') + ' · rest day' : 'Rest day';
    else if (days <= 0) label = coach('streak', [{ days: 0, restToday: false, voice: voice() }], 'Fresh start today');
    else label = days + (days === 1 ? '-day streak' : '-day streak');
    // The pill is short; drill voice adds a line that belongs in the title.
    if (days <= 0 && label.length > 22) label = 'Fresh start today';
    el('streak-text').textContent = label;
    const sentence = coach('streak', [{ days, restToday, freezeUsed, voice: voice() }], days > 0 ? 'Day ' + days + '. Keep it rolling.' : 'Fresh start today');
    const freezeText = available > 0 ? ' ' + available + (available === 1 ? ' streak freeze' : ' streak freezes') + ' saved up: a missed day gets covered automatically.' : '';
    pill.title = sentence + freezeText;
    pill.setAttribute('aria-label', sentence + freezeText);
    el('freeze-chip').classList.toggle('hidden', available <= 0);
    el('freeze-count').textContent = available;
    if (!flameFlickered && !reduceMotion && size > 0) {
      flameFlickered = true;
      const flame = el('streak-flame');
      flame.classList.add('flicker');
      setTimeout(() => flame.classList.remove('flicker'), 1000);
    }
  }

  // Padlock brand mark. The shackle snaps shut once per goal per day; the
  // date is remembered so reopening the popup does not replay it.
  function lockStateFor(current) {
    if (goalMetFor(current)) return streakFor(current) >= 7 ? 'locked-glow' : 'locked';
    if (stats.restToday) return 'resting';
    return 'open';
  }
  const LOCK_LABELS = { open: 'open', locked: 'locked for today', 'locked-glow': 'locked, on a streak', resting: 'resting today' };

  function renderLock(current) {
    const mark = el('brand-mark');
    const state = lockStateFor(current);
    mark.setAttribute('aria-label', 'LIT padlock, ' + LOCK_LABELS[state]);
    const today = todayStr();
    const played = ui.lockShut && ui.lockShut[current.id] === today;
    const isLocked = state === 'locked' || state === 'locked-glow';
    if (isLocked && !played) {
      saveUiState({ lockShut: Object.assign({}, ui.lockShut, { [current.id]: today }) });
      if (!reduceMotion) {
        mark.classList.add('no-anim');
        mark.dataset.state = 'open';
        void mark.offsetWidth;
        mark.classList.remove('no-anim');
        requestAnimationFrame(() => requestAnimationFrame(() => {
          mark.dataset.state = state;
          mark.classList.add('snap');
          setTimeout(() => mark.classList.remove('snap'), 500);
        }));
        return;
      }
    }
    mark.dataset.state = state;
  }

  // ---------------------------------------------------------------------------
  // Tracker tabs with a sliding highlight
  // ---------------------------------------------------------------------------
  const TRACKER_ICONS = {
    briefcase: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><rect x="2.8" y="5.5" width="14.4" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7.3 5.5V4.3a1.2 1.2 0 0 1 1.2-1.2h3a1.2 1.2 0 0 1 1.2 1.2v1.2M2.8 10h14.4" stroke="currentColor" stroke-width="1.6"/></svg>',
    code: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M6.5 6 2.8 10l3.7 4M13.5 6l3.7 4-3.7 4M11.3 4.2 8.7 15.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    target: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="3.8" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/></svg>',
    chat: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h-1A1.5 1.5 0 0 1 3 12.5v-7A1.5 1.5 0 0 1 4.5 4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    mail: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><rect x="2.8" y="4.5" width="14.4" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="m3.5 5.5 6.5 5 6.5-5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    book: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M10 5.5C8.5 4.3 6.3 3.8 3.5 4v11c2.8-.2 5 .3 6.5 1.5 1.5-1.2 3.7-1.7 6.5-1.5V4c-2.8-.2-5 .3-6.5 1.5Zm0 0v11" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    pen: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M12.8 3.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L7.5 16H4v-3.5l8.8-8.8ZM11.5 5l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    people: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><circle cx="7.5" cy="7" r="2.8" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 16c.4-2.8 2.4-4.5 5-4.5s4.6 1.7 5 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M13 4.5a2.6 2.6 0 0 1 0 5M14.5 11.8c1.7.5 2.8 2 3 4.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    phone: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M5 3h2.5l1.3 3.4-1.7 1.2a8.5 8.5 0 0 0 5.3 5.3l1.2-1.7L17 12.5V15a2 2 0 0 1-2 2C8.4 17 3 11.6 3 5a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    star: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="m10 3 2.1 4.4 4.8.6-3.5 3.3.9 4.8L10 13.8 5.7 16.1l.9-4.8L3.1 8l4.8-.6L10 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
  };
  const ICON_NAMES = { briefcase: 'Briefcase', code: 'Code', target: 'Target', chat: 'Chat', mail: 'Mail', book: 'Book', pen: 'Pen', people: 'People', phone: 'Phone', star: 'Star' };

  function iconKey(metric) {
    if (metric.icon === 'users') return 'people';
    if (metric.icon && TRACKER_ICONS[metric.icon] && !(metric.icon === 'target' && (metric.id === 'jobs' || metric.id === 'leetcode'))) return metric.icon;
    if (metric.id === 'jobs') return 'briefcase';
    if (metric.id === 'leetcode') return 'code';
    return 'target';
  }

  function iconFor(metric) {
    return TRACKER_ICONS[iconKey(metric)];
  }

  let tabsRendered = false;

  function renderTabs() {
    const container = el('metric-tabs');
    container.querySelectorAll('.tab-item').forEach(n => n.remove());
    visibleMetrics().forEach(m => {
      const active = m.id === activeMetricId;
      const tab = make('button', 'tab-item' + (active ? ' active' : ''));
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;
      tab.dataset.metricId = m.id;
      tab.style.setProperty('--tab-color', m.color);
      const icon = make('span', 'tab-icon');
      icon.style.color = m.color;
      icon.innerHTML = iconFor(m);
      tab.appendChild(icon);
      tab.appendChild(make('span', '', m.name));
      const count = todayFor(m);
      if (count > 0) tab.appendChild(make('span', 'tab-count', count));
      container.appendChild(tab);
    });
    const animate = tabsRendered && !reduceMotion;
    tabsRendered = true;
    requestAnimationFrame(() => moveTabIndicator(animate));
  }

  function moveTabIndicator(animate) {
    const container = el('metric-tabs');
    const indicator = el('tab-indicator');
    const active = container.querySelector('.tab-item.active');
    if (!active) {
      indicator.style.width = '0';
      return;
    }
    container.classList.toggle('animated', !!animate);
    indicator.style.width = active.offsetWidth + 'px';
    indicator.style.transform = 'translateX(' + active.offsetLeft + 'px)';
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < container.scrollLeft || right > container.scrollLeft + container.clientWidth) {
      container.scrollTo({ left: Math.max(0, left - 24), behavior: animate ? 'smooth' : 'auto' });
    }
  }

  function tabNode(id) {
    return el('metric-tabs').querySelector('[data-metric-id="' + CSS.escape(id) + '"]');
  }

  function selectTracker(id) {
    if (id === activeMetricId || !metricById(id)) return;
    const hadTabFocus = document.activeElement && document.activeElement.classList.contains('tab-item');
    activeMetricId = id;
    pipelineFilter = null;
    TrackerStorage.setActiveMetricId(id);
    renderUI();
    bridgeEmit('tab', { metric: metricById(id) });
    if (hadTabFocus && tabNode(id)) tabNode(id).focus();
  }

  el('metric-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab-item');
    if (tab) selectTracker(tab.dataset.metricId);
  });

  el('metric-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const list = visibleMetrics();
    const i = list.findIndex(m => m.id === activeMetricId);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % list.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + list.length) % list.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = list.length - 1;
    selectTracker(list[next].id);
    const tab = tabNode(list[next].id);
    if (tab) tab.focus();
  });

  window.addEventListener('resize', () => moveTabIndicator(false));

  // ---------------------------------------------------------------------------
  // Counter card: rolling digits and the goal ring
  // ---------------------------------------------------------------------------
  const RING_C = 2 * Math.PI * 52;
  let countersRendered = false;

  // Each digit is a vertical strip of 0-9 that slides to its value, so +1 and
  // -1 roll the way a mechanical counter does. Going up the roll overshoots a
  // touch; going down it settles flat.
  function renderTicker(node, value, animate) {
    const str = String(Math.max(0, parseInt(value, 10) || 0));
    const prev = node.dataset.value;
    if (prev === str && node.querySelector('.digit')) return;
    node.dataset.value = str;
    node.setAttribute('aria-label', str);
    const up = prev !== undefined && Number(str) > Number(prev);
    node.classList.toggle('roll-up', up);
    node.classList.toggle('roll-down', !up);
    const build = len => {
      node.textContent = '';
      for (let d = 0; d < len; d++) {
        const digit = make('span', 'digit');
        digit.setAttribute('aria-hidden', 'true');
        const strip = make('span', 'strip');
        for (let i = 0; i < 10; i++) strip.appendChild(make('span', '', i));
        digit.appendChild(strip);
        node.appendChild(digit);
      }
    };
    const setDigits = digits => {
      digits.split('').forEach((ch, i) => {
        const strip = node.children[i] && node.children[i].firstChild;
        if (strip) strip.style.transform = 'translateY(' + (-Number(ch)) + 'em)';
      });
    };
    const instant = digits => {
      node.classList.add('no-anim');
      build(digits.length);
      setDigits(digits);
      void node.offsetWidth;
      node.classList.remove('no-anim');
    };
    if (!animate || prev === undefined || reduceMotion) {
      instant(str);
      return;
    }
    if (prev.length < str.length) {
      instant(prev.padStart(str.length, '0'));
      requestAnimationFrame(() => setDigits(str));
      return;
    }
    if (prev.length > str.length) {
      instant(str);
      return;
    }
    setDigits(str);
  }

  function buildRingTicks() {
    const g = el('ring-ticks');
    if (g.childNodes.length) return;
    [0.25, 0.5, 0.75].forEach(p => {
      const angle = 2 * Math.PI * p;
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(60 + 52 * Math.cos(angle)));
      c.setAttribute('cy', String(60 + 52 * Math.sin(angle)));
      c.setAttribute('r', '2.2');
      c.setAttribute('class', 'ring-tick');
      c.dataset.pct = String(p);
      g.appendChild(c);
    });
  }

  // Restarts a one-shot CSS animation class.
  function replay(node, cls, ms) {
    if (!node || reduceMotion) return;
    node.classList.remove(cls);
    void (node.getBBox ? node.getBoundingClientRect() : node.offsetWidth);
    node.classList.add(cls);
    setTimeout(() => node.classList.remove(cls), ms);
  }

  function quickAddLabel(metric) {
    if (metric.id === 'jobs') return 'Log application';
    if (metric.id === 'leetcode') return 'Log problem';
    return 'Log ' + unitSingular(metric);
  }

  function counterLabel(metric, n) {
    if (metric.id === 'jobs') return (n === 1 ? 'application' : 'applications') + ' sent today';
    if (metric.id === 'leetcode') return (n === 1 ? 'problem' : 'problems') + ' solved today';
    return displayUnit(metric, n) + ' today';
  }

  // The newly added arc glows for a moment.
  function flashNewArc(fromPct, toPct) {
    const arc = el('ring-new');
    if (!arc || reduceMotion || toPct <= fromPct) return;
    const start = RING_C * fromPct;
    const len = RING_C * (toPct - fromPct);
    arc.style.strokeDasharray = len + ' ' + RING_C;
    arc.style.strokeDashoffset = String(-start);
    replay(arc, 'flash', 820);
  }

  // Twelve accent dots burst from the ring, once per goal per day.
  function burstRing() {
    const wrap = el('ring-wrap');
    if (!wrap || reduceMotion) return;
    const burst = make('div', 'burst');
    burst.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 12; i++) {
      const dot = make('i');
      dot.style.setProperty('--a', (i * 30) + 'deg');
      dot.style.setProperty('--d', (i % 3) * 25 + 'ms');
      burst.appendChild(dot);
    }
    wrap.appendChild(burst);
    setTimeout(() => burst.remove(), 1000);
  }

  function floatPlusChip() {
    const wrap = el('ring-wrap');
    if (!wrap || reduceMotion) return;
    const chip = make('span', 'plus-chip', '+1');
    chip.setAttribute('aria-hidden', 'true');
    wrap.appendChild(chip);
    setTimeout(() => chip.remove(), 950);
  }

  // The goal-complete burst plays once per goal per day, whether the goal
  // was hit here or by an auto-logged application while the popup was shut.
  function maybeCelebrateGoal(current, met) {
    if (!met) return;
    const today = todayStr();
    if (ui.burst && ui.burst[current.id] === today) return;
    saveUiState({ burst: Object.assign({}, ui.burst, { [current.id]: today }) });
    burstRing();
    bridgeEmit('goal-met', { metric: current });
    replay(el('ring-wrap'), 'celebrate', 1300);
    requestAnimationFrame(() => widgetsHost.querySelectorAll('.widget-goal').forEach(n => replay(n, 'celebrate', 1300)));
  }

  function renderCounter(current) {
    const today = todayFor(current);
    const goal = goalFor(current);
    const met = today >= goal;
    const prevRendered = el('metric-count').dataset.value;
    const prevSameMetric = el('counter-card').dataset.metricId === current.id;
    renderTicker(el('metric-count'), today, countersRendered && prevSameMetric);
    countersRendered = true;
    el('counter-card').dataset.metricId = current.id;
    el('ring-goal').textContent = 'of ' + goal;

    buildRingTicks();
    const pct = Math.min(1, today / goal);
    const prevCount = prevSameMetric && prevRendered !== undefined ? Number(prevRendered) : null;
    const prevPct = prevCount === null ? pct : Math.min(1, prevCount / goal);
    const fill = el('ring-fill');
    fill.style.strokeDasharray = String(RING_C);
    fill.style.strokeDashoffset = String(RING_C * (1 - pct));
    if (prevCount !== null && pct > prevPct) flashNewArc(prevPct, pct);
    el('ring-ticks').querySelectorAll('.ring-tick').forEach(t => {
      const at = Number(t.dataset.pct);
      const reached = pct >= at;
      if (reached && prevCount !== null && prevPct < at) replay(t, 'pulse', 720);
      t.classList.toggle('reached', reached);
    });
    el('ring-wrap').classList.toggle('met', met);

    el('metric-unit-label').textContent = counterLabel(current, today);
    el('ring-wrap').title = met ? 'Today\'s goal is done' : (goal - today) + ' to go for today\'s goal';

    const weekly = current.weeklyGoal || 0;
    const weekCount = (stats.weekToDate && stats.weekToDate[current.id]) || 0;
    el('week-line').classList.toggle('hidden', weekly <= 0);
    el('week-set-btn').classList.toggle('hidden', true);
    if (weekly > 0) {
      el('week-count').textContent = weekCount + ' / ' + weekly;
      el('week-fill').style.width = Math.min(100, Math.round((weekCount / weekly) * 100)) + '%';
      el('week-line').classList.toggle('met', weekCount >= weekly);
    }

    el('quick-add-label').textContent = quickAddLabel(current);
    el('undo-btn').setAttribute('aria-label', 'Undo last: take back the most recent ' + unitSingular(current) + ' logged today');

    maybeCelebrateGoal(current, met);
    metrics.forEach(m => { lastToday[m.id] = todayFor(m); });
  }

  el('week-set-btn').addEventListener('click', () => openMetricSettings(activeMetricId, 'metric-settings-weekly'));

  // Week strip: Monday to Sunday dots under the counter.
  const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DOT_WORDS = { met: 'goal met', some: 'some done', none: 'nothing logged', rest: 'rest day', frozen: 'covered by a streak freeze', future: 'still ahead' };
  const SNOW_SVG = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M6 1v10M1.7 3.5l8.6 5M1.7 8.5l8.6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  let lastWeekDots = [];

  async function weekDotsFor(metric) {
    if (has(TrackerStorage, 'getWeekDots')) return TrackerStorage.getWeekDots(metric.id);
    // Fallback: build the strip from two weeks of history.
    const history = await TrackerStorage.getActivityHistory(14, metric.id);
    const today = todayStr();
    const goal = goalFor(metric);
    const d = TrackerStorage.parseLocalDateToNoon(today);
    const back = (d.getDay() + 6) % 7;
    const start = TrackerStorage.addDays(today, -back);
    const byDate = {};
    history.days.forEach(x => { byDate[x.date] = x.count; });
    const out = [];
    for (let i = 0; i < 7; i++) {
      const date = TrackerStorage.addDays(start, i);
      const count = byDate[date] || 0;
      const state = date > today ? 'future' : (count >= goal ? 'met' : (count > 0 ? 'some' : 'none'));
      out.push({ date, count, goal, state, isToday: date === today });
    }
    return out;
  }

  async function renderWeekStrip(metric) {
    const list = el('week-dots');
    const token = bumpToken('weekdots');
    let dots;
    try {
      dots = await weekDotsFor(metric);
    } catch (err) {
      console.warn('[LIT] week strip unavailable', err);
      el('week-strip').classList.add('hidden');
      return;
    }
    if (asyncTokens.weekdots !== token || !Array.isArray(dots) || dots.length !== 7) return;
    el('week-strip').classList.remove('hidden');
    lastWeekDots = dots;
    list.textContent = '';
    dots.forEach(dot => {
      const day = TrackerStorage.parseLocalDateToNoon(dot.date).getDay();
      const li = make('li', 'week-dot state-' + dot.state + (dot.isToday ? ' is-today' : ''));
      const b = make('b');
      if (dot.state === 'met') b.innerHTML = CHECK_SVG;
      else if (dot.state === 'frozen') b.innerHTML = SNOW_SVG;
      li.appendChild(b);
      li.appendChild(make('em', null, DAY_LONG[day][0]));
      const words = DAY_LONG[day] + (dot.isToday ? ' (today)' : '') + ': ' + (dot.state === 'future' ? DOT_WORDS.future : dot.count + ' of ' + dot.goal + ', ' + DOT_WORDS[dot.state]);
      li.setAttribute('aria-label', words);
      li.title = words;
      list.appendChild(li);
    });
  }

  function openCalendar() {
    markSetup('calendar');
    if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url: 'https://calendar.google.com' });
    else window.open('https://calendar.google.com', '_blank');
  }
  el('week-calendar-link').addEventListener('click', openCalendar);

  // +1
  el('quick-add-btn').addEventListener('click', async () => {
    const btn = el('quick-add-btn');
    btn.classList.remove('pressed');
    void btn.offsetWidth;
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 160);
    floatPlusChip();

    let notes;
    let solveTimeSeconds = 0;
    if (activeMetricId === 'leetcode' && timerState.targetSeconds > 0) {
      const elapsed = getElapsedSeconds();
      if (elapsed > 0) {
        notes = formatSolveTimeString(elapsed);
        solveTimeSeconds = elapsed;
      }
      await clearTimerAfterLog();
    }

    try {
      await TrackerStorage.addLog({ metricId: activeMetricId, count: 1, notes, solveTimeSeconds });
    } catch (err) {
      oops('That one did not save. Please try again.', err);
      return;
    }
    if (solveTimeSeconds > 0) {
      showStatus('Logged with a solve time of ' + TrackerStorage.formatTimeHMS(solveTimeSeconds) + '.', 'ok');
    }
    buddyCheerSoon = true;
    notifyCalendarTabs();
    await loadData();
    const loggedMetric = metricById(activeMetricId);
    if (loggedMetric) bridgeEmit('log', { metric: loggedMetric, count: todayFor(loggedMetric), goal: goalFor(loggedMetric) });
  });

  // Undo last (the old -1): no celebration, and a toast to bring it back.
  el('undo-btn').addEventListener('click', async () => {
    const current = metricById(activeMetricId);
    const today = todayStr();
    let latest = null;
    try {
      const logs = await TrackerStorage.getLogs({ metricId: activeMetricId });
      latest = logs.find(l => l.date === today) || null;
    } catch (e) {
      latest = null;
    }
    let removed = false;
    try {
      removed = await TrackerStorage.undoLastLog(activeMetricId);
    } catch (err) {
      oops('That could not be undone just now. Please try again.', err);
      return;
    }
    if (!removed) {
      showStatus('Nothing logged today' + (current ? ' for ' + current.name : '') + ' yet, so there is nothing to undo.');
      return;
    }
    showStatus('Took back the last one from today.', 'ok', latest ? {
      label: 'Undo',
      run: () => restoreEntry(latest)
    } : null);
    notifyCalendarTabs();
    await loadData();
    bridgeEmit('undo', { metric: metricById(activeMetricId) });
  });

  // ---------------------------------------------------------------------------
  // Weekly recap
  // ---------------------------------------------------------------------------
  // Bars are the default: daily counts are discrete, so a line between days
  // suggests values that were never logged. Line stays for existing layouts
  // and for reading the overall trend.
  const CHART_LABELS = { bar: 'Bars', area: 'Line', heatmap: 'Grid' };
  const SUMMARY_LABELS = { today: 'Today', week: 'Last 7 days', month: 'This month', total: 'All time' };
  const CARD_COLOR_NAMES = { '#E0674B': 'Coral', '#5E9270': 'Sage', '#3B7EA1': 'Ocean', '#C9821F': 'Amber', '#8A5A9E': 'Plum', '#3D4A5C': 'Slate', '#C2185B': 'Berry', '#00897B': 'Teal' };
  const CHART_HINTS = { bar: 'Bars, one per day', area: 'Line, overall trend', heatmap: 'Grid, calendar by week' };
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const CHECK_SVG = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 6.2l2.2 2.3L9.5 3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // A 1-3 sentence story about a week, never reporting a decline.
  function weekStoryFor(m, lastWeekTotal) {
    const unit = m ? displayUnit(m, 2) : 'applications';
    const args = { total: m ? m.total : 0, bestDay: m ? m.bestDay : null, activeDays: m ? m.activeDays : 0, lastWeekTotal: lastWeekTotal || 0, unit };
    return coach('weekStory', [args], () => {
      if (!args.total) return 'A quiet week, and that is allowed. A fresh week starts whenever you do.';
      return args.total + ' ' + unit + ' across ' + args.activeDays + (args.activeDays === 1 ? ' day' : ' days') + '. Steady work adds up.';
    });
  }

  // Last week's recap: shown at the start of a new week until dismissed.
  let digestShare = null;
  async function renderDigest() {
    const card = el('digest-card');
    const weekStart = stats && stats.weekStartStr;
    if (!weekStart || prefs.digestDismissedWeek === weekStart) {
      card.classList.add('hidden');
      return;
    }
    const token = bumpToken('digest');
    let summary;
    let before = null;
    try {
      summary = await TrackerStorage.getWeekSummary();
      before = await TrackerStorage.getWeekSummary(TrackerStorage.addDays(summary.weekStart, -7)).catch(() => null);
    } catch (err) {
      card.classList.add('hidden');
      return;
    }
    if (asyncTokens.digest !== token) return;
    if (!summary || summary.total === 0) {
      card.classList.add('hidden');
      return;
    }
    // The story follows the goal on screen, or the busiest one last week.
    const pick = summary.metrics.find(m => m.id === activeMetricId && m.total > 0)
      || summary.metrics.slice().sort((x, y) => y.total - x.total)[0];
    const prior = before && before.metrics ? before.metrics.find(m => m.id === pick.id) : null;
    el('digest-title').textContent = shortDate(summary.weekStart) + ' to ' + shortDate(summary.weekEnd);
    el('digest-story').textContent = weekStoryFor(pick, prior ? prior.total : 0);
    const metric = metricById(pick.id);
    digestShare = {
      bigNumber: pick.total,
      bigLabel: (metric ? displayUnit(metric, pick.total) : 'done') + ' last week',
      metricId: pick.id
    };
    card.classList.remove('hidden');
  }

  el('digest-share-btn').addEventListener('click', () => {
    if (digestShare) openShare(digestShare);
  });

  el('digest-dismiss-btn').addEventListener('click', async () => {
    el('digest-card').classList.add('hidden');
    if (stats && stats.weekStartStr) await setPref({ digestDismissedWeek: stats.weekStartStr });
  });

  // ---------------------------------------------------------------------------
  // Widgets
  // ---------------------------------------------------------------------------
  const widgetsHost = el('widgets-host');
  // Customize mode: cards wiggle and show drag handles and remove buttons.
  let customizing = false;
  const widgetParts = el('widget-parts');
  const PART_IDS = { timer: 'leetcode-timer-widget', timeStats: 'leetcode-time-block', details: 'details-section' };

  const GRIP_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>';
  const GEAR_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" aria-hidden="true" focusable="false"><path d="M4 6h8M15 6h1M4 14h1M8 14h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="13.5" cy="6" r="1.8" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="14" r="1.8" stroke="currentColor" stroke-width="1.5"/></svg>';
  const CHEV_SVG = '<svg class="chev" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M2 3.5 5 6.5l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const X_SVG = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true" focusable="false"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const TROPHY_PATH = '<path d="M4.3 2.2h5.4v2.7a2.7 2.7 0 0 1-5.4 0z" fill="currentColor"/><path d="M4.3 3H3a1.4 1.4 0 0 0 1.5 1.9M9.7 3H11a1.4 1.4 0 0 1-1.5 1.9M7 7.7v2M5 11.8h4M5.6 9.7h2.8v2.1H5.6z" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>';
  const TROPHY_SVG = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true" focusable="false">' + TROPHY_PATH + '</svg>';

  // One glyph per card type for the add-a-card list.
  const WIDGET_TYPE_ICON = {
    goal: '<circle cx="7" cy="7" r="5.3" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="2.8" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="0.9" fill="currentColor"/>',
    summary: '<rect x="2" y="2.8" width="5.5" height="2" rx="1" fill="currentColor"/><rect x="2" y="6" width="8" height="2" rx="1" fill="currentColor"/><rect x="2" y="9.2" width="10" height="2" rx="1" fill="currentColor"/>',
    activity: '<rect x="2.3" y="7.5" width="2.6" height="4" rx="1" fill="currentColor"/><rect x="5.7" y="4.8" width="2.6" height="6.7" rx="1" fill="currentColor"/><rect x="9.1" y="2" width="2.6" height="9.5" rx="1" fill="currentColor"/>',
    streak: '<path d="M7 12.6c2.5 0 4-1.6 4-3.8 0-1.8-1-3-1.8-4.1.1 1.1-.5 1.7-1 1.7.4-1.8-.3-3.4-1.8-4.7-.1 1.4-.8 2.6-1.8 3.6-.9.9-1.4 2-1.4 3.3 0 2.2 1.4 4 3.8 4z" fill="currentColor"/>',
    timer: '<circle cx="7" cy="7.6" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 5v2.6l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.2 1.6h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    timeStats: '<path d="M2 9.5a5 5 0 1 1 10 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M7 9.5 9.3 6.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="9.5" r="0.9" fill="currentColor"/>',
    details: '<rect x="2.5" y="1.8" width="9" height="10.4" rx="1.4" stroke="currentColor" stroke-width="1.2"/><path d="M4.8 5h4.4M4.8 7.3h4.4M4.8 9.6h2.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
    pipeline: '<path d="M1.8 2.5h10.4L8.4 7v4.2l-2.8 1.3V7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
    recentList: '<circle cx="2.8" cy="3.5" r="1" fill="currentColor"/><circle cx="2.8" cy="7" r="1" fill="currentColor"/><circle cx="2.8" cy="10.5" r="1" fill="currentColor"/><path d="M5.3 3.5h6.4M5.3 7h6.4M5.3 10.5h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
    responseStats: '<path d="M2 11.5 5 8l2.2 2L12 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.2 4.5H12v2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
    trophies: TROPHY_PATH,
    recap: '<path d="M3 3.5h8M3 6.5h8M3 9.5h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M9.5 11.5 11 10l1.5 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'
  };

  function metricFor(item) {
    const id = WidgetLayout.resolveMetricId(item, activeMetricId, metrics);
    return metricById(id) || metricById(activeMetricId) || metrics[0];
  }

  // Pinned widgets say which tracker they show; widgets that follow the tab
  // stay unlabeled so the common layout does not repeat the tab name.
  function pinLabel(item, metric) {
    return item.options.metricId && item.options.metricId !== WidgetLayout.ACTIVE ? metric.name : '';
  }

  function widgetTitle(item) {
    if (item.options && item.options.title) return item.options.title;
    return defaultWidgetTitle(item);
  }

  function defaultWidgetTitle(item) {
    if (item.type === 'activity') return item.options.days === WidgetLayout.ALL_DAYS ? 'All-time activity' : item.options.days + '-day activity';
    return WidgetLayout.TYPES[item.type].name;
  }

  function widgetShell(item) {
    const wrap = make('section', 'widget widget-' + item.type);
    wrap.dataset.widgetId = item.id;
    wrap.dataset.widgetType = item.type;
    const head = make('header', 'widget-head');
    const toggle = make('button', 'widget-collapse');
    toggle.type = 'button';
    toggle.innerHTML = CHEV_SVG;
    toggle.appendChild(make('span', 'widget-title'));
    toggle.appendChild(make('span', 'widget-pin'));
    head.appendChild(toggle);
    const tools = make('div', 'widget-tools');
    tools.appendChild(make('div', 'widget-extra'));
    const grip = make('button', 'tool-btn widget-drag-handle');
    grip.type = 'button';
    grip.title = 'Drag to move';
    grip.innerHTML = GRIP_SVG;
    tools.appendChild(grip);
    const edit = make('button', 'tool-btn widget-edit-btn');
    edit.type = 'button';
    edit.title = 'Card settings';
    edit.innerHTML = GEAR_SVG;
    tools.appendChild(edit);
    head.appendChild(tools);
    wrap.appendChild(head);
    // Customize mode: a phone-style remove button on the corner.
    const remove = make('button', 'widget-remove-btn');
    remove.type = 'button';
    remove.innerHTML = X_SVG;
    wrap.appendChild(remove);
    wrap.appendChild(make('div', 'widget-body'));
    return wrap;
  }

  function updateShell(wrap, item, metric, solo) {
    const name = WidgetLayout.TYPES[item.type].name;
    wrap.classList.toggle('size-compact', item.options.size === 'compact');
    wrap.classList.toggle('size-expanded', item.options.size !== 'compact');
    wrap.classList.toggle('solo', solo);
    wrap.classList.toggle('collapsed', !!item.options.collapsed);
    // Cards that follow the tab wear the accent; a card pinned to another
    // goal keeps that goal's color so two side by side read apart.
    if (item.options.color) setTrackerColor(wrap, item.options.color);
    else if (pinLabel(item, metric)) setTrackerColor(wrap, metric.color);
    else {
      wrap.style.setProperty('--tracker', 'var(--accent)');
      wrap.style.setProperty('--on-tracker', 'var(--on-accent)');
    }
    const toggle = wrap.querySelector('.widget-collapse');
    toggle.setAttribute('aria-expanded', item.options.collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', (item.options.collapsed ? 'Expand ' : 'Collapse ') + name);
    wrap.querySelector('.widget-title').textContent = widgetTitle(item);
    const pin = pinLabel(item, metric);
    wrap.querySelector('.widget-pin').textContent = pin ? '· ' + pin : '';
    wrap.querySelector('.widget-drag-handle').setAttribute('aria-label', 'Move the ' + name + ' card. Use the arrow keys to move it.');
    wrap.querySelector('.widget-edit-btn').setAttribute('aria-label', 'Settings for the ' + name + ' card');
    const remove = wrap.querySelector('.widget-remove-btn');
    remove.setAttribute('aria-label', 'Remove the ' + name + ' card');
    remove.title = 'Remove card';
    remove.tabIndex = customizing ? 0 : -1;
  }

  // Singleton parts are moved, not cloned, so the timer's input state and
  // every listener bound at startup keep working wherever the widget sits.
  function placePart(body, partId) {
    const part = el(partId);
    if (part && part.parentElement !== body) body.appendChild(part);
    return part;
  }

  function parkPart(partId) {
    const part = el(partId);
    if (part && widgetParts && part.parentElement !== widgetParts) widgetParts.appendChild(part);
  }

  function statTile(value, name, key) {
    const tile = make('div', 'stat');
    const v = make('span', 'stat-value', value);
    if (key) v.dataset.stat = key;
    tile.appendChild(v);
    tile.appendChild(make('span', 'stat-name', name));
    return tile;
  }

  function statusPill(log) {
    const id = statusOf(log);
    const meta = statusMeta(id);
    const pill = make('button', 'status-pill stage-' + id);
    pill.type = 'button';
    pill.dataset.logId = log.id;
    pill.dataset.status = id;
    pill.setAttribute('aria-haspopup', 'listbox');
    pill.setAttribute('aria-label', 'Stage: ' + meta.label + '. Select to change it.');
    pill.appendChild(make('i'));
    pill.appendChild(document.createTextNode(meta.short));
    return pill;
  }

  // Stage counts as number fields. Applied is whatever the other stages
  // leave, so it shows as a live remainder rather than a field.
  function renderPipelineEditor(body, summary) {
    body.textContent = '';
    const form = make('form', 'funnel pipeline-editor');
    form.noValidate = true;
    STATUSES.forEach(s => {
      // A div, not a label: the stepper buttons would otherwise become the
      // label's control and a click on the stage name would press "-".
      const row = make('div', 'stage stage-' + s.id);
      const name = make('span', 'stage-name');
      name.appendChild(make('i'));
      name.appendChild(document.createTextNode(s.label));
      row.appendChild(name);
      if (s.id === 'applied') {
        row.appendChild(make('span', 'stage-hint', 'the rest'));
        row.appendChild(make('span', 'stage-count pipeline-applied', summary.counts.applied));
      } else {
        row.appendChild(make('span'));
        const input = make('input', 'stage-input');
        input.type = 'number';
        input.min = '0';
        input.max = String(summary.total);
        input.step = '1';
        input.inputMode = 'numeric';
        input.name = s.id;
        input.value = summary.counts[s.id];
        input.dataset.initial = summary.counts[s.id];
        input.setAttribute('aria-label', s.label + ' count');
        // Whole-number counts get -/+ steppers around the field.
        const stepper = make('span', 'stepper');
        const minus = make('button', 'stepper-btn', '\u2212');
        minus.type = 'button';
        minus.dataset.step = '-1';
        minus.setAttribute('aria-label', 'One fewer ' + s.label);
        minus.title = 'One fewer';
        const plus = make('button', 'stepper-btn', '+');
        plus.type = 'button';
        plus.dataset.step = '1';
        plus.setAttribute('aria-label', 'One more ' + s.label);
        plus.title = 'One more';
        stepper.appendChild(minus);
        stepper.appendChild(input);
        stepper.appendChild(plus);
        row.appendChild(stepper);
      }
      form.appendChild(row);
    });
    const foot = make('div', 'funnel-foot pipeline-editor-foot');
    foot.appendChild(make('span', 'pipeline-editor-note', summary.total + (summary.total === 1 ? ' application' : ' applications')));
    const actions = make('span', 'pipeline-editor-actions');
    const cancel = make('button', 'btn btn-ghost btn-sm', 'Cancel');
    cancel.type = 'button';
    cancel.dataset.pipelineCancel = '1';
    const save = make('button', 'btn btn-accent btn-sm', 'Save');
    save.type = 'submit';
    actions.appendChild(cancel);
    actions.appendChild(save);
    foot.appendChild(actions);
    form.appendChild(foot);
    body.appendChild(form);
    updatePipelineRemainder(form, summary.total);
  }

  function pipelineEditorValues(form) {
    const out = {};
    form.querySelectorAll('.stage-input').forEach(input => {
      out[input.name] = Math.max(0, parseInt(input.value, 10) || 0);
    });
    return out;
  }

  function updatePipelineRemainder(form, total) {
    const values = pipelineEditorValues(form);
    const used = Object.keys(values).reduce((n, k) => n + values[k], 0);
    const over = used > total;
    const applied = form.querySelector('.pipeline-applied');
    applied.textContent = Math.max(0, total - used);
    applied.classList.toggle('over', over);
    const note = form.querySelector('.pipeline-editor-note');
    note.textContent = over
      ? 'Only ' + total + (total === 1 ? ' application' : ' applications') + ' to split'
      : total + (total === 1 ? ' application' : ' applications');
    note.classList.toggle('over', over);
    form.querySelector('[type="submit"]').disabled = over;
  }

  async function savePipelineCounts(form) {
    const values = pipelineEditorValues(form);
    const changed = [...form.querySelectorAll('.stage-input')].filter(i => values[i.name] !== parseInt(i.dataset.initial, 10));
    form.querySelectorAll('button, input').forEach(c => { c.disabled = true; });
    const short = [];
    try {
      // Lowered stages first, so the entries they free up are back in
      // Applied before a raised stage looks for some.
      changed.sort((a, b) => (values[a.name] - a.dataset.initial) - (values[b.name] - b.dataset.initial));
      for (const input of changed) {
        const r = await TrackerStorage.setStageCount(input.name, values[input.name]);
        if (r.count !== r.requested) short.push(statusMeta(r.status).label + ' is ' + r.count);
      }
    } catch (err) {
      oops('The stage counts did not save. Please try again.', err);
    }
    pipelineEditing = null;
    jobsCache = null;
    renderWidgets();
    if (short.length) showStatus(short.join(', ') + '. Some entries count as several applications and could not be split.', 'error');
    else if (changed.length) showStatus('Pipeline updated.', 'ok');
  }

  const WIDGET_RENDERERS = {
    goal(body, item, metric) {
      const today = (stats.today && stats.today[metric.id]) || 0;
      const goal = goalFor(metric);
      const pct = Math.min(1, today / goal);
      const met = today >= goal;
      if (!body.firstChild) {
        const top = make('div', 'goal-top');
        const big = make('div', 'big-stat');
        big.appendChild(make('span', 'num'));
        big.appendChild(make('span', 'of'));
        top.appendChild(big);
        const edit = make('button', 'goal-edit', 'Edit goals');
        edit.type = 'button';
        top.appendChild(edit);
        body.appendChild(top);
        const bar = make('div', 'goal-bar');
        bar.appendChild(make('div', 'goal-fill'));
        const labels = make('div', 'milestone-labels');
        [25, 50, 75, 100].forEach(m => {
          const dot = make('span', 'milestone');
          dot.style.left = m + '%';
          dot.dataset.m = String(m);
          bar.appendChild(dot);
          const label = make('span', '', m + '%');
          label.style.left = m + '%';
          label.dataset.m = String(m);
          labels.appendChild(label);
        });
        body.appendChild(bar);
        body.appendChild(labels);
        const weekly = make('div', 'goal-weekly');
        weekly.appendChild(make('span', 'weekly-label', 'This week'));
        const wb = make('div', 'week-bar');
        wb.appendChild(make('span'));
        weekly.appendChild(wb);
        weekly.appendChild(make('span', 'weekly-count'));
        body.appendChild(weekly);
      }
      body.querySelector('.num').textContent = today;
      body.querySelector('.of').textContent = '/ ' + goal + (met ? ', goal met' : ' today');
      body.querySelector('.goal-edit').setAttribute('aria-label', 'Edit the daily and weekly goals for ' + metric.name);
      const bar = body.querySelector('.goal-bar');
      bar.classList.toggle('met', met);
      body.querySelector('.goal-fill').style.width = Math.round(pct * 100) + '%';
      body.querySelectorAll('[data-m]').forEach(n => n.classList.toggle('reached', pct * 100 >= Number(n.dataset.m)));
      const showChecks = item.options.showCheckpoints !== false;
      body.querySelectorAll('.milestone').forEach(n => n.classList.toggle('hidden', !showChecks));
      body.querySelector('.milestone-labels').classList.toggle('hidden', !showChecks);
      const weeklyGoal = item.options.showWeekly === false ? 0 : (metric.weeklyGoal || 0);
      const weekCount = (stats.weekToDate && stats.weekToDate[metric.id]) || 0;
      const weekly = body.querySelector('.goal-weekly');
      weekly.classList.toggle('hidden', weeklyGoal <= 0);
      weekly.classList.toggle('met', weeklyGoal > 0 && weekCount >= weeklyGoal);
      if (weeklyGoal > 0) {
        weekly.querySelector('.week-bar span').style.width = Math.min(100, Math.round((weekCount / weeklyGoal) * 100)) + '%';
        weekly.querySelector('.weekly-count').textContent = weekCount + ' / ' + weeklyGoal;
      }
    },

    summary(body, item, metric) {
      const periods = item.options.periods || WidgetLayout.DEFAULT_PERIODS;
      const key = periods.join(',');
      if (body.dataset.periods !== key) {
        body.textContent = '';
        body.dataset.periods = key;
        const row = make('div', 'stat-row');
        periods.forEach(p => row.appendChild(statTile(0, SUMMARY_LABELS[p], p)));
        body.appendChild(row);
      }
      const source = { today: stats.today, week: stats.thisWeek, month: stats.thisMonth, total: stats.totals };
      periods.forEach(p => {
        const node = body.querySelector('[data-stat="' + p + '"]');
        if (node) node.textContent = (source[p] && source[p][metric.id]) || 0;
      });
    },

    streak(body, item, metric) {
      if (!body.firstChild) {
        const row = make('div', 'stat-row');
        row.appendChild(statTile(0, 'Current', 'current'));
        row.appendChild(statTile(0, 'Longest', 'best'));
        body.appendChild(row);
      }
      const current = (stats.streaks && stats.streaks[metric.id]) || 0;
      const best = Math.max(current, (stats.longestStreaks && stats.longestStreaks[metric.id]) || 0);
      body.querySelector('[data-stat="current"]').textContent = current + (current === 1 ? ' day' : ' days');
      body.querySelector('[data-stat="best"]').textContent = best + (best === 1 ? ' day' : ' days');
      body.querySelector('[data-stat="best"]').parentElement.classList.toggle('hidden', item.options.showLongest === false);
    },

    activity(body, item, metric, wrap) {
      const extra = wrap.querySelector('.widget-extra');
      if (!extra.firstChild) {
        const seg = make('div', 'segmented');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Chart style');
        WidgetLayout.CHART_MODES.forEach(value => {
          const b = make('button', '', CHART_LABELS[value]);
          b.type = 'button';
          b.dataset.chart = value;
          b.title = CHART_HINTS[value];
          seg.appendChild(b);
        });
        extra.appendChild(seg);
      }
      extra.querySelectorAll('[data-chart]').forEach(b => b.setAttribute('aria-pressed', b.dataset.chart === item.options.chart ? 'true' : 'false'));
      if (!body.firstChild) {
        body.appendChild(make('div', 'chart'));
        body.appendChild(make('div', 'empty activity-empty hidden'));
        const statsRow = make('div', 'stat-row activity-stats');
        statsRow.appendChild(statTile(0, 'Total', 'total'));
        statsRow.appendChild(statTile(0, 'Daily avg', 'avg'));
        statsRow.appendChild(statTile(0, 'Active days', 'days'));
        statsRow.appendChild(statTile(0, 'Best day', 'best'));
        body.appendChild(statsRow);
      }
      body.querySelector('.activity-stats').classList.toggle('hidden', !item.options.showStats);
      if (item.options.collapsed) return;
      renderActivity(body, item, metric);
    },

    timer(body) {
      placePart(body, PART_IDS.timer);
      renderTimer();
    },

    timeStats(body) {
      placePart(body, PART_IDS.timeStats);
      renderLeetcodeTimeStats();
    },

    details(body, item, metric) {
      placePart(body, PART_IDS.details);
      const labels = metric.id === 'jobs'
        ? ['Company', 'Role', 'Notes or job link']
        : (metric.id === 'leetcode' ? ['Problem', 'Topic or tag', 'Notes or link'] : ['Title', 'Tag', 'Notes or link']);
      // Placeholders show an example rather than repeating the label.
      const hints = metric.id === 'jobs'
        ? ['e.g. Stripe', 'e.g. Software Engineer', 'Posting URL or a note']
        : (metric.id === 'leetcode' ? ['e.g. Two Sum', 'e.g. Arrays', 'Problem URL or a note'] : ['What you did', 'e.g. Reading', 'URL or a note']);
      el('detail-company-label').textContent = labels[0];
      el('detail-role-label').textContent = labels[1];
      el('detail-notes-label').textContent = labels[2];
      el('detail-company').placeholder = hints[0];
      el('detail-role').placeholder = hints[1];
      el('detail-notes').placeholder = hints[2];
      el('details-form').dataset.metricId = metric.id;
    },

    pipeline(body, item) {
      withJobs(body, 'pipeline:' + item.id, logs => {
        const summary = TrackerStorage.summarizePipeline(logs);
        if (pipelineEditing === item.id) {
          renderPipelineEditor(body, summary);
          return;
        }
        const max = Math.max(1, ...STATUSES.map(s => summary.counts[s.id]));
        body.textContent = '';
        const funnel = make('div', 'funnel');
        STATUSES.forEach(s => {
          const count = summary.counts[s.id];
          const active = pipelineFilter === s.id;
          const row = make('button', 'stage stage-' + s.id + (active ? ' active' : ''));
          row.type = 'button';
          row.dataset.stage = s.id;
          row.setAttribute('aria-pressed', active ? 'true' : 'false');
          row.setAttribute('aria-label', s.label + ': ' + count + '. Select to ' + (active ? 'clear the filter.' : 'show these in Recent Applications.'));
          const name = make('span', 'stage-name');
          name.appendChild(make('i'));
          name.appendChild(document.createTextNode(s.label));
          row.appendChild(name);
          const bar = make('span', 'stage-bar');
          const fill = make('span');
          bar.appendChild(fill);
          row.appendChild(bar);
          row.appendChild(make('span', 'stage-count', count));
          funnel.appendChild(row);
          requestAnimationFrame(() => { fill.style.width = Math.round((count / max) * 100) + '%'; });
        });
        body.appendChild(funnel);
        const foot = make('div', 'funnel-foot');
        foot.appendChild(make('span', '', summary.total + (summary.total === 1 ? ' application' : ' applications')));
        funnel.title = pipelineFilter
          ? 'Recent list shows ' + statusMeta(pipelineFilter).short
          : 'Select a stage to filter the recent list';
        const edit = make('button', 'pipeline-edit-btn', 'Edit counts');
        edit.type = 'button';
        foot.appendChild(edit);
        body.appendChild(foot);
      });
    },

    recentList(body, item) {
      withJobs(body, 'recent:' + item.id, logs => {
        const filtered = pipelineFilter ? logs.filter(l => statusOf(l) === pipelineFilter) : logs;
        body.textContent = '';
        if (pipelineFilter) {
          const chip = make('span', 'filter-chip stage-' + pipelineFilter);
          chip.appendChild(document.createTextNode(statusMeta(pipelineFilter).label + ' (' + filtered.length + ')'));
          const clear = make('button');
          clear.type = 'button';
          clear.dataset.clearFilter = '1';
          clear.setAttribute('aria-label', 'Show every stage');
          clear.title = 'Show every stage';
          clear.innerHTML = X_SVG;
          chip.appendChild(clear);
          body.appendChild(chip);
        }
        if (!filtered.length) {
          // Empty states point at a next step instead of ending the list.
          const empty = make('div', 'empty empty-actions');
          if (pipelineFilter) {
            empty.appendChild(make('p', '', 'Nothing in ' + statusMeta(pipelineFilter).label + ' right now.'));
            const all = make('button', 'btn btn-ghost btn-sm', 'Show every stage');
            all.type = 'button';
            all.dataset.clearFilter = '1';
            empty.appendChild(all);
          } else {
            empty.appendChild(make('p', '', coach('empty', ['applications'], 'No applications sent yet. Your first one will appear here, ready to track.')));
            const add = make('button', 'btn btn-accent btn-sm', 'Add one with details');
            add.type = 'button';
            add.addEventListener('click', focusDetailsForm);
            empty.appendChild(add);
          }
          body.appendChild(empty);
          return;
        }
        const list = make('ul', 'entry-list recent-list');
        filtered.slice(0, item.options.count || WidgetLayout.DEFAULT_RECENT).forEach((log, i) => list.appendChild(entryRow(log, { monogram: true, delay: i })));
        body.appendChild(list);
        // Fade the bottom edge only when there is more to scroll to.
        requestAnimationFrame(() => list.classList.toggle('scrolls', list.scrollHeight > list.clientHeight + 1));
      });
    },

    responseStats(body, item) {
      withJobs(body, 'response:' + item.id, logs => {
        const s = TrackerStorage.summarizePipeline(logs);
        body.textContent = '';
        const wrap = make('div', 'response');
        const big = make('div', 'big-stat');
        // Never a stinging 0%: until someone replies, frame it as early days.
        const noReplies = !s.responded;
        const num = make('span', 'num' + (noReplies ? ' is-words' : ''), noReplies ? (s.total ? 'Early days' : 'Nothing yet') : s.responseRate + '%');
        big.appendChild(num);
        if (!noReplies) big.appendChild(make('span', 'of', 'heard back'));
        wrap.appendChild(big);
        const bar = make('div', 'response-bar');
        bar.setAttribute('aria-hidden', 'true');
        ['review', 'interviewing', 'offer', 'rejected'].forEach(id => {
          const seg = make('span', 'stage-' + id);
          seg.style.width = s.total ? (s.counts[id] / s.total) * 100 + '%' : '0';
          bar.appendChild(seg);
        });
        wrap.appendChild(bar);
        // The bar is color only, so a text legend names each segment.
        const legend = make('div', 'response-legend');
        ['review', 'interviewing', 'offer', 'rejected'].forEach(id => {
          if (!s.counts[id]) return;
          const key = make('span', 'stage-' + id);
          key.appendChild(make('i'));
          key.appendChild(document.createTextNode(statusMeta(id).short + ' ' + s.counts[id]));
          legend.appendChild(key);
        });
        if (legend.firstChild) wrap.appendChild(legend);
        let meta;
        if (s.total === 0) meta = 'Replies show up here once you start applying.';
        else if (noReplies) meta = 'Replies often take a week or three. Each application you send keeps a door open.';
        else meta = s.responded + ' of ' + s.total + ' heard back' + (s.avgTurnaroundDays !== null
          ? '. Replies take about ' + s.avgTurnaroundDays + (s.avgTurnaroundDays === 1 ? ' day' : ' days') + '.'
          : '. Keep them coming.');
        wrap.appendChild(make('div', 'response-meta', meta));
        body.appendChild(wrap);
      });
    },

    // Trophy shelf: milestones reached, the next one to go for.
    trophies(body, item, metric) {
      if (!has(TrackerStorage, 'getMilestones')) {
        body.textContent = '';
        body.appendChild(make('div', 'empty', 'Trophies arrive with your first entries.'));
        return;
      }
      const key = 'trophies:' + item.id;
      const token = bumpToken(key);
      TrackerStorage.getMilestones(metric.id).then(ms => {
        if (asyncTokens[key] !== token || !body.isConnected) return;
        body.textContent = '';
        const reached = (ms && ms.reached) || [];
        const shelf = make('div', 'trophy-shelf');
        reached.forEach(r => {
          const t = make('div', 'trophy' + (ms.unseen && ms.unseen.includes(r.id) ? ' is-new' : ''));
          t.innerHTML = TROPHY_SVG;
          t.appendChild(make('b', null, r.count === null || r.count === undefined ? 'Interview' : r.count));
          t.title = (r.title || '') + (r.date ? ' · ' + shortDate(r.date, true) : '');
          t.setAttribute('aria-label', (r.title || 'Milestone') + (r.date ? ', reached ' + shortDate(r.date, true) : ''));
          shelf.appendChild(t);
        });
        if (ms && ms.next) {
          const ghost = make('div', 'trophy locked');
          ghost.innerHTML = TROPHY_SVG;
          ghost.appendChild(make('b', null, ms.next.count));
          ghost.setAttribute('aria-label', 'Next trophy at ' + ms.next.count);
          shelf.appendChild(ghost);
        }
        body.appendChild(shelf);
        if (!reached.length) body.appendChild(make('div', 'trophy-next', 'Your first trophy comes with your first ' + displayUnit(metric, 1) + '.'));
        else if (ms.next) {
          const next = make('div', 'trophy-next');
          next.appendChild(document.createTextNode(ms.next.remaining + ' more to reach ' + ms.next.count + '.'));
          const bar = make('div', 'week-bar');
          const fill = make('span');
          const prevAt = reached.filter(r => typeof r.count === 'number').reduce((n, r) => Math.max(n, r.count), 0);
          const span = Math.max(1, ms.next.count - prevAt);
          fill.style.width = Math.round(Math.max(0, Math.min(1, (span - ms.next.remaining) / span)) * 100) + '%';
          bar.appendChild(fill);
          next.appendChild(bar);
          body.appendChild(next);
        }
      }).catch(err => {
        console.warn('[LIT] trophies unavailable', err);
      });
    },

    // Weekly recap: this week so far, as a short story, ready to share.
    recap(body, item, metric) {
      const key = 'recap:' + item.id;
      const token = bumpToken(key);
      const thisWeek = stats.weekStartStr;
      Promise.all([
        TrackerStorage.getWeekSummary(thisWeek),
        TrackerStorage.getWeekSummary().catch(() => null)
      ]).then(([now, last]) => {
        if (asyncTokens[key] !== token || !body.isConnected) return;
        const m = now && now.metrics ? now.metrics.find(x => x.id === metric.id) : null;
        const prior = last && last.metrics ? last.metrics.find(x => x.id === metric.id) : null;
        body.textContent = '';
        const total = m ? m.total : 0;
        body.appendChild(make('p', 'story', total > 0
          ? weekStoryFor(m, prior ? prior.total : 0)
          : 'Your week starts with the first one. ' + (prior && prior.total ? 'Last week you sent ' + prior.total + '; that rhythm is still yours.' : 'One is all it takes to get going.')));
        const foot = make('div', 'story-foot');
        foot.appendChild(make('span', 'story-meta', total + ' ' + displayUnit(metric, total) + ' this week' + (m && m.activeDays ? ' · ' + m.activeDays + (m.activeDays === 1 ? ' day' : ' days') + ' active' : '')));
        if (total > 0) {
          const share = make('button', 'btn btn-ghost btn-sm', 'Share');
          share.type = 'button';
          share.dataset.shareWeek = String(total);
          share.setAttribute('aria-label', 'Share this week');
          foot.appendChild(share);
        }
        body.appendChild(foot);
      }).catch(err => {
        console.warn('[LIT] weekly recap unavailable', err);
        if (asyncTokens[key] !== token || !body.isConnected) return;
        body.textContent = '';
        body.appendChild(make('div', 'empty', coach('empty', ['chart'], 'Your week will show up here.')));
      });
    },

    countdown(body, item, metric) {
      body.textContent = '';
      const date = item.options.date;
      if (!date) {
        const box = make('div', 'empty empty-actions');
        box.appendChild(make('p', '', 'Count down to a start date, a career fair, or an application deadline.'));
        const pick = make('button', 'btn btn-accent btn-sm', 'Pick a date');
        pick.type = 'button';
        pick.dataset.openCardSettings = item.id;
        box.appendChild(pick);
        body.appendChild(box);
        return;
      }
      const days = daysUntil(date);
      const big = make('div', 'countdown-big');
      big.appendChild(make('span', 'countdown-num', days > 0 ? String(days) : (days === 0 ? 'Today' : 'Done')));
      if (days > 0) big.appendChild(make('span', 'countdown-unit', days === 1 ? 'day left' : 'days left'));
      body.appendChild(big);
      body.appendChild(make('p', 'countdown-label', (item.options.label || 'Until ' + friendlyDate(date)) + (item.options.label ? ' · ' + friendlyDate(date) : '')));
      if (days > 0) {
        const pace = recentPace(metric.id, 14);
        if (pace > 0) {
          const ahead = Math.round(pace * days);
          body.appendChild(make('p', 'countdown-pace', 'At your recent pace, about ' + ahead + ' more ' + displayUnit(metric, ahead) + ' by then.'));
        } else {
          body.appendChild(make('p', 'countdown-pace', 'Every one you log from here counts toward it.'));
        }
      } else if (days < 0) {
        body.appendChild(make('p', 'countdown-pace', 'That date has passed. Set a new one in card settings.'));
      }
    },

    compare(body, item, metric) {
      body.textContent = '';
      const map = (stats && stats.dailyMap) || {};
      const monday = stats.weekStartStr;
      const lastMonday = TrackerStorage.addDays(monday, -7);
      const today = todayStr();
      const rows = [];
      let thisTotal = 0;
      let lastTotal = 0;
      let lastToDate = 0;
      for (let i = 0; i < 7; i++) {
        const d1 = TrackerStorage.addDays(monday, i);
        const d0 = TrackerStorage.addDays(lastMonday, i);
        const now = d1 <= today ? (((map[d1] || {})[metric.id]) || 0) : null;
        const prev = ((map[d0] || {})[metric.id]) || 0;
        if (now !== null) { thisTotal += now; lastToDate += prev; }
        lastTotal += prev;
        rows.push({ label: ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i], now, prev });
      }
      const max = Math.max(1, ...rows.map(r => Math.max(r.now || 0, r.prev)));
      const chart = make('div', 'compare-chart');
      chart.setAttribute('role', 'img');
      chart.setAttribute('aria-label', 'This week ' + thisTotal + ', last week ' + lastTotal);
      rows.forEach(r => {
        const col = make('div', 'compare-col');
        const bars = make('div', 'compare-bars');
        const prev = make('span', 'compare-bar is-prev');
        prev.style.height = Math.round((r.prev / max) * 100) + '%';
        const now = make('span', 'compare-bar is-now' + (r.now === null ? ' is-future' : ''));
        now.style.height = r.now === null ? '0' : Math.round((r.now / max) * 100) + '%';
        bars.appendChild(prev);
        bars.appendChild(now);
        col.appendChild(bars);
        col.appendChild(make('span', 'compare-day', r.label));
        chart.appendChild(col);
      });
      body.appendChild(chart);
      const legend = make('div', 'compare-legend');
      const a = make('span', 'compare-key is-now', 'This week ' + thisTotal);
      const b = make('span', 'compare-key is-prev', 'Last week ' + lastTotal);
      legend.appendChild(a);
      legend.appendChild(b);
      body.appendChild(legend);
      // Never framed as a decline: ahead says so, behind says what is left.
      let line;
      if (thisTotal > lastToDate) line = (thisTotal - lastToDate) + ' ahead of where you were last week.';
      else if (thisTotal === lastToDate && thisTotal > 0) line = 'Right in step with last week.';
      else if (thisTotal === 0) line = 'Fresh week. The first one sets the tone.';
      else line = 'Last week had ' + (lastToDate - thisTotal) + ' more by now. Plenty of week left.';
      body.appendChild(make('p', 'compare-line', line));
    },

    watchlist(body, item) {
      withJobs(body, 'watch:' + item.id, logs => {
        body.textContent = '';
        const applied = new Set(logs.map(l => TrackerStorage.normalizeCompany(l.company || '')).filter(Boolean));
        const list = make('ul', 'watch-list');
        if (!watchlist.length) {
          body.appendChild(make('p', 'empty', 'Add companies you want to apply to. LIT checks them off when it logs an application there.'));
        }
        watchlist.forEach(w => {
          const done = w.done || applied.has(TrackerStorage.normalizeCompany(w.name));
          const li = make('li', 'watch-item' + (done ? ' is-done' : ''));
          li.dataset.watchId = w.id;
          const check = make('button', 'watch-check');
          check.type = 'button';
          check.setAttribute('aria-pressed', done ? 'true' : 'false');
          check.setAttribute('aria-label', (done ? 'Mark ' + w.name + ' as not applied' : 'Mark ' + w.name + ' as applied'));
          check.dataset.watchToggle = '1';
          check.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 6.2l2.2 2.3L9.5 3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          if (applied.has(TrackerStorage.normalizeCompany(w.name))) { check.disabled = true; check.title = 'You logged an application here.'; }
          li.appendChild(check);
          li.appendChild(make('span', 'watch-name', w.name));
          if (done) li.appendChild(make('span', 'watch-tag', 'Applied'));
          const rm = make('button', 'tool-btn watch-remove');
          rm.type = 'button';
          rm.dataset.watchRemove = '1';
          rm.setAttribute('aria-label', 'Remove ' + w.name);
          rm.title = 'Remove';
          rm.innerHTML = X_SVG;
          li.appendChild(rm);
          list.appendChild(li);
        });
        body.appendChild(list);
        const form = make('form', 'watch-add');
        const input = make('input', 'watch-input');
        input.type = 'text';
        input.maxLength = 60;
        input.placeholder = watchlist.length >= MAX_WATCH ? 'List is full' : 'Add a company';
        input.disabled = watchlist.length >= MAX_WATCH;
        input.setAttribute('aria-label', 'Add a company to watch');
        const add = make('button', 'btn btn-ghost btn-sm', 'Add');
        add.type = 'submit';
        add.disabled = input.disabled;
        form.appendChild(input);
        form.appendChild(add);
        form.dataset.watchForm = '1';
        body.appendChild(form);
      });
    },

    notes(body, item) {
      if (!body.firstChild) {
        const area = make('textarea', 'notes-area');
        area.maxLength = MAX_NOTE;
        area.rows = 4;
        area.placeholder = 'Today\'s plan, a recruiter\'s name, a question to ask...';
        area.setAttribute('aria-label', 'Notes');
        area.dataset.noteId = item.id;
        body.appendChild(area);
        body.appendChild(make('span', 'notes-meta', ''));
      }
      const area = body.querySelector('.notes-area');
      if (document.activeElement !== area) area.value = cardNotes[item.id] || '';
      body.querySelector('.notes-meta').textContent = 'Saved on this computer';
    },

    quote(body, item) {
      body.textContent = '';
      const own = item.options.quoteText;
      const text = own || BOOSTS[dayIndex() % BOOSTS.length];
      const q = make('blockquote', 'boost-text', text);
      body.appendChild(q);
      body.appendChild(make('span', 'boost-meta', own ? 'Your words' : 'New one tomorrow'));
    }
  };

  // ----- Helpers for the newer cards ------------------------------------------
  const MAX_WATCH = 30;
  const MAX_NOTE = 4000;
  const WATCH_KEY = 'pt_watchlist';
  const NOTES_KEY = 'lit_card_notes';
  let watchlist = [];
  let cardNotes = {};
  let buddySession = null;

  // The worker updates the buddy's session while the popup is open (a new
  // entry, a nudge, a break); keep the bubble and LitPopup.api current.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    const sessionKey = typeof LitBuddy !== 'undefined' ? LitBuddy.SESSION_KEY : 'lit_buddy_session';
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[sessionKey]) return;
      buddySession = changes[sessionKey].newValue || null;
      if (metrics.length && stats) renderBuddy(metricById(activeMetricId));
    });
  }

  // Original lines, one a day. Short, warm, never about failing.
  const BOOSTS = [
    'Every application is a door you knocked on. Keep knocking.',
    'You do not need a perfect day. You need a next step.',
    'The right team is looking for someone like you right now.',
    'Small steps, done daily, add up to a new job.',
    'A no is not a verdict on you. It is just not the match.',
    'Rest is part of the plan, not a break from it.',
    'You are building momentum even on the quiet days.',
    'One thoughtful application beats ten rushed ones.',
    'Say yes to the coffee chat. People hire people.',
    'Your experience counts, even the parts that feel small.',
    'Today, send one message you have been putting off.',
    'Progress is not loud. It is steady.',
    'You have done hard things before. This is one more.',
    'The search ends. Keep showing up until it does.',
    'Proud of you for opening this today.',
    'Curiosity in an interview reads as confidence.',
    'Tailor one line of your resume today. It matters.',
    'Your next role might come from someone you have not met yet.',
    'Drink some water. Stretch. Then one more.',
    'Being kind to yourself is a job search skill.',
    'Keep a list of your wins. Read it before interviews.',
    'Done is better than perfect. Hit send.',
    'Follow up. It shows you care, not that you are pushy.',
    'You are allowed to be picky and persistent at once.',
    'Celebrate the interview invites, not just the offers.',
    'Every skill you practice today shows up later.',
    'Where you are is not where you will stay.',
    'Close the laptop when you are done. You earned it.',
    'Ask for the referral. The worst answer is silence.',
    'Your story is worth telling well. Practice it out loud.'
  ];

  function dayIndex() {
    const d = new Date();
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
  }

  function daysUntil(dateStr) {
    const today = new Date(todayStr() + 'T12:00:00');
    const target = new Date(dateStr + 'T12:00:00');
    return Math.round((target - today) / 86400000);
  }

  function friendlyDate(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Average per day over the last `days` days (today included).
  function recentPace(metricId, days) {
    const map = (stats && stats.dailyMap) || {};
    let total = 0;
    for (let i = 0; i < days; i++) total += ((map[TrackerStorage.addDays(todayStr(), -i)] || {})[metricId]) || 0;
    return total / days;
  }

  function storageArea(kind) {
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    return kind === 'sync' ? (chrome.storage.sync || chrome.storage.local) : chrome.storage.local;
  }

  function loadCardData() {
    return new Promise(resolve => {
      let pending = 3;
      const done = () => { if (--pending === 0) resolve(); };
      const sync = storageArea('sync');
      const local = storageArea('local');
      if (!sync || !local) { resolve(); return; }
      sync.get([WATCH_KEY], r => {
        const list = r && Array.isArray(r[WATCH_KEY]) ? r[WATCH_KEY] : [];
        watchlist = list.filter(w => w && typeof w.name === 'string' && w.id).slice(0, MAX_WATCH);
        done();
      });
      local.get([NOTES_KEY], r => {
        cardNotes = r && r[NOTES_KEY] && typeof r[NOTES_KEY] === 'object' ? r[NOTES_KEY] : {};
        done();
      });
      const sessionKey = typeof LitBuddy !== 'undefined' ? LitBuddy.SESSION_KEY : 'lit_buddy_session';
      local.get([sessionKey], r => {
        buddySession = r && r[sessionKey] ? r[sessionKey] : null;
        done();
      });
    });
  }

  function saveWatchlist() {
    const sync = storageArea('sync');
    if (sync) sync.set({ [WATCH_KEY]: watchlist });
  }

  let notesTimer = null;
  function saveNotesSoon() {
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => {
      const local = storageArea('local');
      if (local) local.set({ [NOTES_KEY]: cardNotes });
    }, 400);
  }

  function rerenderType(type) {
    widgetItems.filter(i => i.type === type).forEach(i => {
      const wrap = widgetsHost.querySelector('[data-widget-id="' + CSS.escape(i.id) + '"]');
      const metric = metricFor(i);
      if (wrap && metric && rendererFor(type)) rendererFor(type)(wrap.querySelector('.widget-body'), i, metric, wrap);
    });
  }

  widgetsHost.addEventListener('input', (e) => {
    const area = e.target.closest('.notes-area');
    if (!area) return;
    cardNotes[area.dataset.noteId] = area.value.slice(0, MAX_NOTE);
    const meta = area.parentElement.querySelector('.notes-meta');
    if (meta) meta.textContent = 'Saving...';
    saveNotesSoon();
    clearTimeout(area._savedTimer);
    area._savedTimer = setTimeout(() => { if (meta) meta.textContent = 'Saved on this computer'; }, 700);
  });

  widgetsHost.addEventListener('submit', (e) => {
    const form = e.target.closest('[data-watch-form]');
    if (!form) return;
    e.preventDefault();
    const input = form.querySelector('.watch-input');
    const name = input.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name) return;
    const key = TrackerStorage.normalizeCompany(name);
    if (watchlist.some(w => TrackerStorage.normalizeCompany(w.name) === key)) {
      showStatus(name + ' is already on your list.');
      return;
    }
    if (watchlist.length >= MAX_WATCH) return;
    watchlist.push({ id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, added: todayStr() });
    saveWatchlist();
    rerenderType('watchlist');
    const again = widgetsHost.querySelector('[data-watch-form] .watch-input');
    if (again) again.focus();
  });

  widgetsHost.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open-card-settings]');
    if (open) { openWidgetSettings(open.dataset.openCardSettings); return; }
    const row = e.target.closest('.watch-item');
    if (!row) return;
    const idx = watchlist.findIndex(w => w.id === row.dataset.watchId);
    if (idx < 0) return;
    if (e.target.closest('[data-watch-remove]')) {
      const removedW = watchlist.splice(idx, 1)[0];
      saveWatchlist();
      rerenderType('watchlist');
      showStatus(removedW.name + ' removed from your list.', 'ok', {
        label: 'Undo',
        run: () => { watchlist.splice(idx, 0, removedW); saveWatchlist(); rerenderType('watchlist'); }
      });
    } else if (e.target.closest('[data-watch-toggle]')) {
      watchlist[idx] = Object.assign({}, watchlist[idx], { done: !watchlist[idx].done });
      saveWatchlist();
      rerenderType('watchlist');
    }
  });

  // Brings the Add Details form into view with the first field focused,
  // adding or expanding its widget first when needed.
  async function focusDetailsForm() {
    const item = widgetItems.find(i => i.type === 'details');
    if (!item) await applyLayout(WidgetLayout.add('details', {}));
    else if (item.options.collapsed) await applyLayout(WidgetLayout.update(item.id, { collapsed: false }));
    const field = el('detail-company');
    if (!field || !field.closest('.widget')) return;
    field.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    field.focus({ preventScroll: true });
  }

  // A row for an entry: company or title, a quieter second line, and for job
  // entries a stage pill. Used by Recent Applications and search results.
  function entryRow(log, options = {}) {
    const metric = metricById(log.metricId);
    const li = make('li', 'entry');
    li.dataset.logId = log.id;
    li.style.setProperty('--c', options.color || (metric ? metric.color : '#1a73e8'));
    if (options.delay) li.style.animationDelay = Math.min(options.delay, 10) * 18 + 'ms';
    const main = make('div', 'entry-main');
    const titleText = log.company || log.role || log.notes || (log.metricId === 'jobs' ? 'Application' : (metric ? metric.name : 'Entry'));
    // A one-tracker list gets a company monogram; mixed lists keep the
    // tracker-colored dot, since there the color tells entries apart.
    if (options.monogram) {
      const mono = make('span', 'entry-mono', (titleText.trim()[0] || '?').toUpperCase());
      mono.setAttribute('aria-hidden', 'true');
      main.appendChild(mono);
    } else {
      main.appendChild(make('span', 'entry-dot'));
    }
    const text = make('div', 'entry-text');
    const title = make('div', 'entry-title');
    const subParts = [];
    if (log.company && log.role) subParts.push(log.role);
    if (!options.monogram) subParts.push(relativeDate(log.date));
    if (options.showTracker && metric) subParts.push(metric.name);
    if ((log.company || log.role) && log.notes && options.showNotes) subParts.push(log.notes);
    const subText = subParts.join(' · ');
    const sub = make('div', 'entry-sub');
    if (options.tokens) {
      highlightInto(title, titleText, options.tokens);
      highlightInto(sub, subText, options.tokens);
    } else {
      title.textContent = titleText;
      sub.textContent = subText;
    }
    title.title = titleText;
    if (options.monogram) {
      // The date sits on the title line so a long role can't truncate it.
      const head = make('div', 'entry-head');
      head.appendChild(title);
      head.appendChild(make('span', 'entry-date', relativeDate(log.date)));
      text.appendChild(head);
    } else {
      text.appendChild(title);
    }
    if (sub.textContent) text.appendChild(sub);
    main.appendChild(text);
    li.appendChild(main);
    const side = make('div', 'entry-side');
    if (log.metricId === 'jobs') side.appendChild(statusPill(log));
    if (options.deletable) {
      const del = make('button', 'del-btn');
      del.type = 'button';
      del.dataset.deleteId = log.id;
      del.setAttribute('aria-label', 'Delete this entry');
      del.title = 'Delete entry';
      del.innerHTML = X_SVG;
      side.appendChild(del);
    }
    li.appendChild(side);
    return li;
  }

  async function renderActivity(body, item, metric) {
    const key = 'activity:' + item.id;
    const token = bumpToken(key);
    let history;
    try {
      history = await TrackerStorage.getActivityHistory(item.options.days, metric.id);
    } catch (err) {
      console.warn('[LIT] activity unavailable', err);
      return;
    }
    if (asyncTokens[key] !== token || !body.isConnected) return;

    body.querySelector('[data-stat="total"]').textContent = history.totalCount;
    body.querySelector('[data-stat="avg"]').textContent = history.dailyAverage;
    body.querySelector('[data-stat="days"]').textContent = history.activeDaysCount;
    body.querySelector('[data-stat="best"]').textContent = history.bestDay.count;

    const emptyNote = body.querySelector('.activity-empty');
    if (emptyNote) {
      emptyNote.textContent = history.totalCount === 0 && (stats.totalLogs || 0) === 0
        ? coach('empty', ['chart'], 'Your chart fills in as you go.')
        : (item.options.days === WidgetLayout.ALL_DAYS ? 'Nothing here yet.' : 'Nothing in the last ' + item.options.days + ' days. A fresh start is one tap away.');
      emptyNote.classList.toggle('hidden', history.totalCount > 0);
    }

    const chart = body.querySelector('.chart');
    chart.textContent = '';
    chart.style.height = '';
    const mode = item.options.chart;
    if (mode === 'heatmap') renderHeatmap(chart, history, metric);
    else if (mode === 'area') renderArea(chart, history);
    else renderBars(chart, history);
  }

  function hoverColumns(history, withBars) {
    const bars = make('div', 'bars');
    const max = Math.max(4, ...history.days.map(d => d.count));
    history.days.forEach((day, i) => {
      const col = make('div', 'bar-col');
      if (withBars) {
        const bar = make('div', 'bar' + (day.count > 0 ? ' has-act' : ''));
        bar.style.height = (day.count > 0 ? Math.max(8, Math.round((day.count / max) * 100)) : 4) + '%';
        if (!reduceMotion) bar.style.animationDelay = Math.min(i * 10, 400) + 'ms';
        col.appendChild(bar);
      }
      col.appendChild(make('div', 'tip', day.label + ': ' + day.count));
      bars.appendChild(col);
    });
    return bars;
  }

  function renderBars(chart, history) {
    chart.appendChild(hoverColumns(history, true));
  }

  // Continuous sparkline with a soft fill, plus invisible columns for the
  // same hover tooltips the bars have.
  function renderArea(chart, history) {
    const NS = 'http://www.w3.org/2000/svg';
    const n = history.days.length;
    const W = Math.max(1, (n - 1) * 10);
    const H = 72;
    const max = Math.max(4, ...history.days.map(d => d.count));
    const pts = history.days.map((d, i) => [n === 1 ? 0 : (i / (n - 1)) * W, H - 4 - (d.count / max) * (H - 10)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const svgEl = document.createElementNS(NS, 'svg');
    svgEl.setAttribute('class', 'area-svg');
    svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('aria-hidden', 'true');
    const area = document.createElementNS(NS, 'path');
    area.setAttribute('d', line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z');
    area.setAttribute('class', 'area-fill');
    area.setAttribute('fill', 'var(--tracker)');
    const stroke = document.createElementNS(NS, 'path');
    stroke.setAttribute('d', line);
    stroke.setAttribute('class', 'area-line');
    stroke.setAttribute('stroke', 'var(--tracker)');
    stroke.setAttribute('vector-effect', 'non-scaling-stroke');
    svgEl.appendChild(area);
    svgEl.appendChild(stroke);
    chart.appendChild(svgEl);
    const last = pts[pts.length - 1];
    const dot = make('span', 'area-end');
    dot.style.left = (last[0] / W) * 100 + '%';
    dot.style.top = (last[1] / H) * 100 + '%';
    chart.appendChild(dot);
    const overlay = hoverColumns(history, false);
    overlay.classList.add('overlay');
    chart.appendChild(overlay);
  }

  // GitHub-style contribution grid: a column per week, Monday at the top,
  // shaded by how much of the daily goal each day reached.
  function renderHeatmap(chart, history, metric) {
    chart.style.height = 'auto';
    const grid = make('div', 'heat');
    const first = history.days[0];
    const pad = first ? (first.weekday + 6) % 7 : 0;
    for (let i = 0; i < pad; i++) grid.appendChild(make('span', 'heat-cell pad'));
    const goal = goalFor(metric);
    const today = TrackerStorage.getLocalDateStr();
    const shade = level => (level === 0 ? '' : 'color-mix(in srgb, var(--tracker) ' + [0, 30, 55, 78, 100][level] + '%, var(--surface-3))');
    history.days.forEach(day => {
      const level = day.count <= 0 ? 0 : Math.max(1, Math.min(4, Math.ceil((day.count / goal) * 4)));
      const cell = make('span', 'heat-cell' + (day.date === today ? ' today' : ''));
      if (level) cell.style.background = shade(level);
      cell.appendChild(make('span', 'tip', day.label + ': ' + day.count));
      grid.appendChild(cell);
    });
    chart.appendChild(grid);
    const legend = make('div', 'heat-legend');
    legend.appendChild(make('span', '', 'Less'));
    [0, 1, 2, 3, 4].forEach(level => {
      const sw = make('i');
      if (level) sw.style.background = shade(level);
      legend.appendChild(sw);
    });
    legend.appendChild(make('span', '', 'More'));
    chart.appendChild(legend);
  }

  // Cumulative solve times plus a sparkline of recent timed solves against
  // the median and the fastest.
  async function renderLeetcodeTimeStats() {
    const block = el('leetcode-time-block');
    const token = bumpToken('lcstats');
    let s;
    try {
      s = await TrackerStorage.getLeetcodeTimeStats();
    } catch (err) {
      console.warn('[LIT] solve times unavailable', err);
      return;
    }
    if (asyncTokens.lcstats !== token || !block.closest('.widget')) return;

    const fmt = TrackerStorage.formatTimeHMS;
    el('lc-today-time').textContent = fmt(s.todaySeconds);
    el('lc-total-time').textContent = fmt(s.totalSeconds);
    el('lc-avg-time').textContent = s.sessionCount > 0 ? fmt(s.avgSeconds) : '--';
    el('lc-best-time').textContent = s.bestSeconds > 0 ? fmt(s.bestSeconds) : '--';

    const note = el('leetcode-time-note');
    if (!s.sessionCount) {
      el('lc-spark-wrap').classList.add('hidden');
      note.textContent = 'Time a solve to see your trend.';
      note.classList.remove('hidden');
      return;
    }
    note.classList.add('hidden');
    renderSpark(s);
    // The trend reads from the sparkline; the sentence lives in its tooltip.
    let trend;
    if (s.sessionCount < 2) trend = 'your first timed solve.';
    else if (s.latestSeconds < s.medianSeconds) trend = fmt(s.medianSeconds - s.latestSeconds) + ' faster than your median.';
    else if (s.latestSeconds > s.medianSeconds) trend = fmt(s.latestSeconds - s.medianSeconds) + ' slower than your median.';
    else trend = 'right on your median.';
    el('lc-spark-wrap').title = 'Latest solve ' + fmt(s.latestSeconds) + ', ' + trend;
  }

  function renderSpark(s) {
    const wrap = el('lc-spark-wrap');
    const svgEl = el('lc-spark');
    const series = s.recent.map(r => r.seconds);
    if (series.length < 2) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const NS = 'http://www.w3.org/2000/svg';
    const W = 300;
    const H = 56;
    const max = Math.max(...series, s.medianSeconds) * 1.08;
    const x = i => (i / (series.length - 1)) * W;
    const y = v => H - 3 - (v / max) * (H - 8);
    svgEl.textContent = '';
    const median = document.createElementNS(NS, 'line');
    median.setAttribute('x1', '0');
    median.setAttribute('x2', String(W));
    median.setAttribute('y1', y(s.medianSeconds).toFixed(1));
    median.setAttribute('y2', y(s.medianSeconds).toFixed(1));
    median.setAttribute('stroke', 'var(--text-3)');
    median.setAttribute('stroke-dasharray', '4 4');
    median.setAttribute('vector-effect', 'non-scaling-stroke');
    svgEl.appendChild(median);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', series.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' '));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--tracker)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svgEl.appendChild(path);
    wrap.querySelectorAll('.spark-dot').forEach(d => d.remove());
    const best = series.indexOf(Math.min(...series));
    [[series.length - 1, 'legend-latest', 'Latest'], [best, 'legend-best', 'Fastest']].forEach(([i, cls, label]) => {
      const dot = make('span', 'spark-dot ' + cls);
      dot.title = label + ': ' + TrackerStorage.formatTimeHMS(series[i]);
      dot.style.left = (x(i) / W) * 100 + '%';
      dot.style.top = y(series[i]) + 'px';
      wrap.appendChild(dot);
    });
  }

  // Reconciles the grid against the layout: wrappers are created for new
  // items, removed for deleted ones, and re-appended in layout order (moving
  // a node keeps its contents). Then every visible widget is repainted.
  // Built-in cards first; then card types added by popup modules through
  // LitPopup.registerCard. A module card that throws shows a quiet note
  // instead of breaking the board.
  function rendererFor(type) {
    if (WIDGET_RENDERERS[type]) return WIDGET_RENDERERS[type];
    return typeof LitPopup !== 'undefined' ? LitPopup.renderer(type) : null;
  }

  function renderModuleCard(item, metric, wrap) {
    const body = wrap.querySelector('.widget-body');
    try {
      rendererFor(item.type)(body, item, metric, wrap);
    } catch (err) {
      console.warn('[LIT] card ' + item.type + ' could not render', err);
      body.textContent = '';
      body.appendChild(make('div', 'empty', 'This card could not load just now.'));
    }
  }

  function renderWidgets() {
    if (!widgetsHost || !metrics.length) return;
    const existing = {};
    Array.from(widgetsHost.children).forEach(node => { existing[node.dataset.widgetId] = node; });
    const keep = new Set();

    const visible = [];
    widgetItems.forEach(item => {
      const metric = metricFor(item);
      if (!metric || !rendererFor(item.type)) return;
      if (!WidgetLayout.isVisible(item, metric.id)) {
        if (PART_IDS[item.type]) parkPart(PART_IDS[item.type]);
        return;
      }
      visible.push({ item, metric });
    });
    const solo = WidgetLayout.soloCompactIds(visible.map(v => v.item));

    visible.forEach(({ item, metric }) => {
      let wrap = existing[item.id];
      if (!wrap) wrap = widgetShell(item);
      keep.add(item.id);
      widgetsHost.appendChild(wrap);
      updateShell(wrap, item, metric, solo.has(item.id));
      renderModuleCard(item, metric, wrap);
    });

    Object.keys(existing).forEach(id => {
      if (keep.has(id)) return;
      const node = existing[id];
      const type = node.dataset.widgetType;
      if (PART_IDS[type]) parkPart(PART_IDS[type]);
      node.remove();
    });

    if (!visible.length) widgetsHost.appendChild(widgetsEmptyState());
  }

  // Shown when every widget for this tab has been removed: two starting
  // points rather than a blank area.
  function widgetsEmptyState() {
    const box = make('div', 'empty empty-actions widgets-empty');
    box.appendChild(make('p', '', 'No cards on this tab. Add the ones you want, or start from the recommended set.'));
    const row = make('div', 'empty-buttons');
    const add = make('button', 'btn btn-accent btn-sm', 'Add a card');
    add.type = 'button';
    add.addEventListener('click', () => el('add-widget-btn').click());
    const reset = make('button', 'btn btn-ghost btn-sm', 'Use the recommended cards');
    reset.type = 'button';
    reset.addEventListener('click', () => resetLayout(null));
    row.appendChild(add);
    row.appendChild(reset);
    box.appendChild(row);
    return box;
  }

  function widgetById(id) {
    return widgetItems.find(i => i.id === id) || null;
  }

  // FLIP: widgets glide from where they were to where the new layout puts
  // them instead of jumping.
  function captureRects() {
    const rects = new Map();
    Array.from(widgetsHost.children).forEach(n => rects.set(n.dataset.widgetId, n.getBoundingClientRect()));
    return rects;
  }

  function playFlip(before) {
    if (!before || reduceMotion) return;
    Array.from(widgetsHost.children).forEach(n => {
      const r0 = before.get(n.dataset.widgetId);
      if (!r0 || typeof n.animate !== 'function') return;
      const r1 = n.getBoundingClientRect();
      const dx = r0.left - r1.left;
      const dy = r0.top - r1.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      n.animate([{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }], { duration: 420, easing: EASE });
    });
  }

  async function applyLayout(promise, successMessage, before) {
    const rects = before || captureRects();
    try {
      widgetItems = await promise;
    } catch (err) {
      oops('Your cards could not be updated just now. Please try again.', err);
      return false;
    }
    renderWidgets();
    playFlip(rects);
    if (successMessage) showStatus(successMessage, 'ok');
    return true;
  }

  widgetsHost.addEventListener('input', (e) => {
    const form = e.target.closest('.pipeline-editor');
    if (form) updatePipelineRemainder(form, parseInt(form.querySelector('.stage-input').max, 10) || 0);
  });

  widgetsHost.addEventListener('submit', (e) => {
    const form = e.target.closest('.pipeline-editor');
    if (!form) return;
    e.preventDefault();
    savePipelineCounts(form);
  });

  // One delegated listener covers every widget control.
  widgetsHost.addEventListener('click', (e) => {
    const wrap = e.target.closest('.widget');
    if (!wrap) return;
    const item = widgetById(wrap.dataset.widgetId);
    if (!item) return;
    if (e.target.closest('.widget-remove-btn')) {
      removeCard(item.id);
      return;
    }
    const shareWeek = e.target.closest('[data-share-week]');
    if (shareWeek) {
      const metric = metricFor(item);
      const n = parseInt(shareWeek.dataset.shareWeek, 10) || 0;
      openShare({ bigNumber: n, bigLabel: displayUnit(metric, n) + ' this week', metricId: metric.id });
      return;
    }
    const step = e.target.closest('[data-step]');
    if (step) {
      e.preventDefault();
      const input = step.parentElement.querySelector('.stage-input');
      const max = parseInt(input.max, 10) || 0;
      const next = Math.max(0, Math.min(max, (parseInt(input.value, 10) || 0) + parseInt(step.dataset.step, 10)));
      input.value = next;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (e.target.closest('.widget-edit-btn')) {
      openWidgetSettings(item.id);
      return;
    }
    if (e.target.closest('.widget-collapse')) {
      applyLayout(WidgetLayout.update(item.id, { collapsed: !item.options.collapsed }));
      return;
    }
    const chartBtn = e.target.closest('[data-chart]');
    if (chartBtn) {
      if (chartBtn.dataset.chart !== item.options.chart) applyLayout(WidgetLayout.update(item.id, { chart: chartBtn.dataset.chart }));
      return;
    }
    if (e.target.closest('.goal-edit')) {
      openMetricSettings(metricFor(item).id);
      return;
    }
    if (e.target.closest('.pipeline-edit-btn')) {
      pipelineEditing = item.id;
      renderWidgets();
      return;
    }
    if (e.target.closest('[data-pipeline-cancel]')) {
      pipelineEditing = null;
      renderWidgets();
      return;
    }
    const stage = e.target.closest('button.stage');
    if (stage) {
      pipelineFilter = pipelineFilter === stage.dataset.stage ? null : stage.dataset.stage;
      renderWidgets();
      return;
    }
    if (e.target.closest('[data-clear-filter]')) {
      pipelineFilter = null;
      renderWidgets();
      return;
    }
    const pill = e.target.closest('.status-pill');
    if (pill) openStatusPicker(pill);
  });

  /* Drag to reorder, in two dimensions.
     Pointer events on the grip, not HTML5 drag and drop: the native version
     cannot be styled, misbehaves in extension popups, and has no touch
     story. The lifted widget follows the pointer, a bar shows where it will
     land, and on release the order is committed through WidgetLayout.reorder
     by naming the neighbour it lands in front of, so hidden widgets keep
     their place in the layout. */
  let drag = null;

  function clearDropMarks() {
    widgetsHost.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
  }

  function findDropTarget(x, y) {
    const others = Array.from(widgetsHost.children).filter(n => n !== drag.wrap);
    if (!others.length) return null;
    let hit = null;
    let best = Infinity;
    for (const n of others) {
      const r = n.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        hit = n;
        break;
      }
      const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
      if (d < best) {
        best = d;
        hit = n;
      }
    }
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    const sideBySide = hit.classList.contains('size-compact') && !hit.classList.contains('solo');
    const before = sideBySide ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    return { node: hit, before };
  }

  function dragMove(x, y) {
    const d = drag;
    d.lastX = x;
    d.lastY = y;
    const dx = x - d.startX;
    const dy = y + window.scrollY - d.startPageY;
    d.wrap.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
    const target = findDropTarget(x, y);
    clearDropMarks();
    d.target = target;
    if (target) target.node.classList.add(target.before ? 'drop-before' : 'drop-after');
    // Nudge the popup's scroll near an edge so long layouts can be reordered
    // end to end. Runs only while a drag is live.
    const edge = 36;
    const speed = y < edge ? -6 : (y > window.innerHeight - edge ? 6 : 0);
    if (speed && !d.scrollRaf) {
      const step = () => {
        if (drag !== d) return;
        const before = window.scrollY;
        window.scrollBy(0, speed);
        if (window.scrollY !== before) dragMove(d.lastX, d.lastY);
        d.scrollRaf = requestAnimationFrame(step);
      };
      d.scrollRaf = requestAnimationFrame(step);
    } else if (!speed && d.scrollRaf) {
      cancelAnimationFrame(d.scrollRaf);
      d.scrollRaf = 0;
    }
  }

  function dragEnd(commit) {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.scrollRaf) cancelAnimationFrame(d.scrollRaf);
    try { d.handle.releasePointerCapture(d.pointerId); } catch (e) { /* already released */ }
    const before = captureRects();
    d.wrap.style.transform = '';
    d.wrap.classList.remove('dragging');
    widgetsHost.classList.remove('drag-active');
    clearDropMarks();
    if (!commit || !d.target) {
      playFlip(before);
      return;
    }
    const nodes = Array.from(widgetsHost.children).filter(n => n !== d.wrap);
    const idx = nodes.indexOf(d.target.node);
    const beforeNode = d.target.before ? d.target.node : nodes[idx + 1];
    applyLayout(WidgetLayout.reorder(d.id, beforeNode ? beforeNode.dataset.widgetId : null), null, before);
  }

  widgetsHost.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.widget-drag-handle');
    if (!handle || e.button !== 0) return;
    const wrap = handle.closest('.widget');
    if (!wrap) return;
    e.preventDefault();
    drag = {
      pointerId: e.pointerId,
      handle,
      wrap,
      id: wrap.dataset.widgetId,
      startX: e.clientX,
      startPageY: e.clientY + window.scrollY,
      lastX: e.clientX,
      lastY: e.clientY,
      target: null,
      scrollRaf: 0
    };
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    wrap.classList.add('dragging');
    widgetsHost.classList.add('drag-active');
  });

  widgetsHost.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.pointerId) dragMove(e.clientX, e.clientY);
  });
  widgetsHost.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) dragEnd(true);
  });
  widgetsHost.addEventListener('pointercancel', () => dragEnd(false));
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dragEnd(false);
    }
  }, true);

  // The grip is for pointers; keyboard users move a focused grip with the
  // arrow keys, one step at a time, or use the Position token.
  widgetsHost.addEventListener('keydown', (e) => {
    const handle = e.target.closest && e.target.closest('.widget-drag-handle');
    if (!handle) return;
    const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const wrap = handle.closest('.widget');
    const id = wrap && wrap.dataset.widgetId;
    if (!id) return;
    applyLayout(WidgetLayout.move(id, delta)).then(() => {
      const again = widgetsHost.querySelector('[data-widget-id="' + CSS.escape(id) + '"] .widget-drag-handle');
      if (again) again.focus();
    });
  });

  /* Customize mode: like a phone home screen. Cards wiggle, drag handles and
     remove buttons appear, and "Add a card" sits next to Done. */
  function setCustomizing(on) {
    customizing = !!on;
    widgetsHost.classList.toggle('customizing', customizing);
    el('customize-btn').setAttribute('aria-pressed', customizing ? 'true' : 'false');
    el('customize-label').textContent = customizing ? 'Done' : 'Customize cards';
    el('add-widget-btn').classList.toggle('hidden', !customizing);
    widgetsHost.querySelectorAll('.widget-remove-btn').forEach(b => { b.tabIndex = customizing ? 0 : -1; });
    if (customizing) showStatus('Drag cards to move them, or tap the corner button to remove one. Press Done when you are finished.');
    bridgeEmit('customize', { on: customizing });
  }
  el('customize-btn').addEventListener('click', () => setCustomizing(!customizing));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && customizing && !openModalEl && !drag && !popoverState) {
      setCustomizing(false);
      el('customize-btn').focus();
    }
  });

  // Remove straight from customize mode, with Undo in the toast.
  async function removeCard(id) {
    const removedItem = widgetById(id);
    if (!removedItem) return;
    const index = widgetItems.findIndex(i => i.id === id);
    const nextId = index >= 0 && widgetItems[index + 1] ? widgetItems[index + 1].id : null;
    const ok = await applyLayout(WidgetLayout.remove(id));
    if (!ok) return;
    showStatus(WidgetLayout.TYPES[removedItem.type].name + ' card removed. Nothing you logged changed.', 'ok', {
      label: 'Undo',
      run: () => restoreWidget(removedItem, nextId)
    });
  }

  /* Add a card picker */
  function renderWidgetPicker() {
    const list = el('add-widget-list');
    list.textContent = '';
    WidgetLayout.availableTypes(widgetItems).forEach(t => {
      const row = make('div', 'widget-picker-row');
      const icon = make('span', 'widget-picker-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" focusable="false">' + (WIDGET_TYPE_ICON[t.type] || t.icon || '') + '</svg>';
      const text = make('div', 'widget-picker-text');
      const name = make('div', 'widget-picker-name', t.name);
      if (t.isNew) name.appendChild(make('span', 'new-tag', 'New'));
      text.appendChild(name);
      row.title = t.description;
      text.appendChild(make('div', 'widget-picker-desc', t.description));
      const btn = make('button', 'widget-add-btn' + (t.added ? ' added' : ''), t.added ? 'Added' : 'Add');
      btn.type = 'button';
      btn.setAttribute('aria-label', (t.added ? 'Already added: ' : 'Add ') + t.name);
      btn.disabled = t.added;
      btn.addEventListener('click', async () => {
        const ok = await applyLayout(WidgetLayout.add(t.type, { metricId: WidgetLayout.ACTIVE }), t.name + ' card added.');
        if (ok) closeModal(el('add-widget-modal'));
      });
      row.appendChild(icon);
      row.appendChild(text);
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  el('add-widget-btn').addEventListener('click', () => {
    renderWidgetPicker();
    openModal(el('add-widget-modal'));
  });
  el('close-add-widget-modal').addEventListener('click', () => closeModal(el('add-widget-modal')));

  async function resetLayout(modal) {
    const ok = await applyLayout(WidgetLayout.reset(), 'Back to the recommended cards.');
    if (ok && modal) closeModal(modal);
  }
  el('reset-layout-btn').addEventListener('click', () => resetLayout(el('add-widget-modal')));
  el('settings-reset-layout-btn').addEventListener('click', () => resetLayout(null));

  // ---------------------------------------------------------------------------
  // Token popover: one floating list shared by every token value button and
  // every stage pill. Anchored under (or above) the control that opened it,
  // arrow-key navigable, closed by Escape, an outside pointer, or a pick.
  // Escape is caught in the capture phase so the modal underneath stays open.
  // ---------------------------------------------------------------------------
  const tokenPopover = el('token-popover');
  const tokenPopoverList = el('token-popover-list');
  let popoverState = null; // { anchor, items, onPick, active }

  function closeTokenPopover(restoreFocus) {
    if (!popoverState) return;
    const { anchor } = popoverState;
    popoverState = null;
    tokenPopover.classList.add('hidden');
    tokenPopoverList.textContent = '';
    anchor.setAttribute('aria-expanded', 'false');
    anchor.classList.remove('token-open');
    if (restoreFocus !== false && anchor.isConnected) anchor.focus();
  }

  function placeTokenPopover(anchor) {
    const a = anchor.getBoundingClientRect();
    const w = tokenPopover.offsetWidth;
    const h = tokenPopover.offsetHeight;
    const gap = 6;
    const left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
    let top = a.bottom + gap;
    if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - gap - h);
    tokenPopover.style.left = left + 'px';
    tokenPopover.style.top = top + 'px';
  }

  function setPopoverActive(index) {
    if (!popoverState) return;
    const options = tokenPopoverList.children;
    const clamped = Math.max(0, Math.min(index, options.length - 1));
    popoverState.active = clamped;
    Array.prototype.forEach.call(options, (li, i) => li.classList.toggle('active', i === clamped));
    tokenPopoverList.setAttribute('aria-activedescendant', options[clamped] ? options[clamped].id : '');
    if (options[clamped]) options[clamped].scrollIntoView({ block: 'nearest' });
  }

  // items: [{ value, label, selected, stage }]. onPick(value) runs after the popover closes.
  function openTokenPopover(anchor, items, onPick) {
    if (popoverState && popoverState.anchor === anchor) { closeTokenPopover(); return; }
    closeTokenPopover(false);
    tokenPopoverList.textContent = '';
    items.forEach((item, i) => {
      const li = make('li', item.stage ? 'stage-' + item.stage : '');
      li.id = 'token-option-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', item.selected ? 'true' : 'false');
      if (item.stage) li.appendChild(make('i'));
      if (item.swatch) {
        const dot = make('i', 'token-swatch');
        dot.style.background = item.swatch;
        li.appendChild(dot);
      }
      li.appendChild(make('span', 'token-option-label', item.label));
      if (item.selected) {
        const check = make('span', 'token-option-check');
        check.innerHTML = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 6.2l2.2 2.3L9.5 3.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        li.appendChild(check);
      }
      li.addEventListener('mouseenter', () => setPopoverActive(i));
      li.addEventListener('click', () => pickPopover(i));
      tokenPopoverList.appendChild(li);
    });
    popoverState = { anchor, items, onPick, active: 0 };
    anchor.setAttribute('aria-expanded', 'true');
    anchor.classList.add('token-open');
    tokenPopover.classList.remove('hidden');
    placeTokenPopover(anchor);
    setPopoverActive(Math.max(0, items.findIndex(i => i.selected)));
    tokenPopoverList.focus();
  }

  function pickPopover(index) {
    if (!popoverState) return;
    const { items, onPick } = popoverState;
    const item = items[index];
    closeTokenPopover();
    if (item) onPick(item.value);
  }

  tokenPopoverList.addEventListener('keydown', (e) => {
    if (!popoverState) return;
    const last = popoverState.items.length - 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setPopoverActive(popoverState.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPopoverActive(popoverState.active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setPopoverActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setPopoverActive(last); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickPopover(popoverState.active); }
    else if (e.key === 'Tab') { closeTokenPopover(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!popoverState || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    closeTokenPopover();
  }, true);

  document.addEventListener('pointerdown', (e) => {
    if (!popoverState) return;
    if (tokenPopover.contains(e.target) || popoverState.anchor.contains(e.target)) return;
    closeTokenPopover(false);
  }, true);

  window.addEventListener('resize', () => { if (popoverState) placeTokenPopover(popoverState.anchor); });

  // A changed value flashes once.
  function flashToken(btn) {
    btn.classList.remove('token-flash');
    void btn.offsetWidth;
    btn.classList.add('token-flash');
  }

  // Stage pills (Recent Applications and search) open the popover with the
  // five stages.
  function openStatusPicker(pill) {
    const logId = pill.dataset.logId;
    const current = pill.dataset.status;
    const items = STATUSES.map(s => ({ value: s.id, label: s.label, selected: s.id === current, stage: s.id }));
    openTokenPopover(pill, items, async (value) => {
      if (value === current) return;
      let updated;
      try {
        updated = await TrackerStorage.setLogStatus(logId, value);
      } catch (err) {
        oops('The stage did not change. Please try again.', err);
        return;
      }
      if (!updated) {
        showStatus('That one could not be found. It may have been removed on another computer.', 'error');
        return;
      }
      // Patch the local copies so the pill, funnel, and rate update now.
      if (jobsCache && jobsCache.logs) {
        const hit = jobsCache.logs.find(l => l.id === logId);
        if (hit) Object.assign(hit, updated);
      }
      document.querySelectorAll('.status-pill[data-log-id="' + CSS.escape(logId) + '"]').forEach(p => p.replaceWith(statusPill(updated)));
      renderWidgets();
      if (value === 'rejected') {
        showStatus(coach('rejection', [voice()], 'Every no is a rep. You\'re still in it.'), 'ok');
      } else if ((value === 'interviewing' || value === 'offer') && current !== 'interviewing' && current !== 'offer') {
        showStatus('Moved to ' + statusMeta(value).label + '. That is the work paying off.', 'ok');
        checkMilestones(true);
      } else {
        showStatus('Moved ' + (updated.company || updated.role || 'that application') + ' to ' + statusMeta(value).label + '.', 'ok');
      }
    });
  }

  /* Widget settings */
  let settingsWidgetId = null;
  let widgetRemoveArmed = false;
  let widgetDraft = null; // { metricId, days, showStats, size, chart }

  function metricLabelFor(metricId) {
    if (metricId === WidgetLayout.ACTIVE) return 'Whichever tab I\'m on';
    const m = metricById(metricId);
    return m ? 'This goal: ' + m.name : 'Whichever tab I\'m on';
  }

  function renderWidgetTokens() {
    const item = widgetById(settingsWidgetId);
    if (!item || !widgetDraft) return;
    const spec = WidgetLayout.TYPES[item.type];
    const bindable = 'metricId' in spec.defaults;
    const isActivity = item.type === 'activity';

    el('widget-token-metric').classList.toggle('hidden', !bindable);
    el('widget-metric-btn').textContent = metricLabelFor(widgetDraft.metricId);
    el('widget-size-btn').textContent = widgetDraft.size === 'compact' ? 'Half width' : 'Full width';

    ['widget-token-chart', 'widget-token-days', 'widget-token-stats'].forEach(id => el(id).classList.toggle('hidden', !isActivity));

    const titleInput = el('widget-title-input');
    titleInput.placeholder = defaultWidgetTitle(item);
    if (document.activeElement !== titleInput) titleInput.value = widgetDraft.title || '';
    el('widget-color-btn').textContent = widgetDraft.color ? (CARD_COLOR_NAMES[widgetDraft.color] || 'Custom') : 'Match the goal';

    const toggles = [
      ['widget-token-checkpoints', 'widget-checkpoints-btn', item.type === 'goal', widgetDraft.showCheckpoints],
      ['widget-token-weekly', 'widget-weekly-btn', item.type === 'goal', widgetDraft.showWeekly],
      ['widget-token-longest', 'widget-longest-btn', item.type === 'streak', widgetDraft.showLongest]
    ];
    toggles.forEach(([tokenId, btnId, applies, on]) => {
      el(tokenId).classList.toggle('hidden', !applies);
      const b = el(btnId);
      b.textContent = on ? 'Shown' : 'Hidden';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('token-muted', !on);
    });
    el('widget-token-periods').classList.toggle('hidden', item.type !== 'summary');
    el('widget-periods').querySelectorAll('[data-period]').forEach(b => b.setAttribute('aria-pressed', widgetDraft.periods.includes(b.dataset.period) ? 'true' : 'false'));
    el('widget-token-count').classList.toggle('hidden', item.type !== 'recentList');
    el('widget-token-cd-label').classList.toggle('hidden', item.type !== 'countdown');
    el('widget-token-cd-date').classList.toggle('hidden', item.type !== 'countdown');
    el('widget-token-quote').classList.toggle('hidden', item.type !== 'quote');
    if (document.activeElement !== el('widget-cd-label-input')) el('widget-cd-label-input').value = widgetDraft.cdLabel || '';
    if (document.activeElement !== el('widget-cd-date-input')) el('widget-cd-date-input').value = widgetDraft.cdDate || '';
    if (document.activeElement !== el('widget-quote-input')) el('widget-quote-input').value = widgetDraft.quoteText || '';
    el('widget-count-btn').textContent = 'Last ' + widgetDraft.count;
    el('duplicate-widget-btn').classList.toggle('hidden', !!spec.singleton);
    if (isActivity) {
      el('widget-chart-btn').textContent = CHART_LABELS[widgetDraft.chart];
      const allDays = widgetDraft.days === WidgetLayout.ALL_DAYS;
      const daysInput = el('widget-days-input');
      if (!allDays && document.activeElement !== daysInput) daysInput.value = String(widgetDraft.days);
      if (allDays) daysInput.value = '';
      daysInput.disabled = allDays;
      el('widget-days-unit').classList.toggle('hidden', allDays);
      daysInput.classList.toggle('hidden', allDays);
      el('widget-days-all-btn').setAttribute('aria-pressed', allDays ? 'true' : 'false');
      const statsBtn = el('widget-stats-btn');
      statsBtn.textContent = widgetDraft.showStats ? 'Shown' : 'Hidden';
      statsBtn.setAttribute('aria-pressed', widgetDraft.showStats ? 'true' : 'false');
      statsBtn.classList.toggle('token-muted', !widgetDraft.showStats);
    }

    const index = widgetItems.findIndex(i => i.id === settingsWidgetId);
    el('widget-position-text').textContent = (index + 1) + ' of ' + widgetItems.length;
    el('widget-move-up-btn').disabled = index <= 0;
    el('widget-move-down-btn').disabled = index >= widgetItems.length - 1;
  }

  function openWidgetSettings(id) {
    const item = widgetById(id);
    if (!item) return;
    settingsWidgetId = id;
    widgetRemoveArmed = false;
    widgetDraft = {
      metricId: metricById(item.options.metricId) ? item.options.metricId : WidgetLayout.ACTIVE,
      days: WidgetLayout.normalizeDays(item.options.days, 30),
      showStats: item.options.showStats !== false,
      size: item.options.size,
      chart: item.options.chart || 'bar',
      title: item.options.title || '',
      color: item.options.color || '',
      showWeekly: item.options.showWeekly !== false,
      showCheckpoints: item.options.showCheckpoints !== false,
      showLongest: item.options.showLongest !== false,
      periods: (item.options.periods || WidgetLayout.DEFAULT_PERIODS).slice(),
      count: item.options.count || WidgetLayout.DEFAULT_RECENT,
      cdLabel: item.options.label || '',
      cdDate: item.options.date || '',
      quoteText: item.options.quoteText || ''
    };
    const spec = WidgetLayout.TYPES[item.type];
    el('widget-settings-title').textContent = spec.name;
    renderWidgetTokens();
    const remove = el('remove-widget-btn');
    remove.querySelector('span').textContent = 'Remove card';
    remove.classList.remove('armed');
    remove.title = 'Removing a card never deletes anything you logged. Add it back any time.';
    openModal(el('widget-settings-modal'), 'metricId' in spec.defaults ? 'widget-metric-btn' : 'widget-size-btn');
  }

  el('widget-metric-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = [{ value: WidgetLayout.ACTIVE, label: 'Whichever tab I\'m on', selected: widgetDraft.metricId === WidgetLayout.ACTIVE }]
      .concat(visibleMetrics().map(m => ({ value: m.id, label: 'This goal: ' + m.name, selected: widgetDraft.metricId === m.id })));
    openTokenPopover(el('widget-metric-btn'), items, (value) => {
      if (value === widgetDraft.metricId) return;
      widgetDraft.metricId = value;
      renderWidgetTokens();
      flashToken(el('widget-metric-btn'));
    });
  });

  el('widget-size-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = [
      { value: 'compact', label: 'Half width', selected: widgetDraft.size === 'compact' },
      { value: 'expanded', label: 'Full width', selected: widgetDraft.size !== 'compact' }
    ];
    openTokenPopover(el('widget-size-btn'), items, (value) => {
      if (value === widgetDraft.size) return;
      widgetDraft.size = value;
      renderWidgetTokens();
      flashToken(el('widget-size-btn'));
    });
  });

  el('widget-chart-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = WidgetLayout.CHART_MODES.map(c => ({ value: c, label: CHART_HINTS[c], selected: widgetDraft.chart === c }));
    openTokenPopover(el('widget-chart-btn'), items, (value) => {
      if (value === widgetDraft.chart) return;
      widgetDraft.chart = value;
      renderWidgetTokens();
      flashToken(el('widget-chart-btn'));
    });
  });

  // Length is typed, not picked: any count up to a year, or the word "all".
  // The draft only moves on a valid value, so a half-typed number keeps the
  // last good length until the field settles.
  function readDaysInput() {
    if (!widgetDraft) return;
    const raw = el('widget-days-input').value;
    const days = WidgetLayout.normalizeDays(raw, null);
    if (days === null || days === widgetDraft.days) return;
    widgetDraft.days = days;
    if (days === WidgetLayout.ALL_DAYS) renderWidgetTokens();
  }
  el('widget-days-input').addEventListener('input', readDaysInput);
  el('widget-days-input').addEventListener('blur', () => {
    readDaysInput();
    renderWidgetTokens();
  });
  el('widget-days-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  el('widget-days-all-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const turningOn = widgetDraft.days !== WidgetLayout.ALL_DAYS;
    widgetDraft.days = turningOn ? WidgetLayout.ALL_DAYS : 30;
    renderWidgetTokens();
    flashToken(el('widget-days-all-btn'));
    if (!turningOn) { const i = el('widget-days-input'); i.focus(); i.select(); }
  });

  el('widget-stats-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    widgetDraft.showStats = !widgetDraft.showStats;
    renderWidgetTokens();
    flashToken(el('widget-stats-btn'));
  });

  ['widget-title-input', 'widget-cd-label-input', 'widget-quote-input'].forEach(id => {
    el(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el('widget-settings-form').requestSubmit(); }
    });
  });

  el('widget-color-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = [{ value: '', label: 'Match the goal', selected: !widgetDraft.color }]
      .concat(WidgetLayout.CARD_COLORS.map(hex => ({ value: hex, label: CARD_COLOR_NAMES[hex] || hex, swatch: hex, selected: widgetDraft.color === hex })));
    openTokenPopover(el('widget-color-btn'), items, (value) => {
      if (value === widgetDraft.color) return;
      widgetDraft.color = value;
      renderWidgetTokens();
      flashToken(el('widget-color-btn'));
    });
  });

  [['widget-checkpoints-btn', 'showCheckpoints'], ['widget-weekly-btn', 'showWeekly'], ['widget-longest-btn', 'showLongest']].forEach(([id, key]) => {
    el(id).addEventListener('click', () => {
      if (!widgetDraft) return;
      widgetDraft[key] = !widgetDraft[key];
      renderWidgetTokens();
      flashToken(el(id));
    });
  });

  // Totals: any mix of the four, but never none.
  el('widget-periods').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-period]');
    if (!chip || !widgetDraft) return;
    const p = chip.dataset.period;
    const has = widgetDraft.periods.includes(p);
    if (has && widgetDraft.periods.length === 1) {
      showStatus('Keep at least one total on the card.', 'error');
      return;
    }
    const next = has ? widgetDraft.periods.filter(x => x !== p) : widgetDraft.periods.concat([p]);
    widgetDraft.periods = WidgetLayout.SUMMARY_PERIODS.filter(x => next.includes(x));
    renderWidgetTokens();
  });

  el('widget-count-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = WidgetLayout.RECENT_COUNTS.map(n => ({ value: n, label: 'Last ' + n, selected: widgetDraft.count === n }));
    openTokenPopover(el('widget-count-btn'), items, (value) => {
      if (value === widgetDraft.count) return;
      widgetDraft.count = value;
      renderWidgetTokens();
      flashToken(el('widget-count-btn'));
    });
  });

  el('duplicate-widget-btn').addEventListener('click', async () => {
    const item = widgetById(settingsWidgetId);
    if (!item || typeof WidgetLayout.duplicate !== 'function') return;
    const ok = await applyLayout(WidgetLayout.duplicate(item.id), 'Copy added below. Change its goal or style to compare.');
    if (ok) closeModal(el('widget-settings-modal'));
  });

  async function moveSettingsWidget(delta) {
    if (!settingsWidgetId) return;
    const ok = await applyLayout(WidgetLayout.move(settingsWidgetId, delta));
    if (!ok) return;
    renderWidgetTokens();
    flashToken(el('widget-position-text'));
  }

  el('widget-move-up-btn').addEventListener('click', () => moveSettingsWidget(-1));
  el('widget-move-down-btn').addEventListener('click', () => moveSettingsWidget(1));

  el('widget-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const item = widgetById(settingsWidgetId);
    if (!item || !widgetDraft) { closeModal(el('widget-settings-modal')); return; }
    widgetDraft.title = el('widget-title-input').value.trim();
    const patch = { size: widgetDraft.size, title: widgetDraft.title, color: widgetDraft.color };
    if (item.type === 'goal') {
      patch.showWeekly = widgetDraft.showWeekly;
      patch.showCheckpoints = widgetDraft.showCheckpoints;
    }
    if (item.type === 'streak') patch.showLongest = widgetDraft.showLongest;
    if (item.type === 'summary') patch.periods = widgetDraft.periods;
    if (item.type === 'recentList') patch.count = widgetDraft.count;
    if (item.type === 'countdown') {
      patch.label = el('widget-cd-label-input').value.trim();
      patch.date = el('widget-cd-date-input').value;
    }
    if (item.type === 'quote') patch.quoteText = el('widget-quote-input').value.trim();
    if ('metricId' in WidgetLayout.TYPES[item.type].defaults) patch.metricId = widgetDraft.metricId;
    if (item.type === 'activity') {
      patch.days = widgetDraft.days;
      patch.showStats = widgetDraft.showStats;
      patch.chart = widgetDraft.chart;
    }
    const ok = await applyLayout(WidgetLayout.update(item.id, patch), 'Card updated.');
    if (ok) closeModal(el('widget-settings-modal'));
  });

  // Two-step remove, same pattern as deleting a tracker. The confirm label
  // names the action, and the status line offers Undo, which adds the same
  // widget back with its options in its old slot.
  el('remove-widget-btn').addEventListener('click', async () => {
    const btn = el('remove-widget-btn');
    if (!widgetRemoveArmed) {
      widgetRemoveArmed = true;
      btn.querySelector('span').textContent = 'Yes, remove card';
      btn.classList.add('armed');
      return;
    }
    const target = settingsWidgetId;
    const removedItem = widgetById(target);
    const index = widgetItems.findIndex(i => i.id === target);
    const nextId = index >= 0 && widgetItems[index + 1] ? widgetItems[index + 1].id : null;
    settingsWidgetId = null;
    widgetRemoveArmed = false;
    const ok = await applyLayout(WidgetLayout.remove(target));
    if (!ok) return;
    closeModal(el('widget-settings-modal'));
    const name = removedItem ? WidgetLayout.TYPES[removedItem.type].name : 'Card';
    showStatus(name + ' card removed. Nothing you logged changed.', 'ok', removedItem ? {
      label: 'Undo',
      run: () => restoreWidget(removedItem, nextId)
    } : null);
  });

  async function restoreWidget(item, beforeId) {
    const before = captureRects();
    let items;
    try {
      items = await WidgetLayout.add(item.type, item.options);
      const added = items.find(i => i.type === item.type && !widgetItems.some(w => w.id === i.id));
      if (added && beforeId && items.some(i => i.id === beforeId)) items = await WidgetLayout.reorder(added.id, beforeId);
    } catch (err) {
      oops('That card could not come back just now. Add it again from Add a card.', err);
      return;
    }
    await applyLayout(Promise.resolve(items), WidgetLayout.TYPES[item.type].name + ' card is back.', before);
  }

  el('close-widget-settings-modal').addEventListener('click', () => closeModal(el('widget-settings-modal')));
  el('cancel-widget-settings-btn').addEventListener('click', () => closeModal(el('widget-settings-modal')));

  // ---------------------------------------------------------------------------
  // Goals: add, edit (name, unit, icon, color, numbers), hide, delete, reorder
  // ---------------------------------------------------------------------------
  let settingsMetricId = null;
  let metricDeleteArmed = false;
  let metricEditFromSettings = false;

  const GOAL_COLORS = [
    ['#E0674B', 'Coral'], ['#5E9270', 'Sage'], ['#3B7EA1', 'Ocean'], ['#C9821F', 'Amber'],
    ['#8A5A9E', 'Plum'], ['#3D4A5C', 'Slate'], ['#C2185B', 'Berry'], ['#00897B', 'Teal']
  ];

  // One-tap starting points for people who are not sure what to count.
  // Templates with an `area` match a starter goal that may already exist
  // (hidden), so picking one shows that goal again instead of duplicating it.
  const GOAL_TEMPLATES = [
    // Applying
    { group: 'Applying', name: 'Follow-ups', unit: 'follow-ups', goal: 2, icon: 'mail', color: '#00897B' },
    { group: 'Applying', name: 'Referrals asked', unit: 'asks', goal: 1, icon: 'people', color: '#5E9270' },
    { group: 'Applying', name: 'Tailored resumes', unit: 'resumes', goal: 2, icon: 'pen', color: '#3B7EA1' },
    { group: 'Applying', name: 'Cover letters', unit: 'letters', goal: 1, icon: 'pen', color: '#8A5A9E' },
    { group: 'Applying', name: 'Jobs saved to apply', unit: 'jobs', goal: 5, icon: 'star', color: '#C9821F' },
    // Networking
    { group: 'Networking', area: 'networking', name: 'Networking chats', unit: 'chats', goal: 1, icon: 'people', color: '#5E9270' },
    { group: 'Networking', area: 'outreach', name: 'Cold emails', unit: 'emails', goal: 3, icon: 'mail', color: '#3B7EA1' },
    { group: 'Networking', name: 'LinkedIn connections', unit: 'connections', goal: 5, icon: 'people', color: '#3D4A5C' },
    { group: 'Networking', name: 'Recruiter messages', unit: 'messages', goal: 2, icon: 'chat', color: '#C2185B' },
    { group: 'Networking', name: 'Informational interviews', unit: 'calls', goal: 1, icon: 'phone', color: '#00897B' },
    { group: 'Networking', name: 'Events and meetups', unit: 'events', goal: 1, icon: 'star', color: '#8A5A9E' },
    { group: 'Networking', name: 'LinkedIn posts', unit: 'posts', goal: 1, icon: 'chat', color: '#C9821F' },
    // Interviews
    { group: 'Interviews', name: 'Interviews', unit: 'interviews', goal: 1, icon: 'phone', color: '#8A5A9E' },
    { group: 'Interviews', area: 'prep', name: 'Interview prep', unit: 'sessions', goal: 1, icon: 'book', color: '#8A5A9E' },
    { group: 'Interviews', name: 'Mock interviews', unit: 'mocks', goal: 1, icon: 'people', color: '#3B7EA1' },
    { group: 'Interviews', name: 'Thank-you notes', unit: 'notes', goal: 1, icon: 'mail', color: '#5E9270' },
    { group: 'Interviews', name: 'Company research', unit: 'companies', goal: 2, icon: 'book', color: '#3D4A5C' },
    // Skills
    { group: 'Skills', area: 'leetcode', name: 'LeetCode', unit: 'problems', goal: 2, icon: 'code', color: '#3D4A5C' },
    { group: 'Skills', name: 'Course lessons', unit: 'lessons', goal: 1, icon: 'book', color: '#C2185B' },
    { group: 'Skills', name: 'Certification study', unit: 'sessions', goal: 1, icon: 'star', color: '#C9821F' },
    { group: 'Skills', area: 'portfolio', name: 'Portfolio pieces', unit: 'pieces', goal: 1, icon: 'pen', color: '#C9821F' },
    { group: 'Skills', name: 'Side project work', unit: 'sessions', goal: 1, icon: 'code', color: '#00897B' },
    { group: 'Skills', name: 'Industry reading', unit: 'articles', goal: 1, icon: 'book', color: '#5E9270' },
    // Wellbeing
    { group: 'Wellbeing', name: 'Glasses of water', unit: 'glasses', goal: 8, icon: 'star', color: '#3B7EA1' },
    { group: 'Wellbeing', name: 'Walks or workouts', unit: 'workouts', goal: 1, icon: 'people', color: '#5E9270' },
    { group: 'Wellbeing', name: 'Screen breaks', unit: 'breaks', goal: 3, icon: 'target', color: '#C9821F' }
  ];

  function isBuiltInMetric(m) {
    return !!m && (!!m.isDefault || m.id === 'jobs' || m.id === 'leetcode');
  }

  function buildIconPicker(container, selected, onPick) {
    container.textContent = '';
    Object.keys(TRACKER_ICONS).forEach(key => {
      const b = make('button', 'icon-option');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.icon = key;
      b.setAttribute('aria-checked', key === selected ? 'true' : 'false');
      b.setAttribute('aria-label', ICON_NAMES[key] || key);
      b.title = ICON_NAMES[key] || key;
      b.innerHTML = TRACKER_ICONS[key];
      b.addEventListener('click', () => {
        container.querySelectorAll('.icon-option').forEach(x => x.setAttribute('aria-checked', x === b ? 'true' : 'false'));
        onPick(key);
      });
      container.appendChild(b);
    });
  }

  function buildColorPicker(container, selected, onPick) {
    container.textContent = '';
    const want = String(selected || '').toLowerCase();
    const options = GOAL_COLORS.slice();
    // A goal made before this palette keeps its own color as the first pick.
    if (want && !options.some(([hex]) => hex.toLowerCase() === want)) options.unshift([selected, 'Current color']);
    options.forEach(([hex, name]) => {
      const b = make('button', 'color-option');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.color = hex;
      b.style.background = hex;
      b.setAttribute('aria-label', name);
      b.title = name;
      const on = hex.toLowerCase() === want;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.addEventListener('click', () => {
        container.querySelectorAll('.color-option').forEach(x => {
          x.classList.toggle('selected', x === b);
          x.setAttribute('aria-checked', x === b ? 'true' : 'false');
        });
        onPick(hex);
      });
      container.appendChild(b);
    });
  }

  function setUnitChips(value) {
    el('unit-chips').querySelectorAll('[data-unit]').forEach(b => b.classList.toggle('is-active', b.dataset.unit === value));
  }

  // ----- Add a goal ----------------------------------------------------------
  const newGoalDraft = { icon: 'target', color: GOAL_COLORS[0][0] };

  function existingForTemplate(t) {
    if (!t.area) return null;
    return metrics.find(m => (m.focusArea || m.id) === t.area) || null;
  }

  function renderGoalTemplates() {
    const host = el('goal-templates');
    host.textContent = '';
    let group = null;
    let row = null;
    const taken = new Set(metrics.filter(m => !m.hidden).map(m => m.name.toLowerCase()));
    GOAL_TEMPLATES.forEach((t, i) => {
      const existing = existingForTemplate(t);
      if (existing && !existing.hidden) return; // already on the board
      if (!t.area && taken.has(t.name.toLowerCase())) return;
      if (t.group !== group) {
        group = t.group;
        host.appendChild(make('span', 'goal-template-group', group));
        row = make('div', 'goal-template-row');
        host.appendChild(row);
      }
      const b = make('button', 'chip-btn goal-template');
      b.type = 'button';
      b.dataset.template = String(i);
      const icon = make('span', 'goal-template-icon');
      icon.style.color = t.color;
      icon.innerHTML = TRACKER_ICONS[t.icon];
      b.appendChild(icon);
      b.appendChild(document.createTextNode(t.name));
      if (existing) b.title = 'You have this goal hidden. Picking it shows it again with everything you logged.';
      row.appendChild(b);
    });
    host.closest('.form-group').classList.toggle('hidden', !host.querySelector('.goal-template'));
  }

  function resetNewGoalForm() {
    el('new-metric-name').value = '';
    el('new-metric-unit').value = '';
    el('new-metric-goal').value = '3';
    setUnitChips('');
    newGoalDraft.icon = 'target';
    newGoalDraft.color = GOAL_COLORS[0][0];
    buildIconPicker(el('new-metric-icons'), newGoalDraft.icon, k => { newGoalDraft.icon = k; });
    buildColorPicker(el('color-palette'), newGoalDraft.color, c => { newGoalDraft.color = c; });
    renderGoalTemplates();
  }

  function openNewGoal() {
    resetNewGoalForm();
    openModal(el('new-metric-modal'), 'new-metric-name');
  }

  el('add-metric-tab-btn').addEventListener('click', openNewGoal);
  el('close-metric-modal').addEventListener('click', () => closeModal(el('new-metric-modal')));
  el('cancel-metric-btn').addEventListener('click', () => closeModal(el('new-metric-modal')));

  el('goal-templates').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-template]');
    if (!btn) return;
    const t = GOAL_TEMPLATES[Number(btn.dataset.template)];
    if (!t) return;
    const existing = existingForTemplate(t);
    if (existing && existing.hidden) {
      const ok = await setGoalHidden(existing.id, false);
      if (!ok) return;
      closeModal(el('new-metric-modal'));
      activeMetricId = existing.id;
      TrackerStorage.setActiveMetricId(existing.id);
      await loadData();
      showStatus('"' + existing.name + '" is back on your board, with everything you logged before.', 'ok');
      return;
    }
    el('new-metric-name').value = t.name;
    el('new-metric-unit').value = t.unit;
    el('new-metric-goal').value = String(t.goal);
    setUnitChips(t.unit);
    newGoalDraft.icon = t.icon;
    newGoalDraft.color = t.color;
    buildIconPicker(el('new-metric-icons'), t.icon, k => { newGoalDraft.icon = k; });
    buildColorPicker(el('color-palette'), t.color, c => { newGoalDraft.color = c; });
    el('new-metric-goal').focus();
  });

  // "What are you counting?" suggestions fill the field in one tap.
  el('unit-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-unit]');
    if (!chip) return;
    el('new-metric-unit').value = chip.dataset.unit;
    setUnitChips(chip.dataset.unit);
  });
  el('new-metric-unit').addEventListener('input', () => setUnitChips(el('new-metric-unit').value.trim()));

  el('new-metric-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('new-metric-name').value.trim();
    const unit = el('new-metric-unit').value.trim() || 'times';
    const dailyGoal = parseInt(el('new-metric-goal').value, 10) || 3;
    if (!name) {
      showStatus('Give the goal a name first, like "Networking chats".', 'error');
      el('new-metric-name').focus();
      return;
    }
    let created;
    try {
      created = await TrackerStorage.addMetric({ name, color: newGoalDraft.color, unit, dailyGoal, icon: newGoalDraft.icon });
    } catch (err) {
      oops('That goal could not be added just now. Please try again.', err);
      return;
    }
    activeMetricId = created.id;
    TrackerStorage.setActiveMetricId(created.id);
    closeModal(el('new-metric-modal'));
    markSetup('goal');
    showStatus('Goal "' + created.name + '" added. Tap + whenever you do one.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  // ----- Hide / show ---------------------------------------------------------
  // Returns true when the change stuck. Refuses to hide the last goal on the
  // board, and says why.
  async function setGoalHidden(id, hidden) {
    if (typeof TrackerStorage.setMetricHidden !== 'function') {
      showStatus('This version of LIT cannot hide goals yet.', 'error');
      return false;
    }
    let ok = false;
    try {
      ok = await TrackerStorage.setMetricHidden(id, hidden);
    } catch (err) {
      oops('That goal could not be changed just now. Please try again.', err);
      return false;
    }
    if (!ok) {
      const msg = 'Keep at least one goal on your board. Add or show another goal first.';
      showStatus(msg, 'error');
      if (el('goal-manager-note')) el('goal-manager-note').textContent = msg;
      return false;
    }
    if (hidden && activeMetricId === id) {
      const next = metrics.find(m => !m.hidden && m.id !== id);
      if (next) { activeMetricId = next.id; TrackerStorage.setActiveMetricId(next.id); }
    }
    notifyCalendarTabs();
    return true;
  }

  // ----- Edit a goal ---------------------------------------------------------
  const editDraft = { icon: 'target', color: GOAL_COLORS[0][0] };

  function openMetricSettings(metricId, focusId, fromSettings) {
    const current = metricById(metricId || activeMetricId);
    if (!current) return;
    settingsMetricId = current.id;
    metricDeleteArmed = false;
    metricEditFromSettings = !!fromSettings;
    el('metric-settings-title').textContent = 'Edit ' + current.name;
    el('metric-settings-name').value = current.name;
    el('metric-settings-unit').value = current.id === 'jobs' && (!current.unit || current.unit === 'jobs' || current.unit === 'items') ? 'applications' : (current.unit || '');
    el('metric-settings-goal').value = goalFor(current);
    el('metric-settings-weekly').value = current.weeklyGoal > 0 ? current.weeklyGoal : '';
    editDraft.icon = iconKey(current);
    editDraft.color = current.color || GOAL_COLORS[0][0];
    buildIconPicker(el('metric-settings-icons'), editDraft.icon, k => { editDraft.icon = k; });
    buildColorPicker(el('metric-settings-colors'), editDraft.color, c => { editDraft.color = c; });

    const hideBtn = el('hide-metric-btn');
    const lastVisible = !current.hidden && metrics.filter(m => !m.hidden).length <= 1;
    hideBtn.textContent = current.hidden ? 'Show on my board' : 'Hide from my board';
    hideBtn.disabled = lastVisible;
    hideBtn.title = lastVisible
      ? 'This is your only goal on the board. Add or show another goal before hiding it.'
      : (current.hidden ? 'Puts the tab back and turns auto-logging on again.' : 'Takes the tab off your board and pauses auto-logging. Nothing you logged is deleted.');

    const deleteBtn = el('delete-metric-btn');
    deleteBtn.textContent = 'Delete goal';
    deleteBtn.classList.remove('armed');
    deleteBtn.classList.toggle('hidden', isBuiltInMetric(current));
    el('metric-settings-hint').textContent = isBuiltInMetric(current)
      ? 'Built-in goals can be renamed or hidden. Their history always stays safe.'
      : 'Pick a number you can hit on a normal day. You can change it any time.';
    openModal(el('metric-settings-modal'), focusId || 'metric-settings-goal');
  }

  function finishMetricEdit() {
    closeModal(el('metric-settings-modal'));
    if (metricEditFromSettings) {
      metricEditFromSettings = false;
      openSettings('goals-group');
    }
  }

  el('metric-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('metric-settings-name').value.trim();
    const unit = el('metric-settings-unit').value.trim();
    const goal = parseInt(el('metric-settings-goal').value, 10);
    const weekly = parseInt(el('metric-settings-weekly').value, 10) || 0;
    if (!name) {
      showStatus('Give the goal a name.', 'error');
      el('metric-settings-name').focus();
      return;
    }
    if (!goal || goal < 1) {
      showStatus('Pick a daily number of 1 or more.', 'error');
      el('metric-settings-goal').focus();
      return;
    }
    const current = metricById(settingsMetricId);
    try {
      if (current && typeof TrackerStorage.updateMetric === 'function') {
        const patch = {};
        if (name !== current.name) patch.name = name;
        if (unit && unit !== current.unit) patch.unit = unit;
        if (editDraft.color && editDraft.color !== current.color) patch.color = editDraft.color;
        if (editDraft.icon && editDraft.icon !== iconKey(current)) patch.icon = editDraft.icon;
        if (Object.keys(patch).length) await TrackerStorage.updateMetric(settingsMetricId, patch);
      }
      await TrackerStorage.setMetricGoal(settingsMetricId, goal);
      await TrackerStorage.setMetricWeeklyGoal(settingsMetricId, Math.max(0, weekly));
    } catch (err) {
      oops('Your changes did not save. Please try again.', err);
      return;
    }
    finishMetricEdit();
    markSetup('goal');
    showStatus('Saved. ' + name + ': ' + goal + ' a day' + (weekly > 0 ? ' and ' + weekly + ' a week' : '') + '.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  el('hide-metric-btn').addEventListener('click', async () => {
    const current = metricById(settingsMetricId);
    if (!current) return;
    const hiding = !current.hidden;
    const ok = await setGoalHidden(current.id, hiding);
    if (!ok) return;
    finishMetricEdit();
    await loadData();
    showStatus(hiding
      ? '"' + current.name + '" is hidden. Everything you logged is kept.'
      : '"' + current.name + '" is back on your board.', 'ok', hiding ? {
      label: 'Undo',
      run: async () => { if (await setGoalHidden(current.id, false)) await loadData(); }
    } : null);
  });

  el('delete-metric-btn').addEventListener('click', async () => {
    const btn = el('delete-metric-btn');
    if (!metricDeleteArmed) {
      metricDeleteArmed = true;
      btn.textContent = 'Yes, delete this goal';
      btn.classList.add('armed');
      return;
    }
    const removedGoal = metricById(settingsMetricId);
    let removed = false;
    try {
      removed = await TrackerStorage.deleteMetric(settingsMetricId);
    } catch (err) {
      oops('That goal could not be deleted just now. Please try again.', err);
      return;
    }
    metricDeleteArmed = false;
    if (!removed) {
      showStatus('That goal could not be deleted. It may already be gone.', 'error');
      return;
    }
    if (activeMetricId === settingsMetricId) {
      const next = metrics.find(m => !m.hidden && m.id !== settingsMetricId) || metrics[0];
      activeMetricId = next ? next.id : 'jobs';
      TrackerStorage.setActiveMetricId(activeMetricId);
    }
    settingsMetricId = null;
    finishMetricEdit();
    notifyCalendarTabs();
    await loadData();
    // Entries keep pointing at the goal's id, so bringing the goal back with
    // the same id brings its history back too.
    showStatus('"' + (removedGoal ? removedGoal.name : 'Goal') + '" deleted.', 'ok', removedGoal ? {
      label: 'Undo',
      run: async () => {
        try {
          await TrackerStorage.importMetrics([removedGoal]);
        } catch (err) {
          oops('That goal could not come back just now.', err);
          return;
        }
        notifyCalendarTabs();
        await loadData();
        showStatus('"' + removedGoal.name + '" is back, with everything you logged.', 'ok');
      }
    } : null);
  });

  el('close-settings-modal').addEventListener('click', finishMetricEdit);
  el('cancel-settings-btn').addEventListener('click', finishMetricEdit);

  // Double-click or right-click a tab to edit that goal.
  el('metric-tabs').addEventListener('dblclick', (e) => {
    const tab = e.target.closest('.tab-item');
    if (tab) openMetricSettings(tab.dataset.metricId, 'metric-settings-name');
  });
  el('metric-tabs').addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.tab-item');
    if (!tab) return;
    e.preventDefault();
    openMetricSettings(tab.dataset.metricId, 'metric-settings-name');
  });

  // ----- Settings: Your goals ------------------------------------------------
  const EYE_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true" focusable="false"><path d="M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="10" cy="10" r="2.4" stroke="currentColor" stroke-width="1.6"/></svg>';
  const EYE_OFF_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true" focusable="false"><path d="M3 3l14 14M8.3 4.8A8 8 0 0 1 10 4.5c5 0 8 5.5 8 5.5a14 14 0 0 1-2.4 3M5.6 6.3C3.3 7.8 2 10 2 10s3 5.5 8 5.5c1.3 0 2.4-.3 3.4-.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const PENCIL_SVG = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" aria-hidden="true" focusable="false"><path d="M12.8 3.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L7.5 16H4v-3.5l8.8-8.8Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const UP_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 7.5 6 4l3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const DOWN_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function goalToolBtn(cls, svg, label, data) {
    const b = make('button', 'tool-btn ' + cls);
    b.type = 'button';
    b.innerHTML = svg;
    b.setAttribute('aria-label', label);
    b.title = label;
    Object.keys(data).forEach(k => { b.dataset[k] = data[k]; });
    return b;
  }

  function renderGoalManager() {
    const list = el('goal-manager');
    if (!list) return;
    list.textContent = '';
    const shownCount = metrics.filter(m => !m.hidden).length;
    metrics.forEach((m, i) => {
      const li = make('li', 'goal-row' + (m.hidden ? ' is-hidden' : ''));
      li.dataset.metricId = m.id;
      const icon = make('span', 'goal-row-icon');
      icon.style.color = m.color;
      icon.innerHTML = iconFor(m);
      li.appendChild(icon);
      const text = make('div', 'goal-row-text');
      text.appendChild(make('span', 'goal-row-name', m.name));
      const g = goalFor(m);
      text.appendChild(make('span', 'goal-row-meta', m.hidden ? 'Hidden, history kept' : g + ' ' + displayUnit(m, g) + ' a day'));
      li.appendChild(text);
      const actions = make('div', 'goal-row-actions');
      const up = goalToolBtn('goal-up', UP_SVG, 'Move ' + m.name + ' left in the tabs', { goalMove: '-1' });
      up.disabled = i === 0;
      const down = goalToolBtn('goal-down', DOWN_SVG, 'Move ' + m.name + ' right in the tabs', { goalMove: '1' });
      down.disabled = i === metrics.length - 1;
      const eye = goalToolBtn('goal-eye', m.hidden ? EYE_OFF_SVG : EYE_SVG, m.hidden ? 'Show ' + m.name + ' on my board' : 'Hide ' + m.name + ' from my board', { goalToggle: '1' });
      eye.setAttribute('aria-pressed', m.hidden ? 'false' : 'true');
      if (!m.hidden && shownCount <= 1) {
        eye.disabled = true;
        eye.title = 'Your only goal on the board stays visible.';
      }
      const edit = goalToolBtn('goal-edit-row', PENCIL_SVG, 'Edit ' + m.name, { goalEdit: '1' });
      [up, down, eye, edit].forEach(b => actions.appendChild(b));
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  el('goal-manager').addEventListener('click', async (e) => {
    const row = e.target.closest('.goal-row');
    const btn = e.target.closest('button');
    if (!row || !btn || btn.disabled) return;
    const id = row.dataset.metricId;
    el('goal-manager-note').textContent = '';
    if (btn.dataset.goalEdit) {
      closeModal(el('settings-modal'));
      openMetricSettings(id, 'metric-settings-name', true);
      return;
    }
    if (btn.dataset.goalToggle) {
      const m = metricById(id);
      if (!m) return;
      if (await setGoalHidden(id, !m.hidden)) {
        await loadData();
        renderGoalManager();
        el('goal-manager-note').textContent = m.hidden ? m.name + ' is back on your board.' : m.name + ' is hidden. Its history is kept.';
      }
      return;
    }
    if (btn.dataset.goalMove) {
      if (typeof TrackerStorage.reorderMetrics !== 'function') return;
      const ids = metrics.map(m => m.id);
      const from = ids.indexOf(id);
      const to = from + Number(btn.dataset.goalMove);
      if (from < 0 || to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      try {
        await TrackerStorage.reorderMetrics(ids);
      } catch (err) {
        oops('The new order did not save. Please try again.', err);
        return;
      }
      notifyCalendarTabs();
      await loadData();
      renderGoalManager();
      const moved = el('goal-manager').querySelector('[data-metric-id="' + CSS.escape(id) + '"] [data-goal-move="' + btn.dataset.goalMove + '"]');
      if (moved && !moved.disabled) moved.focus();
    }
  });

  el('settings-add-goal-btn').addEventListener('click', () => {
    closeModal(el('settings-modal'));
    openNewGoal();
  });

  // ---------------------------------------------------------------------------
  // Add details form
  // ---------------------------------------------------------------------------
  let dupConfirmedFor = null;

  function resetDuplicateNote() {
    dupConfirmedFor = null;
    el('dup-note').classList.add('hidden');
    el('details-submit-btn').textContent = 'Save entry';
  }

  el('detail-company').addEventListener('input', () => {
    if (dupConfirmedFor !== null) resetDuplicateNote();
  });

  el('details-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const metricId = el('details-form').dataset.metricId || activeMetricId;
    const company = el('detail-company').value.trim();
    // A repeat application, or another role at the same company, is saved
    // like any other entry.
    let notes = el('detail-notes').value.trim();
    let solveTimeSeconds = 0;
    if (metricId === 'leetcode' && timerState.targetSeconds > 0) {
      const elapsed = getElapsedSeconds();
      if (elapsed > 0) {
        const solveTimeStr = formatSolveTimeString(elapsed);
        notes = notes ? `${notes} (${solveTimeStr})` : solveTimeStr;
        solveTimeSeconds = elapsed;
      }
      await clearTimerAfterLog();
    }
    const url = /^https?:\/\//i.test(notes) ? notes.split(/\s/)[0] : undefined;

    try {
      await TrackerStorage.addLog({
        metricId,
        count: 1,
        company,
        role: el('detail-role').value,
        notes,
        url,
        solveTimeSeconds
      });
    } catch (err) {
      oops('That one did not save. Please try again.', err);
      return;
    }
    notifyCalendarTabs();
    el('detail-company').value = '';
    el('detail-role').value = '';
    el('detail-notes').value = '';
    resetDuplicateNote();
    const savedTo = metricById(metricId);
    showStatus('Saved' + (savedTo ? ' to ' + savedTo.name : '') + '. The form is ready for the next one.', 'ok');
    await loadData();
  });

  // ---------------------------------------------------------------------------
  // Search across all history
  // ---------------------------------------------------------------------------
  const searchInput = el('search-input');
  let searchOpen = false;
  let searchTimer = null;
  let searchToken = 0;
  // The entries on screen, so a deleted one can be put back by Undo.
  const searchLogsById = new Map();

  function openSearch() {
    if (searchOpen) {
      searchInput.focus();
      searchInput.select();
      return;
    }
    searchOpen = true;
    closeProfileMenu();
    el('search-panel').classList.remove('hidden');
    el('main-view').classList.add('hidden');
    searchInput.focus();
    runSearch();
    bridgeEmit('search', { open: true });
  }

  function closeSearch() {
    if (!searchOpen) return;
    searchOpen = false;
    clearTimeout(searchTimer);
    el('search-panel').classList.add('hidden');
    el('main-view').classList.remove('hidden');
    searchInput.value = '';
    el('search-results').textContent = '';
    el('search-btn').focus();
    requestAnimationFrame(() => moveTabIndicator(false));
    bridgeEmit('search', { open: false });
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Wraps every search word in <mark>, building nodes rather than HTML so an
  // entry's text is never parsed as markup.
  function highlightInto(node, text, tokens) {
    node.textContent = '';
    const str = String(text || '');
    if (!tokens || !tokens.length) {
      node.textContent = str;
      return;
    }
    const re = new RegExp(tokens.map(escapeRegExp).join('|'), 'gi');
    let last = 0;
    let m;
    while ((m = re.exec(str)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      if (m.index > last) node.appendChild(document.createTextNode(str.slice(last, m.index)));
      node.appendChild(make('mark', '', m[0]));
      last = m.index + m[0].length;
    }
    if (last < str.length) node.appendChild(document.createTextNode(str.slice(last)));
  }

  async function runSearch() {
    const q = searchInput.value.trim();
    const meta = el('search-meta');
    const results = el('search-results');
    const token = ++searchToken;
    if (!q) {
      results.textContent = '';
      const total = (stats && stats.totalLogs) || 0;
      meta.textContent = total ? 'Search all ' + total + ' by company, role, notes, stage, or goal.' : coach('empty', ['logs'], 'Nothing here yet.');
      results.appendChild(searchSuggestions('Try a stage'));
      return;
    }
    let res;
    try {
      res = await TrackerStorage.searchLogs(q, { limit: 60 });
    } catch (err) {
      console.warn('[LIT] search failed', err);
      meta.textContent = 'Search is not working just now. Close it and try again.';
      return;
    }
    if (token !== searchToken || !searchOpen) return;
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    meta.textContent = res.total === 0
      ? coach('empty', ['search'], 'Nothing matches "' + q + '".')
      : res.total + (res.total === 1 ? ' match' : ' matches') + (res.total > res.results.length ? ', showing the newest ' + res.results.length : '');
    results.textContent = '';
    searchLogsById.clear();
    res.results.forEach(log => searchLogsById.set(log.id, log));
    res.results.forEach((log, i) => results.appendChild(entryRow(log, { tokens, showTracker: true, showNotes: true, deletable: true, delay: i })));
    if (res.total === 0) results.appendChild(searchSuggestions('Search by stage instead'));
  }

  // Starting points for an empty search: one-tap queries for each stage
  // past Applied.
  function searchSuggestions(lead) {
    const li = make('li', 'search-suggest');
    li.appendChild(make('span', 'search-suggest-lead', lead));
    STATUSES.filter(s => s.id !== 'applied').forEach(s => {
      const b = make('button', 'search-suggest-btn stage-' + s.id);
      b.type = 'button';
      b.dataset.suggest = s.label;
      b.appendChild(make('i'));
      b.appendChild(document.createTextNode(s.label));
      li.appendChild(b);
    });
    return li;
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 120);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  });

  el('search-btn').addEventListener('click', () => (searchOpen ? closeSearch() : openSearch()));
  el('search-close-btn').addEventListener('click', closeSearch);

  // Delete (two-step) and stage changes from a search result.
  const deleteArms = new Map();
  el('search-results').addEventListener('click', async (e) => {
    const suggest = e.target.closest('[data-suggest]');
    if (suggest) {
      searchInput.value = suggest.dataset.suggest;
      searchInput.focus();
      runSearch();
      return;
    }
    const pill = e.target.closest('.status-pill');
    if (pill) {
      openStatusPicker(pill);
      return;
    }
    const del = e.target.closest('.del-btn');
    if (!del) return;
    const id = del.dataset.deleteId;
    // First press turns the icon into a labeled "Delete entry" button for a
    // few seconds; only a second press on it deletes.
    if (!deleteArms.has(id)) {
      del.classList.add('armed');
      del.textContent = 'Delete entry';
      del.title = 'Tap again to delete';
      del.setAttribute('aria-label', 'Yes, delete this entry');
      deleteArms.set(id, setTimeout(() => {
        deleteArms.delete(id);
        del.classList.remove('armed');
        del.innerHTML = X_SVG;
        del.title = 'Delete entry';
        del.setAttribute('aria-label', 'Delete this entry');
      }, 4000));
      return;
    }
    clearTimeout(deleteArms.get(id));
    deleteArms.delete(id);
    let removed = false;
    try {
      removed = await TrackerStorage.deleteLog(id);
    } catch (err) {
      oops('That could not be deleted just now. Please try again.', err);
      return;
    }
    if (!removed) {
      showStatus('That entry was already removed.', 'error');
      return;
    }
    const row = del.closest('.entry');
    if (row) row.remove();
    const deleted = searchLogsById.get(id);
    showStatus('Deleted. Your counts and calendar are updated.', 'ok', deleted ? {
      label: 'Undo',
      run: () => restoreEntry(deleted)
    } : null);
    notifyCalendarTabs();
    loadData();
  });

  // Undo for a deleted entry: logs it again with the same content, date, and
  // stage. It comes back as a new entry with a fresh id.
  async function restoreEntry(log) {
    try {
      await TrackerStorage.addLog({
        metricId: log.metricId,
        count: log.count,
        date: log.date,
        company: log.company,
        role: log.role,
        notes: log.notes,
        url: log.url,
        status: log.status,
        solveTimeSeconds: log.solveTimeSeconds,
        source: log.source,
        sourceId: log.sourceId
      });
    } catch (err) {
      oops('That could not be brought back just now. Please add it again.', err);
      return;
    }
    showStatus('Brought back.', 'ok');
    notifyCalendarTabs();
    if (searchOpen) runSearch();
    loadData();
  }

  // "/" or Cmd/Ctrl+F opens search from anywhere in the popup.
  document.addEventListener('keydown', (e) => {
    if (openModalEl || drag) return;
    const active = document.activeElement;
    const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === '/' && !typing) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.key === 'Escape' && searchOpen && !popoverState) {
      e.preventDefault();
      closeSearch();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || activeMetricId !== 'leetcode' || searchOpen) return;
    if (openModalEl) return;
    // Space belongs to whatever control has focus; only claim it when nothing does
    const active = document.activeElement;
    const activeTag = active ? active.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || activeTag === 'button') return;
    if (active && (active.isContentEditable || active.getAttribute('role') === 'button')) return;
    if (!el('leetcode-timer-widget').closest('.widget')) return;
    e.preventDefault();
    toggleTimer();
  });

  // ---------------------------------------------------------------------------
  // Settings sheet
  // ---------------------------------------------------------------------------
  function permissionsApi() {
    return typeof chrome !== 'undefined' && chrome.permissions ? chrome.permissions : null;
  }

  async function renderUniversalSwitch() {
    const perms = permissionsApi();
    let granted = false;
    if (perms) {
      try { granted = await perms.contains({ origins: UNIVERSAL_ORIGINS }); } catch (e) { granted = false; }
    }
    el('universal-switch').setAttribute('aria-checked', prefs.universalTracking && granted ? 'true' : 'false');
  }

  function formatSnapshotDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  async function renderStorageInfo() {
    const info = el('storage-info');
    try {
      const s = await TrackerStorage.getStorageInfo();
      info.textContent = s.logCount.toLocaleString() + (s.logCount === 1 ? ' entry' : ' entries');
      info.title = 'Everything you have logged, on this computer';
    } catch (err) {
      console.warn('[LIT] storage info unavailable', err);
      info.textContent = 'Not available right now';
      info.title = '';
    }
  }

  async function renderSnapshots() {
    const list = el('snapshot-list');
    let snaps = [];
    try {
      snaps = await TrackerStorage.listSnapshots();
    } catch (err) {
      list.textContent = '';
      console.warn('[LIT] backups unavailable', err);
      list.appendChild(make('li', 'snap-empty', 'Your automatic backups could not be listed just now.'));
      return;
    }
    list.textContent = '';
    if (!snaps.length) {
      list.appendChild(make('li', 'snap-empty', 'No backups yet. LIT makes the first one this week.'));
      return;
    }
    snaps.forEach(s => {
      const li = make('li');
      const text = make('div');
      text.appendChild(make('div', '', formatSnapshotDate(s.createdAt)));
      text.appendChild(make('div', 'snap-meta', (s.reason === 'weekly' ? 'Automatic' : 'You made this') + ' · ' + s.logCount + (s.logCount === 1 ? ' entry' : ' entries')));
      li.appendChild(text);
      const actions = make('div', 'snap-actions');
      const restore = make('button', 'link-btn', 'Restore');
      restore.type = 'button';
      restore.dataset.restoreSnapshot = s.id;
      restore.title = 'Adds back anything from this backup that is missing. Nothing you have now is removed or changed.';
      const download = make('button', 'link-btn', 'Download');
      download.type = 'button';
      download.dataset.downloadSnapshot = s.id;
      actions.appendChild(restore);
      actions.appendChild(download);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function openSettings(scrollToId) {
    renderGoalManager();
    renderExportOptions();
    renderModuleSettings();
    if (el('goal-manager-note')) el('goal-manager-note').textContent = '';
    renderAlertToggles();
    renderCoachSettings();
    applyTheme(document.body.classList.contains('pt-dark') ? 'dark' : 'light');
    el('universal-explainer').classList.add('hidden');
    renderUniversalSwitch();
    renderStorageInfo();
    renderSnapshots();
    openModal(el('settings-modal'), 'close-app-settings');
    if (scrollToId && el(scrollToId)) el(scrollToId).scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  // Look and feel, coach voice, going-for line, rest days, tips, sharing.
  function renderCoachSettings() {
    const accent = accentId();
    el('accent-swatches').querySelectorAll('[data-accent-value]').forEach(b => {
      b.setAttribute('aria-checked', b.dataset.accentValue === accent ? 'true' : 'false');
      b.tabIndex = b.dataset.accentValue === accent ? 0 : -1;
    });
    el('comfort-switch').setAttribute('aria-checked', prefs.comfortMode ? 'true' : 'false');
    el('buddy-switch').setAttribute('aria-checked', prefs.buddyEnabled !== false ? 'true' : 'false');
    el('water-switch').setAttribute('aria-checked', prefs.waterReminder !== false ? 'true' : 'false');
    if (document.activeElement !== el('buddy-name-input')) el('buddy-name-input').value = prefs.buddyName || 'Lockie';
    el('buddy-break-select').value = String(prefs.breakReminderMin === undefined ? 60 : prefs.breakReminderMin);
    ['buddy-name-input', 'buddy-break-select', 'water-switch'].forEach(id => { el(id).disabled = prefs.buddyEnabled === false; });
    const style = prefs.themeStyle || 'warm';
    el('style-picker').querySelectorAll('[data-style-value]').forEach(b => {
      const on = b.dataset.styleValue === style;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    // Seasonal and Arcade bring their own color; the accent picker rests.
    const ownColor = style === 'seasonal' || style === 'arcade';
    el('accent-row').classList.toggle('is-muted', ownColor);
    el('accent-row').title = ownColor ? 'This style picks its own color.' : '';
    el('voice-segmented').querySelectorAll('[data-voice]').forEach(b => {
      b.setAttribute('aria-checked', b.dataset.voice === voice() ? 'true' : 'false');
    });
    const input = el('going-for-input');
    if (document.activeElement !== input) input.value = prefs.goingFor || '';
    const rest = Array.isArray(prefs.restDays) ? prefs.restDays : [];
    el('rest-days').querySelectorAll('[data-day]').forEach(b => {
      b.setAttribute('aria-pressed', rest.includes(Number(b.dataset.day)) ? 'true' : 'false');
    });
    el('tips-switch').setAttribute('aria-checked', prefs.tipsOff ? 'false' : 'true');
    el('share-privacy-switch').setAttribute('aria-checked', prefs.shareHideCompanies === false ? 'false' : 'true');
  }

  el('accent-swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent-value]');
    if (b && b.dataset.accentValue !== accentId()) setPref({ accent: b.dataset.accentValue });
  });
  // Arrow keys move through the swatches like any radio group.
  el('accent-swatches').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = ACCENTS.indexOf(accentId());
    const next = ACCENTS[(i + step + ACCENTS.length) % ACCENTS.length];
    setPref({ accent: next }).then(() => {
      const btn = el('accent-swatches').querySelector('[data-accent-value="' + next + '"]');
      if (btn) btn.focus();
    });
  });
  const STYLE_NAMES = { warm: 'Warm', soft: 'Soft', contrast: 'High contrast', seasonal: 'Seasonal', arcade: 'Arcade' };
  el('style-picker').addEventListener('click', (e) => {
    const b = e.target.closest('[data-style-value]');
    if (!b || b.dataset.styleValue === (prefs.themeStyle || 'warm')) return;
    const v = b.dataset.styleValue;
    setPref({ themeStyle: v }, STYLE_NAMES[v] + ' style on.' + (v === 'seasonal' ? ' It changes with the season.' : ''));
  });
  el('style-picker').addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const order = Object.keys(STYLE_NAMES);
    const i = order.indexOf(prefs.themeStyle || 'warm');
    const next = order[(i + step + order.length) % order.length];
    setPref({ themeStyle: next }).then(() => {
      const btn = el('style-picker').querySelector('[data-style-value="' + next + '"]');
      if (btn) btn.focus();
    });
  });
  el('comfort-switch').addEventListener('click', () => setPref({ comfortMode: !prefs.comfortMode }, prefs.comfortMode ? 'Comfort mode off.' : 'Comfort mode on: bigger text and buttons.'));
  el('voice-segmented').addEventListener('click', (e) => {
    const b = e.target.closest('[data-voice]');
    if (!b || b.dataset.voice === voice()) return;
    const sample = { gentle: 'Gentle voice: soft and encouraging.', coach: 'Coach voice: warm and direct.', drill: 'Drill voice: short and firm, never rude.' };
    setPref({ coachVoice: b.dataset.voice }, sample[b.dataset.voice]);
  });
  el('buddy-switch').addEventListener('click', () => {
    const on = prefs.buddyEnabled === false;
    setPref({ buddyEnabled: on }, on ? (prefs.buddyName || 'Lockie') + ' is back.' : (prefs.buddyName || 'Lockie') + ' is taking a rest. Turn it back on any time.');
  });
  el('water-switch').addEventListener('click', () => setPref({ waterReminder: prefs.waterReminder === false }, prefs.waterReminder === false ? 'Water reminders on.' : 'Water reminders off.'));
  el('buddy-break-select').addEventListener('change', () => {
    const v = parseInt(el('buddy-break-select').value, 10) || 0;
    setPref({ breakReminderMin: v }, v ? 'Break reminders after ' + LitBuddy.durationText(v) + ' of applying.' : 'Break reminders off.');
  });
  el('buddy-name-input').addEventListener('change', () => {
    const v = el('buddy-name-input').value.replace(/\s+/g, ' ').trim().slice(0, 20) || 'Lockie';
    if (v === (prefs.buddyName || 'Lockie')) return;
    setPref({ buddyName: v }, 'Say hi to ' + v + '.');
  });
  el('buddy-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  el('going-for-input').addEventListener('change', () => {
    const value = el('going-for-input').value.trim().slice(0, 80);
    if (value === (prefs.goingFor || '')) return;
    setPref({ goingFor: value }, value ? 'Saved. It shows under your count.' : 'Going-for line cleared.');
  });
  el('going-for-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  });
  el('rest-days').addEventListener('click', (e) => {
    const b = e.target.closest('[data-day]');
    if (!b) return;
    const day = Number(b.dataset.day);
    const rest = new Set(Array.isArray(prefs.restDays) ? prefs.restDays : []);
    if (rest.has(day)) rest.delete(day); else rest.add(day);
    const list = Array.from(rest).sort((x, y) => x - y);
    setPref({ restDays: list }, list.length ? 'Rest days saved. They never break your streak.' : 'No rest days. Every day counts toward your streak.')
      .then(() => loadData());
  });
  el('tips-switch').addEventListener('click', () => setPref({ tipsOff: !prefs.tipsOff }, prefs.tipsOff ? 'Daily tips on.' : 'Daily tips off.'));
  el('share-privacy-switch').addEventListener('click', () => {
    const next = prefs.shareHideCompanies === false;
    setPref({ shareHideCompanies: next }, next ? 'Share cards leave out your going-for line.' : 'Share cards can include your going-for line. Company names are still never included.');
  });

  el('close-app-settings').addEventListener('click', () => closeModal(el('settings-modal')));

  // chrome.permissions.request must run inside the click itself (a user
  // gesture), so nothing is awaited before it. The service worker also turns
  // the setting on when the permission lands, in case Chrome's prompt closes
  // the popup before this resolves.
  // Turning it on first shows a plain-language explainer: what LIT reads,
  // what it never does. Only Continue (a fresh click, so still a user
  // gesture) asks Chrome for the permission.
  el('universal-switch').addEventListener('click', async () => {
    const perms = permissionsApi();
    const turningOn = el('universal-switch').getAttribute('aria-checked') !== 'true';
    if (!perms) {
      showStatus('This version of Chrome cannot do this. The big job boards are still noticed.', 'error');
      return;
    }
    if (turningOn) {
      el('universal-explainer').classList.remove('hidden');
      el('universal-continue-btn').focus();
      return;
    }
    await setPref({ universalTracking: false }, 'Turned off. LIT still notices applications on the big job boards.');
    try { await perms.remove({ origins: UNIVERSAL_ORIGINS }); } catch (e) { /* already removed */ }
    renderUniversalSwitch();
  });

  el('universal-notnow-btn').addEventListener('click', () => {
    el('universal-explainer').classList.add('hidden');
    el('universal-switch').focus();
  });

  el('universal-continue-btn').addEventListener('click', async () => {
    const perms = permissionsApi();
    if (!perms) return;
    let granted = false;
    try {
      granted = await perms.request({ origins: UNIVERSAL_ORIGINS });
    } catch (err) {
      granted = false;
    }
    el('universal-explainer').classList.add('hidden');
    if (!granted) {
      showStatus('No problem. This stays off, and the big job boards are still noticed.');
      renderUniversalSwitch();
      return;
    }
    await setPref({ universalTracking: true }, 'On. LIT will notice applications on company careers pages you open from now on.');
    renderUniversalSwitch();
  });

  el('backup-btn').addEventListener('click', () => exportData('json', 'lit-backup'));
  el('restore-btn').addEventListener('click', () => el('restore-input').click());

  function restoreMessage(r) {
    const parts = ['Restored ' + r.added + (r.added === 1 ? ' entry' : ' entries')];
    if (r.skipped) parts.push(r.skipped + ' already here');
    if (r.invalid) parts.push(r.invalid + ' unreadable');
    if (r.metricsAdded) parts.push(r.metricsAdded + (r.metricsAdded === 1 ? ' goal added' : ' goals added'));
    return parts.join(', ') + '.';
  }

  el('restore-input').addEventListener('change', async () => {
    const input = el('restore-input');
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    let result;
    try {
      result = await TrackerStorage.importBackup(await file.text());
    } catch (err) {
      oops('That file could not be restored. Make sure it is a LIT backup file.', err);
      return;
    }
    showStatus(restoreMessage(result), 'ok');
    notifyCalendarTabs();
    renderStorageInfo();
    await loadData();
  });

  // ----- Export to Google Sheets, Notion, or a CSV file ------------------------
  // No sign-in needed: Sheets and Notion both turn a pasted table into rows.
  function renderExportOptions() {
    const sel = el('export-goal');
    const was = sel.value || 'all';
    sel.textContent = '';
    const all = make('option', '', 'All goals');
    all.value = 'all';
    sel.appendChild(all);
    metrics.forEach(m => {
      const o = make('option', '', m.name + (m.hidden ? ' (hidden)' : ''));
      o.value = m.id;
      sel.appendChild(o);
    });
    sel.value = Array.from(sel.options).some(o => o.value === was) ? was : 'all';
    el('export-hint').textContent = 'Google Sheets opens a blank sheet: click cell A1 and paste. In Notion, paste into any page, or use Import, then CSV, for a database.';
  }

  async function exportRows() {
    const names = {};
    metrics.forEach(m => { names[m.id] = m.name; });
    const logs = await TrackerStorage.getLogs({});
    const rows = LitExport.filterLogs(logs, { metricId: el('export-goal').value, days: el('export-range').value, today: todayStr() });
    return { rows, names };
  }

  function exportLabel() {
    const goal = el('export-goal');
    const range = el('export-range');
    return goal.options[goal.selectedIndex].text + ', ' + range.options[range.selectedIndex].text.toLowerCase();
  }

  el('export-sheets-btn').addEventListener('click', async () => {
    let data;
    try { data = await exportRows(); } catch (err) { oops('Your entries could not be read just now.', err); return; }
    if (!data.rows.length) { el('export-hint').textContent = 'Nothing logged for ' + exportLabel() + ' yet.'; return; }
    const copied = await copyText(LitExport.buildTsv(data.rows, data.names));
    if (!copied) { el('export-hint').textContent = 'Copying is blocked here. Use Download CSV instead.'; return; }
    el('export-hint').textContent = 'Copied ' + data.rows.length + ' rows. In the new sheet, click cell A1 and paste.';
    if (chrome.tabs) chrome.tabs.create({ url: 'https://sheets.new' });
  });

  el('export-notion-btn').addEventListener('click', async () => {
    let data;
    try { data = await exportRows(); } catch (err) { oops('Your entries could not be read just now.', err); return; }
    if (!data.rows.length) { el('export-hint').textContent = 'Nothing logged for ' + exportLabel() + ' yet.'; return; }
    const copied = await copyText(LitExport.buildMarkdown(data.rows, data.names, { title: 'LIT: ' + exportLabel() }));
    el('export-hint').textContent = copied
      ? 'Copied ' + data.rows.length + ' rows. Paste into any Notion page and it becomes a table.'
      : 'Copying is blocked here. Use Download CSV and import it into Notion.';
  });

  el('export-csv-btn').addEventListener('click', async () => {
    let data;
    try { data = await exportRows(); } catch (err) { oops('Your entries could not be read just now.', err); return; }
    if (!data.rows.length) { el('export-hint').textContent = 'Nothing logged for ' + exportLabel() + ' yet.'; return; }
    const filename = LitExport.backupFilename('lit-export', 'csv');
    if (downloadText(filename, LitExport.buildCsv(data.rows, data.names), 'text/csv')) {
      el('export-hint').textContent = 'Saved ' + data.rows.length + ' rows to ' + filename + '. Open it in Excel or Numbers, or import it into Notion.';
    } else {
      el('export-hint').textContent = 'Chrome blocked the download. Try Copy for Google Sheets instead.';
    }
  });

  el('settings-modal').addEventListener('click', async (e) => {
    const exportBtn = e.target.closest('[data-export]');
    if (exportBtn) {
      exportData(exportBtn.dataset.export);
      return;
    }
    const restore = e.target.closest('[data-restore-snapshot]');
    if (restore) {
      let result;
      try {
        result = await TrackerStorage.restoreSnapshot(restore.dataset.restoreSnapshot);
      } catch (err) {
        oops('That backup could not be restored just now. Please try again.', err);
        return;
      }
      showStatus(restoreMessage(result), 'ok');
      notifyCalendarTabs();
      renderStorageInfo();
      await loadData();
      return;
    }
    const download = e.target.closest('[data-download-snapshot]');
    if (download) {
      const snap = await TrackerStorage.getSnapshot(download.dataset.downloadSnapshot);
      if (!snap) {
        showStatus('That backup is no longer on this computer.', 'error');
        renderSnapshots();
        return;
      }
      const name = 'lit-snapshot-' + snap.createdAt.slice(0, 10) + '.json';
      if (downloadText(name, JSON.stringify(snap, null, 2), 'application/json')) showStatus('Saved ' + name + '.', 'ok');
    }
  });

  el('snapshot-now-btn').addEventListener('click', async () => {
    try {
      await TrackerStorage.createSnapshot({ reason: 'manual' });
    } catch (err) {
      oops('The backup could not be made just now. Please try again.', err);
      return;
    }
    showStatus('Backup saved on this computer. LIT keeps the four newest.', 'ok');
    renderSnapshots();
  });

  el('shortcuts-link').addEventListener('click', () => {
    if (chrome.tabs) chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  function openAutofillProfile() {
    markSetup('autofill');
    if (chrome.tabs) chrome.tabs.create({ url: chrome.runtime.getURL('options/autofill.html') });
  }
  el('autofill-profile-btn').addEventListener('click', openAutofillProfile);

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------
  function downloadText(filename, text, mimeType) {
    try {
      const blob = new Blob([text], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      // Fall through to the textarea copy.
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch (err) {
      return false;
    }
  }

  async function exportData(format, prefix) {
    const names = {};
    metrics.forEach(m => { names[m.id] = m.name; });
    let text;
    let filename;
    let count;
    try {
      if (format === 'json') {
        const backup = await TrackerStorage.exportBackup();
        count = backup.logs.length;
        text = JSON.stringify(backup, null, 2);
        filename = LitExport.backupFilename(prefix || 'lit-tracker', 'json');
      } else if (format === 'csv') {
        const logs = (await TrackerStorage.getLogs({})).slice().reverse();
        count = logs.length;
        text = LitExport.buildCsv(logs, names);
        filename = LitExport.backupFilename('lit-tracker', 'csv');
      } else {
        const metric = metricById(activeMetricId);
        const logs = await TrackerStorage.getLogs({ metricId: activeMetricId });
        count = logs.length;
        if (!count) {
          showStatus('Nothing logged for ' + metric.name + ' yet, so there is no summary to copy.');
          return;
        }
        text = LitExport.buildMarkdown(logs, names, { title: metric.name + ' (' + count + ')' });
        const copied = await copyText(text);
        showStatus(copied
          ? 'Copied a summary of ' + count + ' ' + metric.name + ' entries. Paste it anywhere.'
          : 'Copying is blocked here. Try again from the menu.', copied ? 'ok' : 'error');
        return;
      }
    } catch (err) {
      oops('That download did not work just now. Please try again.', err);
      return;
    }
    if (!count) {
      showStatus('Nothing to download yet. Log your first one and try again.');
      return;
    }
    if (downloadText(filename, text, format === 'csv' ? 'text/csv' : 'application/json')) {
      showStatus((format === 'json' ? 'Backup saved' : 'Spreadsheet saved') + ' with ' + count + (count === 1 ? ' entry' : ' entries') + ': ' + filename + '.', 'ok');
      return;
    }
    const copied = await copyText(text);
    showStatus(copied
      ? 'Chrome blocked the download, so it was copied to your clipboard instead.'
      : 'Chrome blocked the download. Please try again.', copied ? 'ok' : 'error');
  }

  // ---------------------------------------------------------------------------
  // Footer
  // ---------------------------------------------------------------------------
  el('open-calendar-btn').addEventListener('click', openCalendar);

  // Opening the popup grants activeTab, so the worker can read the page in
  // the current tab and show the quick-log card there.
  el('log-page-btn').addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'PT_LOG_FROM_TAB' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          showStatus('LIT could not read this page. Open a job posting or application, then try again.', 'error');
          return;
        }
        window.close();
      });
    } catch (err) {
      oops('LIT could not reach that page. Close the popup and try again.', err);
    }
  });

  // Same grant as Log this page: the worker injects Autofill into this tab
  // even on a site LIT has no standing access to.
  el('autofill-page-btn').addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'PT_AUTOFILL_TAB' }, (res) => {
        if (chrome.runtime.lastError || !res) {
          showStatus('There is no application form to fill here. Open one, then try again.', 'error');
          return;
        }
        // With no form found, the page itself says so.
        window.close();
      });
    } catch (err) {
      oops('LIT could not reach that page. Close the popup and try again.', err);
    }
  });

  // ---------------------------------------------------------------------------
  // First-run setup checklist (new users only, until done or hidden)
  // ---------------------------------------------------------------------------
  const SETUP_STEPS = [
    { id: 'goal', label: 'Pick your goal', run: () => openMetricSettings('jobs') },
    { id: 'autofill', label: 'Fill your autofill profile', run: () => openAutofillProfile() },
    { id: 'calendar', label: 'See your scoreboard on Calendar', run: () => openCalendar() },
    { id: 'checkin', label: 'Choose a daily check-in', optional: true, run: () => openSettings('checkin-group') }
  ];
  const STEP_CHECK = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 6.2l2.2 2.3L9.5 3.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const STEP_GO = '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true" focusable="false"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function setupDone(id) {
    const done = (ui.setup && ui.setup.done) || {};
    if (done[id]) return true;
    if (id === 'goal') return !!prefs.onboardingDone || (Array.isArray(prefs.focusAreas) && prefs.focusAreas.length > 0);
    if (id === 'checkin') return !!prefs.reminderEnabled;
    return false;
  }

  function markSetup(id) {
    const setup = Object.assign({}, ui.setup);
    setup.done = Object.assign({}, setup.done, { [id]: true });
    saveUiState({ setup });
    if (stats) renderSetup();
  }

  // Decided once: someone who already has history never sees the checklist.
  function setupEligible() {
    if (ui.setup && typeof ui.setup.eligible === 'boolean') return ui.setup.eligible;
    if (!stats) return false;
    const eligible = (stats.totalLogs || 0) === 0;
    saveUiState({ setup: Object.assign({}, ui.setup, { eligible }) });
    return eligible;
  }

  function renderSetup() {
    const card = el('first-run-card');
    const doneCount = SETUP_STEPS.filter(s => setupDone(s.id)).length;
    const show = setupEligible() && !(ui.setup && ui.setup.dismissed) && doneCount < SETUP_STEPS.length;
    card.classList.toggle('hidden', !show);
    if (!show) return;
    const list = el('first-run-tips');
    list.textContent = '';
    SETUP_STEPS.forEach(step => {
      const done = setupDone(step.id);
      const li = make('li');
      const btn = make('button', 'setup-item' + (done ? ' done' : ''));
      btn.type = 'button';
      btn.dataset.step = step.id;
      const check = make('span', 'setup-check');
      check.innerHTML = STEP_CHECK;
      btn.appendChild(check);
      const label = make('span', 'setup-label', step.label);
      if (step.optional) label.appendChild(make('span', 'setup-opt', ' (optional)'));
      btn.appendChild(label);
      const go = make('span', 'setup-go');
      go.innerHTML = STEP_GO;
      btn.appendChild(go);
      btn.setAttribute('aria-label', step.label + (step.optional ? ', optional' : '') + (done ? ', done' : ''));
      li.appendChild(btn);
      list.appendChild(li);
    });
    const C = 2 * Math.PI * 15;
    const fill = el('setup-fill');
    fill.style.strokeDasharray = String(C);
    fill.style.strokeDashoffset = String(C * (1 - doneCount / SETUP_STEPS.length));
    el('setup-count').textContent = doneCount + '/' + SETUP_STEPS.length;
    el('setup-title').textContent = doneCount === 0 ? 'Welcome to LIT' : (doneCount === SETUP_STEPS.length - 1 ? 'One step left' : 'Nice progress');
  }

  el('first-run-tips').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-step]');
    if (!btn) return;
    const step = SETUP_STEPS.find(s => s.id === btn.dataset.step);
    if (step) step.run();
  });

  el('setup-dismiss-btn').addEventListener('click', () => {
    saveUiState({ setup: Object.assign({}, ui.setup, { dismissed: true }) });
    if (!prefs.onboardingDone) setPref({ onboardingDone: true });
    renderSetup();
    showStatus('Setup hidden. Everything is in Settings whenever you want it.');
  });

  // ---------------------------------------------------------------------------
  // Daily "Did you know?" tip
  // ---------------------------------------------------------------------------
  function renderTip() {
    const card = el('tip-card');
    const today = todayStr();
    const setupShowing = !el('first-run-card').classList.contains('hidden');
    const tip = coach('tipFor', [today], () => {
      const tips = Coach && Array.isArray(Coach.tips) ? Coach.tips : [];
      return tips.length ? tips[TrackerStorage.daysBetween('2026-01-01', today) % tips.length] : '';
    });
    const show = !prefs.tipsOff && !setupShowing && ui.tipHiddenOn !== today && !!tip;
    card.classList.toggle('hidden', !show);
    if (show) el('tip-body').textContent = tip;
  }

  el('tip-dismiss-btn').addEventListener('click', () => {
    saveUiState({ tipHiddenOn: todayStr() });
    el('tip-card').classList.add('hidden');
  });
  el('tip-off-btn').addEventListener('click', () => {
    setPref({ tipsOff: true }, 'Tips are off. Turn them back on in Settings any time.');
  });

  // ---------------------------------------------------------------------------
  // Milestones: a one-time card with gentle confetti and a Share button
  // ---------------------------------------------------------------------------
  let milestoneShown = null;
  // Runs after each data load, but only does work when the totals or the
  // job stages changed since the last look (the popup stays snappy).
  let milestoneKey = null;
  async function checkMilestones(force) {
    if (!has(TrackerStorage, 'getMilestones') || !metrics.length) return;
    const current = metricById(activeMetricId) || metrics[0];
    const key = current.id + ':' + ((stats && stats.totalLogs) || 0);
    if (!force && key === milestoneKey) return;
    milestoneKey = key;
    const ids = current.id === 'jobs' ? ['jobs'] : [current.id, 'jobs'];
    const token = bumpToken('milestones');
    for (const metricId of ids) {
      let ms;
      try {
        ms = await TrackerStorage.getMilestones(metricId);
      } catch (err) {
        console.warn('[LIT] milestones unavailable', err);
        return;
      }
      if (asyncTokens.milestones !== token) return;
      const unseen = (ms && Array.isArray(ms.unseen)) ? ms.unseen : [];
      if (!unseen.length) continue;
      // Long-time users see every past milestone as unseen at first: show
      // only the biggest one, then mark them all seen so none replays.
      const reached = (ms.reached || []).filter(r => unseen.includes(r.id));
      const numeric = reached.filter(r => typeof r.count === 'number').sort((a, b) => b.count - a.count);
      const interview = reached.find(r => r.id === 'first-interview');
      const best = interview && (!numeric.length || numeric[0].count < 100) ? interview : (numeric[0] || interview);
      if (has(TrackerStorage, 'markMilestonesSeen')) {
        TrackerStorage.markMilestonesSeen(metricId, unseen).catch(err => console.warn('[LIT] could not mark milestones', err));
      }
      if (best) showMilestone(best, metricById(metricId) || current);
      return;
    }
  }

  function showMilestone(m, metric) {
    const unitRaw = metric.id === 'jobs' ? 'applications' : (metric.unit || 'times');
    const copy = m.id === 'first-interview'
      ? coach('firstInterview', [], { title: m.title || 'Your first interview', body: m.body || 'Someone wants to talk. The work is paying off.' })
      : coach('milestone', [m.count, unitRaw], { title: m.title || (m.count + ' ' + displayUnit(metric, m.count)), body: m.body || 'Steady work adds up.' });
    milestoneShown = { milestone: m, metric, title: copy.title || m.title };
    el('milestone-title').textContent = copy.title || m.title || '';
    el('milestone-body').textContent = copy.body || m.body || '';
    const card = el('milestone-card');
    card.classList.remove('hidden');
    rainConfetti(el('milestone-confetti'));
  }

  function rainConfetti(host) {
    host.textContent = '';
    if (reduceMotion) return;
    const colors = ['var(--accent)', 'var(--flame)', 'var(--success)', 'var(--rest)'];
    for (let i = 0; i < 22; i++) {
      const bit = make('i');
      bit.style.setProperty('--x', Math.round(Math.random() * 100) + '%');
      bit.style.setProperty('--d', Math.round(Math.random() * 400) + 'ms');
      bit.style.setProperty('--r', (Math.random() > 0.5 ? 1 : -1) * Math.round(180 + Math.random() * 360) + 'deg');
      bit.style.setProperty('--c', colors[i % colors.length]);
      host.appendChild(bit);
    }
    setTimeout(() => { host.textContent = ''; }, 2200);
  }

  el('milestone-dismiss-btn').addEventListener('click', () => {
    el('milestone-card').classList.add('hidden');
    milestoneShown = null;
  });
  el('milestone-share-btn').addEventListener('click', () => {
    if (!milestoneShown) return;
    const { milestone, metric, title } = milestoneShown;
    const total = (stats.totals && stats.totals[metric.id]) || milestone.count || 0;
    openShare({
      bigNumber: milestone.count || total,
      bigLabel: milestone.count ? displayUnit(metric, milestone.count) + ' sent' : 'first interview',
      milestoneTitle: title,
      metricId: metric.id
    });
  });

  // ---------------------------------------------------------------------------
  // Share sheet (shared/share-card.js). Company names are never passed in.
  // ---------------------------------------------------------------------------
  const ShareCard = typeof LitShareCard !== 'undefined' ? LitShareCard : null;
  let shareContext = null;
  let shareTemplate = 'minimal';
  let shareBlob = null;
  let shareUrl = null;

  function openShare(context) {
    shareContext = context || {};
    shareBlob = null;
    openModal(el('share-modal'), 'share-copy-btn');
    renderSharePreview();
  }

  function clearSharePreview() {
    if (shareUrl) URL.revokeObjectURL(shareUrl);
    shareUrl = null;
    const img = el('share-preview-img');
    img.hidden = true;
    img.removeAttribute('src');
  }

  async function renderSharePreview() {
    el('share-templates').querySelectorAll('[data-template]').forEach(b => {
      b.setAttribute('aria-checked', b.dataset.template === shareTemplate ? 'true' : 'false');
    });
    el('share-copy-btn').disabled = true;
    el('share-save-btn').disabled = true;
    clearSharePreview();
    const note = el('share-preview-note');
    if (!ShareCard || !has(ShareCard, 'render')) {
      note.textContent = 'Sharing is not available in this version yet.';
      return;
    }
    note.textContent = 'Making your card...';
    const metric = metricById(shareContext.metricId) || metricById(activeMetricId) || metrics[0];
    const dark = document.body.classList.contains('pt-dark');
    const hidePersonal = prefs.shareHideCompanies !== false;
    const token = bumpToken('share');
    let blob;
    try {
      blob = await ShareCard.render({
        template: shareTemplate,
        theme: dark ? 'dark' : 'light',
        accent: accentId(),
        bigNumber: shareContext.bigNumber || 0,
        bigLabel: shareContext.bigLabel || '',
        streak: metric ? streakFor(metric) : 0,
        weekDots: lastWeekDots.map(d => ({ date: d.date, state: d.state, count: d.count, goal: d.goal, isToday: d.isToday })),
        goingFor: hidePersonal ? '' : (prefs.goingFor || ''),
        milestoneTitle: shareContext.milestoneTitle || ''
      });
    } catch (err) {
      console.warn('[LIT] share card failed', err);
      if (asyncTokens.share === token) note.textContent = 'The card could not be made just now. Please try again.';
      return;
    }
    if (asyncTokens.share !== token || el('share-modal').classList.contains('hidden')) return;
    shareBlob = blob;
    shareUrl = URL.createObjectURL(blob);
    const img = el('share-preview-img');
    img.src = shareUrl;
    img.alt = 'Preview: ' + (shareContext.bigNumber || 0) + ' ' + (shareContext.bigLabel || '') + ', tracked with LIT';
    img.hidden = false;
    el('share-copy-btn').disabled = false;
    el('share-save-btn').disabled = false;
  }

  el('share-templates').addEventListener('click', (e) => {
    const b = e.target.closest('[data-template]');
    if (!b || b.dataset.template === shareTemplate) return;
    shareTemplate = b.dataset.template;
    renderSharePreview();
  });

  el('share-copy-btn').addEventListener('click', async () => {
    if (!shareBlob || !ShareCard) return;
    const ok = has(ShareCard, 'copy') ? await ShareCard.copy(shareBlob) : false;
    showStatus(ok ? 'Image copied. Paste it into a post or a message.' : 'Copying images is blocked here. Use Save instead.', ok ? 'ok' : 'error');
    if (ok) closeModal(el('share-modal'));
  });

  el('share-save-btn').addEventListener('click', () => {
    if (!shareBlob || !ShareCard) return;
    const ok = has(ShareCard, 'download') ? ShareCard.download(shareBlob, 'lit-progress-' + todayStr() + '.png') : false;
    showStatus(ok ? 'Saved to your Downloads.' : 'Chrome blocked the download. Try Copy image instead.', ok ? 'ok' : 'error');
    if (ok) closeModal(el('share-modal'));
  });

  el('close-share-modal').addEventListener('click', () => closeModal(el('share-modal')));

  // ---------------------------------------------------------------------------
  // Live updates and startup
  // ---------------------------------------------------------------------------
  // Log writes from content scripts and the service worker, sign-in changes,
  // tracker edits, layout edits from another device: one reload each.
  TrackerStorage.onChanged(() => loadData());

  // Alt+Shift+J opens the popup through the worker with a flag to focus search.
  function consumeSearchFlag() {
    if (/[?&]search=1\b/.test(location.search)) return Promise.resolve(true);
    const area = chrome.storage.session || chrome.storage.local;
    return new Promise(resolve => {
      area.get(['pt_open_search_at'], r => {
        const at = r && r.pt_open_search_at;
        if (!Number.isFinite(at)) { resolve(false); return; }
        area.remove('pt_open_search_at', () => resolve(Date.now() - at < 15000));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Settings > Extras: switch rows that popup modules add through
  // LitPopup.addSetting. The group hides when no module adds one.
  // ---------------------------------------------------------------------------
  function renderModuleSettings() {
    const host = el('module-settings');
    if (!host || typeof LitPopup === 'undefined') return;
    const rows = LitPopup.settingRows;
    el('module-settings-group').classList.toggle('hidden', !rows.length);
    host.textContent = '';
    rows.forEach(row => {
      const wrap = make('div', 'setting-row' + (row.hint ? ' setting-row-2line' : ''));
      const label = make('span', 'setting-label', row.label);
      if (row.hint) label.appendChild(make('small', '', row.hint));
      wrap.appendChild(label);
      const sw = make('button', 'switch');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', row.label);
      let on = false;
      try { on = !!row.get(); } catch (e) { on = false; }
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      sw.appendChild(make('span'));
      sw.addEventListener('click', async () => {
        const next = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', next ? 'true' : 'false');
        try { await row.set(next); } catch (err) { oops('That setting did not save. Please try again.', err); }
      });
      wrap.appendChild(sw);
      host.appendChild(wrap);
    });
  }

  async function logForGoal(metricId) {
    const metric = metricById(metricId);
    if (!metric) return false;
    const before = todayFor(metric);
    try {
      await TrackerStorage.addLog({ metricId, count: 1, source: 'manual' });
    } catch (err) {
      oops('That one did not save. Please try again.', err);
      return false;
    }
    buddyCheerSoon = true;
    notifyCalendarTabs();
    await loadData();
    const after = metricById(metricId);
    const count = after ? todayFor(after) : before + 1;
    const goal = goalFor(after || metric);
    bridgeEmit('log', { metric: after || metric, count, goal });
    if (before < goal && count >= goal) {
      showStatus((after || metric).name + ': locked in for today.', 'ok');
      bridgeEmit('goal-met', { metric: after || metric });
    }
    return true;
  }

  // Adds a company to the watchlist; false when empty, a duplicate, or full.
  function addWatchCompany(raw) {
    const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || watchlist.length >= MAX_WATCH) return false;
    const key = TrackerStorage.normalizeCompany(name);
    if (watchlist.some(w => TrackerStorage.normalizeCompany(w.name) === key)) return false;
    watchlist.push({ id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, added: todayStr() });
    saveWatchlist();
    rerenderType('watchlist');
    return true;
  }

  // Brings the watchlist card into view (adding or expanding it first) and
  // focuses its input.
  async function openWatchlistCard() {
    const item = widgetItems.find(i => i.type === 'watchlist');
    if (!item) await applyLayout(WidgetLayout.add('watchlist', {}), 'Companies card added.');
    else if (item.options.collapsed) await applyLayout(WidgetLayout.update(item.id, { collapsed: false }));
    const input = widgetsHost.querySelector('.widget-watchlist .watch-input');
    if (!input) return false;
    input.closest('.widget').scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    input.focus({ preventScroll: true });
    return true;
  }

  // The read-only view and the helpers popup modules get through LitPopup.api.
  if (typeof LitPopup !== 'undefined') {
    LitPopup.attach({
      get metrics() { return metrics.slice(); },
      get visibleMetrics() { return visibleMetrics(); },
      get activeMetric() { return metricById(activeMetricId); },
      get stats() { return stats; },
      get prefs() { return prefs; },
      get widgetItems() { return widgetItems.slice(); },
      get watchlist() { return watchlist.slice(); },
      get buddySession() { return buddySession; },
      get reduceMotion() { return reduceMotion; },
      get isDark() { return document.body.classList.contains('pt-dark'); },
      get openModalId() { return openModalEl ? openModalEl.id : null; },
      make,
      todayStr,
      todayFor,
      goalFor,
      goalMetFor,
      streakFor,
      displayUnit,
      friendlyDate,
      iconFor,
      statusMeta,
      statusOf,
      metricById,
      jobs: () => getJobs().promise,
      showStatus,
      oops,
      coach,
      // +1 on any goal. The active goal goes through the button (timer,
      // ring, burst); another goal logs directly with the same cheer.
      logOne: metricId => {
        if (!metricId || metricId === activeMetricId) { el('quick-add-btn').click(); return Promise.resolve(true); }
        return logForGoal(metricId);
      },
      addWatchCompany: name => addWatchCompany(name),
      openWatchlist: () => openWatchlistCard(),
      undoLast: () => el('undo-btn').click(),
      selectGoal: id => selectTracker(id),
      openShare,
      openSettings,
      openWidgetSettings,
      openModal,
      closeModal,
      openCalendar: () => el('week-calendar-link').click(),
      refresh: () => loadData()
    });
  }

  applyTheme(await TrackerStorage.getTheme());
  if (typeof LitPopup !== 'undefined') await LitPopup.loadModulePrefs();
  try {
    prefs = await TrackerStorage.getPrefs();
  } catch (err) {
    prefs = Object.assign({}, TrackerStorage.PREF_DEFAULTS);
  }
  applyAppearance();
  await loadUiState();
  renderAlertToggles();
  activeMetricId = await TrackerStorage.getActiveMetricId();

  // Closing the popup tears down this script, but the countdown lives on as
  // a deadline in storage (and as a background alarm). Read it back before
  // the first render, and land on the LeetCode tab whenever a countdown is
  // armed, running, paused, or finished so it is visible on reopen.
  await hydrateTimer();
  if (timerState.status !== 'idle' || timerState.targetSeconds > 0) {
    activeMetricId = 'leetcode';
  }

  // One quick token check per popup open: evicts an expired OAuth token and
  // re-prompts, so the user is never shown as signed in against a dead session.
  try {
    await TrackerAuth.ensureValidSession();
  } catch (err) {
    console.warn('Session check skipped:', errMsg(err));
  }

  const focusSearch = await consumeSearchFlag().catch(() => false);
  await loadData();
  if (typeof LitPopup !== 'undefined') LitPopup.markReady();
  if (focusSearch) openSearch();
});
