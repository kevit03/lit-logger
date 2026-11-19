// Autofill storage for LIT.
//
// Everything lives in chrome.storage.local under keys prefixed 'af_', one key
// per kind of data so a profile edit never rewrites the resume:
//
//   af_profile    flat Profile object (see AUTOFILL_AGENTS.md), eeo nested
//   af_rules      learned rules: label -> profile key, or label -> literal value
//   af_answers    answer bank for long-answer questions
//   af_resume     { name, type, dataUrl, size, savedAt }, at most 5 MB decoded
//   af_settings   { showButton, fillEeo, autoLearn, aiEnabled, aiKey, aiModel }
//
// The Claude API key (settings.aiKey) is left out of exports by default, and
// an import without one keeps the key already stored.
//
// Every method is async. Read-modify-write calls go through one queue so two
// quick saves from the same page cannot overwrite each other.
//
// labelKey normalization is a private copy of AutofillCore.normalizeLabel, so
// this file has no load-order dependency on shared/autofill-core.js.
const AutofillStore = (() => {
  const KEYS = {
    PROFILE: 'af_profile',
    RULES: 'af_rules',
    ANSWERS: 'af_answers',
    RESUME: 'af_resume',
    SETTINGS: 'af_settings'
  };
  const PREFIX = 'af_';

  const EXPORT_FORMAT = 'lit-autofill';
  const EXPORT_VERSION = 1;

  const RESUME_MAX_BYTES = 5 * 1024 * 1024;
  const MAX_RULES = 2000;
  const MAX_ANSWERS = 1000;
  const ANSWER_THRESHOLD = 0.5;

  const PROFILE_FIELDS = [
    'firstName', 'lastName', 'preferredName', 'email', 'phone', 'phoneCountryCode',
    'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
    'linkedin', 'github', 'portfolio', 'website',
    'school', 'degree', 'major', 'gpa', 'gradMonth', 'gradYear',
    'currentCompany', 'currentTitle', 'yearsExperience',
    'workAuthorized', 'needsSponsorship', 'willingToRelocate',
    'earliestStartDate', 'salaryExpectation', 'howDidYouHear'
  ];
  const YES_NO_FIELDS = ['workAuthorized', 'needsSponsorship', 'willingToRelocate'];
  const EEO_FIELDS = ['gender', 'race', 'hispanicLatino', 'veteran', 'disability'];

  const DEFAULT_MODEL = 'claude-opus-5-5';
  const DEFAULT_SETTINGS = {
    showButton: true, fillEeo: false, autoLearn: true,
    aiEnabled: false, aiKey: '', aiModel: DEFAULT_MODEL
  };
  const SETTING_MAX_CHARS = { aiKey: 500, aiModel: 100 };
  const CONTEXT_MAX_CHARS = 120;

  // ----- Helpers -------------------------------------------------------------

  // Same rule as AutofillCore.normalizeLabel: lowercase, drop "(optional)",
  // the word "required", asterisks, and every other punctuation character
  // (each replaced by a space), then collapse whitespace and trim.
  function normalizeLabel(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/\(\s*optional\s*\)/g, ' ')
      .replace(/\*/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\brequired\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function randomId(prefix) {
    let rand = '';
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(9);
        crypto.getRandomValues(bytes);
        rand = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) {
      rand = '';
    }
    if (!rand) rand = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 10);
    return prefix + '_' + Date.now().toString(36) + '_' + rand;
  }

  function str(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function getArea() {
    if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.local) {
      throw new Error('AutofillStore: chrome.storage.local is not available');
    }
    return chrome.storage.local;
  }

  function lastErrorMessage() {
    try {
      const err = chrome && chrome.runtime && chrome.runtime.lastError;
      return err ? (err.message || String(err)) : '';
    } catch (e) {
      return '';
    }
  }

  function areaGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        getArea().get(keys, result => {
          const msg = lastErrorMessage();
          if (msg) reject(new Error(msg));
          else resolve(result || {});
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function areaSet(items) {
    return new Promise((resolve, reject) => {
      try {
        getArea().set(items, () => {
          const msg = lastErrorMessage();
          if (msg) reject(new Error(msg));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function areaRemove(keys) {
    return new Promise((resolve, reject) => {
      try {
        getArea().remove(keys, () => {
          const msg = lastErrorMessage();
          if (msg) reject(new Error(msg));
          else resolve();
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  async function readKey(key) {
    const result = await areaGet([key]);
    return result[key];
  }

  let queue = Promise.resolve();
  function enqueue(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  // ----- Sanitizers ------------------------------------------------------------

  function cleanYesNo(value) {
    const v = str(value).trim().toLowerCase();
    if (v === 'yes' || v === 'y' || v === 'true') return 'yes';
    if (v === 'no' || v === 'n' || v === 'false') return 'no';
    return '';
  }

  function defaultProfile() {
    const profile = {};
    PROFILE_FIELDS.forEach(k => { profile[k] = ''; });
    profile.eeo = {};
    EEO_FIELDS.forEach(k => { profile.eeo[k] = ''; });
    return profile;
  }

  // Overlays `input` on `base`, keeping only known keys. Unknown keys and the
  // derived fullName are dropped.
  function mergeProfile(base, input) {
    const out = defaultProfile();
    const src = isPlainObject(base) ? base : {};
    const patch = isPlainObject(input) ? input : {};
    PROFILE_FIELDS.forEach(k => {
      let v = Object.prototype.hasOwnProperty.call(patch, k) ? patch[k] : src[k];
      v = str(v).trim();
      if (YES_NO_FIELDS.includes(k)) v = cleanYesNo(v);
      out[k] = v;
    });
    const baseEeo = isPlainObject(src.eeo) ? src.eeo : {};
    const patchEeo = isPlainObject(patch.eeo) ? patch.eeo : {};
    EEO_FIELDS.forEach(k => {
      const v = Object.prototype.hasOwnProperty.call(patchEeo, k) ? patchEeo[k] : baseEeo[k];
      out.eeo[k] = str(v).trim();
    });
    return out;
  }

  function cleanSettings(base, patch) {
    const out = Object.assign({}, DEFAULT_SETTINGS);
    [base, patch].forEach(src => {
      if (!isPlainObject(src)) return;
      Object.keys(DEFAULT_SETTINGS).forEach(k => {
        const kind = typeof DEFAULT_SETTINGS[k];
        if (kind === 'boolean' && typeof src[k] === 'boolean') out[k] = src[k];
        if (kind === 'string' && typeof src[k] === 'string') out[k] = src[k].trim().slice(0, SETTING_MAX_CHARS[k] || 500);
      });
    });
    // An empty model field means the default model.
    if (!out.aiModel) out.aiModel = DEFAULT_MODEL;
    return out;
  }

  function cleanHost(host) {
    const h = str(host).trim().toLowerCase();
    return h || '*';
  }

  function cleanRule(raw) {
    if (!isPlainObject(raw)) return null;
    const labelKey = normalizeLabel(raw.labelKey);
    if (!labelKey) return null;
    const rule = {
      id: str(raw.id) || randomId('afr'),
      host: cleanHost(raw.host),
      labelKey
    };
    const profileKey = str(raw.profileKey).trim();
    if (profileKey) rule.profileKey = profileKey;
    else if (raw.value !== undefined && raw.value !== null) rule.value = str(raw.value);
    else return null;
    rule.createdAt = str(raw.createdAt) || nowIso();
    rule.updatedAt = str(raw.updatedAt) || rule.createdAt;
    return rule;
  }

  function cleanAnswer(raw) {
    if (!isPlainObject(raw)) return null;
    const question = str(raw.question).trim();
    const labelKey = normalizeLabel(question || raw.labelKey);
    const answer = str(raw.answer);
    if (!labelKey || !answer.trim()) return null;
    const entry = {
      id: str(raw.id) || randomId('afa'),
      question: question || labelKey,
      labelKey,
      answer,
      updatedAt: str(raw.updatedAt) || nowIso()
    };
    // The company and role the answer was written for, when known, so the
    // answer composer can swap them for the next job's.
    const company = cleanContext(raw.company);
    const role = cleanContext(raw.role);
    if (company) entry.company = company;
    if (role) entry.role = role;
    return entry;
  }

  function cleanContext(value) {
    return str(value).replace(/\s+/g, ' ').trim().slice(0, CONTEXT_MAX_CHARS);
  }

  // Decoded byte length of a base64 data URL (or the raw length otherwise).
  function dataUrlBytes(dataUrl) {
    const comma = dataUrl.indexOf(',');
    const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
    const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    if (/;base64$/i.test(header)) {
      const clean = body.replace(/\s+/g, '');
      const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
      return Math.max(0, Math.floor(clean.length * 3 / 4) - padding);
    }
    try {
      return decodeURIComponent(body).length;
    } catch (e) {
      return body.length;
    }
  }

  function formatMb(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function cleanResume(raw) {
    if (!isPlainObject(raw)) throw new Error('Resume is missing.');
    const dataUrl = str(raw.dataUrl);
    if (!/^data:[^,]*,/i.test(dataUrl)) throw new Error('Resume must be a data: URL.');
    const size = dataUrlBytes(dataUrl);
    if (size > RESUME_MAX_BYTES) {
      throw new Error('Resume is too large (' + formatMb(size) + '). The limit is 5 MB.');
    }
    const headerType = (dataUrl.match(/^data:([^;,]*)/i) || [])[1] || '';
    const name = str(raw.name).trim() || 'resume';
    return {
      name,
      type: str(raw.type).trim() || headerType || 'application/octet-stream',
      dataUrl,
      size,
      savedAt: str(raw.savedAt) || nowIso()
    };
  }

  // Sanitizes an imported list, dropping invalid entries and all but the
  // first entry for each key.
  function cleanUnique(list, clean, keyOf) {
    const seen = new Set();
    return list.map(clean).filter(item => {
      if (!item || seen.has(keyOf(item))) return false;
      seen.add(keyOf(item));
      return true;
    });
  }

  function tokenSet(labelKey) {
    return new Set(labelKey.split(' ').filter(Boolean));
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    a.forEach(t => { if (b.has(t)) inter++; });
    return inter / (a.size + b.size - inter);
  }

  // ----- Readers ---------------------------------------------------------------

  async function readProfile() {
    return mergeProfile(await readKey(KEYS.PROFILE), null);
  }

  async function readRules() {
    const raw = await readKey(KEYS.RULES);
    if (!Array.isArray(raw)) return [];
    return raw.map(cleanRule).filter(Boolean);
  }

  async function readAnswers() {
    const raw = await readKey(KEYS.ANSWERS);
    if (!Array.isArray(raw)) return [];
    return raw.map(cleanAnswer).filter(Boolean);
  }

  async function readSettings() {
    return cleanSettings(await readKey(KEYS.SETTINGS), null);
  }

  async function readResume() {
    const raw = await readKey(KEYS.RESUME);
    if (!isPlainObject(raw)) return null;
    try {
      return cleanResume(raw);
    } catch (e) {
      return null;
    }
  }

  function upsertAnswerInto(list, entry, id) {
    // Editing by id may change the question; any other entry that now has the
    // same labelKey is folded into this one.
    let idx = id ? list.findIndex(a => a.id === id) : -1;
    if (idx < 0) idx = list.findIndex(a => a.labelKey === entry.labelKey);
    if (idx >= 0) {
      const merged = Object.assign({}, entry, { id: list[idx].id });
      // Editing in place (by id) keeps the context it was saved with.
      if (id && list[idx].id === id) {
        ['company', 'role'].forEach(k => { if (!merged[k] && list[idx][k]) merged[k] = list[idx][k]; });
      }
      const rest = list.filter((a, i) => i !== idx && a.labelKey !== entry.labelKey);
      rest.unshift(merged);
      return { list: rest, saved: merged };
    }
    const fresh = Object.assign({}, entry, { id: randomId('afa') });
    return { list: [fresh].concat(list), saved: fresh };
  }

  // ----- Public API ------------------------------------------------------------

  const api = {
    KEYS,
    RESUME_MAX_BYTES,
    DEFAULT_MODEL,
    PROFILE_FIELDS: PROFILE_FIELDS.slice(),
    EEO_FIELDS: EEO_FIELDS.slice(),

    async getProfile() {
      return readProfile();
    },

    // Merges onto the stored profile, so a single changed field can be saved
    // on its own. Unknown keys and fullName are ignored.
    async saveProfile(profile) {
      return enqueue(async () => {
        const current = await readKey(KEYS.PROFILE);
        const next = mergeProfile(current, profile);
        await areaSet({ [KEYS.PROFILE]: next });
        return next;
      });
    },

    async getRules() {
      return readRules();
    },

    // Exactly one of profileKey / value. Upserts by (host, labelKey); host "*"
    // is global. Returns the stored rule.
    async learnRule({ host, labelKey, profileKey, value } = {}) {
      const hasKey = str(profileKey).trim() !== '';
      const hasValue = value !== undefined && value !== null;
      if (hasKey === hasValue) throw new Error('learnRule needs exactly one of profileKey or value.');
      const key = normalizeLabel(labelKey);
      if (!key) throw new Error('learnRule needs a non-empty labelKey.');
      const h = cleanHost(host);
      return enqueue(async () => {
        const rules = await readRules();
        const now = nowIso();
        const idx = rules.findIndex(r => r.host === h && r.labelKey === key);
        const rule = {
          id: idx >= 0 ? rules[idx].id : randomId('afr'),
          host: h,
          labelKey: key,
          createdAt: idx >= 0 ? rules[idx].createdAt : now,
          updatedAt: now
        };
        if (hasKey) rule.profileKey = str(profileKey).trim();
        else rule.value = str(value);
        if (idx >= 0) rules.splice(idx, 1);
        rules.unshift(rule);
        await areaSet({ [KEYS.RULES]: rules.slice(0, MAX_RULES) });
        return rule;
      });
    },

    async deleteRule(id) {
      return enqueue(async () => {
        const rules = await readRules();
        const next = rules.filter(r => r.id !== id);
        if (next.length === rules.length) return false;
        await areaSet({ [KEYS.RULES]: next });
        return true;
      });
    },

    async getAnswers() {
      return readAnswers();
    },

    // Upserts by labelKey. Passing an existing `id` edits that entry in place,
    // even when the question text (and so the labelKey) changes, and keeps
    // its company / role unless new ones are given. `company` and `role` are
    // the job the answer was written for, stored when given.
    async saveAnswer({ question, answer, id, company, role } = {}) {
      const entry = cleanAnswer({ question, answer, company, role, updatedAt: nowIso() });
      if (!entry) {
        if (!normalizeLabel(question)) throw new Error('Saved answer needs a question.');
        throw new Error('Saved answer needs an answer.');
      }
      return enqueue(async () => {
        const { list, saved } = upsertAnswerInto(await readAnswers(), entry, id);
        await areaSet({ [KEYS.ANSWERS]: list.slice(0, MAX_ANSWERS) });
        return saved;
      });
    },

    async deleteAnswer(id) {
      return enqueue(async () => {
        const answers = await readAnswers();
        const next = answers.filter(a => a.id !== id);
        if (next.length === answers.length) return false;
        await areaSet({ [KEYS.ANSWERS]: next });
        return true;
      });
    },

    // Best saved answer by Jaccard similarity of labelKey tokens, or null when
    // the best score is below 0.5. Ties go to the most recently updated.
    async findAnswer(questionText) {
      const target = tokenSet(normalizeLabel(questionText));
      if (!target.size) return null;
      const answers = await readAnswers();
      let best = null;
      answers.forEach(a => {
        const score = jaccard(target, tokenSet(a.labelKey));
        if (score < ANSWER_THRESHOLD) return;
        if (!best || score > best.score || (score === best.score && a.updatedAt > best.updatedAt)) {
          best = { answer: a.answer, score, id: a.id, question: a.question, updatedAt: a.updatedAt };
        }
      });
      if (!best) return null;
      delete best.updatedAt;
      return best;
    },

    async getResume() {
      return readResume();
    },

    // Rejects files over 5 MB (decoded) with a readable message.
    async saveResume(resume) {
      const clean = cleanResume(resume);
      return enqueue(async () => {
        await areaSet({ [KEYS.RESUME]: clean });
        return { name: clean.name, type: clean.type, size: clean.size, savedAt: clean.savedAt };
      });
    },

    async clearResume() {
      return enqueue(() => areaRemove([KEYS.RESUME]));
    },

    async getSettings() {
      return readSettings();
    },

    async saveSettings(partial) {
      return enqueue(async () => {
        const next = cleanSettings(await readKey(KEYS.SETTINGS), partial);
        await areaSet({ [KEYS.SETTINGS]: next });
        return next;
      });
    },

    // callback(changes, keys): changes is the chrome.storage.onChanged object
    // filtered to af_ keys; keys lists them. Returns an unsubscribe function.
    onChange(callback) {
      if (typeof callback !== 'function') return () => {};
      if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.onChanged) return () => {};
      const listener = (changes, areaName) => {
        if (areaName !== 'local' || !changes) return;
        const keys = Object.keys(changes).filter(k => k.startsWith(PREFIX));
        if (!keys.length) return;
        const filtered = {};
        keys.forEach(k => { filtered[k] = changes[k]; });
        try {
          callback(filtered, keys);
        } catch (e) {
          // A broken listener must not stop other listeners.
        }
      };
      chrome.storage.onChanged.addListener(listener);
      return () => chrome.storage.onChanged.removeListener(listener);
    },

    // ----- Import / export (used by the profile editor) ----------------------

    // The API key stays out of export files: a backup is easy to share by
    // accident. includeKey is for in-page undo snapshots only.
    async exportAll({ includeResume = true, includeKey = false } = {}) {
      const [profile, rules, answers, stored, resume] = await Promise.all([
        readProfile(), readRules(), readAnswers(), readSettings(), includeResume ? readResume() : null
      ]);
      const settings = Object.assign({}, stored);
      if (!includeKey) delete settings.aiKey;
      return {
        format: EXPORT_FORMAT,
        version: EXPORT_VERSION,
        exportedAt: nowIso(),
        profile,
        rules,
        answers,
        settings,
        resume: resume || null
      };
    },

    // Replaces each section present in `data`. Sections that are missing are
    // left alone; resume: null clears the stored resume. Everything is
    // validated first, so a bad file changes nothing.
    async importAll(data) {
      let parsed = data;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch (e) {
          throw new Error('Import file is not valid JSON.');
        }
      }
      if (!isPlainObject(parsed) || parsed.format !== EXPORT_FORMAT) {
        throw new Error('This file is not a LIT autofill export.');
      }
      if (typeof parsed.version === 'number' && parsed.version > EXPORT_VERSION) {
        throw new Error('This export is from a newer version of LIT.');
      }
      const items = {};
      const removals = [];
      const counts = { rules: 0, answers: 0, resume: false };
      if (isPlainObject(parsed.profile)) items[KEYS.PROFILE] = mergeProfile(null, parsed.profile);
      // A file without an API key (every normal export) keeps the stored key.
      const keepKey = isPlainObject(parsed.settings) && typeof parsed.settings.aiKey !== 'string';
      if (isPlainObject(parsed.settings)) items[KEYS.SETTINGS] = cleanSettings(null, parsed.settings);
      if (Array.isArray(parsed.rules)) {
        items[KEYS.RULES] = cleanUnique(parsed.rules, cleanRule, r => r.host + '\n' + r.labelKey).slice(0, MAX_RULES);
        counts.rules = items[KEYS.RULES].length;
      }
      if (Array.isArray(parsed.answers)) {
        items[KEYS.ANSWERS] = cleanUnique(parsed.answers, cleanAnswer, a => a.labelKey).slice(0, MAX_ANSWERS);
        counts.answers = items[KEYS.ANSWERS].length;
      }
      if (Object.prototype.hasOwnProperty.call(parsed, 'resume')) {
        if (parsed.resume === null) removals.push(KEYS.RESUME);
        else {
          items[KEYS.RESUME] = cleanResume(parsed.resume);
          counts.resume = true;
        }
      }
      return enqueue(async () => {
        if (keepKey) items[KEYS.SETTINGS].aiKey = (await readSettings()).aiKey;
        if (Object.keys(items).length) await areaSet(items);
        if (removals.length) await areaRemove(removals);
        return counts;
      });
    },

    // Removes every af_ key.
    async clearAll() {
      return enqueue(() => areaRemove(Object.values(KEYS)));
    }
  };

  return api;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutofillStore;
}
