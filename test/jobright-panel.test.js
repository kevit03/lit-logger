// Jobright Auto-apply panel tests: the host classifier, mapping Jobright's
// list API, the list URL, preselection, count and mode prefs, the Start
// message, fetch error states, the live batch view and its Focus / Stop /
// Clear messages, the /jobs route gate, shadow DOM isolation, teardown when
// the extension context is gone, and no emoji in anything it renders.
//
// The sample payload below is hand-written; every name and id is made up.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const dom = require('./mock_dom');

const ROOT = path.resolve(__dirname, '..');
const PANEL_FILE = path.join(ROOT, 'content/jobright/jobright-panel.js');
const HOST_ID = 'lit-jobright-host';
const EMOJI_REGEX = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u;

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await tick();
}

function hex(n) {
  return n.toString(16).padStart(24, '0');
}

function item(id, title, company, applyLink, originalUrl) {
  return {
    jobResult: { jobId: id, jobTitle: title, applyLink, originalUrl, jobLocation: 'Remote', isCompanySiteLink: false },
    companyResult: { companyName: company }
  };
}

const IDS = {
  gh: hex(1), ashby: hex(2), lever: hex(3), rippling: hex(4), dice: hex(5),
  site: hex(6), workday: hex(7), applied: hex(8), fallback: hex(9)
};

function samplePayload() {
  return {
    success: true,
    errorCode: 0,
    errorMsg: null,
    result: {
      impId: 'imp-sample',
      jobList: [
        item(IDS.gh, 'Software Engineer, Platform', 'Northwind Labs',
          'https://job-boards.greenhouse.io/embed/job_app?for=northwind&token=4001&jr_id=' + IDS.gh, 'https://northwind.example/careers'),
        item(IDS.ashby, '  Backend   Engineer ', 'Contoso Data',
          'https://jobs.ashbyhq.com/contoso/0b1e2c3d-0000-4000-8000-000000000001/application?jr_id=' + IDS.ashby, ''),
        item(IDS.lever, 'Full Stack Engineer', 'Fabrikam', 'https://jobs.lever.co/fabrikam/abc-123', ''),
        item(IDS.rippling, 'Data Engineer', 'Tailspin', 'https://ats.rippling.com/tailspin/jobs/77', ''),
        item(IDS.dice, 'Java Developer', 'Staffing Partner', 'https://www.dice.com/job-detail/0000-1111', ''),
        item(IDS.site, 'Frontend Engineer', 'Litware', 'https://careers.litware.example/jobs/9', ''),
        item(IDS.workday, 'Systems Engineer', 'Adventure Works', 'https://adventure.wd5.myworkdayjobs.com/en-US/careers/job/123', ''),
        item(IDS.applied, 'Platform Engineer', 'Northwind Labs',
          'https://job-boards.greenhouse.io/embed/job_app?for=northwind&token=4002', ''),
        // Not an http link: fall back to originalUrl.
        item(IDS.fallback, 'Infrastructure Engineer', 'Proseware', 'javascript:void(0)',
          'https://jobs.ashbyhq.com/proseware/0b1e2c3d-0000-4000-8000-000000000002'),
        // No usable link at all: dropped.
        item(hex(10), 'Ghost Role', 'Nowhere', '', ''),
        // Same id twice: kept once.
        item(IDS.gh, 'Software Engineer, Platform', 'Northwind Labs', 'https://job-boards.greenhouse.io/embed/job_app?for=northwind&token=4001', ''),
        null,
        { jobResult: { jobTitle: 'No id' }, companyResult: {} }
      ]
    }
  };
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function jsonFetch(payload) {
  const fn = async (url, init) => { fn.calls.push({ url, init }); return response(200, JSON.stringify(payload)); };
  fn.calls = [];
  return fn;
}

function createWindow() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(l => l !== fn);
      if (!listeners[type].length) delete listeners[type];
    },
    listenerCount() { return Object.values(listeners).reduce((n, l) => n + l.length, 0); }
  };
}

function load() {
  delete require.cache[require.resolve(PANEL_FILE)];
  return require(PANEL_FILE);
}

// A Jobright page with the panel loaded. `respond(msg)` answers runtime
// messages the way the background would; omit it for "no receiver".
async function page(options = {}) {
  const doc = dom.installDom();
  const chrome = installMockChrome(options.store || {});
  const win = createWindow();
  win.fetch = options.fetch || jsonFetch(samplePayload());
  const entries = options.entries || [];
  win.performance = { getEntriesByType: type => (type === 'resource' ? entries : []) };
  global.document = doc;
  global.window = win;
  global.location = new URL(options.url || 'https://jobright.ai/jobs/recommend');
  const received = [];
  if (options.respond) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      received.push(msg);
      const out = options.respond(msg, chrome);
      Promise.resolve(out).then(sendResponse);
      return true;
    });
  }
  const api = load();
  await settle();
  return { doc, win, chrome, api, received };
}

function cleanup(ctx) {
  if (ctx && ctx.api && typeof ctx.api.destroy === 'function') ctx.api.destroy();
  delete global.document;
  delete global.window;
  delete global.location;
  uninstallMockChrome();
  dom.FakeMutationObserver.reset();
}

async function withPage(options, fn) {
  const ctx = await page(options);
  try {
    await fn(ctx);
  } finally {
    cleanup(ctx);
  }
}

function hostEl(doc) {
  return doc.getElementById(HOST_ID);
}

function shadow(doc) {
  const host = hostEl(doc);
  return host ? host._shadow : null;
}

function q(doc, sel) {
  return shadow(doc).querySelector(sel);
}

function qa(doc, sel) {
  return shadow(doc).querySelectorAll(sel);
}

function isHidden(node) {
  let n = node;
  while (n && n.classList) { if (n.classList.contains('hidden')) return true; n = n.parentElement; }
  return false;
}

async function click(node) {
  assert.ok(node, 'element to click exists');
  node.dispatchEvent(dom.makeEvent('click', node));
  await settle();
}

async function toggle(input, checked) {
  input.checked = checked;
  input.dispatchEvent(dom.makeEvent('change', input));
  await settle();
}

function row(doc, jobId) {
  return q(doc, '[data-job-id="' + jobId + '"]');
}

function batchJob(jobId, status, extra = {}) {
  return Object.assign({
    jobId, title: 'Role ' + jobId.slice(-2), company: 'Company ' + jobId.slice(-2),
    url: 'https://jobs.ashbyhq.com/x/' + jobId, host: 'jobs.ashbyhq.com',
    status, tabId: null, frameId: null, startedAt: null, updatedAt: 1, reason: '', filled: 0, missing: []
  }, extra);
}

function batch(status, jobs) {
  return { id: 'b1', status, mode: 'submit', concurrency: 5, windowId: 9, startedAt: 1, updatedAt: 2, jobs };
}

// --- tests -------------------------------------------------------------------
async function testClassifier() {
  const { classifyHost } = await withLoaded();
  const table = {
    'boards.greenhouse.io': 'supported',
    'job-boards.greenhouse.io': 'supported',
    'boards.eu.greenhouse.io': 'supported',
    'job-boards.eu.greenhouse.io': 'supported',
    'jobs.ashbyhq.com': 'supported',
    'jobs.lever.co': 'supported',
    'jobs.eu.lever.co': 'supported',
    'JOBS.LEVER.CO': 'supported',
    'apply.workable.com': 'generic',
    'acme.bamboohr.com': 'generic',
    'ats.rippling.com': 'generic',
    'acme.rippling-ats.com': 'generic',
    'jobs.smartrecruiters.com': 'generic',
    'jobs.jobvite.com': 'generic',
    'acme.applytojob.com': 'generic',
    'acme.breezy.hr': 'generic',
    'acme.recruitee.com': 'generic',
    'acme.pinpointhq.com': 'generic',
    'acme.teamtailor.com': 'generic',
    'acme.jobs.personio.de': 'generic',
    'acme.eightfold.ai': 'generic',
    'jobs.gem.com': 'generic',
    'acme.avature.net': 'generic',
    'recruiting.ultipro.com': 'generic',
    'recruiting.paylocity.com': 'generic',
    'workforcenow.adp.com': 'generic',
    'acme.dayforcehcm.com': 'generic',
    'acme.csod.com': 'generic',
    'acme.wd5.myworkdayjobs.com': 'signin',
    'wd3.myworkdaysite.com': 'signin',
    'careers-acme.icims.com': 'signin',
    'acme.taleo.net': 'signin',
    'acme.fa.us2.oraclecloud.com': 'signin',
    'career4.successfactors.com': 'signin',
    'career2.successfactors.eu': 'signin',
    'greenhouse.io': 'unsupported',
    'evilgreenhouse.io': 'unsupported',
    'boards.greenhouse.io.evil.com': 'unsupported',
    'notworkable.com': 'unsupported',
    'gem.com': 'unsupported',
    'www.dice.com': 'unsupported',
    'linkedin.com': 'unsupported',
    '': 'unsupported'
  };
  Object.entries(table).forEach(([host, want]) => {
    assert.strictEqual(classifyHost(host), want, host + ' -> ' + want);
  });
  assert.strictEqual(classifyHost(undefined), 'unsupported');
  console.log('[PASS] host classifier table (' + Object.keys(table).length + ' hosts)');
}

// The pure seams (classifier, mapping, summary) keep working after teardown.
async function withLoaded() {
  const ctx = await page({ url: 'https://jobright.ai/' });
  cleanup(ctx);
  return ctx.api;
}

async function testMapJobs() {
  const { mapJobs } = await withLoaded();
  const jobs = mapJobs(samplePayload());
  assert.strictEqual(jobs.length, 9, 'drops no-link, duplicate, null, and id-less items');
  assert.deepStrictEqual(jobs[0], {
    jobId: IDS.gh,
    title: 'Software Engineer, Platform',
    company: 'Northwind Labs',
    url: 'https://job-boards.greenhouse.io/embed/job_app?for=northwind&token=4001&jr_id=' + IDS.gh,
    host: 'job-boards.greenhouse.io'
  }, 'applyLink wins over originalUrl');
  assert.strictEqual(jobs[1].title, 'Backend Engineer', 'whitespace collapsed');
  const fb = jobs.find(j => j.jobId === IDS.fallback);
  assert.strictEqual(fb.url, 'https://jobs.ashbyhq.com/proseware/0b1e2c3d-0000-4000-8000-000000000002', 'non-http applyLink falls back');
  assert.strictEqual(fb.host, 'jobs.ashbyhq.com');
  assert.ok(!jobs.some(j => j.jobId === hex(10)), 'no-link job dropped');
  assert.deepStrictEqual(mapJobs(null), []);
  assert.deepStrictEqual(mapJobs({ success: true, result: {} }), []);
  assert.deepStrictEqual(mapJobs({ success: true, result: { jobList: 'nope' } }), []);
  console.log('[PASS] mapJobs maps, falls back, dedupes, and drops unusable items');
}

async function testListUrl() {
  await withPage({}, async ({ api }) => {
    const u = new URL(api.listUrl(0, 20));
    assert.strictEqual(u.origin, 'https://jobright.ai');
    assert.strictEqual(u.pathname, '/swan/recommend/list/jobs');
    assert.strictEqual(u.searchParams.get('refresh'), 'false');
    assert.strictEqual(u.searchParams.get('sortCondition'), '0');
    assert.strictEqual(u.searchParams.get('position'), '0');
    assert.strictEqual(u.searchParams.get('count'), '20');
    assert.strictEqual(u.searchParams.get('syncRerank'), 'false');
    assert.strictEqual(new URL(api.listUrl(40, 20)).searchParams.get('position'), '40');
  });
  const entries = [
    { name: 'https://jobright.ai/swan/other/thing?x=1' },
    { name: 'https://jobright.ai/swan/recommend/list/jobs?refresh=true&sortCondition=2&position=0&count=10&syncRerank=true&extra=keep' },
    { name: 'https://cdn.example/static.js' }
  ];
  await withPage({ entries }, async ({ api }) => {
    const u = new URL(api.listUrl(10, 10));
    assert.strictEqual(u.searchParams.get('sortCondition'), '2', 'reuses the page request');
    assert.strictEqual(u.searchParams.get('extra'), 'keep');
    assert.strictEqual(u.searchParams.get('syncRerank'), 'true');
    assert.strictEqual(u.searchParams.get('refresh'), 'false', 'never asks for a fresh set');
    assert.strictEqual(u.searchParams.get('position'), '10');
  });
  await withPage({ entries: [{ name: 'https://evil.example/swan/recommend/list/jobs?count=20' }] }, async ({ api }) => {
    assert.strictEqual(new URL(api.listUrl(0, 20)).origin, 'https://jobright.ai', 'always same origin');
  });
  console.log('[PASS] listUrl reuses the page request, forces same origin and refresh=false');
}

async function testOpenAndPreselect() {
  const store = { lit_batch_done: { [IDS.applied]: 1700000000000 } };
  const entries = [{ name: 'https://jobright.ai/swan/recommend/list/jobs?refresh=false&sortCondition=0&position=0&count=20&syncRerank=false' }];
  const open7 = [IDS.gh, IDS.ashby, IDS.lever, IDS.rippling, IDS.dice, IDS.site, IDS.fallback].sort();
  await withPage({ store, entries }, async ({ doc, win, api }) => {
    assert.ok(api.state().launcherShown);
    assert.ok(isHidden(q(doc, '.panel')), 'panel starts closed');
    await click(q(doc, '.launcher'));
    await settle();
    assert.ok(!isHidden(q(doc, '.panel')), 'launcher opens the panel');
    assert.strictEqual(win.fetch.calls.length, 1);
    assert.strictEqual(win.fetch.calls[0].init.credentials, 'include');
    assert.ok(win.fetch.calls[0].url.startsWith('https://jobright.ai/swan/recommend/list/jobs?'));

    const s = api.state();
    assert.strictEqual(s.jobs.length, 8, 'the job LIT already submitted is left out');
    assert.strictEqual(row(doc, IDS.applied), null, 'no row for a submitted job');
    assert.deepStrictEqual(s.selected.sort(), open7, 'everything but sign-in walls');
    const kinds = Object.fromEntries(s.jobs.map(j => [j.jobId, j.kind]));
    assert.strictEqual(kinds[IDS.rippling], 'generic');
    assert.strictEqual(kinds[IDS.workday], 'signin');
    assert.strictEqual(kinds[IDS.dice], 'unsupported');

    const tag = id => row(doc, id).querySelector('.tag').textContent;
    assert.strictEqual(tag(IDS.gh), 'Supported');
    assert.strictEqual(tag(IDS.rippling), 'Generic form');
    assert.strictEqual(tag(IDS.workday), 'Sign-in needed');
    assert.strictEqual(tag(IDS.site), 'Company site');
    assert.strictEqual(row(doc, IDS.workday).querySelector('.check').checked, false);
    assert.strictEqual(row(doc, IDS.gh).querySelector('.check').checked, true);
    assert.strictEqual(q(doc, '.start').textContent, 'Apply to 7');
    assert.strictEqual(q(doc, '.sub').textContent, '7 of 8 selected');

    assert.strictEqual(q(doc, '.select-all').textContent, 'Clear selection');
    await click(q(doc, '.select-all'));
    assert.strictEqual(api.state().selected.length, 0);
    assert.strictEqual(q(doc, '.start').disabled, true, 'Start disabled with nothing selected');
    assert.strictEqual(q(doc, '.select-all').textContent, 'Select all');
    await click(q(doc, '.select-all'));
    assert.deepStrictEqual(api.state().selected.sort(), open7);

    // A job finishing elsewhere drops out of the list.
    await chromeSet({ lit_batch_done: { [IDS.applied]: 1, [IDS.lever]: 2 } });
    assert.ok(!api.state().selected.includes(IDS.lever));
    assert.strictEqual(row(doc, IDS.lever), null, 'submitted job removed from the picker');
    assert.strictEqual(api.state().jobs.length, 7);

    // Escape closes.
    q(doc, '.panel').dispatchEvent(dom.makeEvent('keydown', q(doc, '.panel'), { key: 'Escape' }));
    assert.ok(isHidden(q(doc, '.panel')));
  });
  console.log('[PASS] open loads jobs; all but sign-in preselected, submitted jobs hidden');
}

// Jobright drops a job from its list once you apply; the panel must not keep
// showing a copy from an earlier open.
async function testFreshOnOpen() {
  const full = samplePayload();
  const later = samplePayload();
  later.result.jobList = later.result.jobList.filter(x => !(x && x.jobResult && [IDS.gh, IDS.ashby].includes(x.jobResult.jobId)));
  let payload = full;
  const fetchFn = async (url, init) => { fetchFn.calls.push(url); return response(200, JSON.stringify(payload)); };
  fetchFn.calls = [];
  await withPage({ fetch: fetchFn }, async ({ doc, api }) => {
    await api.open();
    assert.strictEqual(api.state().jobs.length, 9);
    await toggle(row(doc, IDS.lever).querySelector('.check'), false);
    await click(q(doc, '.launcher'));
    assert.ok(isHidden(q(doc, '.panel')));

    // Applied to two jobs on Jobright in the meantime.
    payload = later;
    await click(q(doc, '.launcher'));
    await settle();
    assert.strictEqual(fetchFn.calls.length, 2, 'reopening fetches again');
    assert.strictEqual(new URL(fetchFn.calls[1]).searchParams.get('position'), '0', 'from the top');
    const ids = api.state().jobs.map(j => j.jobId);
    assert.ok(!ids.includes(IDS.gh) && !ids.includes(IDS.ashby), 'jobs gone from Jobright are gone here');
    assert.strictEqual(ids.length, 7);
    assert.strictEqual(row(doc, IDS.lever).querySelector('.check').checked, false, 'user unchecks are kept');
    assert.ok(!api.state().selected.includes(IDS.gh), 'gone jobs are not sent');

    // Hidden or deleted postings are not listed either.
    const { mapJobs } = { mapJobs: api.mapJobs };
    const hidden = item(hex(70), 'Hidden', 'X', 'https://jobs.lever.co/x/1', '');
    hidden.jobResult.hiddenJob = true;
    const deleted = item(hex(71), 'Deleted', 'Y', 'https://jobs.lever.co/y/1', '');
    deleted.jobResult.isDeleted = true;
    assert.deepStrictEqual(mapJobs({ result: { jobList: [hidden, deleted] } }), []);
  });

  // A response from before a reload never lands on top of the new list.
  let release;
  const slow = async url => {
    slow.calls.push(url);
    if (slow.calls.length === 1) await new Promise(r => { release = r; });
    return response(200, JSON.stringify(slow.calls.length === 1 ? full : later));
  };
  slow.calls = [];
  await withPage({ fetch: slow }, async ({ doc, api }) => {
    const first = api.open();
    await settle();
    await click(q(doc, '.launcher'));
    await click(q(doc, '.launcher'));
    await settle();
    release();
    await first;
    await settle();
    assert.strictEqual(api.state().jobs.length, 7, 'stale first response dropped');
    assert.strictEqual(api.state().loading, false);
  });
  console.log('[PASS] reopening refetches from the top; stale responses and hidden postings dropped');
}

async function chromeSet(items) {
  await global.chrome.storage.local.set(items);
  await settle();
}

async function testLoadMore() {
  const payload = samplePayload();
  const pages = [payload, { success: true, result: { jobList: [item(hex(30), 'Late Role', 'Woodgrove', 'https://jobs.lever.co/woodgrove/1', '')] } }];
  const fetchFn = async (url, init) => { fetchFn.calls.push(url); return response(200, JSON.stringify(pages[fetchFn.calls.length - 1])); };
  fetchFn.calls = [];
  // The page asked for 10; the first response has 13 raw items (9 usable),
  // so it counts as full and paging continues at position 10.
  const entries = [{ name: 'https://jobright.ai/swan/recommend/list/jobs?refresh=false&sortCondition=0&position=0&count=10&syncRerank=false' }];
  await withPage({ fetch: fetchFn, entries }, async ({ doc, api }) => {
    await api.open();
    assert.strictEqual(new URL(fetchFn.calls[0]).searchParams.get('count'), '10', 'page size from the page request');
    assert.ok(q(doc, '.load-more'), 'Load more shown after a full page');
    await click(q(doc, '.load-more'));
    await settle();
    assert.strictEqual(new URL(fetchFn.calls[1]).searchParams.get('position'), '10');
    assert.strictEqual(api.state().jobs.length, 10);
    assert.ok(api.state().selected.includes(hex(30)), 'new supported job preselected');
    assert.strictEqual(api.state().exhausted, true);
    assert.strictEqual(q(doc, '.load-more'), null, 'no Load more once the list runs out');
  });
  console.log('[PASS] Load more fetches the next position and stops at the end');
}

async function testPrefs() {
  const { clampCount } = await withLoaded();
  assert.strictEqual(clampCount(1), 5);
  assert.strictEqual(clampCount(5), 5);
  assert.strictEqual(clampCount(7.4), 7);
  assert.strictEqual(clampCount(11), 10);
  assert.strictEqual(clampCount('x'), 5);

  await withPage({ store: { lit_batch_prefs: { concurrency: 42, mode: 'fill-only' } } }, async ({ doc, chrome, api }) => {
    await api.open();
    assert.deepStrictEqual(api.state().prefs, { concurrency: 10, mode: 'fill-only' }, 'stored prefs clamped');
    assert.strictEqual(q(doc, '[data-count="10"]').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(qa(doc, '.seg button').length, 6, 'offers 5..10');
    assert.strictEqual(q(doc, '.switch').checked, false, 'fill-only means the switch is off');
    assert.strictEqual(q(doc, '.start').textContent, 'Fill 8', 'nothing applied yet: all but the sign-in wall');

    await click(q(doc, '[data-count="7"]'));
    assert.deepStrictEqual(chrome.storage.local.store.lit_batch_prefs, { concurrency: 7, mode: 'fill-only' });
    assert.strictEqual(q(doc, '[data-count="7"]').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(q(doc, '[data-count="10"]').getAttribute('aria-pressed'), 'false');

    await toggle(q(doc, '.switch'), true);
    assert.deepStrictEqual(chrome.storage.local.store.lit_batch_prefs, { concurrency: 7, mode: 'submit' });
    assert.strictEqual(q(doc, '.start').textContent, 'Apply to 8');
  });
  await withPage({}, async ({ api }) => {
    assert.deepStrictEqual(api.state().prefs, { concurrency: 5, mode: 'submit' }, 'defaults');
  });
  console.log('[PASS] count clamps to 5..10, count and mode persist to lit_batch_prefs');
}

async function testStart() {
  const respond = msg => (msg.type === 'LIT_BATCH_START' ? { ok: true } : { ok: true });
  await withPage({ respond, store: { lit_batch_prefs: { concurrency: 8, mode: 'submit' } } }, async ({ doc, api, received }) => {
    await api.open();
    await toggle(row(doc, IDS.workday).querySelector('.check'), true);
    await click(q(doc, '.start'));
    await settle();
    const starts = received.filter(m => m.type === 'LIT_BATCH_START');
    assert.strictEqual(starts.length, 1);
    const msg = starts[0];
    assert.deepStrictEqual(Object.keys(msg).sort(), ['concurrency', 'jobs', 'mode', 'type']);
    assert.strictEqual(msg.type, 'LIT_BATCH_START');
    assert.strictEqual(msg.concurrency, 8);
    assert.strictEqual(msg.mode, 'submit');
    assert.deepStrictEqual(msg.jobs.map(j => j.jobId), [IDS.gh, IDS.ashby, IDS.lever, IDS.rippling, IDS.dice, IDS.site, IDS.workday, IDS.applied, IDS.fallback], 'list order');
    msg.jobs.forEach(j => assert.deepStrictEqual(Object.keys(j).sort(), ['company', 'jobId', 'title', 'url']));
    assert.deepStrictEqual(msg.jobs[0], {
      jobId: IDS.gh, title: 'Software Engineer, Platform', company: 'Northwind Labs',
      url: 'https://job-boards.greenhouse.io/embed/job_app?for=northwind&token=4001&jr_id=' + IDS.gh
    });
    assert.strictEqual(api.state().startError, '');
  });

  const refuse = () => ({ ok: false, error: 'A batch is already running.' });
  await withPage({ respond: refuse }, async ({ doc, api }) => {
    await api.open();
    await click(q(doc, '.start'));
    await settle();
    assert.strictEqual(q(doc, '.start-error').textContent, 'A batch is already running.');
    assert.strictEqual(q(doc, '.start').disabled, false, 'can try again');
  });

  await withPage({}, async ({ doc, api }) => {
    await api.open();
    await click(q(doc, '.start'));
    await settle();
    assert.strictEqual(q(doc, '.start-error').textContent, 'LIT did not respond. Try again.', 'no receiver');
  });
  console.log('[PASS] Start sends LIT_BATCH_START with the contract shape; errors show inline');
}

async function testFetchErrors() {
  const cases = [
    { name: '401', fetch: async () => response(401, ''), want: 'Sign in to Jobright to load your jobs.' },
    { name: 'html', fetch: async () => response(200, '<!doctype html><title>Sign in</title>'), want: 'Could not read the job list. Are you signed in to Jobright?' },
    { name: 'success false', fetch: async () => response(200, JSON.stringify({ success: false, errorCode: 10001, errorMsg: 'not login' })), want: 'Jobright could not load jobs: not login' },
    { name: '500', fetch: async () => response(500, 'oops'), want: 'Jobright returned an error (HTTP 500).' },
    { name: 'network', fetch: async () => { throw new TypeError('Failed to fetch'); }, want: 'Could not reach Jobright. Check your connection.' }
  ];
  for (const c of cases) {
    let fail = true;
    const fetchFn = async (...args) => (fail ? c.fetch(...args) : response(200, JSON.stringify(samplePayload())));
    await withPage({ fetch: fetchFn }, async ({ doc, api }) => {
      await api.open();
      assert.strictEqual(api.state().error, c.want, c.name);
      assert.strictEqual(q(doc, '.problem-text').textContent, c.want, c.name + ' shown');
      assert.strictEqual(q(doc, '.start').disabled, true);
      fail = false;
      await click(q(doc, '.retry'));
      await settle();
      assert.strictEqual(api.state().error, '', c.name + ' retry clears');
      assert.strictEqual(api.state().jobs.length, 9, c.name + ' retry loads');
      assert.strictEqual(q(doc, '.problem'), null);
    });
  }
  console.log('[PASS] fetch errors show a short message and Retry recovers');
}

async function testLiveView() {
  const respond = (msg, chrome) => {
    if (msg.type === 'LIT_BATCH_CLEAR') return chrome.storage.local.remove('lit_batch').then(() => ({ ok: true }));
    return { ok: true };
  };
  await withPage({ respond }, async ({ doc, api, received, chrome }) => {
    await api.open();
    const jobs = [
      batchJob(hex(41), 'submitted'),
      batchJob(hex(42), 'ready', { reason: 'Filled. Review and submit.' }),
      batchJob(hex(43), 'needs-you', { reason: '3 required fields need you', missing: ['Why us?'] }),
      batchJob(hex(44), 'needs-you', { reason: 'CAPTCHA' }),
      batchJob(hex(45), 'failed', { reason: 'Unexpected error' }),
      batchJob(hex(46), 'skipped', { reason: 'Tab closed' }),
      batchJob(hex(47), 'filling'),
      batchJob(hex(48), 'submitting'),
      batchJob(hex(49), 'queued')
    ];
    await chromeSet({ lit_batch: batch('running', jobs) });
    assert.strictEqual(q(doc, '.summary-text').textContent,
      '1 submitted, 1 ready, 2 need you, 1 failed, 1 skipped, 2 running, 1 queued');
    assert.ok(q(doc, '.sub').textContent.startsWith('Running'));
    assert.strictEqual(q(doc, '.badge').textContent, '6/9', 'launcher shows progress');
    assert.ok(!isHidden(q(doc, '.badge')));
    const pill = id => row(doc, id).querySelector('.pill').textContent;
    assert.strictEqual(pill(hex(41)), 'Submitted');
    assert.strictEqual(pill(hex(42)), 'Ready to submit');
    assert.strictEqual(pill(hex(43)), 'Needs you');
    assert.strictEqual(pill(hex(45)), 'Failed');
    assert.strictEqual(pill(hex(46)), 'Skipped');
    assert.strictEqual(pill(hex(47)), 'Filling');
    assert.strictEqual(pill(hex(48)), 'Submitting');
    assert.strictEqual(pill(hex(49)), 'Queued');
    assert.strictEqual(row(doc, hex(43)).querySelector('.reason').textContent, '3 required fields need you');
    assert.strictEqual(row(doc, hex(41)).querySelector('.reason'), null, 'no reason line when empty');
    const openIds = qa(doc, '.open-job').map(b => b.closest('.job').getAttribute('data-job-id')).sort();
    assert.deepStrictEqual(openIds, [hex(42), hex(43), hex(44), hex(45)], 'Open only on ready / needs-you / failed');
    assert.ok(q(doc, '.stop'));
    assert.strictEqual(q(doc, '.clear'), null, 'no Clear while running');
    assert.strictEqual(q(doc, '.start'), null, 'picker hidden while a batch exists');

    await click(row(doc, hex(43)).querySelector('.open-job'));
    assert.deepStrictEqual(received[received.length - 1], { type: 'LIT_BATCH_FOCUS', jobId: hex(43) });

    await click(q(doc, '.stop'));
    assert.deepStrictEqual(received[received.length - 1], { type: 'LIT_BATCH_STOP' });

    // A later update re-renders in place.
    jobs[6] = batchJob(hex(47), 'submitted');
    jobs[7] = batchJob(hex(48), 'needs-you', { reason: 'Submitted but no confirmation seen' });
    jobs[8] = batchJob(hex(49), 'skipped', { reason: 'Stopped' });
    await chromeSet({ lit_batch: batch('stopped', jobs) });
    assert.strictEqual(q(doc, '.summary-text').textContent, '2 submitted, 1 ready, 3 need you, 1 failed, 2 skipped');
    assert.ok(q(doc, '.sub').textContent.startsWith('Stopped'));
    assert.strictEqual(q(doc, '.stop'), null);
    assert.ok(isHidden(q(doc, '.badge')), 'no progress badge once finished');

    await click(q(doc, '.clear'));
    await settle();
    assert.deepStrictEqual(received[received.length - 1], { type: 'LIT_BATCH_CLEAR' });
    assert.strictEqual(chrome.storage.local.store.lit_batch, undefined);
    assert.strictEqual(api.state().batch, null);
    assert.ok(q(doc, '.start'), 'back to the picker after Clear');
  });

  // Errors from Stop show inline.
  await withPage({ respond: () => ({ ok: false, error: 'Nothing to stop.' }), store: { lit_batch: batch('running', [batchJob(hex(50), 'filling')]) } }, async ({ doc, api }) => {
    await api.open();
    assert.strictEqual(q(doc, '.summary-text').textContent, '1 running', 'opens straight into the live view');
    await click(q(doc, '.stop'));
    assert.strictEqual(q(doc, '.action-error').textContent, 'Nothing to stop.');
    assert.strictEqual(api.state().jobs.length, 0, 'no list fetched behind a batch');
    // Cleared from elsewhere (another tab): the picker loads its list.
    await chromeSet({ lit_batch: null });
    await settle();
    assert.strictEqual(api.state().batch, null);
    assert.strictEqual(api.state().jobs.length, 9);
    assert.ok(q(doc, '.start'));
  });
  const { summarize } = await withLoaded();
  assert.strictEqual(summarize([batchJob(hex(1), 'needs-you')]), '1 needs you');
  assert.strictEqual(summarize([]), '');
  console.log('[PASS] live view renders lit_batch with counts, pills, reasons; Focus / Stop / Clear messages');
}

async function testRoutes() {
  await withPage({ url: 'https://jobright.ai/' }, async ({ doc, api, win }) => {
    assert.ok(hostEl(doc), 'host mounted');
    assert.strictEqual(api.state().launcherShown, false, 'hidden off /jobs');
    assert.ok(isHidden(q(doc, '.launcher')));
    await api.open();
    assert.strictEqual(api.state().open, false, 'cannot open off /jobs');
    assert.strictEqual(win.fetch.calls.length, 0);

    global.location = new URL('https://jobright.ai/jobs/recommend');
    api.check();
    assert.ok(!isHidden(q(doc, '.launcher')), 'shown after an SPA route change');
    await api.open();
    assert.strictEqual(api.state().open, true);

    global.location = new URL('https://jobright.ai/profile/settings');
    win.listeners.popstate.forEach(fn => fn({ type: 'popstate' }));
    assert.ok(isHidden(q(doc, '.launcher')), 'hidden again on popstate away from /jobs');
    assert.ok(isHidden(q(doc, '.panel')), 'panel closes too');
    assert.strictEqual(api.state().open, false);

    global.location = new URL('https://jobright.ai/jobs/liked');
    api.check();
    assert.ok(!isHidden(q(doc, '.launcher')));
    assert.ok(isHidden(q(doc, '.panel')), 'does not reopen by itself');
  });
  const { isJobsRoute } = await withLoaded();
  assert.ok(isJobsRoute('/jobs'));
  assert.ok(isJobsRoute('/jobs/info/abc'));
  assert.ok(!isJobsRoute('/jobsearch'));
  assert.ok(!isJobsRoute('/'));
  console.log('[PASS] launcher shows only on /jobs routes and follows SPA navigation');
}

async function testShadowIsolation() {
  await withPage({}, async ({ doc, api }) => {
    await api.open();
    const host = hostEl(doc);
    assert.strictEqual(host.tagName, 'LIT-JOBRIGHT');
    assert.ok(/all: initial !important/.test(host.getAttribute('style')), 'host box pinned against page CSS');
    assert.strictEqual(host.shadowRoot, null, 'closed shadow root');
    assert.strictEqual(host._shadow.mode, 'closed');
    assert.strictEqual(host.children.length, 0, 'nothing in the light DOM');
    assert.strictEqual(doc.querySelector('.panel'), null);
    assert.strictEqual(doc.querySelectorAll('[data-job-id]').length, 0);
    const style = host._shadow.querySelector('style');
    assert.ok(style, 'styles live inside the shadow root');
    assert.ok(style.textContent.includes(':host { all: initial; }'));
    assert.ok(style.textContent.includes('prefers-color-scheme: dark'), 'dark mode');
    assert.ok(style.textContent.includes('max-height: min(70vh'), 'bounded height');
    assert.ok(q(doc, '.launcher').textContent.includes('Auto-apply'));
    assert.strictEqual(q(doc, '.panel').getAttribute('role'), 'dialog');

    // A second injection keeps the running copy.
    const again = load();
    assert.strictEqual(again, api);
    assert.strictEqual(doc.querySelectorAll('lit-jobright').length, 1);
  });
  console.log('[PASS] closed shadow root, inline styles, light DOM untouched, idempotent');
}

async function testInvalidated() {
  await withPage({}, async ({ doc, api, chrome, win }) => {
    await api.open();
    assert.strictEqual(chrome.storage.onChanged.listeners.size, 1);
    assert.strictEqual(win.listenerCount(), 1);
    chrome.runtime.id = undefined; // what an orphaned content script sees
    api.check();
    assert.strictEqual(hostEl(doc), null, 'UI removed');
    assert.strictEqual(win.__litJobright, undefined);
    assert.strictEqual(chrome.storage.onChanged.listeners.size, 0);
    assert.strictEqual(win.listenerCount(), 0);
  });
  await withPage({}, async ({ doc, api }) => {
    api.destroy();
    assert.strictEqual(hostEl(doc), null);
    api.destroy(); // twice is fine
  });
  console.log('[PASS] extension reload removes the UI quietly and leaves no listeners');
}

async function testNoEmoji() {
  const source = fs.readFileSync(PANEL_FILE, 'utf8');
  assert.ok(!EMOJI_REGEX.test(source), 'no emoji in the source');
  await withPage({ respond: () => ({ ok: true }) }, async ({ doc, api }) => {
    await api.open();
    assert.ok(!EMOJI_REGEX.test(shadow(doc).textContent), 'picker text');
    const all = ['queued', 'opening', 'filling', 'submitting', 'submitted', 'ready', 'needs-you', 'failed', 'skipped'];
    await chromeSet({ lit_batch: batch('running', all.map((s, i) => batchJob(hex(60 + i), s, { reason: 'Reason ' + i }))) });
    assert.ok(!EMOJI_REGEX.test(shadow(doc).textContent), 'live view text');
    all.forEach(s => assert.ok(api.statusLabel(s) && !EMOJI_REGEX.test(api.statusLabel(s))));
  });
  console.log('[PASS] no emoji in the source or anything rendered');
}

async function run() {
  console.log('--- Running test/jobright-panel.test.js ---');
  await testClassifier();
  await testMapJobs();
  await testListUrl();
  await testOpenAndPreselect();
  await testFreshOnOpen();
  await testLoadMore();
  await testPrefs();
  await testStart();
  await testFetchErrors();
  await testLiveView();
  await testRoutes();
  await testShadowIsolation();
  await testInvalidated();
  await testNoEmoji();
  console.log('--- test/jobright-panel.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
