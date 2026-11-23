// The buddy's session and nudge rules, its lines, the export helpers for
// Sheets and Notion, and the new look-and-feel and buddy preferences.
const assert = require('assert');
const path = require('path');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

async function run() {
  console.log('--- Running test/buddy.test.js ---');
  const B = require(path.join(__dirname, '..', 'shared', 'buddy.js'));
  const MIN = 60 * 1000;
  const t0 = Date.UTC(2026, 10, 20, 15, 0, 0);
  const prefs = { buddyEnabled: true, breakReminderMin: 60, waterReminder: true };

  // Sessions: continue within the quiet gap, restart after it.
  {
    let s = B.recordActivity(null, t0);
    assert.strictEqual(s.start, t0);
    s = B.recordActivity(s, t0 + 40 * MIN);
    assert.strictEqual(s.start, t0, 'a 40 minute gap keeps the session going');
    assert.strictEqual(B.activeMinutes(s, t0 + 50 * MIN), 50);
    const fresh = B.recordActivity(s, t0 + 40 * MIN + (B.SESSION_GAP_MIN + 1) * MIN);
    assert.strictEqual(fresh.start, t0 + 40 * MIN + (B.SESSION_GAP_MIN + 1) * MIN, 'a long gap starts a new session');
    assert.strictEqual(B.activeMinutes(s, t0 + 40 * MIN + (B.SESSION_GAP_MIN + 1) * MIN), 0, 'a quiet session reads as inactive');
    console.log('[PASS] Sessions continue within the quiet gap and restart after it');
  }

  // Nudges: water at half the break interval, then the break, never while
  // snoozed, off when the buddy is off.
  {
    let s = B.recordActivity(null, t0);
    for (let m = 10; m <= 60; m += 10) s = B.recordActivity(s, t0 + m * MIN);
    assert.strictEqual(B.nudgeDue(s, t0 + 20 * MIN, prefs), null, 'nothing due early on');
    assert.strictEqual(B.nudgeDue(s, t0 + 30 * MIN, prefs), 'water', 'water at half of a one hour break interval');
    const watered = B.markNudged(s, 'water', t0 + 30 * MIN);
    assert.strictEqual(B.nudgeDue(watered, t0 + 45 * MIN, prefs), null, 'water does not repeat right away');
    assert.strictEqual(B.nudgeDue(watered, t0 + 60 * MIN, prefs), 'break', 'a break after an hour');
    const rested = B.markNudged(watered, 'break', t0 + 60 * MIN);
    assert.strictEqual(B.nudgeDue(rested, t0 + 61 * MIN, prefs), null, 'a break resets both clocks');
    assert.strictEqual(B.nudgeDue(s, t0 + 60 * MIN, { buddyEnabled: false }), null, 'buddy off means no nudges');
    assert.strictEqual(B.nudgeDue(s, t0 + 60 * MIN, { breakReminderMin: 0, waterReminder: false }), null, 'both reminders off');
    const snoozed = B.snooze(s, t0 + 60 * MIN);
    assert.strictEqual(B.nudgeDue(snoozed, t0 + 70 * MIN, prefs), null, 'snoozed');
    assert.strictEqual(B.nextNudgeAt(B.recordActivity(null, t0), prefs), t0 + 30 * MIN, 'the next nudge is scheduled for water');
    assert.strictEqual(B.nextNudgeAt(B.recordActivity(null, t0), { breakReminderMin: 0, waterReminder: false }), null);
    console.log('[PASS] Water and break nudges, snooze, and off switches');
  }

  // Lines stay kind, short, and emoji free.
  {
    const all = [];
    for (let h = 0; h < 24; h++) all.push(B.lines.greeting(h, 'Lockie'));
    for (let i = 0; i < 10; i++) all.push(B.lines.cheer(i), B.lines.goalMet(i));
    all.push(B.lines.progress(2, 5, 'applications'), B.lines.progress(4, 5, 'applications'), B.lines.rest(), B.lines.water(),
      B.lines.breakNudge(45), B.lines.breakNudge(75), B.lines.breakNudge(130), B.lines.breakThanks());
    all.push(...B.lines.taps);
    all.forEach(line => {
      assert.ok(typeof line === 'string' && line.length > 0 && line.length < 140, 'line length: ' + line);
      assert.ok(!EMOJI.test(line), 'no emoji: ' + line);
      assert.ok(!/fail|lazy|should have|undefined|NaN/i.test(line), 'kind wording: ' + line);
    });
    assert.strictEqual(B.lines.progress(4, 5, 'applications'), 'One more application and today is locked in.');
    assert.ok(B.svg().startsWith('<svg') && !EMOJI.test(B.svg()));
    console.log('[PASS] Buddy lines are short, kind, and emoji free');
  }

  // Export helpers for Sheets and Notion.
  {
    const E = require(path.join(__dirname, '..', 'shared', 'exporters.js'));
    const tsv = E.buildTsv([{ date: '2026-11-20', metricId: 'jobs', company: '=HYPERLINK("x")', role: 'PM\tlead', notes: 'line one\nline two', count: 1 }], { jobs: 'Applications' });
    const lines = tsv.split('\n');
    assert.strictEqual(lines.length, 2);
    const cells = lines[1].split('\t');
    assert.strictEqual(cells.length, 8, 'tabs inside values never add columns');
    assert.strictEqual(cells[1], 'Applications');
    assert.ok(cells[3].startsWith("'="), 'formulas are neutralized');
    assert.strictEqual(cells[6], 'line one line two');
    const logs = [
      { date: '2026-10-01', metricId: 'jobs' },
      { date: '2026-11-19', metricId: 'jobs', timestamp: 'b' },
      { date: '2026-11-19', metricId: 'jobs', timestamp: 'a' },
      { date: '2026-11-18', metricId: 'chats' }
    ];
    assert.deepStrictEqual(E.filterLogs(logs, { days: 7, today: '2026-11-20' }).map(l => l.date + l.metricId + (l.timestamp || '')), ['2026-11-18chats', '2026-11-19jobsa', '2026-11-19jobsb'], 'last 7 days, oldest first');
    assert.strictEqual(E.filterLogs(logs, { metricId: 'jobs', days: 'all' }).length, 3);
    assert.strictEqual(E.filterLogs(logs, {}).length, 4);
    console.log('[PASS] Sheets (TSV) and Notion export helpers');
  }

  // New preferences are shape-checked.
  {
    installMockChrome();
    delete require.cache[require.resolve('../shared/storage')];
    delete require.cache[require.resolve('../shared/auth')];
    global.TrackerAuth = require('../shared/auth');
    const S = require('../shared/storage');
    let p = await S.getPrefs();
    assert.strictEqual(p.themeStyle, 'warm');
    assert.strictEqual(p.buddyEnabled, true);
    assert.strictEqual(p.buddyName, 'Lockie');
    assert.strictEqual(p.breakReminderMin, 60);
    p = await S.setPrefs({ themeStyle: 'arcade', buddyName: '  Pip   the  lock ', breakReminderMin: 90, waterReminder: false });
    assert.strictEqual(p.themeStyle, 'arcade');
    assert.strictEqual(p.buddyName, 'Pip the lock');
    assert.strictEqual(p.breakReminderMin, 90);
    assert.strictEqual(p.waterReminder, false);
    p = await S.setPrefs({ themeStyle: 'neon', buddyName: '   ', breakReminderMin: 17 });
    assert.strictEqual(p.themeStyle, 'arcade', 'unknown styles are refused');
    assert.strictEqual(p.buddyName, 'Pip the lock', 'an empty name is refused');
    assert.strictEqual(p.breakReminderMin, 90, 'only offered break lengths are kept');
    delete global.TrackerAuth;
    uninstallMockChrome();
    console.log('[PASS] Theme style and buddy preferences are validated');
  }

  console.log('--- test/buddy.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => { console.error('Test failed:', err); process.exit(1); });
}

module.exports = { run };
