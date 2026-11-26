import type { Graphics } from 'pixi.js';
import { SEA_LEVEL } from './map-loader';
import type { MapData, RiverItem } from './store';

/**
 * 河流渲染：锚点 → FMG 曲流插值 → 锐角松弛 → Catmull-Rom 加密 → 源细口粗多边形。
 *
 * 河宽不直接采用存档里的 `width`（km）或 FMG 的 `pointIndex + flux^0.7` 放大式，
 * 而是用“流量 × 河长 × 下游进度”的加权几何模型，并以 WIDTH_GAIN 标定到屏幕可见但
 * 不夸张的量级：本图（7.5 km/px）中位河口全宽约 0.49 px，最大河口全宽约 2.2 px。
 *
 * 支流末端吸附父河曲流中心线并向干流内部延伸；左右岸偏移在急弯处钳制到曲率中心，
 * 再对单岸与闭合带状多边形做自交裁剪，保证 422 条河流的填充多边形零自交。
 */

type Pt = [number, number];

interface AnchorPath {
  points: Pt[];
  cells: number[];
}

interface MeanderResult {
  points: Pt[];
  anchorIndices: number[];
}

interface DensePath {
  points: Pt[];
  widths: number[];
}

interface ConfluencePoint {
  x: number;
  y: number;
  half: number;
}

interface RiverGeometry {
  cellCenters: Map<number, ConfluencePoint>;
  dense: DensePath;
}

// --- 河宽标定 --------------------------------------------------------------
// 参考量取真实分布中位数附近的整数：Q_REF = 100 m³/s、CELL_REF = 4 段。
// 冻结契约未暴露 river.length，河长项用 cells.length 代理（实测与 length 相关系数 0.989）。
const Q_REF = 100;
const CELL_REF = 4;
// 权重：流量 0.45（略压缩，抑制 3617 m³/s 这类离群值）、河长 0.2、下游进度 0.35。
const FLOW_WEIGHT = 0.45;
const LENGTH_WEIGHT = 0.2;
const PROGRESS_WEIGHT = 0.35;
// 源头半宽（px）与标定乘数：GAIN 使全图最大河口半宽落在 1.1 px（全宽 2.2 px）。
const SOURCE_HALF_WIDTH = 0.12;
const WIDTH_GAIN = 0.1474;

// --- 曲流参数（对齐 fmg-upstream/src/utils/pathUtils.ts） -------------------
const MEANDERING = 0.5;
const WATER_MEANDER_SCALE = 0.25;
const RELAX_ITERATIONS = 4;
const SPLINE_SAMPLES = 4;
const CURVE_ALPHA = 0.1;
const POINT_EPSILON = 1e-6;

// --- 汇流与自交裁剪 --------------------------------------------------------
// 支流末端越过父河中心线的距离：0.45 × 父河半宽，保证多边形完全嵌入干流带。
const CONFLUENCE_OVERLAP = 0.45;
const INTERSECTION_EPSILON = 1e-9;

export const RIVER_COLOR = '#2b7bba';
export const RIVER_ALPHA = 0.92;

/** 全部河流的最终带状多边形；主地图填充与战场快照裁剪共用同一批次。 */
export function collectRiverPolygons(map: MapData): number[][] {
  const riverById = new Map<number, RiverItem>();
  for (const river of map.rivers) riverById.set(river.i, river);

  // 父河几何先行：支流末端要吸附到父河在该格的曲流中心点与半宽。
  const memo = new Map<number, RiverGeometry>();
  const polygons: number[][] = [];
  for (const river of map.rivers) {
    const geometry = buildRiverGeometry(map, river, riverById, memo);
    if (geometry.dense.points.length < 2) continue;
    polygons.push(buildRibbon(geometry.dense.points, geometry.dense.widths));
  }
  return polygons;
}

/** 将全部河流绘制为平滑多边形河道；同一批路径共用一次 fill。 */
export function renderRivers(riverGfx: Graphics, map: MapData): void {
  riverGfx.clear();
  for (const polygon of collectRiverPolygons(map)) riverGfx.poly(polygon, true);
  riverGfx.fill({ color: RIVER_COLOR, alpha: RIVER_ALPHA });
}

/**
 * 单条河流的最终几何。父河通过递归先行求解，子河把最后一个有效锚点替换为
 * 父河在该格的曲流中心点，并把末端顺延 0.45 × 父河半宽嵌入干流。
 */
function buildRiverGeometry(
  map: MapData,
  river: RiverItem,
  riverById: Map<number, RiverItem>,
  memo: Map<number, RiverGeometry>
): RiverGeometry {
  const cached = memo.get(river.i);
  if (cached) return cached;

  const anchors = buildAnchors(map, river);
  if (anchors.points.length < 2) {
    const emptyGeometry: RiverGeometry = { cellCenters: new Map(), dense: { points: [], widths: [] } };
    memo.set(river.i, emptyGeometry);
    return emptyGeometry;
  }
  const anchorFlux = buildAnchorFlux(map, river, anchors.cells);

  let confluenceHalf = 0;
  if (river.parent > 0) {
    const parent = riverById.get(river.parent);
    if (parent && parent !== river) {
      let joinIndex = anchors.cells.length - 1;
      while (joinIndex >= 0 && anchors.cells[joinIndex] === -1) joinIndex--;
      if (joinIndex >= 0) {
        const parentGeometry = buildRiverGeometry(map, parent, riverById, memo);
        const confluence = parentGeometry.cellCenters.get(anchors.cells[joinIndex]);
        if (confluence) {
          anchors.points[joinIndex] = [confluence.x, confluence.y];
          confluenceHalf = confluence.half;
        }
      }
    }
  }

  const meander = meanderPath(anchors, map);
  const widths = meanderWidths(meander, anchorFlux, river);
  const dense = sampleCatmullRom(meander.points, widths);
  if (confluenceHalf > 0) extendIntoParent(dense, confluenceHalf);

  const cellCenters = new Map<number, ConfluencePoint>();
  for (let i = 0; i < anchors.cells.length; i++) {
    const cell = anchors.cells[i];
    if (cell === -1) continue;
    const pointIndex = meander.anchorIndices[i];
    cellCenters.set(cell, {
      x: meander.points[pointIndex][0],
      y: meander.points[pointIndex][1],
      half: widths[pointIndex],
    });
  }

  const geometry: RiverGeometry = { cellCenters, dense };
  memo.set(river.i, geometry);
  return geometry;
}

/** 沿支流末段切向越过父河中心线 0.45 × 父河半宽；河宽保持不变，仍单调不减。 */
function extendIntoParent(dense: DensePath, parentHalf: number): void {
  const count = dense.points.length;
  const last = dense.points[count - 1];
  const previous = dense.points[count - 2];
  const length = Math.hypot(last[0] - previous[0], last[1] - previous[1]);
  const dx = (last[0] - previous[0]) / length;
  const dy = (last[1] - previous[1]) / length;
  const distance = parentHalf * CONFLUENCE_OVERLAP;
  dense.points.push([last[0] + dx * distance, last[1] + dy * distance]);
  dense.widths.push(dense.widths[count - 1]);
}

// --- 锚点与流量 ------------------------------------------------------------

/** 仅在 `river.points` 与 cells 等长且逐点有效时采用存档折线（外部输入边界校验）。 */
function hasValidPoints(river: RiverItem): river is RiverItem & { points: Pt[] } {
  const points = river.points;
  if (!points || points.length !== river.cells.length) return false;
  for (const point of points) {
    if (!Array.isArray(point) || point.length < 2) return false;
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  }
  return true;
}

function buildAnchors(map: MapData, river: RiverItem): AnchorPath {
  const saved = hasValidPoints(river);
  const points: Pt[] = [];
  const cells: number[] = [];

  for (let i = 0; i < river.cells.length; i++) {
    const cell = river.cells[i];
    if (!saved && cell !== -1 && (cell < 0 || cell >= map.cells.count)) continue;

    let point: Pt;
    if (saved) {
      point = river.points[i];
    } else if (cell === -1) {
      const previous: Pt = points.length ? points[points.length - 1] : [0, 0];
      point = projectToNearestEdge(previous, map.width, map.height);
    } else {
      point = map.cells.p[cell];
    }

    points.push([point[0], point[1]]);
    cells.push(cell);
  }

  return { points, cells };
}

/** 锚点流量：水域格沿用上一格流量，河口补 `river.discharge`，再取累计最大值保证单调。 */
function buildAnchorFlux(map: MapData, river: RiverItem, cells: number[]): number[] {
  const flux = new Array<number>(cells.length);
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell === -1) flux[i] = i > 0 ? flux[i - 1] : 0;
    else flux[i] = map.cells.fl[cell];
  }

  flux[flux.length - 1] = Math.max(flux[flux.length - 1], river.discharge);
  for (let i = 1; i < flux.length; i++) flux[i] = Math.max(flux[i], flux[i - 1]);
  return flux;
}

// --- FMG 曲流移植 ----------------------------------------------------------

function meanderPath(anchors: AnchorPath, map: MapData): MeanderResult {
  const { points: anchorPoints, cells } = anchors;
  const cellCount = cells.length;
  const isWaterCell = cells.map((cell) => cell !== -1 && map.cells.h[cell] < SEA_LEVEL);
  const startStep = cells[0] !== -1 && map.cells.h[cells[0]] < SEA_LEVEL ? 1 : 10;

  const points: Pt[] = [];
  const anchorIndices: number[] = [];
  const lastStep = cellCount - 1;
  let step = startStep;

  for (let i = 0; i <= lastStep; i++, step++) {
    const [x1, y1] = anchorPoints[i];
    anchorIndices.push(points.length);
    points.push([x1, y1]);

    if (i === lastStep) break;
    if (cells[i + 1] === -1) continue; // 边界锚点在下一轮直接落点，不插值

    const [x2, y2] = anchorPoints[i + 1];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist2 = dx * dx + dy * dy;
    if (dist2 <= 25 && cellCount >= 6) continue;

    let meanderValue = MEANDERING + 1 / step + Math.max(MEANDERING - step / 100, 0);
    if (isWaterCell[i] || isWaterCell[i + 1]) meanderValue *= WATER_MEANDER_SCALE;

    const angle = Math.atan2(dy, dx);
    const sinMeander = Math.sin(angle) * meanderValue;
    const cosMeander = Math.cos(angle) * meanderValue;

    if (step < 20 && (dist2 > 64 || (dist2 > 36 && cellCount < 5))) {
      points.push(
        [(x1 * 2 + x2) / 3 - sinMeander, (y1 * 2 + y2) / 3 + cosMeander],
        [(x1 + x2 * 2) / 3 + sinMeander / 2, (y1 + y2 * 2) / 3 - cosMeander / 2]
      );
    } else if (dist2 > 25 || cellCount < 6) {
      points.push([(x1 + x2) / 2 - sinMeander, (y1 + y2) / 2 + cosMeander]);
    }
  }

  relaxAcuteAngles(points, anchorIndices);
  return { points, anchorIndices };
}

function cornerCos(a: Pt, b: Pt, c: Pt): number {
  const ax = a[0] - b[0];
  const ay = a[1] - b[1];
  const cx = c[0] - b[0];
  const cy = c[1] - b[1];
  const la = Math.hypot(ax, ay);
  const lc = Math.hypot(cx, cy);
  if (la === 0 || lc === 0) return -1;
  return (ax * cx + ay * cy) / (la * lc);
}

function reflectAcrossLine(m: Pt, p: Pt, q: Pt): Pt {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [m[0], m[1]];
  const t = ((m[0] - p[0]) * dx + (m[1] - p[1]) * dy) / len2;
  const footX = p[0] + t * dx;
  const footY = p[1] + t * dy;
  return [2 * footX - m[0], 2 * footY - m[1]];
}

/** 以相邻两个锚点的连线为轴翻转锐角折点，4 轮后收敛。 */
function relaxAcuteAngles(points: Pt[], anchorIndices: number[]): void {
  const n = points.length;
  if (n < 3) return;

  const isAnchor = new Uint8Array(n);
  for (const index of anchorIndices) isAnchor[index] = 1;

  const prevAnchor = new Int32Array(n).fill(-1);
  const nextAnchor = new Int32Array(n).fill(-1);
  for (let i = 0, last = -1; i < n; i++) {
    prevAnchor[i] = last;
    if (isAnchor[i]) last = i;
  }
  for (let i = n - 1, last = -1; i >= 0; i--) {
    nextAnchor[i] = last;
    if (isAnchor[i]) last = i;
  }

  const acuteCost = (pos: (k: number) => Pt, i: number): number => {
    if (i <= 0 || i >= n - 1) return 0;
    const cos = cornerCos(pos(i - 1), pos(i), pos(i + 1));
    return cos > 0 ? cos : 0;
  };

  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    const snapshot: Pt[] = points.map((p) => [p[0], p[1]]);
    const at = (k: number) => snapshot[k];
    let flippedAny = false;

    for (let i = 1; i < n - 1; i++) {
      if (isAnchor[i]) continue;
      const p = prevAnchor[i];
      const q = nextAnchor[i];
      if (p < 0 || q < 0) continue;

      const flipped = reflectAcrossLine(snapshot[i], snapshot[p], snapshot[q]);
      const withFlip = (k: number) => (k === i ? flipped : snapshot[k]);

      const before = acuteCost(at, i - 1) + acuteCost(at, i) + acuteCost(at, i + 1);
      const after = acuteCost(withFlip, i - 1) + acuteCost(withFlip, i) + acuteCost(withFlip, i + 1);

      if (after < before - 1e-6) {
        points[i][0] = flipped[0];
        points[i][1] = flipped[1];
        flippedAny = true;
      }
    }

    if (!flippedAny) break;
  }
}

function projectToNearestEdge(point: Pt, width: number, height: number): Pt {
  const [x, y] = point;
  const minDist = Math.min(y, height - y, x, width - x);
  if (minDist === y) return [x, 0];
  if (minDist === height - y) return [x, height];
  if (minDist === x) return [0, y];
  return [width, y];
}

// --- 河宽加权模型 ----------------------------------------------------------

/**
 * 半宽（px）= 源头半宽 + GAIN × 流量因子^0.45 × 河长因子^0.2 × (0.65 + 0.35 × 下游进度)。
 * 流量取河道各格 `fl`，河长因子取 `cells.length`，进度为锚点序号归一化值。
 */
function riverHalfWidth(flux: number, lengthFactor: number, progress: number): number {
  const flowFactor = Math.pow((flux + 1) / Q_REF, FLOW_WEIGHT);
  const taper = 1 - PROGRESS_WEIGHT + PROGRESS_WEIGHT * progress;
  return SOURCE_HALF_WIDTH + WIDTH_GAIN * flowFactor * lengthFactor * taper;
}

/** 把锚点流量/进度铺到曲流点列上，并保证河宽单调不减。 */
function meanderWidths(meander: MeanderResult, anchorFlux: number[], river: RiverItem): number[] {
  const { points, anchorIndices } = meander;
  const count = points.length;
  const flux = new Array<number>(count);
  const progress = new Array<number>(count);
  const lastAnchor = anchorIndices.length - 1;

  for (let k = 0; k < lastAnchor; k++) {
    const start = anchorIndices[k];
    const end = anchorIndices[k + 1];
    const span = end - start;
    for (let i = start; i < end; i++) {
      const t = (i - start) / span;
      flux[i] = anchorFlux[k] + (anchorFlux[k + 1] - anchorFlux[k]) * t;
      progress[i] = (k + t) / lastAnchor;
    }
  }
  flux[count - 1] = anchorFlux[lastAnchor];
  progress[count - 1] = 1;

  const lengthFactor = Math.pow(river.cells.length / CELL_REF, LENGTH_WEIGHT);
  const widths = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    widths[i] = riverHalfWidth(flux[i], lengthFactor, progress[i]);
    if (i > 0) widths[i] = Math.max(widths[i], widths[i - 1]);
  }
  return widths;
}

// --- Catmull-Rom 加密（α = 0.1） ------------------------------------------

function catmullRomPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t0: number, t1: number, t2: number, t3: number, t: number): Pt {
  const a1x = ((t1 - t) * p0[0] + (t - t0) * p1[0]) / (t1 - t0);
  const a1y = ((t1 - t) * p0[1] + (t - t0) * p1[1]) / (t1 - t0);
  const a2x = ((t2 - t) * p1[0] + (t - t1) * p2[0]) / (t2 - t1);
  const a2y = ((t2 - t) * p1[1] + (t - t1) * p2[1]) / (t2 - t1);
  const a3x = ((t3 - t) * p2[0] + (t - t2) * p3[0]) / (t3 - t2);
  const a3y = ((t3 - t) * p2[1] + (t - t2) * p3[1]) / (t3 - t2);

  const b1x = ((t2 - t) * a1x + (t - t0) * a2x) / (t2 - t0);
  const b1y = ((t2 - t) * a1y + (t - t0) * a2y) / (t2 - t0);
  const b2x = ((t3 - t) * a2x + (t - t1) * a3x) / (t3 - t1);
  const b2y = ((t3 - t) * a2y + (t - t1) * a3y) / (t3 - t1);

  return [((t2 - t) * b1x + (t - t1) * b2x) / (t2 - t1), ((t2 - t) * b1y + (t - t1) * b2y) / (t2 - t1)];
}

function knot(a: Pt, b: Pt): number {
  return Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** CURVE_ALPHA, POINT_EPSILON);
}

/** 每段插值 SPLINE_SAMPLES 个采样点（不含终点），河宽同步线性插值。 */
function sampleCatmullRom(points: Pt[], widths: number[]): DensePath {
  const n = points.length;
  const outPoints: Pt[] = [];
  const outWidths: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i > 0 ? i - 1 : 0];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < n ? i + 2 : n - 1];

    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);

    for (let s = 0; s < SPLINE_SAMPLES; s++) {
      const f = s / SPLINE_SAMPLES;
      outPoints.push(catmullRomPoint(p0, p1, p2, p3, t0, t1, t2, t3, t1 + (t2 - t1) * f));
      outWidths.push(widths[i] + (widths[i + 1] - widths[i]) * f);
    }
  }

  outPoints.push([points[n - 1][0], points[n - 1][1]]);
  outWidths.push(widths[n - 1]);
  return compactPath(outPoints, outWidths);
}

/** 去掉 Catmull-Rom 在重复锚点处产生的零长度边。 */
function compactPath(points: Pt[], widths: number[]): DensePath {
  const keptPoints: Pt[] = [points[0]];
  const keptWidths: number[] = [widths[0]];
  for (let i = 1; i < points.length; i++) {
    const previous = keptPoints[keptPoints.length - 1];
    if (Math.hypot(points[i][0] - previous[0], points[i][1] - previous[1]) < POINT_EPSILON) continue;
    keptPoints.push(points[i]);
    keptWidths.push(widths[i]);
  }
  return { points: keptPoints, widths: keptWidths };
}

// --- 左岸/右岸闭合多边形 ---------------------------------------------------

/** 线段严格相交（端点接触不算），返回交点；平行/共线返回 null。 */
function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const qpx = c[0] - a[0];
  const qpy = c[1] - a[1];
  const t = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  if (t <= INTERSECTION_EPSILON || t >= 1 - INTERSECTION_EPSILON) return null;
  if (u <= INTERSECTION_EPSILON || u >= 1 - INTERSECTION_EPSILON) return null;
  return [a[0] + t * rx, a[1] + t * ry];
}

/** 开放折线自交裁剪：检测到边 (A,B) 与 (C,D) 相交时，用交点替换中间打结的回环顶点。 */
function pruneOpenSelfIntersections(chain: Pt[]): Pt[] {
  let points = chain.slice();
  for (;;) {
    const n = points.length;
    let cut = false;
    for (let i = 0; i < n - 1 && !cut; i++) {
      for (let j = i + 2; j < n - 1; j++) {
        const crossing = segmentIntersection(points[i], points[i + 1], points[j], points[j + 1]);
        if (!crossing) continue;
        points = points.slice(0, i + 1).concat([crossing], points.slice(j + 1));
        cut = true;
        break;
      }
    }
    if (!cut || points.length < 2) break;
  }
  return points;
}

function absPolygonArea(points: Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) * 0.5;
}

/** 闭合带状多边形自交裁剪，直到不存在严格相交的边。 */
export function pruneClosedSelfIntersections(flat: number[]): number[] {
  let points: Pt[] = [];
  for (let i = 0; i < flat.length; i += 2) points.push([flat[i], flat[i + 1]]);

  const maxCuts = Math.max(64, points.length * 2);
  for (let iter = 0; iter < maxCuts; iter++) {
    const n = points.length;
    if (n < 3) break;
    let cut = false;
    for (let i = 0; i < n && !cut; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const crossing = segmentIntersection(a, b, points[j], points[(j + 1) % n]);
        if (!crossing) continue;
        const loopA = [...points.slice(0, i + 1), crossing, ...points.slice(j + 1)];
        const loopB = [crossing, ...points.slice(i + 1, j + 1)];
        const areaA = loopA.length >= 3 ? absPolygonArea(loopA) : -1;
        const areaB = loopB.length >= 3 ? absPolygonArea(loopB) : -1;
        points = areaB > areaA ? loopB : loopA;
        cut = true;
        break;
      }
    }
    if (!cut) break;
  }

  const polygon: number[] = [];
  for (const point of points) polygon.push(point[0], point[1]);
  return polygon;
}

/**
 * 单侧岸线偏移。急弯内侧（曲率半径 < 当前半宽）把偏移点钳制到三点外接圆心，
 * 避免偏移点越过转弯中心造成回折；其余情况仍按法向 × 半宽偏移。
 */
function offsetBankPoint(points: Pt[], tangents: Pt[], index: number, half: number, side: number): Pt {
  const [x, y] = points[index];
  const [tx, ty] = tangents[index];
  const nx = -ty * side;
  const ny = tx * side;
  if (index === 0 || index === points.length - 1) return [x + nx * half, y + ny * half];

  const [px, py] = points[index - 1];
  const [qx, qy] = points[index + 1];
  const cross = (x - px) * (qy - y) - (y - py) * (qx - x);
  const inner = side > 0 ? cross > POINT_EPSILON : cross < -POINT_EPSILON;
  if (!inner) return [x + nx * half, y + ny * half];

  const a = Math.hypot(x - px, y - py);
  const b = Math.hypot(qx - x, qy - y);
  const c = Math.hypot(qx - px, qy - py);
  const radius = (a * b * c) / (2 * Math.abs(cross));
  if (radius >= half) return [x + nx * half, y + ny * half];
  return [x + nx * radius, y + ny * radius];
}

/** 沿每点切线法向生成左右岸，内侧急弯钳制 + 单岸自交裁剪，右岸逆序拼成闭合带状多边形。 */
function buildRibbon(points: Pt[], widths: number[]): number[] {
  const n = points.length;
  const tangents: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const previous = points[i > 0 ? i - 1 : 0];
    const next = points[i + 1 < n ? i + 1 : n - 1];
    let dx = next[0] - previous[0];
    let dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy);
    if (length < POINT_EPSILON) {
      dx = 1;
      dy = 0;
    } else {
      dx /= length;
      dy /= length;
    }
    tangents[i] = [dx, dy];
  }

  const left: Pt[] = new Array(n);
  const right: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = offsetBankPoint(points, tangents, i, widths[i], 1);
    right[i] = offsetBankPoint(points, tangents, i, widths[i], -1);
  }

  const leftBank = pruneOpenSelfIntersections(left);
  const rightBank = pruneOpenSelfIntersections(right);

  const polygon: number[] = [];
  for (const point of leftBank) polygon.push(point[0], point[1]);
  for (let i = rightBank.length - 1; i >= 0; i--) polygon.push(rightBank[i][0], rightBank[i][1]);
  return pruneClosedSelfIntersections(polygon);
}
