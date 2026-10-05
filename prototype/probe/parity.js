// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/probe/parity.js — INVESTIGATION CODE. Runs the golden checks and the engine fingerprint
// inside whatever browser opens /__probe/parity.html (served by ../probe-server.mjs next to a
// checkout of the repository). Result: window.__parity (read by run-suite.mjs over WebDriver) and,
// with ?report=1, a POST to /__report so a browser opened by hand or by `open -a Safari URL` can
// report back without any WebDriver.
import { computeScene } from '/demos/motion-planning/planner.js';
import { randomScenes } from '/tools/lib/motion-compare.mjs';
import { evaluate, DEFAULTS as TP_DEFAULTS } from '/demos/three-parametrizations/rotations.js';
import { orientations } from '/demos/euler-angles/model.js';
import { runAll } from '/__probe/fingerprint.js';
import { mathSample } from '/__probe/mathprobe.js';

const out = document.getElementById('out');
const log = (s) => { out.textContent += s + '\n'; };

async function main() {
  const getJson = async (u) => { const r = await fetch(u, { cache: 'no-store' }); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };
  const [named, goldMP, goldTP] = await Promise.all([
    getJson('/tools/data/motion-scenes.json'),
    getJson('/tests/golden/motion-planning.original-states.json'),
    getJson('/tests/golden/three-parametrizations.original-states.json'),
  ]);
  // The same 65 scenes as tools/compare-with-original.mjs: 5 saved states + 20 named + 40 random (seed 1).
  const saved = goldMP.states.map((s, i) => ({ id: `G${i}`, x: s.x, n: s.n, r1: s.r1, r2: s.r2, o1: s.o1, o2: s.o2, o3: s.o3, o4: s.o4 }));
  const scenes = [...saved, ...named.scenes, ...randomScenes(40, 1)];
  log(`scenes: ${scenes.length}`);
  const res = runAll({ computeScene, evaluate, orientations, TP_DEFAULTS }, { goldMP, goldTP, scenes });
  res.math = mathSample();
  res.userAgent = navigator.userAgent;
  res.when = new Date().toISOString();
  log(`golden: ${res.golden.passed}/${res.golden.total} passed${res.golden.failed.length ? ' — FAILED: ' + res.golden.failed.join('; ') : ''}`);
  log(`fingerprint: ${res.fingerprint.overall} (motion ${res.fingerprint.motion.hash}, rotations ${res.fingerprint.rotations.hash}, euler ${res.fingerprint.euler.hash})`);
  log(`time: ${res.timingMs.total} ms`);
  window.__parity = { done: true, ...res };
  if (new URLSearchParams(location.search).get('report') === '1') {
    const name = new URLSearchParams(location.search).get('name') || 'parity';
    const r = await fetch(`/__report?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(res) });
    log(`report POST: HTTP ${r.status}`);
  }
}
main().catch((e) => { log('ERROR ' + (e && e.stack || e)); window.__parity = { done: true, error: String(e && e.message || e) }; });
