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
  if (typeof AutofillCore === 'undefined' || !AutofillCore) return;

  const HOSTS = /^(job-)?boards(\.eu)?\.greenhouse\.io$/;

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
    const loc = AutofillCore.scoreLocation ? AutofillCore.scoreLocation(value, label) : null;
    if (loc !== null) return loc;
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
    if (current && scoreOption(current.textContent, value) >= 0.9) return true;

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
    typeInto(input, String(value));
    let hit = bestOption(await waitFor(options, root) || [], value);
    if (!hit && /,/.test(value)) {
      // Place searches can miss "Plainview, NY"; search the city alone and
      // still pick the option in the right state.
      // Wait for a matching option: the old query's results linger a moment.
      typeInto(input, String(value).split(',')[0].trim());
      hit = await waitFor(() => bestOption(options(), value), root);
    }
    if (!hit) {
      // The typed filter can hide the right option ("United States" vs "USA");
      // clear it and match against the full list.
      typeInto(input, '');
      hit = bestOption(await waitFor(options, root, timing.confirm) || [], value);
    }
    if (!hit) {
      key(input, 'Escape', 27);
      return false;
    }
    const want = hit.textContent;
    press(hit);
    const done = await waitFor(() => {
      const c = chosen();
      return c && scoreOption(c.textContent, want) >= 0.9 ? c : null;
    }, root, timing.confirm);
    return Boolean(done);
  }

  const adapter = {
    id: 'greenhouse',
    timing,
    matches(url) {
      try {
        return HOSTS.test(new URL(String(url && url.href ? url.href : url)).hostname);
      } catch (e) {
        return false;
      }
    },
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
