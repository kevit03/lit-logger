// In-memory IndexedDB for the Node test suite.
//
// Implements the subset shared/db.js relies on, with the semantics that
// matter for correctness rather than a toy key-value map:
//   - key ordering per the IndexedDB spec (number < date < string < array,
//     arrays compared element-wise), so compound-index range scans behave
//   - object stores with keyPath, indexes (single and compound keyPath),
//     get / getAll / getAllKeys / count / put / add / delete / clear /
//     openCursor on stores and indexes, and IDBKeyRange
//   - transactions that run one at a time per database, fire their request
//     callbacks asynchronously, stay active while callbacks queue more
//     requests, auto-commit when idle, and roll back on an unhandled error
//     or abort()
//   - versioned open with onupgradeneeded
// Values are structured-cloned on the way in and out, like the real thing.

function cmp(a, b) {
  const ta = keyType(a);
  const tb = keyType(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (ta === 3) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmp(a[i], b[i]);
      if (c !== 0) return c;
    }
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
  }
  const va = ta === 1 ? a.getTime() : a;
  const vb = tb === 1 ? b.getTime() : b;
  if (va === vb) return 0;
  return va < vb ? -1 : 1;
}

// 0 number, 1 date, 2 string, 3 array. Anything else is not a valid key.
function keyType(k) {
  if (typeof k === 'number' && !Number.isNaN(k)) return 0;
  if (k instanceof Date) return 1;
  if (typeof k === 'string') return 2;
  if (Array.isArray(k)) return 3;
  return -1;
}

function isValidKey(k) {
  const t = keyType(k);
  if (t < 0) return false;
  if (t === 3) return k.every(isValidKey);
  return true;
}

function domError(name, message) {
  const err = new Error(message || name);
  err.name = name;
  return err;
}

class FakeKeyRange {
  constructor(lower, upper, lowerOpen, upperOpen) {
    this.lower = lower;
    this.upper = upper;
    this.lowerOpen = !!lowerOpen;
    this.upperOpen = !!upperOpen;
  }
  includes(key) {
    if (this.lower !== undefined) {
      const c = cmp(key, this.lower);
      if (c < 0 || (c === 0 && this.lowerOpen)) return false;
    }
    if (this.upper !== undefined) {
      const c = cmp(key, this.upper);
      if (c > 0 || (c === 0 && this.upperOpen)) return false;
    }
    return true;
  }
  static only(v) { return new FakeKeyRange(v, v, false, false); }
  static bound(l, u, lo, uo) {
    if (cmp(l, u) > 0) throw domError('DataError', 'lower is greater than upper');
    return new FakeKeyRange(l, u, lo, uo);
  }
  static lowerBound(l, open) { return new FakeKeyRange(l, undefined, open, false); }
  static upperBound(u, open) { return new FakeKeyRange(undefined, u, false, open); }
}

function toRange(query) {
  if (query === undefined || query === null) return null;
  if (query instanceof FakeKeyRange) return query;
  if (!isValidKey(query)) throw domError('DataError', 'invalid key');
  return FakeKeyRange.only(query);
}

function extractKey(value, keyPath) {
  if (Array.isArray(keyPath)) {
    const parts = keyPath.map(p => extractKey(value, p));
    return parts.every(p => p !== undefined && isValidKey(p)) ? parts : undefined;
  }
  let cur = value;
  for (const seg of String(keyPath).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function clone(v) {
  return structuredClone(v);
}

class FakeRequest {
  constructor(source, transaction) {
    this.source = source;
    this.transaction = transaction;
    this.readyState = 'pending';
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

// Store data lives on the database; the objects below are per-transaction
// handles onto it, which is how the real API scopes operations.
class StoreData {
  constructor(name, keyPath, autoIncrement) {
    this.name = name;
    this.keyPath = keyPath === undefined ? null : keyPath;
    this.autoIncrement = !!autoIncrement;
    this.records = []; // sorted [{ key, value }]
    this.indexes = new Map(); // name -> { keyPath, unique, multiEntry }
    this.nextKey = 1;
  }
  find(key) {
    let lo = 0;
    let hi = this.records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cmp(this.records[mid].key, key);
      if (c === 0) return { found: true, index: mid };
      if (c < 0) lo = mid + 1; else hi = mid - 1;
    }
    return { found: false, index: lo };
  }
  snapshot() {
    return { records: this.records.slice(), nextKey: this.nextKey };
  }
  restore(s) {
    this.records = s.records;
    this.nextKey = s.nextKey;
  }
}

class FakeIndex {
  constructor(store, name) {
    this.objectStore = store;
    this.name = name;
    const spec = store._data.indexes.get(name);
    this.keyPath = spec.keyPath;
    this.unique = spec.unique;
    this.multiEntry = spec.multiEntry;
  }
  // Every (indexKey, primaryKey, value) triple, ordered by index key then
  // primary key.
  _entries(range) {
    const out = [];
    for (const rec of this.objectStore._data.records) {
      const ik = extractKey(rec.value, this.keyPath);
      if (ik === undefined || !isValidKey(ik)) continue;
      const keys = this.multiEntry && Array.isArray(ik) ? ik : [ik];
      for (const k of keys) {
        if (!range || range.includes(k)) out.push({ indexKey: k, key: rec.key, value: rec.value });
      }
    }
    out.sort((a, b) => cmp(a.indexKey, b.indexKey) || cmp(a.key, b.key));
    return out;
  }
  get(query) {
    return this.objectStore._tx._request(this, () => {
      const hit = this._entries(toRange(query))[0];
      return hit ? clone(hit.value) : undefined;
    });
  }
  getKey(query) {
    return this.objectStore._tx._request(this, () => {
      const hit = this._entries(toRange(query))[0];
      return hit ? hit.key : undefined;
    });
  }
  getAll(query, count) {
    return this.objectStore._tx._request(this, () => {
      const list = this._entries(toRange(query)).map(e => clone(e.value));
      return count ? list.slice(0, count) : list;
    });
  }
  getAllKeys(query, count) {
    return this.objectStore._tx._request(this, () => {
      const list = this._entries(toRange(query)).map(e => e.key);
      return count ? list.slice(0, count) : list;
    });
  }
  count(query) {
    return this.objectStore._tx._request(this, () => this._entries(toRange(query)).length);
  }
  openCursor(query, direction) {
    const entries = () => {
      const list = this._entries(toRange(query));
      return direction === 'prev' || direction === 'prevunique' ? list.reverse() : list;
    };
    return this.objectStore._openCursor(this, entries);
  }
}

class FakeCursor {
  constructor(request, list, store) {
    this._request = request;
    this._list = list;
    this._pos = 0;
    this._store = store;
    this._sync();
  }
  _sync() {
    const e = this._list[this._pos];
    this.key = e ? (e.indexKey !== undefined ? e.indexKey : e.key) : undefined;
    this.primaryKey = e ? e.key : undefined;
    this.value = e ? clone(e.value) : undefined;
  }
  continue() {
    this._pos++;
    this._sync();
    this._store._tx._reissue(this._request, () => (this._pos < this._list.length ? this : null));
  }
  advance(n) {
    this._pos += Math.max(1, n | 0);
    this._sync();
    this._store._tx._reissue(this._request, () => (this._pos < this._list.length ? this : null));
  }
  delete() {
    return this._store.delete(this.primaryKey);
  }
  update(value) {
    return this._store.put(value);
  }
}

class FakeObjectStore {
  constructor(tx, data) {
    this._tx = tx;
    this._data = data;
    this.name = data.name;
    this.keyPath = data.keyPath;
    this.autoIncrement = data.autoIncrement;
  }
  get indexNames() {
    const names = Array.from(this._data.indexes.keys());
    return { contains: n => names.includes(n), length: names.length, item: i => names[i] };
  }
  createIndex(name, keyPath, options = {}) {
    if (!this._tx._versionChange) throw domError('InvalidStateError', 'createIndex outside an upgrade');
    if (this._data.indexes.has(name)) throw domError('ConstraintError', 'index exists: ' + name);
    this._data.indexes.set(name, { keyPath, unique: !!options.unique, multiEntry: !!options.multiEntry });
    return new FakeIndex(this, name);
  }
  deleteIndex(name) {
    this._data.indexes.delete(name);
  }
  index(name) {
    if (!this._data.indexes.has(name)) throw domError('NotFoundError', 'no index named ' + name);
    return new FakeIndex(this, name);
  }
  _keyFor(value, explicitKey) {
    if (this._data.keyPath !== null) {
      if (explicitKey !== undefined) throw domError('DataError', 'key given for an in-line keyPath store');
      let k = extractKey(value, this._data.keyPath);
      if (k === undefined && this._data.autoIncrement) {
        k = this._data.nextKey++;
        value[this._data.keyPath] = k;
      }
      if (!isValidKey(k)) throw domError('DataError', 'record has no valid key at ' + this._data.keyPath);
      return k;
    }
    if (explicitKey === undefined && this._data.autoIncrement) return this._data.nextKey++;
    if (!isValidKey(explicitKey)) throw domError('DataError', 'invalid key');
    return explicitKey;
  }
  _checkUnique(value, key) {
    for (const [name, spec] of this._data.indexes) {
      if (!spec.unique) continue;
      const ik = extractKey(value, spec.keyPath);
      if (ik === undefined) continue;
      for (const rec of this._data.records) {
        if (cmp(rec.key, key) === 0) continue;
        const other = extractKey(rec.value, spec.keyPath);
        if (other !== undefined && cmp(other, ik) === 0) throw domError('ConstraintError', 'unique index ' + name + ' violated');
      }
    }
  }
  _write(value, explicitKey, noOverwrite) {
    this._tx._assertWritable();
    const copy = clone(value);
    const key = this._keyFor(copy, explicitKey);
    return this._tx._request(this, () => {
      const pos = this._data.find(key);
      if (pos.found && noOverwrite) throw domError('ConstraintError', 'key already exists');
      this._checkUnique(copy, key);
      if (pos.found) this._data.records[pos.index] = { key, value: copy };
      else this._data.records.splice(pos.index, 0, { key, value: copy });
      if (typeof key === 'number' && key >= this._data.nextKey) this._data.nextKey = Math.floor(key) + 1;
      return key;
    });
  }
  put(value, key) { return this._write(value, key, false); }
  add(value, key) { return this._write(value, key, true); }
  get(query) {
    return this._tx._request(this, () => {
      const range = toRange(query);
      const hit = this._data.records.find(r => range.includes(r.key));
      return hit ? clone(hit.value) : undefined;
    });
  }
  getAll(query, count) {
    return this._tx._request(this, () => {
      const range = toRange(query);
      const list = this._data.records.filter(r => !range || range.includes(r.key)).map(r => clone(r.value));
      return count ? list.slice(0, count) : list;
    });
  }
  getAllKeys(query, count) {
    return this._tx._request(this, () => {
      const range = toRange(query);
      const list = this._data.records.filter(r => !range || range.includes(r.key)).map(r => r.key);
      return count ? list.slice(0, count) : list;
    });
  }
  count(query) {
    return this._tx._request(this, () => {
      const range = toRange(query);
      return this._data.records.filter(r => !range || range.includes(r.key)).length;
    });
  }
  delete(query) {
    this._tx._assertWritable();
    return this._tx._request(this, () => {
      const range = toRange(query);
      this._data.records = this._data.records.filter(r => !range.includes(r.key));
      return undefined;
    });
  }
  clear() {
    this._tx._assertWritable();
    return this._tx._request(this, () => {
      this._data.records = [];
      return undefined;
    });
  }
  openCursor(query, direction) {
    const entries = () => {
      const range = toRange(query);
      const list = this._data.records.filter(r => !range || range.includes(r.key)).map(r => ({ key: r.key, value: r.value }));
      return direction === 'prev' || direction === 'prevunique' ? list.reverse() : list;
    };
    return this._openCursor(this, entries);
  }
  _openCursor(source, entries) {
    let cursor = null;
    const req = this._tx._request(source, () => {
      const list = entries();
      if (!list.length) return null;
      cursor = new FakeCursor(req, list, this);
      return cursor;
    });
    return req;
  }
}

class FakeTransaction {
  constructor(db, names, mode, versionChange) {
    this.db = db;
    this.mode = mode || 'readonly';
    this.objectStoreNames = names.slice();
    this._versionChange = !!versionChange;
    this._queue = [];
    this._state = 'pending'; // pending -> active -> committing -> done
    this._snapshots = new Map();
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }
  objectStore(name) {
    if (!this.objectStoreNames.includes(name)) throw domError('NotFoundError', 'store not in transaction scope: ' + name);
    const data = this.db._stores.get(name);
    if (!data) throw domError('NotFoundError', 'no store named ' + name);
    return new FakeObjectStore(this, data);
  }
  _assertWritable() {
    if (this.mode === 'readonly') throw domError('ReadOnlyError', 'transaction is read-only');
  }
  _assertActive() {
    if (this._state === 'done' || this._state === 'committing') {
      throw domError('TransactionInactiveError', 'transaction has finished');
    }
  }
  _request(source, op) {
    this._assertActive();
    const req = new FakeRequest(source, this);
    this._queue.push({ req, op });
    this.db._kick();
    return req;
  }
  _reissue(req, op) {
    this._assertActive();
    req.readyState = 'pending';
    this._queue.push({ req, op });
    this.db._kick();
  }
  abort() {
    if (this._state === 'done') throw domError('InvalidStateError', 'transaction already finished');
    this._abort(domError('AbortError', 'transaction aborted'));
  }
  _begin() {
    this._state = 'active';
    for (const name of this.objectStoreNames) {
      const data = this.db._stores.get(name);
      if (data) this._snapshots.set(name, data.snapshot());
    }
  }
  _abort(error) {
    if (this._state === 'done') return;
    for (const [name, snap] of this._snapshots) {
      const data = this.db._stores.get(name);
      if (data) data.restore(snap);
    }
    this._state = 'done';
    this.error = error;
    this._queue = [];
    const ev = { target: this, type: 'abort' };
    setImmediate(() => {
      if (typeof this.onabort === 'function') this.onabort(ev);
      this.db._finished(this);
    });
  }
  _commit() {
    this._state = 'done';
    setImmediate(() => {
      if (typeof this.oncomplete === 'function') this.oncomplete({ target: this, type: 'complete' });
      this.db._finished(this);
    });
  }
}

class FakeDatabase {
  constructor(factory, name, version) {
    this._factory = factory;
    this.name = name;
    this.version = version;
    this._stores = factory._data(name).stores;
    this._pending = [];
    this._running = null;
    this._closed = false;
    this.onversionchange = null;
    this.onclose = null;
  }
  get objectStoreNames() {
    const names = Array.from(this._stores.keys()).sort();
    return { contains: n => names.includes(n), length: names.length, item: i => names[i], [Symbol.iterator]: () => names[Symbol.iterator]() };
  }
  createObjectStore(name, options = {}) {
    if (!this._upgradeTx) throw domError('InvalidStateError', 'createObjectStore outside an upgrade');
    if (this._stores.has(name)) throw domError('ConstraintError', 'store exists: ' + name);
    const data = new StoreData(name, options.keyPath, options.autoIncrement);
    this._stores.set(name, data);
    this._upgradeTx.objectStoreNames.push(name);
    return new FakeObjectStore(this._upgradeTx, data);
  }
  deleteObjectStore(name) {
    if (!this._upgradeTx) throw domError('InvalidStateError', 'deleteObjectStore outside an upgrade');
    this._stores.delete(name);
  }
  transaction(names, mode) {
    if (this._closed) throw domError('InvalidStateError', 'database is closed');
    const list = Array.isArray(names) ? names : [names];
    list.forEach(n => {
      if (!this._stores.has(n)) throw domError('NotFoundError', 'no store named ' + n);
    });
    const tx = new FakeTransaction(this, list, mode, false);
    this._pending.push(tx);
    this._kick();
    return tx;
  }
  close() {
    this._closed = true;
  }
  // Transactions run strictly one at a time. That is stricter than a real
  // browser (which only serializes overlapping read-write scopes) and gives
  // the same guarantees the storage layer relies on.
  _kick() {
    if (this._scheduled) return;
    this._scheduled = true;
    setImmediate(() => {
      this._scheduled = false;
      this._pump();
    });
  }
  _pump() {
    if (!this._running) {
      const next = this._pending.shift();
      if (!next) return;
      this._running = next;
      next._begin();
    }
    const tx = this._running;
    if (tx._state !== 'active') return;
    const item = tx._queue.shift();
    if (!item) {
      tx._state = 'committing';
      tx._commit();
      return;
    }
    const { req, op } = item;
    let result;
    let error = null;
    try {
      result = op();
    } catch (err) {
      error = err;
    }
    req.readyState = 'done';
    if (error) {
      req.error = error;
      let prevented = false;
      const ev = { target: req, type: 'error', preventDefault() { prevented = true; }, stopPropagation() {} };
      if (typeof req.onerror === 'function') req.onerror(ev);
      if (!prevented && typeof tx.onerror === 'function') tx.onerror(ev);
      if (!prevented) {
        tx._abort(error);
        return;
      }
    } else {
      req.result = result;
      if (typeof req.onsuccess === 'function') req.onsuccess({ target: req, type: 'success' });
    }
    this._kick();
  }
  _finished(tx) {
    if (this._running === tx) this._running = null;
    if (this._upgradeTx === tx) this._upgradeTx = null;
    this._kick();
  }
}

class FakeFactory {
  constructor() {
    this._dbs = new Map(); // name -> { version, stores }
    this.openCount = 0;
    this.failNextOpen = null;
  }
  _data(name) {
    if (!this._dbs.has(name)) this._dbs.set(name, { version: 0, stores: new Map() });
    return this._dbs.get(name);
  }
  open(name, version) {
    const req = new FakeRequest(null, null);
    req.onupgradeneeded = null;
    req.onblocked = null;
    this.openCount++;
    setImmediate(() => {
      if (this.failNextOpen) {
        const err = this.failNextOpen;
        this.failNextOpen = null;
        req.error = err;
        req.readyState = 'done';
        if (typeof req.onerror === 'function') req.onerror({ target: req, type: 'error', preventDefault() {} });
        return;
      }
      const data = this._data(name);
      const oldVersion = data.version;
      const newVersion = version === undefined ? Math.max(1, oldVersion) : version;
      if (newVersion < oldVersion) {
        req.error = domError('VersionError', 'requested version is lower than the current one');
        req.readyState = 'done';
        if (typeof req.onerror === 'function') req.onerror({ target: req, type: 'error', preventDefault() {} });
        return;
      }
      const db = new FakeDatabase(this, name, newVersion);
      req.result = db;
      if (newVersion > oldVersion) {
        const tx = new FakeTransaction(db, Array.from(db._stores.keys()), 'versionchange', true);
        db._upgradeTx = tx;
        tx._begin();
        req.transaction = tx;
        data.version = newVersion;
        try {
          if (typeof req.onupgradeneeded === 'function') {
            req.onupgradeneeded({ target: req, oldVersion, newVersion, type: 'upgradeneeded' });
          }
        } catch (err) {
          tx._abort(err);
          data.version = oldVersion;
          req.error = err;
          if (typeof req.onerror === 'function') req.onerror({ target: req, type: 'error', preventDefault() {} });
          return;
        }
        // The upgrade transaction runs through the same queue so requests
        // issued inside onupgradeneeded complete before onsuccess.
        db._running = tx;
        tx.oncomplete = () => {
          req.transaction = null;
          req.readyState = 'done';
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req, type: 'success' });
        };
        db._kick();
        return;
      }
      req.readyState = 'done';
      if (typeof req.onsuccess === 'function') req.onsuccess({ target: req, type: 'success' });
    });
    return req;
  }
  deleteDatabase(name) {
    const req = new FakeRequest(null, null);
    setImmediate(() => {
      this._dbs.delete(name);
      req.readyState = 'done';
      if (typeof req.onsuccess === 'function') req.onsuccess({ target: req, type: 'success' });
    });
    return req;
  }
  cmp(a, b) {
    return cmp(a, b);
  }
}

let previous = null;

function installMockIDB() {
  previous = { indexedDB: global.indexedDB, IDBKeyRange: global.IDBKeyRange };
  const factory = new FakeFactory();
  global.indexedDB = factory;
  global.IDBKeyRange = FakeKeyRange;
  return factory;
}

function uninstallMockIDB() {
  if (!previous) return;
  if (previous.indexedDB === undefined) delete global.indexedDB; else global.indexedDB = previous.indexedDB;
  if (previous.IDBKeyRange === undefined) delete global.IDBKeyRange; else global.IDBKeyRange = previous.IDBKeyRange;
  previous = null;
}

module.exports = {
  installMockIDB,
  uninstallMockIDB,
  FakeFactory,
  FakeKeyRange,
  compareKeys: cmp
};
