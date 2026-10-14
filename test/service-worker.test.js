// Service worker: the storage host for content scripts, keyboard shortcuts,
// the "Log application from this page" menu, on-demand universal-tracker
// injection, opt-in registration of the universal bootstrap, the solve-timer
// alarm with laps and alert preferences, and weekly snapshot maintenance.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const { installMockIDB, uninstallMockIDB } = require('./mock_idb');

const ROOT = path.resolve(__dirname, '..');

function bus() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    emit(...args) { return listeners.map(fn => fn(...args)); },
    count() { return listeners.length; }
  };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle(n = 40) {
  for (let i = 0; i < n; i++) await tick();
}

// The Chrome APIs the worker uses beyond storage and runtime messaging.
function extendChrome(mock) {
  const alarms = new Map();
  mock.alarms = {
    store: alarms,
    create: async (name, info) => { alarms.set(name, info); },
    clear: async name => alarms.delete(name),
    get: async name => alarms.get(name),
    onAlarm: bus()
  };
  mock.commands = { onCommand: bus() };
  const menus = [];
  mock.contextMenus = {
    items: menus,
    removeAll(cb) { menus.length = 0; if (cb) cb(); },
    create(props, cb) { menus.push(props); if (cb) cb(); },
    onClicked: bus()
  };
  // Frames keyed "tab:frame". Each records which globals exist there, so
  // the probe and the injection bookkeeping can be checked end to end.
  const frames = {};
  const registered = [];
  const executions = [];
  const GLOBAL_OF = {
    'shared/auth.js': 'TrackerAuth',
    'shared/storage.js': 'TrackerStorage',
    'shared/auto-tracker-core.js': 'AutoTrackerCore',
    'shared/job-meta.js': 'JobMeta',
    'content/quick-log.js': 'quickLog',
    'content/auto-tracker.js': 'mounted'
  };
  mock.scripting = {
    frames,
    registered,
    executions,
    blocked: new Set(),
    async executeScript({ target, func, files }) {
      const key = target.tabId + ':' + ((target.frameIds || [0])[0]);
      if (this.blocked.has(target.tabId)) throw new Error('Cannot access contents of the page');
      const frame = frames[key] || (frames[key] = {});
      executions.push({ key, files: files || null, func: func ? func.toString() : null });
      if (files) {
        files.forEach(f => { if (GLOBAL_OF[f]) frame[GLOBAL_OF[f]] = true; });
        return [{ result: undefined }];
      }
      if (/__ptQuickLog\(\)\s*$/.test(func.toString().trim()) || /=>\s*window\.__ptQuickLog\(\)/.test(func.toString())) {
        frame.quickLogCalls = (frame.quickLogCalls || 0) + 1;
        return [{ result: undefined }];
      }
      return [{ result: Object.assign({ TrackerAuth: false, TrackerStorage: false, AutoTrackerCore: false, JobMeta: false, quickLog: false, mounted: false }, frame) }];
    },
    async registerContentScripts(list) { list.forEach(s => registered.push(s)); },
    async getRegisteredContentScripts({ ids }) { return registered.filter(s => !ids || ids.includes(s.id)); },
    async unregisterContentScripts({ ids }) {
      for (let i = registered.length - 1; i >= 0; i--) if (ids.includes(registered[i].id)) registered.splice(i, 1);
    }
  };
  const granted = new Set();
  mock.permissions = {
    granted,
    contains: async ({ origins }) => origins.every(o => granted.has(o)),
    onAdded: bus(),
    onRemoved: bus()
  };
  mock.action = {
    badgeText: '',
    badgeColor: null,
    popupOpens: 0,
    openPopupFails: false,
    setBadgeText({ text }) { this.badgeText = text; },
    setBadgeBackgroundColor({ color }) { this.badgeColor = color; },
    async openPopup() {
      if (this.openPopupFails) throw new Error('No active browser window');
      this.popupOpens++;
    }
  };
  mock.windows = { created: [], async create(opts) { this.created.push(opts); return { id: 9 }; } };
  mock.notifications = { created: [], create(id, opts) { this.created.push({ id, opts }); } };
  mock.tabs = { active: null, query(q, cb) { cb(this.active ? [this.active] : []); } };
  mock.runtime.onStartup = bus();
  mock.runtime.onInstalled = bus();
  mock.runtime.getManifest = () => require(path.join(ROOT, 'manifest.json'));
  return mock;
}

function loadWorker() {
  const mock = extendChrome(installMockChrome());
  installMockIDB();
  const GLOBAL_NAME = { 'auth.js': 'TrackerAuth', 'db.js': 'LitDB', 'storage.js': 'TrackerStorage' };
  global.importScripts = (...files) => {
    files.forEach(f => {
      const full = path.resolve(ROOT, 'background', f);
      delete require.cache[require.resolve(full)];
      global[GLOBAL_NAME[path.basename(full)]] = require(full);
    });
  };
  const swPath = path.join(ROOT, 'background', 'service-worker.js');
  delete require.cache[require.resolve(swPath)];
  const sw = require(swPath);
  return { mock, sw, storage: global.TrackerStorage, auth: global.TrackerAuth };
}

function unload() {
  delete global.importScripts;
  delete global.TrackerAuth;
  delete global.TrackerStorage;
  delete global.LitDB;
  uninstallMockIDB();
  uninstallMockChrome();
}

async function run() {
  console.log('--- Running test/service-worker.test.js ---');

  // 1. Storage host: a content script's log calls land in the worker's
  // IndexedDB.
  {
    const { mock, storage } = loadWorker();
    assert.ok(mock.runtime.onMessage.listenerCount() >= 2, 'the worker answers storage calls and injection requests');
    delete require.cache[require.resolve('../shared/storage')];
    const contentScript = require('../shared/storage');
    contentScript._setMode('remote');
    const log = await contentScript.addLog({ metricId: 'jobs', company: 'From A Page' });
    assert.strictEqual(await storage._backendName(), 'indexeddb');
    assert.strictEqual((await storage.getLogs())[0].id, log.id);
    unload();
    console.log('[PASS] The worker hosts IndexedDB for content scripts');
  }

  // 2. Alt+Shift+A: +1 to the tracker last selected in the popup, with a
  // badge flash; Alt+Shift+J: popup with search focused, or a window.
  {
    const { mock, sw, storage } = loadWorker();
    await storage.setActiveMetricId('leetcode');
    mock.commands.onCommand.emit('increment-active');
    await settle();
    const logs = await storage.getLogs({ metricId: 'leetcode' });
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].source, 'shortcut');
    assert.strictEqual(mock.action.badgeText, '+1');
    assert.strictEqual(mock.action.badgeColor, '#1e8e3e', 'the badge takes the tracker color');

    await storage.setActiveMetricId('deleted-tracker');
    await sw.incrementActiveTracker();
    assert.strictEqual((await storage.getLogs({ metricId: 'jobs' })).length, 1, 'a stale selection falls back to jobs');

    mock.commands.onCommand.emit('open-search');
    await settle();
    assert.strictEqual(mock.action.popupOpens, 1);
    assert.ok(Number.isFinite(mock.storage.session.store[sw.OPEN_SEARCH_FLAG]), 'the popup is told to focus search');
    mock.action.openPopupFails = true;
    assert.strictEqual(await sw.openPopupWithSearch(), 'window');
    assert.ok(/popup\/popup\.html\?search=1$/.test(mock.windows.created[0].url), 'falls back to a popup window');
    unload();
    console.log('[PASS] Keyboard shortcuts: +1 to the active tracker with badge feedback, search popup with fallback');
  }

  // 3. "Log application from this page": probes the frame and injects only
  // what is missing, reuses an injected card, refuses non-web pages.
  {
    const { mock, sw } = loadWorker();
    sw.createMenus();
    assert.deepStrictEqual(mock.contextMenus.items.map(i => [i.id, i.contexts.join(',')]), [
      ['lit-log-page', 'page,frame,selection,link'],
      ['lit-log-page-action', 'action']
    ]);

    assert.strictEqual(await sw.logFromPage({ id: 1, url: 'chrome://extensions/' }), false);
    assert.strictEqual(mock.notifications.created.length, 1, 'a non-web page gets a notification instead');

    mock.contextMenus.onClicked.emit({ menuItemId: 'lit-log-page' }, { id: 5, url: 'https://careers.acme.com/jobs/1' });
    await settle();
    const injected = mock.scripting.executions.filter(e => e.files).map(e => e.files);
    assert.deepStrictEqual(injected[0], ['shared/auth.js', 'shared/storage.js', 'shared/auto-tracker-core.js', 'shared/job-meta.js', 'content/quick-log.js'], 'a bare page gets every dependency in order');

    await sw.logFromPage({ id: 5, url: 'https://careers.acme.com/jobs/1' });
    assert.strictEqual(mock.scripting.frames['5:0'].quickLogCalls, 1, 'a second click reuses the injected card');
    assert.strictEqual(mock.scripting.executions.filter(e => e.files).length, 1, 'nothing is injected twice');

    // A statically matched ATS page already has storage and the core.
    Object.assign(mock.scripting.frames['7:0'] = {}, { TrackerAuth: true, TrackerStorage: true, AutoTrackerCore: true });
    await sw.logFromPage({ id: 7, url: 'https://boards.greenhouse.io/acme/jobs/1' });
    const last = mock.scripting.executions.filter(e => e.files).pop();
    assert.deepStrictEqual(last.files, ['shared/job-meta.js', 'content/quick-log.js'], 'never redeclares a script the page already has');

    mock.scripting.blocked.add(8);
    assert.strictEqual(await sw.logFromPage({ id: 8, url: 'https://chrome.google.com/webstore' }), false);
    assert.ok(/does not allow extensions/.test(mock.notifications.created.pop().opts.message));

    mock.tabs.active = { id: 11, url: 'https://jobs.acme.com/1' };
    const answer = await new Promise(resolve => mock.runtime.sendMessage({ type: 'PT_LOG_FROM_TAB' }, resolve));
    assert.deepStrictEqual(answer, { ok: true }, 'the popup can ask for the current tab');
    unload();
    console.log('[PASS] Quick log: context menus, dependency-aware injection, reuse, and refusal on protected pages');
  }

  // 4. The universal bootstrap asks for the full tracker; it is injected into
  // the asking frame only, and never where a tracker already runs.
  {
    const { mock, sw } = loadWorker();
    const ok = await new Promise(resolve => {
      const origSend = mock.runtime.sendMessage;
      mock.runtime.sendMessage = function (msg, cb) {
        return origSend.call(this, msg, cb);
      };
      mock.runtime.sendMessage({ type: 'PT_INJECT_UNIVERSAL' }, resolve);
    });
    assert.deepStrictEqual(ok, { ok: true });
    const files = mock.scripting.executions.filter(e => e.files).pop();
    assert.strictEqual(files.key, '1:0');
    assert.deepStrictEqual(files.files, ['shared/auth.js', 'shared/storage.js', 'shared/auto-tracker-core.js', 'shared/job-meta.js', 'content/adapters/ats/universal.js', 'content/auto-tracker.js']);

    assert.strictEqual(await sw.injectUniversal({ tab: { id: 1 }, frameId: 0 }), false, 'a frame with a mounted tracker is left alone');
    assert.strictEqual(await sw.injectUniversal({ tab: { id: 2 }, frameId: 3 }), true);
    assert.strictEqual(mock.scripting.executions.filter(e => e.files).pop().key, '2:3', 'the asking iframe, not the top frame');
    assert.strictEqual(await sw.injectUniversal({}), false);
    unload();
    console.log('[PASS] Universal injection: per-frame, dependency-aware, skips frames already tracked');
  }

  // 5. Opt-in registration: the setting and the optional permission must
  // both be on; turning either off unregisters.
  {
    const { mock, sw, storage } = loadWorker();
    assert.strictEqual(await sw.syncUniversalRegistration(), false);
    assert.strictEqual(mock.scripting.registered.length, 0);

    await storage.setPrefs({ universalTracking: true });
    await settle();
    assert.strictEqual(mock.scripting.registered.length, 0, 'no permission, no registration');
    await storage.setPrefs({ universalTracking: false });
    await settle();

    // The grant alone turns the setting on: Chrome's prompt can close the
    // popup before it saves the preference.
    mock.permissions.granted.add('*://*/*');
    mock.permissions.onAdded.emit({ origins: ['*://*/*'] });
    await settle(80);
    assert.strictEqual((await storage.getPrefs()).universalTracking, true, 'the grant turns the setting on');
    assert.strictEqual(mock.scripting.registered.length, 1);
    const reg = mock.scripting.registered[0];
    assert.strictEqual(reg.id, sw.UNIVERSAL_SCRIPT_ID);
    assert.deepStrictEqual(reg.js, ['content/universal-bootstrap.js'], 'only the tiny bootstrap runs everywhere');
    assert.deepStrictEqual(reg.matches, ['http://*/*', 'https://*/*']);
    assert.ok(reg.excludeMatches.includes('https://calendar.google.com/*') && reg.excludeMatches.includes('*://*.workable.com/*'), 'pages with dedicated scripts are excluded');
    assert.strictEqual(reg.allFrames, true);
    assert.strictEqual(reg.persistAcrossSessions, true);

    await sw.syncUniversalRegistration();
    assert.strictEqual(mock.scripting.registered.length, 1, 'idempotent');

    await storage.setPrefs({ universalTracking: false });
    await settle();
    assert.strictEqual(mock.scripting.registered.length, 0, 'turning the setting off unregisters');

    await storage.setPrefs({ universalTracking: true });
    await settle();
    assert.strictEqual(mock.scripting.registered.length, 1);
    mock.permissions.granted.clear();
    mock.permissions.onRemoved.emit({ origins: ['*://*/*'] });
    await settle();
    assert.strictEqual(mock.scripting.registered.length, 0, 'revoking the permission unregisters');
    unload();
    console.log('[PASS] Universal bootstrap registration follows the setting and the optional permission');
  }

  // 6. Solve timer: laps survive the close-out, and the alert preferences
  // decide whether and how the finish is announced.
  {
    const { mock, sw, storage } = loadWorker();
    const t = sw.normalizeTimer({ status: 'running', targetSeconds: 600, endsAt: 5, remainingSeconds: 600, laps: [60, 'x', -1, 130], updatedAt: 1 });
    assert.deepStrictEqual(t.laps, [60, 130], 'malformed laps are dropped');
    assert.strictEqual(sw.normalizeTimer({ status: 'running', endsAt: null }), null);

    mock.storage.local.store.pt_timer_popup = { status: 'running', targetSeconds: 600, endsAt: Date.now() - 10, remainingSeconds: 600, laps: [60, 130], updatedAt: 1 };
    await sw.settleTimer('pt_timer_popup');
    const done = mock.storage.local.store.pt_timer_popup;
    assert.strictEqual(done.status, 'finished');
    assert.deepStrictEqual(done.laps, [60, 130], 'laps are kept on the finished record');
    assert.strictEqual(mock.notifications.created.length, 1);
    assert.strictEqual(mock.notifications.created[0].opts.silent, false);

    await sw.settleTimer('pt_timer_popup');
    assert.strictEqual(mock.notifications.created.length, 1, 'a finished countdown is announced once');

    await storage.setPrefs({ timerSound: false });
    mock.storage.local.store.pt_timer_popup = { status: 'running', targetSeconds: 60, endsAt: Date.now() - 10, remainingSeconds: 60, updatedAt: 2 };
    await sw.settleTimer('pt_timer_popup');
    assert.strictEqual(mock.notifications.created[1].opts.silent, true, 'sound off makes the notification silent');

    await storage.setPrefs({ timerDesktop: false });
    mock.storage.local.store.pt_timer_popup = { status: 'running', targetSeconds: 60, endsAt: Date.now() - 10, remainingSeconds: 60, updatedAt: 3 };
    await sw.settleTimer('pt_timer_popup');
    assert.strictEqual(mock.notifications.created.length, 2, 'desktop alerts off: no notification');
    assert.strictEqual(mock.storage.local.store.pt_timer_popup.status, 'finished', 'the countdown still closes out');
    unload();
    console.log('[PASS] Solve timer: laps persist through the alarm close-out; sound and desktop alerts are honored');
  }

  // 7. Maintenance: install creates the alarm and menus; the alarm takes the
  // weekly snapshot.
  {
    const { mock, storage } = loadWorker();
    mock.runtime.onInstalled.emit({ reason: 'update' });
    await settle(80);
    assert.ok(mock.alarms.store.get('pt-maintenance'), 'the maintenance alarm is scheduled');
    assert.strictEqual(mock.alarms.store.get('pt-maintenance').periodInMinutes, 360);
    assert.strictEqual(mock.contextMenus.items.length, 2);
    assert.strictEqual((await storage.listSnapshots()).length, 0, 'nothing to snapshot on an empty install');

    await storage.addLog({ metricId: 'jobs', company: 'Snapshot Co' });
    mock.alarms.onAlarm.emit({ name: 'pt-maintenance' });
    await settle(80);
    const snaps = await storage.listSnapshots();
    assert.strictEqual(snaps.length, 1);
    assert.strictEqual(snaps[0].reason, 'weekly');
    mock.alarms.onAlarm.emit({ name: 'pt-maintenance' });
    await settle(80);
    assert.strictEqual((await storage.listSnapshots()).length, 1, 'at most one automatic snapshot a week');
    unload();
    console.log('[PASS] Maintenance: alarm and menus on install; one automatic snapshot a week');
  }

  console.log('--- test/service-worker.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
