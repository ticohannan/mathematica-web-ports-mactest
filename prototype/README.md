# Cross-browser probe harness for mathematica-web-ports (investigation code)

Small, dependency-free tools for checking the mathematica-web-ports pages in browsers that the
repository's Playwright suite cannot drive — above all **Safari**, through Apple's `safaridriver` — and
for comparing the ports' model numerics between JavaScript engines. They serve a **checkout of the
repository unchanged**; nothing here is part of the website. Produced with an AI code-generation tool;
licence MIT (see the SPDX header in each file).

## Files

| File | What it does |
|---|---|
| `probe-server.mjs` | Static server for a repository checkout. Injects `probe/probe.js` into every HTML page, serves `probe/` at `/__probe/`, and accepts `POST /__report` (JSON results from a browser opened without WebDriver). Binds to 127.0.0.1. |
| `probe/probe.js` | ES5 script injected first in `<head>`: records uncaught errors, unhandled rejections, `console.error`, and reports WebGL availability. |
| `probe/parity.html`, `probe/parity.js` | Runs the repository's model code in the browser: the 40 golden checks of `tests/golden/parity.test.js`, a bit-exact fingerprint of 65 motion-planning scenes and of the rotation/Euler models, and a `Math` sample. Result in `window.__parity`; `?report=1` also POSTs it to the server. |
| `probe/fingerprint.js`, `probe/mathprobe.js` | The shared logic (runs unchanged in Node and in browsers). |
| `node-reference.mjs` | Computes the same in Node (V8) as the reference. |
| `lib/webdriver.mjs` | Minimal W3C WebDriver client (Node 18+ `fetch`). |
| `run-suite.mjs` | Smoke + interaction + parity suite over WebDriver: page loads, real mouse drag, arrow key, setter click, SVG geometry, parity page; writes `report.json`, `summary.md`, screenshots. Presets: `safari`, `chrome`, `firefox`, `webkitgtk`. |
| `playwright-parity.mjs` | Opens the parity page in Playwright's Chromium/Firefox/WebKit (uses the checkout's own `@playwright/test`). |
| `macos-guest/prepare-guest.sh` | One-time preparation of a macOS test machine: Safari WebDriver on, `safaridriver` at login on port 4444, no sleep/updates/indexing. |
| `hosts/linux/run-mac-vm-tests.sh` | One disposable run against a macOS guest on QEMU/KVM (overlay disk, SSH tunnels, suite, power-off). |
| `hosts/windows/run-mac-vm-tests.ps1` | The same for a VMware Workstation guest (snapshot revert). |
| `github-actions/macos-browsers.yml` | Workflow for GitHub-hosted macOS runners: Safari/Chrome/Firefox via WebDriver on Apple-silicon and Intel images, plus the repository's Playwright WebKit suite. |

## Quick start (any machine with Node 18+)

```
node node-reference.mjs --repo PATH_TO_CHECKOUT --out results/reference-node.json
node probe-server.mjs --repo PATH_TO_CHECKOUT --port 8090
# then, with a WebDriver server for your browser on port 4444 (e.g. `safaridriver -p 4444` on a Mac):
node run-suite.mjs --browser safari --webdriver http://127.0.0.1:4444 --site http://127.0.0.1:8090 --reference results/reference-node.json --out results/my-run
```
Without WebDriver: open `http://127.0.0.1:8090/__probe/parity.html?report=1&name=my-browser` in any
browser; the result is saved under `results/posted/`.

## Status
Verified with WebKitGTK (WebKitWebDriver) and Chromium on Linux. The macOS, VMware and GitHub
Actions scripts have not been run yet.
