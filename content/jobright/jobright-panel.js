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
// This script only reads Jobright's own list and applied-jobs APIs (same
// origin, the user's cookies) and only writes `lit_batch_prefs`. It never clicks anything on the
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

  const HOST_STYLE = 'all: initial !important; position: fixed !important; width: 0 !important; height: 0 !important; ' +
    'left: 0 !important; bottom: 0 !important; z-index: 2147483645 !important; display: block !important;';

  // Tokens mirror popup/popup.css (light) and its pt-dark set (dark).
  const UI_CSS = `
    :host { all: initial; }
    .wrap {
      --font: "Google Sans", "Google Sans Text", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --ease: cubic-bezier(0.16, 1, 0.3, 1);
      --surface: #ffffff;
      --surface-2: #f1f2f4;
      --surface-3: #e7e9ec;
      --border: #e1e3e7;
      --border-soft: #eceef1;
      --text: #1b1d21;
      --text-2: #5f6368;
      --text-3: #6b7075;
      --accent: #1a73e8;
      --accent-text: #1967d2;
      --accent-soft: #e8f0fe;
      --on-accent: #ffffff;
      --success: #1e8e3e;
      --success-soft: #e6f4ea;
      --warn: #b06000;
      --warn-soft: #fef7e0;
      --danger: #d93025;
      --danger-soft: #fce8e6;
      --focus: #1a73e8;
      --shadow-lg: 0 16px 40px rgba(24, 25, 28, 0.16), 0 2px 8px rgba(24, 25, 28, 0.06);
      --knob: #ffffff;
      font-family: var(--font);
      font-size: 13px;
      line-height: 1.4;
      color: var(--text);
      -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .wrap {
        --surface: #17181b;
        --surface-2: #1e2024;
        --surface-3: #26282d;
        --border: rgba(255, 255, 255, 0.1);
        --border-soft: rgba(255, 255, 255, 0.06);
        --text: #ecedee;
        --text-2: #a1a4aa;
        --text-3: #8b8f96;
        --accent: #8ab4f8;
        --accent-text: #8ab4f8;
        --accent-soft: rgba(138, 180, 248, 0.14);
        --on-accent: #0f1012;
        --success: #81c995;
        --success-soft: rgba(129, 201, 149, 0.14);
        --warn: #fdd663;
        --warn-soft: rgba(253, 214, 99, 0.12);
        --danger: #f28b82;
        --danger-soft: rgba(242, 139, 130, 0.12);
        --focus: #8ab4f8;
        --shadow-lg: 0 18px 44px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06);
        --knob: #0f1012;
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
    .x {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px; margin: -4px -6px 0 0; color: var(--text-2);
    }
    .x:hover { background: var(--surface-2); color: var(--text); }
    .x svg { width: 14px; height: 14px; }

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
    .check { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--accent); cursor: pointer; }
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
    .switch:checked { background: var(--accent); }
    .switch:checked::after { transform: translateX(14px); background: var(--knob); }
    .hint { margin: -6px 0 0; font-size: 12px; color: var(--text-3); }
    .caps { margin: 0; font-size: 12px; color: var(--text-2); }
    .caps.quiet { color: var(--text-3); }
    .caps .link { padding: 0; font-size: 12px; white-space: normal; }
    .error { margin: 0; font-size: 12px; color: var(--danger); }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .link { padding: 6px 2px; color: var(--accent-text); }
    .link:hover { text-decoration: underline; }
    .cta { height: 34px; padding: 0 16px; font-size: 13px; font-weight: 600; color: var(--on-accent); background: var(--accent); }
    .cta:not([disabled]):hover { opacity: 0.9; }
    .btn { height: 30px; padding: 0 12px; color: var(--text); background: transparent; border: 1px solid var(--border); }
    .btn:not([disabled]):hover { background: var(--surface-2); }
    .btn-sm { height: 24px; padding: 0 10px; font-size: 11px; }
    .actions .btn { margin-left: auto; }

    @media (max-width: 420px) {
      .panel { left: 8px; width: calc(100vw - 16px); }
      .launcher { left: 8px; }
    }
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; }
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
    appliedList: null,     // promise of Jobright's applied jobIds, once per open
    error: '',
    prefs: Object.assign({}, DEFAULT_PREFS),
    done: {},
    batch: null,
    startError: '',
    actionError: '',
    starting: false,
    caps: null             // { allSites, ai } from LIT_BATCH_CAPS, null until known
  };
  let ui = null;           // { host, shadow, wrap, panel, sub, body, foot, launcher, badge, dot }
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
    return { jobs: SOURCE.map(json), size: SOURCE.size(json) };
  }

  function loadMore() {
    if (st.loading) return st.loading;
    if (!st.pageSize) st.pageSize = defaultPageSize();
    st.error = '';
    const position = st.position;
    const size = st.pageSize;
    const gen = st.gen;
    const current = () => gen === st.gen;
    st.loading = fetchPage(position, size, position === 0).then(({ jobs, size: got }) => {
      if (!current()) return;
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
    if (restart) st.feed = { jobs: [], next: 0, size, exhausted: false };
    const feed = st.feed;
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
        chrome.storage.local.get([BATCH_KEY, DONE_KEY, PREFS_KEY], items => {
          try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
          const all = items || {};
          st.batch = validBatch(all[BATCH_KEY]);
          st.done = all[DONE_KEY] && typeof all[DONE_KEY] === 'object' ? all[DONE_KEY] : {};
          st.prefs = normPrefs(all[PREFS_KEY]);
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

  function validBatch(b) {
    return b && typeof b === 'object' && Array.isArray(b.jobs) ? b : null;
  }

  function dropDone() {
    Object.keys(st.done).forEach(id => st.selected.delete(id));
    st.hidden.forEach(id => st.selected.delete(id));
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !changes) return;
    if (!alive()) { destroy(); return; }
    let dirty = false;
    if (changes[BATCH_KEY]) {
      st.batch = validBatch(changes[BATCH_KEY].newValue);
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
    if (dirty) render();
    if (changes[BATCH_KEY] && changes[BATCH_KEY].oldValue && !st.batch) reloadIfPicking();
  }

  // --- actions ---------------------------------------------------------------
  // What the picker shows: Jobright's current list minus jobs LIT submitted.
  function listedJobs() {
    return st.jobs.filter(j => !st.done[j.jobId] && !st.hidden.has(j.jobId));
  }

  function selectedJobs() {
    return listedJobs().filter(j => st.selected.has(j.jobId));
  }

  // Full autonomy: everything LIT can get into on its own. Sign-in walls stay
  // off until the user picks them.
  function preselectable(job) {
    return classifyHost(job.host) !== 'signin' && !st.done[job.jobId];
  }

  function selectableOpen() {
    return listedJobs().filter(preselectable);
  }

  function toggleAll() {
    const targets = selectableOpen();
    const all = targets.length > 0 && targets.every(j => st.selected.has(j.jobId));
    if (all) st.selected.clear();
    else { st.selected.clear(); targets.forEach(j => st.selected.add(j.jobId)); }
    render();
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
  const focusJob = jobId => action({ type: 'LIT_BATCH_FOCUS', jobId });
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

  // Built node by node: no innerHTML, so a page Trusted Types policy has
  // nothing to object to.
  function closeIcon() {
    if (typeof document.createElementNS !== 'function') return null;
    try {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M4 4l8 8M12 4l-8 8');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
      return svg;
    } catch (e) {
      return null;
    }
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
    panel.addEventListener('keydown', event => {
      if (!event || event.key !== 'Escape') return;
      close();
      try { if (ui) ui.launcher.focus(); } catch (e) { /* no focus */ }
    });

    const head = h('header', 'head');
    const titles = h('div', 'titles');
    titles.appendChild(h('h2', 'title', 'Auto-apply'));
    const sub = h('p', 'sub');
    titles.appendChild(sub);
    const x = button('x', null, close);
    x.setAttribute('aria-label', 'Close');
    x.setAttribute('title', 'Close');
    const icon = closeIcon();
    if (icon) x.appendChild(icon);
    else x.textContent = 'Close';
    head.appendChild(titles);
    head.appendChild(x);

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
    ui = { host, shadow, wrap, panel, sub, body, foot, launcher, badge, dot };
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

  function renderPicker() {
    const listed = listedJobs();
    const n = listed.length;
    const picked = selectedJobs().length;
    ui.sub.textContent = n ? picked + ' of ' + n + ' selected' : 'Jobs from your Jobright list';

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
    count.appendChild(h('span', 'ctl-label', 'Parallel'));
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

    if (st.startError) ui.foot.appendChild(h('p', 'error start-error', st.startError));

    const actions = h('div', 'actions');
    const targets = selectableOpen();
    const allOn = targets.length > 0 && targets.every(j => st.selected.has(j.jobId));
    const sel = button('link select-all', allOn ? 'Clear selection' : 'Select all', toggleAll);
    sel.disabled = !targets.length && !picked;
    keyed(sel, 'select');
    actions.appendChild(sel);
    const verb = st.prefs.mode === 'submit' ? 'Apply to ' : 'Fill ';
    const cta = button('cta start', st.starting ? 'Starting...' : verb + picked, () => { start(); });
    cta.disabled = !picked || st.starting;
    keyed(cta, 'start');
    actions.appendChild(cta);
    ui.foot.appendChild(actions);
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
    row.appendChild(h('span', 'tag tag-' + kind, KIND_LABEL[kind]));
    return row;
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
    const fill = h('div', 'bar-fill');
    fill.style.width = (p.total ? Math.round((p.finished / p.total) * 100) : 0) + '%';
    bar.appendChild(fill);
    summary.appendChild(bar);
    ui.body.appendChild(summary);

    const list = h('div', 'list');
    b.jobs.forEach(job => list.appendChild(batchRow(job)));
    ui.body.appendChild(list);

    if (st.actionError) ui.foot.appendChild(h('p', 'error action-error', st.actionError));
    const actions = h('div', 'actions');
    if (running) actions.appendChild(keyed(button('btn stop', 'Stop', () => { stopBatch(); }), 'stop'));
    else actions.appendChild(keyed(button('btn clear', 'Clear', () => { clearBatch(); }), 'clear'));
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
    const reason = clean(job.reason, ERROR_MAX);
    if (reason) main.appendChild(h('div', 'reason', reason));
    row.appendChild(main);
    const side = h('div', 'side');
    side.appendChild(h('span', 'pill pill-' + job.status, STATUS_LABEL[job.status] || clean(job.status)));
    if (OPENABLE.has(job.status)) {
      const openBtn = button('btn btn-sm open-job', 'Open', () => { focusJob(job.jobId); });
      openBtn.setAttribute('aria-label', 'Open ' + titleText);
      keyed(openBtn, 'open-' + job.jobId);
      side.appendChild(openBtn);
    }
    row.appendChild(side);
    return row;
  }

  // --- open / close / route --------------------------------------------------
  function open() {
    if (!ui || !st.onRoute) return Promise.resolve();
    if (st.open) return st.loading || Promise.resolve();
    st.open = true;
    render();
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
      caps: st.caps ? Object.assign({}, st.caps) : null
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
    start,
    destroy,
    state
  };

  window.__litJobright = api;
  boot();

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
