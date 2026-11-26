import Delaunator from 'delaunator';
import {
  recomputeBurgTiers,
  type BiomeItem,
  type BurgItem,
  type LakeFeature,
  type MapData,
  type ProvinceItem,
  type ReligionItem,
  type RiverItem,
  type StateItem,
} from './store';
import { buildImageHexMapData, isImageBaseSource, parseImageBaseSpec } from './image-map-builder';

/**
 * `.map` 解析与地块网格重建（Agent 1 独占文件 1/3）
 *
 * 输入是 FMG (Azgaar Fantasy Map Generator) 的文本格式存档，兼容两种头部布局：
 *   data[0]  文件头  `version|description|date|seed|width|height|mapId`
 *   —— v1.139 及更早：
 *   data[1]  选项    管道分隔，末尾附 options JSON 与地图名
 *   data[2]  经纬度坐标 JSON
 *   data[3]  生物群系（v1.139+ 为 JSON 数组；更早为 `颜色,#,名称` 管道行）
 *   data[4]  标注 notes
 *   —— v1.154+：选项/坐标/地图名收进 data[1] 的参数 JSON
 *   （坐标在 geography.coordinates，名称在 lore.name），data[2]、data[4] 留空
 *   data[5]  内嵌 SVG（多行，原始渲染底图，本应用不再直接使用）
 *   data[6+] 网格与 pack 数据（从中提取 points / boundary / 高度 / 势力归属）
 *
 * pack 地块（约 2 万个多边形）在存档里 **不存几何**，只存每个地块的属性数组。
 * 几何由 grid 顶点集合 + 边界伪点经 Delaunay/Voronoi 重建，算法与 FMG 的
 * `Grid.rebuildGraph` / `Pack.generate` 等价，因此重建后的地块编号与存档数组
 * 一一对应（本图：21,114 个地块）。
 */

/** 海平面高度（FMG 约定 h < 20 为水域） */
export const SEA_LEVEL = 20;

/** 边界伪点允许向外延伸的像素上限，避免退化三角形产生天文数字坐标 */
const POLYGON_PAD = 80;

export type MapPoint = [number, number];

export interface MapCoords {
  latT: number;
  latN: number;
  latS: number;
  lonT: number;
  lonW: number;
  lonE: number;
}

interface VoronoiGraph {
  cells: { v: number[][]; c: number[][]; b: number[] };
  vertices: { p: MapPoint[] };
}

/**
 * 由点集构造 Voronoi 图。
 * 返回的 `cells.v[c]` 是地块 c 的顶点 id 列表，
 * `cells.c[c]` 是相邻地块 id，`cells.b[c]` 标记是否贴图边。
 */
export function buildVoronoi(points: MapPoint[], boundary: MapPoint[]): VoronoiGraph {
  const allPoints = points.concat(boundary);
  const delaunay = Delaunator.from(allPoints as unknown as ArrayLike<number>[]);
  const pointsN = points.length;
  const triangles = delaunay.triangles;
  const halfedges = delaunay.halfedges;

  const cellsV: number[][] = [];
  const cellsC: number[][] = [];
  const cellsB: number[] = [];
  const verticesP: MapPoint[] = [];

  const nextHalfedge = (e: number) => (e % 3 === 2 ? e - 2 : e + 1);
  const triangleOfEdge = (e: number) => Math.floor(e / 3);
  const edgesOfTriangle = (t: number) => [3 * t, 3 * t + 1, 3 * t + 2];

  const edgesAroundPoint = (start: number): number[] => {
    const result: number[] = [];
    let incoming = start;
    do {
      result.push(incoming);
      const outgoing = nextHalfedge(incoming);
      incoming = halfedges[outgoing];
    } while (incoming !== -1 && incoming !== start && result.length < 24);
    return result;
  };

  const circumcenter = (a: MapPoint, b: MapPoint, c: MapPoint): MapPoint => {
    const [ax, ay] = a;
    const [bx, by] = b;
    const [cx, cy] = c;
    const ad = ax * ax + ay * ay;
    const bd = bx * bx + by * by;
    const cd = cx * cx + cy * cy;
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (!D) return [(ax + bx + cx) / 3, (ay + by + cy) / 3];
    return [
      (1 / D) * (ad * (by - cy) + bd * (cy - ay) + cd * (ay - by)),
      (1 / D) * (ad * (cx - bx) + bd * (ax - cx) + cd * (bx - ax)),
    ];
  };

  for (let e = 0; e < triangles.length; e++) {
    const p = triangles[nextHalfedge(e)];
    if (p < pointsN && !cellsC[p]) {
      const edges = edgesAroundPoint(e);
      cellsV[p] = edges.map((id) => triangleOfEdge(id));
      cellsC[p] = edges.map((id) => triangles[id]).filter((cellId) => cellId < pointsN);
      cellsB[p] = edges.length > cellsC[p].length ? 1 : 0;
    }

    const t = triangleOfEdge(e);
    if (!verticesP[t]) {
      const triangle = edgesOfTriangle(t).map((id) => allPoints[triangles[id]]);
      verticesP[t] = circumcenter(triangle[0], triangle[1], triangle[2]);
    }
  }

  return { cells: { v: cellsV, c: cellsC, b: cellsB }, vertices: { p: verticesP } };
}

// ---------------------------------------------------------------------------
// 文本解析
// ---------------------------------------------------------------------------

interface GridData {
  spacing: number;
  cellsX: number;
  cellsY: number;
  sampling?: string;
  boundary: MapPoint[];
  points: MapPoint[];
  features: Array<{ i?: number; type?: string; land?: boolean }>;
}

const toUint8 = (source?: string): Uint8Array => Uint8Array.from((source ?? '').split(','), Number);
const toInt8 = (source?: string): Int8Array => Int8Array.from((source ?? '').split(','), Number);
const toUint16 = (source?: string): Uint16Array => Uint16Array.from((source ?? '').split(','), Number);

const safeJson = <T>(source: string | undefined, fallback: T): T => {
  if (!source) return fallback;
  try {
    return JSON.parse(source) as T;
  } catch {
    return fallback;
  }
};

/** 把属性数组对齐到地块数量（重建偏差时宁可截断，也不要越界） */
function fitToCells<T extends Uint8Array | Uint16Array | Uint32Array>(
  array: T,
  count: number,
  Ctor: { new (n: number): T }
): T {
  if (array.length === count) return array;
  const result = new Ctor(count);
  result.set(array.subarray(0, Math.min(array.length, count)));
  return result;
}

const clampCoord = (value: number, max: number): number => {
  if (!Number.isFinite(value)) return max / 2;
  return Math.max(-POLYGON_PAD, Math.min(max + POLYGON_PAD, value));
};

/**
 * Sutherland–Hodgman 矩形裁剪。
 * 边界伪点会让图边地块的 Voronoi 外心跑到很远处（±1000 以上），
 * 不裁剪就会出现横穿全图的“尖刺”色块；裁到画布范围后边缘干净且不越界。
 */
function clipPolygonToRect(polygon: MapPoint[], minX: number, minY: number, maxX: number, maxY: number): MapPoint[] {
  const clipVertical = (input: MapPoint[], limit: number, keepGreater: boolean): MapPoint[] => {
    const output: MapPoint[] = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentInside = keepGreater ? current[0] >= limit : current[0] <= limit;
      const previousInside = keepGreater ? previous[0] >= limit : previous[0] <= limit;
      if (currentInside) {
        if (!previousInside) output.push(crossVertical(previous, current, limit));
        output.push(current);
      } else if (previousInside) {
        output.push(crossVertical(previous, current, limit));
      }
    }
    return output;
  };

  const clipHorizontal = (input: MapPoint[], limit: number, keepGreater: boolean): MapPoint[] => {
    const output: MapPoint[] = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      const currentInside = keepGreater ? current[1] >= limit : current[1] <= limit;
      const previousInside = keepGreater ? previous[1] >= limit : previous[1] <= limit;
      if (currentInside) {
        if (!previousInside) output.push(crossHorizontal(previous, current, limit));
        output.push(current);
      } else if (previousInside) {
        output.push(crossHorizontal(previous, current, limit));
      }
    }
    return output;
  };

  const crossVertical = (a: MapPoint, b: MapPoint, x: number): MapPoint => {
    const dx = b[0] - a[0];
    if (!dx) return [x, a[1]];
    const t = (x - a[0]) / dx;
    return [x, a[1] + t * (b[1] - a[1])];
  };

  const crossHorizontal = (a: MapPoint, b: MapPoint, y: number): MapPoint => {
    const dy = b[1] - a[1];
    if (!dy) return [a[0], y];
    const t = (y - a[1]) / dy;
    return [a[0] + t * (b[0] - a[0]), y];
  };

  let result = clipVertical(polygon, minX, true);
  if (result.length < 3) return result;
  result = clipVertical(result, maxX, false);
  if (result.length < 3) return result;
  result = clipHorizontal(result, minY, true);
  if (result.length < 3) return result;
  result = clipHorizontal(result, maxY, false);
  return result;
}

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

const hslToHex = (h: number, s: number, l: number): string => {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - chroma / 2;
  const rgb: [number, number, number] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
};

/** 存档里的颜色可能是 #hex / [h,s,l] / [r,g,b]，统一成 #hex */
function normalizeColor(value: unknown, index: number, fallbackLight = 62): string {
  if (typeof value === 'string' && value.startsWith('#')) return value;
  if (Array.isArray(value) && value.length >= 3) {
    const [a, b, c] = value as number[];
    if (a <= 360 && b <= 100 && c <= 100) return hslToHex(a, b, c);
    const toHex = (v: number) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0');
    return `#${toHex(a)}${toHex(b)}${toHex(c)}`;
  }
  return hslToHex((index * 137.508) % 360, 52, fallbackLight);
}

// ---------------------------------------------------------------------------
// pack 地块重建
// ---------------------------------------------------------------------------

const roundHalf = (value: number): number => Math.round(value * 10) / 10;

const DEFAULT_JITTER = 0.9;

function latticeNeighborDistance(sampling: string | undefined, spacing: number): number {
  const sqrt3 = Math.sqrt(3);
  const hexSide = Math.sqrt(2 / sqrt3);
  if (sampling === 'hexPointy' || sampling === 'hexFlat') return spacing * hexSide;
  if (sampling === 'triangle') return (spacing * Math.sqrt(4 / sqrt3)) / sqrt3;
  return spacing;
}

/**
 * 复刻 FMG `Pack.generate`：剔除深海点、沿岸补点，再由这些点重建 Voronoi。
 * 结果地块数量必须等于存档属性数组长度（本图 21,114）。
 */
function rebuildPackCells(
  grid: GridData,
  gridCells: VoronoiGraph,
  heights: Uint8Array,
  types: Int8Array,
  featureIds: Uint16Array,
  sampling?: string,
  jitter = DEFAULT_JITTER
) {
  const splitDistance = latticeNeighborDistance(sampling, grid.spacing) * (1 + (DEFAULT_JITTER - jitter));
  const spacing2 = splitDistance ** 2;
  const points: MapPoint[] = [];
  const parents: number[] = [];
  const cellHeights: number[] = [];

  for (let i = 0; i < grid.points.length; i++) {
    const height = heights[i];
    const type = types[i];

    if (height < SEA_LEVEL && type !== -1 && type !== -2) continue; // 深海点不要
    const feature = grid.features[featureIds[i]];
    if (type === -2 && (i % 4 === 0 || feature?.type === 'lake')) continue; // 非沿岸湖点

    const [x, y] = grid.points[i];
    points.push([x, y]);
    parents.push(i);
    cellHeights.push(height);

    // 海岸线沿途加密，让海岸与河口形状更细
    if (type === 1 || type === -1) {
      if (gridCells.cells.b[i]) continue;
      for (const neighbor of gridCells.cells.c[i]) {
        if (i > neighbor) continue;
        if (types[neighbor] !== type) continue;
        const dist2 = (y - grid.points[neighbor][1]) ** 2 + (x - grid.points[neighbor][0]) ** 2;
        if (dist2 < spacing2) continue;
        points.push([
          roundHalf((x + grid.points[neighbor][0]) / 2),
          roundHalf((y + grid.points[neighbor][1]) / 2),
        ]);
        parents.push(i);
        cellHeights.push(height);
      }
    }
  }

  return { points, parents, cellHeights };
}

// ---------------------------------------------------------------------------
// 对外：解析 + 加载
// ---------------------------------------------------------------------------

/** 解析 `.map` 文本（或 wenyouImageBase JSON 描述）为渲染所需的 `MapData`（纯函数，便于失败时定位） */
export function parseWorkingMap(text: string): MapData {
  if (isImageBaseSource(text)) {
    return buildImageHexMapData(parseImageBaseSpec(text));
  }
  // 对齐上游 FMG `src/services/io/load.ts`：数据段严格以 CRLF (\r\n) 分隔，
  // SVG 或地名库（nameBases）等单个数据段内部允许存在裸 LF (\n)；仅当整文件不含 CRLF 时退回按 LF 拆分。
  let normalized = text.replace(/^\uFEFF/, '');
  const svgBlock = normalized.match(/<svg[^>]*id="map"[\s\S]*?<\/svg>/)?.[0];
  if (svgBlock?.includes('\r\n')) {
    normalized = normalized.replace(svgBlock, svgBlock.replace(/\r\n/g, '\n'));
  }
  const lines = normalized.includes('\r\n') ? normalized.split('\r\n') : normalized.split('\n');
  if (lines.length < 8) throw new Error('[map-loader] 文件行数不足，不是 FMG 存档');

  const header = lines[0].split('|');
  const width = Math.round(Number(header[4]));
  const height = Math.round(Number(header[5]));
  const mapSeed = (header[3] ?? '').trim();
  const mapId = header[6]; // FMG 创建地图时的身份，重存与重命名不改变它
  if (!mapId || !mapSeed || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('[map-loader] 缺少有效的 FMG mapId、seed 或地图尺寸');
  }
  // 头部布局：v1.154+ 第 2 行是完整参数 JSON（坐标在 geography.coordinates、名称在 lore.name）；
  // 更早版本第 2 行是管道分隔选项（内嵌 options JSON，其后是地图名），第 3 行是坐标 JSON。
  let coords: MapCoords | null;
  let mapName: string;
  let sampling: string | undefined;
  let jitter = DEFAULT_JITTER;
  if ((lines[1] ?? '').startsWith('{')) {
    const params = JSON.parse(lines[1]) as {
      geography?: { coordinates?: MapCoords };
      lore?: { name?: string };
      graph?: { sampling?: string; jitter?: number };
    };
    coords = params.geography?.coordinates ?? null;
    mapName = params.lore?.name ?? '';
    sampling = params.graph?.sampling;
    if (typeof params.graph?.jitter === 'number' && Number.isFinite(params.graph.jitter)) {
      jitter = params.graph.jitter;
    }
  } else {
    coords = JSON.parse(lines[2]) as MapCoords;
    const optionsParts = lines[1].split('|');
    const jsonIndex = optionsParts.findIndex((part) => part.startsWith('{'));
    mapName = jsonIndex >= 0 ? optionsParts[jsonIndex + 1] : '';
  }

  // data[5] 是内嵌 SVG（多行），跳到网格 JSON 所在行，之后按固定顺序取数据段
  const gridIndex = lines.findIndex((line) => line.startsWith('{"spacing"'));
  if (gridIndex < 0) throw new Error('[map-loader] 找不到网格数据（grid JSON）');
  // SVG 内部可含 LF，但 FMG 的数据段只以 CRLF 分隔。
  const originalMap = [...lines.slice(0, 5), lines.slice(5, gridIndex).join('\n'), ...lines.slice(gridIndex)].join('\r\n');
  const rest = lines.slice(gridIndex);

  const grid = JSON.parse(rest[0]) as GridData;
  const heights = toUint8(rest[1]);
  const featureIds = toUint16(rest[3]);
  const types = toInt8(rest[4]);

  const gridCells = buildVoronoi(grid.points, grid.boundary);
  const pack = rebuildPackCells(grid, gridCells, heights, types, featureIds, grid.sampling ?? sampling, jitter);
  const packGraph = buildVoronoi(pack.points, grid.boundary);
  const count = pack.points.length;

  const storedStates = toUint16(rest[19]);
  const storedReligions = toUint16(rest[20]);
  const storedProvinces = toUint16(rest[21]);
  const storedRivers = toUint16(rest[16]);

  if (storedStates.length !== count) {
    console.warn(
      `[map-loader] 地块数与存档属性数组不一致：重建 ${count}，存档 ${storedStates.length}。属性按前 N 项对齐。`
    );
  }

  // 地块多边形：顶点按 Voronoi 顺序连成闭合多边形，并裁剪到画布范围
  const polygons: MapPoint[][] = new Array(count);
  for (let i = 0; i < count; i++) {
    const vertexIds = packGraph.cells.v[i] ?? [];
    const raw: MapPoint[] = new Array(vertexIds.length);
    for (let k = 0; k < vertexIds.length; k++) {
      const vertex = packGraph.vertices.p[vertexIds[k]] ?? [0, 0];
      raw[k] = [clampCoord(vertex[0], width), clampCoord(vertex[1], height)];
    }
    polygons[i] = raw.length >= 3 ? clipPolygonToRect(raw, -1, -1, width + 1, height + 1) : raw;
  }

  const neighbors: number[][] = new Array(count);
  for (let i = 0; i < count; i++) {
    const list = packGraph.cells.c[i] ?? [];
    neighbors[i] = list.filter((cellId) => cellId >= 0 && cellId < count);
  }

  const cells: MapData['cells'] = {
    count,
    polygons,
    p: pack.points,
    c: neighbors,
    h: Uint8Array.from(pack.cellHeights),
    state: fitToCells(storedStates, count, Uint16Array),
    province: fitToCells(storedProvinces, count, Uint16Array),
    religion: fitToCells(storedReligions, count, Uint16Array),
    r: fitToCells(storedRivers, count, Uint16Array),
    g: Uint32Array.from(pack.parents),
    fl: fitToCells(toUint16(rest[14]), count, Uint16Array),
    biome: fitToCells(toUint8(rest[10]), count, Uint8Array),
    t: Int8Array.from(pack.parents, (parent) => types[parent]),
  };

  // v1.139+ 第 4 行是生物群系 JSON 数组（i/name/color 字段）；更早版本是 `颜色,#,名称` 管道行
  let biomes: BiomeItem[];
  if ((lines[3] ?? '').startsWith('[')) {
    const rawBiomes = JSON.parse(lines[3]) as Array<{ i: number; name: string; color: string }>;
    biomes = rawBiomes.map((biome) => ({ i: Number(biome.i), name: String(biome.name), color: String(biome.color) }));
  } else {
    const [biomeColors, , biomeNames] = lines[3].split('|');
    const colors = biomeColors.split(',');
    biomes = biomeNames.split(',').map((name, i) => ({ i, name, color: colors[i] }));
  }
  const features = JSON.parse(rest[6]) as Array<{ i: number; type: string; vertices: number[] }>;
  const lakes: LakeFeature[] = features.filter((feature) => feature.type === 'lake').map((feature) => ({
    i: feature.i,
    polygon: clipPolygonToRect(feature.vertices.map((v) => packGraph.vertices.p[v]), 0, 0, width, height),
  }));
  const states = parseStates(rest[8], cells);
  const provinces = parseProvinces(rest[24], cells);

  const map: MapData = {
    source: { mapId: `${mapSeed}-${mapId}-${width}x${height}`, name: mapName || 'working-map', coords, originalMap, baseKind: 'fmg' },
    width,
    height,
    cells,
    states,
    provinces,
    religions: parseReligions(rest[23]),
    burgs: parseBurgs(rest[9], cells),
    rivers: parseRivers(rest[26]),
    biomes,
    lakes,
  };
  recomputeBurgTiers(map);
  return map;
}

function parseStates(source: string, cells: MapData['cells']): StateItem[] {
  const raw = JSON.parse(source) as Array<Record<string, any>>;
  const states: StateItem[] = raw.map((state, index) => {
    const i = Number(state?.i ?? index);
    const pole = state?.pole;
    return {
      i,
      name: state?.name || (i === 0 ? '中立地' : `势力 ${i}`),
      color: i === 0 ? '#c4c1b0' : normalizeColor(state?.color, i),
      center: typeof state?.center === 'number' ? state.center : undefined,
      capital: state.capital,
      pole: Array.isArray(pole) && pole.length === 2 && pole.every(Number.isFinite) && (pole[0] !== 0 || pole[1] !== 0)
        ? pole as MapPoint
        : cells.p[state.center],
      removed: Boolean(state?.removed),
    };
  });
  if (!states.length) states.push({ i: 0, name: '中立地', color: '#c4c1b0', removed: false });
  return states;
}

function parseProvinces(
  source: string,
  cells: MapData['cells']
): ProvinceItem[] {
  if (!source || !source.trim()) return [];
  const raw = JSON.parse(source) as Array<Record<string, any> | 0>;
  return raw.filter((p): p is Record<string, any> => !!p && !p.removed && p.i > 0).map((province) => {
    const pole = province.pole;
    const [x, y] = Array.isArray(pole) && pole.length === 2 && pole.every(Number.isFinite) && (pole[0] !== 0 || pole[1] !== 0)
      ? pole as MapPoint
      : cells.p[province.center];
    return {
    i: province.i,
    name: province.name,
    fullName: province.fullName,
    color: normalizeColor(province.color, province.i + 3, 58),
    state: province.state,
    centerCell: province.center,
    burg: Number(province.burg || 0),
    x,
    y,
    removed: false,
    };
  });
}

function parseReligions(source: string | undefined): ReligionItem[] {
  const raw = safeJson<Array<Record<string, any>>>(source, []);
  const religions = raw.map((religion, index) => {
    const i = Number(religion?.i ?? index);
    return {
      i,
      name: religion?.name || (i === 0 ? '无信仰' : `信仰 ${i}`),
      color: i === 0 ? '#c9c6bb' : normalizeColor(religion?.color, i + 7, 64),
      removed: Boolean(religion?.removed),
    };
  });
  if (!religions.length) religions.push({ i: 0, name: '无信仰', color: '#c9c6bb', removed: false });
  return religions;
}

function parseBurgs(source: string, cells: MapData['cells']): BurgItem[] {
  const raw = JSON.parse(source) as Array<Record<string, any>>;
  const burgs: BurgItem[] = [];
  raw.forEach((burg, index) => {
    if (!burg || typeof burg !== 'object' || burg.removed) return;
    const i = Number(burg.i ?? index);
    if (!i) return; // burg 0 是占位
    const cell = Number(burg.cell ?? 0);
    const x = Number(burg.x);
    const y = Number(burg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const stateFromCell = cell >= 0 && cell < cells.count ? cells.state[cell] : 0;
    burgs.push({
      i,
      name: burg.name || `聚落 ${i}`,
      x,
      y,
      cell: cell >= 0 && cell < cells.count ? cell : 0,
      state: Number(burg.state ?? stateFromCell ?? 0),
      province: cells.province[cell] || 0,
      capital: Number(burg.capital) === 1 ? 1 : 0,
      port: Number(burg.port || 0),
      tier: 'city', // parseWorkingMap 返回前统一按国家/省份首府引用重算
      population: Number(burg.population || 0),
      removed: Boolean(burg.removed),
    });
  });
  return burgs;
}

function parseRivers(source: string): RiverItem[] {
  if (!source || !source.trim()) return [];
  const raw = JSON.parse(source) as Array<Record<string, any>>;
  const rivers: RiverItem[] = [];
  raw.forEach((river, index) => {
    if (!river || !Array.isArray(river.cells) || river.cells.length < 2) return;
    rivers.push({
      i: Number(river.i ?? index),
      name: river.name || `河流 ${index}`,
      type: river.type,
      cells: river.cells.map((cellId: number) => Number(cellId)),
      points: river.points,
      width: Number(river.width),
      widthFactor: Number(river.widthFactor),
      sourceWidth: Number(river.sourceWidth),
      discharge: Number(river.discharge),
      parent: Number(river.parent),
      basin: Number(river.basin),
    });
  });
  return rivers;
}
