// SPDX-FileCopyrightText: 2026 Tico Hannan
// SPDX-License-Identifier: MIT
// prototype/probe/probe.js — INVESTIGATION CODE. probe-server.mjs injects this classic script as the
// first element of <head> of every HTML page it serves, so it runs before the page's modules and
// records what WebDriver cannot read in Safari (safaridriver has no console-log endpoint):
// uncaught errors, unhandled promise rejections and console.error calls. Written in ES5 on purpose
// so that it also runs in old or minimal engines.
(function () {
  var P = window.__probe = { t0: Date.now(), errors: [], rejections: [], consoleErrors: [] };
  window.addEventListener('error', function (e) {
    var where = e && e.filename ? ' @ ' + e.filename + ':' + e.lineno : '';
    P.errors.push(String((e && e.message) || (e && e.type) || e) + where);
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    P.rejections.push(String((r && (r.stack || r.message)) || r));
  });
  if (window.console && console.error) {
    var orig = console.error;
    console.error = function () {
      try { P.consoleErrors.push(Array.prototype.map.call(arguments, String).join(' ')); } catch (_) { /* ignore */ }
      return orig.apply(console, arguments);
    };
  }
  /** What WebGL this browser offers (renderer string shows software vs. GPU). */
  P.webgl = function () {
    var r = { webgl2: false, webgl: false };
    try {
      var g = document.createElement('canvas').getContext('webgl2');
      r.webgl2 = !!g;
      if (!g) g = document.createElement('canvas').getContext('webgl');
      r.webgl = !!g;
      if (g) {
        var ext = g.getExtension('WEBGL_debug_renderer_info');
        r.renderer = ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
        r.vendor = ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR);
      }
    } catch (err) { r.error = String(err); }
    return r;
  };
  P.ua = navigator.userAgent;
})();
