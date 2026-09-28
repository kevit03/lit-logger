// Google Calendar Content Script — LIT
//
// Shows each day's counts over Google Calendar, in a layer of our own that
// never touches Calendar's DOM, with a quick-add button per day. Everything
// else (timers, charts, the tracker list, sign-in) lives in the popup.
(() => {
  let metrics = [];
  let stats = null;
  let currentTheme = 'light';
  let observer = null;
  let debounceTimer = null;
  let tornDown = false;

  // After the extension is reloaded or updated, this copy of the script keeps
  // running on any Calendar tab that was already open, with no way back to
  // storage: every chrome.* call throws "Extension context invalidated".
  // Notice it, take our chrome off the page, and go quiet. A page refresh
  // brings in the live copy.
  function isContextError(err) {
    let alive = false;
    try { alive = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id; } catch (e) { alive = false; }
    return !alive || /Extension context invalidated/i.test(String(err && err.message || err));
  }

  function teardown() {
    if (tornDown) return;
    tornDown = true;
    if (observer) observer.disconnect();
    clearTimeout(debounceTimer);
    document.querySelectorAll('#pt-layer, .pt-cell-overlay, .pt-quick-add-cell, #pt-day-modal').forEach(n => n.remove());
  }

  // Theme is chosen in the popup and mirrored here for the day modal.
  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    document.querySelectorAll('.pt-modal-dialog').forEach(dlg => {
      dlg.classList.toggle('pt-dark', currentTheme === 'dark');
    });
  }

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  const MONTHS_MAP = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3,
    april: 4, apr: 4, may: 5, june: 6, jun: 6,
    july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9,
    october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
  };

  function dateFromDateKey(key) {
    const num = parseInt(key, 10);
    if (isNaN(num)) return null;

    // 1. Google Calendar internal bitshift encoding:
    // dateKey = (year - 1970) * 512 + (month - 1) * 32 + day + 32
    // The floor is the key for 1990-01-01. It used to be 25000, which is roughly
    // 2018-12; every earlier month fell through to the epoch-days branch below
    // and decoded ~19 years into the future, so the quick-add button on those
    // cells logged entries against the wrong date.
    if (num >= (1990 - 1970) * 512) {
      const yearOffset = (num - 32) % 512;
      const year = Math.floor((num - 32 - yearOffset) / 512) + 1970;
      const day = yearOffset % 32;
      const month = Math.floor((yearOffset - day) / 32) + 1;
      if (year >= 1970 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }

    // 2. Fallback: Days since Unix epoch (or test mock)
    const ms = num * 86400000 + 43200000;
    const d = new Date(ms);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function parseDateFromElement(el) {
    if (!el) return null;

    // 1. Calendar's own data-datekey is exact, so it wins. An aria-label is
    // only consulted when the cell has no key: the first labelled child is
    // often an event chip, and a multi-day event names a different day.
    if (el.dataset && el.dataset.datekey) {
      const d = dateFromDateKey(el.dataset.datekey);
      if (d) return d;
    }
    const childWithKey = el.querySelector && el.querySelector('[data-datekey]');
    if (childWithKey && childWithKey.dataset && childWithKey.dataset.datekey) {
      const d = dateFromDateKey(childWithKey.dataset.datekey);
      if (d) return d;
    }

    // 2. data-date (ISO YYYY-MM-DD)
    if (el.dataset && el.dataset.date && /^\d{4}-\d{2}-\d{2}$/.test(el.dataset.date)) {
      return el.dataset.date;
    }
    const childDate = el.querySelector && el.querySelector('[data-date]');
    if (childDate && childDate.dataset && childDate.dataset.date && /^\d{4}-\d{2}-\d{2}$/.test(childDate.dataset.date)) {
      return childDate.dataset.date;
    }

    // 3. aria-label on the element or a child header or button
    const labelSources = [
      el.getAttribute && el.getAttribute('aria-label'),
      el.querySelector && el.querySelector('[aria-label]') && el.querySelector('[aria-label]').getAttribute('aria-label'),
      el.querySelector && el.querySelector('h2, [role="heading"], button') && (el.querySelector('h2, [role="heading"], button').getAttribute('aria-label') || el.querySelector('h2, [role="heading"], button').textContent)
    ];

    for (const label of labelSources) {
      if (!label) continue;

      // Day-first: "2 September 2026", "2nd September 2026", "2 Sep"
      const mDayFirst = label.match(/\b(\d{1,2})(?:st|nd|rd|th)?[,\s]+\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b(?:[,\s]+(\d{4}))?/i);
      if (mDayFirst) {
        const day = parseInt(mDayFirst[1], 10);
        const month = MONTHS_MAP[mDayFirst[2].toLowerCase()];
        const year = mDayFirst[3] ? parseInt(mDayFirst[3], 10) : new Date().getFullYear();
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }

      // Month-first: "September 2, 2026", "September 2nd", "Wednesday, September 2"
      const mMonthFirst = label.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b[,\s]+(\d{1,2})(?:st|nd|rd|th)?\b(?:[,\s]+(\d{4}))?/i);
      if (mMonthFirst) {
        const month = MONTHS_MAP[mMonthFirst[1].toLowerCase()];
        const day = parseInt(mMonthFirst[2], 10);
        const year = mMonthFirst[3] ? parseInt(mMonthFirst[3], 10) : new Date().getFullYear();
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
          return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }
    }

    return null;
  }

  // Entry text is user-supplied and is interpolated into innerHTML below, so a
  // company name containing "<" or "&" would otherwise corrupt or inject markup.
  function escapeHtml(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateNice(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function metricsMap() {
    const m = {};
    metrics.forEach(x => { m[x.id] = x; });
    return m;
  }

  // ---------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------
  // Storage events, auth events and runtime messages can all land at once.
  // Chain refreshes so two overlapping passes cannot finish out of order and
  // paint the older snapshot over the newer one.
  let refreshChain = Promise.resolve();

  function refreshData() {
    refreshChain = refreshChain.then(doRefreshData, doRefreshData);
    return refreshChain;
  }

  async function doRefreshData() {
    if (tornDown) return;
    try {
      [metrics, stats] = await Promise.all([
        TrackerStorage.getMetrics(),
        TrackerStorage.getStats()
      ]);
    } catch (err) {
      if (isContextError(err)) teardown();
      else console.warn('LIT: could not read tracker data', err);
      return;
    }
    renderBadges();
  }

  // ---------------------------------------------------------------
  // 1. DAY BADGES
  // ---------------------------------------------------------------
  // Nothing is inserted into Google's grid. Badges live in one fixed layer of
  // our own and are positioned from each day's rectangle, so Calendar's
  // layout, and the event and task chips inside it, are never touched.
  //
  // Where a day is anchored:
  //   Week and Day views  the column header, beside the date number
  //   Month view          the day cell's date line, right-aligned
  // Each day gets one .pt-day wrapper holding its count pills and a quick-add
  // button that shows while that day is hovered.
  const LAYER_ID = 'pt-layer';
  const days = new Map();            // dateStr -> { node, anchor, kind }
  let hoverTargets = new WeakMap();  // any element that decodes to a day -> dateStr
  let hoveredDate = null;
  let layoutRaf = 0;

  function layerNode() {
    let node = document.getElementById(LAYER_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = LAYER_ID;
      document.body.appendChild(node);
    }
    return node;
  }

  function isOutsideGrid(el) {
    return !!(el.closest && el.closest('aside, nav, [role="rowheader"]'));
  }

  // One anchor per date. A column header wins when it carries a date (Week
  // and Day views); otherwise the lowest day cell that decodes to the date,
  // which in Week view is the timed column rather than the all-day strip.
  function findAnchors() {
    const found = {};
    hoverTargets = new WeakMap();

    document.querySelectorAll('[role="columnheader"]').forEach(h => {
      if (isOutsideGrid(h)) return;
      const d = parseDateFromElement(h);
      if (!d) return;
      hoverTargets.set(h, d);
      if (!found[d]) found[d] = { anchor: h, kind: 'header' };
    });

    document.querySelectorAll('[role="gridcell"]').forEach(cell => {
      if (isOutsideGrid(cell) || cell.closest('[role="columnheader"], header')) return;
      if (cell.offsetHeight > 0 && cell.offsetHeight < 50) return;
      const d = parseDateFromElement(cell);
      if (!d) return;
      hoverTargets.set(cell, d);
      const cur = found[d];
      if (cur && cur.kind === 'header') return;
      const top = cell.getBoundingClientRect().top || 0;
      if (!cur || top >= cur.top) found[d] = { anchor: cell, kind: 'cell', top };
    });
    return found;
  }

  // "1 Job Application", "2 Job Applications", "1 LeetCode": the tracker's
  // own name, singular for one when it looks plural.
  function metricLabel(m, count) {
    let name = m.name || m.id;
    if (count === 1 && /[^s]s$/i.test(name)) name = name.slice(0, -1);
    return count + ' ' + name;
  }

  function dayStateKey(dateStr) {
    const counts = stats.dailyMap[dateStr] || {};
    return metrics.map(m => {
      const count = counts[m.id] || 0;
      if (count <= 0) return '';
      return m.id + ':' + count + ':' + m.color + ':' + ((m.dailyGoal && count >= m.dailyGoal) ? 1 : 0);
    }).filter(Boolean).join('|');
  }

  function buildPills(overlay, dateStr) {
    overlay.textContent = '';
    const counts = stats.dailyMap[dateStr] || {};
    metrics.forEach(m => {
      const count = counts[m.id] || 0;
      if (count <= 0) return;
      const isGoalMet = !!(m.dailyGoal && count >= m.dailyGoal);
      const badge = document.createElement('div');
      badge.className = 'pt-badge' + (isGoalMet ? ' pt-goal-met' : '');
      badge.style.backgroundColor = isGoalMet ? m.color : m.color + '22';
      badge.style.color = isGoalMet ? '#ffffff' : m.color;
      const label = metricLabel(m, count);
      badge.title = label + (isGoalMet ? ' (goal met)' : ' (goal ' + (m.dailyGoal || 1) + ')');
      const dot = document.createElement('span');
      dot.className = 'pt-badge-dot';
      dot.style.backgroundColor = isGoalMet ? '#ffffff' : m.color;
      // Count and name are separate so a narrow column can keep the count.
      const text = document.createElement('span');
      text.className = 'pt-badge-text';
      const num = document.createElement('span');
      num.className = 'pt-badge-count';
      num.textContent = String(count);
      const name = document.createElement('span');
      name.className = 'pt-badge-name';
      name.textContent = label.slice(String(count).length);
      text.appendChild(num);
      text.appendChild(name);
      badge.appendChild(dot);
      badge.appendChild(text);
      overlay.appendChild(badge);
    });
  }

  function makeDayNode(dateStr) {
    const node = document.createElement('div');
    node.className = 'pt-day';
    node.dataset.date = dateStr;
    const overlay = document.createElement('div');
    overlay.className = 'pt-cell-overlay';
    const addBtn = document.createElement('button');
    addBtn.className = 'pt-quick-add-cell';
    addBtn.type = 'button';
    addBtn.title = 'Log entry for ' + dateStr;
    addBtn.setAttribute('aria-label', 'Log entry for ' + dateStr);
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      openDayModal(dateStr, true);
    });
    node.appendChild(overlay);
    node.appendChild(addBtn);
    return node;
  }

  function positionDay(entry) {
    const r = entry.anchor.getBoundingClientRect();
    const node = entry.node;
    if (!r.width || !r.height) {
      node.style.display = 'none';
      return;
    }
    node.style.display = '';
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    if (entry.kind === 'header') {
      // Stacked down the header's right edge: pills on the weekday line,
      // the quick-add button beside the date number below it. The number is
      // centred, so right-aligning a single row would run under it.
      node.style.top = Math.round(r.top + 6) + 'px';
      node.style.right = Math.round(viewportWidth - r.right + 8) + 'px';
      node.style.height = Math.max(0, Math.round(r.height - 14)) + 'px';
      node.style.maxWidth = Math.max(0, Math.round(r.width - 16)) + 'px';
    } else {
      // The right part of the date line only, clear of the centred number.
      node.style.top = Math.round(r.top + 4) + 'px';
      node.style.right = Math.round(viewportWidth - r.right + 4) + 'px';
      node.style.height = '';
      node.style.maxWidth = Math.max(0, Math.round(r.width * 0.6)) + 'px';
    }
    // Words when they fit, counts alone when any pill would be cut short.
    node.classList.remove('pt-compact');
    const texts = node.querySelectorAll('.pt-badge-text');
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].scrollWidth > texts[i].clientWidth + 1) {
        node.classList.add('pt-compact');
        break;
      }
    }
  }

  function layoutDays() {
    layoutRaf = 0;
    days.forEach(positionDay);
  }

  function scheduleLayout() {
    if (tornDown || layoutRaf) return;
    if (typeof requestAnimationFrame === 'function') {
      layoutRaf = requestAnimationFrame(layoutDays);
    } else {
      layoutRaf = setTimeout(layoutDays, 0);
    }
  }

  // Reconciles the layer against the days currently on screen: one node per
  // date, pills rebuilt only when that day's counts changed.
  function renderBadges() {
    if (tornDown || !stats || !stats.dailyMap || !metrics.length) return;

    // Nodes an earlier version put inside Google's cells.
    document.querySelectorAll('.pt-cell-overlay, .pt-quick-add-cell').forEach(n => {
      if (!n.closest('#' + LAYER_ID)) n.remove();
    });

    const anchors = findAnchors();
    const layer = layerNode();

    days.forEach((entry, dateStr) => {
      if (!anchors[dateStr]) {
        entry.node.remove();
        days.delete(dateStr);
      }
    });

    Object.keys(anchors).forEach(dateStr => {
      const { anchor, kind } = anchors[dateStr];
      let entry = days.get(dateStr);
      if (!entry) {
        entry = { node: makeDayNode(dateStr), anchor, kind, stateKey: null };
        days.set(dateStr, entry);
        layer.appendChild(entry.node);
      }
      entry.anchor = anchor;
      entry.kind = kind;
      entry.node.dataset.anchor = kind;
      const stateKey = dayStateKey(dateStr);
      if (stateKey !== entry.stateKey) {
        buildPills(entry.node.firstElementChild, dateStr);
        entry.stateKey = stateKey;
      }
      entry.node.classList.toggle('pt-hover', hoveredDate === dateStr);
      positionDay(entry);
    });
  }

  function setHoveredDate(dateStr) {
    if (hoveredDate === dateStr) return;
    hoveredDate = dateStr;
    days.forEach((entry, d) => entry.node.classList.toggle('pt-hover', d === dateStr));
  }

  function bindPointerTracking() {
    document.addEventListener('mouseover', (e) => {
      if (tornDown) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#' + LAYER_ID)) return;               // our own pills or button
      const host = t.closest('[role="gridcell"], [role="columnheader"]');
      setHoveredDate(host ? (hoverTargets.get(host) || null) : null);
    }, true);
    document.addEventListener('mouseleave', () => setHoveredDate(null), true);
    document.addEventListener('scroll', scheduleLayout, true);
    window.addEventListener('resize', scheduleLayout);
  }

  // ---------------------------------------------------------------
  // 2. DAY MODAL — add an entry for a date
  // ---------------------------------------------------------------
  async function openDayModal(dateStr, focusForm) {
    const old = document.getElementById('pt-day-modal');
    if (old) old.remove();

    let logs;
    try {
      logs = await TrackerStorage.getLogs({ startDate: dateStr, endDate: dateStr });
    } catch (err) {
      if (isContextError(err)) teardown();
      else console.warn('LIT: could not read entries', err);
      return;
    }
    const mMap = metricsMap();

    const backdrop = document.createElement('div');
    backdrop.id = 'pt-day-modal';
    backdrop.className = 'pt-modal-backdrop';

    // Count summary per metric
    const counts = {};
    logs.forEach(l => {
      counts[l.metricId] = (counts[l.metricId] || 0) + (l.count || 1);
    });
    const summaryParts = Object.entries(counts).map(([id, c]) => {
      const m = mMap[id];
      return c + ' ' + (m ? m.name : id);
    });
    const summaryText = summaryParts.length > 0 ? summaryParts.join(', ') : 'Nothing logged yet';

    // Metric options
    let metricOptions = '';
    metrics.forEach(m => {
      metricOptions += '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>';
    });

    backdrop.innerHTML = [
      '<div class="pt-modal-dialog' + (currentTheme === 'dark' ? ' pt-dark' : '') + '">',
        '<div class="pt-modal-header">',
          '<div>',
            '<div class="pt-modal-header-title">' + escapeHtml(formatDateNice(dateStr)) + '</div>',
            '<div class="pt-modal-header-sub">' + escapeHtml(summaryText) + '</div>',
          '</div>',
          '<button class="pt-close-btn" id="pt-modal-close">&times;</button>',
        '</div>',
        '<div class="pt-modal-body">',
          '<div class="pt-modal-form">',
            '<label>Add entry for ' + escapeHtml(dateStr) + '</label>',
            '<select id="pt-modal-metric">' + metricOptions + '</select>',
            '<div class="pt-modal-form-row">',
              '<input type="text" id="pt-modal-company" placeholder="Company or title" />',
              '<input type="text" id="pt-modal-role" placeholder="Role or tag" />',
            '</div>',
            '<input type="text" id="pt-modal-notes" placeholder="Notes or link (optional)" />',
            '<button class="pt-btn-primary" id="pt-modal-add" style="padding:6px;font-size:12px;">Add Entry</button>',
          '</div>',
        '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(backdrop);

    // Close
    backdrop.querySelector('#pt-modal-close').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });

    // Add entry, then close: the badge count is the only readout for a day.
    backdrop.querySelector('#pt-modal-add').addEventListener('click', async () => {
      const metricId = backdrop.querySelector('#pt-modal-metric').value;
      const company = backdrop.querySelector('#pt-modal-company').value;
      const role = backdrop.querySelector('#pt-modal-role').value;
      const notes = backdrop.querySelector('#pt-modal-notes').value;

      if (!metricId) return;
      try {
        await TrackerStorage.addLog({ metricId, date: dateStr, count: 1, company, role, notes });
      } catch (err) {
        backdrop.remove();
        if (isContextError(err)) teardown();
        else console.warn('LIT: could not save the entry', err);
        return;
      }
      backdrop.remove();
      await refreshData();
    });

    if (focusForm) {
      const companyInput = backdrop.querySelector('#pt-modal-company');
      if (companyInput) setTimeout(() => companyInput.focus(), 50);
    }
  }

  // ---------------------------------------------------------------
  // 3. OBSERVER & INIT
  // ---------------------------------------------------------------
  function createObserver() {
    return new MutationObserver((mutations) => {
      const isOnlyInternal = mutations && mutations.length > 0 && mutations.every(mutation => {
        const target = mutation.target;
        if (target && target.closest && (
          target.closest('#' + LAYER_ID) ||
          target.closest('.pt-modal-backdrop')
        )) {
          return true;
        }
        return false;
      });

      if (isOnlyInternal) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(renderBadges, 100);
    });
  }

  async function init() {
    let savedTheme = 'light';
    try {
      savedTheme = await TrackerStorage.getTheme();
    } catch (err) {
      if (isContextError(err)) return;
    }
    applyTheme(savedTheme);
    bindPointerTracking();
    await refreshData();
    if (tornDown) return;

    observer = createObserver();
    observer.observe(document.body, { childList: true, subtree: true });

    // Single storage listener. A second raw chrome.storage.onChanged listener
    // used to live here as well, which meant every log write ran refreshData
    // (three storage reads plus a full re-render) twice.
    TrackerStorage.onChanged((changes) => {
      if (changes && changes.pt_theme) {
        applyTheme(changes.pt_theme.newValue);
      }
      refreshData();
    });

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'PT_REFRESH') {
          TrackerStorage.getTheme().then(t => {
            applyTheme(t);
            refreshData();
          }).catch(err => {
            if (isContextError(err)) teardown();
          });
        }
        // Returning a promise from an onMessage listener is not supported in MV3.
        return false;
      });
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  // Test-only surface. `module` is undefined in a content script, so this block
  // never runs in the browser; the Node suite uses it to drive the pure helpers
  // and the badge renderer without a real browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      dateFromDateKey,
      escapeHtml,
      renderBadges,
      __setOverlayState: (next) => {
        if (next.metrics) metrics = next.metrics;
        if (next.stats) stats = next.stats;
      }
    };
  }
})();
