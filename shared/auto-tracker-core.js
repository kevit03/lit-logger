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
//   dispatch   Turns an ActivityPayload into TrackerStorage.addLog(). Job
//              entries are checked against the last 90 days first; a likely
//              repeat asks "Log again anyway?" instead of logging.
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
      font-family: "Google Sans", Inter, Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .toast {
      pointer-events: auto;
      box-sizing: border-box;
      width: max-content;
      max-width: 380px;
      min-width: 220px;
      padding: 11px 14px 11px 16px;
      border-radius: 12px;
      background: rgba(24, 25, 28, 0.94);
      color: #ecedee;
      font-size: 13px;
      line-height: 1.45;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);
      position: relative;
      overflow: hidden;
      opacity: 0;
      transform: translateY(8px) scale(0.98);
      transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 320ms cubic-bezier(0.16, 1, 0.3, 1);
      -webkit-backdrop-filter: blur(12px);
      backdrop-filter: blur(12px);
    }
    .toast::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      background: #34a853;
    }
    .toast.show { opacity: 1; transform: translateY(0) scale(1); }
    .toast.info::before { background: #8ab4f8; }
    .toast.warn::before { background: #fbbc04; }
    .prefix { font-weight: 600; margin-right: 4px; color: #ffffff; }
    .body { word-break: break-word; }
    .detail { display: block; margin-top: 2px; font-size: 12px; color: #a9adb3; }
    .actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font: 600 12px/1 inherit;
      font-family: inherit;
      padding: 7px 10px;
      border-radius: 8px;
      color: #ecedee;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: background 160ms cubic-bezier(0.16, 1, 0.3, 1), transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    button:hover { background: rgba(255, 255, 255, 0.14); }
    button:active { transform: scale(0.97); }
    button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    button.primary { background: #8ab4f8; color: #111316; border-color: transparent; }
    button.primary:hover { background: #aecbfa; }
    button.close {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 22px;
      height: 22px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border-color: transparent;
      color: #a9adb3;
      font-size: 15px;
    }
    button.close:hover { background: rgba(255, 255, 255, 0.1); color: #ffffff; }
    .toast.has-close { padding-right: 32px; }
    form { display: flex; flex-direction: column; gap: 6px; margin-top: 9px; }
    label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #a9adb3; font-weight: 600; letter-spacing: 0.2px; }
    input {
      all: unset;
      box-sizing: border-box;
      font: 13px/1.3 inherit;
      font-family: inherit;
      color: #ecedee;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      padding: 7px 9px;
      width: 100%;
      transition: border-color 160ms ease;
    }
    input:focus { border-color: #8ab4f8; }
    .note { margin-top: 8px; font-size: 12px; color: #fdd663; }
    @media (prefers-reduced-motion: reduce) {
      .toast, button { transition: none; }
    }
  `;

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

  // showToast(message, {
  //   variant: 'success' | 'info' | 'warn',
  //   detail: string,                          second, quieter line
  //   actions: [{ label, primary, onClick(toast) }],
  //   sticky: true,                            stays until dismissed (adds a close button)
  //   durationMs, document
  // })
  // Returns { element, dismiss, update(message, detail), setActions(list),
  // showForm(spec), isDismissed() }.
  function showToast(message, options = {}) {
    const root = getToastRoot(options.document);
    if (!root) return null;
    const d = root.doc;
    const variant = options.variant === 'info' || options.variant === 'warn' ? options.variant : 'success';
    const el = d.createElement('div');
    el.className = 'toast ' + variant;
    el.setAttribute('role', options.actions || options.sticky ? 'alertdialog' : 'status');
    el.setAttribute('aria-live', 'polite');
    const prefix = d.createElement('span');
    prefix.className = 'prefix';
    prefix.textContent = TOAST_PREFIX + ':';
    const body = d.createElement('span');
    body.className = 'body';
    body.textContent = String(message || '');
    el.appendChild(prefix);
    el.appendChild(body);
    let detailEl = null;
    let actionsEl = null;
    let formEl = null;
    root.stack.appendChild(el);

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
      update(nextMessage, nextDetail, opts = {}) {
        if (dismissed) return api;
        body.textContent = String(nextMessage || '');
        api.setDetail(nextDetail);
        if (opts.variant) el.className = 'toast ' + opts.variant + (el.classList.contains('show') ? ' show' : '') + (el.classList.contains('has-close') ? ' has-close' : '');
        if (opts.sticky !== undefined) sticky = !!opts.sticky;
        if (opts.durationMs) duration = opts.durationMs;
        arm();
        return api;
      },
      setDetail(text) {
        if (!text) {
          if (detailEl && detailEl.parentNode) detailEl.parentNode.removeChild(detailEl);
          detailEl = null;
          return api;
        }
        if (!detailEl) {
          detailEl = d.createElement('span');
          detailEl.className = 'detail';
          el.insertBefore ? el.insertBefore(detailEl, actionsEl || formEl || null) : el.appendChild(detailEl);
        }
        detailEl.textContent = String(text);
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
        el.appendChild(actionsEl);
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

    if (options.detail) api.setDetail(options.detail);
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
      el.classList.add('has-close');
    }
    el.addEventListener('mouseenter', () => { hovering = true; arm(); });
    el.addEventListener('mouseleave', () => { hovering = false; arm(); });

    // rAF gives the transition a frame to start from.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => el.classList.add('show'));
    } else {
      el.classList.add('show');
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

  // "Note: You applied to Acme 24 days ago on Sep 6, 2026. Log again anyway?"
  function formatDuplicateMessage(prior, company) {
    const name = (prior && prior.log && prior.log.company) || company || 'this company';
    const when = formatDaysAgo(prior && prior.daysAgo) + ' on ' + formatShortDate(prior && prior.log && prior.log.date);
    const lead = prior && prior.sameListing
      ? 'Note: You already logged this ' + name + ' listing ' + when + '.'
      : 'Note: You applied to ' + name + ' ' + when + '.';
    return lead + ' Log again anyway?';
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
    const log = {
      metricId: payload.metricId || adapter.metricId,
      count: Math.max(1, parseInt(payload.count, 10) || 1),
      company: payload.company || '',
      role: payload.role || '',
      notes,
      source: 'auto',
      sourceId: (adapter.dedupeScope || adapter.id) + ':' + slugify(payload.id)
    };
    if (payload.url) log.url = String(payload.url);
    return log;
  }

  // Serializes dispatches so two adapters (or two rapid mutations) cannot race
  // past the dedupe check together.
  let dispatchChain = Promise.resolve();

  // The toast for a logged application: Edit details (company and role, in
  // place) and Undo.
  function showJobToast(log, payload, key, ctx) {
    const { storage, cache, document: doc } = ctx;
    let current = { company: log.company, role: log.role };
    const toast = showToast(formatJobMessage(current.company, current.role), {
      document: doc,
      durationMs: JOB_TOAST_DURATION_MS,
      detail: payload.url ? 'Tracked from ' + safeHost(payload.url) : '',
      actions: [
        { label: 'Edit details', onClick: t => openEdit(t) },
        { label: 'Undo', onClick: t => undo(t) }
      ]
    });
    if (!toast) return null;

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
            t.update('Could not save those details. Edit the entry from the LIT popup.', '', { variant: 'warn', sticky: false, durationMs: 5000 });
            return;
          }
          current = { company: updated.company, role: updated.role };
          t.update(formatJobMessage(current.company, current.role, 'Updated'), '', { sticky: false, durationMs: 3500 });
          t.setActions([{ label: 'Undo', onClick: x => undo(x) }]);
        },
        onCancel: x => {
          x.update(formatJobMessage(current.company, current.role), '', { sticky: false });
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
        t.update(formatJobMessage(current.company, current.role, 'Removed'), '', { variant: 'info', sticky: false, durationMs: 3000 });
      } else {
        t.update('That entry was already removed.', '', { variant: 'info', sticky: false, durationMs: 3000 });
      }
    }

    return toast;
  }

  function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
  }

  // Result: { logged, reason?, key, log?, prior? }. reason is 'duplicate'
  // (already logged today), 'possible-duplicate' (logged within 90 days;
  // the user is asked), 'write-failed', 'no-storage', or 'invalid'.
  function dispatch(adapter, payload, options = {}) {
    const run = async () => {
      if (!adapter || !payload || !payload.id) return { logged: false, reason: 'invalid' };
      const storage = options.storage || (typeof TrackerStorage !== 'undefined' ? TrackerStorage : null);
      if (!storage || typeof storage.addLog !== 'function') return { logged: false, reason: 'no-storage' };

      const cache = options.cache || getDedupeCache();
      const key = buildDedupeKey(adapter.dedupeScope || adapter.id, payload.id, payload.date);
      if (await cache.has(key)) return { logged: false, reason: 'duplicate', key };

      const entry = buildLog(adapter, payload);
      const isJob = entry.metricId === 'jobs';
      if (isJob && !options.skipDuplicateCheck && typeof storage.findRecentApplication === 'function') {
        let prior = null;
        try {
          prior = await storage.findRecentApplication({ company: entry.company, sourceId: entry.sourceId, url: entry.url });
        } catch (e) {
          prior = null;
        }
        if (prior) {
          if (options.toast !== false) {
            showToast(formatDuplicateMessage(prior, entry.company), {
              document: options.document,
              variant: 'warn',
              sticky: true,
              detail: formatJobMessage(entry.company, entry.role, 'Detected'),
              actions: [
                {
                  label: 'Log anyway',
                  primary: true,
                  onClick: t => {
                    t.dismiss();
                    dispatch(adapter, payload, Object.assign({}, options, { skipDuplicateCheck: true })).catch(() => {});
                  }
                },
                { label: 'Skip', onClick: t => t.dismiss() }
              ]
            });
          }
          return { logged: false, reason: 'possible-duplicate', key, prior };
        }
      }

      // Claim the key before writing: mark() re-reads storage, so a sibling
      // tab that claimed it a moment ago wins. A failed write releases the
      // claim so the activity stays retryable.
      if (!(await cache.mark(key))) return { logged: false, reason: 'duplicate', key };

      let log;
      try {
        log = await storage.addLog(entry);
      } catch (e) {
        await cache.unmark(key);
        return { logged: false, reason: 'write-failed', key };
      }
      let toast = null;
      if (options.toast !== false) {
        toast = isJob
          ? showJobToast(log, payload, key, { storage, cache, document: options.document })
          : showToast(formatLoggedMessage(payload), { document: options.document });
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
    formatDuplicateMessage,
    formatDaysAgo,

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
