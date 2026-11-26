import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const {
  translatePoint,
  translateLine,
  translateMultiPolygon,
  translateDeployment,
  rotateDeploymentFacing,
  rotateDeployment,
  createDeploymentEditBatch,
  BattleEditor,
} = await server.ssrLoadModule('/src/battle-editor.ts');

test('旋转部署实际更新占地面及孔洞，逆向旋转恢复全部坐标', () => {
  const deployment = {
    unitId: 'rotated-area', facingDegrees: { state: 'known', value: 0, evidence: [] },
    placement: { state: 'known', evidence: [], value: { anchor: [1, 1], shape: {
      kind: 'area', area: [[
        [[1, 1], [5, 1], [5, 5], [1, 5], [1, 1]],
        [[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]],
      ]],
    } } },
  };
  const rotated = rotateDeployment(deployment, 90, [1, 1]);
  const ring = rotated.placement.value.shape.area[0][0];
  assert.ok(Math.abs(ring[1][0] - 1) < 1e-10);
  assert.ok(Math.abs(ring[1][1] - 5) < 1e-10);
  assert.equal(rotated.placement.value.shape.area[0].length, 2);
  const restored = rotateDeployment(rotated, -90, [1, 1]);
  restored.placement.value.shape.area[0].forEach((restoredRing, h) => {
    restoredRing.forEach((point, i) => point.forEach((value, axis) => {
      assert.ok(Math.abs(value - deployment.placement.value.shape.area[0][h][i][axis]) < 1e-10);
    }));
  });
  assert.equal(restored.facingDegrees.value, 0);
  assert.deepEqual(deployment.placement.value.shape.area[0][0][1], [5, 1]);
});

test('同组单位共用旋转支点，正面线与锚点同步更新且保留相对位置', () => {
  const makeDeployment = (unitId, x) => ({
    unitId, facingDegrees: { state: 'known', value: 0, evidence: [] },
    placement: { state: 'known', evidence: [], value: { anchor: [x, 0],
      shape: { kind: 'frontage', line: [[x, 0], [x + 2, 0]] } } },
  });
  const workspace = { battle: { deployments: [makeDeployment('one', 0), makeDeployment('two', 10)] } };
  let batch;
  const editor = new BattleEditor({ getWorkspace: () => workspace, applyBatch: value => { batch = value; } });
  editor.selectUnits(['one', 'two']);
  editor.commitRotation(90);
  const [first, second] = batch.edits.map(edit => edit.deployment.placement.value);
  assert.ok(Math.abs(first.anchor[0] - 5) < 1e-10);
  assert.ok(Math.abs(first.anchor[1] + 5) < 1e-10);
  assert.ok(Math.abs(second.anchor[0] - 5) < 1e-10);
  assert.ok(Math.abs(second.anchor[1] - 5) < 1e-10);
  assert.ok(Math.abs(first.shape.line[1][1] + 3) < 1e-10);
  assert.deepEqual(workspace.battle.deployments[0].placement.value.anchor, [0, 0]);
});

test('全部未定位时不生成旋转支点或提交虚构坐标', () => {
  const workspace = { battle: { deployments: [
    { unitId: 'unknown', placement: { state: 'unknown', reason: '未定位', evidence: [] } },
  ] } };
  let calls = 0;
  const editor = new BattleEditor({ getWorkspace: () => workspace, applyBatch: () => { calls++; } });
  editor.selectUnits(['unknown']);
  editor.commitRotation(90);
  assert.equal(calls, 0);
});

const {
  syntheticWorkspace,
} = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');

test('translatePoint & Line & MultiPolygon: 纯几何平移计算正确', () => {
  assert.deepEqual(translatePoint([10, 20], [5, -5]), [15, 15]);
  assert.deepEqual(
    translateLine([[0, 0], [10, 10]], [2, 3]),
    [[2, 3], [12, 13]]
  );
  assert.deepEqual(
    translateMultiPolygon([[[[0, 0], [10, 0], [10, 10], [0, 0]]]], [1, 1]),
    [[[[1, 1], [11, 1], [11, 11], [1, 1]]]]
  );
});

test('translateDeployment: 正确平移 point 形态部署', () => {
  const d1Dep = syntheticWorkspace.battle.deployments.find((d) => d.unitId === 'd1');
  const moved = translateDeployment(d1Dep, [30, -20]);

  assert.deepEqual(moved.placement.value.anchor, [230, 580]);
  assert.equal(moved.placement.value.shape.kind, 'point');
});

test('translateDeployment: 正确平移 frontage 折线形态部署', () => {
  const r12Dep = syntheticWorkspace.battle.deployments.find((d) => d.unitId === 'r12');
  assert.equal(r12Dep.placement.value.shape.kind, 'frontage');

  const moved = translateDeployment(r12Dep, [10, 10]);
  assert.deepEqual(moved.placement.value.anchor, [250, 210]);
  assert.deepEqual(
    moved.placement.value.shape.line,
    [[220, 190], [280, 190]]
  );
});

test('translateDeployment: 正确平移 area 多边形形态部署', () => {
  const r11Dep = syntheticWorkspace.battle.deployments.find((d) => d.unitId === 'r11');
  assert.equal(r11Dep.placement.value.shape.kind, 'area');

  const moved = translateDeployment(r11Dep, [-10, 5]);
  assert.deepEqual(moved.placement.value.anchor, [150, 205]);
  const poly = moved.placement.value.shape.area[0][0];
  assert.deepEqual(poly[0], [120, 185]);
});

test('rotateDeploymentFacing: 朝向角度按顺时针旋转并规范化至 [0, 360)', () => {
  const d1Dep = syntheticWorkspace.battle.deployments.find((d) => d.unitId === 'd1');
  assert.equal(d1Dep.facingDegrees.value, 0);

  const r90 = rotateDeploymentFacing(d1Dep, 90);
  assert.equal(r90.facingDegrees.value, 90);

  const rMinus45 = rotateDeploymentFacing(d1Dep, -45);
  assert.equal(rMinus45.facingDegrees.value, 315);

  const r370 = rotateDeploymentFacing(d1Dep, 370);
  assert.equal(r370.facingDegrees.value, 10);
});

test('BattleEditor 控制器: 选中、拖动提交批次、旋转提交批次、标牌避让', () => {
  let submittedBatch = null;
  let refreshed = false;

  const editor = new BattleEditor({
    applyBatch: (batch) => {
      submittedBatch = batch;
    },
    getWorkspace: () => syntheticWorkspace,
    onRefresh: () => {
      refreshed = true;
    },
  });

  // 1. 选中测试
  editor.selectUnits(['r11', 'r12']);
  assert.deepEqual(editor.getSelection().sort(), ['r11', 'r12']);
  assert.ok(refreshed);

  // 2. 拖动测试
  refreshed = false;
  editor.commitDrag([15, 25]);
  assert.ok(refreshed);
  assert.ok(submittedBatch !== null);
  assert.equal(submittedBatch.origin, 'manual');
  assert.equal(submittedBatch.edits.length, 2);
  assert.equal(submittedBatch.edits[0].kind, 'set-deployment');

  // 3. 旋转测试
  submittedBatch = null;
  editor.commitRotation(45);
  assert.ok(submittedBatch !== null);
  assert.equal(submittedBatch.edits.length, 2);
  assert.equal(submittedBatch.edits[0].deployment.facingDegrees.value, 45);

  // 4. 标牌避让微调（不触发批次提交，仅在内存记录）
  submittedBatch = null;
  editor.setBadgeOffset('r11', [10, -5]);
  assert.deepEqual(editor.badgeOffsets.get('r11'), [10, -5]);
  assert.equal(submittedBatch, null); // 严格遵守契约：避让不提交为实际坐标！
});

test('回归：极小负浮点偏移不会产生 360° 朝向，未部署单位不参与拖动/旋转提交', () => {
  const depZero = {
    unitId: 'zero-facing',
    facingDegrees: { state: 'known', value: 0, evidence: [] },
    placement: { state: 'unknown', reason: '未部署', evidence: [] },
  };
  const rotatedNeg = rotateDeploymentFacing(depZero, -1e-15);
  assert.ok(rotatedNeg.facingDegrees.value >= 0 && rotatedNeg.facingDegrees.value < 360);
  assert.equal(rotatedNeg.facingDegrees.value, 0);

  const rotatedWrap = rotateDeploymentFacing(depZero, 360 - 1e-16);
  assert.ok(rotatedWrap.facingDegrees.value >= 0 && rotatedWrap.facingDegrees.value < 360);
  assert.equal(rotatedWrap.facingDegrees.value, 0);

  const rotatedSubOne = rotateDeploymentFacing(depZero, 360 - 1e-13);
  assert.ok(rotatedSubOne.facingDegrees.value >= 0 && rotatedSubOne.facingDegrees.value < 360);

  let submittedBatch = null;
  const editor = new BattleEditor({
    applyBatch: (batch) => { submittedBatch = batch; },
    getWorkspace: () => syntheticWorkspace,
    onRefresh: () => {},
  });

  // 仅选中未部署单位 r33 时不应提交空批次
  editor.selectUnits(['r33']);
  editor.commitDrag([12, -8]);
  assert.equal(submittedBatch, null);
  editor.commitRotation(30);
  assert.equal(submittedBatch, null);

  // 混合选中已部署 r11 与未部署 r33 时，仅提交 r11
  editor.selectUnits(['r11', 'r33']);
  editor.commitDrag([10, 5]);
  assert.deepEqual(submittedBatch.edits.map((e) => e.deployment.unitId), ['r11']);
  submittedBatch = null;
  editor.commitRotation(20);
  assert.deepEqual(submittedBatch.edits.map((e) => e.deployment.unitId), ['r11']);
});
