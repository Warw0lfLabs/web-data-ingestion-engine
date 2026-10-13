#!/usr/bin/env bash
set -euo pipefail
mkdir -p test-logs
node scripts/ci-sandbox.mjs 2>&1 | tee test-logs/sandbox-tests.log
npm run test:integration -- --reporter=default --reporter=json --outputFile=test-logs/integration-results.json 2>&1 | tee test-logs/integration-tests.log
npm run test:browser -- --reporter=default --reporter=json --outputFile=test-logs/browser-results.json 2>&1 | tee test-logs/browser-tests.log
node --input-type=module <<'JS'
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
for(const [name, count] of [['integration',22],['browser',10]]) {
  const report=JSON.parse(readFileSync(`test-logs/${name}-results.json`));
  assert.equal(report.numTotalTests,count);
  assert.equal(report.numPassedTests,count);
  assert.equal(report.numFailedTests,0);
  assert.equal(report.numPendingTests,0);
  assert.equal(report.numTodoTests,0);
  assert.equal(report.success,true);
}
JS
