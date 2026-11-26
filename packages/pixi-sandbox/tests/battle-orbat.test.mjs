import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
after(() => server.close());
const {
  buildBattleOrbat,
  collectBattleDescendantIds,
  collectVisibleBattleOrbatUnitIds,
  flattenBattleOrbat,
  parseBattleOrbatBatch,
  summarizeBattlePersonnel,
  toggleBattleOrbatCollapse,
} = await server.ssrLoadModule('/src/battle-orbat.ts');
const {
  syntheticWorkspace,
  expectedPersonnel,
} = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');

const evidence = [{ sourceId: 'test', basis: 'assumption', excerpt: '测试数据', note: '合成' }];
const known = (value) => ({ state: 'known', value, evidence });
const unknown = (reason = '资料未给出') => ({ state: 'unknown', reason, evidence });

function unit(id, parent, count, options = {}) {
  return {
    id,
    color: '#2563eb',
    assertion: 'reported',
    unitName: known(id),
    provinceId: known(null),
    status: known('驻防'),
    parentUnitId: parent === '?' ? unknown('上级资料未给出') : known(parent),
    echelon: known(options.echelon ?? '团'),
    branch: known('步兵'),
    side: known('蓝方'),
    childrenCompleteness: known(options.completeness ?? 'complete'),
    personnel: {
      scope: options.scope ?? 'own',
      count: count === null ? unknown('人数未给出') : known(count),
    },
  };
}

function sampleUnits() {
  return [
    unit('d1', null, 200, { echelon: '师' }),
    unit('d2', null, 200, { echelon: '师' }),
    unit('d3', null, 200, { echelon: '师' }),
    unit('r11', 'd1', 1000),
    unit('r12', 'd1', 1000),
    unit('r13', 'd1', 1000),
    unit('r21', 'd2', 1000),
    unit('r22', 'd2', 1000),
    unit('r23', 'd2', 1000),
    unit('r31', 'd3', 1000),
    unit('r32', 'd3', 1000),
    unit('r33', 'd3', null),
  ];
}

function batchOptions(units = []) {
  let id = 0;
  return {
    units,
    assertion: 'plan',
    sourceId: 'batch-source',
    allocateUnitId: () => `u${++id}`,
  };
}

test('编制树只按 parentUnitId 派生，3 师 9 团保持 ID', () => {
  const units = sampleUnits();
  const orbat = buildBattleOrbat(units);
  assert.equal(orbat.roots.length, 3);
  assert.deepEqual(orbat.roots.map((node) => node.unitId), ['d1', 'd2', 'd3']);
  assert.deepEqual(orbat.roots[0].children.map((node) => node.unitId), ['r11', 'r12', 'r13']);
  assert.equal(orbat.unattached.length, 0);
  assert.deepEqual(
    flattenBattleOrbat(orbat).map((node) => node.unitId).sort(),
    units.map((item) => item.id).sort(),
  );
});

test('折叠/展开只隐藏后代，单位 ID 与父子边不变', () => {
  const orbat = buildBattleOrbat(sampleUnits());
  const all = collectVisibleBattleOrbatUnitIds(orbat, []);
  assert.equal(all.length, 12);
  const collapsed = collectVisibleBattleOrbatUnitIds(orbat, ['d1']);
  assert.equal(collapsed.length, 9);
  assert.ok(!collapsed.includes('r11'));
  assert.ok(collapsed.includes('d2'));
  assert.equal(collectVisibleBattleOrbatUnitIds(orbat, ['d1', 'd2', 'd3']).length, 3);
  assert.deepEqual(collectVisibleBattleOrbatUnitIds(orbat, []), all);
  assert.deepEqual(orbat.roots[0].children.map((node) => node.unitId), ['r11', 'r12', 'r13']);
});

test('折叠视图状态按 unitId 保存并恢复', () => {
  const state = { collapsedUnitIds: [], selectedUnitId: 'd1' };
  const collapsed = toggleBattleOrbatCollapse(state, 'd1');
  assert.deepEqual(collapsed.collapsedUnitIds, ['d1']);
  assert.equal(collapsed.selectedUnitId, 'd1');
  assert.deepEqual(toggleBattleOrbatCollapse(collapsed, 'd1').collapsedUnitIds, []);
});

test('3 师 9 团：总数未知、已知下限 8600、第九团未解', () => {
  const summary = summarizeBattlePersonnel(sampleUnits(), ['d1', 'd2', 'd3']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 8600);
  assert.deepEqual(summary.countedUnitIds,
    ['d1', 'd2', 'd3', 'r11', 'r12', 'r13', 'r21', 'r22', 'r23', 'r31', 'r32']);
  assert.deepEqual(summary.unresolvedUnitIds, ['r33']);
  assert.deepEqual(summary.excludedUnitIds, []);
});

test('与 P0 合成样例互操作，汇总与 expectedPersonnel 一致', () => {
  const orbat = buildBattleOrbat(syntheticWorkspace.garrisons);
  assert.equal(orbat.roots.length, 3);
  const summary = summarizeBattlePersonnel(
    syntheticWorkspace.garrisons,
    ['d1', 'd2', 'd3'],
  );
  assert.equal(summary.total.state, expectedPersonnel.total.state);
  assert.equal(summary.knownMinimum, expectedPersonnel.knownMinimum);
  assert.deepEqual(summary.countedUnitIds, expectedPersonnel.countedUnitIds);
  assert.deepEqual(summary.unresolvedUnitIds, expectedPersonnel.unresolvedUnitIds);
  assert.deepEqual(summary.excludedUnitIds, expectedPersonnel.excludedUnitIds);
});

test('父子同时选中只计一次，重叠根不重复人数', () => {
  const summary = summarizeBattlePersonnel(sampleUnits(), ['d1', 'r11']);
  assert.equal(summary.total.state, 'known');
  assert.equal(summary.total.value, 3200);
  assert.equal(summary.knownMinimum, 3200);
  assert.deepEqual(summary.countedUnitIds, ['d1', 'r11', 'r12', 'r13']);
  assert.deepEqual(summary.excludedUnitIds, []);
  const reversed = summarizeBattlePersonnel(sampleUnits(), ['r11', 'd1']);
  assert.equal(reversed.total.value, 3200);
  assert.equal(reversed.knownMinimum, 3200);
});

test('已知 inclusive 是统计截点，后代不重复累计', () => {
  const units = [
    unit('a', null, 500, { scope: 'inclusive', echelon: '师' }),
    unit('b', 'a', 100),
    unit('c', 'a', 200),
  ];
  const summary = summarizeBattlePersonnel(units, ['a']);
  assert.equal(summary.total.state, 'known');
  assert.equal(summary.total.value, 500);
  assert.equal(summary.knownMinimum, 500);
  assert.deepEqual(summary.countedUnitIds, ['a']);
  assert.deepEqual(summary.excludedUnitIds, ['b', 'c']);
});

test('未知 inclusive 只给已知下限，不把下限当总数', () => {
  const units = [
    unit('a', null, null, { scope: 'inclusive', echelon: '师' }),
    unit('b', 'a', 100),
    unit('c', 'a', null),
  ];
  const summary = summarizeBattlePersonnel(units, ['a']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 100);
  assert.deepEqual(summary.countedUnitIds, ['b']);
  assert.deepEqual(summary.unresolvedUnitIds, ['a', 'c']);
  assert.deepEqual(summary.excludedUnitIds, []);
});

test('legacy-unspecified 不并入跨层下限，原人数列为未解', () => {
  const units = [
    unit('a', null, 1000, { scope: 'legacy-unspecified', echelon: '师' }),
    unit('b', 'a', 100),
  ];
  const summary = summarizeBattlePersonnel(units, ['a']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 100);
  assert.deepEqual(summary.countedUnitIds, ['b']);
  assert.deepEqual(summary.unresolvedUnitIds, ['a']);
});

test('下属完整性 partial 使总数未知，但保留已知下限', () => {
  const units = [
    unit('a', null, 100, { completeness: 'partial', echelon: '师' }),
    unit('b', 'a', 50),
  ];
  const summary = summarizeBattlePersonnel(units, ['a']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 150);
  assert.deepEqual(summary.countedUnitIds, ['a', 'b']);
  assert.deepEqual(summary.unresolvedUnitIds, ['a']);
});

test('未知人数不填 0，保留未解项', () => {
  const summary = summarizeBattlePersonnel([unit('a', null, null)], ['a']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 0);
  assert.deepEqual(summary.countedUnitIds, []);
  assert.deepEqual(summary.unresolvedUnitIds, ['a']);
});

test('请求不存在的根 ID 作为未解项，不生成默认单位', () => {
  const summary = summarizeBattlePersonnel([unit('a', null, 10)], ['missing']);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 0);
  assert.deepEqual(summary.unresolvedUnitIds, ['missing']);
  assert.deepEqual(summary.countedUnitIds, []);
});

test('上级未知/缺失的单位保留为未定隶属，已有子树仍显示', () => {
  const units = [
    unit('a', '?', 100),
    unit('b', 'a', 50),
    unit('c', 'missing-id', 70),
  ];
  const orbat = buildBattleOrbat(units);
  assert.equal(orbat.roots.length, 0);
  assert.deepEqual(orbat.unattached.map((item) => item.node.unitId), ['a', 'c']);
  assert.equal(orbat.unattached[0].reason, 'parent-unknown');
  assert.deepEqual(orbat.unattached[0].node.children.map((node) => node.unitId), ['b']);
  assert.equal(orbat.unattached[1].reason, 'parent-missing');
});

test('编制环不递归、不丢单位；自身上级也按环显示', () => {
  const orbat = buildBattleOrbat([unit('a', 'b', 100), unit('b', 'a', 100)]);
  assert.equal(orbat.roots.length, 0);
  assert.deepEqual(
    orbat.unattached.map((item) => [item.node.unitId, item.reason]),
    [['a', 'cycle'], ['b', 'cycle']],
  );
  assert.equal(flattenBattleOrbat(orbat).length, 2);

  const self = buildBattleOrbat([unit('a', 'a', 100)]);
  assert.equal(self.unattached.length, 1);
  assert.equal(self.unattached[0].reason, 'cycle');
  assert.equal(self.unattached[0].node.unitId, 'a');
});

test('后代查询排除自身，遇到环不递归', () => {
  const units = [unit('a', null, 100), unit('b', 'a', 100), unit('c', 'b', 100)];
  assert.deepEqual(collectBattleDescendantIds(units, 'a'), ['b', 'c']);
  assert.deepEqual(collectBattleDescendantIds(units, 'c'), []);
  const cyclic = [unit('a', 'b', 100), unit('b', 'a', 100)];
  assert.deepEqual(collectBattleDescendantIds(cyclic, 'a'), ['b']);
});

test('重复单位 ID 在公共入口一次报错', () => {
  assert.throws(
    () => buildBattleOrbat([unit('a', null, 1), unit('a', null, 2)]),
    /重复单位 ID/,
  );
});

test('批量录入解析前后向父级、未知人数并生成同批未知部署', () => {
  const text = [
    '# 临时键 | 名称 | 上级 | 层级 | 兵种 | 阵营 | 口径 | 人数 | 完整性',
    'p | 第一师 | - | 师 | 步兵 | 蓝方 | own | 200 | complete',
    'c1 | 第一团 | p | 团 | 步兵 | 蓝方 | own | 1000 | complete',
    'c2 | 第二团 | p | 团 | 步兵 | 蓝方 | own | ? | partial',
  ].join('\n');
  const result = parseBattleOrbatBatch(text, batchOptions());
  assert.deepEqual(result.issues, []);
  assert.equal(result.source.id, 'batch-source');
  assert.equal(result.edits.filter((edit) => edit.kind === 'upsert-unit').length, 3);
  assert.equal(result.edits.filter((edit) => edit.kind === 'set-deployment').length, 3);
  const units = result.edits.filter((edit) => edit.kind === 'upsert-unit').map((edit) => edit.unit);
  assert.equal(units[1].parentUnitId.state, 'known');
  assert.equal(units[1].parentUnitId.value, units[0].id);
  assert.equal(units[2].personnel.count.state, 'unknown');
  assert.equal(units[2].childrenCompleteness.state, 'known');
  assert.equal(units[2].childrenCompleteness.value, 'partial');
  const deployments = result.edits
    .filter((edit) => edit.kind === 'set-deployment')
    .map((edit) => edit.deployment);
  assert.ok(deployments.every((deployment) => deployment.placement.state === 'unknown'));
  assert.ok(deployments.every((deployment) => deployment.reserveForUnitId.state === 'unknown'));
});

test('批量录入任一行无效时整批不产出编辑', () => {
  const text = [
    'a | 甲 | - | 团 | 步兵 | 蓝方 | own | 100 | complete',
    'b | 乙 | a | 团 | 步兵 | 蓝方 | sideways | 100 | complete',
  ].join('\n');
  const result = parseBattleOrbatBatch(text, batchOptions());
  assert.equal(result.edits.length, 0);
  assert.equal(result.source, null);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0].message, /人数口径/);
});

test('批量录入编制环逐行报错且不分配单位 ID', () => {
  const text = [
    'a | 甲 | b | 团 | 步兵 | 蓝方 | own | 100 | complete',
    'b | 乙 | a | 团 | 步兵 | 蓝方 | own | 100 | complete',
  ].join('\n');
  const result = parseBattleOrbatBatch(text, batchOptions());
  assert.equal(result.edits.length, 0);
  assert.ok(result.issues.length >= 1);
  assert.match(result.issues[0].message, /编制环/);
});

test('批量录入临时键与现有单位 ID 冲突时报错', () => {
  const result = parseBattleOrbatBatch(
    'a | 甲 | - | 团 | 步兵 | 蓝方 | own | 100 | complete',
    batchOptions([unit('a', null, 100)]),
  );
  assert.equal(result.edits.length, 0);
  assert.match(result.issues[0].message, /冲突/);
});

test('空批量录入不生成空成功批次', () => {
  const result = parseBattleOrbatBatch('  \n# 只有注释\n', batchOptions());
  assert.equal(result.edits.length, 0);
  assert.equal(result.issues[0].message, '没有可解析的数据行');
});

test('批量录入保留特殊临时键和现有上级 ID', () => {
  const result = parseBattleOrbatBatch([
    '__proto__ | 甲 | - | 团 | 步兵 | 蓝方 | own | 100 | complete',
    'child | 乙 | __proto__ | 营 | 步兵 | 蓝方 | own | 20 | complete',
    'other | 丙 | constructor | 营 | 步兵 | 蓝方 | own | 30 | complete',
  ].join('\n'), batchOptions([unit('constructor', null, 10)]));
  assert.deepEqual(result.issues, []);
  const units = result.edits.filter(edit => edit.kind === 'upsert-unit').map(edit => edit.unit);
  assert.equal(typeof units[0].id, 'string');
  assert.equal(units[1].parentUnitId.value, units[0].id);
  assert.equal(units[2].parentUnitId.value, 'constructor');
  assert.equal(JSON.parse(JSON.stringify(result.unitIdsByKey)).__proto__, units[0].id);
});

test('O 样例批量录入可解析，3 师 9 团汇总下限 8600', async () => {
  const text = await fs.readFile(
    new URL('../work-packages/BATTLE-1/O/samples/batch-entry.txt', import.meta.url),
    'utf8',
  );
  const result = parseBattleOrbatBatch(text, batchOptions());
  assert.deepEqual(result.issues, []);
  const units = result.edits.filter((edit) => edit.kind === 'upsert-unit').map((edit) => edit.unit);
  assert.equal(units.length, 12);
  const roots = units
    .filter((item) => item.parentUnitId.state === 'known' && item.parentUnitId.value === null)
    .map((item) => item.id);
  assert.equal(roots.length, 3);
  const summary = summarizeBattlePersonnel(units, roots);
  assert.equal(summary.total.state, 'unknown');
  assert.equal(summary.knownMinimum, 8600);
  assert.equal(summary.unresolvedUnitIds.length, 1);
});

test('回归：循环上下级单位人数汇总报 unknown 且累计下限，9 列空白末尾 TSV 正常解析为 unknown 完整性', () => {
  const makeCyclic = (id, parentId, countValue) => ({
    id,
    color: '#2563eb',
    assertion: 'reported',
    unitName: { state: 'known', value: id, evidence: [] },
    provinceId: { state: 'known', value: null, evidence: [] },
    status: { state: 'known', value: '驻防', evidence: [] },
    parentUnitId: { state: 'known', value: parentId, evidence: [] },
    echelon: { state: 'known', value: '团', evidence: [] },
    branch: { state: 'known', value: '步兵', evidence: [] },
    side: { state: 'known', value: '蓝方', evidence: [] },
    childrenCompleteness: { state: 'known', value: 'complete', evidence: [] },
    personnel: { scope: 'own', count: { state: 'known', value: countValue, evidence: [] } },
  });

  const cycleSummary = summarizeBattlePersonnel(
    [makeCyclic('A', 'B', 100), makeCyclic('B', 'A', 200)],
    ['A', 'B'],
  );
  assert.equal(cycleSummary.total.state, 'unknown');
  assert.equal(cycleSummary.knownMinimum, 300);
  assert.ok(cycleSummary.unresolvedUnitIds.length >= 1);

  const tsvResult = parseBattleOrbatBatch('k1\t甲团\t-\t团\t步兵\t蓝方\town\t500\t', batchOptions());
  assert.deepEqual(tsvResult.issues, []);
  const created = tsvResult.edits.filter((edit) => edit.kind === 'upsert-unit').map((edit) => edit.unit);
  assert.equal(created.length, 1);
  assert.equal(created[0].childrenCompleteness.state, 'unknown');
});
