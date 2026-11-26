import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});
after(() => server.close());

const paint = await server.ssrLoadModule('/src/field-battle-paint.ts');
const { appStore } = await server.ssrLoadModule('/src/store.ts');
const { FIELD_BATTLE_DOM } = await server.ssrLoadModule('/src/field-battle-types.ts');

function makeMockMap(count = 5) {
  // 构造一排相邻的正方形地块：
  // 地块 i 范围：x 从 i*10 到 (i+1)*10，y 从 0 到 10
  const polygons = [];
  const p = [];
  const c = [];

  for (let i = 0; i < count; i++) {
    const minX = i * 10;
    const maxX = (i + 1) * 10;
    polygons.push([
      [minX, 0],
      [maxX, 0],
      [maxX, 10],
      [minX, 10],
    ]);
    p.push([(minX + maxX) / 2, 5]);

    const neighbors = [];
    if (i > 0) neighbors.push(i - 1);
    if (i < count - 1) neighbors.push(i + 1);
    c.push(neighbors);
  }

  return {
    width: count * 10,
    height: 10,
    cells: {
      count,
      polygons,
      p,
      c,
    },
    burgs: [],
    states: [],
    provinces: [],
    religions: [],
    rivers: [],
    biomes: [],
    lakes: [],
  };
}

test('导出纯函数用于测试：pointInRing、segmentCellIntervals、isConnected、canAdd', () => {
  assert.equal(typeof paint.pointInRing, 'function');
  assert.equal(typeof paint.segmentCellIntervals, 'function');
  assert.equal(typeof paint.isConnected, 'function');
  assert.equal(typeof paint.canAdd, 'function');
});

test('pointInRing: 内部、外部、边界以及只碰顶点判定', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];

  // 严格在内部
  assert.equal(paint.pointInRing([5, 5], square, false), true);
  // 在外部
  assert.equal(paint.pointInRing([15, 5], square, false), false);
  // 在边上（includeBoundary=false 时不算）
  assert.equal(paint.pointInRing([0, 5], square, false), false);
  assert.equal(paint.pointInRing([0, 5], square, true), true);
  // 只碰顶点（includeBoundary=false 时不算）
  assert.equal(paint.pointInRing([0, 0], square, false), false);
  assert.equal(paint.pointInRing([0, 0], square, true), true);

  // 闭合环（首尾相接）与未闭合环均支持
  const closedSquare = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  assert.equal(paint.pointInRing([5, 5], closedSquare, false), true);
  assert.equal(paint.pointInRing([0, 0], closedSquare, false), false);
});

test('segmentCellIntervals: 穿格求交、按沿线 t 排序与只碰顶点不选', () => {
  const squareA = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const squareB = [
    [10, 0],
    [20, 0],
    [20, 10],
    [10, 10],
  ];
  const squareC = [
    [20, 0],
    [30, 0],
    [30, 10],
    [20, 10],
  ];

  // 1. 穿过多边形返回合法参数区间
  const intervalSingle = paint.segmentCellIntervals([2, 5], [8, 5], squareA);
  assert.ok(intervalSingle);
  assert.equal(intervalSingle.t0, 0);
  assert.equal(intervalSingle.t1, 1);

  // 2. 快速斜线穿过 A、B、C 三个相邻格：按沿线 t 排序且只选实际穿过的格
  const candidates = [
    { id: 2, polygon: squareC },
    { id: 0, polygon: squareA },
    { id: 1, polygon: squareB },
  ];
  const hit = paint.segmentCellIntervals([5, 5], [25, 5], candidates);
  assert.equal(hit.length, 3);
  // 必须按进入沿线 t 升序排序：0 -> 1 -> 2
  assert.equal(hit[0].id, 0);
  assert.equal(hit[1].id, 1);
  assert.equal(hit[2].id, 2);
  assert.ok(hit[0].t0 < hit[1].t0);
  assert.ok(hit[1].t0 < hit[2].t0);

  // 3. 只碰顶点不选：线段仅擦过外围顶点 (0, 0)，未进入内部
  const touchingCorner = paint.segmentCellIntervals([-5, 0], [0, -5], squareA);
  assert.equal(touchingCorner, null);

  // 4. 沿外部棱线擦过：未进入多边形内部，返回 null
  const alongEdge = paint.segmentCellIntervals([-5, 0], [15, 0], squareA);
  assert.equal(alongEdge, null);
});

test('canAdd: 首格任意、不相邻不选、重复不选、2000 格上限与地图越界', () => {
  const map = makeMockMap(5);

  // 首格任意
  assert.equal(paint.canAdd(new Set(), 2, map), true);

  // 选中 2 后，相邻的 1 和 3 可加
  const selected = new Set([2]);
  assert.equal(paint.canAdd(selected, 1, map), true);
  assert.equal(paint.canAdd(selected, 3, map), true);

  // 不相邻不选：地块 0 和 4 不与 2 相邻
  assert.equal(paint.canAdd(selected, 0, map), false);
  assert.equal(paint.canAdd(selected, 4, map), false);

  // 已选地块不能重复添加
  assert.equal(paint.canAdd(selected, 2, map), false);

  // 地块越界无效（地图外坐标/负数/超出范围）
  assert.equal(paint.canAdd(selected, -1, map), false);
  assert.equal(paint.canAdd(selected, 999, map), false);

  // 2000 格上限：达到后禁止添加
  const full = new Set(Array.from({ length: 2000 }, (_, i) => i));
  assert.equal(paint.canAdd(full, 2001, map, 2000), false);
});

test('isConnected: BFS 连通性检查与擦除断开被拒', () => {
  const map = makeMockMap(5);

  // 空集合或单格天然连通
  assert.equal(paint.isConnected([], map), true);
  assert.equal(paint.isConnected([1], map), true);

  // 0 - 1 - 2 连通
  assert.equal(paint.isConnected([0, 1, 2], map), true);

  // 擦除 1 导致剩余 [0, 2] 断开（擦除被拒判据）
  assert.equal(paint.isConnected([0, 2], map), false);

  // 擦除 2 剩余 [0, 1] 仍然连通（允许擦除）
  assert.equal(paint.isConnected([0, 1], map), true);
});

test('生成战场：组装 FieldBattle、测试注入 stub、事件通知与状态退出', () => {
  const map = makeMockMap(3);
  appStore.mapData = map;
  appStore.garrisons = [
    {
      id: 'unit-1',
      unitName: '前锋团',
      troops: 1000,
      color: '#3b82f6',
      status: '驻防',
      x: 5,
      y: 5,
    },
  ];
  appStore.battle = {
    schemaVersion: 1,
    sources: [],
    battlefields: [],
    deployments: [],
  };

  const stubTerrain = {
    displayOutline: [],
    battleOutline: [],
    contextOutline: [],
    cells: [],
    coastBands: [],
    lakes: [],
    rivers: [],
    coastlines: [],
    contours: [],
    burgs: [],
  };

  let skippedWarn = 0;
  const originalAlert = globalThis.window?.alert;
  if (typeof globalThis.window === 'undefined') {
    globalThis.window = { alert: () => skippedWarn++ };
  } else {
    globalThis.window.alert = () => skippedWarn++;
  }

  paint.setFieldBattlePaintDeps({
    buildFieldTerrainSnapshot: (_map, selected) => {
      assert.deepEqual([...selected], [0, 1]);
      return stubTerrain;
    },
    copyBattleUnitsIntoField: (_map, _selected, _units, _battle) => {
      return {
        units: [
          {
            id: 'field-unit-1',
            sourceUnitId: 'unit-1',
            unitName: '前锋团',
            troops: 1000,
            color: '#3b82f6',
            status: '驻防',
          },
        ],
        deployments: [],
        sources: [],
        skippedUnknown: 2,
      };
    },
  });

  paint.enterFieldBattlePaint();
  assert.equal(appStore.interactionMode, 'fieldbattle-paint');

  // 手工加入连通地块 0 和 1
  const selected = paint.getSelectedCells();
  selected.add(0);
  selected.add(1);

  const events = [];
  appStore.on('fieldbattle:changed', (e) => events.push(e));

  const battle = paint.generateFieldBattle('赤壁');
  assert.ok(battle);
  assert.equal(battle.name, '赤壁');
  assert.deepEqual(battle.cellIds, [0, 1]);
  assert.equal(typeof battle.id, 'string');
  assert.ok(battle.id.length > 0);
  assert.equal(battle.terrain, stubTerrain);
  assert.equal(battle.units.length, 1);
  assert.equal(battle.units[0].sourceUnitId, 'unit-1');
  assert.ok(battle.bounds);
  assert.ok(battle.anchor);

  // 生成后退出模式并推入 store
  assert.equal(appStore.interactionMode, 'pan');
  assert.equal(appStore.fieldBattles.length, 1);
  assert.equal(appStore.fieldBattles[0].id, battle.id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { battleId: battle.id, kind: 'create' });
  assert.equal(skippedWarn, 1);

  if (originalAlert) {
    globalThis.window.alert = originalAlert;
  }
});

test('tactical-toolbar.ts 包含全部 7 个涂选 DOM 钩子且符合 contract.md', async () => {
  const code = await readFile(
    new URL('../src/tactical-toolbar.ts', import.meta.url),
    'utf8',
  );

  assert.ok(code.includes('tactical-add-fieldbattle'), '包含 #tactical-add-fieldbattle');
  assert.ok(code.includes('fieldbattle-paint-panel'), '包含 #fieldbattle-paint-panel');
  assert.ok(code.includes('fieldbattle-paint-name'), '包含 #fieldbattle-paint-name');
  assert.ok(code.includes('fieldbattle-paint-count'), '包含 #fieldbattle-paint-count');
  assert.ok(code.includes('fieldbattle-generate'), '包含 #fieldbattle-generate');
  assert.ok(code.includes('fieldbattle-clear'), '包含 #fieldbattle-clear');
  assert.ok(code.includes('fieldbattle-cancel'), '包含 #fieldbattle-cancel');

  // 验证选择器常数对应值
  assert.equal(FIELD_BATTLE_DOM.tacticalAdd, '#tactical-add-fieldbattle');
  assert.equal(FIELD_BATTLE_DOM.paintPanel, '#fieldbattle-paint-panel');
  assert.equal(FIELD_BATTLE_DOM.paintName, '#fieldbattle-paint-name');
  assert.equal(FIELD_BATTLE_DOM.paintCount, '#fieldbattle-paint-count');
  assert.equal(FIELD_BATTLE_DOM.generate, '#fieldbattle-generate');
  assert.equal(FIELD_BATTLE_DOM.clear, '#fieldbattle-clear');
  assert.equal(FIELD_BATTLE_DOM.cancel, '#fieldbattle-cancel');
});

test('涂选模式生命周期：进入、清空与取消', () => {
  paint.enterFieldBattlePaint();
  assert.equal(appStore.interactionMode, 'fieldbattle-paint');

  paint.getSelectedCells().add(0);
  assert.equal(paint.getSelectedCellCount(), 1);

  paint.clearFieldBattlePaint();
  assert.equal(paint.getSelectedCellCount(), 0);
  assert.equal(appStore.interactionMode, 'fieldbattle-paint');

  paint.getSelectedCells().add(0);
  paint.cancelFieldBattlePaint();
  assert.equal(paint.getSelectedCellCount(), 0);
  assert.equal(appStore.interactionMode, 'pan');
});

test('回归：深海空域/越界坐标连续涂选拖动不抛 intervals is not iterable 异常', async () => {
  const { initMapRenderer } = await server.ssrLoadModule('/src/map-renderer.ts');
  const { CanvasTextMetrics } = await import('pixi.js');

  const prevToMapCoords = appStore.toMapCoords;
  const prevMapData = appStore.mapData;
  const prevMode = appStore.interactionMode;
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const origMeasure = CanvasTextMetrics.measureText;

  try {
    CanvasTextMetrics.measureText = (text, style) => ({
      width: Array.from(String(text)).length * (style?.fontSize ?? 12),
      height: (style?.fontSize ?? 12) * 1.2,
    });
    if (typeof globalThis.document === 'undefined') {
      globalThis.document = {
        createElement: () => ({
          style: {},
          getContext: () => ({
            measureText: (t) => ({ width: String(t).length * 8 }),
            fillText: () => {},
            clearRect: () => {},
            getImageData: () => ({ data: [] }),
            putImageData: () => {},
            setTransform: () => {},
            resetTransform: () => {},
            drawImage: () => {},
          }),
          width: 100,
          height: 100,
        }),
        querySelector: () => null,
      };
    }
    globalThis.window = {
      ...(prevWindow ?? {}),
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const sparseMap = {
      width: 100,
      height: 100,
      source: { mapId: 'sparse', name: 'sparse', coords: null, originalMap: null },
      cells: {
        count: 2,
        polygons: [
          [[0, 0], [10, 0], [0, 10]],
          [[10, 0], [20, 0], [20, 10], [10, 10]],
        ],
        p: [[2, 2], [15, 5]],
        c: [[1], [0]],
        h: new Uint8Array([30, 30]),
        state: new Uint16Array([0, 0]),
        province: new Uint16Array([0, 0]),
        religion: new Uint16Array([0, 0]),
        fl: new Uint16Array([0, 0]),
        g: new Uint16Array([0, 0]),
        biome: new Uint8Array([0, 0]),
        t: new Int8Array([1, 1]),
      },
      burgs: [],
      states: [{ i: 0, name: '中立地', color: '#c4c1b0', removed: false }],
      provinces: [],
      religions: [{ i: 0, name: '无信仰', color: '#c9c6bb', removed: false }],
      rivers: [],
      biomes: [{ i: 0, name: '草原', color: '#88aa66' }],
      lakes: [],
    };
    appStore.mapData = sparseMap;
    appStore.toMapCoords = (x, y) => [x, y];

    const listeners = new Map();
    const canvas = {
      style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      addEventListener: (type, fn) => {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener: () => {},
    };
    const dispatch = (type, evt) => {
      for (const fn of listeners.get(type) ?? []) fn(evt);
    };

    initMapRenderer({ ticker: { add() {} } }, canvas);
    appStore.emit('map:loaded', sparseMap);
    paint.initFieldBattlePaint({ querySelector: () => null }, canvas);
    paint.enterFieldBattlePaint();

    // 先在合法地块 0 内部按下，进入 painting 状态
    dispatch('pointerdown', { button: 0, altKey: false, clientX: 2, clientY: 2 });
    assert.equal(paint.getSelectedCellCount(), 1);

    // 依次拖过：同包络框多边形外、空白海洋坐标（无候选地块）、负越界与正越界坐标
    for (const [clientX, clientY] of [[9, 9], [10, 8], [50, 50], [80, 80], [-50, -50], [500, 500], [15, 5]]) {
      dispatch('pointermove', { altKey: false, clientX, clientY });
    }
    dispatch('pointerup', { clientX: 15, clientY: 5 });
    assert.ok(paint.getSelectedCellCount() >= 1);
  } finally {
    paint.cancelFieldBattlePaint();
    CanvasTextMetrics.measureText = origMeasure;
    appStore.toMapCoords = prevToMapCoords;
    appStore.mapData = prevMapData;
    appStore.interactionMode = prevMode;
    if (prevWindow !== undefined) globalThis.window = prevWindow;
    else delete globalThis.window;
    if (prevDocument !== undefined) globalThis.document = prevDocument;
    else delete globalThis.document;
  }
});
