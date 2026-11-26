import type {
  Battlefield,
  BattleScale,
  BattleTerrainFeature,
  BattleMultiPolygon,
  BattlePoint,
  BattleLine,
  BattleField,
  BattleAssertion,
  BattleEditBatch,
} from './battle-contract';

/**
 * 设置战场的距离标定尺度
 */
export function setBattlefieldScale(battlefield: Battlefield, scale: BattleScale): Battlefield {
  return {
    ...battlefield,
    scale,
  };
}

/**
 * 设置战场名称
 */
export function setBattlefieldName(
  battlefield: Battlefield,
  name: BattleField<string>,
): Battlefield {
  return {
    ...battlefield,
    name,
  };
}

/**
 * 设置战场边界多边形
 */
export function setBattlefieldBoundary(
  battlefield: Battlefield,
  boundary: BattleField<BattleMultiPolygon>,
): Battlefield {
  return {
    ...battlefield,
    boundary,
  };
}

/**
 * 校验通行口引用的所有障碍物是否存在于战场中
 */
function validatePassageObstacles(battlefield: Battlefield, passage: Extract<BattleTerrainFeature, { kind: 'passage' }>): void {
  const existingObstacleIds = new Set(
    battlefield.terrain.filter(f => f.kind === 'obstacle').map(f => f.id),
  );
  for (const obsId of passage.obstacleIds) {
    if (!existingObstacleIds.has(obsId)) {
      throw new Error(`Passage '${passage.id}' references non-existent obstacle '${obsId}' in battlefield '${battlefield.id}'`);
    }
  }
}

/**
 * 向战场添加地形特征
 * feature.id 必须唯一；通行口引用的障碍必须存在
 */
export function addTerrainFeature(
  battlefield: Battlefield,
  feature: BattleTerrainFeature,
): Battlefield {
  if (battlefield.terrain.some(f => f.id === feature.id)) {
    throw new Error(`Terrain feature '${feature.id}' already exists in battlefield '${battlefield.id}'`);
  }

  if (feature.kind === 'passage') {
    validatePassageObstacles(battlefield, feature);
  }

  return {
    ...battlefield,
    terrain: [...battlefield.terrain, feature],
  };
}

/**
 * 更新战场中的既有地形特征
 */
export function updateTerrainFeature(
  battlefield: Battlefield,
  feature: BattleTerrainFeature,
): Battlefield {
  const index = battlefield.terrain.findIndex(f => f.id === feature.id);
  if (index === -1) {
    throw new Error(`Terrain feature '${feature.id}' not found in battlefield '${battlefield.id}'`);
  }

  const previous = battlefield.terrain[index];
  if (previous.kind === 'obstacle' && feature.kind !== 'obstacle') {
    const referencingPassage = battlefield.terrain.find(
      f => f.kind === 'passage' && f.id !== feature.id && f.obstacleIds.includes(feature.id),
    );
    if (referencingPassage) {
      throw new Error(
        `Cannot convert obstacle '${feature.id}' because passage '${referencingPassage.id}' references it in battlefield '${battlefield.id}'`,
      );
    }
  }

  const nextTerrain = [...battlefield.terrain];
  nextTerrain[index] = feature;
  if (feature.kind === 'passage') {
    validatePassageObstacles({ ...battlefield, terrain: nextTerrain }, feature);
  }
  return {
    ...battlefield,
    terrain: nextTerrain,
  };
}

/**
 * 移除指定地形特征；若被移除的是障碍且被通行口引用，阻止删除以防悬挂引用
 */
export function removeTerrainFeature(
  battlefield: Battlefield,
  featureId: string,
): Battlefield {
  const target = battlefield.terrain.find(f => f.id === featureId);
  if (!target) {
    throw new Error(`Terrain feature '${featureId}' not found in battlefield '${battlefield.id}'`);
  }

  if (target.kind === 'obstacle') {
    const dependentPassage = battlefield.terrain.find(
      f => f.kind === 'passage' && f.obstacleIds.includes(featureId),
    );
    if (dependentPassage) {
      throw new Error(`Cannot remove obstacle '${featureId}' because passage '${dependentPassage.id}' references it`);
    }
  }

  return {
    ...battlefield,
    terrain: battlefield.terrain.filter(f => f.id !== featureId),
  };
}

/**
 * 辅助函数：构造障碍区特征
 */
export function createObstacleFeature(params: {
  id: string;
  label: BattleField<string>;
  area: BattleField<BattleMultiPolygon>;
  assertion?: BattleAssertion;
}): Extract<BattleTerrainFeature, { kind: 'obstacle' }> {
  return {
    id: params.id,
    kind: 'obstacle',
    assertion: params.assertion ?? 'plan',
    label: params.label,
    area: params.area,
  };
}

/**
 * 辅助函数：构造展开/部署区特征
 */
export function createDeploymentZoneFeature(params: {
  id: string;
  label: BattleField<string>;
  area: BattleField<BattleMultiPolygon>;
  assertion?: BattleAssertion;
}): Extract<BattleTerrainFeature, { kind: 'deployment-zone' }> {
  return {
    id: params.id,
    kind: 'deployment-zone',
    assertion: params.assertion ?? 'plan',
    label: params.label,
    area: params.area,
  };
}

/**
 * 辅助函数：构造通行线（道路等）特征
 */
export function createPassageLineFeature(params: {
  id: string;
  label: BattleField<string>;
  line: BattleField<BattleLine>;
  assertion?: BattleAssertion;
}): Extract<BattleTerrainFeature, { kind: 'passage-line' }> {
  return {
    id: params.id,
    kind: 'passage-line',
    assertion: params.assertion ?? 'plan',
    label: params.label,
    line: params.line,
  };
}

/**
 * 辅助函数：构造通行口（桥、渡口、隘口）特征
 */
export function createPassageFeature(params: {
  id: string;
  label: BattleField<string>;
  point: BattleField<BattlePoint>;
  passageKind: 'bridge' | 'ford' | 'pass';
  obstacleIds: string[];
  widthMapUnits: BattleField<number>;
  assertion?: BattleAssertion;
}): Extract<BattleTerrainFeature, { kind: 'passage' }> {
  return {
    id: params.id,
    kind: 'passage',
    assertion: params.assertion ?? 'plan',
    label: params.label,
    point: params.point,
    passageKind: params.passageKind,
    obstacleIds: params.obstacleIds,
    widthMapUnits: params.widthMapUnits,
  };
}

/**
 * 构造战场保存/更新编辑批次
 */
export function buildUpsertBattlefieldBatch(
  battlefield: Battlefield,
  label?: string,
): BattleEditBatch {
  return {
    label: label ?? `更新战场 [${battlefield.id}]`,
    origin: 'manual',
    candidateItemIds: [],
    edits: [{ kind: 'upsert-battlefield', battlefield }],
  };
}

/**
 * 构造战场删除编辑批次
 */
export function buildRemoveBattlefieldBatch(
  battlefieldId: string,
  label?: string,
): BattleEditBatch {
  return {
    label: label ?? `删除战场 [${battlefieldId}]`,
    origin: 'manual',
    candidateItemIds: [],
    edits: [{ kind: 'remove-battlefield', battlefieldId }],
  };
}
