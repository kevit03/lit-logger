// Ashby autofill adapter: jobs.ashbyhq.com/<company>/<job-id>/application.
//
// The form is client-rendered. System fields have stable ids
// (_systemfield_name, _systemfield_email, _systemfield_resume) and every
// question sits in a .ashby-application-form-field-entry whose
// label.ashby-application-form-question-title points (for=) at the control,
// whose id is the question's UUID. Phone and LinkedIn are ordinary questions,
// so their selectors are derived from the label text at scan time (`fields`
// is a getter for that reason).
//
// Two widgets need `fill`:
// - Yes/No questions are a pair of buttons (data-option="yes"/"no",
//   aria-pressed) backed by a display:none checkbox. Clicking the button is
//   the only way to answer.
// - The location question is an input[role=combobox] autocomplete whose
//   [role=listbox] of [role=option] rows mounts after typing.
(() => {
  if (typeof AutofillCore === 'undefined' || !AutofillCore) return;

  const HOSTS = /^jobs\.ashbyhq\.com$/;

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

  const YESNO = '.ashby-application-form-input-yesno';
  const ENTRY = '.ashby-application-form-field-entry';

  const STATIC_FIELDS = [
    { selector: '#_systemfield_name, input[name="_systemfield_name"]', profileKey: 'fullName' },
    { selector: '#_systemfield_email, input[name="_systemfield_email"]', profileKey: 'email' },
    { selector: 'input#_systemfield_resume[type="file"]', profileKey: 'resume' },
    { selector: '[data-field-path="_systemfield_location"] input[role="combobox"]', profileKey: 'city' },
    { selector: '.ashby-application-form-field-entry input[type="tel"]', profileKey: 'phone' }
  ];

  // Label text -> profile key for questions whose ids are per-posting UUIDs.
  const BY_LABEL = [
    [/linked\s*in/i, 'linkedin'],
    [/git\s*hub/i, 'github'],
    [/portfolio/i, 'portfolio'],
    [/^(personal\s+)?(web\s*site|site)\b/i, 'website'],
    [/^(phone|mobile|phone number|mobile number|cell phone)$/i, 'phone']
  ];

  function labelFields(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const out = [];
    doc.querySelectorAll('label.ashby-application-form-question-title[for]').forEach(label => {
      const id = label.getAttribute('for') || '';
      if (!id || /^_systemfield_/.test(id) || /["\\]/.test(id)) return;
      const text = label.textContent.replace(/\*/g, '').trim();
      const hit = BY_LABEL.find(([re]) => re.test(text));
      if (hit) out.push({ selector: 'input[id="' + id + '"], textarea[id="' + id + '"]', profileKey: hit[1] });
    });
    return out;
  }

  function yesNo(value) {
    const v = norm(value);
    if (/^(yes|y|true)\b/.test(v)) return 'yes';
    if (/^(no|n|false)\b/.test(v)) return 'no';
    return null;
  }

  function yesNoContainer(desc) {
    const el = desc.el;
    return (el && el.closest && el.closest(YESNO)) ||
      (desc.group && desc.group.querySelector && desc.group.querySelector(YESNO)) ||
      (el && el.closest && el.closest(ENTRY) && el.closest(ENTRY).querySelector(YESNO)) ||
      null;
  }

  async function clickYesNo(desc, container, value) {
    const answer = yesNo(value);
    if (!answer) return false;
    const doc = container.ownerDocument;
    const entry = container.closest('[data-field-path]');
    const path = entry ? entry.getAttribute('data-field-path') : '';
    // Re-query by field path every time: React may swap the nodes.
    const current = () => (path && doc.querySelector('[data-field-path="' + path + '"] ' + YESNO)) ||
      (container.isConnected ? container : null);
    const button = () => {
      const c = current();
      if (!c) return null;
      return c.querySelector('button[data-option="' + answer + '"]') ||
        Array.from(c.querySelectorAll('button')).find(b => norm(b.textContent) === answer) || null;
    };
    const target = button();
    if (!target) return false;
    if (target.getAttribute('aria-pressed') === 'true') return true;
    press(target);
    const pressed = await waitFor(() => {
      const b = button();
      return b && b.getAttribute('aria-pressed') === 'true' ? b : null;
    }, doc.documentElement, timing.confirm);
    return Boolean(pressed);
  }

  async function fillAutocomplete(desc, value) {
    const input = desc.el;
    const doc = input.ownerDocument;
    const root = doc.documentElement;
    if (!input.isConnected) return false;
    if (norm(input.value) && scoreOption(input.value, value) >= 0.7) return true;
    const options = () => {
      const owned = input.getAttribute('aria-controls');
      const list = owned ? doc.querySelector('[id="' + owned + '"]') : null;
      const scope = list || doc;
      return Array.from(scope.querySelectorAll('[role="listbox"] [role="option"]'))
        .filter((o, i, all) => all.indexOf(o) === i && o.getAttribute('aria-disabled') !== 'true');
    };
    if (input.focus) input.focus();
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
      key(input, 'Escape', 27);
      return false;
    }
    const want = hit.textContent;
    press(hit);
    const done = await waitFor(() => (scoreOption(input.value, want) >= 0.9 ? input : null), root, timing.confirm);
    return Boolean(done);
  }

  AutofillCore.registerSiteAdapter({
    id: 'ashby',
    timing,
    matches(url) {
      try {
        return HOSTS.test(new URL(String(url && url.href ? url.href : url)).hostname);
      } catch (e) {
        return false;
      }
    },
    // A getter: the label-derived entries depend on the rendered form.
    get fields() {
      return STATIC_FIELDS.concat(labelFields(typeof document !== 'undefined' ? document : null));
    },
    fill(desc, value) {
      const el = desc && desc.el;
      if (!el || typeof el.matches !== 'function') return undefined;
      const yn = yesNoContainer(desc);
      if (yn) return clickYesNo(desc, yn, value);
      if (el.matches('input[role="combobox"]')) return fillAutocomplete(desc, value);
      return undefined;
    }
  });
})();
