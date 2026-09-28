// Manifest V3 schema, permissions, and file reference validation tests
const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function run() {
  console.log('--- Running test/manifest.test.js ---');

  const rootDir = path.resolve(__dirname, '..');
  const manifestPath = path.join(rootDir, 'manifest.json');

  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist');

  const raw = fs.readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    assert.fail(`manifest.json is not valid JSON: ${err.message}`);
  }

  // 1. Manifest V3 Schema Basics
  assert.strictEqual(manifest.manifest_version, 3, 'Must be Manifest V3');
  assert.ok(typeof manifest.name === 'string' && manifest.name.length > 0, 'Name must be non-empty string');
  assert.ok(typeof manifest.version === 'string' && manifest.version.length > 0, 'Version must be non-empty string');
  assert.ok(typeof manifest.description === 'string' && manifest.description.length > 0, 'Description must be non-empty string');

  // 2. Action Configuration
  assert.ok(manifest.action, 'Action must be configured');
  assert.ok(manifest.action.default_popup, 'default_popup must be configured');
  const popupHtmlPath = path.join(rootDir, manifest.action.default_popup);
  assert.ok(fs.existsSync(popupHtmlPath), `default_popup file must exist: ${manifest.action.default_popup}`);

  // 3. Permissions
  assert.ok(Array.isArray(manifest.permissions), 'Permissions must be an array');
  assert.ok(manifest.permissions.includes('storage'), 'Permissions must include "storage"');
  assert.ok(manifest.permissions.includes('identity'), 'Permissions must include "identity"');

  // 3b. Background service worker. The solve timers persist as deadlines and
  //     rely on this worker to mirror them into chrome.alarms, so a missing
  //     worker or permission silently breaks countdown notifications.
  assert.ok(manifest.background, 'background must be configured');
  assert.ok(manifest.background.service_worker, 'background.service_worker must be configured');
  const swPath = path.join(rootDir, manifest.background.service_worker);
  assert.ok(fs.existsSync(swPath), `service worker file must exist: ${manifest.background.service_worker}`);
  assert.ok(manifest.permissions.includes('alarms'), 'Permissions must include "alarms" for background countdowns');
  assert.ok(manifest.permissions.includes('notifications'), 'Permissions must include "notifications" to announce a finished countdown');

  // 4. Content Scripts
  assert.ok(Array.isArray(manifest.content_scripts), 'content_scripts must be an array');
  assert.ok(manifest.content_scripts.length > 0, 'content_scripts must have at least one entry');

  const cs = manifest.content_scripts[0];
  assert.ok(Array.isArray(cs.matches), 'content_scripts.matches must be an array');
  assert.ok(cs.matches.some(m => m.includes('calendar.google.com')), 'content_scripts must match Google Calendar');

  assert.ok(Array.isArray(cs.js), 'content_scripts.js must be an array');
  cs.js.forEach(scriptRelPath => {
    const scriptFullPath = path.join(rootDir, scriptRelPath);
    assert.ok(fs.existsSync(scriptFullPath), `Content script file must exist: ${scriptRelPath}`);
  });

  if (Array.isArray(cs.css)) {
    cs.css.forEach(cssRelPath => {
      const cssFullPath = path.join(rootDir, cssRelPath);
      assert.ok(fs.existsSync(cssFullPath), `Content CSS file must exist: ${cssRelPath}`);
    });
  }

  // 4b. Auto-tracker content scripts. Every entry's files must exist, load
  //     order must put the core before its adapters and the adapters before
  //     the entry point, and each supported platform must be matched.
  manifest.content_scripts.forEach((entry, idx) => {
    assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0, `content_scripts[${idx}].matches must be non-empty`);
    (entry.js || []).forEach(rel => {
      assert.ok(fs.existsSync(path.join(rootDir, rel)), `content_scripts[${idx}] script must exist: ${rel}`);
    });
    (entry.css || []).forEach(rel => {
      assert.ok(fs.existsSync(path.join(rootDir, rel)), `content_scripts[${idx}] css must exist: ${rel}`);
    });
    if ((entry.js || []).includes('content/auto-tracker.js')) {
      const js = entry.js;
      const coreIdx = js.indexOf('shared/auto-tracker-core.js');
      const storageIdx = js.indexOf('shared/storage.js');
      const entryIdx = js.indexOf('content/auto-tracker.js');
      assert.ok(coreIdx >= 0 && storageIdx >= 0, `content_scripts[${idx}] must load storage and the auto-tracker core`);
      assert.ok(coreIdx < entryIdx, `content_scripts[${idx}] core must load before the entry point`);
      const adapterIdxs = js.map((f, i) => (f.startsWith('content/adapters/') ? i : -1)).filter(i => i >= 0);
      assert.ok(adapterIdxs.length > 0, `content_scripts[${idx}] must load at least one adapter`);
      adapterIdxs.forEach(i => {
        assert.ok(i > coreIdx && i < entryIdx, `content_scripts[${idx}] adapter ${js[i]} must load after the core and before the entry point`);
      });
      const atsIdx = js.indexOf('content/adapters/ats/confirmation.js');
      if (atsIdx >= 0) {
        adapterIdxs.filter(i => js[i].startsWith('content/adapters/ats/') && i !== atsIdx)
          .forEach(i => assert.ok(i > atsIdx, `ATS adapter ${js[i]} must load after ats/confirmation.js`));
      }
    }
  });

  const allMatches = manifest.content_scripts.flatMap(cs => cs.matches);
  [
    'https://leetcode.com/problems/*',
    'https://neetcode.io/*',
    'https://boards.greenhouse.io/*',
    'https://job-boards.greenhouse.io/*',
    'https://jobs.lever.co/*',
    'https://jobs.ashbyhq.com/*',
    'https://*.myworkdayjobs.com/*'
  ].forEach(pattern => {
    assert.ok(allMatches.includes(pattern), `content_scripts must match ${pattern}`);
  });
  assert.ok(!allMatches.includes('<all_urls>'), 'auto-tracker must not request <all_urls>');
  assert.ok(!allMatches.some(m => /^https?:\/\/\*\/\*$/.test(m)), 'auto-tracker must not request all hosts');

  // 5. Host Permissions
  assert.ok(Array.isArray(manifest.host_permissions), 'host_permissions must be an array');
  assert.ok(manifest.host_permissions.some(h => h.includes('calendar.google.com')), 'host_permissions must include Google Calendar');
  assert.ok(manifest.host_permissions.some(h => h.includes('googleapis.com')), 'host_permissions must include Google APIs');
  [
    'https://trackapi.nutritionix.com/*',
    'https://api.nal.usda.gov/*',
    'https://generativelanguage.googleapis.com/*'
  ].forEach(pattern => {
    assert.ok(!manifest.host_permissions.includes(pattern), `host_permissions must not include ${pattern}`);
  });

  // 6. Icons
  if (manifest.icons) {
    Object.entries(manifest.icons).forEach(([size, iconRelPath]) => {
      const iconFullPath = path.join(rootDir, iconRelPath);
      assert.ok(fs.existsSync(iconFullPath), `Icon size ${size} file must exist: ${iconRelPath}`);
    });
  }

  console.log('[PASS] Manifest V3 schema, permissions, and file references verified.');
  console.log('--- test/manifest.test.js COMPLETED SUCCESSFULLY ---\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}

module.exports = { run };
