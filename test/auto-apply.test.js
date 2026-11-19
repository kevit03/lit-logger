// Auto-apply driver (content/autofill/auto-apply.js): a non-batch tab costs
// one HELLO and nothing else; a batch tab is filled, verified, submitted with
// exactly one click and confirmed. Every way it must stop short instead of
// guessing (missing required field, CAPTCHA, ambiguous Submit, refused frame
// claim, validation error, Workday) ends as `needs-you` with no click. Also
// the reload-after-submit check-only path, the Ashby/Lever form URL fixes,
// the apply-button rule, and the required-field scan against the saved
// autofill fixtures. Every test checks that no MutationObserver is left
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
