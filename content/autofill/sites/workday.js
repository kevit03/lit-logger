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
  if (typeof AutofillCore === 'undefined' || !AutofillCore) return;

  const HOSTS = /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/;

  // --- widget helpers (same block in greenhouse.js, ashby.js, workday.js) ---
  const timing = { wait: 3000, confirm: 1000 };

  const W = typeof window !== 'undefined' ? window : null;

  const norm = s => String(s == null ? '' : s).toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9+]+/g, ' ').trim();

  const ALIASES = [
    ['united states', 'united states of america', 'us', 'usa', 'u s', 'u s a'],
    ['united kingdom', 'uk', 'u k', 'great britain']
  ];
  const canon = s => { for (const g of ALIASES) if (g.includes(s)) return g[0]; return s; };

  // 1 exact, 0.95 alias, 0.9 yes/no prefix ("Yes, I am..."), 0.7-0.8 whole-word
  // containment (shorter options win), then token Jaccard scaled to 0.6.
  function scoreOption(label, value) {
    const o = norm(label);
    const v = norm(value);
    if (!o || !v) return 0;
    if (o === v) return 1;
    if (canon(o) === canon(v)) return 0.95;
    if (v === 'yes' || v === 'no') return new RegExp('^' + v + '\\b').test(o) ? 0.9 : 0;
    if ((' ' + o + ' ').includes(' ' + v + ' ')) return 0.7 + 0.1 * (v.length / o.length);
    if ((' ' + v + ' ').includes(' ' + o + ' ')) return 0.6 + 0.1 * (o.length / v.length);
    const a = new Set(o.split(' '));
    const b = new Set(v.split(' '));
    let inter = 0;
    a.forEach(t => { if (b.has(t)) inter++; });
    return 0.6 * inter / (a.size + b.size - inter);
  }

  function bestOption(nodes, value) {
    let best = null;
    let bestScore = 0;
    for (const n of nodes) {
      const s = scoreOption(n.textContent, value);
      if (s > bestScore) { best = n; bestScore = s; }
    }
    return bestScore >= 0.5 ? best : null;
  }

  function fire(el, type, init) {
    const opts = Object.assign({ bubbles: true, cancelable: true, composed: true }, init);
    const C = !W ? null
      : /^pointer/.test(type) ? (W.PointerEvent || W.MouseEvent)
      : /^(mouse|click)/.test(type) ? W.MouseEvent
      : /^key/.test(type) ? W.KeyboardEvent
      : W.Event;
    let ev;
    if (C) {
      ev = new C(type, opts);
    } else {
      ev = Object.assign({ type, defaultPrevented: false }, opts);
      ev.preventDefault = function preventDefault() { this.defaultPrevented = true; };
      ev.stopPropagation = function stopPropagation() {};
    }
    el.dispatchEvent(ev);
  }

  // The full sequence a real click produces; widgets differ on which one they
  // listen to (react-select opens on mousedown/mouseup, options select on click).
  function press(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(t =>
      fire(el, t, { button: 0, buttons: /down$/.test(t) ? 1 : 0 }));
  }

  function typeInto(input, text) {
    const proto = W && (W.HTMLTextAreaElement && input instanceof W.HTMLTextAreaElement
      ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement && W.HTMLInputElement.prototype);
    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, text); else input.value = text;
    fire(input, 'input');
  }

  function key(el, name, code) {
    fire(el, 'keydown', { key: name, code: name, keyCode: code, which: code });
    fire(el, 'keyup', { key: name, code: name, keyCode: code, which: code });
  }

  // Resolves with the first truthy result of `find`, re-checked on every DOM
  // mutation under `root` (and on a slow poll as a backstop), or null after
  // `timeout`. Always disconnects its observer.
  function waitFor(find, root, timeout = timing.wait) {
    const probe = typeof find === 'string' ? () => root.querySelector(find) : find;
    return new Promise(resolve => {
      let done = false;
      let obs = null;
      let poll = null;
      let timer = null;
      const finish = v => {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        resolve(v || null);
      };
      const check = () => {
        let v = null;
        try { v = probe(); } catch (e) { v = null; }
        if (v && !(Array.isArray(v) && !v.length)) finish(v);
      };
      check();
      if (done) return;
      if (typeof MutationObserver === 'function' && root) {
        obs = new MutationObserver(check);
        obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      poll = setInterval(check, 100);
      timer = setTimeout(() => finish(null), timeout);
    });
  }
  // --- end widget helpers ----------------------------------------------------

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
    if (scoreOption(start.textContent, value) >= 0.9) return true;

    press(start);
    let list = await waitFor(() => findListbox(doc, button()), root);
    if (!list && button()) {
      press(button());
      list = await waitFor(() => findListbox(doc, button()), root, timing.confirm);
    }
    if (!list) return false;

    const options = () => Array.from(list.querySelectorAll('[role="option"]'))
      .filter(o => o.getAttribute('aria-disabled') !== 'true');
    let hit = bestOption(options(), value);
    if (!hit) {
      // Long lists can be virtualized; Workday listboxes jump on typeahead.
      for (const ch of String(value).slice(0, 12)) fire(list, 'keydown', { key: ch });
      await new Promise(resolve => setTimeout(resolve, 150));
      hit = bestOption(options(), value);
    }
    if (!hit) {
      key(list, 'Escape', 27);
      return false;
    }
    const want = hit.textContent;
    press(hit.querySelector('[data-automation-id="promptOption"]') || hit.firstElementChild || hit);
    const done = await waitFor(() => {
      const b = button();
      if (b && scoreOption(b.textContent, want) >= 0.9) return b;
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
      return Array.from(f.querySelectorAll(SELECTED_ITEM)).find(s => scoreOption(s.textContent, value) >= 0.7) || null;
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
      const hit = bestOption(opts, value) || (opts.length === 1 ? opts[0] : null);
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

  AutofillCore.registerSiteAdapter({
    id: 'workday',
    timing,
    matches(url) {
      try {
        return HOSTS.test(new URL(String(url && url.href ? url.href : url)).hostname);
      } catch (e) {
        return false;
      }
    },
    fields: FIELDS,
    fill(desc, value) {
      const el = desc && desc.el;
      if (!el || typeof el.matches !== 'function') return undefined;
      const doc = el.ownerDocument;
      const route = node => {
        if (node.matches(LISTBOX_BUTTON)) return fillListbox(doc, node, stableSelector(node), value);
        if (isPromptInput(node)) return fillPrompt(doc, node, stableSelector(node), value);
        return null;
      };
      if (el.isConnected) return route(el) || undefined;
      // Re-rendered away since the scan: find the replacement and fill that.
      const tries = candidateSelectors(el, desc);
      return (async () => {
        const fresh = await waitFor(() => {
          for (const s of tries) {
            const hit = doc.querySelector(s);
            if (hit) return hit;
          }
          return null;
        }, doc.documentElement);
        if (!fresh) return false;
        return route(fresh) || AutofillCore.setValue(Object.assign({}, desc, { el: fresh }), value);
      })();
    }
  });
})();
