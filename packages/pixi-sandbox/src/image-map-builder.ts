import type { MapData, RetouchStroke, StateItem } from './store';

export type ImageGridPreset = 'coarse' | 'standard' | 'fine';

export const DEFAULT_IMAGE_OVERLAY_ALPHA = 0.38;
export const MIN_IMAGE_HEX_RADIUS = 10;
export const MAX_IMAGE_HEX_RADIUS = 80;
export const IMAGE_GRID_PRESET_TARGETS: Record<ImageGridPreset, number> = {
  coarse: 2200,
  standard: 5000,
  fine: 9500,
};

export interface WenyouImageBaseSpec {
  wenyouImageBase: 1;
  mapId: string;
  name: string;
  width: number;
  height: number;
  hexRadius: number;
  imageUrl: string;
  imageRelPath?: string;
  kmPerPixel?: number;
  mapWidthKm?: number;
  overlayAlpha?: number;
  retouchStrokes?: RetouchStroke[];
}

export interface CreateImageBaseSpecInput {
  name: string;
  width: number;
  height: number;
  imageUrl: string;
  imageRelPath?: string;
  gridPreset?: ImageGridPreset;
  hexRadius?: number;
  mapWidthKm?: number;
  overlayAlpha?: number;
  retouchStrokes?: RetouchStroke[];
  mapId?: string;
}

const SQRT3 = Math.sqrt(3);
const HEX_AREA_FACTOR = 1.5 * SQRT3;

const DEFAULT_IMAGE_STATES: readonly StateItem[] = [
  { i: 0, name: '未划分', color: '#94a3b8' },
  { i: 1, name: '红方势力', color: '#ef4444' },
  { i: 2, name: '蓝方势力', color: '#3b82f6' },
  { i: 3, name: '绿方势力', color: '#22c55e' },
  { i: 4, name: '金方势力', color: '#eab308' },
  { i: 5, name: '紫方势力', color: '#a855f7' },
];

const EVEN_ROW_OFFSETS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, -1],
  [-1, 0],
  [1, -1],
  [1, 0],
];

const ODD_ROW_OFFSETS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [-1, 1],
  [1, 0],
  [1, 1],
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampOverlayAlpha(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_IMAGE_OVERLAY_ALPHA;
  return clamp(value, 0, 1);
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function slugifyMapName(name: string, disambiguator?: string): string {
  const base = name.replace(/\.[a-z0-9]{1,8}$/i, '').trim();
  const ascii = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const hasNonAscii = /[^\x00-\x7f]/.test(base);
  const trimmedDisambiguator = (disambiguator ?? '').trim();
  const normalizedDisambiguator = trimmedDisambiguator.replace(/\.[a-z0-9]{1,8}$/i, '').trim().toLowerCase();
  const hasDistinctDisambiguator =
    trimmedDisambiguator.length > 0 && normalizedDisambiguator !== base.toLowerCase();
  const hashSource = `${base}|${trimmedDisambiguator}`;
  if (!ascii) {
    return `m${fnv1aHex(hashSource)}`;
  }
  if (hasNonAscii || hasDistinctDisambiguator) {
    return `${ascii.slice(0, 16)}-${fnv1aHex(hashSource)}`;
  }
  return ascii;
}

/** 按目标格数反推 Pointy-top Odd-R 六角半径并夹紧在 10..80 像素。 */
export function computeHexRadiusForPreset(
  width: number,
  height: number,
  preset: ImageGridPreset = 'standard',
): number {
  const safeW = Math.max(1, Number.isFinite(width) ? width : 1600);
  const safeH = Math.max(1, Number.isFinite(height) ? height : 1000);
  const target = IMAGE_GRID_PRESET_TARGETS[preset] ?? IMAGE_GRID_PRESET_TARGETS.standard;
  const radius = Math.sqrt((safeW * safeH) / (target * HEX_AREA_FACTOR));
  return clamp(Math.round(radius), MIN_IMAGE_HEX_RADIUS, MAX_IMAGE_HEX_RADIUS);
}

/** 生成确定性的图片战区 mapId。 */
export function buildImageMapId(
  name: string,
  width: number,
  height: number,
  hexRadius: number,
  disambiguator?: string,
): string {
  const slug = slugifyMapName(name, disambiguator);
  return `img-${slug}-${Math.round(width)}x${Math.round(height)}-r${Math.round(hexRadius)}`;
}

/** 根据图片尺寸、预设网格密度与可选横向跨度构造标准 WenyouImageBaseSpec。 */
export function createImageBaseSpec(input: CreateImageBaseSpecInput): WenyouImageBaseSpec {
  const name = input.name.trim() || '图片战区';
  const width = Math.max(32, Math.round(input.width));
  const height = Math.max(32, Math.round(input.height));
  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
    throw new Error('[image-map-builder] 图片宽高必须为正有限数');
  }
  if (typeof input.imageUrl !== 'string' || !input.imageUrl.trim()) {
    throw new Error('[image-map-builder] 缺少有效的图片底图地址 imageUrl');
  }
  const hexRadius =
    typeof input.hexRadius === 'number' && Number.isFinite(input.hexRadius) && input.hexRadius > 0
      ? clamp(Math.round(input.hexRadius), MIN_IMAGE_HEX_RADIUS, MAX_IMAGE_HEX_RADIUS)
      : computeHexRadiusForPreset(width, height, input.gridPreset ?? 'standard');
  const mapWidthKm =
    typeof input.mapWidthKm === 'number' && Number.isFinite(input.mapWidthKm) && input.mapWidthKm > 0
      ? input.mapWidthKm
      : undefined;
  const kmPerPixel = mapWidthKm !== undefined ? mapWidthKm / width : undefined;
  const overlayAlpha = clampOverlayAlpha(input.overlayAlpha);
  const mapId =
    input.mapId && input.mapId.trim().length > 0
      ? input.mapId.trim()
      : buildImageMapId(name, width, height, hexRadius, input.imageRelPath || input.imageUrl.slice(0, 128));

  return {
    wenyouImageBase: 1,
    mapId,
    name,
    width,
    height,
    hexRadius,
    imageUrl: input.imageUrl,
    ...(input.imageRelPath !== undefined ? { imageRelPath: input.imageRelPath } : {}),
    ...(kmPerPixel !== undefined ? { kmPerPixel } : {}),
    ...(mapWidthKm !== undefined ? { mapWidthKm } : {}),
    overlayAlpha,
    retouchStrokes: input.retouchStrokes ? structuredClone(input.retouchStrokes) : [],
  };
}

function validateRetouchStrokes(value: unknown): RetouchStroke[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('[image-map-builder] retouchStrokes 必须为数组');
  }
  const result: RetouchStroke[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('[image-map-builder] retouchStrokes 包含无效笔划对象');
    }
    const stroke = item as Record<string, unknown>;
    if (
      typeof stroke.id !== 'string' ||
      typeof stroke.color !== 'string' ||
      typeof stroke.width !== 'number' ||
      !Number.isFinite(stroke.width) ||
      stroke.width <= 0 ||
      !Array.isArray(stroke.points) ||
      stroke.points.length === 0 ||
      !stroke.points.every(
        (pt) =>
          Array.isArray(pt) &&
          pt.length === 2 &&
          typeof pt[0] === 'number' &&
          Number.isFinite(pt[0]) &&
          typeof pt[1] === 'number' &&
          Number.isFinite(pt[1]),
      )
    ) {
      throw new Error('[image-map-builder] retouchStrokes 笔划字段无效');
    }
    result.push({
      id: stroke.id,
      color: stroke.color,
      width: stroke.width,
      points: (stroke.points as [number, number][]).map(([x, y]) => [x, y]),
    });
  }
  return result;
}

/** 判断原始文本是否为 wenyouImageBase JSON 描述头。 */
export function isImageBaseSource(raw: string): boolean {
  const trimmed = raw.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).wenyouImageBase === 1
    );
  } catch {
    return false;
  }
}

/** 解析并校验 WenyouImageBaseSpec JSON 描述。 */
export function parseImageBaseSpec(raw: string): WenyouImageBaseSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`[image-map-builder] 图片底图描述 JSON 解析失败：${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('[image-map-builder] 图片底图描述必须为 JSON 对象');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.wenyouImageBase !== 1) {
    throw new Error('[image-map-builder] 不支持的 wenyouImageBase 版本');
  }
  if (typeof obj.mapId !== 'string' || !obj.mapId.trim()) {
    throw new Error('[image-map-builder] 缺少有效的 mapId');
  }
  if (typeof obj.name !== 'string') {
    throw new Error('[image-map-builder] 缺少有效的 name');
  }
  if (typeof obj.width !== 'number' || !Number.isFinite(obj.width) || obj.width <= 0) {
    throw new Error('[image-map-builder] 缺少有效的 width');
  }
  if (typeof obj.height !== 'number' || !Number.isFinite(obj.height) || obj.height <= 0) {
    throw new Error('[image-map-builder] 缺少有效的 height');
  }
  if (typeof obj.hexRadius !== 'number' || !Number.isFinite(obj.hexRadius) || obj.hexRadius <= 0) {
    throw new Error('[image-map-builder] 缺少有效的 hexRadius');
  }
  if (typeof obj.imageUrl !== 'string' || !obj.imageUrl.trim()) {
    throw new Error('[image-map-builder] 缺少有效的 imageUrl');
  }
  if (obj.imageRelPath !== undefined && typeof obj.imageRelPath !== 'string') {
    throw new Error('[image-map-builder] imageRelPath 必须为字符串');
  }

  const width = Math.round(obj.width);
  const height = Math.round(obj.height);
  const hexRadius = Math.max(4, Math.round(obj.hexRadius));

  let kmPerPixel: number | undefined;
  let mapWidthKm: number | undefined;
  if (obj.kmPerPixel !== undefined) {
    if (typeof obj.kmPerPixel !== 'number' || !Number.isFinite(obj.kmPerPixel) || obj.kmPerPixel <= 0) {
      throw new Error('[image-map-builder] kmPerPixel 必须为正有限数');
    }
    kmPerPixel = obj.kmPerPixel;
  }
  if (obj.mapWidthKm !== undefined) {
    if (typeof obj.mapWidthKm !== 'number' || !Number.isFinite(obj.mapWidthKm) || obj.mapWidthKm <= 0) {
      throw new Error('[image-map-builder] mapWidthKm 必须为正有限数');
    }
    mapWidthKm = obj.mapWidthKm;
  }
  if (mapWidthKm !== undefined && kmPerPixel === undefined) {
    kmPerPixel = mapWidthKm / width;
  } else if (kmPerPixel !== undefined && mapWidthKm === undefined) {
    mapWidthKm = kmPerPixel * width;
  }

  let overlayAlpha = DEFAULT_IMAGE_OVERLAY_ALPHA;
  if (obj.overlayAlpha !== undefined) {
    if (typeof obj.overlayAlpha !== 'number' || !Number.isFinite(obj.overlayAlpha) || obj.overlayAlpha < 0 || obj.overlayAlpha > 1) {
      throw new Error('[image-map-builder] overlayAlpha 必须在 0..1 之间');
    }
    overlayAlpha = obj.overlayAlpha;
  }

  const retouchStrokes = validateRetouchStrokes(obj.retouchStrokes);

  return {
    wenyouImageBase: 1,
    mapId: obj.mapId.trim(),
    name: obj.name || '图片战区',
    width,
    height,
    hexRadius,
    imageUrl: obj.imageUrl,
    ...(obj.imageRelPath !== undefined ? { imageRelPath: obj.imageRelPath } : {}),
    ...(kmPerPixel !== undefined ? { kmPerPixel } : {}),
    ...(mapWidthKm !== undefined ? { mapWidthKm } : {}),
    overlayAlpha,
    retouchStrokes,
  };
}

/** 序列化图片底图描述头。 */
export function serializeImageBaseSpec(spec: WenyouImageBaseSpec): string {
  const normalized: WenyouImageBaseSpec = {
    wenyouImageBase: 1,
    mapId: spec.mapId,
    name: spec.name,
    width: Math.round(spec.width),
    height: Math.round(spec.height),
    hexRadius: Math.round(spec.hexRadius),
    imageUrl: spec.imageUrl,
    ...(spec.imageRelPath !== undefined ? { imageRelPath: spec.imageRelPath } : {}),
    ...(spec.kmPerPixel !== undefined && Number.isFinite(spec.kmPerPixel) && spec.kmPerPixel > 0
      ? { kmPerPixel: spec.kmPerPixel }
      : {}),
    ...(spec.mapWidthKm !== undefined && Number.isFinite(spec.mapWidthKm) && spec.mapWidthKm > 0
      ? { mapWidthKm: spec.mapWidthKm }
      : {}),
    overlayAlpha: clampOverlayAlpha(spec.overlayAlpha),
    retouchStrokes: spec.retouchStrokes ? structuredClone(spec.retouchStrokes) : [],
  };
  return JSON.stringify(normalized);
}

/** 从当前运行中的图片战区 MapData 序列化最新 wenyouImageBase 描述头（含修补笔划、透明度与比例尺）。 */
export function serializeImageBaseSpecFromMap(map: MapData): string {
  if (map.source.baseKind !== 'image' || !map.source.imageUrl) {
    throw new Error('[image-map-builder] 当前地图不是有效的图片底图战区');
  }
  const hexRadius =
    typeof map.source.hexRadius === 'number' && Number.isFinite(map.source.hexRadius) && map.source.hexRadius > 0
      ? Math.round(map.source.hexRadius)
      : computeHexRadiusForPreset(map.width, map.height, 'standard');
  const mapWidthKm =
    typeof map.source.mapWidthKm === 'number' && Number.isFinite(map.source.mapWidthKm) && map.source.mapWidthKm > 0
      ? map.source.mapWidthKm
      : typeof map.source.kmPerPixel === 'number' && Number.isFinite(map.source.kmPerPixel) && map.source.kmPerPixel > 0
        ? map.source.kmPerPixel * map.width
        : undefined;
  const kmPerPixel =
    typeof map.source.kmPerPixel === 'number' && Number.isFinite(map.source.kmPerPixel) && map.source.kmPerPixel > 0
      ? map.source.kmPerPixel
      : mapWidthKm !== undefined
        ? mapWidthKm / map.width
        : undefined;

  return serializeImageBaseSpec({
    wenyouImageBase: 1,
    mapId: map.source.mapId,
    name: map.source.name,
    width: map.width,
    height: map.height,
    hexRadius,
    imageUrl: map.source.imageUrl,
    ...(map.source.imageRelPath !== undefined ? { imageRelPath: map.source.imageRelPath } : {}),
    ...(kmPerPixel !== undefined ? { kmPerPixel } : {}),
    ...(mapWidthKm !== undefined ? { mapWidthKm } : {}),
    overlayAlpha: clampOverlayAlpha(map.source.overlayAlpha),
    retouchStrokes: map.source.retouchStrokes ? structuredClone(map.source.retouchStrokes) : [],
  });
}

/** 计算标准 Pointy-top Odd-R 六角网格的严格对称六邻接表。 */
export function computeOddRHexNeighbors(rows: number, cols: number): number[][] {
  const count = rows * cols;
  const neighbors: number[][] = new Array(count);
  for (let row = 0; row < rows; row++) {
    const offsets = row % 2 === 1 ? ODD_ROW_OFFSETS : EVEN_ROW_OFFSETS;
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const list: number[] = [];
      for (const [dr, dc] of offsets) {
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          list.push(nr * cols + nc);
        }
      }
      neighbors[cell] = list;
    }
  }
  return neighbors;
}

/** 确定性构建静态图片底图上的 Pointy-top Odd-R 虚拟六角网格 MapData。 */
export function buildImageHexMapData(spec: WenyouImageBaseSpec): MapData {
  const normalized = parseImageBaseSpec(serializeImageBaseSpec(spec));
  const { width, height, hexRadius: r } = normalized;
  const dx = SQRT3 * r;
  const dy = 1.5 * r;
  const halfDx = dx * 0.5;
  const halfR = r * 0.5;

  const cols = Math.max(2, Math.ceil(width / dx));
  const rows = Math.max(2, Math.ceil(height / dy));
  const count = rows * cols;

  const p: [number, number][] = new Array(count);
  const polygons: [number, number][][] = new Array(count);
  const c = computeOddRHexNeighbors(rows, cols);

  for (let row = 0; row < rows; row++) {
    const isOdd = row % 2 === 1;
    const v = row * 3 + 2;
    const cy = v * halfR;
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col;
      const u = col * 2 + (isOdd ? 2 : 1);
      const cx = u * halfDx;
      p[cell] = [cx, cy];
      // 使用整格点坐标 (u±1, v±1/2) 精确表达 -30° + 60°*k 顶点，确保相邻六边形共享边零浮点漂移
      polygons[cell] = [
        [(u + 1) * halfDx, (v - 1) * halfR],
        [(u + 1) * halfDx, (v + 1) * halfR],
        [u * halfDx, (v + 2) * halfR],
        [(u - 1) * halfDx, (v + 1) * halfR],
        [(u - 1) * halfDx, (v - 1) * halfR],
        [u * halfDx, (v - 2) * halfR],
      ];
    }
  }

  const h = new Uint8Array(count);
  h.fill(25);
  const state = new Uint16Array(count);
  const province = new Uint16Array(count);
  const religion = new Uint16Array(count);
  const rArr = new Uint16Array(count);
  const g = new Uint32Array(count);
  for (let i = 0; i < count; i++) g[i] = i;
  const fl = new Uint16Array(count);
  const biome = new Uint8Array(count);
  const t = new Int8Array(count);
  t.fill(1);

  const overlayAlpha = clampOverlayAlpha(normalized.overlayAlpha);
  const retouchStrokes = normalized.retouchStrokes ? structuredClone(normalized.retouchStrokes) : [];

  return {
    source: {
      mapId: normalized.mapId,
      name: normalized.name,
      coords: null,
      baseKind: 'image',
      imageUrl: normalized.imageUrl,
      ...(normalized.imageRelPath !== undefined ? { imageRelPath: normalized.imageRelPath } : {}),
      hexRadius: r,
      ...(normalized.kmPerPixel !== undefined ? { kmPerPixel: normalized.kmPerPixel } : {}),
      ...(normalized.mapWidthKm !== undefined ? { mapWidthKm: normalized.mapWidthKm } : {}),
      overlayAlpha,
      retouchStrokes,
      originalMap: serializeImageBaseSpec({
        ...normalized,
        overlayAlpha,
        retouchStrokes,
      }),
    },
    width,
    height,
    cells: {
      count,
      polygons,
      p,
      c,
      h,
      state,
      province,
      religion,
      r: rArr,
      g,
      fl,
      biome,
      t,
    },
    states: DEFAULT_IMAGE_STATES.map((item) => ({ ...item })),
    provinces: [],
    religions: [
      { i: 0, name: '无', color: '#94a3b8' },
      { i: 1, name: '默认', color: '#cbd5e1' },
    ],
    burgs: [],
    rivers: [],
    biomes: [{ i: 0, name: '底图', color: '#cbd5e1' }],
    lakes: [],
  };
}

/** 在浏览器环境中探测图片原始宽高；SVG 无固有尺寸时兜底 1600×1000。 */
export function probeImageDimensions(url: string): Promise<{ width: number; height: number }> {
  if (typeof Image === 'undefined') {
    return Promise.reject(new Error('[image-map-builder] 当前运行环境不支持 Image 尺寸探测'));
  }
  const isSvg = /^data:image\/svg\+xml/i.test(url) || /\.svg(?:$|[?#])/i.test(url);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (width > 0 && height > 0) {
        resolve({ width: Math.round(width), height: Math.round(height) });
        return;
      }
      if (isSvg) {
        resolve({ width: 1600, height: 1000 });
        return;
      }
      reject(new Error('[image-map-builder] 无法读取图片有效尺寸'));
    };
    img.onerror = () => {
      reject(new Error('[image-map-builder] 图片底图加载失败，请检查文件路径或图片格式'));
    };
    img.src = url;
  });
}
