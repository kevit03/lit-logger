// Greenhouse: boards.greenhouse.io and job-boards.greenhouse.io (plus the .eu
// variants), including the embedded job_app iframe companies host on their own
// careers pages, which carries the company in ?for= and the job in ?token=.
(() => {
  if (typeof AutoTrackerATS === 'undefined' || !AutoTrackerATS) return;
  const ats = AutoTrackerATS;

  const company = (url, doc) => {
    const fromDom = ats.firstText(doc, ['.company-name', '[class*="company-name"]']).replace(/^at\s+/i, '');
    if (fromDom) return fromDom;
    const fromTitle = /\sat\s/i.test(doc.title || '') ? ats.parseTitle(doc.title).company : '';
    if (fromTitle) return fromTitle;
    const slug = url.searchParams.get('for') || url.pathname.split('/').filter(Boolean)[0];
    return slug && slug !== 'embed' ? AutoTrackerCore.humanizeSlug(slug) : '';
  };

  const role = (url, doc) =>
    ats.firstText(doc, ['h1.app-title', '.app-title', '.job__title h1', 'h1.section-header']) || ats.parseTitle(doc.title).role || ats.firstText(doc, ['h1']);

  const itemId = url => {
    const m = url.pathname.match(/\/jobs\/(\d+)/);
    const id = m ? m[1] : (url.searchParams.get('token') || url.searchParams.get('gh_jid') || '');
    return /^\d+$/.test(id) ? 'job-' + id : '';
  };

  AutoTrackerCore.registerAdapter(ats.createConfirmationAdapter({
    id: 'greenhouse',
    label: 'Greenhouse',
    hosts: /^(job-)?boards(\.eu)?\.greenhouse\.io$/,
    confirmation: { url: /\/confirmation(\/|$|\?)/, selectors: '#application_confirmation, .application-confirmation, [class*="confirmation__"]' },
    itemId,
    company,
    role
  }));
})();
