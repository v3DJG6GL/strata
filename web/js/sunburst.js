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
  /* Delay before a lazy-load indicator appears — fast/cached fetches resolve
   * first and show nothing, so only genuinely slow drill-ins surface it. */
  var SPINNER_DELAY_MS = 250;

  function Sunburst(containerEl, opts) {
    opts = opts || {};

    /* ---- mutable state -------------------------------------------------- */
    var rawRoot = null; // the raw data tree we own & mutate (graft lazy kids)
    var root = null; // current d3.hierarchy
    var focusNode = null; // currently focused hierarchy node
    var sizeKey = "size_actual"; // or "size_apparent"
    var subtreeCache = {}; // path -> children array (lazy fetch cache)
    var pendingFetch = {}; // path -> true while a fetch is in flight
    var spinnerTimer = 0; // setTimeout id for the debounced loader (0 = unarmed)
    var loading = false; // true while the center loader is visible
    var totalSize = 1; // scan-total size for "% of scan" tooltip math
    var ringCount = 2; // rings of children rendered at once (2..5)
    var hlMode = "dedupe"; // hard-link view: "dedupe" | "copies" | "exclusive"
    var textK = 1; // (viewBox units) / (rendered px) — counter-scales label text
    var arcDomByNode = new Map(); // hierarchy node -> its <path> (rebuilt per render)
    var hoverChain = []; // DOM nodes carrying hi/anc classes for the current hover

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
    /* Radial model: a center disc of FIXED radius `HOLE_R`, then the focus's
     * rings fill the remaining radius out to the rim. `band` (ring thickness) is
     * recomputed per focus by recomputeRadius() so RINGS acts as a MAXIMUM — when
     * the focused subtree has fewer levels than ringCount the rings expand to
     * fill the disc instead of leaving the rim empty. The hole does NOT depend on
     * ringCount, so changing RINGS on a shallow focus (e.g. a flat folder) leaves
     * the view unchanged, and the centre label keeps a constant fit budget. */
    var HOLE_R = size / 6; // fixed centre-disc radius (independent of RINGS)
    var holeR = HOLE_R; // current hole radius (HOLE_R, or enlarged for a leaf)
    var band = HOLE_R; // ring thickness (recomputed per focus)
    var holeShown = holeR, // radii currently on screen (tween-from for zoom)
      bandShown = band;
    /* Outer radius at fractional ring depth `y` (0 = center). Depth 0..1 spans
     * the hole; depth >= 1 steps out by `band` per ring. Replaces `y * radius`. */
    function rAt(y) {
      return y <= 1 ? y * holeR : holeR + (y - 1) * band;
    }

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
    /* Hidden-depth hint: a faint dashed ring at the rim, shown when the focused
     * subtree is deeper than the RINGS cap (more levels exist than are drawn).
     * The outermost drawn ring always reaches size/2, so this aligns with it. */
    var rimHint = svg
      .append("circle")
      .attr("class", "sb-rim-hint")
      .attr("r", size / 2 - 0.5)
      .attr("fill", "none")
      .style("display", "none");

    /* center disc — zoom-out target */
    var centerG = svg.append("g").attr("class", "sb-center");
    var centerCircle = centerG
      .append("circle")
      .attr("r", holeR)
      .attr("class", "sb-center-circle");
    /* lazy-load indicator — a quiet arc that spins inside the center disc.
     * pathLength normalizes the dash math so it stays a single ~90° arc at any
     * radius (vs. a tiled dash pattern). Sized in applyRings, hidden by default. */
    var loaderRing = centerG
      .append("circle")
      .attr("class", "sb-loader-ring")
      .attr("pathLength", 100)
      .attr("r", holeR * 0.9) // initial size; recomputeRadius keeps it in sync
      .style("display", "none");
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
        return band * 1.5;
      })
      .innerRadius(function (d) {
        return Math.max(0, rAt(d.y0));
      })
      .outerRadius(function (d) {
        return Math.max(rAt(d.y0), rAt(d.y1) - 1);
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

    /* On a container resize the viewBox is unchanged, but textK (which
     * counter-scales label fonts AND the angular-fold threshold) changes, so
     * the set of folded slices can shift. Re-fold for the new textK and
     * re-render (snap — the geometry itself didn't move). foldPass() re-measures
     * textK itself, so the threshold is always current. */
    function refitOnResize() {
      foldPass(focusNode);
      render(false);
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
      if (data._file) { node._color = "#5a5048"; return; }  // a single big file
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
        return !(d.data && (d.data.other || d.data._files || d.data._file));
      });
      var nTop = Math.max(1, realTops.length);
      // each family's hue band stays inside the gap to its neighbours
      // (capped at 80°) so distinct subtrees never bleed together
      var band0 = Math.min(80, (360 / nTop) * 0.6);
      var realIdx = 0;
      tops.forEach(function (top, i) {
        var data = top.data || {};
        if (data.other || data._files || data._file) {
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

    /* Resolve the size/exclusive/copy fields a `data` node carries for the
     * current Size + Hard-link mode. Centralises the apparent/actual ternary
     * that nodeSize and showTip would otherwise both rewrite. */
    function sizeFields(data) {
      var ap = sizeKey === "size_apparent";
      return {
        base: Number(
          (ap ? data.size_apparent : data.size_actual) || data.size_actual || 0
        ),
        ex: ap ? data.exclusive_apparent : data.exclusive_actual,
        cp: ap ? data.copy_apparent : data.copy_actual
      };
    }

    /* The size value used for layout, honoring the size-type and hard-link
     * view toggles. The ex/cp null-guards are required by the synthetic
     * "·files·" wedge (own-files remainder), which carries only size_actual/
     * size_apparent and no exclusive/copy fields. */
    function nodeSize(data) {
      if (!data) return 0;
      var f = sizeFields(data);
      if (hlMode === "exclusive") return f.ex != null ? Number(f.ex) : f.base;
      if (hlMode === "copies") return f.base + (f.cp != null ? Number(f.cp) : 0);
      return f.base;
    }

    /* May this loose file be promoted to its own leaf slice? The server already
     * decided which files to surface (STRATA_FILE_TOP / STRATA_FILE_FLOOR) and
     * capped the served list, so every entry is a candidate — the angular fold
     * trims anything too thin to see. The one exception is exclusive mode: a
     * multi-link file's exclusive bytes are charged at its LCA, not its
     * canonical directory, so a full-size leaf would overcount — keep those
     * folded into the parent's "+N more files" remainder. */
    function filePromotable(fd) {
      return !(hlMode === "exclusive" && fd.nlink > 1);
    }

    /* Human label that matches what nodeSize() actually counted, for tip
     * rows whose value is a nodeSize result (the synthetic wedge, and the
     * "Counted" row added to the non-wedge tip in non-dedupe modes). */
    function countedLabel() {
      var ap = sizeKey === "size_apparent";
      if (hlMode === "exclusive") return ap ? "Exclusive (apparent)" : "Exclusive";
      if (hlMode === "copies") return ap ? "Apparent + copies" : "On disk + copies";
      return ap ? "Apparent" : "On disk";
    }

    /* Does this data node have real, expandable children present? */
    function hasChildren(data) {
      return data && data.children && data.children.length > 0;
    }

    /* Does it have any loaded child that is a real directory (not a folded
     * server "(other)" bucket)? A truncated node whose ONLY child is an
     * "(other)" bucket renders as a dead single-slice view until its real
     * children are lazily fetched — focusByPath uses this to decide whether a
     * programmatic focus (table click, deep link) must expand first. */
    function hasRealChildren(data) {
      return !!(
        data &&
        data.children &&
        data.children.some(function (c) {
          return !c.other;
        })
      );
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
        var kids = dataNode.children || [];
        var node = { data: dataNode, children: [] };
        var ownSize = nodeSize(dataNode);

        var childSum = 0;
        kids.forEach(function (k) {
          childSum += nodeSize(k);
          node.children.push(wrap(k));
        });

        /* Promote the largest loose files (server-supplied files_top) to their
         * own leaf slices, so a directory that is mostly one huge file shows
         * that file instead of burying it in the remainder. */
        var promotedSum = 0,
          promotedCount = 0,
          base = (dataNode.path || "").replace(/\/$/, "");
        (dataNode.files_top || []).forEach(function (ft) {
          var fd = {
            name: ft.name,
            _file: true,
            path: base + "/" + ft.name,
            size_actual: ft.size_actual,
            size_apparent: ft.size_apparent,
            nlink: ft.nlink,
            count: null,
            children: []
          };
          /* Compare mode tags each file entry with diff fields; carry them onto
           * the leaf so opts.color / opts.tooltipRows can read them. Absent on
           * the normal scan path — purely additive there. */
          if (ft.status != null) {
            fd.status = ft.status;
            fd.base_actual = ft.base_actual;
            fd.base_apparent = ft.base_apparent;
            fd.d_actual = ft.d_actual;
            fd.d_apparent = ft.d_apparent;
          }
          if (!filePromotable(fd)) return;
          var fsz = nodeSize(fd);
          node.children.push({ data: fd, children: [], _leafValue: fsz });
          /* A compare-mode "removed" file is a ghost laid out at its OLD size
           * (like a removed directory); it is not part of THIS snapshot's own
           * bytes/count, so it must not be subtracted from the remainder wedge —
           * otherwise "+N files" undercounts the files that actually remain. */
          if (fd.status === "removed") return;
          promotedSum += fsz;
          promotedCount += 1;
        });

        /* The own-files remainder wedge ("+N more files"): the parent's own
         * bytes not held by a child dir or a promoted file. Only meaningful
         * once the node has any breakdown to sit alongside. */
        if (node.children.length) {
          var remainder = ownSize - childSum - promotedSum;
          if (remainder > 0 && remainder > ownSize * 0.001) {
            var oc = dataNode.own_count;
            node.children.push({
              data: {
                name: "·files·",
                _files: true,
                path: dataNode.path || "",
                size_actual: remainder,
                size_apparent: remainder,
                count: null,
                /* files left in the wedge = own files minus the promoted ones
                 * (null when the snapshot predates own_count). */
                _remainCount: oc != null ? Math.max(0, oc - promotedCount) : null,
                children: []
              },
              children: [],
              /* sum() reads _leafValue off this wrapper, not data; without
               * it the wedge would contribute 0 and collapse to zero width,
               * silently dropping the parent's own-file bytes from the arc. */
              _leafValue: remainder
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
          /* Keep the synthetic own-files remainder wedge (·files·) last so it
           * sits adjacent to the thin-file tail. foldPass always merges the
           * wedge into the single "+N files" bucket, and the combined angular
           * span must stay contiguous — a wedge stranded mid-order would make
           * the bucket arc overlap an intervening non-folded subfolder.
           * (Sort runs before the flatten below, so data is at a.data.data.) */
          var aw = a.data && a.data.data && a.data.data._files;
          var bw = b.data && b.data.data && b.data.data._files;
          if (aw !== bw) return aw ? 1 : -1;
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

    /* Max loaded ring-depth below focus `p` (0 = p is a leaf). Promoted file
     * leaves and the ·files· wedge are real depth+1 children, so they count as a
     * ring; fold buckets reuse an existing child ring and don't extend depth. */
    function depthBelow(p) {
      var maxRel = 0;
      p.each(function (d) {
        var rel = d.depth - p.depth;
        if (rel > maxRel) maxRel = rel;
      });
      return maxRel;
    }

    /* Size the radial band so RINGS is a MAXIMUM: when the focus is shallower
     * than ringCount, the rings fill the disc instead of leaving the rim empty.
     * holeR stays fixed (so the centre text budget is stable); band grows to
     * cover the remaining radius over the actual depth. A childless focus
     * enlarges the hole so it reads as a terminal disc, not a thin empty ring.
     * Recomputed on every focus/build/RINGS change; render() animates the
     * holeR/band change across a zoom. DOM updates are left to render(). */
    function recomputeRadius(p) {
      holeR = HOLE_R;
      var avail = depthBelow(p || focusNode || root);
      if (avail <= 0) {
        holeR = size * 0.3; // leaf focus: dominant centre disc, no ring band
        band = size / 2 - holeR;
        return;
      }
      band = (size / 2 - holeR) / Math.min(ringCount, avail);
    }

    /* Keep the centre disc + loader ring sized to the current holeR. Called
     * wherever holeR changes: per-frame during a band tween, on tween end, on a
     * snap, and on a RINGS change. The loader hugs the inside of the disc. */
    function syncHoleDisc() {
      centerCircle.attr("r", holeR);
      loaderRing.attr("r", holeR * 0.9);
    }

    /* Label font size in SVG user units (counter-scaled to a constant px). */
    function labelFontUnits() {
      return LABEL_FONT * textK;
    }

    /* Radial space a spoke label may occupy in this ring band (user units).
     * Labels run radially, so the budget is the band thickness — NOT the
     * tangential arc length (measuring that was the truncation bug). */
    function bandLength(c) {
      return rAt(c.y1) - rAt(c.y0) - LABEL_PAD;
    }

    /* May this slice host a label? It must be in a visible ring, angularly
     * thick enough for the glyph height, and not a clutter-tiny sliver. */
    function labelFits(c) {
      if (!arcVisible(c)) return false;
      var midR = rAt((c.y0 + c.y1) / 2);
      if ((c.x1 - c.x0) * midR < labelFontUnits() * 1.15) return false;
      return (c.y1 - c.y0) * (c.x1 - c.x0) > LABEL_AREA;
    }

    /* Truncate `name` to fit `avail` user units, with an ellipsis; "" when not
     * even one character fits. `fs`/`mono` default to the ring-label font (sans,
     * LABEL_FONT); the centre disc label passes its own size and mono=true so the
     * measurement matches what actually renders (it's monospace). */
    function fitLabel(name, avail, fs, mono) {
      name = name == null ? "" : String(name);
      if (avail <= 0) return "";
      fs = fs || labelFontUnits();
      var w = mono ? 700 : null;
      if (U.textWidth(name, fs, w, mono) <= avail) return name;
      var lo = 0,
        hi = name.length;
      while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (U.textWidth(name.slice(0, mid) + "…", fs, w, mono) <= avail) lo = mid;
        else hi = mid - 1;
      }
      return lo >= 1 ? name.slice(0, lo) + "…" : "";
    }

    /* The display name for a slice. Real dirs/files use their name; the two
     * synthetic overflow buckets read "+N folders" / "+N files" so they are
     * self-explanatory and tell each other apart (a file leaf falls through to
     * its filename). fitLabel truncates to "+N…" on a narrow arc. */
    function displayName(data) {
      if (!data) return "";
      /* A compare-mode bucket made up only of deleted ghosts (no current items)
       * labels itself "N deleted" instead of a misleading "+0 folders"/"files". */
      if (data.other) {
        if (!(data.other_dirs > 0) && data._deletedCount > 0)
          return data._deletedCount + " deleted";
        /* unknown grouped-dir count (matches the tooltip's "Several") — never a
         * misleading "+0 folders" on a bucket that does hold folders. */
        if (data.other_dirs == null) return "folders";
        return "+" + data.other_dirs + " folders";
      }
      if (data._files) {
        if (data._remainCount > 0) return "+" + data._remainCount + " files";
        /* Only a bucket with NO live files (remain === 0, not the unknown null
         * sentinel) is purely deleted. A bucket folding a legacy own-files wedge
         * (_remainCount === null) still holds current files of unknown count, so
         * it must fall through to "files" rather than claim "N deleted". */
        if (data._remainCount === 0 && data._deletedCount > 0)
          return data._deletedCount + " deleted";
        return "files";
      }
      return data.name || "";
    }

    /* The label text to draw for a node given a coord set ("" = hidden). */
    function labelFor(node, c) {
      if (!labelFits(c)) return "";
      return fitLabel(displayName(node.data), bandLength(c));
    }

    function labelTransform(d) {
      var x = (((d.x0 + d.x1) / 2) * 180) / Math.PI;
      var y = rAt((d.y0 + d.y1) / 2);
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

    /* ---- focus-aware angular fold -------------------------------------- *
     * Any sibling whose arc would render thinner than MIN_ARC_PX at the
     * current focus is "folded" into its parent's overflow bucket: thin dirs
     * (and the server "(other)") into a "+N folders" bucket, thin files (and
     * the own-files wedge) into a "+N files" bucket. Folding is recomputed per
     * focus, so zooming in gives a folded child enough angle to re-appear.
     * The fold rewrites only the RENDER node-set; the d3 partition geometry is
     * untouched, so every layout invariant still holds. */
    var MIN_ARC_PX = 2;

    function isTooThin(c) {
      var midR = rAt((c.y0 + c.y1) / 2);
      return (c.x1 - c.x0) * midR < MIN_ARC_PX * textK;
    }
    function isFileLike(data) {
      return !!(data && (data._file || data._files));
    }

    /* A bucket is a synthetic node cached on its parent so its `current` (and
     * thus its zoom morph) survives across fold passes. */
    function foldBucketFor(parent, kind) {
      var key = kind === "dir" ? "_foldDir" : "_foldFile";
      var b = parent[key];
      if (!b) {
        b = { parent: parent, depth: parent.depth + 1 };
        b.ancestors = function () {
          return [b].concat(parent.ancestors());
        };
        parent[key] = b;
      }
      return b;
    }

    function setBucketGeom(b, x0, x1, y0, y1) {
      b.target = { x0: x0, x1: x1, y0: y0, y1: y1 };
      if (!b.current) b.current = b.target; // first appearance: snap
    }

    function fillDirBucket(b, parent, dirs) {
      var sa = 0, sk = 0, ea = 0, ek = 0, ca = 0, ck = 0,
        cnt = 0, dn = 0, deleted = 0, truncated = false, unknownDirs = false;
      dirs.forEach(function (c) {
        var d = c.data || {};
        sa += Number(d.size_apparent || 0);
        sk += Number(d.size_actual || 0);
        /* Carry the exclusive/copy bytes too: each folded dir's ARC WIDTH comes
         * from nodeSize(), which honours hlMode (exclusive/copies). Without these
         * the bucket has no ex/cp fields, so nodeSize(bucket) falls back to dedupe
         * bytes and the tooltip's "Counted" row + "% of parent"/"% of scan" no
         * longer reconcile with the visibly ex/cp-weighted wedge. */
        ea += Number(d.exclusive_apparent || 0);
        ek += Number(d.exclusive_actual || 0);
        ca += Number(d.copy_apparent || 0);
        ck += Number(d.copy_actual || 0);
        /* A compare-mode "removed" dir is a ghost laid out at its OLD size; it is
         * not part of THIS snapshot, so it keeps its bytes (the folded region
         * still spans it visually) but is excluded from the "+N folders"/item
         * tally — otherwise the bucket claims folders that no longer exist. It is
         * counted separately so an all-deleted bucket can label itself "N deleted". */
        if (d.status === "removed") { deleted += 1; return; }
        cnt += Number(d.count || 0);
        /* A folded compare "(other)" carries no dir count (other_dirs null), so
         * the merged tally is unknown -- mirror fillFileBucket's null sentinel so
         * the bucket reads "folders" rather than a misleading "+0 folders". */
        if (d.other) {
          if (d.other_dirs == null) unknownDirs = true;
          else dn += Number(d.other_dirs);
        } else {
          dn += 1;
        }
        truncated = truncated || !!d.truncated;
      });
      b.data = {
        name: "(other)", other: true, _foldBucket: true,
        path: parent.data.path, other_dirs: unknownDirs ? null : dn,
        _deletedCount: deleted,
        size_actual: sk, size_apparent: sa,
        exclusive_actual: ek, exclusive_apparent: ea,
        copy_actual: ck, copy_apparent: ca, count: cnt,
        truncated: truncated || !!(parent.data && parent.data.truncated),
        children: []
      };
      b._color = "#6e7681";
      b._foldedKids = dirs;
    }

    function fillFileBucket(b, parent, files) {
      var sa = 0, sk = 0, remain = 0, deleted = 0, unknown = false;
      files.forEach(function (c) {
        var d = c.data || {};
        sa += Number(d.size_apparent || 0);
        sk += Number(d.size_actual || 0);
        if (d._files) {
          /* a folded own-files wedge contributes its own file count; null means
           * the snapshot predates own_count, so the tally is unknown. */
          if (d._remainCount == null) unknown = true;
          else remain += Number(d._remainCount);
        } else if (d.status === "removed") {
          /* a compare-mode "removed" ghost keeps its bytes above but is excluded
           * from the current-file count (it no longer exists); counted separately
           * so an all-deleted bucket can label itself "N deleted". */
          deleted += 1;
        } else {
          remain += 1; // a single current file leaf
        }
      });
      b.data = {
        name: "·files·", _files: true, _foldBucket: true,
        path: parent.data.path, _deletedCount: deleted,
        size_actual: sk, size_apparent: sa, count: null,
        /* null when any folded wedge has an unknown count, so the bucket shows
         * "files" (no number) instead of a precise undercount — matching how a
         * standalone null-count wedge already renders (displayName / tooltip). */
        _remainCount: unknown ? null : remain, children: []
      };
      b._color = "#363b44";
      b._foldedKids = files;
    }

    function foldPass(focus) {
      /* isTooThin compares an arc's on-screen width against MIN_ARC_PX*textK,
       * and foldPass runs BEFORE render() (which is what normally refreshes
       * textK). Without this, the very first fold (and the fold after a resize)
       * would use a stale textK and fold the wrong slices. */
      measureTextK();
      root.each(function (d) {
        d._folded = false;
      });
      root.each(function (parent) {
        parent._dirBucket = null;
        parent._fileBucket = null;
        var kids = parent.children;
        if (!kids || !kids.length) return;

        /* A folded parent is already represented by an ancestor's overflow
         * bucket; hide its whole subtree instead of surfacing a floating
         * bucket one ring out. BFS (root.each) folded this parent while
         * visiting its parent, so cascade the fold down to its children —
         * they'll cascade further as each is visited in turn. */
        if (parent._folded) {
          kids.forEach(function (c) { c._folded = true; });
          return;
        }

        /* Children sort by value (desc), so every too-thin child is part of
         * one contiguous tail — its union of spans has no gaps. */
        var thinDirs = [], thinFiles = [], x0 = Infinity, x1 = -Infinity,
          y0 = 0, y1 = 0, dirW = 0, fileW = 0;
        kids.forEach(function (c) {
          if (!arcVisible(c.target)) return;
          /* The own-files remainder wedge always folds into the file bucket so a
           * directory shows ONE "+N files" slice (un-promoted remainder + thin
           * promoted leaves merged); other children fold only when too thin to
           * draw, so genuinely-large files still surface as their own slices. */
          var wedge = c.data && c.data._files;
          if (!wedge && !isTooThin(c.target)) return;
          c._folded = true;
          if (c.target.x0 < x0) x0 = c.target.x0;
          if (c.target.x1 > x1) x1 = c.target.x1;
          y0 = c.target.y0;
          y1 = c.target.y1;
          var w = c.target.x1 - c.target.x0;
          if (isFileLike(c.data)) { thinFiles.push(c); fileW += w; }
          else { thinDirs.push(c); dirW += w; }
        });
        if (!thinDirs.length && !thinFiles.length) return;

        /* split the contiguous tail [x0,x1] between the two buckets by their
         * summed angular width, so neither overlaps the other. */
        var cursor = x0;
        if (thinDirs.length) {
          var bd = foldBucketFor(parent, "dir");
          fillDirBucket(bd, parent, thinDirs);
          setBucketGeom(bd, cursor, cursor + dirW, y0, y1);
          cursor += dirW;
          parent._dirBucket = bd;
        }
        if (thinFiles.length) {
          var bf = foldBucketFor(parent, "file");
          fillFileBucket(bf, parent, thinFiles);
          setBucketGeom(bf, cursor, x1, y0, y1);
          parent._fileBucket = bf;
        }
      });
    }

    /* The arcs/labels to render: every unfolded real node plus the active
     * overflow buckets (skipping the synthetic center root). */
    function renderNodes() {
      var out = [];
      root.each(function (d) {
        if (d.depth > 0 && !d._folded) out.push(d);
        if (d._dirBucket) out.push(d._dirBucket);
        if (d._fileBucket) out.push(d._fileBucket);
      });
      return out;
    }

    /* ---- render --------------------------------------------------------- */
    /* `animate` true → keyed-join transition: persisting arcs morph
     * current→target, entering arcs fade in at their target, exiting arcs fade
     * out. false → snap (setData/relayout/resize). This single path replaced
     * the old split between render() (snap) and zoomTo() (bespoke morph). */
    function render(animate) {
      measureTextK(); // keep label font constant px for the current display
      var nodes = renderNodes();
      var dur = animate ? TWEEN_MS : 0;

      /* Ring thickness can change between focuses (RINGS is a max, so a shallower
       * focus gets fatter rings). recomputeRadius() already set holeR/band to the
       * destination; on an animated render start the arcs at the on-screen values
       * (holeShown/bandShown) and tween to the destination below, so bands grow/
       * shrink smoothly with the angular morph instead of popping. */
      var holeTo = holeR,
        bandTo = band;
      var bandMoves =
        animate && (holeShown !== holeTo || bandShown !== bandTo);
      gArcs.interrupt("ringband");
      if (bandMoves) {
        holeR = holeShown;
        band = bandShown;
      }

      /* ARCS */
      var paths = gArcs.selectAll("path.sb-arc").data(nodes, nodeKey);

      paths
        .exit()
        .interrupt()
        /* stop hit-testing immediately so a slice fading out (folded away or
         * replaced by a rebuild) can't pop a tooltip for a node that is leaving
         * the view during its TWEEN_MS fade. */
        .attr("pointer-events", "none")
        .transition()
        .duration(animate ? TWEEN_MS : TWEEN_MS / 2)
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
        .on("mouseleave", onArcLeave)
        /* entering arcs appear at their target geometry (no stale `current` to
         * morph from), then fade in when animating. */
        .each(function (d) {
          d.current = d.target;
        })
        .attr("fill", opts.color || colorFor)
        .attr("d", function (d) {
          return arc(d.current);
        })
        .attr("stroke-opacity", function (d) {
          return arcVisible(d.target) ? 1 : 0;
        })
        .attr("pointer-events", function (d) {
          return arcVisible(d.target) ? "auto" : "none";
        })
        /* element opacity is left at the SVG default of 1 (fade-in/out is driven
         * by fill-opacity, exit by an opacity transition) — setting it inline
         * here would override the `.sb-hovering` dim rule and kill hover dimming. */
        .attr("fill-opacity", function (d) {
          return animate ? 0 : arcVisible(d.current) ? arcOpacity(d) : 0;
        });

      if (animate) {
        pathsEnter
          .transition()
          .duration(dur)
          .attr("fill-opacity", function (d) {
            return arcVisible(d.target) ? arcOpacity(d) : 0;
          });
      }

      /* UPDATE (persisting) — recolor instantly (a rebuild may re-hue), then
       * morph or snap to the destination geometry. */
      paths.attr("fill", opts.color || colorFor);
      if (animate) {
        paths
          .interrupt()
          .transition()
          .duration(dur)
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
      } else {
        /* A direct .attr() does NOT stop an in-flight transition, so a snap
         * landing mid-zoom (resize / SCALE toggle while a render(true) tween
         * is still ticking) must .interrupt() first — otherwise the old tween
         * keeps overwriting d.current and "d" and the arcs jump back. */
        paths
          .interrupt()
          .each(function (d) {
            d.current = d.target;
          })
          .attr("d", function (d) {
            return arc(d.current);
          })
          .attr("fill-opacity", function (d) {
            return arcVisible(d.current) ? arcOpacity(d) : 0;
          })
          .attr("stroke-opacity", function (d) {
            return arcVisible(d.current) ? 1 : 0;
          })
          .attr("pointer-events", function (d) {
            return arcVisible(d.current) ? "auto" : "none";
          });
      }

      /* Refresh the node->DOM lookup the hover path uses, and drop any stale
       * hover highlight referencing arcs that just exited. */
      var pathsAll = pathsEnter.merge(paths);
      arcDomByNode = new Map();
      pathsAll.each(function (d) {
        arcDomByNode.set(d, this);
      });
      setHover(null);

      /* LABELS — counter-scaled font; radial spokes fitted to the band */
      gLabels.attr("font-size", labelFontUnits());
      var labels = gLabels.selectAll("text.sb-label").data(nodes, nodeKey);
      labels.exit().remove();
      var labelsEnter = labels
        .enter()
        .append("text")
        .attr("class", "sb-label")
        .attr("dy", "0.32em")
        .attr("transform", function (d) {
          return labelTransform(d.current);
        });
      var labelsAll = labelsEnter.merge(labels);
      if (animate) {
        /* The label TEXT is set once and does not reflow during the tween, so it
         * must be fitted to the DESTINATION ring thickness (holeTo/bandTo) — not
         * the tween-start values the globals currently hold when the band is
         * changing (see the bandMoves block above, which sets band = bandShown).
         * Fitting to the old, fatter band of a previous focus would leave the
         * labels too long and overflow the ring on the way in. Only the transform
         * animates, and it reads the live (tweening) band frame-by-frame. */
        var holeCur = holeR,
          bandCur = band;
        holeR = holeTo;
        band = bandTo;
        labelsAll.text(function (d) {
          return labelFor(d, d.target);
        });
        holeR = holeCur;
        band = bandCur;
        labelsAll
          .transition()
          .duration(dur)
          .attr("opacity", function () {
            return this.textContent ? 1 : 0;
          })
          .attrTween("transform", function (d) {
            return function () {
              return labelTransform(d.current);
            };
          });
      } else {
        labelsAll
          .interrupt()
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
      }

      /* hidden-depth hint at the rim: more levels exist below the focus than the
       * RINGS cap draws, so the outermost ring isn't the bottom of the tree. */
      rimHint.style(
        "display",
        focusNode && depthBelow(focusNode) > ringCount ? null : "none"
      );

      if (bandMoves) {
        var hi = d3.interpolate(holeShown, holeTo);
        var bi = d3.interpolate(bandShown, bandTo);
        gArcs
          .transition("ringband")
          .duration(dur)
          .tween("rb", function () {
            return function (t) {
              holeR = hi(t);
              band = bi(t);
              /* update arcs re-eval arc(d.current) via their own tween; entering
               * arcs (no "d" tween) + labels + centre disc need this nudge. */
              pathsAll.attr("d", function (d) {
                return arc(d.current);
              });
              labelsAll.attr("transform", function (d) {
                return labelTransform(d.current);
              });
              syncHoleDisc();
            };
          })
          .on("end.rb interrupt.rb", function () {
            holeR = holeTo;
            band = bandTo;
            syncHoleDisc();
          });
      } else {
        syncHoleDisc();
      }
      holeShown = holeTo;
      bandShown = bandTo;

      /* updateCenter() reads holeR synchronously to fit/stack the centre label,
       * but the bandMoves block above left the globals at the tween-START radii
       * so the arcs animate from the current frame. Restore the destination radii
       * here so the label is fitted to the disc it settles in (the ringband tween
       * reasserts them per frame, so this stays consistent). */
      holeR = holeTo;
      band = bandTo;

      updateCenter();
      renderCrumbs();
      renderDetails();
    }

    function nodeKey(d) {
      /* Stable key across rebuilds: path + name + depth, plus a type tag so a
       * file leaf, a fold bucket, the real "(other)"/wedge and a real dir never
       * key-collide and get morphed into one another across a transition. */
      var data = d.data || {};
      var t = data._foldBucket
        ? data.other ? "B" : "W"
        : data._file
          ? "F"
          : data.other
            ? "O"
            : data._files
              ? "w"
              : "D";
      return data.path + "|" + data.name + "|" + d.depth + "|" + t;
    }

    function arcOpacity(d) {
      if (d.data && d.data._file) return 0.85; // a promoted file — solid-ish
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
          /* fit with the centre label's actual font (14px, monospace, bold) so
           * the truncation matches what renders and the name can't spill past
           * the disc; 1.6·holeR keeps a margin at the off-centre top line. */
          text: fitLabel(
            atRoot ? "(scan)" : f.data.name || f.data.path || "/",
            holeR * 1.6,
            14 * textK,
            true
          )
        },
        { el: centerSub, px: 18, text: U.humanBytes(nodeSize(f.data)) }
      ];
      /* the hint doubles as the loader's label: while loading, show "Loading…"
       * and never drop the line, so it stays put across the render/zoom that run
       * between graft and spinner-hide. updateCenter is the single source of truth. */
      if (!atRoot || loading) {
        cand.push({
          el: centerHint,
          px: 10,
          text: loading ? "Loading…" : "↑ click to zoom out"
        });
      }

      /* drop trailing lines until the stacked block fits inside the hole */
      var LH = 1.34;
      function blockHeight(n) {
        var h = 0;
        for (var i = 0; i < n; i++) h += cand[i].px * textK * LH;
        return h;
      }
      var keep = cand.length;
      while (keep > 1 && blockHeight(keep) > holeR * 1.55) keep--;

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
          U.orDash(f.data.count, U.commaCount)
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
      /* A directory served with a low file floor can carry hundreds of file
       * leaves; list the biggest DETAILS_FILE_CAP individually (rows are sorted
       * by size) and summarise the rest so the panel can't balloon. */
      var DETAILS_FILE_CAP = 50;
      var fileRows = 0, filesSkipped = 0, fileBytesSkipped = 0;
      kids.forEach(function (k) {
        var isFile = k.data && k.data._file;
        if (isFile) {
          if (fileRows >= DETAILS_FILE_CAP) {
            filesSkipped += 1;
            fileBytesSkipped += nodeSize(k.data);
            return;
          }
          fileRows += 1;
        }
        var ksize = nodeSize(k.data);
        var rowEl = el("button", "sb-row");
        rowEl.type = "button";
        var isFiles = k.data && k.data._files;
        var isOther = k.data && k.data.other;
        if (isFiles || isFile) rowEl.classList.add("sb-row-files");
        if (isOther) rowEl.classList.add("sb-row-other");

        var name = displayName(k.data) || k.data.path || "/";
        /* count column: a file leaf is one item; the wedge carries its own
         * remaining-file count; everything else is the subtree item count. */
        var cnt = isFile ? 1 : isFiles ? k.data._remainCount : k.data.count;
        var cntExact =
          cnt != null && !isNaN(cnt) ? U.commaCount(cnt) + " items" : "";
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
          '<span class="sb-row-count mono" title="' +
          U.esc(cntExact) +
          '">' +
          U.esc(U.orDash(cnt, U.humanCount)) +
          "</span>";

        /* Synthetic wedges and file leaves aren't navigable — drill()
         * early-returns on them. Skip the click handler (and the button
         * affordance) so the row doesn't look like a dead button. */
        if (!isFiles && !isFile) {
          rowEl.addEventListener("click", function () {
            drill(k);
          });
        } else {
          rowEl.disabled = true;
        }
        /* mouseenter rebuilds the tip; mousemove only repositions it. */
        rowEl.addEventListener("mouseenter", function (event) {
          showTip(event, k);
        });
        rowEl.addEventListener("mousemove", positionTip);
        rowEl.addEventListener("mouseleave", hideTip);
        list.appendChild(rowEl);
      });

      if (filesSkipped > 0) {
        var more = el("div", "sb-details-more");
        more.textContent =
          "and " + U.commaCount(filesSkipped) + " more files · " +
          U.humanBytes(fileBytesSkipped);
        list.appendChild(more);
      }
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
        /* a real truncated "(other)" always drills; a synthetic fold bucket only
         * expands in some positions — don't tell the user to click otherwise.
         * Skip the "smaller folders grouped" line when the bucket holds only
         * deleted ghosts (other_dirs === 0) — the deleted note below covers it. */
        var canExpand = !data._foldBucket || canExpandFold(d);
        if (data.other_dirs == null || data.other_dirs > 0) {
          rows.push(
            '<div class="sb-tip-note">' +
              U.esc(
                (data.other_dirs != null ? data.other_dirs : "Several") +
                  " smaller folders grouped" +
                  (canExpand ? " — click to expand" : "")
              ) +
              "</div>"
          );
        }
      } else if (data._file) {
        /* a single promoted file */
        if (data.nlink > 1) {
          rows.push(
            '<div class="sb-tip-note">' +
              U.esc(
                "Hard-linked file (" + data.nlink + " links) — bytes counted once"
              ) +
              "</div>"
          );
        }
      } else if (data._files && !(data._remainCount === 0 && data._deletedCount > 0)) {
        /* In dedupe mode the wedge really is just the parent's own files.
         * In exclusive mode it also absorbs bytes shared between sibling
         * subtrees (exclusive at the parent but not at any child); in
         * copies mode it absorbs copy bytes that don't roll up to a
         * child — so the wording has to match the active hl-mode. An
         * all-deleted fold bucket (_remainCount === 0, only deleted ghosts)
         * holds no live files, so it skips this note and shows only the
         * "N deleted" note below; the unknown-count case (_remainCount ===
         * null, live files of unknown tally) still shows it. */
        var note =
          hlMode === "exclusive"
            ? "Files held directly here (bytes exclusive to this directory)"
            : hlMode === "copies"
              ? "Files held directly here, plus hard-link copies unique to this directory"
              : "Files held directly in this directory";
        rows.push('<div class="sb-tip-note">' + U.esc(note) + "</div>");
      }

      /* compare-mode fold bucket: call out how many of the grouped slices are
       * deleted ghosts (shown at their former size but not in the live count). */
      if (data._foldBucket && data._deletedCount > 0) {
        rows.push(
          '<div class="sb-tip-note">' +
            U.esc(
              data._deletedCount +
                " deleted since the baseline — shown at their former size"
            ) +
            "</div>"
        );
      }

      if (opts.tooltipRows) {
        /* compare mode replaces the metric rows with before/after/delta */
        opts.tooltipRows(data).forEach(function (r) {
          rows.push(tipRow(r.k, r.v));
        });
      } else if (data._file) {
        /* a single promoted file: show both sizes, its share, and (when
         * hard-linked) the link count. It is a leaf — no Items/Child dirs. */
        rows.push(tipRow("On disk", bytesDual(Number(data.size_actual || 0))));
        rows.push(tipRow("Apparent", bytesDual(Number(data.size_apparent || 0))));
        rows.push(tipRow("% of parent", U.pctStr(sz, parentSz)));
        rows.push(tipRow("% of scan", U.pctStr(sz, totalSize)));
        if (data.nlink > 1) rows.push(tipRow("Hard links", String(data.nlink)));
      } else if (data._files) {
        /* Two producers land here: the own-files remainder wedge stores
         * size_actual === size_apparent === remainder (current sizeKey/
         * hlMode), while a folded file bucket (fillFileBucket) sums
         * size_actual and size_apparent *separately*, so the two diverge
         * for sparse/sub-block files. Use nodeSize() — the same value the
         * arc and the %-rows use — so the single byte row is mode-correct
         * and reconciles with its own percentages (a hardcoded size_actual
         * would show the actual sum under an "Apparent" label in apparent
         * mode). Skip the always-"—" Child dirs row. */
        rows.push(tipRow(countedLabel(), bytesDual(sz)));
        rows.push(tipRow("% of parent", U.pctStr(sz, parentSz)));
        rows.push(tipRow("% of scan", U.pctStr(sz, totalSize)));
        /* the file count the old wedge never had (Issue 3) */
        if (data._remainCount != null) {
          rows.push(tipRow("Files", U.commaCount(data._remainCount)));
        }
      } else {
        /* show both sizes so the Actual/Apparent distinction is always
         * visible — they are equal unless a directory holds sparse or
         * sub-block files. */
        var saV = Number(data.size_actual || 0);
        var skV = Number(data.size_apparent || 0);
        rows.push(tipRow("On disk", bytesDual(saV)));
        rows.push(tipRow("Apparent", bytesDual(skV)));
        /* In copies/exclusive mode the arc width and the "% of parent" /
         * "% of scan" rows come from nodeSize(), which is neither
         * size_actual nor size_apparent. Add the actual counted figure
         * so the percentages reconcile against a visible denominator. */
        if (hlMode !== "dedupe") {
          rows.push(tipRow(countedLabel(), bytesDual(sz)));
        }
        rows.push(tipRow("% of parent", U.pctStr(sz, parentSz)));
        rows.push(tipRow("% of scan", U.pctStr(sz, totalSize)));
        rows.push(
          tipRow("Items", U.orDash(data.count, U.commaCount))
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
        var f = sizeFields(data);
        if (f.ex != null && Number(f.ex) < f.base) {
          rows.push(
            tipRow(
              "Exclusive",
              U.humanBytes(Number(f.ex)) +
                "  ·  shared " + U.humanBytes(f.base - Number(f.ex))
            )
          );
        }
        if (f.cp) {
          rows.push(tipRow("Hard-link copies", U.humanBytes(Number(f.cp))));
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

    /* "humanBytes  ·  exactBytes B" — the dual short/exact value the tip
     * uses for every byte row (wedge counted, On disk, Apparent, the
     * non-dedupe counted row). One place to tune the separator/units. */
    function bytesDual(v) {
      return U.humanBytes(v) + "  ·  " + U.exactBytes(v) + " B";
    }

    function positionTip(event) {
      var pad = 16;
      var w = tipW || 240;
      var h = tipH || 120;
      var x = event.clientX + pad;
      var y = event.clientY + pad;
      if (x + w > window.innerWidth - 8) x = event.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = event.clientY - h - pad;
      /* transform (composited), not left/top (layout) — see .sb-tip in app.css */
      tip.style.transform =
        "translate(" + Math.max(8, x) + "px," + Math.max(8, y) + "px)";
    }

    function hideTip() {
      tip.style.display = "none";
    }

    /* ---- hover highlighting -------------------------------------------- */
    /* Drop the hi/dim/anc classes from every arc and hide the tip. Shared by
     * onArcLeave, the lazyLoad pre-graft cleanup, and zoomTo — keeping it in
     * one place is what R15 had to retrofit in lazyLoad after the cache-hit
     * regression. */
    /* Highlight the hovered arc + its ancestors and flip the container's
     * `sb-hovering` class; CSS dims everything else. Touches only the hovered
     * chain (O(depth)) — never all arcs — so hover cost is flat in arc count.
     * `d === null` clears the highlight. */
    function setHover(d) {
      for (var i = 0; i < hoverChain.length; i++) {
        hoverChain[i].classList.remove("sb-arc-hi", "sb-arc-anc");
      }
      hoverChain = [];
      if (!d) {
        gArcs.classed("sb-hovering", false);
        return;
      }
      gArcs.classed("sb-hovering", true);
      d.ancestors().forEach(function (n) {
        var node = arcDomByNode.get(n);
        if (!node) return; // off-ring ancestor (focus root & up) — not rendered
        node.classList.add(n === d ? "sb-arc-hi" : "sb-arc-anc");
        hoverChain.push(node);
      });
    }

    function clearHover() {
      setHover(null);
      hideTip();
    }

    function onArcEnter(event, d) {
      setHover(d);
      showTip(event, d);
    }

    /* mousemove fires far above 60fps; coalesce repositioning to one per frame
     * so a fast cursor doesn't queue a layout/transform per event. */
    var moveRaf = 0,
      lastMoveEvt = null;
    function onArcMove(event) {
      lastMoveEvt = event;
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(function () {
        moveRaf = 0;
        if (lastMoveEvt) positionTip(lastMoveEvt);
      });
    }

    function onArcLeave() {
      clearHover();
    }

    /* ---- interaction: click / drill ------------------------------------ */
    function onArcClick(event, d) {
      drill(d);
    }

    /* Drill into node `d`: lazy-load if needed, else pure zoom tween. */
    function drill(d) {
      var data = d.data || {};
      if (data._foldBucket) {
        expandFold(d);
        return;
      }
      if (data._files || data._file) return; // synthetic wedge / file leaf — not navigable

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

    /* Expand an angular-fold bucket. The folded children already exist in the
     * hierarchy, so zooming to the parent gives them the full circle and the
     * next foldPass un-folds them. If the bucket still hides server-truncated
     * directories (a real "(other)" got folded in), fetch those first — the
     * subsequent rebuild zooms to the parent and un-folds. */
    /* A folded "(other)" still hides a server-truncated "(other)" that must be
     * fetched before the bucket can un-fold. True only when such a real (other)
     * is among the folded kids and its subtree isn't already cached. */
    function foldNeedsFetch(d) {
      var pdata = (d.parent && d.parent.data) || {};
      return !!(
        d.data.other &&
        pdata.truncated &&
        opts.fetchSubtree &&
        pdata.path != null &&
        !subtreeCache[pdata.path] &&
        (d._foldedKids || []).some(function (c) {
          return c.data && c.data.other && !c.data._foldBucket;
        })
      );
    }

    /* Does clicking this fold bucket do anything? It can fetch a hidden
     * truncated subtree, or zoom to the parent so the folded dirs get the full
     * circle. When the parent is already the focus and nothing is truncated
     * there is nowhere to zoom — the folded items are only browsable in the
     * details panel, so the tooltip must not promise "click to expand". */
    function canExpandFold(d) {
      return !!d.parent && (foldNeedsFetch(d) || d.parent !== focusNode);
    }

    function expandFold(d) {
      var parent = d.parent;
      if (!parent) return;
      if (foldNeedsFetch(d)) {
        var realOther = null;
        (d._foldedKids || []).forEach(function (c) {
          if (c.data && c.data.other && !c.data._foldBucket) realOther = c;
        });
        lazyLoad(realOther); // foldNeedsFetch guarantees realOther exists
        return;
      }
      /* Already focused at the parent (the bucket is a direct focus child that
       * still can't fit all its children) — there is nothing further to zoom;
       * the folded items remain browsable in the details panel. */
      if (parent !== focusNode) zoomTo(parent);
    }

    /* Lazy-load a subtree, graft it in, rebuild and zoom. */
    function lazyLoad(d) {
      var data = d.data;
      var path = data.path;
      if (pendingFetch[path]) return;

      /* Strip hover state up front on BOTH paths: rebuildPreservingFocus
       * only triggers zoomTo (which clears hi/dim/anc + hideTip) when the
       * loaded path differs from the current focus. On an (other) graft
       * the loaded path *is* the parent's path, so if the user was already
       * focused there the zoom is skipped and stale highlight + pinned
       * tip from the click-source arc persist on the freshly grafted view. */
      clearHover();

      /* cache hit — graft instantly */
      if (subtreeCache[path]) {
        graftChildren(data, subtreeCache[path]);
        rebuildPreservingFocus(path);
        return;
      }

      pendingFetch[path] = true;
      /* Debounce the loader: arm a timer instead of showing it now, so fetches
       * that beat SPINNER_DELAY_MS resolve with no flash. Armed once; concurrent
       * fetches share it and the cleanup below clears it when the last lands. */
      if (!spinnerTimer && !loading) {
        spinnerTimer = setTimeout(function () {
          spinnerTimer = 0;
          if (Object.keys(pendingFetch).length) showSpinner();
        }, SPINNER_DELAY_MS);
      }

      /* Capture the dataset epoch: setData() between dispatch and resolve
       * replaces rawRoot/subtreeCache/pendingFetch, so the resolved kids
       * belong to the old scan. Writing them into the new subtreeCache
       * and calling rebuildPreservingFocus(path) would poison the new
       * dataset and (worst case) zoom it into a coincidentally-named
       * node. The captured `data` reference is also orphan-bound. */
      var owningRoot = rawRoot;
      Promise.resolve(opts.fetchSubtree(path))
        .then(function (node) {
          if (destroyed || rawRoot !== owningRoot) return;
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
          if (destroyed || rawRoot !== owningRoot) return;
          delete pendingFetch[path];
          /* Refcount via pendingFetch: a concurrent fetch on another arc
           * (different path) keeps the spinner up until the last one lands. */
          if (Object.keys(pendingFetch).length === 0) {
            clearTimeout(spinnerTimer);
            spinnerTimer = 0;
            hideSpinner();
          }
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
          parent.truncated = false;
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
      buildAndSnap(focusNode ? focusNode.data.path : "", loadedPath);
    }

    /* ---- spinner -------------------------------------------------------- */
    function showSpinner() {
      loading = true;
      loaderRing.style("display", null);
      updateCenter(); // repaint the hint as "Loading…"
    }
    function hideSpinner() {
      if (!loading) return;
      loading = false;
      loaderRing.style("display", "none");
      updateCenter(); // restore the hint (also the fetch-failure recovery path)
    }

    /* ---- zoom ----------------------------------------------------------- */
    /* Re-focus on `p`: re-project geometry, recompute the focus-aware fold
     * (folded children differ at every zoom level), then animate via the keyed
     * render. Clearing hover first matters because arcs whose target is
     * invisible have pointer-events flipped to "none", so mouseleave never
     * fires on whatever the user just clicked. */
    function zoomTo(p, silent) {
      if (!p) return;
      focusNode = p;
      project(p);
      recomputeRadius(p); // fill rings to depth-below-p (before foldPass uses band)
      foldPass(p);
      clearHover();
      render(true);

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
      clearTimeout(spinnerTimer); // drop any pending debounced loader from the old tree
      spinnerTimer = 0;
      hideSpinner(); // a fresh root must not inherit a prior fetch's spinner
      clearHover(); // nor a pinned tooltip / hover classes from the old tree
      buildAndSnap(null, null); // null focus path → reset to root
    }

    /* Drive focus from the URL. `path` "" → scan root. If the path lies
     * inside a not-yet-loaded subtree, we focus the deepest loaded ancestor. */
    function focusByPath(path) {
      if (!root) return;
      if (path == null) path = "";

      var hit = findHierByPath(path);
      if (hit) {
        var data = hit.data || {};
        /* If the target is truncated and its only loaded children are a folded
         * server "(other)" bucket (or none), zooming to it would show a dead
         * single-"(other)" view ("folders" 100%, "No children loaded yet"). A
         * click-drill expands such a node via fetchSubtree; a programmatic focus
         * (Changes-table row, highlight card, deep link, metric-toggle restore)
         * must do the same. lazyLoad grafts the real children and its rebuild
         * zooms in, so we don't zoom here first. Mirrors drill()'s needFetch. */
        if (
          data.truncated &&
          opts.fetchSubtree &&
          data.path != null &&
          !subtreeCache[data.path] &&
          !hasRealChildren(data)
        ) {
          lazyLoad(hit);
          return;
        }
        /* silent: the router already owns the URL hash. */
        if (hit !== focusNode) zoomTo(hit, true);
        return;
      }

      /* Path not loaded — focus the deepest loaded prefix so a deep link at
       * least lands nearby. */
      var deepest = deepestLoadedAncestor(path);
      if (deepest && deepest !== focusNode) zoomTo(deepest, true);
    }

    /* Find the deepest loaded hierarchy node whose path is a prefix of `path`.
     * Boundary-aware so /foo doesn't match /foobar. */
    function deepestLoadedAncestor(path) {
      var best = root;
      root.each(function (d) {
        var p = d.data && d.data.path;
        if (!p) return;
        if (p === path || path.indexOf(p + "/") === 0) {
          if (p.length > (best.data.path || "").length) best = d;
        }
      });
      return best;
    }

    /* ---- toolbar controls ---------------------------------------------- */
    /* Rebuild the hierarchy and re-render, keeping the user's focus. */
    function relayout() {
      buildAndSnap(focusNode ? focusNode.data.path : "", null);
    }

    /* Shared build+project+snap+render pipeline used by setData, relayout,
     * and rebuildPreservingFocus. Sets focusNode from `focusPath` (null → root),
     * then optionally zooms to `zoomPath` (the node that just got grafted in). */
    function buildAndSnap(focusPath, zoomPath) {
      root = buildHierarchy();
      /* nodeSize() reads the live sizeKey/hlMode, so the "% of scan" denominator
       * has to be refreshed on every rebuild — toolbar toggles (relayout) and
       * subtree grafts (rebuildPreservingFocus) both flow through here. */
      totalSize = nodeSize(rawRoot) || 1;
      focusNode = (focusPath != null && findHierByPath(focusPath)) || root;
      project(focusNode);
      recomputeRadius(focusNode); // fill rings to actual depth (before foldPass)
      foldPass(focusNode);
      root.each(function (d) {
        d.current = d.target;
      });

      var target = zoomPath ? findHierByPath(zoomPath) : null;
      if (target && target !== focusNode) {
        /* base snap, then animate the zoom into the freshly-grafted node */
        render(false);
        zoomTo(target);
      } else if (target === focusNode && target) {
        /* FM-1: a graft landed while already focused at the parent. The grafted
         * children are fresh keys (the keyed join sees them as the enter
         * selection), so an animated render fades/grows them in instead of the
         * old dead in-place snap. */
        render(true);
      } else {
        render(false);
      }
    }

    /* Recompute geometry for a new ring count. The following relayout() rebuilds
     * and re-renders (a snap), so the band fills to the focus's actual depth. */
    function applyRings(n) {
      ringCount = Math.max(2, Math.min(5, n));
      if (focusNode || root) recomputeRadius(focusNode || root);
      else {
        holeR = HOLE_R;
        band = HOLE_R;
      }
      syncHoleDisc();
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
      /* Read-only getter so embedders (compare's metric toggle) can
       * round-trip the user's drill-in across a destroy+rebuild. */
      getFocusPath: function () {
        return focusNode && focusNode.data ? focusNode.data.path || "" : "";
      },
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
        cancelAnimationFrame(moveRaf);
        clearTimeout(spinnerTimer);
        toolbar.removeEventListener("click", onToolbarClick);
        if (svg) {
          /* Cancel any in-flight zoom tween so it doesn't keep ticking
           * for TWEEN_MS against the about-to-be-detached subtree. The
           * ring-band tween is a NAMED transition, which an unnamed
           * interrupt() leaves running, so cancel it explicitly too. */
          svg.interrupt();
          svg.selectAll("*").interrupt();
          gArcs.interrupt("ringband");
          if (svg.node() && svg.node().parentNode) {
            svg.node().parentNode.removeChild(svg.node());
          }
        }
        pendingFetch = {};
      }
    };
  }

  global.Sunburst = Sunburst;
})(window);
