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
        { key: 'firstName', label: 'First name', autocomplete: 'given-name' },
        { key: 'lastName', label: 'Last name', autocomplete: 'family-name' },
        { key: 'preferredName', label: 'Preferred name', autocomplete: 'nickname' },
        { key: 'email', label: 'Email', type: 'email', autocomplete: 'email' },
        { key: 'phoneCountryCode', label: 'Phone country code', placeholder: '+1', autocomplete: 'tel-country-code' },
        { key: 'phone', label: 'Phone', type: 'tel', autocomplete: 'tel-national' },
        { key: 'addressLine1', label: 'Address line 1', autocomplete: 'address-line1', wide: true },
        { key: 'addressLine2', label: 'Address line 2', autocomplete: 'address-line2', wide: true },
        { key: 'city', label: 'City', autocomplete: 'address-level2' },
        { key: 'state', label: 'State or province', autocomplete: 'address-level1' },
        { key: 'postalCode', label: 'Postal code', autocomplete: 'postal-code' },
        { key: 'country', label: 'Country', autocomplete: 'country-name' }
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
        { key: 'school', label: 'School', wide: true },
        { key: 'degree', label: 'Degree', placeholder: 'e.g. Bachelor of Science' },
        { key: 'major', label: 'Major', placeholder: 'e.g. Computer Science' },
        { key: 'gpa', label: 'GPA', placeholder: 'e.g. 3.8' },
        { key: 'gradMonth', label: 'Graduation month', options: [{ value: '', label: 'Not set' }].concat(MONTHS.map(m => ({ value: m, label: m }))) },
        { key: 'gradYear', label: 'Graduation year', placeholder: 'e.g. 2027', inputmode: 'numeric' }
      ]
    },
    {
      title: 'Work',
      fields: [
        { key: 'currentCompany', label: 'Current company', autocomplete: 'organization' },
        { key: 'currentTitle', label: 'Current title', autocomplete: 'organization-title' },
        { key: 'yearsExperience', label: 'Years of experience', placeholder: 'e.g. 2', inputmode: 'decimal' }
      ]
    },
    {
      title: 'Logistics',
      fields: [
        { key: 'workAuthorized', label: 'Authorized to work in the country of the job', options: YES_NO },
        { key: 'needsSponsorship', label: 'Will need visa sponsorship', options: YES_NO },
        { key: 'willingToRelocate', label: 'Willing to relocate', options: YES_NO },
        { key: 'earliestStartDate', label: 'Earliest start date', placeholder: 'e.g. June 2027 or 2027-06-01' },
        { key: 'salaryExpectation', label: 'Salary expectation', placeholder: 'e.g. $120,000' },
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

  // Two-click delete: the first click arms the button, the second confirms.
  function armedDelete(button, onConfirm) {
    const original = button.textContent;
    let timer = null;
    button.addEventListener('click', () => {
      if (!button.classList.contains('armed')) {
        button.classList.add('armed');
        button.textContent = 'Confirm';
        timer = setTimeout(() => {
          button.classList.remove('armed');
          button.textContent = original;
        }, 3000);
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
            spellcheck: 'false'
          });
          control.addEventListener('blur', () => saveProfileField(f.key, control));
          control.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); control.blur(); } });
        }
        profileControls[f.key] = control;
        grid.appendChild(make('label', { className: 'field' + (f.wide ? ' wide' : ''), for: id }, [
          make('span', { className: 'field-label', text: f.label }),
          control
        ]));
      });
      set.appendChild(grid);
      profileForm.appendChild(set);
    });
    profileForm.addEventListener('submit', e => e.preventDefault());
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
      el('resume-meta').textContent = '';
      el('resume-upload-btn').textContent = 'Upload';
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

  armedDelete(el('resume-remove-btn'), async () => {
    await write(store.clearResume());
    renderResume(null);
    el('resume-remove-btn').disabled = false;
    el('resume-remove-btn').classList.remove('armed');
    el('resume-remove-btn').textContent = 'Remove';
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
    empty.textContent = answers.length
      ? 'No saved answers match "' + answersSearch.value.trim() + '".'
      : 'No saved answers yet. They are added when you write a long answer on an application, or with Add answer.';
    show(empty, !visible.length);
  }

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
    armedDelete(del, async () => {
      await write(store.deleteAnswer(a.id));
      answers = answers.filter(x => x.id !== a.id);
      renderAnswers();
    });
    return item;
  }

  answersSearch.addEventListener('input', renderAnswers);

  const newForm = el('answer-new');
  el('answer-add-btn').addEventListener('click', () => {
    show(newForm, true);
    el('answer-new-question').focus();
  });
  el('answer-new-cancel').addEventListener('click', () => {
    newForm.reset();
    show(el('answer-new-error'), false);
    show(newForm, false);
  });
  newForm.addEventListener('submit', async e => {
    e.preventDefault();
    const errBox = el('answer-new-error');
    try {
      await write(store.saveAnswer({ question: el('answer-new-question').value, answer: el('answer-new-text').value }));
      newForm.reset();
      show(errBox, false);
      show(newForm, false);
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
      armedDelete(del, async () => {
        await write(store.deleteRule(rule.id));
        rules = rules.filter(r => r.id !== rule.id);
        renderRules();
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
    empty.textContent = rules.length
      ? 'No rules match "' + rulesSearch.value.trim() + '".'
      : 'No learned rules yet. When you fix a field after autofill, LIT remembers it here.';
    show(empty, !visible.length);
  }

  rulesSearch.addEventListener('input', renderRules);

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  const switches = Array.from(document.querySelectorAll('[data-setting]'));

  function renderSettings(settings) {
    switches.forEach(input => { input.checked = !!settings[input.dataset.setting]; });
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

  const importFile = el('import-file');
  el('import-btn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    importFile.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      if (!window.confirm('Import "' + file.name + '"? It replaces your profile, saved answers, learned rules, settings, and resume with the ones in the file.')) return;
      const counts = await write(store.importAll(text));
      await loadAll();
      setStatus('Imported ' + counts.answers + ' answers, ' + counts.rules + ' rules', 'saved');
    } catch (err) {
      reportError(err);
    }
  });

  armedDelete(el('clear-all-btn'), async () => {
    await write(store.clearAll());
    await loadAll();
    const btn = el('clear-all-btn');
    btn.disabled = false;
    btn.classList.remove('armed');
    btn.textContent = 'Erase all autofill data';
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

  buildProfileForm();
  loadTheme();
  loadAll().catch(reportError);

  try {
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView();
  } catch (e) {
    // Ignore a malformed hash.
  }
})();
