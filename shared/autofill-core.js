// Autofill matching and filling engine.
//
// No AI and no network: fields are found by scanning the DOM, labelled by a
// fixed list of label strategies, matched to profile keys by rules, and filled
// through the native value setters so React / Vue / Angular controlled inputs
// see the change. The engine never clicks a submit button: the only elements
// it ever clicks are the radio, checkbox, choice button, or dropdown option it
// is choosing.
//
//   normalizeLabel(text)             -> labelKey shared with AutofillStore
//   scanFields(root, opts?)          -> FieldDescriptor[]
//   describeField(el)                -> FieldDescriptor | null (one element)
//   matchField(desc, profile, rules, host, opts?) -> Match | null
//   setValue(desc, value)            -> Promise<boolean>
//   registerSiteAdapter(adapter)
//   run({ profile, rules, answers, resume, settings, root?, host?, url? }) -> Promise<Report>
//
// Match priority: site adapter fixed fields, learned rules (this host before
// global), the autocomplete attribute, the synonym dictionary, then the answer
// bank (textareas only). The first source that recognizes a field decides it:
// a learned rule pointing at an empty profile value does not fall through to a
// dictionary guess.
//
// Profile keys are the flat Profile fields plus these derived ones:
//   fullName  firstName + " " + lastName
//   location  "city, state" (country when there is no state)
//   gradDate  "gradMonth gradYear"
//   resume    the stored resume object (file inputs only)
//   eeo.<k>   profile.eeo[k], only when settings.fillEeo is on
const AutofillCore = (() => {
  'use strict';

  // --- text helpers ------------------------------------------------------------

  // AutofillStore keeps a private copy of this function; keep them identical
  // or learned rules stop matching.
  function normalizeLabel(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/\(\s*optional\s*\)/g, ' ')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\brequired\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const collapse = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const stripMarks = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Option text / value comparison form: like normalizeLabel but keeps
  // "required" and drops diacritics.
  function norm(s) {
    return stripMarks(String(s == null ? '' : s).toLowerCase())
      .replace(/['\u2019]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  // Dictionary form of a labelKey: widget filler words removed.
  function dictKey(labelKey) {
    return stripMarks(String(labelKey || ''))
      .replace(/\b(optional|please select|select one|select an option|choose one|select|e g)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // "job_application[first_name]" -> "job application first name";
  // "firstName" -> "first name".
  function splitIdent(s) {
    return normalizeLabel(String(s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-[\].:]+/g, ' '));
  }

  const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'at', 'by', 'with',
    'is', 'are', 'was', 'were', 'be', 'do', 'does', 'did', 'you', 'your', 'yours', 'we', 'us', 'our', 'i', 'me',
    'my', 'it', 'its', 'this', 'that', 'what', 'which', 'who', 'how', 'please', 'any', 'have', 'has', 'if', 'as',
    'about', 'from', 'can', 'will', 'would', 'should']);

  function tokens(s, dropStop = true) {
    return norm(s).split(' ').filter(t => t && (!dropStop || !STOPWORDS.has(t)));
  }

  function jaccard(a, b) {
    const A = new Set(a);
    const B = new Set(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(t => { if (B.has(t)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  function hasWords(hay, needle) {
    if (!needle) return false;
    return (' ' + hay + ' ').includes(' ' + needle + ' ');
  }

  // --- option matching -----------------------------------------------------------

  const US_STATES = [
    ['al', 'alabama'], ['ak', 'alaska'], ['az', 'arizona'], ['ar', 'arkansas'], ['ca', 'california'],
    ['co', 'colorado'], ['ct', 'connecticut'], ['de', 'delaware'], ['fl', 'florida'], ['ga', 'georgia'],
    ['hi', 'hawaii'], ['id', 'idaho'], ['il', 'illinois'], ['in', 'indiana'], ['ia', 'iowa'], ['ks', 'kansas'],
    ['ky', 'kentucky'], ['la', 'louisiana'], ['me', 'maine'], ['md', 'maryland'], ['ma', 'massachusetts'],
    ['mi', 'michigan'], ['mn', 'minnesota'], ['ms', 'mississippi'], ['mo', 'missouri'], ['mt', 'montana'],
    ['ne', 'nebraska'], ['nv', 'nevada'], ['nh', 'new hampshire'], ['nj', 'new jersey'], ['nm', 'new mexico'],
    ['ny', 'new york'], ['nc', 'north carolina'], ['nd', 'north dakota'], ['oh', 'ohio'], ['ok', 'oklahoma'],
    ['or', 'oregon'], ['pa', 'pennsylvania'], ['ri', 'rhode island'], ['sc', 'south carolina'],
    ['sd', 'south dakota'], ['tn', 'tennessee'], ['tx', 'texas'], ['ut', 'utah'], ['vt', 'vermont'],
    ['va', 'virginia'], ['wa', 'washington'], ['wv', 'west virginia'], ['wi', 'wisconsin'], ['wy', 'wyoming'],
    ['dc', 'district of columbia', 'washington dc', 'washington d c']
  ];
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
    'october', 'november', 'december'];

  // Each group lists equivalent normalized spellings; a shared `family` scores
  // lower than the same group (BS vs a generic "Bachelor's Degree").
  const ALIAS_GROUPS = [
    { members: ['yes', 'y', 'true'] },
    { members: ['no', 'n', 'false'] },
    { members: ['us', 'usa', 'u s', 'u s a', 'united states', 'united states of america', 'america'] },
    { members: ['uk', 'u k', 'united kingdom', 'great britain', 'gb', 'britain'] },
    { members: ['uae', 'united arab emirates'] },
    { members: ['male', 'man', 'm'] },
    { members: ['female', 'woman', 'f'] },
    { members: ['non binary', 'nonbinary', 'genderqueer', 'non binary genderqueer'] },
    { members: ['bachelors', 'bachelor', 'bachelors degree', 'bachelor degree', 'undergraduate'], family: 'bachelor' },
    { members: ['bs', 'b s', 'bsc', 'b sc', 'bachelor of science', 'bachelors of science'], family: 'bachelor' },
    { members: ['ba', 'b a', 'bachelor of arts', 'bachelors of arts'], family: 'bachelor' },
    { members: ['beng', 'b eng', 'bachelor of engineering'], family: 'bachelor' },
    { members: ['masters', 'master', 'masters degree', 'master degree', 'graduate'], family: 'master' },
    { members: ['ms', 'm s', 'msc', 'm sc', 'master of science', 'masters of science'], family: 'master' },
    { members: ['ma', 'm a', 'master of arts', 'masters of arts'], family: 'master' },
    { members: ['mba', 'master of business administration'], family: 'master' },
    { members: ['meng', 'm eng', 'master of engineering'], family: 'master' },
    { members: ['phd', 'ph d', 'doctorate', 'doctoral', 'doctor of philosophy', 'doctoral degree'] },
    { members: ['associates', 'associate', 'associates degree', 'associate degree'] },
    { members: ['high school', 'high school diploma', 'ged', 'secondary school'] }
  ]
    .concat(US_STATES.map(s => ({ members: s })))
    .concat(MONTHS.map((m, i) => ({ members: [m, m.slice(0, 3), String(i + 1), String(i + 1).padStart(2, '0')] })));

  const ALIAS_INDEX = new Map();
  ALIAS_GROUPS.forEach((g, i) => g.members.forEach(m => { if (!ALIAS_INDEX.has(m)) ALIAS_INDEX.set(m, { id: i, family: g.family || null }); }));

  // Alias groups that name a place (a US state or a country).
  const PLACE_IDS = new Set(['us', 'uk', 'uae'].concat(US_STATES.map(s => s[0])).map(m => ALIAS_INDEX.get(m).id));

  // "Plainview, NY" vs "Plainview, New York, United States": a place option
  // must name the same city first and, among its other parts, every state or
  // country the value names, abbreviated or not. Same city in another state
  // scores 0 so a same-named town is never picked. null when the value isn't
  // "city, state/country", so the caller scores normally.
  function scoreLocation(value, option) {
    const parts = s => String(s == null ? '' : s).split(',')
      .map(p => norm(p).replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const place = p => { const a = ALIAS_INDEX.get(p); return a && PLACE_IDS.has(a.id) ? a.id : null; };
    const v = parts(value);
    const o = parts(option);
    if (v.length < 2 || !o.length || o[0] !== v[0]) return null;
    const regions = v.slice(1).map(place);
    if (regions.some(r => r === null)) return null;
    if (o.length === 1) return 0.8;
    const have = new Set(o.slice(1).map(place));
    return regions.every(r => have.has(r)) ? 0.95 : 0;
  }

  const DECLINE_RE = /\b(decline|declined|prefer not|rather not|do not wish|dont wish|not wish|choose not|not to (say|answer|disclose|self identify|specify)|wish to answer|wish to self identify|not disclose)\b/;
  const NEGATION_RE = /\b(no|not|dont|do not|never|none|neither|cannot|cant|wont|will not)\b/;
  const YES_RE = /^(yes|y|true|1|on|checked|agree|i agree)$/;
  const NO_RE = /^(no|n|false|0|off|unchecked)$/;

  function scoreOption(value, option) {
    const v = norm(value);
    const o = norm(option);
    if (!v || !o) return 0;
    if (v === o) return 1;
    const loc = scoreLocation(value, option);
    if (loc !== null) return loc;
    const ga = ALIAS_INDEX.get(v);
    const gb = ALIAS_INDEX.get(o);
    if (ga && gb) {
      if (ga.id === gb.id) return 0.95;
      if (ga.family && ga.family === gb.family) return 0.75;
    }
    if (DECLINE_RE.test(v) && DECLINE_RE.test(o)) return 0.9;
    // "yes" vs "Yes, I am authorized" / "no" vs "No, I will not"
    if ((v === 'yes' || v === 'no') && o.split(' ')[0] === v) return 0.9;
    if (o.startsWith(v + ' ') || v.startsWith(o + ' ')) return 0.8;
    if (hasWords(o, v)) return 0.7;
    if (o.length >= 2 && !STOPWORDS.has(o) && hasWords(v, o)) return 0.65;
    // An option that is an alias of a word in the value ("California" in "San Jose, CA").
    const j = jaccard(tokens(v), tokens(o));
    if (j >= 0.5) return 0.5 + 0.2 * j;
    return 0;
  }

  // Best option for a value. Yes/no values also pick between affirmative and
  // negative sentences ("I am not a protected veteran") when no option starts
  // with yes/no. Returns { index, score } or null below 0.5.
  function bestOption(value, options) {
    const list = Array.isArray(options) ? options : [];
    let best = null;
    list.forEach((opt, index) => {
      const alts = Array.isArray(opt) ? opt : [opt];
      let score = 0;
      alts.forEach(a => { score = Math.max(score, scoreOption(value, a)); });
      if (score > 0 && (!best || score > best.score)) best = { index, score };
    });
    if (best && best.score >= 0.5) return best;
    const v = norm(value);
    const yes = YES_RE.test(v);
    const no = NO_RE.test(v);
    if (yes || no) {
      const texts = list.map(opt => norm(Array.isArray(opt) ? opt[0] : opt));
      const candidates = texts
        .map((t, index) => ({ t, index }))
        .filter(c => c.t && !DECLINE_RE.test(c.t));
      const pick = candidates.find(c => (no ? NEGATION_RE.test(c.t) : !NEGATION_RE.test(c.t)));
      if (pick) return { index: pick.index, score: 0.7 };
    }
    return null;
  }

  // --- DOM helpers ---------------------------------------------------------------

  const CONTROL_SELECTOR = 'input, select, textarea, [role="combobox"], button, [role="button"], ' +
    '[role="radio"], [role="checkbox"], [role="option"], [tabindex], [aria-pressed], [aria-checked], [aria-selected], ' +
    '[data-state], [data-headlessui-state]';
  const NEVER_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password']);
  const SKIP_INPUT_TYPES = new Set(['search', 'range', 'color']);
  const SKIP_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'BUTTON', 'SVG']);
  // Matched against norm()'d text, so "--Select--" arrives as "select".
  // "Choose not to disclose" is a real answer, not a placeholder.
  const PLACEHOLDER_RE = /^$|^(none selected|no selection)$|^(please )?(select|choose|pick)\b(?!.*\bnot\b)/;
  const IGNORE_SELECTOR = '[data-lit-autofill-ignore]';
  const TEXT_KINDS = new Set(['text', 'email', 'tel', 'url', 'textarea']);

  const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);
  const tagOf = el => String((el && el.tagName) || '').toUpperCase();
  // The type attribute lowercased, '' when there is none.
  const typeAttr = el => String(attr(el, 'type') || '').toLowerCase();
  const isHiddenInput = el => tagOf(el) === 'INPUT' && typeAttr(el) === 'hidden';
  const opensListbox = el => String(attr(el, 'aria-haspopup') || '').toLowerCase() === 'listbox';

  // el.closest that never throws (an odd selector engine, a foreign node).
  function closestSafe(el, selector) {
    try { return el && el.closest ? el.closest(selector) : null; } catch (_) { return null; }
  }

  function hiddenByAttr(el) {
    return !!(el && el.hasAttribute && (el.hasAttribute('hidden') || attr(el, 'aria-hidden') === 'true'));
  }

  function computed(el) {
    try {
      const view = el.ownerDocument && el.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === 'function') return view.getComputedStyle(el);
      if (typeof getComputedStyle === 'function') return getComputedStyle(el);
    } catch (_) { /* detached or cross-realm */ }
    return null;
  }

  function isRendered(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.closest && el.closest('[hidden]')) return false;
      const cs = computed(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false;
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    } catch (_) { return false; }
    return true;
  }

  function isDisabled(el) {
    if (el.disabled === true || (el.hasAttribute && el.hasAttribute('disabled'))) return true;
    if (attr(el, 'aria-disabled') === 'true') return true;
    return !!closestSafe(el, 'fieldset[disabled]');
  }

  function isReadOnly(el) {
    return el.readOnly === true || !!(el.hasAttribute && el.hasAttribute('readonly'));
  }

  function rootNodeOf(el) {
    if (el && typeof el.getRootNode === 'function') return el.getRootNode();
    let n = el;
    while (n && n.parentNode) n = n.parentNode;
    if (n && n.host) return n;
    return (el && el.ownerDocument) || n;
  }

  function byId(scope, id) {
    if (!scope || !id) return null;
    if (typeof scope.getElementById === 'function') return scope.getElementById(id);
    const all = scope.querySelectorAll ? scope.querySelectorAll('[id]') : [];
    for (const e of Array.from(all)) if (e.id === id) return e;
    return null;
  }

  function childNodesOf(node) {
    if (node.childNodes) return Array.from(node.childNodes);
    return Array.from(node.children || []);
  }

  // The node before (dir -1) or after (dir 1) this one, text nodes included.
  // Falls back to the parent's child list for DOMs without sibling links.
  function siblingOf(node, dir) {
    const own = dir < 0 ? node.previousSibling : node.nextSibling;
    if (own !== undefined) return own;
    const p = node.parentNode;
    if (!p) return null;
    const kids = childNodesOf(p);
    const i = kids.indexOf(node);
    const j = i + dir;
    return i >= 0 && j >= 0 && j < kids.length ? kids[j] : null;
  }
  const prevSibling = node => siblingOf(node, -1);
  const nextSibling = node => siblingOf(node, 1);

  function textOf(node, isRoot = true, depth = 0) {
    if (!node || depth > 40) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1 && node.nodeType !== 11) return '';
    if (node.nodeType === 1) {
      if (!isRoot && SKIP_TEXT_TAGS.has(tagOf(node))) return '';
      if (hiddenByAttr(node)) return '';
    }
    if (!node.childNodes && node.ownText === undefined) return node.textContent || '';
    let out = '';
    for (const c of childNodesOf(node)) out += ' ' + textOf(c, false, depth + 1);
    return out;
  }

  const cleanText = s => collapse(s).slice(0, 300);

  function isControl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = tagOf(el);
    if (tag === 'INPUT') return !NEVER_INPUT_TYPES.has(typeAttr(el) || 'text');
    if (tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (attr(el, 'role') === 'combobox') return true;
    if (tag === 'BUTTON' && opensListbox(el)) return true;
    return isChoiceLike(el) && !!choiceGroupOf(el);
  }

  // --- choice buttons ------------------------------------------------------------
  // Multiple-choice questions drawn as a row of plain buttons ("Yes" / "No",
  // "0-2 years" / "3-5 years") have no input behind them; clicking is the only
  // way to answer. A choice group is 2-12 short-labelled buttons sharing a
  // container that holds no other control. Action buttons (Next, Submit,
  // Upload, Add another...) never count, and inside a <form> a button must say
  // type="button", because a bare <button> there submits the form.
  //
  // The same goes for answer cards drawn as a plain div / li / span / label
  // that takes focus or shows a picked state ("tiles"), and for the options
  // of a listbox drawn in the page rather than popped up by a dropdown. A
  // group whose question says "select all that apply" (or whose listbox is
  // aria-multiselectable) is a checkbox question: several members are picked.
  const CHOICE_MAX = 12;
  const TILE_TAGS = new Set(['DIV', 'LI', 'SPAN', 'LABEL']);
  const TILE_INNER = 'input, select, textarea, button, a, [role="button"], [role="radio"], [role="checkbox"], [role="option"]';
  // Everything a tile or option can be found by (see hasChoiceState).
  const CHOICE_CANDIDATES = '[role="option"], [tabindex], [aria-pressed], [aria-checked], [aria-selected], ' +
    '[data-state], [data-headlessui-state]';
  const MULTI_RE = /\b(all|any|each) (that|which) appl(y|ies)\b|\b(select|check|choose|pick|mark|tick) (all|any|multiple|one or more|as many|up to \w+)\b/;
  const ACTION_RE = new RegExp('^(submit( application)?|apply( now)?|next( step| page)?|continue|back|go back|previous|prev|' +
    'save( and continue| draft| changes)?|cancel|close|done|finish|review|upload( file| resume| cv)?|attach( file| resume)?|' +
    'browse|add( another| more| new| item)?|remove|delete|edit|clear|reset|sign in|log in|login|sign up|register|share|' +
    'print|download|copy( link)?|show (more|less)|learn more|view( more| all| job)?|search|enter manually|skip|' +
    'accept( all| cookies)?|reject( all)?|ok|okay|got it|dismiss|help|menu|x|autofill|fill again|' +
    'dropbox|google drive|one ?drive|locate me|use (my|current) location|(upload|import|apply) (from|with) .+)$');
  const NOT_CHOICE_SCOPE = 'nav, header, footer, [role="navigation"], [role="listbox"], [role="menu"], [role="menubar"], ' +
    '[role="toolbar"], [role="tablist"], [data-lit-autofill-ignore]';
  const STATE_ATTRS = ['aria-pressed', 'aria-checked', 'aria-selected'];
  const STATE_CLASS_RE = /(^|[\s_-])(selected|checked|pressed|active|chosen)($|[\s_-])/i;
  // Groups found during one scan; label extraction asks about the same
  // buttons many times.
  let choiceCache = null;

  function isButtonish(el) {
    return tagOf(el) === 'BUTTON' || String(attr(el, 'role') || '').toLowerCase() === 'button';
  }

  function isTile(el) {
    if (!TILE_TAGS.has(tagOf(el)) || attr(el, 'role')) return false;
    const tab = attr(el, 'tabindex');
    if ((tab == null || tab === '-1') && !hasChoiceState(el)) return false;
    try { return !el.querySelector(TILE_INNER); } catch (_) { return false; }
  }

  // A listbox drawn in the page as the answer list, not a dropdown's popup:
  // nothing points at it, it sits in no combobox, and it is not floated.
  function isStandaloneList(list) {
    if (!list || !isRendered(list)) return false;
    try {
      if (list.parentElement && list.parentElement.closest('[role="combobox"]')) return false;
      const id = String(list.id || '').replace(/"/g, '');
      if (id && rootNodeOf(list).querySelector('[aria-controls*="' + id + '"], [aria-owns*="' + id + '"]')) return false;
    } catch (_) { return false; }
    for (let n = list, i = 0; n && i < 3; n = n.parentElement, i++) {
      const cs = computed(n);
      if (cs && (cs.position === 'absolute' || cs.position === 'fixed')) return false;
    }
    return true;
  }

  function isListOption(el) {
    if (String(attr(el, 'role') || '').toLowerCase() !== 'option') return false;
    try { return isStandaloneList(el.closest('[role="listbox"]')); } catch (_) { return false; }
  }

  // Which kind of clickable answer an element is, or null.
  function choiceFamily(el) {
    if (isButtonish(el)) return 'button';
    if (isListOption(el)) return 'option';
    return isTile(el) ? 'tile' : null;
  }

  function isChoiceLike(el) {
    return choiceFamily(el) !== null;
  }

  function choiceText(el) {
    return norm(textOf(el)) || norm(attr(el, 'aria-label') || '');
  }

  function isChoiceButton(el) {
    const family = choiceFamily(el);
    if (!family) return false;
    const popup = String(attr(el, 'aria-haspopup') || '').toLowerCase();
    if (popup && popup !== 'false') return false;
    try {
      if (tagOf(el) === 'BUTTON') {
        const type = typeAttr(el);
        if (type === 'submit' || type === 'reset') return false;
        if (!type && el.closest('form')) return false;
      }
      // An option's own listbox was already vetted by isStandaloneList.
      const scope = family === 'option' ? (el.closest('[role="listbox"]') || el).parentElement : el;
      if (scope && scope.closest(NOT_CHOICE_SCOPE)) return false;
    } catch (_) { return false; }
    const text = choiceText(el);
    if (!text || text.length > 60 || text.split(' ').length > 8) return false;
    return !ACTION_RE.test(text) && !/\bsubmit\b/.test(text);
  }

  function hasChoiceState(el) {
    if (STATE_ATTRS.some(a => attr(el, a) !== null && attr(el, a) !== undefined)) return true;
    return attr(el, 'data-state') != null || attr(el, 'data-headlessui-state') != null;
  }

  function hasOtherControl(node) {
    try {
      return Array.from(node.querySelectorAll('input, select, textarea, [role="combobox"], [contenteditable="true"]'))
        .some(c => !isHiddenInput(c));
    } catch (_) { return true; }
  }

  // Page chrome (filters, pagination, share bars) can also be a row of short
  // buttons, so a group must sit in a form, expose a pressed/selected state,
  // be marked up as a group, or follow a question.
  function looksLikeQuestion(container, members, question) {
    if (closestSafe(container, 'form, fieldset, [role="group"], [role="radiogroup"]')) return true;
    if (members.some(hasChoiceState)) return true;
    return /\?\s*\*?\s*$/.test(question);
  }

  function isMultiChoice(container, question) {
    if (closestSafe(container, '[aria-multiselectable="true"]')) return true;
    return MULTI_RE.test(norm([question, attr(container, 'aria-label'), labelledByText(container)].join(' ')));
  }

  // Members are the element's own family: buttons with buttons, tiles with
  // tiles of the same tag, options with options.
  function findChoiceGroup(el) {
    if (!isChoiceButton(el)) return null;
    const family = choiceFamily(el);
    const peer = c => choiceFamily(c) === family && (family !== 'tile' || tagOf(c) === tagOf(el));
    let node = el.parentElement;
    for (let depth = 0; depth < 4 && node; depth++, node = node.parentElement) {
      const tag = tagOf(node);
      if (tag === 'FORM' || tag === 'BODY' || tag === 'HTML') return null;
      let buttons = [];
      try { buttons = Array.from(node.querySelectorAll(family === 'button' ? 'button, [role="button"]' : CHOICE_CANDIDATES)).filter(peer); } catch (_) { return null; }
      buttons = buttons.filter(b => !buttons.some(o => o !== b && o.contains && o.contains(b)));
      if (buttons.length < 2) continue;
      if (buttons.length > CHOICE_MAX || !buttons.every(isChoiceButton) || hasOtherControl(node)) return null;
      // Tiles and options beside real buttons are some other widget.
      try { if (family !== 'button' && node.querySelector('button, [role="button"]')) return null; } catch (_) { return null; }
      const question = precedingText(buttons[0], new Set(buttons)) || '';
      if (!looksLikeQuestion(node, buttons, question)) return null;
      return { container: node, members: buttons, multi: isMultiChoice(node, question) };
    }
    return null;
  }

  // 'radio' or 'checkbox' for a member of a choice group, null otherwise.
  function choiceKind(el) {
    const group = choiceGroupOf(el);
    return group ? (group.multi ? 'checkbox' : 'radio') : null;
  }

  // Runs fn with a choice-group cache: the caller's when one is open (a scan
  // in progress), else a fresh one dropped afterwards.
  function withChoiceCache(fn) {
    const outer = choiceCache;
    if (!outer) choiceCache = new Map();
    try {
      return fn();
    } finally {
      choiceCache = outer;
    }
  }

  // Finding a group reads the question text before it, which can ask about a
  // neighbouring group, which reads text that reaches back to this one. A
  // lookup in progress is cached as "no group" so that loop ends at once.
  function choiceGroupOf(el) {
    return withChoiceCache(() => {
      if (!choiceCache.has(el)) {
        choiceCache.set(el, null);
        const group = findChoiceGroup(el);
        choiceCache.set(el, group);
        if (group) group.members.forEach(m => choiceCache.set(m, group));
      }
      return choiceCache.get(el);
    });
  }

  // Attribute and class text that changes when a button is picked, for
  // buttons that show their state only through generated class names.
  function stateSignature(el) {
    const own = n => (n ? [attr(n, 'class')].concat(STATE_ATTRS.map(a => attr(n, a)), [attr(n, 'data-state'), attr(n, 'style')]).join('|') : '');
    return own(el) + '#' + own(el.parentElement);
  }

  function containsControl(node, exclude) {
    if (!node || node.nodeType !== 1) return false;
    const counts = c => isControl(c) && !(exclude && exclude.has(c));
    if (counts(node)) return true;
    try { return Array.from(node.querySelectorAll(CONTROL_SELECTOR)).some(counts); } catch (_) { return false; }
  }

  // --- label extraction ----------------------------------------------------------

  // Per-scan cache of label[for] lookups, keyed by root node.
  function labelForText(el, ctx) {
    const root = rootNodeOf(el);
    // Ashby points label[for] at a hidden checkbox's name, not an id.
    const name = el.id ? '' : String(attr(el, 'name') || '');
    const id = el.id || (name && !byId(root, name) ? name : '');
    if (!id) return '';
    let map = ctx && ctx.labels.get(root);
    if (!map) {
      map = new Map();
      try {
        Array.from(root.querySelectorAll ? root.querySelectorAll('label') : []).forEach(l => {
          const f = attr(l, 'for');
          if (f && !map.has(f)) map.set(f, l);
        });
      } catch (_) { /* ignore */ }
      if (ctx) ctx.labels.set(root, map);
    }
    const label = map.get(id);
    return label ? cleanText(textOf(label)) : '';
  }

  function wrappingLabelText(el) {
    const label = closestSafe(el.parentElement, 'label');
    return label ? cleanText(textOf(label)) : '';
  }

  function legendText(fieldset) {
    const legend = fieldset.querySelector && fieldset.querySelector('legend');
    return legend ? cleanText(textOf(legend)) : '';
  }

  function labelledByText(el) {
    const ids = String(attr(el, 'aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    const root = rootNodeOf(el);
    return cleanText(ids.map(id => {
      const n = byId(root, id);
      return n ? textOf(n) : '';
    }).join(' '));
  }

  function nextSiblingText(el) {
    let n = nextSibling(el);
    while (n) {
      if (n.nodeType === 3) { const t = collapse(n.nodeValue); if (t) return cleanText(t); }
      else if (n.nodeType === 1) {
        if (isControl(n) || containsControl(n)) return '';
        const t = collapse(textOf(n));
        if (t) return cleanText(t);
      }
      n = nextSibling(n);
    }
    return '';
  }

  // The nearest text before the field in its container: walk up a few levels
  // and look at earlier siblings, stopping as soon as a sibling holds another
  // field (that text belongs to it). `exclude` holds the field's own group.
  function precedingText(el, exclude) {
    let node = el;
    for (let depth = 0; depth < 6 && node; depth++) {
      const tag = tagOf(node);
      if (node !== el && tag === 'FIELDSET') {
        const t = legendText(node);
        if (t) return t;
      }
      if (tag === 'FORM' || tag === 'BODY' || node.host) return '';
      let sib = prevSibling(node);
      while (sib) {
        if (sib.nodeType === 3) {
          const t = collapse(sib.nodeValue);
          if (t) return cleanText(t);
        } else if (sib.nodeType === 1 && !hiddenByAttr(sib)) {
          const forId = tagOf(sib) === 'LABEL' ? attr(sib, 'for') : null;
          const forEl = forId ? byId(rootNodeOf(sib), forId) : null;
          if (forEl && exclude && exclude.has(forEl)) { sib = prevSibling(sib); continue; }
          if (forEl && forEl !== el) return '';
          if (containsControl(sib, exclude)) return '';
          const t = collapse(textOf(sib));
          if (t) return cleanText(t);
        }
        sib = prevSibling(sib);
      }
      node = node.parentElement || null;
    }
    return '';
  }

  // The first non-empty text the strategies give, tried in order. A strategy
  // that throws (odd markup, a detached node) counts as finding nothing.
  function firstText(strategies) {
    for (const s of strategies) {
      let t = '';
      try { t = s(); } catch (_) { t = ''; }
      if (t) return t;
    }
    return '';
  }

  const attrText = (el, name) => cleanText(attr(el, name) || '');

  // A field's question, best source first.
  function fieldLabel(el, ctx, kind) {
    return firstText([
      () => labelForText(el, ctx),
      () => wrappingLabelText(el),
      () => labelledByText(el),
      () => attrText(el, 'aria-label'),
      () => (kind === 'checkbox' ? nextSiblingText(el) : ''),
      () => precedingText(el, new Set([el])),
      () => attrText(el, 'placeholder'),
      () => attrText(el, 'title'),
      () => attrText(el, 'name')
    ]);
  }

  // One radio's / checkbox's / choice button's own answer text ("Yes").
  function optionLabel(input, ctx) {
    return firstText([
      () => labelForText(input, ctx),
      () => wrappingLabelText(input),
      () => labelledByText(input),
      () => attrText(input, 'aria-label'),
      () => (tagOf(input) === 'INPUT' ? '' : cleanText(textOf(input))),
      () => nextSiblingText(input),
      () => attrText(input, 'value')
    ]);
  }

  // --- descriptors ---------------------------------------------------------------

  function kindOf(el) {
    const tag = tagOf(el);
    const role = String(attr(el, 'role') || '').toLowerCase();
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      const type = typeAttr(el) || 'text';
      if (NEVER_INPUT_TYPES.has(type)) return null;
      if (type === 'radio' || type === 'checkbox' || type === 'file') return type;
      if (role === 'combobox' || closestSafe(el.parentElement, '[role="combobox"]')) return 'combobox';
      if (SKIP_INPUT_TYPES.has(type)) return null;
      if (type === 'email' || type === 'tel' || type === 'url') return type;
      return 'text';
    }
    if (tag === 'BUTTON') {
      const type = typeAttr(el);
      if (type === 'submit' || type === 'reset') return null;
      if (role === 'combobox' || opensListbox(el)) return 'combobox';
      return choiceKind(el);
    }
    if (role === 'button' || role === 'option') return choiceKind(el);
    if (role === 'radio' || role === 'checkbox') {
      // Custom radios and checkboxes: only inside a group or form, so page
      // chrome toggles (cookie banners, menus) are not taken for questions.
      return closestSafe(el, role === 'radio' ? '[role="radiogroup"]' : '[role="group"], form') ? role : null;
    }
    if (role === 'combobox') {
      // ARIA 1.1 wrapper around a text input: the input is the field.
      try { if (el.querySelector && el.querySelector('input, textarea')) return null; } catch (_) { /* ignore */ }
      return 'combobox';
    }
    return isTile(el) ? choiceKind(el) : null;
  }

  function isPlaceholderOption(opt) {
    const value = opt.getAttribute && opt.getAttribute('value') !== null ? String(opt.value == null ? attr(opt, 'value') : opt.value) : null;
    const text = norm(opt.text != null ? opt.text : opt.textContent);
    if (value === '') return true;
    return PLACEHOLDER_RE.test(text);
  }

  function selectOptions(el) {
    return Array.from(el.options || el.querySelectorAll('option'));
  }

  // The options a select shows as picked (several in a multi-select).
  function chosenOptions(el) {
    return selectOptions(el).filter((o, i) => o.selected || i === el.selectedIndex);
  }

  function optionText(o) {
    return collapse(o.text != null ? o.text : o.textContent);
  }

  // Text of a dropdown's [role=option] row.
  const nodeText = o => collapse(textOf(o));

  function comboboxText(el) {
    if (tagOf(el) === 'INPUT') return collapse(el.value);
    return nodeText(el);
  }

  // A dropdown input is filled when it holds text or a react-select style
  // chosen value sits beside it; any other dropdown when it shows text that
  // is not a placeholder.
  function comboboxFilled(el) {
    if (tagOf(el) !== 'INPUT') {
      const t = norm(comboboxText(el));
      return !!t && !PLACEHOLDER_RE.test(t);
    }
    if (collapse(el.value)) return true;
    let n = el.parentElement;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      try {
        const v = n.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]');
        if (v && nodeText(v)) return true;
      } catch (_) { break; }
    }
    return false;
  }

  function isFilled(desc) {
    const el = desc.el;
    switch (desc.kind) {
      case 'select':
        return chosenOptions(el).some(o => !isPlaceholderOption(o));
      case 'radio':
      case 'checkbox':
        return currentValue(desc) !== '';
      case 'file':
        return !!(el.files && el.files.length);
      case 'combobox':
        return comboboxFilled(el);
      default:
        return collapse(el.value) !== '';
    }
  }

  function makeCtx() { return { labels: new Map() }; }

  function lowestCommonAncestor(nodes) {
    if (!nodes.length) return null;
    let a = nodes[0].parentElement;
    while (a && !nodes.every(n => a.contains(n))) a = a.parentElement;
    return a;
  }

  function groupContainer(inputs) {
    const first = inputs[0];
    try {
      const c = first.closest('fieldset, [role="radiogroup"], [role="group"]');
      if (c && inputs.every(i => c.contains(i))) return c;
    } catch (_) { /* ignore */ }
    if (inputs.length > 1) return lowestCommonAncestor(inputs);
    return first.parentElement;
  }

  function groupLabel(container, inputs, ctx) {
    const exclude = new Set(inputs);
    if (container) {
      const own = (tagOf(container) === 'FIELDSET' && legendText(container)) ||
        labelledByText(container) || attrText(container, 'aria-label');
      if (own) return own;
    }
    const t = precedingText(inputs[0], exclude);
    if (t) return t;
    if (container) {
      const pt = precedingText(container, exclude);
      if (pt) return pt;
    }
    return attrText(inputs[0], 'name');
  }

  function isRequired(el, rawLabel) {
    if (el.required === true || (el.hasAttribute && el.hasAttribute('required'))) return true;
    if (attr(el, 'aria-required') === 'true') return true;
    return /\*|\brequired\b/i.test(rawLabel || '');
  }

  // Label text for a required check needs the raw label (with the asterisk).
  function buildDescriptor(el, kind, ctx, extra) {
    const label = extra && extra.label != null ? extra.label : fieldLabel(el, ctx, kind);
    const desc = {
      el,
      kind,
      label: label.replace(/\s*\*+\s*$/, '').replace(/^\*+\s*/, ''),
      labelKey: normalizeLabel(label),
      name: attr(el, 'name') || '',
      id: el.id || '',
      autocomplete: String(attr(el, 'autocomplete') || '').toLowerCase(),
      placeholder: attr(el, 'placeholder') || '',
      options: [],
      required: false
    };
    if (extra && extra.group) desc.group = extra.group;
    if (extra && extra.inputs) desc.inputs = extra.inputs;
    desc.required = (desc.inputs || [el]).some(i => isRequired(i, '')) || isRequired(desc.group || el, label);
    desc.options = fieldOptions(desc, ctx, !!(extra && extra.isGroup));
    return desc;
  }

  // The answers a field offers: a select's real options, a group's option
  // labels, the rendered list a dropdown points at. [] when unknown.
  function fieldOptions(desc, ctx, isGroup) {
    const el = desc.el;
    if (desc.kind === 'select') return selectOptions(el).filter(o => !isPlaceholderOption(o)).map(optionText).filter(Boolean);
    if ((desc.kind === 'radio' || desc.kind === 'checkbox') && desc.inputs && isGroup) return desc.inputs.map(i => optionLabel(i, ctx));
    if (desc.kind === 'combobox') {
      const listId = attr(el, 'aria-controls') || attr(el, 'aria-owns');
      const list = listId ? byId(rootNodeOf(el), listId) : null;
      if (list) {
        try { return Array.from(list.querySelectorAll('[role="option"]')).map(nodeText).filter(Boolean); } catch (_) { /* ignore */ }
      }
    }
    return [];
  }

  // Ant Design (TikTok's form) and other React kits render radios with no
  // name, so the group is the nearest ancestor holding other nameless inputs
  // of the type, stopping at one that holds a different field. Nameless
  // checkboxes group only inside a container marked as a group: two consent
  // boxes side by side are separate questions.
  function namelessGroup(el, type) {
    const peer = c => tagOf(c) === 'INPUT' && typeAttr(c) === type && !attr(c, 'name');
    let node = el.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      const tag = tagOf(node);
      if (tag === 'FORM' || tag === 'BODY' || tag === 'HTML') break;
      let all = [];
      try { all = Array.from(node.querySelectorAll('input, select, textarea, [role="combobox"]')); } catch (_) { break; }
      if (all.some(c => !peer(c) && !isHiddenInput(c))) break;
      const peers = all.filter(peer);
      if (peers.length < 2) continue;
      if (type === 'checkbox' && !(tag === 'FIELDSET' || attr(node, 'role') === 'group' || /group/i.test(String(attr(node, 'class') || '')))) break;
      return peers;
    }
    return [el];
  }

  function sameScopeInputs(el, type) {
    if (tagOf(el) !== 'INPUT' && isChoiceLike(el)) {
      const choice = choiceGroupOf(el);
      return choice ? choice.members : [el];
    }
    if (tagOf(el) !== 'INPUT') {
      const group = closestSafe(el, type === 'radio' ? '[role="radiogroup"]' : '[role="group"]');
      if (!group) return [el];
      let members = [];
      try { members = Array.from(group.querySelectorAll('[role="' + type + '"]')).filter(m => tagOf(m) !== 'INPUT'); } catch (_) { members = []; }
      return members.length ? members : [el];
    }
    const name = attr(el, 'name');
    if (!name) return namelessGroup(el, type);
    const scope = closestSafe(el, 'form') || rootNodeOf(el);
    let all = [];
    try { all = Array.from(scope.querySelectorAll('input')); } catch (_) { all = [el]; }
    const same = all.filter(i => typeAttr(i) === type && attr(i, 'name') === name);
    return same.length ? same : [el];
  }

  function describeGroup(el, kind, ctx) {
    const inputs = sameScopeInputs(el, kind);
    if (kind === 'checkbox' && inputs.length < 2) {
      return buildDescriptor(el, 'checkbox', ctx, { inputs: [el] });
    }
    let container = null;
    try {
      container = el.closest('[role="radiogroup"], [role="group"]');
      if (container && !inputs.every(i => container.contains(i))) container = null;
    } catch (_) { container = null; }
    if (!container && tagOf(el) !== 'INPUT' && isChoiceLike(el)) {
      const choice = choiceGroupOf(el);
      if (choice) container = choice.container;
    }
    container = container || groupContainer(inputs);
    const label = groupLabel(container, inputs, ctx);
    return buildDescriptor(inputs[0], kind, ctx, { inputs, group: container || undefined, label, isGroup: true });
  }

  // A FieldDescriptor for one element, ignoring visibility (used for adapter
  // fixed fields and by the UI to look up a field the user just edited).
  function describeField(el, ctx) {
    if (!el || el.nodeType !== 1) return null;
    const kind = kindOf(el);
    if (!kind) return null;
    const c = ctx || makeCtx();
    if (kind === 'radio' || kind === 'checkbox') return describeGroup(el, kind, c);
    return buildDescriptor(el, kind, c);
  }

  function isIgnored(el) {
    return !!closestSafe(el, IGNORE_SELECTOR);
  }

  function visibleEnough(el, kind) {
    if (isRendered(el)) return true;
    // Styled radios, checkboxes and file pickers often hide the real input
    // behind a visible wrapper.
    if (kind === 'radio' || kind === 'checkbox' || kind === 'file') return isRendered(el.parentElement);
    return false;
  }

  function forEachElement(root, fn, depth = 0) {
    if (!root || depth > 200) return;
    const kids = root.children ? Array.from(root.children) : (root.documentElement ? [root.documentElement] : []);
    for (const k of kids) { fn(k); forEachElement(k, fn, depth + 1); }
  }

  function collectControls(root, out, depth) {
    try { Array.from(root.querySelectorAll(CONTROL_SELECTOR)).forEach(e => out.push(e)); } catch (_) { return; }
    if (depth >= 4) return;
    forEachElement(root, e => {
      if (e.shadowRoot && !(e.hasAttribute && e.hasAttribute('data-lit-autofill-ignore'))) collectControls(e.shadowRoot, out, depth + 1);
    });
  }

  function defaultDocument() {
    return typeof document !== 'undefined' ? document : null;
  }

  // opts.includeFilled: keep already-filled fields, marked `filled: true`.
  function scanFields(root, opts) {
    const base = root || defaultDocument();
    if (!base) return [];
    const includeFilled = !!(opts && opts.includeFilled);
    return withChoiceCache(() => {
      const raw = [];
      collectControls(base, raw, 0);
      return scanControls(raw, makeCtx(), includeFilled);
    });
  }

  function scanControls(raw, ctx, includeFilled) {
    const seen = new Set();
    const out = [];
    for (const el of raw) {
      if (seen.has(el)) continue;
      seen.add(el);
      try {
        const kind = kindOf(el);
        if (!kind || isIgnored(el)) continue;
        let desc;
        if (kind === 'radio' || kind === 'checkbox') {
          desc = describeGroup(el, kind, ctx);
          (desc.inputs || []).forEach(i => seen.add(i));
          const live = (desc.inputs || [el]).filter(i => !isDisabled(i) && visibleEnough(i, kind));
          if (!live.length) continue;
        } else {
          if (isDisabled(el)) continue;
          if (TEXT_KINDS.has(kind) && isReadOnly(el)) continue;
          if (!visibleEnough(el, kind)) continue;
          desc = buildDescriptor(el, kind, ctx);
        }
        if (isFilled(desc)) {
          if (!includeFilled) continue;
          desc.filled = true;
        }
        out.push(desc);
      } catch (_) { /* one odd element never stops the scan */ }
    }
    return out;
  }

  // --- profile values ------------------------------------------------------------

  const PROFILE_KEYS = [
    'firstName', 'lastName', 'preferredName', 'email', 'phone', 'phoneCountryCode',
    'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
    'linkedin', 'github', 'portfolio', 'website',
    'school', 'degree', 'major', 'gpa', 'gradMonth', 'gradYear',
    'currentCompany', 'currentTitle', 'yearsExperience',
    'workAuthorized', 'needsSponsorship', 'willingToRelocate', 'earliestStartDate', 'salaryExpectation',
    'howDidYouHear',
    'eeo.gender', 'eeo.race', 'eeo.hispanicLatino', 'eeo.veteran', 'eeo.disability'
  ];
  const DERIVED_KEYS = ['fullName', 'location', 'gradDate'];
  const YES_NO_KEYS = new Set(['workAuthorized', 'needsSponsorship', 'willingToRelocate']);

  function str(v) { return v == null ? '' : collapse(v); }

  function profileValue(profile, key) {
    const p = profile || {};
    switch (key) {
      case 'fullName': return collapse(str(p.firstName) + ' ' + str(p.lastName));
      case 'location': return [str(p.city), str(p.state) || str(p.country)].filter(Boolean).join(', ');
      case 'gradDate': return collapse(str(p.gradMonth) + ' ' + str(p.gradYear));
      default:
        if (String(key).startsWith('eeo.')) return str(p.eeo && p.eeo[String(key).slice(4)]);
        return Object.prototype.hasOwnProperty.call(p, key) ? str(p[key]) : '';
    }
  }

  const isEeoKey = k => String(k || '').startsWith('eeo.');

  // --- synonym dictionary --------------------------------------------------------

  const TEXTISH = ['text', 'email', 'tel', 'url', 'textarea', 'select', 'combobox'];
  const ANY = ['text', 'email', 'tel', 'url', 'textarea', 'select', 'combobox', 'radio', 'checkbox'];

  // Order matters: specific entries come before the general ones they
  // overlap with. `exact` hits score 0.9, `loose` 0.6. `maxWords` caps loose
  // matches so a long question that merely mentions "state" is left alone.
  const DICTIONARY = [
    { key: 'needsSponsorship', kinds: ANY,
      not: [/\bwithout\b.*\bsponsor/],
      exact: [/\b(require|need|requires|needs|requiring|needing)\b.*\bsponsor(ship|ed)?\b/, /\bsponsor(ship)?\b.*\b(require|need)/, /^(visa |immigration )?sponsorship( status)?$/],
      loose: [/\bsponsor(ship)?\b/, /\bh ?1 ?b\b/] },
    { key: 'workAuthorized', kinds: ANY,
      exact: [/\b(legally )?(authori[sz]ed|eligible|entitled|permitted|able)\b.*\bwork\b/, /\bwork authori[sz]ation\b/, /\bright to work\b/, /\bwork without\b.*\bsponsor/],
      loose: [/\bauthori[sz]ed\b/, /\bwork permit\b/, /\bwork eligibility\b/] },
    { key: 'willingToRelocate', kinds: ANY,
      not: [/\b(assistance|package|bonus|stipend|reimburse)/],
      exact: [/\breloca(te|tion|ting)\b/] },
    { key: 'eeo.hispanicLatino', kinds: ANY, exact: [/\bhispanic\b/, /\blatin[oax]\b/] },
    { key: 'eeo.race', kinds: ANY, exact: [/\brace\b/, /\bethnicity\b/, /\bethnic\b/, /\bracial\b/] },
    { key: 'eeo.gender', kinds: ANY, exact: [/\bgender\b/, /^sex$/] },
    { key: 'eeo.veteran', kinds: ANY, exact: [/\bveteran\b/, /\bmilitary (service|status)\b/] },
    { key: 'eeo.disability', kinds: ANY, exact: [/\bdisabilit(y|ies)\b/, /\bdisabled\b/] },
    { key: 'earliestStartDate', kinds: TEXTISH,
      exact: [/\b(earliest|desired|available|possible|preferred|expected|anticipated|potential)( start)? start date\b/, /^start date$/, /\bwhen (can|could|would|will) you (start|begin|join)\b/, /\bavailab(le|ility) to (start|begin)\b/, /^date available$/, /^availability( date)?$/],
      loose: [/\bstart date\b/, /\bstart(ing)? date\b/], maxWords: 8 },
    { key: 'salaryExpectation', kinds: TEXTISH,
      exact: [/\b(salary|compensation|pay|wage)\b.*\b(expectation|expected|requirement|desired|range|target)/, /\b(expected|desired|target)\b.*\b(salary|compensation|pay)\b/, /^(salary|compensation)$/],
      loose: [/\bsalary\b/, /\bcompensation\b/], maxWords: 10 },
    { key: 'howDidYouHear', kinds: TEXTISH.concat(['radio']),
      exact: [/\bhow did you (hear|find|learn|come across|discover)\b/, /\bwhere did you (hear|find|see|learn)\b/, /^(referral |application |lead |candidate |job )?source$/, /\bhear about (us|this)\b/],
      loose: [/\bsource\b/], maxWords: 4 },
    { key: 'yearsExperience', kinds: TEXTISH,
      exact: [/\byears? of (professional |relevant |work |industry |total )?experience\b/, /\bhow many years\b/, /^experience( years)?$/],
      loose: [/\bexperience\b.*\byears?\b/, /\byears\b.*\bexperience\b/], maxWords: 10 },
    { key: 'email', kinds: TEXTISH,
      exact: [/^((your|primary|personal|preferred|contact|confirm|confirm your|re enter|re enter your) )?e ?mail( address)?$/],
      loose: [/\be ?mail\b/], maxWords: 6 },
    { key: 'phoneCountryCode', kinds: TEXTISH,
      exact: [/\b(phone |dialing |calling )?country code\b/, /\bcountry (phone|dialing|calling) code\b/, /^phone (country|prefix)$/],
      loose: [/\bdial(ing)? code\b/] },
    { key: 'phone', kinds: TEXTISH,
      not: [/\b(type|device|extension|ext|country|code)\b/],
      exact: [/^((your|primary|mobile|cell|home|contact|preferred) )?(phone|telephone|mobile|cell|cellphone)( phone)?( number| no)?$/],
      loose: [/\b(phone|mobile|cell|telephone)\b/], maxWords: 6 },
    { key: 'preferredName', kinds: TEXTISH,
      exact: [/\bpreferred (first |given )?name\b/, /\bnick ?name\b/, /\bwhat (should|do you want|would you like) (we|us) to call you\b/, /\bname you (go|prefer) by\b/],
      loose: [/\bpreferred\b.*\bname\b/] },
    { key: 'firstName', kinds: TEXTISH,
      not: [/\b(middle|last|family|company|school|employer)\b/],
      exact: [/^((legal|your|candidate|applicant) )?first( legal)? name( legal)?$/, /^(legal )?given names?$/, /^first$/, /^f ?name$/, /^forename$/],
      loose: [/\bfirst name\b/, /\bgiven name\b/], maxWords: 6 },
    { key: 'lastName', kinds: TEXTISH,
      not: [/\b(first|middle|company|school|employer)\b/],
      exact: [/^((legal|your|candidate|applicant) )?(last|family|sur)( legal)? ?name( legal)?$/, /^last$/, /^l ?name$/],
      loose: [/\b(last|family) name\b/, /\bsurname\b/], maxWords: 6 },
    { key: 'fullName', kinds: TEXTISH,
      not: [/\b(company|school|employer|university|reference|referrer|recruiter|manager|emergency)\b/],
      exact: [/^((your|candidate|applicant|full|legal) )*name$/, /^name (first last|in full)$/],
      loose: [/\bfull name\b/, /\blegal name\b/], maxWords: 6 },
    { key: 'linkedin', kinds: TEXTISH, exact: [/\blinked ?in\b/] },
    { key: 'github', kinds: TEXTISH, exact: [/\bgit ?hub\b/] },
    { key: 'portfolio', kinds: TEXTISH, exact: [/\bportfolio\b/] },
    { key: 'website', kinds: TEXTISH,
      not: [/\b(company|employer|twitter|facebook|instagram|tiktok)\b/],
      exact: [/^((personal|your|other|own) )?(web ?site|homepage|home page|blog|personal site)( url| link| address)?$/, /\bpersonal (web ?site|site|url|page|homepage)\b/],
      loose: [/\bweb ?site\b/, /\burl\b/, /\blinks?\b/], maxWords: 5 },
    { key: 'addressLine2', kinds: TEXTISH,
      exact: [/\baddress (line )?2\b/, /^(apt|apartment|suite|unit)\b/, /\bstreet address 2\b/] },
    { key: 'location', kinds: TEXTISH,
      exact: [/^((current|your|home) )?location$/, /^(current )?city (and|or)? ?state( country)?$/, /^where are you (currently )?(located|based)$/, /^(current )?city state$/],
      loose: [/\blocation\b/], maxWords: 3 },
    { key: 'addressLine1', kinds: TEXTISH,
      not: [/\b(e ?mail|web|url|ip|line 2|2)\b/],
      exact: [/^((street|home|mailing|current|residential|postal|permanent) )?address( line)?( 1)?$/, /^street( address)?( 1)?$/, /\baddress line 1\b/],
      loose: [/\baddress\b/], maxWords: 5 },
    { key: 'city', kinds: TEXTISH,
      exact: [/^((current|home) )?(city|town)( of residence)?$/],
      loose: [/\bcity\b/], maxWords: 5 },
    { key: 'state', kinds: TEXTISH,
      not: [/\bunited states\b/, /\bstatement\b/],
      exact: [/^((current|home) )?(state|province|region|state province|state or province|state region|state province region)( of residence)?$/],
      loose: [/\bstate\b/, /\bprovince\b/], maxWords: 4 },
    { key: 'postalCode', kinds: TEXTISH,
      exact: [/^(zip|zip code|zipcode|postal code|postcode|post code|zip postal code|postal zip code|zip postal)$/],
      loose: [/\bzip\b/, /\bpostal\b/, /\bpost ?code\b/] },
    { key: 'country', kinds: TEXTISH,
      not: [/\b(code|citizenship|citizen|passport)\b/],
      exact: [/^((current|home|your) )?country( region| territory| of residence)?$/],
      loose: [/\bcountry\b/], maxWords: 5 },
    { key: 'gpa', kinds: TEXTISH, exact: [/\bgpa\b/, /\bgrade point average\b/, /\bcumulative grade\b/] },
    { key: 'gradMonth', kinds: TEXTISH, exact: [/\bgraduation month\b/, /\bmonth of graduation\b/, /\bgrad month\b/] },
    { key: 'gradYear', kinds: TEXTISH, exact: [/\b(graduation|grad) year\b/, /\byear of graduation\b/, /\bclass of\b/, /\byear graduated\b/] },
    { key: 'gradDate', kinds: TEXTISH,
      exact: [/\b(expected |anticipated )?graduation( date)?\b/, /\bgrad(uation)? date\b/, /\bdate of graduation\b/],
      loose: [/\bgraduat/] },
    { key: 'degree', kinds: TEXTISH.concat(['radio']),
      not: [/\b(major|field|discipline)\b/],
      exact: [/^((highest|most recent|current) )?(degree|degree type|degree level|level of education|education level|highest level of education)( obtained| earned| pursuing)?$/],
      loose: [/\bdegree\b/], maxWords: 6 },
    { key: 'major', kinds: TEXTISH,
      exact: [/^(major|majors|field of study|area of study|discipline|concentration|course of study|program of study|major field of study|area of concentration)$/, /\bfield of study\b/],
      loose: [/\bmajor\b/, /\bdiscipline\b/], maxWords: 6 },
    { key: 'school', kinds: TEXTISH,
      not: [/\bhigh school\b/],
      exact: [/^((current|most recent|your) )?(school|university|college|institution|educational institution|school university|university college)( name| attended)?$/,
        /\b(school|university|college)\b.*\battend(ing|ed)?\b/],
      loose: [/\b(school|university|college|institution)\b/], maxWords: 6 },
    { key: 'currentCompany', kinds: TEXTISH,
      exact: [/^((current|most recent|present|latest) )?(company|employer|organization|organisation|org)( name)?$/],
      loose: [/\b(current|present|most recent|latest) (company|employer|organization)\b/], maxWords: 6 },
    { key: 'currentTitle', kinds: TEXTISH,
      exact: [/^((current|most recent|present|latest) )?(job )?(title|position|role)$/],
      loose: [/\b(current|present|most recent|latest) (job )?(title|position|role)\b/], maxWords: 6 },
    { key: 'resume', kinds: ['file'],
      not: [/\bcover\b/, /\btranscript\b/],
      exact: [/\bresume\b/, /\bcv\b/, /\bcurriculum vitae\b/] }
  ];

  const AUTOCOMPLETE = {
    'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', nickname: 'preferredName',
    email: 'email', tel: 'phone', 'tel-national': 'phone', 'tel-country-code': 'phoneCountryCode',
    'street-address': 'addressLine1', 'address-line1': 'addressLine1', 'address-line2': 'addressLine2',
    'address-level2': 'city', 'address-level1': 'state', 'postal-code': 'postalCode',
    country: 'country', 'country-name': 'country',
    organization: 'currentCompany', 'organization-title': 'currentTitle', url: 'website'
  };

  function wordCount(s) { return s ? s.split(' ').length : 0; }

  function entryHits(entry, text, mode) {
    if (!text) return false;
    if (entry.not && entry.not.some(r => r.test(text))) return false;
    if (mode === 'exact') return !!(entry.exact && entry.exact.some(r => r.test(text)));
    if (!entry.loose) return false;
    if (entry.maxWords && wordCount(text) > entry.maxWords) return false;
    return entry.loose.some(r => r.test(text));
  }

  function identSignals(desc) {
    const out = [];
    const add = s => { const k = dictKey(s); if (k && !out.includes(k)) out.push(k); };
    add(normalizeLabel(desc.placeholder));
    [desc.name, desc.id].forEach(raw => {
      if (!raw) return;
      add(splitIdent(raw));
      const segs = String(raw).match(/\[([^\]]+)\]/g);
      if (segs && segs.length) add(splitIdent(segs[segs.length - 1].slice(1, -1)));
    });
    return out;
  }

  // Dictionary lookup alone: { key, confidence } or null. Exact label first,
  // then exact placeholder / name / id, then the loose versions of both.
  function dictionaryLookup(desc) {
    const label = dictKey(desc.labelKey);
    const idents = identSignals(desc).filter(s => s !== label);
    const kindOk = e => (e.kinds || TEXTISH).includes(desc.kind);
    const passes = [
      { texts: [label], mode: 'exact', confidence: 0.9 },
      { texts: idents, mode: 'exact', confidence: 0.9 },
      { texts: [label], mode: 'loose', confidence: 0.6 },
      { texts: idents, mode: 'loose', confidence: 0.6 }
    ];
    for (const pass of passes) {
      for (const text of pass.texts) {
        for (const entry of DICTIONARY) {
          if (kindOk(entry) && entryHits(entry, text, pass.mode)) return { key: entry.key, confidence: pass.confidence };
        }
      }
    }
    return null;
  }

  function looksEeo(desc) {
    const hit = dictionaryLookup(Object.assign({}, desc, { kind: 'select' }));
    return !!(hit && isEeoKey(hit.key));
  }

  // --- answers -----------------------------------------------------------------

  function findAnswer(answers, questionText) {
    const list = Array.isArray(answers) ? answers : [];
    const key = normalizeLabel(questionText);
    if (!key) return null;
    const qTokens = tokens(key);
    let best = null;
    for (const a of list) {
      if (!a || !a.answer) continue;
      const aKey = a.labelKey || normalizeLabel(a.question);
      if (!aKey) continue;
      const score = aKey === key ? 1 : jaccard(qTokens, tokens(aKey));
      if (!best || score > best.score) best = { answer: a.answer, score, id: a.id };
    }
    return best && best.score >= 0.5 ? best : null;
  }

  // --- site adapters ----------------------------------------------------------------

  let adapters = [];

  function registerSiteAdapter(adapter) {
    if (!adapter || typeof adapter !== 'object' || !adapter.id || typeof adapter.matches !== 'function') return false;
    adapters = adapters.filter(a => a.id !== adapter.id);
    adapters.push(adapter);
    return true;
  }

  function toUrl(u) {
    if (!u) return null;
    if (typeof u === 'object' && u.hostname !== undefined) return u;
    try { return new URL(String(u)); } catch (_) { return null; }
  }

  function getSiteAdapter(url) {
    const u = toUrl(url);
    if (!u) return null;
    for (const a of adapters) {
      try { if (a.matches(u)) return a; } catch (_) { /* a broken adapter is skipped */ }
    }
    return null;
  }

  function normHost(h) {
    return String(h || '').toLowerCase().replace(/^www\./, '');
  }

  // --- matching ---------------------------------------------------------------------

  function presentValue(key, value, kind) {
    if (YES_NO_KEYS.has(key) && TEXT_KINDS.has(kind)) {
      if (/^yes$/i.test(value)) return 'Yes';
      if (/^no$/i.test(value)) return 'No';
    }
    return value;
  }

  function descElements(desc) {
    return desc.inputs && desc.inputs.length ? desc.inputs : [desc.el];
  }

  function safeMatches(el, selector) {
    try { return !!(el && el.matches && el.matches(selector)); } catch (_) { return false; }
  }

  // The match for one profile key, or why there is none: EEO keys only with
  // the setting on, the resume only into file inputs (and nothing else into
  // them), never an empty profile value.
  function keyMatch(env, key, confidence, source) {
    const { desc, profile, settings, resume } = env;
    if (isEeoKey(key) && !settings.fillEeo) return { reason: 'eeo-disabled' };
    if (key === 'resume') {
      if (desc.kind !== 'file') return { reason: 'no-match' };
      return resume && resume.dataUrl
        ? { match: { profileKey: 'resume', value: resume, confidence, source } }
        : { reason: 'no-value' };
    }
    if (desc.kind === 'file') return { reason: 'no-match' };
    // A city dropdown searches places, and a bare city name matches every
    // same-named town ("Plainview" is in NY and TX): give it the state too.
    const value = (key === 'city' && desc.kind === 'combobox' && profileValue(profile, 'location')) ||
      profileValue(profile, key);
    if (!value) return { reason: 'no-value' };
    return { match: { profileKey: key, value: presentValue(key, value, desc.kind), confidence, source } };
  }

  // The profile key a site adapter's fixed field selector gives this field.
  function adapterKey(adapter, desc) {
    const fields = adapter ? adapter.fields : null;
    if (!Array.isArray(fields)) return null;
    for (const f of fields) {
      if (!f || !f.selector || !f.profileKey) continue;
      if (descElements(desc).some(e => safeMatches(e, f.selector))) return f.profileKey;
    }
    return null;
  }

  // The learned rule for a label: this host's first, else the global one.
  function learnedRule(rules, labelKey, host) {
    if (!labelKey || !Array.isArray(rules) || !rules.length) return null;
    const h = normHost(host);
    const hostRule = h ? rules.find(r => r && r.labelKey === labelKey && r.host !== '*' && normHost(r.host) === h) : null;
    return hostRule || rules.find(r => r && r.labelKey === labelKey && (r.host === '*' || !r.host)) || null;
  }

  // The profile key of the last autocomplete token LIT knows, or null.
  function autocompleteKey(autocomplete) {
    if (!autocomplete) return null;
    const toks = autocomplete.split(/\s+/).filter(Boolean);
    for (let i = toks.length - 1; i >= 0; i--) {
      const key = AUTOCOMPLETE[toks[i]];
      if (key) return key;
    }
    return null;
  }

  // Returns { match } or { reason }. Reasons: 'eeo-disabled', 'no-value',
  // 'no-match'.
  function matchInternal(desc, profile, rules, host, opts) {
    const o = opts || {};
    const env = { desc, profile, settings: Object.assign({ fillEeo: false }, o.settings || {}), resume: o.resume || null };
    const make = (key, confidence, source) => keyMatch(env, key, confidence, source);

    // 1. Site adapter fixed fields.
    const adapter = o.adapter !== undefined ? o.adapter : getSiteAdapter(o.url || (host ? 'https://' + host + '/' : null));
    const fixed = adapterKey(adapter, desc);
    if (fixed) return make(fixed, 1, 'adapter');

    // 2. Learned rules, this host before global. A rule that names neither a
    // profile key nor a value falls through to the steps below.
    const rule = learnedRule(rules, desc.labelKey, host);
    if (rule) {
      if (rule.profileKey) return make(rule.profileKey, 1, 'rule');
      if (rule.value != null && String(rule.value) !== '') {
        if (!env.settings.fillEeo && looksEeo(desc)) return { reason: 'eeo-disabled' };
        return { match: { value: String(rule.value), confidence: 1, source: 'rule' } };
      }
    }

    // 3. autocomplete attribute.
    const auto = autocompleteKey(desc.autocomplete);
    if (auto) return make(auto, 0.95, 'autocomplete');

    // 4. Synonym dictionary, then the input type as a last structural hint.
    const hit = dictionaryLookup(desc);
    if (hit) return make(hit.key, hit.confidence, 'dictionary');
    if (desc.kind === 'email') return make('email', 0.9, 'dictionary');
    if (desc.kind === 'tel') return make('phone', 0.9, 'dictionary');

    // 5. Answer bank, long answers only.
    if (desc.kind === 'textarea' && o.answers) {
      const a = findAnswer(o.answers, desc.label || desc.labelKey);
      if (a) return { match: { value: a.answer, confidence: a.score, source: 'answer' } };
    }
    return { reason: 'no-match' };
  }

  function matchField(desc, profile, rules, host, opts) {
    if (!desc) return null;
    try {
      const r = matchInternal(desc, profile, rules, host, opts);
      return r.match || null;
    } catch (_) {
      return null;
    }
  }

  // --- filling ------------------------------------------------------------------------

  function ctorFor(el) {
    const tag = tagOf(el);
    if (tag === 'INPUT' && typeof HTMLInputElement === 'function') return HTMLInputElement;
    if (tag === 'TEXTAREA' && typeof HTMLTextAreaElement === 'function') return HTMLTextAreaElement;
    if (tag === 'SELECT' && typeof HTMLSelectElement === 'function') return HTMLSelectElement;
    return null;
  }

  // Sets a property through the prototype setter, bypassing any instance-level
  // override (React's value tracker), so the framework sees the change.
  function nativeSet(el, prop, value) {
    const C = ctorFor(el);
    if (C && el instanceof C) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, prop);
      if (d && d.set) { d.set.call(el, value); return; }
    }
    let proto = Object.getPrototypeOf(el);
    while (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (d && d.set) { d.set.call(el, value); return; }
      proto = Object.getPrototypeOf(proto);
    }
    el[prop] = value;
  }

  function fire(el, type) {
    let ev;
    try {
      ev = typeof Event === 'function' ? new Event(type, { bubbles: true, cancelable: false }) : null;
    } catch (_) { ev = null; }
    if (!ev) ev = { type, bubbles: true, cancelable: false };
    try { el.dispatchEvent(ev); } catch (_) { /* a page handler threw; the value is already set */ }
  }

  // What a person's edit fires, in order: frameworks commit on input or
  // change, some validators only on blur.
  const COMMIT_EVENTS = ['input', 'change', 'blur', 'focusout'];
  const CHANGE_EVENTS = ['input', 'change'];

  function fireEach(el, types) {
    types.forEach(t => fire(el, t));
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // type=date / month inputs only accept ISO forms. An ISO date or month is
  // converted by hand: Date reads "2027-06-01" as UTC midnight, so the local
  // getters below would land on May 31 anywhere west of UTC.
  function formatForInput(el, value) {
    const type = typeAttr(el);
    if (type !== 'date' && type !== 'month') return value;
    if (type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    if (type === 'month' && /^\d{4}-\d{2}$/.test(value)) return value;
    const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
    if (iso) return type === 'date' ? iso[1] + '-' + iso[2] + '-' + (iso[3] || '01') : iso[1] + '-' + iso[2];
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return type === 'date'
      ? d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
      : d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function fillText(el, value) {
    const v = formatForInput(el, String(value));
    nativeSet(el, 'value', v);
    fireEach(el, COMMIT_EVENTS);
    return v === '' ? String(el.value || '') === '' : String(el.value || '') !== '';
  }

  function fillSelect(el, value) {
    const opts = selectOptions(el);
    const candidates = opts.map(o => (isPlaceholderOption(o) ? [] : [optionText(o), String(o.value == null ? '' : o.value)]));
    const best = bestOption(value, candidates);
    if (!best) return false;
    const opt = opts[best.index];
    nativeSet(el, 'selectedIndex', best.index);
    try { opt.selected = true; } catch (_) { /* ignore */ }
    fireEach(el, COMMIT_EVENTS);
    return el.selectedIndex === best.index || opt.selected === true;
  }

  // Whether a radio, checkbox, or choice button is picked. Custom widgets:
  // ARIA state first, then the data attributes Radix / Headless UI / Chakra
  // set, then class names, but only when no ARIA state says otherwise.
  function isOn(input) {
    if (tagOf(input) === 'INPUT') return input.checked === true;
    if (STATE_ATTRS.some(a => attr(input, a) === 'true')) return true;
    const state = String(attr(input, 'data-state') || attr(input, 'data-headlessui-state') || '').toLowerCase();
    if (/\b(on|checked|selected|active)\b/.test(state)) return true;
    if (['data-selected', 'data-checked'].some(a => input.hasAttribute && input.hasAttribute(a) && attr(input, a) !== 'false')) return true;
    if (STATE_ATTRS.some(a => attr(input, a) === 'false')) return false;
    return STATE_CLASS_RE.test(String(attr(input, 'class') || ''));
  }

  // Click first: React and most frameworks hang radio / checkbox onChange off
  // the click event. If a handler cancels it, set `checked` directly.
  function setChecked(input, want) {
    if (tagOf(input) !== 'INPUT') {
      if (isOn(input) === want) return true;
      const before = stateSignature(input);
      press(input);
      if (isOn(input) === want) return true;
      // A button that marks the pick only with generated class names, or
      // that the page re-rendered away: the click is taken as landing.
      return want && (input.isConnected === false || stateSignature(input) !== before);
    }
    if (!!input.checked === want) return true;
    try { if (typeof input.click === 'function') input.click(); } catch (_) { /* ignore */ }
    if (!!input.checked !== want) {
      nativeSet(input, 'checked', want);
      fireEach(input, CHANGE_EVENTS);
    }
    return !!input.checked === want;
  }

  // [label, value] per radio / checkbox / choice button, as bestOption takes.
  function optionCandidates(inputs) {
    const ctx = makeCtx();
    return inputs.map(i => [optionLabel(i, ctx), String(attr(i, 'value') || '')]);
  }

  function fillRadio(desc, value) {
    const inputs = descElements(desc);
    const best = bestOption(value, optionCandidates(inputs));
    if (!best) return false;
    return setChecked(inputs[best.index], true);
  }

  function fillCheckbox(desc, value) {
    const inputs = descElements(desc);
    const v = norm(Array.isArray(value) ? value.join(' ') : value);
    if (inputs.length === 1) {
      const input = inputs[0];
      if (value === true || YES_RE.test(v)) return setChecked(input, true);
      if (value === false || NO_RE.test(v)) return setChecked(input, false);
      const own = optionLabel(input, makeCtx());
      if (scoreOption(value, own) >= 0.65) return setChecked(input, true);
      return false;
    }
    const candidates = optionCandidates(inputs);
    // A learned answer arrives as "Python, Rust" (currentValue's form): each
    // part is its own pick unless the whole string names one option exactly.
    const whole = Array.isArray(value) ? null : bestOption(value, candidates);
    const parts = Array.isArray(value) ? value : String(value).split(/\s*[,;|]\s*/).filter(Boolean);
    let picks = [];
    if (whole && (whole.score >= 0.95 || parts.length < 2)) picks.push(whole.index);
    else parts.forEach(w => { const b = bestOption(w, candidates); if (b) picks.push(b.index); });
    if (!picks.length && whole) picks.push(whole.index);
    picks = Array.from(new Set(picks));
    if (!picks.length) return false;
    return picks.map(i => setChecked(inputs[i], true)).every(Boolean);
  }

  function decodeDataUrl(dataUrl) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,([\s\S]*)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    let bytes;
    if (m[3]) {
      const bin = atob(m[4].replace(/\s+/g, ''));
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[4]));
    }
    return { mime, bytes };
  }

  function fillFile(el, value) {
    const res = value && typeof value === 'object' ? value : { dataUrl: String(value || ''), name: '', type: '' };
    if (!res.dataUrl || typeof File !== 'function' || typeof DataTransfer !== 'function') return false;
    const decoded = decodeDataUrl(res.dataUrl);
    if (!decoded) return false;
    const file = new File([decoded.bytes], res.name || 'resume', { type: res.type || decoded.mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    try { el.files = dt.files; } catch (_) { return false; }
    fireEach(el, CHANGE_EVENTS);
    return !!(el.files && el.files.length);
  }

  // --- custom widgets ------------------------------------------------------------

  const timing = { comboWait: 1500, comboConfirm: 800, poll: 50 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // check() every timing.poll ms until it returns something truthy or `ms`
  // pass; it always runs at least once. Resolves that value, or null.
  async function pollUntil(check, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const v = check();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(timing.poll);
    }
  }

  function mouse(el, type) {
    let ev = null;
    try {
      const Ctor = type.startsWith('pointer')
        ? (typeof PointerEvent === 'function' ? PointerEvent : (typeof MouseEvent === 'function' ? MouseEvent : null))
        : (typeof MouseEvent === 'function' ? MouseEvent : null);
      if (Ctor) ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, button: 0 });
    } catch (_) { ev = null; }
    if (!ev) { fire(el, type); return; }
    try { el.dispatchEvent(ev); } catch (_) { /* a page handler threw */ }
  }

  // The full pointer sequence: react-select opens on mousedown, Workday and
  // most listboxes commit on click.
  function press(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup'].forEach(t => mouse(el, t));
    try {
      if (typeof el.click === 'function') el.click();
      else mouse(el, 'click');
    } catch (_) { /* a page handler threw */ }
  }

  function keyDown(el, key) {
    let ev = null;
    try {
      if (typeof KeyboardEvent === 'function') ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true });
    } catch (_) { ev = null; }
    if (!ev) ev = { type: 'keydown', key, bubbles: true, cancelable: true };
    try { el.dispatchEvent(ev); } catch (_) { /* a page handler threw */ }
  }

  // Chosen values a dropdown renders next to its input: react-select's single
  // and multi values, Workday's selected-item list. Stops at the first
  // ancestor holding another control so a neighbour's value is never read.
  const CHOSEN_SELECTOR = '[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value__label"], ' +
    '[data-automation-id="selectedItemList"] li, [data-automation-id="selectedItem"]';
  function controlCount(node) {
    return Array.from(node.querySelectorAll('input, select, textarea, button')).filter(c => {
      const tag = tagOf(c);
      if (tag === 'INPUT') return typeAttr(c) !== 'hidden';
      if (tag === 'BUTTON') return opensListbox(c);
      return true;
    }).length;
  }

  function chosenNear(el) {
    let n = el.parentElement;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      try {
        if (controlCount(n) > 1) break;
        const texts = Array.from(n.querySelectorAll(CHOSEN_SELECTOR)).map(nodeText).filter(Boolean);
        if (texts.length) return Array.from(new Set(texts)).join(', ');
      } catch (_) { break; }
    }
    return '';
  }

  function comboboxValue(el) {
    if (tagOf(el) === 'INPUT') return chosenNear(el) || collapse(el.value);
    const t = nodeText(el);
    return PLACEHOLDER_RE.test(norm(t)) ? '' : t;
  }

  // Ashby-style yes/no: a hidden checkbox beside a pair of toggle buttons.
  // null when the checkbox has no such buttons.
  function pressedButtonText(input) {
    const box = input && input.parentElement;
    if (!box || tagOf(input) !== 'INPUT') return null;
    const buttons = Array.from(box.children || []).filter(c => tagOf(c) === 'BUTTON' && c.hasAttribute && c.hasAttribute('aria-pressed'));
    if (buttons.length < 2) return null;
    const on = buttons.find(b => attr(b, 'aria-pressed') === 'true');
    return on ? cleanText(textOf(on)) : '';
  }

  // What a field shows right now, as text, "" when empty: the chosen option
  // for selects, radios, and dropdowns, the checked labels of a checkbox
  // group, "Yes" for a lone checked box. Learning reads fields through this,
  // so custom widgets that never fire `change` read the same as native ones.
  function currentValue(desc) {
    const d = desc && desc.el ? desc : null;
    if (!d) return '';
    const el = d.el;
    try {
      switch (d.kind) {
        case 'select':
          return chosenOptions(el).filter(o => !isPlaceholderOption(o)).map(optionText).filter(Boolean).join(', ');
        case 'radio': {
          const on = descElements(d).find(isOn);
          return on ? (optionLabel(on, makeCtx()) || 'Yes') : '';
        }
        case 'checkbox': {
          const inputs = descElements(d);
          if (inputs.length === 1) {
            const pressed = pressedButtonText(inputs[0]);
            if (pressed !== null) return pressed;
            return isOn(inputs[0]) ? 'Yes' : '';
          }
          const ctx = makeCtx();
          return inputs.filter(isOn).map(i => optionLabel(i, ctx)).filter(Boolean).join(', ');
        }
        case 'file':
          return el.files && el.files.length ? String(el.files[0].name || '') : '';
        case 'combobox':
          return comboboxValue(el);
        default:
          return collapse(el.value) || chosenNear(el);
      }
    } catch (_) {
      return '';
    }
  }

  // Open options of a dropdown: its aria-controls / aria-owns list, or any
  // rendered listbox (portaled menus rarely link back to their input).
  function listOptions(el) {
    const doc = el.ownerDocument || defaultDocument();
    if (!doc) return [];
    const ids = String(attr(el, 'aria-controls') || attr(el, 'aria-owns') || '').split(/\s+/).filter(Boolean);
    let lists = ids.map(id => byId(rootNodeOf(el), id) || byId(doc, id)).filter(Boolean);
    if (!lists.length) {
      try { lists = Array.from(doc.querySelectorAll('[role="listbox"]')).filter(isRendered); } catch (_) { lists = []; }
    }
    const seen = new Set();
    const out = [];
    lists.forEach(list => {
      let opts = [];
      try { opts = Array.from(list.querySelectorAll('[role="option"]')); } catch (_) { opts = []; }
      opts.forEach(o => {
        if (seen.has(o) || attr(o, 'aria-disabled') === 'true' || !isRendered(o)) return;
        seen.add(o);
        out.push(o);
      });
    });
    return out;
  }

  async function waitForOptions(el, ms) {
    return (await pollUntil(() => {
      const opts = listOptions(el);
      return opts.length ? opts : null;
    }, ms)) || [];
  }

  // Types into a searchable dropdown's input the way a person would.
  function setQuery(el, text) {
    nativeSet(el, 'value', text);
    fire(el, 'input');
  }

  // Any ARIA dropdown without a site adapter: open it (typing the value into
  // a searchable one), pick the best option, and confirm it took.
  async function fillCombobox(desc, value) {
    const el = desc.el;
    const want = collapse(Array.isArray(value) ? value[0] : value);
    if (!el || !want) return false;
    if (scoreOption(comboboxValue(el), want) >= 0.9) return true;
    const isInput = tagOf(el) === 'INPUT';
    try { if (typeof el.focus === 'function') el.focus(); } catch (_) { /* ignore */ }
    press(el);
    if (isInput) setQuery(el, want);
    let opts = await waitForOptions(el, timing.comboWait);
    if (!opts.length && isInput) {
      // Some menus only open on an empty query or ArrowDown.
      setQuery(el, '');
      keyDown(el, 'ArrowDown');
      opts = await waitForOptions(el, timing.comboWait);
    }
    const best = bestOption(want, opts.map(nodeText));
    if (!best) {
      if (isInput) setQuery(el, '');
      keyDown(el, 'Escape');
      return false;
    }
    const opt = opts[best.index];
    const text = nodeText(opt);
    press(opt);
    const took = await pollUntil(() => {
      const now = comboboxValue(el);
      return scoreOption(now, text) >= 0.65 || scoreOption(now, want) >= 0.65 || attr(opt, 'aria-selected') === 'true';
    }, timing.comboConfirm);
    // Clicked, and the menu closed, but the widget shows the value somewhere
    // unreadable: trust the click.
    return took || opt.isConnected === false;
  }

  async function setValue(desc, value) {
    try {
      const d = desc && desc.el ? desc : describeField(desc);
      if (!d || !d.el) return false;
      if (value == null) return false;
      switch (d.kind) {
        case 'text': case 'email': case 'tel': case 'url': case 'textarea':
          return fillText(d.el, value);
        case 'select': return fillSelect(d.el, value);
        case 'radio': return fillRadio(d, value);
        case 'checkbox': return fillCheckbox(d, value);
        case 'file': return fillFile(d.el, value);
        case 'combobox': return fillCombobox(d, value);
        default: return false;
      }
    } catch (_) {
      return false;
    }
  }

  // --- run ----------------------------------------------------------------------------

  function isDocument(n) { return !!(n && n.documentElement); }

  function isConnected(el) {
    return !el || el.isConnected === undefined ? true : el.isConnected;
  }

  function refind(desc, root) {
    const fresh = scanFields(root, { includeFilled: true });
    return fresh.find(f => f.kind === desc.kind && (
      (desc.id && f.id === desc.id) ||
      (!desc.id && desc.name && f.name === desc.name) ||
      (!desc.id && !desc.name && desc.labelKey && f.labelKey === desc.labelKey))) || null;
  }

  // Adapter fixed fields the scan missed (hidden behind custom widgets, or
  // outside the narrowed root), described as they are.
  function adapterExtras(adapter, base, descs) {
    const fields = adapter ? adapter.fields : null;
    if (!Array.isArray(fields)) return [];
    const have = new Set();
    descs.forEach(d => descElements(d).forEach(e => have.add(e)));
    const ctx = makeCtx();
    const extras = [];
    fields.forEach(f => {
      if (!f || !f.selector) return;
      let els = [];
      try { els = Array.from(base.querySelectorAll(f.selector)); } catch (_) { els = []; }
      els.forEach(el => {
        if (have.has(el) || isDisabled(el)) return;
        const desc = describeField(el, ctx);
        if (!desc) return;
        if (isFilled(desc)) desc.filled = true;
        descElements(desc).forEach(e => have.add(e));
        extras.push(desc);
      });
    });
    return extras;
  }

  // The adapter's narrower form root inside `base`, else `base` itself.
  function adapterRoot(adapter, base) {
    if (!adapter || typeof adapter.scanRoot !== 'function') return base;
    try {
      const doc = isDocument(base) ? base : (base.ownerDocument || base);
      const narrowed = adapter.scanRoot(doc);
      if (narrowed && (isDocument(base) || (base.contains && base.contains(narrowed)))) return narrowed;
    } catch (_) { /* a broken scanRoot means the whole base */ }
    return base;
  }

  // One field of a run: found again if the page replaced it, matched, then
  // filled through the adapter's fill or setValue. The outcome goes into
  // `report` (filled, skipped with a reason, or unmatched).
  async function runField(desc, scope, report) {
    let d = desc;
    try {
      if (d.filled) { report.skipped.push({ desc: d, reason: 'already-filled' }); return; }
      if (!isConnected(d.el)) {
        const fresh = refind(d, scope.root);
        if (!fresh) { report.skipped.push({ desc: d, reason: 'detached' }); return; }
        if (fresh.filled) { report.skipped.push({ desc: fresh, reason: 'already-filled' }); return; }
        d = fresh;
      }
      const res = matchInternal(d, scope.profile, scope.rules, scope.host, scope.matchOpts);
      if (!res.match) {
        if (res.reason === 'eeo-disabled') report.skipped.push({ desc: d, reason: 'eeo-disabled' });
        else report.unmatched.push(d);
        return;
      }
      const m = res.match;
      const min = m.source === 'answer' ? 0.5 : 0.6;
      if (m.confidence < min) { report.unmatched.push(d); return; }
      const adapter = scope.matchOpts.adapter;
      let ok;
      if (adapter && typeof adapter.fill === 'function') ok = await adapter.fill(d, m.value);
      if (ok === undefined) ok = await setValue(d, m.value);
      if (ok) report.filled.push({ desc: d, match: m });
      else report.skipped.push({ desc: d, reason: d.kind === 'combobox' ? 'unsupported-widget' : 'fill-failed' });
    } catch (e) {
      report.skipped.push({ desc: d, reason: 'error', error: String((e && e.message) || e) });
    }
  }

  async function run(options) {
    const o = options || {};
    const report = { filled: [], skipped: [], unmatched: [] };
    const settings = Object.assign({ fillEeo: false }, o.settings || {});
    const url = toUrl(o.url) || (typeof location !== 'undefined' ? toUrl(location.href) : null)
      || (o.host ? toUrl('https://' + o.host + '/') : null);
    const host = o.host || (url ? url.hostname : '');
    const adapter = o.adapter !== undefined ? o.adapter : getSiteAdapter(url);

    const base = o.root || defaultDocument();
    if (!base) return report;
    const root = adapterRoot(adapter, base);

    let descs = [];
    try { descs = scanFields(root, { includeFilled: true }); } catch (_) { descs = []; }
    try { descs = descs.concat(adapterExtras(adapter, base, descs)); } catch (_) { /* fixed fields are optional */ }

    // One field at a time, in page order.
    const scope = {
      root,
      host,
      profile: o.profile || {},
      rules: o.rules || [],
      matchOpts: { settings, answers: o.answers || [], resume: o.resume || null, adapter, url }
    };
    for (const desc of descs) await runField(desc, scope, report);
    return report;
  }

  // --- site adapter kit ------------------------------------------------------------
  // The widget helpers the Greenhouse, Ashby and Workday adapters drive their
  // custom dropdowns and buttons with (content/autofill/sites/). They are not
  // the engine's helpers above and behave differently: option text compares
  // in a plain ASCII form, events are built from the page's own window event
  // classes with the given init (key codes, buttons), and waits watch the DOM
  // with a MutationObserver plus a slow poll. Each adapter passes its own
  // timeouts, so its `timing` object stays the knob tests and callers turn.
  const siteKit = (() => {
    const win = () => (typeof window !== 'undefined' ? window : null);

    const norm = s => String(s == null ? '' : s).toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9+]+/g, ' ').trim();

    const ALIASES = [
      ['united states', 'united states of america', 'us', 'usa', 'u s', 'u s a'],
      ['united kingdom', 'uk', 'u k', 'great britain']
    ];
    const canon = s => { for (const g of ALIASES) if (g.includes(s)) return g[0]; return s; };

    // How well option text `label` fits `value` (note the order: the label
    // comes first, unlike AutofillCore.scoreOption). 1 exact, the place score
    // for "City, ST" values, 0.95 alias, 0.9 yes/no prefix ("Yes, I am..."),
    // 0.7-0.8 whole-word containment (shorter options win), then token
    // Jaccard scaled to 0.6.
    function scoreText(label, value) {
      const o = norm(label);
      const v = norm(value);
      if (!o || !v) return 0;
      if (o === v) return 1;
      const loc = scoreLocation(value, label);
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

    // The option node whose text fits `value` best, or null below 0.5.
    function bestNode(nodes, value) {
      let best = null;
      let bestScore = 0;
      for (const n of nodes) {
        const s = scoreText(n.textContent, value);
        if (s > bestScore) { best = n; bestScore = s; }
      }
      return bestScore >= 0.5 ? best : null;
    }

    function fire(el, type, init) {
      const W = win();
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

    // Sets a search box's text through the native setter (so React sees it)
    // and fires input.
    function typeInto(input, text) {
      const W = win();
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

    // Resolves with the first truthy result of `find` (a function, or a
    // selector looked up under `root`; an empty array does not count),
    // re-checked on every DOM mutation under `root` and on a slow poll as a
    // backstop, or null after `timeout` ms. Always disconnects its observer.
    function waitFor(find, root, timeout) {
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

    // Types `value` into a search box and resolves the best option node the
    // results offer, or null. Place searches can miss "Plainview, NY", so a
    // "City, ST" value that finds nothing is searched again by the city
    // alone, still picking the option in the right state; that second wait
    // holds out for a matching option because the old query's results linger
    // a moment. `options()` lists the result nodes on screen right now.
    async function searchFor(input, value, options, root, timeout) {
      typeInto(input, String(value));
      let hit = bestNode(await waitFor(options, root, timeout) || [], value);
      if (!hit && /,/.test(value)) {
        typeInto(input, String(value).split(',')[0].trim());
        hit = await waitFor(() => bestNode(options(), value), root, timeout);
      }
      return hit;
    }

    // An adapter's matches(url) for a hostname pattern; url is a string or URL.
    function hostMatcher(hosts) {
      return function matches(url) {
        try {
          return hosts.test(new URL(String(url && url.href ? url.href : url)).hostname);
        } catch (e) {
          return false;
        }
      };
    }

    return { norm, scoreText, bestNode, fire, press, typeInto, key, waitFor, searchFor, hostMatcher, sleep };
  })();

  return {
    normalizeLabel,
    scanFields,
    describeField: el => describeField(el),
    matchField,
    setValue,
    registerSiteAdapter,
    run,

    // Helpers for adapters and the UI.
    getSiteAdapter,
    listSiteAdapters: () => adapters.slice(),
    profileValue,
    bestOption,
    scoreOption,
    scoreLocation,
    findAnswer,
    dictionaryLookup,
    isFilled,
    currentValue,
    refindField: (desc, root) => refind(desc, root || defaultDocument()),
    siteKit,
    timing,
    PROFILE_KEYS: PROFILE_KEYS.slice(),
    DERIVED_KEYS: DERIVED_KEYS.slice(),

    // Test seam.
    _resetSiteAdapters() { adapters = []; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutofillCore;
}
