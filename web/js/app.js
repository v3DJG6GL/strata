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
  /* API helpers + spinner/errorBox fragments live in util.js so the compare
   * page and the dashboard can't drift on the same response contract. */
  var apiGet = U.apiGet;
  var spinner = U.spinnerHTML;
  var errorBox = U.errorBox;

  /* ---- DOM root --------------------------------------------------------- */
  var appEl = document.getElementById("app");

  /* Live-scan polling handle for the dashboard. */
  var pollTimer = null;
  var pollInFlight = false;
  var lastScanning = null;
  /* 1s ticker for the idle next-scan countdown (only one ever runs). */
  var countdownTimer = null;

  /* Handle returned by ComparePage.render — used to tear down the embedded
   * sunburst (body-pinned tooltip + ResizeObserver) when leaving /compare. */
  var compareHandle = null;

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

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function clearPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    clearCountdown();
  }

  /* ====================================================================== *
   * DASHBOARD                                                              *
   * ====================================================================== */
  /* Active scan-path scope ("" = all paths) + the last op=snapshots payload,
   * cached so a scope flip re-renders in place without a refetch. */
  var dashScope = "";
  var lastSnapsData = null;

  /* One small "scoped to <path>" tag per affected section title, so a
   * scrolled screenshot can never be misread as an all-paths total. */
  function scopeTagHTML(id) {
    return (
      '<span class="scope-tag" id="' + id + '" hidden>' +
      '<span class="scope-tag-dot"></span>' +
      '<span class="scope-tag-path mono"></span></span>'
    );
  }

  function updateScopeTags() {
    ["trend-scope-tag", "snap-scope-tag"].forEach(function (id) {
      var tag = document.getElementById(id);
      if (!tag) return;
      if (dashScope) {
        tag.hidden = false;
        tag.title = dashScope;
        tag.querySelector(".scope-tag-dot").style.background =
          U.rootColor(dashScope);
        tag.querySelector(".scope-tag-path").textContent =
          U.shortPath(dashScope, 40);
      } else {
        tag.hidden = true;
      }
    });
  }

  function renderDashboard(scope) {
    clearPoll();
    /* Fresh mount — drop any cross-route scan-state so the first poll tick
     * after a scan-detail → dashboard return doesn't trip the just-finished
     * branch (which would fire a redundant loadSnapshots). */
    lastScanning = null;
    dashScope = scope || "";
    lastSnapsData = null;
    appEl.innerHTML =
      header() +
      '<main class="page page-dashboard">' +
      '<div id="scope-slot"></div>' +
      '<div id="live-slot"></div>' +
      '<section class="trend-section" id="trend-section" hidden>' +
      '<div class="section-head">' +
      '<h2 class="section-title">Storage over time</h2>' +
      scopeTagHTML("trend-scope-tag") +
      '<div class="section-head-right" id="trend-controls"></div>' +
      "</div>" +
      '<div id="trend-slot"></div>' +
      "</section>" +
      '<section class="snap-section">' +
      '<div class="section-head">' +
      '<h2 class="section-title">Snapshots</h2>' +
      scopeTagHTML("snap-scope-tag") +
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

  /* Scope change → persist, sync the URL (suppressed: the dashboard is
   * already mounted), re-render the scoped panels from cached data. */
  function setDashScope(scope) {
    scope = scope || "";
    if (scope === dashScope) return;
    dashScope = scope;
    U.scopeSave(scope);
    var hash = scope ? "#/?scope=" + encodeURIComponent(scope) : "#/";
    suppressHash = hash;
    if (location.hash !== hash) location.hash = hash;
    else suppressHash = null;
    if (lastSnapsData) renderSnapshotList(lastSnapsData);
  }

  /* Rebuild the scope rail. Returns silently for <2 known roots (the rail
   * costs single-path deployments nothing). An unknown scoped path (edited
   * STRATA_SCAN_PATHS, stale link) falls back to All with a notice. */
  function renderScopeRail(snaps) {
    var slot = document.getElementById("scope-slot");
    if (!slot) return;
    var roots = U.rootUnion(snaps);

    var notice = null;
    if (
      dashScope &&
      !roots.some(function (r) {
        return r.path === dashScope;
      })
    ) {
      notice = dashScope;
      dashScope = "";
      U.scopeSave("");
      /* replaceState: fix the URL without a history entry or a re-route */
      if (global.history && global.history.replaceState) {
        global.history.replaceState(null, "", "#/");
      }
    }

    slot.innerHTML = "";
    var rail = U.scopeRail(roots, dashScope, setDashScope);
    if (rail) slot.appendChild(rail);
    if (notice && rail) {
      var n = document.createElement("div");
      n.className = "scope-notice";
      n.textContent =
        U.shortPath(notice, 48) +
        " is not part of any snapshot — showing all paths.";
      slot.appendChild(n);
    }
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

    lastSnapsData = data;
    var snaps = (data && data.snapshots) || [];
    if (countEl)
      countEl.textContent =
        snaps.length + (snaps.length === 1 ? " scan" : " scans");

    /* scope rail first — it validates dashScope (may reset it to All), and
     * everything rendered below must see the validated value. */
    renderScopeRail(snaps);
    updateScopeTags();

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
      var drawn = global.Trends.render(trendSlot, snaps, {
        scope: dashScope,
        onScopeChange: setDashScope
      });
      if (trendSec) trendSec.hidden = !drawn;
    }
  }

  function snapshotCard(s, index) {
    var total = s.total || {};
    var roots = s.roots || [];

    /* Scoped view: the card headlines the scoped root's numbers instead of
     * the combined totals, and links straight to the root-focused sunburst.
     * A snapshot that predates the scoped path shows an explicit gap rather
     * than silently falling back to the combined size. */
    var scopedRoot = null;
    if (dashScope) {
      roots.forEach(function (r) {
        if (r && r.path === dashScope) scopedRoot = r;
      });
    }

    var card = document.createElement("a");
    card.className = "snap-card";
    card.href =
      "#/scan/" +
      encodeURIComponent(s.ts) +
      (scopedRoot ? "/" + encodeURIComponent(dashScope) : "");
    card.style.animationDelay = Math.min(index * 45, 360) + "ms";

    /* card head */
    var head = document.createElement("div");
    head.className = "snap-card-head";
    head.innerHTML =
      '<div class="snap-card-label">' +
      U.esc(s.label || s.ts) +
      "</div>" +
      '<span class="badge badge-ok">tree</span>';
    card.appendChild(head);

    /* headline size */
    var hero = document.createElement("div");
    hero.className = "snap-card-hero";
    var heroSize = dashScope
      ? scopedRoot
        ? U.humanBytes(scopedRoot.size_actual)
        : "—"
      : U.humanBytes(total.size_actual);
    var heroLabel = dashScope
      ? scopedRoot
        ? 'on disk · <span class="mono">' +
          U.esc(U.shortPath(dashScope, 28)) +
          "</span>"
        : "path not in this scan"
      : "on disk";
    hero.innerHTML =
      '<span class="snap-card-size mono">' +
      U.esc(heroSize) +
      "</span>" +
      '<span class="snap-card-size-label">' +
      heroLabel +
      "</span>";
    card.appendChild(hero);

    /* metric strip — Files/Dirs follow the scope; Duration/DB are properties
     * of the whole scan, so under a scope they dim and say so. */
    var mFiles = dashScope ? (scopedRoot || {}).files : total.files;
    var mDirs = dashScope ? (scopedRoot || {}).dirs : total.dirs;
    var metrics = document.createElement("div");
    metrics.className = "snap-card-metrics";
    metrics.appendChild(
      metricCell(
        "Files",
        U.humanCount(mFiles),
        mFiles != null ? U.commaCount(mFiles) + " files" : null
      )
    );
    metrics.appendChild(
      metricCell(
        "Dirs",
        U.humanCount(mDirs),
        mDirs != null ? U.commaCount(mDirs) + " dirs" : null
      )
    );
    var durCell = metricCell("Duration", U.humanDuration(s.duration_sec));
    var dbCell = metricCell("DB", U.humanBytes(s.db_bytes));
    if (dashScope) {
      durCell.classList.add("is-global");
      dbCell.classList.add("is-global");
      durCell.title = "whole scan (not per-path)";
      dbCell.title = "whole scan (not per-path)";
    }
    metrics.appendChild(durCell);
    metrics.appendChild(dbCell);
    card.appendChild(metrics);

    /* per-root breakdown bar + list — segments wear each root's identity
     * colour (same colour as its trend series / scope chip); under a scope
     * the other roots dim instead of disappearing, keeping proportions. */
    if (roots.length) {
      var rootSum = roots.reduce(function (a, r) {
        return a + (Number(r.size_actual) || 0);
      }, 0);

      var bar = document.createElement("div");
      bar.className = "snap-card-bar";
      roots.forEach(function (r) {
        var seg = document.createElement("span");
        seg.className = "snap-card-bar-seg";
        var w = rootSum ? ((Number(r.size_actual) || 0) / rootSum) * 100 : 0;
        seg.style.width = w + "%";
        seg.style.background = U.rootColor(r.path);
        seg.style.opacity = dashScope && r.path !== dashScope ? "0.18" : "0.9";
        seg.title = r.path + " — " + U.humanBytes(r.size_actual);
        bar.appendChild(seg);
      });
      card.appendChild(bar);

      var rl = document.createElement("div");
      rl.className = "snap-card-roots";
      roots.forEach(function (r) {
        var rr = document.createElement("div");
        rr.className =
          "snap-card-root" +
          (dashScope
            ? r.path === dashScope
              ? " is-scoped"
              : " is-dim"
            : "");
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
    go.innerHTML = scopedRoot
      ? 'Explore <span class="mono">' +
        U.esc(U.shortPath(dashScope, 28)) +
        '</span> <span aria-hidden="true">→</span>'
      : 'Explore <span aria-hidden="true">→</span>';
    card.appendChild(go);

    return card;
  }

  function metricCell(label, value, title) {
    var c = document.createElement("div");
    c.className = "metric-cell";
    if (title) c.title = title;
    c.innerHTML =
      '<div class="metric-value mono">' +
      U.esc(value) +
      '</div><div class="metric-label">' +
      U.esc(label) +
      "</div>";
    return c;
  }

  /* Poll op=status; render the live panel and refresh the list on finish.
   * Guarded against in-flight stacking: a slow backend won't accumulate
   * pending requests every interval tick. */
  function pollStatus() {
    var slot = document.getElementById("live-slot");
    if (!slot) return; // navigated away
    if (pollInFlight) return;
    pollInFlight = true;
    apiGet("status")
      .then(function (st) {
        if (!slot.isConnected) return;
        var scanning = !!(st && st.scanning);

        if (scanning) {
          clearCountdown(); // a scan started → stop the idle ticker
          var panelWrap = slot.querySelector(".live-wrap");
          if (!panelWrap) {
            panelWrap = document.createElement("section");
            panelWrap.className = "live-wrap";
            slot.innerHTML = "";
            slot.appendChild(panelWrap);
          }
          global.Stats.renderLive(panelWrap, st);
        } else if (st && st.next_scan != null) {
          /* idle, but we know when the next scan is due → countdown card */
          var idleWrap = slot.querySelector(".live-wrap");
          if (!idleWrap) {
            idleWrap = document.createElement("section");
            idleWrap.className = "live-wrap";
            slot.innerHTML = "";
            slot.appendChild(idleWrap);
          }
          global.Stats.renderIdle(idleWrap, st);
          /* Re-anchor to server time each poll so a skewed client clock can't
           * drift the displayed countdown; restart the single 1s ticker. */
          var serverNow =
            st.server_now != null ? st.server_now : Math.floor(Date.now() / 1000);
          var skew = serverNow - Math.floor(Date.now() / 1000);
          var tick = function () {
            if (!idleWrap.isConnected) {
              clearCountdown();
              return;
            }
            var rem = st.next_scan - (Math.floor(Date.now() / 1000) + skew);
            global.Stats.updateCountdown(idleWrap, rem, st);
          };
          clearCountdown();
          countdownTimer = setInterval(tick, 1000);
          tick(); // paint immediately, don't wait a second
        } else {
          clearCountdown();
          if (slot.firstChild) slot.innerHTML = "";
        }

        /* a scan just finished → refresh the snapshot list */
        if (lastScanning === true && scanning === false) {
          loadSnapshots();
        }
        lastScanning = scanning;
      })
      .catch(function () {
        /* status polling failures are non-fatal; keep the dashboard usable */
      })
      .then(function () {
        pollInFlight = false;
      });
  }

  /* ====================================================================== *
   * SCAN DETAIL                                                            *
   * ====================================================================== */
  var detailState = null; // { ts, sb, focusPath }

  /* Tear down the current scan-detail Sunburst before swapping pages.
   * Without this the chart's tooltip (attached to <body>), ResizeObserver,
   * toolbar listener, and pending-fetch map all leak across navigations. */
  function clearDetail() {
    if (detailState && detailState.sb && detailState.sb.destroy) {
      try { detailState.sb.destroy(); } catch (e) { /* defensive */ }
    }
    detailState = null;
  }

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
  function clearTrends() {
    if (global.Trends && global.Trends.destroy) global.Trends.destroy();
  }

  function clearCompare() {
    if (compareHandle && compareHandle.destroy) {
      try { compareHandle.destroy(); } catch (e) { /* defensive */ }
    }
    compareHandle = null;
  }

  function renderCompare(base, cur, scope) {
    clearPoll();
    clearDetail();
    clearTrends();
    clearCompare();

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
    function compareHash(b, c, sc) {
      var hash = "#/compare";
      if (b && c)
        hash += "/" + encodeURIComponent(b) + "/" + encodeURIComponent(c);
      if (sc) hash += "?scope=" + encodeURIComponent(sc);
      return hash;
    }

    compareHandle = global.ComparePage.render(slot, {
      base: base || "",
      cur: cur || "",
      scope: scope || "",
      /* selector changes flow back through the hash so a comparison is
       * shareable and survives back/forward. */
      onNavigate: function (b, c, sc) {
        var hash = compareHash(b, c, sc);
        if (location.hash === hash) route();
        else location.hash = hash;
      },
      /* scope flips re-render in place (op=compare data is scope-independent);
       * the hash is updated without a re-route, mirroring the sunburst's
       * focus sync. */
      onScopeSync: function (b, c, sc) {
        var hash = compareHash(b, c, sc);
        suppressHash = hash;
        if (location.hash !== hash) location.hash = hash;
        else suppressHash = null;
      }
    });
  }

  /* ====================================================================== *
   * ROUTER                                                                 *
   * ====================================================================== */
  /* When app.js itself writes the hash (focus sync), we record it here so
   * the resulting hashchange does not trigger a full re-route. */
  var suppressHash = null;

  /* decodeURIComponent throws URIError on truncated/garbled %-escapes;
   * a single bad hash would otherwise propagate out of route() and
   * freeze the SPA on whatever was previously rendered (or the boot
   * splash, if the bad hash was the entry URL). */
  function decodePart(s) {
    try {
      return decodeURIComponent(s);
    } catch (_) {
      return s;
    }
  }

  function parseHash() {
    var h = location.hash.replace(/^#/, "");

    /* Hash-query (e.g. "#/?scope=%2Fmnt%2Fdata"): split it off BEFORE the
     * path-segment parse so a query can never corrupt ts/path decoding. */
    var scope = "";
    var qi = h.indexOf("?");
    if (qi >= 0) {
      h.slice(qi + 1)
        .split("&")
        .forEach(function (kv) {
          var eq = kv.indexOf("=");
          if ((eq >= 0 ? kv.slice(0, eq) : kv) === "scope") {
            scope = decodePart(eq >= 0 ? kv.slice(eq + 1) : "");
          }
        });
      h = h.slice(0, qi);
    }

    if (!h || h === "/") return { route: "dashboard", scope: scope };

    var parts = h.split("/").filter(function (p) {
      return p.length > 0;
    });
    /* parts: ["scan", "<ts>", "<encoded path>"?] */
    if (parts[0] === "scan" && parts[1]) {
      return {
        route: "scan",
        ts: decodePart(parts[1]),
        focusPath: parts[2] ? decodePart(parts[2]) : ""
      };
    }
    if (parts[0] === "compare") {
      return {
        route: "compare",
        base: parts[1] ? decodePart(parts[1]) : "",
        cur: parts[2] ? decodePart(parts[2]) : "",
        scope: scope
      };
    }
    return { route: "dashboard", scope: scope };
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
      clearDetail();
      clearTrends();
      clearCompare();
      renderScanDetail(r.ts, r.focusPath);
    } else if (r.route === "compare") {
      renderCompare(r.base, r.cur, r.scope);
    } else {
      clearDetail();
      clearCompare();
      renderDashboard(r.scope);
    }
  }

  /* Browser back/forward + in-app navigation both flow through hashchange. */
  global.addEventListener("hashchange", route);

  /* Boot: pick exactly one of DOMContentLoaded vs the immediate path. With
   * readyState === "interactive" (common when this script runs at end of
   * body) both would otherwise fire route() and stack two cold-load renders. */
  function boot() {
    /* Seed the canonical hash without firing hashchange — assigning
     * location.hash would queue a second route() on top of the sync one. */
    if (!location.hash && global.history && global.history.replaceState) {
      global.history.replaceState(null, "", "#/");
    } else if (!location.hash) {
      location.hash = "#/";
    }
    /* Restore the last scan-path scope on a bare entry URL — ONLY here at
     * boot. After boot the URL alone drives scope, so Back/Forward across
     * "#/?scope=…" ↔ "#/" behaves; adopting localStorage on every route
     * would make a bare "#/" reached via Back snap back to the saved scope. */
    var savedScope = U.scopeLoad();
    if (
      savedScope &&
      location.hash === "#/" &&
      global.history &&
      global.history.replaceState
    ) {
      global.history.replaceState(
        null,
        "",
        "#/?scope=" + encodeURIComponent(savedScope)
      );
    }
    route();
  }
  if (document.readyState === "loading") {
    global.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(window);
