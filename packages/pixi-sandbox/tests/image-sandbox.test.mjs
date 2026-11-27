import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const { appStore } = await server.ssrLoadModule('/src/store.ts');
const {
  DEFAULT_IMAGE_OVERLAY_ALPHA,
  computeHexRadiusForPreset,
  createImageBaseSpec,
  buildImageHexMapData,
  isImageBaseSource,
  parseImageBaseSpec,
  serializeImageBaseSpecFromMap,
  probeImageDimensions,
} = await server.ssrLoadModule('/src/image-map-builder.ts');
const { parseWorkingMap } = await server.ssrLoadModule('/src/map-loader.ts');
const { serializeMap, originalMapRecords } = await server.ssrLoadModule('/src/map-serializer.ts');
const { serializeProject, parseProject } = await server.ssrLoadModule('/src/project-serializer.ts');
const { captureTheater, readTheater, saveTheater } = await server.ssrLoadModule('/src/theater-cache.ts');
const { migrateLegacyBattle } = await server.ssrLoadModule('/src/battle-storage.ts');
const { computeCellSearchRadius, cellLocatorFor, syncBurgsForPaintedCells } = await server.ssrLoadModule('/src/map-renderer.ts');
const { computeSafeTextureDimensions, buildWorkspaceVaultFallbackUrl } = await server.ssrLoadModule('/src/retouch-layer.ts');

const fmgFixture = await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');

test('预设密度反推六角半径夹紧 10..80，并准确换算比例尺 kmPerPixel', () => {
  const rCoarse = computeHexRadiusForPreset(2400, 1500, 'coarse');
  const rStandard = computeHexRadiusForPreset(2400, 1500, 'standard');
  const rFine = computeHexRadiusForPreset(2400, 1500, 'fine');
  assert.ok(rCoarse > rStandard && rStandard > rFine);
  assert.ok(rFine >= 10 && rCoarse <= 80);

  // 极端小图与极大图的夹紧边界
  assert.equal(computeHexRadiusForPreset(100, 100, 'fine'), 10);
  assert.equal(computeHexRadiusForPreset(40000, 40000, 'coarse'), 80);

  const spec = createImageBaseSpec({
    name: '东欧战区.png',
    width: 2000,
    height: 1200,
    imageUrl: 'wenyou-asset://vault?cwd=test&path=maps%2Feast.png',
    imageRelPath: '05-沙盘与图集/east.png',
    gridPreset: 'standard',
    mapWidthKm: 1500,
  });
  assert.equal(spec.wenyouImageBase, 1);
  assert.equal(spec.mapWidthKm, 1500);
  assert.equal(spec.kmPerPixel, 0.75);
  assert.equal(spec.overlayAlpha, DEFAULT_IMAGE_OVERLAY_ALPHA);
  assert.match(spec.mapId, /^img-.+-2000x1200-r\d+$/);
});

test('Pointy-top Odd-R 虚拟六角网格生成：确定性几何、严格对称六邻接与零误差共享边', () => {
  const spec = createImageBaseSpec({
    name: 'hex-check',
    width: 320,
    height: 220,
    hexRadius: 20,
    imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
  });
  const map = buildImageHexMapData(spec);

  const dx = Math.sqrt(3) * 20;
  const dy = 1.5 * 20;
  const cols = Math.max(2, Math.ceil(320 / dx));
  const rows = Math.max(2, Math.ceil(220 / dy));
  const expectedCount = rows * cols;

  assert.equal(map.source.baseKind, 'image');
  assert.equal(map.cells.count, expectedCount);
  assert.equal(map.cells.polygons.length, expectedCount);
  assert.equal(map.cells.p.length, expectedCount);
  assert.equal(map.cells.c.length, expectedCount);
  assert.equal(map.states.length, 6);
  assert.equal(map.states[1].name, '红方势力');

  // 基础数组初始化校验
  for (let i = 0; i < expectedCount; i++) {
    assert.equal(map.cells.h[i], 25);
    assert.equal(map.cells.state[i], 0);
    assert.equal(map.cells.province[i], 0);
    assert.equal(map.cells.religion[i], 0);
    assert.equal(map.cells.r[i], 0);
    assert.equal(map.cells.fl[i], 0);
    assert.equal(map.cells.biome[i], 0);
    assert.equal(map.cells.g[i], i);
    assert.equal(map.cells.t[i], 1);
    assert.equal(map.cells.polygons[i].length, 6);
    assert.ok(map.cells.polygons[i].every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  }

  // 严格对称邻接、无自环无越界无重复，且每对邻居恰好共享 2 个完全一致顶点
  const edgeKey = (a, b) => {
    const ka = `${Math.round(a[0] * 100)},${Math.round(a[1] * 100)}`;
    const kb = `${Math.round(b[0] * 100)},${Math.round(b[1] * 100)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  const cellEdges = map.cells.polygons.map((poly) => {
    const set = new Set();
    for (let k = 0; k < poly.length; k++) {
      set.add(edgeKey(poly[k], poly[(k + 1) % poly.length]));
    }
    return set;
  });

  for (let i = 0; i < expectedCount; i++) {
    const neighbors = map.cells.c[i];
    const unique = new Set(neighbors);
    assert.equal(unique.size, neighbors.length, `cell ${i} 邻接含重复`);
    assert.equal(unique.has(i), false, `cell ${i} 不得自环`);
    const row = Math.floor(i / cols);
    const col = i % cols;
    if (row > 0 && row < rows - 1 && col > 0 && col < cols - 1) {
      assert.equal(neighbors.length, 6, `内部格 (${row},${col}) 应恰好有 6 邻`);
    }
    for (const n of neighbors) {
      assert.ok(n >= 0 && n < expectedCount, `邻居索引 ${n} 越界`);
      assert.ok(map.cells.c[n].includes(i), `邻接不对称：${i} -> ${n} 但缺少反向边`);
      let shared = 0;
      for (const ek of cellEdges[i]) {
        if (cellEdges[n].has(ek)) shared++;
      }
      assert.equal(shared, 1, `相邻六角格 ${i} 与 ${n} 应严格共享 1 条公共棱`);
    }
  }
});

test('map-loader 分派图片底图与 FMG 底图；serializeMap 明确拦截图片底图导出 .map', () => {
  const fmgMap = parseWorkingMap(fmgFixture);
  assert.equal(fmgMap.source.baseKind, 'fmg');
  assert.equal(isImageBaseSource(fmgFixture), false);

  const spec = createImageBaseSpec({
    name: '中亚战区',
    width: 400,
    height: 300,
    hexRadius: 24,
    imageUrl: 'data:image/png;base64,AAAA',
    mapWidthKm: 800,
  });
  const built = buildImageHexMapData(spec);
  assert.equal(isImageBaseSource(built.source.originalMap), true);

  const reparsed = parseWorkingMap(built.source.originalMap);
  assert.equal(reparsed.source.baseKind, 'image');
  assert.equal(reparsed.source.mapId, built.source.mapId);
  assert.equal(reparsed.cells.count, built.cells.count);
  assert.deepEqual(parseImageBaseSpec(reparsed.source.originalMap).kmPerPixel, 2);

  assert.throws(
    () => serializeMap(reparsed),
    /当前战区基于静态图片底图创建，不支持导出为 FMG \.map；请点击「导出推演工程」完整保存版图、修补笔划与兵牌/,
  );
});

test('图片战区（及混合多战区）ProjectArchive v4 完整往返：疆域、城邦、兵牌、修补笔划、透明度与比例尺', () => {
  const fmgMap = parseWorkingMap(fmgFixture);
  const spec = createImageBaseSpec({
    name: '地中海图集',
    width: 640,
    height: 400,
    hexRadius: 24,
    imageUrl: 'wenyou-asset://vault?cwd=demo&path=05-med.png',
    imageRelPath: '05-沙盘与图集/med.png',
    mapWidthKm: 1280,
    overlayAlpha: 0.42,
  });
  const imageMap = buildImageHexMapData(spec);

  // 涂改疆域、添加城邦、修改透明度/比例尺、添加修补笔划与兵牌/战线
  imageMap.cells.state[0] = 1;
  imageMap.cells.state[1] = 1;
  imageMap.cells.state[2] = 2;
  imageMap.states[1].name = '东地中海同盟';
  imageMap.states[1].capital = 1;
  imageMap.burgs.push({
    i: 1,
    name: '君士坦丁堡',
    x: imageMap.cells.p[0][0],
    y: imageMap.cells.p[0][1],
    cell: 0,
    state: 1,
    province: 0,
    capital: 1,
    port: 1,
    tier: 'capital',
    population: 85,
  });
  imageMap.source.overlayAlpha = 0.55;
  imageMap.source.mapWidthKm = 1600;
  imageMap.source.kmPerPixel = 1600 / imageMap.width;
  imageMap.source.retouchStrokes = [
    {
      id: 'stroke-erase-1',
      color: '#d4c9a8',
      width: 28,
      points: [[120, 80], [160, 95], [210, 102]],
    },
  ];

  const battleData = migrateLegacyBattle(imageMap.source.mapId, [
    {
      id: 'u-med-1',
      provinceId: 0,
      unitName: '近卫第一军团',
      troops: 18500,
      color: '#ef4444',
      status: '行军',
      x: imageMap.cells.p[1][0],
      y: imageMap.cells.p[1][1],
    },
  ]);

  const imageTheater = {
    version: 4,
    mapData: imageMap,
    garrisons: battleData.garrisons,
    battle: battleData.battle,
    fieldBattles: [],
    tacticalItems: [
      { id: 'front-med', type: 'frontline', points: [[40, 50], [220, 140]], color: '#ef4444', width: 4, label: '海峡防线' },
    ],
  };
  const fmgTheater = {
    version: 4,
    mapData: fmgMap,
    garrisons: [],
    battle: { schemaVersion: 1, sources: [], battlefields: [], deployments: [] },
    fieldBattles: [],
    tacticalItems: [],
  };

  const jsonText = serializeProject([imageTheater, fmgTheater], imageMap.source.mapId);
  const parsedRaw = JSON.parse(jsonText);
  assert.equal(parsedRaw.format, 'wenyou-project');
  assert.equal(parsedRaw.version, 4);
  assert.equal(isImageBaseSource(parsedRaw.theaters[0].map.source), true);

  const restored = parseProject(jsonText);
  assert.equal(restored.activeMapId, imageMap.source.mapId);
  assert.equal(restored.theaters.length, 2);

  const restoredImg = restored.theaters[0];
  assert.equal(restoredImg.mapData.source.baseKind, 'image');
  assert.equal(restoredImg.mapData.source.imageUrl, 'wenyou-asset://vault?cwd=demo&path=05-med.png');
  assert.equal(restoredImg.mapData.source.imageRelPath, '05-沙盘与图集/med.png');
  assert.equal(restoredImg.mapData.source.overlayAlpha, 0.55);
  assert.equal(restoredImg.mapData.source.mapWidthKm, 1600);
  assert.equal(restoredImg.mapData.source.kmPerPixel, 2.5);
  assert.deepEqual(restoredImg.mapData.source.retouchStrokes, imageMap.source.retouchStrokes);
  assert.equal(restoredImg.mapData.cells.state[0], 1);
  assert.equal(restoredImg.mapData.cells.state[2], 2);
  assert.equal(restoredImg.mapData.burgs[0].name, '君士坦丁堡');
  assert.equal(restoredImg.garrisons[0].id, 'u-med-1');
  assert.equal(restoredImg.tacticalItems[0].id, 'front-med');

  // 独立隔离：修改恢复结果不得污染原始数据
  restoredImg.mapData.source.retouchStrokes[0].points[0][0] = 999;
  assert.equal(imageMap.source.retouchStrokes[0].points[0][0], 120);

  // 通用严格校验仍对图片战区生效
  const broken = JSON.parse(jsonText);
  broken.theaters[0].map.statesByCell[0] = 999;
  assert.throws(() => parseProject(JSON.stringify(broken)), /地块引用了不存在的实体/);

  // captureTheater 保留并深拷贝 retouchStrokes / overlayAlpha / kmPerPixel / mapWidthKm
  appStore.mapData = imageMap;
  appStore.mapId = imageMap.source.mapId;
  appStore.garrisons = battleData.garrisons;
  appStore.battle = battleData.battle;
  appStore.fieldBattles = [];
  appStore.tacticalItems = imageTheater.tacticalItems;
  const captured = captureTheater();
  assert.equal(captured.mapData.source.overlayAlpha, 0.55);
  assert.equal(captured.mapData.source.mapWidthKm, 1600);
  assert.equal(captured.mapData.source.kmPerPixel, 2.5);
  assert.deepEqual(captured.mapData.source.retouchStrokes, imageMap.source.retouchStrokes);
  captured.mapData.source.retouchStrokes[0].color = '#000000';
  assert.equal(imageMap.source.retouchStrokes[0].color, '#d4c9a8');
});

test('probeImageDimensions 正确读取自然宽高并对 0x0 SVG 兜底 1600x1000', async () => {
  const prevImage = globalThis.Image;
  try {
    globalThis.Image = class MockImage {
      constructor() {
        this.crossOrigin = '';
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        this.width = 0;
        this.height = 0;
      }
      set src(url) {
        queueMicrotask(() => {
          if (url.includes('ok.png')) {
            this.naturalWidth = 1920;
            this.naturalHeight = 1080;
            this.onload?.();
          } else if (url.includes('vector.svg')) {
            this.naturalWidth = 0;
            this.naturalHeight = 0;
            this.onload?.();
          } else {
            this.onerror?.(new Error('load fail'));
          }
        });
      }
    };

    assert.deepEqual(await probeImageDimensions('wenyou-asset://vault?path=ok.png'), { width: 1920, height: 1080 });
    assert.deepEqual(await probeImageDimensions('wenyou-asset://vault?path=vector.svg'), { width: 1600, height: 1000 });
    await assert.rejects(() => probeImageDimensions('wenyou-asset://vault?path=missing.png'), /加载失败/);
  } finally {
    if (prevImage) globalThis.Image = prevImage;
    else delete globalThis.Image;
  }
});

test('同名异目录纯 ASCII 图片战区按 disambiguator 消歧，避免 mapId 冲突覆盖', () => {
  const specA = createImageBaseSpec({
    name: 'map.png',
    width: 1600,
    height: 1000,
    hexRadius: 24,
    imageUrl: 'wenyou-asset://vault?cwd=w1&path=epoch1%2Fmap.png',
    imageRelPath: 'epoch1/map.png',
  });
  const specB = createImageBaseSpec({
    name: 'map.png',
    width: 1600,
    height: 1000,
    hexRadius: 24,
    imageUrl: 'wenyou-asset://vault?cwd=w1&path=epoch2%2Fmap.png',
    imageRelPath: 'epoch2/map.png',
  });
  const specA2 = createImageBaseSpec({
    name: 'map.png',
    width: 1600,
    height: 1000,
    hexRadius: 24,
    imageUrl: 'wenyou-asset://vault?cwd=w1&path=epoch1%2Fmap.png',
    imageRelPath: 'epoch1/map.png',
  });

  assert.notEqual(specA.mapId, specB.mapId);
  assert.equal(specA.mapId, specA2.mapId);
});

test('粗网格高分图片战区动态最近格命中半径无死区（hexRadius=80 全域 100% 命中）', () => {
  const spec = createImageBaseSpec({
    name: 'hi-res-coarse',
    width: 4000,
    height: 2400,
    hexRadius: 80,
    imageUrl: 'data:image/png;base64,AAAA',
  });
  const map = buildImageHexMapData(spec);
  assert.equal(computeCellSearchRadius(map), Math.ceil(80 * 2.2));

  const locate = cellLocatorFor(map);
  // 抽样包括六角格顶点（距中心 80px，旧 radius=48 会判为 -1）在内的全域网格点
  let misses = 0;
  let total = 0;
  for (let y = 40; y < map.height - 40; y += 73) {
    for (let x = 40; x < map.width - 40; x += 73) {
      total++;
      if (locate(x, y) < 0) misses++;
    }
  }
  assert.ok(total > 100);
  assert.equal(misses, 0, '粗网格图片战区不应出现任何点击死区');

  // 直接测试某个内部六角格最远顶点也能命中
  const sampleCell = Math.floor(map.cells.count / 2);
  const [vx, vy] = map.cells.polygons[sampleCell][0];
  assert.ok(locate(vx, vy) >= 0);
});

test('政权/省份笔刷同步城池归属与首都合法性，并通过 ProjectArchive 严格校验', () => {
  const fmgMap = parseWorkingMap(fmgFixture);
  const capitalBurg = fmgMap.burgs.find((b) => !b.removed && b.capital === 1 && b.state > 0);
  assert.ok(capitalBurg, 'fixture 应含至少一座首都');
  const oldStateId = capitalBurg.state;
  const targetState = fmgMap.states.find((s) => !s.removed && s.i > 0 && s.i !== oldStateId);
  assert.ok(targetState, 'fixture 应含另一有效国家');

  // 模拟政权笔刷把首都所在格刷给另一国家
  fmgMap.cells.state[capitalBurg.cell] = targetState.i;
  const changed = syncBurgsForPaintedCells(fmgMap, [capitalBurg.cell], 'state');
  assert.equal(changed, true);
  assert.equal(capitalBurg.state, targetState.i);
  assert.equal(capitalBurg.capital, 0);
  assert.equal(fmgMap.states.find((s) => s.i === oldStateId).capital, 0);

  // 必须通过 serializeProject -> parseProject 完整严格校验
  const theater = {
    version: 4,
    mapData: fmgMap,
    garrisons: [],
    battle: { schemaVersion: 1, sources: [], battlefields: [], deployments: [] },
    fieldBattles: [],
    tacticalItems: [],
  };
  const roundtrip = parseProject(serializeProject([theater], fmgMap.source.mapId));
  const restoredBurg = roundtrip.theaters[0].mapData.burgs.find((b) => b.i === capitalBurg.i);
  assert.equal(restoredBurg.state, targetState.i);
  assert.equal(restoredBurg.capital, 0);
});

test('FMG 矢量战区自定义比例尺序列化往返，且 originalMapRecords 放宽支持 1.x / 2.x 版本', () => {
  const fmgMap = parseWorkingMap(fmgFixture);
  fmgMap.source.mapWidthKm = 2864;
  fmgMap.source.kmPerPixel = 2864 / fmgMap.width;

  const theater = {
    version: 4,
    mapData: fmgMap,
    garrisons: [],
    battle: { schemaVersion: 1, sources: [], battlefields: [], deployments: [] },
    fieldBattles: [],
    tacticalItems: [],
  };
  const jsonText = serializeProject([theater], fmgMap.source.mapId);
  const restored = parseProject(jsonText);
  assert.equal(restored.theaters[0].mapData.source.mapWidthKm, 2864);
  assert.equal(restored.theaters[0].mapData.source.kmPerPixel, 2864 / fmgMap.width);

  // 非法比例尺被 parseProject 拦截
  const broken = JSON.parse(jsonText);
  broken.theaters[0].map.kmPerPixel = -5;
  assert.throws(() => parseProject(JSON.stringify(broken)), /kmPerPixel/);

  // originalMapRecords 支持 1.x 与 2.x 版本头
  const v2Map = structuredClone(fmgMap);
  v2Map.source.originalMap = v2Map.source.originalMap.replace(/^1\.\d+\.\d+/, '2.1.0');
  assert.ok(originalMapRecords(v2Map).length >= 33);

  const v140Map = structuredClone(fmgMap);
  v140Map.source.originalMap = v140Map.source.originalMap.replace(/^1\.\d+\.\d+/, '1.140.5');
  assert.ok(originalMapRecords(v140Map).length >= 33);

  const badVerMap = structuredClone(fmgMap);
  badVerMap.source.originalMap = badVerMap.source.originalMap.replace(/^1\.\d+\.\d+/, '3.0.0');
  assert.throws(() => originalMapRecords(badVerMap), /仅支持当前加载器的 FMG/);
});

test('超大图安全纹理等比降采样与失效 vault URL 按当前工作区回退重建', () => {
  assert.deepEqual(computeSafeTextureDimensions(4096, 2048, 8192), {
    width: 4096,
    height: 2048,
    downsampled: false,
  });
  assert.deepEqual(computeSafeTextureDimensions(12000, 6000, 8192), {
    width: 8192,
    height: 4096,
    downsampled: true,
  });
  assert.deepEqual(computeSafeTextureDimensions(6000, 12000, 4096), {
    width: 2048,
    height: 4096,
    downsampled: true,
  });

  const rebuilt = buildWorkspaceVaultFallbackUrl(
    'wenyou-asset://vault?cwd=old-dir&path=maps%2Fgaul.png',
    'maps/gaul.png',
    'new-dir',
  );
  assert.equal(rebuilt, 'wenyou-asset://vault?cwd=new-dir&path=maps%2Fgaul.png');

  // 与原 URL 一致时返回 null，防死循环重试
  assert.equal(
    buildWorkspaceVaultFallbackUrl('wenyou-asset://vault?cwd=new-dir&path=maps%2Fgaul.png', 'maps/gaul.png', 'new-dir'),
    null,
  );
  // 非 vault URL 或缺少 relPath/workspace 返回 null
  assert.equal(buildWorkspaceVaultFallbackUrl('data:image/png;base64,AA', 'maps/gaul.png', 'new-dir'), null);
  assert.equal(buildWorkspaceVaultFallbackUrl('wenyou-asset://vault?cwd=old&path=a.png', '', 'new-dir'), null);
  assert.equal(buildWorkspaceVaultFallbackUrl('wenyou-asset://vault?cwd=old&path=a.png', 'a.png', null), null);
});

test('Bug #26 回归：FMG 与图片底图清空全图宽度 (km) 后经 IndexedDB 落盘切换/重载不再复活旧比例尺', async () => {
  const prevIndexedDB = globalThis.indexedDB;
  const stores = new Map();

  function makeReq(executor) {
    const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
    queueMicrotask(() => {
      try {
        executor(req);
      } catch (err) {
        req.error = err;
        req.onerror?.({ target: req });
      }
    });
    return req;
  }

  globalThis.indexedDB = {
    open(dbName) {
      return makeReq((req) => {
        if (!stores.has(dbName)) stores.set(dbName, new Map());
        const dbStores = stores.get(dbName);
        const db = {
          onclose: null,
          createObjectStore(storeName) {
            if (!dbStores.has(storeName)) dbStores.set(storeName, new Map());
          },
          transaction(storeName) {
            if (!dbStores.has(storeName)) dbStores.set(storeName, new Map());
            const kv = dbStores.get(storeName);
            const tx = {
              oncomplete: null,
              onabort: null,
              onerror: null,
              error: null,
              abort() {
                tx.onabort?.();
              },
              objectStore() {
                return {
                  transaction: tx,
                  get(key) {
                    return makeReq((r) => {
                      r.result = kv.has(key) ? structuredClone(kv.get(key)) : undefined;
                      r.onsuccess?.();
                    });
                  },
                  getKey(key) {
                    return makeReq((r) => {
                      r.result = kv.has(key) ? key : undefined;
                      r.onsuccess?.();
                    });
                  },
                  put(val, key) {
                    kv.set(key, structuredClone(val));
                  },
                  delete(key) {
                    kv.delete(key);
                  },
                  clear() {
                    kv.clear();
                  },
                };
              },
            };
            queueMicrotask(() => {
              tx.oncomplete?.();
            });
            return tx;
          },
        };
        req.result = db;
        req.onupgradeneeded?.({ target: req });
        req.onsuccess?.({ target: req });
      });
    },
  };

  try {
    // 1. FMG 战区：首次落盘带比例尺（__base__ 中会写入旧 mapWidthKm / kmPerPixel）
    const fmgMap = parseWorkingMap(fmgFixture);
    fmgMap.source.mapWidthKm = 2864;
    fmgMap.source.kmPerPixel = 2864 / fmgMap.width;

    appStore.mapData = fmgMap;
    appStore.mapId = fmgMap.source.mapId;
    appStore.garrisons = [];
    appStore.battle = { schemaVersion: 1, sources: [], battlefields: [], deployments: [] };
    appStore.fieldBattles = [];
    appStore.tacticalItems = [];

    await saveTheater(captureTheater());
    const loadedWithScale = await readTheater(fmgMap.source.mapId);
    assert.equal(loadedWithScale?.mapData.source.mapWidthKm, 2864);
    assert.equal(loadedWithScale?.mapData.source.kmPerPixel, 2864 / fmgMap.width);

    // 清空 FMG 比例尺后再次落盘（此时 writeBases=false，仅写可编辑记录）
    delete fmgMap.source.mapWidthKm;
    delete fmgMap.source.kmPerPixel;
    await saveTheater(captureTheater());

    const loadedClearedFmg = await readTheater(fmgMap.source.mapId);
    assert.equal(loadedClearedFmg?.mapData.source.mapWidthKm, undefined);
    assert.equal(loadedClearedFmg?.mapData.source.kmPerPixel, undefined);
    assert.equal('mapWidthKm' in (loadedClearedFmg?.mapData.source ?? {}), false);
    assert.equal('kmPerPixel' in (loadedClearedFmg?.mapData.source ?? {}), false);

    // 2. 再次设置新比例尺后可正常覆盖保存
    fmgMap.source.mapWidthKm = 1800;
    fmgMap.source.kmPerPixel = 1800 / fmgMap.width;
    await saveTheater(captureTheater());
    const loadedUpdatedFmg = await readTheater(fmgMap.source.mapId);
    assert.equal(loadedUpdatedFmg?.mapData.source.mapWidthKm, 1800);

    // 3. 图片底图同样保持清空不复活
    const imgSpec = createImageBaseSpec({
      name: 'scale-clear-img',
      width: 800,
      height: 500,
      hexRadius: 32,
      imageUrl: 'data:image/png;base64,AAAA',
      mapWidthKm: 1600,
    });
    const imgMap = buildImageHexMapData(imgSpec);
    appStore.mapData = imgMap;
    appStore.mapId = imgMap.source.mapId;
    await saveTheater(captureTheater());

    delete imgMap.source.mapWidthKm;
    delete imgMap.source.kmPerPixel;
    await saveTheater(captureTheater());

    const loadedClearedImg = await readTheater(imgMap.source.mapId);
    assert.equal(loadedClearedImg?.mapData.source.mapWidthKm, undefined);
    assert.equal(loadedClearedImg?.mapData.source.kmPerPixel, undefined);
  } finally {
    if (prevIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = prevIndexedDB;
    appStore.mapData = null;
    appStore.mapId = '';
  }
});
