import { knownField } from './battle-contract';
import type {
  BattleAssertion, BattleDeployment, BattleEdit, BattleEvidence, BattleField,
  BattlePersonnelSummary, BattleSource, BattleUnit,
} from './battle-contract';
import type { GarrisonUnit } from './store';

/**
 * O 包：编制树、兵力统计与批量录入。
 *
 * 树只按 parentUnitId 派生，不按名称猜隶属；未知、缺失与环引用分别保留，
 * 不在读取路径改写单位或自动修复编制。
 */

export interface BattleOrbatNode {
  unitId: string;
  unit: BattleUnit;
  children: BattleOrbatNode[];
}

export type BattleOrbatUnattachedReason = 'parent-unknown' | 'parent-missing' | 'cycle';

export interface BattleOrbatUnattached {
  node: BattleOrbatNode;
  reason: BattleOrbatUnattachedReason;
}

export interface BattleOrbat {
  roots: BattleOrbatNode[];
  unattached: BattleOrbatUnattached[];
}

export interface BattleOrbatViewState {
  collapsedUnitIds: string[];
  selectedUnitId: string | null;
}

function indexUnits(units: BattleUnit[]): Map<string, BattleUnit> {
  const index = new Map<string, BattleUnit>();
  for (const unit of units) {
    if (index.has(unit.id)) throw new Error(`编制数据存在重复单位 ID：${unit.id}`);
    index.set(unit.id, unit);
  }
  return index;
}

export function buildBattleOrbat(units: BattleUnit[]): BattleOrbat {
  const index = indexUnits(units);
  const nodes = new Map<string, BattleOrbatNode>();
  for (const unit of units) nodes.set(unit.id, { unitId: unit.id, unit, children: [] });

  const pendingChildren = new Map<string, BattleOrbatNode[]>();
  const roots: BattleOrbatNode[] = [];
  const unattached: { node: BattleOrbatNode; reason: BattleOrbatUnattachedReason }[] = [];

  for (const unit of units) {
    const node = nodes.get(unit.id)!;
    const parent = unit.parentUnitId;
    if (parent.state === 'unknown') {
      unattached.push({ node, reason: 'parent-unknown' });
      continue;
    }
    if (parent.value === null) {
      roots.push(node);
      continue;
    }
    if (parent.value === unit.id) {
      unattached.push({ node, reason: 'cycle' });
      continue;
    }
    if (!index.has(parent.value)) {
      unattached.push({ node, reason: 'parent-missing' });
      continue;
    }
    const siblings = pendingChildren.get(parent.value) ?? [];
    siblings.push(node);
    pendingChildren.set(parent.value, siblings);
  }

  const visited = new Set<string>();
  const attach = (node: BattleOrbatNode): void => {
    if (visited.has(node.unitId)) return;
    visited.add(node.unitId);
    for (const child of pendingChildren.get(node.unitId) ?? []) {
      if (visited.has(child.unitId)) continue;
      node.children.push(child);
      attach(child);
    }
  };

  for (const root of roots) attach(root);
  for (const item of unattached) attach(item.node);

  const order = new Map(units.map((unit, position) => [unit.id, position]));
  for (const unit of units) {
    if (visited.has(unit.id)) continue;
    unattached.push({ node: nodes.get(unit.id)!, reason: 'cycle' });
  }
  unattached.sort((left, right) => order.get(left.node.unitId)! - order.get(right.node.unitId)!);

  return { roots, unattached };
}

export function flattenBattleOrbat(orbat: BattleOrbat): BattleOrbatNode[] {
  const result: BattleOrbatNode[] = [];
  const visit = (node: BattleOrbatNode): void => {
    result.push(node);
    for (const child of node.children) visit(child);
  };
  for (const root of orbat.roots) visit(root);
  for (const item of orbat.unattached) visit(item.node);
  return result;
}

/** 返回 unitId 的全部下级 ID（不含自身）；未知/缺失上级的单位不是任何人的下级。 */
export function collectBattleDescendantIds(units: BattleUnit[], unitId: string): string[] {
  indexUnits(units);
  const children = new Map<string, string[]>();
  for (const unit of units) {
    const parent = unit.parentUnitId;
    if (parent.state === 'known' && parent.value !== null) {
      const list = children.get(parent.value) ?? [];
      list.push(unit.id);
      children.set(parent.value, list);
    }
  }
  const result: string[] = [];
  const seen = new Set<string>([unitId]);
  const visit = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      result.push(child);
      visit(child);
    }
  };
  visit(unitId);
  return result;
}

export function toggleBattleOrbatCollapse(
  state: BattleOrbatViewState,
  unitId: string,
): BattleOrbatViewState {
  const collapsed = new Set(state.collapsedUnitIds);
  if (collapsed.has(unitId)) collapsed.delete(unitId);
  else collapsed.add(unitId);
  return { ...state, collapsedUnitIds: [...collapsed] };
}

/** 按树顺序返回当前可见单位 ID；折叠只隐藏后代，不改变任何单位 ID。 */
export function collectVisibleBattleOrbatUnitIds(
  orbat: BattleOrbat,
  collapsedUnitIds: string[],
): string[] {
  const collapsed = new Set(collapsedUnitIds);
  const result: string[] = [];
  const visit = (node: BattleOrbatNode): void => {
    result.push(node.unitId);
    if (collapsed.has(node.unitId)) return;
    for (const child of node.children) visit(child);
  };
  for (const root of orbat.roots) visit(root);
  for (const item of orbat.unattached) visit(item.node);
  return result;
}

interface PersonnelWalk {
  exact: number | null;
  minimum: number;
  evidence: BattleEvidence[];
}

function evidenceKey(evidence: BattleEvidence): string {
  return `${evidence.sourceId}\u0000${evidence.basis}\u0000${evidence.excerpt}\u0000${evidence.note}`;
}

function pushEvidence(target: BattleEvidence[], evidence: BattleEvidence[], seen: Set<string>): void {
  for (const item of evidence) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(item);
  }
}

function gapEvidence(unit: BattleUnit): BattleEvidence[] {
  const evidence = [...unit.personnel.count.evidence];
  if (unit.childrenCompleteness.state === 'unknown'
    || unit.childrenCompleteness.value === 'partial') {
    evidence.push(...unit.childrenCompleteness.evidence);
  }
  return evidence;
}

/**
 * 契约第 3 节的兵力汇总。请求根转换为子树并集；已知 inclusive 是统计截点；
 * 未知 inclusive、own 子项和 legacy 口径分别只贡献明确下限或未解项。
 */
export function summarizeBattlePersonnel(
  units: BattleUnit[],
  rootUnitIds: string[],
): BattlePersonnelSummary {
  const index = indexUnits(units);
  const children = new Map<string, BattleUnit[]>();
  for (const unit of units) {
    const parent = unit.parentUnitId;
    if (parent.state === 'known' && parent.value !== null && index.has(parent.value)) {
      const list = children.get(parent.value) ?? [];
      list.push(unit);
      children.set(parent.value, list);
    }
  }

  const requested = [...new Set(rootUnitIds)];
  const unknownRootIds = requested.filter((id) => !index.has(id));
  const selected = new Set(requested.filter((id) => index.has(id)));

  // 预检环成员及同环首个被选中的代表根，避免整环互相标记为 nested 导致汇总清零
  const cycleUnitIds = new Set<string>();
  const cycleRepresentative = new Map<string, string>();
  for (const unit of units) {
    const chain: string[] = [];
    const pos = new Map<string, number>();
    let curId: string | null = unit.id;
    while (curId !== null) {
      if (pos.has(curId)) {
        const start = pos.get(curId)!;
        const cycleMembers = chain.slice(start);
        for (const memberId of cycleMembers) cycleUnitIds.add(memberId);
        const firstSelected = requested.find((id) => cycleMembers.includes(id));
        if (firstSelected) {
          for (const memberId of cycleMembers) cycleRepresentative.set(memberId, firstSelected);
        }
        break;
      }
      pos.set(curId, chain.length);
      chain.push(curId);
      const node = index.get(curId);
      if (!node || node.parentUnitId.state !== 'known') break;
      curId = node.parentUnitId.value;
    }
  }

  const nestedSelected = new Set<string>();
  for (const id of selected) {
    if (cycleUnitIds.has(id)) {
      if (cycleRepresentative.get(id) !== id) nestedSelected.add(id);
      continue;
    }
    const seen = new Set<string>([id]);
    let parent = index.get(id)!.parentUnitId;
    while (parent.state === 'known' && parent.value !== null) {
      if (selected.has(parent.value)) {
        nestedSelected.add(id);
        break;
      }
      if (seen.has(parent.value)) break;
      seen.add(parent.value);
      const ancestor = index.get(parent.value);
      if (!ancestor) break;
      parent = ancestor.parentUnitId;
    }
  }
  const topRootIds = requested.filter((id) => selected.has(id) && !nestedSelected.has(id));

  const visited = new Set<string>();
  const counted = new Set<string>();
  const unresolved = new Set<string>(unknownRootIds);
  const excluded = new Set<string>();
  const totalEvidence: BattleEvidence[] = [];
  const evidenceSeen = new Set<string>();
  let exactTotal: number | null = unknownRootIds.length > 0 ? null : 0;
  let knownMinimum = 0;

  const markExcludedSubtree = (unitId: string): void => {
    for (const child of children.get(unitId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      excluded.add(child.id);
      markExcludedSubtree(child.id);
    }
  };

  const visit = (unit: BattleUnit): PersonnelWalk => {
    visited.add(unit.id);
    const ownEvidence = unit.personnel.count.evidence;
    const scope = unit.personnel.scope;
    const count = unit.personnel.count;

    if (scope === 'inclusive' && count.state === 'known') {
      counted.add(unit.id);
      markExcludedSubtree(unit.id);
      if (cycleUnitIds.has(unit.id)) {
        unresolved.add(unit.id);
        return { exact: null, minimum: count.value, evidence: ownEvidence };
      }
      return { exact: count.value, minimum: count.value, evidence: ownEvidence };
    }

    const childWalks: PersonnelWalk[] = [];
    for (const child of children.get(unit.id) ?? []) {
      if (visited.has(child.id)) continue;
      childWalks.push(visit(child));
    }

    if (scope === 'inclusive') {
      unresolved.add(unit.id);
      const evidence = [...ownEvidence];
      let minimum = 0;
      for (const walk of childWalks) {
        minimum += walk.minimum;
        evidence.push(...walk.evidence);
      }
      return { exact: null, minimum, evidence };
    }

    let exact: number | null;
    let minimum: number;
    const evidence = [...ownEvidence];

    if (scope === 'legacy-unspecified') {
      unresolved.add(unit.id);
      exact = null;
      minimum = 0;
    } else if (count.state === 'known') {
      counted.add(unit.id);
      exact = count.value;
      minimum = count.value;
    } else {
      unresolved.add(unit.id);
      exact = null;
      minimum = 0;
    }

    if (cycleUnitIds.has(unit.id)) {
      unresolved.add(unit.id);
      exact = null;
    }

    if (scope !== 'legacy-unspecified'
      && (unit.childrenCompleteness.state === 'unknown'
        || unit.childrenCompleteness.value === 'partial')) {
      unresolved.add(unit.id);
      exact = null;
    }

    for (const walk of childWalks) {
      minimum += walk.minimum;
      evidence.push(...walk.evidence);
      if (walk.exact === null) exact = null;
      else if (exact !== null) exact += walk.exact;
    }

    return { exact, minimum, evidence };
  };

  for (const id of topRootIds) {
    const unit = index.get(id)!;
    const walk = visit(unit);
    knownMinimum += walk.minimum;
    pushEvidence(totalEvidence, walk.evidence, evidenceSeen);
    if (walk.exact === null) exactTotal = null;
    else if (exactTotal !== null) exactTotal += walk.exact;
  }

  if (unknownRootIds.length > 0) exactTotal = null;

  const gapEvidenceList: BattleEvidence[] = [];
  const gapSeen = new Set<string>();
  for (const id of unresolved) {
    const unit = index.get(id);
    if (!unit) continue;
    pushEvidence(gapEvidenceList, gapEvidence(unit), gapSeen);
  }

  const ordered = (set: Set<string>): string[] => units
    .filter((unit) => set.has(unit.id))
    .map((unit) => unit.id);

  const unresolvedOrdered = ordered(unresolved);
  for (const id of unknownRootIds) {
    if (!unresolvedOrdered.includes(id)) unresolvedOrdered.push(id);
  }

  return {
    total: exactTotal === null
      ? {
        state: 'unknown',
        reason: '编制、人数或下属完整性资料不完整，不能给出完整总数',
        evidence: gapEvidenceList,
      }
      : { state: 'known', value: exactTotal, evidence: totalEvidence },
    knownMinimum,
    countedUnitIds: ordered(counted),
    unresolvedUnitIds: unresolvedOrdered,
    excludedUnitIds: ordered(excluded),
  };
}

export function createUnplacedBattleDeployment(
  unitId: string,
  assertion: BattleAssertion,
  evidence: BattleEvidence[],
  reason: string,
): BattleDeployment {
  const unknown = <T>(label: string): BattleField<T> => ({
    state: 'unknown',
    reason: `${reason}：${label}`,
    evidence,
  });
  return {
    unitId,
    assertion,
    battlefieldId: unknown('未指定战场'),
    placement: unknown('没有可定位的部署形态'),
    facingDegrees: unknown('没有朝向资料'),
    depthMapUnits: unknown('没有纵深资料'),
    formationLine: unknown('没有梯队资料'),
    role: unknown('没有战术任务资料'),
    reserveForUnitId: unknown('没有预备队关系'),
  };
}

export interface BattleOrbatBatchOptions {
  units: BattleUnit[];
  assertion: BattleAssertion;
  sourceId: string;
  allocateUnitId: () => string;
  color?: string;
}

export interface BattleOrbatBatchIssue {
  line: number;
  message: string;
}

export interface BattleOrbatBatchResult {
  edits: BattleEdit[];
  source: BattleSource | null;
  unitIdsByKey: Record<string, string>;
  issues: BattleOrbatBatchIssue[];
}

interface BatchRow {
  line: number;
  raw: string;
  key: string;
  name: string | null;
  parent: string | null;
  parentUnknown: boolean;
  echelon: string | null;
  branch: string | null;
  side: string | null;
  scope: 'own' | 'inclusive' | 'legacy-unspecified';
  count: number | null;
  completeness: 'complete' | 'partial' | 'unknown';
}

/**
 * 手工批量录入的外部文本边界，一次解析并逐行报告。
 * 行格式：临时键 | 名称 | 上级 | 层级 | 兵种 | 阵营 | 人数口径 | 人数 | 下属完整性
 * 上级：- 已知无上级；? 上级未知；否则为现有单位 ID 或本批临时键。
 * 名称/层级/兵种/阵营：? 表示未知；人数：? 表示未知；完整性：? 或空表示未知。
 */
export function parseBattleOrbatBatch(
  text: string,
  options: BattleOrbatBatchOptions,
): BattleOrbatBatchResult {
  const issues: BattleOrbatBatchIssue[] = [];
  const existing = indexUnits(options.units);
  const rows: BatchRow[] = [];
  const keys = new Set<string>();

  const rawLines = text.split(/\r?\n/);
  for (let position = 0; position < rawLines.length; position += 1) {
    const rawLine = rawLines[position].replace(/\r$/, '');
    const raw = rawLine.trim();
    const line = position + 1;
    if (raw === '' || raw.startsWith('#')) continue;

    const separator = rawLine.includes('|') ? '|' : rawLine.includes('\t') ? '\t' : '';
    if (separator === '') {
      issues.push({ line, message: '列分隔符应为 | 或制表符' });
      continue;
    }
    const cells = (separator === '\t' ? rawLine : raw).split(separator).map((cell) => cell.trim());
    if (cells.length !== 9) {
      issues.push({ line, message: `需要 9 列，实际 ${cells.length} 列` });
      continue;
    }

    const [key, nameCell, parentCell, echelonCell, branchCell, sideCell, scopeCell, countCell, completenessCell] = cells;
    if (key === '') {
      issues.push({ line, message: '临时键为空' });
      continue;
    }
    if (keys.has(key)) {
      issues.push({ line, message: `临时键重复：${key}` });
      continue;
    }
    if (existing.has(key)) {
      issues.push({ line, message: `临时键与现有单位 ID 冲突：${key}` });
      continue;
    }
    keys.add(key);

    if (nameCell === '') {
      issues.push({ line, message: '名称为空；未知请填 ?' });
      continue;
    }

    let scope: BatchRow['scope'];
    if (scopeCell === 'own' || scopeCell === 'inclusive' || scopeCell === 'legacy-unspecified') {
      scope = scopeCell;
    } else {
      issues.push({ line, message: `人数口径必须是 own / inclusive / legacy-unspecified，实际为 ${scopeCell || '空'}` });
      continue;
    }

    let count: number | null = null;
    if (countCell !== '?') {
      if (!/^\d+$/.test(countCell)) {
        issues.push({ line, message: `人数必须是 ? 或非负整数，实际为 ${countCell || '空'}` });
        continue;
      }
      count = Number(countCell);
    }

    let completeness: BatchRow['completeness'];
    if (completenessCell === '' || completenessCell === '?') completeness = 'unknown';
    else if (completenessCell === 'complete' || completenessCell === 'partial' || completenessCell === 'unknown') {
      completeness = completenessCell;
    } else {
      issues.push({ line, message: `下属完整性必须是 complete / partial / unknown / ?，实际为 ${completenessCell}` });
      continue;
    }

    rows.push({
      line,
      raw,
      key,
      name: nameCell === '?' ? null : nameCell,
      parent: parentCell === '-' || parentCell === '?' ? null : parentCell,
      parentUnknown: parentCell === '?',
      echelon: echelonCell === '?' || echelonCell === '' ? null : echelonCell,
      branch: branchCell === '?' || branchCell === '' ? null : branchCell,
      side: sideCell === '?' || sideCell === '' ? null : sideCell,
      scope,
      count,
      completeness,
    });
  }

  if (rows.length === 0 && issues.length === 0) {
    issues.push({ line: 0, message: '没有可解析的数据行' });
  }

  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  for (const row of rows) {
    if (row.parent === null || existing.has(row.parent)) continue;
    const parentRow = rowByKey.get(row.parent);
    if (!parentRow) {
      issues.push({ line: row.line, message: `上级既不是现有单位 ID，也不是本批临时键：${row.parent}` });
      continue;
    }
    if (parentRow.key === row.key) {
      issues.push({ line: row.line, message: '上级不能是本行自身' });
      continue;
    }
    const seen = new Set<string>([row.key]);
    let cursor: BatchRow | undefined = parentRow;
    while (cursor) {
      if (seen.has(cursor.key)) {
        issues.push({ line: row.line, message: `批量录入形成编制环：${[...seen, cursor.key].join(' → ')}` });
        break;
      }
      seen.add(cursor.key);
      cursor = cursor.parent === null || existing.has(cursor.parent) ? undefined : rowByKey.get(cursor.parent);
    }
  }

  if (issues.length > 0) {
    return { edits: [], source: null, unitIdsByKey: {}, issues };
  }

  const unitIdsByKey: Record<string, string> = Object.create(null);
  const usedIds = new Set(existing.keys());
  for (const row of rows) {
    const id = options.allocateUnitId();
    if (usedIds.has(id)) {
      issues.push({ line: row.line, message: `分配的单位 ID 重复：${id}` });
      continue;
    }
    usedIds.add(id);
    unitIdsByKey[row.key] = id;
  }
  if (issues.length > 0) {
    return { edits: [], source: null, unitIdsByKey: {}, issues };
  }

  const source: BattleSource = {
    id: options.sourceId,
    kind: 'manual',
    title: '编制批量录入',
    text: text.trim(),
    locator: '编制编辑器 · 批量录入',
  };

  const unitEdits: BattleEdit[] = [];
  const deploymentEdits: BattleEdit[] = [];

  for (const row of rows) {
    const unitId = unitIdsByKey[row.key];
    const evidence: BattleEvidence = {
      sourceId: source.id,
      basis: 'quoted',
      excerpt: row.raw,
      note: '批量录入原文',
    };
    const unknown = <T>(field: string): BattleField<T> => ({
      state: 'unknown',
      reason: `批量录入未提供${field}`,
      evidence: [evidence],
    });
    const parentValue = row.parent === null
      ? (row.parentUnknown ? unknown<string | null>('上级') : knownField(null, [evidence]) as BattleField<string | null>)
      : {
        state: 'known',
        value: unitIdsByKey[row.parent] ?? row.parent,
        evidence: [evidence],
      } as BattleField<string | null>;
    const unit: BattleUnit = {
      id: unitId,
      color: options.color ?? '#3b82f6',
      assertion: options.assertion,
      unitName: row.name === null
        ? unknown<string>('名称')
        : knownField(row.name, [evidence]),
      provinceId: unknown<number | null>('行政归属'),
      status: unknown<GarrisonUnit['status']>('部队状态'),
      parentUnitId: parentValue,
      echelon: row.echelon === null
        ? unknown<string>('层级')
        : knownField(row.echelon, [evidence]),
      branch: row.branch === null
        ? unknown<string>('兵种')
        : knownField(row.branch, [evidence]),
      side: row.side === null
        ? unknown<string>('阵营')
        : knownField(row.side, [evidence]),
      childrenCompleteness: row.completeness === 'unknown'
        ? unknown<'complete' | 'partial'>('下属完整性')
        : knownField(row.completeness, [evidence]),
      personnel: {
        scope: row.scope,
        count: row.count === null
          ? unknown<number>('人数')
          : knownField(row.count, [evidence]),
      },
    };
    unitEdits.push({ kind: 'upsert-unit', unit });
    deploymentEdits.push({
      kind: 'set-deployment',
      deployment: createUnplacedBattleDeployment(
        unitId,
        options.assertion,
        [evidence],
        '批量录入的新单位尚未部署',
      ),
    });
  }

  return {
    edits: [
      { kind: 'upsert-source', source },
      ...unitEdits,
      ...deploymentEdits,
    ],
    source,
    unitIdsByKey,
    issues: [],
  };
}
