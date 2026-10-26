// In-page Autofill UI tests: the floating button's visibility rules (field
// count, settings, dynamic DOM), shadow DOM isolation, a run's outlines and
// toast, every learning path, the sensitive-field exclusion, the keyboard
// shortcut, double-injection idempotence, and leak-free teardown.
//
// AutofillStore and AutofillCore are stubbed to the contract (see
// test/mock_autofill_3.js); the UI never needs the real ones.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const dom = require('./mock_dom');
const mock = require('./mock_autofill_3');

const ROOT = path.resolve(__dirname, '..');
const UI_FILE = path.join(ROOT, 'content/autofill/autofill-ui.js');
const HOST = 'boards.greenhouse.io';

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function load() {
  delete require.cache[require.resolve(UI_FILE)];
  return require(UI_FILE);
}

const PROFILE = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  phone: '(555) 123-4567',
  linkedin: 'https://www.linkedin.com/in/ada',
  city: 'London',
  school: 'University of London',
  workAuthorized: 'yes',
  needsSponsorship: 'no'
};

// A page with `fields` (built by the caller from the fresh document) in the
// body, the stubs installed as globals, and the UI script loaded.
async function page(build, options = {}) {
  const doc = dom.installDom();
  const chrome = installMockChrome();
  const win = mock.createWindow();
  global.document = doc;
  global.window = win;
  global.location = new URL(options.url || 'https://' + HOST + '/acme/jobs/123');
  const store = mock.createStore({ profile: options.profile || PROFILE, settings: options.settings || {} });
  const core = mock.createCore();
  if (!options.noStore) global.AutofillStore = store;
  if (!options.noCore) global.AutofillCore = core;
  const fields = build ? build(doc) : {};
  Object.values(fields).forEach(f => { if (!f.parentElement) doc.body.appendChild(f); });
  const api = load();
  await settle();
  return { doc, win, chrome, store, core, fields, api };
}

function cleanup(ctx) {
  if (ctx && ctx.api && typeof ctx.api.destroy === 'function') ctx.api.destroy();
  delete global.document;
  delete global.window;
  delete global.location;
  delete global.AutofillStore;
  delete global.AutofillCore;
  uninstallMockChrome();
  dom.FakeMutationObserver.reset();
}

function hostEl(doc) {
  return doc.getElementById('lit-autofill-host');
}

function shadow(doc) {
  const h = hostEl(doc);
  return h ? h._shadow : null;
}

function fab(doc) {
  const s = shadow(doc);
  return s ? s.querySelector('.fab') : null;
}

function buttonShown(doc) {
  const b = fab(doc);
  return !!b && !b.classList.contains('hidden');
}

function toastText(doc) {
  const s = shadow(doc);
  const t = s ? s.querySelector('.toast .body') : null;
  return t ? t.textContent : '';
}

function promptEl(doc) {
  const s = shadow(doc);
  return s ? s.querySelector('.prompt') : null;
}

function promptText(doc) {
  const p = promptEl(doc);
  return p ? p.querySelector('.body').textContent : '';
}

function promptTitle(doc) {
  const p = promptEl(doc);
  return p ? p.querySelector('.title').textContent : '';
}

function clickPrompt(doc, label) {
  const p = promptEl(doc);
  assert.ok(p, 'a prompt is shown');
  const btn = p.querySelectorAll('button').find(b => b.textContent === label);
  assert.ok(btn, 'prompt button "' + label + '" exists');
  btn.dispatchEvent(dom.makeEvent('click', btn, { stopPropagation() {} }));
}

function threeTextFields(doc) {
  return {
    first: mock.field(doc, 'text', { attrs: { name: 'first_name' } }),
    last: mock.field(doc, 'text', { attrs: { name: 'last_name' } }),
    email: mock.field(doc, 'email', { attrs: { name: 'email' } })
  };
}

// User edits a field: value set, then change (and optionally blur).
function userTypes(ctx, el, value, opts = {}) {
  el.value = value;
  mock.fire(ctx.doc, ctx.win, el, 'input');
  mock.fire(ctx.doc, ctx.win, el, 'change');
  if (opts.blur) mock.fire(ctx.doc, ctx.win, el, 'focusout');
}

async function run() {
  console.log('--- Running test/autofill-ui.test.js ---');

  // -------------------------------------------------------------------------
  // 1. Button visibility by fillable field count
  // -------------------------------------------------------------------------
  {
    const ctx = await page(doc => ({
      a: mock.field(doc, 'text'),
      b: mock.field(doc, 'email')
    }));
    assert.strictEqual(hostEl(ctx.doc), null, 'two fields: no host element is added to the page at all');
    assert.strictEqual(ctx.api.state().eligible, false);
    cleanup(ctx);
  }
  {
    const ctx = await page(threeTextFields);
    assert.ok(hostEl(ctx.doc), 'three fields: the host is mounted');
    assert.ok(buttonShown(ctx.doc), 'three fields: the button shows');
    assert.strictEqual(fab(ctx.doc).textContent, 'Autofill');
    cleanup(ctx);
  }
  {
    // Fields that do not count: hidden inputs, invisible ones, disabled ones,
    // password, submit/button, aria-hidden. A radio group counts once.
    const ctx = await page(doc => {
      const disabled = mock.field(doc, 'text', { attrs: { disabled: '' } });
      const ariaHidden = mock.field(doc, 'text', { attrs: { 'aria-hidden': 'true' } });
      const r1 = mock.field(doc, 'radio', { attrs: { name: 'auth' } });
      const r2 = mock.field(doc, 'radio', { attrs: { name: 'auth' } });
      const r3 = mock.field(doc, 'radio', { attrs: { name: 'auth' } });
      return {
        text: mock.field(doc, 'text'),
        hidden: mock.field(doc, 'hidden'),
        invisible: mock.field(doc, 'text', { visible: false }),
        password: mock.field(doc, 'password'),
        submit: mock.field(doc, 'submit'),
        disabled, ariaHidden, r1, r2, r3
      };
    });
    assert.strictEqual(hostEl(ctx.doc), null, 'only 2 countable fields (text + one radio group)');
    // A resume input is usually visually hidden but still counts.
    const file = mock.field(ctx.doc, 'file', { visible: false });
    ctx.doc.body.appendChild(file);
    ctx.api.check();
    assert.ok(buttonShown(ctx.doc), 'a hidden file input counts as the third field');
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 2. Dynamic re-check on DOM mutations (debounced), and hiding again
  // -------------------------------------------------------------------------
  {
    const ctx = await page(doc => ({ a: mock.field(doc, 'text') }));
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 1, 'one observer');
    assert.strictEqual(dom.FakeMutationObserver.observing(ctx.doc.documentElement).length, 1, 'observing the document root');
    assert.strictEqual(hostEl(ctx.doc), null);

    // A multi-step form renders its next step.
    const step = ctx.doc.createElement('div');
    const added = [mock.field(ctx.doc, 'text'), mock.field(ctx.doc, 'tel')];
    added.forEach(f => step.appendChild(f));
    ctx.doc.body.appendChild(step);
    dom.emitAdded(step);
    dom.emitAdded(step); // a burst schedules one check, not two
    assert.strictEqual(hostEl(ctx.doc), null, 'the check is deferred');
    await wait(ctx.api.CHECK_DELAY_MS + 60);
    assert.ok(buttonShown(ctx.doc), 'button appears after the step renders');

    // A page that never stops mutating (a ticking widget) still gets checked:
    // the check runs a fixed delay after the first mutation of a burst.
    ctx.doc.body.removeChild(step);
    dom.emitAdded(ctx.doc.body);
    await wait(ctx.api.CHECK_DELAY_MS + 60);
    assert.strictEqual(buttonShown(ctx.doc), false);
    ctx.doc.body.appendChild(step);
    const started = Date.now();
    while (!buttonShown(ctx.doc) && Date.now() - started < ctx.api.CHECK_DELAY_MS * 4) {
      dom.emitAdded(step);
      await wait(Math.floor(ctx.api.CHECK_DELAY_MS / 3));
    }
    assert.ok(buttonShown(ctx.doc), 'continuous mutations do not starve the check');

    // The step goes away: the button hides but the host stays for toasts.
    ctx.doc.body.removeChild(step);
    dom.emitAdded(ctx.doc.body);
    await wait(ctx.api.CHECK_DELAY_MS + 60);
    assert.ok(hostEl(ctx.doc), 'host is kept');
    assert.strictEqual(buttonShown(ctx.doc), false, 'button hides below the field threshold');

    // The page (an SPA re-render) throws our host away; the next check puts it back.
    ctx.doc.body.appendChild(step);
    hostEl(ctx.doc).remove();
    dom.emitAdded(step);
    await wait(ctx.api.CHECK_DELAY_MS + 60);
    assert.ok(hostEl(ctx.doc) && buttonShown(ctx.doc), 'host is re-attached when the page drops it');
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 3. settings.showButton, live through AutofillStore.onChange
  // -------------------------------------------------------------------------
  {
    const ctx = await page(threeTextFields, { settings: { showButton: false } });
    assert.strictEqual(buttonShown(ctx.doc), false, 'showButton off: hidden');
    assert.strictEqual(ctx.store.listenerCount(), 1, 'subscribed to store changes');
    await ctx.store.saveSettings({ showButton: true });
    await settle();
    assert.ok(buttonShown(ctx.doc), 'turning showButton on shows it without a reload');
    await ctx.store.saveSettings({ showButton: false });
    await settle();
    assert.strictEqual(buttonShown(ctx.doc), false, 'and off hides it again');
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 4. Shadow DOM isolation
  // -------------------------------------------------------------------------
  {
    const ctx = await page(doc => {
      const pageBtn = doc.createElement('button');
      pageBtn.textContent = 'Page button';
      return Object.assign(threeTextFields(doc), { pageBtn });
    });
    const h = hostEl(ctx.doc);
    assert.strictEqual(h.tagName, 'LIT-AUTOFILL', 'a custom element, so generic page tag rules (div, button) miss it');
    assert.strictEqual(h.shadowRoot, null, 'the shadow root is closed');
    assert.strictEqual(h._shadow.mode, 'closed');
    assert.ok(/all: initial !important/.test(h.getAttribute('style')), 'host box is pinned against page CSS');
    assert.ok(/position: fixed !important/.test(h.getAttribute('style')));
    const style = h._shadow.querySelector('style');
    assert.ok(style && /:host \{ all: initial; \}/.test(style.textContent), 'styles live inside the shadow root');
    assert.strictEqual(h.children.length, 0, 'nothing of ours is in the light DOM under the host');
    const lightButtons = ctx.doc.querySelectorAll('button').map(b => b.textContent);
    assert.deepStrictEqual(lightButtons, ['Page button'], 'the page cannot query our button');
    assert.strictEqual(ctx.doc.querySelectorAll('.fab').length, 0);
    assert.ok(h._shadow.querySelector('.fab'), 'the button is inside the shadow root');
    // Our own UI never counts toward the field threshold.
    assert.strictEqual(ctx.api.state().eligible, true);
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 5. A run: store -> core, outlines, toast, Fill again, focus clears outline
  // -------------------------------------------------------------------------
  {
    const ctx = await page(doc => {
      const f = threeTextFields(doc);
      f.city = mock.field(doc, 'text', { attrs: { name: 'city' } });
      const submit = mock.field(doc, 'submit');
      submit.clicks = 0;
      submit.addEventListener('click', () => { submit.clicks++; });
      f.submit = submit;
      return f;
    });
    const { first, last, email, city, submit } = ctx.fields;
    ctx.store.state.rules = [{ id: 'r0', host: HOST, labelKey: 'x', value: 'y' }];
    ctx.store.state.answers = [{ id: 'a0', question: 'Why?', labelKey: 'why', answer: 'Because.' }];
    ctx.store.state.resume = { name: 'cv.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,AA==' };
    const firstDesc = mock.descFor(first, 'text', 'First name');
    const lastDesc = mock.descFor(last, 'text', 'Last name');
    const emailDesc = mock.descFor(email, 'email', 'Email');
    const cityDesc = mock.descFor(city, 'text', 'Current city');
    ctx.core.setReport(() => ({
      filled: [
        { desc: firstDesc, match: { profileKey: 'firstName', value: 'Ada', confidence: 0.9, source: 'dictionary' } },
        { desc: lastDesc, match: { profileKey: 'lastName', value: 'Lovelace', confidence: 0.9, source: 'dictionary' } }
      ],
      skipped: [{ desc: emailDesc, reason: 'low-confidence' }],
      unmatched: [cityDesc]
    }));

    fab(ctx.doc).dispatchEvent(dom.makeEvent('click', fab(ctx.doc), { stopPropagation() {} }));
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 1, 'one run');
    const opts = ctx.core.calls.run[0];
    assert.strictEqual(opts.profile.firstName, 'Ada', 'profile passed through');
    assert.deepStrictEqual(opts.rules.map(r => r.id), ['r0'], 'rules passed through');
    assert.deepStrictEqual(opts.answers.map(a => a.id), ['a0'], 'answers passed through');
    assert.strictEqual(opts.resume.name, 'cv.pdf', 'resume passed through');
    assert.deepStrictEqual(opts.settings, { showButton: true, fillEeo: false, autoLearn: true }, 'settings passed through');
    assert.strictEqual(opts.host, HOST, 'host passed through');

    assert.ok(first.classList.contains('lit-af-filled') && last.classList.contains('lit-af-filled'), 'filled fields outlined green');
    assert.ok(city.classList.contains('lit-af-unmatched'), 'unmatched outlined amber');
    assert.ok(email.classList.contains('lit-af-unmatched'), 'skipped fields also need the user');
    assert.strictEqual(toastText(ctx.doc), 'Filled 2 fields, 2 need you.');
    assert.strictEqual(fab(ctx.doc).textContent, 'Fill again', 'the button offers Fill again after a run');
    assert.strictEqual(submit.clicks, 0, 'never clicks submit');

    // Focus clears that field's outline only.
    mock.fire(ctx.doc, ctx.win, city, 'focusin');
    assert.strictEqual(city.classList.contains('lit-af-unmatched'), false, 'focus clears the outline');
    assert.ok(first.classList.contains('lit-af-filled'), 'other outlines stay');

    // The toast's Fill again re-runs and resets outlines.
    ctx.core.setReport(() => ({ filled: [{ desc: firstDesc, match: { profileKey: 'firstName', value: 'Ada', confidence: 0.9, source: 'dictionary' } }], skipped: [], unmatched: [] }));
    const again = shadow(ctx.doc).querySelector('.toast').querySelectorAll('button').find(b => b.textContent === 'Fill again');
    assert.ok(again, 'toast has Fill again');
    again.dispatchEvent(dom.makeEvent('click', again, { stopPropagation() {} }));
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 2, 'Fill again runs again');
    assert.strictEqual(last.classList.contains('lit-af-filled'), false, 'old outlines are cleared on the next run');
    assert.strictEqual(email.classList.contains('lit-af-unmatched'), false);
    assert.strictEqual(toastText(ctx.doc), 'Filled 1 field.');
    assert.strictEqual(ctx.api.formatResult(14, 3), 'Filled 14 fields, 3 need you.');
    assert.strictEqual(ctx.api.formatResult(1, 1), 'Filled 1 field, 1 needs you.');

    // A run that throws reports it instead of breaking the button.
    ctx.core.run = async () => { throw new Error('boom'); };
    await ctx.api.fill();
    assert.strictEqual(toastText(ctx.doc), 'Autofill could not finish: boom');
    assert.strictEqual(ctx.api.state().running, false);
    assert.strictEqual(fab(ctx.doc).textContent, 'Fill again');
    cleanup(ctx);
  }

  // Empty profile: a hint instead of "Filled 0 fields".
  {
    const ctx = await page(threeTextFields, { profile: {} });
    ctx.core.setReport(o => ({ filled: [], skipped: [], unmatched: [mock.descFor(ctx.fields.first, 'text', 'First name')] }));
    await ctx.api.fill();
    assert.ok(/profile is empty/.test(toastText(ctx.doc)), toastText(ctx.doc));
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 6. Keyboard shortcut Alt+Shift+F
  // -------------------------------------------------------------------------
  {
    const ctx = await page(threeTextFields);
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, key: 'F', code: 'KeyF' });
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 1, 'Alt+Shift+F runs autofill');
    // macOS Option turns the key into a different character; the code still says KeyF.
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: true, key: 'Ï', code: 'KeyF' });
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 2, 'matches on event.code');
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: false, key: 'f', code: 'KeyF' });
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: true, ctrlKey: true, key: 'F', code: 'KeyF' });
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: true, key: 'G', code: 'KeyG' });
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 2, 'other combos do nothing');
    cleanup(ctx);
  }
  {
    const ctx = await page(doc => ({ a: mock.field(doc, 'text') }));
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: true, key: 'F', code: 'KeyF' });
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 0, 'the shortcut is inert in a frame without a form');
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 7. Learning paths
  // -------------------------------------------------------------------------
  async function learningPage(extraBuild) {
    const ctx = await page(doc => {
      const f = threeTextFields(doc);
      f.city = mock.field(doc, 'text', { attrs: { name: 'q_city' } });
      f.ref = mock.field(doc, 'text', { attrs: { name: 'q_ref' } });
      f.essay = mock.field(doc, 'textarea', { attrs: { name: 'q_why' } });
      if (extraBuild) Object.assign(f, extraBuild(doc));
      return f;
    });
    const d = {
      first: mock.descFor(ctx.fields.first, 'text', 'First name'),
      last: mock.descFor(ctx.fields.last, 'text', 'Last name'),
      email: mock.descFor(ctx.fields.email, 'email', 'Email'),
      city: mock.descFor(ctx.fields.city, 'text', 'Where do you live?'),
      ref: mock.descFor(ctx.fields.ref, 'text', 'Referral code (optional)'),
      essay: mock.descFor(ctx.fields.essay, 'textarea', 'Why do you want to work here?')
    };
    ctx.d = d;
    ctx.core.setReport(() => ({
      filled: [
        { desc: d.first, match: { profileKey: 'firstName', value: 'Ada', confidence: 0.9, source: 'dictionary' } },
        { desc: d.last, match: { profileKey: 'lastName', value: 'Lovelace', confidence: 0.9, source: 'dictionary' } },
        { desc: d.email, match: { profileKey: 'email', value: 'ada@example.com', confidence: 0.9, source: 'autocomplete' } }
      ],
      skipped: [],
      unmatched: [d.city, d.ref, d.essay].concat(ctx.extraUnmatched ? ctx.extraUnmatched(ctx) : [])
    }));
    return ctx;
  }

  // 7a. Unmatched field filled with a profile value: rule to that key, no prompt.
  {
    const ctx = await learningPage();
    await ctx.api.fill();
    userTypes(ctx, ctx.fields.city, '  london ');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule, [{ host: HOST, labelKey: 'where do you live', profileKey: 'city' }]);
    assert.strictEqual(promptEl(ctx.doc), null, 'no prompt when the value is a profile value');
    assert.ok(/Learned/.test(toastText(ctx.doc)), 'a short confirmation');
    // The same change event again does not learn twice.
    mock.fire(ctx.doc, ctx.win, ctx.fields.city, 'change');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 1);
    cleanup(ctx);
  }

  // Profile value matching tolerates URL and phone formatting, refuses ambiguity.
  {
    const ctx = await page(threeTextFields);
    const p = Object.assign({}, mock.EMPTY_PROFILE, PROFILE, { preferredName: 'Ada' });
    assert.strictEqual(ctx.api.profileKeyFor('linkedin.com/in/ada/', p), 'linkedin');
    assert.strictEqual(ctx.api.profileKeyFor('+1 555 123 4567', p), 'phone');
    assert.strictEqual(ctx.api.profileKeyFor('Ada Lovelace', p), 'fullName');
    assert.strictEqual(ctx.api.profileKeyFor('Ada', p), null, 'firstName and preferredName both match: ambiguous');
    assert.strictEqual(ctx.api.profileKeyFor('Yes', p), null, 'bare yes/no is never pinned to a key');
    assert.strictEqual(ctx.api.profileKeyFor('Paris', p), null);
    cleanup(ctx);
  }

  // 7b. Unmatched field with a non-profile value: prompt; This site / All sites / Not now.
  {
    const ctx = await learningPage();
    await ctx.api.fill();
    userTypes(ctx, ctx.fields.ref, 'LIT-2026');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 0, 'nothing saved before the user answers');
    assert.strictEqual(promptTitle(ctx.doc), 'Save answer for next time?');
    assert.strictEqual(promptText(ctx.doc), 'Referral code (optional)');
    assert.strictEqual(promptEl(ctx.doc).querySelector('.value').textContent, 'LIT-2026', 'the answer being saved is shown');
    assert.deepStrictEqual(promptEl(ctx.doc).querySelectorAll('.actions button').map(b => b.textContent), ['Save for this site', 'Save for all sites', 'Not now']);
    assert.ok(promptEl(ctx.doc).parentElement.classList.contains('stack'), 'the prompt sits in the widget, not over the form');
    assert.ok(!/top:|left:/.test(promptEl(ctx.doc).getAttribute('style') || ''), 'the prompt is not pinned next to the field');
    clickPrompt(ctx.doc, 'Save for this site');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule, [{ host: HOST, labelKey: 'referral code optional', value: 'LIT-2026' }]);
    assert.strictEqual(promptEl(ctx.doc), null, 'the prompt closes');

    userTypes(ctx, ctx.fields.ref, 'LIT-2027');
    await settle();
    clickPrompt(ctx.doc, 'Save for all sites');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule[1], { host: '*', labelKey: 'referral code optional', value: 'LIT-2027' }, 'Everywhere saves a global rule');

    userTypes(ctx, ctx.fields.ref, 'LIT-2028');
    await settle();
    clickPrompt(ctx.doc, 'Not now');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 2, 'No saves nothing');
    // The same value changing again (blur/re-render) does not nag a second time.
    mock.fire(ctx.doc, ctx.win, ctx.fields.ref, 'change');
    await settle();
    assert.strictEqual(promptEl(ctx.doc), null, 'no second prompt for an unchanged value');
    cleanup(ctx);
  }

  // 7c. Filled field overwritten with a different profile value: rule moves to that key.
  {
    const ctx = await learningPage();
    ctx.store.state.profile.preferredName = 'Countess';
    await ctx.api.fill();
    assert.strictEqual(ctx.fields.first.value, 'Ada', 'core filled the field');
    userTypes(ctx, ctx.fields.first, 'Countess');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule, [{ host: HOST, labelKey: 'first name', profileKey: 'preferredName' }]);
    assert.strictEqual(promptEl(ctx.doc), null);
    // Re-typing the value the run put there teaches nothing.
    userTypes(ctx, ctx.fields.last, 'Lovelace');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 1, 'unchanged value: nothing learned');
    // Overwriting with a non-profile value asks first.
    userTypes(ctx, ctx.fields.last, 'Byron');
    await settle();
    assert.strictEqual(promptText(ctx.doc), 'Last name');
    assert.strictEqual(ctx.store.calls.learnRule.length, 1);
    cleanup(ctx);
  }

  // 7d. Textarea with 40+ characters: offered to the answer bank on blur.
  {
    const ctx = await learningPage();
    await ctx.api.fill();
    const essay = ctx.fields.essay;
    const answer = 'I have wanted to build analytical engines since I was a child.';
    essay.value = answer;
    mock.fire(ctx.doc, ctx.win, essay, 'change');
    await settle();
    assert.strictEqual(promptEl(ctx.doc), null, 'a long answer waits for blur, no rule prompt on change');
    mock.fire(ctx.doc, ctx.win, essay, 'focusout');
    await settle();
    assert.strictEqual(promptTitle(ctx.doc), 'Save to answer bank?');
    clickPrompt(ctx.doc, 'Save answer');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.saveAnswer, [{ question: 'Why do you want to work here?', answer }]);
    assert.strictEqual(toastText(ctx.doc), 'Saved to your answer bank.');
    assert.strictEqual(ctx.store.calls.learnRule.length, 0, 'answers are not rules');
    // Blurring again without a change does not re-offer.
    mock.fire(ctx.doc, ctx.win, essay, 'focusout');
    await settle();
    assert.strictEqual(promptEl(ctx.doc), null);
    // Under 40 characters: no answer-bank offer.
    essay.value = 'Short answer.';
    mock.fire(ctx.doc, ctx.win, essay, 'focusout');
    await settle();
    assert.strictEqual(promptEl(ctx.doc), null, 'short textarea is not offered');
    assert.strictEqual(ctx.store.calls.saveAnswer.length, 1);
    cleanup(ctx);
  }

  // 7e. Radio group (bare yes/no) asks rather than guessing a profile key.
  {
    let group;
    let yes;
    const ctx = await learningPage(doc => {
      group = doc.createElement('fieldset');
      const mk = (val, text) => {
        const lab = doc.createElement('label');
        const r = mock.field(doc, 'radio', { attrs: { name: 'q_over18', value: val } });
        lab.appendChild(r);
        const t = doc.createElement('span');
        t.textContent = text;
        lab.appendChild(t);
        group.appendChild(lab);
        return r;
      };
      yes = mk('1', 'Yes');
      mk('0', 'No');
      return { group };
    });
    ctx.extraUnmatched = () => [mock.descFor(yes, 'radio', 'Are you over 18?', { group, options: ['Yes', 'No'] })];
    await ctx.api.fill();
    assert.ok(group.classList.contains('lit-af-unmatched'), 'groups are outlined as a whole');
    yes.checked = true;
    mock.fire(ctx.doc, ctx.win, yes, 'change');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 0, 'workAuthorized is "yes" too, but a bare Yes is not pinned to it');
    assert.strictEqual(promptText(ctx.doc), 'Are you over 18?');
    clickPrompt(ctx.doc, 'Save for this site');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule, [{ host: HOST, labelKey: 'are you over 18', value: 'Yes' }]);
    cleanup(ctx);
  }

  // 7f. autoLearn off: nothing is watched for learning.
  {
    const ctx = await learningPage();
    ctx.store.state.settings.autoLearn = false;
    await ctx.api.fill();
    userTypes(ctx, ctx.fields.city, 'London');
    userTypes(ctx, ctx.fields.ref, 'LIT-2026');
    ctx.fields.essay.value = 'x'.repeat(60);
    mock.fire(ctx.doc, ctx.win, ctx.fields.essay, 'focusout');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 0);
    assert.strictEqual(ctx.store.calls.saveAnswer.length, 0);
    assert.strictEqual(promptEl(ctx.doc), null);
    cleanup(ctx);
  }

  // 7g. Edits made before any run teach nothing, and a field no scan finds
  // is not learned from.
  {
    const ctx = await learningPage(doc => ({ other: mock.field(doc, 'text', { attrs: { name: 'other' } }) }));
    userTypes(ctx, ctx.fields.city, 'London');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 0, 'no learning before a run');
    await ctx.api.fill();
    userTypes(ctx, ctx.fields.other, 'London');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 0, 'untracked field');
    cleanup(ctx);
  }

  // 7h. Fields the run did not report (already filled, or rendered later by a
  // multi-step form) are tracked without an outline and learned from.
  {
    let late = null;
    const ctx = await learningPage(doc => ({ prefilled: mock.field(doc, 'text', { attrs: { name: 'q_school' }, value: 'Somewhere' }) }));
    const scanned = () => [mock.descFor(ctx.fields.prefilled, 'text', 'School')]
      .concat(late ? [mock.descFor(late, 'text', 'Current company')] : []);
    ctx.core.scanFields = () => scanned();
    await ctx.api.fill();
    assert.ok(!ctx.fields.prefilled.classList.contains('lit-af-unmatched'), 'no outline on a field the run left alone');
    userTypes(ctx, ctx.fields.prefilled, 'University of London');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule.pop(), { host: HOST, labelKey: 'school', profileKey: 'school' });
    // Next step of the form renders; the mutation check tracks it.
    late = mock.field(ctx.doc, 'text', { attrs: { name: 'q_company' } });
    ctx.doc.body.appendChild(late);
    ctx.api.check();
    userTypes(ctx, late, 'Hooli');
    await settle();
    assert.strictEqual(promptText(ctx.doc), 'Current company', 'a late field asks like any other');
    cleanup(ctx);
  }

  // 7i. Custom dropdowns never fire change: a click re-reads every tracked
  // field, and a pick that is a profile value is learned.
  {
    let button = null;
    const ctx = await learningPage(doc => {
      button = doc.createElement('button');
      button.setAttribute('aria-haspopup', 'listbox');
      button.textContent = 'Select One';
      return { button };
    });
    ctx.core.currentValue = desc => (desc.kind === 'combobox'
      ? (desc.el.textContent === 'Select One' ? '' : desc.el.textContent)
      : String(desc.el.value || ''));
    ctx.extraUnmatched = () => [mock.descFor(button, 'combobox', 'Which school do you attend?')];
    await ctx.api.fill();
    assert.ok(button.classList.contains('lit-af-unmatched'));
    button.textContent = 'University of London';  // the page commits the pick
    mock.fire(ctx.doc, ctx.win, ctx.doc.body, 'click'); // the click landed on a portaled option
    await wait(300);
    assert.deepStrictEqual(ctx.store.calls.learnRule, [{ host: HOST, labelKey: 'which school do you attend', profileKey: 'school' }]);
    // Further clicks with no change learn nothing more.
    mock.fire(ctx.doc, ctx.win, ctx.doc.body, 'click');
    await wait(300);
    assert.strictEqual(ctx.store.calls.learnRule.length, 1);
    cleanup(ctx);
  }

  // 7j. A checkbox group: the checked labels are remembered as one answer.
  {
    let en = null;
    let es = null;
    let box = null;
    const ctx = await learningPage(doc => {
      box = doc.createElement('fieldset');
      en = mock.field(doc, 'checkbox', { attrs: { name: 'lang', value: 'English' } });
      es = mock.field(doc, 'checkbox', { attrs: { name: 'lang', value: 'Spanish' } });
      box.appendChild(en);
      box.appendChild(es);
      return { box };
    });
    ctx.core.currentValue = desc => (desc.kind === 'checkbox'
      ? (desc.inputs || [desc.el]).filter(i => i.checked).map(i => i.getAttribute('value')).join(', ')
      : String(desc.el.value || ''));
    ctx.extraUnmatched = () => [mock.descFor(en, 'checkbox', 'Languages', { group: box, inputs: [en, es], options: ['English', 'Spanish'] })];
    await ctx.api.fill();
    en.checked = true;
    es.checked = true;
    mock.fire(ctx.doc, ctx.win, es, 'change');
    await settle();
    assert.strictEqual(promptText(ctx.doc), 'Languages');
    clickPrompt(ctx.doc, 'Save for all sites');
    await settle();
    assert.deepStrictEqual(ctx.store.calls.learnRule, [{ host: '*', labelKey: 'languages', value: 'English, Spanish' }]);
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 8. Sensitive fields are never learned from
  // -------------------------------------------------------------------------
  {
    const ctx = await page(doc => Object.assign(threeTextFields(doc), {
      pw: mock.field(doc, 'password', { attrs: { name: 'pw' } }),
      ssn: mock.field(doc, 'text', { attrs: { name: 'q1' } }),
      social: mock.field(doc, 'text', { attrs: { name: 'q2' } }),
      card: mock.field(doc, 'text', { attrs: { name: 'q3' } }),
      cvv: mock.field(doc, 'text', { attrs: { name: 'cvv' } }),
      iban: mock.field(doc, 'text', { attrs: { name: 'q5', placeholder: 'IBAN' } }),
      routing: mock.field(doc, 'text', { attrs: { name: 'q6' } }),
      ccAuto: mock.field(doc, 'text', { attrs: { name: 'q7', autocomplete: 'cc-number' } }),
      secret: mock.field(doc, 'textarea', { attrs: { name: 'q8' } })
    }));
    const f = ctx.fields;
    const sensitive = [
      mock.descFor(f.pw, 'text', 'Choose a login'),
      mock.descFor(f.ssn, 'text', 'SSN'),
      mock.descFor(f.social, 'text', 'Social Security Number'),
      mock.descFor(f.card, 'text', 'Credit card number'),
      mock.descFor(f.cvv, 'text', 'Security code'),
      mock.descFor(f.iban, 'text', 'Bank account'),
      mock.descFor(f.routing, 'text', 'Bank routing number'),
      mock.descFor(f.ccAuto, 'text', 'Number'),
      mock.descFor(f.secret, 'textarea', 'Paste your password hint')
    ];
    sensitive.forEach(d => assert.ok(ctx.api.isSensitive(d), d.label + ' is sensitive'));
    assert.strictEqual(ctx.api.isSensitive(mock.descFor(f.first, 'text', 'First name')), false);

    ctx.core.setReport(() => ({ filled: [], skipped: [], unmatched: sensitive }));
    await ctx.api.fill();
    // Profile values and arbitrary values alike: no rule, no prompt.
    userTypes(ctx, f.pw, 'ada@example.com');
    userTypes(ctx, f.ssn, '123-45-6789');
    userTypes(ctx, f.social, 'London');
    userTypes(ctx, f.card, '4111 1111 1111 1111');
    userTypes(ctx, f.cvv, '123');
    userTypes(ctx, f.iban, 'GB33BUKB20201555555555');
    userTypes(ctx, f.routing, '021000021');
    userTypes(ctx, f.ccAuto, '4111111111111111');
    f.secret.value = 'my secret hint is long enough to be an answer bank entry';
    mock.fire(ctx.doc, ctx.win, f.secret, 'change');
    mock.fire(ctx.doc, ctx.win, f.secret, 'focusout');
    await settle();
    assert.strictEqual(ctx.store.calls.learnRule.length, 0, 'no rules from sensitive fields');
    assert.strictEqual(ctx.store.calls.saveAnswer.length, 0, 'no answers from sensitive fields');
    assert.strictEqual(promptEl(ctx.doc), null, 'no prompts for sensitive fields');
    cleanup(ctx);
  }

  // -------------------------------------------------------------------------
  // 9. Double injection is idempotent
  // -------------------------------------------------------------------------
  {
    const ctx = await page(threeTextFields);
    const docListeners = mock.docListenerCount(ctx.doc);
    const winListeners = ctx.win.listenerCount();
    const second = load();
    await settle();
    assert.strictEqual(second, ctx.api, 'the second copy hands back the running instance');
    assert.strictEqual(ctx.doc.querySelectorAll('lit-autofill').length, 1, 'one host');
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 1, 'one observer');
    assert.strictEqual(mock.docListenerCount(ctx.doc), docListeners, 'no duplicate document listeners');
    assert.strictEqual(ctx.win.listenerCount(), winListeners, 'no duplicate window listeners');
    assert.strictEqual(ctx.store.listenerCount(), 1, 'one store subscription');
    ctx.win.dispatch('keydown', { altKey: true, shiftKey: true, key: 'F', code: 'KeyF' });
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 1, 'one run per shortcut');
    cleanup(ctx);
  }

  // A host left by an orphaned copy (extension reload: new isolated world,
  // old closed root) is replaced, not duplicated.
  {
    const doc = dom.installDom();
    const stale = doc.createElement('lit-autofill');
    stale.id = 'lit-autofill-host';
    stale.attachShadow({ mode: 'closed' });
    doc.body.appendChild(stale);
    dom.FakeMutationObserver.reset();
    installMockChrome();
    global.document = doc;
    global.window = mock.createWindow();
    global.location = new URL('https://' + HOST + '/x');
    global.AutofillStore = mock.createStore({ profile: PROFILE });
    global.AutofillCore = mock.createCore();
    Object.values(threeTextFields(doc)).forEach(f => doc.body.appendChild(f));
    const api = load();
    await settle();
    assert.strictEqual(doc.querySelectorAll('lit-autofill').length, 1, 'stale host replaced');
    assert.notStrictEqual(doc.getElementById('lit-autofill-host'), stale);
    cleanup({ api });
  }

  // -------------------------------------------------------------------------
  // 10. Teardown: pagehide, bfcache restore, context invalidation
  // -------------------------------------------------------------------------
  {
    const ctx = await learningPage();
    await ctx.api.fill();
    userTypes(ctx, ctx.fields.ref, 'LIT-2026');
    await settle();
    assert.ok(promptEl(ctx.doc), 'a prompt is open');
    // A pending debounced check must not survive pagehide.
    dom.emitAdded(ctx.fields.ref);
    assert.ok(mock.docListenerCount(ctx.doc) > 0);

    ctx.win.dispatch('pagehide', { persisted: true });
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0, 'observer disconnected');
    assert.strictEqual(mock.docListenerCount(ctx.doc), 0, 'document listeners removed');
    assert.strictEqual(ctx.win.listenerCount('keydown'), 0, 'shortcut listener removed');
    assert.strictEqual(ctx.store.listenerCount(), 0, 'store subscription released');
    assert.strictEqual(promptEl(ctx.doc), null, 'prompt closed');
    assert.strictEqual(ctx.api.state().started, false);
    await wait(ctx.api.CHECK_DELAY_MS + 60);
    assert.strictEqual(ctx.api.state().started, false, 'no timer fired after pagehide');

    ctx.win.dispatch('pageshow', { persisted: false });
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0, 'a fresh (non-bfcache) pageshow does nothing');
    ctx.win.dispatch('pageshow', { persisted: true });
    await settle();
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 1, 'bfcache restore re-arms the observer');
    assert.strictEqual(ctx.store.listenerCount(), 1, 'and the store subscription');
    assert.strictEqual(ctx.win.listenerCount('keydown'), 1);

    // Extension reloaded under the page: the old copy removes itself entirely.
    ctx.chrome.runtime.id = undefined;
    ctx.api.check();
    assert.strictEqual(hostEl(ctx.doc), null, 'host removed');
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0);
    assert.strictEqual(mock.docListenerCount(ctx.doc), 0);
    assert.strictEqual(ctx.win.listenerCount(), 0, 'every window listener removed, lifecycle included');
    assert.strictEqual(ctx.store.listenerCount(), 0);
    assert.strictEqual(ctx.fields.first.classList.contains('lit-af-filled'), false, 'outlines removed');
    assert.strictEqual(global.window.__litAutofillUI, undefined, 'a later injection can start clean');
    cleanup({});
  }

  // -------------------------------------------------------------------------
  // 11. Missing globals: the script does nothing
  // -------------------------------------------------------------------------
  {
    const ctx = await page(threeTextFields, { noCore: true });
    assert.strictEqual(hostEl(ctx.doc), null);
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0);
    assert.strictEqual(ctx.win.listenerCount(), 0);
    assert.strictEqual(ctx.win.__litAutofillUI, undefined);
    cleanup({});
  }
  {
    const ctx = await page(threeTextFields, { noStore: true });
    assert.strictEqual(hostEl(ctx.doc), null);
    assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0);
    cleanup({});
  }

  // -------------------------------------------------------------------------
  // The widget moves: drag by the grip, saved per site, restored on the next
  // load, kept out from under the field being edited, hideable per page.
  {
    const ctx = await page(threeTextFields);
    const sh = shadow(ctx.doc);
    const wrap = sh.querySelector('.wrap');
    const dock = sh.querySelector('.dock');
    assert.ok(!dock.classList.contains('hidden'), 'the dock shows with the button');
    assert.strictEqual(wrap.style.right, '16px', 'bottom right by default');
    assert.strictEqual(wrap.style.bottom, '16px');

    // Layout stand-ins: the widget is 200x40 in the bottom-right corner.
    Object.assign(wrap, { offsetWidth: 200, offsetHeight: 40, rectLeft: 1064, rectTop: 744 });
    Object.assign(dock, { offsetWidth: 200, offsetHeight: 40, rectLeft: 1064, rectTop: 744 });

    // Field under the widget: it hops to the top, then back when focus moves.
    const low = ctx.fields.email;
    Object.assign(low, { offsetWidth: 300, offsetHeight: 32, rectLeft: 1000, rectTop: 750 });
    mock.fire(ctx.doc, ctx.win, low, 'focusin');
    assert.strictEqual(ctx.api.position().dodged, true, 'the widget moves off the focused field');
    assert.strictEqual(wrap.style.top, '16px');
    assert.strictEqual(wrap.style.bottom, 'auto');
    assert.ok(wrap.classList.contains('at-top'), 'cards open downward when the widget is at the top');
    const high = ctx.fields.first;
    Object.assign(high, { offsetWidth: 300, offsetHeight: 32, rectLeft: 20, rectTop: 20 });
    mock.fire(ctx.doc, ctx.win, high, 'focusin');
    assert.strictEqual(ctx.api.position().dodged, false, 'and returns once the field is clear');
    assert.strictEqual(wrap.style.bottom, '16px');

    // A press without movement is a click, not a drag.
    const grip = dock.querySelector('.grip');
    const pe = (type, x, y) => dom.makeEvent(type, grip, { pointerId: 1, button: 0, clientX: x, clientY: y, stopPropagation() {} });
    grip.dispatchEvent(pe('pointerdown', 1100, 760));
    grip.dispatchEvent(pe('pointerup', 1101, 760));
    assert.strictEqual(ctx.api.position().h, 'right', 'a 1px wobble does not move it');

    // Drag to the top left; the dock lands at (40, 60).
    grip.dispatchEvent(pe('pointerdown', 1100, 760));
    grip.dispatchEvent(pe('pointermove', 600, 400));
    assert.ok(wrap.classList.contains('dragging'));
    grip.dispatchEvent(pe('pointermove', 76, 76));
    assert.strictEqual(wrap.style.left, '40px', 'follows the pointer');
    assert.strictEqual(wrap.style.top, '60px');
    Object.assign(dock, { rectLeft: 40, rectTop: 60 });
    Object.assign(wrap, { rectLeft: 40, rectTop: 60 });
    grip.dispatchEvent(pe('pointerup', 76, 76));
    await settle();
    assert.ok(!wrap.classList.contains('dragging'));
    assert.deepStrictEqual(ctx.api.position(), { h: 'left', v: 'top', x: 40, y: 60, dodged: false }, 'pinned to the nearest corner');
    assert.ok(wrap.classList.contains('at-left') && wrap.classList.contains('at-top'));
    const saved = ctx.chrome.storage.local.store.lit_af_ui_pos;
    assert.ok(saved && saved[HOST] && saved[HOST].h === 'left' && saved[HOST].y === 60, 'saved for this site');

    // The click that ends a drag does not fill.
    fab(ctx.doc).dispatchEvent(dom.makeEvent('click', fab(ctx.doc), { stopPropagation() {} }));
    await settle();
    assert.strictEqual(ctx.core.calls.run.length, 0, 'dropping the button is not a click');

    // A fresh load on the same site starts where it was left.
    ctx.api.destroy();
    const api2 = load();
    await settle();
    const wrap2 = shadow(ctx.doc).querySelector('.wrap');
    assert.strictEqual(wrap2.style.left, '40px', 'restored on the next load');
    assert.strictEqual(wrap2.style.top, '60px');
    ctx.api = api2;

    // Hide for this page: gone until the user fills on purpose.
    const hide = shadow(ctx.doc).querySelector('.dock .x');
    hide.dispatchEvent(dom.makeEvent('click', hide, { stopPropagation() {} }));
    assert.strictEqual(buttonShown(ctx.doc), false, 'hidden on this page');
    assert.ok(/hidden on this page/.test(toastText(ctx.doc)));
    ctx.api.check();
    assert.strictEqual(buttonShown(ctx.doc), false, 'stays hidden as the page changes');
    await ctx.api.fill();
    await settle();
    assert.strictEqual(buttonShown(ctx.doc), true, 'a deliberate fill brings it back');

    // Cards hold while hovered and close from their own X.
    const card = shadow(ctx.doc).querySelector('.toast');
    card.dispatchEvent(dom.makeEvent('pointerenter', card));
    assert.ok(card.classList.contains('paused'), 'hovering holds the timer');
    card.dispatchEvent(dom.makeEvent('pointerleave', card));
    assert.ok(!card.classList.contains('paused'));
    const x = card.querySelector('.head .x');
    x.dispatchEvent(dom.makeEvent('click', x, { stopPropagation() {} }));
    assert.strictEqual(shadow(ctx.doc).querySelector('.toast'), null, 'X closes the card');

    // A prompt asked for mid-click (change fires on the mousedown that moves
    // to the next field) waits for the press to end, so it cannot land under
    // the pointer and take the click.
    {
      const d = mock.descFor(ctx.fields.last, 'text', 'Last name');
      ctx.core.setReport(() => ({ filled: [], unmatched: [d], skipped: [] }));
      await ctx.api.fill();
      await settle();
      ctx.win.dispatch('pointerdown');
      userTypes(ctx, ctx.fields.last, 'Byron');
      await settle();
      assert.strictEqual(promptEl(ctx.doc), null, 'held while the button is down');
      ctx.win.dispatch('pointerup');
      await wait(5);
      assert.strictEqual(promptText(ctx.doc), 'Last name', 'shown once the press ends');
      const close = promptEl(ctx.doc).querySelector('.head .x');
      close.dispatchEvent(dom.makeEvent('click', close, { stopPropagation() {} }));
    }

    // The service worker's hooks.
    assert.ok(ctx.api.formSize() >= ctx.api.MIN_FIELDS);
    ctx.api.note('Nothing to fill here.');
    assert.strictEqual(toastText(ctx.doc), 'Nothing to fill here.');
    cleanup(ctx);
    console.log('[PASS] Widget: drag by grip or button, per-site position restored, dodges the focused field, hide per page, cards hold on hover');
  }

  console.log('[PASS] autofill-ui: button visibility, shadow DOM, run, learning, sensitive fields, idempotence, teardown');
}

module.exports = { run };
