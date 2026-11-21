/* WebGL 场景：三维电极头（公开版首屏）和流动的脑电波背景。原生 WebGL，不依赖外部库。
   浏览器不支持 WebGL 时什么都不做，页面保留原来的 SVG 和纯色背景。 */
(function (global) {
  'use strict';

  var reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  function context(canvas) {
    var opts = { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' };
    try { return canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts); }
    catch (err) { return null; }
  }
  function compile(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  function program(gl, vs, fs) {
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    return prog;
  }
  function cssColor(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim().replace('#', '');
    if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    var n = parseInt(v, 16);
    if (v.length !== 6 || isNaN(n)) return [0.5, 0.5, 0.5];
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  function fit(canvas, gl, maxDpr) {
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr || 2);
    var cw = canvas.clientWidth, ch = canvas.clientHeight;
    var w = Math.max(1, Math.round(cw * dpr)), hgt = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
    gl.viewport(0, 0, w, hgt);
    return { w: cw, h: ch, dpr: dpr };
  }
  function onScheme(fn) {
    if (!window.matchMedia) return;
    var mq = matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
  }

  /* 只在画布可见、页面在前台时跑动画。减弱动效时不连续播放，只在 kick() 时画一帧。 */
  function runner(canvas, frame) {
    var raf = 0, visible = true, last = 0, dead = false;
    function step(now) {
      raf = 0;
      if (dead) return;
      var dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
      last = now;
      frame(now / 1000, dt);
      if (!reduceMotion && visible && !document.hidden) raf = requestAnimationFrame(step);
    }
    function kick() { if (!raf && !dead) { last = 0; raf = requestAnimationFrame(step); } }
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; if (visible) kick(); }, { threshold: 0.01 }).observe(canvas);
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(); });
    if ('ResizeObserver' in window) new ResizeObserver(kick).observe(canvas);
    else window.addEventListener('resize', kick);
    kick();
    return { kick: kick, stop: function () { dead = true; if (raf) cancelAnimationFrame(raf); } };
  }

  /* ---------- 三维电极头 ---------- */

  var MARK_VS = 'attribute vec2 aPos; attribute float aSize; attribute float aSoft; attribute vec4 aColor;' +
    'varying vec4 vColor; varying float vSoft;' +
    'void main(){ gl_Position = vec4(aPos, 0.0, 1.0); gl_PointSize = aSize; vColor = aColor; vSoft = aSoft; }';
  var MARK_FS = 'precision mediump float; varying vec4 vColor; varying float vSoft; uniform float uPoint;' +
    'void main(){ float a = vColor.a;' +
    ' if (uPoint > 0.5) { vec2 c = gl_PointCoord * 2.0 - 1.0; float d = dot(c, c);' +
    '   a *= vSoft > 0.5 ? pow(max(0.0, 1.0 - d), 2.0) : smoothstep(1.0, 0.70, d); }' +
    ' gl_FragColor = vec4(vColor.rgb * a, a); }';
  var BALL_VS = 'attribute vec2 aPos; uniform vec2 uScale; varying vec2 v;' +
    'void main(){ v = aPos; gl_Position = vec4(aPos * uScale, 0.0, 1.0); }';
  var BALL_FS = 'precision mediump float; varying vec2 v; uniform vec3 uFill; uniform vec3 uRim; uniform float uPx;' +
    'void main(){ float r = length(v); float edge = smoothstep(1.0, 1.0 - uPx * 1.5, r);' +
    ' float z = sqrt(max(0.0, 1.0 - r * r)); float rim = smoothstep(0.80, 1.0, r);' +
    ' vec3 col = mix(uFill, uRim, rim * 0.55); float a = (0.34 + 0.30 * z + 0.26 * rim) * edge;' +
    ' float line = smoothstep(uPx * 3.0, 0.0, abs(r - (1.0 - uPx * 1.5)));' +
    ' col = mix(col, uRim, line * 0.8); a = max(a, line * 0.9 * step(r, 1.0));' +
    ' gl_FragColor = vec4(col * a, a); }';

  var D = 7.0;                       // 相机到头部中心的距离（头的半径是 1）
  var STRIDE = 8;                    // x, y, 点大小, 是否柔边, r, g, b, a

  function mountHead(opts) {
    var stage = opts.stage, placeholder = opts.placeholder, dots = opts.dots, state = opts.state;
    var canvas = document.createElement('canvas');
    canvas.className = 'head-gl';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '可以拖动旋转的三维头部模型，上面有 59 个电极。左右两侧的声音向头部传来，电极的大小随示意的逐秒判断起伏。');
    var gl = context(canvas);
    if (!gl) return null;
    var markProg, ballProg;
    try { markProg = program(gl, MARK_VS, MARK_FS); ballProg = program(gl, BALL_VS, BALL_FS); }
    catch (err) { return null; }
    stage.insertBefore(canvas, stage.firstChild);
    stage.classList.add('has-gl');

    // 电极的三维位置：二维示意图上离头顶的距离换成从头顶往下的角度，最外一圈落在赤道上
    var RING = 0.82;
    dots.forEach(function (p, i) {
      var r = Math.hypot(p.x, p.y), theta = r / RING * Math.PI / 2;
      p.pos = r < 1e-6 ? [0, 1, 0] : [Math.sin(theta) * p.x / r, Math.cos(theta), -Math.sin(theta) * p.y / r];
      p.cur = 0.2; p.seed = i * 1.618;
    });

    // 头部的经纬线、鼻尖和耳朵
    var wire = [];
    function seg(a, b, alpha) { wire.push({ a: a, b: b, alpha: alpha }); }
    function onSphere(theta, phi) { return [Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi)]; }
    [[30, .30], [60, .30], [90, .62], [116, .22], [140, .12]].forEach(function (ring) {
      var theta = ring[0] * Math.PI / 180;
      for (var i = 0; i < 56; i++) seg(onSphere(theta, i / 56 * Math.PI * 2), onSphere(theta, (i + 1) / 56 * Math.PI * 2), ring[1]);
    });
    for (var m = 0; m < 12; m++) {
      var phi = m / 12 * Math.PI * 2;
      for (var k = 0; k < 20; k++) {
        var t0 = k / 20 * 150 * Math.PI / 180, t1 = (k + 1) / 20 * 150 * Math.PI / 180;
        seg(onSphere(t0, phi), onSphere(t1, phi), (m % 3 === 0 ? .34 : .16) * (1 - Math.max(0, k - 11) / 9));
      }
    }
    seg([-0.13, 0, -0.99], [0, -0.02, -1.19], .8); seg([0, -0.02, -1.19], [0.13, 0, -0.99], .8);
    [-1, 1].forEach(function (side) {
      var pts = [[1, 0, -0.16], [1.07, 0, -0.1], [1.1, 0, 0], [1.07, 0, 0.11], [1, 0, 0.17]];
      for (var i = 0; i < pts.length - 1; i++) seg([side * pts[i][0], pts[i][1], pts[i][2]], [side * pts[i + 1][0], pts[i + 1][1], pts[i + 1][2]], .7);
    });

    var maxPoints = dots.length * 2 + 2 * 44 + 2 * 2 * 5 * 22;
    var pointsBack = new Float32Array(maxPoints * STRIDE), pointsFront = new Float32Array(maxPoints * STRIDE);
    var linesBack = new Float32Array(wire.length * 2 * STRIDE), linesFront = new Float32Array(wire.length * 2 * STRIDE);
    var buffer = gl.createBuffer(), quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = {
      pos: gl.getAttribLocation(markProg, 'aPos'), size: gl.getAttribLocation(markProg, 'aSize'),
      soft: gl.getAttribLocation(markProg, 'aSoft'), color: gl.getAttribLocation(markProg, 'aColor'),
      point: gl.getUniformLocation(markProg, 'uPoint'),
      ballPos: gl.getAttribLocation(ballProg, 'aPos'), ballScale: gl.getUniformLocation(ballProg, 'uScale'),
      fill: gl.getUniformLocation(ballProg, 'uFill'), rim: gl.getUniformLocation(ballProg, 'uRim'), px: gl.getUniformLocation(ballProg, 'uPx')
    };

    var colors = {};
    function readColors() {
      colors = { left: cssColor('--left'), right: cssColor('--right'), mid: cssColor('--ink-3'), ink: cssColor('--ink-3'), fill: cssColor('--raised') };
    }
    readColors();

    var view = { yaw: 0, pitch: 0, dragYaw: 0, dragPitch: 0, dragging: false };
    var smooth = { attended: state.attended, verdictL: 0, verdictR: 0 };
    var BASE_PITCH = 68 * Math.PI / 180;

    function project(p, yaw, pitch, out) {
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      var x = p[0] * cy + p[2] * sy, z = -p[0] * sy + p[2] * cy;
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var y2 = p[1] * cp - z * sp, z2 = p[1] * sp + z * cp;
      var k = D / (D - z2);
      out[0] = x * k; out[1] = y2 * k; out[2] = z2;
    }
    var tmp = [0, 0, 0], tmp2 = [0, 0, 0];

    function frame(t, dt) {
      var size = fit(canvas, gl, 2);
      if (size.w < 10 || size.h < 10) return;
      var mid = placeholder.getBoundingClientRect(), box = canvas.getBoundingClientRect();
      var unit = Math.min(mid.width * 0.385, mid.height * 0.40);          // 头的半径，CSS 像素
      var kx = unit / (size.w / 2), ky = unit / (size.h / 2), dpr = size.dpr;
      var sideW = Math.max(20, mid.left - box.left - 10);                 // 两侧说话人按钮的宽度
      var sourceX = Math.max(1.5, (mid.width / 2 + 10 + sideW / 2) / unit);   // 按钮中心到头部中心的距离
      var sideHalf = sideW / 2 / unit;

      // 视角：缓慢左右摆动，拖动之后慢慢回正
      if (!view.dragging) {
        var back = Math.exp(-dt * 0.55);
        view.dragYaw *= back; view.dragPitch *= back;
      }
      var time = reduceMotion ? 0 : t;
      view.yaw = (reduceMotion ? 0.28 : 0.42 * Math.sin(time * 0.33)) + view.dragYaw;
      view.pitch = BASE_PITCH + (reduceMotion ? 0 : 0.06 * Math.sin(time * 0.21)) + view.dragPitch;

      var ease = reduceMotion ? 1 : Math.min(1, dt * 3.2);
      smooth.attended += (state.attended - smooth.attended) * ease;
      smooth.verdictL += ((state.verdict < 0 ? 1 : 0) - smooth.verdictL) * ease;
      smooth.verdictR += ((state.verdict > 0 ? 1 : 0) - smooth.verdictR) * ease;

      var nb = 0, nf = 0;
      function point(arr, n, x, y, px, soft, c, a) {
        var o = n * STRIDE;
        arr[o] = x * kx; arr[o + 1] = y * ky; arr[o + 2] = px * dpr; arr[o + 3] = soft;
        arr[o + 4] = c[0]; arr[o + 5] = c[1]; arr[o + 6] = c[2]; arr[o + 7] = a;
      }

      // 电极
      var srcX = smooth.attended * sourceX;
      dots.forEach(function (p) {
        var target = p.side ? (p.gain || 0) : 0.18;
        p.cur += (target - p.cur) * (reduceMotion ? 1 : Math.min(1, dt * 4.5));
        project(p.pos, view.yaw, view.pitch, tmp);
        // 从正在听的那一侧扫过头皮的涟漪
        var dist = Math.hypot(p.pos[0] - srcX, p.pos[1], p.pos[2]);
        var ripple = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(time * 3.4 - dist * 3.0 + p.seed * 0.15);
        var level = p.cur + 0.16 * ripple;
        var facing = Math.max(0, Math.min(1, (tmp[2] + 0.30) / 0.55));
        var c = p.side < 0 ? colors.left : p.side > 0 ? colors.right : colors.mid;
        var px = unit * 0.072 * (0.85 + 1.25 * level) * (0.72 + 0.28 * facing);
        var alpha = Math.min(1, (p.side ? 0.42 + 0.85 * level : 0.5)) * (0.25 + 0.75 * facing);
        var front = tmp[2] >= 0;
        if (p.side && level > 0.25) {
          if (front) point(pointsFront, nf++, tmp[0], tmp[1], px * 3.4, 1, c, Math.min(0.55, (level - 0.2) * 0.6) * facing);
          else point(pointsBack, nb++, tmp[0], tmp[1], px * 3.4, 1, c, Math.min(0.3, (level - 0.2) * 0.3));
        }
        if (front) point(pointsFront, nf++, tmp[0], tmp[1], Math.max(2.2, px), 0, c, alpha);
        else point(pointsBack, nb++, tmp[0], tmp[1], Math.max(2, px), 0, c, alpha);
      });

      // 判决弧：累积后的输出偏向哪一侧，哪一侧的弧就亮
      [[-1, smooth.verdictL, colors.left], [1, smooth.verdictR, colors.right]].forEach(function (v) {
        for (var i = 0; i < 44; i++) {
          var a = (i / 43 - 0.5) * 1.75;
          project([v[0] * 1.24 * Math.cos(a), 0, 1.24 * Math.sin(a)], 0, view.pitch, tmp);
          point(pointsFront, nf++, tmp[0], tmp[1], unit * 0.05, 0, v[2], 0.13 + 0.82 * v[1]);
        }
      });

      // 两侧传来的声波：正在听的那一侧更亮
      var reach = sourceX - 1.04, startR = Math.min(sideHalf, reach * 0.6);
      [-1, 1].forEach(function (side) {
        var strength = 0.22 + 0.68 * Math.max(0, Math.min(1, 0.5 + 0.5 * side * smooth.attended));
        var c = side < 0 ? colors.left : colors.right;
        for (var j = 0; j < 5; j++) {
          var phase = reduceMotion ? (j + 0.5) / 5 : ((time * (side < 0 ? 0.42 : 0.36) + j / 5) % 1);
          var r = startR + phase * (reach - startR);
          var fade = Math.pow(Math.sin(Math.PI * phase), 0.8) * strength;
          for (var plane = 0; plane < 2; plane++) {
            for (var q = 0; q < 22; q++) {
              var ang = (q / 21 - 0.5) * 1.9, sn = r * Math.sin(ang);
              project([side * (sourceX - r * Math.cos(ang)), plane ? sn : 0, plane ? 0 : sn], 0, view.pitch, tmp);
              point(pointsFront, nf++, tmp[0], tmp[1], unit * 0.034, 0, c, fade * Math.pow(Math.cos(ang), 1.5));
            }
          }
        }
      });

      // 经纬线：背面的淡一些
      var lb = 0, lf = 0;
      wire.forEach(function (s) {
        project(s.a, view.yaw, view.pitch, tmp); project(s.b, view.yaw, view.pitch, tmp2);
        var z = (tmp[2] + tmp2[2]) / 2, front = z >= 0;
        var arr = front ? linesFront : linesBack, n = front ? lf : lb;
        var alpha = s.alpha * (front ? 0.5 + 0.5 * Math.min(1, z / 0.4) : 0.38);
        point(arr, n, tmp[0], tmp[1], 1, 0, colors.ink, alpha);
        point(arr, n + 1, tmp2[0], tmp2[1], 1, 0, colors.ink, alpha);
        if (front) lf += 2; else lb += 2;
      });

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

      function drawMarks(arr, count, mode) {
        if (!count) return;
        gl.useProgram(markProg);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, count * STRIDE), gl.DYNAMIC_DRAW);
        var bytes = STRIDE * 4;
        gl.enableVertexAttribArray(loc.pos); gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, bytes, 0);
        gl.enableVertexAttribArray(loc.size); gl.vertexAttribPointer(loc.size, 1, gl.FLOAT, false, bytes, 8);
        gl.enableVertexAttribArray(loc.soft); gl.vertexAttribPointer(loc.soft, 1, gl.FLOAT, false, bytes, 12);
        gl.enableVertexAttribArray(loc.color); gl.vertexAttribPointer(loc.color, 4, gl.FLOAT, false, bytes, 16);
        gl.uniform1f(loc.point, mode === gl.POINTS ? 1 : 0);
        gl.drawArrays(mode, 0, count);
      }
      drawMarks(linesBack, lb, gl.LINES);
      drawMarks(pointsBack, nb, gl.POINTS);

      gl.useProgram(ballProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc.ballPos); gl.vertexAttribPointer(loc.ballPos, 2, gl.FLOAT, false, 0, 0);
      var grow = D / Math.sqrt(D * D - 1);
      gl.uniform2f(loc.ballScale, kx * grow, ky * grow);
      gl.uniform3fv(loc.fill, colors.fill); gl.uniform3fv(loc.rim, colors.ink);
      gl.uniform1f(loc.px, 1 / (unit * dpr));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      drawMarks(linesFront, lf, gl.LINES);
      drawMarks(pointsFront, nf, gl.POINTS);
    }

    var loop = runner(canvas, frame);
    onScheme(function () { readColors(); loop.kick(); });

    // 拖动旋转
    var lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', function (ev) {
      view.dragging = true; lastX = ev.clientX; lastY = ev.clientY;
      canvas.setPointerCapture(ev.pointerId); canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!view.dragging) return;
      view.dragYaw = Math.max(-1.4, Math.min(1.4, view.dragYaw + (ev.clientX - lastX) * 0.012));
      view.dragPitch = Math.max(-0.75, Math.min(0.36, view.dragPitch + (ev.clientY - lastY) * 0.008));
      lastX = ev.clientX; lastY = ev.clientY;
      loop.kick();
    });
    function release() { view.dragging = false; canvas.classList.remove('dragging'); loop.kick(); }
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);

    // 显卡上下文丢了就退回 SVG
    canvas.addEventListener('webglcontextlost', function (ev) {
      ev.preventDefault(); loop.stop(); canvas.remove(); stage.classList.remove('has-gl');
    });
    return { kick: loop.kick };
  }

  /* ---------- 流动的脑电波背景 ---------- */

  var WAVE_VS = 'attribute vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }';
  var WAVE_FS = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n' +
    'uniform vec2 uRes; uniform float uTime; uniform vec3 uLeft; uniform vec3 uRight; uniform float uAlpha; uniform float uLines; uniform float uUnit;' +
    'float trace(float x, float t, float s){' +
    ' float y = sin(x * 11.0 + t * 0.9 + s * 5.1) * 0.30 + sin(x * 24.0 - t * 1.5 + s * 9.7) * 0.24' +
    '   + sin(x * 51.0 + t * 2.3 + s * 3.3) * 0.16 + sin(x * 97.0 - t * 3.4 + s * 7.9) * 0.09;' +
    ' return y * (0.42 + 0.58 * sin(x * 2.6 - t * 0.45 + s * 12.0)); }' +
    'void main(){ vec2 uv = gl_FragCoord.xy / uRes; float x = gl_FragCoord.x / uUnit; float e = 1.0 / uUnit;' +
    ' float amp = 0.42 / uLines * uRes.y; float a = 0.0;' +
    ' for (int i = 0; i < 12; i++) { float fi = float(i); if (fi >= uLines) break;' +
    '   float s = fi * 0.37 + 0.11; float y0 = trace(x, uTime, s); float slope = (trace(x + e, uTime, s) - y0) * amp;' +
    '   float d = abs(gl_FragCoord.y - ((fi + 0.5) / uLines * uRes.y + y0 * amp)) / sqrt(1.0 + slope * slope);' +
    '   a += smoothstep(1.5, 0.2, d); }' +
    ' a = min(a, 1.0) * uAlpha;' +
    ' a *= smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x) * smoothstep(0.0, 0.14, uv.y) * smoothstep(1.0, 0.80, uv.y);' +
    ' vec3 col = mix(uLeft, uRight, smoothstep(0.30, 0.70, uv.x));' +
    ' gl_FragColor = vec4(col * a, a); }';

  function mountWaves(canvas) {
    var gl = context(canvas);
    if (!gl) { canvas.remove(); return null; }
    var prog;
    try { prog = program(gl, WAVE_VS, WAVE_FS); } catch (err) { canvas.remove(); return null; }
    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'aPos');
    var u = {};
    ['uRes', 'uTime', 'uLeft', 'uRight', 'uAlpha', 'uLines', 'uUnit'].forEach(function (name) { u[name] = gl.getUniformLocation(prog, name); });
    var left, right, dark;
    var onDark = canvas.hasAttribute('data-on-dark');     // 画在固定的深色底上，不跟随系统的浅色模式
    function readColors() {
      left = onDark ? [0.30, 0.75, 0.80] : cssColor('--left'); right = onDark ? [0.94, 0.54, 0.32] : cssColor('--right');
      dark = onDark || !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    }
    readColors();
    var strength = parseFloat(canvas.getAttribute('data-waves')) || 1;

    var loop = runner(canvas, function (t) {
      var size = fit(canvas, gl, 1.5);
      if (size.w < 10 || size.h < 10) return;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(u.uRes, canvas.width, canvas.height);
      gl.uniform1f(u.uTime, reduceMotion ? 3.0 : (t % 2000));
      gl.uniform3fv(u.uLeft, left); gl.uniform3fv(u.uRight, right);
      gl.uniform1f(u.uAlpha, (dark ? 0.30 : 0.24) * strength);
      gl.uniform1f(u.uUnit, 680 * size.dpr);            // 波形的疏密按固定的像素尺度，不随屏幕宽度拉伸
      gl.uniform1f(u.uLines, Math.max(4, Math.min(12, Math.round(size.h / 70))));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    });
    onScheme(function () { readColors(); loop.kick(); });
    canvas.addEventListener('webglcontextlost', function (ev) { ev.preventDefault(); loop.stop(); canvas.remove(); });
    return loop;
  }

  global.LNGL = { mountHead: mountHead, mountWaves: mountWaves, reduceMotion: reduceMotion };

  function auto() {
    Array.prototype.forEach.call(document.querySelectorAll('canvas[data-waves]'), mountWaves);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
  else auto();
})(window);
