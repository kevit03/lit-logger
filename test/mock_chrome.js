// In-memory mock for Chrome Extension APIs
// Zero-emoji compliant test infrastructure

function deepClone(obj) {
  if (obj === undefined || obj === null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

class MockStorageArea {
  constructor(name, eventBus) {
    this.name = name;
    this.eventBus = eventBus;
    this.store = {};
  }

  get(keys, callback) {
    let result = {};
    if (!keys) {
      result = deepClone(this.store);
    } else if (typeof keys === 'string') {
      if (this.store[keys] !== undefined) {
        result[keys] = deepClone(this.store[keys]);
      }
    } else if (Array.isArray(keys)) {
      keys.forEach(k => {
        if (this.store[k] !== undefined) {
          result[k] = deepClone(this.store[k]);
        }
      });
    } else if (typeof keys === 'object') {
      Object.keys(keys).forEach(k => {
        result[k] = this.store[k] !== undefined ? deepClone(this.store[k]) : deepClone(keys[k]);
      });
    }

    if (typeof callback === 'function') {
      process.nextTick(() => callback(result));
      return;
    }
    return Promise.resolve(result);
  }

  set(items, callback) {
    if (!items || typeof items !== 'object') {
      if (typeof callback === 'function') process.nextTick(callback);
      return Promise.resolve();
    }

    const changes = {};
    Object.keys(items).forEach(key => {
      const oldValue = deepClone(this.store[key]);
      const newValue = deepClone(items[key]);
      this.store[key] = newValue;
      changes[key] = { oldValue, newValue };
    });

    if (this.eventBus && Object.keys(changes).length > 0) {
      process.nextTick(() => {
        this.eventBus.dispatch(changes, this.name);
      });
    }

    if (typeof callback === 'function') {
      process.nextTick(callback);
      return;
    }
    return Promise.resolve();
  }

  remove(keys, callback) {
    const keyList = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    keyList.forEach(k => {
      if (this.store[k] !== undefined) {
        const oldValue = deepClone(this.store[k]);
        delete this.store[k];
        changes[k] = { oldValue, newValue: undefined };
      }
    });

    if (this.eventBus && Object.keys(changes).length > 0) {
      process.nextTick(() => {
        this.eventBus.dispatch(changes, this.name);
      });
    }

    if (typeof callback === 'function') {
      process.nextTick(callback);
      return;
    }
    return Promise.resolve();
  }

  clear(callback) {
    const changes = {};
    Object.keys(this.store).forEach(k => {
      changes[k] = { oldValue: deepClone(this.store[k]), newValue: undefined };
    });
    this.store = {};

    if (this.eventBus && Object.keys(changes).length > 0) {
      process.nextTick(() => {
        this.eventBus.dispatch(changes, this.name);
      });
    }

    if (typeof callback === 'function') {
      process.nextTick(callback);
      return;
    }
    return Promise.resolve();
  }
}

class MockStorageEventBus {
  constructor() {
    this.listeners = new Set();
  }

  addListener(cb) {
    if (typeof cb === 'function') {
      this.listeners.add(cb);
    }
  }

  removeListener(cb) {
    this.listeners.delete(cb);
  }

  hasListener(cb) {
    return this.listeners.has(cb);
  }

  dispatch(changes, areaName) {
    for (const listener of this.listeners) {
      try {
        listener(changes, areaName);
      } catch (err) {
        console.error('Error in mock storage listener:', err);
      }
    }
  }
}

class MockIdentityAPI {
  constructor() {
    this.tokenToReturn = 'mock-oauth2-token-12345';
    this.shouldFail = false;
    this.failureMessage = 'OAuth token request rejected';
    this.cachedTokens = new Set();
  }

  getAuthToken(details, callback) {
    if (this.shouldFail) {
      if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.lastError = { message: this.failureMessage };
      }
      process.nextTick(() => {
        callback(undefined);
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          chrome.runtime.lastError = null;
        }
      });
      return;
    }

    this.cachedTokens.add(this.tokenToReturn);
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.lastError = null;
    }
    process.nextTick(() => {
      callback(this.tokenToReturn);
    });
  }

  removeCachedAuthToken(details, callback) {
    if (details && details.token) {
      this.cachedTokens.delete(details.token);
    }
    if (typeof callback === 'function') {
      process.nextTick(callback);
    }
  }
}

function createMockChrome(initialStore = {}) {
  const eventBus = new MockStorageEventBus();
  const localStorageArea = new MockStorageArea('local', eventBus);
  Object.keys(initialStore).forEach(k => {
    localStorageArea.store[k] = deepClone(initialStore[k]);
  });

  const identity = new MockIdentityAPI();

  // chrome.storage.session is exposed to content scripts only after the
  // service worker calls setAccessLevel; the mock records that call so tests
  // can assert on it and otherwise behaves like a second in-memory area.
  const sessionStorageArea = new MockStorageArea('session', eventBus);
  sessionStorageArea.accessLevel = 'TRUSTED_CONTEXTS';
  sessionStorageArea.setAccessLevel = function (details, callback) {
    this.accessLevel = details && details.accessLevel ? details.accessLevel : this.accessLevel;
    if (typeof callback === 'function') process.nextTick(callback);
    return Promise.resolve();
  };

  // Real chrome.storage.sync enforces an 8KB-per-item / 100KB-total quota,
  // which is exactly what the logs chunking in shared/storage.js exists to
  // respect. Mirror those limits here so a chunking bug shows up as a test
  // failure instead of only at real quota time.
  const syncStorageArea = new MockStorageArea('sync', eventBus);
  syncStorageArea.QUOTA_BYTES = 102400;
  syncStorageArea.QUOTA_BYTES_PER_ITEM = 8192;
  const baseSyncSet = syncStorageArea.set.bind(syncStorageArea);
  syncStorageArea.set = function (items, callback) {
    const incoming = items || {};
    let projectedTotal = 0;
    let overItem = null;
    Object.keys(syncStorageArea.store).forEach(k => {
      if (Object.prototype.hasOwnProperty.call(incoming, k)) return;
      projectedTotal += k.length + JSON.stringify(syncStorageArea.store[k]).length;
    });
    Object.entries(incoming).forEach(([key, value]) => {
      const size = key.length + JSON.stringify(value === undefined ? null : value).length;
      projectedTotal += size;
      if (size > syncStorageArea.QUOTA_BYTES_PER_ITEM) overItem = key;
    });
    if (overItem || projectedTotal > syncStorageArea.QUOTA_BYTES) {
      const message = overItem
        ? 'QUOTA_BYTES_PER_ITEM quota exceeded for key "' + overItem + '"'
        : 'QUOTA_BYTES quota exceeded';
      if (typeof chrome !== 'undefined' && chrome.runtime) chrome.runtime.lastError = { message };
      if (typeof callback === 'function') process.nextTick(() => {
        callback();
        if (typeof chrome !== 'undefined' && chrome.runtime) chrome.runtime.lastError = null;
      });
      return Promise.resolve();
    }
    return baseSyncSet(items, callback);
  };

  // chrome.runtime messaging: sendMessage reaches every onMessage listener
  // with a sender naming this extension. A listener that returns true keeps
  // the channel open for an async sendResponse, as in MV3.
  const messageListeners = new Set();
  const onMessage = {
    addListener(cb) { messageListeners.add(cb); },
    removeListener(cb) { messageListeners.delete(cb); },
    hasListener(cb) { return messageListeners.has(cb); },
    listenerCount() { return messageListeners.size; }
  };

  const mock = {
    storage: {
      local: localStorageArea,
      sync: syncStorageArea,
      session: sessionStorageArea,
      onChanged: eventBus
    },
    identity: identity,
    runtime: {
      lastError: null,
      id: 'job-tracker-mock-extension-id',
      getURL(path) {
        return 'chrome-extension://' + this.id + '/' + (path || '').replace(/^\//, '');
      },
      onMessage,
      sentMessages: [],
      sendMessage(message, callback) {
        const runtime = mock.runtime;
        const payload = deepClone(message);
        runtime.sentMessages.push(payload);
        const sender = { id: runtime.id, tab: { id: 1 }, frameId: 0 };
        let answered = false;
        let keepOpen = false;
        const respond = response => {
          if (answered) return;
          answered = true;
          process.nextTick(() => { if (typeof callback === 'function') callback(deepClone(response)); });
        };
        process.nextTick(() => {
          for (const listener of Array.from(messageListeners)) {
            const ret = listener(payload, sender, respond);
            if (ret === true) keepOpen = true;
            if (answered) break;
          }
          if (!answered && !keepOpen) {
            runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            if (typeof callback === 'function') callback(undefined);
            runtime.lastError = null;
          }
        });
      }
    }
  };

  return mock;
}

let originalChrome = undefined;

function installMockChrome(initialStore = {}) {
  originalChrome = global.chrome;
  const mock = createMockChrome(initialStore);
  global.chrome = mock;
  return mock;
}

function uninstallMockChrome() {
  global.chrome = originalChrome;
}

module.exports = {
  createMockChrome,
  installMockChrome,
  uninstallMockChrome,
  MockStorageArea,
  MockStorageEventBus,
  MockIdentityAPI
};
