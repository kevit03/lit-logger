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

  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
  const STATUSES = TrackerStorage.STATUSES;
  const UNIVERSAL_ORIGINS = ['*://*/*'];

  function errMsg(err) {
    return err && err.message ? err.message : 'unknown error';
  }

  // Single transient status / error line, announced via aria-live
  let statusTimer = null;
  function showStatus(message, tone) {
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
    line.classList.remove('hidden');
    if (tone) line.classList.add(tone === 'error' ? 'status-error' : 'status-ok');
    statusTimer = setTimeout(() => {
      line.textContent = '';
      line.classList.add('hidden');
      line.classList.remove('status-error', 'status-ok');
    }, 6000);
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

  function daysAgoText(n) {
    if (n <= 0) return 'earlier today';
    if (n === 1) return 'yesterday';
    return n + ' days ago';
  }

  // Same wording as the in-page prompt (shared/auto-tracker-core.js).
  function duplicateMessage(prior, company) {
    const name = (prior.log && prior.log.company) || company || 'this company';
    const when = daysAgoText(prior.daysAgo) + ' on ' + shortDate(prior.log.date, true);
    const lead = prior.sameListing
      ? 'Note: You already logged this ' + name + ' listing ' + when + '.'
      : 'Note: You applied to ' + name + ' ' + when + '.';
    return lead + ' Log again anyway?';
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
    return (metric.unit || 'items').replace(/s$/, '');
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
    const preferred = firstFieldId ? el(firstFieldId) : null;
    const target = (preferred && preferred.offsetParent !== null) ? preferred : focusableIn(modal)[0];
    if (target) target.focus();
  }

  function closeModal(modal) {
    const target = modal || openModalEl;
    if (!target) return;
    closeTokenPopover(false);
    target.classList.add('hidden');
    if (target === openModalEl) {
      openModalEl = null;
      if (modalReturnFocusEl && typeof modalReturnFocusEl.focus === 'function' && modalReturnFocusEl.isConnected) {
        modalReturnFocusEl.focus();
      }
      modalReturnFocusEl = null;
    }
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
  ['new-metric-modal', 'metric-settings-modal', 'email-signin-modal', 'add-widget-modal', 'widget-settings-modal', 'settings-modal'].forEach(id => {
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
  }

  async function setPref(patch, message) {
    try {
      prefs = await TrackerStorage.setPrefs(patch);
    } catch (err) {
      showStatus('Could not save that setting: ' + errMsg(err), 'error');
      return;
    }
    renderAlertToggles();
    if (message) showStatus(message, 'ok');
  }

  el('timer-sound-btn').addEventListener('click', () => setPref({ timerSound: !prefs.timerSound }, prefs.timerSound ? 'Timer sound off.' : 'Timer sound on.'));
  el('timer-desktop-btn').addEventListener('click', () => setPref({ timerDesktop: !prefs.timerDesktop }, prefs.timerDesktop ? 'Desktop alerts off.' : 'Desktop alerts on.'));
  el('sound-switch').addEventListener('click', () => setPref({ timerSound: !prefs.timerSound }));
  el('desktop-switch').addEventListener('click', () => setPref({ timerDesktop: !prefs.timerDesktop }));

  // ---------------------------------------------------------------------------
  // Account chip and menu
  // ---------------------------------------------------------------------------
  const SYNC_TEXT = {
    active: 'Synced & Active',
    offline: 'Offline, stored locally',
    expired: 'Session expired, sign in again',
    out: 'Logged out, entries stay on this device'
  };

  function syncState() {
    if (!currentUser || !currentUser.email) return 'out';
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
    chip.setAttribute('aria-label', signedIn ? 'Account ' + currentUser.email + ', ' + SYNC_TEXT[state] : 'Sign in, currently logged out');
    chip.title = signedIn ? currentUser.email + ' · ' + SYNC_TEXT[state] : SYNC_TEXT.out;
    el('chip-label').textContent = signedIn ? '' : 'Sign in';
    el('sync-dot').dataset.state = state;
    el('menu-sync-dot').dataset.state = state;
    renderAvatar(el('account-badge'), currentUser);
    renderAvatar(el('menu-avatar'), currentUser);
    el('account-email').textContent = signedIn ? currentUser.email : 'Not signed in';
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

  async function signIn() {
    try {
      // Never let auth.js fall back to window.prompt: an MV3 popup can close
      // under that dialog. Unpaired builds get our own dialog instead.
      await TrackerAuth.signInWithGoogle(undefined, { allowPrompt: false });
      showStatus('Signed in. You are now seeing this account\'s data.', 'ok');
      await loadData();
    } catch (err) {
      if (err && err.code === 'EMAIL_REQUIRED') {
        el('email-signin-input').value = '';
        openModal(el('email-signin-modal'), 'email-signin-input');
        return;
      }
      showStatus('Sign-in did not complete: ' + errMsg(err), 'error');
    }
  }

  async function signOut(quiet) {
    try {
      await TrackerAuth.signOut();
    } catch (err) {
      showStatus('Sign-out failed: ' + errMsg(err), 'error');
      return false;
    }
    if (!quiet) showStatus('Signed out. Showing entries saved while signed out.', 'ok');
    await loadData();
    return true;
  }

  async function switchAccount() {
    if (await signOut(true)) signIn();
  }

  // Direct email sign-in dialog (unpacked builds with no GCP client paired)
  el('email-signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await TrackerAuth.signInWithEmail(el('email-signin-input').value);
    } catch (err) {
      showStatus('Sign-in did not complete: ' + errMsg(err), 'error');
      el('email-signin-input').focus();
      return;
    }
    closeModal(el('email-signin-modal'));
    showStatus('Signed in. You are now seeing this account\'s data.', 'ok');
    await loadData();
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
      showStatus('Could not load your data: ' + errMsg(err), 'error');
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
      TrackerStorage.getPrefs()
    ]);
    metrics = m;
    stats = s;
    widgetItems = w;
    prefs = p;
    jobsCache = null;
    renderAuth();
    renderAlertToggles();
    renderUI();
    renderDigest();
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
    }).catch(err => showStatus('Could not load applications: ' + errMsg(err), 'error'));
  }

  function renderUI() {
    const current = metricById(activeMetricId) || metrics[0];
    if (!current) return;
    activeMetricId = current.id;
    setTrackerColor(el('counter-card'), current.color);
    renderTabs();
    renderCounter(current);

    const streak = (stats.streaks && stats.streaks[current.id]) || 0;
    el('streak-count').textContent = streak;
    el('streak-pill').classList.toggle('cold', streak === 0);
    el('streak-pill').title = streak > 0
      ? streak + ' consecutive day(s) hitting the ' + current.name + ' daily goal'
      : 'No active ' + current.name + ' streak. Hit today\'s daily goal to start one.';

    const hasAnyData = stats.totalLogs > 0;
    el('first-run-card').classList.toggle('hidden', hasAnyData);
    if (!hasAnyData) {
      el('first-run-tips').textContent = 'Press "' + el('quick-add-label').textContent + '" to log one, or use Add details for a company and role. '
        + 'Applications you submit on Greenhouse, Lever, Workday, Workable, and other job sites, and problems you solve on LeetCode, log themselves. '
        + 'Press / to search, and Alt+Shift+A logs +1 from any tab.';
    }

    renderWidgets();
  }

  // ---------------------------------------------------------------------------
  // Tracker tabs with a sliding highlight
  // ---------------------------------------------------------------------------
  const TRACKER_ICONS = {
    briefcase: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><rect x="2.8" y="5.5" width="14.4" height="10.5" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7.3 5.5V4.3a1.2 1.2 0 0 1 1.2-1.2h3a1.2 1.2 0 0 1 1.2 1.2v1.2M2.8 10h14.4" stroke="currentColor" stroke-width="1.6"/></svg>',
    code: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><path d="M6.5 6 2.8 10l3.7 4M13.5 6l3.7 4-3.7 4M11.3 4.2 8.7 15.8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    target: '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="3.8" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/></svg>'
  };

  function iconFor(metric) {
    if (metric.id === 'jobs' || metric.icon === 'briefcase') return TRACKER_ICONS.briefcase;
    if (metric.id === 'leetcode' || metric.icon === 'code') return TRACKER_ICONS.code;
    return TRACKER_ICONS.target;
  }

  let tabsRendered = false;

  function renderTabs() {
    const container = el('metric-tabs');
    container.querySelectorAll('.tab-item').forEach(n => n.remove());
    metrics.forEach(m => {
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
      const count = (stats.today && stats.today[m.id]) || 0;
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
    if (hadTabFocus && tabNode(id)) tabNode(id).focus();
  }

  el('metric-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab-item');
    if (tab) selectTracker(tab.dataset.metricId);
  });

  el('metric-tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = metrics.findIndex(m => m.id === activeMetricId);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % metrics.length;
    if (e.key === 'ArrowLeft') next = (i - 1 + metrics.length) % metrics.length;
    if (e.key === 'Home') next = 0;
    if (e.key === 'End') next = metrics.length - 1;
    selectTracker(metrics[next].id);
    const tab = tabNode(metrics[next].id);
    if (tab) tab.focus();
  });

  window.addEventListener('resize', () => moveTabIndicator(false));

  // ---------------------------------------------------------------------------
  // Counter card: rolling digits and the goal ring
  // ---------------------------------------------------------------------------
  const RING_C = 2 * Math.PI * 52;
  let countersRendered = false;

  // Each digit is a vertical strip of 0-9 that slides to its value, so +1 and
  // -1 roll the way a mechanical counter does.
  function renderTicker(node, value, animate) {
    const str = String(Math.max(0, parseInt(value, 10) || 0));
    const prev = node.dataset.value;
    if (prev === str && node.querySelector('.digit')) return;
    node.dataset.value = str;
    node.setAttribute('aria-label', str);
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

  function celebrate(node) {
    if (!node || reduceMotion) return;
    node.classList.remove('celebrate');
    void node.offsetWidth;
    node.classList.add('celebrate');
    setTimeout(() => node.classList.remove('celebrate'), 1300);
  }

  function quickAddLabel(metric) {
    if (metric.id === 'jobs') return 'Log application';
    if (metric.id === 'leetcode') return 'Log problem';
    return 'Log ' + unitSingular(metric);
  }

  function renderCounter(current) {
    const today = (stats.today && stats.today[current.id]) || 0;
    const goal = goalFor(current);
    const met = today >= goal;
    renderTicker(el('metric-count'), today, countersRendered);
    countersRendered = true;
    el('ring-goal').textContent = 'of ' + goal;

    buildRingTicks();
    const pct = Math.min(1, today / goal);
    const fill = el('ring-fill');
    fill.style.strokeDasharray = String(RING_C);
    fill.style.strokeDashoffset = String(RING_C * (1 - pct));
    el('ring-ticks').querySelectorAll('.ring-tick').forEach(t => {
      t.classList.toggle('reached', pct >= Number(t.dataset.pct));
    });
    el('ring-wrap').classList.toggle('met', met);

    el('metric-unit-label').textContent = (current.unit || 'items') + ' logged today';
    const sub = el('counter-sub');
    sub.textContent = met ? 'Daily goal reached' : (goal - today) + ' to go for today\'s goal';
    sub.classList.toggle('met', met);

    const weekly = current.weeklyGoal || 0;
    const weekCount = (stats.weekToDate && stats.weekToDate[current.id]) || 0;
    el('week-line').classList.toggle('hidden', weekly <= 0);
    el('week-set-btn').classList.toggle('hidden', weekly > 0);
    if (weekly > 0) {
      el('week-count').textContent = weekCount + ' / ' + weekly;
      el('week-fill').style.width = Math.min(100, Math.round((weekCount / weekly) * 100)) + '%';
      el('week-line').classList.toggle('met', weekCount >= weekly);
    }

    el('quick-add-label').textContent = quickAddLabel(current);
    el('undo-btn').setAttribute('aria-label', 'Remove the most recent ' + current.name + ' entry logged today');

    if (lastToday[current.id] !== undefined && lastToday[current.id] < goal && met) {
      celebrate(el('ring-wrap'));
      requestAnimationFrame(() => widgetsHost.querySelectorAll('.widget-goal').forEach(celebrate));
    }
    metrics.forEach(m => { lastToday[m.id] = (stats.today && stats.today[m.id]) || 0; });
  }

  el('week-set-btn').addEventListener('click', () => openMetricSettings(activeMetricId, 'metric-settings-weekly'));

  // +1
  el('quick-add-btn').addEventListener('click', async () => {
    const btn = el('quick-add-btn');
    btn.classList.remove('pressed');
    void btn.offsetWidth;
    btn.classList.add('pressed');

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
      showStatus('Could not save that entry: ' + errMsg(err), 'error');
      return;
    }
    if (solveTimeSeconds > 0) {
      showStatus('Logged with a solve time of ' + TrackerStorage.formatTimeHMS(solveTimeSeconds) + '.', 'ok');
    }
    notifyCalendarTabs();
    await loadData();
  });

  // -1
  el('undo-btn').addEventListener('click', async () => {
    let removed = false;
    try {
      removed = await TrackerStorage.undoLastLog(activeMetricId);
    } catch (err) {
      showStatus('Could not remove that entry: ' + errMsg(err), 'error');
      return;
    }
    if (!removed) {
      const current = metricById(activeMetricId);
      showStatus('Nothing logged today for ' + (current ? current.name : 'this tracker') + ', so there is nothing to remove.', 'error');
      return;
    }
    showStatus('Removed the most recent entry logged today.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  // ---------------------------------------------------------------------------
  // Weekly recap
  // ---------------------------------------------------------------------------
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  async function renderDigest() {
    const card = el('digest-card');
    const weekStart = stats && stats.weekStartStr;
    if (!weekStart || prefs.digestDismissedWeek === weekStart) {
      card.classList.add('hidden');
      return;
    }
    const token = bumpToken('digest');
    let summary;
    try {
      summary = await TrackerStorage.getWeekSummary();
    } catch (err) {
      card.classList.add('hidden');
      return;
    }
    if (asyncTokens.digest !== token) return;
    if (!summary || summary.total === 0) {
      card.classList.add('hidden');
      return;
    }
    el('digest-title').textContent = shortDate(summary.weekStart) + ' – ' + shortDate(summary.weekEnd);
    const rows = el('digest-rows');
    rows.textContent = '';
    summary.metrics.filter(m => m.total > 0 || m.weeklyGoal > 0).forEach(m => {
      const row = make('div', 'digest-row');
      row.style.setProperty('--c', m.color);

      const name = make('span', 'digest-name');
      name.appendChild(make('i'));
      name.appendChild(make('span', 'digest-name-text', m.name));
      name.title = m.name;
      row.appendChild(name);

      const total = make('span', 'digest-total', String(m.total));
      if (m.weeklyGoal > 0) {
        total.appendChild(make('small', null, ' / ' + m.weeklyGoal));
        row.classList.toggle('met', m.total >= m.weeklyGoal);
      }
      row.appendChild(total);

      // Seven bars, Monday to Sunday, scaled to the week's busiest day.
      const days = m.days || [];
      const peak = Math.max(1, ...days);
      const chart = make('div', 'digest-week');
      chart.setAttribute('aria-hidden', 'true');
      WEEK_LETTERS.forEach((letter, i) => {
        const n = days[i] || 0;
        const col = make('span', 'digest-day' + (n > 0 ? '' : ' is-zero'));
        const bar = make('b');
        bar.style.height = (n > 0 ? Math.max(3, Math.round((n / peak) * 16)) : 2) + 'px';
        col.appendChild(bar);
        col.appendChild(make('em', null, letter));
        col.title = n + (n === 1 ? ' entry' : ' entries');
        chart.appendChild(col);
      });
      row.appendChild(chart);

      const bits = [m.activeDays + '/7 days'];
      if (m.goalDays > 0) bits.push('goal met ' + m.goalDays + '×');
      if (m.bestDay) bits.push('best ' + WEEKDAYS[TrackerStorage.parseLocalDateToNoon(m.bestDay.date).getDay()]);
      const detail = make('span', 'digest-detail', bits.join(' · '));
      detail.title = bits.join(' · ');
      row.appendChild(detail);
      rows.appendChild(row);
    });
    const foot = [];
    if (summary.responses > 0) foot.push(summary.responses + (summary.responses === 1 ? ' application heard back' : ' applications heard back'));
    foot.push(foot.length ? 'keep it going' : 'Keep the chain going this week');
    el('digest-foot').textContent = foot.join(' · ');
    card.classList.remove('hidden');
  }

  el('digest-dismiss-btn').addEventListener('click', async () => {
    el('digest-card').classList.add('hidden');
    if (stats && stats.weekStartStr) await setPref({ digestDismissedWeek: stats.weekStartStr });
  });

  // ---------------------------------------------------------------------------
  // Widgets
  // ---------------------------------------------------------------------------
  const widgetsHost = el('widgets-host');
  const widgetParts = el('widget-parts');
  const PART_IDS = { timer: 'leetcode-timer-widget', timeStats: 'leetcode-time-block', details: 'details-section' };

  const GRIP_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>';
  const GEAR_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" aria-hidden="true" focusable="false"><path d="M4 6h8M15 6h1M4 14h1M8 14h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="13.5" cy="6" r="1.8" stroke="currentColor" stroke-width="1.5"/><circle cx="6.5" cy="14" r="1.8" stroke="currentColor" stroke-width="1.5"/></svg>';
  const CHEV_SVG = '<svg class="chev" viewBox="0 0 10 10" fill="none" aria-hidden="true" focusable="false"><path d="M2 3.5 5 6.5l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const X_SVG = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true" focusable="false"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  // One glyph per widget type for the add-widget list.
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
    responseStats: '<path d="M2 11.5 5 8l2.2 2L12 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.2 4.5H12v2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
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
    if (item.type === 'activity') return item.options.days + '-day activity';
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
    grip.title = 'Drag to reorder';
    grip.innerHTML = GRIP_SVG;
    tools.appendChild(grip);
    const edit = make('button', 'tool-btn widget-edit-btn');
    edit.type = 'button';
    edit.title = 'Customize widget';
    edit.innerHTML = GEAR_SVG;
    tools.appendChild(edit);
    head.appendChild(tools);
    wrap.appendChild(head);
    wrap.appendChild(make('div', 'widget-body'));
    return wrap;
  }

  function updateShell(wrap, item, metric, solo) {
    const name = WidgetLayout.TYPES[item.type].name;
    wrap.classList.toggle('size-compact', item.options.size === 'compact');
    wrap.classList.toggle('size-expanded', item.options.size !== 'compact');
    wrap.classList.toggle('solo', solo);
    wrap.classList.toggle('collapsed', !!item.options.collapsed);
    setTrackerColor(wrap, metric.color);
    const toggle = wrap.querySelector('.widget-collapse');
    toggle.setAttribute('aria-expanded', item.options.collapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', (item.options.collapsed ? 'Expand ' : 'Collapse ') + name);
    wrap.querySelector('.widget-title').textContent = widgetTitle(item);
    const pin = pinLabel(item, metric);
    wrap.querySelector('.widget-pin').textContent = pin ? '· ' + pin : '';
    wrap.querySelector('.widget-drag-handle').setAttribute('aria-label', 'Reorder the ' + name + ' widget. Use the arrow keys to move it.');
    wrap.querySelector('.widget-edit-btn').setAttribute('aria-label', 'Customize the ' + name + ' widget');
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
      const row = make('label', 'stage stage-' + s.id);
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
        row.appendChild(input);
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
      showStatus('Could not update the counts: ' + errMsg(err), 'error');
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
      const weeklyGoal = metric.weeklyGoal || 0;
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
      if (!body.firstChild) {
        const row = make('div', 'stat-row');
        row.appendChild(statTile(0, 'Last 7 days', 'week'));
        row.appendChild(statTile(0, 'This month', 'month'));
        row.appendChild(statTile(0, 'All time', 'total'));
        body.appendChild(row);
      }
      body.querySelector('[data-stat="week"]').textContent = (stats.thisWeek && stats.thisWeek[metric.id]) || 0;
      body.querySelector('[data-stat="month"]').textContent = (stats.thisMonth && stats.thisMonth[metric.id]) || 0;
      body.querySelector('[data-stat="total"]').textContent = (stats.totals && stats.totals[metric.id]) || 0;
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
    },

    activity(body, item, metric, wrap) {
      const extra = wrap.querySelector('.widget-extra');
      if (!extra.firstChild) {
        const seg = make('div', 'segmented');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Chart style');
        [['bar', 'Bars'], ['area', 'Line'], ['heatmap', 'Grid']].forEach(([value, label]) => {
          const b = make('button', '', label);
          b.type = 'button';
          b.dataset.chart = value;
          seg.appendChild(b);
        });
        extra.appendChild(seg);
      }
      extra.querySelectorAll('[data-chart]').forEach(b => b.setAttribute('aria-pressed', b.dataset.chart === item.options.chart ? 'true' : 'false'));
      if (!body.firstChild) {
        body.appendChild(make('div', 'chart'));
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
      const placeholders = metric.id === 'jobs'
        ? ['Company', 'Role', 'Notes or job link']
        : (metric.id === 'leetcode' ? ['Problem', 'Topic or tag', 'Notes or link'] : ['Title', 'Tag', 'Notes or link']);
      el('detail-company').placeholder = placeholders[0];
      el('detail-role').placeholder = placeholders[1];
      el('detail-notes').placeholder = placeholders[2];
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
        foot.appendChild(make('span', '', pipelineFilter ? 'Filtering Recent Applications' : 'Select a stage to filter'));
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
          clear.innerHTML = X_SVG;
          chip.appendChild(clear);
          body.appendChild(chip);
        }
        if (!filtered.length) {
          body.appendChild(make('div', 'empty', pipelineFilter
            ? 'Nothing in ' + statusMeta(pipelineFilter).label + ' right now.'
            : 'No applications yet. Log one here, or apply on a job site and LIT logs it for you.'));
          return;
        }
        const list = make('ul', 'entry-list recent-list');
        const jobsColor = (metricById('jobs') || {}).color;
        filtered.slice(0, 10).forEach((log, i) => list.appendChild(entryRow(log, { color: jobsColor, delay: i })));
        body.appendChild(list);
      });
    },

    responseStats(body, item) {
      withJobs(body, 'response:' + item.id, logs => {
        const s = TrackerStorage.summarizePipeline(logs);
        body.textContent = '';
        const wrap = make('div', 'response');
        const big = make('div', 'big-stat');
        big.appendChild(make('span', 'num', s.responseRate === null ? '--' : s.responseRate + '%'));
        big.appendChild(make('span', 'of', 'response rate'));
        wrap.appendChild(big);
        const bar = make('div', 'response-bar');
        bar.setAttribute('aria-hidden', 'true');
        ['review', 'interviewing', 'offer', 'rejected'].forEach(id => {
          const seg = make('span', 'stage-' + id);
          seg.style.width = s.total ? (s.counts[id] / s.total) * 100 + '%' : '0';
          bar.appendChild(seg);
        });
        wrap.appendChild(bar);
        const meta = s.total === 0
          ? 'Move applications past Applied as you hear back to see your rate.'
          : s.responded + ' of ' + s.total + ' heard back' + (s.avgTurnaroundDays !== null
            ? '. Replies take ' + s.avgTurnaroundDays + (s.avgTurnaroundDays === 1 ? ' day' : ' days') + ' on average.'
            : '.');
        wrap.appendChild(make('div', 'response-meta', meta));
        body.appendChild(wrap);
      });
    }
  };

  // A row for an entry: company or title, a quieter second line, and for job
  // entries a stage pill. Used by Recent Applications and search results.
  function entryRow(log, options = {}) {
    const metric = metricById(log.metricId);
    const li = make('li', 'entry');
    li.dataset.logId = log.id;
    li.style.setProperty('--c', options.color || (metric ? metric.color : '#1a73e8'));
    if (options.delay) li.style.animationDelay = Math.min(options.delay, 10) * 18 + 'ms';
    const main = make('div', 'entry-main');
    main.appendChild(make('span', 'entry-dot'));
    const text = make('div', 'entry-text');
    const title = make('div', 'entry-title');
    const titleText = log.company || log.role || log.notes || (metric ? metric.name : 'Entry');
    const subParts = [];
    if (log.company && log.role) subParts.push(log.role);
    subParts.push(relativeDate(log.date));
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
    text.appendChild(title);
    text.appendChild(sub);
    main.appendChild(text);
    li.appendChild(main);
    const side = make('div', 'entry-side');
    if (log.metricId === 'jobs') side.appendChild(statusPill(log));
    if (options.deletable) {
      const del = make('button', 'del-btn');
      del.type = 'button';
      del.dataset.deleteId = log.id;
      del.setAttribute('aria-label', 'Delete this entry');
      del.title = 'Delete';
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
      showStatus('Could not load activity: ' + errMsg(err), 'error');
      return;
    }
    if (asyncTokens[key] !== token || !body.isConnected) return;

    body.querySelector('[data-stat="total"]').textContent = history.totalCount;
    body.querySelector('[data-stat="avg"]').textContent = history.dailyAverage;
    body.querySelector('[data-stat="days"]').textContent = history.activeDaysCount;
    body.querySelector('[data-stat="best"]').textContent = history.bestDay.count;

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
      showStatus('Could not load solve-time stats: ' + errMsg(err), 'error');
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
      note.textContent = 'Start the Solve Timer before a problem and log it with the plus button to record how long it took.';
      note.classList.remove('hidden');
      return;
    }
    renderSpark(s);
    let trend;
    if (s.sessionCount < 2) trend = 'your first timed solve.';
    else if (s.latestSeconds < s.medianSeconds) trend = fmt(s.medianSeconds - s.latestSeconds) + ' faster than your median.';
    else if (s.latestSeconds > s.medianSeconds) trend = fmt(s.latestSeconds - s.medianSeconds) + ' slower than your median.';
    else trend = 'right on your median.';
    note.textContent = 'Latest solve ' + fmt(s.latestSeconds) + ', ' + trend;
    note.classList.remove('hidden');
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
  function renderWidgets() {
    if (!widgetsHost || !metrics.length) return;
    const existing = {};
    Array.from(widgetsHost.children).forEach(node => { existing[node.dataset.widgetId] = node; });
    const keep = new Set();

    const visible = [];
    widgetItems.forEach(item => {
      const metric = metricFor(item);
      if (!metric || !WIDGET_RENDERERS[item.type]) return;
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
      WIDGET_RENDERERS[item.type](wrap.querySelector('.widget-body'), item, metric, wrap);
    });

    Object.keys(existing).forEach(id => {
      if (keep.has(id)) return;
      const node = existing[id];
      const type = node.dataset.widgetType;
      if (PART_IDS[type]) parkPart(PART_IDS[type]);
      node.remove();
    });
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
      showStatus('Could not update widgets: ' + errMsg(err), 'error');
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

  /* Add widget picker */
  function renderWidgetPicker() {
    const list = el('add-widget-list');
    list.textContent = '';
    WidgetLayout.availableTypes(widgetItems).forEach(t => {
      const row = make('div', 'widget-picker-row');
      const icon = make('span', 'widget-picker-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" focusable="false">' + (WIDGET_TYPE_ICON[t.type] || '') + '</svg>';
      const text = make('div', 'widget-picker-text');
      const name = make('div', 'widget-picker-name', t.name);
      if (t.isNew) name.appendChild(make('span', 'new-tag', 'New'));
      text.appendChild(name);
      text.appendChild(make('div', 'widget-picker-desc', t.description));
      const btn = make('button', 'widget-add-btn' + (t.added ? ' added' : ''), t.added ? 'Added' : 'Add');
      btn.type = 'button';
      btn.setAttribute('aria-label', (t.added ? 'Already added: ' : 'Add ') + t.name);
      btn.disabled = t.added;
      btn.addEventListener('click', async () => {
        const ok = await applyLayout(WidgetLayout.add(t.type, { metricId: WidgetLayout.ACTIVE }), t.name + ' widget added.');
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
    const ok = await applyLayout(WidgetLayout.reset(), 'Widgets reset to the recommended layout.');
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
        showStatus('Could not change the stage: ' + errMsg(err), 'error');
        return;
      }
      if (!updated) {
        showStatus('That entry could not be updated.', 'error');
        return;
      }
      // Patch the local copies so the pill, funnel, and rate update now.
      if (jobsCache && jobsCache.logs) {
        const hit = jobsCache.logs.find(l => l.id === logId);
        if (hit) Object.assign(hit, updated);
      }
      document.querySelectorAll('.status-pill[data-log-id="' + CSS.escape(logId) + '"]').forEach(p => p.replaceWith(statusPill(updated)));
      renderWidgets();
      showStatus('Moved ' + (updated.company || updated.role || 'that application') + ' to ' + statusMeta(value).label + '.', 'ok');
    });
  }

  /* Widget settings */
  let settingsWidgetId = null;
  let widgetRemoveArmed = false;
  let widgetDraft = null; // { metricId, days, showStats, size, chart }
  const CHART_LABELS = { bar: 'Bars', area: 'Line', heatmap: 'Heatmap' };

  function metricLabelFor(metricId) {
    if (metricId === WidgetLayout.ACTIVE) return 'Follow the selected tab';
    const m = metricById(metricId);
    return m ? 'Always ' + m.name : 'Follow the selected tab';
  }

  function renderWidgetTokens() {
    const item = widgetById(settingsWidgetId);
    if (!item || !widgetDraft) return;
    const spec = WidgetLayout.TYPES[item.type];
    const bindable = 'metricId' in spec.defaults;
    const isActivity = item.type === 'activity';

    el('widget-token-metric').classList.toggle('hidden', !bindable);
    el('widget-metric-btn').textContent = metricLabelFor(widgetDraft.metricId);
    el('widget-size-btn').textContent = widgetDraft.size === 'compact' ? 'Compact (half width)' : 'Expanded (full width)';

    ['widget-token-chart', 'widget-token-days', 'widget-token-stats'].forEach(id => el(id).classList.toggle('hidden', !isActivity));
    if (isActivity) {
      el('widget-chart-btn').textContent = CHART_LABELS[widgetDraft.chart];
      el('widget-days-btn').textContent = widgetDraft.days + ' days';
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
      days: item.options.days || 30,
      showStats: item.options.showStats !== false,
      size: item.options.size,
      chart: item.options.chart || 'bar'
    };
    const spec = WidgetLayout.TYPES[item.type];
    el('widget-settings-title').textContent = spec.name;
    renderWidgetTokens();
    const remove = el('remove-widget-btn');
    remove.querySelector('span').textContent = 'Remove widget';
    remove.classList.remove('armed');
    el('widget-settings-hint').textContent = spec.leetcodeOnly
      ? 'This widget only appears while the LeetCode tracker is selected.'
      : spec.jobsOnly
        ? 'This widget only appears while the Job Applications tracker is selected.'
        : (spec.singleton ? 'Removing this widget hides it; add it back any time with Add widget.' : 'Removing a widget never deletes any logged data.');
    openModal(el('widget-settings-modal'), 'metricId' in spec.defaults ? 'widget-metric-btn' : 'widget-size-btn');
  }

  el('widget-metric-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = [{ value: WidgetLayout.ACTIVE, label: 'Follow the selected tab', selected: widgetDraft.metricId === WidgetLayout.ACTIVE }]
      .concat(metrics.map(m => ({ value: m.id, label: 'Always ' + m.name, selected: widgetDraft.metricId === m.id })));
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
      { value: 'compact', label: 'Compact (half width)', selected: widgetDraft.size === 'compact' },
      { value: 'expanded', label: 'Expanded (full width)', selected: widgetDraft.size !== 'compact' }
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
    const items = WidgetLayout.CHART_MODES.map(c => ({ value: c, label: CHART_LABELS[c], selected: widgetDraft.chart === c }));
    openTokenPopover(el('widget-chart-btn'), items, (value) => {
      if (value === widgetDraft.chart) return;
      widgetDraft.chart = value;
      renderWidgetTokens();
      flashToken(el('widget-chart-btn'));
    });
  });

  el('widget-days-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    const items = WidgetLayout.ACTIVITY_DAYS.map(d => ({ value: String(d), label: d + ' days', selected: widgetDraft.days === d }));
    openTokenPopover(el('widget-days-btn'), items, (value) => {
      const days = parseInt(value, 10);
      if (days === widgetDraft.days) return;
      widgetDraft.days = days;
      renderWidgetTokens();
      flashToken(el('widget-days-btn'));
    });
  });

  el('widget-stats-btn').addEventListener('click', () => {
    if (!widgetDraft) return;
    widgetDraft.showStats = !widgetDraft.showStats;
    renderWidgetTokens();
    flashToken(el('widget-stats-btn'));
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
    const patch = { size: widgetDraft.size };
    if ('metricId' in WidgetLayout.TYPES[item.type].defaults) patch.metricId = widgetDraft.metricId;
    if (item.type === 'activity') {
      patch.days = widgetDraft.days;
      patch.showStats = widgetDraft.showStats;
      patch.chart = widgetDraft.chart;
    }
    const ok = await applyLayout(WidgetLayout.update(item.id, patch), 'Widget updated.');
    if (ok) closeModal(el('widget-settings-modal'));
  });

  // Two-step remove, same pattern as deleting a tracker.
  el('remove-widget-btn').addEventListener('click', async () => {
    const btn = el('remove-widget-btn');
    if (!widgetRemoveArmed) {
      widgetRemoveArmed = true;
      btn.querySelector('span').textContent = 'Select again to confirm';
      btn.classList.add('armed');
      return;
    }
    const target = settingsWidgetId;
    settingsWidgetId = null;
    widgetRemoveArmed = false;
    const ok = await applyLayout(WidgetLayout.remove(target), 'Widget removed.');
    if (ok) closeModal(el('widget-settings-modal'));
  });

  el('close-widget-settings-modal').addEventListener('click', () => closeModal(el('widget-settings-modal')));
  el('cancel-widget-settings-btn').addEventListener('click', () => closeModal(el('widget-settings-modal')));

  // ---------------------------------------------------------------------------
  // Trackers: add, goals, delete
  // ---------------------------------------------------------------------------
  let settingsMetricId = null;
  let metricDeleteArmed = false;

  el('add-metric-tab-btn').addEventListener('click', () => openModal(el('new-metric-modal'), 'new-metric-name'));
  el('close-metric-modal').addEventListener('click', () => closeModal(el('new-metric-modal')));
  el('cancel-metric-btn').addEventListener('click', () => closeModal(el('new-metric-modal')));

  let selectedColor = '#1a73e8';
  el('color-palette').addEventListener('click', (e) => {
    const btn = e.target.closest('.color-option');
    if (!btn) return;
    el('color-palette').querySelectorAll('.color-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedColor = btn.dataset.color;
  });

  el('new-metric-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = el('new-metric-name').value.trim();
    const unit = el('new-metric-unit').value.trim() || 'items';
    const dailyGoal = parseInt(el('new-metric-goal').value, 10) || 5;
    if (!name) {
      showStatus('Give the tracker a name before adding it.', 'error');
      el('new-metric-name').focus();
      return;
    }
    let created;
    try {
      created = await TrackerStorage.addMetric({ name, color: selectedColor, unit, dailyGoal, icon: 'target' });
    } catch (err) {
      showStatus('Could not create that tracker: ' + errMsg(err), 'error');
      return;
    }
    activeMetricId = created.id;
    TrackerStorage.setActiveMetricId(created.id);
    el('new-metric-name').value = '';
    el('new-metric-goal').value = '5';
    closeModal(el('new-metric-modal'));
    showStatus('Tracker "' + created.name + '" added.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  function openMetricSettings(metricId, focusId) {
    const current = metricById(metricId || activeMetricId);
    if (!current) return;
    settingsMetricId = current.id;
    metricDeleteArmed = false;
    el('metric-settings-title').textContent = current.name;
    el('metric-settings-goal').value = goalFor(current);
    el('metric-settings-weekly').value = current.weeklyGoal > 0 ? current.weeklyGoal : '';
    const isBuiltIn = !!current.isDefault || current.id === 'jobs' || current.id === 'leetcode';
    const deleteBtn = el('delete-metric-btn');
    deleteBtn.textContent = 'Delete tracker';
    deleteBtn.classList.remove('armed');
    deleteBtn.classList.toggle('hidden', isBuiltIn);
    el('metric-settings-hint').textContent = (isBuiltIn
      ? 'Built-in trackers cannot be removed. '
      : 'Deleting this tracker removes its tab; entries you already logged stay in storage and in your exports. ')
      + 'Leave the weekly goal empty to turn it off.';
    openModal(el('metric-settings-modal'), focusId || 'metric-settings-goal');
  }

  el('metric-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const goal = parseInt(el('metric-settings-goal').value, 10);
    const weekly = parseInt(el('metric-settings-weekly').value, 10) || 0;
    if (!goal || goal < 1) {
      showStatus('Enter a daily goal of 1 or more.', 'error');
      el('metric-settings-goal').focus();
      return;
    }
    try {
      await TrackerStorage.setMetricGoal(settingsMetricId, goal);
      await TrackerStorage.setMetricWeeklyGoal(settingsMetricId, Math.max(0, weekly));
    } catch (err) {
      showStatus('Could not save those goals: ' + errMsg(err), 'error');
      return;
    }
    closeModal(el('metric-settings-modal'));
    showStatus('Daily goal ' + goal + (weekly > 0 ? ', weekly goal ' + weekly : ', weekly goal off') + '.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  el('delete-metric-btn').addEventListener('click', async () => {
    const btn = el('delete-metric-btn');
    if (!metricDeleteArmed) {
      metricDeleteArmed = true;
      btn.textContent = 'Select again to confirm';
      btn.classList.add('armed');
      return;
    }
    let removed = false;
    try {
      removed = await TrackerStorage.deleteMetric(settingsMetricId);
    } catch (err) {
      showStatus('Could not delete that tracker: ' + errMsg(err), 'error');
      return;
    }
    metricDeleteArmed = false;
    if (!removed) {
      showStatus('That tracker could not be deleted.', 'error');
      return;
    }
    if (activeMetricId === settingsMetricId) {
      activeMetricId = 'jobs';
      TrackerStorage.setActiveMetricId('jobs');
    }
    settingsMetricId = null;
    closeModal(el('metric-settings-modal'));
    showStatus('Tracker deleted. Its past entries are still in your export.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  el('close-settings-modal').addEventListener('click', () => closeModal(el('metric-settings-modal')));
  el('cancel-settings-btn').addEventListener('click', () => closeModal(el('metric-settings-modal')));

  // ---------------------------------------------------------------------------
  // Add details form, with the 90-day duplicate check for applications
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
    const companyKey = TrackerStorage.normalizeCompany(company);

    if (metricId === 'jobs' && companyKey && dupConfirmedFor !== companyKey) {
      let prior = null;
      try {
        prior = await TrackerStorage.findRecentApplication({ company });
      } catch (err) {
        prior = null;
      }
      if (prior) {
        dupConfirmedFor = companyKey;
        const note = el('dup-note');
        note.textContent = duplicateMessage(prior, company);
        note.classList.remove('hidden');
        el('details-submit-btn').textContent = 'Log anyway';
        el('details-submit-btn').focus();
        return;
      }
    }

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
      showStatus('Could not save that entry: ' + errMsg(err), 'error');
      return;
    }
    notifyCalendarTabs();
    el('detail-company').value = '';
    el('detail-role').value = '';
    el('detail-notes').value = '';
    resetDuplicateNote();
    showStatus('Entry saved.', 'ok');
    await loadData();
  });

  // ---------------------------------------------------------------------------
  // Search across all history
  // ---------------------------------------------------------------------------
  const searchInput = el('search-input');
  let searchOpen = false;
  let searchTimer = null;
  let searchToken = 0;

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
      meta.textContent = 'Search all ' + ((stats && stats.totalLogs) || 0) + ' entries by company, role, notes, stage, or tracker.';
      return;
    }
    let res;
    try {
      res = await TrackerStorage.searchLogs(q, { limit: 60 });
    } catch (err) {
      meta.textContent = 'Search failed: ' + errMsg(err);
      return;
    }
    if (token !== searchToken || !searchOpen) return;
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    meta.textContent = res.total === 0
      ? 'No entries match "' + q + '".'
      : res.total + (res.total === 1 ? ' match' : ' matches') + (res.total > res.results.length ? ', showing the newest ' + res.results.length : '');
    results.textContent = '';
    res.results.forEach((log, i) => results.appendChild(entryRow(log, { tokens, showTracker: true, showNotes: true, deletable: true, delay: i })));
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
    const pill = e.target.closest('.status-pill');
    if (pill) {
      openStatusPicker(pill);
      return;
    }
    const del = e.target.closest('.del-btn');
    if (!del) return;
    const id = del.dataset.deleteId;
    if (!deleteArms.has(id)) {
      del.classList.add('armed');
      del.title = 'Select again to delete';
      del.setAttribute('aria-label', 'Select again to delete this entry');
      deleteArms.set(id, setTimeout(() => {
        deleteArms.delete(id);
        del.classList.remove('armed');
        del.title = 'Delete';
        del.setAttribute('aria-label', 'Delete this entry');
      }, 3000));
      return;
    }
    clearTimeout(deleteArms.get(id));
    deleteArms.delete(id);
    let removed = false;
    try {
      removed = await TrackerStorage.deleteLog(id);
    } catch (err) {
      showStatus('Could not delete that entry: ' + errMsg(err), 'error');
      return;
    }
    if (!removed) {
      showStatus('That entry was already removed.', 'error');
      return;
    }
    const row = del.closest('.entry');
    if (row) row.remove();
    showStatus('Entry deleted.', 'ok');
    notifyCalendarTabs();
    loadData();
  });

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
      const where = s.backend === 'indexeddb' ? 'IndexedDB' : 'chrome.storage.local';
      info.textContent = s.logCount.toLocaleString() + (s.logCount === 1 ? ' entry' : ' entries') + ' across all accounts, stored on this device in ' + where + '. Trackers, layout, and theme sync through your Chrome profile.';
    } catch (err) {
      info.textContent = 'Could not read storage: ' + errMsg(err);
    }
  }

  async function renderSnapshots() {
    const list = el('snapshot-list');
    let snaps = [];
    try {
      snaps = await TrackerStorage.listSnapshots();
    } catch (err) {
      list.textContent = '';
      list.appendChild(make('li', '', 'Could not list snapshots: ' + errMsg(err)));
      return;
    }
    list.textContent = '';
    if (!snaps.length) {
      list.appendChild(make('li', 'snap-meta', 'No snapshots yet. LIT takes one automatically each week.'));
      return;
    }
    snaps.forEach(s => {
      const li = make('li');
      const text = make('div');
      text.appendChild(make('div', '', formatSnapshotDate(s.createdAt)));
      text.appendChild(make('div', 'snap-meta', (s.reason === 'weekly' ? 'Weekly' : 'Manual') + ' · ' + s.logCount + (s.logCount === 1 ? ' entry' : ' entries')));
      li.appendChild(text);
      const actions = make('div', 'snap-actions');
      const restore = make('button', 'link-btn', 'Restore');
      restore.type = 'button';
      restore.dataset.restoreSnapshot = s.id;
      const download = make('button', 'link-btn', 'Download');
      download.type = 'button';
      download.dataset.downloadSnapshot = s.id;
      actions.appendChild(restore);
      actions.appendChild(download);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function openSettings() {
    renderAlertToggles();
    applyTheme(document.body.classList.contains('pt-dark') ? 'dark' : 'light');
    renderUniversalSwitch();
    renderStorageInfo();
    renderSnapshots();
    openModal(el('settings-modal'), 'close-app-settings');
  }

  el('close-app-settings').addEventListener('click', () => closeModal(el('settings-modal')));

  // chrome.permissions.request must run inside the click itself (a user
  // gesture), so nothing is awaited before it. The service worker also turns
  // the setting on when the permission lands, in case Chrome's prompt closes
  // the popup before this resolves.
  el('universal-switch').addEventListener('click', async () => {
    const perms = permissionsApi();
    const turningOn = el('universal-switch').getAttribute('aria-checked') !== 'true';
    if (!perms) {
      showStatus('This browser does not support optional permissions.', 'error');
      return;
    }
    if (turningOn) {
      let granted = false;
      try {
        granted = await perms.request({ origins: UNIVERSAL_ORIGINS });
      } catch (err) {
        granted = false;
      }
      if (!granted) {
        showStatus('Chrome did not grant access to all sites, so universal detection stays off.', 'error');
        renderUniversalSwitch();
        return;
      }
      await setPref({ universalTracking: true }, 'Universal detection is on for career pages you open from now on.');
    } else {
      await setPref({ universalTracking: false }, 'Universal detection is off. The major job boards are still tracked.');
      try { await perms.remove({ origins: UNIVERSAL_ORIGINS }); } catch (e) { /* already removed */ }
    }
    renderUniversalSwitch();
  });

  el('backup-btn').addEventListener('click', () => exportData('json', 'lit-backup'));
  el('restore-btn').addEventListener('click', () => el('restore-input').click());

  function restoreMessage(r) {
    const parts = ['Restored ' + r.added + (r.added === 1 ? ' entry' : ' entries')];
    if (r.skipped) parts.push(r.skipped + ' already here');
    if (r.invalid) parts.push(r.invalid + ' unreadable');
    if (r.metricsAdded) parts.push(r.metricsAdded + (r.metricsAdded === 1 ? ' tracker added' : ' trackers added'));
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
      showStatus('Restore failed: ' + errMsg(err), 'error');
      return;
    }
    showStatus(restoreMessage(result), 'ok');
    notifyCalendarTabs();
    renderStorageInfo();
    await loadData();
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
        showStatus('Restore failed: ' + errMsg(err), 'error');
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
        showStatus('That snapshot no longer exists.', 'error');
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
      showStatus('Could not take a snapshot: ' + errMsg(err), 'error');
      return;
    }
    showStatus('Snapshot saved. LIT keeps the four newest.', 'ok');
    renderSnapshots();
  });

  el('shortcuts-link').addEventListener('click', () => {
    if (chrome.tabs) chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  el('autofill-profile-btn').addEventListener('click', () => {
    if (chrome.tabs) chrome.tabs.create({ url: chrome.runtime.getURL('options/autofill.html') });
  });

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
          showStatus('Nothing logged for ' + metric.name + ' yet.', 'error');
          return;
        }
        text = LitExport.buildMarkdown(logs, names, { title: metric.name + ' (' + count + ')' });
        const copied = await copyText(text);
        showStatus(copied
          ? 'Copied ' + count + ' ' + metric.name + ' entries as a Markdown table.'
          : 'The clipboard is unavailable here, so the Markdown could not be copied.', copied ? 'ok' : 'error');
        return;
      }
    } catch (err) {
      showStatus('Export failed: ' + errMsg(err), 'error');
      return;
    }
    if (!count) {
      showStatus('Nothing to export yet. Log an entry first.', 'error');
      return;
    }
    if (downloadText(filename, text, format === 'csv' ? 'text/csv' : 'application/json')) {
      showStatus('Exported ' + count + (count === 1 ? ' entry' : ' entries') + ' to ' + filename + '.', 'ok');
      return;
    }
    const copied = await copyText(text);
    showStatus(copied
      ? 'The download was blocked, so the export was copied to your clipboard instead.'
      : 'Export failed: the browser blocked both the download and the clipboard.', copied ? 'ok' : 'error');
  }

  // ---------------------------------------------------------------------------
  // Footer
  // ---------------------------------------------------------------------------
  el('open-calendar-btn').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) chrome.tabs.create({ url: 'https://calendar.google.com' });
    else window.open('https://calendar.google.com', '_blank');
  });

  // Opening the popup grants activeTab, so the worker can read the page in
  // the current tab and show the quick-log card there.
  el('log-page-btn').addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ type: 'PT_LOG_FROM_TAB' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          showStatus('That page cannot be read. Open a job posting or application in the current tab.', 'error');
          return;
        }
        window.close();
      });
    } catch (err) {
      showStatus('Could not reach the LIT background worker: ' + errMsg(err), 'error');
    }
  });

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

  applyTheme(await TrackerStorage.getTheme());
  try {
    prefs = await TrackerStorage.getPrefs();
  } catch (err) {
    prefs = Object.assign({}, TrackerStorage.PREF_DEFAULTS);
  }
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
  if (focusSearch) openSearch();
});
