// Universal job tracking, step one. Registered on every site only after the
// user turns on "Detect applications on any career site" (which grants the
// optional host permission). It is deliberately tiny: it looks at the URL
// (and, once, for a JobPosting in the page's JSON-LD) and, only on a page
// that looks like a job page, asks the service worker to inject the full
// universal tracker into this frame. Everything else stays untouched.
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

  function check() {
    if (requested || window.__ptAutoTrackerMounted || !looksLikeJobPage()) return;
    requested = true;
    try {
      chrome.runtime.sendMessage({ type: 'PT_INJECT_UNIVERSAL' }, () => { void chrome.runtime.lastError; });
    } catch (e) {
      // Extension reloaded under this page; a refresh brings the new copy.
    }
  }

  check();
  // SPA route changes can turn a marketing page into an application.
  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('currententrychange', check);
  }
  window.addEventListener('popstate', check);
  window.addEventListener('hashchange', check);
})();
