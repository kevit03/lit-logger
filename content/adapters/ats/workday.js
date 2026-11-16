// Workday: <tenant>.myworkdayjobs.com and <tenant>.myworkdaysite.com. The
// submitted banner is rendered in place at the end of the multi-step form.
// The listing is the "<Title>_<requisition>" path segment, which is also the
// only place the later form steps still name the role.
(() => {
  if (typeof AutoTrackerATS === 'undefined' || !AutoTrackerATS) return;
  const ats = AutoTrackerATS;

  const listing = url => {
    const segs = url.pathname.split('/').filter(Boolean);
    const rest = segs.slice(segs.indexOf('job') + 1).filter(s => !/^(apply|applyManually|autofillWithResume|useMyLastApplication)$/i.test(s));
    return segs.indexOf('job') < 0 ? '' : (rest.find(s => /_[\w-]*\d/.test(s)) || rest[rest.length - 1] || '');
  };

  const company = (url, doc) =>
    ats.firstText(doc, ['[data-automation-id="companyName"]']) || AutoTrackerCore.humanizeSlug(url.hostname.split('.')[0]);

  const role = (url, doc) => {
    const slug = decodeURIComponent(listing(url)).replace(/_[\w-]*\d[\w-]*$/, '').replace(/-+/g, ' ').trim();
    return ats.firstText(doc, ['[data-automation-id="jobPostingHeader"]']) || slug || ats.parseTitle(doc.title).role;
  };

  AutoTrackerCore.registerAdapter(ats.createConfirmationAdapter({
    id: 'workday',
    label: 'Workday',
    hosts: /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/,
    confirmation: {
      selectors: '[data-automation-id*="applicationSubmitted"], [data-automation-id*="successMessage"], [data-automation-id="applyFlowCompleted"], [data-automation-id*="congratulations"]',
      text: /application (has been |was )?(successfully )?(submitted|received)|thank you for applying|successfully (submitted|applied)|you('ve| have) (successfully )?applied/i
    },
    itemId: url => { const id = listing(url); return id ? 'job-' + id : ''; },
    company,
    role
  }));
})();
