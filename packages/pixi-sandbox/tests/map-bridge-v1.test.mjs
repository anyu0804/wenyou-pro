import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const { appStore } = await server.ssrLoadModule('/src/store.ts');
const { parseWorkingMap } = await server.ssrLoadModule('/src/map-loader.ts');
const { createImageBaseSpec, buildImageHexMapData } = await server.ssrLoadModule('/src/image-map-builder.ts');
const { serializeProject, parseProject } = await server.ssrLoadModule('/src/project-serializer.ts');
const { migrateLegacyBattle } = await server.ssrLoadModule('/src/battle-storage.ts');
const { importProjectFromBridge, exportProjectForBridge, createImageTheaterFromBridge } = await server.ssrLoadModule('/src/theater-manager.ts');
const { resolveWorkspaceScopeFromUrl, resolveTheaterDbName } = await server.ssrLoadModule('/src/theater-cache.ts');
const {
  WENYOU_MAP_BRIDGE_PROTOCOL,
  WENYOU_SANDBOX_VERSION,
  isAllowedHostOrigin,
  resolveReplyTargetOrigin,
  initMapBridge,
} = await server.ssrLoadModule('/src/bridge.ts');

const fixtureSource = await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');

function createMockWindow(embedded = true) {
  const listeners = new Set();
  const sent = [];
  const parent = {
    postMessage(message, targetOrigin) {
      sent.push({ message, targetOrigin });
    },
  };
  const win = {
    parent: null,
    addEventListener(type, fn) {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'message') listeners.delete(fn);
    },
    dispatchMessage(event) {
      for (const fn of listeners) fn(event);
    },
  };
  win.parent = embedded ? parent : win;
  return { win, parent, sent };
}

function flushMicrotasks() {
  return new Promise(resolve => setTimeout(resolve, 15));
}

function resetAppStore() {
  appStore.mapData = null;
  appStore.mapId = '';
  appStore.isSwitchingMap = false;
  appStore.garrisons = [];
  appStore.battle = { schemaVersion: 1, sources: [], battlefields: [], deployments: [] };
  appStore.fieldBattles = [];
  appStore.tacticalItems = [];
  appStore.selectedBurgId = null;
  appStore.selectedTacticalId = null;
}

test('origin 校验与回复目标计算：仅允许 loopback、Electron file:// 与内置协议源', () => {
  assert.equal(isAllowedHostOrigin('http://127.0.0.1:5173'), true);
  assert.equal(isAllowedHostOrigin('http://localhost:3000'), true);
  assert.equal(isAllowedHostOrigin('http://[::1]:5174'), true);
  assert.equal(isAllowedHostOrigin('null'), true);
  assert.equal(isAllowedHostOrigin(''), true);
  assert.equal(isAllowedHostOrigin('file://'), true);
  assert.equal(isAllowedHostOrigin('wenyou-sandbox://app'), true);
  assert.equal(isAllowedHostOrigin('app://renderer'), true);

  assert.equal(isAllowedHostOrigin('https://evil.example'), false);
  assert.equal(isAllowedHostOrigin('http://127.0.0.1.evil.example'), false);
  assert.equal(isAllowedHostOrigin('http://192.168.1.10:5173'), false);

  assert.equal(resolveReplyTargetOrigin('http://127.0.0.1:5179'), 'http://127.0.0.1:5179');
  assert.equal(resolveReplyTargetOrigin('wenyou-sandbox://app'), 'wenyou-sandbox://app');
  assert.equal(resolveReplyTargetOrigin('app://renderer'), 'app://renderer');
  assert.equal(resolveReplyTargetOrigin('null'), '*');
  assert.equal(resolveReplyTargetOrigin(''), '*');
  assert.equal(resolveReplyTargetOrigin(null), '*');
});

test('嵌入握手、上下文同步与非法来源/非法协议忽略', async () => {
  resetAppStore();
  const { win, parent, sent } = createMockWindow(true);
  const badgeNodes = [];
  const mockDoc = {
    getElementById(id) {
      if (id !== 'wenyou-theater-bar') return null;
      return {
        appendChild(node) {
          node.isConnected = true;
          badgeNodes.push(node);
        },
      };
    },
    createElement() {
      return {
        id: '',
        style: { cssText: '' },
        textContent: '',
        title: '',
        isConnected: false,
        remove() { this.isConnected = false; },
      };
    },
  };

  const bridge = initMapBridge({
    win,
    doc: mockDoc,
    listTheaters: async () => [],
  });
  await flushMicrotasks();

  // 初始化后主动发一次 ready
  assert.equal(sent.length, 1);
  assert.equal(sent[0].targetOrigin, '*');
  assert.deepEqual(sent[0].message, {
    protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
    type: 'ready',
    payload: {
      version: WENYOU_SANDBOX_VERSION,
      activeMapId: null,
      mapName: null,
      theaterCount: 0,
    },
  });

  // 忽略非法协议、非 parent 来源、外部域名 origin
  win.dispatchMessage({ source: {}, origin: 'http://127.0.0.1:5173', data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'ping' } });
  win.dispatchMessage({ source: parent, origin: 'https://attacker.test', data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'ping' } });
  win.dispatchMessage({ source: parent, origin: 'http://127.0.0.1:5173', data: { protocol: 'wrong-protocol/v1', type: 'ping' } });
  await flushMicrotasks();
  assert.equal(sent.length, 1);

  // 合法 loopback ping -> 精确 origin 回复 pong
  win.dispatchMessage({
    source: parent,
    origin: 'http://127.0.0.1:5179',
    data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'ping', requestId: 'req-ping-1' },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].targetOrigin, 'http://127.0.0.1:5179');
  assert.equal(sent[1].message.type, 'pong');
  assert.equal(sent[1].message.requestId, 'req-ping-1');
  assert.equal(sent[1].message.payload.version, WENYOU_SANDBOX_VERSION);

  // Electron file:// (origin === 'null') ping -> targetOrigin === '*' 回复 pong
  win.dispatchMessage({
    source: parent,
    origin: 'null',
    data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'ping', requestId: 'req-file-1' },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].targetOrigin, '*');
  assert.equal(sent[2].message.requestId, 'req-file-1');

  // sync_context -> context_acked + 轻标记更新
  win.dispatchMessage({
    source: parent,
    origin: 'http://127.0.0.1:5179',
    data: {
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'sync_context',
      payload: { worldId: 'w-north', worldTitle: '北境诸侯', currentEra: '永安三年', viewer: 'gm' },
    },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 4);
  assert.equal(sent[3].targetOrigin, 'http://127.0.0.1:5179');
  assert.deepEqual(sent[3].message, {
    protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
    type: 'context_acked',
    payload: { worldId: 'w-north', currentEra: '永安三年', activeMapId: null },
  });
  assert.deepEqual(bridge.getLastContext(), {
    worldId: 'w-north',
    worldTitle: '北境诸侯',
    currentEra: '永安三年',
    viewer: 'gm',
  });
  assert.equal(badgeNodes.length, 1);
  assert.match(badgeNodes[0].textContent, /北境诸侯/);

  bridge.destroy();
  assert.equal(badgeNodes[0].isConnected, false);
});

test('非嵌入态（独立标签页）不向自身发送任何 bridge 消息', async () => {
  resetAppStore();
  const { win, sent } = createMockWindow(false);
  const bridge = initMapBridge({ win, doc: null, listTheaters: async () => [] });
  await flushMicrotasks();
  win.dispatchMessage({
    source: win,
    origin: 'http://127.0.0.1:5173',
    data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'ping' },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 0);
  bridge.destroy();
});

test('load_project / request_export_project 真实 v4 工程往返与选择/原文聚焦出站通知', async () => {
  resetAppStore();
  const map = parseWorkingMap(fixtureSource);
  const firstBurg = map.burgs.find(b => b.i > 0 && !b.removed);
  assert.ok(firstBurg, 'fixture 应含至少一座有效城邦');
  firstBurg.name = '镇海城';
  const legacyBattle = migrateLegacyBattle(map.source.mapId, [
    { id: 'u-guard', provinceId: firstBurg.province, unitName: '镇海卫', troops: 4200, color: '#ef4444', status: '驻防', x: firstBurg.x, y: firstBurg.y },
  ]);
  const initialState = {
    version: 4,
    mapData: map,
    garrisons: legacyBattle.garrisons,
    battle: legacyBattle.battle,
    fieldBattles: [],
    tacticalItems: [{ id: 't-front', type: 'frontline', points: [[10, 20], [50, 60]], color: '#ef4444', width: 4, label: '北线' }],
  };
  const projectJson = serializeProject([initialState], map.source.mapId);

  const memoryTheaters = new Map();
  const { win, parent, sent } = createMockWindow(true);
  const bridge = initMapBridge({
    win,
    doc: null,
    listTheaters: async () => Array.from(memoryTheaters.values()).map(t => ({ mapId: t.mapData.source.mapId, name: t.mapData.source.name })),
    importProject: async (jsonText) => {
      const parsed = parseProject(jsonText);
      memoryTheaters.clear();
      for (const theater of parsed.theaters) {
        memoryTheaters.set(theater.mapData.source.mapId, theater);
      }
      const active = parsed.theaters.find(t => t.mapData.source.mapId === parsed.activeMapId);
      appStore.mapData = active.mapData;
      appStore.mapId = active.mapData.source.mapId;
      appStore.garrisons = active.garrisons;
      appStore.battle = active.battle;
      appStore.fieldBattles = active.fieldBattles;
      appStore.tacticalItems = active.tacticalItems;
      appStore.emit('map:loaded', active.mapData);
      return {
        activeMapId: appStore.mapId,
        mapName: appStore.mapData.source.name,
        theaterCount: memoryTheaters.size,
      };
    },
    exportProject: async () => {
      const theaters = Array.from(memoryTheaters.values());
      return {
        projectJson: serializeProject(theaters, appStore.mapId),
        activeMapId: appStore.mapId,
        mapName: appStore.mapData.source.name,
        theaterCount: theaters.length,
      };
    },
  });
  await flushMicrotasks();
  sent.length = 0;

  // 1) load_project
  win.dispatchMessage({
    source: parent,
    origin: 'http://localhost:5175',
    data: {
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'load_project',
      requestId: 'req-load-1',
      payload: { fileName: 'round1.json', projectJson, forceOverwrite: true },
    },
  });
  await flushMicrotasks();

  const loadedMsg = sent.find(item => item.message.type === 'project_loaded');
  assert.ok(loadedMsg, '应回复 project_loaded');
  assert.equal(loadedMsg.targetOrigin, 'http://localhost:5175');
  assert.equal(loadedMsg.message.requestId, 'req-load-1');
  assert.equal(loadedMsg.message.payload.ok, true);
  assert.equal(loadedMsg.message.payload.activeMapId, map.source.mapId);
  assert.equal(loadedMsg.message.payload.theaterCount, 1);

  // 2) request_export_project
  sent.length = 0;
  win.dispatchMessage({
    source: parent,
    origin: 'http://localhost:5175',
    data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'request_export_project', requestId: 'req-exp-1' },
  });
  await flushMicrotasks();

  const exportedMsg = sent.find(item => item.message.type === 'project_exported');
  assert.ok(exportedMsg, '应回复 project_exported');
  assert.equal(exportedMsg.targetOrigin, 'http://localhost:5175');
  assert.equal(exportedMsg.message.requestId, 'req-exp-1');
  assert.equal(exportedMsg.message.payload.ok, true);
  const roundtrip = parseProject(exportedMsg.message.payload.projectJson);
  assert.equal(roundtrip.activeMapId, map.source.mapId);
  assert.equal(roundtrip.theaters[0].mapData.burgs.find(b => b.i === firstBurg.i).name, '镇海城');
  assert.equal(roundtrip.theaters[0].garrisons[0].id, 'u-guard');
  assert.equal(roundtrip.theaters[0].tacticalItems[0].id, 't-front');

  // 3) 非法工程 JSON 应优雅返回 ok: false 而不抛未捕获异常
  sent.length = 0;
  win.dispatchMessage({
    source: parent,
    origin: 'http://localhost:5175',
    data: {
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'load_project',
      requestId: 'req-bad',
      payload: { fileName: 'broken.json', projectJson: '{"format":"bad"}' },
    },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, 'project_loaded');
  assert.equal(sent[0].message.requestId, 'req-bad');
  assert.equal(sent[0].message.payload.ok, false);
  assert.ok(typeof sent[0].message.payload.error === 'string' && sent[0].message.payload.error.length > 0);

  // 4) 选中城邦 / 兵牌 / 原文聚焦出站通知（均发往精确 lastHostOrigin）
  sent.length = 0;
  appStore.emit('selection:burg', firstBurg.i);
  appStore.emit('selection:unit', 'u-guard');
  appStore.emit('source:focus', { sourceId: 'src-msg-99', highlightQuote: '镇海城告急' });

  assert.equal(sent.length, 3);
  assert.equal(sent[0].targetOrigin, 'http://localhost:5175');
  assert.equal(sent[0].message.type, 'selection_changed');
  assert.equal(sent[0].message.payload.kind, 'burg');
  assert.equal(sent[0].message.payload.id, firstBurg.i);
  assert.equal(sent[0].message.payload.name, '镇海城');

  assert.equal(sent[1].message.type, 'selection_changed');
  assert.equal(sent[1].message.payload.kind, 'unit');
  assert.equal(sent[1].message.payload.id, 'u-guard');
  assert.equal(sent[1].message.payload.name, '镇海卫');
  assert.equal(sent[1].message.payload.personnel, 4200);
  assert.equal(sent[1].message.payload.x, firstBurg.x);

  assert.deepEqual(sent[2].message, {
    protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
    type: 'focus_source',
    payload: { sourceId: 'src-msg-99', highlightQuote: '镇海城告急' },
  });

  bridge.destroy();
});

test('create_image_theater 入站建图与 project:autosaved 静默回传 autosave_project 闭环', async () => {
  resetAppStore();
  const memoryTheaters = new Map();
  const { win, parent, sent } = createMockWindow(true);
  const bridge = initMapBridge({
    win,
    doc: null,
    listTheaters: async () =>
      Array.from(memoryTheaters.values()).map(t => ({ mapId: t.mapData.source.mapId, name: t.mapData.source.name })),
    readTheater: async (mapId) => memoryTheaters.get(mapId),
    createImageTheater: async (payload) => {
      const spec = createImageBaseSpec({
        name: payload.name,
        width: 800,
        height: 500,
        imageUrl: payload.imageUrl,
        imageRelPath: payload.imageRelPath,
        gridPreset: payload.gridPreset ?? 'standard',
        mapWidthKm: payload.mapWidthKm,
      });
      const mapData = buildImageHexMapData(spec);
      const theater = {
        version: 4,
        mapData,
        garrisons: [],
        battle: { schemaVersion: 1, sources: [], battlefields: [], deployments: [] },
        fieldBattles: [],
        tacticalItems: [],
      };
      memoryTheaters.set(mapData.source.mapId, theater);
      appStore.mapData = mapData;
      appStore.mapId = mapData.source.mapId;
      appStore.garrisons = [];
      appStore.battle = theater.battle;
      appStore.fieldBattles = [];
      appStore.tacticalItems = [];
      appStore.emit('map:loaded', mapData);
      return {
        activeMapId: mapData.source.mapId,
        mapName: mapData.source.name,
        cellCount: mapData.cells.count,
        ...(mapData.source.kmPerPixel !== undefined ? { kmPerPixel: mapData.source.kmPerPixel } : {}),
        theaterCount: memoryTheaters.size,
      };
    },
  });
  await flushMicrotasks();
  sent.length = 0;

  // 1) create_image_theater 正常创建图片战区
  win.dispatchMessage({
    source: parent,
    origin: 'wenyou-sandbox://app',
    data: {
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'create_image_theater',
      requestId: 'req-img-1',
      payload: {
        name: '高卢行省图',
        imageUrl: 'wenyou-asset://vault?cwd=demo&path=gaul.png',
        imageRelPath: '05-沙盘与图集/gaul.png',
        gridPreset: 'coarse',
        mapWidthKm: 1000,
      },
    },
  });
  await flushMicrotasks();

  const created = sent.find(item => item.message.type === 'image_theater_created');
  assert.ok(created, '应回复 image_theater_created');
  assert.equal(created.targetOrigin, 'wenyou-sandbox://app');
  assert.equal(created.message.requestId, 'req-img-1');
  assert.equal(created.message.payload.ok, true);
  assert.equal(created.message.payload.mapName, '高卢行省图');
  assert.ok(created.message.payload.cellCount > 0);
  assert.equal(created.message.payload.kmPerPixel, 1.25);

  // 2) 缺少 imageUrl 时优雅返回 ok: false
  sent.length = 0;
  win.dispatchMessage({
    source: parent,
    origin: 'wenyou-sandbox://app',
    data: {
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'create_image_theater',
      requestId: 'req-img-bad',
      payload: { name: '坏图' },
    },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, 'image_theater_created');
  assert.equal(sent[0].message.payload.ok, false);

  // 3) 用户涂色+修补后触发 project:autosaved -> 自动静默发 autosave_project
  sent.length = 0;
  appStore.mapData.cells.state[0] = 1;
  appStore.mapData.source.overlayAlpha = 0.5;
  appStore.mapData.source.retouchStrokes = [
    { id: 'r-1', color: '#cccccc', width: 20, points: [[10, 10], [40, 30]] },
  ];
  appStore.emit('project:autosaved');
  await flushMicrotasks();

  const autosave = sent.find(item => item.message.type === 'autosave_project');
  assert.ok(autosave, '应发送 autosave_project');
  assert.equal(autosave.targetOrigin, 'wenyou-sandbox://app');
  assert.equal(autosave.message.payload.activeMapId, appStore.mapId);
  assert.equal(autosave.message.payload.mapName, '高卢行省图');
  assert.equal(autosave.message.payload.theaterCount, 1);
  const parsed = parseProject(autosave.message.payload.projectJson);
  assert.equal(parsed.theaters[0].mapData.cells.state[0], 1);
  assert.equal(parsed.theaters[0].mapData.source.overlayAlpha, 0.5);
  assert.equal(parsed.theaters[0].mapData.source.retouchStrokes.length, 1);

  bridge.destroy();
});

test('theater-manager 桥接导出入口在空沙盘与非法 JSON 时显式抛错', async () => {
  resetAppStore();
  await assert.rejects(() => importProjectFromBridge('{broken'), /JSON|Unexpected|Expected/i);
  await assert.rejects(() => exportProjectForBridge(), /尚未导入地图/);
});

test('workspace 隔离库名解析：无参数保持原库名，不同 workspace 物理隔离', () => {
  assert.equal(resolveWorkspaceScopeFromUrl(''), null);
  assert.equal(resolveWorkspaceScopeFromUrl('?foo=bar'), null);
  assert.equal(resolveWorkspaceScopeFromUrl('?workspace=%20%20'), null);
  assert.equal(resolveWorkspaceScopeFromUrl('?workspace=world%2Falpha'), 'world/alpha');

  assert.equal(resolveTheaterDbName(null), 'wenyou-theaters');
  assert.equal(resolveTheaterDbName(''), 'wenyou-theaters');

  const dbA = resolveTheaterDbName('world/alpha');
  const dbB = resolveTheaterDbName('world/beta');
  assert.match(dbA, /^wenyou-pixi-theaters-[0-9a-f]{8}$/);
  assert.match(dbB, /^wenyou-pixi-theaters-[0-9a-f]{8}$/);
  assert.notEqual(dbA, dbB);
  assert.equal(dbA, resolveTheaterDbName('world/alpha'));
});

test('bridge 透传 workspaceKey、重放启动早期消息并处理 reset_sandbox', async () => {
  resetAppStore();
  const { win, parent, sent } = createMockWindow(true);
  let resetCalls = 0;

  const earlyPing = {
    source: parent,
    origin: 'http://127.0.0.1:5179',
    data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'ping', requestId: 'early-1' },
  };
  const bridge = initMapBridge({
    win,
    doc: null,
    workspaceScope: 'ws-url-alpha',
    earlyMessages: [earlyPing],
    listTheaters: async () => [],
    resetSandbox: async () => {
      resetCalls += 1;
      appStore.mapData = null;
      appStore.mapId = '';
      appStore.emit('map:cleared');
    },
  });
  await flushMicrotasks();

  const initReady = sent.find(item => item.message.type === 'ready');
  assert.ok(initReady, '应发送初始 ready');
  assert.equal(initReady.message.payload.workspaceKey, 'ws-url-alpha');

  const earlyPong = sent.find(item => item.message.type === 'pong' && item.message.requestId === 'early-1');
  assert.ok(earlyPong, '应重放启动早期收到的 ping 并回复 pong');
  assert.equal(earlyPong.message.payload.workspaceKey, 'ws-url-alpha');

  // sync_context 更新 workspaceKey 后，后续消息附带新 workspaceKey
  sent.length = 0;
  win.dispatchMessage({
    source: parent,
    origin: 'http://127.0.0.1:5179',
    data: {
      protocol: WENYOU_MAP_BRIDGE_PROTOCOL,
      type: 'sync_context',
      payload: {
        worldId: 'w-south',
        worldTitle: '南境',
        currentEra: '建元二年',
        viewer: 'gm',
        workspaceKey: 'ws-ctx-beta',
      },
    },
  });
  await flushMicrotasks();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, 'context_acked');
  assert.equal(sent[0].message.payload.workspaceKey, 'ws-ctx-beta');

  // reset_sandbox 清空并回复单次 ready（附带 requestId 与 workspaceKey）
  sent.length = 0;
  win.dispatchMessage({
    source: parent,
    origin: 'http://127.0.0.1:5179',
    data: { protocol: WENYOU_MAP_BRIDGE_PROTOCOL, type: 'reset_sandbox', requestId: 'req-reset-1' },
  });
  await flushMicrotasks();
  assert.equal(resetCalls, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.type, 'ready');
  assert.equal(sent[0].message.requestId, 'req-reset-1');
  assert.equal(sent[0].message.payload.activeMapId, null);
  assert.equal(sent[0].message.payload.theaterCount, 0);
  assert.equal(sent[0].message.payload.workspaceKey, 'ws-ctx-beta');

  bridge.destroy();
});

test('createImageTheaterFromBridge 在异步 probeImageDimensions 期间立即持有切换锁防 TOCTOU 重入', async () => {
  resetAppStore();
  const prevImage = globalThis.Image;
  let rejectProbe;
  try {
    globalThis.Image = class HangingImage {
      constructor() {
        this.crossOrigin = '';
      }
      set src(_url) {
        rejectProbe = () => this.onerror?.(new Error('probe aborted'));
      }
    };

    const first = createImageTheaterFromBridge({
      name: '并发测试图',
      imageUrl: 'wenyou-asset://vault?path=slow.png',
    });

    // 在 probe 尚未结束前，切换锁必须已生效
    assert.equal(appStore.isSwitchingMap, true);

    await assert.rejects(
      () => createImageTheaterFromBridge({ name: '二次重入', imageUrl: 'wenyou-asset://vault?path=second.png' }),
      /正在切换战区/,
    );

    rejectProbe();
    await assert.rejects(() => first, /图片底图加载失败/);
    // 失败后锁必须干净释放
    assert.equal(appStore.isSwitchingMap, false);
  } finally {
    if (prevImage) globalThis.Image = prevImage;
    else delete globalThis.Image;
  }
});
