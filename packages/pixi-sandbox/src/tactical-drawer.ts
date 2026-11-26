import { polylineLength } from './battle-geometry';
import { Container, Graphics, Text } from 'pixi.js';
import { getStrokePoints } from 'perfect-freehand';
import {
  appStore,
  tacticalContainer,
  type TacticalItem,
} from './store';
import { isFieldBattleOwner } from './input-owner';

type Pt = [number, number];

interface DrawOptions {
  highlight?: boolean;
}

const PREVIEW_ALPHA = 0.92;
const MIN_POINT_DISTANCE = 2.4;
const MAX_RAW_POINTS = 1400;
const MAX_HISTORY = 60;
// 箭头整体尺寸系数：按用户要求比 v0.4.0 至少放大 5%
const ARROW_SCALE = 1.05;

/** 箭头是屏幕恒定尺寸：width=1≈城市（进攻城市），width=20≈国家（进攻国家） */
const invScale = (): number =>
  1 / Math.max(1e-6, tacticalContainer.worldTransform.a);

let itemsLayer: Container | null = null;
let previewLayer: Container | null = null;
let previewGfx: Graphics | null = null;
let measureLayer: Container | null = null;

let initialized = false;
let drawing = false;
let activePointerId: number | null = null;
let draft: TacticalItem | null = null;
let draftPoints: Pt[] = [];
let previewQueued = false;
let spaceHeld = false;

let measuring = false;
let measurePointerId: number | null = null;
let measurePoints: Pt[] = [];
let lastMeasureSummary = '';
const measureListeners = new Set<(summary: string) => void>();

export function computeKmPerPixel(
  mapWidthKm: number | undefined,
  mapWidthPx: number
): number | undefined {
  if (
    typeof mapWidthKm !== 'number' ||
    !Number.isFinite(mapWidthKm) ||
    mapWidthKm <= 0 ||
    !Number.isFinite(mapWidthPx) ||
    mapWidthPx <= 0
  ) {
    return undefined;
  }
  return mapWidthKm / mapWidthPx;
}

export function formatMeasureDistance(
  pixelLength: number,
  kmPerPixel?: number
): string {
  const safePx = Number.isFinite(pixelLength) && pixelLength > 0 ? pixelLength : 0;
  if (typeof kmPerPixel === 'number' && Number.isFinite(kmPerPixel) && kmPerPixel > 0) {
    return `${(safePx * kmPerPixel).toFixed(1)} km`;
  }
  return `${Math.round(safePx)} px`;
}

export function measurePolyline(
  points: readonly Pt[],
  kmPerPixel?: number
): { pixels: number; km: number | null; text: string } {
  const pixels = points.length >= 2 ? polylineLength(points as Pt[]) : 0;
  const hasScale =
    typeof kmPerPixel === 'number' && Number.isFinite(kmPerPixel) && kmPerPixel > 0;
  const km = hasScale ? pixels * kmPerPixel : null;
  return {
    pixels,
    km,
    text: formatMeasureDistance(pixels, kmPerPixel),
  };
}

export function getLastMeasureSummary(): string {
  return lastMeasureSummary;
}

export function subscribeMeasureUpdate(fn: (summary: string) => void): () => void {
  measureListeners.add(fn);
  return () => {
    measureListeners.delete(fn);
  };
}

function notifyMeasureUpdate(summary: string): void {
  lastMeasureSummary = summary;
  for (const fn of measureListeners) fn(summary);
}

export function clearMeasurement(): void {
  measuring = false;
  measurePointerId = null;
  measurePoints = [];
  if (measureLayer) clearContainer(measureLayer);
  if (lastMeasureSummary !== '') notifyMeasureUpdate('');
}

interface DragState {
  pointerId: number;
  id: string;
  start: Pt;
  original: Pt[];
  moved: boolean;
  snapshot: string;
}
let dragState: DragState | null = null;

const history: string[] = [];
let idCounter = 0;

function recordSnapshot(snapshot: string) {
  if (history[history.length - 1] === snapshot) return;
  history.push(snapshot);
  if (history.length > MAX_HISTORY) history.shift();
  appStore.emit('tactical-history-change');
}

/**
 * 初始化战术标绘交互层。只接管画布上的左键：
 * - tactical-frontline / tactical-arrow：自由手绘并生成战术图形；
 * - tactical-select：点选、拖动、删除已有图形。
 * 中键 / 右键 / 空格仍由 main.ts 的漫游逻辑处理。
 */
export function initTacticalDrawer(canvasEl: HTMLElement): {
  renderTactical: () => void;
} {
  if (!initialized) {
    initialized = true;

    itemsLayer = new Container();
    previewLayer = new Container();
    previewLayer.eventMode = 'none';
    previewGfx = new Graphics();
    previewLayer.addChild(previewGfx);
    measureLayer = new Container();
    measureLayer.eventMode = 'none';

    tacticalContainer.addChild(itemsLayer);
    tacticalContainer.addChild(previewLayer);
    tacticalContainer.addChild(measureLayer);

    // 画布事件
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('pointercancel', () => cancelDraft());
    canvasEl.addEventListener('contextmenu', () => cancelDraft());

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', () => {
      spaceHeld = false;
      cancelDraft();
    });

    // store 事件：其他模块改数据后立即重绘
    appStore.on('tactical-change', () => {
      renderTactical();
    });
    appStore.on('tactical-selection-change', () => {
      renderTactical();
    });
    appStore.on('theater:leaving', () => {
      cancelDraft();
      clearMeasurement();
    });
    appStore.on('map:loaded', () => {
      clearMeasurement();
      history.length = 0;
      appStore.emit('tactical-history-change');
      appStore.emit('tactical-selection-change', null);
    });
    appStore.on('map:cleared', () => {
      cancelDraft();
      clearMeasurement();
      history.length = 0;
      appStore.emit('tactical-history-change');
      appStore.emit('tactical-selection-change', null);
      renderTactical();
    });
    appStore.on('tactical-mode-change', () => {
      if (drawing || dragState) cancelDraft();
      if (appStore.interactionMode !== 'tactical-measure') clearMeasurement();
      updateCursor(canvasEl);
    });
    appStore.on('brush:changed', () => {
      if (drawing || dragState) cancelDraft();
      if (appStore.interactionMode !== 'tactical-measure') clearMeasurement();
      updateCursor(canvasEl);
    });
    appStore.on('scale:changed', () => {
      renderMeasurement();
      renderTactical();
    });
    // 标绘几何与标注都是屏幕恒定语义，按绘制时倍率构建；缩放后按新倍率整体重建
    let zoomRedrawQueued = false;
    appStore.on('viewport:zoom', () => {
      if (zoomRedrawQueued) return;
      zoomRedrawQueued = true;
      requestAnimationFrame(() => {
        zoomRedrawQueued = false;
        renderTactical();
        renderMeasurement();
      });
    });

  }

  updateCursor(canvasEl);
  renderTactical();
  return { renderTactical };

  // ---------------------------------------------------------------------------
  // 指针交互
  // ---------------------------------------------------------------------------

  /** 与 map-renderer / burg-editor 一致：先扣除画布在页面里的偏移再换算 */
  function toMapPoint(e: PointerEvent): Pt {
    const rect = canvasEl.getBoundingClientRect();
    return appStore.toMapCoords(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0 || spaceHeld) return;
    const mode = appStore.interactionMode;
    if (mode === 'tactical-frontline' || mode === 'tactical-arrow') {
      beginDraw(e, canvasEl);
    } else if (mode === 'tactical-measure') {
      beginMeasure(e, canvasEl);
    } else if (mode === 'tactical-select') {
      beginSelect(e, canvasEl);
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (measuring && e.pointerId === measurePointerId) {
      const p = toMapPoint(e);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      if (e.shiftKey && measurePoints.length >= 1) {
        measurePoints = [measurePoints[0], [p[0], p[1]]];
        renderMeasurement();
      } else {
        const last = measurePoints[measurePoints.length - 1];
        if (
          measurePoints.length < MAX_RAW_POINTS &&
          (!last ||
            Math.hypot(p[0] - last[0], p[1] - last[1]) >=
              MIN_POINT_DISTANCE * invScale())
        ) {
          measurePoints.push([p[0], p[1]]);
          renderMeasurement();
        }
      }
      e.preventDefault();
      return;
    }

    if (drawing && e.pointerId === activePointerId && draft) {
      const p = toMapPoint(e);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
      const last = draftPoints[draftPoints.length - 1];
      if (
        draftPoints.length < MAX_RAW_POINTS &&
        (!last ||
          Math.hypot(p[0] - last[0], p[1] - last[1]) >=
            MIN_POINT_DISTANCE * invScale())
      ) {
        draftPoints.push([p[0], p[1]]);
        draft.points = draftPoints;
        requestPreview();
      }
      e.preventDefault();
      return;
    }

    if (dragState && e.pointerId === dragState.pointerId) {
      const p = toMapPoint(e);
      const item = appStore.tacticalItems.find((it) => it.id === dragState!.id);
      if (!item) return;
      const dx = p[0] - dragState.start[0];
      const dy = p[1] - dragState.start[1];
      if (!dragState.moved && Math.hypot(dx, dy) < 1.2 * invScale()) return;
      dragState.moved = true;
      item.points = dragState.original.map(
        (pt) => [pt[0] + dx, pt[1] + dy] as Pt
      );
      // 拖拽中只本地重绘；tactical-change 留到松手再发，避免每个 move 触发全量快照落盘
      renderTactical();
      e.preventDefault();
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (measuring && e.pointerId === measurePointerId) {
      finishMeasure(canvasEl, e);
      releasePointer(canvasEl, e.pointerId);
      return;
    }
    if (drawing && e.pointerId === activePointerId) {
      finishDraw(canvasEl, e);
      releasePointer(canvasEl, e.pointerId);
      return;
    }
    if (dragState && e.pointerId === dragState.pointerId) {
      const wasMoved = dragState.moved;
      if (wasMoved) recordSnapshot(dragState.snapshot);
      dragState = null;
      releasePointer(canvasEl, e.pointerId);
      if (wasMoved) appStore.emit('tactical-change');
      updateCursor(canvasEl);
    }
  }

  // ---------------------------------------------------------------------------
  // 绘制流程
  // ---------------------------------------------------------------------------

  function beginDraw(e: PointerEvent, el: HTMLElement) {
    const p = toMapPoint(e);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;

    const mode = appStore.interactionMode;
    const type: TacticalItem['type'] =
      mode === 'tactical-frontline' ? 'frontline' : 'arrow';
    const label = (appStore.tacticalLabel || '').trim();

    draftPoints = [[p[0], p[1]]];
    draft = {
      id: nextId(),
      type,
      points: draftPoints,
      color: appStore.tacticalColor,
      width: clampWidth(appStore.tacticalWidth),
      label: label || undefined,
      flipSide: !!appStore.tacticalFlip,
      toothStyle: appStore.tacticalToothStyle,
      arrowStyle: appStore.tacticalArrowStyle,
    };
    drawing = true;
    activePointerId = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 某些环境不支持指针捕获，忽略 */
    }
    el.style.cursor = 'crosshair';
    e.preventDefault();
    requestPreview();
  }

  function finishDraw(el: HTMLElement, e?: PointerEvent) {
    const inv = invScale();
    if (e) {
      const endPt = toMapPoint(e);
      const last = draftPoints[draftPoints.length - 1];
      if (
        Number.isFinite(endPt[0]) &&
        Number.isFinite(endPt[1]) &&
        (!last ||
          Math.hypot(endPt[0] - last[0], endPt[1] - last[1]) > 0.01 * inv)
      ) {
        draftPoints.push([endPt[0], endPt[1]]);
      }
    }

    const item = draft;
    const points = draftPoints
      .filter((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
      .map((pt) => [pt[0], pt[1]] as Pt);
    const length = polylineLength(points);

    drawing = false;
    activePointerId = null;
    draft = null;
    draftPoints = [];
    if (previewGfx) previewGfx.clear();
    updateCursor(el);

    if (!item || points.length < 2 || length < 8 * inv) return;

    recordSnapshot(JSON.stringify(appStore.tacticalItems));
    item.points = points;
    appStore.tacticalItems.push(item);
    appStore.selectedTacticalId = item.id;
    appStore.emit('tactical-history-change');
    appStore.emit('tactical-change');
    appStore.emit('tactical-selection-change', item.id);
  }

  function releasePointer(el: HTMLElement, pointerId: number) {
    try {
      if (el.hasPointerCapture(pointerId)) el.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
  }

  function beginMeasure(e: PointerEvent, el: HTMLElement) {
    const p = toMapPoint(e);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    measurePoints = [[p[0], p[1]]];
    measuring = true;
    measurePointerId = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    el.style.cursor = 'crosshair';
    e.preventDefault();
    renderMeasurement();
  }

  function finishMeasure(el: HTMLElement, e?: PointerEvent) {
    if (e) {
      const endPt = toMapPoint(e);
      const last = measurePoints[measurePoints.length - 1];
      if (
        Number.isFinite(endPt[0]) &&
        Number.isFinite(endPt[1]) &&
        (!last || Math.hypot(endPt[0] - last[0], endPt[1] - last[1]) > 0.01 * invScale())
      ) {
        if (e.shiftKey && measurePoints.length >= 1) {
          measurePoints = [measurePoints[0], [endPt[0], endPt[1]]];
        } else {
          measurePoints.push([endPt[0], endPt[1]]);
        }
      }
    }
    measuring = false;
    measurePointerId = null;
    updateCursor(el);
    if (measurePoints.length < 2) {
      clearMeasurement();
      return;
    }
    renderMeasurement();
  }

  function renderMeasurement() {
    if (!measureLayer) return;
    clearContainer(measureLayer);
    if (measurePoints.length < 2) {
      if (lastMeasureSummary !== '') notifyMeasureUpdate('');
      return;
    }

    const inv = invScale();
    const kmPerPixel = appStore.mapData?.source.kmPerPixel;
    const result = measurePolyline(measurePoints, kmPerPixel);
    notifyMeasureUpdate(result.text);

    const g = new Graphics();
    // 深色衬线 + 亮青虚线/实线测距轨
    strokePolyline(g, measurePoints, 4.2 * inv, 0x020617, 0.78, 1);
    strokePolyline(g, measurePoints, 2.2 * inv, 0x38bdf8, 0.96, 1);

    const first = measurePoints[0];
    const last = measurePoints[measurePoints.length - 1];
    g.circle(first[0], first[1], 3.8 * inv)
      .fill({ color: 0x38bdf8, alpha: 0.95 })
      .stroke({ width: 1.4 * inv, color: 0x020617, alpha: 0.9 });
    g.circle(last[0], last[1], 4.4 * inv)
      .fill({ color: 0xf8fafc, alpha: 0.96 })
      .stroke({ width: 1.6 * inv, color: 0x0284c7, alpha: 0.95 });
    measureLayer.addChild(g);

    // 里程标签锚定在中点或终点上方
    const mid = pointAtDistance(measurePoints, result.pixels * 0.5).point;
    const anchor = result.pixels > 40 * inv ? mid : last;
    const labelText = new Text({
      text: result.text,
      style: {
        fontFamily: '"Microsoft YaHei", "PingFang SC", ui-monospace, monospace',
        fontSize: 12,
        fontWeight: '700',
        fill: 0xe0f2fe,
        stroke: { color: 0x020617, width: 2.5 },
      },
    });
    labelText.anchor.set(0.5);
    labelText.scale.set(inv);

    const w = Math.max(inv, labelText.width);
    const h = Math.max(inv, labelText.height);
    const padX = 7 * inv;
    const padY = 4 * inv;
    const plate = new Graphics();
    plate
      .roundRect(-w / 2 - padX, -h / 2 - padY, w + padX * 2, h + padY * 2, 6 * inv)
      .fill({ color: 0x0b1220, alpha: 0.88 })
      .stroke({ width: 1.2 * inv, color: 0x38bdf8, alpha: 0.92 });

    const pill = new Container();
    pill.addChild(plate, labelText);
    pill.position.set(anchor[0], anchor[1] - 18 * inv);
    measureLayer.addChild(pill);
  }

  function cancelDraft() {
    if (measuring) {
      measuring = false;
      measurePointerId = null;
    }
    if (!drawing && !dragState) return;
    if (drawing && activePointerId !== null) {
      // 指针捕获会在 pointerup 时统一释放，这里只清状态
      activePointerId = null;
    }
    drawing = false;
    if (dragState) {
      for (const item of appStore.tacticalItems) {
        if (item.id === dragState.id) item.points = dragState.original;
      }
    }
    dragState = null;
    draft = null;
    draftPoints = [];
    if (previewGfx) previewGfx.clear();
    if (itemsLayer) renderTactical();
    updateCursor(null);
  }

  // ---------------------------------------------------------------------------
  // 选择 / 拖动
  // ---------------------------------------------------------------------------

  function beginSelect(e: PointerEvent, el: HTMLElement) {
    const p = toMapPoint(e);
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;

    const items = appStore.tacticalItems || [];
    // 箭头本体屏幕恒定，判定半径也按屏幕像素（约 10px 起步）；战线仍按地图距离
    const inv = invScale();
    let best: TacticalItem | null = null;
    let bestDist = Infinity;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const threshold =
        item.type === 'arrow'
          ? Math.max(10, item.width * 3.3 * ARROW_SCALE) * inv
          : Math.max(12, item.width * 3.0) * inv;
      const d = distanceToItem(p, item);
      if (d <= threshold && d < bestDist) {
        best = item;
        bestDist = d;
      }
    }

    if (!best) {
      setSelected(null);
      return;
    }

    setSelected(best.id);
    dragState = {
      pointerId: e.pointerId,
      id: best.id,
      start: p,
      original: best.points.map((pt) => [pt[0], pt[1]] as Pt),
      moved: false,
      snapshot: JSON.stringify(appStore.tacticalItems),
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    el.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function setSelected(id: string | null) {
    if (appStore.selectedTacticalId === id) return;
    appStore.selectedTacticalId = id;
    appStore.emit('tactical-selection-change', id);
    renderTactical();
  }

  // ---------------------------------------------------------------------------
  // 撤销 / 删除 / 清空（工具栏也调用这些导出函数）
  // ---------------------------------------------------------------------------

  function nextId() {
    idCounter += 1;
    return `tac-${Date.now().toString(36)}-${idCounter}`;
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  function renderTactical() {
    if (!itemsLayer) return;
    clearContainer(itemsLayer);

    const items = appStore.tacticalItems || [];
    const selected = items.find(
      (item) => item.id === appStore.selectedTacticalId
    );

    if (selected) {
      itemsLayer.addChild(makeItemGraphic(selected, { highlight: true }));
    }
    for (const item of items) {
      if (item.points && item.points.length > 1) {
        itemsLayer.addChild(makeItemGraphic(item));
      }
    }
    for (const item of items) {
      const label = (item.label || '').trim();
      if (label && item.points && item.points.length > 1) {
        itemsLayer.addChild(
          makeLabel(item, label, item.id === appStore.selectedTacticalId)
        );
      }
    }

  }

  function requestPreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      renderPreview();
    });
  }

  function renderPreview() {
    if (!previewGfx) return;
    previewGfx.clear();
    if (!draft || draft.points.length < 2) return;

    previewGfx.alpha = PREVIEW_ALPHA;
    drawItemInto(
      previewGfx,
      draft,
      parseColor(draft.color),
      1,
      clampWidth(draft.width)
    );

    // 起点与笔尖的定位点（屏幕恒定尺寸）
    const first = draft.points[0];
    const last = draft.points[draft.points.length - 1];
    const inv = invScale();
    previewGfx
      .circle(first[0], first[1], 3.2 * inv)
      .fill({ color: 0xffffff, alpha: 0.9 })
      .circle(last[0], last[1], 4.2 * inv)
      .fill({ color: 0xffffff, alpha: 0.22 })
      .stroke({ width: 1.4 * inv, color: 0xffffff, alpha: 0.85 });
  }

  function makeItemGraphic(
    item: TacticalItem,
    options: DrawOptions = {}
  ): Graphics {
    const g = new Graphics();
    const color = options.highlight
      ? 0x38bdf8
      : parseColor(item.color);
    const alpha = options.highlight ? 0.42 : 1;
    // 选中加宽按屏幕像素：drawFrontline/drawArrow 内部会乘 invScale()
    const width = clampWidth(item.width) + (options.highlight ? 6 : 0);
    drawItemInto(g, item, color, alpha, width);
    return g;
  }

  function makeLabel(
    item: TacticalItem,
    label: string,
    selected: boolean
  ): Container {
    const anchor = labelAnchor(item);
    // 标注与图形同为屏幕恒定尺寸：字号/描边/衬板内边距随缩放反向补偿
    const inv = invScale();
    // 按屏幕字号生成纹理，再整体反向缩放，避免高倍率时用不足 1px 的字号栅格化。
    const fontSize = 12;
    const text = new Text({
      text: label,
      style: {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize,
        fontWeight: '600',
        fill: selected ? 0xbae6fd : 0xf8fafc,
        stroke: { color: 0x020617, width: 2.5 },
        letterSpacing: 0.4,
      },
    });
    text.anchor.set(0.5);
    text.scale.set(inv);

    const w = Math.max(inv, text.width);
    const h = Math.max(inv, text.height);
    const padX = 6 * inv;
    const padY = 4 * inv;
    const radius = 5 * inv;
    const plate = new Graphics();
    plate
      .roundRect(-w / 2 - padX, -h / 2 - padY, w + padX * 2, h + padY * 2, radius)
      .fill({ color: 0x0b1220, alpha: 0.76 })
      .rect(-w / 2 - padX, -h / 2 - padY, 2.5 * inv, h + padY * 2)
      .fill({ color: parseColor(item.color), alpha: 0.95 });
    if (selected) {
      plate
        .roundRect(-w / 2 - padX, -h / 2 - padY, w + padX * 2, h + padY * 2, radius)
        .stroke({ width: inv, color: 0x38bdf8, alpha: 0.9 });
    }

    const container = new Container();
    container.addChild(plate);
    container.addChild(text);
    container.position.set(anchor.pos[0], anchor.pos[1]);
    container.rotation = anchor.rotation;
    return container;
  }

  function labelAnchor(item: TacticalItem): {
    pos: Pt;
    rotation: number;
  } {
    const inv = invScale();
    const raw = sanitizePoints(item.points);
    const step = (item.type === 'arrow' ? 4 : 5) * inv;
    const pts = resample(
      freehandCenterline(raw, Math.max(4, clampWidth(item.width) * 2) * inv),
      step
    );
    if (pts.length < 2) {
      return { pos: raw[0] ?? [0, 0], rotation: 0 };
    }
    const total = polylineLength(pts);
    const fraction = item.type === 'arrow' ? 0.46 : 0.5;
    const at = pointAtDistance(pts, total * fraction);
    const n: Pt = [-at.tangent[1], at.tangent[0]];
    const width = clampWidth(item.width);
    let offset: number;
    let side: number;
    if (item.type === 'frontline') {
      side = item.flipSide ? 1 : -1; // 标注放在齿的另一侧
      offset = Math.max(20, width * 3.3) * inv;
    } else {
      side = 1;
      offset = Math.max(20, width * 3.3 * ARROW_SCALE) * inv;
    }
    const pos: Pt = [
      at.point[0] + n[0] * offset * side,
      at.point[1] + n[1] * offset * side,
    ];

    let rotation = Math.atan2(at.tangent[1], at.tangent[0]);
    if (rotation > Math.PI / 2 || rotation < -Math.PI / 2) {
      rotation += Math.PI;
    }
    return { pos, rotation };
  }

  // ---------------------------------------------------------------------------
  // 具体图形绘制
  // ---------------------------------------------------------------------------

  function drawItemInto(
    g: Graphics,
    item: TacticalItem,
    color: number,
    alpha: number,
    width: number
  ) {
    if (item.type === 'frontline') {
      drawFrontline(g, item, color, alpha, width);
    } else {
      drawArrow(g, item, color, alpha, width);
    }
  }

  function drawFrontline(
    g: Graphics,
    item: TacticalItem,
    color: number,
    alpha: number,
    width: number
  ) {
    const inv = invScale();
    const raw = sanitizePoints(item.points);
    if (raw.length < 2) return;

    const pts = resample(
      freehandCenterline(raw, Math.max(4, width * 2) * inv),
      Math.max(3, Math.min(9, width * 0.9)) * inv
    );
    if (pts.length < 2) return;

    const total = polylineLength(pts);
    const solid = alpha >= 0.99;
    const side = item.flipSide ? -1 : 1;
    // 战线与箭头同为屏幕恒定尺寸：齿距/齿高/线宽随缩放反向补偿
    const spacing = Math.max(7 * inv, width * 3.15 * inv);
    const toothWidth = spacing * 0.62;
    const toothHeight = Math.max(5 * inv, width * 2.15 * inv);
    const dark = darken(color, 0.55);

    // 齿：先统一生成路径，再一次性填充/描边
    const toothMode = item.toothStyle === 'semicircle' ? 'semicircle' : 'sawtooth';
    let hasTooth = false;
    const emitTooth = (s: number) => {
      const at = pointAtDistance(pts, s);
      const n: Pt = [-at.tangent[1] * side, at.tangent[0] * side];
      if (toothMode === 'semicircle') {
        const r = toothHeight * 0.56;
        const cx = at.point[0] + n[0] * r * 0.52;
        const cy = at.point[1] + n[1] * r * 0.52;
        g.circle(cx, cy, r);
        hasTooth = true;
      } else {
        const t = at.tangent;
        const halfW = toothWidth / 2;
        const ax = at.point[0] - t[0] * halfW;
        const ay = at.point[1] - t[1] * halfW;
        const bx = at.point[0] + t[0] * halfW;
        const by = at.point[1] + t[1] * halfW;
        const apexX =
          at.point[0] + n[0] * toothHeight + t[0] * toothWidth * 0.34;
        const apexY =
          at.point[1] + n[1] * toothHeight + t[1] * toothWidth * 0.34;
        g.poly([ax, ay, apexX, apexY, bx, by]);
        hasTooth = true;
      }
    };

    for (let s = spacing * 0.45; s < total - 1 * inv; s += spacing) {
      emitTooth(s);
    }
    if (!hasTooth && total >= spacing * 0.45) {
      emitTooth(total * 0.5);
    }

    if (hasTooth) {
      g.fill({ color, alpha });
      if (solid) {
        g.stroke({
          width: 0.8 * inv,
          color: dark,
          alpha: 0.95,
          join: 'round',
        });
      }
    }

    // 主线：深色包边 + 主色芯线
    strokePolyline(g, pts, (width + (solid ? 2.2 : 0)) * inv, solid ? dark : color, alpha, solid ? 0.9 : 1);
    strokePolyline(g, pts, width * inv, color, alpha, 1);
  }

  function drawArrow(
    g: Graphics,
    item: TacticalItem,
    color: number,
    alpha: number,
    width: number
  ) {
    const inv = invScale();
    const raw = sanitizePoints(item.points);
    if (raw.length < 2) return;

    let pts = resample(
      freehandCenterline(raw, Math.max(4, width * 2) * inv),
      Math.max(2.5, width * 0.45) * inv
    );
    if (pts.length < 2) return;
    if (item.flipSide) pts = pts.slice().reverse();

    const total = polylineLength(pts);
    if (total < 3 * inv) return;

    const solid = alpha >= 0.99;
    const dark = darken(color, 0.55);
    const style = item.arrowStyle || 'solid';
    const half = Math.max(1.2, width * 1.35 * ARROW_SCALE) * inv;
    const headHalf = Math.max(2.4, width * 2.9 * ARROW_SCALE) * inv;
    // 描边跟箭身成比例（约 40%），屏幕下限 0.55px——最小档时头部不能被深边吃掉
    const edge = Math.max(0.55 * inv, Math.min(1.35 * inv, half * 0.4));
    const headLen = Math.min(
      Math.max(Math.max(7, width * 4.8 * ARROW_SCALE) * inv, headHalf * 2.2),
      Math.max(4 * inv, total * 0.55)
    );

    if (style === 'double-retreat') {
      const offset = half * 0.98;
      const laneHalf = Math.max(0.5 * inv, half * 0.56);
      const lanes: Pt[][] = [
        offsetPolyline(pts, offset),
        offsetPolyline(pts, -offset),
      ];
      for (const lane of lanes) {
        const poly = buildArrowPolygon(
          lane,
          laneHalf,
          Math.max(1.5 * inv, headHalf * 0.62),
          Math.max(4 * inv, headLen * 0.86),
          inv
        );
        if (poly.length < 6) continue;
        g.poly(poly).fill({ color, alpha });
        if (solid) {
          g.poly(poly).stroke({
            width: Math.max(0.45 * inv, edge * 0.85),
            color: dark,
            alpha: 0.95,
            join: 'round',
          });
        }
      }
      return;
    }

    if (style === 'dashed') {
      const bodyLen = Math.max(0, total - headLen * 0.9);
      const dash = Math.max(3 * inv, width * 2.3 * ARROW_SCALE * inv);
      const gap = Math.max(2 * inv, width * 1.35 * ARROW_SCALE * inv);
      for (let s = 0; s < bodyLen; s += dash + gap) {
        const e = Math.min(bodyLen, s + dash);
        if (e - s < 1.2 * inv) continue;
        const seg = slicePolyline(pts, s, e);
        const poly = buildRibbonPolygon(seg, half);
        if (poly.length < 6) continue;
        g.poly(poly).fill({ color, alpha });
        if (solid) {
          g.poly(poly).stroke({
            width: Math.max(0.4 * inv, edge * 0.74),
            color: dark,
            alpha: 0.9,
            join: 'round',
          });
        }
      }

      const base = pointAtDistance(pts, Math.max(0, total - headLen)).point;
      const tip = pts[pts.length - 1];
      const d = normalize(tip[0] - base[0], tip[1] - base[1]);
      const n: Pt = [-d[1], d[0]];
      const headPoly = [
        base[0] + n[0] * headHalf,
        base[1] + n[1] * headHalf,
        tip[0],
        tip[1],
        base[0] - n[0] * headHalf,
        base[1] - n[1] * headHalf,
      ];
      g.poly(headPoly).fill({ color, alpha });
      if (solid) {
        g.poly(headPoly).stroke({
          width: Math.max(0.45 * inv, edge * 0.85),
          color: dark,
          alpha: 0.95,
          join: 'round',
        });
      }
      return;
    }

    const poly = buildArrowPolygon(pts, half, headHalf, headLen, inv);
    if (poly.length < 6) return;
    g.poly(poly).fill({ color, alpha });
    if (solid) {
      g.poly(poly).stroke({
        width: edge,
        color: dark,
        alpha: 0.95,
        join: 'round',
      });
    }
  }

  function strokePolyline(
    g: Graphics,
    pts: Pt[],
    width: number,
    color: number,
    alpha: number,
    colorAlpha: number
  ) {
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      g.lineTo(pts[i][0], pts[i][1]);
    }
    g.stroke({
      width,
      color,
      alpha: alpha * colorAlpha,
      cap: 'round',
      join: 'round',
    });
  }

  // ---------------------------------------------------------------------------
  // 键盘
  // ---------------------------------------------------------------------------

  function onKeyDown(e: KeyboardEvent) {
    if (isFieldBattleOwner()) return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    const typing =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      !!target?.isContentEditable;

    if (e.code === 'Space' && !typing) {
      spaceHeld = true;
      return;
    }
    if (typing) return;

    if (e.key === 'Escape') {
      cancelDraft();
      clearMeasurement();
      if (appStore.selectedTacticalId) setSelected(null);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const hasModal = Boolean(
        document.querySelector('#garrison-custom-modal, #wenyou-burg-editor-overlay, .bp-modal-overlay')
      );
      if (appStore.interactionMode.startsWith('tactical') && appStore.selectedTacticalId && !hasModal) {
        e.preventDefault();
        deleteSelectedTactical();
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      // Ctrl+Z 只归属当前工具：tactical-* 模式撤战术，其余模式归画笔（brush-panel）
      if (!appStore.interactionMode.startsWith('tactical')) return;
      if (canUndoTactical()) {
        e.preventDefault();
        undoTactical();
      }
    }
  }

  function onKeyUp(e: KeyboardEvent) {
    if (e.code === 'Space') spaceHeld = false;
  }

  function updateCursor(el: HTMLElement | null) {
    if (!el) {
      el = document.querySelector('#app canvas') as HTMLElement | null;
    }
    if (!el) return;
    if (drawing) {
      el.style.cursor = 'crosshair';
      return;
    }
    if (dragState) {
      el.style.cursor = 'grabbing';
      return;
    }
    const mode = appStore.interactionMode;
    if (
      mode === 'tactical-frontline' ||
      mode === 'tactical-arrow' ||
      mode === 'tactical-measure'
    ) {
      el.style.cursor = 'crosshair';
    } else if (mode === 'tactical-select') {
      el.style.cursor = 'pointer';
    } else if (mode === 'pan') {
      el.style.cursor = 'grab';
    }
  }
}

export function pushTacticalSnapshot(): void {
  recordSnapshot(JSON.stringify(appStore.tacticalItems));
}

// -----------------------------------------------------------------------------
// 导出操作（工具栏调用）
// -----------------------------------------------------------------------------

export function canUndoTactical(): boolean {
  return history.length > 0;
}

export function undoTactical(): void {
  const snapshot = history.pop();
  if (!snapshot) return;
  try {
    const restored = JSON.parse(snapshot) as TacticalItem[];
    appStore.tacticalItems = Array.isArray(restored) ? restored : [];
  } catch {
    return;
  }
  if (
    appStore.selectedTacticalId &&
    !appStore.tacticalItems.some(
      (item) => item.id === appStore.selectedTacticalId
    )
  ) {
    appStore.selectedTacticalId = null;
  }
  appStore.emit('tactical-history-change');
  appStore.emit('tactical-change');
  appStore.emit('tactical-selection-change', appStore.selectedTacticalId);
}

export function deleteSelectedTactical(): void {
  const id = appStore.selectedTacticalId;
  if (!id) return;
  const exists = appStore.tacticalItems.some((item) => item.id === id);
  if (!exists) {
    appStore.selectedTacticalId = null;
    appStore.emit('tactical-selection-change', null);
    return;
  }
  recordSnapshot(JSON.stringify(appStore.tacticalItems));
  appStore.tacticalItems = appStore.tacticalItems.filter(
    (item) => item.id !== id
  );
  appStore.selectedTacticalId = null;
  appStore.emit('tactical-history-change');
  appStore.emit('tactical-change');
  appStore.emit('tactical-selection-change', null);
}

export function clearTacticalItems(): void {
  if (!appStore.tacticalItems.length) return;
  recordSnapshot(JSON.stringify(appStore.tacticalItems));
  appStore.tacticalItems = [];
  appStore.selectedTacticalId = null;
  appStore.emit('tactical-history-change');
  appStore.emit('tactical-change');
  appStore.emit('tactical-selection-change', null);
}

// -----------------------------------------------------------------------------
// 几何工具
// -----------------------------------------------------------------------------

function clampWidth(width: number): number {
  const n = Number(width);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(20, n));
}

function sanitizePoints(points: Pt[] | undefined): Pt[] {
  if (!Array.isArray(points)) return [];
  const out: Pt[] = [];
  for (const p of points) {
    if (!p || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (out.length) {
      const last = out[out.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 0.01) continue;
    }
    out.push([x, y]);
  }
  return out;
}

function chaikin(points: Pt[], iterations: number): Pt[] {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    if (pts.length < 3) return pts;
    const out: Pt[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push([
        a[0] * 0.75 + b[0] * 0.25,
        a[1] * 0.75 + b[1] * 0.25,
      ]);
      out.push([
        a[0] * 0.25 + b[0] * 0.75,
        a[1] * 0.25 + b[1] * 0.75,
      ]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
    if (pts.length > 1600) break;
  }
  return pts;
}

/**
 * 用 perfect-freehand 的 streamline 算法对鼠标采样点做去抖平滑。
 * 只取中心线，不采用它的变宽笔迹轮廓，保证军事线条宽度可控。
 */
function freehandCenterline(points: Pt[], size: number): Pt[] {
  if (points.length < 3) return points.slice();
  try {
    const smoothed = getStrokePoints(points, {
      size: Math.max(1e-3, size),
      thinning: 0,
      smoothing: 0.56,
      streamline: 0.52,
      simulatePressure: false,
      last: true,
    });
    if (smoothed.length >= 2) {
      const out = smoothed.map(
        (sp) => [sp.point[0], sp.point[1]] as Pt
      );
      // 保证首尾与原笔迹一致，避免图形脱离落笔/收笔位置
      out[0] = [points[0][0], points[0][1]];
      out[out.length - 1] = [
        points[points.length - 1][0],
        points[points.length - 1][1],
      ];
      return out;
    }
  } catch {
    /* 平滑失败时退回轻量 Chaikin */
  }
  return chaikin(points, 1);
}

function resample(points: Pt[], step: number): Pt[] {
  if (points.length < 2 || !(step > 0)) return points.slice();
  const out: Pt[] = [[points[0][0], points[0][1]]];
  let prev: Pt = [points[0][0], points[0][1]];
  for (let i = 1; i < points.length; i++) {
    const curr = points[i];
    let d = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
    while (d >= step) {
      const t = step / d;
      const nx = prev[0] + (curr[0] - prev[0]) * t;
      const ny = prev[1] + (curr[1] - prev[1]) * t;
      out.push([nx, ny]);
      prev = [nx, ny];
      d = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
      if (out.length > 2200) return out;
    }
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > 0.01) {
    out.push([last[0], last[1]]);
  }
  return out;
}

function pointAtDistance(
  points: Pt[],
  distance: number
): { point: Pt; tangent: Pt } {
  if (points.length === 0) return { point: [0, 0], tangent: [1, 0] };
  if (points.length === 1) return { point: points[0], tangent: [1, 0] };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 1e-6) continue;
    if (acc + len >= distance) {
      const t = Math.max(0, Math.min(1, (distance - acc) / len));
      return {
        point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        tangent: [(b[0] - a[0]) / len, (b[1] - a[1]) / len],
      };
    }
    acc += len;
  }
  const n = points.length;
  const a = points[n - 2];
  const b = points[n - 1];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return {
    point: [b[0], b[1]],
    tangent: [(b[0] - a[0]) / len, (b[1] - a[1]) / len],
  };
}

function slicePolyline(points: Pt[], start: number, end: number): Pt[] {
  if (points.length < 2 || end <= start) return [];
  const out: Pt[] = [];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len <= 1e-6) continue;
    const segStart = acc;
    const segEnd = acc + len;
    if (segEnd >= start && segStart <= end) {
      const t0 = clamp((Math.max(start, segStart) - segStart) / len, 0, 1);
      const t1 = clamp((Math.min(end, segEnd) - segStart) / len, 0, 1);
      const p0: Pt = [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
      const p1: Pt = [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
      if (
        !out.length ||
        Math.hypot(p0[0] - out[out.length - 1][0], p0[1] - out[out.length - 1][1]) >
          0.01
      ) {
        out.push(p0);
      }
      if (
        Math.hypot(p1[0] - out[out.length - 1][0], p1[1] - out[out.length - 1][1]) >
          0.01
      ) {
        out.push(p1);
      }
    }
    acc = segEnd;
    if (acc >= end) break;
  }
  return out;
}

function tangentAt(points: Pt[], index: number): Pt {
  if (points.length < 2) return [1, 0];
  const a = points[Math.max(0, index - 1)];
  const b = points[Math.min(points.length - 1, index + 1)];
  return normalize(b[0] - a[0], b[1] - a[1]);
}

function buildRibbonPolygon(points: Pt[], half: number): number[] {
  if (points.length < 2) return [];
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const t = tangentAt(points, i);
    const nx = -t[1];
    const ny = t[0];
    left.push([points[i][0] + nx * half, points[i][1] + ny * half]);
    right.push([points[i][0] - nx * half, points[i][1] - ny * half]);
  }
  const poly: number[] = [];
  for (const p of left) poly.push(p[0], p[1]);
  for (let i = right.length - 1; i >= 0; i--) {
    poly.push(right[i][0], right[i][1]);
  }
  return poly;
}

function buildArrowPolygon(
  points: Pt[],
  half: number,
  headHalf: number,
  headLen: number,
  inv = 1
): number[] {
  const total = polylineLength(points);
  if (total < 1 * inv) return [];
  const hLen = Math.min(headLen, Math.max(3 * inv, total * 0.6));
  const shaftLen = Math.max(0, total - hLen);
  const shaft = slicePolyline(points, 0, shaftLen);

  if (shaft.length < 2) {
    const a = points[0];
    const b = points[points.length - 1];
    const d = normalize(b[0] - a[0], b[1] - a[1]);
    const n: Pt = [-d[1], d[0]];
    const base: Pt = [b[0] - d[0] * hLen, b[1] - d[1] * hLen];
    return [
      base[0] + n[0] * headHalf,
      base[1] + n[1] * headHalf,
      b[0],
      b[1],
      base[0] - n[0] * headHalf,
      base[1] - n[1] * headHalf,
    ];
  }

  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < shaft.length; i++) {
    const t = tangentAt(shaft, i);
    const nx = -t[1];
    const ny = t[0];
    left.push([shaft[i][0] + nx * half, shaft[i][1] + ny * half]);
    right.push([shaft[i][0] - nx * half, shaft[i][1] - ny * half]);
  }

  const base = shaft[shaft.length - 1];
  const tip = points[points.length - 1];
  const d = normalize(tip[0] - base[0], tip[1] - base[1]);
  const n: Pt = [-d[1], d[0]];

  const poly: number[] = [];
  for (const p of left) poly.push(p[0], p[1]);
  poly.push(base[0] + n[0] * headHalf, base[1] + n[1] * headHalf);
  poly.push(tip[0], tip[1]);
  poly.push(base[0] - n[0] * headHalf, base[1] - n[1] * headHalf);
  for (let i = right.length - 1; i >= 0; i--) {
    poly.push(right[i][0], right[i][1]);
  }
  return poly;
}

function offsetPolyline(points: Pt[], offset: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) {
    const t = tangentAt(points, i);
    out.push([
      points[i][0] - t[1] * offset,
      points[i][1] + t[0] * offset,
    ]);
  }
  return out;
}

function distanceToItem(point: Pt, item: TacticalItem): number {
  const pts = sanitizePoints(item.points);
  if (pts.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    best = Math.min(best, distanceToSegment(point, pts[i - 1], pts[i]));
  }
  return best;
}

function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + dx * t;
  const y = a[1] + dy * t;
  return Math.hypot(p[0] - x, p[1] - y);
}

function normalize(x: number, y: number): Pt {
  const len = Math.hypot(x, y);
  if (len < 1e-6) return [1, 0];
  return [x / len, y / len];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseColor(color: string): number {
  const fallback = 0xef4444;
  if (typeof color !== 'string') return fallback;
  const value = color.trim();
  if (value.startsWith('#')) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      return parseInt(
        hex
          .split('')
          .map((c) => c + c)
          .join(''),
        16
      );
    }
    if (hex.length === 6 || hex.length === 8) {
      return parseInt(hex.slice(0, 6), 16);
    }
  }
  const rgb = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/
  );
  if (rgb) {
    return (
      (Number(rgb[1]) << 16) |
      (Number(rgb[2]) << 8) |
      Number(rgb[3])
    );
  }
  return fallback;
}

function darken(color: number, factor: number): number {
  const r = Math.max(0, Math.min(255, Math.round(((color >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((color >> 8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((color & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

function clearContainer(container: Container) {
  for (let i = container.children.length - 1; i >= 0; i--) {
    const child = container.children[i];
    container.removeChild(child);
    child.destroy({ children: true });
  }
}

export {
  invScale,
  polylineLength,
  resample,
  freehandCenterline,
  sanitizePoints,
  distanceToItem,
};
