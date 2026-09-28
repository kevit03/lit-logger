// Custom tracker creation, default metrics protection, and log preservation tests
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

function getFreshStorage(initialStore = {}) {
  const mock = installMockChrome(initialStore);
  delete require.cache[require.resolve('../shared/storage')];
  delete require.cache[require.resolve('../shared/auth')];
  const TrackerAuth = require('../shared/auth');
  global.TrackerAuth = TrackerAuth;
  const TrackerStorage = require('../shared/storage');
  global.TrackerStorage = TrackerStorage;
  return { mock, TrackerStorage, TrackerAuth };
}

function baseMetrics() {
  return [
    { id: 'jobs', name: 'Job Applications', unit: 'jobs', dailyGoal: 5, isDefault: true },
    { id: 'leetcode', name: 'LeetCode', unit: 'problems', dailyGoal: 2, isDefault: true }
  ];
}

async function run() {
  console.log('--- Running test/metrics.test.js ---');

  // 1. Default Metrics Initialization and Protection
  {
    const { TrackerStorage } = getFreshStorage();

    const metrics = await TrackerStorage.getMetrics();
    assert.strictEqual(metrics.length, 2, 'Default metrics should have 2 entries');
    const jobsMetric = metrics.find(m => m.id === 'jobs');
    const leetcodeMetric = metrics.find(m => m.id === 'leetcode');
    assert.ok(jobsMetric, 'jobs metric must exist');
    assert.ok(leetcodeMetric, 'leetcode metric must exist');
    assert.strictEqual(jobsMetric.isDefault, true);
    assert.strictEqual(leetcodeMetric.isDefault, true);

    // Attempt to delete 'jobs'
    const delJobs = await TrackerStorage.deleteMetric('jobs');
    assert.strictEqual(delJobs, false, 'deleteMetric on default metric "jobs" must return false');

    // Attempt to delete 'leetcode'
    const delLeetcode = await TrackerStorage.deleteMetric('leetcode');
    assert.strictEqual(delLeetcode, false, 'deleteMetric on default metric "leetcode" must return false');

    // Verify default metrics still intact
    const metricsAfter = await TrackerStorage.getMetrics();
    assert.strictEqual(metricsAfter.length, 2);
    assert.ok(metricsAfter.some(m => m.id === 'jobs'));
    assert.ok(metricsAfter.some(m => m.id === 'leetcode'));

    console.log('[PASS] Default metrics initialization and deletion protection');
    delete global.TrackerAuth;
    delete global.TrackerStorage;
    uninstallMockChrome();
  }

  // 2. Custom Tracker Creation
  {
    const { TrackerStorage } = getFreshStorage();

    const custom = await TrackerStorage.addMetric({
      name: 'System Design',
      color: '#fbbc04',
      icon: 'architecture',
      unit: 'chapters'
    });

    assert.ok(custom.id, 'Custom metric ID must be generated');
    assert.notStrictEqual(custom.id, 'jobs');
    assert.notStrictEqual(custom.id, 'leetcode');
    assert.strictEqual(custom.name, 'System Design');
    assert.strictEqual(custom.color, '#fbbc04');
    assert.strictEqual(custom.icon, 'architecture');
    assert.strictEqual(custom.unit, 'chapters');
    assert.strictEqual(custom.isDefault, false);

    const metrics = await TrackerStorage.getMetrics();
    assert.strictEqual(metrics.length, 3);
    assert.ok(metrics.some(m => m.id === custom.id));

    console.log('[PASS] Custom tracker creation');
    delete global.TrackerAuth;
    delete global.TrackerStorage;
    uninstallMockChrome();
  }

  // 3. Historical Log Preservation on Custom Tracker Deletion
  {
    const { TrackerStorage } = getFreshStorage();

    const custom = await TrackerStorage.addMetric({
      name: 'Mock Interviews',
      color: '#ea4335',
      icon: 'people',
      unit: 'sessions'
    });

    // Add logs for this custom tracker
    const log1 = await TrackerStorage.addLog({
      metricId: custom.id,
      notes: 'Mock interview with senior engineer',
      count: 1
    });

    const log2 = await TrackerStorage.addLog({
      metricId: custom.id,
      notes: 'Peer mock session',
      count: 2
    });

    let customLogs = await TrackerStorage.getLogs({ metricId: custom.id });
    assert.strictEqual(customLogs.length, 2);

    // Delete custom tracker
    const delResult = await TrackerStorage.deleteMetric(custom.id);
    assert.strictEqual(delResult, true, 'Deleting custom metric should return true');

    // Verify metric is removed from active list
    const metrics = await TrackerStorage.getMetrics();
    assert.strictEqual(metrics.length, 2);
    assert.ok(!metrics.some(m => m.id === custom.id));

    // CRITICAL: Historical logs must still exist in storage!
    customLogs = await TrackerStorage.getLogs({ metricId: custom.id });
    assert.strictEqual(customLogs.length, 2, 'Historical logs must NOT be deleted when custom metric is removed');
    assert.strictEqual(customLogs[0].id, log2.id);
    assert.strictEqual(customLogs[1].id, log1.id);

    console.log('[PASS] Historical log preservation on custom tracker deletion');
    delete global.TrackerAuth;
    delete global.TrackerStorage;
    uninstallMockChrome();
  }

  // 4. Batch Metrics Management and Custom Filtering
  {
    const { TrackerStorage } = getFreshStorage();

    const initialMetrics = await TrackerStorage.getMetrics();
    assert.strictEqual(initialMetrics.length, 2);

    // Add custom metric
    const custom = await TrackerStorage.addMetric({
      name: 'Portfolio Updates',
      color: '#34a853',
      unit: 'commits'
    });

    const updated = await TrackerStorage.getMetrics();
    assert.strictEqual(updated.length, 3);

    // Save modified list
    const reordered = [updated[2], updated[0], updated[1]];
    await TrackerStorage.saveMetrics(reordered);

    const saved = await TrackerStorage.getMetrics();
    assert.strictEqual(saved.length, 3);
    assert.strictEqual(saved[0].id, custom.id);

    console.log('[PASS] Batch metrics management and custom reordering');
    delete global.TrackerAuth;
    delete global.TrackerStorage;
    uninstallMockChrome();
  }

  // 5. Daily Goal Targets and Activity History
  {
    const { TrackerStorage } = getFreshStorage();

    const metrics = await TrackerStorage.getMetrics();
    const jobsMetric = metrics.find(m => m.id === 'jobs');
    assert.strictEqual(jobsMetric.dailyGoal, 5, 'Jobs default goal must be 5');

    // Update goal
    await TrackerStorage.setMetricGoal('jobs', 10);
    const updatedMetrics = await TrackerStorage.getMetrics();
    const updatedJobs = updatedMetrics.find(m => m.id === 'jobs');
    assert.strictEqual(updatedJobs.dailyGoal, 10, 'Jobs goal should be updated to 10');

    // Add logs across today and previous days
    await TrackerStorage.addLog({ metricId: 'jobs', count: 3 });
    const history = await TrackerStorage.getActivityHistory(30);
    assert.strictEqual(history.days.length, 30, 'History should return 30 days');
    assert.strictEqual(history.totalCount, 3, 'Total count should be 3');
    assert.strictEqual(history.activeDaysCount, 1, 'Active days count should be 1');
    assert.ok(typeof history.dailyAverage === 'number', 'Daily average should be a number');

    console.log('[PASS] Daily goal targets and activity history computation');
    delete global.TrackerAuth;
    delete global.TrackerStorage;
    uninstallMockChrome();
  }

  // Legacy built-in calorie metric saved by older installs stays hidden
  {
    const { TrackerStorage } = getFreshStorage({
      metrics: baseMetrics().concat([
        { id: 'calories', name: 'Calories', unit: 'kcal', dailyGoal: 2000, isBudget: true, isDefault: true }
      ])
    });
    const metrics = await TrackerStorage.getMetrics();
    assert.deepStrictEqual(metrics.map(m => m.id).sort(), ['jobs', 'leetcode'], 'legacy calorie metric must not be returned');

    console.log('[PASS] Legacy calorie metric filtered out');
    delete global.TrackerAuth;
    delete global.TrackerStorage;
    uninstallMockChrome();
  }

  console.log('--- test/metrics.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
