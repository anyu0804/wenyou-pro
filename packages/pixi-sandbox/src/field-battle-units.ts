import type {
  BattleDeployment, BattleField, BattlePolygon, BattleSource, BattleState, BattleUnit,
} from './battle-contract';
import type { FieldBattle, FieldUnit } from './field-battle-types';
import type { MapData } from './store';
import { closeRing, pointInPolygon } from './battle-geometry';

export interface CopyBattleUnitsResult {
  units: FieldUnit[];
  deployments: BattleDeployment[];
  sources: BattleSource[];
  skippedUnknown: number;
}

/** 选中地块的多边形；地块顶点按 Voronoi 顺序存储，不是闭合环。 */
function selectedCellPolygons(map: MapData, selected: ReadonlySet<number>): BattlePolygon[] {
  const polygons: BattlePolygon[] = [];
  for (const cellId of selected) {
    polygons.push([closeRing(map.cells.polygons[cellId])]);
  }
  return polygons;
}

/** 快照内的上级/预备队引用只能指向已复制单位；指向快照外的引用降级为未知。 */
function remapUnitReference(
  field: BattleField<string | null>,
  idMap: ReadonlyMap<string, string>,
): BattleField<string | null> {
  if (field.state === 'unknown' || field.value === null) return field;
  const mapped = idMap.get(field.value);
  if (mapped !== undefined) return { state: 'known', value: mapped, evidence: field.evidence };
  return {
    state: 'unknown',
    reason: `来源单位不在本战场（原 id: ${field.value}）`,
    evidence: field.evidence,
  };
}

/** 参见 contract-errata 勘误 1：known 非 null 一律降级，原 id 只写进 reason。 */
function remapBattlefieldId(field: BattleField<string | null>): BattleField<string | null> {
  if (field.state === 'unknown' || field.value === null) return field;
  return {
    state: 'unknown',
    reason: `来源战役未纳入此快照（原 id: ${field.value}）`,
    evidence: field.evidence,
  };
}

function addFieldSources<T>(field: BattleField<T>, sourceIds: Set<string>): void {
  for (const item of field.evidence) sourceIds.add(item.sourceId);
}

function collectReferencedSourceIds(
  units: readonly FieldUnit[],
  deployments: readonly BattleDeployment[],
): Set<string> {
  const sourceIds = new Set<string>();
  for (const unit of units) {
    addFieldSources(unit.unitName, sourceIds);
    addFieldSources(unit.provinceId, sourceIds);
    addFieldSources(unit.status, sourceIds);
    addFieldSources(unit.parentUnitId, sourceIds);
    addFieldSources(unit.echelon, sourceIds);
    addFieldSources(unit.branch, sourceIds);
    addFieldSources(unit.side, sourceIds);
    addFieldSources(unit.childrenCompleteness, sourceIds);
    addFieldSources(unit.personnel.count, sourceIds);
  }
  for (const deployment of deployments) {
    addFieldSources(deployment.battlefieldId, sourceIds);
    addFieldSources(deployment.placement, sourceIds);
    addFieldSources(deployment.facingDegrees, sourceIds);
    addFieldSources(deployment.depthMapUnits, sourceIds);
    addFieldSources(deployment.formationLine, sourceIds);
    addFieldSources(deployment.role, sourceIds);
    addFieldSources(deployment.reserveForUnitId, sourceIds);
  }
  return sourceIds;
}

/**
 * 把主地图单位复制成战场快照单位（纯函数，不读 appStore、不回写主地图）。
 * 只纳入 placement 已知且 anchor 落在 selected 地块内的单位；未知位置计入 skippedUnknown。
 */
export function copyBattleUnitsIntoField(
  map: MapData,
  selected: ReadonlySet<number>,
  units: readonly BattleUnit[],
  battle: BattleState,
): CopyBattleUnitsResult {
  const deploymentByUnitId = new Map(battle.deployments.map((deployment) => [deployment.unitId, deployment]));
  const polygons = selectedCellPolygons(map, selected);

  const included: { unit: BattleUnit; deployment: BattleDeployment }[] = [];
  let skippedUnknown = 0;
  for (const unit of units) {
    const deployment = deploymentByUnitId.get(unit.id);
    if (!deployment || deployment.placement.state !== 'known') {
      skippedUnknown += 1;
      continue;
    }
    const anchor = deployment.placement.value.anchor;
    if (!polygons.some((polygon) => pointInPolygon(anchor, polygon))) continue;
    included.push({ unit, deployment });
  }

  const idMap = new Map<string, string>();
  for (const item of included) idMap.set(item.unit.id, crypto.randomUUID());

  const fieldUnits: FieldUnit[] = included.map(({ unit }) => {
    const clone = structuredClone(unit);
    const copy: FieldUnit = {
      ...clone,
      id: idMap.get(unit.id)!,
      sourceUnitId: unit.id,
      parentUnitId: remapUnitReference(clone.parentUnitId, idMap),
    };
    return copy;
  });

  const fieldDeployments: BattleDeployment[] = included.map(({ deployment }) => {
    const clone = structuredClone(deployment);
    return {
      ...clone,
      unitId: idMap.get(clone.unitId)!,
      battlefieldId: remapBattlefieldId(clone.battlefieldId),
      reserveForUnitId: remapUnitReference(clone.reserveForUnitId, idMap),
    };
  });

  const referenced = collectReferencedSourceIds(fieldUnits, fieldDeployments);
  const sources = battle.sources
    .filter((source) => referenced.has(source.id))
    .map((source) => structuredClone(source));

  return { units: fieldUnits, deployments: fieldDeployments, sources, skippedUnknown };
}

/** 只改名称，不改其他字段；空名称由 UI 输入边界拒绝。 */
export function renameFieldBattle(battle: FieldBattle, name: string): FieldBattle {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('战场名称不能为空');
  return { ...battle, name: trimmed };
}

export function removeFieldBattle(list: readonly FieldBattle[], id: string): FieldBattle[] {
  return list.filter((battle) => battle.id !== id);
}
