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
//   Autofill        "Autofill this page" (popup, context menu, Alt+Shift+F)
//                   injects the Autofill button into any site and runs it, so
//                   a company's own careers site works without the all-sites
//                   permission.
//   Universal       With the optional all-sites permission granted and the
//                   setting on, a tiny bootstrap runs on every page and asks
//                   for the full universal tracker only on job pages.
//   Maintenance     A periodic alarm takes the weekly local snapshot.
//   Check-in        Opt-in (prefs.reminderEnabled). One alarm a day at
//                   prefs.reminderTime shows a Chrome notification in the
//                   chosen coach voice; clicking it opens
//                   reminder/reminder.html. Never opens a tab by itself.
//   Toolbar icon    The padlock is drawn open until today's applications
//                   goal is met, then locked. Recomputed on every log write,
//                   at startup, and at local midnight.
//   Install         A fresh install opens onboarding/onboarding.html. An
//                   update keeps existing users' check-in on and skips
//                   onboarding.
//   Auto-apply      background/batch-runner.js (LitBatch) runs Jobright
//                   batches; this file only hands it messages and an
//                   injector for tabs the manifest does not cover.
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
// Coach copy is a nicety: a missing or broken file must not take the storage
// host down with it, so it loads on its own and every caller checks for it.
try { importScripts('../shared/coach-copy.js'); } catch (e) { /* plain fallback text */ }
importScripts('batch-runner.js');
// Answer writing for auto-apply: the store and composer have no DOM or window
// dependency, so they load here too and the API key stays in the worker.
importScripts('../shared/autofill-store.js', '../shared/answer-composer.js', 'ai-answer.js');

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
const REMINDER_ALARM = 'pt-reminder';
const REMINDER_PAGE = 'reminder/reminder.html';
const REMINDER_NOTIFICATION = 'lit-checkin';
const MIDNIGHT_ALARM = 'pt-midnight';
const ONBOARDING_PAGE = 'onboarding/onboarding.html';
// chrome.storage.local marker: this device has run the Warm Coach install or
// update step. Without it a later update would mistake a fresh install's
// unset reminder for an old install's and switch the check-in on.
const MIGRATION_KEY = 'pt_shell_migrations';
const PRIMARY_METRIC = 'jobs';

const MENU_LOG_PAGE = 'lit-log-page';
const MENU_LOG_ACTION = 'lit-log-page-action';

const COMMAND_INCREMENT = 'increment-active';
const COMMAND_SEARCH = 'open-search';
const COMMAND_AUTOFILL = 'autofill-page';
const MENU_AUTOFILL = 'lit-autofill-page';
const OPEN_SEARCH_FLAG = 'pt_open_search_at';

const UNIVERSAL_SCRIPT_ID = 'lit-universal-bootstrap';
const UNIVERSAL_ORIGINS = ['*://*/*'];

// Files the on-demand scripts need, keyed by the global each one defines, in
// load order. A frame that already has one (a statically matched page) is
// not given a second copy: redeclaring a top-level const would throw.
const SHARED_FILES = [
  ['TrackerAuth', 'shared/auth.js'],
  ['TrackerStorage', 'shared/storage.js'],
  ['LitCopy', 'shared/coach-copy.js'],
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
  'content/autofill/autofill-ui.js',
  'content/autofill/auto-apply.js'
];
const AUTOFILL_CSS = ['content/autofill/autofill-ui.css'];
// Matches MIN_FIELDS in content/autofill/autofill-ui.js.
const AUTOFILL_MIN_FIELDS = 3;

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

// ---------------------------------------------------------------------------
// Daily reminder
// ---------------------------------------------------------------------------
// The next occurrence of HH:MM in local time, strictly after `now`. An alarm
// with a fixed `when` is used instead of a 24h period so a clock change or a
// moved time never drifts it.
function nextReminderAt(timeStr, now = Date.now()) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || ''));
  const hours = m ? Math.min(23, parseInt(m[1], 10)) : 14;
  const minutes = m ? Math.min(59, parseInt(m[2], 10)) : 30;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

async function scheduleReminder() {
  let prefs;
  try {
    prefs = await TrackerStorage.getPrefs();
  } catch (err) {
    return null;
  }
  await chrome.alarms.clear(REMINDER_ALARM);
  if (!prefs.reminderEnabled) return null;
  const when = nextReminderAt(prefs.reminderTime);
  await chrome.alarms.create(REMINDER_ALARM, { when });
  return when;
}

// Today's numbers for the primary tracker. Every field has a fallback so a
// storage build without the newer stats still gives a sensible answer.
async function primaryProgress() {
  const [stats, metrics] = await Promise.all([TrackerStorage.getStats(), TrackerStorage.getMetrics()]);
  const metric = (metrics || []).find(m => m.id === PRIMARY_METRIC) || null;
  const goal = Math.max(1, parseInt(metric && metric.dailyGoal, 10) || 5);
  const counts = (stats && (stats.todayCount || stats.today)) || {};
  const count = Math.max(0, parseInt(counts[PRIMARY_METRIC], 10) || 0);
  const met = stats && stats.goalMet && typeof stats.goalMet[PRIMARY_METRIC] === 'boolean'
    ? stats.goalMet[PRIMARY_METRIC]
    : count >= goal;
  return { count, goal, met, restToday: !!(stats && stats.restToday), metric };
}

function reminderCopy(count, goal, voice) {
  try {
    if (typeof LitCopy !== 'undefined' && LitCopy && typeof LitCopy.reminder === 'function') {
      const c = LitCopy.reminder({ count, goal, voice });
      if (c && c.title && c.body) return { title: String(c.title), body: String(c.body) };
    }
  } catch (e) {
    // Fall through to the plain text.
  }
  if (count >= goal) return { title: 'Locked in for today', body: count + ' applications sent. Nice work.' };
  if (count > 0) return { title: 'Daily check-in', body: count + ' of ' + goal + ' applications sent so far. Want to log the rest?' };
  return { title: 'Daily check-in', body: 'How is the search going today? Log what you did, even one counts.' };
}

// Opens (or focuses) the check-in page. Only ever called from a click on the
// notification, so focusing is what the user asked for.
async function openCheckinPage(hash) {
  const base = chrome.runtime.getURL(REMINDER_PAGE);
  const url = base + (hash ? '#' + hash : '');
  try {
    const open = await new Promise(resolve => chrome.tabs.query({}, tabs => resolve(tabs || [])));
    const existing = open.find(t => t && t.id != null && String(t.url || '').indexOf(base) === 0);
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true, url });
      if (existing.windowId != null && chrome.windows && chrome.windows.update) {
        await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      }
      return existing.id;
    }
    const tab = await chrome.tabs.create({ url, active: true });
    return tab && tab.id;
  } catch (err) {
    console.warn('LIT: could not open the check-in:', err && err.message);
    return null;
  }
}

// One notification per firing, then books tomorrow. Rest days are skipped:
// a day off should stay off. Without the notifications API the page opens
// in a background tab, so the user is still never pulled out of their work.
async function showReminder() {
  let prefs = {};
  try { prefs = await TrackerStorage.getPrefs(); } catch (e) { prefs = {}; }
  let progress = { count: 0, goal: 5, restToday: false };
  try { progress = await primaryProgress(); } catch (e) { /* defaults */ }

  if (!progress.restToday) {
    const copy = reminderCopy(progress.count, progress.goal, prefs.coachVoice || 'coach');
    try {
      if (chrome.notifications && typeof chrome.notifications.create === 'function') {
        chrome.notifications.create(REMINDER_NOTIFICATION, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: copy.title,
          message: copy.body,
          buttons: [{ title: 'Log what I did' }, { title: 'Open my check-in' }],
          priority: 1
        }, () => { void chrome.runtime.lastError; });
      } else {
        await chrome.tabs.create({ url: chrome.runtime.getURL(REMINDER_PAGE), active: false });
      }
    } catch (err) {
      console.warn('LIT: could not show the daily check-in:', err && err.message);
    }
  }
  await scheduleReminder();
}

function clearCheckinNotification() {
  try { chrome.notifications.clear(REMINDER_NOTIFICATION, () => { void chrome.runtime.lastError; }); } catch (e) { /* gone */ }
}

if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(id => {
    if (id !== REMINDER_NOTIFICATION) return;
    clearCheckinNotification();
    openCheckinPage('');
  });
}
if (chrome.notifications && chrome.notifications.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((id, index) => {
    if (id !== REMINDER_NOTIFICATION) return;
    clearCheckinNotification();
    openCheckinPage(index === 0 ? 'log' : '');
  });
}

// ---------------------------------------------------------------------------
// Toolbar icon: open padlock until today's goal is met, then locked
// ---------------------------------------------------------------------------
const ACCENTS = {
  coral: '#E0674B', sage: '#5E9270', ocean: '#3B7EA1', plum: '#8A5A9E', amber: '#C9821F', slate: '#3D4A5C'
};
// A mid-tone that reads on both light and dark toolbars.
const OPEN_COLOR = '#8A8178';
const STATIC_ICON_PATHS = { 16: 'icons/icon16.png', 32: 'icons/icon48.png' };

function iconStateFor(progress) {
  return progress && progress.met ? 'locked' : 'open';
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// Same geometry as the inline SVG mark (24-unit box): shackle from (8,11.5)
// up over a radius-4 arc to (16,11.5); body 14x10 at (5,11). Open swings the
// shackle 30 degrees off the left post and lifts it.
function drawPadlock(size, state, accent) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const color = state === 'locked' ? accent : OPEN_COLOR;
  ctx.scale(size / 24, size / 24);
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size <= 16 ? 2.8 : 2.4;

  ctx.save();
  if (state !== 'locked') {
    ctx.translate(0, -2);
    ctx.translate(8, 11.5);
    ctx.rotate(-Math.PI / 6);
    ctx.translate(-8, -11.5);
  }
  ctx.beginPath();
  ctx.moveTo(8, 11.5);
  ctx.lineTo(8, 7.5);
  ctx.arc(12, 7.5, 4, Math.PI, 0);
  ctx.lineTo(16, 11.5);
  ctx.stroke();
  ctx.restore();

  roundRectPath(ctx, 4.5, 10.5, 15, 11, 2.6);
  ctx.fill();
  // Keyhole, punched out so the toolbar shows through.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(12, 15, 1.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(11.2, 15, 1.6, 3.4);
  ctx.globalCompositeOperation = 'source-over';
  return ctx.getImageData(0, 0, size, size);
}

function setStaticIcon() {
  try {
    if (chrome.action && typeof chrome.action.setIcon === 'function') {
      const p = chrome.action.setIcon({ path: STATIC_ICON_PATHS });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  } catch (e) {
    // Nothing more to fall back to.
  }
}

let lastIconKey = null;

async function updateToolbarIcon() {
  if (!chrome.action || typeof chrome.action.setIcon !== 'function') return null;
  let state = 'open';
  try {
    const [progress, prefs] = await Promise.all([primaryProgress(), TrackerStorage.getPrefs().catch(() => ({}))]);
    state = iconStateFor(progress);
    const accent = ACCENTS[prefs && prefs.accent] || ACCENTS.coral;
    const key = state + accent;
    if (key === lastIconKey) return state;
    if (typeof OffscreenCanvas !== 'function') throw new Error('OffscreenCanvas unavailable');
    const imageData = { 16: drawPadlock(16, state, accent), 32: drawPadlock(32, state, accent) };
    await chrome.action.setIcon({ imageData });
    lastIconKey = key;
    return state;
  } catch (err) {
    lastIconKey = null;
    setStaticIcon();
    return state;
  }
}

let iconTimer = null;
function scheduleIconUpdate() {
  if (iconTimer) clearTimeout(iconTimer);
  iconTimer = setTimeout(() => { iconTimer = null; updateToolbarIcon(); }, 250);
}

function nextMidnightAt(now = Date.now()) {
  const at = new Date(now);
  at.setHours(24, 0, 5, 0);
  return at.getTime();
}

async function scheduleMidnight() {
  try {
    await chrome.alarms.create(MIDNIGHT_ALARM, { when: nextMidnightAt() });
  } catch (e) {
    // The next startup or log write still corrects the icon.
  }
}

// ---------------------------------------------------------------------------
// Install and update
// ---------------------------------------------------------------------------
function readMigrations() {
  return new Promise(resolve => {
    chrome.storage.local.get([MIGRATION_KEY], r => {
      const v = r && r[MIGRATION_KEY];
      resolve(v && typeof v === 'object' ? v : {});
    });
  });
}

function writeMigrations(v) {
  return new Promise(resolve => chrome.storage.local.set({ [MIGRATION_KEY]: v }, () => resolve()));
}

// The prefs record as stored, before defaults are filled in, so an explicit
// choice can be told apart from a default.
function readRawPrefs() {
  const area = chrome.storage.sync || chrome.storage.local;
  return new Promise(resolve => {
    area.get(['pt_prefs'], r => {
      const v = r && r.pt_prefs;
      resolve(v && typeof v === 'object' ? v : {});
    });
  });
}

// The check-in used to be on by default and is now opt-in. People who
// already had it keep it; existing installs skip onboarding.
async function migrateExistingInstall() {
  const done = await readMigrations();
  if (done.warmCoach) return false;
  const raw = await readRawPrefs();
  const patch = { onboardingDone: true };
  if (typeof raw.reminderEnabled !== 'boolean') patch.reminderEnabled = true;
  try {
    await TrackerStorage.setPrefs(patch);
  } catch (e) {
    return false;
  }
  await writeMigrations(Object.assign({}, done, { warmCoach: true }));
  return true;
}

async function onFreshInstall() {
  const done = await readMigrations();
  await writeMigrations(Object.assign({}, done, { warmCoach: true }));
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(ONBOARDING_PAGE), active: true });
  } catch (err) {
    console.warn('LIT: could not open onboarding:', err && err.message);
  }
}

async function onInstalled(details) {
  const reason = details && details.reason;
  createMenus();
  if (reason === 'install') await onFreshInstall();
  else if (reason === 'update') await migrateExistingInstall();
  await onStartup();
  runMaintenance();
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === MAINTENANCE_ALARM) {
    runMaintenance();
    return;
  }
  if (alarm.name === REMINDER_ALARM) {
    showReminder();
    return;
  }
  if (alarm.name === MIDNIGHT_ALARM) {
    lastIconKey = null;
    updateToolbarIcon();
    scheduleMidnight();
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
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === COMMAND_INCREMENT) {
      incrementActiveTracker().catch(err => console.warn('LIT: shortcut +1 failed:', err && err.message));
    } else if (command === COMMAND_SEARCH) {
      openPopupWithSearch().catch(() => {});
    } else if (command === COMMAND_AUTOFILL) {
      if (tab) autofillTab(tab).catch(() => {});
      else chrome.tabs.query({ active: true, currentWindow: true }, tabs => { autofillTab(tabs && tabs[0]).catch(() => {}); });
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
      LitCopy: typeof LitCopy !== 'undefined',
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

// Autofill on demand. The popup button, the context menu, and the shortcut
// all grant activeTab, which is enough to inject into the tab's top frame
// (and its same-origin frames) on any site. Frames that already run the
// button (an ATS page, or the universal path) are not given a second copy.
// Only frames holding a form are filled, so an embedded application iframe
// gets one result card instead of one per frame.
async function frameResults(tabId, func) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func });
  } catch (err) {
    results = await chrome.scripting.executeScript({ target: { tabId }, func });
  }
  return (results || []).map(r => ({ frameId: typeof r.frameId === 'number' ? r.frameId : 0, result: r.result }));
}

async function autofillTab(tab) {
  if (!tab || typeof tab.id !== 'number' || !isWebUrl(tab.url)) {
    notify('lit-autofill', 'LIT', 'Open an application form in this tab to autofill it.');
    return false;
  }
  const tabId = tab.id;
  try {
    const probes = await frameResults(tabId, () => ({
      AutofillStore: typeof AutofillStore !== 'undefined',
      AutofillCore: typeof AutofillCore !== 'undefined',
      ui: !!window.__litAutofillUI
    }));
    for (const { frameId, result } of probes) {
      const have = result || {};
      if (have.ui) continue;
      const target = { tabId, frameIds: [frameId] };
      const files = AUTOFILL_SHARED.filter(([name]) => !have[name]).map(([, file]) => file).concat(AUTOFILL_FILES);
      try {
        await chrome.scripting.executeScript({ target, files });
        if (typeof chrome.scripting.insertCSS === 'function') {
          await chrome.scripting.insertCSS({ target, files: AUTOFILL_CSS }).catch(() => {});
        }
      } catch (err) {
        // A sandboxed or cross-origin frame; the others still get filled.
      }
    }
    const sizes = await frameResults(tabId, () => (window.__litAutofillUI ? window.__litAutofillUI.formSize() : -1));
    let frames = sizes.filter(s => s.result >= AUTOFILL_MIN_FIELDS).map(s => s.frameId);
    if (!frames.length) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => { if (window.__litAutofillUI) window.__litAutofillUI.note('LIT did not find an application form on this page yet. Open the form, then try again.'); }
      });
      return false;
    }
    for (const frameId of frames) {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        func: () => { if (window.__litAutofillUI) window.__litAutofillUI.fill(); }
      }).catch(() => {});
    }
    return true;
  } catch (err) {
    notify('lit-autofill', 'LIT', 'This page does not allow extensions to add to it, so it cannot be autofilled.');
    return false;
  }
}

// Auto-apply fallback for a batch tab whose driver never said hello (a
// company site outside the manifest's matches). Works only where the
// extension has host access; the batch's own timeout covers a refusal.
// Frames already running the driver are skipped so nothing runs twice.
async function injectAutofill(tabId) {
  if (typeof tabId !== 'number') return false;
  const probes = await frameResults(tabId, () => ({
    AutofillStore: typeof AutofillStore !== 'undefined',
    AutofillCore: typeof AutofillCore !== 'undefined',
    ui: !!window.__litAutofillUI,
    autoApply: !!window.__litAutoApply
  }));
  let injected = false;
  for (const { frameId, result } of probes) {
    const have = result || {};
    if (have.autoApply) continue;
    const target = { tabId, frameIds: [frameId] };
    const files = have.ui
      ? ['content/autofill/auto-apply.js']
      : AUTOFILL_SHARED.filter(([name]) => !have[name]).map(([, file]) => file).concat(AUTOFILL_FILES);
    try {
      await chrome.scripting.executeScript({ target, files });
      if (!have.ui && typeof chrome.scripting.insertCSS === 'function') {
        await chrome.scripting.insertCSS({ target, files: AUTOFILL_CSS }).catch(() => {});
      }
      injected = true;
    } catch (err) {
      // A sandboxed or cross-origin frame.
    }
  }
  return injected;
}

if (typeof LitBatch !== 'undefined') {
  LitBatch.install({ injectAutofill });
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
      id: MENU_AUTOFILL,
      title: 'Autofill this page',
      contexts: ['page', 'frame', 'editable'],
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
    if (info.menuItemId === MENU_AUTOFILL) autofillTab(tab);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (sender && sender.id && sender.id !== chrome.runtime.id)) return false;
  if (typeof LitBatch !== 'undefined' && LitBatch.handleMessage(msg, sender, sendResponse)) return true;
  if (typeof LitAnswers !== 'undefined' && LitAnswers.handleMessage(msg, sender, sendResponse)) return true;
  if (msg.type === 'PT_INJECT_UNIVERSAL') {
    injectUniversal(sender).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'PT_AUTOFILL_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      autofillTab(tabs && tabs[0]).then(ok => sendResponse({ ok }), () => sendResponse({ ok: false }));
    });
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
    if (before.reminderEnabled !== after.reminderEnabled || before.reminderTime !== after.reminderTime) scheduleReminder();
    if (before.accent !== after.accent || JSON.stringify(before.restDays) !== JSON.stringify(after.restDays)) scheduleIconUpdate();
  }
  // A log write (pt_logs_rev), a changed goal (metrics), or a different
  // account all can flip today's padlock.
  if ((area === 'sync' || area === 'local') && (changes.pt_logs_rev || changes.metrics || changes.pt_auth_user)) {
    scheduleIconUpdate();
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
  await scheduleReminder();
  await scheduleMidnight();
  await syncUniversalRegistration().catch(() => false);
  lastIconKey = null;
  await updateToolbarIcon();
}

chrome.runtime.onStartup.addListener(() => { onStartup(); runMaintenance(); });
chrome.runtime.onInstalled.addListener(details => { onInstalled(details).catch(err => console.warn('LIT: install step failed:', err && err.message)); });

// A service worker is torn down when idle and revived by an event. Reconciling
// on every revival keeps alarms correct even if a storage change arrived while
// the worker was asleep.
exposeSessionStorage();
reconcileTimers();
updateToolbarIcon();

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
    autofillTab,
    injectAutofill,
    syncUniversalRegistration,
    runMaintenance,
    nextReminderAt,
    scheduleReminder,
    showReminder,
    openCheckinPage,
    reminderCopy,
    primaryProgress,
    updateToolbarIcon,
    iconStateFor,
    drawPadlock,
    nextMidnightAt,
    migrateExistingInstall,
    onInstalled,
    createMenus,
    staticMatches,
    UNIVERSAL_SCRIPT_ID,
    OPEN_SEARCH_FLAG
  };
}
