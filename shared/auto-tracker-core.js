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
//              page CSS cannot restyle it and it cannot leak styles out. A
//              toast can carry actions (Undo, Edit details) and an inline
//              form, and stays up while the pointer is over it.
//   dispatch   Turns an ActivityPayload into TrackerStorage.addLog(). A job
//              application is always logged, including a repeat application
//              to the same listing or another role at the same company; only
//              a second detection of the same submit (inside ten minutes) is
//              dropped.
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
//     url?: string,                         the application page
//     notes?: string,                       free text stored on the log
//     meta?: { difficulty, language, runtime, category, ... }
//   }
const AutoTrackerCore = (() => {
  const TOAST_PREFIX = 'LIT';
  const TOAST_HOST_ID = 'pt-auto-toast-host';
  const TOAST_DURATION_MS = 4000;
  const JOB_TOAST_DURATION_MS = 9000;

  const DEDUPE_STORAGE_KEY = 'pt_autotrack_dedupe';
  // A key embeds the local date, so anything older than a day and a half is
  // guaranteed unreachable and only costs storage.
  const DEDUPE_TTL_MS = 36 * 60 * 60 * 1000;
  const DEDUPE_MAX_ENTRIES = 500;
  // One submit can be detected twice (a confirmation URL and its message, two
  // frames, a quick refresh). Anything further apart is a new application.
  const JOB_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

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
        if (!entries.has(key) || entries.get(key) < ts) {
          entries.delete(key);
          entries.set(key, ts);
        }
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

    // With a window, an entry older than the window no longer counts.
    const live = (key, windowMs) => entries.has(key) && (!windowMs || nowMs() - entries.get(key) <= windowMs);

    return {
      async has(key, windowMs) {
        await load();
        prune();
        return live(key, windowMs);
      },
      // Re-reads storage right before marking so a sibling tab that logged the
      // same item a moment ago is seen. Returns false when the key was already
      // present, which is the signal to skip logging.
      async mark(key, windowMs) {
        await load();
        if (activeArea) absorb(await areaGet(activeArea, storageKey));
        prune();
        if (live(key, windowMs)) return false;
        entries.delete(key);
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

  // Small key-value store for state that must outlive one page but not the
  // browser session (the universal tracker's "a submit just happened on this
  // site" marker). Same session-then-local fallback as the dedupe cache.
  let kvArea = undefined;
  async function kvResolveArea() {
    if (kvArea !== undefined) return kvArea;
    const primary = pickDedupeArea();
    const local = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    if (primary && primary !== local) {
      const probe = await areaSet(primary, '__pt_probe', 1);
      kvArea = probe ? primary : local;
    } else {
      kvArea = primary || null;
    }
    return kvArea;
  }

  async function sessionGet(key) {
    const area = await kvResolveArea();
    return area ? areaGet(area, key) : null;
  }

  async function sessionSet(key, value) {
    const area = await kvResolveArea();
    return area ? areaSet(area, key, value) : false;
  }

  // ---------------------------------------------------------------------------
  // Shadow DOM toast ("Warm Coach")
  //
  // A light card in the user's accent color that follows the OS light/dark
  // scheme. An auto-logged activity shows today's progress ("Application
  // logged · 3 of 5 today") over a small segmented bar; the log that meets
  // the day's goal reads "Locked in for today" and its padlock's shackle
  // swings shut once. Everything is read once per log (one getStats call,
  // one prefs read); nothing polls.
  //
  // Placement: top right by default, clear of the bottom-of-form Submit and
  // Next buttons most application pages use. When the Autofill widget has a
  // remembered spot on this site (the user dragged it somewhere out of the
  // way), toasts use that corner and stack just past the widget.
  // ---------------------------------------------------------------------------
  const ACCENTS = {
    coral: ['#E0674B', '#F07A5E'],
    sage: ['#5E9270', '#7FB291'],
    ocean: ['#3B7EA1', '#5FA3C7'],
    plum: ['#8A5A9E', '#B285C6'],
    amber: ['#C9821F', '#E3A54A'],
    slate: ['#3D4A5C', '#A9B6C8']
  };
  const MAX_SEGMENTS = 10;
  const TOAST_STATS_TIMEOUT_MS = 900;
  const AUTOFILL_POS_KEY = 'lit_af_ui_pos';
  const DEFAULT_TOAST_PLACEMENT = { h: 'right', v: 'top', x: 16, y: 16 };
  // The Autofill dock is ~40px tall; toasts start past it.
  const WIDGET_CLEARANCE_PX = 52;

  const TOAST_CSS = `
    :host { all: initial; }
    .stack {
      --bg: #FBF8F3;
      --surface: #FFFFFF;
      --surface-2: #F4EFE7;
      --ink: #2A2622;
      --muted: #6F665E;
      --line: #ECE5DA;
      --success: #6B9E7A;
      --warn: #B7791F;
      --accent: var(--accent-l, #E0674B);
      --on-accent: #FFFFFF;
      --shadow: 0 12px 32px rgba(42, 38, 34, 0.14), 0 2px 6px rgba(42, 38, 34, 0.08);
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-end;
      pointer-events: none;
      font-family: ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .stack.at-left { align-items: flex-start; }
    @media (prefers-color-scheme: dark) {
      .stack {
        --bg: #1C1916;
        --surface: #26221E;
        --surface-2: #2F2A25;
        --ink: #F3EDE4;
        --muted: #A89E92;
        --line: #3A342D;
        --success: #82B592;
        --warn: #E3A54A;
        --accent: var(--accent-d, #F07A5E);
        --on-accent: #1C1916;
        --shadow: 0 14px 36px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3);
      }
    }
    .toast {
      pointer-events: auto;
      box-sizing: border-box;
      width: max-content;
      min-width: 260px;
      max-width: min(360px, calc(100vw - 32px));
      padding: 12px 14px;
      border-radius: 16px;
      background: var(--surface);
      color: var(--ink);
      font-size: 13px;
      line-height: 1.45;
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      position: relative;
      overflow: hidden;
      opacity: 0;
      transform: translateY(-6px) scale(0.98);
      transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .stack.at-bottom .toast { transform: translateY(6px) scale(0.98); }
    .toast.show, .stack.at-bottom .toast.show { opacity: 1; transform: none; }
    .head { display: flex; align-items: flex-start; gap: 9px; }
    .mark {
      flex: none;
      width: 18px;
      height: 18px;
      margin-top: 1px;
      color: var(--accent);
    }
    .mark svg { display: block; overflow: visible; }
    .toast.info .mark { color: var(--muted); }
    .toast.warn .mark { color: var(--warn); }
    .text { flex: 1; min-width: 0; }
    .prefix {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    .body { font-weight: 700; word-break: break-word; font-variant-numeric: tabular-nums; }
    .detail { display: block; margin-top: 2px; font-size: 12px; color: var(--muted); word-break: break-word; }
    .coach { display: block; margin-top: 6px; font-size: 12px; color: var(--ink); }
    .coach + .coach { margin-top: 2px; color: var(--muted); }
    .segs { display: flex; gap: 3px; margin: 8px 0 2px; max-width: 220px; }
    .seg {
      flex: 1 1 0;
      height: 6px;
      border-radius: 3px;
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--line);
    }
    .seg.on { background: var(--accent); box-shadow: none; }
    .seg.new { animation: lit-seg 420ms cubic-bezier(0.34, 1.56, 0.64, 1) 120ms both; }
    @keyframes lit-seg { from { transform: scaleY(0.3); opacity: 0.3; } to { transform: none; opacity: 1; } }
    .actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
    .toast.has-mark .actions, .toast.has-mark form { margin-left: 27px; }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font-family: inherit;
      font-weight: 600;
      font-size: 12px;
      line-height: 1;
      padding: 7px 11px;
      border-radius: 10px;
      color: var(--ink);
      background: var(--surface-2);
      border: 1px solid var(--line);
      transition: background 160ms cubic-bezier(0.16, 1, 0.3, 1), transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    button:hover { background: var(--line); }
    button:active { transform: scale(0.97); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button.primary { background: var(--accent); color: var(--on-accent); border-color: transparent; }
    button.primary:hover { filter: brightness(1.06); background: var(--accent); }
    button.close {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 22px;
      height: 22px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border-color: transparent;
      color: var(--muted);
      font-size: 15px;
      border-radius: 50%;
    }
    button.close:hover { background: var(--surface-2); color: var(--ink); }
    .toast.has-close { padding-right: 34px; }
    form { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; }
    label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted); font-weight: 600; }
    input {
      all: unset;
      box-sizing: border-box;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.3;
      color: var(--ink);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 7px 9px;
      width: 100%;
      transition: border-color 160ms ease;
    }
    input:focus { border-color: var(--accent); }
    .note { margin-top: 8px; font-size: 12px; color: var(--warn); }

    /* Padlock mark. Open: shackle raised and swung off the left post.
       Locked: shackle down, body filled. "shut" plays open -> locked once. */
    .lock .shackle { transform-origin: 12px 8.5px; }
    .lock .lbody { fill: currentColor; fill-opacity: 1; }
    .lock.open .shackle { transform: translateY(-1.6px) rotate(24deg); }
    .lock.open .lbody { fill-opacity: 0; }
    .lock.shut .shackle { animation: lit-shut 350ms cubic-bezier(0.34, 1.56, 0.64, 1) 260ms both; }
    .lock.shut .lbody { animation: lit-fill 200ms ease-out 480ms both; }
    .lock.glow { filter: drop-shadow(0 0 3px var(--accent)); }
    @keyframes lit-shut {
      from { transform: translateY(-1.6px) rotate(24deg); }
      to { transform: none; }
    }
    @keyframes lit-fill { from { fill-opacity: 0; } to { fill-opacity: 1; } }

    @media (prefers-reduced-motion: reduce) {
      .toast, button { transition: none; }
      .seg.new, .lock.shut .shackle, .lock.shut .lbody { animation: none; }
    }
  `;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    lock: {
      attrs: { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none' },
      children: [
        ['path', { class: 'shackle', d: 'M6 8.5V6a3 3 0 0 1 6 0v2.5', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round' }],
        ['rect', { class: 'lbody', x: '3.5', y: '8.5', width: '11', height: '7.5', rx: '2.2', stroke: 'currentColor', 'stroke-width': '1.7' }]
      ]
    },
    check: {
      attrs: { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none' },
      children: [
        ['circle', { cx: '9', cy: '9', r: '7.2', stroke: 'currentColor', 'stroke-width': '1.6' }],
        ['path', { d: 'M5.8 9.2l2.2 2.2 4.3-4.6', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
      ]
    },
    info: {
      attrs: { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none' },
      children: [
        ['circle', { cx: '9', cy: '9', r: '7.2', stroke: 'currentColor', 'stroke-width': '1.6' }],
        ['path', { d: 'M9 8.2v4.2M9 5.6v.1', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }]
      ]
    },
    warn: {
      attrs: { width: '18', height: '18', viewBox: '0 0 18 18', fill: 'none' },
      children: [
        ['path', { d: 'M9 2.4l7 12.4H2z', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round' }],
        ['path', { d: 'M9 7.4v3.2M9 12.8v.1', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }]
      ]
    }
  };

  // null where the document cannot make SVG (the headless test DOM).
  function buildIcon(d, name, extraClass) {
    const spec = ICONS[name];
    if (!spec || !d || typeof d.createElementNS !== 'function') return null;
    try {
      const make = (tag, attrs) => {
        const node = d.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
        return node;
      };
      const svg = make('svg', Object.assign({ 'aria-hidden': 'true', focusable: 'false' }, spec.attrs));
      if (extraClass) svg.setAttribute('class', extraClass);
      spec.children.forEach(([tag, attrs]) => svg.appendChild(make(tag, attrs)));
      return svg;
    } catch (e) {
      return null;
    }
  }

  function accentPair(id) {
    return ACCENTS[id] || ACCENTS.coral;
  }

  function setVar(node, name, value) {
    if (node && node.style && typeof node.style.setProperty === 'function') node.style.setProperty(name, value);
  }

  function applyAccent(root, accentId) {
    if (!root || !root.stack) return;
    const [light, dark] = accentPair(accentId);
    setVar(root.stack, '--accent-l', light);
    setVar(root.stack, '--accent-d', dark);
  }

  // Where toasts go, from the Autofill widget's remembered position on this
  // site (or null): the same corner, just past the widget.
  function toastPlacement(saved) {
    const ok = saved && (saved.h === 'left' || saved.h === 'right') && (saved.v === 'top' || saved.v === 'bottom') &&
      Number.isFinite(saved.x) && Number.isFinite(saved.y);
    if (!ok) return Object.assign({}, DEFAULT_TOAST_PLACEMENT);
    return {
      h: saved.h,
      v: saved.v,
      x: Math.max(8, Math.round(saved.x)),
      y: Math.max(8, Math.round(saved.y)) + WIDGET_CLEARANCE_PX
    };
  }

  function applyPlacement(root, placement) {
    if (!root || !root.stack) return;
    const p = placement || DEFAULT_TOAST_PLACEMENT;
    const s = root.stack.style;
    s.left = p.h === 'left' ? p.x + 'px' : 'auto';
    s.right = p.h === 'right' ? p.x + 'px' : 'auto';
    s.top = p.v === 'top' ? p.y + 'px' : 'auto';
    s.bottom = p.v === 'bottom' ? p.y + 'px' : 'auto';
    root.stack.classList.toggle('at-left', p.h === 'left');
    root.stack.classList.toggle('at-bottom', p.v === 'bottom');
  }

  function extensionAlive() {
    try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; } catch (e) { return false; }
  }

  function pageHost() {
    try { return String((typeof location !== 'undefined' && location.hostname) || '').toLowerCase(); } catch (e) { return ''; }
  }

  // One read when the toast host is created: the widget's spot and the
  // accent. Both are best effort; the defaults are fine.
  function loadRootLook(root) {
    if (!extensionAlive()) return;
    try {
      if (chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(AUTOFILL_POS_KEY, items => {
          try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
          const all = items && items[AUTOFILL_POS_KEY];
          const saved = all && typeof all === 'object' ? all[pageHost()] : null;
          if (saved) applyPlacement(root, toastPlacement(saved));
        });
      }
    } catch (e) { /* storage gone */ }
    try {
      if (typeof TrackerStorage !== 'undefined' && TrackerStorage && typeof TrackerStorage.getPrefs === 'function') {
        Promise.resolve(TrackerStorage.getPrefs()).then(p => { if (p && p.accent) applyAccent(root, p.accent); }).catch(() => {});
      }
    } catch (e) { /* prefs are optional */ }
  }

  let toastRoot = null;

  function getToastRoot(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return null;
    if (toastRoot && toastRoot.doc === d && toastRoot.host && toastRoot.host.isConnected !== false) return toastRoot;
    const createHost = () => {
      const h = d.createElement('div');
      h.id = TOAST_HOST_ID;
      (d.body || d.documentElement).appendChild(h);
      return h;
    };
    let host = d.getElementById ? d.getElementById(TOAST_HOST_ID) : null;
    if (!host) host = createHost();
    let shadow = host.shadowRoot || (toastRoot && toastRoot.host === host ? toastRoot.shadow : null);
    if (!shadow) {
      try {
        shadow = host.attachShadow({ mode: 'closed' });
      } catch (e) {
        // A closed root from an earlier copy of this script (extension
        // reload) cannot be reached or reattached; start a fresh host.
        if (host.parentNode) host.parentNode.removeChild(host);
        host = createHost();
        shadow = host.attachShadow({ mode: 'closed' });
      }
    }
    let fresh = false;
    if (!shadow.querySelector('.stack')) {
      const style = d.createElement('style');
      style.textContent = TOAST_CSS;
      const stack = d.createElement('div');
      stack.className = 'stack';
      shadow.appendChild(style);
      shadow.appendChild(stack);
      fresh = true;
    }
    toastRoot = { host, shadow, stack: shadow.querySelector('.stack'), doc: d };
    if (fresh) {
      applyPlacement(toastRoot, DEFAULT_TOAST_PLACEMENT);
      loadRootLook(toastRoot);
    }
    return toastRoot;
  }

  // ---------------------------------------------------------------------------
  // Progress for a toast: pure, so the copy and the bar can be tested.
  // ---------------------------------------------------------------------------
  function capitalize(s) {
    const t = String(s || '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // "Application", "Problem", "Chat": what one log of this tracker is.
  function unitNoun(metric, metricId) {
    const id = (metric && metric.id) || metricId;
    if (id === 'jobs') return 'Application';
    const unit = String((metric && metric.unit) || '').trim();
    const lib = coachLib();
    if (unit && lib && typeof lib.unitFor === 'function') {
      try {
        const one = lib.unitFor(unit, 1);
        if (typeof one === 'string' && one.trim()) return capitalize(one.trim());
      } catch (e) { /* fall back to trimming the s */ }
    }
    if (unit) return capitalize(/[^s]s$/i.test(unit) ? unit.slice(0, -1) : unit);
    const name = String((metric && metric.name) || id || 'Activity').trim();
    return capitalize(/[^s]s$/i.test(name) ? name.slice(0, -1) : name);
  }

  // Segments mirror the goal one to one up to MAX_SEGMENTS; a bigger goal
  // gets MAX_SEGMENTS proportional segments instead of a hairline per unit.
  function segmentsFor(count, goal) {
    const g = Math.max(1, parseInt(goal, 10) || 1);
    const c = Math.max(0, parseInt(count, 10) || 0);
    if (g <= MAX_SEGMENTS) return { segments: g, filled: Math.min(c, g) };
    return { segments: MAX_SEGMENTS, filled: Math.min(MAX_SEGMENTS, Math.floor((Math.min(c, g) / g) * MAX_SEGMENTS)) };
  }

  function shiftDateStr(dateStr, days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    const d = m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date();
    d.setDate(d.getDate() + days);
    return localDateStr(d);
  }

  function coachLib() {
    return typeof LitCopy !== 'undefined' && LitCopy ? LitCopy : null;
  }

  function fallbackSub(count, goal, justMet) {
    if (justMet) return "That's today's goal. Anything more is a bonus.";
    if (count >= goal) return 'Bonus round. Every extra one counts.';
    const left = goal - count;
    return left === 1 ? 'One more locks in today.' : left + ' more to lock in today.';
  }

  function fallbackStreak(days, met, restToday) {
    if (restToday) return 'Rest day, and you still showed up.';
    if (days >= 2) return met ? 'Day ' + days + '. Keep it rolling.' : days + ' days in a row so far. Keep it rolling.';
    if (days === 1 && met) return 'Day 1. Nice start.';
    return 'Fresh start today';
  }

  // stats: TrackerStorage.getStats() after the write. logCount: how many the
  // log just added. Returns null when there is nothing sensible to show.
  function buildToastProgress({ stats, prefs, metricId, logCount }) {
    if (!stats || !metricId) return null;
    const metric = (Array.isArray(stats.metrics) ? stats.metrics : []).find(m => m && m.id === metricId) || { id: metricId };
    const fromTodayCount = stats.todayCount && Number.isFinite(stats.todayCount[metricId]) ? stats.todayCount[metricId] : null;
    const count = fromTodayCount !== null ? fromTodayCount : ((stats.today && stats.today[metricId]) || 0);
    if (!(count > 0)) return null;
    const goal = Math.max(1, parseInt(metric.dailyGoal, 10) || 1);
    const added = Math.max(1, parseInt(logCount, 10) || 1);
    const before = Math.max(0, count - added);
    const met = count >= goal;
    const justMet = met && before < goal;
    const firstOfDay = before === 0;
    const streak = Math.max(0, parseInt(stats.streaks && stats.streaks[metricId], 10) || 0);
    const freeze = stats.freezes && stats.freezes[metricId];
    const yesterday = shiftDateStr(stats.todayStr, -1);
    const freezeUsed = !!(freeze && Array.isArray(freeze.usedOn) && freeze.usedOn.indexOf(yesterday) >= 0);
    const restToday = !!stats.restToday;
    const voice = (prefs && prefs.coachVoice) || 'coach';
    const noun = unitNoun(metric, metricId);
    const { segments, filled } = segmentsFor(count, goal);
    const prevFilled = segmentsFor(before, goal).filled;

    const title = justMet
      ? 'Locked in for today'
      : (count > goal ? noun + ' logged · ' + count + ' today' : noun + ' logged · ' + count + ' of ' + goal + ' today');

    const lib = coachLib();
    let sub = '';
    if (lib && typeof lib.toast === 'function') {
      try {
        const t = lib.toast({ count, goal, unit: metric.unit || '', label: metric.name || '', voice, firstOfDay, streak });
        sub = t && typeof t.sub === 'string' ? t.sub : '';
      } catch (e) { sub = ''; }
    }
    if (!sub) sub = fallbackSub(count, goal, justMet);

    let streakLine = '';
    if (firstOfDay) {
      if (lib && typeof lib.streak === 'function') {
        try { streakLine = String(lib.streak({ days: streak, restToday, freezeUsed, voice }) || ''); } catch (e) { streakLine = ''; }
      }
      if (!streakLine) streakLine = fallbackStreak(streak, met, restToday);
      // LitCopy's goal-met line already carries the streak day.
      if (/\bDay \d/.test(sub) && /\bDay \d/.test(streakLine)) streakLine = '';
    }

    return {
      metricId,
      count,
      goal,
      before,
      met,
      justMet,
      firstOfDay,
      streak,
      segments,
      filled,
      prevFilled,
      title,
      coach: [sub, streakLine].filter(Boolean),
      lock: met ? (justMet ? 'shut' : 'locked') : 'open',
      glow: met && streak >= 7,
      accent: (prefs && prefs.accent) || 'coral'
    };
  }

  // showToast(message, {
  //   variant: 'success' | 'info' | 'warn',
  //   detail: string,                          second, quieter line
  //   progress: buildToastProgress(...),       segmented bar + padlock
  //   coach: [string],                         short encouraging lines
  //   actions: [{ label, primary, onClick(toast) }],
  //   sticky: true,                            stays until dismissed (adds a close button)
  //   durationMs, document
  // })
  // Returns { element, dismiss, update(message, detail, opts), setDetail,
  // setProgress, setCoach, setActions(list), showForm(spec), isDismissed() }.
  function showToast(message, options = {}) {
    const root = getToastRoot(options.document);
    if (!root) return null;
    const d = root.doc;
    let variant = options.variant === 'info' || options.variant === 'warn' ? options.variant : 'success';
    const el = d.createElement('div');
    el.setAttribute('role', options.actions || options.sticky ? 'alertdialog' : 'status');
    el.setAttribute('aria-live', 'polite');

    const head = d.createElement('div');
    head.className = 'head';
    const mark = d.createElement('span');
    mark.className = 'mark';
    const text = d.createElement('div');
    text.className = 'text';
    const prefix = d.createElement('span');
    prefix.className = 'prefix';
    prefix.textContent = TOAST_PREFIX + ': ';
    const body = d.createElement('span');
    body.className = 'body';
    body.textContent = String(message || '');
    head.appendChild(mark);
    head.appendChild(text);
    el.appendChild(head);

    let detailEl = null;
    let segsEl = null;
    let coachEls = [];
    let actionsEl = null;
    let formEl = null;
    let progress = null;
    let hasMark = false;

    // The text column, always in this order.
    function layoutText() {
      text.textContent = '';
      text.appendChild(prefix);
      text.appendChild(body);
      if (segsEl) text.appendChild(segsEl);
      if (detailEl) text.appendChild(detailEl);
      coachEls.forEach(c => text.appendChild(c));
    }

    function paintMark() {
      mark.textContent = '';
      let icon = null;
      if (progress && variant === 'success') {
        icon = buildIcon(d, 'lock', 'lock ' + progress.lock + (progress.glow ? ' glow' : ''));
      } else {
        icon = buildIcon(d, variant === 'success' ? 'check' : variant);
      }
      hasMark = !!icon;
      if (icon) mark.appendChild(icon);
      el.className = 'toast ' + variant + (hasMark ? ' has-mark' : '') +
        (el.__shown ? ' show' : '') + (el.__closable ? ' has-close' : '');
      if (!hasMark && mark.parentNode) mark.parentNode.removeChild(mark);
      else if (hasMark && !mark.parentNode) head.insertBefore ? head.insertBefore(mark, text) : head.appendChild(mark);
    }

    function buildSegments(p) {
      const wrap = d.createElement('div');
      wrap.className = 'segs';
      wrap.setAttribute('role', 'progressbar');
      wrap.setAttribute('aria-valuemin', '0');
      wrap.setAttribute('aria-valuemax', String(p.goal));
      wrap.setAttribute('aria-valuenow', String(Math.min(p.count, p.goal)));
      wrap.setAttribute('aria-label', p.count + ' of ' + p.goal + ' today');
      for (let i = 0; i < p.segments; i++) {
        const seg = d.createElement('span');
        const on = i < p.filled;
        seg.className = 'seg' + (on ? ' on' : '') + (on && i >= p.prevFilled ? ' new' : '');
        wrap.appendChild(seg);
      }
      return wrap;
    }

    let dismissed = false;
    let timer = null;
    let sticky = !!options.sticky;
    let hovering = false;
    let duration = options.durationMs || TOAST_DURATION_MS;

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (timer) clearTimeout(timer);
      el.classList.remove('show');
      if (el.parentNode) el.parentNode.removeChild(el);
    };

    // One-shot timers only, re-armed when the pointer leaves.
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (dismissed || sticky || hovering) return;
      timer = setTimeout(dismiss, duration);
    };

    const api = {
      element: el,
      dismiss,
      isDismissed: () => dismissed,
      // Coach lines belong to the message they came with, so a new message
      // drops them. The bar stays unless opts.progress is null.
      update(nextMessage, nextDetail, opts = {}) {
        if (dismissed) return api;
        body.textContent = String(nextMessage || '');
        api.setCoach(null);
        if (opts.progress !== undefined) api.setProgress(opts.progress);
        api.setDetail(nextDetail);
        if (opts.variant) {
          variant = opts.variant === 'info' || opts.variant === 'warn' ? opts.variant : 'success';
          paintMark();
        }
        if (opts.sticky !== undefined) sticky = !!opts.sticky;
        if (opts.durationMs) duration = opts.durationMs;
        arm();
        return api;
      },
      setDetail(value) {
        if (!value) {
          detailEl = null;
        } else {
          if (!detailEl) {
            detailEl = d.createElement('span');
            detailEl.className = 'detail';
          }
          detailEl.textContent = String(value);
        }
        layoutText();
        return api;
      },
      setProgress(p) {
        progress = p && p.segments ? p : null;
        segsEl = progress ? buildSegments(progress) : null;
        layoutText();
        paintMark();
        return api;
      },
      setCoach(lines) {
        coachEls = (Array.isArray(lines) ? lines : []).filter(Boolean).slice(0, 2).map(line => {
          const c = d.createElement('span');
          c.className = 'coach';
          c.textContent = String(line);
          return c;
        });
        layoutText();
        return api;
      },
      setActions(list) {
        if (actionsEl && actionsEl.parentNode) actionsEl.parentNode.removeChild(actionsEl);
        actionsEl = null;
        if (!Array.isArray(list) || !list.length) return api;
        actionsEl = d.createElement('div');
        actionsEl.className = 'actions';
        list.forEach(action => {
          const btn = d.createElement('button');
          btn.setAttribute('type', 'button');
          btn.className = action.primary ? 'primary' : '';
          btn.textContent = String(action.label || '');
          btn.addEventListener('click', event => {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
            try { action.onClick && action.onClick(api); } catch (e) { /* an action must not break the page */ }
          });
          actionsEl.appendChild(btn);
        });
        if (formEl && formEl.parentNode === el && el.insertBefore) el.insertBefore(actionsEl, formEl);
        else el.appendChild(actionsEl);
        return api;
      },
      // spec: { fields: [{ name, label, value, placeholder }], submitLabel,
      //         onSubmit(values) -> Promise, onCancel() }
      showForm(spec) {
        if (formEl && formEl.parentNode) formEl.parentNode.removeChild(formEl);
        api.setActions(null);
        sticky = true;
        arm();
        formEl = d.createElement('form');
        const inputs = {};
        (spec.fields || []).forEach(f => {
          const label = d.createElement('label');
          const caption = d.createElement('span');
          caption.textContent = f.label;
          const input = d.createElement('input');
          input.setAttribute('type', 'text');
          input.setAttribute('name', f.name);
          input.setAttribute('autocomplete', 'off');
          input.setAttribute('spellcheck', 'false');
          if (f.placeholder) input.setAttribute('placeholder', f.placeholder);
          input.value = f.value || '';
          inputs[f.name] = input;
          label.appendChild(caption);
          label.appendChild(input);
          formEl.appendChild(label);
        });
        const row = d.createElement('div');
        row.className = 'actions';
        const save = d.createElement('button');
        save.setAttribute('type', 'submit');
        save.className = 'primary';
        save.textContent = spec.submitLabel || 'Save';
        const cancel = d.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.textContent = 'Cancel';
        row.appendChild(save);
        row.appendChild(cancel);
        formEl.appendChild(row);
        formEl.addEventListener('submit', event => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          const values = {};
          Object.keys(inputs).forEach(k => { values[k] = String(inputs[k].value || '').trim(); });
          Promise.resolve(spec.onSubmit ? spec.onSubmit(values, api) : null).catch(() => {});
        });
        // Keep keystrokes inside the toast: some pages bind global shortcuts.
        formEl.addEventListener('keydown', event => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          if (event && event.key === 'Escape') cancel.click();
        });
        cancel.addEventListener('click', () => {
          api.closeForm();
          if (spec.onCancel) spec.onCancel(api);
        });
        el.appendChild(formEl);
        const first = inputs[(spec.fields || [])[0] && spec.fields[0].name];
        if (first && typeof first.focus === 'function') setTimeout(() => { try { first.focus(); } catch (e) { /* detached */ } }, 30);
        return inputs;
      },
      closeForm() {
        if (formEl && formEl.parentNode) formEl.parentNode.removeChild(formEl);
        formEl = null;
        return api;
      },
      submitForm(values) {
        if (!formEl) return false;
        Object.keys(values || {}).forEach(k => {
          const input = formEl.querySelector('input[name="' + k + '"]');
          if (input) input.value = values[k];
        });
        if (typeof formEl.requestSubmit === 'function') {
          formEl.requestSubmit();
        } else {
          formEl.dispatchEvent({ type: 'submit', target: formEl, preventDefault() {} });
        }
        return true;
      }
    };

    progress = options.progress && options.progress.segments ? options.progress : null;
    if (progress) segsEl = buildSegments(progress);
    if (options.detail) {
      detailEl = d.createElement('span');
      detailEl.className = 'detail';
      detailEl.textContent = String(options.detail);
    }
    if (options.coach) api.setCoach(options.coach);
    layoutText();
    paintMark();
    root.stack.appendChild(el);
    if (options.actions) api.setActions(options.actions);
    if (sticky) {
      const close = d.createElement('button');
      close.setAttribute('type', 'button');
      close.className = 'close';
      close.setAttribute('aria-label', 'Dismiss');
      close.textContent = '×';
      close.addEventListener('click', () => {
        dismiss();
        if (typeof options.onClose === 'function') options.onClose();
      });
      el.appendChild(close);
      el.__closable = true;
      el.classList.add('has-close');
    }
    el.addEventListener('mouseenter', () => { hovering = true; arm(); });
    el.addEventListener('mouseleave', () => { hovering = false; arm(); });

    // rAF gives the transition a frame to start from.
    const reveal = () => { el.__shown = true; el.classList.add('show'); };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(reveal);
    } else {
      reveal();
    }
    arm();
    return api;
  }

  function formatLoggedMessage(payload) {
    const title = payload && payload.title ? String(payload.title).trim() : '';
    const count = payload && payload.count ? parseInt(payload.count, 10) || 1 : 1;
    return `Logged ${title || payload.id || 'activity'} (+${count})`;
  }

  // "Logged application at Acme — Engineer"
  function formatJobMessage(company, role, verb) {
    const c = String(company || '').trim();
    const r = String(role || '').trim();
    const lead = (verb || 'Logged') + ' application';
    if (c && r) return lead + ' at ' + c + ' — ' + r;
    if (c) return lead + ' at ' + c;
    if (r) return lead + ' — ' + r;
    return lead;
  }

  // "Acme — Engineer", "Acme", "Engineer", or ''.
  function formatJobSubject(company, role) {
    const c = String(company || '').trim();
    const r = String(role || '').trim();
    if (c && r) return c + ' — ' + r;
    return c || r;
  }

  // "earlier today", "yesterday", "24 days ago"
  function formatDaysAgo(days) {
    const n = Math.max(0, parseInt(days, 10) || 0);
    if (n === 0) return 'earlier today';
    if (n === 1) return 'yesterday';
    return n + ' days ago';
  }

  function formatShortDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!m) return String(dateStr || '');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return MONTHS[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
  }

  // "Heads up: you applied to Acme 24 days ago on Sep 6, 2026. Log it again anyway?"
  function formatDuplicateMessage(prior, company) {
    const name = (prior && prior.log && prior.log.company) || company || 'this company';
    const when = formatDaysAgo(prior && prior.daysAgo) + ' on ' + formatShortDate(prior && prior.log && prior.log.date);
    const lead = prior && prior.sameListing
      ? 'Heads up: you already logged this ' + name + ' listing ' + when + '.'
      : 'Heads up: you applied to ' + name + ' ' + when + '.';
    return lead + ' Log it again anyway?';
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
    const metricId = payload.metricId || adapter.metricId;
    // A job entry's name is its company and role fields; repeating them in
    // the notes only makes the entry longer.
    const notes = payload.notes
      ? String(payload.notes)
      : (metricId === 'jobs' ? source : [source, payload.title, detail].filter(Boolean).join(' | '));
    const log = {
      metricId,
      count: Math.max(1, parseInt(payload.count, 10) || 1),
      company: String(payload.company || '').trim().slice(0, 80),
      role: String(payload.role || '').trim().slice(0, 100),
      notes,
      source: 'auto',
      sourceId: (adapter.dedupeScope || adapter.id) + ':' + slugify(payload.id)
    };
    if (payload.url) log.url = String(payload.url);
    return log;
  }

  // One stats read and one prefs read per log, capped so a slow service
  // worker never holds the toast back: past the cap the plain toast shows.
  async function loadToastProgress(storage, metricId, logCount) {
    if (!storage || typeof storage.getStats !== 'function') return null;
    const read = Promise.all([
      Promise.resolve().then(() => storage.getStats()),
      typeof storage.getPrefs === 'function' ? Promise.resolve().then(() => storage.getPrefs()).catch(() => null) : null
    ]).catch(() => null);
    let timer = null;
    const cap = new Promise(resolve => { timer = setTimeout(() => resolve(null), TOAST_STATS_TIMEOUT_MS); });
    let result = null;
    try {
      result = await Promise.race([read, cap]);
    } catch (e) {
      result = null;
    } finally {
      clearTimeout(timer);
    }
    if (!result) return null;
    try {
      return buildToastProgress({ stats: result[0], prefs: result[1], metricId, logCount });
    } catch (e) {
      return null;
    }
  }

  // Serializes dispatches so two adapters (or two rapid mutations) cannot race
  // past the dedupe check together.
  let dispatchChain = Promise.resolve();

  // The toast for a logged application: today's progress when it is known,
  // what was logged, Edit details (company and role, in place) and Undo.
  function showJobToast(log, payload, key, ctx) {
    const { storage, cache, document: doc, progress } = ctx;
    let current = { company: log.company, role: log.role };
    const host = payload.url ? safeHost(payload.url) : '';
    const subjectLine = () => formatJobSubject(current.company, current.role) || (host ? 'Tracked from ' + host : '');
    const toast = progress
      ? showToast(progress.title, {
        document: doc,
        durationMs: JOB_TOAST_DURATION_MS,
        progress,
        detail: subjectLine(),
        coach: progress.coach,
        actions: [
          { label: 'Edit details', onClick: t => openEdit(t) },
          { label: 'Undo', onClick: t => undo(t) }
        ]
      })
      : showToast(formatJobMessage(current.company, current.role), {
        document: doc,
        durationMs: JOB_TOAST_DURATION_MS,
        detail: host ? 'Tracked from ' + host : '',
        actions: [
          { label: 'Edit details', onClick: t => openEdit(t) },
          { label: 'Undo', onClick: t => undo(t) }
        ]
      });
    if (!toast) return null;
    if (progress) applyAccent(getToastRoot(doc), progress.accent);

    function openEdit(t) {
      t.showForm({
        fields: [
          { name: 'company', label: 'Company', value: current.company, placeholder: 'Company' },
          { name: 'role', label: 'Role', value: current.role, placeholder: 'Role' }
        ],
        submitLabel: 'Save',
        onSubmit: async values => {
          let updated = null;
          try {
            updated = typeof storage.updateLog === 'function' ? await storage.updateLog(log.id, values) : null;
          } catch (e) {
            updated = null;
          }
          t.closeForm();
          if (!updated) {
            t.update("Couldn't save those details. You can fix them from the LIT popup.", '', { variant: 'warn', sticky: false, durationMs: 5000 });
            return;
          }
          current = { company: updated.company, role: updated.role };
          t.update(formatJobMessage(current.company, current.role, 'Updated'), '', { sticky: false, durationMs: 3500 });
          t.setActions([{ label: 'Undo', onClick: x => undo(x) }]);
        },
        onCancel: x => {
          if (progress) {
            x.update(progress.title, subjectLine(), { sticky: false });
            x.setCoach(progress.coach);
          } else {
            x.update(formatJobMessage(current.company, current.role), '', { sticky: false });
          }
          x.setActions([
            { label: 'Edit details', onClick: y => openEdit(y) },
            { label: 'Undo', onClick: y => undo(y) }
          ]);
        }
      });
    }

    async function undo(t) {
      t.setActions(null);
      t.closeForm();
      let removed = false;
      try {
        removed = typeof storage.deleteLog === 'function' ? await storage.deleteLog(log.id) : false;
      } catch (e) {
        removed = false;
      }
      if (removed) {
        // Released so the same application can be logged again later.
        try { await cache.unmark(key); } catch (e) { /* the log is gone either way */ }
        t.update(formatJobMessage(current.company, current.role, 'Removed'), '', { variant: 'info', sticky: false, durationMs: 3000, progress: null });
      } else {
        t.update('That one was already removed.', '', { variant: 'info', sticky: false, durationMs: 3000, progress: null });
      }
    }

    return toast;
  }

  // A solved problem or other non-job activity.
  function showActivityToast(payload, progress, doc) {
    if (!progress) return showToast(formatLoggedMessage(payload), { document: doc });
    const title = payload && payload.title ? String(payload.title).trim() : '';
    const t = showToast(progress.title, {
      document: doc,
      progress,
      detail: title,
      coach: progress.coach
    });
    if (t) applyAccent(getToastRoot(doc), progress.accent);
    return t;
  }

  function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  // Result: { logged, reason?, key, log? }. reason is 'duplicate' (the same
  // activity was already logged: today for a solved problem, in the last ten
  // minutes for a job application), 'hidden' (that goal is hidden from the
  // board), 'write-failed', 'no-storage', or 'invalid'.
  function dispatch(adapter, payload, options = {}) {
    const run = async () => {
      if (!adapter || !payload || !payload.id) return { logged: false, reason: 'invalid' };
      const storage = options.storage || (typeof TrackerStorage !== 'undefined' ? TrackerStorage : null);
      if (!storage || typeof storage.addLog !== 'function') return { logged: false, reason: 'no-storage' };

      const entry = buildLog(adapter, payload);
      // A goal the person hid from their board stops auto-logging. What was
      // already logged stays; showing the goal again resumes it.
      if (typeof storage.getMetrics === 'function') {
        try {
          const list = await storage.getMetrics();
          const target = Array.isArray(list) ? list.find(m => m && m.id === entry.metricId) : null;
          if (target && target.hidden === true) return { logged: false, reason: 'hidden' };
        } catch (e) { /* unknown visibility: log as before */ }
      }
      const isJob = entry.metricId === 'jobs';
      const windowMs = isJob ? JOB_DEDUPE_WINDOW_MS : 0;
      const cache = options.cache || getDedupeCache();
      const key = buildDedupeKey(adapter.dedupeScope || adapter.id, payload.id, payload.date);
      if (await cache.has(key, windowMs)) return { logged: false, reason: 'duplicate', key };

      // Claim the key before writing: mark() re-reads storage, so a sibling
      // tab that claimed it a moment ago wins. A failed write releases the
      // claim so the activity stays retryable.
      if (!(await cache.mark(key, windowMs))) return { logged: false, reason: 'duplicate', key };

      let log;
      try {
        log = await storage.addLog(entry);
      } catch (e) {
        await cache.unmark(key);
        return { logged: false, reason: 'write-failed', key };
      }
      let toast = null;
      if (options.toast !== false) {
        // A log dated another day says nothing about today's progress.
        const today = !payload.date || payload.date === localDateStr();
        const progress = today ? await loadToastProgress(storage, entry.metricId, entry.count) : null;
        toast = isJob
          ? showJobToast(log, payload, key, { storage, cache, document: options.document, progress })
          : showActivityToast(payload, progress, options.document);
      }
      return { logged: true, key, log, toast };
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
    JOB_DEDUPE_WINDOW_MS,

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
    formatJobMessage,
    formatJobSubject,
    formatDuplicateMessage,
    formatDaysAgo,
    buildToastProgress,
    segmentsFor,
    unitNoun,
    toastPlacement,
    ACCENTS,
    MAX_SEGMENTS,

    dispatch,
    buildLog,

    sessionGet,
    sessionSet,

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
    _resetSharedCache() { sharedCache = null; toastRoot = null; kvArea = undefined; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoTrackerCore;
}
