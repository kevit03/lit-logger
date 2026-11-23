// Ashby autofill adapter: jobs.ashbyhq.com/<company>/<job-id>/application.
//
// The form is client-rendered. System fields have stable ids
// (_systemfield_name, _systemfield_email, _systemfield_resume) and every
// question sits in a .ashby-application-form-field-entry whose
// label.ashby-application-form-question-title points (for=) at the control,
// whose id is the question's UUID. Phone and LinkedIn are ordinary questions,
// so their selectors are derived from the label text at scan time (`fields`
// is a getter for that reason).
//
// Two widgets need `fill`:
// - Yes/No questions are a pair of buttons (data-option="yes"/"no",
//   aria-pressed) backed by a display:none checkbox. Clicking the button is
//   the only way to answer.
// - The location question is an input[role=combobox] autocomplete whose
//   [role=listbox] of [role=option] rows mounts after typing.
(() => {
  if (typeof AutofillCore === 'undefined' || !AutofillCore || !AutofillCore.siteKit) return;

  const HOSTS = /^jobs\.ashbyhq\.com$/;

  // Widget helpers shared by the adapters (shared/autofill-core.js); every
  // wait takes its timeout from this adapter's own `timing`.
  const timing = { wait: 3000, confirm: 1000 };
  const kit = AutofillCore.siteKit;
  const { norm, scoreText, press, key, searchFor } = kit;
  const waitFor = (find, root, timeout = timing.wait) => kit.waitFor(find, root, timeout);

  const YESNO = '.ashby-application-form-input-yesno';
  const ENTRY = '.ashby-application-form-field-entry';

  const STATIC_FIELDS = [
    { selector: '#_systemfield_name, input[name="_systemfield_name"]', profileKey: 'fullName' },
    { selector: '#_systemfield_email, input[name="_systemfield_email"]', profileKey: 'email' },
    { selector: 'input#_systemfield_resume[type="file"]', profileKey: 'resume' },
    { selector: '[data-field-path="_systemfield_location"] input[role="combobox"]', profileKey: 'city' },
    { selector: '.ashby-application-form-field-entry input[type="tel"]', profileKey: 'phone' }
  ];

  // Label text -> profile key for questions whose ids are per-posting UUIDs.
  const BY_LABEL = [
    [/linked\s*in/i, 'linkedin'],
    [/git\s*hub/i, 'github'],
    [/portfolio/i, 'portfolio'],
    [/^(personal\s+)?(web\s*site|site)\b/i, 'website'],
    [/^(phone|mobile|phone number|mobile number|cell phone)$/i, 'phone']
  ];

  function labelFields(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const out = [];
    doc.querySelectorAll('label.ashby-application-form-question-title[for]').forEach(label => {
      const id = label.getAttribute('for') || '';
      if (!id || /^_systemfield_/.test(id) || /["\\]/.test(id)) return;
      const text = label.textContent.replace(/\*/g, '').trim();
      const hit = BY_LABEL.find(([re]) => re.test(text));
      if (hit) out.push({ selector: 'input[id="' + id + '"], textarea[id="' + id + '"]', profileKey: hit[1] });
    });
    return out;
  }

  function yesNo(value) {
    const v = norm(value);
    if (/^(yes|y|true)\b/.test(v)) return 'yes';
    if (/^(no|n|false)\b/.test(v)) return 'no';
    return null;
  }

  function yesNoContainer(desc) {
    const el = desc.el;
    return (el && el.closest && el.closest(YESNO)) ||
      (desc.group && desc.group.querySelector && desc.group.querySelector(YESNO)) ||
      (el && el.closest && el.closest(ENTRY) && el.closest(ENTRY).querySelector(YESNO)) ||
      null;
  }

  async function clickYesNo(desc, container, value) {
    const answer = yesNo(value);
    if (!answer) return false;
    const doc = container.ownerDocument;
    const entry = container.closest('[data-field-path]');
    const path = entry ? entry.getAttribute('data-field-path') : '';
    // Re-query by field path every time: React may swap the nodes.
    const current = () => (path && doc.querySelector('[data-field-path="' + path + '"] ' + YESNO)) ||
      (container.isConnected ? container : null);
    const button = () => {
      const c = current();
      if (!c) return null;
      return c.querySelector('button[data-option="' + answer + '"]') ||
        Array.from(c.querySelectorAll('button')).find(b => norm(b.textContent) === answer) || null;
    };
    const target = button();
    if (!target) return false;
    if (target.getAttribute('aria-pressed') === 'true') return true;
    press(target);
    const pressed = await waitFor(() => {
      const b = button();
      return b && b.getAttribute('aria-pressed') === 'true' ? b : null;
    }, doc.documentElement, timing.confirm);
    return Boolean(pressed);
  }

  async function fillAutocomplete(desc, value) {
    const input = desc.el;
    const doc = input.ownerDocument;
    const root = doc.documentElement;
    if (!input.isConnected) return false;
    if (norm(input.value) && scoreText(input.value, value) >= 0.7) return true;
    const options = () => {
      const owned = input.getAttribute('aria-controls');
      const list = owned ? doc.querySelector('[id="' + owned + '"]') : null;
      const scope = list || doc;
      return Array.from(scope.querySelectorAll('[role="listbox"] [role="option"]'))
        .filter((o, i, all) => all.indexOf(o) === i && o.getAttribute('aria-disabled') !== 'true');
    };
    if (input.focus) input.focus();
    const hit = await searchFor(input, value, options, root, timing.wait);
    if (!hit) {
      key(input, 'Escape', 27);
      return false;
    }
    const want = hit.textContent;
    press(hit);
    const done = await waitFor(() => (scoreText(input.value, want) >= 0.9 ? input : null), root, timing.confirm);
    return Boolean(done);
  }

  AutofillCore.registerSiteAdapter({
    id: 'ashby',
    timing,
    matches: kit.hostMatcher(HOSTS),
    // A getter: the label-derived entries depend on the rendered form.
    get fields() {
      return STATIC_FIELDS.concat(labelFields(typeof document !== 'undefined' ? document : null));
    },
    fill(desc, value) {
      const el = desc && desc.el;
      if (!el || typeof el.matches !== 'function') return undefined;
      const yn = yesNoContainer(desc);
      if (yn) return clickYesNo(desc, yn, value);
      if (el.matches('input[role="combobox"]')) return fillAutocomplete(desc, value);
      return undefined;
    }
  });
})();
