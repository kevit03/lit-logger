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
    backupFilename,
    statusText
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LitExport;
}
