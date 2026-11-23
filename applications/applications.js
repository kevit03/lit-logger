// LIT Applications page: every job application in one searchable, sortable
// table. Change a stage in place, keep notes and details, see which ones are
// ready for a follow-up (or have gone quiet), copy a short follow-up note,
// and export what is shown as CSV.
//
// Reads and writes only through TrackerStorage, so the popup, the calendar
// overlay, and this page always agree, and a change made anywhere else shows
// up here on its own. The follow-up rules live in shared/followups.js
// (LitFollowUps). Nothing here changes a stage unless the person picks one.
//
// Opened from the toolbar icon's right-click menu ("Open my applications")
// and from the daily follow-up notification (#followups). #quiet opens the
// Gone quiet view.
(() => {
  const S = TrackerStorage;
  const F = LitFollowUps;
  const X = typeof LitExport !== 'undefined' ? LitExport : null;

  // Rows drawn at once. "Show more" adds another page, so a long history
  // never makes typing in the search box slow.
  const PAGE_SIZE = 200;
  const STAGE_NAMES = { applied: 'Applied', review: 'Under review', interviewing: 'Interviewing', offer: 'Offer', rejected: 'Closed' };
  const MODE_NAMES = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' };
  const VIEW_HINTS = {
    due: 'Still at Applied, and their follow-up day has come. Copy a note, send it from your email, then mark it followed up.',
    quiet: 'No reply in about a month. You could send one last note, or move it to Closed so your list stays tidy. LIT never changes a stage for you.'
  };

  const state = {
    logs: [],
    prefs: Object.assign({}, S.PREF_DEFAULTS),
    today: S.getLocalDateStr(),
    query: '',
    status: 'all',
    workMode: 'all',
    show: 'all',
    sort: 'date',
    dir: 'desc',
    limit: PAGE_SIZE,
    openId: null,
    dirty: false,
    pendingReload: false
  };

  // Entries this page just wrote: their change event is already on screen.
  const ownWrites = new Set();
  // Focus keys to the controls drawn last, so a redraw can hand focus back.
  let controls = new Map();
  // The open details panel is kept, not redrawn, so typing in it survives a
  // search or a change arriving from another window.
  let openPanel = null;
  let toastTimer = null;
  let undoAction = null;
  let reloadTimer = null;

  function el(id) {
    return document.getElementById(id);
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function button(text, className) {
    const b = make('button', className || 'btn', text);
    b.setAttribute('type', 'button');
    return b;
  }

  function register(key, node) {
    node.setAttribute('data-key', key);
    controls.set(key, node);
    return node;
  }

  function focusKey(key) {
    const node = key && controls.get(key);
    if (node && typeof node.focus === 'function') {
      node.focus();
      return true;
    }
    return false;
  }

  function activeKey() {
    const a = document.activeElement;
    return a && typeof a.getAttribute === 'function' ? a.getAttribute('data-key') : null;
  }

  function clean(value) {
    return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function statusOf(log) {
    return S.normalizeStatus(log && log.status) || 'applied';
  }

  function countOf(log) {
    return Math.max(1, parseInt(log && log.count, 10) || 1);
  }

  function hasSubject(log) {
    return !!(clean(log.role) || clean(log.company));
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function find(id) {
    return state.logs.find(l => l.id === id) || null;
  }

  function replaceLog(updated) {
    if (!updated || !updated.id) return;
    const i = state.logs.findIndex(l => l.id === updated.id);
    if (i >= 0) state.logs[i] = updated;
  }

  function agoText(dateStr) {
    const days = F.daysBetween(dateStr, state.today);
    if (!Number.isFinite(days) || days < 0) return '';
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days < 60) return days + ' days ago';
    return 'About ' + Math.round(days / 30) + ' months ago';
  }

  function preview(text) {
    const line = clean(text);
    return line.length > 90 ? line.slice(0, 87).trim() + '...' : line;
  }

  // ----- Messages ------------------------------------------------------------

  function showError(message) {
    const banner = el('page-error');
    banner.textContent = message || '';
    banner.hidden = !message;
  }

  function hideToast() {
    el('toast').hidden = true;
    undoAction = null;
    toastTimer = null;
  }

  function toast(message, undo) {
    el('toast-text').textContent = message;
    undoAction = typeof undo === 'function' ? undo : null;
    el('toast-btn').hidden = !undoAction;
    el('toast').hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undoAction ? 8000 : 4000);
  }

  // ----- Appearance: the popup's light/dark choice (the system's until one
  // is made), its accent color, and comfort mode -------------------------------

  function readRawTheme() {
    return new Promise(resolve => {
      try {
        const area = chrome.storage.sync || chrome.storage.local;
        area.get(['pt_theme'], r => resolve(r && (r.pt_theme === 'dark' || r.pt_theme === 'light') ? r.pt_theme : null));
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function applyAppearance() {
    const root = document.documentElement;
    const theme = await readRawTheme();
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    if (state.prefs.accent) root.setAttribute('data-accent', state.prefs.accent);
    root.setAttribute('data-comfort', state.prefs.comfortMode ? 'on' : 'off');
  }

  // ----- Data ----------------------------------------------------------------

  async function loadPrefs() {
    try {
      state.prefs = await S.getPrefs();
    } catch (e) {
      // Defaults stay in place.
    }
  }

  async function load() {
    state.today = S.getLocalDateStr();
    try {
      const [logs] = await Promise.all([S.getLogs({ metricId: 'jobs' }), loadPrefs()]);
      state.logs = logs;
      showError('');
    } catch (err) {
      showError('LIT could not load your applications. Try reloading this page.');
    }
    render();
  }

  function scheduleReload() {
    if (state.openId && state.dirty) {
      state.pendingReload = true;
      return;
    }
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      load();
    }, 150);
  }

  function onStorageChange(changes) {
    if (changes.logs) {
      const ids = Array.isArray(changes.logs.ids) ? changes.logs.ids : [];
      if (ids.length && ids.every(id => ownWrites.has(id))) {
        ids.forEach(id => ownWrites.delete(id));
      } else {
        scheduleReload();
      }
    }
    if (changes.pt_auth_user) scheduleReload();
    if (changes.pt_prefs || changes.pt_theme) {
      loadPrefs().then(() => {
        applyAppearance();
        render();
      });
    }
  }

  // ----- What is shown -------------------------------------------------------

  function filtersActive() {
    return !!(state.query.trim() || state.status !== 'all' || state.workMode !== 'all' || state.show !== 'all');
  }

  function computeVisible() {
    let list = S.filterApplications(state.logs, { query: state.query, status: state.status, workMode: state.workMode });
    if (state.show === 'due') list = list.filter(l => F.isDue(l, state.today, state.prefs));
    else if (state.show === 'quiet') list = list.filter(l => F.isGoneQuiet(l, state.today, state.prefs));
    return S.sortApplications(list, state.sort, state.dir);
  }

  // ----- Render --------------------------------------------------------------

  function render() {
    renderSummary();
    renderFollowUps();
    renderControls();
    renderTable();
    renderSettings();
  }

  function renderSummary() {
    const sum = S.summarizePipeline(state.logs);
    el('stat-applied').textContent = String(sum.total);
    el('stat-responded').textContent = String(sum.responded);
    el('stat-rate').textContent = sum.responseRate === null ? '' : sum.responseRate + '% of applications';
    el('stat-interviews').textContent = String(sum.counts.interviewing + sum.counts.offer);
    el('stat-offers').textContent = String(sum.counts.offer);
    let line = '';
    if (sum.total > 0 && !sum.responded) {
      line = 'No replies yet. That is common early on, so keep going.';
    } else if (sum.avgTurnaroundDays !== null) {
      const days = Math.round(sum.avgTurnaroundDays);
      line = days < 1
        ? 'Replies have come in the same day, on average.'
        : 'Replies have taken about ' + plural(days, 'day') + ', on average.';
    }
    el('summary-line').textContent = line;
    el('summary-line').hidden = !line;
  }

  function setRadioCount(id, buttonId, label, n) {
    el(id).textContent = n ? String(n) : '';
    el(buttonId).setAttribute('aria-label', n ? label + ', ' + n : label);
  }

  function renderFollowUps() {
    const due = F.dueFollowUps(state.logs, state.today, state.prefs);
    const quiet = F.goneQuiet(state.logs, state.today, state.prefs);
    setRadioCount('count-due', 'show-due', 'Follow-up due', due.length);
    setRadioCount('count-quiet', 'show-quiet', 'Gone quiet', quiet.length);
    let text = '';
    let target = '';
    if (due.length) {
      text = F.summaryText(due.length) + '. A short, kind note can keep you on their radar.';
      target = 'due';
    } else if (quiet.length) {
      text = (quiet.length === 1 ? '1 application has' : quiet.length + ' applications have') +
        ' gone quiet. You could send one last note, or move them to Closed.';
      target = 'quiet';
    }
    el('nudge-text').textContent = text;
    el('nudge-btn').setAttribute('data-show', target);
    el('nudge').hidden = !text || state.show === target;
  }

  function renderControls() {
    ['all', 'due', 'quiet'].forEach(view => {
      const b = el('show-' + view);
      const on = state.show === view;
      b.setAttribute('aria-checked', String(on));
      b.setAttribute('tabindex', on ? '0' : '-1');
    });
    ['company', 'date', 'status'].forEach(key => {
      const sorted = state.sort === key;
      el('th-' + key).setAttribute('aria-sort', sorted ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
    const hint = VIEW_HINTS[state.show] || '';
    el('view-hint').textContent = hint;
    el('view-hint').hidden = !hint;
    if (el('search').value !== state.query) el('search').value = state.query;
    el('filter-status').value = state.status;
    el('filter-mode').value = state.workMode;
  }

  function resultLine(n) {
    if (!state.logs.length) return '';
    if (!filtersActive()) return plural(n, 'application');
    return 'Showing ' + n + ' of ' + plural(state.logs.length, 'application');
  }

  function renderTable() {
    const keep = activeKey();
    const visible = computeVisible();
    const shown = visible.slice(0, state.limit);
    controls = new Map();
    const rows = [];
    shown.forEach(log => {
      rows.push(buildRow(log));
      if (state.openId === log.id) rows.push(buildDetailRow(log));
    });
    el('apps-body').replaceChildren(...rows);
    const hasAny = state.logs.length > 0;
    el('table-wrap').hidden = shown.length === 0;
    el('empty-state').hidden = hasAny;
    el('no-match').hidden = !hasAny || shown.length > 0;
    const left = visible.length - shown.length;
    el('more').hidden = left <= 0;
    el('more-btn').textContent = 'Show ' + Math.min(PAGE_SIZE, Math.max(0, left)) + ' more';
    el('result-line').textContent = resultLine(visible.length);
    if (keep && !focusKey(keep) && /^(stage|mark|copy|edit|field):/.test(keep)) {
      // The row left the current view (say, a new stage outside the filter).
      el('list').focus();
    }
  }

  function buildRow(log) {
    const fu = F.followUpState(log, state.today, state.prefs);
    const name = F.entryName(log);
    const status = statusOf(log);
    const open = status === 'applied' && hasSubject(log);
    const tr = make('tr', 'row' + (fu.kind === 'due' ? ' is-due' : ''));
    tr.setAttribute('data-id', log.id);

    const who = make('td', 'cell-who');
    const role = clean(log.role);
    const company = clean(log.company);
    who.append(make('span', 'role' + (role ? '' : ' is-missing'), role || (company ? 'Role not added' : 'Untitled application')));
    if (company) who.append(make('span', 'company', company));
    if (countOf(log) > 1) who.append(make('span', 'badge', 'Counts as ' + countOf(log)));
    if (clean(log.notes)) who.append(make('span', 'note-preview', preview(log.notes)));

    const when = make('td', 'cell-date');
    const time = make('time', null, F.shortDate(log.date, state.today));
    time.setAttribute('datetime', log.date);
    when.append(time, make('span', 'ago', agoText(log.date)));

    const stage = make('td', 'cell-stage');
    const select = make('select', 'stage-select');
    select.setAttribute('aria-label', 'Stage for ' + name);
    S.STATUSES.forEach(s => {
      const o = make('option', null, STAGE_NAMES[s.id] || s.label);
      o.value = s.id;
      select.append(o);
    });
    select.value = status;
    select.setAttribute('data-status', status);
    select.addEventListener('change', () => changeStage(log.id, select.value));
    stage.append(register('stage:' + log.id, select));

    const details = make('td', 'cell-details');
    const facts = [clean(log.location), MODE_NAMES[log.workMode] || '', clean(log.salary)].filter(Boolean);
    if (facts.length) {
      const list = make('ul', 'facts');
      facts.forEach(f => list.append(make('li', null, f)));
      details.append(list);
    } else {
      details.append(make('span', 'muted', 'Not added'));
    }

    const follow = make('td', 'cell-follow');
    if (fu.kind !== 'none') {
      follow.append(make('span', 'chip chip-' + fu.kind, fu.label));
      if (fu.quiet && fu.kind !== 'quiet') follow.append(make('span', 'chip chip-quiet', 'Gone quiet'));
    } else {
      follow.append(make('span', 'muted', status === 'applied' ? 'Add a role or company' : 'Not needed'));
    }

    const actionsCell = make('td', 'cell-actions');
    const actions = make('div', 'row-actions');
    if (open && fu.kind !== 'done') {
      const mark = button('Mark followed up', 'btn btn-small btn-soft');
      mark.setAttribute('aria-label', 'Mark ' + name + ' as followed up');
      mark.addEventListener('click', () => markFollowedUp(log.id));
      actions.append(register('mark:' + log.id, mark));
    }
    if (open) {
      const copy = button('Copy note', 'btn btn-small btn-quiet');
      copy.setAttribute('aria-label', 'Copy a follow-up note for ' + name);
      copy.addEventListener('click', () => copyDraft(log.id));
      actions.append(register('copy:' + log.id, copy));
    }
    if (/^https?:\/\//i.test(log.url || '')) {
      const link = make('a', 'btn btn-small btn-quiet', 'Open posting');
      link.setAttribute('href', log.url);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('aria-label', 'Open the posting for ' + name + ' in a new tab');
      actions.append(link);
    }
    const isOpen = state.openId === log.id;
    const edit = button(isOpen ? 'Close' : 'Edit', 'btn btn-small btn-quiet');
    edit.setAttribute('aria-expanded', String(isOpen));
    edit.setAttribute('aria-controls', 'detail-' + log.id);
    edit.setAttribute('aria-label', (isOpen ? 'Close details for ' : 'Edit details and notes for ') + name);
    edit.addEventListener('click', () => toggleDetails(log.id));
    actions.append(register('edit:' + log.id, edit));
    actionsCell.append(actions);

    tr.append(who, when, stage, details, follow, actionsCell);
    return tr;
  }

  // ----- Details panel (notes, details, follow-up day, the note to copy) ----

  function input(type, value, max) {
    const node = make(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') node.setAttribute('type', type);
    if (max) node.setAttribute('maxlength', String(max));
    node.value = value || '';
    node.addEventListener('input', () => { state.dirty = true; });
    return node;
  }

  function field(labelText, control, hint, wide) {
    const wrap = make('label', 'field' + (wide ? ' field-wide' : ''));
    wrap.append(make('span', 'field-label', labelText), control);
    if (hint) wrap.append(make('span', 'field-hint', hint));
    return wrap;
  }

  function buildDetailRow(log) {
    if (openPanel && openPanel.id === log.id) {
      openPanel.keys.forEach(([key, node]) => controls.set(key, node));
      return openPanel.row;
    }
    const keys = [];
    const keep = (key, node) => {
      register(key, node);
      keys.push([key, node]);
      return node;
    };
    const name = F.entryName(log);
    const tr = make('tr', 'detail-row');
    tr.setAttribute('id', 'detail-' + log.id);
    const td = make('td');
    td.setAttribute('colspan', '6');
    const form = make('form', 'detail-form');
    form.setAttribute('novalidate', '');
    form.setAttribute('aria-label', 'Details for ' + name);

    const f = {
      role: keep('field:role:' + log.id, input('text', log.role, 300)),
      company: keep('field:company:' + log.id, input('text', log.company, 300)),
      location: keep('field:location:' + log.id, input('text', log.location, 80)),
      workMode: keep('field:workMode:' + log.id, make('select')),
      salary: keep('field:salary:' + log.id, input('text', log.salary, 60)),
      url: keep('field:url:' + log.id, input('url', log.url, 600)),
      followUpAt: keep('field:followUpAt:' + log.id, input('date', log.followUpAt)),
      notes: keep('field:notes:' + log.id, input('textarea', log.notes, 2000))
    };
    [['', 'Not added'], ['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']].forEach(([value, label]) => {
      const o = make('option', null, label);
      o.value = value;
      f.workMode.append(o);
    });
    f.workMode.value = log.workMode || '';
    f.workMode.addEventListener('change', () => { state.dirty = true; });
    f.location.setAttribute('placeholder', 'Austin, TX or Remote (US)');
    f.salary.setAttribute('placeholder', 'As the posting shows it');
    f.url.setAttribute('placeholder', 'https://');
    f.notes.setAttribute('rows', '4');

    const days = F.settings(state.prefs).days;
    const defaultDay = F.addDays(log.date, days);
    const grid = make('div', 'detail-grid');
    grid.append(
      field('Role', f.role),
      field('Company', f.company),
      field('Location', f.location),
      field('Work style', f.workMode),
      field('Salary', f.salary),
      field('Posting link', f.url),
      field('Follow up on', f.followUpAt, 'Leave empty to use ' + days + ' days after applying (' + F.shortDate(defaultDay, state.today) + ').'),
      field('Notes', f.notes, '', true)
    );
    const error = make('p', 'form-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    form.append(grid, error);

    if (log.followedUpAt) {
      const done = make('p', 'followed-line');
      done.append(make('span', null, 'You followed up on ' + F.shortDate(F.followedUpOn(log), state.today) + '. '));
      const undo = button('Undo follow-up', 'link-btn');
      undo.addEventListener('click', () => unmarkFollowedUp(log.id));
      done.append(keep('unmark:' + log.id, undo));
      form.append(done);
    }

    if (statusOf(log) === 'applied' && hasSubject(log)) {
      const box = make('div', 'draft');
      const head = make('div', 'draft-head');
      head.append(make('h3', null, 'Follow-up note'), make('span', 'draft-sub', 'Mentions only the role and company you saved.'));
      const text = make('pre', 'draft-text', F.draft(log).text);
      text.setAttribute('id', 'draft-' + log.id);
      const copy = button('Copy note', 'btn btn-small btn-quiet');
      copy.addEventListener('click', () => copyDraft(log.id));
      box.append(head, text, keep('draftcopy:' + log.id, copy));
      form.append(box);
    }

    const bar = make('div', 'form-actions');
    const save = make('button', 'btn btn-primary', 'Save changes');
    save.setAttribute('type', 'submit');
    const cancel = button('Cancel', 'btn btn-quiet');
    cancel.addEventListener('click', () => closeDetails(true));
    bar.append(keep('save:' + log.id, save), keep('cancel:' + log.id, cancel));
    form.append(bar);

    form.addEventListener('submit', e => {
      e.preventDefault();
      saveDetails(log.id, f, error);
    });
    form.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeDetails(true);
      }
    });

    td.append(form);
    tr.append(td);
    openPanel = { id: log.id, row: tr, keys };
    return tr;
  }

  function toggleDetails(id) {
    if (state.openId === id) {
      closeDetails(true);
      return;
    }
    if (state.openId && state.dirty) {
      toast('Save or cancel the changes you are making first.');
      focusKey('save:' + state.openId);
      return;
    }
    state.openId = id;
    state.dirty = false;
    openPanel = null;
    renderTable();
    focusKey('field:role:' + id);
  }

  function closeDetails(returnFocus) {
    const id = state.openId;
    state.openId = null;
    state.dirty = false;
    openPanel = null;
    if (state.pendingReload) {
      state.pendingReload = false;
      load().then(() => { if (returnFocus) focusKey('edit:' + id); });
      return;
    }
    renderTable();
    if (returnFocus) focusKey('edit:' + id);
  }

  // A link typed without https:// gets it; anything with spaces is refused
  // rather than saved as a broken link.
  function cleanLink(value) {
    const v = clean(value);
    if (!v) return { ok: true, url: '' };
    if (/\s/.test(v)) return { ok: false };
    const url = /^https?:\/\//i.test(v) ? v : 'https://' + v.replace(/^\/+/, '');
    return /^https?:\/\/[^/.]+\.[^/]+/i.test(url) || /^https?:\/\/localhost/i.test(url) ? { ok: true, url } : { ok: false };
  }

  async function saveDetails(id, f, error) {
    const link = cleanLink(f.url.value);
    if (!link.ok) {
      error.textContent = 'That posting link does not look right. Paste the full address, starting with https://';
      error.hidden = false;
      f.url.focus();
      return;
    }
    error.hidden = true;
    const patch = {
      role: f.role.value,
      company: f.company.value,
      location: f.location.value,
      workMode: f.workMode.value || null,
      salary: f.salary.value,
      url: link.url,
      followUpAt: f.followUpAt.value || null,
      notes: f.notes.value
    };
    ownWrites.add(id);
    let updated = false;
    try {
      updated = await S.updateLog(id, patch);
    } catch (e) {
      updated = false;
    }
    if (!updated) {
      ownWrites.delete(id);
      error.textContent = 'That did not save. Check your connection to LIT and try again.';
      error.hidden = false;
      return;
    }
    replaceLog(updated);
    state.openId = null;
    state.dirty = false;
    openPanel = null;
    render();
    focusKey('edit:' + id);
    toast('Saved.');
  }

  // ----- Actions -------------------------------------------------------------

  async function changeStage(id, value) {
    const log = find(id);
    if (!log) return;
    const prev = statusOf(log);
    if (value === prev) return;
    ownWrites.add(id);
    let updated = false;
    try {
      updated = await S.setLogStatus(id, value);
    } catch (e) {
      updated = false;
    }
    if (!updated) {
      ownWrites.delete(id);
      render();
      toast('That stage did not save. Try again.');
      return;
    }
    replaceLog(updated);
    render();
    toast('Moved to ' + (STAGE_NAMES[value] || value) + '.', async () => {
      ownWrites.add(id);
      const back = await S.setLogStatus(id, prev);
      if (back) {
        replaceLog(back);
        render();
        toast('Moved back to ' + STAGE_NAMES[prev] + '.');
      }
    });
  }

  async function markFollowedUp(id) {
    ownWrites.add(id);
    let updated = false;
    try {
      updated = await S.markFollowedUp(id);
    } catch (e) {
      updated = false;
    }
    if (!updated) {
      ownWrites.delete(id);
      toast('That did not save. Try again.');
      return;
    }
    replaceLog(updated);
    render();
    focusKey('copy:' + id) || focusKey('edit:' + id);
    toast('Marked as followed up. Nice work.', () => unmarkFollowedUp(id));
  }

  async function unmarkFollowedUp(id) {
    ownWrites.add(id);
    let back = false;
    try {
      back = await S.markFollowedUp(id, false);
    } catch (e) {
      back = false;
    }
    if (!back) {
      ownWrites.delete(id);
      toast('That did not save. Try again.');
      return;
    }
    replaceLog(back);
    if (state.openId === id) openPanel = null;
    render();
    toast('Follow-up mark removed.');
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      // Fall through to the textarea copy.
    }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  async function copyDraft(id) {
    const log = find(id);
    if (!log) return;
    const ok = await copyText(F.draft(log).text);
    toast(ok
      ? 'Follow-up note copied. Paste it into an email to the recruiter or hiring team.'
      : 'Could not copy. Open Edit to select the note yourself.');
  }

  // ----- Export --------------------------------------------------------------

  function csvCell(value) {
    if (X && typeof X.csvCell === 'function') return X.csvCell(value);
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+@\t\r]/.test(s) || /^-(?![\d.\s])/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function buildCsv(list) {
    const rows = ['date,role,company,stage,location,work_style,salary,follow_up_on,followed_up_at,notes,url,count'];
    list.forEach(l => {
      const followOn = statusOf(l) === 'applied' ? (F.followUpDate(l, state.prefs) || '') : (l.followUpAt || '');
      rows.push([
        l.date,
        l.role,
        l.company,
        X && typeof X.statusText === 'function' ? X.statusText(l) : (STAGE_NAMES[statusOf(l)] || ''),
        l.location,
        MODE_NAMES[l.workMode] || '',
        l.salary,
        followOn,
        l.followedUpAt,
        l.notes,
        l.url,
        countOf(l)
      ].map(csvCell).join(','));
    });
    return rows.join('\r\n');
  }

  function downloadText(filename, text, mimeType) {
    try {
      const blob = new Blob([text], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return true;
    } catch (err) {
      return false;
    }
  }

  async function exportCsv() {
    const list = computeVisible();
    if (!list.length) {
      toast(state.logs.length ? 'Nothing matches these filters, so there is nothing to export.' : 'There is nothing to export yet.');
      return;
    }
    const csv = buildCsv(list);
    const name = X && typeof X.backupFilename === 'function' ? X.backupFilename('lit-applications', 'csv') : 'lit-applications.csv';
    // The byte-order mark tells Excel the file is UTF-8, so accented names
    // and currency signs open correctly.
    if (downloadText(name, '﻿' + csv, 'text/csv')) {
      toast('Saved ' + plural(list.length, 'application') + ' to ' + name + '.');
      return;
    }
    const copied = await copyText(csv);
    toast(copied
      ? 'Chrome blocked the download, so the CSV was copied to your clipboard instead.'
      : 'Chrome blocked the download. Try again.');
  }

  // ----- Settings ------------------------------------------------------------

  function renderSettings() {
    const settings = F.settings(state.prefs);
    el('pref-enabled').checked = settings.enabled;
    const select = el('pref-days');
    const choices = F.DAY_CHOICES.includes(settings.days) ? F.DAY_CHOICES : F.DAY_CHOICES.concat([settings.days]).sort((a, b) => a - b);
    if (select.children.length !== choices.length) {
      select.replaceChildren(...choices.map(n => {
        const o = make('option', null, plural(n, 'day'));
        o.value = String(n);
        return o;
      }));
    }
    select.value = String(settings.days);
  }

  async function savePref(patch, message) {
    try {
      state.prefs = await S.setPrefs(patch);
      render();
      toast(message);
    } catch (e) {
      toast('That setting did not save. Try again.');
    }
  }

  // ----- Views, filters, sorting ---------------------------------------------

  function viewFromHash() {
    const h = String(location.hash || '').replace(/^#/, '').toLowerCase();
    if (h === 'followups' || h === 'due') return 'due';
    if (h === 'quiet') return 'quiet';
    return 'all';
  }

  function setShow(view, updateHash) {
    state.show = view === 'due' || view === 'quiet' ? view : 'all';
    state.limit = PAGE_SIZE;
    if (updateHash) {
      const hash = state.show === 'due' ? '#followups' : state.show === 'quiet' ? '#quiet' : '';
      try {
        history.replaceState(null, '', hash || ((location.pathname || '') + (location.search || '')));
      } catch (e) {
        // The view still changes; only the address stays as it was.
      }
    }
    render();
  }

  function setSort(key) {
    if (state.sort === key) {
      state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort = key;
      state.dir = key === 'date' ? 'desc' : 'asc';
    }
    renderControls();
    renderTable();
  }

  function clearFilters() {
    state.query = '';
    state.status = 'all';
    state.workMode = 'all';
    setShow('all', true);
    el('search').focus();
  }

  function isTyping(target) {
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(target && target.isContentEditable);
  }

  function wire() {
    const statusSelect = el('filter-status');
    S.STATUSES.forEach(s => {
      const o = make('option', null, STAGE_NAMES[s.id] || s.label);
      o.value = s.id;
      statusSelect.append(o);
    });

    el('search').addEventListener('input', () => {
      state.query = el('search').value;
      state.limit = PAGE_SIZE;
      renderControls();
      renderTable();
    });
    el('search').addEventListener('keydown', e => {
      if (e.key === 'Escape' && el('search').value) {
        e.preventDefault();
        el('search').value = '';
        state.query = '';
        renderTable();
      }
    });
    statusSelect.addEventListener('change', () => {
      state.status = statusSelect.value;
      state.limit = PAGE_SIZE;
      renderTable();
    });
    el('filter-mode').addEventListener('change', () => {
      state.workMode = el('filter-mode').value;
      state.limit = PAGE_SIZE;
      renderTable();
    });

    const views = ['all', 'due', 'quiet'];
    views.forEach((view, i) => {
      const b = el('show-' + view);
      b.addEventListener('click', () => setShow(view, true));
      // Arrow keys move between the three, as a radio group does.
      b.addEventListener('keydown', e => {
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = views[(i + 1) % views.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = views[(i + views.length - 1) % views.length];
        else if (e.key === 'Home') next = views[0];
        else if (e.key === 'End') next = views[views.length - 1];
        if (!next) return;
        e.preventDefault();
        setShow(next, true);
        el('show-' + next).focus();
      });
    });

    ['company', 'date', 'status'].forEach(key => {
      el('sort-' + key).addEventListener('click', () => setSort(key));
    });

    el('nudge-btn').addEventListener('click', () => {
      const target = el('nudge-btn').getAttribute('data-show');
      if (!target) return;
      setShow(target, true);
      el('show-' + target).focus();
    });
    el('more-btn').addEventListener('click', () => {
      state.limit += PAGE_SIZE;
      renderTable();
    });
    el('clear-filters').addEventListener('click', clearFilters);
    el('export-btn').addEventListener('click', () => { exportCsv(); });
    el('toast-btn').addEventListener('click', () => {
      const action = undoAction;
      hideToast();
      if (action) action();
    });

    el('pref-enabled').addEventListener('change', () => {
      const on = !!el('pref-enabled').checked;
      savePref({ followUpEnabled: on }, on ? 'Follow-up reminders are on.' : 'Follow-up reminders are off.');
    });
    el('pref-days').addEventListener('change', () => {
      const n = parseInt(el('pref-days').value, 10);
      if (!Number.isFinite(n)) return;
      savePref({ followUpDays: n }, 'Follow-ups are now suggested ' + plural(n, 'day') + ' after applying.');
    });

    // "/" jumps to the search box from anywhere that is not a text field.
    document.addEventListener('keydown', e => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        e.preventDefault();
        el('search').focus();
      }
    });
    // A page left open overnight moves to the new day when it is looked at.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const today = S.getLocalDateStr();
      if (today !== state.today) {
        state.today = today;
        render();
      }
    });
    window.addEventListener('hashchange', () => setShow(viewFromHash(), false));
  }

  function init() {
    wire();
    state.show = viewFromHash();
    S.onChanged(onStorageChange);
    load().then(applyAppearance);
  }

  init();
})();
