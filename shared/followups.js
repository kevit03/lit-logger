// Follow-ups for LIT: which applications are ready for a friendly nudge,
// which have gone quiet, and a short note the person can copy into an email.
// Pure functions over plain job entries (the shape TrackerStorage.getLogs
// returns), so the service worker, the Applications page, and the tests all
// share one rule and nothing here touches storage.
//
// The rules, in plain words:
//   Ready for a follow-up  Still at Applied, not followed up yet, and its
//                          follow-up day has come. That day is the one the
//                          person picked (followUpAt), or followUpDays after
//                          applying. A default day stays "ready" until the
//                          application goes quiet; a day the person picked
//                          stays ready until they act on it.
//                          Marking it followed up settles it. Picking a new
//                          follow-up day after that makes it due again.
//   Gone quiet             Still at Applied quietDays after applying (30, or
//                          two weeks past a longer follow-up wait). Only ever
//                          a suggestion: nothing here changes a stage, and the
//                          page never does it on its own.
//   Nothing to follow up   An entry with no role and no company (a quick +1
//                          from the toolbar) has no one to write to, so it is
//                          never due and never quiet. Counting those would
//                          turn the daily reminder into noise.
// Splitting "ready" from "gone quiet" keeps the daily reminder about the
// recent applications a note can still help, instead of a total that only
// grows with months of history.
const LitFollowUps = (() => {
  const DEFAULT_DAYS = 7;
  const MIN_DAYS = 1;
  const MAX_DAYS = 60;
  const QUIET_DAYS = 30;
  // A follow-up wait always gets at least this many days of "ready" before
  // the application counts as gone quiet.
  const MIN_READY_DAYS = 14;
  // Offered by the Applications page. Any whole number in range is accepted.
  const DAY_CHOICES = [3, 5, 7, 10, 14, 21];

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ----- Dates (local calendar days, anchored at noon so DST never shifts one)

  function isDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1) return false;
    return d <= new Date(y, m, 0).getDate();
  }

  function toNoon(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }

  function dateStrOf(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function addDays(dateStr, n) {
    const d = toNoon(dateStr);
    d.setDate(d.getDate() + n);
    return dateStrOf(d);
  }

  function daysBetween(a, b) {
    return Math.round((toNoon(b).getTime() - toNoon(a).getTime()) / 86400000);
  }

  // The local day an ISO timestamp falls on, or null.
  function localDayOf(iso) {
    if (typeof iso !== 'string' || !iso) return null;
    const t = new Date(iso);
    return isNaN(t.getTime()) ? null : dateStrOf(t);
  }

  function todayOr(today) {
    return isDateStr(today) ? today : dateStrOf(new Date());
  }

  // "Nov 3", or "Nov 3, 2025" when it is not this year.
  function shortDate(dateStr, today) {
    if (!isDateStr(dateStr)) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const base = MONTHS[m - 1] + ' ' + d;
    return String(y) === todayOr(today).slice(0, 4) ? base : base + ', ' + y;
  }

  // ----- Entries -------------------------------------------------------------

  function settings(prefs) {
    const p = prefs || {};
    const n = parseInt(p.followUpDays, 10);
    const days = Number.isFinite(n) && n >= MIN_DAYS && n <= MAX_DAYS ? n : DEFAULT_DAYS;
    return {
      enabled: p.followUpEnabled !== false,
      days,
      quietDays: Math.max(QUIET_DAYS, days + MIN_READY_DAYS)
    };
  }

  function isJob(log) {
    return !!log && typeof log === 'object' && (log.metricId === undefined || log.metricId === 'jobs');
  }

  function statusOf(log) {
    const s = typeof log.status === 'string' ? log.status.trim().toLowerCase() : '';
    return s || 'applied';
  }

  function clean(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function hasSubject(log) {
    return !!(clean(log.role) || clean(log.company));
  }

  // Still waiting on a reply, with someone to write to.
  function isOpen(log) {
    return isJob(log) && isDateStr(log.date) && statusOf(log) === 'applied' && hasSubject(log);
  }

  // "Designer at Acme", "Designer", "Acme", or "Application".
  function entryName(log) {
    const role = clean(log && log.role);
    const company = clean(log && log.company);
    if (role && company) return role + ' at ' + company;
    return role || company || 'Application';
  }

  // The day to follow up: the one picked, or followUpDays after applying.
  function followUpDate(log, prefs) {
    if (!isJob(log) || !isDateStr(log.date)) return null;
    if (isDateStr(log.followUpAt)) return log.followUpAt;
    return addDays(log.date, settings(prefs).days);
  }

  function followedUpOn(log) {
    return localDayOf(log && log.followedUpAt);
  }

  // Followed up, and no later follow-up day has been picked since.
  function isSettled(log) {
    const done = followedUpOn(log);
    if (!done) return false;
    return !(isDateStr(log.followUpAt) && log.followUpAt > done);
  }

  function daysSinceApplied(log, today) {
    if (!log || !isDateStr(log.date)) return null;
    return Math.max(0, daysBetween(log.date, todayOr(today)));
  }

  function isGoneQuiet(log, today, prefs) {
    if (!isOpen(log)) return false;
    return daysSinceApplied(log, today) >= settings(prefs).quietDays;
  }

  function isDue(log, today, prefs) {
    if (!isOpen(log) || isSettled(log)) return false;
    const day = todayOr(today);
    if (isDateStr(log.followUpAt)) return day >= log.followUpAt;
    return day >= followUpDate(log, prefs) && !isGoneQuiet(log, day, prefs);
  }

  function byFollowUpThenDate(prefs) {
    return (a, b) => {
      const fa = followUpDate(a, prefs) || '';
      const fb = followUpDate(b, prefs) || '';
      if (fa !== fb) return fa < fb ? -1 : 1;
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
    };
  }

  // Oldest follow-up day first: the ones waiting longest lead.
  function dueFollowUps(logs, today, prefs) {
    const day = todayOr(today);
    return (Array.isArray(logs) ? logs : []).filter(l => isDue(l, day, prefs)).sort(byFollowUpThenDate(prefs));
  }

  // The due entries whose follow-up day came after `sinceDay`: what is new
  // since the last reminder. Without a sinceDay, all of them.
  function newlyDue(due, sinceDay, prefs) {
    const list = Array.isArray(due) ? due : [];
    if (!isDateStr(sinceDay)) return list.slice();
    return list.filter(l => (followUpDate(l, prefs) || '') > sinceDay);
  }

  function goneQuiet(logs, today, prefs) {
    const day = todayOr(today);
    return (Array.isArray(logs) ? logs : [])
      .filter(l => isGoneQuiet(l, day, prefs))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // What the Follow-up column shows for one entry:
  //   kind  'due' | 'upcoming' | 'quiet' | 'done' | 'none'
  //   date  the follow-up day (due, upcoming) or the day followed up (done)
  //   days  days past the follow-up day (due) or days left (upcoming)
  //   label short plain text for the cell
  //   quiet true when the entry has gone quiet (any kind)
  function followUpState(log, today, prefs) {
    const day = todayOr(today);
    const quiet = isGoneQuiet(log, day, prefs);
    const done = followedUpOn(log);
    if (isJob(log) && done && isSettled(log)) {
      return { kind: 'done', date: done, days: 0, label: 'Followed up ' + shortDate(done, day), quiet };
    }
    if (!isOpen(log)) return { kind: 'none', date: null, days: 0, label: '', quiet: false };
    const on = followUpDate(log, prefs);
    if (isDue(log, day, prefs)) {
      const late = daysBetween(on, day);
      return { kind: 'due', date: on, days: late, label: late === 0 ? 'Follow up today' : 'Ready to follow up', quiet };
    }
    if (on > day) {
      const left = daysBetween(day, on);
      const label = left === 1 ? 'Tomorrow' : left <= 6 ? 'In ' + left + ' days' : shortDate(on, day);
      return { kind: 'upcoming', date: on, days: left, label, quiet };
    }
    return { kind: 'quiet', date: null, days: 0, label: 'Gone quiet', quiet: true };
  }

  // ----- Words ---------------------------------------------------------------

  // "3 applications are ready for a follow-up", or '' for none.
  function summaryText(count) {
    const n = Math.max(0, parseInt(count, 10) || 0);
    if (!n) return '';
    return n === 1 ? '1 application is ready for a follow-up' : n + ' applications are ready for a follow-up';
  }

  // The daily notification: the count, and up to two of the entries by name.
  function notificationCopy(due) {
    const list = Array.isArray(due) ? due : [];
    const names = list.slice(0, 2).map(entryName);
    const more = list.length - names.length;
    let context = names.join(', ');
    if (more > 0) context += ', and ' + more + ' more';
    return {
      title: 'Time for a friendly follow-up',
      message: summaryText(list.length) + '. A short, kind note can keep you on their radar.',
      contextMessage: context
    };
  }

  // A short note to copy into an email. It names only the role and the
  // company, both as the person saved them: no invented names, dates, or
  // claims, and no placeholder that could be sent by mistake.
  function draft(log) {
    const role = clean(log && log.role);
    const company = clean(log && log.company);
    let what;
    let subject;
    if (role && company) {
      what = 'the ' + role + ' role at ' + company;
      subject = 'Following up on my application: ' + role + ' at ' + company;
    } else if (role) {
      what = 'the ' + role + ' role';
      subject = 'Following up on my application: ' + role;
    } else if (company) {
      what = 'the open role at ' + company;
      subject = 'Following up on my application to ' + company;
    } else {
      what = 'the role I applied for';
      subject = 'Following up on my application';
    }
    const opening = followedUpOn(log)
      ? 'I wanted to check in once more about my application for ' + what + '.'
      : 'I recently applied for ' + what + ' and wanted to follow up.';
    const body = [
      'Hello,',
      '',
      opening + ' I am still very interested, and I would be glad to share anything else that would help.',
      '',
      'Thank you for your time.'
    ].join('\n');
    return { subject, body, text: 'Subject: ' + subject + '\n\n' + body };
  }

  return {
    DEFAULT_DAYS,
    MIN_DAYS,
    MAX_DAYS,
    QUIET_DAYS,
    DAY_CHOICES,
    settings,
    entryName,
    followUpDate,
    followedUpOn,
    isDue,
    dueFollowUps,
    newlyDue,
    daysSinceApplied,
    isGoneQuiet,
    goneQuiet,
    followUpState,
    summaryText,
    notificationCopy,
    draft,
    shortDate,
    addDays,
    daysBetween,
    isDateStr
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LitFollowUps;
}
