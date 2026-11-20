// Google Calendar overlay tests. Badges live in a layer of our own and never
// enter Google's cells: one node per date, anchored to the column header in
// Week and Day views and to the day cell in Month view, positioned from the
// anchor's rectangle, with leftovers from older versions swept out.
const assert = require('assert');
const { installMockChrome, uninstallMockChrome } = require('./mock_chrome');
const dom = require('./mock_dom');

function loadContentScript() {
  const mock = installMockChrome();
  const doc = dom.installDom();
  global.document = doc;
  global.window = {
    innerWidth: 1000,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ position: 'static' }),
    location: { href: 'https://calendar.google.com/calendar/u/0/r/week' }
  };
  ['../shared/auth', '../shared/storage', '../content/content'].forEach(m => {
    delete require.cache[require.resolve(m)];
  });
  global.TrackerAuth = require('../shared/auth');
  global.TrackerStorage = require('../shared/storage');
  const content = require('../content/content');
  return { mock, doc, content };
}

function teardown() {
  delete global.document;
  delete global.window;
  delete global.TrackerAuth;
  delete global.TrackerStorage;
  uninstallMockChrome();
}

const METRICS = [
  { id: 'jobs', name: 'Job Applications', color: '#1a73e8', unit: 'jobs', dailyGoal: 5, isDefault: true },
  { id: 'leetcode', name: 'LeetCode', color: '#1e8e3e', unit: 'problems', dailyGoal: 2, isDefault: true }
];

function dateKeyFor(y, m, d) {
  return (y - 1970) * 512 + (m - 1) * 32 + d + 32;
}

// A gridcell the way Calendar renders one: role, date key, and a box.
function gridcell(doc, key, { height, top, left = 0, width = 180, header }) {
  const cell = dom.el(doc, 'div[role="gridcell"]', { attrs: { 'data-datekey': String(key) } });
  cell.offsetHeight = height;
  cell.offsetWidth = width;
  cell.rectTop = top;
  cell.rectLeft = left;
  if (header) cell.appendChild(dom.el(doc, 'h2', { text: header }));
  return cell;
}

// A Week-view column header: weekday plus date, labelled for screen readers.
function columnheader(doc, label, { left, width = 140, top = 60, height = 80 }) {
  const h = dom.el(doc, 'div[role="columnheader"]', { children: [dom.el(doc, 'h2', { attrs: { 'aria-label': label } })] });
  h.offsetHeight = height;
  h.offsetWidth = width;
  h.rectTop = top;
  h.rectLeft = left;
  return h;
}

const layer = doc => doc.getElementById('pt-layer');
const dayNodes = doc => layer(doc) ? layer(doc).querySelectorAll('.pt-day') : [];
const dayFor = (doc, date) => dayNodes(doc).find(n => n.dataset.date === date);
const pillsOf = node => node.querySelectorAll('.pt-badge-text').map(t => t.textContent);

async function run() {
  console.log('--- Running test/calendar.test.js ---');

  // Week view: the all-day strip and the timed column both decode to the
  // date, and a column header carries it too. The header is the anchor;
  // nothing is inserted into any cell.
  {
    const { doc, content } = loadContentScript();
    const key14 = dateKeyFor(2026, 9, 14);
    const key15 = dateKeyFor(2026, 9, 15);
    const head14 = columnheader(doc, 'Monday, September 14, 2026', { left: 100 });
    const head15 = columnheader(doc, 'Tuesday, September 15, 2026', { left: 240 });
    const allDay14 = gridcell(doc, key14, { height: 82, top: 140, left: 100, width: 140 });
    const timed14 = gridcell(doc, key14, { height: 1152, top: 222, left: 100, width: 140 });
    const allDay15 = gridcell(doc, key15, { height: 82, top: 140, left: 240, width: 140 });
    const timed15 = gridcell(doc, key15, { height: 1152, top: 222, left: 240, width: 140 });
    // Must never anchor: a month-style weekday header with no date, a sliver.
    const bareHeader = columnheader(doc, 'Wednesday', { left: 380 });
    const sliver = gridcell(doc, key14, { height: 30, top: 60, left: 100 });
    [head14, head15, bareHeader, allDay14, allDay15, timed14, timed15, sliver].forEach(c => doc.body.appendChild(c));

    content.__setOverlayState({
      metrics: METRICS,
      stats: { dailyMap: { '2026-09-14': { jobs: 1 }, '2026-09-15': { jobs: 2, leetcode: 2 } } }
    });
    content.renderBadges();

    assert.ok(layer(doc), 'a layer is mounted on body');
    assert.strictEqual(dayNodes(doc).length, 2, 'one node per date');
    assert.strictEqual(doc.body.querySelectorAll('[role="gridcell"] .pt-cell-overlay, [role="gridcell"] .pt-quick-add-cell, [role="columnheader"] .pt-day').length, 0, 'nothing is inserted into Google\'s cells');
    [allDay14, timed14, allDay15, timed15].forEach(c => assert.strictEqual(c.style.position, undefined, 'cells are never restyled'));

    const d14 = dayFor(doc, '2026-09-14');
    assert.strictEqual(d14.dataset.anchor, 'header', 'Week view anchors to the column header');
    assert.strictEqual(d14.style.top, (60 + 6) + 'px', 'from the top of the header');
    assert.strictEqual(d14.style.height, (80 - 14) + 'px', 'spanning it, so pills sit on the weekday line and the button beside the number');
    assert.strictEqual(d14.style.right, (1000 - 240 + 8) + 'px', 'right-aligned to the header');
    assert.deepStrictEqual(pillsOf(d14), ['1 Job Application'], 'the tracker name, singular for one');
    assert.strictEqual(d14.querySelector('.pt-badge').title, '1 Job Application (goal 5)');

    const d15 = dayFor(doc, '2026-09-15');
    assert.deepStrictEqual(pillsOf(d15), ['2 Job Applications', '2 LeetCode']);
    assert.strictEqual(d15.querySelectorAll('.pt-badge')[1].title, '2 LeetCode (goal met)');
    assert.ok(d15.querySelectorAll('.pt-badge')[1].classList.contains('pt-goal-met'), 'a met goal is styled');
    assert.strictEqual(d15.querySelectorAll('.pt-quick-add-cell').length, 1, 'each day has a quick-add button');

    // Idempotent: a second render keeps the same nodes.
    content.renderBadges();
    assert.strictEqual(dayNodes(doc).length, 2);
    assert.strictEqual(dayFor(doc, '2026-09-14'), d14, 'unchanged day keeps its node');

    // A data change rebuilds only that day's pills.
    content.__setOverlayState({ stats: { dailyMap: { '2026-09-14': { jobs: 3 }, '2026-09-15': { jobs: 2, leetcode: 2 } } } });
    content.renderBadges();
    assert.deepStrictEqual(pillsOf(dayFor(doc, '2026-09-14')), ['3 Job Applications']);
    assert.strictEqual(dayFor(doc, '2026-09-14'), d14);

    // A day that leaves the screen leaves the layer.
    head15.remove(); allDay15.remove(); timed15.remove();
    content.renderBadges();
    assert.strictEqual(dayNodes(doc).length, 1, 'gone from the grid, gone from the layer');

    teardown();
    console.log('[PASS] Week view: one badge per date, anchored to the column header, nothing inside the cells');
  }

  // Leftovers an earlier version inserted into cells are swept out, and an
  // outer cell nested around an inner one for the same date resolves to one
  // badge.
  {
    const { doc, content } = loadContentScript();
    const key = dateKeyFor(2026, 9, 14);
    const outer = gridcell(doc, key, { height: 400, top: 100, header: '14' });
    const inner = gridcell(doc, key, { height: 300, top: 140 });
    outer.appendChild(inner);
    doc.body.appendChild(outer);
    outer.appendChild(dom.el(doc, 'div.pt-cell-overlay', { attrs: { 'data-state-key': 'stale' } }));
    inner.appendChild(dom.el(doc, 'div.pt-cell-overlay', { attrs: { 'data-state-key': 'stale' } }));
    outer.appendChild(dom.el(doc, 'button.pt-quick-add-cell'));

    content.__setOverlayState({ metrics: METRICS, stats: { dailyMap: { '2026-09-14': { jobs: 1 } } } });
    content.renderBadges();

    assert.strictEqual(outer.querySelectorAll('.pt-cell-overlay, .pt-quick-add-cell').length, 0, 'stale nodes inside cells are removed');
    assert.strictEqual(dayNodes(doc).length, 1, 'exactly one badge for the date');
    assert.strictEqual(dayFor(doc, '2026-09-14').dataset.anchor, 'cell');
    assert.strictEqual(dayFor(doc, '2026-09-14').style.top, (140 + 4) + 'px', 'anchored to the lower, nested cell');

    teardown();
    console.log('[PASS] Stale in-cell nodes are swept and nested same-date cells resolve to one badge');
  }

  // A cell's own date key beats a child chip's aria-label: a multi-day event
  // chip names the day it started on, not the cell it is drawn in.
  {
    const { doc, content } = loadContentScript();
    const cell = gridcell(doc, dateKeyFor(2026, 9, 16), { height: 120, top: 100, header: '16' });
    cell.appendChild(dom.el(doc, 'div', { attrs: { 'aria-label': 'Offsite, All day, Tuesday, September 15, 2026' } }));
    doc.body.appendChild(cell);
    content.__setOverlayState({ metrics: METRICS, stats: { dailyMap: { '2026-09-16': { jobs: 2 }, '2026-09-15': { jobs: 9 } } } });
    content.renderBadges();
    assert.deepStrictEqual(pillsOf(dayFor(doc, '2026-09-16')), ['2 Job Applications'], 'the cell renders its own date, not the chip\'s');
    assert.ok(!dayFor(doc, '2026-09-15'), 'the chip\'s date is not badged');
    teardown();
    console.log('[PASS] data-datekey wins over a child event chip\'s aria-label');
  }

  // Month view: one cell per date, badge on the date line, right-aligned,
  // with room for the quick-add button. Empty days still get the button.
  {
    const { doc, content } = loadContentScript();
    const cells = [12, 13, 14].map((d, i) => gridcell(doc, dateKeyFor(2026, 9, d), { height: 120, top: 100, left: i * 180, header: String(d) }));
    cells.forEach(c => doc.body.appendChild(c));
    // A weekday header row above the grid carries no date and must be ignored.
    doc.body.appendChild(columnheader(doc, 'Saturday', { left: 0, top: 0, height: 24 }));

    content.__setOverlayState({ metrics: METRICS, stats: { dailyMap: { '2026-09-13': { leetcode: 1 } } } });
    content.renderBadges();

    assert.strictEqual(dayNodes(doc).length, 3, 'every visible day has a node');
    const d13 = dayFor(doc, '2026-09-13');
    assert.strictEqual(d13.dataset.anchor, 'cell');
    assert.strictEqual(d13.style.top, '104px', 'on the date line');
    assert.strictEqual(d13.style.right, (1000 - 360 + 4) + 'px', 'right-aligned to the cell');
    assert.deepStrictEqual(pillsOf(d13), ['1 LeetCode'], 'a name that is not plural is left alone');
    assert.strictEqual(d13.style.maxWidth, Math.round(180 * 0.6) + 'px', 'kept to the right part of the date line');
    const d12 = dayFor(doc, '2026-09-12');
    assert.deepStrictEqual(pillsOf(d12), [], 'an empty day shows no pills');
    assert.strictEqual(d12.querySelectorAll('.pt-quick-add-cell').length, 1, 'but still offers quick add');

    teardown();
    console.log('[PASS] Month view: badge on the date line, empty days keep their quick-add');
  }

  // Hidden trackers get no pills; a rest day with nothing logged shows a
  // moon pill; a day a streak freeze covered shows a freeze pill.
  {
    const { doc, content } = loadContentScript();
    // 2026-09-12 is a Saturday, 2026-09-13 a Sunday.
    const cells = [12, 13, 14].map((d, i) => gridcell(doc, dateKeyFor(2026, 9, d), { height: 120, top: 100, left: i * 180, header: String(d) }));
    cells.forEach(c => doc.body.appendChild(c));
    const metrics = METRICS.concat([{ id: 'x1', name: 'Cold emails', color: '#8a5a9e', dailyGoal: 3, hidden: true }]);
    content.__setOverlayState({
      metrics,
      prefs: { restDays: [6] },
      stats: {
        restDays: [0, 6],
        dailyMap: { '2026-09-12': { x1: 4 }, '2026-09-13': { jobs: 2 }, '2026-09-14': { x1: 1 } },
        freezes: { jobs: { available: 0, usedOn: ['2026-09-14'] }, x1: { available: 0, usedOn: ['2026-09-12'] } }
      }
    });
    content.renderBadges();
    const sat = dayFor(doc, '2026-09-12');
    assert.deepStrictEqual(pillsOf(sat), ['Rest'], 'a hidden tracker shows nothing, so the rest day reads as rest');
    assert.ok(sat.querySelector('.pt-rest .pt-icon-moon'), 'the rest pill carries a moon');
    assert.strictEqual(sat.querySelectorAll('.pt-freeze').length, 0, 'a hidden tracker\'s freeze is not shown');
    assert.deepStrictEqual(pillsOf(dayFor(doc, '2026-09-13')), ['2 Job Applications'], 'logging on a rest day shows the count, not the moon');
    const mon = dayFor(doc, '2026-09-14');
    assert.deepStrictEqual(pillsOf(mon), ['Freeze']);
    assert.ok(mon.querySelector('.pt-freeze .pt-icon-snow'), 'the freeze pill carries a snowflake');
    assert.ok(/Job Applications/.test(mon.querySelector('.pt-freeze').title));
    teardown();
    console.log('[PASS] Hidden trackers skipped; rest-day moon pill; freeze snowflake pill');
  }

  // Today's pill shimmers once, at the moment its goal is met, and not on
  // the first paint of a day that was already met.
  {
    const { doc, content } = loadContentScript();
    const today = '2026-09-15';
    doc.body.appendChild(gridcell(doc, dateKeyFor(2026, 9, 15), { height: 120, top: 100, header: '15' }));
    content.__setOverlayState({ metrics: METRICS, stats: { todayStr: today, dailyMap: { [today]: { jobs: 4, leetcode: 2 } } } });
    content.renderBadges();
    const node = dayFor(doc, today);
    assert.ok(node.classList.contains('pt-today'));
    assert.strictEqual(node.querySelectorAll('.pt-shimmer').length, 0, 'already met on load: no shimmer');
    content.__setOverlayState({ stats: { todayStr: today, dailyMap: { [today]: { jobs: 5, leetcode: 2 } } } });
    content.renderBadges();
    const shimmering = node.querySelectorAll('.pt-shimmer');
    assert.strictEqual(shimmering.length, 1, 'the pill that just flipped shimmers');
    assert.ok(shimmering[0].classList.contains('pt-goal-met'));
    assert.ok(/Job Applications/.test(shimmering[0].title));
    content.__setOverlayState({ stats: { todayStr: today, dailyMap: { [today]: { jobs: 6, leetcode: 2 } } } });
    content.renderBadges();
    assert.strictEqual(node.querySelectorAll('.pt-shimmer').length, 0, 'only once');
    teardown();
    console.log('[PASS] Today\'s pill shimmers once when it flips to met');
  }

  // Month view week chips: one per full row with room, totals for the main
  // tracker, none for an empty week or a narrow window.
  {
    const { doc, content } = loadContentScript();
    global.window.innerWidth = 1400;
    // Two rows: Sep 6-12 at top 100 and Sep 13-19 at top 220.
    const cells = [];
    for (let i = 0; i < 14; i++) {
      const d = 6 + i;
      cells.push(gridcell(doc, dateKeyFor(2026, 9, d), { height: 120, top: i < 7 ? 100 : 220, left: (i % 7) * 180, header: String(d) }));
    }
    cells.forEach(c => doc.body.appendChild(c));
    content.__setOverlayState({ metrics: METRICS, stats: { dailyMap: { '2026-09-07': { jobs: 5, leetcode: 9 }, '2026-09-11': { jobs: 7 } } } });
    content.renderBadges();
    let chips = layer(doc).querySelectorAll('.pt-week-chip');
    assert.strictEqual(chips.length, 1, 'only the week with something logged');
    assert.strictEqual(chips[0].textContent, '12 this week');
    assert.strictEqual(chips[0].title, '12 Job Applications this week');
    assert.strictEqual(chips[0].style.top, (100 + 120 - 22) + 'px', 'bottom of the row');
    assert.strictEqual(chips[0].style.right, (1400 - 6 * 180 - 180 + 6) + 'px', 'right edge of the last cell');

    global.window.innerWidth = 800;
    content.renderBadges();
    assert.strictEqual(layer(doc).querySelectorAll('.pt-week-chip').length, 0, 'skipped on a narrow layout');
    teardown();
    console.log('[PASS] Month view: "12 this week" chip per week row, skipped when narrow or empty');
  }

  // Quick-add wording: friendly dates and per-tracker placeholders.
  {
    const { doc, content } = loadContentScript();
    const year = new Date().getFullYear();
    const d = new Date(year, 10, 19);
    const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    assert.strictEqual(content.formatDateNice(year + '-11-19'), wk + ', Nov 19');
    assert.strictEqual(content.formatDateNice('2019-03-04'), 'Mon, Mar 4, 2019', 'another year shows the year');
    assert.deepStrictEqual(content.fieldHints('jobs'), { company: 'Company', role: 'Role', notes: 'Notes or job link (optional)' });
    assert.strictEqual(content.fieldHints('leetcode').company, 'Problem');
    assert.strictEqual(content.fieldHints('abc123').company, 'What you did');
    doc.body.appendChild(gridcell(doc, dateKeyFor(year, 11, 19), { height: 120, top: 100, header: '19' }));
    content.__setOverlayState({ metrics: METRICS, stats: { dailyMap: {} } });
    content.renderBadges();
    const btn = dayFor(doc, year + '-11-19').querySelector('.pt-quick-add-cell');
    assert.strictEqual(btn.getAttribute('aria-label'), 'Add something you did on ' + wk + ', Nov 19');
    teardown();
    console.log('[PASS] Quick add: friendly dates and tracker-specific placeholders');
  }

  console.log('--- test/calendar.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
