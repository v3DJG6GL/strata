/* ==========================================================================
 * util.js — formatting helpers for DUC Advanced
 * Exposes a single global `Util`. No dependencies.
 * ======================================================================== */
(function (global) {
  "use strict";

  /* duc-style human-readable byte sizes: binary (1024), 1 decimal place.
   * Examples: 2.0T, 245.5G, 10.2M, 4.0K, 512
   * Bytes below 1K are shown as a bare integer (no suffix, no decimal). */
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
    return n.toFixed(1) + units[i];
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

  global.Util = {
    humanBytes: humanBytes,
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
    shortPath: shortPath
  };
})(window);
