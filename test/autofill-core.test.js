// Autofill engine tests: label normalization and extraction, scanning rules
// (hidden / disabled / filled / submit), the synonym dictionary, match
// priority (adapter > host rule > global rule > autocomplete > dictionary >
// answer bank), fuzzy select / radio / checkbox options, the React-style
// native setter, file inputs through DataTransfer, EEO gating, and run()
// end to end.
const assert = require('assert');
const path = require('path');
const { installAutofillDom } = require('./mock_autofill_1');

const ROOT = path.resolve(__dirname, '..');

function freshCore() {
  const full = path.join(ROOT, 'shared/autofill-core.js');
  delete require.cache[require.resolve(full)];
  return require(full);
}

const PROFILE = {
  firstName: 'Ada', lastName: 'Lovelace', preferredName: 'Ada', email: 'ada@example.com', phone: '555-0100',
  phoneCountryCode: '+1', addressLine1: '1 Analytical Way', addressLine2: 'Apt 2', city: 'San Jose', state: 'CA',
  postalCode: '95112', country: 'United States', linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada',
  portfolio: 'https://ada.dev/work', website: 'https://ada.dev', school: 'University of London', degree: 'BS',
  major: 'Mathematics', gpa: '3.9', gradMonth: 'May', gradYear: '2026', currentCompany: 'Engines Ltd',
  currentTitle: 'Analyst', yearsExperience: '3', workAuthorized: 'yes', needsSponsorship: 'no', willingToRelocate: 'yes',
  earliestStartDate: '2026-06-01', salaryExpectation: '120000', howDidYouHear: 'LinkedIn',
  eeo: { gender: 'Female', race: 'White', hispanicLatino: 'No', veteran: 'No', disability: '' }
};

const RESUME = { name: 'ada.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4 ada').toString('base64') };

function only(list, msg) {
  assert.strictEqual(list.length, 1, msg + ' (got ' + list.length + ')');
  return list[0];
}

async function run() {
  console.log('--- Running test/autofill-core.test.js ---');

  // normalizeLabel
  {
    const C = freshCore();
    assert.strictEqual(C.normalizeLabel('First Name *'), 'first name');
    assert.strictEqual(C.normalizeLabel('  LinkedIn Profile (Optional) '), 'linkedin profile');
    assert.strictEqual(C.normalizeLabel('Email Address (required)'), 'email address');
    assert.strictEqual(C.normalizeLabel('What\'s your\n  favorite   color?'), 'what s your favorite color');
    assert.strictEqual(C.normalizeLabel('Are you 18+? / Yes-No'), 'are you 18 yes no');
    assert.strictEqual(C.normalizeLabel(null), '');
    // Must agree with the private copy in shared/autofill-store.js.
    assert.strictEqual(C.normalizeLabel('Don\'t * Résumé (optional) Required!'), 'don t résumé');
    ['First Name *', 'Résumé/CV (optional)', 'Will you REQUIRE sponsorship?'].forEach(s => {
      const once = C.normalizeLabel(s);
      assert.strictEqual(C.normalizeLabel(once), once, 'idempotent for ' + s);
    });
    console.log('[PASS] normalizeLabel strips punctuation, asterisks, (optional), required');
  }

  // Label extraction strategies, in priority order
  {
    const { doc, h, restore } = installAutofillDom();
    const C = freshCore();
    const form = h('form', {},
      h('label', { for: 'a' }, 'Label For'),
      h('input', { id: 'a', 'aria-label': 'Aria loses', placeholder: 'Placeholder loses' }),
      h('label', {}, 'Wrapped label', h('input', { id: 'b' })),
      h('label', {}, 'Country', h('select', { id: 'c' }, h('option', { value: '' }, 'Pick'), h('option', {}, 'Canada'))),
      h('span', { id: 'q1' }, 'Labelled'), h('span', { id: 'q2' }, 'By Two'),
      h('div', {}, h('input', { id: 'd', 'aria-labelledby': 'q1 q2' })),
      h('div', {}, h('input', { id: 'e', 'aria-label': 'Aria Only' })),
      h('div', { class: 'question' },
        h('div', { class: 'q-text' }, 'Why do you want to work here?'),
        h('div', {}, h('div', {}, h('textarea', { id: 'f' })))),
      h('div', {}, h('input', { id: 'g', placeholder: 'Your city' })),
      h('div', {}, h('input', { id: 'h', name: 'job_application[zip]' })),
      h('fieldset', {},
        h('legend', {}, 'Are you legally authorized to work in the US?'),
        h('label', {}, h('input', { type: 'radio', name: 'auth', value: 'y' }), 'Yes'),
        h('label', {}, h('input', { type: 'radio', name: 'auth', value: 'n' }), 'No')),
      h('div', { class: 'application-question' },
        h('div', { class: 'application-label' }, 'Will you require sponsorship?'),
        h('ul', {},
          h('li', {}, h('label', {}, h('input', { type: 'radio', name: 'spon', value: 'Yes' }), 'Yes')),
          h('li', {}, h('label', {}, h('input', { type: 'radio', name: 'spon', value: 'No' }), 'No')))),
      h('div', { role: 'group', 'aria-label': 'Which languages?' },
        h('input', { type: 'checkbox', name: 'lang[]', id: 'l1', value: 'js' }), h('label', { for: 'l1' }, 'JavaScript'),
        h('input', { type: 'checkbox', name: 'lang[]', id: 'l2', value: 'py' }), h('label', { for: 'l2' }, 'Python')),
      h('div', {}, h('input', { type: 'checkbox', id: 'agree' }), h('span', {}, 'I am willing to relocate')),
      h('div', {},
        h('label', { for: 'uuid-5' }, 'Will you require sponsorship?'),
        h('div', {}, h('button', { type: 'button' }, 'Yes'), h('button', { type: 'button' }, 'No'),
          h('input', { type: 'checkbox', name: 'uuid-5' })))
    );
    doc.body.appendChild(form);
    const fields = C.scanFields(doc);
    const by = sel => fields.find(f => f.el === doc.querySelector(sel) || (f.inputs || []).includes(doc.querySelector(sel)));
    assert.strictEqual(by('#a').label, 'Label For', 'label[for] beats aria-label and placeholder');
    assert.strictEqual(by('#b').label, 'Wrapped label');
    assert.strictEqual(by('#c').label, 'Country', 'wrapping label text excludes the option text');
    assert.deepStrictEqual(by('#c').options, ['Canada'], 'placeholder option is not an option');
    assert.strictEqual(by('#d').label, 'Labelled By Two', 'aria-labelledby joins every id');
    assert.strictEqual(by('#e').label, 'Aria Only');
    assert.strictEqual(by('#f').label, 'Why do you want to work here?', 'preceding question text in the container');
    assert.strictEqual(by('#f').kind, 'textarea');
    assert.strictEqual(by('#g').label, 'Your city', 'placeholder');
    assert.strictEqual(by('#h').label, 'job_application[zip]', 'name is the last resort');
    const auth = by('input[name="auth"]');
    assert.strictEqual(auth.kind, 'radio');
    assert.strictEqual(auth.label, 'Are you legally authorized to work in the US?', 'legend labels a radio group');
    assert.deepStrictEqual(auth.options, ['Yes', 'No']);
    assert.strictEqual(auth.inputs.length, 2);
    assert.ok(auth.group && auth.group.tagName === 'FIELDSET');
    const spon = by('input[name="spon"]');
    assert.strictEqual(spon.label, 'Will you require sponsorship?', 'question text above a radio list');
    assert.deepStrictEqual(spon.options, ['Yes', 'No']);
    const langs = by('#l1');
    assert.strictEqual(langs.kind, 'checkbox');
    assert.strictEqual(langs.label, 'Which languages?');
    assert.deepStrictEqual(langs.options, ['JavaScript', 'Python']);
    assert.strictEqual(by('#agree').label, 'I am willing to relocate', 'single checkbox reads the text after it');
    assert.strictEqual(fields.filter(f => f.kind === 'radio').length, 2, 'one descriptor per radio group');
    assert.strictEqual(by('input[name="uuid-5"]').label, 'Will you require sponsorship?', 'label[for] naming an id-less field by its name (Ashby yes/no)');
    restore();
    console.log('[PASS] Label extraction: for, wrap, labelledby, aria-label, question text, placeholder, name, groups');
  }

  // Scanning skips hidden, disabled, filled, and non-fields; finds comboboxes
  {
    const { doc, h, restore } = installAutofillDom();
    const C = freshCore();
    let submitted = 0;
    const submit = h('button', { type: 'submit' }, 'Submit application');
    submit.addEventListener('click', () => { submitted++; });
    const filledSelect = h('select', { id: 'fs' }, h('option', { value: '' }, 'Select...'), h('option', { value: 'x', selected: '' }, 'X'));
    doc.body.appendChild(h('form', {},
      h('input', { id: 'visible', name: 'first_name' }),
      h('input', { id: 'typeHidden', type: 'hidden', name: 'token' }),
      h('div', { style: { display: 'none' } }, h('input', { id: 'inHiddenDiv' })),
      h('input', { id: 'hiddenAttr', hidden: '' }),
      h('input', { id: 'invisible', style: { visibility: 'hidden' } }),
      h('input', { id: 'disabled', disabled: '' }),
      h('fieldset', { disabled: '' }, h('input', { id: 'inDisabledFieldset' })),
      h('input', { id: 'readonly', readonly: '' }),
      h('input', { id: 'filled', value: 'already here' }),
      h('input', { id: 'pw', type: 'password' }),
      h('input', { id: 'search', type: 'search' }),
      h('select', { id: 'ph' }, h('option', { value: '' }, '-- Select --'), h('option', { value: 'a' }, 'A')),
      filledSelect,
      h('div', { 'data-lit-autofill-ignore': '' }, h('input', { id: 'ours' })),
      h('label', { id: 'wdl' }, 'Country'),
      h('button', { id: 'wd', type: 'button', 'aria-haspopup': 'listbox', 'aria-labelledby': 'wdl' }, 'Select One'),
      h('div', {}, h('label', { for: 'rs' }, 'School'), h('input', { id: 'rs', role: 'combobox' })),
      h('input', { id: 'filePick', type: 'file', style: { display: 'none' } }),
      h('input', { type: 'submit', value: 'Go' }),
      h('input', { type: 'button', value: 'Other' }),
      submit
    ));
    const host = h('div', {});
    doc.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('label', { for: 'sh' }, 'Email'));
    shadow.appendChild(h('input', { id: 'sh' }));

    const ids = C.scanFields(doc).map(f => f.id);
    assert.deepStrictEqual(ids.sort(), ['filePick', 'ph', 'rs', 'sh', 'visible', 'wd'].sort());
    const all = C.scanFields(doc, { includeFilled: true });
    assert.ok(all.find(f => f.id === 'filled').filled, 'includeFilled marks filled text');
    assert.ok(all.find(f => f.id === 'fs').filled, 'a select on a real option is filled');
    assert.ok(!all.find(f => f.id === 'ph').filled, 'a select on its placeholder is not');
    const wd = all.find(f => f.id === 'wd');
    assert.strictEqual(wd.kind, 'combobox');
    assert.strictEqual(wd.label, 'Country');
    assert.strictEqual(all.find(f => f.id === 'rs').kind, 'combobox');
    assert.strictEqual(all.find(f => f.id === 'sh').label, 'Email', 'open shadow roots are scanned with their own labels');
    assert.strictEqual(submitted, 0);
    restore();
    console.log('[PASS] Scan skips hidden, disabled, readonly, filled, password, submit, and our own UI');
  }

  // Dictionary hits, misses, confidence
  {
    const C = freshCore();
    const d = (label, extra = {}) => Object.assign({ kind: 'text', label, labelKey: C.normalizeLabel(label), name: '', id: '', autocomplete: '', placeholder: '', options: [] }, extra);
    const hit = (label, extra) => { const r = C.dictionaryLookup(d(label, extra)); return r && r.key; };
    const table = [
      ['First Name', 'firstName'], ['Legal First Name *', 'firstName'], ['Given name', 'firstName'],
      ['Last Name', 'lastName'], ['Family name', 'lastName'], ['Surname', 'lastName'],
      ['Full Name', 'fullName'], ['Name', 'fullName'], ['Preferred First Name', 'preferredName'],
      ['Email Address', 'email'], ['Mobile', 'phone'], ['Phone Number', 'phone'], ['Country Code', 'phoneCountryCode'],
      ['Address', 'addressLine1'], ['Address Line 2', 'addressLine2'], ['City', 'city'], ['State/Province', 'state'],
      ['Zip Code', 'postalCode'], ['Country', 'country'], ['Location', 'location'],
      ['LinkedIn Profile URL', 'linkedin'], ['GitHub', 'github'], ['Portfolio', 'portfolio'], ['Website', 'website'],
      ['University', 'school'], ['School Name', 'school'], ['Degree', 'degree'], ['Field of Study', 'major'], ['GPA', 'gpa'],
      ['Expected Graduation', 'gradDate'], ['Expected graduation year', 'gradYear'], ['Graduation Month', 'gradMonth'],
      ['Current Company', 'currentCompany'], ['Current Title', 'currentTitle'], ['Years of experience', 'yearsExperience'],
      ['Are you legally authorized to work in the United States?', 'workAuthorized'],
      ['Will you now or in the future require sponsorship for employment visa status (e.g., H-1B)?', 'needsSponsorship'],
      ['Are you willing to relocate?', 'willingToRelocate'], ['Earliest start date', 'earliestStartDate'],
      ['When can you start?', 'earliestStartDate'], ['Salary expectations', 'salaryExpectation'],
      ['How did you hear about us?', 'howDidYouHear'],
      ['Gender', 'eeo.gender'], ['Race/Ethnicity', 'eeo.race'], ['Are you Hispanic/Latino?', 'eeo.hispanicLatino'],
      ['Veteran Status', 'eeo.veteran'], ['Disability Status', 'eeo.disability']
    ];
    table.forEach(([label, key]) => assert.strictEqual(hit(label), key, label));
    ['Favorite color', 'Phone device type', 'Company website', 'Cover letter', 'Why do you want to work here?',
      'Are you willing to work in the state of New York on weekends and holidays?'].forEach(label => {
      assert.strictEqual(hit(label), null, 'no match for ' + label);
    });
    assert.strictEqual(hit('Resume/CV', { kind: 'file' }), 'resume');
    assert.strictEqual(hit('Cover Letter', { kind: 'file' }), null);
    assert.strictEqual(hit('Resume/CV'), null, 'resume only matches file inputs');
    assert.strictEqual(hit('', { name: 'job_application[first_name]' }), 'firstName', 'name attribute segment');
    assert.strictEqual(hit('Contact', { id: 'lastName' }), 'lastName', 'camelCase id');
    assert.strictEqual(hit('', { name: 'org' }), 'currentCompany', 'Lever org');
    assert.strictEqual(hit('Which university are you currently attending or did you last attend?'), 'school', 'long school question');
    assert.notStrictEqual(hit('Which high school did you attend?'), 'school', 'high school is not the school key');
    assert.strictEqual(C.dictionaryLookup(d('First Name')).confidence, 0.9, 'exact');
    assert.strictEqual(C.dictionaryLookup(d('Your first name as on passport')).confidence, 0.6, 'loose');

    const m = C.matchField(d('First Name'), PROFILE, [], 'x.com');
    assert.deepStrictEqual(m, { profileKey: 'firstName', value: 'Ada', confidence: 0.9, source: 'dictionary' });
    assert.strictEqual(C.matchField(d('Full Name'), PROFILE, [], 'x.com').value, 'Ada Lovelace', 'fullName is derived');
    assert.strictEqual(C.matchField(d('Expected Graduation'), PROFILE, [], 'x.com').value, 'May 2026');
    assert.strictEqual(C.matchField(d('Location'), PROFILE, [], 'x.com').value, 'San Jose, CA');
    assert.strictEqual(C.matchField(d('Are you willing to relocate?'), PROFILE, [], 'x.com').value, 'Yes', 'yes/no capitalized for text');
    assert.strictEqual(C.matchField(d('Favorite color'), PROFILE, [], 'x.com'), null);
    assert.strictEqual(C.matchField(d('First Name'), Object.assign({}, PROFILE, { firstName: '' }), [], 'x.com'), null, 'empty profile value is no match');
    assert.strictEqual(C.matchField(d('Anything', { kind: 'email' }), PROFILE, [], 'x.com').profileKey, 'email', 'type=email fallback');
    console.log('[PASS] Synonym dictionary covers the profile with exact 0.9 / loose 0.6 and rejects near misses');
  }

  // Priority: adapter > host rule > global rule > autocomplete > dictionary; EEO gating
  {
    const { doc, h, restore } = installAutofillDom();
    const C = freshCore();
    const input = h('input', { id: 'x', autocomplete: 'family-name' });
    doc.body.appendChild(h('form', {}, h('label', { for: 'x' }, 'First Name'), input));
    const desc = C.scanFields(doc)[0];
    assert.strictEqual(C.matchField(desc, PROFILE, [], 'jobs.example.com').source, 'autocomplete', 'autocomplete beats the dictionary');
    assert.strictEqual(C.matchField(desc, PROFILE, [], 'jobs.example.com').value, 'Lovelace');
    const globalRule = { id: 'g', host: '*', labelKey: 'first name', profileKey: 'preferredName' };
    const hostRule = { id: 'h', host: 'jobs.example.com', labelKey: 'first name', value: 'Countess' };
    const otherHost = { id: 'o', host: 'other.com', labelKey: 'first name', value: 'Wrong' };
    let m = C.matchField(desc, PROFILE, [globalRule, otherHost], 'jobs.example.com');
    assert.deepStrictEqual(m, { profileKey: 'preferredName', value: 'Ada', confidence: 1, source: 'rule' }, 'global rule beats autocomplete');
    m = C.matchField(desc, PROFILE, [globalRule, hostRule, otherHost], 'www.jobs.example.com');
    assert.deepStrictEqual(m, { value: 'Countess', confidence: 1, source: 'rule' }, 'host rule beats global rule');
    const adapter = { id: 't', matches: () => true, fields: [{ selector: '#x', profileKey: 'email' }] };
    m = C.matchField(desc, PROFILE, [hostRule], 'jobs.example.com', { adapter });
    assert.strictEqual(m.source, 'adapter');
    assert.strictEqual(m.value, 'ada@example.com', 'adapter fixed field beats everything');
    C.registerSiteAdapter(adapter);
    assert.strictEqual(C.matchField(desc, PROFILE, [], 'jobs.example.com').source, 'adapter', 'registered adapters are found by host');
    C._resetSiteAdapters();

    const g = { kind: 'select', label: 'Gender', labelKey: 'gender', name: '', id: '', autocomplete: '', placeholder: '', options: [] };
    assert.strictEqual(C.matchField(g, PROFILE, [], 'x.com'), null, 'EEO is off by default');
    assert.strictEqual(C.matchField(g, PROFILE, [], 'x.com', { settings: { fillEeo: false } }), null);
    assert.strictEqual(C.matchField(g, PROFILE, [], 'x.com', { settings: { fillEeo: true } }).value, 'Female');
    const lit = [{ host: '*', labelKey: 'gender', value: 'Female' }];
    assert.strictEqual(C.matchField(g, PROFILE, lit, 'x.com'), null, 'a literal rule on an EEO question is gated too');
    const dis = Object.assign({}, g, { label: 'Disability', labelKey: 'disability' });
    assert.strictEqual(C.matchField(dis, PROFILE, [], 'x.com', { settings: { fillEeo: true } }), null, 'blank EEO answer stays blank');
    restore();
    console.log('[PASS] Match priority: adapter > host rule > global rule > autocomplete > dictionary; EEO gated');
  }

  // Fuzzy option matching for selects, radios, checkboxes
  {
    const { doc, h, restore } = installAutofillDom();
    const C = freshCore();
    assert.strictEqual(C.bestOption('yes', ['No, I will not', 'Yes, I am authorized']).index, 1);
    assert.strictEqual(C.bestOption('no', ['Yes, I will require sponsorship', 'No, I will not require sponsorship']).index, 1);
    assert.strictEqual(C.bestOption('CA', ['Arizona', 'California', 'Canada']).index, 1, 'state abbreviation');
    assert.strictEqual(C.bestOption('USA', ['Canada', 'United States of America']).index, 1, 'country alias');
    assert.strictEqual(C.bestOption('no', ['I am a protected veteran', 'I am not a protected veteran', 'I don\'t wish to answer']).index, 1, 'yes/no picks the negated sentence');
    assert.strictEqual(C.bestOption('Decline to self identify', ['Male', 'Female', 'I don\'t wish to answer']).index, 2);
    assert.strictEqual(C.bestOption('BS', ['Associate', 'Bachelor of Science', 'Master of Science']).index, 1);
    assert.strictEqual(C.bestOption('BS', ['High School', 'Bachelor\'s Degree', 'Master\'s Degree']).index, 1, 'degree family');
    assert.strictEqual(C.bestOption('May 2026', ['2025', '2026', '2027']).index, 1);
    assert.strictEqual(C.bestOption('Purple', ['Red', 'Green']), null);

    const sel = h('select', { id: 's' }, h('option', { value: '' }, 'Select...'), h('option', { value: 'AZ' }, 'Arizona'), h('option', { value: 'CA' }, 'California'));
    const yn = h('select', { id: 'yn' }, h('option', { value: '' }, ''), h('option', { value: '1' }, 'Yes, I am authorized'), h('option', { value: '0' }, 'No'));
    const events = [];
    sel.addEventListener('change', e => events.push(e.type + ':' + e.target.value));
    doc.body.appendChild(h('form', {}, h('label', { for: 's' }, 'State'), sel, h('label', { for: 'yn' }, 'Authorized?'), yn,
      h('fieldset', { id: 'fs' }, h('legend', {}, 'Sponsorship?'),
        h('label', {}, h('input', { type: 'radio', name: 'sp', value: 'a' }), 'Yes, I will'),
        h('label', {}, h('input', { type: 'radio', name: 'sp', value: 'b' }), 'No, I will not')),
      h('div', { role: 'group', 'aria-label': 'Race' },
        h('label', {}, h('input', { type: 'checkbox', name: 'race[]', value: 'w' }), 'White'),
        h('label', {}, h('input', { type: 'checkbox', name: 'race[]', value: 'a' }), 'Asian')),
      h('label', {}, h('input', { type: 'checkbox', id: 'reloc' }), 'I am willing to relocate')));
    const fields = C.scanFields(doc);
    const f = id => fields.find(x => x.id === id || (x.inputs || []).some(i => i.getAttribute('name') === id));
    assert.strictEqual(await C.setValue(f('s'), 'CA'), true);
    assert.strictEqual(sel.value, 'CA');
    assert.deepStrictEqual(events, ['change:CA'], 'change fires once after the value lands');
    assert.strictEqual(await C.setValue(f('yn'), 'yes'), true);
    assert.strictEqual(yn.value, '1');
    assert.strictEqual(await C.setValue(f('s'), 'Texas'), false, 'no option, no change');
    assert.strictEqual(sel.value, 'CA');

    const sp = f('sp');
    let clicks = 0;
    sp.inputs[1].addEventListener('click', () => { clicks++; });
    assert.strictEqual(await C.setValue(sp, 'no'), true);
    assert.deepStrictEqual(sp.inputs.map(i => i.checked), [false, true]);
    assert.strictEqual(clicks, 1, 'radios are clicked so React onChange fires');
    assert.strictEqual(await C.setValue(sp, 'Yes'), true);
    assert.deepStrictEqual(sp.inputs.map(i => i.checked), [true, false], 'radio exclusivity holds');

    const race = f('race[]');
    assert.strictEqual(race.kind, 'checkbox');
    assert.strictEqual(await C.setValue(race, 'Asian'), true);
    assert.deepStrictEqual(race.inputs.map(i => i.checked), [false, true]);

    const reloc = f('reloc');
    assert.strictEqual(await C.setValue(reloc, 'yes'), true);
    assert.strictEqual(reloc.el.checked, true);
    assert.strictEqual(await C.setValue(reloc, 'no'), true);
    assert.strictEqual(reloc.el.checked, false);
    restore();
    console.log('[PASS] Fuzzy option matching for selects, radio groups, checkbox groups, and single checkboxes');
  }

  // React-style native setter
  {
    const { doc, h, restore } = installAutofillDom();
    const C = freshCore();
    const input = h('input', { id: 'n', name: 'name' });
    doc.body.appendChild(h('form', {}, h('label', { for: 'n' }, 'Full name'), input));
    // React installs an instance-level `value` property that records the last
    // value it saw, and only fires onChange when the DOM value differs.
    const proto = Object.getPrototypeOf(input);
    const nativeDesc = Object.getOwnPropertyDescriptor(proto, 'value');
    let tracked = '';
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return nativeDesc.get.call(this); },
      set(v) { tracked = String(v); nativeDesc.set.call(this, v); }
    });
    const seen = [];
    const onChange = [];
    doc.body.addEventListener('input', e => {
      seen.push('input');
      if (e.target.value !== tracked) { onChange.push(e.target.value); tracked = e.target.value; }
    });
    doc.body.addEventListener('change', () => seen.push('change'));
    doc.body.addEventListener('blur', () => seen.push('blur'));

    // Sanity check of the harness: a plain assignment is swallowed.
    input.value = 'plain';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    assert.deepStrictEqual(onChange, [], 'plain assignment does not trigger React onChange');

    const desc = C.scanFields(doc, { includeFilled: true })[0];
    assert.strictEqual(await C.setValue(desc, 'Ada Lovelace'), true);
    assert.deepStrictEqual(onChange, ['Ada Lovelace'], 'native setter makes React see the change');
    assert.deepStrictEqual(seen.slice(-3), ['input', 'change', 'blur'], 'input, change, blur, all bubbling');
    restore();
    console.log('[PASS] Text fill goes through the prototype setter and fires bubbling input / change / blur');
  }

  // File input
  {
    const { doc, h, restore } = installAutofillDom();
    const C = freshCore();
    const file = h('input', { type: 'file', id: 'resume', name: 'resume', style: { display: 'none' } });
    let changed = 0;
    file.addEventListener('change', () => { changed++; });
    doc.body.appendChild(h('form', {}, h('div', { class: 'upload' }, h('label', { for: 'resume' }, 'Resume/CV'), file)));
    const desc = C.scanFields(doc)[0];
    assert.strictEqual(desc.kind, 'file', 'a display:none file input behind a visible wrapper is still a field');
    const m = C.matchField(desc, PROFILE, [], 'x.com', { resume: RESUME });
    assert.strictEqual(m.profileKey, 'resume');
    assert.strictEqual(C.matchField(desc, PROFILE, [], 'x.com'), null, 'no resume, no match');
    assert.strictEqual(await C.setValue(desc, RESUME), true);
    assert.strictEqual(file.files.length, 1);
    assert.strictEqual(file.files[0].name, 'ada.pdf');
    assert.strictEqual(file.files[0].type, 'application/pdf');
    assert.strictEqual(Buffer.from(file.files[0].bytes).toString(), '%PDF-1.4 ada', 'bytes decoded from the data URL');
    assert.strictEqual(changed, 1, 'change fires');
    assert.strictEqual(await C.setValue(desc, { name: 'x', dataUrl: 'not a data url' }), false);
    restore();
    console.log('[PASS] File inputs get a File through DataTransfer and a change event');
  }

  // run() end to end
  {
    const { doc, h, restore } = installAutofillDom({ href: 'https://boards.example.com/jobs/1' });
    const C = freshCore();
    let submitClicks = 0;
    const submit = h('button', { type: 'submit' }, 'Submit');
    submit.addEventListener('click', () => { submitClicks++; });
    const custom = h('div', { id: 'custom', role: 'combobox', 'aria-label': 'How did you hear about us?' }, 'Select...');
    doc.body.appendChild(h('form', {},
      h('label', { for: 'fn' }, 'First Name *'), h('input', { id: 'fn', required: '' }),
      h('label', { for: 'ln' }, 'Last Name'), h('input', { id: 'ln' }),
      h('label', { for: 'em' }, 'Email'), h('input', { id: 'em', type: 'email', value: 'keep@me.com' }),
      h('label', { for: 'ph' }, 'Phone'), h('input', { id: 'ph', type: 'tel' }),
      h('label', { for: 'li' }, 'LinkedIn Profile'), h('input', { id: 'li' }),
      h('label', { for: 'col' }, 'Favorite color'), h('input', { id: 'col' }),
      h('label', { for: 'gen' }, 'Gender'),
      h('select', { id: 'gen' }, h('option', { value: '' }, 'Select'), h('option', {}, 'Male'), h('option', {}, 'Female')),
      h('label', { for: 'why' }, 'Why do you want to work at Example Corp?'), h('textarea', { id: 'why' }),
      h('label', { for: 'cl' }, 'Cover letter'), h('textarea', { id: 'cl' }),
      h('label', { for: 'res' }, 'Resume'), h('input', { id: 'res', type: 'file' }),
      h('label', { for: 'wa' }, 'Are you legally authorized to work in the United States?'),
      h('select', { id: 'wa' }, h('option', { value: '' }, 'Please select'), h('option', {}, 'Yes'), h('option', {}, 'No')),
      h('label', { for: 'bad' }, 'Portfolio'), h('input', { id: 'bad' }),
      custom,
      submit));
    // A page handler that throws on one field must not stop the run.
    doc.querySelector('#bad').addEventListener('input', () => { throw new Error('page bug'); });

    const answers = [{ id: 'a1', question: 'Why do you want to work here?', labelKey: 'why do you want to work here', answer: 'Because engines.', updatedAt: 1 }];
    let report = await C.run({ profile: PROFILE, rules: [], answers, resume: RESUME, settings: { fillEeo: false } });
    const filledIds = report.filled.map(f => f.desc.id).sort();
    assert.deepStrictEqual(filledIds, ['bad', 'fn', 'li', 'ln', 'ph', 'res', 'wa', 'why'].sort());
    assert.strictEqual(doc.querySelector('#fn').value, 'Ada');
    assert.strictEqual(doc.querySelector('#li').value, PROFILE.linkedin);
    assert.strictEqual(doc.querySelector('#wa').value, 'Yes');
    assert.strictEqual(doc.querySelector('#why').value, 'Because engines.', 'answer bank fills a similar question');
    assert.strictEqual(report.filled.find(f => f.desc.id === 'why').match.source, 'answer');
    assert.strictEqual(doc.querySelector('#bad').value, PROFILE.portfolio, 'a throwing page handler does not undo the fill');
    assert.strictEqual(doc.querySelector('#em').value, 'keep@me.com', 'already-filled fields are left alone');
    const reasons = Object.fromEntries(report.skipped.map(s => [s.desc.id, s.reason]));
    assert.strictEqual(reasons.em, 'already-filled');
    assert.strictEqual(reasons.gen, 'eeo-disabled');
    assert.strictEqual(reasons.custom, 'unsupported-widget', 'comboboxes need an adapter');
    assert.strictEqual(doc.querySelector('#gen').selectedIndex, 0);
    assert.deepStrictEqual(report.unmatched.map(d => d.id).sort(), ['cl', 'col']);
    assert.strictEqual(report.filled.find(f => f.desc.id === 'fn').desc.required, true);
    assert.strictEqual(submitClicks, 0, 'never clicks submit');

    // Second pass with EEO on: only the gender select is new work.
    report = await C.run({ profile: PROFILE, rules: [], answers, resume: RESUME, settings: { fillEeo: true } });
    assert.deepStrictEqual(report.filled.map(f => f.desc.id), ['gen']);
    assert.strictEqual(doc.querySelector('#gen').value, 'Female');
    assert.ok(report.skipped.filter(s => s.reason === 'already-filled').length >= 9);

    // Adapters: fixed fields, scanRoot, custom fill, and undefined -> setValue fallback.
    const doc2 = installAutofillDom({ href: 'https://jobs.acme.test/apply' });
    const H = doc2.h;
    const C2 = freshCore();
    const widget = H('div', { id: 'src', role: 'combobox', 'aria-label': 'Source' }, 'Select...');
    doc2.doc.body.appendChild(H('div', {},
      H('div', { id: 'outside' }, H('label', { for: 'o1' }, 'First Name'), H('input', { id: 'o1' })),
      H('div', { id: 'app' },
        H('input', { id: 'weird', name: 'q_1', style: { display: 'none' } }),
        H('label', { for: 'ln2' }, 'Last Name'), H('input', { id: 'ln2' }),
        widget)));
    const filledBy = [];
    C2.registerSiteAdapter({
      id: 'acme',
      matches: url => /acme\.test$/.test(url.hostname),
      fields: [{ selector: '#weird', profileKey: 'email' }],
      scanRoot: d => d.querySelector('#app'),
      fill: async (desc, value) => {
        if (desc.kind !== 'combobox') return undefined;
        filledBy.push(value);
        desc.el.ownText = value;
        return true;
      }
    });
    report = await C2.run({ profile: PROFILE, rules: [{ host: 'jobs.acme.test', labelKey: 'source', profileKey: 'howDidYouHear' }], answers: [], settings: {} });
    assert.deepStrictEqual(report.filled.map(f => f.desc.id).sort(), ['ln2', 'src', 'weird']);
    assert.strictEqual(doc2.doc.querySelector('#weird').value, PROFILE.email, 'hidden fixed field is filled by the adapter mapping');
    assert.strictEqual(report.filled.find(f => f.desc.id === 'weird').match.source, 'adapter');
    assert.deepStrictEqual(filledBy, ['LinkedIn'], 'adapter fill handles its widget');
    assert.strictEqual(doc2.doc.querySelector('#o1').value, '', 'scanRoot narrows the scan');
    doc2.restore();
    restore();
    console.log('[PASS] run() fills, skips filled / EEO / widgets, reports unmatched, survives page errors, uses adapters');
  }

  // A throwing adapter never breaks the run
  {
    const { doc, h, restore } = installAutofillDom({ href: 'https://x.test/' });
    const C = freshCore();
    doc.body.appendChild(h('form', {}, h('label', { for: 'a' }, 'City'), h('input', { id: 'a' }), h('label', { for: 'b' }, 'Zip'), h('input', { id: 'b' })));
    C.registerSiteAdapter({ id: 'boom', matches: () => { throw new Error('bad matcher'); } });
    C.registerSiteAdapter({ id: 'flaky', matches: () => true, fill: async desc => { if (desc.id === 'a') throw new Error('flaky'); return undefined; } });
    const report = await C.run({ profile: PROFILE, rules: [], answers: [], settings: {} });
    assert.deepStrictEqual(report.filled.map(f => f.desc.id), ['b']);
    assert.deepStrictEqual(report.skipped.map(s => [s.desc.id, s.reason]), [['a', 'error']]);
    const again = await C.run({ profile: PROFILE, root: null });
    assert.deepStrictEqual(again.skipped.map(s => s.reason).sort(), ['already-filled', 'error'], 'defaults work with no rules / answers');
    restore();
    console.log('[PASS] Adapter errors are contained per field');
  }

  console.log('--- autofill-core: all tests passed ---');
}

module.exports = { run };
