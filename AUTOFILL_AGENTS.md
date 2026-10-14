# LIT Autofill: agent prompts

Run agents 1-4 in parallel. Run agent 5 (integration) after they all finish.
Every agent gets the SHARED CONTEXT block plus its own section.

---

## SHARED CONTEXT (paste at the top of every agent's prompt)

You are working on LIT, a Manifest V3 Chrome extension in this repo (plain JS, no build step, no modules: every file is an IIFE that exposes one global, e.g. `const LitDB = (() => { ... })()`). Read `README.md`, `manifest.json`, and `content/adapters/ats/greenhouse.js` first to learn the conventions.

We are adding **Autofill**: a profile you fill in once, plus a button on job application pages (Greenhouse, Lever, Ashby, Workday, and other career sites) that fills the form. No AI API. Fields are matched by rules, and the extension **learns** from your corrections:
- When you fix or fill a field the run missed, it saves `label -> profile key` (or `label -> literal value`) as a rule.
- Long-answer questions go into an answer bank and are suggested next time by fuzzy match.

Autofill never clicks Submit.

### Hard rules
- **Only create or edit the files listed under "You own".** Do not touch any other file, including `manifest.json`, `popup/*`, `test/run_all.js`, existing mocks, or other agents' files. If you need a change outside your files, write it under "Integration notes" in your final report instead.
- Code against the contracts below exactly. Other agents are building the other side at the same time. If a contract seems wrong, follow it anyway and flag it in your report.
- No emoji anywhere (a test suite enforces this). Match the existing code style.
- Tests: write `test/<yourfile>.test.js` exporting `async run()` that throws on failure, like the existing suites. Run it with `node -e "require('./test/<file>').run()"`. Do not add it to `run_all.js`. Reuse `test/mock_chrome.js` / `test/mock_dom.js` read-only; if you need more mocking, put it in a new `test/mock_autofill_<agent#>.js`.
- Do not commit.

### Contracts

**Profile** (stored by `AutofillStore`, flat object, every value is a string unless noted):
```
firstName, lastName, preferredName, email, phone, phoneCountryCode,
addressLine1, addressLine2, city, state, postalCode, country,
linkedin, github, portfolio, website,
school, degree, major, gpa, gradMonth, gradYear,
currentCompany, currentTitle, yearsExperience,
workAuthorized ("yes"|"no"), needsSponsorship ("yes"|"no"),
willingToRelocate ("yes"|"no"), earliestStartDate, salaryExpectation,
howDidYouHear,
eeo: { gender, race, hispanicLatino, veteran, disability }   // each "" = leave blank
```
`fullName` is derived as `firstName + " " + lastName`. It is never stored.

**`AutofillStore`** (global, `shared/autofill-store.js`). It uses `chrome.storage.local` only, and every method is async:
```
getProfile() -> Profile                 // defaults filled with ""
saveProfile(profile)
getRules() -> Rule[]
learnRule({ host, labelKey, profileKey?, value? })   // exactly one of profileKey/value; upsert by (host,labelKey); host "*" = global
deleteRule(id)
getAnswers() -> Answer[]                // { id, question, labelKey, answer, updatedAt }
saveAnswer({ question, answer })        // upsert by labelKey
deleteAnswer(id)
findAnswer(questionText) -> { answer, score } | null   // token-overlap/Jaccard on labelKey, null below 0.5
getResume() -> { name, type, dataUrl } | null
saveResume({ name, type, dataUrl }) / clearResume()
getSettings() -> { showButton: true, fillEeo: false, autoLearn: true }
saveSettings(partial)
onChange(callback)                      // fires on any autofill key change
```
Storage keys are all prefixed `af_`.

**`AutofillCore`** (global, `shared/autofill-core.js`):
```
normalizeLabel(text) -> labelKey        // lowercase, strip punctuation/asterisks/"(optional)"/"required", collapse spaces
scanFields(root = document) -> FieldDescriptor[]
matchField(desc, profile, rules, host) -> Match | null
setValue(desc, value) -> Promise<boolean>   // fires the input/change/blur events React expects
registerSiteAdapter(adapter)
run({ profile, rules, answers, resume, settings, root?, host? }) -> Promise<Report>
```
```
FieldDescriptor = { el, kind: 'text'|'email'|'tel'|'url'|'textarea'|'select'|'radio'|'checkbox'|'file'|'combobox',
                    label, labelKey, name, id, autocomplete, placeholder,
                    options: string[], required: boolean, group?: Element }
Match  = { profileKey?, value, confidence: 0..1, source: 'adapter'|'rule'|'autocomplete'|'dictionary'|'answer' }
Report = { filled: [{ desc, match }], skipped: [{ desc, reason }], unmatched: [desc] }
SiteAdapter = {
  id, matches(url) -> bool,
  fields?: [{ selector, profileKey }],                // fixed known fields; checked first
  scanRoot?(doc) -> Element,                          // narrow where to scan
  fill?(desc, value) -> Promise<boolean> | undefined  // custom widgets; return undefined to fall back to setValue
}
```
Match priority: adapter fields, then learned rules (host-specific before global), then the `autocomplete` attribute, then the synonym dictionary, then the answer bank (textareas only).

---

## AGENT 1: Matching and filling engine

**You own:** `shared/autofill-core.js`, `test/autofill-core.test.js`, `test/mock_autofill_1.js` (optional)

Build `AutofillCore` per the contract.
- **Label extraction, in order:** `<label for>`, a wrapping `<label>`, `aria-labelledby`, `aria-label`, the nearest preceding legend or question text in the field's container, then `placeholder`, then `name`. For radio and checkbox groups, use the fieldset or group's question text as the label and the option labels as `options`.
- **Scanning:** skip hidden, disabled, `type=hidden`, and already-filled fields (except selects still on their placeholder option). Handle `role="combobox"` / `aria-haspopup="listbox"` buttons as `kind: 'combobox'`.
- **Synonym dictionary:** regexes on `labelKey`/`name`/`id` mapping to profile keys. Cover the whole Profile, plus `fullName` and common phrasings: "legal first name", "given name", "family name", "mobile", "LinkedIn profile URL", "are you legally authorized to work", "will you now or in the future require sponsorship", "expected graduation", "university", and so on. Return confidence 0.9 for exact matches, 0.6 for loose ones. EEO keys only match when `settings.fillEeo` is true.
- **`setValue`:**
  - Text: set through the native prototype value setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`), then dispatch `input`, `change`, and `blur` with `bubbles: true`.
  - Selects and radios: fuzzy-match the value to an option (case-insensitive; "yes"/"no" also match "Yes, I am..." / "No, I will not...").
  - Checkboxes: set checked state.
  - Files: build a `File` from the dataUrl, assign it via `DataTransfer`, then dispatch `change`.
  - Comboboxes: return false unless an adapter handles them.
- **`run`:** scan, match, and fill fields with confidence >= 0.6. Use the answer bank for textareas with score >= 0.5. Return the Report. Never throw on one bad field. Never touch submit buttons.
- **Tests:** label extraction variants, dictionary hits/misses, rule priority over the dictionary, host rules over global rules, select/radio fuzzy option matching, the React-style setter firing events, the file field, EEO gating, already-filled fields skipped.

---

## AGENT 2: Profile storage and profile editor page

**You own:** `shared/autofill-store.js`, `options/autofill.html`, `options/autofill.js`, `options/autofill.css`, `test/autofill-store.test.js`, `test/mock_autofill_2.js` (optional)

1. **Build `AutofillStore` per the contract.**
   - Store the profile, rules, answers, settings, and resume under separate `af_` keys.
   - Rule `id`s are random strings.
   - The resume is limited to 5 MB. Reject larger files with a clear error.
   - Use the same `labelKey` normalization as `AutofillCore.normalizeLabel`. Copy that function into your file as a private helper, so the files have no load-order dependency.
2. **Build a standalone settings page** at `options/autofill.html`, opened in a tab. Reuse the visual language of `popup/popup.css`: copy the variables you need into your own CSS and do not edit the popup.
   - Sections: Profile (grouped: Basics, Links, Education, Work, Logistics, EEO with a "leave blank" default), Resume (upload, replace, remove, filename shown), Saved answers (list with edit and delete, search box), Learned rules (table of host / label / maps to, with delete), Settings (show button, fill EEO, auto-learn).
   - Saves on blur, with a small "Saved" indicator.
   - Import and export everything as JSON.
3. **Tests:** store round-trips, defaults, `learnRule` upsert semantics, `findAnswer` threshold, resume size limit, export/import.

---

## AGENT 3: In-page Autofill button and learning loop

**You own:** `content/autofill/autofill-ui.js`, `content/autofill/autofill-ui.css`, `test/autofill-ui.test.js`, `test/mock_autofill_3.js` (optional)

This script loads after `shared/autofill-store.js`, `shared/autofill-core.js`, and the site adapters. Assume those globals exist; guard with `typeof X === 'undefined'`.

- **Button:** inject a small floating "Autofill" button, bottom right, inside a shadow root so page CSS can't break it. Show it only in frames that contain at least 3 fillable fields, and only when `settings.showButton` is on. Re-check on DOM mutations (debounced) because Workday and Greenhouse render steps dynamically. Keyboard shortcut: Alt+Shift+F.
- **On click:** load profile, rules, answers, resume, and settings from `AutofillStore`, then call `AutofillCore.run`. Then:
  - Outline filled fields green and unmatched fields amber. Clear the outlines on focus.
  - Show a toast: "Filled 14 fields, 3 need you."
  - Keep a "Fill again" option for multi-step forms.
- **Learning** (when `settings.autoLearn` is on): after a run, watch `change` events on unmatched and filled fields.
  - The user fills an unmatched short field: if the value equals a profile value, `learnRule({ host, labelKey, profileKey })`. Otherwise show an inline mini prompt, "Remember this for '<label>'? [This site] [Everywhere] [No]", which saves `value`.
  - The user overwrites a filled field with a different profile value: update the rule to that key.
  - A textarea gets 40+ characters: on blur, offer "Save to answer bank?", then `saveAnswer`.
- **Privacy and safety:** never learn from password, card, or SSN-like fields (match label/name/autocomplete on `password|ssn|social security|card|cvv|iban|routing`). Never click Submit.
- **Tests:** the button appears and hides by field count, the learn-rule paths, the sensitive-field exclusion, and the shadow DOM isolation.

---

## AGENT 4: Site adapters (Greenhouse, Lever, Ashby, Workday)

**You own:** `content/autofill/sites/greenhouse.js`, `lever.js`, `ashby.js`, `workday.js`, `test/autofill-sites.test.js`, `test/fixtures/autofill/*.html`, `test/mock_autofill_4.js` (optional)

Each file calls `AutofillCore.registerSiteAdapter({...})` per the SiteAdapter contract. Guard with `typeof AutofillCore === 'undefined'`. Use the `hosts` regexes from the existing `content/adapters/ats/*.js` files (read only, do not edit them).

- **Greenhouse** (`boards`/`job-boards`, including the `.eu` boards and the embed iframe):
  - Fixed fields: `#first_name`, `#last_name`, `#email`, `#phone`, resume `input[type=file]` in the resume section, and the LinkedIn/website question fields.
  - Custom questions are react-select comboboxes. Implement `fill` by focusing the input, typing the value, waiting for `[class*="option"]`, and clicking the best fuzzy match.
- **Lever:** `name="name"` -> fullName, `email`, `phone`, `org` -> currentCompany, `urls[LinkedIn]`, `urls[GitHub]`, `urls[Portfolio]`, `urls[Other]` -> website, and resume `input[name="resume"]`. Card questions are standard radios/selects/textarea; leave those to the core.
- **Ashby:** `_systemfield_name`, `_systemfield_email`, `_systemfield_resume`, and the phone and LinkedIn fields by label. Yes/No questions are button pairs: implement `fill` to click the matching button.
- **Workday** (hardest, spend the most time here):
  - Fields keyed by `data-automation-id`: `legalNameSection_firstName`, `legalNameSection_lastName`, `email`, `phone-number`, `addressSection_addressLine1`, `addressSection_city`, `addressSection_postalCode`, `countryDropdown`, `addressSection_countryRegion`, `phone-device-type`, and the source "How did you hear" prompt.
  - Verify these IDs against a live Workday posting and adjust to what is actually there.
  - Dropdowns are `button[aria-haspopup="listbox"]`. `fill` clicks the button, waits for `[role="listbox"]`, and clicks the matching `[role="option"]`.
  - Multiselect prompts take typing plus Enter.
  - Fields render per step and re-render after edits, so every `fill` waits for elements (a MutationObserver-based `waitFor(selector, timeout=3000)`) and re-queries instead of caching nodes.
- **Tests:** a saved, trimmed HTML fixture per site in `test/fixtures/autofill/` (build it by hand from real markup, with no personal data), asserting that the adapters map the fixed fields and that the custom `fill` functions drive the mock dropdowns correctly.

---

## AGENT 5: Integration (run after 1-4 are done)

**You own:** `manifest.json`, `popup/popup.html`, `popup/popup.js` (minimal additions only), `test/run_all.js`, `test/manifest.test.js`, `README.md`

1. Read the four agents' final reports and apply their "Integration notes".
2. **`manifest.json`:**
   - For the existing ATS and universal content-script entries, append these after the current scripts in this order: `shared/autofill-store.js`, `shared/autofill-core.js`, the site adapter files, `content/autofill/autofill-ui.js`.
   - Add `content/autofill/autofill-ui.css` to `css`.
   - Make sure the universal injection path in `background/service-worker.js` (`PT_INJECT_UNIVERSAL`) also injects these files. Edit only that injection list, and note it in your report.
   - Bump the version to 1.5.0.
3. **Popup:** add one "Autofill profile" button that opens `options/autofill.html` via `chrome.tabs.create({ url: chrome.runtime.getURL(...) })`, placed with the existing settings controls. Do nothing more in the popup.
4. Add the four new test files to `test/run_all.js`, and update `manifest.test.js` for the new scripts and version.
5. Run `node test/run_all.js` until everything passes. When a failure is inside another agent's file, fix the smallest thing possible and list each such fix.
6. Add an "Autofill" section to the README.
7. **Manual check list for the user:** load unpacked, fill the profile, then try one Greenhouse, one Lever, one Ashby, and one Workday posting without submitting. Report what filled and what did not.
