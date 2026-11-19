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
// reports progress with LIT_BATCH_UPDATE.
const LitBatch = (() => {
  const KEY = 'lit_batch';
  const DONE_KEY = 'lit_batch_done';
  const ALARM = 'lit-batch-tick';
  const ALARM_PERIOD_MINUTES = 0.5;

  const OPEN_TIMEOUT_MS = 45 * 1000;
  const HARD_TIMEOUT_MS = 4 * 60 * 1000;
  const INJECT_AFTER_MS = 20 * 1000;
  const CLOSE_DELAY_MS = 1500;
  const DONE_CAP = 2000;
  const MAX_CONCURRENCY = 10;
  const DEFAULT_CONCURRENCY = 5;
  const MAX_MISSING = 10;
  const MAX_LABEL = 80;
  const MAX_REASON = 160;
  const MAX_TEXT = 200;

  const ACTIVE = ['opening', 'filling', 'submitting'];
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
      const ctx = { now, state: await readBatch(), dirty: false, remove: false, submitted: [], closes: [], injects: [], timers: [] };
      if (ctx.state) sweep(ctx);
      const result = fn ? await fn(ctx) : undefined;
      if (ctx.state && !ctx.remove) await pump(ctx);
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
    ctx.injects.forEach(tabId => {
      if (typeof hooks.injectAutofill !== 'function') return;
      Promise.resolve().then(() => hooks.injectAutofill(tabId)).catch(() => {});
    });
    // Best-effort wake-ups for deadlines shorter than the alarm period. If the
    // worker dies first, the alarm or the next event catches up.
    Array.from(new Set(ctx.timers)).forEach(ms => later(() => { tick(); }, ms));
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
      ctx.submitted.push(job.jobId);
      ctx.timers.push(CLOSE_DELAY_MS + 50);
    }
  }

  function sweep(ctx) {
    const { now, state } = ctx;
    state.jobs.forEach(job => {
      if (isActive(job)) {
        const age = now - (Number.isFinite(job.startedAt) ? job.startedAt : now);
        if (job.status === 'opening' && age >= OPEN_TIMEOUT_MS) {
          finish(ctx, job, 'needs-you', 'No application form found');
        } else if (age >= HARD_TIMEOUT_MS) {
          finish(ctx, job, 'needs-you', 'Timed out');
        } else if (job.status === 'opening' && age >= INJECT_AFTER_MS && !job.helloAt && !job.injectedAt && typeof job.tabId === 'number') {
          // No driver has said hello: the page may be outside the manifest's
          // matches. Try once; the 45 s timeout covers a refusal.
          job.injectedAt = now;
          ctx.injects.push(job.tabId);
          ctx.dirty = true;
        }
      } else if (job.status === 'submitted' && typeof job.tabId === 'number' && now - (job.updatedAt || 0) >= CLOSE_DELAY_MS) {
        ctx.closes.push(job.tabId);
        job.tabId = null;
        ctx.dirty = true;
      }
    });
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
    Object.assign(job, { status: 'opening', startedAt: ctx.now, updatedAt: ctx.now, reason: '', tabId: null, frameId: null, helloAt: null, injectedAt: null });
    ctx.dirty = true;
    try {
      job.tabId = await openTab(ctx.state, job.url);
      ctx.timers.push(INJECT_AFTER_MS + 50, OPEN_TIMEOUT_MS + 50);
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

  function stop() {
    return step(ctx => {
      if (!ctx.state) return { ok: false, error: 'No batch' };
      ctx.state.jobs.forEach(job => { if (job.status === 'queued') finish(ctx, job, 'skipped', 'Stopped'); });
      if (ctx.state.status === 'running') ctx.state.status = 'stopped';
      ctx.dirty = true;
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

  async function focus(msg) {
    const state = await step(ctx => ctx.state);
    const job = state && state.jobs.find(j => j.jobId === msg.jobId);
    if (!job || typeof job.tabId !== 'number') return { ok: false, error: 'That tab is closed' };
    try {
      const tab = await chrome.tabs.update(job.tabId, { active: true });
      const windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : state.windowId;
      if (typeof windowId === 'number') await chrome.windows.update(windowId, { focused: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: 'That tab is closed' };
    }
  }

  function jobForTab(state, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!state || typeof tabId !== 'number') return null;
    return state.jobs.find(j => j.tabId === tabId && !isTerminal(j) && j.status !== 'queued') || null;
  }

  function hello(sender) {
    return step(ctx => {
      const job = jobForTab(ctx.state, sender);
      if (!job) return { job: null };
      if (!job.helloAt) { job.helloAt = ctx.now; ctx.dirty = true; }
      return {
        job: { jobId: job.jobId, title: job.title, company: job.company, url: job.url, status: job.status },
        mode: ctx.state.mode
      };
    });
  }

  function update(msg, sender) {
    return step(ctx => {
      const job = jobForTab(ctx.state, sender);
      if (!job) return { ok: false };
      const next = msg.status;
      if (!(TRANSITIONS[job.status] || []).includes(next)) return { ok: false };
      const frameId = sender && typeof sender.frameId === 'number' ? sender.frameId : 0;
      // The first frame to start filling owns the job; any other frame of the
      // same tab (a second form, an ad iframe) is told to stand down.
      if (next === 'filling') job.frameId = frameId;
      else if (job.frameId !== frameId) return { ok: false };

      if (Number.isFinite(msg.filled)) job.filled = Math.max(0, Math.floor(msg.filled));
      if (Array.isArray(msg.missing)) {
        job.missing = msg.missing.map(m => text(m, MAX_LABEL)).filter(Boolean).slice(0, MAX_MISSING);
      }
      if (TERMINAL.includes(next)) {
        finish(ctx, job, next, msg.reason);
      } else {
        job.status = next;
        job.reason = text(msg.reason, MAX_REASON);
        job.updatedAt = ctx.now;
        ctx.dirty = true;
      }
      return { ok: true };
    });
  }

  function onTabRemoved(tabId) {
    return step(ctx => {
      if (!ctx.state) return;
      ctx.state.jobs.forEach(job => {
        if (job.tabId === tabId && isActive(job)) {
          finish(ctx, job, 'skipped', 'Tab closed');
          job.tabId = null;
        }
      });
    });
  }

  function tick(now) {
    return step(null, now);
  }

  function respond(promise, sendResponse, fallback) {
    promise.then(
      res => { try { sendResponse(res); } catch (e) { /* the asker went away */ } },
      () => { try { sendResponse(fallback); } catch (e) { /* the asker went away */ } }
    );
    return true;
  }

  function handleMessage(msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('LIT_BATCH_') !== 0) return false;
    const failed = { ok: false, error: 'Something went wrong' };
    switch (msg.type) {
      case 'LIT_BATCH_START': return respond(start(msg), sendResponse, failed);
      case 'LIT_BATCH_STOP': return respond(stop(), sendResponse, failed);
      case 'LIT_BATCH_CLEAR': return respond(clear(), sendResponse, failed);
      case 'LIT_BATCH_FOCUS': return respond(focus(msg), sendResponse, failed);
      case 'LIT_BATCH_HELLO': return respond(hello(sender), sendResponse, { job: null });
      case 'LIT_BATCH_UPDATE': return respond(update(msg, sender), sendResponse, { ok: false });
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
    KEY,
    DONE_KEY,
    ALARM,
    OPEN_TIMEOUT_MS,
    HARD_TIMEOUT_MS,
    INJECT_AFTER_MS,
    CLOSE_DELAY_MS,
    DONE_CAP
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LitBatch;
