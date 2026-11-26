import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const {
  euclideanDistance,
  calculateLineLength,
  isPointInRing,
  isPointInPolygon,
  isPointInMultiPolygon,
  getBattlefield,
  measureBattleDistance,
  getFeaturesByKind,
  getPassagesForObstacle,
  getObstaclesForPassage,
  queryTerrainAtPoint,
  checkLocationDeployability,
} = await server.ssrLoadModule('/src/battle-terrain.ts');

const {
  setBattlefieldScale,
  setBattlefieldName,
  setBattlefieldBoundary,
  addTerrainFeature,
  updateTerrainFeature,
  removeTerrainFeature,
  createObstacleFeature,
  createDeploymentZoneFeature,
  createPassageLineFeature,
  createPassageFeature,
  buildUpsertBattlefieldBatch,
  buildRemoveBattlefieldBatch,
} = await server.ssrLoadModule('/src/battle-terrain-editor.ts');

const {
  syntheticBattlefield,
  syntheticWorkspace,
  uncalibratedBattlefield,
} = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');

test('getBattlefield: 正常获取战场，不存在时明确抛错不假装成功', () => {
  const bf = getBattlefield(syntheticWorkspace, 'valley');
  assert.equal(bf.id, 'valley');
  assert.equal(bf.mapId, 'synthetic-battle-valley');

  assert.throws(
    () => getBattlefield(syntheticWorkspace, 'non-existent-id'),
    /Battlefield 'non-existent-id' not found in workspace 'synthetic-battle-valley'/,
  );
});

test('平面几何与多边形孔洞判定: isPointInPolygon / isPointInMultiPolygon', () => {
  // 矩形 [100, 100] 到 [700, 700]，内部孔洞 [400, 300] 到 [500, 400]
  const polygonWithHole = [
    [[100, 100], [700, 100], [700, 700], [100, 700], [100, 100]],
    [[400, 300], [400, 400], [500, 400], [500, 300], [400, 300]],
  ];

  // 外部点
  assert.equal(isPointInPolygon([50, 50], polygonWithHole), false);
  // 外环内、孔洞外的普通点
  assert.equal(isPointInPolygon([200, 200], polygonWithHole), true);
  // 正好在孔洞内的点 -> 判定为不在多边形内
  assert.equal(isPointInPolygon([450, 350], polygonWithHole), false);

  // 复合多边形 MultiPolygon 判定（包含主多边形和东部不连通区域）
  const multiPoly = [
    polygonWithHole,
    [[[800, 100], [950, 100], [950, 300], [800, 300], [800, 100]]],
  ];
  assert.equal(isPointInMultiPolygon([200, 200], multiPoly), true);
  assert.equal(isPointInMultiPolygon([450, 350], multiPoly), false);
  assert.equal(isPointInMultiPolygon([850, 200], multiPoly), true);
  assert.equal(isPointInMultiPolygon([999, 200], multiPoly), false);
});

test('距离与折线长度计算', () => {
  assert.equal(euclideanDistance([0, 0], [3, 4]), 5);
  const line = [[0, 0], [3, 4], [3, 9]];
  assert.equal(calculateLineLength(line), 10);
});

test('measureBattleDistance: 已校准战场在适用范围内按比例计算米数', () => {
  // 基准线段 [[100, 650], [300, 650]]，长 200 单位，对应 2000 米（1 单位 = 10 米）
  // 测量线段 [[200, 200], [200, 350]]，长 150 单位，应为 1500 米
  const segment = [[200, 200], [200, 350]];
  const measured = measureBattleDistance(syntheticBattlefield, segment);
  assert.equal(measured.state, 'known');
  if (measured.state === 'known') {
    assert.equal(measured.value, 1500);
    assert.ok(measured.evidence.length > 0);
  }
});

test('measureBattleDistance: 越界线段返回 unknown 且说明超出适用域，不外推全图', () => {
  // 东部点 [850, 200] 不在 appliesWithin: [[[[100, 100], [700, 100], [700, 700], [100, 700], [100, 100]]]]
  const outOfBoundsSegment = [[200, 200], [850, 200]];
  const measured = measureBattleDistance(syntheticBattlefield, outOfBoundsSegment);
  assert.equal(measured.state, 'unknown');
  if (measured.state === 'unknown') {
    assert.match(measured.reason, /超出尺度标定适用范围/);
  }
});

test('measureBattleDistance: 未校准战场返回 unknown 且说明原因，不出现虚假米制', () => {
  const measured = measureBattleDistance(uncalibratedBattlefield, [[810, 120], [850, 120]]);
  assert.equal(measured.state, 'unknown');
  if (measured.state === 'unknown') {
    assert.equal(measured.reason, '没有该范围的距离资料，不能沿用西侧比例');
  }
});

test('测距线端点虽在标定域内，中段穿过孔洞仍不得换算米数', () => {
  const battlefield = structuredClone(syntheticBattlefield);
  battlefield.scale.appliesWithin = [[
    [[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]],
    [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]],
  ]];
  const result = measureBattleDistance(battlefield, [[1, 3], [5, 3]]);
  assert.equal(result.state, 'unknown');
  assert.match(result.reason, /超出尺度标定适用范围/);
});

test('测距线不得从标定域的一个分离区块跨到另一个区块', () => {
  const battlefield = structuredClone(syntheticBattlefield);
  battlefield.scale.appliesWithin = [
    [[[0, 0], [2, 0], [2, 4], [0, 4], [0, 0]]],
    [[[4, 0], [6, 0], [6, 4], [4, 4], [4, 0]]],
  ];
  assert.equal(measureBattleDistance(battlefield, [[1, 2], [5, 2]]).state, 'unknown');
});

test('测距检查整条线段：凹形域外穿越被拒绝，边界上的有效线段可测', () => {
  const battlefield = structuredClone(syntheticBattlefield);
  battlefield.scale.appliesWithin = [
    [[[0, 0], [6, 0], [6, 1], [1, 1], [1, 6], [0, 6], [0, 0]]],
  ];
  assert.equal(measureBattleDistance(battlefield, [[5, 0.5], [0.5, 5]]).state, 'unknown');
  assert.equal(measureBattleDistance(battlefield, [[0, 1], [0, 5]]).state, 'known');
});

test('语义地形查询与关联关系', () => {
  const obstacles = getFeaturesByKind(syntheticBattlefield, 'obstacle');
  assert.equal(obstacles.length, 1);
  assert.equal(obstacles[0].id, 'river');

  const passages = getPassagesForObstacle(syntheticBattlefield, 'river');
  assert.equal(passages.length, 1);
  assert.equal(passages[0].id, 'bridge');

  const bridgedObstacles = getObstaclesForPassage(syntheticBattlefield, 'bridge');
  assert.equal(bridgedObstacles.length, 1);
  assert.equal(bridgedObstacles[0].id, 'river');

  // 查询点位地形
  const pointOnRiver = [560, 300]; // 在 river 障碍区内
  const queryRiver = queryTerrainAtPoint(syntheticBattlefield, pointOnRiver);
  assert.equal(queryRiver.obstacles.length, 1);
  assert.equal(queryRiver.obstacles[0].id, 'river');

  const pointNearBridge = [562, 501]; // 在 bridge 附近
  const queryBridge = queryTerrainAtPoint(syntheticBattlefield, pointNearBridge, 10);
  assert.equal(queryBridge.passages.length, 1);
  assert.equal(queryBridge.passages[0].id, 'bridge');
});

test('可部署性判定: 扣除障碍与展开区规则', () => {
  // 1. 河道障碍区内 -> 不可部署
  const inRiver = checkLocationDeployability(syntheticBattlefield, [560, 300]);
  assert.equal(inRiver.deployable, false);
  assert.equal(inRiver.obstacleId, 'river');

  // 2. 河西展开区内 -> 可部署
  const inDeployZone = checkLocationDeployability(syntheticBattlefield, [200, 200]);
  assert.equal(inDeployZone.deployable, true);
  assert.equal(inDeployZone.deploymentZoneId, 'deploy-west');

  // 3. 在展开区外（但不是障碍区） -> 不可部署
  const outsideDeployZone = checkLocationDeployability(syntheticBattlefield, [450, 200]);
  assert.equal(outsideDeployZone.deployable, false);
  assert.match(outsideDeployZone.reason, /未处于任何指定的允许部署区内/);
});

test('地形编辑与引用完整性校验', () => {
  let bf = { ...syntheticBattlefield };

  // 1. 添加障碍
  const newObstacle = createObstacleFeature({
    id: 'forest',
    label: { state: 'known', value: '密林', evidence: [] },
    area: {
      state: 'known',
      value: [[[[200, 100], [250, 100], [250, 150], [200, 150], [200, 100]]]],
      evidence: [],
    },
  });
  bf = addTerrainFeature(bf, newObstacle);
  assert.equal(bf.terrain.some(f => f.id === 'forest'), true);

  // 2. 添加重复 ID 必须抛错
  assert.throws(
    () => addTerrainFeature(bf, newObstacle),
    /already exists/,
  );

  // 3. 添加通行口但引用了不存在的障碍必须抛错
  const invalidPassage = createPassageFeature({
    id: 'ford-phantom',
    label: { state: 'known', value: '幽灵浅滩', evidence: [] },
    point: { state: 'known', value: [300, 300], evidence: [] },
    passageKind: 'ford',
    obstacleIds: ['non-existent-lake'],
    widthMapUnits: { state: 'known', value: 10, evidence: [] },
  });
  assert.throws(
    () => addTerrainFeature(bf, invalidPassage),
    /references non-existent obstacle 'non-existent-lake'/,
  );

  // 4. 尝试删除被通行口引用的障碍必须阻止，防止孤立悬挂引用
  assert.throws(
    () => removeTerrainFeature(bf, 'river'),
    /Cannot remove obstacle 'river' because passage 'bridge' references it/,
  );

  // 5. 更新与删除无依赖地形特征
  const updatedObstacle = {
    ...newObstacle,
    label: { state: 'known', value: '伐木后的疏林', evidence: [] },
  };
  bf = updateTerrainFeature(bf, updatedObstacle);
  assert.equal(bf.terrain.find(f => f.id === 'forest')?.label.value, '伐木后的疏林');

  bf = removeTerrainFeature(bf, 'forest');
  assert.equal(bf.terrain.some(f => f.id === 'forest'), false);
});

test('编辑批次生成: buildUpsertBattlefieldBatch 与 buildRemoveBattlefieldBatch', () => {
  const upsertBatch = buildUpsertBattlefieldBatch(syntheticBattlefield, '测试保存战场');
  assert.equal(upsertBatch.label, '测试保存战场');
  assert.equal(upsertBatch.origin, 'manual');
  assert.equal(upsertBatch.edits.length, 1);
  assert.equal(upsertBatch.edits[0].kind, 'upsert-battlefield');
  assert.equal(upsertBatch.edits[0].battlefield.id, 'valley');

  const removeBatch = buildRemoveBattlefieldBatch('valley');
  assert.equal(removeBatch.edits.length, 1);
  assert.equal(removeBatch.edits[0].kind, 'remove-battlefield');
  assert.equal(removeBatch.edits[0].battlefieldId, 'valley');
});

test('回归：deploy-west 与 river 四条边界对称包含，updateTerrainFeature 阻止破坏通行口引用与自引用改类', () => {
  // deploy-west: [120..380, 150..620]
  for (const pt of [[200, 150], [380, 300], [200, 620], [120, 300], [120, 150], [380, 620]]) {
    assert.equal(checkLocationDeployability(syntheticBattlefield, pt).deployable, true, `deploy-west edge ${pt}`);
    const q = queryTerrainAtPoint(syntheticBattlefield, pt);
    assert.equal(q.deploymentZones.some((f) => f.id === 'deploy-west'), true, `query deploy-west ${pt}`);
  }
  // river: [550..570, 100..650]
  for (const pt of [[560, 100], [570, 300], [560, 650], [550, 300]]) {
    const q = queryTerrainAtPoint(syntheticBattlefield, pt);
    assert.equal(q.obstacles.some((f) => f.id === 'river'), true, `query river edge ${pt}`);
  }

  // 把被 bridge 引用的 obstacle 'river' 改为非障碍类型必须被拒绝
  const river = syntheticBattlefield.terrain.find((f) => f.id === 'river');
  const convertedRiver = {
    id: river.id,
    kind: 'deployment-zone',
    assertion: river.assertion,
    label: river.label,
    area: river.area,
  };
  assert.throws(
    () => updateTerrainFeature(syntheticBattlefield, convertedRiver),
    /bridge|obstacle/,
  );

  // 把 passage 'bridge' 的 obstacleIds 改为不存在或非障碍要素必须被拒绝
  const bridge = syntheticBattlefield.terrain.find((f) => f.id === 'bridge');
  assert.throws(
    () => updateTerrainFeature(syntheticBattlefield, { ...bridge, obstacleIds: ['deploy-west'] }),
    /obstacle/,
  );
  assert.throws(
    () => updateTerrainFeature(syntheticBattlefield, { ...bridge, obstacleIds: ['bridge'] }),
    /obstacle/,
  );
});
