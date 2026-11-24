// Lever autofill adapter: jobs.lever.co and jobs.eu.lever.co /<company>/<id>/apply.
//
// The form is server-rendered with stable names: name (one full-name field),
// email, phone, org (current company), urls[LinkedIn] / urls[GitHub] /
// urls[Portfolio] / urls[Other], and the resume file input name="resume".
// Custom "cards" questions are plain radios, checkboxes, selects, and
// textareas, so they are left to AutofillCore. The location box is a search:
// only a picked result fills the hidden #selected-location the form sends.
(() => {
  if (typeof AutofillCore === 'undefined' || !AutofillCore || !AutofillCore.siteKit) return;

  const HOSTS = /^jobs(\.eu)?\.lever\.co$/;
  const LOCATION = '#location-input, input.location-input';

  const timing = { wait: 4000, confirm: 1000 };
  const kit = AutofillCore.siteKit;

  async function fillLocation(input, value) {
    const doc = input.ownerDocument;
    const root = doc.documentElement;
    const box = input.closest('li, .application-question, .application-field') || doc;
    const picked = () => {
      const hidden = box.querySelector('#selected-location, input[name="selectedLocation"]');
      return !hidden || !!hidden.value;
    };
    const options = () => Array.from(box.querySelectorAll('.dropdown-results .dropdown-location'));
    if (input.focus) input.focus();
    // The page searches on keydown (debounced 500 ms), not on input.
    const search = async text => {
      kit.typeInto(input, text);
      kit.key(input, 'End', 35);
      return kit.waitFor(() => kit.bestNode(options(), value), root, timing.wait);
    };
    const hit = await search(String(value)) ||
      (/,/.test(value) ? await search(String(value).split(',')[0].trim()) : null);
    if (hit) {
      kit.press(hit);
      if (await kit.waitFor(() => picked() && !!input.value, root, timing.confirm)) return true;
    }
    // Typed but not picked would be refused by the form; leave it empty.
    kit.typeInto(input, '');
    return false;
  }

  AutofillCore.registerSiteAdapter({
    id: 'lever',
    timing,
    matches: AutofillCore.siteKit.hostMatcher(HOSTS),
    fields: [
      { selector: 'input[name="name"]', profileKey: 'fullName' },
      { selector: 'input[name="email"]', profileKey: 'email' },
      { selector: 'input[name="phone"]', profileKey: 'phone' },
      { selector: LOCATION, profileKey: 'location' },
      { selector: 'input[name="org"]', profileKey: 'currentCompany' },
      { selector: 'input[name="urls[LinkedIn]"]', profileKey: 'linkedin' },
      { selector: 'input[name="urls[GitHub]"]', profileKey: 'github' },
      { selector: 'input[name="urls[Portfolio]"]', profileKey: 'portfolio' },
      { selector: 'input[name="urls[Other]"]', profileKey: 'website' },
      { selector: 'input[type="file"][name="resume"]', profileKey: 'resume' }
    ],
    scanRoot(doc) {
      return doc.querySelector('#application-form') || doc.body;
    },
    fill(desc, value) {
      const el = desc && desc.el;
      if (!el || typeof el.matches !== 'function' || !el.matches(LOCATION)) return undefined;
      return fillLocation(el, value);
    }
  });
})();
