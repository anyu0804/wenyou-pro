import { createStore, entries, get, promisifyRequest } from 'idb-keyval';
import { appStore, type MapData, type TacticalItem } from './store';
import type { BattleState, BattleUnit } from './battle-contract';
import type { FieldBattle } from './field-battle-types';
import { validateFieldBattles } from './field-battle-validate';
import { migrateLegacyBattle, validateBattleWorkspace } from './battle-storage';

export interface TheaterState {
  version: 4;
  mapData: MapData;
  garrisons: BattleUnit[];
  battle: BattleState;
  fieldBattles: FieldBattle[];
  tacticalItems: TacticalItem[];
}

export interface TheaterEntry { mapId: string; name: string }

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** 从当前 URL（或显式 search 字符串）解析 `?workspace=` 参数，用于多世界物理隔离缓存。 */
export function resolveWorkspaceScopeFromUrl(search?: string): string | null {
  const rawSearch =
    search !== undefined
      ? search
      : typeof globalThis !== 'undefined' && typeof globalThis.location?.search === 'string'
        ? globalThis.location.search
        : '';
  if (!rawSearch) return null;
  const workspace = new URLSearchParams(rawSearch).get('workspace')?.trim() ?? '';
  return workspace.length > 0 ? workspace : null;
}

/** 按工作区范围解析 IndexedDB 库名；无参数独立打开或单测环境下保持原库名零破坏。 */
export function resolveTheaterDbName(workspaceScope?: string | null): string {
  const normalized = workspaceScope?.trim() ?? '';
  return normalized ? `wenyou-pixi-theaters-${fnv1a32Hex(normalized)}` : 'wenyou-theaters';
}

// 每份完整战区状态直接以 mapId 为 key；传入 ?workspace= 时按工作区哈希物理隔离库名。
const storage = createStore(resolveTheaterDbName(resolveWorkspaceScopeFromUrl()), 'theaters');
const catalogKey = '__catalog__';
const activeKey = '__active__';
const baseKey = (mapId: string) => `__base__${mapId}`;
const replaceBases = new Set<string>(); // 用户忽略损坏缓存后，重新导入同图时重建基底与可编辑状态。

type EditableMap = Pick<MapData, 'burgs' | 'states' | 'provinces'> & {
  source: Pick<
    MapData['source'],
    'mapId' | 'name' | 'overlayAlpha' | 'kmPerPixel' | 'mapWidthKm' | 'retouchStrokes'
  >;
  cells: Pick<MapData['cells'], 'h' | 'state' | 'province' | 'religion'>;
};
type CachedTheater = Omit<TheaterState, 'version' | 'mapData'> & { version: 5; mapData: EditableMap };

function editableState(state: TheaterState): CachedTheater {
  const { mapData: map, garrisons, battle, fieldBattles, tacticalItems } = state;
  const source: EditableMap['source'] = {
    mapId: map.source.mapId,
    name: map.source.name,
  };
  if (map.source.overlayAlpha !== undefined) {
    source.overlayAlpha = map.source.overlayAlpha;
  }
  if (map.source.kmPerPixel !== undefined) {
    source.kmPerPixel = map.source.kmPerPixel;
  } else if (map.source.baseKind === 'image') {
    source.kmPerPixel = undefined;
  }
  if (map.source.mapWidthKm !== undefined) {
    source.mapWidthKm = map.source.mapWidthKm;
  } else if (map.source.baseKind === 'image') {
    source.mapWidthKm = undefined;
  }
  if (map.source.retouchStrokes !== undefined) {
    source.retouchStrokes = structuredClone(map.source.retouchStrokes);
  }
  return { version: 5, mapData: {
    source,
    cells: { h: map.cells.h, state: map.cells.state, province: map.cells.province, religion: map.cells.religion },
    burgs: map.burgs, states: map.states, provinces: map.provinces,
  }, garrisons, battle, fieldBattles, tacticalItems };
}

export function readActiveTheater(): Promise<string | undefined> { return get(activeKey, storage); }
export function replaceBaseOnNextSave(mapId: string): void { replaceBases.add(mapId); }
export function isBaseReplacementPending(mapId: string): boolean { return replaceBases.has(mapId); }
export async function exportRawCache(): Promise<string> {
  return JSON.stringify(await entries(storage), (_key, value) => ArrayBuffer.isView(value)
    ? { typedArray: value.constructor.name, values: Array.from(value as unknown as ArrayLike<number>) } : value);
}

export async function listTheaters(): Promise<TheaterEntry[]> {
  const catalog = await get<TheaterEntry[]>(catalogKey, storage);
  return catalog === undefined ? [] : catalog;
}

export async function readTheater(mapId: string): Promise<TheaterState | undefined> {
  let saved = await get(mapId, storage);
  if (saved === undefined) return undefined; // 首次导入，无历史战区
  const cacheVersion = saved.version;
  if (![1, 2, 3, 4, 5].includes(cacheVersion)) {
    throw new Error(`战区 ${mapId} 的缓存结构无效（不支持的缓存版本 v${String(cacheVersion)}），已停止切换，请保留浏览器数据`);
  }
  if (cacheVersion >= 3) {
    const base = await get(baseKey(mapId), storage);
    if (!base || base.source?.mapId !== mapId) {
      throw new Error(`战区 ${mapId} 的原图基底缺失或损坏，请先导出原始缓存`);
    }
    // 缓存版本始终比 TheaterState 高 1：v5 快照对应 v4 状态，v4 快照对应 v3 状态。
    // 缺可编辑段或版本未知的记录仍合并基底，由下面的结构检查统一报错。
    saved = { ...saved, version: cacheVersion === 5 ? 4 : cacheVersion === 4 ? 3 : cacheVersion === 3 ? 2 : cacheVersion, mapData: { ...base, ...saved.mapData,
      source: { ...base.source, ...saved.mapData?.source }, cells: { ...base.cells, ...saved.mapData?.cells } } };
  }
  if (![1, 2, 3, 4].includes(saved.version) || saved.mapData?.source?.mapId !== mapId ||
      !(saved.mapData.cells.h instanceof Uint8Array) ||
      ![saved.mapData.cells.state, saved.mapData.cells.province, saved.mapData.cells.religion].every(a => a instanceof Uint16Array && a.length === saved.mapData.cells.count) ||
      saved.mapData.cells.h.length !== saved.mapData.cells.count ||
      ![saved.mapData.cells.polygons, saved.mapData.cells.p, saved.mapData.cells.c].every(a => Array.isArray(a) && a.length === saved.mapData.cells.count) ||
      ![saved.mapData.burgs, saved.mapData.states, saved.mapData.provinces, saved.mapData.religions, saved.mapData.rivers, saved.mapData.biomes, saved.mapData.lakes].every(Array.isArray) ||
      !Number.isFinite(saved.mapData.width) || saved.mapData.width <= 0 || !Number.isFinite(saved.mapData.height) || saved.mapData.height <= 0 ||
      !Array.isArray(saved.garrisons) || !Array.isArray(saved.tacticalItems)) {
    throw new Error(`战区 ${mapId} 的缓存结构无效，已停止切换，请保留浏览器数据`);
  }
  // v4/v5 快照是当前兵牌结构；v5 额外带战场快照，v4 及更早一律补空数组。
  const fieldBattles = cacheVersion === 5 ? saved.fieldBattles : [];
  validateFieldBattles(fieldBattles);
  const workspace = cacheVersion >= 4 ? { mapId, garrisons: saved.garrisons, battle: saved.battle }
    : migrateLegacyBattle(mapId, saved.garrisons);
  if (cacheVersion >= 4) validateBattleWorkspace(workspace);
  return { version: 4, mapData: saved.mapData, garrisons: workspace.garrisons, battle: workspace.battle, fieldBattles,
    tacticalItems: saved.tacticalItems };
}

export function captureTheater(): TheaterState {
  // 只复制可序列化的业务数据；不缓存 Pixi 容器、纹理或事件回调。
  const state: TheaterState = {
    version: 4,
    mapData: appStore.mapData!,
    garrisons: appStore.garrisons,
    battle: appStore.battle,
    fieldBattles: appStore.fieldBattles,
    tacticalItems: appStore.tacticalItems,
  };
  const edits = structuredClone(editableState(state));
  // 几何、原图和未编辑的地理资料保持共享，只复制本次可编辑状态。
  return { ...state, ...edits, version: 4, mapData: { ...state.mapData, ...edits.mapData,
    source: { ...state.mapData.source, ...edits.mapData.source },
    cells: { ...state.mapData.cells, ...edits.mapData.cells } } };
}

export async function saveTheater(state: TheaterState): Promise<void> {
  const id = state.mapData.source.mapId;
  const existingBase = await storage('readonly', store => promisifyRequest(store.getKey(baseKey(id))));
  await writeTheaters([state], id, existingBase === undefined || replaceBases.has(id));
  replaceBases.delete(id);
}

/** 工程导入：所有战区和目录在同一个 IndexedDB 事务内提交。 */
export async function saveTheaters(states: TheaterState[], activeMapId = states[0].mapData.source.mapId): Promise<void> {
  await writeTheaters(states, activeMapId, true);
  for (const state of states) replaceBases.delete(state.mapData.source.mapId);
}

/** 删除指定战区的可编辑记录与原图基底，并同步更新目录和活动战区索引；返回切换后的下一个战区 ID（删光返回 undefined）。 */
export async function deleteTheater(mapId: string): Promise<string | undefined> {
  const remaining = (await listTheaters()).filter(entry => entry.mapId !== mapId);
  const nextActiveId = remaining[0]?.mapId;
  await storage('readwrite', store => {
    try {
      store.delete(mapId);
      store.delete(baseKey(mapId));
      store.put(remaining, catalogKey);
      if (nextActiveId !== undefined) store.put(nextActiveId, activeKey);
      else store.delete(activeKey);
    } catch (error) {
      store.transaction.abort();
      throw error;
    }
    return promisifyRequest(store.transaction);
  });
  replaceBases.delete(mapId);
  return nextActiveId;
}

/** 清空当前工作区隔离库中的全部战区记录与索引（供宿主 reset_sandbox 重置空沙盘使用）。 */
export async function clearAllTheaters(): Promise<void> {
  await storage('readwrite', store => {
    try {
      store.clear();
    } catch (error) {
      store.transaction.abort();
      throw error;
    }
    return promisifyRequest(store.transaction);
  });
  replaceBases.clear();
}

async function writeTheaters(states: TheaterState[], activeMapId: string, writeBases: boolean): Promise<void> {
  const ids = new Set(states.map(state => state.mapData.source.mapId));
  const catalog = (await listTheaters()).filter(entry => !ids.has(entry.mapId));
  const values: [IDBValidKey, unknown][] = states.map(state => [state.mapData.source.mapId, editableState(state)]);
  if (writeBases) for (const { mapData } of states) {
    const { burgs, states, provinces, cells, ...base } = mapData;
    const { h, state, province, religion, ...geometry } = cells;
    values.push([baseKey(mapData.source.mapId), { ...base, cells: geometry }]);
  }
  catalog.push(...states.map(state => ({ mapId: state.mapData.source.mapId, name: state.mapData.source.name })));
  values.push([catalogKey, catalog], [activeKey, activeMapId]);
  await storage('readwrite', store => {
    try {
      for (const [key, value] of values) store.put(value, key);
    } catch (error) {
      // idb-keyval 6.3.0 的 setMany 在 put 同步抛错时不 abort，先前排队的写入仍可能提交。
      // 此处拥有整份工程的提交边界；任何同步失败都中止事务并保留原始异常。
      store.transaction.abort();
      throw error;
    }
    return promisifyRequest(store.transaction);
  });
}
