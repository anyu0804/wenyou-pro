import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { createStore, set } from 'idb-keyval';

// 只用固定 fixture（原 working-map 副本）与手写战场样例；不写盘、不碰原始地图文件。
// Node 没有 IndexedDB：装一个只覆盖 idb-keyval 实际用法的内存实现，让 readTheater 走真实索引路径。

const DATABASES = new Map();
const clone = (value) => structuredClone(value);

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onupgradeneeded = null;
    this.onsuccess = null;
    this.onerror = null;
    this.oncomplete = null;
    this.onabort = null;
  }
}

class FakeDatabase {
  constructor(name) {
    this.name = name;
    this.data = new Map();
    this.onclose = null;
  }
  createObjectStore() {}
  transaction() {
    return new FakeTransaction(this);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.changes = new Map();
    this.clearRequested = false;
    this.aborted = false;
    this.settled = false;
    this.pending = 0;
    this.scheduled = false;
  }
  objectStore() {
    return new FakeObjectStore(this);
  }
  abort() {
    this.aborted = true;
    queueMicrotask(() => this.settle(new Error('AbortError')));
  }
  view() {
    const view = new Map(this.db.data);
    if (this.clearRequested) view.clear();
    for (const [key, operation] of this.changes) {
      if (operation.delete) view.delete(key);
      else view.set(key, operation.value);
    }
    return view;
  }
  request(run) {
    const request = new FakeRequest();
    this.pending++;
    queueMicrotask(() => {
      try {
        request.result = run();
        request.onsuccess?.();
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
      this.pending--;
      this.schedule();
    });
    return request;
  }
  schedule() {
    if (this.pending > 0 || this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => this.settle(), 0);
  }
  settle(error) {
    if (this.settled) return;
    this.settled = true;
    if (this.aborted) {
      this.onabort?.();
      return;
    }
    if (error !== undefined) {
      this.onabort?.();
      return;
    }
    if (this.clearRequested) this.db.data.clear();
    for (const [key, operation] of this.changes) {
      if (operation.delete) this.db.data.delete(key);
      else this.db.data.set(key, operation.value);
    }
    this.oncomplete?.();
  }
}

class FakeObjectStore {
  constructor(tx) {
    this.transaction = tx;
  }
  get(key) {
    return this.transaction.request(() => {
      const value = this.transaction.view().get(key);
      return value === undefined ? undefined : clone(value);
    });
  }
  getKey(key) {
    return this.transaction.request(() => (this.transaction.view().has(key) ? key : undefined));
  }
  getAll() {
    return this.transaction.request(() => [...this.transaction.view().values()].map(clone));
  }
  getAllKeys() {
    return this.transaction.request(() => [...this.transaction.view().keys()]);
  }
  put(value, key) {
    return this.transaction.request(() => {
      this.transaction.changes.set(key, { value: clone(value) });
      return key;
    });
  }
  delete(key) {
    return this.transaction.request(() => {
      this.transaction.changes.set(key, { delete: true });
      return undefined;
    });
  }
  clear() {
    return this.transaction.request(() => {
      this.transaction.clearRequested = true;
      this.transaction.changes.clear();
      return undefined;
    });
  }
}

globalThis.indexedDB = {
  open(name) {
    const request = new FakeRequest();
    queueMicrotask(() => {
      let db = DATABASES.get(name);
      const created = db === undefined;
      if (created) {
        db = new FakeDatabase(name);
        DATABASES.set(name, db);
      }
      request.result = db;
      if (created) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  },
};

function resetProfile() {
  for (const db of DATABASES.values()) db.data.clear();
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());
const { parseWorkingMap } = await server.ssrLoadModule('/src/map-loader.ts');
const { appStore } = await server.ssrLoadModule('/src/store.ts');
const cache = await server.ssrLoadModule('/src/theater-cache.ts');
const project = await server.ssrLoadModule('/src/project-serializer.ts');
const map = parseWorkingMap(await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8'));
const sample = JSON.parse(await fs.readFile(new URL('./fixtures/field-battle/sample.json', import.meta.url), 'utf8'));
const store = createStore('wenyou-theaters', 'theaters');
const mapId = map.source.mapId;
const baseKey = `__base__${mapId}`;

const legacyUnits = [{ id: 'legacy-1', provinceId: 0, unitName: '旧军', troops: 1200, color: '#123456', status: '行军', x: 40, y: 60 }];

function editableMap() {
  return {
    source: { mapId: map.source.mapId, name: map.source.name },
    cells: { h: map.cells.h, state: map.cells.state, province: map.cells.province, religion: map.cells.religion },
    burgs: map.burgs, states: map.states, provinces: map.provinces,
  };
}

function baseRecord() {
  const { burgs, states, provinces, cells, ...base } = map;
  const { h, state, province, religion, ...geometry } = cells;
  return { ...base, cells: geometry };
}

function currentBattle() {
  return { schemaVersion: 1, sources: sample.sources, battlefields: [], deployments: sample.deployments };
}

async function seedCache(version, { garrisons, battle, fieldBattles } = {}) {
  resetProfile();
  if (version >= 3) {
    await set(baseKey, baseRecord(), store);
    await set(mapId, {
      version,
      mapData: editableMap(),
      garrisons: garrisons ?? sample.units,
      battle: battle ?? currentBattle(),
      ...(fieldBattles === undefined ? {} : { fieldBattles }),
      tacticalItems: [],
      chronicles: [],
    }, store);
  } else {
    await set(mapId, {
      version,
      mapData: map,
      garrisons: garrisons ?? legacyUnits,
      battle: battle ?? currentBattle(),
      tacticalItems: [],
      chronicles: [],
    }, store);
  }
}

test('缓存 v1/v2/v3 走旧兵牌迁移，fieldBattles 补空数组', async () => {
  for (const version of [1, 2, 3]) {
    await seedCache(version, { garrisons: legacyUnits });
    const state = await cache.readTheater(mapId);
    assert.equal(state.version, 4, `缓存 v${version} 的返回值应为 TheaterState v4`);
    assert.deepEqual(state.fieldBattles, [], `缓存 v${version} 不得带入战场快照`);
    assert.equal(state.garrisons[0].id, 'legacy-1');
    assert.equal(state.garrisons[0].unitName.state, 'known');
    assert.equal(state.garrisons[0].unitName.value, '旧军');
    assert.deepEqual(state.battle.sources.map((source) => source.id), [`legacy:${mapId}`], '旧迁移来源必须存在');
  }
});

test('缓存 v4 走当前兵牌结构，fieldBattles 补空数组且不进旧迁移', async () => {
  await seedCache(4);
  const state = await cache.readTheater(mapId);
  assert.equal(state.version, 4);
  assert.deepEqual(state.fieldBattles, []);
  assert.deepEqual(state.battle.battlefields, []);
  assert.deepEqual(state.battle.deployments, sample.deployments);
  assert.ok(state.battle.sources.every((source) => source.kind !== 'legacy'), 'v4 不得进入旧兵牌迁移');
});

test('缓存 v5 走当前兵牌结构并逐值保留 fieldBattles', async () => {
  await seedCache(5, { fieldBattles: [clone(sample)] });
  const state = await cache.readTheater(mapId);
  assert.deepEqual(state.fieldBattles, [sample]);
  assert.equal(state.fieldBattles[0].terrain.lakes[0].parts[0].holes.length, 1);
  // v5 的 garrisons 是 BattleField 结构；若被送进 migrateLegacyBattle 会直接抛「旧版 unit」。
  assert.equal(state.garrisons[0].unitName.state, 'known');
  assert.ok(state.battle.sources.every((source) => source.kind !== 'legacy'));
});

test('缓存 v5 的坏 fieldBattles 或缺失字段在读取边界直接抛错', async () => {
  await seedCache(5, { fieldBattles: [{ ...clone(sample), badgeScale: 0 }] });
  await assert.rejects(() => cache.readTheater(mapId), /战场字段无效：fieldBattles\[0\]\.badgeScale/);
  resetProfile();
  await set(baseKey, baseRecord(), store);
  await set(mapId, {
    version: 5, mapData: editableMap(), garrisons: sample.units, battle: currentBattle(), tacticalItems: [], chronicles: [],
  }, store);
  await assert.rejects(() => cache.readTheater(mapId), /战场字段无效：fieldBattles/);
});

test('工程 v1/v2 旧迁移，v3 当前结构，v4 保留 fieldBattles 且不进旧迁移', () => {
  const state = {
    version: 4, mapData: map, garrisons: sample.units, battle: currentBattle(),
    fieldBattles: [clone(sample)], tacticalItems: [],
  };
  const json = project.serializeProject([state], mapId);
  const archive = JSON.parse(json);
  assert.equal(archive.version, 4);
  assert.deepEqual(archive.theaters[0].fieldBattles, [sample]);

  const roundTrip = project.parseProject(json);
  assert.equal(roundTrip.theaters[0].version, 4);
  assert.deepEqual(roundTrip.theaters[0].fieldBattles, [sample]);
  assert.ok(roundTrip.theaters[0].battle.sources.every((source) => source.kind !== 'legacy'),
    'v4 的 garrisons 是 BattleField 结构，进旧迁移会直接抛错');

  const version3 = JSON.parse(json);
  version3.version = 3;
  version3.theaters[0].version = 3;
  delete version3.theaters[0].fieldBattles;
  const parsed3 = project.parseProject(JSON.stringify(version3)).theaters[0];
  assert.equal(parsed3.version, 4);
  assert.deepEqual(parsed3.fieldBattles, []);
  assert.ok(parsed3.battle.sources.every((source) => source.kind !== 'legacy'), 'v3 不得进入旧兵牌迁移');

  const legacyProject = (version) => {
    const archive = JSON.parse(json);
    archive.version = version;
    for (const saved of archive.theaters) {
      saved.version = version;
      saved.garrisons = legacyUnits;
      delete saved.battle;
      delete saved.fieldBattles;
      saved.chronicles = [];
    }
    return archive;
  };
  for (const version of [1, 2]) {
    const migrated = project.parseProject(JSON.stringify(legacyProject(version))).theaters[0];
    assert.equal(migrated.version, 4);
    assert.deepEqual(migrated.fieldBattles, []);
    assert.deepEqual(migrated.battle.sources.map((source) => source.id), [`legacy:${mapId}`]);
  }

  const broken = JSON.parse(json);
  broken.theaters[0].fieldBattles = [{ ...clone(sample), units: 'not-an-array' }];
  assert.throws(() => project.parseProject(JSON.stringify(broken)), /战场字段无效：fieldBattles\[0\]\.units/);
});

test('缓存写入、刷新、切战区与新 profile 导入后 fieldBattles 一致', async () => {
  resetProfile();
  appStore.mapData = map;
  appStore.mapId = mapId;
  appStore.fieldBattles = [clone(sample)];
  const captured = cache.captureTheater();
  assert.deepEqual(captured.fieldBattles, [sample]);
  await cache.saveTheater(captured);
  assert.deepEqual((await cache.readTheater(mapId)).fieldBattles, [sample]);

  appStore.fieldBattles = [clone(sample)];
  const json = project.serializeProject([cache.captureTheater()], mapId);
  resetProfile(); // 模拟换浏览器 profile：旧 IndexedDB 数据不再存在
  const imported = project.parseProject(json);
  await cache.saveTheaters(imported.theaters, imported.activeMapId);
  assert.deepEqual((await cache.readTheater(mapId)).fieldBattles, [sample]);
});

test('回归：不支持的缓存版本 v6 在读取边界被拒绝且包含“缓存结构无效”提示', async () => {
  await seedCache(6);
  await assert.rejects(() => cache.readTheater(mapId), /缓存结构无效/);
});
