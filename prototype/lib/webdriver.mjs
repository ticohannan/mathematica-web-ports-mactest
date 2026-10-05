// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/lib/webdriver.mjs — INVESTIGATION CODE. Minimal W3C WebDriver (classic) client using
// Node's built-in fetch (Node 18+); no dependencies. Covers only what run-suite.mjs needs. Works
// with safaridriver (Safari), WebKitWebDriver (WebKitGTK), chromedriver and geckodriver.

export class WebDriverError extends Error {
  constructor(cmd, value) {
    super(`${cmd}: ${value && value.error ? `${value.error}: ${value.message}` : JSON.stringify(value)}`);
    this.value = value;
  }
}

export class WebDriver {
  constructor(base, sessionId) { this.base = base.replace(/\/$/, ''); this.id = sessionId; }

  static async raw(base, method, path, body) {
    const r = await fetch(base.replace(/\/$/, '') + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { value: { error: `HTTP ${r.status}`, message: text.slice(0, 300) } }; }
    if (!r.ok || (json.value && json.value.error)) throw new WebDriverError(`${method} ${path}`, json.value);
    return json.value;
  }

  static async status(base) { return WebDriver.raw(base, 'GET', '/status'); }

  static async newSession(base, alwaysMatch) {
    const v = await WebDriver.raw(base, 'POST', '/session', { capabilities: { alwaysMatch } });
    const d = new WebDriver(base, v.sessionId);
    d.capabilities = v.capabilities;
    return d;
  }

  cmd(method, path, body) { return WebDriver.raw(this.base, method, `/session/${this.id}${path}`, body); }
  navigate(url) { return this.cmd('POST', '/url', { url }); }
  title() { return this.cmd('GET', '/title'); }
  setWindowRect(rect) { return this.cmd('POST', '/window/rect', rect); }
  execute(script, args = []) { return this.cmd('POST', '/execute/sync', { script, args }); }
  executeAsync(script, args = []) { return this.cmd('POST', '/execute/async', { script, args }); }
  setTimeouts(t) { return this.cmd('POST', '/timeouts', t); }
  screenshot() { return this.cmd('GET', '/screenshot'); } // base64 PNG
  performActions(actions) { return this.cmd('POST', '/actions', { actions }); }
  releaseActions() { return this.cmd('DELETE', '/actions'); }
  quit() { return this.cmd('DELETE', ''); }

  /** Find one element by CSS selector; returns its WebDriver element id. */
  async find(css) {
    const v = await this.cmd('POST', '/element', { using: 'css selector', value: css });
    return v['element-6066-11e4-a52e-4f735466cecf'];
  }
  click(elementId) { return this.cmd('POST', `/element/${elementId}/click`, {}); }
  async clickCss(css) { return this.click(await this.find(css)); }

  /** Press one key (W3C key value, e.g. '' = ArrowRight) on the focused element. */
  async key(value) {
    await this.performActions([{ type: 'key', id: 'kbd', actions: [{ type: 'keyDown', value }, { type: 'keyUp', value }] }]);
    await this.releaseActions().catch(() => {});
  }

  /** Poll a JS expression until it is truthy (or time out); returns its value. */
  async waitFor(expr, timeoutMs = 20000, intervalMs = 100) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
      try { last = await this.execute(`return (${expr});`); } catch (e) { last = undefined; }
      if (last) return { value: last, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { value: last, ms: Date.now() - t0, timedOut: true };
  }

  /** Mouse drag from (x0,y0) by (dx,dy) in viewport CSS pixels, in `steps` moves. */
  async drag(x0, y0, dx, dy, steps = 8) {
    const r = (v) => Math.round(v);
    const moves = [];
    for (let i = 1; i <= steps; i++) moves.push({ type: 'pointerMove', duration: 20, origin: 'viewport', x: r(x0 + (dx * i) / steps), y: r(y0 + (dy * i) / steps) });
    await this.performActions([{
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: 'viewport', x: r(x0), y: r(y0) },
        { type: 'pointerDown', button: 0 },
        ...moves,
        { type: 'pointerUp', button: 0 },
      ],
    }]);
    await this.releaseActions().catch(() => {});
  }
}
