import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });

const { parseWorkingMap, SEA_LEVEL } = await server.ssrLoadModule('/src/map-loader.ts');
const { appStore } = await server.ssrLoadModule('/src/store.ts');
const { computeTerrainCellColor, drawWaterAndContours } = await server.ssrLoadModule('/src/terrain-heightmap.ts');
const { collectRiverPolygons } = await server.ssrLoadModule('/src/river-renderer.ts');
const { buildEdgeRecords, collectCoastGeometry } = await server.ssrLoadModule('/src/map-renderer.ts');
const {
  buildFieldTerrainSnapshot,
  computeFieldBattleFrame,
  intersectPolygonWithOutline,
} = await server.ssrLoadModule('/src/field-battle-terrain.ts');

// 测试只用固定 fixture（原 working-map 副本）的临时副本，原件只读。
const tempDir = await mkdtemp(join(tmpdir(), 'fb-s-terrain-'));
const mapCopy = join(tempDir, 'working-map.copy.map');
await copyFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), mapCopy);
const map = parseWorkingMap(await readFile(mapCopy, 'utf8'));

after(async () => {
  await server.close();
  await rm(tempDir, { recursive: true, force: true });
});

// --- 几何断言助手 ------------------------------------------------------------

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInOutline(x, y, outline) {
  for (const part of outline) {
    if (!pointInRing(x, y, part.outer)) continue;
    let inHole = false;
    for (const hole of part.holes) {
      if (pointInRing(x, y, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

// 实现按 0.05px 容差保留贴边折线；求交结果还可能落在边界的浮点邻域。
const BOUNDARY_EPSILON = 0.25;

/** 求交/裁剪结果会精确落在边界上或按 0.05px 容差保留贴边线，断言用“在内部或距边界 0.25px 内”。 */
function pointOnOrInOutline(x, y, outline) {
  if (pointInOutline(x, y, outline)) return true;
  for (const part of outline) {
    for (const ring of [part.outer, ...part.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= BOUNDARY_EPSILON) return true;
      }
    }
  }
  return false;
}

function assertRingClosed(ring, label) {
  assert.ok(ring.length >= 4, `${label} 环点数不足`);
  assert.equal(ring[0][0], ring[ring.length - 1][0], `${label} 外环未闭合`);
  assert.equal(ring[0][1], ring[ring.length - 1][1], `${label} 外环未闭合`);
}

function assertPointsOnOrIn(points, outline, label) {
  for (const [x, y] of points) {
    assert.ok(pointOnOrInOutline(x, y, outline), `${label} 有点落在展示范围外：${x},${y}`);
  }
}

// --- 选区与索引 --------------------------------------------------------------

const cellIdByRing = new Map();
for (let cellId = 0; cellId < map.cells.count; cellId++) {
  cellIdByRing.set(map.cells.polygons[cellId].map(([x, y]) => `${x},${y}`).join(';'), cellId);
}

function cellIdOfSnapshotPolygon(polygon) {
  const open = polygon.slice(0, -1);
  return cellIdByRing.get(open.map(([x, y]) => `${x},${y}`).join(';'));
}

function bfsCells(seed, limit) {
  const selected = new Set([seed]);
  const queue = [seed];
  while (queue.length && selected.size < limit) {
    const cellId = queue.shift();
    for (const neighbor of map.cells.c[cellId]) {
      if (selected.size >= limit) break;
      if (!selected.has(neighbor)) {
        selected.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return selected;
}

function expandDisplay(selected) {
  const display = new Set(selected);
  for (const cellId of selected) for (const neighbor of map.cells.c[cellId]) display.add(neighbor);
  return display;
}

function findCoastalSeed() {
  let best = -1;
  let bestScore = -1;
  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    if (map.cells.h[cellId] < SEA_LEVEL) continue;
    let water = 0;
    for (const neighbor of map.cells.c[cellId]) if (map.cells.h[neighbor] < SEA_LEVEL) water++;
    if (!water) continue;
    const score = water + (map.cells.r[cellId] > 0 ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = cellId;
    }
  }
  return best;
}

const coastalSeed = findCoastalSeed();
assert.ok(coastalSeed >= 0, '测试地图上找不到沿海陆地种子');

const coastalSelection = bfsCells(coastalSeed, 1200);
const coastalTerrain = buildFieldTerrainSnapshot(map, coastalSelection);

// --- 测试 --------------------------------------------------------------------

test('display = selected + 一圈邻接；context 标记与颜色正确', () => {
  const selected = bfsCells(coastalSeed, 400);
  const display = expandDisplay(selected);
  const terrain = buildFieldTerrainSnapshot(map, selected);

  assert.equal(terrain.cells.length, display.size);
  assert.equal(terrain.cells.filter((cell) => cell.context).length, display.size - selected.size);

  const seen = new Set();
  for (const cell of terrain.cells) {
    assertRingClosed(cell.polygon, '地块多边形');
    const cellId = cellIdOfSnapshotPolygon(cell.polygon);
    assert.notEqual(cellId, undefined, '快照地块不在主地图地块表中');
    assert.ok(display.has(cellId), `display 缺失地块 ${cellId}`);
    assert.equal(cell.context, !selected.has(cellId), `地块 ${cellId} 的 context 标记错误`);
    assert.equal(cell.color, computeTerrainCellColor(map, cellId, 'terrain', true));
    assert.equal(seen.has(cellId), false, `地块 ${cellId} 重复`);
    seen.add(cellId);
  }
  assert.equal(seen.size, display.size);
});

test('bounds 是选中地块本体 AABB；anchor 是离中心质心最近的选中地块', () => {
  const selected = bfsCells(coastalSeed, 400);
  const frame = computeFieldBattleFrame(map, selected);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const cellId of selected) {
    for (const [x, y] of map.cells.polygons[cellId]) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  assert.deepEqual(frame.bounds, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });

  let sumX = 0;
  let sumY = 0;
  for (const cellId of selected) {
    sumX += map.cells.p[cellId][0];
    sumY += map.cells.p[cellId][1];
  }
  const centroidX = sumX / selected.size;
  const centroidY = sumY / selected.size;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const cellId of selected) {
    const [x, y] = map.cells.p[cellId];
    const distance = (x - centroidX) ** 2 + (y - centroidY) ** 2;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = [x, y];
    }
  }
  assert.deepEqual(frame.anchor, nearest);
  assert.ok(selected.size > 0);

  const display = expandDisplay(selected);
  let displayMinX = Infinity;
  let displayMaxX = -Infinity;
  for (const cellId of display) {
    for (const [x] of map.cells.polygons[cellId]) {
      displayMinX = Math.min(displayMinX, x);
      displayMaxX = Math.max(displayMaxX, x);
    }
  }
  assert.ok(frame.bounds.width <= displayMaxX - displayMinX, 'battleOutline 不应超过展示范围');
});

test('凹形选区：河流被切成多段，段内点都在 display 内', () => {
  const selected = bfsCells(coastalSeed, 600);
  let notch = -1;
  for (const cellId of selected) {
    if (map.cells.r[cellId] > 0) notch = cellId;
  }
  assert.ok(notch >= 0, '凹形选区需要一个河格作为缺口中心');

  const [notchX, notchY] = map.cells.p[notch];
  const concave = new Set();
  for (const cellId of selected) {
    const [x, y] = map.cells.p[cellId];
    if ((x - notchX) ** 2 + (y - notchY) ** 2 > 22 * 22) concave.add(cellId);
  }
  assert.ok(concave.size > 0);

  const terrain = buildFieldTerrainSnapshot(map, concave);
  const splitRivers = terrain.rivers.filter((river) => river.parts.length >= 2);
  assert.ok(splitRivers.length > 0, '凹形选区应把至少一条河流切成多段');

  for (const river of terrain.rivers) {
    for (const part of river.parts) {
      assertRingClosed(part.outer, '河流分段');
      assertPointsOnOrIn(part.outer, terrain.displayOutline, '河流分段');
      for (const hole of part.holes) assertPointsOnOrIn(hole, terrain.displayOutline, '河流孔洞');
    }
  }

  for (const contour of terrain.contours) {
    for (const line of contour.lines) {
      assertPointsOnOrIn(line.points, terrain.displayOutline, '等高线');
    }
  }
  for (const coastline of terrain.coastlines) {
    for (const line of coastline.lines) {
      assertPointsOnOrIn(line.points, terrain.displayOutline, '海岸线');
    }
  }
});

test('海岸带、海岸线、等高线与湖泊（真实地图）均在 display 内', () => {
  assert.ok(coastalTerrain.coastBands.length > 0, '沿海选区应有海岸晕染带');
  assert.equal(new Set(coastalTerrain.coastBands.map((band) => band.color)).size, coastalTerrain.coastBands.length);
  for (const band of coastalTerrain.coastBands) {
    for (const part of band.parts) {
      assertRingClosed(part.outer, '海岸带');
      assertPointsOnOrIn(part.outer, coastalTerrain.displayOutline, '海岸带');
    }
  }

  assert.ok(coastalTerrain.coastlines.length > 0, '沿海选区应有海岸线');
  for (const coastline of coastalTerrain.coastlines) {
    for (const line of coastline.lines) {
      assertPointsOnOrIn(line.points, coastalTerrain.displayOutline, '海岸线');
    }
  }

  assert.ok(coastalTerrain.contours.length > 0, '沿海丘陵选区应有等高线');
  for (const contour of coastalTerrain.contours) {
    for (const line of contour.lines) {
      assertPointsOnOrIn(line.points, coastalTerrain.displayOutline, '等高线');
    }
  }

  // 找一张真实湖泊，并围绕它生成快照。
  let lakeCell = -1;
  let lakeRing = null;
  for (const lake of map.lakes) {
    for (let cellId = 0; cellId < map.cells.count; cellId++) {
      const [x, y] = map.cells.p[cellId];
      if (pointInRing(x, y, lake.polygon)) {
        lakeCell = cellId;
        lakeRing = lake.polygon;
        break;
      }
    }
    if (lakeCell >= 0) break;
  }
  assert.ok(lakeCell >= 0 && lakeRing, '测试地图上找不到湖泊内地块');

  const lakeSelection = bfsCells(lakeCell, 200);
  const lakeTerrain = buildFieldTerrainSnapshot(map, lakeSelection);
  assert.ok(lakeTerrain.lakes.length > 0, '围绕湖泊的选区应保留湖泊');
  for (const lake of lakeTerrain.lakes) {
    for (const part of lake.parts) {
      assertRingClosed(part.outer, '湖泊');
      assertPointsOnOrIn(part.outer, lakeTerrain.displayOutline, '湖泊');
      for (const hole of part.holes) assertPointsOnOrIn(hole, lakeTerrain.displayOutline, '湖泊孔洞');
    }
  }
});

test('带孔多边形求交保留孔洞；contextOutline 以选区为孔', () => {
  const holeOutline = [{
    outer: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
    holes: [[[40, 40], [40, 60], [60, 60], [60, 40], [40, 40]]],
  }];
  const parts = intersectPolygonWithOutline([[10, 10], [90, 10], [90, 90], [10, 90], [10, 10]], holeOutline);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].holes.length, 1);
  assert.equal(pointInRing(50, 50, parts[0].holes[0]), true);
  assert.equal(pointInOutline(20, 20, parts), true);
  assert.equal(pointInOutline(50, 50, parts), false);

  const selected = bfsCells(coastalSeed, 400);
  const terrain = buildFieldTerrainSnapshot(map, selected);
  const holeCount = terrain.contextOutline.reduce((sum, part) => sum + part.holes.length, 0);
  assert.ok(holeCount >= 1, 'contextOutline 应以 selected 区域为孔');
  assert.ok(terrain.battleOutline.length > 0);
});

test('主地图 viewMode=state 时快照仍是 terrain+山影；不修改主地图设置', () => {
  const selected = bfsCells(coastalSeed, 400);
  const origin = {
    viewMode: appStore.viewMode,
    showHillshade: appStore.showHillshade,
    showContours: appStore.showContours,
  };
  Object.assign(appStore, { viewMode: 'state', showHillshade: false, showContours: false });
  try {
    const terrain = buildFieldTerrainSnapshot(map, selected);
    for (const cell of terrain.cells.slice(0, 60)) {
      const cellId = cellIdOfSnapshotPolygon(cell.polygon);
      assert.equal(cell.color, computeTerrainCellColor(map, cellId, 'terrain', true));
    }
    assert.equal(appStore.viewMode, 'state');
    assert.equal(appStore.showHillshade, false);
    assert.equal(appStore.showContours, false);
  } finally {
    Object.assign(appStore, origin);
  }
});

test('drawWaterAndContours 只读显式选项，不读全局 viewMode/showContours', () => {
  class GraphicsStub {
    constructor() {
      this.ops = [];
    }
    clear() {
      this.ops.push('clear');
    }
    rect() {
      this.ops.push('rect');
      return this;
    }
    poly() {
      this.ops.push('poly');
      return this;
    }
    fill() {
      this.ops.push('fill');
      return this;
    }
    stroke() {
      this.ops.push('stroke');
      return this;
    }
    moveTo() {
      this.ops.push('moveTo');
      return this;
    }
    lineTo() {
      this.ops.push('lineTo');
      return this;
    }
  }

  const edges = buildEdgeRecords(map);
  const origin = { viewMode: appStore.viewMode, showContours: appStore.showContours };
  Object.assign(appStore, { viewMode: 'state', showContours: false });
  try {
    const ocean = new GraphicsStub();
    const contours = new GraphicsStub();
    drawWaterAndContours(ocean, contours, map, edges, { viewMode: 'terrain', hillshade: true, contours: true });
    assert.ok(contours.ops.includes('moveTo'), '显式 contours=true 应绘制等高线');
    assert.ok(contours.ops.includes('stroke'));

    const oceanOff = new GraphicsStub();
    const contoursOff = new GraphicsStub();
    drawWaterAndContours(oceanOff, contoursOff, map, edges, { viewMode: 'terrain', hillshade: true, contours: false });
    assert.deepEqual(contoursOff.ops, ['clear'], '显式 contours=false 不应绘制等高线');

    const oceanBiome = new GraphicsStub();
    const contoursBiome = new GraphicsStub();
    drawWaterAndContours(oceanBiome, contoursBiome, map, edges, { viewMode: 'biome', hillshade: true, contours: true });
    assert.deepEqual(contoursBiome.ops, ['clear'], '非地形视图不绘制等高线');
  } finally {
    Object.assign(appStore, origin);
  }
});

test('快照只含普通数组/数字/字符串，不含 typed array、Pixi 对象或 MapData 引用', () => {
  const selected = bfsCells(coastalSeed, 400);
  const terrain = buildFieldTerrainSnapshot(map, selected);

  const visited = new Set();
  const walk = (value, path) => {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${path} 含非有限数字`);
      return;
    }
    if (typeof value === 'string' || typeof value === 'boolean') return;
    assert.notEqual(value, null, `${path} 为 null`);
    assert.notEqual(typeof value, 'undefined', `${path} 为 undefined`);
    assert.notEqual(typeof value, 'function', `${path} 含函数`);
    assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype, `${path} 含非普通对象`);
    assert.equal(ArrayBuffer.isView(value), false, `${path} 含 typed array`);
    if (visited.has(value)) return;
    visited.add(value);
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  walk(terrain, 'terrain');

  const mapRefs = [map, map.cells, map.cells.polygons, map.cells.p, map.cells.c, map.cells.h, map.lakes, map.rivers, map.burgs];
  for (const lake of map.lakes) mapRefs.push(lake.polygon);
  for (const cellId of selected) mapRefs.push(map.cells.polygons[cellId]);
  for (const ref of mapRefs) assert.equal(visited.has(ref), false, '快照引用了 MapData 内部对象');
});

test('主地图几何收集稳定；terrain/biome 颜色基线不变', () => {
  const edges = buildEdgeRecords(map);
  const firstRivers = collectRiverPolygons(map);
  const secondRivers = collectRiverPolygons(map);
  assert.equal(firstRivers.length, 422);
  assert.deepEqual(firstRivers.map((polygon) => polygon.length), secondRivers.map((polygon) => polygon.length));
  const checksum = (polygons) => polygons.reduce((sum, polygon) => sum + polygon.reduce((s, value) => s + value, 0), 0);
  assert.equal(checksum(firstRivers), checksum(secondRivers));

  const coast = collectCoastGeometry(map, edges);
  assert.equal(coast.bands.length % 3, 0);
  assert.equal(new Set(coast.bands.map((band) => band.color)).size, 3);
  assert.ok(coast.lines.length > 0);

  // 群系视图不叠山影时，颜色应等于群系调色板本身。
  let biomeCell = -1;
  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    if (map.cells.h[cellId] >= SEA_LEVEL) {
      biomeCell = cellId;
      break;
    }
  }
  assert.ok(biomeCell >= 0);
  const biomeColor = map.biomes[map.cells.biome[biomeCell]].color;
  assert.equal(computeTerrainCellColor(map, biomeCell, 'biome', false).toLowerCase(), biomeColor.toLowerCase());

  // 地形视图仍应用山影：至少一格的开关结果不同。
  let shadedDifference = 0;
  for (let cellId = 0; cellId < 200; cellId++) {
    const on = computeTerrainCellColor(map, cellId, 'terrain', true);
    const off = computeTerrainCellColor(map, cellId, 'terrain', false);
    if (on !== off) shadedDifference++;
  }
  assert.ok(shadedDifference > 0, '山影开关应改变地形颜色');
});

test('空选区与越界地块被拒绝', () => {
  assert.throws(() => buildFieldTerrainSnapshot(map, new Set()), /选区为空/);
  assert.throws(() => buildFieldTerrainSnapshot(map, new Set([map.cells.count])), /地块 ID 越界/);
  assert.throws(() => computeFieldBattleFrame(map, new Set([-1])), /地块 ID 越界/);
});

test('回归：多地块 BFS (300 格，种子 500/18000) 快照与海岸带裁剪成功；环自交裁剪保留较大环', async () => {
  const { pruneClosedSelfIntersections } = await server.ssrLoadModule('/src/river-renderer.ts');

  const bfsSelect = (seed, limit = 300) => {
    const selected = new Set([seed]);
    const queue = [seed];
    while (queue.length > 0 && selected.size < limit) {
      const id = queue.shift();
      for (const n of map.cells.c[id] ?? []) {
        if (!selected.has(n)) {
          selected.add(n);
          queue.push(n);
          if (selected.size >= limit) break;
        }
      }
    }
    return selected;
  };

  for (const seed of [500, 18000]) {
    const selected = bfsSelect(seed, 300);
    assert.ok(selected.size >= 300, `种子 ${seed} BFS 应选满 300 格`);
    const snapshot = buildFieldTerrainSnapshot(map, selected);
    assert.ok(snapshot.cells.length >= 300);
    assert.ok(snapshot.displayOutline.length > 0);
  }

  // 8 字自交闭合环：100x100 大环 + 2x2 小交叉环，正反绕向均应保留大环（面积约 10000 而非约 2）
  const ringArea = (flat) => {
    let twice = 0;
    const n = flat.length / 2;
    for (let i = 0; i < n - 1; i++) {
      twice += flat[i * 2] * flat[(i + 1) * 2 + 1] - flat[(i + 1) * 2] * flat[i * 2 + 1];
    }
    return Math.abs(twice) / 2;
  };
  const fig8 = [0, 0, 49, 0, 51, -2, 49, -2, 51, 0, 100, 0, 100, 100, 0, 100, 0, 0];
  const pairs = [];
  for (let i = 0; i < fig8.length; i += 2) pairs.push([fig8[i], fig8[i + 1]]);
  const fig8Reversed = pairs.reverse().flat();

  for (const input of [fig8, fig8Reversed]) {
    const pruned = pruneClosedSelfIntersections(input);
    const area = ringArea(pruned);
    assert.ok(area > 9000 && area < 10500, `期望保留 100x100 大环，实测面积 ${area}`);
  }
});
