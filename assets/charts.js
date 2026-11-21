/* 统计图：折线、区间、条形、散点。纯 SVG，不依赖外部库。
   数据由 build.py 调 chartdata.py 生成；公开版写在页面里的 #chart-data，队员版在加密的 charts.bin 里。 */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  function s(tag, attrs, text) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function h(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fmt(v, digits) {
    return (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits === undefined ? 0 : digits);
  }
  function unit(spec) { return spec.unit ? (spec.unit === '%' ? '%' : ' ' + spec.unit) : ''; }
  function colorOf(item, index) {
    if (item.ink) return 'var(--c-strong)';        // 第四条线用中性的深灰，不再加一种色相
    return item.muted ? 'var(--c-muted)' : 'var(--c' + (item.slot || index + 1) + ')';
  }
  function scale(d0, d1, r0, r1) {
    return function (v) { return r0 + (v - d0) / (d1 - d0) * (r1 - r0); };
  }

  var measurer = null;
  function textWidth(text, size, weight) {
    if (!measurer) measurer = document.createElement('canvas').getContext('2d');
    measurer.font = (weight || 400) + ' ' + size + 'px ' + getComputedStyle(document.body).fontFamily;
    return measurer.measureText(text).width;
  }

  /* ---------- 外框：标题、图例、画布、说明、数据表 ---------- */

  function frame(container, spec, legendItems, table) {
    var fig = h('figure', 'chart chart-' + spec.kind);
    var head = h('figcaption', 'chart-head');
    head.appendChild(h('h4', 'chart-title', spec.title));
    if (spec.subtitle) head.appendChild(h('p', 'chart-sub', spec.subtitle));
    fig.appendChild(head);

    if (legendItems && legendItems.length > 1) {
      var legend = h('ul', 'chart-legend');
      legendItems.forEach(function (item) {
        var li = h('li');
        var key = h('span', 'key key-' + item.shape);
        key.style.setProperty('--k', item.color);
        li.appendChild(key);
        li.appendChild(h('span', '', item.name));
        legend.appendChild(li);
      });
      fig.appendChild(legend);
    }

    var plot = h('div', 'chart-plot');
    var tip = h('div', 'chart-tip');
    tip.hidden = true;
    plot.appendChild(tip);
    fig.appendChild(plot);
    if (spec.note) fig.appendChild(h('p', 'chart-note', spec.note));

    var details = h('details', 'chart-data');
    details.appendChild(h('summary', '', '查看数据'));
    var wrap = h('div', 'chart-table');
    var tbl = h('table');
    var thead = h('thead'), tr = h('tr');
    table.head.forEach(function (c, i) { var th = h('th', i ? 'r' : '', c); th.scope = 'col'; tr.appendChild(th); });
    thead.appendChild(tr); tbl.appendChild(thead);
    var tbody = h('tbody');
    table.rows.forEach(function (row) {
      var r = h('tr');
      row.forEach(function (c, i) { r.appendChild(h(i ? 'td' : 'th', i && typeof c === 'number' ? 'r' : (i ? 'r' : ''), String(c))); });
      tbody.appendChild(r);
    });
    tbl.appendChild(tbody); wrap.appendChild(tbl); details.appendChild(wrap);
    fig.appendChild(details);
    container.appendChild(fig);
    // 第一次滚进屏幕时播放入场动画：折线画出来，条形长出来
    function enter() {
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        fig.classList.add('seen', 'entering');
        setTimeout(function () { fig.classList.remove('entering'); }, 2600);
      }); });
    }
    if ('IntersectionObserver' in window) {
      var watcher = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) { watcher.disconnect(); enter(); }
      }, { threshold: 0.3 });
      watcher.observe(plot);
    } else fig.classList.add('seen');
    return { fig: fig, plot: plot, tip: tip };
  }

  /* 宽度变了就重画 */
  function responsive(plot, draw) {
    var last = 0, current = null;
    function run() {
      var w = Math.floor(plot.clientWidth);
      if (!w || w === last) return;
      last = w;
      if (current) current.remove();
      current = draw(w);
      plot.insertBefore(current, plot.firstChild);
    }
    if ('ResizeObserver' in window) new ResizeObserver(run).observe(plot);
    else window.addEventListener('resize', run);
    run();
  }

  function showTip(tip, plot, x, y, heading, rows) {
    tip.textContent = '';
    if (heading) tip.appendChild(h('p', 'tip-head', heading));
    rows.forEach(function (row) {
      var line = h('p', 'tip-row');
      if (row.color) { var key = h('span', 'key key-line'); key.style.setProperty('--k', row.color); line.appendChild(key); }
      line.appendChild(h('b', '', row.value));
      if (row.name) line.appendChild(h('span', '', row.name));
      tip.appendChild(line);
    });
    tip.hidden = false;
    var w = tip.offsetWidth, ht = tip.offsetHeight, pw = plot.clientWidth;
    var left = x + 14;
    if (left + w > pw) left = x - 14 - w;
    var top = Math.max(0, y - ht - 10);
    if (left < 0) {                      // 左右都放不下：挪到画布上方，不挡数据
      left = Math.max(0, Math.min(pw - w, x - w / 2));
      top = -ht - 6;
    }
    tip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
  }
  function hideTip(tip) { tip.hidden = true; }

  function axisText(x, y, text, anchor, cls) {
    return s('text', { x: x, y: y, 'text-anchor': anchor || 'middle', class: cls || 'tick' }, text);
  }

  /* ---------- 折线图 ---------- */

  function line(container, spec) {
    var xs = spec.x.values, yd = spec.y.digits === undefined ? 1 : spec.y.digits;
    var u = spec.y.unit === '%' ? '%' : '';
    function xText(v) { return fmt(v, 0); }
    function heading(v) {
      if (spec.x.tip) return spec.x.tip.replace('{x}', fmt(v, 0));
      if (spec.marker) return v === 0 ? '换边的这一秒' : (v < 0 ? '换边前 ' + (-v) + ' 秒' : '换边后 ' + v + ' 秒');
      return spec.x.label.replace(/（.*）/, '') + ' ' + v + (/秒/.test(spec.x.label) ? ' 秒' : '');
    }
    var items = spec.series.map(function (sr, i) { return { name: sr.name, color: colorOf(sr, i), shape: 'line' }; });
    var view = frame(container, spec, items, {
      head: [spec.x.label].concat(spec.series.map(function (sr) { return sr.name + (u ? '（%）' : ''); })),
      rows: xs.map(function (x, i) { return [xText(x)].concat(spec.series.map(function (sr) { return fmt(sr.values[i], yd); })); })
    });

    responsive(view.plot, function (W) {
      var narrow = W < 440;
      var H = narrow ? 230 : 270;
      var m = { l: 44, r: 14, t: 18, b: 44 };
      var endLabels = false, labelW = 0;
      var refW = spec.reference ? textWidth(spec.reference.label, 11.5) + 10 : 0;
      if (!narrow && spec.series.length > 1) {
        labelW = Math.max.apply(null, spec.series.map(function (sr) { return textWidth(sr.name, 12, 600); })) + 12;
        endLabels = labelW < W * 0.28;
      }
      var sx, sy = scale(spec.y.min, spec.y.max, H - m.b, m.t);
      function ends() {
        return spec.series.map(function (sr, i) { return { i: i, y: sy(sr.values[sr.values.length - 1]) }; })
          .sort(function (a, b) { return a.y - b.y; });
      }
      if (endLabels) {
        var e = ends();
        if (spec.reference) e = e.concat([{ y: sy(spec.reference.value) }]).sort(function (a, b) { return a.y - b.y; });
        for (var k = 1; k < e.length; k++) if (e[k].y - e[k - 1].y < 15) endLabels = false;   // 挤在一起就不标，靠图例
      }
      m.r = Math.max(m.r, refW, endLabels ? labelW + 8 : 0);
      sx = scale(spec.x.min, spec.x.max, m.l, W - m.r);

      var root = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', tabindex: 0,
        'aria-label': spec.title + '。' + (spec.subtitle || '') + ' 用左右方向键逐点查看，或展开下方的数据表。' });

      spec.y.ticks.forEach(function (t) {
        var strong = spec.reference && spec.reference.value === t;
        root.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), class: strong ? 'ref' : 'grid' }));
        root.appendChild(axisText(m.l - 8, sy(t) + 4, fmt(t, 0) + u, 'end'));
      });
      if (spec.reference) {
        if (spec.y.ticks.indexOf(spec.reference.value) < 0)
          root.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: sy(spec.reference.value), y2: sy(spec.reference.value), class: 'ref' }));
        root.appendChild(axisText(W - m.r + 6, sy(spec.reference.value) + 4, spec.reference.label, 'start', 'tick ref-label'));
      }
      spec.x.ticks.forEach(function (t) {
        root.appendChild(s('line', { x1: sx(t), x2: sx(t), y1: H - m.b, y2: H - m.b + 5, class: 'axis' }));
        root.appendChild(axisText(sx(t), H - m.b + 19, xText(t)));
      });
      root.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'axis' }));
      root.appendChild(axisText((m.l + W - m.r) / 2, H - 6, spec.x.label, 'middle', 'tick axis-label'));
      if (spec.marker) {
        root.appendChild(s('line', { x1: sx(spec.marker.x), x2: sx(spec.marker.x), y1: m.t, y2: H - m.b, class: 'ref' }));
        root.appendChild(axisText(sx(spec.marker.x) + 6, m.t + 4, spec.marker.label, 'start', 'tick ref-label'));
      }

      spec.series.forEach(function (sr, i) {
        var d = sr.values.map(function (v, j) { return (j ? 'L' : 'M') + sx(xs[j]).toFixed(1) + ' ' + sy(v).toFixed(1); }).join('');
        root.appendChild(s('path', { d: d, class: 'series', stroke: colorOf(sr, i), pathLength: 1 }));
        if (sr.markers) sr.values.forEach(function (v, j) {
          root.appendChild(s('circle', { cx: sx(xs[j]), cy: sy(v), r: 4.5, class: 'dot', fill: colorOf(sr, i) }));
          if (spec.labels === 'all') {
            // 标在折线没经过的一侧：线往右上走时标在点的右下，最后一个点标在左上
            var lastPoint = j === xs.length - 1;
            var rising = lastPoint ? sr.values[j - 1] < v : sr.values[j + 1] > v;
            if (lastPoint) root.appendChild(axisText(sx(xs[j]) - 7, sy(v) - 9, fmt(v, yd) + u, 'end', 'value'));
            else root.appendChild(axisText(sx(xs[j]) + 8, sy(v) + (rising ? 17 : -9), fmt(v, yd) + u, 'start', 'value'));
          }
        });
        if (endLabels) {
          var last = sr.values.length - 1;
          root.appendChild(s('circle', { cx: sx(xs[last]), cy: sy(sr.values[last]), r: 4, class: 'dot', fill: colorOf(sr, i) }));
          root.appendChild(axisText(sx(xs[last]) + 9, sy(sr.values[last]) + 4, sr.name, 'start', 'end-label'));
        }
      });

      // 悬停层：竖线吸附到最近的横坐标，一次读出全部序列
      var cross = s('line', { y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' });
      var marks = spec.series.map(function (sr, i) { return s('circle', { r: 4.5, class: 'dot', fill: colorOf(sr, i), visibility: 'hidden' }); });
      root.appendChild(cross);
      marks.forEach(function (mk) { root.appendChild(mk); });
      var active = -1;
      function focusAt(j) {
        active = j;
        var x = sx(xs[j]);
        cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
        var top = H;
        spec.series.forEach(function (sr, i) {
          var y = sy(sr.values[j]);
          marks[i].setAttribute('cx', x); marks[i].setAttribute('cy', y); marks[i].setAttribute('visibility', 'visible');
          top = Math.min(top, y);
        });
        showTip(view.tip, view.plot, x, Math.max(top, m.t + 40), heading(xs[j]), spec.series.map(function (sr, i) {
          return { color: colorOf(sr, i), value: fmt(sr.values[j], yd) + u, name: sr.name };
        }));
      }
      function blur() {
        active = -1; cross.setAttribute('visibility', 'hidden');
        marks.forEach(function (mk) { mk.setAttribute('visibility', 'hidden'); });
        hideTip(view.tip);
      }
      root.addEventListener('pointermove', function (ev) {
        var px = ev.clientX - root.getBoundingClientRect().left, best = 0, dist = Infinity;
        xs.forEach(function (x, j) { var d = Math.abs(sx(x) - px); if (d < dist) { dist = d; best = j; } });
        if (best !== active) focusAt(best);
      });
      root.addEventListener('pointerleave', blur);
      root.addEventListener('blur', blur);
      root.addEventListener('keydown', function (ev) {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
        ev.preventDefault();
        var j = active < 0 ? (ev.key === 'ArrowRight' ? 0 : xs.length - 1) : active + (ev.key === 'ArrowRight' ? 1 : -1);
        focusAt(Math.max(0, Math.min(xs.length - 1, j)));
      });
      return root;
    });
  }

  /* ---------- 区间图：一行一个圆点加 95% 区间 ---------- */

  function interval(container, spec) {
    var dg = spec.digits === undefined ? 2 : spec.digits, u = unit(spec);
    var view = frame(container, spec, null, {
      head: ['方案', '平均（' + (spec.unit || '') + '）', '区间下限', '区间上限'],
      rows: spec.rows.map(function (r) { return [(r.group ? r.group + ' · ' : '') + r.label, fmt(r.value, dg), fmt(r.low, dg), fmt(r.high, dg)]; })
    });

    responsive(view.plot, function (W) {
      var stacked = W < 430;
      var labelW = stacked ? 0 : Math.min(W * 0.34, Math.max.apply(null, spec.rows.map(function (r) { return textWidth(r.label, 13); })) + 14);
      var valueW = textWidth(fmt(88.88, dg) + u, 13, 600) + 12;
      var left = labelW + 2, right = W - valueW - 6;
      var sx = scale(spec.min, spec.max, left, right);
      var rowH = stacked ? 44 : 30, groupH = 28, y = 6, layout = [], lastGroup = null;
      spec.rows.forEach(function (r) {
        if (r.group && r.group !== lastGroup) { layout.push({ group: r.group, y: y }); y += groupH; lastGroup = r.group; }
        layout.push({ row: r, y: y }); y += rowH;
      });
      var plotBottom = y + 4, H = plotBottom + 26;
      var root = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img',
        'aria-label': spec.title + '。' + (spec.subtitle || '') + ' 数值见下方的数据表。' });

      spec.ticks.forEach(function (t) {
        var strong = spec.reference && spec.reference.value === t;
        root.appendChild(s('line', { x1: sx(t), x2: sx(t), y1: 0, y2: plotBottom, class: strong ? 'ref' : 'grid' }));
        root.appendChild(axisText(sx(t), plotBottom + 17, fmt(t, 0) + (spec.unit === '%' ? '%' : '')));
      });

      layout.forEach(function (item) {
        if (item.group) {
          root.appendChild(axisText(0, item.y + 18, item.group, 'start', 'group'));
          return;
        }
        var r = item.row, color = colorOf(r, 0);
        var cy = item.y + (stacked ? 31 : rowH / 2);
        if (stacked) root.appendChild(axisText(0, item.y + 15, r.label, 'start', 'label'));
        else root.appendChild(axisText(labelW - 12, cy + 4.5, r.label, 'end', 'label'));
        var g = s('g', { class: 'mark' });
        g.appendChild(s('line', { x1: sx(r.low), x2: sx(r.high), y1: cy, y2: cy, class: 'ci', stroke: color }));
        g.appendChild(s('circle', { cx: sx(r.value), cy: cy, r: 5.5, class: 'dot', fill: color }));
        root.appendChild(g);
        root.appendChild(axisText(W - 2, cy + 4.5, fmt(r.value, dg) + u, 'end', 'value'));
        var hit = s('rect', { x: 0, y: item.y, width: W, height: rowH, class: 'hit' });
        hit.addEventListener('pointermove', function () {
          g.classList.add('on');
          showTip(view.tip, view.plot, sx(r.value), cy, (r.group ? r.group + ' · ' : '') + r.label, [
            { color: color, value: fmt(r.value, dg) + u, name: '平均' },
            { value: fmt(r.low, dg) + ' – ' + fmt(r.high, dg) + u, name: '95% 区间' }]);
        });
        hit.addEventListener('pointerleave', function () { g.classList.remove('on'); hideTip(view.tip); });
        root.appendChild(hit);
      });
      return root;
    });
  }

  /* ---------- 横向条形图 ---------- */

  function bars(container, spec) {
    var dg = spec.digits === undefined ? 1 : spec.digits, u = unit(spec);
    var grouped = !!spec.groups;
    var flat = [];          // {group, label, value, color}
    if (grouped) spec.groups.forEach(function (g) {
      g.values.forEach(function (v, i) { flat.push({ group: g.label, label: spec.series[i].name, value: v, color: colorOf(spec.series[i], i), first: i === 0 }); });
    });
    else spec.rows.forEach(function (r, i) { flat.push({ label: r.label, value: r.value, color: colorOf(r, 0), first: true }); });

    var legend = grouped ? spec.series.map(function (sr, i) { return { name: sr.name, color: colorOf(sr, i), shape: 'rect' }; }) : null;
    var view = frame(container, spec, legend, {
      head: [grouped ? '条件' : '做法', (grouped ? '' : '') + '数值（' + spec.unit + '）'].concat([]),
      rows: flat.map(function (f) { return [(f.group ? f.group + ' · ' : '') + f.label, fmt(f.value, dg)]; })
    });

    responsive(view.plot, function (W) {
      var valueW = Math.max.apply(null, flat.map(function (f) { return textWidth(fmt(f.value, dg) + u, 13, 600); })) + 10;
      var sx = scale(0, spec.max, 1, W - valueW);
      var thick = 16, y = 2, layout = [];
      flat.forEach(function (f) {
        if (f.first) { y += layout.length ? 14 : 0; layout.push({ text: grouped ? f.group : f.label, y: y }); y += 24; }
        layout.push({ bar: f, y: y }); y += thick + 2;
      });
      var H = y + 6;
      var root = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img',
        'aria-label': spec.title + '。' + (spec.subtitle || '') + ' 数值见下方的数据表。' });
      root.appendChild(s('line', { x1: 0.5, x2: 0.5, y1: 22, y2: H - 4, class: 'axis' }));
      layout.forEach(function (item) {
        if (item.text) { root.appendChild(axisText(0, item.y + 15, item.text, 'start', 'label')); return; }
        var f = item.bar, w = Math.max(2, sx(f.value) - 1), r = Math.min(4, w / 2);
        // 数据端圆角，基线端直角
        var d = 'M1 ' + item.y + 'H' + (1 + w - r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
          'V' + (item.y + thick - r) + 'a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r + 'H1Z';
        var bar = s('path', { d: d, fill: f.color, class: 'bar' });
        root.appendChild(bar);
        root.appendChild(axisText(1 + w + 8, item.y + thick / 2 + 4.5, fmt(f.value, dg) + u, 'start', 'value'));
        var hit = s('rect', { x: 0, y: item.y - 1, width: W, height: thick + 2, class: 'hit' });
        hit.addEventListener('pointermove', function () {
          bar.classList.add('on');
          showTip(view.tip, view.plot, 1 + w, item.y, f.group || '', [{ color: f.color, value: fmt(f.value, dg) + u, name: f.label }]);
        });
        hit.addEventListener('pointerleave', function () { bar.classList.remove('on'); hideTip(view.tip); });
        root.appendChild(hit);
      });
      return root;
    });
  }

  /* ---------- 散点图：两个指标的取舍 ---------- */

  function scatter(container, spec) {
    var pts = spec.points, xd = spec.x.digits || 2, yd = spec.y.digits || 2;
    // 没有被别的点同时在两个指标上压过的点
    pts.forEach(function (p) {
      p.front = !pts.some(function (q) { return q !== p && q.x >= p.x && q.y >= p.y && (q.x > p.x || q.y > p.y); });
    });
    function tone(p) { return p.highlight ? 'var(--c1)' : p.front ? 'var(--c-strong)' : 'var(--c-muted)'; }
    var view = frame(container, spec, [
      { name: '冻结并送去外部复验的方案', color: 'var(--c1)', shape: 'dot' },
      { name: '取舍前沿上的方案', color: 'var(--c-strong)', shape: 'dot' },
      { name: '有别的方案两项都比它好', color: 'var(--c-muted)', shape: 'dot' }
    ], {
      head: ['方案', spec.x.label, spec.y.label],
      rows: pts.map(function (p) { return [p.label, fmt(p.x, xd), fmt(p.y, yd)]; })
    });

    responsive(view.plot, function (W) {
      var narrow = W < 460, H = narrow ? 320 : 360;
      var m = { l: 40, r: 14, t: 30, b: 44 };
      var sx = scale(spec.x.min, spec.x.max, m.l, W - m.r), sy = scale(spec.y.min, spec.y.max, H - m.b, m.t);
      var root = s('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img',
        'aria-label': spec.title + '。' + (spec.subtitle || '') + ' 数值见下方的数据表。' });

      spec.y.ticks.forEach(function (t) {
        var strong = spec.reference && spec.reference.value === t;
        root.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: sy(t), y2: sy(t), class: strong ? 'ref' : 'grid' }));
        root.appendChild(axisText(m.l - 8, sy(t) + 4, fmt(t, 0), 'end'));
      });
      spec.x.ticks.forEach(function (t) {
        root.appendChild(s('line', { x1: sx(t), x2: sx(t), y1: m.t, y2: H - m.b, class: 'grid' }));
        root.appendChild(axisText(sx(t), H - m.b + 18, fmt(t, 0)));
      });
      root.appendChild(axisText(0, 12, spec.y.label, 'start', 'tick axis-label'));
      root.appendChild(axisText((m.l + W - m.r) / 2, H - 6, spec.x.label, 'middle', 'tick axis-label'));
      if (spec.reference) root.appendChild(axisText(W - m.r - 4, sy(spec.reference.value) - 6, spec.reference.label, 'end', 'tick ref-label'));

      if (spec.frontier) {
        var front = pts.filter(function (p) { return p.front; }).sort(function (a, b) { return a.x - b.x; });
        root.appendChild(s('path', { class: 'frontier', d: front.map(function (p, i) { return (i ? 'L' : 'M') + sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1); }).join('') }));
      }

      // 标签：依次试右、左、上、下，取第一个不压到别的点和标签的位置
      var boxes = pts.map(function (p) { return { x0: sx(p.x) - 7, x1: sx(p.x) + 7, y0: sy(p.y) - 7, y1: sy(p.y) + 7 }; });
      function free(b) {
        if (b.x0 < m.l - 34 || b.x1 > W - 2 || b.y0 < m.t - 14 || b.y1 > H - m.b) return false;
        return !boxes.some(function (o) { return b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0; });
      }
      var order = pts.slice().sort(function (a, b) { return (b.highlight ? 1 : 0) - (a.highlight ? 1 : 0) || (b.front ? 1 : 0) - (a.front ? 1 : 0); });
      var labels = [];
      order.forEach(function (p) {
        var w = textWidth(p.label, 12, p.highlight ? 600 : 400), cx = sx(p.x), cy = sy(p.y);
        var tries = [
          { x: cx + 10, y: cy + 4, a: 'start', x0: cx + 9, x1: cx + 11 + w },
          { x: cx - 10, y: cy + 4, a: 'end', x0: cx - 11 - w, x1: cx - 9 },
          { x: cx, y: cy - 11, a: 'middle', x0: cx - w / 2, x1: cx + w / 2 },
          { x: cx, y: cy + 20, a: 'middle', x0: cx - w / 2, x1: cx + w / 2 }
        ];
        for (var i = 0; i < tries.length; i++) {
          var t = tries[i], box = { x0: t.x0, x1: t.x1, y0: t.y - 11, y1: t.y + 3 };
          if (free(box)) { boxes.push(box); labels.push({ p: p, t: t }); return; }
        }
      });

      var marks = [];
      pts.forEach(function (p) {
        var c = s('circle', { cx: sx(p.x), cy: sy(p.y), r: p.highlight ? 6.5 : 5, class: 'dot', fill: tone(p) });
        root.appendChild(c); marks.push(c);
      });
      labels.forEach(function (l) {
        root.appendChild(axisText(l.t.x, l.t.y, l.p.label, l.t.a, 'point-label' + (l.p.highlight ? ' strong' : '')));
      });

      var active = null;
      root.addEventListener('pointermove', function (ev) {
        var box = root.getBoundingClientRect(), px = ev.clientX - box.left, py = ev.clientY - box.top, best = null, dist = 34;
        pts.forEach(function (p, i) { var d = Math.hypot(sx(p.x) - px, sy(p.y) - py); if (d < dist) { dist = d; best = i; } });
        if (best === active) return;
        if (active !== null) marks[active].classList.remove('on');
        active = best;
        if (best === null) { hideTip(view.tip); return; }
        var p = pts[best];
        marks[best].classList.add('on');
        showTip(view.tip, view.plot, sx(p.x), sy(p.y), p.label, [
          { value: fmt(p.x, xd) + '%', name: '稳态' }, { value: fmt(p.y, yd) + '%', name: '换边后 0–4 秒' }]);
      });
      root.addEventListener('pointerleave', function () {
        if (active !== null) marks[active].classList.remove('on');
        active = null; hideTip(view.tip);
      });
      return root;
    });
  }

  var KINDS = { line: line, interval: interval, bars: bars, scatter: scatter };
  function render(container, spec) {
    if (spec && KINDS[spec.kind]) KINDS[spec.kind](container, spec);
  }

  global.LNCharts = { render: render };

  // 公开版：数据直接写在页面里
  function auto() {
    var source = document.getElementById('chart-data');
    if (!source) return;
    var data;
    try { data = JSON.parse(source.textContent); } catch (err) { return; }
    document.querySelectorAll('[data-chart]').forEach(function (slot) {
      var spec = data[slot.getAttribute('data-chart')];
      if (spec) render(slot, spec); else slot.remove();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})(window);
