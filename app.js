/* Meridian Analytics demo: vanilla JS, hand-rolled SVG charts, all filtering client-side. */
(function () {
  "use strict";

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var D, cube, segCube, N, C, state = { from: 0, to: 0, cat: -1, psort: { key: "rev", dir: -1 }, pq: "", pall: false };
  var redraws = [];
  var MIN_SKELETON_MS = 350;

  /* ---------- formatting ---------- */
  var usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  var usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  var int0 = new Intl.NumberFormat("en-US");
  var compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  var money = function (v) { return usd0.format(v); };
  var moneyC = function (v) { return "$" + compact.format(v); };
  var pct = function (v, d) { return (v * 100).toFixed(d == null ? 1 : d) + "%"; };
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dlabel(iso, withYear) { var p = iso.split("-"); return MON[+p[1] - 1] + " " + (+p[2]) + (withYear ? ", " + p[0] : ""); }
  function mlabel(ym) { var p = ym.split("-"); return MON[+p[1] - 1] + " " + p[0].slice(2); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* ---------- data model ---------- */
  function build(data) {
    D = data; N = D.days.length; C = D.categories.length;
    cube = []; for (var c = 0; c <= C; c++) cube.push(zeros(N));
    D.rows.forEach(function (r) { for (var k = 0; k < 8; k++) { cube[r[1] + 1][r[0]][k] += r[2 + k]; cube[0][r[0]][k] += r[2 + k]; } });
    segCube = []; for (var s = 0; s < D.segments.length; s++) segCube.push(zeros(N));
    D.segRows.forEach(function (r) { for (var k = 0; k < 8; k++) segCube[r[1]][r[0]][k] += r[2 + k]; });
    D.monthFirst = D.months.map(function (m) { return D.days.indexOf(m + "-01") < 0 ? firstDayIdx(m) : D.days.indexOf(m + "-01"); });
    D.outageWin = outageWindow();
  }
  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push([0, 0, 0, 0, 0, 0, 0, 0]); return a; }
  function firstDayIdx(m) { for (var i = 0; i < N; i++) if (D.days[i].slice(0, 7) === m) return i; return 0; }
  /* contiguous days with a spike of critical/high payment-gateway incidents (>= 10/day) */
  function outageWindow() {
    var hot = D.outage.filter(function (o) { return o[1] >= 10; }).map(function (o) { return o[0]; }).sort(function (a, b) { return a - b; });
    return hot.length ? [hot[0], hot[hot.length - 1]] : null;
  }
  // vector: 0 orders, 1 recOrders, 2 revenueCents, 3 tx, 4 failed, 5 declined, 6 refunded, 7 refundedCents
  function sumRange(arr, a, b) { var v = [0, 0, 0, 0, 0, 0, 0, 0]; for (var i = Math.max(a, 0); i <= b && i < N; i++) for (var k = 0; k < 8; k++) v[k] += arr[i][k]; return v; }
  var M = {
    rev: function (v) { return v[2] / 100; },
    orders: function (v) { return v[1]; },
    aov: function (v) { return v[1] ? v[2] / 100 / v[1] : 0; },
    fail: function (v) { return v[3] ? (v[4] + v[5]) / v[3] : 0; },
    refund: function (v) { return v[0] ? v[6] / v[0] : 0; }
  };

  /* ---------- buckets ---------- */
  function buckets(a, b) {
    var n = b - a + 1, out = [], i;
    if (n <= 62) { for (i = a; i <= b; i++) out.push({ a: i, b: i, label: dlabel(D.days[i]), long: dlabel(D.days[i], true) }); }
    else if (n <= 300) { for (i = a; i <= b; i += 7) { var e = Math.min(i + 6, b); out.push({ a: i, b: e, label: dlabel(D.days[i]), long: "Week of " + dlabel(D.days[i], true) }); } }
    else { var cur = null; for (i = a; i <= b; i++) { var m = D.days[i].slice(0, 7); if (!cur || cur.m !== m) { cur = { a: i, b: i, m: m, label: mlabel(m), long: mlabel(m) }; out.push(cur); } else cur.b = i; } }
    return out;
  }
  function bucketVecs(arr, bk) { return bk.map(function (x) { return sumRange(arr, x.a, x.b); }); }
  function monthsInRange() { var r = []; D.months.forEach(function (m, i) { var a = D.monthFirst[i], b = i + 1 < D.months.length ? D.monthFirst[i + 1] - 1 : N - 1; if (b >= state.from && a <= state.to) r.push(i); }); return r; }

  /* ---------- svg helpers ---------- */
  function niceStep(v) { var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }
  function niceMax(v) { if (v <= 0) return 1; var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p; var n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10; return n * p; }
  function register(el, draw) {
    el._draw = draw; draw(el.clientWidth || 600);
    if (!el._ro && "ResizeObserver" in window) { el._ro = new ResizeObserver(function () { var w = el.clientWidth; if (w && w !== el._w) { el._w = w; el._draw(w); } }); el._ro.observe(el); }
    el._w = el.clientWidth;
  }
  function tipShow(html, x, y) {
    var t = $("#tip"); t.innerHTML = html; t.hidden = false;
    var w = t.offsetWidth, h = t.offsetHeight, nx = x + 14, ny = y - h - 10;
    if (nx + w > window.innerWidth - 8) nx = x - w - 14; if (nx < 8) nx = 8; if (ny < 8) ny = y + 16;
    t.style.left = nx + "px"; t.style.top = ny + "px";
  }
  function tipHide() { $("#tip").hidden = true; }

  /* time-series chart: line (+area) or stacked columns. opts: {labels, longs, series[{name,color,values}], fmt, axFmt, stacked, area, annotate, zeroBase} */
  function timeChart(el, o) {
    register(el, function (W) {
      var narrow = W < 460, H = narrow ? 220 : 280;
      var m = { t: 14, r: narrow ? 8 : 14, b: 28, l: narrow ? 44 : 54 };
      var iw = W - m.l - m.r, ih = H - m.t - m.b, n = o.labels.length;
      var max = 0;
      for (var i = 0; i < n; i++) { var tot = 0; o.series.forEach(function (s) { tot = o.stacked ? tot + s.values[i] : Math.max(tot, s.values[i]); }); max = Math.max(max, tot); }
      var tstep = niceStep((max * 1.03 || 1) / 4), top = tstep * Math.ceil((max * 1.03 || 1) / tstep), ticks = Math.round(top / tstep), y = function (v) { return m.t + ih - (v / top) * ih; };
      var step = n > 1 ? iw / (o.stacked ? n : n - 1) : iw, x = function (i) { return m.l + (o.stacked ? step * (i + .5) : step * i); };
      var g = "";
      for (var t = 0; t <= ticks; t++) { var v = top / ticks * t, yy = y(v); g += '<line class="' + (t ? "grid-l" : "axis-l") + '" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yy + '" y2="' + yy + '"/><text class="ax" x="' + (m.l - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + o.axFmt(v) + "</text>"; }
      var maxLbl = Math.max(2, Math.floor(iw / 78)), every = Math.ceil(n / maxLbl);
      for (i = 0; i < n; i += every) g += '<text class="ax" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 && !o.stacked ? "start" : "middle") + '">' + o.labels[i] + "</text>";
      var ann = "";
      if (o.annotate) {
        var a = o.annotate, xa = x(a.from) - (o.stacked ? step / 2 : 0), xb = x(a.to) + (o.stacked ? step / 2 : 0);
        if (!o.stacked && a.from === a.to) { xa -= step / 2; xb += step / 2; }
        xa = Math.max(xa, m.l); xb = Math.min(xb, W - m.r); if (xb - xa < 4) { xb = xa + 4; }
        ann = '<rect x="' + xa + '" y="' + m.t + '" width="' + (xb - xa) + '" height="' + ih + '" fill="var(--warn-band)"/>' +
          '<text class="lbl2" x="' + Math.min(xb + 6, W - m.r - 4) + '" y="' + (m.t + 12) + '" text-anchor="' + (xb + 150 > W ? "end" : "start") + '"' + (xb + 150 > W ? ' transform="translate(' + (-(xb - xa) - 12) + ',0)"' : "") + '>Payment-gateway outage</text>';
      }
      var marks = "";
      if (o.stacked) {
        var bw = Math.max(2, Math.min(36, step * .72));
        for (i = 0; i < n; i++) { var acc = 0; o.series.forEach(function (s, si) { var v = s.values[i]; if (!v) return; var y0 = y(acc), y1 = y(acc + v); marks += '<rect x="' + (x(i) - bw / 2) + '" y="' + y1 + '" width="' + bw + '" height="' + Math.max(0, y0 - y1 - (si ? 2 : 0)) + '" rx="2" fill="' + s.color + '"/>'; acc += v; }); }
      } else {
        o.series.forEach(function (s) {
          var d = s.values.map(function (v, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1); }).join("");
          if (o.area) marks += '<path d="' + d + "L" + x(n - 1) + " " + y(0) + "L" + x(0) + " " + y(0) + 'Z" fill="' + s.color + '" fill-opacity=".12"/>';
          marks += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
          var li = n - 1; marks += '<circle cx="' + x(li) + '" cy="' + y(s.values[li]) + '" r="4" fill="' + s.color + '" stroke="var(--surface)" stroke-width="2"/>';
        });
      }
      var label = o.aria + " " + o.labels[0] + " to " + o.labels[n - 1] + ".";
      el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" tabindex="0" aria-label="' + esc(label) + ' Use arrow keys to read values.">' + g + ann + marks + '<g class="hov"></g></svg>';
      var svg = el.firstChild, hov = svg.querySelector(".hov"), cur = -1;
      function show(i, cx, cy) {
        cur = i; var xi = x(i), h = "";
        h += '<line x1="' + xi + '" x2="' + xi + '" y1="' + m.t + '" y2="' + (m.t + ih) + '" stroke="var(--ink2)" stroke-width="1" stroke-dasharray="3 3"/>';
        if (!o.stacked) o.series.forEach(function (s) { h += '<circle cx="' + xi + '" cy="' + y(s.values[i]) + '" r="5" fill="' + s.color + '" stroke="var(--surface)" stroke-width="2"/>'; });
        hov.innerHTML = h;
        var rows = o.series.map(function (s) { return '<div class="r"><span><span class="sw" style="background:' + s.color + '"></span>' + esc(s.name) + "</span><b>" + o.fmt(s.values[i]) + "</b></div>"; }).join("");
        var note = o.annotate && bucketHitsOutage(o, i) ? '<div class="r"><span>Gateway outage logged</span></div>' : "";
        var r = svg.getBoundingClientRect();
        tipShow("<b>" + o.longs[i] + "</b>" + rows + note, cx != null ? cx : r.left + xi * (r.width / W), cy != null ? cy : r.top + m.t * (r.width / W) + 20);
      }
      function nearest(ev) { var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width); var i = o.stacked ? Math.floor((px - m.l) / step) : Math.round((px - m.l) / step); return Math.max(0, Math.min(n - 1, i)); }
      svg.addEventListener("pointermove", function (ev) { var i = nearest(ev); show(i, ev.clientX, ev.clientY); });
      svg.addEventListener("pointerleave", function () { hov.innerHTML = ""; tipHide(); });
      svg.addEventListener("keydown", function (ev) { var d = ev.key === "ArrowRight" ? 1 : ev.key === "ArrowLeft" ? -1 : 0; if (!d) { if (ev.key === "Escape") { hov.innerHTML = ""; tipHide(); } return; } ev.preventDefault(); show(Math.max(0, Math.min(n - 1, (cur < 0 ? (d > 0 ? -1 : n) : cur) + d))); });
      svg.addEventListener("blur", function () { hov.innerHTML = ""; tipHide(); });
    });
  }
  function bucketHitsOutage(o, i) { return o.annotate.hits && o.annotate.hits[i]; }

  function outageFor(bk) {
    var w = D.outageWin; if (!w) return null;
    var hits = bk.map(function (x) { return x.a <= w[1] && x.b >= w[0]; }), from = hits.indexOf(true);
    if (from < 0) return null;
    return { from: from, to: hits.lastIndexOf(true), hits: hits };
  }

  function tableHTML(cols, rows) {
    return '<table class="data"><thead><tr>' + cols.map(function (c, i) { return '<th class="' + (i ? "n" : "") + '" scope="col">' + c + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) { return "<tr>" + r.map(function (c, i) { return '<td class="' + (i ? "n" : "") + '">' + c + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>";
  }

  function hbars(el, items, o) { // items: [{label, value, text, hi}]
    register(el, function (W) {
      var narrow = W < 460, rowH = 30, lw = narrow ? 104 : 150, vw = narrow ? 76 : 96, H = items.length * rowH + 6;
      var max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1, iw = W - lw - vw;
      var g = items.map(function (it, i) {
        var yy = i * rowH + 3, w = Math.max(2, it.value / max * iw), dim = state.cat >= 0 && !it.hi;
        return '<g opacity="' + (dim ? .38 : 1) + '"><text class="lbl2" x="0" y="' + (yy + 18) + '" style="fill:var(--ink)">' + esc(it.label) + '</text><rect x="' + lw + '" y="' + (yy + 5) + '" width="' + w + '" height="16" rx="4" fill="' + (o.color || "var(--s1)") + '"/><text class="lbl" x="' + (lw + w + 8) + '" y="' + (yy + 18) + '">' + it.text + "</text></g>";
      }).join("");
      el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(o.aria) + '">' + g + "</svg>";
      var svg = el.firstChild; svg.addEventListener("pointermove", function (ev) { var r = svg.getBoundingClientRect(), i = Math.floor((ev.clientY - r.top) / rowH * (H / r.height)); if (items[i]) tipShow("<b>" + esc(items[i].label) + "</b><div class='r'><span>" + o.name + "</span><b>" + items[i].text + "</b></div>" + (items[i].extra || ""), ev.clientX, ev.clientY); }); svg.addEventListener("pointerleave", tipHide);
    });
  }

  function spark(vals, color) {
    var W = 160, H = 36, n = vals.length, max = Math.max.apply(null, vals), min = Math.min.apply(null, vals), span = (max - min) || 1;
    var pts = vals.map(function (v, i) { return [n > 1 ? i / (n - 1) * W : W / 2, H - 4 - (v - min) / span * (H - 10)]; });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join("");
    var last = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true"><path d="' + d + 'L' + W + " " + H + "L0 " + H + 'Z" fill="' + color + '" fill-opacity=".10"/><path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
  }

  /* ---------- widgets ---------- */
  var kpiFirst = true;
  function renderKpis() {
    var cc = state.cat + 1, a = state.from, b = state.to, len = b - a + 1;
    var cur = sumRange(cube[cc], a, b), pa = Math.max(0, a - len), plen = a - pa, hasPrev = plen >= len * 0.9, prev = hasPrev ? sumRange(cube[cc], pa, a - 1) : null;
    var bk = buckets(a, b); if (bk.length > 30) { var k = Math.ceil(bk.length / 30), merged = []; for (var i = 0; i < bk.length; i += k) merged.push({ a: bk[i].a, b: bk[Math.min(i + k - 1, bk.length - 1)].b }); bk = merged; }
    var bv = bucketVecs(cube[cc], bk);
    var defs = [
      { l: "Revenue", f: M.rev, fmt: money, up: 1, perday: 1 }, { l: "Orders", f: M.orders, fmt: int0.format.bind(int0), up: 1, perday: 1 }, { l: "Avg. order value", f: M.aov, fmt: function (v) { return usd2.format(v); }, up: 1 },
      { l: "Payment failure rate", f: M.fail, fmt: function (v) { return pct(v); }, up: -1, rate: 1 }, { l: "Refund rate", f: M.refund, fmt: function (v) { return pct(v); }, up: -1, rate: 1 }
    ];
    $("#kpis").innerHTML = defs.map(function (d) {
      var v = d.f(cur), dl = "";
      if (prev) {
        var pv = d.f(prev), diff = d.rate ? (v - pv) * 100 : (pv ? ((d.perday ? v / len : v) - (d.perday ? pv / plen : pv)) / (d.perday ? pv / plen : pv) * 100 : 0), flat = Math.abs(diff) < 0.05, good = diff * d.up > 0;
        var txt = (diff > 0 ? "+" : "") + diff.toFixed(1) + (d.rate ? " pts" : "%");
        dl = '<span class="delta ' + (flat ? "flat" : good ? "good" : "bad") + '"><span style="white-space:nowrap"><span aria-hidden="true">' + (flat ? "■" : diff > 0 ? "▲" : "▼") + "</span> " + txt + "</span> <small>vs previous " + plen + " days</small></span>";
      } else dl = '<span class="delta flat"><small>No earlier period to compare</small></span>';
      return '<div class="kpi' + (kpiFirst ? " enter" : "") + '"><div class="kpi-l">' + d.l + '</div><div class="kpi-v">' + d.fmt(v) + "</div>" + dl + spark(bv.map(d.f), "var(--s1)") + "</div>";
    }).join("");
    kpiFirst = false;
  }

  function renderRevenue() {
    var cc = state.cat + 1, bk = buckets(state.from, state.to), bv = bucketVecs(cube[cc], bk), vals = bv.map(M.rev);
    var unit = bk.length && bk[0].a === bk[0].b ? "Daily" : (bk[0].long.indexOf("Week") === 0 ? "Weekly" : "Monthly");
    var an = outageFor(bk);
    $("#revenue-sub").textContent = unit + " recognized revenue (paid, shipped and completed orders)" + (state.cat >= 0 ? " in " + D.categories[state.cat] : "");
    timeChart($("#chart-revenue"), { labels: bk.map(function (x) { return x.label; }), longs: bk.map(function (x) { return x.long; }), series: [{ name: "Revenue", color: "var(--s1)", values: vals }], fmt: money, axFmt: moneyC, area: true, annotate: an, aria: unit + " revenue line chart." });
    $("#legend-revenue").innerHTML = an ? '<li><i class="band"></i>Payment-gateway outage window (' + dlabel(D.days[D.outageWin[0]], true) + " to " + dlabel(D.days[D.outageWin[1]]) + ", logged critical/high incidents)</li>" : "";
    $("#tbl-revenue").innerHTML = tableHTML(["Period", "Revenue", "Orders"], bk.map(function (x, i) { return [x.long, money(vals[i]), int0.format(bv[i][1])]; }));
  }

  function renderPayments() {
    var cc = state.cat + 1, bk = buckets(state.from, state.to), bv = bucketVecs(cube[cc], bk), an = outageFor(bk);
    var rate = bv.map(M.fail), L = bk.map(function (x) { return x.label; }), LL = bk.map(function (x) { return x.long; });
    timeChart($("#chart-failrate"), { labels: L, longs: LL, series: [{ name: "Failure rate", color: "var(--s2)", values: rate }], fmt: function (v) { return pct(v); }, axFmt: function (v) { return pct(v, 0); }, annotate: an, aria: "Payment failure rate line chart." });
    $("#tbl-failrate").innerHTML = tableHTML(["Period", "Failure rate", "Attempts"], bk.map(function (x, i) { return [x.long, pct(rate[i]), int0.format(bv[i][3])]; }));
    timeChart($("#chart-outcome"), { labels: L, longs: LL, stacked: true, series: [{ name: "Failed", color: "var(--s2)", values: bv.map(function (v) { return v[4]; }) }, { name: "Declined", color: "var(--s1)", values: bv.map(function (v) { return v[5]; }) }], fmt: int0.format.bind(int0), axFmt: function (v) { return compact.format(v); }, annotate: an, aria: "Failed and declined payments stacked column chart." });
    $("#legend-outcome").innerHTML = '<li><i style="background:var(--s2)"></i>Failed</li><li><i style="background:var(--s1)"></i>Declined</li>';
    $("#tbl-outcome").innerHTML = tableHTML(["Period", "Failed", "Declined"], bk.map(function (x, i) { return [x.long, int0.format(bv[i][4]), int0.format(bv[i][5])]; }));
    var items = D.categories.map(function (c, i) { var v = sumRange(cube[i + 1], state.from, state.to); return { label: c, value: M.fail(v), text: pct(M.fail(v)), hi: state.cat === i, extra: "<div class='r'><span>Attempts</span><b>" + int0.format(v[3]) + "</b></div>" }; }).sort(function (a, b) { return b.value - a.value; });
    hbars($("#chart-failcat"), items, { name: "Failure rate", color: "var(--s2)", aria: "Failure rate by category, highest first: " + items.map(function (i) { return i.label + " " + i.text; }).join(", ") });
  }

  function renderRefunds() {
    var items = D.categories.map(function (c, i) { var v = sumRange(cube[i + 1], state.from, state.to); return { label: c, value: v[7] / 100, text: money(v[7] / 100), hi: state.cat === i, extra: "<div class='r'><span>Refunded orders</span><b>" + int0.format(v[6]) + "</b></div><div class='r'><span>Refund rate</span><b>" + pct(M.refund(v)) + "</b></div>" }; }).sort(function (a, b) { return b.value - a.value; });
    hbars($("#chart-refunds"), items, { name: "Refunded value", color: "var(--s1)", aria: "Refunded value by category, highest first: " + items.map(function (i) { return i.label + " " + i.text; }).join(", ") });
  }

  function productRows() {
    var ms = monthsInRange(), set = {}; ms.forEach(function (i) { set[i] = 1; });
    var agg = {};
    D.productMonths.forEach(function (r) { if (!set[r[0]]) return; var a = agg[r[1]] || (agg[r[1]] = { u: 0, v: 0 }); a.u += r[2]; a.v += r[3]; });
    var rows = D.products.filter(function (p) { return agg[p[0]] && (state.cat < 0 || p[3] === state.cat); }).map(function (p) { return { id: p[0], sku: p[1], name: p[2], cat: D.categories[p[3]], units: agg[p[0]].u, rev: agg[p[0]].v / 100 }; });
    var total = rows.reduce(function (s, r) { return s + r.rev; }, 0);
    rows.forEach(function (r) { r.share = total ? r.rev / total : 0; });
    return { rows: rows, total: total, months: ms };
  }
  var PCOLS = [{ k: "name", l: "Product" }, { k: "cat", l: "Category" }, { k: "units", l: "Units", n: 1 }, { k: "rev", l: "Revenue", n: 1 }, { k: "share", l: "Share", n: 1 }];
  function renderProducts() {
    var P = productRows(), q = state.pq.trim().toLowerCase(), s = state.psort;
    var rows = P.rows.filter(function (r) { return !q || (r.name + " " + r.sku + " " + r.cat).toLowerCase().indexOf(q) >= 0; });
    rows.sort(function (a, b) { var x = a[s.key], y = b[s.key]; return (typeof x === "string" ? x.localeCompare(y) : x - y) * s.dir; });
    state._prows = rows;
    var ms = P.months; $("#products-sub").textContent = "Recognized revenue by product, " + (ms.length ? mlabel(D.months[ms[0]]) + " to " + mlabel(D.months[ms[ms.length - 1]]) : "") + " (whole calendar months overlapping the range)";
    var shown = state.pall ? rows : rows.slice(0, 10), max = Math.max.apply(null, rows.map(function (r) { return r.rev; })) || 1;
    var head = "<thead><tr><th scope='col' class='n'>#</th>" + PCOLS.map(function (c) { var on = s.key === c.k; return "<th scope='col' class='" + (c.n ? "n" : "") + "' aria-sort='" + (on ? (s.dir > 0 ? "ascending" : "descending") : "none") + "'><button type='button' data-sort='" + c.k + "'>" + c.l + "<span aria-hidden='true'>" + (on ? (s.dir > 0 ? "▲" : "▼") : "") + "</span></button></th>"; }).join("") + "</tr></thead>";
    var body = shown.length ? shown.map(function (r, i) { return "<tr><td class='n'>" + (i + 1) + "</td><td class='name'>" + esc(r.name) + "<small>" + esc(r.sku) + "</small></td><td>" + esc(r.cat) + "</td><td class='n'>" + int0.format(r.units) + "</td><td class='n'><span class='bar' style='width:" + Math.round(r.rev / max * 64) + "px'></span>" + money(r.rev) + "</td><td class='n'>" + pct(r.share) + "</td></tr>"; }).join("") : "<tr><td colspan='6' class='empty'>No products match this search and filter.</td></tr>";
    $("#ptable").innerHTML = head + "<tbody>" + body + "</tbody>";
    var more = $("#pmore"); more.hidden = rows.length <= 10; more.textContent = state.pall ? "Show top 10 only" : "Show all " + int0.format(rows.length) + " products";
  }

  function renderCustomers() {
    var ms = monthsInRange(), L = ms.map(function (i) { return mlabel(D.months[i]); }), LL = L;
    timeChart($("#chart-repeat"), { labels: L, longs: LL, stacked: true, series: [{ name: "Repeat customers", color: "var(--s1)", values: ms.map(function (i) { return D.repeat[i][1]; }) }, { name: "New customers", color: "var(--s3)", values: ms.map(function (i) { return D.repeat[i][0]; }) }], fmt: int0.format.bind(int0), axFmt: function (v) { return compact.format(v); }, aria: "New versus repeat customers per month, stacked column chart." });
    $("#legend-repeat").innerHTML = '<li><i style="background:var(--s1)"></i>Repeat customers</li><li><i style="background:var(--s3)"></i>New customers</li>';
    $("#tbl-repeat").innerHTML = tableHTML(["Month", "New", "Repeat"], ms.map(function (i, k) { return [L[k], int0.format(D.repeat[i][0]), int0.format(D.repeat[i][1])]; }));
    var cols = 12, h = "<table class='cohort' aria-label='Cohort retention heatmap'><thead><tr><th class='rh' scope='col'>First order</th><th class='bw' scope='col'>Buyers</th>";
    for (var k = 0; k < cols; k++) h += "<th scope='col'>M" + k + "</th>"; h += "</tr></thead><tbody>";
    ms.forEach(function (i) { var c = D.cohorts[i], size = c[0]; h += "<tr><th class='rh' scope='row'>" + mlabel(D.months[i]) + "</th><th class='tabular bw' style='font-weight:500'>" + int0.format(size) + "</th>"; for (var k = 0; k < cols; k++) { if (k >= c[1].length || !size) { h += "<td class='na'></td>"; continue; } var r = c[1][k] / size, lvl = Math.min(6, Math.floor(r / 0.5 * 6.999)); h += "<td class='" + (lvl >= 4 ? "hi" : "") + "' style='background:var(--seq" + lvl + ")' title='" + Math.round(r * 100) + "% of the " + mlabel(D.months[i]) + " cohort ordered in month " + k + "'>" + Math.round(r * 100) + "</td>"; } h += "</tr>"; });
    $("#cohort").innerHTML = h + "</tbody></table><p class='sub' style='margin-top:8px'>Cells show % of the cohort. Month 0 is the first order. Category filter does not apply.</p>";
  }

  function renderSegments() {
    var rows = D.segments.map(function (s, i) { var v = sumRange(segCube[i], state.from, state.to); return { s: s.replace("_", " "), v: v }; });
    var tot = rows.reduce(function (a, r) { return a + r.v[2]; }, 0), max = Math.max.apply(null, rows.map(function (r) { return r.v[2]; })) || 1;
    $("#segtable").innerHTML = "<thead><tr><th scope='col'>Segment</th><th class='n' scope='col'>Revenue</th><th class='n' scope='col'>Share</th><th class='n' scope='col'>Orders</th><th class='n' scope='col'>Avg. order</th><th class='n' scope='col'>Failure rate</th><th class='n' scope='col'>Refund rate</th></tr></thead><tbody>" +
      rows.map(function (r) { return "<tr><td style='text-transform:capitalize'>" + r.s + "</td><td class='n'><span class='bar' style='width:" + Math.round(r.v[2] / max * 80) + "px'></span>" + money(r.v[2] / 100) + "</td><td class='n'>" + pct(tot ? r.v[2] / tot : 0) + "</td><td class='n'>" + int0.format(r.v[1]) + "</td><td class='n'>" + usd2.format(M.aov(r.v)) + "</td><td class='n'>" + pct(M.fail(r.v)) + "</td><td class='n'>" + pct(M.refund(r.v)) + "</td></tr>"; }).join("") + "</tbody>";
  }

  function renderScope() {
    var a = D.days[state.from], b = D.days[state.to];
    $("#scope").textContent = dlabel(a, true) + " to " + dlabel(b, true) + " (" + int0.format(state.to - state.from + 1) + " days), " + (state.cat >= 0 ? D.categories[state.cat] : "all categories") + ".";
  }

  function renderAll() { tipHide(); renderScope(); renderKpis(); renderRevenue(); renderPayments(); renderRefunds(); renderProducts(); renderCustomers(); renderSegments(); }

  /* ---------- filters ---------- */
  function idx(iso) { var i = D.days.indexOf(iso); return i < 0 ? (iso < D.days[0] ? 0 : N - 1) : i; }
  function applyRange() {
    var v = $("#range").value, last = N - 1;
    $("#custom").hidden = v !== "custom";
    if (v === "30" || v === "90" || v === "180") { state.to = last; state.from = Math.max(0, last - (+v) + 1); }
    else if (v === "all") { state.from = 0; state.to = last; }
    else if (v === "y2024") { state.from = idx("2024-01-01"); state.to = last; }
    else if (v === "y2023") { state.from = 0; state.to = idx("2023-12-31"); }
    else if (v === "apr") { state.from = idx("2024-04-01"); state.to = idx("2024-04-30"); }
    else { var f = $("#from").value || D.days[state.from], t = $("#to").value || D.days[state.to]; if (f > t) { var x = f; f = t; t = x; } state.from = idx(f); state.to = idx(t); }
    if (v !== "custom") { $("#from").value = D.days[state.from]; $("#to").value = D.days[state.to]; }
  }
  function wire() {
    $("#category").innerHTML = '<option value="-1">All categories</option>' + D.categories.map(function (c, i) { return '<option value="' + i + '">' + esc(c) + "</option>"; }).join("");
    $("#range").addEventListener("change", function () { applyRange(); renderAll(); });
    $("#from").addEventListener("change", function () { $("#range").value = "custom"; applyRange(); renderAll(); });
    $("#to").addEventListener("change", function () { $("#range").value = "custom"; applyRange(); renderAll(); });
    $("#category").addEventListener("change", function () { state.cat = +$("#category").value; renderAll(); });
    $("#reset").addEventListener("click", function () { $("#range").value = "y2024"; $("#category").value = "-1"; $("#psearch").value = ""; state.cat = -1; state.pq = ""; state.pall = false; applyRange(); renderAll(); });
    $("#psearch").addEventListener("input", function (e) { state.pq = e.target.value; renderProducts(); });
    $("#ptable").addEventListener("click", function (e) { var b = e.target.closest("button[data-sort]"); if (!b) return; var k = b.getAttribute("data-sort"); state.psort = state.psort.key === k ? { key: k, dir: -state.psort.dir } : { key: k, dir: (k === "name" || k === "cat") ? 1 : -1 }; renderProducts(); var nb = $("#ptable button[data-sort='" + k + "']"); if (nb) nb.focus(); });
    $("#pmore").addEventListener("click", function () { state.pall = !state.pall; renderProducts(); });
    $("#csv").addEventListener("click", exportCsv);
    $("#theme").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      var next = cur === "dark" ? "light" : "dark"; document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("meridian-theme", next); } catch (e) {}
    });
    var links = [].slice.call(document.querySelectorAll("#nav a")), secs = links.map(function (a) { return $(a.getAttribute("href")); });
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) { links.forEach(function (l) { l.classList.toggle("active", l.getAttribute("href") === "#" + e.target.id); }); } }); }, { rootMargin: "-20% 0px -70% 0px" });
      secs.forEach(function (s) { if (s) io.observe(s); });
    }
  }
  function exportCsv() {
    var rows = state._prows || [], lines = [["rank", "product", "sku", "category", "units", "revenue_usd", "share"].join(",")];
    rows.forEach(function (r, i) { lines.push([i + 1, '"' + r.name.replace(/"/g, '""') + '"', r.sku, '"' + r.cat + '"', r.units, r.rev.toFixed(2), (r.share * 100).toFixed(2) + "%"].join(",")); });
    var blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "meridian-top-products-" + D.days[state.from] + "_" + D.days[state.to] + ".csv"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------- boot ---------- */
  function skeletonKpis() { var h = ""; for (var i = 0; i < 5; i++) h += '<div class="kpi sk" aria-hidden="true"></div>'; $("#kpis").innerHTML = h; $("#kpis").setAttribute("aria-busy", "true"); }
  skeletonKpis();
  var t0 = Date.now();
  fetch("data/snapshot.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (data) {
    build(data); wire(); applyRange();
    var wait = Math.max(0, MIN_SKELETON_MS - (Date.now() - t0));
    setTimeout(function () {
      renderAll();
      $("#kpis").removeAttribute("aria-busy");
      [].forEach.call(document.querySelectorAll("[data-loading]"), function (p) { p.removeAttribute("data-loading"); });
      requestAnimationFrame(function () { document.body.setAttribute("data-ready", "1"); });
    }, wait);
  }).catch(function (e) { $("#scope").textContent = "Could not load data/snapshot.json (" + e.message + "). Serve the folder over HTTP, e.g. python3 -m http.server."; });
})();
