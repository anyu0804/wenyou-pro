import { Container, Graphics, Texture } from 'pixi.js';
import { appStore, type MapData, type RetouchStroke } from './store';
import { isFieldBattleOwner, isTextInput } from './input-owner';
import { resolveWorkspaceScopeFromUrl } from './theater-cache';

/**
 * 图片底图纹理缓存 + 像素级吸色器 + 擦除旧字修补画笔层
 *
 * - 当底图为 `baseKind === 'image'` 时，加载原图并缓存 Pixi Texture 与离屏 2D 像素画布。
 * - 提供纯像素采样与 3×3 邻域均值转 `#rrggbb`，供吸色笔与 Alt+左键一键吸取底图色。
 * - 管理 `retouch-erase` / `retouch-pick` 画布交互、圆头圆拐角修补笔划绘制与本地撤销栈。
 */

const MAX_RETOUCH_UNDO = 80;
const MIN_RETOUCH_STROKE_WIDTH = 2;
export const MAX_SAFE_TEXTURE_SIZE = 8192;

let detectedMaxTextureSize: number | null = null;

/** 检测当前 WebGL 最大纹理尺寸并封顶至 MAX_SAFE_TEXTURE_SIZE (8192)，无浏览器环境回退 8192。 */
export function detectMaxTextureSize(): number {
  if (detectedMaxTextureSize !== null) return detectedMaxTextureSize;
  let detected = MAX_SAFE_TEXTURE_SIZE;
  if (typeof document !== 'undefined') {
    try {
      const probe = document.createElement('canvas');
      const gl = (probe.getContext('webgl2') || probe.getContext('webgl')) as WebGLRenderingContext | null;
      if (gl) {
        const limit = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
        if (Number.isFinite(limit) && limit >= 1024) {
          detected = Math.min(MAX_SAFE_TEXTURE_SIZE, Math.floor(limit));
        }
        const loseCtx = gl.getExtension('WEBGL_lose_context');
        loseCtx?.loseContext();
      }
    } catch {
      /* ignore */
    }
  }
  detectedMaxTextureSize = detected;
  return detected;
}

/** 计算符合 WebGL 安全纹理上限的等比尺寸，防止超大图上传黑屏或 OOM。 */
export function computeSafeTextureDimensions(
  width: number,
  height: number,
  maxTextureSize?: number
): { width: number; height: number; downsampled: boolean } {
  const safeW = Math.max(1, Math.round(Number.isFinite(width) ? width : 1));
  const safeH = Math.max(1, Math.round(Number.isFinite(height) ? height : 1));
  const rawLimit = maxTextureSize ?? detectMaxTextureSize();
  const limit = Math.max(1024, Math.min(MAX_SAFE_TEXTURE_SIZE, Math.floor(Number.isFinite(rawLimit) ? rawLimit : MAX_SAFE_TEXTURE_SIZE)));
  if (safeW <= limit && safeH <= limit) {
    return { width: safeW, height: safeH, downsampled: false };
  }
  const ratio = limit / Math.max(safeW, safeH);
  return {
    width: Math.max(1, Math.floor(safeW * ratio)),
    height: Math.max(1, Math.floor(safeH * ratio)),
    downsampled: true,
  };
}

/** 当旧目录的 wenyou-asset://vault URL 失效且存在 ?workspace= 与 imageRelPath 时，重建当前工作区路径重试。 */
export function buildWorkspaceVaultFallbackUrl(
  originalUrl: string | undefined,
  imageRelPath?: string,
  workspaceScope?: string | null
): string | null {
  if (!originalUrl || !originalUrl.startsWith('wenyou-asset://vault')) return null;
  const rel = imageRelPath?.trim() ?? '';
  if (!rel) return null;
  const ws = (workspaceScope !== undefined ? workspaceScope : resolveWorkspaceScopeFromUrl())?.trim() ?? '';
  if (!ws) return null;
  const candidate = `wenyou-asset://vault?cwd=${encodeURIComponent(ws)}&path=${encodeURIComponent(rel)}`;
  return candidate === originalUrl ? null : candidate;
}

let cachedImage: HTMLImageElement | null = null;
let cachedTexture: Texture | null = null;
let cachedUrl = '';
let cachedCanvas: HTMLCanvasElement | null = null;
let cachedImageData: ImageData | null = null;
let cachedWidth = 0;
let cachedHeight = 0;
let cachedMapWidth = 0;
let cachedMapHeight = 0;
let loadSeq = 0;

let initialized = false;
let retouchGfx: Graphics | null = null;
let strokeSeq = 0;
let isDrawing = false;
let activePointerId: number | null = null;
let activeStroke: RetouchStroke | null = null;
let spacePressed = false;
const undoStack: string[] = [];

// -----------------------------------------------------------------------------
// 纯算法工具（可供单测直接调用）
// -----------------------------------------------------------------------------

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const hex = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 从 RGBA 像素缓冲区读取 `(x, y)` 处颜色（支持单点或 3×3 邻域均值），返回 `#rrggbb`。
 */
export function sampleColorFromRgbaBuffer(
  data: Uint8ClampedArray | readonly number[],
  width: number,
  height: number,
  x: number,
  y: number,
  neighborhood: 1 | 3 = 3
): string | null {
  if (!data || width <= 0 || height <= 0) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cx = Math.round(x);
  const cy = Math.round(y);
  if (cx < 0 || cx >= width || cy < 0 || cy >= height) return null;

  const expectedMinLen = width * height * 4;
  if (data.length < expectedMinLen) return null;

  const radius = neighborhood === 3 ? 1 : 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  let fallbackR = 0;
  let fallbackG = 0;
  let fallbackB = 0;
  let fallbackCount = 0;

  for (let dy = -radius; dy <= radius; dy++) {
    const py = cy + dy;
    if (py < 0 || py >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const px = cx + dx;
      if (px < 0 || px >= width) continue;
      const idx = (py * width + px) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      if (a > 0) {
        sumR += r;
        sumG += g;
        sumB += b;
        count++;
      } else {
        fallbackR += r;
        fallbackG += g;
        fallbackB += b;
        fallbackCount++;
      }
    }
  }

  if (count > 0) {
    return rgbToHex(sumR / count, sumG / count, sumB / count);
  }
  if (fallbackCount > 0) {
    return rgbToHex(
      fallbackR / fallbackCount,
      fallbackG / fallbackCount,
      fallbackB / fallbackCount
    );
  }
  return null;
}

export function createRetouchStroke(
  color: string,
  radius: number,
  startPoint: [number, number],
  id?: string
): RetouchStroke {
  strokeSeq += 1;
  const width = Math.max(MIN_RETOUCH_STROKE_WIDTH, Math.round(radius * 2));
  return {
    id: id ?? `retouch-${Date.now().toString(36)}-${strokeSeq}`,
    color: color || '#d4c9a8',
    width,
    points: [[startPoint[0], startPoint[1]]],
  };
}

export function appendRetouchPoint(
  stroke: RetouchStroke,
  point: [number, number],
  minDist = 1.5
): boolean {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  const last = stroke.points[stroke.points.length - 1];
  if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < minDist) {
    return false;
  }
  stroke.points.push([point[0], point[1]]);
  return true;
}

export function pushRetouchStroke(map: MapData, stroke: RetouchStroke): number {
  const strokes = (map.source.retouchStrokes ??= []);
  strokes.push(stroke);
  return strokes.length;
}

export function popRetouchStroke(
  map: MapData,
  targetId?: string
): RetouchStroke | null {
  const strokes = map.source.retouchStrokes;
  if (!strokes || strokes.length === 0) return null;
  if (targetId) {
    for (let i = strokes.length - 1; i >= 0; i--) {
      if (strokes[i].id === targetId) {
        const [removed] = strokes.splice(i, 1);
        return removed ?? null;
      }
    }
  }
  return strokes.pop() ?? null;
}

// -----------------------------------------------------------------------------
// 底图纹理与像素缓存管理
// -----------------------------------------------------------------------------

export function clearBaseImageCache(): void {
  loadSeq += 1;
  cachedImage = null;
  if (cachedTexture) {
    cachedTexture.destroy(true);
    cachedTexture = null;
  }
  cachedUrl = '';
  cachedCanvas = null;
  cachedImageData = null;
  cachedWidth = 0;
  cachedHeight = 0;
  cachedMapWidth = 0;
  cachedMapHeight = 0;
}

export function getBaseImageElement(): HTMLImageElement | null {
  return cachedImage;
}

export function getBaseImageTexture(): Texture | null {
  return cachedTexture;
}

export function getBaseImageDimensions(): { width: number; height: number } | null {
  if (cachedMapWidth <= 0 || cachedMapHeight <= 0) return null;
  return { width: cachedMapWidth, height: cachedMapHeight };
}

/**
 * 异步加载底图：
 * 1) 检测 WebGL MAX_TEXTURE_SIZE（封顶 8192），超大图自动等比降采样到安全尺寸生成离屏 Canvas 与纹理，防止黑屏与 OOM；
 * 2) 构造 Pixi Texture 并通过 onReady 通知 map-renderer 挂载底图 Sprite；
 * 3) 绘入离屏 2D Canvas，缓存 RGBA 像素供吸色笔使用。
 */
export function loadBaseImage(
  url: string,
  mapWidth: number,
  mapHeight: number,
  onReady: (texture: Texture, img: HTMLImageElement) => void,
  onError?: (err: unknown) => void
): void {
  const targetW = Math.max(1, Math.round(mapWidth));
  const targetH = Math.max(1, Math.round(mapHeight));

  if (
    url &&
    url === cachedUrl &&
    cachedTexture &&
    cachedMapWidth === targetW &&
    cachedMapHeight === targetH
  ) {
    onReady(cachedTexture, cachedImage ?? (new Image()));
    return;
  }

  clearBaseImageCache();
  if (!url || typeof Image === 'undefined') return;

  const seq = loadSeq;
  const img = new Image();
  img.crossOrigin = 'anonymous';

  img.onload = () => {
    if (seq !== loadSeq) return;
    try {
      const natW = img.naturalWidth || targetW;
      const natH = img.naturalHeight || targetH;
      const texDims = computeSafeTextureDimensions(natW, natH);
      const offDims = computeSafeTextureDimensions(targetW, targetH);

      let offscreen: HTMLCanvasElement | null = null;
      let texCanvas: HTMLCanvasElement | null = null;

      if (typeof document !== 'undefined') {
        offscreen = document.createElement('canvas');
        offscreen.width = offDims.width;
        offscreen.height = offDims.height;
        const ctx = offscreen.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.clearRect(0, 0, offDims.width, offDims.height);
          ctx.drawImage(img, 0, 0, offDims.width, offDims.height);
          cachedCanvas = offscreen;
          try {
            cachedImageData = ctx.getImageData(0, 0, offDims.width, offDims.height);
          } catch {
            // 跨域图片未返回 CORS 头时无法读取像素，但底图仍可正常显示
            cachedImageData = null;
          }
        }

        if (texDims.downsampled) {
          if (offscreen && offDims.width === texDims.width && offDims.height === texDims.height) {
            texCanvas = offscreen;
          } else {
            texCanvas = document.createElement('canvas');
            texCanvas.width = texDims.width;
            texCanvas.height = texDims.height;
            const texCtx = texCanvas.getContext('2d');
            if (texCtx) {
              texCtx.clearRect(0, 0, texDims.width, texDims.height);
              texCtx.drawImage(img, 0, 0, texDims.width, texDims.height);
            }
          }
        }
      }

      const texture = texCanvas ? Texture.from(texCanvas) : Texture.from(img);
      // 超大图降采样时不再暴露原始超限 HTMLImageElement，避免野战裁剪直接上传超限纹理
      cachedImage = texDims.downsampled ? null : img;
      cachedTexture = texture;
      cachedUrl = url;
      cachedWidth = offDims.width;
      cachedHeight = offDims.height;
      cachedMapWidth = targetW;
      cachedMapHeight = targetH;

      onReady(texture, img);
    } catch (err) {
      onError?.(err);
    }
  };

  img.onerror = (err) => {
    if (seq !== loadSeq) return;
    onError?.(err);
  };

  img.src = url;
}

/**
 * 读取地图世界坐标 `(x, y)` 处底图原色（3×3 邻域均值），返回 `#rrggbb`。
 */
export function sampleBaseImageColor(x: number, y: number): string | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (cachedWidth <= 0 || cachedHeight <= 0 || cachedMapWidth <= 0 || cachedMapHeight <= 0) return null;
  const sx = (x * cachedWidth) / cachedMapWidth;
  const sy = (y * cachedHeight) / cachedMapHeight;
  if (cachedImageData) {
    return sampleColorFromRgbaBuffer(
      cachedImageData.data,
      cachedWidth,
      cachedHeight,
      sx,
      sy,
      3
    );
  }
  if (!cachedCanvas) return null;
  const cx = Math.round(sx);
  const cy = Math.round(sy);
  if (cx < 0 || cx >= cachedWidth || cy < 0 || cy >= cachedHeight) return null;
  try {
    const ctx = cachedCanvas.getContext('2d');
    if (!ctx) return null;
    const x0 = Math.max(0, cx - 1);
    const y0 = Math.max(0, cy - 1);
    const w = Math.min(cachedWidth, cx + 2) - x0;
    const h = Math.min(cachedHeight, cy + 2) - y0;
    const patch = ctx.getImageData(x0, y0, w, h);
    return sampleColorFromRgbaBuffer(patch.data, w, h, cx - x0, cy - y0, 3);
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// 修补笔划绘制与交互
// -----------------------------------------------------------------------------

export function renderRetouchStrokesInto(
  graphics: Graphics,
  strokes: readonly RetouchStroke[] | undefined
): void {
  graphics.clear();
  if (!strokes || strokes.length === 0) return;

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (!pts || pts.length === 0) continue;
    const width = Math.max(MIN_RETOUCH_STROKE_WIDTH, Number(stroke.width) || 12);
    const color = stroke.color || '#d4c9a8';

    if (pts.length === 1) {
      graphics.circle(pts[0][0], pts[0][1], width / 2).fill({ color });
      continue;
    }

    graphics.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      graphics.lineTo(pts[i][0], pts[i][1]);
    }
    graphics.stroke({
      width,
      color,
      cap: 'round',
      join: 'round',
    });
  }
}

function renderRetouch(): void {
  if (!retouchGfx) return;
  renderRetouchStrokesInto(retouchGfx, appStore.mapData?.source.retouchStrokes);
}

export function canUndoRetouch(): boolean {
  const strokes = appStore.mapData?.source.retouchStrokes;
  return undoStack.length > 0 || Boolean(strokes && strokes.length > 0);
}

export function undoRetouch(): boolean {
  const map = appStore.mapData;
  if (!map) return false;
  const targetId = undoStack.pop();
  const removed = popRetouchStroke(map, targetId);
  if (!removed) return false;
  renderRetouch();
  appStore.emit('retouch:changed');
  return true;
}

export function clearRetouchStrokes(): boolean {
  const map = appStore.mapData;
  if (!map || !map.source.retouchStrokes?.length) return false;
  map.source.retouchStrokes = [];
  undoStack.length = 0;
  renderRetouch();
  appStore.emit('retouch:changed');
  return true;
}

export function initRetouchLayer(
  canvas: HTMLCanvasElement,
  container: Container
): void {
  if (initialized) return;
  initialized = true;

  retouchGfx = new Graphics();
  container.addChild(retouchGfx);

  const toMap = (event: PointerEvent): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return appStore.toMapCoords(event.clientX - rect.left, event.clientY - rect.top);
  };

  const finishStroke = () => {
    if (!isDrawing) return;
    isDrawing = false;
    const finished = activeStroke;
    activeStroke = null;
    if (activePointerId !== null) {
      try {
        if (canvas.hasPointerCapture(activePointerId)) {
          canvas.releasePointerCapture(activePointerId);
        }
      } catch {
        /* ignore */
      }
      activePointerId = null;
    }
    if (finished) {
      undoStack.push(finished.id);
      if (undoStack.length > MAX_RETOUCH_UNDO) undoStack.shift();
      renderRetouch();
      appStore.emit('retouch:changed');
    }
  };

  canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || spacePressed || isFieldBattleOwner()) return;
    const map = appStore.mapData;
    if (!map) return;

    const mode = appStore.interactionMode;
    const isPickAction =
      mode === 'retouch-pick' || (mode === 'retouch-erase' && event.altKey);

    if (isPickAction) {
      const [mx, my] = toMap(event);
      const picked = sampleBaseImageColor(mx, my);
      if (picked) {
        appStore.retouchColor = picked;
        if (mode === 'retouch-pick') {
          appStore.interactionMode = 'retouch-erase';
          appStore.emit('tactical-mode-change', 'retouch-erase');
        }
        appStore.emit('brush:changed', 'retouch');
      }
      event.preventDefault();
      return;
    }

    if (mode !== 'retouch-erase') return;

    const [mx, my] = toMap(event);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) return;

    const stroke = createRetouchStroke(
      appStore.retouchColor,
      appStore.retouchRadius,
      [mx, my]
    );
    pushRetouchStroke(map, stroke);
    activeStroke = stroke;
    isDrawing = true;
    activePointerId = event.pointerId;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
    renderRetouch();
    event.preventDefault();
  });

  canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!isDrawing || !activeStroke || event.pointerId !== activePointerId) return;
    const [mx, my] = toMap(event);
    const minDist = Math.max(1.5, appStore.retouchRadius * 0.2);
    if (appendRetouchPoint(activeStroke, [mx, my], minDist)) {
      renderRetouch();
    }
    event.preventDefault();
  });

  window.addEventListener('pointerup', (event: PointerEvent) => {
    if (!isDrawing || event.pointerId !== activePointerId) return;
    finishStroke();
  });

  window.addEventListener('pointercancel', () => {
    finishStroke();
  });

  window.addEventListener('blur', () => {
    spacePressed = false;
    finishStroke();
  });

  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (isFieldBattleOwner() || isTextInput(event.target)) return;
    if (event.code === 'Space') {
      spacePressed = true;
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (
      ctrl &&
      !event.shiftKey &&
      event.code === 'KeyZ' &&
      (appStore.interactionMode === 'retouch-erase' ||
        appStore.interactionMode === 'retouch-pick')
    ) {
      if (canUndoRetouch()) {
        event.preventDefault();
        undoRetouch();
      }
    }
  });

  window.addEventListener('keyup', (event: KeyboardEvent) => {
    if (event.code === 'Space') spacePressed = false;
  });

  appStore.on('map:loaded', () => {
    finishStroke();
    undoStack.length = 0;
    renderRetouch();
  });

  appStore.on('map:cleared', () => {
    finishStroke();
    undoStack.length = 0;
    retouchGfx?.clear();
  });

  appStore.on('retouch:changed', () => {
    renderRetouch();
  });

  appStore.on('theater:leaving', () => {
    finishStroke();
  });

  appStore.on('tactical-mode-change', () => {
    if (appStore.interactionMode !== 'retouch-erase') finishStroke();
  });

  renderRetouch();
}
