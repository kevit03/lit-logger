// LIT Auto-apply panel on Jobright (https://jobright.ai/jobs/*).
//
// A floating "Auto-apply" launcher in the bottom-left corner opens a sheet
// listing the jobs Jobright recommends. The user picks some, chooses how many
// run in parallel and whether LIT submits on its own, and presses Start; the
// background orchestrator does the rest (LIT_BATCH_START). While a batch
// exists the sheet becomes a live view of `lit_batch`.
//
// Every job is preselected except sign-in walls: the batch runs on its own
// and leaves anything it cannot finish open for the user.
//
// The list is the one the page is showing. content/jobright/jobright-list-tap.js
// (page world) hands over each list response the page gets; asking the API
// separately does not give the same set (refresh=false at position 0 returns
// an older saved set). Only when nothing was handed over does the panel fetch
// the first page itself, with refresh=true like the page. Left out: jobs LIT
// submitted (lit_batch_done), jobs on Jobright's Applied list, and jobs the
// tracker has logged as applications (LIT_BATCH_APPLIED). On open it asks LIT_BATCH_CAPS and says, in one quiet line each,
// when company sites cannot be reached (no all-sites access) or open
// questions cannot be written (no Claude key; links to the options page via
// LIT_OPEN_OPTIONS).
//
// Refresh (header) rebuilds the list from what the page loaded, asks the
// Applied list and the tracker again, and checks every job card Jobright has
// in the page is accounted for. Each row's X removes that job; removals are
// kept in `lit_batch_dismissed` and can be restored. A queued job in a running
// batch has an X too (LIT_BATCH_REMOVE).
//
// This script only reads Jobright's own list and applied-jobs APIs (same
// origin, the user's cookies) and only writes `lit_batch_prefs` and
// `lit_batch_dismissed`. It never clicks anything on the
// Jobright page. Everything lives in a closed shadow root so neither side's
// CSS leaks into the other.
//
// Bare IIFE with no top-level bindings so a second injection into the same
// isolated world is not a redeclaration error.
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const existing = window.__litJobright;
  if (existing) {
    try { existing.check(); } catch (e) { /* the old copy is going away */ }
    if (typeof module !== 'undefined' && module.exports) module.exports = existing;
    return;
  }

  const HOST_ID = 'lit-jobright-host';
  const HOST_TAG = 'lit-jobright';
  const LIST_PATH = '/swan/recommend/list/jobs';
  const APPLIED_PATH = '/swan/job/applied/jobs-v3';
  const APPLIED_PAGES = 4;
  const APPLIED_PAGE_SIZE = 50;
  const TAP_TAG = 'lit-jobright-list';
  const DEFAULT_LIST = LIST_PATH + '?refresh=false&sortCondition=0&position=0&count=20&syncRerank=false';
  const DEFAULT_PAGE = 20;
  const BATCH_KEY = 'lit_batch';
  const DONE_KEY = 'lit_batch_done';
  const PREFS_KEY = 'lit_batch_prefs';
  const DISMISSED_KEY = 'lit_batch_dismissed';
  const DISMISSED_CAP = 500;
  // Jobright marks every job card it renders with this attribute. The list is
  // virtualized (only the cards near the viewport are in the page), so the
  // cards are a check on the list, never the list itself.
  const CARD_ATTR = 'data-newuser-touring-job-id';
  const JOB_ID_RE = /^[0-9a-f]{24}$/i;
  const COUNT_MIN = 5;
  const COUNT_MAX = 10;
  const DEFAULT_PREFS = { concurrency: 5, mode: 'submit' };
  const POLL_MS = 1000;
  const TITLE_MAX = 200;
  const ERROR_MAX = 140;

  // Same lists as the manifest's ATS content_scripts entries. Sign-in hosts
  // come first: they are in the universal list too, but LIT cannot get past
  // their account wall on its own.
  const SIGNIN_DOMAINS = ['myworkdayjobs.com', 'myworkdaysite.com', 'icims.com', 'taleo.net', 'oraclecloud.com',
    'successfactors.com', 'successfactors.eu'];
  const GENERIC_DOMAINS = ['workable.com', 'bamboohr.com', 'rippling-ats.com', 'smartrecruiters.com', 'jobvite.com',
    'applytojob.com', 'breezy.hr', 'recruitee.com', 'pinpointhq.com', 'teamtailor.com', 'jobs.personio.com',
    'jobs.personio.de', 'eightfold.ai', 'avature.net', 'ultipro.com', 'dayforcehcm.com', 'csod.com'];
  const GENERIC_EXACT = ['ats.rippling.com', 'jobs.gem.com', 'recruiting.paylocity.com', 'workforcenow.adp.com'];
  const SUPPORTED_RE = [/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/, /^jobs\.ashbyhq\.com$/, /^jobs(\.eu)?\.lever\.co$/];

  const KIND_LABEL = {
    supported: 'Supported',
    generic: 'Generic form',
    signin: 'Sign-in needed',
    unsupported: 'Company site'
  };
  // What each tag means, on hover.
  const KIND_TIP = {
    supported: 'LIT knows this job site well.',
    generic: 'LIT fills the common fields on this kind of form.',
    signin: 'This site needs you to sign in, so it is not picked for you.',
    unsupported: "A company's own site. LIT fills what it can."
  };
  const CAPS_SITES_TEXT = 'Turn on Detect applications on any career site in LIT settings so company sites can be filled.';
  const CAPS_AI_TEXT = 'Add a Claude API key in Autofill profile to write answers to open questions.';
  const STATUS_LABEL = {
    queued: 'Queued',
    opening: 'Opening',
    filling: 'Filling',
    submitting: 'Submitting',
    submitted: 'Submitted',
    ready: 'Ready to submit',
    'needs-you': 'Needs you',
    failed: 'Failed',
    skipped: 'Skipped'
  };
  const IN_FLIGHT = new Set(['opening', 'filling', 'submitting']);
  const OPENABLE = new Set(['needs-you', 'ready', 'failed']);
  const OPEN_LABEL = { 'needs-you': 'Open tab', ready: 'Review', failed: 'Open tab' };
  // Plain words for the short reasons the runner and the driver record.
  // Anything not listed is shown as it is.
  const REASON_COPY = {
    'CAPTCHA': 'The site wants to check you are not a robot.',
    'Sign-in required': 'This site needs you to sign in first.',
    'Workday needs you to sign in': 'Workday needs you to sign in first.',
    'Could not find Submit': 'Filled in. LIT could not find the Submit button.',
    'Submit is disabled': 'Filled in, but the site is not ready to submit yet.',
    'Submitted but no confirmation seen': 'LIT pressed Submit but saw no confirmation. Check the tab.',
    'No application form found': 'LIT could not find the application form.',
    'Timed out': 'This one took too long. Have a look in the tab.',
    'Tab closed': 'The tab was closed.',
    'Stopped': 'Stopped before it started.',
    'Stopped before submitting': 'Stopped before submitting. The form is still open if you want to finish it.',
    'Removed': 'Taken off this batch.',
    'Could not open a tab': 'Chrome could not open a tab for it.',
    'Something went wrong': 'Something went wrong on this page.'
  };
  const MISSING_SHOWN = 3;

  const HOST_STYLE = 'all: initial !important; position: fixed !important; width: 0 !important; height: 0 !important; ' +
    'left: 0 !important; bottom: 0 !important; z-index: 2147483645 !important; display: block !important;';

  // Warm Coach tokens, mirroring popup/popup.css (light) and its pt-dark set
  // (dark). --accent-fill is the coral shade that keeps white text at 4.5:1.
  const UI_CSS = `
    :host { all: initial; }
    .wrap {
      --font: ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, -apple-system, sans-serif;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
      --surface: #ffffff;
      --surface-2: #F4EFE7;
      --surface-3: #EDE6DB;
      --border: #E2D9CC;
      --border-soft: #F0EAE1;
      --text: #2A2622;
      --text-2: #6F665E;
      --text-3: #6F665E;
      --accent: #E0674B;
      --accent-text: #A9543F;
      --accent-fill: #A9543F;
      --accent-soft: #FBEBE6;
      --on-accent: #ffffff;
      --success: #4A6650;
      --success-soft: #E9F1EB;
      --warn: #8A5A12;
      --warn-soft: #FBF0DC;
      --danger: #B3402E;
      --danger-soft: #FBE9E4;
      --focus: #A9543F;
      --shadow-lg: 0 18px 40px rgba(42, 38, 34, 0.16), 0 2px 8px rgba(42, 38, 34, 0.06);
      --knob: #ffffff;
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.4;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --surface: #26221E;
        --surface-2: #2F2A25;
        --surface-3: #3A342D;
        --border: #463F37;
        --border-soft: #3A342D;
        --text: #F3EDE4;
        --text-2: #A89E92;
        --text-3: #9A9085;
        --accent: #F07A5E;
        --accent-text: #F07A5E;
        --accent-fill: #F07A5E;
        --accent-soft: rgba(240, 122, 94, 0.16);
        --on-accent: #1C1916;
        --success: #82B592;
        --success-soft: rgba(130, 181, 146, 0.14);
        --warn: #E3B566;
        --warn-soft: rgba(227, 181, 102, 0.12);
        --danger: #F0907E;
        --danger-soft: rgba(240, 144, 126, 0.12);
        --focus: #F07A5E;
        --shadow-lg: 0 18px 44px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06);
        --knob: #1C1916;
      }
    }
    *, *::before, *::after { box-sizing: border-box; }
    .hidden { display: none !important; }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;
      border-radius: 999px;
      transition: background 160ms var(--ease), color 160ms var(--ease), opacity 160ms var(--ease);
    }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    button[disabled] { cursor: default; opacity: 0.45; }

    .launcher {
      position: fixed;
      left: 16px;
      bottom: 16px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      height: 36px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-lg);
    }
    .launcher:hover { background: var(--surface-2); }
    .launcher .badge { font-size: 11px; font-weight: 500; color: var(--text-2); font-variant-numeric: tabular-nums; }
    .launcher .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }

    .panel {
      position: fixed;
      left: 16px;
      bottom: 64px;
      width: min(380px, calc(100vw - 32px));
      max-height: min(70vh, calc(100vh - 88px));
      display: flex;
      flex-direction: column;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow-lg);
      overflow: hidden;
    }
    .head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 16px 12px; }
    .titles { flex: 1; min-width: 0; }
    .title { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
    .sub { margin: 2px 0 0; font-size: 12px; color: var(--text-2); }
    .head-btns { flex: none; display: flex; gap: 2px; margin: -4px -6px 0 0; }
    .x {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; color: var(--text-2);
    }
    .x:hover { background: var(--surface-2); color: var(--text); }
    .x svg { width: 14px; height: 14px; }
    .refresh.spinning svg { animation: lit-spin 900ms linear infinite; }
    @keyframes lit-spin { to { transform: rotate(360deg); } }
    .row-x {
      flex: none; display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; margin: -1px -6px 0 -4px; color: var(--text-3);
    }
    .row-x:hover { background: var(--surface-3); color: var(--text); }
    .row-x svg { width: 12px; height: 12px; }
    .checked { margin: 0; padding: 8px 16px; font-size: 12px; color: var(--text-2); border-bottom: 1px solid var(--border-soft); }
    .checked.warn { color: var(--warn); background: var(--warn-soft); }
    .removed { margin: 0; font-size: 12px; color: var(--text-3); }
    .removed .link { padding: 0; font-size: 12px; }

    .body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; border-top: 1px solid var(--border-soft); scrollbar-width: thin; }
    .job {
      display: flex; align-items: flex-start; gap: 12px;
      padding: 10px 16px;
      border-top: 1px solid var(--border-soft);
    }
    .job:first-child { border-top: none; }
    label.job { cursor: pointer; }
    label.job:hover { background: var(--surface-2); }
    .job.muted .job-title, .job.muted .job-meta { color: var(--text-3); }
    .check { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--accent-fill); cursor: pointer; }
    .job:focus-within { background: var(--surface-2); }
    .main { flex: 1; min-width: 0; }
    .job-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .job-meta { margin-top: 2px; font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .reason { margin-top: 4px; font-size: 12px; color: var(--text-2); }
    .side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }

    .tag, .pill {
      flex: none; display: inline-block; padding: 3px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 500; line-height: 1.3; white-space: nowrap;
      color: var(--text-2); background: var(--surface-2);
    }
    .tag-supported { color: var(--accent-text); background: var(--accent-soft); }
    .tag-signin { color: var(--warn); background: var(--warn-soft); }
    .tag-unsupported { color: var(--text-3); background: transparent; border: 1px solid var(--border-soft); padding: 2px 7px; }
    .pill-opening, .pill-filling, .pill-submitting { color: var(--accent-text); background: var(--accent-soft); }
    .pill-submitted, .pill-ready { color: var(--success); background: var(--success-soft); }
    .pill-needs-you { color: var(--warn); background: var(--warn-soft); }
    .pill-failed { color: var(--danger); background: var(--danger-soft); }
    .pill-skipped { color: var(--text-3); background: transparent; border: 1px solid var(--border-soft); padding: 2px 7px; }

    .note { margin: 0; padding: 24px 16px; text-align: center; color: var(--text-2); }
    .more { display: flex; justify-content: center; padding: 12px 16px 16px; }
    .problem { padding: 20px 16px; text-align: center; }
    .problem p { margin: 0 0 12px; color: var(--text-2); }
    .summary { padding: 12px 16px; border-bottom: 1px solid var(--border-soft); }
    .summary-text { font-size: 12px; color: var(--text-2); }
    .bar { margin-top: 8px; height: 4px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .bar-fill { height: 100%; width: 0; border-radius: 999px; background: var(--accent); transition: width 240ms var(--ease); }
    .bar-fill.done { background: var(--success); }
    .callout {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 16px; font-size: 12px; color: var(--warn); background: var(--warn-soft);
      border-bottom: 1px solid var(--border-soft);
    }
    .callout-text { min-width: 0; }
    .callout .btn { flex: none; color: var(--warn); border-color: currentColor; }
    .missing { margin-top: 2px; font-size: 12px; color: var(--text-3); }

    .foot { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px 16px; border-top: 1px solid var(--border-soft); }
    .ctl { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .ctl-label { font-size: 12px; color: var(--text-2); }
    .seg { display: inline-flex; padding: 2px; gap: 2px; border-radius: 999px; background: var(--surface-2); }
    .seg button { min-width: 28px; height: 24px; padding: 0 8px; text-align: center; color: var(--text-2); font-variant-numeric: tabular-nums; }
    .seg button[aria-pressed="true"] { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgba(24, 25, 28, 0.14); }
    label.ctl { cursor: pointer; }
    .switch {
      appearance: none; -webkit-appearance: none; flex: none; position: relative; margin: 0;
      width: 36px; height: 22px; border-radius: 999px; background: var(--surface-3); cursor: pointer;
      transition: background 180ms var(--ease);
    }
    .switch::after {
      content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
      background: #ffffff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: transform 180ms var(--ease);
    }
    .switch:checked { background: var(--accent-fill); }
    .switch:checked::after { transform: translateX(14px); background: var(--knob); }
    .hint { margin: -6px 0 0; font-size: 12px; color: var(--text-3); }
    .caps { margin: 0; font-size: 12px; color: var(--text-2); }
    .caps.quiet { color: var(--text-3); }
    .caps .link { padding: 0; font-size: 12px; white-space: normal; }
    .error { margin: 0; font-size: 12px; color: var(--danger); }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .link { padding: 6px 2px; color: var(--accent-text); }
    .link:hover { text-decoration: underline; }
    .cta { height: 34px; padding: 0 16px; font-size: 13px; font-weight: 600; color: var(--on-accent); background: var(--accent-fill); }
    .cta:not([disabled]):hover { opacity: 0.9; }
    .btn { height: 30px; padding: 0 12px; color: var(--text); background: transparent; border: 1px solid var(--border); }
    .btn:not([disabled]):hover { background: var(--surface-2); }
    .btn-sm { height: 24px; padding: 0 10px; font-size: 11px; }
    .actions .btn { margin-left: auto; }
    .sel { display: inline-flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 12px; }
    .stop { height: 34px; padding: 0 16px; font-size: 13px; font-weight: 600; color: var(--danger); border-color: var(--danger); }
    .stop:not([disabled]):hover { background: var(--danger-soft); }
    .stop-hint { margin: 0; font-size: 12px; color: var(--text-3); }

    @media (max-width: 420px) {
      .panel { left: 8px; width: calc(100vw - 16px); }
      .launcher { left: 8px; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `;

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // --- state -----------------------------------------------------------------
  const st = {
    started: false,
    onRoute: false,
    href: '',
    open: false,
    jobs: [],              // mapped jobs in list order
    seen: new Set(),       // jobIds already preselected once
    selected: new Set(),
    position: 0,
    pageSize: 0,
    exhausted: false,
    loading: null,         // the in-flight load promise
    gen: 0,                // bumped on reload; stale responses are dropped
    feed: null,            // { jobs, next, size, exhausted }: what the page loaded
    hidden: new Set(),     // jobIds already applied to (Jobright or the tracker)
    raw: new Set(),        // every jobId in the lists behind st.jobs, mappable or not
    dismissed: {},         // jobId -> { title, company, at }: removed by the user (lit_batch_dismissed)
    refreshing: false,
    check: null,           // { onPage, missing, removed, total } from the last refresh
    appliedList: null,     // promise of Jobright's applied jobIds, once per open
    error: '',
    prefs: Object.assign({}, DEFAULT_PREFS),
    done: {},
    batch: null,
    startError: '',
    actionError: '',
    starting: false,
    caps: null,            // { allSites, ai } from LIT_BATCH_CAPS, null until known
    opened: new Set()      // batch jobIds the user opened from here, for "Open next"
  };
  let ui = null;           // { host, shadow, wrap, panel, sub, body, foot, launcher, badge, dot, refreshBtn }
  let pollTimer = null;
  let storageListener = null;

  // --- small helpers ---------------------------------------------------------
  function alive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function clean(s, max) {
    const out = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim();
    return max && out.length > max ? out.slice(0, max - 3).trimEnd() + '...' : out;
  }

  function hostOf(url) {
    try {
      const u = new URL(String(url || ''));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
      return u.hostname.toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function onDomain(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  function classifyHost(host) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!h) return 'unsupported';
    if (SUPPORTED_RE.some(re => re.test(h))) return 'supported';
    if (SIGNIN_DOMAINS.some(d => onDomain(h, d))) return 'signin';
    if (GENERIC_EXACT.includes(h) || GENERIC_DOMAINS.some(d => onDomain(h, d))) return 'generic';
    return 'unsupported';
  }

  // "job-boards.greenhouse.io" -> "greenhouse.io": enough to tell sites apart.
  function shortHost(host) {
    const parts = String(host || '').replace(/^www\./, '').split('.');
    return parts.length > 2 ? parts.slice(-2).join('.') : parts.join('.');
  }

  function clampCount(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_PREFS.concurrency;
    return Math.min(COUNT_MAX, Math.max(COUNT_MIN, v));
  }

  function normPrefs(p) {
    const src = p && typeof p === 'object' ? p : {};
    return {
      concurrency: clampCount(src.concurrency === undefined ? DEFAULT_PREFS.concurrency : src.concurrency),
      mode: src.mode === 'fill-only' ? 'fill-only' : 'submit'
    };
  }

  function isJobsRoute(pathname) {
    return /^\/jobs(\/|$)/.test(String(pathname || ''));
  }

  function currentLocation() {
    try {
      return { href: String(location.href), pathname: String(location.pathname), origin: String(location.origin) };
    } catch (e) {
      return { href: '', pathname: '', origin: 'https://jobright.ai' };
    }
  }

  // --- the list API ----------------------------------------------------------
  function mapJobs(apiJson) {
    const list = apiJson && apiJson.result && Array.isArray(apiJson.result.jobList) ? apiJson.result.jobList : [];
    const out = [];
    const ids = new Set();
    list.forEach(item => {
      if (!item || typeof item !== 'object') return;
      const jr = item.jobResult || {};
      const co = item.companyResult || {};
      const jobId = clean(jr.jobId);
      // Prefer the direct ATS link; originalUrl is often the job board's page.
      const url = hostOf(jr.applyLink) ? String(jr.applyLink).trim() : (hostOf(jr.originalUrl) ? String(jr.originalUrl).trim() : '');
      if (!jobId || !url || ids.has(jobId)) return;
      // Jobright does not show these on the page either.
      if (jr.hiddenJob === true || jr.isDeleted === true) return;
      ids.add(jobId);
      out.push({
        jobId,
        title: clean(jr.jobTitle, TITLE_MAX) || 'Untitled role',
        company: clean(co.companyName, TITLE_MAX),
        url,
        host: hostOf(url)
      });
    });
    return out;
  }

  // Every jobId in a list response, including ones mapJobs leaves out (no
  // usable link), so a card for such a job does not look missing.
  function rawIds(apiJson) {
    const list = apiJson && apiJson.result && Array.isArray(apiJson.result.jobList) ? apiJson.result.jobList : [];
    const out = [];
    list.forEach(item => {
      const id = item && item.jobResult ? clean(item.jobResult.jobId).toLowerCase() : '';
      if (id) out.push(id);
    });
    return out;
  }

  function perfEntries() {
    try {
      const perf = window.performance || (typeof performance !== 'undefined' ? performance : null);
      if (!perf || typeof perf.getEntriesByType !== 'function') return [];
      return perf.getEntriesByType('resource') || [];
    } catch (e) {
      return [];
    }
  }

  // The last list request the page itself made, so filters and sort match
  // what is on screen.
  function pageListUrl() {
    const entries = perfEntries().filter(e => e && typeof e.name === 'string' && e.name.indexOf(LIST_PATH) !== -1);
    if (!entries.length) return null;
    try {
      return new URL(entries[entries.length - 1].name, currentLocation().origin);
    } catch (e) {
      return null;
    }
  }

  function defaultPageSize() {
    const u = pageListUrl();
    const n = u ? parseInt(u.searchParams.get('count'), 10) : NaN;
    return n > 0 && n <= 50 ? n : DEFAULT_PAGE;
  }

  // `fresh` only for the first page when the page's own list was not seen:
  // like the page, it then asks with refresh=true, because refresh=false at
  // position 0 returns an older saved set. Later pages continue with false.
  function listUrl(position, count, fresh) {
    const origin = currentLocation().origin;
    const seen = pageListUrl();
    // Always same origin, whatever the entry said, so cookies apply.
    const u = seen ? new URL(seen.pathname + seen.search, origin) : new URL(DEFAULT_LIST, origin);
    u.searchParams.set('refresh', fresh ? 'true' : 'false');
    u.searchParams.set('position', String(Math.max(0, Math.floor(Number(position) || 0))));
    u.searchParams.set('count', String(count > 0 ? Math.floor(count) : defaultPageSize()));
    return u.toString();
  }

  // One source today (recommendations). A Liked source would add its own
  // url and map functions here.
  const SOURCE = {
    url: listUrl,
    map: mapJobs,
    // Raw page length: paging ends on a short page, not on a short mapped list.
    size: json => (json && json.result && Array.isArray(json.result.jobList) ? json.result.jobList.length : 0)
  };

  function fetcher() {
    return typeof window.fetch === 'function' ? window.fetch.bind(window) : (typeof fetch === 'function' ? fetch : null);
  }

  async function fetchPage(position, count, fresh) {
    const doFetch = fetcher();
    if (!doFetch) throw new Error('Could not reach Jobright.');
    let res;
    try {
      res = await doFetch(SOURCE.url(position, count, fresh), { credentials: 'include' });
    } catch (e) {
      throw new Error('Could not reach Jobright. Check your connection.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Sign in to Jobright to load your jobs.');
    if (!res.ok) throw new Error('Jobright returned an error (HTTP ' + res.status + ').');
    let json;
    try {
      json = JSON.parse(await res.text());
    } catch (e) {
      throw new Error('Could not read the job list. Are you signed in to Jobright?');
    }
    if (!json || typeof json !== 'object') throw new Error('Could not read the job list. Are you signed in to Jobright?');
    if (json.success === false) {
      const msg = clean(json.errorMsg, ERROR_MAX);
      throw new Error(msg ? 'Jobright could not load jobs: ' + msg : 'Jobright could not load jobs.');
    }
    return { jobs: SOURCE.map(json), size: SOURCE.size(json), raw: rawIds(json) };
  }

  function loadMore() {
    if (st.loading) return st.loading;
    if (!st.pageSize) st.pageSize = defaultPageSize();
    st.error = '';
    const position = st.position;
    const size = st.pageSize;
    const gen = st.gen;
    const current = () => gen === st.gen;
    st.loading = fetchPage(position, size, position === 0).then(({ jobs, size: got, raw }) => {
      if (!current()) return;
      raw.forEach(id => st.raw.add(id));
      addJobs(jobs);
      st.position = position + size;
      if (got < size) st.exhausted = true;
      return lookupApplied(jobs);
    }).catch(err => {
      if (current()) st.error = (err && err.message) || 'Could not load jobs.';
    }).then(() => {
      if (!current()) return;
      st.loading = null;
      render();
    });
    render();
    return st.loading;
  }

  function addJobs(jobs) {
    const known = new Set(st.jobs.map(j => j.jobId));
    jobs.forEach(job => {
      if (known.has(job.jobId)) return;
      known.add(job.jobId);
      st.jobs.push(job);
      // Preselect once, when a job first appears; later the user decides.
      if (!st.seen.has(job.jobId)) {
        st.seen.add(job.jobId);
        if (preselectable(job)) st.selected.add(job.jobId);
      }
    });
  }

  // Start over from what the page is showing. Selections the user made stay
  // (st.seen / st.selected); jobs no longer listed simply drop out.
  function reloadJobs() {
    st.gen += 1;
    st.jobs = [];
    st.position = 0;
    st.pageSize = 0;
    st.exhausted = false;
    st.error = '';
    st.loading = null;
    st.appliedList = null;
    st.check = null;
    st.raw = new Set(st.feed ? st.feed.raw : []);
    if (!st.feed || !st.feed.jobs.length) return loadMore();
    addJobs(st.feed.jobs);
    st.position = st.feed.next;
    st.pageSize = st.feed.size;
    st.exhausted = st.feed.exhausted;
    const gen = st.gen;
    st.loading = lookupApplied(st.jobs).then(() => {
      if (gen !== st.gen) return;
      st.loading = null;
      render();
    });
    render();
    return st.loading;
  }

  // --- the page's own list (from jobright-list-tap.js) ------------------------
  function onPageMessage(event) {
    if (!event || event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== TAP_TAG) return;
    if (typeof data.url !== 'string' || typeof data.body !== 'string') return;
    if (!alive()) { destroy(); return; }
    takePageList(data.url, data.body);
  }

  function takePageList(url, body) {
    let u;
    let json;
    try {
      u = new URL(url, currentLocation().origin);
      json = JSON.parse(body);
    } catch (e) {
      return false;
    }
    if (u.origin !== currentLocation().origin || u.pathname !== LIST_PATH) return false;
    if (!json || typeof json !== 'object' || json.success === false) return false;
    const position = Math.max(0, parseInt(u.searchParams.get('position'), 10) || 0);
    const asked = parseInt(u.searchParams.get('count'), 10);
    const got = SOURCE.size(json);
    const size = asked > 0 ? asked : (got || DEFAULT_PAGE);
    // A new set (first page, or refresh=true after a filter change) replaces
    // the old one; later pages extend it.
    const restart = position === 0 || u.searchParams.get('refresh') === 'true' || !st.feed;
    if (restart) st.feed = { jobs: [], next: 0, size, exhausted: false, raw: new Set() };
    const feed = st.feed;
    rawIds(json).forEach(id => feed.raw.add(id));
    const known = new Set(feed.jobs.map(j => j.jobId));
    SOURCE.map(json).forEach(j => { if (!known.has(j.jobId)) { known.add(j.jobId); feed.jobs.push(j); } });
    feed.next = Math.max(feed.next, position + size);
    feed.size = size;
    feed.exhausted = got < size;
    // An open picker follows the page (a filter change, say).
    if (st.open && st.onRoute && !st.batch) reloadJobs();
    return true;
  }

  // --- jobs already applied to ------------------------------------------------
  // Jobright's Applied list, most recent first. One read per open.
  async function jobrightApplied() {
    const doFetch = fetcher();
    const ids = new Set();
    if (!doFetch) return ids;
    const url = new URL(APPLIED_PATH, currentLocation().origin).toString();
    let cursor = null;
    for (let page = 0; page < APPLIED_PAGES; page++) {
      let json;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cursor, pageSize: APPLIED_PAGE_SIZE, applyStatus: 0 })
        });
        if (!res || !res.ok) break;
        json = JSON.parse(await res.text());
      } catch (e) {
        break;
      }
      const r = json && json.result && typeof json.result === 'object' ? json.result : null;
      if (!r || !Array.isArray(r.list)) break;
      r.list.forEach(item => {
        const id = item && item.jobResult ? clean(item.jobResult.jobId) : '';
        if (id) ids.add(id);
      });
      if (!r.hasMore || !r.cursor) break;
      cursor = r.cursor;
    }
    return ids;
  }

  // Marks which of `jobs` are already applied to; never fails the load.
  async function lookupApplied(jobs) {
    const list = (jobs || []).filter(j => !st.hidden.has(j.jobId));
    if (!list.length) return;
    if (!st.appliedList) st.appliedList = jobrightApplied().catch(() => new Set());
    const [onJobright, logged] = await Promise.all([
      st.appliedList,
      send({ type: 'LIT_BATCH_APPLIED', jobs: list.map(j => ({ jobId: j.jobId, title: j.title, company: j.company, url: j.url })) })
    ]);
    list.forEach(j => { if (onJobright.has(j.jobId)) st.hidden.add(j.jobId); });
    if (logged && logged.ok && Array.isArray(logged.jobIds)) logged.jobIds.forEach(id => st.hidden.add(String(id)));
    dropDone();
  }

  // --- chrome plumbing -------------------------------------------------------
  function send(message) {
    return new Promise(resolve => {
      if (!alive()) { destroy(); resolve({ ok: false, error: 'LIT was updated. Reload the page.' }); return; }
      try {
        chrome.runtime.sendMessage(message, response => {
          let lastError = null;
          try { lastError = chrome.runtime.lastError; } catch (e) { /* context gone */ }
          if (lastError || !response) resolve({ ok: false, error: 'LIT did not respond. Try again.' });
          else resolve(response);
        });
      } catch (e) {
        if (!alive()) destroy();
        resolve({ ok: false, error: 'LIT did not respond. Try again.' });
      }
    });
  }

  function readStorage() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([BATCH_KEY, DONE_KEY, PREFS_KEY, DISMISSED_KEY], items => {
          try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
          const all = items || {};
          setBatch(all[BATCH_KEY]);
          st.done = all[DONE_KEY] && typeof all[DONE_KEY] === 'object' ? all[DONE_KEY] : {};
          st.prefs = normPrefs(all[PREFS_KEY]);
          st.dismissed = validDismissed(all[DISMISSED_KEY]);
          dropDone();
          render();
          resolve();
        });
      } catch (e) {
        if (!alive()) destroy();
        resolve();
      }
    });
  }

  function savePrefs() {
    try {
      chrome.storage.local.set({ [PREFS_KEY]: { concurrency: st.prefs.concurrency, mode: st.prefs.mode } }, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
      });
    } catch (e) {
      if (!alive()) destroy();
    }
  }

  function validDismissed(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  // Newest DISMISSED_CAP only, so the record cannot grow without end.
  function saveDismissed() {
    const ids = Object.keys(st.dismissed)
      .sort((a, b) => (Number(st.dismissed[b] && st.dismissed[b].at) || 0) - (Number(st.dismissed[a] && st.dismissed[a].at) || 0));
    if (ids.length > DISMISSED_CAP) ids.slice(DISMISSED_CAP).forEach(id => { delete st.dismissed[id]; });
    try {
      chrome.storage.local.set({ [DISMISSED_KEY]: st.dismissed }, () => {
        try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
      });
    } catch (e) {
      if (!alive()) destroy();
    }
  }

  function validBatch(b) {
    return b && typeof b === 'object' && Array.isArray(b.jobs) ? b : null;
  }

  // A different batch starts its "Open next" from the top.
  function setBatch(raw) {
    const before = st.batch ? st.batch.id : null;
    st.batch = validBatch(raw);
    if (!st.batch || st.batch.id !== before) st.opened.clear();
  }

  function dropDone() {
    Object.keys(st.done).forEach(id => st.selected.delete(id));
    Object.keys(st.dismissed).forEach(id => st.selected.delete(id));
    st.hidden.forEach(id => st.selected.delete(id));
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes) return;
    if (!alive()) { destroy(); return; }
    let dirty = false;
    if (changes[BATCH_KEY]) {
      setBatch(changes[BATCH_KEY].newValue);
      if (st.batch) st.startError = '';
      else st.actionError = '';
      dirty = true;
    }
    if (changes[DONE_KEY]) {
      const v = changes[DONE_KEY].newValue;
      st.done = v && typeof v === 'object' ? v : {};
      dropDone();
      dirty = true;
    }
    if (changes[PREFS_KEY]) {
      st.prefs = normPrefs(changes[PREFS_KEY].newValue);
      dirty = true;
    }
    if (changes[DISMISSED_KEY]) {
      st.dismissed = validDismissed(changes[DISMISSED_KEY].newValue);
      dropDone();
      dirty = true;
    }
    if (dirty) render();
    if (changes[BATCH_KEY] && changes[BATCH_KEY].oldValue && !st.batch) reloadIfPicking();
  }

  // --- actions ---------------------------------------------------------------
  // What the picker shows: Jobright's current list minus jobs LIT submitted,
  // jobs already applied to, and jobs the user removed.
  function listedJobs() {
    return st.jobs.filter(j => !st.done[j.jobId] && !st.hidden.has(j.jobId) && !st.dismissed[j.jobId]);
  }

  // Removed by the user but still in the loaded list: what Restore brings back.
  function removedJobs() {
    return st.jobs.filter(j => st.dismissed[j.jobId] && !st.done[j.jobId] && !st.hidden.has(j.jobId));
  }

  function selectedJobs() {
    return listedJobs().filter(j => st.selected.has(j.jobId));
  }

  // Full autonomy: everything LIT can get into on its own. Sign-in walls stay
  // off until the user picks them.
  function preselectable(job) {
    return classifyHost(job.host) !== 'signin' && !st.done[job.jobId] && !st.dismissed[job.jobId];
  }

  function selectableOpen() {
    return listedJobs().filter(preselectable);
  }

  // Select all: everything LIT can get into on its own (sign-in walls stay
  // for the user to pick). None: nothing.
  function selectAll() {
    st.selected.clear();
    selectableOpen().forEach(j => st.selected.add(j.jobId));
    render();
  }

  function selectNone() {
    st.selected.clear();
    render();
  }

  // The row's X: off the list, and it stays off across refreshes and visits.
  function dismiss(jobId, record) {
    const id = clean(jobId);
    if (!id) return;
    const job = st.jobs.find(j => j.jobId === id) || record || {};
    st.dismissed[id] = { title: clean(job.title, TITLE_MAX), company: clean(job.company, TITLE_MAX), at: Date.now() };
    st.selected.delete(id);
    saveDismissed();
    render();
  }

  function restoreRemoved() {
    const jobs = removedJobs();
    if (!jobs.length) return;
    jobs.forEach(j => {
      delete st.dismissed[j.jobId];
      if (preselectable(j)) st.selected.add(j.jobId);
    });
    saveDismissed();
    render();
  }

  // The jobIds of the cards Jobright has in the page right now.
  function pageJobIds() {
    const ids = new Set();
    try {
      const cards = document.querySelectorAll('[' + CARD_ATTR + ']');
      Array.prototype.forEach.call(cards, el => {
        const id = clean(el.getAttribute(CARD_ATTR)).toLowerCase();
        if (JOB_ID_RE.test(id)) ids.add(id);
      });
    } catch (e) { /* no cards to read */ }
    return Array.from(ids);
  }

  // The Refresh button: re-read what LIT has recorded, rebuild from the jobs
  // the page loaded, ask Jobright's Applied list and the tracker again, then
  // check every job card in the page is accounted for.
  async function refresh() {
    if (st.refreshing || !st.open || st.batch) return st.check;
    st.refreshing = true;
    render();
    const before = new Set(listedJobs().map(j => j.jobId));
    await readStorage();
    if (st.batch) {
      st.refreshing = false;
      render();
      return null;
    }
    await reloadJobs();
    const listed = listedJobs().map(j => j.jobId);
    const onPage = pageJobIds();
    const known = new Set(Array.from(st.raw).concat(st.jobs.map(j => j.jobId.toLowerCase())));
    st.check = st.error ? null : {
      onPage: onPage.length,
      missing: onPage.filter(id => !known.has(id)).length,
      removed: Array.from(before).filter(id => !listed.includes(id) && !st.dismissed[id]).length,
      total: listed.length
    };
    st.refreshing = false;
    render();
    return st.check;
  }

  function setCount(n) {
    st.prefs.concurrency = clampCount(n);
    savePrefs();
    render();
  }

  function setMode(submit) {
    st.prefs.mode = submit ? 'submit' : 'fill-only';
    savePrefs();
    render();
  }

  async function start() {
    const jobs = selectedJobs();
    if (!jobs.length || st.starting || batchRunning()) return { ok: false };
    st.starting = true;
    st.startError = '';
    render();
    const response = await send({
      type: 'LIT_BATCH_START',
      jobs: jobs.map(j => ({ jobId: j.jobId, title: j.title, company: j.company, url: j.url })),
      concurrency: st.prefs.concurrency,
      mode: st.prefs.mode
    });
    st.starting = false;
    if (!response.ok) st.startError = clean(response.error, ERROR_MAX) || 'Could not start.';
    else await readStorage();
    render();
    return response;
  }

  async function action(message) {
    st.actionError = '';
    const response = await send(message);
    if (!response.ok) st.actionError = clean(response.error, ERROR_MAX) || 'Something went wrong. Try again.';
    render();
    return response;
  }

  async function loadCaps() {
    const response = await send({ type: 'LIT_BATCH_CAPS' });
    st.caps = response && typeof response.allSites === 'boolean'
      ? { allSites: response.allSites, ai: !!response.ai }
      : null;
    render();
    return st.caps;
  }

  const openOptions = () => send({ type: 'LIT_OPEN_OPTIONS' });
  const stopBatch = () => action({ type: 'LIT_BATCH_STOP' });
  const focusJob = jobId => {
    st.opened.add(String(jobId));
    return action({ type: 'LIT_BATCH_FOCUS', jobId });
  };
  // Off a running batch before it starts, and off the picker from then on.
  async function removeFromBatch(job) {
    const response = await action({ type: 'LIT_BATCH_REMOVE', jobId: job.jobId });
    if (response.ok) dismiss(job.jobId, job);
    return response;
  }
  async function clearBatch() {
    const response = await action({ type: 'LIT_BATCH_CLEAR' });
    if (response.ok) { await readStorage(); await reloadIfPicking(); }
    return response;
  }

  function batchRunning() {
    return !!(st.batch && st.batch.status === 'running');
  }

  // --- summary ---------------------------------------------------------------
  function summarize(jobs) {
    const n = {};
    (jobs || []).forEach(j => { const s = IN_FLIGHT.has(j.status) ? 'running' : j.status; n[s] = (n[s] || 0) + 1; });
    const parts = [];
    if (n.submitted) parts.push(n.submitted + ' submitted');
    if (n.ready) parts.push(n.ready + ' ready');
    if (n['needs-you']) parts.push(n['needs-you'] + (n['needs-you'] === 1 ? ' needs you' : ' need you'));
    if (n.failed) parts.push(n.failed + ' failed');
    if (n.skipped) parts.push(n.skipped + ' skipped');
    if (n.running) parts.push(n.running + ' running');
    if (n.queued) parts.push(n.queued + ' queued');
    return parts.join(', ');
  }

  function reasonText(job) {
    const raw = clean(job && job.reason, ERROR_MAX);
    if (/^Error:/i.test(raw)) return REASON_COPY['Something went wrong'];
    const m = /^(\d+) required fields? needs? you$/i.exec(raw);
    if (m) return m[1] === '1' ? '1 question needs your answer.' : m[1] + ' questions need your answer.';
    return REASON_COPY[raw] || raw;
  }

  // "Still to answer: Why us?, Pronouns and 2 more", from the driver's list.
  function missingText(job) {
    const list = (Array.isArray(job && job.missing) ? job.missing : []).map(m => clean(m, 60)).filter(Boolean);
    if (!list.length || job.status !== 'needs-you') return '';
    const shown = list.slice(0, MISSING_SHOWN).join(', ');
    const more = list.length - MISSING_SHOWN;
    return 'Still to answer: ' + shown + (more > 0 ? ' and ' + more + ' more' : '');
  }

  // A finished job's tab is still there to open (the runner forgets a tab
  // once it is closed).
  function canOpen(job) {
    return OPENABLE.has(job.status) && typeof job.tabId === 'number';
  }

  // Finished jobs waiting on the user, with their tab open for them.
  function waitingJobs(jobs) {
    return (jobs || []).filter(j => (j.status === 'needs-you' || j.status === 'ready') && canOpen(j));
  }

  function progress(jobs) {
    const list = jobs || [];
    const finished = list.filter(j => !IN_FLIGHT.has(j.status) && j.status !== 'queued').length;
    return { finished, total: list.length };
  }

  // --- DOM -------------------------------------------------------------------
  function h(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(cls, text, onClick) {
    const b = h('button', cls, text);
    b.setAttribute('type', 'button');
    b.addEventListener('click', event => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      if (b.disabled) return;
      onClick(event);
    });
    return b;
  }

  const CLOSE_PATH = 'M4 4l8 8M12 4l-8 8';
  const REFRESH_PATH = 'M13 8a5 5 0 1 1-1.46-3.54M13 2.5V5h-2.5';

  // Built node by node: no innerHTML, so a page Trusted Types policy has
  // nothing to object to.
  function icon(d) {
    if (typeof document.createElementNS !== 'function') return null;
    try {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
      return svg;
    } catch (e) {
      return null;
    }
  }

  function iconButton(cls, d, label, tip, onClick) {
    const b = button(cls, null, onClick);
    b.setAttribute('aria-label', label);
    b.setAttribute('title', tip);
    const svg = icon(d);
    if (svg) b.appendChild(svg);
    else b.textContent = label;
    return b;
  }

  function ensureUi() {
    if (ui) return ui;
    // A host left by an orphaned copy (extension reloaded) is unreachable.
    const stale = document.getElementById(HOST_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    const host = document.createElement(HOST_TAG);
    host.id = HOST_ID;
    host.setAttribute('style', HOST_STYLE);
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const wrap = h('div', 'wrap');
    const panel = h('section', 'panel hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Auto-apply');
    // Focusable itself, so opening can put the keyboard inside the sheet
    // before the list has loaded.
    panel.setAttribute('tabindex', '-1');
    panel.addEventListener('keydown', onPanelKey);

    const head = h('header', 'head');
    const titles = h('div', 'titles');
    titles.appendChild(h('h2', 'title', 'Auto-apply'));
    const sub = h('p', 'sub');
    titles.appendChild(sub);
    const refreshBtn = iconButton('x refresh', REFRESH_PATH, 'Refresh', 'Refresh and check against the page', () => { refresh(); });
    refreshBtn.setAttribute('data-key', 'refresh');
    const x = iconButton('x', CLOSE_PATH, 'Close', 'Close', close);
    const btns = h('div', 'head-btns');
    btns.appendChild(refreshBtn);
    btns.appendChild(x);
    head.appendChild(titles);
    head.appendChild(btns);

    const body = h('div', 'body');
    const foot = h('footer', 'foot');
    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(foot);

    const launcher = button('launcher hidden', null, () => { if (st.open) close(); else open(); });
    launcher.setAttribute('aria-label', 'Auto-apply');
    launcher.setAttribute('aria-expanded', 'false');
    const dot = h('span', 'dot hidden');
    launcher.appendChild(dot);
    launcher.appendChild(h('span', 'label', 'Auto-apply'));
    const badge = h('span', 'badge hidden');
    launcher.appendChild(badge);

    wrap.appendChild(panel);
    wrap.appendChild(launcher);
    shadow.appendChild(wrap);
    (document.body || document.documentElement).appendChild(host);
    ui = { host, shadow, wrap, panel, sub, body, foot, launcher, badge, dot, refreshBtn };
    return ui;
  }

  function render() {
    if (!ui) return;
    const running = batchRunning();
    ui.launcher.classList.toggle('hidden', !st.onRoute);
    ui.launcher.setAttribute('aria-expanded', st.open ? 'true' : 'false');
    const p = st.batch ? progress(st.batch.jobs) : null;
    ui.dot.classList.toggle('hidden', !running);
    ui.badge.classList.toggle('hidden', !running);
    ui.badge.textContent = running && p ? p.finished + '/' + p.total : '';
    ui.panel.classList.toggle('hidden', !(st.open && st.onRoute));
    ui.refreshBtn.classList.toggle('hidden', !!st.batch);
    ui.refreshBtn.classList.toggle('spinning', st.refreshing);
    ui.refreshBtn.disabled = st.refreshing || !!st.loading;
    if (!st.open) return;
    // Everything is rebuilt; keep the scroll position and the focused control.
    const scroll = ui.body.scrollTop || 0;
    let focusKey = null;
    try {
      const active = ui.shadow.activeElement;
      focusKey = active && active.getAttribute ? active.getAttribute('data-key') : null;
    } catch (e) { /* no focus tracking here */ }
    ui.body.textContent = '';
    ui.foot.textContent = '';
    if (st.batch) renderBatch();
    else renderPicker();
    ui.body.scrollTop = scroll;
    if (focusKey) {
      try {
        const again = ui.panel.querySelector('[data-key="' + focusKey + '"]');
        if (again && typeof again.focus === 'function') again.focus();
      } catch (e) { /* odd id or not focusable */ }
    }
  }

  function keyed(node, key) {
    node.setAttribute('data-key', key);
    return node;
  }

  function activeEl() {
    try { return (ui && ui.shadow.activeElement) || null; } catch (e) { return null; }
  }

  function focusEl(node) {
    try { if (node && typeof node.focus === 'function') node.focus(); } catch (e) { /* not focusable */ }
  }

  function prevent(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
  }

  // Keys inside the sheet: Esc closes it; Up / Down (and Home / End) move
  // between the jobs in the list; Left / Right change "Jobs at a time".
  function onPanelKey(event) {
    if (!event || !ui) return;
    const key = event.key;
    if (key === 'Escape') {
      close();
      focusEl(ui.launcher);
      return;
    }
    const active = activeEl();
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const n = active && active.getAttribute ? parseInt(active.getAttribute('data-count'), 10) : NaN;
      if (!Number.isFinite(n)) return;
      prevent(event);
      setCount(n + (key === 'ArrowRight' ? 1 : -1));
      focusEl(ui.panel.querySelector('[data-count="' + st.prefs.concurrency + '"]'));
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
    const items = Array.prototype.slice.call(ui.body.querySelectorAll('[data-nav]'));
    const i = items.indexOf(active);
    // Only from the sheet itself or a row; elsewhere the keys keep their usual job.
    if (!items.length || (i < 0 && active !== ui.panel)) return;
    prevent(event);
    let next;
    if (key === 'Home') next = 0;
    else if (key === 'End') next = items.length - 1;
    else if (i < 0) next = key === 'ArrowDown' ? 0 : items.length - 1;
    else next = Math.min(items.length - 1, Math.max(0, i + (key === 'ArrowDown' ? 1 : -1)));
    focusEl(items[next]);
  }

  function renderPicker() {
    const listed = listedJobs();
    const n = listed.length;
    const picked = selectedJobs().length;
    ui.sub.textContent = n ? picked + ' of ' + n + ' selected' : 'Jobs from your Jobright list';
    const checked = checkLine();
    if (checked) ui.body.appendChild(checked);

    if (!n && st.loading) {
      ui.body.appendChild(h('p', 'note', 'Loading jobs...'));
    } else if (!n && st.error) {
      ui.body.appendChild(problem(st.error));
    } else if (!n) {
      ui.body.appendChild(h('p', 'note', st.jobs.length ? 'You have applied to every job loaded so far.' : 'No jobs found.'));
      if (st.jobs.length && !st.exhausted) ui.body.appendChild(loadMoreRow());
    } else {
      const list = h('div', 'list');
      listed.forEach(job => list.appendChild(pickerRow(job)));
      ui.body.appendChild(list);
      if (st.error) ui.body.appendChild(problem(st.error));
      else if (!st.exhausted) ui.body.appendChild(loadMoreRow());
    }

    const count = h('div', 'ctl');
    count.appendChild(h('span', 'ctl-label', 'Jobs at a time'));
    const seg = h('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Jobs at a time');
    for (let i = COUNT_MIN; i <= COUNT_MAX; i++) {
      const b = button('', String(i), () => setCount(i));
      b.setAttribute('data-count', String(i));
      keyed(b, 'count-' + i);
      b.setAttribute('aria-pressed', st.prefs.concurrency === i ? 'true' : 'false');
      seg.appendChild(b);
    }
    count.appendChild(seg);
    ui.foot.appendChild(count);

    const mode = h('label', 'ctl');
    mode.appendChild(h('span', 'ctl-label', 'Submit automatically'));
    const sw = h('input', 'switch');
    sw.setAttribute('type', 'checkbox');
    sw.setAttribute('role', 'switch');
    keyed(sw, 'mode');
    sw.checked = st.prefs.mode === 'submit';
    sw.addEventListener('change', () => setMode(!!sw.checked));
    mode.appendChild(sw);
    ui.foot.appendChild(mode);
    ui.foot.appendChild(h('p', 'hint', st.prefs.mode === 'submit'
      ? 'Anything LIT is unsure of stays open for you.'
      : 'Forms are filled and left open for you to submit.'));

    if (st.caps && !st.caps.allSites && selectedJobs().some(j => classifyHost(j.host) === 'unsupported')) {
      ui.foot.appendChild(h('p', 'caps caps-sites', CAPS_SITES_TEXT));
    }
    if (st.caps && !st.caps.ai) {
      const line = h('p', 'caps quiet caps-ai', CAPS_AI_TEXT + ' ');
      line.appendChild(keyed(button('link open-options', 'Open Autofill profile', () => { openOptions(); }), 'open-options'));
      ui.foot.appendChild(line);
    }

    const removed = removedJobs().length;
    if (removed) {
      const line = h('p', 'removed', removed + ' removed from this list. ');
      line.appendChild(keyed(button('link restore', 'Restore', restoreRemoved), 'restore'));
      ui.foot.appendChild(line);
    }

    if (st.startError) ui.foot.appendChild(h('p', 'error start-error', st.startError));

    const actions = h('div', 'actions');
    const targets = selectableOpen();
    const allOn = targets.length > 0 && targets.every(j => st.selected.has(j.jobId));
    const sel = h('div', 'sel');
    sel.setAttribute('role', 'group');
    sel.setAttribute('aria-label', 'Select');
    const all = keyed(button('link select-all', 'Select all', selectAll), 'select-all');
    all.disabled = !targets.length || allOn;
    const none = keyed(button('link select-none', 'None', selectNone), 'select-none');
    none.disabled = !picked;
    sel.appendChild(all);
    sel.appendChild(h('span', 'sel-sep', '/'));
    sel.appendChild(none);
    actions.appendChild(sel);
    const verb = st.prefs.mode === 'submit' ? 'Apply to ' : 'Fill ';
    const cta = button('cta start', st.starting ? 'Starting...' : verb + picked, () => { start(); });
    cta.disabled = !picked || st.starting;
    keyed(cta, 'start');
    actions.appendChild(cta);
    ui.foot.appendChild(actions);
  }

  function checkLine() {
    const c = st.check;
    if (!c) return null;
    if (c.missing) {
      return h('p', 'checked warn', c.missing + (c.missing === 1 ? ' job on the Jobright page is' : ' jobs on the Jobright page are') +
        ' not in this list. Reload the Jobright page, then refresh.');
    }
    const parts = [c.onPage ? 'Checked against the page.' : 'Refreshed.'];
    parts.push(c.removed ? c.removed + ' already applied to, taken off.' : 'No applied jobs in the list.');
    return h('p', 'checked', parts.join(' '));
  }

  function loadMoreRow() {
    const more = h('div', 'more');
    const b = button('btn', st.loading ? 'Loading...' : 'Load more', () => { loadMore(); });
    b.classList.add('load-more');
    keyed(b, 'load-more');
    b.disabled = !!st.loading;
    more.appendChild(b);
    return more;
  }

  function pickerRow(job) {
    const kind = classifyHost(job.host);
    const row = h('label', 'job');
    row.setAttribute('data-job-id', job.jobId);
    const cb = h('input', 'check');
    cb.setAttribute('type', 'checkbox');
    keyed(cb, 'job-' + job.jobId);
    cb.setAttribute('data-nav', '');
    cb.checked = st.selected.has(job.jobId);
    cb.addEventListener('change', () => {
      if (cb.checked) st.selected.add(job.jobId);
      else st.selected.delete(job.jobId);
      render();
    });
    row.appendChild(cb);
    const main = h('div', 'main');
    const title = h('div', 'job-title', job.title);
    title.setAttribute('title', job.title);
    main.appendChild(title);
    main.appendChild(h('div', 'job-meta', [job.company, shortHost(job.host)].filter(Boolean).join(' · ')));
    row.appendChild(main);
    const tag = h('span', 'tag tag-' + kind, KIND_LABEL[kind]);
    tag.setAttribute('title', KIND_TIP[kind]);
    row.appendChild(tag);
    row.appendChild(removeButton(job, () => dismiss(job.jobId)));
    return row;
  }

  function removeButton(job, onClick) {
    const what = [clean(job.title, TITLE_MAX) || 'this job', clean(job.company, TITLE_MAX)].filter(Boolean).join(' at ');
    const b = iconButton('row-x', CLOSE_PATH, 'Remove ' + what, 'Remove from list', onClick);
    return keyed(b, 'remove-' + job.jobId);
  }

  function problem(message) {
    const box = h('div', 'problem');
    box.appendChild(h('p', 'problem-text', message));
    box.appendChild(keyed(button('btn retry', 'Retry', () => { loadMore(); }), 'retry'));
    return box;
  }

  function renderBatch() {
    const b = st.batch;
    const running = b.status === 'running';
    const p = progress(b.jobs);
    ui.sub.textContent = (running ? 'Running' : b.status === 'stopped' ? 'Stopped' : 'Finished') +
      ' · ' + p.finished + ' of ' + p.total + ' done';

    const summary = h('div', 'summary');
    summary.appendChild(h('div', 'summary-text', summarize(b.jobs) || 'No jobs'));
    const bar = h('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', p.finished + ' of ' + p.total + ' done');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(p.total));
    bar.setAttribute('aria-valuenow', String(p.finished));
    const fill = h('div', 'bar-fill' + (running ? '' : ' done'));
    fill.style.width = (p.total ? Math.round((p.finished / p.total) * 100) : 0) + '%';
    bar.appendChild(fill);
    summary.appendChild(bar);
    ui.body.appendChild(summary);

    // Jobs waiting on the user, said once at the top with the next one a
    // click away. Each row also has its own Open button.
    const waiting = waitingJobs(b.jobs);
    if (waiting.length) {
      const callout = h('div', 'callout');
      callout.appendChild(h('span', 'callout-text', waiting.length === 1
        ? '1 job needs you. Open it to finish, then press Submit yourself.'
        : waiting.length + ' jobs need you. Open each one to finish, then press Submit yourself.'));
      const nextJob = waiting.find(j => !st.opened.has(String(j.jobId))) || waiting[0];
      const nextBtn = button('btn btn-sm open-next', waiting.length === 1 ? 'Open it' : 'Open next', () => { focusJob(nextJob.jobId); });
      callout.appendChild(keyed(nextBtn, 'open-next'));
      ui.body.appendChild(callout);
    }

    const list = h('div', 'list');
    b.jobs.forEach(job => list.appendChild(batchRow(job)));
    ui.body.appendChild(list);

    if (st.actionError) ui.foot.appendChild(h('p', 'error action-error', st.actionError));
    if (running) {
      ui.foot.appendChild(h('p', 'stop-hint', 'Stop opens nothing new and submits nothing more. Tabs that need you stay open.'));
    }
    const actions = h('div', 'actions');
    if (running) actions.appendChild(keyed(button('btn stop', 'Stop batch', () => { stopBatch(); }), 'stop'));
    else actions.appendChild(keyed(button('btn clear', 'Back to job list', () => { clearBatch(); }), 'clear'));
    ui.foot.appendChild(actions);
  }

  function batchRow(job) {
    const row = h('div', 'job');
    row.setAttribute('data-job-id', String(job.jobId || ''));
    row.setAttribute('data-status', String(job.status || ''));
    const main = h('div', 'main');
    const titleText = clean(job.title, TITLE_MAX) || 'Untitled role';
    const title = h('div', 'job-title', titleText);
    title.setAttribute('title', titleText);
    main.appendChild(title);
    const meta = [clean(job.company, TITLE_MAX), shortHost(job.host)].filter(Boolean).join(' · ');
    if (meta) main.appendChild(h('div', 'job-meta', meta));
    const reason = reasonText(job);
    if (reason) main.appendChild(h('div', 'reason', reason));
    const missing = missingText(job);
    if (missing) main.appendChild(h('div', 'missing', missing));
    row.appendChild(main);
    const side = h('div', 'side');
    side.appendChild(h('span', 'pill pill-' + job.status, STATUS_LABEL[job.status] || clean(job.status)));
    if (canOpen(job)) {
      const openBtn = button('btn btn-sm open-job', OPEN_LABEL[job.status], () => { focusJob(job.jobId); });
      openBtn.setAttribute('aria-label', 'Open the tab for ' + titleText);
      openBtn.setAttribute('data-nav', '');
      keyed(openBtn, 'open-' + job.jobId);
      side.appendChild(openBtn);
    }
    row.appendChild(side);
    if (job.status === 'queued' && st.batch && st.batch.status === 'running') {
      row.appendChild(removeButton(job, () => { removeFromBatch(job); }));
    }
    return row;
  }

  // --- open / close / route --------------------------------------------------
  function open() {
    if (!ui || !st.onRoute) return Promise.resolve();
    if (st.open) return st.loading || Promise.resolve();
    st.open = true;
    render();
    // Into the sheet, so the keyboard starts where the jobs are.
    focusEl(ui.panel);
    return Promise.all([reloadIfPicking(), loadCaps()]).then(() => undefined);
  }

  // The picker always shows Jobright's list as it is now, never a copy from
  // an earlier open; a panel showing a batch has no picker to fill.
  function reloadIfPicking() {
    if (st.open && st.onRoute && !st.batch) return reloadJobs();
    return Promise.resolve();
  }

  function close() {
    st.open = false;
    render();
  }

  function check() {
    if (!alive()) { destroy(); return; }
    const loc = currentLocation();
    if (loc.href === st.href && ui) return;
    st.href = loc.href;
    const onRoute = isJobsRoute(loc.pathname);
    if (onRoute !== st.onRoute) {
      st.onRoute = onRoute;
      if (!onRoute) st.open = false;
    }
    render();
  }

  function onPopState() { check(); }

  function boot() {
    if (st.started) return;
    if (!alive()) return;
    st.started = true;
    ensureUi();
    try {
      storageListener = onStorageChanged;
      chrome.storage.onChanged.addListener(storageListener);
    } catch (e) { /* context gone; check() cleans up */ }
    window.addEventListener('popstate', onPopState);
    window.addEventListener('message', onPageMessage);
    // Jobright is an SPA and a content script cannot see the page's own
    // pushState calls, so the URL is polled.
    pollTimer = setInterval(check, POLL_MS);
    check();
    readStorage();
  }

  // Full removal: used when the extension context is gone (reloaded under
  // this page) so a stale copy leaves nothing behind.
  function destroy() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (storageListener) {
      try { chrome.storage.onChanged.removeListener(storageListener); } catch (e) { /* context gone */ }
      storageListener = null;
    }
    try {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('message', onPageMessage);
    } catch (e) { /* window gone */ }
    if (ui && ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
    st.open = false;
    st.started = false;
    if (window.__litJobright === api) {
      try { delete window.__litJobright; } catch (e) { window.__litJobright = undefined; }
    }
  }

  function state() {
    return {
      started: st.started,
      onRoute: st.onRoute,
      open: st.open && st.onRoute,
      launcherShown: !!ui && st.onRoute,
      jobs: listedJobs().map(j => Object.assign({ kind: classifyHost(j.host) }, j)),
      selected: selectedJobs().map(j => j.jobId),
      prefs: Object.assign({}, st.prefs),
      loading: !!st.loading,
      error: st.error,
      position: st.position,
      exhausted: st.exhausted,
      batch: st.batch ? { status: st.batch.status, summary: summarize(st.batch.jobs), total: st.batch.jobs.length } : null,
      startError: st.startError,
      actionError: st.actionError,
      caps: st.caps ? Object.assign({}, st.caps) : null,
      removed: removedJobs().map(j => j.jobId),
      refreshing: st.refreshing,
      check: st.check ? Object.assign({}, st.check) : null
    };
  }

  const api = {
    HOST_ID,
    classifyHost,
    mapJobs,
    listUrl,
    clampCount,
    summarize,
    statusLabel: s => STATUS_LABEL[s] || '',
    isJobsRoute,
    open,
    close,
    check,
    loadMore,
    takePageList,
    refresh,
    dismiss,
    start,
    destroy,
    state
  };

  window.__litJobright = api;
  boot();

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
