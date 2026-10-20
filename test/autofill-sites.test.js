// Autofill site adapters (Greenhouse, Lever, Ashby, Workday): registration
// and URL matching, the fixed field selectors against a saved fixture per
// site, and each custom `fill` driving the simulated widgets (react-select,
// Ashby yes/no buttons and autocomplete, Workday listbox and multiselect
// prompt), including Workday's re-render-after-every-edit behavior. Every
// test also checks that no MutationObserver is left connected.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dom = require('./mock_dom');
const af = require('./mock_autofill_4');

const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'content', 'autofill', 'sites');
const SITES = ['greenhouse', 'lever', 'ashby', 'workday'];

function loadSite(site) {
  const full = path.join(SITE_DIR, site + '.js');
  delete require.cache[require.resolve(full)];
  require(full);
}

function loadAll() {
  const core = af.stubAutofillCore();
  SITES.forEach(loadSite);
  const by = {};
  core.adapters.forEach(a => { by[a.id] = a; });
  // Short waits so the failure paths finish quickly.
  Object.values(by).forEach(a => { if (a.timing) { a.timing.wait = 400; a.timing.confirm = 250; } });
  return { core, by };
}

function descOf(el, extra) {
  return Object.assign({ el, id: el.getAttribute('id') || '', name: el.getAttribute('name') || '' }, extra);
}

// profileKey -> elements its selector resolves to in `doc`.
function resolveFields(adapter, doc) {
  const out = {};
  for (const f of adapter.fields) {
    assert.ok(f.selector && f.profileKey, adapter.id + ': field entries need selector and profileKey');
    out[f.profileKey] = (out[f.profileKey] || []).concat(doc.querySelectorAll(f.selector));
  }
  return out;
}

function assertMapped(map, key, check, site) {
  const els = map[key] || [];
  assert.strictEqual(els.length, 1, site + ': ' + key + ' should resolve to exactly one element, got ' + els.length);
  assert.ok(check(els[0]), site + ': ' + key + ' resolved to the wrong element (' + els[0].tagName + ' ' + JSON.stringify(els[0].attributes) + ')');
}

function assertNoObservers(label) {
  assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0, label + ': MutationObserver left connected');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- registration ------------------------------------------------------------
test('guard: files load without AutofillCore and register nothing', () => {
  af.unstubAutofillCore();
  SITES.forEach(site => assert.doesNotThrow(() => loadSite(site), site + ' threw without AutofillCore'));
  assert.strictEqual(typeof global.AutofillCore, 'undefined');
});

test('registration: one adapter per site with the contract shape', () => {
  const { core, by } = loadAll();
  assert.deepStrictEqual(core.adapters.map(a => a.id).sort(), ['ashby', 'greenhouse', 'lever', 'workday']);
  for (const a of core.adapters) {
    assert.strictEqual(typeof a.matches, 'function', a.id + '.matches');
    assert.ok(Array.isArray(a.fields) && a.fields.length > 0, a.id + '.fields');
    if (a.fill !== undefined) assert.strictEqual(typeof a.fill, 'function', a.id + '.fill');
    if (a.scanRoot !== undefined) assert.strictEqual(typeof a.scanRoot, 'function', a.id + '.scanRoot');
  }
  assert.strictEqual(by.lever.fill, undefined, 'Lever leaves custom questions to the core');
});

test('matches: hosts mirror content/adapters/ats', () => {
  const { by } = loadAll();
  const cases = [
    ['greenhouse', 'https://boards.greenhouse.io/exampleco/jobs/123', true],
    ['greenhouse', 'https://job-boards.greenhouse.io/exampleco/jobs/123', true],
    ['greenhouse', 'https://boards.eu.greenhouse.io/exampleco/jobs/123', true],
    ['greenhouse', 'https://job-boards.eu.greenhouse.io/exampleco/jobs/123', true],
    ['greenhouse', 'https://boards.greenhouse.io/embed/job_app?for=exampleco&token=123', true],
    ['greenhouse', 'https://www.greenhouse.io/careers', false],
    ['greenhouse', 'https://boards.greenhouse.io.evil.example/x', false],
    ['lever', 'https://jobs.lever.co/exampleco/abc/apply', true],
    ['lever', 'https://jobs.eu.lever.co/exampleco/abc/apply', true],
    ['lever', 'https://lever.co/', false],
    ['ashby', 'https://jobs.ashbyhq.com/exampleco/0000/application', true],
    ['ashby', 'https://ashbyhq.com/', false],
    ['workday', 'https://exampleco.wd5.myworkdayjobs.com/en-US/External/job/X/apply', true],
    ['workday', 'https://wd3.myworkdaysite.com/recruiting/exampleco/External', true],
    ['workday', 'https://myworkdayjobs.com.evil.example/', false],
    ['workday', 'https://example.com/', false]
  ];
  for (const [id, url, want] of cases) {
    assert.strictEqual(by[id].matches(url), want, id + ' matches(' + url + ')');
    assert.strictEqual(by[id].matches(new URL(url)), want, id + ' matches(URL ' + url + ')');
  }
  assert.strictEqual(by.workday.matches('not a url'), false);
  assert.strictEqual(by.greenhouse.matches(undefined), false);
});

test('helpers: the shared widget block is identical in all three files', () => {
  const block = site => {
    const src = fs.readFileSync(path.join(SITE_DIR, site + '.js'), 'utf8');
    const a = src.indexOf('// --- widget helpers');
    const b = src.indexOf('// --- end widget helpers');
    assert.ok(a > 0 && b > a, site + ': helper block markers missing');
    return src.slice(a, b);
  };
  const gh = block('greenhouse');
  assert.strictEqual(block('ashby'), gh, 'ashby.js helper block drifted from greenhouse.js');
  assert.strictEqual(block('workday'), gh, 'workday.js helper block drifted from greenhouse.js');
});

// --- Greenhouse --------------------------------------------------------------
test('greenhouse: fixed fields resolve on the job-boards fixture', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const map = resolveFields(by.greenhouse, doc);
  const byId = id => el => el.getAttribute('id') === id;
  assertMapped(map, 'firstName', byId('first_name'), 'greenhouse');
  assertMapped(map, 'lastName', byId('last_name'), 'greenhouse');
  assertMapped(map, 'preferredName', byId('preferred_name'), 'greenhouse');
  assertMapped(map, 'email', byId('email'), 'greenhouse');
  assertMapped(map, 'phone', byId('phone'), 'greenhouse');
  assertMapped(map, 'country', byId('country'), 'greenhouse');
  assertMapped(map, 'city', byId('candidate-location'), 'greenhouse');
  assertMapped(map, 'resume', el => el.getAttribute('id') === 'resume' && el.type === 'file', 'greenhouse');
  assertMapped(map, 'linkedin', byId('question_1000000101'), 'greenhouse');
  assertMapped(map, 'github', byId('question_1000000102'), 'greenhouse');
  assertMapped(map, 'website', byId('question_1000000103'), 'greenhouse');
  assert.strictEqual((map.portfolio || []).length, 0, 'no portfolio question in this fixture');
  assert.strictEqual(doc.querySelector('#cover_letter').matches(by.greenhouse.fields.find(f => f.profileKey === 'resume').selector), false,
    'the cover letter upload is not the resume');
  assert.strictEqual(by.greenhouse.scanRoot(doc).getAttribute('id'), 'application-form');
});

test('greenhouse: plain inputs fall back to setValue', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  assert.strictEqual(by.greenhouse.fill(descOf(doc.querySelector('#first_name')), 'Alex'), undefined);
  assert.strictEqual(by.greenhouse.fill(descOf(doc.querySelector('#question_1000000104')), 'Because'), undefined);
  assert.strictEqual(by.greenhouse.fill(descOf(doc.querySelector('#resume')), 'x'), undefined);
});

test('greenhouse: react-select question is opened, typed into, and an option clicked', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const id = 'question_1000000105';
  const state = af.reactSelect(doc, id, ['Yes', 'No']);
  const ok = await by.greenhouse.fill(descOf(doc.getElementById(id)), 'no');
  assert.strictEqual(ok, true);
  assert.strictEqual(state.selected, 'No');
  assert.strictEqual(state.clicks, 1);
  assert.strictEqual(doc.querySelector('[id="react-select-' + id + '-listbox"]'), null, 'menu closed after the pick');
  assert.strictEqual(doc.getElementById(id).closest('.select__control').querySelector('.select__single-value').textContent, 'No');

  // Already answered: nothing is reopened or re-clicked.
  const again = await by.greenhouse.fill(descOf(doc.getElementById(id)), 'No');
  assert.strictEqual(again, true);
  assert.strictEqual(state.clicks, 1);
  assertNoObservers('greenhouse select');
});

test('greenhouse: "yes" picks the long-form yes option', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const id = 'question_1000000106';
  const state = af.reactSelect(doc, id, ['No, I am not authorized', 'Yes, I am authorized to work in this country']);
  assert.strictEqual(await by.greenhouse.fill(descOf(doc.getElementById(id)), 'yes'), true);
  assert.strictEqual(state.selected, 'Yes, I am authorized to work in this country');
  assertNoObservers('greenhouse yes');
});

test('greenhouse: clears the filter when typing hides the right option', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const state = af.reactSelect(doc, 'country', ['Canada', 'USA', 'United Kingdom']);
  assert.strictEqual(await by.greenhouse.fill(descOf(doc.getElementById('country')), 'United States'), true);
  assert.strictEqual(state.selected, 'USA');
  assertNoObservers('greenhouse country');
});

test('greenhouse: async location options are awaited and the closest one wins', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const state = af.reactSelect(doc, 'candidate-location',
    ['Austintown, Ohio, United States', 'Austin, Texas, United States', 'Austin, Minnesota, United States'],
    { asyncOptions: true, delay: 30 });
  assert.strictEqual(await by.greenhouse.fill(descOf(doc.getElementById('candidate-location')), 'Austin'), true);
  assert.strictEqual(state.selected, 'Austin, Texas, United States');
  assertNoObservers('greenhouse location');
});

test('greenhouse: location picks the same-named town in the profile state', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const state = af.reactSelect(doc, 'candidate-location',
    ['Plainview, Texas, United States', 'Plainview, New York, United States', 'Plainview, Nebraska, United States'],
    { asyncOptions: true, delay: 30 });
  // The mock filters by substring, so "Plainview, NY" finds nothing and the
  // adapter has to retry with the city alone.
  assert.strictEqual(await by.greenhouse.fill(descOf(doc.getElementById('candidate-location')), 'Plainview, NY'), true);
  assert.strictEqual(state.selected, 'Plainview, New York, United States');
  assertNoObservers('greenhouse plainview');
});

test('greenhouse: no acceptable option returns false and closes the menu', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('greenhouse.html');
  const id = 'question_1000000105';
  const state = af.reactSelect(doc, id, ['Yes', 'No']);
  assert.strictEqual(await by.greenhouse.fill(descOf(doc.getElementById(id)), 'Prefer to discuss later'), false);
  assert.strictEqual(state.selected, null);
  assert.strictEqual(state.open, false, 'Escape closed the menu');
  assertNoObservers('greenhouse miss');
});

// --- Lever -------------------------------------------------------------------
test('lever: fixed fields resolve, including the bracketed urls[...] names', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('lever.html');
  const map = resolveFields(by.lever, doc);
  const byName = n => el => el.getAttribute('name') === n;
  assertMapped(map, 'fullName', byName('name'), 'lever');
  assertMapped(map, 'email', byName('email'), 'lever');
  assertMapped(map, 'phone', byName('phone'), 'lever');
  assertMapped(map, 'currentCompany', byName('org'), 'lever');
  assertMapped(map, 'linkedin', byName('urls[LinkedIn]'), 'lever');
  assertMapped(map, 'github', byName('urls[GitHub]'), 'lever');
  assertMapped(map, 'portfolio', byName('urls[Portfolio]'), 'lever');
  assertMapped(map, 'website', byName('urls[Other]'), 'lever');
  assertMapped(map, 'resume', el => el.getAttribute('name') === 'resume' && el.type === 'file', 'lever');
  assert.strictEqual(by.lever.scanRoot(doc).getAttribute('id'), 'application-form');
});

// --- Ashby -------------------------------------------------------------------
test('ashby: system fields plus label-derived phone, LinkedIn, GitHub', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('ashby.html');
  global.document = doc;
  try {
    const map = resolveFields(by.ashby, doc);
    const byId = id => el => el.getAttribute('id') === id;
    assertMapped(map, 'fullName', byId('_systemfield_name'), 'ashby');
    assertMapped(map, 'email', byId('_systemfield_email'), 'ashby');
    assertMapped(map, 'resume', byId('_systemfield_resume'), 'ashby');
    assertMapped(map, 'city', el => el.matches('input.ashby-application-form-input-autocomplete'), 'ashby');
    assertMapped(map, 'linkedin', byId('00000000-0000-4000-8000-0000000000a2'), 'ashby');
    assertMapped(map, 'github', byId('00000000-0000-4000-8000-0000000000a3'), 'ashby');
    // Phone is found by type=tel and by its label; both point at one input.
    const phones = new Set(map.phone);
    assert.strictEqual(phones.size, 1);
    assert.strictEqual([...phones][0].getAttribute('id'), '00000000-0000-4000-8000-0000000000a1');
  } finally {
    delete global.document;
  }
  // Without a document the getter still returns the static entries.
  assert.ok(by.ashby.fields.length >= 5);
});

test('ashby: yes/no questions are answered by clicking the button', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('ashby.html');
  const entry = path => doc.querySelector('[data-field-path="' + path + '"]');
  const authorized = entry('00000000-0000-4000-8000-0000000000a5');
  const sponsor = entry('00000000-0000-4000-8000-0000000000a6');
  const s1 = af.ashbyYesNo(doc, authorized.querySelector('.ashby-application-form-input-yesno'));
  const s2 = af.ashbyYesNo(doc, sponsor.querySelector('.ashby-application-form-input-yesno'));

  // The core sees the display:none checkbox, or only the group.
  assert.strictEqual(await by.ashby.fill(descOf(authorized.querySelector('input[type="checkbox"]'), { kind: 'checkbox' }), 'yes'), true);
  assert.strictEqual(authorized.querySelector('button[data-option="yes"]').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(authorized.querySelector('input[type="checkbox"]').checked, true);

  assert.strictEqual(await by.ashby.fill({ el: sponsor.querySelector('label'), group: sponsor, kind: 'radio' }, 'No'), true);
  assert.strictEqual(sponsor.querySelector('button[data-option="no"]').getAttribute('aria-pressed'), 'true');
  assert.strictEqual(sponsor.querySelector('button[data-option="yes"]').getAttribute('aria-pressed'), 'false');

  // Already answered: no second click (a second click could toggle it off).
  assert.strictEqual(await by.ashby.fill(descOf(authorized.querySelector('input[type="checkbox"]')), 'Yes'), true);
  assert.strictEqual(s1.clicks, 1);
  assert.strictEqual(s2.clicks, 1);

  // Not a yes/no answer: refuse instead of guessing.
  assert.strictEqual(await by.ashby.fill(descOf(sponsor.querySelector('input[type="checkbox"]')), 'Maybe'), false);
  assert.strictEqual(s2.clicks, 1);
  assertNoObservers('ashby yes/no');
});

test('ashby: location autocomplete types and picks a suggestion', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('ashby.html');
  const input = doc.querySelector('[data-field-path="_systemfield_location"] input[role="combobox"]');
  af.ashbyAutocomplete(doc, input, ['Austin, Texas, United States', 'Austin, Minnesota, United States', 'Boston, Massachusetts, United States'], { delay: 30 });
  assert.strictEqual(await by.ashby.fill(descOf(input, { kind: 'combobox' }), 'Austin'), true);
  assert.strictEqual(input.value, 'Austin, Texas, United States');
  assert.strictEqual(doc.querySelector('[role="listbox"]'), null);
  assertNoObservers('ashby location');
});

test('ashby: location picks the same-named town in the profile state', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('ashby.html');
  const input = doc.querySelector('[data-field-path="_systemfield_location"] input[role="combobox"]');
  af.ashbyAutocomplete(doc, input, ['Plainview, Texas, United States', 'Plainview, New York, United States'], { delay: 30 });
  assert.strictEqual(await by.ashby.fill(descOf(input, { kind: 'combobox' }), 'Plainview, NY'), true);
  assert.strictEqual(input.value, 'Plainview, New York, United States');
  assertNoObservers('ashby plainview');
});

test('ashby: plain inputs fall back to setValue', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('ashby.html');
  assert.strictEqual(by.ashby.fill(descOf(doc.querySelector('#_systemfield_name')), 'Alex Example'), undefined);
  assert.strictEqual(by.ashby.fill(descOf(doc.querySelector('textarea')), 'text'), undefined);
});

// --- Workday -----------------------------------------------------------------
test('workday: fixed fields resolve on the data-automation-id generation', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const map = resolveFields(by.workday, doc);
  const aid = v => el => el.getAttribute('data-automation-id') === v;
  assertMapped(map, 'firstName', aid('legalNameSection_firstName'), 'workday legacy');
  assertMapped(map, 'lastName', aid('legalNameSection_lastName'), 'workday legacy');
  assertMapped(map, 'email', aid('email'), 'workday legacy');
  assertMapped(map, 'phone', aid('phone-number'), 'workday legacy');
  assertMapped(map, 'addressLine1', aid('addressSection_addressLine1'), 'workday legacy');
  assertMapped(map, 'addressLine2', aid('addressSection_addressLine2'), 'workday legacy');
  assertMapped(map, 'city', aid('addressSection_city'), 'workday legacy');
  assertMapped(map, 'postalCode', aid('addressSection_postalCode'), 'workday legacy');
  assertMapped(map, 'state', aid('addressSection_countryRegion'), 'workday legacy');
  assertMapped(map, 'country', aid('countryDropdown'), 'workday legacy');
  assertMapped(map, 'howDidYouHear', el => el.closest('[data-automation-id="formField-sourcePrompt"]') && el.tagName === 'INPUT', 'workday legacy');
  assertMapped(map, 'resume', aid('file-upload-input-ref'), 'workday legacy');
});

test('workday: fixed fields resolve on the "<section>--<field>" id generation', () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-current.html');
  const map = resolveFields(by.workday, doc);
  const byId = id => el => el.getAttribute('id') === id;
  assertMapped(map, 'firstName', byId('name--legalName--firstName'), 'workday current');
  assertMapped(map, 'lastName', byId('name--legalName--lastName'), 'workday current');
  assertMapped(map, 'phone', byId('phoneNumber--phoneNumber'), 'workday current');
  assertMapped(map, 'addressLine1', byId('address--addressLine1'), 'workday current');
  assertMapped(map, 'city', byId('address--city'), 'workday current');
  assertMapped(map, 'postalCode', byId('address--postalCode'), 'workday current');
  assertMapped(map, 'state', byId('address--countryRegion'), 'workday current');
  assertMapped(map, 'country', byId('country--country'), 'workday current');
  assertMapped(map, 'howDidYouHear', byId('source--source'), 'workday current');
});

test('workday: listbox dropdown picks the option and survives the re-render', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const state = af.workdayListbox(doc, 'button[data-automation-id="countryDropdown"]',
    ['Canada', 'United States Minor Outlying Islands', 'United States of America']);
  const button = doc.querySelector('button[data-automation-id="countryDropdown"]');
  assert.strictEqual(await by.workday.fill(descOf(button, { kind: 'combobox' }), 'United States'), true);
  const fresh = doc.querySelector('button[data-automation-id="countryDropdown"]');
  assert.notStrictEqual(fresh, button, 'the simulator re-rendered the field');
  assert.strictEqual(button.isConnected, false);
  assert.strictEqual(fresh.textContent, 'United States of America');
  assert.strictEqual(state.picks, 1);
  assert.strictEqual(doc.querySelector('[role="listbox"][data-automation-id="activeListContainer"]'), null, 'popup closed');
  assertNoObservers('workday country');
});

test('workday: a desc whose button was re-rendered away is re-queried', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const sel = 'button[data-automation-id="phone-device-type"]';
  const stale = doc.querySelector(sel);
  // A re-render between the scan and the fill: same attributes, new node.
  const replacement = doc.createElement('button');
  Object.entries(stale.attributes).forEach(([k, v]) => replacement.setAttribute(k, v));
  replacement.textContent = 'Select One';
  stale.parentElement.appendChild(replacement);
  stale.remove();
  const state = af.workdayListbox(doc, sel, ['Home', 'Mobile', 'Work'], { openDelay: 120 });
  assert.strictEqual(await by.workday.fill(descOf(stale, { kind: 'combobox' }), 'Mobile'), true);
  assert.strictEqual(doc.querySelector(sel).textContent, 'Mobile');
  assert.strictEqual(state.opens, 1);
  assertNoObservers('workday stale button');
});

test('workday: dropdown on the id generation (no aria-controls)', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-current.html');
  af.workdayListbox(doc, 'button[id="address--countryRegion"]', ['California', 'Oregon', 'Washington']);
  const button = doc.querySelector('button[id="address--countryRegion"]');
  assert.strictEqual(await by.workday.fill(descOf(button), 'Oregon'), true);
  assert.strictEqual(doc.querySelector('button[id="address--countryRegion"]').textContent, 'Oregon');
  assertNoObservers('workday current state');
});

test('workday: a dropdown that never opens times out with false', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const button = doc.querySelector('button[data-automation-id="addressSection_countryRegion"]');
  const t0 = Date.now();
  assert.strictEqual(await by.workday.fill(descOf(button), 'Oregon'), false);
  assert.ok(Date.now() - t0 < 3000, 'gave up within the configured wait');
  assertNoObservers('workday never opens');
});

test('workday: no matching option returns false and leaves the value alone', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const state = af.workdayListbox(doc, 'button[data-automation-id="countryDropdown"]', ['Canada', 'Mexico']);
  const button = doc.querySelector('button[data-automation-id="countryDropdown"]');
  assert.strictEqual(await by.workday.fill(descOf(button), 'Narnia'), false);
  assert.strictEqual(state.picks, 0);
  assert.strictEqual(doc.querySelector('button[data-automation-id="countryDropdown"]').textContent, 'Select One');
  assertNoObservers('workday no match');
});

test('workday: "How did you hear" prompt searches, then picks a leaf', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const sel = '[data-automation-id="formField-sourcePrompt"] input';
  const state = af.workdayPrompt(doc, sel, [
    { label: 'Job Board', children: [{ label: 'LinkedIn' }, { label: 'Indeed' }] },
    { label: 'Employee Referral' }
  ]);
  assert.strictEqual(await by.workday.fill(descOf(doc.querySelector(sel)), 'LinkedIn'), true);
  assert.deepStrictEqual(state.picks, ['LinkedIn']);
  assert.strictEqual(state.searches, 1);
  assert.strictEqual(doc.querySelector('[data-automation-id="selectedItemList"] li').textContent, 'LinkedIn');
  // Already selected: no second search.
  assert.strictEqual(await by.workday.fill(descOf(doc.querySelector(sel)), 'LinkedIn'), true);
  assert.strictEqual(state.searches, 1);
  assertNoObservers('workday prompt');
});

test('workday: prompt drills into a category when the search returns one', async () => {
  const { by } = loadAll();
  const doc = af.loadFixture('workday-current.html');
  const sel = 'input[id="source--source"]';
  const state = af.workdayPrompt(doc, sel, [
    { label: 'Job Board', children: [{ label: 'LinkedIn' }, { label: 'Indeed' }] },
    { label: 'Employee Referral' }
  ], { flatten: false });
  assert.strictEqual(await by.workday.fill(descOf(doc.querySelector(sel)), 'Indeed'), true);
  assert.deepStrictEqual(state.picks, ['Indeed']);
  assertNoObservers('workday prompt drill');
});

test('workday: text inputs use setValue, re-queried when re-rendered', async () => {
  const { core, by } = loadAll();
  const doc = af.loadFixture('workday-current.html');
  const live = doc.querySelector('input[id="address--city"]');
  assert.strictEqual(by.workday.fill(descOf(live), 'Springfield'), undefined, 'connected text input -> core setValue');

  const stale = doc.querySelector('input[id="name--legalName--firstName"]');
  const desc = descOf(stale, { kind: 'text' });
  const replacement = doc.createElement('input');
  Object.entries(stale.attributes).forEach(([k, v]) => replacement.setAttribute(k, v));
  stale.parentElement.appendChild(replacement);
  stale.remove();
  assert.strictEqual(await by.workday.fill(desc, 'Alex'), true);
  assert.strictEqual(core.setValueCalls.length, 1);
  assert.strictEqual(core.setValueCalls[0].desc.el, replacement);
  assert.strictEqual(replacement.value, 'Alex');
  assert.strictEqual(core.setValueCalls[0].desc.kind, 'text', 'the rest of the descriptor is preserved');
  assertNoObservers('workday text');
});

test('workday: a re-rendered input that never comes back returns false', async () => {
  const { core, by } = loadAll();
  const doc = af.loadFixture('workday-legacy.html');
  const stale = doc.querySelector('input[data-automation-id="addressSection_city"]');
  stale.closest('[data-automation-id="formField-addressSection_city"]').remove();
  assert.strictEqual(await by.workday.fill(descOf(stale), 'Springfield'), false);
  assert.strictEqual(core.setValueCalls.length, 0);
  assertNoObservers('workday gone');
});

async function run() {
  console.log('--- Running test/autofill-sites.test.js ---');
  const savedCore = global.AutofillCore;
  const savedObserver = global.MutationObserver;
  let passed = 0;
  try {
    for (const t of tests) {
      try {
        await t.fn();
      } catch (err) {
        err.message = '[' + t.name + '] ' + err.message;
        throw err;
      }
      passed++;
      console.log('[PASS] ' + t.name);
    }
  } finally {
    if (savedCore === undefined) delete global.AutofillCore; else global.AutofillCore = savedCore;
    if (savedObserver === undefined) delete global.MutationObserver; else global.MutationObserver = savedObserver;
  }
  console.log('--- test/autofill-sites.test.js COMPLETED (' + passed + ' tests) ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
