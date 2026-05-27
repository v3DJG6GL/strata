/* ==========================================================================
 * trends.js — "storage over time" panel for the dashboard
 *
 *   Trends.render(containerEl, snapshots)   // snapshots = op=snapshots list
 *   -> draws the panel; returns true if drawn (needs >= 2 dated snapshots),
 *      false otherwise. Idempotent re-renders on the same container are cheap.
 *
 * Panel contents:
 *   - Section controls (injected into the container's section-head-right):
 *       [ Auto-fit | Zero ]   [ Total | Lines | Stacked ]
 *   - Main chart    — total / per-root lines / stacked area
 *   - Chip legend   — one chip per root, click to toggle (lines/stacked only)
 *   - Δ panel       — change-since-first, signed area with green/red fills
 *
 * State (mode + visibility + per-root palette) persists in localStorage under
 * `strata.trends.v1`. The data flattener is pure; rendering is full-redraw on
 * any state change — cheap for the snapshot counts we deal with.
 *
 * Depends on: d3 (v7 global), Util.
 * ======================================================================== */
(function (global) {
  "use strict";

  var d3 = global.d3;
  var U = global.Util;

  var LS_KEY = "strata.trends.v1";

  /* d3.schemeTableau10 with the brand accent (#58a6ff) reserved for the
   * total overlay. The 5th slot of Tableau10 ("#59a14f", green) is replaced
   * with a teal to avoid colliding with the delta-panel positive-fill green
   * (--green = #3fb950). The accent-blue Tableau slot ("#4e79a7") is kept,
   * since it is dark enough to not be confused with our brand accent. */
  var PALETTE = [
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

  /* Module-level state — survives re-renders on the same dashboard view. */
  var resizeObs = null;
  var lastSig = null;          /* short hash of the snapshots we last drew */
  var state = null;            /* loaded lazily on first render            */
  /* Pending click→navigate timer; module-scope so a fresh draw can cancel
   * it (the timer outlives the closure that scheduled it). */
  var pendingClickTimer = null;

  /* ---------- state persistence ---------------------------------------- */

  function loadState() {
    var s;
    try {
      s = JSON.parse(global.localStorage.getItem(LS_KEY)) || {};
    } catch (_) {
      s = {};
    }
    return {
      yMode: s.yMode === "zero" ? "zero" : "auto",
      viewMode:
        s.viewMode === "lines" || s.viewMode === "stacked"
          ? s.viewMode
          : "total",
      hiddenRoots: Array.isArray(s.hiddenRoots) ? s.hiddenRoots.slice() : [],
      colors: s.colors && typeof s.colors === "object" ? s.colors : {},
      range: sanitizeRange(s.range)
    };
  }

  function saveState() {
    try {
      global.localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          yMode: state.yMode,
          viewMode: state.viewMode,
          hiddenRoots: state.hiddenRoots,
          colors: state.colors,
          range: state.range
        })
      );
    } catch (_) {
      /* private mode / quota — non-fatal */
    }
  }

  /* ---------- time range -------------------------------------------------
   * State shape:
   *   { kind: "all" }
   *   { kind: "preset", preset: "7d"|"14d"|"30d"|"90d" }
   *   { kind: "custom", custom: { n: 1..999, unit: "d"|"w"|"m"|"y" } }
   *   { kind: "brush",  brush: [isoFrom, isoTo] }
   * Always anchored on the newest snapshot for preset/custom — so "Last 7d"
   * means the last 7 days of recorded data, not "today minus 7 days". */
  var PRESET_MS = {
    "7d":  7 * 86400000,
    "14d": 14 * 86400000,
    "30d": 30 * 86400000,
    "90d": 90 * 86400000
  };

  function unitDays(u) {
    return u === "y" ? 365 : u === "m" ? 30 : u === "w" ? 7 : 1;
  }
  function customMs(c) {
    if (!c || !c.n) return PRESET_MS["30d"];
    return Math.max(1, Math.min(999, c.n)) * unitDays(c.unit) * 86400000;
  }

  function sanitizeRange(r) {
    if (!r || typeof r !== "object") return { kind: "all" };
    if (r.kind === "preset" && PRESET_MS[r.preset]) {
      return { kind: "preset", preset: r.preset };
    }
    if (r.kind === "custom" && r.custom && typeof r.custom.n === "number") {
      var unit = ["d", "w", "m", "y"].indexOf(r.custom.unit) >= 0 ? r.custom.unit : "d";
      var n = Math.max(1, Math.min(999, Math.round(r.custom.n))) || 30;
      return { kind: "custom", custom: { n: n, unit: unit } };
    }
    if (r.kind === "brush" && Array.isArray(r.brush) && r.brush.length === 2) {
      var t0 = new Date(r.brush[0]), t1 = new Date(r.brush[1]);
      if (!isNaN(+t0) && !isNaN(+t1) && t1 > t0) {
        return { kind: "brush", brush: [t0.toISOString(), t1.toISOString()] };
      }
    }
    return { kind: "all" };
  }

  /* Returns whatever snapshots fall inside state.range — including 0 or 1.
   * Also returns `window: [from, to]` so the chart can use the requested
   * window as its x-domain regardless of how many points sit inside it
   * (otherwise an empty/single-point filter would silently lie about the
   * range the user asked for). Pure. */
  function applyRange(data) {
    if (!data || data.dates.length < 2) {
      return assign({}, data, { window: null });
    }
    var r = state.range || { kind: "all" };
    if (r.kind === "all") return assign({}, data, { window: null });

    var now = data.dates[data.dates.length - 1];
    var from, to = now;
    if (r.kind === "preset") {
      from = new Date(+now - PRESET_MS[r.preset]);
    } else if (r.kind === "custom") {
      from = new Date(+now - customMs(r.custom));
    } else if (r.kind === "brush") {
      from = new Date(r.brush[0]);
      to   = new Date(r.brush[1]);
    } else {
      return assign({}, data, { window: null });
    }

    /* Indices kept in [from, to]. Linear scan is fine — at the snapshot
     * counts we deal with (≤ a few hundred) bisection adds no value. */
    var keep = [];
    for (var i = 0; i < data.dates.length; i++) {
      if (data.dates[i] >= from && data.dates[i] <= to) keep.push(i);
    }

    return {
      dates:  keep.map(function (j) { return data.dates[j]; }),
      labels: keep.map(function (j) { return data.labels[j]; }),
      ts:     keep.map(function (j) { return data.ts[j]; }),
      total:  keep.map(function (j) { return data.total[j]; }),
      roots: data.roots.map(function (rt) {
        var values = keep.map(function (j) { return rt.values[j]; });
        var lv = null;
        for (var k = values.length - 1; k >= 0; k--) {
          if (values[k] != null) { lv = values[k]; break; }
        }
        return {
          path: rt.path,
          values: values,
          latest: lv != null ? lv : rt.latest
        };
      }),
      window: [from, to]
    };
  }

  /* Span-based time-axis formatter. Returns ONE format applied uniformly
   * to every tick (Highcharts / Plotly / Grafana convention) instead of
   * d3's default per-tick multi-scale formatter (which would still render
   * two same-day snapshots as identical "May 26 / May 26" labels). */
  function pickTimeFormat(domain) {
    var span = Math.abs(+domain[1] - +domain[0]);
    var DAY = 86400000;
    if (span < 1 * DAY)   return d3.timeFormat("%H:%M");        /* 02:00      */
    if (span < 7 * DAY)   return d3.timeFormat("%b %d %H:%M");  /* May 26 02:00 */
    if (span < 365 * DAY) return d3.timeFormat("%b %d");         /* May 26     */
    return d3.timeFormat("%b %Y");                               /* May 2026   */
  }

  /* tiny Object.assign shim (kept ES5-friendly to match the file's style) */
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  /* ---------- data shaping --------------------------------------------- */

  /* "2026-05-20_22-37" -> Date, or null if unparseable. */
  function tsToDate(ts) {
    var p = String(ts || "").split("_");
    if (p.length !== 2) return null;
    var d = new Date(p[0] + "T" + p[1].replace("-", ":"));
    return isNaN(d.getTime()) ? null : d;
  }

  /* Build series from the raw snapshot list. Output:
   *   {
   *     dates:  [Date, ...],
   *     labels: [String, ...],
   *     ts:     [String, ...],        // for #/scan/<ts> linking
   *     total:  [Number, ...],
   *     roots:  [ {path, values:[Number|null], latest:Number}, ... ]
   *   }
   * The roots[] array is sorted by latest size, descending. */
  function flatten(snapshots) {
    var rows = (snapshots || [])
      .map(function (s) {
        return {
          ts: s.ts,
          label: s.label || s.ts,
          date: tsToDate(s.ts),
          total: s.total ? Number(s.total.size_actual) : null,
          roots: Array.isArray(s.roots) ? s.roots : []
        };
      })
      .filter(function (r) {
        return r.date && r.total != null && !isNaN(r.total);
      })
      .sort(function (a, b) {
        return a.date - b.date;
      });

    if (rows.length < 2) return null;

    var dates = [], labels = [], ts = [], total = [];
    var byRoot = {};               /* path -> {values, latest} */
    rows.forEach(function (r, i) {
      dates.push(r.date);
      labels.push(r.label);
      ts.push(r.ts);
      total.push(r.total);
      var seenThisRow = {};
      r.roots.forEach(function (root) {
        var p = root.path;
        if (!p) return;
        var v = Number(root.size_actual);
        if (isNaN(v)) return;
        if (!byRoot[p]) {
          /* prefix-pad with nulls in one shot for any root first seen
           * after row 0 — cheaper than incremental while-push, especially
           * when a new root appears deep into a long history. */
          var pad = new Array(i).fill(null);
          byRoot[p] = { values: pad, latest: 0 };
        }
        byRoot[p].values.push(v);
        byRoot[p].latest = v;
        seenThisRow[p] = true;
      });
      /* pad with null only the roots that didn't appear in this row;
       * after this loop every byRoot[p].values has length === i + 1. */
      Object.keys(byRoot).forEach(function (p) {
        if (!seenThisRow[p]) byRoot[p].values.push(null);
      });
    });

    var roots = Object.keys(byRoot)
      .map(function (p) {
        return {
          path: p,
          values: byRoot[p].values,
          latest: byRoot[p].latest
        };
      })
      .sort(function (a, b) { return b.latest - a.latest; });

    return { dates: dates, labels: labels, ts: ts, total: total, roots: roots };
  }

  /* Stable palette assignment: a root keeps its colour across sessions.
   * Persisted in state.colors. New roots take the next free slot; once all
   * are used, cycle modulo PALETTE.length. */
  function assignColor(path) {
    if (state.colors[path] != null) return PALETTE[state.colors[path] % PALETTE.length];
    var used = {};
    Object.keys(state.colors).forEach(function (k) {
      used[state.colors[k]] = true;
    });
    var i = 0;
    while (used[i] && i < PALETTE.length) i++;
    if (i >= PALETTE.length) {
      /* all taken; pick the lowest-numbered slot (modular cycle) */
      i = Object.keys(state.colors).length % PALETTE.length;
    }
    state.colors[path] = i;
    saveState();
    return PALETTE[i];
  }

  /* ---------- DOM scaffold --------------------------------------------- */

  function buildScaffold(container) {
    container.innerHTML = "";
    container.style.position = "relative";

    /* segmented controls live in the section-head; the rest below. */
    var headSlot = document.querySelector("#trend-controls");
    if (headSlot) {
      headSlot.innerHTML = "";

      /* snapshot count — muted feedback, hidden when nothing is filtered */
      var snapCount = document.createElement("span");
      snapCount.id = "trend-snap-count";
      snapCount.className = "trend-snap-count mono";
      headSlot.appendChild(snapCount);

      /* range presets */
      headSlot.appendChild(seg("trend-rseg", [
        { v: "7d",  label: "7d",  hint: "last 7 days" },
        { v: "14d", label: "14d", hint: "last 14 days" },
        { v: "30d", label: "30d", hint: "last 30 days" },
        { v: "90d", label: "90d", hint: "last 90 days" },
        { v: "all", label: "All", hint: "every retained snapshot" }
      ], currentRangeKey(), function (v) {
        if (v === "all") state.range = { kind: "all" };
        else state.range = { kind: "preset", preset: v };
        saveState();
        syncRangeControls(container);
        drawAll(container);
      }));

      /* custom "Last [N] [unit]" input — independent from the preset seg */
      headSlot.appendChild(buildCustomInput(container));

      /* y-axis mode + view mode (existing controls) */
      headSlot.appendChild(seg("trend-yseg", [
        { v: "auto", label: "Auto-fit", hint: "y-axis zooms to data range" },
        { v: "zero", label: "Zero",     hint: "y-axis anchored at 0" }
      ], state.yMode, function (v) {
        state.yMode = v;
        saveState();
        drawAll(container);
      }));
      headSlot.appendChild(seg("trend-vseg", [
        { v: "total",   label: "Total",   hint: "single aggregate line" },
        { v: "lines",   label: "Lines",   hint: "one line per root directory" },
        { v: "stacked", label: "Stacked", hint: "stacked area by root" }
      ], state.viewMode, function (v) {
        state.viewMode = v;
        saveState();
        drawAll(container);
      }));
    }

    /* main chart slot */
    var main = document.createElement("div");
    main.className = "trend-main";
    main.id = "trend-main";
    container.appendChild(main);

    /* shared cursor-following tooltip for both charts */
    var tip = document.createElement("div");
    tip.className = "trend-tip";
    tip.id = "trend-tip";
    tip.style.display = "none";
    container.appendChild(tip);

    /* chip legend */
    var legend = document.createElement("div");
    legend.className = "trend-legend";
    legend.id = "trend-legend";
    container.appendChild(legend);

    /* delta panel — title says "since baseline" (not "since first scan")
     * because under a filter the baseline is the first visible snapshot. */
    var deltaSec = document.createElement("div");
    deltaSec.className = "trend-delta";
    deltaSec.id = "trend-delta";
    deltaSec.innerHTML =
      '<div class="trend-delta-head">' +
      '  <span class="trend-delta-title">Change since baseline</span>' +
      '  <span class="trend-delta-base mono" id="trend-delta-base"></span>' +
      "</div>" +
      '<div class="trend-delta-slot" id="trend-delta-slot"></div>';
    container.appendChild(deltaSec);
  }

  /* Maps the current state.range to the value of the preset segmented
   * control: "7d"/"14d"/"30d"/"90d"/"all" for matching presets and "all",
   * empty string when a custom/brush range is active (no preset highlighted). */
  function currentRangeKey() {
    var r = state.range || { kind: "all" };
    if (r.kind === "all") return "all";
    if (r.kind === "preset") return r.preset;
    return ""; /* custom / brush -> no preset highlighted */
  }

  /* Builds the "Last [N] [d|w|m|y]" inline input. */
  function buildCustomInput(container) {
    var wrap = document.createElement("div");
    wrap.className = "trend-custom";
    var cur = state.range && state.range.kind === "custom"
      ? state.range.custom
      : { n: 30, unit: "d" };

    wrap.innerHTML =
      '<span class="trend-custom-lab">Last</span>' +
      '<input type="number" min="1" max="999" step="1" inputmode="numeric"' +
      '       class="trend-custom-n mono" value="' + cur.n + '"' +
      '       aria-label="custom range value">' +
      '<select class="trend-custom-u" aria-label="custom range unit">' +
      '  <option value="d">d</option>' +
      '  <option value="w">w</option>' +
      '  <option value="m">m</option>' +
      '  <option value="y">y</option>' +
      "</select>";
    var nEl = wrap.querySelector(".trend-custom-n");
    var uEl = wrap.querySelector(".trend-custom-u");
    uEl.value = cur.unit;

    if (state.range && state.range.kind === "custom") {
      wrap.classList.add("is-active");
    }

    function commit() {
      var raw = parseInt(nEl.value, 10);
      /* Empty / non-numeric / zero / negative → revert to the previously
       * committed value instead of silently committing "Last 1 ...". */
      if (!Number.isFinite(raw) || raw < 1) { nEl.value = cur.n; return; }
      var n = Math.min(999, raw);
      cur = { n: n, unit: uEl.value };
      nEl.value = String(n);
      state.range = { kind: "custom", custom: cur };
      saveState();
      syncRangeControls(container);
      drawAll(container);
    }
    nEl.addEventListener("change", commit);
    nEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); nEl.blur(); }
    });
    uEl.addEventListener("change", commit);

    return wrap;
  }

  /* Keep the range chips + custom input in sync with state.range — called
   * after a brush selection or programmatic range change. */
  function syncRangeControls(container) {
    var key = currentRangeKey();
    /* preset chips */
    var rseg = document.querySelector(".trend-rseg");
    if (rseg) {
      Array.prototype.forEach.call(rseg.children, function (b) {
        var on = b.dataset.value === key;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on ? "true" : "false");
      });
    }
    /* custom input highlight */
    var custom = document.querySelector(".trend-custom");
    if (custom) {
      custom.classList.toggle("is-active",
        state.range && state.range.kind === "custom");
      if (state.range && state.range.kind === "custom") {
        var nEl = custom.querySelector(".trend-custom-n");
        var uEl = custom.querySelector(".trend-custom-u");
        if (nEl) nEl.value = String(state.range.custom.n);
        if (uEl) uEl.value = state.range.custom.unit;
      }
    }
  }

  /* Build a small segmented control. opts = [{v, label, hint}, ...] */
  function seg(cls, opts, active, onPick) {
    var wrap = document.createElement("div");
    wrap.className = "trend-seg " + cls;
    wrap.setAttribute("role", "tablist");
    opts.forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "trend-seg-btn" + (o.v === active ? " is-active" : "");
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", o.v === active ? "true" : "false");
      b.setAttribute("title", o.hint);
      b.dataset.value = o.v;
      b.textContent = o.label;
      b.addEventListener("click", function () {
        /* sync sibling button state before delegating — the click handler
         * triggers a chart re-render but not a controls rebuild, so the
         * buttons would otherwise keep their initial highlight. */
        Array.prototype.forEach.call(wrap.children, function (sib) {
          var on = sib.dataset.value === o.v;
          sib.classList.toggle("is-active", on);
          sib.setAttribute("aria-selected", on ? "true" : "false");
        });
        onPick(o.v);
      });
      b.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var btns = Array.prototype.slice.call(wrap.children);
        var i = btns.indexOf(b);
        var j = (i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
        btns[j].focus();
        btns[j].click();
      });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /* ---------- main chart ----------------------------------------------- */

  /* Shared layout for both SVGs so date columns line up. */
  var W = 960,
      m = { top: 18, right: 22, bottom: 30, left: 72 };
  var H_MAIN = 240, H_DELTA = 130;

  function drawMain(container, data) {
    var slot = container.querySelector("#trend-main");
    slot.querySelectorAll("svg").forEach(function (n) { n.remove(); });
    /* any prior empty-state overlay */
    var prevEmpty = slot.querySelector(".trend-empty");
    if (prevEmpty) prevEmpty.remove();

    var iw = W - m.left - m.right,
        ih = H_MAIN - m.top - m.bottom;

    /* If the filter has reported its window, anchor x to that window — so
     * the axis reflects what the user asked for even when fewer than 2
     * snapshots fall inside it. Otherwise fall back to the data extent. */
    var xDomain = data.window || d3.extent(data.dates);
    if (!xDomain || xDomain[0] == null || xDomain[1] == null) {
      /* nothing usable — shouldn't normally happen */
      xDomain = [new Date(Date.now() - 86400000), new Date()];
    }
    var x = d3.scaleTime().domain(xDomain).range([0, iw]);

    /* Sparse-filter branch — render a clean message panel (no chart frame)
     * when the filter yields fewer than 2 snapshots. The chart frame at
     * sparse counts reads as broken; a centered message + widen CTA is
     * cleaner. The Δ panel below also hides itself for the same reason. */
    if (data.dates.length < 2) {
      drawSparsePanel(slot, container, data.dates.length);
      return;
    }

    var visible = data.roots.filter(function (r) {
      return state.hiddenRoots.indexOf(r.path) < 0;
    });

    /* y domain depends on mode + view */
    var domain;
    if (state.viewMode === "stacked") {
      var sumPerIdx = data.dates.map(function (_, i) {
        return visible.reduce(function (s, r) {
          return s + (r.values[i] || 0);
        }, 0);
      });
      var hiS = d3.max(sumPerIdx) || 1;
      domain = [0, hiS * 1.08];
    } else {
      var pool = state.viewMode === "total"
        ? data.total
        : visible.reduce(function (acc, r) {
            r.values.forEach(function (v) { if (v != null) acc.push(v); });
            return acc;
          }, []);
      if (!pool.length) pool = [0];
      var lo = d3.min(pool), hi = d3.max(pool);
      if (state.yMode === "zero") {
        domain = [0, (hi || 1) * 1.12];
      } else {
        var span = hi - lo;
        var pad = Math.max(span * 0.08, hi * 0.005);
        if (span === 0) pad = Math.max(hi * 0.001, 1);
        domain = [Math.max(0, lo - pad), hi + pad];
      }
    }
    /* d3's tick *count* is only a hint, and bare .nice() uses a different
     * count internally — that's why a zero-anchored ~91 T domain could
     * produce just 3 ticks. Passing the SAME hint to both nice() and
     * ticks() keeps their step computations in sync and reliably yields
     * 5–7 ticks across both wide and narrow domains. */
    var Y_HINT = 6;
    var y = d3.scaleLinear().domain(domain).nice(Y_HINT).range([ih, 0]);

    var svg = d3.select(slot).append("svg")
      .attr("class", "trend-svg")
      .attr("viewBox", [0, 0, W, H_MAIN])
      .attr("preserveAspectRatio", "xMidYMid meet");
    var g = svg.append("g").attr("transform", "translate(" + m.left + "," + m.top + ")");

    /* gridlines */
    var yticks = y.ticks(Y_HINT);
    /* derive step + axis-max for adaptive precision: narrow domains like
     * [91.04T, 91.21T] would all read "91.2T" at 1-decimal precision —
     * humanBytesAtStep picks just enough decimals to distinguish ticks. */
    var yStep = yticks.length > 1
      ? yticks[1] - yticks[0]
      : (yticks[0] || 1);
    var yRef = yticks.length
      ? Math.max.apply(null, yticks.map(function (d) { return Math.abs(d); }))
      : 1;
    g.selectAll("line.trend-grid").data(yticks).enter().append("line")
      .attr("class", "trend-grid")
      .attr("x1", 0).attr("x2", iw)
      .attr("y1", function (d) { return y(d); })
      .attr("y2", function (d) { return y(d); });

    /* y labels — anchor the lowest one when zoomed */
    var loDom = domain[0];
    g.selectAll("text.trend-ylab").data(yticks).enter().append("text")
      .attr("class", function (d) {
        return "trend-ylab" + (state.yMode === "auto" && state.viewMode !== "stacked" && d === yticks[0] ? " trend-ylab--anchor" : "");
      })
      .attr("x", -12)
      .attr("y", function (d) { return y(d); })
      .attr("dy", "0.32em")
      .attr("text-anchor", "end")
      .text(function (d) { return U.humanBytesAtStep(d, yStep, yRef); });

    /* dashed baseline marker when the axis is non-zero */
    if (state.yMode === "auto" && state.viewMode !== "stacked" && loDom > 0) {
      g.append("line").attr("class", "trend-baseline")
        .attr("x1", 0).attr("x2", iw)
        .attr("y1", ih).attr("y2", ih);
    }

    /* x labels — span-based format keeps adjacent ticks distinguishable
     * even when two snapshots are on the same calendar day. */
    var xFmt = pickTimeFormat(x.domain());
    var xticks = x.ticks(Math.min(6, Math.max(2, data.dates.length)));
    g.selectAll("text.trend-xlab").data(xticks).enter().append("text")
      .attr("class", "trend-xlab")
      .attr("x", function (d) { return x(d); })
      .attr("y", ih + 21)
      .attr("text-anchor", "middle")
      .text(xFmt);

    /* ---- view-specific drawing ---- */
    if (state.viewMode === "total") {
      drawTotal(g, data, x, y, iw, ih, container);
    } else if (state.viewMode === "lines") {
      drawLines(g, data, visible, x, y, iw, ih, container);
    } else {
      drawStacked(g, data, visible, x, y, iw, ih, container);
    }

    /* brush layer — must sit ABOVE the data so it captures all pointer
     * events on the plot area. The end handler distinguishes click vs drag
     * to preserve the existing "click opens that scan" behaviour. */
    attachBrush(g, data, x, iw, ih, container);

    /* counter-scale axis labels so they stay at their px size regardless of
     * the rendered chart width (the viewBox would otherwise magnify them). */
    function fitSvg(node, viewBoxW) {
      var w = node.getBoundingClientRect().width;
      node.style.setProperty("--trend-k", w > 0 ? String(viewBoxW / w) : "1");
    }
    function fitText() {
      fitSvg(svg.node(), W);
      /* Initialize the delta svg in the same tick — drawDelta has no
       * ResizeObserver of its own, so without this its labels render at
       * the viewBox scale until the first resize event fires. */
      var deltaSvg = container.querySelector("#trend-delta-slot svg");
      if (deltaSvg) fitSvg(deltaSvg, W);
    }
    fitText();
    if (resizeObs) resizeObs.disconnect();
    resizeObs = new ResizeObserver(fitText);
    resizeObs.observe(svg.node());
  }

  /* ---- sparse-filter render mode --------------------------------------- *
   * When the filter yields 0 or 1 snapshots, the chart frame is more
   * confusing than helpful (huge empty axes with a single floating dot,
   * y-range padded around one value, x-axis spanning a window with no
   * line in it). Render a clean centered message panel instead — no SVG,
   * no axes, no dot. The "Show last 7 d" CTA is the documented escape
   * hatch. The Δ panel hides itself when the slice has < 2 points.
   * --------------------------------------------------------------------- */
  function drawSparsePanel(slot, container, filteredCount) {
    slot.querySelectorAll("svg").forEach(function (n) { n.remove(); });
    slot.querySelectorAll(".trend-empty").forEach(function (n) { n.remove(); });

    var msg = filteredCount === 0
      ? "No snapshots in this range."
      : "Only 1 snapshot in this range.";

    var panel = document.createElement("div");
    panel.className = "trend-empty";
    panel.innerHTML =
      '<div class="trend-empty-msg">' + U.esc(msg) + "</div>" +
      '<div class="trend-empty-sub">Widen the filter for a trend.</div>' +
      '<a href="#" class="trend-empty-cta">Show last 7 d →</a>';
    panel.querySelector(".trend-empty-cta").addEventListener("click", function (e) {
      e.preventDefault();
      state.range = { kind: "preset", preset: "7d" };
      saveState();
      syncRangeControls(container);
      drawAll(container);
    });
    slot.appendChild(panel);
  }

  /* ---- total view: one accent line + clickable dots ---- */
  function drawTotal(g, data, x, y, iw, ih, container) {
    var dateMs = data.dateMs;
    var pts = data.dates.map(function (d, i) {
      return { date: d, size: data.total[i], i: i };
    });

    g.append("path").datum(pts).attr("class", "trend-area")
      .attr("d", d3.area()
        .x(function (p) { return x(p.date); })
        .y0(ih)
        .y1(function (p) { return y(p.size); })
        .curve(d3.curveMonotoneX));

    g.append("path").datum(pts).attr("class", "trend-line")
      .attr("d", d3.line()
        .x(function (p) { return x(p.date); })
        .y(function (p) { return y(p.size); })
        .curve(d3.curveMonotoneX));

    /* Dots are now purely visual — interaction (click/hover) is delegated
     * to the unified brush layer added later in drawMain. This keeps the
     * click semantics consistent across all three view modes. */
    var dots = g.selectAll("g.trend-dot").data(pts).enter().append("g")
      .attr("class", "trend-dot")
      .attr("transform", function (p) { return "translate(" + x(p.date) + "," + y(p.size) + ")"; });
    dots.append("circle").attr("class", "trend-pt").attr("r", 4);

    /* Hover callback consumed by attachBrush — renders the total-mode
     * tooltip (with delta-to-previous) at the nearest x. */
    var tip = container.querySelector("#trend-tip");
    container.__hoverFn = function (mx, event) {
      var i = d3.bisectCenter(dateMs, +x.invert(mx));
      var p = pts[i];
      var prev = i > 0 ? data.total[i - 1] : null;
      var dHtml = "";
      if (prev != null) {
        var d = p.size - prev;
        if (d !== 0) {
          dHtml = ' <span class="trend-tip-d ' + (d > 0 ? "up" : "down") + '">' +
            (d > 0 ? "▲ " : "▼ ") + U.esc(U.humanBytes(Math.abs(d))) + "</span>";
        }
      }
      tip.innerHTML =
        '<div class="trend-tip-lab">' + U.esc(data.labels[i]) + "</div>" +
        '<div class="trend-tip-val mono">' + U.esc(U.humanBytes(p.size)) + dHtml + "</div>" +
        '<div class="trend-tip-hint">click to open · drag to zoom</div>';
      tip.style.display = "block";
      positionTip(container, tip, event);
    };
    container.__hoverLeaveFn = function () { tip.style.display = "none"; };
  }

  /* ---- lines view: per-root + faint total overlay + crosshair ---- */
  function drawLines(g, data, visible, x, y, iw, ih, container) {
    var line = d3.line()
      .defined(function (d) { return d.v != null; })
      .x(function (d) { return x(d.date); })
      .y(function (d) { return y(d.v); })
      .curve(d3.curveMonotoneX);

    /* faint total overlay (dashed, dim) so users always see the aggregate */
    var totalPts = data.dates.map(function (d, i) { return { date: d, v: data.total[i] }; });
    g.append("path").datum(totalPts).attr("class", "trend-total-ghost").attr("d", line);

    /* per-root series */
    var series = g.append("g").attr("class", "trend-series-g");
    visible.forEach(function (r) {
      var pts = data.dates.map(function (d, i) { return { date: d, v: r.values[i] }; });
      series.append("path")
        .datum(pts)
        .attr("class", "trend-series")
        .attr("data-path", r.path)
        .attr("stroke", assignColor(r.path))
        .attr("d", line);
    });

    /* crosshair overlay + per-series circles, populated on pointermove */
    crosshair(g, data, visible, x, y, iw, ih, container, false);
  }

  /* ---- stacked area view ---- */
  function drawStacked(g, data, visible, x, y, iw, ih, container) {
    /* Build wide-format rows for d3.stack. Missing values -> 0 (stack math
     * requires real numbers; the legend chip still shows the root as visible). */
    var keys = visible.map(function (r) { return r.path; });
    var rows = data.dates.map(function (d, i) {
      var obj = { _date: d };
      visible.forEach(function (r) { obj[r.path] = r.values[i] || 0; });
      return obj;
    });
    var stacked = d3.stack().keys(keys).order(d3.stackOrderInsideOut)(rows);

    var areaGen = d3.area()
      .x(function (d) { return x(d.data._date); })
      .y0(function (d) { return y(d[0]); })
      .y1(function (d) { return y(d[1]); })
      .curve(d3.curveMonotoneX);

    g.selectAll("path.trend-layer").data(stacked).enter().append("path")
      .attr("class", "trend-layer")
      .attr("data-path", function (s) { return s.key; })
      .attr("fill", function (s) { return assignColor(s.key); })
      .attr("d", areaGen);

    /* Top-edge line per layer — matches the Total view's "subtle fill +
     * solid line carries the shape" idiom, so Stacked stops looking like
     * dense solid blocks and slots into the dashboard's visual language. */
    var edgeGen = d3.line()
      .x(function (d) { return x(d.data._date); })
      .y(function (d) { return y(d[1]); })
      .curve(d3.curveMonotoneX);
    g.selectAll("path.trend-layer-edge").data(stacked).enter().append("path")
      .attr("class", "trend-layer-edge")
      .attr("data-path", function (s) { return s.key; })
      .attr("stroke", function (s) { return assignColor(s.key); })
      .attr("d", edgeGen);

    crosshair(g, data, visible, x, y, iw, ih, container, true);
  }

  /* ---- crosshair shared by lines + stacked ----
   * Sets up the rule + marks groups and exposes a hover callback consumed
   * by attachBrush. All pointer events arrive via the brush layer. */
  function crosshair(g, data, visible, x, y, iw, ih, container, isStacked) {
    var rule = g.append("line").attr("class", "trend-crosshair")
      .attr("y1", 0).attr("y2", ih).style("display", "none");
    var marks = g.append("g").attr("class", "trend-marks");
    var tip = container.querySelector("#trend-tip");
    var dateMs = data.dateMs;

    container.__hoverFn = function (mx, event) {
      var i = d3.bisectCenter(dateMs, +x.invert(mx));
      rule.attr("x1", x(data.dates[i])).attr("x2", x(data.dates[i]))
          .style("display", null);

      /* mark dots at hovered x */
      var hits = visible
        .map(function (r) { return { path: r.path, v: r.values[i] }; })
        .filter(function (h) { return h.v != null; })
        .sort(function (a, b) { return b.v - a.v; });

      marks.selectAll("*").remove();
      if (!isStacked) {
        hits.forEach(function (h) {
          marks.append("circle")
            .attr("class", "trend-pt-multi")
            .attr("r", 3.5)
            .attr("cx", x(data.dates[i]))
            .attr("cy", y(h.v))
            .attr("fill", assignColor(h.path));
        });
      }

      var rowsHtml = hits.slice(0, 8).map(function (h) {
        return '<div class="trend-tip-row">' +
          '<span class="trend-tip-sw" style="background:' + assignColor(h.path) + '"></span>' +
          '<span class="trend-tip-path">' + U.esc(U.shortPath(h.path, 32)) + '</span>' +
          '<span class="trend-tip-sz mono">' + U.esc(U.humanBytes(h.v)) + '</span>' +
          '</div>';
      }).join("");
      var sumVisible = hits.reduce(function (s, h) { return s + h.v; }, 0);
      tip.innerHTML =
        '<div class="trend-tip-lab">' + U.esc(data.labels[i]) + "</div>" +
        rowsHtml +
        '<div class="trend-tip-row trend-tip-sum">' +
          '<span class="trend-tip-sw" style="background:transparent;border:1px solid var(--accent)"></span>' +
          '<span class="trend-tip-path">' + (isStacked ? "Stack total" : "Visible total") + '</span>' +
          '<span class="trend-tip-sz mono">' + U.esc(U.humanBytes(sumVisible)) + '</span>' +
        '</div>';
      tip.style.display = "block";
      positionTip(container, tip, event);
    };
    container.__hoverLeaveFn = function () {
      rule.style("display", "none");
      marks.selectAll("*").remove();
      tip.style.display = "none";
    };
  }

  function positionTip(container, tip, e) {
    var r = container.getBoundingClientRect();
    var tx = e.clientX - r.left + 16;
    var ty = e.clientY - r.top + 16;
    var tw = tip.offsetWidth || 240;
    if (tx + tw + 8 > r.width) tx = e.clientX - r.left - tw - 8;
    tip.style.left = Math.max(4, tx) + "px";
    tip.style.top = Math.max(4, ty) + "px";
  }

  /* ---------- brush layer ---------------------------------------------- *
   * One transparent rect on top of the data captures all pointer events
   * on the plot area and dispatches them to:
   *   - hover (no mousedown) → __hoverFn (view-specific tooltip render)
   *   - click (mousedown + up, no significant drag) → open nearest scan
   *   - drag (mousedown + move > threshold + up) → set brush range
   *   - dblclick → reset to "All" (only if a brush/custom range is active)
   * This unifies interaction across total / lines / stacked view modes. */
  var DRAG_THRESHOLD = 4; /* px before a click becomes a drag */

  function attachBrush(g, data, x, iw, ih, container) {
    var brushG = g.append("g").attr("class", "trend-brush");
    var dateMs = data.dateMs;

    /* selection rect — drawn during drag, hidden otherwise */
    var sel = brushG.append("rect")
      .attr("class", "trend-brush-sel")
      .attr("y", 0).attr("height", ih)
      .attr("x", 0).attr("width", 0)
      .style("display", "none")
      .style("pointer-events", "none");

    /* the actual interaction surface — sits above everything */
    var hot = brushG.append("rect")
      .attr("class", "trend-brush-hot")
      .attr("width", iw).attr("height", ih)
      .style("fill", "none")
      .style("pointer-events", "all");

    var down = null;       /* [x,y] at mousedown, null when idle */
    var dragging = false;
    var hotNode = hot.node();
    /* Single-click navigation lives at module scope so a redraw can clear
     * a still-pending timer (otherwise a click followed by a view/range
     * change inside CLICK_DEFER_MS would navigate to the old snapshot). */
    var CLICK_DEFER_MS = 220;

    /* d3.pointer walks getScreenCTM, so it returns user-space coords inside
     * the inner g (where the rect lives at (0,0)..(iw,ih)) — exactly what
     * the x scale expects without further conversion. */
    function localPointer(event) {
      return d3.pointer(event, hotNode);
    }

    function nearestIndex(mx) {
      return d3.bisectCenter(dateMs, +x.invert(mx));
    }

    hot.on("pointermove", function (event) {
      var p = localPointer(event);
      if (down) {
        if (!dragging && Math.abs(p[0] - down[0]) > DRAG_THRESHOLD) {
          dragging = true;
          if (container.__hoverLeaveFn) container.__hoverLeaveFn();
        }
        if (dragging) {
          var lo = Math.max(0, Math.min(down[0], p[0]));
          var hi = Math.min(iw, Math.max(down[0], p[0]));
          sel.attr("x", lo).attr("width", hi - lo).style("display", null);
        }
      } else if (container.__hoverFn) {
        container.__hoverFn(p[0], event);
      }
    });

    hot.on("pointerdown", function (event) {
      if (event.button !== 0) return;
      /* second click of a dblclick — cancel the pending nav so the
       * dblclick handler can reset the range instead. */
      if (pendingClickTimer) { clearTimeout(pendingClickTimer); pendingClickTimer = null; }
      down = localPointer(event);
      dragging = false;
      try { hotNode.setPointerCapture(event.pointerId); } catch (_) {}
    });

    hot.on("pointerup", function (event) {
      if (!down) return;
      try { hotNode.releasePointerCapture(event.pointerId); } catch (_) {}
      var p = localPointer(event);
      if (dragging) {
        var lo = Math.max(0, Math.min(down[0], p[0]));
        var hi = Math.min(iw, Math.max(down[0], p[0]));
        sel.style("display", "none");
        if (hi - lo >= DRAG_THRESHOLD) {
          var t0 = x.invert(lo), t1 = x.invert(hi);
          state.range = {
            kind: "brush",
            brush: [t0.toISOString(), t1.toISOString()]
          };
          saveState();
          syncRangeControls(container);
          drawAll(container);
        }
      } else {
        /* click without drag → open nearest scan, deferred so a follow-up
         * pointerdown (the start of a dblclick) can cancel us. */
        var ts = data.ts[nearestIndex(p[0])];
        if (pendingClickTimer) clearTimeout(pendingClickTimer);
        pendingClickTimer = setTimeout(function () {
          pendingClickTimer = null;
          global.location.hash = "#/scan/" + encodeURIComponent(ts);
        }, CLICK_DEFER_MS);
      }
      down = null;
      dragging = false;
    });

    hot.on("pointerleave", function () {
      if (down) return; /* keep selection visible while dragging out */
      if (container.__hoverLeaveFn) container.__hoverLeaveFn();
    });
    hot.on("pointercancel", function () {
      sel.style("display", "none");
      down = null;
      dragging = false;
    });

    hot.on("dblclick", function (event) {
      event.preventDefault();
      if (pendingClickTimer) { clearTimeout(pendingClickTimer); pendingClickTimer = null; }
      if (state.range && (state.range.kind === "brush" || state.range.kind === "custom")) {
        state.range = { kind: "all" };
        saveState();
        syncRangeControls(container);
        drawAll(container);
      }
    });
  }

  /* ---------- chip legend ---------------------------------------------- */

  function drawLegend(container, data) {
    var leg = container.querySelector("#trend-legend");
    leg.innerHTML = "";
    if (state.viewMode === "total") {
      leg.hidden = true;
      return;
    }
    leg.hidden = false;

    data.roots.forEach(function (r) {
      var hidden = state.hiddenRoots.indexOf(r.path) >= 0;
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "trend-chip" + (hidden ? " is-hidden" : "");
      chip.setAttribute("aria-pressed", hidden ? "false" : "true");
      chip.title = r.path;
      chip.innerHTML =
        '<span class="trend-chip-dot" style="background:' + assignColor(r.path) + '"></span>' +
        '<span class="trend-chip-path">' + U.esc(U.shortPath(r.path, 36)) + '</span>' +
        '<span class="trend-chip-size mono">' + U.esc(U.humanBytes(r.latest)) + '</span>';
      chip.addEventListener("click", function () {
        var idx = state.hiddenRoots.indexOf(r.path);
        if (idx >= 0) state.hiddenRoots.splice(idx, 1);
        else state.hiddenRoots.push(r.path);
        saveState();
        drawAll(container);
      });
      chip.addEventListener("mouseenter", function () {
        if (state.viewMode === "lines") {
          container.querySelectorAll(".trend-series").forEach(function (n) {
            n.classList.toggle("is-dim", n.dataset.path !== r.path);
          });
        } else if (state.viewMode === "stacked") {
          container.querySelectorAll(".trend-layer, .trend-layer-edge").forEach(function (n) {
            n.classList.toggle("is-dim", n.dataset.path !== r.path);
          });
        }
      });
      chip.addEventListener("mouseleave", function () {
        container.querySelectorAll(".trend-series, .trend-layer, .trend-layer-edge").forEach(function (n) {
          n.classList.remove("is-dim");
        });
      });
      leg.appendChild(chip);
    });

    if (state.hiddenRoots.length) {
      var reset = document.createElement("button");
      reset.type = "button";
      reset.className = "trend-chip-reset";
      reset.textContent = "Show all ⟳";
      reset.addEventListener("click", function () {
        state.hiddenRoots = [];
        saveState();
        drawAll(container);
      });
      leg.appendChild(reset);
    }
  }

  /* ---------- Δ panel -------------------------------------------------- */

  function drawDelta(container, data) {
    var slot = container.querySelector("#trend-delta-slot");
    slot.innerHTML = "";
    var baseLabel = container.querySelector("#trend-delta-base");
    var deltaSec  = container.querySelector("#trend-delta");

    /* Δ requires ≥ 2 points to compute "since baseline" — hide the whole
     * sub-panel under sparse filters; the snap-count CTA tells the user
     * how to widen if they care. */
    if (!data || data.dates.length < 2) {
      if (deltaSec) deltaSec.hidden = true;
      if (baseLabel) baseLabel.textContent = "";
      return;
    }
    if (deltaSec) deltaSec.hidden = false;

    /* what series to delta against: total if in total mode, else the sum of
     * currently visible roots. */
    var series;
    if (state.viewMode === "total") {
      series = data.total.slice();
    } else {
      var visible = data.roots.filter(function (r) {
        return state.hiddenRoots.indexOf(r.path) < 0;
      });
      series = data.dates.map(function (_, i) {
        return visible.reduce(function (s, r) { return s + (r.values[i] || 0); }, 0);
      });
    }
    var base = series[0];
    var deltas = series.map(function (v) { return v - base; });

    /* baseline label — use the same span-based format as the x-axis so a
     * sub-daily window shows time (since the day is unambiguous from the
     * header), and a multi-day window shows date. */
    var baselineFmt = pickTimeFormat([
      data.dates[0],
      data.dates[data.dates.length - 1]
    ]);
    baseLabel.textContent =
      "baseline " + U.humanBytes(base) + " · " +
      baselineFmt(data.dates[0]);

    var iw = W - m.left - m.right,
        ih = H_DELTA - m.top - m.bottom;
    /* mirror drawMain's x-domain expression so the two panels line up on
     * the same time range — without this they disagree under any windowed
     * filter where the data covers only part of the requested span. */
    var xDomain = data.window || d3.extent(data.dates);
    var x = d3.scaleTime().domain(xDomain).range([0, iw]);

    var lo = Math.min(0, d3.min(deltas));
    var hi = Math.max(0, d3.max(deltas));
    if (lo === hi) hi = (lo || 0) + 1;
    var pad = (hi - lo) * 0.12;
    /* see drawMain: same hint to nice() and ticks() keeps their steps in sync. */
    var DY_HINT = 5;
    var y = d3.scaleLinear()
      .domain([lo - pad, hi + pad])
      .nice(DY_HINT)
      .range([ih, 0]);

    var svg = d3.select(slot).append("svg")
      .attr("class", "trend-svg trend-delta-svg")
      .attr("viewBox", [0, 0, W, H_DELTA])
      .attr("preserveAspectRatio", "xMidYMid meet");
    var g = svg.append("g").attr("transform", "translate(" + m.left + "," + m.top + ")");

    /* gridlines + y labels (signed) */
    var yticks = y.ticks(DY_HINT);
    var dyStep = yticks.length > 1
      ? yticks[1] - yticks[0]
      : (Math.abs(yticks[0]) || 1);
    var dyRef = yticks.length
      ? Math.max.apply(null, yticks.map(function (d) { return Math.abs(d); })) || 1
      : 1;
    g.selectAll("line.trend-grid").data(yticks).enter().append("line")
      .attr("class", "trend-grid")
      .attr("x1", 0).attr("x2", iw)
      .attr("y1", function (d) { return y(d); })
      .attr("y2", function (d) { return y(d); });
    g.selectAll("text.trend-ylab").data(yticks).enter().append("text")
      .attr("class", "trend-ylab")
      .attr("x", -12)
      .attr("y", function (d) { return y(d); })
      .attr("dy", "0.32em")
      .attr("text-anchor", "end")
      .text(function (d) {
        if (d === 0) return "0";
        return (d > 0 ? "+" : "−") + U.humanBytesAtStep(Math.abs(d), dyStep, dyRef);
      });

    var xFmt = pickTimeFormat(x.domain());
    var xticks = x.ticks(Math.min(6, Math.max(2, data.dates.length)));
    g.selectAll("text.trend-xlab").data(xticks).enter().append("text")
      .attr("class", "trend-xlab")
      .attr("x", function (d) { return x(d); })
      .attr("y", ih + 21)
      .attr("text-anchor", "middle")
      .text(xFmt);

    /* clip rects to split positive (green) from negative (red) areas */
    var defs = svg.append("defs");
    defs.append("clipPath").attr("id", "trend-clip-pos")
      .append("rect").attr("x", 0).attr("y", 0).attr("width", iw).attr("height", y(0));
    defs.append("clipPath").attr("id", "trend-clip-neg")
      .append("rect").attr("x", 0).attr("y", y(0)).attr("width", iw).attr("height", Math.max(0, ih - y(0)));

    var deltaPts = data.dates.map(function (d, i) { return { date: d, v: deltas[i] }; });
    var areaGen = d3.area()
      .x(function (p) { return x(p.date); })
      .y0(y(0))
      .y1(function (p) { return y(p.v); })
      .curve(d3.curveMonotoneX);

    g.append("path").datum(deltaPts).attr("class", "trend-delta-area pos")
      .attr("clip-path", "url(#trend-clip-pos)")
      .attr("d", areaGen);
    g.append("path").datum(deltaPts).attr("class", "trend-delta-area neg")
      .attr("clip-path", "url(#trend-clip-neg)")
      .attr("d", areaGen);

    /* zero baseline (always visible) */
    g.append("line").attr("class", "trend-zero")
      .attr("x1", 0).attr("x2", iw)
      .attr("y1", y(0)).attr("y2", y(0));

    /* line on top */
    g.append("path").datum(deltaPts).attr("class", "trend-delta-line")
      .attr("d", d3.line()
        .x(function (p) { return x(p.date); })
        .y(function (p) { return y(p.v); })
        .curve(d3.curveMonotoneX));

    /* dots — clickable */
    var tip = container.querySelector("#trend-tip");
    var dots = g.selectAll("g.trend-dot").data(deltaPts).enter().append("g")
      .attr("class", "trend-dot")
      .attr("transform", function (p) { return "translate(" + x(p.date) + "," + y(p.v) + ")"; })
      .style("cursor", "pointer")
      .attr("tabindex", 0)
      .attr("role", "link")
      .attr("aria-label", function (p, i) {
        var d = p.v;
        return data.labels[i] + " — " +
          (d === 0 ? "no change" : (d > 0 ? "+" : "−") + U.humanBytes(Math.abs(d))) +
          " since first scan. Open scan.";
      });
    dots.append("circle").attr("class", "trend-hit").attr("r", 14);
    dots.append("circle").attr("class", "trend-pt").attr("r", 3.5)
      .attr("fill", function (p) {
        return p.v > 0 ? "var(--green)" : p.v < 0 ? "var(--red)" : "var(--dim)";
      });

    function go(i) { global.location.hash = "#/scan/" + encodeURIComponent(data.ts[i]); }
    dots.on("click", function (e, p) { go(deltaPts.indexOf(p)); });
    dots.on("keydown", function (e, p) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go(deltaPts.indexOf(p));
      }
    });
    dots.on("mouseenter focus", function (e, p) {
      var i = deltaPts.indexOf(p);
      var d = p.v;
      var sign = d > 0 ? '<span class="trend-tip-d up">▲ +' :
                 d < 0 ? '<span class="trend-tip-d down">▼ −' :
                         '<span class="trend-tip-d">±';
      tip.innerHTML =
        '<div class="trend-tip-lab">' + U.esc(data.labels[i]) + "</div>" +
        '<div class="trend-tip-val mono">' +
          sign + U.esc(U.humanBytes(Math.abs(d))) + "</span>" +
          ' <span class="trend-tip-since">since first</span>' +
        "</div>" +
        '<div class="trend-tip-hint">absolute: ' + U.esc(U.humanBytes(series[i])) + ' · click to open</div>';
      tip.style.display = "block";
    })
    .on("mousemove", function (e) { positionTip(container, tip, e); })
    .on("mouseleave blur", function () { tip.style.display = "none"; });
  }

  /* ---------- orchestration ------------------------------------------- */

  function drawAll(container) {
    /* read raw data, then narrow to the active range — the rest of the
     * pipeline (main, legend, delta) sees only the filtered slice and
     * therefore the Δ baseline tracks the *visible* first point. */
    var raw = container.__trendsData;
    if (!raw) return;
    /* Cancel any pending click→navigate from the previous draw; the user
     * just toggled a control (range / view / metric), so completing the
     * navigation would land on a now-stale snapshot. */
    if (pendingClickTimer) { clearTimeout(pendingClickTimer); pendingClickTimer = null; }
    var data = applyRange(raw);
    /* dateMs is consumed by bisectCenter in drawTotal / crosshair / attachBrush
     * / drawDelta -- cache the numeric coercion once per draw rather than
     * rebuilding the array in each closure. */
    data.dateMs = data.dates.map(function (d) { return +d; });
    updateSnapCount(container, raw, data);
    drawMain(container, data);
    drawLegend(container, data);
    drawDelta(container, data);
  }

  function updateSnapCount(container, raw, filtered) {
    var el = container.querySelector("#trend-snap-count");
    if (!el) return;
    el.classList.remove("is-active", "is-warn");
    /* clear any previously-installed CTA listener; safe even if absent */
    var oldCta = el.querySelector(".trend-snap-cta");
    if (oldCta) oldCta.remove();

    var fLen = filtered.dates.length;
    var rLen = raw.dates.length;

    if (fLen === rLen) {
      el.textContent = rLen + " snapshots";
      return;
    }

    /* sparse / empty — show the count + a one-click "widen" CTA. The link
     * jumps to the 7d preset; if that's still too narrow the user can pick
     * something else from the chips. */
    el.textContent = fLen + " of " + rLen + " in range";
    el.classList.add(fLen < 2 ? "is-warn" : "is-active");
    if (fLen < 2) {
      var sep = document.createTextNode(" · ");
      el.appendChild(sep);
      var a = document.createElement("a");
      a.href = "#";
      a.className = "trend-snap-cta";
      a.textContent = "Show last 7d →";
      a.addEventListener("click", function (e) {
        e.preventDefault();
        state.range = { kind: "preset", preset: "7d" };
        saveState();
        syncRangeControls(container);
        drawAll(container);
      });
      el.appendChild(a);
    }
  }

  function render(container, snapshots) {
    if (!container) return false;

    /* skip re-render if the snapshot list is unchanged. Sample every ts +
     * total so a re-scan of an existing ts (same key, new bytes) or a
     * mid-list mutation still busts the cache — the previous "first + last
     * + length" signature missed those and left the chart stale. */
    var snaps = (snapshots || []).filter(function (s) { return s.ts; });
    var sig = snaps.length + "|" + snaps.map(function (s) {
      return s.ts + "@" + (s.total ? s.total.size_actual : "");
    }).join(",");
    if (sig === lastSig && container.__trendsData) {
      return true; /* still drawn */
    }

    var data = flatten(snaps);
    if (!data) {
      lastSig = null;
      container.innerHTML = "";
      container.__trendsData = null;
      return false;
    }

    if (!state) state = loadState();
    lastSig = sig;
    container.__trendsData = data;

    buildScaffold(container);
    drawAll(container);
    return true;
  }

  global.Trends = { render: render };
})(window);
