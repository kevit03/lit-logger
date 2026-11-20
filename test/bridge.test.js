// The popup bridge (popup/bridge.js) and module card registration in
// shared/widgets.js: isolated listeners, ready queue, module prefs, settings
// rows, and card types that clean their own options.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

function fresh(rel) {
  const file = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

async function run() {
  console.log('--- Running test/bridge.test.js ---');
  installMockChrome();
  const W = fresh('shared/widgets.js');
  global.WidgetLayout = W;
  const B = fresh('popup/bridge.js');

  // Events: a throwing listener does not stop the others; unsubscribe works.
  {
    const seen = [];
    const origWarn = console.warn;
    console.warn = () => {};
    B.on('log', () => { throw new Error('boom'); });
    const off = B.on('log', d => seen.push(d.count));
    B.emit('log', { count: 1 });
    off();
    B.emit('log', { count: 2 });
    console.warn = origWarn;
    assert.deepStrictEqual(seen, [1], 'isolated listeners; unsubscribe stops delivery');
    console.log('[PASS] Bridge events are isolated and unsubscribable');
  }

  // Ready: queued callbacks run once, in order, with the attached api; late
  // callers run right away.
  {
    const order = [];
    B.whenReady(api => order.push('a:' + api.name));
    B.whenReady(api => order.push('b:' + api.name));
    B.attach({ name: 'popup' });
    assert.deepStrictEqual(order, [], 'nothing runs before markReady');
    B.markReady();
    B.markReady();
    B.whenReady(api => order.push('c:' + api.name));
    assert.deepStrictEqual(order, ['a:popup', 'b:popup', 'c:popup']);
    console.log('[PASS] Ready queue runs once, then immediately');
  }

  // Module prefs persist to chrome.storage.local.
  {
    await B.loadModulePrefs();
    assert.strictEqual(B.modulePref('stories', true), true, 'fallback when unset');
    await B.setModulePref('stories', false);
    assert.strictEqual(B.modulePref('stories', true), false);
    const B2 = fresh('popup/bridge.js');
    await B2.loadModulePrefs();
    assert.strictEqual(B2.modulePref('stories', true), false, 'survives a reopen');
    B.addSetting({ id: 'x', label: 'X', get: () => true, set: () => {} });
    B.addSetting({ id: 'x', label: 'X again', get: () => true, set: () => {} });
    B.addSetting({ id: 'bad' });
    assert.deepStrictEqual(B.settingRows.map(r => r.label), ['X'], 'rows dedupe by id and need get/set');
    console.log('[PASS] Module prefs and settings rows');
  }

  // Card registration.
  {
    const render = () => {};
    assert.strictEqual(B.registerCard('top10', {
      name: 'Top 10', description: 'Best days.', defaultSize: 'expanded', defaults: { metricId: 'active' },
      normalize(input, out) { if (input.rankBy === 'companies') out.rankBy = 'companies'; }
    }, render), true);
    assert.strictEqual(B.renderer('top10'), render);
    assert.strictEqual(B.registerCard('goal', { name: 'Hijack', description: 'x' }), false, 'built-ins cannot be replaced');
    assert.strictEqual(B.registerCard('Bad Type', { name: 'x', description: 'x' }), false, 'type ids are checked');
    assert.strictEqual(B.registerCard('top10', { name: 'Again', description: 'x' }), false, 'no double registration');
    assert.deepStrictEqual(W.normalizeOptions('top10', { rankBy: 'companies', junk: 1, title: 'Mine' }),
      { metricId: 'active', rankBy: 'companies', title: 'Mine', size: 'expanded', collapsed: false });
    assert.deepStrictEqual(W.normalizeOptions('top10', { rankBy: 'nope' }), { metricId: 'active', size: 'expanded', collapsed: false });
    const avail = W.availableTypes([]);
    assert.ok(avail.find(t => t.type === 'top10' && t.isNew), 'module cards appear in the picker, flagged New');
    let items = await W.load();
    items = await W.add('top10', { rankBy: 'companies' });
    assert.strictEqual(items[items.length - 1].options.rankBy, 'companies');
    console.log('[PASS] Module card types register, normalize, and persist');
  }

  delete global.WidgetLayout;
  uninstallMockChrome();
  console.log('--- test/bridge.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => { console.error('Test failed:', err); process.exit(1); });
}

module.exports = { run };
