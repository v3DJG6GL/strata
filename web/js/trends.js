/* ==========================================================================
 * trends.js — "storage over time" line chart for the dashboard
 *
 *   Trends.render(containerEl, snapshots)  // snapshots = op=snapshots list
 *   -> draws a total-size timeline; returns true if a chart was drawn
 *      (needs >= 2 dated snapshots), false otherwise. Dots link to the scan.
 *
 * Depends on: d3 (v7 global), Util.
 * ======================================================================== */
(function (global) {
  "use strict";

  var d3 = global.d3;
  var U = global.Util;

  /* "2026-05-20_22-37" -> Date, or null if unparseable. */
  function tsToDate(ts) {
    var p = String(ts || "").split("_");
    if (p.length !== 2) return null;
    var d = new Date(p[0] + "T" + p[1].replace("-", ":"));
    return isNaN(d.getTime()) ? null : d;
  }

  function render(container, snapshots) {
    if (!container) return false;
    container.innerHTML = "";

    /* keep dated snapshots with a known total size, oldest -> newest */
    var pts = (snapshots || [])
      .map(function (s) {
        return {
          ts: s.ts,
          label: s.label || s.ts,
          date: tsToDate(s.ts),
          size: s.total ? Number(s.total.size_actual) : null
        };
      })
      .filter(function (p) {
        return p.date && p.size != null && !isNaN(p.size);
      })
      .sort(function (a, b) {
        return a.date - b.date;
      });

    if (pts.length < 2) return false; // not enough history to plot

    var W = 960,
      H = 240,
      m = { top: 18, right: 22, bottom: 30, left: 72 },
      iw = W - m.left - m.right,
      ih = H - m.top - m.bottom;

    var x = d3
      .scaleTime()
      .domain(d3.extent(pts, function (p) { return p.date; }))
      .range([0, iw]);
    var maxV = d3.max(pts, function (p) { return p.size; }) || 1;
    var y = d3.scaleLinear().domain([0, maxV * 1.12]).nice().range([ih, 0]);

    var svg = d3
      .select(container)
      .append("svg")
      .attr("class", "trend-svg")
      .attr("viewBox", [0, 0, W, H])
      .attr("preserveAspectRatio", "xMidYMid meet");
    var g = svg
      .append("g")
      .attr("transform", "translate(" + m.left + "," + m.top + ")");

    /* y gridlines + size labels */
    var yticks = y.ticks(4);
    g.selectAll("line.trend-grid")
      .data(yticks)
      .enter()
      .append("line")
      .attr("class", "trend-grid")
      .attr("x1", 0)
      .attr("x2", iw)
      .attr("y1", function (d) { return y(d); })
      .attr("y2", function (d) { return y(d); });
    g.selectAll("text.trend-ylab")
      .data(yticks)
      .enter()
      .append("text")
      .attr("class", "trend-ylab")
      .attr("x", -12)
      .attr("y", function (d) { return y(d); })
      .attr("dy", "0.32em")
      .attr("text-anchor", "end")
      .text(function (d) { return U.humanBytes(d); });

    /* x date labels */
    var xticks = x.ticks(Math.min(6, pts.length));
    var fmt = d3.timeFormat("%b %d");
    g.selectAll("text.trend-xlab")
      .data(xticks)
      .enter()
      .append("text")
      .attr("class", "trend-xlab")
      .attr("x", function (d) { return x(d); })
      .attr("y", ih + 21)
      .attr("text-anchor", "middle")
      .text(fmt);

    /* area + line */
    var area = d3
      .area()
      .x(function (p) { return x(p.date); })
      .y0(ih)
      .y1(function (p) { return y(p.size); })
      .curve(d3.curveMonotoneX);
    var line = d3
      .line()
      .x(function (p) { return x(p.date); })
      .y(function (p) { return y(p.size); })
      .curve(d3.curveMonotoneX);
    g.append("path").datum(pts).attr("class", "trend-area").attr("d", area);
    g.append("path").datum(pts).attr("class", "trend-line").attr("d", line);

    /* cursor-following tooltip */
    var tip = document.createElement("div");
    tip.className = "trend-tip";
    tip.style.display = "none";
    container.style.position = "relative";
    container.appendChild(tip);

    /* dots — clickable, link to that scan */
    var dots = g
      .selectAll("g.trend-dot")
      .data(pts)
      .enter()
      .append("g")
      .attr("class", "trend-dot")
      .attr("transform", function (p) {
        return "translate(" + x(p.date) + "," + y(p.size) + ")";
      })
      .style("cursor", "pointer")
      .attr("tabindex", 0)
      .attr("role", "link")
      .attr("aria-label", function (p) {
        return p.label + " — " + U.humanBytes(p.size);
      });
    dots.append("circle").attr("class", "trend-hit").attr("r", 15);
    dots.append("circle").attr("class", "trend-pt").attr("r", 4);

    function go(p) {
      global.location.hash = "#/scan/" + encodeURIComponent(p.ts);
    }
    dots.on("click", function (e, p) { go(p); });
    dots.on("keydown", function (e, p) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go(p);
      }
    });

    dots
      .on("mouseenter focus", function (e, p) {
        var i = pts.indexOf(p);
        var delta = i > 0 ? p.size - pts[i - 1].size : null;
        var dHtml =
          delta == null || delta === 0
            ? ""
            : ' <span class="trend-tip-d ' +
              (delta > 0 ? "up" : "down") +
              '">' +
              (delta > 0 ? "▲ " : "▼ ") +
              U.esc(U.humanBytes(Math.abs(delta))) +
              "</span>";
        tip.innerHTML =
          '<div class="trend-tip-lab">' + U.esc(p.label) + "</div>" +
          '<div class="trend-tip-val mono">' +
          U.esc(U.humanBytes(p.size)) +
          dHtml +
          "</div>";
        tip.style.display = "block";
      })
      .on("mousemove", function (e) {
        var r = container.getBoundingClientRect();
        var tx = e.clientX - r.left + 16;
        var ty = e.clientY - r.top + 16;
        if (tx + 210 > r.width) tx = e.clientX - r.left - 210;
        tip.style.left = Math.max(4, tx) + "px";
        tip.style.top = ty + "px";
      })
      .on("mouseleave blur", function () {
        tip.style.display = "none";
      });

    return true;
  }

  global.Trends = { render: render };
})(window);
