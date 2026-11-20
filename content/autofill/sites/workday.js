// Workday autofill adapter: <tenant>.myworkdayjobs.com and
// <tenant>.myworkdaysite.com application steps.
//
// Workday is a client-rendered, multi-step flow that re-renders form fields
// after almost every edit, so nothing here caches nodes: every fill derives a
// stable selector for its control, waits for it (MutationObserver-backed
// waitFor), and re-queries after each interaction.
//
// Two markup generations are targeted. The older one keys controls by
// data-automation-id (legalNameSection_firstName, addressSection_city,
// phone-number, phone-device-type, countryDropdown, formField-sourcePrompt);
// the newer one uses "<section>--<field>" ids and names
// (name--legalName--firstName, address--city, phoneNumber--phoneType,
// source--source). Neither could be checked against a live application step,
// which sits behind a candidate sign-in, so all selectors are best effort.
//
// Widgets driven by `fill`:
// - Single selects: button[aria-haspopup=listbox]. Click, wait for the
//   [role=listbox] (aria-controls when present), click the best [role=option].
// - Multiselect prompts ("How did you hear about us?"): type, press Enter,
//   wait for promptOption rows in the wd-popup, click the best one, and drill
//   into a category row when the choice is nested.
// Plain inputs return undefined so AutofillCore.setValue handles them, unless
// the node was re-rendered away, in which case the fresh node is filled.
(() => {
  if (typeof AutofillCore === 'undefined' || !AutofillCore || !AutofillCore.siteKit) return;

  const HOSTS = /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/;

  // Widget helpers shared by the adapters (shared/autofill-core.js); every
  // wait takes its timeout from this adapter's own `timing`.
  const timing = { wait: 3000, confirm: 1000 };
  const kit = AutofillCore.siteKit;
  const { scoreText, bestNode, fire, press, typeInto, key, sleep } = kit;
  const waitFor = (find, root, timeout = timing.wait) => kit.waitFor(find, root, timeout);

  const LISTBOX_BUTTON = 'button[aria-haspopup="listbox"]';
  const PROMPT_CONTAINER = '[data-automation-id="multiSelectContainer"], [data-automation-id="multiselectInputContainer"], [data-uxi-widget-type="multiselect"]';
  const SELECTED_ITEM = '[data-automation-id="selectedItemList"] li, [data-automation-id="selectedItem"]';

  const sel = (tag, pairs) => pairs.map(([attr, v]) => tag + '[' + attr + '="' + v + '"]').join(', ');

  const FIELDS = [
    { selector: sel('input', [['data-automation-id', 'legalNameSection_firstName'], ['id', 'name--legalName--firstName'], ['name', 'legalName--firstName']]), profileKey: 'firstName' },
    { selector: sel('input', [['data-automation-id', 'legalNameSection_lastName'], ['id', 'name--legalName--lastName'], ['name', 'legalName--lastName']]), profileKey: 'lastName' },
    { selector: sel('input', [['data-automation-id', 'email'], ['id', 'emailAddress--emailAddress'], ['name', 'emailAddress']]), profileKey: 'email' },
    { selector: sel('input', [['data-automation-id', 'phone-number'], ['id', 'phoneNumber--phoneNumber'], ['name', 'phoneNumber']]), profileKey: 'phone' },
    { selector: sel('input', [['data-automation-id', 'addressSection_addressLine1'], ['id', 'address--addressLine1'], ['name', 'addressLine1']]), profileKey: 'addressLine1' },
    { selector: sel('input', [['data-automation-id', 'addressSection_addressLine2'], ['id', 'address--addressLine2'], ['name', 'addressLine2']]), profileKey: 'addressLine2' },
    { selector: sel('input', [['data-automation-id', 'addressSection_city'], ['id', 'address--city'], ['name', 'city']]), profileKey: 'city' },
    { selector: sel('input', [['data-automation-id', 'addressSection_postalCode'], ['id', 'address--postalCode'], ['name', 'postalCode']]), profileKey: 'postalCode' },
    { selector: sel('button', [['data-automation-id', 'addressSection_countryRegion'], ['id', 'address--countryRegion'], ['name', 'countryRegion']]), profileKey: 'state' },
    { selector: sel('button', [['data-automation-id', 'countryDropdown'], ['id', 'country--country'], ['name', 'country']]), profileKey: 'country' },
    {
      selector: '[data-automation-id="formField-sourcePrompt"] input, [data-automation-id="formField-source"] input, input[id="source--source"]',
      profileKey: 'howDidYouHear'
    },
    { selector: 'input[type="file"][data-automation-id="file-upload-input-ref"]', profileKey: 'resume' }
  ];

  const safe = v => typeof v === 'string' && v !== '' && !/["\\]/.test(v);

  // Selectors that can find this control again after Workday re-renders it:
  // data-automation-id, then id, then name. Generated ids like "input-12"
  // are skipped; they change between renders. Works on detached nodes too.
  function candidateSelectors(el, desc) {
    const tag = el.tagName.toLowerCase();
    const out = [];
    const aid = el.getAttribute('data-automation-id');
    if (safe(aid) && aid !== 'searchBox') out.push(tag + '[data-automation-id="' + aid + '"]');
    const id = el.getAttribute('id') || (desc && desc.id);
    if (safe(id) && !/^input-\d+$/.test(id)) out.push(tag + '[id="' + id + '"]');
    const name = el.getAttribute('name') || (desc && desc.name);
    if (safe(name)) out.push(tag + '[name="' + name + '"]');
    const field = el.closest('[data-automation-id^="formField-"]');
    const fid = field && field.getAttribute('data-automation-id');
    if (safe(fid)) out.push('[data-automation-id="' + fid + '"] ' + tag + (safe(aid) ? '[data-automation-id="' + aid + '"]' : ''));
    return out;
  }

  // The first candidate that matches exactly this node right now.
  function stableSelector(el) {
    const doc = el.ownerDocument;
    for (const s of candidateSelectors(el)) {
      let hits;
      try { hits = doc.querySelectorAll(s); } catch (e) { continue; }
      if (hits.length === 1 && hits[0] === el) return s;
    }
    return null;
  }

  function refetch(doc, el, key) {
    if (key) {
      const found = doc.querySelector(key);
      if (found) return found;
    }
    return el && el.isConnected ? el : null;
  }

  function isPromptInput(el) {
    return el.tagName === 'INPUT' && Boolean(el.closest(PROMPT_CONTAINER));
  }

  function findListbox(doc, button) {
    const owned = button && button.getAttribute('aria-controls');
    const lists = owned
      ? [doc.querySelector('[id="' + owned + '"]')].filter(Boolean)
      : Array.from(doc.querySelectorAll('[role="listbox"]')).filter(l => l.getAttribute('data-automation-id') !== 'selectedItemList');
    // The newest popup is mounted last.
    for (let i = lists.length - 1; i >= 0; i--) {
      if (lists[i].querySelector('[role="option"]')) return lists[i];
    }
    return null;
  }

  async function fillListbox(doc, el, keySel, value) {
    const root = doc.documentElement;
    const button = () => refetch(doc, el, keySel);
    const start = button();
    if (!start) return false;
    if (scoreText(start.textContent, value) >= 0.9) return true;

    press(start);
    let list = await waitFor(() => findListbox(doc, button()), root);
    if (!list && button()) {
      press(button());
      list = await waitFor(() => findListbox(doc, button()), root, timing.confirm);
    }
    if (!list) return false;

    const options = () => Array.from(list.querySelectorAll('[role="option"]'))
      .filter(o => o.getAttribute('aria-disabled') !== 'true');
    let hit = bestNode(options(), value);
    if (!hit) {
      // Long lists can be virtualized; Workday listboxes jump on typeahead.
      for (const ch of String(value).slice(0, 12)) fire(list, 'keydown', { key: ch });
      await sleep(150);
      hit = bestNode(options(), value);
    }
    if (!hit) {
      key(list, 'Escape', 27);
      return false;
    }
    const want = hit.textContent;
    press(hit.querySelector('[data-automation-id="promptOption"]') || hit.firstElementChild || hit);
    const done = await waitFor(() => {
      const b = button();
      if (b && scoreText(b.textContent, want) >= 0.9) return b;
      return !keySel && !list.isConnected ? list : null;
    }, root, timing.confirm);
    return Boolean(done);
  }

  async function fillPrompt(doc, el, keySel, value) {
    const root = doc.documentElement;
    const input = () => refetch(doc, el, keySel);
    const start = input();
    if (!start) return false;
    const fieldOf = i => (i && (i.closest('[data-automation-id^="formField-"]') || i.closest(PROMPT_CONTAINER))) || null;
    const widgetOf = i => {
      const c = i && i.closest('[data-automation-id="multiSelectContainer"]');
      return c ? c.getAttribute('id') : '';
    };
    const selectedMatch = () => {
      const f = fieldOf(input());
      if (!f) return null;
      return Array.from(f.querySelectorAll(SELECTED_ITEM)).find(s => scoreText(s.textContent, value) >= 0.7) || null;
    };
    if (selectedMatch()) return true;

    const widget = widgetOf(start);
    const promptOptions = () => {
      let popups = Array.from(doc.querySelectorAll('[data-automation-widget="wd-popup"]'));
      if (widget) {
        const mine = popups.filter(p => p.querySelector('[data-associated-widget="' + widget + '"]'));
        if (mine.length) popups = mine;
      }
      const scope = popups.length ? popups : [doc];
      const out = [];
      scope.forEach(p => p.querySelectorAll('[data-automation-id="promptOption"]').forEach(o => {
        const f = fieldOf(input());
        if (!out.includes(o) && !(f && f.contains(o))) out.push(o);
      }));
      return out;
    };

    if (start.focus) start.focus();
    typeInto(start, String(value));
    key(start, 'Enter', 13);

    let seen = [];
    const changed = o => o.length > 0 && (o.length !== seen.length || o[0] !== seen[0]);
    for (let depth = 0; depth < 3; depth++) {
      const opts = await waitFor(() => { const o = promptOptions(); return changed(o) ? o : null; }, root);
      if (!opts) break;
      seen = opts;
      const hit = bestNode(opts, value) || (opts.length === 1 ? opts[0] : null);
      if (!hit) break;
      press(hit);
      // Either the pick lands in selectedItemList, or a category opened a
      // second level of options.
      const next = await waitFor(() => {
        if (selectedMatch()) return 'selected';
        return changed(promptOptions()) ? 'more' : null;
      }, root);
      if (next === 'selected') {
        const i = input();
        if (i) key(i, 'Escape', 27);
        return true;
      }
      if (next !== 'more') break;
    }
    if (selectedMatch()) return true;
    const i = input();
    if (i) {
      key(i, 'Escape', 27);
      typeInto(i, '');
    }
    return false;
  }

  // The custom widget fill for this node (a promise), or null for a plain input.
  function widgetFill(doc, node, value) {
    if (node.matches(LISTBOX_BUTTON)) return fillListbox(doc, node, stableSelector(node), value);
    if (isPromptInput(node)) return fillPrompt(doc, node, stableSelector(node), value);
    return null;
  }

  // The field was re-rendered away since the scan: wait for its replacement
  // and fill that one, through its widget fill or AutofillCore.setValue.
  async function fillReplacement(doc, desc, value) {
    const tries = candidateSelectors(desc.el, desc);
    const fresh = await waitFor(() => {
      for (const s of tries) {
        const hit = doc.querySelector(s);
        if (hit) return hit;
      }
      return null;
    }, doc.documentElement);
    if (!fresh) return false;
    return widgetFill(doc, fresh, value) || AutofillCore.setValue(Object.assign({}, desc, { el: fresh }), value);
  }

  AutofillCore.registerSiteAdapter({
    id: 'workday',
    timing,
    matches: kit.hostMatcher(HOSTS),
    fields: FIELDS,
    fill(desc, value) {
      const el = desc && desc.el;
      if (!el || typeof el.matches !== 'function') return undefined;
      const doc = el.ownerDocument;
      if (el.isConnected) return widgetFill(doc, el, value) || undefined;
      return fillReplacement(doc, desc, value);
    }
  });
})();
