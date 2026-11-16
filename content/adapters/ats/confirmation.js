// Shared factory for ATS "application submitted" adapters.
//
// Every applicant tracking system ends an application the same way: a
// confirmation URL, a confirmation element, or a "thank you for applying"
// message rendered in place. A concrete adapter only declares which of those
// it uses and how to read the company and role; this file owns detection.
//
// What the job is, and whether a submit just happened, are both remembered
// outside the page (module state for SPA route changes, session storage for
// full page loads), because the confirmation screen itself rarely says which
// role it is for:
//   seen    The company and role read from the posting or the form, keyed by
//           the listing id. Refreshed on mount and on every button press.
//   arm     The last button press or form submit on this site. Valid for five
//           minutes.
//
// Two detection paths:
//   URL        The page is at a confirmation URL (Greenhouse /confirmation,
//              Lever /thanks). Logged on arrival. A reload or a restored tab
//              is not an arrival and logs nothing.
//   In place   After an arm, a confirmation element or message appears: a new
//              node, a text change, or a hidden block being revealed. A
//              message that was already visible when the button was pressed
//              is ignored. After a full page load that follows an arm, a
//              message already on the page counts.
const AutoTrackerATS = (() => {
  if (typeof AutoTrackerCore === 'undefined') return null;
  const core = AutoTrackerCore;
  const meta = typeof JobMeta !== 'undefined' ? JobMeta : null;

  const ARM_WINDOW_MS = 5 * 60 * 1000;
  const SEEN_STORE_KEY = 'pt_ats_seen';
  const SEEN_TTL_MS = 12 * 60 * 60 * 1000;
  const SEEN_MAX = 40;
  const MAX_TEXT = 400;
  const MAX_SCAN = 1500;
  const CANDIDATE_SELECTOR = 'h1, h2, h3, h4, p, span, strong, li, [role="alert"], [role="status"], [role="dialog"], [aria-live], [class*="confirm"], [class*="success"], [class*="thank"], [class*="submitted"], [data-automation-id]';
  const INTERACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"], a[class*="submit"], a[class*="btn"], a[class*="button"]';
  const DEFAULT_TEXT = /thank(s| you) for (applying|your (job )?application|submitting)|application (has been |was |is )?(successfully )?(submitted|received|sent|complete)|we('ve| have)? (successfully )?(received|got) your (job )?application|successfully (submitted|applied)/i;
  const GENERIC_HEADING = /^(thank you|thanks|application (submitted|received|complete)|success|congratulations)/i;
  const OBSERVE_OPTIONS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] };

  // "Role at Company", "Role @ Company", "Company - Role", "Role | Company".
  // Returns whatever it can; callers fall back per field. A role may itself
  // contain " at " ("Engineer at Scale @ Acme"), so the last one splits.
  function parseTitle(title, options = {}) {
    const raw = String(title || '').replace(/\s+/g, ' ').trim();
    if (!raw) return { role: '', company: '' };
    const cleaned = raw.replace(/^job application for\s+/i, '').replace(/\s*[-|]\s*(careers?|jobs?|job board|apply)\s*$/i, '');
    const company = v => v.trim().replace(/\s+(careers?|jobs?|job board)$/i, '');
    let m = cleaned.match(/^(.+)\s+@\s+(.+)$/) || cleaned.match(/^(.+)\s+at\s+(.+)$/i);
    if (m) return { role: m[1].trim(), company: company(m[2]) };
    m = cleaned.match(/^(.+?)\s+[-|]\s+(.+)$/);
    if (m) {
      return options.companyFirst
        ? { company: company(m[1]), role: m[2].trim() }
        : { role: m[1].trim(), company: company(m[2]) };
    }
    return { role: cleaned, company: '' };
  }

  function isGeneric(text) {
    return GENERIC_HEADING.test(text) || DEFAULT_TEXT.test(text) || (meta ? meta.isGenericHeading(text) : false);
  }

  function firstText(doc, selectors) {
    for (const sel of [].concat(selectors || [])) {
      const el = doc.querySelector(sel);
      const text = core.textOf(el);
      if (text && text.length <= 200 && !isGeneric(text)) return text;
    }
    return '';
  }

  function tidyCompany(value) {
    const s = String(value || '').replace(/\s+/g, ' ').trim();
    return meta ? meta.cleanCompany(s) : s.slice(0, 60);
  }

  function tidyRole(value, company) {
    const s = String(value || '').replace(/\s+/g, ' ').trim();
    if (!s || isGeneric(s)) return '';
    return meta ? meta.cleanRole(s, company) : s.slice(0, 80);
  }

  function isInteraction(event) {
    const t = event && event.target;
    if (!t) return false;
    if (event.type === 'submit') return true;
    return typeof t.closest === 'function' && !!t.closest(INTERACTION_SELECTOR);
  }

  // Laid out at all. Environments without layout count everything as visible.
  function isVisible(el) {
    if (!el || typeof el.getClientRects !== 'function') return true;
    try { return el.getClientRects().length > 0; } catch (e) { return true; }
  }

  // A reload, a back/forward step, or a restored tab re-shows a page; only a
  // fresh navigation is an arrival.
  function isFreshNavigation(win) {
    try {
      const perf = win && win.performance;
      const entry = perf && typeof perf.getEntriesByType === 'function' ? perf.getEntriesByType('navigation')[0] : null;
      return !entry || !entry.type || entry.type === 'navigate';
    } catch (e) {
      return true;
    }
  }

  // --- memory shared by every adapter in this frame -------------------------
  // { '<adapter>|<origin>|<item id>': { company, role, id, url, at, armedAt } }
  let seen = {};
  let seenLoaded = null;

  function loadSeen() {
    if (seenLoaded) return seenLoaded;
    seenLoaded = core.sessionGet(SEEN_STORE_KEY).then(stored => {
      if (stored && typeof stored === 'object') {
        // What this page has learned since it loaded wins over the stored copy.
        seen = Object.assign({}, stored, seen);
      }
    }, () => {});
    return seenLoaded;
  }

  function saveSeen() {
    const cutoff = core.nowMs() - SEEN_TTL_MS;
    const keys = Object.keys(seen).filter(k => seen[k] && seen[k].at >= cutoff).sort((a, b) => seen[b].at - seen[a].at).slice(0, SEEN_MAX);
    const next = {};
    keys.forEach(k => { next[k] = seen[k]; });
    seen = next;
    return loadSeen().then(() => core.sessionSet(SEEN_STORE_KEY, seen)).catch(() => false);
  }

  function createConfirmationAdapter(spec) {
    const confirmation = spec.confirmation || {};
    const urlRe = confirmation.url || null;
    const selectors = confirmation.selectors || '';
    const textRe = confirmation.text || DEFAULT_TEXT;
    const prefix = spec.id + '|';

    const fresh = at => Number.isFinite(at) && at > 0 && core.nowMs() - at <= ARM_WINDOW_MS;

    function isSuccessText(text) {
      if (!text || text.length > MAX_TEXT) return false;
      return textRe.test(text) || DEFAULT_TEXT.test(text) || (meta ? meta.isSuccessText(text) : false);
    }

    function readDetails(url, doc) {
      const ld = meta ? (meta.readJsonLd(doc)[0] || null) : null;
      const company = tidyCompany((ld && ld.company) || spec.company(url, doc));
      const role = tidyRole(ld && ld.title, company) || tidyRole(spec.role(url, doc), company);
      const id = spec.itemId ? String(spec.itemId(url, doc) || '') : '';
      return { company, role, id };
    }

    function keyFor(url, id) {
      return prefix + url.origin + '|' + (id || '');
    }

    // The newest record for this adapter on this origin, armed ones first.
    function latestOnOrigin(url, armedOnly) {
      const start = prefix + url.origin + '|';
      let best = null;
      Object.keys(seen).forEach(k => {
        const r = seen[k];
        if (k.indexOf(start) !== 0 || !r) return;
        if (armedOnly && !fresh(r.armedAt)) return;
        const stamp = armedOnly ? r.armedAt : r.at;
        if (!best || stamp > (armedOnly ? best.armedAt : best.at)) best = r;
      });
      return best;
    }

    // Records what this page says about the job. A page that knows less than
    // an earlier one (a confirmation screen) never overwrites it.
    function remember(url, doc, armed) {
      const here = readDetails(url, doc);
      const key = keyFor(url, here.id);
      const prev = seen[key] || {};
      const next = {
        company: here.company || prev.company || '',
        role: here.role || prev.role || '',
        id: here.id,
        at: core.nowMs(),
        armedAt: armed ? core.nowMs() : (prev.armedAt || 0)
      };
      if (!next.company && !next.role && !next.armedAt && !here.id) return here;
      seen[key] = next;
      saveSeen();
      return here;
    }

    function buildPayload(url, doc) {
      const here = readDetails(url, doc);
      const exact = here.id ? seen[keyFor(url, here.id)] : null;
      // Without a listing id in the URL, the form the user just submitted on
      // this site is the best witness.
      const recent = exact || latestOnOrigin(url, true) || seen[keyFor(url, '')] || null;
      const company = (recent && recent.company) || here.company;
      const role = (recent && recent.role) || here.role;
      const id = here.id || (recent && recent.id) || '';
      return {
        id: id || core.slugify(`${company} ${role}`) || url.pathname,
        title: [role, company].filter(Boolean).join(' at ') || core.humanizeSlug(spec.id),
        company,
        role
      };
    }

    function disarm(url) {
      const start = prefix + url.origin + '|';
      Object.keys(seen).forEach(k => { if (k.indexOf(start) === 0 && seen[k]) seen[k].armedAt = 0; });
      saveSeen();
    }

    function init(onSuccess, ctx) {
      const doc = ctx.document;
      const url = ctx.url;
      const root = doc.body || doc.documentElement;
      const cleanup = core.createCleanup();
      const baseline = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
      const isUrlConfirmation = !!(urlRe && urlRe.test(url.pathname + url.search));
      let fired = false;
      let watching = false;

      const isArmed = () => !!latestOnOrigin(url, true);

      const fire = () => {
        if (fired) return;
        fired = true;
        cleanup();
        const payload = buildPayload(url, doc);
        disarm(url);
        onSuccess(payload);
      };

      // First confirmation under `node` that was not already on screen when
      // the user pressed the button.
      function findConfirmation(node, collect) {
        if (!node || node.nodeType !== 1) return null;
        const counts = el => isVisible(el) && !(baseline && baseline.has(el));
        const hits = [];
        const take = el => {
          if (!counts(el)) return false;
          hits.push(el);
          return !collect;
        };
        if (selectors) {
          if (typeof node.matches === 'function' && node.matches(selectors) && take(node)) return node;
          let marked = [];
          try { marked = node.querySelectorAll(selectors); } catch (e) { marked = []; }
          for (let i = 0; i < marked.length; i++) if (take(marked[i])) return marked[i];
        }
        if (isSuccessText(core.textOf(node)) && take(node)) return node;
        let nodes = [];
        try { nodes = node.querySelectorAll(CANDIDATE_SELECTOR); } catch (e) { nodes = []; }
        for (let i = 0; i < nodes.length && i < MAX_SCAN; i++) {
          if (isSuccessText(core.textOf(nodes[i])) && take(nodes[i])) return nodes[i];
        }
        return collect ? hits : null;
      }

      function onRecords(records) {
        if (fired || !isArmed()) return;
        for (const record of records) {
          const added = record.addedNodes || [];
          for (let i = 0; i < added.length; i++) {
            if (findConfirmation(added[i])) { fire(); return; }
          }
          if (record.type === 'characterData' || record.type === 'attributes') {
            let target = record.target;
            if (target && target.nodeType !== 1) target = target.parentElement || target.parentNode;
            if (findConfirmation(target)) { fire(); return; }
            // A text change inside a heading: the heading is the message.
            const parent = target && record.type === 'characterData' ? target.parentElement : null;
            if (parent && isSuccessText(core.textOf(parent)) && isVisible(parent) && !(baseline && baseline.has(parent))) { fire(); return; }
          }
        }
      }

      // Nothing is observed until the user acts.
      function startWatching() {
        if (watching || fired) return;
        watching = true;
        cleanup.add(core.observe(root, onRecords, OBSERVE_OPTIONS));
      }

      function arm() {
        if (fired) return;
        if (baseline) {
          const existing = findConfirmation(root, true) || [];
          existing.forEach(el => baseline.add(el));
        }
        remember(url, doc, true);
        startWatching();
      }

      cleanup.add(core.listen(root, 'submit', event => { if (isInteraction(event)) arm(); }));
      cleanup.add(core.listen(root, 'click', event => { if (isInteraction(event)) arm(); }));

      if (!isUrlConfirmation) remember(url, doc, false);

      // An arm from before this mount: an SPA route change, or a full page
      // load after the submit.
      const resume = () => {
        if (fired || cleanup.isDone()) return;
        const armed = isArmed();
        if (isUrlConfirmation) {
          if (armed || isFreshNavigation(ctx.window)) fire();
          return;
        }
        if (!armed) return;
        if (findConfirmation(root)) { fire(); return; }
        startWatching();
      };

      if (isArmed()) resume();
      if (!fired) loadSeen().then(resume, resume);
      return cleanup;
    }

    return {
      id: spec.id,
      label: spec.label || spec.id,
      metricId: 'jobs',
      matches: url => spec.hosts.test(url.hostname) && (!spec.paths || spec.paths.test(url.pathname)),
      // Pathname is the route key on purpose: an SPA that pushes /confirmation
      // remounts and takes the definitive URL path instead of relying on text.
      routeKey: spec.routeKey || (url => url.pathname),
      init,
      _internals: { buildPayload, readDetails, isSuccessText, ARM_WINDOW_MS }
    };
  }

  return {
    createConfirmationAdapter,
    parseTitle,
    firstText,
    isInteraction,
    ARM_WINDOW_MS,
    SEEN_STORE_KEY,
    DEFAULT_TEXT,
    _reset() { seen = {}; seenLoaded = null; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoTrackerATS;
}
