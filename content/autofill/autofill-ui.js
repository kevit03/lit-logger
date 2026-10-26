// In-page Autofill: the floating "Autofill" button and the learning loop.
//
// Loads after shared/autofill-store.js, shared/autofill-core.js, and the site
// adapters. In each frame that holds at least MIN_FIELDS fillable fields (and
// while settings.showButton is on) it shows a small button, bottom right,
// inside a closed shadow root so page CSS cannot reach it. Alt+Shift+F does
// the same as a click.
//
// A click loads everything from AutofillStore, hands it to AutofillCore.run,
// outlines filled fields solid green and the ones that still need the user
// dashed amber, explains the outlines in the result toast,
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
  // Filled is solid green, needs-you dashed amber: two cues, not just color.
  const OUTLINE_STYLES = { [FILLED_CLASS]: '2px solid #34a853', [UNMATCHED_CLASS]: '2px dashed #f9ab00' };
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
  const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
  // Where the widget sits, per site, in chrome.storage.local.
  const POS_KEY = 'lit_af_ui_pos';
  const POS_HOSTS_MAX = 60;
  const DEFAULT_POS = { h: 'right', v: 'bottom', x: 16, y: 16 };
  const EDGE_MIN = 6;
  const DRAG_THRESHOLD_PX = 4;
  const AVOID_MARGIN_PX = 8;
  const PRESS_SAFETY_MS = 1500;

  // The host element can still be hit by page selectors such as `#id` or a
  // universal rule, so its own box is pinned inline with !important.
  const HOST_STYLE = 'all: initial !important; position: fixed !important; width: 0 !important; height: 0 !important; ' +
    'right: 0 !important; bottom: 0 !important; z-index: 2147483646 !important; display: block !important;';

  // The widget: one dock (grip, Autofill button, hide) and a stack of cards
  // that opens away from the screen edge the dock is pinned to. The wrap's
  // left/right/top/bottom are set from the saved position; `at-top` and
  // `at-left` flip the stacking and alignment so cards never hang offscreen.
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
      color: #ecedee;
      transition: opacity 160ms ease;
    }
    .wrap.at-top { flex-direction: column-reverse; }
    .wrap.at-left { align-items: flex-start; }
    .wrap.dragging, .wrap.dragging * { cursor: grabbing !important; user-select: none; }
    .wrap.dragging .card, .wrap.dragging .dock { box-shadow: 0 18px 40px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.25); }
    .stack { display: flex; flex-direction: column; gap: 8px; align-items: inherit; }
    .wrap.at-top .stack { flex-direction: column-reverse; }
    button {
      all: unset;
      box-sizing: border-box;
      cursor: pointer;
      font-family: inherit;
      font-weight: 600;
      font-size: 12px;
      line-height: 1;
      padding: 7px 11px;
      border-radius: 8px;
      color: #ecedee;
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.1);
      white-space: nowrap;
      transition: background 160ms cubic-bezier(0.16, 1, 0.3, 1), transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    button:hover { background: rgba(255, 255, 255, 0.14); }
    button:active { transform: scale(0.97); }
    button:focus-visible { outline: 2px solid #8ab4f8; outline-offset: 2px; }
    /* In a card the main answer is a blue tint, not a fill: the solid blue
       stays on the Autofill button alone. */
    button.primary { background: rgba(138, 180, 248, 0.16); color: #aecbfa; border-color: rgba(138, 180, 248, 0.38); }
    button.primary:hover { background: rgba(138, 180, 248, 0.26); }
    button.quiet { background: transparent; border-color: transparent; color: #9aa0a6; }
    button.quiet:hover { background: rgba(255, 255, 255, 0.08); color: #ecedee; }
    .hidden { display: none !important; }

    .grip {
      flex: none;
      width: 18px;
      align-self: stretch;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #7c8086;
      cursor: grab;
      touch-action: none;
      border-radius: 6px;
    }
    .grip:hover { color: #ecedee; }
    .grip svg { display: block; }

    .dock {
      pointer-events: auto;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px;
      border-radius: 999px;
      background: rgba(24, 25, 28, 0.94);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 2px 6px rgba(0, 0, 0, 0.2);
      transition: box-shadow 160ms ease;
    }
    .dock .grip { width: 16px; margin-left: 4px; }
    /* The one control in brand blue: everything else in the widget is
       neutral, so the Autofill button is what the eye lands on. */
    .fab {
      font-size: 13px;
      padding: 8px 14px 8px 12px;
      border-radius: 999px;
      background: #8ab4f8;
      color: #111316;
      border-color: transparent;
      touch-action: none;
    }
    .fab::before {
      content: "";
      display: inline-block;
      width: 6px;
      height: 6px;
      margin-right: 8px;
      border-radius: 50%;
      background: currentColor;
      vertical-align: 1px;
    }
    .fab:hover { background: #aecbfa; }
    .fab.busy { opacity: 0.75; cursor: progress; }
    .fab.busy::before { animation: lit-pulse 900ms ease-in-out infinite; }
    .x {
      flex: none;
      width: 24px;
      height: 24px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      background: transparent;
      border-color: transparent;
      color: #7c8086;
    }
    .x:hover { background: rgba(255, 255, 255, 0.1); color: #ecedee; }
    .x svg { display: block; }
    /* Hide sits apart from Autofill, behind a hairline, so a slightly-off
       click on the main button does not dismiss the widget. */
    .dock .x { margin-left: 6px; position: relative; }
    .dock .x::before {
      content: "";
      position: absolute;
      left: -4px; top: 5px; bottom: 5px;
      width: 1px;
      background: rgba(255, 255, 255, 0.14);
    }

    .card {
      pointer-events: auto;
      box-sizing: border-box;
      width: 300px;
      max-width: calc(100vw - 24px);
      padding: 10px 10px 14px 14px;
      border-radius: 14px;
      background: rgba(24, 25, 28, 0.97);
      font-size: 12px;
      line-height: 1.5;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.2);
      position: relative;
      overflow: hidden;
      animation: lit-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    .card::before {
      content: "";
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 3px;
      background: #5f6368;
    }
    .card.success::before { background: #34a853; }
    .card.warn::before { background: #fbbc04; }
    /* Type scale: 13 title, 12 body and buttons, 11 notes. The title is the
       heaviest and brightest line; the body steps down in contrast. */
    .head { display: flex; align-items: center; gap: 6px; margin: 0 0 4px -6px; }
    .head .grip { height: 22px; }
    .icon {
      flex: none;
      width: 16px;
      height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #9aa0a6;
    }
    .icon svg { display: block; }
    .success .icon { color: #81c995; }
    .warn .icon { color: #fdd663; }
    .title {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
      color: #ecedee;
    }
    .body { word-break: break-word; padding-right: 4px; color: #bdc1c6; }
    .value {
      margin-top: 8px;
      margin-right: 4px;
      padding: 6px 8px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #c8cbd0;
      font-size: 12px;
      line-height: 1.4;
      max-height: 54px;
      overflow: hidden;
      word-break: break-word;
    }
    .note {
      margin-top: 8px;
      padding-right: 4px;
      font-size: 11px;
      line-height: 1.45;
      color: #9aa0a6;
    }
    .key { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font-size: 11px; color: #bdc1c6; }
    .key span { display: inline-flex; align-items: center; gap: 6px; }
    .swatch { width: 12px; height: 8px; border-radius: 2px; box-sizing: border-box; }
    .swatch.filled { border: 2px solid #34a853; }
    .swatch.unmatched { border: 2px dashed #f9ab00; }
    .actions { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
    .actions button { border-radius: 7px; }
    .bar {
      position: absolute;
      left: 0; bottom: 0;
      height: 2px;
      width: 100%;
      background: rgba(255, 255, 255, 0.22);
      transform-origin: left center;
      animation: lit-drain var(--life, 20000ms) linear forwards;
    }
    .card.paused .bar { animation-play-state: paused; }
    @keyframes lit-drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
    @keyframes lit-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @keyframes lit-pulse { 50% { opacity: 0.3; } }
    @media (prefers-reduced-motion: reduce) {
      button, .wrap, .dock { transition: none; }
      .card, .fab.busy::before { animation: none; }
      .bar { display: none; }
    }
  `;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const GRIP_SVG = {
    attrs: { width: '8', height: '14', viewBox: '0 0 8 14', fill: 'currentColor' },
    children: [[2, 2], [6, 2], [2, 7], [6, 7], [2, 12], [6, 12]].map(([cx, cy]) => ['circle', { cx: String(cx), cy: String(cy), r: '1.3' }])
  };
  // Card status icons, so success, warning, and info differ by shape as well
  // as by color.
  const CHECK_SVG = {
    attrs: { width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none' },
    children: [
      ['circle', { cx: '7', cy: '7', r: '6', stroke: 'currentColor', 'stroke-width': '1.4' }],
      ['path', { d: 'M4.3 7.2l1.8 1.8 3.6-3.8', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]
    ]
  };
  const WARN_SVG = {
    attrs: { width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none' },
    children: [
      ['path', { d: 'M7 1.6l5.6 10H1.4z', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }],
      ['path', { d: 'M7 5.6v2.6M7 10v.1', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }]
    ]
  };
  const INFO_SVG = {
    attrs: { width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none' },
    children: [
      ['circle', { cx: '7', cy: '7', r: '6', stroke: 'currentColor', 'stroke-width': '1.4' }],
      ['path', { d: 'M7 6.4v3.4M7 4.2v.1', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }]
    ]
  };
  const STATUS_SVG = { success: CHECK_SVG, warn: WARN_SVG, info: INFO_SVG };
  const X_SVG = {
    attrs: { width: '10', height: '10', viewBox: '0 0 10 10', fill: 'none' },
    children: [['path', { d: 'M1.5 1.5l7 7M8.5 1.5l-7 7', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' }]]
  };

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
  let ui = null;          // { host, shadow, wrap, stack, dock, fab }
  let toast = null;       // { el, timer, remaining, startedAt, held }
  let prompt = null;      // same, plus entry
  let pos = Object.assign({}, DEFAULT_POS); // saved corner + offsets
  let dodge = null;       // a mirror of pos while the edited field is under it
  let drag = null;
  let suppressClick = false;
  let hiddenForPage = false;
  let viewportTimer = null;
  let pointerDown = false;
  let pendingPrompt = null; // { show, timer } held until the press ends
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

  function swallow(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
  }

  // Icons are built node by node: no innerHTML, so a page's Trusted Types
  // policy has nothing to object to.
  function svgIcon(spec) {
    if (typeof document.createElementNS !== 'function') return null;
    try {
      const svg = document.createElementNS(SVG_NS, 'svg');
      Object.keys(spec.attrs).forEach(k => svg.setAttribute(k, spec.attrs[k]));
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      spec.children.forEach(([tag, attrs]) => {
        const node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
        svg.appendChild(node);
      });
      return svg;
    } catch (e) {
      return null;
    }
  }

  function svgSpan(cls, spec) {
    const span = document.createElement('span');
    span.className = cls;
    const icon = svgIcon(spec);
    if (icon) span.appendChild(icon);
    return span;
  }

  function makeGrip() {
    const grip = svgSpan('grip', GRIP_SVG);
    grip.setAttribute('title', 'Drag to move');
    grip.setAttribute('aria-hidden', 'true');
    grip.addEventListener('pointerdown', startDrag);
    return grip;
  }

  function makeClose(label, onClick) {
    const x = document.createElement('button');
    x.className = 'x';
    x.setAttribute('type', 'button');
    x.setAttribute('aria-label', label);
    x.setAttribute('title', label);
    const icon = svgIcon(X_SVG);
    if (icon) x.appendChild(icon);
    x.addEventListener('click', event => { swallow(event); onClick(); });
    return x;
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

    const dock = document.createElement('div');
    dock.className = 'dock hidden';
    const fab = document.createElement('button');
    fab.className = 'fab hidden';
    fab.setAttribute('type', 'button');
    fab.setAttribute('title', 'Fill this form from your LIT profile (Alt+Shift+F). Nothing is submitted. Drag to move.');
    fab.setAttribute('aria-label', 'Autofill this form from your LIT profile. Nothing is submitted.');
    fab.textContent = 'Autofill';
    // The button drags too; a press that moves is a drag, not a click.
    fab.addEventListener('pointerdown', startDrag);
    fab.addEventListener('click', event => {
      swallow(event);
      if (suppressClick) { suppressClick = false; return; }
      fill();
    });
    dock.appendChild(makeGrip());
    dock.appendChild(fab);
    dock.appendChild(makeClose('Hide on this page (Alt+Shift+F still fills)', hideForPage));

    wrap.appendChild(stack);
    wrap.appendChild(dock);
    shadow.appendChild(wrap);
    attachHost(host);
    ui = { host, shadow, wrap, stack, dock, fab };
    applyPos();
    loadPos();
    return ui;
  }

  function setFabVisible(show) {
    if (!ui) return;
    ui.fab.classList.toggle('hidden', !show);
    ui.dock.classList.toggle('hidden', !show);
  }

  function setFabBusy(busy) {
    if (!ui) return;
    ui.fab.classList.toggle('busy', !!busy);
    ui.fab.textContent = busy ? 'Filling...' : (hasRun ? 'Fill again' : 'Autofill');
  }

  function hideForPage() {
    hiddenForPage = true;
    setFabVisible(false);
    showToast('Autofill is hidden on this page. Alt+Shift+F or "Autofill this page" in the LIT menu still fills it.', { variant: 'info' });
  }

  // --- position, dragging, and staying out of the way ---------------------------
  function viewport() {
    return { w: window.innerWidth || 1024, h: window.innerHeight || 768 };
  }

  function clampNum(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function validPos(p) {
    return !!p && (p.h === 'left' || p.h === 'right') && (p.v === 'top' || p.v === 'bottom') &&
      Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  function rectOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return r && (r.width > 0 || r.height > 0) ? r : null;
    } catch (e) {
      return null;
    }
  }

  // The widget's box if it sat at `p`, from its current size.
  function boxAt(p, size) {
    const vp = viewport();
    const left = p.h === 'left' ? p.x : vp.w - p.x - size.w;
    const top = p.v === 'top' ? p.y : vp.h - p.y - size.h;
    return { left, top, right: left + size.w, bottom: top + size.h };
  }

  function overlaps(a, b, margin) {
    return a.left < b.right + margin && a.right > b.left - margin && a.top < b.bottom + margin && a.bottom > b.top - margin;
  }

  function sizeOf() {
    const r = ui ? rectOf(ui.wrap) : null;
    return r ? { w: r.width, h: r.height } : { w: 0, h: 0 };
  }

  // Keeps the widget on screen after a resize or with a position saved on a
  // larger window.
  function clampPos(p, size) {
    const vp = viewport();
    return {
      h: p.h,
      v: p.v,
      x: clampNum(p.x, EDGE_MIN, Math.max(EDGE_MIN, vp.w - size.w - EDGE_MIN)),
      y: clampNum(p.y, EDGE_MIN, Math.max(EDGE_MIN, vp.h - size.h - EDGE_MIN))
    };
  }

  function applyPos() {
    if (!ui || drag) return;
    const p = clampPos(dodge || pos, sizeOf());
    const s = ui.wrap.style;
    s.left = p.h === 'left' ? p.x + 'px' : 'auto';
    s.right = p.h === 'right' ? p.x + 'px' : 'auto';
    s.top = p.v === 'top' ? p.y + 'px' : 'auto';
    s.bottom = p.v === 'bottom' ? p.y + 'px' : 'auto';
    ui.wrap.classList.toggle('at-top', p.v === 'top');
    ui.wrap.classList.toggle('at-left', p.h === 'left');
  }

  function storageArea() {
    try {
      return alive() && chrome.storage && chrome.storage.local ? chrome.storage.local : null;
    } catch (e) {
      return null;
    }
  }

  function loadPos() {
    const area = storageArea();
    if (!area) return;
    const host = hostName();
    try {
      area.get(POS_KEY, items => {
        try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
        const all = items && items[POS_KEY];
        const saved = all && typeof all === 'object' ? all[host] : null;
        if (!validPos(saved) || drag) return;
        pos = { h: saved.h, v: saved.v, x: saved.x, y: saved.y };
        applyPos();
      });
    } catch (e) { /* storage gone */ }
  }

  // One position per site, the most recent POS_HOSTS_MAX kept.
  function savePos() {
    const area = storageArea();
    if (!area) return;
    const host = hostName();
    const value = { h: pos.h, v: pos.v, x: pos.x, y: pos.y, at: Date.now() };
    try {
      area.get(POS_KEY, items => {
        try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
        const all = Object.assign({}, items && typeof items[POS_KEY] === 'object' ? items[POS_KEY] : {});
        all[host] = value;
        const hosts = Object.keys(all).sort((a, b) => ((all[b] && all[b].at) || 0) - ((all[a] && all[a].at) || 0));
        hosts.slice(POS_HOSTS_MAX).forEach(h => { delete all[h]; });
        try { area.set({ [POS_KEY]: all }, () => { try { void chrome.runtime.lastError; } catch (e) { /* gone */ } }); } catch (e) { /* gone */ }
      });
    } catch (e) { /* storage gone */ }
  }

  function startDrag(event) {
    if (!ui || !event) return;
    if (event.button !== undefined && event.button !== 0) return;
    const r = rectOf(ui.wrap);
    if (!r) return;
    drag = {
      id: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      left: r.left,
      top: r.top,
      w: r.width,
      h: r.height,
      moved: false,
      handle: event.currentTarget || event.target
    };
    try { drag.handle.setPointerCapture(event.pointerId); } catch (e) { /* no capture */ }
    ui.shadow.addEventListener('pointermove', onDragMove);
    ui.shadow.addEventListener('pointerup', endDrag);
    ui.shadow.addEventListener('pointercancel', endDrag);
  }

  function onDragMove(event) {
    if (!drag || !ui || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      ui.wrap.classList.add('dragging');
      dodge = null;
    }
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const vp = viewport();
    const left = clampNum(drag.left + dx, EDGE_MIN, Math.max(EDGE_MIN, vp.w - drag.w - EDGE_MIN));
    const top = clampNum(drag.top + dy, EDGE_MIN, Math.max(EDGE_MIN, vp.h - drag.h - EDGE_MIN));
    const s = ui.wrap.style;
    s.left = left + 'px';
    s.top = top + 'px';
    s.right = 'auto';
    s.bottom = 'auto';
  }

  // The drop pins the dock to the nearest corner, measured from the dock
  // (not the whole widget) so cards opening the other way do not make it jump.
  function endDrag(event) {
    if (!drag || !ui || (event && event.pointerId !== drag.id)) return;
    const was = drag;
    drag = null;
    ui.shadow.removeEventListener('pointermove', onDragMove);
    ui.shadow.removeEventListener('pointerup', endDrag);
    ui.shadow.removeEventListener('pointercancel', endDrag);
    try { was.handle.releasePointerCapture(was.id); } catch (e) { /* released */ }
    ui.wrap.classList.remove('dragging');
    if (!was.moved) {
      applyPos();
      return;
    }
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    const anchor = rectOf(ui.dock) || rectOf(ui.wrap);
    if (anchor) {
      const vp = viewport();
      const h = anchor.left + anchor.width / 2 < vp.w / 2 ? 'left' : 'right';
      const v = anchor.top + anchor.height / 2 < vp.h / 2 ? 'top' : 'bottom';
      pos = {
        h,
        v,
        x: Math.round(h === 'left' ? anchor.left : vp.w - anchor.right),
        y: Math.round(v === 'top' ? anchor.top : vp.h - anchor.bottom)
      };
      savePos();
    }
    applyPos();
  }

  // When the field being edited sits under the widget, the widget moves to
  // the first mirror position that clears it (the other side vertically, then
  // horizontally), and goes back once the field is out from under it. The
  // saved position never changes.
  function avoid(target) {
    if (!ui || drag) return;
    const before = dodge;
    const t = target && target !== ui.host && target !== document.body ? rectOf(target) : null;
    if (!t) {
      dodge = null;
    } else {
      const size = sizeOf();
      const flipV = p => Object.assign({}, p, { v: p.v === 'top' ? 'bottom' : 'top' });
      const flipH = p => Object.assign({}, p, { h: p.h === 'left' ? 'right' : 'left' });
      const candidates = [pos, flipV(pos), flipH(pos), flipH(flipV(pos))];
      const clear = candidates.find(c => !overlaps(boxAt(clampPos(c, size), size), t, AVOID_MARGIN_PX));
      dodge = !clear || clear === pos ? null : clear;
    }
    if (before !== dodge) applyPos();
  }

  // Between fields (focus on the body) the widget stays where it is.
  function avoidActive() {
    const active = document.activeElement;
    if (active && FIELD_TAGS.has(tagOf(active))) avoid(active);
  }

  function onViewportChange() {
    if (!ui || viewportTimer) return;
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      dodge = null;
      applyPos();
      avoidActive();
    }, 120);
  }

  // A field's `change` fires on the mousedown that moves to the next field.
  // A card added then lands under the pointer and takes the click, so focus
  // never reaches the field the user clicked. Prompts asked for mid-press
  // wait for the press to end (or a short safety delay).
  function onPointerDownAny() { pointerDown = true; }

  function onPointerUpAny() {
    pointerDown = false;
    flushPendingPrompt(0);
  }

  function flushPendingPrompt(delay) {
    if (!pendingPrompt) return;
    const pending = pendingPrompt;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (pendingPrompt !== pending) return;
      pendingPrompt = null;
      pending.show();
    }, delay);
  }

  function cancelPendingPrompt() {
    if (!pendingPrompt) return;
    clearTimeout(pendingPrompt.timer);
    pendingPrompt = null;
  }

  // --- cards -----------------------------------------------------------------------
  function makeButtons(container, actions, close) {
    const row = document.createElement('div');
    row.className = 'actions';
    actions.forEach(action => {
      const btn = document.createElement('button');
      btn.setAttribute('type', 'button');
      if (action.primary) btn.className = 'primary';
      else if (action.quiet) btn.className = 'quiet';
      btn.textContent = action.label;
      btn.addEventListener('click', event => {
        swallow(event);
        close();
        if (typeof action.onClick === 'function') action.onClick();
      });
      row.appendChild(btn);
    });
    container.appendChild(row);
  }

  // A card: header (grip, title, close), body, optional value and actions,
  // and a bar that drains until it closes itself. Hovering or tabbing into
  // the card holds the timer; Escape closes it.
  function buildCard(cls, options, close) {
    const el = document.createElement('div');
    el.className = 'card ' + cls;
    const head = document.createElement('div');
    head.className = 'head';
    head.appendChild(makeGrip());
    const status = STATUS_SVG[options.variant] || INFO_SVG;
    head.appendChild(svgSpan('icon', status));
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = options.title || 'LIT Autofill';
    head.appendChild(title);
    head.appendChild(makeClose('Close', close));
    el.appendChild(head);
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = options.text;
    el.appendChild(body);
    if (options.value) {
      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = options.value;
      el.appendChild(value);
    }
    if (options.key) el.appendChild(outlineKey());
    if (options.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = options.note;
      el.appendChild(note);
    }
    if (options.actions && options.actions.length) makeButtons(el, options.actions, close);
    const bar = document.createElement('div');
    bar.className = 'bar';
    el.appendChild(bar);
    el.setAttribute('style', '--life: ' + Math.round(options.durationMs) + 'ms');
    el.addEventListener('keydown', event => {
      if (event && event.key === 'Escape') { swallow(event); close(); }
    });
    return el;
  }

  // What the outlines on the page mean, in words, so the green and amber
  // (solid and dashed) are not left to color alone.
  function outlineKey() {
    const key = document.createElement('div');
    key.className = 'key';
    [['filled', 'Filled'], ['unmatched', 'Needs you']].forEach(([cls, text]) => {
      const item = document.createElement('span');
      const swatch = document.createElement('span');
      swatch.className = 'swatch ' + cls;
      swatch.setAttribute('aria-hidden', 'true');
      item.appendChild(swatch);
      const label = document.createElement('span');
      label.textContent = text;
      item.appendChild(label);
      key.appendChild(item);
    });
    return key;
  }

  function startLife(current, ms, close) {
    current.remaining = ms;
    current.startedAt = Date.now();
    current.timer = setTimeout(close, ms);
    const hold = () => {
      if (current.held) return;
      current.held = true;
      clearTimeout(current.timer);
      current.remaining = Math.max(1500, current.remaining - (Date.now() - current.startedAt));
      current.el.classList.add('paused');
    };
    const release = () => {
      if (!current.held) return;
      current.held = false;
      current.startedAt = Date.now();
      current.timer = setTimeout(close, current.remaining);
      current.el.classList.remove('paused');
    };
    current.el.addEventListener('pointerenter', hold);
    current.el.addEventListener('pointerleave', release);
    current.el.addEventListener('focusin', hold);
    current.el.addEventListener('focusout', release);
  }

  function closeToast() {
    if (!toast) return;
    clearTimeout(toast.timer);
    if (toast.el.parentNode) toast.el.parentNode.removeChild(toast.el);
    toast = null;
    applyPos();
  }

  function showToast(text, options = {}) {
    const root = ensureUi();
    closeToast();
    const durationMs = options.durationMs || NOTE_TOAST_MS;
    const current = { el: null, timer: null };
    const close = () => { if (toast === current) closeToast(); };
    const variant = options.variant || 'info';
    const titles = { success: 'Autofill', warn: 'Autofill needs attention', info: 'Autofill' };
    const el = buildCard('toast ' + variant, {
      title: options.title || titles[variant] || 'Autofill',
      variant,
      text,
      note: options.note,
      key: options.key,
      actions: options.actions,
      durationMs
    }, close);
    el.setAttribute('role', 'status');
    current.el = el;
    root.stack.appendChild(el);
    startLife(current, durationMs, close);
    toast = current;
    applyPos();
    avoidActive();
    return current;
  }

  function closePrompt() {
    cancelPendingPrompt();
    if (!prompt) return;
    clearTimeout(prompt.timer);
    if (prompt.el.parentNode) prompt.el.parentNode.removeChild(prompt.el);
    prompt = null;
    applyPos();
  }

  // Learning questions sit in the widget, beside the Autofill button, never
  // over the form. One at a time: a new prompt replaces the old one, and an
  // unanswered prompt goes away by itself.
  function showPrompt(entry, card, actions) {
    cancelPendingPrompt();
    if (pointerDown) {
      pendingPrompt = { show: () => showPrompt(entry, card, actions), timer: null };
      flushPendingPrompt(PRESS_SAFETY_MS);
      return null;
    }
    const root = ensureUi();
    closePrompt();
    const current = { el: null, timer: null, entry };
    const close = () => { if (prompt === current) closePrompt(); };
    const el = buildCard('prompt', {
      title: card.title,
      variant: 'info',
      note: card.note,
      text: card.text,
      value: card.value,
      actions,
      durationMs: PROMPT_MS
    }, close);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'LIT Autofill: ' + card.title);
    current.el = el;
    // The prompt sits next to the dock; a toast, if any, stays outermost.
    root.stack.appendChild(el);
    startLife(current, PROMPT_MS, close);
    prompt = current;
    applyPos();
    avoidActive();
    return current;
  }

  function preview(value, max) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max - 3).trim() + '...' : text;
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
    target.style.setProperty('outline', OUTLINE_STYLES[cls], 'important');
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
    showPrompt(entry, {
      title: 'Save answer for next time?',
      text: label,
      value: preview(value, 120),
      note: 'LIT will fill in this answer the next time it sees this question.'
    }, [
      {
        label: 'Save for this site',
        primary: true,
        onClick: () => { learn({ host: hostName(), labelKey, value }, "Saved. LIT will fill '" + label + "' on this site."); }
      },
      {
        label: 'Save for all sites',
        onClick: () => { learn({ host: '*', labelKey, value }, "Saved. LIT will fill '" + label + "' on every site."); }
      },
      { label: 'Not now', quiet: true }
    ]);
  }

  function offerAnswer(entry, value) {
    const desc = entry.desc;
    entry.offered = value;
    showPrompt(entry, {
      title: 'Save to answer bank?',
      text: desc.label || labelKeyOf(desc) || 'Long answer',
      value: preview(value, 160),
      note: 'LIT can reuse it when a similar question comes up.'
    }, [
      {
        label: 'Save answer',
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
      { label: 'Not now', quiet: true }
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
    const target = event && event.target;
    const entry = entryFor(target);
    if (entry) clearOutline(entry.target);
    // Focus inside the widget reaches the document as the host itself.
    if (ui && target && target !== ui.host && FIELD_TAGS.has(tagOf(target))) avoid(target);
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
    hiddenForPage = false;
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
      const empty = filled.length === 0 && profileIsEmpty(profile);
      const text = empty
        ? 'Your Autofill profile is empty. Open LIT and choose Autofill profile to set it up.'
        : formatResult(filled.length, need);
      // The Autofill button already reads "Fill again", so the toast's copy
      // of it stays secondary.
      showToast(text, {
        variant: filled.length ? 'success' : 'warn',
        durationMs: RESULT_TOAST_MS,
        key: !empty && filled.length + need > 0,
        note: empty ? '' : 'Nothing was submitted. Check the form before you send it.',
        actions: [{ label: 'Fill again', onClick: () => { fill(); } }]
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
    const show = eligible && !hiddenForPage && !!settings && settings.showButton !== false;
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
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('pointerdown', onPointerDownAny, true);
    window.addEventListener('pointerup', onPointerUpAny, true);
    window.addEventListener('pointercancel', onPointerUpAny, true);
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
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('pointerdown', onPointerDownAny, true);
    window.removeEventListener('pointerup', onPointerUpAny, true);
    window.removeEventListener('pointercancel', onPointerUpAny, true);
    pointerDown = false;
    cancelPendingPrompt();
    clearTimeout(viewportTimer);
    viewportTimer = null;
    if (drag && ui) endDrag(null);
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
    // For the service worker's "Autofill this page": the form's size (capped
    // at MIN_FIELDS) and a note when there is nothing to fill.
    formSize: () => countFillable(document),
    note: text => { showToast(String(text || ''), { variant: 'warn', durationMs: RESULT_TOAST_MS }); },
    position: () => Object.assign({}, dodge || pos, { dodged: !!dodge }),
    state: () => ({ started, eligible, running, hasRun, buttonShown: !!ui && !ui.fab.classList.contains('hidden'), tracked: byEl.size })
  };

  window.__litAutofillUI = api;
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  start();

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
