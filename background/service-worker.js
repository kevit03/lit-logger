// Background service worker for LIT.
//
// Jobs, in the order they appear below:
//
//   Storage host    Content scripts cannot reach the extension's IndexedDB
//                   (theirs belongs to the page), so they send log calls
//                   here and TrackerStorage.serveRemote answers them.
//   Solve timer     Mirrors the popup's countdown into chrome.alarms so zero
//                   is announced with every page closed.
//   Shortcuts       Alt+Shift+A logs +1 to the tracker last selected in the
//                   popup; Alt+Shift+J opens the popup with search focused.
//   Quick log       "Log application from this page" in the page and toolbar
//                   context menus injects content/quick-log.js on demand.
//   Universal       With the optional all-sites permission granted and the
//                   setting on, a tiny bootstrap runs on every page and asks
//                   for the full universal tracker only on job pages.
//   Maintenance     A periodic alarm takes the weekly local snapshot.
//
// The solve timers are persisted as a DEADLINE, never as a decrementing
// counter. A counter driven by setInterval dies with its page and is throttled
// to roughly one tick per minute in an unfocused tab; a deadline survives both,
// because every surface derives its remaining time from Date.now() at render.
//
// Timer state contract. One record per surface, written only by that surface:
//
//   chrome.storage.local['pt_timer_popup']   owned by popup/popup.js
//
//   {
//     status: 'idle' | 'running' | 'paused' | 'finished',
//     targetSeconds: integer,      the armed countdown length
//     endsAt: epoch ms | null,     authoritative while status is 'running'
//     remainingSeconds: integer,   authoritative while status is not 'running'
//     finishedAt: epoch ms | null,
//     laps: [elapsedSeconds],      split times recorded while running
//     updatedAt: epoch ms
//   }
//
// This worker does not drive the timer. It writes a record exactly once per
// countdown, to close it out at zero.

importScripts('../shared/auth.js', '../shared/db.js', '../shared/storage.js');

TrackerStorage.serveRemote();

const TIMER_SURFACES = {
  pt_timer_popup: { alarm: 'pt-timer-popup', label: 'Solve timer' }
};

// The calendar dock and its timer were removed in 1.3; an install upgrading
// from an older build may still hold its record and alarm.
const LEGACY_DOCK_TIMER_KEY = 'pt_timer_dock';
const LEGACY_DOCK_ALARM = 'pt-timer-dock';

// Matches MAX_TIMER_SECONDS in shared/storage.js. A free-text field must never
// be able to arm an alarm further out than a day.
const MAX_TIMER_SECONDS = 86400;
const MAX_LAPS = 50;

const MAINTENANCE_ALARM = 'pt-maintenance';
const MAINTENANCE_PERIOD_MINUTES = 360;

const MENU_LOG_PAGE = 'lit-log-page';
const MENU_LOG_ACTION = 'lit-log-page-action';

const COMMAND_INCREMENT = 'increment-active';
const COMMAND_SEARCH = 'open-search';
const OPEN_SEARCH_FLAG = 'pt_open_search_at';

const UNIVERSAL_SCRIPT_ID = 'lit-universal-bootstrap';
const UNIVERSAL_ORIGINS = ['*://*/*'];

// Files the on-demand scripts need, keyed by the global each one defines, in
// load order. A frame that already has one (a statically matched page) is
// not given a second copy: redeclaring a top-level const would throw.
const SHARED_FILES = [
  ['TrackerAuth', 'shared/auth.js'],
  ['TrackerStorage', 'shared/storage.js'],
  ['AutoTrackerCore', 'shared/auto-tracker-core.js'],
  ['JobMeta', 'shared/job-meta.js']
];

// Autofill rides along with the universal tracker. The store and core define
// top-level consts and get the same one-copy guard; the site adapters and the
// button script are safe to load twice.
const AUTOFILL_SHARED = [
  ['AutofillStore', 'shared/autofill-store.js'],
  ['AutofillCore', 'shared/autofill-core.js']
];
const AUTOFILL_FILES = [
  'content/autofill/sites/greenhouse.js',
  'content/autofill/sites/lever.js',
  'content/autofill/sites/ashby.js',
  'content/autofill/sites/workday.js',
  'content/autofill/autofill-ui.js'
];
const AUTOFILL_CSS = ['content/autofill/autofill-ui.css'];

function alarmNameFor(key) {
  return TIMER_SURFACES[key] ? TIMER_SURFACES[key].alarm : null;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, parseInt(totalSeconds, 10) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) return hrs + 'h ' + mins + 'm';
  if (mins > 0 && secs > 0) return mins + 'm ' + secs + 's';
  if (mins > 0) return mins + 'm';
  return secs + 's';
}

// Tolerates a missing, malformed, or partially written record rather than
// throwing inside an event handler the browser will not retry.
function normalizeTimer(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = raw.status;
  if (status !== 'idle' && status !== 'running' && status !== 'paused' && status !== 'finished') {
    return null;
  }
  const target = Math.min(MAX_TIMER_SECONDS, Math.max(0, parseInt(raw.targetSeconds, 10) || 0));
  const remaining = Math.min(MAX_TIMER_SECONDS, Math.max(0, parseInt(raw.remainingSeconds, 10) || 0));
  const endsAt = Number.isFinite(raw.endsAt) ? raw.endsAt : null;
  if (status === 'running' && endsAt === null) return null;
  const laps = Array.isArray(raw.laps)
    ? raw.laps.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n >= 0).slice(0, MAX_LAPS)
    : [];
  return {
    status,
    targetSeconds: target,
    endsAt,
    remainingSeconds: remaining,
    finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
    laps,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  };
}

function readTimer(key) {
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(normalizeTimer(result && result[key]));
    });
  });
}

function writeTimer(key, state) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: state }, () => resolve(!chrome.runtime.lastError));
  });
}

// Mirrors one record into chrome.alarms. Chrome clamps alarm delays, so a
// deadline under the clamp floor is settled immediately instead of scheduled.
async function syncAlarm(key, state) {
  const alarm = alarmNameFor(key);
  if (!alarm) return;

  if (!state || state.status !== 'running') {
    await chrome.alarms.clear(alarm);
    return;
  }

  if (state.endsAt <= Date.now()) {
    await chrome.alarms.clear(alarm);
    await settleTimer(key);
    return;
  }

  // create() replaces an alarm of the same name, so a restart or an edit of a
  // running countdown cannot leave two alarms racing for one surface.
  await chrome.alarms.create(alarm, { when: state.endsAt });
}

async function notifyFinished(key, state) {
  if (!chrome.notifications) return;
  let prefs = null;
  try { prefs = await TrackerStorage.getPrefs(); } catch (e) { prefs = null; }
  if (prefs && prefs.timerDesktop === false) return;
  const surface = TIMER_SURFACES[key];
  const label = surface ? surface.label : 'Timer';
  const lengthText = state && state.targetSeconds > 0
    ? ' Countdown length was ' + formatDuration(state.targetSeconds) + '.'
    : '';
  chrome.notifications.create(surface ? surface.alarm : key, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: label + ' finished',
    message: 'Your LeetCode countdown reached zero.' + lengthText,
    priority: 2,
    requireInteraction: true,
    silent: !!(prefs && prefs.timerSound === false)
  });
}

// Closes out a countdown whose deadline has passed. Writing 'finished' is
// idempotent: a record already finished is left alone, so a duplicate alarm or
// a startup reconcile cannot fire two notifications for one countdown.
async function settleTimer(key) {
  const state = await readTimer(key);
  if (!state || state.status !== 'running') return;
  if (state.endsAt === null || state.endsAt > Date.now()) return;

  const finished = {
    status: 'finished',
    targetSeconds: state.targetSeconds,
    endsAt: null,
    remainingSeconds: 0,
    finishedAt: state.endsAt,
    laps: state.laps,
    updatedAt: Date.now()
  };
  await writeTimer(key, finished);
  await notifyFinished(key, state);
}

// Rebuilds alarm state from storage. Alarms do not survive a browser restart,
// so without this a countdown armed before a restart would sit 'running'
// forever and never resolve.
async function reconcileTimers() {
  for (const key of Object.keys(TIMER_SURFACES)) {
    const state = await readTimer(key);
    await syncAlarm(key, state);
  }
  try {
    await chrome.alarms.clear(LEGACY_DOCK_ALARM);
    chrome.storage.local.remove(LEGACY_DOCK_TIMER_KEY, () => { void chrome.runtime.lastError; });
  } catch (e) {
    // Nothing to clean up on a fresh install.
  }
}

// ---------------------------------------------------------------------------
// Maintenance: weekly snapshot, legacy sync cleanup
// ---------------------------------------------------------------------------
async function ensureMaintenanceAlarm() {
  const existing = await chrome.alarms.get(MAINTENANCE_ALARM);
  if (!existing) {
    await chrome.alarms.create(MAINTENANCE_ALARM, { delayInMinutes: 1, periodInMinutes: MAINTENANCE_PERIOD_MINUTES });
  }
}

async function runMaintenance() {
  try {
    await TrackerStorage.maybeAutoSnapshot();
  } catch (err) {
    console.warn('LIT: weekly snapshot skipped:', err && err.message);
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MAINTENANCE_ALARM) {
    runMaintenance();
    return;
  }
  const key = Object.keys(TIMER_SURFACES).find(k => TIMER_SURFACES[k].alarm === alarm.name);
  if (!key) return;
  settleTimer(key);
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
let badgeTimer = null;

function flashBadge(text, color) {
  if (!chrome.action) return;
  try {
    chrome.action.setBadgeBackgroundColor({ color: /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#1a73e8' });
    chrome.action.setBadgeText({ text });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      try { chrome.action.setBadgeText({ text: '' }); } catch (e) { /* worker torn down */ }
    }, 1800);
  } catch (e) {
    // Badge feedback is cosmetic.
  }
}

async function incrementActiveTracker() {
  const [metricId, metrics] = await Promise.all([
    TrackerStorage.getActiveMetricId(),
    TrackerStorage.getMetrics()
  ]);
  const metric = metrics.find(m => m.id === metricId) || metrics.find(m => m.id === 'jobs') || metrics[0];
  if (!metric) return null;
  const log = await TrackerStorage.addLog({ metricId: metric.id, source: 'shortcut' });
  flashBadge('+1', metric.color);
  return log;
}

async function openPopupWithSearch() {
  const area = chrome.storage.session || chrome.storage.local;
  await new Promise(r => area.set({ [OPEN_SEARCH_FLAG]: Date.now() }, r));
  try {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      return 'popup';
    }
  } catch (e) {
    // No focused window, or a Chrome build without openPopup for commands.
  }
  if (chrome.windows && typeof chrome.windows.create === 'function') {
    await chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html?search=1'), type: 'popup', width: 400, height: 640 });
    return 'window';
  }
  return 'none';
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(command => {
    if (command === COMMAND_INCREMENT) {
      incrementActiveTracker().catch(err => console.warn('LIT: shortcut +1 failed:', err && err.message));
    } else if (command === COMMAND_SEARCH) {
      openPopupWithSearch().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------
// On-demand injection: quick log and the universal tracker
// ---------------------------------------------------------------------------
async function probeFrame(target) {
  const [res] = await chrome.scripting.executeScript({
    target,
    func: () => ({
      TrackerAuth: typeof TrackerAuth !== 'undefined',
      TrackerStorage: typeof TrackerStorage !== 'undefined',
      AutoTrackerCore: typeof AutoTrackerCore !== 'undefined',
      JobMeta: typeof JobMeta !== 'undefined',
      AutofillStore: typeof AutofillStore !== 'undefined',
      AutofillCore: typeof AutofillCore !== 'undefined',
      quickLog: typeof window.__ptQuickLog === 'function',
      mounted: !!window.__ptAutoTrackerMounted
    })
  });
  return (res && res.result) || {};
}

function missingShared(have) {
  return SHARED_FILES.filter(([name]) => !have[name]).map(([, file]) => file);
}

function isWebUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function notify(id, title, message) {
  if (!chrome.notifications) return;
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
    priority: 0
  });
}

async function logFromPage(tab) {
  if (!tab || typeof tab.id !== 'number' || !isWebUrl(tab.url)) {
    notify('lit-quick-log', 'LIT', 'Open a job posting or application page to log it from there.');
    return false;
  }
  const target = { tabId: tab.id };
  try {
    const have = await probeFrame(target);
    if (have.quickLog) {
      await chrome.scripting.executeScript({ target, func: () => window.__ptQuickLog() });
      return true;
    }
    await chrome.scripting.executeScript({ target, files: missingShared(have).concat(['content/quick-log.js']) });
    return true;
  } catch (err) {
    notify('lit-quick-log', 'LIT', 'This page does not allow extensions to add to it, so it cannot be logged from here.');
    return false;
  }
}

async function injectUniversal(sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (typeof tabId !== 'number') return false;
  const target = { tabId, frameIds: [typeof sender.frameId === 'number' ? sender.frameId : 0] };
  try {
    const have = await probeFrame(target);
    if (have.mounted) return false;
    const autofill = AUTOFILL_SHARED.filter(([name]) => !have[name]).map(([, file]) => file).concat(AUTOFILL_FILES);
    await chrome.scripting.executeScript({
      target,
      files: missingShared(have).concat(['content/adapters/ats/universal.js', 'content/auto-tracker.js'], autofill)
    });
    // executeScript does not apply CSS. The button script falls back to
    // inline outlines, so a failure here is not a failed injection.
    if (typeof chrome.scripting.insertCSS === 'function') {
      await chrome.scripting.insertCSS({ target, files: AUTOFILL_CSS }).catch(() => {});
    }
    return true;
  } catch (err) {
    return false;
  }
}

function createMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: MENU_LOG_PAGE,
      title: 'Log application from this page',
      contexts: ['page', 'frame', 'selection', 'link'],
      documentUrlPatterns: ['http://*/*', 'https://*/*']
    }, () => { void chrome.runtime.lastError; });
    chrome.contextMenus.create({
      id: MENU_LOG_ACTION,
      title: 'Log application from this page',
      contexts: ['action']
    }, () => { void chrome.runtime.lastError; });
  });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_LOG_PAGE || info.menuItemId === MENU_LOG_ACTION) logFromPage(tab);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (sender && sender.id && sender.id !== chrome.runtime.id)) return false;
  if (msg.type === 'PT_INJECT_UNIVERSAL') {
    injectUniversal(sender).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'PT_LOG_FROM_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      logFromPage(tabs && tabs[0]).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false }));
    });
    return true;
  }
  return false;
});

// ---------------------------------------------------------------------------
// Universal tracking registration
// ---------------------------------------------------------------------------
// Pages the manifest already covers get their dedicated trackers; the
// bootstrap stays off them.
function staticMatches() {
  try {
    const manifest = chrome.runtime.getManifest();
    return (manifest.content_scripts || []).reduce((all, cs) => all.concat(cs.matches || []), []);
  } catch (e) {
    return [];
  }
}

async function syncUniversalRegistration() {
  if (!chrome.scripting || typeof chrome.scripting.registerContentScripts !== 'function' || !chrome.permissions) return false;
  let prefs;
  try { prefs = await TrackerStorage.getPrefs(); } catch (e) { return false; }
  const granted = await chrome.permissions.contains({ origins: UNIVERSAL_ORIGINS });
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [UNIVERSAL_SCRIPT_ID] });
  const want = !!(prefs.universalTracking && granted);
  if (want && existing.length === 0) {
    await chrome.scripting.registerContentScripts([{
      id: UNIVERSAL_SCRIPT_ID,
      matches: ['http://*/*', 'https://*/*'],
      excludeMatches: staticMatches(),
      js: ['content/universal-bootstrap.js'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true
    }]);
  } else if (!want && existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [UNIVERSAL_SCRIPT_ID] });
  }
  return want;
}

// The only way to get all-sites access is the settings switch (or granting
// it on chrome://extensions), so a grant means the user wants universal
// detection. Setting the preference here also covers Chrome's permission
// prompt closing the popup before the popup could save it.
async function onPermissionsAdded(perms) {
  const origins = (perms && perms.origins) || [];
  if (origins.some(o => UNIVERSAL_ORIGINS.includes(o))) {
    try {
      const prefs = await TrackerStorage.getPrefs();
      if (!prefs.universalTracking) await TrackerStorage.setPrefs({ universalTracking: true });
    } catch (e) {
      // Registration below still reflects the stored preference.
    }
  }
  return syncUniversalRegistration();
}

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(perms => { onPermissionsAdded(perms).catch(() => {}); });
  chrome.permissions.onRemoved.addListener(() => { syncUniversalRegistration().catch(() => {}); });
}

// Surfaces communicate only by writing storage, so this is the single point
// where a start, pause, reset, or edit becomes an alarm, and where the
// universal-tracking setting becomes a registered script.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    Object.keys(TIMER_SURFACES).forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(changes, key)) return;
      syncAlarm(key, normalizeTimer(changes[key].newValue));
    });
  }
  if ((area === 'sync' || area === 'local') && changes.pt_prefs) {
    const before = changes.pt_prefs.oldValue || {};
    const after = changes.pt_prefs.newValue || {};
    if (before.universalTracking !== after.universalTracking) syncUniversalRegistration().catch(() => {});
  }
});

// The auto-tracker's dedupe cache lives in chrome.storage.session so it
// survives page reloads but not a browser restart. Content scripts cannot read
// the session area until the worker opts them in; the cache falls back to
// chrome.storage.local if this has not run yet.
function exposeSessionStorage() {
  if (!chrome.storage || !chrome.storage.session || typeof chrome.storage.session.setAccessLevel !== 'function') return;
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (e) {
    // Older Chrome without setAccessLevel; the local fallback covers it.
  }
}

async function onStartup() {
  await reconcileTimers();
  await ensureMaintenanceAlarm();
  await syncUniversalRegistration().catch(() => false);
}

chrome.runtime.onStartup.addListener(() => { onStartup(); runMaintenance(); });
chrome.runtime.onInstalled.addListener(() => { createMenus(); onStartup(); runMaintenance(); });

// A service worker is torn down when idle and revived by an event. Reconciling
// on every revival keeps alarms correct even if a storage change arrived while
// the worker was asleep.
exposeSessionStorage();
reconcileTimers();

// Test seam: the Node suite loads this file with a mocked chrome and drives
// these directly.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    normalizeTimer,
    settleTimer,
    incrementActiveTracker,
    openPopupWithSearch,
    logFromPage,
    injectUniversal,
    syncUniversalRegistration,
    runMaintenance,
    createMenus,
    staticMatches,
    UNIVERSAL_SCRIPT_ID,
    OPEN_SEARCH_FLAG
  };
}
