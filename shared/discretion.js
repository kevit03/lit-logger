// Discretion rules for auto-apply: what a typical applicant would answer to
// the housekeeping questions an application form asks after the profile has
// run out (consent boxes, SMS opt-ins, "have you worked here before",
// "how did you hear about us").
//
//   decide(desc, { profile, job }) -> { value: string | boolean, why } | null
//
// `desc` is an AutofillCore FieldDescriptor (`kind`, `label`, `labelKey`,
// `options`, `required`). For a lone checkbox the value is a boolean (false
// means "decided: leave it unchecked"); for a field with options it is one of
// those options verbatim; for a text field or an option-less dropdown it is a
// short string ("Yes", "No", "Job board").
//
// Facts about the applicant are never decided here: work authorization,
// sponsorship, degrees, GPA, dates, salary, location choices, criminal
// history, and demographics beyond the neutral "decline to answer". Those
// return null so the profile, the answer writer, or the user answers them.
//
// Pure and synchronous: no DOM, no chrome APIs, so the Node tests load it
// directly and it costs nothing in a frame that never asks.
const LitDiscretion = (() => {
  'use strict';

  const collapse = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lower = s => collapse(s).toLowerCase().replace(/[‘’]/g, "'");

  // --- option picking ----------------------------------------------------------
  const YES_OPTION = /^(yes|y|true|i agree|agree|i accept|accept|i consent|i do|i am|i will|i certify|i confirm|i acknowledge|i understand|i have read)\b/;
  const NO_OPTION = /^(no|n|false|i do not|i don't|i am not|i have not|i haven't|i will not|not)\b/;
  const AGREE_OPTION = /\b(agree|accept|consent|acknowledge|certify|confirm|understand|opt in|opt-in)\b/;
  const NOT_AGREE = /\b(not|don't|disagree|decline|refuse|opt out|opt-out)\b/;
  const NEUTRAL_OPTION = /decline|prefer not|rather not|do(n't| not) wish|not wish|choose not|not to (say|answer|disclose|identify|self)|no answer|don't want to (answer|say|disclose)|do not want to (answer|say|disclose)/;

  function options(desc) {
    return Array.isArray(desc && desc.options) ? desc.options.map(collapse).filter(Boolean) : [];
  }

  function firstOption(opts, tests) {
    for (const t of tests) {
      const hit = opts.find(o => (typeof t === 'function' ? t(lower(o)) : t.test(lower(o))));
      if (hit) return hit;
    }
    return null;
  }

  function yesOption(opts) {
    return firstOption(opts, [
      YES_OPTION,
      o => /\byes\b/.test(o) && !/\bno\b|\bnot\b/.test(o),
      o => AGREE_OPTION.test(o) && !NOT_AGREE.test(o)
    ]);
  }

  function noOption(opts) {
    return firstOption(opts, [NO_OPTION, o => /\bno\b/.test(o) && !/\byes\b/.test(o)]);
  }

  function neutralOption(opts) {
    return firstOption(opts, [NEUTRAL_OPTION]);
  }

  // A lone checkbox answers with a boolean; everything else needs an option
  // (or, without options, the plain word).
  function isLoneCheckbox(desc) {
    return desc.kind === 'checkbox' && options(desc).length < 2;
  }

  function hasOptions(desc) {
    return options(desc).length > 0 && desc.kind !== 'text' && desc.kind !== 'textarea';
  }

  function answerYes(desc) {
    if (isLoneCheckbox(desc)) return true;
    if (hasOptions(desc)) return yesOption(options(desc));
    if (desc.kind === 'file') return null;
    return 'Yes';
  }

  function answerNo(desc) {
    if (isLoneCheckbox(desc)) return false;
    if (hasOptions(desc)) return noOption(options(desc));
    if (desc.kind === 'file') return null;
    return 'No';
  }

  const CHOICE_KINDS = ['checkbox', 'radio', 'select', 'combobox'];
  const ANY_KINDS = CHOICE_KINDS.concat(['text', 'textarea', 'email', 'tel', 'url']);

  // --- the rule table ----------------------------------------------------------
  // First match wins. A rule whose `kinds` do not include the field's kind is
  // skipped (the next rule may still match); a `never` rule always stops.
  // Each `act` returns { value, why } or null ("leave it alone").
  const RULES = [
    // Facts the applicant has to supply. Checked first so "I acknowledge I am
    // authorized to work..." is never ticked on the user's behalf.
    { id: 'never-authorization', never: true, test: /authori[sz]ed|authori[sz]ation|eligible to work|eligibility to work|right to work|work permit|legally (able|permitted|allowed|entitled)|permitted to work/ },
    { id: 'never-sponsorship', never: true, test: /sponsor|\bvisa\b|h-?1b|immigration|green card|\bstem opt\b|\bopt (ead|extension|status|work)\b|\bf-?1\b|\bcpt\b/ },
    { id: 'never-citizenship', never: true, test: /citizen|nationality|security clearance|\bclearance\b|export control|itar/ },
    { id: 'never-education', never: true, test: /\bdegree\b|bachelor|master's|masters\b|\bmba\b|\bph\.?d\b|doctorate|diploma|graduat|university|college|school|\bmajor\b|education|coursework|\bgpa\b|grade point|transcript/ },
    { id: 'never-dates', never: true, test: /(?<!up to )\bdates?\b|start(ing)? (date|work)|when (can|could|would) you|earliest|notice period|available to start|how (soon|many years)|years of (professional |relevant |work )?experience|\bmm\/|\bdd\/|\byyyy\b/ },
    { id: 'never-salary', never: true, test: /salary|compensation|pay (expectation|range|requirement)|expected pay|desired pay|\bwages?\b|hourly rate|\brate\b|\$|\bctc\b|equity expectation/ },
    { id: 'never-location', never: true, test: /relocat|which (office|location|city|cities|site|region|country)|what (office|location|city|region|country)|preferred (office|location|city|region|country|work location)|(select|choose) (an? |your )?(office|location|city|region|country)|where (are you|do you) (live|reside|located|based)|currently (live|reside|located|based)|\btime ?zone\b|\bzip\b|postal code|\b(home|mailing|street|physical|residential) address\b|\baddress line\b|\bcountry of\b/ },
    { id: 'never-criminal', never: true, test: /convict|felony|misdemeanor|criminal|arrest|pending charges|guilty/ },
    { id: 'never-identity', never: true, test: /social security|\bssn\b|date of birth|birth ?date|driver'?s licen[cs]e|passport|password/ },

    // Opt-ins. Marketing first: "I agree to receive marketing emails" is a
    // marketing box, not a consent box.
    { id: 'marketing-opt-out', kinds: CHOICE_KINDS, test: /newsletter|marketing|promotion(al|s)?\b|talent (community|network|pool|pipeline)|job alerts?|career (alerts?|news|updates|newsletter)|(future|other|new) (job )?(opportunities|openings|roles|positions|jobs)|subscribe|mailing list|product (updates|news)|special offers|keep me (informed|updated|posted)|stay (in touch|connected) (about|with) (other|future|our)/, act: marketing },
    { id: 'sms-opt-in', kinds: CHOICE_KINDS, test: /text messag|\bsms\b|\btexts\b|text me|by text|via text|mobile messag|whatsapp|(updates|communications?|messages|notifications) (about|regarding|on|related to) (my|this|your) (application|candidacy)/, act: (desc) => yes(desc, 'sms-opt-in') },
    { id: 'consent', kinds: CHOICE_KINDS, test: /\bi (hereby )?(certify|attest|acknowledge|confirm|agree|accept|consent|understand|have read|declare)\b|\b(certify|attest|acknowledge|consent|agree) (that|to)\b|privacy (policy|notice|statement)|terms (of (use|service)|and conditions)|data (processing|protection|privacy)|processing of (my )?(personal )?(data|information)|personal (data|information) (processing|use)|\bgdpr\b|\bccpa\b|background check consent|consent to (a )?background|information (provided|given|submitted) (is|are|in this application is) (true|accurate|complete|correct)|true(, | and )?(accurate|complete|correct)|accurate and complete|applicant (statement|certification|acknowledg)|candidate (privacy|consent)/, act: (desc) => yes(desc, 'consent') },

    // Demographics: only the neutral answer, only when required, only when
    // the profile is silent. Never a guess.
    { id: 'eeo-neutral', kinds: ['radio', 'select', 'combobox', 'checkbox'], test: /gender|\bsex\b|\brace\b|racial|ethnic|hispanic|latin[oax]|veteran|military (service|status)|disabilit|disabled|sexual orientation|transgender|lgbt|self-identif|voluntary self/, act: eeo },

    // Things a form asks that a profile has no field for.
    { id: 'skip-pronouns', never: true, test: /pronoun|preferred (first )?name|nickname/ },
    { id: 'hear-about', kinds: ANY_KINDS, test: /how did you (hear|learn|find out|find|come across|discover)|where did you (hear|find|learn|see|come across)|how (were you|was this) (referred|found)|referral source|source of (your )?(application|referral)|how did this (job|role|position) come/, act: hearAbout },
    { id: 'referred-by-employee', kinds: ANY_KINDS, test: /(were|was) you referred|referred (by|to (us|this|the) .*by)|employee referral|referred .*(employee|staff|someone who works)|know (anyone|someone) (who works|at|currently)/, act: (desc) => yesNoOnly(desc) ? no(desc, 'referred') : null },
    { id: 'related-to-employee', kinds: ANY_KINDS, test: /(related to|relative|relatives|family member|family members|relationship with|spouse|partner).*(employee|employed|works? (at|for)|working (at|for)|staff|board|director|officer)|(employee|staff).*(related to you|relative|family)/, act: (desc) => yesNoOnly(desc) ? no(desc, 'related-to-employee') : null },
    { id: 'employed-here', kinds: ANY_KINDS, test: /(previously|ever|formerly|before|in the past|prior|currently)\b.*\b(employed|worked|work(ed)? (for|at|with)|been an? (employee|contractor|intern|consultant)|been (employed|hired))|former (employee|intern|contractor)|(employed|worked) (by|for|at) .* (before|previously|in the past)/, act: employedHere },
    { id: 'non-compete', kinds: ANY_KINDS, test: /non-?compete|non-?solicit|restrictive covenant|bound by (any|an) (agreement|contract|covenant)|agreement that (would|could|may) (restrict|prevent|limit)/, act: (desc) => yesNoOnly(desc) ? no(desc, 'non-compete') : null },
    { id: 'age-18', kinds: ANY_KINDS, test: /\b(18|eighteen)\b.*\b(years|older|age|over)\b|\bat least (18|eighteen)\b|\bover (the age of )?(18|eighteen)\b|legal (working )?age|of legal age|minimum age/, act: (desc) => yesNoOnly(desc) ? yes(desc, 'age-18') : null },
    { id: 'essential-functions', kinds: ANY_KINDS, test: /essential (functions|duties|job functions)|perform the (essential|duties|job)|with or without (a )?(reasonable )?accommodation/, act: (desc) => yesNoOnly(desc) ? yes(desc, 'essential-functions') : null },
    { id: 'background-check', kinds: ANY_KINDS, test: /background (check|screen|investigation)|drug (test|screen)|reference check|employment verification|e-verify/, act: (desc) => yesNoOnly(desc) ? yes(desc, 'background-check') : null },
    { id: 'work-schedule', kinds: ANY_KINDS, test: /(comfortable|able|willing|okay|ok|open|agree|available)\b.*\b(on-?site|in[- ]office|in[- ]person|hybrid|the office|our office|an office|office (days|schedule|policy)|commut|work schedule|this schedule|days (a|per) week|work from (the|our) office|return to office|rto)\b/, act: (desc) => yesNoOnly(desc) ? yes(desc, 'work-schedule') : null }
  ];

  // --- rule actions --------------------------------------------------------------
  function result(value, why) {
    return value === null || value === undefined ? null : { value, why };
  }

  function yes(desc, why) { return result(answerYes(desc), why); }
  function no(desc, why) { return result(answerNo(desc), why); }

  // Yes/no-shaped field: a lone checkbox, options that read yes/no, or a short
  // text or option-less dropdown. A long textarea is an essay, not a yes/no.
  function yesNoOnly(desc) {
    if (desc.kind === 'textarea' || desc.kind === 'file') return false;
    if (isLoneCheckbox(desc)) return true;
    if (hasOptions(desc)) {
      const opts = options(desc);
      return !!(yesOption(opts) && noOption(opts));
    }
    // Free text: only a question that reads yes/no ("Have you...?"), not
    // "who referred you?".
    const label = lower(desc.label || desc.labelKey);
    return /^(are|am|do|does|did|have|has|had|were|was|will|would|can|could|is|should|if)\b/.test(label) && !/^if\b.*\b(who|what|which|name|please (list|provide|specify|describe))\b/.test(label) ||
      /\(?\byes ?\/ ?no\b\)?/.test(label);
  }

  function marketing(desc) {
    // A required marketing box blocks the form; ticking it is the only way on.
    if (desc.required) return yes(desc, 'marketing-required');
    return no(desc, 'marketing-opt-out');
  }

  function employedHere(desc, ctx) {
    if (!yesNoOnly(desc)) return null;
    const label = lower(desc.label || desc.labelKey);
    const company = lower(ctx.job && ctx.job.company);
    const here = /\b(us|here|this (company|organization|organisation|employer|firm)|our (company|organization|organisation|firm|team)|the company|its (subsidiaries|affiliates)|any of (its|our) (subsidiaries|affiliates|companies))\b/.test(label);
    const named = company.length >= 2 && label.indexOf(company) !== -1;
    // "Are you currently employed?" is about the applicant, not this employer.
    if (!here && !named) return null;
    return no(desc, 'employed-here');
  }

  function eeoValue(profile, label) {
    const eeo = profile && profile.eeo && typeof profile.eeo === 'object' ? profile.eeo : {};
    const pick = k => collapse(eeo[k]);
    if (/hispanic|latin[oax]/.test(label)) return pick('hispanicLatino');
    if (/\brace\b|racial|ethnic/.test(label)) return pick('race');
    if (/gender|\bsex\b/.test(label)) return pick('gender');
    if (/veteran|military/.test(label)) return pick('veteran');
    if (/disabilit|disabled/.test(label)) return pick('disability');
    return '';
  }

  function eeo(desc, ctx) {
    if (!desc.required) return null;
    const label = lower(desc.label || desc.labelKey);
    if (eeoValue(ctx.profile, label)) return null;
    const opts = options(desc);
    if (!opts.length) return null;
    return result(neutralOption(opts), 'eeo-neutral');
  }

  function hearAbout(desc, ctx) {
    const mine = collapse(ctx.profile && ctx.profile.howDidYouHear);
    if (!hasOptions(desc)) {
      if (desc.kind === 'checkbox') return null;
      return result(mine || 'Job board', 'hear-about');
    }
    const opts = options(desc);
    const tests = [];
    if (mine) {
      const m = lower(mine);
      tests.push(o => o === m, o => o.indexOf(m) !== -1 || m.indexOf(o) !== -1);
    }
    tests.push(/jobright/, /job ?boards?/, /job (sites?|search|websites?|postings?)/, /\bonline\b/, /^other\b/, /\bother\b/);
    return result(firstOption(opts, tests), 'hear-about');
  }

  // --- entry point -----------------------------------------------------------------
  function labelOf(desc) {
    return lower((desc && (desc.label || desc.labelKey)) || '');
  }

  // True for the questions no rule may answer for the applicant. The driver
  // uses it to keep its neutral fallback from picking "Other" on them.
  function isFactual(label) {
    const text = lower(label);
    return RULES.some(r => r.never && r.id !== 'skip-pronouns' && r.test.test(text));
  }

  function decide(desc, ctx) {
    if (!desc || typeof desc !== 'object') return null;
    const kind = String(desc.kind || '');
    if (!kind || kind === 'file' || kind === 'password') return null;
    const label = labelOf(desc);
    if (!label) return null;
    const c = Object.assign({ profile: {}, job: {} }, ctx || {});
    const d = Object.assign({}, desc, { kind, label, required: !!desc.required });
    for (const rule of RULES) {
      if (!rule.test.test(label)) continue;
      if (rule.never) return null;
      if (rule.kinds && !rule.kinds.includes(kind)) continue;
      let out = null;
      try { out = rule.act(d, c); } catch (e) { out = null; }
      return out && out.value !== null && out.value !== undefined ? out : null;
    }
    return null;
  }

  return {
    decide,
    isFactual,
    neutralOption: opts => neutralOption((opts || []).map(collapse).filter(Boolean)),
    RULES: RULES.map(r => Object.freeze({ id: r.id, never: !!r.never, kinds: r.kinds ? r.kinds.slice() : null, test: r.test }))
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LitDiscretion;
