// Tests for popup/modules/stories.js: story data per ring, the month in
// review math, seen/unseen hashing, and the slide timer state machine. The
// module must load in node without a DOM.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function fresh(rel) {
  const file = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(file)];
  return require(file);
}

const TODAY = '2026-11-20'; // a Friday

// Applications by day. Goal 5. This week (Mon Nov 16 to today): 3, 5, 2, 0, 4.
const MAP = {
  '2026-10-15': { jobs: 2 },
  '2026-11-03': { jobs: 6 },
  '2026-11-04': { jobs: 5 },
  '2026-11-05': { jobs: 5 },
  '2026-11-10': { jobs: 2 },
  '2026-11-12': { jobs: 1 },
  '2026-11-16': { jobs: 3 },
  '2026-11-17': { jobs: 5 },
  '2026-11-18': { jobs: 2 },
  '2026-11-19': { leetcode: 1 },
  '2026-11-20': { jobs: 4, leetcode: 2 }
};

const JOBS = [
  { id: 'a', metricId: 'jobs', date: '2026-11-20', company: 'Acme Corp', status: 'applied', timestamp: '2026-11-20T10:00:00Z' },
  { id: 'b', metricId: 'jobs', date: '2026-11-18', company: 'acme', status: 'interviewing' },
  { id: 'c', metricId: 'jobs', date: '2026-11-17', company: 'Globex', status: 'review' },
  { id: 'd', metricId: 'jobs', date: '2026-11-17', company: 'Initech', status: 'rejected' },
  { id: 'e', metricId: 'jobs', date: '2026-11-03', company: 'Umbrella', status: 'offer' },
  { id: 'f', metricId: 'jobs', date: '2026-11-03', company: '', count: 3 },
  { id: 'g', metricId: 'jobs', date: '2026-10-30', company: 'Old Co' }
];

const LABELS = { applied: 'Applied', review: 'Under Review', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Archived / Rejected' };

function makeCtx(S, Copy, over) {
  const o = over || {};
  const unitName = o.unitName || 'applications';
  const ctx = Object.assign({
    metricId: 'jobs',
    isJobs: true,
    unit: n => Copy.unitFor(unitName, n),
    goal: 5,
    todayStr: TODAY,
    dailyMap: MAP,
    voice: 'coach',
    streak: 2,
    longest: 3,
    freezes: 0,
    restDays: [],
    restToday: false,
    total: 35,
    copy: Copy,
    friendlyDate: s => 'on ' + s,
    statusLabel: id => LABELS[id],
    statusOf: l => l.status || 'applied',
    normalizeCompany: n => String(n).toLowerCase().replace(/\b(corp|inc)\b/g, '').trim()
  }, o);
  delete ctx.unitName;
  if (!o.milestones) ctx.milestones = S.localMilestones(ctx.dailyMap, ctx.metricId, ctx);
  return ctx;
}

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const DECLINE = /\b(fewer|less than|down from|decline|dropped|drop|behind|missed|failed|only)\b/i;

function allText(slides) {
  return slides.map(s => JSON.stringify(s)).join(' ');
}

async function run() {
  console.log('--- Running test/stories.test.js ---');
  const hadWindow = typeof global.window !== 'undefined';
  const hadDocument = typeof global.document !== 'undefined';
  const S = fresh('popup/modules/stories.js');
  const Copy = fresh('shared/coach-copy.js');
  assert.strictEqual(hadWindow, false, 'no window in node');
  assert.strictEqual(hadDocument, false, 'no document in node');
  assert.strictEqual(typeof S.listStories, 'function');
  assert.strictEqual(S.SEEN_KEY, 'lit_stories_seen');
  console.log('[PASS] Module loads in node without a DOM and exports its helpers');

  // Dates: Monday-first weeks, month edges.
  {
    assert.strictEqual(S.weekStartOf('2026-11-20'), '2026-11-16');
    assert.strictEqual(S.weekStartOf('2026-11-16'), '2026-11-16');
    assert.strictEqual(S.weekStartOf('2026-11-22'), '2026-11-16', 'Sunday belongs to the week that started Monday');
    assert.strictEqual(S.addDays('2026-11-30', 1), '2026-12-01');
    assert.strictEqual(S.addDays('2026-01-01', -1), '2025-12-31');
    assert.strictEqual(S.weekdayOf('2026-11-20'), 5);
    console.log('[PASS] Date helpers: Monday weeks and month/year edges');
  }

  // Seen state: hash per content; more today makes it new again.
  {
    const ctx = makeCtx(S, Copy);
    const list = S.listStories(ctx);
    const today = list.find(s => s.kind === 'today');
    assert.ok(today && today.hash, 'today has a hash');
    assert.strictEqual(S.isUnseen({}, today), true);
    const seen = S.markSeen({}, today);
    assert.strictEqual(S.isUnseen(seen, today), false, 'seen after marking');
    const more = Object.assign({}, MAP, { [TODAY]: { jobs: 5, leetcode: 2 } });
    const today2 = S.listStories(makeCtx(S, Copy, { dailyMap: more })).find(s => s.kind === 'today');
    assert.strictEqual(today2.id, today.id, 'same story id');
    assert.notStrictEqual(today2.hash, today.hash, 'content changed, hash changed');
    assert.strictEqual(S.isUnseen(seen, today2), true, 'a higher count makes Today new again');
    const again = S.listStories(makeCtx(S, Copy)).find(s => s.kind === 'today');
    assert.strictEqual(again.hash, today.hash, 'hash is stable for the same content');
    assert.strictEqual(S.hashString('abc'), S.hashString('abc'));
    assert.notStrictEqual(S.hashString('abc'), S.hashString('abd'));
    // The map stays small: oldest entries drop.
    let big = {};
    for (let i = 0; i < 70; i++) big = S.markSeen(big, { id: 's' + i, hash: 'h' + i });
    assert.strictEqual(Object.keys(big).length, 60);
    assert.ok(!('s0' in big) && big.s69 === 'h69', 'oldest dropped, newest kept');
    assert.deepStrictEqual(S.markSeen(null, { id: 'x', hash: 'y' }), { x: 'y' }, 'tolerates a missing map');
    console.log('[PASS] Seen hashing: stable, per story, and a new count makes it unseen');
  }

  // Ring row: only stories with something to say.
  {
    assert.deepStrictEqual(S.listStories(makeCtx(S, Copy, { dailyMap: {}, streak: 0, longest: 0 })), [], 'brand-new person: no rings');
    const list = S.listStories(makeCtx(S, Copy));
    assert.deepStrictEqual(list.map(s => s.kind), ['today', 'week', 'streak', 'milestone', 'month']);
    assert.deepStrictEqual(list.map(s => s.label), ['Today', 'This week', 'Streak', 'Milestone', 'Your month']);
    list.forEach(s => {
      assert.ok(/^[a-z]+:jobs$/.test(s.id), 'ids carry the goal: ' + s.id);
      assert.ok(s.aria && !EMOJI.test(s.aria));
    });
    assert.deepStrictEqual(list[0].face, { type: 'count', count: 4, goal: 5 });
    assert.deepStrictEqual(list[1].face.values, [3, 5, 2, 0, 4, 0, 0]);
    assert.strictEqual(list[4].face.text, 'NOV');
    // Nothing logged today and not a rest day: no Today ring.
    const noToday = Object.assign({}, MAP);
    delete noToday[TODAY];
    assert.ok(!S.listStories(makeCtx(S, Copy, { dailyMap: noToday })).some(s => s.kind === 'today'));
    // A rest day with nothing logged still gets a Today story.
    const rest = S.listStories(makeCtx(S, Copy, { dailyMap: noToday, restToday: true }));
    assert.deepStrictEqual(rest[0].face, { type: 'rest' });
    const restSlides = S.slidesFor('today', makeCtx(S, Copy, { dailyMap: noToday, restToday: true }));
    assert.strictEqual(restSlides[0].big, 'Rest day');
    assert.ok(/streak is safe/.test(restSlides[0].line));
    // No streak at all: no Streak ring.
    assert.ok(!S.listStories(makeCtx(S, Copy, { streak: 0, longest: 0 })).some(s => s.kind === 'streak'));
    console.log('[PASS] Ring row lists only stories with something to say');
  }

  // Today: the ring slide and a positive comparison only when there is one.
  {
    const slides = S.slidesFor('today', makeCtx(S, Copy));
    assert.strictEqual(slides.length, 1, 'no comparison when today is not above the usual day');
    assert.strictEqual(slides[0].layout, 'ring');
    assert.deepStrictEqual(slides[0].ring, { count: 4, goal: 5 });
    assert.strictEqual(slides[0].line, Copy.headline({ count: 4, goal: 5, voice: 'coach' }));
    assert.strictEqual(slides[0].buddy, true, 'buddy waves on the opening slide');
    const big = Object.assign({}, MAP, { [TODAY]: { jobs: 7 } });
    const best = S.slidesFor('today', makeCtx(S, Copy, { dailyMap: big }));
    assert.strictEqual(best.length, 2);
    assert.strictEqual(best[1].id, 'today-best');
    assert.ok(/previous best was 6/.test(best[1].line));
    console.log('[PASS] Today story: goal ring, coach headline, upbeat comparison');
  }

  // Week: bars, best day, and a comparison that never frames a decline.
  {
    const slides = S.slidesFor('week', makeCtx(S, Copy));
    assert.strictEqual(slides.length, 2);
    assert.strictEqual(slides[0].big, 14);
    assert.strictEqual(slides[0].bigLabel, 'applications this week');
    assert.deepStrictEqual(slides[0].bars.map(b => b.count), [3, 5, 2, 0, 4, 0, 0]);
    assert.deepStrictEqual(slides[0].bars.map(b => b.future), [false, false, false, false, false, true, true]);
    assert.strictEqual(slides[0].bars.findIndex(b => b.best), 1, 'Tuesday is the best day');
    assert.ok(/Tuesday was your strongest day, with 5/.test(slides[0].line));
    assert.ok(/11 more than last week/.test(slides[1].quote), 'positive comparison from LitCopy.weekStory');
    assert.strictEqual(slides[1].chip, '+11 on the week before');
    // A quieter week than the last one: no comparison and no decline words.
    const quiet = {
      '2026-11-09': { jobs: 4 }, '2026-11-10': { jobs: 4 }, '2026-11-11': { jobs: 4 },
      '2026-11-17': { jobs: 2 }
    };
    const q = S.slidesFor('week', makeCtx(S, Copy, { dailyMap: quiet }));
    const qText = allText(q);
    assert.ok(!/more than last week/.test(qText));
    assert.ok(!DECLINE.test(q[1].quote), 'never frames a decline: ' + q[1].quote);
    assert.strictEqual(q[1].chip, '');
    // Monday with nothing yet: last week instead.
    const monday = makeCtx(S, Copy, { todayStr: '2026-11-23', dailyMap: MAP });
    const wk = S.listStories(monday).find(s => s.kind === 'week');
    assert.strictEqual(wk.label, 'Last week');
    const lw = S.slidesFor('week', monday);
    assert.strictEqual(lw[0].bigLabel, 'applications last week');
    assert.ok(!/this week/.test(lw[1].quote), 'last week reads as last week: ' + lw[1].quote);
    assert.ok(/than the week before/.test(lw[1].quote), 'compares with the week before: ' + lw[1].quote);
    console.log('[PASS] Week story: bars, best day, and only positive comparisons');
  }

  // Streak: flame, longest, freezes, rest days; never a zero headline.
  {
    const s = S.slidesFor('streak', makeCtx(S, Copy, { restDays: [6, 0], freezes: 1 }));
    assert.strictEqual(s[0].big, 2);
    assert.strictEqual(s[0].bigLabel, 'days in a row');
    assert.strictEqual(s[1].stats[0].value, 3);
    assert.strictEqual(s[1].stats[1].value, 1);
    assert.strictEqual(s[1].stats[1].label, 'streak freeze ready');
    assert.strictEqual(s[1].stats[2].value, 'Sat, Sun');
    const fresh0 = S.slidesFor('streak', makeCtx(S, Copy, { streak: 0, longest: 6 }));
    assert.strictEqual(fresh0[0].big, 'Fresh start', 'no zero headline');
    assert.ok(/best run so far is 6 days/.test(fresh0[0].line));
    assert.ok(!fresh0[1].stats.some(x => x.value === 0), 'no zero tiles');
    console.log('[PASS] Streak story: current, longest, freezes, rest days, no zeros');
  }

  // Milestones: newest reached, next one as progress.
  {
    const ctx = makeCtx(S, Copy);
    assert.deepStrictEqual(ctx.milestones.reached.map(r => [r.count, r.date]), [[1, '2026-10-15'], [10, '2026-11-04'], [25, '2026-11-17']]);
    assert.deepStrictEqual(ctx.milestones.next, { count: 50, remaining: 15 });
    const s = S.slidesFor('milestone', ctx);
    assert.strictEqual(s[0].big, 25);
    assert.strictEqual(s[0].title, Copy.milestone(25, 'applications').title);
    assert.strictEqual(s[0].note, 'Reached on 2026-11-17');
    assert.deepStrictEqual(s[0].share, { metricId: 'jobs', bigNumber: 25, bigLabel: 'applications sent', milestoneTitle: s[0].title });
    assert.strictEqual(s[1].progress, 0.4);
    assert.strictEqual(s[1].bigLabel, 'more to reach 50');
    const withInterview = { reached: ctx.milestones.reached.concat([{ id: 'first-interview', count: null, date: '2026-11-19', title: 'Your first interview', body: 'Someone read it.' }]), next: null };
    const newest = S.newestMilestone(withInterview);
    assert.strictEqual(newest.id, 'first-interview');
    const fi = S.slidesFor('milestone', makeCtx(S, Copy, { milestones: withInterview }));
    assert.strictEqual(fi.length, 1);
    assert.strictEqual(fi[0].big, '');
    assert.strictEqual(fi[0].share.bigLabel, 'first interview');
    assert.strictEqual(S.newestMilestone({ reached: [] }), null);
    console.log('[PASS] Milestone story: newest milestone, share context, next as progress');
  }

  // Month in review: the math.
  {
    const month = S.pickMonth(TODAY, MAP, 'jobs');
    assert.deepStrictEqual([month.key, month.start, month.end, month.last, month.past, month.name], ['2026-11', '2026-11-01', TODAY, '2026-11-30', false, 'November']);
    const early = S.pickMonth('2026-11-02', MAP, 'jobs');
    assert.deepStrictEqual([early.key, early.end, early.past, early.name], ['2026-10', '2026-10-31', true, 'October'], 'first days of a month look back at the last one');
    assert.strictEqual(S.pickMonth('2026-11-02', {}, 'jobs').key, '2026-11', 'unless last month was empty');
    assert.strictEqual(S.pickMonth('2026-11-04', MAP, 'jobs').key, '2026-11');
    assert.strictEqual(S.pickMonth('2027-01-02', { '2026-12-10': { jobs: 1 } }, 'jobs').key, '2026-12', 'crosses the year');

    const r = S.monthReview({ dailyMap: MAP, metricId: 'jobs', goal: 5, restDays: [], month, jobs: JOBS, statusOf: l => l.status || 'applied', normalizeCompany: n => String(n).toLowerCase().replace(/\b(corp|inc)\b/g, '').trim() });
    assert.strictEqual(r.total, 33);
    assert.strictEqual(r.activeDays, 9);
    assert.strictEqual(r.goalDays, 4);
    assert.deepStrictEqual(r.busiest, { date: '2026-11-03', count: 6 });
    assert.deepStrictEqual(r.weekdayTotals, [3, 13, 7, 6, 4, 0, 0]);
    assert.strictEqual(r.topWeekday.name, 'Tuesday');
    assert.strictEqual(r.topWeekday.share, 39);
    assert.deepStrictEqual([r.bestRun.kind, r.bestRun.days, r.bestRun.start, r.bestRun.end], ['goal', 3, '2026-11-03', '2026-11-05']);
    assert.strictEqual(r.days.length, 30, 'the whole month is in the grid');
    assert.strictEqual(r.days.filter(d => d.future).length, 10);
    assert.strictEqual(r.daysElapsed, 20);
    assert.deepStrictEqual(r.companies, { count: 4, names: ['Acme Corp', 'Globex', 'Initech'] });
    assert.deepStrictEqual(r.stages, [
      { id: 'applied', count: 4 }, { id: 'review', count: 1 }, { id: 'interviewing', count: 1 }, { id: 'offer', count: 1 }, { id: 'rejected', count: 1 }
    ]);
    assert.strictEqual(r.moving, 3);
    assert.strictEqual(r.jobsTotal, 8);
    const noJobs = S.monthReview({ dailyMap: MAP, metricId: 'jobs', goal: 5, month, jobs: null });
    assert.strictEqual(noJobs.companies, null);
    assert.strictEqual(noJobs.stages, null);

    // Best run: rest days neither break nor add; an active run when no goal run.
    const days = [
      { date: 'a', met: true, count: 5, rest: false },
      { date: 'b', met: false, count: 0, rest: true },
      { date: 'c', met: false, count: 0, rest: true },
      { date: 'd', met: true, count: 5, rest: false },
      { date: 'e', met: false, count: 0, rest: false },
      { date: 'f', met: true, count: 6, rest: false }
    ];
    assert.deepStrictEqual(S.longestRun(days, d => d.met), { days: 2, start: 'a', end: 'd' });
    const activeOnly = { '2026-11-16': { jobs: 1 }, '2026-11-17': { jobs: 2 }, '2026-11-18': { jobs: 1 } };
    const ra = S.monthReview({ dailyMap: activeOnly, metricId: 'jobs', goal: 5, month, jobs: null });
    assert.deepStrictEqual([ra.bestRun.kind, ra.bestRun.days], ['active', 3]);
    console.log('[PASS] Month in review: totals, busiest day, weekday, active days, companies, stages, best run');
  }

  // Month deck: 6 to 8 slides, buddy bookends, share on the closing slide.
  {
    const ctx = makeCtx(S, Copy);
    const deck = S.slidesFor('month', ctx, { jobs: JOBS });
    assert.deepStrictEqual(deck.map(s => s.id), ['month-open', 'month-busiest', 'month-weekday', 'month-active', 'month-companies', 'month-stages', 'month-run', 'month-close']);
    assert.ok(deck.length >= 6 && deck.length <= 8);
    assert.strictEqual(deck[0].big, 33);
    assert.strictEqual(deck[0].bigLabel, 'applications sent');
    assert.strictEqual(deck[0].title, 'Your November');
    assert.strictEqual(deck[0].buddy, true);
    assert.strictEqual(deck[deck.length - 1].buddy, true, 'buddy waves on the closing slide');
    assert.ok(!deck.slice(1, -1).some(s => s.buddy), 'and only there');
    assert.strictEqual(deck[2].big, 'Tuesdays');
    assert.ok(/39% of your month/.test(deck[2].line));
    assert.strictEqual(deck[3].big, 9);
    assert.ok(/goal on 4 of them/.test(deck[3].line));
    assert.deepStrictEqual(deck[4].names, ['Acme Corp', 'Globex', 'Initech']);
    assert.ok(/^Plus 1 more/.test(deck[4].line));
    assert.deepStrictEqual(deck[5].stages.map(s => s.label), ['Applied', 'Under Review', 'Interviewing', 'Offer', 'Closed']);
    assert.strictEqual(deck[5].big, 3);
    assert.strictEqual(deck[5].bigLabel, 'moving forward');
    assert.strictEqual(deck[6].big, 3);
    assert.deepStrictEqual(deck[7].share, { metricId: 'jobs', bigNumber: 33, bigLabel: 'applications in November', milestoneTitle: 'November in review' });
    // Without the job list (it failed to load): still a full deck.
    const lean = S.slidesFor('month', ctx, { jobs: null });
    assert.strictEqual(lean.length, 6);
    // Another goal: its own unit, "logged", no companies or stages.
    const lc = makeCtx(S, Copy, { metricId: 'leetcode', isJobs: false, unitName: 'problems', goal: 2, total: 3 });
    const lcDeck = S.slidesFor('month', lc, { jobs: JOBS });
    assert.strictEqual(lcDeck[0].bigLabel, 'problems logged');
    assert.ok(!lcDeck.some(s => s.id === 'month-companies' || s.id === 'month-stages'), 'jobs-only slides skipped');
    assert.ok(lcDeck.length >= 5 && lcDeck.length <= 8);
    assert.ok(!/application/.test(allText(lcDeck)), 'no application wording for another goal');
    const lcRing = S.listStories(lc).find(s => s.kind === 'today');
    assert.ok(/problems today/.test(lcRing.aria), lcRing.aria);
    const lcToday = S.slidesFor('today', lc);
    assert.strictEqual(lcToday[0].bigLabel, 'problems today');
    // An empty month: no deck and no ring.
    assert.deepStrictEqual(S.slidesFor('month', makeCtx(S, Copy, { dailyMap: { '2026-10-02': { jobs: 2 } } }), {}), []);
    console.log('[PASS] Month deck: 6-8 slides, buddy bookends, share, other-goal wording');
  }

  // Live-region text and copy rules.
  {
    const ctx = makeCtx(S, Copy, { restDays: [6, 0] });
    const kinds = ['today', 'week', 'streak', 'milestone', 'month'];
    kinds.forEach(k => {
      S.slidesFor(k, ctx, { jobs: JOBS }).forEach(slide => {
        const t = S.slideText(slide);
        assert.ok(t.length > 0, 'text for ' + slide.id);
        assert.ok(/[.!?]$/.test(t), 'reads as sentences: ' + t);
        assert.ok(!/\.\./.test(t.replace(/\.\.\./g, '')), 'no doubled periods: ' + t);
        assert.ok(!EMOJI.test(t), 'no emoji');
        assert.ok(!/undefined|null|NaN/.test(t), 'no leaks: ' + t);
      });
    });
    const t = S.slideText(S.slidesFor('month', ctx, { jobs: JOBS })[0]);
    assert.ok(t.startsWith('Month so far. Your November. 33 applications sent.'), t);
    const src = fs.readFileSync(path.join(__dirname, '..', 'popup/modules/stories.js'), 'utf8') +
      fs.readFileSync(path.join(__dirname, '..', 'popup/modules/stories.css'), 'utf8');
    assert.ok(!/wrapped/i.test(src), 'no borrowed feature names');
    assert.ok(!EMOJI.test(src), 'no emoji in the module');
    console.log('[PASS] Slide text for the live region; copy rules hold');
  }

  // Slide timer.
  {
    let s = S.timerInit({ stories: 3, story: 0, duration: 5000 });
    assert.strictEqual(s.changed, 'story');
    assert.strictEqual(S.timerRunning(s), true);
    s = S.timerStep(s, { type: 'slides', count: 3 });
    assert.strictEqual(s.slides, 3);
    s = S.timerStep(s, { type: 'tick', dt: 2500 });
    assert.strictEqual(S.timerProgress(s), 0.5);
    assert.strictEqual(s.changed, null);
    s = S.timerStep(s, { type: 'tick', dt: 2500 });
    assert.deepStrictEqual([s.story, s.slide, s.changed, s.elapsed], [0, 1, 'slide', 0], 'auto-advance after the duration');
    // Pause, hold, hidden, a dialog, and loading all stop the clock.
    ['pause', 'hold', 'hidden', 'modal', 'loading'].forEach(kind => {
      const on = kind === 'pause' ? { type: 'pause' } : { type: kind, on: true };
      const off = kind === 'pause' ? { type: 'play' } : { type: kind, on: false };
      let p = S.timerStep(s, on);
      assert.strictEqual(S.timerRunning(p), false, kind + ' stops it');
      p = S.timerStep(p, { type: 'tick', dt: 9000 });
      assert.deepStrictEqual([p.slide, p.elapsed], [1, 0], kind + ': no ticks counted');
      p = S.timerStep(p, off);
      assert.strictEqual(S.timerRunning(p), true, kind + ' released');
    });
    const toggled = S.timerStep(S.timerStep(s, { type: 'toggle' }), { type: 'toggle' });
    assert.strictEqual(toggled.paused, false, 'toggle twice is a no-op');
    // Manual moves, across story boundaries both ways.
    s = S.timerStep(s, { type: 'next' });
    assert.deepStrictEqual([s.story, s.slide, s.changed], [0, 2, 'slide']);
    s = S.timerStep(s, { type: 'next' });
    assert.deepStrictEqual([s.story, s.slide, s.changed], [1, 0, 'story'], 'past the last slide goes to the next story');
    s = S.timerStep(s, { type: 'slides', count: 2 });
    s = S.timerStep(s, { type: 'prev' });
    assert.deepStrictEqual([s.story, s.slide, s.changed], [0, 0, 'story'], 'back from a first slide goes to the previous story');
    s = S.timerStep(s, { type: 'tick', dt: 1200 });
    s = S.timerStep(s, { type: 'prev' });
    assert.deepStrictEqual([s.story, s.slide, s.changed, s.elapsed], [0, 0, 'restart', 0], 'back at the very start restarts the slide');
    // Ending: last slide of the last story closes, then nothing moves.
    let e = S.timerInit({ stories: 2, story: 1 });
    e = S.timerStep(e, { type: 'slides', count: 1 });
    e = S.timerStep(e, { type: 'tick', dt: 6000 });
    assert.deepStrictEqual([e.closed, e.changed], [true, 'close']);
    e = S.timerStep(e, { type: 'prev' });
    assert.strictEqual(e.closed, true);
    assert.strictEqual(e.changed, null);
    // Slides shrinking under the cursor clamp it.
    let c = S.timerStep(S.timerInit({ stories: 1, slides: 5 }), { type: 'next' });
    c = S.timerStep(S.timerStep(S.timerStep(c, { type: 'next' }), { type: 'next' }), { type: 'slides', count: 2 });
    assert.strictEqual(c.slide, 1);
    assert.strictEqual(S.timerStep(S.timerInit({}), { type: 'close' }).closed, true);
    assert.strictEqual(S.timerInit({ stories: 3, story: 9 }).story, 2, 'start index clamps');
    console.log('[PASS] Slide timer: advance, pause/hold/hidden, story boundaries, close');
  }

  // Count-up easing.
  {
    assert.strictEqual(S.countUpValue(42, 0), 0);
    assert.strictEqual(S.countUpValue(42, 1), 42);
    assert.strictEqual(S.countUpValue(42, 2), 42);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = S.countUpValue(42, t);
      assert.ok(v >= prev && v <= 42, 'monotonic');
      prev = v;
    }
    assert.ok(S.countUpValue(100, 0.5) > 50, 'eases out');
    console.log('[PASS] Count-up eases out and lands on the target');
  }

  console.log('--- test/stories.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => { console.error('Test failed:', err); process.exit(1); });
}

module.exports = { run };
