// Answer composer (shared/answer-composer.js): pieces saved answers together
// into an answer for a new question. Uses a hand-written answer bank (no real
// personal data) and checks re-targeting, picking, combining, de-duplication,
// trimming, and that a weak match returns nothing rather than a guess.
const assert = require('assert');
const path = require('path');

const C = require(path.join(__dirname, '..', 'shared', 'answer-composer.js'));

const BANK = [
  {
    id: 'why_stripe', question: 'Why do you want to work at Stripe?', labelKey: 'why do you want to work at stripe',
    company: 'Stripe', role: 'Software Engineering Intern', updatedAt: '2026-10-01T00:00:00.000Z',
    answer: 'I want to work at Stripe because I care about making it easier for small businesses to get paid online. ' +
      "I have used Stripe's documentation as a model for my own API docs. " +
      'I want to learn how a team ships infrastructure that developers trust, and the Software Engineering Intern role would let me contribute to that work while growing as an engineer.'
  },
  {
    id: 'project', question: 'Tell us about a project you are proud of.', labelKey: 'tell us about a project you are proud of',
    updatedAt: '2026-10-02T00:00:00.000Z',
    answer: 'I built LIT, a Chrome extension that tracks job applications and autofills application forms. ' +
      'I designed its storage layer and wrote a test suite of more than 400 checks, which caught regressions before every release. ' +
      'Over 200 classmates now use it to manage their internship search.'
  },
  {
    id: 'challenge', question: 'Describe a time you faced a challenge on a team.', labelKey: 'describe a time you faced a challenge on a team',
    updatedAt: '2026-10-03T00:00:00.000Z',
    answer: 'During a hackathon our backend developer left halfway through. I took over the API, reorganized our task list, and we still shipped a working demo in time. I learned to communicate early when plans change.'
  },
  {
    id: 'strengths', question: 'What are your greatest strengths?', labelKey: 'what are your greatest strengths',
    updatedAt: '2026-10-04T00:00:00.000Z',
    answer: 'I learn new tools quickly and I write clear documentation. I enjoy turning vague requirements into small, testable steps.'
  },
  {
    id: 'fit', question: 'What makes you a good fit for this team?', labelKey: 'what makes you a good fit for this team',
    updatedAt: '2026-10-05T00:00:00.000Z',
    answer: 'I learn new tools quickly and I write clear documentation. I also care about the people who use what I build, so I test my work with real users early.'
  },
  {
    id: 'start', question: 'When can you start?', labelKey: 'when can you start', updatedAt: '2026-10-06T00:00:00.000Z',
    answer: 'I can start in June 2027 after I graduate, and I am available full time through the summer.'
  },
  {
    id: 'why_role', question: 'Why are you interested in this role?', labelKey: 'why are you interested in this role',
    company: 'Notion', role: 'Product Engineer Intern', updatedAt: '2026-10-07T00:00:00.000Z',
    answer: 'The Product Engineer Intern role at Notion combines the two things I enjoy most: building interfaces and talking to the people who use them. I want to keep working close to users.'
  }
];

const JOB = { title: 'Backend Engineer Intern', company: 'Acme' };
const PROFILE = { school: 'State University', major: 'Computer Science', degree: 'Bachelor of Science', gradMonth: 'June', gradYear: '2027' };

function compose(question, extra) {
  return C.compose(Object.assign({ question, kind: 'text', job: JOB, profile: PROFILE, answers: BANK }, extra || {}));
}

function sentencesOf(text) {
  return C.splitSentences(text).map(s => s.toLowerCase());
}

function assertNoRepeats(text, label) {
  const list = sentencesOf(text);
  assert.strictEqual(new Set(list).size, list.length, label + ': no sentence appears twice\n' + text);
}

function testWhyCompanyRetargeted() {
  for (const q of ['Why do you want to join Acme?', 'Why Acme?', 'What interests you about working at our company?']) {
    const r = compose(q);
    assert.ok(r, q + ': answered');
    assert.deepStrictEqual(r.sources, ['why_stripe'], q + ': built from the why-company answer');
    assert.ok(r.score >= C.MIN_SCORE && r.score <= 1);
    assert.ok(/I want to work at Acme because/.test(r.text), q + ': company swapped in\n' + r.text);
    assert.ok(!/Stripe/.test(r.text), q + ': old company gone');
    assert.ok(/the Backend Engineer Intern role/.test(r.text), q + ': role swapped in');
    assert.ok(!/Software Engineering Intern/.test(r.text), q + ': old role gone');
    // A first-hand claim about the old company would be made up for the new one.
    assert.ok(!/documentation as a model/.test(r.text), q + ': experience with the old company is dropped');
  }
  // The same company again keeps everything.
  const same = compose('Why do you want to work at Stripe?', { job: { title: 'Software Engineering Intern', company: 'Stripe' } });
  assert.ok(/documentation as a model/.test(same.text), 'reapplying to the same company keeps every sentence');
  // Unknown company: neutral words instead of a wrong name.
  const unknown = compose('Why do you want to work here?', { job: {} });
  assert.ok(/I want to work at your company because/.test(unknown.text), unknown.text);
  assert.ok(/this role would let me/i.test(unknown.text), 'unknown role reads naturally: ' + unknown.text);
}

function testProjectQuestion() {
  const r = compose('Describe a technical project you have built that you are proud of.');
  assert.ok(r);
  assert.strictEqual(r.sources[0], 'project');
  assert.ok(r.text.startsWith('I built LIT, a Chrome extension'), r.text);
  assert.ok(/400 checks/.test(r.text));
  assert.ok(!/Acme|hackathon/.test(r.text), 'only the project answer: ' + r.text);

  const failure = compose('Tell me about a time you failed or struggled.');
  assert.deepStrictEqual(failure.sources, ['challenge']);
  assert.ok(failure.text.startsWith('During a hackathon'));
}

function testMixedQuestion() {
  const q = 'Tell us about a project you are proud of and why you want to work at Acme.';
  const r = compose(q);
  assert.ok(r);
  assert.deepStrictEqual(r.sources.slice().sort(), ['project', 'why_stripe'], 'both answers used: ' + r.sources);
  assert.ok(/I built LIT/.test(r.text) && /I want to work at Acme/.test(r.text), r.text);
  assert.ok(!/Stripe/.test(r.text));
  assert.strictEqual(r.text.split('\n\n').length, 2, 'two paragraphs, one per part of the question');
  assertNoRepeats(r.text, 'mixed');

  // Two strengths answers share a sentence: combined, said once.
  const s = compose('What strengths make you a good fit?');
  assert.deepStrictEqual(s.sources.slice().sort(), ['fit', 'strengths']);
  assert.strictEqual(s.text.split('I learn new tools quickly').length - 1, 1, 'the shared sentence appears once:\n' + s.text);
  assert.ok(/real users early/.test(s.text) && /small, testable steps/.test(s.text), 'both answers contribute');
  assertNoRepeats(s.text, 'strengths');

  // Single-voice intents never stack: one why-role answer, not two.
  const extra = BANK.concat([{
    id: 'why_role_2', question: 'Why are you interested in this position?', company: 'Figma', role: 'Design Engineer Intern',
    updatedAt: '2026-09-01T00:00:00.000Z', answer: 'The Design Engineer Intern position at Figma lets me work where design meets code.'
  }]);
  const role = compose('Why are you interested in this internship?', { answers: extra });
  assert.strictEqual(role.sources.length, 1, 'one why-role answer: ' + role.sources);
}

function testWeakMatch() {
  assert.strictEqual(compose('What is your favorite programming language for embedded firmware?'), null, 'weak match returns null');
  assert.strictEqual(compose('Do you have a current security clearance?'), null);
  assert.strictEqual(compose(''), null, 'no question');
  assert.strictEqual(compose('Why do you want to work here?', { answers: [] }), null, 'empty bank');
  assert.strictEqual(compose('Why do you want to work here?', { kind: 'choice' }), null, 'text only');
  assert.strictEqual(C.compose(null), null);
}

function testAnythingElseFallback() {
  const now = new Date('2026-11-19T12:00:00Z');
  const r = compose('Is there anything else you would like us to know?', { answers: [], now });
  assert.ok(r, 'profile fallback');
  assert.deepStrictEqual(r.sources, []);
  assert.strictEqual(r.score, 0.25);
  assert.strictEqual(r.text, 'I am studying Computer Science at State University and expect to graduate in June 2027. ' +
    'Thank you for considering my application for the Backend Engineer Intern role at Acme.');
  const grad = compose('Additional information', { answers: [], now: new Date('2028-01-10T12:00:00Z') });
  assert.ok(/^I graduated from State University with a Bachelor of Science in Computer Science in June 2027\./.test(grad.text), grad.text);
  const worker = compose('Anything else?', { answers: [], profile: { currentTitle: 'Engineer', currentCompany: 'Initech' } });
  assert.ok(worker.text.startsWith('I currently work as an Engineer at Initech.'), worker.text);
  // No facts, no fallback: nothing is invented.
  assert.strictEqual(compose('Is there anything else you would like us to know?', { answers: [], profile: {} }), null);
  // Only "anything else" questions get it.
  assert.strictEqual(compose('Describe your thesis research.', { answers: [] }), null);
  // A saved "anything else" answer wins over the fallback.
  const saved = compose('Anything else we should know?', {
    answers: [{ id: 'else', question: 'Is there anything else you want us to know?', answer: 'I am glad to share code samples.' }]
  });
  assert.deepStrictEqual(saved.sources, ['else']);
}

function testPlaceholders() {
  const answers = [{
    id: 'cover', question: 'Cover letter', updatedAt: '2026-10-01T00:00:00.000Z',
    answer: 'Dear {company} team,\nI am applying for the {role} position because I like building reliable tools. [Company] is where I want to grow.'
  }];
  const r = compose('Cover letter (optional)', { answers });
  assert.ok(/^Dear Acme team, I am applying/.test(r.text), r.text);
  assert.ok(/the Backend Engineer Intern position/.test(r.text));
  assert.ok(/Acme is where I want to grow\./.test(r.text));
  assert.ok(!/[{}[\]]/.test(r.text), 'no placeholder left');
  const unknown = compose('Cover letter', { answers, job: {} });
  assert.ok(/^Dear your company team, /.test(unknown.text), unknown.text);
}

function testMaxLength() {
  const q = 'Tell us about a project you are proud of and why you want to work at Acme.';
  for (const max of [120, 200, 350, 600]) {
    const r = compose(q, { maxLength: max });
    assert.ok(r, 'answered at ' + max);
    assert.ok(r.text.length <= max, max + ': ' + r.text.length);
    assert.ok(/[.!?]$/.test(r.text), max + ': ends at a sentence boundary: ' + r.text);
    const full = compose(q, { maxLength: 5000 }).text.replace(/\n\n/g, ' ');
    assert.ok(full.startsWith(r.text.replace(/\n\n/g, ' ')), max + ': whole sentences from the start');
  }
  // A first sentence longer than the limit is cut at a word and closed.
  const tiny = compose('Describe a project you are proud of.', { maxLength: 40 });
  assert.ok(tiny.text.length <= 40 && /\.$/.test(tiny.text) && !/\s\S{0,2}\.$/.test(tiny.text.slice(-3)) , tiny.text);
  // Default limit is 1500.
  const long = BANK.map(a => Object.assign({}, a, { answer: a.answer + ' ' + a.answer.replace(/\./g, ' again.') }));
  const def = compose('Cover letter', { answers: long });
  assert.ok(def.text.length <= 1500);
  // trimToLength keeps paragraphs and never exceeds the limit.
  assert.strictEqual(C.trimToLength('One. Two.\n\nThree.', 100), 'One. Two.\n\nThree.');
  assert.strictEqual(C.trimToLength('One sentence here. Two sentence here.', 25), 'One sentence here.');
  assert.strictEqual(C.dropPartialSentence('Done here. And then the model stopp'), 'Done here.');
}

function testHelpers() {
  assert.strictEqual(C.stem('challenges'), C.stem('challenging'));
  assert.strictEqual(C.stem('challenged'), C.stem('challenge'));
  assert.strictEqual(C.stem('companies'), 'company');
  assert.ok(C.intentsOf('Why do you want to work here?').has('whyCompany'));
  assert.ok(C.intentsOf('Why Acme?', { company: 'Acme' }).has('whyCompany'));
  assert.ok(C.intentsOf('What is your expected salary?').has('salary'));
  assert.ok(C.intentsOf('When are you available to start?').has('availability'));
  assert.ok(C.intentsOf('Please attach or paste a cover letter').has('coverLetter'));
  assert.deepStrictEqual(C.splitSentences('- First point\n- Second point. Third one!'), ['First point.', 'Second point.', 'Third one!']);
  // Ranking: the best answer is first and every score is within 0..1.
  const ranked = C.rank('When can you start?', BANK, JOB);
  assert.strictEqual(ranked[0].answer.id, 'start');
  ranked.forEach(r => assert.ok(r.score >= 0 && r.score <= 1));
}

async function run() {
  console.log('--- Running test/answer-composer.test.js ---');
  const tests = [
    testWhyCompanyRetargeted,
    testProjectQuestion,
    testMixedQuestion,
    testWeakMatch,
    testAnythingElseFallback,
    testPlaceholders,
    testMaxLength,
    testHelpers
  ];
  for (const t of tests) {
    try {
      await t();
      console.log('[PASS] ' + t.name);
    } catch (e) {
      console.error('[FAIL] ' + t.name);
      throw e;
    }
  }
  console.log('--- test/answer-composer.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
