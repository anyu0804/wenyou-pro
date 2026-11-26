import type {
  BattleDeploymentRequest, BattleEvidence, BattleTerrainFeature, BattleWorkspace,
} from '../../../../src/battle-contract';
import { syntheticRequest, syntheticWorkspace } from '../../P0/samples/river-valley';

/** 全部为 D 包的合成请求；不引用正式地图、世界事实或已执行方案。 */
const evidence: BattleEvidence[] = [{
  sourceId: 'setting',
  basis: 'assumption',
  excerpt: 'D 包合成部署请求',
  note: '仅用于几何与冲突样例，不是实际作战方案',
}];

export const successRequest: BattleDeploymentRequest = syntheticRequest;

/** 第一梯队只有 80 地图单位，却要放两个各 60 的团。 */
export const narrowFrontRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  lines: [
    { order: 1, front: [[130, 180], [210, 180]] },
    { order: 2, front: [[130, 280], [350, 280]] },
  ],
  evidence,
};

/** 正面穿过合成河段障碍。 */
export const obstacleRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  deploymentArea: [[[[500, 100], [700, 100], [700, 700], [500, 700], [500, 100]]]],
  lines: [{ order: 1, front: [[500, 400], [650, 400]] }],
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 100, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

/** 右侧超出请求部署区。 */
export const outsideAreaRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  lines: [{ order: 1, front: [[350, 200], [450, 200]] }],
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

/** 展开面横跨两块不连通的部署区。 */
export const disconnectedAreaRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  deploymentArea: [
    [[[120, 150], [250, 150], [250, 620], [120, 620], [120, 150]]],
    [[[300, 150], [380, 150], [380, 620], [300, 620], [300, 150]]],
  ],
  lines: [{ order: 1, front: [[200, 200], [350, 200]] }],
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 100, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

/** 正面穿过部署区孔洞。 */
export const holeRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  deploymentArea: [[
    [[100, 100], [700, 100], [700, 700], [100, 700], [100, 100]],
    [[400, 300], [400, 400], [500, 400], [500, 300], [400, 300]],
  ]],
  lines: [{ order: 1, front: [[380, 340], [480, 340]] }],
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 80, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

/** 面向东，纵深按契约向左（-x）展开。 */
export const facingEastRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  facingDegrees: 90,
  lines: [{ order: 1, front: [[300, 200], [300, 300]] }],
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 50, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

/** 朝向与正面线平行，纵深展开退化成零面积。 */
export const degenerateFacingRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  facingDegrees: 90,
  lines: [{ order: 1, front: [[200, 200], [350, 200]] }],
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

export const missingUnitRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  allocations: [{
    unitId: 'ghost', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

export const missingLineRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  allocations: [{
    unitId: 'r11', lineOrder: 9, frontageMapUnits: 60, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

export const zeroFrontageRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 0, depthMapUnits: 40,
    role: 'line', reserveForUnitId: null,
  }],
  evidence,
};

export const badFacingRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  facingDegrees: 360,
  evidence,
};

export const invalidReserveRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  allocations: [{
    unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40,
    role: 'line', reserveForUnitId: 'd1',
  }],
  evidence,
};

export const duplicateUnitRequest: BattleDeploymentRequest = {
  ...syntheticRequest,
  allocations: [
    {
      unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40,
      role: 'line', reserveForUnitId: null,
    },
    {
      unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40,
      role: 'line', reserveForUnitId: null,
    },
  ],
  evidence,
};

/** 障碍已声明为 obstacle，但范围未知；D 不能假装校验通过。 */
export function workspaceWithUnknownObstacle(): BattleWorkspace {
  const battlefield = syntheticWorkspace.battle.battlefields[0];
  const unknownObstacle: BattleTerrainFeature = {
    id: 'unknown-marsh',
    kind: 'obstacle',
    assertion: 'plan',
    label: { state: 'known', value: '范围未知的沼泽', evidence },
    area: { state: 'unknown', reason: '尚未绘制范围', evidence },
  };
  return {
    ...syntheticWorkspace,
    battle: {
      ...syntheticWorkspace.battle,
      battlefields: [{
        ...battlefield,
        terrain: [...battlefield.terrain, unknownObstacle],
      }],
    },
  };
}
