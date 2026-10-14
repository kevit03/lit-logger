// Form-control layer on top of test/mock_dom.js for the autofill engine tests.
//
// mock_dom.js models a tree of elements; the engine also needs what a real
// form has: text nodes and siblings (label extraction), input / textarea /
// select / option elements with prototype value setters (the React path),
// radio exclusivity, checkbox / radio click(), File + DataTransfer + FileList,
// getComputedStyle / getClientRects for visibility, and an Event class whose
// `target` the mock dispatcher can write.
const dom = require('./mock_dom');

const { FakeElement, FakeDocument } = dom;

class MockEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.target = null;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

class TextNode {
  constructor(text, parent) {
    this.nodeType = 3;
    this.nodeValue = text;
    this.parentNode = parent;
  }
  get textContent() { return this.nodeValue; }
}

class AFElement extends FakeElement {
  get childNodes() {
    const out = [];
    if (this.ownText) {
      if (!this._textNode || this._textNode.nodeValue !== this.ownText) this._textNode = new TextNode(this.ownText, this);
      out.push(this._textNode);
    }
    return out.concat(this.children);
  }
  get previousSibling() {
    const p = this.parentNode;
    if (!p || !p.childNodes) return null;
    const kids = p.childNodes;
    const i = kids.indexOf(this);
    return i > 0 ? kids[i - 1] : null;
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p || !p.childNodes) return null;
    const kids = p.childNodes;
    const i = kids.indexOf(this);
    return i >= 0 && i < kids.length - 1 ? kids[i + 1] : null;
  }
  get hidden() { return this.hasAttribute('hidden'); }
  getRootNode() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    if (n.host) return n;
    if (n.isRoot) return this.ownerDocument;
    return n;
  }
  getClientRects() {
    let n = this;
    while (n) {
      if (n.style && n.style.display === 'none') return [];
      if (n.hasAttribute && n.hasAttribute('hidden')) return [];
      n = n.parentNode || n.host || null;
    }
    return [{ width: 10, height: 10 }];
  }
  getElementById(id) {
    for (const e of this.walk()) if (e.id === id) return e;
    return null;
  }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  blur() {}
  click() { this.dispatchEvent(new MockEvent('click', { bubbles: true, cancelable: true })); }
  attachShadow(init) {
    const root = new AFElement('#shadow-root', this.ownerDocument);
    root.nodeType = 11;
    root.mode = init && init.mode;
    root.host = this;
    this.shadowRoot = init && init.mode === 'closed' ? null : root;
    this._shadow = root;
    return root;
  }
}

function scopeOf(el) {
  return el.closest('form') || el.getRootNode();
}

class AFInput extends AFElement {
  constructor(tag, doc) {
    super(tag, doc);
    delete this.checked; // mock_dom sets an own data property; use the accessor below
    this._value = null;
    this._checked = null;
    this._files = null;
  }
  get type() { return (this.getAttribute('type') || 'text').toLowerCase(); }
  get name() { return this.getAttribute('name') || ''; }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get readOnly() { return this.hasAttribute('readonly'); }
  get required() { return this.hasAttribute('required'); }
  get value() {
    if (this._value !== null) return this._value;
    const a = this.getAttribute('value');
    if (a !== null) return a;
    return this.type === 'checkbox' || this.type === 'radio' ? 'on' : '';
  }
  set value(v) {
    if (this.type === 'file') {
      if (v !== '') throw new Error('InvalidStateError: file inputs only accept an empty string');
      this._files = null;
      return;
    }
    this._value = v == null ? '' : String(v);
  }
  get checked() { return this._checked !== null ? this._checked : this.hasAttribute('checked'); }
  set checked(v) {
    const on = !!v;
    this._checked = on;
    if (on && this.type === 'radio' && this.name) {
      const scope = scopeOf(this);
      const peers = scope && scope.querySelectorAll ? scope.querySelectorAll('input') : [];
      peers.forEach(p => { if (p !== this && p.type === 'radio' && p.name === this.name) p._checked = false; });
    }
  }
  get files() { return this._files || new MockFileList([]); }
  set files(list) {
    if (!(list instanceof MockFileList)) throw new TypeError('files must be a FileList');
    this._files = list;
  }
  click() {
    if (this.disabled) return;
    const t = this.type;
    if (t === 'checkbox' || t === 'radio') {
      const before = this.checked;
      const peersBefore = t === 'radio' ? this._radioPeers().map(p => [p, p.checked]) : [];
      if (t === 'checkbox') this.checked = !before; else this.checked = true;
      const ev = new MockEvent('click', { bubbles: true, cancelable: true });
      this.dispatchEvent(ev);
      if (ev.defaultPrevented) {
        this._checked = before;
        peersBefore.forEach(([p, c]) => { p._checked = c; });
        return;
      }
      if (this.checked !== before) {
        this.dispatchEvent(new MockEvent('input', { bubbles: true }));
        this.dispatchEvent(new MockEvent('change', { bubbles: true }));
      }
      return;
    }
    super.click();
  }
  _radioPeers() {
    if (!this.name) return [];
    const scope = scopeOf(this);
    return scope.querySelectorAll('input').filter(p => p !== this && p.type === 'radio' && p.name === this.name);
  }
}

class AFTextArea extends AFElement {
  constructor(tag, doc) { super(tag, doc); this._value = null; }
  get name() { return this.getAttribute('name') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get readOnly() { return this.hasAttribute('readonly'); }
  get required() { return this.hasAttribute('required'); }
  get value() { return this._value !== null ? this._value : this.ownText; }
  set value(v) { this._value = v == null ? '' : String(v); }
}

class AFOption extends AFElement {
  get value() { const a = this.getAttribute('value'); return a !== null ? a : this.text; }
  get text() { return this.textContent.replace(/\s+/g, ' ').trim(); }
  _select() { return this.closest('select'); }
  get selected() {
    const s = this._select();
    if (!s) return this.hasAttribute('selected');
    return s.multiple ? !!s._multi.has(this) || (s._multi.size === 0 && this.hasAttribute('selected')) : s.selectedIndex === s.options.indexOf(this);
  }
  set selected(v) {
    const s = this._select();
    if (!s) return;
    if (s.multiple) { if (v) s._multi.add(this); else s._multi.delete(this); return; }
    if (v) s._index = s.options.indexOf(this);
  }
}

class AFSelect extends AFElement {
  constructor(tag, doc) { super(tag, doc); this._index = null; this._multi = new Set(); }
  get name() { return this.getAttribute('name') || ''; }
  get disabled() { return this.hasAttribute('disabled'); }
  get required() { return this.hasAttribute('required'); }
  get multiple() { return this.hasAttribute('multiple'); }
  get options() { return this.querySelectorAll('option'); }
  get selectedIndex() {
    const opts = this.options;
    if (this.multiple) {
      for (let i = 0; i < opts.length; i++) if (opts[i].selected) return i;
      return -1;
    }
    if (this._index !== null) return this._index;
    const marked = opts.findIndex(o => o.hasAttribute('selected'));
    if (marked >= 0) return marked;
    return opts.length ? 0 : -1;
  }
  set selectedIndex(i) {
    const n = Number(i);
    this._index = n >= 0 && n < this.options.length ? n : -1;
  }
  get value() {
    const i = this.selectedIndex;
    return i >= 0 ? this.options[i].value : '';
  }
  set value(v) {
    this._index = this.options.findIndex(o => o.value === String(v));
  }
}

class AFLabel extends AFElement {
  get htmlFor() { return this.getAttribute('for') || ''; }
}

const CLASSES = { input: AFInput, textarea: AFTextArea, select: AFSelect, option: AFOption, label: AFLabel };

class AFDocument extends FakeDocument {
  constructor() {
    super();
    this.documentElement = new AFElement('html', this);
    this.documentElement.isRoot = true;
    this.body = new AFElement('body', this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag) {
    const C = CLASSES[String(tag).toLowerCase()] || AFElement;
    return new C(tag, this);
  }
}

class MockFile {
  constructor(parts, name, opts = {}) {
    const chunks = parts.map(p => (p instanceof Uint8Array ? p : new TextEncoder().encode(String(p))));
    const size = chunks.reduce((n, c) => n + c.length, 0);
    this.bytes = new Uint8Array(size);
    let off = 0;
    chunks.forEach(c => { this.bytes.set(c, off); off += c.length; });
    this.name = String(name);
    this.type = opts.type || '';
    this.size = size;
  }
}

class MockFileList {
  constructor(files) {
    files.forEach((f, i) => { this[i] = f; });
    this.length = files.length;
  }
  item(i) { return this[i] || null; }
}

class MockDataTransfer {
  constructor() {
    const files = [];
    this.files = new MockFileList([]);
    this.items = {
      add: f => { files.push(f); this.files = new MockFileList(files); }
    };
  }
}

function mockGetComputedStyle(el) {
  let visibility = 'visible';
  let n = el;
  while (n) {
    if (n.style && n.style.visibility) { visibility = n.style.visibility; break; }
    n = n.parentNode;
  }
  return { display: (el.style && el.style.display) || 'block', visibility };
}

const GLOBALS = ['MutationObserver', 'Event', 'File', 'DataTransfer', 'HTMLInputElement', 'HTMLTextAreaElement',
  'HTMLSelectElement', 'getComputedStyle', 'document', 'location'];

// Installs the globals the engine reads and returns { doc, h, restore }.
// h(tag, attrs?, ...children): attrs may hold `style` (an object); string
// children become text (the first as the element's own text, later ones as
// <span>s so sibling order is kept).
function installAutofillDom(opts = {}) {
  const saved = {};
  GLOBALS.forEach(k => { saved[k] = Object.getOwnPropertyDescriptor(global, k); });
  dom.installDom();
  const doc = new AFDocument();
  const set = (k, v) => Object.defineProperty(global, k, { value: v, writable: true, configurable: true });
  set('Event', MockEvent);
  set('File', MockFile);
  set('DataTransfer', MockDataTransfer);
  set('HTMLInputElement', AFInput);
  set('HTMLTextAreaElement', AFTextArea);
  set('HTMLSelectElement', AFSelect);
  set('getComputedStyle', mockGetComputedStyle);
  set('document', doc);
  set('location', opts.href ? new URL(opts.href) : undefined);

  function h(tag, attrs, ...children) {
    let a = attrs;
    if (a === null || a === undefined || typeof a === 'string' || a instanceof FakeElement) {
      if (a !== null && a !== undefined) children.unshift(a);
      a = {};
    }
    const node = doc.createElement(tag);
    Object.entries(a).forEach(([k, v]) => {
      if (k === 'style') Object.assign(node.style, v);
      else node.setAttribute(k, v);
    });
    children.flat().forEach(c => {
      if (c === null || c === undefined || c === false) return;
      if (typeof c === 'string' || typeof c === 'number') {
        if (!node.children.length && !node.ownText) node.ownText = String(c);
        else { const s = doc.createElement('span'); s.ownText = String(c); node.appendChild(s); }
      } else {
        node.appendChild(c);
      }
    });
    return node;
  }

  function restore() {
    GLOBALS.forEach(k => {
      if (saved[k]) Object.defineProperty(global, k, saved[k]);
      else delete global[k];
    });
  }

  return { doc, h, restore };
}

module.exports = {
  installAutofillDom,
  MockEvent,
  MockFile,
  MockFileList,
  MockDataTransfer,
  AFElement,
  AFInput,
  AFTextArea,
  AFSelect,
  AFOption,
  AFDocument
};
