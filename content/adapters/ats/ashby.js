// Ashby: jobs.ashbyhq.com/<company>/<job-id>/application. The confirmation is
// rendered in place after submit, so detection is the armed in-place path.
// The page title is "Role @ Company"; headings inside the job description are
// not the role.
(() => {
  if (typeof AutoTrackerATS === 'undefined' || !AutoTrackerATS) return;
  const ats = AutoTrackerATS;

  const company = (url, doc) => {
    const slug = url.pathname.split('/').filter(Boolean)[0];
    return ats.parseTitle(doc.title).company || (slug ? AutoTrackerCore.humanizeSlug(decodeURIComponent(slug)) : '');
  };

  const role = (url, doc) => {
    const parsed = ats.parseTitle(doc.title);
    return (parsed.company ? parsed.role : '') || ats.firstText(doc, ['h1[class*="title"]', 'h1[class*="heading"]', 'h2[class*="title"]', 'h1']) || parsed.role;
  };

  AutoTrackerCore.registerAdapter(ats.createConfirmationAdapter({
    id: 'ashby',
    label: 'Ashby',
    hosts: /^jobs\.ashbyhq\.com$/,
    confirmation: { selectors: '[class*="application-form-success"], [class*="ashby-application-form-success"], [class*="_success_"]' },
    itemId: url => { const m = url.pathname.match(/\/([0-9a-f]{8}-[0-9a-f-]{27,})/i); return m ? 'job-' + m[1] : ''; },
    company,
    role
  }));
})();
