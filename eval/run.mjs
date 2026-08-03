#!/usr/bin/env node
/**
 * CADI Assist — offline retrieval evaluation.
 *
 * Runs the real ranking code from shared/scoring.mjs against the real index.
 * No API key, no network, no model call, no cost. Finishes in under a second.
 *
 *   node eval/run.mjs                 # run and print a report
 *   node eval/run.mjs --verbose       # show the top 3 for every case
 *   node eval/run.mjs --save-baseline # record the current score as the baseline
 *
 * Exits non-zero if the score is below the committed baseline, so CI can block
 * a change that makes search worse.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildRetrieval } from '../shared/scoring.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const verbose = process.argv.includes('--verbose');
const saveBaseline = process.argv.includes('--save-baseline');

const index = JSON.parse(readFileSync(join(root, 'search-index.json'), 'utf8')).pages;
const glossary = JSON.parse(readFileSync(join(root, 'config/glossary.json'), 'utf8')).entries;
const boostConfig = JSON.parse(readFileSync(join(root, 'config/boosts.json'), 'utf8'));
const { cases } = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

const baselinePath = join(here, 'baseline.json');

const short = (url) => url.replace('https://cadi.port.ac.uk', '') || '/';

function check(testCase, result) {
  const matched = result.matchedPages;
  const top = matched[0];
  const checks = [];

  if (testCase.expect_gap) {
    checks.push({
      pass: result.isGap,
      detail: result.isGap
        ? 'found nothing, as expected'
        : `expected nothing, got ${top ? short(top.url) : '(empty)'} at ${result.maxScore}`,
    });
  }
  if (testCase.expect_weak) {
    const ok = result.isGap || result.isWeak;
    checks.push({
      pass: ok,
      detail: ok
        ? `low confidence (score ${result.maxScore})`
        : `expected low confidence, got ${result.maxScore} on ${short(top.url)}`,
    });
  }
  if (testCase.expect_url_contains) {
    const ok = matched.length && top.url.includes(testCase.expect_url_contains);
    checks.push({
      pass: ok,
      detail: ok ? `top = ${short(top.url)}` : `top = ${matched.length ? short(top.url) : 'nothing'}, wanted ${testCase.expect_url_contains}`,
    });
  }
  if (testCase.expect_in_top_3) {
    const three = matched.slice(0, 3);
    const needle = testCase.expect_in_top_3.toLowerCase();
    const hit = three.find((p) => p.url.toLowerCase().includes(needle));
    checks.push({
      pass: Boolean(hit),
      detail: hit ? `top 3 includes ${short(hit.url)}` : `top 3 = ${three.map((p) => short(p.url)).join(', ') || 'nothing'}`,
    });
  }
  if (!checks.length) return { pass: false, detail: 'case has no assertion' };

  const failed = checks.filter((c) => !c.pass);
  return {
    pass: failed.length === 0,
    detail: (failed.length ? failed : checks).map((c) => c.detail).join('; '),
  };
}

const results = [];
for (const testCase of cases) {
  const retrieval = buildRetrieval(index, testCase.query, [], { glossary, boostConfig });
  const { pass, detail } = check(testCase, retrieval);
  results.push({ testCase, retrieval, pass, detail });
}

// ── Report ───────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const total = results.length;

console.log(`\nCADI Assist — retrieval evaluation`);
console.log(`Index: ${index.length} pages   Cases: ${total}\n`);

const byCategory = new Map();
for (const r of results) {
  const cat = r.testCase.category || 'uncategorised';
  if (!byCategory.has(cat)) byCategory.set(cat, []);
  byCategory.get(cat).push(r);
}

for (const [cat, rows] of [...byCategory.entries()].sort()) {
  const ok = rows.filter((r) => r.pass).length;
  const flag = ok === rows.length ? 'ok  ' : 'FAIL';
  console.log(`  ${flag} ${cat.padEnd(20)} ${ok}/${rows.length}`);
}

const failures = results.filter((r) => !r.pass);
if (failures.length) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  "${f.testCase.query}"`);
    console.log(`      ${f.detail}`);
  }
}

if (verbose) {
  console.log(`\nAll cases:`);
  for (const r of results) {
    console.log(`\n  ${r.pass ? 'PASS' : 'FAIL'}  "${r.testCase.query}"  (score ${r.retrieval.maxScore})`);
    if (r.retrieval.expandedQuery !== r.testCase.query) {
      console.log(`        expanded: ${r.retrieval.expandedQuery}`);
    }
    r.retrieval.matchedPages.slice(0, 3).forEach((p, i) => {
      console.log(`        ${i + 1}. ${short(p.url)}  (${r.retrieval.scores.get(p.url)})`);
    });
  }
}

console.log(`\nScore: ${passed}/${total}\n`);

// ── Baseline gate ────────────────────────────────────────────────────────────

if (saveBaseline) {
  writeFileSync(baselinePath, JSON.stringify({ passed, total, savedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`Baseline saved: ${passed}/${total}\n`);
  process.exit(0);
}

if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (passed < baseline.passed) {
    console.error(`REGRESSION: baseline was ${baseline.passed}/${baseline.total}, now ${passed}/${total}.`);
    console.error(`If this change is intentional, re-run with --save-baseline.\n`);
    process.exit(1);
  }
  console.log(`Baseline ${baseline.passed}/${baseline.total} held.\n`);
}

process.exit(failures.length ? 1 : 0);
