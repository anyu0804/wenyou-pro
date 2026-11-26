import type { Graphics } from 'pixi.js';
import type { EdgeRecord } from './map-renderer';
import type { FieldRing, FieldStrokeStyle } from './field-battle-types';
import type { MapData, ViewMode } from './store';
import { SEA_LEVEL } from './map-loader';

/**
 * 地形高度图渲染（T 包独占）
 *
 * - `computeTerrainCellColor`：FMG bright 风格连续高程色带 + 西北光源坡度明暗；群系视图取群系色并叠加轻微光影。
 * - `drawWaterAndContours`：深海底色 → 浅海大陆架 → 41 个内陆淡水湖 → 地形视图等高线。
 *
 * 等高线使用 Marching-Polygons 的共享棱插值：顶点高程取共享该 Voronoi 顶点的地块高度均值，
 * 交点在 `edges` 的唯一棱记录上只算一次，因此相邻地块在共享棱上的交点逐字节相同，
 * 再按共享端点拼成连续折线链并做一轮 Chaikin 圆角平滑。
 *
 * 只消费 P0 冻结的 `MapData` 强类型结构，高度取自 `cells.h`（0..100，<20 为水域）。
 */

type Rgb = [number, number, number];

interface ColorStop {
  h: number;
  rgb: Rgb;
}

// hypsometric tint：海岸平原 → 丘陵 → 山地 → 高寒雪线
const COLOR_STOPS: ColorStop[] = [
  { h: 20, rgb: [120, 198, 121] }, // #78c679
  { h: 28, rgb: [173, 221, 142] }, // #addd8e
  { h: 38, rgb: [217, 240, 163] }, // #d9f0a3
  { h: 48, rgb: [254, 217, 142] }, // #fed98e
  { h: 60, rgb: [254, 153, 41] }, // #fe9929
  { h: 72, rgb: [204, 76, 2] }, // #cc4c02
  { h: 84, rgb: [140, 45, 4] }, // #8c2d04
  { h: 95, rgb: [241, 238, 246] }, // #f1eef6
];

const SNOW_RGB: Rgb = [241, 238, 246];

const DEEP_OCEAN_COLOR = '#0f3550';
const SHELF_COLOR = '#1c5278';
export const LAKE_FILL_COLOR = '#2b7bba';
const LAKE_STROKE_COLOR = '#1b4f79';

const CONTOUR_LEVELS = [30, 45, 60, 75, 88];
const CONTOUR_MINOR_COLOR = '#33220f';
const CONTOUR_MAJOR_COLOR = '#1f1408';

export const CONTOUR_STYLES: { minor: FieldStrokeStyle; major: FieldStrokeStyle } = {
  minor: { color: CONTOUR_MINOR_COLOR, width: 0.7, alpha: 0.3 },
  major: { color: CONTOUR_MAJOR_COLOR, width: 1.2, alpha: 0.5 },
};

// 西北光源方向 (-0.707, -0.707)；0.4 是把实测梯度映射到 [-1,1] 的归一化系数
const LIGHT_COMPONENT = 0.7071067811865476;
const SHADE_SCALE = 0.4;
const LIT_GAIN = 0.12;
const SHADE_LOSS = 0.16;
const BIOME_SHADE_SCALE = 0.55;

// --- 颜色 --------------------------------------------------------------------

const rgbCache = new Map<string, Rgb>();

function hexToRgb(hex: string): Rgb {
  const cached = rgbCache.get(hex);
  if (cached) return cached;
  const value = Number.parseInt(hex.slice(1), 16);
  const rgb: Rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  rgbCache.set(hex, rgb);
  return rgb;
}

function hypsometricTint(height: number): Rgb {
  if (height <= COLOR_STOPS[0].h) return COLOR_STOPS[0].rgb;
  if (height >= 95) return SNOW_RGB;
  for (let i = 1; i < COLOR_STOPS.length; i++) {
    const upper = COLOR_STOPS[i];
    if (height <= upper.h) {
      const lower = COLOR_STOPS[i - 1];
      const t = (height - lower.h) / (upper.h - lower.h);
      return [
        lower.rgb[0] + (upper.rgb[0] - lower.rgb[0]) * t,
        lower.rgb[1] + (upper.rgb[1] - lower.rgb[1]) * t,
        lower.rgb[2] + (upper.rgb[2] - lower.rgb[2]) * t,
      ];
    }
  }
  return SNOW_RGB;
}

const byteToHex = (value: number): string =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');

function shadeToHex(rgb: Rgb, light: number): string {
  const factor = light >= 0 ? 1 + LIT_GAIN * light : 1 + SHADE_LOSS * light;
  return `#${byteToHex(rgb[0] * factor)}${byteToHex(rgb[1] * factor)}${byteToHex(rgb[2] * factor)}`;
}

/**
 * 单格坡度光照系数，[-1, 1]。`hillshade` 由调用方显式传入，不读全局开关。
 * gx / gy 为邻格加权高程梯度；东南方向高程上升（gx+gy > 0）意味着坡面朝西北、迎着光源受光。
 */
function hillshadeLight(map: MapData, cellId: number, hillshade: boolean): number {
  if (!hillshade) return 0;
  const { cells } = map;
  const [x, y] = cells.p[cellId];
  const height = cells.h[cellId];
  let gx = 0;
  let gy = 0;
  for (const neighbor of cells.c[cellId]) {
    const dx = cells.p[neighbor][0] - x;
    const dy = cells.p[neighbor][1] - y;
    const d2 = dx * dx + dy * dy;
    const dh = cells.h[neighbor] - height;
    gx += (dh * dx) / d2;
    gy += (dh * dy) / d2;
  }
  const light = (gx + gy) * LIGHT_COMPONENT * SHADE_SCALE;
  return light < -1 ? -1 : light > 1 ? 1 : light;
}

export function computeTerrainCellColor(
  map: MapData,
  cellId: number,
  viewMode: 'terrain' | 'biome',
  hillshade: boolean
): string {
  if (map.cells.h[cellId] < SEA_LEVEL) {
    return map.cells.t[cellId] === -1 ? SHELF_COLOR : DEEP_OCEAN_COLOR;
  }
  const light = hillshadeLight(map, cellId, hillshade);
  if (viewMode === 'biome') {
    const biome = map.biomes[map.cells.biome[cellId]];
    return shadeToHex(hexToRgb(biome.color), light * BIOME_SHADE_SCALE);
  }
  return shadeToHex(hypsometricTint(map.cells.h[cellId]), light);
}

// --- 几何与等高线拓扑缓存 ------------------------------------------------------

interface FlatGeometry {
  map: MapData;
  cells: number[][];
}

let flatGeometry: FlatGeometry | null = null;

/** 多边形摊平成 [x0,y0,x1,y1,...]，随底图加载缓存一次 */
function getFlatGeometry(map: MapData): FlatGeometry {
  if (flatGeometry && flatGeometry.map === map) return flatGeometry;
  const cells = new Array<number[]>(map.cells.count);
  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    const polygon = map.cells.polygons[cellId];
    const flat = new Array<number>(polygon.length * 2);
    for (let k = 0; k < polygon.length; k++) {
      flat[k * 2] = polygon[k][0];
      flat[k * 2 + 1] = polygon[k][1];
    }
    cells[cellId] = flat;
  }
  flatGeometry = { map, cells };
  return flatGeometry;
}

interface ContourTopology {
  map: MapData;
  edges: EdgeRecord[];
  /** 每个地块多边形的顶点在 `vertexX/Y` 中的下标 */
  vertexIds: Int32Array[];
  /** 每个地块多边形的边在 `edges` 中的下标（与多边形边序一致） */
  edgeIds: Int32Array[];
  edgeVa: Int32Array;
  edgeVb: Int32Array;
  vertexX: Float64Array;
  vertexY: Float64Array;
  vertexCount: number;
  vertexSum: Float64Array;
  vertexSamples: Uint16Array;
  vertexWater: Uint8Array;
  vertexHeight: Float64Array;
  crossX: Float64Array;
  crossY: Float64Array;
  crossMask: Uint8Array;
}

let contourTopology: ContourTopology | null = null;

const CONTOUR_LEVEL_COUNT = CONTOUR_LEVELS.length;

const vertexKey = (x: number, y: number): number => Math.round(x * 100) * 1_000_000 + Math.round(y * 100);
const edgePairKey = (a: number, b: number, stride: number): number => (a < b ? a * stride + b : b * stride + a);

/**
 * 建立“顶点 ↔ 地块多边形 ↔ 唯一棱”的对应表。
 * 拓扑只随底图/棱表身份变化，顶点高程每帧由 `cells.h` 重新汇总。
 */
function getContourTopology(map: MapData, edges: EdgeRecord[]): ContourTopology {
  if (contourTopology && contourTopology.map === map && contourTopology.edges === edges) {
    return contourTopology;
  }

  const vertexIndex = new Map<number, number>();
  const vertexXs: number[] = [];
  const vertexYs: number[] = [];
  const vertexIds = new Array<Int32Array>(map.cells.count);

  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    const polygon = map.cells.polygons[cellId];
    const ids = new Int32Array(polygon.length);
    for (let k = 0; k < polygon.length; k++) {
      const [x, y] = polygon[k];
      const key = vertexKey(x, y);
      let id = vertexIndex.get(key);
      if (id === undefined) {
        id = vertexXs.length;
        vertexIndex.set(key, id);
        vertexXs.push(x);
        vertexYs.push(y);
      }
      ids[k] = id;
    }
    vertexIds[cellId] = ids;
  }

  const vertexCount = vertexXs.length;
  const edgeIndex = new Map<number, number>();
  const edgeVa = new Int32Array(edges.length);
  const edgeVb = new Int32Array(edges.length);
  for (let e = 0; e < edges.length; e++) {
    const edge = edges[e];
    const va = vertexIndex.get(vertexKey(edge.ax, edge.ay))!;
    const vb = vertexIndex.get(vertexKey(edge.bx, edge.by))!;
    edgeVa[e] = va;
    edgeVb[e] = vb;
    edgeIndex.set(edgePairKey(va, vb, vertexCount), e);
  }

  const edgeIds = new Array<Int32Array>(map.cells.count);
  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    const ids = vertexIds[cellId];
    const cellEdges = new Int32Array(ids.length);
    for (let k = 0; k < ids.length; k++) {
      const next = (k + 1) % ids.length;
      cellEdges[k] = edgeIndex.get(edgePairKey(ids[k], ids[next], vertexCount))!;
    }
    edgeIds[cellId] = cellEdges;
  }

  const slots = edges.length * CONTOUR_LEVEL_COUNT;
  contourTopology = {
    map,
    edges,
    vertexIds,
    edgeIds,
    edgeVa,
    edgeVb,
    vertexX: Float64Array.from(vertexXs),
    vertexY: Float64Array.from(vertexYs),
    vertexCount,
    vertexSum: new Float64Array(vertexCount),
    vertexSamples: new Uint16Array(vertexCount),
    vertexWater: new Uint8Array(vertexCount),
    vertexHeight: new Float64Array(vertexCount),
    crossX: new Float64Array(slots),
    crossY: new Float64Array(slots),
    crossMask: new Uint8Array(slots),
  };
  return contourTopology;
}

/** 顶点高程 = 共享该顶点的所有地块高度均值；任一相邻格为水域则锚定在海岸线以下。 */
function updateVertexHeights(map: MapData, topology: ContourTopology): void {
  const { vertexIds, vertexSum, vertexSamples, vertexWater, vertexHeight } = topology;
  vertexSum.fill(0);
  vertexSamples.fill(0);
  vertexWater.fill(0);

  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    const height = map.cells.h[cellId];
    const water = height < SEA_LEVEL ? 1 : 0;
    const ids = vertexIds[cellId];
    for (let k = 0; k < ids.length; k++) {
      const vertex = ids[k];
      vertexSum[vertex] += height;
      vertexSamples[vertex] += 1;
      vertexWater[vertex] |= water;
    }
  }

  for (let vertex = 0; vertex < topology.vertexCount; vertex++) {
    const average = vertexSum[vertex] / vertexSamples[vertex];
    vertexHeight[vertex] = vertexWater[vertex] === 1 ? Math.min(average, SEA_LEVEL - 0.5) : average;
  }
}

/** 每条唯一棱按顶点高程做一次线性插值，两侧地块复用同一交点。 */
function computeEdgeCrossings(topology: ContourTopology): void {
  const { edges, edgeVa, edgeVb, vertexHeight, vertexX, vertexY, crossX, crossY, crossMask } = topology;
  crossMask.fill(0);

  for (let e = 0; e < edges.length; e++) {
    const va = edgeVa[e];
    const vb = edgeVb[e];
    const ha = vertexHeight[va];
    const hb = vertexHeight[vb];
    if (ha === hb) continue;

    const ax = vertexX[va];
    const ay = vertexY[va];
    const bx = vertexX[vb];
    const by = vertexY[vb];
    for (let levelIndex = 0; levelIndex < CONTOUR_LEVEL_COUNT; levelIndex++) {
      const level = CONTOUR_LEVELS[levelIndex];
      // 半开区间：顶点高程恰好等于层级时只归属下降侧棱一次，
      // 避免同一顶点被两侧边重复计数或漏计，保证每格交点数为偶数、链条不断。
      if ((ha < level) === (hb < level)) continue;
      const t = (level - ha) / (hb - ha);
      const slot = e * CONTOUR_LEVEL_COUNT + levelIndex;
      crossX[slot] = ax + (bx - ax) * t;
      crossY[slot] = ay + (by - ay) * t;
      crossMask[slot] = 1;
    }
  }
}

/** 按地块多边形边序收集交点，相邻交点两两连成穿格线段。 */
function collectContourSegments(map: MapData, topology: ContourTopology, buckets: number[][]): void {
  const { edgeIds, crossX, crossY, crossMask } = topology;

  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    if (map.cells.h[cellId] < SEA_LEVEL) continue;
    const ids = edgeIds[cellId];
    for (let levelIndex = 0; levelIndex < CONTOUR_LEVEL_COUNT; levelIndex++) {
      const bucket = buckets[levelIndex];
      let pending = false;
      let pendingX = 0;
      let pendingY = 0;
      for (let k = 0; k < ids.length; k++) {
        const slot = ids[k] * CONTOUR_LEVEL_COUNT + levelIndex;
        if (!crossMask[slot]) continue;
        const x = crossX[slot];
        const y = crossY[slot];
        if (!pending) {
          pending = true;
          pendingX = x;
          pendingY = y;
        } else {
          bucket.push(pendingX, pendingY, x, y);
          pending = false;
        }
      }
    }
  }
}

interface ContourChain {
  points: number[];
  closed: boolean;
}

const chainPointKey = (x: number, y: number): string => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;

/** 把同层线段按共享端点拼成折线链；开放链从端点度数为 1 的节点出发，剩余闭环单独收集。 */
function buildContourChains(segments: number[]): ContourChain[] {
  const count = segments.length / 4;
  if (count === 0) return [];

  interface ChainNode {
    x: number;
    y: number;
    links: number[];
  }
  const nodes = new Map<string, ChainNode>();
  const nodeAt = (key: string, x: number, y: number): ChainNode => {
    let node = nodes.get(key);
    if (!node) {
      node = { x, y, links: [] };
      nodes.set(key, node);
    }
    return node;
  };

  const ends = new Array<[string, string]>(count);
  for (let s = 0; s < count; s++) {
    const ax = segments[s * 4];
    const ay = segments[s * 4 + 1];
    const bx = segments[s * 4 + 2];
    const by = segments[s * 4 + 3];
    const keyA = chainPointKey(ax, ay);
    const keyB = chainPointKey(bx, by);
    ends[s] = [keyA, keyB];
    nodeAt(keyA, ax, ay).links.push(s);
    if (keyB !== keyA) nodeAt(keyB, bx, by).links.push(s);
  }

  const used = new Uint8Array(count);
  const chains: ContourChain[] = [];

  const walk = (startKey: string): ContourChain => {
    const points: number[] = [];
    let key = startKey;
    for (;;) {
      const node = nodes.get(key)!;
      let next = -1;
      for (const segment of node.links) {
        if (!used[segment]) {
          next = segment;
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      points.push(node.x, node.y);
      const [keyA, keyB] = ends[next];
      key = keyA === key ? keyB : keyA;
    }
    const last = nodes.get(key)!;
    points.push(last.x, last.y);
    const firstKey = chainPointKey(points[0], points[1]);
    const lastKey = chainPointKey(points[points.length - 2], points[points.length - 1]);
    return { points, closed: firstKey === lastKey };
  };

  for (const [key, node] of nodes) {
    if (node.links.length !== 1) continue;
    if (used[node.links[0]]) continue;
    chains.push(walk(key));
  }
  for (let s = 0; s < count; s++) {
    if (used[s]) continue;
    chains.push(walk(ends[s][0]));
  }
  return chains;
}

/** 一轮 Chaikin：每段取 0.25 / 0.75 分位点，开放链保留首尾端点。 */
function chaikinSmooth(chain: ContourChain): ContourChain {
  const { points, closed } = chain;
  const pointCount = points.length / 2;
  if (pointCount < 3) return chain;

  const smoothed: number[] = [];
  if (!closed) smoothed.push(points[0], points[1]);
  const segmentCount = closed ? pointCount : pointCount - 1;
  for (let i = 0; i < segmentCount; i++) {
    const j = (i + 1) % pointCount;
    const x0 = points[i * 2];
    const y0 = points[i * 2 + 1];
    const x1 = points[j * 2];
    const y1 = points[j * 2 + 1];
    smoothed.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25);
    smoothed.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
  }
  if (!closed) smoothed.push(points[points.length - 2], points[points.length - 1]);
  return { points: smoothed, closed };
}

/** 等高线链转普通数组环形；闭合链末尾重复首点，与快照的 ring 约定一致。 */
function contourChainToRing(chain: ContourChain): FieldRing {
  const ring: FieldRing = new Array(chain.points.length / 2);
  for (let i = 0; i < chain.points.length; i += 2) ring[i / 2] = [chain.points[i], chain.points[i + 1]];
  if (chain.closed) ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/**
 * 收集主地图全部等高线（与 `drawContours`、战场快照同源）。
 * 拓扑缓存按 map 与边表身份失效；顶点高程每次从 `cells.h` 重新汇总，因此高度重刷后无需重建拓扑。
 */
export function collectContourChains(
  map: MapData,
  edges: EdgeRecord[]
): { minor: FieldRing[]; major: FieldRing[] } {
  const topology = getContourTopology(map, edges);
  updateVertexHeights(map, topology);
  computeEdgeCrossings(topology);

  const buckets = CONTOUR_LEVELS.map(() => [] as number[]);
  collectContourSegments(map, topology, buckets);

  const minor: FieldRing[] = [];
  const major: FieldRing[] = [];
  for (let levelIndex = 0; levelIndex < CONTOUR_LEVEL_COUNT; levelIndex++) {
    const level = CONTOUR_LEVELS[levelIndex];
    const target = level === 60 || level === 75 ? major : minor;
    for (const chain of buildContourChains(buckets[levelIndex])) {
      target.push(contourChainToRing(chaikinSmooth(chain)));
    }
  }
  return { minor, major };
}

function strokeContourRings(graphics: Graphics, rings: FieldRing[], style: FieldStrokeStyle): void {
  for (const ring of rings) {
    if (ring.length < 2) continue;
    graphics.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) graphics.lineTo(ring[i][0], ring[i][1]);
  }
  graphics.stroke({ width: style.width, color: style.color, alpha: style.alpha });
}

/** 逐层收集穿格线段 → 按共享端点拼接 → Chaikin 平滑 → 每层一次描边。 */
function drawContours(graphics: Graphics, map: MapData, edges: EdgeRecord[]): void {
  const { minor, major } = collectContourChains(map, edges);
  strokeContourRings(graphics, minor, CONTOUR_STYLES.minor);
  strokeContourRings(graphics, major, CONTOUR_STYLES.major);
}

/** 湖泊多边形；与 `drawWaterAndContours` 同一来源（`map.lakes[].polygon`），返回独立数组供快照持有。 */
export function collectLakes(map: MapData): FieldRing[] {
  return map.lakes.map((lake) => lake.polygon.map(([x, y]) => [x, y] as [number, number]));
}

export interface WaterAndContourOptions {
  viewMode: ViewMode;
  hillshade: boolean;
  contours: boolean;
}

export function drawWaterAndContours(
  oceanGfx: Graphics,
  contourGfx: Graphics,
  map: MapData,
  edges: EdgeRecord[],
  options: WaterAndContourOptions
): void {
  oceanGfx.clear();
  contourGfx.clear();

  oceanGfx.rect(0, 0, map.width, map.height).fill({ color: DEEP_OCEAN_COLOR });

  const geometry = getFlatGeometry(map);
  const { cells } = map;
  for (let cellId = 0; cellId < cells.count; cellId++) {
    if (cells.h[cellId] < SEA_LEVEL && cells.t[cellId] === -1) {
      oceanGfx.poly(geometry.cells[cellId], true);
    }
  }
  oceanGfx.fill({ color: SHELF_COLOR });

  for (const lake of collectLakes(map)) {
    const flat: number[] = [];
    for (const [x, y] of lake) flat.push(x, y);
    oceanGfx.poly(flat, true).fill({ color: LAKE_FILL_COLOR }).stroke({ color: LAKE_STROKE_COLOR, width: 1 });
  }

  if (!options.contours || options.viewMode !== 'terrain') return;
  drawContours(contourGfx, map, edges);
}
