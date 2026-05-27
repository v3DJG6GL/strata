/* ==========================================================================
 * sunburst.js — zoomable D3 v7 sunburst for Strata
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

  /* Label sizing. LABEL_FONT is the on-screen pixel size labels should keep
   * regardless of how large the SVG is displayed; it is counter-scaled into
   * SVG user units via textK (see measureTextK). */
  var LABEL_FONT = 13;
  var LABEL_PAD = 10; // radial padding inside a ring band (user units)
  var LABEL_AREA = 0.03; // clutter gate: min (Δy)·(Δx) for a slice to be labelled
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
    var textK = 1; // (viewBox units) / (rendered px) — counter-scales label text

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

    /* items: [value, label] or [value, label, tooltip]; groupTip is an
     * optional title on the group label. Tooltip text is author-controlled
     * static copy (no quotes), so it is inlined into the title attribute. */
    function ctlGroup(label, group, items, active, cls, groupTip) {
      var html =
        '<div class="sb-ctl' + (cls ? " " + cls : "") + '">' +
        '<span class="sb-ctl-label"' +
        (groupTip ? ' title="' + groupTip + '"' : "") + ">" +
        label + "</span>" +
        '<div class="sb-toggle" role="group">';
      items.forEach(function (it) {
        html +=
          '<button type="button" data-g="' + group + '" data-v="' + it[0] + '"' +
          (it[2] ? ' title="' + it[2] + '"' : "") +
          (it[0] === active ? ' class="active"' : "") + ">" + it[1] + "</button>";
      });
      return html + "</div></div>";
    }

    toolbar.innerHTML =
      ctlGroup("SIZE", "size",
        [["size_actual", "Actual",
          "Disk blocks actually allocated (st_blocks x 512) -- the real " +
          "on-disk footprint. Includes block slack; sparse and compressed " +
          "files measure smaller than their content."],
         ["size_apparent", "Apparent",
          "The file's logical length (st_size), as shown by ls -l. Ignores " +
          "how blocks are allocated on disk."]],
        "size_actual", "sb-ctl-layout",
        "How file size is measured.") +
      ctlGroup("HARD LINKS", "hl",
        [["dedupe", "Deduped",
          "Each inode counted once, charged to its owner directory. Folder " +
          "totals sum to real disk usage."],
         ["copies", "+ Copies",
          "Deduped size plus copy bytes: every extra hard link adds its " +
          "bytes back in its own folder -- the nominal footprint, as if " +
          "nothing were shared."],
         ["exclusive", "Exclusive",
          "Only bytes whose every hard link lives inside the folder -- what " +
          "you would actually reclaim by deleting it."]],
        "dedupe", "sb-ctl-layout",
        "How files with multiple hard links are counted.") +
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
    /* center text — updateCenter() sizes and positions these explicitly */
    var centerLabel = centerG
      .append("text")
      .attr("class", "sb-center-label")
      .attr("text-anchor", "middle");
    var centerSub = centerG
      .append("text")
      .attr("class", "sb-center-sub")
      .attr("text-anchor", "middle");
    var centerHint = centerG
      .append("text")
      .attr("class", "sb-center-hint")
      .attr("text-anchor", "middle");

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

    /* ---- constant-size text -------------------------------------------- */
    /* The SVG keeps a fixed viewBox, so displaying it larger magnifies
     * everything — text included. textK counter-scales label fonts so they
     * stay a constant on-screen size while arcs/rings still scale. A
     * ResizeObserver re-fits on SCALE changes and window/container resizes. */
    function measureTextK() {
      var w = svg.node().getBoundingClientRect().width;
      textK = w > 0 ? size / w : 1;
    }
    var roRaf = 0;
    var resizeObs = new ResizeObserver(function () {
      cancelAnimationFrame(roRaf);
      roRaf = requestAnimationFrame(function () {
        if (root) refitOnResize();
      });
    });
    resizeObs.observe(svg.node());

    /* On a container resize the viewBox is unchanged -- only textK (which
     * counter-scales label fonts) needs updating. Skip the full render's
     * data joins / breadcrumb / details rebuild. */
    function refitOnResize() {
      measureTextK();
      gLabels.attr("font-size", labelFontUnits());
      gLabels
        .selectAll("text.sb-label")
        .text(function (d) {
          return labelFor(d, d.current);
        })
        .attr("opacity", function () {
          return this.textContent ? 1 : 0;
        });
      updateCenter();
    }

    /* ---- color --------------------------------------------------------- */
    /* Each top-level directory owns a hue, evenly spaced around the wheel.
     * Descendants spread by sibling index across a shrinking sub-band of
     * their parent's hue, so adjacent siblings always differ — in hue and a
     * lightness zig-zag — while a whole subtree stays one recognisable
     * colour family. Colours are index-based (independent of size and zoom)
     * so they are computed once per (re)build and cached on `d._color`;
     * assignColors() runs at the end of buildHierarchy(). */
    var START_HUE = 210; // anchor hue for the first top-level directory
    var SAT = 0.52; // constant saturation across the chart
    var BAND_DECAY = 0.62; // each depth spreads its kids over this much less hue

    function nodeLight(depth, sibIndex) {
      // deeper rings a touch lighter; adjacent siblings zig-zag in lightness
      var l = Math.min(0.66, 0.4 + Math.max(0, depth - 1) * 0.055);
      l += sibIndex % 2 === 0 ? -0.04 : 0.04;
      return Math.max(0.3, Math.min(0.72, l));
    }

    function paintNode(node, hue, sibIndex) {
      var data = node.data || {};
      if (data.other) { node._color = "#6e7681"; return; } // (other) bucket
      if (data._files) { node._color = "#363b44"; return; } // own-files wedge
      if (node.depth === 0) { node._color = "#30363d"; return; }
      node._color = d3
        .hsl(hue, SAT, nodeLight(node.depth, sibIndex))
        .formatHex();
    }

    /* Paint `node`, then spread its children across [hue ± band/2] by index. */
    function descendColor(node, hue, band, sibIndex) {
      paintNode(node, hue, sibIndex);
      var kids = node.children || [];
      var n = kids.length;
      if (!n) return;
      var childBand = band * BAND_DECAY;
      kids.forEach(function (k, i) {
        var frac = n > 1 ? (i + 0.5) / n - 0.5 : 0;
        descendColor(k, hue + band * frac, childBand, i);
      });
    }

    /* Assign a stable `_color` to every node of hierarchy `h`. Colour
     * families start at the first level that actually branches — trivial
     * single-child wrapper rings (a lone scan root like `/data`) are painted
     * a neutral slate and skipped, so a one-root scan still gets a full
     * multi-hue chart instead of collapsing to a single family. */
    function assignColors(h) {
      h._color = "#30363d";
      var familyRoot = h;
      while (familyRoot.children && familyRoot.children.length === 1) {
        familyRoot = familyRoot.children[0];
        familyRoot._color = "#3a4150"; // neutral wrapper ring
      }
      var tops = familyRoot.children || [];
      var realTops = tops.filter(function (d) {
        return !(d.data && (d.data.other || d.data._files));
      });
      var nTop = Math.max(1, realTops.length);
      // each family's hue band stays inside the gap to its neighbours
      // (capped at 80°) so distinct subtrees never bleed together
      var band0 = Math.min(80, (360 / nTop) * 0.6);
      var realIdx = 0;
      tops.forEach(function (top, i) {
        var data = top.data || {};
        if (data.other || data._files) {
          descendColor(top, START_HUE, band0, i);
          return;
        }
        descendColor(top, START_HUE + (360 / nTop) * realIdx, band0, i);
        realIdx += 1;
      });
    }

    function colorFor(d) {
      return (d && d._color) || "#30363d";
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
     * children fit within its angular span (child sizes sum to ≤ parent).
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

      /* Stable, index-based colours — recomputed on every (re)build so
       * lazily-grafted subtrees are coloured too, without shifting the rest. */
      assignColors(h);
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

    /* Label font size in SVG user units (counter-scaled to a constant px). */
    function labelFontUnits() {
      return LABEL_FONT * textK;
    }

    /* Radial space a spoke label may occupy in this ring band (user units).
     * Labels run radially, so the budget is the band thickness — NOT the
     * tangential arc length (measuring that was the truncation bug). */
    function bandLength(c) {
      return (c.y1 - c.y0) * radius - LABEL_PAD;
    }

    /* May this slice host a label? It must be in a visible ring, angularly
     * thick enough for the glyph height, and not a clutter-tiny sliver. */
    function labelFits(c) {
      if (!arcVisible(c)) return false;
      var midR = ((c.y0 + c.y1) / 2) * radius;
      if ((c.x1 - c.x0) * midR < labelFontUnits() * 1.15) return false;
      return (c.y1 - c.y0) * (c.x1 - c.x0) > LABEL_AREA;
    }

    /* Truncate `name` to fit `avail` user units along the spoke, with an
     * ellipsis; "" when not even one character fits. */
    function fitLabel(name, avail) {
      name = name == null ? "" : String(name);
      if (avail <= 0) return "";
      var fs = labelFontUnits();
      if (U.textWidth(name, fs) <= avail) return name;
      var lo = 0,
        hi = name.length;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (U.textWidth(name.slice(0, mid) + "…", fs) <= avail) lo = mid;
        else hi = mid - 1;
      }
      return lo >= 1 ? name.slice(0, lo) + "…" : "";
    }

    /* The label text to draw for a node given a coord set ("" = hidden). */
    function labelFor(node, c) {
      if (!labelFits(c)) return "";
      return fitLabel(node.data && node.data.name, bandLength(c));
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

    /* ---- render --------------------------------------------------------- */
    function render() {
      measureTextK(); // keep label font constant px for the current display
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
        .attr("vector-effect", "non-scaling-stroke")
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

      /* LABELS — counter-scaled font; radial spokes fitted to the band */
      gLabels.attr("font-size", labelFontUnits());
      var labels = gLabels.selectAll("text.sb-label").data(nodes, nodeKey);
      labels.exit().remove();
      var labelsEnter = labels
        .enter()
        .append("text")
        .attr("class", "sb-label")
        .attr("dy", "0.32em");
      labelsEnter
        .merge(labels)
        .attr("transform", function (d) {
          return labelTransform(d.current);
        })
        .text(function (d) {
          return labelFor(d, d.current);
        })
        /* element opacity also hides the dark halo of an empty/hidden label */
        .attr("opacity", function () {
          return this.textContent ? 1 : 0;
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

      /* candidate lines {element, base px, text}; the hint is dropped at root.
       * Fonts are counter-scaled (textK) like the ring labels. */
      var cand = [
        {
          el: centerLabel,
          px: 14,
          text: fitLabel(
            atRoot ? "(scan)" : f.data.name || f.data.path || "/",
            radius * 1.7
          )
        },
        { el: centerSub, px: 18, text: U.humanBytes(nodeSize(f.data)) }
      ];
      if (!atRoot) {
        cand.push({ el: centerHint, px: 10, text: "↑ click to zoom out" });
      }

      /* drop trailing lines until the stacked block fits inside the hole */
      var LH = 1.34;
      function blockHeight(n) {
        var h = 0;
        for (var i = 0; i < n; i++) h += cand[i].px * textK * LH;
        return h;
      }
      var keep = cand.length;
      while (keep > 1 && blockHeight(keep) > radius * 1.55) keep--;

      [centerLabel, centerSub, centerHint].forEach(function (el) {
        el.style("display", "none");
      });
      var y = -blockHeight(keep) / 2;
      for (var i = 0; i < keep; i++) {
        var c = cand[i];
        var lh = c.px * textK * LH;
        c.el
          .style("display", null)
          .attr("font-size", c.px * textK)
          .attr("y", y + lh * 0.72)
          .text(c.text);
        y += lh;
      }

      centerG.on("click", function () {
        if (focusNode && focusNode.parent) zoomTo(focusNode.parent);
      });
      /* bind showTip on enter (rebuilds innerHTML) and the lighter positionTip
       * on every move -- otherwise a hover that sits inside the centre disc
       * would re-render the tip dozens of times per second. */
      centerG
        .on("mouseenter", function (event) {
          showTip(event, f);
        })
        .on("mousemove", positionTip)
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
        /* mouseenter rebuilds the tip; mousemove only repositions it. */
        rowEl.addEventListener("mouseenter", function (event) {
          showTip(event, k);
        });
        rowEl.addEventListener("mousemove", positionTip);
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
        /* show both sizes so the Actual/Apparent distinction is always
         * visible — they are equal unless a directory holds sparse or
         * sub-block files. */
        var saV = Number(data.size_actual || 0);
        var skV = Number(data.size_apparent || 0);
        rows.push(
          tipRow("On disk", U.humanBytes(saV) + "  ·  " + U.exactBytes(saV) + " B")
        );
        rows.push(
          tipRow("Apparent", U.humanBytes(skV) + "  ·  " + U.exactBytes(skV) + " B")
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
      /* offsetWidth/Height force layout; read once on (re)build and let
       * positionTip reuse the cached values for every mousemove. */
      tipW = tip.offsetWidth || 240;
      tipH = tip.offsetHeight || 120;
      positionTip(event);
    }
    var tipW = 0, tipH = 0;

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
      var w = tipW || 240;
      var h = tipH || 120;
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
      /* identity Set beats nodeKey() string concatenation: hierarchy nodes
       * are stable references within a build, so one Set lookup per arc
       * replaces three string composes + map lookups. */
      var chain = new Set(d.ancestors());
      gArcs
        .selectAll("path.sb-arc")
        .classed("sb-arc-hi", function (n) {
          return n === d;
        })
        .classed("sb-arc-dim", function (n) {
          return !chain.has(n) && n !== d;
        })
        .classed("sb-arc-anc", function (n) {
          return chain.has(n) && n !== d;
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

    /* Find a hierarchy node by data path (first match). d3's .each visits
     * every descendant even after a hit; recurse manually so the search
     * actually short-circuits on large trees. */
    function findHierByPath(path) {
      function visit(d) {
        if (d.data && d.data.path === path) return d;
        var kids = d.children;
        if (!kids) return null;
        for (var i = 0; i < kids.length; i++) {
          var h = visit(kids[i]);
          if (h) return h;
        }
        return null;
      }
      return visit(root);
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

      /* Re-fit label text to the destination geometry, then tween position
       * and fade opacity to the target visibility. */
      gLabels.attr("font-size", labelFontUnits());
      gLabels
        .selectAll("text.sb-label")
        .text(function (d) {
          return labelFor(d, d.target);
        })
        .transition(t)
        .attr("opacity", function () {
          return this.textContent ? 1 : 0;
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

    function onToolbarClick(e) {
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
        /* "Full" also collapses the side panel below so the chart gets the
         * whole row, not just the chart column. */
        layout.classList.toggle("sb-layout-wide", value === "full");
      }
    }
    toolbar.addEventListener("click", onToolbarClick);

    var destroyed = false;
    return {
      setData: setData,
      focusByPath: focusByPath,
      destroy: function () {
        /* Compare mode rebuilds Sunburst instances on every metric/sort
         * toggle; without this teardown the document.body-attached tip,
         * the toolbar listener, and any in-flight fetchSubtree promise
         * accumulate across mounts. */
        if (destroyed) return;
        destroyed = true;
        if (tip && tip.parentNode) tip.parentNode.removeChild(tip);
        resizeObs.disconnect();
        cancelAnimationFrame(roRaf);
        toolbar.removeEventListener("click", onToolbarClick);
        if (svg && svg.node() && svg.node().parentNode) {
          svg.node().parentNode.removeChild(svg.node());
        }
        pendingFetch = {};
      }
    };
  }

  global.Sunburst = Sunburst;
})(window);
