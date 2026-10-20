// Mocks for the autofill site-adapter suite (agent 4).
//
// Builds on test/mock_dom.js without modifying it: AfElement subclasses
// FakeElement with the form-control surface the adapters touch (value, focus,
// click, disabled) and a selector engine that understands quoted attribute
// values containing brackets (Lever's name="urls[LinkedIn]"), the child
// combinator, and the ^= / $= / *= / ~= operators. A small HTML parser turns
// the fixtures in test/fixtures/autofill/ into a live tree, and the widget
// simulators below reproduce how react-select, Ashby's yes/no buttons and
// autocomplete, and Workday's listbox and prompt popups react to events.
const fs = require('fs');
const path = require('path');
const dom = require('./mock_dom');

const FIXTURES = path.join(__dirname, 'fixtures', 'autofill');

// --- selector engine ---------------------------------------------------------
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of str) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

function parseCompound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [] };
  const re = /^(?:([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\])/;
  let rest = src;
  while (rest.length) {
    const m = re.exec(rest);
    if (!m) throw new Error('mock_autofill_4: unsupported selector fragment: ' + src);
    if (m[1] && m[1] !== '*') c.tag = m[1].toLowerCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) {
      const value = m[6] !== undefined ? m[6] : m[7] !== undefined ? m[7] : m[8];
      c.attrs.push({ name: m[4], op: m[5] || null, value: value === undefined ? null : value });
    }
    rest = rest.slice(m[0].length);
  }
  return c;
}

// "a b > c" -> [{ compound: a }, { combinator: ' ', compound: b }, { combinator: '>', compound: c }]
function parseComplex(sel) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  const flush = () => { if (cur.trim()) tokens.push(cur.trim()); cur = ''; };
  for (const ch of sel) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0 && (ch === ' ' || ch === '>')) {
      flush();
      if (ch === '>') tokens.push('>');
      continue;
    }
    cur += ch;
  }
  flush();
  const parts = [];
  let combinator = ' ';
  for (const t of tokens) {
    if (t === '>') { combinator = '>'; continue; }
    parts.push({ combinator, compound: parseCompound(t) });
    combinator = ' ';
  }
  return parts;
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1 || el.tagName === '#SHADOW-ROOT') return false;
  if (c.tag && el.tagName.toLowerCase() !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '*=' && !(a.value && v.includes(a.value))) return false;
    if (a.op === '^=' && !(a.value && v.startsWith(a.value))) return false;
    if (a.op === '$=' && !(a.value && v.endsWith(a.value))) return false;
    if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === '|=' && !(v === a.value || v.startsWith(a.value + '-'))) return false;
  }
  return true;
}

function matchParts(el, parts, idx) {
  if (!matchCompound(el, parts[idx].compound)) return false;
  if (idx === 0) return true;
  const comb = parts[idx].combinator;
  if (comb === '>') return matchParts(el.parentElement, parts, idx - 1);
  for (let n = el.parentElement; n; n = n.parentElement) {
    if (matchParts(n, parts, idx - 1)) return true;
  }
  return false;
}

const selectorCache = new Map();
function compile(selector) {
  if (!selectorCache.has(selector)) selectorCache.set(selector, splitTopLevel(String(selector), ',').map(parseComplex));
  return selectorCache.get(selector);
}

function matchesSelector(el, selector) {
  return compile(selector).some(parts => matchParts(el, parts, parts.length - 1));
}

// --- nodes -------------------------------------------------------------------
class AfElement extends dom.FakeElement {
  constructor(tag, doc) {
    super(tag, doc);
    this._value = '';
    this.files = null;
  }
  get type() { return (this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : '')).toLowerCase(); }
  get name() { return this.getAttribute('name') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get value() {
    if (this.tagName === 'SELECT') {
      const opt = this.querySelectorAll('option').find(o => o.selected) || this.querySelector('option');
      return opt ? (opt.hasAttribute('value') ? opt.getAttribute('value') : opt.textContent) : '';
    }
    return this._value;
  }
  set value(v) { this._value = String(v); }
  matches(selector) { return matchesSelector(this, selector); }
  focus() {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement !== this) {
      if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
      doc.activeElement = this;
      this.dispatchEvent(dom.makeEvent('focus', this));
    }
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc && doc.activeElement === this) {
      doc.activeElement = doc.body;
      this.dispatchEvent(dom.makeEvent('blur', this));
    }
  }
  click() { this.dispatchEvent(dom.makeEvent('click', this)); }
  walkFind(test) {
    for (const n of this.walk()) if (test(n)) return n;
    return null;
  }
}

class AfDocument {
  constructor() {
    this.title = '';
    this.readyState = 'complete';
    this.listeners = {};
    this.documentElement = new AfElement('html', this);
    this.documentElement.isRoot = true;
    this.body = new AfElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag) { return new AfElement(tag, this); }
  getElementById(id) { return this.documentElement.walkFind(n => n.getAttribute('id') === id); }
  querySelector(sel) { return this.documentElement.matches(sel) ? this.documentElement : this.documentElement.querySelector(sel); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  addEventListener(type, fn, opts) { (this.listeners[type] = this.listeners[type] || []).push({ fn, opts }); }
  removeEventListener(type, fn) { if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter(l => l.fn !== fn); }
}


// --- HTML parser -------------------------------------------------------------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[m[1].toLowerCase()] = decode(v);
  }
  return attrs;
}

function appendText(node, text) {
  const t = decode(text).replace(/\s+/g, ' ');
  if (!t.trim()) return;
  node.ownText = (node.ownText + t).replace(/\s+/g, ' ');
}

// Parses an HTML fragment (or a whole document; the <html>/<head>/<body>
// wrappers are folded into the AfDocument's own) into `parent`.
function parseInto(doc, parent, html) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[5] !== undefined) { appendText(top(), m[5]); continue; }
    if (m[1]) {
      const tag = m[1].toLowerCase();
      if (['html', 'head', 'body'].includes(tag)) continue;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (tag === 'html' || tag === 'head') continue;
    if (tag === 'body') {
      Object.entries(parseAttrs(m[3] || '')).forEach(([k, v]) => doc.body.setAttribute(k, v));
      continue;
    }
    if (tag === 'title') {
      const end = html.indexOf('</title>', re.lastIndex);
      doc.title = decode(html.slice(re.lastIndex, end)).trim();
      re.lastIndex = end + 8;
      continue;
    }
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf('</' + tag, re.lastIndex);
      re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
      continue;
    }
    const node = doc.createElement(tag);
    Object.entries(parseAttrs(m[3] || '')).forEach(([k, v]) => node.setAttribute(k, v));
    if (node.hasAttribute('value')) node._value = node.getAttribute('value');
    if (tag === 'option' && node.hasAttribute('selected')) node.selected = true;
    if (tag === 'input' && node.hasAttribute('checked')) node.checked = true;
    top().appendChild(node);
    if (tag === 'textarea') {
      const end = html.toLowerCase().indexOf('</textarea', re.lastIndex);
      node._value = decode(html.slice(re.lastIndex, end));
      re.lastIndex = html.indexOf('>', end) + 1;
      continue;
    }
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
}

function html(doc, markup) {
  const wrap = doc.createElement('div');
  parseInto(doc, wrap, markup);
  return wrap.children.length === 1 ? wrap.children[0] : wrap;
}

function loadFixture(name) {
  dom.installDom(); // fresh FakeMutationObserver registry on the global
  const doc = new AfDocument();
  parseInto(doc, doc.body, fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
  return doc;
}

// Appends and notifies observers, the way a framework portal mounts.
function mount(parent, node) {
  parent.appendChild(node);
  dom.emitAdded(node);
  return node;
}

function later(ms, fn) { setTimeout(fn, ms); }

// --- widget simulators -------------------------------------------------------

// react-select as Greenhouse's job-boards renders it: the menu opens on the
// control's mouseup (that is when it appeared on a live board), typing in the
// input filters options by substring, an option click commits a
// .select__single-value and unmounts the menu. With `asyncOptions`, options
// only arrive `delay` ms after typing (the candidate-location field).
function reactSelect(doc, inputId, labels, { asyncOptions = false, delay = 15 } = {}) {
  const input = doc.getElementById(inputId);
  const control = input.closest('.select__control');
  const shell = input.closest('.select-shell') || control.parentElement;
  const state = { open: false, menu: null, selected: null, clicks: 0 };

  const close = () => {
    if (state.menu) state.menu.remove();
    state.menu = null;
    state.open = false;
    input.setAttribute('aria-expanded', 'false');
  };

  const render = () => {
    if (state.menu) state.menu.remove();
    const q = input.value.trim().toLowerCase();
    const shown = asyncOptions && !q ? [] : labels.filter(l => l.toLowerCase().includes(q));
    const menu = html(doc, '<div class="select__menu remix-css-menu"><div class="select__menu-list" role="listbox" aria-multiselectable="false" id="react-select-' + inputId + '-listbox"></div></div>');
    const list = menu.firstElementChild;
    if (!shown.length) {
      list.appendChild(html(doc, '<div class="select__menu-notice select__menu-notice--no-options">No options</div>'));
    }
    shown.forEach((label, i) => {
      const opt = html(doc, '<div class="select__option" aria-disabled="false" tabindex="-1" role="option"></div>');
      opt.id = 'react-select-' + inputId + '-option-' + i;
      opt.ownText = label;
      opt.addEventListener('click', () => {
        state.clicks++;
        state.selected = label;
        const vc = control.querySelector('.select__value-container');
        const old = vc.querySelector('.select__single-value') || vc.querySelector('.select__placeholder');
        if (old) old.remove();
        const sv = html(doc, '<div class="select__single-value"></div>');
        sv.ownText = label;
        vc.appendChild(sv);
        input.value = '';
        close();
      });
      list.appendChild(opt);
    });
    state.menu = mount(shell, menu);
    state.open = true;
    input.setAttribute('aria-expanded', 'true');
  };

  control.addEventListener('mouseup', () => { if (!state.open) render(); });
  input.addEventListener('input', () => {
    if (asyncOptions) {
      if (state.menu) state.menu.remove();
      state.menu = null;
      later(delay, render);
    } else {
      render();
    }
  });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  return state;
}

// Ashby yes/no pair: clicking a button sets aria-pressed on it, clears the
// other, and mirrors the answer into the display:none checkbox.
function ashbyYesNo(doc, container) {
  const state = { clicks: 0 };
  const buttons = container.querySelectorAll('button');
  const box = container.querySelector('input[type="checkbox"]');
  buttons.forEach(b => b.addEventListener('click', () => {
    state.clicks++;
    buttons.forEach(o => o.setAttribute('aria-pressed', o === b ? 'true' : 'false'));
    box.checked = b.getAttribute('data-option') === 'yes';
  }));
  return state;
}

// Ashby location autocomplete: typing mounts a floating [role=listbox] with
// [role=option] rows after a short fetch; clicking a row writes it into the
// input and unmounts the list.
function ashbyAutocomplete(doc, input, labels, { delay = 15 } = {}) {
  const state = { list: null };
  const close = () => { if (state.list) state.list.remove(); state.list = null; input.setAttribute('aria-expanded', 'false'); };
  input.addEventListener('input', () => {
    close();
    const q = input.value.trim().toLowerCase();
    later(delay, () => {
      const list = html(doc, '<div class="_floatingContainer_x" role="listbox" id=":r0:"></div>');
      labels.filter(l => l.toLowerCase().includes(q)).forEach(label => {
        const row = html(doc, '<div class="_result_x ashby-application-form-input-autocomplete-result" role="option"></div>');
        row.ownText = label;
        row.addEventListener('click', () => { input.value = label; close(); });
        list.appendChild(row);
      });
      state.list = mount(doc.body, list);
      input.setAttribute('aria-expanded', 'true');
    });
  });
  return state;
}

// Workday single-select: a click on the button mounts ul[role=listbox] at the
// end of <body> (a portal) after `openDelay` ms. Picking an option closes the
// list and, like Workday, re-renders the whole form field, so the old button
// node is detached and a new one with the same id takes its place.
function workdayListbox(doc, buttonSelector, labels, { openDelay = 10, rerender = true } = {}) {
  const state = { opens: 0, picks: 0, rerenders: 0 };
  const wire = button => {
    button.addEventListener('click', () => {
      if (button.getAttribute('aria-expanded') === 'true') return;
      state.opens++;
      later(openDelay, () => {
        const listId = button.getAttribute('aria-controls') || 'listbox-' + state.opens;
        const ul = html(doc, '<ul role="listbox" tabindex="-1" data-automation-id="activeListContainer"></ul>');
        ul.id = listId;
        labels.forEach((label, i) => {
          const li = html(doc, '<li role="option" aria-selected="false" tabindex="-1"><div data-automation-id="promptOption"></div></li>');
          li.setAttribute('data-value', 'opt-' + i);
          li.firstElementChild.ownText = label;
          li.addEventListener('click', () => {
            state.picks++;
            ul.remove();
            const fresh = rerender ? doc.createElement('button') : button;
            if (rerender) {
              Object.entries(button.attributes).forEach(([k, v]) => fresh.setAttribute(k, v));
              button.parentElement.appendChild(fresh);
              button.remove();
              wire(fresh);
              state.rerenders++;
            }
            fresh.setAttribute('aria-expanded', 'false');
            fresh.textContent = label;
            fresh.setAttribute('value', 'opt-' + i);
          });
          ul.appendChild(li);
        });
        button.setAttribute('aria-expanded', 'true');
        mount(doc.body, ul);
      });
    });
  };
  wire(doc.querySelector(buttonSelector));
  return state;
}

// Workday multiselect prompt ("How did you hear about us?"): Enter in the
// search input mounts a wd-popup whose promptOption rows match the query.
// Category rows open a second level; leaf rows add a selected pill to the
// field's selectedItemList. Pass { flatten: false } for tenants whose search
// returns the category row rather than the nested match.
function workdayPrompt(doc, inputSelector, tree, { delay = 10, flatten = true } = {}) {
  const state = { searches: 0, picks: [] };
  const input = doc.querySelector(inputSelector);
  const field = input.closest('[data-automation-id="multiSelectContainer"]');
  const widgetId = field.getAttribute('id');
  let popup = null;
  const close = () => { if (popup) popup.remove(); popup = null; };
  const show = rows => {
    close();
    popup = html(doc, '<div data-automation-widget="wd-popup"><div data-associated-widget="' + widgetId + '"><div data-automation-id="activeListContainer" role="listbox"></div></div></div>');
    const list = popup.querySelector('[role="listbox"]');
    rows.forEach(node => {
      const row = html(doc, '<div role="option" data-automation-id="menuItem"><div data-automation-id="promptOption" data-automation-label=""></div></div>');
      row.firstElementChild.ownText = node.label;
      row.firstElementChild.setAttribute('data-automation-label', node.label);
      if (node.children) row.firstElementChild.setAttribute('data-uxi-multiselectlistitem-hasChildren', 'true');
      row.addEventListener('click', () => {
        if (node.children) { later(delay, () => show(node.children)); return; }
        state.picks.push(node.label);
        const ul = field.querySelector('[data-automation-id="selectedItemList"]');
        const li = html(doc, '<li data-automation-id="menuItem"><div data-automation-id="selectedItem"></div></li>');
        li.firstElementChild.ownText = node.label;
        mount(ul, li);
        input.value = '';
        close();
      });
      list.appendChild(row);
    });
    mount(doc.body, popup);
  };
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    state.searches++;
    const q = input.value.trim().toLowerCase();
    // flatten: search returns matching nodes from any level. Otherwise it
    // returns top-level rows that match or contain a match (a category).
    const hit = n => n.label.toLowerCase().includes(q) || (n.children || []).some(hit);
    const flat = [];
    const visit = nodes => nodes.forEach(n => { if (n.label.toLowerCase().includes(q)) flat.push(n); if (n.children) visit(n.children); });
    if (!q) flat.push(...tree);
    else if (flatten) visit(tree);
    else flat.push(...tree.filter(hit));
    later(delay, () => show(flat));
  });
  return state;
}

// --- AutofillCore stub -------------------------------------------------------
function stubAutofillCore() {
  const core = {
    adapters: [],
    setValueCalls: [],
    registerSiteAdapter(adapter) { core.adapters.push(adapter); },
    // Real place scoring: adapters defer to it for "City, ST" values.
    scoreLocation: require('../shared/autofill-core.js').scoreLocation,
    async setValue(desc, value) {
      core.setValueCalls.push({ desc, value });
      if (!desc || !desc.el) return false;
      desc.el.value = String(value);
      desc.el.dispatchEvent(dom.makeEvent('input', desc.el));
      desc.el.dispatchEvent(dom.makeEvent('change', desc.el));
      return true;
    }
  };
  global.AutofillCore = core;
  return core;
}

function unstubAutofillCore() { delete global.AutofillCore; }

module.exports = {
  AfElement,
  AfDocument,
  matchesSelector,
  parseInto,
  html,
  loadFixture,
  mount,
  reactSelect,
  ashbyYesNo,
  ashbyAutocomplete,
  workdayListbox,
  workdayPrompt,
  stubAutofillCore,
  unstubAutofillCore,
  FIXTURES
};
