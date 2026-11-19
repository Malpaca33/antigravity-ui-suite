import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  createWindowBridgeController,
  isAllowedBridgeOrigin,
  isAntigravityMainPageTarget,
  parseDevToolsPortFile,
  resolveDevToolsPortCandidates,
} from '../backend/window-bridge.mjs';
import { computeCapsuleLayoutMode } from '../src/components/layout/WindowOverlayShell.js';
import { backendHarness } from './backend-harness.mjs';

test('DevToolsActivePort parsing, cross-platform discovery, and strict target/origin filtering', () => {
  assert.equal(parseDevToolsPortFile('9222\n/devtools/browser/abc-123\n'), 9222);
  assert.equal(parseDevToolsPortFile('54321\r\n/devtools/browser/win'), 54321);
  assert.equal(parseDevToolsPortFile('0\n/devtools'), null);
  assert.equal(parseDevToolsPortFile('70000\n/devtools'), null);
  assert.equal(parseDevToolsPortFile('not-a-port'), null);

  const explicit = resolveDevToolsPortCandidates(
    { ANTIGRAVITY_DEVTOOLS_PORT_FILE: '/tmp/custom-port' },
    'win32',
    'C:\\Users\\Dev'
  );
  assert.deepEqual(explicit, ['/tmp/custom-port']);

  const winPaths = resolveDevToolsPortCandidates(
    { APPDATA: 'C:\\Roaming', LOCALAPPDATA: 'C:\\Local' },
    'win32',
    'C:\\Users\\Dev'
  );
  assert.equal(winPaths.length, 2);
  assert.ok(winPaths[0].includes('Roaming'));
  assert.ok(winPaths[1].includes('Local'));

  const macPaths = resolveDevToolsPortCandidates({}, 'darwin', '/Users/dev');
  assert.equal(macPaths[0], path.join('/Users/dev', 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'));

  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'https://127.0.0.1:51234/c/12345678-1234-1234-1234-123456789abc',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/main1',
    }),
    true
  );
  // Reject auxiliary webviews, non-HTTPS pages, and non-loopback debugger sockets
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'iframe',
      url: 'vscode-webview://panel/index.html',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/wv1',
    }),
    false
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'http://127.0.0.1:51234/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/http1',
    }),
    false
  );
  assert.equal(
    isAntigravityMainPageTarget({
      type: 'page',
      url: 'https://127.0.0.1:51234/',
      webSocketDebuggerUrl: 'ws://evil.example.com:9222/devtools/page/remote',
    }),
    false
  );

  assert.equal(isAllowedBridgeOrigin('https://127.0.0.1:58123'), true);
  assert.equal(isAllowedBridgeOrigin('https://localhost:58123'), true);
  assert.equal(isAllowedBridgeOrigin('http://127.0.0.1:58123'), false);
  assert.equal(isAllowedBridgeOrigin('https://example.com:58123'), false);
  assert.equal(isAllowedBridgeOrigin('vscode-webview://panel'), false);
});

test('Loopback HTTP bridge enforces Origin, Private Network CORS, token auth, and body limits', async () => {
  const receivedCalls = [];
  const controller = createWindowBridgeController({
    handleApiRequest: async (pathname, method, data) => {
      receivedCalls.push({ pathname, method, data });
      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, echoPath: pathname, echoData: data }),
      };
    },
    readAssetFn: async () => '',
    getSettingsFn: () => ({ enableWindowOverlay: true }),
    getBundleVersionFn: () => 'v1',
  });

  try {
    const { port, token } = await controller.ensureBridgeServer();
    assert.ok(port > 0);
    assert.equal(token.length, 64);

    const validOrigin = 'https://127.0.0.1:60123';

    // 1. Disallowed origin -> 403
    const badOriginRes = await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      headers: { Origin: 'https://evil.example', 'X-Usage-Monitor-Token': token },
    });
    assert.equal(badOriginRes.status, 403);

    // 2. OPTIONS preflight -> 204 with Private Network header (including Chromium cross-scheme Sec-Fetch-Site: cross-site)
    const rawCrossSchemePreflight = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/telemetry',
          method: 'OPTIONS',
          headers: {
            Origin: validOrigin,
            'Sec-Fetch-Site': 'cross-site',
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'x-usage-monitor-token',
          },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode, headers: res.headers });
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rawCrossSchemePreflight.status, 204);
    assert.equal(rawCrossSchemePreflight.headers['access-control-allow-origin'], validOrigin);
    assert.equal(rawCrossSchemePreflight.headers['access-control-allow-private-network'], 'true');

    const rawCrossSchemeGetStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/telemetry?conversationId=conv-sec&range=today',
          method: 'GET',
          headers: {
            Origin: validOrigin,
            'Sec-Fetch-Site': 'cross-site',
            'X-Usage-Monitor-Token': token,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rawCrossSchemeGetStatus, 200);

    // 3. Invalid token -> 403
    const badTokenRes = await fetch(`http://127.0.0.1:${port}/api/telemetry`, {
      headers: { Origin: validOrigin, 'X-Usage-Monitor-Token': 'wrong-token' },
    });
    assert.equal(badTokenRes.status, 403);

    // 4. Valid GET /api/telemetry -> 200
    const okGetRes = await fetch(
      `http://127.0.0.1:${port}/api/telemetry?conversationId=conv-1&range=today`,
      {
        headers: { Origin: validOrigin, 'X-Usage-Monitor-Token': token },
      }
    );
    assert.equal(okGetRes.status, 200);
    const getBody = await okGetRes.json();
    assert.equal(getBody.ok, true);
    assert.equal(getBody.echoData.conversationId, 'conv-1');
    assert.equal(getBody.echoData.range, 'today');

    // 5. Valid POST /api/settings -> 200
    const okPostRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: {
        Origin: validOrigin,
        'Content-Type': 'application/json',
        'X-Usage-Monitor-Token': token,
      },
      body: JSON.stringify({ enableWindowOverlay: false }),
    });
    assert.equal(okPostRes.status, 200);
    const postBody = await okPostRes.json();
    assert.equal(postBody.echoData.enableWindowOverlay, false);
    assert.equal(receivedCalls.length, 3);

    // 6. Oversized POST body -> 413
    const hugePayload = JSON.stringify({ pad: 'x'.repeat(70 * 1024) });
    const hugeRes = await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: {
        Origin: validOrigin,
        'Content-Type': 'application/json',
        'X-Usage-Monitor-Token': token,
      },
      body: hugePayload,
    }).catch(() => ({ status: 413 }));
    assert.equal(hugeRes.status, 413);
  } finally {
    await controller.stop();
  }
});

test('CDP multi-window sync injects, skips healthy windows, hot-upgrades on version bump, and cleans up on disable', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-wm-cdp-test-'));
  const portFile = path.join(tmpDir, 'DevToolsActivePort');

  // Simulated VM contexts for two open Antigravity windows
  const windowContexts = new Map();
  for (const id of ['win1', 'win2']) {
    const winObj = {};
    winObj.window = winObj;
    winObj.globalThis = winObj;
    windowContexts.set(id, vm.createContext(winObj));
  }

  let injectEvalCount = 0;

  class MockCdpWebSocket {
    constructor(url) {
      this.url = url;
      this.targetId = url.split('/').pop();
      this.listeners = new Map();
      queueMicrotask(() => this._emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      if (msg.method === 'Runtime.evaluate') {
        const expr = msg.params.expression;
        if (expr.includes('__AGUsageMonitorBridge =')) {
          injectEvalCount += 1;
        }
        const ctx = windowContexts.get(this.targetId);
        const value = vm.runInContext(expr, ctx);
        queueMicrotask(() =>
          this._emit('message', {
            data: JSON.stringify({ id: msg.id, result: { result: { value } } }),
          })
        );
      }
    }
    close() {}
    _emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
  }

  const cdpHttpServer = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const cdpPort = cdpHttpServer.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            type: 'page',
            url: 'https://127.0.0.1:61001/c/11111111-1111-1111-1111-111111111111',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/win1`,
          },
          {
            type: 'page',
            url: 'https://127.0.0.1:61002/c/22222222-2222-2222-2222-222222222222',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/win2`,
          },
          {
            type: 'iframe',
            url: 'vscode-webview://aux-pane/index.html',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/page/ignored`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => cdpHttpServer.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(portFile, `${cdpHttpServer.address().port}\n/devtools/browser/mock`, 'utf8');

  let overlayEnabled = true;
  let currentVer = 'bundle-v1';

  const mockAppJs = `
    (() => {
      window.__AGUsageMonitorOverlay?.dispose?.();
      const br = window.__AGUsageMonitorBridge;
      let alive = true;
      window.__AGUsageMonitorOverlay = {
        bundleVersion: br.bundleVersion,
        ensureAlive: () => alive,
        dispose: () => { alive = false; },
      };
    })();
  `;

  const controller = createWindowBridgeController({
    handleApiRequest: async () => ({ status: 200, body: '{}' }),
    readAssetFn: async (rel) => (rel === 'styles.css' ? ':host{}' : mockAppJs),
    getSettingsFn: () => ({ enableWindowOverlay: overlayEnabled }),
    getBundleVersionFn: () => currentVer,
    env: { ANTIGRAVITY_DEVTOOLS_PORT_FILE: portFile },
    WebSocketImpl: MockCdpWebSocket,
  });

  try {
    // 1. Initial sync mounts onto both main windows and ignores the webview
    const first = await controller.syncAllWindows();
    assert.equal(first.ok, true);
    assert.equal(first.targets, 2);
    assert.equal(first.injected, 2);
    assert.equal(first.aliveCount, 2);
    assert.equal(injectEvalCount, 2);

    // 2. Subsequent poll sees matching bundleVersion & port -> 0 re-injections
    const second = await controller.syncAllWindows();
    assert.equal(second.injected, 0);
    assert.equal(second.aliveCount, 2);
    assert.equal(injectEvalCount, 2);

    // 3. Hot bundle update triggers seamless re-injection on both windows
    currentVer = 'bundle-v2';
    const upgraded = await controller.syncAllWindows();
    assert.equal(upgraded.injected, 2);
    assert.equal(upgraded.aliveCount, 2);
    assert.equal(windowContexts.get('win1').__AGUsageMonitorOverlay.bundleVersion, 'bundle-v2');
    assert.equal(windowContexts.get('win2').__AGUsageMonitorOverlay.bundleVersion, 'bundle-v2');

    // 4. Disabling enableWindowOverlay disposes and removes globals from all windows
    overlayEnabled = false;
    const disabled = await controller.notifySettingChanged(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.removed, 2);
    assert.equal(windowContexts.get('win1').__AGUsageMonitorOverlay, undefined);
    assert.equal(windowContexts.get('win1').__AGUsageMonitorBridge, undefined);
  } finally {
    await controller.stop();
    await new Promise((resolve) => cdpHttpServer.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Capsule 4-stage responsive hysteresis and backend settings default/override', async () => {
  // Hysteresis stability check for dual-capsule topbar layout (multiBtn + capsuleBtn)
  let mode = computeCapsuleLayoutMode(300, 'wide');
  assert.equal(mode, 'wide');
  mode = computeCapsuleLayoutMode(240, mode);
  assert.equal(mode, 'compact');
  // At 265px (< 272px restore threshold), stays compact instead of flickering back to wide
  mode = computeCapsuleLayoutMode(265, mode);
  assert.equal(mode, 'compact');
  mode = computeCapsuleLayoutMode(280, mode);
  assert.equal(mode, 'wide');
  mode = computeCapsuleLayoutMode(150, mode);
  assert.equal(mode, 'minimal');
  mode = computeCapsuleLayoutMode(70, mode);
  assert.equal(mode, 'ring-only');
  mode = computeCapsuleLayoutMode(85, mode);
  assert.equal(mode, 'ring-only');
  mode = computeCapsuleLayoutMode(96, mode);
  assert.equal(mode, 'minimal');

  // Single-capsule mode (showMulti: false) grants ~76px extra breathing room before collapsing
  assert.equal(computeCapsuleLayoutMode(200, 'wide', { showMulti: false }), 'wide');
  assert.equal(computeCapsuleLayoutMode(150, 'wide', { showMulti: false }), 'compact');

  // Backend harness verifies enableWindowOverlay, showTopbarMultiSession, and topbarCapsuleSlots defaults & normalization
  const defaultEnv = backendHarness({ settings: {} });
  const defaultPayload = await defaultEnv.buildTelemetryPayloadInternal('', false, {});
  assert.equal(defaultPayload.settings.enableWindowOverlay, true);
  assert.equal(defaultPayload.settings.showTopbarMultiSession, true);
  assert.deepEqual(Array.from(defaultPayload.settings.topbarCapsuleSlots), [
    'context',
    'tps',
    'quota_auto',
  ]);

  const disabledEnv = backendHarness({
    settings: {
      enableWindowOverlay: false,
      showTopbarMultiSession: false,
      topbarCapsuleSlots: ['gemini_5h', 'ttft', 'claude_weekly'],
    },
  });
  const disabledPayload = await disabledEnv.buildTelemetryPayloadInternal('', false, {});
  assert.equal(disabledPayload.settings.enableWindowOverlay, false);
  assert.equal(disabledPayload.settings.showTopbarMultiSession, false);
  assert.deepEqual(Array.from(disabledPayload.settings.topbarCapsuleSlots), [
    'gemini_5h',
    'ttft',
    'claude_weekly',
  ]);

  const allNoneEnv = backendHarness({
    settings: { topbarCapsuleSlots: ['none', 'none', 'none'] },
  });
  const allNonePayload = await allNoneEnv.buildTelemetryPayloadInternal('', false, {});
  assert.deepEqual(Array.from(allNonePayload.settings.topbarCapsuleSlots), [
    'context',
    'none',
    'none',
  ]);
});

test('Compiled app.js mounts dual Shadow DOM hosts, tracks /c/<uuid> routes, protects host reload, and supports composedPath()', async () => {
  const appJsPath = new URL('../app.js', import.meta.url);
  const stylesCssPath = new URL('../styles.css', import.meta.url);
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const stylesCss = fs.readFileSync(stylesCssPath, 'utf8');

  // Minimal DOM mock supporting ShadowRoot, querySelector, attributes, classes, and composedPath
  class MockNode {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.className = '';
      this.textContent = '';
      this.style = {
        _vars: new Map(),
        setProperty(k, v) { this._vars.set(k, String(v)); },
        getPropertyValue(k) { return this._vars.get(k) || ''; },
      };
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.shadowRoot = null;
      this._listeners = new Map();
      const self = this;
      this.classList = {
        _set() {
          return new Set(String(self.className || '').split(/\s+/).filter(Boolean));
        },
        add(...tokens) {
          const s = this._set();
          for (const t of tokens) if (t) s.add(t);
          self.className = Array.from(s).join(' ');
        },
        contains(tok) {
          return this._set().has(tok);
        },
        toggle(tok, force) {
          const s = this._set();
          const should = force === undefined ? !s.has(tok) : Boolean(force);
          if (should) s.add(tok);
          else s.delete(tok);
          self.className = Array.from(s).join(' ');
        },
      };
    }
    get parentElement() { return this.parentNode; }
    get firstChild() { return this.children[0] || null; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { return this.children[this.children.length - 1] || null; }
    get isConnected() {
      let cur = this;
      while (cur) {
        if (cur.isDocumentRoot) return true;
        cur = cur.parentNode || cur.host || null;
      }
      return false;
    }
    setAttribute(k, v) {
      const s = String(v);
      this.attributes.set(k, s);
      if (k === 'id') this.id = s;
      if (k === 'class') this.className = s;
    }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    hasAttribute(k) { return this.attributes.has(k); }
    removeAttribute(k) { this.attributes.delete(k); }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    insertBefore(node, refNode) {
      if (!refNode) return this.appendChild(node);
      if (node.parentNode) node.parentNode.removeChild(node);
      const idx = this.children.indexOf(refNode);
      node.parentNode = this;
      if (idx < 0) this.children.push(node);
      else this.children.splice(idx, 0, node);
      return node;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    attachShadow() {
      const sr = new MockNode('#shadow-root');
      sr.host = this;
      this.shadowRoot = sr;
      return sr;
    }
    contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners.get(type);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    }
    dispatchEvent(ev) {
      for (const fn of [...(this._listeners.get(ev.type) || [])]) fn(ev);
    }
    getBoundingClientRect() {
      return { left: 900, right: 1080, top: 6, bottom: 32, width: 180, height: 26 };
    }
    querySelector(sel) {
      if (sel === ':scope > div.shrink-0') {
        return this.children.find((c) => c.classList.contains('shrink-0')) || null;
      }
      return this._find((n) => {
        if (sel === '[class*="@container/titlebar"]') {
          return String(n.className || '').includes('@container/titlebar');
        }
        if (sel.startsWith('.')) {
          return n.classList.contains(sel.slice(1));
        }
        return false;
      });
    }
    querySelectorAll(sel) {
      const s = String(sel || '').trim();
      if (!s || s.includes(',')) return [];
      if (s.includes(' ')) {
        const [first, ...rest] = s.split(/\s+/);
        const roots = this.querySelectorAll(first);
        const out = [];
        for (const r of roots) {
          for (const item of r.querySelectorAll(rest.join(' '))) {
            if (!out.includes(item)) out.push(item);
          }
        }
        return out;
      }
      if (!s.startsWith('.')) return [];
      const cls = s.slice(1);
      const out = [];
      const walk = (node) => {
        for (const c of node.children) {
          if (c.classList.contains(cls)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    _find(pred) {
      for (const c of this.children) {
        if (pred(c)) return c;
        const hit = c._find(pred);
        if (hit) return hit;
      }
      return null;
    }
  }

  const docRoot = new MockNode('html');
  docRoot.isDocumentRoot = true;
  const body = new MockNode('body');
  docRoot.appendChild(body);

  // Build simulated Antigravity titlebar
  const titlebar = new MockNode('div');
  titlebar.className = 'flex items-center @container/titlebar';
  const titleLeft = new MockNode('div');
  titleLeft.textContent = 'Chat Title';
  const titleRight = new MockNode('div');
  titleRight.className = 'shrink-0 flex items-center';
  const nativeBtn = new MockNode('button');
  titleRight.appendChild(nativeBtn);
  titlebar.appendChild(titleLeft);
  titlebar.appendChild(titleRight);
  body.appendChild(titlebar);

  let reloadCalled = false;
  let currentBundleVer = 'ver-100';
  const fetchedUrls = [];
  const fetchedHeaders = [];

  const docListeners = new Map();
  const winListeners = new Map();

  const mockDocument = {
    readyState: 'complete',
    hidden: false,
    documentElement: docRoot,
    body,
    createElement: (tag) => new MockNode(tag),
    createElementNS: (_ns, tag) => new MockNode(tag),
    createTextNode: (txt) => {
      const t = new MockNode('#text');
      t.textContent = String(txt);
      return t;
    },
    getElementById: (id) => docRoot._find((n) => n.id === id),
    querySelector: (sel) => docRoot.querySelector(sel),
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = docListeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
  };

  const mockLocation = {
    pathname: '/c/aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    reload() {
      reloadCalled = true;
    },
  };

  const mockSettings = {
    weeklyLimitMode: 'official',
    weeklyTokenBudget: 150000000,
    weeklyCostBudget: 100,
    showUpstreamModel: false,
    autoUpdatePlugin: false,
    enableWindowOverlay: true,
    showTopbarMultiSession: true,
    topbarCapsuleSlots: ['context', 'tps', 'quota_auto'],
  };

  const mockWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    location: mockLocation,
    document: mockDocument,
    __AGUsageMonitorBridge: {
      port: 49152,
      token: 'secret-bridge-token-123',
      bundleVersion: 'ver-100',
      stylesCss,
    },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = winListeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    getComputedStyle: () => ({ paddingRight: '8px', getPropertyValue: () => '' }),
    fetch: async (url, opts = {}) => {
      const urlStr = String(url);
      fetchedUrls.push(urlStr);
      fetchedHeaders.push(opts.headers || {});
      if (urlStr.includes('/api/settings') && String(opts.method || '').toUpperCase() === 'POST') {
        const patch = opts.body ? JSON.parse(opts.body) : {};
        Object.assign(mockSettings, patch);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...mockSettings }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          uiBundleVersion: currentBundleVer,
          settings: { ...mockSettings },
          cloudStatus: { updateAvailable: true, currentPluginVersion: '1.4.2', latestPluginVersion: '1.5.0' },
          account: { tierName: 'Google AI Ultra', planName: 'Pro', totalConversations: 5 },
          runningConversations: [
            {
              cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
              title: 'Dual Mode Session',
              isCurrentSelected: true,
              isMainRunning: true,
              isRunning: true,
              stepCount: 24,
              totalStepCount: 38,
              latestTokPerSec: 92.4,
              contextUsedPct: 50,
              mainActivity: {
                phase: 'tool',
                label: '执行命令',
                detail: 'rg -n ProtectedURLFilter',
                stepProgress: '1/2',
                startedAtMs: Date.now() - 12000,
                signature: 'tool:rg:1',
              },
              subagentCount: 1,
              runningSubagentCount: 1,
              subagents: [
                {
                  cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb:sub1',
                  index: 1,
                  badgeText: '子1',
                  shortLabel: '子代理 #1',
                  role: 'Auth Researcher',
                  isRunning: true,
                  stepCount: 14,
                  lastModifiedMs: Date.now() - 8000,
                  liveActivity: {
                    phase: 'thinking',
                    label: '读取文件',
                    detail: 'MastLoginFilter.java',
                    stepProgress: '',
                    startedAtMs: Date.now() - 8000,
                    signature: 'sub1:read',
                  },
                },
              ],
            },
            {
              cascadeId: 'eeeeeeee-5555-6666-7777-ffffffffffff',
              title: 'Solo Refactor Task',
              isCurrentSelected: false,
              isMainRunning: true,
              isRunning: true,
              stepCount: 9,
              totalStepCount: 9,
              latestTokPerSec: 72.1,
              contextUsedPct: 21.0,
              mainActivity: {
                phase: 'thinking',
                label: '推理中',
                detail: '',
                stepProgress: '',
                startedAtMs: Date.now() - 4000,
                signature: 'solo:think',
              },
              subagentCount: 0,
              runningSubagentCount: 0,
              subagents: [],
            },
          ],
          conversations: [
            {
              cascadeId: 'bbbbbbbb-2222-3333-4444-cccccccccccc',
              title: 'Background Security Audit',
              stepCount: 24,
              subagentCount: 1,
              runningSubagentCount: 1,
              totalStepCount: 38,
              isRunning: true,
              contextUsedPct: 48.4,
              sessionCostUsd: 1.85,
              lastModifiedMs: Date.now() - 2000,
            },
            {
              cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
              title: 'Dual Mode Session',
              stepCount: 6,
              subagentCount: 0,
              totalStepCount: 6,
              isRunning: false,
              contextUsedPct: 50,
              sessionCostUsd: 7.3,
              lastModifiedMs: Date.now() - 180000,
            },
          ],
          activeConversation: {
            cascadeId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
            title: 'Dual Mode Session',
            isRunning: false,
            stepCount: 6,
            latestTokPerSec: 92.4,
            latestTtftSec: 0.85,
            avgTokPerSec: 88.2,
            latestStepCostUsd: 0.04,
            latestCacheHitPct: 98.7,
            sessionCostUsd: 7.3,
            activeModelShort: 'carbon-high',
            context: {
              totalTokens: 128000,
              compactionLimitTokens: 256000,
              limitTokens: 256000,
              toolResultsTokens: 76000,
              assistantTokens: 42000,
              userRulesTokens: 10000,
            },
            recentSteps: [],
          },
          consumption: {
            selectedRange: { key: 'today', label: '今天', startMs: 1, endMs: 2 },
            session: { totalTokens: 128000, costUsd: 0.42, unpricedCalls: 12 },
            account: { totalTokens: 500000, costUsd: 1.5, unpricedCalls: 3993 },
            trendSeries: [],
            monthlySeries: [],
          },
          quotas: {
            meta: { hasOfficialData: true },
            activePool: { family: 'Carbon', poolLabel: 'Carbon', remainingPct: 68, weeklyRemainingPct: 81 },
            pools: [
              {
                poolKey: 'Gemini',
                poolLabel: 'Gemini',
                remainingPct: 44,
                weeklyRemainingPct: 26,
              },
              {
                poolKey: 'Claude & GPT',
                poolLabel: 'Claude & GPT',
                remainingPct: 100,
                weeklyRemainingPct: 91,
              },
            ],
            weekly: { remainingPct: 81 },
          },
          modelBreakdown: [],
        }),
      };
    },
  };
  mockWindow.window = mockWindow;
  mockWindow.globalThis = mockWindow;

  const sandbox = vm.createContext({
    window: mockWindow,
    globalThis: mockWindow,
    document: mockDocument,
    location: mockLocation,
    navigator: {},
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: mockWindow.fetch,
    console,
  });

  vm.runInContext(appJs, sandbox);
  await new Promise((r) => setTimeout(r, 40));

  try {
    const ov = mockWindow.__AGUsageMonitorOverlay;
    assert.ok(ov, 'Overlay handle should be registered on window');
    assert.equal(ov.ensureAlive(), true);

    const capsuleHost = mockDocument.getElementById('ag-usage-monitor-capsule');
    const portalHost = mockDocument.getElementById('ag-usage-monitor-portal');
    assert.ok(capsuleHost, 'Capsule host mounted');
    assert.ok(portalHost, 'Portal host mounted');
    assert.equal(capsuleHost.getAttribute('data-dock'), 'flow');
    assert.equal(capsuleHost.parentNode, titleRight);
    assert.equal(titleRight.firstChild, capsuleHost, 'Capsule inserted before native right buttons');

    // Verify authenticated bridge call & automatic /c/<uuid> route tracking
    assert.ok(fetchedUrls.length >= 1);
    assert.ok(fetchedUrls[0].startsWith('http://127.0.0.1:49152/api/telemetry?'));
    assert.ok(fetchedUrls[0].includes('conversationId=aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'));
    assert.equal(fetchedHeaders[0]['X-Usage-Monitor-Token'], 'secret-bridge-token-123');

    // Verify dual topbar buttons: left multi-session button (.wm-multi-btn) before right telemetry capsule (.wm-capsule-btn)
    const multiBtn = capsuleHost.shadowRoot.querySelector('.wm-multi-btn');
    const capsuleBtn = capsuleHost.shadowRoot.querySelector('.wm-capsule-btn');
    assert.ok(multiBtn, 'Left multi-session button mounted');
    assert.ok(capsuleBtn, 'Right telemetry capsule button mounted');
    assert.ok(
      capsuleHost.shadowRoot.children.indexOf(multiBtn) <
        capsuleHost.shadowRoot.children.indexOf(capsuleBtn),
      'Multi-session button sits immediately to the left of telemetry capsule'
    );
    assert.equal(multiBtn.querySelector('.svg-icon'), null, 'Multi-session button has zero SVG clutter');
    assert.equal(multiBtn.classList.contains('is-running'), true);
    const multiLabelEl = multiBtn.querySelector('.wm-multi-label');
    assert.equal(multiLabelEl.textContent, '1 子运行');

    // Verify capsule reactive UI (2x context ring + 50% / 256k sublabel, dot-matrix 92.4 t/s deep green tier + model sublabel, fixed-width 7-cell Mac battery + click pool toggle, left subagent panel openable, right capsule hover/click non-expanding)
    const ctxSegEl = capsuleHost.shadowRoot.querySelector('.wm-ctx-seg');
    const ctxRingSvg = ctxSegEl.querySelector('.wm-ring-svg');
    const ctxPctEl = capsuleHost.shadowRoot.querySelector('.wm-ctx-pct');
    const ctxLimitEl = capsuleHost.shadowRoot.querySelector('.wm-ctx-limit');
    const speedSegEl = capsuleHost.shadowRoot.querySelector('.wm-seg-speed');
    const quotaSegEl = capsuleHost.shadowRoot.querySelector('.wm-seg-quota');
    assert.equal(ctxRingSvg.getAttribute('viewBox'), '0 0 26 26', 'Context ring expanded to 2x radius viewBox');
    assert.equal(ctxRingSvg.children[0].getAttribute('r'), '10.4', 'Context ring radius doubled to 10.4');
    assert.equal(ctxPctEl.textContent, '50%');
    assert.equal(ctxLimitEl.textContent, '256k');
    assert.equal(speedSegEl.children.length, 2, 'Speed segment has dot-matrix speed row + compact model line');
    assert.equal(speedSegEl.querySelector('.svg-icon'), null);
    assert.equal(speedSegEl.classList.contains('speed-tier-green'), true, '92.4 t/s uses 46-100 green tier');
    assert.ok(speedSegEl.querySelector('.wm-speed-dot-svg').children.length > 0, 'Dot-matrix speed SVG rendered');
    assert.equal(speedSegEl.querySelector('.wm-speed-unit').textContent, 't/s');
    assert.ok(speedSegEl.querySelector('.wm-speed-text').textContent.includes('92.4 t/s'));
    assert.equal(speedSegEl.querySelector('.wm-speed-model').textContent, 'carbon-high');
    assert.ok(quotaSegEl.querySelector('.wm-bat-wrap'), 'Quota slot renders Mac battery widget instead of text');
    assert.equal(quotaSegEl.querySelectorAll('.wm-bat-cell').length, 7, 'Topbar Mac battery has 7 cells (~14% each)');
    assert.equal(quotaSegEl.getAttribute('data-pool'), 'gemini');
    assert.equal(quotaSegEl.querySelector('.wm-quota-pool-label').textContent, 'Gemini');
    assert.equal(quotaSegEl.getAttribute('data-5h-pct'), '44');
    assert.equal(quotaSegEl.getAttribute('data-weekly-pct'), '26');
    assert.equal(quotaSegEl.querySelector('.wm-bat-weekly-fill').attributes.get('stroke-dashoffset'), '74');
    assert.match(stylesCss, /\.wm-seg-quota\s*\{[^}]*width:\s*62px;/, 'Quota battery slot uses fixed width for zero click shift');
    assert.match(stylesCss, /\.wm-seg-speed\s*\{[^}]*width:\s*108px;/, 'Speed slot uses fixed width for zero live shift');
    assert.match(stylesCss, /\.wm-bat-cell-fill\s*\{[^}]*background:\s*#148838;/, 'Gemini battery cells use deeper truer green');
    assert.match(stylesCss, /\.wm-seg-speed\.speed-tier-low\s*\{\s*color:\s*var\(--text-primary\);/, 'Below 46 t/s tier uses crisp primary white');
    assert.match(stylesCss, /\.wm-seg-speed\.speed-tier-green\s*\{\s*color:\s*#148838;/, 'Speed green tier uses deeper truer green');
    assert.match(stylesCss, /\.wm-seg-speed\.speed-tier-orange\s*\{\s*color:\s*#c2410c;/, 'Speed orange tier uses deeper orange');
    assert.match(stylesCss, /\.wm-seg-speed\.speed-tier-purple\s*\{\s*color:\s*#7e22ce;/, 'Speed >=180 tier uses deeper purple');

    // Clicking capsuleBtn never expands the full popover; clicking battery swaps Gemini <-> Claude & GPT in-place
    capsuleBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isOpen(), false, 'Left-clicking topbar capsule never expands main popover panel');
    quotaSegEl.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isOpen(), false);
    assert.equal(quotaSegEl.getAttribute('data-pool'), 'claude');
    assert.equal(quotaSegEl.querySelector('.wm-quota-pool-label').textContent, 'Claude & GPT');
    assert.equal(quotaSegEl.getAttribute('data-5h-pct'), '100');
    assert.equal(quotaSegEl.getAttribute('data-weekly-pct'), '91');
    assert.equal(quotaSegEl.querySelector('.wm-bat-weekly-fill').attributes.get('stroke-dashoffset'), '9');
    quotaSegEl.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(quotaSegEl.getAttribute('data-pool'), 'gemini');

    // Legacy 4-tab popover panel, hover overview tip, and topbar update pill are completely removed from topbar HUD
    const multiPanelEl = portalHost.shadowRoot.querySelector('.wm-multi-panel');
    assert.ok(multiPanelEl, 'Current-window stream panel mounted in portal shadow root');
    assert.equal(portalHost.shadowRoot.querySelector('.wm-popover-panel'), null, 'Old 4-tab popover panel is removed');
    assert.equal(portalHost.shadowRoot.querySelector('.wm-hover-tip'), null, 'Legacy hover tip panel is removed');
    assert.equal(capsuleHost.shadowRoot.querySelector('.wm-update-btn'), null, 'Legacy topbar update pill is removed');
    assert.equal(capsuleHost.shadowRoot.querySelector('.wm-update-dot'), null, 'Legacy topbar update dot is removed');

    multiBtn.dispatchEvent({ type: 'mouseenter', clientX: 930, clientY: 18 });
    assert.equal(ov.isMultiOpen(), true, 'Hovering multi-session button opens current-window stream panel');
    assert.equal(ov.isMultiHoverOpen(), true);
    assert.equal(multiPanelEl.hasAttribute('hidden'), false);
    multiBtn.dispatchEvent({ type: 'mouseleave', clientX: 930, clientY: 18 });
    await new Promise((r) => setTimeout(r, 110));
    assert.equal(ov.isMultiOpen(), true, 'Stationary pointer inside multi button prevents synthetic mouseleave blink');

    const runningListEl = multiPanelEl.querySelector('.live-activity-list');
    assert.equal(runningListEl.children.length, 1, 'Cross-conversation sessions filtered out; only current window rendered');
    const liveTaskCard = runningListEl.children[0];
    assert.equal(liveTaskCard.querySelector('.live-task-title').textContent, 'Dual Mode Session');
    assert.equal(liveTaskCard.querySelector('.live-sub-role').textContent, 'Auth Researcher');

    // Clicking conversation title inside stream panel never opens legacy popover
    liveTaskCard.querySelector('.live-task-title').dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isOpen(), false, 'Clicking session title does not open legacy popover');

    multiBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isMultiPinnedOpen(), true, 'Clicking multi-session button pins stream panel open');
    assert.equal(multiBtn.classList.contains('is-open'), true);
    assert.equal(multiLabelEl.textContent, '1 子运行', 'Inline subagent label remains visible');
    multiBtn.dispatchEvent({ type: 'click', stopPropagation() {} });
    assert.equal(ov.isMultiOpen(), false, 'Second click unpins and closes stream panel');

    capsuleBtn.dispatchEvent({ type: 'mouseenter', clientX: 960, clientY: 18 });
    assert.equal(ov.isHoverOpen(), false, 'Hovering topbar capsule never opens floating hover HUD');

    // Programmatic ov.open() / ov.toggle() remain safe no-ops and never open any popover
    ov.open();
    assert.equal(ov.isOpen(), false);
    ov.toggle();
    assert.equal(ov.isOpen(), false);

    // Topbar capsule reacts live to backend settings updates (hide/show multiBtn + customize 3 slots)
    const capSlots = capsuleHost.shadowRoot.querySelectorAll('.wm-cap-slot');
    const capSeps = capsuleHost.shadowRoot.querySelectorAll('.wm-sep');
    assert.equal(capSlots.length, 3);
    assert.equal(capSeps.length, 2);

    mockSettings.showTopbarMultiSession = false;
    ov.updateBridge({ port: 49152, token: 'secret-bridge-token-123' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(multiBtn.hasAttribute('hidden'), true, 'Topbar multi-session button hidden immediately');
    assert.equal(capsuleHost.getAttribute('data-multi'), 'off');

    mockSettings.showTopbarMultiSession = true;
    mockSettings.topbarCapsuleSlots = ['gemini_5h', 'ttft', 'cost'];
    ov.updateBridge({ port: 49152, token: 'secret-bridge-token-123' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(multiBtn.hasAttribute('hidden'), false, 'Topbar multi-session button restored immediately');
    assert.equal(capSlots[0].getAttribute('data-metric'), 'gemini_5h');
    assert.equal(capSlots[0].querySelector('.wm-ring-svg'), null, 'Ring SVG detached cleanly when slot leaves context');
    assert.ok(capSlots[0].querySelector('.wm-bat-wrap'), 'Battery gauge mounted for quota slot');
    assert.equal(capSlots[0].getAttribute('data-5h-pct'), '44');
    assert.equal(capSlots[1].getAttribute('data-metric'), 'ttft');
    assert.equal(capSlots[1].children[0].textContent, '0.85s');
    assert.equal(capSlots[2].getAttribute('data-metric'), 'cost');
    assert.equal(capSlots[2].children[0].textContent, '$0.040');

    // Hide middle slot ('none') and set Slot 2 to Claude Weekly
    mockSettings.topbarCapsuleSlots = ['ttft', 'none', 'claude_weekly'];
    ov.updateBridge({ port: 49152, token: 'secret-bridge-token-123' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(capSlots[1].hasAttribute('hidden'), true, 'Middle slot hidden when set to none');
    assert.equal(capSeps[0].hasAttribute('hidden'), true, 'Separator before hidden middle slot collapses');
    assert.equal(capSeps[1].hasAttribute('hidden'), false, 'Single separator remains between Slot 0 and Slot 2');
    assert.equal(capSeps[1].getAttribute('data-sep-for-rank'), '2');
    assert.equal(capSlots[2].getAttribute('data-vis-rank'), '2');
    assert.ok(capSlots[2].querySelector('.wm-bat-wrap'));
    assert.equal(capSlots[2].getAttribute('data-5h-pct'), '91');

    // Restore default slots
    mockSettings.topbarCapsuleSlots = ['context', 'tps', 'quota_auto'];
    ov.updateBridge({ port: 49152, token: 'secret-bridge-token-123' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(capSlots[0].getAttribute('data-metric'), 'context');
    assert.equal(capSlots[0].children.length, 2, 'Ring SVG re-attached on Slot 0');
    assert.equal(capSlots[0].querySelector('.wm-ctx-pct').textContent, '50%');

    // Verify bundle version bump NEVER calls window.location.reload() in overlay mode
    currentBundleVer = 'ver-200';
    mockLocation.pathname = '/c/cccccccc-4444-5555-6666-dddddddddddd';
    for (const fn of winListeners.get('popstate') || []) fn({});
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(reloadCalled, false, 'Host window must never reload on bundle version change');
    assert.ok(
      fetchedUrls.some((u) => u.includes('conversationId=cccccccc-4444-5555-6666-dddddddddddd')),
      'Navigated host route immediately tracked'
    );
    // Verify fallback to CDP RPC relay when browser fetch fails (e.g. CSP connect-src or proxy block)
    let fetchShouldFail = true;
    const origFetch = mockWindow.fetch;
    mockWindow.fetch = async (url, opts) => {
      if (fetchShouldFail) {
        throw new TypeError('Failed to fetch');
      }
      return origFetch(url, opts);
    };
    mockLocation.pathname = '/c/dddddddd-7777-8888-9999-eeeeeeeeeeee';
    for (const fn of winListeners.get('popstate') || []) fn({});
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(mockWindow.__AGUsageMonitorBridge.transportMode, 'cdp');
    assert.equal(Array.isArray(mockWindow.__AGUsageMonitorBridge.rpcQueue), true);
    assert.equal(mockWindow.__AGUsageMonitorBridge.rpcQueue.length, 1);
    const queuedItem = mockWindow.__AGUsageMonitorBridge.rpcQueue.shift();
    const delivered = ov.deliverRpc([
      {
        id: queuedItem.id,
        ok: true,
        status: 200,
        data: {
          uiBundleVersion: 'ver-200',
          settings: { weeklyLimitMode: 'official', weeklyTokenBudget: 150000000, weeklyCostBudget: 100, enableWindowOverlay: true },
          activeConversation: {
            cascadeId: 'dddddddd-7777-8888-9999-eeeeeeeeeeee',
            title: 'CDP Relay Session',
            isRunning: false,
            stepCount: 8,
            latestTokPerSec: 120.5,
            context: { totalTokens: 64000, compactionLimitTokens: 256000, limitTokens: 256000 },
            recentSteps: [],
          },
          consumption: { selectedRange: { key: 'today', label: '今天', startMs: 1, endMs: 2 }, session: {}, account: {}, trendSeries: [], monthlySeries: [] },
          quotas: null,
          modelBreakdown: [],
        },
      },
    ]);
    assert.equal(delivered, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctxPctEl.textContent, '25%', 'CDP relay delivered live telemetry without HTTP');
    assert.equal(ctxLimitEl.textContent, '256k', 'CDP relay preserves context window total size sublabel');
    assert.equal(speedSegEl.querySelector('.wm-speed-text').textContent, '121 t/s');
    assert.equal(speedSegEl.classList.contains('speed-tier-orange'), true, '120.5 t/s uses 100-180 deep orange tier');
    assert.equal(quotaSegEl.hasAttribute('hidden'), false, 'Quota slot stays pre-reserved even when quotas=null');
    assert.equal(quotaSegEl.getAttribute('data-5h-pct'), '');
    assert.equal(quotaSegEl.querySelector('.wm-bat-weekly-fill').attributes.get('stroke-dashoffset'), '100');

    // Verify in-place bridge port rotation preserves exact DOM host nodes without remount
    fetchShouldFail = false;
    assert.equal(ov.updateBridge({ port: 51234, token: 'rotated-token-456' }), true);
    assert.equal(mockWindow.__AGUsageMonitorBridge.port, 51234);
    assert.equal(mockDocument.getElementById('ag-usage-monitor-capsule'), capsuleHost);

    // Verify navigating back to New Conversation screen ('/') clears context & speed immediately and requests __none__
    mockLocation.pathname = '/';
    for (const fn of winListeners.get('popstate') || []) fn({});
    await new Promise((r) => setTimeout(r, 40));
    const requestedNewChat =
      fetchedUrls.some((u) => u.includes('conversationId=__none__')) ||
      (mockWindow.__AGUsageMonitorBridge.rpcQueue || []).some((item) =>
        String(item?.path || '').includes('conversationId=__none__')
      );
    assert.ok(
      requestedNewChat,
      'Navigating to New Chat (/) explicitly requests conversationId=__none__'
    );
    assert.equal(ctxPctEl.textContent, '0%', 'New Chat clears stale context usage');
    assert.equal(ctxLimitEl.textContent, '—', 'New Chat clears context window limit sublabel');
    assert.equal(speedSegEl.querySelector('.wm-speed-text').textContent, '待命', 'New Chat clears stale token speed');
    assert.equal(speedSegEl.querySelector('.wm-speed-model').textContent, '—', 'New Chat clears stale model sublabel');
    assert.equal(quotaSegEl.hasAttribute('hidden'), false, 'New Chat retains account quota battery slot');
  } finally {
    mockWindow.__AGUsageMonitorOverlay?.dispose?.();
    assert.equal(mockDocument.getElementById('ag-usage-monitor-capsule'), null);
    assert.equal(mockDocument.getElementById('ag-usage-monitor-portal'), null);
  }
});

test('Backend buildTelemetryPayloadInternal does not leak previous conversation on __none__ or unstarted new UUID', async () => {
  const prevRaw = {
    trajectory: {
      steps: [
        {
          status: 'CORTEX_STEP_STATUS_DONE',
          metadata: {
            createdAt: '2026-01-01T00:00:00Z',
            finishedGeneratingAt: '2026-01-01T00:00:05Z',
            modelUsage: {
              model: 'MODEL_PLACEHOLDER_M418',
              inputTokens: '1000',
              cacheReadTokens: '2000',
              outputTokens: '500',
              thinkingOutputTokens: '100',
              responseOutputTokens: '400',
            },
          },
          plannerResponse: { response: 'done' },
        },
      ],
      generatorMetadata: [
        {
          stepIndices: [0],
          chatModel: {
            timeToFirstToken: '1s',
            streamingDuration: '4s',
            chatStartMetadata: {
              contextWindowMetadata: {
                tokenBreakdown: {
                  groups: [{ type: 'TOKEN_TYPE_CHAT_MESSAGES', numTokens: 51200 }],
                },
              },
            },
          },
        },
      ],
    },
  };

  const h = backendHarness({
    summaries: {
      'hist-conv-1': {
        stepCount: 1,
        lastModifiedTime: '2026-01-01T00:00:05Z',
        status: 'IDLE',
        annotations: { title: 'Previous Chat' },
      },
    },
    trajectories: {
      'hist-conv-1': prevRaw,
    },
  });

  const emptyScreenPayload = await h.buildTelemetryPayloadInternal('__none__', false, {});
  assert.equal(emptyScreenPayload.activeConversation.cascadeId, null);
  assert.equal(emptyScreenPayload.activeConversation.stepCount, 0);
  assert.equal(emptyScreenPayload.activeConversation.latestTokPerSec, null);
  assert.equal(emptyScreenPayload.activeConversation.context.usedPct, 0);

  const brandNewUuidPayload = await h.buildTelemetryPayloadInternal('new-unstarted-uuid', false, {});
  assert.equal(brandNewUuidPayload.activeConversation.cascadeId, 'new-unstarted-uuid');
  assert.equal(brandNewUuidPayload.activeConversation.stepCount, 0);
  assert.equal(brandNewUuidPayload.activeConversation.latestTokPerSec, null);
  assert.equal(brandNewUuidPayload.activeConversation.context.usedPct, 0);

  const defaultPayload = await h.buildTelemetryPayloadInternal('', false, {});
  assert.equal(defaultPayload.activeConversation.cascadeId, 'hist-conv-1');
  assert.equal(defaultPayload.activeConversation.stepCount, 1);
  assert.ok(defaultPayload.activeConversation.latestTokPerSec > 0);
  assert.ok(defaultPayload.activeConversation.context.usedPct > 0);
});
