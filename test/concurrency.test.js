// Cross-context concurrency tests.
//
// The write mutex inside shared/storage.js only serializes writers within one
// JS context. Two contexts that each load their own copy of the module can
// still race: trackers live in one shared chrome.storage.sync, and when
// IndexedDB is unavailable, logs live in chrome.storage.local month shards.
// Neither has compare-and-swap, so a read-modify-write in one context can
// clobber the other. These tests load two independent module instances and
// widen the read/write window so the race is actually provoked rather than
// merely asserted away. With IndexedDB, transactions do the serializing; the
// last case checks two contexts sharing one database.
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const { installMockIDB, uninstallMockIDB } = require('./mock_idb');

// Widen the gap between a read and its matching write so concurrent
// read-modify-write cycles reliably interleave.
function withLatency(area, getDelayMs, setDelayMs) {
  return {
    get(keys, cb) { setTimeout(() => area.get(keys, cb), getDelayMs); },
    set(items, cb) { setTimeout(() => area.set(items, cb), setDelayMs); },
    remove(keys, cb) { setTimeout(() => area.remove(keys, cb), setDelayMs); }
  };
}

function freshEnvironment(getDelayMs = 8, setDelayMs = 1) {
  const mock = installMockChrome();
  const realArea = mock.storage.sync;
  mock.storage.sync = withLatency(realArea, getDelayMs, setDelayMs);
  mock.storage.local = withLatency(mock.storage.local, getDelayMs, setDelayMs);
  return { mock, realArea };
}

// Each call returns a distinct module closure with its own write mutex, the way
// the popup and the content script each get their own.
function loadStorageContext() {
  delete require.cache[require.resolve('../shared/auth')];
  delete require.cache[require.resolve('../shared/storage')];
  delete require.cache[require.resolve('../shared/db')];
  global.TrackerAuth = require('../shared/auth');
  return require('../shared/storage');
}

function teardown() {
  delete global.TrackerAuth;
  delete global.TrackerStorage;
  uninstallMockIDB();
  uninstallMockChrome();
}

// A plain read-modify-write append, i.e. what shared/storage.js did before the
// verify-and-retry hardening. Used as a control so these tests fail loudly if
// the harness ever stops provoking the race.
function naiveAppend(area, entry) {
  return new Promise(resolve => {
    area.get(['logs'], res => {
      const logs = Array.isArray(res.logs) ? res.logs : [];
      logs.push(entry);
      area.set({ logs }, () => resolve(entry));
    });
  });
}

async function run() {
  console.log('--- Running test/concurrency.test.js ---');

  // 0. Control: the harness really does provoke lost updates
  {
    const { mock } = freshEnvironment();
    const area = mock.storage.sync;

    await Promise.all(
      [1, 2, 3, 4, 5, 6].map(n => naiveAppend(area, { id: 'naive-' + n }))
    );

    const stored = await new Promise(r => area.get(['logs'], res => r(res.logs || [])));
    assert.ok(
      stored.length < 6,
      'Control failed: the harness no longer provokes the lost-update race ' +
      '(expected fewer than 6 stored, got ' + stored.length + ')'
    );

    console.log('[PASS] Harness provokes cross-context lost updates (' + stored.length + '/6 survived a naive append)');
    teardown();
  }

  // 1. Concurrent addLog from two contexts must not lose entries
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();
    assert.notStrictEqual(popup, dock, 'Contexts must be distinct module instances');

    const writes = [];
    for (let i = 0; i < 6; i++) {
      writes.push(popup.addLog({ metricId: 'jobs', company: 'Popup ' + i }));
      writes.push(dock.addLog({ metricId: 'leetcode', company: 'Dock ' + i }));
    }
    const created = await Promise.all(writes);

    const logs = await popup.getLogs();
    assert.strictEqual(logs.length, 12, 'All 12 concurrent writes must survive, got ' + logs.length);

    const storedIds = new Set(logs.map(l => l.id));
    created.forEach(log => {
      assert.ok(storedIds.has(log.id), 'addLog returned ' + log.id + ' but it is not in storage');
    });

    const stats = await popup.getStats();
    assert.strictEqual(stats.totals.jobs, 6);
    assert.strictEqual(stats.totals.leetcode, 6);

    console.log('[PASS] Concurrent addLog from popup and dock loses no entries');
    teardown();
  }

  // 2. Concurrent delete in one context and add in the other
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();

    const seeded = [];
    for (let i = 0; i < 4; i++) {
      seeded.push(await popup.addLog({ metricId: 'jobs', company: 'Seed ' + i }));
    }
    assert.strictEqual((await popup.getLogs()).length, 4);

    // Popup deletes two seeded entries while the dock appends two new ones.
    const [d1, d2, a1, a2] = await Promise.all([
      popup.deleteLog(seeded[0].id),
      popup.deleteLog(seeded[1].id),
      dock.addLog({ metricId: 'leetcode', company: 'Concurrent A' }),
      dock.addLog({ metricId: 'leetcode', company: 'Concurrent B' })
    ]);

    assert.strictEqual(d1, true);
    assert.strictEqual(d2, true);

    const logs = await popup.getLogs();
    const ids = new Set(logs.map(l => l.id));
    assert.ok(!ids.has(seeded[0].id), 'Deleted entry was resurrected by the concurrent add');
    assert.ok(!ids.has(seeded[1].id), 'Deleted entry was resurrected by the concurrent add');
    assert.ok(ids.has(seeded[2].id), 'Untouched entry was dropped');
    assert.ok(ids.has(seeded[3].id), 'Untouched entry was dropped');
    assert.ok(ids.has(a1.id), 'Concurrent add was clobbered by the delete');
    assert.ok(ids.has(a2.id), 'Concurrent add was clobbered by the delete');
    assert.strictEqual(logs.length, 4);

    console.log('[PASS] Concurrent delete and add across contexts stay consistent');
    teardown();
  }

  // 3. Default-metric seeding must not clobber a concurrent custom tracker.
  //    getMetrics used to write DEFAULT_METRICS straight through, outside the
  //    write queue, which dropped a tracker created at the same moment.
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();

    const [created] = await Promise.all([
      popup.addMetric({ name: 'Cold Emails', unit: 'emails' }),
      dock.getMetrics(),
      dock.getMetrics(),
      popup.getMetrics()
    ]);

    // Let the fire-and-forget seeding write settle.
    await new Promise(r => setTimeout(r, 60));

    const metrics = await popup.getMetrics();
    assert.ok(metrics.some(m => m.id === 'jobs'), 'Default jobs tracker must exist');
    assert.ok(metrics.some(m => m.id === 'leetcode'), 'Default leetcode tracker must exist');
    assert.ok(
      metrics.some(m => m.id === created.id),
      'Custom tracker was lost to the concurrent default-metric seeding'
    );
    assert.strictEqual(metrics.length, 3, 'Expected exactly 3 trackers, got ' + metrics.length);

    console.log('[PASS] Default-metric seeding does not clobber a concurrent custom tracker');
    teardown();
  }

  // 4. Concurrent addMetric from two contexts
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();

    const created = await Promise.all([
      popup.addMetric({ name: 'Alpha' }),
      dock.addMetric({ name: 'Beta' }),
      popup.addMetric({ name: 'Gamma' }),
      dock.addMetric({ name: 'Delta' })
    ]);

    const metrics = await popup.getMetrics();
    created.forEach(m => {
      assert.ok(metrics.some(x => x.id === m.id), 'Custom tracker "' + m.name + '" was lost');
    });
    assert.strictEqual(metrics.length, 6, 'Expected 2 defaults plus 4 custom, got ' + metrics.length);

    console.log('[PASS] Concurrent addMetric from two contexts loses no trackers');
    teardown();
  }

  // 5. Concurrent goal edits do not resurrect a deleted tracker or drop the goal
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();

    const custom = await popup.addMetric({ name: 'Mock Interviews' });

    await Promise.all([
      popup.setMetricGoal('jobs', 12),
      dock.setMetricGoal('leetcode', 7),
      popup.setMetricGoal(custom.id, 3)
    ]);

    const metrics = await popup.getMetrics();
    assert.strictEqual(metrics.find(m => m.id === 'jobs').dailyGoal, 12);
    assert.strictEqual(metrics.find(m => m.id === 'leetcode').dailyGoal, 7);
    assert.strictEqual(metrics.find(m => m.id === custom.id).dailyGoal, 3);

    console.log('[PASS] Concurrent goal edits across contexts all stick');
    teardown();
  }

  // 6. Rapid +1 / -1 clicking must never drive a count negative or over-delete
  {
    freshEnvironment(2, 1);
    const dock = loadStorageContext();
    const today = dock.getLocalDateStr();

    // Ten undos racing three adds: the extra undos must be no-ops, not
    // deletions of some other metric's or some other day's entries.
    const other = await dock.addLog({ metricId: 'leetcode', date: today });
    const yesterday = await dock.addLog({ metricId: 'jobs', date: dock.addDays(today, -1) });

    const ops = [];
    for (let i = 0; i < 3; i++) ops.push(dock.addLog({ metricId: 'jobs', date: today }));
    for (let i = 0; i < 10; i++) ops.push(dock.undoLastLog('jobs', today));
    await Promise.all(ops);

    const stats = await dock.getStats();
    assert.ok((stats.today.jobs || 0) >= 0, 'Count must never go negative');
    assert.strictEqual(stats.today.jobs || 0, 0, 'Ten undos must consume all three adds');

    const logs = await dock.getLogs();
    const ids = new Set(logs.map(l => l.id));
    assert.ok(ids.has(other.id), 'Over-undo must not touch another metric');
    assert.ok(ids.has(yesterday.id), 'Over-undo must not touch another date');

    // A further undo on an empty day is still a safe no-op
    assert.strictEqual(await dock.undoLastLog('jobs', today), false);
    assert.strictEqual(await dock.undoLastLog('does-not-exist', today), false);
    assert.strictEqual(await dock.deleteLog('log-does-not-exist'), false);
    assert.strictEqual(await dock.deleteLog(null), false);

    console.log('[PASS] Rapid add and undo never drives a count negative or over-deletes');
    teardown();
  }

  // 7. Deleting a custom tracker leaves default trackers and history intact,
  //    even while the other context is writing.
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();

    const custom = await popup.addMetric({ name: 'Portfolio' });
    const customLog = await popup.addLog({ metricId: custom.id, notes: 'Shipped a page' });
    const jobsLog = await popup.addLog({ metricId: 'jobs', company: 'Acme' });

    const [deleted, concurrentAdd] = await Promise.all([
      popup.deleteMetric(custom.id),
      dock.addLog({ metricId: 'leetcode', company: 'Two Sum' })
    ]);
    assert.strictEqual(deleted, true);

    const metrics = await popup.getMetrics();
    assert.strictEqual(metrics.length, 2, 'Only the two defaults should remain');
    assert.ok(metrics.some(m => m.id === 'jobs'));
    assert.ok(metrics.some(m => m.id === 'leetcode'));

    const logs = await popup.getLogs();
    const ids = new Set(logs.map(l => l.id));
    assert.ok(ids.has(customLog.id), 'History for the deleted tracker must be preserved');
    assert.ok(ids.has(jobsLog.id), 'Default tracker history must be untouched');
    assert.ok(ids.has(concurrentAdd.id), 'Concurrent write must survive the tracker deletion');

    // Deleting again, and deleting something that never existed, are safe
    assert.strictEqual(await popup.deleteMetric(custom.id), false);
    assert.strictEqual(await popup.deleteMetric('never-existed'), false);
    assert.strictEqual(await popup.deleteMetric('jobs'), false);
    assert.strictEqual(await popup.deleteMetric('leetcode'), false);

    console.log('[PASS] Custom tracker deletion preserves defaults and history under concurrency');
    teardown();
  }

  // 8. Concurrent writes from two accounts stay isolated
  {
    freshEnvironment();
    const popup = loadStorageContext();
    const dock = loadStorageContext();

    const writes = [];
    for (let i = 0; i < 4; i++) {
      writes.push(popup.addLog({ metricId: 'jobs', userEmail: 'alice@example.com' }));
      writes.push(dock.addLog({ metricId: 'jobs', userEmail: 'BOB@Example.com' }));
      writes.push(popup.addLog({ metricId: 'jobs', userEmail: null }));
    }
    await Promise.all(writes);

    const alice = await popup.getLogs({}, 'alice@example.com');
    const bob = await popup.getLogs({}, 'bob@example.com');
    const anon = await popup.getLogs({}, null);

    assert.strictEqual(alice.length, 4, 'Alice should see exactly her 4 entries');
    assert.strictEqual(bob.length, 4, 'Bob should see exactly his 4 entries');
    assert.strictEqual(anon.length, 4, 'Signed-out entries stay in their own bucket');
    assert.ok(alice.every(l => l.userEmail === 'alice@example.com'));
    assert.ok(bob.every(l => l.userEmail === 'bob@example.com'));
    assert.ok(anon.every(l => l.userEmail === null));

    console.log('[PASS] Concurrent multi-account writes stay isolated');
    teardown();
  }

  // 9. Cumulative LeetCode solve time is scoped per account and ignores
  //    entries logged without a timed session.
  {
    freshEnvironment(1, 1);
    const store = loadStorageContext();
    const today = store.getLocalDateStr();
    const older = store.addDays(today, -3);

    await store.addLog({ metricId: 'leetcode', date: today, solveTimeSeconds: 300, userEmail: 'alice@example.com' });
    await store.addLog({ metricId: 'leetcode', date: today, solveTimeSeconds: 600, userEmail: 'alice@example.com' });
    await store.addLog({ metricId: 'leetcode', date: older, solveTimeSeconds: 900, userEmail: 'alice@example.com' });
    await store.addLog({ metricId: 'leetcode', date: today, userEmail: 'alice@example.com' });
    await store.addLog({ metricId: 'leetcode', date: today, solveTimeSeconds: 111, userEmail: 'bob@example.com' });
    await store.addLog({ metricId: 'jobs', date: today, solveTimeSeconds: 999, userEmail: 'alice@example.com' });

    const alice = await store.getLeetcodeTimeStats('alice@example.com');
    assert.strictEqual(alice.todaySeconds, 900, 'Today total must exclude other days and other metrics');
    assert.strictEqual(alice.totalSeconds, 1800);
    assert.strictEqual(alice.sessionCount, 3, 'Untimed entries must not count as sessions');
    assert.strictEqual(alice.avgSeconds, 600);

    const bob = await store.getLeetcodeTimeStats('bob@example.com');
    assert.strictEqual(bob.totalSeconds, 111, 'Solve time must not leak across accounts');

    const anon = await store.getLeetcodeTimeStats(null);
    assert.strictEqual(anon.totalSeconds, 0);
    assert.strictEqual(anon.avgSeconds, 0, 'Empty stats must not divide by zero');

    // Malformed solve times are sanitized on write
    const bad = await store.addLog({ metricId: 'leetcode', solveTimeSeconds: -50 });
    assert.strictEqual(bad.solveTimeSeconds, 0);
    const nan = await store.addLog({ metricId: 'leetcode', solveTimeSeconds: 'abc' });
    assert.strictEqual(nan.solveTimeSeconds, 0);

    assert.strictEqual(store.formatTimeHMS(0), '0s');
    assert.strictEqual(store.formatTimeHMS(90), '1m 30s');
    assert.strictEqual(store.formatTimeHMS(3660), '1h 1m');
    assert.strictEqual(store.formatTimeHMS(-5), '0s');

    console.log('[PASS] Cumulative solve-time stats are per-account and ignore untimed entries');
    teardown();
  }

  // 10. Two contexts on one IndexedDB (the popup and the service worker
  //     answering a content script): 50 writes each, interleaved with
  //     deletes and undos, lose nothing and keep the aggregates exact.
  {
    installMockChrome();
    installMockIDB();
    const popup = loadStorageContext();
    const worker = loadStorageContext();
    const today = popup.getLocalDateStr();

    const seeded = [];
    for (let i = 0; i < 6; i++) seeded.push(await worker.addLog({ metricId: 'jobs', company: 'Seed ' + i }));

    const ops = [];
    for (let i = 0; i < 50; i++) {
      ops.push(popup.addLog({ metricId: 'jobs', company: 'Popup ' + i }));
      ops.push(worker.addLog({ metricId: 'leetcode', company: 'Worker ' + i }));
    }
    ops.push(popup.deleteLog(seeded[0].id), worker.deleteLog(seeded[1].id), popup.undoLastLog('jobs', today));
    const results = await Promise.all(ops);
    assert.strictEqual(results[100], true);
    assert.strictEqual(results[101], true);
    assert.strictEqual(results[102], true);

    const logs = await popup.getLogs();
    assert.strictEqual(logs.length, 6 + 100 - 3, 'every add survives and exactly three entries were removed, got ' + logs.length);
    const stats = await worker.getStats();
    const jobs = logs.filter(l => l.metricId === 'jobs').length;
    assert.strictEqual(stats.totals.jobs, jobs, 'jobs aggregate matches the surviving entries');
    assert.strictEqual(stats.totals.leetcode, 50);
    assert.strictEqual(stats.totalLogs, logs.length);

    console.log('[PASS] Two contexts on one IndexedDB: 100 interleaved writes plus deletes stay exact');
    teardown();
  }

  console.log('--- test/concurrency.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
