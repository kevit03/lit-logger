// Auto-apply driver: runs inside each batch tab opened by the background
// batch runner (background/batch-runner.js) and walks one application:
// reach the form, autofill it, verify every required field, click Submit
// once, and confirm success.
//
// Loads right after content/autofill/autofill-ui.js in every frame where
// autofill loads. On load it asks the background whether this tab belongs to
// a batch (LIT_BATCH_HELLO). For every other tab the answer is null and the
// driver stops there: no listeners, no observers, no timers.
//
// Anything it cannot do confidently ends as `needs-you` with the tab left
// open: a required field still empty, a CAPTCHA challenge, a validation
// error, an ambiguous Submit button, Workday's sign-in. It never solves or
// touches a CAPTCHA, never navigates away except the Ashby/Lever form URL
// fixes and one apply button, and never clicks Submit twice for a job, also
// across reloads (status `submitting` from HELLO means check for success only).
//
// Background tabs throttle timers to about one per second and never run
// requestAnimationFrame, so every wait is a MutationObserver plus setTimeout
// polling against a Date.now() deadline.
//
// A bare IIFE with no top-level bindings: the background may inject this file
// again into a frame that already has it.
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const existing = window.__litAutoApply;
  if (existing) {
    if (typeof module !== 'undefined' && module.exports) module.exports = existing;
    return;
  }

  const timing = {
    formWait: 20000,     // step 3: how long to wait for a fillable form
    applyGrace: 3000,    // no form this long -> look for one apply button
    refillDelay: 1500,   // between the two fill passes (conditional questions)
    settle: 400,         // after filling, before verifying
    successWait: 30000,  // after the click
    errorGrace: 1500,    // errors right after the click may be stale; wait this long
    poll: 500,           // polling backstop (throttled to ~1 s in background tabs)
    throttle: 200        // min gap between mutation-driven checks
  };

  const MIN_FORM = 3;
  const MAX_MISSING = 10;
  const MAX_LABEL = 80;

  const APPLY_RE = /^(apply|apply now|apply for this job|apply to this job|start application)$/i;
  const SIGNIN_HREF_RE = /log-?in|sign-?in|sign_in|signup|sign-?up|register|oauth|\bsso\b|\/auth\b|account|linkedin|indeed/i;
  const SUBMIT_TEXT_RE = /submit|send application|apply/i;
  const SUBMIT_EXCLUDE_RE = /linkedin|indeed|save|draft|back|cancel/i;
  const SUCCESS_URL_RE = /confirmation|thanks|thank-you|thank_you|submitted|success/i;
  const SUCCESS_SELECTOR = '#application_confirmation, .application-confirmation, .ashby-application-form-success-container, [data-qa="msg-submit-success"]';
  // Copy of AutoTrackerATS.DEFAULT_TEXT for frames where confirmation.js is absent.
  const DEFAULT_SUCCESS_TEXT = /thank(s| you) for (applying|your (job )?application|submitting)|application (has been |was |is )?(successfully )?(submitted|received|sent|complete)|we('ve| have)? (successfully )?(received|got) your (job )?application|successfully (submitted|applied)/i;
  const TEXT_CANDIDATES = 'h1, h2, h3, h4, p, span, strong, div, li, [role="alert"], [role="status"]';
  const FIELD_SELECTOR = 'input, select, textarea, [role="combobox"]';
  const ERROR_SELECTOR = '[role="alert"], .error, .error-message, .field-error, .invalid-feedback, [class*="error"], [id$="-error"]';
  const ERROR_TEXT_RE = /required|invalid|error|please|missing|must|could not|couldn.t|failed|try again|not valid/i;
  const REQUIRED_CLASS_RE = /(^|[\s_-])required([\s_-]|$)/i;
  const NOT_REQUIRED_CLASS_RE = /not[-_]?required|optional/i;
  const FILE_NAME_RE = /[\w)\]-]\.(pdf|docx?|rtf|txt|odt|pages)\b/i;
  const WRAPPER_SELECTOR = '.ashby-application-form-field-entry, .field-wrapper, .application-question, [role="group"], fieldset, .field, .form-group';
  // The question's own text inside a wrapper or a wrapping <label>, before
  // falling back to any label (which may be an option's).
  const TITLE_SELECTOR = '.ashby-application-form-question-title, .application-label, legend, .label, [class*="question-title"]';

  const HOSTS = {
    greenhouse: /(^|\.)greenhouse\.io$/,
    ashby: /^jobs\.ashbyhq\.com$/,
    lever: /^jobs(\.eu)?\.lever\.co$/,
    workday: /(^|\.)(myworkdayjobs|myworkdaysite|myworkday|workday)\.com$/
  };

  const state = {
    phase: 'idle',       // idle | hello | inactive | navigating | waiting-form | no-form | filling | verifying | submitting | checking | done | stopped | dead
    job: null,
    mode: null,
    status: null,        // last status the background accepted
    reason: '',
    filled: 0,
    missing: [],
    applyClicked: false,
    submitClicks: 0,
    sent: []             // statuses sent, accepted or not
  };

  let current = null;
  let claimed = false;

  // --- small helpers -----------------------------------------------------------
  const collapse = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const attr = (el, n) => {
    try { return el && typeof el.getAttribute === 'function' ? el.getAttribute(n) : null; } catch (e) { return null; }
  };
  const tagOf = el => String((el && el.tagName) || '').toLowerCase();
  const qsa = (root, sel) => {
    try { return Array.from(root.querySelectorAll(sel)); } catch (e) { return []; }
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

  function core() {
    return typeof AutofillCore !== 'undefined' && AutofillCore ? AutofillCore : null;
  }

  function ui() {
    const u = window.__litAutofillUI;
    return u && typeof u === 'object' ? u : null;
  }

  function alive() {
    try {
      return typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime && !!chrome.runtime.id &&
        typeof chrome.runtime.sendMessage === 'function';
    } catch (e) {
      return false;
    }
  }

  function loc() {
    try { return window.location || (typeof location !== 'undefined' ? location : null); } catch (e) { return null; }
  }

  function currentUrl() {
    const l = loc();
    try { return new URL(String(l && l.href ? l.href : l)); } catch (e) { return null; }
  }

  function toUrl(u) {
    if (!u) return currentUrl();
    try { return new URL(String(u && u.href ? u.href : u)); } catch (e) { return null; }
  }

  function hostOf(u) {
    const url = toUrl(u);
    return url ? url.hostname.toLowerCase() : '';
  }

  function textOf(el) {
    if (!el) return '';
    let t = '';
    try { t = el.innerText != null ? el.innerText : el.textContent; } catch (e) { t = ''; }
    return collapse(t);
  }

  function hiddenByAncestor(el) {
    try { return !!(el.closest && el.closest('[hidden]')); } catch (e) { return false; }
  }

  function styleOf(el) {
    try {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === 'function') return view.getComputedStyle(el);
      if (typeof getComputedStyle === 'function') return getComputedStyle(el);
    } catch (e) { /* detached */ }
    return null;
  }

  // On screen with a real box. A display:none subtree has no box; reCAPTCHA
  // parks its hidden challenge at top:-10000px with visibility:hidden.
  function isVisible(el) {
    if (!el || el.nodeType !== 1 || hiddenByAncestor(el)) return false;
    const cs = styleOf(el);
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || cs.opacity === '0')) return false;
    let r = null;
    try { r = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (e) { r = null; }
    if (!r) return true;
    if (r.width <= 1 && r.height <= 1) return false;
    if (r.bottom < 0 || r.right < 0) return false;
    return true;
  }

  // Fields often hide the real control behind a styled wrapper, so they only
  // need to be rendered, not boxed.
  function isRenderedLoose(el) {
    if (!el || hiddenByAncestor(el)) return false;
    const cs = styleOf(el);
    return !(cs && cs.display === 'none');
  }

  function isDisabled(el) {
    return !!el && (el.disabled === true || (el.hasAttribute && el.hasAttribute('disabled')) || attr(el, 'aria-disabled') === 'true');
  }

  function clip(s, n = MAX_LABEL) {
    const t = collapse(String(s || '').replace(/\*/g, ' '));
    return t.length > n ? t.slice(0, n - 3).trim() + '...' : t;
  }

  function byId(doc, id) {
    if (!id) return null;
    try {
      if (typeof doc.getElementById === 'function') return doc.getElementById(id);
    } catch (e) { /* fall through */ }
    return qsa(doc, '[id]').find(e => e.id === id) || null;
  }

  function docOf(el) {
    return (el && el.ownerDocument) || document;
  }

  function labelledBy(el) {
    const ids = collapse(attr(el, 'aria-labelledby') || '').split(' ').filter(Boolean);
    const doc = docOf(el);
    return ids.map(id => byId(doc, id)).filter(Boolean);
  }

  function labelsFor(el) {
    const out = [];
    if (!el) return out;
    const id = el.id || attr(el, 'id');
    if (id) {
      const doc = docOf(el);
      qsa(doc, 'label[for]').forEach(l => { if (attr(l, 'for') === id) out.push(l); });
    }
    try {
      const wrap = el.closest && el.closest('label');
      if (wrap) out.push(wrap);
    } catch (e) { /* ignore */ }
    return out;
  }

  function wrapperTitle(el) {
    try {
      const wrap = el.closest && el.closest(WRAPPER_SELECTOR);
      if (!wrap) return null;
      const al = labelledBy(wrap);
      if (al.length) return al[0];
      return wrap.querySelector(TITLE_SELECTOR) ||
        qsa(wrap, 'label').find(l => !qsa(l, FIELD_SELECTOR).length) || null;
    } catch (e) {
      return null;
    }
  }

  function isGroup(desc) {
    return (desc.kind === 'radio' || desc.kind === 'checkbox') && Array.isArray(desc.inputs) && desc.inputs.length > 1;
  }

  // Every element that may carry a field's question text or required mark.
  // A group's inputs have option labels ("English"), not the question.
  function labelElements(desc) {
    const el = desc.el;
    const out = [];
    const push = n => { if (n && !out.includes(n)) out.push(n); };
    if (desc.group) labelledBy(desc.group).forEach(push);
    labelledBy(el).forEach(push);
    if (!isGroup(desc)) labelsFor(el).forEach(push);
    push(wrapperTitle(el));
    return out;
  }

  function labelText(l) {
    let title = null;
    try { title = l.querySelector ? l.querySelector(TITLE_SELECTOR) : null; } catch (e) { title = null; }
    return clip(textOf(title || l));
  }

  function labelOf(desc) {
    for (const l of labelElements(desc)) {
      const t = labelText(l);
      if (t && !/^(attach|upload|upload file|choose file|browse)$/i.test(t)) return t;
    }
    const el = desc.el;
    const aria = clip(attr(el, 'aria-label'));
    if (aria) return aria;
    const own = clip(desc.label);
    if (own && own !== collapse(desc.placeholder) && own !== collapse(desc.name)) return own;
    return clip(desc.placeholder || desc.name || attr(el, 'name') || el.id || 'Unlabeled field');
  }

  function markedRequired(node) {
    if (!node) return false;
    const cls = String(attr(node, 'class') || '');
    if (REQUIRED_CLASS_RE.test(cls) && !NOT_REQUIRED_CLASS_RE.test(cls)) return true;
    if (/\*\s*$/.test(textOf(node))) return true;
    return qsa(node, '.required, [class*="required"]').some(n => !NOT_REQUIRED_CLASS_RE.test(String(attr(n, 'class') || '')));
  }

  function ancestorRequired(el) {
    let n = el && el.parentElement;
    for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
      const tag = tagOf(n);
      if (tag === 'form' || tag === 'body') break;
      if (attr(n, 'aria-required') === 'true') return true;
    }
    return false;
  }

  function isRequired(desc) {
    if (desc.required) return true;
    const inputs = desc.inputs || [desc.el];
    if (inputs.some(i => i.required === true || (i.hasAttribute && i.hasAttribute('required')) || attr(i, 'aria-required') === 'true')) return true;
    if (desc.group && attr(desc.group, 'aria-required') === 'true') return true;
    if (labelElements(desc).some(markedRequired)) return true;
    return ancestorRequired(desc.el);
  }

  // Ashby yes/no and similar: a hidden checkbox behind aria-pressed buttons.
  function pressedNearby(el) {
    const box = el && el.parentElement;
    if (!box) return false;
    return qsa(box, '[aria-pressed="true"], [aria-checked="true"]').length > 0;
  }

  // The site often keeps the chosen file only as a name next to the picker.
  function fileShown(el) {
    try {
      const wrap = el.closest('[role="group"], .file-upload, .ashby-application-form-field-entry, .field-wrapper, .application-question, fieldset');
      return !!wrap && FILE_NAME_RE.test(textOf(wrap));
    } catch (e) {
      return false;
    }
  }

  function isFilledLoose(desc, c) {
    let filled = false;
    try { filled = !!c.isFilled(desc); } catch (e) { filled = false; }
    if (filled) return true;
    if (desc.kind === 'checkbox' || desc.kind === 'radio') return pressedNearby(desc.el);
    if (desc.kind === 'file') return fileShown(desc.el);
    return false;
  }

  // --- verification --------------------------------------------------------------
  // Labels of required fields still empty, at most MAX_MISSING.
  function missingRequired(doc) {
    const c = core();
    const root = doc || document;
    if (!c || typeof c.scanFields !== 'function') return [];
    let descs = [];
    try { descs = c.scanFields(root, { includeFilled: true }); } catch (e) { descs = []; }
    const out = [];
    for (const desc of descs) {
      if (!desc || !desc.el) continue;
      const el = desc.el;
      // Greenhouse mirrors each react-select into a hidden required input.
      if (desc.kind !== 'file' && attr(el, 'aria-hidden') === 'true') continue;
      if (!isRequired(desc)) continue;
      if (isFilledLoose(desc, c)) continue;
      const label = labelOf(desc);
      if (!out.includes(label)) out.push(label);
      if (out.length >= MAX_MISSING) break;
    }
    return out;
  }

  // Name of a visible CAPTCHA the user has to solve, or null. Invisible
  // reCAPTCHA keeps its iframes in the page all the time; only a visible
  // challenge or checkbox counts.
  function detectCaptcha(doc) {
    const root = doc || document;
    for (const f of qsa(root, 'iframe')) {
      const src = String(attr(f, 'src') || '').toLowerCase();
      const title = String(attr(f, 'title') || '').toLowerCase();
      let kind = null;
      if (/recaptcha\/(api2|enterprise)\/bframe/.test(src) || /recaptcha challenge/.test(title)) kind = 'reCAPTCHA';
      else if (/recaptcha\/(api2|enterprise)\/anchor/.test(src) && !/size=invisible/.test(src)) kind = 'reCAPTCHA';
      else if (/hcaptcha\.com/.test(src) || /hcaptcha/.test(title)) kind = 'hCaptcha';
      else if (/challenges\.cloudflare\.com/.test(src) || /cloudflare|turnstile/.test(title)) kind = 'Turnstile';
      if (kind && isVisible(f)) return kind;
    }
    for (const w of qsa(root, '.h-captcha, .cf-turnstile, [data-hcaptcha-widget-id]')) {
      if (String(attr(w, 'data-size') || '').toLowerCase() === 'invisible') continue;
      if (isVisible(w)) return w.classList && w.classList.contains('cf-turnstile') ? 'Turnstile' : 'hCaptcha';
    }
    return null;
  }

  function buttonText(el) {
    if (tagOf(el) === 'input') return collapse(attr(el, 'value') || attr(el, 'aria-label') || '');
    return collapse(textOf(el) || attr(el, 'aria-label') || attr(el, 'value') || '');
  }

  function isSubmitType(el) {
    const tag = tagOf(el);
    const type = String(attr(el, 'type') || '').toLowerCase();
    if (tag === 'input') return type === 'submit';
    if (tag !== 'button') return false;
    if (type === 'submit') return true;
    // A bare <button> inside a form submits it.
    if (type) return false;
    try { return !!el.closest('form'); } catch (e) { return false; }
  }

  function siteSubmitSelector(host) {
    if (HOSTS.greenhouse.test(host)) {
      return '#application-form button[type="submit"], #application_form button[type="submit"], ' +
        '#application-form input[type="submit"], #application_form input[type="submit"], #submit_app';
    }
    if (HOSTS.ashby.test(host)) return 'button.ashby-application-form-submit-button';
    if (HOSTS.lever.test(host)) return '#btn-submit, button[data-qa="btn-submit"]';
    return null;
  }

  function fieldCount(form) {
    return qsa(form, FIELD_SELECTOR).length;
  }

  // The one Submit button for this form, or null when there is none or more
  // than one candidate.
  function findSubmit(doc, url) {
    const root = doc || document;
    const sel = siteSubmitSelector(hostOf(url));
    if (sel) {
      const hits = Array.from(new Set(qsa(root, sel)))
        .filter(isVisible)
        .filter(el => !SUBMIT_EXCLUDE_RE.test(buttonText(el)));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null;
    }
    let cands = qsa(root, 'button, input[type="submit"]')
      .filter(isSubmitType)
      .filter(isVisible)
      .filter(el => {
        const t = buttonText(el);
        return SUBMIT_TEXT_RE.test(t) && !SUBMIT_EXCLUDE_RE.test(t);
      });
    if (cands.length > 1) {
      // Keep the ones in the form that holds the most fields.
      const forms = Array.from(new Set(cands.map(el => { try { return el.closest('form'); } catch (e) { return null; } }).filter(Boolean)));
      if (forms.length > 1) {
        const counts = forms.map(fieldCount);
        const max = Math.max.apply(null, counts);
        const best = forms.filter((f, i) => counts[i] === max);
        if (best.length === 1) cands = cands.filter(el => best[0].contains(el));
      }
    }
    return cands.length === 1 ? cands[0] : null;
  }

  function successTextRe() {
    try {
      if (typeof AutoTrackerATS !== 'undefined' && AutoTrackerATS && AutoTrackerATS.DEFAULT_TEXT instanceof RegExp) return AutoTrackerATS.DEFAULT_TEXT;
    } catch (e) { /* not loaded in this frame */ }
    return DEFAULT_SUCCESS_TEXT;
  }

  function containsField(el) {
    return qsa(el, FIELD_SELECTOR).some(f => String(attr(f, 'type') || '').toLowerCase() !== 'hidden');
  }

  // Short visible blocks that read like a confirmation.
  function successTexts(doc) {
    const re = successTextRe();
    const out = new Set();
    for (const el of qsa(doc, TEXT_CANDIDATES)) {
      // textContent first: cheap, and rules out whole-page containers.
      if (String(el.textContent || '').length > 600) continue;
      const t = textOf(el);
      if (!t || t.length > 300 || !re.test(t)) continue;
      if (containsField(el) || !isVisible(el)) continue;
      out.add(t);
    }
    return out;
  }

  function formPresent(doc) {
    const u = ui();
    if (u && typeof u.formSize === 'function' && (!doc || doc === document)) {
      try { return u.formSize() >= MIN_FORM; } catch (e) { /* fall through */ }
    }
    const c = core();
    if (!c || typeof c.scanFields !== 'function') return false;
    try { return c.scanFields(doc || document, { includeFilled: true }).length >= MIN_FORM; } catch (e) { return false; }
  }

  // opts.baseline: confirmation-like texts already on the page before the
  // click; opts.startUrl: the URL at the click. Without them (a fresh page
  // after a reload), URL and text only count once the form is gone, so a
  // company slug like "customer-success" or "once your application is
  // submitted..." under a form is not taken for success.
  function isSuccess(doc, url, opts) {
    const root = doc || document;
    const o = opts || {};
    const u = toUrl(url);
    if (qsa(root, SUCCESS_SELECTOR).some(isVisible)) return true;
    if (u && SUCCESS_URL_RE.test(u.pathname + ' ' + u.hash)) {
      if (o.startUrl && String(o.startUrl) !== u.href) return true;
      if (!formPresent(root)) return true;
    }
    const texts = successTexts(root);
    if (!texts.size) return false;
    if (o.baseline) return Array.from(texts).some(t => !o.baseline.has(t));
    return !formPresent(root);
  }

  // Visible validation problems: fields marked aria-invalid, error text near
  // fields, an alert about a field.
  function errorSignals(doc) {
    const root = doc || document;
    const fields = qsa(root, FIELD_SELECTOR).filter(f => attr(f, 'aria-invalid') === 'true' && isRenderedLoose(f));
    const texts = qsa(root, ERROR_SELECTOR).filter(el => {
      const t = textOf(el);
      if (t.length < 2 || t.length > 200 || containsField(el) || !isVisible(el)) return false;
      if (/error/i.test(String(attr(el, 'class') || '') + ' ' + (el.id || ''))) return true;
      return attr(el, 'role') === 'alert' && ERROR_TEXT_RE.test(t);
    });
    return { fields, texts };
  }

  function newErrors(doc, baseline) {
    const now = errorSignals(doc);
    const seenF = (baseline && baseline.fields) || [];
    const seenT = (baseline && baseline.texts) || [];
    const fields = now.fields.filter(f => !seenF.includes(f));
    const texts = now.texts.filter(t => !seenT.includes(t));
    if (!fields.length && !texts.length) return null;
    const c = core();
    const missing = [];
    for (const f of fields) {
      let desc = null;
      try { desc = c && c.describeField ? c.describeField(f) : null; } catch (e) { desc = null; }
      const label = labelOf(desc || { el: f, label: '', name: attr(f, 'name') || '' });
      if (!missing.includes(label)) missing.push(label);
      if (missing.length >= MAX_MISSING) break;
    }
    const reason = fields.length
      ? (fields.length === 1 ? '1 field shows an error' : fields.length + ' fields show errors')
      : 'Form error: ' + clip(textOf(texts[0]), 60);
    return { reason, missing };
  }

  // --- waiting -------------------------------------------------------------------
  // Resolves with the first truthy check() result, or null at the deadline.
  // Re-checks on DOM mutations (throttled) and on a polling backstop.
  function waitUntil(check, timeoutMs) {
    return new Promise(resolve => {
      const deadline = Date.now() + Math.max(0, timeoutMs);
      let done = false;
      let obs = null;
      let pollTimer = null;
      let mutTimer = null;
      let lastRun = 0;
      const finish = v => {
        if (done) return;
        done = true;
        if (obs) { try { obs.disconnect(); } catch (e) { /* gone */ } }
        clearTimeout(pollTimer);
        clearTimeout(mutTimer);
        resolve(v || null);
      };
      const run = () => {
        if (done) return;
        lastRun = Date.now();
        let v = null;
        try { v = check(); } catch (e) { v = null; }
        if (v) return finish(v);
        if (Date.now() >= deadline) finish(null);
      };
      const poll = () => {
        if (done) return;
        run();
        if (!done) pollTimer = setTimeout(poll, Math.max(1, Math.min(timing.poll, deadline - Date.now())));
      };
      const onMutation = () => {
        if (done || mutTimer) return;
        const gap = timing.throttle - (Date.now() - lastRun);
        if (gap <= 0) { run(); return; }
        mutTimer = setTimeout(() => { mutTimer = null; run(); }, gap);
      };
      try {
        if (typeof MutationObserver !== 'undefined' && document.documentElement) {
          obs = new MutationObserver(onMutation);
          obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        }
      } catch (e) { obs = null; }
      poll();
    });
  }

  // --- messaging -----------------------------------------------------------------
  function send(msg) {
    return new Promise(resolve => {
      if (!alive()) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage(msg, res => {
          let err = null;
          try { err = chrome.runtime.lastError; } catch (e) { err = e; }
          resolve(err ? null : (res === undefined ? null : res));
        });
      } catch (e) {
        // Extension context invalidated (reloaded under this page).
        resolve(null);
      }
    });
  }

  async function update(status, extra) {
    const msg = Object.assign({ type: 'LIT_BATCH_UPDATE', status }, extra || {});
    if (Array.isArray(msg.missing)) msg.missing = msg.missing.slice(0, MAX_MISSING).map(s => clip(s));
    state.sent.push(status);
    const res = await send(msg);
    const ok = !!(res && res.ok === true);
    if (ok) {
      state.status = status;
      if (extra && typeof extra.reason === 'string') state.reason = extra.reason;
    }
    return ok;
  }

  async function claim() {
    if (claimed) return true;
    claimed = await update('filling');
    if (!claimed) state.phase = 'stopped';
    return claimed;
  }

  async function end(status, reason, extra) {
    const payload = Object.assign({ reason }, extra || {});
    state.reason = reason;
    if (Array.isArray(payload.missing)) state.missing = payload.missing.slice();
    const ok = await update(status, payload);
    state.phase = ok ? 'done' : 'stopped';
    return state;
  }

  // --- session flags (survive a reload in this tab, per origin) ----------------
  function flag(name, jobId, value) {
    const key = 'lit_aa_' + name + '_' + jobId;
    try {
      const ss = window.sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
      if (!ss) return null;
      if (value === undefined) return ss.getItem(key);
      ss.setItem(key, String(value));
    } catch (e) { /* storage blocked */ }
    return null;
  }

  // --- getting to the form -------------------------------------------------------
  function formUrlFix(u) {
    if (!u) return null;
    const host = u.hostname.toLowerCase();
    const parts = u.pathname.split('/').filter(Boolean);
    if (HOSTS.ashby.test(host)) {
      if (parts.length < 2 || parts[parts.length - 1] === 'application') return null;
      if (parts.length > 2) return null;
      return u.origin + '/' + parts.join('/') + '/application' + u.search;
    }
    if (HOSTS.lever.test(host)) {
      if (parts.length !== 2) return null;
      return u.origin + '/' + parts.join('/') + '/apply' + u.search;
    }
    return null;
  }

  function navigate(url) {
    const l = loc();
    if (l && typeof l.assign === 'function') l.assign(url);
    else if (l) l.href = url;
  }

  function findApplyButton(doc) {
    const root = doc || document;
    for (const el of qsa(root, 'a, button, [role="button"], input[type="button"], input[type="submit"]')) {
      const t = buttonText(el).replace(/[.!]+$/, '');
      if (!APPLY_RE.test(t)) continue;
      const aria = String(attr(el, 'aria-label') || '');
      if (aria && /linkedin|indeed|autofill|sign in|log in/i.test(aria)) continue;
      if (tagOf(el) === 'a') {
        if (String(attr(el, 'target') || '').toLowerCase() === '_blank') continue;
        if (SIGNIN_HREF_RE.test(String(attr(el, 'href') || ''))) continue;
      }
      if (isDisabled(el) || !isVisible(el)) continue;
      return el;
    }
    return null;
  }

  async function waitForForm(job) {
    const start = Date.now();
    return waitUntil(() => {
      if (formPresent(document)) return true;
      if (!state.applyClicked && !flag('apply', job.jobId) && Date.now() - start >= timing.applyGrace) {
        const btn = findApplyButton(document);
        if (btn) {
          state.applyClicked = true;
          flag('apply', job.jobId, 1);
          try { btn.click(); } catch (e) { /* page handler threw */ }
        }
      }
      return null;
    }, timing.formWait);
  }

  // --- filling -------------------------------------------------------------------
  async function fallbackFill() {
    const c = core();
    if (!c || typeof c.run !== 'function' || typeof AutofillStore === 'undefined' || !AutofillStore) return null;
    const s = AutofillStore;
    const safe = async (fn, d) => { try { const v = await fn(); return v === undefined ? d : v; } catch (e) { return d; } };
    const [profile, rules, answers, resume, settings] = await Promise.all([
      safe(() => s.getProfile(), {}), safe(() => s.getRules(), []), safe(() => s.getAnswers(), []),
      safe(() => s.getResume(), null), safe(() => s.getSettings(), null)
    ]);
    return c.run({
      profile, rules, answers, resume,
      settings: Object.assign({ showButton: true, fillEeo: false, autoLearn: true }, settings || {}),
      host: hostOf()
    });
  }

  async function fillOnce() {
    const u = ui();
    let report = null;
    if (u && typeof u.fill === 'function') {
      try { report = await u.fill(); } catch (e) { report = null; }
      // null: a run already in progress (the user clicked) or a dead context.
      if (report) return report;
      if (!alive()) return null;
    }
    try { return await fallbackFill(); } catch (e) { return null; }
  }

  function filledCount(report) {
    return report && Array.isArray(report.filled) ? report.filled.length : 0;
  }

  // --- the run -------------------------------------------------------------------
  async function checkOnly() {
    state.phase = 'checking';
    const res = await waitUntil(() => {
      if (isSuccess(document, currentUrl())) return { status: 'submitted', reason: 'Submitted' };
      if (detectCaptcha(document)) return { status: 'needs-you', reason: 'CAPTCHA' };
      const err = newErrors(document, null);
      if (err) return { status: 'needs-you', reason: err.reason, missing: err.missing };
      return null;
    }, timing.successWait);
    if (!res) return end('needs-you', 'Submitted but no confirmation seen');
    return end(res.status, res.reason, res.missing ? { missing: res.missing } : undefined);
  }

  async function afterClick(baseline) {
    const clickedAt = Date.now();
    const res = await waitUntil(() => {
      if (isSuccess(document, currentUrl(), { baseline: baseline.texts, startUrl: baseline.url })) return { status: 'submitted', reason: 'Submitted' };
      if (detectCaptcha(document)) return { status: 'needs-you', reason: 'CAPTCHA' };
      if (Date.now() - clickedAt >= timing.errorGrace) {
        const err = newErrors(document, baseline.errors);
        if (err) return { status: 'needs-you', reason: err.reason, missing: err.missing };
      }
      return null;
    }, timing.successWait);
    if (!res) return end('needs-you', 'Submitted but no confirmation seen', { filled: state.filled });
    return end(res.status, res.reason, Object.assign({ filled: state.filled }, res.missing ? { missing: res.missing } : {}));
  }

  async function drive(job, mode) {
    state.job = job;
    state.mode = mode === 'fill-only' ? 'fill-only' : 'submit';
    state.reason = '';
    claimed = job.status === 'filling' || job.status === 'submitting';

    // Never click twice: after our click only success is checked.
    if (job.status === 'submitting' || flag('clicked', job.jobId)) return checkOnly();
    if (job.status !== 'opening' && job.status !== 'filling') { state.phase = 'inactive'; return state; }

    const url = currentUrl();
    if (url && HOSTS.workday.test(url.hostname.toLowerCase())) {
      if (!await claim()) return state;
      return end('needs-you', 'Workday needs you to sign in');
    }

    const fix = formUrlFix(url);
    if (fix && !flag('nav', job.jobId)) {
      flag('nav', job.jobId, 1);
      state.phase = 'navigating';
      navigate(fix);
      return state;
    }

    state.phase = 'waiting-form';
    const found = await waitForForm(job);
    if (!alive()) { state.phase = 'dead'; return state; }
    if (!found) {
      // A login wall in this frame is worth saying; otherwise another frame
      // may own the form and the background timeout covers the rest.
      const pw = qsa(document, 'input[type="password"]').some(isVisible);
      if (pw && await claim()) return end('needs-you', 'Sign-in required');
      state.phase = 'no-form';
      return state;
    }

    if (!await claim()) return state;

    state.phase = 'filling';
    let filled = filledCount(await fillOnce());
    await sleep(timing.refillDelay);
    if (!alive()) { state.phase = 'dead'; return state; }
    filled += filledCount(await fillOnce());
    state.filled = filled;
    await sleep(timing.settle);

    state.phase = 'verifying';
    const missing = missingRequired(document);
    state.missing = missing;
    if (detectCaptcha(document)) return end('needs-you', 'CAPTCHA', { filled, missing });
    if (missing.length) {
      const reason = missing.length === 1 ? '1 required field needs you' : missing.length + ' required fields need you';
      return end('needs-you', reason, { filled, missing });
    }
    if (state.mode === 'fill-only') return end('ready', 'Filled. Review and submit.', { filled, missing: [] });

    const btn = findSubmit(document, currentUrl());
    if (!btn) return end('needs-you', 'Could not find Submit', { filled, missing: [] });
    if (isDisabled(btn)) return end('needs-you', 'Submit is disabled', { filled, missing: [] });

    const startUrl = currentUrl();
    const baseline = { texts: successTexts(document), errors: errorSignals(document), url: startUrl ? startUrl.href : '' };
    state.phase = 'submitting';
    if (!await update('submitting', { filled })) { state.phase = 'stopped'; return state; }
    flag('clicked', job.jobId, 1);
    state.submitClicks++;
    try { btn.click(); } catch (e) { /* page handler threw; the wait decides */ }
    return afterClick(baseline);
  }

  function run(job, mode) {
    if (current) return current;
    if (!job || !job.jobId) return Promise.resolve(state);
    current = (async () => {
      try {
        return await drive(job, mode);
      } catch (e) {
        if (claimed) await end('failed', clip('Error: ' + ((e && e.message) || 'unknown'), 80));
        else state.phase = 'stopped';
        return state;
      } finally {
        current = null;
      }
    })();
    return current;
  }

  async function hello() {
    if (!alive()) { state.phase = 'inactive'; return state; }
    state.phase = 'hello';
    const res = await send({ type: 'LIT_BATCH_HELLO' });
    const job = res && res.job;
    if (!job || !job.jobId) { state.phase = 'inactive'; return state; }
    return run(job, res.mode);
  }

  let started = null;

  const api = {
    timing,
    state: () => Object.assign({}, state, { missing: state.missing.slice(), sent: state.sent.slice() }),
    run,
    // Resolves when the current run (or the HELLO) settles.
    whenDone: () => current || started || Promise.resolve(state),
    findSubmit,
    missingRequired,
    detectCaptcha,
    isSuccess,
    findApplyButton,
    formUrlFix
  };

  window.__litAutoApply = api;
  started = hello();

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
