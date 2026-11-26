import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const { appStore } = await server.ssrLoadModule('/src/store.ts');
const actions = await server.ssrLoadModule('/src/battle-actions.ts');
const { migrateLegacyBattle, validateBattleWorkspace } = await server.ssrLoadModule('/src/battle-storage.ts');
const { parseWorkingMap } = await server.ssrLoadModule('/src/map-loader.ts');
const { serializeProject, parseProject } = await server.ssrLoadModule('/src/project-serializer.ts');
const { captureTheater } = await server.ssrLoadModule('/src/theater-cache.ts');
const { syntheticWorkspace } = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');
const source = await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');
const map = parseWorkingMap(source);
const legacy = [
  { id: 'old-zero', provinceId: 1, unitName: '旧零人数', troops: 0, color: '#123456', status: '驻防' },
  { id: 'old-point', provinceId: 0, unitName: '旧明确位置', troops: 1500, color: '#654321', status: '行军', x: 23, y: 45 },
];

function workspace() {
  const value = structuredClone(syntheticWorkspace);
  value.mapId = map.source.mapId;
  for (const bf of value.battle.battlefields) bf.mapId = value.mapId;
  return value;
}
function load(value) {
  appStore.mapId = value.mapId;
  appStore.mapData = map;
  appStore.garrisons = structuredClone(value.garrisons);
  appStore.battle = structuredClone(value.battle);
  appStore.tacticalItems = [];
  appStore.isSwitchingMap = false;
  actions.resetBattleHistory();
}

test('旧兵牌迁移保留0人数与唯一ID，省份不生成部署；只有明确x/y进入点位', () => {
  const migrated = migrateLegacyBattle(map.source.mapId, legacy);
  validateBattleWorkspace(migrated);
  assert.deepEqual(migrated.garrisons.map(u => u.id), ['old-zero', 'old-point']);
  assert.equal(migrated.garrisons[0].personnel.count.value, 0);
  assert.equal(migrated.garrisons[0].personnel.scope, 'legacy-unspecified');
  assert.equal(migrated.garrisons[0].parentUnitId.state, 'unknown');
  assert.equal(migrated.battle.deployments[0].placement.state, 'unknown');
  assert.deepEqual(migrated.battle.deployments[1].placement.value, { anchor: [23, 45], shape: { kind: 'point' } });
  assert.ok(!('x' in migrated.garrisons[1]));
  assert.ok(!('troops' in migrated.garrisons[1]));
});

test('整批修改只提交一次事件，撤销重做同时恢复单位、部署和来源，调用者不能反改已提交对象', () => {
  load(workspace());
  const before = structuredClone(actions.getBattleWorkspace());
  let events = 0;
  appStore.on('battle:changed', () => events++);
  const unit = structuredClone(appStore.garrisons[0]);
  const dep = structuredClone(appStore.battle.deployments[0]);
  unit.unitName.value = '已修改第一师';
  dep.placement.value.anchor = [111, 222];
  const batch = { label: '跨对象修改', origin: 'manual', candidateItemIds: [], edits: [
    { kind: 'upsert-unit', unit }, { kind: 'set-deployment', deployment: dep },
  ] };
  actions.applyBattleEdits(batch);
  assert.equal(events, 1);
  const after = structuredClone(actions.getBattleWorkspace());
  unit.unitName.value = '调用者后改';
  assert.equal(appStore.garrisons[0].unitName.value, '已修改第一师');
  actions.undoBattleEdit();
  assert.deepEqual(actions.getBattleWorkspace(), before);
  actions.redoBattleEdit();
  assert.deepEqual(actions.getBattleWorkspace(), after);
  assert.equal(events, 3);
});

test('无效批次或删除被引用上级保持整份当前状态与历史不变', () => {
  load(workspace());
  const before = structuredClone(actions.getBattleWorkspace());
  assert.throws(() => actions.applyBattleEdits({ label: '删上级', origin: 'manual', candidateItemIds: [],
    edits: [{ kind: 'remove-unit', unitId: 'd1' }] }), /parentUnitId/);
  assert.deepEqual(actions.getBattleWorkspace(), before);
  assert.deepEqual(actions.battleHistoryAvailability(), { undo: false, redo: false });
  const newUnit = structuredClone(appStore.garrisons[0]); newUnit.id = 'new-unplaced';
  assert.throws(() => actions.applyBattleEdits({ label: '未给部署记录', origin: 'manual', candidateItemIds: [],
    edits: [{ kind: 'upsert-unit', unit: newUnit }] }), /每单位必须有一条当前部署/);
  assert.deepEqual(actions.getBattleWorkspace(), before);
});

test('A 候选预览复用提交计算，不修改当前状态、事件或撤销栈', () => {
  load(workspace());
  const before = structuredClone(actions.getBattleWorkspace());
  const deployment = structuredClone(before.battle.deployments[0]);
  deployment.placement.value.anchor = [321, 234];
  const batch = { label: '候选预览', origin: 'candidate', candidateItemIds: ['item-1'],
    edits: [{ kind: 'set-deployment', deployment }] };
  const preview = actions.previewBattleEdits(before, batch);
  assert.deepEqual(preview.battle.deployments[0].placement.value.anchor, [321, 234]);
  assert.deepEqual(actions.getBattleWorkspace(), before);
  assert.deepEqual(actions.battleHistoryAvailability(), { undo: false, redo: false });
  actions.applyBattleEdits(batch);
  assert.deepEqual(actions.getBattleWorkspace(), preview);
});

test('外部 unknown 携带 value 明确拒绝，不能把矛盾字段送进候选或工程', () => {
  const value = workspace();
  value.battle.deployments.find(d => d.unitId === 'r33').placement.value = { anchor: [1, 2], shape: { kind: 'point' } };
  assert.throws(() => validateBattleWorkspace(value), /deployment.placement/);
});

test('工程v3往返保留含孔/多块、来源、未知和唯一部署；真实旧v2文件走迁移而非新格式假装兼容', () => {
  load(workspace());
  const state = captureTheater();
  const json = serializeProject([state], appStore.mapId);
  const archive = JSON.parse(json);
  assert.equal(archive.version, 4);
  const restored = parseProject(json).theaters[0];
  assert.equal(restored.version, 4);
  assert.deepEqual(restored.garrisons, state.garrisons);
  assert.deepEqual(restored.battle, state.battle);
  restored.battle.deployments[0].placement.value.anchor[0] = 999;
  assert.notEqual(state.battle.deployments[0].placement.value.anchor[0], 999);
  const old = JSON.parse(json);
  old.version = 2; old.theaters[0].version = 2;
  old.theaters[0].garrisons = legacy; delete old.theaters[0].battle;
  const migrated = parseProject(JSON.stringify(old)).theaters[0];
  assert.deepEqual(migrated.garrisons, migrateLegacyBattle(map.source.mapId, legacy).garrisons);
  assert.equal(migrated.battle.deployments[0].placement.state, 'unknown');
  assert.equal(migrated.version, 4);
});

test('工程外部引用出错明确拒绝，捕获保存状态保持独立，战区清历史后不能跨图撤销', () => {
  load(workspace());
  const saved = captureTheater();
  const changed = structuredClone(appStore.battle.deployments[0]); changed.placement.value.anchor = [50, 60];
  actions.applyBattleEdits({ label: '移动', origin: 'manual', candidateItemIds: [], edits: [{ kind: 'set-deployment', deployment: changed }] });
  assert.notDeepEqual(saved.battle.deployments[0].placement.value.anchor, [50, 60]);
  const archive = JSON.parse(serializeProject([saved], appStore.mapId));
  archive.theaters[0].battle.deployments[0].placement.evidence[0].sourceId = 'missing-source';
  assert.throws(() => parseProject(JSON.stringify(archive)), /evidence/);
  actions.resetBattleHistory();
  assert.throws(() => actions.undoBattleEdit(), /没有可撤销/);
});

test('P0-v0.5.1 customBadge：可选文化与自定义兵牌配置通过校验并随工程v3往返，非法文化或非data:image图标被边界拒绝', () => {
  const migrated = migrateLegacyBattle(map.source.mapId, [
    {
      ...legacy[0],
      customBadge: {
        culture: 'huaxia',
        requirementTag: '重装陷阵步兵',
        customGlyph: '陷阵',
        customIconDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
    },
  ]);
  validateBattleWorkspace(migrated);
  assert.equal(migrated.garrisons[0].customBadge.culture, 'huaxia');
  assert.equal(migrated.garrisons[0].customBadge.customGlyph, '陷阵');

  load(workspace());
  appStore.garrisons[0].customBadge = migrated.garrisons[0].customBadge;
  const saved = captureTheater();
  const restored = parseProject(serializeProject([saved], appStore.mapId)).theaters[0];
  assert.deepEqual(restored.garrisons[0].customBadge, migrated.garrisons[0].customBadge);

  const badCulture = structuredClone(migrated);
  badCulture.garrisons[0].customBadge.culture = 'mars';
  assert.throws(() => validateBattleWorkspace(badCulture), /customBadge\.culture/);

  const badIcon = structuredClone(migrated);
  badIcon.garrisons[0].customBadge.customIconDataUrl = 'https://example.com/icon.png';
  assert.throws(() => validateBattleWorkspace(badIcon), /customBadge\.customIconDataUrl/);
});

test('回归：validateBattleWorkspace 拒绝领结/零面积多边形及空 terrain.feature.id；migrateLegacyBattle 拒绝空 unit.id', () => {
  const emptyIdWs = workspace();
  emptyIdWs.battle.battlefields[0].terrain[1].id = '';
  assert.throws(() => validateBattleWorkspace(emptyIdWs), /terrain\.id/);

  const blankIdWs = workspace();
  blankIdWs.battle.battlefields[0].terrain[1].id = '   ';
  assert.throws(() => validateBattleWorkspace(blankIdWs), /terrain\.id/);

  const bowtieWs = workspace();
  bowtieWs.battle.battlefields[0].terrain[0].area.value = [[[[0, 0], [20, 20], [20, 0], [0, 20], [0, 0]]]];
  assert.throws(() => validateBattleWorkspace(bowtieWs), /area/);

  const zeroBoundaryWs = workspace();
  zeroBoundaryWs.battle.battlefields[0].boundary.value = [[[[0, 0], [10, 0], [20, 0], [0, 0]]]];
  assert.throws(() => validateBattleWorkspace(zeroBoundaryWs), /boundary/);

  assert.throws(
    () => migrateLegacyBattle(map.source.mapId, [{ ...legacy[0], id: '' }]),
    /旧版 unit/,
  );
  assert.throws(
    () => migrateLegacyBattle(map.source.mapId, [{ ...legacy[0], id: '   ' }]),
    /旧版 unit/,
  );
});
