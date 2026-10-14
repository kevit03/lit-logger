// Storage CRUD, LIFO tie-breaking, streaks, DST-proof date math, input
// sanitization, corruption resilience, the IndexedDB engine and its daily
// aggregates, legacy migration without loss, and write serialization under
// 100 concurrent writes on both backends.
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const { installMockIDB, uninstallMockIDB } = require('./mock_idb');

function loadStorage() {
  delete require.cache[require.resolve('../shared/auth')];
  delete require.cache[require.resolve('../shared/storage')];
  delete require.cache[require.resolve('../shared/db')];
  const TrackerAuth = require('../shared/auth');
  global.TrackerAuth = TrackerAuth;
  const TrackerStorage = require('../shared/storage');
  global.TrackerStorage = TrackerStorage;
  return { TrackerStorage, TrackerAuth };
}

function getFreshStorage(initialStore = {}) {
  const mock = installMockChrome(initialStore);
  return Object.assign({ mock }, loadStorage());
}

// Same as getFreshStorage, with an in-memory IndexedDB installed so the
// storage module picks the IndexedDB backend.
function getFreshIdbStorage(initialStore = {}) {
  const mock = installMockChrome(initialStore);
  const idb = installMockIDB();
  return Object.assign({ mock, idb }, loadStorage());
}

function cleanup() {
  delete global.TrackerAuth;
  delete global.TrackerStorage;
  uninstallMockIDB();
  uninstallMockChrome();
}

function legacyLog(i, extra = {}) {
  return Object.assign({
    id: 'legacy-' + i,
    metricId: i % 3 === 0 ? 'leetcode' : 'jobs',
    userEmail: null,
    count: 1,
    date: '2026-09-' + String(1 + (i % 28)).padStart(2, '0'),
    timestamp: '2026-09-' + String(1 + (i % 28)).padStart(2, '0') + 'T10:00:00.000Z',
    company: 'Legacy Co ' + i,
    role: 'Role ' + i,
    notes: '',
    solveTimeSeconds: 0
  }, extra);
}

// Sum of every entry's count per date and metric, straight from the logs.
function dailyFromLogs(logs) {
  const map = {};
  logs.forEach(l => {
    const d = map[l.date] || (map[l.date] = {});
    d[l.metricId] = (d[l.metricId] || 0) + (l.count || 1);
  });
  return map;
}

async function run() {
  console.log('--- Running test/storage.test.js ---');

  // 1. Basic CRUD operations (on both backends)
  for (const flavor of ['local', 'indexeddb']) {
    const { TrackerStorage } = flavor === 'local' ? getFreshStorage() : getFreshIdbStorage();
    assert.strictEqual(await TrackerStorage._backendName(), flavor === 'local' ? 'chrome.storage.local' : 'indexeddb');
    const today = TrackerStorage.getLocalDateStr();

    const log1 = await TrackerStorage.addLog({
      metricId: 'jobs',
      company: 'Google',
      role: 'Staff Software Engineer',
      notes: 'Applied via portal',
      date: today
    });

    assert.ok(log1.id, 'Log ID should be generated');
    assert.strictEqual(log1.metricId, 'jobs');
    assert.strictEqual(log1.company, 'Google');
    assert.strictEqual(log1.role, 'Staff Software Engineer');
    assert.strictEqual(log1.notes, 'Applied via portal');
    assert.strictEqual(log1.date, today);
    assert.strictEqual(log1.count, 1);
    assert.strictEqual(log1.status, 'applied', 'job entries start in the Applied stage');
    assert.strictEqual(log1.source, 'manual');

    let logs = await TrackerStorage.getLogs({ metricId: 'jobs', date: today });
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].id, log1.id);
    assert.ok(!Object.keys(logs[0]).some(k => k.startsWith('_')), 'internal index fields never leave storage');

    const log2 = await TrackerStorage.addLog({ metricId: 'leetcode', count: 3, date: today });
    assert.strictEqual(log2.count, 3);
    assert.strictEqual(log2.status, undefined, 'only job entries carry a pipeline status');

    logs = await TrackerStorage.getLogs();
    assert.strictEqual(logs.length, 2);

    const delResult = await TrackerStorage.deleteLog(log1.id);
    assert.strictEqual(delResult, true);
    logs = await TrackerStorage.getLogs();
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0].id, log2.id);

    const stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.today.jobs, 0, 'the delete came off the daily aggregate');
    assert.strictEqual(stats.today.leetcode, 3);
    assert.strictEqual(stats.totalLogs, 1);

    console.log('[PASS] Basic CRUD operations (' + flavor + ')');
    cleanup();
  }

  // 2. LIFO Tie-Breaker and Deterministic Ordering
  for (const flavor of ['local', 'indexeddb']) {
    const { TrackerStorage } = flavor === 'local' ? getFreshStorage() : getFreshIdbStorage();
    const today = TrackerStorage.getLocalDateStr();

    const sameIso = new Date().toISOString();
    const logA = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Company A', date: today, createdAt: sameIso });
    const logB = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Company B', date: today, createdAt: sameIso });
    const logC = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Company C', date: today, createdAt: sameIso });

    let logs = await TrackerStorage.getLogs({ metricId: 'jobs', date: today });
    assert.strictEqual(logs.length, 3);
    assert.strictEqual(logs[0].id, logC.id);
    assert.strictEqual(logs[1].id, logB.id);
    assert.strictEqual(logs[2].id, logA.id);

    assert.strictEqual(await TrackerStorage.undoLastLog('jobs', today), true);
    logs = await TrackerStorage.getLogs({ metricId: 'jobs', date: today });
    assert.deepStrictEqual(logs.map(l => l.id), [logB.id, logA.id]);

    assert.strictEqual(await TrackerStorage.undoLastLog('jobs', today), true);
    assert.strictEqual(await TrackerStorage.undoLastLog('jobs', today), true);
    logs = await TrackerStorage.getLogs({ metricId: 'jobs', date: today });
    assert.strictEqual(logs.length, 0);
    assert.strictEqual(await TrackerStorage.undoLastLog('jobs', today), false, 'over-undo returns false safely');

    console.log('[PASS] LIFO tie-breaker and deterministic undo (' + flavor + ')');
    cleanup();
  }

  // 3. Streak Calculations: a streak day is a day the DAILY GOAL was met
  {
    const { TrackerStorage } = getFreshStorage();
    const today = TrackerStorage.getLocalDateStr();
    const yesterday = TrackerStorage.addDays(today, -1);
    const twoDaysAgo = TrackerStorage.addDays(today, -2);
    const threeDaysAgo = TrackerStorage.addDays(today, -3);

    await TrackerStorage.addLog({ metricId: 'jobs', date: twoDaysAgo });
    await TrackerStorage.addLog({ metricId: 'jobs', date: yesterday });
    await TrackerStorage.addLog({ metricId: 'jobs', date: today });
    let stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.currentStreak, 0, 'Entries below the daily goal must not start a streak');
    assert.strictEqual(stats.streaks.jobs, 0);

    await TrackerStorage.setMetricGoal('jobs', 2);
    await TrackerStorage.addLog({ metricId: 'jobs', date: twoDaysAgo });
    await TrackerStorage.addLog({ metricId: 'jobs', date: yesterday });
    await TrackerStorage.addLog({ metricId: 'jobs', date: today });
    await TrackerStorage.addLog({ metricId: 'jobs', date: today });
    await TrackerStorage.addLog({ metricId: 'leetcode', date: threeDaysAgo });

    stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.currentStreak, 3, 'Streak should be 3 once the goal is met three days running');
    assert.strictEqual(stats.streaks.jobs, 3);
    assert.strictEqual(stats.longestStreaks.jobs, 3);
    assert.strictEqual(stats.streaks.leetcode, 0, 'One LeetCode entry against a goal of 2 is not a streak day');
    assert.strictEqual(stats.today['jobs'], 3);
    assert.strictEqual(stats.totals['jobs'], 7);

    const { TrackerStorage: tsShort } = getFreshStorage();
    await tsShort.setMetricGoal('jobs', 2);
    await tsShort.addLog({ metricId: 'jobs', date: twoDaysAgo });
    await tsShort.addLog({ metricId: 'jobs', date: twoDaysAgo });
    await tsShort.addLog({ metricId: 'jobs', date: yesterday });
    await tsShort.addLog({ metricId: 'jobs', date: today });
    await tsShort.addLog({ metricId: 'jobs', date: today });
    const statsShort = await tsShort.getStats();
    assert.strictEqual(statsShort.currentStreak, 1, 'Yesterday at 1 of 2 breaks the streak; today alone counts');
    assert.strictEqual(statsShort.longestStreaks.jobs, 1);

    const { TrackerStorage: ts2 } = getFreshStorage();
    await ts2.setMetricGoal('jobs', 1);
    await ts2.addLog({ metricId: 'jobs', date: twoDaysAgo });
    await ts2.addLog({ metricId: 'jobs', date: yesterday });
    const stats2 = await ts2.getStats();
    assert.strictEqual(stats2.currentStreak, 2, 'Streak ending yesterday should be 2');

    const { TrackerStorage: ts3 } = getFreshStorage();
    await ts3.setMetricGoal('jobs', 1);
    const fourDaysAgo = ts3.addDays(today, -4);
    await ts3.addLog({ metricId: 'jobs', date: fourDaysAgo });
    const stats3 = await ts3.getStats();
    assert.strictEqual(stats3.currentStreak, 0, 'Streak with gap to today/yesterday should be 0');
    assert.strictEqual(stats3.longestStreaks.jobs, 1, 'Longest streak remembers the old run');

    const map = { [twoDaysAgo]: { jobs: 5 }, [yesterday]: { jobs: 5 }, [today]: { jobs: 4 } };
    assert.strictEqual(TrackerStorage.computeCurrentStreak(map, 'jobs', 5, today), 2, 'today short of goal: streak is yesterday\'s 2');
    assert.strictEqual(TrackerStorage.computeCurrentStreak(map, 'jobs', 4, today), 3);
    assert.strictEqual(TrackerStorage.computeLongestStreak(map, 'jobs', 5), 2);
    assert.strictEqual(TrackerStorage.goalMetOn(map, today, 'jobs', 4), true);
    assert.strictEqual(TrackerStorage.goalMetOn(map, today, 'jobs', 5), false);

    console.log('[PASS] Streak calculations and boundary handling');
    cleanup();
  }

  // 4. DST Protection and Date Math
  {
    const { TrackerStorage } = getFreshStorage();
    assert.strictEqual(TrackerStorage.addDays('2024-02-28', 1), '2024-02-29');
    assert.strictEqual(TrackerStorage.addDays('2024-02-28', 2), '2024-03-01');
    assert.strictEqual(TrackerStorage.addDays('2023-02-28', 1), '2023-03-01');
    assert.strictEqual(TrackerStorage.addDays('2025-12-31', 1), '2026-01-01');
    assert.strictEqual(TrackerStorage.addDays('2026-01-01', -1), '2025-12-31');
    assert.strictEqual(TrackerStorage.addDays('2026-03-08', 1), '2026-03-09');
    assert.strictEqual(TrackerStorage.daysBetween('2026-03-07', '2026-03-09'), 2, 'day counts survive a DST change');
    assert.strictEqual(TrackerStorage.weekStartOf('2026-10-04'), '2026-09-28', 'Sunday belongs to the week that started Monday');
    assert.strictEqual(TrackerStorage.weekStartOf('2026-09-28'), '2026-09-28');
    assert.strictEqual(TrackerStorage.isDateStr('2026-02-30'), false);
    assert.strictEqual(TrackerStorage.isDateStr('2024-02-29'), true);

    console.log('[PASS] DST protection, week starts, and leap year / date boundary math');
    cleanup();
  }

  // 5. Input Sanitization & Storage Corruption Resilience
  {
    const { TrackerStorage, mock } = getFreshStorage();

    assert.strictEqual((await TrackerStorage.addLog({ metricId: 'jobs', count: -5 })).count, 1);
    assert.strictEqual((await TrackerStorage.addLog({ metricId: 'jobs', count: 0 })).count, 1);
    assert.strictEqual((await TrackerStorage.addLog({ metricId: 'jobs', count: '4' })).count, 4);
    const badDate = await TrackerStorage.addLog({ metricId: 'jobs', date: '2026-13-45' });
    assert.strictEqual(badDate.date, TrackerStorage.getLocalDateStr(), 'an impossible date falls back to today');

    const logTrim = await TrackerStorage.addLog({
      metricId: 'jobs',
      company: '  Acme Corp   ',
      role: '  Lead Architect  ',
      notes: '  Remote role  '
    });
    assert.strictEqual(logTrim.company, 'Acme Corp');
    assert.strictEqual(logTrim.role, 'Lead Architect');
    assert.strictEqual(logTrim.notes, 'Remote role');

    // Damaged shard entries are skipped, not fatal.
    const month = TrackerStorage.getLocalDateStr().slice(0, 7);
    const shardKey = 'pt_logs__m_' + month;
    mock.storage.local.store[shardKey] = mock.storage.local.store[shardKey].concat([null, 'junk', { corrupted: true }]);
    assert.strictEqual((await TrackerStorage.getLogs()).length, 5, 'junk entries in a shard are ignored');

    // A damaged index hides history but never throws, and the next write
    // re-lists the month, bringing its shard back.
    mock.storage.local.store['pt_logs__index'] = 'corrupt_string_value';
    assert.deepStrictEqual(await TrackerStorage.getLogs(), []);
    const afterCorruption = await TrackerStorage.addLog({ metricId: 'jobs' });
    assert.ok(afterCorruption.id);
    assert.strictEqual((await TrackerStorage.getLogs()).length, 6, 'the month shard is reachable again after the next write');

    // A damaged aggregate is rebuilt from its shard on read.
    mock.storage.local.store['pt_daily_aggregates__' + month] = 'garbage';
    const stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.totals.jobs, 9, 'stats recover from a damaged aggregate (1+1+4+1+1+1)');

    console.log('[PASS] Input sanitization and storage corruption resilience');
    cleanup();
  }

  // 6. Theme Storage & Time Helpers (LeetCode Timer)
  {
    const { TrackerStorage } = getFreshStorage();

    assert.strictEqual(await TrackerStorage.getTheme(), 'light');
    assert.strictEqual(await TrackerStorage.setTheme('dark'), 'dark');
    assert.strictEqual(await TrackerStorage.getTheme(), 'dark');
    assert.strictEqual(await TrackerStorage.setTheme('unknown_theme'), 'light');
    assert.strictEqual(await TrackerStorage.getTheme(), 'light');

    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(0), '00:00');
    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(59), '00:59');
    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(60), '01:00');
    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(150), '02:30');
    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(3600), '60:00');
    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(-10), '00:00');
    assert.strictEqual(TrackerStorage.formatSecondsToMMSS(null), '00:00');

    assert.strictEqual(TrackerStorage.parseStringToSeconds('25:00'), 1500);
    assert.strictEqual(TrackerStorage.parseStringToSeconds('05:30'), 330);
    assert.strictEqual(TrackerStorage.parseStringToSeconds('1:15:00'), 4500);
    assert.strictEqual(TrackerStorage.parseStringToSeconds('25'), 1500);
    assert.strictEqual(TrackerStorage.parseStringToSeconds('15'), 900);
    assert.strictEqual(TrackerStorage.parseStringToSeconds('600'), 600);
    assert.strictEqual(TrackerStorage.parseStringToSeconds('abc'), 0);
    assert.strictEqual(TrackerStorage.parseStringToSeconds(''), 0);
    assert.strictEqual(TrackerStorage.parseStringToSeconds(null), 0);

    assert.strictEqual(TrackerStorage.formatTimeHMS(45), '45s');
    assert.strictEqual(TrackerStorage.formatTimeHMS(120), '2m');
    assert.strictEqual(TrackerStorage.formatTimeHMS(150), '2m 30s');
    assert.strictEqual(TrackerStorage.formatTimeHMS(3660), '1h 1m');

    await TrackerStorage.addLog({ metricId: 'leetcode', count: 1, solveTimeSeconds: 1500 });
    await TrackerStorage.addLog({ metricId: 'leetcode', count: 1, solveTimeSeconds: 900 });
    await TrackerStorage.addLog({ metricId: 'leetcode', count: 1, solveTimeSeconds: 600 });
    await TrackerStorage.addLog({ metricId: 'jobs', count: 1 });

    const stats = await TrackerStorage.getLeetcodeTimeStats();
    assert.strictEqual(stats.totalSeconds, 3000);
    assert.strictEqual(stats.todaySeconds, 3000);
    assert.strictEqual(stats.sessionCount, 3);
    assert.strictEqual(stats.todaySessionCount, 3);
    assert.strictEqual(stats.avgSeconds, 1000);
    assert.strictEqual(stats.bestSeconds, 600);
    assert.strictEqual(stats.medianSeconds, 900);
    assert.strictEqual(stats.latestSeconds, 600, 'latest is the most recent timed solve');
    assert.deepStrictEqual(stats.recent.map(r => r.seconds), [1500, 900, 600], 'sparkline series runs oldest to newest');

    // Device preferences and the active tracker used by the +1 shortcut.
    assert.strictEqual((await TrackerStorage.getPrefs()).timerSound, true);
    await TrackerStorage.setPrefs({ timerSound: false, bogus: 1, timerDesktop: 'yes' });
    const prefs = await TrackerStorage.getPrefs();
    assert.strictEqual(prefs.timerSound, false);
    assert.strictEqual(prefs.timerDesktop, true, 'a wrongly typed value is ignored');
    assert.ok(!('bogus' in prefs));
    assert.strictEqual(await TrackerStorage.getActiveMetricId(), 'jobs');
    await TrackerStorage.setActiveMetricId('leetcode');
    assert.strictEqual(await TrackerStorage.getActiveMetricId(), 'leetcode');

    console.log('[PASS] Theme, preferences, and LeetCode time helpers (median, best, sparkline series)');
    cleanup();
  }

  // 7. Daily aggregates stay exactly in step with the logs through adds,
  // edits that move an entry across months, deletes, and undo, and a full
  // rebuild reproduces them.
  for (const flavor of ['local', 'indexeddb']) {
    const { TrackerStorage } = flavor === 'local' ? getFreshStorage() : getFreshIdbStorage();
    const today = TrackerStorage.getLocalDateStr();
    const lastMonth = TrackerStorage.addDays(today, -35);
    const created = [];
    for (let i = 0; i < 30; i++) {
      created.push(await TrackerStorage.addLog({
        metricId: i % 2 ? 'jobs' : 'leetcode',
        count: 1 + (i % 3),
        date: TrackerStorage.addDays(today, -i * 2)
      }));
    }
    await TrackerStorage.deleteLog(created[3].id);
    await TrackerStorage.updateLog(created[5].id, { date: lastMonth, count: 7 });
    await TrackerStorage.undoLastLog('leetcode', today);

    const logs = await TrackerStorage.getLogs();
    const expected = dailyFromLogs(logs);
    const { dailyMap, logCount } = await TrackerStorage.getDailyAggregates();
    assert.deepStrictEqual(dailyMap, expected, 'aggregates equal a recount of the logs');
    assert.strictEqual(logCount, logs.length);

    await TrackerStorage.rebuildAggregates();
    assert.deepStrictEqual((await TrackerStorage.getDailyAggregates()).dailyMap, expected, 'rebuild reproduces the same totals');

    const history = await TrackerStorage.getActivityHistory(60, 'jobs');
    assert.strictEqual(history.days.length, 60);
    const jobsTotal = logs.filter(l => l.metricId === 'jobs' && l.date > TrackerStorage.addDays(today, -60)).reduce((s, l) => s + l.count, 0);
    assert.strictEqual(history.totalCount, jobsTotal, '60-day history reads from the aggregates');

    console.log('[PASS] Daily aggregates match the logs through edits and deletes (' + flavor + ')');
    cleanup();
  }

  // 8. Month views and streaks never load raw logs: getStats reads only the
  // aggregate store.
  {
    const { TrackerStorage, idb } = getFreshIdbStorage();
    for (let i = 0; i < 40; i++) await TrackerStorage.addLog({ metricId: 'jobs', date: TrackerStorage.addDays(TrackerStorage.getLocalDateStr(), -i) });
    const db = await require('../shared/db').open();
    const origTransaction = db.transaction.bind(db);
    const touched = [];
    db.transaction = (names, mode) => {
      touched.push([].concat(names).join(','));
      return origTransaction(names, mode);
    };
    const stats = await TrackerStorage.getStats();
    db.transaction = origTransaction;
    assert.strictEqual(stats.totals.jobs, 40);
    assert.ok(touched.length > 0 && touched.every(t => t === 'daily_aggregates'), 'getStats touched only the aggregate store: ' + touched.join(' | '));
    assert.ok(idb.openCount >= 1);
    console.log('[PASS] getStats reads the per-month aggregate store, never the raw logs');
    cleanup();
  }

  // 9. Legacy migration: chrome.storage.local['logs'] into IndexedDB, with no
  // loss, order preserved, the raw key archived, and no double import.
  {
    const legacy = [];
    for (let i = 0; i < 250; i++) legacy.push(legacyLog(i));
    // Two entries share a timestamp; insertion order must still break the tie.
    legacy.push(legacyLog(900, { date: '2026-09-02', timestamp: '2026-09-02T11:00:00.000Z', company: 'Tie First' }));
    legacy.push(legacyLog(901, { date: '2026-09-02', timestamp: '2026-09-02T11:00:00.000Z', company: 'Tie Second' }));
    legacy.push(null, 'junk', { id: 'no-date' });
    const { TrackerStorage, mock } = getFreshIdbStorage({ logs: legacy });

    const logs = await TrackerStorage.getLogs();
    assert.strictEqual(logs.length, 252, 'every valid legacy entry was imported');
    const ids = new Set(logs.map(l => l.id));
    legacy.filter(l => l && l.date).forEach(l => assert.ok(ids.has(l.id), 'lost ' + l.id));
    const tie = logs.filter(l => l.company.startsWith('Tie'));
    assert.deepStrictEqual(tie.map(l => l.company), ['Tie Second', 'Tie First'], 'LIFO order survives migration');
    assert.ok(logs.filter(l => l.metricId === 'jobs').every(l => l.status === 'applied'), 'imported job entries read as Applied');

    assert.strictEqual(mock.storage.local.store.logs, undefined, 'the raw legacy key is removed');
    const archive = mock.storage.local.store.pt_legacy_logs_archive;
    assert.ok(archive && archive.logs.length === legacy.length && archive.source === 'local', 'the raw key is archived intact');

    const stats = await TrackerStorage.getStats();
    const expectedJobs = legacy.filter(l => l && l.date && l.metricId === 'jobs').length;
    assert.strictEqual(stats.totals.jobs, expectedJobs, 'aggregates were built during the import');

    // A second context (the service worker) starting against the same
    // database must not import again.
    const { TrackerStorage: second } = loadStorage();
    assert.strictEqual((await second.getLogs()).length, 252);
    const info = await second.getStorageInfo();
    assert.strictEqual(info.backend, 'indexeddb');
    assert.strictEqual(info.logCount, 252);
    assert.strictEqual(info.migration.source, 'local');
    assert.strictEqual(info.migration.count, 252);

    console.log('[PASS] Legacy chrome.storage.local logs migrate into IndexedDB without loss, archived, imported once');
    cleanup();
  }

  // 10. Legacy migration from chrome.storage.sync chunks and the local
  // overflow. The overflow wins (it was the device's complete picture); sync
  // chunks are left for devices that have not upgraded yet, then freed after
  // the grace period.
  {
    const chunk0 = [legacyLog(1), legacyLog(2)];
    const chunk1 = [legacyLog(3, { userEmail: 'Alice@Example.com' })];
    const { TrackerStorage, mock } = getFreshIdbStorage();
    mock.storage.sync.store.logs__meta = { count: 2 };
    mock.storage.sync.store.logs__c0 = chunk0;
    mock.storage.sync.store.logs__c1 = chunk1;

    assert.strictEqual((await TrackerStorage.getLogs({}, null)).length, 2);
    const alice = await TrackerStorage.getLogs({}, 'alice@example.com');
    assert.strictEqual(alice.length, 1, 'account scoping survives the import');
    assert.ok(mock.storage.sync.store.logs__meta, 'sync chunks stay for devices still on an older build');
    const marker = mock.storage.sync.store.pt_logs_migrated;
    assert.ok(marker && Number.isFinite(marker.at));
    assert.strictEqual(await TrackerStorage._cleanupLegacySync(marker.at + 1000), false, 'not freed inside the grace period');
    assert.strictEqual(await TrackerStorage._cleanupLegacySync(marker.at + 31 * 86400000), true);
    assert.strictEqual(mock.storage.sync.store.logs__meta, undefined, 'freed after the grace period');
    assert.strictEqual(mock.storage.sync.store.logs__c1, undefined);
    cleanup();

    const { TrackerStorage: withOverflow, mock: mock2 } = getFreshIdbStorage({
      logs_overflow: [legacyLog(10), legacyLog(11), legacyLog(12)]
    });
    mock2.storage.sync.store.logs__meta = { count: 1 };
    mock2.storage.sync.store.logs__c0 = [legacyLog(10), legacyLog(99, { company: 'Deleted since overflow began' })];
    const merged = await withOverflow.getLogs();
    assert.deepStrictEqual(merged.map(l => l.id).sort(), ['legacy-10', 'legacy-11', 'legacy-12'], 'the overflow is authoritative; stale sync entries are not resurrected');
    assert.strictEqual(mock2.storage.local.store.logs_overflow, undefined);
    assert.strictEqual(mock2.storage.local.store.pt_legacy_logs_archive.source, 'local-overflow');

    console.log('[PASS] Sync-chunk and overflow migrations: priority, scoping, and grace-period cleanup');
    cleanup();
  }

  // 11. Promise mutex: 100 concurrent writes from one context land exactly
  // once each, on both backends.
  for (const flavor of ['local', 'indexeddb']) {
    const { TrackerStorage } = flavor === 'local' ? getFreshStorage() : getFreshIdbStorage();
    const today = TrackerStorage.getLocalDateStr();
    const writes = [];
    for (let i = 0; i < 100; i++) {
      writes.push(TrackerStorage.addLog({ metricId: i % 2 ? 'jobs' : 'leetcode', company: 'Burst ' + i, date: TrackerStorage.addDays(today, -(i % 40)) }));
    }
    const created = await Promise.all(writes);
    assert.strictEqual(new Set(created.map(l => l.id)).size, 100, 'ids are unique');
    const logs = await TrackerStorage.getLogs();
    assert.strictEqual(logs.length, 100, flavor + ': all 100 concurrent writes survive, got ' + logs.length);
    const stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.totals.jobs + stats.totals.leetcode, 100, 'aggregates counted every write exactly once');
    assert.strictEqual(stats.totalLogs, 100);
    console.log('[PASS] 100 concurrent writes serialize without loss (' + flavor + ')');
    cleanup();
  }

  // 12. IndexedDB that fails to open falls back to chrome.storage.local.
  {
    const { TrackerStorage, idb, mock } = getFreshIdbStorage();
    const err = new Error('disk full');
    err.name = 'UnknownError';
    idb.failNextOpen = err;
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (...a) => warnings.push(a.join(' '));
    const log = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Fallback Co' });
    console.warn = origWarn;
    assert.strictEqual(await TrackerStorage._backendName(), 'chrome.storage.local');
    assert.ok(warnings.some(w => /IndexedDB unavailable/.test(w)), 'the fallback is logged');
    assert.strictEqual((await TrackerStorage.getLogs())[0].id, log.id);
    assert.ok(Object.keys(mock.storage.local.store).some(k => k.startsWith('pt_logs__m_')));
    console.log('[PASS] An IndexedDB open failure falls back to chrome.storage.local month shards');
    cleanup();
  }

  console.log('--- test/storage.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
