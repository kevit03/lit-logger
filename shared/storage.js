// Shared storage manager for LIT (Locked In Tracker).
//
// Where everything lives
//
//   Logs              IndexedDB (shared/db.js) in extension-origin contexts: the
//                     popup and the service worker. One record per entry,
//                     indexed by account, date, tracker, company, and time, so
//                     a +1 writes one record instead of rewriting the history.
//                     If IndexedDB cannot be opened, logs fall back to month
//                     shards in chrome.storage.local ('pt_logs__m_YYYY-MM').
//   Daily aggregates  Per-account, per-month day totals kept in step with the
//                     logs ('daily_aggregates' in IndexedDB, or
//                     'pt_daily_aggregates__YYYY-MM' in the fallback). Badges,
//                     streaks, and charts read these, never the raw logs.
//   Content scripts   A content script's own indexedDB belongs to the host
//                     page's origin, so the calendar overlay and the
//                     auto-trackers proxy every log call to the service worker
//                     (serveRemote). Tracker and theme calls stay local.
//   Trackers, theme,  chrome.storage.sync. Small, and they follow the user to
//   preferences       every device signed into the same Chrome profile.
//   Change events     Every log write bumps chrome.storage.local['pt_logs_rev'],
//                     which fans out to every open context through
//                     chrome.storage.onChanged.
//
// Older builds kept logs in chrome.storage.sync chunks ('logs__meta',
// 'logs__c0', ...), a local overflow ('logs_overflow'), or a plain local
// 'logs' array. The first run of this build on a device imports them once;
// local copies are archived under 'pt_legacy_logs_archive'.
const TrackerStorage = (() => {
  const STORAGE_KEYS = {
    LOGS: 'logs',
    METRICS: 'metrics',
    AUTH: 'pt_auth_user',
    VISIBLE_METRICS: 'pt_visible_metrics',
    THEME: 'pt_theme',
    PREFS: 'pt_prefs',
    ACTIVE_METRIC: 'pt_active_metric',
    LOGS_REV: 'pt_logs_rev'
  };

  const LEGACY_KEYS = {
    META: 'logs__meta',
    CHUNK_PREFIX: 'logs__c',
    OVERFLOW: 'logs_overflow',
    LOCAL: 'logs',
    ARCHIVE: 'pt_legacy_logs_archive',
    SYNC_MIGRATED: 'pt_logs_migrated'
  };

  const LOCAL_BACKEND_KEYS = {
    INDEX: 'pt_logs__index',
    SHARD_PREFIX: 'pt_logs__m_',
    AGG_PREFIX: 'pt_daily_aggregates__',
    SETTING_PREFIX: 'pt_store_setting__',
    SNAPSHOTS: 'pt_snapshots'
  };

  const MIGRATION_SETTING = 'legacy_migration_v2';
  const LAST_AUTO_SNAPSHOT_SETTING = 'last_auto_snapshot_at';
  const REMOTE_MESSAGE = 'PT_STORAGE_CALL';

  // Application pipeline. Only job entries carry a status.
  const STATUSES = [
    { id: 'applied', label: 'Applied', short: 'Applied' },
    { id: 'review', label: 'Under Review', short: 'Review' },
    { id: 'interviewing', label: 'Interviewing', short: 'Interview' },
    { id: 'offer', label: 'Offer', short: 'Offer' },
    { id: 'rejected', label: 'Archived / Rejected', short: 'Closed' }
  ];
  const STATUS_IDS = STATUSES.map(s => s.id);

  const LOG_SOURCES = ['manual', 'auto', 'calendar', 'shortcut', 'quick', 'import'];

  const DUPLICATE_WINDOW_DAYS = 90;
  const SNAPSHOT_RETAIN = 4;
  const SNAPSHOT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
  // Other devices still on an older build read history from the legacy sync
  // chunks. They are left in place this long after the first device migrates,
  // then freed so trackers and layout keep their share of the sync quota.
  const LEGACY_SYNC_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

  const PREF_DEFAULTS = {
    timerSound: true,
    timerDesktop: true,
    universalTracking: false,
    digestDismissedWeek: '',
    duplicateWarnings: true
  };

  function formatSecondsToMMSS(totalSeconds) {
    const s = Math.max(0, parseInt(totalSeconds, 10) || 0);
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // Upper bound for the solve timer. A free-text field must never be able to
  // arm a countdown longer than a day (or a negative one).
  const MAX_TIMER_SECONDS = 86400;

  function parseStringToSeconds(str) {
    if (!str || typeof str !== 'string') return 0;
    const trimmed = str.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = parseInt(trimmed, 10);
      return Math.min(MAX_TIMER_SECONDS, n <= 300 ? n * 60 : n);
    }
    // Every component must be a plain unsigned integer. "-5:30" or "1:2:3:4"
    // are rejected outright rather than silently producing a negative duration.
    const rawParts = trimmed.split(':');
    if (rawParts.length !== 2 && rawParts.length !== 3) return 0;
    if (!rawParts.every(p => /^\d+$/.test(p.trim()))) return 0;
    const parts = rawParts.map(p => parseInt(p.trim(), 10));
    const total = parts.length === 2
      ? parts[0] * 60 + parts[1]
      : parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (!isFinite(total) || total <= 0) return 0;
    return Math.min(MAX_TIMER_SECONDS, total);
  }

  const DEFAULT_METRICS = [
    {
      id: 'jobs',
      name: 'Job Applications',
      color: '#1a73e8',
      icon: 'briefcase',
      unit: 'jobs',
      dailyGoal: 5,
      isDefault: true,
      createdAt: '2026-09-01T00:00:00.000Z'
    },
    {
      id: 'leetcode',
      name: 'LeetCode',
      color: '#1e8e3e',
      icon: 'code',
      unit: 'problems',
      dailyGoal: 2,
      isDefault: true,
      createdAt: '2026-09-01T00:00:00.000Z'
    }
  ];

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  function lastError() {
    try {
      return typeof chrome !== 'undefined' && chrome && chrome.runtime ? chrome.runtime.lastError : null;
    } catch (e) {
      return null;
    }
  }

  function normalizeEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const trimmed = email.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
  }

  // Index key for an account. Signed-out entries get '' because IndexedDB
  // does not index null.
  function userKeyOf(email) {
    return normalizeEmail(email) || '';
  }

  function getLocalDateStr(d = new Date()) {
    const date = new Date(d);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseLocalDateToNoon(dateStr) {
    if (!dateStr) return new Date();
    const parts = dateStr.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
  }

  function addDays(dateStrOrDate, n) {
    const d = typeof dateStrOrDate === 'string'
      ? parseLocalDateToNoon(dateStrOrDate)
      : new Date(dateStrOrDate.getFullYear(), dateStrOrDate.getMonth(), dateStrOrDate.getDate(), 12, 0, 0);
    d.setDate(d.getDate() + n);
    return getLocalDateStr(d);
  }

  function isDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1) return false;
    return d <= new Date(y, m, 0).getDate();
  }

  function monthOf(dateStr) {
    return String(dateStr).slice(0, 7);
  }

  function isMonthStr(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
  }

  // Whole days from a to b (both YYYY-MM-DD), DST-proof by anchoring at noon.
  function daysBetween(a, b) {
    const ms = parseLocalDateToNoon(b).getTime() - parseLocalDateToNoon(a).getTime();
    return Math.round(ms / 86400000);
  }

  // Monday of the week containing dateStr.
  function weekStartOf(dateStr) {
    const d = parseLocalDateToNoon(dateStr || getLocalDateStr());
    const offset = (d.getDay() + 6) % 7;
    return addDays(getLocalDateStr(d), -offset);
  }

  function defaultGoalFor(metricId) {
    if (metricId === 'jobs') return 5;
    if (metricId === 'leetcode') return 2;
    return 1;
  }

  // A streak day is a day the DAILY GOAL was met, not merely a day with an
  // entry. Logging one application against a goal of five keeps the count
  // moving but does not extend the streak.
  function goalMetOn(dailyMap, dateStr, metricId, goal) {
    const value = ((dailyMap || {})[dateStr] || {})[metricId];
    return (value || 0) >= Math.max(1, goal || 1);
  }

  // Consecutive goal-met days ending today, or ending yesterday when today's
  // goal is still open, so a streak is not shown as broken before the day is.
  function computeCurrentStreak(dailyMap, metricId, goal, todayStr) {
    let check = todayStr || getLocalDateStr();
    if (!goalMetOn(dailyMap, check, metricId, goal)) check = addDays(check, -1);
    let streak = 0;
    while (goalMetOn(dailyMap, check, metricId, goal)) {
      streak++;
      check = addDays(check, -1);
    }
    return streak;
  }

  function computeLongestStreak(dailyMap, metricId, goal) {
    const dates = Object.keys(dailyMap || {}).filter(d => goalMetOn(dailyMap, d, metricId, goal)).sort();
    let best = 0;
    let run = 0;
    let prev = null;
    dates.forEach(d => {
      run = prev && addDays(prev, 1) === d ? run + 1 : 1;
      if (run > best) best = run;
      prev = d;
    });
    return best;
  }

  // "Acme, Inc." / "ACME Corp" / "acme careers" all normalize to "acme", which
  // is what the duplicate-application warning keys on.
  const COMPANY_NOISE = /\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|bv|pty|careers?|jobs?|hiring|recruiting|the)\b/g;

  function normalizeCompany(name) {
    const base = String(name || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    if (!base) return '';
    const stripped = base.replace(COMPANY_NOISE, ' ').replace(/\s+/g, '').trim();
    return (stripped || base.replace(/\s+/g, '')).slice(0, 120);
  }

  function normalizeStatus(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    if (STATUS_IDS.includes(v)) return v;
    if (v === 'under review' || v === 'screening') return 'review';
    if (v === 'interview' || v === 'interviews') return 'interviewing';
    if (v === 'archived' || v === 'closed' || v === 'declined') return 'rejected';
    return null;
  }

  // Moves a job record to a new stage in place. Leaving Applied stamps when
  // the reply came in; going back to Applied clears it.
  function applyStatus(next, cur, value, nowIso) {
    if (next.metricId !== 'jobs') return;
    const status = normalizeStatus(value);
    const prev = normalizeStatus(cur.status) || 'applied';
    if (!status || status === prev) return;
    next.status = status;
    next.statusUpdatedAt = nowIso;
    if (status === 'applied') delete next.respondedAt;
    else if (!next.respondedAt) next.respondedAt = nowIso;
  }

  function statusLabel(id) {
    const s = STATUSES.find(x => x.id === id);
    return s ? s.label : '';
  }

  function cleanText(value, max) {
    return String(value === null || value === undefined ? '' : value).trim().slice(0, max || 2000);
  }

  function cleanUrl(value) {
    const s = cleanText(value, 600);
    return /^https?:\/\//i.test(s) ? s : '';
  }

  function countOf(rec) {
    return Math.max(1, parseInt(rec && rec.count, 10) || 1);
  }

  function timeOf(rec) {
    const t = new Date(rec.timestamp || rec.date || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // Newest first; ties (same timestamp) fall back to reverse insertion order,
  // so the entry added last is the one undo removes.
  function compareNewestFirst(a, b) {
    const diff = timeOf(b) - timeOf(a);
    if (diff !== 0) return diff;
    return (b._seq || 0) - (a._seq || 0);
  }

  let seqCounter = 0;
  function nextSeq() {
    seqCounter = (seqCounter + 1) % 1000;
    return Date.now() * 1000 + seqCounter;
  }

  function newLogId() {
    return 'log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
  }

  // Stored record: the public entry plus internal index fields.
  function toRecord(log, seq) {
    const rec = Object.assign({}, log);
    rec._uk = userKeyOf(log.userEmail);
    rec._ck = normalizeCompany(log.company);
    rec._seq = typeof seq === 'number' ? seq : nextSeq();
    return rec;
  }

  // Public entry: internal fields stripped, and job entries from before the
  // pipeline existed read as 'applied'.
  function fromRecord(rec) {
    if (!rec) return rec;
    const out = {};
    Object.keys(rec).forEach(k => {
      if (k.charAt(0) !== '_') out[k] = rec[k];
    });
    if (out.metricId === 'jobs' && !normalizeStatus(out.status)) out.status = 'applied';
    return out;
  }

  function isValidRecord(r) {
    return !!r && typeof r === 'object' && typeof r.id === 'string' && r.id.length > 0 &&
      typeof r.metricId === 'string' && isDateStr(r.date);
  }

  function matchesFilter(rec, f) {
    if (!isValidRecord(rec)) return false;
    if (f.userKey !== undefined && rec._uk !== f.userKey) return false;
    if (f.metricId && rec.metricId !== f.metricId) return false;
    if (f.startDate && rec.date < f.startDate) return false;
    if (f.endDate && rec.date > f.endDate) return false;
    if (f.companyKey && rec._ck !== f.companyKey) return false;
    if (f.sourceId && rec.sourceId !== f.sourceId) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Daily aggregates
  // ---------------------------------------------------------------------------
  function aggKeyOf(userKey, month) {
    return userKey + '|' + month;
  }

  function emptyAgg(userKey, month) {
    return { key: aggKeyOf(userKey, month), userKey, month, days: {}, logCount: 0 };
  }

  // Folds [record, +1 | -1] pairs into one delta per (account, month), so a
  // transaction touches each aggregate record exactly once.
  function aggDeltas(pairs) {
    const map = new Map();
    pairs.forEach(([rec, sign]) => {
      if (!isValidRecord(rec)) return;
      const month = monthOf(rec.date);
      const key = aggKeyOf(rec._uk || '', month);
      let d = map.get(key);
      if (!d) {
        d = emptyAgg(rec._uk || '', month);
        map.set(key, d);
      }
      const day = d.days[rec.date] || (d.days[rec.date] = {});
      day[rec.metricId] = (day[rec.metricId] || 0) + sign * countOf(rec);
      d.logCount += sign;
    });
    return map;
  }

  function mergeAgg(target, delta) {
    Object.keys(delta.days).forEach(date => {
      const add = delta.days[date];
      const day = Object.assign({}, target.days[date] || {});
      Object.keys(add).forEach(metricId => {
        const next = (day[metricId] || 0) + add[metricId];
        if (next > 0) day[metricId] = next; else delete day[metricId];
      });
      if (Object.keys(day).length) target.days[date] = day; else delete target.days[date];
    });
    target.logCount = Math.max(0, (target.logCount || 0) + delta.logCount);
    return target;
  }

  function aggIsEmpty(agg) {
    return (!agg.logCount || agg.logCount <= 0) && Object.keys(agg.days || {}).length === 0;
  }

  // Aggregate for one month shard of the local fallback: { userKey: { days, logCount } }.
  function aggregateShard(records) {
    const out = {};
    aggDeltas(records.map(r => [r, 1])).forEach(d => {
      out[d.userKey] = { days: d.days, logCount: d.logCount };
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // IndexedDB backend
  // ---------------------------------------------------------------------------
  function createIdbBackend(db) {
    const LOGS = db.STORES.LOGS;
    const AGG = db.STORES.AGGREGATES;
    const SETTINGS = db.STORES.SETTINGS;
    const SNAPSHOTS = db.STORES.SNAPSHOTS;
    const KR = () => db.keyRange();
    const HIGH = '\uffff';

    function applyDeltas(aggStore, deltas) {
      deltas.forEach(delta => {
        const req = aggStore.get(delta.key);
        req.onsuccess = () => {
          const cur = req.result || emptyAgg(delta.userKey, delta.month);
          mergeAgg(cur, delta);
          if (aggIsEmpty(cur)) aggStore.delete(delta.key);
          else aggStore.put(cur);
        };
      });
    }

    return {
      name: 'indexeddb',

      add(rec) {
        return db.run([LOGS, AGG], 'readwrite', (s, out) => {
          s[LOGS].add(rec).onsuccess = () => {
            applyDeltas(s[AGG], aggDeltas([[rec, 1]]));
            out.value = rec;
          };
        });
      },

      get(id) {
        return db.get(LOGS, id);
      },

      // fn(current) returns { record } to write, or { status } to leave it.
      update(id, fn) {
        return db.run([LOGS, AGG], 'readwrite', (s, out) => {
          const req = s[LOGS].get(id);
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) { out.value = { status: 'missing' }; return; }
            const res = fn(cur);
            if (!res || !res.record) { out.value = res || { status: 'noop' }; return; }
            const next = res.record;
            s[LOGS].put(next).onsuccess = () => {
              applyDeltas(s[AGG], aggDeltas([[cur, -1], [next, 1]]));
              out.value = { status: 'updated', before: cur, after: next };
            };
          };
        });
      },

      remove(id, guard) {
        return db.run([LOGS, AGG], 'readwrite', (s, out) => {
          const req = s[LOGS].get(id);
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) { out.value = { status: 'missing' }; return; }
            if (guard && !guard(cur)) { out.value = { status: 'denied', record: cur }; return; }
            s[LOGS].delete(id).onsuccess = () => {
              applyDeltas(s[AGG], aggDeltas([[cur, -1]]));
              out.value = { status: 'deleted', record: cur };
            };
          };
        });
      },

      // Find-and-delete in one transaction, so two undos can never pick the
      // same entry or remove one that a concurrent add just made newest.
      removeLatest({ userKey, metricId, date }) {
        return db.run([LOGS, AGG], 'readwrite', (s, out) => {
          const req = s[LOGS].index('user_metric_date').getAll(KR().only([userKey, metricId, date]));
          req.onsuccess = () => {
            const list = (req.result || []).filter(isValidRecord);
            if (!list.length) { out.value = null; return; }
            list.sort(compareNewestFirst);
            const target = list[0];
            s[LOGS].delete(target.id).onsuccess = () => {
              applyDeltas(s[AGG], aggDeltas([[target, -1]]));
              out.value = target;
            };
          };
        });
      },

      query(filter) {
        const f = filter || {};
        const uk = f.userKey;
        return db.run(LOGS, 'readonly', (s, out) => {
          const store = s[LOGS];
          let req;
          if (uk === undefined) {
            req = store.getAll();
          } else if (f.sourceId) {
            req = store.index('user_source').getAll(KR().only([uk, f.sourceId]));
          } else if (f.companyKey) {
            req = store.index('user_company').getAll(KR().only([uk, f.companyKey]));
          } else if (f.metricId) {
            req = store.index('user_metric_date').getAll(KR().bound(
              [uk, f.metricId, f.startDate || ''],
              [uk, f.metricId, f.endDate || HIGH]
            ));
          } else {
            req = store.index('user_date').getAll(KR().bound([uk, f.startDate || ''], [uk, f.endDate || HIGH]));
          }
          req.onsuccess = () => {
            out.value = (req.result || []).filter(r => matchesFilter(r, f));
          };
        });
      },

      aggregates(userKey) {
        return db.getAll(AGG, 'userEmail', KR().only(userKey)).then(list => list
          .filter(a => a && isMonthStr(a.month))
          .map(a => ({ month: a.month, days: a.days || {}, logCount: a.logCount || 0 })));
      },

      // Idempotent by id: anything already stored is skipped, and only the
      // new records are counted into the aggregates.
      bulkAdd(records) {
        return db.run([LOGS, AGG], 'readwrite', (s, out) => {
          const keysReq = s[LOGS].getAllKeys();
          keysReq.onsuccess = () => {
            const existing = new Set(keysReq.result || []);
            const fresh = [];
            records.forEach(r => {
              if (!isValidRecord(r) || existing.has(r.id)) return;
              existing.add(r.id);
              fresh.push(r);
            });
            fresh.forEach(r => s[LOGS].put(r));
            applyDeltas(s[AGG], aggDeltas(fresh.map(r => [r, 1])));
            out.value = fresh.length;
          };
        });
      },

      getMany(ids) {
        return db.run(LOGS, 'readonly', (s, out) => {
          const found = new Map();
          out.value = found;
          ids.forEach(id => {
            if (typeof id !== 'string' || !id) return;
            s[LOGS].get(id).onsuccess = e => {
              if (e.target.result) found.set(id, e.target.result);
            };
          });
        });
      },

      all() {
        return db.getAll(LOGS).then(list => list.filter(isValidRecord));
      },

      countAll() {
        return db.count(LOGS);
      },

      rebuildAggregates() {
        return db.run([LOGS, AGG], 'readwrite', (s, out) => {
          s[AGG].clear();
          const req = s[LOGS].getAll();
          req.onsuccess = () => {
            const deltas = aggDeltas((req.result || []).map(r => [r, 1]));
            deltas.forEach(d => {
              const clean = mergeAgg(emptyAgg(d.userKey, d.month), d);
              if (!aggIsEmpty(clean)) s[AGG].put(clean);
            });
            out.value = deltas.size;
          };
        });
      },

      settingsGet(key) {
        return db.get(SETTINGS, key).then(r => (r ? r.value : null));
      },

      settingsSet(key, value) {
        return db.put(SETTINGS, { key, value }).then(() => value);
      },

      snapshotPut(snapshot) {
        return db.put(SNAPSHOTS, snapshot);
      },

      snapshotGet(id) {
        return db.get(SNAPSHOTS, id);
      },

      snapshotDelete(id) {
        return db.remove(SNAPSHOTS, id);
      },

      snapshotList() {
        return db.getAll(SNAPSHOTS).then(list => list.map(snapshotMeta));
      }
    };
  }

  // ---------------------------------------------------------------------------
  // chrome.storage.local fallback backend
  // ---------------------------------------------------------------------------
  // Logs are sharded by month so a write rewrites one month, not the whole
  // history. Each shard is written together with its month's aggregate, and
  // both are recomputed from the shard on every write, so whichever context's
  // write lands, the aggregate matches the logs beside it. chrome.storage has
  // no compare-and-swap and every context loads its own copy of this module,
  // so each write is read back and re-applied if another context clobbered it.
  const MAX_WRITE_ATTEMPTS = 5;

  function createLocalBackend(area) {
    const K = LOCAL_BACKEND_KEYS;
    const shardKey = m => K.SHARD_PREFIX + m;
    const aggKey = m => K.AGG_PREFIX + m;

    function get(keys) {
      return new Promise(resolve => {
        try {
          area.get(keys, result => {
            if (lastError()) { resolve({}); return; }
            resolve(result || {});
          });
        } catch (e) {
          resolve({});
        }
      });
    }

    function set(items) {
      return new Promise(resolve => {
        try {
          area.set(items, () => resolve(!lastError()));
        } catch (e) {
          resolve(false);
        }
      });
    }

    function remove(keys) {
      return new Promise(resolve => {
        try {
          if (typeof area.remove !== 'function') { resolve(); return; }
          area.remove(keys, () => { void lastError(); resolve(); });
        } catch (e) {
          resolve();
        }
      });
    }

    function cleanShard(value) {
      return Array.isArray(value) ? value.filter(isValidRecord) : [];
    }

    async function readIndex() {
      const r = await get([K.INDEX]);
      const v = r[K.INDEX];
      const months = v && Array.isArray(v.months) ? v.months.filter(isMonthStr) : [];
      return Array.from(new Set(months)).sort();
    }

    async function readShard(month) {
      const r = await get([shardKey(month)]);
      return cleanShard(r[shardKey(month)]);
    }

    async function readShards(months) {
      if (!months.length) return new Map();
      const r = await get(months.map(shardKey));
      const out = new Map();
      months.forEach(m => out.set(m, cleanShard(r[shardKey(m)])));
      return out;
    }

    // apply(currentLogs, alreadyWrote) returns
    //   { write: false }                                  nothing to do
    //   { write: true, logs, verify(readBack) }           write and confirm
    async function mutateMonth(month, apply) {
      let wrote = false;
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const logs = await readShard(month);
        const plan = apply(logs, wrote);
        if (!plan || !plan.write) return;
        const ok = await set({ [shardKey(month)]: plan.logs, [aggKey(month)]: aggregateShard(plan.logs) });
        if (!ok) throw new Error('Could not write to chrome.storage.local');
        wrote = true;
        if (plan.verify(await readShard(month))) return;
      }
    }

    // Months are only ever added to the index, so re-reading and re-adding
    // converges even with several contexts adding months at once.
    async function ensureIndexed(months) {
      const wanted = Array.from(new Set(months.filter(isMonthStr)));
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
        const current = await readIndex();
        const missing = wanted.filter(m => !current.includes(m));
        if (!missing.length) return;
        await set({ [K.INDEX]: { months: current.concat(missing).sort() } });
      }
    }

    async function locate(id) {
      const months = (await readIndex()).reverse();
      for (const m of months) {
        const logs = await readShard(m);
        if (logs.some(r => r.id === id)) return m;
      }
      return null;
    }

    async function allRecords() {
      const shards = await readShards(await readIndex());
      const out = [];
      const seen = new Set();
      shards.forEach(list => list.forEach(r => {
        if (seen.has(r.id)) return;
        seen.add(r.id);
        out.push(r);
      }));
      return out;
    }

    const backend = {
      name: 'chrome.storage.local',

      async add(rec) {
        const month = monthOf(rec.date);
        const has = list => list.some(r => r.id === rec.id);
        await mutateMonth(month, logs => (has(logs)
          ? { write: false }
          : { write: true, logs: logs.concat([rec]), verify: has }));
        await ensureIndexed([month]);
        return rec;
      },

      async get(id) {
        const month = await locate(id);
        if (!month) return null;
        return (await readShard(month)).find(r => r.id === id) || null;
      },

      async update(id, fn) {
        const month = await locate(id);
        if (!month) return { status: 'missing' };
        let outcome = { status: 'missing' };
        await mutateMonth(month, (logs, wrote) => {
          const cur = logs.find(r => r.id === id);
          if (!cur) {
            if (!wrote) outcome = { status: 'missing' };
            return { write: false };
          }
          const res = fn(cur);
          if (!res || !res.record) {
            outcome = res || { status: 'noop' };
            return { write: false };
          }
          const next = res.record;
          if (monthOf(next.date) !== month) {
            outcome = { status: 'moved', before: cur, after: next };
            return { write: false };
          }
          outcome = { status: 'updated', before: cur, after: next };
          const expected = JSON.stringify(next);
          return {
            write: true,
            logs: logs.map(r => (r.id === id ? next : r)),
            verify: list => list.some(r => r.id === id && JSON.stringify(r) === expected)
          };
        });
        if (outcome.status === 'moved') {
          // Add to the new month first: a crash in between leaves a duplicate
          // (collapsed by id on read), never a lost entry.
          await backend.add(outcome.after);
          await mutateMonth(month, logs => (logs.some(r => r.id === id)
            ? { write: true, logs: logs.filter(r => r.id !== id), verify: list => !list.some(r => r.id === id) }
            : { write: false }));
          outcome = { status: 'updated', before: outcome.before, after: outcome.after };
        }
        return outcome;
      },

      async remove(id, guard) {
        const month = await locate(id);
        if (!month) return { status: 'missing' };
        let outcome = { status: 'missing' };
        await mutateMonth(month, (logs, wrote) => {
          const cur = logs.find(r => r.id === id);
          if (!cur) {
            if (!wrote) outcome = { status: 'missing' };
            return { write: false };
          }
          if (guard && !guard(cur)) {
            outcome = { status: 'denied', record: cur };
            return { write: false };
          }
          outcome = { status: 'deleted', record: cur };
          return { write: true, logs: logs.filter(r => r.id !== id), verify: list => !list.some(r => r.id === id) };
        });
        return outcome;
      },

      async removeLatest({ userKey, metricId, date }) {
        let removed = null;
        await mutateMonth(monthOf(date), (logs, wrote) => {
          const candidates = logs.filter(r => r._uk === userKey && r.metricId === metricId && r.date === date);
          if (!candidates.length) {
            if (!wrote) removed = null;
            return { write: false };
          }
          candidates.sort(compareNewestFirst);
          const target = candidates[0];
          removed = target;
          return { write: true, logs: logs.filter(r => r.id !== target.id), verify: list => !list.some(r => r.id === target.id) };
        });
        return removed;
      },

      async query(filter) {
        const f = filter || {};
        let months = await readIndex();
        if (f.startDate) months = months.filter(m => m >= monthOf(f.startDate));
        if (f.endDate) months = months.filter(m => m <= monthOf(f.endDate));
        const shards = await readShards(months);
        const out = [];
        const seen = new Set();
        shards.forEach(list => list.forEach(r => {
          if (seen.has(r.id) || !matchesFilter(r, f)) return;
          seen.add(r.id);
          out.push(r);
        }));
        return out;
      },

      async aggregates(userKey) {
        const months = await readIndex();
        if (!months.length) return [];
        const r = await get(months.map(aggKey));
        const out = [];
        const repaired = {};
        for (const m of months) {
          let agg = r[aggKey(m)];
          if (!agg || typeof agg !== 'object' || Array.isArray(agg)) {
            // Missing or damaged: rebuild this month from its shard.
            agg = aggregateShard(await readShard(m));
            repaired[aggKey(m)] = agg;
          }
          const mine = agg[userKey];
          if (mine && typeof mine === 'object') {
            out.push({ month: m, days: mine.days || {}, logCount: mine.logCount || 0 });
          }
        }
        if (Object.keys(repaired).length) await set(repaired);
        return out;
      },

      async bulkAdd(records) {
        const valid = records.filter(isValidRecord);
        if (!valid.length) return 0;
        const existing = new Set((await allRecords()).map(r => r.id));
        const byMonth = new Map();
        valid.forEach(r => {
          if (existing.has(r.id)) return;
          existing.add(r.id);
          const m = monthOf(r.date);
          if (!byMonth.has(m)) byMonth.set(m, []);
          byMonth.get(m).push(r);
        });
        let added = 0;
        for (const [month, recs] of byMonth) {
          let addedHere = 0;
          await mutateMonth(month, logs => {
            const have = new Set(logs.map(r => r.id));
            const fresh = recs.filter(r => !have.has(r.id));
            addedHere = fresh.length;
            if (!fresh.length) return { write: false };
            return {
              write: true,
              logs: logs.concat(fresh),
              verify: list => {
                const ids = new Set(list.map(r => r.id));
                return fresh.every(r => ids.has(r.id));
              }
            };
          });
          added += addedHere;
        }
        await ensureIndexed(Array.from(byMonth.keys()));
        return added;
      },

      async getMany(ids) {
        const wanted = new Set(ids);
        const found = new Map();
        (await allRecords()).forEach(r => {
          if (wanted.has(r.id)) found.set(r.id, r);
        });
        return found;
      },

      all: allRecords,

      async countAll() {
        return (await allRecords()).length;
      },

      async rebuildAggregates() {
        const months = await readIndex();
        const shards = await readShards(months);
        const items = {};
        shards.forEach((list, m) => { items[aggKey(m)] = aggregateShard(list); });
        if (Object.keys(items).length) await set(items);
        return months.length;
      },

      async settingsGet(key) {
        const r = await get([K.SETTING_PREFIX + key]);
        return r[K.SETTING_PREFIX + key] === undefined ? null : r[K.SETTING_PREFIX + key];
      },

      async settingsSet(key, value) {
        await set({ [K.SETTING_PREFIX + key]: value });
        return value;
      },

      async snapshotPut(snapshot) {
        const list = await readSnapshots();
        await set({ [K.SNAPSHOTS]: list.filter(s => s.id !== snapshot.id).concat([snapshot]) });
        return snapshot;
      },

      async snapshotGet(id) {
        return (await readSnapshots()).find(s => s.id === id) || null;
      },

      async snapshotDelete(id) {
        const list = await readSnapshots();
        await set({ [K.SNAPSHOTS]: list.filter(s => s.id !== id) });
        return true;
      },

      async snapshotList() {
        return (await readSnapshots()).map(snapshotMeta);
      }
    };

    async function readSnapshots() {
      const r = await get([K.SNAPSHOTS]);
      return Array.isArray(r[K.SNAPSHOTS]) ? r[K.SNAPSHOTS].filter(s => s && typeof s.id === 'string') : [];
    }

    // Exposed for the legacy cleanup: nothing else writes these keys.
    backend._remove = remove;
    return backend;
  }

  // Newest first. createdAt alone ties for snapshots taken in the same
  // millisecond, so the insertion sequence decides.
  function compareSnapshotsNewestFirst(a, b) {
    const diff = (b.seq || 0) - (a.seq || 0);
    if (diff !== 0) return diff;
    return a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0);
  }

  function snapshotMeta(s) {
    return {
      id: s.id,
      seq: s.seq || 0,
      createdAt: s.createdAt,
      reason: s.reason || 'manual',
      logCount: Array.isArray(s.logs) ? s.logs.length : (s.logCount || 0),
      accounts: Array.isArray(s.accounts) ? s.accounts : []
    };
  }

  // ---------------------------------------------------------------------------
  // chrome.storage.sync area for trackers, theme, and preferences
  // ---------------------------------------------------------------------------
  // chrome.storage.sync carries data across every device signed into the same
  // Chrome profile; chrome.storage.local never leaves this machine. Falling
  // back to local (and, failing that, to a localStorage-backed shim) keeps a
  // sync-less Chrome build or a bare test mock working, just without the
  // cross-device carry-over.
  function getStorageArea() {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage) {
      if (chrome.storage.sync) return chrome.storage.sync;
      if (chrome.storage.local) return chrome.storage.local;
    }
    return localStorageShim();
  }

  function getLocalArea() {
    if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.local) return chrome.storage.local;
    return localStorageShim();
  }

  function localStorageShim() {
    return {
      get: (keys, cb) => {
        const result = {};
        const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        keyList.forEach(k => {
          if (typeof localStorage !== 'undefined' && localStorage) {
            const val = localStorage.getItem(k);
            if (val !== null && val !== undefined) {
              try { result[k] = JSON.parse(val); } catch (e) { result[k] = val; }
            }
          }
        });
        if (cb) cb(result);
      },
      set: (items, cb) => {
        if (typeof localStorage !== 'undefined' && localStorage) {
          Object.entries(items).forEach(([k, v]) => {
            localStorage.setItem(k, JSON.stringify(v));
          });
        }
        if (cb) cb();
      },
      remove: (keys, cb) => {
        if (typeof localStorage !== 'undefined' && localStorage) {
          (Array.isArray(keys) ? keys : [keys]).forEach(k => localStorage.removeItem(k));
        }
        if (cb) cb();
      }
    };
  }

  function areaGet(area, keys) {
    return new Promise(resolve => {
      try {
        area.get(keys, result => {
          if (lastError()) { resolve({}); return; }
          resolve(result || {});
        });
      } catch (e) {
        resolve({});
      }
    });
  }

  function areaSet(area, items) {
    return new Promise(resolve => {
      try {
        area.set(items, () => resolve(!lastError()));
      } catch (e) {
        resolve(false);
      }
    });
  }

  function areaRemove(area, keys) {
    return new Promise(resolve => {
      try {
        if (typeof area.remove !== 'function') { resolve(); return; }
        area.remove(keys, () => { void lastError(); resolve(); });
      } catch (e) {
        resolve();
      }
    });
  }

  // Write queue mutex. Serializes writers inside this context; the verify
  // step in mutateVerified covers the other contexts.
  let writeLock = Promise.resolve();
  function enqueueWrite(fn) {
    const next = writeLock.then(() => fn(), () => fn());
    writeLock = next.catch(() => {});
    return next;
  }

  // Log writes get their own queue so a tracker edit never waits behind a
  // bulk import.
  let logLock = Promise.resolve();
  function enqueueLogWrite(fn) {
    const next = logLock.then(() => fn(), () => fn());
    logLock = next.catch(() => {});
    return next;
  }

  function readRaw(key) {
    return new Promise(resolve => {
      getStorageArea().get([key], result => resolve(result || {}));
    });
  }

  function writeRaw(key, value) {
    return new Promise(resolve => {
      getStorageArea().set({ [key]: value }, () => resolve(true));
    });
  }

  // apply(currentValue, alreadyWrote) must return either
  //   { write: false, result }                         -> nothing to do
  //   { write: true, value, verify(readBack), result } -> write and confirm
  async function mutateVerified(readCurrent, writeValue, apply) {
    let lastResult;
    let wrote = false;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const plan = apply(await readCurrent(), wrote);
      lastResult = plan.result;
      if (!plan.write) return plan.result;
      await writeValue(plan.value);
      wrote = true;
      if (plan.verify(await readCurrent())) return plan.result;
    }
    return lastResult;
  }

  function safeGetMetrics(result) {
    return Array.isArray(result && result[STORAGE_KEYS.METRICS]) ? result[STORAGE_KEYS.METRICS] : [];
  }

  function readMetricsRaw() {
    return migrateSimpleKeyIfNeeded(STORAGE_KEYS.METRICS).then(() => new Promise(resolve => {
      getStorageArea().get([STORAGE_KEYS.METRICS], result => resolve(safeGetMetrics(result)));
    }));
  }

  function writeMetricsRaw(metrics) {
    return new Promise(resolve => {
      getStorageArea().set({ [STORAGE_KEYS.METRICS]: metrics }, () => resolve());
    });
  }

  // A device upgrading from a local-only build still has its settings sitting
  // in chrome.storage.local; sync starts out empty on every device until this
  // runs once. Only copies when sync has nothing yet, so it can never clobber
  // data another device already synced in.
  const migratedKeys = {};
  async function migrateSimpleKeyIfNeeded(key) {
    if (migratedKeys[key]) return;
    migratedKeys[key] = true;
    if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.sync || !chrome.storage.local) return;
    try {
      const syncResult = await new Promise(r => chrome.storage.sync.get([key], r));
      if (syncResult && syncResult[key] !== undefined) return;
      const localResult = await new Promise(r => chrome.storage.local.get([key], r));
      if (localResult && localResult[key] !== undefined) {
        await new Promise(r => chrome.storage.sync.set({ [key]: localResult[key] }, r));
      }
    } catch (e) {
      // Best effort: sync simply starts empty if this fails.
    }
  }

  // Seeding the defaults used to be an unlocked set() straight out of getMetrics,
  // which could overwrite an addMetric that was mid-flight in another context and
  // silently drop the new tracker. Route it through the queue and re-check first.
  function seedDefaultMetrics() {
    return enqueueWrite(async () => {
      const existing = safeGetMetrics(await readRaw(STORAGE_KEYS.METRICS));
      if (existing.length > 0) return false;
      await writeRaw(STORAGE_KEYS.METRICS, DEFAULT_METRICS.map(m => ({ ...m })));
      return true;
    });
  }

  async function getCurrentUserEmail() {
    if (typeof TrackerAuth !== 'undefined' && TrackerAuth && typeof TrackerAuth.getCurrentUser === 'function') {
      try {
        const u = await TrackerAuth.getCurrentUser();
        return u && u.email ? normalizeEmail(u.email) : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  async function resolveEmail(override) {
    return normalizeEmail(override !== undefined ? override : await getCurrentUserEmail());
  }

  // ---------------------------------------------------------------------------
  // Backend selection and legacy migration
  // ---------------------------------------------------------------------------
  function dbModule() {
    if (typeof LitDB !== 'undefined' && LitDB) return LitDB;
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try { return require('./db'); } catch (e) { return null; }
    }
    return null;
  }

  function hasRuntimeMessaging() {
    try {
      return typeof chrome !== 'undefined' && !!chrome && !!chrome.runtime &&
        typeof chrome.runtime.sendMessage === 'function' && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  // 'idb' in the popup and the service worker, 'remote' in a content script
  // (a web page origin with the extension's messaging available), 'local'
  // wherever IndexedDB is missing.
  let forcedMode = null;
  let resolvedMode = null;
  function currentMode() {
    if (forcedMode) return forcedMode;
    if (resolvedMode) return resolvedMode;
    const loc = typeof location !== 'undefined' && location ? location : null;
    const proto = loc && typeof loc.protocol === 'string' ? loc.protocol : '';
    const isWebPage = /^(https?|file):$/.test(proto);
    if (isWebPage && hasRuntimeMessaging()) {
      resolvedMode = 'remote';
    } else {
      const db = dbModule();
      resolvedMode = !isWebPage && db && db.available() ? 'idb' : 'local';
    }
    return resolvedMode;
  }

  let backendPromise = null;
  function getBackend() {
    if (!backendPromise) {
      backendPromise = initBackend();
      backendPromise.catch(() => { backendPromise = null; });
    }
    return backendPromise;
  }

  async function initBackend() {
    let backend = null;
    if (currentMode() === 'idb') {
      const db = dbModule();
      try {
        await db.open();
        backend = createIdbBackend(db);
      } catch (err) {
        if (typeof console !== 'undefined') console.warn('LIT: IndexedDB unavailable, keeping logs in chrome.storage.local:', err && err.message);
      }
    }
    if (!backend) backend = createLocalBackend(getLocalArea());
    await migrateLegacyLogs(backend);
    return backend;
  }

  function readLegacyChunks(area) {
    return areaGet(area, [LEGACY_KEYS.META, LEGACY_KEYS.LOCAL]).then(metaResult => {
      const meta = metaResult[LEGACY_KEYS.META];
      const count = meta && typeof meta.count === 'number' && meta.count >= 0 ? meta.count : null;
      if (count === null) {
        return Array.isArray(metaResult[LEGACY_KEYS.LOCAL]) ? metaResult[LEGACY_KEYS.LOCAL] : null;
      }
      if (count === 0) return [];
      const keys = [];
      for (let i = 0; i < count; i++) keys.push(LEGACY_KEYS.CHUNK_PREFIX + i);
      return areaGet(area, keys).then(chunks => {
        let logs = [];
        keys.forEach(k => { if (Array.isArray(chunks[k])) logs = logs.concat(chunks[k]); });
        return logs;
      });
    });
  }

  // Turns whatever an older build stored into clean records. Entries with no
  // usable date fall back to their timestamp's local date, or are dropped.
  function recordsFromLegacy(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((l, index) => {
      if (!l || typeof l !== 'object') return;
      let date = l.date;
      if (!isDateStr(date)) {
        const t = new Date(l.timestamp || 0);
        if (!l.timestamp || isNaN(t.getTime())) return;
        date = getLocalDateStr(t);
      }
      const log = {
        id: typeof l.id === 'string' && l.id ? l.id : newLogId() + '-m' + index,
        metricId: typeof l.metricId === 'string' && l.metricId ? l.metricId : 'jobs',
        userEmail: normalizeEmail(l.userEmail),
        count: countOf(l),
        date,
        timestamp: typeof l.timestamp === 'string' ? l.timestamp : new Date(date + 'T12:00:00').toISOString(),
        company: cleanText(l.company, 300),
        role: cleanText(l.role, 300),
        notes: cleanText(l.notes),
        solveTimeSeconds: Math.max(0, parseInt(l.solveTimeSeconds, 10) || 0)
      };
      ['status', 'statusUpdatedAt', 'respondedAt', 'source', 'sourceId', 'url'].forEach(k => {
        if (typeof l[k] === 'string' && l[k]) log[k] = l[k];
      });
      if (log.metricId === 'jobs') log.status = normalizeStatus(log.status) || 'applied';
      out.push(toRecord(log, index));
    });
    return out;
  }

  // Runs once per device. Priority mirrors how older builds decided what was
  // current: a local overflow was always the complete picture for this
  // device, then sync chunks, then a pre-sync local array. Union across them
  // would resurrect entries deleted after the older copy was made.
  let migrationRun = null;
  function migrateLegacyLogs(backend) {
    if (!migrationRun) migrationRun = doMigrateLegacyLogs(backend).catch(err => {
      migrationRun = null;
      if (typeof console !== 'undefined') console.warn('LIT: legacy log import failed and will retry:', err && err.message);
    });
    return migrationRun;
  }

  async function doMigrateLegacyLogs(backend) {
    const marker = await backend.settingsGet(MIGRATION_SETTING);
    if (marker && marker.done) return marker;

    const hasChrome = typeof chrome !== 'undefined' && chrome && chrome.storage;
    const local = hasChrome && chrome.storage.local ? chrome.storage.local : (hasChrome ? null : localStorageShim());
    const sync = hasChrome && chrome.storage.sync ? chrome.storage.sync : null;

    let source = 'none';
    let legacy = [];
    const localVals = local ? await areaGet(local, [LEGACY_KEYS.OVERFLOW]) : {};
    if (Array.isArray(localVals[LEGACY_KEYS.OVERFLOW])) {
      source = 'local-overflow';
      legacy = localVals[LEGACY_KEYS.OVERFLOW];
    } else {
      const fromSync = sync ? await readLegacyChunks(sync) : null;
      if (fromSync && fromSync.length) {
        source = 'sync';
        legacy = fromSync;
      } else if (local) {
        const fromLocal = await readLegacyChunks(local);
        if (fromLocal && fromLocal.length) {
          source = 'local';
          legacy = fromLocal;
        }
      }
    }

    const records = recordsFromLegacy(legacy);
    const added = records.length ? await backend.bulkAdd(records) : 0;

    if (source !== 'none' && local) {
      await areaSet(local, {
        [LEGACY_KEYS.ARCHIVE]: { archivedAt: new Date().toISOString(), source, count: legacy.length, logs: legacy }
      });
      if (source !== 'sync') {
        const chunkKeys = [];
        const meta = (await areaGet(local, [LEGACY_KEYS.META]))[LEGACY_KEYS.META];
        const count = meta && typeof meta.count === 'number' ? meta.count : 0;
        for (let i = 0; i < count; i++) chunkKeys.push(LEGACY_KEYS.CHUNK_PREFIX + i);
        await areaRemove(local, [LEGACY_KEYS.OVERFLOW, LEGACY_KEYS.LOCAL, LEGACY_KEYS.META].concat(chunkKeys));
      }
    }
    if (source === 'sync' && sync) {
      const existing = (await areaGet(sync, [LEGACY_KEYS.SYNC_MIGRATED]))[LEGACY_KEYS.SYNC_MIGRATED];
      if (!existing) await areaSet(sync, { [LEGACY_KEYS.SYNC_MIGRATED]: { at: Date.now() } });
    }

    const result = { done: true, at: new Date().toISOString(), source, count: records.length, added };
    await backend.settingsSet(MIGRATION_SETTING, result);
    if (added > 0) notifyLogsChanged('migrate', []);
    return result;
  }

  // Frees the legacy sync chunks once every device has had a month to import
  // them. Runs from the service worker's periodic maintenance.
  async function cleanupLegacySync(now) {
    if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.sync) return false;
    const sync = chrome.storage.sync;
    const r = await areaGet(sync, [LEGACY_KEYS.SYNC_MIGRATED, LEGACY_KEYS.META]);
    const marker = r[LEGACY_KEYS.SYNC_MIGRATED];
    if (!marker || !Number.isFinite(marker.at) || (now || Date.now()) - marker.at < LEGACY_SYNC_GRACE_MS) return false;
    const meta = r[LEGACY_KEYS.META];
    const count = meta && typeof meta.count === 'number' ? meta.count : 0;
    const keys = [LEGACY_KEYS.META, LEGACY_KEYS.LOCAL];
    for (let i = 0; i < count; i++) keys.push(LEGACY_KEYS.CHUNK_PREFIX + i);
    await areaRemove(sync, keys);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Change broadcast
  // ---------------------------------------------------------------------------
  let revCounter = 0;
  function notifyLogsChanged(op, ids) {
    if (typeof chrome === 'undefined' || !chrome || !chrome.storage || !chrome.storage.local) return;
    revCounter++;
    const rev = {
      rev: Date.now().toString(36) + '-' + revCounter + '-' + Math.random().toString(36).slice(2, 6),
      op,
      ids: (ids || []).slice(0, 50),
      at: Date.now()
    };
    try {
      chrome.storage.local.set({ [STORAGE_KEYS.LOGS_REV]: rev }, () => { void lastError(); });
    } catch (e) {
      // A torn-down context has nobody left to notify.
    }
  }

  // ---------------------------------------------------------------------------
  // Remote calls (content scripts -> service worker)
  // ---------------------------------------------------------------------------
  const REMOTE_METHODS = [
    'getLogs', 'addLog', 'updateLog', 'setLogStatus', 'deleteLog', 'undoLastLog',
    'getStats', 'getActivityHistory', 'getLeetcodeTimeStats', 'getDailyAggregates',
    'findRecentApplication', 'searchLogs', 'getRecentLogs', 'getPipelineSummary',
    'getWeekSummary', 'exportBackup', 'importBackup', 'createSnapshot', 'listSnapshots',
    'getSnapshot', 'restoreSnapshot', 'maybeAutoSnapshot', 'getStorageInfo', 'rebuildAggregates'
  ];

  // JSON messaging turns an undefined argument into null, and null means
  // "signed out" to every scoped call here. Keep the two apart.
  const UNDEFINED_ARG = { __ptUndefined: true };
  function encodeArgs(args) {
    return Array.prototype.slice.call(args).map(a => (a === undefined ? UNDEFINED_ARG : a));
  }
  function decodeArgs(args) {
    return (Array.isArray(args) ? args : []).map(a => (a && typeof a === 'object' && a.__ptUndefined === true ? undefined : a));
  }

  function sendOnce(payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(payload, response => {
          const err = lastError();
          if (err) { reject(new Error(err.message || String(err))); return; }
          if (!response) { reject(new Error('The LIT background worker did not answer')); return; }
          if (response.ok) resolve(response.result);
          else reject(new Error(response.error || 'Storage call failed in the background worker'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function callRemote(method, args) {
    const payload = { type: REMOTE_MESSAGE, method, args: encodeArgs(args) };
    try {
      return await sendOnce(payload);
    } catch (err) {
      // The worker may still be starting up; one retry covers that window.
      if (/Receiving end does not exist|did not answer/i.test(String(err && err.message))) {
        await new Promise(r => setTimeout(r, 150));
        return sendOnce(payload);
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Log helpers used by the public API
  // ---------------------------------------------------------------------------
  function buildNewLog(logData, userEmail) {
    const now = new Date();
    const metricId = typeof logData.metricId === 'string' && logData.metricId ? logData.metricId : 'jobs';
    const log = {
      id: newLogId(),
      metricId,
      userEmail: userEmail || null,
      count: Math.max(1, parseInt(logData.count, 10) || 1),
      date: isDateStr(logData.date) ? logData.date : getLocalDateStr(now),
      timestamp: now.toISOString(),
      company: (logData.company || '').trim(),
      role: (logData.role || '').trim(),
      notes: (logData.notes || '').trim(),
      solveTimeSeconds: Math.max(0, parseInt(logData.solveTimeSeconds, 10) || 0),
      source: LOG_SOURCES.includes(logData.source) ? logData.source : 'manual'
    };
    if (metricId === 'jobs') log.status = normalizeStatus(logData.status) || 'applied';
    // Logged straight into a later stage (say, an interview for an old
    // application): stamp the stage change but not respondedAt, which would
    // count as a same-day response in the turnaround stats.
    if (log.status && log.status !== 'applied') log.statusUpdatedAt = now.toISOString();
    const sourceId = cleanText(logData.sourceId, 200);
    if (sourceId) log.sourceId = sourceId;
    const url = cleanUrl(logData.url);
    if (url) log.url = url;
    return log;
  }

  function isAuthorized(rec, targetUk) {
    return (rec._uk || '') === targetUk;
  }

  // Pipeline counts and response stats over job entries. Counts are weighted
  // by entry count so they add up to the same totals as the counter.
  function summarizePipeline(logs) {
    const counts = {};
    STATUS_IDS.forEach(id => { counts[id] = 0; });
    let total = 0;
    let turnaroundSum = 0;
    let turnaroundSamples = 0;
    (logs || []).forEach(l => {
      if (!l || l.metricId !== 'jobs') return;
      const status = normalizeStatus(l.status) || 'applied';
      const n = countOf(l);
      counts[status] += n;
      total += n;
      if (status !== 'applied' && typeof l.respondedAt === 'string' && isDateStr(l.date)) {
        const respondedDate = getLocalDateStr(new Date(l.respondedAt));
        const days = daysBetween(l.date, respondedDate);
        if (Number.isFinite(days) && days >= 0) {
          turnaroundSum += days;
          turnaroundSamples++;
        }
      }
    });
    const responded = total - counts.applied;
    return {
      total,
      counts,
      responded,
      responseRate: total > 0 ? Math.round((responded / total) * 100) : null,
      avgTurnaroundDays: turnaroundSamples > 0 ? parseFloat((turnaroundSum / turnaroundSamples).toFixed(1)) : null,
      turnaroundSamples
    };
  }

  function buildDailyMap(aggs) {
    const dailyMap = {};
    let logCount = 0;
    aggs.forEach(a => {
      logCount += a.logCount || 0;
      Object.keys(a.days || {}).forEach(date => {
        const src = a.days[date] || {};
        const dst = dailyMap[date] || (dailyMap[date] = {});
        Object.keys(src).forEach(m => { dst[m] = (dst[m] || 0) + (src[m] || 0); });
      });
    });
    return { dailyMap, logCount };
  }

  function sanitizeImportedLog(raw, userEmail, index) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isDateStr(raw.date)) return null;
    const log = {
      id: typeof raw.id === 'string' && /^[\w.:-]{1,100}$/.test(raw.id) ? raw.id : newLogId() + '-i' + index,
      metricId: typeof raw.metricId === 'string' && raw.metricId ? raw.metricId.slice(0, 120) : 'jobs',
      userEmail: userEmail || null,
      count: countOf(raw),
      date: raw.date,
      timestamp: typeof raw.timestamp === 'string' && !isNaN(new Date(raw.timestamp).getTime())
        ? raw.timestamp
        : new Date(raw.date + 'T12:00:00').toISOString(),
      company: cleanText(raw.company, 300),
      role: cleanText(raw.role, 300),
      notes: cleanText(raw.notes),
      solveTimeSeconds: Math.max(0, parseInt(raw.solveTimeSeconds, 10) || 0),
      source: LOG_SOURCES.includes(raw.source) ? raw.source : 'import'
    };
    if (log.metricId === 'jobs') {
      log.status = normalizeStatus(raw.status) || 'applied';
      if (typeof raw.statusUpdatedAt === 'string') log.statusUpdatedAt = raw.statusUpdatedAt;
      if (typeof raw.respondedAt === 'string' && log.status !== 'applied') log.respondedAt = raw.respondedAt;
    }
    const sourceId = cleanText(raw.sourceId, 200);
    if (sourceId) log.sourceId = sourceId;
    const url = cleanUrl(raw.url);
    if (url) log.url = url;
    return log;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  const api = {
    STORAGE_KEYS,
    DEFAULT_METRICS,
    STATUSES,
    DUPLICATE_WINDOW_DAYS,
    SNAPSHOT_RETAIN,
    PREF_DEFAULTS,
    getLocalDateStr,
    parseLocalDateToNoon,
    addDays,
    daysBetween,
    weekStartOf,
    isDateStr,
    normalizeEmail,
    normalizeCompany,
    normalizeStatus,
    statusLabel,
    summarizePipeline,

    async getMetrics(userEmailOverride) {
      const targetEmail = normalizeEmail(userEmailOverride !== undefined ? userEmailOverride : await getCurrentUserEmail());
      let allMetrics = await readMetricsRaw();
      if (allMetrics.length === 0) {
        allMetrics = [...DEFAULT_METRICS];
        seedDefaultMetrics();
      }
      return allMetrics.filter(m => m && typeof m === 'object' && typeof m.id === 'string').map(m => {
        const dailyGoal = m.dailyGoal || defaultGoalFor(m.id);
        const weeklyGoal = Math.max(0, parseInt(m.weeklyGoal, 10) || 0);
        return { ...m, dailyGoal, weeklyGoal };
      }).filter(m => {
        // Installs from before the calorie tracker was removed still have its
        // built-in metric saved; keep it out of the tab bar.
        if (m.id === 'calories' && m.isBudget) return false;
        if (m.isDefault || m.id === 'jobs' || m.id === 'leetcode') return true;
        const owner = normalizeEmail(m.userEmail);
        if (!targetEmail) {
          return !owner;
        }
        return owner === targetEmail;
      });
    },

    async saveMetrics(metrics) {
      return enqueueWrite(async () => {
        return new Promise(resolve => {
          getStorageArea().set({ [STORAGE_KEYS.METRICS]: Array.isArray(metrics) ? metrics : [] }, () => resolve(true));
        });
      });
    },

    async setMetricGoal(metricId, goalNumber) {
      const goal = Math.max(1, parseInt(goalNumber, 10) || 1);
      const hasGoal = list => {
        const found = list.find(m => m && m.id === metricId);
        return !found || found.dailyGoal === goal;
      };
      return enqueueWrite(async () => {
        return mutateVerified(readMetricsRaw, writeMetricsRaw, current => {
          const allMetrics = current.length === 0 ? [...DEFAULT_METRICS] : current;
          const updated = allMetrics.map(m => (m && m.id === metricId ? { ...m, dailyGoal: goal } : m));
          return { write: true, value: updated, verify: hasGoal, result: true };
        });
      });
    },

    // 0 (or anything below 1) turns the weekly goal off.
    async setMetricWeeklyGoal(metricId, goalNumber) {
      const goal = Math.max(0, parseInt(goalNumber, 10) || 0);
      const hasGoal = list => {
        const found = list.find(m => m && m.id === metricId);
        return !found || (parseInt(found.weeklyGoal, 10) || 0) === goal;
      };
      return enqueueWrite(async () => {
        return mutateVerified(readMetricsRaw, writeMetricsRaw, current => {
          const allMetrics = current.length === 0 ? [...DEFAULT_METRICS] : current;
          const updated = allMetrics.map(m => (m && m.id === metricId ? { ...m, weeklyGoal: goal } : m));
          return { write: true, value: updated, verify: hasGoal, result: true };
        });
      });
    },

    async addMetric(metricOptions = {}, userEmailOverride) {
      return enqueueWrite(async () => {
        const options = typeof metricOptions === 'string' ? { name: metricOptions } : (metricOptions || {});
        const customEmail = options.userEmail !== undefined ? options.userEmail : userEmailOverride;
        const userEmail = normalizeEmail(customEmail !== undefined ? customEmail : await getCurrentUserEmail());
        const cleanName = (options.name || '').trim();
        const id = (cleanName || 'metric')
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-') + '-' + Math.random().toString(36).substring(2, 6);

        const newMetric = {
          id,
          name: cleanName || 'Custom Metric',
          unit: (options.unit || 'items').trim(),
          color: options.color || '#1a73e8',
          icon: options.icon || 'target',
          dailyGoal: Math.max(1, parseInt(options.dailyGoal, 10) || 1),
          weeklyGoal: Math.max(0, parseInt(options.weeklyGoal, 10) || 0),
          userEmail: userEmail || null,
          isDefault: false,
          createdAt: new Date().toISOString()
        };

        const hasMetric = list => list.some(m => m && m.id === newMetric.id);
        return mutateVerified(readMetricsRaw, writeMetricsRaw, current => {
          if (hasMetric(current)) return { write: false, result: newMetric };
          const allMetrics = current.length === 0 ? [...DEFAULT_METRICS] : current;
          return {
            write: true,
            value: allMetrics.concat([newMetric]),
            verify: hasMetric,
            result: newMetric
          };
        });
      });
    },

    async deleteMetric(id, userEmailOverride) {
      if (!id || id === 'jobs' || id === 'leetcode') {
        return false;
      }
      return enqueueWrite(async () => {
        const targetEmail = normalizeEmail(userEmailOverride !== undefined ? userEmailOverride : await getCurrentUserEmail());
        const isGone = list => !list.some(m => m && m.id === id);
        return mutateVerified(readMetricsRaw, writeMetricsRaw, (allMetrics, alreadyWrote) => {
          const target = allMetrics.find(m => m && m.id === id);
          if (!target) return { write: false, result: alreadyWrote };
          if (target.isDefault || target.id === 'jobs' || target.id === 'leetcode') {
            return { write: false, result: false };
          }
          const owner = normalizeEmail(target.userEmail);
          const authorized = (!targetEmail && !owner) || (targetEmail && owner === targetEmail);
          if (!authorized) return { write: false, result: false };
          return {
            write: true,
            value: allMetrics.filter(m => !m || m.id !== id),
            verify: isGone,
            result: true
          };
        });
      });
    },

    // Adds custom trackers from a backup that this account does not have yet,
    // keeping their ids so imported entries still point at them.
    async importMetrics(list, userEmailOverride) {
      const incoming = (Array.isArray(list) ? list : []).filter(m => m && typeof m.id === 'string' && m.id &&
        !m.isDefault && m.id !== 'jobs' && m.id !== 'leetcode');
      if (!incoming.length) return 0;
      const userEmail = await resolveEmail(userEmailOverride);
      return enqueueWrite(async () => {
        let added = 0;
        await mutateVerified(readMetricsRaw, writeMetricsRaw, current => {
          const base = current.length === 0 ? [...DEFAULT_METRICS] : current;
          const have = new Set(base.map(m => m && m.id));
          const fresh = incoming.filter(m => !have.has(m.id)).map(m => ({
            id: m.id.slice(0, 120),
            name: cleanText(m.name, 80) || 'Custom Metric',
            unit: cleanText(m.unit, 40) || 'items',
            color: /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#1a73e8',
            icon: typeof m.icon === 'string' ? m.icon.slice(0, 40) : 'target',
            dailyGoal: Math.max(1, parseInt(m.dailyGoal, 10) || 1),
            weeklyGoal: Math.max(0, parseInt(m.weeklyGoal, 10) || 0),
            userEmail: userEmail || null,
            isDefault: false,
            createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString()
          }));
          added = fresh.length;
          if (!fresh.length) return { write: false, result: 0 };
          const ids = fresh.map(m => m.id);
          return {
            write: true,
            value: base.concat(fresh),
            verify: l => ids.every(id => l.some(m => m && m.id === id)),
            result: fresh.length
          };
        });
        return added;
      });
    },

    // ----- Logs -----------------------------------------------------------

    async getLogs(filter = {}, userEmailOverride) {
      let metricId = null;
      let startDate = null;
      let endDate = null;
      let limit = 0;
      let targetUserEmail;

      if (typeof filter === 'string') {
        metricId = filter;
        if (userEmailOverride !== undefined) targetUserEmail = userEmailOverride;
      } else if (filter && typeof filter === 'object') {
        metricId = filter.metricId || null;
        startDate = filter.startDate || null;
        endDate = filter.endDate || null;
        if (isDateStr(filter.date)) {
          startDate = filter.date;
          endDate = filter.date;
        }
        limit = Math.max(0, parseInt(filter.limit, 10) || 0);
        if (filter.userEmail !== undefined) {
          targetUserEmail = filter.userEmail;
        } else if (userEmailOverride !== undefined) {
          targetUserEmail = userEmailOverride;
        }
      }

      const email = await resolveEmail(targetUserEmail);
      const backend = await getBackend();
      const recs = await backend.query({
        userKey: userKeyOf(email),
        metricId: metricId || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined
      });
      recs.sort(compareNewestFirst);
      const list = limit ? recs.slice(0, limit) : recs;
      return list.map(fromRecord);
    },

    async addLog(logData = {}, userEmailOverride) {
      const data = logData && typeof logData === 'object' ? logData : {};
      return enqueueLogWrite(async () => {
        const customEmail = data.userEmail !== undefined ? data.userEmail : userEmailOverride;
        const userEmail = await resolveEmail(customEmail);
        const log = buildNewLog(data, userEmail);
        const backend = await getBackend();
        await backend.add(toRecord(log));
        notifyLogsChanged('add', [log.id]);
        return log;
      });
    },

    // Edits an entry in place. Only content fields can change; the account,
    // id, and timestamp never do. Moving a job entry off 'applied' stamps
    // respondedAt, which the response-rate and turnaround stats read.
    async updateLog(id, patch, userEmailOverride) {
      if (!id || !patch || typeof patch !== 'object') return false;
      const targetUk = userKeyOf(await resolveEmail(userEmailOverride));
      return enqueueLogWrite(async () => {
        const backend = await getBackend();
        const outcome = await backend.update(id, cur => {
          if (!isAuthorized(cur, targetUk)) return { status: 'denied' };
          const next = Object.assign({}, cur);
          const nowIso = new Date().toISOString();
          if (patch.company !== undefined) next.company = cleanText(patch.company, 300);
          if (patch.role !== undefined) next.role = cleanText(patch.role, 300);
          if (patch.notes !== undefined) next.notes = cleanText(patch.notes);
          if (patch.count !== undefined) next.count = Math.max(1, parseInt(patch.count, 10) || 1);
          if (patch.date !== undefined && isDateStr(patch.date)) next.date = patch.date;
          if (patch.url !== undefined) {
            const url = cleanUrl(patch.url);
            if (url) next.url = url; else delete next.url;
          }
          if (patch.status !== undefined) applyStatus(next, cur, patch.status, nowIso);
          next._ck = normalizeCompany(next.company);
          const changed = JSON.stringify(next) !== JSON.stringify(cur);
          return changed ? { record: next } : { status: 'noop', record: null, current: cur };
        });
        if (outcome.status === 'updated') {
          notifyLogsChanged('update', [id]);
          return fromRecord(outcome.after);
        }
        if (outcome.status === 'noop') return fromRecord(outcome.current);
        return false;
      });
    },

    async setLogStatus(id, status, userEmailOverride) {
      if (!normalizeStatus(status)) return false;
      return api.updateLog(id, { status }, userEmailOverride);
    },

    // Sets how many applications sit in one stage by moving entries between
    // it and Applied, so the stage filter and the counts always agree.
    // Raising a stage takes the oldest Applied entries; lowering it returns
    // the most recently moved ones. Applied itself is whatever is left over.
    async setStageCount(status, target, userEmailOverride) {
      const stage = normalizeStatus(status);
      if (!stage || stage === 'applied') throw new Error('Pick a stage other than Applied.');
      const want = Math.max(0, parseInt(target, 10) || 0);
      const targetUk = userKeyOf(await resolveEmail(userEmailOverride));
      return enqueueLogWrite(async () => {
        const backend = await getBackend();
        const jobs = (await backend.query({ userKey: targetUk, metricId: 'jobs' })).map(fromRecord);
        const statusOfLog = l => normalizeStatus(l.status) || 'applied';
        const inStage = jobs.filter(l => statusOfLog(l) === stage);
        let have = inStage.reduce((n, l) => n + countOf(l), 0);
        let candidates;
        let to;
        if (want > have) {
          to = stage;
          candidates = jobs.filter(l => statusOfLog(l) === 'applied')
            .sort((a, b) => (a.date === b.date ? String(a.timestamp).localeCompare(String(b.timestamp)) : (a.date < b.date ? -1 : 1)));
        } else {
          to = 'applied';
          candidates = inStage
            .sort((a, b) => String(b.statusUpdatedAt || '').localeCompare(String(a.statusUpdatedAt || '')));
        }
        const nowIso = new Date().toISOString();
        const ids = [];
        for (const log of candidates) {
          if (have === want) break;
          const n = countOf(log);
          // An entry that stands for several applications moves only when
          // it fits, so the stage never overshoots the number asked for.
          if (to === stage ? have + n > want : have - n < want) continue;
          const outcome = await backend.update(log.id, cur => {
            if (!isAuthorized(cur, targetUk)) return { status: 'denied' };
            const next = Object.assign({}, cur);
            applyStatus(next, cur, to, nowIso);
            return { record: next };
          });
          if (outcome.status !== 'updated') continue;
          have += to === stage ? n : -n;
          ids.push(log.id);
        }
        if (ids.length) notifyLogsChanged('update', ids);
        return { status: stage, count: have, requested: want, moved: ids.length };
      });
    },

    async deleteLog(id, userEmailOverride) {
      if (!id) return false;
      const targetUk = userKeyOf(await resolveEmail(userEmailOverride));
      return enqueueLogWrite(async () => {
        const backend = await getBackend();
        const outcome = await backend.remove(id, rec => isAuthorized(rec, targetUk));
        if (outcome.status !== 'deleted') return false;
        notifyLogsChanged('delete', [id]);
        return true;
      });
    },

    async undoLastLog(metricId = 'jobs', date, userEmailOverride) {
      const targetDate = isDateStr(date) ? date : getLocalDateStr();
      const targetUk = userKeyOf(await resolveEmail(userEmailOverride));
      return enqueueLogWrite(async () => {
        const backend = await getBackend();
        const removed = await backend.removeLatest({ userKey: targetUk, metricId, date: targetDate });
        if (!removed) return false;
        notifyLogsChanged('delete', [removed.id]);
        return true;
      });
    },

    // ----- Aggregates and stats -------------------------------------------

    async getDailyAggregates(userEmailOverride) {
      const email = await resolveEmail(userEmailOverride);
      const backend = await getBackend();
      const { dailyMap, logCount } = buildDailyMap(await backend.aggregates(userKeyOf(email)));
      return { dailyMap, logCount };
    },

    async getStats(metricIdOrEmail, userEmailOverride) {
      let targetEmail;
      if (typeof metricIdOrEmail === 'string' && metricIdOrEmail.includes('@')) {
        targetEmail = normalizeEmail(metricIdOrEmail);
      } else {
        targetEmail = await resolveEmail(userEmailOverride);
      }
      const backend = await getBackend();
      const [metrics, aggs] = await Promise.all([
        api.getMetrics(targetEmail),
        backend.aggregates(userKeyOf(targetEmail))
      ]);
      const { dailyMap, logCount } = buildDailyMap(aggs);

      const now = new Date();
      const todayStr = getLocalDateStr(now);
      const weekAgoStr = addDays(todayStr, -6);
      const weekStartStr = weekStartOf(todayStr);
      const startOfMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

      const today = {};
      const thisWeek = {};
      const weekToDate = {};
      const thisMonth = {};
      const totals = {};
      metrics.forEach(m => {
        today[m.id] = 0;
        thisWeek[m.id] = 0;
        weekToDate[m.id] = 0;
        thisMonth[m.id] = 0;
        totals[m.id] = 0;
      });

      Object.keys(dailyMap).forEach(date => {
        const byMetric = dailyMap[date];
        Object.keys(byMetric).forEach(mId => {
          const cnt = byMetric[mId] || 0;
          totals[mId] = (totals[mId] || 0) + cnt;
          if (date === todayStr) today[mId] = (today[mId] || 0) + cnt;
          if (date >= weekAgoStr && date <= todayStr) thisWeek[mId] = (thisWeek[mId] || 0) + cnt;
          if (date >= weekStartStr && date <= todayStr) weekToDate[mId] = (weekToDate[mId] || 0) + cnt;
          if (date >= startOfMonthStr && date <= todayStr) thisMonth[mId] = (thisMonth[mId] || 0) + cnt;
        });
      });

      // Goal-based streaks per tracker. currentStreak stays the jobs streak
      // for older callers.
      const streaks = {};
      const longestStreaks = {};
      const weeklyAverages = {};
      metrics.forEach(m => {
        const goal = m.dailyGoal || defaultGoalFor(m.id);
        streaks[m.id] = computeCurrentStreak(dailyMap, m.id, goal, todayStr);
        longestStreaks[m.id] = computeLongestStreak(dailyMap, m.id, goal);
        weeklyAverages[m.id] = parseFloat(((thisWeek[m.id] || 0) / 7).toFixed(1));
      });

      return {
        todayStr,
        weekStartStr,
        metrics,
        today,
        thisWeek,
        weekToDate,
        thisMonth,
        totals,
        totalLogs: logCount,
        currentStreak: streaks.jobs || 0,
        streaks,
        longestStreaks,
        weeklyAverages,
        dailyMap
      };
    },

    async getActivityHistory(daysCount = 30, metricId = null, userEmailOverride) {
      const days = Math.max(1, Math.min(366, parseInt(daysCount, 10) || 30));
      let targetMetricId = null;
      let targetEmailOverride = userEmailOverride;
      if (typeof metricId === 'string' && metricId.includes('@')) {
        targetEmailOverride = metricId;
      } else {
        targetMetricId = metricId;
      }

      const targetEmail = await resolveEmail(targetEmailOverride);
      const backend = await getBackend();
      const [metrics, aggs] = await Promise.all([
        api.getMetrics(targetEmail),
        backend.aggregates(userKeyOf(targetEmail))
      ]);
      const todayStr = getLocalDateStr(new Date());
      const firstStr = addDays(todayStr, -(days - 1));
      const { dailyMap } = buildDailyMap(aggs.filter(a => a.month >= monthOf(firstStr)));

      const historyDays = [];
      let totalCount = 0;
      let activeDaysCount = 0;
      let bestDay = { date: todayStr, count: 0 };
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      for (let i = days - 1; i >= 0; i--) {
        const dStr = addDays(todayStr, -i);
        const byMetric = dailyMap[dStr] || {};
        const dayTotal = targetMetricId
          ? (byMetric[targetMetricId] || 0)
          : Object.keys(byMetric).reduce((sum, k) => sum + byMetric[k], 0);
        totalCount += dayTotal;
        if (dayTotal > 0) activeDaysCount++;
        if (dayTotal > bestDay.count) bestDay = { date: dStr, count: dayTotal };
        const parts = dStr.split('-');
        historyDays.push({
          date: dStr,
          label: `${MONTHS[parseInt(parts[1], 10) - 1]} ${parseInt(parts[2], 10)}`,
          weekday: parseLocalDateToNoon(dStr).getDay(),
          count: dayTotal,
          byMetric
        });
      }

      return {
        days: historyDays,
        totalCount,
        dailyAverage: parseFloat((days > 0 ? totalCount / days : 0).toFixed(1)),
        activeDaysCount,
        bestDay,
        metrics
      };
    },

    formatSecondsToMMSS,
    parseStringToSeconds,
    defaultGoalFor,
    goalMetOn,
    computeCurrentStreak,
    computeLongestStreak,

    formatTimeHMS(totalSeconds) {
      const s = Math.max(0, parseInt(totalSeconds, 10) || 0);
      const hrs = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      const secs = s % 60;
      if (hrs > 0) return hrs + 'h ' + mins + 'm';
      if (mins > 0 && secs > 0) return mins + 'm ' + secs + 's';
      if (mins > 0) return mins + 'm';
      return secs + 's';
    },

    async getLeetcodeTimeStats(userEmailOverride) {
      const logs = await api.getLogs({ metricId: 'leetcode' }, userEmailOverride);
      const today = getLocalDateStr();
      let totalSeconds = 0;
      let todaySeconds = 0;
      let sessionCount = 0;
      let todaySessionCount = 0;
      const timed = [];

      logs.forEach(l => {
        const sec = parseInt(l.solveTimeSeconds, 10) || 0;
        if (sec > 0) {
          totalSeconds += sec;
          sessionCount++;
          timed.push({ seconds: sec, date: l.date, id: l.id });
          if (l.date === today) {
            todaySeconds += sec;
            todaySessionCount++;
          }
        }
      });

      const sorted = timed.map(t => t.seconds).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const medianSeconds = sorted.length === 0 ? 0
        : (sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2));

      return {
        totalSeconds,
        todaySeconds,
        sessionCount,
        todaySessionCount,
        avgSeconds: sessionCount > 0 ? Math.round(totalSeconds / sessionCount) : 0,
        bestSeconds: sorted.length ? sorted[0] : 0,
        medianSeconds,
        latestSeconds: timed.length ? timed[0].seconds : 0,
        // Oldest first, for the distribution sparkline.
        recent: timed.slice(0, 20).reverse()
      };
    },

    // ----- Job pipeline, duplicates, and search ---------------------------

    // The most recent job entry for the same company (or the same listing)
    // inside the window, or null. Drives the "you applied here N days ago"
    // warning before an auto-detected or manual entry is logged.
    async findRecentApplication(query = {}, userEmailOverride) {
      const q = query && typeof query === 'object' ? query : { company: query };
      const companyKey = normalizeCompany(q.company);
      const sourceId = cleanText(q.sourceId, 200);
      const url = cleanUrl(q.url);
      if (!companyKey && !sourceId) return null;
      const email = await resolveEmail(userEmailOverride);
      const uk = userKeyOf(email);
      const withinDays = Math.max(1, parseInt(q.withinDays, 10) || DUPLICATE_WINDOW_DAYS);
      const today = getLocalDateStr();
      const since = addDays(today, -withinDays);
      const backend = await getBackend();
      const [byCompany, bySource] = await Promise.all([
        companyKey ? backend.query({ userKey: uk, companyKey }) : Promise.resolve([]),
        sourceId ? backend.query({ userKey: uk, sourceId }) : Promise.resolve([])
      ]);
      const seen = new Set();
      const candidates = byCompany.concat(bySource).filter(r => {
        if (seen.has(r.id)) return false;
        seen.add(r.id);
        return r.metricId === 'jobs' && r.date >= since && r.id !== q.excludeId;
      });
      if (!candidates.length) return null;
      candidates.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : compareNewestFirst(a, b)));
      const hit = candidates[0];
      return {
        log: fromRecord(hit),
        daysAgo: Math.max(0, daysBetween(hit.date, today)),
        sameListing: !!((sourceId && hit.sourceId === sourceId) || (url && hit.url === url))
      };
    },

    async searchLogs(query, options = {}, userEmailOverride) {
      const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
      const opts = options && typeof options === 'object' ? options : {};
      const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
      if (!tokens.length) return { results: [], total: 0 };
      const email = await resolveEmail(userEmailOverride);
      const backend = await getBackend();
      const [metrics, recs] = await Promise.all([
        api.getMetrics(email),
        backend.query({ userKey: userKeyOf(email), metricId: opts.metricId || undefined })
      ]);
      const names = {};
      metrics.forEach(m => { names[m.id] = m.name; });
      const matches = recs.filter(r => {
        const status = r.metricId === 'jobs' ? statusLabel(normalizeStatus(r.status) || 'applied') : '';
        const hay = [r.company, r.role, r.notes, names[r.metricId] || r.metricId, status, r.date]
          .join(' ')
          .toLowerCase();
        return tokens.every(t => hay.includes(t));
      });
      matches.sort(compareNewestFirst);
      return { results: matches.slice(0, limit).map(fromRecord), total: matches.length };
    },

    async getRecentLogs(options = {}, userEmailOverride) {
      const opts = options && typeof options === 'object' ? options : {};
      const limit = Math.max(1, Math.min(200, parseInt(opts.limit, 10) || 10));
      const status = normalizeStatus(opts.status);
      const logs = await api.getLogs({ metricId: opts.metricId || 'jobs' }, userEmailOverride);
      const filtered = status ? logs.filter(l => (normalizeStatus(l.status) || 'applied') === status) : logs;
      return { results: filtered.slice(0, limit), total: filtered.length };
    },

    async getPipelineSummary(userEmailOverride) {
      const logs = await api.getLogs({ metricId: 'jobs' }, userEmailOverride);
      return summarizePipeline(logs);
    },

    // Totals for one Monday-to-Sunday week (the previous one by default), for
    // the weekly recap card.
    async getWeekSummary(weekStart, userEmailOverride) {
      const email = await resolveEmail(userEmailOverride);
      const start = isDateStr(weekStart) ? weekStartOf(weekStart) : addDays(weekStartOf(getLocalDateStr()), -7);
      const end = addDays(start, 6);
      const backend = await getBackend();
      const [metrics, aggs, jobs] = await Promise.all([
        api.getMetrics(email),
        backend.aggregates(userKeyOf(email)),
        api.getLogs({ metricId: 'jobs' }, email)
      ]);
      const { dailyMap } = buildDailyMap(aggs.filter(a => a.month >= monthOf(start) && a.month <= monthOf(end)));
      const perMetric = metrics.map(m => {
        let total = 0;
        let activeDays = 0;
        let goalDays = 0;
        let bestDay = null;
        const days = [];
        for (let i = 0; i < 7; i++) {
          const d = addDays(start, i);
          const n = (dailyMap[d] || {})[m.id] || 0;
          days.push(n);
          total += n;
          if (n > 0) activeDays++;
          if (goalMetOn(dailyMap, d, m.id, m.dailyGoal)) goalDays++;
          if (n > 0 && (!bestDay || n > bestDay.count)) bestDay = { date: d, count: n };
        }
        return {
          id: m.id,
          name: m.name,
          color: m.color,
          unit: m.unit,
          dailyGoal: m.dailyGoal,
          weeklyGoal: m.weeklyGoal || 0,
          total,
          activeDays,
          goalDays,
          bestDay,
          days
        };
      });
      const responses = jobs.filter(l => {
        if (!l.respondedAt || (normalizeStatus(l.status) || 'applied') === 'applied') return false;
        const d = getLocalDateStr(new Date(l.respondedAt));
        return d >= start && d <= end;
      }).length;
      return {
        weekStart: start,
        weekEnd: end,
        metrics: perMetric,
        total: perMetric.reduce((s, m) => s + m.total, 0),
        responses
      };
    },

    // ----- Backup, restore, and snapshots ---------------------------------

    async exportBackup(userEmailOverride) {
      const email = await resolveEmail(userEmailOverride);
      const [metrics, logs] = await Promise.all([api.getMetrics(email), api.getLogs({}, email)]);
      return {
        format: 'lit-backup',
        version: 2,
        exportedAt: new Date().toISOString(),
        account: email,
        metrics,
        logs: logs.slice().reverse()
      };
    },

    // Merges a backup (or a snapshot, or the older plain export) into the
    // signed-in account. Never deletes: entries already here are skipped, so
    // restoring the same file twice is harmless.
    async importBackup(data, options = {}, userEmailOverride) {
      let parsed = data;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch (e) { throw new Error('That file is not valid JSON.'); }
      }
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.logs) ? parsed.logs : null);
      if (!list) throw new Error('That file does not look like a LIT backup (no "logs" list found).');
      const email = await resolveEmail(userEmailOverride);
      const uk = userKeyOf(email);
      const metricsAdded = parsed && Array.isArray(parsed.metrics) ? await api.importMetrics(parsed.metrics, email) : 0;

      return enqueueLogWrite(async () => {
        const backend = await getBackend();
        let invalid = 0;
        const clean = [];
        list.forEach((raw, i) => {
          const log = sanitizeImportedLog(raw, email, i);
          if (log) clean.push(log); else invalid++;
        });
        const existing = await backend.getMany(clean.map(l => l.id));
        let skipped = 0;
        const records = [];
        clean.forEach((log, i) => {
          const found = existing.get(log.id);
          if (found) {
            if ((found._uk || '') === uk) { skipped++; return; }
            // Same id under another account on this device: keep both.
            log.id = newLogId() + '-r' + i;
          }
          records.push(toRecord(log, i));
        });
        const added = records.length ? await backend.bulkAdd(records) : 0;
        skipped += records.length - added;
        if (added > 0) notifyLogsChanged('import', []);
        return { added, skipped, invalid, metricsAdded, total: list.length };
      });
    },

    async createSnapshot(options = {}) {
      const reason = options && typeof options.reason === 'string' ? options.reason.slice(0, 40) : 'manual';
      const backend = await getBackend();
      const [records, metrics] = await Promise.all([backend.all(), readMetricsRaw()]);
      const logs = records.map(fromRecord);
      const accounts = Array.from(new Set(records.map(r => r._uk || ''))).sort();
      const now = new Date();
      const snapshot = {
        id: 'snap-' + now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        seq: nextSeq(),
        createdAt: now.toISOString(),
        reason,
        logCount: logs.length,
        accounts,
        metrics,
        logs
      };
      await backend.snapshotPut(snapshot);
      const all = (await backend.snapshotList()).sort(compareSnapshotsNewestFirst);
      for (const old of all.slice(SNAPSHOT_RETAIN)) await backend.snapshotDelete(old.id);
      return snapshotMeta(snapshot);
    },

    async listSnapshots() {
      const backend = await getBackend();
      return (await backend.snapshotList()).sort(compareSnapshotsNewestFirst);
    },

    async getSnapshot(id) {
      const backend = await getBackend();
      return backend.snapshotGet(id);
    },

    // Restores the signed-in account's entries from a snapshot (merge, never
    // delete). Other accounts' entries in the snapshot are left alone.
    async restoreSnapshot(id, userEmailOverride) {
      const backend = await getBackend();
      const snap = await backend.snapshotGet(id);
      if (!snap) throw new Error('That snapshot no longer exists.');
      const email = await resolveEmail(userEmailOverride);
      const uk = userKeyOf(email);
      const mine = (snap.logs || []).filter(l => userKeyOf(l && l.userEmail) === uk);
      const metrics = (snap.metrics || []).filter(m => m && userKeyOf(m.userEmail) === uk);
      return api.importBackup({ logs: mine, metrics }, {}, email);
    },

    // Called by the service worker on a schedule: one automatic snapshot a
    // week, rotated to the last SNAPSHOT_RETAIN.
    async maybeAutoSnapshot(nowMs) {
      const now = Number.isFinite(nowMs) ? nowMs : Date.now();
      const backend = await getBackend();
      await cleanupLegacySync(now);
      const last = await backend.settingsGet(LAST_AUTO_SNAPSHOT_SETTING);
      if (Number.isFinite(last) && now - last < SNAPSHOT_INTERVAL_MS) return null;
      if ((await backend.countAll()) === 0) return null;
      const meta = await api.createSnapshot({ reason: 'weekly' });
      await backend.settingsSet(LAST_AUTO_SNAPSHOT_SETTING, now);
      return meta;
    },

    async getStorageInfo() {
      const backend = await getBackend();
      const [logCount, snapshots, migration] = await Promise.all([
        backend.countAll(),
        backend.snapshotList(),
        backend.settingsGet(MIGRATION_SETTING)
      ]);
      return { backend: backend.name, logCount, snapshotCount: snapshots.length, migration };
    },

    async rebuildAggregates() {
      const backend = await getBackend();
      const n = await backend.rebuildAggregates();
      notifyLogsChanged('rebuild', []);
      return n;
    },

    // ----- Theme, preferences, active tracker ------------------------------

    async getTheme() {
      await migrateSimpleKeyIfNeeded(STORAGE_KEYS.THEME);
      return new Promise(resolve => {
        getStorageArea().get([STORAGE_KEYS.THEME], result => {
          const theme = result && result[STORAGE_KEYS.THEME];
          resolve(theme === 'dark' ? 'dark' : 'light');
        });
      });
    },

    async setTheme(theme) {
      const cleanTheme = theme === 'dark' ? 'dark' : 'light';
      return enqueueWrite(async () => {
        return new Promise(resolve => {
          getStorageArea().set({ [STORAGE_KEYS.THEME]: cleanTheme }, () => resolve(cleanTheme));
        });
      });
    },

    async getPrefs() {
      const r = await areaGet(getStorageArea(), [STORAGE_KEYS.PREFS]);
      const stored = r[STORAGE_KEYS.PREFS] && typeof r[STORAGE_KEYS.PREFS] === 'object' ? r[STORAGE_KEYS.PREFS] : {};
      const out = Object.assign({}, PREF_DEFAULTS);
      Object.keys(PREF_DEFAULTS).forEach(k => {
        if (stored[k] !== undefined && typeof stored[k] === typeof PREF_DEFAULTS[k]) out[k] = stored[k];
      });
      return out;
    },

    async setPrefs(patch) {
      return enqueueWrite(async () => {
        const current = await api.getPrefs();
        const next = Object.assign({}, current);
        Object.keys(patch || {}).forEach(k => {
          if (k in PREF_DEFAULTS && typeof patch[k] === typeof PREF_DEFAULTS[k]) next[k] = patch[k];
        });
        await areaSet(getStorageArea(), { [STORAGE_KEYS.PREFS]: next });
        return next;
      });
    },

    // The tracker the popup last had selected. The global +1 shortcut logs to it.
    async getActiveMetricId() {
      const r = await areaGet(getLocalArea(), [STORAGE_KEYS.ACTIVE_METRIC]);
      const id = r[STORAGE_KEYS.ACTIVE_METRIC];
      return typeof id === 'string' && id ? id : 'jobs';
    },

    async setActiveMetricId(id) {
      if (typeof id !== 'string' || !id) return false;
      return areaSet(getLocalArea(), { [STORAGE_KEYS.ACTIVE_METRIC]: id });
    },

    // ----- Events ----------------------------------------------------------

    // Timer records sit deliberately outside onChanged's key filter: a
    // countdown transition must not drag a full overlay re-render with it.
    onTimerChanged(key, cb) {
      if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[key]) cb(changes[key].newValue);
        });
      }
    },

    // Log writes arrive as changes.logs = { op, ids, rev }; the history itself
    // is never shipped with the event, so a write stays O(1) at any size.
    onChanged(cb) {
      if (typeof chrome !== 'undefined' && chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'sync' && area !== 'local') return;
          const out = {};
          if (changes[STORAGE_KEYS.LOGS_REV]) {
            out.logs = Object.assign({ op: 'change', ids: [] }, changes[STORAGE_KEYS.LOGS_REV].newValue || {});
          }
          ['metrics', 'pt_auth_user', 'pt_visible_metrics', 'pt_theme', 'pt_widgets', 'pt_prefs'].forEach(k => {
            if (changes[k]) out[k] = changes[k];
          });
          if (!Object.keys(out).length) return;
          cb(out);
        });
      }
    },

    // Service worker only: answers log calls proxied from content scripts.
    serveRemote() {
      if (typeof chrome === 'undefined' || !chrome || !chrome.runtime || !chrome.runtime.onMessage) return false;
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.type !== REMOTE_MESSAGE) return false;
        if (sender && sender.id && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
        if (!REMOTE_METHODS.includes(msg.method)) {
          sendResponse({ ok: false, error: 'Unknown storage method: ' + msg.method });
          return false;
        }
        Promise.resolve()
          .then(() => localImpl[msg.method].apply(api, decodeArgs(msg.args)))
          .then(
            result => sendResponse({ ok: true, result: result === undefined ? null : result }),
            err => sendResponse({ ok: false, error: (err && err.message) || String(err) })
          );
        return true;
      });
      return true;
    },

    REMOTE_METHODS,

    // Test seams.
    _setMode(mode) {
      forcedMode = mode || null;
      resolvedMode = null;
      backendPromise = null;
      migrationRun = null;
    },
    _mode() {
      return currentMode();
    },
    async _backendName() {
      if (currentMode() === 'remote') return 'remote';
      return (await getBackend()).name;
    },
    _cleanupLegacySync: cleanupLegacySync
  };

  // In a content script the log methods run in the service worker. The
  // wrappers decide per call, so a test (or a context that learns late that
  // it has messaging) always gets the right path.
  const localImpl = {};
  REMOTE_METHODS.forEach(name => {
    const impl = api[name];
    localImpl[name] = impl;
    api[name] = function () {
      if (currentMode() === 'remote') return callRemote(name, arguments);
      return impl.apply(api, arguments);
    };
  });

  return api;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrackerStorage;
}
