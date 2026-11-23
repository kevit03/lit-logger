// Tests for popup/modules/shell-fx.js: focus-session state and time math,
// the status island's words and scheduling, double-tap detection, the
// time-of-day phase, swipe decisions and goal choice. Also drives the
// service worker's focus-session section (alarm, close-out notification,
// "Start another") in isolation. The module must load in node without a DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MIN = 60000;

function fresh(rel) {
  const file = path.join(ROOT, rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

async function settle(n = 20) {
  for (let i = 0; i < n; i++) await tick();
}

function bus() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    emit(...args) { return listeners.map(fn => fn(...args)); },
    count() { return listeners.length; }
  };
}

// The worker's focus section, cut out between its markers and run against a
// small fake chrome, so it is tested on its own.
function loadFocusSection(opts) {
  const src = fs.readFileSync(path.join(ROOT, 'background', 'service-worker.js'), 'utf8');
  const start = src.indexOf('// --- BEGIN Focus sessions');
  const end = src.indexOf('// --- END Focus sessions');
  assert.ok(start > 0 && end > start, 'the worker has a delimited focus-session section');
  const section = src.slice(start, end);
  const store = Object.assign({}, opts && opts.store);
  const onChanged = bus();
  const alarms = new Map();
  const chrome = {
    runtime: { lastError: null, getURL: p => 'chrome-extension://x/' + p },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          keys.forEach(k => { if (store[k] !== undefined) out[k] = JSON.parse(JSON.stringify(store[k])); });
          setImmediate(() => cb(out));
        },
        set(items, cb) {
          const changes = {};
          Object.keys(items).forEach(k => {
            changes[k] = { oldValue: store[k], newValue: JSON.parse(JSON.stringify(items[k])) };
            store[k] = JSON.parse(JSON.stringify(items[k]));
          });
          setImmediate(() => { onChanged.emit(changes, 'local'); if (cb) cb(); });
        }
      },
      onChanged
    },
    alarms: {
      store: alarms,
      create: async (name, info) => { alarms.set(name, info); },
      clear: async name => alarms.delete(name),
      onAlarm: bus()
    },
    notifications: {
      created: [],
      cleared: [],
      create(id, o, cb) { this.created.push({ id, opts: o }); if (cb) cb(id); },
      clear(id, cb) { this.cleared.push(id); if (cb) cb(true); },
      onClicked: bus(),
      onButtonClicked: bus()
    }
  };
  const prefs = Object.assign({}, opts && opts.prefs);
  const sandbox = {
    chrome,
    TrackerStorage: { getPrefs: async () => prefs },
    console: { warn() {}, log() {} },
    setImmediate,
    Promise,
    Date
  };
  vm.createContext(sandbox);
  const api = vm.runInContext(section + '\n;({ litFocusNormalize, litFocusSync, litFocusSettle, litFocusStartAnother, LIT_FOCUS_ALARM, LIT_FOCUS_NOTIFICATION });', sandbox);
  return { api, chrome, store };
}

async function run() {
  console.log('--- Running test/shell-fx.test.js ---');

  global.LitPopup = undefined;
  const fx = fresh('popup/modules/shell-fx.js');
  delete global.LitPopup;

  // 1. Loads in node with no DOM and exposes the pure helpers.
  {
    assert.strictEqual(typeof fx.normalizeFocus, 'function');
    assert.strictEqual(fx.FOCUS_KEY, 'lit_focus');
    assert.deepStrictEqual(fx.FOCUS_LENGTHS, [25, 45, 60]);
    assert.deepStrictEqual(fx.FEATURE_KEYS, ['island', 'miniPlayer', 'doubleTap', 'ambient', 'swipeGoals']);
    const src = fs.readFileSync(path.join(ROOT, 'popup', 'modules', 'shell-fx.js'), 'utf8');
    ['Dynamic Island', 'Spotify', 'Netflix', 'Instagram', 'TikTok', 'YouTube', 'Apple'].forEach(name => {
      assert.ok(!src.includes(name), 'no other company or feature name: ' + name);
    });
    console.log('[PASS] Loads without a DOM; exports its helpers; no borrowed names');
  }

  // 2. Focus records: tolerant normalizing.
  {
    const idle = fx.normalizeFocus(null);
    assert.deepStrictEqual(idle, { status: 'idle', length: 25, startedAt: null, endsAt: null, remaining: 25 * MIN });
    assert.strictEqual(fx.normalizeFocus({ status: 'bogus', length: 45 }).status, 'idle');
    assert.strictEqual(fx.normalizeFocus({ status: 'bogus', length: 45 }).length, 45);
    assert.strictEqual(fx.normalizeFocus({ status: 'running', length: 25 }).status, 'idle', 'running needs a deadline');
    assert.strictEqual(fx.normalizeFocus({ status: 'idle', length: -3 }).length, 25);
    assert.strictEqual(fx.normalizeFocus({ status: 'idle', length: 9999 }).length, 180);
    assert.strictEqual(fx.normalizeFocus({ status: 'paused', length: 25, remaining: 0 }).status, 'done', 'nothing left is done');
    assert.strictEqual(fx.normalizeFocus({ status: 'paused', length: 25, remaining: 99 * MIN }).remaining, 25 * MIN, 'remaining is capped at the length');
    const run1 = fx.normalizeFocus({ status: 'running', length: 25, endsAt: 1000 + 25 * MIN });
    assert.strictEqual(run1.startedAt, 1000, 'a missing start is derived from the deadline');
    console.log('[PASS] Focus records normalize safely');
  }

  // 3. Focus transitions and remaining-time math.
  {
    const t0 = 1700000000000;
    const idle = fx.normalizeFocus({ status: 'idle', length: 45 });
    const running = fx.focusStart(idle, t0);
    assert.deepStrictEqual(running, { status: 'running', length: 45, startedAt: t0, endsAt: t0 + 45 * MIN, remaining: 45 * MIN });
    assert.strictEqual(fx.focusRemaining(running, t0 + 10 * MIN), 35 * MIN);
    assert.ok(Math.abs(fx.focusProgress(running, t0 + 9 * MIN) - 0.2) < 1e-9);
    assert.strictEqual(fx.focusStatus(running, t0 + 45 * MIN), 'done', 'at the deadline it is done');
    assert.strictEqual(fx.focusStatus(running, t0 + 45 * MIN + 31 * MIN), 'idle', 'long finished reads as idle again');
    assert.strictEqual(fx.focusRemaining(running, t0 + 50 * MIN), 0);
    assert.strictEqual(fx.focusProgress(running, t0 + 50 * MIN), 1);

    const paused = fx.focusPause(running, t0 + 15 * MIN);
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.endsAt, null);
    assert.strictEqual(paused.remaining, 30 * MIN);
    assert.strictEqual(fx.focusRemaining(paused, t0 + 99 * MIN), 30 * MIN, 'a paused session does not tick');
    assert.strictEqual(fx.focusPause(paused, t0), paused, 'pausing twice changes nothing');

    const resumed = fx.focusResume(paused, t0 + 60 * MIN);
    assert.strictEqual(resumed.status, 'running');
    assert.strictEqual(resumed.endsAt, t0 + 90 * MIN);
    assert.strictEqual(resumed.startedAt, t0, 'resume keeps the original start');

    assert.strictEqual(fx.focusToggle(running, t0 + MIN).status, 'paused');
    assert.strictEqual(fx.focusToggle(paused, t0).status, 'running');
    const again = fx.focusToggle(running, t0 + 46 * MIN);
    assert.strictEqual(again.status, 'running', 'play after done starts another');
    assert.strictEqual(again.endsAt, t0 + 46 * MIN + 45 * MIN);

    assert.deepStrictEqual(fx.focusStop(running), { status: 'idle', length: 45, startedAt: null, endsAt: null, remaining: 45 * MIN });

    const longer = fx.focusSetLength(running, 60, t0 + 5 * MIN);
    assert.strictEqual(longer.status, 'running', 'a new length restarts a running session');
    assert.strictEqual(longer.endsAt, t0 + 5 * MIN + 60 * MIN);
    const pausedLonger = fx.focusSetLength(paused, 60, t0);
    assert.strictEqual(pausedLonger.status, 'paused');
    assert.strictEqual(pausedLonger.remaining, 60 * MIN);
    const idleLonger = fx.focusSetLength(idle, 25, t0);
    assert.strictEqual(idleLonger.status, 'idle');
    assert.strictEqual(idleLonger.length, 25);
    console.log('[PASS] Focus sessions start, pause, resume, finish, and change length; time is derived from the clock');
  }

  // 4. Words on the clock, the player, and the play button.
  {
    assert.strictEqual(fx.formatClock(25 * MIN), '25:00');
    assert.strictEqual(fx.formatClock(18 * MIN + 41500), '18:42', 'partial seconds round up');
    assert.strictEqual(fx.formatClock(999), '0:01');
    assert.strictEqual(fx.formatClock(0), '0:00');
    assert.strictEqual(fx.formatClock(-5), '0:00');
    assert.strictEqual(fx.minutesText(30000), 'under a minute');
    assert.strictEqual(fx.minutesText(MIN), '1 minute');
    assert.strictEqual(fx.minutesText(18 * MIN + 1), '19 minutes');

    const t0 = 1700000000000;
    const idle = fx.normalizeFocus({ status: 'idle', length: 25 });
    const running = fx.focusStart(idle, t0);
    const at = t0 + 6 * MIN + 18000; // 18:42 left
    assert.strictEqual(fx.playerSub({ count: 3, goal: 5 }, running, at), '3 of 5 today · 18:42 left');
    assert.strictEqual(fx.playerSub({ count: 3, goal: 5 }, idle, at), '3 of 5 today · 25 min focus');
    assert.strictEqual(fx.focusLine(fx.focusPause(running, at), at), 'Paused, 18:42');
    assert.strictEqual(fx.focusLine(running, t0 + 26 * MIN), 'Session done');
    assert.strictEqual(fx.playerSub({ count: 0, goal: 0 }, idle, at), '0 of 1 today · 25 min focus', 'a missing goal never divides by zero');

    assert.deepStrictEqual(fx.playButton(idle, at), { icon: 'play', label: 'Start a 25 minute focus session' });
    assert.strictEqual(fx.playButton(running, at).icon, 'pause');
    assert.strictEqual(fx.playButton(fx.focusPause(running, at), at).label, 'Resume the focus session');
    assert.strictEqual(fx.playButton(running, t0 + 26 * MIN).label, 'Start another 25 minute focus session');
    console.log('[PASS] Clock, player line, and play button read plainly');
  }

  // 5. The status island: what it says for each moment.
  {
    const log = fx.islandMessage('log', { count: 3, goal: 5, unitOne: 'application' });
    assert.strictEqual(log.title, '+1 Application');
    assert.strictEqual(log.sub, '3 of 5 today');
    assert.strictEqual(log.text, '+1 Application · 3 of 5');
    assert.strictEqual(log.icon, 'plus');
    const met = fx.islandMessage('goal-met', {});
    assert.strictEqual(met.text, 'Locked in for today');
    assert.strictEqual(met.icon, 'lock');
    assert.strictEqual(met.say, true);
    const focus = fx.islandMessage('focus', { remainingMs: 18 * MIN + 42000 });
    assert.strictEqual(focus.sub, '18:42 left');
    assert.strictEqual(focus.title, 'Focus session');
    assert.strictEqual(fx.islandMessage('focus', { remainingMs: MIN, paused: true }).title, 'Focus paused');
    assert.strictEqual(fx.islandMessage('nudge', { kind: 'water' }).text, 'Time for a water break');
    assert.strictEqual(fx.islandMessage('nudge', { kind: 'break' }).text, 'Time for a stretch break');
    assert.ok(/Stretch and grab some water/.test(fx.islandMessage('focus-done').text));
    assert.strictEqual(fx.islandMessage('undo', { count: 2, goal: 5 }).sub, '2 of 5 today');
    assert.strictEqual(fx.islandMessage('mystery'), null);

    const rest = fx.islandRest({ count: 3, goal: 5, unitMany: 'applications', focusStatus: 'running', focusRemaining: 18 * MIN + 42000 });
    assert.strictEqual(rest.label, '3/5');
    assert.strictEqual(rest.pct, 0.6);
    assert.strictEqual(rest.met, false);
    assert.strictEqual(rest.timer, '18:42');
    assert.ok(/3 of 5 applications/.test(rest.aria) && /19 minutes left/.test(rest.aria));
    const done = fx.islandRest({ count: 7, goal: 5, focusStatus: 'idle' });
    assert.strictEqual(done.pct, 1);
    assert.strictEqual(done.met, true);
    assert.strictEqual(done.timer, '', 'no clock without a session');

    const sum = fx.islandSummary({ count: 3, goal: 5, week: 12, weekly: 20, streak: 4, focusStatus: 'running', focusRemaining: 5 * MIN });
    assert.deepStrictEqual(sum, { today: '3 of 5', week: '12 of 20', streak: '4 days', focus: 'Focus session · 5:00 left' });
    const plain = fx.islandSummary({ count: 0, goal: 5, week: 2, weekly: 0, streak: 0, focusStatus: 'idle' });
    assert.strictEqual(plain.week, '2');
    assert.strictEqual(plain.streak, 'Fresh start', 'never "0 days"');
    assert.strictEqual(plain.focus, null);
    assert.strictEqual(fx.islandSummary({ streak: 1 }).streak, '1 day');
    console.log('[PASS] Island words for log, goal met, focus, nudges, and the summary');
  }

  // 6. The island's schedule: priorities, refresh in place, a short queue.
  {
    const msg = (kind, extra) => Object.assign(fx.islandMessage(kind, { count: 1, goal: 5, unitOne: 'application', kind: 'water' }), extra);
    let plan = fx.islandSchedule(null, [], msg('log'));
    assert.strictEqual(plan.show.kind, 'log', 'nothing showing: show it');
    plan = fx.islandSchedule(msg('log'), [], msg('log', { sub: '2 of 5 today' }));
    assert.strictEqual(plan.show.sub, '2 of 5 today', 'the same kind refreshes in place');
    plan = fx.islandSchedule(msg('log'), [], msg('goal-met'));
    assert.strictEqual(plan.show.kind, 'goal-met', 'a met goal takes over');
    plan = fx.islandSchedule(msg('goal-met'), [], msg('log'));
    assert.strictEqual(plan.show, null);
    assert.deepStrictEqual(plan.queue, [], 'the log that met the goal is not repeated');
    plan = fx.islandSchedule(msg('nudge'), [], msg('focus'));
    assert.strictEqual(plan.show, null, 'a focus update waits behind a nudge');
    assert.deepStrictEqual(plan.queue.map(m => m.kind), ['focus']);
    plan = fx.islandSchedule(msg('goal-met'), plan.queue, msg('focus'));
    assert.strictEqual(plan.queue.length, 1, 'one queued message per kind');
    plan = fx.islandSchedule(msg('goal-met'), [msg('focus'), msg('undo')], msg('nudge'));
    assert.deepStrictEqual(plan.queue.map(m => m.kind), ['undo', 'nudge'], 'the queue keeps the latest two');
    assert.strictEqual(fx.islandSchedule(null, [], null).show, null);
    console.log('[PASS] The island shows the most important moment and queues the rest');
  }

  // 7. Buddy nudges worth showing.
  {
    const now = 1700000000000;
    const s = at => ({ lastNudge: { kind: 'water', at } });
    assert.strictEqual(fx.nudgeToShow(s(now - 5 * MIN), now, 0), 'water');
    assert.strictEqual(fx.nudgeToShow({ lastNudge: { kind: 'break', at: now - MIN } }, now, 0), 'break');
    assert.strictEqual(fx.nudgeToShow(s(now - 21 * MIN), now, 0), null, 'older than 20 minutes is stale');
    assert.strictEqual(fx.nudgeToShow(s(now - 5 * MIN), now, now - 5 * MIN), null, 'shown once');
    assert.strictEqual(fx.nudgeToShow({ lastNudge: null }, now, 0), null);
    assert.strictEqual(fx.nudgeToShow(null, now, 0), null);
    console.log('[PASS] Recent buddy nudges show once');
  }

  // 8. Double-tap detection from timestamps and positions.
  {
    assert.ok(fx.isTap({ x: 10, y: 10, t: 0 }, { x: 14, y: 12, t: 120 }));
    assert.ok(!fx.isTap({ x: 10, y: 10, t: 0 }, { x: 40, y: 10, t: 120 }), 'a drag is not a tap');
    assert.ok(!fx.isTap({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 900 }), 'a long press is not a tap');
    assert.ok(fx.isDoubleTap({ x: 50, y: 50, t: 1000 }, { x: 58, y: 54, t: 1250 }));
    assert.ok(!fx.isDoubleTap({ x: 50, y: 50, t: 1000 }, { x: 50, y: 50, t: 1400 }), 'too slow');
    assert.ok(!fx.isDoubleTap({ x: 50, y: 50, t: 1000 }, { x: 95, y: 50, t: 1100 }), 'too far apart');
    assert.ok(!fx.isDoubleTap(null, { x: 1, y: 1, t: 1 }));

    const gate = fx.createTapGate();
    assert.strictEqual(gate.tap({ x: 0, y: 0, t: 0 }), false, 'a single tap does nothing');
    assert.strictEqual(gate.tap({ x: 2, y: 1, t: 200 }), true, 'the second quick tap fires');
    assert.strictEqual(gate.tap({ x: 2, y: 1, t: 350 }), false, 'a third tap starts a new pair');
    assert.strictEqual(gate.tap({ x: 2, y: 1, t: 2000 }), false, 'a slow pair does not fire');
    gate.reset();
    assert.strictEqual(gate.tap({ x: 2, y: 1, t: 2100 }), false, 'reset (a drag) forgets the first tap');
    console.log('[PASS] Double-tap: quick and close fires once; single, slow, far, and dragged taps do not');
  }

  // 9. Time-of-day phase.
  {
    const phases = {};
    for (let h = 0; h < 24; h++) phases[h] = fx.timePhase(h);
    assert.strictEqual(phases[4], 'night');
    assert.strictEqual(phases[5], 'morning');
    assert.strictEqual(phases[10], 'morning');
    assert.strictEqual(phases[11], 'midday');
    assert.strictEqual(phases[16], 'midday');
    assert.strictEqual(phases[17], 'evening');
    assert.strictEqual(phases[20], 'evening');
    assert.strictEqual(phases[21], 'night');
    assert.strictEqual(phases[23], 'night');
    assert.strictEqual(fx.timePhase(29), 'morning', 'wraps past midnight');
    assert.strictEqual(fx.timePhase('x'), 'midday');
    console.log('[PASS] Time of day: morning, midday, evening, night');
  }

  // 10. Swipe decisions and the goal they land on.
  {
    assert.strictEqual(fx.swipeDirection(-80, 5), 1, 'drag left: next goal');
    assert.strictEqual(fx.swipeDirection(80, 5), -1, 'drag right: previous goal');
    assert.strictEqual(fx.swipeDirection(-30, 0), 0, 'too short');
    assert.strictEqual(fx.swipeDirection(-80, 70), 0, 'too diagonal');
    assert.strictEqual(fx.swipeDirection(5, 300), 0, 'vertical scroll');
    assert.strictEqual(fx.swipeDirection(80, 0, { source: 'wheel' }), 1, 'wheel to the right: next goal');
    assert.strictEqual(fx.swipeDirection(-80, 0, { source: 'wheel' }), -1);
    assert.ok(fx.dragIntent(14, 3));
    assert.ok(!fx.dragIntent(6, 0), 'small moves stay taps');
    assert.ok(!fx.dragIntent(14, 14), 'diagonal is not a swipe');
    assert.strictEqual(fx.dragOffset(-100, true), -50);
    assert.strictEqual(fx.dragOffset(-400, true), -70, 'follow is capped');
    assert.strictEqual(fx.dragOffset(100, false), 18, 'rubber band at the ends');
    assert.strictEqual(fx.dragOffset(400, false), 24);
    assert.strictEqual(fx.wheelPixels(3, 1), 48, 'line deltas become pixels');
    assert.strictEqual(fx.wheelPixels(12, 0), 12);

    const gate = fx.createWheelGate();
    let fired = [];
    for (let i = 0; i < 30; i++) fired.push(gate.feed({ dx: 6, dy: 1, t: i * 16 }));
    assert.deepStrictEqual(fired.filter(Boolean), [1], 'one goal change per trackpad swipe, momentum included');
    assert.strictEqual(gate.feed({ dx: -70, dy: 0, t: 30 * 16 + 300 }), -1, 'after a pause the next swipe counts');
    const vertical = fx.createWheelGate();
    fired = [];
    for (let i = 0; i < 40; i++) fired.push(vertical.feed({ dx: i % 5 === 0 ? 8 : 0, dy: 30, t: i * 16 }));
    assert.deepStrictEqual(fired.filter(Boolean), [], 'scrolling the page never switches goals');

    const ids = ['jobs', 'leetcode', 'outreach'];
    assert.strictEqual(fx.neighborGoal(ids, 'jobs', 1), 'leetcode');
    assert.strictEqual(fx.neighborGoal(ids, 'leetcode', -1), 'jobs');
    assert.strictEqual(fx.neighborGoal(ids, 'outreach', 1), null, 'no wrap past the last goal');
    assert.strictEqual(fx.neighborGoal(ids, 'jobs', -1), null, 'no wrap before the first goal');
    assert.strictEqual(fx.neighborGoal(ids, 'gone', 1), null);
    assert.strictEqual(fx.neighborGoal(['jobs'], 'jobs', 1), null);
    assert.strictEqual(fx.neighborGoal(ids, 'jobs', 0), null);
    console.log('[PASS] Swipes: direction, threshold, vertical ignored, one per gesture, no wrap');
  }

  // 11. Readable text on a goal color.
  {
    assert.strictEqual(fx.readableOn('#1a73e8'), '#FFFFFF');
    assert.strictEqual(fx.readableOn('#FFD54F'), '#202124');
    assert.strictEqual(fx.readableOn('#fff'), '#202124');
    assert.strictEqual(fx.readableOn('not a color'), '#FFFFFF');
    console.log('[PASS] Artwork icons stay readable on any goal color');
  }

  // 12. The service worker's focus-session section.
  {
    const now = Date.now();
    const { api, chrome, store } = loadFocusSection({ prefs: { buddyName: 'Pip' } });
    await settle();
    assert.strictEqual(chrome.alarms.store.size, 0, 'nothing booked without a session');

    // The popup starts a session: the alarm follows the deadline.
    chrome.storage.local.set({ lit_focus: { status: 'running', length: 25, startedAt: now, endsAt: now + 25 * MIN, remaining: 25 * MIN } });
    await settle();
    assert.strictEqual(chrome.alarms.store.get('lit-focus').when, now + 25 * MIN);

    // Pause clears it; resume books it again.
    chrome.storage.local.set({ lit_focus: { status: 'paused', length: 25, startedAt: now, endsAt: null, remaining: 20 * MIN } });
    await settle();
    assert.strictEqual(chrome.alarms.store.get('lit-focus'), undefined, 'pause clears the alarm');
    chrome.storage.local.set({ lit_focus: { status: 'running', length: 25, startedAt: now, endsAt: now + 20 * MIN, remaining: 20 * MIN } });
    await settle();
    assert.ok(chrome.alarms.store.get('lit-focus'));

    // The deadline passes and the alarm fires: done, one notification.
    store.lit_focus.endsAt = Date.now() - 1000;
    chrome.alarms.onAlarm.emit({ name: 'lit-focus' });
    await settle();
    assert.strictEqual(store.lit_focus.status, 'done');
    assert.strictEqual(store.lit_focus.remaining, 0);
    assert.strictEqual(chrome.notifications.created.length, 1);
    const note = chrome.notifications.created[0];
    assert.strictEqual(note.id, 'lit-focus');
    assert.strictEqual(note.opts.title, 'Pip', 'titled with the buddy name');
    assert.strictEqual(note.opts.message, 'Focus session done. Stretch and grab some water.');
    assert.strictEqual(JSON.stringify(note.opts.buttons.map(b => b.title)), JSON.stringify(['Start another']));
    assert.strictEqual(chrome.alarms.store.get('lit-focus'), undefined, 'done clears the alarm');

    chrome.alarms.onAlarm.emit({ name: 'lit-focus' });
    await settle();
    assert.strictEqual(chrome.notifications.created.length, 1, 'a duplicate alarm does not announce twice');

    // Other alarms and notifications are none of its business.
    chrome.alarms.onAlarm.emit({ name: 'pt-timer-popup' });
    chrome.notifications.onButtonClicked.emit('pt-timer-popup', 0);
    await settle();
    assert.strictEqual(store.lit_focus.status, 'done');

    // Clicking the body only clears it.
    chrome.notifications.onClicked.emit('lit-focus');
    await settle();
    assert.ok(chrome.notifications.cleared.includes('lit-focus'));
    assert.strictEqual(store.lit_focus.status, 'done');

    // "Start another": a new running session of the same length, alarm booked.
    const before = Date.now();
    chrome.notifications.onButtonClicked.emit('lit-focus', 0);
    await settle();
    assert.strictEqual(store.lit_focus.status, 'running');
    assert.strictEqual(store.lit_focus.length, 25);
    assert.ok(store.lit_focus.endsAt >= before + 25 * MIN);
    assert.strictEqual(chrome.alarms.store.get('lit-focus').when, store.lit_focus.endsAt);

    // Stop clears the alarm.
    chrome.storage.local.set({ lit_focus: { status: 'idle', length: 25 } });
    await settle();
    assert.strictEqual(chrome.alarms.store.get('lit-focus'), undefined);
    assert.strictEqual(api.litFocusNormalize({ status: 'running', length: 25 }), null, 'a running record needs a deadline');
    console.log('[PASS] Worker: alarm follows the session, done is announced once in the buddy name, Start another restarts');
  }

  // 13. Worker revival: re-arms a live session, closes a stale one quietly,
  //     and says LIT when the buddy is off.
  {
    const now = Date.now();
    let w = loadFocusSection({ store: { lit_focus: { status: 'running', length: 45, startedAt: now, endsAt: now + 30 * MIN, remaining: 45 * MIN } } });
    await settle();
    assert.strictEqual(w.chrome.alarms.store.get('lit-focus').when, now + 30 * MIN, 'a restart re-arms a running session');

    w = loadFocusSection({ store: { lit_focus: { status: 'running', length: 25, startedAt: now - 3 * 60 * MIN, endsAt: now - 2 * 60 * MIN, remaining: 0 } } });
    await settle();
    assert.strictEqual(w.store.lit_focus.status, 'done');
    assert.strictEqual(w.chrome.notifications.created.length, 0, 'a session that ended hours ago closes quietly');

    w = loadFocusSection({ prefs: { buddyEnabled: false, buddyName: 'Pip' }, store: { lit_focus: { status: 'running', length: 25, startedAt: now - 26 * MIN, endsAt: now - 60000, remaining: 0 } } });
    await settle();
    assert.strictEqual(w.store.lit_focus.status, 'done');
    assert.strictEqual(w.chrome.notifications.created[0].opts.title, 'LIT', 'plain LIT when the buddy is off');

    w = loadFocusSection({});
    await settle();
    assert.strictEqual((await w.api.litFocusSettle()), false, 'nothing to close without a session');
    console.log('[PASS] Worker revival: re-arms, closes stale sessions quietly, names LIT when the buddy is off');
  }

  console.log('--- test/shell-fx.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => { console.error('Test failed:', err); process.exit(1); });
}

module.exports = { run };
