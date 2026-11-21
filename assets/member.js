/* 聆脑寻音 · 队员版：登录、解密、阅读。没有服务器，全部在浏览器里完成。 */
(function () {
  'use strict';

  var BUILD = document.documentElement.dataset.build || '';
  var DATA = 'data/';
  var SESSION_KEY = 'lingnao.member.session';
  var enc = new TextEncoder(), dec = new TextDecoder();

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var state = {
    key: null, keys: {}, profile: null, manifest: null, byId: {}, byCollection: {},
    docCache: new Map(), blobUrls: new Map(), search: null, currentDoc: null, seq: 0
  };

  // ───────────── 加解密 ─────────────
  function b64ToBytes(text) {
    var bin = atob(text), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function unseal(key, bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: view.subarray(0, 12) }, key, view.subarray(12));
  }
  function importSiteKey(base64) {
    return crypto.subtle.importKey('raw', b64ToBytes(base64), 'AES-GCM', false, ['decrypt']);
  }
  // acl：受限范围的标识。受限的内容用那个范围自己的钥匙，账号里没有这把钥匙就解不开。
  function fetchSealed(path, acl) {
    var key = acl ? state.keys[acl] : state.key;
    if (!key) return Promise.reject(new Error('没有查看权限'));
    return fetch(DATA + path + '?v=' + BUILD).then(function (res) {
      if (!res.ok) throw new Error('读取失败：' + path);
      return res.arrayBuffer();
    }).then(function (buffer) { return unseal(key, buffer); });
  }
  function fetchSealedJson(path, acl) {
    return fetchSealed(path, acl).then(function (buffer) { return JSON.parse(dec.decode(buffer)); });
  }

  function AuthError() { this.name = 'AuthError'; }

  function authenticate(username, password) {
    var user = username.trim().toLowerCase();
    return fetch(DATA + 'keys.json', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('读取账号信息失败');
      return res.json();
    }).then(function (ring) {
      var siteSalt = b64ToBytes(ring.site), name = enc.encode(user);
      var joined = new Uint8Array(siteSalt.length + name.length);
      joined.set(siteSalt); joined.set(name, siteSalt.length);
      return crypto.subtle.digest('SHA-256', joined).then(function (digest) {
        var entry = ring.users[hex(digest).slice(0, 32)];
        // 用户名不存在时也照常做一次派生，耗时上看不出差别
        var salt = entry ? b64ToBytes(entry.s) : crypto.getRandomValues(new Uint8Array(16));
        return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']).then(function (base) {
          return crypto.subtle.deriveKey(
            { name: 'PBKDF2', hash: ring.kdf.hash, salt: salt, iterations: ring.kdf.iterations },
            base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        }).then(function (kek) {
          if (!entry) throw new AuthError();
          return unseal(kek, b64ToBytes(entry.w)).then(
            function (plain) { return JSON.parse(dec.decode(plain)); },
            function () { throw new AuthError(); });
        });
      });
    });
  }

  // ───────────── 会话 ─────────────
  function readSession() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeSession(profile, remember) {
    try {
      sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY);
      (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify(profile));
    } catch (e) { /* 无痕模式下存不了，本次仍可使用 */ }
  }
  function clearSession() {
    try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }

  function openSession(profile) {
    var granted = Object.keys(profile.g || {});
    return importSiteKey(profile.k).then(function (key) {
      state.key = key; state.profile = profile; state.keys = {};
      return Promise.all(granted.map(function (gid) {
        return importSiteKey(profile.g[gid]).then(function (k) { state.keys[gid] = k; });
      }));
    }).then(function () {
      return fetchSealedJson('manifest.bin');
    }).then(function (manifest) {
      // 权限配置变过：存着的登录信息里钥匙可能不全或已作废，要求重新登录
      if ((manifest.access || '') !== (profile.av || '')) throw new Error('权限有更新');
      // 这个账号能看的受限范围，各有一份自己的目录
      state.extraCharts = [];
      return Promise.all(granted.map(function (gid) {
        return fetchSealedJson('manifest-' + gid + '.bin', gid).then(function (scoped) {
          scoped.docs.forEach(function (doc) { doc.acl = gid; manifest.docs.push(doc); });
          scoped.attachments.forEach(function (a) { a.acl = gid; manifest.attachments.push(a); });
          (scoped.chart_sections || []).forEach(function (section) {
            section.limited = true;
            state.extraCharts.push(section);
            manifest.charts += section.charts.length;
          });
        });
      })).then(function () { return manifest; });
    }).then(function (manifest) {
      state.manifest = manifest; state.byId = {}; state.byCollection = {};
      manifest.docs.forEach(function (doc) {
        state.byId[doc.id] = doc;
        (state.byCollection[doc.collection] = state.byCollection[doc.collection] || []).push(doc);
      });
      // 总览和教学按原有顺序，其余按最近修改排在前
      manifest.collections.forEach(function (c) {
        var list = state.byCollection[c.id] || (state.byCollection[c.id] = []);
        if (c.id !== 'overview' && c.id !== 'course') list.sort(function (a, b) { return b.mtime - a.mtime; });
      });
    });
  }

  // ───────────── 登录界面 ─────────────
  var loginEl = $('#login'), appEl = $('#app');
  var form = $('#login-form'), errorEl = $('#login-error'), submitBtn = $('#login-submit');

  function showLogin(message) {
    document.body.classList.remove('booting');
    appEl.hidden = true; loginEl.hidden = false;
    document.title = '聆脑寻音 · 队员登录';
    showError(message || '');
    if (!window.crypto || !crypto.subtle) {
      showError('这个页面不是通过 HTTPS 打开的，浏览器没法解密内容。请换用 https 地址，或在本机用 localhost 预览。');
      submitBtn.disabled = true;
      return;
    }
    var userInput = $('#login-user');
    (userInput.value ? $('#login-pass') : userInput).focus();
  }
  function showError(message) {
    errorEl.textContent = message; errorEl.hidden = !message;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var username = $('#login-user').value, password = $('#login-pass').value;
    if (!username.trim() || !password) { showError('请输入用户名和密码。'); return; }
    showError('');
    submitBtn.disabled = true; submitBtn.textContent = '正在验证…';
    authenticate(username, password).then(function (profile) {
      writeSession(profile, $('#login-remember').checked);
      return openSession(profile);
    }).then(function () {
      $('#login-pass').value = '';
      enterApp();
    }).catch(function (error) {
      clearSession();
      showError(error instanceof AuthError ? '用户名或密码不对。' : '没能打开内容：' + (error.message || '网络错误') + '。请刷新后重试。');
    }).then(function () {
      submitBtn.disabled = false; submitBtn.textContent = '登录';
    });
  });

  function logout() {
    clearSession();
    state.blobUrls.forEach(function (url) { URL.revokeObjectURL(url); });
    state.blobUrls.clear(); state.docCache.clear();
    state.key = state.profile = state.manifest = state.search = state.charts = state.currentDoc = null;
    state.keys = {}; state.extraCharts = [];
    $('#view').innerHTML = ''; $('#side').innerHTML = '';
    history.replaceState(null, '', location.pathname);
    showLogin('');
  }

  // ───────────── 工具 ─────────────
  function fmtDate(ts, withYear) {
    var d = new Date(ts * 1000);
    return (withYear ? d.getFullYear() + ' 年 ' : '') + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }
  function fmtIsoDate(iso) {
    var p = iso.split('-');
    return Number(p[1]) + ' 月 ' + Number(p[2]) + ' 日';
  }
  function fmtChars(n) {
    return n >= 10000 ? '约 ' + (n / 10000).toFixed(1) + ' 万字' : '约 ' + Math.max(100, Math.round(n / 100) * 100).toLocaleString('en-US') + ' 字';
  }
  var toastTimer = null;
  function toast(message) {
    var el = $('#toast');
    el.textContent = message; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }
  function copyText(text, done) {
    var ok = function () { toast(done); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () { toast('复制失败，路径是：' + text); });
    } else { toast(text); }
  }
  function collection(id) {
    return state.manifest.collections.filter(function (c) { return c.id === id; })[0];
  }
  function docLink(doc) { return '#/doc/' + doc.id; }

  function blobUrl(kind, id, mime, acl) {
    var cacheKey = kind + id;
    if (state.blobUrls.has(cacheKey)) return Promise.resolve(state.blobUrls.get(cacheKey));
    return fetchSealed(kind + '/' + id + '.bin', acl).then(function (buffer) {
      var url = URL.createObjectURL(new Blob([buffer], { type: mime }));
      state.blobUrls.set(cacheKey, url);
      return url;
    });
  }
  function download(attachmentId) {
    var item = state.manifest.attachments.filter(function (a) { return a.id === attachmentId; })[0];
    if (!item) { toast('这个文件不存在，或者你的账号没有查看权限'); return; }
    toast('正在解密 ' + item.name + '…');
    blobUrl('f', item.id, item.mime, item.acl).then(function (url) {
      var a = document.createElement('a');
      a.href = url; a.download = item.name;
      document.body.appendChild(a); a.click(); a.remove();
      toast('已开始下载 ' + item.name);
    }).catch(function () { toast('下载失败，请重试'); });
  }

  // ───────────── 外框 ─────────────
  var view = $('#view'), side = $('#side');

  function enterApp() {
    document.body.classList.remove('booting');
    loginEl.hidden = true; appEl.hidden = false;
    $('#user-name').textContent = state.profile.name;
    route();
  }

  function renderSide(active) {
    var m = state.manifest, html = '';
    html += '<a class="side-link' + (active.page === 'home' ? ' on' : '') + '" href="#/">概览<span>时间线</span></a>';
    if (m.charts) html += '<a class="side-link' + (active.page === 'charts' ? ' on' : '') + '" href="#/charts">图表<span>' + m.charts + ' 张</span></a>';
    html += '<p class="side-title">资料库</p>';
    m.collections.forEach(function (c) {
      var docs = state.byCollection[c.id], open = active.collection === c.id;
      if (!docs.length) return;                      // 这个账号一篇也看不到的栏目不列出来
      html += '<a class="side-link' + (open && active.page === 'collection' ? ' on' : '') + (open ? ' open' : '') +
        '" href="#/c/' + c.id + '">' + esc(c.title) + '<span>' + docs.length + '</span></a>';
      if (open) {
        html += '<ul class="side-docs">' + docs.map(function (d) {
          return '<li><a href="' + docLink(d) + '"' + (active.doc === d.id ? ' class="on" aria-current="page"' : '') + '>' + esc(d.title) + '</a></li>';
        }).join('') + '</ul>';
      }
    });
    html += '<p class="side-title">文件</p>';
    html += '<a class="side-link' + (active.page === 'files' ? ' on' : '') + '" href="#/files">附件下载<span>' +
      m.attachments.filter(function (a) { return a.included; }).length + '</span></a>';
    side.innerHTML = html;
    var current = $('.side-docs a.on', side);
    if (current && current.scrollIntoView) current.scrollIntoView({ block: 'nearest' });
  }

  function setTitle(text) { document.title = (text ? text + ' · ' : '') + '聆脑寻音 队员版'; }

  // ───────────── 页面：概览 ─────────────
  function renderHome() {
    var m = state.manifest, o = m.overview;
    var built = new Date(m.built);
    var recent = m.docs.slice().sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 6);
    var html = '<div class="page">';
    html += '<header class="page-head"><p class="kicker">队员工作台</p><h1>' + esc(state.profile.name) + '，你好</h1>' +
      '<p class="page-meta">资料同步于 ' + built.getFullYear() + ' 年 ' + (built.getMonth() + 1) + ' 月 ' + built.getDate() + ' 日 ' +
      ('0' + built.getHours()).slice(-2) + ':' + ('0' + built.getMinutes()).slice(-2) +
      ' · ' + m.docs.length + ' 篇文档 · ' + o.timeline.length + ' 条进展记录</p></header>';

    html += '<section class="now">';
    if (o.lead) html += '<article class="now-card"><h2>主模型</h2><div class="rich">' + o.lead + '</div></article>';
    if (o.current) html += '<article class="now-card accent"><h2>当前路线</h2><div class="rich">' + o.current + '</div></article>';
    html += '</section>';
    if (m.charts) html += '<a class="chart-entry" href="#/charts"><b>用图看结果</b>' +
      '<span>换边前后每一秒的正确率、各版方案的取舍 · ' + m.charts + ' 张图 →</span></a>';

    if (o.timeline.length) {
      html += '<section class="block"><div class="block-head"><h2>进展时间线</h2><a href="' +
        (state.byCollection.overview[0] ? docLink(state.byCollection.overview[0]) : '#/') + '">读完整的项目总览 →</a></div><ol class="timeline">';
      var lastDate = null;
      o.timeline.forEach(function (item) {
        var first = item.date !== lastDate; lastDate = item.date;
        html += '<li class="tl-item' + (first ? ' first' : '') + '">' +
          '<time datetime="' + item.date + '">' + (first ? fmtIsoDate(item.date) : '') + '</time>' +
          '<details class="tl-body"><summary><span class="tl-headline">' + esc(item.headline) + '。</span>' +
          item.tags.map(function (t) { return '<span class="tag' + (t === '未得到支持' ? ' tag-neg' : '') + '">' + esc(t) + '</span>'; }).join('') +
          '</summary><div class="rich">' + item.html + '</div></details></li>';
      });
      html += '</ol></section>';
    }

    html += '<section class="block"><div class="block-head"><h2>最近修改的文档</h2></div><ul class="doc-list compact">' +
      recent.map(docRow).join('') + '</ul></section>';

    html += '<section class="block"><div class="block-head"><h2>资料库</h2></div><div class="shelves">' +
      m.collections.filter(function (c) { return state.byCollection[c.id].length; }).map(function (c) {
        return '<a class="shelf" href="#/c/' + c.id + '"><span class="shelf-count num">' + state.byCollection[c.id].length +
          '</span><span class="shelf-title">' + esc(c.title) + '</span><span class="shelf-blurb">' + esc(c.blurb) + '</span></a>';
      }).join('') + '</div></section></div>';
    view.innerHTML = html;
    setTitle('概览');
  }

  function docRow(doc) {
    var c = collection(doc.collection);
    return '<li><a class="doc-row" href="' + docLink(doc) + '">' +
      '<span class="doc-title">' + esc(doc.title) + '</span>' +
      '<span class="doc-summary">' + esc(doc.summary) + '</span>' +
      '<span class="doc-meta"><span>' + esc(c.title) + '</span><span>' + fmtDate(doc.mtime) + ' 修改</span><span>' + fmtChars(doc.chars) +
      '</span><span class="doc-path">' + esc(doc.path) + '</span></span></a></li>';
  }

  // ───────────── 页面：栏目 ─────────────
  function renderCollection(id) {
    var c = collection(id);
    var docs = state.byCollection[id];
    if (!c || !docs.length) return renderMissing();
    var limited = docs.every(function (d) { return d.acl; });
    view.innerHTML = '<div class="page"><header class="page-head"><p class="kicker">资料库</p><h1>' + esc(c.title) +
      '</h1><p class="page-meta">' + esc(c.blurb) + ' · ' + docs.length + ' 篇' +
      (limited ? ' <span class="tag">只对指定账号开放</span>' : '') + '</p></header>' +
      '<ul class="doc-list">' + docs.map(docRow).join('') + '</ul></div>';
    setTitle(c.title);
  }

  // ───────────── 页面：文档 ─────────────
  function loadDoc(id) {
    if (state.docCache.has(id)) return Promise.resolve(state.docCache.get(id));
    return fetchSealedJson('d/' + id + '.bin', state.byId[id] && state.byId[id].acl).then(function (payload) {
      state.docCache.set(id, payload.html);
      return payload.html;
    });
  }

  function scrollToAnchor(anchor, smooth) {
    if (!anchor) return false;
    var target = document.getElementById(anchor);
    if (!target || !view.contains(target)) return false;
    target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    return true;
  }

  function renderDoc(id, anchor) {
    var doc = state.byId[id];
    if (!doc) return renderMissing();
    if (state.currentDoc === id && $('.article', view)) { scrollToAnchor(anchor); return; }
    var seq = ++state.seq, c = collection(doc.collection);
    var siblings = state.byCollection[doc.collection], index = siblings.indexOf(doc);
    view.innerHTML = '<div class="page doc-page"><p class="loading">正在解密文档…</p></div>';
    setTitle(doc.title);
    loadDoc(id).then(function (html) {
      if (seq !== state.seq) return;
      var toc = doc.headings.length >= 3 ? '<aside class="toc" aria-label="本页目录"><p>本页目录</p><ul>' +
        doc.headings.map(function (h) {
          return '<li class="l' + h.level + '"><a href="#" data-anchor="' + esc(h.id) + '">' + esc(h.text) + '</a></li>';
        }).join('') + '</ul></aside>' : '';
      var prev = siblings[index - 1], next = siblings[index + 1];
      view.innerHTML = '<div class="page doc-page' + (toc ? ' with-toc' : '') + '"><div class="doc-main">' +
        '<nav class="crumbs" aria-label="位置"><a href="#/c/' + c.id + '">' + esc(c.title) + '</a><span>' + esc(doc.path) + '</span></nav>' +
        '<article class="article">' + html + '</article>' +
        '<footer class="doc-foot"><p>' + fmtDate(doc.mtime, true) + ' 修改 · ' + fmtChars(doc.chars) +
        ' · <button type="button" class="linkish" data-copy="' + esc(doc.path) + '">复制文件路径</button></p>' +
        '<div class="pager">' +
        (prev ? '<a class="prev" href="' + docLink(prev) + '"><span>上一篇</span>' + esc(prev.title) + '</a>' : '<span></span>') +
        (next ? '<a class="next" href="' + docLink(next) + '"><span>下一篇</span>' + esc(next.title) + '</a>' : '<span></span>') +
        '</div></footer></div>' + toc + '</div>';
      state.currentDoc = id;
      var article = $('.article', view);
      if (!$('h1', article)) article.insertAdjacentHTML('afterbegin', '<h1>' + esc(doc.title) + '</h1>');
      hydrateImages(article);
      if (doc.has_mermaid && state.manifest.has_mermaid_lib) renderDiagrams(article);
      watchToc();
      if (!scrollToAnchor(anchor)) window.scrollTo(0, 0);
    }).catch(function () {
      if (seq !== state.seq) return;
      view.innerHTML = '<div class="page"><p class="loading">这篇文档没能解密。可能是站点刚更新过，请退出后重新登录。</p></div>';
    });
  }

  function hydrateImages(root) {
    $$('img[data-asset]', root).forEach(function (img) {
      img.classList.add('pending');
      blobUrl('a', img.dataset.asset, img.dataset.mime, img.dataset.acl).then(function (url) {
        img.src = url; img.classList.remove('pending');
      }).catch(function () {
        img.classList.remove('pending'); img.classList.add('broken');
        if (img.dataset.acl && !state.keys[img.dataset.acl]) img.alt = '这张图只对指定账号开放';
      });
    });
  }

  var mermaidLoading = null;
  function renderDiagrams(root) {
    if (!mermaidLoading) {
      mermaidLoading = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'vendor/mermaid.min.js?v=' + BUILD; s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      }).then(function () {
        var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        window.mermaid.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'neutral', securityLevel: 'strict',
          fontFamily: getComputedStyle(document.body).fontFamily });
      });
    }
    mermaidLoading.then(function () {
      $$('pre.mermaid-src', root).forEach(function (pre, i) {
        var figure = pre.parentNode;
        window.mermaid.render('diagram-' + Date.now() + '-' + i, pre.textContent).then(function (out) {
          if (!figure.isConnected) return;
          figure.innerHTML = out.svg; figure.classList.add('ready');
        }).catch(function () { /* 画不出来就保留源码 */ });
      });
    }).catch(function () {});
  }

  var tocObserver = null;
  function watchToc() {
    if (tocObserver) { tocObserver.disconnect(); tocObserver = null; }
    var links = $$('.toc a', view);
    if (!links.length || !('IntersectionObserver' in window)) return;
    var map = {};
    links.forEach(function (a) { map[a.dataset.anchor] = a; });
    tocObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('on'); });
        var a = map[entry.target.id];
        if (a) a.classList.add('on');
      });
    }, { rootMargin: '-64px 0px -70% 0px' });
    $$('.article h2[id], .article h3[id]', view).forEach(function (h) { tocObserver.observe(h); });
  }

  // ───────────── 页面：附件 ─────────────
  function renderFiles() {
    var groups = {}, order = [];
    state.manifest.attachments.forEach(function (a) {
      if (!groups[a.group]) { groups[a.group] = []; order.push(a.group); }
      groups[a.group].push(a);
    });
    var html = '<div class="page"><header class="page-head"><p class="kicker">文件</p><h1>附件下载</h1>' +
      '<p class="page-meta">文件在浏览器里解密后保存到本机。体积太大的压缩包没有打包进网站，只列出它在项目目录里的位置。</p></header>';
    order.forEach(function (group) {
      html += '<section class="block"><div class="block-head"><h2>' + esc(group) +
        (groups[group].every(function (a) { return a.acl; }) ? ' <span class="tag">只对指定账号开放</span>' : '') +
        '</h2></div><ul class="file-list">' +
        groups[group].map(function (a) {
          return '<li><span class="file-name">' + esc(a.name) + '</span><span class="file-meta num">' + esc(a.size_text) + ' · ' + fmtDate(a.mtime) + '</span>' +
            (a.included ? '<button type="button" class="btn ghost small" data-attachment="' + a.id + '">下载</button>'
              : '<button type="button" class="btn ghost small" data-copy="' + esc(a.path) + '">复制路径</button>') + '</li>';
        }).join('') + '</ul></section>';
    });
    view.innerHTML = html + '</div>';
    setTitle('附件下载');
  }

  // ───────────── 页面：图表 ─────────────
  function renderCharts() {
    var seq = state.seq;
    view.innerHTML = '<div class="page"><header class="page-head"><p class="kicker">图表</p><h1>用图看结果</h1>' +
      '<p class="page-meta">数据每次构建时从项目目录里的归档结果重新提取。鼠标移到图上看数值，图下面可以展开数据表。</p></header>' +
      '<div id="charts-body"><p class="loading">正在解密图表数据…</p></div></div>';
    setTitle('图表');
    if (!state.charts) state.charts = fetchSealedJson('charts.bin');
    state.charts.then(function (sections) {
      if (seq !== state.seq) return;
      sections = sections.concat(state.extraCharts || []);
      var body = $('#charts-body');
      body.textContent = '';
      sections.forEach(function (section) {
        var block = document.createElement('section');
        block.className = 'block';
        block.innerHTML = '<div class="block-head"><h2>' + esc(section.title) +
          (section.limited ? ' <span class="tag">只对指定账号开放</span>' : '') + '</h2></div>' +
          (section.note ? '<p class="block-note">' + esc(section.note) + '</p>' : '') + '<div class="chart-grid"></div>';
        body.appendChild(block);
        var grid = $('.chart-grid', block);
        section.charts.forEach(function (spec) {
          var card = document.createElement('div');
          var wide = spec.kind === 'scatter' || (spec.kind === 'line' && spec.x.values.length > 20);
          card.className = 'chart-card' + (wide ? ' wide' : '');
          grid.appendChild(card);
          window.LNCharts.render(card, spec);
        });
      });
    }).catch(function () {
      state.charts = null;
      var body = $('#charts-body');
      if (body) body.innerHTML = '<p class="loading">图表数据没能读出来，请刷新重试。</p>';
    });
  }

  // ───────────── 页面：搜索 ─────────────
  function loadSearch() {
    if (!state.search) state.search = Promise.all([fetchSealedJson('search.bin')].concat(
      Object.keys(state.keys).map(function (gid) { return fetchSealedJson('search-' + gid + '.bin', gid); })
    )).then(function (parts) {
      var rows = Array.prototype.concat.apply([], parts);
      rows.forEach(function (row) { row.lower = row.text.toLowerCase(); });
      return rows;
    });
    return state.search;
  }
  function highlight(text, terms) {
    var out = esc(text);
    terms.forEach(function (term) {
      var pattern = esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(pattern, 'gi'), function (hit) { return '<mark>' + hit + '</mark>'; });
    });
    return out;
  }
  function renderSearch(query) {
    var seq = ++state.seq;
    var input = $('#search-input');
    if (input.value !== query) input.value = query;
    var terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    setTitle('搜索 ' + query);
    if (!terms.length) { view.innerHTML = '<div class="page"><p class="loading">输入关键词后回车。</p></div>'; return; }
    view.innerHTML = '<div class="page"><p class="loading">正在搜索…</p></div>';
    loadSearch().then(function (rows) {
      if (seq !== state.seq) return;
      var results = [];
      rows.forEach(function (row) {
        var doc = state.byId[row.id];
        if (!doc) return;
        var title = doc.title.toLowerCase(), score = 0, firstAt = -1;
        for (var i = 0; i < terms.length; i++) {
          var term = terms[i], inTitle = title.indexOf(term) >= 0, at = row.lower.indexOf(term);
          if (!inTitle && at < 0) return;
          var count = 0, pos = at;
          while (pos >= 0 && count < 200) { count++; pos = row.lower.indexOf(term, pos + term.length); }
          score += count + (inTitle ? 50 : 0);
          if (firstAt < 0 && at >= 0) firstAt = at;
        }
        var from = Math.max(0, firstAt - 50);
        var snippet = firstAt < 0 ? doc.summary : (from > 0 ? '…' : '') + row.text.slice(from, firstAt + 110) + '…';
        results.push({ doc: doc, score: score, snippet: snippet });
      });
      results.sort(function (a, b) { return b.score - a.score; });
      var html = '<div class="page"><header class="page-head"><p class="kicker">搜索</p><h1>「' + esc(query) + '」</h1>' +
        '<p class="page-meta">' + (results.length ? '在 ' + results.length + ' 篇文档里找到' : '没有找到。换个词试试，多个词之间用空格分开。') + '</p></header><ul class="doc-list">';
      results.slice(0, 60).forEach(function (r) {
        var c = collection(r.doc.collection);
        html += '<li><a class="doc-row" href="' + docLink(r.doc) + '"><span class="doc-title">' + highlight(r.doc.title, terms) +
          '</span><span class="doc-summary">' + highlight(r.snippet, terms) + '</span><span class="doc-meta"><span>' + esc(c.title) +
          '</span><span>' + fmtDate(r.doc.mtime) + ' 修改</span><span class="doc-path">' + esc(r.doc.path) + '</span></span></a></li>';
      });
      view.innerHTML = html + '</ul></div>';
    }).catch(function () {
      if (seq === state.seq) view.innerHTML = '<div class="page"><p class="loading">搜索索引没能加载，请刷新重试。</p></div>';
    });
  }

  function renderMissing() {
    view.innerHTML = '<div class="page"><header class="page-head"><h1>没有这个页面</h1><p class="page-meta">文档可能已经改名或移走，或者只对指定账号开放。<a href="#/">回到概览</a></p></header></div>';
    setTitle('未找到');
  }

  // ───────────── 路由 ─────────────
  function route() {
    if (!state.manifest) return;
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
    var head = parts[0], rest = parts.slice(1).join('/');
    closeMenu();
    if (head !== 'doc') { state.currentDoc = null; state.seq++; }
    if (head !== 'search') $('#search-input').value = '';
    if (!head) { renderHome(); renderSide({ page: 'home' }); window.scrollTo(0, 0); }
    else if (head === 'c') { renderCollection(rest); renderSide({ page: 'collection', collection: rest }); window.scrollTo(0, 0); }
    else if (head === 'doc') {
      var docId = parts[1], doc = state.byId[docId];
      renderSide({ page: 'doc', collection: doc && doc.collection, doc: docId });
      renderDoc(docId, parts.slice(2).join('/'));
    }
    else if (head === 'files') { renderFiles(); renderSide({ page: 'files' }); window.scrollTo(0, 0); }
    else if (head === 'charts' && state.manifest.charts) { renderCharts(); renderSide({ page: 'charts' }); window.scrollTo(0, 0); }
    else if (head === 'search') { renderSearch(rest); renderSide({ page: 'search' }); window.scrollTo(0, 0); }
    else { renderMissing(); renderSide({}); }
  }
  window.addEventListener('hashchange', route);

  // ───────────── 交互 ─────────────
  document.addEventListener('click', function (event) {
    var target = event.target.closest('[data-anchor],[data-attachment],[data-asset-link],[data-copy],.fileref,.article img,.diagram.ready');
    if (!target || !appEl.contains(target)) return;
    if (target.hasAttribute('data-anchor')) {
      event.preventDefault();
      scrollToAnchor(target.dataset.anchor, true);
    } else if (target.hasAttribute('data-attachment')) {
      event.preventDefault();
      download(target.dataset.attachment);
    } else if (target.hasAttribute('data-asset-link')) {
      event.preventDefault();
      blobUrl('a', target.dataset.assetLink, target.dataset.mime, target.dataset.acl).then(
        function (url) { window.open(url, '_blank', 'noopener'); },
        function () { toast('这张图不存在，或者你的账号没有查看权限'); });
    } else if (target.hasAttribute('data-copy')) {
      copyText(target.dataset.copy, '已复制路径');
    } else if (target.classList.contains('fileref')) {
      copyText(target.dataset.path, '已复制文件路径');
    } else if (target.tagName === 'IMG' && target.src) {
      window.open(target.src, '_blank', 'noopener');
    } else if (target.classList.contains('diagram')) {
      // 流程图默认缩到页面宽度，点一下按原始大小横向滚动着看
      var svg = target.querySelector('svg');
      if (!svg) return;
      if (target.classList.toggle('zoomed')) {
        svg.dataset.fit = svg.style.maxWidth;
        svg.style.width = svg.style.maxWidth || (svg.viewBox.baseVal.width + 'px');
        svg.style.maxWidth = 'none';
      } else {
        svg.style.maxWidth = svg.dataset.fit; svg.style.width = '';
      }
    }
  });
  document.addEventListener('keydown', function (event) {
    if (appEl.hidden) return;
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
      event.preventDefault(); $('#search-input').focus(); $('#search-input').select();
    } else if (event.key === 'Enter' && event.target.classList && event.target.classList.contains('fileref')) {
      copyText(event.target.dataset.path, '已复制文件路径');
    } else if (event.key === 'Escape') { closeMenu(); }
  });
  $('#search-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var q = $('#search-input').value.trim();
    if (q) location.hash = '#/search/' + encodeURIComponent(q);
  });
  $('#logout-btn').addEventListener('click', logout);

  var menuBtn = $('#menu-btn'), scrim = $('#scrim');
  function closeMenu() {
    document.body.classList.remove('menu-open'); scrim.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  menuBtn.addEventListener('click', function () {
    var open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open); scrim.hidden = !open;
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  scrim.addEventListener('click', closeMenu);

  // 登录页的电极点阵装饰
  (function () {
    var svg = $('#login-head');
    if (!svg) return;
    var NS = 'http://www.w3.org/2000/svg', rows = [[4, 18, 1], [3, 36, 2], [2, 54, 4], [1, 72, 4], [0, 90, 4], [-1, 108, 4], [-2, 126, 4], [-3, 144, 3], [-4, 162, 1]];
    function add(tag, attrs) { var n = document.createElementNS(NS, tag); for (var k in attrs) n.setAttribute(k, attrs[k]); svg.appendChild(n); }
    add('circle', { cx: 0, cy: 0, r: 1, class: 'lh-outline' });
    add('path', { d: 'M-0.11 -0.995 L0 -1.13 L0.11 -0.995', class: 'lh-outline' });
    rows.forEach(function (row) {
      var midY = row[0] * 0.82 / 4, a = row[1] * Math.PI / 180, rx = 0.82 * Math.sin(a), ry = 0.82 * Math.cos(a);
      if (Math.abs(row[0]) < 4 || row[0] === 4) add('circle', { cx: 0, cy: -midY, r: 0.034, class: 'lh-mid' });
      for (var i = 1; i <= row[2]; i++) {
        var t = row[2] === 1 ? 1 : i / row[2], y = -(midY + (ry - midY) * t * t);
        add('circle', { cx: -rx * t, cy: y, r: 0.04, class: 'lh-l' });
        add('circle', { cx: rx * t, cy: y, r: 0.04, class: 'lh-r' });
      }
    });
  })();

  // ───────────── 启动 ─────────────
  var saved = readSession();
  if (saved && window.crypto && crypto.subtle) {
    openSession(saved).then(enterApp, function () {
      clearSession();
      state.key = state.profile = state.manifest = null; state.keys = {};
      showLogin('登录已失效（站点内容或权限更新过），请重新登录。');
    });
  } else {
    showLogin('');
  }
})();
