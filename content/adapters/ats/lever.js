// Lever: jobs.lever.co/<company>/<posting-id>. Submitting lands on /thanks,
// which names neither the role nor always the company; both come from the
// posting or the /apply form seen earlier.
(() => {
  if (typeof AutoTrackerATS === 'undefined' || !AutoTrackerATS) return;
  const ats = AutoTrackerATS;

  const titleOf = doc => ats.parseTitle(doc.title, { companyFirst: true });

  const company = (url, doc) => {
    const slug = url.pathname.split('/').filter(Boolean)[0];
    const parsed = titleOf(doc);
    return (parsed.role && parsed.company) || (slug && AutoTrackerCore.humanizeSlug(slug)) || '';
  };

  const role = (url, doc) => {
    const parsed = titleOf(doc);
    return ats.firstText(doc, ['.posting-headline h2', '.posting-header h2']) || (parsed.company ? parsed.role : '');
  };

  AutoTrackerCore.registerAdapter(ats.createConfirmationAdapter({
    id: 'lever',
    label: 'Lever',
    hosts: /^jobs(\.eu)?\.lever\.co$/,
    confirmation: { url: /\/thanks(\/|$|\?)/, selectors: '.application-confirmation, [class*="application-confirmation"]' },
    itemId: url => { const m = url.pathname.match(/\/([0-9a-f]{8}-[0-9a-f-]{27,})/i); return m ? 'posting-' + m[1] : ''; },
    company,
    role
  }));
})();
