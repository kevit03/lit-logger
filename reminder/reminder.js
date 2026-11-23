// LIT daily check-in. Opened from the check-in notification (the service
// worker never opens it on its own). Leads with today's applications and an
// encouraging line, shows the week, and offers one action: log what you did.
// The pep-talk video waits, collapsed and not autoplaying, under "Need a
// push?"; the time, voice, and off switch sit under their own disclosure.
(() => {
  const el = id => document.getElementById(id);
  // Job applications lead; if that goal is hidden, the first goal still on
  // the board stands in (set in load()).
  let METRIC = 'jobs';
  const VIDEO_ID = 'amXl7FG7J4c';
  const DAY_LETTERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = { count: 0, goal: 5, unit: 'applications', voice: 'coach', restToday: false, loggedIds: [] };

  function setStatus(text) {
    el('status').textContent = text || '';
  }

  function localDateStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // ----- Appearance ----------------------------------------------------------

  function readRawTheme() {
    return new Promise(resolve => {
      try {
        const area = chrome.storage.sync || chrome.storage.local;
        area.get(['pt_theme'], r => resolve(r && (r.pt_theme === 'dark' || r.pt_theme === 'light') ? r.pt_theme : null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function applyAppearance(prefs) {
    const root = document.documentElement;
    const theme = await readRawTheme();
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (prefs) {
      if (prefs.accent) root.dataset.accent = prefs.accent;
      root.dataset.comfort = prefs.comfortMode ? 'on' : 'off';
    }
  }

  // ----- Copy ------------------------------------------------------------------

  function headline() {
    const { count, goal, voice } = state;
    if (state.restToday && count < goal) return 'Rest day. Anything you log is a bonus.';
    try {
      if (typeof LitCopy !== 'undefined' && LitCopy && typeof LitCopy.headline === 'function') {
        const line = LitCopy.headline({ count, goal, voice });
        if (line) return String(line);
      }
    } catch (e) {
      // Fall through.
    }
    if (count >= goal) return 'Locked in for today.';
    if (count > 0) {
      const left = goal - count;
      return 'Nice, that\'s ' + count + '. ' + (left === 1 ? 'One more locks it in.' : left + ' more locks it in.');
    }
    return 'Ready when you are. Even one counts.';
  }

  // ----- Render ------------------------------------------------------------------

  function renderTally(animateLock) {
    el('count').textContent = String(state.count);
    el('goal-text').textContent = ' of ' + state.goal;
    el('unit').textContent = state.unit + ' sent today';
    el('headline').textContent = headline();
    const lock = el('lock');
    const met = state.count >= state.goal;
    lock.classList.toggle('is-resting', state.restToday && !met);
    if (met && animateLock && !reduceMotion) {
      lock.classList.remove('is-locked');
      requestAnimationFrame(() => requestAnimationFrame(() => lock.classList.add('is-locked')));
    } else {
      lock.classList.toggle('is-locked', met);
    }
    el('undo-btn').hidden = state.loggedIds.length === 0;
  }

  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 12.5 4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const REST = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 8h7l-7 8h7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const STATE_LABEL = { met: 'goal met', some: 'some sent', none: 'nothing logged', rest: 'rest day', frozen: 'streak freeze used', future: 'coming up' };

  function renderWeek(dots) {
    const list = el('week');
    list.innerHTML = '';
    dots.forEach((d, i) => {
      const li = document.createElement('li');
      if (d.isToday) li.className = 'today';
      const dot = document.createElement('span');
      dot.className = 'dot ' + d.state;
      if (d.state === 'met') dot.innerHTML = CHECK;
      else if (d.state === 'rest') dot.innerHTML = REST;
      const label = document.createElement('span');
      label.textContent = DAY_LETTERS[i];
      li.appendChild(dot);
      li.appendChild(label);
      li.setAttribute('aria-label', DAY_LETTERS[i] + (d.isToday ? ', today' : '') + ': ' + d.count + ', ' + (STATE_LABEL[d.state] || ''));
      list.appendChild(li);
    });
  }

  // Monday-first week built from the daily totals, for a storage build
  // without getWeekDots.
  function fallbackWeek(dailyMap, goal, restDays) {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const todayStr = localDateStr(today);
    const dots = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const date = localDateStr(d);
      const count = (dailyMap && dailyMap[date] && dailyMap[date][METRIC]) || 0;
      let st;
      if (date > todayStr) st = 'future';
      else if (count >= goal) st = 'met';
      else if ((restDays || []).includes(d.getDay())) st = 'rest';
      else if (count > 0) st = 'some';
      else st = 'none';
      dots.push({ date, count, goal, state: st, isToday: date === todayStr });
    }
    return dots;
  }

  async function load() {
    if (typeof TrackerStorage === 'undefined') return;
    let prefs = {};
    try { prefs = await TrackerStorage.getPrefs(); } catch (e) { prefs = {}; }
    applyAppearance(prefs);
    state.voice = prefs.coachVoice || 'coach';
    el('time-input').value = prefs.reminderTime || '14:30';
    setVoiceUI(state.voice);
    if (prefs.reminderEnabled === false) {
      el('off-btn').disabled = true;
      el('off-btn').textContent = 'The daily check-in is off';
    }

    try {
      const [stats, metrics] = await Promise.all([TrackerStorage.getStats(), TrackerStorage.getMetrics()]);
      const all = metrics || [];
      const shown = all.filter(m => m && !m.hidden);
      const metric = shown.find(m => m.id === 'jobs') || shown[0] || all.find(m => m.id === 'jobs');
      if (metric) METRIC = metric.id;
      state.goal = Math.max(1, parseInt(metric && metric.dailyGoal, 10) || 5);
      state.unit = metric && metric.id === 'jobs' && (!metric.unit || metric.unit === 'jobs' || metric.unit === 'items') ? 'applications' : ((metric && metric.unit) || 'applications');
      const counts = stats.todayCount || stats.today || {};
      state.count = Math.max(0, parseInt(counts[METRIC], 10) || 0);
      state.restToday = !!stats.restToday;
      renderTally(false);

      let dots = null;
      if (typeof TrackerStorage.getWeekDots === 'function') {
        try { dots = await TrackerStorage.getWeekDots(METRIC); } catch (e) { dots = null; }
      }
      if (!Array.isArray(dots) || dots.length !== 7) dots = fallbackWeek(stats.dailyMap, state.goal, prefs.restDays);
      renderWeek(dots);
    } catch (e) {
      renderTally(false);
    }
  }

  // ----- Log what I did ---------------------------------------------------------------

  el('log-btn').addEventListener('click', async () => {
    const btn = el('log-btn');
    btn.disabled = true;
    const wasMet = state.count >= state.goal;
    try {
      const log = await TrackerStorage.addLog({ metricId: METRIC, source: 'manual' });
      if (log && log.id) state.loggedIds.push(log.id);
      state.count += 1;
      renderTally(!wasMet && state.count >= state.goal);
      setStatus(state.count >= state.goal && !wasMet ? 'That locks in today.' : 'Logged. Tap again for each one you sent.');
      load();
    } catch (err) {
      setStatus('Could not log that. Try again from the LIT popup.');
    }
    btn.disabled = false;
  });

  el('undo-btn').addEventListener('click', async () => {
    const id = state.loggedIds.pop();
    if (!id) return;
    try {
      await TrackerStorage.deleteLog(id);
      state.count = Math.max(0, state.count - 1);
      renderTally(false);
      setStatus('Took that one back.');
      load();
    } catch (err) {
      state.loggedIds.push(id);
      setStatus('Could not undo that.');
    }
  });

  // ----- Need a push? (lazy, never autoplays) -----------------------------------------

  el('push').addEventListener('toggle', () => {
    const slot = el('video-slot');
    if (!el('push').open || slot.querySelector('iframe')) return;
    const frame = document.createElement('iframe');
    frame.title = 'Are you just living day to day?';
    frame.src = 'https://www.youtube-nocookie.com/embed/' + VIDEO_ID + '?rel=0&modestbranding=1';
    frame.allow = 'encrypted-media; picture-in-picture';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    slot.appendChild(frame);
  });

  // ----- Settings -----------------------------------------------------------------------

  function setVoiceUI(voice) {
    el('voice-group').querySelectorAll('[data-voice]').forEach(b => {
      b.setAttribute('aria-checked', b.dataset.voice === voice ? 'true' : 'false');
      b.tabIndex = b.dataset.voice === voice ? 0 : -1;
    });
  }

  el('voice-group').addEventListener('click', async e => {
    const b = e.target.closest('[data-voice]');
    if (!b) return;
    state.voice = b.dataset.voice;
    setVoiceUI(state.voice);
    el('headline').textContent = headline();
    try {
      await TrackerStorage.setPrefs({ coachVoice: state.voice });
      setStatus('Voice saved.');
    } catch (err) {
      setStatus('Could not save the voice.');
    }
  });

  el('time-input').addEventListener('change', async e => {
    const value = e.target.value;
    if (!/^\d{2}:\d{2}$/.test(value)) return;
    try {
      await TrackerStorage.setPrefs({ reminderTime: value, reminderEnabled: true });
      el('off-btn').disabled = false;
      el('off-btn').textContent = 'Turn off the daily check-in';
      setStatus('See you at ' + value + ' every day.');
    } catch (err) {
      setStatus('Could not save that time.');
    }
  });

  el('off-btn').addEventListener('click', async () => {
    try {
      await TrackerStorage.setPrefs({ reminderEnabled: false });
      el('off-btn').disabled = true;
      el('off-btn').textContent = 'The daily check-in is off';
      setStatus('Check-in turned off. Pick a time above to turn it back on.');
    } catch (err) {
      setStatus('Could not turn the check-in off.');
    }
  });

  // ----- Start ----------------------------------------------------------------------------

  function focusLogIfAsked() {
    if (location.hash !== '#log') return;
    const btn = el('log-btn');
    btn.focus();
    btn.classList.remove('pulse');
    void btn.offsetWidth;
    btn.classList.add('pulse');
  }
  window.addEventListener('hashchange', focusLogIfAsked);

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(changes => {
      if (changes.pt_theme) applyAppearance(null);
      if (changes.pt_logs_rev || changes.metrics || changes.pt_prefs) load();
    });
  }

  load().then(focusLogIfAsked);
})();
