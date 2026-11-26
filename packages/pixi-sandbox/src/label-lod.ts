import { Container, Graphics, Text } from 'pixi.js';
import type { MapData, ViewMode } from './store';

/**
 * L 包独占：标签 8 方向候选槽位自动躲开、短引线与港口图标渲染
 *
 * - 8 方向候选槽位自动躲开（Multi-Position Label Dodging）：
 *   - 围绕城市圆点的 8 个第一圈候选方位（gap = markerRadius + 3.5px）
 *   - 4 个第二圈远距候选方位（gap = markerRadius + 11px，启用 hasLeader = true）
 *   - Level 1 / 2 / 3 均启用 SpatialGrid：
 *     1. 圆点障碍物先行入表（[sx - r - 2, sy - r - 2, sx + r + 2, sy + r + 2]）
 *     2. 高层级标签依次选位（国都 → 省首府 → 国名/省名）
 *     3. 普通城市按人口降序准入并避让；所有倍率均在无空位时隐藏文字，保留城市圆点
 *
 * - 偏移指示短引线（Leader Line）：
 *   - 选用远距槽位或存在位移的可见城市绘制 0.9 * invScale 引导细线
 *
 * - 港口城市角标（burg.port > 0）：
 *   - Level 2 和 Level 3 下，在圆点外围加绘青蓝海港光环与右下方海锚码头菱形角标
 *
 * - 字号随缩放放大（Zoom Font Boost）：
 *   - 全图视角（scale < 1.15）维持屏幕恒定字号，文字不变大、不糊屏
 *   - scale >= 1.15 起有效屏幕字号线性放大（画防线常用的 2.5~4 倍约 1.4~1.9 倍），5.76 封顶 2.4x
 *   - 标签纹理按封顶倍率超采样渲染，放大后文字边缘依然锐利
 */

interface StateLabelItem {
  id: number;
  text: Text;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BurgLabelItem {
  id: number;
  name: string;
  tier: 'capital' | 'provincial' | 'city';
  text: Text;
  x: number;
  y: number;
  population: number;
  port: number;
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  hasLeader: boolean;
}

interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  ownerId?: number;
  isCityMarker?: boolean;
}

interface CandidateSlot {
  name: string;
  offsetX: number;
  offsetY: number;
  hasLeader: boolean;
}

class SpatialGrid {
  private cellSize: number;
  private grid = new Map<string, AABB[]>();

  constructor(cellSize = 80) {
    this.cellSize = cellSize;
  }

  clear(): void {
    this.grid.clear();
  }

  insert(box: AABB): void {
    const minCx = Math.floor(box.minX / this.cellSize);
    const maxCx = Math.floor(box.maxX / this.cellSize);
    const minCy = Math.floor(box.minY / this.cellSize);
    const maxCy = Math.floor(box.maxY / this.cellSize);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const key = `${cx},${cy}`;
        const list = this.grid.get(key);
        if (list) {
          list.push(box);
        } else {
          this.grid.set(key, [box]);
        }
      }
    }
  }

  collides(box: AABB, ignoreOwnerId?: number, ignoreCityMarkers = false): boolean {
    const minCx = Math.floor(box.minX / this.cellSize);
    const maxCx = Math.floor(box.maxX / this.cellSize);
    const minCy = Math.floor(box.minY / this.cellSize);
    const maxCy = Math.floor(box.maxY / this.cellSize);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const list = this.grid.get(`${cx},${cy}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const other = list[i];
          if (ignoreCityMarkers && other.isCityMarker) {
            continue;
          }
          if (ignoreOwnerId !== undefined && other.ownerId !== undefined && other.ownerId === ignoreOwnerId) {
            continue;
          }
          if (
            box.minX < other.maxX &&
            box.maxX > other.minX &&
            box.minY < other.maxY &&
            box.maxY > other.minY
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

}

// 围绕圆点的 12 个候选槽位（8 个第一圈 + 4 个第二圈）
function getCandidateSlots(
  width: number,
  height: number,
  markerRadius: number
): CandidateSlot[] {
  const gap1 = markerRadius + 3.5;
  const gap2 = markerRadius + 11.0;
  const diag = gap1 * 0.7071;
  const hw = width * 0.5;
  const hh = height * 0.5;

  return [
    // 1. 正上 N (默认首选，无引线)
    { name: 'N', offsetX: 0, offsetY: -(gap1 + hh), hasLeader: false },
    // 2. 正下 S (无引线)
    { name: 'S', offsetX: 0, offsetY: +(gap1 + hh), hasLeader: false },
    // 3. 正右 E (无引线)
    { name: 'E', offsetX: +(gap1 + hw), offsetY: 0, hasLeader: false },
    // 4. 正左 W (无引线)
    { name: 'W', offsetX: -(gap1 + hw), offsetY: 0, hasLeader: false },
    // 5. 右上 NE (无引线)
    { name: 'NE', offsetX: +(diag + hw), offsetY: -(diag + hh), hasLeader: false },
    // 6. 左上 NW (无引线)
    { name: 'NW', offsetX: -(diag + hw), offsetY: -(diag + hh), hasLeader: false },
    // 7. 右下 SE (无引线)
    { name: 'SE', offsetX: +(diag + hw), offsetY: +(diag + hh), hasLeader: false },
    // 8. 左下 SW (无引线)
    { name: 'SW', offsetX: -(diag + hw), offsetY: +(diag + hh), hasLeader: false },
    // 9. 远上 N2 (带短引线)
    { name: 'N2', offsetX: 0, offsetY: -(gap2 + hh), hasLeader: true },
    // 10. 远下 S2 (带短引线)
    { name: 'S2', offsetX: 0, offsetY: +(gap2 + hh), hasLeader: true },
    // 11. 远右 E2 (带短引线)
    { name: 'E2', offsetX: +(gap2 + hw), offsetY: 0, hasLeader: true },
    // 12. 远左 W2 (带短引线)
    { name: 'W2', offsetX: -(gap2 + hw), offsetY: 0, hasLeader: true },
  ];
}

// 国名/省名避让候选偏移（以 18px、32px 步长及多方位探测）
const REGION_OFFSETS: [number, number][] = [
  [0, 0],
  [0, 18], [0, -18], [18, 0], [-18, 0],
  [0, 32], [0, -32], [32, 0], [-32, 0],
  [0, 48], [0, -48], [48, 0], [-48, 0],
  [0, 64], [0, -64], [64, 0], [-64, 0],
  [18, 18], [-18, 18], [18, -18], [-18, -18],
  [32, 32], [-32, 32], [32, -32], [-32, -32],
  [48, 32], [-48, 32], [48, -32], [-48, -32],
  [0, 80], [0, -80], [80, 0], [-80, 0],
];

// 模块级缓存
let stateLabels: StateLabelItem[] = [];
let provinceLabels: StateLabelItem[] = [];
let capitalBurgs: BurgLabelItem[] = [];
let provincialBurgs: BurgLabelItem[] = [];
let cityBurgs: BurgLabelItem[] = []; // 按 population 降序预排

const spatialGrid = new SpatialGrid(80);

let lastScale = -1;
let lastViewMode: ViewMode | null = null;
let lastCityScale = 1;
let lastCityZoomBoost = true;
let lastCityDynamicLod = true;

export interface LabelLodOptions {
  /** 城市名手动缩放倍率（0.5 ~ 2.4，仅影响城市名，不动国名/省名） */
  cityScale?: number;
  /** 是否开启城市名字号随视口缩放动态放大，默认 true */
  cityZoomBoost?: boolean;
  /** 是否开启城市名按缩放倍率分级显隐与避让，默认 true */
  cityDynamicLod?: boolean;
}

// 标签屏幕字号随缩放放大：从 Level 2 起点（1.15）线性增长，5.76 封顶 2.4x。
// 画防线常用的 2.5~4 倍区间即可读到 1.4~1.9 倍字号；全图视角（< 1.15）维持 1x。
const LABEL_BOOST_MAX = 2.4;

// 标签纹理超采样倍率：保证手动调大或缩放放大到高倍率时文字边缘依然锐利
const LABEL_TEXTURE_RESOLUTION = 3;

export function clearMapLabels(labelLayer: Container, burgMarkers: Graphics): void {
  labelLayer.removeChildren().forEach((child) => child.destroy());
  burgMarkers.clear();
  stateLabels = [];
  provinceLabels = [];
  capitalBurgs = [];
  provincialBurgs = [];
  cityBurgs = [];
  lastScale = -1;
  lastViewMode = null;
}

function labelBoost(scale: number): number {
  if (scale < 1.15) return 1;
  return Math.min(LABEL_BOOST_MAX, 1 + ((scale - 1.15) / (5.76 - 1.15)) * (LABEL_BOOST_MAX - 1));
}

function estimateTextDimensions(
  text: string,
  fontSize: number,
  letterSpacing = 0,
  strokeWidth = 0
): { width: number; height: number } {
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      code >= 0x2e80 ||
      (code >= 0x2000 && code <= 0x206f) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      width += fontSize;
    } else {
      width += fontSize * 0.58;
    }
  }
  if (text.length > 1) {
    width += (text.length - 1) * letterSpacing;
  }
  width += strokeWidth;
  const height = fontSize * 1.25 + strokeWidth;
  return { width: Math.max(width, fontSize), height };
}

/** 绘制从圆点边缘到文字框最近点的指示短引线（文字框按 boost 放大后计） */
function drawLeaderLine(
  burgMarkers: Graphics,
  item: BurgLabelItem,
  markerRadius: number,
  invScale: number,
  boost: number
): void {
  const hw = item.width * boost * 0.5 * invScale;
  const hh = item.height * boost * 0.5 * invScale;
  const cx = item.text.position.x;
  const cy = item.text.position.y;
  const bx1 = cx - hw;
  const bx2 = cx + hw;
  const by1 = cy - hh;
  const by2 = cy + hh;

  const targetX = Math.max(bx1, Math.min(bx2, item.x));
  const targetY = Math.max(by1, Math.min(by2, item.y));

  const dx = targetX - item.x;
  const dy = targetY - item.y;
  const dist = Math.hypot(dx, dy);
  const r = markerRadius * invScale;

  if (dist > r) {
    const startX = item.x + (dx / dist) * r;
    const startY = item.y + (dy / dist) * r;
    burgMarkers
      .moveTo(startX, startY)
      .lineTo(targetX, targetY)
      .stroke({ width: 0.9 * invScale, color: '#334155', alpha: 0.75 });
  }
}

/** 绘制港口城市专属青蓝海港光环与右下方海锚码头菱形角标 */
function drawPortMarker(
  burgMarkers: Graphics,
  x: number,
  y: number,
  markerRadius: number,
  invScale: number
): void {
  // 1. 青蓝色海港光环
  burgMarkers
    .circle(x, y, (markerRadius + 2.2) * invScale)
    .stroke({ color: '#0284c7', width: 1.1 * invScale });

  // 2. 右下方青蓝海锚/码头菱形角标
  const offset = (markerRadius + 3.2) * 0.7071 * invScale;
  const bx = x + offset;
  const by = y + offset;
  const size = 1.8 * invScale;
  burgMarkers
    .poly([bx, by - size, bx + size, by, bx, by + size, bx - size, by])
    .fill({ color: '#0284c7' });
}

/** 地图加载或实体变更时重建国名、省名、三级城市文本对象 */
export function rebuildMapLabels(
  labelLayer: Container,
  burgMarkers: Graphics,
  map: MapData
): void {
  labelLayer.removeChildren().forEach((child) => child.destroy());
  burgMarkers.clear();

  stateLabels = [];
  provinceLabels = [];
  capitalBurgs = [];
  provincialBurgs = [];
  cityBurgs = [];

  lastScale = -1;
  lastViewMode = null;

  // 1. 创建国名文本（16px 加粗衬线体，深色字配浅色宽描边，锚定于 state.pole）
  for (let i = 0; i < map.states.length; i++) {
    const state = map.states[i];
    if (state.i <= 0 || state.removed || !state.name || !state.pole) continue;

    const [x, y] = state.pole;
    const text = new Text({
      text: state.name,
      style: {
        fontFamily: '"Cinzel", "Noto Serif SC", "Songti SC", "SimSun", serif',
        fontSize: 16,
        fontWeight: 'bold',
        fill: '#0f172a',
        stroke: { color: '#f8fafc', width: 3.5 },
        letterSpacing: 1.5,
      },
      resolution: LABEL_TEXTURE_RESOLUTION,
    });
    text.anchor.set(0.5, 0.5);
    text.position.set(x, y);

    const dims = estimateTextDimensions(state.name, 16, 1.5, 3.5);
    stateLabels.push({
      id: state.i,
      text,
      x,
      y,
      width: dims.width,
      height: dims.height,
    });
  }

  // 2. 创建省名文本（13px 半粗体，在 province 视图下显示）
  for (let i = 0; i < map.provinces.length; i++) {
    const province = map.provinces[i];
    if (province.i <= 0 || province.removed || !province.name) continue;

    const x = province.x;
    const y = province.y;
    const text = new Text({
      text: province.name,
      style: {
        fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
        fontSize: 13,
        fontWeight: '600',
        fill: '#1e293b',
        stroke: { color: '#ffffff', width: 2.5 },
        letterSpacing: 0.8,
      },
      resolution: LABEL_TEXTURE_RESOLUTION,
    });
    text.anchor.set(0.5, 0.5);
    text.position.set(x, y);

    const dims = estimateTextDimensions(province.name, 13, 0.8, 2.5);
    provinceLabels.push({
      id: province.i,
      text,
      x,
      y,
      width: dims.width,
      height: dims.height,
    });
  }

  // 3. 创建城市文本：按普通城市、省首府、国家首都归类
  const tempCityBurgs: BurgLabelItem[] = [];

  for (let i = 0; i < map.burgs.length; i++) {
    const burg = map.burgs[i];
    if (burg.removed || !burg.name) continue;

    const port = burg.port || 0;

    if (burg.tier === 'city') {
      const text = new Text({
        text: burg.name,
        style: {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: 9.5,
          fontWeight: 'normal',
          fill: '#334155',
          stroke: { color: '#ffffff', width: 2 },
        },
        resolution: LABEL_TEXTURE_RESOLUTION,
      });
      text.anchor.set(0.5, 0.5);
      text.position.set(burg.x, burg.y);

      const dims = estimateTextDimensions(burg.name, 9.5, 0, 2);
      tempCityBurgs.push({
        id: burg.i,
        name: burg.name,
        tier: burg.tier,
        text,
        x: burg.x,
        y: burg.y,
        population: burg.population,
        port,
        width: dims.width,
        height: dims.height,
        offsetX: 0,
        offsetY: 0,
        hasLeader: false,
      });
    } else if (burg.tier === 'provincial') {
      const text = new Text({
        text: burg.name,
        style: {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: 11,
          fontWeight: '600',
          fill: '#0f172a',
          stroke: { color: '#ffffff', width: 2.5 },
          letterSpacing: 0.3,
        },
        resolution: LABEL_TEXTURE_RESOLUTION,
      });
      text.anchor.set(0.5, 0.5);
      text.position.set(burg.x, burg.y);

      const dims = estimateTextDimensions(burg.name, 11, 0.3, 2.5);
      provincialBurgs.push({
        id: burg.i,
        name: burg.name,
        tier: burg.tier,
        text,
        x: burg.x,
        y: burg.y,
        population: burg.population,
        port,
        width: dims.width,
        height: dims.height,
        offsetX: 0,
        offsetY: 0,
        hasLeader: false,
      });
    } else {
      // capital
      const text = new Text({
        text: burg.name,
        style: {
          fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif',
          fontSize: 12.5,
          fontWeight: 'bold',
          fill: '#111827',
          stroke: { color: '#fef3c7', width: 3 },
          letterSpacing: 0.5,
        },
        resolution: LABEL_TEXTURE_RESOLUTION,
      });
      text.anchor.set(0.5, 0.5);
      text.position.set(burg.x, burg.y);

      const dims = estimateTextDimensions(burg.name, 12.5, 0.5, 3);
      capitalBurgs.push({
        id: burg.i,
        name: burg.name,
        tier: burg.tier,
        text,
        x: burg.x,
        y: burg.y,
        population: burg.population,
        port,
        width: dims.width,
        height: dims.height,
        offsetX: 0,
        offsetY: 0,
        hasLeader: false,
      });
    }
  }

  // 普通城市按人口降序预排序
  tempCityBurgs.sort((a, b) => b.population - a.population);
  cityBurgs = tempCityBurgs;

  // 严格按层级自底向上加入 labelLayer：国名 → 省名 → 普通城市 → 省首府 → 国家首都
  for (let i = 0; i < stateLabels.length; i++) {
    labelLayer.addChild(stateLabels[i].text);
  }
  for (let i = 0; i < provinceLabels.length; i++) {
    labelLayer.addChild(provinceLabels[i].text);
  }
  for (let i = 0; i < cityBurgs.length; i++) {
    labelLayer.addChild(cityBurgs[i].text);
  }
  for (let i = 0; i < provincialBurgs.length; i++) {
    labelLayer.addChild(provincialBurgs[i].text);
  }
  for (let i = 0; i < capitalBurgs.length; i++) {
    labelLayer.addChild(capitalBurgs[i].text);
  }
}

/** 每帧或视口缩放时，执行 8 方向候选槽位自动躲开、高层级避让、引线与圆点/海港渲染 */
export function updateLabelLod(
  burgMarkers: Graphics,
  viewMode: ViewMode,
  scale: number,
  force?: boolean,
  options?: LabelLodOptions
): void {
  const cityScale = Math.max(0.5, Math.min(2.4, options?.cityScale ?? 1));
  const cityZoomBoost = options?.cityZoomBoost ?? true;
  const cityDynamicLod = options?.cityDynamicLod ?? true;

  const scaleDiff = Math.abs(scale - lastScale);
  if (
    force !== true &&
    lastViewMode === viewMode &&
    scaleDiff <= 0.01 &&
    Math.abs(cityScale - lastCityScale) <= 0.001 &&
    cityZoomBoost === lastCityZoomBoost &&
    cityDynamicLod === lastCityDynamicLod
  ) {
    return;
  }

  lastScale = scale;
  lastViewMode = viewMode;
  lastCityScale = cityScale;
  lastCityZoomBoost = cityZoomBoost;
  lastCityDynamicLod = cityDynamicLod;

  const safeScale = Math.max(0.01, scale);
  const invScale = 1 / safeScale;
  // 国名/省名维持既有放大曲线，不受城市名手动滑块与城市动态开关影响
  const regionBoost = labelBoost(safeScale);
  // 城市名可独立关闭“随缩放变大”并叠加上手动缩放倍率
  const cityZoomFactor = cityZoomBoost ? regionBoost : 1;
  const cityBoost = cityZoomFactor * cityScale;
  const markerBoost = cityZoomFactor * Math.min(1.4, Math.max(0.75, cityScale));

  // 三档缩放阈值
  const isLevel1 = safeScale < 1.15;
  const isLevel2 = safeScale >= 1.15 && safeScale < 2.2;
  const isLevel3 = safeScale >= 2.2;

  // 无论 Level 1、2、3，均启用 SpatialGrid 进行多方位避让与防遮挡
  spatialGrid.clear();

  // --- 第一步：圆点障碍物先行入表 ---
  // 开启分级显示时：Level 1 仅国家首都圆点可见，Level 2/3 所有城市圆点可见；
  // 关闭分级显示时：全倍率均显示全部城市，圆点障碍物只将首都/省府入表供国名/省名避让
  for (let i = 0; i < capitalBurgs.length; i++) {
    const item = capitalBurgs[i];
    const sx = item.x * safeScale;
    const sy = item.y * safeScale;
    const r = 4.2 * markerBoost;
    spatialGrid.insert({
      minX: sx - r - 2,
      maxX: sx + r + 2,
      minY: sy - r - 2,
      maxY: sy + r + 2,
      ownerId: item.id,
    });
  }

  if (!cityDynamicLod || !isLevel1) {
    for (let i = 0; i < provincialBurgs.length; i++) {
      const item = provincialBurgs[i];
      const sx = item.x * safeScale;
      const sy = item.y * safeScale;
      const r = 3.0 * markerBoost;
      spatialGrid.insert({
        minX: sx - r - 2,
        maxX: sx + r + 2,
        minY: sy - r - 2,
        maxY: sy + r + 2,
        ownerId: item.id,
      });
    }

    if (cityDynamicLod) {
      const cityR = (isLevel3 ? 1.5 : 1.2) * markerBoost;
      for (let i = 0; i < cityBurgs.length; i++) {
        const item = cityBurgs[i];
        const sx = item.x * safeScale;
        const sy = item.y * safeScale;
        spatialGrid.insert({
          minX: sx - cityR - 2,
          maxX: sx + cityR + 2,
          minY: sy - cityR - 2,
          maxY: sy + cityR + 2,
          ownerId: item.id,
          isCityMarker: true,
        });
      }
    }
  }

  // 高层级标签按国都 → 省府 → 国名 → 省名的顺序选位。
  function placeBurgLabels(items: BurgLabelItem[], visible: boolean, radius: number, skipAvoidance = false): void {
    for (const item of items) {
      item.text.visible = visible;
      if (!visible) { item.hasLeader = false; continue; }
      item.text.scale.set(invScale * cityBoost);
      if (skipAvoidance) {
        const offsetY = -(radius * markerBoost + 3.5 + item.height * cityBoost * 0.5);
        item.text.position.set(item.x, item.y + offsetY * invScale);
        item.offsetX = 0;
        item.offsetY = offsetY;
        item.hasLeader = false;
        continue;
      }
      const sx = item.x * safeScale;
      const sy = item.y * safeScale;
      const slots = getCandidateSlots(item.width * cityBoost, item.height * cityBoost, radius * markerBoost);
      const boxAt = (slot: CandidateSlot): AABB => ({
        minX: sx + slot.offsetX - item.width * cityBoost * 0.5 - 2,
        maxX: sx + slot.offsetX + item.width * cityBoost * 0.5 + 2,
        minY: sy + slot.offsetY - item.height * cityBoost * 0.5 - 2,
        maxY: sy + slot.offsetY + item.height * cityBoost * 0.5 + 2,
        ownerId: item.id,
      });
      const available = slots.find(slot => !spatialGrid.collides(boxAt(slot), item.id));
      // 首都和省府常驻；无空位时沿用第一槽位且不画引线。
      const slot = available ?? slots[0];
      item.text.position.set(item.x + slot.offsetX * invScale, item.y + slot.offsetY * invScale);
      item.offsetX = slot.offsetX;
      item.offsetY = slot.offsetY;
      item.hasLeader = available === undefined ? false : slot.hasLeader;
      spatialGrid.insert(boxAt(slot));
    }
  }
  function placeRegionLabels(items: StateLabelItem[], visible: boolean, padding: number): void {
    for (const item of items) {
      item.text.visible = visible;
      if (!visible) continue;
      item.text.scale.set(invScale * regionBoost);
      const sx = item.x * safeScale;
      const sy = item.y * safeScale;
      const boxAt = (dx: number, dy: number): AABB => ({
        minX: sx + dx - item.width * regionBoost * 0.5 - padding,
        maxX: sx + dx + item.width * regionBoost * 0.5 + padding,
        minY: sy + dy - item.height * regionBoost * 0.5 - padding,
        maxY: sy + dy + item.height * regionBoost * 0.5 + padding,
      });
      const [dx, dy] = REGION_OFFSETS.find(([x, y]) => !spatialGrid.collides(boxAt(x, y), undefined, true)) ?? [0, 0];
      item.text.position.set(item.x + dx * invScale, item.y + dy * invScale);
      spatialGrid.insert(boxAt(dx, dy));
    }
  }
  placeBurgLabels(capitalBurgs, true, 4.2, !cityDynamicLod);
  placeBurgLabels(provincialBurgs, !cityDynamicLod || !isLevel1, 3.0, !cityDynamicLod);
  for (const item of stateLabels) item.text.alpha = isLevel1 ? 1.0 : 0.35;
  placeRegionLabels(stateLabels, true, 4);
  placeRegionLabels(provinceLabels, !isLevel1 && viewMode === 'province', 3);

  // --- 第三步：普通城市（cityBurgs）分级准入、屏幕保护间距与多方位避让 ---
  if (!cityDynamicLod) {
    // 关闭按缩放分级显示：所有普通城市在任意倍率直接常驻显示，不再按倍率或密度筛除
    placeBurgLabels(cityBurgs, true, 1.5, true);
  } else if (!isLevel3) {
    for (let i = 0; i < cityBurgs.length; i++) {
      cityBurgs[i].text.visible = false;
      cityBurgs[i].hasLeader = false;
    }
  } else {
    // 放大后仍按屏幕距离和文字框避让，不再强制显示挤不下的城市名。
    const isMacroMedium = safeScale < 3.2; // 宏观中观多国/大帝国视角（用户主要反馈区间）

    // 准入数量阶梯：宏观视角取前 12%~24% 核心骨干城市；战术视角扩展到 24%~70%
    const eligibleRatio = Math.min(1, isMacroMedium
      ? 0.12 + ((safeScale - 2.2) / 1.0) * 0.12
      : 0.24 + ((safeScale - 3.2) / 1.3) * 0.46);
    const eligibleCount = Math.min(cityBurgs.length, Math.max(16, Math.round(cityBurgs.length * eligibleRatio)));

    // 屏幕空间最小保护中心距离（像素）：宏观视角 56px，战术视角 36px，彻底根除字贴字扎堆
    const minScreenDist = isMacroMedium ? 56 : 36;
    const minScreenDistSq = minScreenDist * minScreenDist;

    // 标签呼吸内边距（Padding）：提供充裕留白，避免 2px 贴脸
    const padX = isMacroMedium ? 7.0 : 4.5;
    const padY = isMacroMedium ? 4.5 : 3.0;

    // 记录所有已成功显示标签（含首都、省首府及已放普通城市）的屏幕中心坐标
    const placedCenters: [number, number][] = [];
    for (let i = 0; i < capitalBurgs.length; i++) {
      if (capitalBurgs[i].text.visible) {
        placedCenters.push([capitalBurgs[i].x * safeScale, capitalBurgs[i].y * safeScale]);
      }
    }
    for (let i = 0; i < provincialBurgs.length; i++) {
      if (provincialBurgs[i].text.visible) {
        placedCenters.push([provincialBurgs[i].x * safeScale, provincialBurgs[i].y * safeScale]);
      }
    }

    for (let i = 0; i < cityBurgs.length; i++) {
      const item = cityBurgs[i];
      if (i >= eligibleCount) {
        item.text.visible = false;
        item.hasLeader = false;
        continue;
      }

      const sx = item.x * safeScale;
      const sy = item.y * safeScale;

      // 屏幕空间最小距离过滤：若与任意已放城市距离过近，直接跳过文字显示
      let tooClose = false;
      for (let p = 0; p < placedCenters.length; p++) {
        const dx = sx - placedCenters[p][0];
        const dy = sy - placedCenters[p][1];
        if (dx * dx + dy * dy < minScreenDistSq) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) {
        item.text.visible = false;
        item.hasLeader = false;
        continue;
      }

      const allSlots = getCandidateSlots(item.width * cityBoost, item.height * cityBoost, 1.5 * markerBoost);
      // 宏观中观视角仅尝试第一圈 8 方位（无引线），战术视角允许使用第二圈 4 方位
      const slots = isMacroMedium ? allSlots.slice(0, 8) : allSlots;
      let placed = false;

      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s];
        const box: AABB = {
          minX: sx + slot.offsetX - item.width * cityBoost * 0.5 - padX,
          maxX: sx + slot.offsetX + item.width * cityBoost * 0.5 + padX,
          minY: sy + slot.offsetY - item.height * cityBoost * 0.5 - padY,
          maxY: sy + slot.offsetY + item.height * cityBoost * 0.5 + padY,
          ownerId: item.id,
        };
        if (!spatialGrid.collides(box, item.id)) {
          item.text.visible = true;
          item.text.scale.set(invScale * cityBoost);
          item.text.position.set(item.x + slot.offsetX * invScale, item.y + slot.offsetY * invScale);
          item.offsetX = slot.offsetX;
          item.offsetY = slot.offsetY;
          item.hasLeader = slot.hasLeader;
          spatialGrid.insert(box);
          placedCenters.push([sx, sy]);
          placed = true;
          break;
        }
      }

      if (!placed) {
        item.text.visible = false;
        item.hasLeader = false;
      }
    }
  }

  // --- 第四步：城市圆点（burgMarkers）、短引线与港口图标绘制 ---
  burgMarkers.clear();

  // 1. 绘制短引线（对选用远距槽位且可见的城市标签）
  for (let i = 0; i < capitalBurgs.length; i++) {
    const item = capitalBurgs[i];
    if (item.text.visible && item.hasLeader) {
      drawLeaderLine(burgMarkers, item, 4.2 * markerBoost, invScale, cityBoost);
    }
  }
  for (let i = 0; i < provincialBurgs.length; i++) {
    const item = provincialBurgs[i];
    if (item.text.visible && item.hasLeader) {
      drawLeaderLine(burgMarkers, item, 3.0 * markerBoost, invScale, cityBoost);
    }
  }
  if (cityDynamicLod && isLevel3) {
    for (let i = 0; i < cityBurgs.length; i++) {
      const item = cityBurgs[i];
      if (item.text.visible && item.hasLeader) {
        drawLeaderLine(burgMarkers, item, 1.5 * markerBoost, invScale, cityBoost);
      }
    }
  }

  // 城市先画，省府与首都依次覆盖在上方；各倍率共用同一绘制逻辑。
  if (!cityDynamicLod) {
    for (let i = 0; i < cityBurgs.length; i++) {
      burgMarkers.circle(cityBurgs[i].x, cityBurgs[i].y, 1.4 * markerBoost * invScale);
    }
    burgMarkers.fill({ color: '#475569', alpha: 0.85 }).stroke({ color: '#ffffff', width: 0.6 * invScale });
  } else if (isLevel2) {
    // a. 普通城市微弱小点（屏幕半径 1.0px × markerBoost，透明度 0.40，无白边）
    for (let i = 0; i < cityBurgs.length; i++) {
      burgMarkers.circle(cityBurgs[i].x, cityBurgs[i].y, 1.0 * markerBoost * invScale);
    }
    burgMarkers.fill({ color: '#64748b', alpha: 0.40 });

  } else if (isLevel3) {
    // a. 普通城市分层绘制：文字可见的重点城市绘制清晰圆点；文字隐藏的次要小城市按阶梯柔和绘制
    if (safeScale >= 4.5) {
      for (let i = 0; i < cityBurgs.length; i++) {
        burgMarkers.circle(cityBurgs[i].x, cityBurgs[i].y, 1.5 * markerBoost * invScale);
      }
      burgMarkers.fill({ color: '#475569', alpha: 0.85 }).stroke({ color: '#ffffff', width: 0.6 * invScale });
    } else {
      // 次要小城市（无文字）：柔和不扎眼
      const minorR = (safeScale < 3.2 ? 1.0 : 1.2) * markerBoost * invScale;
      const minorAlpha = safeScale < 3.2 ? 0.35 : 0.55;
      for (let i = 0; i < cityBurgs.length; i++) {
        if (!cityBurgs[i].text.visible) {
          burgMarkers.circle(cityBurgs[i].x, cityBurgs[i].y, minorR);
        }
      }
      burgMarkers.fill({ color: '#64748b', alpha: minorAlpha });

      // 骨干可见城市：清晰带白边
      for (let i = 0; i < cityBurgs.length; i++) {
        if (cityBurgs[i].text.visible) {
          burgMarkers.circle(cityBurgs[i].x, cityBurgs[i].y, 1.5 * markerBoost * invScale);
        }
      }
      burgMarkers.fill({ color: '#475569', alpha: 0.85 }).stroke({ color: '#ffffff', width: 0.6 * invScale });
    }

  }
  if (!cityDynamicLod || !isLevel1) {
    for (let i = 0; i < provincialBurgs.length; i++) {
      const burg = provincialBurgs[i];
      burgMarkers
        .circle(burg.x, burg.y, 3.0 * markerBoost * invScale)
        .fill({ color: '#2563eb' })
        .stroke({ color: '#ffffff', width: 1.0 * invScale });
      burgMarkers.circle(burg.x, burg.y, 1.3 * markerBoost * invScale).fill({ color: '#ffffff' });
    }

  }
  for (let i = 0; i < capitalBurgs.length; i++) {
    const burg = capitalBurgs[i];
    burgMarkers
      .circle(burg.x, burg.y, 4.2 * markerBoost * invScale)
      .fill({ color: '#f59e0b' })
      .stroke({ color: '#78350f', width: 1.2 * invScale });
    burgMarkers.circle(burg.x, burg.y, 2.0 * markerBoost * invScale).fill({ color: '#fef3c7' });
  }

  // 3. Level 2 和 Level 3（或关闭分级显示时），为港口城市加绘海港光环与右下方海锚菱形角标
  if (!cityDynamicLod || !isLevel1) {
    for (let i = 0; i < capitalBurgs.length; i++) {
      const b = capitalBurgs[i];
      if (b.port > 0) {
        drawPortMarker(burgMarkers, b.x, b.y, 4.2 * markerBoost, invScale);
      }
    }
    for (let i = 0; i < provincialBurgs.length; i++) {
      const b = provincialBurgs[i];
      if (b.port > 0) {
        drawPortMarker(burgMarkers, b.x, b.y, 3.0 * markerBoost, invScale);
      }
    }
    const cityR = (!cityDynamicLod ? 1.4 : isLevel3 ? 1.5 : 1.2) * markerBoost;
    for (let i = 0; i < cityBurgs.length; i++) {
      const b = cityBurgs[i];
      // 普通城市港口：仅当标签可见或在战术大倍率下绘制角标，避免宏观悬浮
      if (b.port > 0 && (b.text.visible || safeScale >= 4.5)) {
        drawPortMarker(burgMarkers, b.x, b.y, cityR, invScale);
      }
    }
  }
}
