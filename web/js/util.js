/* ==========================================================================
 * util.js — formatting helpers for Strata
 * Exposes a single global `Util`. No dependencies.
 * ======================================================================== */
(function (global) {
  "use strict";

  /* Human-readable byte sizes: binary (1024), 1 decimal place, IEC units.
   * Examples: 2.0 TiB, 245.5 GiB, 10.2 MiB, 4.0 KiB, 512 B
   * Because we divide by 1024, the technically correct suffix is the IEC
   * binary prefix (KiB/MiB/GiB…), not a bare "K/M/G" — that keeps it
   * unambiguous and consistent with our MiB/s and KiB/s rate labels. A
   * space separates the number from the unit (NIST style).
   * Bytes below 1 KiB are shown as a bare integer with a " B" suffix.
   * For axis ticks or other places where two adjacent values must stay
   * distinguishable at the same suffix (e.g. 91.04 TiB vs 91.21 TiB), use
   * `humanBytesAtStep` — it derives the decimals from the tick step. */
  function humanBytes(n) {
    if (n == null || isNaN(n)) return "—";
    n = Number(n);
    if (n < 0) return "—";
    if (n < 1024) return Math.round(n) + " B";
    var units = ["KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
    var i = -1;
    do {
      n /= 1024;
      i++;
    } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(1) + " " + units[i];
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
    var units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"];
    var k = Math.min(
      units.length - 1,
      Math.max(0, Math.floor(Math.log(ref) / Math.log(1024)))
    );
    var scale = Math.pow(1024, k);
    var scaledStep = Math.abs(step) / scale;
    var decimals = scaledStep > 0 ? Math.ceil(-Math.log10(scaledStep)) : 1;
    decimals = Math.min(4, Math.max(0, decimals));
    var s = (value / scale).toFixed(decimals);
    return s + " " + units[k];
  }

  /* Exact byte count with thousands separators, e.g. "2,199,023,255,552". */
  function exactBytes(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(Number(n)).toLocaleString("en-US");
  }

  /* Human-readable counts (files/dirs): decimal (1000), 1 decimal place.
   * Examples: 1.2M, 340.0K, 812 — K=thousand, M=million, B=billion, T=trillion
   * (matches Intl/CLDR compact notation: "B" is billion, not bytes).
   * A bare compact count reads as a byte size ("10.6M" looks like megabytes),
   * so always pair it with the counted noun — via `countWithNoun` for a
   * standalone value, or a column header/label that names what it counts. */
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

  /* Compact count paired with the noun it counts, e.g. "10.6M files".
   * Use wherever a count would otherwise stand alone (no nearby label or
   * column header), so it can't be misread as a byte size. The space
   * follows NIST number/unit spacing. Returns "—" when the count is
   * missing (no dangling noun). */
  function countWithNoun(n, noun) {
    var s = humanCount(n);
    return s === "—" ? s : s + " " + noun;
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

  /* ---- root identity colors --------------------------------------------
   * One stable colour per scan root, shared by every surface that names a
   * root (trend series, legend chips, the scope rail, Δ-by-path bars, the
   * compare subtotal band) so a root is the same colour everywhere.
   *
   * d3.schemeTableau10 with the brand accent (#58a6ff) reserved for the
   * all-paths total. The 5th slot of Tableau10 ("#59a14f", green) is moved
   * last to avoid colliding with the delta-panel positive-fill green
   * (--green = #3fb950). The accent-blue Tableau slot ("#4e79a7") is kept,
   * since it is dark enough to not be confused with our brand accent. */
  var ROOT_PALETTE = [
    "#e15759", /* red       */
    "#f28e2b", /* orange    */
    "#76b7b2", /* teal      */
    "#4e79a7", /* dark blue */
    "#edc948", /* yellow    */
    "#b07aa1", /* purple    */
    "#ff9da7", /* pink      */
    "#9c755f", /* brown     */
    "#bab0ac", /* warm grey */
    "#59a14f"  /* green — last because it overlaps the delta panel */
  ];
  var COLORS_LS = "strata.rootcolors.v1";

  var _rootColorMap = null;
  function _loadRootColors() {
    if (_rootColorMap) return _rootColorMap;
    var m = null;
    try {
      m = JSON.parse(global.localStorage.getItem(COLORS_LS));
    } catch (_) {
      /* private mode / malformed — fall through */
    }
    if (!m || typeof m !== "object") {
      /* one-time migration: colour slots lived inside the trends panel state
       * before the scope feature promoted them app-wide. */
      try {
        var legacy = JSON.parse(global.localStorage.getItem("strata.trends.v1"));
        if (legacy && legacy.colors && typeof legacy.colors === "object") {
          m = legacy.colors;
        }
      } catch (_) {
        /* ignore */
      }
    }
    _rootColorMap = m && typeof m === "object" ? m : {};
    return _rootColorMap;
  }
  function _saveRootColors() {
    try {
      global.localStorage.setItem(COLORS_LS, JSON.stringify(_rootColorMap));
    } catch (_) {
      /* private mode / quota — non-fatal */
    }
  }

  /* Stable palette assignment: a root keeps its colour across sessions.
   * New roots take the next free slot; once all are used, cycle modulo
   * ROOT_PALETTE.length. */
  function rootColor(path) {
    var map = _loadRootColors();
    if (map[path] != null) return ROOT_PALETTE[map[path] % ROOT_PALETTE.length];
    var used = {};
    Object.keys(map).forEach(function (k) {
      used[map[k]] = true;
    });
    var i = 0;
    while (used[i] && i < ROOT_PALETTE.length) i++;
    if (i >= ROOT_PALETTE.length) {
      /* all taken; pick the lowest-numbered slot (modular cycle) */
      i = Object.keys(map).length % ROOT_PALETTE.length;
    }
    map[path] = i;
    _saveRootColors();
    return ROOT_PALETTE[i];
  }

  /* ---- scan-path scope ---------------------------------------------------
   * The global "which scan path am I looking at" state. "" = all paths.
   * The URL is the source of truth (app.js owns parsing/writing the hash);
   * localStorage only echoes the last choice so a fresh "#/" restores it. */
  var SCOPE_LS = "strata.scope.v1";

  function scopeLoad() {
    try {
      return global.localStorage.getItem(SCOPE_LS) || "";
    } catch (_) {
      return "";
    }
  }
  function scopeSave(path) {
    try {
      if (path) global.localStorage.setItem(SCOPE_LS, path);
      else global.localStorage.removeItem(SCOPE_LS);
    } catch (_) {
      /* private mode / quota — non-fatal */
    }
  }

  /* Union of scan roots across a snapshot list (newest first), each with the
   * size from the newest snapshot that contains it. Sorted by size desc, so
   * chip order matches the trend legend. Feeds the scope rail. */
  function rootUnion(snapshots) {
    var byPath = {};
    var order = [];
    (snapshots || []).forEach(function (s) {
      (Array.isArray(s.roots) ? s.roots : []).forEach(function (r) {
        if (!r || !r.path) return;
        if (!byPath[r.path]) {
          byPath[r.path] = { path: r.path, size_actual: Number(r.size_actual) || 0 };
          order.push(byPath[r.path]);
        }
      });
    });
    order.sort(function (a, b) {
      return b.size_actual - a.size_actual;
    });
    return order;
  }

  /* Build the scope rail (variant A): [All paths] + one chip per root, each
   * with its identity dot and latest size. Collapses to a <select> above
   * SCOPE_CHIP_MAX roots. Returns null when there is nothing to scope
   * (fewer than 2 roots) so single-path deployments pay zero UI cost.
   *   roots    — rootUnion() output
   *   current  — active scope ("" = all)
   *   onChange — function(path) — "" means back to all; clicking the active
   *              root chip also returns to all. */
  var SCOPE_CHIP_MAX = 6;

  function scopeRail(roots, current, onChange) {
    if (!roots || roots.length < 2) return null;
    var rail = document.createElement("div");
    rail.className = "scope-rail";
    var lab = document.createElement("span");
    lab.className = "scope-rail-label";
    lab.textContent = "Scope";
    rail.appendChild(lab);

    var total = roots.reduce(function (a, r) {
      return a + (r.size_actual || 0);
    }, 0);

    if (roots.length > SCOPE_CHIP_MAX) {
      /* dropdown fallback — same state, compact at high path counts */
      var sel = document.createElement("select");
      sel.className = "scope-select mono";
      sel.setAttribute("aria-label", "scan path scope");
      var optAll = document.createElement("option");
      optAll.value = "";
      optAll.textContent = "All paths (" + humanBytes(total) + ")";
      sel.appendChild(optAll);
      roots.forEach(function (r) {
        var opt = document.createElement("option");
        opt.value = r.path;
        opt.textContent = r.path + " (" + humanBytes(r.size_actual) + ")";
        sel.appendChild(opt);
      });
      sel.value = current || "";
      sel.addEventListener("change", function () {
        onChange(sel.value);
      });
      rail.appendChild(sel);
      return rail;
    }

    function chip(path, label, color, size) {
      var active = (current || "") === path;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "scope-chip" + (active ? " is-active" : "");
      b.setAttribute("aria-pressed", active ? "true" : "false");
      if (path) {
        b.title = active
          ? path + " — click to show all paths"
          : "Scope everything to " + path;
        if (active) b.style.borderColor = color;
      } else {
        b.title = "Show every scan path combined";
      }
      var dot = document.createElement("span");
      dot.className = "scope-chip-dot";
      dot.style.background = color;
      b.appendChild(dot);
      var p = document.createElement("span");
      p.className = "scope-chip-path" + (path ? " mono" : "");
      p.textContent = label;
      b.appendChild(p);
      if (size != null) {
        var sz = document.createElement("span");
        sz.className = "scope-chip-size mono";
        sz.textContent = humanBytes(size);
        b.appendChild(sz);
      }
      b.addEventListener("click", function () {
        /* clicking the active root chip returns to All */
        onChange(active ? "" : path);
      });
      b.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var btns = Array.prototype.slice.call(
          rail.querySelectorAll(".scope-chip")
        );
        var i = btns.indexOf(b);
        var j =
          (i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
        btns[j].focus();
      });
      return b;
    }

    rail.appendChild(chip("", "All paths", "var(--accent)", total));
    roots.forEach(function (r) {
      rail.appendChild(
        chip(r.path, shortPath(r.path, 36), rootColor(r.path), r.size_actual)
      );
    });
    return rail;
  }

  /* ---- shared API + UI fragments --------------------------------------
   * The dashboard and the compare page both poll the same CGI endpoint
   * and need the same spinner / error-box fragments; kept here so the two
   * pages can't drift in their error-handling contract. */
  var API = "cgi-bin/api.cgi";

  /* All endpoints return application/json; errors come back as
   * {"error": "..."} with HTTP 200, so every call must check `.error`. */
  function apiGet(op, params) {
    var qs = "op=" + encodeURIComponent(op);
    if (params) {
      Object.keys(params).forEach(function (k) {
        if (params[k] != null)
          qs += "&" + k + "=" + encodeURIComponent(params[k]);
      });
    }
    return fetch(API + "?" + qs, { headers: { Accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        if (json && json.error) throw new Error(json.error);
        return json;
      });
  }

  /* spinner markup, used both as a string in larger innerHTML templates and
   * as a DOM node via spinnerEl(). One source of truth for the class names. */
  function spinnerHTML(label) {
    return (
      '<div class="loading"><div class="spin"></div><span>' +
      esc(label || "Loading…") +
      "</span></div>"
    );
  }

  function spinnerEl(label) {
    var d = document.createElement("div");
    d.innerHTML = spinnerHTML(label);
    return d.firstChild;
  }

  function errorBox(msg, retryFn) {
    var box = document.createElement("div");
    box.className = "errbox";
    box.innerHTML =
      '<div class="errbox-icon">!</div>' +
      '<div class="errbox-body">' +
      '<div class="errbox-title">Something went wrong</div>' +
      '<div class="errbox-msg">' +
      esc(msg) +
      "</div></div>";
    if (retryFn) {
      var btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Retry";
      btn.addEventListener("click", retryFn);
      box.appendChild(btn);
    }
    return box;
  }

  /* Measure a string's rendered width via an offscreen 2-D canvas. `fontPx`
   * is the font size in whatever units the caller is working in (the result
   * comes back in the same units). Used to fit chart labels precisely. */
  var _measureCtx = null;
  /* Measure text width for fitting/truncation. `mono` selects the monospace
   * stack (matches CSS --mono) — used for the centre disc label, which renders
   * mono; measuring it as sans under-counts and lets the name overflow. */
  function textWidth(text, fontPx, weight, mono) {
    if (!_measureCtx) {
      _measureCtx = document.createElement("canvas").getContext("2d");
    }
    var family = mono
      ? 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, ' +
        '"Liberation Mono", monospace'
      : '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, ' +
        "sans-serif";
    _measureCtx.font = (weight || 500) + " " + (fontPx || 14) + "px " + family;
    return _measureCtx.measureText(text == null ? "" : String(text)).width;
  }

  global.Util = {
    humanBytes: humanBytes,
    humanBytesAtStep: humanBytesAtStep,
    exactBytes: exactBytes,
    humanCount: humanCount,
    countWithNoun: countWithNoun,
    commaCount: commaCount,
    humanDuration: humanDuration,
    pctStr: pctStr,
    rateMiB: rateMiB,
    rateKiB: rateKiB,
    epochToStr: epochToStr,
    coalesce: coalesce,
    orDash: orDash,
    esc: esc,
    shortPath: shortPath,
    textWidth: textWidth,
    rootColor: rootColor,
    rootUnion: rootUnion,
    scopeLoad: scopeLoad,
    scopeSave: scopeSave,
    scopeRail: scopeRail,
    apiGet: apiGet,
    spinnerHTML: spinnerHTML,
    spinnerEl: spinnerEl,
    errorBox: errorBox
  };
})(window);
