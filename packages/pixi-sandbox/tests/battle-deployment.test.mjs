import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const { calculateBattleDeployment } = await server.ssrLoadModule('/src/battle-deployment.ts');
const geometry = await server.ssrLoadModule('/src/battle-geometry.ts');
const sample = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');
const cases = await server.ssrLoadModule('/work-packages/BATTLE-1/D/samples/deployment-cases.ts');

function issueCodes(result) {
  assert.equal(result.outcome, 'conflict');
  return result.issues.map((issue) => issue.code);
}

function deploymentOf(result, unitId) {
  assert.equal(result.outcome, 'placed');
  const deployment = result.deployments.find((candidate) => candidate.unitId === unitId);
  assert.notEqual(deployment, undefined);
  return deployment;
}

function ringOf(deployment) {
  assert.equal(deployment.placement.state, 'known');
  const shape = deployment.placement.value.shape;
  assert.equal(shape.kind, 'area');
  return shape.area[0][0];
}

function bounds(ring) {
  const xs = ring.map(([x]) => x);
  const ys = ring.map(([, y]) => y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

test('凹形部署面的包含与重叠不依赖落在面外的顶点均值', () => {
  const concave = [[0, 0], [6, 0], [6, 1], [1, 1], [1, 6], [0, 6], [0, 0]];
  assert.equal(geometry.polygonContainsRing([concave], concave), true);
  assert.equal(geometry.multiPolygonOverlapsRing([[concave]], concave), true);
});

test('面积裁切识别没有顶点落入区块的横穿，贴边仍不算压住障碍', () => {
  const strip = [[0, 2], [10, 2], [10, 3], [0, 3], [0, 2]];
  const blocks = [
    [[[2, 0], [3, 0], [3, 5], [2, 5], [2, 0]]],
    [[[7, 0], [8, 0], [8, 5], [7, 5], [7, 0]]],
  ];
  assert.deepEqual(geometry.ringComponentsWithVertices(blocks, strip), [0, 1]);
  assert.equal(geometry.multiPolygonOverlapsRing(blocks, strip), true);
  assert.equal(geometry.multiPolygonOverlapsRing(
    [[[[0, 3], [10, 3], [10, 4], [0, 4], [0, 3]]]], strip), false);
});

test('成熟几何运算保留孔洞和小数坐标，禁止把被孔占据的面积当作可部署', () => {
  const region = [
    [[0.1, 0.1], [6.1, 0.1], [6.1, 6.1], [0.1, 6.1], [0.1, 0.1]],
    [[2.1, 2.1], [2.1, 4.1], [4.1, 4.1], [4.1, 2.1], [2.1, 2.1]],
  ];
  assert.equal(geometry.polygonContainsRing(region,
    [[1.1, 1.1], [5.1, 1.1], [5.1, 5.1], [1.1, 5.1], [1.1, 1.1]]), false);
  assert.equal(geometry.polygonContainsRing(region,
    [[0.1, 0.1], [1.1, 0.1], [1.1, 1.1], [0.1, 1.1], [0.1, 0.1]]), true);
});

test('合成请求沿两条正面生成确定的三块占地区域', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.successRequest);
  assert.equal(result.outcome, 'placed');
  assert.deepEqual(result.deployments.map((deployment) => deployment.unitId), ['r11', 'r12', 'r13']);

  for (const deployment of result.deployments) {
    assert.equal(deployment.assertion, 'plan');
    assert.equal(deployment.battlefieldId.state, 'known');
    assert.equal(deployment.battlefieldId.value, 'valley');
    assert.equal(deployment.placement.state, 'known');
    assert.equal(deployment.placement.value.shape.kind, 'area');
    const ring = ringOf(deployment);
    assert.equal(geometry.ringIsValid(ring), true);
    assert.ok(geometry.ringSignedArea(ring) > 0);
    for (const point of ring) {
      assert.equal(geometry.pointInMultiPolygon(point, cases.successRequest.deploymentArea), true);
    }
  }

  const r11 = deploymentOf(result, 'r11');
  assert.deepEqual(bounds(ringOf(r11)), [130, 180, 190, 220]);
  assert.deepEqual(r11.placement.value.anchor, [160, 180]);
  const r12 = deploymentOf(result, 'r12');
  assert.deepEqual(bounds(ringOf(r12)), [190, 180, 250, 220]);
  assert.deepEqual(r12.placement.value.anchor, [220, 180]);
  const r13 = deploymentOf(result, 'r13');
  assert.deepEqual(bounds(ringOf(r13)), [130, 280, 190, 320]);
  assert.deepEqual(r13.placement.value.anchor, [160, 280]);
  assert.equal(r13.formationLine.value, 2);
  assert.equal(r13.role.value, 'reserve');
  assert.equal(r13.reserveForUnitId.value, 'd1');

  const again = calculateBattleDeployment(sample.syntheticWorkspace, cases.successRequest);
  assert.deepEqual(again, result);
});

test('正面不足返回该梯队全部单位', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.narrowFrontRequest);
  assert.deepEqual(issueCodes(result), ['insufficient-frontage']);
  assert.deepEqual(result.issues[0].unitIds, ['r11', 'r12']);
  assert.equal(result.issues[0].code, sample.syntheticConflict.issues[0].code);
  assert.deepEqual(result.issues[0].unitIds, sample.syntheticConflict.issues[0].unitIds);
});

test('压住障碍返回 obstacle-intersection 和地形 ID', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.obstacleRequest);
  assert.deepEqual(issueCodes(result), ['obstacle-intersection']);
  assert.deepEqual(result.issues[0].terrainIds, ['river']);
});

test('超出请求部署区返回 outside-deployment-area', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.outsideAreaRequest);
  assert.deepEqual(issueCodes(result), ['outside-deployment-area']);
});

test('横跨不连通部署区返回 disconnected-allocation', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.disconnectedAreaRequest);
  assert.deepEqual(issueCodes(result), ['disconnected-allocation']);
});

test('落入部署区孔洞返回 outside-deployment-area', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.holeRequest);
  assert.deepEqual(issueCodes(result), ['outside-deployment-area']);
});

test('面向东时纵深向左展开', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.facingEastRequest);
  assert.equal(result.outcome, 'placed');
  const deployment = deploymentOf(result, 'r11');
  assert.deepEqual(bounds(ringOf(deployment)), [260, 200, 300, 250]);
  assert.deepEqual(deployment.placement.value.anchor, [300, 225]);
});

test('朝向与正面线平行时不返回零面积部署', () => {
  const result = calculateBattleDeployment(sample.syntheticWorkspace, cases.degenerateFacingRequest);
  assert.deepEqual(issueCodes(result), ['disconnected-allocation']);
  assert.match(result.issues[0].message, /纵深方向/);
});

test('缺项与非法参数返回 missing-input', () => {
  const requests = [
    [cases.missingUnitRequest, ['ghost']],
    [cases.missingLineRequest, ['r11']],
    [cases.zeroFrontageRequest, ['r11']],
    [cases.invalidReserveRequest, ['r11']],
    [cases.duplicateUnitRequest, ['r11']],
  ];
  for (const [request, unitIds] of requests) {
    const result = calculateBattleDeployment(sample.syntheticWorkspace, request);
    assert.deepEqual(issueCodes(result), ['missing-input']);
    assert.deepEqual(result.issues[0].unitIds, unitIds);
  }

  const facing = calculateBattleDeployment(sample.syntheticWorkspace, cases.badFacingRequest);
  assert.deepEqual(issueCodes(facing), ['missing-input']);
  assert.match(facing.issues[0].message, /朝向/);
});

test('障碍范围未知时不返回 placed', () => {
  const result = calculateBattleDeployment(
    cases.workspaceWithUnknownObstacle(), sample.syntheticRequest,
  );
  assert.deepEqual(issueCodes(result), ['missing-input']);
  assert.deepEqual(result.issues[0].terrainIds, ['unknown-marsh']);
});

test('几何原语：面积、孔洞、切片、自交与障碍重叠', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  assert.equal(geometry.ringSignedArea(square), 100);
  assert.equal(geometry.ringIsClockwise(square), true);
  assert.equal(geometry.ringIsValid(square), true);
  assert.deepEqual(geometry.buildFootprintRing([[0, 0], [10, 0]], 5, 0), [
    [0, 0], [10, 0], [10, 5], [0, 5], [0, 0],
  ]);
  assert.deepEqual(geometry.depthVectorForFacing(0), [0, 1]);
  assert.deepEqual(geometry.depthVectorForFacing(90), [-1, 0]);
  assert.deepEqual(geometry.depthVectorForFacing(180), [0, -1]);
  assert.deepEqual(geometry.depthVectorForFacing(270), [1, 0]);

  const polygon = [
    square,
    [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]],
  ];
  assert.equal(geometry.pointInPolygon([1, 1], polygon), true);
  assert.equal(geometry.pointInPolygon([5, 5], polygon), false);
  assert.equal(geometry.pointInPolygon([4, 5], polygon), true);

  const line = [[0, 0], [100, 0], [100, 100]];
  assert.equal(geometry.polylineLength(line), 200);
  assert.deepEqual(geometry.slicePolyline(line, 50, 100), [[50, 0], [100, 0], [100, 50]]);
  assert.equal(geometry.slicePolyline(line, 150, 100), null);

  assert.equal(geometry.ringIsSimple([[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]), false);
  const footprint = [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]];
  assert.equal(geometry.polygonContainsRing(polygon, footprint), false);
  assert.equal(
    geometry.polygonContainsRing(polygon, [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]]),
    false,
  );
  const obstacle = [[[[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]];
  assert.equal(geometry.multiPolygonOverlapsRing(obstacle, footprint), true);
  assert.equal(
    geometry.multiPolygonOverlapsRing([[[[10, 0], [20, 0], [20, 10], [10, 10], [10, 0]]]], square),
    false,
  );
  assert.equal(
    geometry.multiPolygonOverlapsRing([[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]], square),
    true,
  );
  assert.equal(
    geometry.multiPolygonIsValid([[[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]]]),
    false,
  );
});

test('回归：斜角共边不触发 holeOf 崩溃或微缝误报，重叠障碍不可相互抵消，自引用与非有限坐标被拒', () => {
  // 1. 浮点斜角共边部署（37°）与外侧共边障碍
  const rad = (37 * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const vx = -Math.sin(rad);
  const vy = Math.cos(rad);
  const pt = (s, t) => [200 + s * ux + t * vx, 200 + s * uy + t * vy];
  const obliqueZone = [[pt(0, 0), pt(100, 0), pt(100, 80), pt(0, 80), pt(0, 0)]];
  const touchingOutsideObstacle = [[pt(0, 0), pt(100, 0), pt(100, -20), pt(0, -20), pt(0, 0)]];

  assert.equal(geometry.polygonContainsRing(obliqueZone, [pt(10, 0), pt(70, 0), pt(70, 40), pt(10, 40), pt(10, 0)]), true);
  assert.equal(
    geometry.multiPolygonOverlapsRing([touchingOutsideObstacle], [pt(10, 0), pt(70, 0), pt(70, 40), pt(10, 40), pt(10, 0)]),
    false,
  );

  const ws = structuredClone(sample.syntheticWorkspace);
  ws.battle.battlefields[0].terrain.push({
    id: 'oblique-cliff',
    kind: 'obstacle',
    assertion: 'plan',
    label: { state: 'known', value: '斜向断崖', evidence: [] },
    area: { state: 'known', value: [touchingOutsideObstacle], evidence: [] },
  });
  const obliqueResult = calculateBattleDeployment(ws, {
    battlefieldId: 'valley',
    deploymentArea: [obliqueZone],
    lines: [{ order: 1, front: [pt(0, 0), pt(100, 0)] }],
    allocations: [{ unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40, role: 'line', reserveForUnitId: null }],
    facingDegrees: 37,
    evidence: cases.successRequest.evidence,
  });
  assert.equal(obliqueResult.outcome, 'placed');

  // 2. 同一 MultiPolygon 内两个重叠障碍不因偶奇校验相互抵消
  const overlappingObstacles = [
    [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
    [[[2, 2], [12, 2], [12, 12], [2, 12], [2, 2]]],
  ];
  assert.equal(
    geometry.multiPolygonOverlapsRing(overlappingObstacles, [[3, 3], [8, 3], [8, 8], [3, 8], [3, 3]]),
    true,
  );

  // 3. 自引用 reserveForUnitId === unitId 被拒绝
  const selfReserve = structuredClone(cases.successRequest);
  selfReserve.allocations = [{ ...selfReserve.allocations[2], lineOrder: 1, reserveForUnitId: selfReserve.allocations[2].unitId }];
  selfReserve.lines = [selfReserve.lines[0]];
  const selfRes = calculateBattleDeployment(sample.syntheticWorkspace, selfReserve);
  assert.deepEqual(issueCodes(selfRes), ['missing-input']);

  // 4. 非有限坐标环在入口被 ringIsSimple 拒绝
  assert.equal(geometry.ringIsSimple([[0, 0], [Number.NaN, 0], [10, 10], [0, 0]]), false);
  assert.equal(geometry.ringIsSimple([[0, 0], [10, Number.POSITIVE_INFINITY], [10, 10], [0, 0]]), false);
});
