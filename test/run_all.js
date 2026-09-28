#!/usr/bin/env node
// Unified test runner for Job & Activity Tracker test suite
// Zero-emoji compliant test runner

const path = require('path');

const SUITES = [
  { name: 'Storage CRUD & Math Suite', file: './storage.test.js' },
  { name: 'Metrics & Tracker Suite', file: './metrics.test.js' },
  { name: 'Authentication & Session Suite', file: './auth.test.js' },
  { name: 'Multi-User Isolation Suite', file: './isolation.test.js' },
  { name: 'Event & Real-Time Sync Suite', file: './events.test.js' },
  { name: 'Cross-Context Concurrency Suite', file: './concurrency.test.js' },
  { name: 'Date Decoding & Popup Timer Guard Suite', file: './timer.test.js' },
  { name: 'Auto-Tracker Adapter & Dedupe Suite', file: './autotracker.test.js' },
  { name: 'Popup Widget Layout Suite', file: './widgets.test.js' },
  { name: 'Calendar Overlay Suite', file: './calendar.test.js' },
  { name: 'Zero-Emoji Compliance Suite', file: './emoji.test.js' },
  { name: 'Manifest V3 Validation Suite', file: './manifest.test.js' }
];

async function main() {
  const startTime = Date.now();
  console.log('===============================================================');
  console.log('JOB & ACTIVITY TRACKER — AUTOMATED VERIFICATION SUITE');
  console.log('===============================================================\n');

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const suite of SUITES) {
    const suiteStart = Date.now();
    try {
      const suiteModule = require(suite.file);
      if (typeof suiteModule.run === 'function') {
        await suiteModule.run();
      }
      const duration = Date.now() - suiteStart;
      console.log(`[SUITE PASS] ${suite.name} (${duration}ms)\n`);
      passed++;
    } catch (err) {
      const duration = Date.now() - suiteStart;
      console.error(`[SUITE FAIL] ${suite.name} (${duration}ms)`);
      console.error(err.stack || err.message);
      console.error('\n');
      failed++;
      failures.push({ name: suite.name, error: err });
    }
  }

  const totalDuration = Date.now() - startTime;
  console.log('===============================================================');
  console.log('TEST EXECUTION SUMMARY');
  console.log('===============================================================');
  console.log(`Total Suites:  ${SUITES.length}`);
  console.log(`Passed Suites: ${passed}`);
  console.log(`Failed Suites: ${failed}`);
  console.log(`Total Time:    ${totalDuration}ms`);
  console.log('===============================================================');

  if (failed > 0) {
    console.error('\nFAILURES DETECTED:');
    failures.forEach(f => {
      console.error(` - ${f.name}: ${f.error.message}`);
    });
    process.exit(1);
  } else {
    console.log('\nALL VERIFICATION SUITES PASSED CLEANLY (EXIT 0)');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal error running test runner:', err);
  process.exit(1);
});
