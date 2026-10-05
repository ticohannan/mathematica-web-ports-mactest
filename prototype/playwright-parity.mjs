#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/playwright-parity.mjs — INVESTIGATION CODE. Opens /__probe/parity.html (from
// probe-server.mjs) in Playwright's Chromium / Firefox / WebKit and compares the golden checks, the
// engine fingerprint and the Math sample with the Node reference. Uses the @playwright/test that
// is already installed in the repository checkout (--repo), so nothing new is installed.
//
//   node playwright-parity.mjs --repo PATH_TO_CHECKOUT --site http://127.0.0.1:8090 \
//        --reference results/reference-node.json [--browsers chromium,firefox,webkit] [--out DIR]
// Env PW_CHROMIUM_PATH: optional Chromium binary (as in the repo's playwright.config.js).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { diffFingerprints } from './probe/fingerprint.js';
import { diffMath } from './probe/mathprobe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const repo = path.resolve(opt('repo', '.'));
const site = opt('site', 'http://127.0.0.1:8090').replace(/\/$/, '');
const ref = JSON.parse(fs.readFileSync(path.resolve(opt('reference', path.join(here, 'results', 'reference-node.json'))), 'utf8'));
const which = opt('browsers', 'chromium,firefox,webkit').split(',');
const outDir = path.resolve(opt('out', path.join(here, 'results', 'playwright-parity')));
const pw = createRequire(path.join(repo, 'package.json'))('@playwright/test');

fs.mkdirSync(outDir, { recursive: true });
const summary = [];
for (const name of which) {
  const launchOpts = name === 'chromium' && process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {};
  let browser;
  try {
    browser = await pw[name].launch(launchOpts);
    const page = await browser.newPage();
    await page.goto(`${site}/__probe/parity.html`);
    await page.waitForFunction(() => window.__parity && window.__parity.done, null, { timeout: 180000 });
    const par = await page.evaluate(() => window.__parity);
    if (par.error) throw new Error(par.error);
    const fp = diffFingerprints(ref, par);
    const m = diffMath(ref.math, par.math);
    const mathDiff = Object.entries(m).filter(([, v]) => v.differing).map(([k, v]) => `${k} ${v.differing}/${v.of} (max ${v.maxUlp} ulp)`);
    const line = `${name} ${browser.version()}: golden ${par.golden.passed}/${par.golden.total}; fingerprint ${fp.identical ? 'IDENTICAL' : `differs (motion scenes ${fp.motionScenesDiffering.length}/65, rotation rows ${fp.rotationsRowsDiffering}/${ref.fingerprint.rotations.n}, euler ${fp.eulerDiffers ? 'differs' : 'same'})`}; Math: ${mathDiff.length ? mathDiff.join(', ') : 'bit-identical'}; ${par.timingMs.total} ms`;
    console.log(line);
    summary.push(line);
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify({ browserVersion: browser.version(), userAgent: par.userAgent, golden: par.golden, fingerprintDiff: fp, mathDiff: m, timingMs: par.timingMs }, null, 1));
  } catch (e) {
    const line = `${name}: NOT RUN (${e.message.split('\n')[0]})`;
    console.log(line);
    summary.push(line);
  } finally {
    if (browser) await browser.close();
  }
}
fs.writeFileSync(path.join(outDir, 'summary.txt'), `reference: ${ref.userAgent}\n${summary.join('\n')}\n`);
