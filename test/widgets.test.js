// Popup widget layout tests: registry, normalization of whatever is in
// storage, add / remove / move / update, singleton enforcement, tracker
// binding resolution, compact / expanded sizing and accordion state, the
// job-pipeline widgets, the one-time upgrade of older layouts, and
// persistence through chrome.storage.sync.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

function fresh() {
  const full = path.join(__dirname, '..', 'shared', 'widgets.js');
  delete require.cache[require.resolve(full)];
  return require(full);
}

async function run() {
  console.log('--- Running test/widgets.test.js ---');

  // Registry and defaults
  {
    installMockChrome();
    const W = fresh();
    const types = Object.keys(W.TYPES);
    assert.deepStrictEqual(types.sort(), ['activity', 'details', 'goal', 'pipeline', 'recentList', 'responseStats', 'streak', 'summary', 'timeStats', 'timer']);
    const items = W.defaultItems();
    assert.deepStrictEqual(items.map(i => i.type), ['timer', 'timeStats', 'goal', 'details', 'pipeline', 'recentList', 'streak', 'responseStats', 'summary', 'activity'], 'the recommended layout');
    assert.ok(items.every(i => typeof i.id === 'string' && i.id.startsWith(i.type + '-')), 'every default item gets an id');
    assert.strictEqual(new Set(items.map(i => i.id)).size, items.length, 'ids are unique');
    const activity = items.find(i => i.type === 'activity');
    assert.deepStrictEqual(activity.options, { metricId: 'active', days: 30, chart: 'bar', showStats: true, size: 'expanded', collapsed: false });
    assert.deepStrictEqual(items.find(i => i.type === 'timer').options, { size: 'expanded', collapsed: false });
    assert.deepStrictEqual(items.find(i => i.type === 'streak').options, { metricId: 'active', size: 'compact', collapsed: false }, 'streak and response rate pair up as compact cards');
    assert.deepStrictEqual(items.find(i => i.type === 'responseStats').options, { size: 'compact', collapsed: false });
    uninstallMockChrome();
    console.log('[PASS] Registry exposes ten widget types with a stable recommended layout');
  }

  // Normalization is defensive
  {
    installMockChrome();
    const W = fresh();
    const dirty = { version: 1, items: [
      { id: 'a', type: 'goal', options: { metricId: 'jobs' } },
      { id: 'a', type: 'summary' },
      { type: 'nope' },
      'garbage',
      null,
      { id: 't1', type: 'timer' },
      { id: 't2', type: 'timer' },
      { id: 'c', type: 'activity', options: { days: 12, showStats: 'yes', collapsed: 1, metricId: '', chart: 'pie', size: 'huge' } },
      { id: 'd', type: 'activity', options: { days: '60', showStats: false, chart: 'heatmap', size: 'compact' } },
      { id: 'p', type: 'pipeline', options: { metricId: 'leetcode', size: 'compact', collapsed: 'yes', junk: 1 } },
      { id: 'proto', type: '__proto__' },
      { id: 'ctor', type: 'constructor' }
    ] };
    const items = W.normalize(dirty);
    assert.deepStrictEqual(items.map(i => i.type), ['goal', 'summary', 'timer', 'activity', 'activity', 'pipeline'], 'inherited property names are not widget types');
    assert.strictEqual(items[0].id, 'a');
    assert.notStrictEqual(items[1].id, 'a', 'a duplicate id is re-minted');
    assert.strictEqual(items.filter(i => i.type === 'timer').length, 1, 'singletons collapse to one');
    assert.strictEqual(items[2].id, 't1', 'the first singleton wins');
    assert.deepStrictEqual(items[3].options, { metricId: 'active', days: 30, chart: 'bar', showStats: true, size: 'expanded', collapsed: true }, 'bad days, chart, and size fall back; showStats coerces; empty metric follows the tab');
    assert.deepStrictEqual(items[4].options, { metricId: 'active', days: 60, chart: 'heatmap', showStats: false, size: 'compact', collapsed: false });
    assert.deepStrictEqual(items[5].options, { size: 'compact', collapsed: true }, 'pipeline widgets drop options they do not have');
    assert.deepStrictEqual(W.normalize(null).map(i => i.type), W.defaultItems().map(i => i.type), 'nothing stored means the default layout');
    assert.deepStrictEqual(W.normalize({ version: 1, items: [] }), [], 'an explicitly empty layout stays empty');
    assert.deepStrictEqual(W.normalize([{ type: 'streak' }]).map(i => i.type), ['streak'], 'a bare array is accepted');
    uninstallMockChrome();
    console.log('[PASS] Normalization drops junk, collapses singletons, and repairs options');
  }

  // Mutations persist and serialize
  {
    const chrome = installMockChrome();
    const W = fresh();
    let items = await W.load();
    assert.strictEqual(items.length, 10);
    assert.ok(chrome.storage.sync.store[W.STORAGE_KEY], 'first load persists the default layout');
    assert.strictEqual(chrome.storage.sync.store[W.STORAGE_KEY].version, 2);
    assert.deepStrictEqual(items.map(i => i.id), ['timer-default', 'timeStats-default', 'goal-default', 'details-default', 'pipeline-default', 'recentList-default', 'streak-default', 'responseStats-default', 'summary-default', 'activity-default'], 'default ids are fixed');
    // Trim to the original six so the index arithmetic below stays readable.
    for (const id of ['pipeline-default', 'recentList-default', 'streak-default', 'responseStats-default']) items = await W.remove(id);
    assert.strictEqual(items.length, 6);

    // Regression: on a fresh install, an edit keyed by a default id must land.
    items = await W.reorder('goal-default', null);
    assert.strictEqual(items[items.length - 1].id, 'goal-default', 'reorder finds a default widget on a fresh install');
    items = await W.reorder('goal-default', 'details-default');

    items = await W.add('streak', { metricId: 'leetcode' });
    assert.strictEqual(items.length, 7);
    assert.strictEqual(items[6].type, 'streak');
    assert.strictEqual(items[6].options.metricId, 'leetcode');
    assert.strictEqual(chrome.storage.sync.store[W.STORAGE_KEY].items.length, 7, 'add persisted');

    items = await W.add('activity', { days: 7 });
    assert.strictEqual(items.length, 8, 'non-singleton types can be added repeatedly');
    assert.strictEqual(items[7].options.days, 7);

    const before = items.length;
    items = await W.add('timer');
    assert.strictEqual(items.length, before, 'a second timer is refused');
    await assert.rejects(() => W.add('bogus'), /Unknown widget type/);

    const streakId = items.find(i => i.type === 'streak').id;
    items = await W.move(streakId, -1);
    assert.strictEqual(items.findIndex(i => i.id === streakId), 5, 'moved up one slot');
    items = await W.move(streakId, -10);
    assert.strictEqual(items.findIndex(i => i.id === streakId), 4, 'delta is a single step regardless of magnitude');
    const firstId = items[0].id;
    items = await W.move(firstId, -1);
    assert.strictEqual(items[0].id, firstId, 'moving the top item up is a no-op');
    const lastId = items[items.length - 1].id;
    items = await W.move(lastId, 1);
    assert.strictEqual(items[items.length - 1].id, lastId, 'moving the bottom item down is a no-op');
    items = await W.move('missing', 1);
    assert.strictEqual(items.length, 8, 'moving an unknown id changes nothing');

    const actId = items.find(i => i.type === 'activity').id;
    items = await W.update(actId, { days: 14, metricId: 'jobs', collapsed: true, chart: 'area', size: 'compact' });
    const act = items.find(i => i.id === actId);
    assert.deepStrictEqual(act.options, { metricId: 'jobs', days: 14, chart: 'area', showStats: true, size: 'compact', collapsed: true });
    items = await W.update(actId, { options: { days: 99 } });
    assert.strictEqual(items.find(i => i.id === actId).options.days, 30, 'an invalid update falls back to the default, not the old value');
    assert.strictEqual(items.find(i => i.id === actId).options.metricId, 'jobs', 'untouched options survive an update');

    // Drag and drop: drop before a neighbour, or at the end.
    const ids = () => items.map(i => i.id);
    const [a, b, c] = ids();
    items = await W.reorder(a, c);
    assert.deepStrictEqual(ids().slice(0, 3), [b, a, c], 'dropped before c');
    items = await W.reorder(a, null);
    assert.strictEqual(ids()[ids().length - 1], a, 'null drops at the end');
    items = await W.reorder(a, b);
    assert.strictEqual(ids()[0], a, 'dropped before the first item lands first');
    const snapshot = ids();
    items = await W.reorder(a, a);
    assert.deepStrictEqual(ids(), snapshot, 'dropping onto itself changes nothing');
    items = await W.reorder(a, 'missing');
    assert.strictEqual(ids()[ids().length - 1], a, 'an unknown neighbour means the end');
    items = await W.reorder('missing', b);
    assert.strictEqual(ids().length, 8);
    items = await W.reorder(b, a);
    const posA = ids().indexOf(a);
    assert.strictEqual(ids()[posA - 1], b, 'b now sits immediately before a');
    assert.strictEqual(posA, ids().length - 1, 'a is still last');

    items = await W.remove(streakId);
    assert.strictEqual(items.length, 7);
    assert.ok(!items.some(i => i.id === streakId));
    items = await W.remove('missing');
    assert.strictEqual(items.length, 7);

    // Burst of edits: every one lands, in order.
    const results = await Promise.all([
      W.add('goal', { metricId: 'jobs' }),
      W.add('goal', { metricId: 'leetcode' }),
      W.remove(actId)
    ]);
    assert.strictEqual(results[2].length, 8, 'serialized: two adds then a remove');
    assert.ok(!results[2].some(i => i.id === actId));

    // A fresh module instance reads back the persisted layout.
    const W2 = fresh();
    const reloaded = await W2.load();
    assert.deepStrictEqual(reloaded.map(i => i.id), results[2].map(i => i.id), 'layout survives a popup reopen');

    items = await W.reset();
    assert.deepStrictEqual(items.map(i => i.type), ['timer', 'timeStats', 'goal', 'details', 'pipeline', 'recentList', 'streak', 'responseStats', 'summary', 'activity'], 'reset restores the recommended layout');
    uninstallMockChrome();
    console.log('[PASS] Add, move, update, remove persist to storage and serialize under a burst');
  }

  // Tracker binding and visibility
  {
    installMockChrome();
    const W = fresh();
    const metrics = [{ id: 'jobs' }, { id: 'leetcode' }, { id: 'custom-1' }];
    const follow = { type: 'goal', options: { metricId: 'active' } };
    const pinned = { type: 'goal', options: { metricId: 'custom-1' } };
    const stale = { type: 'goal', options: { metricId: 'deleted-tracker' } };
    assert.strictEqual(W.resolveMetricId(follow, 'jobs', metrics), 'jobs');
    assert.strictEqual(W.resolveMetricId(follow, 'leetcode', metrics), 'leetcode');
    assert.strictEqual(W.resolveMetricId(pinned, 'jobs', metrics), 'custom-1', 'a pin ignores the selected tab');
    assert.strictEqual(W.resolveMetricId(stale, 'jobs', metrics), 'jobs', 'a pin to a deleted tracker follows the tab instead of breaking');

    assert.strictEqual(W.isVisible({ type: 'timer' }, 'leetcode'), true);
    assert.strictEqual(W.isVisible({ type: 'timer' }, 'jobs'), false, 'timer is LeetCode-only');
    assert.strictEqual(W.isVisible({ type: 'timeStats' }, 'jobs'), false);
    assert.strictEqual(W.isVisible({ type: 'goal' }, 'jobs'), true);
    assert.strictEqual(W.isVisible({ type: 'nope' }, 'jobs'), false);
    assert.strictEqual(W.isVisible({ type: 'pipeline' }, 'jobs'), true);
    assert.strictEqual(W.isVisible({ type: 'pipeline' }, 'leetcode'), false, 'pipeline widgets are job-only');
    assert.strictEqual(W.isVisible({ type: 'recentList' }, 'custom-1'), false);
    assert.strictEqual(W.isVisible({ type: 'responseStats' }, 'jobs'), true);

    const avail = W.availableTypes(W.defaultItems());
    assert.strictEqual(avail.length, 10);
    assert.deepStrictEqual(avail.filter(t => t.isNew).map(t => t.type), ['pipeline', 'recentList', 'responseStats'], 'new widget types are flagged in the picker');
    assert.strictEqual(avail.find(t => t.type === 'timer').added, true, 'a present singleton is marked added');
    assert.strictEqual(avail.find(t => t.type === 'goal').added, false, 'multi-instance types are always addable');
    assert.strictEqual(avail.find(t => t.type === 'streak').added, false);
    uninstallMockChrome();
    console.log('[PASS] Tracker binding resolves pins and stale pins; LeetCode-only widgets hide elsewhere');
  }

  // Compact pairing: two compact widgets share a row; a compact widget with
  // no compact neighbour stretches to the full row, so there are no holes.
  {
    installMockChrome();
    const W = fresh();
    const c = id => ({ id, options: { size: 'compact' } });
    const e = id => ({ id, options: { size: 'expanded' } });
    assert.deepStrictEqual(Array.from(W.soloCompactIds([c('a'), c('b')])), []);
    assert.deepStrictEqual(Array.from(W.soloCompactIds([c('a'), e('x'), c('b')])), ['a', 'b']);
    assert.deepStrictEqual(Array.from(W.soloCompactIds([c('a'), c('b'), c('c')])), ['c']);
    assert.deepStrictEqual(Array.from(W.soloCompactIds([e('x'), c('a'), c('b'), c('c'), c('d')])), []);
    assert.deepStrictEqual(Array.from(W.soloCompactIds([])), []);
    uninstallMockChrome();
    console.log('[PASS] Compact widgets pair two to a row; an unpaired one takes the full row');
  }

  // The new widgets serialize, survive a browser restart, and a version-1
  // layout from an older build is upgraded once with the pipeline widgets.
  {
    const chrome = installMockChrome();
    const W = fresh();
    let items = await W.load();
    const pipeId = items.find(i => i.type === 'pipeline').id;
    const listId = items.find(i => i.type === 'recentList').id;
    items = await W.update(pipeId, { size: 'compact', collapsed: true });
    items = await W.update(listId, { size: 'compact' });
    items = await W.add('responseStats');
    const stored = JSON.parse(JSON.stringify(chrome.storage.sync.store[W.STORAGE_KEY]));

    // A browser restart: a fresh module instance against the same storage.
    const W2 = fresh();
    const reloaded = await W2.load();
    assert.deepStrictEqual(reloaded, items, 'every option of the new widgets survives a restart');
    assert.deepStrictEqual(chrome.storage.sync.store[W.STORAGE_KEY], stored, 'loading a current layout does not rewrite it');
    assert.deepStrictEqual(reloaded.find(i => i.id === pipeId).options, { size: 'compact', collapsed: true });
    assert.strictEqual(reloaded.filter(i => i.type === 'responseStats').length, 2, 'job widgets are not singletons');
    uninstallMockChrome();

    const chrome2 = installMockChrome();
    chrome2.storage.sync.store[W.STORAGE_KEY] = { version: 1, items: [
      { id: 'goal-default', type: 'goal', options: { metricId: 'active' } },
      { id: 'mine', type: 'activity', options: { days: 7, collapsed: true } }
    ] };
    const W3 = fresh();
    const upgraded = await W3.load();
    assert.deepStrictEqual(upgraded.map(i => i.type), ['goal', 'activity', 'pipeline', 'recentList', 'responseStats'], 'older layouts keep their order and gain the new widgets at the end');
    assert.deepStrictEqual(upgraded[1].options, { metricId: 'active', days: 7, chart: 'bar', showStats: true, size: 'expanded', collapsed: true }, 'old options carry over');
    assert.strictEqual(chrome2.storage.sync.store[W.STORAGE_KEY].version, 2, 'the upgrade is written back');
    const removed = await W3.remove(upgraded.find(i => i.type === 'pipeline').id);
    const W4 = fresh();
    assert.deepStrictEqual((await W4.load()).map(i => i.id), removed.map(i => i.id), 'a removed pipeline widget stays removed after the upgrade');
    assert.strictEqual(W3.upgrade({ version: 2, items: [] }), null);
    assert.strictEqual(W3.upgrade(null), null);
    uninstallMockChrome();
    console.log('[PASS] Pipeline, recent list, and response widgets serialize, survive restarts, and upgrade older layouts once');
  }

  console.log('--- test/widgets.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
