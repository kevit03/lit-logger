// LIT autofill profile editor (options/autofill.html).
//
// Every control saves itself: text fields on blur, selects and switches on
// change. Lists re-render when storage changes elsewhere (for example a rule
// learned on an application page), except while you are typing in them.
(() => {
  if (typeof AutofillStore === 'undefined' || !AutofillStore) return;
  const store = AutofillStore;

  const el = id => document.getElementById(id);

  // ---------------------------------------------------------------------------
  // Profile schema
  // ---------------------------------------------------------------------------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const YES_NO = [{ value: '', label: 'Not set' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }];
  const BLANK = { value: '', label: 'Leave blank' };
  const opts = list => [BLANK].concat(list.map(v => ({ value: v, label: v })));

  const GROUPS = [
    {
      title: 'Basics',
      fields: [
        { key: 'firstName', label: 'First name', autocomplete: 'given-name', placeholder: 'As it appears on your resume' },
        { key: 'lastName', label: 'Last name', autocomplete: 'family-name' },
        { key: 'preferredName', label: 'Preferred name', autocomplete: 'nickname', placeholder: 'Only if different from first name' },
        { key: 'email', label: 'Email', type: 'email', autocomplete: 'email', placeholder: 'name@example.com' },
        { key: 'phoneCountryCode', label: 'Phone country code', placeholder: '+1', autocomplete: 'tel-country-code' },
        { key: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel-national', placeholder: 'e.g. 555 123 4567' },
        { key: 'addressLine1', label: 'Address line 1', autocomplete: 'address-line1', wide: true, placeholder: 'Street address' },
        { key: 'addressLine2', label: 'Address line 2', autocomplete: 'address-line2', wide: true, placeholder: 'Apartment, suite, or unit (optional)' },
        { key: 'city', label: 'City', autocomplete: 'address-level2', placeholder: 'e.g. Seattle' },
        { key: 'state', label: 'State or province', autocomplete: 'address-level1', placeholder: 'e.g. WA or Washington' },
        { key: 'postalCode', label: 'Postal code', autocomplete: 'postal-code', placeholder: 'e.g. 98101' },
        { key: 'country', label: 'Country', autocomplete: 'country-name', placeholder: 'e.g. United States' }
      ]
    },
    {
      title: 'Links',
      fields: [
        { key: 'linkedin', label: 'LinkedIn', type: 'url', placeholder: 'https://www.linkedin.com/in/...' },
        { key: 'github', label: 'GitHub', type: 'url', placeholder: 'https://github.com/...' },
        { key: 'portfolio', label: 'Portfolio', type: 'url', placeholder: 'https://' },
        { key: 'website', label: 'Website', type: 'url', placeholder: 'https://' }
      ]
    },
    {
      title: 'Education',
      fields: [
        { key: 'school', label: 'School', wide: true, placeholder: 'e.g. University of Washington' },
        { key: 'degree', label: 'Degree', placeholder: 'e.g. Bachelor of Science' },
        { key: 'major', label: 'Major', placeholder: 'e.g. Computer Science' },
        { key: 'gpa', label: 'GPA', placeholder: 'e.g. 3.8', hint: 'Leave blank to skip GPA questions.' },
        { key: 'gradMonth', label: 'Graduation month', options: [{ value: '', label: 'Not set' }].concat(MONTHS.map(m => ({ value: m, label: m }))) },
        { key: 'gradYear', label: 'Graduation year', placeholder: 'e.g. 2027', inputmode: 'numeric',
          stepper: { min: 1950, max: 2100, start: new Date().getFullYear() } }
      ]
    },
    {
      title: 'Work',
      fields: [
        { key: 'currentCompany', label: 'Current company', autocomplete: 'organization', placeholder: 'Leave blank if not working' },
        { key: 'currentTitle', label: 'Current title', autocomplete: 'organization-title', placeholder: 'e.g. Software Engineer' },
        { key: 'yearsExperience', label: 'Years of experience', placeholder: 'e.g. 2', inputmode: 'decimal',
          stepper: { min: 0, max: 60, start: 0 }, hint: 'Count internships if the job is entry level.' }
      ]
    },
    {
      title: 'Logistics',
      fields: [
        { key: 'workAuthorized', label: 'Authorized to work in the country of the job', options: YES_NO },
        { key: 'needsSponsorship', label: 'Will need visa sponsorship', options: YES_NO },
        { key: 'willingToRelocate', label: 'Willing to relocate', options: YES_NO },
        { key: 'earliestStartDate', label: 'Earliest start date', placeholder: 'e.g. June 2027 or 2027-06-01' },
        { key: 'salaryExpectation', label: 'Salary expectation', placeholder: 'e.g. $120,000', hint: 'Filled exactly as written. Leave blank to skip.' },
        { key: 'howDidYouHear', label: 'How did you hear about us', placeholder: 'e.g. LinkedIn' }
      ]
    },
    {
      title: 'EEO',
      note: 'Voluntary self-identification. Each answer is left blank unless you pick one, and nothing here is filled unless "Fill EEO questions" is on in Settings.',
      fields: [
        { key: 'eeo.gender', label: 'Gender', options: opts(['Male', 'Female', 'Non-binary', 'Decline to self-identify']) },
        { key: 'eeo.race', label: 'Race or ethnicity', options: opts([
          'American Indian or Alaska Native', 'Asian', 'Black or African American',
          'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races',
          'Decline to self-identify']) },
        { key: 'eeo.hispanicLatino', label: 'Hispanic or Latino', options: [BLANK,
          { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
          { value: 'Decline to self-identify', label: 'Decline to self-identify' }] },
        { key: 'eeo.veteran', label: 'Veteran status', options: opts([
          'I am not a protected veteran',
          'I identify as one or more of the classifications of protected veteran',
          'I do not wish to answer']) },
        { key: 'eeo.disability', label: 'Disability status', options: opts([
          'No, I do not have a disability',
          'Yes, I have a disability (or previously had a disability)',
          'I do not want to answer']) }
      ]
    }
  ];

  const FIELD_LABELS = { fullName: 'Full name' };
  GROUPS.forEach(g => g.fields.forEach(f => { FIELD_LABELS[f.key] = f.label; }));
  Object.keys(FIELD_LABELS).forEach(k => {
    if (k.startsWith('eeo.')) FIELD_LABELS[k.slice(4)] = FIELD_LABELS[k];
  });

  const getPath = (obj, key) => {
    if (key.startsWith('eeo.')) return (obj.eeo || {})[key.slice(4)] || '';
    return obj[key] || '';
  };
  const patchFor = (key, value) => (key.startsWith('eeo.') ? { eeo: { [key.slice(4)]: value } } : { [key]: value });

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function make(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'className') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    (children || []).forEach(c => { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function show(node, visible) {
    node.classList.toggle('hidden', !visible);
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

  // Two-click delete: the first click arms the button and relabels it with
  // the action it will take, the second confirms. It disarms after 4 seconds.
  function armedDelete(button, confirmLabel, onConfirm) {
    const original = button.textContent;
    let timer = null;
    button.addEventListener('click', () => {
      if (!button.classList.contains('armed')) {
        button.classList.add('armed');
        button.textContent = confirmLabel;
        timer = setTimeout(() => {
          button.classList.remove('armed');
          button.textContent = original;
        }, 4000);
        return;
      }
      clearTimeout(timer);
      button.disabled = true;
      Promise.resolve(onConfirm()).catch(err => {
        button.disabled = false;
        button.classList.remove('armed');
        button.textContent = original;
        reportError(err);
      });
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
    status.className = 'save-status' + (kind ? ' is-' + kind : '') + (text ? ' is-visible' : '');
    if (kind === 'saved') {
      statusTimer = setTimeout(() => { status.className = 'save-status is-saved'; }, 1600);
    }
  }

  function reportError(err) {
    const msg = (err && err.message) || String(err);
    setStatus('Not saved', 'error');
    const banner = el('page-error');
    banner.textContent = msg;
    show(banner, true);
  }

  async function saving(promise) {
    pending++;
    setStatus('Saving', 'saving');
    try {
      const result = await promise;
      pending--;
      if (!pending) setStatus('Saved', 'saved');
      show(el('page-error'), false);
      return result;
    } catch (err) {
      pending--;
      reportError(err);
      throw err;
    }
  }

  // Storage changes made by this page are already on screen; this keeps the
  // onChange listener from rebuilding lists for our own writes.
  let ownWrites = 0;
  async function write(promise) {
    ownWrites++;
    try {
      return await saving(promise);
    } finally {
      setTimeout(() => { ownWrites = Math.max(0, ownWrites - 1); }, 300);
    }
  }

  // ---------------------------------------------------------------------------
  // Undo bar: shown after a delete, erase, or import, for 8 seconds
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
      await write(action());
      await loadAll();
      setStatus('Restored', 'saved');
    } catch (err) {
      reportError(err);
    }
  });

  // Puts one section back exactly as it was (order and ids included) without
  // touching the others: importAll leaves sections missing from the data alone.
  function restoreSection(snapshot, key) {
    return () => store.importAll({ format: snapshot.format, version: snapshot.version, [key]: snapshot[key] });
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------
  const profileForm = el('profile-form');
  const profileControls = {};
  let savedProfile = null;

  function ensureOption(select, value) {
    if (!value) return;
    const exists = Array.from(select.options).some(o => o.value === value);
    if (!exists) select.appendChild(make('option', { value, text: value }));
  }

  function buildProfileForm() {
    profileForm.textContent = '';
    GROUPS.forEach(group => {
      const set = make('fieldset', { className: 'group' });
      set.appendChild(make('legend', { text: group.title }));
      if (group.note) set.appendChild(make('p', { className: 'group-note', text: group.note }));
      const grid = make('div', { className: 'grid' });
      group.fields.forEach(f => {
        const id = 'pf-' + f.key.replace('.', '-');
        let control;
        if (f.options) {
          control = make('select', { id, className: 'input' }, f.options.map(o => make('option', { value: o.value, text: o.label })));
          control.addEventListener('change', () => saveProfileField(f.key, control));
        } else {
          control = make('input', {
            id,
            className: 'input',
            type: f.type || 'text',
            autocomplete: f.autocomplete || 'off',
            placeholder: f.placeholder || '',
            inputmode: f.inputmode,
            spellcheck: 'false',
            'aria-describedby': f.hint ? id + '-hint' : null
          });
          control.addEventListener('blur', () => saveProfileField(f.key, control));
          control.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); control.blur(); } });
        }
        if (f.options && f.hint) control.setAttribute('aria-describedby', id + '-hint');
        profileControls[f.key] = control;
        // Hints are always visible under the field, so they work on touch and
        // keyboard too (no hover-only tooltips).
        grid.appendChild(make('div', { className: 'field' + (f.wide ? ' wide' : '') }, [
          make('label', { className: 'field-label', for: id, text: f.label }),
          f.stepper ? stepper(f, control) : control,
          f.hint ? make('span', { className: 'field-hint', id: id + '-hint', text: f.hint }) : null
        ]));
      });
      set.appendChild(grid);
      profileForm.appendChild(set);
    });
    profileForm.addEventListener('submit', e => e.preventDefault());
  }

  // Whole-number fields get -/+ buttons. The input stays a text box so a typed
  // value like "2.5" still saves as written; the buttons round to whole steps.
  function stepper(f, control) {
    const cfg = f.stepper;
    const name = f.label.toLowerCase();
    const bump = delta => {
      const n = parseFloat(control.value);
      const base = isNaN(n) ? cfg.start : Math.round(n) + delta;
      control.value = String(Math.min(cfg.max, Math.max(cfg.min, base)));
      saveProfileField(f.key, control);
    };
    const button = (text, label, delta) => {
      const b = make('button', { type: 'button', className: 'step-btn', 'aria-label': label, title: label, text });
      b.addEventListener('click', e => { e.preventDefault(); bump(delta); });
      return b;
    };
    control.classList.add('step-input');
    control.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        bump(e.key === 'ArrowUp' ? 1 : -1);
      }
    });
    return make('div', { className: 'stepper' }, [
      button('\u2212', 'Decrease ' + name, -1),
      control,
      button('+', 'Increase ' + name, 1)
    ]);
  }

  function fillProfileForm(profile) {
    savedProfile = profile;
    Object.keys(profileControls).forEach(key => {
      const control = profileControls[key];
      if (document.activeElement === control) return;
      const value = getPath(profile, key);
      if (control.tagName === 'SELECT') ensureOption(control, value);
      control.value = value;
    });
  }

  async function saveProfileField(key, control) {
    const value = control.tagName === 'SELECT' ? control.value : control.value.trim();
    if (savedProfile && getPath(savedProfile, key) === value) return;
    try {
      const next = await write(store.saveProfile(patchFor(key, value)));
      savedProfile = next;
      if (control.tagName !== 'SELECT' && document.activeElement !== control) control.value = getPath(next, key);
    } catch (e) {
      // Shown by reportError.
    }
  }

  // ---------------------------------------------------------------------------
  // Resume
  // ---------------------------------------------------------------------------
  const resumeFile = el('resume-file');

  function showResumeError(msg) {
    const box = el('resume-error');
    box.textContent = msg || '';
    show(box, !!msg);
  }

  function renderResume(resume) {
    const download = el('resume-download');
    if (!resume) {
      el('resume-name').textContent = 'No resume uploaded';
      el('resume-meta').textContent = 'Upload one so LIT can attach it when an application asks for a resume.';
      el('resume-upload-btn').textContent = 'Upload resume';
      download.removeAttribute('href');
      show(download, false);
      show(el('resume-remove-btn'), false);
      return;
    }
    el('resume-name').textContent = resume.name;
    el('resume-meta').textContent = [formatBytes(resume.size), resume.savedAt ? 'Uploaded ' + formatDate(resume.savedAt) : '']
      .filter(Boolean).join(' / ');
    el('resume-upload-btn').textContent = 'Replace';
    download.href = resume.dataUrl;
    download.setAttribute('download', resume.name);
    show(download, true);
    show(el('resume-remove-btn'), true);
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Could not read that file.'));
      reader.readAsDataURL(file);
    });
  }

  el('resume-upload-btn').addEventListener('click', () => resumeFile.click());
  resumeFile.addEventListener('change', async () => {
    const file = resumeFile.files && resumeFile.files[0];
    resumeFile.value = '';
    if (!file) return;
    showResumeError('');
    if (file.size > store.RESUME_MAX_BYTES) {
      showResumeError('"' + file.name + '" is ' + formatBytes(file.size) + '. The limit is 5 MB.');
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      await write(store.saveResume({ name: file.name, type: file.type, dataUrl }));
      renderResume(await store.getResume());
    } catch (err) {
      showResumeError((err && err.message) || String(err));
    }
  });

  armedDelete(el('resume-remove-btn'), 'Yes, remove resume', async () => {
    const previous = await store.getResume();
    await write(store.clearResume());
    renderResume(null);
    el('resume-remove-btn').disabled = false;
    el('resume-remove-btn').classList.remove('armed');
    el('resume-remove-btn').textContent = 'Remove';
    if (previous) offerUndo('Resume removed.', () => store.saveResume(previous));
  });

  // ---------------------------------------------------------------------------
  // Saved answers
  // ---------------------------------------------------------------------------
  const answersList = el('answers-list');
  const answersSearch = el('answers-search');
  let answers = [];

  function answerMatches(a, q) {
    if (!q) return true;
    return (a.question + '\n' + a.answer).toLowerCase().includes(q);
  }

  function renderAnswers() {
    const q = answersSearch.value.trim().toLowerCase();
    const visible = answers.filter(a => answerMatches(a, q));
    answersList.textContent = '';
    visible.forEach(a => answersList.appendChild(answerItem(a)));
    const empty = el('answers-empty');
    empty.textContent = '';
    if (answers.length) {
      empty.appendChild(make('p', { text: 'No saved answers match "' + answersSearch.value.trim() + '".' }));
    } else {
      // Starting points instead of a blank list: each opens the new-answer
      // form with the question filled in.
      empty.appendChild(make('p', { text: 'No saved answers yet. LIT adds one when you write a long answer on an application. Or start from a common question:' }));
      empty.appendChild(make('div', { className: 'template-list' }, ANSWER_TEMPLATES.map(q => {
        const b = make('button', { type: 'button', className: 'btn btn-ghost btn-sm template-btn', text: q });
        b.addEventListener('click', () => openNewAnswer(q));
        return b;
      })));
    }
    show(empty, !visible.length);
  }

  const ANSWER_TEMPLATES = [
    'Why do you want to work here?',
    'Tell us about yourself.',
    'Describe a challenging project you worked on.',
    'Is there anything else you would like us to know?'
  ];

  function answerItem(a) {
    const qInput = make('input', { type: 'text', className: 'input', value: a.question, 'aria-label': 'Question', autocomplete: 'off' });
    const aText = make('textarea', { className: 'input textarea', rows: '3', 'aria-label': 'Answer' });
    aText.value = a.answer;
    const meta = make('span', { className: 'item-meta', text: a.updatedAt ? 'Updated ' + formatDate(a.updatedAt) : '' });
    const del = make('button', { type: 'button', className: 'btn btn-danger-ghost btn-sm', text: 'Delete' });
    const err = make('div', { className: 'field-error hidden', role: 'alert' });
    const item = make('div', { className: 'answer-item', dataset: { id: a.id } }, [
      qInput,
      aText,
      make('div', { className: 'row-actions between' }, [meta, del]),
      err
    ]);

    const commit = async () => {
      const question = qInput.value.trim();
      const answer = aText.value;
      if (question === a.question && answer === a.answer) return;
      if (!question || !answer.trim()) {
        err.textContent = 'A saved answer needs both a question and an answer. Use Delete to remove it.';
        show(err, true);
        return;
      }
      show(err, false);
      try {
        const saved = await write(store.saveAnswer({ id: a.id, question, answer }));
        Object.assign(a, saved);
        meta.textContent = 'Updated ' + formatDate(saved.updatedAt);
        refresh('answers');
      } catch (e) {
        err.textContent = (e && e.message) || String(e);
        show(err, true);
      }
    };
    qInput.addEventListener('blur', commit);
    aText.addEventListener('blur', commit);
    armedDelete(del, 'Yes, delete answer', async () => {
      const snapshot = await store.exportAll({ includeResume: false });
      await write(store.deleteAnswer(a.id));
      answers = answers.filter(x => x.id !== a.id);
      renderAnswers();
      offerUndo('Answer deleted.', restoreSection(snapshot, 'answers'));
    });
    return item;
  }

  answersSearch.addEventListener('input', renderAnswers);

  // While the new-answer form is open its Save button is the one primary
  // action in this section, so Add answer steps aside.
  const newForm = el('answer-new');
  function openNewAnswer(question) {
    show(newForm, true);
    show(el('answer-add-btn'), false);
    if (question) {
      el('answer-new-question').value = question;
      el('answer-new-text').focus();
    } else {
      el('answer-new-question').focus();
    }
  }
  function closeNewAnswer() {
    newForm.reset();
    show(el('answer-new-error'), false);
    show(newForm, false);
    show(el('answer-add-btn'), true);
  }
  el('answer-add-btn').addEventListener('click', () => openNewAnswer(''));
  el('answer-new-cancel').addEventListener('click', closeNewAnswer);
  newForm.addEventListener('submit', async e => {
    e.preventDefault();
    const errBox = el('answer-new-error');
    try {
      await write(store.saveAnswer({ question: el('answer-new-question').value, answer: el('answer-new-text').value }));
      closeNewAnswer();
      answers = await store.getAnswers();
      renderAnswers();
    } catch (err) {
      errBox.textContent = (err && err.message) || String(err);
      show(errBox, true);
    }
  });

  // ---------------------------------------------------------------------------
  // Learned rules
  // ---------------------------------------------------------------------------
  const rulesSearch = el('rules-search');
  let rules = [];

  function describeTarget(rule) {
    if (rule.profileKey) {
      return { text: FIELD_LABELS[rule.profileKey] || rule.profileKey, kind: 'Profile' };
    }
    return { text: rule.value === '' ? '(empty)' : rule.value, kind: 'Value' };
  }

  function renderRules() {
    const q = rulesSearch.value.trim().toLowerCase();
    const visible = rules.filter(r => !q || (r.host + ' ' + r.labelKey + ' ' + (r.profileKey || r.value || '')).toLowerCase().includes(q));
    const body = el('rules-body');
    body.textContent = '';
    visible.forEach(rule => {
      const target = describeTarget(rule);
      const del = make('button', { type: 'button', className: 'btn btn-danger-ghost btn-sm', text: 'Delete' });
      armedDelete(del, 'Yes, delete rule', async () => {
        const snapshot = await store.exportAll({ includeResume: false });
        await write(store.deleteRule(rule.id));
        rules = rules.filter(r => r.id !== rule.id);
        renderRules();
        offerUndo('Rule deleted.', restoreSection(snapshot, 'rules'));
      });
      body.appendChild(make('tr', null, [
        make('td', { className: 'mono' }, [rule.host === '*' ? make('span', { className: 'chip', text: 'All sites' }) : rule.host]),
        make('td', { text: rule.labelKey }),
        make('td', null, [make('span', { className: 'chip chip-soft', text: target.kind }), ' ', target.text]),
        make('td', { className: 'actions' }, [del])
      ]));
    });
    show(el('rules-table'), visible.length > 0);
    const empty = el('rules-empty');
    empty.textContent = '';
    if (rules.length) {
      empty.appendChild(make('p', { text: 'No rules match "' + rulesSearch.value.trim() + '".' }));
    } else if (!currentSettings.autoLearn) {
      // The likely reason for an empty list, with the fix one click away.
      empty.appendChild(make('p', { text: 'No learned rules yet. Learn from corrections is off, so fixes you make on applications are not saved.' }));
      const on = make('button', { type: 'button', className: 'btn btn-ghost btn-sm', text: 'Turn on Learn from corrections' });
      on.addEventListener('click', async () => {
        try {
          renderSettings(await write(store.saveSettings({ autoLearn: true })));
        } catch (e) {
          // Shown by reportError.
        }
      });
      empty.appendChild(on);
    } else {
      empty.appendChild(make('p', { text: 'No learned rules yet. Autofill an application, then fix any field LIT got wrong. LIT remembers the fix here and uses it next time.' }));
    }
    show(empty, !visible.length);
  }

  rulesSearch.addEventListener('input', renderRules);

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const switches = Array.from(document.querySelectorAll('[data-setting]'));
  let currentSettings = {};

  function renderSettings(settings) {
    const learnChanged = !!currentSettings.autoLearn !== !!settings.autoLearn;
    currentSettings = settings || {};
    switches.forEach(input => { input.checked = !!currentSettings[input.dataset.setting]; });
    if (learnChanged) renderRules();
  }

  switches.forEach(input => {
    input.addEventListener('change', async () => {
      try {
        renderSettings(await write(store.saveSettings({ [input.dataset.setting]: input.checked })));
      } catch (e) {
        input.checked = !input.checked;
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Import / export / erase
  // ---------------------------------------------------------------------------
  el('export-btn').addEventListener('click', async () => {
    try {
      const data = await store.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = make('a', { href: url, download: 'lit-autofill-' + new Date().toISOString().slice(0, 10) + '.json' });
      document.body.appendChild(a);
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
      const snapshot = await store.exportAll();
      const counts = await write(store.importAll(job.text));
      await loadAll();
      setStatus('Imported ' + counts.answers + ' answers, ' + counts.rules + ' rules', 'saved');
      offerUndo('Imported "' + job.name + '".', () => store.importAll(snapshot));
    } catch (err) {
      reportError(err);
    }
  });

  armedDelete(el('clear-all-btn'), 'Yes, erase everything', async () => {
    const snapshot = await store.exportAll();
    await write(store.clearAll());
    await loadAll();
    const btn = el('clear-all-btn');
    btn.disabled = false;
    btn.classList.remove('armed');
    btn.textContent = 'Erase all autofill data';
    offerUndo('All autofill data erased.', () => store.importAll(snapshot));
  });

  // ---------------------------------------------------------------------------
  // Theme (follows the popup's light/dark choice)
  // ---------------------------------------------------------------------------
  function applyTheme(theme) {
    document.body.classList.toggle('pt-dark', theme === 'dark');
  }

  function loadTheme() {
    try {
      const area = chrome.storage.sync || chrome.storage.local;
      area.get(['pt_theme'], r => {
        if (r && r.pt_theme) return applyTheme(r.pt_theme);
        chrome.storage.local.get(['pt_theme'], l => applyTheme(l && l.pt_theme));
      });
      chrome.storage.onChanged.addListener(changes => {
        if (changes.pt_theme) applyTheme(changes.pt_theme.newValue);
      });
    } catch (e) {
      // Light theme by default.
    }
  }

  // ---------------------------------------------------------------------------
  // Load and live updates
  // ---------------------------------------------------------------------------
  async function loadAll() {
    const [profile, resume, list, ruleList, settings] = await Promise.all([
      store.getProfile(), store.getResume(), store.getAnswers(), store.getRules(), store.getSettings()
    ]);
    fillProfileForm(profile);
    renderResume(resume);
    answers = list;
    renderAnswers();
    rules = ruleList;
    renderRules();
    renderSettings(settings);
  }

  // Lists are rebuilt from storage on outside changes, but never while focus
  // is inside them, so an edit in progress is not thrown away.
  const deferred = new Set();
  function focusInside(node) {
    return node.contains(document.activeElement);
  }

  async function refresh(part) {
    if (part === 'answers') {
      if (focusInside(el('answers'))) return deferred.add(part);
      answers = await store.getAnswers();
      renderAnswers();
    } else if (part === 'rules') {
      if (focusInside(el('rules-body'))) return deferred.add(part);
      rules = await store.getRules();
      renderRules();
    } else if (part === 'profile') {
      fillProfileForm(await store.getProfile());
    } else if (part === 'resume') {
      renderResume(await store.getResume());
    } else if (part === 'settings') {
      renderSettings(await store.getSettings());
    }
  }

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      Array.from(deferred).forEach(part => {
        deferred.delete(part);
        refresh(part);
      });
    }, 0);
  });

  store.onChange((changes, keys) => {
    if (ownWrites > 0) return;
    const K = store.KEYS;
    const map = { [K.PROFILE]: 'profile', [K.RESUME]: 'resume', [K.ANSWERS]: 'answers', [K.RULES]: 'rules', [K.SETTINGS]: 'settings' };
    keys.forEach(k => { if (map[k]) refresh(map[k]); });
  });

  // Closing or hiding the tab while a field still has focus saves that field.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.type !== 'search') {
      active.dispatchEvent(new FocusEvent('blur'));
    }
  });

  // ---------------------------------------------------------------------------
  // Section nav: marks the section in view
  // ---------------------------------------------------------------------------
  const navLinks = Array.from(document.querySelectorAll('.section-nav a'));
  let navFrame = 0;

  function markActiveSection() {
    navFrame = 0;
    const offset = document.querySelector('.topbar').offsetHeight + 24;
    let current = navLinks[0];
    navLinks.forEach(link => {
      const section = document.getElementById(link.getAttribute('href').slice(1));
      if (section && section.getBoundingClientRect().top <= offset) current = link;
    });
    // At the bottom of the page the last short sections never reach the top.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      current = navLinks[navLinks.length - 1];
    }
    navLinks.forEach(link => {
      if (link === current) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  window.addEventListener('scroll', () => {
    if (!navFrame) navFrame = requestAnimationFrame(markActiveSection);
  }, { passive: true });

  buildProfileForm();
  loadTheme();
  markActiveSection();
  loadAll().catch(reportError);

  try {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView();
  } catch (e) {
    // Ignore a malformed hash.
  }
})();
