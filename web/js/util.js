/* ==========================================================================
 * util.js — formatting helpers for Strata
 * Exposes a single global `Util`. No dependencies.
 * ======================================================================== */
(function (global) {
  "use strict";

  /* Human-readable byte sizes: binary (1024), 2 decimal places.
   * Examples: 2.00T, 245.50G, 10.20M, 4.00K, 512
   * Bytes below 1K are shown as a bare integer (no suffix, no decimal).
   * Two decimals (was one) so storage values at the TB scale carry
   * meaningful precision side-by-side (91.04T vs 91.21T, not 91.0T vs 91.2T). */
  function humanBytes(n) {
    if (n == null || isNaN(n)) return "—";
    n = Number(n);
    if (n < 0) return "—";
    if (n < 1024) return String(Math.round(n));
    var units = ["K", "M", "G", "T", "P", "E"];
    var i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(2) + units[i];
  }

  /* Adaptive byte formatter for axis tick labels or other collision-prone
   * places where multiple values are shown next to each other. Picks the
   * unit from `refValue` (or `value` if not given) so every tick on the
   * same axis shares a suffix; picks decimals from `step` so adjacent
   * ticks are always distinguishable. Binary (1024) units, like humanBytes.
   *
   * Usage: compute once per axis, then call per tick:
   *   var step = ticks[1] - ticks[0];
   *   var ref  = Math.max.apply(null, ticks.map(Math.abs));
   *   ticks.forEach(function (d) { ...humanBytesAtStep(d, step, ref)... });
   */
  function humanBytesAtStep(value, step, refValue) {
    if (value == null || isNaN(value)) return "—";
    if (value === 0) return "0";
    var ref =
      Math.abs(refValue != null ? refValue : value) ||
      Math.abs(step) ||
      1;
    var units = ["B", "K", "M", "G", "T", "P", "E"];
    var k = Math.min(
      units.length - 1,
      Math.max(0, Math.floor(Math.log(ref) / Math.log(1024)))
    );
    var scale = Math.pow(1024, k);
    var scaledStep = Math.abs(step) / scale;
    var decimals = scaledStep > 0 ? Math.ceil(-Math.log10(scaledStep)) : 1;
    decimals = Math.min(4, Math.max(0, decimals));
    var s = (value / scale).toFixed(decimals);
    return k === 0 ? s : s + units[k];
  }

  /* Exact byte count with thousands separators, e.g. "2,199,023,255,552". */
  function exactBytes(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(Number(n)).toLocaleString("en-US");
  }

  /* Human-readable counts (files/dirs): decimal (1000), 1 decimal place.
   * Examples: 1.2M, 340.0K, 812 */
  function humanCount(n) {
    if (n == null || isNaN(n)) return "—";
    n = Number(n);
    if (n < 0) return "—";
    if (n < 1000) return String(Math.round(n));
    var units = ["K", "M", "B", "T"];
    var i = -1;
    do {
      n /= 1000;
      i++;
    } while (n >= 1000 && i < units.length - 1);
    return n.toFixed(1) + units[i];
  }

  /* Integer with thousands separators, e.g. "10,418,725". */
  function commaCount(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(Number(n)).toLocaleString("en-US");
  }

  /* Duration from seconds → compact human string.
   * Examples: "1h 02m", "3m 12s", "45s" */
  function humanDuration(sec) {
    if (sec == null || isNaN(sec)) return "—";
    sec = Math.max(0, Math.floor(Number(sec)));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (h > 0) return h + "h " + pad2(m) + "m";
    if (m > 0) return m + "m " + pad2(s) + "s";
    return s + "s";
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /* Percentage of part within whole, returns a Number (0..100).
   * Guards division by zero. */
  function pct(part, whole) {
    if (!whole || isNaN(whole) || isNaN(part)) return 0;
    return (Number(part) / Number(whole)) * 100;
  }

  /* Format a percentage for display, e.g. "42.7%", "0.1%", "<0.1%". */
  function pctStr(part, whole) {
    var p = pct(part, whole);
    if (p > 0 && p < 0.1) return "<0.1%";
    return p.toFixed(1) + "%";
  }

  /* MiB/s rate, 1 decimal: "5.2 MiB/s". */
  function rateMiB(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(1) + " MiB/s";
  }

  /* KiB/s rate, 1 decimal: "12.4 KiB/s". */
  function rateKiB(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(1) + " KiB/s";
  }

  /* Unix epoch seconds → "2026-05-20 22:12". Returns em-dash on null. */
  function epochToStr(epoch) {
    if (epoch == null || isNaN(epoch)) return "—";
    var d = new Date(Number(epoch) * 1000);
    if (isNaN(d.getTime())) return "—";
    return (
      d.getFullYear() +
      "-" +
      pad2(d.getMonth() + 1) +
      "-" +
      pad2(d.getDate()) +
      " " +
      pad2(d.getHours()) +
      ":" +
      pad2(d.getMinutes())
    );
  }

  /* Coalesce: return first non-null/non-undefined argument, else `def`. */
  function coalesce() {
    for (var i = 0; i < arguments.length - 1; i++) {
      if (arguments[i] != null) return arguments[i];
    }
    return arguments[arguments.length - 1];
  }

  /* Show value or em-dash if missing. Optionally pass a formatter fn. */
  function orDash(v, fmt) {
    if (v == null || v === "" || (typeof v === "number" && isNaN(v))) return "—";
    return fmt ? fmt(v) : String(v);
  }

  /* Escape text for safe insertion into HTML. */
  function esc(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* Truncate a long path keeping the meaningful tail, e.g.
   * "/mnt/hdd-pool/…/photos/2024". */
  function shortPath(path, maxLen) {
    maxLen = maxLen || 48;
    if (!path) return "/";
    if (path.length <= maxLen) return path;
    var parts = path.split("/").filter(Boolean);
    if (parts.length <= 2) return path;
    var tail = parts.slice(-2).join("/");
    return "/" + parts[0] + "/…/" + tail;
  }

  /* Measure a string's rendered width via an offscreen 2-D canvas. `fontPx`
   * is the font size in whatever units the caller is working in (the result
   * comes back in the same units). Used to fit chart labels precisely. */
  var _measureCtx = null;
  function textWidth(text, fontPx, weight) {
    if (!_measureCtx) {
      _measureCtx = document.createElement("canvas").getContext("2d");
    }
    _measureCtx.font =
      (weight || 500) + " " + (fontPx || 14) + 'px "Segoe UI", system-ui, ' +
      "-apple-system, Roboto, Helvetica, Arial, sans-serif";
    return _measureCtx.measureText(text == null ? "" : String(text)).width;
  }

  global.Util = {
    humanBytes: humanBytes,
    humanBytesAtStep: humanBytesAtStep,
    exactBytes: exactBytes,
    humanCount: humanCount,
    commaCount: commaCount,
    humanDuration: humanDuration,
    pct: pct,
    pctStr: pctStr,
    rateMiB: rateMiB,
    rateKiB: rateKiB,
    epochToStr: epochToStr,
    coalesce: coalesce,
    orDash: orDash,
    esc: esc,
    shortPath: shortPath,
    textWidth: textWidth
  };
})(window);
