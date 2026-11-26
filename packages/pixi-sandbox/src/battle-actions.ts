import { upsertBy } from './battle-collections';
import { appStore } from './store';
import type { BattleEditBatch, BattleEditReceipt, BattleWorkspace } from './battle-contract';
import { validateBattleWorkspace } from './battle-storage';

const undoStack: { before: BattleWorkspace; after: BattleWorkspace; batch: BattleEditBatch }[] = [];
const redoStack: typeof undoStack = [];

export function getBattleWorkspace(): BattleWorkspace {
  return { mapId: appStore.mapId, garrisons: appStore.garrisons, battle: appStore.battle };
}

export function resetBattleHistory(): void { undoStack.length = 0; redoStack.length = 0; }
export function battleHistoryAvailability(): { undo: boolean; redo: boolean } {
  return { undo: undoStack.length > 0, redo: redoStack.length > 0 };
}

function publish(workspace: BattleWorkspace, batch: BattleEditBatch, origin: BattleEditReceipt['origin']): BattleEditReceipt {
  appStore.garrisons = workspace.garrisons;
  appStore.battle = workspace.battle;
  const unitIds = new Set<string>();
  const battlefieldIds = new Set<string>();
  for (const edit of batch.edits) {
    if (edit.kind === 'upsert-unit') unitIds.add(edit.unit.id);
    if (edit.kind === 'remove-unit') unitIds.add(edit.unitId);
    if (edit.kind === 'set-deployment') unitIds.add(edit.deployment.unitId);
    if (edit.kind === 'upsert-battlefield') battlefieldIds.add(edit.battlefield.id);
    if (edit.kind === 'remove-battlefield') battlefieldIds.add(edit.battlefieldId);
  }
  const receipt: BattleEditReceipt = { mapId: workspace.mapId, label: batch.label, origin,
    candidateItemIds: [...batch.candidateItemIds], changedUnitIds: [...unitIds],
    changedBattlefieldIds: [...battlefieldIds], sourcesChanged: batch.edits.some(e => e.kind === 'upsert-source') };
  appStore.emit('battle:changed', receipt);
  return receipt;
}

/** 运行提交与 A 候选预览共用同一批次计算；不写 store、事件或历史。 */
export function previewBattleEdits(workspace: BattleWorkspace, batch: BattleEditBatch): BattleWorkspace {
  const after = structuredClone(workspace);
  for (const edit of batch.edits) {
    switch (edit.kind) {
      case 'upsert-unit': {
        upsertBy(after.garrisons, structuredClone(edit.unit), 'id');
        break;
      }
      case 'remove-unit':
        if (!after.garrisons.some(u => u.id === edit.unitId)) throw new Error(`删除目标单位不存在：${edit.unitId}`);
        after.garrisons = after.garrisons.filter(u => u.id !== edit.unitId);
        after.battle.deployments = after.battle.deployments.filter(d => d.unitId !== edit.unitId);
        break;
      case 'set-deployment': {
        upsertBy(after.battle.deployments, structuredClone(edit.deployment), 'unitId');
        break;
      }
      case 'upsert-battlefield': {
        upsertBy(after.battle.battlefields, structuredClone(edit.battlefield), 'id');
        break;
      }
      case 'remove-battlefield':
        if (!after.battle.battlefields.some(b => b.id === edit.battlefieldId)) throw new Error(`删除目标战场不存在：${edit.battlefieldId}`);
        after.battle.battlefields = after.battle.battlefields.filter(b => b.id !== edit.battlefieldId);
        break;
      case 'upsert-source': {
        upsertBy(after.battle.sources, structuredClone(edit.source), 'id');
      }
    }
  }
  validateBattleWorkspace(after);
  return after;
}

/** 用户提交入口：整批先生成最终状态，再核对引用；失败不发布任何半份数据。 */
export function applyBattleEdits(batch: BattleEditBatch): BattleEditReceipt {
  if (appStore.isSwitchingMap) throw new Error('正在切换战区，请稍后编辑战役');
  const before = structuredClone(getBattleWorkspace());
  const after = previewBattleEdits(before, batch);
  undoStack.push({ before, after: structuredClone(after), batch: structuredClone(batch) });
  redoStack.length = 0;
  return publish(after, batch, batch.origin);
}

export function undoBattleEdit(): BattleEditReceipt {
  if (appStore.isSwitchingMap || undoStack.length === 0) throw new Error('当前没有可撤销的战役编辑');
  const entry = undoStack.pop()!;
  redoStack.push(entry);
  return publish(structuredClone(entry.before), entry.batch, 'undo');
}
export function redoBattleEdit(): BattleEditReceipt {
  if (appStore.isSwitchingMap || redoStack.length === 0) throw new Error('当前没有可重做的战役编辑');
  const entry = redoStack.pop()!;
  undoStack.push(entry);
  return publish(structuredClone(entry.after), entry.batch, 'redo');
}
