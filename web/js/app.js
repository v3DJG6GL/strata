/* ==========================================================================
 * app.js — hash router + page orchestration for Strata
 *
 * Routes:
 *   #/                                       → Dashboard
 *   #/scan/<ts>                              → Scan detail
 *   #/scan/<ts>/<encodeURIComponent(path)>   → Scan detail focused on a path
 *   #/compare                                → Compare (newest vs previous)
 *   #/compare/<base>/<cur>                   → Compare two snapshots
 *
 * Depends on: d3 (only inside Sunburst), Util, Stats, Sunburst, ComparePage.
 * ======================================================================== */
(function (global) {
  "use strict";

  var U = global.Util;
  var API = "cgi-bin/api.cgi";

  /* ---- API layer -------------------------------------------------------- */
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

  /* ---- DOM root --------------------------------------------------------- */
  var appEl = document.getElementById("app");

  /* Live-scan polling handle for the dashboard. */
  var pollTimer = null;
  var lastScanning = null;

  /* ---- shared UI fragments --------------------------------------------- */
  function spinner(label) {
    return (
      '<div class="loading"><div class="spin"></div><span>' +
      U.esc(label || "Loading…") +
      "</span></div>"
    );
  }

  function errorBox(msg, retryFn) {
    var box = document.createElement("div");
    box.className = "errbox";
    box.innerHTML =
      '<div class="errbox-icon">!</div>' +
      '<div class="errbox-body">' +
      '<div class="errbox-title">Something went wrong</div>' +
      '<div class="errbox-msg">' +
      U.esc(msg) +
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

  function header() {
    return (
      '<header class="app-header">' +
      '<a class="brand" href="#/">' +
      '<span class="brand-mark" aria-hidden="true"></span>' +
      '<span class="brand-name">Stra<span class="brand-name-accent">' +
      "ta</span></span>" +
      '<span class="brand-sub">disk usage explorer</span>' +
      "</a>" +
      "</header>"
    );
  }

  function clearPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /* ====================================================================== *
   * DASHBOARD                                                              *
   * ====================================================================== */
  function renderDashboard() {
    clearPoll();
    appEl.innerHTML =
      header() +
      '<main class="page page-dashboard">' +
      '<div id="live-slot"></div>' +
      '<section class="trend-section" id="trend-section" hidden>' +
      '<div class="section-head">' +
      '<h2 class="section-title">Storage over time</h2>' +
      '<span class="section-meta">click a point to open that scan</span>' +
      "</div>" +
      '<div id="trend-slot"></div>' +
      "</section>" +
      '<section class="snap-section">' +
      '<div class="section-head">' +
      '<h2 class="section-title">Snapshots</h2>' +
      '<div class="section-head-right">' +
      '<span class="section-meta mono" id="snap-count"></span>' +
      '<a class="btn btn-compare" href="#/compare">⇄ Compare scans</a>' +
      "</div>" +
      "</div>" +
      '<div id="snap-list">' +
      spinner("Loading snapshots…") +
      "</div>" +
      "</section>" +
      "</main>";

    loadSnapshots();
    pollStatus(); // immediate, then every 4s
    pollTimer = setInterval(pollStatus, 4000);
  }

  function loadSnapshots() {
    var listEl = document.getElementById("snap-list");
    if (!listEl) return;
    apiGet("snapshots")
      .then(function (data) {
        renderSnapshotList(data);
      })
      .catch(function (err) {
        if (!listEl.isConnected) return;
        listEl.innerHTML = "";
        listEl.appendChild(errorBox(err.message, loadSnapshots));
      });
  }

  function renderSnapshotList(data) {
    var listEl = document.getElementById("snap-list");
    var countEl = document.getElementById("snap-count");
    if (!listEl) return;

    var snaps = (data && data.snapshots) || [];
    if (countEl)
      countEl.textContent =
        snaps.length + (snaps.length === 1 ? " scan" : " scans");

    if (!snaps.length) {
      listEl.innerHTML =
        '<div class="empty"><div class="empty-title">No snapshots yet</div>' +
        '<div class="empty-msg">The first scan may still be running. ' +
        "Completed scans will appear here, newest first.</div></div>";
      return;
    }

    listEl.innerHTML = "";
    var grid = document.createElement("div");
    grid.className = "snap-grid";
    snaps.forEach(function (s, i) {
      grid.appendChild(snapshotCard(s, i));
    });
    listEl.appendChild(grid);

    /* storage-over-time chart — shown only when there are >=2 dated scans */
    var trendSlot = document.getElementById("trend-slot");
    var trendSec = document.getElementById("trend-section");
    if (trendSlot && global.Trends) {
      var drawn = global.Trends.render(trendSlot, snaps);
      if (trendSec) trendSec.hidden = !drawn;
    }
  }

  function snapshotCard(s, index) {
    var total = s.total || {};
    var card = document.createElement("a");
    card.className = "snap-card";
    card.href = "#/scan/" + encodeURIComponent(s.ts);
    card.style.animationDelay = Math.min(index * 45, 360) + "ms";

    /* card head */
    var head = document.createElement("div");
    head.className = "snap-card-head";
    head.innerHTML =
      '<div class="snap-card-label">' +
      U.esc(s.label || s.ts) +
      "</div>" +
      (s.has_tree
        ? '<span class="badge badge-ok">tree</span>'
        : '<span class="badge badge-muted">no tree</span>');
    card.appendChild(head);

    /* headline size */
    var hero = document.createElement("div");
    hero.className = "snap-card-hero";
    hero.innerHTML =
      '<span class="snap-card-size mono">' +
      U.esc(U.humanBytes(total.size_actual)) +
      "</span>" +
      '<span class="snap-card-size-label">on disk</span>';
    card.appendChild(hero);

    /* metric strip */
    var metrics = document.createElement("div");
    metrics.className = "snap-card-metrics";
    metrics.appendChild(metricCell("Files", U.humanCount(total.files)));
    metrics.appendChild(metricCell("Dirs", U.humanCount(total.dirs)));
    metrics.appendChild(
      metricCell(
        "Duration",
        s.duration_sec != null ? U.humanDuration(s.duration_sec) : "—"
      )
    );
    metrics.appendChild(metricCell("DB", U.humanBytes(s.db_bytes)));
    card.appendChild(metrics);

    /* per-root breakdown bar + list */
    var roots = s.roots || [];
    if (roots.length) {
      var rootSum = roots.reduce(function (a, r) {
        return a + (Number(r.size_actual) || 0);
      }, 0);

      var bar = document.createElement("div");
      bar.className = "snap-card-bar";
      roots.forEach(function (r, ri) {
        var seg = document.createElement("span");
        seg.className = "snap-card-bar-seg";
        var w = rootSum ? ((Number(r.size_actual) || 0) / rootSum) * 100 : 0;
        seg.style.width = w + "%";
        seg.style.opacity = String(1 - ri * 0.18);
        seg.title = r.path + " — " + U.humanBytes(r.size_actual);
        bar.appendChild(seg);
      });
      card.appendChild(bar);

      var rl = document.createElement("div");
      rl.className = "snap-card-roots";
      roots.forEach(function (r) {
        var rr = document.createElement("div");
        rr.className = "snap-card-root";
        rr.innerHTML =
          '<span class="snap-card-root-path">' +
          U.esc(r.path) +
          "</span>" +
          '<span class="snap-card-root-size mono">' +
          U.esc(U.humanBytes(r.size_actual)) +
          "</span>";
        rl.appendChild(rr);
      });
      card.appendChild(rl);
    }

    var go = document.createElement("div");
    go.className = "snap-card-go";
    go.innerHTML = "Explore <span aria-hidden=\"true\">→</span>";
    card.appendChild(go);

    return card;
  }

  function metricCell(label, value) {
    var c = document.createElement("div");
    c.className = "metric-cell";
    c.innerHTML =
      '<div class="metric-value mono">' +
      U.esc(value) +
      '</div><div class="metric-label">' +
      U.esc(label) +
      "</div>";
    return c;
  }

  /* Poll op=status; render the live panel and refresh the list on finish. */
  function pollStatus() {
    var slot = document.getElementById("live-slot");
    if (!slot) return; // navigated away
    apiGet("status")
      .then(function (st) {
        if (!slot.isConnected) return;
        var scanning = !!(st && st.scanning);

        if (scanning) {
          if (!slot.querySelector(".telemetry")) slot.innerHTML = "";
          var panelWrap = slot.querySelector(".live-wrap");
          if (!panelWrap) {
            panelWrap = document.createElement("section");
            panelWrap.className = "live-wrap";
            slot.innerHTML = "";
            slot.appendChild(panelWrap);
          }
          global.Stats.renderLive(panelWrap, st);
        } else {
          slot.innerHTML = "";
        }

        /* a scan just finished → refresh the snapshot list */
        if (lastScanning === true && scanning === false) {
          loadSnapshots();
        }
        lastScanning = scanning;
      })
      .catch(function () {
        /* status polling failures are non-fatal; keep the dashboard usable */
      });
  }

  /* ====================================================================== *
   * SCAN DETAIL                                                            *
   * ====================================================================== */
  var detailState = null; // { ts, sb, statsCollapsed }

  function renderScanDetail(ts, focusPath) {
    clearPoll();

    appEl.innerHTML =
      header() +
      '<main class="page page-scan">' +
      '<nav class="crumbtrail">' +
      '<a href="#/" class="crumbtrail-link">Dashboard</a>' +
      '<span class="crumbtrail-sep">/</span>' +
      '<span class="crumbtrail-here mono">' +
      U.esc(ts) +
      "</span>" +
      "</nav>" +
      '<h1 class="scan-title">Scan <span class="mono">' +
      U.esc(ts) +
      "</span></h1>" +
      /* collapsible stats panel */
      '<section class="stats-block">' +
      '<button class="stats-toggle" id="stats-toggle" type="button" ' +
      'aria-expanded="true">' +
      '<span class="stats-toggle-caret" aria-hidden="true">▾</span>' +
      '<span class="stats-toggle-label">Scan statistics</span>' +
      "</button>" +
      '<div class="stats-body" id="stats-body">' +
      spinner("Loading statistics…") +
      "</div>" +
      "</section>" +
      /* interactive results view */
      '<section class="results-block">' +
      '<div class="section-head">' +
      '<h2 class="section-title">Disk usage map</h2>' +
      "</div>" +
      '<div id="sunburst-slot">' +
      spinner("Building usage map…") +
      "</div>" +
      "</section>" +
      "</main>";

    detailState = { ts: ts, sb: null, focusPath: focusPath || "" };

    /* collapsible stats panel wiring */
    var toggle = document.getElementById("stats-toggle");
    var body = document.getElementById("stats-body");
    toggle.addEventListener("click", function () {
      var open = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!open));
      body.classList.toggle("collapsed", open);
    });

    loadStats(ts, body);
    loadTree(ts, focusPath);
  }

  function loadStats(ts, body) {
    apiGet("stats", { ts: ts })
      .then(function (stats) {
        if (!body.isConnected) return;
        global.Stats.renderFrozen(body, stats);
      })
      .catch(function (err) {
        if (!body.isConnected) return;
        body.innerHTML = "";
        body.appendChild(
          errorBox(err.message, function () {
            body.innerHTML = spinner("Loading statistics…");
            loadStats(ts, body);
          })
        );
      });
  }

  function loadTree(ts, focusPath) {
    var slot = document.getElementById("sunburst-slot");
    if (!slot) return;
    apiGet("tree", { ts: ts })
      .then(function (data) {
        if (!slot.isConnected) return;
        var node = data && data.node;
        if (!node) throw new Error("Scan tree is empty or unavailable.");
        slot.innerHTML = "";
        mountSunburst(slot, ts, node, focusPath);
      })
      .catch(function (err) {
        if (!slot.isConnected) return;
        slot.innerHTML = "";
        slot.appendChild(
          errorBox(err.message, function () {
            slot.innerHTML = spinner("Building usage map…");
            loadTree(ts, focusPath);
          })
        );
      });
  }

  function mountSunburst(slot, ts, rootNode, focusPath) {
    var sb = global.Sunburst(slot, {
      /* When the chart's focus changes, write it into the URL hash. We use
       * replaceState-style behaviour by setting location.hash; the resulting
       * hashchange is recognised as self-originated and ignored. */
      onFocusChange: function (path) {
        var hash = "#/scan/" + encodeURIComponent(ts);
        if (path) hash += "/" + encodeURIComponent(path);
        suppressHash = hash;
        if (location.hash !== hash) location.hash = hash;
      },
      /* Lazy subtree loader for truncated / (other) nodes. */
      fetchSubtree: function (path) {
        return apiGet("tree", { ts: ts, path: path }).then(function (data) {
          if (!data || !data.node)
            throw new Error("Subtree unavailable for " + path);
          return data.node;
        });
      }
    });

    sb.setData(rootNode);
    detailState.sb = sb;

    /* apply any focus path from the URL */
    if (focusPath) sb.focusByPath(focusPath);
  }

  /* ====================================================================== *
   * COMPARE                                                                *
   * ====================================================================== */
  function renderCompare(base, cur) {
    clearPoll();
    detailState = null;

    appEl.innerHTML =
      header() +
      '<main class="page page-compare">' +
      '<nav class="crumbtrail">' +
      '<a href="#/" class="crumbtrail-link">Dashboard</a>' +
      '<span class="crumbtrail-sep">/</span>' +
      '<span class="crumbtrail-here">Compare scans</span>' +
      "</nav>" +
      '<h1 class="scan-title">Compare scans</h1>' +
      '<div id="compare-slot">' +
      spinner("Loading comparison…") +
      "</div>" +
      "</main>";

    var slot = document.getElementById("compare-slot");
    if (!global.ComparePage) {
      slot.innerHTML = "";
      slot.appendChild(errorBox("Comparison module failed to load."));
      return;
    }
    global.ComparePage.render(slot, {
      base: base || "",
      cur: cur || "",
      /* selector changes flow back through the hash so a comparison is
       * shareable and survives back/forward. */
      onNavigate: function (b, c) {
        var hash = "#/compare";
        if (b && c)
          hash += "/" + encodeURIComponent(b) + "/" + encodeURIComponent(c);
        if (location.hash === hash) route();
        else location.hash = hash;
      }
    });
  }

  /* ====================================================================== *
   * ROUTER                                                                 *
   * ====================================================================== */
  /* When app.js itself writes the hash (focus sync), we record it here so
   * the resulting hashchange does not trigger a full re-route. */
  var suppressHash = null;

  function parseHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h || h === "/") return { route: "dashboard" };

    var parts = h.split("/").filter(function (p) {
      return p.length > 0;
    });
    /* parts: ["scan", "<ts>", "<encoded path>"?] */
    if (parts[0] === "scan" && parts[1]) {
      return {
        route: "scan",
        ts: decodeURIComponent(parts[1]),
        focusPath: parts[2] ? decodeURIComponent(parts[2]) : ""
      };
    }
    if (parts[0] === "compare") {
      return {
        route: "compare",
        base: parts[1] ? decodeURIComponent(parts[1]) : "",
        cur: parts[2] ? decodeURIComponent(parts[2]) : ""
      };
    }
    return { route: "dashboard" };
  }

  function route() {
    var current = location.hash;

    /* Self-originated hash write (focus sync) — just drive the chart. */
    if (suppressHash !== null && current === suppressHash) {
      suppressHash = null;
      return;
    }
    suppressHash = null;

    var r = parseHash();

    if (r.route === "scan") {
      /* If we're already on this scan's detail page, just move the focus
       * instead of rebuilding everything — keeps back/forward smooth. */
      if (
        detailState &&
        detailState.ts === r.ts &&
        detailState.sb &&
        document.getElementById("sunburst-slot")
      ) {
        detailState.focusPath = r.focusPath;
        detailState.sb.focusByPath(r.focusPath || "");
        return;
      }
      detailState = null;
      renderScanDetail(r.ts, r.focusPath);
    } else if (r.route === "compare") {
      renderCompare(r.base, r.cur);
    } else {
      detailState = null;
      renderDashboard();
    }
  }

  /* Browser back/forward + in-app navigation both flow through hashchange. */
  global.addEventListener("hashchange", route);
  global.addEventListener("DOMContentLoaded", function () {
    if (!location.hash) location.hash = "#/";
    route();
  });

  /* If the document is already parsed (script at end of body), route now. */
  if (document.readyState !== "loading") {
    if (!location.hash) location.hash = "#/";
    route();
  }
})(window);
