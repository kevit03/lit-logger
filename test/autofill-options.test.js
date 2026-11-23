// Autofill profile page (options/autofill.html + options/autofill.js): loads
// the real markup and script against a small DOM stand-in and the real
// AutofillStore, then checks that the page shows stored data, saves one
// field at a time without touching the rest, and that every delete can be
// undone back to exactly what was stored.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'options/autofill.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'options/autofill.js'), 'utf8');

// ----- DOM stand-in ----------------------------------------------------------

class Node {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.doc = doc;
    this.attrs = {};
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.dataset = {};
    this.style = {};
    this.text = '';
    const el = this;
    this.classList = {
      list: () => (el.attrs.class || '').split(/\s+/).filter(Boolean),
      contains: c => el.classList.list().includes(c),
      add: c => { if (!el.classList.contains(c)) el.attrs.class = el.classList.list().concat(c).join(' '); },
      remove: c => { el.attrs.class = el.classList.list().filter(x => x !== c).join(' '); },
      toggle: (c, force) => {
        const want = force === undefined ? !el.classList.contains(c) : !!force;
        el.classList[want ? 'add' : 'remove'](c);
        return want;
      }
    };
  }

  get id() { return this.attrs.id || ''; }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = v; }
  get type() { return this.attrs.type || (this.tagName === 'TEXTAREA' ? 'textarea' : 'text'); }
  get options() { return this.children; }

  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this.children = []; this.text = String(v); }

  // A select only ever holds the value of one of its options.
  get value() {
    if (this.tagName === 'SELECT') {
      const has = this.children.some(o => o.value === this._value);
      return has ? this._value : (this.children[0] ? this.children[0].value : '');
    }
    return this._value !== undefined ? this._value : (this.attrs.value || '');
  }
  set value(v) { this._value = String(v); }

  setAttribute(n, v) {
    if (n.startsWith('data-')) this.dataset[n.slice(5)] = String(v);
    this.attrs[n] = String(v);
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  removeAttribute(n) { delete this.attrs[n]; }

  append(...nodes) {
    nodes.forEach(n => {
      if (typeof n === 'string') {
        const t = new Node('#text', this.doc);
        t.text = n;
        n = t;
      }
      n.remove();
      n.parent = this;
      this.children.push(n);
    });
  }
  replaceChildren(...nodes) {
    this.children.forEach(c => { c.parent = null; });
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
    this.parent = null;
  }
  contains(other) {
    for (let n = other; n; n = n.parent) if (n === this) return true;
    return false;
  }
  walk(fn) {
    this.children.forEach(c => { fn(c); c.walk(fn); });
  }
  find(test) {
    const out = [];
    this.walk(n => { if (test(n)) out.push(n); });
    return out;
  }
  // Rendered: attached to the document with no hidden ancestor.
  get visible() {
    for (let n = this; n; n = n.parent) {
      if (n.classList.contains('hidden')) return false;
      if (!n.parent) return n === this.doc.body;
    }
    return false;
  }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, extra) {
    const event = Object.assign({ type, target: this, preventDefault() {} }, extra);
    (this.listeners[type] || []).slice().forEach(fn => fn(event));
  }
  click() { if (!this.disabled) this.fire('click'); }
  focus() { this.doc.activeElement = this; }
  blur() {
    if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
    this.fire('blur');
  }
  reset() {
    this.find(n => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA').forEach(n => { n.value = ''; });
  }
}

// Builds the tree for the page's <body>. Enough of a parser for this one
// hand-written file: tags, quoted attributes, void and self-closed elements.
function parseBody(doc) {
  const VOID = new Set(['input', 'img', 'meta', 'link', 'br']);
  const source = HTML.slice(HTML.indexOf('<body>') + 6, HTML.indexOf('<script'));
  let parent = doc.body;
  const token = /<(\/?)([a-zA-Z0-9]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = token.exec(source))) {
    const [, closing, tag, attrs, selfClosed, text] = m;
    if (text !== undefined) {
      if (text.trim()) parent.append(text.trim());
    } else if (closing) {
      parent = parent.parent;
    } else {
      const node = new Node(tag, doc);
      (attrs.match(/[\w:-]+(?:="[^"]*")?/g) || []).forEach(pair => {
        const eq = pair.indexOf('=');
        if (eq < 0) node.setAttribute(pair, '');
        else node.setAttribute(pair.slice(0, eq), pair.slice(eq + 2, -1));
      });
      parent.append(node);
      if (!selfClosed && !VOID.has(tag.toLowerCase())) parent = node;
    }
  }
  assert.strictEqual(parent, doc.body, 'options/autofill.html has balanced tags');
}

// Loads the page over `stored` (the af_ keys in chrome.storage.local).
async function openPage(stored = {}, hash = '', syncStored = {}) {
  const mock = installMockChrome();
  Object.assign(mock.storage.local.store, JSON.parse(JSON.stringify(stored)));
  Object.assign(mock.storage.sync.store, JSON.parse(JSON.stringify(syncStored)));
  delete require.cache[require.resolve('../shared/autofill-store')];
  const store = require('../shared/autofill-store');

  const doc = {
    activeElement: null,
    visibilityState: 'visible',
    listeners: {},
    createElement: tag => new Node(tag, doc),
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    getElementById: id => doc.body.find(n => n.id === id)[0] || null,
    // The page only ever queries by a single [attribute] or [attribute="value"].
    querySelectorAll(selector) {
      const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      assert.ok(m, 'unsupported selector in test DOM: ' + selector);
      return doc.body.find(n => (m[1] in n.attrs) && (m[2] === undefined || n.attrs[m[1]] === m[2]));
    }
  };
  doc.body = new Node('body', doc);
  doc.documentElement = new Node('html', doc);
  doc.activeElement = doc.body;
  parseBody(doc);

  const location = { hash };
  const win = { listeners: {}, addEventListener(type, fn) { win.listeners[type] = fn; } };
  const history = { replaceState(state, title, url) { location.hash = url; } };
  // Only zero-delay timers run; the page's long ones (disarm, hide undo,
  // fade the save indicator) would otherwise outlive the test.
  const setTimeoutStub = (fn, ms) => (ms ? 0 : setImmediate(fn));

  const errors = [];
  const consoleStub = { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} };
  new Function('AutofillStore', 'document', 'window', 'location', 'history', 'chrome', 'setTimeout', 'clearTimeout', 'console', SCRIPT)(
    store, doc, win, location, history, mock, setTimeoutStub, () => {}, consoleStub);

  const page = {
    doc,
    location,
    winListeners: win.listeners,
    el: id => {
      const node = doc.getElementById(id);
      assert.ok(node, 'page has #' + id);
      return node;
    },
    stored: () => JSON.parse(JSON.stringify(mock.storage.local.store)),
    // Lets queued storage callbacks and the promise chains behind them finish.
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      assert.deepStrictEqual(errors, [], 'no console errors');
      assert.ok(!page.el('page-error').visible, 'no error banner: ' + page.el('page-error').textContent);
    },
    // Types into a text field the way a person does: focus, change, leave.
    async type(node, value) {
      node.focus();
      node.value = value;
      node.blur();
      await page.settle();
    },
    // Destructive buttons need a second click to confirm.
    async confirm(node) {
      node.click();
      assert.ok(node.classList.contains('armed'), 'first click only arms the button');
      node.click();
      await page.settle();
    }
  };
  await page.settle();
  return page;
}

const NOW = '2026-11-01T12:00:00.000Z';
const RESUME = { name: 'resume.pdf', type: 'application/pdf', size: 3, savedAt: NOW, dataUrl: 'data:application/pdf;base64,AAAA' };
const SEED = {
  af_profile: {
    firstName: 'Sam', lastName: 'Rivera', preferredName: '', email: 'sam@example.com', phone: '555 123 4567',
    phoneCountryCode: '+1', addressLine1: '1 Main St', addressLine2: '', city: 'Seattle', state: 'WA',
    postalCode: '98101', country: 'United States', linkedin: 'https://www.linkedin.com/in/sam', github: '',
    portfolio: '', website: '', school: 'University of Washington', degree: 'Bachelor of Science',
    major: 'Computer Science', gpa: '', gradMonth: 'June', gradYear: '2027', currentCompany: '',
    currentTitle: '', yearsExperience: '2', workAuthorized: 'yes', needsSponsorship: 'no',
    willingToRelocate: '', earliestStartDate: '', salaryExpectation: '', howDidYouHear: '',
    eeo: { gender: 'A value this page does not list', race: '', hispanicLatino: '', veteran: '', disability: '' }
  },
  af_answers: [
    { id: 'afa_1', question: 'Why do you want to work here?', labelKey: 'why do you want to work here', answer: 'Because.', updatedAt: NOW },
    { id: 'afa_2', question: 'Tell us about yourself.', labelKey: 'tell us about yourself', answer: 'Student.', updatedAt: NOW }
  ],
  af_rules: [
    { id: 'afr_1', host: '*', labelKey: 'legal first name', profileKey: 'firstName', createdAt: NOW, updatedAt: NOW },
    { id: 'afr_2', host: 'jobs.lever.co', labelKey: 'pronouns', value: 'they/them', createdAt: NOW, updatedAt: NOW }
  ],
  af_settings: { showButton: true, fillEeo: false, autoLearn: true },
  af_resume: RESUME
};

async function testShowsStoredData() {
  const page = await openPage(SEED);
  assert.deepStrictEqual(page.stored(), SEED, 'opening the page writes nothing');

  assert.strictEqual(page.el('pf-firstName').value, 'Sam');
  assert.strictEqual(page.el('pf-gradMonth').value, 'June');
  assert.strictEqual(page.el('pf-eeo-gender').value, 'A value this page does not list', 'an unlisted stored choice is kept, not blanked');
  assert.strictEqual(page.el('pf-workAuthorized').dataset.value, 'yes');
  assert.strictEqual(page.el('pf-willingToRelocate').dataset.value, '');

  // Every profile field the store knows has a control on the page.
  const store = require('../shared/autofill-store');
  store.PROFILE_FIELDS.forEach(k => page.el('pf-' + k));
  store.EEO_FIELDS.forEach(k => page.el('pf-eeo-' + k));

  assert.strictEqual(page.el('progress-text').textContent, '19 of 23 filled');
  assert.strictEqual(page.el('count-answers').textContent, '2');
  assert.strictEqual(page.el('count-rules').textContent, '2');
  assert.strictEqual(page.el('resume-name').textContent, 'resume.pdf');
  assert.ok(!page.el('resume-remove-btn').visible, 'the resume tab is not the open one');
  assert.strictEqual(page.el('answers-list').children.length, 2);
  assert.strictEqual(page.el('rules-body').children.length, 2);
  assert.strictEqual(page.el('rules-body').children[0].children[2].textContent, 'Your profile First name');
  uninstallMockChrome();
}

async function testTabs() {
  const page = await openPage(SEED);
  const panels = ['profile', 'resume', 'answers', 'rules', 'settings'];
  const open = () => panels.filter(p => page.el(p).visible);
  assert.deepStrictEqual(open(), ['profile'], 'profile opens first');

  page.el('tab-rules').click();
  assert.deepStrictEqual(open(), ['rules']);
  assert.strictEqual(page.location.hash, '#rules');
  assert.strictEqual(page.el('tab-rules').getAttribute('aria-selected'), 'true');
  assert.strictEqual(page.el('tab-profile').getAttribute('aria-selected'), 'false');
  uninstallMockChrome();

  const linked = await openPage(SEED, '#data');
  assert.ok(linked.el('settings').visible, 'the old #data link opens Settings');
  uninstallMockChrome();
}

async function testProfileEdits() {
  const page = await openPage(SEED);
  const expected = JSON.parse(JSON.stringify(SEED));

  await page.type(page.el('pf-github'), '  https://github.com/sam ');
  expected.af_profile.github = 'https://github.com/sam';
  assert.deepStrictEqual(page.stored(), expected, 'one field saved, the rest untouched');
  assert.strictEqual(page.el('progress-text').textContent, '19 of 23 filled', 'GitHub is optional, so it does not count');

  const relocate = page.el('pf-willingToRelocate');
  const [yes, no] = relocate.children;
  yes.click();
  await page.settle();
  expected.af_profile.willingToRelocate = 'yes';
  assert.deepStrictEqual(page.stored(), expected);
  assert.strictEqual(yes.getAttribute('aria-pressed'), 'true');
  no.click();
  await page.settle();
  assert.strictEqual(page.stored().af_profile.willingToRelocate, 'no');
  no.click();
  await page.settle();
  assert.strictEqual(page.stored().af_profile.willingToRelocate, '', 'pressing the lit button clears the answer');
  assert.strictEqual(no.getAttribute('aria-pressed'), 'false');

  const year = page.el('pf-gradYear');
  year.parent.children[2].click();
  await page.settle();
  assert.strictEqual(page.stored().af_profile.gradYear, '2028', 'the + button steps the year');

  const gender = page.el('pf-eeo-gender');
  gender.value = 'Female';
  gender.fire('change');
  await page.settle();
  assert.strictEqual(page.stored().af_profile.eeo.gender, 'Female');
  uninstallMockChrome();
}

async function testListEditsAndUndo() {
  const page = await openPage(SEED);

  const second = page.el('answers-list').children[1];
  await page.type(second.children[1], 'Final-year student.');
  // The store moves an edited answer to the top of the list.
  assert.deepStrictEqual(page.stored().af_answers.map(a => a.id), ['afa_2', 'afa_1'], 'editing keeps both answers and their ids');
  assert.strictEqual(page.stored().af_answers[0].answer, 'Final-year student.');
  const before = page.stored();

  const lastDelete = page.el('answers-list').children[1].find(n => n.tagName === 'BUTTON' && n.textContent === 'Delete')[0];
  await page.confirm(lastDelete);
  assert.deepStrictEqual(page.stored().af_answers.map(a => a.id), ['afa_2']);
  assert.strictEqual(page.el('count-answers').textContent, '1');
  page.el('undo-btn').click();
  await page.settle();
  assert.deepStrictEqual(page.stored(), before, 'undo puts the deleted answer back in place');
  assert.strictEqual(page.el('answers-list').children.length, 2);

  const ruleDelete = page.el('rules-body').children[1].find(n => n.tagName === 'BUTTON' && n.textContent === 'Forget')[0];
  await page.confirm(ruleDelete);
  assert.deepStrictEqual(page.stored().af_rules.map(r => r.id), ['afr_1']);
  page.el('undo-btn').click();
  await page.settle();
  assert.deepStrictEqual(page.stored(), before, 'undo puts the deleted rule back in place');

  page.el('answer-add-btn').click();
  page.el('answer-new-question').value = 'Favorite language?';
  page.el('answer-new-text').value = 'JavaScript';
  page.el('answer-new').fire('submit');
  await page.settle();
  assert.strictEqual(page.stored().af_answers.length, 3);
  assert.strictEqual(page.el('answers-list').children.length, 3);
  assert.ok(!page.el('answer-new').visible, 'the new-answer form closes after saving');
  uninstallMockChrome();
}

async function testSettingsResumeAndErase() {
  const page = await openPage(SEED);

  const eeoSwitch = page.doc.querySelectorAll('[data-setting="fillEeo"]')[0];
  assert.strictEqual(eeoSwitch.checked, false);
  eeoSwitch.checked = true;
  eeoSwitch.fire('change');
  await page.settle();
  assert.deepStrictEqual(page.stored().af_settings, {
    showButton: true, fillEeo: true, autoLearn: true, aiEnabled: false, aiKey: '', aiModel: 'claude-opus-5-5'
  });
  const before = page.stored();

  await page.confirm(page.el('resume-remove-btn'));
  assert.ok(!('af_resume' in page.stored()));
  assert.ok(page.el('resume-drop').classList.contains('is-empty'));
  page.el('undo-btn').click();
  await page.settle();
  assert.strictEqual(page.stored().af_resume.dataUrl, RESUME.dataUrl, 'undo restores the resume file');
  assert.strictEqual(page.el('resume-name').textContent, 'resume.pdf');

  await page.confirm(page.el('clear-all-btn'));
  assert.deepStrictEqual(page.stored(), {}, 'erase removes every autofill key');
  assert.strictEqual(page.el('pf-firstName').value, '');
  assert.strictEqual(page.el('clear-all-btn').textContent, 'Erase', 'the erase button disarms afterwards');
  page.el('undo-btn').click();
  await page.settle();
  const after = page.stored();
  // The resume's savedAt is restamped when it is saved again.
  after.af_resume.savedAt = before.af_resume.savedAt;
  assert.deepStrictEqual(after, before, 'undo after erase restores everything');
  assert.strictEqual(page.el('pf-firstName').value, 'Sam');
  uninstallMockChrome();
}

async function testAnswerWriting() {
  const KEY = 'sk-ant-api03-test-key-WXYZ';
  const seed = JSON.parse(JSON.stringify(SEED));
  seed.af_answers[0].company = 'Stripe';
  seed.af_answers[0].role = 'Software Engineering Intern';
  const page = await openPage(seed, '#settings');

  // Saved answers show the job they were written for, and search finds it.
  const first = page.el('answers-list').children[0];
  assert.ok(first.find(n => n.classList.contains('answer-context') && n.textContent === 'Software Engineering Intern at Stripe').length,
    'the answer shows its company and role');
  assert.strictEqual(page.el('answers-list').children[1].find(n => n.classList.contains('answer-context')).length, 0,
    'no context, no chip');
  page.el('answers-search').value = 'stripe';
  page.el('answers-search').fire('input');
  assert.strictEqual(page.el('answers-list').children.length, 1, 'search matches the company');
  page.el('answers-search').value = '';
  page.el('answers-search').fire('input');

  const aiSwitch = page.doc.querySelectorAll('[data-setting="aiEnabled"]')[0];
  const keyInput = page.el('ai-key');
  assert.strictEqual(keyInput.getAttribute('type'), 'password', 'the key field is masked');
  assert.strictEqual(page.el('ai-key-status').textContent, 'No key saved');
  assert.ok(!page.el('ai-key-remove').visible, 'nothing to remove yet');
  assert.strictEqual(page.el('ai-model').value, 'claude-opus-5-5');
  assert.ok(/sent to Anthropic/.test(page.el('ai-note').textContent) && /api\.anthropic\.com/.test(page.el('ai-note').textContent),
    'the page says what is sent where');

  aiSwitch.checked = true;
  aiSwitch.fire('change');
  await page.settle();
  assert.strictEqual(page.stored().af_settings.aiEnabled, true);
  assert.ok(page.el('ai-key-status').classList.contains('is-warn'), 'on without a key asks for one');

  // The key is saved on blur and never shown again.
  await page.type(keyInput, '  ' + KEY + ' ');
  assert.strictEqual(page.stored().af_settings.aiKey, KEY);
  assert.strictEqual(keyInput.value, '', 'the field is cleared after saving');
  assert.strictEqual(page.el('ai-key-status').textContent, 'Saved, ending in WXYZ');
  assert.ok(!page.doc.body.find(n => n.value === KEY || n.textContent.includes(KEY)).length, 'the key is nowhere on the page');
  assert.ok(page.el('ai-key-remove').visible);
  // Blurring the empty field does not wipe the key.
  await page.type(keyInput, '');
  assert.strictEqual(page.stored().af_settings.aiKey, KEY);

  // Model: saved on blur; cleared means the default.
  await page.type(page.el('ai-model'), 'claude-sonnet-5-5');
  assert.strictEqual(page.stored().af_settings.aiModel, 'claude-sonnet-5-5');
  await page.type(page.el('ai-model'), '  ');
  assert.strictEqual(page.stored().af_settings.aiModel, 'claude-opus-5-5');
  assert.strictEqual(page.el('ai-model').value, 'claude-opus-5-5');

  // Remove asks twice and can be undone.
  await page.confirm(page.el('ai-key-remove'));
  assert.strictEqual(page.stored().af_settings.aiKey, '');
  assert.strictEqual(page.el('ai-key-status').textContent, 'Add a key so LIT can write answers');
  page.el('undo-btn').click();
  await page.settle();
  assert.strictEqual(page.stored().af_settings.aiKey, KEY, 'undo puts the key back');

  // Erase then undo brings the key back too (the snapshot holds it in memory).
  await page.confirm(page.el('clear-all-btn'));
  assert.deepStrictEqual(page.stored(), {});
  page.el('undo-btn').click();
  await page.settle();
  assert.strictEqual(page.stored().af_settings.aiKey, KEY, 'undo after erase restores the key');
  assert.strictEqual(page.stored().af_answers[0].company, 'Stripe', 'and the answer context');
  uninstallMockChrome();
}

async function testEmptyPage() {
  const page = await openPage({}, '#answers');
  assert.deepStrictEqual(page.stored(), {}, 'opening an empty page writes nothing');
  assert.strictEqual(page.el('progress-text').textContent, '0 of 23 filled');
  assert.ok(page.el('answers-empty').visible, 'empty answers offer starting points');
  assert.strictEqual(page.el('count-answers').textContent, '');
  assert.ok(page.el('resume-drop').classList.contains('is-empty'));

  const template = page.el('answers-empty').find(n => n.tagName === 'BUTTON')[0];
  template.click();
  assert.ok(page.el('answer-new').visible);
  assert.strictEqual(page.el('answer-new-question').value, template.textContent);
  uninstallMockChrome();
}

// Plain language for people who are not technical, the AI settings tucked
// away, and LIT's accent and comfort mode applied to the page.
async function testPlainLanguageAndLook() {
  const banned = /\bEEO\b|Maps to|Learned rules|Answer bank|>\s*Label\s*</;
  assert.ok(!banned.test(HTML), 'no jargon in the page markup');
  assert.ok(!/title: 'EEO'|Answer bank|answer bank/.test(SCRIPT), 'no jargon in the page script');
  assert.ok(/When a form asks/.test(HTML) && /LIT fills/.test(HTML) && /What LIT has learned/.test(HTML));

  const page = await openPage(SEED, '', { pt_prefs: { accent: 'sage', comfortMode: true }, pt_theme: 'dark' });
  assert.strictEqual(page.doc.documentElement.getAttribute('data-accent'), 'sage');
  assert.strictEqual(page.doc.documentElement.getAttribute('data-comfort'), 'on');
  assert.ok(page.doc.body.classList.contains('pt-dark'), 'the popup theme still wins');

  // The API key and model live under a collapsed Advanced section.
  const advanced = page.el('answer-writing');
  assert.strictEqual(advanced.tagName, 'DETAILS');
  assert.ok(!('open' in advanced.attrs), 'collapsed by default');
  assert.ok(advanced.contains(page.el('ai-key')) && advanced.contains(page.el('ai-model')));
  assert.ok(/Advanced \(AI answers\)/.test(advanced.textContent));

  // GitHub is optional and sits after the links most people have.
  const order = ['pf-linkedin', 'pf-portfolio', 'pf-website', 'pf-github'].map(id => page.el(id));
  const fields = page.el('profile-form').find(n => n.tagName === 'INPUT');
  const idx = order.map(n => fields.indexOf(n));
  assert.deepStrictEqual(idx.slice().sort((a, b) => a - b), idx, 'LinkedIn, Portfolio, Website, then GitHub');
  assert.strictEqual(page.el('pf-github-label').textContent, 'GitHuboptional');
  assert.ok(page.el('profile-form').textContent.includes('Diversity questions (optional)'));
  assert.strictEqual(page.el('pf-eeo-gender-label').textContent, 'Gender', 'no per-field tag inside an optional group');
  uninstallMockChrome();

  // An unknown accent falls back to the default.
  const other = await openPage({}, '', { pt_prefs: { accent: 'neon' } });
  assert.strictEqual(other.doc.documentElement.getAttribute('data-accent'), 'coral');
  assert.strictEqual(other.doc.documentElement.getAttribute('data-comfort'), 'off');
  uninstallMockChrome();
}

// A key press on `node` that bubbles to the document, the way the page's
// field handlers and its page-wide shortcuts both see it. Returns whether
// anything called preventDefault.
function press(page, node, key, mods = {}) {
  let prevented = false;
  const event = Object.assign({ type: 'keydown', key, target: node, preventDefault() { prevented = true; } }, mods);
  (node.listeners.keydown || []).slice().forEach(fn => fn(event));
  (page.doc.listeners.keydown || []).slice().forEach(fn => fn(event));
  return prevented;
}

// The meter points at the next thing to do, and fields with a shape say
// plainly when a value looks off (but still save it as typed).
async function testNextStepAndChecks() {
  const page = await openPage(SEED, '#answers');
  const next = page.el('progress-next');
  assert.ok(!page.el('profile').visible);
  assert.strictEqual(next.textContent, 'Next: Portfolio', 'the first empty field that counts');
  next.click();
  assert.ok(page.el('profile').visible, 'Next opens the profile');
  assert.strictEqual(page.doc.activeElement, page.el('pf-portfolio'), 'and puts the cursor in that field');
  assert.ok(page.el('pf-portfolio').parent.classList.contains('is-target'), 'the field is ringed');

  // Saved as typed, flagged under the field, and the meter points at it.
  await page.type(page.el('pf-email'), 'sam@example');
  assert.strictEqual(page.stored().af_profile.email, 'sam@example', 'a value that looks off is still saved');
  const msg = page.el('pf-email-msg');
  assert.ok(msg.visible);
  assert.strictEqual(msg.textContent, 'Check this email. It should look like name@example.com.');
  assert.strictEqual(page.el('pf-email').getAttribute('aria-invalid'), 'true');
  assert.strictEqual(page.el('pf-email').getAttribute('aria-describedby'), 'pf-email-msg');
  assert.strictEqual(next.textContent, 'Check: Email');
  assert.ok(next.classList.contains('is-warn'));
  await page.type(page.el('pf-email'), 'sam@example.com');
  assert.ok(!msg.visible, 'the note goes once it is fixed');
  assert.strictEqual(page.el('pf-email').getAttribute('aria-invalid'), null);
  assert.strictEqual(next.textContent, 'Next: Portfolio');

  // Format tidying only: a missing https:// or +.
  await page.type(page.el('pf-linkedin'), 'linkedin.com/in/sam-r');
  assert.strictEqual(page.stored().af_profile.linkedin, 'https://linkedin.com/in/sam-r');
  assert.strictEqual(page.el('pf-linkedin').value, 'https://linkedin.com/in/sam-r');
  assert.ok(!page.el('pf-linkedin-msg').visible);
  await page.type(page.el('pf-linkedin'), 'https://example.com/sam');
  assert.ok(/does not look like a LinkedIn link/.test(page.el('pf-linkedin-msg').textContent));
  await page.type(page.el('pf-phoneCountryCode'), '44');
  assert.strictEqual(page.stored().af_profile.phoneCountryCode, '+44');
  await page.type(page.el('pf-phone'), 'call me');
  assert.strictEqual(page.el('pf-phone-msg').textContent, 'Use numbers only, like 555 123 4567.');
  await page.type(page.el('pf-phone'), '(555) 123-4567 ext. 9');
  assert.ok(!page.el('pf-phone-msg').visible, 'brackets, dashes and an extension are fine');
  await page.type(page.el('pf-gradYear'), '27');
  assert.strictEqual(page.el('pf-gradYear-msg').textContent, 'Use a 4-digit year, like 2027.');
  await page.type(page.el('pf-portfolio'), 'my site');
  assert.ok(/starting with https:\/\//.test(page.el('pf-portfolio-msg').textContent), 'text that is not a link is not given a scheme');
  assert.strictEqual(page.stored().af_profile.portfolio, 'my site');
  uninstallMockChrome();

  // A stored value that looks off is flagged on open, without writing.
  const seed = JSON.parse(JSON.stringify(SEED));
  seed.af_profile.website = 'not a link';
  const again = await openPage(seed);
  assert.deepStrictEqual(again.stored(), seed, 'opening the page writes nothing');
  assert.ok(again.el('pf-website-msg').visible);
  assert.strictEqual(again.el('progress-next').textContent, 'Check: Website');
  uninstallMockChrome();

  // Everything filled: the resume is next, then all set.
  const full = JSON.parse(JSON.stringify(SEED));
  Object.assign(full.af_profile, { portfolio: 'https://sam.example.com', website: 'https://sam.example.com',
    willingToRelocate: 'yes', earliestStartDate: 'June 2027' });
  delete full.af_resume;
  const done = await openPage(full);
  assert.strictEqual(done.el('progress-text').textContent, '23 of 23 filled');
  assert.strictEqual(done.el('progress-next').textContent, 'Next: add your resume');
  done.el('progress-next').click();
  assert.ok(done.el('resume').visible);
  assert.strictEqual(done.doc.activeElement, done.el('resume-upload-btn'));
  uninstallMockChrome();
  full.af_resume = RESUME;
  const allSet = await openPage(full);
  assert.strictEqual(allSet.el('progress-text').textContent, 'All 23 filled');
  assert.ok(!allSet.el('progress-next').visible);
  assert.ok(allSet.el('progress-box').classList.contains('is-complete'));
  uninstallMockChrome();
}

async function testKeyboardAndLeaving() {
  const page = await openPage(SEED);

  // Ctrl/Cmd+S saves the field you are in without leaving it.
  const city = page.el('pf-city');
  city.focus();
  city.value = 'Tacoma';
  assert.ok(press(page, city, 's', { ctrlKey: true }), 'the browser save dialog is held off');
  await page.settle();
  assert.strictEqual(page.stored().af_profile.city, 'Tacoma');
  assert.strictEqual(page.doc.activeElement, city, 'still in the field');
  assert.strictEqual(page.el('save-status').textContent, 'Saved');
  press(page, city, 'S', { metaKey: true });
  await page.settle();
  assert.strictEqual(page.el('save-status').textContent, 'Everything is saved', 'nothing new to save says so');

  // Esc takes back an edit in a profile field.
  const state = page.el('pf-state');
  state.focus();
  state.value = 'Oregon';
  press(page, state, 'Escape');
  await page.settle();
  assert.strictEqual(state.value, 'WA');
  assert.strictEqual(page.stored().af_profile.state, 'WA', 'nothing written');

  // ...and in a saved answer.
  const item = page.el('answers-list').children[0];
  const [question, text] = item.children;
  text.focus();
  text.value = 'A half-written thought';
  press(page, text, 'Escape');
  await page.settle();
  assert.strictEqual(text.value, 'Because.');
  assert.strictEqual(page.stored().af_answers[0].answer, 'Because.');
  assert.ok(question, 'the item has its question field');

  // New answer: Enter moves from question to answer, Ctrl+Enter saves.
  page.el('tab-answers').click();
  page.el('answer-add-btn').click();
  const q = page.el('answer-new-question');
  const a = page.el('answer-new-text');
  assert.strictEqual(page.doc.activeElement, q);
  assert.ok(/(Ctrl|Cmd)\+Enter saves\. Esc cancels\./.test(page.el('answer-new-keys').textContent));
  q.value = 'What are your salary expectations?';
  assert.ok(press(page, q, 'Enter'), 'Enter does not send a half-done form');
  assert.strictEqual(page.doc.activeElement, a, 'Enter moves on to the answer');
  assert.ok(!press(page, a, 'Enter'), 'plain Enter in the answer is a new line');
  a.value = 'Open to discussing.';
  press(page, a, 'Enter', { ctrlKey: true });
  await page.settle();
  assert.strictEqual(page.stored().af_answers.length, 3);
  assert.ok(!page.el('answer-new').visible);
  assert.strictEqual(page.el('save-status').textContent, 'Answer saved');

  // Saving with a piece missing says which, in plain words.
  page.el('answer-add-btn').click();
  page.el('answer-new').fire('submit');
  await page.settle();
  assert.strictEqual(page.el('answer-new-error').textContent, 'Add the question first, then your answer.');
  q.value = 'Anything else?';
  page.el('answer-new').fire('submit');
  await page.settle();
  assert.strictEqual(page.el('answer-new-error').textContent, 'Write your answer, then save.');
  assert.strictEqual(page.doc.activeElement, a);

  // A draft blocks a careless close; Esc closes it but offers it back.
  a.value = 'Draft words';
  const unload = { returnValue: undefined, prevented: false, preventDefault() { this.prevented = true; } };
  const win = page.winListeners;
  win.beforeunload(unload);
  assert.ok(unload.prevented && unload.returnValue === '', 'leaving with a draft asks first');
  press(page, a, 'Escape');
  assert.ok(!page.el('answer-new').visible, 'Esc cancels the form');
  assert.strictEqual(page.doc.activeElement, page.el('answer-add-btn'));
  assert.strictEqual(page.el('undo-text').textContent, 'Answer draft closed.');
  page.el('undo-btn').click();
  await page.settle();
  assert.ok(page.el('answer-new').visible, 'undo brings the draft back');
  assert.strictEqual(q.value, 'Anything else?');
  assert.strictEqual(a.value, 'Draft words');
  assert.strictEqual(page.stored().af_answers.length, 3, 'the draft was never saved');
  page.el('answer-new-cancel').click();
  const calm = { returnValue: undefined, prevented: false, preventDefault() { this.prevented = true; } };
  win.beforeunload(calm);
  assert.ok(!calm.prevented && calm.returnValue === undefined, 'nothing unsaved, no question');

  // Esc answers the import question with "Keep my data".
  page.el('tab-settings').click();
  page.el('import-confirm').classList.remove('hidden');
  press(page, page.doc.body, 'Escape');
  assert.ok(!page.el('import-confirm').visible);

  // The Applications page link uses the extension URL.
  assert.strictEqual(page.el('applications-link').getAttribute('href'),
    'chrome-extension://job-tracker-mock-extension-id/applications/applications.html');
  uninstallMockChrome();
}

async function run() {
  const tests = [
    testPlainLanguageAndLook,
    testNextStepAndChecks,
    testKeyboardAndLeaving,
    testShowsStoredData,
    testTabs,
    testProfileEdits,
    testListEditsAndUndo,
    testSettingsResumeAndErase,
    testAnswerWriting,
    testEmptyPage
  ];
  for (const t of tests) {
    try {
      await t();
      console.log('[PASS] ' + t.name);
    } catch (e) {
      uninstallMockChrome();
      console.error('[FAIL] ' + t.name);
      throw e;
    }
  }
  console.log('--- test/autofill-options.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
