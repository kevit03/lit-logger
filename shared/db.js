// IndexedDB wrapper for LIT. Native indexedDB only, wrapped in promises.
//
// Only extension-origin contexts (the popup, the service worker, the options
// page) may use this. A content script's `indexedDB` belongs to the host page's
// origin, so the calendar overlay and the auto-trackers reach the database
// through the service worker instead (see TrackerStorage.serveRemote).
//
// Schema, version 1:
//   logs              keyPath 'id'. One record per logged entry. Internal
//                     fields: _uk (normalized account email, '' when signed
//                     out), _ck (normalized company), _seq (insertion order).
//     indexes         userEmail (_uk), date, metricId, company (_ck),
//                     timestamp, and compound user_date [_uk, date],
//                     user_metric_date [_uk, metricId, date],
//                     user_company [_uk, _ck], user_source [_uk, sourceId]
//   daily_aggregates  keyPath 'key' = '<_uk>|<YYYY-MM>'. Per-account, per-month
//                     day totals: { days: { 'YYYY-MM-DD': { metricId: n } },
//                     logCount }. Kept in step with logs inside the same
//                     transaction, so month views and streaks never scan logs.
//     indexes         userEmail (userKey)
//   settings          keyPath 'key'. Device-local bookkeeping (migration
//                     marker, snapshot schedule).
//   snapshots         keyPath 'id'. Rotating local backups.
//     indexes         createdAt
const LitDB = (() => {
  const DB_NAME = 'lit_tracker';
  const DB_VERSION = 1;
  const STORES = {
    LOGS: 'logs',
    AGGREGATES: 'daily_aggregates',
    SETTINGS: 'settings',
    SNAPSHOTS: 'snapshots'
  };

  function factory() {
    return typeof indexedDB !== 'undefined' && indexedDB && typeof indexedDB.open === 'function' ? indexedDB : null;
  }

  function available() {
    return !!factory();
  }

  function upgrade(db, oldVersion) {
    if (oldVersion < 1) {
      const logs = db.createObjectStore(STORES.LOGS, { keyPath: 'id' });
      logs.createIndex('userEmail', '_uk');
      logs.createIndex('date', 'date');
      logs.createIndex('metricId', 'metricId');
      logs.createIndex('company', '_ck');
      logs.createIndex('timestamp', 'timestamp');
      logs.createIndex('user_date', ['_uk', 'date']);
      logs.createIndex('user_metric_date', ['_uk', 'metricId', 'date']);
      logs.createIndex('user_company', ['_uk', '_ck']);
      logs.createIndex('user_source', ['_uk', 'sourceId']);

      const aggregates = db.createObjectStore(STORES.AGGREGATES, { keyPath: 'key' });
      aggregates.createIndex('userEmail', 'userKey');

      db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });

      const snapshots = db.createObjectStore(STORES.SNAPSHOTS, { keyPath: 'id' });
      snapshots.createIndex('createdAt', 'createdAt');
    }
  }

  // One connection per context. It is dropped (and reopened on next use) if
  // the browser closes it or another context upgrades the schema, and when a
  // test swaps in a fresh indexedDB.
  let connection = null;
  let connectionFactory = null;

  function open() {
    const idb = factory();
    if (!idb) return Promise.reject(new Error('IndexedDB is not available in this context'));
    if (connection && connectionFactory === idb) return connection;
    connectionFactory = idb;
    connection = new Promise((resolve, reject) => {
      let req;
      try {
        req = idb.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = event => {
        try {
          upgrade(req.result, event.oldVersion || 0);
        } catch (err) {
          reject(err);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch (e) { /* already closed */ }
          if (connectionFactory === idb) connection = null;
        };
        db.onclose = () => {
          if (connectionFactory === idb) connection = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('Could not open the LIT database'));
      req.onblocked = () => reject(new Error('The LIT database is blocked by another open version'));
    });
    connection.catch(() => {
      if (connectionFactory === idb) connection = null;
    });
    return connection;
  }

  // Runs `work(stores, out, tx)` inside a single transaction and resolves with
  // out.value once the transaction commits. `work` must issue every request
  // synchronously or from inside a request's onsuccess callback, never after
  // an await: a transaction commits as soon as it has nothing pending.
  // Any request error that is not handled aborts the whole transaction and
  // rejects, so a failed multi-store write never half-applies.
  function run(storeNames, mode, work) {
    const names = [].concat(storeNames);
    return open().then(db => new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(names, mode || 'readonly');
      } catch (err) {
        if (err && err.name === 'InvalidStateError' && connectionFactory === factory()) connection = null;
        reject(err);
        return;
      }
      const stores = {};
      names.forEach(n => { stores[n] = tx.objectStore(n); });
      const out = { value: undefined };
      let settled = false;
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(out.value);
      };
      tx.onabort = () => {
        if (settled) return;
        settled = true;
        reject(tx.error || out.error || new Error('LIT database transaction aborted'));
      };
      try {
        work(stores, out, tx);
      } catch (err) {
        out.error = err;
        try { tx.abort(); } catch (e) { /* already finished */ }
      }
    }));
  }

  // Convenience wrappers for single-request reads and writes.
  function get(store, key) {
    return run(store, 'readonly', (s, out) => {
      s[store].get(key).onsuccess = e => { out.value = e.target.result === undefined ? null : e.target.result; };
    });
  }

  function put(store, value) {
    return run(store, 'readwrite', (s, out) => {
      s[store].put(value).onsuccess = () => { out.value = value; };
    });
  }

  function remove(store, key) {
    return run(store, 'readwrite', (s, out) => {
      s[store].delete(key).onsuccess = () => { out.value = true; };
    });
  }

  function getAll(store, indexName, query) {
    return run(store, 'readonly', (s, out) => {
      const source = indexName ? s[store].index(indexName) : s[store];
      source.getAll(query === undefined ? null : query).onsuccess = e => { out.value = e.target.result || []; };
    });
  }

  function count(store, indexName, query) {
    return run(store, 'readonly', (s, out) => {
      const source = indexName ? s[store].index(indexName) : s[store];
      source.count(query === undefined ? null : query).onsuccess = e => { out.value = e.target.result || 0; };
    });
  }

  function keyRange() {
    return typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null;
  }

  // Test seam: forget the cached connection.
  function _reset() {
    connection = null;
    connectionFactory = null;
  }

  return {
    DB_NAME,
    DB_VERSION,
    STORES,
    available,
    open,
    run,
    get,
    put,
    remove,
    getAll,
    count,
    keyRange,
    _reset
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LitDB;
}
