// Auto-apply orchestrator (background/batch-runner.js): start validation, the
// concurrency cap, the batch window, HELLO and frame claims, the transition
// table, timeouts on an injected clock, user-closed tabs, stop/clear/focus,
// the done record, and surviving a worker restart. v2: 90 s / 6 min timeouts,
// LIT_BATCH_CAPS (never leaks the key), LIT_OPEN_OPTIONS, and the
// composed counts from driver updates.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

const RUNNER = path.resolve(__dirname, '..', 'background', 'batch-runner.js');

function bus() {
  let listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { listeners = listeners.filter(l => l !== fn); },
    emit(...args) { return listeners.map(fn => fn(...args)); },
    reset() { listeners = []; },
    count() { return listeners.length; }
  };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle(n = 30) {
  for (let i = 0; i < n; i++) await tick();
}

// Tabs and windows with just enough behavior: a tab can only be created in a
// window that exists, removing a tab fires onRemoved, and a window can vanish.
function extendChrome(mock) {
  const alarms = new Map();
  mock.alarms = {
    store: alarms,
    create: async (name, info) => { alarms.set(name, info); },
    clear: async name => alarms.delete(name),
    get: async name => alarms.get(name),
    onAlarm: bus()
  };
  let nextTab = 500;
  let nextWin = 50;
  const tabs = new Map();
  const windows = new Map();
  mock.tabs = {
    store: tabs,
    createdCalls: [],
    updatedCalls: [],
    removedCalls: [],
    onRemoved: bus(),
    async create(opts) {
      this.createdCalls.push(opts);
      if (!windows.has(opts.windowId)) throw new Error('No window with id: ' + opts.windowId + '.');
      const tab = { id: nextTab++, windowId: opts.windowId, url: opts.url, active: !!opts.active };
      tabs.set(tab.id, tab);
      return Object.assign({}, tab);
    },
    async update(id, opts) {
      this.updatedCalls.push({ id, opts });
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id + '.');
      Object.assign(tabs.get(id), opts);
      return Object.assign({}, tabs.get(id));
    },
    async get(id) {
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id + '.');
      return Object.assign({}, tabs.get(id));
    },
    movedCalls: [],
    async move(id, opts) {
      this.movedCalls.push({ id, opts });
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id + '.');
      if (!windows.has(opts.windowId)) throw new Error('No window with id: ' + opts.windowId + '.');
      mock.windows.take(id, opts.windowId);
      return Object.assign({}, tabs.get(id));
    },
    async remove(id) {
      this.removedCalls.push(id);
      if (!tabs.has(id)) throw new Error('No tab with id: ' + id + '.');
      const tab = tabs.get(id);
      tabs.delete(id);
      mock.tabs.onRemoved.emit(id, { windowId: tab.windowId, isWindowClosing: false });
    },
    async query({ windowId }) {
      return Array.from(tabs.values()).filter(t => windowId === undefined || t.windowId === windowId);
    }
  };
  mock.windows = {
    store: windows,
    createdCalls: [],
    updatedCalls: [],
    async create(opts) {
      this.createdCalls.push(opts);
      const win = { id: nextWin++, focused: !!opts.focused };
      windows.set(win.id, win);
      if (typeof opts.tabId === 'number') {
        this.take(opts.tabId, win.id);
        return { id: win.id, focused: win.focused, tabs: [Object.assign({}, tabs.get(opts.tabId))] };
      }
      const tab = { id: nextTab++, windowId: win.id, url: opts.url, active: true };
      tabs.set(tab.id, tab);
      return { id: win.id, focused: win.focused, tabs: [Object.assign({}, tab)] };
    },
    async update(id, opts) {
      this.updatedCalls.push({ id, opts });
      if (!windows.has(id)) throw new Error('No window with id: ' + id + '.');
      return Object.assign(windows.get(id), opts);
    },
    removedCalls: [],
    async remove(id) {
      this.removedCalls.push(id);
      if (!windows.has(id)) throw new Error('No window with id: ' + id + '.');
      this.close(id);
    },
    // A tab changes windows; like Chrome, a window closes with its last tab
    // and onRemoved does not fire for a moved tab.
    take(tabId, windowId) {
      const from = tabs.get(tabId).windowId;
      tabs.get(tabId).windowId = windowId;
      if (!Array.from(tabs.values()).some(t => t.windowId === from)) windows.delete(from);
    },
    // Test helper: the user closes the whole window.
    close(id) {
      windows.delete(id);
      Array.from(tabs.values()).filter(t => t.windowId === id).forEach(t => {
        tabs.delete(t.id);
        mock.tabs.onRemoved.emit(t.id, { windowId: id, isWindowClosing: true });
      });
    }
  };
  return mock;
}

function setup(initialStore) {
  const mock = extendChrome(installMockChrome(initialStore || {}));
  const env = { mock, now: 1000000, timers: [], injected: [] };
  env.boot = () => {
    // A fresh worker: new module instance, new listeners.
    mock.tabs.onRemoved.reset();
    mock.alarms.onAlarm.reset();
    delete require.cache[require.resolve(RUNNER)];
    env.LB = require(RUNNER);
    return env.LB.install({
      now: () => env.now,
      setTimeout: (fn, ms) => { env.timers.push({ fn, ms }); },
      injectAutofill: async tabId => { env.injected.push(tabId); }
    });
  };
  env.send = (msg, sender) => new Promise(resolve => {
    const handled = env.LB.handleMessage(msg, sender || {}, resolve);
    if (!handled) resolve('unhandled');
  });
  env.fromTab = (tabId, frameId = 0) => ({ id: mock.runtime.id, tab: { id: tabId }, frameId });
  env.batch = () => mock.storage.local.store.lit_batch;
  env.job = id => env.batch().jobs.find(j => j.jobId === id);
  env.advance = async ms => { env.now += ms; await env.LB._tick(env.now); };
  env.settle = async () => { await settle(); await env.LB._whenIdle(); await settle(); };
  return env;
}

function jobs(n, extra) {
  return Array.from({ length: n }, (_, i) => Object.assign({
    jobId: 'job' + (i + 1),
    title: 'Engineer ' + (i + 1),
    company: 'Co ' + (i + 1),
    url: 'https://job-boards.greenhouse.io/embed/job_app?for=co&token=' + (i + 1)
  }, extra));
}

async function run() {
  console.log('--- Running test/batch-runner.test.js ---');

  // 1. Start: validation, dedupe, clamping, and refusal while running.
  {
    const env = setup();
    await env.boot();
    assert.strictEqual(env.LB.handleMessage({ type: 'PT_AUTOFILL_TAB' }, {}, () => {}), false, 'other messages are not claimed');
    assert.strictEqual(env.LB.handleMessage(null, {}, () => {}), false);
    assert.deepStrictEqual((await env.send({ type: 'LIT_BATCH_START', jobs: [] })).ok, false, 'nothing to apply to');
    const res = await env.send({
      type: 'LIT_BATCH_START',
      concurrency: 50,
      mode: 'fill-only',
      jobs: [
        { jobId: 'a', title: 'A', company: 'X', url: 'https://jobs.ashbyhq.com/x/1/application' },
        { jobId: 'a', title: 'A again', company: 'X', url: 'https://jobs.ashbyhq.com/x/1/application' },
        { jobId: 'b', title: 'B', company: 'Y', url: 'javascript:alert(1)' },
        { jobId: 'c', title: 'C', company: 'Z', url: 'ftp://example.com/job' },
        { jobId: 'd', title: 'D', company: 'W', url: '' },
        { jobId: 'e', title: 'E', company: 'V', url: 'http://careers.example.com/e' }
      ]
    });
    assert.deepStrictEqual(res, { ok: true });
    await env.settle();
    const b = env.batch();
    assert.deepStrictEqual(b.jobs.map(j => j.jobId), ['a', 'e'], 'non-http dropped, duplicates removed');
    assert.strictEqual(b.concurrency, 10, 'clamped to 10');
    assert.strictEqual(b.mode, 'fill-only');
    assert.strictEqual(b.status, 'running');
    assert.strictEqual(env.job('a').host, 'jobs.ashbyhq.com');
    const again = await env.send({ type: 'LIT_BATCH_START', jobs: jobs(1) });
    assert.strictEqual(again.ok, false, 'refused while running');
    assert.ok(again.error);
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_CLEAR' })).ok, false, 'clear is refused while running');
    uninstallMockChrome();

    const env2 = setup();
    await env2.boot();
    await env2.send({ type: 'LIT_BATCH_START', concurrency: -3, jobs: jobs(3) });
    await env2.settle();
    assert.strictEqual(env2.batch().concurrency, 1, 'clamped to 1');
    assert.strictEqual(env2.batch().mode, 'submit', 'submit is the default mode');
    uninstallMockChrome();
    console.log('[PASS] Start validates, dedupes, clamps, and refuses while a batch runs');
  }

  // 2-9. One batch carried through its whole life.
  {
    const env = setup();
    const { mock } = env;
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 3, mode: 'submit', jobs: jobs(8) });
    await env.settle();
    let b = env.batch();
    assert.deepStrictEqual(b.jobs.map(j => j.status), ['opening', 'opening', 'opening', 'queued', 'queued', 'queued', 'queued', 'queued'], 'at most 3 in flight');
    assert.strictEqual(mock.windows.createdCalls.length, 1, 'one batch window');
    assert.strictEqual(mock.windows.createdCalls[0].focused, false, 'the window does not steal focus');
    assert.strictEqual(mock.windows.createdCalls[0].url, jobs(1)[0].url);
    assert.strictEqual(mock.tabs.createdCalls.length, 2);
    mock.tabs.createdCalls.forEach(c => {
      assert.strictEqual(c.windowId, b.windowId, 'later tabs reuse the batch window');
      assert.strictEqual(c.active, false);
    });
    assert.ok(b.jobs.slice(0, 3).every(j => typeof j.tabId === 'number' && j.startedAt === env.now));
    assert.ok(mock.alarms.store.has('lit-batch-tick'), 'the tick alarm runs with the batch');
    assert.strictEqual(mock.alarms.store.get('lit-batch-tick').periodInMinutes, 0.5);

    // HELLO is answered by tab; any other tab gets null.
    const t1 = env.job('job1').tabId;
    const t2 = env.job('job2').tabId;
    const t3 = env.job('job3').tabId;
    const hello = await env.send({ type: 'LIT_BATCH_HELLO' }, env.fromTab(t1, 4));
    assert.deepStrictEqual(hello, { job: { jobId: 'job1', title: 'Engineer 1', company: 'Co 1', url: jobs(1)[0].url, status: 'opening' }, mode: 'submit' });
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_HELLO' }, env.fromTab(99999)), { job: null });
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_HELLO' }, {}), { job: null });

    // Illegal transitions are refused.
    for (const status of ['submitting', 'submitted', 'ready', 'needs-you', 'queued', 'opening', 'bogus']) {
      assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status }, env.fromTab(t1, 4)), { ok: false }, 'opening -> ' + status + ' is refused');
    }
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(99999)), { ok: false }, 'a tab outside the batch is refused');

    // Frame claim: the first filling frame owns the job.
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1, 4)), { ok: true });
    assert.strictEqual(env.job('job1').frameId, 4);
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1, 0)), { ok: false }, 'a second frame cannot claim');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, env.fromTab(t1, 0)), { ok: false }, 'nor report for the owner');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1, 4)), { ok: false }, 'filling -> filling is refused');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting', filled: 9 }, env.fromTab(t1, 4)), { ok: true });
    assert.strictEqual(env.job('job1').status, 'submitting');
    assert.strictEqual(env.job('job1').filled, 9);

    // Submitted: recorded, tab closed after 1.5 s, next job launched.
    env.now += 5000;
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitted' }, env.fromTab(t1, 4)), { ok: true });
    await env.settle();
    assert.strictEqual(env.job('job1').status, 'submitted');
    assert.strictEqual(env.job('job1').reason, 'Submitted');
    assert.strictEqual(mock.storage.local.store.lit_batch_done.job1, env.now);
    assert.strictEqual(env.job('job4').status, 'opening', 'a freed slot launches the next job');
    assert.ok(mock.tabs.store.has(t1), 'the tab stays briefly so the confirmation is visible');
    assert.ok(env.timers.some(t => t.ms >= 1500 && t.ms < 2000), 'a close wake-up is scheduled');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'failed' }, env.fromTab(t1, 4)), { ok: false }, 'a terminal job takes no more updates');
    await env.advance(1500);
    assert.ok(!mock.tabs.store.has(t1), 'the submitted tab is closed');
    assert.strictEqual(env.job('job1').tabId, null);
    assert.strictEqual(env.job('job1').status, 'submitted', 'closing our own tab does not mark it skipped');

    // needs-you: tab left open, missing labels capped.
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t2, 0));
    const missing = Array.from({ length: 14 }, (_, i) => 'Question ' + i + ' ' + 'x'.repeat(100));
    const r2 = await env.send({ type: 'LIT_BATCH_UPDATE', status: 'needs-you', reason: '14 required fields need you', missing, filled: 6 }, env.fromTab(t2, 0));
    assert.deepStrictEqual(r2, { ok: true });
    await env.settle();
    const j2 = env.job('job2');
    assert.strictEqual(j2.status, 'needs-you');
    assert.strictEqual(j2.reason, '14 required fields need you');
    assert.strictEqual(j2.missing.length, 10);
    assert.ok(j2.missing.every(m => m.length <= 80));
    assert.ok(mock.tabs.store.has(t2), 'a needs-you tab is left open');
    assert.strictEqual(j2.tabId, t2);
    assert.strictEqual(env.job('job5').status, 'opening');

    // Open shows a needs-you tab on its own, outside the batch window (beside
    // the Jobright tab when there is one; see the last block).
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job2' }), { ok: true });
    assert.deepStrictEqual(mock.tabs.updatedCalls.pop(), { id: t2, opts: { active: true } });
    assert.deepStrictEqual(mock.windows.updatedCalls.pop(), { id: mock.tabs.store.get(t2).windowId, opts: { focused: true } });
    assert.deepStrictEqual(Array.from(mock.tabs.store.values()).filter(t => t.windowId === mock.tabs.store.get(t2).windowId).map(t => t.id), [t2], 'only that page');
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job1' })).ok, false, 'a closed tab cannot be focused');
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'nope' })).ok, false);

    // Timeouts on the injected clock. job3 never says hello.
    env.injected.length = 0;
    const launched3 = env.job('job3').startedAt;
    env.now = launched3 + 19000;
    await env.LB._tick(env.now);
    assert.deepStrictEqual(env.injected, [], 'no injection before 20 s');
    env.now = launched3 + 20000;
    await env.LB._tick(env.now);
    await settle();
    assert.ok(env.injected.includes(t3), 'injection is tried 20 s after launch without a hello');
    assert.ok(!env.injected.includes(env.job('job4').tabId), 'not for jobs launched later');
    await env.LB._tick(env.now + 1000);
    await settle();
    assert.strictEqual(env.injected.filter(id => id === t3).length, 1, 'injection is tried once');
    env.now = launched3 + 89000;
    await env.LB._tick(env.now);
    await env.settle();
    assert.strictEqual(env.job('job3').status, 'opening', 'still opening at 89 s: apply-button hops take time');
    env.now = launched3 + 90000;
    await env.LB._tick(env.now);
    await env.settle();
    assert.strictEqual(env.job('job3').status, 'needs-you');
    assert.strictEqual(env.job('job3').reason, 'No application form found');
    assert.ok(mock.tabs.store.has(t3), 'a timed-out tab is left open');
    assert.strictEqual(env.job('job6').status, 'opening');

    // A job that said hello is not injected.
    const t4 = env.job('job4').tabId;
    await env.send({ type: 'LIT_BATCH_HELLO' }, env.fromTab(t4));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t4));
    const before = env.injected.length;
    // Hard timeout: still filling 6 min after launch (not at 4).
    env.now = env.job('job4').startedAt + 4 * 60 * 1000;
    await env.LB._tick(env.now);
    await env.settle();
    assert.strictEqual(env.job('job4').status, 'filling', 'answer writing may run past 4 min');
    // The jobs launched into the freed slots start filling, so they are still
    // in flight two minutes later.
    for (const j of env.batch().jobs.filter(x => x.status === 'opening')) {
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(j.tabId));
    }
    env.now = env.job('job4').startedAt + 6 * 60 * 1000;
    await env.LB._tick(env.now);
    await env.settle();
    assert.strictEqual(env.job('job4').status, 'needs-you');
    assert.strictEqual(env.job('job4').reason, 'Timed out');
    assert.ok(!env.injected.slice(before).includes(t4), 'a job with a driver is not injected');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitted' }, env.fromTab(t4)), { ok: false }, 'a late report after the timeout is refused');

    // Whatever else was opening by then has timed out too; slots refill.
    b = env.batch();
    const inflight = b.jobs.filter(j => ['opening', 'filling', 'submitting'].includes(j.status));
    assert.ok(inflight.length <= 3);

    // The user closes a job's tab: skipped, next one launched.
    const open = inflight[0];
    const queuedBefore = b.jobs.filter(j => j.status === 'queued').length;
    await mock.tabs.remove(open.tabId);
    await env.settle();
    assert.strictEqual(env.job(open.jobId).status, 'skipped');
    assert.strictEqual(env.job(open.jobId).reason, 'Tab closed');
    assert.strictEqual(env.batch().jobs.filter(j => j.status === 'queued').length, Math.max(0, queuedBefore - 1));

    uninstallMockChrome();
    console.log('[PASS] Batch life: cap, window reuse, hello, frame claim, transitions, submit/close, needs-you, timeouts, injection, closed tabs, focus');
  }

  // 10. Window gone between launches, without any tab events.
  {
    const env = setup();
    const { mock } = env;
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 1, jobs: jobs(2) });
    await env.settle();
    const w1 = env.batch().windowId;
    mock.windows.store.delete(w1);
    const t1 = env.job('job1').tabId;
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'failed', reason: 'Unexpected error' }, env.fromTab(t1));
    await env.settle();
    assert.strictEqual(env.job('job1').status, 'failed');
    assert.strictEqual(env.job('job2').status, 'opening', 'the next job still opens');
    assert.notStrictEqual(env.batch().windowId, w1, 'in a new window');
    assert.strictEqual(mock.windows.createdCalls.length, 2);
    uninstallMockChrome();

    // The user closes the whole batch window: its in-flight tabs are skipped
    // and the next job opens a new unfocused window instead of failing.
    const env2 = setup();
    await env2.boot();
    await env2.send({ type: 'LIT_BATCH_START', concurrency: 2, jobs: jobs(4) });
    await env2.settle();
    const w2 = env2.batch().windowId;
    env2.mock.windows.close(w2);
    await env2.settle();
    const b2 = env2.batch();
    assert.deepStrictEqual(b2.jobs.map(j => j.status), ['skipped', 'skipped', 'opening', 'opening']);
    assert.ok(b2.jobs.slice(0, 2).every(j => j.reason === 'Tab closed'));
    assert.notStrictEqual(b2.windowId, w2, 'a new batch window replaces the closed one');
    assert.strictEqual(env2.mock.windows.createdCalls.length, 2);
    assert.strictEqual(env2.mock.windows.createdCalls[1].focused, false);
    assert.ok(b2.jobs.slice(2).every(j => env2.mock.tabs.store.get(j.tabId).windowId === b2.windowId), 'both new tabs share the new window');
    uninstallMockChrome();
    console.log('[PASS] A vanished or closed batch window is replaced');
  }

  // 11. Stop: nothing new opens and nothing more is submitted. Queued jobs
  //     are skipped, tabs still looking for a form close, a form being
  //     filled stays open for the user, a job already submitting reports its
  //     result. Then clear, and the alarm lifetime.
  {
    const env = setup();
    const { mock } = env;
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 3, jobs: jobs(6) });
    await env.settle();
    const t1 = env.job('job1').tabId;
    const t2 = env.job('job2').tabId;
    const t3 = env.job('job3').tabId;
    const win = env.batch().windowId;
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t2));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, env.fromTab(t2));
    await env.settle();
    assert.deepStrictEqual(env.batch().jobs.map(j => j.status), ['filling', 'submitting', 'opening', 'queued', 'queued', 'queued']);

    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_STOP' }), { ok: true });
    await env.settle();
    let b = env.batch();
    assert.strictEqual(b.status, 'stopped');
    assert.deepStrictEqual(b.jobs.map(j => j.status), ['needs-you', 'submitting', 'skipped', 'skipped', 'skipped', 'skipped']);
    assert.strictEqual(env.job('job1').reason, 'Stopped before submitting');
    assert.ok(b.jobs.slice(2).every(j => j.reason === 'Stopped'));
    assert.ok(mock.tabs.store.has(t1), 'a half-filled form stays open for the user');
    assert.ok(!mock.tabs.store.has(t3), 'a tab that never found its form is closed');
    assert.strictEqual(env.job('job3').tabId, null);
    assert.ok(mock.alarms.store.has('lit-batch-tick'), 'the alarm stays while a job is submitting');

    // The filling driver asks to submit: refused, so it stands down.
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, env.fromTab(t1)), { ok: false }, 'no submit after Stop');
    // The job that already pressed Submit still reports.
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitted' }, env.fromTab(t2)), { ok: true }, 'in-flight submits still report');
    await env.settle();
    assert.strictEqual(env.job('job2').status, 'submitted');
    assert.ok(!mock.alarms.store.has('lit-batch-tick'), 'the alarm goes when nothing is in flight');
    assert.ok(!env.batch().jobs.some(j => j.status === 'queued' || j.status === 'opening'), 'nothing new launched after stop');
    // The submitted tab closes; the window stays for the tab that needs you.
    await env.advance(env.LB.CLOSE_DELAY_MS);
    await env.settle();
    assert.ok(!mock.tabs.store.has(t2));
    assert.strictEqual(env.batch().windowId, win, 'the window stays while a tab needs you');
    assert.ok(mock.windows.store.has(win));
    // Once the user closes that tab, the batch window goes too.
    await mock.tabs.remove(t1);
    await env.settle();
    assert.strictEqual(env.job('job1').status, 'needs-you', 'a finished job keeps its result');
    assert.strictEqual(env.job('job1').tabId, null, 'but forgets its closed tab');
    assert.strictEqual(env.batch().windowId, null);
    assert.deepStrictEqual(mock.windows.removedCalls, [win], 'the empty batch window is closed');

    assert.strictEqual(env.batch().status, 'stopped');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_CLEAR' }), { ok: true });
    await env.settle();
    assert.strictEqual(env.batch(), undefined, 'clear removes the batch');
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_STOP' })).ok, false, 'nothing to stop');
    // A new batch may start after the old one ended, in a new window.
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_START', jobs: jobs(1) }), { ok: true });
    await env.settle();
    assert.strictEqual(mock.windows.createdCalls.length, 2);
    uninstallMockChrome();
    console.log('[PASS] Stop skips the queue, closes tabs with no form, keeps filled forms for you, refuses later submits; window closes when empty');
  }

  // 11a. Stop right after Start: every tab was still opening, so every tab
  //      and the batch window close.
  {
    const env = setup();
    const { mock } = env;
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 2, jobs: jobs(4) });
    await env.settle();
    const win = env.batch().windowId;
    await env.send({ type: 'LIT_BATCH_STOP' });
    await env.settle();
    assert.deepStrictEqual(env.batch().jobs.map(j => j.status), ['skipped', 'skipped', 'skipped', 'skipped']);
    assert.strictEqual(Array.from(mock.tabs.store.values()).filter(t => t.windowId === win).length, 0, 'no tabs left behind');
    assert.ok(!mock.windows.store.has(win), 'the batch window is gone');
    assert.strictEqual(env.batch().windowId, null);
    assert.ok(!mock.alarms.store.has('lit-batch-tick'));
    uninstallMockChrome();
    console.log('[PASS] Stop during opening closes every tab and the batch window');
  }

  // 11b. Remove: a queued job is skipped and never opens; a started one stays.
  {
    const env = setup();
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 2, jobs: jobs(4) });
    await env.settle();
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_REMOVE', jobId: 'job3' }), { ok: true });
    await env.settle();
    assert.strictEqual(env.job('job3').status, 'skipped');
    assert.strictEqual(env.job('job3').reason, 'Removed');
    assert.strictEqual(env.job('job3').tabId, null, 'a removed job never gets a tab');
    assert.strictEqual(env.job('job4').status, 'queued');
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_REMOVE', jobId: 'job1' })).ok, false, 'a started job is left alone');
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_REMOVE', jobId: 'nope' })).ok, false, 'unknown job');
    // The last queued job removed and the rest finishing ends the batch.
    await env.send({ type: 'LIT_BATCH_REMOVE', jobId: 'job4' });
    for (const id of ['job1', 'job2']) {
      const t = env.job(id).tabId;
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t));
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'ready' }, env.fromTab(t));
    }
    await env.settle();
    assert.strictEqual(env.batch().status, 'done');
    uninstallMockChrome();
    console.log('[PASS] Remove skips a queued job; started jobs stay');
  }

  // 12. Done: the batch finishes and the alarm is cleared; lit_batch_done is
  // capped at the 2000 newest.
  {
    const seeded = {};
    for (let i = 0; i < 2000; i++) seeded['old' + i] = 1000 + i;
    const env = setup({ lit_batch_done: seeded });
    const { mock } = env;
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 5, jobs: jobs(2) });
    await env.settle();
    for (const id of ['job1', 'job2']) {
      const tabId = env.job(id).tabId;
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(tabId));
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, env.fromTab(tabId));
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitted' }, env.fromTab(tabId));
    }
    await env.settle();
    assert.strictEqual(env.batch().status, 'done');
    assert.ok(!mock.alarms.store.has('lit-batch-tick'), 'the alarm is cleared when the batch is done');
    const done = mock.storage.local.store.lit_batch_done;
    assert.strictEqual(Object.keys(done).length, 2000, 'capped at 2000');
    assert.ok(done.job1 && done.job2, 'the newest are kept');
    assert.ok(!('old0' in done) && !('old1' in done), 'the oldest are dropped');
    uninstallMockChrome();
    console.log('[PASS] A finished batch is done, its alarm cleared, and lit_batch_done keeps the 2000 newest');
  }

  // 13. Concurrent messages are serialized: neither write is lost.
  {
    const env = setup();
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 3, jobs: jobs(3) });
    await env.settle();
    const ids = ['job1', 'job2', 'job3'].map(id => env.job(id).tabId);
    const answers = await Promise.all(ids.map(tabId => env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(tabId))));
    assert.ok(answers.every(a => a.ok));
    assert.ok(env.batch().jobs.every(j => j.status === 'filling'), 'every update landed');
    uninstallMockChrome();
    console.log('[PASS] Simultaneous updates are serialized');
  }

  // 14. Alarm routing and a worker restart: state in storage still drives
  // the batch, the alarm is re-armed, and free slots are refilled.
  {
    const env = setup();
    const { mock } = env;
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 2, jobs: jobs(4) });
    await env.settle();
    const t1 = env.job('job1').tabId;
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1, 2));

    // Other alarms are ignored; the tick alarm sweeps.
    const snapshot = JSON.stringify(env.batch());
    mock.alarms.onAlarm.emit({ name: 'pt-maintenance' });
    await env.settle();
    assert.strictEqual(JSON.stringify(env.batch()), snapshot, 'other alarms do nothing');
    env.now += 90000;
    mock.alarms.onAlarm.emit({ name: 'lit-batch-tick' });
    await env.settle();
    assert.strictEqual(env.job('job2').status, 'needs-you', 'the tick alarm applies timeouts');
    assert.strictEqual(env.job('job1').status, 'filling', 'a filling job is not an opening timeout');

    // The worker dies: alarm lost, module state gone, and a slot is free.
    mock.alarms.store.clear();
    const s = env.batch();
    s.jobs.find(j => j.jobId === 'job3').status = 'queued';
    s.jobs.find(j => j.jobId === 'job3').tabId = null;
    mock.storage.local.store.lit_batch = s;
    await env.boot();
    await env.settle();
    assert.ok(mock.alarms.store.has('lit-batch-tick'), 'install re-arms the alarm for a running batch');
    assert.strictEqual(env.job('job3').status, 'opening', 'a free slot is refilled after restart');
    assert.strictEqual(mock.tabs.onRemoved.count(), 1, 'one listener per worker');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_HELLO' }, env.fromTab(t1, 2)), {
      job: { jobId: 'job1', title: 'Engineer 1', company: 'Co 1', url: jobs(1)[0].url, status: 'filling' }, mode: 'submit'
    }, 'hello still finds the job');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, env.fromTab(t1, 0)), { ok: false }, 'the frame claim survives');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, env.fromTab(t1, 2)), { ok: true });
    await mock.tabs.remove(env.job('job3').tabId);
    await env.settle();
    assert.strictEqual(env.job('job3').status, 'skipped', 'the new worker hears tab closes');
    assert.strictEqual(env.job('job4').status, 'opening');

    // A restart with no batch at all does nothing.
    mock.storage.local.store = {};
    mock.alarms.store.clear();
    await env.boot();
    await env.settle();
    assert.strictEqual(env.batch(), undefined);
    assert.ok(!mock.alarms.store.has('lit-batch-tick'));
    uninstallMockChrome();
    console.log('[PASS] Alarm routing, and a restarted worker resumes from storage');
  }

  // 15. v2: timeouts, capabilities, the options link, composed counts.
  {
    const env = setup({ af_settings: { showButton: true, aiEnabled: true, aiKey: 'sk-ant-secret-key', aiModel: 'claude-opus-5-5' } });
    const { mock } = env;
    let granted = false;
    const asked = [];
    mock.permissions = { contains: async q => { asked.push(q); return granted; } };
    let opened = 0;
    mock.runtime.openOptionsPage = async () => { opened++; };
    await env.boot();
    assert.strictEqual(env.LB.OPEN_TIMEOUT_MS, 90 * 1000);
    assert.strictEqual(env.LB.HARD_TIMEOUT_MS, 6 * 60 * 1000);

    let caps = await env.send({ type: 'LIT_BATCH_CAPS' });
    assert.deepStrictEqual(caps, { allSites: false, ai: true, profile: false });
    assert.deepStrictEqual(asked[0], { origins: ['*://*/*'] });
    assert.ok(!JSON.stringify(caps).includes('sk-ant'), 'the key never leaves the worker');
    granted = true;
    mock.storage.local.store.af_settings = { aiEnabled: true, aiKey: '   ' };
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_CAPS' }), { allSites: true, ai: false, profile: false }, 'a blank key is no key');
    mock.storage.local.store.af_settings = { aiEnabled: false, aiKey: 'sk-ant-x' };
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_CAPS' })).ai, false, 'switched off');
    delete mock.storage.local.store.af_settings;
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_CAPS' })).ai, false, 'no settings yet');
    // Callback-style permissions API (older Chrome).
    mock.permissions = { contains: (q, cb) => { cb(true); } };
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_CAPS' })).allSites, true);
    delete mock.permissions;
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_CAPS' })).allSites, false, 'no permissions API');

    assert.deepStrictEqual(await env.send({ type: 'LIT_OPEN_OPTIONS' }), { ok: true });
    assert.strictEqual(opened, 1);
    mock.runtime.openOptionsPage = async () => { throw new Error('nope'); };
    assert.strictEqual((await env.send({ type: 'LIT_OPEN_OPTIONS' })).ok, false);
    assert.strictEqual(env.LB.handleMessage({ type: 'LIT_COMPOSE_ANSWER' }, {}, () => {}), false, 'the answer writer is not ours');

    await env.send({ type: 'LIT_BATCH_START', concurrency: 2, jobs: jobs(2) });
    await env.settle();
    assert.strictEqual(env.job('job1').composed, 0);
    const t1 = env.job('job1').tabId;
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(t1));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting', filled: 14, composed: 3.7 }, env.fromTab(t1));
    assert.strictEqual(env.job('job1').filled, 14);
    assert.strictEqual(env.job('job1').composed, 3);
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitted', composed: 'lots' }, env.fromTab(t1));
    assert.strictEqual(env.job('job1').composed, 3, 'non-numbers ignored');
    uninstallMockChrome();
    console.log('[PASS] v2: 90 s / 6 min timeouts, LIT_BATCH_CAPS without the key, LIT_OPEN_OPTIONS, composed stored');
  }

  {
    // LIT_BATCH_APPLIED: which Jobright jobs the tracker already logged.
    installMockChrome({});
    delete require.cache[require.resolve(RUNNER)];
    const LB = require(RUNNER);
    const logs = [
      { company: 'Northwind Labs, Inc.', role: 'Software Engineer - Platform', url: '' },
      { company: 'Other Co', role: 'Whatever', url: 'https://jobs.lever.co/fabrikam/abc-123/?utm_source=x' },
      { company: 'Contoso', role: '', url: '' },
      null
    ];
    const jobs = [
      { jobId: 'a', company: 'Northwind Labs', title: 'Software Engineer, Platform', url: 'https://x.example/1' },
      { jobId: 'b', company: 'Fabrikam', title: 'Full Stack Engineer', url: 'https://jobs.lever.co/fabrikam/abc-123' },
      { jobId: 'c', company: 'Northwind Labs', title: 'Data Engineer', url: 'https://x.example/2' },
      { jobId: 'd', company: 'Contoso', title: 'Backend Engineer', url: '' }
    ];
    // The worker has TrackerStorage loaded; its normalizer is the one used.
    global.TrackerStorage = require(path.resolve(__dirname, '..', 'shared', 'storage.js'));
    assert.deepStrictEqual(LB.matchApplied(jobs, logs), ['a', 'b'],
      'same company + role, or same link; same company alone is not enough');
    delete global.TrackerStorage;
    LB.install({ getJobLogs: async () => logs, normalizeCompany: n => String(n || '').toLowerCase().replace(/\b(inc)\b/g, '').replace(/[^a-z0-9]+/g, '') });
    const ask = msg => new Promise(resolve => { LB.handleMessage(msg, {}, resolve); });
    assert.deepStrictEqual(await ask({ type: 'LIT_BATCH_APPLIED', jobs }), { ok: true, jobIds: ['a', 'b'] });
    assert.deepStrictEqual(await ask({ type: 'LIT_BATCH_APPLIED' }), { ok: true, jobIds: [] });
    LB.install({ getJobLogs: async () => { throw new Error('db gone'); } });
    assert.deepStrictEqual(await ask({ type: 'LIT_BATCH_APPLIED', jobs }), { ok: false, jobIds: [] }, 'failure is an empty answer');
    await settle();
    await LB._whenIdle();
    await settle();
    uninstallMockChrome();
    console.log('[PASS] LIT_BATCH_APPLIED matches logged applications by company + role or link');
  }

  {
    // Open on an unfinished job fills its form: an answering driver is asked,
    // a lost tab is reopened, a reloaded page is told to assist.
    const env = setup();
    const { mock } = env;
    mock.tabs.onReplaced = bus();
    mock.tabs.onUpdated = bus();
    const asked = [];
    let answers = true;
    mock.tabs.sendMessage = async (id, msg) => {
      asked.push({ id, msg });
      if (!answers) throw new Error('Could not establish connection. Receiving end does not exist.');
      return { ok: true };
    };
    const reloads = [];
    mock.tabs.reload = async id => { reloads.push(id); };
    const create = mock.tabs.create;
    mock.tabs.create = async opts => create.call(mock.tabs, Object.assign({ windowId: env.batch() && env.batch().windowId }, opts));
    const from = (id, url) => Object.assign(env.fromTab(id), { url });
    const GH = 'https://job-boards.greenhouse.io/embed/job_app?for=co&token=1';
    await env.boot();
    await env.send({ type: 'LIT_BATCH_START', concurrency: 2, jobs: jobs(2) });
    await env.settle();
    let t1 = env.job('job1').tabId;
    const t2 = env.job('job2').tabId;
    assert.ok(mock.tabs.updatedCalls.some(c => c.id === t1 && c.opts.autoDiscardable === false), 'batch tabs are kept in memory');
    await env.send({ type: 'LIT_BATCH_HELLO' }, from(t1, GH));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, from(t1, GH));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'needs-you', reason: 'x', filled: 2 }, from(t1, GH));

    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, from(t2, GH));

    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job1' }), { ok: true });
    assert.deepStrictEqual(asked.pop(), { id: t1, msg: { type: 'LIT_BATCH_ASSIST', jobId: 'job1', submit: true } });

    // A new page in that tab (reload, discard) is told to fill.
    mock.tabs.onReplaced.emit(9001, t1);
    await env.settle();
    t1 = 9001;
    assert.strictEqual(env.job('job1').tabId, 9001, 'a discarded tab keeps its job under the new id');
    let hi = await env.send({ type: 'LIT_BATCH_HELLO' }, from(t1, GH));
    assert.strictEqual(hi.mode, 'assist');
    assert.strictEqual(hi.hops, true, 'just opened');
    env.now += env.LB.ASSIST_MS + 1;
    hi = await env.send({ type: 'LIT_BATCH_HELLO' }, from(t1, GH));
    assert.deepStrictEqual([hi.mode, hi.hops, hi.submit], ['assist', false, false], 'a later reload fills but presses nothing');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_HELLO' }, from(t1, 'https://elsewhere.example.com/form')), { job: null }, 'a tab taken elsewhere is left alone');
    assert.strictEqual((await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, from(t1, GH))).ok, false, 'without a recent Open, an assisting page cannot submit');
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_ASSISTED', filled: 6, missing: [], ready: true, reason: 'Filled. Review and submit.' }, from(t1, GH)), { ok: true });
    assert.deepStrictEqual([env.job('job1').status, env.job('job1').filled], ['ready', 6]);

    // Nobody answers on a job board after the extension was updated: one reload.
    answers = false;
    mock.tabs.store.set(9001, { id: 9001, windowId: env.batch().windowId });
    env.job('job1').assistAt = null;
    env.LB.install({ now: () => env.now, setTimeout: () => {}, injectAutofill: async () => { throw new Error('no access'); } });
    await env.settle();
    env.batch().jobs[0].lastHelloAt = 0;
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job1' }), { ok: true });
    assert.deepStrictEqual(reloads, [9001]);
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job1' }), { ok: true, noAccess: true }, 'never reloads twice');
    assert.strictEqual(reloads.length, 1);

    // The user closed it: opened again.
    mock.tabs.store.delete(9001);
    mock.tabs.onRemoved.emit(9001, {});
    await env.settle();
    assert.strictEqual(env.job('job1').tabId, null);
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job1' }), { ok: true });
    assert.strictEqual(mock.tabs.createdCalls.slice(-1)[0].url, GH);
    assert.ok(typeof env.job('job1').tabId === 'number');

    // After Submit was pressed nothing refills the form.
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, from(t2, GH));
    await env.send({ type: 'LIT_BATCH_UPDATE', status: 'needs-you', reason: 'Submitted but no confirmation seen' }, from(t2, GH));
    assert.deepStrictEqual(await env.send({ type: 'LIT_BATCH_HELLO' }, from(t2, GH)), { job: null });
    await env.settle();
    uninstallMockChrome();
    console.log('[PASS] Open fills unfinished jobs: asks the driver, survives discards, reloads and closed tabs');
  }

  {
    // A company site LIT may not touch says so, without the 90 s wait.
    const env = setup();
    await env.boot();
    env.LB.install({ now: () => env.now, setTimeout: () => {}, injectAutofill: async () => { throw new Error('no access'); } });
    await env.send({ type: 'LIT_BATCH_START', concurrency: 1, jobs: jobs(1, { url: 'https://careers.example.com/apply' }) });
    await env.settle();
    await env.advance(21 * 1000);
    await env.settle();
    assert.strictEqual(env.job('job1').noAccess, true);
    await env.advance(10 * 1000);
    assert.deepStrictEqual([env.job('job1').status, env.job('job1').reason], ['needs-you', env.LB.NO_ACCESS]);
    await env.settle();
    uninstallMockChrome();
    console.log('[PASS] A site without access is reported as such');
  }

  // Open submits a complete form, once, when the batch was started to submit.
  {
    const open = async (mode, stopped) => {
      const env = setup();
      await env.boot();
      await env.send({ type: 'LIT_BATCH_START', concurrency: 1, mode, jobs: jobs(1) });
      await env.settle();
      const t = env.job('job1').tabId;
      const me = Object.assign(env.fromTab(t), { url: jobs(1)[0].url });
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, me);
      if (stopped) await env.send({ type: 'LIT_BATCH_STOP' });
      else await env.send({ type: 'LIT_BATCH_UPDATE', status: 'needs-you', reason: 'x' }, me);
      assert.strictEqual((await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, me)).ok, false, 'not before Open');
      env.now += 30 * 60 * 1000; // opened long after the batch ran
      await env.send({ type: 'LIT_BATCH_FOCUS', jobId: 'job1' });
      const hi = await env.send({ type: 'LIT_BATCH_HELLO' }, me);
      const sent = await env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, Object.assign({}, me, { frameId: 3 }));
      return { env, t, me, hi, sent };
    };

    let r = await open('submit');
    assert.strictEqual(r.hi.submit, true);
    assert.strictEqual(r.sent.ok, true);
    await r.env.advance(1000);
    assert.strictEqual(r.env.job('job1').status, 'submitting', 'the old start time does not time it out');
    assert.strictEqual((await r.env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitting' }, r.me)).ok, false, 'once');
    assert.strictEqual((await r.env.send({ type: 'LIT_BATCH_UPDATE', status: 'submitted' }, Object.assign({}, r.me, { frameId: 3 }))).ok, true);
    await r.env.advance(5000);
    assert.strictEqual(r.env.job('job1').status, 'submitted');
    assert.ok(r.env.mock.tabs.store.has(r.t), 'the opened tab stays on its confirmation');
    assert.ok(r.env.mock.storage.local.store.lit_batch_done.job1);
    uninstallMockChrome();

    r = await open('fill-only');
    assert.deepStrictEqual([r.hi.submit, r.sent.ok], [false, false], 'Submit automatically is off');
    uninstallMockChrome();
    r = await open('submit', true);
    assert.deepStrictEqual([r.hi.submit, r.sent.ok], [false, false], 'Stop stays stopped');
    uninstallMockChrome();
    console.log('[PASS] Open submits a complete form once; never in fill-only or after Stop');
  }

  // Open shows one page: that tab alone moves beside the Jobright tab.
  {
    const env = setup();
    const { mock } = env;
    await env.boot();
    mock.windows.store.set(7, { id: 7, focused: true });
    mock.tabs.store.set(70, { id: 70, windowId: 7, url: 'https://jobright.ai/jobs/recommend', active: true });
    const panel = { id: mock.runtime.id, tab: { id: 70, windowId: 7, index: 2 }, frameId: 0 };
    const inWindow = id => Array.from(mock.tabs.store.values()).filter(t => t.windowId === id).map(t => t.id);
    await env.send({ type: 'LIT_BATCH_START', concurrency: 4, jobs: jobs(4) });
    await env.settle();
    const batchWin = env.batch().windowId;
    const ids = env.batch().jobs.map(j => j.tabId);
    for (const id of ids) {
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'filling' }, env.fromTab(id));
      await env.send({ type: 'LIT_BATCH_UPDATE', status: 'needs-you', reason: 'x' }, env.fromTab(id));
    }
    const open = jobId => env.send({ type: 'LIT_BATCH_FOCUS', jobId }, panel);

    mock.windows.updatedCalls.length = 0;
    assert.strictEqual((await open('job2')).ok, true);
    assert.deepStrictEqual(mock.tabs.movedCalls, [{ id: ids[1], opts: { windowId: 7, index: 3 } }]);
    assert.deepStrictEqual(inWindow(7), [70, ids[1]].sort((a, b) => a - b), 'one company page joins the Jobright window');
    assert.deepStrictEqual(inWindow(batchWin), [ids[0], ids[2], ids[3]], 'the rest stay behind');
    assert.ok(mock.windows.updatedCalls.every(c => c.id === 7), 'the batch window is never brought forward');
    assert.strictEqual(mock.windows.createdCalls.length, 1, 'no extra window');
    assert.strictEqual(env.job('job2').tabId, ids[1], 'still the same tab');

    // Opening it again shows it where it is.
    assert.strictEqual((await open('job2')).ok, true);
    assert.strictEqual(mock.tabs.movedCalls.length, 1, 'not moved twice');

    // A closed one reopens beside Jobright, never in the batch window.
    await mock.tabs.remove(ids[2]);
    await env.settle();
    assert.strictEqual((await open('job3')).ok, true);
    assert.deepStrictEqual(mock.tabs.createdCalls.slice(-1)[0], { url: jobs(3)[2].url, active: true, windowId: 7, index: 3 });

    // Chrome refuses the move: a window of its own, not the batch window.
    mock.tabs.move = async () => { throw new Error('Tabs cannot be moved'); };
    assert.strictEqual((await open('job1')).ok, true);
    const own = mock.tabs.store.get(ids[0]).windowId;
    assert.ok(own !== batchWin && own !== 7);
    assert.deepStrictEqual(inWindow(own), [ids[0]]);
    assert.deepStrictEqual(inWindow(batchWin), [ids[3]]);
    uninstallMockChrome();
    console.log('[PASS] Open shows one company page, beside the Jobright tab');
  }

  console.log('--- test/batch-runner.test.js COMPLETED SUCCESSFULLY ---');
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
