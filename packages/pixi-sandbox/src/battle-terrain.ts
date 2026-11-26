import type {
  Battlefield,
  BattlePoint,
  BattleRing,
  BattlePolygon,
  BattleMultiPolygon,
  BattleField,
  BattleTerrainFeature,
  BattleWorkspace,
} from './battle-contract';
import {
  closeRing,
  pointDistance as euclideanDistance,
  pointInMultiPolygon as geomPointInMultiPolygon,
  pointInPolygon as geomPointInPolygon,
  pointInRing as geomPointInRing,
  polylineLength as calculateLineLength,
  segmentWithinMultiPolygon,
} from './battle-geometry';
export { euclideanDistance, calculateLineLength };

export function isPointInRing(point: BattlePoint, ring: BattleRing | BattlePoint[]): boolean {
  if (ring.length < 3) return false;
  return geomPointInRing(point, closeRing(ring as BattlePoint[]), true);
}

export function isPointInPolygon(point: BattlePoint, polygon: BattlePolygon): boolean {
  return geomPointInPolygon(point, polygon);
}

export function isPointInMultiPolygon(point: BattlePoint, multi: BattleMultiPolygon): boolean {
  return geomPointInMultiPolygon(point, multi);
}

/**
 * 获取工作区中的确切战场；未知 ID 是入口错误，不返回默认战场
 */
export function getBattlefield(workspace: BattleWorkspace, battlefieldId: string): Battlefield {
  const found = workspace.battle.battlefields.find(b => b.id === battlefieldId);
  if (!found) {
    throw new Error(`Battlefield '${battlefieldId}' not found in workspace '${workspace.mapId}'`);
  }
  return found;
}

/**
 * 测量战场局部线段的米制长度
 * 若未校准或超出标定适用范围，返回明确未知状态并说明原因；绝不外推全图距离
 */
export function measureBattleDistance(
  battlefield: Battlefield,
  segment: [BattlePoint, BattlePoint],
): BattleField<number> {
  const { scale } = battlefield;
  if (scale.state === 'uncalibrated') {
    return {
      state: 'unknown',
      reason: scale.reason,
      evidence: [],
    };
  }

  const [p1, p2] = segment;
  if (!segmentWithinMultiPolygon(segment, scale.appliesWithin)) {
    return {
      state: 'unknown',
      reason: '待测线段超出尺度标定适用范围，不能外推全图距离',
      evidence: scale.evidence,
    };
  }

  const refDist = euclideanDistance(scale.referenceSegment[0], scale.referenceSegment[1]);
  if (refDist <= 0) {
    throw new Error(`Battlefield '${battlefield.id}' has invalid reference segment with non-positive length`);
  }

  const metersPerMapUnit = scale.distanceMeters / refDist;
  const segDist = euclideanDistance(p1, p2);
  const value = segDist * metersPerMapUnit;

  return {
    state: 'known',
    value,
    evidence: scale.evidence,
  };
}

/**
 * 按类型提取战场中的地形特征
 */
export function getFeaturesByKind<K extends BattleTerrainFeature['kind']>(
  battlefield: Battlefield,
  kind: K,
): Extract<BattleTerrainFeature, { kind: K }>[] {
  return battlefield.terrain.filter(
    (f): f is Extract<BattleTerrainFeature, { kind: K }> => f.kind === kind,
  );
}

/**
 * 查询指定障碍上所有的通行口（桥、渡口、隘口）
 */
export function getPassagesForObstacle(
  battlefield: Battlefield,
  obstacleId: string,
): Extract<BattleTerrainFeature, { kind: 'passage' }>[] {
  return getFeaturesByKind(battlefield, 'passage').filter(p =>
    p.obstacleIds.includes(obstacleId),
  );
}

/**
 * 查询指定通行口所跨越的所有障碍物
 */
export function getObstaclesForPassage(
  battlefield: Battlefield,
  passageId: string,
): Extract<BattleTerrainFeature, { kind: 'obstacle' }>[] {
  const passage = battlefield.terrain.find(f => f.id === passageId);
  if (!passage || passage.kind !== 'passage') {
    throw new Error(`Passage '${passageId}' not found in battlefield '${battlefield.id}'`);
  }
  const obstacles = getFeaturesByKind(battlefield, 'obstacle');
  return obstacles.filter(o => passage.obstacleIds.includes(o.id));
}

/**
 * 点位地形语义查询：查询包含该点的障碍、允许部署区与附近的通行口
 */
export function queryTerrainAtPoint(
  battlefield: Battlefield,
  point: BattlePoint,
  passageToleranceMapUnits = 10,
): {
  obstacles: Extract<BattleTerrainFeature, { kind: 'obstacle' }>[];
  deploymentZones: Extract<BattleTerrainFeature, { kind: 'deployment-zone' }>[];
  passages: Extract<BattleTerrainFeature, { kind: 'passage' }>[];
} {
  const obstacles = getFeaturesByKind(battlefield, 'obstacle').filter(o =>
    o.area.state === 'known' && isPointInMultiPolygon(point, o.area.value),
  );

  const deploymentZones = getFeaturesByKind(battlefield, 'deployment-zone').filter(d =>
    d.area.state === 'known' && isPointInMultiPolygon(point, d.area.value),
  );

  const passages = getFeaturesByKind(battlefield, 'passage').filter(p => {
    if (p.point.state !== 'known') {
      return false;
    }
    return euclideanDistance(point, p.point.value) <= passageToleranceMapUnits;
  });

  return { obstacles, deploymentZones, passages };
}

export interface DeployabilityCheckResult {
  deployable: boolean;
  reason?: string;
  obstacleId?: string;
  deploymentZoneId?: string;
}

/**
 * 校验某点在当前战场地形规则下的可部署性
 * 规则：
 * 1. 落在任何已知 obstacle 内 -> 不可部署；
 * 2. 若存在已知 deployment-zone，且点不在任何 deployment-zone 内 -> 不可部署；
 * 3. 否则 -> 可部署。
 */
export function checkLocationDeployability(
  battlefield: Battlefield,
  point: BattlePoint,
): DeployabilityCheckResult {
  const obstacles = getFeaturesByKind(battlefield, 'obstacle');
  for (const obs of obstacles) {
    if (obs.area.state === 'known' && isPointInMultiPolygon(point, obs.area.value)) {
      return {
        deployable: false,
        reason: `落在障碍区 [${obs.id}] 内部，禁止占地部署`,
        obstacleId: obs.id,
      };
    }
  }

  const zones = getFeaturesByKind(battlefield, 'deployment-zone').filter(
    z => z.area.state === 'known',
  );

  if (zones.length > 0) {
    const matched = zones.find(z =>
      z.area.state === 'known' && isPointInMultiPolygon(point, z.area.value),
    );
    if (!matched) {
      return {
        deployable: false,
        reason: '未处于任何指定的允许部署区内',
      };
    }
    return {
      deployable: true,
      deploymentZoneId: matched.id,
    };
  }

  return { deployable: true };
}
