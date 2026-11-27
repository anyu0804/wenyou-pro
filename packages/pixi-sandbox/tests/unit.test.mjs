import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const { parseWorkingMap, SEA_LEVEL } = await server.ssrLoadModule('/src/map-loader.ts');
const { serializeMap, originalMapRecords } = await server.ssrLoadModule('/src/map-serializer.ts');
const { computeTerrainCellColor } = await server.ssrLoadModule('/src/terrain-heightmap.ts');
const { appStore, recomputeBurgTiers, terrainContainer } = await server.ssrLoadModule('/src/store.ts');
const { serializeProject, parseProject } = await server.ssrLoadModule('/src/project-serializer.ts');
const { migrateLegacyBattle } = await server.ssrLoadModule('/src/battle-storage.ts');
const { rebuildMapLabels, updateLabelLod } = await server.ssrLoadModule('/src/label-lod.ts');
const { cellLocatorFor } = await server.ssrLoadModule('/src/map-renderer.ts');
const { initBurgEditor, findBurgOccupyingCell, canPlaceBurgAtCell } = await server.ssrLoadModule('/src/burg-editor.ts');
const { Container, Graphics } = await server.ssrLoadModule('pixi.js');
// 启动不再附带底图；解析回归固定使用旧格式 fixture（v1.108 E群岛原字节副本）
const source = await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');
const map = parseWorkingMap(source);

test('原图重建地块编号、尺寸、typed arrays 和几何相互对应', () => {
  const records = source.split('\r\n');
  const header = records[0].split('|');
  assert.equal(map.source.mapId, `${header[3]}-${header[6]}-${header[4]}x${header[5]}`);
  assert.deepEqual([map.width, map.height], header.slice(4, 6).map(Number));
  assert.equal(map.cells.count, records[25].split(',').length);
  assert.deepEqual(Array.from(map.cells.state), records[25].split(',').map(Number));
  assert.equal(map.cells.polygons.length, map.cells.count);
  assert.ok(map.cells.polygons.every(polygon => polygon.every(point => point.every(Number.isFinite))));
  assert.ok(map.cells.h instanceof Uint8Array);
  assert.ok(map.cells.province instanceof Uint16Array);
  const nullSlots = [...records];
  nullSlots[30] = JSON.stringify(JSON.parse(records[30]).map(province => province === 0 ? null : province));
  assert.deepEqual(parseWorkingMap(nullSlots.join('\r\n')).provinces, map.provinces);
  assert.throws(() => parseWorkingMap('not a map'), /map-loader/);
});

test('城市分层：首都优先；删除国家、省份、城市和失效首府不参与', () => {
  const data = {
    burgs: [1, 2, 3, 4, 5].map(i => ({ i, capital: 1, tier: 'capital', removed: i === 5 })),
    states: [{ i: 1, capital: 1 }, { i: 2, capital: 3, removed: true }, { i: 3, capital: 999 }, { i: 4 }],
    provinces: [{ i: 1, burg: 1 }, { i: 2, burg: 2 }, { i: 3, burg: 4, removed: true }, { i: 4, burg: 5 }],
  };
  recomputeBurgTiers(data);
  assert.deepEqual(data.burgs.slice(0, 4).map(b => [b.capital, b.tier]),
    [[1, 'capital'], [0, 'provincial'], [0, 'city'], [0, 'city']]);
  assert.equal(data.burgs[4].removed, true);
});

test('FMG v1.139/v1.154 头部布局：参数 JSON、空坐标行与生物群系 JSON 数组可解析', () => {
  const lines = source.split('\r\n');
  // 旧选项行里内嵌的 options JSON 与其后的地图名
  const optionsParts = lines[1].split('|');
  const jsonIndex = optionsParts.findIndex(part => part.startsWith('{'));
  const legacyName = optionsParts[jsonIndex + 1];
  const legacyCoords = JSON.parse(lines[2]);
  const [colorList, , nameList] = lines[3].split('|');
  const biomeJson = JSON.stringify(colorList.split(',').map((color, i) => ({ i, color, name: nameList.split(',')[i] })));

  // v1.154 布局：第 2 行参数 JSON（坐标并入 geography、名称并入 lore），第 3/5 行留空，第 4 行群系 JSON
  const v154 = [...lines];
  v154[0] = v154[0].replace(/^1\.\d+\.\d+/, '1.154.2');
  v154[1] = JSON.stringify({ geography: { coordinates: legacyCoords }, lore: { name: legacyName } });
  v154[2] = '';
  v154[3] = biomeJson;
  v154[4] = '';
  const modern = parseWorkingMap(v154.join('\r\n'));
  assert.equal(modern.source.name, legacyName);
  assert.deepEqual(modern.source.coords, map.source.coords);
  assert.deepEqual(modern.biomes, map.biomes);
  assert.equal(modern.cells.count, map.cells.count);
  assert.deepEqual(Array.from(modern.cells.state), Array.from(map.cells.state));
  assert.equal(modern.source.mapId, map.source.mapId);

  // v1.139 布局：保留选项行与坐标行，仅第 4 行群系换成 JSON 数组
  const v139 = [...lines];
  v139[3] = biomeJson;
  const mixed = parseWorkingMap(v139.join('\r\n'));
  assert.deepEqual(mixed.biomes, map.biomes);
  assert.equal(mixed.source.name, map.source.name);
  assert.deepEqual(mixed.source.coords, map.source.coords);

  // 参数 JSON 缺坐标时置 null（渲染器经纬网回退默认范围），不再抛异常
  const noCoords = [...v154];
  noCoords[1] = JSON.stringify({ geography: {}, lore: { name: '无坐标' } });
  assert.equal(parseWorkingMap(noCoords.join('\r\n')).source.coords, null);
});

test('工程往返：城市、地块、兵牌和战线，恢复后可独立编辑', () => {
  const edited = structuredClone(map);
  edited.burgs[0].name = '<城> & 中文 | 😀';
  edited.cells.h[0] = 55;
  const upgraded = migrateLegacyBattle(edited.source.mapId,
    [{ id: 'army', provinceId: 1, unitName: '一军', troops: 12345, color: '#ff0000', status: '驻防' }]);
  const state = { version: 4, mapData: edited,
    garrisons: upgraded.garrisons, battle: upgraded.battle, fieldBattles: [],
    tacticalItems: [{ id: 'line', type: 'frontline', points: [[10, 20], [30, 40]], width: 4, color: '#ff0000' }],
  };
  const json = serializeProject([state], edited.source.mapId);
  const restored = parseProject(json).theaters[0];
  assert.equal(restored.mapData.burgs[0].name, edited.burgs[0].name);
  for (const field of ['h', 'state', 'province', 'religion']) assert.deepEqual(restored.mapData.cells[field], edited.cells[field]);
  for (const field of ['garrisons', 'battle', 'tacticalItems']) assert.deepEqual(restored[field], state[field]);
  restored.mapData.cells.h[0] = 44;
  assert.equal(edited.cells.h[0], 55);
  const broken = JSON.parse(json);
  broken.theaters[0].map.heights.pop();
  assert.throws(() => parseProject(JSON.stringify(broken)), /heights/);
});

test('回归：非数字种子与空 provinces/rivers 行可解析；1.158.0 导出不继承 tombstone removed:true', () => {
  assert.equal(appStore.mapId, '');

  const lines = source.split('\r\n');
  const seedLines = [...lines];
  const seedHeader = seedLines[0].split('|');
  seedHeader[3] = 'westeros';
  seedLines[0] = seedHeader.join('|');
  seedLines[30] = '';
  seedLines[32] = '';
  const nonNumeric = parseWorkingMap(seedLines.join('\r\n'));
  assert.equal(nonNumeric.source.mapId, `westeros-${seedHeader[6]}-${seedHeader[4]}x${seedHeader[5]}`);
  assert.deepEqual(nonNumeric.provinces, []);
  assert.deepEqual(nonNumeric.rivers, []);

  // 1.158.0 版本与省份 tombstone 复用：原始档位标记 removed:true，重新启用后导出不得残留 removed:true
  const v158Lines = [...lines];
  v158Lines[0] = v158Lines[0].replace(/^1\.\d+\.\d+/, '1.158.0');
  const rawProvs = JSON.parse(v158Lines[30]);
  const reusedProvId = rawProvs.findIndex(p => p && typeof p === 'object' && p.i > 0);
  assert.ok(reusedProvId > 0);
  const templateProv = structuredClone(map.provinces.find(p => p.i === reusedProvId));
  assert.ok(templateProv);
  templateProv.name = '复国行省';
  rawProvs[reusedProvId] = { ...rawProvs[reusedProvId], removed: true };
  v158Lines[30] = JSON.stringify(rawProvs);

  const m158 = parseWorkingMap(v158Lines.join('\r\n'));
  assert.equal(m158.provinces.some(p => p.i === reusedProvId), false);
  m158.provinces.push({ ...templateProv });
  const prevDOMParser = globalThis.DOMParser;
  const prevXMLSerializer = globalThis.XMLSerializer;
  let saved;
  try {
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelector: () => null, getElementById: () => null };
      }
    };
    globalThis.XMLSerializer = class {
      serializeToString() {
        return v158Lines[5];
      }
    };
    saved = serializeMap(m158);
  } finally {
    if (prevDOMParser) globalThis.DOMParser = prevDOMParser;
    else delete globalThis.DOMParser;
    if (prevXMLSerializer) globalThis.XMLSerializer = prevXMLSerializer;
    else delete globalThis.XMLSerializer;
  }
  const savedProvs = JSON.parse(saved.split('\r\n')[30]);
  assert.equal('removed' in savedProvs[reusedProvId], false);
  const reloaded = parseWorkingMap(saved);
  assert.equal(reloaded.provinces.some(p => p.i === reusedProvId && p.name === '复国行省'), true);
});

test('回归：海洋/架海域高程颜色分支返回固定海洋色而非陆地色阶', () => {
  const waterMap = structuredClone(map);
  assert.equal(SEA_LEVEL, 20);
  waterMap.cells.h[0] = 10;
  waterMap.cells.t[0] = -1;
  assert.equal(computeTerrainCellColor(waterMap, 0, 'terrain', true), '#1c5278');
  assert.equal(computeTerrainCellColor(waterMap, 0, 'terrain', false), '#1c5278');
  waterMap.cells.h[0] = 5;
  waterMap.cells.t[0] = -2;
  assert.equal(computeTerrainCellColor(waterMap, 0, 'terrain', true), '#0f3550');
  assert.equal(computeTerrainCellColor(waterMap, 0, 'terrain', false), '#0f3550');
});

test('回归：nameBases 段含裸 LF 时按 CRLF 拆段不错位，rivers 与 originalMapRecords 完整保留', () => {
  const records = source.split('\r\n');
  const injected = [...records];
  injected[31] = `${records[31]}\n/Japanese|4|10||0|\n/自定义中亚|5|12||0|阿布斯坦,伊尔巴德`;
  const parsed = parseWorkingMap(injected.join('\r\n'));
  assert.equal(parsed.rivers.length, map.rivers.length);
  assert.equal(parsed.cells.count, map.cells.count);
  const keptRecords = originalMapRecords(parsed);
  assert.equal(keptRecords.length, records.length);
  assert.equal(keptRecords[31], injected[31]);
  assert.equal(keptRecords[32], records[32]);
});

test('城市名手动大小与动态双开关仅影响城市名，不动国名与省名', () => {
  const labelLayer = new Container();
  const burgMarkers = new Graphics();
  rebuildMapLabels(labelLayer, burgMarkers, map);
  const stateCount = map.states.filter(s => s.i > 0 && !s.removed && s.name && s.pole).length;
  const provCount = map.provinces.filter(p => p.i > 0 && !p.removed && p.name).length;
  const cityCount = map.burgs.filter(b => !b.removed && b.name && b.tier === 'city').length;
  const sampleState = labelLayer.children[0];
  const sampleCity = labelLayer.children[stateCount + provCount];
  assert.ok(sampleState && sampleCity && cityCount > 0);

  // 1. 默认开启分级与随缩放：Level 1 (0.9x) 普通城市隐藏；放大到 3.5x 时国名与城市名均应用 boost
  updateLabelLod(burgMarkers, 'state', 0.9, true, { cityScale: 1, cityZoomBoost: true, cityDynamicLod: true });
  assert.equal(sampleCity.visible, false);
  const stateScaleAt09 = sampleState.scale.x;

  updateLabelLod(burgMarkers, 'state', 3.5, true, { cityScale: 1, cityZoomBoost: true, cityDynamicLod: true });
  const stateScaleAt35Default = sampleState.scale.x;

  // 2. 关闭随缩放 + 手动调城市名大小到 1.6x + 关闭分级显示：普通城市全显且按固定 1.6x 缩放，国名缩放完全不变
  updateLabelLod(burgMarkers, 'state', 3.5, true, { cityScale: 1.6, cityZoomBoost: false, cityDynamicLod: false });
  assert.equal(sampleCity.visible, true);
  assert.ok(Math.abs(sampleCity.scale.x - (1.6 / 3.5)) < 1e-6);
  assert.ok(Math.abs(sampleState.scale.x - stateScaleAt35Default) < 1e-6, '城市名设置不得影响国名字号');

  // 3. 在全图低倍率 (0.9x) 下关闭分级显示，普通城市依然全部常驻可见，国名仍保持原 0.9x 缩放
  updateLabelLod(burgMarkers, 'state', 0.9, true, { cityScale: 0.7, cityZoomBoost: false, cityDynamicLod: false });
  const visibleCities = labelLayer.children
    .slice(stateCount + provCount, stateCount + provCount + cityCount)
    .filter(node => node.visible).length;
  assert.equal(visibleCities, cityCount);
  assert.ok(Math.abs(sampleCity.scale.x - (0.7 / 0.9)) < 1e-6);
  assert.ok(Math.abs(sampleState.scale.x - stateScaleAt09) < 1e-6);
});

test('Bug #27 回归：城邑编辑器前置拦截同 Voronoi 地块新建与拖入双城，允许自身格内微调与已删城邑地块复用', () => {
  const edited = structuredClone(map);
  const activeBurgs = edited.burgs.filter((b) => !b.removed);
  assert.ok(activeBurgs.length >= 2, 'fixture 应至少包含两座活跃城邑');
  const burgA = activeBurgs[0];
  const burgB = activeBurgs[1];
  assert.notEqual(burgA.cell, burgB.cell);

  // 找一个空闲陆地格与一个海洋格
  const occupiedCells = new Set(activeBurgs.map((b) => b.cell));
  let emptyLandCell = -1;
  let oceanCell = -1;
  for (let c = 0; c < edited.cells.count; c++) {
    if (edited.cells.h[c] >= 20 && !occupiedCells.has(c) && emptyLandCell < 0) emptyLandCell = c;
    if (edited.cells.h[c] < 20 && oceanCell < 0) oceanCell = c;
    if (emptyLandCell >= 0 && oceanCell >= 0) break;
  }
  assert.ok(emptyLandCell >= 0 && oceanCell >= 0);

  // 1. 纯校验逻辑：占用拦截、自身排除、海洋拦截、已删除城邑不拦截
  assert.equal(findBurgOccupyingCell(edited, burgB.cell)?.i, burgB.i);
  assert.equal(findBurgOccupyingCell(edited, burgB.cell, burgB.i), null);
  assert.deepEqual(canPlaceBurgAtCell(edited, burgB.cell), {
    ok: false,
    reason: 'occupied',
    occupant: burgB,
  });
  assert.deepEqual(canPlaceBurgAtCell(edited, burgB.cell, burgA.i), {
    ok: false,
    reason: 'occupied',
    occupant: burgB,
  });
  assert.deepEqual(canPlaceBurgAtCell(edited, burgA.cell, burgA.i), { ok: true });
  assert.deepEqual(canPlaceBurgAtCell(edited, emptyLandCell), { ok: true });
  assert.deepEqual(canPlaceBurgAtCell(edited, oceanCell), { ok: false, reason: 'not-land' });

  // 已删除城邑所在陆地格允许重新建城
  const removedCopy = structuredClone(edited);
  removedCopy.burgs.find((b) => b.i === burgB.i).removed = true;
  assert.deepEqual(canPlaceBurgAtCell(removedCopy, burgB.cell), { ok: true });

  // 2. 端到端指针交互：新建点击被占用格与拖拽落入被占用格均被前置拒绝
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const windowListeners = new Map();
  const canvasListeners = new Map();

  class MockNode {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.id = '';
      this.className = '';
      this.style = {};
      this.hidden = false;
      this.textContent = '';
      this.children = [];
      this.attrs = {};
      this.ownerDocument = null;
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(child) { this.children.push(child); return child; }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    remove() {}
    querySelector(sel) {
      if (sel.startsWith('#')) {
        const id = sel.slice(1);
        return this.children.find((c) => c.id === id) ?? null;
      }
      return null;
    }
  }

  const head = new MockNode('head');
  const mockDoc = {
    head,
    getElementById: (id) => head.children.find((c) => c.id === id) ?? null,
    createElement: (tag) => {
      const node = new MockNode(tag);
      node.ownerDocument = mockDoc;
      return node;
    },
  };
  const mount = mockDoc.createElement('div');
  const mockCanvas = {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: edited.width, height: edited.height }),
    addEventListener: (type, fn) => {
      if (!canvasListeners.has(type)) canvasListeners.set(type, []);
      canvasListeners.get(type).push(fn);
    },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
  };

  globalThis.document = mockDoc;
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener: () => {},
  };

  const dispatchCanvas = (type, evt) => {
    for (const fn of canvasListeners.get(type) ?? []) fn(evt);
  };
  const dispatchWindow = (type, evt) => {
    for (const fn of windowListeners.get(type) ?? []) fn(evt);
  };

  const prevMapData = appStore.mapData;
  const prevMode = appStore.interactionMode;
  const prevToMapCoords = appStore.toMapCoords;
  let entityChangedCount = 0;
  const onEntityChanged = () => { entityChangedCount += 1; };
  appStore.on('entity:changed', onEntityChanged);

  try {
    // 仅保留两座距离充足的测试城邑，避免随机邻城落入探针命中半径
    const pairMap = structuredClone(edited);
    pairMap.burgs = [structuredClone(burgA), structuredClone(burgB)];
    const testBurgA = pairMap.burgs[0];
    const testBurgB = pairMap.burgs[1];
    testBurgA.x = 120;
    testBurgA.y = 120;
    testBurgB.x = 420;
    testBurgB.y = 220;
    appStore.mapData = pairMap;
    appStore.interactionMode = 'burg-edit';
    terrainContainer.worldTransform.a = 1;
    appStore.toMapCoords = (x, y) => [x, y];

    // 精确映射测试坐标到目标 Voronoi 地块
    const baseLocate = cellLocatorFor(pairMap);
    const locateOverride = (x, y) => {
      if (Math.hypot(x - (testBurgB.x + 25), y - testBurgB.y) < 1) return testBurgB.cell;
      if (Math.hypot(x - testBurgB.x, y - testBurgB.y) < 1) return testBurgB.cell;
      return baseLocate(x, y);
    };

    initBurgEditor(mockCanvas, mount, locateOverride);

    // 场景 A：点击同一地块内空白偏置处（距 testBurgB 25px > HIT_RADIUS_PX，但仍落在 testBurgB.cell）：拒绝弹出新建弹窗并提示冲突
    dispatchCanvas('pointerdown', {
      button: 0, pointerId: 1, clientX: testBurgB.x + 25, clientY: testBurgB.y, preventDefault() {},
    });
    dispatchWindow('pointerup', {
      button: 0, pointerId: 1, clientX: testBurgB.x + 25, clientY: testBurgB.y, preventDefault() {},
    });
    assert.equal(mount.querySelector('#wenyou-burg-editor-overlay'), null, '被占用地块不得打开新建城邑弹窗');
    const noticeAfterCreate = mount.querySelector('#wenyou-burg-editor-notice');
    assert.ok(noticeAfterCreate && noticeAfterCreate.hidden === false, '应显示冲突提示');
    assert.match(noticeAfterCreate.textContent, /每格仅允许一座城市/);

    // 场景 B：将 testBurgA 拖拽到 testBurgB 所在 Voronoi 地块松手：拒绝落点并保持原位，不触发 entity:changed
    const origX = testBurgA.x;
    const origY = testBurgA.y;
    const origCell = testBurgA.cell;
    const origState = testBurgA.state;
    const origProvince = testBurgA.province;

    dispatchCanvas('pointerdown', {
      button: 0, pointerId: 2, clientX: origX, clientY: origY, preventDefault() {},
    });
    dispatchWindow('pointermove', {
      pointerId: 2, clientX: testBurgB.x, clientY: testBurgB.y, target: mockCanvas, preventDefault() {},
    });
    dispatchWindow('pointerup', {
      button: 0, pointerId: 2, clientX: testBurgB.x, clientY: testBurgB.y, preventDefault() {},
    });

    assert.equal(testBurgA.x, origX);
    assert.equal(testBurgA.y, origY);
    assert.equal(testBurgA.cell, origCell);
    assert.equal(testBurgA.state, origState);
    assert.equal(testBurgA.province, origProvince);
    assert.equal(entityChangedCount, 0, '拖入已被占用地块不应触发 entity:changed');
    assert.equal(mount.querySelector('#wenyou-burg-editor-notice').hidden, false);

    // 清理内部 notice 计时器避免测试进程挂起
    appStore.emit('theater:leaving');
  } finally {
    appStore.off('entity:changed', onEntityChanged);
    appStore.mapData = prevMapData;
    appStore.interactionMode = prevMode;
    appStore.toMapCoords = prevToMapCoords;
    if (prevWindow === undefined) delete globalThis.window;
    else globalThis.window = prevWindow;
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
  }
});
