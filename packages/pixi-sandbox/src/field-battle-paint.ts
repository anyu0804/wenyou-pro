import { rayCrossesRing } from './planar-geometry';
import { Graphics } from 'pixi.js';
import type { BattleState, BattleUnit } from './battle-contract';
import type { CopyBattleUnitsResult } from './field-battle-units';
import { copyBattleUnitsIntoField as defaultCopyBattleUnitsIntoField } from './field-battle-units';
import type { FieldBattle, FieldTerrainSnapshot, FieldUnit } from './field-battle-types';
import { FIELD_BATTLE_DOM } from './field-battle-types';
import { fieldBattleOverlay } from './map-viewport';
import { cellAt } from './map-renderer';
import { appStore, type MapData } from './store';

export interface IntervalResult {
  t0: number;
  t1: number;
  tEnter: number;
  tExit: number;
}

export interface CellInterval {
  id: number;
  cellId: number;
  t0: number;
  t1: number;
  tEnter: number;
  tExit: number;
}

export type BuildFieldTerrainSnapshotFn = (
  map: MapData,
  selected: ReadonlySet<number>,
) => FieldTerrainSnapshot;

export type CopyBattleUnitsIntoFieldFn = (
  map: MapData,
  selected: ReadonlySet<number>,
  units: readonly BattleUnit[],
  battle: BattleState,
) => CopyBattleUnitsResult;

export interface FieldBattlePaintDeps {
  buildFieldTerrainSnapshot?: BuildFieldTerrainSnapshotFn;
  copyBattleUnitsIntoField?: CopyBattleUnitsIntoFieldFn;
}

// ---------------------------------------------------------------------------
// 纯几何与图论算法
// ---------------------------------------------------------------------------

function getRingVertices(ring: [number, number][]): [number, number][] {
  if (!ring || ring.length < 3) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (
    ring.length >= 4 &&
    Math.abs(first[0] - last[0]) < 1e-9 &&
    Math.abs(first[1] - last[1]) < 1e-9
  ) {
    return ring.slice(0, -1);
  }
  return ring;
}

function pointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-7) return false;
  return (
    p[0] >= Math.min(a[0], b[0]) - 1e-7 &&
    p[0] <= Math.max(a[0], b[0]) + 1e-7 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-7 &&
    p[1] <= Math.max(a[1], b[1]) + 1e-7
  );
}

/**
 * 点在多边形环判定（纯函数）。
 * includeBoundary=false 时，落在环边或顶点上的点不算在内（只碰顶点不选）。
 */
export function pointInRing(
  point: [number, number],
  ring: [number, number][],
  includeBoundary = false,
): boolean {
  const vertices = getRingVertices(ring);
  const n = vertices.length;
  if (n < 3) return false;

  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    if (pointOnSegment(point, a, b)) {
      return includeBoundary;
    }
  }

  return rayCrossesRing(point[0], point[1], vertices);
}

/**
 * 计算线段 P0->P1 与单个多边形相交的内部参数区间 [t0, t1]。
 * 若仅触碰边或顶点、未真正进入内部，则返回 null。
 */
export function computeSegmentPolygonInterval(
  p0: [number, number],
  p1: [number, number],
  ring: [number, number][],
): IntervalResult | null {
  const vertices = getRingVertices(ring);
  const n = vertices.length;
  if (n < 3) return null;

  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const lenSq = dx * dx + dy * dy;

  if (lenSq < 1e-12) {
    if (pointInRing(p0, vertices, false)) {
      return { t0: 0, t1: 1, tEnter: 0, tExit: 1 };
    }
    return null;
  }

  const tEvents: number[] = [0, 1];

  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];

    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) > 1e-9) {
      const t = ((a[0] - p0[0]) * ey - (a[1] - p0[1]) * ex) / denom;
      const u = ((a[0] - p0[0]) * dy - (a[1] - p0[1]) * dx) / denom;
      if (t >= -1e-7 && t <= 1 + 1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
        tEvents.push(Math.max(0, Math.min(1, t)));
      }
    } else {
      const crossA = (a[0] - p0[0]) * dy - (a[1] - p0[1]) * dx;
      if (Math.abs(crossA) <= 1e-7) {
        const tA = ((a[0] - p0[0]) * dx + (a[1] - p0[1]) * dy) / lenSq;
        const tB = ((b[0] - p0[0]) * dx + (b[1] - p0[1]) * dy) / lenSq;
        if (tA >= 0 && tA <= 1) tEvents.push(tA);
        if (tB >= 0 && tB <= 1) tEvents.push(tB);
      }
    }
  }

  tEvents.sort((a, b) => a - b);
  const uniqueT: number[] = [];
  for (let i = 0; i < tEvents.length; i++) {
    const t = tEvents[i];
    if (uniqueT.length === 0 || t - uniqueT[uniqueT.length - 1] > 1e-6) {
      uniqueT.push(t);
    }
  }

  let enterT = Infinity;
  let exitT = -Infinity;
  let hasInterior = false;

  for (let i = 0; i < uniqueT.length - 1; i++) {
    const tA = uniqueT[i];
    const tB = uniqueT[i + 1];
    if (tB - tA < 1e-6) continue;

    const tMid = (tA + tB) / 2;
    const midPoint: [number, number] = [p0[0] + tMid * dx, p0[1] + tMid * dy];

    if (pointInRing(midPoint, vertices, false)) {
      hasInterior = true;
      if (tA < enterT) enterT = tA;
      if (tB > exitT) exitT = tB;
    }
  }

  if (!hasInterior || exitT - enterT < 1e-6) {
    return null;
  }

  return {
    t0: enterT,
    t1: exitT,
    tEnter: enterT,
    tExit: exitT,
  };
}

/**
 * 穿格线段相交求值（纯函数）。
 * 支持计算单个多边形区间，或对多个候选地块批量求交并按沿线 t0 升序排序。
 */
export function segmentCellIntervals(
  p0: [number, number],
  p1: [number, number],
  polygon: [number, number][],
): IntervalResult | null;
export function segmentCellIntervals(
  p0: [number, number],
  p1: [number, number],
  cells: Array<{ id: number; polygon: [number, number][] }>,
): CellInterval[];
export function segmentCellIntervals(
  p0: [number, number],
  p1: [number, number],
  polygonOrCells:
    | [number, number][]
    | Array<{ id: number; polygon: [number, number][] }>,
): IntervalResult | null | CellInterval[] {
  if (!polygonOrCells || polygonOrCells.length === 0) {
    return null;
  }

  const first = polygonOrCells[0];
  if (first && typeof first === 'object' && 'polygon' in first) {
    const cellList = polygonOrCells as Array<{
      id: number;
      polygon: [number, number][];
    }>;
    const results: CellInterval[] = [];
    for (const cell of cellList) {
      const interval = computeSegmentPolygonInterval(p0, p1, cell.polygon);
      if (interval) {
        results.push({
          id: cell.id,
          cellId: cell.id,
          t0: interval.t0,
          t1: interval.t1,
          tEnter: interval.tEnter,
          tExit: interval.tExit,
        });
      }
    }
    results.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
    return results;
  }

  return computeSegmentPolygonInterval(
    p0,
    p1,
    polygonOrCells as [number, number][],
  );
}

/**
 * BFS 连通性检查（纯函数）。
 * 判断 cellIds 集合在所属地块拓扑图 cells.c 下是否形成单一连通分量。
 */
export function isConnected(
  cellIds: ReadonlySet<number> | readonly number[],
  map: MapData,
): boolean {
  const set = cellIds instanceof Set ? cellIds : new Set(cellIds);
  if (set.size <= 1) return true;

  const iterator = set.values();
  const start = iterator.next().value;
  if (start === undefined) return true;

  const visited = new Set<number>([start]);
  const queue: number[] = [start];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const neighbors = map.cells?.c?.[curr];
    if (neighbors) {
      for (let i = 0; i < neighbors.length; i++) {
        const n = neighbors[i];
        if (set.has(n) && !visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
  }

  return visited.size === set.size;
}

/**
 * 加格合法性判定（纯函数）。
 * - 首格任意；
 * - 之后必须与已选格沿边相邻（cells.c 包含已选格）；
 * - 达到上限（默认 2000）或已包含或越界则不可加。
 */
export function canAdd(
  selected: ReadonlySet<number> | readonly number[],
  candidateId: number,
  map: MapData,
  maxCells = 2000,
): boolean {
  const count = map.cells?.count ?? map.cells?.polygons?.length ?? 0;
  if (candidateId < 0 || candidateId >= count) return false;

  const set = selected instanceof Set ? selected : new Set(selected);
  if (set.has(candidateId)) return false;
  if (set.size >= maxCells) return false;
  if (set.size === 0) return true;

  const neighbors = map.cells?.c?.[candidateId];
  if (!neighbors || neighbors.length === 0) return false;

  for (let i = 0; i < neighbors.length; i++) {
    if (set.has(neighbors[i])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// AABB 辅助缓存
// ---------------------------------------------------------------------------

const aabbCache = new WeakMap<MapData, Float32Array>();

function getCellAABB(map: MapData): Float32Array {
  let cached = aabbCache.get(map);
  if (cached) return cached;

  const count = map.cells?.count ?? map.cells?.polygons?.length ?? 0;
  cached = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const poly = map.cells.polygons[i];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    if (poly) {
      for (let j = 0; j < poly.length; j++) {
        const [x, y] = poly[j];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    cached[i * 4] = minX;
    cached[i * 4 + 1] = minY;
    cached[i * 4 + 2] = maxX;
    cached[i * 4 + 3] = maxY;
  }

  aabbCache.set(map, cached);
  return cached;
}

// ---------------------------------------------------------------------------
// 涂选控制器与预览管理
// ---------------------------------------------------------------------------

let initialized = false;
let previewGfx: Graphics | null = null;
const selectedCells = new Set<number>();
let hoverCell: number | null = null;
let isPainting = false;
let lastPoint: [number, number] | null = null;

let rootElement: HTMLElement | null = null;
let canvasElement: HTMLCanvasElement | null = null;

let injectedDeps: FieldBattlePaintDeps = {};

export function setFieldBattlePaintDeps(deps: FieldBattlePaintDeps): void {
  injectedDeps = { ...deps };
}

export function getSelectedCells(): ReadonlySet<number> {
  return selectedCells;
}

export function getSelectedCellCount(): number {
  return selectedCells.size;
}

function toMapPoint(e: PointerEvent): [number, number] {
  if (!canvasElement) {
    return [e.clientX, e.clientY];
  }
  const rect = canvasElement.getBoundingClientRect();
  return appStore.toMapCoords(e.clientX - rect.left, e.clientY - rect.top);
}

function updatePaintUI(): void {
  if (!rootElement) return;

  const countEl = rootElement.querySelector<HTMLElement>(
    FIELD_BATTLE_DOM.paintCount,
  );
  if (countEl) {
    countEl.textContent = String(selectedCells.size);
  }

  const generateBtn = rootElement.querySelector<HTMLButtonElement>(
    FIELD_BATTLE_DOM.generate,
  );
  if (generateBtn) {
    generateBtn.disabled = selectedCells.size === 0;
  }
  showStatus(`战场涂选（已选 ${selectedCells.size} 格）：左键加格 · Alt+左键擦格 · 右键平移`);
}

function showStatus(message: string): void {
  if (!rootElement) return;
  const statusEl = rootElement.querySelector<HTMLElement>(
    '#tactical-toolbar-panel [data-role="status"]',
  );
  if (statusEl) {
    statusEl.textContent = message;
  }
}

export function updatePreview(): void {
  if (!previewGfx) return;
  previewGfx.clear();

  if (appStore.interactionMode !== 'fieldbattle-paint') {
    return;
  }

  const map = appStore.mapData;
  if (!map) return;

  // 1. 选中地块高亮
  for (const cellId of selectedCells) {
    const poly = map.cells.polygons[cellId];
    if (!poly || poly.length < 3) continue;

    const flat: number[] = [];
    for (let i = 0; i < poly.length; i++) {
      flat.push(poly[i][0], poly[i][1]);
    }
    previewGfx
      .poly(flat, true)
      .fill({ color: '#3b82f6', alpha: 0.38 })
      .stroke({ width: 1.5, color: '#60a5fa', alpha: 0.85 });
  }

  // 2. 当前 hover 格描边
  if (hoverCell !== null && hoverCell >= 0 && hoverCell < map.cells.count) {
    const poly = map.cells.polygons[hoverCell];
    if (poly && poly.length >= 3) {
      const flat: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        flat.push(poly[i][0], poly[i][1]);
      }
      const isSelected = selectedCells.has(hoverCell);
      previewGfx
        .poly(flat, true)
        .stroke({
          width: 2,
          color: isSelected ? '#f87171' : '#f8fafc',
          alpha: 0.95,
        });
    }
  }
}

export function enterFieldBattlePaint(): void {
  appStore.interactionMode = 'fieldbattle-paint';
  selectedCells.clear();
  hoverCell = null;
  isPainting = false;
  lastPoint = null;

  if (rootElement) {
    const panel = rootElement.querySelector<HTMLElement>(
      FIELD_BATTLE_DOM.paintPanel,
    );
    if (panel) panel.style.display = '';

    const nameInput = rootElement.querySelector<HTMLInputElement>(
      FIELD_BATTLE_DOM.paintName,
    );
    if (nameInput) nameInput.value = '';
  }

  updatePaintUI();
  updatePreview();
  showStatus('战场涂选：左键加格 · Alt+左键擦格 · 右键平移');
  appStore.emit('tactical-mode-change', 'fieldbattle-paint');
}

export function exitFieldBattlePaint(): void {
  appStore.interactionMode = 'pan';
  selectedCells.clear();
  hoverCell = null;
  isPainting = false;
  lastPoint = null;

  if (rootElement) {
    const panel = rootElement.querySelector<HTMLElement>(
      FIELD_BATTLE_DOM.paintPanel,
    );
    if (panel) panel.style.display = 'none';
  }

  if (previewGfx) {
    previewGfx.clear();
  }

  updatePaintUI();
  appStore.emit('tactical-mode-change', 'pan');
}

export function clearFieldBattlePaint(): void {
  selectedCells.clear();
  hoverCell = null;
  isPainting = false;
  lastPoint = null;

  updatePaintUI();
  updatePreview();
  showStatus('战场涂选：左键加格 · Alt+左键擦格 · 右键平移');
}

export function cancelFieldBattlePaint(): void {
  exitFieldBattlePaint();
}

/**
 * 组装并生成 FieldBattle。
 */
export function generateFieldBattle(name?: string): FieldBattle | null {
  if (selectedCells.size === 0) {
    return null;
  }

  const map = appStore.mapData;
  if (!map) return null;

  // 1. 调用 S: buildFieldTerrainSnapshot
  let terrainSnapshotBuilder = injectedDeps.buildFieldTerrainSnapshot;
  if (!terrainSnapshotBuilder) {
    throw new Error(
      '[field-battle-paint] buildFieldTerrainSnapshot 未就绪，请注入或确保 FB-S 已集成',
    );
  }

  const terrain = terrainSnapshotBuilder(map, selectedCells);

  // 2. 调用 U: copyBattleUnitsIntoField
  const copier =
    injectedDeps.copyBattleUnitsIntoField ?? defaultCopyBattleUnitsIntoField;
  const copyResult = copier(
    map,
    selectedCells,
    appStore.garrisons,
    appStore.battle,
  );

  // 3. 计算 bounds 与 anchor
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumY = 0;

  const selectedArray = [...selectedCells];
  for (const cellId of selectedArray) {
    const [cx, cy] = map.cells.p[cellId];
    sumX += cx;
    sumY += cy;
    const poly = map.cells.polygons[cellId];
    if (poly) {
      for (const [vx, vy] of poly) {
        if (vx < minX) minX = vx;
        if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy;
        if (vy > maxY) maxY = vy;
      }
    }
  }

  const computedBounds = {
    x: minX === Infinity ? 0 : minX,
    y: minY === Infinity ? 0 : minY,
    width: maxX === -Infinity ? 0 : maxX - minX,
    height: maxY === -Infinity ? 0 : maxY - minY,
  };

  const count = selectedArray.length;
  const meanX = count > 0 ? sumX / count : 0;
  const meanY = count > 0 ? sumY / count : 0;
  let computedAnchor: [number, number] = [meanX, meanY];
  let bestDistSq = Infinity;
  for (const cellId of selectedArray) {
    const [cx, cy] = map.cells.p[cellId];
    const d2 = (cx - meanX) ** 2 + (cy - meanY) ** 2;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      computedAnchor = [cx, cy];
    }
  }

  const terrainWithExtras = terrain as FieldTerrainSnapshot & {
    bounds?: { x: number; y: number; width: number; height: number };
    anchor?: [number, number];
  };
  const bounds = terrainWithExtras.bounds ?? computedBounds;
  const anchor = terrainWithExtras.anchor ?? computedAnchor;

  // 4. 组装 FieldBattle 字段
  const battleId = crypto.randomUUID();
  let battleName = (name ?? '').trim();
  if (!battleName && rootElement) {
    const nameInput = rootElement.querySelector<HTMLInputElement>(
      FIELD_BATTLE_DOM.paintName,
    );
    if (nameInput) {
      battleName = nameInput.value.trim();
    }
  }
  if (!battleName) {
    battleName = `战场${appStore.fieldBattles.length + 1}`;
  }

  const fieldBattle: FieldBattle = {
    id: battleId,
    name: battleName,
    createdAt: new Date().toISOString(),
    cellIds: selectedArray,
    anchor,
    bounds,
    terrain,
    units: copyResult.units as FieldUnit[],
    deployments: copyResult.deployments,
    sources: copyResult.sources,
    badgeStyle: appStore.garrisonStyle,
    badgeScale: appStore.garrisonScale,
  };

  appStore.fieldBattles.push(fieldBattle);
  appStore.emit('fieldbattle:changed', { battleId, kind: 'create' });

  exitFieldBattlePaint();

  if (copyResult.skippedUnknown > 0) {
    const msg = `${copyResult.skippedUnknown} 个位置未知的单位未纳入`;
    showStatus(msg);
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(msg);
    }
  }

  return fieldBattle;
}

// ---------------------------------------------------------------------------
// 指针事件监听
// ---------------------------------------------------------------------------

function onPointerDown(e: PointerEvent): void {
  if (appStore.interactionMode !== 'fieldbattle-paint') return;
  if (e.button !== 0) return; // 右键/中键不进入加格，主地图继续平移

  const map = appStore.mapData;
  if (!map) return;

  const [x, y] = toMapPoint(e);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x < 0 || x > map.width || y < 0 || y > map.height) return; // 地图外坐标无效

  const candidate = cellAt(x, y);
  if (candidate < 0 || candidate >= map.cells.count) return;

  const poly = map.cells.polygons[candidate];
  if (!poly || !pointInRing([x, y], poly, false)) return; // 点在多边形内部判断

  if (e.altKey) {
    // 擦格
    if (selectedCells.has(candidate)) {
      const nextSelected = new Set(selectedCells);
      nextSelected.delete(candidate);
      if (nextSelected.size === 0) {
        selectedCells.clear();
        updatePaintUI();
        updatePreview();
      } else if (isConnected(nextSelected, map)) {
        selectedCells.delete(candidate);
        updatePaintUI();
        updatePreview();
      } else {
        showStatus('擦除会导致战场不连通');
      }
    }
  } else {
    // 加格
    if (canAdd(selectedCells, candidate, map, 2000)) {
      selectedCells.add(candidate);
      updatePaintUI();
      updatePreview();
    } else if (selectedCells.size >= 2000) {
      showStatus('已达到 2000 格上限');
    }
  }

  isPainting = true;
  lastPoint = [x, y];
}

function onPointerMove(e: PointerEvent): void {
  if (appStore.interactionMode !== 'fieldbattle-paint') return;

  const map = appStore.mapData;
  if (!map) return;

  const [x, y] = toMapPoint(e);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  // Hover 更新
  if (x >= 0 && x <= map.width && y >= 0 && y <= map.height) {
    const candidate = cellAt(x, y);
    if (
      candidate >= 0 &&
      candidate < map.cells.count &&
      pointInRing([x, y], map.cells.polygons[candidate], false)
    ) {
      hoverCell = candidate;
    } else {
      hoverCell = null;
    }
  } else {
    hoverCell = null;
  }

  if (!isPainting || !lastPoint) {
    updatePreview();
    return;
  }

  if (x < 0 || x > map.width || y < 0 || y > map.height) {
    updatePreview();
    return;
  }

  const p0 = lastPoint;
  const p1: [number, number] = [x, y];

  if (e.altKey) {
    // Alt 拖动擦格
    if (hoverCell !== null && selectedCells.has(hoverCell)) {
      const nextSelected = new Set(selectedCells);
      nextSelected.delete(hoverCell);
      if (nextSelected.size === 0) {
        selectedCells.clear();
        updatePaintUI();
      } else if (isConnected(nextSelected, map)) {
        selectedCells.delete(hoverCell);
        updatePaintUI();
      } else {
        showStatus('擦除会导致战场不连通');
      }
    }
    lastPoint = p1;
    updatePreview();
    return;
  }

  // 穿格检测：AABB 过滤候选地块 -> 多边形求交排序 -> 依序加格
  const segMinX = Math.min(p0[0], p1[0]);
  const segMaxX = Math.max(p0[0], p1[0]);
  const segMinY = Math.min(p0[1], p1[1]);
  const segMaxY = Math.max(p0[1], p1[1]);

  const aabb = getCellAABB(map);
  const count = map.cells.count;
  const candidates: Array<{ id: number; polygon: [number, number][] }> = [];

  for (let cellId = 0; cellId < count; cellId++) {
    const cMinX = aabb[cellId * 4];
    const cMinY = aabb[cellId * 4 + 1];
    const cMaxX = aabb[cellId * 4 + 2];
    const cMaxY = aabb[cellId * 4 + 3];

    if (
      cMinX <= segMaxX &&
      cMaxX >= segMinX &&
      cMinY <= segMaxY &&
      cMaxY >= segMinY
    ) {
      const poly = map.cells.polygons[cellId];
      if (poly) {
        candidates.push({ id: cellId, polygon: poly });
      }
    }
  }

  if (candidates.length > 0) {
    const intervals = segmentCellIntervals(p0, p1, candidates);
    if (Array.isArray(intervals)) {
      for (const item of intervals) {
        if (selectedCells.has(item.cellId)) continue;
        if (selectedCells.size >= 2000) {
          showStatus('已达到 2000 格上限');
          break;
        }
        if (canAdd(selectedCells, item.cellId, map, 2000)) {
          selectedCells.add(item.cellId);
        }
      }
    }
  }

  lastPoint = p1;
  updatePaintUI();
  updatePreview();
}

function onPointerEnd(): void {
  isPainting = false;
  lastPoint = null;
}

// ---------------------------------------------------------------------------
// 模块全局初始化
// ---------------------------------------------------------------------------

export function initFieldBattlePaint(
  root: HTMLElement,
  canvas?: HTMLCanvasElement | null,
  deps?: FieldBattlePaintDeps,
): void {
  if (initialized) return;
  initialized = true;

  rootElement = root;
  canvasElement = canvas ?? root.querySelector('canvas');

  if (deps) {
    setFieldBattlePaintDeps(deps);
  }

  previewGfx = new Graphics();
  fieldBattleOverlay.addChild(previewGfx);

  // 绑定 DOM 控件事件
  const clearBtn = root.querySelector<HTMLButtonElement>(
    FIELD_BATTLE_DOM.clear,
  );
  clearBtn?.addEventListener('click', () => {
    clearFieldBattlePaint();
  });

  const cancelBtn = root.querySelector<HTMLButtonElement>(
    FIELD_BATTLE_DOM.cancel,
  );
  cancelBtn?.addEventListener('click', () => {
    cancelFieldBattlePaint();
  });

  const generateBtn = root.querySelector<HTMLButtonElement>(
    FIELD_BATTLE_DOM.generate,
  );
  generateBtn?.addEventListener('click', () => {
    try {
      generateFieldBattle();
    } catch (error) {
      console.error('[field-battle-paint] 生成战场失败', error);
      showStatus(`生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  if (canvasElement) {
    canvasElement.addEventListener('pointerdown', onPointerDown);
    canvasElement.addEventListener('pointermove', onPointerMove);
    canvasElement.addEventListener('pointerup', onPointerEnd);
    canvasElement.addEventListener('pointercancel', onPointerEnd);
    canvasElement.addEventListener('pointerleave', onPointerEnd);
  } else if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  }

  const clearPaintOverlayOnly = () => {
    if (selectedCells.size > 0 || isPainting) {
      selectedCells.clear();
      isPainting = false;
      lastPoint = null;
    }
    hoverCell = null;
    if (previewGfx) previewGfx.clear();
    if (rootElement) {
      const panel = rootElement.querySelector<HTMLElement>(
        FIELD_BATTLE_DOM.paintPanel,
      );
      if (panel) panel.style.display = 'none';
    }
  };

  appStore.on('tactical-mode-change', (mode) => {
    if (mode !== 'fieldbattle-paint') clearPaintOverlayOnly();
  });

  appStore.on('brush:changed', () => {
    if (appStore.interactionMode !== 'fieldbattle-paint') clearPaintOverlayOnly();
  });

  appStore.on('theater:leaving', () => {
    if (appStore.interactionMode === 'fieldbattle-paint' || selectedCells.size > 0 || isPainting) {
      exitFieldBattlePaint();
    }
  });

  const resetPaintState = () => {
    selectedCells.clear();
    hoverCell = null;
    isPainting = false;
    lastPoint = null;
    if (previewGfx) previewGfx.clear();
    updatePaintUI();
  };
  appStore.on('map:loaded', resetPaintState);
  appStore.on('map:cleared', resetPaintState);
}
