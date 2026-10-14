// Job page understanding for LIT: what company and role a page is about, and
// how sure we are that it is a job application at all.
//
// Used by the universal auto-tracker (content/adapters/ats/universal.js), the
// on-demand "Log application from this page" action (content/quick-log.js),
// and the lightweight page check that decides whether to load either
// (content/universal-bootstrap.js mirrors JOB_HOST and JOB_PATH).
//
// Nothing here touches storage or mutates the page.
const JobMeta = (() => {
  // A page, or an SPA route, the application has just been submitted from.
  const CONFIRM_URL = /(confirmation|thank-?you|application-submitted|success|applied|submission-complete|completed)(\/|\?|#|$)/i;

  // High-confidence confirmation wording. Deliberately phrased around
  // "application" so an order, a newsletter, or a comment never matches.
  const SUCCESS_TEXT = /(thank(s| you) for (applying|your application|your interest in (joining|working))|application (has been |was )?(submitted|received|sent|complete)|we('ve| have) received your application|your application (has been |was )?(sent|submitted|received)( successfully)?|successfully (submitted|applied|sent your application)|you('ve| have) (successfully )?applied)/i;

  // Wording that means the success message is about something else.
  const NEGATIVE_TEXT = /\b(newsletter|subscri(be|bed|bing|ption)|your order|order (number|#|confirmed|confirmation)|shopping cart|checkout|shipping|receipt|purchase|payment|password|reset link|verify your email|comment (has been )?(posted|submitted)|your comment|reply posted|credit card|loan|mortgage|rental|scholarship|grant application|visa application|membership)\b/i;

  const JOB_HOST = /^(careers?|jobs?|apply|hire|hiring|recruit(ing|ment)?|talent|work|join)[.-]/i;
  const JOB_PATH = /\/(jobs?|careers?|apply|application|applications|positions?|openings?|vacanc(y|ies)|opportunit(y|ies)|join-us|work-with-us|hiring|requisitions?|postings?)(\/|\?|#|$|-)/i;
  const NON_JOB_PATH = /\/(blog|news|articles?|posts?|press|stories|events?|podcasts?|webinars?|shop|store|cart|checkout|account|login|signin|signup|support|help)(\/|$)/i;

  // Applicant tracking systems. `tenant` pulls the employer out of the URL.
  const ATS = [
    { name: 'Workable', host: /(^|\.)workable\.com$/, tenant: (u, labels) => (labels[0] === 'apply' || labels[0] === 'jobs' || labels[0] === 'www' ? seg(u, 0) : labels[0]) },
    { name: 'BambooHR', host: /(^|\.)bamboohr\.com$/, tenant: (u, labels) => labels[0] },
    { name: 'Rippling', host: /(^|\.)rippling-ats\.com$/, tenant: (u, labels) => labels[0] },
    { name: 'Rippling', host: /^ats\.rippling\.com$/, tenant: u => seg(u, 0) },
    { name: 'iCIMS', host: /(^|\.)icims\.com$/, tenant: (u, labels) => labels[0].replace(/^(careers|jobs|uscareers|external)-/, '').replace(/-(careers|jobs)$/, '') },
    { name: 'Taleo', host: /(^|\.)taleo\.net$/, tenant: (u, labels) => labels[0] },
    { name: 'SmartRecruiters', host: /(^|\.)smartrecruiters\.com$/, tenant: (u, labels) => (/^(jobs|careers|www)$/.test(labels[0]) ? seg(u, 0) : labels[0]) },
    { name: 'Jobvite', host: /(^|\.)jobvite\.com$/, tenant: (u, labels) => (/^(jobs|www|app)$/.test(labels[0]) ? seg(u, 0) : labels[0]) },
    { name: 'JazzHR', host: /(^|\.)applytojob\.com$/, tenant: (u, labels) => labels[0] },
    { name: 'Breezy HR', host: /(^|\.)breezy\.hr$/, tenant: (u, labels) => labels[0] },
    { name: 'Recruitee', host: /(^|\.)recruitee\.com$/, tenant: (u, labels) => labels[0] },
    { name: 'Pinpoint', host: /(^|\.)pinpointhq\.com$/, tenant: (u, labels) => labels[0] },
    { name: 'Greenhouse', host: /(^|\.)greenhouse\.io$/, tenant: u => u.searchParams.get('for') || (seg(u, 0) === 'embed' ? '' : seg(u, 0)) },
    { name: 'Lever', host: /(^|\.)lever\.co$/, tenant: u => seg(u, 0) },
    { name: 'Ashby', host: /(^|\.)ashbyhq\.com$/, tenant: u => seg(u, 0) },
    { name: 'Workday', host: /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/, tenant: (u, labels) => labels[0] }
  ];

  // Site names that are the ATS or a job board, never the employer.
  const PLATFORM_NAMES = /^(workable|greenhouse|lever|ashby|workday|icims|taleo|oracle|smartrecruiters|jobvite|bamboohr|bamboo hr|breezy|breezy hr|recruitee|pinpoint|jazzhr|jazz hr|rippling|linkedin|indeed|glassdoor|ziprecruiter|wellfound|angellist|careers?|jobs?|home|apply)$/i;

  const TWO_LEVEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.in', 'co.kr', 'co.za', 'com.br', 'com.mx', 'com.sg', 'com.hk', 'com.tr', 'com.cn', 'com.tw', 'co.il', 'com.ar']);
  const GENERIC_LABELS = /^(www\d*|careers?|jobs?|apply|hire|hiring|recruit(ing|ment)?|talent|work|join|boards?|app|portal|en|us)$/i;

  const GENERIC_HEADING = /^(thank(s| you)|apply( now| for this job)?|application( form)?|careers?|jobs?|join us|success|submitted|congratulations|confirmation|open (roles|positions)|welcome|sign in|log in|home)\b/i;

  function seg(url, i) {
    return url.pathname.split('/').filter(Boolean)[i] || '';
  }

  function textOf(node) {
    if (!node) return '';
    const t = node.textContent !== undefined ? node.textContent : (node.innerText || '');
    return String(t || '').replace(/\s+/g, ' ').trim();
  }

  function humanize(slug) {
    const s = String(slug || '').trim();
    if (!s) return '';
    // Leave already-cased names ("OpenAI", "DoorDash") alone.
    if (/[A-Z]/.test(s) && !/[-_]/.test(s)) return s;
    return s.replace(/[-_]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function toURL(input) {
    if (input && typeof input === 'object' && typeof input.hostname === 'string' && input.searchParams) return input;
    try { return new URL(String(input)); } catch (e) { return null; }
  }

  function atsFor(hostname) {
    const host = String(hostname || '').toLowerCase();
    return ATS.find(a => a.host.test(host)) || null;
  }

  // careers.airbnb.com -> Airbnb, stripe.com -> Stripe, jobs.acme.co.uk -> Acme,
  // apply.workable.com/acme-labs/... -> Acme Labs.
  function companyFromUrl(input) {
    const url = toURL(input);
    if (!url) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    const labels = host.split('.');
    const ats = atsFor(host);
    if (ats) {
      let tenant = '';
      try { tenant = ats.tenant(url, labels) || ''; } catch (e) { tenant = ''; }
      tenant = decodeURIComponent(String(tenant)).replace(/\.(com|io|co)$/i, '');
      if (tenant && !GENERIC_LABELS.test(tenant)) return humanize(tenant);
      return '';
    }
    if (labels.length < 2) return '';
    const lastTwo = labels.slice(-2).join('.');
    const idx = TWO_LEVEL_SUFFIXES.has(lastTwo) ? labels.length - 3 : labels.length - 2;
    const label = labels[idx];
    if (!label || GENERIC_LABELS.test(label)) return '';
    return humanize(label);
  }

  function metaContent(doc, selector) {
    const el = doc && doc.querySelector ? doc.querySelector(selector) : null;
    const v = el ? (el.getAttribute('content') || '') : '';
    return String(v).replace(/\s+/g, ' ').trim();
  }

  function asArray(v) {
    return Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]);
  }

  function isJobPosting(node) {
    return asArray(node && node['@type']).some(t => String(t).toLowerCase() === 'jobposting');
  }

  // Every JobPosting in the page's JSON-LD, flattened out of @graph blocks
  // and arrays. Malformed blocks are skipped.
  function readJsonLd(doc) {
    const out = [];
    if (!doc || !doc.querySelectorAll) return out;
    const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (let i = 0; i < scripts.length && i < 20; i++) {
      let data;
      try { data = JSON.parse(scripts[i].textContent || ''); } catch (e) { continue; }
      const stack = asArray(data).slice();
      let guard = 0;
      while (stack.length && guard++ < 200) {
        const node = stack.shift();
        if (!node || typeof node !== 'object') continue;
        if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);
        if (Array.isArray(node)) { stack.push(...node); continue; }
        if (!isJobPosting(node)) continue;
        const org = node.hiringOrganization;
        const identifier = node.identifier;
        out.push({
          title: typeof node.title === 'string' ? node.title.trim() : '',
          company: typeof org === 'string' ? org.trim() : (org && typeof org.name === 'string' ? org.name.trim() : ''),
          identifier: typeof identifier === 'string' || typeof identifier === 'number'
            ? String(identifier)
            : (identifier && identifier.value !== undefined ? String(identifier.value) : ''),
          url: typeof node.url === 'string' ? node.url : ''
        });
      }
    }
    return out;
  }

  function cleanCompany(name) {
    const s = String(name || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*[-|:]\s*(careers?|jobs?|job board|hiring|open (roles|positions)).*$/i, '')
      .replace(/^(careers?|jobs?)\s+(at|@)\s+/i, '')
      .replace(/\s+(careers?|jobs?)$/i, '')
      .trim();
    if (!s || PLATFORM_NAMES.test(s)) return '';
    return s.slice(0, 120);
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // "Senior Engineer - Careers | Airbnb" -> "Senior Engineer".
  function cleanRole(title, company) {
    let s = String(title || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    s = s.replace(/^(job application for|apply(ing)? (for|to)|application for|job details:?)\s+/i, '');
    if (company) {
      const c = escapeRe(company);
      s = s.replace(new RegExp('\\s*(\\bat\\b|@|[-|:\\u2013\\u2014])\\s*' + c + '(\\s+(careers?|jobs?))?\\s*$', 'i'), '');
      s = s.replace(new RegExp('^' + c + '(\\s+(careers?|jobs?))?\\s*[-|:\\u2013\\u2014]\\s*', 'i'), '');
    }
    s = s.replace(/\s*[-|:–—]\s*(careers?|jobs?|job board|apply( now)?|job details|job description|open roles?)\s*$/i, '');
    s = s.replace(/\s*[-|–—]\s*[^-|–—]*\b(careers?|jobs?)\s*$/i, '');
    s = s.trim();
    if (!s || GENERIC_HEADING.test(s)) return '';
    return s.slice(0, 160);
  }

  function firstText(doc, selectors) {
    for (const sel of selectors) {
      let el = null;
      try { el = doc.querySelector(sel); } catch (e) { el = null; }
      const text = textOf(el);
      if (text && !GENERIC_HEADING.test(text) && text.length <= 160) return text;
    }
    return '';
  }

  const ROLE_SELECTORS = [
    '[data-automation-id*="jobTitle"]',
    '[data-automation-id="jobPostingHeader"]',
    '[itemprop="title"]',
    '[data-testid*="job-title"]',
    '[class*="job-title"]',
    '[class*="jobTitle"]',
    '[class*="posting-headline"] h2',
    'h1'
  ];

  const JOB_SEGMENT = /^(jobs?|j|p|o|postings?|positions?|requisitions?|openings?|careers?|vacanc(y|ies)|roles?)$/i;
  const GENERIC_SEGMENT = /^(apply|application|applications|search|results|all|list|openings|details|description|overview|thank-?you|confirmation|success)$/i;
  const ID_PARAMS = ['gh_jid', 'jobId', 'job_id', 'jobid', 'job', 'reqId', 'req', 'requisitionId', 'postingId', 'jid', 'id'];

  // The listing id in a path: the first segment after a jobs keyword that
  // contains a digit (/jobs/4821, /j/4F2C9A1B7D, /positions/77), else the
  // first long, non-generic slug after one (/jobs/senior-designer). A short
  // word like /jobs/uk/... is never taken for an id, so two different
  // listings on one site cannot collapse into one.
  function idInPath(pathname) {
    const segs = String(pathname || '').split('/').filter(Boolean).map(x => {
      try { return decodeURIComponent(x); } catch (e) { return x; }
    });
    const after = [];
    segs.forEach((seg, i) => {
      if (JOB_SEGMENT.test(seg)) after.push(segs.slice(i + 1, i + 4));
    });
    for (const rest of after) {
      const hit = rest.find(x => /\d/.test(x) && /^[\w-]{2,80}$/.test(x));
      if (hit) return hit;
    }
    for (const rest of after) {
      const hit = rest.find(x => x.length >= 6 && /^[\w-]{6,80}$/.test(x) && !JOB_SEGMENT.test(x) && !GENERIC_SEGMENT.test(x));
      if (hit) return hit;
    }
    return '';
  }

  // Stable id for "the same listing": the JSON-LD identifier, a job id in
  // the path or the query (Taleo, iCIMS), or the application path with its
  // confirmation suffix removed.
  function sourceIdFor(url, ld) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (ld && ld.identifier) return host + ':' + ld.identifier.slice(0, 100);
    const pathId = idInPath(url.pathname);
    if (pathId) return host + ':' + pathId.toLowerCase();
    for (const key of ID_PARAMS) {
      const v = url.searchParams.get(key);
      if (v && /^[\w-]{2,80}$/.test(v)) return host + ':' + key.toLowerCase() + '=' + v.toLowerCase();
    }
    const base = url.pathname
      .replace(/\/(confirmation|thank-?you|application-submitted|success|applied|submission-complete|completed)(\/.*)?$/i, '')
      .replace(/\/(apply|application)\/?$/i, '')
      .replace(/\/+$/, '');
    return host + ':' + (base || '/').toLowerCase().slice(0, 120);
  }

  // Company and role for the page, each with where it came from.
  function extract(doc, input) {
    const url = toURL(input);
    const ld = readJsonLd(doc)[0] || null;
    let company = '';
    let companySource = '';
    if (ld && cleanCompany(ld.company)) { company = cleanCompany(ld.company); companySource = 'json-ld'; }
    if (!company) {
      const site = cleanCompany(metaContent(doc, 'meta[property="og:site_name"]'));
      if (site) { company = site; companySource = 'og:site_name'; }
    }
    if (!company && url) {
      const fromUrl = companyFromUrl(url);
      if (fromUrl) { company = fromUrl; companySource = 'domain'; }
    }

    let role = '';
    let roleSource = '';
    if (ld && cleanRole(ld.title, company)) { role = cleanRole(ld.title, company); roleSource = 'json-ld'; }
    if (!role) {
      const og = cleanRole(metaContent(doc, 'meta[property="og:title"]'), company);
      if (og) { role = og; roleSource = 'og:title'; }
    }
    if (!role) {
      const heading = cleanRole(firstText(doc, ROLE_SELECTORS), company);
      if (heading) { role = heading; roleSource = 'heading'; }
    }
    if (!role && doc) {
      const fromTitle = cleanRole(doc.title, company);
      if (fromTitle && (!company || fromTitle.toLowerCase() !== company.toLowerCase())) { role = fromTitle; roleSource = 'title'; }
    }

    return {
      company,
      role,
      companySource,
      roleSource,
      sourceId: url ? sourceIdFor(url, ld) : '',
      url: url ? url.origin + url.pathname : ''
    };
  }

  const KEYWORDS = [
    /\b(resume|résumé|curriculum vitae|cv)\b/i,
    /\bcover letter\b/i,
    /\b(job title|position|role you('re| are) applying)\b/i,
    /\bapplicant\b/i,
    /\bcareers?\b/i,
    /\binterview\b/i,
    /\blinkedin( profile| url)?\b/i,
    /\b(work authori[sz]ation|visa sponsorship|sponsorship|legally authori[sz]ed)\b/i,
    /\b(years of experience|salary expectations?|notice period|start date)\b/i
  ];

  function formText(doc) {
    const parts = [doc.title || '', metaContent(doc, 'meta[name="description"]'), metaContent(doc, 'meta[property="og:title"]')];
    let nodes = [];
    try { nodes = doc.querySelectorAll('label, legend, h1, h2, h3, button, [role="heading"], [aria-label]'); } catch (e) { nodes = []; }
    for (let i = 0; i < nodes.length && i < 250; i++) {
      parts.push(textOf(nodes[i]));
      const aria = nodes[i].getAttribute && nodes[i].getAttribute('aria-label');
      if (aria) parts.push(aria);
    }
    return parts.join(' ').slice(0, 6000);
  }

  // How strongly the page looks like a job application. 3 or more is a job
  // page; the universal tracker never logs below that.
  const JOB_THRESHOLD = 3;

  function jobSignals(doc, input) {
    const url = toURL(input);
    let score = 0;
    const reasons = [];
    const add = (n, why) => { score += n; reasons.push(why); };
    if (url) {
      if (atsFor(url.hostname)) add(3, 'ats-host');
      else if (JOB_HOST.test(url.hostname)) add(2, 'careers-host');
      if (JOB_PATH.test(url.pathname + url.search + url.hash)) add(2, 'job-path');
      if (NON_JOB_PATH.test(url.pathname)) add(-3, 'non-job-path');
    }
    if (doc) {
      if (readJsonLd(doc).length) add(3, 'json-ld');
      let files = [];
      try { files = doc.querySelectorAll('input[type="file"]'); } catch (e) { files = []; }
      if (files.length) {
        const resumeFile = Array.prototype.some.call(files, f => {
          const hint = [f.getAttribute('name'), f.getAttribute('id'), f.getAttribute('accept'), f.getAttribute('aria-label'), f.getAttribute('data-testid')].join(' ');
          return /resume|cv|cover|\.pdf|\.docx?/i.test(hint);
        });
        add(resumeFile ? 3 : 1, resumeFile ? 'resume-upload' : 'file-upload');
      }
      const text = formText(doc);
      let hits = 0;
      KEYWORDS.forEach(re => { if (re.test(text)) hits++; });
      if (hits) add(Math.min(4, hits), 'keywords:' + hits);
    }
    return { score, isJob: score >= JOB_THRESHOLD, reasons };
  }

  function isConfirmationUrl(input) {
    const url = toURL(input);
    if (!url) return false;
    return CONFIRM_URL.test(url.pathname + url.search + url.hash);
  }

  function isSuccessText(text) {
    const t = String(text || '');
    return t.length > 0 && t.length <= 600 && SUCCESS_TEXT.test(t) && !NEGATIVE_TEXT.test(t);
  }

  // Cheap URL-only check, the same test the bootstrap runs before asking for
  // the full tracker.
  function looksLikeJobUrl(input) {
    const url = toURL(input);
    if (!url || !/^https?:$/.test(url.protocol)) return false;
    return !!atsFor(url.hostname) || JOB_HOST.test(url.hostname) || JOB_PATH.test(url.pathname + url.search + url.hash);
  }

  return {
    CONFIRM_URL,
    SUCCESS_TEXT,
    NEGATIVE_TEXT,
    JOB_HOST,
    JOB_PATH,
    JOB_THRESHOLD,
    atsFor,
    companyFromUrl,
    readJsonLd,
    cleanCompany,
    cleanRole,
    extract,
    jobSignals,
    isConfirmationUrl,
    isSuccessText,
    looksLikeJobUrl,
    sourceIdFor,
    humanize
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = JobMeta;
}
