// Claude answer writer (background/ai-answer.js): LIT_COMPOSE_ANSWER in the
// service worker. fetch is mocked; no test makes a network call. Checks the
// exact request (endpoint, headers, body), that the API key never reaches the
// content script, choice matching, refusal / error / timeout fallbacks to the
// local composer, and maxLength trimming.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

const ROOT = path.join(__dirname, '..');
const KEY = 'sk-ant-api03-SECRET-test-key-0000';

const PROFILE = {
  firstName: 'Sam', lastName: 'Rivera', email: 'sam@example.com', phone: '555 123 4567', addressLine1: '1 Main St',
  city: 'Seattle', state: 'WA', country: 'United States', school: 'State University', major: 'Computer Science',
  gradMonth: 'June', gradYear: '2027', workAuthorized: 'yes', needsSponsorship: 'no',
  eeo: { gender: 'Prefer not to say', race: '', hispanicLatino: '', veteran: '', disability: '' }
};
const ANSWERS = [
  {
    id: 'afa_why', question: 'Why do you want to work at Stripe?', labelKey: 'why do you want to work at stripe',
    company: 'Stripe', role: 'Software Engineering Intern', updatedAt: '2026-10-01T00:00:00.000Z',
    answer: 'I want to work at Stripe because I care about making it easier for small businesses to get paid online. I want to learn how a team ships infrastructure that developers trust.'
  },
  {
    id: 'afa_proj', question: 'Tell us about a project you are proud of.', labelKey: 'tell us about a project you are proud of',
    updatedAt: '2026-10-02T00:00:00.000Z',
    answer: 'I built LIT, a Chrome extension that tracks job applications. I wrote a test suite of more than 400 checks.'
  }
];
const JOB = { title: 'Backend Engineer Intern', company: 'Acme', description: 'Acme builds payment APIs. '.repeat(400) };

function load(settings, { withStore = true } = {}) {
  const mock = installMockChrome();
  Object.assign(mock.storage.local.store, JSON.parse(JSON.stringify({
    af_profile: PROFILE,
    af_answers: ANSWERS,
    af_settings: Object.assign({ showButton: true, fillEeo: false, autoLearn: true }, settings)
  })));
  ['../shared/autofill-store.js', '../shared/answer-composer.js', '../background/ai-answer.js'].forEach(f => {
    delete require.cache[require.resolve(path.join(__dirname, f))];
  });
  if (withStore) global.AutofillStore = require(path.join(ROOT, 'shared/autofill-store.js'));
  global.AnswerComposer = require(path.join(ROOT, 'shared/answer-composer.js'));
  const LitAnswers = require(path.join(ROOT, 'background/ai-answer.js'));
  return { mock, LitAnswers };
}

function unload() {
  delete global.AutofillStore;
  delete global.AnswerComposer;
  delete global.fetch;
  uninstallMockChrome();
}

// fetch stand-in: records calls and answers with `reply(call)`.
function mockFetch(reply) {
  const calls = [];
  global.fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return reply(call);
  };
  return calls;
}

function claudeReply(text, stopReason = 'end_turn', extraBlocks = []) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
      stop_reason: stopReason,
      content: extraBlocks.concat(text === null ? [] : [{ type: 'text', text }])
    })
  };
}

// Sends the message through handleMessage the way the worker's listener does.
function send(LitAnswers, msg) {
  return new Promise((resolve, reject) => {
    const full = Object.assign({ type: 'LIT_COMPOSE_ANSWER' }, msg);
    const handled = LitAnswers.handleMessage(full, { tab: { id: 7 }, frameId: 0 }, resolve);
    if (!handled) reject(new Error('message not handled'));
  });
}

function assertNoKey(res, label) {
  assert.ok(!JSON.stringify(res).includes(KEY), label + ': the key never reaches the content script');
  assert.ok(!JSON.stringify(res).includes('SECRET'), label + ': not even part of it');
}

const TEXT_MSG = { question: 'Why do you want to join Acme?', kind: 'text', required: true, job: JOB };

async function testRequestShape() {
  const { LitAnswers } = load({ aiEnabled: true, aiKey: KEY });
  const calls = mockFetch(() => claudeReply('I want to join Acme because I care about helping small businesses get paid online.'));
  const res = await send(LitAnswers, TEXT_MSG);
  assert.deepStrictEqual(res, {
    ok: true, text: 'I want to join Acme because I care about helping small businesses get paid online.', source: 'ai'
  });
  assertNoKey(res, 'text');

  assert.strictEqual(calls.length, 1);
  const { url, init, body } = calls[0];
  assert.strictEqual(url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(init.method, 'POST');
  assert.deepStrictEqual(init.headers, {
    'content-type': 'application/json',
    'x-api-key': KEY,
    'anthropic-version': '2026-10-21',
    'anthropic-beta': 'server-side-fallback-2026-07-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  });
  assert.ok(init.signal && typeof init.signal.aborted === 'boolean', 'request carries an abort signal');
  assert.deepStrictEqual(Object.keys(body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.strictEqual(body.model, 'claude-opus-5-5');
  assert.strictEqual(body.max_tokens, 2000);
  assert.strictEqual(body.fallbacks, 'default');
  assert.deepStrictEqual(body.output_config, { effort: 'low' });
  ['thinking', 'temperature', 'top_p', 'top_k'].forEach(k => assert.ok(!(k in body), 'no ' + k));
  assert.strictEqual(body.messages.length, 1, 'one user turn, no assistant prefill');
  assert.strictEqual(body.messages[0].role, 'user');
  assert.strictEqual(typeof body.system, 'string');
  assert.ok(/first person/i.test(body.system) && /only facts/i.test(body.system) && /NONE/.test(body.system), 'system prompt rules');
  assert.ok(!/Stripe|State University|Acme/.test(body.system), 'data stays out of the system prompt');

  const content = body.messages[0].content;
  assert.ok(/<job>[\s\S]*Title: Backend Engineer Intern[\s\S]*Company: Acme[\s\S]*<\/job>/.test(content), 'job block');
  assert.ok(/<profile>[\s\S]*school: State University[\s\S]*<\/profile>/.test(content), 'profile block');
  assert.ok(/<saved_answers>[\s\S]*Written for: Software Engineering Intern at Stripe[\s\S]*<\/saved_answers>/.test(content), 'answers with context');
  assert.ok(/<question kind="text" required="yes" max_characters="1500">\nWhy do you want to join Acme\?\n<\/question>/.test(content), 'question block');
  assert.ok(content.indexOf('afa_why') < 0, 'ids are not sent');
  // The answer that fits best is listed first.
  assert.ok(content.indexOf('Why do you want to work at Stripe?') < content.indexOf('Tell us about a project'), 'most relevant answer first');
  ['sam@example.com', '555 123 4567', '1 Main St', 'Prefer not to say'].forEach(v => assert.ok(!content.includes(v), 'not sent: ' + v));
  const desc = content.slice(content.indexOf('Description:'), content.indexOf('</job>'));
  assert.ok(desc.length <= 6000 + 'Description:\n'.length + 2, 'description capped at 6000 chars (' + desc.length + ')');
  assert.ok(!content.includes(KEY), 'the key is only in the header');

  // A chosen model is used.
  unload();
  const second = load({ aiEnabled: true, aiKey: KEY, aiModel: 'claude-sonnet-5-5' });
  const calls2 = mockFetch(() => claudeReply('Fine answer here.'));
  await send(second.LitAnswers, TEXT_MSG);
  assert.strictEqual(calls2[0].body.model, 'claude-sonnet-5-5');
  unload();
}

async function testChoice() {
  const { LitAnswers } = load({ aiEnabled: true, aiKey: KEY });
  const options = ['Yes', 'No', 'I prefer not to answer'];
  const msg = { question: 'Are you legally authorized to work in the United States?', kind: 'choice', options, required: true, job: JOB };

  let replyText = 'yes';
  const calls = mockFetch(() => claudeReply(replyText));
  let res = await send(LitAnswers, msg);
  assert.deepStrictEqual(res, { ok: true, choice: 'Yes', source: 'ai' }, 'case-insensitive match returns the original option');
  assertNoKey(res, 'choice');
  assert.ok(/<options>\nYes\nNo\nI prefer not to answer\n<\/options>/.test(calls[0].body.messages[0].content), 'options listed');
  assert.ok(!/max_characters/.test(calls[0].body.messages[0].content.split('<question')[1]), 'no length limit for a choice');

  replyText = '  "I PREFER NOT TO ANSWER" ';
  res = await send(LitAnswers, msg);
  assert.deepStrictEqual(res, { ok: true, choice: 'I prefer not to answer', source: 'ai' });

  replyText = 'NONE';
  res = await send(LitAnswers, msg);
  assert.deepStrictEqual(res, { ok: false, reason: 'undetermined' }, 'NONE is not an answer');

  replyText = 'Yes, I am authorized to work in the US.';
  res = await send(LitAnswers, msg);
  assert.deepStrictEqual(res, { ok: false, reason: 'no-match' }, 'anything but an option verbatim is rejected');

  replyText = 'Maybe';
  res = await send(LitAnswers, msg);
  assert.strictEqual(res.ok, false);

  // Refusal or failure: no local guess for choices.
  global.fetch = async () => claudeReply(null, 'refusal');
  res = await send(LitAnswers, msg);
  assert.deepStrictEqual(res, { ok: false, reason: 'no-ai' });
  unload();

  // AI off: choices are never guessed.
  const off = load({ aiEnabled: false, aiKey: KEY });
  const offCalls = mockFetch(() => claudeReply('Yes'));
  res = await send(off.LitAnswers, msg);
  assert.deepStrictEqual(res, { ok: false, reason: 'no-ai' });
  assert.strictEqual(offCalls.length, 0, 'no request when AI is off');

  // Bad requests.
  assert.deepStrictEqual(await send(off.LitAnswers, { question: 'Pick one', kind: 'choice', options: [] }), { ok: false, reason: 'bad-request' });
  assert.deepStrictEqual(await send(off.LitAnswers, { question: '   ', kind: 'text' }), { ok: false, reason: 'bad-request' });
  assert.deepStrictEqual(await send(off.LitAnswers, { question: 'Q', kind: 'essay' }), { ok: false, reason: 'bad-request' });
  unload();
}

async function testFallbacks() {
  const { LitAnswers } = load({ aiEnabled: true, aiKey: KEY });
  const local = text => assert.ok(/^I want to work at Acme because/.test(text), 'local composer answer: ' + text);

  // Refusal -> local composer.
  let calls = mockFetch(() => claudeReply(null, 'refusal'));
  let res = await send(LitAnswers, TEXT_MSG);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.source, 'local');
  local(res.text);
  assertNoKey(res, 'refusal');

  // Network error (with the key in the error text) -> local.
  global.fetch = async () => { throw new Error('network down for ' + KEY); };
  res = await send(LitAnswers, TEXT_MSG);
  assert.strictEqual(res.source, 'local');
  assertNoKey(res, 'network error');

  // HTTP error -> local.
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  res = await send(LitAnswers, TEXT_MSG);
  assert.strictEqual(res.source, 'local');
  assertNoKey(res, 'http error');

  // Bad JSON, empty content, NONE -> local.
  global.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } });
  assert.strictEqual((await send(LitAnswers, TEXT_MSG)).source, 'local');
  mockFetch(() => claudeReply(null, 'end_turn'));
  assert.strictEqual((await send(LitAnswers, TEXT_MSG)).source, 'local');
  mockFetch(() => claudeReply('NONE'));
  assert.strictEqual((await send(LitAnswers, TEXT_MSG)).source, 'local');

  // Nothing local either -> ok: false, never invented.
  mockFetch(() => claudeReply(null, 'refusal'));
  res = await send(LitAnswers, { question: 'Describe your experience with embedded firmware.', kind: 'text', job: JOB });
  assert.deepStrictEqual(res, { ok: false, reason: 'no-answer' });

  // Timeout: the request is aborted after 30 s and falls back.
  const realSetTimeout = global.setTimeout;
  let abortDelay = null;
  global.setTimeout = (fn, ms) => { if (ms === 30000) { abortDelay = ms; return realSetTimeout(fn, 0); } return realSetTimeout(fn, ms); };
  global.fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  try {
    res = await send(LitAnswers, TEXT_MSG);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.strictEqual(abortDelay, 30000, '30 s timeout');
  assert.strictEqual(res.source, 'local', 'timeout falls back');
  unload();
}

async function testAiDisabledUsesComposer() {
  for (const settings of [{ aiEnabled: false, aiKey: KEY }, { aiEnabled: true, aiKey: '' }, {}]) {
    const { LitAnswers } = load(settings);
    const calls = mockFetch(() => claudeReply('should not be used'));
    const res = await send(LitAnswers, Object.assign({}, TEXT_MSG, { maxLength: 400 }));
    assert.strictEqual(calls.length, 0, 'no network call: ' + JSON.stringify(settings));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.source, 'local');
    assert.ok(/Acme/.test(res.text) && !/Stripe/.test(res.text), res.text);
    assert.ok(res.text.length <= 400);
    unload();
  }
  // Without AutofillStore in the worker the raw af_ keys are read.
  const { LitAnswers } = load({ aiEnabled: false }, { withStore: false });
  const res = await send(LitAnswers, TEXT_MSG);
  assert.strictEqual(res.source, 'local');
  assert.ok(/^I want to work at Acme/.test(res.text));
  unload();
}

async function testTrimming() {
  const { LitAnswers } = load({ aiEnabled: true, aiKey: KEY });
  const long = 'I want to join Acme because payments matter to small businesses. ' +
    'I built a Chrome extension with more than 400 tests. ' +
    'I learn new tools quickly and I write clear documentation. ' +
    'I would bring that care to the Backend Engineer Intern role.';
  mockFetch(() => claudeReply(long));
  let res = await send(LitAnswers, Object.assign({}, TEXT_MSG, { maxLength: 130 }));
  assert.strictEqual(res.source, 'ai');
  assert.strictEqual(res.text, 'I want to join Acme because payments matter to small businesses. I built a Chrome extension with more than 400 tests.');
  assert.ok(res.text.length <= 130);

  // Cut off at max_tokens: the unfinished sentence goes.
  mockFetch(() => claudeReply('I want to join Acme because payments matter. I built a Chrome exten', 'max_tokens'));
  res = await send(LitAnswers, TEXT_MSG);
  assert.strictEqual(res.text, 'I want to join Acme because payments matter.');

  // Text blocks are joined; other block types are ignored; markdown is stripped.
  mockFetch(() => claudeReply('rest of it.', 'end_turn', [
    { type: 'thinking', thinking: '', signature: 'x' },
    { type: 'text', text: '**I want to join Acme** because of the ' }
  ]));
  res = await send(LitAnswers, TEXT_MSG);
  assert.strictEqual(res.text, 'I want to join Acme because of the rest of it.');

  // maxLength from the element is honored, and a silly one is clamped.
  const req = LitAnswers.normalizeRequest({ question: 'Q', kind: 'text', maxLength: 99999999 });
  assert.strictEqual(req.maxLength, 10000);
  assert.strictEqual(LitAnswers.normalizeRequest({ question: 'Q' }).maxLength, 1500);
  unload();
}

async function testOtherMessagesIgnored() {
  const { LitAnswers } = load({});
  assert.strictEqual(LitAnswers.handleMessage({ type: 'LIT_BATCH_HELLO' }, {}, () => {}), false);
  assert.strictEqual(LitAnswers.handleMessage(null, {}, () => {}), false);
  assert.strictEqual(LitAnswers.matchChoice('no', ['Yes', 'No']), 'No');
  assert.strictEqual(LitAnswers.matchChoice('No.', ['Yes', 'No']), 'No');
  assert.strictEqual(LitAnswers.matchChoice('Nope', ['Yes', 'No']), null);
  unload();
}

async function run() {
  console.log('--- Running test/ai-answer.test.js ---');
  const realFetch = global.fetch;
  const tests = [
    testRequestShape,
    testChoice,
    testFallbacks,
    testAiDisabledUsesComposer,
    testTrimming,
    testOtherMessagesIgnored
  ];
  try {
    for (const t of tests) {
      // Any real network call is a failure.
      global.fetch = async () => { throw new Error('unexpected real fetch'); };
      try {
        await t();
        console.log('[PASS] ' + t.name);
      } catch (e) {
        try { unload(); } catch (err) { /* already unloaded */ }
        console.error('[FAIL] ' + t.name);
        throw e;
      }
    }
  } finally {
    if (realFetch) global.fetch = realFetch;
    else delete global.fetch;
  }
  console.log('--- test/ai-answer.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
