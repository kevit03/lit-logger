// Auto-apply orchestrator: runs a batch of Jobright jobs, a few tabs at a
// time, in one unfocused window.
//
// The service worker can be torn down between any two events, so nothing
// here lives in memory except the promise chain. Every event re-reads
// chrome.storage.local['lit_batch'], applies timeouts, handles itself,
// launches into free slots, and writes the record back. The chain serializes
// those read-modify-write steps so two messages arriving together cannot
// overwrite each other.
//
// Only this file writes lit_batch and lit_batch_done. The Jobright panel
// reads them; the driver in each job tab (content/autofill/auto-apply.js)
// reports progress with LIT_BATCH_UPDATE. It also answers LIT_BATCH_CAPS
// (what the panel and driver may count on: all-sites access, Claude answers,
// a filled-in profile) and LIT_OPEN_OPTIONS (the panel's link to the Autofill
// profile page).
//
// A job that ended as needs-you, ready or failed stays the user's to finish.
// Its page can lose what LIT typed at any time: the tab is reloaded, Chrome
// discards it to save memory, the extension is updated, or the form only
// shows up once someone is looking. So LIT_BATCH_FOCUS (the panel's Open
// button) shows that one tab beside the Jobright page, leaving the batch window
// behind, and also makes sure the form gets filled, reopening the tab if it is
// gone, and a page that says hello for such a job is told to `assist`: fill
// the form (LIT_BATCH_ASSISTED reports back). With Submit automatically on,
// Open also sends a form that has nothing missing, at most once per job (see
// maySubmit); a later reload never does.
const LitBatch = (() => {
  const KEY = 'lit_batch';
  const DONE_KEY = 'lit_batch_done';
  const ALARM = 'lit-batch-tick';
  const ALARM_PERIOD_MINUTES = 0.5;

  // Opening covers up to 3 apply-button hops; the hard limit covers the
  // answer-writing requests (40 s each, 3 at a time).
  const OPEN_TIMEOUT_MS = 90 * 1000;
  const HARD_TIMEOUT_MS = 6 * 60 * 1000;
  const INJECT_AFTER_MS = 20 * 1000;
  const NO_ACCESS_WAIT_MS = 30 * 1000;
  const CLOSE_DELAY_MS = 1500;
  const DONE_CAP = 2000;
  const MAX_CONCURRENCY = 10;
  const DEFAULT_CONCURRENCY = 5;
  const MAX_MISSING = 10;
  const MAX_LABEL = 80;
  const MAX_REASON = 160;
  const MAX_TEXT = 200;
  const SETTINGS_KEY = 'af_settings';
  const PROFILE_KEY = 'af_profile';
  const ALL_SITES = ['*://*/*'];

  const ACTIVE = ['opening', 'filling', 'submitting'];
  // Ended, but with a form the user still has to finish.
  const UNFINISHED = ['needs-you', 'ready', 'failed'];
  // How long after Open a job's tab may wander to a new site (an apply link,
  // a sign-in) and still count as that job's.
  const ASSIST_MS = 2 * 60 * 1000;
  // After a page finishes loading, give the manifest's own scripts time to
  // run before adding them.
  const INJECT_SETTLE_MS = 1500;
  const RECENT_HELLO_MS = 15 * 1000;
  const MAX_HOSTS = 8;
  const NO_ACCESS = 'No access to this site';
  const TERMINAL = ['submitted', 'ready', 'needs-you', 'failed', 'skipped'];
  // The only moves a driver may make. Anything else is a stale or confused
  // driver and is refused, so it stops.
  const TRANSITIONS = {
    opening: ['filling'],
    filling: ['submitting', 'submitted', 'ready', 'needs-you', 'failed'],
    submitting: ['submitted', 'ready', 'needs-you', 'failed']
  };
  const DEFAULT_REASON = {
    submitted: 'Submitted',
    ready: 'Filled. Review and submit.',
    'needs-you': 'Needs you',
    failed: 'Something went wrong'
  };

  let hooks = {};
  let chain = Promise.resolve();

  const isActive = job => ACTIVE.includes(job.status);
  const isTerminal = job => TERMINAL.includes(job.status);
  const clock = () => (typeof hooks.now === 'function' ? hooks.now() : Date.now());

  function later(fn, ms) {
    const timer = typeof hooks.setTimeout === 'function' ? hooks.setTimeout : setTimeout;
    try { timer(fn, ms); } catch (e) { /* the alarm still sweeps */ }
  }

  function text(value, max) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function getKey(key) {
    return new Promise(resolve => {
      chrome.storage.local.get([key], result => {
        if (chrome.runtime.lastError) { resolve(undefined); return; }
        resolve(result ? result[key] : undefined);
      });
    });
  }

  function setKey(key, value) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [key]: value }, () => resolve(!chrome.runtime.lastError));
    });
  }

  function removeKey(key) {
    return new Promise(resolve => {
      chrome.storage.local.remove(key, () => resolve(!chrome.runtime.lastError));
    });
  }

  async function readBatch() {
    const raw = await getKey(KEY);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.jobs)) return null;
    return raw;
  }

  async function recordDone(jobIds, now) {
    if (!jobIds.length) return;
    const raw = await getKey(DONE_KEY);
    const done = raw && typeof raw === 'object' ? raw : {};
    jobIds.forEach(id => { done[id] = now; });
    const ids = Object.keys(done);
    if (ids.length > DONE_CAP) {
      ids.sort((a, b) => (done[b] || 0) - (done[a] || 0));
      ids.slice(DONE_CAP).forEach(id => { delete done[id]; });
    }
    await setKey(DONE_KEY, done);
  }

  // One serialized read-modify-write. `fn(ctx)` may change ctx.state (and set
  // ctx.dirty), replace it, or set ctx.remove; its return value is the result.
  function step(fn, nowOverride) {
    const run = async () => {
      const now = Number.isFinite(nowOverride) ? nowOverride : clock();
      const ctx = { now, state: await readBatch(), dirty: false, remove: false, submitted: [], closes: [], injects: [], timers: [], closeWindow: null };
      if (ctx.state) sweep(ctx);
      const result = fn ? await fn(ctx) : undefined;
      if (ctx.state && !ctx.remove) await pump(ctx);
      if (ctx.state && !ctx.remove) releaseWindow(ctx);
      if (ctx.remove) {
        await removeKey(KEY);
      } else if (ctx.state && ctx.dirty) {
        ctx.state.updatedAt = now;
        await setKey(KEY, ctx.state);
      }
      await recordDone(ctx.submitted, now);
      await syncAlarm(ctx.remove ? null : ctx.state);
      afterEffects(ctx);
      return result;
    };
    const p = chain.then(run);
    chain = p.catch(err => { console.warn('LIT: auto-apply step failed:', err && err.message); });
    return p;
  }

  function afterEffects(ctx) {
    ctx.closes.forEach(tabId => {
      try {
        const r = chrome.tabs.remove(tabId);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (e) { /* already closed */ }
    });
    // Usually gone already (Chrome closes a window with its last tab).
    if (typeof ctx.closeWindow === 'number' && chrome.windows && typeof chrome.windows.remove === 'function') {
      try {
        const r = chrome.windows.remove(ctx.closeWindow);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (e) { /* already closed */ }
    }
    ctx.injects.forEach(tabId => { inject(tabId); });
    // Best-effort wake-ups for deadlines shorter than the alarm period. If the
    // worker dies first, the alarm or the next event catches up.
    Array.from(new Set(ctx.timers)).forEach(ms => later(() => { tick(); }, ms));
  }

  // Adds the autofill scripts to a tab that has none. Resolves false when
  // Chrome refuses: LIT has no access to that site, which is recorded on the
  // job so the panel can say so.
  async function inject(tabId) {
    if (typeof hooks.injectAutofill !== 'function') return true;
    try {
      await hooks.injectAutofill(tabId);
      return true;
    } catch (e) {
      await step(ctx => {
        const job = ctx.state && ctx.state.jobs.find(j => j.tabId === tabId);
        // The manifest's own script answered from this page: not a refusal.
        if (!job || job.noAccess || ctx.now - (job.lastHelloAt || 0) < RECENT_HELLO_MS) return;
        job.noAccess = true;
        if (UNFINISHED.includes(job.status) && !job.filled) job.reason = NO_ACCESS;
        ctx.dirty = true;
      });
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Rules applied on every event
  // ---------------------------------------------------------------------------
  function finish(ctx, job, status, reason) {
    job.status = status;
    job.reason = text(reason || DEFAULT_REASON[status] || '', MAX_REASON);
    job.updatedAt = ctx.now;
    ctx.dirty = true;
    if (status === 'submitted') {
      job.missing = [];
      ctx.submitted.push(job.jobId);
      ctx.timers.push(CLOSE_DELAY_MS + 50);
    }
  }

  function sweep(ctx) {
    const { now, state } = ctx;
    state.jobs.forEach(job => {
      if (isActive(job)) {
        const age = now - (Number.isFinite(job.startedAt) ? job.startedAt : now);
        if (job.status === 'opening' && job.noAccess && age >= NO_ACCESS_WAIT_MS) {
          // Long enough for a redirect to a site LIT does cover.
          finish(ctx, job, 'needs-you', NO_ACCESS);
        } else if (job.status === 'opening' && age >= OPEN_TIMEOUT_MS) {
          finish(ctx, job, 'needs-you', job.noAccess ? NO_ACCESS : 'No application form found');
        } else if (age >= HARD_TIMEOUT_MS) {
          finish(ctx, job, 'needs-you', 'Timed out');
        } else if (job.status === 'opening' && age >= INJECT_AFTER_MS && !job.helloAt && !job.injectedAt && typeof job.tabId === 'number') {
          // No driver has said hello: the page may be outside the manifest's
          // matches. Try once; the opening timeout covers a refusal.
          job.injectedAt = now;
          ctx.injects.push(job.tabId);
          ctx.dirty = true;
        }
      } else if (job.status === 'submitted' && typeof job.tabId === 'number' && now - (job.updatedAt || 0) >= CLOSE_DELAY_MS) {
        // A tab the user opened stays, so they see the confirmation.
        if (!job.assistAt) ctx.closes.push(job.tabId);
        job.tabId = null;
        ctx.dirty = true;
      }
    });
  }

  // A batch that is over (stopped or done) and holds no tab the user still
  // needs gives its window back. Chrome closes a window with its last tab,
  // but a tab a job site opened by itself would otherwise keep a stray
  // window around after the batch.
  function releaseWindow(ctx) {
    const state = ctx.state;
    if (state.status === 'running' || typeof state.windowId !== 'number') return;
    if (state.jobs.some(j => isActive(j) || typeof j.tabId === 'number')) return;
    ctx.closeWindow = state.windowId;
    state.windowId = null;
    ctx.dirty = true;
  }

  // Chrome discards background tabs to save memory, and a discarded form
  // comes back empty. Best effort; Open refills the form either way.
  function keepInMemory(tabId) {
    try {
      const r = chrome.tabs.update(tabId, { autoDiscardable: false });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    } catch (e) { /* not supported here */ }
  }

  async function openTab(state, url) {
    if (typeof state.windowId === 'number') {
      try {
        const tab = await chrome.tabs.create({ windowId: state.windowId, url, active: false });
        if (tab && typeof tab.id === 'number') return tab.id;
      } catch (e) {
        // The user closed the batch window; open a new one below.
      }
    }
    const win = await chrome.windows.create({ url, focused: false });
    state.windowId = win && typeof win.id === 'number' ? win.id : null;
    const first = win && Array.isArray(win.tabs) ? win.tabs[0] : null;
    if (first && typeof first.id === 'number') return first.id;
    const tabs = await chrome.tabs.query({ windowId: state.windowId });
    if (tabs && tabs[0] && typeof tabs[0].id === 'number') return tabs[0].id;
    throw new Error('no tab');
  }

  async function launch(ctx, job) {
    Object.assign(job, { status: 'opening', startedAt: ctx.now, updatedAt: ctx.now, reason: '', tabId: null, frameId: null, helloAt: null, injectedAt: null, noAccess: false });
    ctx.dirty = true;
    try {
      job.tabId = await openTab(ctx.state, job.url);
      keepInMemory(job.tabId);
      ctx.timers.push(INJECT_AFTER_MS + 50, NO_ACCESS_WAIT_MS + 50, OPEN_TIMEOUT_MS + 50);
    } catch (e) {
      finish(ctx, job, 'failed', 'Could not open a tab');
    }
  }

  // Fills free slots, then closes out the batch when nothing is left.
  async function pump(ctx) {
    const state = ctx.state;
    if (state.status === 'running') {
      const cap = Math.min(MAX_CONCURRENCY, Math.max(1, parseInt(state.concurrency, 10) || DEFAULT_CONCURRENCY));
      let next;
      while (state.jobs.filter(isActive).length < cap && (next = state.jobs.find(j => j.status === 'queued'))) {
        await launch(ctx, next);
      }
      if (!state.jobs.some(j => j.status === 'queued' || isActive(j))) {
        state.status = 'done';
        ctx.dirty = true;
      }
    }
  }

  // The tick alarm exists only while something can still change on its own:
  // a job in flight, or a running batch with jobs queued.
  async function syncAlarm(state) {
    if (!chrome.alarms) return;
    const needed = !!state && state.jobs.some(j => isActive(j) || (state.status === 'running' && j.status === 'queued'));
    try {
      if (needed) {
        const existing = await chrome.alarms.get(ALARM);
        if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_PERIOD_MINUTES });
      } else {
        await chrome.alarms.clear(ALARM);
      }
    } catch (e) {
      // Events still sweep without the alarm.
    }
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
  }

  function start(msg) {
    return step(ctx => {
      if (ctx.state && ctx.state.status === 'running') return { ok: false, error: 'A batch is already running' };
      const seen = new Set();
      const jobs = [];
      (Array.isArray(msg.jobs) ? msg.jobs : []).forEach(raw => {
        if (!raw || typeof raw !== 'object') return;
        const url = String(raw.url || '').trim();
        if (!/^https?:\/\//i.test(url) || !hostOf(url)) return;
        const jobId = text(raw.jobId || url, MAX_TEXT);
        if (!jobId || seen.has(jobId)) return;
        seen.add(jobId);
        jobs.push({
          jobId,
          title: text(raw.title, MAX_TEXT),
          company: text(raw.company, MAX_TEXT),
          url,
          host: hostOf(url),
          status: 'queued',
          tabId: null,
          frameId: null,
          startedAt: null,
          updatedAt: ctx.now,
          reason: '',
          filled: 0,
          composed: 0,
          missing: [],
          helloAt: null,
          injectedAt: null
        });
      });
      if (!jobs.length) return { ok: false, error: 'No jobs with an application link' };
      const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, parseInt(msg.concurrency, 10) || DEFAULT_CONCURRENCY));
      ctx.state = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
        status: 'running',
        mode: msg.mode === 'fill-only' ? 'fill-only' : 'submit',
        concurrency,
        windowId: null,
        startedAt: ctx.now,
        updatedAt: ctx.now,
        jobs
      };
      ctx.dirty = true;
      return { ok: true };
    });
  }

  // Stop: nothing new opens and nothing more is submitted.
  // - queued: skipped.
  // - opening (no form found yet, nothing typed): skipped, and its tab closed.
  // - filling: left open for the user as needs-you; when its driver asks to
  //   submit, the transition table refuses and it stands down.
  // - submitting: Submit was already pressed, so its result still counts.
  // Once nothing holds a tab, the batch window closes (releaseWindow).
  function stop() {
    return step(ctx => {
      if (!ctx.state) return { ok: false, error: 'No batch' };
      ctx.state.jobs.forEach(job => {
        if (job.status === 'queued') {
          finish(ctx, job, 'skipped', 'Stopped');
        } else if (job.status === 'opening') {
          finish(ctx, job, 'skipped', 'Stopped');
          if (typeof job.tabId === 'number') ctx.closes.push(job.tabId);
          job.tabId = null;
        } else if (job.status === 'filling') {
          finish(ctx, job, 'needs-you', 'Stopped before submitting');
        }
      });
      if (ctx.state.status === 'running') ctx.state.status = 'stopped';
      ctx.dirty = true;
      return { ok: true };
    });
  }

  // The panel's X on a queued job: it never opens. A job already under way
  // is left alone (Stop is for that).
  function removeJob(msg) {
    return step(ctx => {
      if (!ctx.state) return { ok: false, error: 'No batch' };
      const job = ctx.state.jobs.find(j => j.jobId === String(msg.jobId || ''));
      if (!job) return { ok: false, error: 'That job is not in this batch' };
      if (job.status !== 'queued') return { ok: false, error: 'That job has already started' };
      finish(ctx, job, 'skipped', 'Removed');
      return { ok: true };
    });
  }

  function clear() {
    return step(ctx => {
      if (!ctx.state) return { ok: true };
      if (ctx.state.status === 'running') return { ok: false, error: 'Stop the batch first' };
      ctx.remove = true;
      return { ok: true };
    });
  }

  // Takes one job's tab out of the batch window, so Open shows that page and
  // not every company's. It lands beside the tab Open was clicked in, else in
  // a window of its own. Moving a tab keeps its page and anything typed in it.
  async function bringOut(state, tabId, home) {
    const tab = await chrome.tabs.get(tabId);
    // Already out of the batch window, or the panel itself is in there.
    if (tab.windowId !== state.windowId || (home && home.windowId === tab.windowId)) return;
    if (home) {
      // -1 (the end) covers spots Chrome refuses.
      for (const index of [home.index, -1]) {
        try { await chrome.tabs.move(tabId, { windowId: home.windowId, index }); return; } catch (e) { /* next */ }
      }
    }
    try { await chrome.windows.create({ tabId, focused: true }); } catch (e) { /* shown where it is */ }
  }

  // The last focused window (the default) could be the batch window.
  async function createBeside(url, home) {
    if (home) {
      const spot = { url, active: true, windowId: home.windowId };
      if (home.index >= 0) spot.index = home.index;
      try { return await chrome.tabs.create(spot); } catch (e) { /* that window is gone */ }
    }
    return chrome.tabs.create({ url, active: true });
  }

  // Where Open was clicked: the window, and the spot right after that tab.
  function homeOf(sender) {
    const tab = sender && sender.tab;
    if (!tab || typeof tab.windowId !== 'number') return null;
    return { windowId: tab.windowId, index: typeof tab.index === 'number' && tab.index >= 0 ? tab.index + 1 : -1 };
  }

  // Shows one job's tab and makes sure its form is filled. A tab that is gone
  // is opened again.
  async function focus(msg, sender) {
    const home = homeOf(sender);
    const opened = await step(async ctx => {
      const job = ctx.state && ctx.state.jobs.find(j => j.jobId === msg.jobId);
      if (!job) return { ok: false, error: 'That job is not in this batch' };
      const unfinished = UNFINISHED.includes(job.status);
      const first = !job.assistAt;
      if (typeof job.tabId === 'number') {
        try {
          await bringOut(ctx.state, job.tabId, home);
          const tab = await chrome.tabs.update(job.tabId, { active: true });
          const windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : ctx.state.windowId;
          if (typeof windowId === 'number') await chrome.windows.update(windowId, { focused: true });
          if (unfinished) { job.assistAt = ctx.now; ctx.dirty = true; }
          return { ok: true, tabId: job.tabId, assist: unfinished, submit: maySubmit(ctx, job), first, hadDriver: !!job.helloAt };
        } catch (e) {
          job.tabId = null;
          ctx.dirty = true;
        }
      }
      if (!unfinished) return { ok: false, error: 'That tab is closed' };
      try {
        const tab = await createBeside(job.url, home);
        job.tabId = tab.id;
        job.assistAt = ctx.now;
        job.noAccess = false;
        ctx.dirty = true;
        keepInMemory(job.tabId);
        if (typeof tab.windowId === 'number') chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        // Its driver says hello when the page loads; see onTabUpdated for
        // sites the manifest does not cover.
        return { ok: true };
      } catch (e) {
        return { ok: false, error: 'Could not open a tab' };
      }
    });
    if (!opened.ok || !opened.assist) return opened.ok ? { ok: true } : { ok: false, error: opened.error };

    if (await askToAssist(opened.tabId, msg.jobId, opened.submit)) return { ok: true };
    // Nobody home. Add the scripts where LIT may; where only the manifest
    // puts them (a job board after the extension was updated), load the page
    // again, but only on the first Open so nothing typed since is lost.
    if (await inject(opened.tabId)) return { ok: true };
    if (opened.hadDriver && opened.first && typeof chrome.tabs.reload === 'function') {
      try { await chrome.tabs.reload(opened.tabId); return { ok: true }; } catch (e) { /* gone */ }
    }
    return { ok: true, noAccess: true };
  }

  // Open may send this job's form: the batch was started to submit and not
  // stopped, the user opened the job just now, and Submit was never pressed.
  function maySubmit(ctx, job) {
    return ctx.state.mode === 'submit' && ctx.state.status !== 'stopped' && UNFINISHED.includes(job.status) &&
      !job.submitAt && !!job.assistAt && ctx.now - job.assistAt < ASSIST_MS;
  }

  // True when a driver in that tab answered.
  async function askToAssist(tabId, jobId, submit) {
    if (typeof chrome.tabs.sendMessage !== 'function') return false;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'LIT_BATCH_ASSIST', jobId, submit: !!submit });
      return !!(res && res.ok);
    } catch (e) {
      return false;
    }
  }

  function jobForTab(state, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!state || typeof tabId !== 'number') return null;
    return state.jobs.find(j => j.tabId === tabId && !isTerminal(j) && j.status !== 'queued') || null;
  }

  function senderHost(sender) {
    return hostOf((sender && sender.url) || (sender && sender.tab && sender.tab.url) || '');
  }

  // Sites this job's tab has been on, so a tab the user later takes somewhere
  // else is left alone.
  function rememberHost(ctx, job, host) {
    const hosts = Array.isArray(job.hosts) ? job.hosts : [];
    if (!host || hosts.includes(host) || hosts.length >= MAX_HOSTS) return;
    job.hosts = hosts.concat(host);
    ctx.dirty = true;
  }

  function markHello(ctx, job) {
    if (!job.helloAt) job.helloAt = ctx.now;
    job.lastHelloAt = ctx.now;
    job.noAccess = false;
    ctx.dirty = true;
  }

  // The unfinished job a page belongs to, when LIT should fill it for the user.
  function assistFor(ctx, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!ctx.state || typeof tabId !== 'number') return null;
    const job = ctx.state.jobs.find(j => j.tabId === tabId && UNFINISHED.includes(j.status));
    // Submit was pressed: the form is no longer ours to fill.
    if (!job || job.submitAt) return null;
    const host = senderHost(sender);
    const recent = !!job.assistAt && ctx.now - job.assistAt < ASSIST_MS;
    if (!recent && (!host || (host !== job.host && !(job.hosts || []).includes(host)))) return null;
    rememberHost(ctx, job, host);
    markHello(ctx, job);
    return { job: { jobId: job.jobId, title: job.title, company: job.company, url: job.url, status: job.status }, mode: 'assist', hops: recent, submit: maySubmit(ctx, job) };
  }

  // What the driver found after filling an unfinished job's form.
  function assisted(msg, sender) {
    return step(ctx => {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      const job = ctx.state && typeof tabId === 'number' && ctx.state.jobs.find(j => j.tabId === tabId && UNFINISHED.includes(j.status));
      if (!job || job.submitAt) return { ok: false };
      if (Number.isFinite(msg.filled)) job.filled = Math.max(0, Math.floor(msg.filled));
      if (Number.isFinite(msg.composed)) job.composed = Math.max(0, Math.floor(msg.composed));
      if (Array.isArray(msg.missing)) job.missing = msg.missing.map(m => text(m, MAX_LABEL)).filter(Boolean).slice(0, MAX_MISSING);
      finish(ctx, job, msg.ready === true ? 'ready' : 'needs-you', msg.reason);
      return { ok: true };
    });
  }

  function hello(sender) {
    return step(ctx => {
      const job = jobForTab(ctx.state, sender);
      if (!job) return assistFor(ctx, sender) || { job: null };
      markHello(ctx, job);
      rememberHost(ctx, job, senderHost(sender));
      return {
        job: { jobId: job.jobId, title: job.title, company: job.company, url: job.url, status: job.status },
        mode: ctx.state.mode
      };
    });
  }

  // The job whose Open may submit from this tab, or null.
  function openedJob(ctx, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    const job = ctx.state && typeof tabId === 'number' && ctx.state.jobs.find(j => j.tabId === tabId);
    return job && maySubmit(ctx, job) ? job : null;
  }

  function update(msg, sender) {
    return step(ctx => {
      const next = msg.status;
      const opened = next === 'submitting' ? openedJob(ctx, sender) : null;
      const job = opened || jobForTab(ctx.state, sender);
      if (!job) return { ok: false };
      if (!opened && !(TRANSITIONS[job.status] || []).includes(next)) return { ok: false };
      const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
      // The first frame to start filling owns the job; any other frame of the
      // same tab (a second form, an ad iframe) is told to stand down.
      if (next === 'filling' || opened) job.frameId = frameId;
      else if (job.frameId !== frameId) return { ok: false };

      if (Number.isFinite(msg.filled)) job.filled = Math.max(0, Math.floor(msg.filled));
      // How many of those the answer writer composed (v2 drivers only).
      if (Number.isFinite(msg.composed)) job.composed = Math.max(0, Math.floor(msg.composed));
      if (Array.isArray(msg.missing)) {
        job.missing = msg.missing.map(m => text(m, MAX_LABEL)).filter(Boolean).slice(0, MAX_MISSING);
      }
      if (TERMINAL.includes(next)) {
        finish(ctx, job, next, msg.reason);
      } else {
        job.status = next;
        if (next === 'submitting') job.submitAt = ctx.now;
        // The time limits count from here, not from when the batch began.
        if (opened) job.startedAt = ctx.now;
        job.reason = text(msg.reason, MAX_REASON);
        job.updatedAt = ctx.now;
        ctx.dirty = true;
      }
      return { ok: true };
    });
  }

  // A job still in flight is skipped. A finished one only forgets its tab,
  // so the panel stops offering to open it.
  function onTabRemoved(tabId) {
    return step(ctx => {
      if (!ctx.state) return;
      ctx.state.jobs.forEach(job => {
        if (job.tabId !== tabId) return;
        if (isActive(job)) finish(ctx, job, 'skipped', 'Tab closed');
        job.tabId = null;
        ctx.dirty = true;
      });
    });
  }

  // Discarding a tab can give it a new id.
  function onTabReplaced(addedId, removedId) {
    return step(ctx => {
      if (!ctx.state) return;
      ctx.state.jobs.forEach(job => {
        if (job.tabId !== removedId) return;
        job.tabId = addedId;
        ctx.dirty = true;
      });
    });
  }

  // A page outside the manifest's matches has no scripts of ours, and each
  // page load (an apply link, a reload) starts without them again.
  function onTabUpdated(tabId, info) {
    if (!info || info.status !== 'complete') return Promise.resolve();
    return step(ctx => {
      const job = ctx.state && ctx.state.jobs.find(j => j.tabId === tabId);
      if (!job) return;
      const opening = job.status === 'opening' && (!job.helloAt || job.injectedAt);
      const assisting = UNFINISHED.includes(job.status) && !job.submitAt && !!job.assistAt && ctx.now - job.assistAt < ASSIST_MS;
      if (!opening && !assisting) return;
      if (opening && !job.injectedAt) { job.injectedAt = ctx.now; ctx.dirty = true; }
      later(() => { inject(tabId); }, INJECT_SETTLE_MS);
    });
  }

  // Tab and window ids mean nothing after a browser restart.
  function onBrowserStart() {
    return step(ctx => {
      if (!ctx.state) return;
      ctx.state.windowId = null;
      ctx.state.jobs.forEach(job => {
        if (isActive(job)) finish(ctx, job, 'needs-you', 'Chrome was restarted');
        job.tabId = null;
      });
      ctx.dirty = true;
    });
  }

  function tick(now) {
    return step(null, now);
  }

  // chrome.permissions.contains answers through a callback or a promise
  // depending on the Chrome version; take whichever comes.
  function hasAllSites() {
    return new Promise(resolve => {
      try {
        if (!chrome.permissions || typeof chrome.permissions.contains !== 'function') { resolve(false); return; }
        const r = chrome.permissions.contains({ origins: ALL_SITES }, granted => {
          try { void chrome.runtime.lastError; } catch (e) { /* ignore */ }
          resolve(!!granted);
        });
        if (r && typeof r.then === 'function') r.then(v => resolve(!!v), () => resolve(false));
      } catch (e) {
        resolve(false);
      }
    });
  }

  // Never returns the key or the profile itself, only whether answers can be
  // written and whether there is anything to fill forms with.
  async function caps() {
    const [allSites, settings, stored] = await Promise.all([hasAllSites(), getKey(SETTINGS_KEY), getKey(PROFILE_KEY)]);
    const s = settings && typeof settings === 'object' ? settings : {};
    const p = stored && typeof stored === 'object' ? stored : {};
    const profile = ['firstName', 'lastName', 'email', 'phone'].some(k => typeof p[k] === 'string' && !!p[k].trim());
    return { allSites, ai: !!(s.aiEnabled && typeof s.aiKey === 'string' && s.aiKey.trim()), profile };
  }

  // --- jobs already applied to (LIT_BATCH_APPLIED) ---------------------------
  // The Jobright panel asks which of its listed jobs the tracker already has
  // as applications, so it can leave them out. A job matches a logged one by
  // the same link, or by the same company and the same role title.
  const APPLIED_LOOKBACK_DAYS = 180;
  const MAX_LOOKUP = 200;

  function companyKey(name) {
    const fn = hooks.normalizeCompany ||
      (typeof TrackerStorage !== 'undefined' && TrackerStorage.normalizeCompany) || null;
    if (fn) return fn(name);
    return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function titleKey(title) {
    return String(title || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // host + path, so tracking parameters and trailing slashes do not matter.
  function linkKey(url) {
    try {
      const u = new URL(String(url || ''));
      if (!/^https?:$/.test(u.protocol)) return '';
      return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function matchApplied(jobs, logs) {
    const pairs = new Set();
    const links = new Set();
    (logs || []).forEach(l => {
      if (!l || typeof l !== 'object') return;
      const c = companyKey(l.company);
      const t = titleKey(l.role);
      if (c && t) pairs.add(c + '|' + t);
      const k = linkKey(l.url);
      if (k) links.add(k);
    });
    return (jobs || []).filter(j => {
      if (!j || typeof j !== 'object') return false;
      const c = companyKey(j.company);
      const t = titleKey(j.title);
      if (c && t && pairs.has(c + '|' + t)) return true;
      const k = linkKey(j.url);
      return !!k && links.has(k);
    }).map(j => String(j.jobId));
  }

  async function jobLogs() {
    if (typeof hooks.getJobLogs === 'function') return hooks.getJobLogs();
    if (typeof TrackerStorage === 'undefined') return [];
    const since = new Date(clock() - APPLIED_LOOKBACK_DAYS * 86400000);
    const pad = n => String(n).padStart(2, '0');
    const startDate = since.getFullYear() + '-' + pad(since.getMonth() + 1) + '-' + pad(since.getDate());
    return TrackerStorage.getLogs({ metricId: 'jobs', startDate });
  }

  async function applied(msg) {
    const jobs = Array.isArray(msg.jobs) ? msg.jobs.slice(0, MAX_LOOKUP) : [];
    if (!jobs.length) return { ok: true, jobIds: [] };
    const logs = await jobLogs();
    return { ok: true, jobIds: matchApplied(jobs, Array.isArray(logs) ? logs : []) };
  }

  async function openOptions(msg) {
    try {
      if (msg && msg.section === 'settings') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('options/autofill.html#settings') });
        return { ok: true };
      }
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'Could not open LIT settings' };
    }
  }

  function respond(promise, sendResponse, fallback) {
    promise.then(
      res => { try { sendResponse(res); } catch (e) { /* the asker went away */ } },
      () => { try { sendResponse(fallback); } catch (e) { /* the asker went away */ } }
    );
    return true;
  }

  function handleMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;
    const failed = { ok: false, error: 'Something went wrong' };
    if (msg.type === 'LIT_OPEN_OPTIONS') return respond(openOptions(msg), sendResponse, failed);
    if (msg.type.indexOf('LIT_BATCH_') !== 0) return false;
    switch (msg.type) {
      case 'LIT_BATCH_CAPS': return respond(caps(), sendResponse, { allSites: false, ai: false, profile: true });
      case 'LIT_BATCH_APPLIED': return respond(applied(msg), sendResponse, { ok: false, jobIds: [] });
      case 'LIT_BATCH_START': return respond(start(msg), sendResponse, failed);
      case 'LIT_BATCH_STOP': return respond(stop(), sendResponse, failed);
      case 'LIT_BATCH_CLEAR': return respond(clear(), sendResponse, failed);
      case 'LIT_BATCH_REMOVE': return respond(removeJob(msg), sendResponse, failed);
      case 'LIT_BATCH_FOCUS': return respond(focus(msg, sender), sendResponse, failed);
      case 'LIT_BATCH_HELLO': return respond(hello(sender), sendResponse, { job: null });
      case 'LIT_BATCH_UPDATE': return respond(update(msg, sender), sendResponse, { ok: false });
      case 'LIT_BATCH_ASSISTED': return respond(assisted(msg, sender), sendResponse, { ok: false });
      default: return false;
    }
  }

  // Called once per worker start. The reconcile step re-arms the alarm for a
  // batch that was running when the previous worker died, and resumes it.
  function install(h) {
    hooks = Object.assign({}, h || {});
    if (chrome.tabs && chrome.tabs.onRemoved) {
      chrome.tabs.onRemoved.addListener(tabId => { onTabRemoved(tabId); });
    }
    if (chrome.tabs && chrome.tabs.onReplaced) {
      chrome.tabs.onReplaced.addListener((added, removed) => { onTabReplaced(added, removed); });
    }
    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, info) => { onTabUpdated(tabId, info); });
    }
    if (chrome.runtime && chrome.runtime.onStartup) {
      chrome.runtime.onStartup.addListener(() => { onBrowserStart(); });
    }
    if (chrome.alarms && chrome.alarms.onAlarm) {
      chrome.alarms.onAlarm.addListener(alarm => { if (alarm && alarm.name === ALARM) tick(); });
    }
    return tick();
  }

  return {
    install,
    handleMessage,
    // Test seams.
    _tick: tick,
    _whenIdle: () => chain,
    matchApplied,
    KEY,
    DONE_KEY,
    ALARM,
    OPEN_TIMEOUT_MS,
    HARD_TIMEOUT_MS,
    INJECT_AFTER_MS,
    CLOSE_DELAY_MS,
    ASSIST_MS,
    NO_ACCESS,
    DONE_CAP
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LitBatch;
