document.addEventListener('DOMContentLoaded', async () => {
  let metrics = [];
  let stats = null;
  let activeMetricId = 'jobs';
  let currentUser = null;

  let lcStatsToken = 0;

  // Widget layout (see shared/widgets.js). Rendered below the counter card.
  let widgetItems = [];
  const activityTokens = {};

  // Modal state
  let settingsMetricId = null;
  let metricDeleteArmed = false;
  let settingsWidgetId = null;
  let widgetRemoveArmed = false;

  const el = (id) => document.getElementById(id);

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

  // Modal plumbing: Escape to close, Tab trapped inside, focus restored on close
  let openModalEl = null;
  let modalReturnFocusEl = null;

  function focusableIn(container) {
    const nodes = container.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return Array.prototype.filter.call(nodes, n => !n.disabled && n.offsetParent !== null);
  }

  function openModal(modal, firstFieldId) {
    if (!modal) return;
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
    if (typeof closeTokenPopover === 'function') closeTokenPopover(false);
    target.classList.add('hidden');
    if (target === openModalEl) {
      openModalEl = null;
      if (modalReturnFocusEl && typeof modalReturnFocusEl.focus === 'function') {
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
  ['new-metric-modal', 'metric-settings-modal', 'email-signin-modal', 'add-widget-modal', 'widget-settings-modal', 'calorie-keys-modal'].forEach(id => {
    const modal = el(id);
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    }
  });

  function formatDateHeader() {
    return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  el('current-date-text').textContent = formatDateHeader();

  function applyTheme(theme) {
    const isDark = theme === 'dark';
    document.body.classList.toggle('pt-dark', isDark);
    const btn = el('theme-toggle-btn');
    if (btn) btn.textContent = isDark ? 'Light' : 'Dark';
  }

  const initialTheme = await TrackerStorage.getTheme();
  applyTheme(initialTheme);

  el('theme-toggle-btn').addEventListener('click', async () => {
    const isDark = document.body.classList.contains('pt-dark');
    const nextTheme = isDark ? 'light' : 'dark';
    applyTheme(nextTheme);
    await TrackerStorage.setTheme(nextTheme);
    notifyCalendarTabs();
  });

  // LeetCode Timer State
  //
  // The countdown is persisted as a DEADLINE in chrome.storage.local rather
  // than held as a decrementing counter. Closing the popup tears down this
  // script's context outright, so a counter would die with it. A deadline keeps
  // running while the popup is shut and is recovered, still correct, the next
  // time it opens. background/service-worker.js watches this same key and
  // mirrors it into chrome.alarms so zero is announced even with everything
  // closed.
  const TIMER_KEY = 'pt_timer_popup';
  const IDLE_TIMER = {
    status: 'idle',
    targetSeconds: 0,
    endsAt: null,
    remainingSeconds: 0,
    finishedAt: null,
    updatedAt: 0
  };

  let timerState = Object.assign({}, IDLE_TIMER);
  let timerTick = null;
  let announcedFinishAt = null;
  let timerInputAtFocus = null;

  const timerInput = el('timer-input');
  const timerToggleBtn = el('timer-toggle-btn');
  const timerResetBtn = el('timer-reset-btn');

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
    if (!raw || typeof raw !== 'object' || !raw.status) return Object.assign({}, IDLE_TIMER);
    return {
      status: raw.status,
      targetSeconds: Math.max(0, parseInt(raw.targetSeconds, 10) || 0),
      endsAt: Number.isFinite(raw.endsAt) ? raw.endsAt : null,
      remainingSeconds: Math.max(0, parseInt(raw.remainingSeconds, 10) || 0),
      finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
    };
  }

  function readStoredTimer() {
    return new Promise(resolve => {
      chrome.storage.local.get([TIMER_KEY], result => {
        if (chrome.runtime.lastError) {
          resolve(Object.assign({}, IDLE_TIMER));
          return;
        }
        resolve(normalizeTimerRecord(result && result[TIMER_KEY]));
      });
    });
  }

  // Writing the record is what arms or cancels the background alarm. The
  // service worker watches this key, so the popup never has to message it.
  function persistTimer(next) {
    timerState = Object.assign({}, next, { updatedAt: Date.now() });
    renderTimer();
    return new Promise(resolve => {
      chrome.storage.local.set({ [TIMER_KEY]: timerState }, () => resolve(true));
    });
  }

  // One render for every surface of the widget: the time, the status word,
  // the progress track, the preset highlight, and the toggle's label.
  function renderTimer() {
    if (!timerInput || !timerToggleBtn) return;
    const running = isTimerRunning();
    const remaining = timerRemaining();
    const target = timerState.targetSeconds;
    const finished = timerState.status === 'finished';
    const state = running ? 'running'
      : finished ? 'finished'
      : (timerState.status === 'paused' ? 'paused' : (remaining > 0 ? 'armed' : 'idle'));

    const widget = el('leetcode-timer-widget');
    if (widget) widget.dataset.state = state;

    const status = el('timer-status');
    if (status) {
      status.textContent = {
        idle: 'Set a length',
        armed: 'Ready',
        running: 'Running',
        paused: 'Paused',
        finished: 'Time is up'
      }[state];
    }

    timerToggleBtn.textContent = running ? 'Pause' : (finished ? 'Restart' : 'Start');
    timerToggleBtn.classList.toggle('running', running);
    timerToggleBtn.disabled = state === 'idle';

    // Never fight the user for the field while they are editing it.
    if (document.activeElement !== timerInput) {
      timerInput.value = TrackerStorage.formatSecondsToMMSS(remaining);
    }
    timerInput.classList.toggle('timer-expired', finished);

    const progress = el('timer-progress');
    if (progress) {
      const pct = target > 0 ? Math.min(100, Math.max(0, ((target - remaining) / target) * 100)) : 0;
      progress.style.width = pct + '%';
    }

    document.querySelectorAll('.timer-preset').forEach(btn => {
      const seconds = (parseInt(btn.dataset.minutes, 10) || 0) * 60;
      btn.classList.toggle('is-active', target === seconds && target > 0);
    });
  }

  // Kept for the existing call sites; rendering is now the whole job.
  function updateTimerInputDisplay() {
    renderTimer();
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

  function announceFinished(finishedAt) {
    // The popup and the service worker can both notice zero. Announce once.
    if (announcedFinishAt === finishedAt) return;
    announcedFinishAt = finishedAt;
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
      finishedAt: finishedAt
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
      finishedAt: null
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
      finishedAt: null
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
      finishedAt: null
    });
  }

  // Called once a solve has been logged: the countdown has served its purpose
  // and must not keep running or fire an alarm afterwards.
  async function clearTimerAfterLog() {
    stopRenderTick();
    announcedFinishAt = null;
    await persistTimer(Object.assign({}, IDLE_TIMER));
  }

  async function armTimer(seconds) {
    stopRenderTick();
    announcedFinishAt = null;
    await persistTimer({
      status: 'idle',
      targetSeconds: seconds,
      endsAt: null,
      remainingSeconds: seconds,
      finishedAt: null
    });
  }

  // Recovers whatever the countdown did while the popup was closed.
  async function hydrateTimer() {
    timerState = await readStoredTimer();
    if (timerState.status === 'running' && timerRemaining() <= 0) {
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
  if (TrackerStorage.onTimerChanged) {
    TrackerStorage.onTimerChanged(TIMER_KEY, (record) => {
      const next = normalizeTimerRecord(record);
      if (next.updatedAt === timerState.updatedAt) return;
      timerState = next;
      renderTimer();
      if (isTimerRunning()) startRenderTick(); else stopRenderTick();
      if (next.status === 'finished' && next.finishedAt) announceFinished(next.finishedAt);
    });
  }

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

  document.querySelectorAll('.timer-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const minutes = parseInt(btn.dataset.minutes, 10) || 0;
      if (minutes > 0) armTimer(minutes * 60);
    });
  });

  timerResetBtn.addEventListener('click', () => {
    resetTimer();
  });

  timerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      timerInput.blur();
    }
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

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || activeMetricId !== 'leetcode') return;
    if (openModalEl) return;
    // Space belongs to whatever control has focus; only claim it when nothing does
    const active = document.activeElement;
    const activeTag = active ? active.tagName.toLowerCase() : '';
    if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || activeTag === 'button') return;
    if (active && (active.isContentEditable || active.getAttribute('role') === 'button')) return;
    e.preventDefault();
    toggleTimer();
  });

  async function updateAuthUI() {
    currentUser = await TrackerAuth.getCurrentUser();
    const info = el('account-info');
    const signInBtn = el('account-signin-btn');

    if (currentUser && currentUser.email) {
      info.classList.remove('hidden');
      signInBtn.classList.add('hidden');
      el('account-email').textContent = currentUser.email;
      el('account-email').title = currentUser.email;
      renderAvatar(el('account-badge'), currentUser);
      const sub = el('account-sub');
      if (sub) {
        const expired = currentUser.sessionExpired === true;
        sub.textContent = expired
          ? 'Session expired. Sign out and back in to reconnect.'
          : (currentUser.token ? 'Google Account' : 'Google Account (email sign-in)');
        sub.classList.toggle('expired', expired);
      }
    } else {
      info.classList.add('hidden');
      signInBtn.classList.remove('hidden');
    }
  }

  // Google profile photo when OAuth supplied one, otherwise the initial.
  function renderAvatar(node, user) {
    if (!node) return;
    node.textContent = '';
    if (user.picture) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = user.picture;
      img.addEventListener('error', () => {
        node.textContent = (user.name || user.email)[0].toUpperCase();
      });
      node.appendChild(img);
      return;
    }
    node.textContent = (user.name || user.email)[0].toUpperCase();
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
    // 0.208 is the luminance at which white and #202124 give equal contrast
    // (0.179 would be the crossover against pure black, which we never use)
    return L > 0.208 ? '#202124' : '#ffffff';
  }

  async function loadData() {
    await updateAuthUI();
    [metrics, stats, widgetItems] = await Promise.all([
      TrackerStorage.getMetrics(),
      TrackerStorage.getStats(),
      WidgetLayout.load()
    ]);
    renderUI();
  }

  function renderUI() {
    const current = metrics.find(m => m.id === activeMetricId) || metrics[0];
    if (!current) return;
    activeMetricId = current.id;

    // Tabs
    const tabsContainer = el('metric-tabs');
    tabsContainer.innerHTML = '';
    metrics.forEach(m => {
      const tab = document.createElement('button');
      tab.className = 'tab-item' + (m.id === activeMetricId ? ' active' : '');
      if (m.id === activeMetricId) {
        tab.style.borderColor = m.color;
        tab.style.color = m.color;
      }

      const dot = document.createElement('span');
      dot.className = 'tab-dot';
      dot.style.backgroundColor = m.color;

      const label = document.createElement('span');
      label.textContent = m.name;

      tab.appendChild(dot);
      tab.appendChild(label);
      tab.addEventListener('click', () => { activeMetricId = m.id; renderUI(); });
      tabsContainer.appendChild(tab);
    });

    // Counter
    const todayCount = (stats && stats.today[activeMetricId]) || 0;

    el('metric-count').textContent = todayCount;
    el('metric-unit-label').textContent = (current.unit || 'items') + ' logged today';

    const unitSingular = (current.unit || 'items').replace(/s$/, '');
    el('quick-add-label').textContent = '+1 ' + unitSingular;
    const quickAdd = el('quick-add-btn');
    quickAdd.style.setProperty('--flow-color', current.color);
    quickAdd.style.setProperty('--flow-on-color', readableTextOn(current.color));

    // Calories is a budget to log conversationally, not a +1/-1 counter: swap
    // the action row for the calorie chat panel while that tab is selected.
    const isBudget = !!current.isBudget;
    const actionButtons = el('action-buttons');
    if (actionButtons) actionButtons.classList.toggle('hidden', isBudget);
    const caloriePanel = el('calorie-chat-widget');
    if (caloriePanel) caloriePanel.classList.toggle('hidden', !isBudget);
    if (isBudget) {
      initCalorieChatOnce();
      renderCalorieChatStatus();
      renderFoodLog();
    }

    // Streak follows the active tracker rather than always reporting Job Applications
    const metricStreak = computeStreak(activeMetricId);
    el('streak-count').textContent = metricStreak;
    const streakPill = el('streak-pill');
    if (streakPill) {
      streakPill.title = metricStreak > 0
        ? metricStreak + ' consecutive day(s) ' + (isBudget ? 'staying at or under the ' + current.name + ' daily budget' : 'hitting the ' + current.name + ' daily goal')
        : (isBudget ? 'No active ' + current.name + ' streak. Log a day at or under budget to start one.' : 'No active ' + current.name + ' streak. Hit today\'s daily goal to start one.');
    }

    // First-run guidance: only for an account with no data at all
    const firstRunCard = el('first-run-card');
    if (firstRunCard) {
      const hasAnyData = !!(stats && stats.totalLogs > 0);
      firstRunCard.classList.toggle('hidden', hasAnyData);
      if (!hasAnyData) {
        el('first-run-tips').textContent = 'Press "+1 ' + unitSingular + '" to log one instantly, or open "Add details" to record a company, role, or notes. '
          + 'Select the daily goal number below to change it, and use Export at the bottom to take your history with you.';
      }
    }

    renderWidgets();
  }

  // Consecutive days (ending today or yesterday) on which the tracker's daily
  // goal was met. Computed by TrackerStorage.getStats so every surface agrees.
  function computeStreak(metricId) {
    return (stats && stats.streaks && stats.streaks[metricId]) || 0;
  }

  // Cumulative solve-time block: today, all time, average, fastest, plus a trend line
  async function renderLeetcodeTimeStats() {
    const lcTimeStats = el('leetcode-time-stats');
    const note = el('leetcode-time-note');
    if (!lcTimeStats) return;

    const token = ++lcStatsToken;
    let timeStats;
    let lcLogs;
    try {
      [timeStats, lcLogs] = await Promise.all([
        TrackerStorage.getLeetcodeTimeStats(),
        TrackerStorage.getLogs({ metricId: 'leetcode' })
      ]);
    } catch (err) {
      showStatus('Could not load solve-time stats: ' + errMsg(err), 'error');
      return;
    }
    // Ignore a result that lost the race with a newer render, or whose widget
    // has since been hidden or removed.
    if (token !== lcStatsToken || !lcTimeStats.closest('.widget')) return;

    const timed = lcLogs.filter(l => (parseInt(l.solveTimeSeconds, 10) || 0) > 0);
    const bestSeconds = (typeof timeStats.bestSeconds === 'number' && timeStats.bestSeconds > 0)
      ? timeStats.bestSeconds
      : timed.reduce((best, l) => {
          const s = parseInt(l.solveTimeSeconds, 10) || 0;
          return (best === 0 || s < best) ? s : best;
        }, 0);

    el('lc-today-time').textContent = TrackerStorage.formatTimeHMS(timeStats.todaySeconds);
    el('lc-total-time').textContent = TrackerStorage.formatTimeHMS(timeStats.totalSeconds);
    el('lc-avg-time').textContent = timeStats.sessionCount > 0 ? TrackerStorage.formatTimeHMS(timeStats.avgSeconds) : '--';
    el('lc-best-time').textContent = bestSeconds > 0 ? TrackerStorage.formatTimeHMS(bestSeconds) : '--';

    if (!note) return;
    if (timed.length === 0) {
      note.classList.add('hidden');
      return;
    }
    const lastSeconds = parseInt(timed[0].solveTimeSeconds, 10) || 0;
    const diff = timeStats.avgSeconds - lastSeconds;
    let trend;
    if (timed.length < 2) {
      trend = 'your first timed solve.';
    } else if (diff > 0) {
      trend = TrackerStorage.formatTimeHMS(diff) + ' faster than your average.';
    } else if (diff < 0) {
      trend = TrackerStorage.formatTimeHMS(-diff) + ' slower than your average.';
    } else {
      trend = 'exactly your average pace.';
    }
    note.textContent = 'Last timed solve ' + TrackerStorage.formatTimeHMS(lastSeconds) + ' — ' + trend
      + ' Timed ' + timed.length + ' of ' + lcLogs.length + ' logged problems.';
    note.classList.remove('hidden');
  }

  // Google Sign In / Sign Out
  el('account-signin-btn').addEventListener('click', async () => {
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
      console.warn('Sign-in cancelled or failed:', errMsg(err));
      showStatus('Sign-in did not complete: ' + errMsg(err), 'error');
    }
  });

  // Direct email sign-in dialog (unpacked builds with no GCP client paired)
  el('email-signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = el('email-signin-input').value;
    try {
      await TrackerAuth.signInWithEmail(email);
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

  el('account-signout-btn').addEventListener('click', async () => {
    try {
      await TrackerAuth.signOut();
      showStatus('Signed out. Showing local, signed-out data.', 'ok');
      await loadData();
    } catch (err) {
      showStatus('Sign-out failed: ' + errMsg(err), 'error');
    }
  });

  function notifyCalendarTabs() {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({ url: '*://calendar.google.com/*' }, (tabs) => {
        if (tabs && tabs.length > 0) {
          tabs.forEach(tab => {
            chrome.tabs.sendMessage(tab.id, { type: 'PT_REFRESH' }).catch(() => {});
          });
        }
      });
    }
  }

  // +1
  el('quick-add-btn').addEventListener('click', async () => {
    el('metric-count').classList.add('bump');
    setTimeout(() => el('metric-count').classList.remove('bump'), 150);

    let notes = undefined;
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
      await TrackerStorage.addLog({
        metricId: activeMetricId,
        count: 1,
        notes: notes,
        solveTimeSeconds: solveTimeSeconds
      });
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
      const current = metrics.find(m => m.id === activeMetricId);
      showStatus('Nothing logged today for ' + (current ? current.name : 'this tracker') + ', so there is nothing to remove.', 'error');
      return;
    }
    showStatus('Removed the most recent entry logged today.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  // Details toggle
  el('toggle-details-btn').addEventListener('click', () => {
    const form = el('details-form');
    form.classList.toggle('hidden');
    const isOpen = !form.classList.contains('hidden');
    el('details-arrow').classList.toggle('open', isOpen);
    el('toggle-details-btn').setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (isOpen) el('detail-company').focus();
  });

  // Details submit
  el('details-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    let notes = el('detail-notes').value ? el('detail-notes').value.trim() : '';
    let solveTimeSeconds = 0;
    if (activeMetricId === 'leetcode' && timerState.targetSeconds > 0) {
      const elapsed = getElapsedSeconds();
      if (elapsed > 0) {
        const solveTimeStr = formatSolveTimeString(elapsed);
        notes = notes ? `${notes} (${solveTimeStr})` : solveTimeStr;
        solveTimeSeconds = elapsed;
      }
      await clearTimerAfterLog();
    }

    try {
      await TrackerStorage.addLog({
        metricId: activeMetricId,
        count: 1,
        company: el('detail-company').value,
        role: el('detail-role').value,
        notes: notes,
        solveTimeSeconds: solveTimeSeconds
      });
    } catch (err) {
      showStatus('Could not save that entry: ' + errMsg(err), 'error');
      return;
    }
    notifyCalendarTabs();
    el('detail-company').value = '';
    el('detail-role').value = '';
    el('detail-notes').value = '';
    el('details-form').classList.add('hidden');
    el('details-arrow').classList.remove('open');
    el('toggle-details-btn').setAttribute('aria-expanded', 'false');
    showStatus('Entry saved.', 'ok');
    await loadData();
  });

  // Open Google Calendar
  el('open-calendar-btn').addEventListener('click', () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.create({ url: 'https://calendar.google.com' });
    } else {
      window.open('https://calendar.google.com', '_blank');
    }
  });

  // New metric modal
  el('add-metric-tab-btn').addEventListener('click', () => {
    openModal(el('new-metric-modal'), 'new-metric-name');
  });

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
    const goalInput = el('new-metric-goal');
    const dailyGoal = goalInput ? parseInt(goalInput.value, 10) || 5 : 5;
    if (!name) {
      showStatus('Give the tracker a name before adding it.', 'error');
      el('new-metric-name').focus();
      return;
    }

    let created;
    try {
      created = await TrackerStorage.addMetric({ name, color: selectedColor, unit, dailyGoal, icon: 'custom' });
    } catch (err) {
      showStatus('Could not create that tracker: ' + errMsg(err), 'error');
      return;
    }
    activeMetricId = created.id;
    el('new-metric-name').value = '';
    if (goalInput) goalInput.value = '5';
    closeModal(el('new-metric-modal'));
    showStatus('Tracker "' + created.name + '" added.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  /* ---------- Widgets (add, remove, reorder, bind to a tracker) ---------- */

  const widgetsHost = el('widgets-host');
  const widgetParts = el('widget-parts');
  const GRIP_SVG = '<svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>';
  const GEAR_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';

  // One glyph per widget type so the add-widget list reads at a glance
  // instead of as a plain column of names.
  const WIDGET_TYPE_ICON = {
    goal: '<circle cx="7" cy="7" r="5.3" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="2.8" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="0.9" fill="currentColor"/>',
    summary: '<rect x="2" y="2.8" width="5.5" height="2" rx="1" fill="currentColor"/><rect x="2" y="6" width="8" height="2" rx="1" fill="currentColor"/><rect x="2" y="9.2" width="10" height="2" rx="1" fill="currentColor"/>',
    activity: '<rect x="2.3" y="7.5" width="2.6" height="4" rx="1" fill="currentColor"/><rect x="5.7" y="4.8" width="2.6" height="6.7" rx="1" fill="currentColor"/><rect x="9.1" y="2" width="2.6" height="9.5" rx="1" fill="currentColor"/>',
    streak: '<path d="M7 12.6c2.5 0 4-1.6 4-3.8 0-1.8-1-3-1.8-4.1.1 1.1-.5 1.7-1 1.7.4-1.8-.3-3.4-1.8-4.7-.1 1.4-.8 2.6-1.8 3.6-.9.9-1.4 2-1.4 3.3 0 2.2 1.4 4 3.8 4z" fill="currentColor"/>',
    timer: '<circle cx="7" cy="7.6" r="5" stroke="currentColor" stroke-width="1.3"/><path d="M7 5v2.6l2 1.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5.2 1.6h3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    timeStats: '<path d="M2 9.5a5 5 0 1 1 10 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M7 9.5 9.3 6.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="9.5" r="0.9" fill="currentColor"/>',
    details: '<rect x="2.5" y="1.8" width="9" height="10.4" rx="1.4" stroke="currentColor" stroke-width="1.2"/><path d="M4.8 5h4.4M4.8 7.3h4.4M4.8 9.6h2.8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>'
  };

  function metricFor(item) {
    const id = WidgetLayout.resolveMetricId(item, activeMetricId, metrics);
    return metrics.find(m => m.id === id) || metrics.find(m => m.id === activeMetricId) || metrics[0];
  }

  function goalFor(metric) {
    if (metric.dailyGoal) return metric.dailyGoal;
    if (metric.id === 'jobs') return 5;
    if (metric.id === 'leetcode') return 2;
    if (metric.id === 'calories') return 2000;
    return 1;
  }

  // Pinned widgets say which tracker they show; widgets that follow the tab
  // stay unlabeled so the common layout does not repeat the tab name.
  function pinLabel(item, metric) {
    return item.options.metricId !== WidgetLayout.ACTIVE ? metric.name : '';
  }

  function widgetShell(item) {
    const wrap = document.createElement('section');
    wrap.className = 'widget widget-' + item.type;
    wrap.dataset.widgetId = item.id;
    wrap.dataset.widgetType = item.type;
    const tools = document.createElement('div');
    tools.className = 'widget-tools';
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'widget-drag-handle';
    grip.title = 'Drag to reorder';
    grip.setAttribute('aria-label', 'Drag to reorder the ' + WidgetLayout.TYPES[item.type].name + ' widget');
    grip.innerHTML = GRIP_SVG;
    tools.appendChild(grip);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'widget-edit-btn';
    edit.title = 'Customize widget';
    edit.setAttribute('aria-label', 'Customize ' + WidgetLayout.TYPES[item.type].name + ' widget');
    edit.innerHTML = GEAR_SVG;
    tools.appendChild(edit);
    const body = document.createElement('div');
    body.className = 'widget-body';
    wrap.appendChild(body);
    wrap.appendChild(tools);
    return wrap;
  }

  // Singleton parts are moved, not cloned, so the timer's input state and
  // every listener bound at startup keep working wherever the widget sits.
  function placePart(body, partId) {
    const part = el(partId);
    if (!part) return null;
    if (part.parentElement !== body) body.appendChild(part);
    return part;
  }

  function parkPart(partId) {
    const part = el(partId);
    if (part && widgetParts && part.parentElement !== widgetParts) widgetParts.appendChild(part);
  }

  const PART_IDS = { timer: 'leetcode-timer-widget', timeStats: 'leetcode-time-block', details: 'details-section' };

  const WIDGET_RENDERERS = {
    goal(body, item, metric) {
      const isBudget = !!metric.isBudget;
      const todayCount = (stats && stats.today[metric.id]) || 0;
      const goal = goalFor(metric);
      const met = isBudget ? todayCount <= goal : todayCount >= goal;
      const pin = pinLabel(item, metric);
      if (!body.firstChild) {
        body.innerHTML = [
          '<div class="goal-meter">',
            '<div class="goal-header">',
              '<span class="goal-label"><span class="widget-pin"></span><span class="goal-label-text">Daily Goal</span>: <strong class="goal-target-num" role="button" tabindex="0" title="Open tracker settings (daily goal)"></strong></span>',
              '<span class="goal-status"></span>',
            '</div>',
            '<div class="goal-bar-wrap"><div class="goal-bar-fill"></div></div>',
          '</div>'
        ].join('');
      }
      body.querySelector('.widget-pin').textContent = pin ? pin + ' ' : '';
      body.querySelector('.goal-label-text').textContent = isBudget ? 'Daily Budget' : 'Daily Goal';
      const target = body.querySelector('.goal-target-num');
      target.textContent = goal;
      target.setAttribute('aria-label', (isBudget ? 'Daily budget' : 'Daily goal') + ' for ' + metric.name + ' is ' + goal + '. Select to change it.');
      const status = body.querySelector('.goal-status');
      status.textContent = todayCount + ' / ' + goal + (met ? (isBudget ? ' (Under Budget)' : ' (Goal Met)') : (isBudget ? ' (Over Budget)' : ''));
      status.style.color = met ? '#1e8e3e' : (isBudget ? '#d93025' : 'var(--text-main)');
      const fill = body.querySelector('.goal-bar-fill');
      fill.style.width = Math.min(100, Math.round((todayCount / goal) * 100)) + '%';
      fill.style.backgroundColor = met ? '#1e8e3e' : (isBudget ? '#d93025' : metric.color);
      fill.classList.toggle('goal-met', met);
    },

    summary(body, item, metric) {
      if (!body.firstChild) {
        body.innerHTML = [
          '<div class="summary-stats">',
            '<div class="stat-item"><span class="stat-value" data-stat="week">0</span><span class="stat-name">This Week</span></div>',
            '<div class="stat-divider"></div>',
            '<div class="stat-item"><span class="stat-value" data-stat="month">0</span><span class="stat-name">This Month</span></div>',
            '<div class="stat-divider"></div>',
            '<div class="stat-item"><span class="stat-value" data-stat="total">0</span><span class="stat-name">Total</span></div>',
          '</div>',
          '<div class="widget-caption"></div>'
        ].join('');
      }
      body.querySelector('[data-stat="week"]').textContent = (stats && stats.thisWeek[metric.id]) || 0;
      body.querySelector('[data-stat="month"]').textContent = (stats && stats.thisMonth[metric.id]) || 0;
      body.querySelector('[data-stat="total"]').textContent = (stats && stats.totals[metric.id]) || 0;
      const cap = body.querySelector('.widget-caption');
      const pin = pinLabel(item, metric);
      cap.textContent = pin;
      cap.classList.toggle('hidden', !pin);
    },

    streak(body, item, metric) {
      if (!body.firstChild) {
        body.innerHTML = [
          '<div class="summary-stats">',
            '<div class="stat-item"><span class="stat-value" data-stat="current">0</span><span class="stat-name">Current Streak</span></div>',
            '<div class="stat-divider"></div>',
            '<div class="stat-item"><span class="stat-value" data-stat="best">0</span><span class="stat-name">Longest Streak</span></div>',
          '</div>',
          '<div class="widget-caption"></div>'
        ].join('');
      }
      const current = computeStreak(metric.id);
      body.querySelector('[data-stat="current"]').textContent = current;
      body.querySelector('[data-stat="best"]').textContent = Math.max(current, computeLongestStreak(metric.id));
      const cap = body.querySelector('.widget-caption');
      const pin = pinLabel(item, metric);
      cap.textContent = pin ? pin + ' (days)' : '';
      cap.classList.toggle('hidden', !pin);
    },

    activity(body, item, metric) {
      const days = item.options.days;
      if (!body.firstChild) {
        body.innerHTML = [
          '<div class="activity-section">',
            '<button class="activity-toggle" type="button" aria-expanded="true">',
              '<span class="activity-title"></span>',
              '<span class="arrow-down open"></span>',
            '</button>',
            '<div class="activity-panel">',
              '<div class="activity-bars"></div>',
              '<div class="activity-stats-grid">',
                '<div><div class="act-stat-num" data-stat="total">0</div><div class="act-stat-lbl"></div></div>',
                '<div><div class="act-stat-num" data-stat="avg">0.0</div><div class="act-stat-lbl">Daily Avg</div></div>',
                '<div><div class="act-stat-num" data-stat="days">0</div><div class="act-stat-lbl">Active Days</div></div>',
                '<div><div class="act-stat-num" data-stat="best">0</div><div class="act-stat-lbl">Best Day</div></div>',
              '</div>',
            '</div>',
          '</div>'
        ].join('');
      }
      body.querySelector('.activity-title').textContent = days + '-Day ' + metric.name + ' Activity';
      const collapsed = !!item.options.collapsed;
      body.querySelector('.activity-toggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      body.querySelector('.arrow-down').classList.toggle('open', !collapsed);
      const panel = body.querySelector('.activity-panel');
      panel.classList.toggle('hidden', collapsed);
      const grid = body.querySelector('.activity-stats-grid');
      grid.classList.toggle('hidden', !item.options.showStats);
      grid.querySelector('[data-stat="total"]').nextElementSibling.textContent = days + 'D Total';
      if (collapsed) return;
      renderActivityBars(body, item, metric);
    },

    timer(body) {
      placePart(body, PART_IDS.timer);
      updateTimerInputDisplay();
    },

    timeStats(body) {
      placePart(body, PART_IDS.timeStats);
      renderLeetcodeTimeStats();
    },

    details(body) {
      placePart(body, PART_IDS.details);
    }
  };

  async function renderActivityBars(body, item, metric) {
    const token = (activityTokens[item.id] || 0) + 1;
    activityTokens[item.id] = token;
    let history;
    try {
      history = await TrackerStorage.getActivityHistory(item.options.days, metric.id);
    } catch (err) {
      showStatus('Could not load activity: ' + errMsg(err), 'error');
      return;
    }
    // A newer render for this widget, or its removal, wins.
    if (activityTokens[item.id] !== token || !body.isConnected) return;

    body.querySelector('[data-stat="total"]').textContent = history.totalCount;
    body.querySelector('[data-stat="avg"]').textContent = history.dailyAverage;
    body.querySelector('[data-stat="days"]').textContent = history.activeDaysCount;
    body.querySelector('[data-stat="best"]').textContent = history.bestDay.count;

    const bars = body.querySelector('.activity-bars');
    bars.innerHTML = '';
    const maxVal = Math.max(4, ...history.days.map(d => d.count));
    history.days.forEach(day => {
      const col = document.createElement('div');
      col.className = 'pop-bar-col';
      const bar = document.createElement('div');
      bar.className = 'pop-bar' + (day.count > 0 ? ' has-act' : '');
      bar.style.height = (day.count > 0 ? Math.max(10, Math.round((day.count / maxVal) * 100)) : 4) + '%';
      if (day.count > 0) bar.style.backgroundColor = metric.color;
      const tooltip = document.createElement('div');
      tooltip.className = 'pop-bar-tooltip';
      tooltip.textContent = day.label + ': ' + day.count;
      col.appendChild(bar);
      col.appendChild(tooltip);
      bars.appendChild(col);
    });
  }

  // Longest run of consecutive goal-met days over all history.
  function computeLongestStreak(metricId) {
    return (stats && stats.longestStreaks && stats.longestStreaks[metricId]) || 0;
  }

  // Reconciles the host against the layout: wrappers are created for new
  // items, removed for deleted ones, and re-appended in layout order (moving
  // a node keeps its contents). Then every visible widget is repainted.
  function renderWidgets() {
    if (!widgetsHost) return;
    const existing = {};
    Array.from(widgetsHost.children).forEach(node => { existing[node.dataset.widgetId] = node; });
    const keep = new Set();

    widgetItems.forEach(item => {
      const metric = metricFor(item);
      if (!metric) return;
      const visible = WidgetLayout.isVisible(item, metric.id);
      let wrap = existing[item.id];
      if (!visible) {
        if (PART_IDS[item.type]) parkPart(PART_IDS[item.type]);
        if (wrap) wrap.remove();
        return;
      }
      if (!wrap) wrap = widgetShell(item);
      keep.add(item.id);
      widgetsHost.appendChild(wrap);
      WIDGET_RENDERERS[item.type](wrap.querySelector('.widget-body'), item, metric);
    });

    Object.keys(existing).forEach(id => {
      if (keep.has(id)) return;
      const node = existing[id];
      const type = node.dataset.widgetType;
      if (PART_IDS[type]) parkPart(PART_IDS[type]);
      node.remove();
    });

    const note = el('leetcode-time-note');
    if (note && !note.closest('.widget')) note.classList.add('hidden');
  }

  function widgetById(id) {
    return widgetItems.find(i => i.id === id) || null;
  }

  async function applyLayout(promise, successMessage) {
    try {
      widgetItems = await promise;
    } catch (err) {
      showStatus('Could not update widgets: ' + errMsg(err), 'error');
      return false;
    }
    renderWidgets();
    if (successMessage) showStatus(successMessage, 'ok');
    return true;
  }

  // One delegated listener covers every widget: the gear, the collapsible
  // chart header, and the goal number that opens tracker settings.
  widgetsHost.addEventListener('click', (e) => {
    const wrap = e.target.closest('.widget');
    if (!wrap) return;
    const item = widgetById(wrap.dataset.widgetId);
    if (!item) return;
    if (e.target.closest('.widget-edit-btn')) {
      openWidgetSettings(item.id);
      return;
    }
    if (e.target.closest('.activity-toggle')) {
      applyLayout(WidgetLayout.update(item.id, { collapsed: !item.options.collapsed }));
      return;
    }
    if (e.target.closest('.goal-target-num')) {
      openMetricSettings(metricFor(item).id);
    }
  });

  widgetsHost.addEventListener('keydown', (e) => {
    if (!(e.key === 'Enter' || e.key === ' ' || e.code === 'Space')) return;
    const target = e.target.closest('.goal-target-num');
    if (!target) return;
    e.preventDefault();
    const wrap = target.closest('.widget');
    const item = wrap ? widgetById(wrap.dataset.widgetId) : null;
    if (item) openMetricSettings(metricFor(item).id);
  });

  /* Drag to reorder.
     Pointer events on the grip, not HTML5 drag and drop: the native version
     cannot be styled, misbehaves in extension popups, and has no touch
     story. The lifted widget follows the pointer; the others slide out of
     its way. On release the order is committed through WidgetLayout.reorder
     by naming the neighbour it lands in front of, so hidden widgets keep
     their place in the layout. */
  const WIDGET_GAP = 10;
  let drag = null;

  function dragMeasure() {
    const items = Array.from(widgetsHost.children);
    return {
      items,
      tops: items.map(el => el.getBoundingClientRect().top + window.scrollY),
      heights: items.map(el => el.getBoundingClientRect().height)
    };
  }

  function dragTargetIndex(d, centerY) {
    let to = 0;
    d.items.forEach((el, i) => {
      if (i === d.from) return;
      if (centerY > d.tops[i] + d.heights[i] / 2) to++;
    });
    return to;
  }

  function dragUpdate(clientY) {
    if (!drag) return;
    const d = drag;
    d.lastClientY = clientY;
    const pageY = clientY + window.scrollY;
    const dy = pageY - d.startPageY;
    d.wrap.style.transform = 'translateY(' + dy + 'px)';
    const center = d.tops[d.from] + d.heights[d.from] / 2 + dy;
    d.to = dragTargetIndex(d, center);
    const slide = d.heights[d.from] + WIDGET_GAP;
    d.items.forEach((el, i) => {
      if (i === d.from) return;
      let shift = 0;
      if (i < d.from && i >= d.to) shift = slide;
      else if (i > d.from && i <= d.to) shift = -slide;
      el.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
    // Nudge the popup's scroll when the pointer nears an edge so long layouts
    // can be reordered end to end. Runs only while a drag is live.
    const edge = 36;
    const speed = clientY < edge ? -6 : (clientY > window.innerHeight - edge ? 6 : 0);
    if (speed && !d.scrollRaf) {
      const step = () => {
        if (!drag || drag !== d) return;
        const before = window.scrollY;
        window.scrollBy(0, speed);
        if (window.scrollY !== before) dragUpdate(d.lastClientY);
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
    d.items.forEach(el => { el.style.transform = ''; });
    d.wrap.classList.remove('dragging');
    widgetsHost.classList.remove('drag-active');
    try { d.handle.releasePointerCapture(d.pointerId); } catch (e) { /* already released */ }
    if (!commit || d.to === d.from) return;
    const rest = d.items.filter(el => el !== d.wrap);
    const before = rest[d.to];
    applyLayout(WidgetLayout.reorder(d.id, before ? before.dataset.widgetId : null));
  }

  widgetsHost.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.widget-drag-handle');
    if (!handle || e.button !== 0) return;
    const wrap = handle.closest('.widget');
    if (!wrap) return;
    e.preventDefault();
    const m = dragMeasure();
    const from = m.items.indexOf(wrap);
    drag = {
      pointerId: e.pointerId,
      handle,
      wrap,
      id: wrap.dataset.widgetId,
      items: m.items,
      tops: m.tops,
      heights: m.heights,
      from,
      to: from,
      startPageY: e.clientY + window.scrollY,
      lastClientY: e.clientY,
      scrollRaf: 0
    };
    try { handle.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    wrap.classList.add('dragging');
    widgetsHost.classList.add('drag-active');
  });

  widgetsHost.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.pointerId) dragUpdate(e.clientY);
  });
  widgetsHost.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.pointerId) dragEnd(true);
  });
  widgetsHost.addEventListener('pointercancel', () => dragEnd(false));
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') { e.preventDefault(); dragEnd(false); }
  }, true);

  // The grip is for pointers; keyboard users reorder from the gear's
  // Position token. Arrow keys on a focused grip do the same one step at a time.
  widgetsHost.addEventListener('keydown', (e) => {
    const handle = e.target.closest && e.target.closest('.widget-drag-handle');
    if (!handle) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const wrap = handle.closest('.widget');
    const id = wrap && wrap.dataset.widgetId;
    if (!id) return;
    applyLayout(WidgetLayout.move(id, e.key === 'ArrowUp' ? -1 : 1)).then(() => {
      const again = widgetsHost.querySelector('[data-widget-id="' + id + '"] .widget-drag-handle');
      if (again) again.focus();
    });
  });

  /* Add widget picker */
  function renderWidgetPicker() {
    const list = el('add-widget-list');
    list.innerHTML = '';
    WidgetLayout.availableTypes(widgetItems).forEach(t => {
      const row = document.createElement('div');
      row.className = 'widget-picker-row';
      const icon = document.createElement('span');
      icon.className = 'widget-picker-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" fill="none" focusable="false">' + (WIDGET_TYPE_ICON[t.type] || '') + '</svg>';
      const text = document.createElement('div');
      text.className = 'widget-picker-text';
      const name = document.createElement('div');
      name.className = 'widget-picker-name';
      name.textContent = t.name;
      const desc = document.createElement('div');
      desc.className = 'widget-picker-desc';
      desc.textContent = t.description;
      text.appendChild(name);
      text.appendChild(desc);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'widget-add-btn' + (t.added ? ' added' : '');
      btn.innerHTML = t.added
        ? '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 6.2l2.2 2.3L9.5 3.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Added</span>'
        : '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true" focusable="false"><path d="M6 2.5v7M2.5 6h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Add</span>';
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

  /* Token popover: one floating list shared by every token value button.
     Anchored under (or above) the button that opened it, arrow-key
     navigable, closed by Escape, outside pointer, or a pick. Escape is
     caught in the capture phase so the modal underneath stays open. */
  const tokenPopover = el('token-popover');
  const tokenPopoverList = el('token-popover-list');
  let popoverState = null; // { anchor, items, onPick, active }

  function closeTokenPopover(restoreFocus) {
    if (!popoverState) return;
    const { anchor } = popoverState;
    popoverState = null;
    tokenPopover.classList.add('hidden');
    tokenPopoverList.innerHTML = '';
    anchor.setAttribute('aria-expanded', 'false');
    anchor.classList.remove('token-open');
    if (restoreFocus !== false) anchor.focus();
  }

  function placeTokenPopover(anchor) {
    const a = anchor.getBoundingClientRect();
    const w = tokenPopover.offsetWidth;
    const h = tokenPopover.offsetHeight;
    const gap = 6;
    let left = Math.max(8, Math.min(a.left, window.innerWidth - w - 8));
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
    Array.prototype.forEach.call(options, (li, i) => {
      li.classList.toggle('active', i === clamped);
    });
    tokenPopoverList.setAttribute('aria-activedescendant', options[clamped] ? options[clamped].id : '');
    if (options[clamped] && typeof options[clamped].scrollIntoView === 'function') {
      options[clamped].scrollIntoView({ block: 'nearest' });
    }
  }

  // items: [{ value, label, selected }]. onPick(value) runs after the popover closes.
  function openTokenPopover(anchor, items, onPick) {
    if (popoverState && popoverState.anchor === anchor) { closeTokenPopover(); return; }
    closeTokenPopover(false);
    tokenPopoverList.innerHTML = '';
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.id = 'token-option-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', item.selected ? 'true' : 'false');
      li.dataset.value = item.value;
      const label = document.createElement('span');
      label.className = 'token-option-label';
      label.textContent = item.label;
      li.appendChild(label);
      if (item.selected) {
        const check = document.createElement('span');
        check.className = 'token-option-check';
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
    const selectedIdx = Math.max(0, items.findIndex(i => i.selected));
    setPopoverActive(selectedIdx);
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

  // A changed value flashes once, the same cue as the filter bar's tokens.
  function flashToken(btn) {
    btn.classList.remove('token-flash');
    void btn.offsetWidth;
    btn.classList.add('token-flash');
  }

  /* Widget settings */
  let widgetDraft = null; // { metricId, days, showStats }

  function metricLabelFor(metricId) {
    if (metricId === WidgetLayout.ACTIVE) return 'Follow the selected tab';
    const m = metrics.find(x => x.id === metricId);
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

    el('widget-token-days').classList.toggle('hidden', !isActivity);
    el('widget-token-stats').classList.toggle('hidden', !isActivity);
    if (isActivity) {
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
      metricId: metrics.some(m => m.id === item.options.metricId) ? item.options.metricId : WidgetLayout.ACTIVE,
      days: item.options.days || 30,
      showStats: item.options.showStats !== false
    };
    const spec = WidgetLayout.TYPES[item.type];
    const bindable = 'metricId' in spec.defaults;

    el('widget-settings-title').textContent = spec.name;
    renderWidgetTokens();

    el('remove-widget-btn').querySelector('span').textContent = 'Remove widget';
    el('remove-widget-btn').classList.remove('armed');
    el('widget-settings-hint').textContent = spec.leetcodeOnly
      ? 'This widget only appears while the LeetCode tracker is selected.'
      : (spec.singleton ? 'Removing this widget hides it; add it back any time from the plus button.' : 'Removing a widget never deletes any logged data.');

    openModal(el('widget-settings-modal'), bindable ? 'widget-metric-btn' : 'widget-move-up-btn');
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
    const patch = {};
    if ('metricId' in WidgetLayout.TYPES[item.type].defaults) patch.metricId = widgetDraft.metricId;
    if (item.type === 'activity') {
      patch.days = widgetDraft.days;
      patch.showStats = widgetDraft.showStats;
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
    btn.querySelector('span').textContent = 'Remove widget';
    btn.classList.remove('armed');
    const ok = await applyLayout(WidgetLayout.remove(target), 'Widget removed.');
    if (ok) closeModal(el('widget-settings-modal'));
  });

  el('close-widget-settings-modal').addEventListener('click', () => closeModal(el('widget-settings-modal')));
  el('cancel-widget-settings-btn').addEventListener('click', () => closeModal(el('widget-settings-modal')));

  /* ---------- Tracker settings (daily goal, remove tracker) ---------- */

  function openMetricSettings(metricId) {
    const current = metrics.find(m => m.id === (metricId || activeMetricId));
    if (!current) return;
    settingsMetricId = current.id;
    metricDeleteArmed = false;

    const isBudget = !!current.isBudget;
    el('metric-settings-title').textContent = current.name + ' Settings';
    el('metric-settings-goal').value = current.dailyGoal || 1;

    el('goal-field-plain').classList.toggle('hidden', isBudget);
    const budgetUi = el('cal-budget-ui');
    if (budgetUi) {
      budgetUi.classList.toggle('hidden', !isBudget);
      if (isBudget) {
        el('cal-budget-number').value = current.dailyGoal || 2000;
        setCalorieMode('manual');
        prefillCalorieProfile();
      }
    }
    el('metric-settings-save-btn').textContent = isBudget ? 'Save Budget' : 'Save Goal';

    const isBuiltIn = !!current.isDefault || current.id === 'jobs' || current.id === 'leetcode';
    const deleteBtn = el('delete-metric-btn');
    deleteBtn.textContent = 'Delete tracker';
    deleteBtn.classList.toggle('hidden', isBuiltIn);
    el('metric-settings-hint').textContent = isBuiltIn
      ? (isBudget
        ? 'Built-in trackers cannot be removed. Changing the budget does not affect entries you already logged.'
        : 'Built-in trackers cannot be removed. Changing the goal does not affect entries you already logged.')
      : 'Deleting this tracker removes its tab. Entries you already logged stay in storage and in your exports.';

    openModal(el('metric-settings-modal'), isBudget ? 'cal-budget-number' : 'metric-settings-goal');
  }

  el('metric-settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const settingsIsBudget = !!(metrics.find(m => m.id === settingsMetricId) || {}).isBudget;
    const goal = parseInt(el('metric-settings-goal').value, 10);
    if (!goal || goal < 1) {
      showStatus('Enter a ' + (settingsIsBudget ? 'budget' : 'daily goal') + ' of 1 or more.', 'error');
      (settingsIsBudget ? el('cal-budget-number') : el('metric-settings-goal')).focus();
      return;
    }
    try {
      await TrackerStorage.setMetricGoal(settingsMetricId, goal);
    } catch (err) {
      showStatus('Could not save that ' + (settingsIsBudget ? 'budget' : 'goal') + ': ' + errMsg(err), 'error');
      return;
    }
    closeModal(el('metric-settings-modal'));
    showStatus(settingsIsBudget ? ('Daily budget set to ' + goal + ' kcal.') : ('Daily goal set to ' + goal + '.'), 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  el('delete-metric-btn').addEventListener('click', async () => {
    const btn = el('delete-metric-btn');
    if (!metricDeleteArmed) {
      metricDeleteArmed = true;
      btn.textContent = 'Select again to confirm';
      showStatus('Select "Select again to confirm" to remove this tracker.', 'error');
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
    btn.textContent = 'Delete tracker';
    if (!removed) {
      showStatus('That tracker could not be deleted.', 'error');
      return;
    }
    if (activeMetricId === settingsMetricId) activeMetricId = 'jobs';
    settingsMetricId = null;
    closeModal(el('metric-settings-modal'));
    showStatus('Tracker deleted. Its past entries are still in your export.', 'ok');
    notifyCalendarTabs();
    await loadData();
  });

  el('close-settings-modal').addEventListener('click', () => closeModal(el('metric-settings-modal')));
  el('cancel-settings-btn').addEventListener('click', () => closeModal(el('metric-settings-modal')));

  /* ---------- Calorie budget: stepper, mode toggle, profile, live preview ---------- */

  // The big stepper number is the only thing the user edits directly; it is
  // mirrored into the real (hidden-while-budget-mode) #metric-settings-goal
  // on every change so the existing submit handler needs no changes at all.
  const CAL_BUDGET_MIN = 200;
  const CAL_BUDGET_STEP = 50;

  function syncCalBudgetToGoalField() {
    const n = parseInt(el('cal-budget-number').value, 10);
    el('metric-settings-goal').value = isFinite(n) ? Math.max(CAL_BUDGET_MIN, n) : '';
  }

  el('cal-budget-number').addEventListener('input', syncCalBudgetToGoalField);

  el('cal-budget-dec').addEventListener('click', () => {
    const n = parseInt(el('cal-budget-number').value, 10) || 0;
    el('cal-budget-number').value = Math.max(CAL_BUDGET_MIN, n - CAL_BUDGET_STEP);
    syncCalBudgetToGoalField();
  });
  el('cal-budget-inc').addEventListener('click', () => {
    const n = parseInt(el('cal-budget-number').value, 10) || 0;
    el('cal-budget-number').value = n + CAL_BUDGET_STEP;
    syncCalBudgetToGoalField();
  });

  // Manual vs. From-profile is purely a display toggle for the assistant
  // panel below; the stepper above stays visible and editable either way.
  function setCalorieMode(mode) {
    const manual = mode !== 'profile';
    el('cal-mode-manual-btn').classList.toggle('active', manual);
    el('cal-mode-manual-btn').setAttribute('aria-selected', manual ? 'true' : 'false');
    el('cal-mode-profile-btn').classList.toggle('active', !manual);
    el('cal-mode-profile-btn').setAttribute('aria-selected', !manual ? 'true' : 'false');
    el('cal-mode-indicator').style.transform = manual ? 'translateX(0)' : 'translateX(100%)';
    el('calorie-profile-section').classList.toggle('hidden', manual);
  }
  el('cal-mode-manual-btn').addEventListener('click', () => setCalorieMode('manual'));
  el('cal-mode-profile-btn').addEventListener('click', () => setCalorieMode('profile'));

  function setActiveChip(groupEl, value) {
    Array.from(groupEl.children).forEach(btn => {
      const active = btn.dataset.value === value;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  el('calorie-sex-segmented').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-segment');
    if (!btn) return;
    setActiveChip(el('calorie-sex-segmented'), btn.dataset.value);
    updateCaloriePreview();
  });

  el('calorie-activity-chips').addEventListener('click', (e) => {
    const btn = e.target.closest('.cal-chip');
    if (!btn) return;
    setActiveChip(el('calorie-activity-chips'), btn.dataset.value);
    el('calorie-activity-desc').textContent = btn.dataset.desc || '';
    updateCaloriePreview();
  });

  el('calorie-profile-deficit').addEventListener('input', () => {
    el('calorie-deficit-value').textContent = el('calorie-profile-deficit').value + ' kcal';
    updateCaloriePreview();
  });

  ['calorie-profile-weight', 'calorie-profile-height', 'calorie-profile-age'].forEach(id => {
    el(id).addEventListener('input', updateCaloriePreview);
  });

  function currentCalorieProfile() {
    return {
      weightLb: parseFloat(el('calorie-profile-weight').value),
      heightIn: parseFloat(el('calorie-profile-height').value),
      age: parseFloat(el('calorie-profile-age').value),
      sex: el('calorie-sex-segmented').querySelector('.active').dataset.value,
      activityLevel: el('calorie-activity-chips').querySelector('.active').dataset.value,
      deficit: parseFloat(el('calorie-profile-deficit').value)
    };
  }

  let lastCalorieEstimate = null;

  function updateCaloriePreview() {
    const result = CalorieTracker.estimateCalorieBudget(currentCalorieProfile());
    lastCalorieEstimate = result;
    const bmrEl = el('calorie-preview-bmr');
    const tdeeEl = el('calorie-preview-tdee');
    const budgetEl = el('calorie-preview-budget');
    if (!result) {
      bmrEl.textContent = '—';
      tdeeEl.textContent = '—';
      budgetEl.textContent = '—';
      el('calorie-preview').classList.add('cal-preview-empty');
      return;
    }
    el('calorie-preview').classList.remove('cal-preview-empty');
    bmrEl.textContent = result.bmr.toLocaleString() + ' kcal';
    tdeeEl.textContent = '~' + result.tdee.toLocaleString() + ' kcal';
    budgetEl.textContent = result.suggestedBudget.toLocaleString() + ' kcal';
  }

  async function prefillCalorieProfile() {
    let profile;
    try {
      profile = await CalorieTracker.CalorieKeys.getProfile();
    } catch (err) {
      profile = null;
    }
    if (profile) {
      if (profile.weightLb) el('calorie-profile-weight').value = profile.weightLb;
      if (profile.heightIn) el('calorie-profile-height').value = profile.heightIn;
      if (profile.age) el('calorie-profile-age').value = profile.age;
      if (profile.sex) setActiveChip(el('calorie-sex-segmented'), profile.sex);
      if (profile.activityLevel) {
        setActiveChip(el('calorie-activity-chips'), profile.activityLevel);
        const activeChip = el('calorie-activity-chips').querySelector('.active');
        el('calorie-activity-desc').textContent = (activeChip && activeChip.dataset.desc) || '';
      }
      if (profile.deficit !== undefined) {
        el('calorie-profile-deficit').value = profile.deficit;
        el('calorie-deficit-value').textContent = profile.deficit + ' kcal';
      }
    }
    updateCaloriePreview();
  }

  el('calorie-profile-use-btn').addEventListener('click', async () => {
    if (!lastCalorieEstimate) return;
    el('cal-budget-number').value = lastCalorieEstimate.suggestedBudget;
    syncCalBudgetToGoalField();
    try {
      await CalorieTracker.CalorieKeys.saveProfile(currentCalorieProfile());
    } catch (err) {
      // Best effort: the number above is already applied either way.
    }
    showStatus('Budget updated to ' + lastCalorieEstimate.suggestedBudget + ' kcal. Save to keep it.', 'ok');
  });

  /* ---------- Calorie chat: conversational food logger ---------- */

  const calorieChat = {
    stage: 'idle', // 'idle' | 'asking' | 'working' | 'confirming'
    originalText: '',
    questions: [],
    questionIndex: 0,
    answers: {},
    initialized: false,
    logDate: '', // 'YYYY-MM-DD'; defaults to today in initCalorieChatOnce
    lastQuery: null,
    lastResult: null
  };

  function calorieMetric() {
    return metrics.find(m => m.id === 'calories') || null;
  }

  // Short "Sep 15" style label for the date picker/status line, without the
  // UTC-midnight day-shift bug of `new Date('YYYY-MM-DD')` in negative-offset
  // timezones -- parseLocalDateToNoon anchors it at local noon first.
  function formatLogDateLabel(dateStr) {
    return TrackerStorage.parseLocalDateToNoon(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // The chat used to say the exact same "Looking that up...", "Logged X
  // kcal..." etc. every single time, which reads as canned/robotic on a
  // feature you use several times a day. These pick a random phrasing each
  // time instead so the conversation doesn't feel identical on every entry.
  function pickVariant(options) {
    return options[Math.floor(Math.random() * options.length)];
  }

  const CALORIE_COPY = {
    checking: [
      'Let me check that...',
      'One sec, checking...',
      'Looking into that...',
      'Give me a moment to check...'
    ],
    lookingUp: [
      'Looking that up...',
      'Crunching the numbers...',
      'Checking nutrition data...',
      'Let me calculate that...'
    ],
    cancelled: [
      'Cancelled.',
      'No worries, cancelled.',
      'Scrapped that one.',
      'Okay, cancelled that.'
    ],
    couldNotSave(msg) {
      return pickVariant([
        'Could not save: ' + msg,
        "Hmm, that didn't save: " + msg,
        'Saving failed: ' + msg
      ]);
    },
    notFood(summary) {
      const suffix = summary ? ' (' + summary + ')' : '';
      return pickVariant([
        'That doesn\'t look like food' + suffix + ' — enter the calories yourself if you want to log it anyway:',
        'Doesn\'t seem to be something edible' + suffix + ' — you can still log a number by hand below:',
        'Not sure that\'s food' + suffix + ' — feel free to enter calories manually if you want it logged:'
      ]);
    },
    // Distinct from the "no key configured" message below: this is for when
    // Gemini WAS configured and tried, but the call errored or its answer
    // couldn't be parsed -- telling someone with a working key "no API key
    // configured" would be actively misleading.
    aiUnavailable(query) {
      return pickVariant([
        'Couldn\'t get an automatic read on "' + query + '" — enter the calories yourself:',
        'That one stumped the lookup — go ahead and enter the calories for "' + query + '" manually:',
        'No luck estimating "' + query + '" automatically this time — you can log the calories by hand:'
      ]);
    },
    logged(calVal, dayTotal, budget, remaining, dayLabel) {
      const overUnder = remaining >= 0 ? remaining + ' left' : Math.abs(remaining) + ' over';
      const dayPhrase = dayLabel ? dayLabel : 'Today';
      const dayPhraseLower = dayLabel ? dayLabel : 'today';
      return pickVariant([
        'Logged ' + calVal + ' kcal. ' + dayPhrase + ': ' + dayTotal + ' / ' + budget + ' kcal (' + overUnder + ').',
        calVal + ' kcal logged. You\'re at ' + dayTotal + ' of ' + budget + ' kcal ' + dayPhraseLower + ' (' + overUnder + ').',
        'Got it — ' + calVal + ' kcal added. Running total: ' + dayTotal + '/' + budget + ' kcal (' + overUnder + ').',
        'Added ' + calVal + ' kcal to the log. ' + dayTotal + ' / ' + budget + ' kcal so far (' + overUnder + ').'
      ]);
    }
  };

  function addCalorieMessage(text, role) {
    const list = el('calorie-chat-messages');
    if (!list) return null;
    const div = document.createElement('div');
    div.className = 'calorie-msg ' + role;
    div.textContent = text;
    list.appendChild(div);
    list.scrollTop = list.scrollHeight;
    return div;
  }

  function setCalorieComposerEnabled(enabled, placeholder) {
    const input = el('calorie-chat-input');
    const form = el('calorie-chat-form');
    const btn = form ? form.querySelector('.calorie-chat-send-btn') : null;
    if (input) {
      input.disabled = !enabled;
      if (placeholder) input.placeholder = placeholder;
    }
    if (btn) btn.disabled = !enabled;
  }

  function resetCalorieChat() {
    calorieChat.stage = 'idle';
    calorieChat.originalText = '';
    calorieChat.questions = [];
    calorieChat.questionIndex = 0;
    calorieChat.answers = {};
    setCalorieComposerEnabled(true, 'What did you eat? e.g. slice of bread');
  }

  function askNextCalorieQuestion() {
    const q = calorieChat.questions[calorieChat.questionIndex];
    if (!q) { runCalorieEstimate(); return; }
    addCalorieMessage(q.prompt, 'bot');
    setCalorieComposerEnabled(true, q.optional ? 'Answer, or type "no"' : 'Your answer');
  }

  async function runCalorieEstimate() {
    calorieChat.stage = 'working';
    setCalorieComposerEnabled(false, 'Working...');
    addCalorieMessage(pickVariant(CALORIE_COPY.lookingUp), 'system');
    const query = CalorieTracker.buildFollowupQuery(calorieChat.originalText, calorieChat.answers);
    let result;
    try {
      const credentials = await CalorieTracker.CalorieKeys.getCredentials();
      result = await CalorieTracker.estimateCalories({ query, credentials });
    } catch (err) {
      result = { calories: null, source: 'manual' };
    }
    showCalorieConfirm(query, result);
  }

  function showCalorieConfirm(query, result) {
    calorieChat.stage = 'confirming';
    calorieChat.lastQuery = query;
    calorieChat.lastResult = result;
    const list = el('calorie-chat-messages');
    if (!list) return;
    const wrap = document.createElement('div');
    wrap.className = 'calorie-msg-confirm';

    const summary = document.createElement('div');
    summary.className = 'calorie-msg-confirm-summary';
    if (result.calories !== null) {
      const label = result.source === 'nutritionix' ? 'Estimated'
        : result.source === 'ai' ? 'AI-estimated'
        : result.source === 'ai-search' ? 'AI-estimated (web search)'
        : result.source === 'cross-checked' ? 'Cross-checked'
        : result.source === 'ai-arbitrated' ? 'AI-arbitrated (sources disagreed)'
        : 'Roughly estimated (USDA fallback)';
      let summaryText = label + ' for "' + query + '"';
      if (result.summary && (result.source === 'ai' || result.source === 'ai-search' || result.source === 'ai-arbitrated')) {
        summaryText += ' (' + result.summary + ')';
      }
      summary.textContent = summaryText + ':';
      if (Array.isArray(result.checkedAgainst) && result.checkedAgainst.length > 1) {
        const detail = document.createElement('div');
        detail.className = 'calorie-msg-confirm-detail';
        detail.textContent = 'Checked: ' + result.checkedAgainst.map(c => c.source + ' ' + c.calories + ' kcal').join(', ');
        wrap.appendChild(detail);
      }
    } else if (result.reason === 'not-food') {
      summary.textContent = CALORIE_COPY.notFood(result.summary);
    } else if (result.reason === 'ai-error') {
      summary.textContent = CALORIE_COPY.aiUnavailable(query);
    } else {
      summary.textContent = 'Couldn\'t look up "' + query + '" (no API key configured yet, or nothing matched). Enter the calories yourself:';
    }
    wrap.appendChild(summary);

    const row = document.createElement('div');
    row.className = 'calorie-msg-confirm-row';
    const inputGroup = document.createElement('div');
    inputGroup.className = 'calorie-msg-confirm-input-group';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.value = result.calories !== null ? result.calories : '';
    input.placeholder = '0';
    input.setAttribute('aria-label', 'Calories for ' + query);
    const unitLabel = document.createElement('span');
    unitLabel.className = 'calorie-msg-confirm-unit';
    unitLabel.textContent = 'kcal';
    inputGroup.appendChild(input);
    inputGroup.appendChild(unitLabel);
    row.appendChild(inputGroup);
    wrap.appendChild(row);

    const actions = document.createElement('div');
    actions.className = 'calorie-msg-confirm-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'calorie-btn calorie-btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      wrap.remove();
      addCalorieMessage(pickVariant(CALORIE_COPY.cancelled), 'system');
      resetCalorieChat();
    });
    const logBtn = document.createElement('button');
    logBtn.type = 'button';
    logBtn.className = 'calorie-btn calorie-btn-accent';
    logBtn.textContent = 'Log entry';
    logBtn.addEventListener('click', async () => {
      const calVal = parseInt(input.value, 10);
      if (!isFinite(calVal) || calVal < 0) {
        input.focus();
        return;
      }
      logBtn.disabled = true;
      const logDate = calorieChat.logDate || TrackerStorage.getLocalDateStr();
      try {
        await TrackerStorage.addLog({ metricId: 'calories', count: calVal, notes: query, date: logDate });
      } catch (err) {
        addCalorieMessage(CALORIE_COPY.couldNotSave(errMsg(err)), 'system');
        logBtn.disabled = false;
        return;
      }
      wrap.remove();
      notifyCalendarTabs();
      await loadData();
      const m = calorieMetric();
      const budget = m ? goalFor(m) : 2000;
      const isToday = logDate === (stats && stats.todayStr);
      const dayTotal = (isToday ? (stats && stats.today.calories) : ((stats && stats.dailyMap[logDate]) || {}).calories) || 0;
      const remaining = budget - dayTotal;
      addCalorieMessage(CALORIE_COPY.logged(calVal, dayTotal, budget, remaining, isToday ? null : formatLogDateLabel(logDate)), 'system');
      renderCalorieChatStatus();
      renderFoodLog();
      resetCalorieChat();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(logBtn);
    wrap.appendChild(actions);

    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
    setCalorieComposerEnabled(false, 'Confirm the entry above first');
  }

  function startClarifyingFlow(trimmed) {
    calorieChat.originalText = trimmed;
    calorieChat.questions = CalorieTracker.getClarifyingQuestions(trimmed);
    calorieChat.questionIndex = 0;
    calorieChat.answers = {};
    calorieChat.stage = 'asking';
    askNextCalorieQuestion();
  }

  // Rigid canned questions ("what kind of bread", or worse, the generic
  // "...and the exact kind or brand?" for anything unrecognized) don't
  // actually know what's reasonable for a given food the way a model does --
  // and answering the generic one by just repeating the food name used to
  // literally duplicate it in the query (e.g. "crab" -> "crab crab"). So
  // when Gemini is configured, it's the one deciding/estimating for EVERY
  // entry, known-rule or not, instead of interrogating the user. The
  // keyword clarifying-question flow only kicks in as what's left for
  // people who haven't set up an AI key, or on an AI-side error -- and even
  // then, unrecognized food skips straight to a manual-entry prompt instead
  // of the old generic "brand" question.
  async function startFoodEntry(trimmed) {
    calorieChat.originalText = trimmed;
    calorieChat.stage = 'working';
    const credentials = await CalorieTracker.CalorieKeys.getCredentials();
    let aiFailureReason = null;
    if (credentials.geminiApiKey) {
      setCalorieComposerEnabled(false, 'Checking...');
      addCalorieMessage(pickVariant(CALORIE_COPY.checking), 'system');
      let result;
      try {
        result = await CalorieTracker.estimateCaloriesWithAI({ text: trimmed, credentials });
      } catch (err) {
        result = { isFood: null, calories: null, source: 'manual', reason: 'ai-error' };
      }
      if (result.isFood !== null) {
        showCalorieConfirm(trimmed, result);
        return;
      }
      // AI configured but unavailable/errored this time -- fall through, but
      // remember why so the eventual manual-entry message doesn't wrongly
      // tell someone with a working key that "no API key is configured".
      aiFailureReason = result.reason || 'ai-error';
    }
    if (CalorieTracker.hasKnownFoodRule(trimmed)) {
      startClarifyingFlow(trimmed);
    } else {
      showCalorieConfirm(trimmed, { calories: null, source: 'manual', reason: aiFailureReason || 'no-match' });
    }
  }

  function handleCalorieSubmit(text) {
    const trimmed = text.trim();
    if (!trimmed || calorieChat.stage === 'working' || calorieChat.stage === 'confirming') return;
    if (calorieChat.stage === 'idle') {
      addCalorieMessage(trimmed, 'user');
      startFoodEntry(trimmed);
      return;
    }
    addCalorieMessage(trimmed, 'user');
    const q = calorieChat.questions[calorieChat.questionIndex];
    if (q) calorieChat.answers[q.key] = trimmed;
    calorieChat.questionIndex++;
    askNextCalorieQuestion();
  }

  // Reports the budget/total for whichever date is selected in the "Logging
  // for" picker (today by default), not always today -- otherwise the status
  // pill would keep showing today's numbers while you're backdating entries
  // into a previous day, which would be actively misleading.
  function renderCalorieChatStatus() {
    const status = el('calorie-chat-status');
    if (!status) return;
    const m = calorieMetric();
    if (!m || !stats) {
      status.textContent = 'Ready';
      status.classList.remove('over-budget', 'under-budget');
      return;
    }
    const budget = goalFor(m);
    const isToday = calorieChat.logDate === stats.todayStr;
    const total = (isToday ? stats.today.calories : (stats.dailyMap[calorieChat.logDate] || {}).calories) || 0;
    status.textContent = total + ' / ' + budget + ' kcal' + (isToday ? ' today' : ' on ' + formatLogDateLabel(calorieChat.logDate));
    status.classList.toggle('over-budget', total > budget);
    status.classList.toggle('under-budget', total <= budget);
  }

  // Itemized record of what was actually eaten on the selected date. The
  // chat above is just the conversation used to arrive at a number; this is
  // the persistent log (backed by the same TrackerStorage logs every other
  // tracker uses) so past entries -- today's or a backdated day's -- can be
  // reviewed or removed individually.
  async function renderFoodLog() {
    const list = el('calorie-food-log-list');
    const totalEl = el('calorie-food-log-total');
    const titleEl = el('calorie-food-log-title');
    if (!list) return;
    const logDate = calorieChat.logDate || TrackerStorage.getLocalDateStr();
    const isToday = logDate === TrackerStorage.getLocalDateStr();
    if (titleEl) titleEl.textContent = isToday ? "Today's Log" : 'Log for ' + formatLogDateLabel(logDate);
    let logs;
    try {
      logs = await TrackerStorage.getLogs({ metricId: 'calories', startDate: logDate, endDate: logDate });
    } catch (err) {
      logs = [];
    }
    list.innerHTML = '';
    if (logs.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'calorie-food-log-empty';
      empty.textContent = isToday ? 'Nothing logged yet today.' : 'Nothing logged for this day.';
      list.appendChild(empty);
      if (totalEl) totalEl.textContent = '';
      return;
    }
    let total = 0;
    // getLogs returns newest first; show the day in the order it happened.
    logs.slice().reverse().forEach(log => {
      const count = log.count || 0;
      total += count;
      const item = document.createElement('li');
      item.className = 'calorie-food-log-item';

      const text = document.createElement('span');
      text.className = 'calorie-food-log-item-text';
      text.textContent = log.notes || 'Entry';
      text.title = log.notes || 'Entry';

      const cal = document.createElement('span');
      cal.className = 'calorie-food-log-item-cal';
      cal.textContent = count + ' kcal';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'calorie-food-log-item-del';
      delBtn.setAttribute('aria-label', 'Remove ' + (log.notes || 'this entry'));
      delBtn.innerHTML = '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true" focusable="false"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
      delBtn.addEventListener('click', async () => {
        delBtn.disabled = true;
        try {
          await TrackerStorage.deleteLog(log.id);
        } catch (err) {
          delBtn.disabled = false;
          return;
        }
        notifyCalendarTabs();
        await loadData();
        renderCalorieChatStatus();
        renderFoodLog();
      });

      item.appendChild(text);
      item.appendChild(cal);
      item.appendChild(delBtn);
      list.appendChild(item);
    });
    if (totalEl) totalEl.textContent = total + ' kcal total';
  }

  function setCalorieLogDate(dateStr) {
    const today = TrackerStorage.getLocalDateStr();
    calorieChat.logDate = dateStr && dateStr <= today ? dateStr : today;
    const dateInput = el('calorie-log-date');
    const todayBtn = el('calorie-log-date-today-btn');
    if (dateInput) dateInput.value = calorieChat.logDate;
    if (todayBtn) todayBtn.classList.toggle('hidden', calorieChat.logDate === today);
    renderCalorieChatStatus();
    renderFoodLog();
  }

  // A plain-text snapshot of the current calorie chat, meant to be pasted
  // straight into a bug report: the visible transcript, the last estimate
  // this session attempted (source/calories/summary/checkedAgainst -- never
  // the raw API keys, only whether each is configured), and the date/budget
  // context so a report doesn't need a screenshot to be actionable.
  function buildCalorieDebugText() {
    const lines = [];
    lines.push('Calorie chat debug dump -- ' + new Date().toISOString());
    try {
      lines.push('Extension version: ' + chrome.runtime.getManifest().version);
    } catch (err) { /* not running as an extension (e.g. dev shim) */ }
    lines.push('Log date: ' + (calorieChat.logDate || '(unset)'));
    lines.push('Chat stage: ' + calorieChat.stage);

    const messages = Array.from(document.querySelectorAll('#calorie-chat-messages .calorie-msg'));
    lines.push('', '--- Transcript (' + messages.length + ' messages) ---');
    messages.forEach(msgEl => {
      const role = Array.from(msgEl.classList).find(c => c !== 'calorie-msg') || 'msg';
      lines.push('[' + role + '] ' + msgEl.textContent.trim());
    });

    lines.push('', '--- Last estimate attempt ---');
    if (calorieChat.lastQuery !== null) {
      lines.push('Query: ' + calorieChat.lastQuery);
      lines.push('Result: ' + JSON.stringify(calorieChat.lastResult));
    } else {
      lines.push('(none yet this session)');
    }

    lines.push('', '--- Context ---');
    const m = calorieMetric();
    if (m && stats) {
      const budget = goalFor(m);
      const isToday = calorieChat.logDate === stats.todayStr;
      const total = (isToday ? stats.today.calories : (stats.dailyMap[calorieChat.logDate] || {}).calories) || 0;
      lines.push('Budget: ' + budget + ' kcal, logged for that date: ' + total + ' kcal');
    }
    return lines.join('\n');
  }

  // A misbehaving chat can make this very easy to mash; each open GitHub tab
  // is a real, visible action (and the issue body carries whatever the last
  // estimate attempt was), so it is rate-limited like any other send action:
  // at most 2 within a rolling 60s window. The button is disabled for the
  // remainder of that window and re-enabled automatically, not just left to
  // silently reject further clicks.
  const DEBUG_REPORT_MAX_PER_WINDOW = 2;
  const DEBUG_REPORT_WINDOW_MS = 60000;
  const DEBUG_REPORT_REPO_URL = 'https://github.com/kevit03/tracker';
  // Chrome's practical safe ceiling for a GET URL is ~8000 chars; stay well
  // under it since encodeURIComponent can triple the length of some text.
  const DEBUG_REPORT_MAX_BODY_CHARS = 6000;
  let debugReportClicks = [];
  let debugReportReenableTimer = null;

  function pruneDebugReportClicks() {
    const now = Date.now();
    debugReportClicks = debugReportClicks.filter(t => now - t < DEBUG_REPORT_WINDOW_MS);
    return now;
  }

  function updateDebugBtnAvailability() {
    const btn = el('calorie-debug-btn');
    if (!btn) return;
    const now = pruneDebugReportClicks();
    const atLimit = debugReportClicks.length >= DEBUG_REPORT_MAX_PER_WINDOW;
    btn.disabled = atLimit;
    clearTimeout(debugReportReenableTimer);
    if (atLimit) {
      const waitMs = DEBUG_REPORT_WINDOW_MS - (now - debugReportClicks[0]) + 50;
      debugReportReenableTimer = setTimeout(updateDebugBtnAvailability, Math.max(0, waitMs));
    }
  }

  // Builds the debug dump, copies it to the clipboard (best effort, kept as
  // a fallback), and opens a pre-filled "new issue" tab on this project's own
  // GitHub repo so the report is actually sent somewhere a maintainer will
  // see it rather than left sitting on the clipboard. The user still clicks
  // Submit on GitHub's page -- this never auto-submits anything on its own.
  async function sendCalorieDebugReport() {
    const text = buildCalorieDebugText();
    // API keys are configured booleans only -- never the actual key values --
    // appended after the fact so a failed clipboard write above still shows
    // the rest of the dump was built correctly.
    let credsLine = 'Keys configured: (unknown)';
    try {
      const creds = await CalorieTracker.CalorieKeys.getCredentials();
      credsLine = 'Keys configured: nutritionix=' + !!(creds.nutritionixAppId && creds.nutritionixApiKey)
        + ', usda=' + !!creds.usdaApiKey + ', gemini=' + !!creds.geminiApiKey;
    } catch (err) { /* leave as unknown */ }
    const fullText = text + '\n' + credsLine + '\n';

    let copied = false;
    try {
      await navigator.clipboard.writeText(fullText);
      copied = true;
    } catch (err) {
      // Clipboard API can be flaky/permission-gated inside an extension
      // popup; fall back to the classic hidden-textarea copy trick.
      try {
        const ta = document.createElement('textarea');
        ta.value = fullText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        copied = true;
      } catch (err2) { /* leave copied = false */ }
    }

    const truncated = fullText.length > DEBUG_REPORT_MAX_BODY_CHARS;
    const body = truncated
      ? fullText.slice(0, DEBUG_REPORT_MAX_BODY_CHARS) + '\n\n...(truncated -- the full report is on your clipboard)'
      : fullText;
    const issueUrl = DEBUG_REPORT_REPO_URL + '/issues/new?title=' + encodeURIComponent('Calorie tracker bug report')
      + '&body=' + encodeURIComponent(body);

    let opened = false;
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
        await new Promise((resolve, reject) => {
          chrome.tabs.create({ url: issueUrl }, (tab) => {
            if (chrome.runtime.lastError || !tab) reject(chrome.runtime.lastError || new Error('tab not created'));
            else resolve(tab);
          });
        });
        opened = true;
      } else if (typeof window !== 'undefined' && typeof window.open === 'function') {
        opened = !!window.open(issueUrl, '_blank');
      }
    } catch (err) {
      opened = false;
    }

    if (opened) {
      showStatus(copied ? 'Report opened on GitHub (and copied to clipboard) -- click Submit there to send it.' : 'Report opened on GitHub -- click Submit there to send it.', 'ok');
    } else if (copied) {
      showStatus('Could not open GitHub automatically. Debug info copied to clipboard -- paste it into a new issue.', 'error');
    } else {
      showStatus('Could not send or copy the report. Try again in a moment.', 'error');
    }
  }

  async function handleDebugReportClick() {
    const now = pruneDebugReportClicks();
    if (debugReportClicks.length >= DEBUG_REPORT_MAX_PER_WINDOW) {
      const waitSeconds = Math.ceil((DEBUG_REPORT_WINDOW_MS - (now - debugReportClicks[0])) / 1000);
      showStatus('You can send at most ' + DEBUG_REPORT_MAX_PER_WINDOW + ' reports per minute. Try again in ' + waitSeconds + 's.', 'error');
      return;
    }
    debugReportClicks.push(now);
    updateDebugBtnAvailability();
    try {
      await sendCalorieDebugReport();
    } catch (err) {
      showStatus('Could not send the report: ' + errMsg(err), 'error');
    }
  }

  function initCalorieChatOnce() {
    if (calorieChat.initialized) return;
    calorieChat.initialized = true;
    const form = el('calorie-chat-form');
    const input = el('calorie-chat-input');
    if (!form || !input) return;

    const debugBtn = el('calorie-debug-btn');
    if (debugBtn) debugBtn.addEventListener('click', handleDebugReportClick);

    const dateInput = el('calorie-log-date');
    const todayBtn = el('calorie-log-date-today-btn');
    const today = TrackerStorage.getLocalDateStr();
    if (dateInput) {
      dateInput.max = today;
      dateInput.value = today;
      calorieChat.logDate = today;
      dateInput.addEventListener('change', () => setCalorieLogDate(dateInput.value));
    } else {
      calorieChat.logDate = today;
    }
    if (todayBtn) todayBtn.addEventListener('click', () => setCalorieLogDate(today));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value;
      input.value = '';
      input.style.height = 'auto';
      handleCalorieSubmit(text);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(70, input.scrollHeight) + 'px';
    });

    el('calorie-keys-btn').addEventListener('click', async () => {
      const creds = await CalorieTracker.CalorieKeys.getCredentials();
      el('calorie-key-nix-id').value = creds.nutritionixAppId || '';
      el('calorie-key-nix-key').value = creds.nutritionixApiKey || '';
      el('calorie-key-usda').value = creds.usdaApiKey || '';
      el('calorie-key-gemini').value = creds.geminiApiKey || '';
      openModal(el('calorie-keys-modal'), 'calorie-key-nix-id');
    });
  }

  el('calorie-keys-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await CalorieTracker.CalorieKeys.saveCredentials({
      nutritionixAppId: el('calorie-key-nix-id').value,
      nutritionixApiKey: el('calorie-key-nix-key').value,
      usdaApiKey: el('calorie-key-usda').value,
      geminiApiKey: el('calorie-key-gemini').value
    });
    closeModal(el('calorie-keys-modal'));
    showStatus('Nutrition API keys saved.', 'ok');
  });
  el('close-calorie-keys-modal').addEventListener('click', () => closeModal(el('calorie-keys-modal')));
  el('cancel-calorie-keys-btn').addEventListener('click', () => closeModal(el('calorie-keys-modal')));

  /* ---------- Export ---------- */

  function csvCell(value) {
    const s = (value === null || value === undefined) ? '' : String(value);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function buildCsv(logs, metricNames) {
    const rows = ['date,time,tracker,count,company,role,notes,solve_time_seconds'];
    logs.forEach(l => {
      rows.push([
        csvCell(l.date),
        csvCell(l.timestamp),
        csvCell(metricNames[l.metricId] || l.metricId),
        csvCell(l.count || 1),
        csvCell(l.company),
        csvCell(l.role),
        csvCell(l.notes),
        csvCell(parseInt(l.solveTimeSeconds, 10) || 0)
      ].join(','));
    });
    return rows.join('\r\n');
  }

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
      console.warn('Download failed:', errMsg(err));
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
      console.warn('Clipboard copy failed:', errMsg(err));
    }
    return false;
  }

  async function exportData(format) {
    const isCsv = format === 'csv';
    let logs;
    try {
      logs = await TrackerStorage.getLogs({});
    } catch (err) {
      showStatus('Export failed: ' + errMsg(err), 'error');
      return;
    }
    if (logs.length === 0) {
      showStatus('Nothing to export yet. Log an entry first.', 'error');
      return;
    }

    // getLogs returns newest first; an export reads better oldest first
    const ordered = logs.slice().reverse();
    const metricNames = {};
    metrics.forEach(m => { metricNames[m.id] = m.name; });

    const text = isCsv
      ? buildCsv(ordered, metricNames)
      : JSON.stringify({
          exportedAt: new Date().toISOString(),
          account: (currentUser && currentUser.email) ? currentUser.email : null,
          metrics: metrics,
          logs: ordered
        }, null, 2);

    const filename = 'locked-in-tracker-' + TrackerStorage.getLocalDateStr() + (isCsv ? '.csv' : '.json');
    if (downloadText(filename, text, isCsv ? 'text/csv' : 'application/json')) {
      showStatus('Exported ' + ordered.length + ' entries to ' + filename + '.', 'ok');
      return;
    }
    const copied = await copyText(text);
    showStatus(copied
      ? 'The download was blocked, so the export was copied to your clipboard instead.'
      : 'Export failed: the browser blocked both the download and the clipboard.', copied ? 'ok' : 'error');
  }

  el('export-csv-btn').addEventListener('click', () => exportData('csv'));
  el('export-json-btn').addEventListener('click', () => exportData('json'));

  // Live sync from content script and auth changes
  TrackerStorage.onChanged(() => loadData());

  // The widget layout has its own listener so the calendar overlay, which
  // shares TrackerStorage.onChanged, never re-renders for a popup-only key.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if ((area !== 'sync' && area !== 'local') || !changes[WidgetLayout.STORAGE_KEY]) return;
      widgetItems = WidgetLayout.normalize(changes[WidgetLayout.STORAGE_KEY].newValue);
      renderWidgets();
    });
  }

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

  // Calories gets its own tab (like Jobs/LeetCode) instead of a widget, since
  // the whole point is a dedicated conversational logger, not a +1/-1 counter.
  // Idempotent: a no-op after the first run on any given install.
  try {
    await TrackerStorage.ensureCalorieMetric();
  } catch (err) {
    console.warn('Calorie tracker setup skipped:', errMsg(err));
  }

  await loadData();
});
