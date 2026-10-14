// Lever autofill adapter: jobs.lever.co and jobs.eu.lever.co /<company>/<id>/apply.
//
// The form is server-rendered with stable names: name (one full-name field),
// email, phone, org (current company), urls[LinkedIn] / urls[GitHub] /
// urls[Portfolio] / urls[Other], and the resume file input name="resume".
// Custom "cards" questions are plain radios, checkboxes, selects, and
// textareas, so they are left to AutofillCore; there is no custom fill.
(() => {
  if (typeof AutofillCore === 'undefined' || !AutofillCore) return;

  const HOSTS = /^jobs(\.eu)?\.lever\.co$/;

  AutofillCore.registerSiteAdapter({
    id: 'lever',
    matches(url) {
      try {
        return HOSTS.test(new URL(String(url && url.href ? url.href : url)).hostname);
      } catch (e) {
        return false;
      }
    },
    fields: [
      { selector: 'input[name="name"]', profileKey: 'fullName' },
      { selector: 'input[name="email"]', profileKey: 'email' },
      { selector: 'input[name="phone"]', profileKey: 'phone' },
      { selector: 'input[name="org"]', profileKey: 'currentCompany' },
      { selector: 'input[name="urls[LinkedIn]"]', profileKey: 'linkedin' },
      { selector: 'input[name="urls[GitHub]"]', profileKey: 'github' },
      { selector: 'input[name="urls[Portfolio]"]', profileKey: 'portfolio' },
      { selector: 'input[name="urls[Other]"]', profileKey: 'website' },
      { selector: 'input[type="file"][name="resume"]', profileKey: 'resume' }
    ],
    scanRoot(doc) {
      return doc.querySelector('#application-form') || doc.body;
    }
  });
})();
