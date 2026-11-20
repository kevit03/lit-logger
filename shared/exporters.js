// Export formats for LIT: CSV, Markdown (for Notion, Obsidian, GitHub), and
// the JSON backup. Pure functions over plain entries, so every format is
// testable headlessly and the popup only decides where the text goes.
const LitExport = (() => {
  const STATUS_LABELS = {
    applied: 'Applied',
    review: 'Under Review',
    interviewing: 'Interviewing',
    offer: 'Offer',
    rejected: 'Archived / Rejected'
  };

  function statusText(log) {
    if (!log || log.metricId !== 'jobs') return '';
    return STATUS_LABELS[log.status] || STATUS_LABELS.applied;
  }

  // Spreadsheets execute a cell that starts with =, +, or @ (and - before a
  // name) as a formula. Prefixing a quote keeps an imported note inert.
  function csvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+@\t\r]/.test(s) || /^-(?![\d.\s])/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function buildCsv(logs, metricNames) {
    const names = metricNames || {};
    const rows = ['date,time,tracker,count,company,role,status,notes,solve_time_seconds,url'];
    (logs || []).forEach(l => {
      rows.push([
        csvCell(l.date),
        csvCell(l.timestamp),
        csvCell(names[l.metricId] || l.metricId),
        csvCell(l.count || 1),
        csvCell(l.company),
        csvCell(l.role),
        csvCell(statusText(l)),
        csvCell(l.notes),
        csvCell(parseInt(l.solveTimeSeconds, 10) || 0),
        csvCell(l.url)
      ].join(','));
    });
    return rows.join('\r\n');
  }

  function markdownCell(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/[\r\n]+/g, ' ')
      .trim();
  }

  // A GitHub-flavored Markdown table. Job-only exports get Status in place
  // of Tracker; a mixed export keeps both.
  function buildMarkdown(logs, metricNames, options = {}) {
    const names = metricNames || {};
    const list = logs || [];
    const jobsOnly = list.length > 0 && list.every(l => l.metricId === 'jobs');
    const headers = jobsOnly
      ? ['Date', 'Company', 'Role', 'Status', 'Notes']
      : ['Date', 'Tracker', 'Count', 'Company', 'Role', 'Status', 'Notes'];
    const lines = [];
    if (options.title) lines.push('## ' + markdownCell(options.title), '');
    lines.push('| ' + headers.join(' | ') + ' |');
    lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
    list.forEach(l => {
      const cells = jobsOnly
        ? [l.date, l.company, l.role, statusText(l), l.notes]
        : [l.date, names[l.metricId] || l.metricId, l.count || 1, l.company, l.role, statusText(l), l.notes];
      lines.push('| ' + cells.map(markdownCell).join(' | ') + ' |');
    });
    return lines.join('\n') + '\n';
  }

  // Tab-separated rows for pasting straight into Google Sheets or Excel: a
  // paste splits on tabs into columns. Tabs and line breaks inside a value
  // become spaces, and formula-looking cells get the same quote guard as CSV.
  function tsvCell(value) {
    let s = value === null || value === undefined ? '' : String(value);
    s = s.replace(/[\t\r\n]+/g, ' ').trim();
    if (/^[=+@]/.test(s) || /^-(?![\d.\s])/.test(s)) s = "'" + s;
    return s;
  }

  function buildTsv(logs, metricNames) {
    const names = metricNames || {};
    const rows = [['Date', 'Goal', 'Count', 'Company', 'Role', 'Status', 'Notes', 'Link'].join('\t')];
    (logs || []).forEach(l => {
      rows.push([
        l.date, names[l.metricId] || l.metricId, l.count || 1, l.company, l.role, statusText(l), l.notes, l.url
      ].map(tsvCell).join('\t'));
    });
    return rows.join('\n');
  }

  // Narrows entries for an export: one goal (or 'all') and the last `days`
  // days counted back from `today` (YYYY-MM-DD), or every day for 'all'.
  // Returns oldest first, the order a spreadsheet reads best.
  function filterLogs(logs, options = {}) {
    const metricId = options.metricId || 'all';
    const days = options.days === 'all' || !options.days ? 'all' : Math.max(1, parseInt(options.days, 10) || 1);
    let since = '';
    if (days !== 'all' && options.today) {
      const d = new Date(options.today + 'T12:00:00');
      d.setDate(d.getDate() - (days - 1));
      since = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    return (logs || [])
      .filter(l => l && (metricId === 'all' || l.metricId === metricId) && (!since || String(l.date) >= since))
      .slice()
      .sort((a, b) => (String(a.date) + String(a.timestamp || '')).localeCompare(String(b.date) + String(b.timestamp || '')));
  }

  function backupFilename(prefix, ext, date) {
    const d = date || new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return (prefix || 'lit-tracker') + '-' + stamp + '.' + ext;
  }

  return {
    csvCell,
    buildCsv,
    markdownCell,
    buildMarkdown,
    tsvCell,
    buildTsv,
    filterLogs,
    backupFilename,
    statusText
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LitExport;
}
