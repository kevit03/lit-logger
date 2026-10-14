// In-page Autofill: the floating "Autofill" button and the learning loop.
//
// Loads after shared/autofill-store.js, shared/autofill-core.js, and the site
// adapters. In each frame that holds at least MIN_FIELDS fillable fields (and
// while settings.showButton is on) it shows a small button, bottom right,
// inside a closed shadow root so page CSS cannot reach it. Alt+Shift+F does
// the same as a click.
//
// A click loads everything from AutofillStore, hands it to AutofillCore.run,
// outlines filled fields green and the ones that still need the user amber,
// and reports "Filled 14 fields, 3 need you." Outlines clear on focus.
//
// Learning (settings.autoLearn): after a run, edits to every field on the
// form are watched through one document-level listener per event type: text
// boxes, selects, radios, checkboxes, and custom dropdowns and button groups
// (react-select, Workday listboxes, Ashby yes/no). Custom widgets never fire
// `change`, so clicks and keys also trigger a re-read of every tracked field.
// Fields the run left alone (already filled, or rendered later by a
// multi-step form) are tracked too, without an outline.
//   - A missed short field filled with a profile value learns label -> key.
//   - Any other value asks "Remember this for '<label>'?" and saves a literal.
//   - Overwriting a filled field with another profile value moves the rule.
//   - A textarea left with 40+ characters offers "Save to answer bank?".
// Nothing is ever learned from password, card, or SSN-like fields, and
// nothing on the page is ever clicked.
//
// This file is a bare IIFE with no top-level bindings so a second injection
// into the same isolated world (the universal path can re-inject) is not a
// redeclaration error; the running copy is kept and just re-checks.
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const existing = window.__litAutofillUI;
  if (existing) {
    try { existing.check(); } catch (e) { /* the old copy is going away */ }
    if (typeof module !== 'undefined' && module.exports) module.exports = existing;
    return;
  }
  if (typeof AutofillStore === 'undefined' || !AutofillStore) return;
  if (typeof AutofillCore === 'undefined' || !AutofillCore) return;
  const store = AutofillStore;
  const core = AutofillCore;

  const HOST_ID = 'lit-autofill-host';
  const HOST_TAG = 'lit-autofill';
  const MIN_FIELDS = 3;
  const CHECK_DELAY_MS = 300;
  const RESULT_TOAST_MS = 8000;
  const NOTE_TOAST_MS = 4000;
  const PROMPT_MS = 20000;
  const ANSWER_MIN_CHARS = 40;
  const FILLED_CLASS = 'lit-af-filled';
  const UNMATCHED_CLASS = 'lit-af-unmatched';
  const OUTLINE_COLORS = { [FILLED_CLASS]: '#34a853', [UNMATCHED_CLASS]: '#f9ab00' };
  const DEFAULT_SETTINGS = { showButton: true, fillEeo: false, autoLearn: true };

  const SENSITIVE = /password|ssn|social security|card|cvv|iban|routing/i;
  const FILLABLE_SELECTOR = 'input, textarea, select, [role="combobox"], [aria-haspopup="listbox"]';
  const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password']);
  const LEARNABLE_KINDS = new Set(['text', 'email', 'tel', 'url', 'textarea', 'select', 'radio', 'checkbox', 'combobox']);
  const TYPED_KINDS = new Set(['text', 'email', 'tel', 'url', 'textarea']);
  // Re-reads after a click or key: once for instant widgets, once more for
  // ones that commit after an animation or re-render (Workday).
  const SWEEP_DELAYS_MS = [250, 900];
  const URL_KEYS = new Set(['linkedin', 'github', 'portfolio', 'website']);

  // The host element can still be hit by page selectors such as `#id` or a
  // universal rule, so its own box is pinned inline with !important.
  const HOST_STYLE = 'all: initial !important; position: fixed !important; width: 0 !important; height: 0 !important; ' +
    'right: 0 !important; bottom: 0 !important; z-index: 2147483646 !important; display: block !important;';

  const UI_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483646;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      pointer-events: none;
      font-family: "Google Sans", Inter, Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .stack { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font-family: inherit;
      font-weight: 600;
      font-size: 12px;
      line-height: 1;
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
    .fab {
      pointer-events: auto;
      font-size: 13px;
      padding: 10px 16px;
      border-radius: 999px;
      background: rgba(24, 25, 28, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.2);
    }
    .fab::before {
      content: "";
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 8px;
      border-radius: 50%;
      background: #8ab4f8;
      vertical-align: 1px;
    }
    .fab:hover { background: rgba(40, 42, 46, 0.96); }
    .fab.busy { opacity: 0.7; cursor: progress; }
    .hidden { display: none !important; }
    .card {
      pointer-events: auto;
      box-sizing: border-box;
      max-width: 340px;
      min-width: 200px;
      padding: 11px 14px 11px 16px;
      border-radius: 12px;
      background: rgba(24, 25, 28, 0.96);
      color: #ecedee;
      font-size: 13px;
      line-height: 1.45;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      background: #8ab4f8;
    }
    .card.success::before { background: #34a853; }
    .card.warn::before { background: #fbbc04; }
    .body { word-break: break-word; }
    .actions { display: flex; gap: 6px; margin-top: 9px; flex-wrap: wrap; }
    .prompt { position: fixed; z-index: 2147483647; font-family: inherit; }
    .prompt.docked { right: 16px; bottom: 64px; }
    @media (prefers-reduced-motion: reduce) {
      button { transition: none; }
    }
  `;

  // --- state ---------------------------------------------------------------
  let started = false;
  let observer = null;
  let checkTimer = null;
  let settings = null;
  let settingsSeq = 0;
  let storeUnsub = null;
  let storeSubscribedForever = false;
  let eligible = false;
  let running = false;
  let hasRun = false;
  let lastProfile = null;
  let ui = null;          // { host, shadow, wrap, stack, fab }
  let toast = null;       // { el, timer }
  let prompt = null;      // { el, timer, entry }
  let byEl = new Map();   // field element -> entry
  let byGroup = new Map();// radio/checkbox group container -> entry
  let outlined = new Set();
  let sweepTimers = [];
  let inlineOutlines = new Map();

  // --- small helpers ---------------------------------------------------------
  function alive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  function hostName() {
    try {
      return String(location.hostname || '').toLowerCase();
    } catch (e) {
      return '';
    }
  }

  function norm(s) {
    return String(s === undefined || s === null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function localNormalizeLabel(text) {
    return norm(text)
      .replace(/\(optional\)/g, ' ')
      .replace(/\brequired\b/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function labelKeyOf(desc) {
    if (desc.labelKey) return desc.labelKey;
    try {
      if (typeof core.normalizeLabel === 'function') return core.normalizeLabel(desc.label || '') || '';
    } catch (e) { /* fall through */ }
    return localNormalizeLabel(desc.label || '');
  }

  function shortLabel(desc) {
    const text = String(desc.label || desc.labelKey || desc.name || 'this field').replace(/\s+/g, ' ').trim();
    return text.length > 60 ? text.slice(0, 57).trim() + '...' : text;
  }

  function attr(el, name) {
    try {
      return el && typeof el.getAttribute === 'function' ? (el.getAttribute(name) || '') : '';
    } catch (e) {
      return '';
    }
  }

  function tagOf(el) {
    return el && el.tagName ? String(el.tagName).toLowerCase() : '';
  }

  function inputType(el) {
    return String(attr(el, 'type') || (typeof el.type === 'string' ? el.type : '') || 'text').toLowerCase();
  }

  function isDisabled(el) {
    return !!el.disabled || (typeof el.hasAttribute === 'function' && el.hasAttribute('disabled'));
  }

  function isVisible(el) {
    if (el.offsetWidth > 0 || el.offsetHeight > 0) return true;
    try {
      return typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    } catch (e) {
      return false;
    }
  }

  // --- fillable field count --------------------------------------------------
  function isCountable(el) {
    if (isDisabled(el)) return false;
    if (attr(el, 'aria-hidden') === 'true') return false;
    if (tagOf(el) === 'input') {
      const type = inputType(el);
      if (SKIP_INPUT_TYPES.has(type)) return false;
      // Resume inputs are usually visually hidden behind a styled button.
      if (type === 'file') return true;
    }
    return isVisible(el);
  }

  function countFillable(root) {
    let nodes;
    try {
      nodes = Array.from(root.querySelectorAll(FILLABLE_SELECTOR));
    } catch (e) {
      return 0;
    }
    const radioNames = new Set();
    let n = 0;
    for (const el of nodes) {
      if (!isCountable(el)) continue;
      if (tagOf(el) === 'input' && inputType(el) === 'radio') {
        const name = attr(el, 'name');
        if (name) {
          if (radioNames.has(name)) continue;
          radioNames.add(name);
        }
      }
      n++;
      if (n >= MIN_FIELDS) return n;
    }
    return n;
  }

  // --- shadow UI ---------------------------------------------------------------
  // Other job extensions (Jobright, Simplify) pin their panels at the maximum
  // z-index over the same corner. The top layer draws above any z-index, so
  // the host goes there when the browser supports popovers. HOST_STYLE's
  // `all: initial !important` overrides the popover UA styles.
  function raise(host) {
    try {
      if (typeof host.showPopover !== 'function') return;
      if (!host.hasAttribute('popover')) host.setAttribute('popover', 'manual');
      if (!host.matches(':popover-open')) host.showPopover();
    } catch (e) {
      // Not in a document yet, or no top layer here; z-index still applies.
    }
  }

  function attachHost(host) {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    raise(host);
  }

  function ensureUi() {
    if (ui) {
      attachHost(ui.host);
      return ui;
    }
    // A host left by an orphaned copy (extension reloaded under the page)
    // lives in a closed root we cannot reach; replace it.
    const stale = document.getElementById(HOST_ID);
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    const host = document.createElement(HOST_TAG);
    host.id = HOST_ID;
    host.setAttribute('style', HOST_STYLE);
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const stack = document.createElement('div');
    stack.className = 'stack';
    const fab = document.createElement('button');
    fab.className = 'fab hidden';
    fab.setAttribute('type', 'button');
    fab.setAttribute('title', 'Autofill this form (Alt+Shift+F)');
    fab.setAttribute('aria-label', 'Autofill this form');
    fab.textContent = 'Autofill';
    fab.addEventListener('click', event => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      fill();
    });
    wrap.appendChild(stack);
    wrap.appendChild(fab);
    shadow.appendChild(wrap);
    attachHost(host);
    ui = { host, shadow, wrap, stack, fab };
    return ui;
  }

  function setFabVisible(show) {
    if (!ui) return;
    ui.fab.classList.toggle('hidden', !show);
  }

  function setFabBusy(busy) {
    if (!ui) return;
    ui.fab.classList.toggle('busy', !!busy);
    ui.fab.textContent = busy ? 'Filling...' : (hasRun ? 'Fill again' : 'Autofill');
  }

  function makeButtons(container, actions, close) {
    const row = document.createElement('div');
    row.className = 'actions';
    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.setAttribute('type', 'button');
      if (action.primary) btn.className = 'primary';
      btn.textContent = action.label;
      btn.addEventListener('click', event => {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
        close();
        if (typeof action.onClick === 'function') action.onClick();
      });
      row.appendChild(btn);
    });
    container.appendChild(row);
  }

  function closeToast() {
    if (!toast) return;
    clearTimeout(toast.timer);
    if (toast.el.parentNode) toast.el.parentNode.removeChild(toast.el);
    toast = null;
  }

  function showToast(text, options = {}) {
    const root = ensureUi();
    closeToast();
    const el = document.createElement('div');
    el.className = 'card toast ' + (options.variant || 'info');
    el.setAttribute('role', 'status');
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    el.appendChild(body);
    const current = { el, timer: null };
    const close = () => { if (toast === current) closeToast(); };
    if (options.actions && options.actions.length) makeButtons(el, options.actions, close);
    root.stack.appendChild(el);
    current.timer = setTimeout(close, options.durationMs || NOTE_TOAST_MS);
    toast = current;
    return current;
  }

  function closePrompt() {
    if (!prompt) return;
    clearTimeout(prompt.timer);
    if (prompt.el.parentNode) prompt.el.parentNode.removeChild(prompt.el);
    prompt = null;
  }

  // A small card next to the field. One at a time: a new prompt replaces the
  // old one, and an unanswered prompt goes away by itself.
  function showPrompt(entry, text, actions) {
    const root = ensureUi();
    closePrompt();
    const el = document.createElement('div');
    el.className = 'card prompt';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'LIT Autofill');
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = text;
    el.appendChild(body);
    const current = { el, timer: null, entry };
    const close = () => { if (prompt === current) closePrompt(); };
    makeButtons(el, actions, close);

    let placed = false;
    try {
      const target = entry.desc.group || entry.desc.el;
      const r = target.getBoundingClientRect();
      if (r && (r.width > 0 || r.height > 0)) {
        const vw = window.innerWidth || 1024;
        const vh = window.innerHeight || 768;
        let top = r.bottom + 6;
        if (top > vh - 110) top = Math.max(8, r.top - 110);
        const left = Math.max(8, Math.min(r.left, vw - 348));
        el.setAttribute('style', 'top: ' + Math.round(top) + 'px; left: ' + Math.round(left) + 'px;');
        placed = true;
      }
    } catch (e) {
      placed = false;
    }
    if (!placed) el.classList.add('docked');
    root.shadow.appendChild(el);
    current.timer = setTimeout(close, PROMPT_MS);
    prompt = current;
    return current;
  }

  // --- outlines ----------------------------------------------------------------
  // The classes are styled by content/autofill/autofill-ui.css. Where that
  // stylesheet is not present (a frame reached by script injection only), the
  // same outline is set inline and restored on clear.
  function outline(target, cls) {
    if (!target || !target.classList) return;
    target.classList.remove(FILLED_CLASS, UNMATCHED_CLASS);
    target.classList.add(cls);
    outlined.add(target);
    if (typeof window.getComputedStyle !== 'function' || !target.style || typeof target.style.setProperty !== 'function') return;
    let cs = null;
    try { cs = window.getComputedStyle(target); } catch (e) { cs = null; }
    if (!cs || (cs.outlineStyle && cs.outlineStyle !== 'none')) return;
    if (!inlineOutlines.has(target)) {
      inlineOutlines.set(target, {
        outline: target.style.getPropertyValue('outline'),
        outlinePriority: target.style.getPropertyPriority('outline'),
        offset: target.style.getPropertyValue('outline-offset'),
        offsetPriority: target.style.getPropertyPriority('outline-offset')
      });
    }
    target.style.setProperty('outline', '2px solid ' + OUTLINE_COLORS[cls], 'important');
    target.style.setProperty('outline-offset', '1px', 'important');
  }

  function clearOutline(target) {
    if (!target || !outlined.has(target)) return;
    outlined.delete(target);
    try { target.classList.remove(FILLED_CLASS, UNMATCHED_CLASS); } catch (e) { /* detached */ }
    const prev = inlineOutlines.get(target);
    if (prev) {
      inlineOutlines.delete(target);
      try {
        if (prev.outline) target.style.setProperty('outline', prev.outline, prev.outlinePriority);
        else target.style.removeProperty('outline');
        if (prev.offset) target.style.setProperty('outline-offset', prev.offset, prev.offsetPriority);
        else target.style.removeProperty('outline-offset');
      } catch (e) { /* detached */ }
    }
  }

  function clearAllOutlines() {
    Array.from(outlined).forEach(clearOutline);
    outlined = new Set();
    inlineOutlines = new Map();
  }

  // --- tracking ------------------------------------------------------------------
  function resetTracking() {
    clearSweeps();
    closePrompt();
    clearAllOutlines();
    byEl = new Map();
    byGroup = new Map();
  }

  function track(desc, state, match, silent) {
    if (!desc || !desc.el) return;
    const target = desc.group || desc.el;
    if (!silent) outline(target, state === 'filled' ? FILLED_CLASS : UNMATCHED_CLASS);
    const value = readValue(desc);
    const entry = { desc, state, match: match || null, target, initial: value, value, offered: '' };
    byEl.set(desc.el, entry);
    (desc.inputs || []).forEach(i => byEl.set(i, entry));
    if (desc.group) byGroup.set(desc.group, entry);
  }

  function entryFor(node) {
    let n = node;
    let depth = 0;
    while (n && depth < 10) {
      const hit = byEl.get(n) || byGroup.get(n);
      if (hit) return hit;
      n = n.parentElement;
      depth++;
    }
    return null;
  }

  function optionLabel(input) {
    try {
      if (input.labels && input.labels[0]) return input.labels[0].textContent;
    } catch (e) { /* no labels API */ }
    const wrapping = typeof input.closest === 'function' ? input.closest('label') : null;
    if (wrapping) return wrapping.textContent;
    const id = attr(input, 'id');
    if (id && input.ownerDocument && typeof input.ownerDocument.querySelector === 'function') {
      try {
        const forLabel = input.ownerDocument.querySelector('label[for="' + id.replace(/"/g, '') + '"]');
        if (forLabel) return forLabel.textContent;
      } catch (e) { /* odd id */ }
    }
    return typeof input.value === 'string' ? input.value : attr(input, 'value');
  }

  function readValue(desc) {
    const el = desc.el;
    if (!el) return '';
    if (typeof core.currentValue === 'function') {
      try { return String(core.currentValue(desc) || '').replace(/\s+/g, ' ').trim(); } catch (e) { return ''; }
    }
    try {
      if (desc.kind === 'radio') {
        const root = desc.group || (tagOf(el) === 'input' ? (el.form || el.parentElement) : el) || document;
        const name = attr(el, 'name');
        const radios = Array.from(root.querySelectorAll('input[type="radio"]'))
          .filter(r => !name || attr(r, 'name') === name);
        if (tagOf(el) === 'input' && radios.indexOf(el) < 0) radios.push(el);
        const checked = radios.find(r => r.checked);
        return checked ? String(optionLabel(checked) || '').replace(/\s+/g, ' ').trim() : '';
      }
      if (desc.kind === 'checkbox') return el.checked ? 'yes' : '';
      if (tagOf(el) === 'select') {
        const opt = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        if (opt) {
          if (String(opt.value || '') === '') return '';
          return String(opt.text || opt.textContent || opt.value || '').replace(/\s+/g, ' ').trim();
        }
        return String(el.value || '').trim();
      }
      if (typeof el.value === 'string') return el.value.trim();
      return String(el.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (e) {
      return '';
    }
  }

  function isSensitive(desc) {
    const el = desc.el;
    if (el && tagOf(el) === 'input' && inputType(el) === 'password') return true;
    const autocomplete = String(desc.autocomplete || attr(el, 'autocomplete') || '');
    if (/(^|\s)cc-/i.test(autocomplete)) return true;
    const hay = [
      desc.label, desc.labelKey, desc.name, desc.id, desc.placeholder, autocomplete,
      attr(el, 'name'), attr(el, 'id'), attr(el, 'aria-label'), attr(el, 'placeholder')
    ].join(' ');
    return SENSITIVE.test(hay);
  }

  // --- profile value lookup ----------------------------------------------------
  function urlish(s) {
    return norm(s).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }

  function sameValue(value, profileValue, key) {
    const a = norm(value);
    const b = norm(profileValue);
    if (!a || !b) return false;
    if (a === b) return true;
    if (URL_KEYS.has(key) || /^https?:\/\//.test(a)) {
      if (urlish(a) && urlish(a) === urlish(b)) return true;
    }
    const phoneish = /^[\d\s()+.\-]+$/;
    if (phoneish.test(a) && phoneish.test(b)) {
      const da = a.replace(/\D/g, '');
      const db = b.replace(/\D/g, '');
      if (da.length >= 7 && db.length >= 7 && (da === db || da.endsWith(db) || db.endsWith(da))) return true;
    }
    return false;
  }

  // The one profile key whose value equals `value`, or null when none or
  // several do. A bare yes/no answers too many questions to pin to a key.
  function profileKeyFor(value, profile) {
    if (!profile || typeof profile !== 'object') return null;
    const v = norm(value);
    if (!v || v === 'yes' || v === 'no') return null;
    const hits = [];
    Object.keys(profile).forEach(key => {
      if (key === 'eeo') return;
      const pv = profile[key];
      if (typeof pv !== 'string' || !pv.trim()) return;
      if (sameValue(value, pv, key)) hits.push(key);
    });
    const first = typeof profile.firstName === 'string' ? profile.firstName.trim() : '';
    const last = typeof profile.lastName === 'string' ? profile.lastName.trim() : '';
    if (first && last && sameValue(value, first + ' ' + last, 'fullName')) hits.push('fullName');
    return hits.length === 1 ? hits[0] : null;
  }

  // --- learning ----------------------------------------------------------------
  function learningOn() {
    return hasRun && !running && !!settings && settings.autoLearn !== false && alive();
  }

  async function learn(rule, doneText) {
    try {
      await store.learnRule(rule);
      if (doneText) showToast(doneText, { variant: 'success' });
      return true;
    } catch (err) {
      showToast('Could not save that: ' + (err && err.message ? err.message : 'unknown error'), { variant: 'warn' });
      return false;
    }
  }

  function promptRemember(entry, value) {
    const desc = entry.desc;
    const labelKey = labelKeyOf(desc);
    const label = shortLabel(desc);
    showPrompt(entry, "Remember this for '" + label + "'?", [
      {
        label: 'This site',
        primary: true,
        onClick: () => { learn({ host: hostName(), labelKey, value }, "Saved. LIT will fill '" + label + "' on this site."); }
      },
      {
        label: 'Everywhere',
        onClick: () => { learn({ host: '*', labelKey, value }, "Saved. LIT will fill '" + label + "' everywhere."); }
      },
      { label: 'No' }
    ]);
  }

  function offerAnswer(entry, value) {
    const desc = entry.desc;
    entry.offered = value;
    showPrompt(entry, 'Save to answer bank?', [
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          try {
            await store.saveAnswer({ question: desc.label || labelKeyOf(desc), answer: value });
            showToast('Saved to your answer bank.', { variant: 'success' });
          } catch (err) {
            showToast('Could not save that answer: ' + (err && err.message ? err.message : 'unknown error'), { variant: 'warn' });
          }
        }
      },
      { label: 'No' }
    ]);
  }

  function handleChange(entry) {
    const desc = entry.desc;
    if (!LEARNABLE_KINDS.has(desc.kind) || isSensitive(desc)) return;
    const value = readValue(desc);
    if (!value || value === entry.value) return;
    entry.value = value;
    // Long answers are offered to the answer bank on blur instead.
    if (desc.kind === 'textarea' && value.length >= ANSWER_MIN_CHARS) return;
    const labelKey = labelKeyOf(desc);
    if (!labelKey) return;
    const key = profileKeyFor(value, lastProfile);
    const label = shortLabel(desc);
    const host = hostName();

    if (entry.state === 'filled') {
      const oldKey = entry.match && entry.match.profileKey;
      if (key && key !== oldKey) {
        entry.match = { profileKey: key, value, confidence: 1, source: 'rule' };
        learn({ host, labelKey, profileKey: key }, "Got it. '" + label + "' now uses your " + key + ' on this site.');
      } else if (!key) {
        promptRemember(entry, value);
      }
      return;
    }

    if (key) {
      entry.state = 'filled';
      entry.match = { profileKey: key, value, confidence: 1, source: 'rule' };
      learn({ host, labelKey, profileKey: key }, "Learned. LIT will fill '" + label + "' with your " + key + ' here.');
      return;
    }
    promptRemember(entry, value);
  }

  function handleBlur(entry) {
    const desc = entry.desc;
    if (desc.kind !== 'textarea' || isSensitive(desc)) return;
    const value = readValue(desc);
    if (value.length < ANSWER_MIN_CHARS || value === entry.initial || value === entry.offered) return;
    entry.value = value;
    offerAnswer(entry, value);
  }

  // Every field on the form, not only the ones the run reported: fields the
  // user filled first, and steps or follow-up questions rendered later. EEO
  // questions are left out while EEO filling is off.
  function isTracked(desc) {
    return [desc.el].concat(desc.inputs || []).some(el => byEl.has(el)) || (desc.group && byGroup.has(desc.group));
  }

  function eeoBlocked(desc) {
    if (settings && settings.fillEeo) return false;
    try {
      const hit = typeof core.dictionaryLookup === 'function' ? core.dictionaryLookup(desc) : null;
      return !!(hit && /^eeo\./.test(hit.key));
    } catch (e) {
      return false;
    }
  }

  function scanRoot() {
    try {
      const adapter = typeof core.getSiteAdapter === 'function' ? core.getSiteAdapter(location.href) : null;
      const root = adapter && typeof adapter.scanRoot === 'function' ? adapter.scanRoot(document) : null;
      if (root) return root;
    } catch (e) { /* fall back to the document */ }
    return document;
  }

  function trackPage() {
    if (!learningOn() || typeof core.scanFields !== 'function') return;
    let descs = [];
    try { descs = core.scanFields(scanRoot(), { includeFilled: true }) || []; } catch (e) { descs = []; }
    descs.forEach(desc => {
      if (!desc || !desc.el || isTracked(desc) || !LEARNABLE_KINDS.has(desc.kind)) return;
      if (isSensitive(desc) || eeoBlocked(desc)) return;
      track(desc, 'seen', null, true);
    });
  }

  // A re-rendered field (Workday swaps nodes after every edit) is looked up
  // again so its new node is read, not the detached one.
  function refresh(entry) {
    const el = entry.desc.el;
    if (!el || el.isConnected !== false || typeof core.refindField !== 'function') return entry;
    let fresh = null;
    try { fresh = core.refindField(entry.desc, document); } catch (e) { fresh = null; }
    if (!fresh || !fresh.el) return entry;
    byEl.delete(el);
    (entry.desc.inputs || []).forEach(i => byEl.delete(i));
    if (entry.desc.group) byGroup.delete(entry.desc.group);
    entry.desc = fresh;
    entry.target = fresh.group || fresh.el;
    byEl.set(fresh.el, entry);
    (fresh.inputs || []).forEach(i => byEl.set(i, entry));
    if (fresh.group) byGroup.set(fresh.group, entry);
    return entry;
  }

  // Re-read every tracked field and learn from the ones that changed. A text
  // box still being typed in is left to its change and blur events.
  function sweep() {
    if (!learningOn()) return;
    const active = document.activeElement;
    Array.from(new Set(byEl.values())).forEach(entry => {
      refresh(entry);
      if (TYPED_KINDS.has(entry.desc.kind) && entry.desc.el === active) return;
      handleChange(entry);
    });
  }

  function scheduleSweep() {
    if (!learningOn()) return;
    sweepTimers.forEach(clearTimeout);
    sweepTimers = SWEEP_DELAYS_MS.map(ms => setTimeout(sweep, ms));
  }

  function clearSweeps() {
    sweepTimers.forEach(clearTimeout);
    sweepTimers = [];
  }

  // --- document listeners --------------------------------------------------------
  function onFocusIn(event) {
    const entry = entryFor(event && event.target);
    if (entry) clearOutline(entry.target);
  }

  function onChange(event) {
    if (!learningOn()) return;
    const entry = entryFor(event && event.target);
    if (entry) handleChange(entry);
    scheduleSweep();
  }

  function onFocusOut(event) {
    if (!learningOn()) return;
    const entry = entryFor(event && event.target);
    if (entry) handleBlur(entry);
    scheduleSweep();
  }

  // Custom dropdowns and button groups commit on click or Enter and never
  // fire `change`.
  function onPointerCommit() { scheduleSweep(); }

  function onKeyCommit(event) {
    const key = event && event.key;
    if (key === 'Enter' || key === ' ' || key === 'Tab' || key === 'Escape') scheduleSweep();
  }

  function onKeyDown(event) {
    if (!event || !event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
    if (event.code !== 'KeyF' && String(event.key || '').toLowerCase() !== 'f') return;
    if (!eligible) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    fill();
  }

  // --- the run -----------------------------------------------------------------
  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function formatResult(filled, need) {
    const head = 'Filled ' + plural(filled, 'field', 'fields');
    return need > 0 ? head + ', ' + need + ' need' + (need === 1 ? 's' : '') + ' you.' : head + '.';
  }

  function profileIsEmpty(profile) {
    if (!profile) return true;
    return !['firstName', 'lastName', 'email', 'phone'].some(k => typeof profile[k] === 'string' && profile[k].trim());
  }

  async function safe(fn, fallback) {
    try {
      const v = await fn();
      return v === undefined ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  async function fill() {
    if (running) return null;
    if (!alive()) { destroy(); return null; }
    running = true;
    ensureUi();
    setFabBusy(true);
    closeToast();
    resetTracking();
    let report = null;
    try {
      const [profile, rules, answers, resume, loaded] = await Promise.all([
        store.getProfile(),
        safe(() => store.getRules(), []),
        safe(() => store.getAnswers(), []),
        safe(() => store.getResume(), null),
        safe(() => store.getSettings(), null)
      ]);
      if (loaded) settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
      const runSettings = settings || Object.assign({}, DEFAULT_SETTINGS);
      report = await core.run({ profile, rules, answers, resume, settings: runSettings, host: hostName() });
      lastProfile = profile;
      const filled = (report && Array.isArray(report.filled)) ? report.filled : [];
      const unmatched = (report && Array.isArray(report.unmatched)) ? report.unmatched : [];
      // Fields the user already filled, or EEO fields left blank on purpose,
      // do not need attention.
      const skipped = ((report && Array.isArray(report.skipped)) ? report.skipped : [])
        .filter(item => item && item.reason !== 'already-filled' && item.reason !== 'eeo-disabled');
      filled.forEach(item => { if (item) track(item.desc, 'filled', item.match); });
      unmatched.forEach(desc => track(desc, 'unmatched', null));
      skipped.forEach(item => { if (item) track(item.desc, 'unmatched', null); });
      hasRun = true;
      running = false;
      trackPage();
      const need = unmatched.length + skipped.length;
      const text = filled.length === 0 && profileIsEmpty(profile)
        ? 'Your Autofill profile is empty. Open LIT and choose Autofill profile to set it up.'
        : formatResult(filled.length, need);
      showToast(text, {
        variant: filled.length ? 'success' : 'warn',
        durationMs: RESULT_TOAST_MS,
        actions: [{ label: 'Fill again', primary: true, onClick: () => { fill(); } }, { label: 'Dismiss' }]
      });
    } catch (err) {
      showToast('Autofill could not finish: ' + (err && err.message ? err.message : 'unknown error'), { variant: 'warn', durationMs: RESULT_TOAST_MS });
    } finally {
      running = false;
      setFabBusy(false);
      check();
    }
    return report;
  }

  // --- visibility checks -----------------------------------------------------------
  function check() {
    if (!started) return;
    if (!alive()) { destroy(); return; }
    eligible = countFillable(document) >= MIN_FIELDS;
    trackPage();
    const show = eligible && !!settings && settings.showButton !== false;
    if (show) {
      ensureUi();
      setFabVisible(true);
    } else {
      setFabVisible(false);
    }
  }

  // Runs CHECK_DELAY_MS after the first mutation of a burst rather than after
  // the last one, so a page that never stops mutating still gets checked.
  function scheduleCheck() {
    if (checkTimer || !started) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      check();
    }, CHECK_DELAY_MS);
  }

  function loadSettings() {
    const seq = ++settingsSeq;
    return safe(() => store.getSettings(), null).then(s => {
      if (seq !== settingsSeq) return;
      settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
      check();
    });
  }

  function onStoreChange() {
    if (!started) return;
    loadSettings();
  }

  function subscribeStore() {
    if (storeUnsub || storeSubscribedForever || typeof store.onChange !== 'function') return;
    let ret;
    try { ret = store.onChange(onStoreChange); } catch (e) { ret = null; }
    if (typeof ret === 'function') storeUnsub = ret;
    else storeSubscribedForever = true; // no way to unsubscribe; onStoreChange checks `started`
  }

  function start() {
    if (started) return;
    started = true;
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      observer = new MutationObserver(scheduleCheck);
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('click', onPointerCommit, true);
    document.addEventListener('keyup', onKeyCommit, true);
    window.addEventListener('keydown', onKeyDown, true);
    subscribeStore();
    loadSettings();
  }

  function stop() {
    if (!started) return;
    started = false;
    if (observer) observer.disconnect();
    observer = null;
    clearTimeout(checkTimer);
    checkTimer = null;
    settingsSeq++;
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('click', onPointerCommit, true);
    document.removeEventListener('keyup', onKeyCommit, true);
    window.removeEventListener('keydown', onKeyDown, true);
    clearSweeps();
    if (storeUnsub) {
      try { storeUnsub(); } catch (e) { /* storage gone */ }
      storeUnsub = null;
    }
    closePrompt();
    closeToast();
  }

  function onPageHide() { stop(); }
  function onPageShow(event) { if (event && event.persisted) start(); }

  // Full removal: used when the extension context is gone (reloaded or
  // updated under this page) so a stale copy leaves nothing behind.
  function destroy() {
    stop();
    resetTracking();
    if (ui && ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui = null;
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    if (window.__litAutofillUI === api) {
      try { delete window.__litAutofillUI; } catch (e) { window.__litAutofillUI = undefined; }
    }
  }

  const api = {
    HOST_ID,
    MIN_FIELDS,
    CHECK_DELAY_MS,
    FILLED_CLASS,
    UNMATCHED_CLASS,
    fill,
    check,
    start,
    stop,
    destroy,
    isSensitive,
    profileKeyFor,
    formatResult,
    sweep,
    state: () => ({ started, eligible, running, hasRun, buttonShown: !!ui && !ui.fab.classList.contains('hidden'), tracked: byEl.size })
  };

  window.__litAutofillUI = api;
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  start();

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
