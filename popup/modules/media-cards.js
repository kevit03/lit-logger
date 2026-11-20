// LIT popup module: media cards.
//
// Four card types that borrow interaction patterns from streaming apps
// (a poster row, a ranked top 10, a rotating billboard, a play-style queue)
// and dress them in LIT's own tokens:
//
//   continueRow  "Pick up where you left off"  recent applications as posters
//   top10        "Your top 10"                 best days, companies, or roles
//   spotlight    "Spotlight"                   milestone, today's pick, streak, record
//   upNext       "Up next"                     goals to finish, follow-ups, companies
//
// Talks to the popup only through window.LitPopup (popup/bridge.js). The
// card types register at load time; everything else waits for a render.
// Pure helpers are exported at the bottom for test/media-cards.test.js, and
// the file loads in node without a DOM.
(function () {
  'use strict';

  const HAS_DOM = typeof document !== 'undefined' && typeof window !== 'undefined';
  const FOLLOWUPS_KEY = 'lit_media_followups';
  const PREF_KEY = 'mediaCards';
  const FOLLOW_UP_DAYS = 7;
  const ROW_LIMIT = 12;
  const TOP_LIMIT = 10;
  const SLIDE_MS = 6500;
  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

  // ---------------------------------------------------------------------------
  // Pure helpers (no DOM, no chrome.*)
  // ---------------------------------------------------------------------------
  const STAGE_STEPS = ['applied', 'review', 'interviewing', 'offer'];
  const STAGE_NAMES = { applied: 'Applied', review: 'Under review', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Closed' };
  const RANK_MODES = ['days', 'companies', 'roles'];
  const DEFAULT_RANK = 'days';

  function clean(value, max) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max || 120) : '';
  }

  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  // Mirrors TrackerStorage.normalizeStatus so this file stands alone.
  function normStatus(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (v === 'applied' || v === 'review' || v === 'interviewing' || v === 'offer' || v === 'rejected') return v;
    if (v === 'under review' || v === 'screening') return 'review';
    if (v === 'interview' || v === 'interviews') return 'interviewing';
    if (v === 'archived' || v === 'closed' || v === 'declined') return 'rejected';
    return null;
  }

  function statusOfLog(log) {
    return normStatus(log && log.status) || 'applied';
  }

  // How far an application has moved: Applied 25%, Under review 50%,
  // Interviewing 75%, Offer 100%. Closed is shown full but muted, and never
  // as a failure.
  function stageProgress(status) {
    const id = normStatus(status) || 'applied';
    if (id === 'rejected') {
      return { id, step: 0, steps: STAGE_STEPS.length, pct: 100, muted: true, label: STAGE_NAMES.rejected, note: 'Not this one. On to the next.' };
    }
    const step = STAGE_STEPS.indexOf(id) + 1;
    return {
      id,
      step,
      steps: STAGE_STEPS.length,
      pct: Math.round((step / STAGE_STEPS.length) * 100),
      muted: false,
      label: STAGE_NAMES[id],
      note: id === 'offer' ? 'An offer. Well earned.' : ''
    };
  }

  function nextStage(status) {
    const id = normStatus(status) || 'applied';
    const i = STAGE_STEPS.indexOf(id);
    return i >= 0 && i < STAGE_STEPS.length - 1 ? STAGE_STEPS[i + 1] : null;
  }

  function dayNumber(dateStr) {
    const m = ISO.exec(typeof dateStr === 'string' ? dateStr : '');
    if (!m) return NaN;
    return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
  }

  // Whole calendar days from a to b ('YYYY-MM-DD'); NaN for bad input.
  function daysBetween(a, b) {
    const x = dayNumber(a);
    const y = dayNumber(b);
    return Number.isNaN(x) || Number.isNaN(y) ? NaN : y - x;
  }

  function appliedAgo(days) {
    if (days === null || days === undefined || !Number.isFinite(Number(days))) return 'Applied';
    const n = Math.max(0, Math.floor(Number(days)));
    if (n === 0) return 'Applied today';
    if (n === 1) return 'Applied yesterday';
    if (n < 14) return 'Applied ' + n + ' days ago';
    if (n < 60) return 'Applied ' + Math.round(n / 7) + ' weeks ago';
    const months = Math.round(n / 30);
    return 'Applied ' + months + (months === 1 ? ' month ago' : ' months ago');
  }

  // An application that has sat in Applied for a week or more, has a name to
  // follow up with, and was not marked as followed up yet.
  function needsFollowUp(log, todayStr, followups, afterDays) {
    if (!log || !log.id) return false;
    if (statusOfLog(log) !== 'applied') return false;
    if (!clean(log.company) && !clean(log.role)) return false;
    if (followups && Object.prototype.hasOwnProperty.call(followups, log.id)) return false;
    const d = daysBetween(log.date, todayStr);
    return Number.isFinite(d) && d >= (afterDays || FOLLOW_UP_DAYS);
  }

  // FNV-1a, 32 bit. Deterministic across sessions and machines.
  function hashString(str) {
    let h = 0x811c9dc5;
    const s = String(str === null || str === undefined ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  const MONO_SKIP = new Set(['the', 'inc', 'llc', 'ltd', 'co', 'corp', 'corporation', 'company', 'group', 'of', 'and', 'gmbh', 'plc', 'limited']);

  // "Goldman Sachs" -> "GS", "Stripe" -> "S", "IBM" -> "IBM", "The Acme Co" -> "A".
  function monogramFor(name) {
    const words = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    const useful = words.filter(w => !MONO_SKIP.has(w.toLowerCase()));
    const list = useful.length ? useful : words;
    if (!list.length) return '';
    if (list.length === 1) {
      const w = list[0];
      return w.length <= 3 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w[0].toUpperCase();
    }
    return (list[0][0] + list[1][0]).toUpperCase();
  }

  // Hues and an angle for a poster gradient. The CSS mixes these with theme
  // tokens, so the same company reads well in every style and in dark mode.
  function posterArt(name) {
    const key = String(name || '').trim().toLowerCase();
    const h = hashString(key || 'lit');
    const hue = h % 360;
    const hue2 = (hue + 24 + ((h >>> 9) % 56)) % 360;
    const angle = 110 + ((h >>> 17) % 80);
    return { hue, hue2, angle, mono: monogramFor(name) };
  }

  function countOf(log) {
    return Math.max(1, parseInt(log && log.count, 10) || 1);
  }

  const COMPANY_NOISE = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv|pty|careers?|jobs?|hiring|recruiting|the)\b/g;

  // Same key TrackerStorage uses for duplicate checks, with a local fallback.
  function companyKey(name) {
    if (typeof TrackerStorage !== 'undefined' && TrackerStorage && typeof TrackerStorage.normalizeCompany === 'function') {
      try { return TrackerStorage.normalizeCompany(name); } catch (e) { /* fall through */ }
    }
    const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!base) return '';
    const stripped = base.replace(COMPANY_NOISE, ' ').replace(/\s+/g, '').trim();
    return (stripped || base.replace(/\s+/g, '')).slice(0, 120);
  }

  function finishRank(map, limit) {
    return Array.from(map.values())
      .sort((a, b) => b.value - a.value || a.order - b.order)
      .slice(0, limit || TOP_LIMIT)
      .map((e, i) => ({ key: e.key, label: e.label, value: e.value, rank: i + 1 }));
  }

  // Best days this month for one goal. Ties go to the more recent day.
  function rankDays(dailyMap, metricId, todayStr, limit) {
    const month = String(todayStr || '').slice(0, 7);
    const out = [];
    Object.keys(dailyMap || {}).forEach(date => {
      if (!ISO.test(date) || date.slice(0, 7) !== month || (todayStr && date > todayStr)) return;
      const n = num((dailyMap[date] || {})[metricId]);
      if (n > 0) out.push({ key: date, label: date, value: n });
    });
    out.sort((a, b) => b.value - a.value || (a.key < b.key ? 1 : -1));
    return out.slice(0, limit || TOP_LIMIT).map((r, i) => Object.assign(r, { rank: i + 1 }));
  }

  // Companies with the most applications. Logs arrive newest first, so the
  // label is the most recent spelling and ties go to the most recent.
  function rankCompanies(logs, limit, keyFn) {
    const toKey = typeof keyFn === 'function' ? keyFn : companyKey;
    const map = new Map();
    let order = 0;
    (Array.isArray(logs) ? logs : []).forEach(l => {
      const name = clean(l && l.company, 60);
      if (!name) return;
      const key = toKey(name) || name.toLowerCase();
      let e = map.get(key);
      if (!e) {
        e = { key, label: name, value: 0, order: order++ };
        map.set(key, e);
      }
      e.value += countOf(l);
    });
    return finishRank(map, limit);
  }

  const ROLE_SKIP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'for', 'to', 'in', 'at', 'on', 'with', 'ii', 'iii', 'iv', 'vi', 'sr', 'jr', 'remote', 'hybrid', 'onsite', 'contract', 'temp', 'full', 'part', 'time', 'fulltime', 'parttime']);

  // The distinct, meaningful words in a role title. Short all-caps words
  // (QA, UX, SWE) keep their casing; the rest are title-cased.
  function roleWords(role) {
    const out = [];
    const seen = new Set();
    String(role || '').split(/[^A-Za-z0-9+#]+/).forEach(raw => {
      if (!raw || !/[A-Za-z]/.test(raw)) return;
      const key = raw.toLowerCase();
      if (key.length < 2 || ROLE_SKIP.has(key) || seen.has(key)) return;
      seen.add(key);
      const label = raw.length <= 4 && raw === raw.toUpperCase() ? raw : key.charAt(0).toUpperCase() + key.slice(1);
      out.push({ key, label });
    });
    return out;
  }

  function rankRoles(logs, limit) {
    const map = new Map();
    let order = 0;
    (Array.isArray(logs) ? logs : []).forEach(l => {
      roleWords(l && l.role).forEach(w => {
        let e = map.get(w.key);
        if (!e) {
          e = { key: w.key, label: w.label, value: 0, order: order++ };
          map.set(w.key, e);
        }
        e.value += countOf(l);
      });
    });
    return finishRank(map, limit);
  }

  function rankModesFor(metricId) {
    return metricId === 'jobs' ? RANK_MODES.slice() : [DEFAULT_RANK];
  }

  function effectiveRank(rankBy, metricId) {
    return rankModesFor(metricId).includes(rankBy) ? rankBy : DEFAULT_RANK;
  }

  function rankItems(mode, ctx) {
    const c = ctx || {};
    if (mode === 'companies') return rankCompanies(c.logs, c.limit, c.keyFn);
    if (mode === 'roles') return rankRoles(c.logs, c.limit);
    return rankDays(c.dailyMap, c.metricId, c.todayStr, c.limit);
  }

  // spec.normalize for top10: the rank mode is kept only when it is not the
  // default, so untouched cards store nothing extra.
  function normalizeTop10(input, out) {
    const v = input && input.rankBy;
    if (v === 'companies' || v === 'roles') out.rankBy = v;
    else delete out.rankBy;
  }

  // Poster tiles for the continue row: named applications, newest first,
  // with closed ones moved to the end. Unnamed entries only fill the row
  // when nothing has a name yet.
  function continueTiles(logs, todayStr, followups, limit) {
    const list = (Array.isArray(logs) ? logs : []).filter(l => l && l.id);
    const named = list.filter(l => clean(l.company) || clean(l.role));
    const source = named.length ? named : list;
    const tiles = source.map(l => {
      const company = clean(l.company, 60);
      const role = clean(l.role, 80);
      const status = statusOfLog(l);
      const d = daysBetween(l.date, todayStr);
      const days = Number.isFinite(d) ? Math.max(0, d) : null;
      const title = company || role || 'Application';
      return {
        id: l.id,
        title,
        role: company && role ? role : '',
        days,
        ago: appliedAgo(days),
        status,
        stage: stageProgress(status),
        next: nextStage(status),
        followUp: needsFollowUp(l, todayStr, followups),
        followedUp: !!(followups && Object.prototype.hasOwnProperty.call(followups, l.id)),
        unnamed: !company && !role,
        art: posterArt(company || role)
      };
    });
    const open = tiles.filter(t => t.status !== 'rejected');
    const closed = tiles.filter(t => t.status === 'rejected');
    return open.concat(closed).slice(0, limit || ROW_LIMIT);
  }

  // Follow-ups due, the longest-waiting first.
  function followUpsDue(logs, todayStr, followups, limit) {
    return (Array.isArray(logs) ? logs : [])
      .filter(l => needsFollowUp(l, todayStr, followups))
      .map(l => {
        const company = clean(l.company, 60);
        const role = clean(l.role, 80);
        const days = Math.max(0, daysBetween(l.date, todayStr));
        return { id: l.id, title: company || role, role: company && role ? role : '', days, ago: appliedAgo(days) };
      })
      .sort((a, b) => b.days - a.days)
      .slice(0, limit || 3);
  }

  // Watchlist companies with no application logged and not checked off.
  function watchCandidates(watchlist, logs, keyFn) {
    const toKey = typeof keyFn === 'function' ? keyFn : companyKey;
    const applied = new Set((Array.isArray(logs) ? logs : []).map(l => toKey(clean(l && l.company, 60))).filter(Boolean));
    return (Array.isArray(watchlist) ? watchlist : []).filter(w => {
      const name = w && clean(w.name, 60);
      return name && !w.done && !applied.has(toKey(name));
    });
  }

  // One candidate per day, stable for the whole day.
  function pickOfTheDay(candidates, todayStr) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    return candidates[hashString(String(todayStr || '')) % candidates.length];
  }

  // The best single day ever for a goal; ties keep the first time it happened.
  function bestDay(dailyMap, metricId) {
    let best = null;
    Object.keys(dailyMap || {}).sort().forEach(date => {
      if (!ISO.test(date)) return;
      const n = num((dailyMap[date] || {})[metricId]);
      if (n > 0 && (!best || n > best.count)) best = { date, count: n };
    });
    return best;
  }

  // The play queue: goals not met today, follow-ups due, then companies to
  // try. Rest days leave the goals out.
  function buildUpNext(ctx) {
    const c = ctx || {};
    const items = [];
    if (!c.restToday) {
      (Array.isArray(c.goals) ? c.goals : []).forEach(g => {
        if (!g || !g.id || g.met) return;
        const goal = Math.max(1, Math.floor(num(g.goal)) || 1);
        const today = Math.max(0, Math.floor(num(g.today)));
        if (today >= goal) return;
        const left = goal - today;
        items.push({
          kind: 'goal',
          key: 'goal:' + g.id,
          metricId: g.id,
          title: g.name || 'Your goal',
          sub: (today ? today + ' of ' + goal + ' today' : 'Fresh start today') + ' · ' + left + ' to go',
          action: 'log'
        });
      });
    }
    followUpsDue(c.logs, c.todayStr, c.followups, c.followLimit || 3).forEach(t => {
      items.push({
        kind: 'followup',
        key: 'fu:' + t.id,
        logId: t.id,
        name: t.title,
        title: 'Follow up with ' + t.title,
        sub: t.ago + (t.role ? ' · ' + t.role : ''),
        action: 'followed'
      });
    });
    watchCandidates(c.watchlist, c.logs, c.keyFn).slice(0, c.watchLimit || 3).forEach(w => {
      items.push({
        kind: 'watch',
        key: 'w:' + (w.id || w.name),
        company: clean(w.name, 60),
        title: 'Apply to ' + clean(w.name, 60),
        sub: 'On your watchlist',
        action: 'applied'
      });
    });
    const limit = c.limit || 6;
    return { items: items.slice(0, limit), more: Math.max(0, items.length - limit), total: items.length };
  }

  // Billboard slides, in order: next milestone, today's pick (jobs only),
  // streak, record day. Each has one primary action.
  function spotlightSlides(ctx) {
    const c = ctx || {};
    const many = c.unitMany || 'entries';
    const logLabel = c.logLabel || 'Log one';
    const today = Math.max(0, Math.floor(num(c.today)));
    const goal = Math.max(1, Math.floor(num(c.goal)) || 1);
    const streak = Math.max(0, Math.floor(num(c.streak)));
    const slides = [];
    const logCta = { kind: 'log', label: logLabel };

    if (c.next && num(c.next.count) > 0) {
      const count = Math.floor(num(c.next.count));
      const remaining = Math.max(0, Math.floor(num(c.next.remaining)));
      const prev = Math.max(0, Math.floor(num(c.prevMilestone)));
      const span = Math.max(1, count - prev);
      const pct = Math.round((Math.max(0, Math.min(span, span - remaining)) / span) * 100);
      slides.push({
        id: 'milestone',
        kicker: 'Next milestone',
        headline: count + ' ' + many,
        line: remaining + ' more to go. ' + (pct >= 50 ? 'Past the halfway mark.' : 'Every one counts.'),
        pct,
        cta: logCta
      });
    }

    if (c.isJobs) {
      if (c.pick && clean(c.pick.name)) {
        slides.push({ id: 'pick', kicker: 'Today\'s pick', headline: clean(c.pick.name, 60), line: 'On your watchlist and not applied yet. Today could be the day.', cta: { kind: 'applied', label: 'I applied', company: clean(c.pick.name, 60) } });
      } else if (!num(c.watchCount)) {
        slides.push({ id: 'pick', kicker: 'Today\'s pick', headline: 'Pick a few places', line: 'Keep a short list of companies. LIT checks them off as you apply.', cta: { kind: 'watchlist', label: 'Add companies' } });
      } else {
        slides.push({ id: 'pick', kicker: 'Today\'s pick', headline: 'Your list is all done', line: 'You applied everywhere you were watching. Add a few more?', cta: { kind: 'watchlist', label: 'Add companies' } });
      }
    }

    if (c.restToday) {
      slides.push({ id: 'streak', kicker: 'Streak', headline: streak ? streak + '-day streak' : 'Rest day', line: 'Rest day today. Your streak is safe.', cta: logCta });
    } else if (streak > 0) {
      slides.push({
        id: 'streak',
        kicker: 'Streak',
        headline: streak + '-day streak',
        line: c.met ? 'Today\'s goal is met. The streak is safe.' : Math.max(1, goal - today) + ' more today keeps it going.',
        cta: c.met ? { kind: 'share', label: 'Share it' } : logCta
      });
    } else {
      slides.push({
        id: 'streak',
        kicker: 'Streak',
        headline: 'Fresh start',
        line: today > 0 ? Math.max(1, goal - today) + ' more today starts a streak.' : 'One today starts a new streak.',
        cta: logCta
      });
    }

    if (c.record && num(c.record.count) >= 2) {
      const best = Math.floor(num(c.record.count));
      let line;
      if (c.record.date === c.todayStr) line = 'That is today. What a day.';
      else if (today >= best) line = 'You matched it today.';
      else line = (c.record.label || c.record.date) + '. ' + (today ? today + ' so far today.' : 'Today is a fresh shot.');
      slides.push({ id: 'record', kicker: 'Record day', headline: best + ' in one day', line, cta: logCta });
    }
    return slides;
  }

  // Which slide to show after the list changes: the same slide when it is
  // still there, otherwise the nearest index.
  function slideIndexFor(slides, currentId, fallbackIndex) {
    const list = Array.isArray(slides) ? slides : [];
    if (!list.length) return 0;
    const at = list.findIndex(s => s.id === currentId);
    if (at >= 0) return at;
    const i = Math.floor(num(fallbackIndex));
    return Math.max(0, Math.min(list.length - 1, i));
  }

  // Keeps the follow-up map small: valid dates only, nothing older than
  // maxAgeDays, at most maxEntries (newest kept).
  function pruneFollowups(map, todayStr, maxAgeDays, maxEntries) {
    const src = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    const age = maxAgeDays || 180;
    const cap = maxEntries || 300;
    const rows = Object.keys(src)
      .filter(id => typeof id === 'string' && id && ISO.test(src[id]))
      .filter(id => {
        const d = daysBetween(src[id], todayStr);
        return !Number.isFinite(d) || d <= age;
      })
      .sort((a, b) => (src[a] < src[b] ? 1 : src[a] > src[b] ? -1 : 0))
      .slice(0, cap);
    const out = {};
    rows.forEach(id => { out[id] = src[id]; });
    return out;
  }

  const PURE = {
    FOLLOWUPS_KEY,
    PREF_KEY,
    FOLLOW_UP_DAYS,
    RANK_MODES,
    DEFAULT_RANK,
    STAGE_STEPS,
    normStatus,
    stageProgress,
    nextStage,
    daysBetween,
    appliedAgo,
    needsFollowUp,
    hashString,
    monogramFor,
    posterArt,
    companyKey,
    rankDays,
    rankCompanies,
    roleWords,
    rankRoles,
    rankModesFor,
    effectiveRank,
    rankItems,
    normalizeTop10,
    continueTiles,
    followUpsDue,
    watchCandidates,
    pickOfTheDay,
    bestDay,
    buildUpNext,
    spotlightSlides,
    slideIndexFor,
    pruneFollowups
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PURE;

  // ---------------------------------------------------------------------------
  // Popup side
  // ---------------------------------------------------------------------------
  const Lit = typeof LitPopup !== 'undefined' && LitPopup ? LitPopup : null;
  if (!HAS_DOM || !Lit || typeof Lit.registerCard !== 'function') return;

  const SVG_NS_OPEN = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">';
  const ICONS = {
    left: SVG_NS_OPEN + '<path d="M14.5 6 8.5 12l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    right: SVG_NS_OPEN + '<path d="M9.5 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: SVG_NS_OPEN + '<path class="mc-check-path" d="M5.5 12.5l4.2 4.2L18.5 7.8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    forward: SVG_NS_OPEN + '<path d="M5 12h13M13 6.5 18.5 12 13 17.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    close: SVG_NS_OPEN + '<path d="M7 7l10 10M17 7 7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    send: SVG_NS_OPEN + '<path d="M4.5 11.6 19 5l-6.6 14.5-2.1-5.8-5.8-2.1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10.3 13.7 19 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    bookmark: SVG_NS_OPEN + '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-4-6 4V5.5a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    briefcase: SVG_NS_OPEN + '<rect x="3.5" y="7" width="17" height="12" rx="2.4" stroke="currentColor" stroke-width="1.8"/><path d="M9 7V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6V7M3.5 12.5h17" stroke="currentColor" stroke-width="1.8"/></svg>',
    trophy: SVG_NS_OPEN + '<path d="M7.5 4h9v4.5a4.5 4.5 0 0 1-9 0Z" fill="currentColor"/><path d="M7.5 5.5H5a2.3 2.3 0 0 0 2.6 3.2M16.5 5.5H19a2.3 2.3 0 0 1-2.6 3.2M12 13v3.5M8.5 20h7M9.5 16.5h5V20h-5Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    target: SVG_NS_OPEN + '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.4" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>',
    flame: SVG_NS_OPEN + '<path d="M12 21c4.2 0 6.8-2.7 6.8-6.4 0-3-1.7-5.1-3-6.9.2 1.8-.8 2.9-1.7 2.9.6-3.1-.5-5.8-3.1-8-.2 2.4-1.4 4.4-3.1 6.1-1.5 1.5-2.4 3.4-2.4 5.6 0 3.8 2.4 6.7 6.5 6.7Z" fill="currentColor"/></svg>',
    star: SVG_NS_OPEN + '<path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8Z" fill="currentColor"/></svg>',
    pause: SVG_NS_OPEN + '<path d="M9 6.5v11M15 6.5v11" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    play: SVG_NS_OPEN + '<path d="M8.5 6.2v11.6L18 12Z" fill="currentColor"/></svg>',
    spark: SVG_NS_OPEN + '<path d="M12 3.5v4M12 16.5v4M3.5 12h4M16.5 12h4M6 6l2.6 2.6M15.4 15.4 18 18M18 6l-2.6 2.6M8.6 15.4 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };
  const SLIDE_ICON = { milestone: 'trophy', pick: 'target', streak: 'flame', record: 'star' };

  function api() {
    return Lit.api;
  }

  function isOn() {
    try { return Lit.modulePref(PREF_KEY, true) !== false; } catch (e) { return true; }
  }

  function reduceMotion() {
    const a = api();
    if (a && a.reduceMotion) return true;
    if (document.documentElement.dataset.motion === 'reduce') return true;
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(className, label, text) {
    const b = h('button', className, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    return b;
  }

  function icon(name, className) {
    const span = h('span', className || 'mc-ico');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  function todayStr() {
    const a = api();
    try { if (a && typeof a.todayStr === 'function') return a.todayStr(); } catch (e) { /* fall through */ }
    if (typeof TrackerStorage !== 'undefined' && TrackerStorage.getLocalDateStr) return TrackerStorage.getLocalDateStr();
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function friendly(dateStr) {
    const a = api();
    try { if (a && typeof a.friendlyDate === 'function') return a.friendlyDate(dateStr); } catch (e) { /* fall through */ }
    return dateStr;
  }

  function unit(metric, n) {
    const a = api();
    try { if (a && typeof a.displayUnit === 'function') return a.displayUnit(metric, n); } catch (e) { /* fall through */ }
    return n === 1 ? 'entry' : 'entries';
  }

  function logLabelFor(metric) {
    return metric && metric.id === 'jobs' ? 'Log application' : 'Log ' + unit(metric, 1);
  }

  function setArt(node, art) {
    node.style.setProperty('--mc-h', String(art.hue));
    node.style.setProperty('--mc-h2', String(art.hue2));
    node.style.setProperty('--mc-a', art.angle + 'deg');
  }

  // ----- Per-card state, keyed on the card body ------------------------------
  const states = new WeakMap();
  const live = new Set();

  function stateOf(body) {
    let s = states.get(body);
    if (!s) {
      s = { token: 0, sig: '', bound: false, args: null };
      states.set(body, s);
    }
    return s;
  }

  function rootOf(body, kind) {
    let root = body.querySelector(':scope > .mc-root');
    if (!root || root.dataset.kind !== kind) {
      body.textContent = '';
      root = h('div', 'mc-root mc-' + kind);
      root.dataset.kind = kind;
      body.appendChild(root);
      stateOf(body).sig = '';
      stateOf(body).bound = false;
    }
    return root;
  }

  // Module switch off: the card hides entirely and keeps nothing drawn.
  function gate(body, item, wrap) {
    const on = isOn();
    if (wrap) wrap.classList.toggle('mc-off', !on);
    if (!on) {
      const st = stateOf(body);
      st.token++;
      st.sig = '';
      if (body.firstChild) body.textContent = '';
      const extra = wrap && wrap.querySelector('.widget-extra');
      if (extra && extra.dataset.mcSeg !== undefined) {
        extra.textContent = '';
        delete extra.dataset.mcSeg;
      }
      live.delete(body);
      return false;
    }
    return true;
  }

  function remember(body, type, item, metric, wrap) {
    const st = stateOf(body);
    st.args = { type, item, metric, wrap };
    live.add(body);
    return st;
  }

  // Repaints every media card on screen with its last arguments (used after
  // a local change such as a follow-up mark, without a full reload).
  function repaintAll(onlyType) {
    live.forEach(body => {
      if (!body.isConnected) { live.delete(body); return; }
      const st = stateOf(body);
      if (!st.args || (onlyType && st.args.type !== onlyType)) return;
      const fn = RENDERERS[st.args.type];
      try { fn(body, st.args.item, st.args.metric, st.args.wrap); } catch (e) { console.warn('[LIT] media card repaint', e); }
    });
  }

  // ----- Data: job logs and the follow-up map ---------------------------------
  const settled = new WeakMap();

  // Calls fn(logs) now when the popup's job list is already loaded, or once
  // it arrives unless the card re-rendered or went away meanwhile.
  function withJobs(body, st, needJobs, fn) {
    const token = ++st.token;
    const finish = logs => {
      if (st.token !== token || !body.isConnected) return;
      fn(logs);
    };
    const followupsReady = fuLoaded ? null : loadFollowups();
    if (!needJobs) {
      if (followupsReady) followupsReady.then(() => finish([]));
      else fn([]);
      return;
    }
    let p = null;
    try { p = api().jobs(); } catch (e) { p = null; }
    if (!p || typeof p.then !== 'function') {
      if (followupsReady) followupsReady.then(() => finish([]));
      else fn([]);
      return;
    }
    if (settled.has(p) && !followupsReady) {
      fn(settled.get(p));
      return;
    }
    Promise.all([p, followupsReady]).then(([logs]) => {
      const list = Array.isArray(logs) ? logs : [];
      settled.set(p, list);
      finish(list);
    }, err => {
      console.warn('[LIT] media cards: applications unavailable', err);
      finish([]);
    });
  }

  let followups = {};
  let fuLoaded = false;
  let fuPromise = null;

  function localArea() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
  }

  function loadFollowups() {
    if (fuPromise) return fuPromise;
    fuPromise = new Promise(resolve => {
      const done = v => {
        followups = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        fuLoaded = true;
        resolve(followups);
      };
      const area = localArea();
      if (!area) { done({}); return; }
      try { area.get([FOLLOWUPS_KEY], r => done(r && r[FOLLOWUPS_KEY])); } catch (e) { done({}); }
    });
    return fuPromise;
  }

  function markFollowedUp(logId) {
    if (!logId) return;
    followups = pruneFollowups(Object.assign({}, followups, { [logId]: todayStr() }), todayStr());
    const area = localArea();
    try { if (area) area.set({ [FOLLOWUPS_KEY]: followups }); } catch (e) { /* best effort */ }
  }

  function unmarkFollowedUp(logId) {
    if (!logId || !Object.prototype.hasOwnProperty.call(followups, logId)) return;
    followups = Object.assign({}, followups);
    delete followups[logId];
    const area = localArea();
    try { if (area) area.set({ [FOLLOWUPS_KEY]: followups }); } catch (e) { /* best effort */ }
  }

  // ----- Shared actions -------------------------------------------------------
  function status(text, tone, action) {
    const a = api();
    if (a && typeof a.showStatus === 'function') a.showStatus(text, tone, action);
  }

  function oops(text, err) {
    const a = api();
    if (a && typeof a.oops === 'function') a.oops(text, err);
    else console.warn('[LIT]', text, err);
  }

  function refresh() {
    const a = api();
    return a && typeof a.refresh === 'function' ? Promise.resolve(a.refresh()) : Promise.resolve();
  }

  function addOne(metricId, extra) {
    if (typeof TrackerStorage === 'undefined' || typeof TrackerStorage.addLog !== 'function') return Promise.reject(new Error('Storage unavailable'));
    return TrackerStorage.addLog(Object.assign({ metricId, count: 1, source: 'manual' }, extra || {}));
  }

  function undoLog(log) {
    if (!log || !log.id || typeof TrackerStorage.deleteLog !== 'function') return null;
    return {
      label: 'Undo',
      run: () => TrackerStorage.deleteLog(log.id).then(refresh).catch(err => oops('That could not be undone just now.', err))
    };
  }

  // Logs one for a goal. The active goal goes through the popup's own +1 so
  // the ring and the buddy celebrate; a pinned goal is written directly.
  function logFor(metric) {
    const a = api();
    const active = a && a.activeMetric;
    if (active && metric && active.id === metric.id && typeof a.logOne === 'function') {
      a.logOne();
      return Promise.resolve(null);
    }
    return addOne(metric.id).then(log => {
      status('Logged 1 for ' + metric.name + '.', 'ok', undoLog(log));
      return refresh();
    });
  }

  function logApplied(company) {
    return addOne('jobs', { company }).then(log => {
      status('Logged an application at ' + company + '. Nice work.', 'ok', undoLog(log));
      return refresh();
    });
  }

  function widgetNode(id) {
    return document.querySelector('#widgets-host [data-widget-id="' + CSS.escape(id) + '"]');
  }

  // "Add companies": brings the watchlist card into view (adding or opening
  // it first) and puts the cursor in its box.
  async function openWatchlist() {
    const a = api();
    if (!a) return;
    let item = (a.widgetItems || []).find(i => i.type === 'watchlist');
    try {
      if (!item) {
        await WidgetLayout.add('watchlist', {});
        await refresh();
        status('Added your watchlist card. Type a company to start.', 'ok');
      } else if (item.options && item.options.collapsed) {
        await WidgetLayout.update(item.id, { collapsed: false });
        await refresh();
      }
    } catch (err) {
      oops('The watchlist card could not open just now.', err);
      return;
    }
    item = (a.widgetItems || []).find(i => i.type === 'watchlist');
    const wrap = item && widgetNode(item.id);
    if (!wrap) {
      const customize = document.getElementById('customize-btn');
      if (customize) customize.focus();
      return;
    }
    wrap.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    let tries = 0;
    const focusInput = () => {
      const input = wrap.querySelector('.watch-input');
      if (input && !input.disabled) input.focus({ preventScroll: true });
      else if (tries++ < 10) setTimeout(focusInput, 50);
    };
    focusInput();
  }

  function runCta(cta, metric) {
    if (!cta) return Promise.resolve();
    const a = api();
    if (cta.kind === 'applied' && cta.company) return logApplied(cta.company);
    if (cta.kind === 'watchlist') return openWatchlist();
    if (cta.kind === 'share' && a && typeof a.openShare === 'function') {
      const streak = a.streakFor(metric);
      a.openShare({ metricId: metric.id, bigNumber: streak, bigLabel: 'day streak' });
      return Promise.resolve();
    }
    return logFor(metric);
  }

  // ----- Scroll rows (continue row, top 10) -----------------------------------
  function buildRail(row, label) {
    const rail = h('div', 'mc-rail');
    const prev = button('mc-arrow mc-prev', 'Scroll ' + label + ' back');
    prev.appendChild(icon('left'));
    prev.dataset.mcScroll = '-1';
    const next = button('mc-arrow mc-next', 'Scroll ' + label + ' forward');
    next.appendChild(icon('right'));
    next.dataset.mcScroll = '1';
    rail.appendChild(prev);
    rail.appendChild(row);
    rail.appendChild(next);
    return rail;
  }

  function updateArrows(rail) {
    const row = rail && rail.querySelector('.mc-row');
    if (!row) return;
    const max = row.scrollWidth - row.clientWidth;
    const prev = rail.querySelector('.mc-prev');
    const next = rail.querySelector('.mc-next');
    const atStart = row.scrollLeft <= 2;
    const atEnd = row.scrollLeft >= max - 2;
    if (prev) prev.disabled = atStart || max <= 2;
    if (next) next.disabled = atEnd || max <= 2;
    rail.classList.toggle('mc-scrolls', max > 2);
  }

  function scrollRow(row, dir) {
    const step = Math.max(80, row.clientWidth * 0.8);
    row.scrollBy({ left: dir * step, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function bindRail(root) {
    root.addEventListener('scroll', e => {
      const row = e.target;
      if (!row.classList || !row.classList.contains('mc-row')) return;
      if (row._mcRaf) return;
      row._mcRaf = requestAnimationFrame(() => {
        row._mcRaf = 0;
        updateArrows(row.closest('.mc-rail'));
      });
    }, true);
    root.addEventListener('click', e => {
      const arrow = e.target.closest('[data-mc-scroll]');
      if (!arrow) return;
      const rail = arrow.closest('.mc-rail');
      const row = rail && rail.querySelector('.mc-row');
      if (row) scrollRow(row, parseInt(arrow.dataset.mcScroll, 10) || 1);
    });
  }

  function afterLayout(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }

  // ----- Continue row ---------------------------------------------------------
  let openSheet = null;
  const lastPct = new Map();

  function closeSheet(restoreFocus) {
    if (!openSheet) return;
    const { tile, sheet, trigger } = openSheet;
    openSheet = null;
    sheet.hidden = true;
    tile.classList.remove('mc-sheet-open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outsideSheet, true);
    if (restoreFocus && trigger.isConnected) trigger.focus();
  }

  function outsideSheet(e) {
    if (openSheet && !openSheet.tile.contains(e.target)) closeSheet(false);
  }

  function openTileSheet(tile) {
    const trigger = tile.querySelector('.mc-tile-btn');
    const sheet = tile.querySelector('.mc-sheet');
    if (!trigger || !sheet) return;
    if (openSheet && openSheet.tile === tile) { closeSheet(true); return; }
    closeSheet(false);
    sheet.hidden = false;
    tile.classList.add('mc-sheet-open');
    trigger.setAttribute('aria-expanded', 'true');
    openSheet = { tile, sheet, trigger };
    document.addEventListener('pointerdown', outsideSheet, true);
    const first = sheet.querySelector('button');
    if (first) first.focus();
  }

  function sheetKeys(e) {
    if (!openSheet || !openSheet.sheet.contains(e.target)) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSheet(true);
      return true;
    }
    if (e.key === 'Tab') {
      const items = Array.from(openSheet.sheet.querySelectorAll('button:not(:disabled)'));
      if (!items.length) return true;
      const i = items.indexOf(document.activeElement);
      e.preventDefault();
      const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i >= items.length - 1 ? 0 : i + 1);
      items[next].focus();
      return true;
    }
    return false;
  }

  // Roving focus: one tile in the tab order, arrows move between tiles.
  function rovingKeys(e, selector) {
    const current = e.target.closest(selector);
    if (!current) return;
    const row = current.closest('.mc-row');
    const all = Array.from(row.querySelectorAll(selector));
    const i = all.indexOf(current);
    let to = -1;
    if (e.key === 'ArrowRight') to = Math.min(all.length - 1, i + 1);
    else if (e.key === 'ArrowLeft') to = Math.max(0, i - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = all.length - 1;
    if (to < 0) return;
    e.preventDefault();
    all.forEach((b, k) => { b.tabIndex = k === to ? 0 : -1; });
    all[to].focus({ preventScroll: true });
    all[to].scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function tileLabel(t) {
    const parts = [t.title];
    if (t.role) parts.push(t.role);
    parts.push(t.ago);
    parts.push('Stage: ' + t.stage.label);
    if (t.followUp) parts.push('Might be time to follow up');
    return parts.join('. ') + '. Open actions.';
  }

  function buildTile(t, index) {
    const li = h('li', 'mc-tile' + (t.stage.muted ? ' is-closed' : '') + (t.status === 'offer' ? ' is-offer' : ''));
    li.dataset.logId = t.id;
    li.dataset.status = t.status;
    const trigger = button('mc-tile-btn', tileLabel(t));
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.tabIndex = index === 0 ? 0 : -1;
    const art = h('span', 'mc-art');
    setArt(art, t.art);
    if (t.unnamed) art.appendChild(icon('briefcase', 'mc-mono mc-mono-ico'));
    else art.appendChild(h('span', 'mc-mono', t.art.mono || t.title.charAt(0).toUpperCase()));
    if (t.status !== 'applied') art.appendChild(h('span', 'mc-chip stage-' + t.status, t.stage.label));
    if (t.followUp) art.appendChild(h('span', 'mc-badge', 'Follow up?'));
    const bar = h('span', 'mc-progress');
    const fill = h('span');
    const from = lastPct.has(t.id) ? lastPct.get(t.id) : t.stage.pct;
    fill.style.width = from + '%';
    bar.appendChild(fill);
    art.appendChild(bar);
    if (from !== t.stage.pct) afterLayout(() => { fill.style.width = t.stage.pct + '%'; });
    lastPct.set(t.id, t.stage.pct);
    trigger.appendChild(art);
    const cap = h('span', 'mc-cap');
    cap.appendChild(h('span', 'mc-cap-title', t.title));
    if (t.role) cap.appendChild(h('span', 'mc-cap-sub', t.role));
    cap.appendChild(h('span', 'mc-cap-meta', t.stage.muted ? t.stage.note : t.ago));
    trigger.appendChild(cap);
    trigger.title = t.title + (t.role ? ' · ' + t.role : '') + ' · ' + t.stage.label;
    li.appendChild(trigger);

    const sheet = h('div', 'mc-sheet');
    sheet.hidden = true;
    sheet.setAttribute('role', 'group');
    sheet.setAttribute('aria-label', 'Actions for ' + t.title);
    sheet.appendChild(h('span', 'mc-sheet-title', t.title));
    if (t.next) {
      const move = button('mc-sheet-btn mc-primary', 'Move ' + t.title + ' to ' + STAGE_NAMES[t.next]);
      move.dataset.mcAction = 'move';
      move.dataset.mcStatus = t.next;
      move.appendChild(icon('forward'));
      move.appendChild(h('span', '', STAGE_NAMES[t.next]));
      sheet.appendChild(move);
    } else {
      sheet.appendChild(h('span', 'mc-sheet-note', t.status === 'offer' ? 'An offer. Congratulations.' : t.stage.note));
    }
    if (t.status === 'applied' && !t.unnamed) {
      const fu = button('mc-sheet-btn', t.followedUp ? 'Followed up with ' + t.title + '. Select to undo.' : 'I followed up with ' + t.title);
      fu.dataset.mcAction = t.followedUp ? 'unfollow' : 'followed';
      fu.setAttribute('aria-pressed', t.followedUp ? 'true' : 'false');
      fu.appendChild(icon(t.followedUp ? 'check' : 'send'));
      fu.appendChild(h('span', '', 'Followed up'));
      sheet.appendChild(fu);
    }
    const close = button('mc-sheet-btn mc-quiet', 'Close actions for ' + t.title);
    close.dataset.mcAction = 'close';
    close.appendChild(icon('close'));
    close.appendChild(h('span', '', 'Close'));
    sheet.appendChild(close);
    li.appendChild(sheet);
    return li;
  }

  // The tile to focus once the row rebuilds after a change.
  let pendingFocus = null;

  async function moveStage(logId, to, title, prev) {
    if (typeof TrackerStorage === 'undefined' || typeof TrackerStorage.setLogStatus !== 'function') return;
    closeSheet(false);
    try {
      const ok = await TrackerStorage.setLogStatus(logId, to);
      if (ok === false) { status('That application could not be updated just now.', 'error'); return; }
      status(title + ' moved to ' + STAGE_NAMES[to] + '. Nice progress.', 'ok', prev ? {
        label: 'Undo',
        run: () => TrackerStorage.setLogStatus(logId, prev).then(refresh).catch(err => oops('That could not be undone just now.', err))
      } : null);
      pendingFocus = logId;
      await refresh();
    } catch (err) {
      oops('That application could not be updated just now.', err);
    }
  }

  function focusPendingTile(root) {
    if (!pendingFocus) return;
    const btn = root.querySelector('.mc-tile[data-log-id="' + CSS.escape(pendingFocus) + '"] .mc-tile-btn');
    pendingFocus = null;
    if (!btn) return;
    btn.closest('.mc-row').querySelectorAll('.mc-tile-btn').forEach(b => { b.tabIndex = b === btn ? 0 : -1; });
    btn.focus({ preventScroll: true });
  }

  function bindContinue(root) {
    bindRail(root);
    root.addEventListener('click', e => {
      const action = e.target.closest('[data-mc-action]');
      if (action) {
        const tile = action.closest('.mc-tile');
        const id = tile && tile.dataset.logId;
        const title = tile ? tile.querySelector('.mc-cap-title').textContent : '';
        const kind = action.dataset.mcAction;
        if (kind === 'close') { closeSheet(true); return; }
        if (kind === 'move') { moveStage(id, action.dataset.mcStatus, title, tile.dataset.status); return; }
        if (kind === 'followed' || kind === 'unfollow') {
          closeSheet(false);
          if (kind === 'followed') {
            markFollowedUp(id);
            status('Noted. Following up keeps you on their radar.', 'ok', { label: 'Undo', run: () => { unmarkFollowedUp(id); repaintAll(); } });
          } else {
            unmarkFollowedUp(id);
          }
          pendingFocus = id;
          repaintAll();
        }
        return;
      }
      const trigger = e.target.closest('.mc-tile-btn');
      if (trigger) openTileSheet(trigger.closest('.mc-tile'));
    });
    root.addEventListener('keydown', e => {
      if (sheetKeys(e)) return;
      if (e.target.closest('.mc-tile-btn')) rovingKeys(e, '.mc-tile-btn');
    });
  }

  function renderContinue(body, item, metric, wrap) {
    if (!gate(body, item, wrap)) return;
    const st = remember(body, 'continueRow', item, metric, wrap);
    if (item.options && item.options.collapsed) return;
    const root = rootOf(body, 'continue');
    if (!st.bound) { bindContinue(root); st.bound = true; }
    withJobs(body, st, true, logs => {
      const today = todayStr();
      const tiles = continueTiles(logs, today, followups, ROW_LIMIT);
      const sig = JSON.stringify([today, tiles.map(t => [t.id, t.title, t.role, t.days, t.status, t.followUp, t.followedUp])]);
      if (st.sig === sig && root.firstChild) { focusPendingTile(root); return; }
      // A rebuild drops an open action sheet, so close it cleanly first.
      if (openSheet && root.contains(openSheet.tile)) closeSheet(false);
      st.sig = sig;
      root.textContent = '';
      if (!tiles.length) {
        const empty = h('div', 'mc-empty');
        empty.appendChild(icon('briefcase', 'mc-empty-ico'));
        empty.appendChild(h('p', 'mc-empty-title', 'Your applications line up here'));
        empty.appendChild(h('p', 'mc-empty-line', 'Log one with the company name and it shows up as a poster you can move along.'));
        root.appendChild(empty);
        return;
      }
      const row = h('ul', 'mc-row');
      row.setAttribute('aria-label', 'Recent applications. Use the arrow keys to move between them.');
      tiles.forEach((t, i) => row.appendChild(buildTile(t, i)));
      const rail = buildRail(row, 'applications');
      root.appendChild(rail);
      if (tiles.every(t => t.unnamed)) root.appendChild(h('p', 'mc-note', 'Add the company with the next one and it gets its own poster.'));
      const due = tiles.filter(t => t.followUp).length;
      if (due) root.appendChild(h('p', 'mc-note', due === 1 ? 'One has waited a week. A short follow-up note can help.' : due + ' have waited a week. A short follow-up note can help.'));
      focusPendingTile(root);
      afterLayout(() => updateArrows(rail));
    });
  }

  // ----- Top 10 ---------------------------------------------------------------
  const RANK_LABELS = { days: 'Days', companies: 'Companies', roles: 'Roles' };
  const RANK_SHORT = { days: 'Days', companies: 'Firms', roles: 'Roles' };
  const pendingRank = new Map();

  function rankModeOf(item, metric) {
    const want = pendingRank.has(item.id) ? pendingRank.get(item.id) : (item.options && item.options.rankBy) || DEFAULT_RANK;
    if (pendingRank.has(item.id) && pendingRank.get(item.id) === ((item.options && item.options.rankBy) || DEFAULT_RANK)) pendingRank.delete(item.id);
    return effectiveRank(want, metric.id);
  }

  // The rank switch. It is updated in place (never rebuilt on a mode change)
  // so keyboard focus stays on the button that was pressed.
  function syncSeg(host, body, itemId, mode, modes, compact) {
    if (!host) return;
    let seg = host.querySelector(':scope > .mc-seg');
    const key = modes.length > 1 ? modes.join() + (compact ? ':c' : ':w') : '';
    if (!key) {
      if (seg) seg.remove();
      if (host.dataset.mcSeg !== undefined) delete host.dataset.mcSeg;
      return;
    }
    if (!seg || seg.dataset.key !== key) {
      if (seg) seg.remove();
      seg = h('div', 'segmented mc-seg' + (compact ? ' mc-seg-compact' : ''));
      seg.dataset.key = key;
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Rank by');
      modes.forEach(m => {
        const b = button('', 'Rank by ' + RANK_LABELS[m].toLowerCase(), compact ? RANK_SHORT[m] : RANK_LABELS[m]);
        b.dataset.mcRank = m;
        b.title = 'Rank by ' + RANK_LABELS[m].toLowerCase();
        seg.appendChild(b);
      });
      seg.addEventListener('click', e => {
        const b = e.target.closest('[data-mc-rank]');
        if (!b || b.getAttribute('aria-pressed') === 'true') return;
        const next = b.dataset.mcRank;
        pendingRank.set(itemId, next);
        seg.querySelectorAll('[data-mc-rank]').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        repaintAll('top10');
        WidgetLayout.update(itemId, { rankBy: next })
          .then(() => refresh())
          .catch(err => {
            pendingRank.delete(itemId);
            oops('That choice did not save. Please try again.', err);
          });
      });
      host.insertBefore(seg, host.firstChild);
      host.dataset.mcSeg = key;
    }
    seg.querySelectorAll('[data-mc-rank]').forEach(x => x.setAttribute('aria-pressed', x.dataset.mcRank === mode ? 'true' : 'false'));
  }

  function rankPoster(mode, r, metric) {
    const poster = h('span', 'mc-poster');
    const art = h('span', 'mc-art');
    if (mode === 'days') {
      const d = new Date(r.key + 'T12:00:00');
      setArt(art, posterArt('day-' + r.key));
      art.appendChild(h('span', 'mc-day-num', String(d.getDate())));
      art.appendChild(h('span', 'mc-day-mon', d.toLocaleDateString(undefined, { month: 'short' })));
    } else if (mode === 'companies') {
      const pa = posterArt(r.label);
      setArt(art, pa);
      art.appendChild(h('span', 'mc-mono', pa.mono || r.label.charAt(0).toUpperCase()));
    } else {
      setArt(art, posterArt('role-' + r.key));
      art.appendChild(h('span', 'mc-word', r.label));
    }
    poster.appendChild(art);
    const cap = h('span', 'mc-cap');
    if (mode === 'days') {
      cap.appendChild(h('span', 'mc-cap-title', r.value + ' ' + unit(metric, r.value)));
      cap.appendChild(h('span', 'mc-cap-meta', r.key === todayStr() ? 'Today' : friendly(r.key)));
    } else {
      cap.appendChild(h('span', 'mc-cap-title', r.label));
      cap.appendChild(h('span', 'mc-cap-meta', (mode === 'roles' ? 'In ' : '') + r.value + ' ' + unit(metric, r.value)));
    }
    poster.appendChild(cap);
    return poster;
  }

  function rankSpoken(mode, r, metric) {
    if (mode === 'days') return 'Number ' + r.rank + ': ' + (r.key === todayStr() ? 'today' : friendly(r.key)) + ', ' + r.value + ' ' + unit(metric, r.value) + '.';
    if (mode === 'roles') return 'Number ' + r.rank + ': ' + r.label + ', in ' + r.value + ' ' + unit(metric, r.value) + '.';
    return 'Number ' + r.rank + ': ' + r.label + ', ' + r.value + ' ' + unit(metric, r.value) + '.';
  }

  const RANK_EMPTY = {
    days: 'Your best days this month rank here.',
    companies: 'The companies you apply to most rank here.',
    roles: 'Add the role when you log, and the words that come up most rank here.'
  };

  function bindTop10(root) {
    bindRail(root);
    root.addEventListener('keydown', e => {
      const row = e.target.closest && e.target.closest('.mc-row');
      if (!row || e.target !== row) return;
      const item = row.querySelector('.mc-rank');
      const step = item ? item.getBoundingClientRect().width + 10 : 120;
      let left = null;
      if (e.key === 'ArrowRight') left = row.scrollLeft + step;
      else if (e.key === 'ArrowLeft') left = row.scrollLeft - step;
      else if (e.key === 'Home') left = 0;
      else if (e.key === 'End') left = row.scrollWidth;
      if (left === null) return;
      e.preventDefault();
      row.scrollTo({ left, behavior: reduceMotion() ? 'auto' : 'smooth' });
    });
  }

  function renderTop10(body, item, metric, wrap) {
    const extra = wrap && wrap.querySelector('.widget-extra');
    if (!gate(body, item, wrap)) return;
    const st = remember(body, 'top10', item, metric, wrap);
    const compact = item.options && item.options.size === 'compact';
    const modes = rankModesFor(metric.id);
    const mode = rankModeOf(item, metric);
    // The mode switch sits in the header slot on a wide card and at the top
    // of the body on a compact one, where the header has no room.
    syncSeg(extra, body, item.id, mode, compact ? [] : modes, false);
    if (item.options && item.options.collapsed) return;
    const root = rootOf(body, 'top10');
    if (!st.bound) { bindTop10(root); st.bound = true; }
    syncSeg(root, body, item.id, mode, compact ? modes : [], true);
    let content = root.querySelector(':scope > .mc-top-content');
    if (!content) {
      content = h('div', 'mc-top-content');
      root.appendChild(content);
    }
    withJobs(body, st, metric.id === 'jobs' && mode !== 'days', logs => {
      const a = api();
      const stats = (a && a.stats) || {};
      const today = todayStr();
      const ranked = rankItems(mode, { dailyMap: stats.dailyMap, metricId: metric.id, todayStr: today, logs, limit: TOP_LIMIT });
      const sig = JSON.stringify([mode, metric.id, today, ranked.map(r => [r.key, r.label, r.value])]);
      if (st.sig === sig && content.firstChild) return;
      st.sig = sig;
      content.textContent = '';
      root.dataset.mode = mode;
      if (!ranked.length) {
        const empty = h('div', 'mc-empty');
        empty.appendChild(icon('star', 'mc-empty-ico'));
        empty.appendChild(h('p', 'mc-empty-title', 'Your top 10 fills in as you go'));
        empty.appendChild(h('p', 'mc-empty-line', RANK_EMPTY[mode]));
        content.appendChild(empty);
        return;
      }
      const row = h('ol', 'mc-row mc-rank-row');
      row.tabIndex = 0;
      row.setAttribute('aria-label', 'Your top ' + ranked.length + ' by ' + RANK_LABELS[mode].toLowerCase() + '. Use the arrow keys to scroll.');
      ranked.forEach(r => {
        const li = h('li', 'mc-rank' + (r.rank >= 10 ? ' is-wide' : ''));
        const n = h('span', 'mc-rank-num', String(r.rank));
        n.setAttribute('aria-hidden', 'true');
        li.appendChild(n);
        const poster = rankPoster(mode, r, metric);
        poster.setAttribute('aria-hidden', 'true');
        poster.title = rankSpoken(mode, r, metric).replace(/^Number \d+: /, '');
        li.appendChild(poster);
        li.appendChild(h('span', 'sr-only', rankSpoken(mode, r, metric)));
        row.appendChild(li);
      });
      if (ranked.length < TOP_LIMIT) {
        const spot = ranked.length + 1;
        const ghost = h('li', 'mc-rank is-ghost' + (spot >= 10 ? ' is-wide' : ''));
        const n = h('span', 'mc-rank-num', String(spot));
        n.setAttribute('aria-hidden', 'true');
        ghost.appendChild(n);
        const poster = h('span', 'mc-poster');
        const art = h('span', 'mc-art mc-art-ghost');
        art.appendChild(icon('spark', 'mc-ghost-ico'));
        poster.appendChild(art);
        const cap = h('span', 'mc-cap');
        cap.appendChild(h('span', 'mc-cap-title', 'Open spot'));
        cap.appendChild(h('span', 'mc-cap-meta', 'Yours to fill'));
        poster.appendChild(cap);
        poster.setAttribute('aria-hidden', 'true');
        ghost.appendChild(poster);
        ghost.appendChild(h('span', 'sr-only', 'Number ' + spot + ' is still open.'));
        row.appendChild(ghost);
      }
      const rail = buildRail(row, 'your top 10');
      content.appendChild(rail);
      if (ranked.length < 3) content.appendChild(h('p', 'mc-note', 'Your top 10 fills in as you go.'));
      afterLayout(() => updateArrows(rail));
    });
  }

  // ----- Spotlight ------------------------------------------------------------
  const spots = new Map();
  const msCache = new Map();
  let spotTimer = 0;

  function spotOf(body) {
    let s = spots.get(body);
    if (!s) {
      s = { body, index: 0, id: '', count: 0, hover: false, focus: false, userPaused: false, collapsed: false };
      spots.set(body, s);
    }
    return s;
  }

  function spotEligible(s) {
    return s.body.isConnected && !s.collapsed && s.count > 1 && !s.hover && !s.focus && !s.userPaused && isOn();
  }

  // One timer serves every spotlight; it stops when none can rotate.
  function scheduleSpot() {
    if (spotTimer) return;
    spots.forEach((s, body) => { if (!body.isConnected) spots.delete(body); });
    if (reduceMotion()) return;
    if (!Array.from(spots.values()).some(spotEligible)) return;
    spotTimer = setTimeout(() => {
      spotTimer = 0;
      const a = api();
      const blocked = document.hidden || (a && a.openModalId);
      if (!blocked) spots.forEach(s => { if (spotEligible(s)) showSlide(s, (s.index + 1) % s.count, false); });
      scheduleSpot();
    }, SLIDE_MS);
  }

  function resetSpotTimer() {
    clearTimeout(spotTimer);
    spotTimer = 0;
    scheduleSpot();
  }

  function showSlide(s, index, user) {
    const root = s.body.querySelector('.mc-spot');
    if (!root) return;
    const slides = Array.from(root.querySelectorAll('.mc-slide'));
    if (!slides.length) return;
    const i = Math.max(0, Math.min(slides.length - 1, index));
    s.index = i;
    s.id = slides[i].dataset.slide;
    slides.forEach((el, k) => {
      const on = k === i;
      el.classList.toggle('is-active', on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
      if (on) el.removeAttribute('inert'); else el.setAttribute('inert', '');
    });
    root.querySelectorAll('.mc-dot').forEach((d, k) => {
      if (k === i) d.setAttribute('aria-current', 'true'); else d.removeAttribute('aria-current');
    });
    const bill = root.querySelector('.mc-bill');
    if (bill) bill.dataset.slide = s.id;
    const stage = root.querySelector('.mc-slides');
    if (stage) stage.setAttribute('aria-live', user || s.userPaused || reduceMotion() ? 'polite' : 'off');
    if (user) resetSpotTimer();
  }

  function updatePauseBtn(s) {
    const b = s.body.querySelector('.mc-pause');
    if (!b) return;
    b.innerHTML = '';
    b.appendChild(icon(s.userPaused ? 'play' : 'pause'));
    b.setAttribute('aria-label', s.userPaused ? 'Play the slides' : 'Pause the slides');
    b.setAttribute('aria-pressed', s.userPaused ? 'true' : 'false');
    b.title = s.userPaused ? 'Play' : 'Pause';
  }

  function bindSpot(root, body) {
    const s = spotOf(body);
    root.addEventListener('mouseenter', () => { s.hover = true; });
    root.addEventListener('mouseleave', () => { s.hover = false; scheduleSpot(); });
    root.addEventListener('focusin', () => { s.focus = true; });
    root.addEventListener('focusout', e => {
      if (e.relatedTarget && root.contains(e.relatedTarget)) return;
      s.focus = false;
      scheduleSpot();
    });
    root.addEventListener('click', e => {
      const dot = e.target.closest('.mc-dot');
      if (dot) { showSlide(s, parseInt(dot.dataset.index, 10) || 0, true); return; }
      if (e.target.closest('.mc-pause')) {
        s.userPaused = !s.userPaused;
        updatePauseBtn(s);
        showSlide(s, s.index, false);
        if (!s.userPaused) scheduleSpot();
        return;
      }
      const cta = e.target.closest('.mc-cta');
      if (cta && !cta.disabled) {
        const st = stateOf(body);
        const metric = st.args && st.args.metric;
        const slide = (st.slides || []).find(x => x.id === cta.dataset.slide);
        if (!metric || !slide) return;
        cta.disabled = true;
        runCta(slide.cta, metric)
          .catch(err => oops('That did not go through. Please try again.', err))
          .finally(() => { if (cta.isConnected) cta.disabled = false; });
      }
    });
    root.addEventListener('keydown', e => {
      const dot = e.target.closest && e.target.closest('.mc-dot');
      if (!dot) return;
      const n = s.count;
      let to = -1;
      if (e.key === 'ArrowRight') to = (s.index + 1) % n;
      else if (e.key === 'ArrowLeft') to = (s.index - 1 + n) % n;
      else if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      if (to < 0) return;
      e.preventDefault();
      showSlide(s, to, true);
      const dots = root.querySelectorAll('.mc-dot');
      if (dots[to]) dots[to].focus();
    });
  }

  function milestonesFor(metric, total, onFresh) {
    const key = metric.id + ':' + total;
    const hit = msCache.get(metric.id);
    if (hit && hit.key === key) return hit.value;
    if (typeof TrackerStorage === 'undefined' || typeof TrackerStorage.getMilestones !== 'function') return null;
    if (!hit || hit.pending !== key) {
      msCache.set(metric.id, { key: hit ? hit.key : '', value: hit ? hit.value : null, pending: key });
      TrackerStorage.getMilestones(metric.id).then(ms => {
        msCache.set(metric.id, { key, value: ms || null, pending: '' });
        onFresh();
      }).catch(err => {
        console.warn('[LIT] spotlight milestones unavailable', err);
        msCache.set(metric.id, { key, value: null, pending: '' });
      });
    }
    return hit ? hit.value : null;
  }

  function buildSlide(slide, index, count) {
    const el = h('article', 'mc-slide');
    el.dataset.slide = slide.id;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-roledescription', 'slide');
    el.setAttribute('aria-label', (index + 1) + ' of ' + count + ': ' + slide.kicker);
    el.appendChild(icon(SLIDE_ICON[slide.id] || 'star', 'mc-slide-art'));
    const text = h('div', 'mc-slide-text');
    text.appendChild(h('span', 'mc-kicker', slide.kicker));
    text.appendChild(h('h3', 'mc-headline', slide.headline));
    text.appendChild(h('p', 'mc-line', slide.line));
    if (typeof slide.pct === 'number') {
      const bar = h('span', 'mc-bill-bar');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', 'Progress to the next milestone');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      bar.setAttribute('aria-valuenow', String(slide.pct));
      const fill = h('span');
      fill.style.width = slide.pct + '%';
      bar.appendChild(fill);
      text.appendChild(bar);
    }
    const cta = button('mc-cta', null, slide.cta.label);
    cta.dataset.slide = slide.id;
    if (slide.cta.kind === 'applied') cta.setAttribute('aria-label', 'I applied to ' + slide.cta.company + ' today. Log it.');
    text.appendChild(cta);
    el.appendChild(text);
    return el;
  }

  function renderSpotlight(body, item, metric, wrap) {
    if (!gate(body, item, wrap)) { spots.delete(body); return; }
    const st = remember(body, 'spotlight', item, metric, wrap);
    const s = spotOf(body);
    s.collapsed = !!(item.options && item.options.collapsed);
    if (s.collapsed) return;
    const root = rootOf(body, 'spot');
    if (!st.bound) { bindSpot(root, body); st.bound = true; }
    const isJobs = metric.id === 'jobs';
    withJobs(body, st, isJobs, logs => {
      const a = api();
      const stats = (a && a.stats) || {};
      const today = todayStr();
      const total = ((stats.totals || {})[metric.id]) || 0;
      const ms = milestonesFor(metric, total, () => { if (body.isConnected) renderSpotlight(body, st.args.item, st.args.metric, st.args.wrap); });
      const reached = (ms && ms.reached) || [];
      const prev = reached.filter(r => typeof r.count === 'number').reduce((n, r) => Math.max(n, r.count), 0);
      const watch = (a && a.watchlist) || [];
      const candidates = isJobs ? watchCandidates(watch, logs) : [];
      const record = bestDay(stats.dailyMap, metric.id);
      const slides = spotlightSlides({
        isJobs,
        unitMany: unit(metric, 2),
        logLabel: logLabelFor(metric),
        today: a.todayFor(metric),
        goal: a.goalFor(metric),
        met: a.goalMetFor(metric),
        streak: a.streakFor(metric),
        restToday: !!stats.restToday,
        next: ms && ms.next,
        prevMilestone: prev,
        pick: pickOfTheDay(candidates, today),
        watchCount: watch.length,
        record: record ? { date: record.date, count: record.count, label: friendly(record.date) } : null,
        todayStr: today
      });
      st.slides = slides;
      const sig = JSON.stringify([metric.id, slides]);
      s.count = slides.length;
      if (st.sig === sig && root.firstChild) { scheduleSpot(); return; }
      st.sig = sig;
      root.textContent = '';
      const bill = h('div', 'mc-bill');
      bill.setAttribute('role', 'group');
      bill.setAttribute('aria-roledescription', 'carousel');
      bill.setAttribute('aria-label', 'Spotlight for ' + metric.name);
      const stage = h('div', 'mc-slides');
      stage.setAttribute('aria-live', 'off');
      slides.forEach((slide, i) => stage.appendChild(buildSlide(slide, i, slides.length)));
      bill.appendChild(stage);
      if (slides.length > 1) {
        const controls = h('div', 'mc-bill-controls');
        const dots = h('div', 'mc-dots');
        dots.setAttribute('role', 'group');
        dots.setAttribute('aria-label', 'Choose a slide');
        slides.forEach((slide, i) => {
          const d = button('mc-dot', 'Slide ' + (i + 1) + ' of ' + slides.length + ': ' + slide.kicker);
          d.dataset.index = String(i);
          dots.appendChild(d);
        });
        controls.appendChild(dots);
        if (!reduceMotion()) {
          const pause = button('mc-pause', 'Pause the slides');
          controls.appendChild(pause);
        }
        bill.appendChild(controls);
      }
      root.appendChild(bill);
      updatePauseBtn(s);
      showSlide(s, slideIndexFor(slides, s.id, s.index), false);
      scheduleSpot();
    });
  }

  // ----- Up next --------------------------------------------------------------
  const queueSeen = new Map();

  function queueIcon(entry, metric) {
    const span = h('span', 'mc-q-icon kind-' + entry.kind);
    span.setAttribute('aria-hidden', 'true');
    if (entry.kind === 'goal') {
      let svg = '';
      try { svg = api().iconFor(metric) || ''; } catch (e) { svg = ''; }
      span.innerHTML = svg || ICONS.target;
      if (metric && metric.color) span.style.setProperty('--mc-q', metric.color);
    } else {
      span.innerHTML = entry.kind === 'followup' ? ICONS.send : ICONS.bookmark;
    }
    return span;
  }

  function queueButton(entry) {
    let b;
    if (entry.action === 'log') {
      b = button('mc-q-btn mc-q-plus', 'Log 1 for ' + entry.title);
      b.appendChild(h('span', 'mc-q-btn-text', '+1'));
    } else if (entry.action === 'followed') {
      b = button('mc-q-btn', 'Mark ' + entry.name + ' as followed up');
      b.appendChild(h('span', 'mc-q-btn-text', 'Done'));
    } else {
      b = button('mc-q-btn', 'I applied to ' + entry.company + ' today. Log it.');
      b.appendChild(h('span', 'mc-q-btn-text', 'Applied'));
    }
    b.appendChild(icon('check', 'mc-q-check'));
    b.dataset.mcKey = entry.key;
    return b;
  }

  function announce(root, text) {
    const region = root.querySelector('.mc-live');
    if (!region) return;
    region.textContent = '';
    setTimeout(() => { region.textContent = text; }, 30);
  }

  function bindQueue(root, body) {
    root.addEventListener('click', e => {
      const b = e.target.closest('.mc-q-btn');
      if (!b || b.disabled) return;
      const st = stateOf(body);
      const entry = (st.queue || []).find(x => x.key === b.dataset.mcKey);
      if (!entry) return;
      const a = api();
      b.disabled = true;
      const row = b.closest('.mc-q');
      const done = () => {
        if (row) row.classList.add('is-done');
        b.classList.add('is-done');
      };
      const settle = reduceMotion() ? 0 : 520;
      if (entry.action === 'log') {
        const metric = a.metricById(entry.metricId);
        addOne(entry.metricId).then(log => {
          done();
          announce(root, 'Logged 1 for ' + entry.title + '.');
          status('Logged 1 for ' + (metric ? metric.name : entry.title) + '.', 'ok', undoLog(log));
          setTimeout(refresh, settle);
        }).catch(err => {
          b.disabled = false;
          oops('That did not log just now. Please try again.', err);
        });
      } else if (entry.action === 'followed') {
        markFollowedUp(entry.logId);
        done();
        announce(root, 'Marked as followed up.');
        status('Noted. Following up keeps you on their radar.', 'ok', { label: 'Undo', run: () => { unmarkFollowedUp(entry.logId); repaintAll(); } });
        setTimeout(() => repaintAll(), settle);
      } else {
        addOne('jobs', { company: entry.company }).then(log => {
          done();
          announce(root, 'Logged an application at ' + entry.company + '.');
          status('Logged an application at ' + entry.company + '. Nice work.', 'ok', undoLog(log));
          setTimeout(refresh, settle);
        }).catch(err => {
          b.disabled = false;
          oops('That did not log just now. Please try again.', err);
        });
      }
    });
  }

  function renderUpNext(body, item, metric, wrap) {
    if (!gate(body, item, wrap)) return;
    const st = remember(body, 'upNext', item, metric, wrap);
    if (item.options && item.options.collapsed) return;
    const root = rootOf(body, 'queue');
    if (!st.bound) {
      bindQueue(root, body);
      st.bound = true;
    }
    const a = api();
    const metrics = (a && a.visibleMetrics) || [];
    const hasJobs = metrics.some(m => m && m.id === 'jobs');
    withJobs(body, st, hasJobs, logs => {
      const stats = (a && a.stats) || {};
      const today = todayStr();
      const goals = metrics.map(m => ({ id: m.id, name: m.name, today: a.todayFor(m), goal: a.goalFor(m), met: a.goalMetFor(m) }));
      const q = buildUpNext({
        goals,
        restToday: !!stats.restToday,
        logs,
        followups,
        watchlist: hasJobs ? (a.watchlist || []) : [],
        todayStr: today,
        limit: item.options && item.options.size === 'compact' ? 4 : 6
      });
      st.queue = q.items;
      const sig = JSON.stringify([today, q, !!stats.restToday]);
      if (st.sig === sig && root.querySelector('.mc-q-wrap')) return;
      st.sig = sig;
      const prevCount = queueSeen.has(item.id) ? queueSeen.get(item.id) : -1;
      queueSeen.set(item.id, q.total);
      root.textContent = '';
      const region = h('span', 'sr-only mc-live');
      region.setAttribute('aria-live', 'polite');
      root.appendChild(region);
      const wrapEl = h('div', 'mc-q-wrap');
      root.appendChild(wrapEl);
      if (!q.items.length) {
        const caught = h('div', 'mc-caught' + (prevCount > 0 && !reduceMotion() ? ' is-fresh' : ''));
        caught.appendChild(icon('check', 'mc-caught-check'));
        caught.appendChild(h('p', 'mc-empty-title', stats.restToday ? 'Rest day' : 'All caught up'));
        caught.appendChild(h('p', 'mc-empty-line', stats.restToday
          ? 'Nothing needs you today. Rest is part of the plan.'
          : 'Every goal is met and nothing is waiting on you. Enjoy the rest of your day.'));
        wrapEl.appendChild(caught);
        return;
      }
      const list = h('ol', 'mc-q-list');
      list.setAttribute('aria-label', 'Up next');
      q.items.forEach((entry, i) => {
        const li = h('li', 'mc-q' + (i === 0 ? ' is-first' : ''));
        li.dataset.kind = entry.kind;
        const goalMetric = entry.kind === 'goal' ? a.metricById(entry.metricId) : null;
        li.appendChild(queueIcon(entry, goalMetric));
        const text = h('span', 'mc-q-text');
        if (i === 0) text.appendChild(h('span', 'mc-q-kicker', 'Up first'));
        text.appendChild(h('span', 'mc-q-title', entry.title));
        text.appendChild(h('span', 'mc-q-sub', entry.sub));
        li.appendChild(text);
        li.appendChild(queueButton(entry));
        list.appendChild(li);
      });
      wrapEl.appendChild(list);
      if (q.more) wrapEl.appendChild(h('p', 'mc-note', q.more === 1 ? 'One more after these.' : q.more + ' more after these.'));
    });
  }

  const RENDERERS = {
    continueRow: renderContinue,
    top10: renderTop10,
    spotlight: renderSpotlight,
    upNext: renderUpNext
  };

  // ----- Registration (load time) ---------------------------------------------
  Lit.registerCard('continueRow', {
    name: 'Pick up where you left off',
    description: 'Recent applications as a row of posters, with how far each has moved and a nudge when one is ready for a follow-up.',
    defaultSize: 'expanded',
    jobsOnly: true,
    defaults: {}
  }, renderContinue);

  Lit.registerCard('top10', {
    name: 'Your top 10',
    description: 'Your best days this month, the companies you apply to most, or your most common role words, ranked.',
    defaultSize: 'expanded',
    defaults: { metricId: 'active' },
    normalize: normalizeTop10
  }, renderTop10);

  Lit.registerCard('spotlight', {
    name: 'Spotlight',
    description: 'A rotating billboard: your next milestone, a company to try today, your streak, and your record day.',
    defaultSize: 'expanded',
    defaults: { metricId: 'active' }
  }, renderSpotlight);

  Lit.registerCard('upNext', {
    name: 'Up next',
    description: 'A short queue of what to do next: goals to finish today, follow-ups due, and companies to try.',
    defaultSize: 'expanded',
    defaults: {}
  }, renderUpNext);

  if (typeof Lit.addSetting === 'function') {
    Lit.addSetting({
      id: 'media-cards',
      label: 'Poster, top 10, spotlight, and up next cards',
      hint: 'Off hides these cards. Nothing you logged changes.',
      get: () => isOn(),
      set: async next => {
        await Lit.setModulePref(PREF_KEY, !!next);
        if (!next) closeSheet(false);
        await refresh();
      }
    });
  }

  Lit.whenReady(() => {
    Lit.on('modal', d => { if (d && d.open) closeSheet(false); else scheduleSpot(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSpot(); });
  });
})();
