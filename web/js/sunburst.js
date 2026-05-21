/* ==========================================================================
 * sunburst.js — zoomable D3 v7 sunburst for DUC Advanced
 *
 * Hand-rolled per the canonical D3 "Zoomable Sunburst" technique, extended
 * with: lazy subtree loading, a tooltip on EVERY arc, a clickable breadcrumb,
 * a children details side panel, ancestor highlighting and an actual/apparent
 * size toggle.
 *
 *   const sb = Sunburst(svgContainerEl, {
 *     onFocusChange: (path) => {},          // called when focus changes
 *     fetchSubtree:  (path) => Promise<node> // resolve a fuller child set
 *   });
 *   sb.setData(rootNode);
 *   sb.focusByPath(path);
 *
 * Depends on: d3 (v7 global), Util.
 * ======================================================================== */
(function (global) {
  "use strict";

  var U = global.Util;
  var d3 = global.d3;

  /* Label sizing, in SVG user units. The CSS .sb-label font-size must match
   * LABEL_FONT so the arc-fit math below stays accurate. */
  var LABEL_FONT = 15;
  var LABEL_CHAR_W = LABEL_FONT * 0.6; // approx monospace glyph advance
  var LABEL_MIN_CHARS = 3; // hide a label that cannot fit at least this many
  /* Zoom transition duration. */
  var TWEEN_MS = 750;

  function Sunburst(containerEl, opts) {
    opts = opts || {};

    /* ---- mutable state -------------------------------------------------- */
    var rawRoot = null; // the raw data tree we own & mutate (graft lazy kids)
    var root = null; // current d3.hierarchy
    var focusNode = null; // currently focused hierarchy node
    var sizeKey = "size_actual"; // or "size_apparent"
    var subtreeCache = {}; // path -> children array (lazy fetch cache)
    var pendingFetch = {}; // path -> true while a fetch is in flight
    var totalSize = 1; // scan-total size for "% of scan" tooltip math
    var ringCount = 2; // rings of children rendered at once (2..5)
    var hlMode = "dedupe"; // hard-link view: "dedupe" | "copies" | "exclusive"

    /* ---- DOM scaffold --------------------------------------------------- */
    containerEl.classList.add("sb-root");
    containerEl.innerHTML = "";

    /* breadcrumb bar */
    var crumbBar = el("div", "sb-crumbs");
    containerEl.appendChild(crumbBar);

    /* layout: chart on the left, details panel on the right */
    var layout = el("div", "sb-layout");
    containerEl.appendChild(layout);

    var chartWrap = el("div", "sb-chart");
    layout.appendChild(chartWrap);

    /* toolbar — segmented view controls */
    var toolbar = el("div", "sb-toolbar");

    function ctlGroup(label, group, items, active, cls) {
      var html =
        '<div class="sb-ctl' + (cls ? " " + cls : "") + '">' +
        '<span class="sb-ctl-label">' + label + "</span>" +
        '<div class="sb-toggle" role="group">';
      items.forEach(function (it) {
        html +=
          '<button type="button" data-g="' + group + '" data-v="' + it[0] + '"' +
          (it[0] === active ? ' class="active"' : "") + ">" + it[1] + "</button>";
      });
      return html + "</div></div>";
    }

    toolbar.innerHTML =
      ctlGroup("SIZE", "size",
        [["size_actual", "Actual"], ["size_apparent", "Apparent"]],
        "size_actual", "sb-ctl-layout") +
      ctlGroup("HARD LINKS", "hl",
        [["dedupe", "Deduped"], ["copies", "+ Copies"], ["exclusive", "Exclusive"]],
        "dedupe", "sb-ctl-layout") +
      ctlGroup("RINGS", "rings",
        [["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]], "2") +
      ctlGroup("SCALE", "scale",
        [["s", "S"], ["m", "M"], ["l", "L"], ["full", "Full"]], "l");
    chartWrap.appendChild(toolbar);
    /* compare mode lays the chart out itself — hide the layout-only controls */
    if (opts.compareMode) {
      toolbar.querySelectorAll(".sb-ctl-layout").forEach(function (g) {
        g.style.display = "none";
      });
    }

    var svgHost = el("div", "sb-svg-host");
    chartWrap.appendChild(svgHost);

    var detailsPanel = el("div", "sb-details");
    layout.appendChild(detailsPanel);

    /* tooltip — fixed-position, follows cursor */
    var tip = el("div", "sb-tip");
    tip.style.display = "none";
    document.body.appendChild(tip);

    /* ---- D3 svg --------------------------------------------------------- */
    var size = 720; // logical viewBox size
    // ring band thickness — center disc + ringCount rings span the radius
    var radius = size / (2 * (ringCount + 1));

    var svg = d3
      .select(svgHost)
      .append("svg")
      .attr("class", "sb-svg sb-scale-l")
      .attr("viewBox", [-size / 2, -size / 2, size, size])
      .attr("preserveAspectRatio", "xMidYMid meet");

    var gArcs = svg.append("g").attr("class", "sb-arcs");
    var gLabels = svg
      .append("g")
      .attr("class", "sb-labels")
      .attr("pointer-events", "none")
      .attr("text-anchor", "middle");

    /* center disc — zoom-out target */
    var centerG = svg.append("g").attr("class", "sb-center");
    var centerCircle = centerG
      .append("circle")
      .attr("r", radius)
      .attr("class", "sb-center-circle");
    var centerLabel = centerG
      .append("text")
      .attr("class", "sb-center-label")
      .attr("text-anchor", "middle")
      .attr("dy", "-0.2em");
    var centerSub = centerG
      .append("text")
      .attr("class", "sb-center-sub")
      .attr("text-anchor", "middle")
      .attr("dy", "1.1em");
    var centerHint = centerG
      .append("text")
      .attr("class", "sb-center-hint")
      .attr("text-anchor", "middle")
      .attr("dy", "2.6em");

    /* spinner ring (shown over a ring while lazily loading) */
    var spinner = svg
      .append("g")
      .attr("class", "sb-spinner")
      .style("display", "none");
    var spinnerRing = spinner
      .append("circle")
      .attr("r", radius * 1.55)
      .attr("class", "sb-spinner-ring");

    /* arc generator (paddingless inner gap for crispness) */
    var arc = d3
      .arc()
      .startAngle(function (d) {
        return d.x0;
      })
      .endAngle(function (d) {
        return d.x1;
      })
      .padAngle(function (d) {
        return Math.min((d.x1 - d.x0) / 2, 0.004);
      })
      .padRadius(function () {
        return radius * 1.5;
      })
      .innerRadius(function (d) {
        return d.y0 * radius;
      })
      .outerRadius(function (d) {
        return Math.max(d.y0 * radius, d.y1 * radius - 1);
      });

    /* ---- color --------------------------------------------------------- */
    /* Categorical hue per depth-1 directory; descendants share the hue with
     * a lightness ramp by depth. (other) buckets are neutral grey. */
    var hueScale = d3.scaleOrdinal(
      d3.quantize(d3.interpolateRainbow, 12).map(function (c) {
        return c;
      })
    );
    var hueAssign = {}; // depth-1 name -> base color
    var hueIndex = 0;

    function colorFor(d) {
      var data = d.data || {};
      if (data.other) return "#6e7681"; // neutral grey for (other)
      if (data._files) return "#363b44"; // synthetic "own files" wedge
      // walk up to the depth-1 ancestor
      var anc = d;
      while (anc.depth > 1 && anc.parent) anc = anc.parent;
      if (anc.depth === 0) return "#30363d";
      var keyName = (anc.data && anc.data.name) || "root";
      if (!(keyName in hueAssign)) {
        hueAssign[keyName] = hueScale(hueIndex++);
      }
      var base = d3.hsl(hueAssign[keyName]);
      base.s = Math.max(0.32, Math.min(0.62, base.s));
      // lightness ramp: deeper = lighter, capped
      var lvl = Math.max(0, d.depth - 1);
      base.l = Math.min(0.74, 0.42 + lvl * 0.085);
      return base.formatHex();
    }

    /* ---- helpers -------------------------------------------------------- */
    function el(tag, cls) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    /* The size value used for layout, honoring the size-type and hard-link
     * view toggles. Falls back gracefully for trees without the newer
     * exclusive/copy fields. */
    function nodeSize(data) {
      if (!data) return 0;
      var ap = sizeKey === "size_apparent";
      var base = Number(
        (ap ? data.size_apparent : data.size_actual) || data.size_actual || 0
      );
      if (hlMode === "exclusive") {
        var ex = ap ? data.exclusive_apparent : data.exclusive_actual;
        return ex != null ? Number(ex) : base;
      }
      if (hlMode === "copies") {
        var cp = ap ? data.copy_apparent : data.copy_actual;
        return base + (cp != null ? Number(cp) : 0);
      }
      return base;
    }

    /* Does this data node have real, expandable children present? */
    function hasChildren(data) {
      return data && data.children && data.children.length > 0;
    }

    /* ---- hierarchy / partition ----------------------------------------- */
    /* Key invariant: a directory's arc angle ∝ its own size_actual, and its
     * children fit within its angular span (duc child sizes sum to ≤ parent).
     * We give every node a synthetic leaf-value equal to its own size minus
     * the sum of its children's sizes — that remainder represents the
     * directory's own files. We then add an explicit "·files·" leaf child so
     * the partition's children exactly fill the parent. */
    function buildHierarchy() {
      /* Deep-ish clone wrapper so we can inject synthetic children without
       * mutating rawRoot's child arrays permanently. We build a parallel
       * structure referencing the same data objects. */
      function wrap(dataNode) {
        var kids = (dataNode.children || []).slice();
        var node = { data: dataNode, children: [] };
        var ownSize = nodeSize(dataNode);
        if (kids.length) {
          var childSum = 0;
          kids.forEach(function (k) {
            childSum += nodeSize(k);
          });
          kids.forEach(function (k) {
            node.children.push(wrap(k));
          });
          var remainder = ownSize - childSum;
          /* Only add a "own files" wedge when it is a meaningful slice. */
          if (remainder > 0 && remainder > ownSize * 0.001) {
            node.children.push({
              data: {
                name: "·files·",
                _files: true,
                path: dataNode.path || "",
                size_actual: remainder,
                size_apparent: remainder,
                count: null,
                children: []
              },
              children: []
            });
          }
        }
        node._leafValue = node.children.length ? 0 : ownSize;
        return node;
      }

      var wrapped = wrap(rawRoot);

      var h = d3
        .hierarchy(wrapped, function (d) {
          return d.children && d.children.length ? d.children : null;
        })
        .sum(function (d) {
          return d.children && d.children.length ? 0 : d._leafValue || 0;
        })
        .sort(function (a, b) {
          return b.value - a.value;
        });

      /* Flatten our wrapper: expose the real data node as d.data so the rest
       * of the component reads `d.data.name`, `d.data.path`, etc. */
      h.each(function (d) {
        d.data = d.data.data;
      });

      /* size[1] MUST be (height + 1): it makes d3.partition emit integer
       * ring depths for y0/y1 (0,1,2,…). arcVisible() and the arc radii
       * depend on that — a fixed cap here makes every arc fail y1<=3 and
       * render fully transparent. */
      d3.partition().size([2 * Math.PI, h.height + 1])(h);

      /* Each node remembers its layout as both `current` and `target`. */
      h.each(function (d) {
        d.current = { x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 };
        d.target = { x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 };
      });
      return h;
    }

    /* ---- focus geometry ------------------------------------------------- */
    /* Re-project every node's `target` relative to `p` (the focus). */
    function project(p) {
      root.each(function (d) {
        d.target = {
          x0:
            Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0 || 1))) *
            2 *
            Math.PI,
          x1:
            Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0 || 1))) *
            2 *
            Math.PI,
          y0: Math.max(0, d.y0 - p.depth),
          y1: Math.max(0, d.y1 - p.depth)
        };
      });
    }

    function arcVisible(d) {
      return d.y0 >= 1 && d.y1 <= ringCount + 1 && d.x1 > d.x0;
    }

    /* Monospace chars that fit tangentially along an arc's mid-radius band. */
    function arcChars(c) {
      var midR = ((c.y0 + c.y1) / 2) * radius;
      return Math.floor(((c.x1 - c.x0) * midR) / LABEL_CHAR_W);
    }

    /* A label shows only if its arc is visible AND wide enough for a few
     * chars — this is what stops tiny slices from stacking unreadable
     * fragments (e.g. on the collapsed 0° seam). */
    function labelVisible(c) {
      return arcVisible(c) && arcChars(c) >= LABEL_MIN_CHARS;
    }

    /* Fit a node's name to its arc; ellipsize only when it genuinely cannot
     * fit, and return "" when the arc is too small for any label at all. */
    function labelText(node, c) {
      var name =
        node.data && node.data.name != null ? String(node.data.name) : "";
      var max = arcChars(c);
      if (max < LABEL_MIN_CHARS) return "";
      if (name.length <= max) return name;
      return name.slice(0, Math.max(1, max - 1)) + "…";
    }

    function labelTransform(d) {
      var x = (((d.x0 + d.x1) / 2) * 180) / Math.PI;
      var y = ((d.y0 + d.y1) / 2) * radius;
      return (
        "rotate(" +
        (x - 90) +
        ") translate(" +
        y +
        ",0) rotate(" +
        (x < 180 ? 0 : 180) +
        ")"
      );
    }

    function ellipsize(text, maxChars) {
      if (text == null) return "";
      text = String(text);
      if (text.length <= maxChars) return text;
      return text.slice(0, Math.max(1, maxChars - 1)) + "…";
    }

    /* ---- render --------------------------------------------------------- */
    function render() {
      var nodes = root.descendants().filter(function (d) {
        return d.depth > 0; // skip synthetic root (it's the center disc)
      });

      /* ARCS */
      var paths = gArcs.selectAll("path.sb-arc").data(nodes, nodeKey);

      paths
        .exit()
        .transition()
        .duration(TWEEN_MS / 2)
        .style("opacity", 0)
        .remove();

      var pathsEnter = paths
        .enter()
        .append("path")
        .attr("class", "sb-arc")
        .attr("fill-rule", "evenodd")
        .style("cursor", "pointer")
        .on("click", onArcClick)
        .on("mousemove", onArcMove)
        .on("mouseenter", onArcEnter)
        .on("mouseleave", onArcLeave);

      var pathsAll = pathsEnter.merge(paths);

      pathsAll
        .attr("fill", opts.color || colorFor)
        .attr("fill-opacity", function (d) {
          return arcVisible(d.current) ? arcOpacity(d) : 0;
        })
        .attr("stroke-opacity", function (d) {
          return arcVisible(d.current) ? 1 : 0;
        })
        .attr("pointer-events", function (d) {
          return arcVisible(d.current) ? "auto" : "none";
        })
        .attr("d", function (d) {
          return arc(d.current);
        });

      /* LABELS */
      var labels = gLabels.selectAll("text.sb-label").data(nodes, nodeKey);
      labels.exit().remove();
      var labelsEnter = labels
        .enter()
        .append("text")
        .attr("class", "sb-label")
        .attr("dy", "0.32em");
      var labelsAll = labelsEnter.merge(labels);
      labelsAll
        .attr("fill-opacity", function (d) {
          return labelVisible(d.current) ? 1 : 0;
        })
        .attr("transform", function (d) {
          return labelTransform(d.current);
        })
        .text(function (d) {
          return labelText(d, d.current);
        });

      updateCenter();
      renderCrumbs();
      renderDetails();
    }

    function nodeKey(d) {
      /* Stable key across rebuilds: path + name + depth. */
      return (
        (d.data && d.data.path) +
        "|" +
        (d.data && d.data.name) +
        "|" +
        d.depth
      );
    }

    function arcOpacity(d) {
      if (d.data && d.data._files) return 0.32;
      if (d.data && d.data.other) return 0.7;
      return d.children ? 0.92 : 0.78;
    }

    /* ---- center disc ---------------------------------------------------- */
    function updateCenter() {
      var f = focusNode;
      var atRoot = f === root;
      centerG.style("cursor", atRoot ? "default" : "pointer");
      centerCircle.classed("sb-center-clickable", !atRoot);

      var name = atRoot
        ? "(scan)"
        : ellipsize(f.data.name || f.data.path || "/", 18);
      centerLabel.text(name);
      centerSub.text(U.humanBytes(nodeSize(f.data)));
      centerHint.text(atRoot ? "" : "↑ click to zoom out");

      centerG.on("click", function () {
        if (focusNode && focusNode.parent) zoomTo(focusNode.parent);
      });
      centerG
        .on("mousemove", function (event) {
          showTip(event, f);
        })
        .on("mouseleave", hideTip);
    }

    /* ---- breadcrumb ----------------------------------------------------- */
    function renderCrumbs() {
      crumbBar.innerHTML = "";
      var chain = focusNode.ancestors().reverse(); // root → focus
      chain.forEach(function (node, i) {
        if (i > 0) {
          var sep = el("span", "sb-crumb-sep");
          sep.textContent = "›";
          crumbBar.appendChild(sep);
        }
        var crumb = el("button", "sb-crumb");
        if (node === focusNode) crumb.classList.add("sb-crumb-active");
        crumb.type = "button";
        crumb.textContent =
          node.depth === 0
            ? "(scan)"
            : node.data.name || node.data.path || "/";
        crumb.title = node.data.path || "(scan root)";
        crumb.addEventListener("click", function () {
          zoomTo(node);
        });
        crumbBar.appendChild(crumb);
      });
    }

    /* ---- details side panel -------------------------------------------- */
    function renderDetails() {
      detailsPanel.innerHTML = "";
      var f = focusNode;

      var head = el("div", "sb-details-head");
      head.innerHTML =
        '<div class="sb-details-title">' +
        U.esc(f.depth === 0 ? "(scan)" : f.data.name || "/") +
        "</div>" +
        '<div class="sb-details-path mono">' +
        U.esc(f.data.path || "(scan root)") +
        "</div>";
      detailsPanel.appendChild(head);

      /* focus summary stats */
      var fSize = nodeSize(f.data);
      var summary = el("div", "sb-details-summary");
      summary.appendChild(stat("Size", U.humanBytes(fSize)));
      summary.appendChild(
        stat(
          "% of scan",
          U.pctStr(fSize, totalSize)
        )
      );
      summary.appendChild(
        stat(
          "Items",
          f.data.count != null ? U.commaCount(f.data.count) : "—"
        )
      );
      detailsPanel.appendChild(summary);

      var listHead = el("div", "sb-details-listhead");
      listHead.textContent = "Children by size";
      detailsPanel.appendChild(listHead);

      var list = el("div", "sb-details-list");
      detailsPanel.appendChild(list);

      var kids = (f.children || [])
        .slice()
        .sort(function (a, b) {
          return nodeSize(b.data) - nodeSize(a.data);
        });

      if (!kids.length) {
        var empty = el("div", "sb-details-empty");
        empty.textContent =
          f.data && f.data.truncated
            ? "No children loaded yet."
            : "This directory has no further breakdown.";
        detailsPanel.appendChild(empty);
        return;
      }

      var maxKid = nodeSize(kids[0].data) || 1;
      kids.forEach(function (k) {
        var ksize = nodeSize(k.data);
        var rowEl = el("button", "sb-row");
        rowEl.type = "button";
        var isFiles = k.data && k.data._files;
        var isOther = k.data && k.data.other;
        if (isFiles) rowEl.classList.add("sb-row-files");
        if (isOther) rowEl.classList.add("sb-row-other");

        var name = k.data.name || k.data.path || "/";
        rowEl.innerHTML =
          '<span class="sb-row-bar" style="width:' +
          (ksize / maxKid) * 100 +
          '%"></span>' +
          '<span class="sb-row-name">' +
          U.esc(name) +
          (isOther ? ' <span class="sb-row-tag">grouped</span>' : "") +
          "</span>" +
          '<span class="sb-row-size mono">' +
          U.esc(U.humanBytes(ksize)) +
          "</span>" +
          '<span class="sb-row-pct mono">' +
          U.esc(U.pctStr(ksize, fSize)) +
          "</span>" +
          '<span class="sb-row-count mono">' +
          U.esc(k.data.count != null ? U.humanCount(k.data.count) : "—") +
          "</span>";

        rowEl.addEventListener("click", function () {
          drill(k);
        });
        rowEl.addEventListener("mousemove", function (event) {
          showTip(event, k);
        });
        rowEl.addEventListener("mouseleave", hideTip);
        list.appendChild(rowEl);
      });
    }

    function stat(label, value) {
      var s = el("div", "sb-stat");
      s.innerHTML =
        '<div class="sb-stat-label">' +
        U.esc(label) +
        '</div><div class="sb-stat-value mono">' +
        U.esc(value) +
        "</div>";
      return s;
    }

    /* ---- tooltip -------------------------------------------------------- */
    function showTip(event, d) {
      var data = d.data || {};
      var sz = nodeSize(data);
      var parentSz = d.parent ? nodeSize(d.parent.data) : sz;
      var rows = [];

      rows.push(
        '<div class="sb-tip-path mono">' +
          U.esc(data.path || "(scan root)") +
          "</div>"
      );

      if (data.other) {
        rows.push(
          '<div class="sb-tip-note">' +
            U.esc(
              (data.other_dirs != null ? data.other_dirs : "Several") +
                " smaller directories grouped — click to expand"
            ) +
            "</div>"
        );
      } else if (data._files) {
        rows.push(
          '<div class="sb-tip-note">Files held directly in this directory</div>'
        );
      }

      if (opts.tooltipRows) {
        /* compare mode replaces the metric rows with before/after/delta */
        opts.tooltipRows(data).forEach(function (r) {
          rows.push(tipRow(r.k, r.v));
        });
      } else {
        rows.push(
          tipRow("Size", U.humanBytes(sz) + "  ·  " + U.exactBytes(sz) + " B")
        );
        rows.push(tipRow("% of parent", U.pctStr(sz, parentSz)));
        rows.push(tipRow("% of scan", U.pctStr(sz, totalSize)));
        rows.push(
          tipRow("Items", data.count != null ? U.commaCount(data.count) : "—")
        );
        var childDirs = (data.children || []).filter(function (c) {
          return !c._files;
        }).length;
        rows.push(
          tipRow(
            "Child dirs",
            data.other
              ? "—"
              : childDirs + (data.truncated ? "+ (truncated)" : "")
          )
        );
        /* hard-link breakdown, shown only when this subtree has any */
        var apK = sizeKey === "size_apparent";
        var dedup = Number(
          (apK ? data.size_apparent : data.size_actual) || data.size_actual || 0
        );
        var exV = apK ? data.exclusive_apparent : data.exclusive_actual;
        var cpV = apK ? data.copy_apparent : data.copy_actual;
        if (exV != null && Number(exV) < dedup) {
          rows.push(
            tipRow(
              "Exclusive",
              U.humanBytes(Number(exV)) +
                "  ·  shared " + U.humanBytes(dedup - Number(exV))
            )
          );
        }
        if (cpV) {
          rows.push(tipRow("Hard-link copies", U.humanBytes(Number(cpV))));
        }
      }

      tip.innerHTML = rows.join("");
      tip.style.display = "block";
      positionTip(event);
    }

    function tipRow(k, v) {
      return (
        '<div class="sb-tip-row"><span class="sb-tip-k">' +
        U.esc(k) +
        '</span><span class="sb-tip-v mono">' +
        U.esc(v) +
        "</span></div>"
      );
    }

    function positionTip(event) {
      var pad = 16;
      var w = tip.offsetWidth || 240;
      var h = tip.offsetHeight || 120;
      var x = event.clientX + pad;
      var y = event.clientY + pad;
      if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
      tip.style.left = Math.max(8, x) + "px";
      tip.style.top = Math.max(8, y) + "px";
    }

    function hideTip() {
      tip.style.display = "none";
    }

    /* ---- hover highlighting -------------------------------------------- */
    function onArcEnter(event, d) {
      var chain = {};
      d.ancestors().forEach(function (a) {
        chain[nodeKey(a)] = true;
      });
      gArcs
        .selectAll("path.sb-arc")
        .classed("sb-arc-hi", function (n) {
          return n === d;
        })
        .classed("sb-arc-dim", function (n) {
          return !chain[nodeKey(n)] && n !== d;
        })
        .classed("sb-arc-anc", function (n) {
          return chain[nodeKey(n)] && n !== d;
        });
      showTip(event, d);
    }

    function onArcMove(event, d) {
      positionTip(event);
    }

    function onArcLeave() {
      gArcs
        .selectAll("path.sb-arc")
        .classed("sb-arc-hi", false)
        .classed("sb-arc-dim", false)
        .classed("sb-arc-anc", false);
      hideTip();
    }

    /* ---- interaction: click / drill ------------------------------------ */
    function onArcClick(event, d) {
      drill(d);
    }

    /* Drill into node `d`: lazy-load if needed, else pure zoom tween. */
    function drill(d) {
      var data = d.data || {};
      if (data._files) return; // synthetic wedge — not navigable

      var needFetch =
        (data.other && !subtreeCache[data.path]) ||
        (data.truncated &&
          (!hasChildren(data) || !subtreeCache[data.path]));

      if (needFetch && opts.fetchSubtree && data.path != null) {
        lazyLoad(d);
        return;
      }

      /* Non-truncated (or already-loaded) drill — pure tween.
       * If a node has no children, zoom onto it anyway (shows it as center). */
      zoomTo(d);
    }

    /* Lazy-load a subtree, graft it in, rebuild and zoom. */
    function lazyLoad(d) {
      var data = d.data;
      var path = data.path;
      if (pendingFetch[path]) return;

      /* cache hit — graft instantly */
      if (subtreeCache[path]) {
        graftChildren(data, subtreeCache[path]);
        rebuildPreservingFocus(path);
        return;
      }

      pendingFetch[path] = true;
      showSpinner(d);

      Promise.resolve(opts.fetchSubtree(path))
        .then(function (node) {
          var kids = (node && node.children) || [];
          subtreeCache[path] = kids;
          graftChildren(data, kids);
          rebuildPreservingFocus(path);
        })
        .catch(function (err) {
          /* On failure, leave the tree as-is and surface a console note. */
          if (global.console) console.warn("Subtree fetch failed:", err);
        })
        .then(function () {
          pendingFetch[path] = false;
          hideSpinner();
        });
    }

    /* Graft fetched children into a data node. For an (other) bucket, the
     * server returns a fuller child set for the PARENT — replace the parent's
     * children entirely (the (other) node lives in `data` already). */
    function graftChildren(data, kids) {
      if (data.other) {
        /* `data` IS the (other) node; its `path` is the parent's path. The
         * fetched `kids` is the parent's fuller child list. We find the
         * parent in rawRoot and replace its children. */
        var parent = findByChild(rawRoot, data);
        if (parent) {
          parent.children = kids.slice();
        } else {
          /* fallback: attach onto the (other) node itself */
          data.children = kids.slice();
          data.truncated = false;
        }
      } else {
        data.children = kids.slice();
        data.truncated = false;
      }
    }

    /* Find the parent data node that directly contains `child`. */
    function findByChild(node, child) {
      if (!node || !node.children) return null;
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i] === child) return node;
        var found = findByChild(node.children[i], child);
        if (found) return found;
      }
      return null;
    }

    /* Find a hierarchy node by data path (first match). */
    function findHierByPath(path) {
      var hit = null;
      root.each(function (d) {
        if (hit) return;
        if (d.data && d.data.path === path) hit = d;
      });
      return hit;
    }

    /* Rebuild hierarchy after a graft, then zoom into the loaded node. */
    function rebuildPreservingFocus(loadedPath) {
      var prevFocusPath = focusNode ? focusNode.data.path : "";
      root = buildHierarchy();

      /* restore focus to where the user was */
      focusNode =
        findHierByPath(prevFocusPath) || root;
      project(focusNode);
      root.each(function (d) {
        d.current = d.target;
      });

      /* now animate a zoom INTO the just-loaded node, if found */
      var target = findHierByPath(loadedPath);
      render();
      if (target && target !== focusNode) {
        zoomTo(target);
      }
    }

    /* ---- spinner -------------------------------------------------------- */
    function showSpinner(d) {
      spinner.style("display", null);
    }
    function hideSpinner() {
      spinner.style("display", "none");
    }

    /* ---- zoom tween ----------------------------------------------------- */
    function zoomTo(p, silent) {
      if (!p) return;
      focusNode = p;
      project(p);

      var t = svg.transition().duration(TWEEN_MS);

      gArcs
        .selectAll("path.sb-arc")
        .transition(t)
        .tween("data", function (d) {
          var i = d3.interpolate(d.current, d.target);
          return function (tt) {
            d.current = i(tt);
          };
        })
        .attrTween("d", function (d) {
          return function () {
            return arc(d.current);
          };
        })
        .attr("fill-opacity", function (d) {
          return arcVisible(d.target) ? arcOpacity(d) : 0;
        })
        .attr("stroke-opacity", function (d) {
          return arcVisible(d.target) ? 1 : 0;
        })
        .attr("pointer-events", function (d) {
          return arcVisible(d.target) ? "auto" : "none";
        });

      /* Re-fit label text to the destination geometry up front, then tween
       * position and fade opacity to the target visibility. */
      gLabels
        .selectAll("text.sb-label")
        .text(function (d) {
          return labelText(d, d.target);
        })
        .transition(t)
        .attr("fill-opacity", function (d) {
          return labelVisible(d.target) ? 1 : 0;
        })
        .attrTween("transform", function (d) {
          return function () {
            return labelTransform(d.current);
          };
        });

      updateCenter();
      renderCrumbs();
      renderDetails();

      /* notify the router (skipped when the router itself drove this focus) */
      if (!silent && opts.onFocusChange) {
        opts.onFocusChange(p.depth === 0 ? "" : p.data.path || "");
      }
    }

    /* ---- public API ----------------------------------------------------- */

    /* Load a fresh root node (the `node` from op=tree). */
    function setData(node) {
      rawRoot = node || {
        name: "(scan)",
        path: "",
        size_actual: 0,
        children: []
      };
      subtreeCache = {};
      pendingFetch = {};
      hueAssign = {};
      hueIndex = 0;
      totalSize = nodeSize(rawRoot) || 1;

      root = buildHierarchy();
      focusNode = root;
      project(root);
      root.each(function (d) {
        d.current = d.target;
      });
      render();
    }

    /* Drive focus from the URL. `path` "" → scan root. If the path lies
     * inside a not-yet-loaded subtree, we focus the deepest loaded ancestor. */
    function focusByPath(path) {
      if (!root) return;
      if (path == null) path = "";

      var hit = findHierByPath(path);
      if (hit) {
        /* silent: the router already owns the URL hash. */
        if (hit !== focusNode) zoomTo(hit, true);
        return;
      }

      /* Path not loaded — focus the deepest loaded prefix so a deep link at
       * least lands nearby. */
      var deepest = deepestLoadedAncestor(path);
      if (deepest && deepest !== focusNode) zoomTo(deepest, true);
    }

    /* Find the deepest loaded hierarchy node whose path is a prefix of `path`. */
    function deepestLoadedAncestor(path) {
      var best = root;
      root.each(function (d) {
        var p = d.data && d.data.path;
        if (p && path.indexOf(p) === 0 && p.length > (best.data.path || "").length) {
          best = d;
        }
      });
      return best;
    }

    /* ---- toolbar controls ---------------------------------------------- */
    /* Rebuild the hierarchy and re-render, keeping the user's focus. */
    function relayout() {
      var prevFocus = focusNode ? focusNode.data.path : "";
      root = buildHierarchy();
      focusNode = findHierByPath(prevFocus) || root;
      project(focusNode);
      root.each(function (d) {
        d.current = d.target;
      });
      render();
    }

    /* Recompute geometry for a new ring count. */
    function applyRings(n) {
      ringCount = Math.max(2, Math.min(5, n));
      radius = size / (2 * (ringCount + 1));
      centerCircle.attr("r", radius);
      spinnerRing.attr("r", radius * (ringCount + 1) * 0.92);
    }

    toolbar.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-g]");
      if (!btn) return;
      var group = btn.getAttribute("data-g");
      var value = btn.getAttribute("data-v");
      toolbar
        .querySelectorAll('button[data-g="' + group + '"]')
        .forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });

      if (group === "size") {
        if (value === sizeKey) return;
        sizeKey = value;
        relayout();
      } else if (group === "hl") {
        if (value === hlMode) return;
        hlMode = value;
        relayout();
      } else if (group === "rings") {
        applyRings(parseInt(value, 10) || 2);
        relayout();
      } else if (group === "scale") {
        svg.attr("class", "sb-svg sb-scale-" + value);
      }
    });

    return {
      setData: setData,
      focusByPath: focusByPath,
      destroy: function () {
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
      }
    };
  }

  global.Sunburst = Sunburst;
})(window);
