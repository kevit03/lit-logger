// Real-time storage change events and cross-tab/dock synchronization tests
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

function getFreshModules(initialStore = {}) {
  const mock = installMockChrome(initialStore);
  delete require.cache[require.resolve('../shared/storage')];
  delete require.cache[require.resolve('../shared/auth')];
  const TrackerStorage = require('../shared/storage');
  const TrackerAuth = require('../shared/auth');
  return { mock, TrackerStorage, TrackerAuth };
}

async function run() {
  console.log('--- Running test/events.test.js ---');

  // 1. Storage Event Firing on Mutation Operations
  {
    const { TrackerStorage } = getFreshModules();

    const capturedChanges = [];
    TrackerStorage.onChanged(changes => {
      capturedChanges.push(changes);
    });

    // Mutation 1: Add log
    const log = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Event Test Corp' });
    await new Promise(r => setTimeout(r, 20));

    assert.ok(capturedChanges.length >= 1, 'Should capture at least 1 change event');
    const lastChange = capturedChanges[capturedChanges.length - 1];
    assert.ok(lastChange.logs, 'Change event should contain logs');
    assert.strictEqual(lastChange.logs.op, 'add');
    assert.deepStrictEqual(lastChange.logs.ids, [log.id], 'the event names the entry, not the whole history');
    assert.strictEqual(lastChange.logs.newValue, undefined, 'the history is never shipped with the event');

    // Mutation 2: Add metric
    const customMetric = await TrackerStorage.addMetric({ name: 'Event Custom', color: '#990099' });
    await new Promise(r => setTimeout(r, 20));

    const metricChange = capturedChanges[capturedChanges.length - 1];
    assert.ok(metricChange.metrics, 'Change event should contain metrics');

    // Mutation 3: Undo log
    await TrackerStorage.undoLastLog('jobs', log.date);
    await new Promise(r => setTimeout(r, 20));

    const undoChange = capturedChanges[capturedChanges.length - 1];
    assert.ok(undoChange.logs, 'Undo should emit logs change');
    assert.strictEqual(undoChange.logs.op, 'delete');
    assert.deepStrictEqual(undoChange.logs.ids, [log.id]);

    // Status changes and edits are events too.
    const job = await TrackerStorage.addLog({ metricId: 'jobs', company: 'Status Corp' });
    await TrackerStorage.setLogStatus(job.id, 'interviewing');
    await new Promise(r => setTimeout(r, 20));
    const statusChange = capturedChanges[capturedChanges.length - 1];
    assert.strictEqual(statusChange.logs.op, 'update');
    assert.deepStrictEqual(statusChange.logs.ids, [job.id]);

    console.log('[PASS] Storage event firing on mutations');
    uninstallMockChrome();
  }

  // 2. Multi-Listener Synchronization (Simulating Popup & Calendar Dock simultaneously)
  {
    const { TrackerStorage } = getFreshModules();

    let popupNotified = false;
    let calendarDockNotified = false;
    let dayModalNotified = false;

    // Simulate popup listener
    TrackerStorage.onChanged(changes => {
      if (changes.logs) popupNotified = true;
    });

    // Simulate calendar content script overlay dock listener
    TrackerStorage.onChanged(changes => {
      if (changes.logs) calendarDockNotified = true;
    });

    // Simulate day modal listener
    TrackerStorage.onChanged(changes => {
      if (changes.logs) dayModalNotified = true;
    });

    await TrackerStorage.addLog({ metricId: 'jobs', company: 'Multi-Listener Sync Test' });
    await new Promise(r => setTimeout(r, 25));

    assert.strictEqual(popupNotified, true, 'Popup listener must be notified');
    assert.strictEqual(calendarDockNotified, true, 'Calendar dock listener must be notified');
    assert.strictEqual(dayModalNotified, true, 'Day modal listener must be notified');

    console.log('[PASS] Multi-listener synchronization (popup, dock, modal)');
    uninstallMockChrome();
  }

  // 3. Sign-in and sign-out reach the single storage listener.
  //    The content script used to register three overlapping listeners
  //    (TrackerStorage.onChanged, TrackerAuth.onAuthChanged, and a raw
  //    chrome.storage.onChanged), so one log write re-rendered the whole
  //    overlay twice. Only the storage listener remains, and it must still
  //    cover auth transitions.
  {
    const { TrackerStorage, TrackerAuth } = getFreshModules();

    const authChanges = [];
    TrackerStorage.onChanged(changes => {
      if (changes.pt_auth_user) authChanges.push(changes.pt_auth_user);
    });

    await TrackerAuth.setUser({ email: 'Alice@Example.com', name: 'Alice' });
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(authChanges.length, 1, 'Sign-in must reach TrackerStorage.onChanged');
    assert.strictEqual(authChanges[0].newValue.email, 'alice@example.com');

    await TrackerAuth.signOut();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(authChanges.length, 2, 'Sign-out must reach TrackerStorage.onChanged');
    assert.strictEqual(authChanges[1].newValue, null);

    console.log('[PASS] Auth transitions reach the storage change listener');
    uninstallMockChrome();
  }

  // 4. Regression pin: the content script must not re-introduce a second raw
  //    chrome.storage.onChanged listener alongside TrackerStorage.onChanged.
  {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../content/content.js'), 'utf8');
    const rawListeners = (source.match(/chrome\.storage\.onChanged\.addListener/g) || []).length;
    assert.strictEqual(
      rawListeners,
      0,
      'content/content.js should subscribe through TrackerStorage.onChanged only, found ' +
      rawListeners + ' raw chrome.storage.onChanged listener(s)'
    );

    console.log('[PASS] Content script registers a single storage change listener');
  }

  console.log('--- test/events.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
