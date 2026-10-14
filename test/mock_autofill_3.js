// Mocks for the in-page Autofill UI suite (test/autofill-ui.test.js).
//
// AutofillStore and AutofillCore are built by other files; these stubs follow
// the contract in AUTOFILL_AGENTS.md exactly and record every call, so the UI
// can be tested without either real implementation. Also: a window stand-in
// with countable listeners, field builders on top of test/mock_dom.js, and an
// event helper that carries an event past <html> to the document and window
// listeners (mock_dom stops bubbling at the root element).

const dom = require('./mock_dom');

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

const EMPTY_PROFILE = {
  firstName: '', lastName: '', preferredName: '', email: '', phone: '', phoneCountryCode: '',
  addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: '',
  linkedin: '', github: '', portfolio: '', website: '',
  school: '', degree: '', major: '', gpa: '', gradMonth: '', gradYear: '',
  currentCompany: '', currentTitle: '', yearsExperience: '',
  workAuthorized: '', needsSponsorship: '', willingToRelocate: '', earliestStartDate: '', salaryExpectation: '',
  howDidYouHear: '',
  eeo: { gender: '', race: '', hispanicLatino: '', veteran: '', disability: '' }
};

// AutofillStore stub. Every method is async, as in the contract.
function createStore(seed = {}) {
  const state = {
    profile: Object.assign(clone(EMPTY_PROFILE), seed.profile || {}),
    rules: clone(seed.rules || []),
    answers: clone(seed.answers || []),
    resume: seed.resume ? clone(seed.resume) : null,
    settings: Object.assign({ showButton: true, fillEeo: false, autoLearn: true }, seed.settings || {})
  };
  const listeners = new Set();
  const calls = { learnRule: [], saveAnswer: [], getSettings: 0 };
  let nextId = 1;
  const notify = () => listeners.forEach(fn => fn({}, []));

  const store = {
    state,
    calls,
    listenerCount: () => listeners.size,
    async getProfile() { return clone(state.profile); },
    async saveProfile(p) { state.profile = clone(p); notify(); },
    async getRules() { return clone(state.rules); },
    async learnRule(rule) {
      const hasKey = !!rule.profileKey;
      const hasValue = rule.value !== undefined && rule.value !== null;
      if (hasKey === hasValue) throw new Error('learnRule needs exactly one of profileKey or value.');
      calls.learnRule.push(clone(rule));
      const idx = state.rules.findIndex(r => r.host === rule.host && r.labelKey === rule.labelKey);
      const saved = Object.assign({ id: 'r' + nextId++ }, clone(rule));
      if (idx >= 0) state.rules[idx] = saved; else state.rules.push(saved);
      notify();
      return saved;
    },
    async deleteRule(id) { state.rules = state.rules.filter(r => r.id !== id); notify(); },
    async getAnswers() { return clone(state.answers); },
    async saveAnswer(a) {
      calls.saveAnswer.push(clone(a));
      state.answers.push(Object.assign({ id: 'a' + nextId++, labelKey: String(a.question).toLowerCase(), updatedAt: '' }, clone(a)));
      notify();
    },
    async deleteAnswer(id) { state.answers = state.answers.filter(a => a.id !== id); notify(); },
    async findAnswer() { return null; },
    async getResume() { return clone(state.resume); },
    async saveResume(r) { state.resume = clone(r); notify(); },
    async clearResume() { state.resume = null; notify(); },
    async getSettings() { calls.getSettings++; return clone(state.settings); },
    async saveSettings(partial) { Object.assign(state.settings, partial); notify(); },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
  };
  return store;
}

// AutofillCore stub. `run` returns whatever report the test sets with
// setReport(fn), where fn(options) builds a Report; every call is recorded.
// `fillValues` lets a test emulate setValue writing to the filled fields.
function createCore() {
  let reportFn = () => ({ filled: [], skipped: [], unmatched: [] });
  const calls = { run: [] };
  const core = {
    calls,
    setReport(fn) { reportFn = fn; },
    normalizeLabel(text) {
      return String(text || '').toLowerCase()
        .replace(/\(optional\)/g, ' ').replace(/\brequired\b/g, ' ')
        .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    },
    scanFields() { return []; },
    matchField() { return null; },
    async setValue(desc, value) {
      desc.el.value = String(value);
      return true;
    },
    registerSiteAdapter() {},
    async run(options) {
      calls.run.push(options);
      const report = reportFn(options);
      for (const item of report.filled || []) {
        if (item.match && item.match.value !== undefined && item.desc.kind !== 'radio') item.desc.el.value = String(item.match.value);
      }
      return report;
    }
  };
  return core;
}

function createWindow() {
  const listeners = {};
  return {
    innerWidth: 1280,
    innerHeight: 800,
    listeners,
    addEventListener(type, fn, opts) { (listeners[type] = listeners[type] || []).push({ fn, opts }); },
    removeEventListener(type, fn) {
      if (!listeners[type]) return;
      listeners[type] = listeners[type].filter(l => l.fn !== fn);
      if (!listeners[type].length) delete listeners[type];
    },
    listenerCount(type) {
      if (type) return (listeners[type] || []).length;
      return Object.values(listeners).reduce((n, l) => n + l.length, 0);
    },
    dispatch(type, extra = {}) {
      const event = Object.assign({ type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} }, extra);
      (listeners[type] || []).slice().forEach(l => l.fn(event));
      return event;
    }
  };
}

function docListenerCount(doc) {
  return Object.values(doc.listeners).reduce((n, l) => n + l.length, 0);
}

// Bubbles through the element chain (mock_dom), then reaches the document and
// window listeners the way a real event would.
function fire(doc, win, target, type, extra = {}) {
  const event = dom.makeEvent(type, target, Object.assign({ stopPropagation() {} }, extra));
  target.dispatchEvent(event);
  (doc.listeners[type] || []).slice().forEach(l => l.fn(event));
  if (win) (win.listeners[type] || []).slice().forEach(l => l.fn(event));
  return event;
}

// A visible form control. kind: 'text' | 'email' | 'tel' | 'textarea' |
// 'select' | 'radio' | 'checkbox' | 'password' | 'hidden' | 'submit' | 'file'.
function field(doc, kind, opts = {}) {
  const tag = kind === 'textarea' ? 'textarea' : kind === 'select' ? 'select' : 'input';
  const node = doc.createElement(tag);
  if (tag === 'input') node.setAttribute('type', kind);
  Object.entries(opts.attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
  node.value = opts.value || '';
  const visible = opts.visible !== false;
  node.offsetWidth = visible ? 240 : 0;
  node.offsetHeight = visible ? 32 : 0;
  node.rectTop = opts.top || 100;
  node.rectLeft = 40;
  return node;
}

// FieldDescriptor per the contract.
function descFor(el, kind, label, extra = {}) {
  return Object.assign({
    el,
    kind,
    label,
    labelKey: String(label).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim(),
    name: el.getAttribute('name') || '',
    id: el.getAttribute('id') || '',
    autocomplete: el.getAttribute('autocomplete') || '',
    placeholder: el.getAttribute('placeholder') || '',
    options: [],
    required: false
  }, extra);
}

module.exports = {
  EMPTY_PROFILE,
  createStore,
  createCore,
  createWindow,
  docListenerCount,
  fire,
  field,
  descFor
};
