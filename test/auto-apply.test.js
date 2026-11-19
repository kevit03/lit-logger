// Auto-apply driver (content/autofill/auto-apply.js): a non-batch tab costs
// one HELLO and nothing else; a batch tab is filled, verified, submitted with
// exactly one click and confirmed. Every way it must stop short instead of
// guessing (missing required field, CAPTCHA, ambiguous Submit, refused frame
// claim, validation error, Workday) ends as `needs-you` with no click. Also
// the reload-after-submit check-only path, the Ashby/Lever form URL fixes,
// the apply-button rule, and the required-field scan against the saved
// autofill fixtures. v2: composed answers through LIT_COMPOSE_ANSWER
// (parallel, budgeted, trimmed, adapter fill path), unknown questions left
// empty rather than guessed, and apply-button hops (manual over autofill, new-tab
// links followed in place, sign-in / LinkedIn never pressed, 3 hops per job
// across reloads). Every test checks that no MutationObserver is left
// connected.
const assert = require('assert');
const dom = require('./mock_dom');
const m = require('./mock_auto_apply_c');

const GH_EMBED = 'https://job-boards.greenhouse.io/embed/job_app?for=example&token=4000000001&jr_id=abc';
const ASHBY_FORM = 'https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-00000000aaaa/application?jr_id=abc';

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertNoObservers(label) {
  assert.strictEqual(dom.FakeMutationObserver.activeCount(), 0, label + ': MutationObserver left connected');
}

// Fills the whole Greenhouse embed fixture, like a complete profile would.
function fillGreenhouse(doc, pass) {
  if (pass > 1) return 0;
  m.setValue(doc, 'first_name', 'Ada');
  m.setValue(doc, 'last_name', 'Lovelace');
  m.setValue(doc, 'email', 'ada@example.com');
  m.setValue(doc, 'phone', '5551234567');
  m.attachFile(doc, 'resume', 'ada.pdf');
  m.setValue(doc, 'question_201', 'Because the work matters.');
  m.pickReactSelect(doc, 'question_202', 'No');
  return 7;
}

function submitButton(doc) {
  return doc.querySelector('#application-form button[type="submit"]');
}

function headerApply(doc) {
  return doc.querySelector('.job__header-apply button');
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- non-batch tabs and guards -----------------------------------------------
test('non-batch tab: one HELLO, then no listeners, observers or updates', async () => {
  const bg = m.fakeBackground({ job: null });
  const p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, plan: fillGreenhouse });
  const clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  await wait(30);
  assert.deepStrictEqual(bg.messages.map(x => x.type), ['LIT_BATCH_HELLO']);
  assert.strictEqual(p.api.state().phase, 'inactive');
  assert.strictEqual(p.ui.fills, 0, 'never fills');
  assert.strictEqual(clicks.n, 0);
  assert.strictEqual(p.winListeners.length, 0, 'no window listeners');
  assert.strictEqual(Object.keys(p.doc.listeners).length, 0, 'no document listeners');
  assertNoObservers('non-batch');
});

test('guards: no chrome.runtime, invalidated context, double injection', async () => {
  let p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, noChrome: true });
  await p.api.whenDone();
  assert.strictEqual(p.api.state().phase, 'inactive');

  const bg = m.fakeBackground({ url: GH_EMBED });
  p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, invalidated: true });
  await p.api.whenDone();
  assert.strictEqual(p.api.state().phase, 'inactive');
  assert.strictEqual(bg.messages.length, 0);

  const bg2 = m.fakeBackground({ job: null });
  p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg: bg2 });
  const first = p.api;
  // A second injection into the same frame keeps the running copy.
  delete require.cache[require.resolve(m.DRIVER)];
  const second = require(m.DRIVER);
  assert.strictEqual(second, first);
  await first.whenDone();
  await wait(20);
  assert.strictEqual(bg2.messages.length, 1, 'still one HELLO');
  assertNoObservers('guards');
});

// --- happy path --------------------------------------------------------------
test('happy path: filling -> submitting -> submitted with exactly one click', async () => {
  const p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, plan: fillGreenhouse });
  const submit = submitButton(p.doc);
  const clicks = m.counter(submit);
  const applyClicks = m.counter(headerApply(p.doc));
  submit.addEventListener('click', () => {
    // The form posts and the frame lands on the confirmation page.
    setTimeout(() => {
      p.location.href = 'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=example&token=4000000001';
      m.replaceBody(p.doc, m.readFixture('greenhouse-confirmation.html'));
    }, 20);
  });
  const st = await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'submitting', 'submitted']);
  assert.strictEqual(clicks.n, 1, 'Submit clicked once');
  assert.strictEqual(applyClicks.n, 0, 'the type=button Apply is never clicked');
  assert.strictEqual(p.ui.fills, 2, 'two fill passes');
  assert.strictEqual(st.phase, 'done');
  assert.strictEqual(st.submitClicks, 1);
  const last = p.bg.updates[p.bg.updates.length - 1];
  assert.strictEqual(last.reason, 'Submitted');
  assert.strictEqual(last.filled, 7);
  assert.strictEqual(p.session.getItem('lit_aa_clicked_job1'), '1', 'click remembered for reloads');
  assertNoObservers('happy path');
});

test('Ashby: in-place success view after the submit-class button', async () => {
  const p = m.page({
    fixture: 'ashby-form.html',
    url: ASHBY_FORM,
    plan: (doc, pass) => {
      if (pass > 1) return 0;
      m.setValue(doc, '_systemfield_name', 'Ada Lovelace');
      m.setValue(doc, '_systemfield_email', 'ada@example.com');
      m.attachFile(doc, '_systemfield_resume');
      doc.querySelector('[data-option="yes"]').setAttribute('aria-pressed', 'true');
      return 4;
    }
  });
  const submit = p.doc.querySelector('button.ashby-application-form-submit-button');
  const clicks = m.counter(submit);
  submit.addEventListener('click', () => setTimeout(() => m.replaceBody(p.doc, m.readFixture('ashby-success.html')), 20));
  await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'submitting', 'submitted']);
  assert.strictEqual(clicks.n, 1);
  assert.deepStrictEqual(p.assigned, [], 'already on /application: no navigation');
  assertNoObservers('ashby');
});

// --- stopping short ----------------------------------------------------------
test('missing required -> needs-you with labels, no click', async () => {
  const p = m.page({
    fixture: 'greenhouse-embed.html',
    url: GH_EMBED,
    plan: (doc, pass) => {
      if (pass > 1) return 0;
      m.setValue(doc, 'first_name', 'Ada');
      m.setValue(doc, 'last_name', 'Lovelace');
      m.setValue(doc, 'email', 'ada@example.com');
      return 3;
    }
  });
  const clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'needs-you']);
  const last = p.bg.updates[1];
  assert.strictEqual(last.reason, '3 required fields need you');
  assert.deepStrictEqual(last.missing, ['Resume/CV', 'Why do you want to join us?', 'Will you now or in the future require visa sponsorship?']);
  assert.strictEqual(last.filled, 3);
  assert.strictEqual(clicks.n, 0);
  assertNoObservers('missing');
});

test('Ashby: _required_ title class marks the resume and yes/no as required', async () => {
  const p = m.page({
    fixture: 'ashby-form.html',
    url: ASHBY_FORM,
    plan: (doc, pass) => {
      if (pass > 1) return 0;
      m.setValue(doc, '_systemfield_name', 'Ada Lovelace');
      m.setValue(doc, '_systemfield_email', 'ada@example.com');
      return 2;
    }
  });
  await p.api.whenDone();
  const last = p.bg.updates[p.bg.updates.length - 1];
  assert.strictEqual(last.status, 'needs-you');
  assert.deepStrictEqual(last.missing, ['Resume', 'Are you legally authorized to work in the United States?']);
  assert.strictEqual(last.reason, '2 required fields need you');
  assertNoObservers('ashby required');
});

test('fill-only -> ready, no click', async () => {
  const bg = m.fakeBackground({ url: GH_EMBED, mode: 'fill-only' });
  const p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, plan: fillGreenhouse });
  const clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'ready']);
  assert.strictEqual(bg.updates[1].reason, 'Filled. Review and submit.');
  assert.strictEqual(clicks.n, 0);
  assertNoObservers('fill-only');
});

test('visible CAPTCHA challenge -> needs-you, no click', async () => {
  const p = m.page({
    fixture: 'greenhouse-embed.html',
    url: GH_EMBED,
    plan: (doc, pass) => {
      const n = fillGreenhouse(doc, pass);
      // The challenge pops up: reCAPTCHA moves its frame on screen.
      const frame = doc.querySelector('iframe[src*="bframe"]');
      delete frame.parentElement.attributes['data-test-offscreen'];
      m.layout(doc);
      return n;
    }
  });
  const clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'needs-you']);
  assert.strictEqual(p.bg.updates[1].reason, 'CAPTCHA');
  assert.strictEqual(clicks.n, 0);
  assertNoObservers('captcha');
});

test('ambiguous Submit -> needs-you "Could not find Submit"', async () => {
  const p = m.page({
    fixture: 'greenhouse-embed.html',
    url: GH_EMBED,
    plan: fillGreenhouse,
    prepare: doc => {
      const wrap = doc.querySelector('.application--submit');
      wrap.appendChild(require('./mock_autofill_4').html(doc, '<button type="submit" class="btn">Submit</button>'));
    }
  });
  const clicks = p.doc.querySelectorAll('button[type="submit"]').map(b => m.counter(b));
  await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'needs-you']);
  assert.strictEqual(p.bg.updates[1].reason, 'Could not find Submit');
  assert.ok(clicks.every(c => c.n === 0));
  assertNoObservers('ambiguous');
});

test('missing Submit on a generic site -> needs-you', async () => {
  const html = '<form id="f"><label for="a">Name *</label><input id="a" required value="x">' +
    '<label for="b">Email</label><input id="b" type="email" value="y"><label for="c">Phone</label><input id="c" type="tel" value="z">' +
    '<button type="button">Next</button></form>';
  const bg = m.fakeBackground({ url: 'https://careers.example.com/apply/1' });
  const p = m.page({ html, url: 'https://careers.example.com/apply/1', bg, plan: () => 0 });
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'needs-you']);
  assert.strictEqual(bg.updates[1].reason, 'Could not find Submit');
  assertNoObservers('no submit');
});

test('frame claim refused -> stops without filling', async () => {
  const bg = m.fakeBackground({ url: GH_EMBED, refuseClaim: true });
  const p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, plan: fillGreenhouse });
  const clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  await wait(30);
  assert.deepStrictEqual(bg.messages.map(x => x.type + ':' + (x.status || '')), ['LIT_BATCH_HELLO:', 'LIT_BATCH_UPDATE:filling']);
  assert.strictEqual(p.api.state().phase, 'stopped');
  assert.strictEqual(p.ui.fills, 0);
  assert.strictEqual(clicks.n, 0);
  assertNoObservers('claim refused');
});

test('reload with status submitting: checks for success only, never clicks', async () => {
  // Back on the form (no confirmation): wait, then needs-you.
  let bg = m.fakeBackground({ url: GH_EMBED, job: { status: 'submitting' } });
  let p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, plan: fillGreenhouse, timing: { successWait: 120 } });
  let clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['needs-you']);
  assert.strictEqual(bg.updates[0].reason, 'Submitted but no confirmation seen');
  assert.strictEqual(clicks.n, 0);
  assert.strictEqual(p.ui.fills, 0, 'no refill after submit');

  // On the confirmation page: submitted.
  bg = m.fakeBackground({ job: { status: 'submitting' } });
  p = m.page({ fixture: 'greenhouse-confirmation.html', url: 'https://job-boards.greenhouse.io/embed/job_app/confirmation?for=example', bg });
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['submitted']);

  // The tab remembers the click even if HELLO still says filling.
  bg = m.fakeBackground({ url: GH_EMBED, job: { status: 'filling' } });
  const session = m.makeSession({ lit_aa_clicked_job1: '1' });
  p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, session, plan: fillGreenhouse, timing: { successWait: 80 } });
  clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  assert.strictEqual(clicks.n, 0);
  assert.strictEqual(p.ui.fills, 0);
  assertNoObservers('reload');
});

test('validation error after the click -> needs-you, one click', async () => {
  const p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, plan: fillGreenhouse });
  const submit = submitButton(p.doc);
  const clicks = m.counter(submit);
  submit.addEventListener('click', () => {
    setTimeout(() => {
      const email = p.doc.getElementById('email');
      email.setAttribute('aria-invalid', 'true');
      const err = p.doc.getElementById('email-error');
      delete err.attributes.hidden;
      err.textContent = 'Enter a valid email address';
      dom.emitAdded(err);
    }, 10);
  });
  await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'submitting', 'needs-you']);
  const last = p.bg.updates[2];
  assert.strictEqual(last.reason, '1 field shows an error');
  assert.deepStrictEqual(last.missing, ['Email']);
  assert.strictEqual(clicks.n, 1);
  assertNoObservers('validation');
});

test('no confirmation after the click -> needs-you, never resubmits', async () => {
  const p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, plan: fillGreenhouse, timing: { successWait: 120 } });
  const clicks = m.counter(submitButton(p.doc));
  await p.api.whenDone();
  assert.deepStrictEqual(p.bg.statuses(), ['filling', 'submitting', 'needs-you']);
  assert.strictEqual(p.bg.updates[2].reason, 'Submitted but no confirmation seen');
  assert.strictEqual(clicks.n, 1);
  assertNoObservers('no confirmation');
});

test('Workday -> needs-you "Workday needs you to sign in"', async () => {
  const url = 'https://example.wd5.myworkdayjobs.com/en-US/External/job/Remote/Software-Engineer_R1/apply';
  const bg = m.fakeBackground({ url });
  const p = m.page({ fixture: 'workday-current.html', url, bg, plan: () => 5 });
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'needs-you']);
  assert.strictEqual(bg.updates[1].reason, 'Workday needs you to sign in');
  assert.strictEqual(p.ui.fills, 0);
  assertNoObservers('workday');
});

// --- getting to the form -----------------------------------------------------
test('Ashby and Lever URL fixups, once per tab', async () => {
  const posting = 'https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-00000000aaaa?jr_id=abc';
  let bg = m.fakeBackground({ url: posting });
  let p = m.page({ html: '<div><h1>Software Engineer</h1></div>', url: posting, bg });
  await p.api.whenDone();
  assert.deepStrictEqual(p.assigned, ['https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-00000000aaaa/application?jr_id=abc']);
  assert.deepStrictEqual(bg.statuses(), [], 'no status before the form');
  assert.strictEqual(p.api.state().phase, 'navigating');

  // Redirected back to the posting: no second navigation, waits for a form.
  const session = p.session;
  bg = m.fakeBackground({ url: posting });
  p = m.page({ html: '<div><h1>Software Engineer</h1></div>', url: posting, bg, session, timing: { formWait: 60 } });
  await p.api.whenDone();
  assert.deepStrictEqual(p.assigned, []);
  assert.strictEqual(p.api.state().phase, 'no-form');
  assert.deepStrictEqual(bg.statuses(), [], 'a frame with no form stops silently');

  const lever = 'https://jobs.lever.co/example/00000000-0000-4000-8000-00000000bbbb';
  bg = m.fakeBackground({ url: lever });
  p = m.page({ html: '<div><a href="' + lever + '/apply">Apply for this job</a></div>', url: lever, bg });
  await p.api.whenDone();
  assert.deepStrictEqual(p.assigned, [lever + '/apply']);

  const fix = p.api.formUrlFix;
  assert.strictEqual(fix(new URL(lever + '/apply')), null);
  assert.strictEqual(fix(new URL(ASHBY_FORM)), null);
  assert.strictEqual(fix(new URL('https://jobs.ashbyhq.com/example')), null, 'a board, not a posting');
  assert.strictEqual(fix(new URL(GH_EMBED)), null);
  assertNoObservers('fixups');
});

test('apply-phrase rule: clicks "Apply", ignores "Apply with LinkedIn"', async () => {
  const url = 'https://boards.greenhouse.io/example/jobs/4000000001';
  const html = '<div id="top"><h1>Software Engineer</h1>' +
    '<button type="button" id="li">Apply with LinkedIn</button>' +
    '<a id="signin" href="/users/sign_in">Apply</a>' +
    '<a id="newtab" href="https://example.com/apply" target="_blank">Apply now</a>' +
    '<button type="button" id="apply">Apply</button></div>';
  const bg = m.fakeBackground({ url });
  const p = m.page({ html, url, bg, plan: fillGreenhouse });
  const li = m.counter(p.doc.getElementById('li'));
  const signin = m.counter(p.doc.getElementById('signin'));
  const newtab = m.counter(p.doc.getElementById('newtab'));
  const apply = m.counter(p.doc.getElementById('apply'));
  let submitClicks = null;
  p.doc.getElementById('apply').addEventListener('click', () => {
    setTimeout(() => {
      m.replaceBody(p.doc, m.readFixture('greenhouse-embed.html'));
      const submit = submitButton(p.doc);
      submitClicks = m.counter(submit);
      submit.addEventListener('click', () => setTimeout(() => m.replaceBody(p.doc, m.readFixture('greenhouse-confirmation.html')), 10));
    }, 10);
  });
  await p.api.whenDone();
  assert.strictEqual(li.n, 0, 'Apply with LinkedIn ignored');
  assert.strictEqual(signin.n, 0, 'sign-in link ignored');
  assert.strictEqual(newtab.n, 0, 'new-tab link ignored');
  assert.strictEqual(apply.n, 1, 'Apply clicked once');
  assert.ok(submitClicks && submitClicks.n === 1);
  assert.deepStrictEqual(bg.statuses(), ['filling', 'submitting', 'submitted']);
  assertNoObservers('apply rule');
});

// --- seams -------------------------------------------------------------------
test('findSubmit: site rules and the generic fallback', () => {
  let p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg: m.fakeBackground({ job: null }) });
  assert.strictEqual(p.api.findSubmit(p.doc, GH_EMBED).textContent, 'Submit application');

  p = m.page({ fixture: 'lever.html', url: 'https://jobs.lever.co/example/x/apply', bg: m.fakeBackground({ job: null }) });
  assert.strictEqual(p.api.findSubmit(p.doc, 'https://jobs.lever.co/example/x/apply').getAttribute('data-qa'), 'btn-submit');

  const html = '<form><input id="a"><input id="b"><input id="c"><button type="submit">Apply with LinkedIn</button><button type="submit">Save draft</button>' +
    '<button>Send application</button></form><form><input id="q"><button type="submit">Apply filters</button></form>';
  p = m.page({ html, url: 'https://careers.example.com/x', bg: m.fakeBackground({ job: null }) });
  const generic = p.api.findSubmit(p.doc, 'https://careers.example.com/x');
  assert.strictEqual(generic && generic.textContent, 'Send application');
});

test('detectCaptcha: visible challenges only', () => {
  const bg = m.fakeBackground({ job: null });
  let p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg });
  assert.strictEqual(p.api.detectCaptcha(p.doc), null, 'parked invisible reCAPTCHA is not a challenge');
  p = m.page({ html: '<div><iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox"></iframe></div>', bg });
  assert.strictEqual(p.api.detectCaptcha(p.doc), 'hCaptcha');
  p = m.page({ html: '<div><div class="cf-turnstile" data-sitekey="x"></div></div>', bg });
  assert.strictEqual(p.api.detectCaptcha(p.doc), 'Turnstile');
  p = m.page({ html: '<div><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&amp;size=invisible"></iframe></div>', bg });
  assert.strictEqual(p.api.detectCaptcha(p.doc), null);
  p = m.page({ html: '<div><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&amp;size=normal"></iframe></div>', bg });
  assert.strictEqual(p.api.detectCaptcha(p.doc), 'reCAPTCHA');
});

test('isSuccess: URL, selector, and text only once the form is gone', () => {
  const bg = m.fakeBackground({ job: null });
  let p = m.page({ html: '<div><h2>Done</h2></div>', url: 'https://jobs.lever.co/example/x/thanks', bg });
  assert.ok(p.api.isSuccess(p.doc, 'https://jobs.lever.co/example/x/thanks'));
  p = m.page({ fixture: 'greenhouse-confirmation.html', url: GH_EMBED, bg });
  assert.ok(p.api.isSuccess(p.doc, GH_EMBED));
  p = m.page({ fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, prepare: doc => {
    doc.querySelector('.job__header').appendChild(require('./mock_autofill_4').html(doc, '<p>Once your application is submitted, we will be in touch.</p>'));
  } });
  assert.ok(!p.api.isSuccess(p.doc, GH_EMBED), 'boilerplate under a live form is not success');
  // A company slug that happens to say "success", with the form still up.
  assert.ok(!p.api.isSuccess(p.doc, 'https://jobs.ashbyhq.com/customer-success/x/application'));
});

test('missingRequired: saved autofill fixtures', () => {
  const bg = m.fakeBackground({ job: null });
  let p = m.page({ fixture: 'greenhouse.html', url: 'https://job-boards.greenhouse.io/example/jobs/1', bg });
  const gh = p.api.missingRequired(p.doc);
  assert.strictEqual(gh.length, 8, JSON.stringify(gh));
  ['First Name', 'Last Name', 'Email', 'Location (City)', 'Resume/CV', 'Why do you want to join us?'].forEach(l => assert.ok(gh.includes(l), 'greenhouse missing ' + l + ': ' + JSON.stringify(gh)));
  assert.ok(gh.some(l => /sponsorship/.test(l)) && gh.some(l => /legally authorized/.test(l)), 'react-select questions');
  ['Preferred First Name', 'Phone', 'Country', 'Gender', 'Cover Letter'].forEach(l => assert.ok(!gh.includes(l), 'not required: ' + l));

  // Answer the two react-select questions: they leave the list.
  m.pickReactSelect(p.doc, 'question_1000000105', 'No');
  m.pickReactSelect(p.doc, 'question_1000000106', 'Yes');
  assert.strictEqual(p.api.missingRequired(p.doc).length, 6);

  p = m.page({ fixture: 'lever.html', url: 'https://jobs.lever.co/example/x/apply', bg });
  const lv = p.api.missingRequired(p.doc);
  ['Resume/CV', 'Full name', 'Email', 'Current location'].forEach(l => assert.ok(lv.includes(l), 'lever missing ' + l + ': ' + JSON.stringify(lv)));
  assert.ok(lv.some(l => /university/.test(l)), 'required select on placeholder');
  assert.ok(lv.some(l => /Language Skill/.test(l)), 'required checkbox group with nothing checked');
  assert.ok(lv.length <= 10);
  assert.ok(lv.every(l => l.length <= 80 && !/\*/.test(l)));
});

test('missingRequired: radio group, combobox placeholder, cap at 10', () => {
  const bg = m.fakeBackground({ job: null });
  let html = '<form><fieldset><legend>Are you 18 or older? *</legend>' +
    '<label><input type="radio" name="age" value="y" required> Yes</label><label><input type="radio" name="age" value="n"> No</label></fieldset>' +
    '<label id="lvl">Seniority *</label><button type="button" role="combobox" aria-required="true" aria-labelledby="lvl">Select...</button>' +
    '<label for="ssn">Notes</label><input id="ssn" type="text"></form>';
  let p = m.page({ html, url: 'https://careers.example.com/x', bg });
  assert.deepStrictEqual(p.api.missingRequired(p.doc), ['Are you 18 or older?', 'Seniority']);
  p.doc.querySelector('input[value="y"]').checked = true;
  assert.deepStrictEqual(p.api.missingRequired(p.doc), ['Seniority']);

  html = '<form>' + Array.from({ length: 14 }, (_, i) => '<label for="f' + i + '">Question ' + i + ' *</label><input id="f' + i + '" type="text">').join('') + '</form>';
  p = m.page({ html, url: 'https://careers.example.com/x', bg });
  assert.strictEqual(p.api.missingRequired(p.doc).length, 10);
});

// --- v2: composed answers; nothing is guessed --------------------------------
const GH_V2 = 'https://job-boards.greenhouse.io/embed/job_app?for=example&token=5000000001';

function fillIdentity(doc, pass) {
  if (pass > 1) return 0;
  m.setValue(doc, 'first_name', 'Ada');
  m.setValue(doc, 'last_name', 'Lovelace');
  m.setValue(doc, 'email', 'ada@example.com');
  return 3;
}

// Autofill that also knows the certification box (a saved answer would).
function fillKnown(doc, pass) {
  if (pass > 1) return 0;
  fillIdentity(doc, pass);
  doc.getElementById('certify').checked = true;
  return 4;
}

// A background answer writer: text questions get a sentence, the
// authorization question gets "yes" (matched to the "Yes" option), every
// other choice gets NONE. Each answer takes 20 ms so requests overlap.
function writer(msg) {
  let res;
  if (msg.kind === 'text') res = { ok: true, text: 'I want to build payment rails. ' + 'x'.repeat(10), source: 'local' };
  else if (/authorized/.test(msg.question)) res = { ok: true, choice: 'yes', source: 'ai' };
  else res = { ok: true, choice: 'NONE', source: 'ai' };
  return new Promise(resolve => setTimeout(() => resolve(res), 20));
}

// A writer whose profile answers every required choice on the v2 form.
const KNOWN = [
  [/authorized/, 'Yes'], [/sponsorship/, 'No'], [/hear about/, 'Job board'],
  [/Gender/, 'Decline to self-identify'], [/employed|worked/i, 'No']
];
function knownWriter(msg) {
  if (msg.kind === 'text') return { ok: true, text: 'I want to build payment rails.', source: 'local' };
  const hit = KNOWN.find(([re]) => re.test(msg.question));
  return hit ? { ok: true, choice: hit[1], source: 'ai' } : { ok: true, choice: 'NONE', source: 'ai' };
}

function v2Page(opts = {}) {
  const bg = m.fakeBackground(Object.assign({ url: GH_V2 }, opts.bg || {}));
  const p = m.page(Object.assign({ fixture: 'greenhouse-v2.html', url: GH_V2, bg, plan: fillIdentity }, opts.page || {}));
  const submit = submitButton(p.doc);
  const clicks = m.counter(submit);
  submit.addEventListener('click', () => setTimeout(() => m.replaceBody(p.doc, m.readFixture('greenhouse-confirmation.html')), 20));
  // Held before the run: the confirmation page replaces the form.
  const els = {};
  ['why', 'project', 'extra', 'auth', 'sponsor', 'hear', 'gender', 'prior_yes', 'prior_no', 'sms', 'marketing', 'certify']
    .forEach(id => { els[id] = p.doc.getElementById(id); });
  p.els = els;
  return { p, bg, clicks };
}

const byId = (p, id) => (p.els && p.els[id]) || p.doc.getElementById(id);

test('v2: only known answers are filled; nothing is guessed -> needs you, no click', async () => {
  const { p, bg, clicks } = v2Page({ bg: { compose: writer } });
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'needs-you']);
  assert.strictEqual(clicks.n, 0, 'Submit never clicked');

  // Known: composed from the profile and answer bank.
  assert.ok(/^I want to build payment rails\./.test(byId(p, 'why').value), 'required open question written');
  assert.ok(byId(p, 'project').value, 'optional substantive question written');
  assert.strictEqual(byId(p, 'extra').value, '', '"anything else" needs AI, which is off');
  assert.strictEqual(byId(p, 'auth').value, 'Yes', 'choice answer matched to the option');

  // Unknown: left alone, no typical-applicant or neutral picks.
  assert.strictEqual(byId(p, 'sponsor').value, 'Select...', 'NONE stays empty, no "Prefer not to say"');
  assert.strictEqual(byId(p, 'hear').value, 'Select...');
  assert.strictEqual(byId(p, 'gender').value, 'Select...', 'no "Decline to self-identify" guess');
  assert.strictEqual(byId(p, 'prior_yes').checked, false);
  assert.strictEqual(byId(p, 'prior_no').checked, false);
  ['sms', 'marketing', 'certify'].forEach(id => assert.strictEqual(byId(p, id).checked, false, id + ' left unchecked'));

  const reqs = bg.composeRequests;
  const why = reqs.find(r => /Why do you/.test(r.question));
  assert.strictEqual(why.maxLength, 500, 'maxlength attribute');
  assert.strictEqual(why.required, true);
  assert.strictEqual(reqs.find(r => /project/.test(r.question)).maxLength, 1500, 'default length');
  assert.deepStrictEqual(reqs.find(r => /authorized/.test(r.question)).options, ['Yes', 'No']);
  reqs.forEach(r => {
    assert.strictEqual(r.job.title, 'Software Engineer');
    assert.strictEqual(r.job.company, 'Example Co');
    assert.ok(r.job.description.includes('payment rails for small businesses'), 'page text outside the form');
    assert.ok(!r.job.description.includes('Why do you want'), 'form text left out');
    assert.ok(r.job.description.length <= 6000);
  });
  assert.ok(bg.maxInFlight >= 2 && bg.maxInFlight <= 3, 'up to 3 in flight, got ' + bg.maxInFlight);
  assert.strictEqual(bg.messages.filter(x => x.type === 'LIT_BATCH_CAPS').length, 1, 'caps asked once, for the AI-only question; no answer means no AI');

  const last = bg.updates[1];
  assert.strictEqual(last.composed, 3, 'why, project, authorization');
  assert.strictEqual(last.filled, 6, 'autofill 3 + composed 3');
  assert.strictEqual(last.decided, undefined, 'no discretion count any more');
  ['Will you now or in the future require visa sponsorship?', 'How did you hear about this job?', 'Gender',
    'I certify that the information provided is true'].forEach(q => assert.ok(last.missing.includes(q), 'missing: ' + q));
  assert.ok(!last.missing.includes('Are you legally authorized to work in the United States?'));
  assertNoObservers('v2 unknowns');
});

test('v2: every required question known -> submitted with one click', async () => {
  const { p, bg, clicks } = v2Page({ bg: { compose: knownWriter }, page: { plan: fillKnown } });
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'submitting', 'submitted']);
  assert.strictEqual(clicks.n, 1, 'Submit clicked once');
  assert.strictEqual(byId(p, 'sponsor').value, 'No');
  assert.strictEqual(byId(p, 'hear').value, 'Job board');
  assert.strictEqual(byId(p, 'prior_no').checked, true);
  assert.strictEqual(byId(p, 'sms').checked, false, 'optional boxes nothing answers stay unchecked');
  assert.strictEqual(byId(p, 'marketing').checked, false);
  assertNoObservers('v2 happy');
});

test('v2: AI on -> "anything else" is composed too; caps asked once', async () => {
  const { p, bg } = v2Page({ bg: { compose: knownWriter, caps: { allSites: true, ai: true } }, page: { plan: fillKnown } });
  await p.api.whenDone();
  assert.ok(byId(p, 'extra').value, 'catch-all question written with AI on');
  assert.strictEqual(bg.messages.filter(x => x.type === 'LIT_BATCH_CAPS').length, 1);
  assert.strictEqual(bg.updates[bg.updates.length - 1].composed, 8, 'why, project, extra + 5 required choices');
  assert.deepStrictEqual(bg.statuses(), ['filling', 'submitting', 'submitted']);
});

test('v2: composed text is trimmed to maxlength at a sentence', async () => {
  const long = 'First sentence here. ' + 'Second sentence goes on and on. '.repeat(30);
  const { p } = v2Page({ bg: { compose: msg => (msg.kind === 'text' ? { ok: true, text: long, source: 'ai' } : { ok: false, reason: 'no-ai' }) } });
  await p.api.whenDone();
  const v = byId(p, 'why').value;
  assert.ok(v.length <= 500, 'length ' + v.length);
  assert.ok(/\.$/.test(v), 'ends at a sentence: ' + v.slice(-20));
});

test('v2: no answer writer -> every unanswered required field needs you', async () => {
  const { p, bg, clicks } = v2Page();
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'needs-you']);
  const last = bg.updates[1];
  assert.deepStrictEqual(last.missing, [
    'Why do you want to work at Example Co?',
    'Are you legally authorized to work in the United States?',
    'Will you now or in the future require visa sponsorship?',
    'How did you hear about this job?',
    'Gender',
    'Have you ever been employed by Example Co?',
    'I certify that the information provided is true'
  ]);
  assert.strictEqual(last.reason, '7 required fields need you');
  assert.strictEqual(last.composed, 0);
  assert.strictEqual(byId(p, 'auth').value, 'Select...', 'authorization is never guessed');
  assert.strictEqual(clicks.n, 0);
  assertNoObservers('v2 no writer');
});

test('v2: a compose request past its budget is dropped', async () => {
  const started = Date.now();
  const { p, bg } = v2Page({ bg: { compose: () => new Promise(() => {}) }, page: { timing: { composeBudget: 60 } } });
  await p.api.whenDone();
  assert.deepStrictEqual(bg.statuses(), ['filling', 'needs-you']);
  assert.ok(Date.now() - started < 2000, 'did not wait forever');
  assert.strictEqual(bg.updates[1].composed, 0);
});

test('v2: refused or invalid answers are not applied', async () => {
  const { p, bg } = v2Page({ bg: { compose: msg => (msg.kind === 'choice' ? { ok: true, choice: 'Maybe', source: 'ai' } : { ok: false, reason: 'refusal' }) } });
  await p.api.whenDone();
  assert.strictEqual(byId(p, 'auth').value, 'Select...', 'a choice outside the options is ignored');
  assert.strictEqual(byId(p, 'why').value, '');
  assert.strictEqual(bg.statuses()[1], 'needs-you');
});

test('v2: a required choice nothing answers stays empty, whatever its options', async () => {
  const html = '<form id="f">' +
    '<label for="n">Name *</label><input id="n" required>' +
    '<label for="office">Which office location would you prefer? *</label><select id="office" required><option>Select...</option><option>New York</option><option>London</option><option>Other</option></select>' +
    '<label for="team">Which team interests you most? *</label><select id="team" required><option>Select...</option><option>Payments</option><option>Risk</option><option>Other</option></select>' +
    '<label for="vet">Are you a protected veteran? *</label><select id="vet" required><option>Select...</option><option>Yes</option><option>No</option><option>N/A</option><option>Prefer not to say</option></select>' +
    '<button type="submit">Submit application</button></form>';
  const url = 'https://careers.example.com/apply/9';
  const bg = m.fakeBackground({ url, compose: () => ({ ok: false, reason: 'undetermined' }) });
  const p = m.page({ html, url, bg, plan: (doc, pass) => { if (pass === 1) m.setValue(doc, 'n', 'Ada'); return pass === 1 ? 1 : 0; } });
  await p.api.whenDone();
  ['office', 'team', 'vet'].forEach(id => assert.strictEqual(byId(p, id).value, 'Select...', id + ' not guessed'));
  assert.deepStrictEqual(bg.updates[1].missing, ['Which office location would you prefer?', 'Which team interests you most?', 'Are you a protected veteran?']);
  assert.deepStrictEqual(bg.statuses(), ['filling', 'needs-you']);
  assertNoObservers('no guess');
});

test('v2: custom widgets go through the site adapter fill, like AutofillCore.run', async () => {
  const calls = [];
  const adapter = {
    id: 'test-greenhouse',
    matches: u => /greenhouse\.io$/.test(new URL(String(u && u.href ? u.href : u)).hostname),
    scanRoot: doc => doc.querySelector('#application-form'),
    fill(desc, value) {
      calls.push({ id: desc.el.id, value });
      if (desc.el.id === 'question_202') { m.pickReactSelect(desc.el.ownerDocument, 'question_202', value); return true; }
      return undefined;
    }
  };
  const bg = m.fakeBackground({ url: GH_EMBED, compose: msg => (msg.kind === 'text' ? { ok: true, text: 'Because the work matters.', source: 'local' } : { ok: true, choice: 'No', source: 'ai' }) });
  const p = m.page({
    fixture: 'greenhouse-embed.html', url: GH_EMBED, bg, adapters: [adapter],
    plan: (doc, pass) => {
      if (pass > 1) return 0;
      ['first_name', 'last_name', 'email'].forEach(id => m.setValue(doc, id, 'x'));
      m.attachFile(doc, 'resume', 'ada.pdf');
      return 4;
    }
  });
  const submit = submitButton(p.doc);
  const q201 = p.doc.getElementById('question_201');
  submit.addEventListener('click', () => setTimeout(() => m.replaceBody(p.doc, m.readFixture('greenhouse-confirmation.html')), 20));
  await p.api.whenDone();
  const choiceReq = bg.composeRequests.find(r => r.kind === 'choice');
  assert.deepStrictEqual(choiceReq.options, ['Yes', 'No'], 'an option-less yes/no dropdown is offered Yes / No');
  assert.ok(!bg.messages.some(x => x.type === 'LIT_BATCH_CAPS'), 'caps only asked when an AI-only question exists');
  assert.ok(calls.some(c => c.id === 'question_202' && c.value === 'No'), 'react-select answered through the adapter');
  assert.ok(calls.some(c => c.id === 'question_201'), 'the adapter sees text fields first and passes');
  assert.strictEqual(q201.value, 'Because the work matters.', 'core setValue after the adapter passes');
  assert.deepStrictEqual(bg.statuses(), ['filling', 'submitting', 'submitted']);
  assertNoObservers('adapter');
});

// --- v2: apply-button hops -----------------------------------------------------
const POSTING = 'https://careers.example.com/jobs/42';

function showForm(p) {
  m.replaceBody(p.doc, m.readFixture('greenhouse-embed.html'));
}

test('hops: "Apply for this job" opens the chooser; "Apply manually" beats autofill / LinkedIn / Indeed / sign-in', async () => {
  const bg = m.fakeBackground({ url: POSTING });
  const p = m.page({ fixture: 'posting-apply-modal.html', url: POSTING, bg, plan: fillGreenhouse });
  const ids = ['apply-job', 'autofill-resume', 'apply-linkedin', 'apply-indeed', 'apply-manual', 'signin', 'create'];
  const c = Object.fromEntries(ids.map(id => [id, m.counter(p.doc.getElementById(id))]));
  p.doc.getElementById('apply-job').addEventListener('click', () => setTimeout(() => {
    delete p.doc.getElementById('chooser').attributes.hidden;
    dom.emitAdded(p.doc.getElementById('chooser'));
  }, 5));
  let submitClicks = null;
  p.doc.getElementById('apply-manual').addEventListener('click', () => setTimeout(() => {
    showForm(p);
    const submit = submitButton(p.doc);
    submitClicks = m.counter(submit);
    submit.addEventListener('click', () => setTimeout(() => m.replaceBody(p.doc, m.readFixture('greenhouse-confirmation.html')), 10));
  }, 5));
  await p.api.whenDone();
  assert.strictEqual(c['apply-job'].n, 1, 'Apply for this job (with its arrow icon) clicked');
  assert.strictEqual(c['apply-manual'].n, 1, 'Apply manually clicked');
  ['autofill-resume', 'apply-linkedin', 'apply-indeed', 'signin', 'create'].forEach(id => assert.strictEqual(c[id].n, 0, id + ' never clicked'));
  assert.deepStrictEqual(p.assigned, [], 'the Indeed link is not followed');
  assert.strictEqual(p.session.getItem('lit_aa_hops_job1'), '2');
  assert.ok(submitClicks && submitClicks.n === 1);
  assert.deepStrictEqual(bg.statuses(), ['filling', 'submitting', 'submitted']);
  assertNoObservers('chooser');
});

test('hops: a target=_blank or cross-origin apply link is followed in the same tab', async () => {
  const html = '<div><h1>Software Engineer</h1><a id="ext" href="https://boards.greenhouse.io/example/jobs/1" target="_blank" rel="noopener">Apply on company site \u2197</a></div>';
  const bg = m.fakeBackground({ url: 'https://jobright.ai/jobs/info/abc' });
  const p = m.page({ html, url: 'https://jobright.ai/jobs/info/abc', bg });
  const clicks = m.counter(p.doc.getElementById('ext'));
  await p.api.whenDone();
  assert.deepStrictEqual(p.assigned, ['https://boards.greenhouse.io/example/jobs/1']);
  assert.strictEqual(clicks.n, 0, 'navigated, not clicked (a click would open a new tab)');
  assert.strictEqual(p.api.state().phase, 'navigating');
  assert.strictEqual(p.session.getItem('lit_aa_hops_job1'), '1');
  assert.deepStrictEqual(bg.statuses(), [], 'no status before a form');

  const html2 = '<div><a id="x" href="https://jobs.lever.co/example/1">Apply now</a></div>';
  const bg2 = m.fakeBackground({ url: POSTING });
  const p2 = m.page({ html: html2, url: POSTING, bg: bg2 });
  await p2.api.whenDone();
  assert.deepStrictEqual(p2.assigned, ['https://jobs.lever.co/example/1'], 'cross-origin link without a target');
  assertNoObservers('new tab');
});

test('hops: "Apply with LinkedIn", "Sign in", and "Create account" alone -> nothing pressed', async () => {
  const html = '<div><h1>Software Engineer</h1>' +
    '<button type="button" id="li">Apply with LinkedIn</button>' +
    '<button type="button" id="google">Apply with Google</button>' +
    '<a id="si" href="/login">Sign in</a>' +
    '<button type="button" id="ca">Create account</button>' +
    '<a id="ap" href="/users/sign_in?return=/apply">Apply</a>' +
    '<button type="button" id="easy">Easy Apply</button></div>';
  const bg = m.fakeBackground({ url: POSTING });
  const p = m.page({ html, url: POSTING, bg, timing: { formWait: 120 } });
  const c = ['li', 'google', 'si', 'ca', 'ap', 'easy'].map(id => m.counter(p.doc.getElementById(id)));
  await p.api.whenDone();
  assert.ok(c.every(x => x.n === 0), 'none clicked');
  assert.deepStrictEqual(p.assigned, []);
  assert.strictEqual(p.api.state().phase, 'no-form');
  assert.strictEqual(p.session.getItem('lit_aa_hops_job1'), null);
  assertNoObservers('linkedin only');
});

test('hops: limit of 3 per job holds across reloads', async () => {
  const html = '<div><button type="button" id="a">I’m interested</button></div>';
  // Two hops already made on earlier loads: one more is allowed.
  const session = m.makeSession({ lit_aa_hops_job1: '2' });
  const bg = m.fakeBackground({ url: POSTING });
  const p = m.page({ html, url: POSTING, bg, session, timing: { formWait: 150 } });
  const first = m.counter(p.doc.getElementById('a'));
  let second = null;
  p.doc.getElementById('a').addEventListener('click', () => setTimeout(() => {
    m.replaceBody(p.doc, '<div><button type="button" id="b">Continue to application</button></div>');
    second = m.counter(p.doc.getElementById('b'));
  }, 5));
  await p.api.whenDone();
  assert.strictEqual(first.n, 1, '"I’m interested" pressed as the third hop');
  assert.ok(second && second.n === 0, 'a fourth hop is refused');
  assert.strictEqual(session.getItem('lit_aa_hops_job1'), '3');
  assert.strictEqual(p.api.state().phase, 'no-form');

  // The next load (same tab) presses nothing at all.
  const bg2 = m.fakeBackground({ url: POSTING });
  const p2 = m.page({ html: '<div><button type="button" id="c">Apply now</button></div>', url: POSTING, bg: bg2, session, timing: { formWait: 120 } });
  const third = m.counter(p2.doc.getElementById('c'));
  await p2.api.whenDone();
  assert.strictEqual(third.n, 0);
  assert.strictEqual(session.getItem('lit_aa_hops_job1'), '3');
  assertNoObservers('hop limit');
});

test('findApplyTarget: phrases, arrows, manual preference, and exclusions', () => {
  const bg = m.fakeBackground({ job: null });
  const pick = (html, url) => {
    const p = m.page({ html: '<div>' + html + '</div>', url: url || POSTING, bg });
    const t = p.api.findApplyTarget(p.doc);
    return t ? { id: t.el.id, navigate: t.navigate } : null;
  };
  [
    'Apply', 'Apply now', 'APPLY NOW', 'Apply for this position', 'Apply for this role', 'Apply to this job',
    'Start application', 'Start your application', "I'm interested", 'I am interested', 'Apply on company website',
    'Continue to application', 'Apply now →', '  Apply   for this job  '
  ].forEach(t => assert.deepStrictEqual(pick('<button type="button" id="b">' + t + '</button>'), { id: 'b', navigate: null }, t));
  [
    'Apply with LinkedIn', 'Apply with Indeed', 'Autofill with resume', 'Sign in to apply', 'Apply filters',
    'Save job', 'Applying is easy', 'Create account', 'Easy Apply'
  ].forEach(t => assert.strictEqual(pick('<button type="button" id="b">' + t + '</button>'), null, t));
  assert.strictEqual(pick('<button type="button" id="b" aria-label="Apply with LinkedIn">Apply</button>'), null, 'aria-label says LinkedIn');
  assert.strictEqual(pick('<button type="button" id="b" disabled>Apply</button>'), null, 'disabled');
  assert.strictEqual(pick('<div hidden><button type="button" id="b">Apply</button></div>'), null, 'hidden');
  assert.deepStrictEqual(pick('<button type="button" id="auto">Autofill with resume</button><button type="button" id="man">Apply manually</button>'), { id: 'man', navigate: null });
  assert.deepStrictEqual(pick('<a id="ext" href="https://x.example/apply" target="_blank">Apply</a><button type="button" id="b">Apply</button>'), { id: 'b', navigate: null }, 'an in-page button beats leaving the page');
  assert.deepStrictEqual(pick('<a id="same" href="/jobs/42/apply">Apply</a>'), { id: 'same', navigate: null }, 'same-origin link is clicked');
  assert.deepStrictEqual(pick('<a id="rel" href="/jobs/42/apply" target="_blank">Apply</a>'), { id: 'rel', navigate: 'https://careers.example.com/jobs/42/apply' }, 'new-tab link resolved and navigated');
  assert.strictEqual(pick('<a id="js" href="javascript:void(0)" target="_blank">Apply</a>').navigate, null, 'javascript: links are clicked, never assigned');
  assert.strictEqual(pick('<a id="li" href="https://www.linkedin.com/jobs/view/1">Apply</a>'), null, 'LinkedIn link');
  assert.strictEqual(pick('<a id="o" href="https://auth.example.com/oauth/authorize">Apply</a>'), null, 'OAuth link');
  assert.deepStrictEqual(pick('<button type="button" id="g">Apply as guest</button><button type="button" id="s">Sign in</button>'), { id: 'g', navigate: null }, 'guest path');
});

async function run() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  [PASS] ' + t.name);
    } catch (e) {
      failed++;
      console.error('  [FAIL] ' + t.name + '\n    ' + (e && e.stack ? e.stack : e));
    } finally {
      m.cleanup();
    }
  }
  if (failed) throw new Error(failed + ' auto-apply test(s) failed');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => console.log('ok'), e => { console.error(e.message); process.exit(1); });
}
