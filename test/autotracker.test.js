// Auto-tracker tests: adapter registry and URL matching, dedupe TTL cache,
// dispatch into TrackerStorage, Shadow DOM toast, per-adapter detection, and
// clean teardown of every observer and listener on unmount.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const dom = require('./mock_dom');

const ROOT = path.resolve(__dirname, '..');

function fresh(modulePath) {
  const full = path.join(ROOT, modulePath);
  delete require.cache[require.resolve(full)];
  return require(full);
}

// Adapter files are IIFEs that read the core off the global scope, exactly as
// they do in a content script; loading one registers it.
function loadAdapters(core, files) {
  global.AutoTrackerCore = core;
  files.forEach(f => {
    const full = path.join(ROOT, f);
    delete require.cache[require.resolve(full)];
    const exported = require(full);
    if (f.endsWith('ats/confirmation.js')) global.AutoTrackerATS = exported;
  });
}

const CODING_ADAPTERS = ['content/adapters/leetcode.js', 'content/adapters/neetcode.js'];
const ATS_ADAPTERS = [
  'content/adapters/ats/confirmation.js',
  'content/adapters/ats/greenhouse.js',
  'content/adapters/ats/lever.js',
  'content/adapters/ats/ashby.js',
  'content/adapters/ats/workday.js'
];

function makeCtx(doc, href) {
  return { url: new URL(href), document: doc, window: global.window, core: global.AutoTrackerCore };
}

function collect() {
  const calls = [];
  const fn = payload => calls.push(payload);
  fn.calls = calls;
  return fn;
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

// Lets chained storage promises (session reads, probes) finish.
async function settle(n = 12) {
  for (let i = 0; i < n; i++) await tick();
}

function loadJobMeta() {
  const full = path.join(ROOT, 'shared/job-meta.js');
  delete require.cache[require.resolve(full)];
  global.JobMeta = require(full);
  return global.JobMeta;
}

// Buttons inside a closed-shadow toast, found through the mock's handle.
function toastButtons(doc, core) {
  const host = doc.getElementById(core.TOAST_HOST_ID);
  return host ? host._shadow.querySelectorAll('button') : [];
}

function clickToastButton(doc, core, label) {
  const btn = toastButtons(doc, core).find(b => b.textContent === label);
  assert.ok(btn, 'toast button "' + label + '" is shown');
  btn.dispatchEvent(dom.makeEvent('click', btn));
}

function toastTexts(doc, core) {
  const host = doc.getElementById(core.TOAST_HOST_ID);
  return host ? host._shadow.querySelectorAll('.toast').map(t => t.querySelector('.body').textContent) : [];
}

// A job page the way the tests describe one: URL, title, meta tags, JSON-LD,
// and body children.
function jobPage(spec) {
  const doc = dom.installDom();
  doc.title = spec.title || '';
  (spec.meta || []).forEach(([prop, content]) => {
    doc.documentElement.appendChild(dom.el(doc, 'meta[property="' + prop + '"]', { attrs: { content } }));
  });
  if (spec.jsonLd) {
    doc.documentElement.appendChild(dom.el(doc, 'script[type="application/ld+json"]', { text: JSON.stringify(spec.jsonLd) }));
  }
  (spec.body || []).forEach(node => doc.body.appendChild(typeof node === 'function' ? node(doc) : node));
  return doc;
}

async function run() {
  console.log('--- Running test/autotracker.test.js ---');

  // -------------------------------------------------------------------------
  // 1. Registry
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    assert.throws(() => core.registerAdapter({ id: 'x' }), /metricId/);
    assert.throws(() => core.registerAdapter({ id: 'x', metricId: 'jobs', matches: () => true }), /init/);
    const a = { id: 'a', metricId: 'jobs', matches: u => u.hostname === 'a.test', init: () => () => {} };
    const b = { id: 'b', metricId: 'jobs', matches: () => { throw new Error('boom'); }, init: () => () => {} };
    const c = { id: 'c', metricId: 'jobs', matches: u => u.hostname === 'c.test', init: () => () => {} };
    core.registerAdapter(b);
    core.registerAdapter(a);
    core.registerAdapter(c);
    assert.strictEqual(core.getActiveAdapter('https://a.test/x').id, 'a');
    assert.strictEqual(core.getActiveAdapter('https://c.test/x').id, 'c', 'a throwing matcher must not mask later adapters');
    assert.strictEqual(core.getActiveAdapter('https://none.test/'), null);
    assert.strictEqual(core.getActiveAdapter('not a url'), null);
    core.registerAdapter({ id: 'a', metricId: 'leetcode', matches: () => false, init: () => () => {} });
    assert.strictEqual(core.getAdapters().filter(x => x.id === 'a').length, 1, 're-registering replaces by id');
    assert.strictEqual(core.routeKeyFor(a, 'https://a.test/p/q?z=1'), '/p/q', 'default route key is pathname');
    core.clearAdapters();
    assert.strictEqual(core.getAdapters().length, 0);
    uninstallMockChrome();
    console.log('[PASS] Adapter registry: validation, ordering, replacement, route keys');
  }

  // -------------------------------------------------------------------------
  // 2. Adapter URL matching
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    loadAdapters(core, CODING_ADAPTERS.concat(ATS_ADAPTERS));
    assert.strictEqual(core.getAdapters().length, 6, 'six adapters registered');

    const cases = [
      ['https://leetcode.com/problems/two-sum/', 'leetcode'],
      ['https://leetcode.com/problems/two-sum/submissions/123456/', 'leetcode'],
      ['https://leetcode.com/problems/two-sum/description/?envType=daily', 'leetcode'],
      ['https://leetcode.cn/problems/two-sum/', 'leetcode'],
      ['https://leetcode.com/problemset/all/', null],
      ['https://leetcode.com/contest/', null],
      ['https://neetcode.io/problems/duplicate-integer', 'neetcode'],
      ['https://neetcode.io/practice', 'neetcode'],
      ['https://neetcode.io/practice?tab=neetcode150', 'neetcode'],
      ['https://neetcode.io/roadmap', 'neetcode'],
      ['https://neetcode.io/courses/lessons/big-o', null],
      ['https://boards.greenhouse.io/anthropic/jobs/4012345', 'greenhouse'],
      ['https://job-boards.greenhouse.io/anthropic/jobs/4012345/confirmation', 'greenhouse'],
      ['https://boards.eu.greenhouse.io/acme/jobs/1', 'greenhouse'],
      ['https://boards.greenhouse.io/embed/job_app?for=acme&token=1', 'greenhouse'],
      ['https://www.greenhouse.io/', null],
      ['https://jobs.lever.co/acme/8f1a2b3c-1111-2222-3333-444455556666/thanks', 'lever'],
      ['https://jobs.eu.lever.co/acme/8f1a2b3c-1111-2222-3333-444455556666', 'lever'],
      ['https://lever.co/', null],
      ['https://jobs.ashbyhq.com/acme/8f1a2b3c-1111-2222-3333-444455556666/application', 'ashby'],
      ['https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_R123', 'workday'],
      ['https://acme.myworkdaysite.com/recruiting/acme/careers', 'workday'],
      ['https://myworkdayjobs.com.evil.test/x', null],
      ['https://calendar.google.com/', null]
    ];
    for (const [href, expected] of cases) {
      const found = core.getActiveAdapter(href);
      assert.strictEqual(found ? found.id : null, expected, `match for ${href}`);
    }

    const lc = core.getActiveAdapter('https://leetcode.com/problems/two-sum/');
    assert.strictEqual(
      core.routeKeyFor(lc, 'https://leetcode.com/problems/two-sum/'),
      core.routeKeyFor(lc, 'https://leetcode.com/problems/two-sum/submissions/987/'),
      'post-submit pushState to /submissions must not change the LeetCode route key'
    );
    assert.notStrictEqual(
      core.routeKeyFor(lc, 'https://leetcode.com/problems/two-sum/'),
      core.routeKeyFor(lc, 'https://leetcode.com/problems/add-two-numbers/')
    );
    const nc = core.getActiveAdapter('https://neetcode.io/practice');
    assert.strictEqual(core.routeKeyFor(nc, 'https://neetcode.io/practice?tab=a'), core.routeKeyFor(nc, 'https://neetcode.io/practice?tab=b'));

    core.clearAdapters();
    uninstallMockChrome();
    console.log('[PASS] Adapter URL matching: 24 URL cases across 6 adapters, route-key stability');
  }

  // -------------------------------------------------------------------------
  // 3. Dedupe cache
  // -------------------------------------------------------------------------
  {
    const chrome = installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    let now = new Date('2026-09-14T10:00:00').getTime();
    core._setClock(() => now);

    assert.strictEqual(core.buildDedupeKey('LeetCode', 'Two Sum', '2026-09-14'), 'leetcode:two-sum:2026-09-14');
    assert.strictEqual(core.buildDedupeKey('leetcode', 'two-sum'), 'leetcode:two-sum:2026-09-14', 'date defaults to local today');
    assert.match(core.buildDedupeKey('greenhouse', 'job-4012345'), /^greenhouse:job-4012345:\d{4}-\d{2}-\d{2}$/);

    const cache = core.createDedupeCache();
    assert.strictEqual(await cache.has('leetcode:two-sum:2026-09-14'), false);
    assert.strictEqual(await cache.mark('leetcode:two-sum:2026-09-14'), true);
    assert.strictEqual(await cache.mark('leetcode:two-sum:2026-09-14'), false, 'second mark of the same key is rejected');
    assert.strictEqual(await cache.has('leetcode:two-sum:2026-09-14'), true);
    assert.strictEqual(await cache.has('leetcode:two-sum:2026-09-15'), false, 'a new day is a new key');
    assert.strictEqual(cache.areaName(), 'session', 'session storage is the primary backing store');

    // Persisted: a brand new cache (a page reload) sees the key.
    const stored = chrome.storage.session.store[core.DEDUPE_STORAGE_KEY];
    assert.ok(stored && stored['leetcode:two-sum:2026-09-14'], 'key persisted to chrome.storage.session');
    const reloaded = core.createDedupeCache();
    assert.strictEqual(await reloaded.has('leetcode:two-sum:2026-09-14'), true, 'survives a page reload');
    assert.strictEqual(await reloaded.mark('leetcode:two-sum:2026-09-14'), false);

    // Sibling tab: a key written by another context after this cache loaded.
    chrome.storage.session.store[core.DEDUPE_STORAGE_KEY]['neetcode:three-sum:2026-09-14'] = now;
    assert.strictEqual(await cache.mark('neetcode:three-sum:2026-09-14'), false, 'mark re-reads storage before deciding');

    // TTL expiry.
    now += core.DEDUPE_TTL_MS + 1000;
    assert.strictEqual(await cache.has('leetcode:two-sum:2026-09-14'), false, 'expired after TTL');
    assert.strictEqual(await cache.mark('leetcode:two-sum:2026-09-14'), true);

    // Max entries: oldest evicted first.
    const small = core.createDedupeCache({ maxEntries: 3, storageKey: 'pt_test_small' });
    for (let i = 0; i < 5; i++) { now += 10; await small.mark('k:' + i + ':2026-09-14'); }
    assert.strictEqual(small.size(), 3);
    assert.deepStrictEqual(small.keys(), ['k:2:2026-09-14', 'k:3:2026-09-14', 'k:4:2026-09-14']);

    // Session area refused (service worker has not widened access): fall back to local.
    const denied = {
      name: 'denied-session',
      get(keys, cb) { chrome.runtime.lastError = { message: 'Access to storage is not allowed from this context.' }; cb({}); chrome.runtime.lastError = null; },
      set(items, cb) { chrome.runtime.lastError = { message: 'Access to storage is not allowed from this context.' }; cb(); chrome.runtime.lastError = null; }
    };
    const fallback = core.createDedupeCache({ area: denied, fallbackArea: chrome.storage.local, storageKey: 'pt_test_fb' });
    assert.strictEqual(await fallback.mark('x:y:2026-09-14'), true);
    assert.strictEqual(fallback.areaName(), 'local', 'fell back to chrome.storage.local');
    assert.ok(chrome.storage.local.store.pt_test_fb && chrome.storage.local.store.pt_test_fb['x:y:2026-09-14']);

    // No chrome at all: memory only, still dedupes within the page.
    const memory = core.createDedupeCache({ area: null, fallbackArea: null });
    assert.strictEqual(await memory.mark('m:1:2026-09-14'), true);
    assert.strictEqual(await memory.mark('m:1:2026-09-14'), false);
    assert.strictEqual(memory.areaName(), 'memory');

    core._setClock(null);
    uninstallMockChrome();
    console.log('[PASS] Dedupe cache: key format, reload persistence, cross-tab re-read, TTL, LRU cap, local fallback');
  }

  // -------------------------------------------------------------------------
  // 4. Dispatch into TrackerStorage and Shadow DOM toast
  // -------------------------------------------------------------------------
  {
    const chrome = installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    const storage = fresh('shared/storage.js');
    global.TrackerStorage = storage;
    const doc = dom.installDom();
    const adapter = { id: 'leetcode', label: 'LeetCode', metricId: 'leetcode', matches: () => true, init: () => () => {} };
    const payload = { id: 'two-sum', title: 'Two Sum', meta: { difficulty: 'Easy', language: 'Python3', runtime: '52 ms' } };

    const first = await core.dispatch(adapter, payload, { document: doc, storage });
    assert.strictEqual(first.logged, true);
    assert.strictEqual(first.key, 'leetcode:two-sum:' + core.localDateStr());
    assert.strictEqual(first.log.metricId, 'leetcode');
    assert.strictEqual(first.log.count, 1);
    assert.strictEqual(first.log.notes, 'Auto-logged from LeetCode | Two Sum | Easy, Python3, 52 ms');

    const second = await core.dispatch(adapter, payload, { document: doc, storage });
    assert.strictEqual(second.logged, false);
    assert.strictEqual(second.reason, 'duplicate');

    // Concurrent dispatches of one payload collapse to a single log.
    const burst = await Promise.all([1, 2, 3].map(() => core.dispatch(adapter, { id: 'three-sum', title: '3Sum' }, { document: doc, storage })));
    assert.deepStrictEqual(burst.map(r => r.logged), [true, false, false], 'dispatch is serialized through the dedupe check');

    const logs = await storage.getLogs({ metricId: 'leetcode' });
    assert.strictEqual(logs.length, 2, 'exactly two logs written (two-sum, three-sum)');

    // Jobs metadata flows through.
    const gh = { id: 'greenhouse', label: 'Greenhouse', metricId: 'jobs', matches: () => true, init: () => () => {} };
    const job = await core.dispatch(gh, { id: 'job-1', title: 'Engineer at Acme', company: 'Acme', role: 'Engineer' }, { document: doc, storage, toast: false });
    assert.strictEqual(job.log.metricId, 'jobs');
    assert.strictEqual(job.log.company, 'Acme');
    assert.strictEqual(job.log.role, 'Engineer');

    // Cross-platform scope: NeetCode ticks share the LeetCode namespace.
    const nc = { id: 'neetcode', label: 'NeetCode', metricId: 'leetcode', dedupeScope: 'leetcode', matches: () => true, init: () => () => {} };
    const dup = await core.dispatch(nc, { id: 'two-sum', title: 'Two Sum' }, { document: doc, storage, toast: false });
    assert.strictEqual(dup.logged, false, 'same problem ticked on NeetCode after LeetCode does not double count');

    // A throwing write releases the dedupe claim so the solve can be retried.
    const failing = { addLog: async () => { throw new Error('quota'); } };
    const failed = await core.dispatch(adapter, { id: 'retry-me', title: 'Retry Me' }, { document: doc, storage: failing, toast: false });
    assert.strictEqual(failed.reason, 'write-failed');
    const retried = await core.dispatch(adapter, { id: 'retry-me', title: 'Retry Me' }, { document: doc, storage, toast: false });
    assert.strictEqual(retried.logged, true, 'key released after a failed write');

    // Missing storage is a soft failure.
    const none = await core.dispatch(adapter, { id: 'z' }, { document: doc, storage: { addLog: undefined }, toast: false });
    assert.strictEqual(none.reason, 'no-storage');

    // Toast: rendered inside a shadow root, prefixed, no emoji, self-dismissing.
    const host = doc.getElementById(core.TOAST_HOST_ID);
    assert.ok(host, 'toast host element mounted on body');
    assert.strictEqual(host.shadowRoot, null, 'shadow root is closed');
    const shadow = host._shadow;
    assert.ok(shadow.querySelector('style'), 'styles are scoped inside the shadow root');
    const toasts = shadow.querySelectorAll('.toast');
    assert.strictEqual(toasts.length, 2, 'one toast per logged activity (jobs toast was suppressed)');
    assert.strictEqual(toasts[0].textContent, 'LIT:Logged Two Sum (+1)');
    assert.strictEqual(toasts[0].getAttribute('role'), 'status');
    const EMOJI = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u;
    assert.ok(!EMOJI.test(toasts[0].textContent), 'toast text is emoji-free');

    const quick = core.showToast('Logged Quick (+1)', { document: doc, durationMs: 5 });
    assert.strictEqual(shadow.querySelectorAll('.toast').length, 3);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(shadow.querySelectorAll('.toast').length, 2, 'toast removed itself after its duration');
    quick.dismiss();
    assert.strictEqual(shadow.querySelectorAll('.toast').length, 2, 'dismiss is idempotent');

    assert.ok(chrome.storage.session.store[core.DEDUPE_STORAGE_KEY], 'dispatch persisted its dedupe keys');
    delete global.TrackerStorage;
    uninstallMockChrome();
    console.log('[PASS] Dispatch: addLog wiring, duplicate rejection, burst serialization, closed-shadow toast');
  }

  // -------------------------------------------------------------------------
  // 5. LeetCode adapter
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    loadAdapters(core, ['content/adapters/leetcode.js']);
    const adapter = core.getActiveAdapter('https://leetcode.com/problems/two-sum/');
    let now = 1000000;
    core._setClock(() => now);
    const MO = dom.FakeMutationObserver;

    function scene() {
      const doc = dom.installDom();
      doc.title = '1. Two Sum - LeetCode';
      const title = dom.el(doc, 'a.no-underline[href="/problems/two-sum/"]', { text: '1. Two Sum' });
      doc.body.appendChild(dom.el(doc, 'div.text-title-large', { children: [title] }));
      doc.body.appendChild(dom.el(doc, 'div.text-difficulty-easy', { text: 'Easy' }));
      doc.body.appendChild(dom.el(doc, 'button.text-label-2.text-sm', { text: 'Python3' }));
      const submit = dom.el(doc, 'button[data-e2e-locator="console-submit-button"]', { text: 'Submit' });
      doc.body.appendChild(submit);
      const panel = dom.el(doc, 'div#result-panel');
      doc.body.appendChild(panel);
      return { doc, submit, panel };
    }

    // Accepted after submit: logged once, observer gone, teardown leaves nothing.
    {
      const { doc, submit, panel } = scene();
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://leetcode.com/problems/two-sum/'));
      assert.strictEqual(MO.activeCount(), 0, 'nothing is observed before a submit');
      assert.strictEqual(doc.body.listenerCount('click'), 1);
      assert.strictEqual(doc.body.listenerCount('keydown'), 1);

      submit.dispatchEvent(dom.makeEvent('click', submit));
      assert.strictEqual(MO.activeCount(), 1, 'submit arms exactly one observer');

      const verdict = dom.el(doc, 'span[data-e2e-locator="submission-result"]', { text: 'Accepted' });
      const stats = dom.el(doc, 'div.result-stats', { text: 'Runtime 52 ms Beats 90%' });
      const wrap = dom.el(doc, 'div', { children: [verdict, stats] });
      panel.appendChild(wrap);
      dom.emitAdded(wrap);

      assert.strictEqual(onSuccess.calls.length, 1);
      const p = onSuccess.calls[0];
      assert.strictEqual(p.id, 'two-sum');
      assert.strictEqual(p.title, 'Two Sum');
      assert.strictEqual(p.meta.difficulty, 'Easy');
      assert.strictEqual(p.meta.language, 'Python3');
      assert.strictEqual(p.meta.runtime, '52 ms');
      assert.strictEqual(MO.activeCount(), 0, 'observer disconnected on verdict');

      panel.appendChild(dom.el(doc, 'span[data-e2e-locator="submission-result"]', { text: 'Accepted' }));
      dom.emitAdded(panel.children[panel.children.length - 1]);
      assert.strictEqual(onSuccess.calls.length, 1, 'a verdict without a new submit is ignored');

      teardown();
      assert.strictEqual(doc.body.listenerCount(), 0, 'teardown removed every listener');
      assert.strictEqual(MO.activeCount(), 0, 'teardown left no observer');
      submit.dispatchEvent(dom.makeEvent('click', submit));
      assert.strictEqual(MO.activeCount(), 0, 'a click after teardown arms nothing');
    }

    // Wrong Answer disarms without logging; keyboard shortcut arms.
    {
      const { doc, panel } = scene();
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://leetcode.com/problems/two-sum/'));
      doc.body.dispatchEvent(dom.makeEvent('keydown', doc.body, { key: 'Enter', metaKey: true }));
      assert.strictEqual(MO.activeCount(), 1, 'Cmd+Enter arms');
      const wa = dom.el(doc, 'span[data-e2e-locator="submission-result"]', { text: 'Wrong Answer' });
      panel.appendChild(wa);
      dom.emitAdded(wa);
      assert.strictEqual(onSuccess.calls.length, 0);
      assert.strictEqual(MO.activeCount(), 0, 'a failing verdict still disconnects');
      teardown();
    }

    // Pending then Accepted via in-place text update.
    {
      const { doc, submit, panel } = scene();
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://leetcode.com/problems/two-sum/'));
      submit.dispatchEvent(dom.makeEvent('click', submit));
      const node = dom.el(doc, 'span[data-e2e-locator="submission-result"]', { text: 'Pending' });
      panel.appendChild(node);
      dom.emitAdded(node);
      assert.strictEqual(onSuccess.calls.length, 0);
      assert.strictEqual(MO.activeCount(), 2, 'pending node gets its own scoped observer');
      dom.setText(node, 'Accepted');
      assert.strictEqual(onSuccess.calls.length, 1, 'in-place update to Accepted is caught');
      assert.strictEqual(MO.activeCount(), 0);
      teardown();
    }

    // Arm window lapsed: a late Accepted is not attributed to the old submit.
    {
      const { doc, submit, panel } = scene();
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://leetcode.com/problems/two-sum/'));
      submit.dispatchEvent(dom.makeEvent('click', submit));
      now += adapter._internals.ARM_WINDOW_MS + 1;
      const late = dom.el(doc, 'span[data-e2e-locator="submission-result"]', { text: 'Accepted' });
      panel.appendChild(late);
      dom.emitAdded(late);
      assert.strictEqual(onSuccess.calls.length, 0, 'verdict outside the arm window is ignored');
      assert.strictEqual(MO.activeCount(), 0);
      teardown();
    }

    // Legacy green text inside a submissions-list row is not a verdict.
    {
      const { doc, submit, panel } = scene();
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://leetcode.com/problems/two-sum/'));
      submit.dispatchEvent(dom.makeEvent('click', submit));
      const row = dom.el(doc, 'tr', { children: [dom.el(doc, 'td', { children: [dom.el(doc, 'span.text-green-s', { text: 'Accepted' })] })] });
      panel.appendChild(row);
      dom.emitAdded(row);
      assert.strictEqual(onSuccess.calls.length, 0, 'old Accepted rows re-rendered after a submit do not count');
      const legacy = dom.el(doc, 'div.text-green-s', { text: 'Accepted' });
      panel.appendChild(legacy);
      dom.emitAdded(legacy);
      assert.strictEqual(onSuccess.calls.length, 1, 'legacy verdict outside a list row counts');
      teardown();
    }

    // Slug and title helpers.
    assert.strictEqual(adapter._internals.slugFrom(new URL('https://leetcode.com/problems/add-two-numbers/description/')), 'add-two-numbers');
    assert.strictEqual(adapter._internals.slugFrom(new URL('https://leetcode.com/problemset/')), null);
    {
      const doc = dom.installDom();
      doc.title = '2. Add Two Numbers - LeetCode';
      assert.strictEqual(adapter._internals.readTitle(doc, 'add-two-numbers'), 'Add Two Numbers', 'title falls back to document.title');
      doc.title = '';
      assert.strictEqual(adapter._internals.readTitle(doc, 'add-two-numbers'), 'Add Two Numbers', 'then to the humanized slug');
    }

    core._setClock(null);
    core.clearAdapters();
    uninstallMockChrome();
    console.log('[PASS] LeetCode adapter: submit-armed detection, verdict handling, arm window, list-row guard, teardown');
  }

  // -------------------------------------------------------------------------
  // 6. NeetCode adapter
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    loadAdapters(core, ['content/adapters/neetcode.js']);
    const adapter = core.getActiveAdapter('https://neetcode.io/practice');
    assert.strictEqual(adapter.dedupeScope, 'leetcode');
    const MO = dom.FakeMutationObserver;

    // Roadmap / practice list: checkbox toggles.
    {
      const doc = dom.installDom();
      const heading = dom.el(doc, 'h2.pattern-name', { text: 'Arrays & Hashing' });
      const box = dom.el(doc, 'input[type="checkbox"]');
      const link = dom.el(doc, 'a[href="/problems/two-sum"]', { text: 'Two Sum' });
      const row = dom.el(doc, 'tr', { children: [dom.el(doc, 'td', { children: [box] }), dom.el(doc, 'td', { children: [link] })] });
      const table = dom.el(doc, 'table', { children: [row] });
      doc.body.appendChild(dom.el(doc, 'section', { children: [heading, table] }));

      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://neetcode.io/roadmap'));
      assert.strictEqual(MO.activeCount(), 0, 'list pages use a delegated listener, no observer');
      assert.strictEqual(doc.body.listenerCount('change'), 1);

      box.checked = false;
      box.dispatchEvent(dom.makeEvent('change', box));
      assert.strictEqual(onSuccess.calls.length, 0, 'unticking does not count');

      box.checked = true;
      box.dispatchEvent(dom.makeEvent('change', box));
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual(onSuccess.calls[0], { id: 'two-sum', title: 'Two Sum', meta: { category: 'Arrays & Hashing' } });

      const other = dom.el(doc, 'input[type="text"]');
      doc.body.appendChild(other);
      other.dispatchEvent(dom.makeEvent('change', other));
      assert.strictEqual(onSuccess.calls.length, 1, 'non-checkbox change events are ignored');

      teardown();
      assert.strictEqual(doc.body.listenerCount(), 0);
      box.dispatchEvent(dom.makeEvent('change', box));
      assert.strictEqual(onSuccess.calls.length, 1, 'no detection after teardown');
    }

    // IDE: submit then passing output.
    {
      const doc = dom.installDom();
      doc.title = 'Duplicate Integer - NeetCode';
      doc.body.appendChild(dom.el(doc, 'h1', { text: 'Duplicate Integer' }));
      const submit = dom.el(doc, 'button.submit-btn', { text: 'Submit' });
      doc.body.appendChild(submit);
      const out = dom.el(doc, 'div.output-panel');
      doc.body.appendChild(out);

      const onSuccess = collect();
      const ide = core.getActiveAdapter('https://neetcode.io/problems/duplicate-integer');
      const teardown = ide.init(onSuccess, makeCtx(doc, 'https://neetcode.io/problems/duplicate-integer'));
      assert.strictEqual(MO.activeCount(), 0);

      const early = dom.el(doc, 'pre', { text: 'All Tests Passed' });
      out.appendChild(early);
      dom.emitAdded(early);
      assert.strictEqual(onSuccess.calls.length, 0, 'output before any submit is ignored');

      submit.dispatchEvent(dom.makeEvent('click', submit));
      assert.strictEqual(MO.activeCount(), 1);
      const running = dom.el(doc, 'pre.result', { text: 'Running tests...' });
      out.appendChild(running);
      dom.emitAdded(running);
      assert.strictEqual(onSuccess.calls.length, 0);
      dom.setText(running, 'All Tests Passed');
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.strictEqual(onSuccess.calls[0].id, 'duplicate-integer');
      assert.strictEqual(onSuccess.calls[0].title, 'Duplicate Integer');
      assert.strictEqual(MO.activeCount(), 0);

      submit.dispatchEvent(dom.makeEvent('click', submit));
      const failed = dom.el(doc, 'pre.result', { text: '2 / 5 tests passed. Failed on case 3' });
      out.appendChild(failed);
      dom.emitAdded(failed);
      assert.strictEqual(onSuccess.calls.length, 1, 'a partially passed run does not count');
      assert.strictEqual(MO.activeCount(), 0);

      teardown();
      assert.strictEqual(doc.body.listenerCount(), 0);
      assert.strictEqual(MO.activeCount(), 0);
    }

    // Row without a problems link slugifies the title.
    {
      const doc = dom.installDom();
      const box = dom.el(doc, 'input[type="checkbox"]');
      const row = dom.el(doc, 'li', { text: 'Valid Anagram', children: [box] });
      doc.body.appendChild(row);
      const p = adapter._internals.payloadFromRow(row);
      assert.strictEqual(p.id, 'valid-anagram');
      assert.strictEqual(p.title, 'Valid Anagram');
    }

    core.clearAdapters();
    uninstallMockChrome();
    console.log('[PASS] NeetCode adapter: checkbox toggles with category, IDE pass/fail, shared dedupe scope, teardown');
  }

  // -------------------------------------------------------------------------
  // 7. ATS adapters
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    loadAdapters(core, ATS_ADAPTERS);
    const ats = global.AutoTrackerATS;
    const MO = dom.FakeMutationObserver;
    let now = 5000000;
    core._setClock(() => now);

    // Title parsing.
    assert.deepStrictEqual(ats.parseTitle('Job Application for Software Engineer at Acme Corp'), { role: 'Software Engineer', company: 'Acme Corp' });
    assert.deepStrictEqual(ats.parseTitle('Software Engineer @ Acme'), { role: 'Software Engineer', company: 'Acme' });
    assert.deepStrictEqual(ats.parseTitle('Acme - Software Engineer', { companyFirst: true }), { company: 'Acme', role: 'Software Engineer' });
    assert.deepStrictEqual(ats.parseTitle('Software Engineer | Acme Careers'), { role: 'Software Engineer', company: 'Acme' });
    assert.deepStrictEqual(ats.parseTitle(''), { role: '', company: '' });

    // Greenhouse: confirmation URL logs on mount, with metadata.
    {
      const doc = dom.installDom();
      doc.title = 'Job Application for Research Engineer at Anthropic';
      doc.body.appendChild(dom.el(doc, 'h1.app-title', { text: 'Research Engineer' }));
      doc.body.appendChild(dom.el(doc, 'span.company-name', { text: 'at Anthropic' }));
      const href = 'https://job-boards.greenhouse.io/anthropic/jobs/4012345/confirmation';
      const adapter = core.getActiveAdapter(href);
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual(onSuccess.calls[0], { id: 'job-4012345', title: 'Research Engineer at Anthropic', company: 'Anthropic', role: 'Research Engineer' });
      assert.strictEqual(MO.activeCount(), 0, 'URL-confirmed mount leaves no observer behind');
      assert.strictEqual(doc.body.listenerCount(), 0);
      teardown();
    }

    // Greenhouse: job page, in-place confirmation requires an interaction first.
    {
      const doc = dom.installDom();
      doc.title = 'Job Application for Research Engineer at Anthropic';
      doc.body.appendChild(dom.el(doc, 'h1.app-title', { text: 'Research Engineer' }));
      const form = dom.el(doc, 'form#application_form');
      const button = dom.el(doc, 'button[type="submit"]', { text: 'Submit Application' });
      form.appendChild(button);
      doc.body.appendChild(form);
      const href = 'https://boards.greenhouse.io/anthropic/jobs/4012345';
      const adapter = core.getActiveAdapter(href);
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      assert.strictEqual(onSuccess.calls.length, 0, 'a job page is not a confirmation');
      assert.strictEqual(MO.activeCount(), 1, 'one body observer while waiting');

      const stale = dom.el(doc, 'div#application_confirmation', { text: 'Thank you for applying' });
      doc.body.appendChild(stale);
      dom.emitAdded(stale);
      assert.strictEqual(onSuccess.calls.length, 0, 'confirmation markup without any interaction is ignored');

      form.dispatchEvent(dom.makeEvent('submit', form));
      const real = dom.el(doc, 'div', { children: [dom.el(doc, 'h1', { text: 'Research Engineer' }), dom.el(doc, 'div#application_confirmation', { text: 'Thank you for applying' })] });
      doc.body.appendChild(real);
      dom.emitAdded(real);
      assert.strictEqual(onSuccess.calls.length, 1, 'confirmation after a submit counts, even when it is not the first heading in the container');
      assert.strictEqual(onSuccess.calls[0].id, 'job-4012345');
      assert.strictEqual(onSuccess.calls[0].company, 'Anthropic');
      assert.strictEqual(MO.activeCount(), 0);
      assert.strictEqual(doc.body.listenerCount(), 0, 'fired adapter tore itself down');
      teardown();
    }

    // Greenhouse embedded iframe: company from ?for=.
    {
      const doc = dom.installDom();
      doc.body.appendChild(dom.el(doc, 'h1.app-title', { text: 'Designer' }));
      const href = 'https://boards.greenhouse.io/embed/job_app?for=acme-labs&token=99';
      const adapter = core.getActiveAdapter(href);
      const p = adapter._internals.buildPayload(new URL(href), doc);
      assert.strictEqual(p.company, 'Acme Labs');
      assert.strictEqual(p.role, 'Designer');
      assert.strictEqual(p.id, 'acme-labs-designer', 'no job id in the embed URL, so company+role is the item id');
    }

    // Lever: /thanks.
    {
      const doc = dom.installDom();
      doc.title = 'Acme - Backend Engineer';
      doc.body.appendChild(dom.el(doc, 'div.posting-headline', { children: [dom.el(doc, 'h2', { text: 'Backend Engineer' })] }));
      const href = 'https://jobs.lever.co/acme/8f1a2b3c-1111-2222-3333-444455556666/thanks';
      const adapter = core.getActiveAdapter(href);
      const onSuccess = collect();
      adapter.init(onSuccess, makeCtx(doc, href))();
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual(onSuccess.calls[0], { id: 'posting-8f1a2b3c-1111-2222-3333-444455556666', title: 'Backend Engineer at Acme', company: 'Acme', role: 'Backend Engineer' });
      const apply = core.getActiveAdapter('https://jobs.lever.co/acme/8f1a2b3c-1111-2222-3333-444455556666/apply');
      const quiet = collect();
      const td = apply.init(quiet, makeCtx(dom.installDom(), 'https://jobs.lever.co/acme/8f1a2b3c-1111-2222-3333-444455556666/apply'));
      assert.strictEqual(quiet.calls.length, 0, '/apply is not a confirmation');
      td();
      assert.strictEqual(MO.activeCount(), 0);
    }

    // Ashby: in-place success block after clicking submit.
    {
      const doc = dom.installDom();
      doc.title = 'Product Engineer @ Acme';
      doc.body.appendChild(dom.el(doc, 'h1', { text: 'Product Engineer' }));
      const button = dom.el(doc, 'button', { text: 'Submit Application' });
      doc.body.appendChild(button);
      const href = 'https://jobs.ashbyhq.com/acme/8f1a2b3c-1111-2222-3333-444455556666/application';
      const adapter = core.getActiveAdapter(href);
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      button.dispatchEvent(dom.makeEvent('click', button));
      const success = dom.el(doc, 'div[class="ashby-application-form-success-container"]', { text: 'Your application has been received.' });
      doc.body.appendChild(success);
      dom.emitAdded(success);
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual(onSuccess.calls[0], { id: 'job-8f1a2b3c-1111-2222-3333-444455556666', title: 'Product Engineer at Acme', company: 'Acme', role: 'Product Engineer' });
      teardown();
      assert.strictEqual(MO.activeCount(), 0);
    }

    // Workday: text banner after the submit click; company from the tenant.
    {
      const doc = dom.installDom();
      doc.title = 'Software Engineer II';
      doc.body.appendChild(dom.el(doc, 'h2[data-automation-id="jobPostingHeader"]', { text: 'Software Engineer II' }));
      const button = dom.el(doc, 'button[data-automation-id="bottom-navigation-next-button"]', { text: 'Submit' });
      doc.body.appendChild(button);
      const href = 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Software-Engineer-II_JR1990001/apply/applyManually';
      const adapter = core.getActiveAdapter(href);
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));

      const noise = dom.el(doc, 'div[data-automation-id="progressBar"]', { text: 'Step 4 of 4: Review' });
      doc.body.appendChild(noise);
      dom.emitAdded(noise);
      assert.strictEqual(MO.activeCount(), 1, 'Workday automation-id noise does not spawn scoped observers');

      button.dispatchEvent(dom.makeEvent('click', button));
      const banner = dom.el(doc, 'div[data-automation-id="applicationSubmittedMessage"]', { text: 'Congratulations, your application has been submitted.' });
      doc.body.appendChild(banner);
      dom.emitAdded(banner);
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.strictEqual(onSuccess.calls[0].company, 'Nvidia');
      assert.strictEqual(onSuccess.calls[0].role, 'Software Engineer II');
      assert.strictEqual(onSuccess.calls[0].id, 'job-Software-Engineer-II_JR1990001');
      teardown();
      assert.strictEqual(MO.activeCount(), 0);
    }

    // Arm window: an interaction long ago does not validate a later confirmation.
    {
      const doc = dom.installDom();
      const button = dom.el(doc, 'button', { text: 'Next' });
      doc.body.appendChild(button);
      const href = 'https://jobs.ashbyhq.com/acme/8f1a2b3c-1111-2222-3333-444455556666/application';
      const adapter = core.getActiveAdapter(href);
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      button.dispatchEvent(dom.makeEvent('click', button));
      now += ats.ARM_WINDOW_MS + 1;
      const h = dom.el(doc, 'h2', { text: 'Thank you for applying' });
      doc.body.appendChild(h);
      dom.emitAdded(h);
      assert.strictEqual(onSuccess.calls.length, 0);
      teardown();
    }

    // Declarative adapters stay small.
    for (const file of ['greenhouse', 'lever', 'ashby', 'workday']) {
      const src = fs.readFileSync(path.join(ROOT, 'content/adapters/ats', file + '.js'), 'utf8');
      const codeLines = src.split('\n').filter(l => l.trim() && !l.trim().startsWith('//'));
      assert.ok(codeLines.length <= 40, `${file}.js should stay declarative (${codeLines.length} code lines)`);
    }

    core._setClock(null);
    core.clearAdapters();
    uninstallMockChrome();
    console.log('[PASS] ATS adapters: URL and in-place confirmations, interaction gating, metadata for all four systems');
  }

  // -------------------------------------------------------------------------
  // 8. Entry point: mount, SPA remount, pagehide teardown
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    global.AutoTrackerCore = core;
    const doc = dom.installDom();
    global.document = doc;

    const winListeners = {};
    const history = {
      pushState(state, title, url) { win.location.href = new URL(url, win.location.href).href; },
      replaceState(state, title, url) { win.location.href = new URL(url, win.location.href).href; }
    };
    const win = {
      location: { href: 'https://leetcode.com/problems/two-sum/' },
      history,
      addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
      removeEventListener(type, fn) { winListeners[type] = (winListeners[type] || []).filter(f => f !== fn); },
      emit(type, event) { (winListeners[type] || []).slice().forEach(f => f(event || { type })); }
    };
    global.window = win;
    global.location = win.location;

    const inits = [];
    const teardowns = [];
    core.registerAdapter({
      id: 'lc',
      metricId: 'leetcode',
      matches: u => u.hostname === 'leetcode.com' && /^\/problems\//.test(u.pathname),
      routeKey: u => (u.pathname.match(/^\/problems\/([^/]+)/) || [])[1],
      init(onSuccess, ctx) { inits.push(ctx.url.href); return () => teardowns.push(ctx.url.href); }
    });
    core.registerAdapter({
      id: 'other',
      metricId: 'jobs',
      matches: u => u.hostname === 'jobs.example',
      init(onSuccess, ctx) { inits.push(ctx.url.href); return () => teardowns.push(ctx.url.href); }
    });

    fresh('content/auto-tracker.js');
    assert.deepStrictEqual(inits, ['https://leetcode.com/problems/two-sum/'], 'mounted on load');
    assert.strictEqual(win.__ptAutoTrackerMounted, true);

    history.pushState({}, '', '/problems/two-sum/submissions/123/');
    assert.strictEqual(inits.length, 1, 'same route key: no remount');
    assert.strictEqual(teardowns.length, 0);

    history.pushState({}, '', '/problems/add-two-numbers/');
    assert.strictEqual(teardowns.length, 1, 'old mount torn down');
    assert.strictEqual(inits.length, 2, 'new problem mounted');
    assert.strictEqual(inits[1], 'https://leetcode.com/problems/add-two-numbers/');

    history.replaceState({}, '', '/problemset/all/');
    assert.strictEqual(teardowns.length, 2, 'navigating to an unmatched URL unmounts');
    assert.strictEqual(inits.length, 2);

    win.location.href = 'https://leetcode.com/problems/three-sum/';
    win.emit('popstate');
    assert.strictEqual(inits.length, 3, 'popstate remounts');

    win.emit('pagehide');
    assert.strictEqual(teardowns.length, 3, 'pagehide tears down');
    assert.strictEqual(typeof history.pushState, 'function');
    history.pushState({}, '', '/problems/four-sum/');
    assert.strictEqual(inits.length, 3, 'no remount after pagehide: URL watch was stopped');

    win.emit('pageshow', { type: 'pageshow', persisted: true });
    assert.strictEqual(inits.length, 4, 'bfcache restore re-mounts');
    assert.strictEqual(inits[3], 'https://leetcode.com/problems/four-sum/');
    win.emit('pagehide');
    assert.strictEqual(teardowns.length, 4);

    delete global.window;
    delete global.location;
    delete global.document;
    delete global.AutoTrackerCore;
    core.clearAdapters();
    uninstallMockChrome();
    console.log('[PASS] Entry point: mount on load, route-key aware SPA remount, popstate, pagehide, bfcache restore');
  }

  // -------------------------------------------------------------------------
  // 9. Core DOM helpers and static zero-polling guard
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    const doc = dom.installDom();
    const MO = dom.FakeMutationObserver;

    const cleanup = core.createCleanup();
    let torn = 0;
    cleanup.add(() => { torn++; });
    cleanup.add(() => { throw new Error('bad teardown'); });
    cleanup.add(() => { torn++; });
    assert.strictEqual(cleanup.size(), 3);
    cleanup();
    assert.strictEqual(torn, 2, 'a throwing teardown does not stop the others');
    cleanup();
    assert.strictEqual(torn, 2, 'cleanup is idempotent');
    let late = 0;
    cleanup.add(() => { late++; });
    assert.strictEqual(late, 1, 'adding to a finished cleanup runs immediately');

    const found = [];
    const stop = core.waitFor('span.hit', { root: doc.body, onFound: n => found.push(n.textContent) });
    assert.strictEqual(MO.activeCount(), 1);
    const miss = dom.el(doc, 'span.miss', { text: 'no' });
    doc.body.appendChild(miss);
    dom.emitAdded(miss);
    assert.strictEqual(found.length, 0);
    const box = dom.el(doc, 'div', { children: [dom.el(doc, 'span.hit', { text: 'yes' })] });
    doc.body.appendChild(box);
    dom.emitAdded(box);
    assert.deepStrictEqual(found, ['yes'], 'match found inside an added container');
    assert.strictEqual(MO.activeCount(), 0, 'waitFor disconnects itself after the first hit');
    stop();

    // waitForText caps scoped observers.
    const stopText = core.waitForText('p', { root: doc.body, maxTracked: 2, test: t => /done/.test(t) });
    for (let i = 0; i < 5; i++) { const p = dom.el(doc, 'p', { text: 'wait' }); doc.body.appendChild(p); dom.emitAdded(p); }
    assert.strictEqual(MO.activeCount(), 3, 'one root observer plus at most maxTracked scoped observers');
    stopText();
    assert.strictEqual(MO.activeCount(), 0);

    const off = core.listen(doc.body, 'click', () => {});
    assert.strictEqual(doc.body.listenerCount('click'), 1);
    off();
    assert.strictEqual(doc.body.listenerCount('click'), 0);

    // No polling anywhere in the auto-tracker sources.
    const sources = [
      'shared/auto-tracker-core.js',
      'shared/job-meta.js',
      'content/auto-tracker.js',
      'content/quick-log.js',
      'content/universal-bootstrap.js',
      'content/adapters/leetcode.js',
      'content/adapters/neetcode.js',
      'content/adapters/ats/universal.js'
    ].concat(ATS_ADAPTERS);
    for (const file of sources) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.ok(!/setInterval\s*\(/.test(src), `${file} must not poll with setInterval`);
    }

    uninstallMockChrome();
    console.log('[PASS] Core helpers: cleanup aggregation, scoped waitFor, tracked-observer cap, no setInterval in sources');
  }

  // -------------------------------------------------------------------------
  // 10. JobMeta: company and role extraction, job-page scoring
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const meta = loadJobMeta();
    const cases = [
      ['https://careers.airbnb.com/positions/123', 'Airbnb'],
      ['https://stripe.com/jobs/listing/backend-engineer/5521', 'Stripe'],
      ['https://jobs.netflix.com/jobs/31337', 'Netflix'],
      ['https://www.acme.co.uk/careers/', 'Acme'],
      ['https://apply.workable.com/acme-labs/j/4F2C9A1B7D/', 'Acme Labs'],
      ['https://acme.workable.com/jobs/12', 'Acme'],
      ['https://careers-globex.icims.com/jobs/4821/software-engineer/job', 'Globex'],
      ['https://jobs.smartrecruiters.com/Pendant/743999-logistics', 'Pendant'],
      ['https://ats.rippling.com/foo-bar/jobs/1', 'Foo Bar'],
      ['https://acme.rippling-ats.com/job/1', 'Acme'],
      ['https://kramerica.breezy.hr/p/abc-marketing-lead', 'Kramerica'],
      ['https://initech.bamboohr.com/careers/112', 'Initech'],
      ['https://vandelay.applytojob.com/apply/xyz', 'Vandelay'],
      ['https://jobs.jobvite.com/soylent/job/o1', 'Soylent'],
      ['https://hooli.recruitee.com/o/data-scientist', 'Hooli'],
      ['https://pied-piper.pinpointhq.com/jobs/77', 'Pied Piper'],
      ['https://acme.taleo.net/careersection/2/jobapply.ftl?job=1', 'Acme'],
      ['https://boards.greenhouse.io/embed/job_app?for=acme', 'Acme'],
      ['https://jobs.smartrecruiters.com/', ''],
      ['http://localhost:8080/apply', '']
    ];
    for (const [href, expected] of cases) {
      assert.strictEqual(meta.companyFromUrl(href), expected, 'company for ' + href);
    }

    assert.strictEqual(meta.cleanRole('Senior Engineer - Careers | Airbnb', 'Airbnb'), 'Senior Engineer');
    assert.strictEqual(meta.cleanRole('Job Application for Designer at Acme', 'Acme'), 'Designer');
    assert.strictEqual(meta.cleanRole('Acme Careers - Backend Engineer', 'Acme'), 'Backend Engineer');
    assert.strictEqual(meta.cleanRole('Data Analyst | Globex Jobs', ''), 'Data Analyst');
    assert.strictEqual(meta.cleanRole('Thank you for applying', 'Acme'), '', 'generic headings are not roles');
    assert.strictEqual(meta.cleanCompany('Vandelay Industries Careers'), 'Vandelay Industries');
    assert.strictEqual(meta.cleanCompany('Workable'), '', 'an ATS name is never the employer');

    const doc = jobPage({
      title: 'Careers',
      meta: [['og:site_name', 'Workable'], ['og:title', 'Platform Engineer - Umbrella']],
      jsonLd: { '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': 'JobPosting', title: 'Platform Engineer', hiringOrganization: { '@type': 'Organization', name: 'Umbrella Corp' }, identifier: { value: 'UMB-9' } }] },
      body: [d => dom.el(d, 'h1', { text: 'Apply now' })]
    });
    const ex = meta.extract(doc, 'https://apply.workable.com/umbrella/j/ZZZ/apply');
    assert.deepStrictEqual(
      { company: ex.company, companySource: ex.companySource, role: ex.role, roleSource: ex.roleSource, sourceId: ex.sourceId },
      { company: 'Umbrella Corp', companySource: 'json-ld', role: 'Platform Engineer', roleSource: 'json-ld', sourceId: 'apply.workable.com:UMB-9' },
      'JSON-LD inside @graph wins; the ATS site name is ignored'
    );
    const bare = meta.extract(jobPage({ title: 'Data Analyst - Acme Careers', meta: [['og:title', 'Data Analyst - Acme Careers']] }), 'https://acme.taleo.net/careersection/2/jobapply.ftl?job=12345');
    assert.strictEqual(bare.company, 'Acme');
    assert.strictEqual(bare.role, 'Data Analyst');
    assert.strictEqual(bare.sourceId, 'acme.taleo.net:job=12345', 'a job id in the query is part of the listing id');
    const broken = jobPage({ body: [d => dom.el(d, 'script[type="application/ld+json"]', { text: '{not json' })] });
    assert.deepStrictEqual(meta.readJsonLd(broken), [], 'malformed JSON-LD is skipped');

    const apply = jobPage({ body: [d => dom.el(d, 'label', { text: 'Resume / CV' }), d => dom.el(d, 'input[type="file"][name="resume"]'), d => dom.el(d, 'label', { text: 'LinkedIn profile' })] });
    assert.ok(meta.jobSignals(apply, 'https://example.com/join').isJob, 'a resume upload plus application wording is a job page');
    const blog = jobPage({ body: [d => dom.el(d, 'h1', { text: 'My interview story' })] });
    assert.ok(!meta.jobSignals(blog, 'https://example.com/blog/careers-advice').isJob, 'a blog post is not a job page');
    assert.ok(meta.jobSignals(jobPage({}), 'https://jobs.lever.co/acme/1').isJob, 'an ATS host alone qualifies');

    assert.ok(meta.isSuccessText('Thank you for applying!'));
    assert.ok(meta.isSuccessText('Your application was sent successfully'));
    assert.ok(meta.isSuccessText('We have received your application for Data Scientist.'));
    assert.ok(!meta.isSuccessText('Thanks! Your application has been received and you are subscribed to our newsletter.'), 'newsletter wording vetoes a match');
    assert.ok(!meta.isSuccessText('Thank you for your order'));
    assert.ok(!meta.isSuccessText('Your credit card application was submitted'));
    assert.ok(meta.isConfirmationUrl('https://x.com/careers/apply/7/thank-you'));
    assert.ok(meta.isConfirmationUrl('https://x.com/jobs/1#/application-submitted'));
    assert.ok(!meta.isConfirmationUrl('https://x.com/successful-teams/jobs'));
    assert.ok(meta.looksLikeJobUrl('https://careers.acme.com/'));
    assert.ok(meta.looksLikeJobUrl('https://acme.com/en/jobs/12'));
    assert.ok(!meta.looksLikeJobUrl('https://acme.com/pricing'));

    delete global.JobMeta;
    uninstallMockChrome();
    console.log('[PASS] JobMeta: 20 company-from-URL cases, role cleanup, JSON-LD @graph, job scoring, success and negative wording');
  }

  // -------------------------------------------------------------------------
  // 11. Universal adapter: ten career-site layouts
  // -------------------------------------------------------------------------
  {
    const chrome = installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    loadJobMeta();
    const load = () => {
      core.clearAdapters();
      loadAdapters(core, ['content/adapters/ats/universal.js']);
      return core.getActiveAdapter('https://example.com/');
    };
    let adapter = load();
    assert.strictEqual(adapter.id, 'universal');
    assert.strictEqual(core.getActiveAdapter('chrome://extensions/'), null, 'only web pages');
    let now = 9000000;
    core._setClock(() => now);
    const MO = dom.FakeMutationObserver;
    const click = node => node.dispatchEvent(dom.makeEvent('click', node));

    // 1. Workable: in-place heading after the Submit click.
    {
      const button = dom.el(dom.installDom(), 'button', { text: 'Submit application' });
      const doc = jobPage({
        title: 'Senior Robotics Engineer - Acme Robotics',
        body: [
          d => dom.el(d, 'h1', { text: 'Senior Robotics Engineer' }),
          d => dom.el(d, 'form', { children: [dom.el(d, 'label', { text: 'Resume' }), dom.el(d, 'input[type="file"][name="resume"]'), button] })
        ]
      });
      const href = 'https://apply.workable.com/acme-robotics/j/4F2C9A1B7D/apply/';
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      assert.strictEqual(MO.activeCount(), 0, 'nothing is observed before the user acts');
      click(button);
      assert.ok(MO.activeCount() >= 1, 'submitting arms the watchers');
      const done = dom.el(doc, 'div', { children: [dom.el(doc, 'h2', { text: 'Thank you for applying!' })] });
      doc.body.appendChild(done);
      dom.emitAdded(done);
      assert.strictEqual(onSuccess.calls.length, 1);
      const p = onSuccess.calls[0];
      assert.strictEqual(p.company, 'Acme Robotics');
      assert.strictEqual(p.role, 'Senior Robotics Engineer');
      assert.strictEqual(p.id, 'apply.workable.com:4f2c9a1b7d');
      assert.strictEqual(p.url, 'https://apply.workable.com/acme-robotics/j/4F2C9A1B7D/apply/');
      assert.strictEqual(p.notes, 'Auto-logged from Workable | Senior Robotics Engineer at Acme Robotics');
      assert.strictEqual(MO.activeCount(), 0, 'fired adapter disconnects everything');
      teardown();
      assert.strictEqual(doc.body.listenerCount(), 0);
    }

    // 2. Taleo: an existing alert region fills in after the form submits.
    {
      const form = dom.el(dom.installDom(), 'form#applyFlow');
      const alertBox = dom.el(dom.installDom(), 'div[role="alert"]');
      const doc = jobPage({ title: 'Data Analyst - Acme Careers', meta: [['og:title', 'Data Analyst - Acme Careers']], body: [form, alertBox] });
      const href = 'https://acme.taleo.net/careersection/2/jobapply.ftl?job=12345&lang=en';
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      form.dispatchEvent(dom.makeEvent('submit', form));
      dom.setText(alertBox, 'Your application has been submitted.');
      assert.strictEqual(onSuccess.calls.length, 1, 'an in-place update to a live region counts');
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id], ['Acme', 'Data Analyst', 'acme.taleo.net:job=12345']);
      teardown();
    }

    // 3. iCIMS: JSON-LD metadata, an input[type=submit] labelled by value.
    {
      const submit = dom.el(dom.installDom(), 'input[type="submit"]', { attrs: { value: 'Submit' } });
      const doc = jobPage({
        jsonLd: { '@type': 'JobPosting', title: 'Software Engineer II', hiringOrganization: { name: 'Globex Corporation' } },
        body: [d => dom.el(d, 'div.iCIMS_Forms', { children: [submit] })]
      });
      const href = 'https://careers-globex.icims.com/jobs/4821/software-engineer/job?mode=apply&iis=Indeed';
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      click(submit);
      const msg = dom.el(doc, 'div.iCIMS_InfoMsg', { children: [dom.el(doc, 'p', { text: 'Thank you for your application. A recruiter will be in touch.' })] });
      doc.body.appendChild(msg);
      dom.emitAdded(msg);
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id], ['Globex Corporation', 'Software Engineer II', 'careers-globex.icims.com:4821']);
      teardown();
    }

    // 4. BambooHR: a React dialog appears after "Submit Application".
    {
      const button = dom.el(dom.installDom(), 'button[type="button"]', { text: 'Submit Application' });
      const doc = jobPage({ meta: [['og:site_name', 'Initech']], body: [d => dom.el(d, 'h1', { text: 'Product Manager' }), button] });
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://initech.bamboohr.com/careers/112'));
      click(button);
      const dialog = dom.el(doc, 'div[role="dialog"]', { children: [dom.el(doc, 'h2', { text: 'Application Submitted' }), dom.el(doc, 'p', { text: 'We will be in touch.' })] });
      doc.body.appendChild(dialog);
      dom.emitAdded(dialog);
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role], ['Initech', 'Product Manager']);
      teardown();
    }

    // 5. Custom React modal on a company's own domain.
    {
      const button = dom.el(dom.installDom(), 'button', { text: 'Send application' });
      const doc = jobPage({
        body: [
          d => dom.el(d, 'h1', { text: 'Data Scientist' }),
          d => dom.el(d, 'input[type="file"][accept=".pdf,.doc,.docx"]'),
          button
        ]
      });
      const href = 'https://www.hooli.com/careers/jobs/5521-data-scientist/apply';
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, href));
      click(button);
      const modal = dom.el(doc, 'div[class="Modal_root__x1"]', { children: [dom.el(doc, 'div[class="Modal_body__x2"]', { text: 'We have received your application for Data Scientist.' })] });
      doc.body.appendChild(modal);
      dom.emitAdded(modal);
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id], ['Hooli', 'Data Scientist', 'hooli.com:5521-data-scientist']);
      teardown();
    }

    // 6. Web component: the form and the success message live in an open
    // shadow root; the click reaches the document retargeted to the host.
    {
      const doc = jobPage({
        jsonLd: { '@type': 'JobPosting', title: 'Field Researcher', hiringOrganization: 'Umbrella' },
        body: [d => dom.el(d, 'apply-flow')]
      });
      const hostEl = doc.body.children[0];
      const shadow = hostEl.attachShadow({ mode: 'open' });
      const button = dom.el(doc, 'button', { text: 'Apply' });
      shadow.appendChild(dom.el(doc, 'form', { children: [button] }));
      const onSuccess = collect();
      const teardown = adapter.init(onSuccess, makeCtx(doc, 'https://careers.umbrella.example/positions/77/apply'));
      hostEl.dispatchEvent(dom.makeEvent('click', hostEl, { composedPath: () => [button, button.parentElement, shadow, hostEl, doc.body] }));
      assert.ok(MO.observing(shadow).length >= 1, 'the open shadow root is watched once the user acts');
      const msg = dom.el(doc, 'p.success', { text: 'Thank you for your application!' });
      shadow.appendChild(msg);
      dom.emitAdded(msg);
      assert.strictEqual(onSuccess.calls.length, 1, 'a message inside a shadow root counts');
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id], ['Umbrella', 'Field Researcher', 'careers.umbrella.example:77']);
      teardown();
      assert.strictEqual(MO.activeCount(), 0);
    }

    // 7. SPA: pushState to /thank-you remounts the adapter; the intent from
    // the form carries over in memory and the richer form details win.
    {
      const button = dom.el(dom.installDom(), 'button', { text: 'Submit' });
      const doc = jobPage({
        title: 'Growth Lead | Soylent',
        meta: [['og:site_name', 'Soylent']],
        jsonLd: { '@type': 'JobPosting', title: 'Growth Lead', hiringOrganization: { name: 'Soylent' }, identifier: 'SOY-31' },
        body: [d => dom.el(d, 'h1', { text: 'Growth Lead' }), button]
      });
      const onSuccess = collect();
      const first = adapter.init(onSuccess, makeCtx(doc, 'https://jobs.soylent.io/careers/apply/31'));
      click(button);
      first();
      // The route changes and the page re-renders into a bare thank-you view.
      doc.body.children.slice().forEach(c => c.remove());
      doc.documentElement.children.filter(c => c.tagName !== 'BODY').forEach(c => c.remove());
      doc.title = 'Thank you';
      doc.body.appendChild(dom.el(doc, 'h1', { text: 'Thanks!' }));
      const second = adapter.init(onSuccess, makeCtx(doc, 'https://jobs.soylent.io/careers/apply/31/thank-you'));
      assert.strictEqual(onSuccess.calls.length, 1, 'the confirmation route fires on remount');
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id, onSuccess.calls[0].meta.detection], ['Soylent', 'Growth Lead', 'jobs.soylent.io:SOY-31', 'url']);
      second();
    }

    // 8. Full page load: a POST redirect lands on /application-submitted in a
    // new document. The intent persisted to chrome.storage.session.
    {
      const form = dom.el(dom.installDom(), 'form');
      const doc = jobPage({ meta: [['og:site_name', 'Vandelay Industries Careers']], body: [d => dom.el(d, 'h1', { text: 'Import Export Analyst' }), form] });
      const onSuccess = collect();
      const td = adapter.init(onSuccess, makeCtx(doc, 'https://careers.vandelay.com/jobs/909/apply'));
      form.dispatchEvent(dom.makeEvent('submit', form));
      await settle();
      td();
      const stored = chrome.storage.session.store[adapter._internals.ARM_STORE_KEY];
      assert.ok(stored && stored['https://careers.vandelay.com'], 'intent persisted per site');

      adapter = load(); // a new document gets a fresh copy of the script
      const next = jobPage({ title: 'Submitted', body: [d => dom.el(d, 'p', { text: 'All set.' })] });
      const onNext = collect();
      const td2 = adapter.init(onNext, makeCtx(next, 'https://careers.vandelay.com/application-submitted?ref=909'));
      await settle();
      assert.strictEqual(onNext.calls.length, 1, 'the redirect target fires from the persisted intent');
      assert.deepStrictEqual([onNext.calls[0].company, onNext.calls[0].role, onNext.calls[0].id], ['Vandelay Industries', 'Import Export Analyst', 'careers.vandelay.com:909']);
      assert.ok(!chrome.storage.session.store[adapter._internals.ARM_STORE_KEY]['https://careers.vandelay.com'], 'the intent is consumed');
      td2();
    }

    // 9. SmartRecruiters: loaded straight at a confirmation URL with the
    // message on screen and JSON-LD; no intent needed.
    {
      const doc = jobPage({
        jsonLd: { '@type': 'JobPosting', title: 'Logistics Coordinator', hiringOrganization: { name: 'Pendant Publishing' }, identifier: { value: '743999' } },
        body: [d => dom.el(d, 'h1', { text: 'Thank you for applying!' })]
      });
      const onSuccess = collect();
      const td = adapter.init(onSuccess, makeCtx(doc, 'https://jobs.smartrecruiters.com/Pendant/743999-logistics-coordinator/confirmation'));
      await settle();
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id, onSuccess.calls[0].meta.detection], ['Pendant Publishing', 'Logistics Coordinator', 'jobs.smartrecruiters.com:743999', 'url+message']);
      td();
    }

    // 10. Breezy: a status toast after "Submit Application", role from
    // og:title with the company suffix stripped.
    {
      const button = dom.el(dom.installDom(), 'a[role="button"]', { text: 'Submit Application' });
      const doc = jobPage({ meta: [['og:title', 'Marketing Lead | Kramerica']], body: [d => dom.el(d, 'label', { text: 'Resume' }), button] });
      const onSuccess = collect();
      const td = adapter.init(onSuccess, makeCtx(doc, 'https://kramerica.breezy.hr/p/8a7b6c5d4e3f-marketing-lead/apply'));
      click(button);
      const toast = dom.el(doc, 'div[role="status"]', { text: 'Your application was sent successfully' });
      doc.body.appendChild(toast);
      dom.emitAdded(toast);
      assert.strictEqual(onSuccess.calls.length, 1);
      assert.deepStrictEqual([onSuccess.calls[0].company, onSuccess.calls[0].role, onSuccess.calls[0].id], ['Kramerica', 'Marketing Lead', 'kramerica.breezy.hr:8a7b6c5d4e3f-marketing-lead']);
      td();
    }

    core._setClock(null);
    core.clearAdapters();
    delete global.JobMeta;
    uninstallMockChrome();
    console.log('[PASS] Universal adapter: Workable, Taleo, iCIMS, BambooHR, React modal, shadow root, SPA route, cross-page redirect, SmartRecruiters, Breezy');
  }

  // -------------------------------------------------------------------------
  // 12. Universal adapter: negative cases never log
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    loadJobMeta();
    loadAdapters(core, ['content/adapters/ats/universal.js']);
    const adapter = core.getActiveAdapter('https://example.com/');
    let now = 12000000;
    core._setClock(() => now);
    const MO = dom.FakeMutationObserver;
    const click = node => node.dispatchEvent(dom.makeEvent('click', node));

    async function scenario(name, href, build, act) {
      adapter._internals.reset();
      const doc = dom.installDom();
      const parts = build(doc);
      const onSuccess = collect();
      const td = adapter.init(onSuccess, makeCtx(doc, href));
      await settle();
      await act(doc, parts);
      await settle();
      assert.strictEqual(onSuccess.calls.length, 0, name + ' must not log');
      td();
      assert.strictEqual(MO.activeCount(), 0, name + ' leaves no observer');
    }

    const add = (doc, spec, text) => {
      const n = dom.el(doc, spec, { text });
      doc.body.appendChild(n);
      dom.emitAdded(n);
    };

    await scenario('Newsletter signup on a careers page', 'https://www.acme.com/careers/', doc => {
      const form = dom.el(doc, 'form', { children: [dom.el(doc, 'input[type="email"]'), dom.el(doc, 'button', { text: 'Subscribe' })] });
      doc.body.appendChild(dom.el(doc, 'h2', { text: 'Join our talent newsletter' }));
      doc.body.appendChild(form);
      return { form };
    }, (doc, { form }) => {
      form.dispatchEvent(dom.makeEvent('submit', form));
      add(doc, 'p', 'Thanks! Your application has been received and you are now subscribed to our newsletter.');
    });

    await scenario('eCommerce checkout thank-you page', 'https://shop.example.com/checkout/thank-you', doc => {
      doc.body.appendChild(dom.el(doc, 'h1', { text: 'Thank you! Your application was submitted.' }));
      doc.body.appendChild(dom.el(doc, 'p', { text: 'Order #4411 ships soon.' }));
      return {};
    }, async () => {});

    await scenario('Password reset', 'https://app.example.com/account/password/reset/success', doc => {
      const button = dom.el(doc, 'button', { text: 'Submit' });
      doc.body.appendChild(button);
      return { button };
    }, (doc, { button }) => {
      click(button);
      add(doc, 'p', 'Your request has been submitted. Check your email for a reset link.');
    });

    await scenario('Blog comment', 'https://blog.example.com/posts/how-i-got-my-job', doc => {
      const button = dom.el(doc, 'button', { text: 'Submit' });
      doc.body.appendChild(dom.el(doc, 'h1', { text: 'How I prepared for my interview' }));
      doc.body.appendChild(dom.el(doc, 'form', { children: [dom.el(doc, 'textarea'), button] }));
      return { button };
    }, (doc, { button }) => {
      click(button);
      add(doc, 'p', 'Thank you for applying my advice, great post!');
    });

    await scenario('Volunteer signup with no job signals', 'https://volunteer.example.org/signup', doc => {
      const button = dom.el(doc, 'button', { text: 'Submit' });
      doc.body.appendChild(button);
      return { button };
    }, (doc, { button }) => {
      click(button);
      add(doc, 'h2', 'Thank you for applying to volunteer!');
    });

    await scenario('A stale confirmation already on screen, no intent', 'https://apply.workable.com/acme/j/ABC123/', doc => {
      doc.body.appendChild(dom.el(doc, 'h2', { text: 'Thank you for applying' }));
      return {};
    }, doc => add(doc, 'h2', 'Thank you for applying'));

    await scenario('Confirmation after the intent window lapsed', 'https://apply.workable.com/acme/j/ABC123/apply', doc => {
      const button = dom.el(doc, 'button', { text: 'Submit application' });
      doc.body.appendChild(dom.el(doc, 'input[type="file"][name="resume"]'));
      doc.body.appendChild(button);
      return { button };
    }, (doc, { button }) => {
      click(button);
      now += adapter._internals.ARM_WINDOW_MS + 1;
      add(doc, 'h2', 'Thank you for applying!');
    });

    await scenario('Clicking a non-submit control', 'https://apply.workable.com/acme/j/ABC123/apply', doc => {
      const button = dom.el(doc, 'button', { text: 'Save draft' });
      doc.body.appendChild(button);
      return { button };
    }, (doc, { button }) => {
      click(button);
      assert.strictEqual(MO.activeCount(), 0, 'a non-submit click arms nothing');
      add(doc, 'h2', 'Thank you for applying!');
    });

    await scenario('Order confirmation URL after a checkout submit', 'https://store.example.com/order/confirmation', doc => {
      const button = dom.el(doc, 'button', { text: 'Place order' });
      doc.body.appendChild(dom.el(doc, 'h1', { text: 'Thank you for your order' }));
      doc.body.appendChild(button);
      return { button };
    }, async () => {});

    core._setClock(null);
    core.clearAdapters();
    delete global.JobMeta;
    uninstallMockChrome();
    console.log('[PASS] Universal adapter negatives: newsletter, checkout, password reset, blog comment, volunteer form, stale page, lapsed window, non-submit click, order URL');
  }

  // -------------------------------------------------------------------------
  // 13. Job toasts: Edit details and Undo; the 90-day duplicate prompt
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    const storage = fresh('shared/storage.js');
    const doc = dom.installDom();
    const adapter = { id: 'universal', label: 'Career site', metricId: 'jobs', matches: () => true, init: () => () => {} };
    const payload = { id: 'hooli.com:5521', title: 'Data Scientist at Hooli', company: 'Hooli', role: 'Data Scientist', url: 'https://hooli.com/careers/jobs/5521' };

    const first = await core.dispatch(adapter, payload, { document: doc, storage });
    assert.strictEqual(first.logged, true);
    assert.strictEqual(first.log.source, 'auto');
    assert.strictEqual(first.log.sourceId, 'universal:hooli-com-5521');
    assert.strictEqual(first.log.url, 'https://hooli.com/careers/jobs/5521');
    assert.deepStrictEqual(toastTexts(doc, core), ['Logged application at Hooli — Data Scientist']);
    assert.deepStrictEqual(toastButtons(doc, core).map(b => b.textContent), ['Edit details', 'Undo']);

    clickToastButton(doc, core, 'Edit details');
    assert.ok(first.toast.submitForm({ company: 'Hooli XYZ', role: 'Senior Data Scientist' }));
    await settle();
    const edited = (await storage.getLogs({ metricId: 'jobs' }))[0];
    assert.strictEqual(edited.company, 'Hooli XYZ', 'the inline edit reached storage');
    assert.strictEqual(edited.role, 'Senior Data Scientist');
    assert.deepStrictEqual(toastTexts(doc, core), ['Updated application at Hooli XYZ — Senior Data Scientist']);

    clickToastButton(doc, core, 'Undo');
    await settle();
    assert.strictEqual((await storage.getLogs({ metricId: 'jobs' })).length, 0, 'Undo removed the entry');
    assert.deepStrictEqual(toastTexts(doc, core), ['Removed application at Hooli XYZ — Senior Data Scientist']);
    assert.strictEqual(await core.getDedupeCache().has(first.key), false, 'Undo releases the dedupe claim');

    // Applied to the same company 24 days ago: ask before logging again.
    const today = storage.getLocalDateStr();
    await storage.addLog({ metricId: 'jobs', company: 'Globex Corporation', role: 'SRE', date: storage.addDays(today, -24) });
    const doc2 = dom.installDom();
    core._resetSharedCache();
    const dup = await core.dispatch(adapter, { id: 'globex:77', title: 'Platform Engineer at Globex', company: 'Globex', role: 'Platform Engineer' }, { document: doc2, storage });
    assert.strictEqual(dup.logged, false);
    assert.strictEqual(dup.reason, 'possible-duplicate');
    assert.strictEqual(dup.prior.daysAgo, 24);
    const text = toastTexts(doc2, core)[0];
    assert.ok(/^Note: You applied to Globex Corporation 24 days ago on [A-Z][a-z]{2} \d{1,2}, \d{4}\. Log again anyway\?$/.test(text), text);
    assert.strictEqual((await storage.getLogs({ metricId: 'jobs' })).length, 1, 'nothing logged until the user answers');
    clickToastButton(doc2, core, 'Log anyway');
    await settle(20);
    const all = await storage.getLogs({ metricId: 'jobs' });
    assert.strictEqual(all.length, 2, 'Log anyway logs it');
    assert.strictEqual(all[0].company, 'Globex');

    // Skip leaves storage alone.
    const doc3 = dom.installDom();
    core._resetSharedCache();
    const skipped = await core.dispatch(adapter, { id: 'globex:78', title: 'x', company: 'GLOBEX corp' }, { document: doc3, storage });
    assert.strictEqual(skipped.reason, 'possible-duplicate');
    clickToastButton(doc3, core, 'Skip');
    await settle();
    assert.strictEqual((await storage.getLogs({ metricId: 'jobs' })).length, 2);
    assert.strictEqual(toastTexts(doc3, core).length, 0, 'Skip dismisses the prompt');

    const EMOJI = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u;
    assert.ok(!EMOJI.test(text + toastButtons(doc2, core).map(b => b.textContent).join('')), 'toast text is emoji-free');
    uninstallMockChrome();
    console.log('[PASS] Job toasts: inline Edit details and Undo; 90-day duplicate prompt with Log anyway and Skip');
  }

  // -------------------------------------------------------------------------
  // 14. "Log application from this page" card
  // -------------------------------------------------------------------------
  {
    installMockChrome();
    const core = fresh('shared/auto-tracker-core.js');
    global.AutoTrackerCore = core;
    loadJobMeta();
    const storage = fresh('shared/storage.js');
    // An https: page would route storage through the service worker; the
    // proxy has its own suite (test/pipeline.test.js), so stay local here.
    storage._setMode('local');
    global.TrackerStorage = storage;
    const doc = jobPage({
      meta: [['og:site_name', 'Pied Piper'], ['og:title', 'Compression Engineer - Pied Piper']],
      body: [d => dom.el(d, 'h1', { text: 'Compression Engineer' })]
    });
    global.document = doc;
    global.location = new URL('https://careers.piedpiper.com/jobs/42');
    global.window = {};

    fresh('content/quick-log.js');
    await settle(80);
    assert.deepStrictEqual(toastTexts(doc, core), ['Log application from this page']);
    const host = doc.getElementById(core.TOAST_HOST_ID)._shadow;
    const inputs = host.querySelectorAll('input');
    assert.deepStrictEqual(inputs.map(i => i.value), ['Pied Piper', 'Compression Engineer'], 'company and role are pre-filled from the page');
    const form = host.querySelector('form');
    inputs[1].value = 'Senior Compression Engineer';
    form.dispatchEvent({ type: 'submit', target: form, preventDefault() {} });
    await settle(80);
    const logs = await storage.getLogs({ metricId: 'jobs' });
    assert.strictEqual(logs.length, 1);
    assert.deepStrictEqual([logs[0].company, logs[0].role, logs[0].source, logs[0].url], ['Pied Piper', 'Senior Compression Engineer', 'quick', 'https://careers.piedpiper.com/jobs/42']);
    assert.deepStrictEqual(toastTexts(doc, core), ['Logged application at Pied Piper — Senior Compression Engineer']);
    assert.strictEqual(typeof global.window.__ptQuickLog, 'function', 'later clicks reuse the injected script');

    // A second run on the same company warns first.
    global.window.__ptQuickLog();
    await settle(80);
    const texts = host.querySelectorAll('.detail').map(d => d.textContent);
    assert.ok(texts.some(t => /^Note: You already logged this Pied Piper listing earlier today on /.test(t)), texts.join(' / '));
    assert.ok(host.querySelectorAll('button').some(b => b.textContent === 'Log anyway'));

    delete global.document;
    delete global.location;
    delete global.window;
    delete global.TrackerStorage;
    delete global.AutoTrackerCore;
    delete global.JobMeta;
    uninstallMockChrome();
    console.log('[PASS] Quick log: pre-filled card, editable fields, duplicate note on a repeat, reusable entry point');
  }

  console.log('--- test/autotracker.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
