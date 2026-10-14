// Popup widget layout for LIT.
//
// The popup below the counter is a grid of widgets the user can add, remove,
// reorder, resize, collapse, and bind to a tracker. This module owns the
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
//   days       activity chart length
//   chart      'bar' | 'area' | 'heatmap'
//   showStats  activity totals row
//
// Singleton types (timer, timeStats, details) wrap markup that exists once in
// popup.html, so the layout holds at most one of each.
const WidgetLayout = (() => {
  const STORAGE_KEY = 'pt_widgets';
  const VERSION = 2;
  const ACTIVE = 'active';
  const ACTIVITY_DAYS = [7, 14, 30, 60];
  const CHART_MODES = ['bar', 'area', 'heatmap'];
  const SIZES = ['compact', 'expanded'];

  const TYPES = {
    goal: {
      name: 'Daily Goal',
      description: 'Progress toward the daily goal with milestones, plus the weekly goal.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    summary: {
      name: 'Week / Month / Total',
      description: 'Counts for this week, this month, and all time.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE }
    },
    activity: {
      name: 'Activity Chart',
      description: 'Bars, a sparkline, or a contribution heatmap for the last 7 to 60 days.',
      singleton: false,
      defaultSize: 'expanded',
      defaults: { metricId: ACTIVE, days: 30, chart: 'bar', showStats: true }
    },
    streak: {
      name: 'Streak',
      description: 'Current and longest run of days that hit the daily goal.',
      singleton: false,
      defaultSize: 'compact',
      defaults: { metricId: ACTIVE }
    },
    timer: {
      name: 'Solve Timer',
      description: 'Countdown with presets, nudges, and laps. Shows on the LeetCode tracker.',
      singleton: true,
      leetcodeOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    timeStats: {
      name: 'Solve Time Stats',
      description: 'Today, all time, average, and fastest, with a distribution sparkline.',
      singleton: true,
      leetcodeOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    details: {
      name: 'Add Details',
      description: 'Company, role, and notes form for the next entry.',
      singleton: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    pipeline: {
      name: 'Application Pipeline',
      description: 'Applications by stage, from Applied to Offer. Select a stage to filter.',
      singleton: false,
      jobsOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    recentList: {
      name: 'Recent Applications',
      description: 'The last 10 applications with their stage. Select a stage to change it.',
      singleton: false,
      jobsOnly: true,
      defaultSize: 'expanded',
      defaults: {}
    },
    responseStats: {
      name: 'Response Rate',
      description: 'Share of applications that heard back, and the average days to a reply.',
      singleton: false,
      jobsOnly: true,
      defaultSize: 'compact',
      defaults: {}
    }
  };

  // Widget types added after layout version 1. A layout saved by an older
  // build gets these appended once, so an upgrade surfaces them.
  const ADDED_IN_V2 = ['pipeline', 'recentList', 'responseStats'];

  // The recommended layout. Fixed ids: a fresh install renders these before
  // anything is stored, and an edit made then must still find its widget on
  // the next read.
  const DEFAULT_ITEMS = [
    { id: 'timer-default', type: 'timer' },
    { id: 'timeStats-default', type: 'timeStats' },
    { id: 'goal-default', type: 'goal' },
    { id: 'details-default', type: 'details' },
    { id: 'pipeline-default', type: 'pipeline' },
    { id: 'recentList-default', type: 'recentList' },
    { id: 'streak-default', type: 'streak' },
    { id: 'responseStats-default', type: 'responseStats' },
    { id: 'summary-default', type: 'summary' },
    { id: 'activity-default', type: 'activity' }
  ];

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

  function normalizeOptions(type, raw) {
    const spec = TYPES[type];
    const out = Object.assign({}, spec.defaults);
    const input = raw && typeof raw === 'object' ? raw : {};
    if ('metricId' in spec.defaults) {
      out.metricId = typeof input.metricId === 'string' && input.metricId ? input.metricId : ACTIVE;
    }
    if (type === 'activity') {
      const days = parseInt(input.days, 10);
      out.days = ACTIVITY_DAYS.includes(days) ? days : spec.defaults.days;
      out.chart = CHART_MODES.includes(input.chart) ? input.chart : spec.defaults.chart;
      out.showStats = input.showStats === undefined ? spec.defaults.showStats : !!input.showStats;
    }
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
      const def = DEFAULT_ITEMS.find(d => d.type === type);
      const id = items.some(i => i.id === def.id) ? newId(type) : def.id;
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

  function availableTypes(items) {
    const present = new Set((items || []).map(i => i.type));
    return Object.keys(TYPES).map(type => ({
      type,
      name: TYPES[type].name,
      description: TYPES[type].description,
      singleton: TYPES[type].singleton,
      isNew: ADDED_IN_V2.includes(type),
      added: TYPES[type].singleton && present.has(type)
    }));
  }

  return {
    STORAGE_KEY,
    VERSION,
    ACTIVE,
    ACTIVITY_DAYS,
    CHART_MODES,
    SIZES,
    TYPES,
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
