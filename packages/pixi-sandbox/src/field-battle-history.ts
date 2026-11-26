import { upsertBy } from './battle-collections';
import type { BattleDeployment, BattleField, BattleSource, BattleUnit } from './battle-contract';
import type { FieldBattle, FieldUnit, UnitEditBatch } from './field-battle-types';

/**
 * FB-U 的战场撤销栈：一次 apply 调用 = 一个撤销步。
 * 历史只存在内存中，按 battleId 分开；窗口收起/切换战场时由调用方 reset。
 */

interface FieldBattleSnapshot {
  units: FieldUnit[];
  deployments: BattleDeployment[];
  sources: BattleSource[];
}

interface HistoryEntry {
  before: FieldBattleSnapshot;
  after: FieldBattleSnapshot;
}

interface BattleHistory {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

const histories = new Map<string, BattleHistory>();

function snapshot(battle: FieldBattle): FieldBattleSnapshot {
  return structuredClone({
    units: battle.units,
    deployments: battle.deployments,
    sources: battle.sources,
  });
}

function replaceArray<T>(target: T[], next: readonly T[]): void {
  target.splice(0, target.length, ...structuredClone(next));
}

function restore(battle: FieldBattle, value: FieldBattleSnapshot): void {
  replaceArray(battle.units, value.units);
  replaceArray(battle.deployments, value.deployments);
  replaceArray(battle.sources, value.sources);
}

function isFieldUnit(unit: BattleUnit | FieldUnit): unit is FieldUnit {
  return 'sourceUnitId' in unit && typeof unit.sourceUnitId === 'string';
}

/** 已有 FieldUnit 保留原 sourceUnitId；设计器新建的 BattleUnit 补空串。 */
function toFieldUnit(incoming: BattleUnit | FieldUnit, existing?: FieldUnit): FieldUnit {
  const clone = structuredClone(incoming);
  const sourceUnitId = existing ? existing.sourceUnitId : isFieldUnit(incoming) ? incoming.sourceUnitId : '';
  const result: FieldUnit = { ...clone, sourceUnitId };
  return result;
}

function detachReference(
  field: BattleField<string | null>,
  removed: ReadonlySet<string>,
): BattleField<string | null> {
  if (field.state === 'unknown' || field.value === null || !removed.has(field.value)) return field;
  return {
    state: 'unknown',
    reason: `引用单位已删除（原 id: ${field.value}）`,
    evidence: field.evidence,
  };
}

/** 应用一个编辑批次；单位、部署、来源与引用在同一撤销步内一起变化。 */
export function applyFieldBattleBatch(battle: FieldBattle, batch: UnitEditBatch): void {
  const before = snapshot(battle);
  const removed = new Set(batch.units.remove);

  let units = battle.units.map((unit) => structuredClone(unit));
  let deployments = battle.deployments.map((deployment) => structuredClone(deployment));
  let sources: BattleSource[] = battle.sources.map((source) => structuredClone(source));

  units = units.filter((unit) => !removed.has(unit.id));
  deployments = deployments.filter((deployment) => !removed.has(deployment.unitId));
  for (const unit of units) unit.parentUnitId = detachReference(unit.parentUnitId, removed);
  for (const deployment of deployments) {
    deployment.reserveForUnitId = detachReference(deployment.reserveForUnitId, removed);
  }

  for (const incoming of batch.units.upsert) {
    const index = units.findIndex((unit) => unit.id === incoming.id);
    if (index === -1) units.push(toFieldUnit(incoming));
    else units[index] = toFieldUnit(incoming, units[index]);
  }

  const deploymentRemovals = new Set(batch.deployments.removeByUnitId);
  deployments = deployments.filter((deployment) => !deploymentRemovals.has(deployment.unitId));
  for (const incoming of batch.deployments.upsert) {
    upsertBy(deployments, structuredClone(incoming), 'unitId');
  }

  for (const incoming of batch.sources.upsert) {
    upsertBy(sources, structuredClone(incoming), 'id');
  }

  replaceArray(battle.units, units);
  replaceArray(battle.deployments, deployments);
  replaceArray(battle.sources, sources);

  const history = histories.get(battle.id) ?? { undo: [], redo: [] };
  history.undo.push({ before, after: snapshot(battle) });
  history.redo.length = 0;
  histories.set(battle.id, history);
}

export function undoFieldBattle(battle: FieldBattle): boolean {
  const history = histories.get(battle.id);
  if (!history || history.undo.length === 0) return false;
  const entry = history.undo.pop()!;
  restore(battle, entry.before);
  history.redo.push(entry);
  return true;
}

export function redoFieldBattle(battle: FieldBattle): boolean {
  const history = histories.get(battle.id);
  if (!history || history.redo.length === 0) return false;
  const entry = history.redo.pop()!;
  restore(battle, entry.after);
  history.undo.push(entry);
  return true;
}

/** 不传 battleId 时清空全部；窗口收起/切换战场时按 id 清空。 */
export function resetFieldBattleHistory(battleId?: string): void {
  if (battleId === undefined) histories.clear();
  else histories.delete(battleId);
}
