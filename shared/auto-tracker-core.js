// Auto-tracking core for Job & Activity Tracker.
//
// Everything a platform adapter needs and nothing it should own itself:
//
//   registry   registerAdapter / getActiveAdapter. An adapter is a small
//              declarative object (see PlatformAdapter below); the core never
//              branches on a site name.
//   dedupe     TTL + LRU cache keyed `<scope>:<slug>:<YYYY-MM-DD>`, mirrored
//              into chrome.storage.session so a page refresh, tab reload, or a
//              second accepted submission of the same problem cannot double
//              count. Falls back to chrome.storage.local when the session area
//              is not exposed to content scripts.
//   toast      An in-page notice rendered inside a closed ShadowRoot so host
//              page CSS cannot restyle it and it cannot leak styles out.
//   dispatch   Turns an ActivityPayload into TrackerStorage.addLog().
//   dom        observe / listen / waitFor / watchUrl. Each returns a teardown
//              function, and an adapter collects them on a Cleanup so leaving
//              a page disconnects every observer in one call. No setInterval
//              anywhere: every wait is a scoped MutationObserver that
//              disconnects the moment it has what it needs.
//
// PlatformAdapter contract:
//   {
//     id: 'leetcode',                       unique platform id
//     metricId: 'leetcode' | 'jobs',        target metric
//     dedupeScope?: 'leetcode',             optional; defaults to id. Lets two
//                                           platforms that host the same
//                                           problems (LeetCode, NeetCode) share
//                                           one dedupe namespace.
//     matches(url: URL): boolean,
//     routeKey?(url: URL): string,          same key => same mount. Defaults to
//                                           pathname. LeetCode maps every
//                                           /problems/<slug>/... to the slug
//                                           so a post-submit pushState to
//                                           /submissions/<id> does not remount.
//     init(onSuccess, ctx): () => void      arm detection; returns teardown.
//   }
//
// ActivityPayload:
//   {
//     id: 'two-sum',                        stable slug, used in the dedupe key
//     title: 'Two Sum',                     shown in the toast
//     company?: string, role?: string,      jobs metadata
//     notes?: string,                       free text stored on the log
//     meta?: { difficulty, language, runtime, category, ... }
//   }
const AutoTrackerCore = (() => {
  const TOAST_PREFIX = 'LIT';
  const TOAST_HOST_ID = 'pt-auto-toast-host';
  const TOAST_DURATION_MS = 4000;

  const DEDUPE_STORAGE_KEY = 'pt_autotrack_dedupe';
  // A key embeds the local date, so anything older than a day and a half is
  // guaranteed unreachable and only costs storage.
  const DEDUPE_TTL_MS = 36 * 60 * 60 * 1000;
  const DEDUPE_MAX_ENTRIES = 500;

  // Injectable clock so TTL expiry can be driven headlessly in tests.
  let nowMs = () => Date.now();

  // ---------------------------------------------------------------------------
  // Adapter registry
  // ---------------------------------------------------------------------------
  const adapters = [];

  function assertAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object') throw new Error('Adapter must be an object');
    if (typeof adapter.id !== 'string' || !adapter.id) throw new Error('Adapter needs a string id');
    if (typeof adapter.metricId !== 'string' || !adapter.metricId) throw new Error('Adapter needs a metricId');
    if (typeof adapter.matches !== 'function') throw new Error('Adapter needs matches(url)');
    if (typeof adapter.init !== 'function') throw new Error('Adapter needs init(onSuccess)');
  }

  function registerAdapter(adapter) {
    assertAdapter(adapter);
    const existing = adapters.findIndex(a => a.id === adapter.id);
    if (existing >= 0) adapters.splice(existing, 1);
    adapters.push(adapter);
    return adapter;
  }

  function getAdapters() {
    return adapters.slice();
  }

  function clearAdapters() {
    adapters.length = 0;
  }

  function toURL(input) {
    if (input instanceof URL) return input;
    try {
      return new URL(String(input));
    } catch (e) {
      return null;
    }
  }

  function getActiveAdapter(input) {
    const url = toURL(input);
    if (!url) return null;
    for (const adapter of adapters) {
      try {
        if (adapter.matches(url)) return adapter;
      } catch (e) {
        // A throwing matcher must not block the adapters registered after it.
      }
    }
    return null;
  }

  function routeKeyFor(adapter, input) {
    const url = toURL(input);
    if (!url) return '';
    if (adapter && typeof adapter.routeKey === 'function') {
      try {
        return String(adapter.routeKey(url));
      } catch (e) {
        return url.pathname;
      }
    }
    return url.pathname;
  }

  // ---------------------------------------------------------------------------
  // Deduplication engine
  // ---------------------------------------------------------------------------
  function localDateStr(d) {
    const date = d ? new Date(d) : new Date(nowMs());
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function slugify(value) {
    return String(value || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120) || 'unknown';
  }

  function buildDedupeKey(scope, itemId, date) {
    return `${slugify(scope)}:${slugify(itemId)}:${date || localDateStr()}`;
  }

  // Content scripts only see chrome.storage.session after the service worker
  // widens its access level; until then reads reject with lastError. Local is
  // the fallback so dedupe never silently degrades to memory-only.
  function pickDedupeArea() {
    if (typeof chrome === 'undefined' || !chrome.storage) return null;
    if (chrome.storage.session) return chrome.storage.session;
    if (chrome.storage.local) return chrome.storage.local;
    return null;
  }

  function areaGet(area, key) {
    return new Promise(resolve => {
      try {
        area.get([key], result => {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(result && result[key] !== undefined ? result[key] : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function areaSet(area, key, value) {
    return new Promise(resolve => {
      try {
        area.set({ [key]: value }, () => {
          const failed = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
          resolve(!failed);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  function createDedupeCache(options = {}) {
    const ttlMs = options.ttlMs || DEDUPE_TTL_MS;
    const maxEntries = options.maxEntries || DEDUPE_MAX_ENTRIES;
    const storageKey = options.storageKey || DEDUPE_STORAGE_KEY;
    const area = options.area !== undefined ? options.area : pickDedupeArea();
    const fallbackArea = options.fallbackArea !== undefined
      ? options.fallbackArea
      : (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && area !== chrome.storage.local
        ? chrome.storage.local
        : null);

    // Insertion order doubles as recency: Map iterates oldest first, and a
    // re-mark deletes then re-inserts, which is all the LRU we need.
    const entries = new Map();
    let activeArea = area;
    let loaded = null;

    function prune() {
      const cutoff = nowMs() - ttlMs;
      for (const [key, ts] of entries) {
        if (ts < cutoff) entries.delete(key);
      }
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    }

    function absorb(raw) {
      if (!raw || typeof raw !== 'object') return;
      const pairs = Object.entries(raw)
        .filter(([, ts]) => Number.isFinite(ts))
        .sort((a, b) => a[1] - b[1]);
      for (const [key, ts] of pairs) {
        if (!entries.has(key)) entries.set(key, ts);
      }
      prune();
    }

    async function load() {
      if (loaded) return loaded;
      loaded = (async () => {
        if (!activeArea) return;
        let raw = await areaGet(activeArea, storageKey);
        if (raw === null && fallbackArea && activeArea !== fallbackArea) {
          // Session area refused us; stay on local for the rest of this page.
          const probe = await areaSet(activeArea, storageKey, {});
          if (!probe) {
            activeArea = fallbackArea;
            raw = await areaGet(activeArea, storageKey);
          }
        }
        absorb(raw);
      })();
      return loaded;
    }

    async function persist() {
      if (!activeArea) return false;
      const snapshot = {};
      for (const [key, ts] of entries) snapshot[key] = ts;
      const ok = await areaSet(activeArea, storageKey, snapshot);
      if (!ok && fallbackArea && activeArea !== fallbackArea) {
        activeArea = fallbackArea;
        return areaSet(activeArea, storageKey, snapshot);
      }
      return ok;
    }

    return {
      async has(key) {
        await load();
        prune();
        return entries.has(key);
      },
      // Re-reads storage right before marking so a sibling tab that logged the
      // same item a moment ago is seen. Returns false when the key was already
      // present, which is the signal to skip logging.
      async mark(key) {
        await load();
        if (activeArea) absorb(await areaGet(activeArea, storageKey));
        prune();
        if (entries.has(key)) return false;
        entries.set(key, nowMs());
        prune();
        await persist();
        return true;
      },
      async unmark(key) {
        await load();
        if (!entries.delete(key)) return false;
        await persist();
        return true;
      },
      async clear() {
        await load();
        entries.clear();
        await persist();
      },
      size() {
        prune();
        return entries.size;
      },
      keys() {
        prune();
        return Array.from(entries.keys());
      },
      areaName() {
        if (!activeArea) return 'memory';
        if (activeArea.name) return activeArea.name;
        const session = typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.session : null;
        return activeArea === session ? 'session' : 'local';
      }
    };
  }

  let sharedCache = null;
  function getDedupeCache() {
    if (!sharedCache) sharedCache = createDedupeCache();
    return sharedCache;
  }

  // ---------------------------------------------------------------------------
  // Shadow DOM toast
  // ---------------------------------------------------------------------------
  const TOAST_CSS = `
    :host { all: initial; }
    .stack {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
      pointer-events: none;
      font-family: "Google Sans", Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .toast {
      pointer-events: auto;
      max-width: 360px;
      padding: 10px 14px;
      border-radius: 8px;
      background: #202124;
      color: #e8eaed;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.28);
      border-left: 3px solid #34a853;
      opacity: 0;
      transform: translateY(6px);
      transition: opacity 160ms ease, transform 160ms ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.info { border-left-color: #8ab4f8; }
    .toast.warn { border-left-color: #fbbc04; }
    .prefix { font-weight: 600; margin-right: 4px; }
  `;

  let toastRoot = null;

  function getToastRoot(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;
    if (toastRoot && toastRoot.host && toastRoot.host.isConnected !== false) return toastRoot;
    let host = d.getElementById ? d.getElementById(TOAST_HOST_ID) : null;
    if (!host) {
      host = d.createElement('div');
      host.id = TOAST_HOST_ID;
      (d.body || d.documentElement).appendChild(host);
    }
    const shadow = host.shadowRoot || host.attachShadow({ mode: 'closed' });
    if (!shadow.querySelector('.stack')) {
      const style = d.createElement('style');
      style.textContent = TOAST_CSS;
      const stack = d.createElement('div');
      stack.className = 'stack';
      shadow.appendChild(style);
      shadow.appendChild(stack);
    }
    toastRoot = { host, shadow, stack: shadow.querySelector('.stack'), doc: d };
    return toastRoot;
  }

  function showToast(message, options = {}) {
    const root = getToastRoot(options.document);
    if (!root) return null;
    const d = root.doc;
    const variant = options.variant === 'info' || options.variant === 'warn' ? options.variant : 'success';
    const el = d.createElement('div');
    el.className = 'toast ' + variant;
    el.setAttribute('role', 'status');
    const prefix = d.createElement('span');
    prefix.className = 'prefix';
    prefix.textContent = TOAST_PREFIX + ':';
    const body = d.createElement('span');
    body.textContent = String(message || '');
    el.appendChild(prefix);
    el.appendChild(body);
    root.stack.appendChild(el);

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.remove('show');
      if (el.parentNode) el.parentNode.removeChild(el);
    };

    // One-shot timers only. rAF gives the transition a frame to start from.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => el.classList.add('show'));
    } else {
      el.classList.add('show');
    }
    setTimeout(dismiss, options.durationMs || TOAST_DURATION_MS);
    return { element: el, dismiss };
  }

  function formatLoggedMessage(payload) {
    const title = payload && payload.title ? String(payload.title).trim() : '';
    const count = payload && payload.count ? parseInt(payload.count, 10) || 1 : 1;
    return `Logged ${title || payload.id || 'activity'} (+${count})`;
  }

  // ---------------------------------------------------------------------------
  // Dispatcher
  // ---------------------------------------------------------------------------
  function describeMeta(meta) {
    if (!meta || typeof meta !== 'object') return '';
    const bits = [];
    if (meta.category) bits.push(String(meta.category));
    if (meta.difficulty) bits.push(String(meta.difficulty));
    if (meta.language) bits.push(String(meta.language));
    if (meta.runtime) bits.push(String(meta.runtime));
    return bits.join(', ');
  }

  function buildLog(adapter, payload) {
    const detail = describeMeta(payload.meta);
    const source = `Auto-logged from ${adapter.label || adapter.id}`;
    const notes = payload.notes
      ? String(payload.notes)
      : [source, payload.title, detail].filter(Boolean).join(' | ');
    return {
      metricId: payload.metricId || adapter.metricId,
      count: Math.max(1, parseInt(payload.count, 10) || 1),
      company: payload.company || '',
      role: payload.role || '',
      notes
    };
  }

  // Serializes dispatches so two adapters (or two rapid mutations) cannot race
  // past the dedupe check together.
  let dispatchChain = Promise.resolve();

  function dispatch(adapter, payload, options = {}) {
    const run = async () => {
      if (!adapter || !payload || !payload.id) return { logged: false, reason: 'invalid' };
      const storage = options.storage || (typeof TrackerStorage !== 'undefined' ? TrackerStorage : null);
      if (!storage || typeof storage.addLog !== 'function') return { logged: false, reason: 'no-storage' };

      const cache = options.cache || getDedupeCache();
      const key = buildDedupeKey(adapter.dedupeScope || adapter.id, payload.id, payload.date);
      // Claim the key before writing: mark() re-reads storage, so a sibling
      // tab that claimed it a moment ago wins. A failed write releases the
      // claim so the activity stays retryable.
      if (!(await cache.mark(key))) return { logged: false, reason: 'duplicate', key };

      let log;
      try {
        log = await storage.addLog(buildLog(adapter, payload));
      } catch (e) {
        await cache.unmark(key);
        return { logged: false, reason: 'write-failed', key };
      }
      if (options.toast !== false) {
        showToast(formatLoggedMessage(payload), { document: options.document });
      }
      return { logged: true, key, log };
    };
    const next = dispatchChain.then(run, run);
    dispatchChain = next.catch(() => {});
    return next;
  }

  // ---------------------------------------------------------------------------
  // Zero-polling DOM helpers
  // ---------------------------------------------------------------------------
  function getMutationObserverCtor() {
    return typeof MutationObserver !== 'undefined' ? MutationObserver : null;
  }

  // Observe `target` and call cb(records, stop). Returns stop.
  function observe(target, cb, options) {
    const Ctor = getMutationObserverCtor();
    if (!Ctor || !target) return () => {};
    let stopped = false;
    const observer = new Ctor(records => {
      if (stopped) return;
      cb(records, stop);
    });
    function stop() {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
    }
    observer.observe(target, options || { childList: true, subtree: true });
    return stop;
  }

  // Calls onFound(el, stop) for elements matching `selector` as they are
  // added under `root`. Only ADDED nodes are inspected, which is what keeps a
  // Monaco keystroke from costing a document-wide query. Default is one hit
  // then disconnect; `once: false` keeps going, `all: true` reports every
  // match inside an added container (capped) instead of only the first.
  function waitFor(selector, options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document.body || document.documentElement : null);
    if (!root) return () => {};
    const onFound = options.onFound || (() => {});
    const once = options.once !== false;
    const maxPerNode = options.maxPerNode || 50;
    if (options.checkExisting && typeof root.querySelector === 'function') {
      const existing = root.querySelector(selector);
      if (existing) {
        onFound(existing, () => {});
        return () => {};
      }
    }
    let stopped = false;
    const stopObserver = observe(root, (records, stop) => {
      for (const record of records) {
        const added = record.addedNodes || [];
        for (let i = 0; i < added.length; i++) {
          const node = added[i];
          if (!node || node.nodeType !== 1) continue;
          const hits = [];
          if (typeof node.matches === 'function' && node.matches(selector)) hits.push(node);
          if (options.all && typeof node.querySelectorAll === 'function') {
            const inner = node.querySelectorAll(selector);
            for (let j = 0; j < inner.length && hits.length < maxPerNode; j++) hits.push(inner[j]);
          } else if (!hits.length && typeof node.querySelector === 'function') {
            const hit = node.querySelector(selector);
            if (hit) hits.push(hit);
          }
          for (const hit of hits) {
            if (once) stopSelf();
            onFound(hit, stopSelf);
            if (stopped) return;
          }
        }
      }
    }, { childList: true, subtree: true });
    function stopSelf() {
      if (stopped) return;
      stopped = true;
      stopObserver();
    }
    return stopSelf;
  }

  // Waits for an element matching `selector` whose text satisfies `test`.
  // Added nodes are checked once; a node that matches the selector but not
  // yet the text (an output panel still reading "Pending") gets its own
  // scoped observer so an in-place text update is caught too. Everything
  // disconnects on the first satisfying node. Returns stop.
  function waitForText(selector, options = {}) {
    const root = options.root || (typeof document !== 'undefined' ? document.body || document.documentElement : null);
    const test = typeof options.test === 'function' ? options.test : (() => true);
    const filter = typeof options.filter === 'function' ? options.filter : (() => true);
    const onMatch = typeof options.onMatch === 'function' ? options.onMatch : (() => {});
    const maxTracked = options.maxTracked === undefined ? 8 : options.maxTracked;
    const cleanup = createCleanup();
    if (!root) return cleanup;
    const tracked = new Set();

    function evaluate(node) {
      if (cleanup.isDone()) return true;
      const text = textOf(node);
      if (!test(text, node)) return false;
      cleanup();
      onMatch(node, text);
      return true;
    }

    function track(node) {
      if (!filter(node) || tracked.has(node) || evaluate(node)) return;
      if (tracked.size >= maxTracked) return;
      tracked.add(node);
      cleanup.add(observe(node, () => evaluate(node), { childList: true, subtree: true, characterData: true }));
    }

    cleanup.add(waitFor(selector, { root, once: false, all: true, onFound: track }));
    return cleanup;
  }

  // Passive listener with teardown. Adapters never touch add/removeEventListener directly.
  function listen(target, type, handler, options) {
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    const opts = options === undefined ? { passive: true, capture: true } : options;
    target.addEventListener(type, handler, opts);
    return () => target.removeEventListener(type, handler, opts);
  }

  // Aggregates teardown functions so an adapter can return one cleanup.
  function createCleanup() {
    const fns = [];
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      while (fns.length) {
        const fn = fns.pop();
        try { fn(); } catch (e) { /* teardown must never throw mid-way */ }
      }
    };
    cleanup.add = fn => {
      if (typeof fn !== 'function') return fn;
      if (done) { try { fn(); } catch (e) { /* already torn down */ } return fn; }
      fns.push(fn);
      return fn;
    };
    cleanup.size = () => fns.length;
    cleanup.isDone = () => done;
    return cleanup;
  }

  // SPA URL changes. The Navigation API's currententrychange fires for the
  // page's own pushState/replaceState even from an isolated world, which a
  // monkey-patched history object in this world would never see. The patches
  // are still installed for our own navigations and for environments without
  // the Navigation API; popstate and hashchange cover traversal.
  function watchUrl(cb, options = {}) {
    const win = options.window || (typeof window !== 'undefined' ? window : null);
    if (!win) return () => {};
    const cleanup = createCleanup();
    let last = options.initial || (win.location ? win.location.href : '');

    const check = () => {
      const href = win.location ? win.location.href : '';
      if (href === last) return;
      const prev = last;
      last = href;
      cb(href, prev);
    };

    if (win.navigation && typeof win.navigation.addEventListener === 'function') {
      cleanup.add(listen(win.navigation, 'currententrychange', check, {}));
    }
    cleanup.add(listen(win, 'popstate', check, {}));
    cleanup.add(listen(win, 'hashchange', check, {}));

    const history = win.history;
    if (history && typeof history.pushState === 'function') {
      const origPush = history.pushState;
      const origReplace = history.replaceState;
      history.pushState = function () {
        const r = origPush.apply(this, arguments);
        check();
        return r;
      };
      history.replaceState = function () {
        const r = origReplace.apply(this, arguments);
        check();
        return r;
      };
      cleanup.add(() => {
        if (history.pushState !== origPush) history.pushState = origPush;
        if (history.replaceState !== origReplace) history.replaceState = origReplace;
      });
    }
    return cleanup;
  }

  // Text helpers shared by adapters.
  function textOf(node) {
    if (!node) return '';
    const t = node.textContent !== undefined ? node.textContent : (node.innerText || '');
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  function humanizeSlug(slug) {
    return String(slug || '')
      .replace(/[-_]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  return {
    TOAST_PREFIX,
    TOAST_HOST_ID,
    DEDUPE_STORAGE_KEY,
    DEDUPE_TTL_MS,
    DEDUPE_MAX_ENTRIES,

    registerAdapter,
    getAdapters,
    clearAdapters,
    getActiveAdapter,
    routeKeyFor,

    createDedupeCache,
    getDedupeCache,
    buildDedupeKey,
    slugify,
    localDateStr,

    showToast,
    formatLoggedMessage,

    dispatch,
    buildLog,

    observe,
    waitFor,
    waitForText,
    listen,
    createCleanup,
    watchUrl,
    textOf,
    humanizeSlug,

    nowMs: () => nowMs(),

    // Test seams.
    _setClock(fn) { nowMs = typeof fn === 'function' ? fn : (() => Date.now()); },
    _resetSharedCache() { sharedCache = null; toastRoot = null; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoTrackerCore;
}
