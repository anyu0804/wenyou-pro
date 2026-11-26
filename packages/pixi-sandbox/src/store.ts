import { Container } from 'pixi.js';
import type { FieldBattle, FieldBattleChange, ViewportChanged } from './field-battle-types';
import type {
  BadgeCultureStyle,
  BattleEditReceipt,
  BattleState,
  BattleUnit,
  CustomBadgeConfig,
  EchelonSymbolCode,
  EchelonTierName,
  EchelonTierSpec,
} from './battle-contract';

export type {
  BadgeCultureStyle,
  CustomBadgeConfig,
  EchelonSymbolCode,
  EchelonTierName,
  EchelonTierSpec,
};

export type ViewMode = 'terrain' | 'biome' | 'state' | 'province' | 'religion';
export type BurgTier = 'capital' | 'provincial' | 'city';
export type GarrisonBadgeStyle = 'standard' | 'compact' | 'minimal';

export interface BiomeItem {
  i: number;
  name: string;
  color: string;
}

export interface LakeFeature {
  i: number;
  polygon: [number, number][];
}
export type InteractionMode =
  | 'pan'
  | 'brush-height'
  | 'brush-state'
  | 'brush-province'
  | 'brush-religion'
  | 'burg-edit'
  | 'retouch-erase'
  | 'retouch-pick'
  | 'tactical-frontline'
  | 'tactical-arrow'
  | 'tactical-measure'
  | 'tactical-select'
  | 'battle-select'
  | 'battle-draw'
  | 'fieldbattle-paint';

export interface RetouchStroke {
  id: string;
  color: string;
  width: number;
  points: [number, number][];
}

export interface StateItem {
  i: number;
  name: string;
  color: string;
  center?: number;
  capital?: number;
  pole?: [number, number];
  removed?: boolean;
}

export interface ProvinceItem {
  i: number;
  name: string;
  fullName?: string;
  color: string;
  state: number;
  centerCell: number;
  burg: number;
  x: number;
  y: number;
  removed?: boolean;
}

export interface ReligionItem {
  i: number;
  name: string;
  color: string;
  removed?: boolean;
}

export interface BurgItem {
  i: number;
  name: string;
  x: number;
  y: number;
  cell: number;
  state: number;
  province: number;
  capital: number;
  port: number;
  tier: BurgTier;
  population: number;
  removed?: boolean;
}

export interface RiverItem {
  i: number;
  name: string;
  type: string;
  cells: number[];
  points?: [number, number][];
  width: number;
  widthFactor: number;
  sourceWidth: number;
  discharge: number;
  parent: number;
  basin: number;
}

export interface TacticalItem {
  id: string;
  type: 'frontline' | 'arrow';
  points: [number, number][];
  color: string;
  width: number;
  label?: string;
  flipSide?: boolean;
  toothStyle?: 'sawtooth' | 'semicircle';
  arrowStyle?: 'solid' | 'dashed' | 'double-retreat';
}

export interface GarrisonUnit {
  id: string;
  provinceId: number;
  unitName: string;
  troops: number;
  color: string;
  status: '驻防' | '行军' | '被围';
  x?: number;
  y?: number;
  customBadge?: CustomBadgeConfig;
}

export interface MapData {
  source: {
    mapId: string;
    name: string;
    coords: { latT: number; latN: number; latS: number; lonT: number; lonW: number; lonE: number } | null;
    /** 完整 FMG 数据段或 wenyouImageBase JSON 描述头；渲染模型之外的信息在此保留。 */
    originalMap?: string;
    baseKind?: 'fmg' | 'image';
    imageUrl?: string;
    imageRelPath?: string;
    hexRadius?: number;
    kmPerPixel?: number;
    mapWidthKm?: number;
    overlayAlpha?: number;
    retouchStrokes?: RetouchStroke[];
  };
  width: number;
  height: number;
  cells: {
    count: number;
    polygons: [number, number][][];
    p: [number, number][];
    c: number[][];
    h: Uint8Array;
    state: Uint16Array;
    province: Uint16Array;
    religion: Uint16Array;
    r: Uint16Array;
    g: Uint32Array;
    fl: Uint16Array;
    biome: Uint8Array;
    t: Int8Array;
  };
  states: StateItem[];
  provinces: ProvinceItem[];
  religions: ReligionItem[];
  burgs: BurgItem[];
  rivers: RiverItem[];
  biomes: BiomeItem[];
  lakes: LakeFeature[];
}

/** 国家首都优先于省首府；删除实体与已失效的首府引用不参与分层。 */
export function recomputeBurgTiers(map: MapData): void {
  const validBurgs = new Set(map.burgs.filter((burg) => burg.i > 0 && !burg.removed).map((burg) => burg.i));
  const stateCapitals = new Set(map.states
    .filter((state) => state.i > 0 && !state.removed && state.capital !== undefined && validBurgs.has(state.capital))
    .map((state) => state.capital));
  const provCapitals = new Set(map.provinces
    .filter((province) => province.i > 0 && !province.removed && validBurgs.has(province.burg))
    .map((province) => province.burg));
  for (const burg of map.burgs) {
    if (burg.removed) continue;
    burg.capital = stateCapitals.has(burg.i) ? 1 : 0;
    burg.tier = burg.capital === 1 ? 'capital' : provCapitals.has(burg.i) ? 'provincial' : 'city';
  }
}

/** 重算传入区域的内部极点；领土笔刷只传入本笔发生增减的国家/省份。 */
export function recomputeRegionPoles(map: MapData): void {
  const { cells } = map;
  const stateLand = new Map(map.states.filter((state) => state.i > 0 && !state.removed)
    .map((state) => [state.i, [] as number[]]));
  const provinceLand = new Map(map.provinces.filter((province) => province.i > 0 && !province.removed)
    .map((province) => [province.i, [] as number[]]));
  for (let cell = 0; cell < cells.count; cell++) {
    if (cells.h[cell] < 20) continue;
    stateLand.get(cells.state[cell])?.push(cell);
    provinceLand.get(cells.province[cell])?.push(cell);
  }

  const nearestToMean = (land: number[]): number => {
    let sumX = 0;
    let sumY = 0;
    for (const cell of land) {
      sumX += cells.p[cell][0];
      sumY += cells.p[cell][1];
    }
    const avgX = sumX / land.length;
    const avgY = sumY / land.length;
    let nearest = land[0];
    let minDistance = Infinity;
    for (const cell of land) {
      const [x, y] = cells.p[cell];
      const distance = (x - avgX) ** 2 + (y - avgY) ** 2;
      if (distance < minDistance) {
        minDistance = distance;
        nearest = cell;
      }
    }
    return nearest;
  };

  for (const state of map.states) {
    if (state.i <= 0 || state.removed) continue;
    const land = stateLand.get(state.i)!;
    if (land.length > 0) {
      state.center = nearestToMean(land);
      state.pole = [...cells.p[state.center]];
    } else {
      const capital = map.burgs.find((burg) => burg.i > 0 && burg.i === state.capital && !burg.removed);
      if (capital) {
        state.center = capital.cell;
        state.pole = [capital.x, capital.y];
      }
    }
  }
  for (const province of map.provinces) {
    if (province.i <= 0 || province.removed) continue;
    const land = provinceLand.get(province.i)!;
    if (land.length > 0) {
      province.centerCell = nearestToMean(land);
      [province.x, province.y] = cells.p[province.centerCell];
    } else {
      const capital = map.burgs.find((burg) => burg.i > 0 && burg.i === province.burg && !burg.removed);
      if (capital) {
        province.centerCell = capital.cell;
        province.x = capital.x;
        province.y = capital.y;
      }
    }
  }
}

// 3 根业务图层容器（挂载在主舞台 worldViewport 下）
export const terrainContainer = new Container();
export const tacticalContainer = new Container();
export const garrisonContainer = new Container();

export interface AppEvents {
  'map:loaded': [map: MapData];
  'map:cleared': [];
  'map:loading': [];
  'map:error': [error: unknown];
  'viewport:zoom': [scale: number];
  'viewport:changed': [payload: ViewportChanged];
  'viewport:interaction': [];
  'brush:changed': [property?: string];
  'brush:painted': [payload: { cells: number; mode?: InteractionMode }];
  'brush:targets-changed': [];
  'brush:finish': [];
  'view:changed': [mode: ViewMode];
  'terrain:style': [property: 'hillshade' | 'contours'];
  'labels:style': [];
  'grid:changed': [enabled: boolean];
  'entity:changed': [];
  'garrison:style': [style: GarrisonBadgeStyle, scale: number];
  'garrisons-change': [];
  'battle:changed': [receipt: BattleEditReceipt];
  'battle:open': [];
  'fieldbattle:changed': [payload: FieldBattleChange];
  'fieldbattle:visibility': [visible: boolean];
  'tactical-change': [];
  'tactical-history-change': [];
  'tactical-selection-change': [id: string | null];
  'tactical-mode-change': [mode?: InteractionMode];
  'theater:leaving': [];
  'selection:burg': [burgId: number | null];
  'selection:unit': [unitId: string | null];
  'source:focus': [payload: { sourceId: string; highlightQuote?: string }];
  'retouch:changed': [];
  'overlay:alpha': [alpha: number];
  'scale:changed': [kmPerPixel: number | undefined];
  'project:autosaved': [];
}

class AppStore {
  mapData: MapData | null = null;
  mapId = '';
  isSwitchingMap = false;
  viewMode: ViewMode = 'state';
  interactionMode: InteractionMode = 'pan';
  showCiv4Grid = false;
  showHillshade = true;
  showContours = true;
  cityLabelScale = 1;
  cityLabelZoomBoost = true;
  cityLabelDynamicLod = true;
  showFieldBattles = false;
  fieldBattles: FieldBattle[] = [];

  // 画笔参数（Agent 1）
  brushRadius = 35;
  heightDelta = 3;
  activeStateId = 24;
  activeProvinceId = 1;
  activeReligionId = 1;
  selectedBurgId: number | null = null;
  retouchColor = '#d4c9a8';
  retouchRadius = 24;

  // 战术标绘参数（Agent 2）
  tacticalItems: TacticalItem[] = [];
  selectedTacticalId: string | null = null;
  tacticalColor = '#ef4444';
  tacticalWidth = 4;
  tacticalFlip = false;
  tacticalLabel = '主力防线';
  tacticalToothStyle: 'sawtooth' | 'semicircle' = 'sawtooth';
  tacticalArrowStyle: 'solid' | 'dashed' | 'double-retreat' = 'solid';

  // 当前战区的驻军列表。
  garrisons: BattleUnit[] = [];
  battle: BattleState = { schemaVersion: 1, sources: [], battlefields: [], deployments: [] };
  garrisonScale = 0.75;
  garrisonStyle: GarrisonBadgeStyle = 'compact';

  private listeners: { [K in keyof AppEvents]?: ((...args: AppEvents[K]) => void)[] } = {};

  on<K extends keyof AppEvents>(event: K, fn: (...args: AppEvents[K]) => void) {
    const callbacks = (this.listeners[event] ??= []) as ((...args: AppEvents[K]) => void)[];
    callbacks.push(fn);
  }

  off<K extends keyof AppEvents>(event: K, fn: (...args: AppEvents[K]) => void) {
    const callbacks = this.listeners[event] as ((...args: AppEvents[K]) => void)[] | undefined;
    if (!callbacks) return;
    const idx = callbacks.indexOf(fn);
    if (idx >= 0) callbacks.splice(idx, 1);
  }

  emit<K extends keyof AppEvents>(event: K, ...args: AppEvents[K]) {
    for (const fn of this.listeners[event] || []) fn(...args);
  }

  toMapCoords(globalX: number, globalY: number): [number, number] {
    const pt = terrainContainer.toLocal({ x: globalX, y: globalY });
    return [pt.x, pt.y];
  }
}

export const appStore = new AppStore();
