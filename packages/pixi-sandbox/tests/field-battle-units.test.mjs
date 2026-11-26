import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const {
  copyBattleUnitsIntoField,
  renameFieldBattle,
  removeFieldBattle,
} = await server.ssrLoadModule('/src/field-battle-units.ts');
const {
  applyFieldBattleBatch,
  undoFieldBattle,
  redoFieldBattle,
  resetFieldBattleHistory,
} = await server.ssrLoadModule('/src/field-battle-history.ts');
const { validateFieldBattle, validateFieldBattles } = await server.ssrLoadModule('/src/field-battle-validate.ts');

const sample = JSON.parse(await readFile(new URL('./fixtures/field-battle/sample.json', import.meta.url), 'utf8'));

const known = (value, evidence = []) => ({ state: 'known', value, evidence });
const unknown = (reason, evidence = []) => ({ state: 'unknown', reason, evidence });
const evidence = (sourceId) => [{ sourceId, basis: 'assumption', excerpt: '测试证据', note: '合成数据' }];

function makeUnit(id, options = {}) {
  return {
    id,
    color: '#cc4444',
    assertion: 'plan',
    unitName: known(options.unitName ?? id, options.unitEvidence ?? []),
    provinceId: known(null),
    status: known('驻防'),
    parentUnitId: options.parent === undefined ? known(null) : known(options.parent),
    echelon: known('团'),
    branch: known('步兵'),
    side: known('演示方'),
    childrenCompleteness: known('complete'),
    personnel: { scope: 'own', count: known(1000) },
  };
}

function makeDeployment(unitId, placement, options = {}) {
  return {
    unitId,
    assertion: 'plan',
    battlefieldId: options.battlefieldId ?? known(null),
    placement,
    facingDegrees: known(90),
    depthMapUnits: known(4),
    formationLine: known(1),
    role: options.role ?? known('line'),
    reserveForUnitId: options.reserveForUnitId ?? known(null),
  };
}

// 三个相邻方形地块；只有 0、1 被选中。
const map = {
  cells: {
    polygons: [
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[10, 0], [20, 0], [20, 10], [10, 10]],
      [[20, 0], [30, 0], [30, 10], [20, 10]],
    ],
  },
};

function copyFixture() {
  const s1 = 'copy-source-1';
  const s2 = 'copy-source-2';
  const s3 = 'copy-source-3';
  const s4 = 'copy-source-4';
  const units = [
    makeUnit('main-1', { parent: 'main-4', unitEvidence: evidence(s1) }),
    makeUnit('main-2', { parent: 'main-1' }),
    makeUnit('main-3'),
    makeUnit('main-4'),
  ];
  const battle = {
    schemaVersion: 1,
    sources: [
      { id: s1, kind: 'reference', title: '来源一', text: '一', locator: null },
      { id: s2, kind: 'reference', title: '来源二', text: '二', locator: null },
      { id: s3, kind: 'reference', title: '来源三', text: '三', locator: null },
      { id: s4, kind: 'reference', title: '来源四', text: '四', locator: null },
    ],
    battlefields: [],
    deployments: [
      makeDeployment('main-1', known({ anchor: [5, 5], shape: { kind: 'point' } }), {
        battlefieldId: known('main-battlefield-1'),
      }),
      makeDeployment('main-2', known({ anchor: [15, 5], shape: { kind: 'point' } }), {
        role: known('reserve', evidence(s2)),
        reserveForUnitId: known('main-1'),
      }),
      makeDeployment('main-3', unknown('位置未知', evidence(s3))),
      makeDeployment('main-4', known({ anchor: [25, 5], shape: { kind: 'point' } }), {
        role: known('line', evidence(s4)),
      }),
    ],
  };
  return { units, battle, s1, s2 };
}

test('复制只纳入已知位置且在选区内的单位，并建立新 ID 与引用映射', () => {
  const { units, battle, s1, s2 } = copyFixture();
  const result = copyBattleUnitsIntoField(map, new Set([0, 1]), units, battle);

  assert.equal(result.skippedUnknown, 1);
  assert.deepEqual(result.units.map((unit) => unit.sourceUnitId), ['main-1', 'main-2']);
  assert.equal(result.deployments.length, 2);
  for (const unit of result.units) {
    assert.match(unit.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(unit.id, unit.sourceUnitId);
  }
  assert.notEqual(result.units[0].id, result.units[1].id);
  assert.equal(result.units[1].parentUnitId.state, 'known');
  assert.equal(result.units[1].parentUnitId.value, result.units[0].id);
  assert.equal(result.deployments[1].reserveForUnitId.state, 'known');
  assert.equal(result.deployments[1].reserveForUnitId.value, result.units[0].id);
  assert.deepEqual(result.deployments.map((deployment) => deployment.unitId), result.units.map((unit) => unit.id));

  // 指向选区外单位的上级、以及主地图战役引用都降级为 unknown，原 id 只出现在 reason。
  assert.equal(result.units[0].parentUnitId.state, 'unknown');
  assert.match(result.units[0].parentUnitId.reason, /main-4/);
  assert.equal(result.deployments[0].battlefieldId.state, 'unknown');
  assert.match(result.deployments[0].battlefieldId.reason, /main-battlefield-1/);
  assert.deepEqual(result.deployments[0].battlefieldId.evidence, []);
  assert.equal(result.deployments[1].battlefieldId.state, 'known');
  assert.equal(result.deployments[1].battlefieldId.value, null);

  // 只复制被证据引用的来源；未被引用的来源不进入快照。
  assert.deepEqual(result.sources.map((source) => source.id), [s1, s2]);

  // 深拷贝且不回写输入。
  assert.notEqual(result.units[0], units[0]);
  assert.notEqual(result.units[0].unitName, units[0].unitName);
  assert.notEqual(result.sources[0], battle.sources[0]);
  assert.equal(units[0].id, 'main-1');
  assert.equal(battle.deployments[0].unitId, 'main-1');
  assert.equal(battle.deployments[0].battlefieldId.value, 'main-battlefield-1');
});

test('applyFieldBattleBatch 删除单位时解除引用，undo/redo 恢复整个批次', () => {
  const battle = structuredClone(sample);
  const newSource = { id: 'field-source-2', kind: 'manual', title: '新增来源', text: '新增来源正文', locator: null };
  const newUnit = makeUnit('field-unit-3', { unitEvidence: evidence('field-source-2') });
  const newDeployment = makeDeployment('field-unit-3', unknown('新单位尚未部署'));
  const batch = {
    units: { upsert: [newUnit], remove: ['field-unit-1'] },
    deployments: { upsert: [newDeployment], removeByUnitId: ['field-unit-1'] },
    sources: { upsert: [newSource] },
  };

  applyFieldBattleBatch(battle, batch);

  assert.deepEqual(battle.units.map((unit) => unit.id), ['field-unit-2', 'field-unit-3']);
  assert.equal(battle.units.find((unit) => unit.id === 'field-unit-3').sourceUnitId, '');
  assert.equal(battle.units.find((unit) => unit.id === 'field-unit-2').parentUnitId.state, 'unknown');
  assert.match(battle.units.find((unit) => unit.id === 'field-unit-2').parentUnitId.reason, /field-unit-1/);
  assert.deepEqual(battle.deployments.map((deployment) => deployment.unitId), ['field-unit-2', 'field-unit-3']);
  assert.equal(battle.deployments.find((deployment) => deployment.unitId === 'field-unit-2').reserveForUnitId.state, 'unknown');
  assert.match(battle.deployments.find((deployment) => deployment.unitId === 'field-unit-2').reserveForUnitId.reason, /field-unit-1/);
  assert.deepEqual(battle.sources.map((source) => source.id), ['sample-source-1', 'field-source-2']);

  assert.equal(undoFieldBattle(battle), true);
  assert.deepEqual(battle.units.map((unit) => unit.id), ['field-unit-1', 'field-unit-2']);
  assert.deepEqual(battle.deployments.map((deployment) => deployment.unitId), ['field-unit-1', 'field-unit-2']);
  assert.deepEqual(battle.sources.map((source) => source.id), ['sample-source-1']);
  const restoredUnit = battle.units.find((unit) => unit.id === 'field-unit-2');
  assert.equal(restoredUnit.parentUnitId.state, 'known');
  assert.equal(restoredUnit.parentUnitId.value, 'field-unit-1');
  const restoredDeployment = battle.deployments.find((deployment) => deployment.unitId === 'field-unit-2');
  assert.equal(restoredDeployment.reserveForUnitId.value, 'field-unit-1');

  assert.equal(redoFieldBattle(battle), true);
  assert.deepEqual(battle.units.map((unit) => unit.id), ['field-unit-2', 'field-unit-3']);
  assert.deepEqual(battle.sources.map((source) => source.id), ['sample-source-1', 'field-source-2']);
  assert.equal(redoFieldBattle(battle), false);

  resetFieldBattleHistory(battle.id);
  assert.equal(undoFieldBattle(battle), false);
});

test('历史按 battleId 隔离；已有 FieldUnit 的 sourceUnitId 不被覆盖', () => {
  const battle = structuredClone(sample);
  const other = structuredClone(sample);
  other.id = 'fieldbattle-other';

  applyFieldBattleBatch(battle, {
    units: { upsert: [], remove: ['field-unit-1'] },
    deployments: { upsert: [], removeByUnitId: [] },
    sources: { upsert: [] },
  });
  assert.equal(undoFieldBattle(other), false);
  assert.equal(undoFieldBattle(battle), true);

  const edited = structuredClone(battle.units[0]);
  edited.unitName = known('改名后的单位');
  edited.sourceUnitId = '不应保留';
  applyFieldBattleBatch(battle, {
    units: { upsert: [edited], remove: [] },
    deployments: { upsert: [], removeByUnitId: [] },
    sources: { upsert: [] },
  });
  assert.equal(battle.units[0].sourceUnitId, 'main-unit-1');
  assert.equal(battle.units[0].unitName.value, '改名后的单位');
  resetFieldBattleHistory();
});

test('delete 批次未显式 removeByUnitId 时，仍移除该单位的部署', () => {
  const battle = structuredClone(sample);
  applyFieldBattleBatch(battle, {
    units: { upsert: [], remove: ['field-unit-1'] },
    deployments: { upsert: [], removeByUnitId: [] },
    sources: { upsert: [] },
  });
  assert.deepEqual(battle.deployments.map((deployment) => deployment.unitId), ['field-unit-2']);
  assert.equal(undoFieldBattle(battle), true);
  assert.deepEqual(battle.deployments.map((deployment) => deployment.unitId), ['field-unit-1', 'field-unit-2']);
  resetFieldBattleHistory();
});

test('纯数据辅助只返回新对象，不改输入', () => {
  const battle = structuredClone(sample);
  const renamed = renameFieldBattle(battle, '  新名称  ');
  assert.equal(renamed.name, '新名称');
  assert.equal(battle.name, '战场1');
  assert.throws(() => renameFieldBattle(battle, '   '), /不能为空/);

  const list = [battle, { ...structuredClone(sample), id: 'fieldbattle-2' }];
  const remaining = removeFieldBattle(list, 'fieldbattle-2');
  assert.deepEqual(remaining.map((item) => item.id), [sample.id]);
  assert.equal(list.length, 2);
});

test('验证器接受手写样例，并对坏环/坏折线/悬空引用/坏缩放/非空战役引用报路径', () => {
  validateFieldBattle(structuredClone(sample));
  validateFieldBattles([structuredClone(sample), structuredClone(sample)]);

  const badRing = structuredClone(sample);
  badRing.terrain.cells[0].polygon = [[0, 0], [1, 1]];
  assert.throws(() => validateFieldBattles([badRing]), /fieldBattles\[0\]\.terrain\.cells\[0\]\.polygon/);

  const badLine = structuredClone(sample);
  badLine.terrain.contours[0].lines[0].points = [[0, 0]];
  assert.throws(() => validateFieldBattles([badLine]), /fieldBattles\[0\]\.terrain\.contours\[0\]\.lines\[0\]\.points/);

  const danglingUnit = structuredClone(sample);
  danglingUnit.deployments[0].unitId = 'missing-unit';
  assert.throws(() => validateFieldBattles([danglingUnit]), /fieldBattles\[0\]\.deployments\[0\]\.unitId/);

  const danglingSource = structuredClone(sample);
  danglingSource.units[0].unitName.evidence[0].sourceId = 'missing-source';
  assert.throws(() => validateFieldBattles([danglingSource]), /fieldBattles\[0\]\.units\[0\]\.unitName\.evidence\[0\]\.sourceId/);

  const badScale = structuredClone(sample);
  badScale.badgeScale = 0;
  assert.throws(() => validateFieldBattles([badScale]), /fieldBattles\[0\]\.badgeScale/);

  const knownBattlefield = structuredClone(sample);
  knownBattlefield.deployments[0].battlefieldId = known('main-battlefield-1');
  assert.throws(() => validateFieldBattles([knownBattlefield]), /fieldBattles\[0\]\.deployments\[0\]\.battlefieldId/);

  const badParent = structuredClone(sample);
  badParent.units[1].parentUnitId = known('missing-parent');
  assert.throws(() => validateFieldBattles([badParent]), /fieldBattles\[0\]\.units\[1\]\.parentUnitId/);

  const badViewZero = structuredClone(sample);
  badViewZero.view = { scale: 0, x: 0, y: 0 };
  assert.throws(() => validateFieldBattles([badViewZero]), /fieldBattles\[0\]\.view\.scale/);

  const badViewNeg = structuredClone(sample);
  badViewNeg.view = { scale: -1, x: 0, y: 0 };
  assert.throws(() => validateFieldBattles([badViewNeg]), /fieldBattles\[0\]\.view\.scale/);
});
