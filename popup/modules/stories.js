// LIT popup module: stories.
//
// A row of story rings under the date (Today, This week, Streak, Milestone,
// Your month) and a full-popup viewer that plays them like a social app:
// segmented progress bars, auto-advance, tap left/right, press and hold to
// pause, swipe down to close. "Your month" is a short month-in-review deck.
//
// Talks to the popup only through window.LitPopup (see popup/bridge.js).
// Owns #stories-host and #overlay-host. Seen state lives in
// chrome.storage.local['lit_stories_seen'] as { storyId: contentHash }, so a
// story turns new again when what it says changes.
//
// The first half of this file is pure (story data, month math, seen hashing,
// the slide timer) and loads in node for test/stories.test.js. The browser
// wiring at the bottom only runs in the popup.
const LitStories = (() => {
  const SEEN_KEY = 'lit_stories_seen';
  const PREF_KEY = 'stories';
  const SLIDE_MS = 5000;
  const SLIDE_MS_REDUCED = 8000;
  const COUNT_MS = 900;
  const SEEN_LIMIT = 60;
  // Storage's own list when available, so the ring and the trophy shelf agree.
  const MILESTONES = typeof TrackerStorage !== 'undefined' && Array.isArray(TrackerStorage.MILESTONE_THRESHOLDS)
    ? TrackerStorage.MILESTONE_THRESHOLDS.slice()
    : [1, 10, 25, 50, 100, 250, 500, 1000];
  const STAGES = ['applied', 'review', 'interviewing', 'offer', 'rejected'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ----- Dates (local, YYYY-MM-DD) -------------------------------------------
  const pad = n => (n < 10 ? '0' : '') + n;
  const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  function parseDate(s) {
    const p = String(s).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2], 12);
  }

  function toDateStr(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(s, n) {
    const d = parseDate(s);
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }

  function weekdayOf(s) {
    return parseDate(s).getDay();
  }

  // Monday of the week holding s (LIT weeks run Monday to Sunday).
  function weekStartOf(s) {
    return addDays(s, -((weekdayOf(s) + 6) % 7));
  }

  function daysInMonth(y, m) {
    return new Date(y, m, 0).getDate();
  }

  function shortDate(s) {
    const d = parseDate(s);
    return MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate();
  }

  function longDay(s) {
    const d = parseDate(s);
    return DAY_NAMES[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate();
  }

  function int(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function countOn(map, date, metricId) {
    return int(((map || {})[date] || {})[metricId]);
  }

  // ----- Seen state ------------------------------------------------------------
  // FNV-1a, 32-bit, base 36. Short and stable; only compared for equality.
  function hashString(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  function isUnseen(seen, story) {
    return !story || !seen || typeof seen !== 'object' || seen[story.id] !== story.hash;
  }

  // A new map with story marked seen; the oldest entries drop past the limit.
  function markSeen(seen, story, limit) {
    const out = {};
    const src = seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {};
    Object.keys(src).forEach(k => { if (k !== story.id && typeof src[k] === 'string') out[k] = src[k]; });
    out[story.id] = story.hash;
    const keys = Object.keys(out);
    const max = limit || SEEN_LIMIT;
    if (keys.length > max) keys.slice(0, keys.length - max).forEach(k => { delete out[k]; });
    return out;
  }

  // ----- Copy helpers -------------------------------------------------------
  function copyLib(ctx) {
    if (ctx && ctx.copy) return ctx.copy;
    return typeof LitCopy !== 'undefined' ? LitCopy : null;
  }

  function callCopy(ctx, fn, args, fallback) {
    const C = copyLib(ctx);
    try {
      if (C && typeof C[fn] === 'function') {
        const out = C[fn].apply(C, args);
        if (out !== undefined && out !== null && out !== '') return out;
      }
    } catch (e) { /* fall through */ }
    return typeof fallback === 'function' ? fallback() : fallback;
  }

  function unitOf(ctx, n) {
    if (ctx && typeof ctx.unit === 'function') {
      try {
        const u = ctx.unit(n);
        if (u) return u;
      } catch (e) { /* fall through */ }
    }
    return n === 1 ? 'application' : 'applications';
  }

  // "sent" reads right for applications; any other goal is "logged".
  function verbOf(ctx) {
    return ctx && ctx.isJobs ? 'sent' : 'logged';
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  // ----- Week math ---------------------------------------------------------------
  function weekData(map, metricId, todayStr, weekStart) {
    const days = [];
    let total = 0;
    let active = 0;
    let best = null;
    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const future = date > todayStr;
      const count = future ? 0 : countOn(map, date, metricId);
      days.push({ date, count, future, isToday: date === todayStr, letter: DAY_LETTERS[i] });
      total += count;
      if (count > 0) active++;
      if (count > 0 && (!best || count > best.count)) best = { date, count };
    }
    return { start: weekStart, days, total, activeDays: active, best };
  }

  // This week, or last week when this one has nothing yet.
  function weekStory(ctx) {
    const ws = weekStartOf(ctx.todayStr);
    let wk = weekData(ctx.dailyMap, ctx.metricId, ctx.todayStr, ws);
    let mode = 'this';
    if (wk.total === 0) {
      const last = weekData(ctx.dailyMap, ctx.metricId, ctx.todayStr, addDays(ws, -7));
      if (last.total === 0) return null;
      wk = last;
      mode = 'last';
    }
    const prior = weekData(ctx.dailyMap, ctx.metricId, ctx.todayStr, addDays(wk.start, -7));
    return Object.assign(wk, { mode, priorTotal: prior.total });
  }

  // ----- Month math ----------------------------------------------------------
  // The month to review: this month so far, or last month during the first
  // three days of a new one (when last month has something to show).
  function pickMonth(todayStr, map, metricId) {
    const t = parseDate(todayStr);
    const y = t.getFullYear();
    const m = t.getMonth() + 1;
    if (t.getDate() <= 3) {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      const start = py + '-' + pad(pm) + '-01';
      const end = py + '-' + pad(pm) + '-' + pad(daysInMonth(py, pm));
      let total = 0;
      for (let d = start; d <= end; d = addDays(d, 1)) total += countOn(map, d, metricId);
      if (total > 0) return { key: py + '-' + pad(pm), start, end, last: end, past: true, name: MONTHS[pm - 1], short: MONTHS_SHORT[pm - 1] };
    }
    const start = y + '-' + pad(m) + '-01';
    return { key: y + '-' + pad(m), start, end: todayStr, last: y + '-' + pad(m) + '-' + pad(daysInMonth(y, m)), past: false, name: MONTHS[m - 1], short: MONTHS_SHORT[m - 1] };
  }

  function companyKey(name, normalize) {
    if (typeof normalize === 'function') {
      try { return normalize(name) || ''; } catch (e) { /* fall through */ }
    }
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Longest run of qualifying days; rest days that do not qualify neither
  // break the run nor add to it.
  function longestRun(days, qualifies) {
    let best = { days: 0, start: null, end: null };
    let run = { days: 0, start: null, end: null };
    days.forEach(d => {
      if (qualifies(d)) {
        if (!run.days) run.start = d.date;
        run.days++;
        run.end = d.date;
        if (run.days > best.days) best = Object.assign({}, run);
      } else if (!d.rest) {
        run = { days: 0, start: null, end: null };
      }
    });
    return best;
  }

  // Everything the month deck says. opts: { dailyMap, metricId, goal,
  // restDays, month (from pickMonth), jobs (job logs, any order, or null),
  // normalizeCompany, statusOf }.
  function monthReview(opts) {
    const o = opts || {};
    const month = o.month;
    const goal = Math.max(1, int(o.goal) || 1);
    const rest = Array.isArray(o.restDays) ? o.restDays : [];
    const days = [];
    const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
    let total = 0;
    let activeDays = 0;
    let goalDays = 0;
    let busiest = null;
    for (let d = month.start; d <= month.last; d = addDays(d, 1)) {
      const future = d > month.end;
      const count = future ? 0 : countOn(o.dailyMap, d, o.metricId);
      const wd = weekdayOf(d);
      const day = { date: d, count, future, met: !future && count >= goal, rest: rest.includes(wd), weekday: wd };
      days.push(day);
      if (future) continue;
      total += count;
      weekdayTotals[(wd + 6) % 7] += count;
      if (count > 0) activeDays++;
      if (day.met) goalDays++;
      if (count > 0 && (!busiest || count > busiest.count)) busiest = { date: d, count };
    }
    let top = null;
    weekdayTotals.forEach((n, i) => {
      if (n > 0 && (!top || n > top.total)) top = { index: (i + 1) % 7, monFirst: i, total: n };
    });
    if (top) {
      top.name = DAY_NAMES[top.index];
      top.share = total ? Math.round((top.total / total) * 100) : 0;
    }
    const past = days.filter(d => !d.future);
    let bestRun = null;
    const goalRun = longestRun(past, d => d.met);
    if (goalRun.days >= 2) bestRun = Object.assign({ kind: 'goal' }, goalRun);
    else {
      const activeRun = longestRun(past, d => d.count > 0);
      if (activeRun.days >= 2) bestRun = Object.assign({ kind: 'active' }, activeRun);
    }

    let companies = null;
    let stages = null;
    let jobsTotal = 0;
    if (Array.isArray(o.jobs)) {
      const byKey = new Map();
      const counts = {};
      STAGES.forEach(s => { counts[s] = 0; });
      o.jobs.forEach(log => {
        if (!log || !isDate(log.date) || log.date < month.start || log.date > month.end) return;
        if (log.metricId && log.metricId !== 'jobs') return;
        const weight = Math.max(1, int(log.count) || 1);
        jobsTotal += weight;
        let status = 'applied';
        try { status = typeof o.statusOf === 'function' ? o.statusOf(log) : (log.status || 'applied'); } catch (e) { status = 'applied'; }
        if (!STAGES.includes(status)) status = 'applied';
        counts[status] += weight;
        const name = String(log.company || '').trim();
        const key = name ? companyKey(name, o.normalizeCompany) : '';
        if (!key) return;
        const prev = byKey.get(key);
        const stamp = log.date + '|' + (log.timestamp || '');
        if (!prev) byKey.set(key, { name, count: 1, last: stamp });
        else {
          prev.count++;
          if (stamp > prev.last) { prev.last = stamp; prev.name = name; }
        }
      });
      const list = Array.from(byKey.values()).sort((a, b) => (b.count - a.count) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
      companies = { count: list.length, names: list.slice(0, 3).map(c => c.name) };
      stages = STAGES.map(id => ({ id, count: counts[id] }));
    }
    const moving = stages ? stages.filter(s => s.id === 'review' || s.id === 'interviewing' || s.id === 'offer').reduce((n, s) => n + s.count, 0) : 0;
    return { month, total, activeDays, goalDays, busiest, weekdayTotals, topWeekday: top, bestRun, days, companies, stages, moving, jobsTotal, daysElapsed: past.length };
  }

  // ----- Milestones ------------------------------------------------------------
  // The threshold milestones from the day totals, for an instant ring before
  // TrackerStorage.getMilestones (which also knows the first interview) lands.
  function localMilestones(map, metricId, ctx) {
    const dates = Object.keys(map || {}).filter(isDate).sort();
    const reached = [];
    let total = 0;
    let ti = 0;
    dates.forEach(date => {
      total += countOn(map, date, metricId);
      while (ti < MILESTONES.length && total >= MILESTONES[ti]) {
        const count = MILESTONES[ti];
        const copy = callCopy(ctx, 'milestone', [count, unitOf(ctx, 2)], () => ({ title: count + ' ' + unitOf(ctx, count), body: 'Every one of these moves you closer.' }));
        reached.push({ id: count, count, date, title: copy.title, body: copy.body });
        ti++;
      }
    });
    const nextCount = MILESTONES.find(t => t > total);
    return { reached, next: nextCount ? { count: nextCount, remaining: nextCount - total } : null };
  }

  function newestMilestone(ms) {
    const list = ms && Array.isArray(ms.reached) ? ms.reached.filter(r => r && isDate(r.date)) : [];
    if (!list.length) return null;
    return list.reduce((a, b) => (b.date > a.date || (b.date === a.date && (b.count || 0) >= (a.count || 0)) ? b : a));
  }

  // ----- Stories ------------------------------------------------------------
  // Story summaries for the ring row: { id, kind, label, hash, face, aria }.
  // Only stories with something to say are listed. Slides are built later,
  // when a story opens (slidesFor).
  function listStories(ctx) {
    if (!ctx || !ctx.metricId || !ctx.todayStr) return [];
    const mid = ctx.metricId;
    const goal = Math.max(1, int(ctx.goal) || 1);
    const out = [];

    const count = countOn(ctx.dailyMap, ctx.todayStr, mid);
    if (count > 0 || ctx.restToday) {
      out.push({
        id: 'today:' + mid, kind: 'today', label: 'Today',
        hash: hashString(['today', ctx.todayStr, count, goal, ctx.restToday ? 1 : 0].join('|')),
        face: count > 0 ? { type: 'count', count, goal } : { type: 'rest' },
        aria: count > 0 ? count + ' of ' + goal + ' ' + unitOf(ctx, goal) + ' today' : 'Rest day'
      });
    }

    const wk = weekStory(ctx);
    if (wk) {
      out.push({
        id: 'week:' + mid, kind: 'week', label: wk.mode === 'this' ? 'This week' : 'Last week',
        hash: hashString(['week', wk.start, wk.days.map(d => d.count).join(',')].join('|')),
        face: { type: 'bars', values: wk.days.map(d => d.count) },
        aria: wk.total + ' ' + unitOf(ctx, wk.total) + (wk.mode === 'this' ? ' this week' : ' last week')
      });
    }

    const streak = int(ctx.streak);
    const longest = Math.max(int(ctx.longest), streak);
    if (streak > 0 || longest > 0) {
      out.push({
        id: 'streak:' + mid, kind: 'streak', label: 'Streak',
        hash: hashString(['streak', streak, longest, int(ctx.freezes), ctx.restToday ? 1 : 0].join('|')),
        face: { type: 'flame', value: streak },
        aria: streak > 0 ? streak + '-day streak' : 'Best run ' + longest + plural(longest, ' day', ' days')
      });
    }

    const ms = newestMilestone(ctx.milestones);
    if (ms) {
      out.push({
        id: 'milestone:' + mid, kind: 'milestone', label: 'Milestone',
        hash: hashString(['milestone', ms.id, ms.date].join('|')),
        face: { type: 'medal' },
        aria: ms.title || 'Milestone reached'
      });
    }

    const month = pickMonth(ctx.todayStr, ctx.dailyMap, mid);
    let mTotal = 0;
    let mActive = 0;
    for (let d = month.start; d <= month.end; d = addDays(d, 1)) {
      const c = countOn(ctx.dailyMap, d, mid);
      mTotal += c;
      if (c > 0) mActive++;
    }
    if (mTotal > 0) {
      out.push({
        id: 'month:' + mid, kind: 'month', label: 'Your month',
        hash: hashString(['month', month.key, mTotal, mActive].join('|')),
        face: { type: 'month', text: month.short.toUpperCase() },
        aria: month.name + (month.past ? '' : ' so far') + ', ' + mTotal + ' ' + unitOf(ctx, mTotal),
        month
      });
    }
    return out;
  }

  // ----- Slides ----------------------------------------------------------------
  // A slide: { id, tone, layout, kicker, big, bigLabel, title, line, note,
  // buddy, share, ...layout data }. tone picks the backdrop: accent, tracker,
  // flame, frost, success. big is a number (counted up) or a short string.

  function todaySlides(ctx) {
    const mid = ctx.metricId;
    const goal = Math.max(1, int(ctx.goal) || 1);
    const count = countOn(ctx.dailyMap, ctx.todayStr, mid);
    const streak = int(ctx.streak);
    if (count === 0) {
      return [{
        id: 'today-rest', tone: 'frost', layout: 'rest', kicker: 'Today', big: 'Rest day',
        line: callCopy(ctx, 'streak', [{ days: streak, restToday: true, voice: ctx.voice }], 'Rest day. Recharge and come back fresh.'),
        note: 'Rest days never break your streak.'
      }];
    }
    const slides = [{
      id: 'today-ring', tone: 'tracker', layout: 'ring', kicker: 'Today',
      big: count, bigLabel: unitOf(ctx, count) + ' today',
      ring: { count, goal },
      title: count >= goal ? 'Goal of ' + goal + ' met' : '',
      line: callCopy(ctx, 'headline', [{ count, goal, voice: ctx.voice }], 'Nice work today.')
    }];
    // A positive comparison with the last four weeks, only when there is one.
    const recent = [];
    for (let i = 1; i <= 28; i++) {
      const c = countOn(ctx.dailyMap, addDays(ctx.todayStr, -i), mid);
      if (c > 0) recent.push(c);
    }
    if (recent.length >= 3) {
      const best = Math.max.apply(null, recent);
      const avg = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
      if (count > best) {
        slides.push({
          id: 'today-best', tone: 'flame', layout: 'spark', kicker: 'Today',
          big: count, bigLabel: 'your biggest day in four weeks',
          line: 'Your previous best was ' + best + '. Look at you go.'
        });
      } else if (count >= 2 && count > avg) {
        slides.push({
          id: 'today-pace', tone: 'accent', layout: 'spark', kicker: 'Today',
          big: count, bigLabel: 'above your usual day',
          line: 'On an active day you usually do about ' + avg + '. Today you went further.'
        });
      }
    }
    return slides;
  }

  function weekSlides(ctx) {
    const wk = weekStory(ctx);
    if (!wk) return [];
    const label = wk.mode === 'this' ? 'This week' : 'Last week';
    const best = wk.best;
    const unit = unitOf(ctx, 2);
    const story = callCopy(ctx, 'weekStory', [{ total: wk.total, activeDays: wk.activeDays, lastWeekTotal: wk.priorTotal, bestDay: best, unit }], () =>
      wk.total + ' ' + unitOf(ctx, wk.total) + ' this week across ' + wk.activeDays + plural(wk.activeDays, ' day.', ' days.') + ' Steady work adds up.');
    // The shared copy speaks about this week; a look back at last week
    // compares with the week before it.
    const quote = wk.mode === 'this' ? story : String(story).replace(/than last week/g, 'than the week before').replace(/this week/g, 'last week');
    const slides = [{
      id: 'week-bars', tone: 'accent', layout: 'bars', kicker: label,
      big: wk.total, bigLabel: unitOf(ctx, wk.total) + (wk.mode === 'this' ? ' this week' : ' last week'),
      bars: wk.days.map(d => ({ label: d.letter, count: d.count, future: d.future, isToday: d.isToday, best: !!best && d.date === best.date })),
      line: !best ? '' : wk.activeDays === 1
        ? (wk.mode === 'this' ? 'A strong start to the week.' : 'One focused day. It counts.')
        : DAY_NAMES[weekdayOf(best.date)] + ' was your strongest day' + (best.count > 1 ? ', with ' + best.count + '.' : '.')
    }];
    const more = wk.priorTotal > 0 && wk.total > wk.priorTotal ? wk.total - wk.priorTotal : 0;
    slides.push({
      id: 'week-story', tone: 'tracker', layout: 'quote', kicker: label,
      quote,
      chip: more ? '+' + more + ' on the week before' : (wk.activeDays >= 5 ? wk.activeDays + ' active days' : ''),
      line: ''
    });
    return slides;
  }

  function streakSlides(ctx) {
    const streak = int(ctx.streak);
    const longest = Math.max(int(ctx.longest), streak);
    const freezes = int(ctx.freezes);
    const rest = (Array.isArray(ctx.restDays) ? ctx.restDays : []).filter(n => n >= 0 && n <= 6);
    const restText = rest.length ? rest.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(n => DAY_SHORT[n]).join(', ') : '';
    const first = streak > 0
      ? {
        id: 'streak-now', tone: 'flame', layout: 'flame', kicker: 'Streak',
        big: streak, bigLabel: plural(streak, 'day in a row', 'days in a row'),
        line: callCopy(ctx, 'streak', [{ days: streak, restToday: ctx.restToday, voice: ctx.voice }], 'Keep it rolling.')
      }
      : {
        id: 'streak-fresh', tone: 'flame', layout: 'flame', kicker: 'Streak',
        big: 'Fresh start',
        line: 'Your best run so far is ' + longest + plural(longest, ' day', ' days') + '. Today can start the next one.'
      };
    const stats = [
      { value: longest, label: plural(longest, 'day, your longest run', 'days, your longest run') },
      freezes > 0
        ? { value: freezes, label: plural(freezes, 'streak freeze ready', 'streak freezes ready') }
        : { value: 7, label: 'days in a row earns a streak freeze' },
      restText
        ? { value: restText, label: 'rest days, always safe', text: true }
        : { value: 'None', label: 'rest days set yet', text: true }
    ];
    return [first, {
      id: 'streak-kit', tone: 'frost', layout: 'stats', kicker: 'Streak', title: 'Your streak, covered',
      stats,
      line: freezes > 0 ? 'A freeze covers a day you miss, so one off day will not undo your run.' : 'Rest days never break your streak. Pick them in Settings.'
    }];
  }

  function milestoneSlides(ctx) {
    const ms = newestMilestone(ctx.milestones);
    if (!ms) return [];
    const fmt = typeof ctx.friendlyDate === 'function' ? ctx.friendlyDate : shortDate;
    let when = '';
    try { when = fmt(ms.date); } catch (e) { when = shortDate(ms.date); }
    const slides = [{
      id: 'milestone-new', tone: 'success', layout: 'medal', kicker: 'Milestone',
      big: ms.count ? ms.count : '', bigLabel: ms.count ? unitOf(ctx, ms.count) : '',
      title: ms.title || 'Milestone reached', line: ms.body || '', note: when ? 'Reached ' + when : '',
      share: {
        metricId: ctx.metricId,
        bigNumber: ms.count || int(ctx.total) || 1,
        bigLabel: ms.count ? unitOf(ctx, ms.count) + ' ' + verbOf(ctx) : 'first interview',
        milestoneTitle: ms.title || ''
      }
    }];
    const next = ctx.milestones && ctx.milestones.next;
    if (next && next.count && next.remaining > 0) {
      const prevAt = MILESTONES.filter(t => t < next.count).pop() || 0;
      const span = Math.max(1, next.count - prevAt);
      slides.push({
        id: 'milestone-next', tone: 'accent', layout: 'progress', kicker: 'Next milestone',
        big: next.remaining, bigLabel: 'more to reach ' + next.count,
        progress: Math.max(0, Math.min(1, (span - next.remaining) / span)),
        progressFrom: prevAt, progressTo: next.count,
        line: 'Every one you log counts toward it.'
      });
    }
    return slides;
  }

  function monthSlides(ctx, extra) {
    const month = pickMonth(ctx.todayStr, ctx.dailyMap, ctx.metricId);
    const r = monthReview({
      dailyMap: ctx.dailyMap, metricId: ctx.metricId, goal: ctx.goal, restDays: ctx.restDays, month,
      jobs: ctx.isJobs && extra && Array.isArray(extra.jobs) ? extra.jobs : null,
      normalizeCompany: ctx.normalizeCompany, statusOf: ctx.statusOf
    });
    if (!r.total) return [];
    const verb = verbOf(ctx);
    const title = 'Your ' + month.name;
    const slides = [];
    slides.push({
      id: 'month-open', tone: 'accent', layout: 'open', kicker: month.past ? 'Month in review' : 'Month so far',
      title, big: r.total, bigLabel: unitOf(ctx, r.total) + ' ' + verb,
      line: month.past ? 'Here is how your month went.' : 'Here is your month so far.', buddy: true
    });
    if (r.busiest) {
      slides.push({
        id: 'month-busiest', tone: 'tracker', layout: 'spark', kicker: 'Your busiest day',
        big: r.busiest.count, bigLabel: unitOf(ctx, r.busiest.count) + ' in one day',
        title: longDay(r.busiest.date),
        line: r.busiest.count >= Math.max(1, int(ctx.goal)) ? 'A full day of real effort.' : 'Every one of them was a real chance.'
      });
    }
    if (r.topWeekday && r.activeDays >= 2) {
      slides.push({
        id: 'month-weekday', tone: 'flame', layout: 'weekbars', kicker: 'Most active weekday',
        big: r.topWeekday.name + 's', bigLabel: '',
        bars: r.weekdayTotals.map((n, i) => ({ label: DAY_LETTERS[i], count: n, best: i === r.topWeekday.monFirst })),
        line: r.topWeekday.share >= 25
          ? r.topWeekday.share + '% of your month happened on a ' + r.topWeekday.name + '.'
          : 'You spread the work across the week, and ' + r.topWeekday.name + 's edged ahead.'
      });
    }
    slides.push({
      id: 'month-active', tone: 'frost', layout: 'calendar', kicker: 'Active days',
      big: r.activeDays, bigLabel: plural(r.activeDays, 'day you showed up', 'days you showed up'),
      calendar: r.days.map(d => ({ date: d.date, day: parseDate(d.date).getDate(), weekday: d.weekday, count: d.count, met: d.met, rest: d.rest, future: d.future })),
      line: r.goalDays > 0 ? 'You hit your goal on ' + r.goalDays + plural(r.goalDays, ' of them.', ' of them.') : 'Every one of them counts.'
    });
    if (r.companies && r.companies.count > 0) {
      const extraN = r.companies.count - r.companies.names.length;
      slides.push({
        id: 'month-companies', tone: 'success', layout: 'names', kicker: 'Companies',
        big: r.companies.count, bigLabel: plural(r.companies.count, 'company you applied to', 'companies you applied to'),
        names: r.companies.names,
        line: extraN > 0 ? 'Plus ' + extraN + ' more. That is a lot of doors knocked on.' : 'Each one is a real door you knocked on.'
      });
    }
    if (r.stages && r.jobsTotal > 0) {
      const label = typeof ctx.statusLabel === 'function' ? ctx.statusLabel : (id => id);
      slides.push({
        id: 'month-stages', tone: 'accent', layout: 'stages', kicker: 'Where they stand',
        big: r.moving > 0 ? r.moving : r.jobsTotal,
        bigLabel: r.moving > 0 ? 'moving forward' : plural(r.jobsTotal, 'application out there', 'applications out there'),
        stages: r.stages.filter(s => s.count > 0).map(s => {
          let l = s.id;
          try { l = label(s.id) || s.id; } catch (e) { l = s.id; }
          // "Closed" reads gentler than "Archived / Rejected" in a recap.
          if (s.id === 'rejected') l = 'Closed';
          return { id: s.id, label: l, count: s.count };
        }),
        line: r.moving > 0 ? 'Replies are coming in. Keep the follow-ups going.' : 'Replies take time. Each one is still a real chance.'
      });
    }
    if (r.bestRun) {
      slides.push({
        id: 'month-run', tone: 'flame', layout: 'flame', kicker: 'Best streak',
        big: r.bestRun.days, bigLabel: r.bestRun.kind === 'goal' ? 'days in a row at your goal' : 'active days in a row',
        line: shortDate(r.bestRun.start) + ' to ' + shortDate(r.bestRun.end) + '. That is what momentum looks like.'
      });
    }
    slides.push({
      id: 'month-close', tone: 'tracker', layout: 'close', kicker: 'That is your month', title,
      big: r.total, bigLabel: unitOf(ctx, r.total) + ' ' + verb,
      line: month.past ? 'A new month is a fresh start. Keep it rolling.' : 'Plenty of month left. Keep it rolling.',
      buddy: true,
      share: {
        metricId: ctx.metricId, bigNumber: r.total,
        bigLabel: unitOf(ctx, r.total) + ' in ' + month.name,
        milestoneTitle: month.name + ' in review'
      }
    });
    return slides;
  }

  // Slides for one story kind. extra: { jobs } for the month deck. The buddy
  // waves on each story's first slide and on its last when it has several.
  function slidesFor(kind, ctx, extra) {
    let slides = [];
    if (kind === 'today') slides = todaySlides(ctx);
    else if (kind === 'week') slides = weekSlides(ctx);
    else if (kind === 'streak') slides = streakSlides(ctx);
    else if (kind === 'milestone') slides = milestoneSlides(ctx);
    else if (kind === 'month') slides = monthSlides(ctx, extra);
    if (slides.length) {
      slides[0].buddy = true;
      if (slides.length > 2) slides[slides.length - 1].buddy = true;
    }
    return slides;
  }

  function sentence(s) {
    const t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return /[.!?]$/.test(t) ? t : t + '.';
  }

  // What the live region reads for a slide: the words on it, in order.
  function slideText(slide) {
    if (!slide) return '';
    const bits = [];
    bits.push(slide.kicker);
    if (slide.title && slide.layout === 'open') bits.push(slide.title);
    const big = slide.big === undefined || slide.big === null ? '' : String(slide.big);
    if (big || slide.bigLabel) bits.push([big, slide.bigLabel].filter(Boolean).join(' '));
    if (slide.title && slide.layout !== 'open') bits.push(slide.title);
    if (slide.quote) bits.push(slide.quote);
    if (slide.chip) bits.push(slide.chip);
    if (Array.isArray(slide.names) && slide.names.length) bits.push(slide.names.join(', '));
    if (Array.isArray(slide.stages) && slide.stages.length) bits.push(slide.stages.map(s => s.label + ' ' + s.count).join(', '));
    if (Array.isArray(slide.stats)) bits.push(slide.stats.map(s => s.value + ' ' + s.label).join('. '));
    bits.push(slide.line);
    bits.push(slide.note);
    return bits.map(sentence).filter(Boolean).join(' ');
  }

  // ----- Slide timer ------------------------------------------------------------
  // A pure state machine over (story, slide). The viewer feeds it ticks and
  // gestures; `changed` says what to redraw: 'slide', 'story', 'restart',
  // 'close', or null.
  function timerInit(opts) {
    const o = opts || {};
    const stories = Math.max(1, int(o.stories) || 1);
    return {
      stories,
      story: Math.min(stories - 1, int(o.story)),
      slide: 0,
      slides: Math.max(1, int(o.slides) || 1),
      elapsed: 0,
      duration: Math.max(500, int(o.duration) || SLIDE_MS),
      paused: false,
      held: false,
      hidden: false,
      modal: false,
      loading: false,
      closed: false,
      changed: 'story'
    };
  }

  function timerRunning(s) {
    return !!s && !s.closed && !s.paused && !s.held && !s.hidden && !s.modal && !s.loading;
  }

  function timerProgress(s) {
    return s && s.duration ? Math.max(0, Math.min(1, s.elapsed / s.duration)) : 0;
  }

  function goNext(n) {
    n.elapsed = 0;
    if (n.slide + 1 < n.slides) {
      n.slide++;
      n.changed = 'slide';
    } else if (n.story + 1 < n.stories) {
      n.story++;
      n.slide = 0;
      n.slides = 1;
      n.changed = 'story';
    } else {
      n.closed = true;
      n.changed = 'close';
    }
    return n;
  }

  function goPrev(n) {
    n.elapsed = 0;
    if (n.slide > 0) {
      n.slide--;
      n.changed = 'slide';
    } else if (n.story > 0) {
      n.story--;
      n.slide = 0;
      n.slides = 1;
      n.changed = 'story';
    } else {
      n.changed = 'restart';
    }
    return n;
  }

  function timerStep(state, action) {
    const n = Object.assign({}, state, { changed: null });
    const a = action || {};
    if (state.closed) return n;
    switch (a.type) {
      case 'tick':
        if (!timerRunning(state)) return n;
        n.elapsed = state.elapsed + Math.max(0, Number(a.dt) || 0);
        return n.elapsed >= n.duration ? goNext(n) : n;
      case 'next': return goNext(n);
      case 'prev': return goPrev(n);
      case 'toggle': n.paused = !state.paused; return n;
      case 'pause': n.paused = true; return n;
      case 'play': n.paused = false; return n;
      case 'hold': n.held = !!a.on; return n;
      case 'hidden': n.hidden = !!a.on; return n;
      case 'modal': n.modal = !!a.on; return n;
      case 'loading': n.loading = !!a.on; return n;
      case 'slides':
        n.slides = Math.max(1, int(a.count) || 1);
        if (n.slide >= n.slides) n.slide = n.slides - 1;
        return n;
      case 'close': n.closed = true; n.changed = 'close'; return n;
      default: return n;
    }
  }

  // Ease-out count-up: the value shown t (0..1) of the way through.
  function countUpValue(target, t) {
    const to = Number(target) || 0;
    const p = Math.max(0, Math.min(1, Number(t) || 0));
    if (p >= 1) return to;
    return Math.round(to * (1 - Math.pow(1 - p, 3)));
  }

  return {
    SEEN_KEY,
    PREF_KEY,
    SLIDE_MS,
    SLIDE_MS_REDUCED,
    COUNT_MS,
    MILESTONES,
    STAGES,
    addDays,
    weekStartOf,
    weekdayOf,
    shortDate,
    hashString,
    isUnseen,
    markSeen,
    weekData,
    weekStory,
    pickMonth,
    monthReview,
    longestRun,
    localMilestones,
    newestMilestone,
    listStories,
    slidesFor,
    slideText,
    timerInit,
    timerStep,
    timerRunning,
    timerProgress,
    countUpValue
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LitStories;

// ---------------------------------------------------------------------------
// Browser wiring: the ring row and the viewer. Popup only.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof LitPopup !== 'undefined') {
  (() => {
    const S = LitStories;
    const NS = 'http://www.w3.org/2000/svg';
    const HOLD_MS = 220;
    const SWIPE_CLOSE_PX = 90;

    const ICONS = {
      flame: '<svg viewBox="0 0 14 14" aria-hidden="true" focusable="false"><path d="M7 12.6c2.5 0 4-1.6 4-3.8 0-1.8-1-3-1.8-4.1.1 1.1-.5 1.7-1 1.7.4-1.8-.3-3.4-1.8-4.7-.1 1.4-.8 2.6-1.8 3.6-.9.9-1.4 2-1.4 3.3 0 2.2 1.4 4 3.8 4z" fill="currentColor"/></svg>',
      medal: '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M6.2 1.8h7.6l-2.3 5H8.5z" fill="currentColor" opacity="0.55"/><circle cx="10" cy="12" r="5.6" fill="currentColor"/><path d="m10 8.9.95 1.95 2.15.3-1.55 1.5.37 2.13L10 13.8l-1.92 1 .37-2.14-1.55-1.5 2.15-.3z" fill="var(--lst-medal-star, #fff)"/></svg>',
      moon: '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M15.5 12.6A6.5 6.5 0 0 1 7.4 4.5a6.5 6.5 0 1 0 8.1 8.1z" fill="currentColor"/></svg>',
      pause: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/></svg>',
      play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 2.8v10.4a.7.7 0 0 0 1.06.6l8.2-5.2a.7.7 0 0 0 0-1.2l-8.2-5.2a.7.7 0 0 0-1.06.6z" fill="currentColor"/></svg>',
      close: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>',
      left: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3.5 5.5 8l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      right: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      share: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 10V2.5M5 5.2 8 2.2l3 3M3.2 8.5v4.3c0 .4.3.7.7.7h8.2c.4 0 .7-.3.7-.7V8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
      arm: '<svg class="lst-arm-svg" viewBox="0 0 44 48" aria-hidden="true" focusable="false"><path class="lst-arm" d="M35.5 29.5c3.2-1.6 5.2-4.6 5.6-8.6" fill="none" stroke-width="4.2" stroke-linecap="round"/></svg>'
    };

    let seen = {};
    let seenLoaded = false;
    let rowSig = '';
    let stories = [];
    let storyCtx = null;
    let rowMetric = null;
    const msCache = {};
    const msPending = {};
    let viewer = null;

    const enabled = () => LitPopup.modulePref(S.PREF_KEY, true) !== false;
    const api = () => LitPopup.api;

    function reduced() {
      const a = api();
      if (a && a.reduceMotion) return true;
      if (document.documentElement.dataset.motion === 'reduce') return true;
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function make(tag, cls, text) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
      return n;
    }

    function readableOn(hex) {
      const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return '#ffffff';
      const v = parseInt(m[1], 16);
      const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      const L = 0.2126 * lin(v >> 16) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
      return L > 0.208 ? '#202124' : '#ffffff';
    }

    function setTracker(node, metric) {
      if (!node || !metric || !/^#[0-9a-f]{6}$/i.test(metric.color || '')) return;
      node.style.setProperty('--tracker', metric.color);
      node.style.setProperty('--on-tracker', readableOn(metric.color));
    }

    function idle(fn) {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1500 });
      else setTimeout(fn, 300);
    }

    // ----- Seen state ----------------------------------------------------------
    function loadSeen() {
      return new Promise(resolve => {
        try {
          chrome.storage.local.get([S.SEEN_KEY], r => {
            const v = r && r[S.SEEN_KEY];
            seen = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
            seenLoaded = true;
            resolve();
          });
        } catch (e) {
          seenLoaded = true;
          resolve();
        }
      });
    }

    function saveSeen(story) {
      if (!story || !S.isUnseen(seen, story)) return;
      seen = S.markSeen(seen, story);
      try { chrome.storage.local.set({ [S.SEEN_KEY]: seen }); } catch (e) { /* not fatal */ }
    }

    // ----- Context ---------------------------------------------------------------
    function contextFor(metric) {
      const a = api();
      const st = (a && a.stats) || {};
      const id = metric.id;
      const total = (st.totals && st.totals[id]) || 0;
      const cached = msCache[id] && msCache[id].sig === String(total) ? msCache[id].data : null;
      const ctx = {
        metricId: id,
        isJobs: id === 'jobs',
        unit: n => a.displayUnit(metric, n),
        goal: a.goalFor(metric),
        todayStr: st.todayStr || a.todayStr(),
        dailyMap: st.dailyMap || {},
        voice: a.prefs && a.prefs.coachVoice,
        streak: (st.streaks && st.streaks[id]) || 0,
        longest: (st.longestStreaks && st.longestStreaks[id]) || 0,
        freezes: (st.freezes && st.freezes[id] && st.freezes[id].available) || 0,
        restDays: st.restDays || [],
        restToday: !!st.restToday,
        total,
        friendlyDate: a.friendlyDate,
        statusLabel: sid => a.statusMeta(sid).label,
        statusOf: a.statusOf,
        normalizeCompany: typeof TrackerStorage !== 'undefined' ? TrackerStorage.normalizeCompany : null
      };
      ctx.milestones = cached || S.localMilestones(ctx.dailyMap, id, ctx);
      return ctx;
    }

    // The authoritative milestones (with the first interview), once per
    // goal and total, at idle time.
    function refreshMilestones(metric, total) {
      const id = metric.id;
      const sig = String(total || 0);
      if ((msCache[id] && msCache[id].sig === sig) || msPending[id] === sig) return;
      if (typeof TrackerStorage === 'undefined' || typeof TrackerStorage.getMilestones !== 'function') return;
      msPending[id] = sig;
      idle(() => {
        TrackerStorage.getMilestones(id).then(data => {
          msCache[id] = { sig, data: data && Array.isArray(data.reached) ? data : null };
        }).catch(() => {
          msCache[id] = { sig, data: null };
        }).then(() => {
          delete msPending[id];
          if (rowMetric && rowMetric.id === id && !viewer) renderRow(rowMetric);
        });
      });
    }

    // ----- Ring row ------------------------------------------------------------
    function faceNode(story) {
      const f = story.face || {};
      const face = make('span', 'lst-face lst-face-' + f.type);
      face.setAttribute('aria-hidden', 'true');
      if (f.type === 'count') {
        face.appendChild(make('span', 'lst-face-num', f.count));
        face.appendChild(make('span', 'lst-face-of', '/' + f.goal));
      } else if (f.type === 'rest') {
        face.innerHTML = ICONS.moon;
      } else if (f.type === 'bars') {
        const max = Math.max(1, Math.max.apply(null, f.values));
        const chart = make('span', 'lst-face-chart');
        f.values.forEach(v => {
          const bar = make('i');
          bar.style.height = (v > 0 ? Math.round(5 + (v / max) * 17) : 2) + 'px';
          if (v > 0) bar.className = 'on';
          chart.appendChild(bar);
        });
        face.appendChild(chart);
      } else if (f.type === 'flame') {
        face.innerHTML = ICONS.flame;
        if (f.value > 0) face.appendChild(make('span', 'lst-face-num', f.value));
      } else if (f.type === 'medal') {
        face.innerHTML = ICONS.medal;
      } else if (f.type === 'month') {
        face.appendChild(make('span', 'lst-face-month', f.text));
      }
      return face;
    }

    function renderRow(metricArg) {
      const host = document.getElementById('stories-host');
      if (!host) return;
      if (!enabled()) {
        if (host.firstChild) host.textContent = '';
        rowSig = '';
        return;
      }
      const a = api();
      if (!a || !a.stats || !seenLoaded) return;
      const metric = (metricArg && metricArg.id ? a.metricById(metricArg.id) || metricArg : null) || a.activeMetric;
      if (!metric) return;
      rowMetric = metric;
      const ctx = contextFor(metric);
      const list = S.listStories(ctx);
      stories = list;
      storyCtx = ctx;
      refreshMilestones(metric, ctx.total);
      const sig = metric.id + '|' + (metric.color || '') + '|' + list.map(s => s.id + ':' + s.hash + ':' + (S.isUnseen(seen, s) ? 1 : 0)).join(',');
      if (sig === rowSig && (host.firstChild || !list.length)) return;
      rowSig = sig;
      host.textContent = '';
      if (!list.length) return;
      const row = make('div', 'lst-row');
      row.setAttribute('role', 'list');
      row.setAttribute('aria-label', 'Stories');
      setTracker(row, metric);
      list.forEach((story, i) => {
        const item = make('div', 'lst-item');
        item.setAttribute('role', 'listitem');
        const unseen = S.isUnseen(seen, story);
        const btn = make('button', 'lst-ring' + (unseen ? ' is-unseen' : ''));
        btn.type = 'button';
        btn.dataset.storyId = story.id;
        btn.setAttribute('aria-label', story.label + (unseen ? ', new story. ' : ' story. ') + story.aria);
        const halo = make('span', 'lst-halo');
        halo.appendChild(faceNode(story));
        btn.appendChild(halo);
        btn.appendChild(make('span', 'lst-label', story.label));
        btn.addEventListener('click', () => openViewer(i, btn));
        if (story.kind === 'month' && ctx.isJobs) {
          const warm = () => { try { a.jobs().catch(() => {}); } catch (e) { /* ignore */ } };
          btn.addEventListener('pointerenter', warm, { once: true });
          btn.addEventListener('focus', warm, { once: true });
        }
        item.appendChild(btn);
        row.appendChild(item);
      });
      host.appendChild(row);
    }

    // ----- Viewer --------------------------------------------------------------
    function buddyNode() {
      const a = api();
      if ((a && a.prefs && a.prefs.buddyEnabled === false) || typeof LitBuddy === 'undefined' || typeof LitBuddy.svg !== 'function') return null;
      const wrap = make('div', 'lst-buddy');
      wrap.setAttribute('aria-hidden', 'true');
      wrap.innerHTML = LitBuddy.svg() + ICONS.arm;
      return wrap;
    }

    function bigNode(slide, countUps) {
      const hero = make('div', 'lst-hero');
      const hasBig = slide.big !== undefined && slide.big !== null && slide.big !== '';
      if (hasBig) {
        const isNum = typeof slide.big === 'number';
        const big = make('span', 'lst-big' + (isNum ? '' : ' is-text'));
        if (isNum) {
          big.textContent = countUps ? '0' : String(slide.big);
          if (countUps) countUps.push({ el: big, to: slide.big, start: null });
        } else {
          big.textContent = slide.big;
        }
        hero.appendChild(big);
      }
      if (slide.bigLabel) hero.appendChild(make('span', 'lst-big-label', slide.bigLabel));
      return hasBig || slide.bigLabel ? hero : null;
    }

    function ringVisual(slide, animate, countUps) {
      const r = slide.ring;
      const pct = Math.max(0, Math.min(1, r.count / Math.max(1, r.goal)));
      const wrap = make('div', 'lst-progress-ring');
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 120 120');
      svg.setAttribute('aria-hidden', 'true');
      const C = 2 * Math.PI * 52;
      const track = document.createElementNS(NS, 'circle');
      track.setAttribute('class', 'lst-ring-track');
      const arc = document.createElementNS(NS, 'circle');
      arc.setAttribute('class', 'lst-ring-arc');
      [track, arc].forEach(c => {
        c.setAttribute('cx', '60'); c.setAttribute('cy', '60'); c.setAttribute('r', '52');
      });
      arc.setAttribute('stroke-dasharray', String(C));
      arc.setAttribute('stroke-dashoffset', String(animate ? C : C * (1 - pct)));
      svg.appendChild(track);
      svg.appendChild(arc);
      wrap.appendChild(svg);
      const mid = make('span', 'lst-ring-mid');
      const num = make('span', 'lst-ring-num', animate && countUps ? '0' : r.count);
      if (animate && countUps) countUps.push({ el: num, to: r.count, start: null });
      mid.appendChild(num);
      mid.appendChild(make('span', 'lst-ring-of', 'of ' + r.goal));
      wrap.appendChild(mid);
      if (animate) {
        requestAnimationFrame(() => requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(C * (1 - pct)))));
      }
      return wrap;
    }

    function barsVisual(slide, weekly) {
      const box = make('div', 'lst-bars-chart' + (weekly ? ' is-weekday' : ''));
      const max = Math.max(1, Math.max.apply(null, slide.bars.map(b => b.count)));
      slide.bars.forEach((b, i) => {
        const col = make('div', 'lst-col' + (b.best ? ' is-best' : '') + (b.isToday ? ' is-today' : '') + (b.future ? ' is-future' : ''));
        col.style.setProperty('--i', i);
        col.appendChild(make('span', 'lst-col-n', b.count > 0 ? b.count : ''));
        const track = make('span', 'lst-col-track');
        const bar = make('span', 'lst-col-bar');
        bar.style.setProperty('--h', (b.count > 0 ? Math.max(8, Math.round((b.count / max) * 100)) : 4) + '%');
        track.appendChild(bar);
        col.appendChild(track);
        col.appendChild(make('span', 'lst-col-l', b.label));
        box.appendChild(col);
      });
      box.setAttribute('aria-hidden', 'true');
      return box;
    }

    function calendarVisual(slide) {
      const box = make('div', 'lst-cal');
      box.setAttribute('aria-hidden', 'true');
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(l => box.appendChild(make('span', 'lst-cal-h', l)));
      const lead = slide.calendar.length ? (slide.calendar[0].weekday + 6) % 7 : 0;
      for (let i = 0; i < lead; i++) box.appendChild(make('span', 'lst-cal-pad'));
      slide.calendar.forEach(d => {
        const cls = d.future ? 'is-future' : d.met ? 'is-met' : d.count > 0 ? 'is-on' : d.rest ? 'is-rest' : 'is-off';
        box.appendChild(make('span', 'lst-cal-d ' + cls, d.day));
      });
      return box;
    }

    function stagesVisual(slide) {
      const box = make('div', 'lst-stages');
      const max = Math.max(1, Math.max.apply(null, slide.stages.map(s => s.count)));
      slide.stages.forEach(s => {
        const row = make('div', 'lst-stage-row');
        row.style.setProperty('--stage', 'var(--stage-' + s.id + ', var(--accent))');
        row.appendChild(make('span', 'lst-stage-l', s.label));
        const track = make('span', 'lst-stage-track');
        const fill = make('span', 'lst-stage-fill');
        fill.style.setProperty('--w', Math.max(6, Math.round((s.count / max) * 100)) + '%');
        track.appendChild(fill);
        row.appendChild(track);
        row.appendChild(make('span', 'lst-stage-n', s.count));
        box.appendChild(row);
      });
      return box;
    }

    function statsVisual(slide) {
      const box = make('div', 'lst-stats');
      slide.stats.forEach(s => {
        const row = make('div', 'lst-stat');
        row.appendChild(make('span', 'lst-stat-v' + (s.text ? ' is-text' : ''), s.value));
        row.appendChild(make('span', 'lst-stat-l', s.label));
        box.appendChild(row);
      });
      return box;
    }

    function slideNode(slide, opts) {
      const node = make('section', 'lst-slide');
      node.dataset.layout = slide.layout;
      const animate = !opts.reduce;
      const top = make('div', 'lst-slide-top');
      top.appendChild(make('p', 'lst-kicker', slide.kicker));
      if (slide.title && (slide.layout === 'open' || slide.layout === 'close')) top.appendChild(make('h2', 'lst-title lst-title-xl', slide.title));
      node.appendChild(top);

      const main = make('div', 'lst-slide-main');
      if (slide.layout === 'ring') {
        main.appendChild(ringVisual(slide, animate, opts.countUps));
        if (slide.bigLabel) main.appendChild(make('p', 'lst-big-label', slide.bigLabel));
      } else if (slide.layout === 'quote') {
        main.appendChild(make('p', 'lst-quote', slide.quote));
        if (slide.chip) main.appendChild(make('span', 'lst-chip', slide.chip));
      } else if (slide.layout === 'medal' || slide.layout === 'flame' || slide.layout === 'rest') {
        const icon = make('div', 'lst-emblem lst-emblem-' + slide.layout);
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = slide.layout === 'medal' ? ICONS.medal : slide.layout === 'flame' ? ICONS.flame : ICONS.moon;
        main.appendChild(icon);
        const hero = bigNode(slide, animate ? opts.countUps : null);
        if (hero) main.appendChild(hero);
      } else {
        const hero = bigNode(slide, animate ? opts.countUps : null);
        if (hero) main.appendChild(hero);
      }
      if (slide.title && !(slide.layout === 'open' || slide.layout === 'close')) main.appendChild(make('h2', 'lst-title', slide.title));
      if (slide.layout === 'bars') main.appendChild(barsVisual(slide, false));
      if (slide.layout === 'weekbars') main.appendChild(barsVisual(slide, true));
      if (slide.layout === 'calendar') main.appendChild(calendarVisual(slide));
      if (slide.layout === 'stages') main.appendChild(stagesVisual(slide));
      if (slide.layout === 'stats') main.appendChild(statsVisual(slide));
      if (slide.layout === 'names' && slide.names.length) {
        const list = make('ul', 'lst-names');
        slide.names.forEach(n => list.appendChild(make('li', 'lst-name', n)));
        main.appendChild(list);
      }
      if (slide.layout === 'progress') {
        const bar = make('div', 'lst-meter');
        bar.setAttribute('aria-hidden', 'true');
        const fill = make('span', 'lst-meter-fill');
        fill.style.setProperty('--w', Math.round(slide.progress * 100) + '%');
        bar.appendChild(fill);
        main.appendChild(bar);
        const ends = make('div', 'lst-meter-ends');
        ends.setAttribute('aria-hidden', 'true');
        ends.appendChild(make('span', '', slide.progressFrom));
        ends.appendChild(make('span', '', slide.progressTo));
        main.appendChild(ends);
      }
      if (slide.line) main.appendChild(make('p', 'lst-line', slide.line));
      if (slide.note) main.appendChild(make('p', 'lst-note', slide.note));
      if (slide.share) {
        const share = make('button', 'lst-share');
        share.type = 'button';
        share.innerHTML = ICONS.share;
        share.appendChild(make('span', '', 'Share'));
        share.setAttribute('aria-label', 'Share ' + (slide.share.milestoneTitle || 'this'));
        share.addEventListener('click', e => {
          e.stopPropagation();
          opts.onShare(slide.share);
        });
        main.appendChild(share);
      }
      node.appendChild(main);

      const foot = make('div', 'lst-slide-foot');
      if (slide.buddy) {
        const b = buddyNode();
        if (b) foot.appendChild(b);
      }
      if (foot.firstChild) node.appendChild(foot);
      return node;
    }

    function openViewer(startIndex, opener) {
      const host = document.getElementById('overlay-host');
      const a = api();
      if (!host || !a || !stories.length) return;
      if (viewer) viewer.close(false);
      const list = stories.slice();
      const ctx = storyCtx;
      const metric = rowMetric;
      const reduce = reduced();
      const built = {};
      const loadingFor = {};
      let state = S.timerInit({ stories: list.length, story: startIndex, duration: reduce ? S.SLIDE_MS_REDUCED : S.SLIDE_MS });
      state = S.timerStep(state, { type: 'hidden', on: document.hidden });
      state = S.timerStep(state, { type: 'modal', on: !!a.openModalId });
      let raf = 0;
      let lastTs = 0;
      let countUps = [];
      let segments = [];
      let closed = false;
      const returnId = opener && opener.dataset ? opener.dataset.storyId : null;
      const returnEl = opener || document.activeElement;

      const root = make('div', 'lst-viewer');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.tabIndex = -1;
      setTracker(root, metric);
      if (reduce) root.classList.add('is-reduced');
      const backdrop = make('div', 'lst-backdrop');
      backdrop.setAttribute('aria-hidden', 'true');
      backdrop.appendChild(make('span', 'lst-blob lst-blob-a'));
      backdrop.appendChild(make('span', 'lst-blob lst-blob-b'));
      root.appendChild(backdrop);

      const head = make('div', 'lst-head');
      const bars = make('div', 'lst-segments');
      bars.setAttribute('aria-hidden', 'true');
      head.appendChild(bars);
      const bar2 = make('div', 'lst-headrow');
      const who = make('div', 'lst-who');
      const whoName = make('span', 'lst-who-name');
      const whoSub = make('span', 'lst-who-sub');
      who.appendChild(whoName);
      who.appendChild(whoSub);
      bar2.appendChild(who);
      const pauseBtn = make('button', 'lst-icon-btn lst-pause');
      pauseBtn.type = 'button';
      const closeBtn = make('button', 'lst-icon-btn lst-close');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close stories');
      closeBtn.innerHTML = ICONS.close;
      bar2.appendChild(pauseBtn);
      bar2.appendChild(closeBtn);
      head.appendChild(bar2);
      root.appendChild(head);

      const stage = make('div', 'lst-stage');
      root.appendChild(stage);
      const prevBtn = make('button', 'lst-nav lst-nav-prev');
      prevBtn.type = 'button';
      prevBtn.setAttribute('aria-label', 'Previous');
      prevBtn.innerHTML = ICONS.left;
      const nextBtn = make('button', 'lst-nav lst-nav-next');
      nextBtn.type = 'button';
      nextBtn.setAttribute('aria-label', 'Next');
      nextBtn.innerHTML = ICONS.right;
      root.appendChild(prevBtn);
      root.appendChild(nextBtn);
      const live = make('div', 'sr-only');
      live.setAttribute('aria-live', 'polite');
      live.setAttribute('aria-atomic', 'true');
      root.appendChild(live);

      function paintPause() {
        const paused = state.paused;
        pauseBtn.innerHTML = paused ? ICONS.play : ICONS.pause;
        pauseBtn.setAttribute('aria-label', paused ? 'Play stories' : 'Pause stories');
        pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
        root.classList.toggle('is-paused', paused || state.held);
      }

      function paintProgress() {
        const p = S.timerProgress(state);
        segments.forEach((seg, i) => {
          const v = i < state.slide ? 1 : i === state.slide ? p : 0;
          seg.style.transform = 'scaleX(' + v.toFixed(4) + ')';
        });
      }

      function buildSegments(n) {
        bars.textContent = '';
        segments = [];
        for (let i = 0; i < n; i++) {
          const seg = make('span', 'lst-seg');
          const fill = make('i');
          seg.appendChild(fill);
          bars.appendChild(seg);
          segments.push(fill);
        }
      }

      function renderSlide() {
        const story = list[state.story];
        const slides = built[state.story] || [];
        const slide = slides[state.slide];
        countUps = [];
        if (!slide) return;
        root.dataset.tone = slide.tone || 'accent';
        root.dataset.kind = story.kind;
        root.setAttribute('aria-label', story.label + ' story, ' + (state.slide + 1) + ' of ' + slides.length);
        const node = slideNode(slide, { reduce, countUps, onShare: share });
        if (!reduce) node.classList.add('lst-enter');
        stage.textContent = '';
        stage.appendChild(node);
        live.textContent = (state.slide === 0 ? story.label + '. ' : '') + S.slideText(slide);
        paintProgress();
      }

      function renderLoading() {
        stage.textContent = '';
        const node = make('section', 'lst-slide');
        node.dataset.layout = 'loading';
        const main = make('div', 'lst-slide-main');
        main.appendChild(make('p', 'lst-kicker', 'Your month'));
        main.appendChild(make('p', 'lst-line', 'Gathering your month...'));
        node.appendChild(main);
        stage.appendChild(node);
      }

      function enterStory() {
        const idx = state.story;
        const story = list[idx];
        whoName.textContent = story.label;
        whoSub.textContent = metric ? metric.name || '' : '';
        saveSeen(story);
        if (built[idx]) {
          state = S.timerStep(state, { type: 'slides', count: built[idx].length });
          buildSegments(built[idx].length);
          renderSlide();
          return;
        }
        if (story.kind === 'month' && ctx.isJobs) {
          if (loadingFor[idx]) return;
          loadingFor[idx] = true;
          state = S.timerStep(state, { type: 'loading', on: true });
          buildSegments(1);
          renderLoading();
          let jobsP;
          try { jobsP = Promise.resolve(a.jobs()); } catch (e) { jobsP = Promise.reject(e); }
          jobsP.then(jobs => jobs, () => null).then(jobs => {
            built[idx] = S.slidesFor('month', ctx, { jobs });
            loadingFor[idx] = false;
            if (closed) return;
            state = S.timerStep(state, { type: 'loading', on: false });
            if (state.story !== idx) return;
            if (!built[idx].length) { dispatch({ type: 'next' }); return; }
            enterStory();
            ensureLoop();
          });
          return;
        }
        built[idx] = S.slidesFor(story.kind, ctx, {});
        if (!built[idx].length) {
          // Nothing to show after all (data moved on): skip it.
          built[idx] = null;
          dispatch({ type: 'next' });
          return;
        }
        enterStory();
      }

      function handleChange() {
        if (state.changed === 'close') { close(true); return; }
        if (state.changed === 'story') enterStory();
        else if (state.changed === 'slide' || state.changed === 'restart') renderSlide();
      }

      function dispatch(action) {
        if (closed) return;
        state = S.timerStep(state, action);
        handleChange();
        if (closed) return;
        paintProgress();
        paintPause();
        ensureLoop();
      }

      function stepCountUps(ts) {
        if (!countUps.length) return false;
        countUps = countUps.filter(c => {
          if (!c.el.isConnected) return false;
          if (c.start === null) c.start = ts;
          const t = (ts - c.start) / S.COUNT_MS;
          c.el.textContent = String(S.countUpValue(c.to, t));
          return t < 1;
        });
        return countUps.length > 0;
      }

      function frame(ts) {
        raf = 0;
        if (closed) return;
        const dt = lastTs ? Math.min(100, ts - lastTs) : 0;
        lastTs = ts;
        if (S.timerRunning(state)) {
          state = S.timerStep(state, { type: 'tick', dt });
          handleChange();
          if (closed) return;
        }
        paintProgress();
        const counting = stepCountUps(ts);
        if (S.timerRunning(state) || counting) raf = requestAnimationFrame(frame);
        else lastTs = 0;
      }

      function ensureLoop() {
        if (closed || raf) return;
        if (!S.timerRunning(state) && !countUps.length) return;
        lastTs = 0;
        raf = requestAnimationFrame(frame);
      }

      function share(ctxShare) {
        close(true);
        try {
          if (a && typeof a.openShare === 'function') a.openShare(ctxShare);
        } catch (e) {
          if (a && a.oops) a.oops('Sharing is not available just now.', e);
        }
      }

      function focusables() {
        return Array.prototype.filter.call(root.querySelectorAll('button:not([disabled])'), n => n.offsetParent !== null);
      }

      function onKey(e) {
        // A popup dialog above the viewer owns the keyboard while it is open.
        if (closed || state.modal) return;
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          close(true);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault(); e.stopPropagation();
          dispatch({ type: 'next' });
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault(); e.stopPropagation();
          dispatch({ type: 'prev' });
        } else if (e.key === ' ' || e.key === 'Spacebar') {
          if (e.target && e.target.closest && e.target.closest('button')) return;
          e.preventDefault(); e.stopPropagation();
          dispatch({ type: 'toggle' });
        } else if (e.key === 'Tab') {
          const items = focusables();
          if (!items.length) { e.preventDefault(); return; }
          const first = items[0];
          const last = items[items.length - 1];
          const inside = root.contains(document.activeElement);
          if (!inside || document.activeElement === root) {
            e.preventDefault();
            (e.shiftKey ? last : first).focus();
          } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
          }
          e.stopPropagation();
        }
      }

      // Tap left third: back; anywhere else: forward. Press and hold pauses;
      // a vertical drag down closes; a horizontal swipe moves too.
      let ptr = null;
      function endPointer(e, cancelled) {
        if (!ptr || (e && e.pointerId !== ptr.id)) return;
        clearTimeout(ptr.timer);
        const p = ptr;
        ptr = null;
        root.classList.remove('is-dragging');
        if (p.drag) {
          const dy = e ? e.clientY - p.y : 0;
          if (!cancelled && dy > SWIPE_CLOSE_PX) { close(true); return; }
          root.style.transform = '';
          root.style.opacity = '';
          dispatch({ type: 'hold', on: false });
          return;
        }
        if (p.held) { dispatch({ type: 'hold', on: false }); return; }
        if (cancelled || !e) return;
        const dx = e.clientX - p.x;
        if (Math.abs(dx) > 48) { dispatch({ type: dx < 0 ? 'next' : 'prev' }); return; }
        const rect = stage.getBoundingClientRect();
        const rel = rect.width ? (e.clientX - rect.left) / rect.width : 1;
        dispatch({ type: rel < 1 / 3 ? 'prev' : 'next' });
      }

      stage.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (e.target.closest('button, a, input')) return;
        ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, held: false, drag: false, timer: 0 };
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        ptr.timer = setTimeout(() => {
          if (!ptr || ptr.drag) return;
          ptr.held = true;
          dispatch({ type: 'hold', on: true });
        }, HOLD_MS);
      });
      stage.addEventListener('pointermove', e => {
        if (!ptr || e.pointerId !== ptr.id) return;
        const dx = e.clientX - ptr.x;
        const dy = e.clientY - ptr.y;
        if (!ptr.drag && dy > 12 && dy > Math.abs(dx)) {
          ptr.drag = true;
          clearTimeout(ptr.timer);
          root.classList.add('is-dragging');
          if (!ptr.held) dispatch({ type: 'hold', on: true });
        }
        if (ptr.drag) {
          const d = Math.max(0, dy);
          root.style.transform = 'translateY(' + Math.round(d * 0.7) + 'px)';
          root.style.opacity = String(Math.max(0.5, 1 - d / 420));
        }
      });
      stage.addEventListener('pointerup', e => endPointer(e, false));
      stage.addEventListener('pointercancel', e => endPointer(e, true));
      stage.addEventListener('contextmenu', e => e.preventDefault());
      root.addEventListener('wheel', e => e.preventDefault(), { passive: false });

      pauseBtn.addEventListener('click', () => dispatch({ type: 'toggle' }));
      closeBtn.addEventListener('click', () => close(true));
      prevBtn.addEventListener('click', () => dispatch({ type: 'prev' }));
      nextBtn.addEventListener('click', () => dispatch({ type: 'next' }));
      document.addEventListener('keydown', onKey, true);

      function close(restore) {
        if (closed) return;
        closed = true;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.removeEventListener('keydown', onKey, true);
        if (ptr) clearTimeout(ptr.timer);
        root.remove();
        if (viewer === handle) viewer = null;
        // Seen rings go quiet; then focus goes back to the ring that opened it.
        renderRow(rowMetric);
        if (!restore) return;
        let target = null;
        const hostRow = document.getElementById('stories-host');
        if (returnId && hostRow) target = Array.prototype.find.call(hostRow.querySelectorAll('.lst-ring'), b => b.dataset.storyId === returnId) || null;
        if (!target && returnEl && returnEl.isConnected) target = returnEl;
        if (!target && hostRow) target = hostRow.querySelector('.lst-ring');
        if (target && typeof target.focus === 'function') target.focus();
      }

      const handle = {
        close,
        hidden: on => dispatch({ type: 'hidden', on }),
        modal: on => dispatch({ type: 'modal', on })
      };
      viewer = handle;
      host.appendChild(root);
      paintPause();
      root.focus();
      enterStory();
      paintProgress();
      ensureLoop();
    }

    function closeViewer() {
      if (viewer) viewer.close(false);
    }

    // ----- Setup --------------------------------------------------------------
    LitPopup.addSetting({
      id: 'stories',
      label: 'Story rings',
      hint: 'Your day, week, and month as quick stories',
      get: () => enabled(),
      set: async next => {
        await LitPopup.setModulePref(S.PREF_KEY, !!next);
        if (!next) {
          closeViewer();
          const host = document.getElementById('stories-host');
          if (host) host.textContent = '';
          rowSig = '';
        } else {
          rowSig = '';
          renderRow(rowMetric);
        }
      }
    });

    LitPopup.whenReady(a => {
      loadSeen().then(() => renderRow(a && a.activeMetric));
      LitPopup.on('render', d => renderRow(d && d.metric));
      LitPopup.on('modal', d => { if (viewer) viewer.modal(!!(d && d.open)); });
      document.addEventListener('visibilitychange', () => { if (viewer) viewer.hidden(document.hidden); });
    });
  })();
}
