#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/node-reference.mjs — INVESTIGATION CODE. Computes the golden checks and the engine
// fingerprint in Node (V8) for a checkout of the repository, as the reference that browser runs
// (run-suite.mjs --reference FILE) are compared with.
// Usage: node node-reference.mjs --repo PATH_TO_CHECKOUT [--out FILE]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runAll } from './probe/fingerprint.js';
import { mathSample } from './probe/mathprobe.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const repo = path.resolve(opt('repo', '.'));
const out = path.resolve(opt('out', path.join(here, 'results', 'reference-node.json')));
const imp = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const json = (rel) => JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));

const { computeScene } = await imp('demos/motion-planning/planner.js');
const { randomScenes } = await imp('tools/lib/motion-compare.mjs');
const { evaluate, DEFAULTS: TP_DEFAULTS } = await imp('demos/three-parametrizations/rotations.js');
const { orientations } = await imp('demos/euler-angles/model.js');
const goldMP = json('tests/golden/motion-planning.original-states.json');
const goldTP = json('tests/golden/three-parametrizations.original-states.json');
const named = json('tools/data/motion-scenes.json');
const saved = goldMP.states.map((s, i) => ({ id: `G${i}`, x: s.x, n: s.n, r1: s.r1, r2: s.r2, o1: s.o1, o2: s.o2, o3: s.o3, o4: s.o4 }));
const scenes = [...saved, ...named.scenes, ...randomScenes(40, 1)];

const res = runAll({ computeScene, evaluate, orientations, TP_DEFAULTS }, { goldMP, goldTP, scenes });
res.math = mathSample();
res.userAgent = `Node ${process.version} (V8 ${process.versions.v8}) on ${process.platform}/${process.arch}`;
res.when = new Date().toISOString();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(res, null, 1));
console.log(`scenes ${scenes.length}; golden ${res.golden.passed}/${res.golden.total}; fingerprint ${res.fingerprint.overall}; ${res.timingMs.total} ms -> ${out}`);
if (res.golden.failed.length) { console.log('FAILED:', res.golden.failed.join('; ')); process.exitCode = 1; }
