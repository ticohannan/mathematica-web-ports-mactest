#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/run-suite.mjs — INVESTIGATION CODE (see README.md). Zero dependencies (Node 18+).
//
// A small cross-browser smoke + parity suite driven over W3C WebDriver, so it works with Safari
// (safaridriver), which Playwright cannot drive. It runs on the HOST; the browser can be in a VM,
// on a GitHub-hosted macOS runner, or local. Pages come from probe-server.mjs.
//
//   node run-suite.mjs --browser safari --webdriver http://127.0.0.1:4444 \
//        --site http://127.0.0.1:8090 [--reference results/reference-node.json] [--out DIR] [--label TEXT]
//
// --site is the server address AS SEEN BY THE BROWSER (through the SSH reverse tunnel of the VM
// set-ups it is http://127.0.0.1:8090 inside the guest too).
// Exit code 0 = every check that is expected to work passed; 1 = something failed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebDriver } from './lib/webdriver.mjs';
import { diffFingerprints } from './probe/fingerprint.js';
import { diffMath } from './probe/mathprobe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const browser = opt('browser', 'safari');
const wdUrl = opt('webdriver', 'http://127.0.0.1:4444');
const site = opt('site', 'http://127.0.0.1:8090').replace(/\/$/, '');
const outDir = path.resolve(opt('out', path.join(here, 'results', `${browser}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`)));
const label = opt('label', '');
const refFile = opt('reference', null);

const PRESETS = {
  safari: { browserName: 'safari' },
  webkitgtk: {
    browserName: 'MiniBrowser',
    'webkitgtk:browserOptions': {
      binary: process.env.MINIBROWSER || '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser',
      args: ['--automation'],
    },
  },
  // Flags against renderer throttling/hangs in CI desktop sessions (macos-26-intel, 2026-10-05).
  chrome: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--no-first-run', '--no-default-browser-check', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling'] } },
  'chrome-headless': { browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new', '--no-first-run', '--window-size=1100,900'] } },
  firefox: { browserName: 'firefox' },
};
const caps = opt('caps', null) ? JSON.parse(opt('caps')) : PRESETS[browser];
if (!caps) { console.error(`unknown --browser ${browser}; use ${Object.keys(PRESETS).join('|')} or --caps JSON`); process.exit(2); }

fs.mkdirSync(outDir, { recursive: true });
const results = [];
const t00 = Date.now();
const record = (r) => { results.push(r); console.log(`${r.status.padEnd(13)} ${r.id}  ${r.note || ''}`); };
const shot = async (wd, name) => {
  try { fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(await wd.screenshot(), 'base64')); return `${name}.png`; } catch (e) { return `screenshot failed: ${e.message}`; }
};
const probeState = (wd) => wd.execute('var P = window.__probe; return P ? { errors: P.errors, rejections: P.rejections, consoleErrors: P.consoleErrors, webgl: P.webgl(), ua: P.ua } : null;');
const problemsOf = (p) => (p ? [...p.errors, ...p.rejections, ...p.consoleErrors] : ['probe script missing (page not served by probe-server?)']);

const DEMOS = [
  { id: 'motion-planning', needsWebGL: false },
  { id: 'three-parametrizations', needsWebGL: true },
  { id: 'euler-angles', needsWebGL: true },
];

let wd;
let dead = false; // set when the driver stops answering; remaining checks are skipped, not hung
async function guard(id, fn) {
  if (dead) { record({ id, status: 'skip', note: 'skipped: browser/driver stopped answering earlier' }); return; }
  const t = Date.now();
  try { await fn(); } catch (e) {
    record({ id, status: 'fail', ms: Date.now() - t, note: `aborted: ${e.message}` });
    if (e.transport) dead = true;
    else await wd.navigate('about:blank').catch(() => { dead = true; });
  }
}
async function newSessionWithRetry(attempts = 3) {
  // safaridriver on a freshly booted CI Mac can time out "finding or launching a compatible local
  // Safari" on the first try (macos-26-intel, 2026-10-05); retrying is the usual remedy.
  for (let i = 1; ; i++) {
    try { return await WebDriver.newSession(wdUrl, caps); } catch (e) {
      console.log(`session attempt ${i}/${attempts} failed: ${e.message.slice(0, 200)}`);
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}
try {
  const t0 = Date.now();
  wd = await newSessionWithRetry();
  const caps2 = wd.capabilities || {};
  record({ id: 'session', status: 'pass', ms: Date.now() - t0, note: `${caps2.browserName || '?'} ${caps2.browserVersion || ''} on ${caps2.platformName || '?'}` });
  await wd.setTimeouts({ script: 180000, pageLoad: 60000 }).catch(() => {});
  await wd.setWindowRect({ width: 1100, height: 900 }).catch(() => {});

  // 1. Landing page
  await guard('index', async () => {
    const t = Date.now();
    await wd.navigate(`${site}/index.html`);
    await wd.waitFor("document.readyState === 'complete'", 15000);
    const links = await wd.execute("return Array.from(document.querySelectorAll('a[href*=\"demos/\"]')).length;");
    const p = await probeState(wd);
    const problems = problemsOf(p);
    record({ id: 'index', status: links >= 3 && !problems.length ? 'pass' : 'fail', ms: Date.now() - t, note: `${links} demo links${problems.length ? '; ' + problems.join(' | ') : ''}`, ua: p && p.ua, webgl: p && p.webgl });
  });

  // 2. Each demo page: loads, becomes ready, no uncaught errors; WebGL facts recorded
  const ready = {};
  for (const d of DEMOS) await guard(`load:${d.id}`, async () => {
    const t = Date.now();
    await wd.navigate(`${site}/demos/${d.id}/`);
    // Stop waiting as soon as the page is ready OR has thrown (e.g. no WebGL), so a failing page
    // costs ~2 s instead of the full 20 s timeout.
    const w = await wd.waitFor('(window.__demo && window.__demo.ready === true) || (window.__probe && window.__probe.errors.length + window.__probe.rejections.length > 0 && Date.now() - window.__probe.t0 > 1500)', 20000);
    const isReady = await wd.execute('return !!(window.__demo && window.__demo.ready === true);').catch(() => false);
    const p = await probeState(wd);
    const problems = problemsOf(p);
    const gl = p && p.webgl;
    ready[d.id] = isReady;
    let status = isReady && !problems.length ? 'pass' : 'fail';
    let note = `${isReady ? `ready after ${w.ms} ms` : `NOT ready (gave up after ${w.ms} ms)`}; WebGL ${gl && gl.webgl ? `yes (${gl.renderer || '?'})` : 'NO'}`;
    if (status === 'fail' && d.needsWebGL && gl && !gl.webgl) { status = 'expected-fail'; note += ' — page needs WebGL, browser has none (see MACVM-OVR, OVR-F04)'; }
    if (problems.length) note += `; errors: ${problems.join(' | ').slice(0, 400)}`;
    record({ id: `load:${d.id}`, status, ms: Date.now() - t, note, webgl: gl, shot: await shot(wd, `load-${d.id}`) });
  });

  // 3. Motion planning interactions (real input events, not __demo.setState)
  if (ready['motion-planning']) await guard('mp:interactions', async () => {
    await wd.navigate(`${site}/demos/motion-planning/`);
    await wd.waitFor('window.__demo && window.__demo.ready === true', 20000);
    // 3a mouse drag of the goal locator r2 (pointer events + setPointerCapture on SVG <g>)
    {
      const t = Date.now();
      const before = await wd.execute('return window.__demo.getState().r2;');
      const pt = await wd.execute("return window.__demo.locatorClientPoint('r2');");
      let status = 'fail'; let note = '';
      try {
        await wd.drag(pt.x, pt.y, 40, -30);
        const after = await wd.execute('return window.__demo.getState().r2;');
        const moved = after[0] > before[0] && after[1] > before[1]; // right on screen = +x; up on screen = +y (y-flip)
        status = moved ? 'pass' : 'fail';
        note = `r2 ${JSON.stringify(before)} -> ${JSON.stringify(after)} (expect x up, y up)`;
      } catch (e) { note = e.message; }
      record({ id: 'mp:drag-locator', status, ms: Date.now() - t, note, shot: await shot(wd, 'mp-after-drag') });
    }
    // 3b keyboard: focused locator + ArrowRight (port addition A-MP: arrow-key movement)
    {
      const t = Date.now();
      let status = 'fail'; let note = '';
      try {
        const before = await wd.execute('return window.__demo.getState().o1;');
        await wd.execute("document.querySelector('[data-testid=\"locator-o1\"]').focus();");
        await wd.key('');
        const after = await wd.execute('return window.__demo.getState().o1;');
        status = after[0] > before[0] && after[1] === before[1] ? 'pass' : 'fail';
        note = `o1 ${JSON.stringify(before)} -> ${JSON.stringify(after)}`;
      } catch (e) { note = e.message; }
      record({ id: 'mp:arrow-key', status, ms: Date.now() - t, note });
    }
    // 3c setter bar click: boundary sides 5
    {
      const t = Date.now();
      let status = 'fail'; let note = '';
      try {
        await wd.clickCss('[data-testid="setter-x-5"]');
        const r = await wd.execute("return { x: window.__demo.getState().x, sides: window.__demo.scene().borderpoly.length, pressed: document.querySelector('[data-testid=\"setter-x-5\"]').getAttribute('aria-pressed') };");
        status = r.x === 5 && r.sides === 5 && r.pressed === 'true' ? 'pass' : 'fail';
        note = JSON.stringify(r);
      } catch (e) { note = e.message; }
      record({ id: 'mp:setter-click', status, ms: Date.now() - t, note, shot: await shot(wd, 'mp-after-setter') });
    }
    // 3d SVG geometry: the drawn locator circle centre maps back to the state (getScreenCTM path)
    {
      const t = Date.now();
      let status = 'fail'; let note = '';
      try {
        const r = await wd.execute("var s = window.__demo.getState(); var a = window.__demo.locatorClientPoint('o2'); var b = window.__demo.worldToClient(s.o2); return { a: a, b: b };");
        const dx = Math.abs(r.a.x - r.b.x); const dy = Math.abs(r.a.y - r.b.y);
        status = dx < 1.5 && dy < 1.5 ? 'pass' : 'fail';
        note = `circle centre vs getScreenCTM mapping differ by (${dx.toFixed(2)}, ${dy.toFixed(2)}) px`;
      } catch (e) { note = e.message; }
      record({ id: 'mp:svg-geometry', status, ms: Date.now() - t, note });
    }
  }); else {
    record({ id: 'mp:interactions', status: 'skip', note: 'motion-planning page did not become ready' });
  }

  // 4. In-browser golden checks + engine fingerprint (pure model code, CPU only)
  await guard('parity', async () => {
    const t = Date.now();
    await wd.navigate(`${site}/__probe/parity.html`);
    const w = await wd.waitFor('window.__parity && window.__parity.done', 180000, 250);
    const par = w.value ? await wd.execute('return window.__parity;') : null;
    fs.writeFileSync(path.join(outDir, 'parity.json'), JSON.stringify(par, null, 1));
    if (!par || par.error) {
      record({ id: 'parity:golden', status: 'fail', ms: Date.now() - t, note: par ? par.error : 'parity page did not finish' });
    } else {
      record({ id: 'parity:golden', status: par.golden.failed.length ? 'fail' : 'pass', ms: par.timingMs.total, note: `${par.golden.passed}/${par.golden.total} golden checks${par.golden.failed.length ? '; FAILED: ' + par.golden.failed.join('; ') : ''}` });
      if (refFile) {
        const ref = JSON.parse(fs.readFileSync(path.resolve(refFile), 'utf8'));
        const d = diffFingerprints(ref, par);
        fs.writeFileSync(path.join(outDir, 'fingerprint-diff.json'), JSON.stringify(d, null, 1));
        if (ref.math && par.math) {
          const m = diffMath(ref.math, par.math);
          fs.writeFileSync(path.join(outDir, 'math-diff.json'), JSON.stringify(m, null, 1));
          const differing = Object.entries(m).filter(([, v]) => v.differing);
          record({ id: 'math:libm-vs-reference', status: differing.length ? 'differs' : 'pass',
            note: differing.length ? differing.map(([k, v]) => `${k} ${v.differing}/${v.of} (max ${v.maxUlp} ulp)`).join(', ') : 'all 13 Math functions bit-identical on 1,000 inputs each' });
        }
        record({
          id: 'parity:fingerprint-vs-reference',
          status: d.identical ? 'pass' : 'differs',
          note: d.identical ? `identical to reference (${ref.userAgent})`
            : `differs from reference (${ref.userAgent}): motion scenes ${d.motionScenesDiffering.length}/65 [${d.motionScenesDiffering.slice(0, 8).map((m) => `${m.id}:${m.fields.join('+')}`).join(', ')}${d.motionScenesDiffering.length > 8 ? ', ...' : ''}], rotation rows ${d.rotationsRowsDiffering}/${ref.fingerprint.rotations.n}, euler ${d.eulerDiffers ? 'differs' : 'same'}`,
        });
      } else {
        record({ id: 'parity:fingerprint', status: 'info', note: par.fingerprint.overall });
      }
    }
  });
} catch (e) {
  record({ id: 'harness', status: 'fail', note: e.stack || e.message });
} finally {
  if (wd) await wd.quit().catch(() => {});
}

const counts = results.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
const report = { label, browser, webdriver: wdUrl, site, when: new Date().toISOString(), totalMs: Date.now() - t00, counts, results };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
const md = [
  `# Browser run: ${browser}${label ? ` — ${label}` : ''}`,
  '',
  `When: ${report.when} · total ${(report.totalMs / 1000).toFixed(1)} s · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  '',
  '| Check | Status | ms | Note |',
  '|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.status} | ${r.ms ?? ''} | ${String(r.note || '').replace(/\|/g, '/').replace(/\n/g, ' ')} |`),
  '',
];
fs.writeFileSync(path.join(outDir, 'summary.md'), md.join('\n'));
console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ')}  -> ${outDir}`);
process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
