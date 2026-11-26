import type { GarrisonUnit } from './store';

/** 所属地图的平面坐标：x 向右、y 向下；不是经纬度。 */
export type BattlePoint = [x: number, y: number];
export type BattleLine = [BattlePoint, BattlePoint, ...BattlePoint[]];
/** 闭合环；首尾相同，至少三个不同顶点。 */
export type BattleRing = [BattlePoint, BattlePoint, BattlePoint, BattlePoint, ...BattlePoint[]];
/** 第一环为外边界，其余为孔；嵌套深度分别为 3 和 4。 */
export type BattlePolygon = [BattleRing, ...BattleRing[]];
export type BattleMultiPolygon = [BattlePolygon, ...BattlePolygon[]];

export interface BattleSource {
  id: string;
  kind: 'reference' | 'manual' | 'ai' | 'legacy';
  title: string;
  text: string;
  locator: string | null;
}

export interface BattleEvidence {
  sourceId: string;
  basis: 'quoted' | 'assumption' | 'inference';
  excerpt: string;
  note: string;
}

/** 来源解释值从何而来；reported/plan 另外解释它是记录还是方案。 */
export type BattleField<T> =
  | { state: 'known'; value: T; evidence: BattleEvidence[] }
  | { state: 'unknown'; reason: string; evidence: BattleEvidence[] };
export function knownField<T>(value: T, evidence: BattleEvidence[]): BattleField<T> {
  return { state: 'known', value, evidence };
}

export function unknownField<T>(reason: string, evidence: BattleEvidence[]): BattleField<T> {
  return { state: 'unknown', reason, evidence };
}

export type BattleAssertion = 'reported' | 'plan';

export interface BattlePersonnel {
  /** own 仅含本部；inclusive 含下属；旧数据缺统计口径时明确保持未解。 */
  scope: 'own' | 'inclusive' | 'legacy-unspecified';
  count: BattleField<number>;
}

export type BadgeCultureStyle = 'universal' | 'nato' | 'huaxia' | 'western' | 'nomad' | 'arcane' | 'custom';

export type EchelonSymbolCode = '|' | '||' | '|||' | 'x' | 'xx' | 'xxx' | 'xxxx';
export type EchelonTierName = '连' | '营' | '团' | '师' | '军' | '集团军' | '方面军';

export interface EchelonTierSpec {
  /** 1..8 对应 0-500, 500-2000, 2000-6000, 6000-18000, 18000-54000, 54000-150000, 150000-450000, 450000+ */
  tierIndex: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  symbol: EchelonSymbolCode;
  echelonName: EchelonTierName;
  bracketLabel: '0-500' | '500-2000' | '2000-6000' | '6000-18000' | '18000-54000' | '54000-150000' | '150000-450000' | '450000+';
  minTroops: number;
  maxTroops: number | null;
}

export interface CustomBadgeConfig {
  /** 文化底板与框体风格：universal 为按人数档位通用图标 */
  culture: BadgeCultureStyle;
  /** 历史兼容字段（已从 UI 下线，保留字段避免旧档校验失败） */
  requirementTag?: string;
  /** 玩家自定义兵牌中心大字或符号（最多 2 个汉字或 4 个 ASCII 字符，如“陷阵”、“禁军”） */
  customGlyph?: string;
  /** 玩家上传或粘贴的自定义图标 DataURL（仅限 data:image/ 开头，可选） */
  customIconDataUrl?: string;
  /** 兵牌文字颜色（#rrggbb，可选，默认雪白） */
  textColor?: string;
}

/** 将来替换同一个 garrisons[] 的元素类型，不建立第二份单位集合。 */
export type BattleUnit = Omit<GarrisonUnit,
  'unitName' | 'troops' | 'provinceId' | 'status' | 'x' | 'y'> & {
  assertion: BattleAssertion;
  unitName: BattleField<string>;
  provinceId: BattleField<number | null>;
  status: BattleField<GarrisonUnit['status']>;
  parentUnitId: BattleField<GarrisonUnit['id'] | null>;
  echelon: BattleField<string>;
  branch: BattleField<string>;
  side: BattleField<string>;
  childrenCompleteness: BattleField<'complete' | 'partial'>;
  personnel: BattlePersonnel;
  customBadge?: CustomBadgeConfig;
};

export type BattlePlacement = {
  /** 唯一兵牌实际位置；移动时同本对象中的线/面一起变换。 */
  anchor: BattlePoint;
  shape:
    | { kind: 'point' }
    | { kind: 'frontage'; line: BattleLine }
    | { kind: 'area'; area: BattleMultiPolygon };
};

export interface BattleDeployment {
  /** 沿用 GarrisonUnit.id，每单位恰有一条当前部署，未知也保留记录。 */
  unitId: GarrisonUnit['id'];
  assertion: BattleAssertion;
  battlefieldId: BattleField<string | null>;
  placement: BattleField<BattlePlacement>;
  /** 0 为地图上方，90 为右方，顺时针，范围 [0, 360)。 */
  facingDegrees: BattleField<number>;
  /** 所属地图的平面单位；不是米。 */
  depthMapUnits: BattleField<number>;
  /** 1 为第一梯队，2 为第二梯队，以此类推。 */
  formationLine: BattleField<number>;
  role: BattleField<'line' | 'reserve' | 'headquarters'>;
  reserveForUnitId: BattleField<GarrisonUnit['id'] | null>;
}

export type BattleScale =
  | { state: 'uncalibrated'; reason: string }
  | {
    state: 'calibrated';
    referenceSegment: [BattlePoint, BattlePoint];
    distanceMeters: number;
    appliesWithin: BattleMultiPolygon;
    evidence: BattleEvidence[];
  };

interface BattleTerrainBase {
  id: string;
  assertion: BattleAssertion;
  label: BattleField<string>;
}

export type BattleTerrainFeature = BattleTerrainBase & (
  | { kind: 'obstacle'; area: BattleField<BattleMultiPolygon> }
  | { kind: 'deployment-zone'; area: BattleField<BattleMultiPolygon> }
  | { kind: 'passage-line'; line: BattleField<BattleLine> }
  | {
    kind: 'passage';
    point: BattleField<BattlePoint>;
    passageKind: 'bridge' | 'ford' | 'pass';
    obstacleIds: string[];
    widthMapUnits: BattleField<number>;
  }
);

export interface Battlefield {
  id: string;
  mapId: string;
  assertion: BattleAssertion;
  name: BattleField<string>;
  boundary: BattleField<BattleMultiPolygon>;
  scale: BattleScale;
  terrain: BattleTerrainFeature[];
}

/** 同一个战区的可持久化附加状态，不包含独立的单位副本。 */
export interface BattleState {
  schemaVersion: 1;
  sources: BattleSource[];
  battlefields: Battlefield[];
  deployments: BattleDeployment[];
}

/** 操作输入视图；不是另存一份的工程格式。 */
export interface BattleWorkspace {
  mapId: string;
  garrisons: BattleUnit[];
  battle: BattleState;
}

export interface BattlePersonnelSummary {
  total: BattleField<number>;
  /** 部分未知时仍可展示已知下限，不能称为总兵力。 */
  knownMinimum: number;
  countedUnitIds: string[];
  unresolvedUnitIds: string[];
  excludedUnitIds: string[];
}

export interface BattleDeploymentRequest {
  battlefieldId: string;
  assertion: BattleAssertion;
  facingDegrees: number;
  deploymentArea: BattleMultiPolygon;
  lines: { order: number; front: BattleLine }[];
  allocations: {
    unitId: GarrisonUnit['id'];
    lineOrder: number;
    frontageMapUnits: number;
    depthMapUnits: number;
    role: 'line' | 'reserve';
    reserveForUnitId: GarrisonUnit['id'] | null;
  }[];
  evidence: BattleEvidence[];
}

export type BattleDeploymentResult =
  | { outcome: 'placed'; deployments: BattleDeployment[] }
  | {
    outcome: 'conflict';
    issues: {
      code: 'insufficient-frontage' | 'obstacle-intersection' |
        'outside-deployment-area' | 'disconnected-allocation' | 'missing-input';
      unitIds: string[];
      terrainIds: string[];
      message: string;
    }[];
  };

/** 具体业务编辑；手工入口和 AI 已接受条目共用，不是命令注册框架。 */
export type BattleEdit =
  | { kind: 'upsert-unit'; unit: BattleUnit }
  | { kind: 'remove-unit'; unitId: GarrisonUnit['id'] }
  | { kind: 'set-deployment'; deployment: BattleDeployment }
  | { kind: 'upsert-battlefield'; battlefield: Battlefield }
  | { kind: 'remove-battlefield'; battlefieldId: string }
  | { kind: 'upsert-source'; source: BattleSource };

export interface BattleEditBatch {
  label: string;
  origin: 'manual' | 'candidate';
  candidateItemIds: string[];
  edits: BattleEdit[];
}

export interface BattleEditReceipt {
  mapId: string;
  label: string;
  origin: 'manual' | 'candidate' | 'undo' | 'redo';
  candidateItemIds: string[];
  changedUnitIds: string[];
  changedBattlefieldIds: string[];
  sourcesChanged: boolean;
}

export type BattleCandidateItem = {
  id: string;
  instruction: string;
  evidence: BattleEvidence[];
} & (
  | { state: 'ready'; edits: BattleEdit[] }
  | { state: 'unresolved'; reason: string }
);

/** 外部 JSON 一次解析后的候选；没有自动执行含义。 */
export interface BattleCandidateBatch {
  format: 'wenyou-battle-candidates';
  version: 1;
  mapId: string;
  sources: BattleSource[];
  items: BattleCandidateItem[];
}
