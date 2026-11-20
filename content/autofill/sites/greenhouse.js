// Greenhouse autofill adapter: boards.greenhouse.io and job-boards.greenhouse.io
// (plus the .eu variants), including the embedded job_app iframe companies
// host on their own careers pages (the content script runs in all frames).
//
// The job-boards form keys its standard inputs by id (#first_name, #last_name,
// #email, #phone, #resume) and its custom questions by question_<n>, with the
// question text in aria-label. Dropdown questions, the phone country, the
// location, and the EEO questions are react-select comboboxes: an
// input.select__input[role=combobox] inside .select__control whose menu
// (#react-select-<id>-listbox, .select__option rows) only mounts after the
// control is clicked. `fill` drives those; plain inputs fall back to
// AutofillCore.setValue.
(() => {
  if (typeof AutofillCore === 'undefined' || !AutofillCore || !AutofillCore.siteKit) return;

  const HOSTS = /^(job-)?boards(\.eu)?\.greenhouse\.io$/;

  // Widget helpers shared by the adapters (shared/autofill-core.js); every
  // wait takes its timeout from this adapter's own `timing`.
  const timing = { wait: 3000, confirm: 1000 };
  const kit = AutofillCore.siteKit;
  const { scoreText, bestNode, press, typeInto, key, searchFor } = kit;
  const waitFor = (find, root, timeout = timing.wait) => kit.waitFor(find, root, timeout);

  const REACT_SELECT = 'input.select__input, .select__control input[role="combobox"]';

  async function fillReactSelect(desc, value) {
    const doc = desc.el.ownerDocument;
    const root = doc.documentElement;
    const id = desc.el.id || desc.id || '';
    // Re-query by id: the form re-renders while other fields fill.
    const input = (id && doc.getElementById(id)) || (desc.el.isConnected ? desc.el : null);
    if (!input) return false;
    const control = () => {
      const i = (id && doc.getElementById(id)) || input;
      return i.closest('.select__control') || i.parentElement;
    };
    const chosen = () => {
      const c = control();
      return c && c.querySelector('[class*="single-value"], [class*="multi-value__label"], [class*="multi-value"]');
    };

    const current = chosen();
    if (current && scoreText(current.textContent, value) >= 0.9) return true;

    const options = () => {
      const list = id ? doc.querySelector('[id="react-select-' + id + '-listbox"]') : null;
      const scope = list || input.closest('.select-shell') || input.closest('.select') || control();
      if (!scope) return [];
      return Array.from(scope.querySelectorAll('[role="option"], [class*="option"]')).filter((o, i, all) =>
        all.indexOf(o) === i &&
        !/notice/.test(o.getAttribute('class') || '') &&
        o.getAttribute('aria-disabled') !== 'true');
    };

    if (input.focus) input.focus();
    press(control());
    let hit = await searchFor(input, value, options, root, timing.wait);
    if (!hit) {
      // The typed filter can hide the right option ("United States" vs "USA");
      // clear it and match against the full list.
      typeInto(input, '');
      hit = bestNode(await waitFor(options, root, timing.confirm) || [], value);
    }
    if (!hit) {
      key(input, 'Escape', 27);
      return false;
    }
    const want = hit.textContent;
    press(hit);
    const done = await waitFor(() => {
      const c = chosen();
      return c && scoreText(c.textContent, want) >= 0.9 ? c : null;
    }, root, timing.confirm);
    return Boolean(done);
  }

  const adapter = {
    id: 'greenhouse',
    timing,
    matches: kit.hostMatcher(HOSTS),
    fields: [
      { selector: '#first_name', profileKey: 'firstName' },
      { selector: '#last_name', profileKey: 'lastName' },
      { selector: '#preferred_name', profileKey: 'preferredName' },
      { selector: '#email', profileKey: 'email' },
      { selector: '#phone', profileKey: 'phone' },
      { selector: '.phone-input #country, .phone-input__country input[role="combobox"]', profileKey: 'country' },
      { selector: '#candidate-location', profileKey: 'city' },
      { selector: '[aria-labelledby="upload-label-resume"] input[type="file"], input#resume[type="file"], #resume_fieldset input[type="file"]', profileKey: 'resume' },
      { selector: 'input[id^="question_"][aria-label*="LinkedIn"], input[id^="question_"][aria-label*="Linkedin"], input[id^="question_"][aria-label*="linkedin"]', profileKey: 'linkedin' },
      { selector: 'input[id^="question_"][aria-label*="GitHub"], input[id^="question_"][aria-label*="Github"], input[id^="question_"][aria-label*="github"]', profileKey: 'github' },
      { selector: 'input[id^="question_"][aria-label*="Portfolio"], input[id^="question_"][aria-label*="portfolio"]', profileKey: 'portfolio' },
      { selector: 'input[id^="question_"][aria-label*="Website"], input[id^="question_"][aria-label*="website"]', profileKey: 'website' }
    ],
    scanRoot(doc) {
      return doc.querySelector('#application-form') || doc.querySelector('#application_form') || doc.body;
    },
    fill(desc, value) {
      const el = desc && desc.el;
      if (!el || typeof el.matches !== 'function') return undefined;
      if (el.matches(REACT_SELECT)) return fillReactSelect(desc, value);
      return undefined;
    }
  };

  AutofillCore.registerSiteAdapter(adapter);
})();
