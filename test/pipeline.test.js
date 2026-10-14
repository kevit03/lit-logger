// Application pipeline and quality-of-life storage features: status stages,
// response rate and turnaround, the 90-day duplicate-application check,
// search, the weekly recap, JSON backup and restore, rotating snapshots,
// the CSV / Markdown exporters, and the content-script proxy that routes log
// calls to the service worker.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const { installMockIDB, uninstallMockIDB } = require('./mock_idb');

function loadStorage() {
  delete require.cache[require.resolve('../shared/auth')];
  delete require.cache[require.resolve('../shared/storage')];
  delete require.cache[require.resolve('../shared/db')];
  const TrackerAuth = require('../shared/auth');
  global.TrackerAuth = TrackerAuth;
  const TrackerStorage = require('../shared/storage');
  return { TrackerStorage, TrackerAuth };
}

function fresh() {
  const mock = installMockChrome();
  installMockIDB();
  return Object.assign({ mock }, loadStorage());
}

function cleanup() {
  delete global.TrackerAuth;
  uninstallMockIDB();
  uninstallMockChrome();
}

async function run() {
  console.log('--- Running test/pipeline.test.js ---');

  // 1. Status stages, respondedAt, and the pipeline / response summary.
  {
    const { TrackerStorage, TrackerAuth } = fresh();
    await TrackerAuth.setUser({ email: 'alice@example.com' });
    const today = TrackerStorage.getLocalDateStr();
    const a = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Acme', role: 'Engineer', date: TrackerStorage.addDays(today, -10) });
    const b = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Globex', role: 'Designer', date: TrackerStorage.addDays(today, -4) });
    const c = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Initech', count: 2 });
    const lc = await TrackerStorage.addLog({ metricId: 'leetcode' });

    const moved = await TrackerStorage.setLogStatus(a.id, 'interviewing');
    assert.strictEqual(moved.status, 'interviewing');
    assert.ok(moved.respondedAt && moved.statusUpdatedAt, 'leaving Applied stamps respondedAt');
    const firstResponse = moved.respondedAt;
    const offer = await TrackerStorage.setLogStatus(a.id, 'offer');
    assert.strictEqual(offer.respondedAt, firstResponse, 'respondedAt keeps the first response');
    await TrackerStorage.setLogStatus(b.id, 'rejected');
    assert.strictEqual(await TrackerStorage.setLogStatus(b.id, 'bogus'), false, 'unknown stages are refused');
    assert.strictEqual((await TrackerStorage.setLogStatus(lc.id, 'offer')).status, undefined, 'non-job entries have no stage');

    const summary = await TrackerStorage.getPipelineSummary();
    assert.deepStrictEqual(summary.counts, { applied: 2, review: 0, interviewing: 0, offer: 1, rejected: 1 });
    assert.strictEqual(summary.total, 4, 'weighted by entry count (Initech counts twice)');
    assert.strictEqual(summary.responded, 2);
    assert.strictEqual(summary.responseRate, 50);
    assert.strictEqual(summary.turnaroundSamples, 2);
    assert.strictEqual(summary.avgTurnaroundDays, 7, 'mean of 10 and 4 days');

    const back = await TrackerStorage.setLogStatus(b.id, 'applied');
    assert.strictEqual(back.respondedAt, undefined, 'moving back to Applied clears the response');

    // Edits: content fields only, and never across accounts.
    const edited = await TrackerStorage.updateLog(c.id, { company: '  Initech LLC ', role: 'PM', notes: 'Referral', userEmail: 'mallory@example.com', id: 'hijack' });
    assert.strictEqual(edited.company, 'Initech LLC');
    assert.strictEqual(edited.role, 'PM');
    assert.strictEqual(edited.userEmail, 'alice@example.com', 'the owner cannot be edited');
    assert.strictEqual(edited.id, c.id);
    await TrackerAuth.setUser({ email: 'bob@example.com' });
    assert.strictEqual(await TrackerStorage.updateLog(c.id, { company: 'Pwned' }), false, 'cross-account edits are rejected');
    assert.strictEqual(await TrackerStorage.setLogStatus(a.id, 'rejected'), false);
    await TrackerAuth.setUser({ email: 'alice@example.com' });
    assert.strictEqual((await TrackerStorage.getLogs({ metricId: 'jobs' })).find(l => l.id === c.id).company, 'Initech LLC');

    const pure = TrackerStorage.summarizePipeline([]);
    assert.strictEqual(pure.responseRate, null, 'no applications means no rate, not 0%');
    assert.strictEqual(pure.avgTurnaroundDays, null);

    console.log('[PASS] Pipeline stages, response rate, turnaround, and scoped edits');
    cleanup();
  }

  // 2. Duplicate-application check: normalized company, 90-day window,
  // same-listing detection, account isolation.
  {
    const { TrackerStorage, TrackerAuth } = fresh();
    await TrackerAuth.setUser({ email: 'alice@example.com' });
    const today = TrackerStorage.getLocalDateStr();
    const old = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Acme, Inc.', role: 'Engineer', date: TrackerStorage.addDays(today, -24), sourceId: 'greenhouse:job-42', source: 'auto' });
    await TrackerStorage.addLog({ metricId: 'jobs', company: 'Stale Corp', date: TrackerStorage.addDays(today, -91) });
    await TrackerStorage.addLog({ metricId: 'leetcode', company: 'Acme' });

    assert.strictEqual(TrackerStorage.normalizeCompany('ACME Corp.'), 'acme');
    assert.strictEqual(TrackerStorage.normalizeCompany('The Trade Desk'), 'tradedesk');
    assert.strictEqual(TrackerStorage.normalizeCompany('Johnson & Johnson'), 'johnsonandjohnson');
    assert.strictEqual(TrackerStorage.normalizeCompany('Co'), 'co', 'a name made only of noise words keeps itself');

    const hit = await TrackerStorage.findRecentApplication({ company: 'acme' });
    assert.ok(hit, 'Acme, Inc. matches acme');
    assert.strictEqual(hit.log.id, old.id);
    assert.strictEqual(hit.daysAgo, 24);
    assert.strictEqual(hit.sameListing, false);
    assert.strictEqual((await TrackerStorage.findRecentApplication({ company: 'Other', sourceId: 'greenhouse:job-42' })).sameListing, true, 'the same listing is found even under another company name');
    assert.strictEqual(await TrackerStorage.findRecentApplication({ company: 'Stale Corp' }), null, 'older than 90 days is not a duplicate');
    assert.ok(await TrackerStorage.findRecentApplication({ company: 'Stale Corp', withinDays: 120 }), 'the window is configurable');
    assert.strictEqual(await TrackerStorage.findRecentApplication({ company: 'Acme', excludeId: old.id }), null, 'an entry is not its own duplicate');
    assert.strictEqual(await TrackerStorage.findRecentApplication({ company: '' }), null);

    await TrackerAuth.setUser({ email: 'bob@example.com' });
    assert.strictEqual(await TrackerStorage.findRecentApplication({ company: 'Acme' }), null, 'another account\'s applications never count');

    console.log('[PASS] Duplicate-application check: normalization, window, same listing, isolation');
    cleanup();
  }

  // 3. Search across history and recent-entry listing.
  {
    const { TrackerStorage } = fresh();
    await TrackerStorage.addLog({ metricId: 'jobs', company: 'Stripe', role: 'Backend Engineer', notes: 'Referral from Sam' });
    const inter = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Plaid', role: 'Frontend Engineer' });
    await TrackerStorage.setLogStatus(inter.id, 'interviewing');
    await TrackerStorage.addLog({ metricId: 'leetcode', notes: 'Two Sum, easy' });

    let res = await TrackerStorage.searchLogs('engineer');
    assert.strictEqual(res.total, 2);
    res = await TrackerStorage.searchLogs('backend stripe');
    assert.strictEqual(res.total, 1, 'every word must match');
    assert.strictEqual(res.results[0].company, 'Stripe');
    res = await TrackerStorage.searchLogs('interviewing');
    assert.strictEqual(res.results[0].company, 'Plaid', 'status labels are searchable');
    res = await TrackerStorage.searchLogs('leetcode two');
    assert.strictEqual(res.total, 1, 'tracker names are searchable');
    assert.deepStrictEqual(await TrackerStorage.searchLogs('   '), { results: [], total: 0 });

    const recent = await TrackerStorage.getRecentLogs({ limit: 10 });
    assert.strictEqual(recent.total, 2, 'recent defaults to job entries');
    const filtered = await TrackerStorage.getRecentLogs({ status: 'interviewing' });
    assert.deepStrictEqual(filtered.results.map(l => l.company), ['Plaid']);

    console.log('[PASS] Search matches company, role, notes, status, and tracker; recent list filters by stage');
    cleanup();
  }

  // 4. Weekly goal, week-to-date, and the Monday recap for last week.
  {
    const { TrackerStorage } = fresh();
    const today = TrackerStorage.getLocalDateStr();
    const thisMonday = TrackerStorage.weekStartOf(today);
    const lastMonday = TrackerStorage.addDays(thisMonday, -7);
    await TrackerStorage.setMetricWeeklyGoal('jobs', 25);
    await TrackerStorage.setMetricGoal('jobs', 2);
    for (let i = 0; i < 3; i++) await TrackerStorage.addLog({ metricId: 'jobs', date: lastMonday });
    await TrackerStorage.addLog({ metricId: 'jobs', date: TrackerStorage.addDays(lastMonday, 2) });
    const responded = await TrackerStorage.addLog({ metricId: 'jobs', date: TrackerStorage.addDays(lastMonday, -30) });
    await TrackerStorage.addLog({ metricId: 'jobs', date: thisMonday });

    const metrics = await TrackerStorage.getMetrics();
    assert.strictEqual(metrics.find(m => m.id === 'jobs').weeklyGoal, 25);
    assert.strictEqual(metrics.find(m => m.id === 'leetcode').weeklyGoal, 0, 'weekly goals default to off');

    const stats = await TrackerStorage.getStats();
    assert.strictEqual(stats.weekStartStr, thisMonday);
    assert.strictEqual(stats.weekToDate.jobs, 1, 'week-to-date counts from Monday');

    const recap = await TrackerStorage.getWeekSummary();
    assert.strictEqual(recap.weekStart, lastMonday);
    assert.strictEqual(recap.weekEnd, TrackerStorage.addDays(lastMonday, 6));
    const jobs = recap.metrics.find(m => m.id === 'jobs');
    assert.strictEqual(jobs.total, 4);
    assert.strictEqual(jobs.activeDays, 2);
    assert.strictEqual(jobs.goalDays, 1, 'only Monday reached the daily goal of 2');
    assert.deepStrictEqual(jobs.bestDay, { date: lastMonday, count: 3 });
    assert.strictEqual(jobs.weeklyGoal, 25);
    assert.strictEqual(recap.responses, 0);
    assert.ok(responded.id);

    await TrackerStorage.setMetricWeeklyGoal('jobs', 0);
    assert.strictEqual((await TrackerStorage.getMetrics()).find(m => m.id === 'jobs').weeklyGoal, 0, 'a weekly goal can be turned off');

    console.log('[PASS] Weekly goals, week-to-date totals, and the previous-week recap');
    cleanup();
  }

  // 5. Backup and restore: export, restore into another account on another
  // device, idempotent re-import, invalid rows, custom trackers.
  {
    const { TrackerStorage, TrackerAuth } = fresh();
    await TrackerAuth.setUser({ email: 'alice@example.com' });
    const custom = await TrackerStorage.addMetric({ name: 'Cold Emails', unit: 'emails', dailyGoal: 3 });
    const j = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Acme', role: 'SWE' });
    await TrackerStorage.setLogStatus(j.id, 'review');
    await TrackerStorage.addLog({ metricId: custom.id, notes: 'Sent 3' });
    const backup = await TrackerStorage.exportBackup();
    assert.strictEqual(backup.format, 'lit-backup');
    assert.strictEqual(backup.version, 2);
    assert.strictEqual(backup.account, 'alice@example.com');
    assert.strictEqual(backup.logs.length, 2);
    assert.ok(backup.metrics.some(m => m.id === custom.id));
    const text = JSON.stringify(backup);
    cleanup();

    const { TrackerStorage: device2, TrackerAuth: auth2 } = fresh();
    await auth2.setUser({ email: 'alice.new@example.com' });
    const result = await device2.importBackup(text);
    assert.strictEqual(result.added, 2);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.metricsAdded, 1);
    const restored = await device2.getLogs();
    assert.strictEqual(restored.length, 2);
    assert.ok(restored.every(l => l.userEmail === 'alice.new@example.com'), 'entries land in the signed-in account');
    assert.strictEqual(restored.find(l => l.metricId === 'jobs').status, 'review', 'pipeline stage survives the round trip');
    assert.ok((await device2.getMetrics()).some(m => m.id === custom.id && m.userEmail === 'alice.new@example.com'), 'custom trackers come along');

    const again = await device2.importBackup(backup);
    assert.strictEqual(again.added, 0, 're-importing the same backup is a no-op');
    assert.strictEqual(again.skipped, 2);

    const messy = await device2.importBackup({ logs: [{ date: 'yesterday' }, null, { metricId: 'jobs', date: '2026-02-30' }, { metricId: 'jobs', date: '2026-09-01', company: 'Old Export' }] });
    assert.strictEqual(messy.invalid, 3);
    assert.strictEqual(messy.added, 1);
    await assert.rejects(() => device2.importBackup('{not json'), /not valid JSON/);
    await assert.rejects(() => device2.importBackup({ hello: 'world' }), /does not look like a LIT backup/);

    const stats = await device2.getStats();
    assert.strictEqual(stats.totals.jobs, 2, 'aggregates include restored entries');

    console.log('[PASS] Backup export and merge-only restore across accounts and devices');
    cleanup();
  }

  // 6. Snapshots: rotation keeps the last four, the weekly schedule gates
  // automatic ones, and a restore brings back only the signed-in account.
  {
    const { TrackerStorage, TrackerAuth } = fresh();
    await TrackerAuth.setUser({ email: 'alice@example.com' });
    const a1 = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Alpha' });
    await TrackerStorage.addLog({ metricId: 'jobs', company: 'Bob Co', userEmail: 'bob@example.com' });

    assert.strictEqual(await TrackerStorage.maybeAutoSnapshot(Date.now()) !== null, true, 'first run takes a snapshot');
    assert.strictEqual(await TrackerStorage.maybeAutoSnapshot(Date.now() + 1000), null, 'not again within a week');
    const weekly = await TrackerStorage.maybeAutoSnapshot(Date.now() + 8 * 86400000);
    assert.ok(weekly && weekly.reason === 'weekly', 'again after a week');

    for (let i = 0; i < 4; i++) await TrackerStorage.createSnapshot({ reason: 'manual' });
    const list = await TrackerStorage.listSnapshots();
    assert.strictEqual(list.length, 4, 'rotation keeps the last four');
    assert.ok(list.every(s => s.reason === 'manual'), 'the oldest snapshots rotate out first');
    assert.strictEqual(list[0].logCount, 2);
    assert.deepStrictEqual(list[0].accounts, ['alice@example.com', 'bob@example.com']);

    await TrackerStorage.deleteLog(a1.id);
    await TrackerStorage.deleteLog((await TrackerStorage.getLogs({}, 'bob@example.com'))[0].id, 'bob@example.com');
    const res = await TrackerStorage.restoreSnapshot(list[0].id);
    assert.strictEqual(res.added, 1);
    assert.deepStrictEqual((await TrackerStorage.getLogs()).map(l => l.company), ['Alpha']);
    assert.strictEqual((await TrackerStorage.getLogs({}, 'bob@example.com')).length, 0, 'another account is never restored into');
    const full = await TrackerStorage.getSnapshot(list[0].id);
    assert.strictEqual(full.logs.length, 2, 'a snapshot can be downloaded whole');
    await assert.rejects(() => TrackerStorage.restoreSnapshot('snap-missing'), /no longer exists/);

    console.log('[PASS] Snapshots: weekly schedule, rotation to four, account-scoped restore');
    cleanup();
  }

  // 7. Exporters: CSV escaping and formula guard, Markdown tables.
  {
    const LitExport = require(path.join(__dirname, '..', 'shared', 'exporters.js'));
    const logs = [
      { date: '2026-09-01', timestamp: 't', metricId: 'jobs', count: 1, company: 'A|B "Co"', role: 'Eng\nII', notes: '=HYPERLINK("x")', status: 'offer' },
      { date: '2026-09-02', timestamp: 't', metricId: 'leetcode', count: 2, company: '', role: '', notes: '-5 min faster', solveTimeSeconds: 90 }
    ];
    const csv = LitExport.buildCsv(logs, { jobs: 'Job Applications', leetcode: 'LeetCode' });
    const rows = csv.split('\r\n');
    assert.strictEqual(rows[0], 'date,time,tracker,count,company,role,status,notes,solve_time_seconds,url');
    assert.ok(rows[1].includes('"A|B ""Co"""'), 'quotes are doubled');
    assert.ok(rows[1].includes('"\'=HYPERLINK(""x"")"'), 'a formula is neutralized');
    assert.ok(rows[1].includes('"Offer"'));
    assert.ok(rows[2].includes('"-5 min faster"'), 'a leading minus before a number stays as typed');
    assert.strictEqual(LitExport.csvCell('-cmd'), '"\'-cmd"');

    const md = LitExport.buildMarkdown(logs, { jobs: 'Job Applications', leetcode: 'LeetCode' });
    const mdRows = md.trim().split('\n');
    assert.strictEqual(mdRows[0], '| Date | Tracker | Count | Company | Role | Status | Notes |');
    assert.strictEqual(mdRows[1], '| --- | --- | --- | --- | --- | --- | --- |');
    assert.strictEqual(mdRows[2], '| 2026-09-01 | Job Applications | 1 | A\\|B "Co" | Eng II | Offer | =HYPERLINK("x") |');
    const jobsMd = LitExport.buildMarkdown([logs[0]], {}, { title: 'Applications' });
    assert.ok(jobsMd.startsWith('## Applications\n\n| Date | Company | Role | Status | Notes |'), 'job-only tables lead with company and stage');
    assert.strictEqual(LitExport.backupFilename('lit-backup', 'json', new Date(2026, 8, 30)), 'lit-backup-2026-09-30.json');

    console.log('[PASS] CSV and Markdown exporters escape cells and guard spreadsheet formulas');
  }

  // 8. Content-script proxy: log calls from a web-page context run in the
  // service worker's storage; tracker calls stay local; undefined arguments
  // keep meaning "the signed-in account", never "signed out".
  {
    const mock = installMockChrome();
    installMockIDB();
    const { TrackerStorage: worker, TrackerAuth } = loadStorage();
    worker._setMode('idb');
    assert.strictEqual(worker.serveRemote(), true);
    delete require.cache[require.resolve('../shared/storage')];
    const client = require('../shared/storage');
    client._setMode('remote');
    assert.strictEqual(await client._backendName(), 'remote');

    await TrackerAuth.setUser({ email: 'alice@example.com' });
    const added = await client.addLog({ metricId: 'jobs', company: 'Via Proxy' });
    assert.strictEqual(added.userEmail, 'alice@example.com');
    assert.strictEqual((await worker.getLogs())[0].id, added.id, 'the write landed in the worker\'s database');
    assert.strictEqual((await client.getLogs({}, undefined)).length, 1, 'undefined still means the signed-in account');
    assert.strictEqual((await client.getLogs({}, null)).length, 0, 'null still means signed out');
    const stats = await client.getStats();
    assert.strictEqual(stats.today.jobs, 1);
    const dup = await client.findRecentApplication({ company: 'via proxy' });
    assert.strictEqual(dup.log.id, added.id);
    assert.strictEqual((await client.setLogStatus(added.id, 'review')).status, 'review');
    assert.strictEqual(await client.deleteLog(added.id), true);
    assert.strictEqual((await worker.getLogs()).length, 0);

    const calls = mock.runtime.sentMessages.filter(m => m.type === 'PT_STORAGE_CALL').map(m => m.method);
    assert.ok(calls.includes('addLog') && calls.includes('getStats') && calls.includes('deleteLog'));
    const before = mock.runtime.sentMessages.length;
    await client.getMetrics();
    await client.getTheme();
    assert.strictEqual(mock.runtime.sentMessages.length, before, 'tracker and theme reads stay in the content script');

    const refused = await new Promise(resolve => mock.runtime.sendMessage({ type: 'PT_STORAGE_CALL', method: 'serveRemote', args: [] }, resolve));
    assert.strictEqual(refused.ok, false, 'only allow-listed methods can be called remotely');

    await assert.rejects(() => client.importBackup('{bad'), /not valid JSON/, 'errors travel back to the caller');

    delete global.TrackerAuth;
    uninstallMockIDB();
    uninstallMockChrome();
    console.log('[PASS] Content-script proxy: log calls run in the service worker, errors and undefined round-trip');
  }

  // Setting a stage's count directly moves entries to and from Applied.
  {
    const { TrackerStorage, TrackerAuth } = fresh();
    await TrackerAuth.setUser({ email: 'alice@example.com' });
    const today = TrackerStorage.getLocalDateStr();
    const ids = [];
    for (let i = 5; i >= 1; i--) ids.push((await TrackerStorage.addLog({ metricId: 'jobs', date: TrackerStorage.addDays(today, -i) })).id);
    const big = await TrackerStorage.addLog({ metricId: 'jobs', count: 3 });
    await TrackerStorage.addLog({ metricId: 'leetcode' });

    let r = await TrackerStorage.setStageCount('rejected', 2);
    assert.deepStrictEqual([r.count, r.moved], [2, 2]);
    let logs = await TrackerStorage.getLogs({ metricId: 'jobs' });
    const rejectedIds = logs.filter(l => l.status === 'rejected').map(l => l.id).sort();
    assert.deepStrictEqual(rejectedIds, ids.slice(0, 2).sort(), 'the oldest Applied entries move first');
    assert.ok(logs.filter(l => l.status === 'rejected').every(l => l.respondedAt), 'moved entries count as a reply');

    r = await TrackerStorage.setStageCount('archived', 1);
    assert.deepStrictEqual([r.status, r.count], ['rejected', 1], 'stage aliases resolve; lowering moves entries back');
    assert.strictEqual((await TrackerStorage.getLogs({ metricId: 'jobs' })).find(l => l.status !== 'rejected' && l.respondedAt), undefined, 'back in Applied clears respondedAt');

    r = await TrackerStorage.setStageCount('interviewing', 50);
    assert.strictEqual(r.count, 7, 'capped at what is left in Applied (4 singles + the count-3 entry)');
    r = await TrackerStorage.setStageCount('interviewing', 5);
    assert.strictEqual(r.count, 5, 'a count-3 entry moves back only when it fits');
    const summary = await TrackerStorage.getPipelineSummary();
    assert.deepStrictEqual(summary.counts, { applied: 2, review: 0, interviewing: 5, offer: 0, rejected: 1 });
    assert.strictEqual(summary.total, 8, 'moving stages never changes the total');
    assert.ok(big.id);

    await assert.rejects(() => TrackerStorage.setStageCount('applied', 3), /other than Applied/);
    await assert.rejects(() => TrackerStorage.setStageCount('bogus', 3), /other than Applied/);
    cleanup();
    console.log('[PASS] Stage counts can be set directly; entries move to and from Applied');
  }

  console.log('--- test/pipeline.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
