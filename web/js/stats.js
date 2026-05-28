/* ==========================================================================
 * stats.js — telemetry readout component for Strata
 *
 * Exposes a global `Stats` with two renderers that share ONE visual language:
 *   Stats.renderLive(container, statusJson)   — live scan progress (#/)
 *   Stats.renderFrozen(container, statsJson)  — frozen per-scan stats (#/scan)
 *
 * Both produce a sectioned key/value "terminal telemetry" readout so a
 * finished scan reads like a frozen snapshot of the live panel.
 * Depends on: Util.
 * ======================================================================== */
(function (global) {
  "use strict";

  var U = global.Util;

  /* ---- low-level builders ------------------------------------------------ */

  /* Build one "key value" row. `value` may carry an optional dim suffix. */
  function row(label, value, suffix, mono) {
    var r = document.createElement("div");
    r.className = "tl-row";

    var k = document.createElement("span");
    k.className = "tl-key";
    k.textContent = label;

    var v = document.createElement("span");
    v.className = "tl-val" + (mono === false ? "" : " mono");
    var missing = value == null || value === "" || value === "—";
    if (missing) value = "—";
    v.textContent = value;

    r.appendChild(k);
    r.appendChild(v);

    if (suffix && !missing) {
      var s = document.createElement("span");
      s.className = "tl-suffix mono";
      s.textContent = suffix;
      v.appendChild(s);
    }
    return r;
  }

  /* Build a titled section wrapping a set of rows / nodes. `cls` is an
   * optional extra class — used to place the section in the live grid. */
  function section(title, nodes, cls) {
    var sec = document.createElement("div");
    sec.className = "tl-section" + (cls ? " " + cls : "");

    var h = document.createElement("div");
    h.className = "tl-section-head";
    h.textContent = title;
    sec.appendChild(h);

    var body = document.createElement("div");
    body.className = "tl-section-body";
    (nodes || []).forEach(function (n) {
      if (n) body.appendChild(n);
    });
    sec.appendChild(body);
    return sec;
  }

  /* A horizontal meter bar (0..1). Used for CPU / progress feel. */
  function meter(frac, accentVar) {
    var wrap = document.createElement("div");
    wrap.className = "tl-meter";
    var fill = document.createElement("div");
    fill.className = "tl-meter-fill";
    fill.style.width = Math.max(0, Math.min(1, frac || 0)) * 100 + "%";
    if (accentVar) fill.style.background = "var(" + accentVar + ")";
    wrap.appendChild(fill);
    return wrap;
  }

  /* The live "Path" row: segments the current path, dims the parent
   * directories and highlights the deepest folder, and inserts a <wbr>
   * break opportunity after every "/" so a long path wraps cleanly at
   * directory boundaries instead of mid-name. <wbr> elements carry no
   * width and are not copied to the clipboard, so the path stays a clean
   * string when selected. */
  function pathRow(path) {
    var r = document.createElement("div");
    r.className = "tl-row tl-row-wrap";

    var k = document.createElement("span");
    k.className = "tl-key";
    k.textContent = "Path";
    r.appendChild(k);

    var v = document.createElement("span");
    v.className = "tl-val mono tl-path";
    r.appendChild(v);

    if (!path) {
      v.textContent = "—";
      return r;
    }

    var segs = String(path).split("/");
    // the leaf is the last non-empty segment (tolerate a trailing slash)
    var leafIdx = segs.length - 1;
    while (leafIdx > 0 && segs[leafIdx] === "") leafIdx--;

    for (var i = 0; i <= leafIdx; i++) {
      if (i === leafIdx) {
        var leaf = document.createElement("span");
        leaf.className = "tl-path-leaf";
        leaf.textContent = segs[i];
        v.appendChild(leaf);
      } else {
        var seg = document.createElement("span");
        seg.className = "tl-path-seg";
        seg.textContent = segs[i] + "/";
        v.appendChild(seg);
        v.appendChild(document.createElement("wbr"));
      }
    }
    return r;
  }

  /* Per-root table (frozen mode only). */
  function rootsTable(roots) {
    var tbl = document.createElement("div");
    tbl.className = "tl-roots";

    var head = document.createElement("div");
    head.className = "tl-roots-row tl-roots-head";
    ["Path", "Size", "Files", "Dirs"].forEach(function (t, i) {
      var c = document.createElement("span");
      c.className = "tl-roots-cell" + (i === 0 ? " grow" : " mono");
      c.textContent = t;
      head.appendChild(c);
    });
    tbl.appendChild(head);

    if (!roots || !roots.length) {
      var empty = document.createElement("div");
      empty.className = "tl-roots-empty";
      empty.textContent = "No roots reported.";
      tbl.appendChild(empty);
      return tbl;
    }

    roots.forEach(function (rt) {
      var r = document.createElement("div");
      r.className = "tl-roots-row";
      var cells = [
        { t: rt.path || "—", grow: true },
        { t: U.humanBytes(rt.size_actual), mono: true },
        { t: U.humanCount(rt.files), mono: true },
        { t: U.humanCount(rt.dirs), mono: true }
      ];
      cells.forEach(function (c) {
        var el = document.createElement("span");
        el.className =
          "tl-roots-cell" + (c.grow ? " grow" : "") + (c.mono ? " mono" : "");
        el.textContent = c.t;
        if (c.grow) el.title = c.t;
        r.appendChild(el);
      });
      tbl.appendChild(r);
    });
    return tbl;
  }

  /* ---- LIVE mode --------------------------------------------------------- */

  function renderLive(container, st) {
    container.innerHTML = "";
    var panel = document.createElement("div");
    panel.className = "telemetry telemetry-live";

    /* header — pulsing scanning badge */
    var head = document.createElement("div");
    head.className = "tl-head";
    head.innerHTML =
      '<span class="tl-pulse" aria-hidden="true"></span>' +
      '<span class="tl-head-title">scanning</span>' +
      '<span class="tl-head-meta mono">' +
      U.esc(st.ts || "") +
      "</span>";
    panel.appendChild(head);

    var grid = document.createElement("div");
    grid.className = "tl-grid tl-grid-live";

    /* Process */
    var cpuPct = st.cpu_pct;
    var fix1 = function (v) { return Number(v).toFixed(1); };
    var procNodes = [
      row("Elapsed", U.humanDuration(st.elapsed_sec)),
      row("CPU (now)", U.orDash(cpuPct, function (v) { return fix1(v) + "%"; })),
      meter(cpuPct != null ? Number(cpuPct) / 100 : 0, "--green"),
      row("Status", st.status_desc, null, false),
      row("Memory · indexer", U.orDash(st.mem_mb, fix1), " MiB"),
      row("Memory · container", U.orDash(st.cmem_mb, fix1), " MiB"),
      row("Process ID", U.orDash(st.pid))
    ];
    grid.appendChild(section("Process", procNodes, "tl-area-process"));

    /* Location */
    grid.appendChild(
      section(
        "Location",
        [
          pathRow(st.current_path),
          row("Depth", U.orDash(st.depth)),
          row("Roots", st.paths, null, true)
        ],
        "tl-area-location"
      )
    );

    /* Scanned so far */
    grid.appendChild(
      section(
        "Scanned so far",
        [
          row("Files", st.files_human || U.humanCount(st.files)),
          row("Directories", st.dirs_human || U.humanCount(st.dirs))
        ],
        "tl-area-scanned"
      )
    );

    /* Disk I/O */
    grid.appendChild(
      section(
        "Disk I/O",
        [
          row("Read", U.humanBytes(st.read_bytes), null, true),
          row("Read rate", U.rateMiB(st.read_rate)),
          row("Written", U.humanBytes(st.write_bytes), null, true),
          row("Write rate", U.rateMiB(st.write_rate))
        ],
        "tl-area-io"
      )
    );

    /* No "Output database" section in live mode: api.cgi op_status
     * never populates db_bytes/db_growth_rate (only build_stats does,
     * post-scan), so this section would render two permanent "—" rows. */

    panel.appendChild(grid);
    container.appendChild(panel);
  }

  /* ---- FROZEN mode ------------------------------------------------------- */

  function renderFrozen(container, stats) {
    container.innerHTML = "";
    var panel = document.createElement("div");
    panel.className = "telemetry telemetry-frozen";

    var total = stats.total || {};
    var io = stats.io || {};
    var rates = stats.rates || {};

    /* header */
    var head = document.createElement("div");
    head.className = "tl-head";
    head.innerHTML =
      '<span class="tl-dot" aria-hidden="true"></span>' +
      '<span class="tl-head-title">snapshot</span>' +
      '<span class="tl-head-meta mono">' +
      U.esc(stats.label || stats.ts || "") +
      "</span>";
    panel.appendChild(head);

    var grid = document.createElement("div");
    grid.className = "tl-grid";

    /* Scan */
    grid.appendChild(
      section("Scan", [
        row("Timestamp", stats.ts || "—"),
        row("Started", U.epochToStr(stats.start)),
        row("Finished", U.epochToStr(stats.end)),
        row(
          "Duration",
          stats.duration_human || U.humanDuration(stats.duration_sec)
        )
      ])
    );

    /* Totals */
    grid.appendChild(
      section("Totals", [
        row("Size · actual", U.humanBytes(total.size_actual), null, true),
        row("Size · apparent", U.humanBytes(total.size_apparent), null, true),
        row("Files", U.commaCount(total.files)),
        row("Directories", U.commaCount(total.dirs))
      ])
    );

    /* Per-root */
    grid.appendChild(
      section("Per-root", [rootsTable(stats.roots)], "tl-section-wide")
    );

    /* Output database */
    grid.appendChild(
      section("Output database", [
        row("Size", U.humanBytes(stats.db_bytes), null, true)
      ])
    );

    /* I/O */
    grid.appendChild(
      section("I/O", [
        row("Read total", U.humanBytes(io.read_bytes), null, true),
        row("Write total", U.humanBytes(io.write_bytes), null, true)
      ])
    );

    /* Derived rates */
    grid.appendChild(
      section("Derived rates", [
        row(
          "Files / sec",
          rates.files_per_sec != null
            ? Number(rates.files_per_sec).toLocaleString("en-US", {
                maximumFractionDigits: 1
              })
            : "—"
        ),
        row("DB growth", U.rateKiB(rates.db_growth_kib_s))
      ])
    );

    panel.appendChild(grid);
    container.appendChild(panel);
  }

  global.Stats = {
    renderLive: renderLive,
    renderFrozen: renderFrozen
  };
})(window);
