(function () {
  'use strict';

  const bootEl = document.getElementById('boot');
  const appRoot = document.getElementById('root') || (() => {
    const el = document.createElement('div');
    el.setAttribute('id', 'root');
    if (document.body && document.body.appendChild) {
      document.body.appendChild(el);
    }
    return el;
  })();

  function fail(message) {
    bootEl.textContent = '启动失败：\n\n' + message;
    bootEl.className = 'boot-inner error';
  }

  function log(level, args) {
    const fn = window.console[level] || window.console.log;
    try {
      fn.apply(window.console, args);
    } catch (err) {
      // console shims are optional in odd embeds
    }
  }

  const appInstance = { globalData: {} };
  let pageDefinition = null;
  let pageInstance = null;

  const moduleCache = new Map();
  const bundleMap = window.__WX_BUNDLE || {};

  function resolvePath(baseDir, relPath) {
    const parts = baseDir.split('/').filter(Boolean);
    const rel = relPath.split('/');
    for (const seg of rel) {
      if (seg === '.' || seg === '') {
        continue;
      }
      if (seg === '..') {
        parts.pop();
      } else {
        parts.push(seg);
      }
    }
    return parts.join('/');
  }

  function dirOf(path) {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i) : '';
  }

  function requireModule(relPath, fromPath) {
    const normalized = resolvePath(dirOf(fromPath), relPath);
    if (moduleCache.has(normalized)) {
      return moduleCache.get(normalized).exports;
    }
    const source = bundleMap[normalized + '.js'] || '';
    if (!source) {
      throw new Error('打包中缺少模块：' + normalized + '.js');
    }
    const module = { exports: {} };
    moduleCache.set(normalized, module);
    const localRequire = (sub) => requireModule(sub, normalized);
    const fn = new Function(
      'module',
      'exports',
      'require',
      source + '\n//# sourceURL=weapp://' + normalized + '.js'
    );
    fn(module, module.exports, localRequire);
    return module.exports;
  }

  function Page(def) {
    pageDefinition = def;
  }

  function getPage() {
    return pageInstance;
  }

  function App(def) {
    Object.assign(appInstance, def);
    if (typeof def.onLaunch === 'function') {
      def.onLaunch.call(appInstance);
    }
  }

  function getApp() {
    return appInstance;
  }

  function showModal(options) {
    const dlg = document.createElement('div');
    dlg.className = 'wx-modal-backdrop';
    const card = document.createElement('div');
    card.className = 'wx-modal-card';
    const title = document.createElement('div');
    title.className = 'wx-modal-title';
    title.textContent = options.title || '';
    const content = document.createElement('div');
    content.className = 'wx-modal-content';
    content.textContent = options.content || '';
    const buttons = document.createElement('div');
    buttons.className = 'wx-modal-buttons';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'wx-modal-cancel';
    cancelBtn.textContent = options.cancelText || '取消';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'wx-modal-ok';
    okBtn.textContent = options.confirmText || '确定';
    okBtn.style.color = options.confirmColor || '#2f9d8a';
    if (options.showCancel === false) {
      cancelBtn.style.display = 'none';
    }
    buttons.appendChild(cancelBtn);
    buttons.appendChild(okBtn);
    card.appendChild(title);
    card.appendChild(content);
    card.appendChild(buttons);
    dlg.appendChild(card);
    const close = (confirm) => {
      dlg.remove();
      if (options.success) {
        options.success({ confirm, cancel: !confirm });
      }
    };
    okBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    document.body.appendChild(dlg);
  }

  const storage = (function () {
    let mem = {};
    const resetMode = /[?&]reset=1/.test(window.location.search);
    const freshId = () =>
      '散修' + Math.random().toString(36).slice(2, 8).toUpperCase();
    try {
      if (!resetMode) {
        const raw = localStorage.getItem('weapp_storage_v1');
        if (raw) {
          mem = JSON.parse(raw);
        }
      }
      if (!mem.playerId) {
        mem.playerId = freshId();
        mem.playerName = '无名散修';
        try {
          localStorage.setItem('weapp_storage_v1', JSON.stringify(mem));
        } catch (err) {
          // storage can be unavailable in private browsing; memory still works
        }
      }
    } catch (err) {
      mem = {};
    }
    return {
      get(key) {
        return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : '';
      },
      set(key, value) {
        mem[key] = value;
        try {
          localStorage.setItem('weapp_storage_v1', JSON.stringify(mem));
        } catch (err) {
          // storage can be unavailable in private browsing; memory still works
        }
      }
    };
  })();

  window.wx = {
    getStorageSync(key) {
      return storage.get(key);
    },
    setStorageSync(key, value) {
      storage.set(key, value);
    },
    getAccountInfoSync() {
      return {
        miniProgram: {
          appId: 'web-xiuxian-sou-da-che'
        }
      };
    },
    showModal
  };
  window.__WX_DEBUG__ = {
    get page() {
      return getPage();
    }
  };

  const EXPR_CACHE = new Map();

  function evalExpr(expr, scope) {
    let trimmed = expr.trim();
    if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
      trimmed = trimmed.slice(2, -2).trim();
    }
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      try {
        return evalExpr(trimmed.slice(1, -1), scope);
      } catch (err) {
        // fall through to the cached function below
      }
    }
    if (trimmed === 'true') {
      return true;
    }
    if (trimmed === 'false') {
      return false;
    }
    let fn = EXPR_CACHE.get(trimmed);
    if (!fn) {
      try {
        fn = new Function('scope', 'with (scope) { return (' + trimmed + '); }');
        EXPR_CACHE.set(trimmed, fn);
      } catch (err) {
        return undefined;
      }
    }
    try {
      return fn(scope);
    } catch (err) {
      return undefined;
    }
  }

  function textValue(scope, raw) {
    return raw.replace(/\{\{([\s\S]*?)\}\}/g, (match, expr) => {
      const value = evalExpr(expr, scope);
      return value === undefined || value === null ? '' : String(value);
    });
  }

  function childText(scope, nodes) {
    return nodes
      .map((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        return textValue(scope, node.nodeValue);
      }
        if (node.nodeType === Node.ELEMENT_NODE && node.tagName.toLowerCase() === 'text') {
          return textValue(scope, node.textContent);
        }
        return '';
      })
      .join('');
  }

  function makeScope(parent, extra) {
    const scope = Object.create(parent);
    if (extra) {
      Object.assign(scope, extra);
    }
    return scope;
  }

  const TAG_MAP = {
    view: 'div',
    text: 'span',
    button: 'button',
    'scroll-view': 'div',
    image: 'img',
    img: 'img',
    input: 'input',
    b: 'b',
    block: null
  };

  const EVENT_ATTRS = [
    { wx: 'bindtap', dom: 'click' },
    { wx: 'catchtap', dom: 'click', stop: true },
    { wx: 'bindinput', dom: 'input' },
    { wx: 'bindchange', dom: 'change' },
    { wx: 'bindconfirm', dom: 'change' },
    { wx: 'bindscroll', dom: 'scroll' },
    { wx: 'bindlongpress', dom: 'contextmenu' },
    { wx: 'bindtouchstart', dom: 'touchstart' },
    { wx: 'bindtouchmove', dom: 'touchmove' },
    { wx: 'bindtouchend', dom: 'touchend' },
    { wx: 'catchtouchmove', dom: 'touchmove', stop: true }
  ];

  function isEventAttr(name) {
    return EVENT_ATTRS.some((entry) => entry.wx === name);
  }

  function boolAttrValue(scope, value) {
    const v = textValue(scope, value);
    return v !== '' && v !== 'false' && v !== '0';
  }

  function findCondChain(nodes, index) {
    let cursor = index;
    const chain = [];
    while (cursor < nodes.length) {
      const node = nodes[cursor];
      if (node.nodeType === Node.ELEMENT_NODE) {
        const attrs = node.attributes;
        const mode = attrs.getNamedItem('wx:if')
          ? 'if'
          : attrs.getNamedItem('wx:elif')
            ? 'elif'
            : attrs.getNamedItem('wx:else')
              ? 'else'
              : null;
        if (!mode || (chain.length === 0 && mode !== 'if')) {
          break;
        }
        if (chain.length > 0 && (mode === 'if' || chain[chain.length - 1].mode === 'else')) {
          break;
        }
        chain.push({ node, mode });
        cursor += 1;
        if (mode === 'else') {
          break;
        }
        continue;
      }
      // Whitespace text nodes between wx:if/wx:elif/wx:else stay in the chain.
      if (chain.length === 0) {
        break;
      }
      cursor += 1;
    }
    return chain;
  }

  function attachEvent(el, wxName, handlerName, stop, page) {
    const entry = EVENT_ATTRS.find((item) => item.wx === wxName);
    if (!entry) {
      return;
    }
    el.addEventListener(entry.dom, (ev) => {
      if (stop) {
        ev.stopPropagation();
      }
      if (entry.dom === 'click') {
        ev.preventDefault();
      }
      const detail =
        entry.dom === 'input' || entry.dom === 'change'
          ? { value: ev.target.value }
          : ev.detail || {};
      const dataset = el.__wxDataset || {};
      const handler = page[handlerName];
      if (typeof handler === 'function') {
        handler.call(page, {
          currentTarget: { dataset, id: el.id || '' },
          target: { dataset },
          detail
        });
      }
    });
  }

  let templateIdSeed = 0;
  function templateIdOf(node) {
    if (!node.__tid) {
      node.__tid = ++templateIdSeed;
    }
    return node.__tid;
  }

  function appendLoopPath(ctx, node, index) {
    const part = templateIdOf(node) + ':' + index;
    return ctx.path ? ctx.path + '/' + part : part;
  }

  function makeKey(kind, node, ctx) {
    return kind + templateIdOf(node) + (ctx.path ? ':' + ctx.path : '');
  }

  function buildElementVNode(node, scope, ctx) {
    const tag = node.tagName.toLowerCase();
    const vnode = {
      key: makeKey('e', node, ctx),
      type: 'element',
      node,
      tag,
      attrs: Array.from(node.attributes),
      scope,
      dataset: {},
      children: []
    };
    if (tag === 'text') {
      vnode.textElement = true;
    } else if (node.childNodes.length > 0) {
      vnode.children = buildVNodes(Array.from(node.childNodes), scope, ctx);
    }
    return vnode;
  }

  function buildVNodes(nodes, scope, ctx) {
    const out = [];
    let cursor = 0;
    while (cursor < nodes.length) {
      const node = nodes[cursor];
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.nodeValue;
        if (text && text.trim()) {
          out.push({
            key: makeKey('t', node, ctx),
            type: 'text',
            raw: text,
            scope
          });
        }
        cursor += 1;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        cursor += 1;
        continue;
      }

      const condMode = node.attributes.getNamedItem('wx:if')
        ? 'if'
        : node.attributes.getNamedItem('wx:elif')
          ? 'elif'
          : node.attributes.getNamedItem('wx:else')
            ? 'else'
            : null;
      if (condMode) {
        const chain = findCondChain(nodes, cursor);
        let chosen = null;
        for (const item of chain) {
          if (item.mode === 'else') {
            chosen = item;
            break;
          }
          const expr = item.node.attributes.getNamedItem(
            item.mode === 'if' ? 'wx:if' : 'wx:elif'
          ).value;
          if (evalExpr(expr, scope)) {
            chosen = item;
            break;
          }
        }
        if (chosen) {
          const tag = chosen.node.tagName.toLowerCase();
          if (TAG_MAP[tag] === null) {
            out.push(...buildVNodes(Array.from(chosen.node.childNodes), scope, ctx));
          } else {
            out.push(buildElementVNode(chosen.node, scope, ctx));
          }
        }
        cursor += Math.max(1, chain.length);
        continue;
      }

      const forExpr = node.attributes.getNamedItem('wx:for');
      if (forExpr) {
        const list = evalExpr(forExpr.value, scope);
        if (Array.isArray(list) || (list && typeof list.length === 'number')) {
          const itemName = (node.attributes.getNamedItem('wx:for-item') || {}).value || 'item';
          const indexName = (node.attributes.getNamedItem('wx:for-index') || {}).value || 'index';
          const tag = node.tagName.toLowerCase();
          for (let i = 0; i < list.length; i += 1) {
            const loopScope = makeScope(scope, {});
            loopScope[itemName] = list[i];
            loopScope[indexName] = i;
            const loopCtx = { path: appendLoopPath(ctx, node, i) };
            if (TAG_MAP[tag] === null) {
              out.push(...buildVNodes(Array.from(node.childNodes), loopScope, loopCtx));
            } else {
              out.push(buildElementVNode(node, loopScope, loopCtx));
            }
          }
        }
        cursor += 1;
        continue;
      }

      const tag = node.tagName.toLowerCase();
      if (TAG_MAP[tag] === null) {
        out.push(...buildVNodes(Array.from(node.childNodes), scope, ctx));
        cursor += 1;
        continue;
      }
      if (!TAG_MAP[tag]) {
        console.warn('未支持的小程序标签：', tag);
        cursor += 1;
        continue;
      }
      out.push(buildElementVNode(node, scope, ctx));
      cursor += 1;
    }
    return out;
  }

  function syncElement(el, vnode, page, first) {
    const dataset = {};
    for (const attr of vnode.attrs) {
      const name = attr.name;
      if (isEventAttr(name) || name === 'wx:if' || name === 'wx:elif' || name === 'wx:else' ||
          name === 'wx:for' || name === 'wx:for-item' || name === 'wx:for-index' || name === 'wx:key') {
        continue;
      }
      if (name.startsWith('data-')) {
        const dataName = name.slice(5).replace(/-([a-z])/g, (m, ch) => ch.toUpperCase());
        const value = attr.value.trim();
        dataset[dataName] = value.startsWith('{{') && value.endsWith('}}')
          ? evalExpr(value, vnode.scope)
          : textValue(vnode.scope, attr.value);
        const next = dataset[dataName] == null ? '' : String(dataset[dataName]);
        if (el.getAttribute(name) !== next) {
          el.setAttribute(name, next);
        }
        continue;
      }
      if (name === 'hover-class') {
        el.classList.add('wx-hoverable');
        el.dataset.hoverClass = attr.value;
        continue;
      }
      if (name === 'scroll-y' || name === 'scroll-x') {
        el.setAttribute(name, '');
        continue;
      }
      if (name === 'class') {
        const cls = textValue(vnode.scope, attr.value).trim();
        if (el.className !== cls) {
          el.className = cls;
        }
        continue;
      }
      if (name === 'style') {
        const style = textValue(vnode.scope, attr.value);
        if (el.getAttribute('style') !== style) {
          el.setAttribute('style', style);
        }
        continue;
      }
      if (name === 'id') {
        const id = textValue(vnode.scope, attr.value);
        if (el.id !== id) {
          el.id = id;
        }
        continue;
      }
      if (name === 'hidden') {
        el.hidden = boolAttrValue(vnode.scope, attr.value);
        continue;
      }
      if (name === 'disabled') {
        if (boolAttrValue(vnode.scope, attr.value)) {
          el.setAttribute('disabled', '');
        } else {
          el.removeAttribute('disabled');
        }
        continue;
      }
      if (name === 'src') {
        const rawSrc = textValue(vnode.scope, attr.value);
        const next = rawSrc.replace(/^(?:\.\.\/)+assets\//, './assets/');
        if (el.hasAttribute('data-src-fallback')) {
          el.removeAttribute('data-src-fallback');
        }
        if (el.getAttribute('src') !== next) {
          el.setAttribute('src', next);
        }
        continue;
      }
      if (name === 'placeholder') {
        const value = textValue(vnode.scope, attr.value);
        if (el.getAttribute(name) !== value) {
          el.setAttribute(name, value);
        }
        continue;
      }
      if (name === 'value') {
        const value = textValue(vnode.scope, attr.value);
        if (el.value !== value) {
          el.value = value;
        }
        continue;
      }
      const value = textValue(vnode.scope, attr.value);
      if (el.getAttribute(name) !== value) {
        el.setAttribute(name, value);
      }
    }
    el.__wxDataset = dataset;
    if (!el.__wxEventBound && page) {
      el.__wxEventBound = true;
      for (const attr of vnode.attrs) {
        if (isEventAttr(attr.name)) {
          const stop = EVENT_ATTRS.find((item) => item.wx === attr.name).stop;
          attachEvent(el, attr.name, attr.value, stop, page);
        }
      }
    }
  }

  function patchVNodeList(container, oldVNodes, newVNodes, page) {
    const newKeys = new Set(newVNodes.map((vnode) => vnode.key));
    const remaining = [];
    for (const oldVNode of oldVNodes || []) {
      if (newKeys.has(oldVNode.key)) {
        remaining.push(oldVNode);
      } else {
        oldVNode.dom && oldVNode.dom.remove();
      }
    }
    let cursor = 0;
    for (const newVNode of newVNodes) {
      if (cursor < remaining.length && remaining[cursor].key === newVNode.key) {
        const oldVNode = remaining[cursor];
        newVNode.dom = oldVNode.dom;
        patchVNode(oldVNode, newVNode, page);
        cursor += 1;
        continue;
      }
      const matchIndex = remaining.findIndex((vnode, i) => i >= cursor && vnode.key === newVNode.key);
      const anchor = cursor < remaining.length ? remaining[cursor].dom : null;
      if (matchIndex >= 0) {
        const oldVNode = remaining[matchIndex];
        remaining.splice(matchIndex, 1);
        container.insertBefore(oldVNode.dom, anchor);
        newVNode.dom = oldVNode.dom;
        patchVNode(oldVNode, newVNode, page);
      } else {
        const dom = createVNodeDom(newVNode, page);
        newVNode.dom = dom;
        container.insertBefore(dom, anchor);
      }
    }
    for (let i = cursor; i < remaining.length; i += 1) {
      remaining[i].dom && remaining[i].dom.remove();
    }
  }

  function patchVNode(oldVNode, newVNode, page) {
    if (newVNode.type === 'text') {
      const text = textValue(newVNode.scope, newVNode.raw);
      if (oldVNode.dom.nodeValue !== text) {
        oldVNode.dom.nodeValue = text;
      }
      return;
    }
    const el = oldVNode.dom;
    syncElement(el, newVNode, page, false);
    if (newVNode.textElement) {
      const text = childText(newVNode.scope, Array.from(newVNode.node.childNodes));
      if (el.textContent !== text) {
        el.textContent = text;
      }
      return;
    }
    patchVNodeList(el, oldVNode.children, newVNode.children, page);
  }

  function createVNodeDom(vnode, page) {
    if (vnode.type === 'text') {
      return document.createTextNode(textValue(vnode.scope, vnode.raw));
    }
    const el = document.createElement(TAG_MAP[vnode.tag]);
    el.dataset.wxTag = vnode.tag;
    syncElement(el, vnode, page, true);
    if (vnode.textElement) {
      el.textContent = childText(vnode.scope, Array.from(vnode.node.childNodes));
    } else {
      patchVNodeList(el, [], vnode.children, page);
    }
    return el;
  }

  function transformWxss(css) {
    const rpx = (value) => {
      const num = parseFloat(value);
      if (!Number.isFinite(num)) {
        return value;
      }
      const numText = Number.isInteger(num) ? String(num) : String(num);
      return 'calc(' + numText + ' * 100vw / 750)';
    };
    let out = css
      .replace(/(^|[,}\s])page([,{>\s])/g, '$1:root$2')
      .replace(/page([,{>\s])/g, ':root$1')
      .replace(/\bview\b/g, '[data-wx-tag="view"]')
      .replace(/\btext\b/g, '[data-wx-tag="text"]')
      .replace(/\bbutton(?=[,{>\s.#:[+~]|$)/g, '[data-wx-tag="button"]')
      .replace(/\bscroll-view\b/g, '[data-wx-tag="scroll-view"]')
      .replace(/url\(\s*'?\/assets\//g, "url('./assets/");
    out = out
      .replace(/(\d*\.?\d+)rpx/g, (match, num) => rpx(num))
      .replace(/(\d*\.?\d+)PX/g, (match, num) => rpx(num));
    out +=
      '\n\n[data-wx-tag="text"] { white-space: pre-wrap; }\n' +
      '[data-wx-tag="view"] { box-sizing: border-box; }\n' +
      '[data-wx-tag="button"] { box-sizing: border-box; font: inherit; margin: 0; padding: 0; }\n' +
      '.wx-hoverable { transition: opacity 0.12s ease, transform 0.12s ease; }\n' +
      '.wx-hoverable:active { opacity: 0.78; transform: scale(0.98); }\n' +
      '.wx-modal-backdrop { position: fixed; inset: 0; background: rgba(5, 8, 13, 0.72); ' +
      'display: flex; align-items: center; justify-content: center; z-index: 999; padding: 24px; }\n' +
      '.wx-modal-card { width: 100%; max-width: 560px; background: #1b2230; border: 1px solid rgba(213, 163, 74, 0.35); ' +
      'border-radius: 16px; color: #e9edf4; padding: 24px; box-shadow: 0 18px 50px rgba(0,0,0,0.45); }\n' +
      '.wx-modal-title { font-size: 19px; font-weight: 600; margin-bottom: 12px; }\n' +
      '.wx-modal-content { font-size: 15px; line-height: 1.6; color: #c7cedb; margin-bottom: 22px; }\n' +
      '.wx-modal-buttons { display: flex; justify-content: flex-end; gap: 12px; }\n' +
      '.wx-modal-buttons button { border: 1px solid rgba(255,255,255,0.16); background: transparent; color: #c7cedb; ' +
      'border-radius: 10px; padding: 9px 22px; font-size: 15px; }\n' +
      '.wx-modal-buttons .wx-modal-ok { border-color: transparent; background: #2f9d8a; color: #fff; }\n';
    return out;
  }

  async function boot() {
    try {
      const bundle = window.__WX_BUNDLE;
      if (!bundle || !bundle['pages/game/game.wxml']) {
        throw new Error('未找到 game.bundle.js，请先运行 web/build.js 生成打包文件。');
      }
      const wxmlSource = bundle['pages/game/game.wxml'];
      const wxssSource = bundle['pages/game/game.wxss'];
      const gameJs = bundle['pages/game/game.js'];
      const appJs = bundle['app.js'];

      const runApp = new Function(
        'wx',
        'App',
        'getApp',
        appJs + '\n//# sourceURL=weapp://app.js'
      );
      runApp(window.wx, App, getApp);

      const runPage = new Function(
        'wx',
        'Page',
        'getApp',
        'require',
        gameJs + '\n//# sourceURL=weapp://pages/game/game.js'
      );
      runPage(
        window.wx,
        Page,
        getApp,
        (rel) => requireModule(rel, 'pages/game/game.js')
      );

      if (!pageDefinition) {
        throw new Error('Page() 没有注册页面定义');
      }

      const styleEl = document.createElement('style');
      styleEl.textContent = transformWxss(wxssSource);
      document.head.appendChild(styleEl);

      const parser = new DOMParser();
      const templateDoc = parser.parseFromString(wxmlSource, 'text/html');
      const templateRoot = templateDoc.body;

      pageInstance = {
        ...pageDefinition,
        data: JSON.parse(JSON.stringify(pageDefinition.data || {})),
        __renderQueued: false,
        __vnodeList: [],
        setData(patch) {
          Object.assign(this.data, patch);
          if (this.__renderQueued) {
            return;
          }
          this.__renderQueued = true;
          setTimeout(() => {
            this.__renderQueued = false;
            this.__render();
          }, 0);
        },
        __scope: null,
        __render() {
          const scope = makeScope(null, this.data);
          this.__scope = scope;
          const next = buildVNodes(Array.from(templateRoot.childNodes), scope, { path: '' });
          patchVNodeList(appRoot, this.__vnodeList, next, this);
          this.__vnodeList = next;
        }
      };
      Object.keys(pageDefinition).forEach((key) => {
        if (key !== 'data' && key !== 'setData') {
          pageInstance[key] = pageDefinition[key];
        }
      });
      pageInstance.__render();
      bootEl.remove();
      if (typeof pageInstance.onLoad === 'function') {
        pageInstance.onLoad.call(pageInstance);
      }
      if (typeof pageInstance.onShow === 'function') {
        pageInstance.onShow.call(pageInstance);
      }
    } catch (err) {
      fail(err && err.stack ? err.stack : String(err));
      console.error(err);
    }
  }

  boot();
})();


