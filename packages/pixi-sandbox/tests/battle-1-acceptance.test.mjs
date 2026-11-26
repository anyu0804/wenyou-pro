import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const { syntheticWorkspace } = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');
const cases = await server.ssrLoadModule('/work-packages/BATTLE-1/D/samples/deployment-cases.ts');
const { calculateBattleDeployment } = await server.ssrLoadModule('/src/battle-deployment.ts');
const {
  buildBattleOrbat, collectBattleDescendantIds, summarizeBattlePersonnel, createUnplacedBattleDeployment,
} = await server.ssrLoadModule('/src/battle-orbat.ts');
const {
  getBattlefield, getPassagesForObstacle, queryTerrainAtPoint,
} = await server.ssrLoadModule('/src/battle-terrain.ts');
const { validateBattleWorkspace } = await server.ssrLoadModule('/src/battle-storage.ts');
const { parseBattleCandidates, selectBattleCandidates } = await server.ssrLoadModule('/src/battle-import.ts');
const { previewBattleEdits } = await server.ssrLoadModule('/src/battle-actions.ts');
const fs = await import('node:fs/promises');

const evidence = [{ sourceId: 'setting', basis: 'assumption', excerpt: 'G 包合成验收', note: '仅用于验收，不是世界事实' }];
const known = (value) => ({ state: 'known', value, evidence });
const unknown = (reason) => ({ state: 'unknown', reason, evidence });

test('S1 开阔地：3 师 9 团，两梯队与预备队可由合成请求确定生成', () => {
  const workspace = syntheticWorkspace;
  const orbat = buildBattleOrbat(workspace.garrisons);
  assert.equal(orbat.roots.length, 3);
  assert.equal(orbat.unattached.length, 0);
  for (const division of orbat.roots) assert.equal(division.children.length, 3);
  assert.equal(orbat.roots.reduce((sum, division) => sum + 1 + division.children.length, 0), 12);

  const result = calculateBattleDeployment(workspace, cases.successRequest);
  assert.equal(result.outcome, 'placed');
  assert.deepEqual(result.deployments.map(deployment => deployment.unitId), ['r11', 'r12', 'r13']);
  assert.equal(result.deployments.find(deployment => deployment.unitId === 'r13').formationLine.value, 2);
  assert.equal(result.deployments.find(deployment => deployment.unitId === 'r13').role.value, 'reserve');

  const summary = summarizeBattlePersonnel(workspace.garrisons, ['d1', 'd2', 'd3']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 8600);
  assert.deepEqual(summary.unresolvedUnitIds, ['r33']);
});

test('S2 河谷与狭口：正面不足报冲突，障碍与通行口语义保持区分', () => {
  const conflict = calculateBattleDeployment(syntheticWorkspace, cases.narrowFrontRequest);
  assert.equal(conflict.outcome, 'conflict');
  assert.deepEqual(conflict.issues.map(issue => issue.code), ['insufficient-frontage']);
  assert.deepEqual(conflict.issues[0].unitIds, ['r11', 'r12']);
  assert.equal('deployments' in conflict, false);

  const obstacle = calculateBattleDeployment(syntheticWorkspace, cases.obstacleRequest);
  assert.equal(obstacle.outcome, 'conflict');
  assert.deepEqual(obstacle.issues.map(issue => issue.code), ['obstacle-intersection']);
  assert.deepEqual(obstacle.issues[0].terrainIds, ['river']);

  const battlefield = getBattlefield(syntheticWorkspace, 'valley');
  const passages = getPassagesForObstacle(battlefield, 'river');
  assert.equal(passages.length, 1);
  assert.equal(passages[0].kind, 'passage');
  assert.equal(passages[0].passageKind, 'bridge');
  assert.equal(queryTerrainAtPoint(battlefield, [560, 500]).passages.length, 1);
  assert.equal(queryTerrainAtPoint(battlefield, [560, 300]).obstacles.length, 1);
});

test('S3 缺项：未知位置/人数保持未知，手工补齐后才进入已知，JSON 往返不丢语义', () => {
  validateBattleWorkspace(syntheticWorkspace);
  const missing = syntheticWorkspace.garrisons.find(unit => unit.id === 'r33');
  assert.equal(missing.unitName.evidence.length > 0, true);
  assert.equal(missing.personnel.count.state, 'unknown');
  const deployment = syntheticWorkspace.battle.deployments.find(item => item.unitId === 'r33');
  assert.equal(deployment.placement.state, 'unknown');

  const filled = structuredClone(syntheticWorkspace);
  const filledUnit = filled.garrisons.find(unit => unit.id === 'r33');
  filledUnit.personnel.count = known(900);
  const filledDeployment = filled.battle.deployments.find(item => item.unitId === 'r33');
  filledDeployment.placement = known({ anchor: [300, 500], shape: { kind: 'point' } });
  validateBattleWorkspace(filled);
  assert.equal(filledUnit.personnel.count.value, 900);

  const roundTrip = JSON.parse(JSON.stringify(filled));
  validateBattleWorkspace(roundTrip);
  assert.equal(roundTrip.battle.deployments.find(item => item.unitId === 'r33').placement.value.anchor[0], 300);
  assert.equal(syntheticWorkspace.battle.deployments.find(item => item.unitId === 'r33').placement.state, 'unknown');
});

test('180 个团：编制树、唯一部署与兵力汇总在 240 个单位下保持一致', () => {
  const units = [];
  const deployments = [];
  const divisionIds = [];
  for (let division = 1; division <= 60; division += 1) {
    const divisionId = `d${division}`;
    divisionIds.push(divisionId);
    units.push({
      id: divisionId, assertion: 'plan', color: '#2563eb', unitName: known(`第${division}师`),
      provinceId: known(null), status: known('驻防'), parentUnitId: known(null), echelon: known('师'),
      branch: known('步兵'), side: known('蓝方'), childrenCompleteness: known('complete'),
      personnel: { scope: 'own', count: known(100) },
    });
    deployments.push(createUnplacedBattleDeployment(divisionId, 'plan', evidence, '合成容量样例未给位置'));
    for (let regiment = 1; regiment <= 3; regiment += 1) {
      const regimentId = `r${division}-${regiment}`;
      units.push({
        id: regimentId, assertion: 'plan', color: '#2563eb', unitName: known(`第${division}师第${regiment}团`),
        provinceId: known(null), status: known('驻防'), parentUnitId: known(divisionId), echelon: known('团'),
        branch: known('步兵'), side: known('蓝方'), childrenCompleteness: known('complete'),
        personnel: { scope: 'own', count: known(500) },
      });
      deployments.push(createUnplacedBattleDeployment(regimentId, 'plan', evidence, '合成容量样例未给位置'));
    }
  }
  const workspace = {
    mapId: 'synthetic-capacity-180', garrisons: units,
    battle: { schemaVersion: 1, sources: syntheticWorkspace.battle.sources, battlefields: [], deployments },
  };
  validateBattleWorkspace(workspace);
  const orbat = buildBattleOrbat(units);
  assert.equal(orbat.roots.length, 60);
  assert.equal(orbat.unattached.length, 0);
  assert.equal(orbat.roots.flatMap(division => division.children).length, 180);
  assert.equal(collectBattleDescendantIds(units, 'd60').length, 3);
  assert.equal(summarizeBattlePersonnel(units, divisionIds).total.value, 96_000);
  assert.equal(new Set(deployments.map(deployment => deployment.unitId)).size, 240);
});

test('AI 候选：固定原文解析出 1 个可应用项与 1 个未解项，应用只改选中对象', async () => {
  const text = await fs.readFile(new URL('../work-packages/BATTLE-1/A/samples/river-valley-candidates.json', import.meta.url), 'utf8');
  const batch = parseBattleCandidates(text, syntheticWorkspace);
  assert.equal(batch.items.filter(item => item.state === 'ready').length, 1);
  assert.equal(batch.items.filter(item => item.state === 'unresolved').length, 1);
  assert.equal(batch.items.find(item => item.id === 'candidate-r33').state, 'unresolved');

  const editBatch = selectBattleCandidates(batch, ['candidate-r13'], syntheticWorkspace);
  const after = previewBattleEdits(syntheticWorkspace, editBatch);
  validateBattleWorkspace(after);
  const r13 = after.battle.deployments.find(deployment => deployment.unitId === 'r13');
  assert.deepEqual(r13.placement.value.anchor, [220, 320]);
  assert.equal(after.garrisons.find(unit => unit.id === 'r33').personnel.count.state, 'unknown');
  assert.equal(after.battle.sources.some(source => source.id === 'ai-draft'), true);
  assert.equal(syntheticWorkspace.battle.deployments.find(deployment => deployment.unitId === 'r13').placement.value.anchor[0], 200);
});
