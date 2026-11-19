// Answer composer for LIT auto-apply: writes an answer to an open-ended
// question by piecing together the answers already saved in the answer bank.
//
// Pure and synchronous: no storage, no network, no DOM, so it runs in the
// service worker (importScripts), in content scripts, and under Node tests.
//
//   compose({ question, kind: 'text', maxLength?, job: { title, company, description? },
//             profile, answers })
//     -> { text, sources: [answerId], score: 0..1 } | null
//
// It never invents anything: every sentence comes from a saved answer (with
// the company and role swapped for the current job), or, for "anything else"
// questions only, from profile facts.
const AnswerComposer = (() => {
  const DEFAULT_MAX = 1500;
  const MIN_SCORE = 0.25;
  const MAX_SOURCES = 3;
  const FALLBACK_SCORE = 0.25;

  const STOP = new Set((
    'a an the and or but nor so of to in on for with at by from as into onto than then that this these those ' +
    'is are was were be been being am do does did doing done have has had having will would shall should can could may might must ' +
    'i me my mine myself you your yours yourself we us our ours it its they them their he she his her ' +
    'what which who whom whose why how when where whether if there here any some all each every no not only own same ' +
    'very too just also more most much many such other another about up down out over under again further once ' +
    'please tell describe share explain give provide briefly write let know us ever example examples answer question ' +
    'want like would wish think feel get got make made thing things something anything time one'
  ).split(/\s+/));

  // Intents a question can carry. `combine` intents can be answered by more
  // than one saved answer at once (two strengths read fine together); the
  // rest speak in one voice (two different "why us" answers would repeat).
  const INTENTS = [
    { name: 'whyCompany', re: /\bwhy (do |would )?you (want|like|wish|hope) to (work|join|be part)|\bwhy (do you want to |would you like to )?(work (at|for|with)|join)\b|\bwhy (us|our company|this company|here)\b|what (excites|interests|attracts|draws) you (most )?(about|to) (us|our|this company|working (at|here|with us)|joining)|\binterest(ed)? in (joining|working (at|for|with|here))|\bwhy are you (applying|interested) (to|at|in) (us|our company|this company)\b|\bmission\b/ },
    { name: 'whyRole', re: /\bwhy (this|the|our) (role|position|job|internship|team|opportunity)\b|\binterest(ed)? in (this|the|our) (role|position|job|internship|opportunity|team)\b|\bwhy (are you )?(applying|apply)( for)? (to )?(this|the) (role|position|job|internship)\b|\bwhat (excites|interests|attracts) you about (this|the) (role|position|job|internship|opportunity)\b/ },
    { name: 'project', combine: true, re: /\bprojects?\b|\bproud\b|\baccomplish|\bachievement|\bsomething (you('ve| have)? )?(built|made|created|shipped)|\bbuilt\b|\bside project|\bportfolio piece/ },
    { name: 'challenge', combine: true, re: /\bchalleng|\bdifficult|\bobstacle|\bfail(ed|ure)?\b|\bmistake|\bsetback|\bconflict|\bovercome|\bovercame|\bhard problem|\bstruggl/ },
    { name: 'strengths', combine: true, re: /\bstrengths?\b|\bskills?\b|\bqualif|\b(good|great|strong|right|best) fit\b|\bstand out\b|\bsets? you apart\b|\bunique(ly)?\b|\bwhy should we hire|\bwhat (do you|would you) bring\b|\bsuperpower/ },
    { name: 'leadership', combine: true, re: /\blead(er|ers|ership|ing)?\b|\bled\b|\bteam ?work|\bcollaborat|\b(on|in|with|within) a team\b|\bmentor|\binitiative\b/ },
    { name: 'interests', combine: true, re: /\bhobb(y|ies)\b|\bpassion|\boutside (of )?(work|school|class)|\bmotivat|\bwhat (do you|are you) (enjoy|passionate)|\bfree time\b|\bspare time\b|\bcurious about\b/ },
    { name: 'about', combine: true, re: /\btell (us|me) (a bit |a little )?about (yourself|you)\b|\bintroduce yourself\b|\bdescribe yourself\b|\babout (yourself|you)\b|\byour background\b|\bwho are you\b/ },
    { name: 'availability', re: /\bavailab|\bstart date\b|\bwhen (can|could|would) you start\b|\bearliest (start|date)\b|\btime (constraints?|commitments?)\b|\bhours (per|a) week\b|\bnotice period\b|\bschedule (conflicts?|constraints?)\b|\bgraduat(e|ion) date\b/ },
    { name: 'anythingElse', re: /\banything else\b|\badditional (information|info|comments?|details|notes?)\b|\bother (information|info|comments?)\b|\b(want|like) (us|the hiring team) to know\b|\bis there anything\b/ },
    { name: 'coverLetter', re: /\bcover letter\b|\bletter of (interest|motivation|intent)\b|\bmotivation(al)? letter\b|\bpersonal statement\b/ },
    { name: 'salary', re: /\bsalary\b|\bcompensation\b|\bpay (expectations?|range|requirements?)\b|\bdesired (pay|rate|wage)\b|\bhourly rate\b|\bexpected (pay|wage)\b/ }
  ];
  const INTENT_BY_NAME = {};
  INTENTS.forEach(i => { INTENT_BY_NAME[i.name] = i; });
  // A cover letter is answered from several kinds of saved answer at once.
  const EXPANDS = { coverLetter: ['coverLetter', 'about', 'whyCompany', 'whyRole', 'project', 'strengths'] };

  // A sentence that claims first-hand experience with a company. When the
  // answer is re-targeted to another company, keeping it would make that
  // experience up, so it is dropped instead.
  const EXPERIENCE = /\b(i|we)\s+(have\s+|'ve\s+|had\s+|recently\s+|already\s+)?(used|use|worked|interned|built|met|visited|spoke|talked|attended|shipped|contributed|followed|read|watched|interviewed|applied|integrated|been)\b/i;

  // ----- Text helpers --------------------------------------------------------

  function str(v) {
    return v === undefined || v === null ? '' : String(v);
  }

  function clean(text) {
    return str(text).replace(/\s+/g, ' ').trim();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Light stemming: enough that challenge, challenges, challenging and
  // challenged meet, and companies meets company.
  function stem(word) {
    let w = word;
    if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
    return w;
  }

  function tokens(text) {
    const out = new Set();
    str(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).forEach(raw => {
      if (!raw || raw.length < 2 || STOP.has(raw)) return;
      out.add(stem(raw));
    });
    return out;
  }

  function overlap(a, b) {
    let n = 0;
    a.forEach(t => { if (b.has(t)) n++; });
    return n;
  }

  function dice(a, b) {
    if (!a.size || !b.size) return 0;
    return (2 * overlap(a, b)) / (a.size + b.size);
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    const inter = overlap(a, b);
    return inter / (a.size + b.size - inter);
  }

  function intentsOf(text, job) {
    const t = ' ' + clean(text).toLowerCase() + ' ';
    const found = new Set();
    INTENTS.forEach(i => { if (i.re.test(t)) found.add(i.name); });
    // "Why Acme?" names the company instead of saying "us".
    const company = clean(job && job.company).toLowerCase();
    if (company && /\bwhy\b/.test(t) && t.includes(company) && !found.has('whyRole')) found.add('whyCompany');
    return found;
  }

  // Sentences of a saved answer, in order. Line breaks and bullets count as
  // boundaries; a sentence without end punctuation gets a period.
  function splitSentences(text) {
    const out = [];
    // A line ending in a comma or colon ("Dear team,") runs into the next.
    str(text).replace(/([,;:])[ \t]*\n+\s*/g, '$1 ').split(/\n+/).forEach(line => {
      const l = clean(line.replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      if (!l) return;
      l.split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[\p{Lu}\p{N}])/u).forEach(s => {
        let sentence = clean(s);
        if (!sentence) return;
        if (!/[.!?]["')\]]?$/.test(sentence)) sentence += '.';
        out.push(sentence);
      });
    });
    return out;
  }

  function capitalizeFirst(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Trims to at most `max` characters at a sentence boundary. Paragraph
  // breaks are kept. A first sentence longer than `max` is cut at a word.
  function trimToLength(text, max) {
    const limit = Number(max) > 0 ? Math.floor(Number(max)) : DEFAULT_MAX;
    const body = str(text).trim();
    if (body.length <= limit) return body;
    const paragraphs = body.split(/\n{2,}/).map(p => splitSentences(p)).filter(p => p.length);
    let out = '';
    for (const para of paragraphs) {
      let started = false;
      for (const sentence of para) {
        const sep = !out ? '' : (started ? ' ' : '\n\n');
        if (out.length + sep.length + sentence.length > limit) return out || cutWords(sentence, limit);
        out += sep + sentence;
        started = true;
      }
    }
    return out;
  }

  function cutWords(sentence, limit) {
    if (limit < 2) return '';
    let cut = sentence.slice(0, limit - 1);
    const space = cut.lastIndexOf(' ');
    if (space > limit / 3) cut = cut.slice(0, space);
    cut = cut.replace(/[\s,;:\-]+$/, '').replace(/[.!?]+$/, '');
    return cut ? cut + '.' : '';
  }

  // Drops an unfinished last sentence (a reply cut off at max_tokens).
  function dropPartialSentence(text) {
    const body = str(text).trim();
    if (/[.!?]["')\]]?$/.test(body)) return body;
    const m = body.match(/^[\s\S]*[.!?]["')\]]?(?=\s)/);
    return m ? m[0].trim() : body;
  }

  // ----- Re-targeting ------------------------------------------------------------

  function wordRe(name, flags) {
    return new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(name) + '(?![\\p{L}\\p{N}])', flags || 'giu');
  }

  const PLACEHOLDER = {
    company: /\{\{?\s*(company|company name|employer|organization)\s*\}?\}|\[\s*(company|company name)\s*\]/gi,
    role: /\{\{?\s*(role|position|job title|title|job)\s*\}?\}|\[\s*(role|position|job title)\s*\]/gi
  };

  // Replaces every match; a lowercase replacement ("your company") is
  // capitalized only where it starts a sentence.
  function swap(s, re, replacement) {
    return s.replace(re, (...args) => {
      const offset = args[args.length - 2];
      const atStart = /(^|[.!?:]\s+|\n\s*)$/.test(s.slice(0, offset));
      return atStart ? capitalizeFirst(replacement) : replacement;
    });
  }

  // Swaps the saved answer's own company / role for the current job's and
  // fills placeholders. Returns null for a sentence that has to go.
  function retargetSentence(sentence, saved, job) {
    const oldCompany = clean(saved && saved.company);
    const oldRole = clean(saved && saved.role);
    const newCompany = clean(job && job.company);
    const newRole = clean(job && job.title);
    let s = sentence;
    const companyChanges = oldCompany && oldCompany.toLowerCase() !== newCompany.toLowerCase();
    if (companyChanges && wordRe(oldCompany, 'iu').test(s) && EXPERIENCE.test(s)) return null;

    if (oldRole && oldRole.toLowerCase() !== newRole.toLowerCase()) {
      if (newRole) s = swap(s, wordRe(oldRole), newRole);
      else {
        const re = new RegExp('(?:(?<![\\p{L}\\p{N}])(?:the|a|an|this)\\s+)?' + escapeRe(oldRole) + '(?:\\s+(?:role|position|job))?(?![\\p{L}\\p{N}])', 'giu');
        s = swap(s, re, 'this role');
      }
    }
    if (companyChanges) s = swap(s, wordRe(oldCompany), newCompany || 'your company');
    s = swap(s, PLACEHOLDER.company, newCompany || 'your company');
    s = swap(s, PLACEHOLDER.role, newRole || 'this role');
    return capitalizeFirst(s);
  }

  // ----- Ranking -------------------------------------------------------------------

  function normalizeAnswers(answers) {
    if (!Array.isArray(answers)) return [];
    return answers.filter(a => a && typeof a === 'object' && clean(a.answer) && clean(a.question || a.labelKey));
  }

  // Relevance of each saved answer to the question, best first.
  function rank(question, answers, job) {
    const q = tokens(question);
    const qIntents = intentsOf(question, job);
    const wanted = new Set();
    qIntents.forEach(n => (EXPANDS[n] || [n]).forEach(x => wanted.add(x)));
    return normalizeAnswers(answers).map(a => {
      const savedQ = clean(a.question || a.labelKey);
      const aq = tokens(savedQ);
      const aa = tokens(a.answer);
      const aIntents = intentsOf(savedQ, { company: a.company });
      const shared = Array.from(aIntents).filter(n => wanted.has(n));
      const qq = dice(q, aq);
      const qa = q.size ? overlap(q, aa) / q.size : 0;
      let score;
      if (wanted.size) {
        score = (shared.length ? 0.5 : 0) + 0.35 * qq + 0.15 * qa;
        if (!shared.length && aIntents.size) score *= 0.5;
      } else {
        score = 0.75 * qq + 0.25 * qa;
      }
      return { answer: a, score: Math.min(1, score), intents: aIntents, shared };
    }).sort((x, y) => (y.score - x.score) || str(y.answer.updatedAt).localeCompare(str(x.answer.updatedAt)));
  }

  // Best 1-3 answers: the top one, the best one for every other intent the
  // question asks about, then close runners-up where answers combine well.
  function choose(ranked, question, job) {
    const best = ranked[0];
    if (!best || best.score < MIN_SCORE) return [];
    const chosen = [best];
    const has = r => chosen.includes(r);
    const qIntents = intentsOf(question, job);
    const wanted = [];
    qIntents.forEach(n => (EXPANDS[n] || [n]).forEach(x => { if (!wanted.includes(x)) wanted.push(x); }));
    const covered = new Set(best.shared);
    wanted.forEach(name => {
      if (chosen.length >= MAX_SOURCES || covered.has(name)) return;
      const pick = ranked.find(r => !has(r) && r.score >= MIN_SCORE && r.intents.has(name));
      if (!pick) return;
      chosen.push(pick);
      pick.shared.forEach(n => covered.add(n));
    });
    const floor = Math.max(0.35, best.score * 0.75);
    ranked.forEach(r => {
      if (chosen.length >= MAX_SOURCES || has(r) || r.score < floor) return;
      // Single-voice intents (why us, salary, availability) never stack.
      const combinable = wanted.length
        ? r.shared.length && r.shared.every(n => INTENT_BY_NAME[n] && INTENT_BY_NAME[n].combine)
        : true;
      if (combinable) chosen.push(r);
    });
    return chosen.sort((x, y) => y.score - x.score);
  }

  // ----- Assembly ------------------------------------------------------------------

  function assemble(chosen, job, maxLength) {
    const kept = [];
    const paragraphs = [];
    const sources = [];
    chosen.forEach(r => {
      const sentences = [];
      splitSentences(r.answer.answer).forEach(raw => {
        const s = retargetSentence(raw, r.answer, job);
        if (!s) return;
        const t = tokens(s);
        const norm = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        const dup = kept.some(k => k.norm === norm || (t.size >= 3 && jaccard(t, k.tokens) >= 0.7));
        if (dup) return;
        kept.push({ norm, tokens: t });
        sentences.push(s);
      });
      if (!sentences.length) return;
      sources.push(r.answer.id);
      paragraphs.push(sentences.join(' '));
    });
    if (!paragraphs.length) return null;
    // At most two paragraphs: the best answer, then everything it is
    // combined with. Short fields get one line.
    const limit = Number(maxLength) > 0 ? Math.floor(Number(maxLength)) : DEFAULT_MAX;
    let text;
    if (paragraphs.length === 1) text = paragraphs[0];
    else if (limit < 400) text = paragraphs.join(' ');
    else text = paragraphs[0] + '\n\n' + paragraphs.slice(1).join(' ');
    text = trimToLength(text, limit);
    if (!text) return null;
    return { text, sources };
  }

  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

  function graduated(profile, now) {
    const year = parseInt(profile.gradYear, 10);
    if (!year) return null;
    const idx = MONTHS.findIndex(m => clean(profile.gradMonth).toLowerCase().startsWith(m.slice(0, 3)));
    const month = idx >= 0 ? idx : 5;
    const d = now instanceof Date ? now : new Date();
    return d.getFullYear() > year || (d.getFullYear() === year && d.getMonth() > month);
  }

  // A short answer for "anything else?" built only from profile facts.
  function profileFallback(profile, job, maxLength, now) {
    const p = profile && typeof profile === 'object' ? profile : {};
    const school = clean(p.school);
    const major = clean(p.major);
    const degree = clean(p.degree);
    const when = clean([clean(p.gradMonth), clean(p.gradYear)].filter(Boolean).join(' '));
    const title = clean(p.currentTitle);
    const employer = clean(p.currentCompany);
    const sentences = [];
    if (title) sentences.push('I currently work as ' + (/^[aeiou]/i.test(title) ? 'an ' : 'a ') + title + (employer ? ' at ' + employer : '') + '.');
    if (school) {
      const done = graduated(p, now);
      if (done === true) {
        sentences.push('I graduated from ' + school + (degree || major ? ' with ' + (degree ? (/^[aeiou]/i.test(degree) ? 'an ' : 'a ') + degree : 'a degree') + (major ? ' in ' + major : '') : '') + (when ? ' in ' + when : '') + '.');
      } else {
        sentences.push('I am ' + (major ? 'studying ' + major + ' at ' : 'a student at ') + school + (when ? ' and expect to graduate in ' + when : '') + '.');
      }
    }
    if (!sentences.length) return null;
    const role = clean(job && job.title);
    const company = clean(job && job.company);
    sentences.push('Thank you for considering my application' + (role ? ' for the ' + role + ' role' : '') + (company ? ' at ' + company : '') + '.');
    const text = trimToLength(sentences.join(' '), maxLength);
    return text ? { text, sources: [], score: FALLBACK_SCORE } : null;
  }

  // ----- Public ----------------------------------------------------------------------

  function compose(input) {
    const opts = input && typeof input === 'object' ? input : {};
    const question = clean(opts.question);
    if (!question) return null;
    if (opts.kind && opts.kind !== 'text') return null;
    const job = opts.job && typeof opts.job === 'object' ? opts.job : {};
    const maxLength = Number(opts.maxLength) > 0 ? Math.floor(Number(opts.maxLength)) : DEFAULT_MAX;
    const ranked = rank(question, opts.answers, job);
    const chosen = choose(ranked, question, job);
    if (chosen.length) {
      const built = assemble(chosen, job, maxLength);
      if (built) return { text: built.text, sources: built.sources, score: Math.round(chosen[0].score * 1000) / 1000 };
    }
    if (intentsOf(question, job).has('anythingElse')) return profileFallback(opts.profile, job, maxLength, opts.now);
    return null;
  }

  return {
    DEFAULT_MAX,
    MIN_SCORE,
    INTENTS: INTENTS.map(i => i.name),
    compose,
    rank,
    tokens,
    stem,
    intentsOf,
    splitSentences,
    trimToLength,
    dropPartialSentence,
    retargetSentence
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnswerComposer;
}
