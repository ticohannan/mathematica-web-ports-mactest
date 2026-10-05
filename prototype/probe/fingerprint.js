// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/probe/fingerprint.js — INVESTIGATION CODE, not part of the app (see ../README.md).
//
// Runs the ports' pure model code (no DOM, no WebGL) and reduces every number it produces to a
// 64-bit hash of the exact IEEE-754 bits. The same module runs in Node (V8 = reference) and in any
// browser, so two engines that compute even one bit differently get different hashes, and the
// per-scene hashes say WHERE they differ. It also repeats the golden checks of
// tests/golden/parity.test.js (exact equality, -0 distinguished from +0) inside the browser.
//
// The model modules are passed in (not imported here) because Node and the browser reach them by
// different paths.

// ---- exact hashing ---------------------------------------------------------------------------
// FNV-1a over bytes, two independent 32-bit lanes (no BigInt needed; works in old engines too).
function makeHasher() {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  const buf = new DataView(new ArrayBuffer(8));
  const byte = (b) => {
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x5bd1e995) ^ (h2 >>> 15);
  };
  const str = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); byte(c & 0xff); byte(c >>> 8); } byte(0); };
  const num = (x) => {
    if (Number.isNaN(x)) { str('NaN'); return; } // NaN payloads are not portable: canonicalise
    buf.setFloat64(0, x, true);
    for (let i = 0; i < 8; i++) byte(buf.getUint8(i));
  };
  const walk = (v) => {
    if (v === null) return str('Z');
    switch (typeof v) {
      case 'number': str('N'); return num(v);
      case 'string': str('S'); return str(v);
      case 'boolean': return str(v ? 'T' : 'F');
      case 'undefined': return str('U');
      case 'function': return str('Fn');
      default: break;
    }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) { str('A'); num(v.length); for (const e of v) walk(e); return; }
    if (v instanceof Map) { str('M'); num(v.size); for (const [k, e] of v) { walk(k); walk(e); } return; }
    if (v instanceof Set) { str('Set'); num(v.size); for (const e of v) walk(e); return; }
    str('O');
    const keys = Object.keys(v).sort();
    num(keys.length);
    for (const k of keys) { str(k); walk(v[k]); }
  };
  const hex = () => (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return { walk, hex };
}

export function hashValue(v) {
  const h = makeHasher();
  h.walk(v);
  return h.hex();
}

// ---- exact equality (like Vitest toEqual on numbers, but -0 !== +0 and NaN === NaN) ---------
export function exactEqual(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => exactEqual(x, b[i]));
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') return false;
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && exactEqual(a[k], b[k]));
  }
  return a === b;
}
const closeDeep = (a, b, tol) => {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((v, i) => closeDeep(v, b[i], tol));
  return Math.abs(a - b) <= tol;
};

// ---- golden checks: the same assertions as tests/golden/parity.test.js ------------------------
export function goldenChecks({ computeScene, evaluate }, goldMP, goldTP) {
  const out = [];
  const add = (name, pass) => out.push({ name, pass: !!pass });
  goldMP.states.forEach((s, i) => {
    const sc = computeScene({ x: s.x, n: s.n, r1: s.r1, r2: s.r2, o1: s.o1, o2: s.o2, o3: s.o3, o4: s.o4 });
    const p = `MP state ${i}`;
    add(`${p}: obstacle polygons (bit-identical)`, exactEqual(sc.obstaclepoly, s.prevObstaclepoly));
    add(`${p}: robot polygons (bit-identical)`, exactEqual(sc.robotStartPoly, s.prevRobotStartPoly) && exactEqual(sc.robotEndPoly, s.prevRobotEndPoly));
    add(`${p}: Minkowski sums (bit-identical)`, exactEqual(sc.robotobstconfig, s.prevRobotobstconfig));
    add(`${p}: visibility lines from start (bit-identical)`, exactEqual(sc.linesStarttoObstacles, s.linesStarttoObstacles));
    add(`${p}: visibility lines from end (bit-identical)`, exactEqual(sc.linesEndtoObstacles, s.linesEndtoObstacles));
    add(`${p}: bitangent lines (bit-identical)`, exactEqual(sc.verticestoVertices, s.verticestoVertices));
    add(`${p}: discretised path (1e-15)`, closeDeep(sc.discretePath, s.discretePath, 1e-15));
  });
  goldTP.states.forEach((s, i) => {
    const st = { progress: s.progress, typeRot: s.typeRot, phi: s.Phi, theta: s.Theta, psi: s.Psi,
      axis: s.axis, angle: s.angle, alpha: s.Alpha, beta: s.Beta, gamma: s.Gamma };
    const o = evaluate(st).state;
    // parity.test.js uses toBeCloseTo(x, 9): |a - b| < 5e-10
    const ok = ['phi', 'theta', 'psi', 'angle', 'alpha', 'beta', 'gamma'].every((k) => Math.abs(o[k] - st[k]) < 5e-10)
      && Math.abs(o.axis[0] - st.axis[0]) < 5e-10 && Math.abs(o.axis[1] - st.axis[1]) < 5e-10;
    add(`TP state ${i} (method ${s.typeRot}) (1e-9)`, ok);
  });
  return out;
}

// ---- engine fingerprint ------------------------------------------------------------------------
/** Motion planning: one hash per scene and per output field. */
export function motionFingerprint(computeScene, scenes) {
  return scenes.map((sc) => {
    const st = { x: sc.x, n: sc.n, r1: sc.r1, r2: sc.r2, o1: sc.o1, o2: sc.o2, o3: sc.o3, o4: sc.o4 };
    let out;
    try { out = computeScene(st); } catch (e) { return { id: sc.id, error: String(e && e.message || e) }; }
    const fields = {};
    for (const k of Object.keys(out).sort()) fields[k] = hashValue(out[k]);
    return { id: sc.id, hash: hashValue(fields), fields };
  });
}

/** Three parametrizations: sweep all three methods over a fixed grid (includes gimbal-lock angles). */
export function rotationsFingerprint(evaluate, DEFAULTS) {
  const angles = [0, Math.PI / 7, Math.PI / 2, 2.5, Math.PI, -1.2, 3 * Math.PI / 2 - 1e-9];
  const rows = [];
  for (const typeRot of [1, 2, 3]) {
    for (const a of angles) for (const b of angles) {
      const st = { ...DEFAULTS, typeRot, progress: 0.8,
        phi: a, theta: b, psi: a - b, axis: [a, b / 3], angle: b, alpha: a, beta: b / 2, gamma: a + b };
      let r;
      try { r = evaluate(st); } catch (e) { r = { error: String(e && e.message || e) }; }
      rows.push(hashValue(r));
    }
  }
  return { n: rows.length, hash: hashValue(rows), rows };
}

/** Euler angles: every 7th degree on all three angles. */
export function eulerFingerprint(orientations) {
  const rows = [];
  for (let a1 = 0; a1 <= 360; a1 += 45) for (let a2 = 0; a2 <= 360; a2 += 30) for (let a3 = 0; a3 <= 360; a3 += 7) {
    rows.push(hashValue(orientations({ a1, a2, a3 })));
  }
  return { n: rows.length, hash: hashValue(rows) };
}

/** Everything; returns plain JSON. */
export function runAll(mods, data) {
  const t0 = Date.now();
  const golden = goldenChecks(mods, data.goldMP, data.goldTP);
  const t1 = Date.now();
  const motion = motionFingerprint(mods.computeScene, data.scenes);
  const t2 = Date.now();
  const rotations = rotationsFingerprint(mods.evaluate, mods.TP_DEFAULTS);
  const euler = eulerFingerprint(mods.orientations);
  const t3 = Date.now();
  return {
    golden: { total: golden.length, passed: golden.filter((g) => g.pass).length, failed: golden.filter((g) => !g.pass).map((g) => g.name) },
    fingerprint: {
      overall: hashValue([motion.map((m) => m.hash || m.error), rotations.hash, euler.hash]),
      motion: { scenes: motion.length, hash: hashValue(motion.map((m) => m.hash || m.error)), perScene: motion },
      rotations: { n: rotations.n, hash: rotations.hash, rows: rotations.rows },
      euler,
    },
    timingMs: { golden: t1 - t0, motion: t2 - t1, rotationsAndEuler: t3 - t2, total: t3 - t0 },
  };
}

/** Compare a result with a reference result; lists what differs. */
export function diffFingerprints(ref, got) {
  const d = { identical: ref.fingerprint.overall === got.fingerprint.overall, motionScenesDiffering: [], rotationsRowsDiffering: 0, eulerDiffers: false };
  const byId = new Map(ref.fingerprint.motion.perScene.map((m) => [m.id, m]));
  for (const m of got.fingerprint.motion.perScene) {
    const r = byId.get(m.id);
    if (!r || r.hash !== m.hash) {
      const fields = r && r.fields && m.fields ? Object.keys(r.fields).filter((k) => r.fields[k] !== m.fields[k]) : ['(missing or error)'];
      d.motionScenesDiffering.push({ id: m.id, fields });
    }
  }
  const rr = ref.fingerprint.rotations.rows;
  const gr = got.fingerprint.rotations.rows;
  d.rotationsRowsDiffering = rr.filter((h, i) => h !== gr[i]).length;
  d.eulerDiffers = ref.fingerprint.euler.hash !== got.fingerprint.euler.hash;
  return d;
}
