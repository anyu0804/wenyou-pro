import type {
  BattleCandidateBatch, BattleCandidateItem, BattleEdit, BattleEditBatch,
  BattleEvidence, BattleSource, BattleWorkspace,
} from './battle-contract';
import { previewBattleEdits } from './battle-actions';

function requireValue(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new Error(`${path}：${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path, '需要对象');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0, path, '需要非空文字');
}

function validateEvidence(value: unknown, sourceIds: Set<string>, path: string): asserts value is BattleEvidence[] {
  requireValue(Array.isArray(value), path, '需要来源数组');
  value.forEach((entry: unknown, index: number) => {
    const item = record(entry, `${path}[${index}]`);
    requireValue(typeof item.sourceId === 'string' && sourceIds.has(item.sourceId), `${path}[${index}].sourceId`, '来源 ID 不存在');
    requireValue(['quoted', 'assumption', 'inference'].includes(String(item.basis)), `${path}[${index}].basis`, '需要 quoted/assumption/inference');
    requireValue(typeof item.excerpt === 'string' && typeof item.note === 'string', `${path}[${index}]`, 'excerpt 和 note 必须为文字');
  });
}

/** 已由统一状态校验器检查的对象；遍历只收集字段来源，不重新校验内部字段。 */
export function candidateEvidence(value: unknown): BattleEvidence[] {
  if (Array.isArray(value)) return value.flatMap(candidateEvidence);
  if (value === null || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return Object.entries(object).flatMap(([key, child]) => key === 'evidence'
    ? child as BattleEvidence[] : candidateEvidence(child));
}

function editTarget(edit: BattleEdit): string {
  switch (edit.kind) {
    case 'upsert-unit': return `unit:${edit.unit.id}`;
    case 'remove-unit': return `unit:${edit.unitId}`;
    case 'set-deployment': return `deployment:${edit.deployment.unitId}`;
    case 'upsert-battlefield': return `battlefield:${edit.battlefield.id}`;
    case 'remove-battlefield': return `battlefield:${edit.battlefieldId}`;
    case 'upsert-source': return `source:${edit.source.id}`;
  }
}

function uniqueTargets(edits: BattleEdit[]): void {
  const targets = new Set<string>();
  const removedUnitIds = new Set<string>();
  const deploymentUnitIds = new Set<string>();
  for (const edit of edits) {
    const target = editTarget(edit);
    requireValue(!targets.has(target), target, '选中项重复修改同一对象，请只选择其中一个候选');
    targets.add(target);
    if (edit.kind === 'remove-unit') {
      requireValue(!deploymentUnitIds.has(edit.unitId), `deployment:${edit.unitId}`, '选中项重复修改同一对象，请只选择其中一个候选');
      removedUnitIds.add(edit.unitId);
    } else if (edit.kind === 'set-deployment') {
      requireValue(!removedUnitIds.has(edit.deployment.unitId), `unit:${edit.deployment.unitId}`, '选中项重复修改同一对象，请只选择其中一个候选');
      deploymentUnitIds.add(edit.deployment.unitId);
    }
  }
}

function parseEdit(value: unknown, path: string): BattleEdit {
  const edit = record(value, path);
  switch (edit.kind) {
    case 'upsert-unit': requiredText(record(edit.unit, `${path}.unit`).id, `${path}.unit.id`); break;
    case 'remove-unit': requiredText(edit.unitId, `${path}.unitId`); break;
    case 'set-deployment': requiredText(record(edit.deployment, `${path}.deployment`).unitId, `${path}.deployment.unitId`); break;
    case 'upsert-battlefield': requiredText(record(edit.battlefield, `${path}.battlefield`).id, `${path}.battlefield.id`); break;
    case 'remove-battlefield': requiredText(edit.battlefieldId, `${path}.battlefieldId`); break;
    case 'upsert-source': requiredText(record(edit.source, `${path}.source`).id, `${path}.source.id`); break;
    default: throw new Error(`${path}.kind：不支持的编辑种类 ${String(edit.kind)}`);
  }
  // 完整单位、部署、几何、地形和引用由 previewBattleEdits 内的唯一状态校验器检查。
  return edit as unknown as BattleEdit;
}

function sameSource(left: BattleSource, right: BattleSource): boolean {
  return left.id === right.id && left.kind === right.kind && left.title === right.title
    && left.text === right.text && left.locator === right.locator;
}

function batchForItems(batch: BattleCandidateBatch, items: BattleCandidateItem[]): BattleEditBatch {
  const edits = items.flatMap(item => item.state === 'ready' ? item.edits : []);
  const nonSourceEdits = edits.filter(edit => edit.kind !== 'upsert-source');
  uniqueTargets(nonSourceEdits);
  const ids = new Set(candidateEvidence(items).map(evidence => evidence.sourceId));
  for (const edit of edits) if (edit.kind === 'upsert-source') ids.add(edit.source.id);
  const sourceEdits: BattleEdit[] = batch.sources.filter(source => ids.has(source.id))
    .map(source => ({ kind: 'upsert-source', source }));
  return {
    label: `接受 AI 草案（${items.length} 项）`, origin: 'candidate',
    candidateItemIds: items.map(item => item.id),
    edits: [...sourceEdits, ...nonSourceEdits],
  };
}

/** 外部 JSON 只在这里解析。每个 ready 项是一组可独立审阅的原子编辑。 */
export function parseBattleCandidates(text: string, workspace: BattleWorkspace): BattleCandidateBatch {
  const input = record(JSON.parse(text) as unknown, '$');
  requireValue(input.format === 'wenyou-battle-candidates', '$.format', '需要 wenyou-battle-candidates');
  requireValue(input.version === 1, '$.version', '仅支持版本 1');
  requireValue(input.mapId === workspace.mapId, '$.mapId', `文件与当前战区不一致（当前 ${workspace.mapId}）`);
  requireValue(Array.isArray(input.sources), '$.sources', '需要来源数组');
  requireValue(Array.isArray(input.items), '$.items', '需要候选数组');
  const sources = input.sources as BattleSource[];
  const sourceIds = new Set(workspace.battle.sources.map(source => source.id));
  const declared = new Set<string>();
  sources.forEach((value, index) => {
    const source = record(value, `$.sources[${index}]`);
    requiredText(source.id, `$.sources[${index}].id`);
    requireValue(!declared.has(source.id), `$.sources[${index}].id`, '来源 ID 重复');
    declared.add(source.id);
    sourceIds.add(source.id);
  });
  // 来源结构也复用统一解析器，包含尚未被任何项引用的来源。
  previewBattleEdits(workspace, { label: '解析候选来源', origin: 'candidate', candidateItemIds: [],
    edits: sources.map(source => ({ kind: 'upsert-source', source })) });
  for (const source of sources) {
    const existing = workspace.battle.sources.find(current => current.id === source.id);
    requireValue(existing === undefined || sameSource(existing, source), `$.sources.${source.id}`, '已有来源 ID 的内容不同，请为新原文使用新 ID');
  }
  const itemIds = new Set<string>();
  const items: BattleCandidateItem[] = input.items.map((value: unknown, index: number) => {
    const path = `$.items[${index}]`;
    const item = record(value, path);
    requiredText(item.id, `${path}.id`);
    requireValue(!itemIds.has(item.id), `${path}.id`, '候选 ID 重复');
    itemIds.add(item.id);
    requiredText(item.instruction, `${path}.instruction`);
    validateEvidence(item.evidence, sourceIds, `${path}.evidence`);
    if (item.state === 'unresolved') {
      requiredText(item.reason, `${path}.reason`);
      requireValue(!('edits' in item), `${path}.edits`, '待补项不能包含可执行编辑');
      return { id: item.id, instruction: item.instruction, evidence: item.evidence, state: 'unresolved', reason: item.reason };
    }
    requireValue(item.state === 'ready', `${path}.state`, '需要 ready 或 unresolved');
    requireValue(Array.isArray(item.edits) && item.edits.length > 0, `${path}.edits`, 'ready 项需要明确编辑');
    const edits = item.edits.map((edit: unknown, editIndex: number) => parseEdit(edit, `${path}.edits[${editIndex}]`));
    uniqueTargets(edits);
    for (const edit of edits) if (edit.kind === 'upsert-source') {
      const declaredSource = sources.find(source => source.id === edit.source.id);
      requireValue(declaredSource !== undefined && sameSource(declaredSource, edit.source), `${path}.edits.source`, '来源编辑必须在 sources 中声明相同内容');
    }
    return { id: item.id, instruction: item.instruction, evidence: item.evidence, state: 'ready', edits };
  });
  const batch: BattleCandidateBatch = { format: 'wenyou-battle-candidates', version: 1, mapId: workspace.mapId, sources, items };
  // 不把格式错误伪装成 unresolved。原子项必须自行包含新建单位和所需部署等配套编辑。
  for (const item of items) if (item.state === 'ready') previewBattleEdits(workspace, {
    label: `解析 ${item.id}`, origin: 'candidate', candidateItemIds: [item.id],
    edits: [...sources.map(source => ({ kind: 'upsert-source' as const, source })), ...item.edits],
  });
  return batch;
}

/** 用户选择边界；仍用同一个预览入口检查部分选中后的最终业务引用。 */
export function selectBattleCandidates(batch: BattleCandidateBatch, selectedIds: string[], workspace: BattleWorkspace): BattleEditBatch {
  requireValue(batch.mapId === workspace.mapId, '$.mapId', '已切换战区，请重新导入候选');
  requireValue(selectedIds.length > 0 && new Set(selectedIds).size === selectedIds.length, 'selection', '请选择至少一个不同的 ready 项');
  const items = selectedIds.map(id => {
    const item = batch.items.find(candidate => candidate.id === id);
    requireValue(item !== undefined && item.state === 'ready', `selection.${id}`, '此项不存在或仍待补，不能应用');
    return item;
  });
  const selected = batchForItems(batch, items);
  previewBattleEdits(workspace, selected);
  return selected;
}
