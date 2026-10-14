// AutofillStore: profile defaults and round-trips, learned-rule upsert
// semantics, the answer bank and its findAnswer threshold, the 5 MB resume
// limit, settings, onChange, and JSON export/import.
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

function loadStore(initialStore = {}) {
  const mock = installMockChrome(initialStore);
  delete require.cache[require.resolve('../shared/autofill-store')];
  const store = require('../shared/autofill-store');
  return { mock, store };
}

function cleanup() {
  uninstallMockChrome();
}

const tick = () => new Promise(r => setImmediate(r));

function dataUrlOfBytes(bytes, type = 'application/pdf') {
  return 'data:' + type + ';base64,' + Buffer.alloc(bytes, 7).toString('base64');
}

async function expectReject(promise, pattern, message) {
  let threw = null;
  try {
    await promise;
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, message + ' (expected a rejection)');
  if (pattern) assert.ok(pattern.test(threw.message), message + ' (got: ' + threw.message + ')');
}

async function testProfileDefaults() {
  const { mock, store } = loadStore();
  const profile = await store.getProfile();
  store.PROFILE_FIELDS.forEach(k => assert.strictEqual(profile[k], '', 'default ' + k + ' is empty'));
  assert.deepStrictEqual(profile.eeo, { gender: '', race: '', hispanicLatino: '', veteran: '', disability: '' });
  assert.ok(!('fullName' in profile), 'fullName is never stored or returned');
  assert.strictEqual(Object.keys(mock.storage.local.store).length, 0, 'reading does not write');
  cleanup();
}

async function testProfileRoundTrip() {
  const { mock, store } = loadStore();
  await store.saveProfile({
    firstName: '  Ada ',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    fullName: 'Should Not Store',
    bogus: 'x',
    workAuthorized: 'Yes',
    needsSponsorship: 'no',
    willingToRelocate: 'maybe',
    gpa: 3.9,
    eeo: { gender: 'Female', unknown: 'x' }
  });
  const stored = mock.storage.local.store.af_profile;
  assert.ok(stored, 'profile stored under af_profile');
  assert.ok(!('fullName' in stored) && !('bogus' in stored), 'unknown keys and fullName dropped');

  const p = await store.getProfile();
  assert.strictEqual(p.firstName, 'Ada', 'values trimmed');
  assert.strictEqual(p.lastName, 'Lovelace');
  assert.strictEqual(p.workAuthorized, 'yes', 'yes/no normalized');
  assert.strictEqual(p.needsSponsorship, 'no');
  assert.strictEqual(p.willingToRelocate, '', 'invalid yes/no becomes empty');
  assert.strictEqual(p.gpa, '3.9', 'numbers become strings');
  assert.strictEqual(p.eeo.gender, 'Female');
  assert.ok(!('unknown' in p.eeo));

  // Partial save merges and keeps other fields, including nested eeo.
  await store.saveProfile({ city: 'London', eeo: { veteran: 'I am not a protected veteran' } });
  const p2 = await store.getProfile();
  assert.strictEqual(p2.firstName, 'Ada', 'partial save keeps earlier fields');
  assert.strictEqual(p2.city, 'London');
  assert.strictEqual(p2.eeo.gender, 'Female', 'partial eeo save keeps other eeo keys');
  assert.strictEqual(p2.eeo.veteran, 'I am not a protected veteran');

  // Clearing a field works.
  await store.saveProfile({ city: '' });
  assert.strictEqual((await store.getProfile()).city, '');

  // Corrupt stored data does not throw.
  mock.storage.local.store.af_profile = 'garbage';
  const p3 = await store.getProfile();
  assert.strictEqual(p3.firstName, '');
  cleanup();
}

async function testConcurrentProfileSaves() {
  const { store } = loadStore();
  await Promise.all([
    store.saveProfile({ firstName: 'A' }),
    store.saveProfile({ lastName: 'B' }),
    store.saveProfile({ city: 'C' }),
    store.saveProfile({ eeo: { race: 'Asian' } })
  ]);
  const p = await store.getProfile();
  assert.deepStrictEqual([p.firstName, p.lastName, p.city, p.eeo.race], ['A', 'B', 'C', 'Asian'], 'queued saves do not lose writes');
  cleanup();
}

async function testLearnRule() {
  const { mock, store } = loadStore();
  assert.deepStrictEqual(await store.getRules(), [], 'no rules by default');

  const r1 = await store.learnRule({ host: 'boards.greenhouse.io', labelKey: 'Legal First Name *', profileKey: 'firstName' });
  assert.ok(typeof r1.id === 'string' && r1.id.length >= 8, 'rule id is a random string');
  assert.strictEqual(r1.labelKey, 'legal first name', 'labelKey normalized');
  assert.strictEqual(r1.profileKey, 'firstName');
  assert.ok(!('value' in r1), 'profileKey rule has no value');
  assert.ok(Array.isArray(mock.storage.local.store.af_rules), 'rules stored under af_rules');

  // Same (host, labelKey): upsert, keep id, switch to value.
  const r2 = await store.learnRule({ host: 'BOARDS.greenhouse.io', labelKey: 'legal first name', value: 'Ada' });
  assert.strictEqual(r2.id, r1.id, 'upsert keeps the id');
  assert.strictEqual(r2.value, 'Ada');
  assert.ok(!('profileKey' in r2), 'switching to value drops profileKey');
  let rules = await store.getRules();
  assert.strictEqual(rules.length, 1, 'upsert does not duplicate');

  // Same label on another host, and globally: separate rules.
  const g = await store.learnRule({ host: '*', labelKey: 'legal first name', profileKey: 'firstName' });
  await store.learnRule({ host: 'jobs.lever.co', labelKey: 'legal first name', profileKey: 'preferredName' });
  rules = await store.getRules();
  assert.strictEqual(rules.length, 3);
  assert.notStrictEqual(g.id, r1.id, 'ids are unique');
  assert.strictEqual(new Set(rules.map(r => r.id)).size, 3);

  // Missing host means global.
  const noHost = await store.learnRule({ labelKey: 'legal first name', profileKey: 'lastName' });
  assert.strictEqual(noHost.host, '*');
  assert.strictEqual(noHost.id, g.id, 'missing host upserts the global rule');

  // Empty string literal is a valid value rule.
  const empty = await store.learnRule({ host: 'x.com', labelKey: 'Middle name', value: '' });
  assert.strictEqual(empty.value, '');

  // Validation: exactly one of profileKey / value, non-empty label.
  await expectReject(store.learnRule({ host: '*', labelKey: 'a', profileKey: 'email', value: 'x' }), /exactly one/, 'both rejected');
  await expectReject(store.learnRule({ host: '*', labelKey: 'a' }), /exactly one/, 'neither rejected');
  await expectReject(store.learnRule({ host: '*', labelKey: ' ** (optional) ', profileKey: 'email' }), /labelKey/, 'empty label rejected');

  // deleteRule.
  assert.strictEqual(await store.deleteRule(r1.id), true);
  assert.strictEqual(await store.deleteRule('nope'), false);
  rules = await store.getRules();
  assert.ok(!rules.some(r => r.id === r1.id));
  cleanup();
}

async function testNormalizeLabelThroughStore() {
  const { store } = loadStore();
  const cases = [
    ['First Name*', 'first name'],
    ['  E-mail   Address (Optional) ', 'e mail address'],
    ['Phone (required)', 'phone'],
    ['Required: LinkedIn Profile URL', 'linkedin profile url'],
    ['What\'s your\n\tgrad year?', 'what s your grad year'],
    ['Nombre / Prénom', 'nombre prénom']
  ];
  for (const [input, expected] of cases) {
    const saved = await store.saveAnswer({ question: input, answer: 'x' });
    assert.strictEqual(saved.labelKey, expected, 'normalizeLabel(' + JSON.stringify(input) + ')');
  }
  cleanup();
}

async function testAnswers() {
  const { mock, store } = loadStore();
  assert.deepStrictEqual(await store.getAnswers(), []);
  const a1 = await store.saveAnswer({ question: 'Why do you want to work here?', answer: 'Because.' });
  assert.ok(a1.id && a1.updatedAt, 'answer has id and updatedAt');
  assert.strictEqual(a1.labelKey, 'why do you want to work here');
  assert.strictEqual(a1.question, 'Why do you want to work here?');
  assert.ok(Array.isArray(mock.storage.local.store.af_answers), 'answers stored under af_answers');

  // Upsert by labelKey: punctuation/case differences hit the same entry.
  const a2 = await store.saveAnswer({ question: 'why do you want to work here', answer: 'Mission.' });
  assert.strictEqual(a2.id, a1.id, 'same labelKey upserts');
  let list = await store.getAnswers();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].answer, 'Mission.');

  // Editing by id may change the question.
  const b = await store.saveAnswer({ question: 'Describe a project', answer: 'LIT.' });
  const b2 = await store.saveAnswer({ id: b.id, question: 'Describe a recent project', answer: 'LIT v2.' });
  assert.strictEqual(b2.id, b.id, 'edit by id keeps the id');
  assert.strictEqual(b2.labelKey, 'describe a recent project');
  list = await store.getAnswers();
  assert.strictEqual(list.length, 2);

  // Editing by id onto another entry's labelKey merges them.
  await store.saveAnswer({ id: b.id, question: 'Why do you want to work here?', answer: 'Merged.' });
  list = await store.getAnswers();
  assert.strictEqual(list.length, 1, 'colliding edit folds the duplicate');
  assert.strictEqual(list[0].id, b.id);
  assert.strictEqual(list[0].answer, 'Merged.');

  await expectReject(store.saveAnswer({ question: '', answer: 'x' }), /question/, 'empty question rejected');
  await expectReject(store.saveAnswer({ question: 'Q', answer: '   ' }), /answer/, 'empty answer rejected');

  assert.strictEqual(await store.deleteAnswer(b.id), true);
  assert.strictEqual(await store.deleteAnswer(b.id), false);
  assert.deepStrictEqual(await store.getAnswers(), []);
  cleanup();
}

async function testFindAnswer() {
  const { store } = loadStore();
  assert.strictEqual(await store.findAnswer('Anything'), null, 'empty bank returns null');
  await store.saveAnswer({ question: 'Why do you want to work at this company?', answer: 'A1' });
  await store.saveAnswer({ question: 'Tell us about a challenging project', answer: 'A2' });

  const exact = await store.findAnswer('WHY do you want to work at this company');
  assert.strictEqual(exact.answer, 'A1');
  assert.strictEqual(exact.score, 1, 'exact labelKey scores 1');

  // 'why do you want to work at acme' vs 'why do you want to work at this company':
  // tokens {why,do,you,want,to,work,at,acme} vs {...,this,company}: 7 / 10 = 0.7.
  const close = await store.findAnswer('Why do you want to work at Acme?');
  assert.strictEqual(close.answer, 'A1');
  assert.ok(Math.abs(close.score - 0.7) < 1e-9, 'Jaccard score (got ' + close.score + ')');

  // {tell,us,about,a,recent,bug,fix} vs {tell,us,about,a,challenging,project}: 4 / 9.
  assert.strictEqual(await store.findAnswer('tell us about a recent bug fix'), null, 'below 0.5 returns null');
  // {tell,us,about,a,challenging,bug,fix} vs {tell,us,about,a,challenging,project}: 5 / 8.
  const above = await store.findAnswer('tell us about a challenging bug fix');
  assert.strictEqual(above.answer, 'A2');
  assert.strictEqual(above.score, 5 / 8);

  await store.saveAnswer({ question: 'one two', answer: 'A3' });
  const boundary = await store.findAnswer('one two three four');
  // {one,two} vs {one,two,three,four}: 2 / 4 = 0.5, which is not below 0.5.
  assert.strictEqual(boundary.answer, 'A3', 'score of exactly 0.5 is returned');
  assert.strictEqual(boundary.score, 0.5);
  assert.strictEqual(await store.findAnswer('one two three four five'), null, '2 / 5 is below threshold');

  assert.strictEqual(await store.findAnswer(''), null);
  assert.strictEqual(await store.findAnswer('***'), null);
  assert.strictEqual(await store.findAnswer(null), null);
  cleanup();
}

async function testResume() {
  const { mock, store } = loadStore();
  assert.strictEqual(await store.getResume(), null, 'no resume by default');

  const dataUrl = dataUrlOfBytes(1000);
  const saved = await store.saveResume({ name: 'resume.pdf', type: 'application/pdf', dataUrl });
  assert.strictEqual(saved.size, 1000, 'decoded size reported');
  const r = await store.getResume();
  assert.strictEqual(r.name, 'resume.pdf');
  assert.strictEqual(r.type, 'application/pdf');
  assert.strictEqual(r.dataUrl, dataUrl);
  assert.ok(mock.storage.local.store.af_resume, 'resume stored under af_resume');

  // Type falls back to the data URL's media type.
  await store.saveResume({ name: 'cv.txt', dataUrl: 'data:text/plain;base64,aGk=' });
  assert.strictEqual((await store.getResume()).type, 'text/plain');

  // Exactly 5 MB is accepted; one byte more is rejected with a clear error,
  // and the previous resume stays.
  await store.saveResume({ name: 'max.pdf', type: 'application/pdf', dataUrl: dataUrlOfBytes(5 * 1024 * 1024) });
  assert.strictEqual((await store.getResume()).name, 'max.pdf');
  await expectReject(
    store.saveResume({ name: 'big.pdf', type: 'application/pdf', dataUrl: dataUrlOfBytes(5 * 1024 * 1024 + 1) }),
    /too large.*5 MB/,
    'over 5 MB rejected'
  );
  assert.strictEqual((await store.getResume()).name, 'max.pdf', 'rejected upload leaves the old resume');

  await expectReject(store.saveResume({ name: 'x', dataUrl: 'not a data url' }), /data: URL/, 'non data URL rejected');
  await expectReject(store.saveResume(null), /missing/, 'missing resume rejected');

  await store.clearResume();
  assert.strictEqual(await store.getResume(), null);
  assert.ok(!('af_resume' in mock.storage.local.store));
  cleanup();
}

async function testSettings() {
  const { mock, store } = loadStore();
  assert.deepStrictEqual(await store.getSettings(), { showButton: true, fillEeo: false, autoLearn: true });
  const next = await store.saveSettings({ fillEeo: true, junk: 1, showButton: 'no' });
  assert.deepStrictEqual(next, { showButton: true, fillEeo: true, autoLearn: true }, 'non-boolean and unknown keys ignored');
  await store.saveSettings({ autoLearn: false });
  assert.deepStrictEqual(await store.getSettings(), { showButton: true, fillEeo: true, autoLearn: false }, 'partial saves merge');
  assert.ok(mock.storage.local.store.af_settings, 'settings stored under af_settings');
  cleanup();
}

async function testKeysArePrefixed() {
  const { mock, store } = loadStore();
  await store.saveProfile({ firstName: 'A' });
  await store.learnRule({ host: '*', labelKey: 'x', profileKey: 'email' });
  await store.saveAnswer({ question: 'q', answer: 'a' });
  await store.saveResume({ name: 'r', dataUrl: 'data:text/plain;base64,aGk=' });
  await store.saveSettings({ fillEeo: true });
  const keys = Object.keys(mock.storage.local.store);
  assert.strictEqual(keys.length, 5, 'five separate keys');
  keys.forEach(k => assert.ok(k.startsWith('af_'), k + ' is prefixed'));
  assert.strictEqual(Object.keys(mock.storage.sync.store).length, 0, 'nothing in storage.sync');
  cleanup();
}

async function testOnChange() {
  const { mock, store } = loadStore();
  const seen = [];
  const off = store.onChange((changes, keys) => seen.push(keys.slice().sort().join(',')));
  await store.saveProfile({ firstName: 'A' });
  await tick();
  await new Promise(r => mock.storage.local.set({ pt_theme: 'dark', other: 1 }, r));
  await tick();
  await store.saveSettings({ fillEeo: true });
  await tick();
  assert.deepStrictEqual(seen, ['af_profile', 'af_settings'], 'only af_ keys fire the callback');
  off();
  await store.saveProfile({ firstName: 'B' });
  await tick();
  assert.strictEqual(seen.length, 2, 'unsubscribe stops callbacks');
  assert.doesNotThrow(() => store.onChange(null)(), 'non-function callback is harmless');
  cleanup();
}

async function testExportImport() {
  const { store } = loadStore();
  await store.saveProfile({ firstName: 'Ada', eeo: { gender: 'Female' } });
  await store.learnRule({ host: 'jobs.lever.co', labelKey: 'Pronouns', value: 'she/her' });
  await store.learnRule({ host: '*', labelKey: 'Given name', profileKey: 'firstName' });
  await store.saveAnswer({ question: 'Why us?', answer: 'Mission.' });
  await store.saveResume({ name: 'cv.pdf', type: 'application/pdf', dataUrl: dataUrlOfBytes(300) });
  await store.saveSettings({ fillEeo: true });

  const exported = await store.exportAll();
  assert.strictEqual(exported.format, 'lit-autofill');
  assert.strictEqual(exported.version, 1);
  assert.strictEqual(exported.profile.firstName, 'Ada');
  assert.strictEqual(exported.rules.length, 2);
  assert.strictEqual(exported.answers.length, 1);
  assert.strictEqual(exported.resume.name, 'cv.pdf');
  assert.strictEqual(exported.settings.fillEeo, true);
  const json = JSON.stringify(exported);
  const noResume = await store.exportAll({ includeResume: false });
  assert.strictEqual(noResume.resume, null);
  cleanup();

  // Import into a fresh store reproduces everything.
  const fresh = loadStore().store;
  const counts = await fresh.importAll(json);
  assert.deepStrictEqual(counts, { rules: 2, answers: 1, resume: true });
  const again = await fresh.exportAll();
  ['profile', 'rules', 'answers', 'settings', 'resume'].forEach(k => {
    const a = JSON.parse(JSON.stringify(exported[k]));
    const b = JSON.parse(JSON.stringify(again[k]));
    assert.deepStrictEqual(b, a, k + ' survives export then import');
  });

  // Rejections leave storage untouched.
  await expectReject(fresh.importAll('{not json'), /not valid JSON/, 'bad JSON rejected');
  await expectReject(fresh.importAll({ profile: {} }), /not a LIT autofill export/, 'wrong format rejected');
  await expectReject(fresh.importAll({ format: 'lit-autofill', version: 99 }), /newer version/, 'future version rejected');
  const big = JSON.parse(json);
  big.profile.firstName = 'Changed';
  big.resume = { name: 'big.pdf', dataUrl: dataUrlOfBytes(5 * 1024 * 1024 + 10) };
  await expectReject(fresh.importAll(big), /too large/, 'oversized resume in import rejected');
  assert.strictEqual((await fresh.getProfile()).firstName, 'Ada', 'failed import changes nothing');

  // Bad entries are dropped, duplicates collapsed; missing sections are kept;
  // resume: null clears.
  const partial = {
    format: 'lit-autofill',
    version: 1,
    rules: [
      { host: '*', labelKey: 'Email', profileKey: 'email' },
      { host: '*', labelKey: 'email', profileKey: 'email' },
      { host: '*', labelKey: '', profileKey: 'email' },
      { host: '*', labelKey: 'Nothing' },
      'junk'
    ],
    answers: [{ question: 'Q', answer: 'A' }, { question: 'q', answer: 'dup' }, { question: 'Empty', answer: '' }],
    resume: null
  };
  const c2 = await fresh.importAll(partial);
  assert.deepStrictEqual(c2, { rules: 1, answers: 1, resume: false });
  assert.strictEqual((await fresh.getProfile()).firstName, 'Ada', 'missing profile section left alone');
  assert.strictEqual((await fresh.getSettings()).fillEeo, true, 'missing settings section left alone');
  assert.strictEqual(await fresh.getResume(), null, 'resume: null clears the resume');
  assert.strictEqual((await fresh.getRules())[0].labelKey, 'email');

  await fresh.clearAll();
  assert.deepStrictEqual(await fresh.getRules(), []);
  assert.strictEqual((await fresh.getProfile()).firstName, '');
  cleanup();
}

async function testStorageErrorsReject() {
  const { mock, store } = loadStore();
  const realSet = mock.storage.local.set.bind(mock.storage.local);
  mock.storage.local.set = (items, cb) => {
    mock.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
    process.nextTick(() => { cb(); mock.runtime.lastError = null; });
  };
  await expectReject(store.saveProfile({ firstName: 'A' }), /QUOTA/, 'storage errors surface as rejections');
  mock.storage.local.set = realSet;
  // The queue keeps working after a failure.
  await store.saveProfile({ firstName: 'B' });
  assert.strictEqual((await store.getProfile()).firstName, 'B');
  cleanup();
}

async function run() {
  console.log('--- Running test/autofill-store.test.js ---');
  const tests = [
    testProfileDefaults,
    testProfileRoundTrip,
    testConcurrentProfileSaves,
    testLearnRule,
    testNormalizeLabelThroughStore,
    testAnswers,
    testFindAnswer,
    testResume,
    testSettings,
    testKeysArePrefixed,
    testOnChange,
    testExportImport,
    testStorageErrorsReject
  ];
  for (const t of tests) {
    try {
      await t();
      console.log('[PASS] ' + t.name);
    } catch (e) {
      cleanup();
      console.error('[FAIL] ' + t.name);
      throw e;
    }
  }
  console.log('--- test/autofill-store.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
