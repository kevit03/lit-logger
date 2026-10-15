// Universal job tracking, step one. Registered on every site only after the
// user turns on "Detect applications on any career site" (which grants the
// optional host permission). It is deliberately tiny: it looks at the URL
// (and, once, for a JobPosting in the page's JSON-LD) and, only on a page
// that looks like a job page, asks the service worker to inject the full
// universal tracker and the Autofill button into this frame.
//
// A company's own applicant system often lives at a URL that says nothing
// (lifeattiktok.com/resume/<id>/apply is caught, but many are not), so the
// form itself also counts: three or more fields plus a resume upload or an
// application question. That is checked a few times while the page settles
// and again when the user first clicks into a field.
//
// JOB_HOST and JOB_PATH mirror shared/job-meta.js.
(() => {
  if (window.__ptUniversalBootstrap) return;
  window.__ptUniversalBootstrap = true;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  // The full tracker already runs here (a statically matched ATS page).
  if (window.__ptAutoTrackerMounted) return;

  const JOB_HOST = /^(careers?|jobs?|apply|hire|hiring|recruit(ing|ment)?|talent|work|join)[.-]/i;
  const JOB_PATH = /\/(jobs?|careers?|apply|application|applications|positions?|openings?|vacanc(y|ies)|opportunit(y|ies)|join-us|work-with-us|hiring|requisitions?|postings?)(\/|\?|#|$|-)/i;
  const FIELD_SELECTOR = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="password"]), textarea, select, [role="combobox"]';
  const APPLICATION_WORDS = /\b(resume|r\u00e9sum\u00e9|cv|cover letter|linkedin|sponsorship|work authori[sz]ation|authori[sz]ed to work|desired salary|notice period|years of experience)\b/i;
  const FORM_RECHECK_MS = [1500, 4000, 9000];

  let requested = false;
  let checkedLd = false;

  function hasJobPostingLd() {
    if (checkedLd) return false;
    checkedLd = true;
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length && i < 20; i++) {
      if (/"JobPosting"/.test(scripts[i].textContent || '')) return true;
    }
    return false;
  }

  function looksLikeJobPage() {
    if (!/^https?:$/.test(location.protocol)) return false;
    return JOB_HOST.test(location.hostname) || JOB_PATH.test(location.pathname + location.search + location.hash) || hasJobPostingLd();
  }

  // Field labels, placeholders, and accessible names; never the whole page
  // text, so a blog post about resumes next to a newsletter box is not a form.
  function fieldText(fields) {
    const parts = [];
    document.querySelectorAll('label, legend').forEach((l, i) => { if (i < 80) parts.push(l.textContent || ''); });
    fields.forEach((f, i) => {
      if (i >= 80) return;
      parts.push(f.getAttribute('placeholder') || '', f.getAttribute('aria-label') || '', f.getAttribute('name') || '', f.id || '');
    });
    return parts.join(' ').slice(0, 20000);
  }

  function looksLikeApplicationForm() {
    if (!document.body) return false;
    const fields = Array.from(document.querySelectorAll(FIELD_SELECTOR));
    if (fields.length < 3) return false;
    if (document.querySelector('input[type="file"]')) return true;
    return APPLICATION_WORDS.test(fieldText(fields));
  }

  function check() {
    if (requested || window.__ptAutoTrackerMounted) return;
    if (!looksLikeJobPage() && !looksLikeApplicationForm()) return;
    requested = true;
    try {
      chrome.runtime.sendMessage({ type: 'PT_INJECT_UNIVERSAL' }, () => { void chrome.runtime.lastError; });
    } catch (e) {
      // Extension reloaded under this page; a refresh brings the new copy.
    }
  }

  // Forms rendered by script appear after document_idle.
  let timers = [];
  function checkSoon() {
    check();
    timers.forEach(clearTimeout);
    timers = FORM_RECHECK_MS.map(ms => setTimeout(check, ms));
  }

  let lastFocusCheck = 0;
  function onFocusIn(event) {
    if (requested) { document.removeEventListener('focusin', onFocusIn, true); return; }
    const t = event && event.target;
    if (!t || typeof t.matches !== 'function' || !t.matches(FIELD_SELECTOR)) return;
    const now = Date.now();
    if (now - lastFocusCheck < 2000) return;
    lastFocusCheck = now;
    check();
  }

  checkSoon();
  document.addEventListener('focusin', onFocusIn, true);
  // SPA route changes can turn a marketing page into an application.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('currententrychange', checkSoon);
  }
  window.addEventListener('popstate', checkSoon);
  window.addEventListener('hashchange', checkSoon);
})();
