// Runs in Jobright's own page world (manifest "world": "MAIN", document_start)
// so the Auto-apply panel can list exactly the jobs the page is showing.
//
// Jobright builds the first page of recommendations with refresh=true and
// pages on with refresh=false. Asking the API again from the panel does not
// give the same set: refresh=false at position 0 returns an older saved set,
// and refresh=true makes a new one. So this script watches the page's own
// list responses and hands each one to the panel (content/jobright/
// jobright-panel.js) with window.postMessage. It reads responses only; it
// never changes a request, a response, or the page.
(() => {
  if (typeof window === 'undefined' || window.__litJobrightTap) return;
  try {
    Object.defineProperty(window, '__litJobrightTap', { value: true });
  } catch (e) {
    return;
  }

  const PATH = '/swan/recommend/list/jobs';
  const TAG = 'lit-jobright-list';
  const MAX_BODY = 4 * 1024 * 1024;

  function wanted(url) {
    try {
      const u = new URL(String(url), location.href);
      return u.origin === location.origin && u.pathname === PATH;
    } catch (e) {
      return false;
    }
  }

  function hand(url, body) {
    if (typeof body !== 'string' || !body || body.length > MAX_BODY) return;
    try {
      window.postMessage({ source: TAG, url: new URL(String(url), location.href).href, body }, location.origin);
    } catch (e) { /* nothing to do */ }
  }

  // XMLHttpRequest (what Jobright uses today).
  try {
    const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (XHR) {
      const open = XHR.open;
      const send = XHR.send;
      XHR.open = function (method, url) {
        try { this.__litUrl = url; } catch (e) { /* frozen */ }
        return open.apply(this, arguments);
      };
      XHR.send = function () {
        try {
          if (wanted(this.__litUrl)) {
            this.addEventListener('load', () => {
              try {
                if (this.status !== 200) return;
                const rt = this.responseType;
                const body = rt === '' || rt === 'text' ? this.responseText
                  : rt === 'json' ? JSON.stringify(this.response) : '';
                hand(this.responseURL || this.__litUrl, body);
              } catch (e) { /* unreadable */ }
            });
          }
        } catch (e) { /* never break the page */ }
        return send.apply(this, arguments);
      };
    }
  } catch (e) { /* leave XHR alone */ }

  // fetch, in case the page moves to it.
  try {
    const realFetch = window.fetch;
    if (typeof realFetch === 'function') {
      window.fetch = function (input) {
        const p = realFetch.apply(this, arguments);
        try {
          const url = input && typeof input === 'object' && 'url' in input ? input.url : input;
          if (wanted(url)) {
            p.then(res => {
              if (!res || res.status !== 200) return;
              res.clone().text().then(body => hand(res.url || url, body), () => {});
            }, () => {});
          }
        } catch (e) { /* never break the page */ }
        return p;
      };
    }
  } catch (e) { /* leave fetch alone */ }
})();
