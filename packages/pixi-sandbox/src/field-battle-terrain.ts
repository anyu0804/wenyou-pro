import { rayCrossesRing } from './planar-geometry';
import { diff, intersection, union, type MultiPolygon, type Polygon } from 'martinez-polygon-clipping';
import type { BurgTier, MapData } from './store';
import type { FieldPolygonPart, FieldRing, FieldTerrainSnapshot } from './field-battle-types';
import {
  CONTOUR_STYLES,
  LAKE_FILL_COLOR,
  collectContourChains,
  collectLakes,
  computeTerrainCellColor,
} from './terrain-heightmap';
import { RIVER_ALPHA, RIVER_COLOR, collectRiverPolygons, pruneClosedSelfIntersections } from './river-renderer';
import { COAST_BANDS, COAST_LINE_STYLE, buildCoastBandPolygon, buildEdgeRecords, collectCoastGeometry } from './map-renderer';

/**
 * 战场地形快照：在完整主地图上收集地块/河流/湖泊/海岸/等高线，再裁剪到 displayOutline。
 *
 * - 快照只含普通数组、数字、字符串，不持有 MapData、typed array 或 Pixi 对象；窗口只读快照。
 * - 颜色固定按地形视图 + 山影计算，不受主地图当前 viewMode / showHillshade 影响。
 * - 折线（等高线、海岸线）按线段与 displayOutline 边界的交点切分，离开展示范围即断开，不跨段连接。
 */

const CLIP_EPSILON = 1e-9;
const BOUNDARY_BUCKET = 64;
/** 折线与展示边界共用地块顶点时会贴着边界走；0.05px 内按“在边界上”处理，避免贴边段被误判丢弃。 */
const CLIP_BOUNDARY_TOLERANCE = 0.05;

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const toPolygon = (part: FieldPolygonPart): Polygon => [part.outer, ...part.holes];

const toMultiPolygon = (parts: FieldPolygonPart[]): MultiPolygon => parts.map(toPolygon);

const toParts = (multi: MultiPolygon): FieldPolygonPart[] =>
  multi.map(([outer, ...holes]) => ({ outer, holes }));

function copyRing(ring: [number, number][]): FieldRing {
  const out: FieldRing = new Array(ring.length);
  for (let i = 0; i < ring.length; i++) out[i] = [ring[i][0], ring[i][1]];
  return out;
}

function closeRing(ring: FieldRing): FieldRing {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring;
}

function flatToRing(flat: number[]): FieldRing {
  const ring: FieldRing = new Array(flat.length / 2);
  for (let i = 0; i < flat.length; i += 2) ring[i / 2] = [flat[i], flat[i + 1]];
  return ring;
}

function ringBox(ring: FieldRing): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function boxOfParts(parts: FieldPolygonPart[]): Box {
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const part of parts) {
    for (const [x, y] of part.outer) {
      if (x < box.minX) box.minX = x;
      if (y < box.minY) box.minY = y;
      if (x > box.maxX) box.maxX = x;
      if (y > box.maxY) box.maxY = y;
    }
  }
  return box;
}

/**
 * 逐对树状合并。martinez 0.9.0 一次传入多个多边形求并会返回互相重叠的错误结果
 * （实测地块面积和 843.81 的 40 格选区被并成面积 905.85 的两块），逐对合并结果与地块面积和一致。
 */
function unionCellPolygons(map: MapData, cellIds: Iterable<number>): MultiPolygon {
  let level: MultiPolygon[] = [];
  for (const cellId of cellIds) level.push([[copyRing(map.cells.polygons[cellId])]]);
  while (level.length > 1) {
    const next: MultiPolygon[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? union(level[i], level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

function ringToFlat(ring: FieldRing): number[] {
  const flat: number[] = [];
  for (const [x, y] of ring) flat.push(x, y);
  return flat;
}

function dedupeRing(ring: FieldRing): FieldRing {
  if (ring.length === 0) return ring;
  const cleaned: FieldRing = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const cur = ring[i];
    if (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) >= 1e-6) {
      cleaned.push(cur);
    }
  }
  return closeRing(cleaned);
}

/** 单个多边形与展示范围求交；保留孔洞，结果可为多块。 */
export function intersectPolygonWithOutline(
  ring: FieldRing,
  outline: FieldPolygonPart[]
): FieldPolygonPart[] {
  const cleanRing = dedupeRing(ring);
  if (cleanRing.length < 4) return [];
  const outlineGeometry = toMultiPolygon(outline);
  // martinez 0.9.0 对部分自交海岸带会因参数方向抛 holeOf 错误；第三条把环修成简单多边形再求交。
  // 依次尝试三种输入；全部失败时抛出汇总错误，不返回空结果。
  const attempts = [
    () => intersection(outlineGeometry, [cleanRing]),
    () => intersection([cleanRing], outlineGeometry),
    () => {
      const pruned = dedupeRing(flatToRing(pruneClosedSelfIntersections(ringToFlat(cleanRing))));
      return pruned.length < 4 ? [] : intersection(outlineGeometry, [pruned]);
    },
  ];
  const errors: unknown[] = [];
  for (const attempt of attempts) {
    try {
      return toParts(attempt());
    } catch (error) {
      errors.push(error);
    }
  }
  throw new Error(`[field-battle-terrain] 多边形与展示范围求交失败（${ring.length} 点）`, { cause: errors });
}

function clipCoastBandSegment(
  map: MapData,
  segment: FieldRing,
  offset: number,
  displayOutline: FieldPolygonPart[]
): FieldPolygonPart[] {
  const polygon = buildCoastBandPolygon(map, segment, offset);
  if (polygon.length < 6) return [];
  try {
    return intersectPolygonWithOutline(flatToRing(polygon), displayOutline);
  } catch (err) {
    if (segment.length <= 2) throw err;
    const mid = Math.floor(segment.length / 2);
    return [
      ...clipCoastBandSegment(map, segment.slice(0, mid + 1), offset, displayOutline),
      ...clipCoastBandSegment(map, segment.slice(mid), offset, displayOutline),
    ];
  }
}

// --- 点在展示范围内 ----------------------------------------------------------

function pointInOutline(x: number, y: number, outline: FieldPolygonPart[]): boolean {
  for (const part of outline) {
    if (!rayCrossesRing(x, y, part.outer)) continue;
    let inHole = false;
    for (const hole of part.holes) {
      if (rayCrossesRing(x, y, hole)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

// --- 折线裁剪 ----------------------------------------------------------------

interface BoundaryIndex {
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  buckets: number[][];
  /** 每段 4 个数：ax, ay, bx, by */
  segments: number[];
  marks: Int32Array;
  mark: number;
}

function buildBoundaryIndex(outline: FieldPolygonPart[]): BoundaryIndex {
  const segments: number[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const part of outline) {
    for (const ring of [part.outer, ...part.holes]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (a[0] === b[0] && a[1] === b[1]) continue;
        segments.push(a[0], a[1], b[0], b[1]);
        if (a[0] < minX) minX = a[0];
        if (a[1] < minY) minY = a[1];
        if (a[0] > maxX) maxX = a[0];
        if (a[1] > maxY) maxY = a[1];
      }
    }
  }

  const cols = Math.max(1, Math.ceil((maxX - minX) / BOUNDARY_BUCKET) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / BOUNDARY_BUCKET) + 1);
  const buckets = Array.from({ length: cols * rows }, () => [] as number[]);
  const count = segments.length / 4;

  for (let s = 0; s < count; s++) {
    const o = s * 4;
    const minBx = clampBucket(Math.floor((Math.min(segments[o], segments[o + 2]) - minX) / BOUNDARY_BUCKET), cols);
    const maxBx = clampBucket(Math.floor((Math.max(segments[o], segments[o + 2]) - minX) / BOUNDARY_BUCKET), cols);
    const minBy = clampBucket(Math.floor((Math.min(segments[o + 1], segments[o + 3]) - minY) / BOUNDARY_BUCKET), rows);
    const maxBy = clampBucket(Math.floor((Math.max(segments[o + 1], segments[o + 3]) - minY) / BOUNDARY_BUCKET), rows);
    for (let by = minBy; by <= maxBy; by++) {
      for (let bx = minBx; bx <= maxBx; bx++) buckets[by * cols + bx].push(s);
    }
  }

  return { minX, minY, cols, rows, buckets, segments, marks: new Int32Array(count), mark: 0 };
}

const clampBucket = (value: number, limit: number): number =>
  value < 0 ? 0 : value >= limit ? limit - 1 : value;

/** 收集线段 (a,b) 与展示边界的交点参数 t（严格在 0..1 内，端点交点交给邻段）。 */
function collectCuts(
  index: BoundaryIndex,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cuts: number[]
): void {
  const minBx = clampBucket(Math.floor((Math.min(ax, bx) - index.minX) / BOUNDARY_BUCKET), index.cols);
  const maxBx = clampBucket(Math.floor((Math.max(ax, bx) - index.minX) / BOUNDARY_BUCKET), index.cols);
  const minBy = clampBucket(Math.floor((Math.min(ay, by) - index.minY) / BOUNDARY_BUCKET), index.rows);
  const maxBy = clampBucket(Math.floor((Math.max(ay, by) - index.minY) / BOUNDARY_BUCKET), index.rows);

  const rx = bx - ax;
  const ry = by - ay;
  index.mark += 1;

  for (let by2 = minBy; by2 <= maxBy; by2++) {
    for (let bx2 = minBx; bx2 <= maxBx; bx2++) {
      for (const segment of index.buckets[by2 * index.cols + bx2]) {
        if (index.marks[segment] === index.mark) continue;
        index.marks[segment] = index.mark;

        const o = segment * 4;
        const cx = index.segments[o];
        const cy = index.segments[o + 1];
        const sx = index.segments[o + 2] - cx;
        const sy = index.segments[o + 3] - cy;
        const denominator = rx * sy - ry * sx;
        if (Math.abs(denominator) < 1e-12) continue;

        const qpx = cx - ax;
        const qpy = cy - ay;
        const t = (qpx * sy - qpy * sx) / denominator;
        if (t <= CLIP_EPSILON || t >= 1 - CLIP_EPSILON) continue;
        const u = (qpx * ry - qpy * rx) / denominator;
        if (u < -CLIP_EPSILON || u > 1 + CLIP_EPSILON) continue;
        cuts.push(t);
      }
    }
  }
}

function segmentPoint(a: [number, number], b: [number, number], t: number): [number, number] {
  if (t <= 0) return [a[0], a[1]];
  if (t >= 1) return [b[0], b[1]];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function distanceSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const ex = px - (ax + dx * t);
  const ey = py - (ay + dy * t);
  return ex * ex + ey * ey;
}

/** 点到展示边界的最短距离平方；只查点在的 3×3 桶邻域。 */
function boundaryDistanceSq(index: BoundaryIndex, x: number, y: number): number {
  const bucketX = clampBucket(Math.floor((x - index.minX) / BOUNDARY_BUCKET), index.cols);
  const bucketY = clampBucket(Math.floor((y - index.minY) / BOUNDARY_BUCKET), index.rows);
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    const by = bucketY + dy;
    if (by < 0 || by >= index.rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const bx = bucketX + dx;
      if (bx < 0 || bx >= index.cols) continue;
      for (const segment of index.buckets[by * index.cols + bx]) {
        const o = segment * 4;
        const distance = distanceSqToSegment(
          x,
          y,
          index.segments[o],
          index.segments[o + 1],
          index.segments[o + 2],
          index.segments[o + 3]
        );
        if (distance < best) best = distance;
      }
    }
  }
  return best;
}

const CLIP_TOLERANCE_SQ = CLIP_BOUNDARY_TOLERANCE * CLIP_BOUNDARY_TOLERANCE;

/**
 * 子段是否保留。中点在内直接保留；中点只是贴近边界（贴边行走）时，
 * 还要求至少一个端点也贴着边界，避免把仅擦过边界外侧的短段留下。
 */
function segmentInside(
  index: BoundaryIndex,
  outline: FieldPolygonPart[],
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): boolean {
  if (pointInOutline(x, y, outline)) return true;
  if (boundaryDistanceSq(index, x, y) > CLIP_TOLERANCE_SQ) return false;
  return boundaryDistanceSq(index, ax, ay) <= CLIP_TOLERANCE_SQ
    || boundaryDistanceSq(index, bx, by) <= CLIP_TOLERANCE_SQ;
}

interface FieldLine {
  points: FieldRing;
  closed: boolean;
}

/**
 * 按展示范围裁剪一条折线：逐段求交、按交点切分，保留中点落在范围内的子段。
 * 闭合折线整条都在范围内时保持 closed；一旦被裁剪，输出均为开放段。
 * 不依赖“是否检测到交点”：折线可与边界共用地块顶点贴边行走，此时没有严格交点，只能靠子段中点判定。
 */
function clipPolyline(
  rawPoints: FieldRing,
  closed: boolean,
  outline: FieldPolygonPart[],
  index: BoundaryIndex
): FieldLine[] {
  const duplicateEnd = closed && rawPoints.length > 1
    && rawPoints[0][0] === rawPoints[rawPoints.length - 1][0]
    && rawPoints[0][1] === rawPoints[rawPoints.length - 1][1];
  const points = duplicateEnd ? rawPoints.slice(0, -1) : rawPoints;
  if (points.length < 2) return [];

  const segmentCount = closed ? points.length : points.length - 1;
  const runs: FieldRing[] = [];
  const cuts: number[] = [];
  let current: FieldRing | null = null;

  for (let s = 0; s < segmentCount; s++) {
    const a = points[s];
    const b = points[(s + 1) % points.length];
    cuts.length = 0;
    cuts.push(0, 1);
    collectCuts(index, a[0], a[1], b[0], b[1], cuts);
    cuts.sort((p, q) => p - q);

    for (let i = 0; i + 1 < cuts.length; i++) {
      const t0 = cuts[i];
      const t1 = cuts[i + 1];
      if (t1 - t0 <= CLIP_EPSILON) continue;
      const mid = segmentPoint(a, b, (t0 + t1) / 2);
      const inside = segmentInside(index, outline, mid[0], mid[1], a[0], a[1], b[0], b[1]);
      if (!inside) {
        current = null;
        continue;
      }
      const start = segmentPoint(a, b, t0);
      const end = segmentPoint(a, b, t1);
      const tail = current ? current[current.length - 1] : null;
      if (current && tail && tail[0] === start[0] && tail[1] === start[1]) current.push(end);
      else {
        current = [start, end];
        runs.push(current);
      }
    }
  }

  const lines: FieldLine[] = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    const runClosed = closed && run.length > 2
      && run[0][0] === run[run.length - 1][0]
      && run[0][1] === run[run.length - 1][1];
    lines.push({ points: runClosed ? run.slice(0, -1) : run, closed: runClosed });
  }
  return lines;
}

function clipRings(
  rings: FieldRing[],
  outline: FieldPolygonPart[],
  index: BoundaryIndex
): FieldLine[] {
  const lines: FieldLine[] = [];
  for (const ring of rings) {
    const closed = ring.length > 1
      && ring[0][0] === ring[ring.length - 1][0]
      && ring[0][1] === ring[ring.length - 1][1];
    lines.push(...clipPolyline(ring, closed, outline, index));
  }
  return lines;
}

/** 闭合海岸线切成两段开放折线，避免晕染多边形在接缝处绕回自交。 */
function splitClosedLine(points: FieldRing): FieldRing[] {
  if (points.length < 4) return [points];
  const half = Math.floor(points.length / 2);
  const first: FieldRing = points.slice(0, half + 1);
  const second: FieldRing = points.slice(half);
  second.push([points[0][0], points[0][1]]);
  return [first, second];
}

// --- 快照 --------------------------------------------------------------------

function assertSelection(map: MapData, selected: ReadonlySet<number>): void {
  if (selected.size === 0) throw new Error('[field-battle-terrain] 选区为空，无法生成地形快照');
  for (const cellId of selected) {
    if (!Number.isInteger(cellId) || cellId < 0 || cellId >= map.cells.count) {
      throw new Error(`[field-battle-terrain] 地块 ID 越界：${cellId}`);
    }
  }
}

export interface FieldBattleFrame {
  /** selected 中离选中格中心质心最近的地块中心 */
  anchor: [number, number];
  /** selected 地块本体（不是 display 范围）的 AABB */
  bounds: { x: number; y: number; width: number; height: number };
}

/**
 * 战场外框：`FieldTerrainSnapshot` 冻结类型不含 anchor/bounds，
 * 由 FB-P 组装 `FieldBattle` 时与快照一起取得。
 */
export function computeFieldBattleFrame(map: MapData, selected: ReadonlySet<number>): FieldBattleFrame {
  assertSelection(map, selected);
  const { cells } = map;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let centerSumX = 0;
  let centerSumY = 0;
  for (const cellId of selected) {
    for (const [x, y] of cells.polygons[cellId]) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    centerSumX += cells.p[cellId][0];
    centerSumY += cells.p[cellId][1];
  }

  const centroidX = centerSumX / selected.size;
  const centroidY = centerSumY / selected.size;
  let anchor: [number, number] = [centroidX, centroidY];
  let anchorDistance = Infinity;
  for (const cellId of selected) {
    const [x, y] = cells.p[cellId];
    const distance = (x - centroidX) ** 2 + (y - centroidY) ** 2;
    if (distance < anchorDistance) {
      anchorDistance = distance;
      anchor = [x, y];
    }
  }

  return {
    anchor,
    bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
  };
}

export function buildFieldTerrainSnapshot(
  map: MapData,
  selected: ReadonlySet<number>
): FieldTerrainSnapshot {
  const { cells } = map;
  assertSelection(map, selected);

  const display = new Set<number>(selected);
  for (const cellId of selected) {
    for (const neighbor of cells.c[cellId]) display.add(neighbor);
  }

  const battleOutline = toParts(unionCellPolygons(map, selected));
  const displayOutline = toParts(unionCellPolygons(map, display));
  const displayGeometry = toMultiPolygon(displayOutline);
  const contextOutline = toParts(diff(displayGeometry, toMultiPolygon(battleOutline)));
  const displayBox = boxOfParts(displayOutline);

  const cellEntries: FieldTerrainSnapshot['cells'] = [];
  for (const cellId of display) {
    cellEntries.push({
      polygon: closeRing(copyRing(cells.polygons[cellId])),
      color: computeTerrainCellColor(map, cellId, 'terrain', true),
      context: !selected.has(cellId),
    });
  }

  const rivers: FieldTerrainSnapshot['rivers'] = [];
  for (const flat of collectRiverPolygons(map)) {
    const ring = flatToRing(flat);
    if (!boxesOverlap(ringBox(ring), displayBox)) continue;
    const parts = intersectPolygonWithOutline(ring, displayOutline);
    if (parts.length) rivers.push({ parts, color: RIVER_COLOR, alpha: RIVER_ALPHA });
  }

  const lakes: FieldTerrainSnapshot['lakes'] = [];
  for (const ring of collectLakes(map)) {
    if (!boxesOverlap(ringBox(ring), displayBox)) continue;
    const parts = intersectPolygonWithOutline(ring, displayOutline);
    if (parts.length) lakes.push({ parts, color: LAKE_FILL_COLOR });
  }

  const edgeRecords = buildEdgeRecords(map);
  const coast = collectCoastGeometry(map, edgeRecords);

  const boundary = buildBoundaryIndex(displayOutline);
  const clippedCoastLines: FieldLine[] = [];
  for (const line of coast.lines) {
    clippedCoastLines.push(...clipPolyline(line.points, line.closed, displayOutline, boundary));
  }

  // 海岸带先按裁剪后的中心线段生成，再与展示范围求交。
  // 主地图整条链的晕染多边形在复杂海湾会自交，martinez 0.9.0 会抛错；
  // 裁剪后的短链不自交，且仍是同一中心线、同一偏移与水侧投票。
  const coastBands: FieldTerrainSnapshot['coastBands'] = [];
  for (const band of COAST_BANDS) {
    const parts: FieldPolygonPart[] = [];
    for (const piece of clippedCoastLines) {
      const segments = piece.closed ? splitClosedLine(piece.points) : [piece.points];
      for (const segment of segments) {
        parts.push(...clipCoastBandSegment(map, segment, band.offset, displayOutline));
      }
    }
    if (parts.length) coastBands.push({ parts, color: band.color, alpha: band.alpha });
  }

  const contours: FieldTerrainSnapshot['contours'] = [];
  const contourChains = collectContourChains(map, edgeRecords);
  const minor = clipRings(contourChains.minor, displayOutline, boundary);
  if (minor.length) contours.push({ lines: minor, style: CONTOUR_STYLES.minor });
  const major = clipRings(contourChains.major, displayOutline, boundary);
  if (major.length) contours.push({ lines: major, style: CONTOUR_STYLES.major });

  const coastlines: FieldTerrainSnapshot['coastlines'] = clippedCoastLines.length
    ? [{ lines: clippedCoastLines, style: COAST_LINE_STYLE }]
    : [];

  const burgs: { name: string; x: number; y: number; tier: BurgTier }[] = [];
  for (const burg of map.burgs) {
    if (burg.removed || !selected.has(burg.cell)) continue;
    burgs.push({ name: burg.name, x: burg.x, y: burg.y, tier: burg.tier });
  }

  return {
    displayOutline,
    battleOutline,
    contextOutline,
    cells: cellEntries,
    coastBands,
    lakes,
    rivers,
    coastlines,
    contours,
    burgs,
  };
}
