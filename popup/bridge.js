// LIT popup bridge.
//
// Popup modules (popup/modules/*.js) add features in their own files without
// reaching into popup.js. They load after this file and before popup.js, and
// talk to the popup only through window.LitPopup:
//
//   LitPopup.whenReady(api => ...)   run once the first render is done
//   LitPopup.on(event, fn)           subscribe; returns an unsubscribe function
//   LitPopup.api                     state getters and helpers (null until
//                                    popup.js attaches, before the first render)
//   LitPopup.registerCard(type, spec, render)
//                                    adds a card type to the "Add a card"
//                                    picker. Call at load time (top level of a
//                                    module), before the popup reads the layout.
//   LitPopup.modulePref(key, fallback) / setModulePref(key, value)
//                                    per-module on/off switches and small
//                                    settings, kept in chrome.storage.local
//   LitPopup.addSetting({ id, label, hint, get, set })
//                                    a switch row in Settings > Extras
//
// Events (detail objects):
//   'ready'    {}                          first render finished
//   'render'   { metric }                  the counter and cards re-rendered
//   'log'      { metric, count, goal }     the person logged one in the popup
//   'undo'     { metric }                  Undo last took one back
//   'goal-met' { metric }                  today's goal was just met (once a day)
//   'tab'      { metric }                  a different goal tab was picked
//   'modal'    { open, id }                a dialog opened or closed
//   'settings' {}                          the settings sheet opened
//
// A module that throws never breaks the popup: every listener is isolated.
const LitPopup = (() => {
  const listeners = {};
  const readyQueue = [];
  const renderers = {};
  const settingRows = [];
  const MODULE_PREFS_KEY = 'lit_module_prefs';
  let modulePrefs = {};
  let prefsLoaded = false;
  let api = null;
  let ready = false;

  function safe(fn, detail, label) {
    try {
      fn(detail);
    } catch (e) {
      console.warn('[LIT] popup module error' + (label ? ' (' + label + ')' : ''), e);
    }
  }

  function loadModulePrefs() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get([MODULE_PREFS_KEY], r => {
          const v = r && r[MODULE_PREFS_KEY];
          modulePrefs = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
          prefsLoaded = true;
          resolve(modulePrefs);
        });
      } catch (e) {
        prefsLoaded = true;
        resolve(modulePrefs);
      }
    });
  }

  return {
    MODULE_PREFS_KEY,

    on(name, fn) {
      if (typeof fn !== 'function') return () => {};
      (listeners[name] = listeners[name] || []).push(fn);
      return () => {
        listeners[name] = (listeners[name] || []).filter(f => f !== fn);
      };
    },

    emit(name, detail) {
      (listeners[name] || []).slice().forEach(fn => safe(fn, detail || {}, name));
    },

    get api() { return api; },
    get isReady() { return ready; },

    whenReady(fn) {
      if (typeof fn !== 'function') return;
      if (ready) safe(fn, api, 'whenReady');
      else readyQueue.push(fn);
    },

    // popup.js only.
    attach(impl) { api = impl; },
    markReady() {
      if (ready) return;
      ready = true;
      readyQueue.splice(0).forEach(fn => safe(fn, api, 'whenReady'));
      this.emit('ready', {});
    },

    registerCard(type, spec, render) {
      if (typeof WidgetLayout === 'undefined' || typeof WidgetLayout.registerType !== 'function') return false;
      if (!WidgetLayout.registerType(type, spec)) return false;
      if (typeof render === 'function') renderers[type] = render;
      return true;
    },

    renderer(type) {
      return renderers[type] || null;
    },

    // Module prefs load before popup.js renders anything (it awaits this),
    // so reads are synchronous everywhere after that.
    loadModulePrefs,
    get modulePrefsLoaded() { return prefsLoaded; },

    modulePref(key, fallback) {
      return Object.prototype.hasOwnProperty.call(modulePrefs, key) ? modulePrefs[key] : fallback;
    },

    setModulePref(key, value) {
      modulePrefs = Object.assign({}, modulePrefs, { [key]: value });
      return new Promise(resolve => {
        try {
          chrome.storage.local.set({ [MODULE_PREFS_KEY]: modulePrefs }, () => resolve(modulePrefs));
        } catch (e) {
          resolve(modulePrefs);
        }
      });
    },

    // A switch row in Settings > Extras. get() returns the current boolean;
    // set(next) applies it (usually via setModulePref).
    addSetting(row) {
      if (!row || !row.id || typeof row.get !== 'function' || typeof row.set !== 'function') return;
      if (settingRows.some(r => r.id === row.id)) return;
      settingRows.push(row);
    },

    get settingRows() { return settingRows.slice(); }
  };
})();

if (typeof window !== 'undefined') window.LitPopup = LitPopup;
if (typeof module !== 'undefined' && module.exports) module.exports = LitPopup;
