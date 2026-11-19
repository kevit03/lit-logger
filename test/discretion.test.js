// Discretion rules (shared/discretion.js): consent and SMS boxes are ticked,
// marketing boxes left alone unless required, screening questions get the
// typical applicant's answer, demographics only ever get the neutral option
// (and only when required with nothing in the profile), and no factual
// question about the applicant (authorization, sponsorship, degree, GPA,
// dates, salary, location, criminal history) is ever decided.
const assert = require('assert');
const D = require('../shared/discretion.js');

const JOB = { title: 'Software Engineer', company: 'Acme' };
const YES_NO = ['Yes', 'No'];

function field(kind, label, extra) {
  return Object.assign({ kind, label, labelKey: label.toLowerCase(), options: [], required: false }, extra || {});
}

const box = (label, extra) => field('checkbox', label, extra);
const radio = (label, options, extra) => field('radio', label, Object.assign({ options: options || YES_NO }, extra));
const select = (label, options, extra) => field('select', label, Object.assign({ options }, extra));

function decide(desc, profile) {
  return D.decide(desc, { profile: profile || {}, job: JOB });
}

function expectValue(desc, want, msg, profile) {
  const out = decide(desc, profile);
  assert.ok(out, (msg || desc.label) + ': expected a decision, got null');
  assert.strictEqual(out.value, want, (msg || desc.label) + ': ' + JSON.stringify(out));
  assert.ok(typeof out.why === 'string' && out.why, 'why is set');
  return out;
}

function expectNull(desc, msg, profile) {
  const out = decide(desc, profile);
  assert.strictEqual(out, null, (msg || desc.label) + ': expected null, got ' + JSON.stringify(out));
}

async function run() {
  console.log('--- Running test/discretion.test.js ---');

  // The rule table is exposed, ordered, and every rule has an id and a regex.
  assert.ok(Array.isArray(D.RULES) && D.RULES.length >= 15);
  const ids = D.RULES.map(r => r.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'unique ids');
  D.RULES.forEach(r => assert.ok(r.test instanceof RegExp, r.id));
  const firstDecider = D.RULES.findIndex(r => !r.never);
  assert.ok(D.RULES.slice(0, firstDecider).every(r => r.never), 'factual guards come before any deciding rule');
  assert.ok(ids.indexOf('marketing-opt-out') < ids.indexOf('consent'), 'marketing before consent');
  assert.ok(ids.indexOf('sms-opt-in') < ids.indexOf('consent'));
  console.log('[PASS] rule table exposed and ordered');

  // Consent, certification, acknowledgement.
  [
    'I certify that the information provided is true',
    'I certify that the information provided in this application is true, accurate and complete.',
    'I acknowledge that I have read the Applicant Privacy Notice',
    'I agree to the Privacy Policy and Terms of Use',
    'I confirm the information is accurate',
    'I consent to the processing of my personal data for recruitment purposes',
    'By checking this box I consent to a background check',
    'I understand that false statements may result in disqualification',
    'GDPR consent: I agree that my data may be stored'
  ].forEach(l => expectValue(box(l), true, l));
  expectValue(radio('Do you consent to the processing of your personal data?'), 'Yes');
  expectValue(radio('Candidate privacy acknowledgement', ['I acknowledge', 'I do not acknowledge']), 'I acknowledge');
  expectValue(select('Applicant certification: I certify my answers are truthful', ['Select...', 'I agree', 'I disagree'].slice(1)), 'I agree');
  console.log('[PASS] consent / certification / acknowledgement -> yes');

  // SMS opt-ins about the application.
  expectValue(box('I would like to receive text messages about my application'), true);
  expectValue(box('Yes, text me updates about my application status (SMS). Message and data rates may apply.'), true);
  expectValue(radio('Can we send you SMS messages about your interview schedule?'), 'Yes');
  expectValue(box('Opt in to WhatsApp messages from our recruiting team'), true);
  console.log('[PASS] SMS opt-ins -> yes');

  // Marketing: unchecked unless required.
  const mk = expectValue(box('Sign me up for marketing emails and job alerts'), false);
  assert.ok(/marketing/.test(mk.why));
  expectValue(box('Subscribe to our newsletter'), false);
  expectValue(box('Join our Talent Community to hear about future opportunities'), false);
  expectValue(box('I agree to receive promotional emails and special offers'), false, 'marketing beats "I agree"');
  expectValue(box('Send me SMS marketing messages'), false, 'marketing beats SMS');
  expectValue(radio('Would you like to receive job alerts for similar roles?'), 'No');
  expectValue(box('Subscribe to our newsletter', { required: true }), true, 'a required newsletter box is checked');
  expectValue(radio('Join our talent network?', YES_NO, { required: true }), 'Yes');
  console.log('[PASS] marketing / talent community / job alerts -> no, required -> yes');

  // Screening defaults.
  expectValue(radio('Have you ever been employed by Acme?'), 'No');
  expectValue(box('Have you ever been employed by Acme?'), false, 'Ashby yes/no box answers No');
  expectValue(field('text', 'Have you previously worked for Acme or any of its subsidiaries?'), 'No');
  expectValue(radio('Have you worked at this company before?'), 'No');
  expectNull(radio('Are you currently employed?'), 'about the applicant, not this employer');
  expectNull(radio('Have you ever worked at a startup?'), 'not this employer');
  expectValue(radio('Are you related to anyone currently employed by Acme?'), 'No');
  expectValue(radio('Do you have any family members who work at Acme?'), 'No');
  expectValue(radio('Are you subject to a non-compete or non-solicitation agreement?'), 'No');
  expectValue(radio('Are you at least 18 years of age?'), 'Yes');
  expectValue(select('Are you 18 years or older?', ['Yes', 'No']), 'Yes');
  expectValue(radio('Are you able to perform the essential functions of this job with or without reasonable accommodation?'), 'Yes');
  expectValue(radio('Are you willing to undergo a background check and drug test?'), 'Yes');
  expectValue(radio('Are you comfortable working from our San Francisco office 3 days a week?'), 'Yes');
  expectValue(radio('This role is hybrid. Are you able to work on-site?', ['Yes, I can', 'No, I cannot']), 'Yes, I can');
  expectValue(radio('Were you referred by a current employee?'), 'No');
  expectNull(field('text', 'If you were referred by an employee, who referred you?'), 'a referrer name is not a yes/no');
  expectNull(field('textarea', 'Have you ever worked for Acme? Tell us about it.'), 'an essay is not a yes/no');
  console.log('[PASS] screening defaults');

  // How did you hear.
  expectValue(select('How did you hear about this job?', ['LinkedIn', 'Indeed', 'Job board', 'Referral', 'Other']), 'Job board');
  expectValue(select('How did you hear about us?', ['LinkedIn', 'Jobright.ai', 'Job board', 'Other']), 'Jobright.ai', 'Jobright first');
  expectValue(radio('Where did you hear about this position?', ['Company website', 'Online job site', 'Friend']), 'Online job site');
  expectValue(select('How did you hear about us?', ['LinkedIn', 'Glassdoor', 'Referral', 'Other (please specify)']), 'Other (please specify)');
  expectValue(select('How did you hear about us?', ['LinkedIn', 'Jobright', 'Other']), 'LinkedIn', 'profile answer wins', { howDidYouHear: 'LinkedIn' });
  expectValue(field('text', 'How did you hear about this role?'), 'Job board');
  expectValue(field('text', 'How did you hear about this role?'), 'Handshake', 'text uses the profile', { howDidYouHear: 'Handshake' });
  expectNull(select('How did you hear about us?', ['LinkedIn', 'Glassdoor']), 'no fitting option');
  expectValue(field('combobox', 'How did you hear about us?'), 'Job board', 'option-less dropdown gets the word');
  console.log('[PASS] how did you hear -> profile, Jobright, Job board, Online, Other');

  // Demographics: neutral only, required only, profile silent only.
  const gender = ['Male', 'Female', 'Non-binary', 'Decline to self-identify'];
  expectValue(select('Gender', gender, { required: true }), 'Decline to self-identify');
  expectNull(select('Gender', gender), 'optional EEO is left alone');
  expectNull(select('Gender', gender, { required: true }), 'profile value: not ours to decide', { eeo: { gender: 'Female' } });
  expectValue(radio('Are you Hispanic/Latino?', ['Yes', 'No', 'I prefer not to say'], { required: true }), 'I prefer not to say');
  expectValue(select('Race / Ethnicity', ['Asian', 'Black or African American', 'White', "I don't wish to answer"], { required: true }), "I don't wish to answer");
  expectValue(radio('Veteran status', ['I am a protected veteran', 'I am not a protected veteran', 'I do not wish to self-identify'], { required: true }), 'I do not wish to self-identify');
  expectNull(radio('Disability status', ['Yes, I have a disability', 'No, I do not have a disability'], { required: true }), 'no neutral option: never guess');
  expectNull(box('Do you identify as transgender?', { required: true }), 'a lone EEO box is never ticked');
  console.log('[PASS] EEO: only the neutral option, only when required and the profile is silent');

  // Facts about the applicant are never decided.
  [
    radio('Are you legally authorized to work in the US?'),
    radio('Are you legally authorized to work in the United States?', YES_NO, { required: true }),
    radio('Will you require sponsorship?'),
    radio('Will you now or in the future require visa sponsorship (e.g. H-1B)?'),
    box('I acknowledge that I am authorized to work in the country where this job is located', { required: true }),
    box('I certify that I will not require sponsorship', { required: true }),
    radio('Are you a U.S. citizen?'),
    radio('Do you hold an active security clearance?'),
    radio("Do you have a Bachelor's degree in Computer Science?"),
    select('Highest level of education', ['High school', 'Bachelor', 'Master', 'PhD']),
    field('text', 'What is your GPA?'),
    field('text', 'Expected graduation date'),
    field('text', 'When can you start?'),
    select('How many years of professional experience do you have?', ['0-1', '2-4', '5+']),
    field('text', 'What are your salary expectations?'),
    select('Desired compensation range', ['$100k-$120k', '$120k-$140k']),
    radio('Are you willing to relocate to New York?'),
    select('Which office location do you prefer?', ['New York', 'London', 'Remote']),
    select('Where are you currently located?', ['US', 'Canada', 'Other']),
    radio('Have you ever been convicted of a felony?'),
    field('text', 'Social Security Number'),
    field('text', 'Preferred name'),
    select('Pronouns', ['she/her', 'he/him', 'they/them', 'Prefer not to say'], { required: true })
  ].forEach(d => expectNull(d, d.label));
  assert.ok(D.isFactual('Will you require sponsorship?'));
  assert.ok(D.isFactual('Are you legally authorized to work in the US?'));
  assert.ok(!D.isFactual('How did you hear about us?'));
  console.log('[PASS] authorization, sponsorship, degree, GPA, dates, salary, location, criminal history -> null');

  // Odds and ends.
  expectNull(field('file', 'I certify my resume is accurate'), 'files are never decided');
  expectNull(field('textarea', 'Why do you want to work at Acme?'), 'open questions are for the composer');
  expectNull(field('text', 'LinkedIn Profile'));
  expectNull(box('Remember me'));
  expectNull(field('text', 'Type your full name to certify the above is true'), 'a signature is identity, not a checkbox');
  expectNull(null, 'null desc');
  expectNull({ kind: 'checkbox', label: '' }, 'no label');
  assert.strictEqual(D.decide(box('I agree to the terms'), undefined).value, true, 'ctx optional');
  assert.strictEqual(D.neutralOption(['Yes', 'No', 'Prefer not to answer']), 'Prefer not to answer');
  assert.strictEqual(D.neutralOption(['Yes', 'No']), null);
  console.log('[PASS] files, essays, identity text, and junk input are left alone');

  console.log('--- test/discretion.test.js COMPLETED SUCCESSFULLY ---');
}

if (require.main === module) {
  run().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { run };
