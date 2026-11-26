import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const importer = await server.ssrLoadModule('/src/battle-import.ts');
const actions = await server.ssrLoadModule('/src/battle-actions.ts');
const { appStore } = await server.ssrLoadModule('/src/store.ts');
const sample = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');
const workspace = () => structuredClone(sample.syntheticWorkspace);
const candidate = () => structuredClone(sample.syntheticCandidate);
const parse = (value, state = workspace()) => importer.parseBattleCandidates(JSON.stringify(value), state);

test('非法 JSON、格式、版本、地图身份和候选结构在入口拒绝', () => {
  assert.throws(() => importer.parseBattleCandidates('{invalid', workspace()), SyntaxError);
  for (const [key, value, path] of [
    ['format', 'other', /\$\.format/], ['version', 2, /\$\.version/],
    ['mapId', 'other-map', /\$\.mapId/], ['sources', {}, /\$\.sources/], ['items', null, /\$\.items/],
  ]) {
    const input = candidate();
    input[key] = value;
    assert.throws(() => parse(input), path);
  }
  const invalid = candidate();
  invalid.items[0].instruction = '';
  assert.throws(() => parse(invalid), /items\[0\]\.instruction/);
});

test('混合 ready 与 unresolved 保留未知信息，解析不改输入工作区', () => {
  const state = workspace();
  const before = structuredClone(state);
  const parsed = parse(candidate(), state);
  assert.deepEqual(parsed, candidate());
  assert.deepEqual(state, before);
  assert.equal(parsed.items[1].state, 'unresolved');
  assert.match(parsed.items[1].reason, /人数也未给出/);
  const ninth = state.garrisons.find(unit => unit.id === 'r33');
  assert.equal(ninth.personnel.count.state, 'unknown');
  assert.equal('value' in ninth.personnel.count, false);
});

test('来源引用、来源内容与字段类型经真实状态校验器拒绝', () => {
  const badItemSource = candidate();
  badItemSource.items[0].evidence[0].sourceId = 'missing-source';
  assert.throws(() => parse(badItemSource), /evidence\[0\]\.sourceId/);
  const badFieldSource = candidate();
  badFieldSource.items[0].edits[0].deployment.placement.evidence = structuredClone(badFieldSource.items[0].edits[0].deployment.placement.evidence);
  badFieldSource.items[0].edits[0].deployment.placement.evidence[0].sourceId = 'missing-source';
  assert.throws(() => parse(badFieldSource), /deployment\.placement\.evidence/);
  const badSourceType = candidate();
  badSourceType.sources[0].kind = 'invented-kind';
  assert.throws(() => parse(badSourceType), /source/);
  const badPayload = candidate();
  badPayload.items[0].edits[0].deployment.facingDegrees.value = 360;
  assert.throws(() => parse(badPayload), /facingDegrees/);
  const unknownUnit = candidate();
  unknownUnit.items[0].edits[0].deployment.unitId = 'missing-unit';
  assert.throws(() => parse(unknownUnit), /deployment\.unitId/);
});

test('来源 ID 不能覆盖既有原文，未解项不能暗藏编辑', () => {
  const collision = candidate();
  collision.sources.push({ ...workspace().battle.sources[0], text: '改写旧来源' });
  assert.throws(() => parse(collision), /已有来源 ID 的内容不同/);
  const hidden = candidate();
  hidden.items[1].edits = [hidden.items[0].edits[0]];
  assert.throws(() => parse(hidden), /待补项不能包含/);
  const badKind = candidate();
  badKind.items[0].edits[0].kind = 'teleport-army';
  assert.throws(() => parse(badKind), /不支持的编辑种类/);
});

test('重复来源/候选 ID 与同项重复编辑被拒绝，坏载荷不能被后续覆盖隐藏', () => {
  const sources = candidate();
  sources.sources.push(structuredClone(sources.sources[0]));
  assert.throws(() => parse(sources), /来源 ID 重复/);
  const items = candidate();
  items.items[1].id = items.items[0].id;
  assert.throws(() => parse(items), /候选 ID 重复/);
  const overwrite = candidate();
  const bad = structuredClone(overwrite.items[0].edits[0]);
  delete bad.deployment.placement;
  overwrite.items[0].edits.unshift(bad);
  assert.throws(() => parse(overwrite), /重复修改同一对象/);
});

test('部分选中只包含接受项及其所需来源，未选来源不提交', () => {
  const value = candidate();
  const otherSource = { id: 'not-selected', kind: 'ai', title: '未选人数候选', text: '合成方案：第九团为900人', locator: null };
  value.sources.push(otherSource);
  const evidence = [{ sourceId: otherSource.id, basis: 'assumption', excerpt: otherSource.text, note: '测试用明确假设' }];
  const ninth = structuredClone(workspace().garrisons.find(unit => unit.id === 'r33'));
  ninth.personnel.count = { state: 'known', value: 900, evidence };
  value.items.push({ id: 'count-r33', state: 'ready', instruction: '合成假设人数', evidence,
    edits: [{ kind: 'upsert-unit', unit: ninth }] });
  const state = workspace();
  const parsed = parse(value, state);
  const selected = importer.selectBattleCandidates(parsed, ['candidate-r13'], state);
  assert.deepEqual(selected.candidateItemIds, ['candidate-r13']);
  assert.equal(selected.origin, 'candidate');
  assert.deepEqual(selected.edits.map(edit => edit.kind), ['upsert-source', 'set-deployment']);
  assert.equal(selected.edits[0].source.id, 'ai-draft');
  assert.equal(selected.edits.some(edit => edit.kind === 'upsert-source' && edit.source.id === 'not-selected'), false);
  const after = actions.previewBattleEdits(state, selected);
  assert.equal(after.garrisons.find(unit => unit.id === 'r33').personnel.count.state, 'unknown');
  assert.deepEqual(after.battle.deployments.find(deployment => deployment.unitId === 'r13').placement.value.anchor, [220, 320]);
  assert.equal(state.battle.sources.some(source => source.id === 'ai-draft'), false);
});

test('空选、待补项、未知项和跨地图选择不能提交', () => {
  const state = workspace();
  const parsed = parse(candidate(), state);
  for (const ids of [[], ['candidate-r33'], ['not-found'], ['candidate-r13', 'candidate-r13']]) {
    assert.throws(() => importer.selectBattleCandidates(parsed, ids, state), /selection/);
  }
  const otherMap = workspace();
  otherMap.mapId = 'different-map';
  assert.throws(() => importer.selectBattleCandidates(parsed, ['candidate-r13'], otherMap), /已切换战区/);
});

test('重叠候选可审阅，选择同时覆盖同一对象时明确报冲突', () => {
  const value = candidate();
  const alternative = structuredClone(value.items[0]);
  alternative.id = 'alternative-r13';
  alternative.edits[0].deployment.placement.value.anchor = [240, 340];
  value.items.push(alternative);
  const state = workspace();
  const parsed = parse(value, state);
  assert.throws(() => importer.selectBattleCandidates(parsed, ['candidate-r13', 'alternative-r13'], state), /重复修改同一对象/);
  assert.doesNotThrow(() => importer.selectBattleCandidates(parsed, ['alternative-r13'], state));
});

test('新建单位必须与其部署组成原子项，不猜省份中心或补坐标', () => {
  const value = candidate();
  const unit = structuredClone(workspace().garrisons[0]);
  unit.id = 'new-headquarters';
  value.items[0].edits = [{ kind: 'upsert-unit', unit }];
  assert.throws(() => parse(value), /每单位必须有一条/);
  const deployment = structuredClone(workspace().battle.deployments[0]);
  deployment.unitId = unit.id;
  deployment.placement = { state: 'unknown', reason: '没有确切位置', evidence: [] };
  value.items[0].edits.push({ kind: 'set-deployment', deployment });
  const parsed = parse(value);
  const selected = importer.selectBattleCandidates(parsed, ['candidate-r13'], workspace());
  const after = actions.previewBattleEdits(workspace(), selected);
  assert.equal(after.battle.deployments.find(item => item.unitId === unit.id).placement.state, 'unknown');
});

test('取消草案前已做的解析与多次预览均不写状态或历史', () => {
  const state = workspace();
  const before = structuredClone(state);
  const historyBefore = actions.battleHistoryAvailability();
  let pending = parse(candidate(), state);
  const selected = importer.selectBattleCandidates(pending, ['candidate-r13'], state);
  const after = actions.previewBattleEdits(state, selected);
  assert.notDeepEqual(after, state);
  actions.previewBattleEdits(state, selected);
  pending = null; // 取消只是丢弃候选，不调用 applyBattleEdits。
  assert.equal(pending, null);
  assert.deepEqual(state, before);
  assert.deepEqual(actions.battleHistoryAvailability(), historyBefore);
});

test('真实统一提交将来源和编辑同批应用，撤销恢复两者', () => {
  const beforeStore = structuredClone(actions.getBattleWorkspace());
  const state = workspace();
  appStore.mapId = state.mapId;
  appStore.garrisons = state.garrisons;
  appStore.battle = state.battle;
  actions.resetBattleHistory();
  const parsed = parse(candidate(), actions.getBattleWorkspace());
  const selected = importer.selectBattleCandidates(parsed, ['candidate-r13'], actions.getBattleWorkspace());
  const receipt = actions.applyBattleEdits(selected);
  assert.equal(receipt.origin, 'candidate');
  assert.deepEqual(receipt.candidateItemIds, ['candidate-r13']);
  assert.equal(appStore.battle.sources.some(source => source.id === 'ai-draft'), true);
  assert.deepEqual(appStore.battle.deployments.find(item => item.unitId === 'r13').placement.value.anchor, [220, 320]);
  actions.undoBattleEdit();
  assert.deepEqual(actions.getBattleWorkspace(), state);
  assert.equal(appStore.battle.sources.some(source => source.id === 'ai-draft'), false);
  appStore.mapId = beforeStore.mapId;
  appStore.garrisons = beforeStore.garrisons;
  appStore.battle = beforeStore.battle;
  actions.resetBattleHistory();
});

test('当前战区任务模板保留真实稳定 ID、来源、未知和局部尺度，响应模板可直接解析', () => {
  const state = workspace();
  const template = importer.createBattleAiTemplate(state);
  assert.equal(template.mapId, state.mapId);
  assert.deepEqual(template.workspace, state);
  assert.notEqual(template.workspace, state);
  assert.equal(template.workspace.garrisons.find(unit => unit.id === 'r33').personnel.count.state, 'unknown');
  assert.match(template.instructions.join('\n'), /未校准不能转换米/);
  assert.match(template.instructions.join('\n'), /不是已核验史实/);
  const response = parse(template.responseTemplate, state);
  assert.equal(response.items[0].state, 'unresolved');
});

test('public 合成示例不接受其他地图身份', async () => {
  const contents = await readFile(new URL('../public/battle-ai-template.json', import.meta.url), 'utf8');
  const parsed = importer.parseBattleCandidates(contents, workspace());
  assert.equal(parsed.items[0].state, 'unresolved');
  const realState = workspace();
  realState.mapId = 'real-user-map';
  assert.throws(() => importer.parseBattleCandidates(contents, realState), /文件与当前战区不一致/);
});

test('A 包自带候选样例可解析并可选中，声明来源与引用一致', async () => {
  const contents = await readFile(new URL('../work-packages/BATTLE-1/A/samples/river-valley-candidates.json', import.meta.url), 'utf8');
  const state = workspace();
  const parsed = importer.parseBattleCandidates(contents, state);
  assert.deepEqual(parsed.items.map(item => item.state), ['ready', 'unresolved']);
  assert.deepEqual(parsed.sources.map(source => source.id), ['ai-draft', 'plan']);
  const selected = importer.selectBattleCandidates(parsed, ['candidate-r13'], state);
  assert.deepEqual(selected.edits.map(edit => edit.kind), ['upsert-source', 'upsert-source', 'set-deployment']);
  const after = actions.previewBattleEdits(state, selected);
  assert.deepEqual(after.battle.deployments.find(deployment => deployment.unitId === 'r13').placement.value.anchor, [220, 320]);
});

test('回归：多条候选共享同一新来源合并提交成功；同一批 remove-unit 与 set-deployment 冲突被拒绝', () => {
  const base = candidate();
  const depR21 = structuredClone(base.items[0].edits[0].deployment);
  depR21.unitId = 'r21';
  base.items.push({
    id: 'candidate-r21',
    state: 'ready',
    instruction: '共享同一来源部署 r21',
    evidence: structuredClone(base.items[0].evidence),
    edits: [{ kind: 'set-deployment', deployment: depR21 }],
  });
  const state = workspace();
  const parsed = parse(base, state);
  const selected = importer.selectBattleCandidates(parsed, ['candidate-r13', 'candidate-r21'], state);
  assert.equal(selected.edits.filter(e => e.kind === 'upsert-source').length, 1);
  assert.equal(selected.edits.filter(e => e.kind === 'set-deployment').length, 2);
  const preview = actions.previewBattleEdits(state, selected);
  assert.equal(preview.battle.deployments.find(d => d.unitId === 'r21').placement.state, 'known');

  const conflict = candidate();
  conflict.items.push({
    id: 'remove-r13',
    state: 'ready',
    instruction: '同批删除已部署的 r13',
    evidence: structuredClone(conflict.items[0].evidence),
    edits: [{ kind: 'remove-unit', unitId: 'r13' }],
  });
  const parsedConflict = parse(conflict, state);
  assert.throws(
    () => importer.selectBattleCandidates(parsedConflict, ['candidate-r13', 'remove-r13'], state),
    /冲突|重复|remove-unit/,
  );
});
