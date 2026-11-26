import { knownField } from './battle-contract';
import type {
  BattleDeployment, BattleDeploymentRequest, BattleDeploymentResult, BattleLine,
  BattleMultiPolygon, BattlePlacement, BattleRing, BattleWorkspace,
} from './battle-contract';
import {
  GEOMETRY_EPSILON, buildFootprintRing, multiPolygonIsValid, multiPolygonOverlapsRing,
  pointAtPolylineDistance, polygonContainsRing, polylineLength, ringComponentsWithVertices,
  ringIsSimple, ringSignedArea, slicePolyline,
} from './battle-geometry';

type DeploymentIssue = Extract<BattleDeploymentResult, { outcome: 'conflict' }>['issues'][number];

function missingInput(
  message: string, unitIds: string[] = [], terrainIds: string[] = [],
): DeploymentIssue {
  return { code: 'missing-input', unitIds, terrainIds, message };
}

function conflict(issues: DeploymentIssue[]): BattleDeploymentResult {
  return { outcome: 'conflict', issues };
}

/**
 * 纯部署计算：读取当前战区的真实单位和战场地形，返回完整草案或具体冲突。
 * 不写 store，不补时代模板，不把裁切/缩水结果当成功。
 */
export function calculateBattleDeployment(
  workspace: BattleWorkspace,
  request: BattleDeploymentRequest,
): BattleDeploymentResult {
  const battlefield = workspace.battle.battlefields.find(
    (candidate) => candidate.id === request.battlefieldId,
  );
  if (battlefield === undefined) {
    return conflict([missingInput(`未知战场：${request.battlefieldId}`)]);
  }
  if (battlefield.mapId !== workspace.mapId) {
    return conflict([missingInput(
      `战场 ${battlefield.id} 属于 ${battlefield.mapId}，不是当前地图 ${workspace.mapId}`,
    )]);
  }

  const issues: DeploymentIssue[] = [];
  validateRequest(workspace, request, issues);
  if (issues.length > 0) return conflict(issues);

  const knownObstacles: { id: string; area: BattleMultiPolygon }[] = [];
  for (const feature of battlefield.terrain) {
    if (feature.kind !== 'obstacle') continue;
    if (feature.area.state === 'unknown') {
      issues.push(missingInput(
        `障碍 ${feature.id} 的范围未知，无法校验部署面`, [], [feature.id],
      ));
      continue;
    }
    if (!multiPolygonIsValid(feature.area.value)) {
      issues.push(missingInput(`障碍 ${feature.id} 的几何无效`, [], [feature.id]));
      continue;
    }
    knownObstacles.push({ id: feature.id, area: feature.area.value });
  }
  if (issues.length > 0) return conflict(issues);

  const lineStates = new Map<number, { front: BattleLine; cursor: number }>();
  for (const line of request.lines) lineStates.set(line.order, { front: line.front, cursor: 0 });

  const deployments: BattleDeployment[] = [];
  for (const allocation of request.allocations) {
    const lineState = lineStates.get(allocation.lineOrder)!;
    const front = slicePolyline(
      lineState.front, lineState.cursor, allocation.frontageMapUnits,
    );
    if (front === null) {
      issues.push({
        code: 'insufficient-frontage',
        unitIds: [allocation.unitId],
        terrainIds: [],
        message: `单位 ${allocation.unitId} 无法在梯队 ${allocation.lineOrder} 上取得 ${allocation.frontageMapUnits} 的正面`,
      });
      continue;
    }
    lineState.cursor += allocation.frontageMapUnits;

    const footprint = buildFootprintRing(
      front, allocation.depthMapUnits, request.facingDegrees,
    );
    if (!ringIsSimple(footprint) || Math.abs(ringSignedArea(footprint)) <= GEOMETRY_EPSILON) {
      issues.push({
        code: 'disconnected-allocation',
        unitIds: [allocation.unitId],
        terrainIds: [],
        message: `单位 ${allocation.unitId} 的展开面自交、断裂或没有面积；检查正面线与纵深方向`,
      });
      continue;
    }

    const containingComponent = request.deploymentArea.findIndex(
      (polygon) => polygonContainsRing(polygon, footprint),
    );
    if (containingComponent < 0) {
      const components = ringComponentsWithVertices(request.deploymentArea, footprint);
      if (components.length > 1) {
        issues.push({
          code: 'disconnected-allocation',
          unitIds: [allocation.unitId],
          terrainIds: [],
          message: `单位 ${allocation.unitId} 的展开面跨越了不连通的部署区块 ${components.join(', ')}`,
        });
      } else {
        issues.push({
          code: 'outside-deployment-area',
          unitIds: [allocation.unitId],
          terrainIds: [],
          message: `单位 ${allocation.unitId} 的展开面超出请求的部署区或落入孔洞`,
        });
      }
      continue;
    }

    const obstacleHits = knownObstacles.filter(
      (obstacle) => multiPolygonOverlapsRing(obstacle.area, footprint),
    );
    if (obstacleHits.length > 0) {
      const terrainIds = obstacleHits.map((obstacle) => obstacle.id);
      issues.push({
        code: 'obstacle-intersection',
        unitIds: [allocation.unitId],
        terrainIds,
        message: `单位 ${allocation.unitId} 的展开面压住障碍 ${terrainIds.join(', ')}`,
      });
      continue;
    }

    deployments.push(buildDeployment(request, allocation, front, footprint));
  }

  if (issues.length > 0) return conflict(issues);
  return { outcome: 'placed', deployments };
}

function validateRequest(
  workspace: BattleWorkspace,
  request: BattleDeploymentRequest,
  issues: DeploymentIssue[],
): void {
  if (!Number.isFinite(request.facingDegrees)
    || request.facingDegrees < 0 || request.facingDegrees >= 360) {
    issues.push(missingInput('朝向必须是 [0, 360) 内的有限数'));
  }
  if (!multiPolygonIsValid(request.deploymentArea)) {
    issues.push(missingInput('部署区必须是闭合、简单、有面积的 MultiPolygon'));
  }

  const lineOrders = new Set<number>();
  for (const line of request.lines) {
    if (!Number.isInteger(line.order) || line.order < 1) {
      issues.push(missingInput(`梯队序号 ${line.order} 必须是正整数`));
      continue;
    }
    if (lineOrders.has(line.order)) {
      issues.push(missingInput(`梯队序号 ${line.order} 重复`));
      continue;
    }
    lineOrders.add(line.order);
    if (line.front.length < 2) {
      issues.push(missingInput(`梯队 ${line.order} 的正面线至少需要两个点`));
      continue;
    }
    if (line.front.some((point) => !point.every(Number.isFinite))) {
      issues.push(missingInput(`梯队 ${line.order} 的正面线包含非有限坐标`));
      continue;
    }
    if (polylineLength(line.front) <= GEOMETRY_EPSILON) {
      issues.push(missingInput(`梯队 ${line.order} 的正面线长度必须大于 0`));
    }
  }

  const unitIds = new Set(workspace.garrisons.map((unit) => unit.id));
  const allocatedUnitIds = new Set<string>();
  const requiredByLine = new Map<number, number>();
  for (const allocation of request.allocations) {
    if (!unitIds.has(allocation.unitId)) {
      issues.push(missingInput(`单位 ${allocation.unitId} 不在当前战区`, [allocation.unitId]));
    }
    if (allocatedUnitIds.has(allocation.unitId)) {
      issues.push(missingInput(`单位 ${allocation.unitId} 被重复分配`, [allocation.unitId]));
    }
    allocatedUnitIds.add(allocation.unitId);
    if (!lineOrders.has(allocation.lineOrder)) {
      issues.push(missingInput(
        `单位 ${allocation.unitId} 引用了不存在的梯队 ${allocation.lineOrder}`,
        [allocation.unitId],
      ));
    }
    if (!Number.isFinite(allocation.frontageMapUnits) || allocation.frontageMapUnits <= 0) {
      issues.push(missingInput(
        `单位 ${allocation.unitId} 的正面宽度必须大于 0`, [allocation.unitId],
      ));
    }
    if (!Number.isFinite(allocation.depthMapUnits) || allocation.depthMapUnits <= 0) {
      issues.push(missingInput(
        `单位 ${allocation.unitId} 的纵深必须大于 0`, [allocation.unitId],
      ));
    }
    if (allocation.role !== 'reserve' && allocation.reserveForUnitId !== null) {
      issues.push(missingInput(
        `单位 ${allocation.unitId} 不是预备队，不能设置预备关系`, [allocation.unitId],
      ));
    }
    if (allocation.reserveForUnitId !== null && allocation.reserveForUnitId === allocation.unitId) {
      issues.push(missingInput(
        `单位 ${allocation.unitId} 不能将自身设为预备上级`,
        [allocation.unitId],
      ));
    } else if (allocation.reserveForUnitId !== null && !unitIds.has(allocation.reserveForUnitId)) {
      issues.push(missingInput(
        `单位 ${allocation.unitId} 的预备上级 ${allocation.reserveForUnitId} 不存在`,
        [allocation.unitId],
      ));
    }
    const required = requiredByLine.get(allocation.lineOrder);
    requiredByLine.set(
      allocation.lineOrder,
      required === undefined ? allocation.frontageMapUnits : required + allocation.frontageMapUnits,
    );
  }

  for (const [order, required] of requiredByLine) {
    const line = request.lines.find((candidate) => candidate.order === order);
    if (line === undefined) continue;
    const available = polylineLength(line.front);
    if (required > available + GEOMETRY_EPSILON) {
      issues.push({
        code: 'insufficient-frontage',
        unitIds: request.allocations
          .filter((allocation) => allocation.lineOrder === order)
          .map((allocation) => allocation.unitId),
        terrainIds: [],
        message: `梯队 ${order} 正面不足：需要 ${required} 地图单位，只有 ${available}`,
      });
    }
  }
}

function buildDeployment(
  request: BattleDeploymentRequest,
  allocation: BattleDeploymentRequest['allocations'][number],
  front: BattleLine,
  footprint: BattleRing,
): BattleDeployment {
  const evidence = request.evidence;
  const area: BattleMultiPolygon = [[footprint]];
  const placement: BattlePlacement = {
    anchor: pointAtPolylineDistance(front, allocation.frontageMapUnits / 2),
    shape: { kind: 'area', area },
  };
  return {
    unitId: allocation.unitId,
    assertion: request.assertion,
    battlefieldId: knownField(request.battlefieldId, evidence),
    placement: knownField(placement, evidence),
    facingDegrees: knownField(request.facingDegrees, evidence),
    depthMapUnits: knownField(allocation.depthMapUnits, evidence),
    formationLine: knownField(allocation.lineOrder, evidence),
    role: knownField(allocation.role, evidence),
    reserveForUnitId: knownField(allocation.reserveForUnitId, evidence),
  };
}
