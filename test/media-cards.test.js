// Tests for popup/modules/media-cards.js: the pure helpers behind the poster
// row, top 10, spotlight, and up next cards, plus load-time registration
// through the popup bridge.
const assert = require('assert');
const path = require('path');

function fresh(rel) {
  const file = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

function forget(rel) {
  delete require.cache[require.resolve(path.join(__dirname, '..', rel))];
}

const TODAY = '2026-11-20';

async function run() {
  console.log('--- Running test/media-cards.test.js ---');

  // Loads in node with no DOM and no LitPopup, and registers nothing.
  const hadLit = typeof global.LitPopup !== 'undefined';
  assert.strictEqual(hadLit, false, 'no LitPopup in node by default');
  const M = fresh('popup/modules/media-cards.js');
  assert.strictEqual(typeof M.stageProgress, 'function');
  assert.strictEqual(typeof M.buildUpNext, 'function');
  console.log('[PASS] Module loads headlessly and exports its helpers');

  // Stage progress: Applied, Under review, Interviewing, Offer; Closed muted.
  {
    assert.deepStrictEqual(['applied', 'review', 'interviewing', 'offer'].map(s => M.stageProgress(s).pct), [25, 50, 75, 100]);
    assert.strictEqual(M.stageProgress('Under Review').id, 'review', 'aliases normalize');
    assert.strictEqual(M.stageProgress('interview').id, 'interviewing');
    assert.strictEqual(M.stageProgress(undefined).id, 'applied', 'missing status reads as Applied');
    const closed = M.stageProgress('rejected');
    assert.strictEqual(closed.muted, true);
    assert.strictEqual(closed.label, 'Closed');
    assert.ok(!/reject|fail/i.test(closed.note), 'closed is framed kindly');
    assert.strictEqual(M.stageProgress('declined').id, 'rejected');
    assert.strictEqual(M.nextStage('applied'), 'review');
    assert.strictEqual(M.nextStage('review'), 'interviewing');
    assert.strictEqual(M.nextStage('interviewing'), 'offer');
    assert.strictEqual(M.nextStage('offer'), null);
    assert.strictEqual(M.nextStage('rejected'), null);
    console.log('[PASS] Stage progress mapping and next stage');
  }

  // Dates and "Applied 5 days ago".
  {
    assert.strictEqual(M.daysBetween('2026-11-15', TODAY), 5);
    assert.strictEqual(M.daysBetween('2026-10-31', '2026-11-01'), 1, 'month boundary');
    assert.strictEqual(M.daysBetween('2026-03-07', '2026-03-09'), 2, 'DST weekend is still two days');
    assert.ok(Number.isNaN(M.daysBetween('nope', TODAY)));
    assert.strictEqual(M.appliedAgo(0), 'Applied today');
    assert.strictEqual(M.appliedAgo(1), 'Applied yesterday');
    assert.strictEqual(M.appliedAgo(5), 'Applied 5 days ago');
    assert.strictEqual(M.appliedAgo(21), 'Applied 3 weeks ago');
    assert.strictEqual(M.appliedAgo(90), 'Applied 3 months ago');
    assert.strictEqual(M.appliedAgo(null), 'Applied');
    assert.strictEqual(M.appliedAgo(-3), 'Applied today', 'future dates clamp');
    console.log('[PASS] Day math and applied-ago copy');
  }

  // Follow-up detection.
  {
    const base = { id: 'a1', company: 'Acme', status: 'applied', date: '2026-11-13' };
    assert.strictEqual(M.needsFollowUp(base, TODAY, {}), true, '7 days in Applied');
    assert.strictEqual(M.needsFollowUp(Object.assign({}, base, { date: '2026-11-14' }), TODAY, {}), false, '6 days is too soon');
    assert.strictEqual(M.needsFollowUp(base, TODAY, { a1: '2026-11-19' }), false, 'followed up clears it');
    assert.strictEqual(M.needsFollowUp(Object.assign({}, base, { status: 'review' }), TODAY, {}), false, 'only Applied');
    assert.strictEqual(M.needsFollowUp(Object.assign({}, base, { company: '', role: '' }), TODAY, {}), false, 'needs a name');
    assert.strictEqual(M.needsFollowUp(Object.assign({}, base, { company: '', role: 'Designer' }), TODAY, {}), true, 'a role is enough');
    assert.strictEqual(M.needsFollowUp(Object.assign({}, base, { date: 'bad' }), TODAY, {}), false);
    assert.strictEqual(M.needsFollowUp(null, TODAY, {}), false);
    console.log('[PASS] Follow-up detection');
  }

  // Monograms and deterministic gradients.
  {
    assert.strictEqual(M.monogramFor('Goldman Sachs'), 'GS');
    assert.strictEqual(M.monogramFor('Stripe'), 'S');
    assert.strictEqual(M.monogramFor('IBM'), 'IBM');
    assert.strictEqual(M.monogramFor('The Acme Co'), 'A');
    assert.strictEqual(M.monogramFor('Societe Generale'), 'SG');
    assert.strictEqual(M.monogramFor('Ecole Polytechnique'.normalize('NFC')), 'EP');
    assert.strictEqual(M.monogramFor(''), '');
    assert.strictEqual(M.monogramFor('  '), '');
    assert.strictEqual(M.hashString('acme'), M.hashString('acme'), 'stable hash');
    assert.notStrictEqual(M.hashString('acme'), M.hashString('acne'));
    const a = M.posterArt('Acme');
    assert.deepStrictEqual(a, M.posterArt('  ACME '), 'case and spacing do not change the art');
    ['Acme', 'Stripe', 'Initech', '', 'x'].forEach(n => {
      const art = M.posterArt(n);
      assert.ok(art.hue >= 0 && art.hue < 360 && art.hue2 >= 0 && art.hue2 < 360);
      assert.ok(art.angle >= 110 && art.angle < 190);
      assert.notStrictEqual(art.hue, art.hue2, 'two distinct hues');
    });
    console.log('[PASS] Monograms and poster gradients');
  }

  // Ranking: days this month, companies, role words.
  {
    const dailyMap = {
      '2026-11-02': { jobs: 3, leetcode: 9 },
      '2026-11-05': { jobs: 5 },
      '2026-11-09': { jobs: 3 },
      '2026-11-20': { jobs: 1 },
      '2026-11-21': { jobs: 50 },
      '2026-10-31': { jobs: 40 },
      'junk': { jobs: 99 }
    };
    const days = M.rankDays(dailyMap, 'jobs', TODAY);
    assert.deepStrictEqual(days.map(d => d.key), ['2026-11-05', '2026-11-09', '2026-11-02', '2026-11-20'], 'this month only, best first, ties to the newer day, no future days');
    assert.deepStrictEqual(days.map(d => d.rank), [1, 2, 3, 4]);
    assert.strictEqual(M.rankDays(dailyMap, 'leetcode', TODAY)[0].value, 9, 'per goal');
    const many = {};
    for (let d = 1; d <= 15; d++) many['2026-11-' + String(d).padStart(2, '0')] = { jobs: d };
    assert.strictEqual(M.rankDays(many, 'jobs', TODAY).length, 10, 'top 10 only');
    assert.deepStrictEqual(M.rankDays({}, 'jobs', TODAY), []);
    assert.deepStrictEqual(M.rankDays(undefined, 'jobs', TODAY), []);

    const logs = [
      { company: 'Initech', role: 'Senior Software Engineer' },
      { company: 'Acme, Inc.', role: 'Software Engineer II', count: 2 },
      { company: 'Globex', role: 'QA Engineer (Remote)' },
      { company: 'acme', role: 'Product Designer' },
      { company: 'Initech', role: 'software engineer' },
      { company: '', role: 'UX Researcher' }
    ];
    const keyFn = name => String(name).toLowerCase().replace(/,?\s*inc\.?$/, '').trim();
    const cos = M.rankCompanies(logs, 10, keyFn);
    assert.deepStrictEqual(cos.map(c => [c.label, c.value]), [['Acme, Inc.', 3], ['Initech', 2], ['Globex', 1]], 'merged by key, weighted by count, newest spelling, ties to the more recent');
    const builtIn = M.rankCompanies([{ company: 'Acme Inc' }, { company: 'ACME' }, { company: 'The Acme Company' }]);
    assert.strictEqual(builtIn.length, 1, 'the built-in key merges company noise words');
    assert.strictEqual(builtIn[0].value, 3);

    const roles = M.rankRoles(logs);
    const byKey = Object.fromEntries(roles.map(r => [r.key, r]));
    assert.strictEqual(roles[0].label, 'Engineer');
    assert.strictEqual(byKey.engineer.value, 5, 'weighted by count');
    assert.strictEqual(byKey.software.value, 4);
    assert.ok(!byKey.ii && !byKey.remote, 'filler words are dropped');
    assert.strictEqual(byKey.qa.label, 'QA', 'short acronyms keep their casing');
    assert.strictEqual(byKey.ux.label, 'UX');
    assert.deepStrictEqual(M.roleWords('Engineer, Engineer & engineer').map(w => w.key), ['engineer'], 'a word counts once per role');
    assert.deepStrictEqual(M.rankRoles([]), []);

    assert.deepStrictEqual(M.rankModesFor('jobs'), ['days', 'companies', 'roles']);
    assert.deepStrictEqual(M.rankModesFor('leetcode'), ['days'], 'companies and roles are for applications');
    assert.strictEqual(M.effectiveRank('companies', 'leetcode'), 'days');
    assert.strictEqual(M.effectiveRank('roles', 'jobs'), 'roles');
    assert.strictEqual(M.effectiveRank(undefined, 'jobs'), 'days');
    assert.strictEqual(M.rankItems('companies', { logs, keyFn })[0].label, 'Acme, Inc.');
    assert.strictEqual(M.rankItems('days', { dailyMap, metricId: 'jobs', todayStr: TODAY })[0].key, '2026-11-05');

    const out = { metricId: 'active', rankBy: 'stale' };
    M.normalizeTop10({ rankBy: 'days' }, out);
    assert.ok(!('rankBy' in out), 'the default mode is not stored');
    M.normalizeTop10({ rankBy: 'roles' }, out);
    assert.strictEqual(out.rankBy, 'roles');
    M.normalizeTop10({ rankBy: 'bogus' }, out);
    assert.ok(!('rankBy' in out));
    console.log('[PASS] Top 10 ranking for days, companies, and roles');
  }

  // Continue row tiles.
  {
    const logs = [
      { id: 'q1', date: TODAY },
      { id: 'r1', company: 'Hooli', role: 'PM', status: 'rejected', date: '2026-11-18' },
      { id: 'n1', company: 'Acme', role: 'Engineer', status: 'applied', date: '2026-11-15' },
      { id: 'n2', company: 'Initech', status: 'interviewing', date: '2026-11-01' },
      { id: 'n3', role: 'Designer', status: 'applied', date: '2026-11-10' }
    ];
    const tiles = M.continueTiles(logs, TODAY, {});
    assert.deepStrictEqual(tiles.map(t => t.id), ['n1', 'n2', 'n3', 'r1'], 'named only, closed last');
    const acme = tiles[0];
    assert.strictEqual(acme.title, 'Acme');
    assert.strictEqual(acme.role, 'Engineer');
    assert.strictEqual(acme.ago, 'Applied 5 days ago');
    assert.strictEqual(acme.stage.pct, 25);
    assert.strictEqual(acme.next, 'review');
    assert.strictEqual(acme.followUp, false);
    assert.strictEqual(acme.art.mono, 'A');
    assert.strictEqual(tiles[2].title, 'Designer', 'role stands in for a missing company');
    assert.strictEqual(tiles[2].role, '');
    assert.strictEqual(tiles[2].followUp, true, '10 days in Applied');
    assert.strictEqual(M.continueTiles(logs, TODAY, { n3: TODAY })[2].followUp, false);
    assert.strictEqual(M.continueTiles(logs, TODAY, { n3: TODAY })[2].followedUp, true);
    assert.strictEqual(tiles[3].stage.muted, true);
    const unnamed = M.continueTiles([{ id: 'q1', date: TODAY }, { id: 'q2', date: TODAY }], TODAY, {});
    assert.strictEqual(unnamed.length, 2, 'unnamed entries fill the row when nothing has a name');
    assert.strictEqual(unnamed[0].unnamed, true);
    assert.strictEqual(unnamed[0].title, 'Application');
    const lots = Array.from({ length: 30 }, (_, i) => ({ id: 'x' + i, company: 'Co ' + i, date: TODAY }));
    assert.strictEqual(M.continueTiles(lots, TODAY, {}).length, 12, 'row caps at 12');
    assert.deepStrictEqual(M.continueTiles(null, TODAY, {}), []);

    const due = M.followUpsDue(logs.concat([{ id: 'old', company: 'Umbrella', date: '2026-10-01' }]), TODAY, {});
    assert.deepStrictEqual(due.map(d => d.id), ['old', 'n3'], 'longest wait first');
    assert.strictEqual(due[0].title, 'Umbrella');
    console.log('[PASS] Continue row tiles and follow-ups due');
  }

  // Watchlist picks.
  {
    const watch = [{ id: 'w1', name: 'Acme' }, { id: 'w2', name: 'Globex' }, { id: 'w3', name: 'Hooli', done: true }, { id: 'w4', name: 'Initech' }];
    const logs = [{ company: 'ACME Inc.' }];
    const c = M.watchCandidates(watch, logs);
    assert.deepStrictEqual(c.map(w => w.id), ['w2', 'w4'], 'applied and checked-off companies drop out');
    const pick = M.pickOfTheDay(c, TODAY);
    assert.strictEqual(M.pickOfTheDay(c, TODAY), pick, 'same pick all day');
    const seen = new Set();
    for (let d = 1; d <= 20; d++) seen.add(M.pickOfTheDay(c, '2026-11-' + String(d).padStart(2, '0')).id);
    assert.strictEqual(seen.size, 2, 'picks rotate across days');
    assert.strictEqual(M.pickOfTheDay([], TODAY), null);
    assert.deepStrictEqual(M.watchCandidates(undefined, undefined), []);
    console.log('[PASS] Watchlist candidates and today\'s pick');
  }

  // Up next queue.
  {
    const goals = [
      { id: 'jobs', name: 'Applications', today: 2, goal: 5, met: false },
      { id: 'leetcode', name: 'LeetCode', today: 3, goal: 3, met: true },
      { id: 'walk', name: 'Walks', today: 0, goal: 1, met: false }
    ];
    const logs = [
      { id: 'a', company: 'Acme', role: 'Engineer', status: 'applied', date: '2026-11-01' },
      { id: 'b', company: 'Globex', status: 'applied', date: TODAY }
    ];
    const watchlist = [{ id: 'w1', name: 'Initech' }, { id: 'w2', name: 'Acme' }];
    const q = M.buildUpNext({ goals, logs, followups: {}, watchlist, todayStr: TODAY });
    assert.deepStrictEqual(q.items.map(i => i.key), ['goal:jobs', 'goal:walk', 'fu:a', 'w:w1']);
    assert.strictEqual(q.items[0].sub, '2 of 5 today · 3 to go');
    assert.strictEqual(q.items[1].sub, 'Fresh start today · 1 to go');
    assert.strictEqual(q.items[2].title, 'Follow up with Acme');
    assert.strictEqual(q.items[2].name, 'Acme');
    assert.strictEqual(q.items[2].sub, 'Applied 3 weeks ago · Engineer');
    assert.strictEqual(q.items[3].company, 'Initech');
    assert.strictEqual(q.items[3].action, 'applied');
    assert.strictEqual(q.more, 0);

    const rest = M.buildUpNext({ goals, logs, followups: { a: TODAY }, watchlist: [], todayStr: TODAY, restToday: true });
    assert.deepStrictEqual(rest.items, [], 'rest day and nothing waiting is all caught up');
    assert.strictEqual(rest.total, 0);

    const capped = M.buildUpNext({ goals, logs, followups: {}, watchlist, todayStr: TODAY, limit: 2 });
    assert.strictEqual(capped.items.length, 2);
    assert.strictEqual(capped.more, 2);
    assert.strictEqual(M.buildUpNext({}).total, 0, 'empty input is safe');
    console.log('[PASS] Up next queue');
  }

  // Spotlight slides.
  {
    const base = {
      isJobs: true, unitMany: 'applications', logLabel: 'Log application',
      today: 2, goal: 5, met: false, streak: 4, restToday: false,
      next: { count: 25, remaining: 3 }, prevMilestone: 10,
      pick: { name: 'Initech' }, watchCount: 2,
      record: { date: '2026-11-05', count: 6, label: 'Thu, Nov 5' }, todayStr: TODAY
    };
    const s = M.spotlightSlides(base);
    assert.deepStrictEqual(s.map(x => x.id), ['milestone', 'pick', 'streak', 'record']);
    assert.strictEqual(s[0].headline, '25 applications');
    assert.strictEqual(s[0].pct, 80, '12 of the 15 between 10 and 25');
    assert.strictEqual(s[1].headline, 'Initech');
    assert.deepStrictEqual(s[1].cta, { kind: 'applied', label: 'I applied', company: 'Initech' });
    assert.strictEqual(s[2].headline, '4-day streak');
    assert.strictEqual(s[2].line, '3 more today keeps it going.');
    assert.strictEqual(s[2].cta.kind, 'log');
    assert.ok(s[3].line.startsWith('Thu, Nov 5.'));
    s.forEach(x => assert.ok(x.cta && x.cta.label, 'every slide has one primary action'));

    const met = M.spotlightSlides(Object.assign({}, base, { met: true, today: 5 }));
    assert.strictEqual(met.find(x => x.id === 'streak').cta.kind, 'share');
    const noWatch = M.spotlightSlides(Object.assign({}, base, { pick: null, watchCount: 0 }));
    assert.deepStrictEqual(noWatch[1].cta, { kind: 'watchlist', label: 'Add companies' });
    const allDone = M.spotlightSlides(Object.assign({}, base, { pick: null, watchCount: 3 }));
    assert.strictEqual(allDone[1].headline, 'Your list is all done');
    const other = M.spotlightSlides(Object.assign({}, base, { isJobs: false, unitMany: 'problems', logLabel: 'Log problem' }));
    assert.ok(!other.some(x => x.id === 'pick'), 'no watchlist pick outside applications');
    const fresh0 = M.spotlightSlides({ streak: 0, today: 0, goal: 3, todayStr: TODAY });
    assert.deepStrictEqual(fresh0.map(x => x.id), ['streak'], 'brand new: one encouraging slide');
    assert.strictEqual(fresh0[0].headline, 'Fresh start');
    const smallRecord = M.spotlightSlides(Object.assign({}, base, { record: { date: '2026-11-01', count: 1 } }));
    assert.ok(!smallRecord.some(x => x.id === 'record'), 'a record of one is not worth a slide');
    const todayRecord = M.spotlightSlides(Object.assign({}, base, { record: { date: TODAY, count: 6 } }));
    assert.strictEqual(todayRecord.find(x => x.id === 'record').line, 'That is today. What a day.');
    const rest = M.spotlightSlides(Object.assign({}, base, { restToday: true }));
    assert.strictEqual(rest.find(x => x.id === 'streak').line, 'Rest day today. Your streak is safe.');
    const done = M.spotlightSlides(Object.assign({}, base, { next: null }));
    assert.ok(!done.some(x => x.id === 'milestone'), 'no milestone slide once every milestone is reached');

    assert.strictEqual(M.slideIndexFor(s, 'streak', 0), 2, 'stays on the same slide when the list changes');
    assert.strictEqual(M.slideIndexFor(s, 'gone', 9), 3, 'clamps when the slide went away');
    assert.strictEqual(M.slideIndexFor([], 'x', 4), 0);
    console.log('[PASS] Spotlight slide selection');
  }

  // Follow-up map stays small.
  {
    const map = { a: TODAY, b: '2026-01-01', c: 'not a date', d: '2026-11-01' };
    assert.deepStrictEqual(M.pruneFollowups(map, TODAY), { a: TODAY, d: '2026-11-01' });
    const big = {};
    for (let i = 0; i < 20; i++) big['id' + i] = '2026-11-' + String(i + 1).padStart(2, '0');
    const kept = M.pruneFollowups(big, TODAY, 180, 5);
    assert.deepStrictEqual(Object.keys(kept).sort(), ['id15', 'id16', 'id17', 'id18', 'id19'], 'newest kept');
    assert.deepStrictEqual(M.pruneFollowups(null, TODAY), {});
    assert.deepStrictEqual(M.pruneFollowups([1, 2], TODAY), {});
    console.log('[PASS] Follow-up map pruning');
  }

  // Load-time registration through the bridge, with a minimal DOM stand-in.
  {
    const W = fresh('shared/widgets.js');
    global.WidgetLayout = W;
    const B = fresh('popup/bridge.js');
    global.LitPopup = B;
    const hadDoc = 'document' in global;
    const hadWin = 'window' in global;
    global.document = { addEventListener() {} };
    global.window = {};
    try {
      fresh('popup/modules/media-cards.js');
      ['continueRow', 'top10', 'spotlight', 'upNext'].forEach(type => {
        assert.ok(W.TYPES[type], type + ' registered');
        assert.strictEqual(typeof B.renderer(type), 'function', type + ' has a renderer');
      });
      const avail = W.availableTypes([]);
      ['continueRow', 'top10', 'spotlight', 'upNext'].forEach(type => {
        assert.ok(avail.find(t => t.type === type && t.isNew), type + ' is offered as New');
      });
      assert.strictEqual(W.TYPES.continueRow.jobsOnly, true);
      assert.strictEqual(W.isVisible({ type: 'continueRow', options: {} }, 'jobs'), true);
      assert.strictEqual(W.isVisible({ type: 'continueRow', options: {} }, 'leetcode'), false);
      assert.deepStrictEqual(W.normalizeOptions('top10', { rankBy: 'companies' }), { metricId: 'active', rankBy: 'companies', size: 'expanded', collapsed: false });
      assert.deepStrictEqual(W.normalizeOptions('top10', { rankBy: 'days' }), { metricId: 'active', size: 'expanded', collapsed: false }, 'sparse');
      assert.deepStrictEqual(W.normalizeOptions('spotlight', {}), { metricId: 'active', size: 'expanded', collapsed: false });
      assert.deepStrictEqual(W.normalizeOptions('upNext', { size: 'compact' }), { size: 'compact', collapsed: false });
      const row = B.settingRows.find(r => r.id === 'media-cards');
      assert.ok(row, 'adds an on/off switch to Settings > Extras');
      assert.strictEqual(row.get(), true, 'on by default');
    } finally {
      if (hadDoc) { /* left as found */ } else delete global.document;
      if (hadWin) { /* left as found */ } else delete global.window;
      delete global.LitPopup;
      delete global.WidgetLayout;
      forget('popup/modules/media-cards.js');
      forget('popup/bridge.js');
      forget('shared/widgets.js');
    }
    console.log('[PASS] Card types register at load time with a settings switch');
  }

  console.log('--- test/media-cards.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => { console.error('Test failed:', err); process.exit(1); });
}

module.exports = { run };
