import type {
  BattleCandidateBatch, BattleEdit, BattleEditBatch, BattleField, BattleWorkspace,
} from './battle-contract';
import { previewBattleEdits } from './battle-actions';
import { candidateEvidence, createBattleAiTemplate, parseBattleCandidates, selectBattleCandidates } from './battle-import';

export interface BattleReviewOptions {
  getWorkspace: () => BattleWorkspace;
  applyBatch: (batch: BattleEditBatch) => unknown;
  onFocusSource?: (payload: { sourceId: string; highlightQuote?: string }) => void;
}

function editTitle(edit: BattleEdit): string {
  switch (edit.kind) {
    case 'upsert-unit': return `部队 ${edit.unit.id}`;
    case 'remove-unit': return `删除部队 ${edit.unitId}`;
    case 'set-deployment': return `部署 ${edit.deployment.unitId}`;
    case 'upsert-battlefield': return `战场 ${edit.battlefield.id}`;
    case 'remove-battlefield': return `删除战场 ${edit.battlefieldId}`;
    case 'upsert-source': return `来源 ${edit.source.id}`;
  }
}

function objectBefore(workspace: BattleWorkspace, edit: BattleEdit): unknown {
  switch (edit.kind) {
    case 'upsert-unit': return workspace.garrisons.find(unit => unit.id === edit.unit.id);
    case 'remove-unit': return workspace.garrisons.find(unit => unit.id === edit.unitId);
    case 'set-deployment': return workspace.battle.deployments.find(deployment => deployment.unitId === edit.deployment.unitId);
    case 'upsert-battlefield': return workspace.battle.battlefields.find(field => field.id === edit.battlefield.id);
    case 'remove-battlefield': return workspace.battle.battlefields.find(field => field.id === edit.battlefieldId);
    case 'upsert-source': return workspace.battle.sources.find(source => source.id === edit.source.id);
  }
}

interface FieldEntry {
  path: string;
  field: BattleField<unknown>;
}

/** 把候选对象拆成字段级条目；路径用于和当前对象逐字段对照。 */
function collectFieldEntries(value: unknown, path: string, entries: FieldEntry[]): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectFieldEntries(child, `${path}[${index}]`, entries));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if ((record.state === 'known' || record.state === 'unknown') && Array.isArray(record.evidence)) {
    entries.push({ path, field: record as unknown as BattleField<unknown> });
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'evidence') continue;
    collectFieldEntries(child, path === '' ? key : `${path}.${key}`, entries);
  }
}

function valueAtPath(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function displayFieldValue(value: unknown): string {
  if (value === undefined) return '无';
  if (value !== null && typeof value === 'object' && 'state' in value) {
    const field = value as BattleField<unknown>;
    return field.state === 'known' ? JSON.stringify(field.value) : `未知（${field.reason}）`;
  }
  return JSON.stringify(value);
}

function editSubject(edit: BattleEdit): unknown {
  switch (edit.kind) {
    case 'upsert-unit': return edit.unit;
    case 'set-deployment': return edit.deployment;
    case 'upsert-battlefield': return edit.battlefield;
    case 'upsert-source': return edit.source;
    case 'remove-unit':
    case 'remove-battlefield': return null;
  }
}

/** 所有业务写入经 applyBatch；抽屉只保存待审阅候选和界面选择。 */
export function initBattleReview(root: HTMLElement, options: BattleReviewOptions): { refresh: () => void } {
  const doc = root.ownerDocument;
  const entry = doc.createElement('button');
  entry.id = 'battle-ai-open';
  entry.type = 'button';
  entry.textContent = 'AI 草案';
  entry.style.cssText = 'position:fixed;top:76px;left:382px;z-index:110;padding:9px 18px;border-radius:7px;background:#5b21b6;color:white;border:1px solid #a78bfa;cursor:pointer';
  const panel = doc.createElement('section');
  panel.id = 'battle-ai-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'AI 草案审阅');
  panel.style.cssText = 'position:fixed;top:115px;right:12px;bottom:16px;width:min(650px,90vw);z-index:125;overflow:auto;padding:14px;background:#0f172af8;color:#e2e8f0;border:1px solid #a78bfa;border-radius:10px;font:13px/1.6 "Microsoft YaHei",sans-serif';
  panel.innerHTML = `
    <header style="display:flex;align-items:center;gap:12px"><strong>AI 草案审阅</strong><button id="battle-ai-close" type="button">收起</button></header>
    <p>先导出当前战区任务模板，在现有 AI 会话补充原文和修改要求，再将返回的候选 JSON 导入。此处不调用模型。</p>
    <p id="battle-ai-map"></p>
    <button id="battle-ai-template" type="button">导出当前战区 AI 任务模板</button>
    <label style="display:block;margin:10px 0">导入候选文件 <input id="battle-ai-file" type="file" accept=".json,application/json"></label>
    <label for="battle-ai-json">候选 JSON</label>
    <textarea id="battle-ai-json" rows="8" spellcheck="false" style="box-sizing:border-box;width:100%;background:#020617;color:#e2e8f0;border:1px solid #64748b;border-radius:5px"></textarea>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
      <button id="battle-ai-parse" type="button">解析候选</button>
      <button id="battle-ai-preview" type="button" disabled>预览选中项</button>
      <button id="battle-ai-apply" type="button" disabled>应用已预览项</button>
      <button id="battle-ai-cancel" type="button">取消草案</button>
    </div>
    <div id="battle-ai-status" role="status" style="white-space:pre-wrap;color:#c4b5fd"></div>
    <div id="battle-ai-items"></div>
    <div id="battle-ai-result"></div>`;
  root.append(entry, panel);
  const element = <T extends HTMLElement>(id: string): T => panel.querySelector<T>(`#${id}`)!;
  const input = element<HTMLTextAreaElement>('battle-ai-json');
  const file = element<HTMLInputElement>('battle-ai-file');
  const previewButton = element<HTMLButtonElement>('battle-ai-preview');
  const applyButton = element<HTMLButtonElement>('battle-ai-apply');
  const status = element('battle-ai-status');
  const list = element('battle-ai-items');
  const result = element('battle-ai-result');
  let candidates: BattleCandidateBatch | null = null;
  let previewed: BattleEditBatch | null = null;
  let previewBasis: string | null = null;
  let activeMapId = options.getWorkspace().mapId;

  const text = (parent: HTMLElement, tag: 'p' | 'strong' | 'pre' | 'summary', value: string): HTMLElement => {
    const node = doc.createElement(tag);
    node.textContent = value;
    if (tag === 'pre') node.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;background:#020617;padding:8px;border-radius:4px;font-size:11px';
    parent.append(node);
    return node;
  };
  const invalidatePreview = (): void => {
    previewed = null;
    previewBasis = null;
    applyButton.disabled = true;
    result.replaceChildren();
  };
  const clear = (): void => {
    candidates = null;
    invalidatePreview();
    list.replaceChildren();
    input.value = '';
    file.value = '';
    previewButton.disabled = true;
  };
  const selectedIds = (): string[] => Array.from(list.querySelectorAll<HTMLInputElement>('input[data-candidate-id]:checked'))
    .map(checkbox => checkbox.dataset.candidateId!);
  // 文件读取/JSON解析/候选选择/提交均在用户事件这一处显示原错与堆栈，绝不返回空成功。
  const run = async (action: () => void | Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      invalidatePreview();
      status.textContent = `操作失败：${error instanceof Error ? error.message : String(error)}`;
      console.error('AI 草案操作失败', error);
    }
  };

  const renderCandidates = (): void => {
    const batch = candidates!;
    const workspace = options.getWorkspace();
    const sourceFor = (sourceId: string) => batch.sources.find(source => source.id === sourceId)
      ?? workspace.battle.sources.find(source => source.id === sourceId);
    list.replaceChildren();
    for (const item of batch.items) {
      const card = doc.createElement('article');
      card.dataset.candidateItem = item.id;
      card.style.cssText = 'border:1px solid #475569;border-radius:7px;margin:10px 0;padding:10px';
      const label = doc.createElement('label');
      const checkbox = doc.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.candidateId = item.id;
      checkbox.disabled = item.state === 'unresolved';
      checkbox.addEventListener('change', () => { invalidatePreview(); status.textContent = '选择已变化，请预览后应用。'; });
      label.append(checkbox, doc.createTextNode(`${item.state === 'ready' ? '可审阅' : '待补'} · ${item.instruction}`));
      card.append(label);
      text(card, 'p', `候选 ID：${item.id}`);
      if (item.state === 'unresolved') text(card, 'p', `待补原因：${item.reason}`);
      else for (const edit of item.edits) {
        const details = doc.createElement('details');
        text(details, 'summary', editTitle(edit));
        text(details, 'strong', '当前对象');
        const before = objectBefore(workspace, edit);
        text(details, 'pre', before === undefined ? '对象尚不存在' : JSON.stringify(before, null, 2));
        const subject = editSubject(edit);
        if (subject !== null) {
          const entries: FieldEntry[] = [];
          collectFieldEntries(subject, '', entries);
          if (entries.length > 0) {
            text(details, 'strong', '字段级候选与来源');
            for (const entry of entries) {
              const fieldDetails = doc.createElement('details');
              text(fieldDetails, 'summary', `${entry.path} · ${entry.field.state === 'known' ? '已知' : '未知'}`);
              const beforeValue = before === undefined ? undefined : valueAtPath(before, entry.path);
              text(fieldDetails, 'p', `当前：${displayFieldValue(beforeValue)}`);
              text(fieldDetails, 'p', `候选：${entry.field.state === 'known'
                ? JSON.stringify(entry.field.value) : `未知（${entry.field.reason}）`}`);
              if (entry.field.evidence.length === 0) text(fieldDetails, 'p', '字段来源：无');
              for (const evidence of entry.field.evidence) {
                const source = sourceFor(evidence.sourceId);
                text(fieldDetails, 'p', source
                  ? `来源：${source.title} · ${evidence.basis} · ${evidence.sourceId}`
                  : `来源：已移除（${evidence.sourceId}） · ${evidence.basis}`);
                text(fieldDetails, 'p', `对应原文：${evidence.excerpt}`);
                text(fieldDetails, 'p', `说明：${evidence.note}`);
              }
              details.append(fieldDetails);
            }
          }
        }
        text(details, 'strong', '候选完整编辑（各字段保留来源、未知和记录/方案）');
        text(details, 'pre', JSON.stringify(edit, null, 2));
        card.append(details);
      }
      const evidenceList = candidateEvidence(item);
      if (evidenceList.length > 0) text(card, 'strong', '候选引用的来源原文');
      const seen = new Set<string>();
      for (const evidence of evidenceList) {
        const key = JSON.stringify(evidence);
        if (seen.has(key)) continue;
        seen.add(key);
        const source = sourceFor(evidence.sourceId);
        const details = doc.createElement('details');
        text(details, 'summary', source
          ? `来源 ${source.title} · ${evidence.basis} · ${evidence.sourceId}`
          : `来源：已移除（${evidence.sourceId}） · ${evidence.basis}`);
        text(details, 'p', `对应原文：${evidence.excerpt}`);
        text(details, 'p', `说明：${evidence.note}`);
        if (source) {
          text(details, 'p', `种类：${source.kind}；定位：${source.locator === null ? '未填写' : source.locator}`);
          if (source.locator && source.locator.trim() && options.onFocusSource) {
            const locator = source.locator.trim();
            const focusBtn = doc.createElement('button');
            focusBtn.type = 'button';
            focusBtn.textContent = '在宿主中定位原文';
            focusBtn.addEventListener('click', () => {
              options.onFocusSource?.({
                sourceId: locator,
                ...(evidence.excerpt ? { highlightQuote: evidence.excerpt } : {}),
              });
            });
            details.append(focusBtn);
          }
          text(details, 'pre', source.text);
        }
        card.append(details);
      }
      if (evidenceList.length === 0) text(card, 'p', '此项没有引用来源，审阅时需确认资料是否充分。');
      list.append(card);
    }
  };

  entry.addEventListener('click', () => { refresh(); panel.hidden = !panel.hidden; });
  element('battle-ai-close').addEventListener('click', () => { panel.hidden = true; });
  input.addEventListener('input', () => {
    candidates = null;
    list.replaceChildren();
    invalidatePreview();
    previewButton.disabled = true;
    status.textContent = 'JSON 已变化，请重新解析。';
  });
  file.addEventListener('change', () => {
    const selected = file.files![0];
    if (selected === undefined) return; // 用户关闭文件选择器；事件入口，无文件就没有导入动作。
    void run(async () => {
      clear();
      input.value = await selected.text();
      status.textContent = '文件已读入，请解析并审阅。';
    });
  });
  element('battle-ai-parse').addEventListener('click', () => { void run(() => {
    candidates = null;
    list.replaceChildren();
    invalidatePreview();
    previewButton.disabled = true;
    candidates = parseBattleCandidates(input.value, options.getWorkspace());
    renderCandidates();
    const ready = candidates.items.filter(item => item.state === 'ready').length;
    previewButton.disabled = ready === 0;
    status.textContent = `已解析 ${ready} 项可审阅候选，${candidates.items.length - ready} 项待补。尚未修改地图。`;
  }); });
  previewButton.addEventListener('click', () => { void run(() => {
    const workspace = options.getWorkspace();
    previewed = selectBattleCandidates(candidates!, selectedIds(), workspace);
    const after = previewBattleEdits(workspace, previewed);
    previewBasis = JSON.stringify(workspace);
    result.replaceChildren();
    text(result, 'strong', `将同批应用 ${previewed.candidateItemIds.length} 项候选；未选项和待补项不应用。`);
    for (const edit of previewed.edits) {
      const details = doc.createElement('details');
      text(details, 'summary', editTitle(edit));
      text(details, 'strong', '应用前');
      const beforeValue = objectBefore(workspace, edit);
      text(details, 'pre', beforeValue === undefined ? '对象尚不存在' : JSON.stringify(beforeValue, null, 2));
      text(details, 'strong', '应用后');
      const afterValue = objectBefore(after, edit);
      text(details, 'pre', afterValue === undefined ? '对象将被删除' : JSON.stringify(afterValue, null, 2));
      result.append(details);
    }
    applyButton.disabled = false;
    status.textContent = '预览已通过，地图仍未修改；确认所选内容后应用，可通过“战役”面板撤销整批。';
  }); });
  applyButton.addEventListener('click', () => { void run(() => {
    if (previewed === null || previewBasis !== JSON.stringify(options.getWorkspace())) {
      throw new Error('当前地图数据或选择已变化，请重新预览后再应用');
    }
    const batch = previewed;
    options.applyBatch(batch);
    const appliedIds = new Set(batch.candidateItemIds);
    candidates!.items = candidates!.items.filter(item => !appliedIds.has(item.id));
    invalidatePreview();
    renderCandidates();
    previewButton.disabled = !candidates!.items.some(item => item.state === 'ready');
    status.textContent = `已应用 ${batch.candidateItemIds.length} 项，来源与编辑同批提交。剩余候选尚未应用；可在“战役”面板撤销。`;
  }); });
  element('battle-ai-cancel').addEventListener('click', () => {
    clear();
    status.textContent = '已取消草案，地图状态未改变。';
  });
  element('battle-ai-template').addEventListener('click', () => { void run(() => {
    const workspace = options.getWorkspace();
    if (!workspace.mapId) throw new Error('请先加载一个战区，再导出任务模板');
    const blob = new Blob([JSON.stringify(createBattleAiTemplate(workspace), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = `battle-ai-task-${workspace.mapId.replace(/[^\p{L}\p{N}_-]/gu, '_')}.json`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status.textContent = '已导出当前战区任务包，保留稳定 ID、来源及未知；请补充本次原文和修改要求。';
  }); });

  function refresh(): void {
    const workspace = options.getWorkspace();
    if (activeMapId !== workspace.mapId) {
      clear();
      activeMapId = workspace.mapId;
      status.textContent = '已切换战区，旧草案已清除。';
    } else invalidatePreview();
    element('battle-ai-map').textContent = `当前战区：${workspace.mapId || '尚未加载'}；${workspace.garrisons.length} 个部队，${workspace.battle.battlefields.length} 个战场。`;
    if (candidates !== null) renderCandidates();
  }
  refresh();
  return { refresh };
}
