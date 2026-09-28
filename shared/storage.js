// Shared storage manager for Job & Activity Tracker
const TrackerStorage = (() => {
  const STORAGE_KEYS = {
    LOGS: 'logs',
    METRICS: 'metrics',
    AUTH: 'pt_auth_user',
    VISIBLE_METRICS: 'pt_visible_metrics',
    THEME: 'pt_theme'
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

  // Write queue mutex to serialize concurrent writes to chrome.storage.sync
  let writeLock = Promise.resolve();

  function enqueueWrite(fn) {
    const next = writeLock.then(() => fn(), () => fn());
    writeLock = next.catch(() => {});
    return next;
  }

  function readRaw(key) {
    return new Promise(resolve => {
      getStorageArea().get([key], result => resolve(result));
    });
  }

  function writeRaw(key, value) {
    return new Promise(resolve => {
      getStorageArea().set({ [key]: value }, () => resolve(true));
    });
  }

  // The mutex above only serializes writers inside a single JS context, and the
  // popup and the content script each load their own copy of this module against
  // one shared chrome.storage.sync. chrome.storage has no compare-and-swap, so
  // a read-modify-write here can still be clobbered by the other context.
  // Re-read after every write and re-apply the mutation when that happens.
  const MAX_WRITE_ATTEMPTS = 5;

  // apply(currentValue, alreadyWrote) must return either
  //   { write: false, result }                       -> nothing to do
  //   { write: true, value, verify(readBack), result } -> write and confirm
  // readCurrent/writeValue abstract over a plain single-key value (metrics)
  // and the chunked logs array, so both share this retry loop.
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

  function normalizeEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const trimmed = email.trim().toLowerCase();
    return trimmed.length > 0 ? trimmed : null;
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

  // chrome.storage.sync carries data across every device signed into the same
  // Chrome profile; chrome.storage.local never leaves this machine. Falling
  // back to local (and, failing that, to a localStorage-backed shim) keeps a
  // sync-less Chrome build or a bare test mock working, just without the
  // cross-device carry-over.
  function getStorageArea() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      if (chrome.storage.sync) return chrome.storage.sync;
      if (chrome.storage.local) return chrome.storage.local;
    }
    return {
      get: (keys, cb) => {
        const result = {};
        const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
        keyList.forEach(k => {
          if (typeof localStorage !== 'undefined') {
            const val = localStorage.getItem(k);
            if (val !== null && val !== undefined) {
              try { result[k] = JSON.parse(val); } catch (e) { result[k] = val; }
            }
          }
        });
        if (cb) cb(result);
      },
      set: (items, cb) => {
        if (typeof localStorage !== 'undefined') {
          Object.entries(items).forEach(([k, v]) => {
            localStorage.setItem(k, JSON.stringify(v));
          });
        }
        if (cb) cb();
      },
      remove: (keys, cb) => {
        if (typeof localStorage !== 'undefined') {
          (Array.isArray(keys) ? keys : [keys]).forEach(k => localStorage.removeItem(k));
        }
        if (cb) cb();
      }
    };
  }

  // A device upgrading from a local-only build still has its history sitting
  // in chrome.storage.local; sync starts out empty on every device until this
  // runs once. Only copies when sync has nothing yet, so it can never clobber
  // data another device already synced in.
  const migratedKeys = {};
  async function migrateSimpleKeyIfNeeded(key) {
    if (migratedKeys[key]) return;
    migratedKeys[key] = true;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync || !chrome.storage.local) return;
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

  function safeGetLogs(result) {
    return Array.isArray(result && result[STORAGE_KEYS.LOGS]) ? result[STORAGE_KEYS.LOGS] : [];
  }

  function safeGetMetrics(result) {
    return Array.isArray(result && result[STORAGE_KEYS.METRICS]) ? result[STORAGE_KEYS.METRICS] : [];
  }

  // The logs array is the one value that can realistically outgrow sync's
  // 8KB-per-item quota, so it is never stored as a single 'logs' item there.
  // It is split across 'logs__c0', 'logs__c1', ... with 'logs__meta' naming
  // how many chunks exist. LOGS_CHUNK_BUDGET leaves headroom under the 8192
  // byte cap for JSON overhead and multi-byte characters.
  const LOGS_META_KEY = 'logs__meta';
  const LOGS_CHUNK_BUDGET = 6000;

  function logsChunkKey(i) {
    return 'logs__c' + i;
  }

  function byteSize(value) {
    try { return JSON.stringify(value).length; } catch (e) { return Infinity; }
  }

  function chunkLogs(logs) {
    if (logs.length === 0) return [];
    const chunks = [];
    let current = [];
    logs.forEach(log => {
      const trial = current.concat([log]);
      if (current.length > 0 && byteSize(trial) > LOGS_CHUNK_BUDGET) {
        chunks.push(current);
        current = [log];
      } else {
        current = trial;
      }
    });
    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  // Once real chrome.storage.sync and chrome.storage.local both exist, sync
  // is the primary target and local is available as an overflow bucket. In
  // any other environment (a bare mock, or a sync-less Chrome build already
  // falling back to local through getStorageArea) there is nothing to
  // overflow into, so the chunks just live wherever getStorageArea() points.
  function hasRealSyncAndLocal() {
    return typeof chrome !== 'undefined' && chrome.storage && !!chrome.storage.sync && !!chrome.storage.local;
  }

  const LOGS_OVERFLOW_KEY = 'logs_overflow';

  // Read path also accepts the old unchunked 'logs' array, so a value written
  // by a pre-sync build (or poked directly in a test) is never mistaken for
  // empty storage: it is only ever missing once real chunks exist.
  function readChunked(area) {
    return new Promise(resolve => {
      area.get([LOGS_META_KEY, STORAGE_KEYS.LOGS], metaResult => {
        const meta = metaResult && metaResult[LOGS_META_KEY];
        const count = meta && typeof meta.count === 'number' && meta.count >= 0 ? meta.count : null;
        if (count === null) {
          resolve(safeGetLogs(metaResult));
          return;
        }
        if (count === 0) {
          resolve([]);
          return;
        }
        const keys = [];
        for (let i = 0; i < count; i++) keys.push(logsChunkKey(i));
        area.get(keys, chunkResult => {
          let logs = [];
          for (let i = 0; i < count; i++) {
            const chunk = chunkResult[logsChunkKey(i)];
            if (Array.isArray(chunk)) logs = logs.concat(chunk);
          }
          resolve(logs);
        });
      });
    });
  }

  // Writes safeLogs, chunked, into area. Resolves false (instead of
  // rejecting) when the browser reports a quota error, so the caller can fall
  // back instead of losing the write.
  function writeChunked(area, safeLogs) {
    const chunks = chunkLogs(safeLogs);
    return new Promise(resolve => {
      area.get([LOGS_META_KEY], metaResult => {
        const prevMeta = metaResult && metaResult[LOGS_META_KEY];
        const prevCount = prevMeta && typeof prevMeta.count === 'number' ? prevMeta.count : 0;
        const items = { [LOGS_META_KEY]: { count: chunks.length } };
        chunks.forEach((chunk, i) => { items[logsChunkKey(i)] = chunk; });
        area.set(items, () => {
          const failed = typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError;
          if (failed) { resolve(false); return; }
          if (prevCount > chunks.length) {
            const stale = [];
            for (let i = chunks.length; i < prevCount; i++) stale.push(logsChunkKey(i));
            area.remove(stale, () => resolve(true));
          } else {
            resolve(true);
          }
        });
      });
    });
  }

  // chrome.storage.sync's 100KB total quota is shared by every device signed
  // into the account, so it fills the same way everywhere: once it does, the
  // full array (not just the new entry) is kept in chrome.storage.local under
  // LOGS_OVERFLOW_KEY so nothing this device wrote is ever lost, even though
  // it stops reaching other devices from that point. A device with no
  // overflow yet still reads straight from sync, which is the up-to-date
  // shared picture; a later write that fits again (history trimmed, or more
  // quota freed up) clears the overflow, since sync is once more complete.
  function readLogsRaw() {
    return migrateLogsIfNeeded().then(() => {
      if (!hasRealSyncAndLocal()) return readChunked(getStorageArea());
      return new Promise(resolve => chrome.storage.local.get([LOGS_OVERFLOW_KEY], r => {
        resolve(Array.isArray(r[LOGS_OVERFLOW_KEY]) ? r[LOGS_OVERFLOW_KEY] : null);
      })).then(overflowLogs => {
        // Every write while overflowing rewrites the FULL array into
        // overflow, so once it exists it is already the complete picture for
        // this device; re-merging the (now stale, frozen) sync snapshot back
        // in would resurrect anything deleted since overflow started.
        if (overflowLogs !== null) return overflowLogs;
        return readChunked(chrome.storage.sync);
      });
    });
  }

  function writeLogsRaw(logs) {
    const safeLogs = Array.isArray(logs) ? logs : [];
    if (!hasRealSyncAndLocal()) {
      return writeChunked(getStorageArea(), safeLogs).then(() => {});
    }
    return writeChunked(chrome.storage.sync, safeLogs).then(ok => {
      if (ok) {
        return new Promise(resolve => chrome.storage.local.remove([LOGS_OVERFLOW_KEY], resolve));
      }
      return new Promise(resolve => chrome.storage.local.set({ [LOGS_OVERFLOW_KEY]: safeLogs }, resolve));
    });
  }

  let logsMigrated = false;
  async function migrateLogsIfNeeded() {
    if (logsMigrated) return;
    logsMigrated = true;
    if (!hasRealSyncAndLocal()) return;
    try {
      const syncMeta = await new Promise(r => chrome.storage.sync.get([LOGS_META_KEY, STORAGE_KEYS.LOGS], r));
      const overflowResult = await new Promise(r => chrome.storage.local.get([LOGS_OVERFLOW_KEY], r));
      const alreadyMigrated = (syncMeta && (syncMeta[LOGS_META_KEY] !== undefined || syncMeta[STORAGE_KEYS.LOGS] !== undefined)) ||
        (overflowResult && Array.isArray(overflowResult[LOGS_OVERFLOW_KEY]));
      if (alreadyMigrated) return;
      const localResult = await new Promise(r => chrome.storage.local.get([STORAGE_KEYS.LOGS], r));
      const localLogs = safeGetLogs(localResult);
      if (localLogs.length > 0) await writeLogsRaw(localLogs);
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

  return {
    STORAGE_KEYS,
    DEFAULT_METRICS,
    getLocalDateStr,
    parseLocalDateToNoon,
    addDays,
    normalizeEmail,

    async getMetrics(userEmailOverride) {
      const targetEmail = normalizeEmail(userEmailOverride !== undefined ? userEmailOverride : await getCurrentUserEmail());
      let allMetrics = await readMetricsRaw();
      if (allMetrics.length === 0) {
        allMetrics = [...DEFAULT_METRICS];
        seedDefaultMetrics();
      }
      return allMetrics.map(m => {
        const dailyGoal = m.dailyGoal || defaultGoalFor(m.id);
        return { ...m, dailyGoal };
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

    async getActivityHistory(daysCount = 30, metricId = null, userEmailOverride) {
      const days = Math.max(1, Math.min(90, parseInt(daysCount, 10) || 30));
      let targetMetricId = null;
      let targetEmailOverride = userEmailOverride;
      if (typeof metricId === 'string' && metricId.includes('@')) {
        targetEmailOverride = metricId;
        targetMetricId = null;
      } else {
        targetMetricId = metricId;
      }

      const targetEmail = normalizeEmail(targetEmailOverride !== undefined ? targetEmailOverride : await getCurrentUserEmail());
      const [metrics, logs] = await Promise.all([
        this.getMetrics(targetEmail),
        this.getLogs(targetMetricId ? { metricId: targetMetricId } : {}, targetEmail)
      ]);

      const now = new Date();
      const todayStr = getLocalDateStr(now);

      const dailyMap = {};
      logs.forEach(l => {
        if (!dailyMap[l.date]) dailyMap[l.date] = { total: 0, byMetric: {} };
        const cnt = l.count || 1;
        dailyMap[l.date].total += cnt;
        dailyMap[l.date].byMetric[l.metricId] = (dailyMap[l.date].byMetric[l.metricId] || 0) + cnt;
      });

      const historyDays = [];
      let totalCount = 0;
      let activeDaysCount = 0;
      let bestDay = { date: todayStr, count: 0 };

      for (let i = days - 1; i >= 0; i--) {
        const dStr = addDays(todayStr, -i);
        const dayData = dailyMap[dStr] || { total: 0, byMetric: {} };
        const dayTotal = targetMetricId ? (dayData.byMetric[targetMetricId] || 0) : dayData.total;
        totalCount += dayTotal;
        if (dayTotal > 0) activeDaysCount++;
        if (dayTotal > bestDay.count) {
          bestDay = { date: dStr, count: dayTotal };
        }

        const dateParts = dStr.split('-');
        const monthNum = parseInt(dateParts[1], 10);
        const dayNum = parseInt(dateParts[2], 10);
        const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][monthNum - 1];

        historyDays.push({
          date: dStr,
          label: `${monthShort} ${dayNum}`,
          count: dayTotal,
          byMetric: dayData.byMetric
        });
      }

      const dailyAverage = days > 0 ? (totalCount / days).toFixed(1) : '0.0';

      return {
        days: historyDays,
        totalCount,
        dailyAverage: parseFloat(dailyAverage),
        activeDaysCount,
        bestDay,
        metrics
      };
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
          const isAuthorized = (!targetEmail && !owner) || (targetEmail && owner === targetEmail);
          if (!isAuthorized) return { write: false, result: false };
          return {
            write: true,
            value: allMetrics.filter(m => !m || m.id !== id),
            verify: isGone,
            result: true
          };
        });
      });
    },

    async getLogs(filter = {}, userEmailOverride) {
      let metricId = null;
      let startDate = null;
      let endDate = null;
      let targetUserEmail = undefined;

      if (typeof filter === 'string') {
        metricId = filter;
        if (userEmailOverride !== undefined) {
          targetUserEmail = userEmailOverride;
        }
      } else if (filter && typeof filter === 'object') {
        metricId = filter.metricId || null;
        startDate = filter.startDate || null;
        endDate = filter.endDate || null;
        if (filter.userEmail !== undefined) {
          targetUserEmail = filter.userEmail;
        } else if (userEmailOverride !== undefined) {
          targetUserEmail = userEmailOverride;
        }
      }

      if (targetUserEmail === undefined) {
        targetUserEmail = await getCurrentUserEmail();
      }
      const normalizedTarget = normalizeEmail(targetUserEmail);

      const rawLogs = await readLogsRaw();
      const indexed = rawLogs.map((l, index) => ({ log: l, originalIndex: index }));
      const filtered = indexed.filter(item => {
        const l = item.log;
        if (!l) return false;
        const logEmail = normalizeEmail(l.userEmail);
        if (!normalizedTarget) {
          if (logEmail) return false;
        } else {
          if (logEmail !== normalizedTarget) return false;
        }
        if (metricId && l.metricId !== metricId) return false;
        if (startDate && l.date < startDate) return false;
        if (endDate && l.date > endDate) return false;
        return true;
      });

      // Sort by timestamp descending; tie-breaker: reverse original insertion order (LIFO)
      filtered.sort((a, b) => {
        const timeA = new Date(a.log.timestamp || a.log.date || 0).getTime();
        const timeB = new Date(b.log.timestamp || b.log.date || 0).getTime();
        const diff = timeB - timeA;
        if (diff !== 0) return diff;
        return b.originalIndex - a.originalIndex;
      });

      return filtered.map(item => item.log);
    },

    async addLog(logData = {}, userEmailOverride) {
      return enqueueWrite(async () => {
        const customEmail = logData.userEmail !== undefined ? logData.userEmail : userEmailOverride;
        const userEmail = normalizeEmail(customEmail !== undefined ? customEmail : await getCurrentUserEmail());
        const now = new Date();

        const newLog = {
          id: 'log-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7),
          metricId: logData.metricId || 'jobs',
          userEmail: userEmail || null,
          count: Math.max(1, parseInt(logData.count, 10) || 1),
          date: logData.date || getLocalDateStr(now),
          timestamp: now.toISOString(),
          company: (logData.company || '').trim(),
          role: (logData.role || '').trim(),
          notes: (logData.notes || '').trim(),
          solveTimeSeconds: Math.max(0, parseInt(logData.solveTimeSeconds, 10) || 0),
        };

        const hasLog = list => list.some(l => l && l.id === newLog.id);
        return mutateVerified(readLogsRaw, writeLogsRaw, logs => {
          if (hasLog(logs)) return { write: false, result: newLog };
          return { write: true, value: logs.concat([newLog]), verify: hasLog, result: newLog };
        });
      });
    },

    async deleteLog(id, userEmailOverride) {
      if (!id) return false;
      return enqueueWrite(async () => {
        const targetEmail = normalizeEmail(userEmailOverride !== undefined ? userEmailOverride : await getCurrentUserEmail());
        const isGone = list => !list.some(l => l && l.id === id);
        return mutateVerified(readLogsRaw, writeLogsRaw, (logs, alreadyWrote) => {
          const log = logs.find(l => l && l.id === id);
          if (!log) return { write: false, result: alreadyWrote };
          const logEmail = normalizeEmail(log.userEmail);
          const isAuthorized = (!targetEmail && !logEmail) || (targetEmail && logEmail === targetEmail);
          if (!isAuthorized) return { write: false, result: false };
          return {
            write: true,
            value: logs.filter(l => !l || l.id !== id),
            verify: isGone,
            result: true
          };
        });
      });
    },

    async undoLastLog(metricId = 'jobs', date, userEmailOverride) {
      return enqueueWrite(async () => {
        const targetDate = date || getLocalDateStr();
        const targetEmail = normalizeEmail(userEmailOverride !== undefined ? userEmailOverride : await getCurrentUserEmail());
        return mutateVerified(readLogsRaw, writeLogsRaw, (logs, alreadyWrote) => {
          const indexed = logs.map((l, index) => ({ log: l, originalIndex: index }));
          const filtered = indexed.filter(item => {
            const l = item.log;
            if (!l || l.metricId !== metricId || l.date !== targetDate) return false;
            const logEmail = normalizeEmail(l.userEmail);
            if (!targetEmail) return !logEmail;
            return logEmail === targetEmail;
          });

          // Nothing left to undo. Counts must never be driven negative.
          if (filtered.length === 0) return { write: false, result: alreadyWrote };

          filtered.sort((a, b) => {
            const timeA = new Date(a.log.timestamp || a.log.date || 0).getTime();
            const timeB = new Date(b.log.timestamp || b.log.date || 0).getTime();
            const diff = timeB - timeA;
            if (diff !== 0) return diff;
            return b.originalIndex - a.originalIndex;
          });

          const newestId = filtered[0].log.id;
          return {
            write: true,
            value: logs.filter(l => !l || l.id !== newestId),
            verify: list => !list.some(l => l && l.id === newestId),
            result: true
          };
        });
      });
    },

    async getStats(metricIdOrEmail, userEmailOverride) {
      let targetEmail = undefined;
      if (typeof metricIdOrEmail === 'string' && metricIdOrEmail.includes('@')) {
        targetEmail = metricIdOrEmail;
      } else if (userEmailOverride !== undefined) {
        targetEmail = userEmailOverride;
      } else {
        targetEmail = await getCurrentUserEmail();
      }

      const [metrics, logs] = await Promise.all([
        this.getMetrics(targetEmail),
        this.getLogs({}, targetEmail)
      ]);
      const now = new Date();
      const todayStr = getLocalDateStr(now);
      const weekAgoStr = addDays(todayStr, -6);
      const startOfMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

      const today = {};
      const thisWeek = {};
      const thisMonth = {};
      const totals = {};
      const dailyMap = {};

      metrics.forEach(m => {
        today[m.id] = 0;
        thisWeek[m.id] = 0;
        thisMonth[m.id] = 0;
        totals[m.id] = 0;
      });

      logs.forEach(l => {
        const mId = l.metricId;
        const cnt = l.count || 1;

        totals[mId] = (totals[mId] || 0) + cnt;

        if (l.date === todayStr) {
          today[mId] = (today[mId] || 0) + cnt;
        }
        if (l.date >= weekAgoStr && l.date <= todayStr) {
          thisWeek[mId] = (thisWeek[mId] || 0) + cnt;
        }
        if (l.date >= startOfMonthStr && l.date <= todayStr) {
          thisMonth[mId] = (thisMonth[mId] || 0) + cnt;
        }

        if (!dailyMap[l.date]) dailyMap[l.date] = {};
        dailyMap[l.date][mId] = (dailyMap[l.date][mId] || 0) + cnt;
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
      const currentStreak = streaks.jobs || 0;

      return {
        todayStr,
        metrics,
        today,
        thisWeek,
        thisMonth,
        totals,
        totalLogs: logs.length,
        currentStreak,
        streaks,
        longestStreaks,
        weeklyAverages,
        dailyMap
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
      if (hrs > 0) {
        return hrs + 'h ' + mins + 'm';
      }
      if (mins > 0 && secs > 0) {
        return mins + 'm ' + secs + 's';
      }
      if (mins > 0) {
        return mins + 'm';
      }
      return secs + 's';
    },

    async getLeetcodeTimeStats(userEmailOverride) {
      const logs = await this.getLogs({ metricId: 'leetcode' }, userEmailOverride);
      const today = getLocalDateStr();
      let totalSeconds = 0;
      let todaySeconds = 0;
      let sessionCount = 0;
      let todaySessionCount = 0;

      logs.forEach(l => {
        const sec = parseInt(l.solveTimeSeconds, 10) || 0;
        if (sec > 0) {
          totalSeconds += sec;
          sessionCount++;
          if (l.date === today) {
            todaySeconds += sec;
            todaySessionCount++;
          }
        }
      });

      const avgSeconds = sessionCount > 0 ? Math.round(totalSeconds / sessionCount) : 0;

      return {
        totalSeconds,
        todaySeconds,
        sessionCount,
        todaySessionCount,
        avgSeconds
      };
    },

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

    // Timer records sit deliberately outside onChanged's key filter: a
    // countdown transition must not drag a full overlay re-render with it.
    onTimerChanged(key, cb) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && changes[key]) cb(changes[key].newValue);
        });
      }
    },

    onChanged(cb) {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'sync' && area !== 'local') return;
          const logsTouched = Object.keys(changes).some(k => k === LOGS_META_KEY || k === LOGS_OVERFLOW_KEY || k.indexOf('logs__c') === 0);
          const hasOther = changes.logs || changes.metrics || changes.pt_auth_user || changes.pt_visible_metrics || changes.pt_theme || changes.pt_widgets;
          if (!logsTouched && !hasOther) return;
          if (!logsTouched) {
            cb(changes);
            return;
          }
          // The chunked keys are an implementation detail: reassemble the
          // full array so listeners still see a plain changes.logs.newValue.
          readLogsRaw().then(logs => {
            cb(Object.assign({}, changes, { logs: { newValue: logs } }));
          });
        });
      }
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TrackerStorage;
}
