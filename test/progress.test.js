// Progress layer: rest days, streak freezes (earn, spend, cap), week dots,
// milestones, focus areas, merging signed-out entries, the coach copy, and
// the share card.
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const { installMockIDB, uninstallMockIDB } = require('./mock_idb');

function loadStorage() {
  delete require.cache[require.resolve('../shared/auth')];
  delete require.cache[require.resolve('../shared/storage')];
  delete require.cache[require.resolve('../shared/db')];
  const TrackerAuth = require('../shared/auth');
  global.TrackerAuth = TrackerAuth;
  const TrackerStorage = require('../shared/storage');
  global.TrackerStorage = TrackerStorage;
  return { TrackerStorage, TrackerAuth };
}

function fresh(flavor) {
  const mock = installMockChrome({});
  if (flavor === 'indexeddb') installMockIDB();
  return Object.assign({ mock }, loadStorage());
}

function cleanup() {
  delete global.TrackerAuth;
  delete global.TrackerStorage;
  uninstallMockIDB();
  uninstallMockChrome();
}

const EMOJI = /(\p{Extended_Pictographic}|\p{Emoji_Presentation})/u;

// Builds a dailyMap where each listed date has `n` of metric 'jobs'.
function mapOf(dates, n = 1) {
  const m = {};
  dates.forEach(d => { m[d] = { jobs: n }; });
  return m;
}

function range(S, start, days) {
  const out = [];
  for (let i = 0; i < days; i++) out.push(S.addDays(start, i));
  return out;
}

async function run() {
  console.log('--- Running test/progress.test.js ---');
  const { TrackerStorage: S } = fresh('local');
  // 2026-11-19 is a Thursday; 2026-11-16 the Monday of that week.
  const TODAY = '2026-11-19';
  assert.strictEqual(S.parseLocalDateToNoon(TODAY).getDay(), 4);

  // 1. Without rest days the new walk agrees with the classic streak helpers.
  {
    const cases = [
      mapOf(range(S, '2026-11-17', 3)),
      mapOf(range(S, '2026-11-15', 4)),
      mapOf(['2026-11-10', '2026-11-11', '2026-11-13', '2026-11-18']),
      {}
    ];
    cases.forEach(map => {
      const w = S.computeStreakWithRest(map, 'jobs', 1, TODAY, []);
      assert.strictEqual(w.current, S.computeCurrentStreak(map, 'jobs', 1, TODAY));
      assert.strictEqual(w.longest, S.computeLongestStreak(map, 'jobs', 1));
    });
    console.log('[PASS] No rest days and short runs: streaks match the classic helpers');
  }

  // 2. Rest days neither break nor need the goal; a goal met on a rest day is a bonus day.
  {
    // Mon 9th..Fri 13th met, weekend off, Mon 16th..Wed 18th met, today open.
    const map = mapOf(range(S, '2026-11-09', 5).concat(range(S, '2026-11-16', 3)));
    assert.strictEqual(S.computeStreakWithRest(map, 'jobs', 1, TODAY, []).current, 3, 'the weekend breaks a streak without rest days');
    assert.strictEqual(S.computeStreakWithRest(map, 'jobs', 1, TODAY, [0, 6]).current, 8, 'Sat/Sun rest days carry the run across the weekend');
    const bonus = Object.assign({}, map, { '2026-11-14': { jobs: 1 } });
    assert.strictEqual(S.computeStreakWithRest(bonus, 'jobs', 1, TODAY, [0, 6]).current, 9, 'a goal met on a rest day extends the run');
    assert.strictEqual(S.computeStreakWithRest(map, 'jobs', 1, TODAY, ['0', 6, 6, 9]).current, 8, 'rest days are cleaned');
    assert.strictEqual(S.isRestDay('2026-11-15', [0]), true);
    assert.strictEqual(S.isRestDay('2026-11-16', [0]), false);
    console.log('[PASS] Rest days carry a streak without breaking or extending it');
  }

  // 3. Freezes: earn one per 7 goal days, cap 2, spent on a missed past day,
  //    never on today or a rest day.
  {
    let f = S.computeFreezes(mapOf(range(S, '2026-11-12', 7)), 'jobs', 1, TODAY, []);
    assert.deepStrictEqual(f, { available: 1, usedOn: [] }, '7 straight goal days earn one freeze');
    f = S.computeFreezes(mapOf(range(S, '2026-11-12', 6)), 'jobs', 1, TODAY, []);
    assert.strictEqual(f.available, 0, '6 days earn nothing');
    f = S.computeFreezes(mapOf(range(S, '2026-11-06', 14)), 'jobs', 1, TODAY, []);
    assert.strictEqual(f.available, 2, '14 days earn two');
    f = S.computeFreezes(mapOf(range(S, '2026-10-30', 21)), 'jobs', 1, TODAY, []);
    assert.strictEqual(f.available, 2, 'capped at two');

    // 7 met (Nov 5..11), Nov 12 missed, Nov 13..18 met, today open.
    const map = mapOf(range(S, '2026-11-05', 7).concat(range(S, '2026-11-13', 6)));
    const w = S.walkStreak(map, 'jobs', 1, TODAY, []);
    assert.deepStrictEqual(w.usedOn, ['2026-11-12'], 'the freeze is spent on the missed day');
    assert.strictEqual(w.current, 13, 'the run holds across the frozen day without counting it');
    assert.strictEqual(w.available, 0);
    assert.strictEqual(w.longest, 13);

    // Two missed days with one freeze: the second one ends the run.
    const map2 = mapOf(range(S, '2026-11-04', 7).concat(range(S, '2026-11-13', 6)));
    const w2 = S.walkStreak(map2, 'jobs', 1, TODAY, []);
    assert.deepStrictEqual(w2.usedOn, ['2026-11-11']);
    assert.strictEqual(w2.current, 6, 'the run restarts after the freezes run out');
    assert.strictEqual(w2.longest, 7);

    // Ending yesterday, today still open: nothing is spent.
    const w3 = S.walkStreak(mapOf(range(S, '2026-11-11', 8)), 'jobs', 1, TODAY, []);
    assert.deepStrictEqual(w3.usedOn, []);
    assert.strictEqual(w3.available, 1);
    assert.strictEqual(w3.current, 8);

    // A rest day never costs a freeze.
    const map4 = mapOf(range(S, '2026-11-08', 7).concat(['2026-11-16', '2026-11-17', '2026-11-18']));
    const w4 = S.walkStreak(map4, 'jobs', 1, TODAY, [0]);
    assert.deepStrictEqual(w4.usedOn, [], 'Sunday the 15th is a rest day');
    assert.strictEqual(w4.available, 1);
    assert.strictEqual(w4.current, 10);

    // Deterministic.
    assert.deepStrictEqual(S.walkStreak(map, 'jobs', 1, TODAY, []), S.walkStreak(map, 'jobs', 1, TODAY, []));
    // Below goal is a miss.
    const below = Object.assign(mapOf(range(S, '2026-11-11', 7), 3), { '2026-11-18': { jobs: 2 } });
    assert.strictEqual(S.walkStreak(below, 'jobs', 3, TODAY, []).usedOn[0], '2026-11-18');
    console.log('[PASS] Streak freezes are earned every 7 goal days, capped at 2, and spent only on missed past work days');
  }

  // 4. Week dots: every state, Monday to Sunday.
  {
    const map = { '2026-11-16': { jobs: 5 }, '2026-11-17': { jobs: 2 }, '2026-11-19': { jobs: 0 }, '2026-11-22': { jobs: 9 } };
    const dots = S.buildWeekDots(map, 'jobs', 5, TODAY, TODAY, [0], ['2026-11-18']);
    assert.strictEqual(dots.length, 7);
    assert.deepStrictEqual(dots.map(d => d.date), range(S, '2026-11-16', 7));
    assert.deepStrictEqual(dots.map(d => d.state), ['met', 'some', 'frozen', 'none', 'future', 'future', 'future']);
    assert.deepStrictEqual(dots.map(d => d.isToday), [false, false, false, true, false, false, false]);
    assert.strictEqual(dots[1].count, 2);
    assert.strictEqual(dots[0].goal, 5);
    const last = S.buildWeekDots({ '2026-11-14': { jobs: 6 } }, 'jobs', 5, '2026-11-12', TODAY, [0, 6], []);
    assert.deepStrictEqual(last.map(d => d.state), ['none', 'none', 'none', 'none', 'none', 'met', 'rest'], 'a met rest day shows met; an idle one shows rest');
    console.log('[PASS] Week dots cover met, some, none, rest, frozen, and future');
  }

  // 5. getStats wiring: rest days from prefs, freezes, goalMet, todayCount, restToday.
  {
    const today = S.getLocalDateStr();
    const yesterday = S.addDays(today, -1);
    await S.setMetricGoal('jobs', 1);
    await S.addLog({ metricId: 'jobs', date: S.addDays(today, -2) });
    await S.addLog({ metricId: 'jobs', date: today });
    let stats = await S.getStats();
    assert.strictEqual(stats.streaks.jobs, 1, 'yesterday is a missed work day');
    assert.deepStrictEqual(stats.freezes.jobs, { available: 0, usedOn: [] });
    assert.strictEqual(stats.goalMet.jobs, true);
    assert.strictEqual(stats.goalMet.leetcode, false);
    assert.strictEqual(stats.todayCount.jobs, 1);
    assert.strictEqual(stats.restToday, false);

    await S.setPrefs({ restDays: [S.parseLocalDateToNoon(yesterday).getDay()] });
    stats = await S.getStats();
    assert.strictEqual(stats.streaks.jobs, 2, 'yesterday is now a rest day');
    assert.strictEqual(stats.currentStreak, 2);

    await S.setPrefs({ restDays: [S.parseLocalDateToNoon(today).getDay()] });
    stats = await S.getStats();
    assert.strictEqual(stats.restToday, true);

    const dots = await S.getWeekDots('jobs');
    assert.strictEqual(dots.length, 7);
    assert.strictEqual(dots.filter(d => d.isToday).length, 1);
    assert.strictEqual(dots[0].date, S.weekStartOf(today));
    assert.ok(S.REMOTE_METHODS.includes('getWeekDots') && S.REMOTE_METHODS.includes('getMilestones') &&
      S.REMOTE_METHODS.includes('mergeSignedOutEntries'), 'log-reading methods are proxied for content scripts');
    console.log('[PASS] getStats and getWeekDots honor rest days and expose freezes, goalMet, todayCount, restToday');
  }
  cleanup();

  // 6. Preferences: new defaults and shape checks.
  {
    const { TrackerStorage } = fresh('local');
    const p = await TrackerStorage.getPrefs();
    assert.strictEqual(p.reminderEnabled, false, 'the daily reminder is off for new installs');
    assert.strictEqual(p.reminderTime, '14:30');
    assert.deepStrictEqual(p.focusAreas, []);
    assert.deepStrictEqual(p.restDays, []);
    assert.strictEqual(p.accent, 'coral');
    assert.strictEqual(p.coachVoice, 'coach');
    assert.deepStrictEqual(p.seenMilestones, {});
    assert.strictEqual(p.shareHideCompanies, true);
    assert.strictEqual(p.onboardingDone, false);
    assert.strictEqual(p.tipsOff, false);
    assert.strictEqual(p.comfortMode, false);
    assert.strictEqual(p.goingFor, '');
    const next = await TrackerStorage.setPrefs({ accent: 'neon', coachVoice: 'drill', restDays: { 0: 1 }, reminderTime: '25:00', focusAreas: ['jobs', 'bogus'] });
    assert.strictEqual(next.accent, 'coral', 'unknown accent ignored');
    assert.strictEqual(next.coachVoice, 'drill');
    assert.deepStrictEqual(next.restDays, [], 'an object is not a rest-day list');
    assert.strictEqual(next.reminderTime, '14:30');
    assert.deepStrictEqual(next.focusAreas, ['jobs']);
    (await TrackerStorage.getPrefs()).restDays.push(3);
    assert.deepStrictEqual((await TrackerStorage.getPrefs()).restDays, [], 'defaults are never shared by reference');
    console.log('[PASS] New preferences: defaults and validation');
    cleanup();
  }

  // 7. Milestones: thresholds, dates, next, first interview, seen.
  {
    const ms = S.buildMilestones({ '2026-11-01': { jobs: 4 }, '2026-11-02': { jobs: 7 }, '2026-11-03': { jobs: 1 } }, 'jobs', { unit: 'applications', seen: [1] });
    assert.deepStrictEqual(ms.reached.map(r => r.id), [1, 10]);
    assert.deepStrictEqual(ms.reached.map(r => r.date), ['2026-11-01', '2026-11-02']);
    assert.deepStrictEqual(ms.next, { count: 25, remaining: 13 });
    assert.deepStrictEqual(ms.unseen, [10]);
    assert.ok(ms.reached[1].title && ms.reached[1].body);
    const huge = S.buildMilestones({ '2026-01-01': { jobs: 1200 } }, 'jobs', {});
    assert.deepStrictEqual(huge.reached.map(r => r.count), S.MILESTONE_THRESHOLDS);
    assert.strictEqual(huge.next, null);

    for (const flavor of ['local', 'indexeddb']) {
      const { TrackerStorage } = fresh(flavor);
      let m = await TrackerStorage.getMilestones('jobs');
      assert.deepStrictEqual(m.reached, []);
      assert.deepStrictEqual(m.next, { count: 1, remaining: 1 });
      const log = await TrackerStorage.addLog({ metricId: 'jobs', count: 12, date: '2026-11-02' });
      m = await TrackerStorage.getMilestones('jobs');
      assert.deepStrictEqual(m.unseen, [1, 10]);
      assert.ok(m.reached[0].title.includes('application'), 'jobs milestones say applications: ' + m.reached[0].title);
      await TrackerStorage.setLogStatus(log.id, 'interviewing');
      m = await TrackerStorage.getMilestones('jobs');
      assert.ok(m.reached.some(r => r.id === 'first-interview'), 'an interview adds the first-interview milestone');
      assert.deepStrictEqual(m.unseen, [1, 10, 'first-interview']);
      await TrackerStorage.markMilestonesSeen('jobs', [1, 10]);
      await TrackerStorage.markMilestonesSeen('jobs', [10, 'first-interview', 'junk']);
      m = await TrackerStorage.getMilestones('jobs');
      assert.deepStrictEqual(m.unseen, []);
      assert.deepStrictEqual((await TrackerStorage.getPrefs()).seenMilestones, { jobs: [1, 10, 'first-interview'] });
      const lc = await TrackerStorage.getMilestones('leetcode');
      assert.ok(!lc.reached.some(r => r.id === 'first-interview'));
      cleanup();
    }
    console.log('[PASS] Milestones: thresholds, dates, next target, first interview, and seen tracking');
  }

  // 8. Focus areas hide unpicked starter trackers, never delete, never hide jobs.
  {
    const { TrackerStorage } = fresh('local');
    const custom = await TrackerStorage.addMetric({ name: 'Gym', unit: 'sessions' });
    await TrackerStorage.addLog({ metricId: 'leetcode', date: '2026-11-10' });
    let metrics = await TrackerStorage.setFocusAreas(['jobs', 'networking', 'bogus']);
    const byArea = a => metrics.filter(m => m.id === a || m.focusArea === a);
    assert.strictEqual(byArea('networking').length, 1);
    const net = byArea('networking')[0];
    assert.strictEqual(net.name, 'Networking chats');
    assert.strictEqual(net.unit, 'chats');
    assert.strictEqual(net.hidden, false);
    assert.strictEqual(byArea('leetcode')[0].hidden, true, 'LeetCode is hidden, not deleted');
    assert.strictEqual(byArea('jobs')[0].hidden, false);
    assert.strictEqual(metrics.find(m => m.id === custom.id).hidden, false, 'hand-made trackers are left alone');
    assert.deepStrictEqual((await TrackerStorage.getPrefs()).focusAreas, ['jobs', 'networking']);

    metrics = await TrackerStorage.setFocusAreas(['jobs', 'networking']);
    assert.strictEqual(byArea('networking').length, 1, 'running it again creates nothing new');

    metrics = await TrackerStorage.setFocusAreas([]);
    assert.strictEqual(byArea('jobs')[0].hidden, false, 'jobs is never hidden');
    assert.strictEqual(byArea('networking')[0].hidden, true);

    metrics = await TrackerStorage.setFocusAreas(['leetcode', 'outreach']);
    assert.strictEqual(byArea('leetcode')[0].hidden, false, 'picking it again shows it');
    assert.strictEqual(byArea('networking')[0].hidden, true);
    assert.strictEqual(byArea('outreach')[0].unit, 'emails');
    assert.strictEqual((await TrackerStorage.getLogs({ metricId: 'leetcode' })).length, 1, 'data is untouched');
    assert.ok(metrics.every(m => typeof m.hidden === 'boolean'));

    // Another account sees its own starter trackers, not this one's.
    const other = await TrackerStorage.setFocusAreas(['networking'], 'b@example.com');
    assert.strictEqual(other.filter(m => m.focusArea === 'networking').length, 1);
    assert.notStrictEqual(other.find(m => m.focusArea === 'networking').id, net.id);
    console.log('[PASS] setFocusAreas creates, hides, and shows starter trackers without deleting anything');
    cleanup();
  }

  // 9. Merging signed-out entries is dedupe-safe and idempotent (both backends).
  for (const flavor of ['local', 'indexeddb']) {
    const { TrackerStorage } = fresh(flavor);
    const email = 'a@example.com';
    const looseMetric = await TrackerStorage.addMetric({ name: 'Coffee chats' }, null);
    await TrackerStorage.addLog({ metricId: 'jobs', date: '2026-11-10', sourceId: 'gh:123', company: 'Acme' }, email);
    await TrackerStorage.addLog({ metricId: 'jobs', date: '2026-11-10', sourceId: 'gh:123', company: 'Acme' }, null);
    await TrackerStorage.addLog({ metricId: 'jobs', date: '2026-11-11', company: 'Beta' }, null);
    await TrackerStorage.addLog({ metricId: 'jobs', date: '2026-11-11', company: 'Beta' }, null);
    await TrackerStorage.addLog({ metricId: looseMetric.id, date: '2026-11-12', count: 2 }, null);
    await TrackerStorage.addLog({ metricId: 'jobs', date: '2026-11-12' }, 'someone@else.com');

    assert.deepStrictEqual(await TrackerStorage.mergeSignedOutEntries(null), { moved: 0, duplicates: 0, metricsMoved: 0 });
    const r1 = await TrackerStorage.mergeSignedOutEntries(' A@Example.com ');
    assert.strictEqual(r1.moved, 3, 'two repeat Beta entries and the custom entry move (repeats are kept)');
    assert.strictEqual(r1.duplicates, 1, 'the same listing on the same day is not counted twice');
    assert.strictEqual(r1.metricsMoved, 1);
    assert.strictEqual((await TrackerStorage.getLogs({}, null)).length, 0, 'nothing is left signed out');
    const mine = await TrackerStorage.getLogs({}, email);
    assert.strictEqual(mine.length, 4);
    assert.ok(mine.every(l => l.userEmail === email));
    assert.strictEqual((await TrackerStorage.getLogs({}, 'someone@else.com')).length, 1, 'other accounts are untouched');
    const stats = await TrackerStorage.getStats(email);
    assert.strictEqual(stats.totals.jobs, 3, 'aggregates moved with the entries');
    assert.strictEqual(stats.totals[looseMetric.id], 2);
    assert.ok((await TrackerStorage.getMetrics(email)).some(m => m.id === looseMetric.id), 'the custom tracker followed its entries');
    const signedOutStats = await TrackerStorage.getStats(null);
    assert.strictEqual(signedOutStats.totalLogs, 0);

    const r2 = await TrackerStorage.mergeSignedOutEntries(email);
    assert.deepStrictEqual(r2, { moved: 0, duplicates: 0, metricsMoved: 0 }, 'a second run is a no-op');
    assert.strictEqual((await TrackerStorage.getLogs({}, email)).length, 4);
    cleanup();
  }
  console.log('[PASS] mergeSignedOutEntries moves signed-out work once, keeps repeats, folds same-listing duplicates');

  // 10. LitCopy: contract lines, three voices, no emoji, no shaming words.
  {
    delete require.cache[require.resolve('../shared/coach-copy')];
    const C = require('../shared/coach-copy');
    assert.strictEqual(C.headline({ count: 0, goal: 5, voice: 'coach' }), 'Ready when you are');
    assert.strictEqual(C.headline({ count: 3, goal: 5, voice: 'coach' }), 'Nice, that\'s 3. Two more locks it in.');
    assert.strictEqual(C.headline({ count: 5, goal: 5, voice: 'coach' }), 'Locked in for today.');
    assert.strictEqual(C.streak({ days: 0 }), 'Fresh start today');
    assert.strictEqual(C.streak({ days: 6 }), 'Day 6. Keep it rolling.');
    assert.strictEqual(C.rejection('coach'), 'Every no is a rep. You\'re still in it.');
    assert.deepStrictEqual(C.milestone(50, 'applications'), { title: '50 applications', body: 'Most offers take dozens; you\'re on your way.' });
    assert.strictEqual(C.milestone(1, 'jobs').title, 'Your first application is in');
    assert.strictEqual(C.gentleGoal({ missedDays: 2, goal: 5 }), null);
    assert.strictEqual(C.gentleGoal({ missedDays: 3, goal: 1 }), null);
    assert.ok(/goal of 3/.test(C.gentleGoal({ missedDays: 3, goal: 5 })));
    const t = C.toast({ count: 5, goal: 5, unit: 'jobs', voice: 'coach', streak: 4 });
    assert.ok(t.title && t.sub && /Day 4/.test(t.sub));
    assert.ok(Array.isArray(C.tips) && C.tips.length >= 8);
    ['Alt+Shift+A', 'Alt+Shift+J', 'Alt+Shift+F', 'Calendar', 'rest day', 'Drag', 'autofill profile']
      .forEach(k => assert.ok(C.tips.some(tip => tip.toLowerCase().includes(k.toLowerCase())), 'a tip covers ' + k));
    assert.strictEqual(C.tipFor('2026-11-19'), C.tipFor('2026-11-19'));
    const down = C.weekStory({ total: 4, bestDay: { date: '2026-11-17', count: 2 }, activeDays: 2, lastWeekTotal: 20 });
    assert.ok(!/(fewer|less|down|drop|decline|behind)/i.test(down), 'a slower week never reports a decline: ' + down);
    const up = C.weekStory({ total: 12, bestDay: '2026-11-17', activeDays: 5, lastWeekTotal: 9 });
    assert.ok(/3 more than last week/.test(up) && /Tuesday/.test(up));
    assert.ok(up.split(/(?<=\.)\s/).length <= 3);

    const out = [];
    const push = v => {
      if (v === null || v === undefined) return;
      if (typeof v === 'string') out.push(v);
      else if (typeof v === 'object') Object.keys(v).forEach(k => push(v[k]));
    };
    const units = ['jobs', 'applications', 'problems', 'chats', 'emails', 'sessions', 'pieces', undefined];
    for (const voice of ['gentle', 'coach', 'drill', 'unknown']) {
      for (let goal = 0; goal <= 6; goal++) {
        for (let count = 0; count <= 9; count++) {
          push(C.headline({ count, goal, voice }));
          push(C.reminder({ count, goal, voice }));
          units.forEach(unit => push(C.toast({ count, goal, unit, label: 'X', voice, firstOfDay: count === 1, streak: count })));
        }
      }
      for (let days = 0; days <= 40; days++) {
        push(C.streak({ days, voice }));
        push(C.streak({ days, voice, restToday: true }));
        push(C.streak({ days, voice, freezeUsed: true }));
      }
      push(C.rejection(voice));
    }
    [1, 10, 25, 50, 100, 250, 500, 1000, 7].forEach(n => units.forEach(u => push(C.milestone(n, u))));
    push(C.firstInterview());
    [0, 1, 5].forEach(total => [0, 3, 10].forEach(last => push(C.weekStory({ total, bestDay: null, activeDays: total ? 1 : 0, lastWeekTotal: last }))));
    ['logs', 'applications', 'chart', 'search', 'other'].forEach(k => push(C.empty(k)));
    push(C.tips);
    for (let m = 0; m < 10; m++) push(C.gentleGoal({ missedDays: m, goal: 6 }));
    assert.ok(out.length > 1000);
    out.forEach(s => {
      assert.ok(!EMOJI.test(s), 'emoji in copy: ' + s);
      assert.ok(!/failed|fail\b|(^|[^\d])0-day|(^|[^\d])0 day|\b(lazy|pathetic|excuses?|loser)\b/i.test(s), 'shaming copy: ' + s);
      assert.ok(!/\b(entries|entry|logs)\b/i.test(s) || /logged/.test(s), 'say applications, not entries: ' + s);
      assert.ok(!/undefined|NaN|null/.test(s), 'template leak: ' + s);
    });
    console.log('[PASS] LitCopy: contract lines, three voices, ' + out.length + ' strings with no emoji or shaming words');
  }

  // 11. LitShareCard: every template and theme draws, brands itself, and
  //     never draws anything it was not given (no company names).
  {
    delete require.cache[require.resolve('../shared/share-card')];
    const Card = require('../shared/share-card');
    const texts = [];
    const ctx = new Proxy({ font: '10px sans-serif' }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'fillText') return text => texts.push(String(text));
        if (prop === 'measureText') {
          return text => {
            const size = parseInt(String(target.font).match(/(\d+)px/)[1], 10);
            return { width: String(text).length * size * 0.55 };
          };
        }
        return () => {};
      },
      set(target, prop, value) { target[prop] = value; return true; }
    });
    const dots = S.buildWeekDots({ '2026-11-16': { jobs: 5 } }, 'jobs', 5, TODAY, TODAY, [0], ['2026-11-18']);
    for (const template of ['minimal', 'bold', 'stats', 'nonsense']) {
      for (const theme of ['light', 'dark']) {
        texts.length = 0;
        const d = Card.draw(ctx, {
          template, theme, accent: 'ocean', bigNumber: 1234, bigLabel: 'applications sent',
          streak: 9, weekDots: dots, goingFor: 'Product designer at a fintech', milestoneTitle: '100 applications',
          company: 'Acme Secret Corp', companies: ['Acme Secret Corp'], logs: [{ company: 'Acme Secret Corp' }]
        });
        assert.ok(texts.includes('Tracked with LIT'), template + '/' + theme + ' draws the brand line');
        assert.ok(texts.includes('1,234'));
        assert.ok(texts.some(s => s.includes('9 day streak')));
        assert.ok(texts.some(s => s.includes('Product designer at a fintech')));
        assert.ok(!texts.some(s => /Acme/.test(s)), 'no company names on the card');
        assert.strictEqual(d.accent, theme === 'dark' ? '#5FA3C7' : '#3B7EA1');
      }
    }
    assert.strictEqual(Card.normalize({}).template, 'minimal');
    assert.strictEqual(Card.WIDTH, 1200);
    assert.strictEqual(Card.HEIGHT, 627);
    assert.strictEqual(await Card.copy(null), false, 'copy reports false when it cannot copy');
    assert.strictEqual(Card.download(null, 'x.png'), false);
    await assert.rejects(Card.render({}), /canvas/, 'render explains itself without a canvas');
    console.log('[PASS] LitShareCard: three templates, light and dark, brand line, no company names');
  }

  console.log('--- test/progress.test.js COMPLETED SUCCESSFULLY ---');
}

module.exports = { run };

if (require.main === module) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
