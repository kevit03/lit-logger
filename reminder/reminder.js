// LIT daily check-in. Opened by the service worker's pt-reminder alarm.
// Shows today's tally for the selected tracker over the video, and lets the
// time be moved or the reminder turned off without opening the popup.
(() => {
  const el = id => document.getElementById(id);

  function applyTheme(theme) {
    document.body.classList.toggle('pt-dark', theme === 'dark');
  }

  function setStatus(text) {
    el('status').textContent = text;
  }

  async function loadTheme() {
    try {
      applyTheme(await TrackerStorage.getTheme());
    } catch (e) {
      // The light theme is fine if the read fails.
    }
  }

  async function loadTally() {
    try {
      const [metricId, metrics] = await Promise.all([TrackerStorage.getActiveMetricId(), TrackerStorage.getMetrics()]);
      const metric = metrics.find(m => m.id === metricId) || metrics.find(m => m.id === 'jobs') || metrics[0];
      if (!metric) return;
      const history = await TrackerStorage.getActivityHistory(1, metric.id);
      const n = history.totalCount;
      const noun = (metric.name || 'entries').toLowerCase();
      el('tally').textContent = n > 0
        ? n + ' logged today for ' + noun + '. Keep it moving.'
        : 'Nothing logged today for ' + noun + ' yet.';
    } catch (e) {
      // The tally is a nicety; the page still works without it.
    }
  }

  async function loadPrefs() {
    try {
      const prefs = await TrackerStorage.getPrefs();
      el('time-input').value = prefs.reminderTime || '14:30';
      if (!prefs.reminderEnabled) setStatus('The daily reminder is off. Turn it back on from Settings in the popup.');
    } catch (e) {
      // Defaults stay in the markup.
    }
  }

  el('done-btn').addEventListener('click', () => {
    window.close();
  });

  el('time-input').addEventListener('change', async (e) => {
    const value = e.target.value;
    if (!/^\d{2}:\d{2}$/.test(value)) return;
    try {
      await TrackerStorage.setPrefs({ reminderTime: value, reminderEnabled: true });
      setStatus('Moved to ' + value + ' every day.');
    } catch (err) {
      setStatus('Could not save that time.');
    }
  });

  el('off-btn').addEventListener('click', async () => {
    try {
      await TrackerStorage.setPrefs({ reminderEnabled: false });
      setStatus('Daily reminder turned off. Turn it back on from Settings in the popup.');
      el('off-btn').disabled = true;
    } catch (err) {
      setStatus('Could not turn the reminder off.');
    }
  });

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(changes => {
      if (changes.pt_theme) applyTheme(changes.pt_theme.newValue);
    });
  }

  loadTheme();
  loadTally();
  loadPrefs();
})();
