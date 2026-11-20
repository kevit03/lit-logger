// Google Calendar Content Script — LIT
//
// Shows each day's counts over Google Calendar, in a layer of our own that
// never touches Calendar's DOM, with a quick-add button per day. Everything
// else (timers, charts, the tracker list, sign-in) lives in the popup.
//
// The pills are the scoreboard: a tinted pill per tracker with a count, a
// filled pill with a check once that day's goal is met (shape and fill, not
// only color), a moon on a rest day with nothing logged, and a snowflake on
// a day a streak freeze covered. In Month view a small "12 this week" chip
// sits at the end of each week row when there is room for it.
(() => {
  let metrics = [];
  let stats = null;
  let prefs = {};
  let currentTheme = 'light';
  let observer = null;
  let debounceTimer = null;
  let tornDown = false;

  const TIP_KEY = 'pt_cal_tip_seen';
  const TIP_ID = 'pt-cal-tip';
  const ACCENTS = {
    coral: ['#E0674B', '#F07A5E'],
    sage: ['#5E9270', '#7FB291'],
    ocean: ['#3B7EA1', '#5FA3C7'],
    plum: ['#8A5A9E', '#B285C6'],
    amber: ['#C9821F', '#E3A54A'],
    slate: ['#3D4A5C', '#A9B6C8']
  };

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
    document.querySelectorAll('#pt-layer, .pt-cell-overlay, .pt-quick-add-cell, #pt-day-modal, #' + TIP_ID).forEach(n => n.remove());
  }

  // Theme is chosen in the popup and mirrored here for the day modal.
  function applyTheme(theme) {
    currentTheme = theme === 'dark' ? 'dark' : 'light';
    document.querySelectorAll('.pt-modal-dialog').forEach(dlg => {
      dlg.classList.toggle('pt-dark', currentTheme === 'dark');
      applyAccentTo(dlg);
    });
  }

  // The user's accent, light or dark shade to match the modal's theme.
  function applyAccentTo(node) {
    if (!node || !node.style || typeof node.style.setProperty !== 'function') return;
    const pair = ACCENTS[prefs && prefs.accent] || ACCENTS.coral;
    node.style.setProperty('--pt-accent', currentTheme === 'dark' ? pair[1] : pair[0]);
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


  const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function parseLocalDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null;
  }

  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // "Wed, Nov 19"; the year is added only when it is not this year.
  function formatDateNice(dateStr) {
    const d = parseLocalDate(dateStr);
    if (!d) return String(dateStr || '');
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return WEEKDAYS_SHORT[d.getDay()] + ', ' + MONTHS_SHORT[d.getMonth()] + ' ' + d.getDate() + (sameYear ? '' : ', ' + d.getFullYear());
  }

  // The same per-tracker wording as the popup's details form.
  function fieldHints(metricId) {
    if (metricId === 'jobs') return { company: 'Company', role: 'Role', notes: 'Notes or job link (optional)' };
    if (metricId === 'leetcode') return { company: 'Problem', role: 'Topic or tag', notes: 'Notes or link (optional)' };
    return { company: 'What you did', role: 'Tag (optional)', notes: 'Notes or link (optional)' };
  }

  function metricsMap() {
    const m = {};
    metrics.forEach(x => { m[x.id] = x; });
    return m;
  }

  // Trackers the user chose to hide (focus areas they did not pick) keep
  // their data but get no pills.
  function visibleMetrics() {
    return metrics.filter(m => m && !m.hidden);
  }

  function primaryMetric() {
    const list = visibleMetrics();
    return list.find(m => m.id === 'jobs') || list[0] || null;
  }

  function isGoalMet(m, count) {
    return !!(m.dailyGoal && count >= m.dailyGoal);
  }

  function isRestDay(dateStr) {
    const rest = stats && Array.isArray(stats.restDays) ? stats.restDays
      : (prefs && Array.isArray(prefs.restDays) ? prefs.restDays : []);
    if (!rest.length) return false;
    const d = parseLocalDate(dateStr);
    return !!d && rest.indexOf(d.getDay()) >= 0;
  }

  // Visible trackers whose streak a freeze covered on this date.
  function frozenOn(dateStr) {
    const freezes = stats && stats.freezes;
    if (!freezes) return [];
    return visibleMetrics().filter(m => {
      const f = freezes[m.id];
      return f && Array.isArray(f.usedOn) && f.usedOn.indexOf(dateStr) >= 0;
    });
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

  function readPrefs() {
    if (typeof TrackerStorage.getPrefs !== 'function') return Promise.resolve({});
    return Promise.resolve(TrackerStorage.getPrefs()).catch(() => ({}));
  }

  async function doRefreshData() {
    if (tornDown) return;
    try {
      let nextPrefs;
      [metrics, stats, nextPrefs] = await Promise.all([
        TrackerStorage.getMetrics(),
        TrackerStorage.getStats(),
        readPrefs()
      ]);
      prefs = nextPrefs || {};
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
  const weekChips = new Map();       // first date of a Month-view row -> { node, anchor }
  let hoverTargets = new WeakMap();  // any element that decodes to a day -> dateStr
  let hoveredDate = null;
  let layoutRaf = 0;
  // Today's goal state per tracker, so the pill shimmers once at the moment
  // it flips to met and not on every page load.
  const todayMet = {};
  let todayPrimed = false;
  let initStarted = false;
  let tipChecked = false;

  // A week chip needs a roomy grid: a wide window and a cell with space below
  // its events for a small label.
  const WEEK_CHIP_MIN_VIEWPORT = 900;
  const WEEK_CHIP_MIN_CELL_W = 96;
  const WEEK_CHIP_MIN_CELL_H = 72;

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
    const parts = visibleMetrics().map(m => {
      const count = counts[m.id] || 0;
      if (count <= 0) return '';
      return m.id + ':' + count + ':' + m.color + ':' + (isGoalMet(m, count) ? 1 : 0);
    }).filter(Boolean);
    if (!parts.length && isRestDay(dateStr)) parts.push('rest');
    frozenOn(dateStr).forEach(m => parts.push('frz:' + m.id));
    return parts.join('|');
  }

  // Small inline icons. Falls back to an empty span where the document
  // cannot make SVG.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    moon: [['path', { d: 'M8.6 7.7A3.9 3.9 0 0 1 4.3 3.4c0-.7.2-1.4.5-1.9a4.6 4.6 0 1 0 5.7 5.7c-.6.3-1.2.5-1.9.5z', fill: 'currentColor' }]],
    snow: [['path', { d: 'M6 1.2v9.6M1.8 3.6l8.4 4.8M1.8 8.4l8.4-4.8M4.6 1.9L6 3l1.4-1.1M4.6 10.1L6 9l1.4 1.1', stroke: 'currentColor', 'stroke-width': '1.15', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' }]],
    lock: [
      ['path', { d: 'M4 5.6V4a2 2 0 0 1 4 0v1.6', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', fill: 'none' }],
      ['rect', { x: '2.3', y: '5.6', width: '7.4', height: '5.1', rx: '1.5', fill: 'currentColor' }]
    ]
  };

  function icon(name) {
    const holder = document.createElement('span');
    holder.className = 'pt-icon pt-icon-' + name;
    if (typeof document.createElementNS !== 'function') return holder;
    try {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 12 12');
      svg.setAttribute('width', '10');
      svg.setAttribute('height', '10');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      (ICONS[name] || []).forEach(([tag, attrs]) => {
        const node = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(k => node.setAttribute(k, attrs[k]));
        svg.appendChild(node);
      });
      holder.appendChild(svg);
    } catch (e) { /* the empty holder is fine */ }
    return holder;
  }

  // A pill with an icon and a word (rest day, freeze).
  function statusPill(kind, iconName, word, title) {
    const badge = document.createElement('div');
    badge.className = 'pt-badge pt-' + kind;
    badge.title = title;
    badge.setAttribute('aria-label', title);
    const text = document.createElement('span');
    text.className = 'pt-badge-text';
    const name = document.createElement('span');
    name.className = 'pt-badge-name';
    name.textContent = word;
    text.appendChild(name);
    badge.appendChild(icon(iconName));
    badge.appendChild(text);
    return badge;
  }

  function buildPills(overlay, dateStr, shimmerIds) {
    overlay.textContent = '';
    const counts = stats.dailyMap[dateStr] || {};
    let shown = 0;
    visibleMetrics().forEach(m => {
      const count = counts[m.id] || 0;
      if (count <= 0) return;
      shown++;
      const isGoalMetNow = isGoalMet(m, count);
      const badge = document.createElement('div');
      badge.className = 'pt-badge' + (isGoalMetNow ? ' pt-goal-met' : '') +
        (isGoalMetNow && shimmerIds && shimmerIds.has(m.id) ? ' pt-shimmer' : '');
      badge.style.backgroundColor = isGoalMetNow ? m.color : m.color + '24';
      badge.style.color = isGoalMetNow ? '#ffffff' : m.color;
      if (!isGoalMetNow) badge.style.borderColor = m.color + '40';
      const label = metricLabel(m, count);
      badge.title = label + (isGoalMetNow ? ' (goal met)' : ' (goal ' + (m.dailyGoal || 1) + ')');
      const dot = document.createElement('span');
      // A met goal swaps the dot for a check (drawn in content.css), so it
      // reads by shape and not only by the solid fill.
      dot.className = 'pt-badge-dot';
      if (!isGoalMetNow) dot.style.backgroundColor = m.color;
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
    if (!shown && isRestDay(dateStr)) {
      overlay.appendChild(statusPill('rest', 'moon', 'Rest', 'Rest day. Your streak is safe.'));
    }
    const frozen = frozenOn(dateStr);
    if (frozen.length) {
      const names = frozen.map(m => m.name || m.id).join(', ');
      overlay.appendChild(statusPill('freeze', 'snow', 'Freeze', 'A streak freeze kept your streak going (' + names + ')'));
    }
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
    const label = 'Add something you did on ' + formatDateNice(dateStr);
    addBtn.title = label;
    addBtn.setAttribute('aria-label', label);
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

  function viewportWidth() {
    return window.innerWidth || document.documentElement.clientWidth || 0;
  }

  function positionDay(entry) {
    const r = entry.anchor.getBoundingClientRect();
    const node = entry.node;
    if (!r.width || !r.height) {
      node.style.display = 'none';
      return;
    }
    node.style.display = '';
    const vw = viewportWidth();
    if (entry.kind === 'header') {
      // Stacked down the header's right edge: pills on the weekday line,
      // the quick-add button beside the date number below it. The number is
      // centred, so right-aligning a single row would run under it.
      node.style.top = Math.round(r.top + 6) + 'px';
      node.style.right = Math.round(vw - r.right + 8) + 'px';
      node.style.height = Math.max(0, Math.round(r.height - 14)) + 'px';
      node.style.maxWidth = Math.max(0, Math.round(r.width - 16)) + 'px';
    } else {
      // The right part of the date line only, clear of the centred number.
      node.style.top = Math.round(r.top + 4) + 'px';
      node.style.right = Math.round(vw - r.right + 4) + 'px';
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

  function positionWeekChip(chip) {
    const r = chip.anchor.getBoundingClientRect();
    if (!r.width || !r.height) {
      chip.node.style.display = 'none';
      return;
    }
    chip.node.style.display = '';
    chip.node.style.top = Math.round(r.top + r.height - 22) + 'px';
    chip.node.style.right = Math.round(viewportWidth() - r.right + 6) + 'px';
  }

  // Month view only (every anchor is a day cell): one chip per week row,
  // at the bottom right of the row's last cell, with that row's total for
  // the main tracker. Skipped on narrow layouts and short cells, and for a
  // week with nothing logged yet.
  function renderWeekChips(anchors) {
    const want = new Map();
    const dates = Object.keys(anchors);
    const metric = primaryMetric();
    const monthView = dates.length >= 7 && dates.every(d => anchors[d].kind === 'cell');
    if (monthView && metric && viewportWidth() >= WEEK_CHIP_MIN_VIEWPORT) {
      const rows = new Map();
      dates.forEach(d => {
        const r = anchors[d].anchor.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const key = Math.round(r.top);
        if (!rows.has(key)) rows.set(key, []);
        rows.get(key).push({ date: d, anchor: anchors[d].anchor, r });
      });
      rows.forEach(cells => {
        if (cells.length < 5) return;
        cells.sort((a, b) => a.r.left - b.r.left);
        const last = cells[cells.length - 1];
        if (last.r.width < WEEK_CHIP_MIN_CELL_W || last.r.height < WEEK_CHIP_MIN_CELL_H) return;
        const total = cells.reduce((sum, c) => sum + ((stats.dailyMap[c.date] || {})[metric.id] || 0), 0);
        if (total <= 0) return;
        want.set(cells[0].date, { total, anchor: last.anchor });
      });
    }

    weekChips.forEach((chip, key) => {
      if (!want.has(key)) {
        chip.node.remove();
        weekChips.delete(key);
      }
    });
    if (!want.size) return;
    const layer = layerNode();
    want.forEach((info, key) => {
      let chip = weekChips.get(key);
      if (!chip) {
        const node = document.createElement('div');
        node.className = 'pt-week-chip';
        layer.appendChild(node);
        chip = { node, anchor: info.anchor };
        weekChips.set(key, chip);
      }
      chip.anchor = info.anchor;
      chip.node.textContent = info.total + ' this week';
      chip.node.title = info.total + ' ' + (metric.name || metric.id) + ' this week';
      positionWeekChip(chip);
    });
  }

  function layoutDays() {
    layoutRaf = 0;
    days.forEach(positionDay);
    weekChips.forEach(positionWeekChip);
  }

  function scheduleLayout() {
    if (tornDown || layoutRaf) return;
    if (typeof requestAnimationFrame === 'function') {
      layoutRaf = requestAnimationFrame(layoutDays);
    } else {
      layoutRaf = setTimeout(layoutDays, 0);
    }
  }

  // Which of today's trackers just flipped to met since the last render.
  function takeTodayFlips(todayStr) {
    const flips = new Set();
    const counts = (stats.dailyMap && stats.dailyMap[todayStr]) || {};
    visibleMetrics().forEach(m => {
      const met = isGoalMet(m, counts[m.id] || 0);
      if (todayPrimed && met && todayMet[m.id] === false) flips.add(m.id);
      todayMet[m.id] = met;
    });
    todayPrimed = true;
    return flips;
  }

  // Reconciles the layer against the days currently on screen: one node per
  // date, pills rebuilt only when that day's counts changed.
  function renderBadges() {
    if (tornDown || !stats || !stats.dailyMap || !metrics.length) return;

    // Nodes an earlier version put inside Google's cells.
    document.querySelectorAll('.pt-cell-overlay, .pt-quick-add-cell').forEach(n => {
      if (!n.closest('#' + LAYER_ID)) n.remove();
    });

    const todayStr = stats.todayStr || localToday();
    const flips = takeTodayFlips(todayStr);
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
      entry.node.classList.toggle('pt-today', dateStr === todayStr);
      const stateKey = dayStateKey(dateStr);
      if (stateKey !== entry.stateKey) {
        buildPills(entry.node.firstElementChild, dateStr, dateStr === todayStr ? flips : null);
        entry.stateKey = stateKey;
      }
      entry.node.classList.toggle('pt-hover', hoveredDate === dateStr);
      positionDay(entry);
    });

    renderWeekChips(anchors);
    if (initStarted && !tipChecked && days.size) maybeShowTip();
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
  // First-visit tip: once, dismissible, off when tips are turned off.
  // ---------------------------------------------------------------
  function maybeShowTip() {
    tipChecked = true;
    if (prefs && prefs.tipsOff) return;
    try {
      chrome.storage.local.get(TIP_KEY, (items) => {
        try {
          try { void chrome.runtime.lastError; } catch (e) { /* context gone */ }
          if (tornDown || (items && items[TIP_KEY]) || typeof document === 'undefined') return;
          chrome.storage.local.set({ [TIP_KEY]: true });
          showTip();
        } catch (e) { /* the tip is optional */ }
      });
    } catch (e) { /* storage gone: skip the tip */ }
  }

  function showTip() {
    if (document.getElementById(TIP_ID)) return;
    const tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.className = 'pt-cal-tip';
    tip.setAttribute('role', 'note');
    const mark = icon('lock');
    mark.classList.add('pt-cal-tip-mark');
    const text = document.createElement('div');
    text.className = 'pt-cal-tip-text';
    const strong = document.createElement('strong');
    strong.textContent = 'LIT';
    text.appendChild(strong);
    const line = document.createElement('span');
    line.textContent = 'These pills are your scoreboard. Hover a day to add something you did.';
    text.appendChild(line);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pt-cal-tip-close';
    close.textContent = 'Got it';
    close.addEventListener('click', () => tip.remove());
    tip.appendChild(mark);
    tip.appendChild(text);
    tip.appendChild(close);
    document.body.appendChild(tip);
    applyAccentTo(tip);
  }

  // ---------------------------------------------------------------
  // 2. DAY MODAL — add something for a date
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
    const niceDate = formatDateNice(dateStr);

    const backdrop = document.createElement('div');
    backdrop.id = 'pt-day-modal';
    backdrop.className = 'pt-modal-backdrop';

    // Count summary per tracker
    const counts = {};
    logs.forEach(l => {
      counts[l.metricId] = (counts[l.metricId] || 0) + (l.count || 1);
    });
    const summaryParts = Object.entries(counts).map(([id, c]) => {
      const m = mMap[id];
      return m ? metricLabel(m, c) : c + ' ' + id;
    });
    const summaryText = summaryParts.length > 0 ? summaryParts.join(', ') : 'Nothing here yet';

    const choices = visibleMetrics();
    const firstId = (choices.find(m => m.id === 'jobs') || choices[0] || {}).id || '';
    const hints = fieldHints(firstId);
    let metricOptions = '';
    choices.forEach(m => {
      metricOptions += '<option value="' + escapeHtml(m.id) + '"' + (m.id === firstId ? ' selected' : '') + '>' + escapeHtml(m.name) + '</option>';
    });

    backdrop.innerHTML = [
      '<div class="pt-modal-dialog' + (currentTheme === 'dark' ? ' pt-dark' : '') + '" role="dialog" aria-modal="true" aria-labelledby="pt-modal-title">',
        '<div class="pt-modal-header">',
          '<div>',
            '<div class="pt-modal-header-title" id="pt-modal-title">' + escapeHtml(niceDate) + '</div>',
            '<div class="pt-modal-header-sub">' + escapeHtml(summaryText) + '</div>',
          '</div>',
          '<button class="pt-close-btn" id="pt-modal-close" type="button" aria-label="Close" title="Close">&times;</button>',
        '</div>',
        '<div class="pt-modal-body">',
          '<div class="pt-modal-form">',
            '<label for="pt-modal-metric">Add something for ' + escapeHtml(niceDate) + '</label>',
            '<select id="pt-modal-metric" aria-label="Tracker">' + metricOptions + '</select>',
            '<div class="pt-modal-form-row">',
              '<input type="text" id="pt-modal-company" placeholder="' + escapeHtml(hints.company) + '" aria-label="' + escapeHtml(hints.company) + '" />',
              '<input type="text" id="pt-modal-role" placeholder="' + escapeHtml(hints.role) + '" aria-label="' + escapeHtml(hints.role) + '" />',
            '</div>',
            '<input type="text" id="pt-modal-notes" placeholder="' + escapeHtml(hints.notes) + '" aria-label="' + escapeHtml(hints.notes) + '" />',
            '<div class="pt-modal-error" id="pt-modal-error" role="alert" hidden></div>',
            '<button class="pt-btn-primary pt-modal-submit" id="pt-modal-add" type="button">Add it</button>',
          '</div>',
        '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(backdrop);
    applyAccentTo(backdrop.querySelector('.pt-modal-dialog'));

    const metricSelect = backdrop.querySelector('#pt-modal-metric');
    const companyInput = backdrop.querySelector('#pt-modal-company');
    const roleInput = backdrop.querySelector('#pt-modal-role');
    const notesInput = backdrop.querySelector('#pt-modal-notes');
    const addBtn = backdrop.querySelector('#pt-modal-add');
    const errorBox = backdrop.querySelector('#pt-modal-error');

    function setError(text) {
      errorBox.textContent = text || '';
      if (text) errorBox.removeAttribute('hidden');
      else errorBox.setAttribute('hidden', '');
    }

    // The fields read like the popup's for whichever tracker is picked.
    metricSelect.addEventListener('change', () => {
      const h = fieldHints(metricSelect.value);
      [[companyInput, h.company], [roleInput, h.role], [notesInput, h.notes]].forEach(([input, text]) => {
        input.setAttribute('placeholder', text);
        input.setAttribute('aria-label', text);
      });
    });

    // Close
    backdrop.querySelector('#pt-modal-close').addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') backdrop.remove();
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') addBtn.click();
    });

    // Add, then close: the pill count is the readout for a day. A failed
    // save keeps everything typed and says so in the box.
    addBtn.addEventListener('click', async () => {
      const metricId = metricSelect.value;
      if (!metricId || addBtn.disabled) return;
      setError('');
      addBtn.disabled = true;
      try {
        await TrackerStorage.addLog({
          metricId,
          date: dateStr,
          count: 1,
          company: companyInput.value,
          role: roleInput.value,
          notes: notesInput.value
        });
      } catch (err) {
        if (isContextError(err)) {
          backdrop.remove();
          teardown();
          return;
        }
        console.warn('LIT: could not save the entry', err);
        addBtn.disabled = false;
        setError("Couldn't save that one. Check your connection and try again. What you typed is still here.");
        return;
      }
      backdrop.remove();
      await refreshData();
    });

    if (focusForm && companyInput) setTimeout(() => companyInput.focus(), 50);
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
          target.closest('.pt-modal-backdrop') ||
          target.closest('#' + TIP_ID)
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
    initStarted = true;
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
      formatDateNice,
      fieldHints,
      renderBadges,
      openDayModal,
      __setOverlayState: (next) => {
        if (next.metrics) metrics = next.metrics;
        if (next.stats) stats = next.stats;
        if (next.prefs) prefs = next.prefs;
      }
    };
  }
})();
