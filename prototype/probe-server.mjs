#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/probe-server.mjs — INVESTIGATION CODE (see README.md). Zero dependencies.
//
// Serves a CHECKOUT of the repository (read-only; nothing in it is changed) the way tools/serve.mjs
// does, plus:
//   * injects <script src="/__probe/probe.js"> as the first element of <head> of every .html page,
//     so uncaught errors are recorded even in browsers whose WebDriver cannot read the console;
//   * serves this folder's probe/ files at /__probe/ (parity.html, fingerprint.js, ...);
//   * accepts POST /__report?name=NAME and writes the JSON body to --reports DIR, so a browser that
//     was opened without WebDriver (e.g. `open -a Safari URL` over SSH) can still report back.
//
// Usage:
//   node probe-server.mjs --repo PATH_TO_CHECKOUT [--port 8090] [--host 127.0.0.1] [--reports DIR]
// Binds to 127.0.0.1 by default. In the VM set-ups of MACVM-LNX / MACVM-WIN the guest reaches it
// through an SSH reverse tunnel (ssh -R 8090:127.0.0.1:8090), so it never needs to listen publicly.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const repo = path.resolve(args.repo || '.');
const port = Number(args.port || 8090);
const host = args.host || '127.0.0.1';
const reports = path.resolve(args.reports || path.join(here, 'results', 'posted'));
const probeDir = path.join(here, 'probe');

if (!fs.existsSync(path.join(repo, 'demos'))) {
  console.error(`--repo ${repo} does not look like a mathematica-web-ports checkout (no demos/ folder)`);
  process.exit(2);
}
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const blocked = ['/_internal', '/node_modules', '/.git'];
const INJECT = '<script src="/__probe/probe.js"></script>';

function sendFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (ext === '.html') {
    let html = fs.readFileSync(file, 'utf8');
    const m = /<head[^>]*>/i.exec(html);
    html = m ? html.slice(0, m.index + m[0].length) + INJECT + html.slice(m.index + m[0].length) : INJECT + html;
    res.writeHead(200, headers);
    return res.end(html);
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const urlPath = decodeURIComponent(url.pathname);
    if (req.method === 'POST' && urlPath === '/__report') {
      const name = (url.searchParams.get('name') || 'report').replace(/[^A-Za-z0-9._-]/g, '_');
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
      req.on('end', () => {
        fs.mkdirSync(reports, { recursive: true });
        const file = path.join(reports, `${new Date().toISOString().replace(/[:.]/g, '-')}_${name}.json`);
        fs.writeFileSync(file, body);
        console.log(`report saved: ${file}`);
        res.writeHead(201, { 'Content-Type': 'text/plain' });
        res.end('saved');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let root = repo;
    let rel = urlPath;
    if (urlPath.startsWith('/__probe/')) { root = probeDir; rel = urlPath.slice('/__probe'.length); }
    else if (blocked.some((b) => urlPath === b || urlPath.startsWith(b + '/'))) { res.writeHead(403); return res.end('Forbidden'); }
    let file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    sendFile(res, file);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});
server.listen(port, host, () => console.log(`probe-server: ${repo} at http://${host}:${port}/  (probe at /__probe/, reports -> ${reports})`));
