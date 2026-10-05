// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/probe/mathprobe.js — INVESTIGATION CODE. Evaluates the JavaScript Math functions the
// ports use on 1,000 fixed inputs each and returns the exact result bits, so results from two
// engines can be compared function by function (ECMAScript does not require these functions to be
// correctly rounded; engines use different libm implementations: V8 and SpiderMonkey ship their own
// fdlibm ports, JavaScriptCore calls the platform libm — glibc on Linux, Apple's libm on macOS).
// Runs unchanged in Node and in browsers.

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

const N = 1000;
const FNS = {
  sin: (r) => [ (r() - 0.5) * 20 ],
  cos: (r) => [ (r() - 0.5) * 20 ],
  tan: (r) => [ (r() - 0.5) * 3 ],
  atan: (r) => [ (r() - 0.5) * 10 ],
  atan2: (r) => [ (r() - 0.5) * 10, (r() - 0.5) * 10 ],
  acos: (r) => [ r() * 2 - 1 ],
  asin: (r) => [ r() * 2 - 1 ],
  exp: (r) => [ (r() - 0.5) * 20 ],
  log: (r) => [ r() * 100 + 1e-3 ],
  pow: (r) => [ r() * 10, (r() - 0.5) * 6 ],
  hypot: (r) => [ (r() - 0.5) * 10, (r() - 0.5) * 10 ],
  sqrt: (r) => [ r() * 100 ],
  cbrt: (r) => [ (r() - 0.5) * 100 ],
};

const buf = new DataView(new ArrayBuffer(8));
const bits = (x) => { buf.setFloat64(0, x); return buf.getUint32(0).toString(16).padStart(8, '0') + buf.getUint32(4).toString(16).padStart(8, '0'); };

/** { fn: [hex bits of result for input i] } */
export function mathSample() {
  const out = {};
  for (const [fn, gen] of Object.entries(FNS)) {
    const r = lcg(fn.length * 7919 + fn.charCodeAt(0));
    const f = Math[fn];
    const row = new Array(N);
    for (let i = 0; i < N; i++) row[i] = bits(f(...gen(r)));
    out[fn] = row;
  }
  return out;
}

/** Compare two samples: per function, how many results differ and by how many units in the last place. */
export function diffMath(ref, got) {
  const res = {};
  for (const fn of Object.keys(ref)) {
    let n = 0; let maxUlp = 0;
    for (let i = 0; i < ref[fn].length; i++) {
      const a = ref[fn][i]; const b = got[fn] && got[fn][i];
      if (a !== b) {
        n++;
        if (typeof BigInt === 'function' && b) {
          const d = BigInt('0x' + a) - BigInt('0x' + b);
          const u = Number(d < 0n ? -d : d);
          if (u > maxUlp) maxUlp = u;
        }
      }
    }
    res[fn] = { differing: n, of: ref[fn].length, maxUlp };
  }
  return res;
}
