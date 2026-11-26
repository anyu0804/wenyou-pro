import { knownField, unknownField } from './battle-contract';
import type {
  BadgeCultureStyle, CustomBadgeConfig,
  BattleAssertion, BattleEdit, BattleEditBatch, BattleEvidence, BattleField,
  BattleSource, BattleUnit, BattleWorkspace,
} from './battle-contract';
import {
  buildBattleOrbat, collectBattleDescendantIds, createUnplacedBattleDeployment,
  flattenBattleOrbat, parseBattleOrbatBatch, summarizeBattlePersonnel,
  type BattleOrbat, type BattleOrbatBatchIssue, type BattleOrbatNode,
  type BattleOrbatUnattached,
} from './battle-orbat';
import { resolveTroopEchelon } from './military-symbols';

/**
 * O 包：编制编辑面板。
 *
 * 面板不直接引用 appStore：P0 通过 getWorkspace 提供当前 BattleWorkspace，
 * 通过 applyBatch 调用唯一提交入口；提交后由 P0 在 battle:changed 时调用 refresh。
 * 面板本身不保存业务状态，所有改动以 BattleEditBatch 交给 P0。
 */

export interface BattleOrbatEditorOptions {
  getWorkspace: () => BattleWorkspace;
  applyBatch: (batch: BattleEditBatch) => void;
  allocateUnitId: () => string;
  allocateSourceId: () => string;
  /** 树中点选时通知宿主；宿主据此同步地图选择。 */
  onSelectUnit?: (unitId: string | null) => void;
  /** 点击证据定位原文时通知宿主（桥接宿主原文抽屉）。 */
  onFocusSource?: (payload: { sourceId: string; highlightQuote?: string }) => void;
}

export interface BattleOrbatEditorHandle {
  refresh: () => void;
  destroy: () => void;
  /** 宿主把地图选择同步到树；不会再次触发 onSelectUnit。 */
  selectUnit: (unitId: string | null) => void;
}

type EditorMode = 'detail' | 'create' | 'batch';

interface EditorState {
  collapsedUnitIds: string[];
  selectedUnitId: string | null;
  mode: EditorMode;
  staged: BattleEdit[];
  notice: string | null;
  batchText: string;
  batchAssertion: BattleAssertion;
  batchIssues: BattleOrbatBatchIssue[];
}

interface TextDraft {
  unknown: boolean;
  value: string;
  reason: string;
}

interface ParentDraft {
  unknown: boolean;
  value: string | null;
  reason: string;
}

interface CountDraft {
  unknown: boolean;
  value: number;
  reason: string;
}

interface CompletenessDraft {
  unknown: boolean;
  value: 'complete' | 'partial' | 'unknown';
  reason: string;
}

interface FieldControl {
  row: HTMLDivElement;
  control: HTMLInputElement | HTMLSelectElement;
  unknown: HTMLInputElement;
  reason: HTMLInputElement;
}

interface CompletenessControl {
  row: HTMLDivElement;
  select: HTMLSelectElement;
  reason: HTMLInputElement;
}

const STYLE_ID = 'battle-orbat-editor-style';

// 详情与新建表单共用同一组用户输入字段。
function createBadgeFields(doc: Document, form: HTMLFormElement, count: HTMLInputElement,
  echelon: FieldControl, initial?: CustomBadgeConfig) {
  const culture = doc.createElement('select');
  for (const [value, label] of Object.entries({ universal: '通用分档', nato: '现代北约',
    huaxia: '华夏旌旗', western: '西式纹章', nomad: '草原狼纛', arcane: '奇幻奥术', custom: '自由定制' })) {
    culture.append(option(doc, value, label));
  }
  culture.value = initial?.culture ?? 'universal';
  const textColor = doc.createElement('input');
  textColor.type = 'color';
  textColor.value = initial?.textColor ?? '#f8fafc';
  const glyph = doc.createElement('input'); glyph.value = initial?.customGlyph ?? ''; glyph.maxLength = 4;
  const icon = doc.createElement('input'); icon.value = initial?.customIconDataUrl ?? '';
  icon.pattern = 'data:image/.*'; icon.placeholder = '可选 data:image/…';
  const auto = button(doc, '按人数自动匹配编制（连~方面军）');
  auto.addEventListener('click', () => {
    if (!count.reportValidity() || count.value === '') return;
    echelon.unknown.checked = false;
    echelon.unknown.dispatchEvent(new Event('change'));
    echelon.control.value = resolveTroopEchelon(Number(count.value)).echelonName;
  });
  form.append(auto, createPlainField(doc, '兵牌文化', culture),
    createPlainField(doc, '兵牌字体颜色', textColor), createPlainField(doc, '中心字/徽记', glyph),
    createPlainField(doc, '自定义兵牌图片', icon));
  return () : CustomBadgeConfig => ({ culture: culture.value as BadgeCultureStyle,
    textColor: /^#[0-9a-f]{6}$/i.test(textColor.value) ? textColor.value : undefined,
    customGlyph: glyph.value.trim() || undefined,
    customIconDataUrl: icon.value.trim() || undefined });
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(doc: Document, text: string, className = 'bob-btn'): HTMLButtonElement {
  const node = el(doc, 'button', className, text);
  node.type = 'button';
  return node;
}

function option(doc: Document, value: string, text: string): HTMLOptionElement {
  const node = doc.createElement('option');
  node.value = value;
  node.textContent = text;
  return node;
}

function sourceEvidence(source: BattleSource, note: string): BattleEvidence {
  return {
    sourceId: source.id,
    basis: 'quoted',
    excerpt: source.text,
    note,
  };
}

function withKnown<T>(old: BattleField<T>, value: T, evidence: BattleEvidence): BattleField<T> {
  if (old.state === 'known' && old.value === value) return old;
  return knownField(value, [evidence]);
}

function withUnknown<T>(old: BattleField<T>, reason: string, evidence: BattleEvidence): BattleField<T> {
  if (old.state === 'unknown' && old.reason === reason) return old;
  return unknownField(reason, [evidence]);
}

function unitLabel(unit: BattleUnit): string {
  return unit.unitName.state === 'known' ? unit.unitName.value : `名称未知（${unit.id}）`;
}

function unitNameText(unit: BattleUnit): string {
  return unit.unitName.state === 'known' ? unit.unitName.value : '名称未知';
}

function assertionLabel(assertion: BattleAssertion): string {
  return assertion === 'reported' ? '记录' : '方案';
}

function scopeLabel(scope: BattleUnit['personnel']['scope']): string {
  if (scope === 'own') return '本部';
  if (scope === 'inclusive') return '含下属';
  return '旧口径未说明';
}

function personnelText(unit: BattleUnit): string {
  const count = unit.personnel.count;
  if (count.state === 'unknown') return '人数未知';
  return `${scopeLabel(unit.personnel.scope)} ${count.value.toLocaleString('zh-CN')} 人`;
}

function completenessWarning(unit: BattleUnit): string | null {
  if (unit.childrenCompleteness.state === 'unknown') return '下属完整性未知';
  if (unit.childrenCompleteness.value === 'partial') return '下属不完整';
  return null;
}

function unattachedReasonLabel(reason: BattleOrbatUnattached['reason']): string {
  if (reason === 'parent-unknown') return '上级资料未给出';
  if (reason === 'parent-missing') return '上级 ID 不在本战区';
  return '编制环引用，无法挂接';
}

function createFieldControl(
  doc: Document,
  label: string,
  control: HTMLInputElement | HTMLSelectElement,
  initial: { unknown: boolean; reason: string; requiredWhenKnown: boolean },
): FieldControl {
  const row = el(doc, 'div', 'bob-field');
  const head = el(doc, 'div', 'bob-field-head');
  head.append(el(doc, 'span', 'bob-label', label));
  const unknownLabel = el(doc, 'label', 'bob-unknown');
  const unknown = doc.createElement('input');
  unknown.type = 'checkbox';
  unknown.checked = initial.unknown;
  unknownLabel.append(unknown, doc.createTextNode(' 未知'));
  head.append(unknownLabel);

  const body = el(doc, 'div', 'bob-field-body');
  control.classList.add('bob-input');
  const reason = doc.createElement('input');
  reason.type = 'text';
  reason.className = 'bob-input bob-reason';
  reason.placeholder = '未知原因（必填）';
  reason.value = initial.reason;
  body.append(control, reason);
  row.append(head, body);

  const sync = (): void => {
    const checked = unknown.checked;
    control.disabled = checked;
    control.required = !checked && initial.requiredWhenKnown;
    reason.disabled = !checked;
    reason.required = checked;
    row.classList.toggle('bob-is-unknown', checked);
  };
  unknown.addEventListener('change', sync);
  sync();
  return { row, control, unknown, reason };
}

function createPlainField(
  doc: Document,
  label: string,
  control: HTMLInputElement | HTMLSelectElement,
  hint?: string,
): HTMLDivElement {
  const row = el(doc, 'div', 'bob-field');
  const head = el(doc, 'div', 'bob-field-head');
  head.append(el(doc, 'span', 'bob-label', label));
  const body = el(doc, 'div', 'bob-field-body');
  control.classList.add('bob-input');
  body.append(control);
  row.append(head, body);
  if (hint) row.append(el(doc, 'span', 'bob-hint', hint));
  return row;
}

function createCompletenessField(
  doc: Document,
  field: BattleField<'complete' | 'partial'>,
): CompletenessControl {
  const row = el(doc, 'div', 'bob-field');
  const head = el(doc, 'div', 'bob-field-head');
  head.append(el(doc, 'span', 'bob-label', '下属完整性'));
  const body = el(doc, 'div', 'bob-field-body');
  const select = doc.createElement('select');
  select.className = 'bob-input';
  select.append(
    option(doc, 'complete', '完整'),
    option(doc, 'partial', '不完整'),
    option(doc, 'unknown', '未知'),
  );
  select.value = field.state === 'unknown' ? 'unknown' : field.value;
  const reason = doc.createElement('input');
  reason.type = 'text';
  reason.className = 'bob-input bob-reason';
  reason.placeholder = '未知原因（必填）';
  reason.value = field.state === 'unknown' ? field.reason : '';
  body.append(select, reason);
  row.append(head, body);

  const sync = (): void => {
    const isUnknown = select.value === 'unknown';
    reason.disabled = !isUnknown;
    reason.required = isUnknown;
  };
  select.addEventListener('change', sync);
  sync();
  return { row, select, reason };
}

function fillParentSelect(
  doc: Document,
  select: HTMLSelectElement,
  units: BattleUnit[],
  current: BattleField<string | null>,
  blockedIds: Set<string>,
): void {
  select.append(option(doc, '', '请选择上级'));
  select.append(option(doc, '__root__', '无上级（根）'));
  for (const unit of units) {
    if (blockedIds.has(unit.id)) continue;
    select.append(option(doc, unit.id, `${unitLabel(unit)}（${unit.id}）`));
  }
  if (current.state === 'known' && current.value !== null) {
    const exists = Array.from(select.options).some((item) => item.value === current.value);
    if (!exists) {
      select.append(option(doc, current.value, `${current.value}（当前上级，无法挂接）`));
    }
    select.value = current.value;
  } else if (current.state === 'known') {
    select.value = '__root__';
  } else {
    select.value = '';
  }
}

function readTextDraft(control: HTMLInputElement | HTMLSelectElement, unknown: HTMLInputElement, reason: HTMLInputElement): TextDraft {
  return { unknown: unknown.checked, value: control.value.trim(), reason: reason.value.trim() };
}

function readParentDraft(control: HTMLSelectElement, unknown: HTMLInputElement, reason: HTMLInputElement): ParentDraft {
  if (unknown.checked) return { unknown: true, value: null, reason: reason.value.trim() };
  if (control.value === '__root__') return { unknown: false, value: null, reason: '' };
  return { unknown: false, value: control.value, reason: '' };
}

function readCountDraft(control: HTMLInputElement, unknown: HTMLInputElement, reason: HTMLInputElement): CountDraft {
  return {
    unknown: unknown.checked,
    value: control.value === '' ? 0 : Number(control.value),
    reason: reason.value.trim(),
  };
}

function readCompletenessDraft(control: CompletenessControl): CompletenessDraft {
  const value = control.select.value as 'complete' | 'partial' | 'unknown';
  if (value === 'unknown') {
    return { unknown: true, value: 'unknown', reason: control.reason.value.trim() };
  }
  return { unknown: false, value, reason: '' };
}

function describeChanges(
  unit: BattleUnit,
  drafts: {
    name: TextDraft;
    parent: ParentDraft;
    echelon: TextDraft;
    branch: TextDraft;
    side: TextDraft;
    count: CountDraft;
    completeness: CompletenessDraft;
    assertion: BattleAssertion;
  },
): string[] {
  const changes: string[] = [];
  const compareText = (label: string, field: BattleField<string>, draft: TextDraft): void => {
    if (draft.unknown) {
      if (field.state !== 'unknown' || field.reason !== draft.reason) {
        changes.push(`${label}=未知（${draft.reason}）`);
      }
    } else if (field.state !== 'known' || field.value !== draft.value) {
      changes.push(`${label}=${draft.value}`);
    }
  };
  const compareParent = (field: BattleField<string | null>, draft: ParentDraft): void => {
    if (draft.unknown) {
      if (field.state !== 'unknown' || field.reason !== draft.reason) {
        changes.push(`上级=未知（${draft.reason}）`);
      }
    } else if (field.state !== 'known' || field.value !== draft.value) {
      changes.push(`上级=${draft.value === null ? '无上级' : draft.value}`);
    }
  };
  const compareCount = (field: BattleField<number>, draft: CountDraft): void => {
    if (draft.unknown) {
      if (field.state !== 'unknown' || field.reason !== draft.reason) {
        changes.push(`人数=未知（${draft.reason}）`);
      }
    } else if (field.state !== 'known' || field.value !== draft.value) {
      changes.push(`人数=${draft.value}`);
    }
  };
  const compareCompleteness = (field: BattleField<'complete' | 'partial'>, draft: CompletenessDraft): void => {
    if (draft.unknown) {
      if (field.state !== 'unknown' || field.reason !== draft.reason) {
        changes.push(`下属完整性=未知（${draft.reason}）`);
      }
    } else if (field.state !== 'known' || field.value !== draft.value) {
      changes.push(`下属完整性=${draft.value}`);
    }
  };

  compareText('名称', unit.unitName, drafts.name);
  compareParent(unit.parentUnitId, drafts.parent);
  compareText('层级', unit.echelon, drafts.echelon);
  compareText('兵种', unit.branch, drafts.branch);
  compareText('阵营', unit.side, drafts.side);
  compareCount(unit.personnel.count, drafts.count);
  compareCompleteness(unit.childrenCompleteness, drafts.completeness);
  if (unit.assertion !== drafts.assertion) changes.push(`资料属性=${assertionLabel(drafts.assertion)}`);
  return changes;
}

function evidenceLabel(basis: BattleEvidence['basis']): string {
  if (basis === 'quoted') return '引用';
  if (basis === 'assumption') return '假设';
  return '推断';
}

function sourceKindLabel(kind: BattleSource['kind']): string {
  if (kind === 'reference') return '文献';
  if (kind === 'manual') return '手工';
  if (kind === 'ai') return 'AI';
  return '旧数据';
}

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.bob-root {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: #101922; color: #dbe7f0; font: 12px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
  border: 1px solid #263746; border-radius: 10px; overflow: hidden;
}
.bob-header { display: flex; align-items: baseline; gap: 10px; padding: 12px 14px 8px; }
.bob-title { font-size: 15px; font-weight: 700; letter-spacing: .04em; }
.bob-stats { color: #8fa9bd; font-size: 11px; }
.bob-toolbar { display: flex; align-items: center; gap: 8px; padding: 0 14px 10px; border-bottom: 1px solid #1f2d39; }
.bob-notice { color: #67d4c3; font-size: 11px; margin-left: auto; text-align: right; }
.bob-body { display: grid; grid-template-columns: minmax(250px, 1.05fr) minmax(300px, 1.3fr); min-height: 0; flex: 1; }
@media (max-width: 760px) { .bob-body { grid-template-columns: 1fr; } }
.bob-tree { min-height: 0; overflow: auto; padding: 8px; border-right: 1px solid #1f2d39; }
.bob-detail { min-height: 0; overflow: auto; padding: 10px 12px 14px; }
.bob-group-title { color: #8fa9bd; font-size: 11px; margin: 10px 4px 4px; }
.bob-node { display: block; }
.bob-children { padding-left: 12px; border-left: 1px dashed #243441; margin-left: 8px; }
.bob-row { display: flex; align-items: center; flex-wrap: wrap; row-gap: 3px; column-gap: 5px; padding: 5px 6px; border-radius: 6px; cursor: pointer; }
.bob-row:hover { background: #182633; }
.bob-row.selected { background: #1d3a4d; outline: 1px solid #2f6c88; }
.bob-row.unattached { border-left: 2px solid #b58a3e; }
.bob-toggle { width: 18px; height: 18px; flex: 0 0 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: #8fa9bd; cursor: pointer; }
.bob-toggle:hover { background: #243441; color: #dbe7f0; }
.bob-toggle-spacer { width: 18px; flex: 0 0 18px; }
.bob-name { font-weight: 600; min-width: 76px; flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bob-name.unknown { color: #7f93a5; font-weight: 500; }
.bob-chip { color: #92a9bb; background: #182633; border: 1px solid #243441; border-radius: 999px; padding: 0 6px; font-size: 10px; white-space: nowrap; }
.bob-warn { color: #e0b25c; font-size: 10px; white-space: nowrap; }
.bob-reason-badge { color: #d6a95c; font-size: 10px; white-space: nowrap; }
.bob-detail-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; margin-bottom: 8px; }
.bob-detail-title { font-size: 14px; font-weight: 700; }
.bob-detail-sub { color: #8fa9bd; font-size: 11px; margin-top: 2px; }
.bob-summary { background: #0c151d; border: 1px solid #22313d; border-radius: 7px; padding: 7px 9px; margin: 8px 0 10px; color: #a9c0d1; font-size: 11px; }
.bob-form { display: flex; flex-direction: column; gap: 7px; }
.bob-field { border: 1px solid #1f2d39; border-radius: 7px; padding: 6px 8px; background: #0d1720; }
.bob-field-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.bob-label { color: #9fb7c8; font-size: 11px; }
.bob-unknown { color: #8fa9bd; font-size: 10px; user-select: none; }
.bob-field-body { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
.bob-input { flex: 1; min-width: 0; background: #101b25; color: #dbe7f0; border: 1px solid #2a3d4c; border-radius: 5px; padding: 4px 6px; font: inherit; }
.bob-input:disabled { opacity: .45; }
.bob-input:focus { outline: 1px solid #3d87a8; border-color: #3d87a8; }
.bob-field.bob-is-unknown .bob-input:not(.bob-reason) { opacity: .45; }
.bob-reason { flex: 1.1; }
.bob-reason:disabled { display: none; }
.bob-hint { display: block; margin-top: 4px; color: #7f93a5; font-size: 10px; line-height: 1.4; }
.bob-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.bob-btn { background: #1d3a4d; color: #dbe7f0; border: 1px solid #2f6c88; border-radius: 6px; padding: 4px 9px; font: inherit; cursor: pointer; }
.bob-btn:hover { background: #245068; }
.bob-btn:disabled { opacity: .45; cursor: default; }
.bob-btn-ghost { background: transparent; border-color: #2a3d4c; color: #a9c0d1; }
.bob-btn-danger { background: #3a1f24; border-color: #7a3542; color: #f0b7c0; }
.bob-btn-danger:hover { background: #4c2830; }
.bob-evidence { margin-top: 12px; border-top: 1px solid #1f2d39; padding-top: 8px; }
.bob-evidence summary { color: #a9c0d1; cursor: pointer; font-size: 11px; }
.bob-evidence-row { margin: 6px 0 8px; }
.bob-evidence-label { color: #9fb7c8; font-size: 11px; }
.bob-evidence-body { color: #8097a9; font-size: 10px; margin-top: 2px; }
.bob-staged { border-top: 1px solid #1f2d39; padding: 8px 12px 10px; max-height: 180px; overflow: auto; }
.bob-staged-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.bob-staged-title { color: #a9c0d1; font-size: 11px; font-weight: 600; }
.bob-staged-list { margin: 0; padding-left: 18px; color: #8fa9bd; font-size: 11px; }
.bob-staged-list li { margin: 2px 0; }
.bob-issues { margin: 6px 0 0; padding-left: 18px; color: #e0b25c; font-size: 11px; }
.bob-textarea { width: 100%; box-sizing: border-box; min-height: 150px; resize: vertical; background: #0c151d; color: #dbe7f0; border: 1px solid #2a3d4c; border-radius: 6px; padding: 7px; font: 11px/1.5 Consolas, monospace; }
.bob-help { color: #7f93a5; font-size: 10px; white-space: pre-wrap; }
`;
  doc.head.appendChild(style);
}

export function initBattleOrbatEditor(
  mountEl: HTMLElement,
  options: BattleOrbatEditorOptions,
): BattleOrbatEditorHandle {
  const doc = mountEl.ownerDocument;
  injectStyles(doc);

  const state: EditorState = {
    collapsedUnitIds: [],
    selectedUnitId: null,
    mode: 'detail',
    staged: [],
    notice: null,
    batchText: '',
    batchAssertion: 'plan',
    batchIssues: [],
  };

  let workspace: BattleWorkspace;
  let orbat: BattleOrbat;

  const root = el(doc, 'div', 'bob-root');
  const header = el(doc, 'div', 'bob-header');
  const stats = el(doc, 'div', 'bob-stats');
  header.append(el(doc, 'div', 'bob-title', '编制'), stats);

  const notice = el(doc, 'div', 'bob-notice');
  const toolbar = el(doc, 'div', 'bob-toolbar');
  const createButton = button(doc, '＋ 新建单位');
  const batchButton = button(doc, '批量录入');
  toolbar.append(createButton, batchButton, notice);

  const treeEl = el(doc, 'div', 'bob-tree');
  treeEl.setAttribute('role', 'tree');
  const detailEl = el(doc, 'div', 'bob-detail');
  const body = el(doc, 'div', 'bob-body');
  body.append(treeEl, detailEl);

  const stagedEl = el(doc, 'div', 'bob-staged');
  root.append(header, toolbar, body, stagedEl);
  mountEl.appendChild(root);

  const renderNotice = (): void => {
    notice.textContent = state.notice ?? '';
  };

  const setNotice = (message: string | null): void => {
    state.notice = message;
    renderNotice();
  };

  const stageEdit = (edit: BattleEdit): void => {
    if (edit.kind === 'upsert-unit') {
      state.staged = state.staged.filter(
        (item) => !(item.kind === 'upsert-unit' && item.unit.id === edit.unit.id)
          && !(item.kind === 'remove-unit' && item.unitId === edit.unit.id),
      );
    } else if (edit.kind === 'set-deployment') {
      state.staged = state.staged.filter(
        (item) => !(item.kind === 'set-deployment' && item.deployment.unitId === edit.deployment.unitId),
      );
    } else if (edit.kind === 'remove-unit') {
      state.staged = state.staged.filter(
        (item) => !((item.kind === 'upsert-unit' && item.unit.id === edit.unitId)
          || (item.kind === 'set-deployment' && item.deployment.unitId === edit.unitId)
          || (item.kind === 'remove-unit' && item.unitId === edit.unitId)),
      );
    }
    state.staged.push(edit);
  };

  const effectiveUnits = (): BattleUnit[] => {
    const stagedUpserts = new Map<string, BattleUnit>();
    const stagedRemoved = new Set<string>();
    for (const item of state.staged) {
      if (item.kind === 'upsert-unit') stagedUpserts.set(item.unit.id, item.unit);
      else if (item.kind === 'remove-unit') stagedRemoved.add(item.unitId);
    }
    const merged = workspace.garrisons
      .filter((u) => !stagedRemoved.has(u.id))
      .map((u) => stagedUpserts.get(u.id) ?? u);
    for (const [id, unit] of stagedUpserts) {
      if (!workspace.garrisons.some((u) => u.id === id)) merged.push(unit);
    }
    return merged;
  };

  const currentUnit = (unitId: string): BattleUnit | null => {
    const staged = state.staged.find(
      (item): item is Extract<BattleEdit, { kind: 'upsert-unit' }> =>
        item.kind === 'upsert-unit' && item.unit.id === unitId,
    );
    if (staged) return staged.unit;
    const node = flattenBattleOrbat(orbat).find((item) => item.unitId === unitId);
    return node ? node.unit : null;
  };

  const unitIsCycle = (unitId: string): boolean => orbat.unattached.some(
    (item) => item.reason === 'cycle' && item.node.unitId === unitId,
  );

  const renderStats = (): void => {
    const topIds = [
      ...orbat.roots.map((node) => node.unitId),
      ...orbat.unattached
        .filter((item) => item.reason !== 'cycle')
        .map((item) => item.node.unitId),
    ];
    const summary = summarizeBattlePersonnel(workspace.garrisons, topIds);
    const cycleCount = orbat.unattached.filter((item) => item.reason === 'cycle').length;
    const totalText = summary.total.state === 'known'
      ? `总人数 ${summary.total.value.toLocaleString('zh-CN')}`
      : `总数未知（已知至少 ${summary.knownMinimum.toLocaleString('zh-CN')}）`;
    const parts = [
      `单位 ${workspace.garrisons.length}`,
      totalText,
      `未解 ${summary.unresolvedUnitIds.length}`,
    ];
    if (cycleCount > 0) parts.push(`环引用 ${cycleCount}（未计入汇总）`);
    stats.textContent = parts.join(' · ');
  };

  const renderNode = (node: BattleOrbatNode, reason?: BattleOrbatUnattached['reason']): HTMLElement => {
    const wrapper = el(doc, 'div', 'bob-node');
    const row = el(doc, 'div', 'bob-row');
    if (state.selectedUnitId === node.unitId) row.classList.add('selected');
    if (reason) row.classList.add('unattached');
    row.setAttribute('role', 'treeitem');
    row.tabIndex = 0;
    row.dataset.unitId = node.unitId;

    if (node.children.length > 0) {
      const collapsed = state.collapsedUnitIds.includes(node.unitId);
      const toggle = button(doc, collapsed ? '▸' : '▾', 'bob-toggle');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const next = state.collapsedUnitIds.includes(node.unitId)
          ? state.collapsedUnitIds.filter((id) => id !== node.unitId)
          : [...state.collapsedUnitIds, node.unitId];
        state.collapsedUnitIds = next;
        renderTree();
      });
      row.append(toggle);
    } else {
      row.append(el(doc, 'span', 'bob-toggle-spacer'));
    }

    const name = el(doc, 'span', 'bob-name', unitNameText(node.unit));
    if (node.unit.unitName.state === 'unknown') {
      name.classList.add('unknown');
      name.title = node.unit.unitName.reason;
    }
    row.append(name);

    if (node.unit.echelon.state === 'known') row.append(el(doc, 'span', 'bob-chip', node.unit.echelon.value));
    if (node.unit.branch.state === 'known') row.append(el(doc, 'span', 'bob-chip', node.unit.branch.value));
    row.append(el(doc, 'span', 'bob-chip', personnelText(node.unit)));

    const warning = completenessWarning(node.unit);
    if (warning) row.append(el(doc, 'span', 'bob-warn', `⚠ ${warning}`));
    if (reason) row.append(el(doc, 'span', 'bob-reason-badge', unattachedReasonLabel(reason)));

    const select = (): void => {
      state.selectedUnitId = node.unitId;
      state.mode = 'detail';
      renderTree();
      renderDetail();
      options.onSelectUnit?.(node.unitId);
    };
    row.addEventListener('click', select);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });

    wrapper.append(row);
    const collapsed = state.collapsedUnitIds.includes(node.unitId);
    if (!collapsed && node.children.length > 0) {
      const children = el(doc, 'div', 'bob-children');
      for (const child of node.children) children.append(renderNode(child));
      wrapper.append(children);
    }
    return wrapper;
  };

  const renderTree = (): void => {
    treeEl.replaceChildren();
    for (const node of orbat.roots) treeEl.append(renderNode(node));
    if (orbat.unattached.length > 0) {
      treeEl.append(el(doc, 'div', 'bob-group-title', `未定隶属 / 无法挂接（${orbat.unattached.length}）`));
      for (const item of orbat.unattached) treeEl.append(renderNode(item.node, item.reason));
    }
  };

  const renderEvidence = (
    container: HTMLElement,
    unit: BattleUnit,
    sources: BattleSource[],
  ): void => {
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const fields: [string, BattleField<unknown>][] = [
      ['名称', unit.unitName],
      ['上级', unit.parentUnitId],
      ['层级', unit.echelon],
      ['兵种', unit.branch],
      ['阵营', unit.side],
      ['人数', unit.personnel.count],
      ['下属完整性', unit.childrenCompleteness],
      ['行政归属', unit.provinceId],
      ['部队状态', unit.status],
    ];
    const details = el(doc, 'details', 'bob-evidence');
    details.append(el(doc, 'summary', undefined, `字段来源（${fields.length} 项）`));
    for (const [label, field] of fields) {
      const row = el(doc, 'div', 'bob-evidence-row');
      const stateText = field.state === 'known' ? '已知' : `未知：${field.reason}`;
      row.append(el(doc, 'div', 'bob-evidence-label', `${label} · ${stateText}`));
      if (field.evidence.length === 0) {
        row.append(el(doc, 'div', 'bob-evidence-body', '没有来源记录'));
      }
      for (const evidence of field.evidence) {
        const source = sourceById.get(evidence.sourceId);
        const sourceText = source
          ? `${source.title}（${sourceKindLabel(source.kind)}）`
          : `来源 ${evidence.sourceId}（未在本战区 sources 中找到）`;
        const body = el(doc, 'div', 'bob-evidence-body');
        body.textContent = `${sourceText} · ${evidenceLabel(evidence.basis)} · “${evidence.excerpt}”${evidence.note ? ` · ${evidence.note}` : ''}`;
        if (source?.locator && source.locator.trim() && options.onFocusSource) {
          const locator = source.locator.trim();
          const jump = button(doc, '定位原文', 'bob-btn bob-btn-ghost');
          jump.style.marginLeft = '6px';
          jump.addEventListener('click', () => {
            options.onFocusSource?.({
              sourceId: locator,
              ...(evidence.excerpt ? { highlightQuote: evidence.excerpt } : {}),
            });
          });
          body.append(jump);
        }
        row.append(body);
      }
      details.append(row);
    }
    container.append(details);
  };

  const renderUnitDetail = (unit: BattleUnit): void => {
    detailEl.replaceChildren();
    const head = el(doc, 'div', 'bob-detail-head');
    const titleWrap = el(doc, 'div');
    titleWrap.append(el(doc, 'div', 'bob-detail-title', unitNameText(unit)));
    titleWrap.append(el(doc, 'div', 'bob-detail-sub',
      `${unit.id} · ${assertionLabel(unit.assertion)} · ${scopeLabel(unit.personnel.scope)}`));
    head.append(titleWrap);
    detailEl.append(head);

    if (unitIsCycle(unit.id)) {
      detailEl.append(el(doc, 'div', 'bob-summary', '编制环引用：该单位与上级无法构成有效树，兵力汇总不作为可用结果；请先修正上级关系。'));
    } else {
      const summary = summarizeBattlePersonnel(workspace.garrisons, [unit.id]);
      const totalText = summary.total.state === 'known'
        ? `总人数 ${summary.total.value.toLocaleString('zh-CN')}`
        : `总数未知（已知至少 ${summary.knownMinimum.toLocaleString('zh-CN')}）`;
      const parts = [totalText, `计入 ${summary.countedUnitIds.length}`, `未解 ${summary.unresolvedUnitIds.length}`];
      if (summary.excludedUnitIds.length > 0) parts.push(`上级口径覆盖 ${summary.excludedUnitIds.length}`);
      detailEl.append(el(doc, 'div', 'bob-summary', parts.join(' · ')));
    }

    const form = el(doc, 'form', 'bob-form');
    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.value = unit.unitName.state === 'known' ? unit.unitName.value : '';
    nameInput.placeholder = '单位名称';
    const nameField = createFieldControl(doc, '名称', nameInput, {
      unknown: unit.unitName.state === 'unknown',
      reason: unit.unitName.state === 'unknown' ? unit.unitName.reason : '',
      requiredWhenKnown: true,
    });

    const parentSelect = doc.createElement('select');
    const mergedUnits = effectiveUnits();
    fillParentSelect(
      doc,
      parentSelect,
      mergedUnits,
      unit.parentUnitId,
      new Set([unit.id, ...collectBattleDescendantIds(mergedUnits, unit.id)]),
    );
    const parentField = createFieldControl(doc, '上级', parentSelect, {
      unknown: unit.parentUnitId.state === 'unknown',
      reason: unit.parentUnitId.state === 'unknown' ? unit.parentUnitId.reason : '',
      requiredWhenKnown: true,
    });

    const echelonInput = doc.createElement('input');
    echelonInput.type = 'text';
    echelonInput.value = unit.echelon.state === 'known' ? unit.echelon.value : '';
    echelonInput.placeholder = '例如：师、团、旅';
    const echelonField = createFieldControl(doc, '层级', echelonInput, {
      unknown: unit.echelon.state === 'unknown',
      reason: unit.echelon.state === 'unknown' ? unit.echelon.reason : '',
      requiredWhenKnown: true,
    });

    const branchInput = doc.createElement('input');
    branchInput.type = 'text';
    branchInput.value = unit.branch.state === 'known' ? unit.branch.value : '';
    branchInput.placeholder = '例如：步兵、骑兵';
    const branchField = createFieldControl(doc, '兵种', branchInput, {
      unknown: unit.branch.state === 'unknown',
      reason: unit.branch.state === 'unknown' ? unit.branch.reason : '',
      requiredWhenKnown: true,
    });

    const sideInput = doc.createElement('input');
    sideInput.type = 'text';
    sideInput.value = unit.side.state === 'known' ? unit.side.value : '';
    sideInput.placeholder = '阵营或政权';
    const sideField = createFieldControl(doc, '阵营', sideInput, {
      unknown: unit.side.state === 'unknown',
      reason: unit.side.state === 'unknown' ? unit.side.reason : '',
      requiredWhenKnown: true,
    });

    const scopeSelect = doc.createElement('select');
    scopeSelect.required = true;
    scopeSelect.append(
      option(doc, 'own', '本部人数（不含下属）'),
      option(doc, 'inclusive', '含下属总人数'),
      option(doc, 'legacy-unspecified', '旧数据口径未说明'),
    );
    scopeSelect.value = unit.personnel.scope;
    const scopeField = createPlainField(
      doc,
      '人数口径',
      scopeSelect,
      'own 与下属分别累计；inclusive 不再累计下属；legacy 不并入跨层汇总。',
    );

    const countInput = doc.createElement('input');
    countInput.type = 'number';
    countInput.min = '0';
    countInput.step = '1';
    countInput.value = unit.personnel.count.state === 'known' ? String(unit.personnel.count.value) : '';
    countInput.placeholder = '非负整数';
    const countField = createFieldControl(doc, '人数', countInput, {
      unknown: unit.personnel.count.state === 'unknown',
      reason: unit.personnel.count.state === 'unknown' ? unit.personnel.count.reason : '',
      requiredWhenKnown: true,
    });

    const completenessField = createCompletenessField(doc, unit.childrenCompleteness);

    const assertionSelect = doc.createElement('select');
    assertionSelect.append(
      option(doc, 'plan', '方案（拟议）'),
      option(doc, 'reported', '记录（既有状态）'),
    );
    assertionSelect.value = unit.assertion;
    const assertionField = createPlainField(doc, '资料属性', assertionSelect);

    form.append(
      nameField.row,
      parentField.row,
      echelonField.row,
      branchField.row,
      sideField.row,
      scopeField,
      countField.row,
      completenessField.row,
      assertionField,
    );

    const readBadge = createBadgeFields(doc, form, countInput, echelonField, unit.customBadge);
    const actions = el(doc, 'div', 'bob-actions');
    const saveButton = button(doc, '加入待提交');
    const deleteButton = button(doc, '删除单位', 'bob-btn bob-btn-danger');
    actions.append(saveButton, deleteButton);
    form.append(actions);

    const normalizeBadge = (b?: CustomBadgeConfig) => ({
      culture: b?.culture ?? 'universal',
      requirementTag: b?.requirementTag?.trim() || undefined,
      customGlyph: b?.customGlyph?.trim() || undefined,
      customIconDataUrl: b?.customIconDataUrl?.trim() || undefined,
      textColor: (b?.textColor?.trim() || '#f8fafc').toLowerCase(),
    });
    const validateDrafts = (drafts: {
      name: TextDraft; parent: ParentDraft; echelon: TextDraft;
      branch: TextDraft; side: TextDraft; count: CountDraft; completeness: CompletenessDraft;
    }): string | null => {
      for (const [label, d] of [
        ['名称', drafts.name],
        ['层级', drafts.echelon],
        ['兵种', drafts.branch],
        ['阵营', drafts.side],
      ] as const) {
        if (d.unknown ? d.reason === '' : d.value === '') {
          return d.unknown ? `请填写「${label}」的未知原因` : `请填写有效「${label}」`;
        }
      }
      if (drafts.parent.unknown && drafts.parent.reason === '') return '请填写「上级」的未知原因';
      if (drafts.count.unknown && drafts.count.reason === '') return '请填写「人数」的未知原因';
      if (drafts.completeness.unknown && drafts.completeness.reason === '') return '请填写「下属完整性」的未知原因';
      return null;
    };

    saveButton.addEventListener('click', () => {
      if (!form.reportValidity()) return;
      const drafts = {
        name: readTextDraft(nameField.control, nameField.unknown, nameField.reason),
        parent: readParentDraft(parentField.control as HTMLSelectElement, parentField.unknown, parentField.reason),
        echelon: readTextDraft(echelonField.control, echelonField.unknown, echelonField.reason),
        branch: readTextDraft(branchField.control, branchField.unknown, branchField.reason),
        side: readTextDraft(sideField.control, sideField.unknown, sideField.reason),
        count: readCountDraft(countField.control as HTMLInputElement, countField.unknown, countField.reason),
        completeness: readCompletenessDraft(completenessField),
        assertion: assertionSelect.value as BattleAssertion,
      };
      if (!drafts.parent.unknown && drafts.parent.value === '') {
        setNotice('请选择上级，或勾选“未知”。');
        return;
      }
      const draftErr = validateDrafts(drafts);
      if (draftErr) {
        setNotice(draftErr);
        return;
      }
      const nextScope = scopeSelect.value as BattleUnit['personnel']['scope'];
      const changes = describeChanges(unit, drafts);
      const badge = readBadge();
      if (JSON.stringify(normalizeBadge(badge)) !== JSON.stringify(normalizeBadge(unit.customBadge))) {
        changes.push('兵牌文化/需求');
      }
      if (unit.personnel.scope !== nextScope) {
        changes.push(`人数口径=${scopeLabel(nextScope)}`);
      }
      if (changes.length === 0) {
        setNotice('没有改动，未加入待提交。');
        return;
      }

      const source: BattleSource = {
        id: options.allocateSourceId(),
        kind: 'manual',
        title: '编制手工编辑',
        text: `单位 ${unit.id}：${changes.join('；')}`,
        locator: '编制编辑器',
      };
      const evidence = sourceEvidence(source, '用户在编制编辑器中提交的修改');
      const next: BattleUnit = {
        ...unit,
        customBadge: badge,
        assertion: drafts.assertion,
        unitName: drafts.name.unknown
          ? withUnknown(unit.unitName, drafts.name.reason, evidence)
          : withKnown(unit.unitName, drafts.name.value, evidence),
        parentUnitId: drafts.parent.unknown
          ? withUnknown(unit.parentUnitId, drafts.parent.reason, evidence)
          : withKnown(unit.parentUnitId, drafts.parent.value, evidence),
        echelon: drafts.echelon.unknown
          ? withUnknown(unit.echelon, drafts.echelon.reason, evidence)
          : withKnown(unit.echelon, drafts.echelon.value, evidence),
        branch: drafts.branch.unknown
          ? withUnknown(unit.branch, drafts.branch.reason, evidence)
          : withKnown(unit.branch, drafts.branch.value, evidence),
        side: drafts.side.unknown
          ? withUnknown(unit.side, drafts.side.reason, evidence)
          : withKnown(unit.side, drafts.side.value, evidence),
        childrenCompleteness: drafts.completeness.unknown
          ? withUnknown(unit.childrenCompleteness, drafts.completeness.reason, evidence)
          : withKnown(unit.childrenCompleteness, drafts.completeness.value as 'complete' | 'partial', evidence),
        personnel: {
          scope: nextScope,
          count: drafts.count.unknown
            ? withUnknown(unit.personnel.count, drafts.count.reason, evidence)
            : withKnown(unit.personnel.count, drafts.count.value, evidence),
        },
      };
      stageEdit({ kind: 'upsert-source', source });
      stageEdit({ kind: 'upsert-unit', unit: next });
      setNotice(`已加入待提交：${unit.id}`);
      renderStaged();
    });

    deleteButton.addEventListener('click', () => {
      const children = workspace.garrisons.filter(
        (item) => item.parentUnitId.state === 'known' && item.parentUnitId.value === unit.id,
      );
      const reserveRefs = workspace.battle.deployments.filter(
        (item) => item.unitId !== unit.id
          && item.reserveForUnitId.state === 'known'
          && item.reserveForUnitId.value === unit.id,
      );
      if (children.length > 0 || reserveRefs.length > 0) {
        const parts: string[] = [];
        if (children.length > 0) parts.push(`下级 ${children.map((item) => item.id).join('、')}`);
        if (reserveRefs.length > 0) parts.push(`被部署引用 ${reserveRefs.map((item) => item.unitId).join('、')}`);
        setNotice(`不能删除：请先处理${parts.join('；')}。`);
        return;
      }
      const view = doc.defaultView!;
      if (!view.confirm(`确认删除单位 ${unit.id}（${unitNameText(unit)}）？`)) return;
      stageEdit({ kind: 'remove-unit', unitId: unit.id });
      setNotice(`已加入待提交：删除 ${unit.id}`);
      renderStaged();
    });

    detailEl.append(form);
    renderEvidence(detailEl, unit, workspace.battle.sources);
  };

  const renderCreateForm = (): void => {
    detailEl.replaceChildren();
    const head = el(doc, 'div', 'bob-detail-head');
    const titleWrap = el(doc, 'div');
    titleWrap.append(el(doc, 'div', 'bob-detail-title', '新建单位'));
    titleWrap.append(el(doc, 'div', 'bob-detail-sub', '提交前不会出现在树中；层级关系可在批量录入中一次建立。'));
    head.append(titleWrap);
    detailEl.append(head);

    const form = el(doc, 'form', 'bob-form');
    const nameInput = doc.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '单位名称';
    const nameField = createFieldControl(doc, '名称', nameInput, {
      unknown: false,
      reason: '',
      requiredWhenKnown: true,
    });

    const parentSelect = doc.createElement('select');
    fillParentSelect(doc, parentSelect, workspace.garrisons, {
      state: 'unknown',
      reason: '新建单位未填写上级',
      evidence: [],
    }, new Set());
    const parentField = createFieldControl(doc, '上级', parentSelect, {
      unknown: true,
      reason: '新建单位未填写上级',
      requiredWhenKnown: true,
    });

    const echelonInput = doc.createElement('input');
    echelonInput.type = 'text';
    echelonInput.placeholder = '例如：师、团、旅';
    const echelonField = createFieldControl(doc, '层级', echelonInput, {
      unknown: true,
      reason: '新建单位未填写层级',
      requiredWhenKnown: true,
    });

    const branchInput = doc.createElement('input');
    branchInput.type = 'text';
    branchInput.placeholder = '例如：步兵、骑兵';
    const branchField = createFieldControl(doc, '兵种', branchInput, {
      unknown: true,
      reason: '新建单位未填写兵种',
      requiredWhenKnown: true,
    });

    const sideInput = doc.createElement('input');
    sideInput.type = 'text';
    sideInput.placeholder = '阵营或政权';
    const sideField = createFieldControl(doc, '阵营', sideInput, {
      unknown: true,
      reason: '新建单位未填写阵营',
      requiredWhenKnown: true,
    });

    const scopeSelect = doc.createElement('select');
    scopeSelect.required = true;
    scopeSelect.append(
      option(doc, '', '请选择人数口径'),
      option(doc, 'own', '本部人数（不含下属）'),
      option(doc, 'inclusive', '含下属总人数'),
      option(doc, 'legacy-unspecified', '旧数据口径未说明'),
    );
    const scopeField = createPlainField(doc, '人数口径', scopeSelect);

    const countInput = doc.createElement('input');
    countInput.type = 'number';
    countInput.min = '0';
    countInput.step = '1';
    countInput.placeholder = '非负整数';
    const countField = createFieldControl(doc, '人数', countInput, {
      unknown: true,
      reason: '新建单位未填写人数',
      requiredWhenKnown: true,
    });

    const completeness = createCompletenessField(doc, {
      state: 'unknown',
      reason: '新建单位未填写下属完整性',
      evidence: [],
    });

    const assertionSelect = doc.createElement('select');
    assertionSelect.append(
      option(doc, 'plan', '方案（拟议）'),
      option(doc, 'reported', '记录（既有状态）'),
    );
    assertionSelect.value = 'plan';
    const assertionField = createPlainField(doc, '资料属性', assertionSelect);

    const colorInput = doc.createElement('input');
    colorInput.type = 'color';
    colorInput.value = '#3b82f6';
    const colorField = createPlainField(doc, '显示颜色', colorInput);

    form.append(
      nameField.row,
      parentField.row,
      echelonField.row,
      branchField.row,
      sideField.row,
      scopeField,
      countField.row,
      completeness.row,
      assertionField,
      colorField,
    );

    const actions = el(doc, 'div', 'bob-actions');
    const saveButton = button(doc, '加入待提交');
    const readBadge = createBadgeFields(doc, form, countInput, echelonField);
    const cancelButton = button(doc, '取消', 'bob-btn bob-btn-ghost');
    actions.append(saveButton, cancelButton);
    form.append(actions);

    saveButton.addEventListener('click', () => {
      if (!form.reportValidity()) return;
      const parent = readParentDraft(parentField.control as HTMLSelectElement, parentField.unknown, parentField.reason);
      if (!parent.unknown && parent.value === '') {
        setNotice('请选择上级，或勾选“未知”。');
        return;
      }
      if (scopeSelect.value === '') {
        setNotice('请选择人数口径。');
        return;
      }
      const unitId = options.allocateUnitId();
      const duplicated = workspace.garrisons.some((item) => item.id === unitId)
        || state.staged.some((item) => item.kind === 'upsert-unit' && item.unit.id === unitId);
      if (duplicated) {
        setNotice(`单位 ID 重复：${unitId}`);
        return;
      }

      const name = readTextDraft(nameField.control, nameField.unknown, nameField.reason);
      const echelon = readTextDraft(echelonField.control, echelonField.unknown, echelonField.reason);
      const branch = readTextDraft(branchField.control, branchField.unknown, branchField.reason);
      const side = readTextDraft(sideField.control, sideField.unknown, sideField.reason);
      const count = readCountDraft(countField.control as HTMLInputElement, countField.unknown, countField.reason);
      const completenessDraft = readCompletenessDraft(completeness);
      const assertion = assertionSelect.value as BattleAssertion;

      for (const [label, d] of [
        ['名称', name],
        ['层级', echelon],
        ['兵种', branch],
        ['阵营', side],
      ] as const) {
        if (d.unknown ? d.reason === '' : d.value === '') {
          setNotice(d.unknown ? `请填写「${label}」的未知原因` : `请填写有效「${label}」`);
          return;
        }
      }
      if (parent.unknown && parent.reason === '') { setNotice('请填写「上级」的未知原因'); return; }
      if (count.unknown && count.reason === '') { setNotice('请填写「人数」的未知原因'); return; }
      if (completenessDraft.unknown && completenessDraft.reason === '') { setNotice('请填写「下属完整性」的未知原因'); return; }

      const source: BattleSource = {
        id: options.allocateSourceId(),
        kind: 'manual',
        title: '新建编制单位',
        text: `新建单位 ${name.unknown ? '名称未知' : name.value}；上级=${parent.unknown ? '未知' : parent.value === null ? '无上级' : parent.value}；人数口径=${scopeLabel(scopeSelect.value as BattleUnit['personnel']['scope'])}；人数=${count.unknown ? '未知' : count.value}；下属完整性=${completenessDraft.unknown ? '未知' : completenessDraft.value}；部署未知。`,
        locator: '编制编辑器',
      };
      const evidence = sourceEvidence(source, '用户在编制编辑器中新建单位');
      const unit: BattleUnit = {
        id: unitId,
        customBadge: readBadge(),
        color: colorInput.value,
        assertion,
        unitName: name.unknown ? unknownField(name.reason, [evidence]) : knownField(name.value, [evidence]),
        provinceId: unknownField('新建单位未填写行政归属', [evidence]),
        status: unknownField('新建单位未填写部队状态', [evidence]),
        parentUnitId: parent.unknown
          ? unknownField(parent.reason, [evidence])
          : knownField(parent.value, [evidence]),
        echelon: echelon.unknown ? unknownField(echelon.reason, [evidence]) : knownField(echelon.value, [evidence]),
        branch: branch.unknown ? unknownField(branch.reason, [evidence]) : knownField(branch.value, [evidence]),
        side: side.unknown ? unknownField(side.reason, [evidence]) : knownField(side.value, [evidence]),
        childrenCompleteness: completenessDraft.unknown
          ? unknownField(completenessDraft.reason, [evidence])
          : knownField(completenessDraft.value as 'complete' | 'partial', [evidence]),
        personnel: {
          scope: scopeSelect.value as BattleUnit['personnel']['scope'],
          count: count.unknown ? unknownField(count.reason, [evidence]) : knownField(count.value, [evidence]),
        },
      };
      stageEdit({ kind: 'upsert-source', source });
      stageEdit({ kind: 'upsert-unit', unit });
      stageEdit({
        kind: 'set-deployment',
        deployment: createUnplacedBattleDeployment(
          unitId,
          assertion,
          [evidence],
          '新建单位尚未部署',
        ),
      });
      state.mode = 'detail';
      setNotice(`已加入待提交：新建 ${unitId}（提交后出现在树中）`);
      refresh();
    });

    cancelButton.addEventListener('click', () => {
      state.mode = 'detail';
      renderDetail();
    });

    detailEl.append(form);
  };

  const renderBatchForm = (): void => {
    detailEl.replaceChildren();
    const head = el(doc, 'div', 'bob-detail-head');
    const titleWrap = el(doc, 'div');
    titleWrap.append(el(doc, 'div', 'bob-detail-title', '批量录入'));
    titleWrap.append(el(doc, 'div', 'bob-detail-sub', '外部文本在导入边界一次解析；有错误的批次不会加入待提交。'));
    head.append(titleWrap);
    detailEl.append(head);

    const help = el(doc, 'div', 'bob-help',
      '每行 9 列，用 | 或制表符分隔：\n临时键 | 名称 | 上级 | 层级 | 兵种 | 阵营 | 人数口径 | 人数 | 下属完整性\n'
      + '上级填 - 表示无上级，? 表示上级未知，也可填现有单位 ID 或本批临时键。\n'
      + '名称/层级/兵种/阵营填 ? 表示未知；人数填 ? 表示未知；人数口径必须为 own / inclusive / legacy-unspecified；下属完整性为 complete / partial / unknown / ?。');
    detailEl.append(help);

    const form = el(doc, 'form', 'bob-form');
    const textarea = doc.createElement('textarea');
    textarea.className = 'bob-textarea';
    textarea.value = state.batchText;
    textarea.placeholder = '1师 | 第一师 | - | 师 | 步兵 | 蓝方 | own | 200 | complete';
    textarea.addEventListener('input', () => {
      state.batchText = textarea.value;
    });

    const assertionSelect = doc.createElement('select');
    assertionSelect.append(
      option(doc, 'plan', '方案（拟议）'),
      option(doc, 'reported', '记录（既有状态）'),
    );
    assertionSelect.value = state.batchAssertion;
    assertionSelect.addEventListener('change', () => {
      state.batchAssertion = assertionSelect.value as BattleAssertion;
    });
    const assertionField = createPlainField(doc, '资料属性', assertionSelect);

    const actions = el(doc, 'div', 'bob-actions');
    const parseButton = button(doc, '解析并加入待提交');
    const cancelButton = button(doc, '关闭', 'bob-btn bob-btn-ghost');
    actions.append(parseButton, cancelButton);

    form.append(textarea, assertionField, actions);

    if (state.batchIssues.length > 0) {
      const list = el(doc, 'ul', 'bob-issues');
      for (const issue of state.batchIssues) {
        list.append(el(doc, 'li', undefined, issue.line > 0 ? `第 ${issue.line} 行：${issue.message}` : issue.message));
      }
      form.append(list);
    }

    parseButton.addEventListener('click', () => {
      const result = parseBattleOrbatBatch(textarea.value, {
        units: workspace.garrisons,
        assertion: state.batchAssertion,
        sourceId: options.allocateSourceId(),
        allocateUnitId: options.allocateUnitId,
      });
      if (result.issues.length > 0) {
        state.batchIssues = result.issues;
        setNotice('批量录入有错误，未加入待提交。');
        renderDetail();
        return;
      }
      state.batchIssues = [];
      for (const edit of result.edits) stageEdit(edit);
      setNotice(`已加入待提交：${Object.keys(result.unitIdsByKey).length} 个新单位`);
      renderStaged();
      renderDetail();
    });

    cancelButton.addEventListener('click', () => {
      state.mode = 'detail';
      renderDetail();
    });

    detailEl.append(form);
  };

  const renderDetail = (): void => {
    if (state.mode === 'create') {
      renderCreateForm();
      return;
    }
    if (state.mode === 'batch') {
      renderBatchForm();
      return;
    }
    const unit = state.selectedUnitId ? currentUnit(state.selectedUnitId) : null;
    if (unit) {
      renderUnitDetail(unit);
      return;
    }
    detailEl.replaceChildren();
    detailEl.append(el(doc, 'div', 'bob-summary',
      '选择左侧单位查看编制、人数口径与字段来源；或使用“新建单位”“批量录入”。'));
  };

  const editDescription = (edit: BattleEdit): string => {
    if (edit.kind === 'upsert-source') return `来源：${edit.source.title}`;
    if (edit.kind === 'upsert-unit') return `单位：${unitNameText(edit.unit)}（${edit.unit.id}）`;
    if (edit.kind === 'set-deployment') return `部署：${edit.deployment.unitId}`;
    if (edit.kind === 'remove-unit') return `删除单位：${edit.unitId}`;
    if (edit.kind === 'upsert-battlefield') return `战场：${edit.battlefield.id}`;
    return `删除战场：${edit.battlefieldId}`;
  };

  const renderStaged = (): void => {
    stagedEl.replaceChildren();
    const businessCount = state.staged.filter((edit) => edit.kind !== 'upsert-source').length;
    const head = el(doc, 'div', 'bob-staged-head');
    head.append(el(doc, 'div', 'bob-staged-title', `待提交（${businessCount} 项业务编辑）`));
    stagedEl.append(head);
    if (state.staged.length === 0) {
      stagedEl.append(el(doc, 'div', 'bob-help', '没有待提交编辑。'));
      return;
    }
    const list = el(doc, 'ul', 'bob-staged-list');
    for (const edit of state.staged) list.append(el(doc, 'li', undefined, editDescription(edit)));
    stagedEl.append(list);

    const actions = el(doc, 'div', 'bob-actions');
    const clearButton = button(doc, '清空', 'bob-btn bob-btn-ghost');
    const submitButton = button(doc, '提交批次');
    submitButton.disabled = businessCount === 0;
    actions.append(submitButton, clearButton);
    stagedEl.append(actions);

    clearButton.addEventListener('click', () => {
      state.staged = [];
      setNotice('已清空待提交编辑。');
      renderStaged();
    });
    submitButton.addEventListener('click', () => {
      const batch: BattleEditBatch = {
        label: `编制编辑（${businessCount} 项）`,
        origin: 'manual',
        candidateItemIds: [],
        edits: state.staged,
      };
      try {
        options.applyBatch(batch);
        state.staged = [];
        setNotice(`已提交 ${businessCount} 项编制编辑。`);
        refresh();
      } catch (error) {
        setNotice(`提交失败：${error instanceof Error ? error.message : String(error)}`);
        renderNotice();
      }
    });
  };

  const reconcileStaged = (): void => {
    if (state.staged.length === 0) return;
    const committedIds = new Set(workspace.garrisons.map((u) => u.id));
    const stagedDeployedIds = new Set(
      state.staged
        .filter((e): e is Extract<BattleEdit, { kind: 'set-deployment' }> => e.kind === 'set-deployment')
        .map((e) => e.deployment.unitId),
    );
    const stagedCreatedIds = new Set(
      state.staged
        .filter((e): e is Extract<BattleEdit, { kind: 'upsert-unit' }> =>
          e.kind === 'upsert-unit' && !committedIds.has(e.unit.id) && stagedDeployedIds.has(e.unit.id))
        .map((e) => e.unit.id),
    );
    const nonSource = state.staged.filter((edit) => {
      if (edit.kind === 'upsert-source') return false;
      if (edit.kind === 'remove-unit') return committedIds.has(edit.unitId);
      if (edit.kind === 'upsert-unit') return committedIds.has(edit.unit.id) || stagedCreatedIds.has(edit.unit.id);
      if (edit.kind === 'set-deployment') return committedIds.has(edit.deployment.unitId) || stagedCreatedIds.has(edit.deployment.unitId);
      return true;
    });
    const usedSources = new Set<string>();
    const collectSources = (val: unknown): void => {
      if (Array.isArray(val)) val.forEach(collectSources);
      else if (val && typeof val === 'object') {
        const rec = val as Record<string, unknown>;
        if (typeof rec.sourceId === 'string') usedSources.add(rec.sourceId);
        Object.values(rec).forEach(collectSources);
      }
    };
    nonSource.forEach(collectSources);
    state.staged = [
      ...state.staged.filter((e) => e.kind === 'upsert-source' && usedSources.has(e.source.id)),
      ...nonSource,
    ];
  };

  const refresh = (): void => {
    workspace = options.getWorkspace();
    reconcileStaged();
    orbat = buildBattleOrbat(workspace.garrisons);
    const knownIds = new Set(flattenBattleOrbat(orbat).map((node) => node.unitId));
    if (state.selectedUnitId && !knownIds.has(state.selectedUnitId)) state.selectedUnitId = null;
    renderStats();
    renderTree();
    renderDetail();
    renderStaged();
    renderNotice();
  };

  createButton.addEventListener('click', () => {
    state.mode = 'create';
    state.selectedUnitId = null;
    renderTree();
    renderDetail();
  });
  batchButton.addEventListener('click', () => {
    state.mode = 'batch';
    state.selectedUnitId = null;
    state.batchIssues = [];
    renderTree();
    renderDetail();
  });

  refresh();

  return {
    refresh,
    destroy: () => {
      root.remove();
    },
    selectUnit: (unitId) => {
      state.selectedUnitId = unitId;
      state.mode = 'detail';
      renderTree();
      renderDetail();
    },
  };
}
