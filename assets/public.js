/* 公开版首屏的示意动画：59 个电极、两路说话人、逐秒判断。全部是示意，不含实测数据。 */
(function () {
  'use strict';

  // 项目使用的 59 个公共通道（10-10 系统命名）
  var CHANNELS = ['Fp1', 'Fp2', 'F3', 'F4', 'C3', 'C4', 'P3', 'P4', 'O1', 'O2', 'F7', 'F8', 'T7', 'T8', 'P7', 'P8',
    'Fz', 'Cz', 'Pz', 'Oz', 'FC1', 'FC2', 'CP1', 'CP2', 'FC5', 'FC6', 'CP5', 'CP6', 'POz', 'F1', 'F2', 'C1', 'C2',
    'P1', 'P2', 'AF3', 'AF4', 'FC3', 'FC4', 'CP3', 'CP4', 'PO3', 'PO4', 'F5', 'F6', 'C5', 'C6', 'P5', 'P6',
    'AF7', 'AF8', 'FT7', 'FT8', 'TP7', 'TP8', 'PO7', 'PO8', 'Fpz', 'CPz'];

  // 每一排电极：中线上的前后位置，以及最外侧电极在头围上的角度（从正前方起算）
  var RING = 0.82;
  var ROWS = {
    Fp: { y: 4, angle: 18 }, AF: { y: 3, angle: 36 }, F: { y: 2, angle: 54 },
    FC: { y: 1, angle: 72 }, FT: { y: 1, angle: 72 }, C: { y: 0, angle: 90 }, T: { y: 0, angle: 90 },
    CP: { y: -1, angle: 108 }, TP: { y: -1, angle: 108 }, P: { y: -2, angle: 126 },
    PO: { y: -3, angle: 144 }, O: { y: -4, angle: 162 }
  };

  function locate(name) {
    var m = /^([A-Z][A-Za-z]*?)(\d+|z)$/.exec(name);
    var row = ROWS[m[1]];
    var midY = row.y * RING / 4;
    if (m[2] === 'z') return { name: name, x: 0, y: midY, side: 0 };
    var n = parseInt(m[2], 10);
    var t = Math.ceil(n / 2) / 4;                      // 1/2 → 0.25 … 7/8 → 1
    if (m[1] === 'Fp' || m[1] === 'O') t = 1;
    var a = row.angle * Math.PI / 180;
    var ringX = RING * Math.sin(a), ringY = RING * Math.cos(a);
    var side = n % 2 ? -1 : 1;                         // 奇数在左
    return { name: name, x: side * ringX * t, y: midY + (ringY - midY) * t * t, side: side, weight: 0.5 + 0.5 * Math.abs(row.y) / 4 };
  }

  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  var demo = document.getElementById('demo');
  var head = document.getElementById('head');
  if (!demo || !head) return;

  // 头部轮廓：鼻尖朝上
  head.appendChild(el('path', { class: 'outline', d: 'M-0.11 -0.995 L0 -1.13 L0.11 -0.995' }));
  head.appendChild(el('path', { class: 'outline', d: 'M-1 -0.14 C-1.11 -0.14 -1.11 0.16 -1 0.16' }));
  head.appendChild(el('path', { class: 'outline', d: 'M1 -0.14 C1.11 -0.14 1.11 0.16 1 0.16' }));
  head.appendChild(el('circle', { class: 'outline', cx: 0, cy: 0, r: 1 }));
  var arcs = {
    '-1': el('path', { class: 'verdict-arc l', d: 'M-0.86 -0.86 A1.216 1.216 0 0 0 -0.86 0.86' }),
    '1': el('path', { class: 'verdict-arc r', d: 'M0.86 -0.86 A1.216 1.216 0 0 1 0.86 0.86' })
  };
  head.appendChild(arcs['-1']);
  head.appendChild(arcs['1']);

  var BASE_R = 0.036;
  var dots = CHANNELS.map(locate).map(function (p) {
    var node = el('circle', {
      class: 'el ' + (p.side < 0 ? 'l' : p.side > 0 ? 'r' : 'mid'),
      cx: p.x.toFixed(3), cy: (-p.y).toFixed(3), r: BASE_R
    });
    var title = el('title', {});
    title.textContent = p.name;
    node.appendChild(title);
    head.appendChild(node);
    p.node = node;
    return p;
  });

  // 逐秒判断条
  var CELLS = 24;
  function makeCells(id) {
    var box = document.getElementById(id), cells = [];
    for (var i = 0; i < CELLS; i++) { var c = document.createElement('i'); box.appendChild(c); cells.push(c); }
    return cells;
  }
  var rawCells = makeCells('ticker-raw'), outCells = makeCells('ticker-out');
  var rawHistory = [], outHistory = [];

  function gauss() {
    var u = 1 - Math.random(), v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  var attended = -1;   // −1 左，+1 右
  var evidence = 0;
  var shared = { attended: -1, verdict: -1 };   // 给三维场景读的状态
  var scene = null;

  function paint(cells, history) {
    var offset = CELLS - history.length;
    for (var i = 0; i < CELLS; i++) {
      var v = history[i - offset];
      cells[i].className = (v === undefined ? '' : v < 0 ? 'l' : 'r') + (i === CELLS - 1 && v !== undefined ? ' now' : '');
    }
  }

  function tick() {
    var raw = attended * 0.45 + gauss();           // 单秒得分：有一点方向信息，噪声更大
    evidence = 0.86 * evidence + raw;              // 带遗忘的累积
    rawHistory.push(raw < 0 ? -1 : 1);
    outHistory.push(evidence < 0 ? -1 : 1);
    if (rawHistory.length > CELLS) { rawHistory.shift(); outHistory.shift(); }
    paint(rawCells, rawHistory);
    paint(outCells, outHistory);

    var verdict = evidence < 0 ? -1 : 1;
    shared.verdict = verdict;
    arcs['-1'].classList.toggle('on', verdict < 0);
    arcs['1'].classList.toggle('on', verdict > 0);

    // 电极：成对电极的大小随这一秒的左右差起伏
    var lean = Math.max(-1, Math.min(1, raw / 2));
    dots.forEach(function (p) {
      if (!p.side) return;
      var v = p.side * lean * p.weight + gauss() * 0.22;
      var gain = Math.max(0, v);
      p.gain = gain;
      p.node.setAttribute('r', (BASE_R * (0.8 + gain * 1.3)).toFixed(4));
      p.node.setAttribute('fill-opacity', Math.min(1, 0.38 + gain * 0.9).toFixed(2));
    });
    if (scene) scene.kick();
  }

  var voices = demo.querySelectorAll('.voice');
  function listenTo(side) {
    attended = side;
    shared.attended = side;
    if (scene) scene.kick();
    voices.forEach(function (btn) {
      var on = Number(btn.dataset.side) === side;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.querySelector('.voice-state').textContent = on ? '正在听' : '点这里换听';
    });
  }
  voices.forEach(function (btn) {
    btn.addEventListener('click', function () { listenTo(Number(btn.dataset.side)); });
  });

  // 先铺满一段历史，页面打开时就能看到两行的差别
  for (var i = 0; i < CELLS; i++) tick();

  // 支持 WebGL 就换成可以拖动的三维头部，不支持就留着上面的 SVG
  if (window.LNGL) scene = window.LNGL.mountHead({ stage: demo.querySelector('.demo-stage'), placeholder: head, dots: dots, state: shared });

  var timer = null;
  function start() { if (!timer) { timer = setInterval(tick, 1000); demo.classList.remove('paused'); } }
  function stop() { clearInterval(timer); timer = null; demo.classList.add('paused'); }
  var visible = true;
  function sync() { (visible && !document.hidden) ? start() : stop(); }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; sync(); }, { threshold: 0.15 }).observe(demo);
  }
  document.addEventListener('visibilitychange', sync);
  sync();
})();

/* 滚动入场和数字滚动。系统设了「减弱动态效果」就全部跳过。 */
(function () {
  'use strict';
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var targets = document.querySelectorAll('.sec-head, .prose-2col > *, .card, .stat, .module, .table-scroll, .after-table');
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in');
      seen.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  Array.prototype.forEach.call(targets, function (node) {
    if (node.getBoundingClientRect().top < window.innerHeight * 0.9) return;     // 一打开就在屏幕里的不动
    var index = Array.prototype.indexOf.call(node.parentNode.children, node);
    node.style.setProperty('--d', Math.min(index, 4) * 90 + 'ms');
    node.classList.add('reveal');
    seen.observe(node);
  });

  // 大数字从 0 数上去
  var counter = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      counter.unobserve(entry.target);
      var node = entry.target.firstChild, goal = entry.target._goal, start = null;
      function step(now) {
        if (start === null) start = now;
        var k = Math.min(1, (now - start) / 1300), eased = 1 - Math.pow(1 - k, 3);
        node.nodeValue = Math.round(goal * eased).toLocaleString('en-US');
        if (k < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }, { threshold: 0.6 });
  Array.prototype.forEach.call(document.querySelectorAll('.stat dd.num'), function (dd) {
    var node = dd.firstChild;
    if (!node || node.nodeType !== 3 || !/^[\d,]+$/.test(node.nodeValue.trim())) return;
    var goal = parseInt(node.nodeValue.replace(/,/g, ''), 10);
    if (goal < 10) return;
    dd._goal = goal;
    dd.style.minWidth = dd.getBoundingClientRect().width + 'px';
    node.nodeValue = '0';
    counter.observe(dd);
  });
})();
