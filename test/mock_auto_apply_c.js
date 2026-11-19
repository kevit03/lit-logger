// Mocks for the auto-apply driver suite (agent C).
//
// Builds on test/mock_dom.js and test/mock_autofill_4.js (its HTML parser and
// selector engine) without modifying them. `page()` sets up one frame: a
// parsed fixture with every element given a layout box, a location object,
// tab-scoped sessionStorage, a stubbed window.__litAutofillUI whose fill()
// runs a caller-supplied plan, the real AutofillCore for scanning, and a fake
// background that answers LIT_BATCH_HELLO / LIT_BATCH_UPDATE with the
// contract's transition rules, and (v2) LIT_COMPOSE_ANSWER / LIT_BATCH_CAPS
// through caller-supplied handlers. The real shared/discretion.js is loaded
// as the LitDiscretion global; site adapters registered by other suites are
// set aside for each page and restored at cleanup.
const fs = require('fs');
const path = require('path');
const dom = require('./mock_dom');
const af = require('./mock_autofill_4');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = path.join(ROOT, 'content', 'autofill', 'auto-apply.js');
const AA_FIXTURES = path.join(__dirname, 'fixtures', 'auto-apply');
const CORE = require('../shared/autofill-core.js');
const DISCRETION = require('../shared/discretion.js');
const SAVED_ADAPTERS = CORE.listSiteAdapters();

function readFixture(name) {
  const dir = fs.existsSync(path.join(AA_FIXTURES, name)) ? AA_FIXTURES : af.FIXTURES;
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

// Every element gets a 100x20 box on screen, except under data-test-offscreen
// (parked above the viewport, the way reCAPTCHA hides its challenge).
function layout(root) {
  const nodes = root.documentElement ? [root.documentElement].concat(Array.from(root.documentElement.walk())) : [root].concat(Array.from(root.walk()));
  for (const n of nodes) {
    n.offsetWidth = 100;
    n.offsetHeight = 20;
    let off = false;
    try { off = !!n.closest('[data-test-offscreen]'); } catch (e) { off = false; }
    n.rectTop = off ? -10000 : 10;
  }
}

// Replaces the body's content with a fixture, the way a navigation or an
// in-place re-render would, and notifies observers.
function replaceBody(doc, markup) {
  doc.body.children.slice().forEach(c => doc.body.removeChild(c));
  af.parseInto(doc, doc.body, markup);
  layout(doc);
  dom.emitAdded(doc.body.children);
}

function mount(doc, parent, markup) {
  const node = af.html(doc, markup);
  parent.appendChild(node);
  layout(doc);
  dom.emitAdded(node);
  return node;
}

function makeSession(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    map,
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); }
  };
}

const ALLOWED = {
  opening: ['filling'],
  filling: ['submitting', 'submitted', 'ready', 'needs-you', 'failed'],
  submitting: ['submitted', 'ready', 'needs-you', 'failed']
};

// A background with one job in `status`. job: null -> not a batch tab.
function fakeBackground(opts = {}) {
  const bg = {
    job: opts.job === null ? null : Object.assign({ jobId: 'job1', title: 'Software Engineer', company: 'Example Co', url: opts.url || '', status: 'opening' }, opts.job || {}),
    mode: opts.mode || 'submit',
    refuseClaim: !!opts.refuseClaim,
    messages: [],
    updates: [],
    composeRequests: [],
    inFlight: 0,
    maxInFlight: 0,
    handle(msg) {
      bg.messages.push(msg);
      if (msg.type === 'LIT_BATCH_HELLO') {
        return bg.job ? { job: Object.assign({}, bg.job), mode: bg.mode } : { job: null };
      }
      if (msg.type === 'LIT_BATCH_UPDATE') {
        bg.updates.push(msg);
        if (!bg.job) return { ok: false };
        if (msg.status === 'filling' && bg.refuseClaim) return { ok: false };
        const next = ALLOWED[bg.job.status] || [];
        if (!next.includes(msg.status)) return { ok: false };
        bg.job.status = msg.status;
        return { ok: true };
      }
      if (msg.type === 'LIT_COMPOSE_ANSWER') {
        bg.composeRequests.push(msg);
        if (typeof opts.compose !== 'function') return undefined;
        bg.inFlight++;
        bg.maxInFlight = Math.max(bg.maxInFlight, bg.inFlight);
        return Promise.resolve(opts.compose(msg)).then(res => { bg.inFlight--; return res; }, () => { bg.inFlight--; return undefined; });
      }
      if (msg.type === 'LIT_BATCH_CAPS') return opts.caps;
      return undefined;
    },
    statuses: () => bg.updates.map(u => u.status)
  };
  return bg;
}

function installChrome(bg, opts = {}) {
  const chrome = {
    runtime: {
      id: 'lit-test',
      lastError: null,
      sendMessage(msg, cb) {
        if (opts.invalidated) throw new Error('Extension context invalidated.');
        setTimeout(() => {
          Promise.resolve(bg.handle(msg)).then(res => {
            chrome.runtime.lastError = null;
            if (typeof cb === 'function') cb(res);
          });
        }, 0);
      }
    }
  };
  global.chrome = chrome;
  return chrome;
}

// Stub of window.__litAutofillUI: formSize() counts what the real core scans
// (capped like the real one), fill() runs `plan(doc, pass)` and returns a
// Report with that many entries.
function stubUi(doc, plan) {
  const ui = {
    fills: 0,
    formSize() { return Math.min(3, CORE.scanFields(doc, { includeFilled: true }).length); },
    async fill() {
      ui.fills++;
      const n = plan ? (plan(doc, ui.fills) || 0) : 0;
      return { filled: Array.from({ length: n }, () => ({ desc: {}, match: {} })), skipped: [], unmatched: [] };
    }
  };
  return ui;
}

function setValue(doc, id, value) {
  const el = doc.getElementById(id);
  el.value = value;
  return el;
}

function attachFile(doc, id, name) {
  const el = doc.getElementById(id);
  el.files = [{ name: name || 'resume.pdf' }];
  return el;
}

// react-select committed value, the node core.isFilled looks for.
function pickReactSelect(doc, inputId, text) {
  const input = doc.getElementById(inputId);
  const values = input.closest('.select__value-container');
  const ph = values.querySelector('.select__placeholder');
  if (ph) ph.remove();
  const chip = af.html(doc, '<div class="select__single-value">' + text + '</div>');
  // The core reads text through childNodes when a node has them; the parser
  // keeps text in ownText, so give the chip a real text node.
  chip.childNodes = [{ nodeType: 3, nodeValue: String(text) }];
  values.appendChild(chip);
}

function counter(el, type = 'click') {
  const c = { n: 0 };
  el.addEventListener(type, () => { c.n++; });
  return c;
}

// One frame with the driver loaded. Returns everything a test inspects.
function page(opts = {}) {
  dom.installDom();
  const doc = new af.AfDocument();
  if (opts.fixture) af.parseInto(doc, doc.body, readFixture(opts.fixture));
  else if (opts.html) af.parseInto(doc, doc.body, opts.html);
  if (opts.prepare) opts.prepare(doc);
  layout(doc);

  const location = new URL(opts.url || 'https://job-boards.greenhouse.io/embed/job_app?for=example&token=1');
  const assigned = [];
  location.assign = u => { assigned.push(String(u)); };
  const session = opts.session || makeSession();
  const winListeners = [];
  const win = {
    location,
    sessionStorage: session,
    addEventListener: (t) => { winListeners.push(t); },
    removeEventListener: () => {}
  };
  const bg = opts.bg || fakeBackground({ url: location.href });
  const ui = opts.noUi ? null : stubUi(doc, opts.plan);
  if (ui) win.__litAutofillUI = ui;

  global.window = win;
  global.document = doc;
  global.location = location;
  global.AutofillCore = CORE;
  if (opts.noDiscretion) delete global.LitDiscretion;
  else global.LitDiscretion = DISCRETION;
  if (opts.profile) global.AutofillStore = { getProfile: async () => opts.profile };
  else delete global.AutofillStore;
  CORE._resetSiteAdapters();
  (opts.adapters || []).forEach(a => CORE.registerSiteAdapter(a));
  if (opts.noChrome) delete global.chrome;
  else installChrome(bg, { invalidated: opts.invalidated });

  delete require.cache[require.resolve(DRIVER)];
  const api = require(DRIVER);
  if (opts.timing !== false) Object.assign(api.timing, FAST, opts.timing || {});
  return { doc, api, bg, ui, win, location, assigned, session, winListeners };
}

const FAST = { formWait: 400, applyGrace: 40, refillDelay: 10, settle: 5, successWait: 400, errorGrace: 30, poll: 10, throttle: 5, composeBudget: 300 };

function cleanup() {
  delete global.window;
  delete global.document;
  delete global.location;
  delete global.chrome;
  delete global.AutofillCore;
  delete global.LitDiscretion;
  delete global.AutofillStore;
  CORE._resetSiteAdapters();
  SAVED_ADAPTERS.forEach(a => CORE.registerSiteAdapter(a));
  delete require.cache[require.resolve(DRIVER)];
}

module.exports = {
  DRIVER,
  CORE,
  FAST,
  readFixture,
  layout,
  replaceBody,
  mount,
  makeSession,
  fakeBackground,
  installChrome,
  stubUi,
  setValue,
  attachFile,
  pickReactSelect,
  counter,
  page,
  cleanup
};
