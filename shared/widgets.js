// Popup widget layout for LIT.
//
// The popup below the counter is a grid of widgets (called "cards" in the
// UI) the user can add, remove, reorder, resize, collapse, and bind to a
// tracker (a "goal" in the UI). This module owns the
// registry of widget types and the persisted layout; popup/popup.js owns
// rendering. Nothing here touches the DOM, so the layout rules are testable
// headlessly.
//
// Layout record, chrome.storage.sync['pt_widgets']:
//   { version: 2, items: [{ id, type, options }] }
//
// Options every widget has:
//   size       'compact' (half width, two share a row) or 'expanded' (full row)
//   collapsed  accordion state; a collapsed widget shows only its header
// Options some widgets have:
//   metricId   'active' (follow the selected tab) or a tracker id
//   days       activity chart length: a day count (1 to 366) or 'all' for
//              the entire history
//   chart      'bar' | 'area' | 'heatmap'
//   showStats  activity totals row
//
// Singleton types (timer, timeStats, details) wrap markup that exists once in
// popup.html, so the layout holds at most one of each.
const WidgetLayout = (() => {
  const STORAGE_KEY = 'pt_widgets';
  const VERSION = 2;
  const ACTIVE = 'active';
  // Quick picks for the activity length; any count up to MAX_ACTIVITY_DAYS
  // can be typed, and ALL_DAYS charts the entire history.
  const ACTIVITY_DAYS = [7, 14, 30, 60, 90, 180, 365];
  const ALL_DAYS = 'all';
  const MAX_ACTIVITY_DAYS = 366;
  const CHART_MODES = ['bar', 'area', 'heatmap'];
  const SIZES = ['compact', 'expanded'];
  // Personal touches every card can carry. Stored sparsely: an option only
  // lands in storage when it differs from the default, so older layouts and
  // untouched cards stay byte-for-byte the same.
  const MAX_TITLE = 40;
  const CARD_COLORS = ['#E0674B', '#5E9270', '#3B7EA1', '#C9821F', '#8A5A9E', '#3D4A5C', '#C2185B', '#00897B'];
  const SUMMARY_PERIODS = ['today', 'week', 'month', 'total'];
  const DEFAULT_PERIODS = ['week', 'month', 'total'];
  const RECENT_COUNTS = [5, 10, 20];
  const DEFAULT_RECENT = 10;

  // Names and descriptions are user-facing copy: the popup calls these
  // "cards", in plain words.
  const TYPES = {
    goal: {
      name: 'Daily goal bar',
      description: 'Progress toward today\'s goal with checkpoints, plus your weekly goal.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    summary: {
      name: 'Totals',
      description: 'How many this week, this month, and all time.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    activity: {
      name: 'Activity chart',
      description: 'Bars, a line, or a calendar grid for any number of days, or your whole history.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE, days: 30, chart: 'bar', showStats: true }
    },
    streak: {
      name: 'Streak',
      description: 'Your current and longest run of days that hit the goal.',
      singleton: false,
      defaultSize: 'compact',
      defaults: { metricId: ACTIVE }
    },
    timer: {
      name: 'Solve timer',
      description: 'A countdown for practice problems. Shows on the LeetCode goal.',
      singleton: true,
      leetcodeOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    timeStats: {
      name: 'Solve times',
      description: 'Today, all time, average, and fastest, with a trend line.',
      singleton: true,
      leetcodeOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    details: {
      name: 'Add with details',
      description: 'Save the company, role, and a note with the next one you log.',
      singleton: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    pipeline: {
      name: 'Where applications stand',
      description: 'Applications by stage, from Applied to Offer. Tap a stage to filter.',
      singleton: false,
      jobsOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    recentList: {
      name: 'Recent applications',
      description: 'Your last 10 applications and where each one stands.',
      singleton: false,
      jobsOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    responseStats: {
      name: 'Replies',
      description: 'How many applications heard back, and how long replies take.',
      singleton: false,
      jobsOnly: true,
      defaultSize: 'compact',
      defaults: {}
    },
    trophies: {
      name: 'Trophy shelf',
      description: 'Milestones you have reached, and how close the next one is.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    recap: {
      name: 'Weekly recap',
      description: 'Your week so far in a sentence or two, ready to share.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    countdown: {
      name: 'Countdown',
      description: 'Days left until a date you care about, and what your pace adds up to by then.',
      singleton: false,
      defaultSize: 'compact',
      defaults: { metricId: ACTIVE }
    },
    compare: {
      name: 'This week vs last',
      description: 'This week next to last week, day by day.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    watchlist: {
      name: 'Companies I\'m watching',
      description: 'A short list of places you want to apply, checked off when you do.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: {}
    },
    notes: {
      name: 'Notes',
      description: 'A scratchpad for today\'s plan, a contact, or a thought. Saves as you type.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: {}
    },
    quote: {
      name: 'Daily boost',
      description: 'A fresh line of encouragement each day, or words of your own.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: {}
    }
  };

  // Widget types added after layout version 1. A layout saved by an older
  // build gets these appended once, so an upgrade surfaces them.
  const ADDED_IN_V2 = ['pipeline', 'recentList', 'responseStats'];
  // Newer card types are only offered in the picker (tagged New); saved
  // layouts are never changed to include them.
  const NEW_TYPES = ['trophies', 'recap', 'countdown', 'compare', 'watchlist', 'notes', 'quote'];
  const MAX_QUOTE = 160;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  // The recommended layout, kept lean for someone just starting: recent
  // applications and the weekly recap (the counter and week strip above the
  // grid are fixed). The solve timer only shows on the LeetCode goal, so it
  // costs nothing elsewhere. Fixed ids: a fresh install renders these before
  // anything is stored, and an edit made then must still find its widget on
  // the next read.
  const DEFAULT_ITEMS = [
    { id: 'timer-default', type: 'timer' },
    { id: 'recentList-default', type: 'recentList' },
    { id: 'recap-default', type: 'recap' }
  ];

  // Popup modules add card types at load time (before the layout is read).
  // A type needs a name, a description, defaults, and a size; it may add a
  // normalize(input, out) for its own options. Built-in types cannot be
  // replaced. New types are flagged New in the picker.
  const TYPE_ID = /^[a-z][a-zA-Z0-9]{1,30}$/;
  function registerType(type, spec) {
    if (typeof type !== 'string' || !TYPE_ID.test(type)) return false;
    if (Object.prototype.hasOwnProperty.call(TYPES, type)) return false;
    if (!spec || typeof spec.name !== 'string' || typeof spec.description !== 'string') return false;
    TYPES[type] = {
      name: spec.name,
      description: spec.description,
      singleton: !!spec.singleton,
      jobsOnly: !!spec.jobsOnly,
      leetcodeOnly: false,
      defaultSize: SIZES.includes(spec.defaultSize) ? spec.defaultSize : 'expanded',
      defaults: spec.defaults && typeof spec.defaults === 'object' ? Object.assign({}, spec.defaults) : {},
      normalize: typeof spec.normalize === 'function' ? spec.normalize : null,
      // SVG markup drawn inside a 14x14 viewBox for the "Add a card" list.
      icon: typeof spec.icon === 'string' ? spec.icon : '',
      // When this returns false (the module is switched off) the type leaves
      // the picker and its cards leave the board; nothing is deleted.
      enabled: typeof spec.enabled === 'function' ? spec.enabled : null,
      module: true
    };
    if (spec.isNew !== false && !NEW_TYPES.includes(type)) NEW_TYPES.push(type);
    return true;
  }

  function newId(type) {
    return type + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // chrome.storage.sync carries the layout across devices; falls back to
  // local (and then a localStorage shim) when sync is unavailable.
  function getStorageArea() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.sync) return chrome.storage.sync;
      if (chrome.storage.local) return chrome.storage.local;
    }
    return {
      get: (keys, cb) => {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (typeof localStorage !== 'undefined') {
            const val = localStorage.getItem(k);
            if (val !== null) {
              try { result[k] = JSON.parse(val); } catch (e) { /* ignore */ }
            }
          }
        });
        cb(result);
      },
      set: (items, cb) => {
        if (typeof localStorage !== 'undefined') {
          Object.entries(items).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v)));
        }
        if (cb) cb();
      }
    };
  }

  // A device upgrading from a local-only build still has its layout sitting
  // in chrome.storage.local; sync starts out empty until this runs once. Only
  // copies when sync has nothing yet, so it never clobbers a layout another
  // device already synced in.
  let widgetsMigrated = false;
  async function migrateFromLocalIfNeeded() {
    if (widgetsMigrated) return;
    widgetsMigrated = true;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync || !chrome.storage.local) return;
    try {
      const syncResult = await new Promise(r => chrome.storage.sync.get([STORAGE_KEY], r));
      if (syncResult && syncResult[STORAGE_KEY] !== undefined) return;
      const localResult = await new Promise(r => chrome.storage.local.get([STORAGE_KEY], r));
      if (localResult && localResult[STORAGE_KEY] !== undefined) {
        await new Promise(r => chrome.storage.sync.set({ [STORAGE_KEY]: localResult[STORAGE_KEY] }, r));
      }
    } catch (e) {
      // Best effort: sync simply starts with the default layout if this fails.
    }
  }

  // 'all', or a whole number of days from 1 to MAX_ACTIVITY_DAYS; anything
  // else is the fallback.
  function normalizeDays(value, fallback) {
    if (value === ALL_DAYS) return ALL_DAYS;
    if (typeof value === 'string' && value.trim().toLowerCase() === ALL_DAYS) return ALL_DAYS;
    const n = typeof value === 'number' ? value : (typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? parseInt(value, 10) : NaN);
    if (!Number.isInteger(n) || n < 1 || n > MAX_ACTIVITY_DAYS) return fallback;
    return n;
  }

  function normalizeOptions(type, raw) {
    const spec = TYPES[type];
    const out = Object.assign({}, spec.defaults);
    const input = raw && typeof raw === 'object' ? raw : {};
    if ('metricId' in spec.defaults) {
      out.metricId = typeof input.metricId === 'string' && input.metricId ? input.metricId : ACTIVE;
    }
    if (type === 'activity') {
      out.days = normalizeDays(input.days, spec.defaults.days);
      out.chart = CHART_MODES.includes(input.chart) ? input.chart : spec.defaults.chart;
      out.showStats = input.showStats === undefined ? spec.defaults.showStats : !!input.showStats;
    }
    // Per-type display choices (sparse: only non-default values are kept).
    if (type === 'goal') {
      if (input.showWeekly === false) out.showWeekly = false;
      if (input.showCheckpoints === false) out.showCheckpoints = false;
    }
    if (type === 'streak' && input.showLongest === false) out.showLongest = false;
    if (type === 'summary' && Array.isArray(input.periods)) {
      const periods = SUMMARY_PERIODS.filter(p => input.periods.includes(p));
      if (periods.length && periods.join() !== DEFAULT_PERIODS.join()) out.periods = periods;
    }
    if (type === 'recentList') {
      const n = parseInt(input.count, 10);
      if (RECENT_COUNTS.includes(n) && n !== DEFAULT_RECENT) out.count = n;
    }
    if (type === 'countdown') {
      if (typeof input.date === 'string' && ISO_DATE.test(input.date) && !isNaN(new Date(input.date + 'T12:00:00'))) out.date = input.date;
      if (typeof input.label === 'string') {
        const label = input.label.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
        if (label) out.label = label;
      }
    }
    if (type === 'quote' && typeof input.quoteText === 'string') {
      const text = input.quoteText.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE);
      if (text) out.quoteText = text;
    }
    // Card types added by popup modules may clean their own options.
    if (typeof spec.normalize === 'function') {
      try { spec.normalize(input, out); } catch (e) { /* keep the defaults */ }
    }
    // Every card: a custom title and its own color.
    if (typeof input.title === 'string') {
      const title = input.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
      if (title) out.title = title;
    }
    if (typeof input.color === 'string' && CARD_COLORS.includes(input.color.toUpperCase())) out.color = input.color.toUpperCase();
    out.size = SIZES.includes(input.size) ? input.size : spec.defaultSize;
    out.collapsed = !!input.collapsed;
    return out;
  }

  // Accepts anything that might be in storage and returns a clean item list:
  // unknown types dropped, duplicate singletons collapsed to the first,
  // missing ids minted, options merged over the type defaults.
  function normalize(raw) {
    const source = raw && Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : null);
    const list = source === null ? DEFAULT_ITEMS : source;
    const seenSingletons = new Set();
    const seenIds = new Set();
    const items = [];
    list.forEach(entry => {
      if (!entry || typeof entry !== 'object') return;
      const type = entry.type;
      const spec = Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : null;
      if (!spec) return;
      if (spec.singleton) {
        if (seenSingletons.has(type)) return;
        seenSingletons.add(type);
      }
      let id = typeof entry.id === 'string' && entry.id ? entry.id : newId(type);
      while (seenIds.has(id)) id = newId(type);
      seenIds.add(id);
      items.push({ id, type, options: normalizeOptions(type, entry.options) });
    });
    return items;
  }

  function defaultItems() {
    return normalize(null);
  }

  // Version 1 layouts predate the job-pipeline widgets. Append the ones the
  // user does not have yet, once; after that the layout is theirs.
  function upgrade(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const version = parseInt(raw.version, 10) || 1;
    if (version >= VERSION || !Array.isArray(raw.items)) return null;
    const items = normalize(raw);
    const present = new Set(items.map(i => i.type));
    ADDED_IN_V2.forEach(type => {
      if (present.has(type)) return;
      const defId = type + '-default';
      const id = items.some(i => i.id === defId) ? newId(type) : defId;
      items.push({ id, type, options: normalizeOptions(type, {}) });
    });
    return items;
  }

  function readRaw() {
    return migrateFromLocalIfNeeded().then(() => new Promise(resolve => {
      getStorageArea().get([STORAGE_KEY], result => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(result && result[STORAGE_KEY] !== undefined ? result[STORAGE_KEY] : null);
      });
    }));
  }

  function writeRaw(items) {
    return new Promise(resolve => {
      getStorageArea().set({ [STORAGE_KEY]: { version: VERSION, items } }, () => resolve(items));
    });
  }

  // Layout edits are read-modify-write; serialize them so two quick clicks
  // cannot clobber each other.
  let chain = Promise.resolve();
  function mutate(fn) {
    const run = async () => {
      const raw = await readRaw();
      const items = upgrade(raw) || normalize(raw);
      const next = fn(items.map(i => ({ id: i.id, type: i.type, options: Object.assign({}, i.options) })));
      if (!next) return items;
      return writeRaw(normalize(next));
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  function resolveMetricId(item, activeMetricId, metrics) {
    const wanted = item && item.options ? item.options.metricId : ACTIVE;
    if (!wanted || wanted === ACTIVE) return activeMetricId;
    if (Array.isArray(metrics) && !metrics.some(m => m && m.id === wanted)) return activeMetricId;
    return wanted;
  }

  // Timer widgets only make sense for LeetCode solves and pipeline widgets
  // only for job applications; hide them on other trackers rather than show
  // a countdown next to job applications or a funnel next to LeetCode.
  function isVisible(item, resolvedMetricId) {
    const spec = item && Object.prototype.hasOwnProperty.call(TYPES, item.type) ? TYPES[item.type] : null;
    if (!spec) return false;
    if (!typeEnabled(spec)) return false;
    if (spec.leetcodeOnly) return resolvedMetricId === 'leetcode';
    if (spec.jobsOnly) return resolvedMetricId === 'jobs';
    return true;
  }

  // Two compact widgets share a row. A compact widget with no compact
  // neighbour to pair with takes the full row instead of leaving a hole, so
  // rendering order always equals layout order. Returns the ids to stretch.
  function soloCompactIds(visibleItems) {
    const solo = new Set();
    let pending = null;
    (visibleItems || []).forEach(item => {
      const compact = item.options && item.options.size === 'compact';
      if (!compact) {
        if (pending) solo.add(pending.id);
        pending = null;
        return;
      }
      if (pending) {
        pending = null;
      } else {
        pending = item;
      }
    });
    if (pending) solo.add(pending.id);
    return solo;
  }

  function typeEnabled(spec) {
    if (!spec || typeof spec.enabled !== 'function') return true;
    try { return spec.enabled() !== false; } catch (e) { return true; }
  }

  function availableTypes(items) {
    const present = new Set((items || []).map(i => i.type));
    return Object.keys(TYPES).filter(type => typeEnabled(TYPES[type])).map(type => ({
      type,
      name: TYPES[type].name,
      description: TYPES[type].description,
      singleton: TYPES[type].singleton,
      isNew: NEW_TYPES.includes(type),
      added: TYPES[type].singleton && present.has(type),
      icon: TYPES[type].icon || ''
    }));
  }

  return {
    STORAGE_KEY,
    VERSION,
    ACTIVE,
    ACTIVITY_DAYS,
    ALL_DAYS,
    MAX_ACTIVITY_DAYS,
    normalizeDays,
    CHART_MODES,
    SIZES,
    MAX_TITLE,
    MAX_QUOTE,
    CARD_COLORS,
    SUMMARY_PERIODS,
    DEFAULT_PERIODS,
    RECENT_COUNTS,
    DEFAULT_RECENT,
    TYPES,
    registerType,
    normalize,
    normalizeOptions,
    defaultItems,
    resolveMetricId,
    isVisible,
    soloCompactIds,
    availableTypes,
    upgrade,

    // Nothing stored yet means the default layout; persist it so later edits
    // and other contexts all see the same ids. An older layout is upgraded
    // and written back once.
    async load() {
      const raw = await readRaw();
      if (raw === null) return writeRaw(normalize(null));
      const upgraded = upgrade(raw);
      if (upgraded) return writeRaw(upgraded);
      return normalize(raw);
    },

    async reset() {
      return mutate(() => DEFAULT_ITEMS.map(i => ({ id: i.id, type: i.type })));
    },

    async add(type, options) {
      if (!Object.prototype.hasOwnProperty.call(TYPES, type)) throw new Error('Unknown widget type: ' + type);
      return mutate(items => {
        if (TYPES[type].singleton && items.some(i => i.type === type)) return null;
        return items.concat([{ id: newId(type), type, options: normalizeOptions(type, options) }]);
      });
    },

    async remove(id) {
      return mutate(items => items.filter(i => i.id !== id));
    },

    // A copy of a card, right after the original, with all its settings.
    // Singleton cards wrap markup that exists once, so they cannot be copied.
    async duplicate(id) {
      return mutate(items => {
        const from = items.findIndex(i => i.id === id);
        if (from < 0 || TYPES[items[from].type].singleton) return null;
        const src = items[from];
        const copy = { id: newId(src.type), type: src.type, options: normalizeOptions(src.type, Object.assign({}, src.options, { collapsed: false })) };
        const next = items.slice();
        next.splice(from + 1, 0, copy);
        return next;
      });
    },

    // Patches the same options onto several cards at once (used for "make
    // every card half width" style bulk edits). Unknown ids are ignored.
    async updateMany(ids, patch) {
      const set = new Set(Array.isArray(ids) ? ids : []);
      return mutate(items => items.map(i => {
        if (!set.has(i.id)) return i;
        return { id: i.id, type: i.type, options: normalizeOptions(i.type, Object.assign({}, i.options, patch)) };
      }));
    },

    async update(id, patch) {
      return mutate(items => items.map(i => {
        if (i.id !== id) return i;
        const merged = Object.assign({}, i.options, patch && patch.options ? patch.options : patch);
        return { id: i.id, type: i.type, options: normalizeOptions(i.type, merged) };
      }));
    },

    // Drop `id` immediately before `beforeId`, or at the end when beforeId is
    // null. Drag and drop works on the visible widgets only, so callers name
    // a neighbour instead of an index; hidden widgets keep their place.
    async reorder(id, beforeId) {
      return mutate(items => {
        const from = items.findIndex(i => i.id === id);
        if (from < 0 || beforeId === id) return null;
        const rest = items.filter(i => i.id !== id);
        let to = beforeId ? rest.findIndex(i => i.id === beforeId) : rest.length;
        if (to < 0) to = rest.length;
        rest.splice(to, 0, items[from]);
        if (rest.every((i, idx) => i.id === items[idx].id)) return null;
        return rest;
      });
    },

    // delta -1 moves toward the top, +1 toward the bottom; clamped.
    async move(id, delta) {
      return mutate(items => {
        const from = items.findIndex(i => i.id === id);
        if (from < 0) return null;
        const to = Math.max(0, Math.min(items.length - 1, from + (delta < 0 ? -1 : 1)));
        if (to === from) return null;
        const copy = items.slice();
        const [it] = copy.splice(from, 1);
        copy.splice(to, 0, it);
        return copy;
      });
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WidgetLayout;
}
