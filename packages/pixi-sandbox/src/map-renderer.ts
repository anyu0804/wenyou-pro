import { Container, Graphics, Rectangle, Sprite, type Application } from 'pixi.js';
import { appStore, terrainContainer, recomputeBurgTiers, recomputeRegionPoles, type MapData } from './store';
import { SEA_LEVEL } from './map-loader';
import { computeTerrainCellColor, drawWaterAndContours } from './terrain-heightmap';
import { renderRivers } from './river-renderer';
import { clearMapLabels, rebuildMapLabels, updateLabelLod, type LabelLodOptions } from './label-lod';
import { buildWorkspaceVaultFallbackUrl, clearBaseImageCache, loadBaseImage } from './retouch-layer';
import { serializeImageBaseSpecFromMap } from './image-map-builder';
import type { FieldRing, FieldStrokeStyle } from './field-battle-types';

/**
 * 底图渲染 + 在线刷地形/宗教/政权（Agent 1 独占文件 2/3）
 *
 * 图层全部挂在共享的 `terrainContainer` 下，顺序自下而上：
 *   海面底色 → 地块多边形（分块 Graphics）→ 等高线 → 经纬网 → 河流 → 边界 → 地名标签 → 光标/高亮
 *
 * 地块按 180px 分块，重刷只重建受影响的块，因此拖笔时不会整图重绘。
 */

const CHUNK_SIZE = 180;
const BUCKET_SIZE = 32;

const NEUTRAL_LAND = '#c4c1b0';
const COAST_LINE = '#21323d';

type BrushField = 'h' | 'state' | 'province' | 'religion';

export interface EdgeRecord {
  i: number;
  j: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

interface PaintRecord {
  cell: number;
  field: BrushField;
  before: number;
  after: number;
}

// --- 模块级图层/数据 ---------------------------------------------------------
let pixiApp: Application | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let map: MapData | null = null;
let mapWidth = 1440;
let mapHeight = 888;

let oceanGfx: Graphics;
let baseImageContainer: Container;
let baseImageSprite: Sprite | null = null;
let retouchContainer: Container;
let coastGfx: Graphics;
let cellRoot: Container;
let contourGfx: Graphics;
let gridGfx: Graphics;
let riverGfx: Graphics;
let borderGfx: Graphics;
let burgMarkers: Graphics;
let labelLayer: Container;
let overlayGfx: Graphics;

let chunkCols = 1;
let chunkRows = 1;
let chunkContainers: Container[] = [];
let chunkGraphics: Graphics[] = [];
let chunkCells: number[][] = [];
let cellChunk: Int32Array = new Int32Array(0);
let cellFill: string[] = [];
let flatPolygons: number[][] = [];

let cellCenters: Float32Array = new Float32Array(0);
let bucketCols = 1;
let bucketRows = 1;
let centerBuckets: number[][] = [];
let centerSearchRadius = 48;
let baseImageErrorBanner: HTMLDivElement | null = null;

let edges: EdgeRecord[] = [];
let stateColors: string[] = [];
let provinceColors: string[] = [];
let religionColors: string[] = [];


// --- 绘制/刷新调度 -----------------------------------------------------------
const dirtyChunks = new Set<number>();
let terrainDirty = true;
let bordersDirty = true;
let labelsDirty = true;

// --- 画笔 ----------------------------------------------------------------
let isPainting = false;
let strokeRecords: PaintRecord[] = [];
let strokeTouched = new Set<number>();
let strokeTouchedHeights = false;
const undoStack: PaintRecord[][] = [];
const redoStack: PaintRecord[][] = [];
const MAX_UNDO = 80;

let cursorX = -1;
let cursorY = -1;
let hoverCell = -1;
let pointerInside = false;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const isImageBaseMap = (data: MapData | null): boolean => data?.source.baseKind === 'image';

export function getRetouchContainer(): Container {
  return retouchContainer;
}

function clearBaseImageErrorBanner(): void {
  if (baseImageErrorBanner) {
    baseImageErrorBanner.remove();
    baseImageErrorBanner = null;
  }
}

function showBaseImageErrorBanner(mapName: string, detail?: string): void {
  if (typeof document === 'undefined') return;
  clearBaseImageErrorBanner();
  const banner = document.createElement('div');
  banner.id = 'wenyou-base-image-error';
  banner.setAttribute('role', 'alert');
  banner.style.cssText =
    'position:fixed;top:68px;left:50%;transform:translateX(-50%);z-index:10010;max-width:min(560px,86vw);display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:rgba(127,29,29,0.94);border:1px solid #f87171;color:#fef2f2;font-size:12px;line-height:1.45;box-shadow:0 12px 32px rgba(0,0,0,0.55);';
  const text = document.createElement('span');
  text.textContent = `图片底图加载失败（${mapName}）${detail ? `：${detail}` : ''}。请检查图集文件是否存在或重新导入图片底图。`;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '关闭';
  closeBtn.style.cssText =
    'flex-shrink:0;background:rgba(15,23,42,0.65);color:#fecaca;border:1px solid rgba(248,113,113,0.6);border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px;';
  closeBtn.addEventListener('click', clearBaseImageErrorBanner);
  banner.append(text, closeBtn);
  (document.getElementById('app') ?? document.body).appendChild(banner);
  baseImageErrorBanner = banner;
}

function clearBaseImageSprite(): void {
  if (baseImageSprite) {
    baseImageSprite.removeFromParent();
    baseImageSprite.destroy({ texture: false, textureSource: false });
    baseImageSprite = null;
  }
  if (baseImageContainer) {
    baseImageContainer.removeChildren();
  }
}

function syncCanvasCursor(): void {
  if (!canvasEl) return;
  const mode = appStore.interactionMode;
  if (isBrushMode() || mode === 'retouch-erase') {
    canvasEl.style.cursor = 'none';
  } else if (mode === 'retouch-pick') {
    canvasEl.style.cursor = 'crosshair';
  } else if (mode === 'pan') {
    canvasEl.style.cursor = 'grab';
  } else if (!mode.startsWith('tactical-') && mode !== 'fieldbattle-paint') {
    canvasEl.style.cursor = 'default';
  }
}

// --- 初始化 ----------------------------------------------------------------
export function initMapRenderer(app: Application, canvas: HTMLCanvasElement): void {
  if (pixiApp) return;
  pixiApp = app;
  canvasEl = canvas;

  oceanGfx = new Graphics();
  baseImageContainer = new Container();
  retouchContainer = new Container();
  coastGfx = new Graphics();
  cellRoot = new Container();
  contourGfx = new Graphics();
  gridGfx = new Graphics();
  riverGfx = new Graphics();
  borderGfx = new Graphics();
  burgMarkers = new Graphics();
  labelLayer = new Container();
  overlayGfx = new Graphics();

  terrainContainer.addChild(
    oceanGfx,
    baseImageContainer,
    retouchContainer,
    coastGfx,
    cellRoot,
    contourGfx,
    gridGfx,
    riverGfx,
    borderGfx,
    burgMarkers,
    labelLayer,
    overlayGfx
  );

  bindStoreEvents();
  bindPointerEvents(canvas);
  app.ticker.add(onTick);
}

function bindStoreEvents(): void {
  const handleMapReady = (data: MapData) => {
    if (!data) return;
    if (map === data) {
      repaintMap();
      return;
    }
    buildMap(data);
  };
  appStore.on('map:loaded', handleMapReady);
  appStore.on('map:cleared', clearMap);

  appStore.on('view:changed', repaintMap);
  appStore.on('terrain:style', repaintMap);
  appStore.on('labels:style', () => {
    if (!map) return;
    updateLabelLod(burgMarkers, appStore.viewMode, terrainContainer.worldTransform.a, true, currentLabelOptions());
  });
  appStore.on('entity:changed', () => {
    buildPalettes();
    recomputeColors();
    repaintAllCells();
    bordersDirty = true;
    labelsDirty = true;
  });
  appStore.on('brush:changed', () => {
    if (!map) return;
    drawOverlay();
    syncCanvasCursor();
  });
  appStore.on('tactical-mode-change', () => {
    if (!map) return;
    drawOverlay();
    syncCanvasCursor();
  });
  appStore.on('overlay:alpha', (alpha: number) => {
    if (!map) return;
    const clamped = clamp(Number.isFinite(alpha) ? alpha : 0.38, 0, 0.9);
    map.source.overlayAlpha = clamped;
    if (isImageBaseMap(map)) {
      cellRoot.alpha = clamped;
    }
  });
  appStore.on('grid:changed', () => {
    if (!map) return;
    drawGraticule();
  });
}

const isBrushMode = (): boolean => appStore.interactionMode.startsWith('brush-');

function bindPointerEvents(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || !isBrushMode()) return;
    if (!map) return;
    isPainting = true;
    strokeRecords = [];
    strokeTouched.clear();
    paintAtScreen(event);
  });

  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    const [x, y] = toMap(event);
    cursorX = x;
    cursorY = y;
    pointerInside = true;
    hoverCell = cellAt(x, y);
    if (isPainting) paintAtScreen(event);
    else drawOverlay();
  });

  canvas.addEventListener('pointerleave', () => {
    pointerInside = false;
    hoverCell = -1;
    drawOverlay();
  });

  const endStroke = () => {
    if (!isPainting) return;
    isPainting = false;
    if (strokeTouchedHeights) {
      // 拖笔期间只增量重刷地块分块；水体/等高线/河流等重资产重建留到收笔一次
      terrainDirty = true;
      strokeTouchedHeights = false;
    }
    if (strokeRecords.length) {
      undoStack.push(strokeRecords);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack.length = 0;
      applyPoleRecompute(strokeRecords);
      appStore.emit('brush:painted', {
        mode: appStore.interactionMode,
        cells: new Set(strokeRecords.map((record) => record.cell)).size,
      });
    }
    strokeRecords = [];
    strokeTouched.clear();
    bordersDirty = true;
  };
  window.addEventListener('pointerup', endStroke);
  window.addEventListener('pointercancel', endStroke);
  appStore.on('theater:leaving', endStroke);
  appStore.on('brush:finish', endStroke);
}

const toMap = (event: PointerEvent): [number, number] => {
  if (!canvasEl) return [0, 0];
  const rect = canvasEl.getBoundingClientRect();
  return appStore.toMapCoords(event.clientX - rect.left, event.clientY - rect.top);
};

// --- 建图 ------------------------------------------------------------------
function clearMap(): void {
  map = null;
  undoStack.length = 0;
  redoStack.length = 0;
  strokeRecords = [];
  strokeTouched.clear();
  isPainting = false;
  hoverCell = -1;
  dirtyChunks.clear();
  clearBaseImageErrorBanner();
  clearBaseImageSprite();
  clearBaseImageCache();
  cellRoot.alpha = 1;
  for (const container of chunkContainers) container.destroy({ children: true, context: true });
  chunkContainers = [];
  chunkGraphics = [];
  chunkCells = [];
  flatPolygons = [];
  cellFill = [];
  edges = [];
  oceanGfx.clear();
  coastGfx.clear();
  contourGfx.clear();
  gridGfx.clear();
  riverGfx.clear();
  borderGfx.clear();
  overlayGfx.clear();
  clearMapLabels(labelLayer, burgMarkers);
  if (canvasEl) canvasEl.style.cursor = 'default';
}

function buildMap(data: MapData): void {
  map = data;
  mapWidth = data.width;
  mapHeight = data.height;
  undoStack.length = 0;
  redoStack.length = 0;
  strokeRecords = [];

  clearBaseImageErrorBanner();
  clearBaseImageSprite();
  if (isImageBaseMap(data)) {
    const overlayAlpha = clamp(data.source.overlayAlpha ?? 0.38, 0, 0.9);
    data.source.overlayAlpha = overlayAlpha;
    cellRoot.alpha = overlayAlpha;
    if (data.source.imageUrl) {
      const mountBaseImage = (url: string, retried: boolean) => {
        loadBaseImage(
          url,
          data.width,
          data.height,
          (texture) => {
            if (map !== data) return;
            clearBaseImageErrorBanner();
            clearBaseImageSprite();
            const sprite = new Sprite(texture);
            sprite.position.set(0, 0);
            sprite.width = data.width;
            sprite.height = data.height;
            baseImageContainer.addChild(sprite);
            baseImageSprite = sprite;
          },
          (err) => {
            if (map !== data) return;
            if (!retried) {
              const fallbackUrl = buildWorkspaceVaultFallbackUrl(url, data.source.imageRelPath);
              if (fallbackUrl) {
                data.source.imageUrl = fallbackUrl;
                if (data.source.originalMap) {
                  try {
                    data.source.originalMap = serializeImageBaseSpecFromMap(data);
                  } catch {
                    /* ignore */
                  }
                }
                mountBaseImage(fallbackUrl, true);
                return;
              }
            }
            console.error('[map-renderer] 图片底图加载失败:', err);
            const detail = data.source.imageRelPath || url.slice(0, 80);
            showBaseImageErrorBanner(data.source.name, detail);
          }
        );
      };
      mountBaseImage(data.source.imageUrl, false);
    } else {
      clearBaseImageCache();
    }
  } else {
    clearBaseImageCache();
    cellRoot.alpha = 1;
  }

  buildChunks();
  buildFlatPolygons();
  buildCenterBuckets();
  buildTopology();
  buildPalettes();
  recomputeColors();
  repaintAllCells();
  bordersDirty = true;
  labelsDirty = true;
  terrainDirty = true;
  drawGraticule();
  flush();
  syncCanvasCursor();
}

function buildChunks(): void {
  if (!map) return;
  for (const container of chunkContainers) container.destroy({ children: true, context: true });
  chunkContainers = [];
  chunkGraphics = [];
  chunkCells = [];
  dirtyChunks.clear();

  chunkCols = Math.max(1, Math.ceil(mapWidth / CHUNK_SIZE));
  chunkRows = Math.max(1, Math.ceil(mapHeight / CHUNK_SIZE));
  const total = chunkCols * chunkRows;

  for (let i = 0; i < total; i++) {
    chunkCells.push([]);
    const container = new Container();
    container.cullable = true;
    const graphics = new Graphics();
    container.addChild(graphics);
    cellRoot.addChild(container);
    chunkContainers.push(container);
    chunkGraphics.push(graphics);
  }

  cellChunk = new Int32Array(map.cells.count);
  for (let cellId = 0; cellId < map.cells.count; cellId++) {
    const [x, y] = map.cells.p[cellId];
    const cx = clamp(Math.floor(x / CHUNK_SIZE), 0, chunkCols - 1);
    const cy = clamp(Math.floor(y / CHUNK_SIZE), 0, chunkRows - 1);
    const index = cy * chunkCols + cx;
    cellChunk[cellId] = index;
    chunkCells[index].push(cellId);
  }

  for (let i = 0; i < total; i++) {
    const cx = i % chunkCols;
    const cy = Math.floor(i / chunkCols);
    let minX = cx * CHUNK_SIZE;
    let minY = cy * CHUNK_SIZE;
    let maxX = minX + CHUNK_SIZE;
    let maxY = minY + CHUNK_SIZE;
    for (const cellId of chunkCells[i]) {
      for (const [px, py] of map.cells.polygons[cellId]) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    chunkContainers[i].cullArea = new Rectangle(minX, minY, maxX - minX, maxY - minY);
  }
}

/** 多边形摊平成 [x0,y0,x1,y1,...]，供 Pixi Graphics 快速消费 */
function buildFlatPolygons(): void {
  if (!map) return;
  const count = map.cells.count;
  flatPolygons = new Array(count);
  for (let cellId = 0; cellId < count; cellId++) {
    const polygon = map.cells.polygons[cellId];
    const flat = new Array<number>(polygon.length * 2);
    for (let k = 0; k < polygon.length; k++) {
      flat[k * 2] = polygon[k][0];
      flat[k * 2 + 1] = polygon[k][1];
    }
    flatPolygons[cellId] = flat;
  }
}

// --- 中心点索引（交互命中与海岸晕染共用同一套分桶规则） -----------------------
interface CenterIndex {
  centers: Float32Array;
  cols: number;
  rows: number;
  width: number;
  height: number;
  buckets: number[][];
  searchRadius: number;
}

/** 根据地图类型与网格密度动态计算最近格命中搜索半径，避免高分/粗网格图片战区出现死区。 */
export function computeCellSearchRadius(data: MapData | null): number {
  if (!data) return 48;
  if (data.source.baseKind === 'image') {
    return Math.max(48, Math.ceil((data.source.hexRadius ?? 24) * 2.2));
  }
  const areaPerCell = (data.width * data.height) / Math.max(1, data.cells.count);
  return Math.max(48, Math.ceil(Math.sqrt(areaPerCell) * 1.6));
}

function buildCenterIndex(data: MapData): CenterIndex {
  const count = data.cells.count;
  const centers = new Float32Array(count * 2);
  const cols = Math.max(1, Math.ceil(data.width / BUCKET_SIZE));
  const rows = Math.max(1, Math.ceil(data.height / BUCKET_SIZE));
  const buckets = Array.from({ length: cols * rows }, () => [] as number[]);

  for (let cellId = 0; cellId < count; cellId++) {
    const [x, y] = data.cells.p[cellId];
    centers[cellId * 2] = x;
    centers[cellId * 2 + 1] = y;
    const bx = clamp(Math.floor(x / BUCKET_SIZE), 0, cols - 1);
    const by = clamp(Math.floor(y / BUCKET_SIZE), 0, rows - 1);
    buckets[by * cols + bx].push(cellId);
  }
  return {
    centers,
    cols,
    rows,
    width: data.width,
    height: data.height,
    buckets,
    searchRadius: computeCellSearchRadius(data),
  };
}

function buildCenterBuckets(): void {
  if (!map) return;
  const index = buildCenterIndex(map);
  cellCenters = index.centers;
  bucketCols = index.cols;
  bucketRows = index.rows;
  centerBuckets = index.buckets;
  centerSearchRadius = index.searchRadius;
}

function lookupNearestCell(x: number, y: number, index: CenterIndex): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > index.width || y < 0 || y > index.height) {
    return -1;
  }
  const radius = Math.max(48, index.searchRadius);
  const cellSpan = Math.max(1, Math.ceil(radius / BUCKET_SIZE));
  const centerBx = clamp(Math.floor(x / BUCKET_SIZE), 0, index.cols - 1);
  const centerBy = clamp(Math.floor(y / BUCKET_SIZE), 0, index.rows - 1);
  const minBx = clamp(centerBx - cellSpan, 0, index.cols - 1);
  const maxBx = clamp(centerBx + cellSpan, 0, index.cols - 1);
  const minBy = clamp(centerBy - cellSpan, 0, index.rows - 1);
  const maxBy = clamp(centerBy + cellSpan, 0, index.rows - 1);

  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let by = minBy; by <= maxBy; by++) {
    for (let bx = minBx; bx <= maxBx; bx++) {
      for (const cellId of index.buckets[by * index.cols + bx]) {
        const dx = index.centers[cellId * 2] - x;
        const dy = index.centers[cellId * 2 + 1] - y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cellId;
        }
      }
    }
  }
  return bestDistance <= radius * radius ? best : -1;
}

let locatorCache: { map: MapData; index: CenterIndex } | null = null;

/** 只依赖 MapData 的最近格查询；与交互用 `cellAt` 同一分桶与浮点精度。 */
export function cellLocatorFor(data: MapData): (x: number, y: number) => number {
  const index = locatorCache && locatorCache.map === data ? locatorCache.index : buildCenterIndex(data);
  locatorCache = { map: data, index };
  return (x, y) => lookupNearestCell(x, y, index);
}

/**
 * 一次性建立无向边表：同一条棱只留一条记录，两侧地块都记下。
 * 结果按 MapData 身份缓存在 WeakMap：棱只来自 `cells.polygons`，同一实例内不变；高度重刷不影响边表。
 */
const edgeRecordCache = new WeakMap<MapData, EdgeRecord[]>();

export function buildEdgeRecords(data: MapData): EdgeRecord[] {
  const cached = edgeRecordCache.get(data);
  if (cached) return cached;

  const records: EdgeRecord[] = [];
  const seen = new Map<string, number>();
  const polygons = data.cells.polygons;

  for (let cellId = 0; cellId < data.cells.count; cellId++) {
    const polygon = polygons[cellId];
    const length = polygon.length;
    if (length < 3) continue;
    for (let k = 0; k < length; k++) {
      const a = polygon[k];
      const b = polygon[(k + 1) % length];
      const key = edgeKey(a, b);
      const found = seen.get(key);
      if (found === undefined) {
        seen.set(key, records.length);
        records.push({ i: cellId, j: -1, ax: a[0], ay: a[1], bx: b[0], by: b[1] });
      } else if (records[found].j === -1) {
        records[found].j = cellId;
      }
    }
  }
  edgeRecordCache.set(data, records);
  return records;
}

function buildTopology(): void {
  if (!map) return;
  edges = buildEdgeRecords(map);
}

const edgeKey = (a: [number, number], b: [number, number]): string => {
  const keyA = `${Math.round(a[0] * 100)},${Math.round(a[1] * 100)}`;
  const keyB = `${Math.round(b[0] * 100)},${Math.round(b[1] * 100)}`;
  return keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
};

function buildPalettes(): void {
  if (!map) return;
  const imageMode = isImageBaseMap(map);
  const neutral = imageMode ? '' : NEUTRAL_LAND;

  stateColors = [];
  for (const state of map.states) stateColors[state.i] = state.removed ? neutral : state.color;
  stateColors[0] = neutral;

  provinceColors = [];
  for (const province of map.provinces) provinceColors[province.i] = province.removed ? neutral : province.color;
  provinceColors[0] = neutral;

  religionColors = [];
  const palette = ['#c9c6bb', '#e8c07d', '#9db4d4', '#b7a1c9', '#9dc7a3', '#d6a3a3', '#c7c08a', '#8fbfc7'];
  for (const religion of map.religions) {
    religionColors[religion.i] = religion.removed ? neutral : religion.color;
  }
  religionColors[0] = imageMode ? '' : palette[0];
}

function computeCellFillColor(data: MapData, cellId: number): string {
  const { cells } = data;
  const height = cells.h[cellId];
  if (height < SEA_LEVEL) return '';

  const view = appStore.viewMode;
  if (isImageBaseMap(data)) {
    switch (view) {
      case 'terrain':
      case 'biome':
        // 图片底图模式下地形/群系视图完全透明，原汁原味透出底下高清底图
        return '';
      case 'state': {
        const sid = cells.state[cellId];
        return sid > 0 ? (stateColors[sid] ?? '') : '';
      }
      case 'province': {
        const pid = cells.province[cellId];
        return pid > 0 ? (provinceColors[pid] ?? '') : '';
      }
      case 'religion': {
        const rid = cells.religion[cellId];
        return rid > 0 ? (religionColors[rid] ?? '') : '';
      }
    }
  }

  switch (view) {
    case 'terrain':
    case 'biome':
      return computeTerrainCellColor(data, cellId, view, appStore.showHillshade);
    case 'state':
      return stateColors[cells.state[cellId]] ?? NEUTRAL_LAND;
    case 'province':
      return provinceColors[cells.province[cellId]] ?? NEUTRAL_LAND;
    case 'religion':
      return religionColors[cells.religion[cellId]] ?? NEUTRAL_LAND;
  }
}

function recomputeColors(): void {
  if (!map) return;
  const { cells } = map;
  cellFill = new Array(cells.count);

  for (let cellId = 0; cellId < cells.count; cellId++) {
    cellFill[cellId] = computeCellFillColor(map, cellId);
  }
}

// --- 地块绘制 ---------------------------------------------------------------
function redrawChunk(chunkIndex: number): void {
  const graphics = chunkGraphics[chunkIndex];
  if (!graphics || !map) return;
  graphics.clear();

  const groups = new Map<string, number[][]>();
  for (const cellId of chunkCells[chunkIndex]) {
    const color = cellFill[cellId];
    if (!color) continue; // 水域不落色，露出海面底色
    const flat = flatPolygons[cellId];
    if (!flat || flat.length < 6) continue;
    let bucket = groups.get(color);
    if (!bucket) {
      bucket = [];
      groups.set(color, bucket);
    }
    bucket.push(flat);
  }

  for (const [color, polygons] of groups) {
    for (const flat of polygons) graphics.poly(flat, true);
    graphics.fill({ color });
  }
}

function repaintAllCells(): void {
  for (let i = 0; i < chunkGraphics.length; i++) dirtyChunks.add(i);
}

function currentLabelOptions(): LabelLodOptions {
  return {
    cityScale: appStore.cityLabelScale,
    cityZoomBoost: appStore.cityLabelZoomBoost,
    cityDynamicLod: appStore.cityLabelDynamicLod,
  };
}

function onTick(): void {
  if (!pixiApp) return;
  if (!map) return;
  if (dirtyChunks.size || terrainDirty) flush();
  else if (bordersDirty && !isPainting) {
    bordersDirty = false;
    drawBorders();
  } else if (labelsDirty) {
    labelsDirty = false;
    rebuildLabels();
  }
  updateLabelLod(burgMarkers, appStore.viewMode, terrainContainer.worldTransform.a, false, currentLabelOptions());
}

function flush(): void {
  if (terrainDirty) {
    terrainDirty = false;
    if (isImageBaseMap(map)) {
      // 图片底图模式：不绘制虚假海洋/等高线；保留纯暗色托底与非空河流
      oceanGfx.clear();
      oceanGfx.rect(0, 0, mapWidth, mapHeight).fill({ color: '#0f172a' });
      contourGfx.clear();
      riverGfx.clear();
      if (map!.rivers.length > 0) renderRivers(riverGfx, map!);
    } else {
      drawWaterAndContours(oceanGfx, contourGfx, map!, edges, {
        viewMode: appStore.viewMode,
        hillshade: appStore.showHillshade,
        contours: appStore.showContours,
      });
      renderRivers(riverGfx, map!);
    }
  }
  if (dirtyChunks.size) {
    for (const chunkIndex of dirtyChunks) redrawChunk(chunkIndex);
    dirtyChunks.clear();
  }
  if (bordersDirty && !isPainting) {
    bordersDirty = false;
    drawBorders();
  }
  if (labelsDirty) {
    labelsDirty = false;
    rebuildLabels();
  }
  drawOverlay();
}

// --- 边界 ------------------------------------------------------------------
function drawBorders(): void {
  borderGfx.clear();
  coastGfx.clear();
  if (!map || !edges.length) return;

  const view = appStore.viewMode;
  const { cells } = map;

  const majorSegments: number[] = [];
  const minorSegments: number[] = [];

  const isWater = (cellId: number) => cellId < 0 || cells.h[cellId] < SEA_LEVEL;

  for (const edge of edges) {
    const { i, j, ax, ay, bx, by } = edge;
    const waterI = isWater(i);
    const waterJ = j < 0 ? true : isWater(j);

    if (waterI !== waterJ) continue;
    if (waterI || j < 0) continue;

    if (view === 'state') {
      if (cells.state[i] !== cells.state[j]) majorSegments.push(ax, ay, bx, by);
    } else if (view === 'province') {
      if (cells.state[i] !== cells.state[j]) majorSegments.push(ax, ay, bx, by);
      else if (cells.province[i] !== cells.province[j]) minorSegments.push(ax, ay, bx, by);
    } else if (view === 'religion') {
      if (cells.religion[i] !== cells.religion[j]) minorSegments.push(ax, ay, bx, by);
    }
  }

  const imageMode = isImageBaseMap(map);
  if (!imageMode) {
    drawCoastline(map, edges);
  }

  // 国界/省界保持 Voronoi/六角直棱，独立于 cellRoot 不透明描边，确保图片底图上半透明涂色边界清晰
  if (minorSegments.length) {
    strokeSegments(borderGfx, minorSegments, '#1f2937', imageMode ? 0.9 : 0.7, imageMode ? 0.6 : 0.45);
  }
  if (majorSegments.length) {
    strokeSegments(borderGfx, majorSegments, '#111827', imageMode ? 1.6 : 1.3, imageMode ? 0.85 : 0.7);
  }
}

// --- 海岸线：链化 + Chaikin 平滑 + 浅海晕染 -----------------------------------
type Pt = [number, number];
interface CoastChain {
  points: Pt[];
  closed: boolean;
}

// 由内到外三层水晕：近岸浓、外缘淡，叠加成连续渐变（羊皮纸观感）
export const COAST_BANDS: Array<{ offset: number; color: string; alpha: number }> = [
  { offset: 30, color: '#4a90c4', alpha: 0.12 },
  { offset: 16, color: '#5da5d6', alpha: 0.15 },
  { offset: 7, color: '#7cc4e8', alpha: 0.17 },
];

export const COAST_LINE_STYLE: FieldStrokeStyle = { color: COAST_LINE, width: 1.25, alpha: 0.9 };

export interface CoastGeometry {
  bands: { polygon: number[]; color: string; alpha: number }[];
  lines: { points: FieldRing; closed: boolean }[];
}

const coastVKey = (x: number, y: number): string =>
  `${Math.round(x * 100)},${Math.round(y * 100)}`;

/** 把离散海岸棱按共享顶点顺序连成折线链（闭合环或开放链），顶点度数 >2 时任取一支继续 */
function chainCoastEdges(coastEdges: EdgeRecord[]): CoastChain[] {
  const openAt = new Map<string, number[]>();
  const used = new Array<boolean>(coastEdges.length).fill(false);
  const enqueue = (key: string, idx: number) => {
    const list = openAt.get(key);
    if (list) list.push(idx);
    else openAt.set(key, [idx]);
  };
  coastEdges.forEach((edge, idx) => {
    enqueue(coastVKey(edge.ax, edge.ay), idx);
    enqueue(coastVKey(edge.bx, edge.by), idx);
  });

  const takeEdgeAt = (key: string): EdgeRecord | null => {
    const list = openAt.get(key);
    while (list && list.length) {
      const idx = list.pop()!;
      if (!used[idx]) {
        used[idx] = true;
        return coastEdges[idx];
      }
    }
    return null;
  };

  const chains: CoastChain[] = [];
  for (let seed = 0; seed < coastEdges.length; seed++) {
    if (used[seed]) continue;
    used[seed] = true;
    const e = coastEdges[seed];
    const pts: Pt[] = [[e.ax, e.ay], [e.bx, e.by]];
    const startKey = coastVKey(e.ax, e.ay);

    // 向尾部生长，长回起点即闭合环
    let tailKey = coastVKey(e.bx, e.by);
    let closed = false;
    while (true) {
      if (tailKey === startKey) {
        closed = true;
        pts.pop();
        break;
      }
      const next = takeEdgeAt(tailKey);
      if (!next) break;
      if (coastVKey(next.bx, next.by) === tailKey) {
        pts.push([next.ax, next.ay]);
        tailKey = coastVKey(next.ax, next.ay);
      } else {
        pts.push([next.bx, next.by]);
        tailKey = coastVKey(next.bx, next.by);
      }
    }

    if (!closed) {
      // 开放链再向头部生长
      let headKey = startKey;
      while (true) {
        const prev = takeEdgeAt(headKey);
        if (!prev) break;
        if (coastVKey(prev.ax, prev.ay) === headKey) {
          pts.unshift([prev.bx, prev.by]);
          headKey = coastVKey(prev.bx, prev.by);
        } else {
          pts.unshift([prev.ax, prev.ay]);
          headKey = coastVKey(prev.ax, prev.ay);
        }
      }
    }
    chains.push({ points: pts, closed });
  }
  return chains;
}

/** Chaikin 切角平滑；开放链保留首尾端点，闭合链整体切角成环 */
function chaikinSmoothChain(points: Pt[], iterations: number, closed: boolean): Pt[] {
  let pts = points.slice();
  if (pts.length > 3000) {
    // 超长海岸环先等距抽稀，控制两轮切角后的顶点规模
    const step = Math.ceil(pts.length / 3000);
    pts = pts.filter((_, i) => i % step === 0);
    if (closed) pts.push(pts[0]);
  }
  for (let it = 0; it < iterations; it++) {
    if (closed) {
      if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) {
        // 已含重复首点
      } else {
        pts.push(pts[0]);
      }
    }
    if (pts.length < 3) return points.slice();
    const n = pts.length;
    const out: Pt[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) {
      out.unshift(pts[0]);
      out.push(pts[n - 1]);
    }
    pts = out;
  }
  return pts;
}

function offsetChain(points: Pt[], dist: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    out.push([points[i][0] - ty * dist, points[i][1] + tx * dist]);
  }
  return out;
}

/**
 * 平滑海岸链 -> 海域一侧的带状晕染多边形。
 * 偏移方向不依赖链绕向：两侧候选各采样数点，用最近格的水陆属性投票取水侧。
 */
function buildCoastBandPoly(
  smooth: Pt[],
  dist: number,
  isWater: (id: number) => boolean,
  locate: (x: number, y: number) => number
): number[] {
  if (smooth.length < 2) return [];
  const sideA = offsetChain(smooth, dist);
  const sideB = offsetChain(smooth, -dist);

  let votesA = 0;
  let votesB = 0;
  const samples = Math.min(9, smooth.length);
  for (let s = 0; s < samples; s++) {
    const idx = Math.floor(((s + 0.5) / samples) * smooth.length);
    const cellA = locate(sideA[idx][0], sideA[idx][1]);
    if (cellA >= 0 && isWater(cellA)) votesA++;
    const cellB = locate(sideB[idx][0], sideB[idx][1]);
    if (cellB >= 0 && isWater(cellB)) votesB++;
  }
  const outer = votesA >= votesB ? sideA : sideB;

  const poly: number[] = [];
  for (const p of outer) poly.push(p[0], p[1]);
  for (let i = smooth.length - 1; i >= 0; i--) poly.push(smooth[i][0], smooth[i][1]);
  return poly;
}

/**
 * 由一段平滑海岸折线生成某一层晕染多边形；水侧投票与主地图一致。
 * 供战场快照对已裁剪到展示范围的中心线片段复用。
 */
export function buildCoastBandPolygon(data: MapData, points: FieldRing, offset: number): number[] {
  const { cells } = data;
  const isWater = (cellId: number) => cellId < 0 || cells.h[cellId] < SEA_LEVEL;
  return buildCoastBandPoly(points, offset, isWater, cellLocatorFor(data));
}

/**
 * 海岸晕染带与海岸线本体（主地图绘制与战场快照同源）。
 * 只依赖 MapData 与边表；陆地/水域判定用 `cells.h < SEA_LEVEL`，与 `drawBorders` 一致。
 */
export function collectCoastGeometry(data: MapData, edgeRecords: EdgeRecord[]): CoastGeometry {
  const { cells } = data;
  const isWater = (cellId: number) => cellId < 0 || cells.h[cellId] < SEA_LEVEL;

  const coastEdges: EdgeRecord[] = [];
  for (const edge of edgeRecords) {
    const waterI = isWater(edge.i);
    const waterJ = edge.j < 0 ? true : isWater(edge.j);
    if (waterI !== waterJ) coastEdges.push(edge);
  }

  const locate = cellLocatorFor(data);
  const lines: { points: FieldRing; closed: boolean }[] = [];
  const smoothChains: Pt[][] = [];
  for (const chain of chainCoastEdges(coastEdges)) {
    if (chain.points.length < 2) continue;
    const smooth = chaikinSmoothChain(chain.points, 2, chain.closed);
    smoothChains.push(smooth);
    lines.push({ points: smooth, closed: chain.closed });
  }

  const bands: CoastGeometry['bands'] = [];
  for (const band of COAST_BANDS) {
    for (const smooth of smoothChains) {
      const polygon = buildCoastBandPoly(smooth, band.offset, isWater, locate);
      if (polygon.length >= 6) bands.push({ polygon, color: band.color, alpha: band.alpha });
    }
  }
  return { bands, lines };
}

function drawCoastline(data: MapData, edgeRecords: EdgeRecord[]): void {
  const { bands, lines } = collectCoastGeometry(data, edgeRecords);

  // 浅海大陆架晕染：同一层里所有链的带状路径合并成一次 nonzero 填充
  let pending: { color: string; alpha: number } | null = null;
  for (const band of bands) {
    if (pending && (pending.color !== band.color || pending.alpha !== band.alpha)) {
      coastGfx.fill({ color: pending.color, alpha: pending.alpha });
      pending = null;
    }
    coastGfx.poly(band.polygon);
    pending = { color: band.color, alpha: band.alpha };
  }
  if (pending) coastGfx.fill({ color: pending.color, alpha: pending.alpha });

  // 海岸线本体：平滑链一次性描边
  let stroked = false;
  for (const line of lines) {
    if (line.points.length < 2) continue;
    borderGfx.moveTo(line.points[0][0], line.points[0][1]);
    for (let i = 1; i < line.points.length; i++) borderGfx.lineTo(line.points[i][0], line.points[i][1]);
    if (line.closed) borderGfx.closePath();
    stroked = true;
  }
  if (stroked) {
    borderGfx.stroke({ ...COAST_LINE_STYLE, cap: 'round', join: 'round' });
  }
}

function strokeSegments(graphics: Graphics, segments: number[], color: string, width: number, alpha: number): void {
  for (let i = 0; i < segments.length; i += 4) {
    graphics.moveTo(segments[i], segments[i + 1]).lineTo(segments[i + 2], segments[i + 3]);
  }
  graphics.stroke({ width, color, alpha });
}

// --- 经纬网 / 六角辅助网 ----------------------------------------------------
function drawGraticule(): void {
  gridGfx.clear();
  if (!map) return;
  if (!appStore.showCiv4Grid) return;

  if (isImageBaseMap(map) && !map.source.coords) {
    if (edges.length && map.cells.count <= 18000) {
      const hexSegments: number[] = [];
      for (const edge of edges) {
        hexSegments.push(edge.ax, edge.ay, edge.bx, edge.by);
      }
      if (hexSegments.length) {
        strokeSegments(gridGfx, hexSegments, '#e2e8f0', 0.6, 0.16);
      }
    }
    gridGfx.rect(0, 0, mapWidth, mapHeight).stroke({ width: 1, color: '#93c5fd', alpha: 0.25 });
    return;
  }

  const coords = map.source.coords;
  const lonW = coords?.lonW ?? -14.6;
  const lonE = coords?.lonE ?? 14.6;
  const latN = coords?.latN ?? -7.2;
  const latS = coords?.latS ?? -25.2;

  const lonToX = (lon: number) => ((lon - lonW) / (lonE - lonW)) * mapWidth;
  const latToY = (lat: number) => ((lat - latN) / (latS - latN)) * mapHeight;

  const lines: number[] = [];
  for (let lon = Math.ceil(lonW / 5) * 5; lon <= lonE; lon += 5) {
    const x = lonToX(lon);
    lines.push(x, 0, x, mapHeight);
  }
  for (let lat = Math.ceil(latS / 5) * 5; lat <= latN; lat += 5) {
    const y = latToY(lat);
    lines.push(0, y, mapWidth, y);
  }
  if (!lines.length) return;

  strokeSegments(gridGfx, lines, '#bfdbfe', 1, 0.16);
  gridGfx.rect(0, 0, mapWidth, mapHeight).stroke({ width: 1, color: '#93c5fd', alpha: 0.25 });
}

// --- 地名标签 ----------------------------------------------------------------
function rebuildLabels(): void {
  rebuildMapLabels(labelLayer, burgMarkers, map!);
  updateLabelLod(burgMarkers, appStore.viewMode, terrainContainer.worldTransform.a, true, currentLabelOptions());
}

// --- 光标与高亮 -------------------------------------------------------------
function drawOverlay(): void {
  overlayGfx.clear();
  if (!map) return;

  const mode = appStore.interactionMode;
  if (mode === 'retouch-erase') {
    if (!pointerInside) return;
    const radius = Math.max(2, appStore.retouchRadius);
    overlayGfx.circle(cursorX, cursorY, radius).fill({ color: appStore.retouchColor, alpha: 0.45 });
    overlayGfx.circle(cursorX, cursorY, radius).stroke({ width: 1.5, color: '#f8fafc', alpha: 0.9 });
    overlayGfx.circle(cursorX, cursorY, Math.max(1.5, radius - 1.5)).stroke({ width: 1, color: '#0f172a', alpha: 0.65 });
    return;
  }

  if (mode === 'retouch-pick') {
    if (!pointerInside) return;
    overlayGfx.circle(cursorX, cursorY, 8).fill({ color: appStore.retouchColor, alpha: 0.55 });
    overlayGfx.circle(cursorX, cursorY, 8).stroke({ width: 1.5, color: '#f8fafc', alpha: 0.95 });
    overlayGfx.circle(cursorX, cursorY, 2).fill({ color: '#0f172a', alpha: 0.9 });
    return;
  }

  if (hoverCell >= 0 && hoverCell < map.cells.count) {
    const flat = flatPolygons[hoverCell];
    if (flat && flat.length >= 6) {
      overlayGfx.poly(flat, true).stroke({ width: 1.2, color: '#f8fafc', alpha: 0.55 });
    }
  }

  if (!pointerInside || !isBrushMode()) return;

  const radius = appStore.brushRadius;
  overlayGfx.circle(cursorX, cursorY, radius).fill({ color: '#f8fafc', alpha: 0.06 });
  overlayGfx.circle(cursorX, cursorY, radius).stroke({ width: 1.5, color: '#f8fafc', alpha: 0.85 });
  overlayGfx.circle(cursorX, cursorY, 2).fill({ color: '#f8fafc', alpha: 0.9 });
}

// --- 命中与落笔 -------------------------------------------------------------
export function cellAt(x: number, y: number): number {
  if (!map) return -1;
  return lookupNearestCell(x, y, {
    centers: cellCenters,
    cols: bucketCols,
    rows: bucketRows,
    width: mapWidth,
    height: mapHeight,
    buckets: centerBuckets,
    searchRadius: centerSearchRadius,
  });
}

/** 同步被政权/省份笔刷改写的地块上未移除城池的归属与首都/省府合法性，确保工程序列化校验 100% 通过。 */
export function syncBurgsForPaintedCells(
  data: MapData,
  cellIds: Iterable<number>,
  field: 'state' | 'province'
): boolean {
  const touched = cellIds instanceof Set ? cellIds : new Set(cellIds);
  if (touched.size === 0 || data.burgs.length === 0) return false;

  const validStates = new Set(data.states.filter((s) => !s.removed).map((s) => s.i));
  const validProvinces = new Map(data.provinces.filter((p) => !p.removed).map((p) => [p.i, p]));
  let changed = false;

  for (const burg of data.burgs) {
    if (burg.removed || !touched.has(burg.cell)) continue;
    const rawState = data.cells.state[burg.cell];
    const nextState = validStates.has(rawState) ? rawState : 0;
    const rawProvince = data.cells.province[burg.cell];
    const cellProv = rawProvince > 0 ? validProvinces.get(rawProvince) : undefined;

    if (field === 'state') {
      const prevState = burg.state;
      const nextProv =
        cellProv && cellProv.state === nextState
          ? cellProv.i
          : burg.province > 0 && validProvinces.get(burg.province)?.state === nextState
            ? burg.province
            : 0;
      if (burg.state !== nextState || burg.province !== nextProv) {
        burg.state = nextState;
        burg.province = nextProv;
        if (nextState !== prevState) {
          for (const st of data.states) {
            if (st.capital === burg.i && st.i !== nextState) st.capital = 0;
          }
          for (const pv of data.provinces) {
            if (pv.burg === burg.i && pv.i !== nextProv) pv.burg = 0;
          }
        }
        changed = true;
      }
    } else {
      const nextProv = cellProv ? cellProv.i : 0;
      const resolvedState = cellProv && validStates.has(cellProv.state) ? cellProv.state : nextState;
      if (burg.province !== nextProv || burg.state !== resolvedState) {
        const prevState = burg.state;
        burg.province = nextProv;
        burg.state = resolvedState;
        if (resolvedState !== prevState) {
          for (const st of data.states) {
            if (st.capital === burg.i && st.i !== resolvedState) st.capital = 0;
          }
        }
        for (const pv of data.provinces) {
          if (pv.burg === burg.i && pv.i !== nextProv) pv.burg = 0;
        }
        changed = true;
      }
    }
  }

  if (changed) {
    recomputeBurgTiers(data);
  }
  return changed;
}

const brushField = (): BrushField | null => {
  switch (appStore.interactionMode) {
    case 'brush-height':
      return 'h';
    case 'brush-state':
      return 'state';
    case 'brush-province':
      return 'province';
    case 'brush-religion':
      return 'religion';
    default:
      return null;
  }
};

function paintAtScreen(event: PointerEvent): void {
  const [x, y] = toMap(event);
  cursorX = x;
  cursorY = y;
  pointerInside = true;
  hoverCell = cellAt(x, y);
  paintAt(x, y);
  drawOverlay();
}

/** 在地图坐标 (x, y) 落一笔；半径、目标值都取自 `appStore` */
export function paintAt(x: number, y: number): void {
  if (!map) return;
  const field = brushField();
  if (!field) return;

  const radius = appStore.brushRadius;
  const radiusSq = radius * radius;
  const targetValue =
    field === 'h'
      ? appStore.heightDelta
      : field === 'state'
        ? appStore.activeStateId
        : field === 'province'
          ? appStore.activeProvinceId
          : appStore.activeReligionId;
  if (field === 'state' && targetValue !== 0 && !map.states.some((s) => s.i === targetValue && !s.removed)) return;
  if (field === 'province' && targetValue !== 0 && !map.provinces.some((p) => p.i === targetValue && !p.removed)) return;

  const minBx = clamp(Math.floor((x - radius) / BUCKET_SIZE), 0, bucketCols - 1);
  const maxBx = clamp(Math.floor((x + radius) / BUCKET_SIZE), 0, bucketCols - 1);
  const minBy = clamp(Math.floor((y - radius) / BUCKET_SIZE), 0, bucketRows - 1);
  const maxBy = clamp(Math.floor((y + radius) / BUCKET_SIZE), 0, bucketRows - 1);

  const array = cellArray(field);
  const touchedCells: number[] = [];
  let touched = 0;
  for (let by = minBy; by <= maxBy; by++) {
    for (let bx = minBx; bx <= maxBx; bx++) {
      for (const cellId of centerBuckets[by * bucketCols + bx]) {
        const dx = cellCenters[cellId * 2] - x;
        const dy = cellCenters[cellId * 2 + 1] - y;
        if (dx * dx + dy * dy > radiusSq) continue;
        if (strokeTouched.has(cellId)) continue; // 同一笔里每格只改一次，撤销才干净

        const before = array[cellId];
        let after: number;

        if (field === 'h') {
          after = clamp(before + targetValue, 0, 100);
        } else {
          if (map.cells.h[cellId] < SEA_LEVEL) continue; // 水域不刷势力/信仰
          after = targetValue;
        }
        if (after === before) continue;

        array[cellId] = after;
        strokeRecords.push({ cell: cellId, field, before, after });
        strokeTouched.add(cellId);
        touchedCells.push(cellId);
        dirtyChunks.add(cellChunk[cellId]);
        touched++;
      }
    }
  }

  if (touched) {
    if (field === 'h') strokeTouchedHeights = true;
    if ((field === 'state' || field === 'province') && syncBurgsForPaintedCells(map, touchedCells, field)) {
      labelsDirty = true;
    }
    recolorCells(touchedCells, field === 'h');
    bordersDirty = true;
  }
}

function cellArray(field: BrushField): Uint8Array | Uint16Array {
  const { cells } = map!;
  return field === 'h' ? cells.h : field === 'state' ? cells.state : field === 'province' ? cells.province : cells.religion;
}

// --- 撤销/重做 ---------------------------------------------------------------
/** 按记录涉及的实体重算极点并标记标签重建；落笔、撤销、重做共用 */
function applyPoleRecompute(records: PaintRecord[]): void {
  const stateIds = new Set(records.filter((record) => record.field === 'state')
    .flatMap((record) => [record.before, record.after]));
  const provinceIds = new Set(records.filter((record) => record.field === 'province')
    .flatMap((record) => [record.before, record.after]));
  if (stateIds.size === 0 && provinceIds.size === 0) return;
  recomputeRegionPoles({
    ...map!,
    states: map!.states.filter((state) => stateIds.has(state.i)),
    provinces: map!.provinces.filter((province) => provinceIds.has(province.i)),
  });
  labelsDirty = true;
}

function scrubHistoryStack(stack: PaintRecord[][], field: 'state' | 'province', entityId: number): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    const scrubbed: PaintRecord[] = [];
    for (const record of stack[i]) {
      if (record.field !== field) {
        scrubbed.push(record);
        continue;
      }
      const before = record.before === entityId ? 0 : record.before;
      const after = record.after === entityId ? 0 : record.after;
      if (before !== after) scrubbed.push({ ...record, before, after });
    }
    if (scrubbed.length === 0) stack.splice(i, 1);
    else stack[i] = scrubbed;
  }
}

export function purgeEntityPaintHistory(field: 'state' | 'province', entityId: number): void {
  scrubHistoryStack(undoStack, field, entityId);
  scrubHistoryStack(redoStack, field, entityId);
}

function validRestoredId(field: BrushField, value: number): number {
  if (value === 0 || !map) return value;
  if (field === 'state') return map.states.some((s) => s.i === value && !s.removed) ? value : 0;
  if (field === 'province') return map.provinces.some((p) => p.i === value && !p.removed) ? value : 0;
  return value;
}

function repaintRecords(records: PaintRecord[]): void {
  if (!map) return;
  const cells: number[] = [];
  // 逆序还原：同一格若在一笔里被记了多条，先写的 before 才是真正的前值
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    const array = cellArray(record.field);
    array[record.cell] = validRestoredId(record.field, record.before);
    dirtyChunks.add(cellChunk[record.cell]);
    cells.push(record.cell);
  }
  const heightsChanged = records.some((record) => record.field === 'h');
  const stateCells = records.filter((record) => record.field === 'state').map((record) => record.cell);
  const provCells = records.filter((record) => record.field === 'province').map((record) => record.cell);
  if (stateCells.length && syncBurgsForPaintedCells(map, stateCells, 'state')) labelsDirty = true;
  if (provCells.length && syncBurgsForPaintedCells(map, provCells, 'province')) labelsDirty = true;
  recolorCells(cells, heightsChanged);
  if (heightsChanged) terrainDirty = true;
  applyPoleRecompute(records);
  bordersDirty = true;
}

/** 单格颜色按当前视图重算（落笔与撤销都走这里） */
function recolorCells(cellIds: number[], heightsChanged: boolean): void {
  if (!map) return;
  const { cells } = map;
  const affected = new Set(cellIds);
  if (heightsChanged) {
    // 高度变化会改变相邻地块的坡度光影，连同其 Graphics 分块一起重刷。
    // 水体/等高线/河流的全量重建不由这里触发（拖笔期间每帧调用），由收笔统一置 terrainDirty。
    for (const cellId of cellIds) for (const neighbor of cells.c[cellId]) affected.add(neighbor);
  }
  for (const cellId of affected) {
    dirtyChunks.add(cellChunk[cellId]);
    cellFill[cellId] = computeCellFillColor(map, cellId);
  }
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

export function undoPaint(): boolean {
  const batch = undoStack.pop();
  if (!batch) return false;
  repaintRecords(batch);
  redoStack.push(batch);
  appStore.emit('brush:painted', { cells: new Set(batch.map(record => record.cell)).size });
  return true;
}

export function redoPaint(): boolean {
  const batch = redoStack.pop();
  if (!batch || !map) return false;
  const cells: number[] = [];
  for (const record of batch) {
    const array = cellArray(record.field);
    array[record.cell] = validRestoredId(record.field, record.after);
    dirtyChunks.add(cellChunk[record.cell]);
    cells.push(record.cell);
  }
  const heightsChanged = batch.some((record) => record.field === 'h');
  const stateCells = batch.filter((record) => record.field === 'state').map((record) => record.cell);
  const provCells = batch.filter((record) => record.field === 'province').map((record) => record.cell);
  if (stateCells.length && syncBurgsForPaintedCells(map, stateCells, 'state')) labelsDirty = true;
  if (provCells.length && syncBurgsForPaintedCells(map, provCells, 'province')) labelsDirty = true;
  recolorCells(cells, heightsChanged);
  if (heightsChanged) terrainDirty = true;
  applyPoleRecompute(batch);
  bordersDirty = true;
  undoStack.push(batch);
  appStore.emit('brush:painted', { cells: new Set(batch.map(record => record.cell)).size });
  return true;
}

/** 外部（时间轴等）改了地块属性后，主动请求整图重刷 */
export function repaintMap(): void {
  if (!map) return;
  recomputeColors();
  repaintAllCells();
  terrainDirty = true;
  bordersDirty = true;
  labelsDirty = true;
}

