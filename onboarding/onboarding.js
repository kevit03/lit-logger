// LIT onboarding. Opened once by the service worker on a fresh install.
// Four skippable steps (focus areas, daily goal, autofill, daily check-in)
// and a finish screen. Each "Next" saves that step; "Skip" moves on without
// saving; "Skip setup" jumps to the end. Reaching the end sets
// prefs.onboardingDone.
(() => {
  const el = id => document.getElementById(id);
  const TOTAL_STEPS = 4;
  const UNIVERSAL_ORIGINS = ['*://*/*'];
  const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const ICONS = {
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18"/>',
    users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 14.2A5.5 5.5 0 0 1 20.5 19"/>',
    mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7.5 8 6 8-6"/>',
    target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8"/>',
    star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4l-4.8 2.5.9-5.4-3.9-3.8 5.4-.8Z"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>'
  };

  const FOCUS = [
    { id: 'jobs', label: 'Job applications', sub: 'Always on', icon: 'briefcase' },
    { id: 'networking', label: 'Networking chats', sub: 'Coffee chats, calls', icon: 'users' },
    { id: 'outreach', label: 'Cold emails', sub: 'Reaching out', icon: 'mail' },
    { id: 'prep', label: 'Interview prep', sub: 'Practice sessions', icon: 'target' },
    { id: 'portfolio', label: 'Portfolio pieces', sub: 'Projects, case studies', icon: 'star' },
    { id: 'leetcode', label: 'LeetCode', sub: 'Coding problems', icon: 'code' }
  ];

  // Shown Monday first; stored as 0 = Sunday .. 6 = Saturday.
  const DAYS = [
    { n: 1, short: 'Mon', name: 'Monday' }, { n: 2, short: 'Tue', name: 'Tuesday' },
    { n: 3, short: 'Wed', name: 'Wednesday' }, { n: 4, short: 'Thu', name: 'Thursday' },
    { n: 5, short: 'Fri', name: 'Friday' }, { n: 6, short: 'Sat', name: 'Saturday' },
    { n: 0, short: 'Sun', name: 'Sunday' }
  ];

  const VOICE_HINTS = {
    gentle: 'Soft and patient. No pressure, just a friendly hello.',
    coach: 'Warm and direct. Cheers you on, keeps you moving.',
    drill: 'Short and firm. Straight to the point, never mean.'
  };

  const state = {
    step: 1,
    focus: new Set(['jobs']),
    restDays: new Set(),
    voice: 'coach'
  };

  const hasStorage = typeof TrackerStorage !== 'undefined' && TrackerStorage;

  function setStatus(text) {
    el('status').textContent = text || '';
  }

  function svg(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
  }

  // ----- Appearance --------------------------------------------------------

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

  async function applyAppearance() {
    const root = document.documentElement;
    const theme = await readRawTheme();
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    if (!hasStorage) return;
    try {
      const prefs = await TrackerStorage.getPrefs();
      if (prefs.accent) root.dataset.accent = prefs.accent;
      root.dataset.comfort = prefs.comfortMode ? 'on' : 'off';
    } catch (e) {
      // Defaults in the markup.
    }
  }

  // ----- Navigation ---------------------------------------------------------

  function showStep(n) {
    state.step = n;
    document.querySelectorAll('.step').forEach(sec => {
      sec.hidden = Number(sec.dataset.step) !== n;
    });
    const finish = n > TOTAL_STEPS;
    el('progress').classList.toggle('is-hidden', finish);
    el('skip-all').hidden = finish;
    el('progress-label').textContent = 'Step ' + Math.min(n, TOTAL_STEPS) + ' of ' + TOTAL_STEPS;
    el('progress-bar').setAttribute('aria-valuenow', String(Math.min(n, TOTAL_STEPS)));
    el('progress-bar').querySelectorAll('span').forEach((s, i) => s.classList.toggle('on', i < n));
    document.querySelector('main').setAttribute('aria-labelledby', 'step-title-' + n);
    const heading = el('step-title-' + n);
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    setStatus('');
    if (finish) onFinish();
  }

  const SAVERS = { 1: saveFocus, 2: saveGoal, 3: async () => {}, 4: saveCheckin };

  document.querySelectorAll('[data-next]').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await SAVERS[state.step]();
    } catch (err) {
      setStatus('Could not save that step, but you can keep going. You can change it later in the popup.');
    }
    btn.disabled = false;
    showStep(state.step + 1);
  }));
  document.querySelectorAll('[data-skip]').forEach(btn => btn.addEventListener('click', () => showStep(state.step + 1)));
  document.querySelectorAll('[data-back]').forEach(btn => btn.addEventListener('click', () => showStep(Math.max(1, state.step - 1))));
  el('skip-all').addEventListener('click', () => showStep(TOTAL_STEPS + 1));

  // ----- Step 1: focus areas --------------------------------------------------

  function renderFocus() {
    const wrap = el('focus-chips');
    wrap.innerHTML = '';
    FOCUS.forEach(f => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.id = f.id;
      const on = state.focus.has(f.id);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (f.id === 'jobs') b.setAttribute('aria-disabled', 'true');
      b.innerHTML = svg(f.icon) + '<span class="chip-text"><span></span><span class="chip-sub"></span></span>';
      b.querySelector('.chip-text span').textContent = f.label;
      b.querySelector('.chip-sub').textContent = f.sub;
      b.addEventListener('click', () => {
        if (f.id === 'jobs') return;
        if (state.focus.has(f.id)) state.focus.delete(f.id);
        else state.focus.add(f.id);
        b.setAttribute('aria-pressed', state.focus.has(f.id) ? 'true' : 'false');
      });
      wrap.appendChild(b);
    });
  }

  async function saveFocus() {
    if (!hasStorage) return;
    const areas = FOCUS.map(f => f.id).filter(id => state.focus.has(id));
    // setFocusAreas also saves prefs.focusAreas; older storage builds only
    // get the preference.
    if (typeof TrackerStorage.setFocusAreas === 'function') await TrackerStorage.setFocusAreas(areas);
    else await TrackerStorage.setPrefs({ focusAreas: areas });
  }

  // ----- Step 2: goal, going for, rest days ----------------------------------

  function clampGoal(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 5;
  }

  function setGoal(v) {
    el('goal-input').value = String(clampGoal(v));
    updatePreview();
  }

  el('goal-minus').addEventListener('click', () => setGoal(clampGoal(el('goal-input').value) - 1));
  el('goal-plus').addEventListener('click', () => setGoal(clampGoal(el('goal-input').value) + 1));
  el('goal-input').addEventListener('change', () => setGoal(el('goal-input').value));

  function renderDays() {
    const wrap = el('rest-chips');
    wrap.innerHTML = '';
    DAYS.forEach(d => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = d.short;
      b.setAttribute('aria-label', d.name);
      b.setAttribute('aria-pressed', state.restDays.has(d.n) ? 'true' : 'false');
      b.addEventListener('click', () => {
        if (state.restDays.has(d.n)) state.restDays.delete(d.n);
        else if (state.restDays.size < 6) state.restDays.add(d.n);
        b.setAttribute('aria-pressed', state.restDays.has(d.n) ? 'true' : 'false');
      });
      wrap.appendChild(b);
    });
  }

  async function saveGoal() {
    if (!hasStorage) return;
    const goal = clampGoal(el('goal-input').value);
    await TrackerStorage.setMetricGoal('jobs', goal);
    await TrackerStorage.setPrefs({
      goingFor: el('going-for').value.trim().slice(0, 80),
      restDays: Array.from(state.restDays).sort((a, b) => a - b)
    });
  }

  // ----- Step 3: autofill and all-sites permission ------------------------------

  el('open-profile').addEventListener('click', () => {
    try {
      if (chrome.runtime && typeof chrome.runtime.openOptionsPage === 'function') chrome.runtime.openOptionsPage();
      else window.open(chrome.runtime.getURL('options/autofill.html'), '_blank');
    } catch (e) {
      setStatus('Open the autofill profile later from the LIT popup: Settings, then Autofill profile.');
    }
  });

  function showUniversalOn() {
    el('universal-state').hidden = false;
    el('universal-btn').hidden = true;
    el('universal-status').textContent = 'On. LIT will count applications on company career sites too. Turn it off any time in Settings.';
  }

  async function checkUniversal() {
    try {
      if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') {
        el('universal-card').hidden = true;
        return;
      }
      const granted = await chrome.permissions.contains({ origins: UNIVERSAL_ORIGINS });
      const prefs = hasStorage ? await TrackerStorage.getPrefs() : {};
      if (granted && prefs.universalTracking) showUniversalOn();
    } catch (e) {
      // Leave the button available.
    }
  }

  // chrome.permissions.request must run straight from the click.
  el('universal-btn').addEventListener('click', () => {
    let req;
    try {
      req = chrome.permissions.request({ origins: UNIVERSAL_ORIGINS });
    } catch (e) {
      el('universal-status').textContent = 'Chrome did not show the request. You can turn this on later in Settings.';
      return;
    }
    Promise.resolve(req).then(async granted => {
      if (!granted) {
        el('universal-status').textContent = 'No problem. LIT still counts applications on the supported job sites.';
        return;
      }
      if (hasStorage) await TrackerStorage.setPrefs({ universalTracking: true }).catch(() => {});
      showUniversalOn();
    }, () => {
      el('universal-status').textContent = 'Chrome did not show the request. You can turn this on later in Settings.';
    });
  });

  // ----- Step 4: daily check-in ----------------------------------------------------

  function fallbackReminder(count, goal, voice) {
    const left = Math.max(0, goal - count);
    if (voice === 'gentle') return { title: 'Checking in', body: 'You have sent ' + count + ' of ' + goal + ' today. Whatever you get to is progress.' };
    if (voice === 'drill') return { title: 'Check-in', body: count + ' of ' + goal + '. ' + left + ' to go. Get them in.' };
    return { title: 'Daily check-in', body: count + ' of ' + goal + ' applications sent. ' + left + ' more locks in today.' };
  }

  function updatePreview() {
    const goal = clampGoal(el('goal-input').value);
    const count = Math.min(2, Math.max(0, goal - 1));
    let copy = null;
    try {
      if (typeof LitCopy !== 'undefined' && LitCopy && typeof LitCopy.reminder === 'function') {
        copy = LitCopy.reminder({ count, goal, voice: state.voice });
      }
    } catch (e) {
      copy = null;
    }
    if (!copy || !copy.title) copy = fallbackReminder(count, goal, state.voice);
    el('preview-title').textContent = copy.title;
    el('preview-body').textContent = copy.body;
  }

  function setVoice(voice) {
    state.voice = VOICE_HINTS[voice] ? voice : 'coach';
    el('voice-group').querySelectorAll('[data-voice]').forEach(b => {
      b.setAttribute('aria-checked', b.dataset.voice === state.voice ? 'true' : 'false');
      b.tabIndex = b.dataset.voice === state.voice ? 0 : -1;
    });
    el('voice-hint').textContent = VOICE_HINTS[state.voice];
    updatePreview();
  }

  el('voice-group').addEventListener('click', e => {
    const b = e.target.closest('[data-voice]');
    if (b) setVoice(b.dataset.voice);
  });
  el('voice-group').addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const order = ['gentle', 'coach', 'drill'];
    const i = order.indexOf(state.voice) + (e.key === 'ArrowRight' ? 1 : -1);
    setVoice(order[(i + order.length) % order.length]);
    el('voice-group').querySelector('[aria-checked="true"]').focus();
    e.preventDefault();
  });

  function syncCheckinOptions() {
    el('checkin-options').classList.toggle('is-off', !el('checkin-on').checked);
  }
  el('checkin-on').addEventListener('change', syncCheckinOptions);

  async function saveCheckin() {
    if (!hasStorage) return;
    const time = el('checkin-time').value;
    const patch = { reminderEnabled: el('checkin-on').checked, coachVoice: state.voice };
    if (/^\d{2}:\d{2}$/.test(time)) patch.reminderTime = time;
    await TrackerStorage.setPrefs(patch);
  }

  // ----- Finish ---------------------------------------------------------------------

  async function onFinish() {
    const lock = el('finish-lock');
    lock.classList.remove('is-locked');
    // Let the open state paint before it shuts.
    setTimeout(() => {
      lock.classList.add('is-locked');
      el('brand-lock').classList.add('is-locked');
    }, reduceMotion ? 0 : 250);
    const goingFor = el('going-for').value.trim();
    el('finish-lede').textContent = goingFor
      ? 'Going for: ' + goingFor + '. LIT will count every application on the way.'
      : 'Go apply. LIT will count as you go.';
    if (!hasStorage) return;
    try {
      await TrackerStorage.setPrefs({ onboardingDone: true });
    } catch (e) {
      // Onboarding only opens on install, so a failed write costs nothing.
    }
  }

  el('open-calendar').addEventListener('click', () => {
    try {
      chrome.tabs.create({ url: 'https://calendar.google.com/' });
    } catch (e) {
      window.open('https://calendar.google.com/', '_blank', 'noopener');
    }
  });

  el('finish-done').addEventListener('click', async () => {
    try {
      if (chrome.action && typeof chrome.action.openPopup === 'function') {
        await chrome.action.openPopup();
        return;
      }
    } catch (e) {
      // Older Chrome: the popup cannot be opened from a page.
    }
    el('finish-done').textContent = 'Click the LIT padlock in your toolbar';
    el('finish-done').disabled = true;
  });

  // ----- Start ------------------------------------------------------------------------

  async function loadExisting() {
    if (!hasStorage) return;
    try {
      const [prefs, metrics] = await Promise.all([TrackerStorage.getPrefs(), TrackerStorage.getMetrics()]);
      (prefs.focusAreas || []).forEach(id => { if (FOCUS.some(f => f.id === id)) state.focus.add(id); });
      (prefs.restDays || []).forEach(n => state.restDays.add(n));
      if (prefs.goingFor) el('going-for').value = prefs.goingFor;
      if (prefs.reminderTime) el('checkin-time').value = prefs.reminderTime;
      el('checkin-on').checked = !!prefs.reminderEnabled;
      if (prefs.coachVoice) state.voice = prefs.coachVoice;
      const jobs = (metrics || []).find(m => m.id === 'jobs');
      if (jobs && jobs.dailyGoal) el('goal-input').value = String(clampGoal(jobs.dailyGoal));
    } catch (e) {
      // Fresh defaults.
    }
  }

  async function init() {
    await applyAppearance();
    await loadExisting();
    renderFocus();
    renderDays();
    setVoice(state.voice);
    syncCheckinOptions();
    checkUniversal();
    showStep(1);
  }

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(changes => {
      if (changes.pt_theme || changes.pt_prefs) applyAppearance();
    });
  }

  init();
})();
