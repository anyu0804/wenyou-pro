import { appStore, recomputeBurgTiers, type InteractionMode, type MapData, type ProvinceItem, type StateItem, type ViewMode } from './store';
import { canRedo, canUndo, purgeEntityPaintHistory, redoPaint, undoPaint } from './map-renderer';
import { canUndoRetouch, undoRetouch } from './retouch-layer';
import { isFieldBattleOwner, isTextInput, setInputOwner } from './input-owner';

/**
 * 在线刷政权 / 刷省份 / 城市编辑 的控制面板
 *
 * 只负责界面与 appStore 参数，真正的落笔、重绘、撤销在 map-renderer.ts。
 * v0.5.1（U 包）：下线捏地形与宗教 UI 入口（视图、工具、高度增量滑块、信仰下拉），
 * 底层 cells.h / cells.religion 数据读写与序列化保持原样。
 */

const VIEWS: Array<{ mode: ViewMode; label: string }> = [
  { mode: 'terrain', label: '地形' },
  { mode: 'biome', label: '群系' },
  { mode: 'state', label: '政权' },
  { mode: 'province', label: '省份' },
];

const TOOLS: Array<{ mode: InteractionMode; label: string; icon: string; hint: string }> = [
  { mode: 'pan', label: '漫游', icon: '✋', hint: '拖动/缩放地图' },
  { mode: 'brush-state', label: '刷政权', icon: '⚑', hint: '把地块划给当前势力' },
  { mode: 'brush-province', label: '刷省份', icon: '⌗', hint: '把地块划给当前省份' },
  { mode: 'burg-edit', label: '城市编辑', icon: '🏙', hint: '点击陆地新建城市 · 点击城市编辑属性 · 拖拽城市移位' },
];

type EntityKind = 'state' | 'province';

let panelEl: HTMLDivElement | null = null;
let statusEl: HTMLDivElement | null = null;
let summaryEl: HTMLDivElement | null = null;
let radiusLabel: HTMLSpanElement | null = null;
let radiusInput: HTMLInputElement | null = null;
let stateSelect: HTMLSelectElement | null = null;
let provinceSelect: HTMLSelectElement | null = null;
let undoButton: HTMLButtonElement | null = null;
let redoButton: HTMLButtonElement | null = null;
let retouchSectionEl: HTMLDivElement | null = null;
let overlayAlphaInput: HTMLInputElement | null = null;
let overlayAlphaLabel: HTMLSpanElement | null = null;
let retouchColorInput: HTMLInputElement | null = null;
let retouchColorHex: HTMLSpanElement | null = null;
let retouchRadiusInput: HTMLInputElement | null = null;
let retouchRadiusLabel: HTMLSpanElement | null = null;
let retouchUndoButton: HTMLButtonElement | null = null;
const entityActionButtons: HTMLButtonElement[] = [];

const MODEL_KEY = 'wenyou-brush-panel';

export function initBrushPanel(rootEl: HTMLElement): void {
  if (panelEl) return;
  injectStyles();

  const panel = document.createElement('div');
  panel.id = MODEL_KEY;
  panelEl = panel;
  panel.addEventListener('pointerdown', () => setInputOwner('map'));

  panel.appendChild(buildHeader());

  summaryEl = document.createElement('div');
  summaryEl.className = 'bp-summary';
  summaryEl.textContent = '等待底图…';
  panel.appendChild(summaryEl);

  panel.appendChild(buildSection('视图', buildViewSwitch()));
  panel.appendChild(buildSection('工具', buildToolSwitch()));
  panel.appendChild(buildSection('画笔', buildBrushControls()));
  panel.appendChild(buildSection('目标', buildTargetControls()));
  retouchSectionEl = buildSection('底图修补与透明度', buildImageRetouchControls());
  retouchSectionEl.id = 'bp-image-retouch-section';
  retouchSectionEl.style.display = 'none';
  panel.appendChild(retouchSectionEl);
  panel.appendChild(buildSection('显示与历史', buildDisplayControls()));

  statusEl = document.createElement('div');
  statusEl.className = 'bp-status';
  statusEl.textContent = '等待底图…';
  panel.appendChild(statusEl);

  const hint = document.createElement('div');
  hint.className = 'bp-hint';
  hint.textContent = '左键作画 · 中键/右键/空格拖动地图 · 滚轮缩放 · Ctrl+Z 撤销 · 数字键 1~4 切换工具';
  panel.appendChild(hint);

  rootEl.appendChild(panel);
  setEntityActionsEnabled(false);
  syncSelection();
  bindStoreEvents();
  bindKeyboard();
}

// --- 布局块 ----------------------------------------------------------------
function buildHeader(): HTMLDivElement {
  const header = document.createElement('div');
  header.className = 'bp-header';

  const title = document.createElement('div');
  title.className = 'bp-title';
  title.textContent = '政权与城市画笔';

  const subtitle = document.createElement('div');
  subtitle.className = 'bp-subtitle';
  subtitle.textContent = '文游战略沙盘 v0.9.1';

  header.append(title, subtitle);
  return header;
}

function buildSection(title: string, body: HTMLElement): HTMLDivElement {
  const section = document.createElement('div');
  section.className = 'bp-section';

  const heading = document.createElement('div');
  heading.className = 'bp-label';
  heading.textContent = title;

  section.append(heading, body);
  return section;
}

function buildViewSwitch(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bp-stack';

  const btnRow = document.createElement('div');
  btnRow.className = 'bp-buttons';
  for (const view of VIEWS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bp-btn';
    button.dataset.view = view.mode;
    button.textContent = view.label;
    button.addEventListener('click', () => {
      appStore.viewMode = view.mode;
      appStore.emit('view:changed', view.mode);
      syncSelection();
    });
    btnRow.appendChild(button);
  }

  const toggleRow = document.createElement('label');
  toggleRow.className = 'bp-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.id = 'view-toggle-field-battles';
  check.checked = appStore.showFieldBattles;
  check.addEventListener('change', () => {
    appStore.showFieldBattles = check.checked;
    appStore.emit('fieldbattle:visibility', check.checked);
  });
  const text = document.createElement('span');
  text.textContent = '战场';
  toggleRow.append(check, text);

  wrap.append(btnRow, toggleRow);
  return wrap;
}

function buildToolSwitch(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bp-buttons bp-buttons-column';
  for (const tool of TOOLS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bp-btn bp-btn-tool';
    button.dataset.tool = tool.mode;
    button.title = tool.hint;

    const icon = document.createElement('span');
    icon.className = 'bp-icon';
    icon.textContent = tool.icon;

    const label = document.createElement('span');
    label.textContent = tool.label;

    button.append(icon, label);
    button.addEventListener('click', () => {
      appStore.interactionMode = tool.mode;
      appStore.emit('tactical-mode-change', tool.mode);
      appStore.emit('brush:changed', tool.mode);
      syncSelection();
    });
    wrap.appendChild(button);
  }
  return wrap;
}

function buildBrushControls(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bp-stack';

  const radiusRow = document.createElement('div');
  radiusRow.className = 'bp-row';
  const radiusTitle = document.createElement('span');
  radiusTitle.textContent = '半径';
  radiusLabel = document.createElement('span');
  radiusLabel.className = 'bp-value';
  radiusLabel.textContent = String(appStore.brushRadius);
  radiusRow.append(radiusTitle, radiusLabel);

  const radius = document.createElement('input');
  radiusInput = radius;
  radius.type = 'range';
  radius.min = '6';
  radius.max = '140';
  radius.step = '1';
  radius.value = String(appStore.brushRadius);
  radius.addEventListener('input', () => {
    appStore.brushRadius = Number(radius.value);
    if (radiusLabel) radiusLabel.textContent = radius.value;
    appStore.emit('brush:changed', 'radius');
  });

  wrap.append(radiusRow, radius);
  return wrap;
}

function buildTargetControls(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bp-stack';

  stateSelect = createSelect('势力', () => {
    appStore.activeStateId = Number(stateSelect?.value ?? appStore.activeStateId);
    appStore.emit('brush:changed', 'state');
  });
  provinceSelect = createSelect('省份', () => {
    appStore.activeProvinceId = Number(provinceSelect?.value ?? appStore.activeProvinceId);
    appStore.emit('brush:changed', 'province');
  });

  wrap.append(
    createSelectRow('势力', stateSelect),
    buildEntityActionRow('state'),
    createSelectRow('省份', provinceSelect),
    buildEntityActionRow('province')
  );
  return wrap;
}

function buildEntityActionRow(kind: EntityKind): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'bp-actions';

  const actions = kind === 'state'
    ? [
        { label: '+ 新建国家', title: '新建一个政权，并立即切换到涂刷政权模式', run: openCreateStateForm },
        { label: '✎ 改名/色', title: '修改当前选中势力的名称与颜色', run: openEditStateForm },
        { label: '🗑 删除', title: '删除当前选中势力，其地块回归中立地', run: deleteActiveState },
      ]
    : [
        { label: '+ 新建省份', title: '新建一个省份，并立即切换到涂刷省份模式', run: openCreateProvinceForm },
        { label: '✎ 改名/色', title: '修改当前选中省份的名称、颜色与所属国家', run: openEditProvinceForm },
        { label: '🗑 删除', title: '删除当前选中省份，其地块归还国家直辖', run: deleteActiveProvince },
      ];

  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bp-btn bp-btn-mini';
    button.textContent = action.label;
    button.title = action.title;
    button.dataset.entityAction = kind;
    button.addEventListener('click', action.run);
    entityActionButtons.push(button);
    row.appendChild(button);
  }
  return row;
}

function createSelect(labelText: string, onChange: () => void): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'bp-select';
  select.title = `当前${labelText}`;
  select.addEventListener('change', onChange);
  return select;
}

function createSelectRow(labelText: string, select: HTMLSelectElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'bp-row bp-row-select';
  const label = document.createElement('span');
  label.textContent = labelText;
  row.append(label, select);
  return row;
}

function buildImageRetouchControls(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bp-stack';

  // 1. 疆域遮罩透明度 (0% ~ 85%，默认 38%)
  const alphaRow = document.createElement('div');
  alphaRow.className = 'bp-row';
  const alphaTitle = document.createElement('span');
  alphaTitle.textContent = '疆域遮罩透明度';
  overlayAlphaLabel = document.createElement('span');
  overlayAlphaLabel.className = 'bp-value';
  overlayAlphaLabel.textContent = '38%';
  alphaRow.append(alphaTitle, overlayAlphaLabel);

  const alphaInput = document.createElement('input');
  overlayAlphaInput = alphaInput;
  alphaInput.id = 'bp-overlay-alpha';
  alphaInput.type = 'range';
  alphaInput.min = '0';
  alphaInput.max = '85';
  alphaInput.step = '1';
  alphaInput.value = '38';
  alphaInput.addEventListener('input', () => {
    const pct = Math.max(0, Math.min(85, Number(alphaInput.value) || 0));
    if (overlayAlphaLabel) overlayAlphaLabel.textContent = `${pct}%`;
    appStore.emit('overlay:alpha', pct / 100);
  });

  // 2. 修补擦字笔 & 吸取底图色
  const modeRow = document.createElement('div');
  modeRow.className = 'bp-buttons';

  const eraseBtn = document.createElement('button');
  eraseBtn.type = 'button';
  eraseBtn.className = 'bp-btn bp-btn-mini';
  eraseBtn.dataset.tool = 'retouch-erase';
  eraseBtn.textContent = '🖌 修补擦字笔';
  eraseBtn.title = '左键涂抹覆盖底图旧字 · 按住 Alt+左键可随时吸色';
  eraseBtn.addEventListener('click', () => {
    appStore.interactionMode = 'retouch-erase';
    appStore.emit('tactical-mode-change', 'retouch-erase');
    appStore.emit('brush:changed', 'retouch');
    syncSelection();
    setStatus('修补擦字笔：左键涂抹盖旧字 · 按住 Alt+左键吸取底图色 · Ctrl+Z 撤销');
  });

  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'bp-btn bp-btn-mini';
  pickBtn.dataset.tool = 'retouch-pick';
  pickBtn.textContent = '🧪 吸取底图色';
  pickBtn.title = '点击底图吸取颜色（也可在擦字时按 Alt+左键吸色）';
  pickBtn.addEventListener('click', () => {
    appStore.interactionMode = 'retouch-pick';
    appStore.emit('tactical-mode-change', 'retouch-pick');
    appStore.emit('brush:changed', 'retouch');
    syncSelection();
    setStatus('吸色模式：点击底图吸取颜色（也可在擦字时按 Alt+左键吸色）');
  });

  modeRow.append(eraseBtn, pickBtn);

  // 3. 当前修补色
  const colorRow = document.createElement('div');
  colorRow.className = 'bp-row';
  const colorTitle = document.createElement('span');
  colorTitle.textContent = '修补色';
  const colorRight = document.createElement('div');
  colorRight.className = 'bp-retouch-color-wrap';

  retouchColorInput = document.createElement('input');
  retouchColorInput.id = 'bp-retouch-color';
  retouchColorInput.type = 'color';
  retouchColorInput.className = 'bp-color-input';
  retouchColorInput.value = appStore.retouchColor;
  retouchColorInput.addEventListener('input', () => {
    appStore.retouchColor = retouchColorInput!.value;
    if (retouchColorHex) retouchColorHex.textContent = appStore.retouchColor;
    appStore.emit('brush:changed', 'retouch');
  });

  retouchColorHex = document.createElement('span');
  retouchColorHex.className = 'bp-value bp-hex';
  retouchColorHex.textContent = appStore.retouchColor;
  colorRight.append(retouchColorInput, retouchColorHex);
  colorRow.append(colorTitle, colorRight);

  // 4. 修补笔半径
  const rRow = document.createElement('div');
  rRow.className = 'bp-row';
  const rTitle = document.createElement('span');
  rTitle.textContent = '修补笔粗细';
  retouchRadiusLabel = document.createElement('span');
  retouchRadiusLabel.className = 'bp-value';
  retouchRadiusLabel.textContent = `${appStore.retouchRadius}px`;
  rRow.append(rTitle, retouchRadiusLabel);

  const rInput = document.createElement('input');
  retouchRadiusInput = rInput;
  rInput.id = 'bp-retouch-radius';
  rInput.type = 'range';
  rInput.min = '4';
  rInput.max = '80';
  rInput.step = '1';
  rInput.value = String(appStore.retouchRadius);
  rInput.addEventListener('input', () => {
    const val = Math.max(4, Math.min(80, Number(rInput.value) || 24));
    appStore.retouchRadius = val;
    if (retouchRadiusLabel) retouchRadiusLabel.textContent = `${val}px`;
    appStore.emit('brush:changed', 'retouch');
  });

  // 5. 撤销修补与提示
  retouchUndoButton = document.createElement('button');
  retouchUndoButton.id = 'bp-retouch-undo';
  retouchUndoButton.type = 'button';
  retouchUndoButton.className = 'bp-btn bp-btn-mini';
  retouchUndoButton.textContent = '↶ 撤销修补';
  retouchUndoButton.disabled = true;
  retouchUndoButton.addEventListener('click', () => {
    if (undoRetouch()) {
      syncRetouchControls();
      setStatus('已撤销上一笔底图修补');
    }
  });

  const tip = document.createElement('div');
  tip.className = 'bp-retouch-tip';
  tip.textContent = '提示：也可在擦字时按 Alt+左键吸色';

  wrap.append(alphaRow, alphaInput, modeRow, colorRow, rRow, rInput, retouchUndoButton, tip);
  return wrap;
}

function syncRetouchControls(): void {
  const mapData = appStore.mapData;
  const isImage = mapData?.source.baseKind === 'image';
  if (retouchSectionEl) {
    retouchSectionEl.style.display = isImage ? '' : 'none';
  }
  if (isImage && mapData) {
    const pct = Math.max(0, Math.min(85, Math.round((mapData.source.overlayAlpha ?? 0.38) * 100)));
    if (overlayAlphaInput && document.activeElement !== overlayAlphaInput) {
      overlayAlphaInput.value = String(pct);
    }
    if (overlayAlphaLabel) overlayAlphaLabel.textContent = `${pct}%`;
  }
  if (retouchColorInput && document.activeElement !== retouchColorInput) {
    retouchColorInput.value = appStore.retouchColor;
  }
  if (retouchColorHex) retouchColorHex.textContent = appStore.retouchColor;
  if (retouchRadiusInput && document.activeElement !== retouchRadiusInput) {
    retouchRadiusInput.value = String(appStore.retouchRadius);
  }
  if (retouchRadiusLabel) retouchRadiusLabel.textContent = `${appStore.retouchRadius}px`;
  if (retouchUndoButton) retouchUndoButton.disabled = !canUndoRetouch();
}

function buildDisplayControls(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'bp-stack';

  const gridRow = document.createElement('label');
  gridRow.className = 'bp-check';
  const grid = document.createElement('input');
  grid.type = 'checkbox';
  grid.checked = appStore.showCiv4Grid;
  grid.addEventListener('change', () => {
    appStore.showCiv4Grid = grid.checked;
    appStore.emit('grid:changed', grid.checked);
  });
  const gridText = document.createElement('span');
  gridText.textContent = '显示经纬网';
  gridRow.append(grid, gridText);

  const hillshadeRow = buildToggle('立体坡度光影', appStore.showHillshade, (checked) => {
    appStore.showHillshade = checked;
    appStore.emit('terrain:style', 'hillshade');
  });

  const contourRow = buildToggle('海拔等高线', appStore.showContours, (checked) => {
    appStore.showContours = checked;
    appStore.emit('terrain:style', 'contours');
  });

  const cityScaleRow = document.createElement('div');
  cityScaleRow.className = 'bp-row';
  const cityScaleTitle = document.createElement('span');
  cityScaleTitle.textContent = '城市名大小';
  const cityScaleVal = document.createElement('span');
  cityScaleVal.id = 'city-label-scale-val';
  cityScaleVal.className = 'bp-value';
  cityScaleVal.textContent = `${Math.round(appStore.cityLabelScale * 100)}%`;
  cityScaleRow.append(cityScaleTitle, cityScaleVal);

  const cityScaleInput = document.createElement('input');
  cityScaleInput.id = 'city-label-scale';
  cityScaleInput.type = 'range';
  cityScaleInput.min = '0.5';
  cityScaleInput.max = '2.4';
  cityScaleInput.step = '0.05';
  cityScaleInput.value = String(appStore.cityLabelScale);
  cityScaleInput.setAttribute('aria-label', '城市名大小');
  cityScaleInput.addEventListener('input', () => {
    const val = Number(cityScaleInput.value) || 1;
    appStore.cityLabelScale = val;
    cityScaleVal.textContent = `${Math.round(val * 100)}%`;
    appStore.emit('labels:style');
  });

  const cityZoomRow = buildToggle('城市名随缩放变大', appStore.cityLabelZoomBoost, (checked) => {
    appStore.cityLabelZoomBoost = checked;
    appStore.emit('labels:style');
  });
  cityZoomRow.querySelector('input')!.id = 'city-label-zoom-boost';

  const cityLodRow = buildToggle('城市名按缩放分级显示', appStore.cityLabelDynamicLod, (checked) => {
    appStore.cityLabelDynamicLod = checked;
    appStore.emit('labels:style');
  });
  cityLodRow.querySelector('input')!.id = 'city-label-dynamic-lod';

  const historyRow = document.createElement('div');
  historyRow.className = 'bp-buttons';

  undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'bp-btn';
  undoButton.textContent = '↶ 撤销';
  undoButton.addEventListener('click', () => {
    if (undoPaint()) {
      syncHistoryButtons();
      setStatus('已撤销上一笔');
    }
  });

  redoButton = document.createElement('button');
  redoButton.type = 'button';
  redoButton.className = 'bp-btn';
  redoButton.textContent = '↷ 重做';
  redoButton.addEventListener('click', () => {
    if (redoPaint()) {
      syncHistoryButtons();
      setStatus('已重做下一笔');
    }
  });

  historyRow.append(undoButton, redoButton);
  wrap.append(gridRow, hillshadeRow, contourRow, cityScaleRow, cityScaleInput, cityZoomRow, cityLodRow, historyRow);
  syncHistoryButtons();
  return wrap;
}

function buildToggle(labelText: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'bp-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = labelText;
  row.append(input, text);
  return row;
}

// --- 表单弹窗 --------------------------------------------------------------
type FormFieldKind = 'text' | 'color' | 'select';

interface FormOption {
  value: string;
  label: string;
}

interface FormFieldSpec {
  key: string;
  label: string;
  kind: FormFieldKind;
  value: string;
  options?: FormOption[];
  required?: boolean;
}

interface FormDialogSpec {
  title: string;
  fields: FormFieldSpec[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => void;
  onFieldChange?: (
    key: string,
    value: string,
    setOptions: (key: string, options: FormOption[], selected?: string) => void
  ) => void;
}

let dialogOverlay: HTMLDivElement | null = null;

function closeFormDialog(): void {
  dialogOverlay?.remove();
  dialogOverlay = null;
}

function openFormDialog(spec: FormDialogSpec): void {
  closeFormDialog();

  const overlay = document.createElement('div');
  overlay.className = 'bp-modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'bp-modal';
  dialog.tabIndex = -1;

  const title = document.createElement('div');
  title.className = 'bp-modal-title';
  title.textContent = spec.title;

  const form = document.createElement('div');
  form.className = 'bp-modal-form';

  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const selectTargets = new Map<string, HTMLSelectElement>();

  const setOptions = (key: string, options: FormOption[], selected?: string): void => {
    const select = selectTargets.get(key)!;
    select.innerHTML = '';
    for (const option of options) {
      const node = document.createElement('option');
      node.value = option.value;
      node.textContent = option.label;
      select.appendChild(node);
    }
    if (selected !== undefined) select.value = selected;
  };

  for (const field of spec.fields) {
    const row = document.createElement('label');
    row.className = 'bp-modal-row';

    const label = document.createElement('span');
    label.textContent = field.label;

    let control: HTMLInputElement | HTMLSelectElement;
    if (field.kind === 'select') {
      const select = document.createElement('select');
      select.className = 'bp-select';
      selectTargets.set(field.key, select);
      setOptions(field.key, field.options ?? [], field.value);
      select.addEventListener('change', () => {
        spec.onFieldChange?.(field.key, select.value, setOptions);
      });
      control = select;
    } else {
      const input = document.createElement('input');
      input.className = 'bp-modal-input';
      input.type = field.kind;
      input.value = field.value;
      control = input;
    }
    controls.set(field.key, control);
    row.append(label, control);
    form.appendChild(row);
  }

  const error = document.createElement('div');
  error.className = 'bp-modal-error';

  const actions = document.createElement('div');
  actions.className = 'bp-modal-actions';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'bp-btn';
  cancel.textContent = '取消';
  cancel.addEventListener('click', closeFormDialog);

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'bp-btn bp-btn-primary';
  submit.textContent = spec.submitLabel;
  submit.addEventListener('click', () => {
    const values: Record<string, string> = {};
    for (const [key, control] of controls) values[key] = control.value.trim();
    const missing = spec.fields.find((field) => field.required && values[field.key].length === 0);
    if (missing) {
      error.textContent = `请填写「${missing.label}」`;
      return;
    }
    spec.onSubmit(values);
    closeFormDialog();
  });

  actions.append(cancel, submit);
  dialog.append(title, form, error, actions);
  overlay.appendChild(dialog);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) closeFormDialog();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeFormDialog();
  });

  document.body.appendChild(overlay);
  dialogOverlay = overlay;
  dialog.focus();
}

// --- 国家 / 省份 增删改 ------------------------------------------------------
/** 面板在 `map:loaded` 之前禁用全部实体管理按钮，处理函数直接消费已加载地图。 */
function loadedMap(): MapData {
  return appStore.mapData as MapData;
}

function setEntityActionsEnabled(enabled: boolean): void {
  for (const button of entityActionButtons) button.disabled = !enabled;
}

function validStates(mapData: MapData): StateItem[] {
  return mapData.states.filter((state) => state.i > 0 && !state.removed);
}

function validProvinces(mapData: MapData): ProvinceItem[] {
  return mapData.provinces.filter((province) => province.i > 0 && !province.removed);
}

function burgOptions(mapData: MapData, stateId?: number, placeholder = '（暂不设首府）'): FormOption[] {
  const options: FormOption[] = [{ value: '0', label: placeholder }];
  for (const burg of mapData.burgs) {
    if (burg.i <= 0 || burg.removed) continue;
    if (stateId !== undefined && burg.state !== stateId) continue;
    options.push({ value: String(burg.i), label: `${burg.i} · ${burg.name}` });
  }
  return options;
}

function stateOptions(mapData: MapData): FormOption[] {
  return validStates(mapData).map((state) => ({ value: String(state.i), label: `${state.i} · ${state.name}` }));
}

function openCreateStateForm(): void {
  const mapData = loadedMap();
  openFormDialog({
    title: '新建国家',
    submitLabel: '确认新建',
    fields: [
      { key: 'name', label: '国名', kind: 'text', value: '新政权', required: true },
      { key: 'color', label: '颜色', kind: 'color', value: '#7c3aed' },
      {
        key: 'capital',
        label: '首都城市',
        kind: 'select',
        value: '0',
        options: burgOptions(mapData, undefined, '（暂不设首都，涂刷后自动定锚）'),
      },
    ],
    onSubmit: (values) => createState(mapData, values),
  });
}

function createState(mapData: MapData, values: Record<string, string>): void {
  const newId = Math.max(0, ...mapData.states.map((state) => state.i)) + 1;
  const capitalId = Number(values.capital);
  const capital = capitalId > 0 ? mapData.burgs.find((burg) => burg.i === capitalId && !burg.removed) : undefined;

  const state: StateItem = {
    i: newId,
    name: values.name,
    color: values.color,
    pole: capital ? [capital.x, capital.y] : [mapData.width / 2, mapData.height / 2],
    removed: false,
  };
  if (capital) {
    for (const other of mapData.states) {
      if (other.capital === capital.i) other.capital = 0;
    }
    if (capital.province > 0) {
      const oldProv = mapData.provinces.find((p) => p.i === capital.province && !p.removed);
      if (oldProv && oldProv.state !== newId) {
        if (oldProv.burg === capital.i) oldProv.burg = 0;
        capital.province = 0;
        mapData.cells.province[capital.cell] = 0;
      }
    }
    state.center = capital.cell;
    state.capital = capital.i;
    mapData.cells.state[capital.cell] = newId;
    capital.state = newId;
  }
  mapData.states.push(state);
  recomputeBurgTiers(mapData);

  appStore.activeStateId = newId;
  appStore.interactionMode = 'brush-state';
  appStore.viewMode = 'state';
  appStore.emit('entity:changed');
  appStore.emit('view:changed', 'state');
  appStore.emit('brush:changed', 'brush-state');
  syncSelection();
  setStatus(`已新建国家 ${newId} · ${state.name}${capital ? `，首都 ${capital.name}` : '，涂刷地块后自动定锚'}`);
}

function openEditStateForm(): void {
  const mapData = loadedMap();
  const state = validStates(mapData).find((item) => item.i === appStore.activeStateId);
  if (!state) {
    setStatus('请先在「势力」下拉框中选择要编辑的国家');
    return;
  }
  openFormDialog({
    title: `编辑国家 ${state.i} · ${state.name}`,
    submitLabel: '保存',
    fields: [
      { key: 'name', label: '国名', kind: 'text', value: state.name, required: true },
      { key: 'color', label: '颜色', kind: 'color', value: state.color },
    ],
    onSubmit: (values) => {
      state.name = values.name;
      state.color = values.color;
      appStore.emit('entity:changed');
      setStatus(`已更新国家 ${state.i} · ${state.name}`);
    },
  });
}

function deleteActiveState(): void {
  const mapData = loadedMap();
  const state = validStates(mapData).find((item) => item.i === appStore.activeStateId);
  if (!state) {
    setStatus('请先在「势力」下拉框中选择要删除的国家');
    return;
  }
  if (!window.confirm(`确认删除国家「${state.name}」？其名下地块将全部回归中立地。`)) return;

  const stateId = state.i;
  state.removed = true;
  for (let cell = 0; cell < mapData.cells.count; cell++) {
    if (mapData.cells.state[cell] === stateId) mapData.cells.state[cell] = 0;
  }
  for (const province of mapData.provinces) {
    if (province.state === stateId) province.state = 0;
  }
  for (const burg of mapData.burgs) {
    if (burg.state !== stateId) continue;
    burg.state = 0;
    burg.capital = 0;
  }
  recomputeBurgTiers(mapData);
  purgeEntityPaintHistory('state', stateId);
  syncHistoryButtons();
  appStore.emit('entity:changed');
  setStatus(`已删除国家 ${stateId} · ${state.name}`);
}

function openCreateProvinceForm(): void {
  const mapData = loadedMap();
  const states = validStates(mapData);
  if (!states.length) {
    setStatus('尚无有效国家，请先新建国家再新建省份');
    return;
  }
  const defaultStateId = states.some((state) => state.i === appStore.activeStateId)
    ? appStore.activeStateId
    : states[0].i;

  openFormDialog({
    title: '新建省份',
    submitLabel: '确认新建',
    fields: [
      { key: 'name', label: '省名', kind: 'text', value: '新省份', required: true },
      { key: 'state', label: '所属国家', kind: 'select', value: String(defaultStateId), options: stateOptions(mapData) },
      { key: 'color', label: '颜色', kind: 'color', value: '#38bdf8' },
      {
        key: 'capital',
        label: '省首府城市',
        kind: 'select',
        value: '0',
        options: burgOptions(mapData, defaultStateId, '（暂不设首府，涂刷后自动定锚）'),
      },
    ],
    onFieldChange: (key, value, setOptions) => {
      if (key !== 'state') return;
      const stateId = Number(value);
      setOptions('capital', burgOptions(mapData, stateId, '（暂不设首府，涂刷后自动定锚）'), '0');
    },
    onSubmit: (values) => createProvince(mapData, values),
  });
}

function createProvince(mapData: MapData, values: Record<string, string>): void {
  const newId = Math.max(0, ...mapData.provinces.map((province) => province.i)) + 1;
  const burgId = Number(values.capital);
  const burg = burgId > 0 ? mapData.burgs.find((item) => item.i === burgId && !item.removed) : undefined;

  const province: ProvinceItem = {
    i: newId,
    name: values.name,
    color: values.color,
    state: Number(values.state),
    centerCell: burg ? burg.cell : 0,
    burg: burg ? burg.i : 0,
    x: burg ? burg.x : mapData.width / 2,
    y: burg ? burg.y : mapData.height / 2,
  };
  if (burg) {
    for (const other of mapData.provinces) {
      if (other.burg === burg.i) other.burg = 0;
    }
    mapData.cells.province[burg.cell] = newId;
    burg.province = newId;
  }
  mapData.provinces.push(province);
  recomputeBurgTiers(mapData);

  appStore.activeProvinceId = newId;
  appStore.interactionMode = 'brush-province';
  appStore.viewMode = 'province';
  appStore.emit('entity:changed');
  appStore.emit('view:changed', 'province');
  appStore.emit('brush:changed', 'brush-province');
  syncSelection();
  setStatus(`已新建省份 ${newId} · ${province.name}${burg ? `，首府 ${burg.name}` : '，涂刷地块后自动定锚'}`);
}

function openEditProvinceForm(): void {
  const mapData = loadedMap();
  const province = validProvinces(mapData).find((item) => item.i === appStore.activeProvinceId);
  if (!province) {
    setStatus('请先在「省份」下拉框中选择要编辑的省份');
    return;
  }
  openFormDialog({
    title: `编辑省份 ${province.i} · ${province.name}`,
    submitLabel: '保存',
    fields: [
      { key: 'name', label: '省名', kind: 'text', value: province.name, required: true },
      {
        key: 'state',
        label: '所属国家',
        kind: 'select',
        value: String(province.state),
        options: [...stateOptions(mapData), { value: '0', label: '0 · 无主省份' }],
      },
      { key: 'color', label: '颜色', kind: 'color', value: province.color },
    ],
    onSubmit: (values) => {
      province.name = values.name;
      province.color = values.color;
      province.state = Number(values.state);
      recomputeBurgTiers(mapData);
      appStore.emit('entity:changed');
      setStatus(`已更新省份 ${province.i} · ${province.name}`);
    },
  });
}

function deleteActiveProvince(): void {
  const mapData = loadedMap();
  const province = validProvinces(mapData).find((item) => item.i === appStore.activeProvinceId);
  if (!province) {
    setStatus('请先在「省份」下拉框中选择要删除的省份');
    return;
  }
  if (!window.confirm(`确认删除省份「${province.name}」？其地块将归还国家直辖，驻军转为无省份状态。`)) return;

  const provId = province.i;
  province.removed = true;
  for (let cell = 0; cell < mapData.cells.count; cell++) {
    if (mapData.cells.province[cell] === provId) mapData.cells.province[cell] = 0;
  }
  for (const burg of mapData.burgs) {
    if (burg.province === provId) burg.province = 0;
  }
  for (const unit of appStore.garrisons) {
    if (unit.provinceId.state === 'known' && unit.provinceId.value === provId) {
      unit.provinceId = { ...unit.provinceId, value: null };
    }
  }
  recomputeBurgTiers(mapData);
  purgeEntityPaintHistory('province', provId);
  syncHistoryButtons();
  appStore.emit('entity:changed');
  appStore.emit('garrisons-change');
  setStatus(`已删除省份 ${provId} · ${province.name}`);
}

// --- 状态同步 --------------------------------------------------------------
function syncSelection(): void {
  if (!panelEl) return;
  panelEl.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    button.classList.toggle('bp-btn-active', button.dataset.view === appStore.viewMode);
  });
  panelEl.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((button) => {
    button.classList.toggle('bp-btn-active', button.dataset.tool === appStore.interactionMode);
  });
}

function syncHistoryButtons(): void {
  if (undoButton) undoButton.disabled = !canUndo();
  if (redoButton) redoButton.disabled = !canRedo();
}

function populateTargets(mapData: MapData): void {
  fillSelect(stateSelect, validStates(mapData), appStore.activeStateId);
  fillSelect(provinceSelect, validProvinces(mapData), appStore.activeProvinceId);
}

/** 顶部统计行：城市 / 省份 / 国家实时计数，随实体增删改刷新。 */
function updateSummary(mapData: MapData): void {
  const cities = mapData.burgs.filter((burg) => burg.i > 0 && !burg.removed).length;
  const provinces = validProvinces(mapData).length;
  const states = validStates(mapData).length;
  summaryEl!.textContent = `${cities.toLocaleString()} 座城市 · ${provinces} 个省份 · ${states} 个国家`;
}

/** `entity:changed` / `brush:targets-changed` 统一入口：刷新下拉框、统计行与工具高亮。 */
function refreshEntityViews(): void {
  const mapData = appStore.mapData as MapData;
  populateTargets(mapData);
  updateSummary(mapData);
  syncSelection();
}

function fillSelect<T extends { i: number; name: string }>(select: HTMLSelectElement | null, items: T[], activeId: number) {
  if (!select) return;
  select.innerHTML = '';
  if (!items.length) {
    const option = document.createElement('option');
    option.value = '0';
    option.textContent = '（底图无可用项）';
    select.appendChild(option);
    select.disabled = true;
    if (select === stateSelect) appStore.activeStateId = 0;
    else if (select === provinceSelect) appStore.activeProvinceId = 0;
    return;
  }
  select.disabled = false;
  let matched = false;
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item.i);
    option.textContent = `${item.i} · ${item.name}`;
    if (item.i === activeId) matched = true;
    select.appendChild(option);
  }
  if (!matched) {
    // 存档里当前默认目标不存在时，回落到第一个可用项并写回 store
    const first = items[0].i;
    select.value = String(first);
    if (select === stateSelect) appStore.activeStateId = first;
    else if (select === provinceSelect) appStore.activeProvinceId = first;
  } else {
    select.value = String(activeId);
  }
}

// --- 事件 ------------------------------------------------------------------
function bindStoreEvents(): void {
  appStore.on('map:loading', () => setStatus('正在解析底图…（首次约 1~2 秒）'));
  appStore.on('map:error', (error: unknown) => setStatus(`底图加载失败：${(error as Error)?.message ?? error}`));
  appStore.on('map:loaded', (mapData: MapData) => {
    populateTargets(mapData);
    updateSummary(mapData);
    setEntityActionsEnabled(true);
    setStatus(`已载入 ${mapData.cells.count.toLocaleString()} 个地块 · ${mapData.width}×${mapData.height}\n城市圆点全显；放大可见全部城名。`);
    syncHistoryButtons();
    syncRetouchControls();
    syncSelection();
  });
  appStore.on('map:cleared', () => {
    closeFormDialog();
    fillSelect(stateSelect, [], 0);
    fillSelect(provinceSelect, [], 0);
    setEntityActionsEnabled(false);
    if (summaryEl) summaryEl.textContent = '等待底图…';
    setStatus('等待底图…');
    syncHistoryButtons();
    syncRetouchControls();
    syncSelection();
  });
  appStore.on('entity:changed', refreshEntityViews);
  appStore.on('brush:targets-changed', refreshEntityViews);
  appStore.on('theater:leaving', closeFormDialog);
  appStore.on('tactical-mode-change', syncSelection);
  appStore.on('brush:changed', () => {
    syncSelection();
    syncRetouchControls();
  });
  appStore.on('retouch:changed', syncRetouchControls);
  appStore.on('overlay:alpha', (alpha: number) => {
    const pct = Math.max(0, Math.min(85, Math.round((Number.isFinite(alpha) ? alpha : 0.38) * 100)));
    if (overlayAlphaInput && document.activeElement !== overlayAlphaInput) {
      overlayAlphaInput.value = String(pct);
    }
    if (overlayAlphaLabel) overlayAlphaLabel.textContent = `${pct}%`;
  });
  appStore.on('brush:painted', (payload: { cells: number }) => {
    if (payload && payload.cells) setStatus(`本笔改动 ${payload.cells} 个地块`);
    syncHistoryButtons();
  });
  appStore.on('fieldbattle:visibility', (checked: boolean) => {
    const toggle = document.querySelector<HTMLInputElement>('#view-toggle-field-battles');
    if (toggle && toggle.checked !== checked) {
      toggle.checked = checked;
    }
  });
}

function setStatus(text: string): void {
  if (statusEl) statusEl.textContent = text;
}

function bindKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (isTextInput(event.target)) return;

    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.code === 'KeyZ') {
      if (isFieldBattleOwner()) return;
      // Ctrl+Z 只归属当前工具：tactical-* 撤战术，retouch-* 撤底图修补
      if (appStore.interactionMode.startsWith('tactical') || appStore.interactionMode.startsWith('retouch')) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (redoPaint()) {
          syncHistoryButtons();
          setStatus('已重做下一笔');
        }
      } else if (undoPaint()) {
        syncHistoryButtons();
        setStatus('已撤销上一笔');
      }
      return;
    }
    if (ctrl && event.code === 'KeyY') {
      if (isFieldBattleOwner()) return;
      if (appStore.interactionMode.startsWith('tactical') || appStore.interactionMode.startsWith('retouch')) return;
      event.preventDefault();
      if (redoPaint()) {
        syncHistoryButtons();
        setStatus('已重做下一笔');
      }
      return;
    }

    if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
      if (isFieldBattleOwner() || ctrl || event.altKey) return;
      const step = event.code === 'BracketLeft' ? -6 : 6;
      if (appStore.interactionMode === 'retouch-erase') {
        appStore.retouchRadius = Math.max(4, Math.min(80, appStore.retouchRadius + step));
        syncRetouchControls();
        appStore.emit('brush:changed', 'retouch');
        return;
      }
      appStore.brushRadius = Math.max(6, Math.min(140, appStore.brushRadius + step));
      if (radiusLabel) radiusLabel.textContent = String(appStore.brushRadius);
      if (radiusInput) radiusInput.value = String(appStore.brushRadius);
      appStore.emit('brush:changed', 'radius');
      return;
    }

    const index = Number(event.key);
    if (index >= 1 && index <= TOOLS.length) {
      if (isFieldBattleOwner() || ctrl || event.altKey) return;
      const tool = TOOLS[index - 1];
      appStore.interactionMode = tool.mode;
      appStore.emit('tactical-mode-change', tool.mode);
      appStore.emit('brush:changed', tool.mode);
      syncSelection();
    }
  });

  appStore.on('brush:painted', syncSelection);
}

// --- 样式 ------------------------------------------------------------------
function injectStyles(): void {
  if (document.getElementById('wenyou-brush-panel-style')) return;
  const style = document.createElement('style');
  style.id = 'wenyou-brush-panel-style';
  style.textContent = `
  #wenyou-brush-panel {
    position: fixed; left: 16px; top: 16px; width: 252px;
    max-height: calc(100vh - 32px); overflow-y: auto;
    background: rgba(13, 19, 26, 0.92);
    border: 1px solid rgba(148, 163, 184, 0.28);
    border-radius: 14px; padding: 14px 14px 12px;
    color: #e2e8f0; font-size: 12px; line-height: 1.45;
    box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(8px); z-index: 30;
  }
  #wenyou-brush-panel .bp-header { margin-bottom: 6px; }
  #wenyou-brush-panel .bp-title { font-size: 14px; font-weight: 700; letter-spacing: .5px; color: #f8fafc; }
  #wenyou-brush-panel .bp-subtitle { font-size: 10px; color: #7f94ad; letter-spacing: .4px; }
  #wenyou-brush-panel .bp-summary { font-size: 11px; color: #93c5fd; font-variant-numeric: tabular-nums; padding: 2px 0 8px; border-bottom: 1px solid rgba(148,163,184,.18); margin-bottom: 10px; }
  #wenyou-brush-panel .bp-section { margin-bottom: 12px; }
  #wenyou-brush-panel .bp-label { font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: #7f94ad; margin-bottom: 6px; }
  #wenyou-brush-panel .bp-buttons { display: flex; gap: 6px; flex-wrap: wrap; }
  #wenyou-brush-panel .bp-buttons-column { flex-direction: column; }
  #wenyou-brush-panel .bp-btn {
    flex: 1 1 auto; min-width: 52px; padding: 6px 8px; cursor: pointer;
    background: rgba(51, 65, 85, 0.55); color: #cbd5e1;
    border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 8px;
    font-family: inherit; font-size: 12px; transition: all .12s ease;
  }
  #wenyou-brush-panel .bp-btn:hover { background: rgba(71, 85, 105, 0.75); color: #f1f5f9; }
  #wenyou-brush-panel .bp-btn:disabled { opacity: .4; cursor: default; }
  #wenyou-brush-panel .bp-btn-active { background: #2563eb; border-color: #3b82f6; color: #f8fafc; box-shadow: 0 0 0 1px rgba(59,130,246,.5) inset; }
  #wenyou-brush-panel .bp-btn-tool { display: flex; align-items: center; gap: 8px; text-align: left; }
  #wenyou-brush-panel .bp-icon { font-size: 13px; opacity: .9; }
  #wenyou-brush-panel .bp-actions { display: flex; gap: 4px; margin: 0 0 6px; }
  #wenyou-brush-panel .bp-btn-mini { min-width: 0; padding: 4px 4px; font-size: 10.5px; border-radius: 6px; }
  #wenyou-brush-panel .bp-btn-mini[data-entity-action]:last-child:hover { background: rgba(153, 27, 27, .78); border-color: rgba(248,113,113,.55); color: #fee2e2; }
  #wenyou-brush-panel .bp-stack { display: flex; flex-direction: column; gap: 6px; }
  #wenyou-brush-panel .bp-row { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #a9b6c7; }
  #wenyou-brush-panel .bp-row-select { gap: 8px; }
  #wenyou-brush-panel .bp-value { color: #f1f5f9; font-variant-numeric: tabular-nums; }
  #wenyou-brush-panel input[type="range"] { width: 100%; accent-color: #3b82f6; }
  #wenyou-brush-panel .bp-select {
    flex: 1; min-width: 0; background: rgba(30, 41, 59, 0.9); color: #e2e8f0;
    border: 1px solid rgba(148, 163, 184, 0.25); border-radius: 6px;
    font-family: inherit; font-size: 11px; padding: 3px 4px; outline: none;
  }
  #wenyou-brush-panel .bp-check { display: flex; align-items: center; gap: 6px; color: #a9b6c7; font-size: 11px; cursor: pointer; }
  #wenyou-brush-panel .bp-check input { accent-color: #3b82f6; }
  #wenyou-brush-panel .bp-retouch-color-wrap { display: flex; align-items: center; gap: 6px; }
  #wenyou-brush-panel .bp-color-input { width: 28px; height: 22px; padding: 0; border: 1px solid rgba(148,163,184,.35); border-radius: 5px; background: transparent; cursor: pointer; }
  #wenyou-brush-panel .bp-hex { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }
  #wenyou-brush-panel .bp-retouch-tip { font-size: 10px; color: #7f94ad; line-height: 1.4; }
  #wenyou-brush-panel .bp-status { margin-top: 4px; padding-top: 8px; border-top: 1px solid rgba(148,163,184,.18); font-size: 11px; color: #8fa4bb; white-space: pre-line; }
  #wenyou-brush-panel .bp-hint { margin-top: 4px; font-size: 10px; color: #64748b; line-height: 1.5; }

  .bp-modal-overlay {
    position: fixed; inset: 0; z-index: 80; display: flex; align-items: center; justify-content: center;
    background: rgba(2, 6, 23, 0.62); backdrop-filter: blur(3px);
  }
  .bp-modal {
    width: 320px; max-width: calc(100vw - 48px); outline: none;
    background: rgba(15, 23, 34, 0.98); border: 1px solid rgba(148, 163, 184, 0.32);
    border-radius: 14px; padding: 16px; color: #e2e8f0;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 12px;
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.6);
  }
  .bp-modal .bp-modal-title { font-size: 13px; font-weight: 700; color: #f8fafc; margin-bottom: 12px; }
  .bp-modal .bp-modal-form { display: flex; flex-direction: column; gap: 8px; }
  .bp-modal .bp-modal-row { display: flex; align-items: center; gap: 10px; font-size: 11px; color: #a9b6c7; }
  .bp-modal .bp-modal-row > span { flex: 0 0 68px; }
  .bp-modal .bp-select,
  .bp-modal .bp-modal-input {
    flex: 1; min-width: 0; background: rgba(30, 41, 59, 0.95); color: #e2e8f0;
    border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 6px;
    font-family: inherit; font-size: 11px; padding: 4px 5px; outline: none;
  }
  .bp-modal .bp-modal-input[type="color"] { height: 24px; padding: 1px 2px; cursor: pointer; }
  .bp-modal .bp-modal-error { min-height: 14px; margin-top: 8px; font-size: 10.5px; color: #fca5a5; }
  .bp-modal .bp-modal-actions { display: flex; gap: 8px; margin-top: 6px; }
  .bp-modal .bp-btn {
    flex: 1; padding: 6px 8px; cursor: pointer;
    background: rgba(51, 65, 85, 0.6); color: #cbd5e1;
    border: 1px solid rgba(148, 163, 184, 0.24); border-radius: 8px;
    font-family: inherit; font-size: 12px;
  }
  .bp-modal .bp-btn:hover { background: rgba(71, 85, 105, 0.8); color: #f1f5f9; }
  .bp-modal .bp-btn-primary { background: #2563eb; border-color: #3b82f6; color: #f8fafc; }
  .bp-modal .bp-btn-primary:hover { background: #1d4ed8; }
  `;
  document.head.appendChild(style);
}
