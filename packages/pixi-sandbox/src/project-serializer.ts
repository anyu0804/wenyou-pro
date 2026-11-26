import { JsonValidator, isFiniteNumber as finite, isPoint as point } from './json-validation';
import { parseWorkingMap } from './map-loader';
import { originalMapRecords } from './map-serializer';
import { isImageBaseSource, serializeImageBaseSpecFromMap } from './image-map-builder';
import type { TheaterState } from './theater-cache';
import type { MapData, BurgItem, StateItem, ProvinceItem, TacticalItem } from './store';
import { validateFieldBattles } from './field-battle-validate';
import { migrateLegacyBattle, validateBattleWorkspace } from './battle-storage';

type EditableMap = Pick<MapData, 'burgs' | 'states' | 'provinces'> & {
  source: string; name: string; mapId: string;
  kmPerPixel?: number; mapWidthKm?: number;
  heights: number[]; statesByCell: number[]; provincesByCell: number[]; religionsByCell: number[];
};
type SavedTheater = Omit<TheaterState, 'mapData'> & { map: EditableMap };
export interface ProjectArchive {
  format: 'wenyou-project'; version: 4; activeMapId: string; theaters: SavedTheater[];
}
export interface ImportedProject { activeMapId: string; theaters: TheaterState[] }

/** JSON 只存粗网格原文（或静态图片底图描述）及可编辑状态，几何重建，不序列化 Pixi 对象或 typed-array 数字键。 */
export function serializeProject(theaters: TheaterState[], activeMapId: string): string {
  const archive: ProjectArchive = {
    format: 'wenyou-project', version: 4, activeMapId,
    theaters: theaters.map(({ mapData, ...state }) => ({
      ...state,
      map: {
        source: mapData.source.baseKind === 'image'
          ? serializeImageBaseSpecFromMap(mapData)
          : originalMapRecords(mapData).join('\r\n'),
        name: mapData.source.name, mapId: mapData.source.mapId,
        ...(typeof mapData.source.kmPerPixel === 'number' && Number.isFinite(mapData.source.kmPerPixel) && mapData.source.kmPerPixel > 0
          ? { kmPerPixel: mapData.source.kmPerPixel }
          : {}),
        ...(typeof mapData.source.mapWidthKm === 'number' && Number.isFinite(mapData.source.mapWidthKm) && mapData.source.mapWidthKm > 0
          ? { mapWidthKm: mapData.source.mapWidthKm }
          : {}),
        heights: Array.from(mapData.cells.h), statesByCell: Array.from(mapData.cells.state),
        provincesByCell: Array.from(mapData.cells.province), religionsByCell: Array.from(mapData.cells.religion),
        burgs: mapData.burgs, states: mapData.states, provinces: mapData.provinces,
      },
    })),
  };
  return JSON.stringify(archive);
}

// 以下校验仅用于外部 JSON 反序列化边界。通过后，内部数据直接遵守类型契约。
const json: JsonValidator = new JsonValidator((path, detail) => `工程文件字段无效：${path}${detail === undefined ? '' : `（${detail}）`}`);
const uint = (value: unknown, max = 65535): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

function cellArray(value: unknown, count: number, max: number, path: string): asserts value is number[] {
  json.check(Array.isArray(value) && value.length === count && value.every(n => uint(n, max)), path);
}
function entities(value: unknown, kind: 'burgs' | 'states' | 'provinces', count: number, path: string): void {
  json.check(Array.isArray(value), path);
  const ids = new Set<number>();
  for (const item of value) {
    json.object(item, path);
    json.check(uint(item.i) && !ids.has(item.i) && typeof item.name === 'string' &&
      (item.removed === undefined || typeof item.removed === 'boolean'), `${path}.i/name/removed`);
    ids.add(item.i);
    if (kind === 'burgs') {
      json.check(item.i > 0 && uint(item.cell, count - 1) && finite(item.x) && finite(item.y) &&
        uint(item.state) && uint(item.province) && [0, 1].includes(item.capital) && uint(item.port) &&
        finite(item.population) && item.population >= 0 && ['city', 'provincial', 'capital'].includes(item.tier), path);
    } else {
      json.check(color(item.color), `${path}.color`);
      if (kind === 'states') {
        json.check((item.center === undefined || uint(item.center, count - 1)) &&
          (item.capital === undefined || uint(item.capital)) && (item.pole === undefined || point(item.pole)), path);
      } else {
        json.check(item.i > 0 && uint(item.state) && uint(item.centerCell, count - 1) &&
          uint(item.burg) && finite(item.x) && finite(item.y) &&
          (item.fullName === undefined || typeof item.fullName === 'string'), path);
      }
    }
  }
}
function tactical(value: unknown, path: string): asserts value is TacticalItem[] {
  json.check(Array.isArray(value), path);
  const ids = new Set<string>();
  for (const item of value) {
    json.object(item, path);
    json.check(typeof item.id === 'string' && !ids.has(item.id) && ['frontline', 'arrow'].includes(item.type) &&
      Array.isArray(item.points) && item.points.length >= 2 && item.points.every(point) &&
      color(item.color) && finite(item.width) && item.width > 0 &&
      (item.label === undefined || typeof item.label === 'string') &&
      (item.flipSide === undefined || typeof item.flipSide === 'boolean') &&
      (item.toothStyle === undefined || ['sawtooth', 'semicircle'].includes(item.toothStyle)) &&
      (item.arrowStyle === undefined || ['solid', 'dashed', 'double-retreat'].includes(item.arrowStyle)), path);
    ids.add(item.id);
  }
}

/** 整份文件先解析完，再由调用方提交数据库；校验失败不返回半份工程。 */
export function parseProject(text: string): ImportedProject {
  const archive: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  json.object(archive, 'root');
  json.check(archive.format === 'wenyou-project' && [1, 2, 3, 4].includes(archive.version), 'format/version（需要 wenyou-project v1/v2/v3/v4）');
  json.check(typeof archive.activeMapId === 'string' && Array.isArray(archive.theaters) && archive.theaters.length > 0, 'activeMapId/theaters');
  const ids = new Set<string>();
  const theaters: TheaterState[] = [];
  for (const [index, saved] of archive.theaters.entries()) {
    const path = `theaters[${index}]`;
    json.object(saved, path);
    json.check(saved.version === archive.version, `${path}.version`);
    json.object(saved.map, `${path}.map`);
    const map = saved.map;
    json.check(typeof map.source === 'string' && typeof map.name === 'string' && typeof map.mapId === 'string', `${path}.map.source/name/mapId`);
    if (map.kmPerPixel !== undefined) {
      json.check(finite(map.kmPerPixel) && map.kmPerPixel > 0, `${path}.map.kmPerPixel`);
    }
    if (map.mapWidthKm !== undefined) {
      json.check(finite(map.mapWidthKm) && map.mapWidthKm > 0, `${path}.map.mapWidthKm`);
    }
    const mapData = parseWorkingMap(map.source);
    const isImageBase = isImageBaseSource(map.source);
    json.check(mapData.source.mapId === map.mapId && !ids.has(map.mapId), `${path}.map.mapId（身份不符或重复）`);
    ids.add(map.mapId);
    const count = mapData.cells.count;
    if (!isImageBase) {
      json.check(originalMapRecords(mapData)[25].split(',').length === count, `${path}.map: 原图地块编号不一致`);
    }
    cellArray(map.heights, count, 100, `${path}.map.heights`);
    cellArray(map.statesByCell, count, 65535, `${path}.map.statesByCell`);
    cellArray(map.provincesByCell, count, 65535, `${path}.map.provincesByCell`);
    cellArray(map.religionsByCell, count, 65535, `${path}.map.religionsByCell`);
    entities(map.burgs, 'burgs', count, `${path}.map.burgs`);
    entities(map.states, 'states', count, `${path}.map.states`);
    entities(map.provinces, 'provinces', count, `${path}.map.provinces`);
    const stateIds = new Set(map.states.filter((s: StateItem) => !s.removed).map((s: StateItem) => s.i));
    const provinceIds = new Set([0, ...map.provinces.filter((p: ProvinceItem) => !p.removed).map((p: ProvinceItem) => p.i)]);
    const religionIds = new Set(mapData.religions.filter(r => !r.removed).map(r => r.i));
    json.check(map.statesByCell.every(id => stateIds.has(id)) && map.provincesByCell.every(id => provinceIds.has(id)) &&
      map.religionsByCell.every(id => religionIds.has(id)), `${path}.map: 地块引用了不存在的实体`);
    json.check(map.burgs.every((b: BurgItem) => b.removed || (stateIds.has(b.state) && provinceIds.has(b.province))) &&
      map.provinces.every((p: ProvinceItem) => p.removed || stateIds.has(p.state)), `${path}.map: 城市/省份归属引用无效`);
    const fieldBattles = archive.version >= 4 ? saved.fieldBattles : [];
    validateFieldBattles(fieldBattles);
    const workspace = archive.version >= 3
      ? { mapId: map.mapId, garrisons: saved.garrisons, battle: saved.battle }
      : migrateLegacyBattle(map.mapId, saved.garrisons);
    if (archive.version >= 3) validateBattleWorkspace(workspace);
    tactical(saved.tacticalItems, `${path}.tacticalItems`);
    mapData.source.name = map.name;
    if (typeof map.kmPerPixel === 'number') {
      mapData.source.kmPerPixel = map.kmPerPixel;
    }
    if (typeof map.mapWidthKm === 'number') {
      mapData.source.mapWidthKm = map.mapWidthKm;
    }
    if (mapData.source.mapWidthKm !== undefined && mapData.source.kmPerPixel === undefined) {
      mapData.source.kmPerPixel = mapData.source.mapWidthKm / mapData.width;
    } else if (mapData.source.kmPerPixel !== undefined && mapData.source.mapWidthKm === undefined) {
      mapData.source.mapWidthKm = mapData.source.kmPerPixel * mapData.width;
    }
    if (isImageBase) {
      mapData.source.originalMap = serializeImageBaseSpecFromMap(mapData);
    }
    mapData.cells.h = Uint8Array.from(map.heights);
    mapData.cells.state = Uint16Array.from(map.statesByCell);
    mapData.cells.province = Uint16Array.from(map.provincesByCell);
    mapData.cells.religion = Uint16Array.from(map.religionsByCell);
    mapData.burgs = map.burgs;
    mapData.states = map.states;
    mapData.provinces = map.provinces;
    theaters.push({ version: 4, mapData, garrisons: workspace.garrisons, battle: workspace.battle, fieldBattles,
      tacticalItems: saved.tacticalItems });
  }
  json.check(ids.has(archive.activeMapId), 'activeMapId：未包含当前战区');
  return { activeMapId: archive.activeMapId, theaters };
}
