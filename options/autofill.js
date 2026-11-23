// LIT autofill profile editor (options/autofill.html).
//
// One tab per section. Every control saves itself: text fields on blur,
// selects, toggles and switches on change. Lists re-render when storage
// changes elsewhere (for example a rule learned on an application page),
// except while you are typing in them.
(() => {
  if (typeof AutofillStore === 'undefined' || !AutofillStore) return;
  const store = AutofillStore;

  const el = id => document.getElementById(id);
  const errText = err => (err && err.message) || String(err);
  const show = (node, visible) => node.classList.toggle('hidden', !visible);
  // What Ctrl/Cmd+S runs for the focused control: each editable control
  // registers the same save it runs on blur.
  const commits = new WeakMap();

  // ---------------------------------------------------------------------------
  // Profile schema
  //
  // A field is a text input unless it has `options` (select) or `toggle`
  // (yes/no buttons; neither pressed means not set). `optional` fields are
  // left out of the "fields filled" count.
  // ---------------------------------------------------------------------------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const DECLINE = 'Decline to self-identify';
  const choices = (blank, values) => [{ value: '', label: blank }].concat(values.map(v => ({ value: v, label: v })));
  const eeo = values => choices('Leave blank', values);

  const GROUPS = [
    {
      title: 'Basics',
      fields: [
        { key: 'firstName', label: 'First name', autocomplete: 'given-name', placeholder: 'As it appears on your resume' },
        { key: 'lastName', label: 'Last name', autocomplete: 'family-name' },
        { key: 'preferredName', label: 'Preferred name', autocomplete: 'nickname', placeholder: 'Only if different from first name', optional: true },
        { key: 'email', label: 'Email', type: 'email', autocomplete: 'email', placeholder: 'name@example.com', check: 'email' },
        { key: 'phoneCountryCode', label: 'Phone country code', placeholder: '+1', autocomplete: 'tel-country-code', check: 'countryCode' },
        { key: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel-national', placeholder: 'e.g. 555 123 4567', check: 'phone' }
      ]
    },
    {
      title: 'Address',
      fields: [
        { key: 'addressLine1', label: 'Address line 1', autocomplete: 'address-line1', wide: true, placeholder: 'Street address' },
        { key: 'addressLine2', label: 'Address line 2', autocomplete: 'address-line2', wide: true, placeholder: 'Apartment, suite, or unit', optional: true },
        { key: 'city', label: 'City', autocomplete: 'address-level2', placeholder: 'e.g. Seattle' },
        { key: 'state', label: 'State or province', autocomplete: 'address-level1', placeholder: 'e.g. WA or Washington' },
        { key: 'postalCode', label: 'Postal code', autocomplete: 'postal-code', placeholder: 'e.g. 98101' },
        { key: 'country', label: 'Country', autocomplete: 'country-name', placeholder: 'e.g. United States' }
      ]
    },
    {
      title: 'Links',
      fields: [
        { key: 'linkedin', label: 'LinkedIn', type: 'url', placeholder: 'https://www.linkedin.com/in/your-name', check: 'url', site: 'linkedin.com' },
        { key: 'portfolio', label: 'Portfolio', type: 'url', placeholder: 'Work samples, a Behance or Dribbble page', check: 'url' },
        { key: 'website', label: 'Website', type: 'url', placeholder: 'Personal site or blog', check: 'url' },
        // Only some roles ask for it, so it sits last and is not counted.
        { key: 'github', label: 'GitHub', type: 'url', placeholder: 'https://github.com/your-name', optional: true, check: 'url', site: 'github.com' }
      ]
    },
    {
      title: 'Education',
      fields: [
        { key: 'school', label: 'School', wide: true, placeholder: 'e.g. University of Washington' },
        { key: 'degree', label: 'Degree', placeholder: 'e.g. Bachelor of Science' },
        { key: 'major', label: 'Major', placeholder: 'e.g. Computer Science' },
        { key: 'gpa', label: 'GPA', placeholder: 'e.g. 3.8', hint: 'Leave blank to skip GPA questions.', optional: true, check: 'gpa' },
        { key: 'gradMonth', label: 'Graduation month', options: choices('Not set', MONTHS) },
        { key: 'gradYear', label: 'Graduation year', placeholder: 'e.g. 2027', inputmode: 'numeric', check: 'year',
          stepper: { min: 1950, max: 2100, start: new Date().getFullYear() } }
      ]
    },
    {
      title: 'Work',
      fields: [
        { key: 'currentCompany', label: 'Current company', autocomplete: 'organization', placeholder: 'Leave blank if not working', optional: true },
        { key: 'currentTitle', label: 'Current title', autocomplete: 'organization-title', placeholder: 'e.g. Software Engineer', optional: true },
        { key: 'yearsExperience', label: 'Years of experience', placeholder: 'e.g. 2', inputmode: 'decimal', check: 'years',
          stepper: { min: 0, max: 60, start: 0 }, hint: 'Count internships if the job is entry level.' }
      ]
    },
    {
      title: 'Logistics',
      fields: [
        { key: 'workAuthorized', label: 'Authorized to work in the country of the job', short: 'Work authorization', toggle: true },
        { key: 'needsSponsorship', label: 'Will need visa sponsorship', short: 'Visa sponsorship', toggle: true },
        { key: 'willingToRelocate', label: 'Willing to relocate', short: 'Relocation', toggle: true },
        { key: 'earliestStartDate', label: 'Earliest start date', short: 'Start date', placeholder: 'e.g. June 2027 or 2027-06-01' },
        { key: 'salaryExpectation', label: 'Salary expectation', placeholder: 'e.g. $120,000', hint: 'Filled exactly as written. Leave blank to skip.', optional: true },
        { key: 'howDidYouHear', label: 'How did you hear about us', placeholder: 'e.g. LinkedIn', optional: true }
      ]
    },
    {
      title: 'Diversity questions (optional)',
      note: 'Always voluntary, and "Leave blank" is fine. LIT fills these only while "Fill diversity questions" is on in Settings.',
      optional: true,
      fields: [
        { key: 'eeo.gender', label: 'Gender', options: eeo(['Male', 'Female', 'Non-binary', DECLINE]) },
        { key: 'eeo.race', label: 'Race or ethnicity', options: eeo([
          'American Indian or Alaska Native', 'Asian', 'Black or African American',
          'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races', DECLINE]) },
        { key: 'eeo.hispanicLatino', label: 'Hispanic or Latino', options: [
          { value: '', label: 'Leave blank' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
          { value: DECLINE, label: DECLINE }] },
        { key: 'eeo.veteran', label: 'Veteran status', options: eeo([
          'I am not a protected veteran',
          'I identify as one or more of the classifications of protected veteran',
          'I do not wish to answer']) },
        { key: 'eeo.disability', label: 'Disability status', options: eeo([
          'No, I do not have a disability',
          'Yes, I have a disability (or previously had a disability)',
          'I do not want to answer']) }
      ]
    }
  ];

  const counted = group => group.fields.filter(f => !group.optional && !f.optional);

  // Rules name profile keys with or without the "eeo." prefix.
  const FIELD_LABELS = { fullName: 'Full name' };
  const FIELDS = {}; // key -> field spec
  GROUPS.forEach(g => g.fields.forEach(f => {
    FIELDS[f.key] = f;
    FIELD_LABELS[f.key] = f.label;
    if (f.key.startsWith('eeo.')) FIELD_LABELS[f.key.slice(4)] = f.label;
  }));

  // Friendly checks for fields that have a shape (`check` in the schema).
  // A value that fails is still saved as typed: autosave must never lose
  // what someone wrote, and only they know their details. The note under
  // the field says what to look at. `fix` only tidies the format (a missing
  // https://, a missing +), never the content.
  const onSite = (host, site) => host === site || host.endsWith('.' + site);
  const CHECKS = {
    email: {
      problem: v => (/^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(v) ? '' : 'Check this email. It should look like name@example.com.')
    },
    countryCode: {
      fix: v => (/^\d{1,4}$/.test(v) ? '+' + v : v),
      problem: v => (/^\+\d{1,4}$/.test(v) ? '' : 'Use a plus and 1 to 4 digits, like +1 or +44.')
    },
    phone: {
      problem: v => {
        // An extension at the end ("x 12", "ext. 12") is fine.
        const main = v.replace(/\s*(ext\.?|x)\s*\d+$/i, '');
        if (/[^\d\s().+-]/.test(main)) return 'Use numbers only, like 555 123 4567.';
        const digits = main.replace(/\D/g, '').length;
        if (digits < 7) return 'This number looks too short. Check for missing digits.';
        return digits > 15 ? 'This number looks too long. Put the country code in its own box.' : '';
      }
    },
    url: {
      fix: v => (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(v) ? 'https://' + v : v),
      problem: (v, f) => {
        let u = null;
        try { u = new URL(v); } catch (e) { u = null; }
        if (!u || !/^https?:$/.test(u.protocol) || u.hostname.indexOf('.') < 0) {
          return 'Check this link. Paste the full address from your browser, starting with https://';
        }
        if (f.site && !onSite(u.hostname.toLowerCase(), f.site)) return 'This does not look like a ' + f.label + ' link. It should be on ' + f.site + '.';
        return '';
      }
    },
    year: { problem: v => (/^(19[5-9]\d|20\d\d|2100)$/.test(v) ? '' : 'Use a 4-digit year, like 2027.') },
    years: { problem: v => (/^\d{1,2}(\.\d+)?\+?$/.test(v) ? '' : 'Use a number, like 2 or 3.5.') },
    gpa: { problem: v => (/^\d(\.\d{1,3})?(\s*(\/|out of)\s*\d+(\.\d+)?)?$/i.test(v) ? '' : 'Use a number, like 3.8 or 3.8 / 4.0.') }
  };

  function problemOf(f, value) {
    const check = f && f.check && CHECKS[f.check];
    return check && value ? check.problem(value, f) : '';
  }

  const getPath = (obj, key) => (key.startsWith('eeo.') ? (obj.eeo || {})[key.slice(4)] : obj[key]) || '';
  const patchFor = (key, value) => (key.startsWith('eeo.') ? { eeo: { [key.slice(4)]: value } } : { [key]: value });

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function make(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'className') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    node.append(...(children || []).filter(Boolean));
    return node;
  }

  function button(className, text, onClick) {
    const b = make('button', { type: 'button', className, text });
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function showError(box, msg) {
    box.textContent = msg || '';
    show(box, !!msg);
  }

  function renderEmpty(id, visible, nodes) {
    const box = el(id);
    box.replaceChildren(...nodes);
    show(box, visible);
  }

  // Two-click delete: the first click arms the button and relabels it with
  // the action it will take, the second confirms. It disarms after 4 seconds,
  // and once the action has finished.
  function armedDelete(btn, confirmLabel, onConfirm) {
    const label = btn.textContent;
    let timer = null;
    const disarm = () => {
      clearTimeout(timer);
      btn.disabled = false;
      btn.classList.remove('armed');
      btn.textContent = label;
    };
    btn.addEventListener('click', async () => {
      if (!btn.classList.contains('armed')) {
        btn.classList.add('armed');
        btn.textContent = confirmLabel;
        timer = setTimeout(disarm, 4000);
        return;
      }
      clearTimeout(timer);
      btn.disabled = true;
      try {
        await onConfirm();
      } catch (err) {
        reportError(err);
      } finally {
        disarm();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Save indicator
  // ---------------------------------------------------------------------------
  const status = el('save-status');
  let statusTimer = null;
  let pending = 0;

  function setStatus(text, kind) {
    clearTimeout(statusTimer);
    status.textContent = text;
    status.className = 'save-status is-visible is-' + kind;
    if (kind === 'saved') {
      statusTimer = setTimeout(() => status.classList.remove('is-visible'), 1600);
    }
  }

  function reportError(err) {
    setStatus('Not saved', 'error');
    showError(el('page-error'), "Something didn't save: " + errText(err));
  }

  // Tracks a storage write in the save indicator. Storage changes made by
  // this page are already on screen, so ownWrites keeps the onChange listener
  // from rebuilding lists for them.
  let ownWrites = 0;
  let writesStarted = 0; // lets Ctrl/Cmd+S tell "saved just now" from "nothing to save"
  async function write(promise) {
    ownWrites++;
    writesStarted++;
    pending++;
    setStatus('Saving', 'saving');
    try {
      const result = await promise;
      if (!--pending) setStatus('Saved', 'saved');
      showError(el('page-error'), '');
      return result;
    } catch (err) {
      pending--;
      reportError(err);
      throw err;
    } finally {
      setTimeout(() => { ownWrites = Math.max(0, ownWrites - 1); }, 300);
    }
  }

  // ---------------------------------------------------------------------------
  // Undo bar: shown after a delete, erase, or import, for 8 seconds. An
  // action that returns a promise is a storage write (saved, then the page
  // reloads from storage); one that returns nothing only puts something back
  // on screen, like a closed answer draft.
  // ---------------------------------------------------------------------------
  const undoBar = el('undo-bar');
  let undoAction = null;
  let undoTimer = null;

  function hideUndo() {
    clearTimeout(undoTimer);
    undoAction = null;
    show(undoBar, false);
  }

  function offerUndo(text, action) {
    clearTimeout(undoTimer);
    undoAction = action;
    el('undo-text').textContent = text;
    show(undoBar, true);
    undoTimer = setTimeout(hideUndo, 8000);
  }

  el('undo-btn').addEventListener('click', async () => {
    const action = undoAction;
    hideUndo();
    if (!action) return;
    try {
      const result = action();
      if (!result || typeof result.then !== 'function') return;
      await write(result);
      await loadAll();
      setStatus('Restored', 'saved');
    } catch (err) {
      reportError(err);
    }
  });

  // ---------------------------------------------------------------------------
  // Tabs: one section on screen at a time, mirrored in the URL hash
  // ---------------------------------------------------------------------------
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const TAB_ALIASES = { data: 'settings' };

  function selectTab(name) {
    const wanted = TAB_ALIASES[name] || name;
    const active = tabs.find(t => t.dataset.tab === wanted) || tabs[0];
    tabs.forEach(tab => {
      const on = tab === active;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      show(el(tab.dataset.tab), on);
    });
    if (location.hash.slice(1) !== active.dataset.tab) history.replaceState(null, '', '#' + active.dataset.tab);
    return active;
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', e => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      selectTab(tabs[(i + step + tabs.length) % tabs.length].dataset.tab).focus();
    });
  });
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------
  const profileForm = el('profile-form');
  const controls = {}; // key -> { node, get(), set(value) }
  let savedProfile = null;

  function textControl(f, id) {
    const input = make('input', {
      id,
      className: 'input',
      type: f.type || 'text',
      autocomplete: f.autocomplete || 'off',
      placeholder: f.placeholder || '',
      inputmode: f.inputmode,
      spellcheck: 'false'
    });
    input.addEventListener('blur', () => saveField(f.key));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape' && savedProfile) {
        // Esc takes back what was typed: the saved value returns, nothing is written.
        e.preventDefault();
        input.value = getPath(savedProfile, f.key);
        input.blur();
      }
    });
    commits.set(input, () => saveField(f.key));
    return {
      node: input,
      focusEl: input,
      root: f.stepper ? stepper(f, input) : input,
      get: () => input.value.trim(),
      set: value => { input.value = value; }
    };
  }

  function selectControl(f, id) {
    const select = make('select', { id, className: 'input' }, f.options.map(o => make('option', { value: o.value, text: o.label })));
    select.addEventListener('change', () => saveField(f.key));
    return {
      node: select,
      focusEl: select,
      get: () => select.value,
      // A stored value that is not in the list (from an import, say) is kept
      // as an extra option instead of being dropped.
      set: value => {
        if (value && !Array.from(select.options).some(o => o.value === value)) {
          select.append(make('option', { value, text: value }));
        }
        select.value = value;
      }
    };
  }

  // Yes / No buttons. Pressing the lit one again clears the answer.
  function toggleControl(f, id) {
    const group = make('div', { id, className: 'segmented', role: 'group', 'aria-labelledby': id + '-label' });
    const control = {
      node: group,
      get: () => group.dataset.value || '',
      set: value => {
        group.dataset.value = value;
        Array.from(group.children).forEach(b => b.setAttribute('aria-pressed', String(b.value === value)));
      }
    };
    [['yes', 'Yes'], ['no', 'No']].forEach(([value, label]) => {
      const b = button('', label, () => {
        control.set(control.get() === value ? '' : value);
        saveField(f.key);
      });
      b.value = value;
      group.append(b);
      if (!control.focusEl) control.focusEl = b;
    });
    return control;
  }

  // Whole-number fields get -/+ buttons. The input stays a text box so a typed
  // value like "2.5" still saves as written; the buttons round to whole steps.
  function stepper(f, input) {
    const { min, max, start } = f.stepper;
    const name = f.label.toLowerCase();
    const bump = delta => {
      const n = parseFloat(input.value);
      input.value = String(Math.min(max, Math.max(min, isNaN(n) ? start : Math.round(n) + delta)));
      saveField(f.key);
    };
    const step = (text, label, delta) => {
      const b = button('step-btn', text, () => bump(delta));
      b.title = label;
      b.setAttribute('aria-label', label);
      return b;
    };
    input.classList.add('step-input');
    input.addEventListener('keydown', e => {
      const delta = { ArrowUp: 1, ArrowDown: -1 }[e.key];
      if (!delta) return;
      e.preventDefault();
      bump(delta);
    });
    return make('div', { className: 'stepper' }, [
      step('−', 'Decrease ' + name, -1),
      input,
      step('+', 'Increase ' + name, 1)
    ]);
  }

  function buildProfileForm() {
    profileForm.replaceChildren(...GROUPS.map(group => {
      group.countEl = make('span', { className: 'group-count' });
      return make('section', { className: 'group card' }, [
        make('div', { className: 'group-head' }, [
          make('h3', { text: group.title }),
          group.countEl,
          group.note && make('p', { className: 'group-note', text: group.note })
        ]),
        make('div', { className: 'grid' }, group.fields.map(f => {
          const id = 'pf-' + f.key.replace('.', '-');
          const control = (f.options ? selectControl : f.toggle ? toggleControl : textControl)(f, id);
          // Hints ride along as the control's tooltip instead of a line of
          // text under every field.
          if (f.hint) control.node.title = f.hint;
          controls[f.key] = control;
          // Optional fields say so, unless the whole group is optional.
          const label = make('label', { className: 'field-label', id: id + '-label', for: f.toggle ? undefined : id, text: f.label });
          if (f.optional && !group.optional) label.append(make('span', { className: 'field-optional', text: 'optional' }));
          // Fields with a shape get a note line for "this looks off".
          if (f.check) {
            control.msg = make('p', { className: 'field-msg hidden', id: id + '-msg' });
            control.node.setAttribute('aria-describedby', id + '-msg');
          }
          control.field = make('div', { className: 'field' + (f.wide ? ' wide' : '') }, [
            label,
            control.root || control.node,
            control.msg
          ]);
          return control.field;
        }))
      ]);
    }));
    profileForm.addEventListener('submit', e => e.preventDefault());
  }

  // The one thing to do next, for the "Next" button by the meter: a value
  // that looks off comes first, then the first empty field that counts,
  // then the resume. Null when there is nothing left to do.
  let nextTarget = null;
  function nextStep() {
    const all = GROUPS.reduce((list, g) => list.concat(g.fields), []);
    const off = all.find(f => problemOf(f, getPath(savedProfile, f.key)));
    if (off) return { key: off.key, text: 'Check: ' + (off.short || off.label), warn: true };
    const empty = GROUPS.reduce((list, g) => list.concat(counted(g)), []).find(f => !getPath(savedProfile, f.key));
    if (empty) return { key: empty.key, text: 'Next: ' + (empty.short || empty.label) };
    if (currentResume === null) return { tab: 'resume', text: 'Next: add your resume' };
    return null;
  }

  function renderProgress() {
    let filled = 0;
    let total = 0;
    GROUPS.forEach(group => {
      const fields = counted(group);
      const done = fields.filter(f => getPath(savedProfile, f.key)).length;
      filled += done;
      total += fields.length;
      group.countEl.textContent = group.optional ? 'Optional' : done + ' / ' + fields.length;
      group.countEl.classList.toggle('is-done', !group.optional && done === fields.length);
    });
    nextTarget = nextStep();
    const complete = filled === total && !nextTarget;
    el('progress-text').textContent = complete ? 'All ' + total + ' filled' : filled + ' of ' + total + ' filled';
    el('progress-bar').style.width = Math.round((filled / total) * 100) + '%';
    el('progress-box').classList.toggle('is-complete', complete);
    const next = el('progress-next');
    next.textContent = nextTarget ? nextTarget.text : '';
    next.classList.toggle('is-warn', !!(nextTarget && nextTarget.warn));
    show(next, !!nextTarget);
  }

  el('progress-next').addEventListener('click', () => {
    const target = nextTarget;
    if (!target) return;
    if (target.tab) {
      selectTab(target.tab);
      el('resume-upload-btn').focus();
      return;
    }
    const control = controls[target.key];
    selectTab('profile');
    // A short ring so the eye lands on it, then the cursor goes in.
    control.field.classList.add('is-target');
    setTimeout(() => control.field.classList.remove('is-target'), 1800);
    if (typeof control.field.scrollIntoView === 'function') control.field.scrollIntoView({ block: 'center' });
    control.focusEl.focus({ preventScroll: true });
  });

  // Shows or clears the "looks off" note for one field from what it holds.
  function renderCheck(key) {
    const control = controls[key];
    if (!control.msg) return '';
    const problem = problemOf(FIELDS[key], control.get());
    control.msg.textContent = problem;
    show(control.msg, !!problem);
    if (problem) control.node.setAttribute('aria-invalid', 'true');
    else control.node.removeAttribute('aria-invalid');
    return problem;
  }

  function fillProfileForm(profile) {
    savedProfile = profile;
    Object.entries(controls).forEach(([key, control]) => {
      if (document.activeElement === control.node) return;
      control.set(getPath(profile, key));
      renderCheck(key);
    });
    renderProgress();
  }

  async function saveField(key) {
    const control = controls[key];
    const check = CHECKS[FIELDS[key].check];
    let value = control.get();
    // Tidy the format first ("linkedin.com/in/sam" gets its https://).
    if (value && check && check.fix && check.fix(value) !== value) {
      value = check.fix(value);
      control.set(value);
    }
    renderCheck(key);
    if (savedProfile && getPath(savedProfile, key) === value) return;
    try {
      savedProfile = await write(store.saveProfile(patchFor(key, value)));
      // Show the value as stored (trimmed, normalized) once focus has moved on.
      if (!control.node.contains(document.activeElement)) control.set(getPath(savedProfile, key));
      renderCheck(key);
      renderProgress();
    } catch (e) {
      // Shown by reportError.
    }
  }

  // ---------------------------------------------------------------------------
  // Resume: pick a file or drop one on the card
  // ---------------------------------------------------------------------------
  const resumeFile = el('resume-file');
  const resumeDrop = el('resume-drop');
  const resumeError = el('resume-error');

  // undefined until the first load, then the stored resume or null.
  let currentResume;

  function renderResume(resume) {
    currentResume = resume || null;
    if (savedProfile) renderProgress();
    const download = el('resume-download');
    resumeDrop.classList.toggle('is-empty', !resume);
    show(download, !!resume);
    show(el('resume-remove-btn'), !!resume);
    el('resume-upload-btn').textContent = resume ? 'Replace' : 'Choose file';
    if (!resume) {
      el('resume-name').textContent = 'Drop your resume here';
      el('resume-meta').textContent = 'Or choose a file. PDF, Word, RTF, or plain text, up to 5 MB.';
      download.removeAttribute('href');
      return;
    }
    el('resume-name').textContent = resume.name;
    el('resume-meta').textContent = [formatBytes(resume.size), resume.savedAt && 'Uploaded ' + formatDate(resume.savedAt)]
      .filter(Boolean).join(' / ');
    download.href = resume.dataUrl;
    download.setAttribute('download', resume.name);
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadResume(file) {
    if (!file) return;
    showError(resumeError, '');
    if (file.size > store.RESUME_MAX_BYTES) {
      showError(resumeError, '"' + file.name + '" is ' + formatBytes(file.size) + ', a bit over the 5 MB limit. A PDF export is usually smaller.');
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      await write(store.saveResume({ name: file.name, type: file.type, dataUrl }));
      renderResume(await store.getResume());
    } catch (err) {
      showError(resumeError, errText(err));
    }
  }

  el('resume-upload-btn').addEventListener('click', () => resumeFile.click());
  resumeFile.addEventListener('change', () => {
    const file = resumeFile.files && resumeFile.files[0];
    resumeFile.value = '';
    uploadResume(file);
  });

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => {
    resumeDrop.addEventListener(type, e => {
      e.preventDefault();
      resumeDrop.classList.toggle('is-drag', type === 'dragenter' || type === 'dragover');
      if (type === 'drop') uploadResume(e.dataTransfer && e.dataTransfer.files[0]);
    });
  });

  armedDelete(el('resume-remove-btn'), 'Yes, remove resume', async () => {
    const previous = await store.getResume();
    await write(store.clearResume());
    renderResume(null);
    if (previous) offerUndo('Resume removed.', () => store.saveResume(previous));
  });

  // ---------------------------------------------------------------------------
  // Lists: saved answers and learned rules
  // ---------------------------------------------------------------------------
  const lists = { answers: [], rules: [] };

  // Deletes one entry, then offers to put that list back exactly as it was
  // (order and ids included): importAll leaves sections missing from the data
  // alone, so nothing else is touched.
  async function deleteEntry(key, id, remove, message) {
    const snapshot = await store.exportAll({ includeResume: false });
    await write(remove(id));
    lists[key] = lists[key].filter(x => x.id !== id);
    PARTS[key].render(lists[key]);
    offerUndo(message, () => store.importAll({ format: snapshot.format, version: snapshot.version, [key]: snapshot[key] }));
  }

  // The trimmed search text and a case-insensitive matcher for it.
  function searchOf(input) {
    const text = input.value.trim();
    const q = text.toLowerCase();
    return { text, matches: haystack => !q || haystack.toLowerCase().includes(q) };
  }

  // ----- Saved answers -------------------------------------------------------
  const answersSearch = el('answers-search');
  const ANSWER_TEMPLATES = [
    'Why do you want to work here?',
    'Tell us about yourself.',
    'Describe a challenging project you worked on.',
    'Is there anything else you would like us to know?'
  ];

  function renderAnswers() {
    const search = searchOf(answersSearch);
    const visible = lists.answers.filter(a => search.matches([a.question, a.answer, a.role, a.company].filter(Boolean).join('\n')));
    el('answers-list').replaceChildren(...visible.map(answerItem));
    el('count-answers').textContent = lists.answers.length || '';
    // With nothing saved yet, offer starting points: each opens the
    // new-answer form with the question filled in.
    renderEmpty('answers-empty', !visible.length, lists.answers.length
      ? [make('p', { text: 'Nothing matches "' + search.text + '". Try a shorter word.' })]
      : [
        make('p', { className: 'empty-title', text: 'No saved answers yet' }),
        make('p', { text: 'Pick a question most applications ask, and write your answer once:' }),
        make('div', { className: 'template-list' },
          ANSWER_TEMPLATES.map(q => button('btn btn-ghost btn-sm template-btn', q, () => openNewAnswer(q))))
      ]);
  }

  function answerItem(a) {
    const qInput = make('input', { type: 'text', className: 'input answer-q', value: a.question, 'aria-label': 'Question', autocomplete: 'off' });
    const aText = make('textarea', { className: 'input textarea', rows: '3', 'aria-label': 'Answer' });
    aText.value = a.answer;
    const meta = make('span', { className: 'item-meta', text: a.updatedAt ? 'Updated ' + formatDate(a.updatedAt) : '' });
    // The job the answer was written for; answer writing swaps it for the next one.
    const context = a.role && a.company ? a.role + ' at ' + a.company : (a.role || a.company || '');
    const contextChip = context
      ? make('span', { className: 'chip chip-soft answer-context', text: context, title: 'Written for ' + context })
      : null;
    const del = button('btn btn-danger-ghost btn-sm', 'Delete');
    const err = make('div', { className: 'field-error hidden', role: 'alert' });

    const commit = async () => {
      const question = qInput.value.trim();
      const answer = aText.value;
      if (question === a.question && answer === a.answer) return;
      if (!question || !answer.trim()) {
        showError(err, 'A saved answer needs both a question and an answer. To remove it, use Delete.');
        return;
      }
      showError(err, '');
      try {
        const saved = await write(store.saveAnswer({ id: a.id, question, answer }));
        Object.assign(a, saved);
        meta.textContent = 'Updated ' + formatDate(saved.updatedAt);
        refresh('answers');
      } catch (e) {
        showError(err, errText(e));
      }
    };
    qInput.addEventListener('blur', commit);
    aText.addEventListener('blur', commit);
    // Esc takes back an edit in progress: the saved text returns.
    const revert = e => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      qInput.value = a.question;
      aText.value = a.answer;
      showError(err, '');
      e.target.blur();
    };
    qInput.addEventListener('keydown', revert);
    aText.addEventListener('keydown', revert);
    commits.set(qInput, commit);
    commits.set(aText, commit);
    armedDelete(del, 'Yes, delete answer', () => deleteEntry('answers', a.id, id => store.deleteAnswer(id), 'Answer deleted.'));

    return make('div', { className: 'card answer-item', dataset: { id: a.id } }, [
      qInput,
      aText,
      make('div', { className: 'row-actions between' }, [make('div', { className: 'answer-meta' }, [contextChip, meta]), del]),
      err
    ]);
  }

  answersSearch.addEventListener('input', renderAnswers);

  // While the new-answer form is open its Save button is the one primary
  // action in this section, so Add answer steps aside.
  //
  // Keys: Enter in the question moves on to the answer (or saves once the
  // answer is written), Ctrl/Cmd+Enter in the answer saves (plain Enter is a
  // new line), Esc cancels. Cancelling with something typed offers it back.
  const newForm = el('answer-new');
  const newQuestion = el('answer-new-question');
  const newText = el('answer-new-text');
  const newError = el('answer-new-error');
  const IS_MAC = (() => {
    try { return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''); } catch (e) { return false; }
  })();
  el('answer-new-keys').textContent = (IS_MAC ? 'Cmd' : 'Ctrl') + '+Enter saves. Esc cancels.';

  function openNewAnswer(question, text) {
    show(newForm, true);
    show(el('answer-add-btn'), false);
    newQuestion.value = question;
    newText.value = text || '';
    (question ? newText : newQuestion).focus();
  }
  function closeNewAnswer() {
    newForm.reset();
    showError(newError, '');
    show(newForm, false);
    show(el('answer-add-btn'), true);
  }
  function hasDraft() {
    return !newForm.classList.contains('hidden') && !!(newQuestion.value.trim() || newText.value.trim());
  }
  function cancelNewAnswer() {
    const draft = { question: newQuestion.value, answer: newText.value };
    const typed = hasDraft();
    closeNewAnswer();
    el('answer-add-btn').focus();
    if (typed) offerUndo('Answer draft closed.', () => { openNewAnswer(draft.question, draft.answer); });
  }

  // False when something is missing (said under the form), so Ctrl/Cmd+S
  // does not also report "Everything is saved".
  async function submitNewAnswer() {
    const question = newQuestion.value.trim();
    const answer = newText.value;
    if (!question) {
      showError(newError, 'Add the question first, then your answer.');
      newQuestion.focus();
      return false;
    }
    if (!answer.trim()) {
      showError(newError, 'Write your answer, then save.');
      newText.focus();
      return false;
    }
    try {
      await write(store.saveAnswer({ question, answer }));
      closeNewAnswer();
      PARTS.answers.render(await store.getAnswers());
      el('answer-add-btn').focus();
      setStatus('Answer saved', 'saved');
      return true;
    } catch (err) {
      showError(newError, errText(err));
      return false;
    }
  }

  el('answer-add-btn').addEventListener('click', () => openNewAnswer(''));
  el('answer-new-cancel').addEventListener('click', cancelNewAnswer);
  newForm.addEventListener('submit', e => {
    e.preventDefault();
    submitNewAnswer();
  });
  newQuestion.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (newText.value.trim()) submitNewAnswer();
    else newText.focus();
  });
  newText.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    submitNewAnswer();
  });
  commits.set(newQuestion, submitNewAnswer);
  commits.set(newText, submitNewAnswer);

  // ----- Learned rules -------------------------------------------------------
  const rulesSearch = el('rules-search');

  function ruleRow(rule) {
    const [kind, target] = rule.profileKey
      ? ['Your profile', FIELD_LABELS[rule.profileKey] || rule.profileKey]
      : ['Your answer', rule.value === '' ? '(left blank)' : rule.value];
    const del = button('btn btn-danger-ghost btn-sm', 'Forget');
    armedDelete(del, 'Yes, forget it', () => deleteEntry('rules', rule.id, id => store.deleteRule(id), 'LIT forgot that one.'));
    return make('tr', null, [
      make('td', { className: 'site' }, [rule.host === '*' ? make('span', { className: 'chip', text: 'Every site' }) : rule.host]),
      make('td', { text: rule.labelKey }),
      make('td', null, [make('span', { className: 'chip chip-soft', text: kind }), ' ', target]),
      make('td', { className: 'actions' }, [del])
    ]);
  }

  function renderRules() {
    const search = searchOf(rulesSearch);
    const visible = lists.rules.filter(r => search.matches(r.host + ' ' + r.labelKey + ' ' + (r.profileKey || r.value || '')));
    el('rules-body').replaceChildren(...visible.map(ruleRow));
    el('count-rules').textContent = lists.rules.length || '';
    show(el('rules-card'), visible.length > 0);

    let empty;
    if (lists.rules.length) {
      empty = [make('p', { text: 'Nothing matches "' + search.text + '".' })];
    } else if (settings.autoLearn) {
      empty = [
        make('p', { className: 'empty-title', text: 'Nothing learned yet' }),
        make('p', { text: 'After autofill, fix any field that came out wrong. LIT remembers it here for next time.' })
      ];
    } else {
      // The likely reason for an empty list, with the fix one click away.
      empty = [
        make('p', { className: 'empty-title', text: 'Nothing learned yet' }),
        make('p', { text: '"Learn from my fixes" is off, so LIT is not remembering corrections.' }),
        button('btn btn-ghost btn-sm', 'Turn it on', () => saveSetting('autoLearn', true).catch(() => {}))
      ];
    }
    renderEmpty('rules-empty', !visible.length, empty);
  }

  rulesSearch.addEventListener('input', renderRules);

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const switches = Array.from(document.querySelectorAll('[data-setting]'));
  let settings = {};

  function renderSettings(next) {
    const learnChanged = !!settings.autoLearn !== !!next.autoLearn;
    settings = next;
    switches.forEach(input => { input.checked = !!settings[input.dataset.setting]; });
    renderAnswerWriting();
    if (learnChanged) renderRules();
  }

  // Rejects (after reportError has shown why) when the write fails.
  async function saveSetting(name, value) {
    renderSettings(await write(store.saveSettings({ [name]: value })));
  }

  switches.forEach(input => {
    input.addEventListener('change', () => {
      saveSetting(input.dataset.setting, input.checked).catch(() => { input.checked = !input.checked; });
    });
  });

  // ----- Answer writing ------------------------------------------------------
  // The key is never written back into the page: its field stays empty and
  // the line under the label says whether one is saved.
  const keyInput = el('ai-key');
  const keyStatus = el('ai-key-status');
  const keyRemove = el('ai-key-remove');
  const modelInput = el('ai-model');

  function renderAnswerWriting() {
    const hasKey = !!settings.aiKey;
    const missing = !hasKey && !!settings.aiEnabled;
    keyStatus.textContent = hasKey
      ? 'Saved, ending in ' + settings.aiKey.slice(-4)
      : (missing ? 'Add a key so LIT can write answers' : 'No key saved');
    keyStatus.classList.toggle('is-warn', missing);
    keyInput.setAttribute('placeholder', hasKey ? 'Paste a new key to replace it' : 'Paste your API key');
    show(keyRemove, hasKey);
    if (document.activeElement !== modelInput) modelInput.value = settings.aiModel || '';
  }

  keyInput.addEventListener('blur', () => {
    const value = keyInput.value.trim();
    keyInput.value = '';
    if (!value || value === settings.aiKey) return;
    saveSetting('aiKey', value).catch(() => {});
  });
  keyInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') keyInput.blur();
  });
  commits.set(keyInput, () => keyInput.blur());

  armedDelete(keyRemove, 'Yes, remove key', async () => {
    const previous = settings.aiKey;
    await saveSetting('aiKey', '');
    offerUndo('API key removed.', () => store.saveSettings({ aiKey: previous }));
  });

  // An empty model field goes back to the default model.
  modelInput.addEventListener('blur', () => {
    const value = modelInput.value.trim();
    if (value === (settings.aiModel || '')) return;
    saveSetting('aiModel', value).catch(() => {});
  });
  commits.set(modelInput, () => modelInput.blur());

  // ---------------------------------------------------------------------------
  // Import / export / erase
  // ---------------------------------------------------------------------------
  el('export-btn').addEventListener('click', async () => {
    try {
      const data = await store.exportAll();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = make('a', { href: url, download: 'lit-autofill-' + new Date().toISOString().slice(0, 10) + '.json' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('Exported', 'saved');
    } catch (err) {
      reportError(err);
    }
  });

  // Import replaces data, so the file is read first and an inline panel asks
  // before anything changes. A snapshot taken just before makes it undoable.
  const importFile = el('import-file');
  const importPanel = el('import-confirm');
  let pendingImport = null;

  function closeImportPanel() {
    pendingImport = null;
    show(importPanel, false);
  }

  el('import-btn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      pendingImport = { name: file.name, text: await file.text() };
      el('import-confirm-title').textContent = 'Replace your autofill data with "' + file.name + '"?';
      show(importPanel, true);
      el('import-cancel').focus();
    } catch (err) {
      reportError(err);
    }
  });
  el('import-cancel').addEventListener('click', () => {
    closeImportPanel();
    el('import-btn').focus();
  });
  el('import-confirm-btn').addEventListener('click', async () => {
    const job = pendingImport;
    closeImportPanel();
    if (!job) return;
    try {
      const snapshot = await store.exportAll({ includeKey: true });
      const counts = await write(store.importAll(job.text));
      await loadAll();
      setStatus('Imported ' + counts.answers + ' answers and ' + counts.rules + ' learned fixes', 'saved');
      offerUndo('Imported "' + job.name + '".', () => store.importAll(snapshot));
    } catch (err) {
      reportError(err);
    }
  });

  armedDelete(el('clear-all-btn'), 'Yes, erase everything', async () => {
    const snapshot = await store.exportAll({ includeKey: true });
    await write(store.clearAll());
    await loadAll();
    offerUndo('All autofill data erased.', () => store.importAll(snapshot));
  });

  // ---------------------------------------------------------------------------
  // Keyboard and leaving the page
  //
  // Ctrl/Cmd+S saves the field you are in (and keeps the browser's "Save
  // page" dialog away); with nothing to save it says so. Esc backs out of
  // the import question or the new-answer form; inside a field it takes
  // back the edit (see the controls above).
  // ---------------------------------------------------------------------------
  async function saveNow() {
    const active = document.activeElement;
    const commit = active ? commits.get(active) : null;
    const before = writesStarted;
    if (commit && (await commit()) === false) return;
    if (writesStarted === before && !pending) setStatus('Everything is saved', 'saved');
  }

  document.addEventListener('keydown', e => {
    const key = String(e.key || '');
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
    } else if (key === 'Escape') {
      if (!importPanel.classList.contains('hidden')) {
        e.preventDefault();
        el('import-cancel').click();
      } else if (!newForm.classList.contains('hidden') && newForm.contains(document.activeElement)) {
        e.preventDefault();
        cancelNewAnswer();
      }
    }
  });

  // Everything else saves itself; only a new answer still being written, or
  // a save still on its way, is worth asking about before the tab closes.
  window.addEventListener('beforeunload', e => {
    if (!hasDraft() && !pending) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });

  // The Applications page lives elsewhere in the extension; the relative
  // link in the markup is the fallback.
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      el('applications-link').setAttribute('href', chrome.runtime.getURL('applications/applications.html'));
    }
  } catch (e) {
    // Keep the relative link.
  }

  // ---------------------------------------------------------------------------
  // Look: the popup's light/dark choice (the OS scheme until one is made),
  // plus the accent color and comfort mode from LIT's preferences.
  // ---------------------------------------------------------------------------
  let chosenTheme = '';

  function prefersDark() {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      return false;
    }
  }

  function applyTheme(theme) {
    chosenTheme = theme === 'dark' || theme === 'light' ? theme : '';
    document.body.classList.toggle('pt-dark', chosenTheme ? chosenTheme === 'dark' : prefersDark());
  }

  const ACCENT_IDS = ['coral', 'sage', 'ocean', 'plum', 'amber', 'slate'];
  function applyPrefs(prefs) {
    const root = document.documentElement;
    if (!root || typeof root.setAttribute !== 'function') return;
    const p = prefs && typeof prefs === 'object' ? prefs : {};
    root.setAttribute('data-accent', ACCENT_IDS.indexOf(p.accent) >= 0 ? p.accent : 'coral');
    root.setAttribute('data-comfort', p.comfortMode ? 'on' : 'off');
  }

  // Theme and prefs live in sync storage when it is there, else local.
  function readSetting(key, done) {
    const area = chrome.storage.sync || chrome.storage.local;
    area.get([key], r => {
      if (r && r[key] !== undefined) return done(r[key]);
      if (area === chrome.storage.local) return done(undefined);
      chrome.storage.local.get([key], l => done(l && l[key]));
    });
  }

  function loadTheme() {
    try {
      readSetting('pt_theme', applyTheme);
      readSetting('pt_prefs', applyPrefs);
      chrome.storage.onChanged.addListener(changes => {
        if (changes.pt_theme) applyTheme(changes.pt_theme.newValue);
        if (changes.pt_prefs) applyPrefs(changes.pt_prefs.newValue);
      });
      if (typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', () => { if (!chosenTheme) applyTheme(''); });
      }
    } catch (e) {
      // Light theme and the default accent.
    }
  }

  // ---------------------------------------------------------------------------
  // Load and live updates
  //
  // One entry per stored section, in render order (rules read the settings).
  // `busy` names the element whose focus means an edit is in progress there.
  // ---------------------------------------------------------------------------
  const K = store.KEYS;
  const listPart = (key, storageKey, load, render, busy) => ({
    storageKey,
    load,
    busy,
    render: items => { lists[key] = items; render(); }
  });
  const PARTS = {
    profile: { storageKey: K.PROFILE, load: () => store.getProfile(), render: fillProfileForm },
    resume: { storageKey: K.RESUME, load: () => store.getResume(), render: renderResume },
    settings: { storageKey: K.SETTINGS, load: () => store.getSettings(), render: renderSettings },
    answers: listPart('answers', K.ANSWERS, () => store.getAnswers(), renderAnswers, 'answers'),
    rules: listPart('rules', K.RULES, () => store.getRules(), renderRules, 'rules-body')
  };

  async function loadAll() {
    const parts = Object.values(PARTS);
    const data = await Promise.all(parts.map(p => p.load()));
    parts.forEach((p, i) => p.render(data[i]));
  }

  // Lists are rebuilt from storage on outside changes, but never while focus
  // is inside them, so an edit in progress is not thrown away.
  const deferred = new Set();
  async function refresh(name) {
    const part = PARTS[name];
    if (part.busy && el(part.busy).contains(document.activeElement)) return deferred.add(name);
    part.render(await part.load());
  }

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      Array.from(deferred).forEach(name => {
        deferred.delete(name);
        refresh(name);
      });
    }, 0);
  });

  store.onChange((changes, keys) => {
    if (ownWrites > 0) return;
    Object.keys(PARTS).forEach(name => {
      if (keys.includes(PARTS[name].storageKey)) refresh(name);
    });
  });

  // Closing or hiding the tab while a field still has focus saves that field.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.type !== 'search') {
      active.dispatchEvent(new FocusEvent('blur'));
    }
  });

  buildProfileForm();
  loadTheme();
  selectTab(location.hash.slice(1));
  loadAll().catch(reportError);
})();
