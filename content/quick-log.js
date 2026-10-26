// "Log application from this page": injected on demand by the service worker
// (context menu on the page or the toolbar icon). Reads the company and role
// the page describes, shows them in an editable card, warns when the same
// company was applied to in the last 90 days, and logs on confirmation.
//
// Needs shared/auth.js, shared/storage.js, shared/auto-tracker-core.js, and
// shared/job-meta.js in the same isolated world; the worker injects whichever
// of those the page does not already have.
(() => {
  if (typeof AutoTrackerCore === 'undefined' || typeof JobMeta === 'undefined' || typeof TrackerStorage === 'undefined') return;
  const core = AutoTrackerCore;
  let open = null;

  async function run() {
    // A second click while the card is up focuses it instead of stacking.
    if (open && !open.isDismissed()) return;
    const url = new URL(location.href);
    const details = JobMeta.extract(document, url);
    const host = url.hostname.replace(/^www\./, '');
    const sourceId = details.sourceId ? 'quick:' + details.sourceId : '';

    const toast = core.showToast('Log application from this page', {
      variant: 'info',
      sticky: true,
      detail: host,
      onClose: () => { open = null; }
    });
    if (!toast) return;
    open = toast;

    let prior = null;
    try {
      prior = await TrackerStorage.findRecentApplication({ company: details.company, sourceId, url: details.url });
    } catch (e) {
      prior = null;
    }
    if (prior) toast.setDetail(core.formatDuplicateMessage(prior, details.company));

    toast.showForm({
      fields: [
        { name: 'company', label: 'Company', value: details.company, placeholder: 'e.g. Acme Corp' },
        { name: 'role', label: 'Role', value: details.role, placeholder: 'e.g. Software Engineer' }
      ],
      submitLabel: prior ? 'Log anyway' : 'Log application',
      onSubmit: async values => {
        if (!values.company && !values.role) {
          toast.setDetail('Add a company or a role first.');
          return;
        }
        let log;
        try {
          log = await TrackerStorage.addLog({
            metricId: 'jobs',
            company: values.company,
            role: values.role,
            url: details.url,
            sourceId,
            source: 'quick',
            notes: 'Logged from ' + host
          });
        } catch (err) {
          open = null;
          toast.closeForm();
          toast.update('Could not log that application: ' + (err && err.message ? err.message : 'unknown error'), '', { variant: 'warn', sticky: false, durationMs: 6000 });
          return;
        }
        // The form is done; a new click may open a new card.
        open = null;
        toast.closeForm();
        toast.update(core.formatJobMessage(log.company, log.role), '', { variant: 'success', sticky: false, durationMs: 7000 });
        toast.setActions([{
          label: 'Undo',
          onClick: async t => {
            t.setActions(null);
            let removed = false;
            try { removed = await TrackerStorage.deleteLog(log.id); } catch (e) { removed = false; }
            t.update(removed ? core.formatJobMessage(log.company, log.role, 'Removed') : 'That entry was already removed.', '', { variant: 'info', sticky: false, durationMs: 3000 });
          }
        }]);
      },
      onCancel: t => {
        open = null;
        t.dismiss();
      }
    });
  }

  // The worker calls this again on later clicks instead of re-injecting.
  window.__ptQuickLog = () => { run().catch(() => {}); };
  run().catch(() => {});
})();
