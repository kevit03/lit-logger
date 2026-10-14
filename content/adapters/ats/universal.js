// Universal adapter: detects a submitted job application on any career site
// the dedicated adapters do not cover (Workable, Taleo, iCIMS, BambooHR,
// Rippling, SmartRecruiters, Jobvite, JazzHR, Breezy, Recruitee, Pinpoint,
// and companies' own careers pages).
//
// Detection is gated twice:
//   Intent      The user submitted a form or pressed a Submit / Apply / Send
//               application control within the last five minutes. Nothing is
//               observed before that. The mark survives an SPA route change
//               (module state) and a full page load on the same site
//               (chrome.storage.session), so a POST-and-redirect to a
//               /thank-you page still counts.
//   Job page    JobMeta.jobSignals scores the page (ATS host, careers path,
//               JSON-LD JobPosting, a resume upload, application wording). A
//               newsletter, a checkout, a password reset, or a blog comment
//               never reaches the threshold, and success wording about an
//               order or a subscription is rejected outright.
// Then either signal confirms:
//   URL         navigation to a confirmation route (/thank-you, /confirmation,
//               /application-submitted, ...). With no recent intent, a
//               confirmation route only counts if the page also shows the
//               success message and scores as a job page.
//   Message     a success message ("Thank you for applying", "Application
//               submitted") rendered in a heading, alert, status region,
//               dialog, or inside an open shadow root.
(() => {
  if (typeof AutoTrackerCore === 'undefined' || typeof JobMeta === 'undefined') return;
  const core = AutoTrackerCore;
  const meta = JobMeta;

  const ARM_WINDOW_MS = 5 * 60 * 1000;
  const CONFIRM_WATCH_MS = 20 * 1000;
  const ARM_STORE_KEY = 'pt_universal_arm';
  const CANDIDATE_SELECTOR = 'h1, h2, h3, h4, p, [role="alert"], [role="status"], [role="dialog"], [aria-live], dialog, [class*="confirm"], [class*="success"], [class*="thank"], [class*="submitted"], [class*="modal"], [class*="Modal"], [class*="toast"], [class*="notification"], [data-automation-id]';
  const LIVE_SELECTOR = '[role="alert"], [role="status"], [aria-live], [role="dialog"], dialog';
  const INTERACTION_SELECTOR = 'button, [role="button"], input[type="submit"], input[type="button"], a[role="button"], a[class*="button"], a[class*="btn"]';
  const INTERACTION_TEXT = /\b(submit|apply|send( my)? application|send|complete( my)? application|finish|confirm)\b/i;
  const COMPANY_RANK = { 'json-ld': 3, 'og:site_name': 2, domain: 1, '': 0 };
  const ROLE_RANK = { 'json-ld': 4, 'og:title': 3, heading: 2, title: 1, '': 0 };

  // The last intent on this page, kept across SPA remounts.
  let lastArm = null;

  function labelOf(el) {
    const parts = [core.textOf(el)];
    if (el.value && typeof el.value === 'string') parts.push(el.value);
    if (el.getAttribute) {
      parts.push(el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('value') || '');
    }
    return parts.filter(Boolean).join(' ').slice(0, 200);
  }

  // A click inside a web component reaches the document retargeted to the
  // component's host; composedPath() still names the real button when the
  // shadow root is open.
  function isInteraction(event) {
    if (!event || !event.target) return false;
    if (event.type === 'submit') return true;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    const candidates = path && path.length ? path.slice(0, 12) : [event.target];
    for (const node of candidates) {
      if (!node || typeof node.closest !== 'function') continue;
      const el = node.closest(INTERACTION_SELECTOR);
      if (el) return INTERACTION_TEXT.test(labelOf(el));
    }
    return false;
  }

  function freshArm(arm, origin) {
    return arm && arm.origin === origin && Number.isFinite(arm.at) && core.nowMs() - arm.at <= ARM_WINDOW_MS ? arm : null;
  }

  async function readArm(origin) {
    const all = await core.sessionGet(ARM_STORE_KEY);
    return all && typeof all === 'object' ? freshArm(all[origin], origin) : null;
  }

  async function writeArm(origin, arm) {
    const all = (await core.sessionGet(ARM_STORE_KEY)) || {};
    const next = {};
    Object.keys(all).forEach(o => { if (freshArm(all[o], o)) next[o] = all[o]; });
    if (arm) next[origin] = arm; else delete next[origin];
    return core.sessionSet(ARM_STORE_KEY, next);
  }

  // Open shadow roots under `root`, depth-first, capped so a huge page costs
  // a bounded walk.
  function collectShadowRoots(root, cap) {
    const out = [];
    const stack = root ? [root] : [];
    let visited = 0;
    while (stack.length && visited < 5000 && out.length < (cap || 20)) {
      const node = stack.pop();
      visited++;
      if (!node) continue;
      if (node.shadowRoot) {
        out.push(node.shadowRoot);
        stack.push(node.shadowRoot);
      }
      const kids = node.children;
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  }

  function findSuccess(root) {
    const roots = [root].concat(collectShadowRoots(root, 20));
    for (const r of roots) {
      if (!r || typeof r.querySelectorAll !== 'function') continue;
      const nodes = r.querySelectorAll(CANDIDATE_SELECTOR);
      for (let i = 0; i < nodes.length && i < 400; i++) {
        if (meta.isSuccessText(core.textOf(nodes[i]))) return nodes[i];
      }
    }
    return null;
  }

  // Field by field, keeps the better-sourced value: the listing's JSON-LD
  // beats a later form step's heading, and anything beats a thank-you page
  // that knows nothing. Ties go to `primary`.
  function pick(a, b, field, sourceField, rank) {
    const ra = a[field] ? (rank[a[sourceField] || ''] || 0) : -1;
    const rb = b[field] ? (rank[b[sourceField] || ''] || 0) : -1;
    return rb > ra ? b : a;
  }

  function mergeDetails(primary, fallback) {
    const a = primary || {};
    const b = fallback || {};
    const c = pick(a, b, 'company', 'companySource', COMPANY_RANK);
    const r = pick(a, b, 'role', 'roleSource', ROLE_RANK);
    return {
      company: c.company || '',
      companySource: c.companySource || '',
      role: r.role || '',
      roleSource: r.roleSource || '',
      sourceId: a.sourceId || b.sourceId || '',
      url: a.url || b.url || ''
    };
  }

  function siteName(url) {
    const ats = meta.atsFor(url.hostname);
    return ats ? ats.name : url.hostname.replace(/^www\./, '');
  }

  function buildPayload(details, url, reason) {
    const company = String(details.company || '').trim();
    const role = String(details.role || '').trim();
    const title = [role, company].filter(Boolean).join(' at ');
    return {
      id: details.sourceId || meta.sourceIdFor(url, null),
      title: title || 'Job application',
      company,
      role,
      url: details.url || (url.origin + url.pathname),
      notes: 'Auto-logged from ' + siteName(url) + (title ? ' | ' + title : ''),
      meta: { detection: reason }
    };
  }

  function init(onSuccess, ctx) {
    const doc = ctx.document;
    const url = ctx.url;
    const origin = url.origin;
    const root = doc.body || doc.documentElement;
    const cleanup = core.createCleanup();
    let fired = false;
    let watching = false;

    const currentArm = () => freshArm(lastArm, origin);
    const jobScoreHere = () => meta.jobSignals(doc, url).score;
    const jobOk = arm => Math.max(arm ? arm.jobScore : -Infinity, jobScoreHere()) >= meta.JOB_THRESHOLD;

    function fire(reason, arm) {
      if (fired) return;
      fired = true;
      const details = mergeDetails(arm && arm.details, meta.extract(doc, url));
      lastArm = null;
      writeArm(origin, null).catch(() => {});
      cleanup();
      onSuccess(buildPayload(details, url, reason));
    }

    function arm() {
      if (fired) return;
      const prev = currentArm();
      const here = meta.extract(doc, url);
      lastArm = {
        at: core.nowMs(),
        origin,
        href: url.href,
        jobScore: Math.max(jobScoreHere(), prev ? prev.jobScore : -Infinity),
        details: mergeDetails(here, prev && prev.details)
      };
      writeArm(origin, lastArm).catch(() => {});
      startWatching();
    }

    const successTest = text => !!currentArm() && meta.isSuccessText(text) && jobOk(currentArm());
    const onMatch = () => fire('message', currentArm());

    function watchRoot(r, tracked) {
      cleanup.add(core.waitForText(CANDIDATE_SELECTOR, { root: r, maxTracked: tracked, test: successTest, onMatch }));
    }

    // Starts only after the first interaction: until the user acts, there is
    // nothing to confirm and nothing is observed.
    function startWatching() {
      if (watching || fired) return;
      watching = true;
      watchRoot(root, 6);
      // Live regions and dialogs already on the page update in place.
      let live = [];
      try { live = root.querySelectorAll(LIVE_SELECTOR); } catch (e) { live = []; }
      for (let i = 0; i < live.length && i < 10; i++) {
        const node = live[i];
        cleanup.add(core.observe(node, () => {
          if (successTest(core.textOf(node))) onMatch();
        }, { childList: true, subtree: true, characterData: true }));
      }
      // Web components: their messages render inside shadow roots that a
      // document observer cannot see into.
      const seen = new Set();
      const watchShadows = node => {
        collectShadowRoots(node, 10).forEach(sr => {
          if (seen.has(sr)) return;
          seen.add(sr);
          watchRoot(sr, 4);
          const hit = findSuccess(sr);
          if (hit && successTest(core.textOf(hit))) onMatch();
        });
      };
      watchShadows(root);
      cleanup.add(core.observe(root, records => {
        for (const record of records) {
          const added = record.addedNodes || [];
          for (let i = 0; i < added.length; i++) {
            if (added[i] && added[i].nodeType === 1) watchShadows(added[i]);
          }
        }
      }, { childList: true, subtree: true }));
    }

    function confirmWithoutIntent() {
      if (fired || cleanup.isDone()) return;
      if (!meta.jobSignals(doc, url).isJob) return;
      if (findSuccess(root)) {
        fire('url+message', null);
        return;
      }
      // The message may render a beat after the route change.
      const stop = core.waitForText(CANDIDATE_SELECTOR, {
        root,
        maxTracked: 4,
        test: text => meta.isSuccessText(text),
        onMatch: () => fire('url+message', null)
      });
      cleanup.add(stop);
      const timer = setTimeout(stop, CONFIRM_WATCH_MS);
      cleanup.add(() => clearTimeout(timer));
    }

    cleanup.add(core.listen(root, 'submit', event => { if (isInteraction(event)) arm(); }));
    cleanup.add(core.listen(root, 'click', event => { if (isInteraction(event)) arm(); }));

    if (meta.isConfirmationUrl(url)) {
      const inPage = currentArm();
      if (inPage && jobOk(inPage)) {
        fire('url', inPage);
        return cleanup;
      }
      readArm(origin).then(stored => {
        if (fired || cleanup.isDone()) return;
        if (stored && jobOk(stored)) {
          lastArm = stored;
          fire('url', stored);
          return;
        }
        confirmWithoutIntent();
      }).catch(() => confirmWithoutIntent());
    } else if (currentArm()) {
      // An SPA step change remounted us mid-application; keep watching.
      startWatching();
    }

    return cleanup;
  }

  core.registerAdapter({
    id: 'universal',
    label: 'Career site',
    metricId: 'jobs',
    matches: url => /^https?:$/.test(url.protocol),
    // Hash and query routes remount too: many career SPAs route by hash or
    // step parameter, and a remount is how a confirmation route is noticed.
    routeKey: url => url.pathname + url.search + url.hash,
    init,
    _internals: {
      ARM_WINDOW_MS,
      ARM_STORE_KEY,
      isInteraction,
      findSuccess,
      buildPayload,
      mergeDetails,
      reset() { lastArm = null; },
      lastArm: () => lastArm
    }
  });
})();
