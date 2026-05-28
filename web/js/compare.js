/* ==========================================================================
 * compare.js — scan-comparison page for Strata
 *
 * Renders a "diff" view between two scans: a prominent delta header, two scan
 * selectors + a metric toggle, a delta-coloured sunburst, and a sortable /
 * filterable diff table. Self-contained: depends only on globals already
 * loaded before it (Util, Sunburst) and exposes `window.ComparePage`.
 *
 *   window.ComparePage.render(containerEl, {
 *     base: "<ts>" | "",          // baseline snapshot ts
 *     cur:  "<ts>" | "",          // current snapshot ts
 *     onNavigate: (base, cur) => {}  // user changed the selection
 *   });
 *
 * Visual language deliberately mirrors app.css: monospace numerics, terminal
 * sectioned readouts, thin accent rails. All new CSS lives in app.css under
 * the "COMPARE" banner.
 * ======================================================================== */
(function (global) {
  "use strict";

  var U = global.Util;
  /* API + spinner/errorBox live in util.js (shared with app.js). */
  var apiGet = U.apiGet;
  var spinner = U.spinnerEl;
  var errorBox = U.errorBox;

  /* ---- metric definitions ----------------------------------------------- *
   * The metric toggle swaps which family of numbers drives colours, table
   * and summary. Each metric knows its diff-tree field, its `changes`
   * field, the absolute base/cur fields on a diff node, and how to
   * format a value. */
  var METRICS = {
    actual: {
      key: "actual",
      label: "Size",
      sub: "actual",
      dField: "d_actual", // signed subtree delta on a diff node
      selfField: "self_actual", // self delta on a `changes` row
      nodeBase: "base_actual", // absolute fields on a diff node
      nodeCur: "size_actual",
      fmt: function (v) {
        return U.humanBytes(Math.abs(v));
      },
      isCount: false
    },
    apparent: {
      key: "apparent",
      label: "Apparent",
      sub: "apparent",
      dField: "d_apparent",
      selfField: "self_apparent",
      nodeBase: "base_apparent",
      nodeCur: "size_apparent",
      fmt: function (v) {
        return U.humanBytes(Math.abs(v));
      },
      isCount: false
    },
    count: {
      key: "count",
      label: "Item count",
      sub: "items",
      dField: "d_count",
      selfField: "self_count",
      nodeBase: "base_count",
      nodeCur: "count",
      fmt: function (v) {
        return U.commaCount(Math.abs(v));
      },
      isCount: true
    }
  };

  /* ---- small helpers ---------------------------------------------------- */
  function el(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function num(v) {
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  /* Signed human string with a leading ▲ / ▼ glyph (or "± 0" when flat).
   * `fmt` is always called with a non-negative value — the sign is owned
   * here. This matters for raw formatters like U.commaCount which would
   * otherwise emit a native "-" alongside our "−" ("▼ −-50"). */
  function signedStr(v, fmt) {
    v = num(v);
    if (v === 0) return "± 0";
    var glyph = v > 0 ? "▲" : "▼";
    var sign = v > 0 ? "+" : "−";
    return glyph + " " + sign + fmt(Math.abs(v));
  }

  /* Signed percentage of a delta against a base value. */
  function deltaPctStr(delta, base) {
    delta = num(delta);
    base = num(base);
    if (base === 0) return delta === 0 ? "0%" : "new";
    var p = (delta / base) * 100;
    var sign = p > 0 ? "+" : p < 0 ? "−" : "";
    var a = Math.abs(p);
    if (a > 0 && a < 0.1) return sign + "<0.1%";
    return sign + a.toFixed(1) + "%";
  }

  /* Direction class: "up" (grew), "down" (shrank), "flat" (unchanged). */
  function dirClass(v) {
    v = num(v);
    return v > 0 ? "up" : v < 0 ? "down" : "flat";
  }

  /* ======================================================================= *
   * MAIN ENTRY                                                              *
   * ======================================================================= */
  function render(containerEl, opts) {
    opts = opts || {};
    var onNavigate =
      typeof opts.onNavigate === "function" ? opts.onNavigate : function () {};

    /* Per-render page state. A fresh object every render() keeps things
     * isolated and avoids stale closures from a previous mount. */
    var state = {
      container: containerEl,
      onNavigate: onNavigate,
      snapshots: [], // newest-first list from op=snapshots
      base: opts.base || "", // selected baseline ts
      cur: opts.cur || "", // selected current ts
      result: null, // op=compare payload
      metric: METRICS.actual, // active metric
      sb: null, // Sunburst handle
      sort: { col: "self", dir: "desc" }, // diff-table sort
      /* "unchanged" rows appear when size barely moved but item count
       * changed (file replacement, churn) — a headline case for the
       * Items metric. Omitting the key would silently drop every such
       * row regardless of the user's chip state. */
      filters: {
        grew: true,
        shrank: true,
        added: true,
        removed: true,
        unchanged: true
      },
      threshold: 0, // noise-threshold (chosen-metric units)
      thresholdMax: 1 // slider ceiling, set after data loads
    };

    containerEl.innerHTML = "";
    destroySunburstSafe(state);
    containerEl.appendChild(spinner("Loading snapshots…"));

    /* Step 1 — fetch the snapshot list, pick defaults, then fetch the diff. */
    loadSnapshots(state, function () {
      runCompare(state);
    });

    /* Returned handle lets the router tear down the embedded sunburst
     * (body-attached tooltip + ResizeObserver) when leaving /compare. */
    return {
      destroy: function () {
        destroySunburstSafe(state);
      }
    };
  }

  /* ---- snapshot loading + default selection ----------------------------- */
  function loadSnapshots(state, done) {
    apiGet("snapshots")
      .then(function (data) {
        if (!state.container.isConnected) return;
        state.snapshots = (data && data.snapshots) || [];

        /* Only one (or zero) snapshot → comparison is impossible. */
        if (state.snapshots.length < 2) {
          renderShell(state);
          showNotEnough(state);
          return;
        }

        /* Default selection: cur = newest, base = the one before it. */
        var tsSet = {};
        state.snapshots.forEach(function (s) {
          tsSet[s.ts] = true;
        });
        if (!state.cur || !tsSet[state.cur]) {
          state.cur = state.snapshots[0].ts;
        }
        if (!state.base || !tsSet[state.base]) {
          state.base = previousSnapshotTs(state, state.cur);
        }
        /* Guard: a baseline must not be newer than the current scan. */
        normalizeSelection(state);

        done();
      })
      .catch(function (err) {
        if (!state.container.isConnected) return;
        state.container.innerHTML = "";
        state.container.appendChild(
          errorBox(err.message, function () {
            render(state.container, {
              base: state.base,
              cur: state.cur,
              onNavigate: state.onNavigate
            });
          })
        );
      });
  }

  /* The snapshot immediately older than `ts` (list is newest-first). */
  function previousSnapshotTs(state, ts) {
    var idx = indexOfTs(state, ts);
    if (idx < 0) return state.snapshots.length > 1 ? state.snapshots[1].ts : "";
    if (idx + 1 < state.snapshots.length) return state.snapshots[idx + 1].ts;
    /* `ts` is already the oldest — fall back to the next-newest. */
    return idx > 0 ? state.snapshots[idx - 1].ts : "";
  }

  function indexOfTs(state, ts) {
    for (var i = 0; i < state.snapshots.length; i++) {
      if (state.snapshots[i].ts === ts) return i;
    }
    return -1;
  }

  /* Ensure base is older than cur. Snapshots are newest-first, so a *larger*
   * index means older. If the user picks a baseline newer than current, we
   * transparently swap the two so the diff still reads "since baseline". */
  function normalizeSelection(state) {
    var bi = indexOfTs(state, state.base);
    var ci = indexOfTs(state, state.cur);
    if (bi < 0 || ci < 0) return;
    if (bi < ci) {
      var t = state.base;
      state.base = state.cur;
      state.cur = t;
    } else if (bi === ci) {
      /* base == cur — nudge baseline one step older if possible. */
      if (ci + 1 < state.snapshots.length) {
        state.base = state.snapshots[ci + 1].ts;
      }
    }
  }

  /* ---- compare fetch ---------------------------------------------------- */
  function runCompare(state) {
    renderShell(state);
    var slot = state.container.querySelector("#cmp-body");
    if (!slot) return;
    slot.innerHTML = "";
    slot.appendChild(buildLoadingSkeleton());

    apiGet("compare", { base: state.base, cur: state.cur })
      .then(function (data) {
        if (!state.container.isConnected) return;
        state.result = data || {};
        computeThresholdCeiling(state);
        buildPage(state);
      })
      .catch(function (err) {
        if (!state.container.isConnected) return;
        slot.innerHTML = "";
        slot.appendChild(
          errorBox(err.message, function () {
            runCompare(state);
          })
        );
      });
  }

  /* Slider ceiling = the largest |self-delta| across the chosen metric, so
   * the noise filter spans the full range of real changes. */
  function computeThresholdCeiling(state) {
    var changes = (state.result && state.result.changes) || [];
    var m = state.metric;
    var max = 0;
    changes.forEach(function (c) {
      var v = Math.abs(num(c[m.selfField]));
      if (v > max) max = v;
    });
    state.thresholdMax = max || 1;
    if (state.threshold > state.thresholdMax) state.threshold = 0;
  }

  /* ======================================================================= *
   * SHELL — body slot                                                       *
   * app.js owns the crumbtrail + page title (rendered as siblings of the    *
   * mount point); we just own the body container.                           *
   * ======================================================================= */
  function renderShell(state) {
    state.container.innerHTML = "";
    var body = el("div");
    body.id = "cmp-body";
    state.container.appendChild(body);
  }

  /* A lightweight loading skeleton while op=compare is in flight. */
  function buildLoadingSkeleton() {
    var wrap = el("div", "cmp-skeleton");
    wrap.innerHTML =
      '<div class="cmp-skel-band"></div>' +
      '<div class="cmp-skel-row"></div>' +
      '<div class="cmp-skel-chart"></div>';
    var s = spinner("Comparing scans…");
    wrap.appendChild(s);
    return wrap;
  }

  /* Friendly message when fewer than two snapshots exist. */
  function showNotEnough(state) {
    var slot = state.container.querySelector("#cmp-body");
    if (!slot) return;
    slot.innerHTML = "";
    var box = el("div", "empty");
    box.innerHTML =
      '<div class="empty-title">Not enough snapshots to compare</div>' +
      '<div class="empty-msg">A comparison needs at least two completed ' +
      "scans. Once a second scan finishes it will appear here, and you can " +
      "diff it against the baseline.</div>";
    slot.appendChild(box);
  }

  /* ======================================================================= *
   * PAGE BUILD                                                              *
   * ======================================================================= */
  function buildPage(state) {
    var slot = state.container.querySelector("#cmp-body");
    if (!slot) return;
    destroySunburstSafe(state);
    slot.innerHTML = "";

    slot.appendChild(buildSelectors(state));
    slot.appendChild(buildSummary(state));
    slot.appendChild(buildSunburstSection(state));
    slot.appendChild(buildTableSection(state));

    /* Stagger the page-load reveal — matches the dashboard's cardIn feel. */
    var blocks = slot.querySelectorAll(".cmp-reveal");
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].style.animationDelay = Math.min(i * 70, 320) + "ms";
    }
  }

  function destroySunburstSafe(state) {
    if (state.sb && typeof state.sb.destroy === "function") {
      try {
        state.sb.destroy();
      } catch (e) {
        /* ignore */
      }
    }
    state.sb = null;
  }

  /* Re-render only the metric-dependent sections (summary, sunburst, table).
   * The scan selectors don't change shape when the metric toggles, so
   * rebuilding them costs a snapshot-list iteration for nothing and would
   * also tear down any open <select> menu mid-interaction. */
  function rerenderMetric(state) {
    computeThresholdCeiling(state);
    var slot = state.container.querySelector("#cmp-body");
    if (!slot) return;
    /* Preserve the user's drill-in across the destroy+rebuild — without
     * this, toggling Actual ↔ Apparent ↔ Items snaps the chart back to
     * the synthetic root even though the metric toggle is meant to be
     * a pure re-render. */
    var savedFocus =
      state.sb && typeof state.sb.getFocusPath === "function"
        ? state.sb.getFocusPath()
        : "";
    destroySunburstSafe(state);
    var replacements = [
      [".cmp-summary", buildSummary(state)],
      [".cmp-chart-section", buildSunburstSection(state)],
      [".cmp-table-section", buildTableSection(state)]
    ];
    replacements.forEach(function (pair) {
      var prev = slot.querySelector(pair[0]);
      if (prev && prev.parentNode) prev.parentNode.replaceChild(pair[1], prev);
    });
    if (savedFocus && state.sb) state.sb.focusByPath(savedFocus);
  }

  /* ----------------------------------------------------------------------- *
   * SECTION 2 — scan selectors + metric toggle                              *
   * (placed first in the DOM so the controls sit above the summary band)    *
   * ----------------------------------------------------------------------- */
  function buildSelectors(state) {
    var wrap = el("section", "cmp-controls cmp-reveal");

    /* --- baseline / current dropdowns --- */
    var pickRow = el("div", "cmp-pickrow");

    var baseField = buildSelectField(state, {
      label: "Baseline",
      role: "base",
      selectedTs: state.base,
      onChange: function (ts) {
        state.base = ts;
        commitSelection(state);
      }
    });
    pickRow.appendChild(baseField);

    /* arrow between the two selects */
    var arrow = el("div", "cmp-pick-arrow");
    arrow.textContent = "→";
    arrow.setAttribute("aria-hidden", "true");
    pickRow.appendChild(arrow);

    var curField = buildSelectField(state, {
      label: "Current",
      role: "cur",
      selectedTs: state.cur,
      onChange: function (ts) {
        state.cur = ts;
        commitSelection(state);
      }
    });
    pickRow.appendChild(curField);

    /* "vs previous" quick action */
    var quick = el("button", "btn cmp-quick");
    quick.type = "button";
    quick.textContent = "vs previous";
    quick.title = "Compare the newest scan against the one before it";
    quick.addEventListener("click", function () {
      var cur = state.snapshots[0] ? state.snapshots[0].ts : state.cur;
      var base = previousSnapshotTs(state, cur);
      state.cur = cur;
      state.base = base;
      commitSelection(state);
    });
    pickRow.appendChild(quick);

    wrap.appendChild(pickRow);

    /* --- metric toggle --- */
    var metricWrap = el("div", "cmp-metric");
    var mLabel = el("span", "cmp-metric-label");
    mLabel.textContent = "METRIC";
    metricWrap.appendChild(mLabel);

    var toggle = el("div", "cmp-toggle");
    var toggleBtns = [];
    ["actual", "apparent", "count"].forEach(function (k) {
      var m = METRICS[k];
      var b = el("button");
      b.type = "button";
      b.textContent = m.label;
      b.dataset.metric = k;
      if (state.metric.key === k) b.classList.add("active");
      b.addEventListener("click", function () {
        if (state.metric.key === k) return;
        state.metric = m;
        toggleBtns.forEach(function (other) {
          other.classList.toggle("active", other === b);
        });
        rerenderMetric(state); // no re-fetch — pure re-render
      });
      toggle.appendChild(b);
      toggleBtns.push(b);
    });
    metricWrap.appendChild(toggle);
    wrap.appendChild(metricWrap);

    return wrap;
  }

  /* A labelled <select> populated with every snapshot. The option whose
   * choice would be invalid (baseline newer-or-equal than current, or current
   * older-or-equal than baseline) is disabled so the user cannot pick it. */
  function buildSelectField(state, opts) {
    var field = el("label", "cmp-field");
    var cap = el("span", "cmp-field-label");
    cap.textContent = opts.label;
    field.appendChild(cap);

    var sel = el("select", "cmp-select mono");
    var isBaseline = opts.role === "base";
    var otherTs = isBaseline ? state.cur : state.base;
    var otherIdx = indexOfTs(state, otherTs);

    state.snapshots.forEach(function (s, idx) {
      var opt = el("option");
      opt.value = s.ts;
      var sizeHint = s.total
        ? "  ·  " + U.humanBytes(s.total.size_actual)
        : "";
      opt.textContent = (s.label || s.ts) + sizeHint;
      if (s.ts === opts.selectedTs) opt.selected = true;
      /* Disable picks that would invert the timeline (newest-first list). */
      if (otherIdx >= 0) {
        if (isBaseline && idx <= otherIdx) opt.disabled = true; // not older
        if (!isBaseline && idx >= otherIdx) opt.disabled = true; // not newer
      }
      sel.appendChild(opt);
    });

    sel.addEventListener("change", function () {
      opts.onChange(sel.value);
    });
    field.appendChild(sel);
    return field;
  }

  /* Apply guards then notify the router; app.js re-invokes render(). */
  function commitSelection(state) {
    normalizeSelection(state);
    state.onNavigate(state.base, state.cur);
  }

  /* ----------------------------------------------------------------------- *
   * SECTION 1 — summary band                                                *
   * ----------------------------------------------------------------------- */
  function buildSummary(state) {
    var r = state.result || {};
    var m = state.metric;
    var summary = r.summary || {};
    var delta = summary.delta || {};
    var counts = summary.counts || {};

    /* summary.delta is keyed like a total (size_actual/size_apparent/count),
     * not like a diff-tree node (d_actual/...) — use the total field. */
    var dVal = num(delta[metricTotalField(m)]);
    var baseTotal = summary.base_total || {};
    /* baseline total for the chosen metric — used for the headline Δ%. */
    var baseMetricVal = num(baseTotal[metricTotalField(m)]);

    var band = el("section", "cmp-summary cmp-reveal");
    band.classList.add(dVal > 0 ? "is-up" : dVal < 0 ? "is-down" : "is-flat");

    /* --- hero delta --- */
    var hero = el("div", "cmp-summary-hero");
    var glyph = dVal > 0 ? "▲" : dVal < 0 ? "▼" : "■";
    var verb = dVal > 0 ? "added" : dVal < 0 ? "freed" : "unchanged";
    var heroNum = el("div", "cmp-hero-num mono");
    heroNum.innerHTML =
      '<span class="cmp-hero-glyph">' +
      glyph +
      "</span>" +
      '<span class="cmp-hero-value">' +
      U.esc(m.fmt(dVal)) +
      "</span>";
    hero.appendChild(heroNum);

    var heroCaption = el("div", "cmp-hero-caption");
    var pctTxt =
      baseMetricVal > 0 ? "  (" + deltaPctStr(dVal, baseMetricVal) + ")" : "";
    heroCaption.innerHTML =
      "<strong>" +
      U.esc(m.sub) +
      " " +
      verb +
      "</strong> since baseline" +
      U.esc(pctTxt);
    hero.appendChild(heroCaption);
    band.appendChild(hero);

    /* --- baseline → current labels --- */
    var span = el("div", "cmp-summary-span");
    span.innerHTML =
      '<span class="cmp-span-label">BASELINE</span>' +
      '<span class="cmp-span-ts mono">' +
      U.esc(r.base_label || r.base || state.base) +
      "</span>" +
      '<span class="cmp-span-arrow">→</span>' +
      '<span class="cmp-span-label">CURRENT</span>' +
      '<span class="cmp-span-ts mono">' +
      U.esc(r.cur_label || r.cur || state.cur) +
      "</span>";
    band.appendChild(span);

    /* --- change counts --- */
    var countRow = el("div", "cmp-counts");
    countRow.appendChild(countChip("grew", counts.grew, "up"));
    countRow.appendChild(countChip("shrank", counts.shrank, "down"));
    countRow.appendChild(countChip("added", counts.added, "added"));
    countRow.appendChild(countChip("removed", counts.removed, "removed"));
    band.appendChild(countRow);

    /* --- biggest grower / biggest space freed --- */
    var changes = (r.changes || []).slice();
    if (changes.length) {
      /* `changes` arrives pre-sorted by self_actual desc. For the chosen
       * metric we re-rank by self-delta so the highlights stay consistent. */
      var ranked = changes.slice().sort(function (a, b) {
        return num(b[m.selfField]) - num(a[m.selfField]);
      });
      var topGrower = ranked[0];
      var topFreed = ranked[ranked.length - 1];

      var hi = el("div", "cmp-highlights");
      if (topGrower && num(topGrower[m.selfField]) > 0) {
        hi.appendChild(
          highlightCard(state, "Biggest grower", topGrower, "up")
        );
      }
      if (
        topFreed &&
        num(topFreed[m.selfField]) < 0 &&
        topFreed !== topGrower
      ) {
        hi.appendChild(
          highlightCard(state, "Most space freed", topFreed, "down")
        );
      }
      if (hi.children.length) band.appendChild(hi);
    }

    return band;
  }

  /* The absolute summary total field matching a metric (base_total / cur). */
  function metricTotalField(m) {
    if (m.key === "actual") return "size_actual";
    if (m.key === "apparent") return "size_apparent";
    return "count";
  }

  function countChip(label, n, kind) {
    var chip = el("span", "cmp-count cmp-count-" + kind);
    chip.innerHTML =
      '<span class="cmp-count-n mono">' +
      U.esc(U.commaCount(num(n))) +
      "</span>" +
      '<span class="cmp-count-l">' +
      U.esc(label) +
      "</span>";
    return chip;
  }

  /* A click-through highlight card; clicking focuses that path in the chart. */
  function highlightCard(state, title, change, dir) {
    var m = state.metric;
    var card = el("button", "cmp-hl cmp-hl-" + dir);
    card.type = "button";
    var selfVal = num(change[m.selfField]);
    card.innerHTML =
      '<span class="cmp-hl-rail" aria-hidden="true"></span>' +
      '<span class="cmp-hl-title">' +
      U.esc(title) +
      "</span>" +
      '<span class="cmp-hl-name mono">' +
      U.esc(change.name || change.path || "/") +
      "</span>" +
      '<span class="cmp-hl-path mono">' +
      U.esc(change.path || "") +
      "</span>" +
      '<span class="cmp-hl-delta mono cmp-' +
      dirClass(selfVal) +
      '">' +
      U.esc(signedStr(selfVal, m.fmt)) +
      "</span>";
    card.title = "Focus " + (change.path || "") + " in the chart";
    card.addEventListener("click", function () {
      focusInChart(state, change.path);
    });
    return card;
  }

  /* Scroll to the chart and focus a path inside the sunburst. */
  function focusInChart(state, path) {
    if (state.sb && path) {
      state.sb.focusByPath(path);
      var chart = state.container.querySelector(".cmp-chart-section");
      if (chart && chart.scrollIntoView) {
        chart.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }

  /* ----------------------------------------------------------------------- *
   * SECTION 3 — delta sunburst                                              *
   * ----------------------------------------------------------------------- */
  function buildSunburstSection(state) {
    var section = el("section", "cmp-chart-section cmp-reveal");

    var head = el("div", "section-head");
    /* The embedded Sunburst defaults sizeKey to "size_actual" and we
     * pass compareMode:true (which hides its size toggle), so arcs are
     * always sized by current actual size regardless of the row metric. */
    head.innerHTML =
      '<h2 class="section-title">Delta map</h2>' +
      '<span class="section-meta">arc size = current actual size · ' +
      "colour = change</span>";
    section.appendChild(head);

    /* legend — explains the diverging colour scale + glyphs */
    section.appendChild(buildLegend());

    var slot = el("div", "cmp-sb-slot");
    section.appendChild(slot);

    var tree = state.result && state.result.tree;
    if (!tree) {
      var empty = el("div", "empty");
      empty.innerHTML =
        '<div class="empty-title">No tree available</div>' +
        '<div class="empty-msg">This comparison did not return a directory ' +
        "tree, so the delta map cannot be drawn.</div>";
      slot.appendChild(empty);
      return section;
    }

    /* The colour scale needs a magnitude reference. We use a high quantile of
     * |d_metric| across the tree so a single huge outlier doesn't wash the
     * rest of the chart toward neutral. */
    var scaleRef = computeColorReference(state, tree);

    /* Mount the shared Sunburst with compare hooks. */
    state.sb = global.Sunburst(slot, {
      compareMode: true, // hides the built-in actual/apparent toggle
      color: function (hierNode) {
        return arcColor(state, hierNode, scaleRef);
      },
      tooltipRows: function (dataNode) {
        return tooltipRows(state, dataNode);
      }
    });
    state.sb.setData(tree);

    return section;
  }

  /* A compact legend strip. */
  function buildLegend() {
    var legend = el("div", "cmp-legend");
    var items = [
      { cls: "added", txt: "added", glyph: "＋" },
      { cls: "up", txt: "grew", glyph: "▲" },
      { cls: "flat", txt: "unchanged", glyph: "■" },
      { cls: "down", txt: "shrank", glyph: "▼" },
      { cls: "removed", txt: "removed", glyph: "✕" }
    ];
    items.forEach(function (it) {
      var s = el("span", "cmp-legend-item");
      s.innerHTML =
        '<span class="cmp-legend-swatch cmp-sw-' +
        it.cls +
        '"></span>' +
        '<span class="cmp-legend-glyph cmp-' +
        it.cls +
        '">' +
        it.glyph +
        "</span>" +
        '<span class="cmp-legend-txt">' +
        it.txt +
        "</span>";
      legend.appendChild(s);
    });
    return legend;
  }

  /* Reference magnitude for the diverging colour scale: the 92nd-percentile
   * of |relative change| over grew/shrank nodes. Quantile-based so outliers
   * do not flatten the palette. */
  function computeColorReference(state, tree) {
    var m = state.metric;
    var ratios = [];
    (function walk(node) {
      if (!node) return;
      if (!node.other && (node.status === "grew" || node.status === "shrank")) {
        var base = Math.abs(num(node[m.nodeBase]));
        var d = Math.abs(num(node[m.dField]));
        if (base > 0) {
          ratios.push(d / base);
        } else if (d > 0) {
          ratios.push(1);
        }
      }
      (node.children || []).forEach(walk);
    })(tree);

    if (!ratios.length) return 1;
    ratios.sort(function (a, b) {
      return a - b;
    });
    var idx = Math.floor(ratios.length * 0.92);
    if (idx >= ratios.length) idx = ratios.length - 1;
    var ref = ratios[idx];
    return ref > 0 ? ref : 1;
  }

  /* ---- arc colour ------------------------------------------------------- *
   * Diverging scale on the chosen metric's d_* value, relative to the node's
   * own base size. Growth = warm, shrink = cool, added = green, removed =
   * muted grey, (other) = neutral grey. Intensity is log-compressed so the
   * mid-range stays legible. */
  function arcColor(state, hierNode, scaleRef) {
    var d = (hierNode && hierNode.data) || {};
    var m = state.metric;

    if (d.other) return "#5b626d"; // neutral grey aggregate
    if (d._files) return "#363b44"; // synthetic "own files" wedge
    if (hierNode.depth === 0) return "#30363d"; // synthetic root

    var status = d.status || "unchanged";
    if (status === "removed") return "#454c57"; // muted grey ghost
    if (status === "added") return "#2ea043"; // clear green

    var delta = num(d[m.dField]);
    if (delta === 0 || status === "unchanged") return "#2b313c"; // near-neutral

    /* magnitude 0..1 — log-compressed ratio of |delta| to node base size. */
    var base = Math.abs(num(d[m.nodeBase]));
    var ratio = base > 0 ? Math.abs(delta) / base : 1;
    var t = Math.log1p(ratio) / Math.log1p(scaleRef || 1);
    if (t > 1) t = 1;
    if (t < 0) t = 0;
    /* keep a visible floor so small-but-real changes still read as coloured */
    t = 0.16 + t * 0.84;

    return delta > 0 ? warmColor(t) : coolColor(t);
  }

  /* Growth ramp: dim ember → hot orange-red. */
  function warmColor(t) {
    return mixHsl(28, 0.62, 0.46, 12, 0.82, 0.6, t);
  }
  /* Shrink ramp: dim slate-teal → bright cyan-blue. */
  function coolColor(t) {
    return mixHsl(205, 0.42, 0.42, 192, 0.74, 0.62, t);
  }

  /* Interpolate two HSL stops and return a hex string (no d3 dependency). */
  function mixHsl(h0, s0, l0, h1, s1, l1, t) {
    var h = h0 + (h1 - h0) * t;
    var s = s0 + (s1 - s0) * t;
    var l = l0 + (l1 - l0) * t;
    return hslToHex(h, s, l);
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    function hue(p, q, x) {
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    }
    var r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hue(p, q, h + 1 / 3);
      g = hue(p, q, h);
      b = hue(p, q, h - 1 / 3);
    }
    function ch(x) {
      var v = Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16);
      return v.length === 1 ? "0" + v : v;
    }
    return "#" + ch(r) + ch(g) + ch(b);
  }

  /* ---- sunburst tooltip rows -------------------------------------------- */
  function tooltipRows(state, d) {
    d = d || {};
    var m = state.metric;

    if (d._files) {
      return [{ k: "Type", v: "Files held directly here" }];
    }
    if (d.other) {
      return [{ k: "Type", v: "Smaller directories grouped" }];
    }

    var status = d.status || "unchanged";
    var baseVal = num(d[m.nodeBase]);
    var curVal = num(d[m.nodeCur]);
    var delta = num(d[m.dField]);
    var fmtVal = m.isCount ? U.commaCount : U.humanBytes;

    var rows = [{ k: "Status", v: statusLabel(status) }];

    if (status === "added") {
      rows.push({ k: "Was", v: "—" });
      rows.push({ k: "Now", v: fmtVal(curVal) });
    } else if (status === "removed") {
      rows.push({ k: "Was", v: fmtVal(baseVal) });
      rows.push({ k: "Now", v: "—" });
    } else {
      rows.push({ k: "Was", v: fmtVal(baseVal) });
      rows.push({ k: "Now", v: fmtVal(curVal) });
    }

    rows.push({ k: "Δ " + m.sub, v: signedStr(delta, m.fmt) });
    rows.push({ k: "Δ%", v: deltaPctStr(delta, baseVal) });
    /* Skip "Δ items" when the active metric IS count — it would just repeat
     * the row above with the same label and number. */
    if (!m.isCount) {
      rows.push({ k: "Δ items", v: signedStr(num(d.d_count), U.commaCount) });
    }
    return rows;
  }

  function statusLabel(s) {
    switch (s) {
      case "grew":
        return "▲ grew";
      case "shrank":
        return "▼ shrank";
      case "added":
        return "＋ added";
      case "removed":
        return "✕ removed";
      default:
        return "■ unchanged";
    }
  }

  /* ----------------------------------------------------------------------- *
   * SECTION 4 — diff table                                                  *
   * ----------------------------------------------------------------------- */
  function buildTableSection(state) {
    var section = el("section", "cmp-table-section cmp-reveal");

    var head = el("div", "section-head");
    head.innerHTML =
      '<h2 class="section-title">Changed directories</h2>' +
      '<span class="section-meta mono" id="cmp-row-count"></span>';
    section.appendChild(head);

    var changes = (state.result && state.result.changes) || [];

    if (!changes.length) {
      var empty = el("div", "empty");
      empty.innerHTML =
        '<div class="empty-title">No directory changes</div>' +
        '<div class="empty-msg">These two scans are identical at directory ' +
        "granularity — nothing grew, shrank, was added or removed.</div>";
      section.appendChild(empty);
      return section;
    }

    /* --- toolbar: status filter chips + noise-threshold slider --- */
    var toolbar = el("div", "cmp-table-toolbar");

    var chips = el("div", "cmp-filter-chips");
    ["grew", "shrank", "unchanged", "added", "removed"].forEach(function (st) {
      var chip = el("button", "cmp-fchip cmp-fchip-" + st);
      chip.type = "button";
      chip.dataset.status = st;
      chip.setAttribute(
        "aria-pressed",
        state.filters[st] ? "true" : "false"
      );
      if (!state.filters[st]) chip.classList.add("off");
      chip.innerHTML =
        '<span class="cmp-fchip-dot"></span>' + U.esc(st);
      chip.addEventListener("click", function () {
        state.filters[st] = !state.filters[st];
        chip.classList.toggle("off", !state.filters[st]);
        chip.setAttribute("aria-pressed", state.filters[st] ? "true" : "false");
        refreshTable(state);
      });
      chips.appendChild(chip);
    });
    toolbar.appendChild(chips);

    /* noise-threshold slider */
    var sliderWrap = el("div", "cmp-threshold");
    var slLabel = el("span", "cmp-threshold-label");
    slLabel.textContent = "MIN |Δ|";
    sliderWrap.appendChild(slLabel);

    var slider = el("input", "cmp-slider");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(state.thresholdMax);
    /* ~200 steps gives smooth dragging across any magnitude. */
    slider.step = String(Math.max(1, state.thresholdMax / 200));
    slider.value = String(state.threshold);
    sliderWrap.appendChild(slider);

    var slVal = el("span", "cmp-threshold-val mono");
    slVal.textContent = thresholdText(state);
    sliderWrap.appendChild(slVal);

    slider.addEventListener("input", function () {
      state.threshold = num(slider.value);
      slVal.textContent = thresholdText(state);
      refreshTable(state);
    });
    toolbar.appendChild(sliderWrap);

    section.appendChild(toolbar);

    /* --- table scaffold --- */
    var tableWrap = el("div", "cmp-table-wrap");
    var table = el("table", "cmp-table");

    var thead = el("thead");
    var hr = el("tr");
    COLUMNS.forEach(function (col) {
      var th = el("th", "cmp-th cmp-th-" + col.align);
      th.dataset.col = col.key;
      th.innerHTML =
        '<span class="cmp-th-label">' +
        U.esc(col.label) +
        "</span>" +
        '<span class="cmp-th-caret"></span>';
      th.addEventListener("click", function () {
        toggleSort(state, col.key);
        refreshTable(state);
        paintSortHeaders(state, thead);
      });
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el("tbody");
    tbody.id = "cmp-tbody";
    table.appendChild(tbody);

    tableWrap.appendChild(table);
    section.appendChild(tableWrap);

    /* initial paint */
    state._tableNodes = { tbody: tbody, thead: thead, section: section };
    paintSortHeaders(state, thead);
    refreshTable(state);

    return section;
  }

  /* Column model — `key` doubles as the sort key. */
  var COLUMNS = [
    { key: "path", label: "Path", align: "left" },
    { key: "status", label: "Status", align: "left" },
    { key: "was", label: "Was", align: "right" },
    { key: "now", label: "Now", align: "right" },
    { key: "self", label: "Δ", align: "right" },
    { key: "pct", label: "Δ%", align: "right" },
    { key: "items", label: "Δ items", align: "right" }
  ];

  /* Toggle sort: same column flips direction, new column resets to a sane
   * default (desc for numeric magnitude, asc for path). */
  function toggleSort(state, key) {
    if (state.sort.col === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.col = key;
      state.sort.dir = key === "path" ? "asc" : "desc";
    }
  }

  function paintSortHeaders(state, thead) {
    var ths = thead.querySelectorAll(".cmp-th");
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var active = th.dataset.col === state.sort.col;
      th.classList.toggle("sorted", active);
      th.classList.toggle("asc", active && state.sort.dir === "asc");
      th.classList.toggle("desc", active && state.sort.dir === "desc");
    }
  }

  /* Slider readout: "off" at zero, otherwise the formatted threshold. */
  function thresholdText(state) {
    if (state.threshold <= 0) return "off";
    var m = state.metric;
    return "≥ " + m.fmt(state.threshold);
  }

  /* Filter + sort + render the table body. Kept allocation-light so it stays
   * snappy for a few hundred rows across every filter/sort/slider change. */
  function refreshTable(state) {
    var nodes = state._tableNodes;
    if (!nodes) return;
    var tbody = nodes.tbody;
    var m = state.metric;
    var all = (state.result && state.result.changes) || [];

    /* filter */
    var rows = all.filter(function (c) {
      if (!state.filters[c.status]) return false;
      if (state.threshold > 0) {
        if (Math.abs(num(c[m.selfField])) < state.threshold) return false;
      }
      return true;
    });

    /* sort */
    var dir = state.sort.dir === "asc" ? 1 : -1;
    var col = state.sort.col;
    rows.sort(function (a, b) {
      return compareRows(a, b, col, m) * dir;
    });

    /* render — build the markup once, assign in a single innerHTML write. */
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      html += rowHtml(rows[i], m);
    }
    tbody.innerHTML = html || "";

    if (!rows.length) {
      var tr = el("tr", "cmp-row-empty");
      var td = el("td");
      td.colSpan = COLUMNS.length;
      td.textContent =
        "No changes match the current filters" +
        (state.threshold > 0 ? " and noise threshold." : ".");
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    /* row click → focus that path in the sunburst */
    tbody.onclick = function (ev) {
      var tr = ev.target.closest("tr.cmp-row");
      if (!tr) return;
      var path = tr.getAttribute("data-path");
      if (path) focusInChart(state, path);
    };

    /* row count readout. Resolve via the section node (not state.container)
     * because the very first refreshTable() runs from inside buildTableSection
     * BEFORE the section is appended to the slot — a container-scoped query
     * would miss the readout on every fresh build / metric toggle. */
    var countEl =
      (nodes.section && nodes.section.querySelector("#cmp-row-count")) ||
      state.container.querySelector("#cmp-row-count");
    if (countEl) {
      countEl.textContent =
        rows.length +
        (rows.length === 1 ? " directory" : " directories") +
        (rows.length !== all.length ? " of " + all.length : "");
    }
  }

  /* Comparator for a single column. */
  function compareRows(a, b, col, m) {
    switch (col) {
      case "path":
        return String(a.path || "").localeCompare(String(b.path || ""));
      case "status":
        return statusRank(a.status) - statusRank(b.status);
      case "was":
        /* apparent/count rows carry no base — fall back to self-delta so the
         * ordering is still stable and intuitive. */
        return (
          numOr(rowWas(a, m), num(a[m.selfField])) -
          numOr(rowWas(b, m), num(b[m.selfField]))
        );
      case "now":
        return (
          numOr(rowNow(a, m), num(a[m.selfField])) -
          numOr(rowNow(b, m), num(b[m.selfField]))
        );
      case "self":
        return num(a[m.selfField]) - num(b[m.selfField]);
      case "pct":
        return rowPct(a, m) - rowPct(b, m);
      case "items":
        return num(a.self_count) - num(b.self_count);
      default:
        return 0;
    }
  }

  function statusRank(s) {
    return { grew: 0, added: 1, unchanged: 2, shrank: 3, removed: 4 }[s] || 2;
  }

  /* Coalesce: first argument if non-null, else the fallback. */
  function numOr(v, fallback) {
    return v == null ? fallback : v;
  }

  /* Row-level "Was" value for the active metric.
   * `changes` rows only carry base_actual / cur_actual; for apparent + count
   * the API gives no row-level base/cur, so those return null (shown as "—"). */
  function rowWas(c, m) {
    if (m.key === "actual") return num(c.base_actual);
    /* derive from self delta — cur isn't available for apparent/count rows. */
    return null;
  }
  function rowNow(c, m) {
    if (m.key === "actual") return num(c.cur_actual);
    return null;
  }

  /* Row Δ% — relative to the row's base where we have one. */
  function rowPct(c, m) {
    var was = rowWas(c, m);
    var self = num(c[m.selfField]);
    if (was == null) {
      /* no base for this metric → percent is undefined; rank by magnitude. */
      return self === 0 ? 0 : self > 0 ? 1e-9 : -1e-9;
    }
    /* was===0 means a new directory; sentinel ranks it above any finite %
     * without producing NaN under Infinity-Infinity in a sort comparator. */
    if (was === 0) return self > 0 ? 1e12 : self < 0 ? -1e12 : 0;
    return (self / was) * 100;
  }

  /* Render one table row. */
  function rowHtml(c, m) {
    var status = c.status || "unchanged";
    var selfVal = num(c[m.selfField]);
    var was = rowWas(c, m);
    var now = rowNow(c, m);

    /* Was / Now cells. For apparent + count we lack row-level base/cur, so we
     * show an em-dash rather than a misleading number. */
    var wasTxt =
      was == null
        ? "—"
        : status === "added"
        ? "—"
        : (m.isCount ? U.commaCount(was) : U.humanBytes(was));
    var nowTxt =
      now == null
        ? "—"
        : status === "removed"
        ? "—"
        : (m.isCount ? U.commaCount(now) : U.humanBytes(now));

    /* Δ% cell */
    var pctTxt;
    if (was == null) {
      pctTxt = "—";
    } else if (status === "added") {
      pctTxt = "new";
    } else if (status === "removed") {
      pctTxt = "−100%";
    } else {
      pctTxt = deltaPctStr(selfVal, was);
    }

    var dc = dirClass(selfVal);
    var itemsVal = num(c.self_count);

    return (
      '<tr class="cmp-row cmp-row-' +
      status +
      '" data-path="' +
      U.esc(c.path || "") +
      '">' +
      /* path */
      '<td class="cmp-td cmp-td-path">' +
      '<span class="cmp-path-rail cmp-rail-' +
      status +
      '" aria-hidden="true"></span>' +
      '<span class="cmp-path-name mono">' +
      U.esc(c.name || "/") +
      "</span>" +
      '<span class="cmp-path-dir mono">' +
      U.esc(dirOf(c.path)) +
      "</span>" +
      "</td>" +
      /* status chip */
      '<td class="cmp-td">' +
      statusChip(status) +
      "</td>" +
      /* was */
      '<td class="cmp-td cmp-td-num mono">' +
      U.esc(wasTxt) +
      "</td>" +
      /* now */
      '<td class="cmp-td cmp-td-num mono">' +
      U.esc(nowTxt) +
      "</td>" +
      /* delta */
      '<td class="cmp-td cmp-td-num mono cmp-' +
      dc +
      '">' +
      U.esc(signedStr(selfVal, m.fmt)) +
      "</td>" +
      /* delta % */
      '<td class="cmp-td cmp-td-num mono cmp-' +
      dc +
      '">' +
      U.esc(pctTxt) +
      "</td>" +
      /* delta items */
      '<td class="cmp-td cmp-td-num mono cmp-' +
      dirClass(itemsVal) +
      '">' +
      U.esc(itemsVal === 0 ? "0" : signedStr(itemsVal, U.commaCount)) +
      "</td>" +
      "</tr>"
    );
  }

  /* The parent directory of a path, for the dim secondary line. */
  function dirOf(path) {
    if (!path) return "";
    var i = path.lastIndexOf("/");
    if (i <= 0) return "/";
    return path.slice(0, i);
  }

  function statusChip(status) {
    var glyphs = {
      grew: "▲",
      shrank: "▼",
      added: "＋",
      removed: "✕",
      unchanged: "■"
    };
    return (
      '<span class="cmp-chip cmp-chip-' +
      status +
      '"><span class="cmp-chip-glyph">' +
      (glyphs[status] || "■") +
      "</span>" +
      U.esc(status) +
      "</span>"
    );
  }

  /* ---- export ----------------------------------------------------------- */
  global.ComparePage = { render: render };
})(window);
