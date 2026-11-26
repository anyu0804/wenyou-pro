import { Graphics } from 'pixi.js';
import {
  appStore,
  recomputeBurgTiers,
  terrainContainer,
  type BurgItem,
  type MapData,
  type ProvinceItem,
  type StateItem,
} from './store';
import { cellAt } from './map-renderer';

/**
 * B 包独占：城市交互编辑器
 *
 * 仅在 `appStore.interactionMode === 'burg-edit'` 时接管左键：
 * - 命中城市：按下后可拖拽移位；未拖动则打开属性编辑弹窗。
 * - 命中空白陆地：打开新建城市弹窗。
 *
 * 所有实体修改统一走 `recomputeBurgTiers` + `entity:changed`，
 * 由地图刷新与当前战区保存链路消费。
 */

const LAND_LEVEL = 20;
const HIT_RADIUS_PX = 12;
const DRAG_THRESHOLD_PX = 5;

interface BurgPress {
  kind: 'burg';
  burg: BurgItem;
  pointerId: number;
  downClientX: number;
  downClientY: number;
  originX: number;
  originY: number;
  originCell: number;
  originState: number;
  originProvince: number;
  dragging: boolean;
}

interface EmptyPress {
  kind: 'empty';
  pointerId: number;
  downClientX: number;
  downClientY: number;
  mapX: number;
  mapY: number;
}

let initialized = false;
let canvasEl: HTMLCanvasElement | null = null;
let rootEl: HTMLElement | null = null;
let modalEl: HTMLDivElement | null = null;
let indicator: Graphics | null = null;
let indicatorVisible = false;
let indicatorX = 0;
let indicatorY = 0;
let indicatorColor = '#22d3ee';
let press: BurgPress | EmptyPress | null = null;

/** P0 在 `initBrushPanel` 之后调用本入口；地图尚未加载时仍先绑定事件，命中时再取 store。 */
export function initBurgEditor(canvas: HTMLCanvasElement, mountEl: HTMLElement): void {
  if (initialized) return;
  initialized = true;
  canvasEl = canvas;
  rootEl = mountEl;

  indicator = new Graphics();
  terrainContainer.addChild(indicator);

  injectStyles(mountEl.ownerDocument);
  canvas.addEventListener('pointerdown', onCanvasPointerDown);
  canvas.addEventListener('pointerleave', onCanvasPointerLeave);
  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', onWindowPointerUp);
  appStore.on('theater:leaving', () => {
    cancelPress();
    closeModal();
    hideIndicator();
  });
  appStore.on('map:loaded', () => {
    cancelPress();
    closeModal();
    hideIndicator();
  });
  window.addEventListener('pointercancel', onWindowPointerCancel);
  appStore.on('brush:changed', syncCursor);
  appStore.on('tactical-mode-change', syncCursor);
  appStore.on('viewport:zoom', drawIndicator);
  syncCursor();
}

function cancelPress(): void {
  if (press && canvasEl?.hasPointerCapture(press.pointerId)) {
    canvasEl.releasePointerCapture(press.pointerId);
  }
  press = null;
}

// --- 坐标与命中 -------------------------------------------------------------
const viewportScale = (): number => Math.max(0.01, terrainContainer.worldTransform.a);

function toMap(clientX: number, clientY: number): [number, number] {
  const rect = canvasEl!.getBoundingClientRect();
  return appStore.toMapCoords(clientX - rect.left, clientY - rect.top);
}

function burgAt(map: MapData, mapX: number, mapY: number): BurgItem | null {
  const limit = HIT_RADIUS_PX / viewportScale();
  let nearest: BurgItem | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const burg of map.burgs) {
    if (burg.removed) continue;
    const distance = Math.hypot(burg.x - mapX, burg.y - mapY);
    if (distance <= limit && distance < nearestDistance) {
      nearest = burg;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function isLand(map: MapData, cell: number): boolean {
  return cell >= 0 && map.cells.h[cell] >= LAND_LEVEL;
}

// --- 指针交互 ---------------------------------------------------------------
function onCanvasPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || appStore.interactionMode !== 'burg-edit' || modalEl) return;
  const map = appStore.mapData;
  if (!map) return;

  const [mapX, mapY] = toMap(event.clientX, event.clientY);
  const burg = burgAt(map, mapX, mapY);

  if (burg) {
    press = {
      kind: 'burg',
      burg,
      pointerId: event.pointerId,
      downClientX: event.clientX,
      downClientY: event.clientY,
      originX: burg.x,
      originY: burg.y,
      originCell: burg.cell,
      originState: burg.state,
      originProvince: burg.province,
      dragging: false,
    };
    canvasEl!.setPointerCapture(event.pointerId);
    appStore.selectedBurgId = burg.i;
    appStore.emit('selection:burg', burg.i);
    showIndicator(burg.x, burg.y, '#22d3ee');
  } else {
    press = {
      kind: 'empty',
      pointerId: event.pointerId,
      downClientX: event.clientX,
      downClientY: event.clientY,
      mapX,
      mapY,
    };
    appStore.selectedBurgId = null;
    appStore.emit('selection:burg', null);
    hideIndicator();
  }
  event.preventDefault();
}

function onWindowPointerMove(event: PointerEvent): void {
  if (!press || press.pointerId !== event.pointerId) {
    if (event.target === canvasEl && appStore.interactionMode === 'burg-edit' && !modalEl) {
      const map = appStore.mapData;
      if (!map) return;
      const [mapX, mapY] = toMap(event.clientX, event.clientY);
      canvasEl!.style.cursor = burgAt(map, mapX, mapY) ? 'grab' : 'crosshair';
    }
    return;
  }

  if (press.kind === 'empty') return;

  if (!press.dragging) {
    const moved = Math.hypot(event.clientX - press.downClientX, event.clientY - press.downClientY);
    if (moved < DRAG_THRESHOLD_PX) return;
    press.dragging = true;
    canvasEl!.style.cursor = 'grabbing';
  }

  const map = appStore.mapData!;
  const [mapX, mapY] = toMap(event.clientX, event.clientY);
  showIndicator(mapX, mapY, isLand(map, cellAt(mapX, mapY)) ? '#22d3ee' : '#ef4444');
}

function onWindowPointerUp(event: PointerEvent): void {
  if (!press || press.pointerId !== event.pointerId) return;
  const current = press;
  press = null;
  if (canvasEl?.hasPointerCapture(event.pointerId)) {
    canvasEl.releasePointerCapture(event.pointerId);
  }

  if (current.kind === 'burg') {
    if (current.dragging) {
      commitDrag(current, event);
    } else {
      openEditModal(current.burg);
    }
  } else {
    const moved = Math.hypot(event.clientX - current.downClientX, event.clientY - current.downClientY);
    if (moved < DRAG_THRESHOLD_PX) {
      const map = appStore.mapData!;
      const cell = cellAt(current.mapX, current.mapY);
      if (isLand(map, cell)) openCreateModal(current.mapX, current.mapY, cell);
    }
  }

  if (appStore.interactionMode === 'burg-edit' && !modalEl && canvasEl) {
    canvasEl.style.cursor = 'crosshair';
  }
}

function commitDrag(current: BurgPress, event: PointerEvent): void {
  const map = appStore.mapData!;
  const [mapX, mapY] = toMap(event.clientX, event.clientY);
  const cell = cellAt(mapX, mapY);

  if (!isLand(map, cell)) {
    current.burg.x = current.originX;
    current.burg.y = current.originY;
    showIndicator(current.originX, current.originY, '#22d3ee');
    return;
  }

  const newState = map.cells.state[cell];
  const newProvince = map.cells.province[cell];
  if (newState !== current.originState) {
    for (const state of map.states) {
      if (state.capital === current.burg.i) state.capital = 0;
    }
    current.burg.capital = 0;
    for (const prov of map.provinces) {
      if (prov.burg === current.burg.i) prov.burg = 0;
    }
  } else if (newProvince !== current.originProvince) {
    for (const prov of map.provinces) {
      if (prov.burg === current.burg.i) prov.burg = 0;
    }
  }

  current.burg.x = mapX;
  current.burg.y = mapY;
  current.burg.cell = cell;
  current.burg.state = newState;
  current.burg.province = newProvince;
  recomputeBurgTiers(map);
  appStore.selectedBurgId = current.burg.i;
  appStore.emit('selection:burg', current.burg.i);
  appStore.emit('entity:changed');
  showIndicator(mapX, mapY, '#22d3ee');
}

function onWindowPointerCancel(event: PointerEvent): void {
  if (!press || press.pointerId !== event.pointerId) return;
  const current = press;
  press = null;
  if (current.kind === 'burg' && current.dragging) {
    current.burg.x = current.originX;
    current.burg.y = current.originY;
    current.burg.cell = current.originCell;
    current.burg.state = current.originState;
    current.burg.province = current.originProvince;
  }
  hideIndicator();
}

function onCanvasPointerLeave(): void {
  if (!press && appStore.interactionMode === 'burg-edit' && !modalEl && canvasEl) {
    canvasEl.style.cursor = 'crosshair';
  }
}

function syncCursor(): void {
  if (appStore.interactionMode !== 'burg-edit') {
    cancelPress();
    hideIndicator();
    return;
  }
  canvasEl!.style.cursor = 'crosshair';
}

// --- 选中/拖拽指示环 --------------------------------------------------------
function showIndicator(x: number, y: number, color: string): void {
  indicatorX = x;
  indicatorY = y;
  indicatorColor = color;
  indicatorVisible = true;
  drawIndicator();
}

function hideIndicator(): void {
  indicatorVisible = false;
  indicator?.clear();
}

function drawIndicator(): void {
  const gfx = indicator!;
  gfx.clear();
  if (!indicatorVisible) return;
  const scale = viewportScale();
  gfx.circle(indicatorX, indicatorY, 9 / scale).stroke({ width: 2 / scale, color: indicatorColor, alpha: 0.95 });
  gfx.circle(indicatorX, indicatorY, 2.4 / scale).fill({ color: indicatorColor, alpha: 0.9 });
}

// --- 弹窗 ------------------------------------------------------------------
interface ModalSession {
  map: MapData;
  burg: BurgItem | null;
  burgId: number;
  mapX: number;
  mapY: number;
  cell: number;
}

function openEditModal(burg: BurgItem): void {
  const map = appStore.mapData!;
  showModal({ map, burg, burgId: burg.i, mapX: burg.x, mapY: burg.y, cell: burg.cell });
}

function openCreateModal(mapX: number, mapY: number, cell: number): void {
  const map = appStore.mapData!;
  const newId = map.burgs.reduce((max, burg) => Math.max(max, burg.i), 0) + 1;
  showModal({ map, burg: null, burgId: newId, mapX, mapY, cell });
}

function showModal(session: ModalSession): void {
  if (modalEl) return;
  const { map, burg, burgId, mapX, mapY, cell } = session;
  const isNew = burg === null;
  appStore.selectedBurgId = burgId;
  if (!isNew) appStore.emit('selection:burg', burgId);
  showIndicator(mapX, mapY, '#22d3ee');

  const overlay = document.createElement('div');
  overlay.id = 'wenyou-burg-editor-overlay';
  modalEl = overlay;

  const form = document.createElement('form');
  form.className = 'be-dialog';
  form.noValidate = false;

  const header = document.createElement('div');
  header.className = 'be-header';
  const title = document.createElement('div');
  title.className = 'be-title';
  title.textContent = isNew ? '新建城市' : '城市属性编辑';
  const subtitle = document.createElement('div');
  subtitle.className = 'be-subtitle';
  subtitle.textContent = isNew
    ? `待新建 · 地块 ${cell} · (${mapX.toFixed(1)}, ${mapY.toFixed(1)})`
    : `#${burg.i} · ${tierName(burg.tier)} · 地块 ${burg.cell} · (${burg.x.toFixed(1)}, ${burg.y.toFixed(1)})`;
  header.append(title, subtitle);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.required = true;
  nameInput.maxLength = 40;
  nameInput.value = isNew ? `新聚落 #${burgId}` : burg.name;
  nameInput.addEventListener('input', () => nameInput.setCustomValidity(''));

  const popInput = document.createElement('input');
  popInput.type = 'number';
  popInput.required = true;
  popInput.min = '0';
  popInput.step = 'any';
  popInput.value = isNew ? '1' : String(burg.population);

  const popHint = document.createElement('span');
  popHint.className = 'be-hint';
  const syncPopulationHint = () => {
    const population = Number(popInput.value);
    popHint.textContent = `≈ ${Math.round(population * 1000).toLocaleString('zh-CN')} 人（FMG 人口以千人计）`;
  };
  popInput.addEventListener('input', syncPopulationHint);
  syncPopulationHint();

  const stateSelect = document.createElement('select');
  fillStates(stateSelect, map, isNew ? map.cells.state[cell] : burg.state);

  const provinceSelect = document.createElement('select');
  const referencedProvince = isNew
    ? null
    : map.provinces.find(
        (province) => province.i === burg.province && !province.removed && province.state === burg.state
      ) ?? map.provinces.find(
        (province) => province.i > 0 && !province.removed && province.burg === burg.i && province.state === burg.state
      );
  const initialProvinceId = isNew
    ? map.cells.province[cell]
    : referencedProvince
      ? referencedProvince.i
      : burg.province;
  fillProvinces(provinceSelect, map, Number(stateSelect.value), initialProvinceId);

  const provinceCapital = buildCheckbox('设为所属省份首府', false);
  const nationalCapital = buildCheckbox('设为所属国家首都', false);
  const portCheck = buildCheckbox('⚓ 设为海港城市 (Port)', isNew ? false : burg.port > 0);

  const syncProvinceCapital = () => {
    const province = findProvince(map, Number(provinceSelect.value));
    provinceCapital.input.disabled = !province;
    provinceCapital.input.checked = Boolean(province && province.burg === burgId);
  };
  const syncNationalCapital = () => {
    const state = findState(map, Number(stateSelect.value));
    nationalCapital.input.disabled = !state;
    nationalCapital.input.checked = Boolean(state && state.capital === burgId);
  };

  syncProvinceCapital();
  syncNationalCapital();

  stateSelect.addEventListener('change', () => {
    fillProvinces(provinceSelect, map, Number(stateSelect.value), 0);
    syncProvinceCapital();
    syncNationalCapital();
  });
  provinceSelect.addEventListener('change', syncProvinceCapital);

  const nameField = buildField('城市名称', nameInput);
  const popField = buildField('人口（千人）', popInput, popHint);

  const row = document.createElement('div');
  row.className = 'be-row';
  row.append(
    buildField('所属国家', stateSelect),
    buildField('所属省份', provinceSelect)
  );

  const checks = document.createElement('div');
  checks.className = 'be-checks';
  checks.append(provinceCapital.row, nationalCapital.row, portCheck.row);

  const footer = document.createElement('div');
  footer.className = 'be-footer';

  if (!isNew) {
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'be-btn be-btn-danger';
    deleteButton.textContent = '🗑 删除此城市';
    deleteButton.addEventListener('click', () => deleteBurg(map, burg));
    footer.appendChild(deleteButton);
  }

  const spacer = document.createElement('span');
  spacer.className = 'be-spacer';
  footer.appendChild(spacer);

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'be-btn';
  cancelButton.textContent = '取消';
  cancelButton.addEventListener('click', closeModal);

  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'be-btn be-btn-primary';
  saveButton.textContent = isNew ? '确认新建' : '保存修改';

  footer.append(cancelButton, saveButton);
  form.append(header, nameField, popField, row, checks, footer);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.setCustomValidity('城市名称不能为空');
      nameInput.reportValidity();
      return;
    }
    nameInput.setCustomValidity('');
    saveBurg(session, {
      name,
      population: Number(popInput.value),
      stateId: Number(stateSelect.value),
      provinceId: Number(provinceSelect.value),
      provinceCapital: provinceCapital.input.checked,
      nationalCapital: nationalCapital.input.checked,
      port: portCheck.input.checked,
    });
  });

  overlay.appendChild(form);
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
    }
  });
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) closeModal();
  });

  rootEl!.appendChild(overlay);
  nameInput.focus();
  nameInput.select();
}

function closeModal(): void {
  if (!modalEl) return;
  modalEl.remove();
  modalEl = null;
  appStore.selectedBurgId = null;
  hideIndicator();
  if (appStore.interactionMode === 'burg-edit' && canvasEl) {
    canvasEl.style.cursor = 'crosshair';
  }
}

// --- 保存/删除 --------------------------------------------------------------
interface BurgFormValues {
  name: string;
  population: number;
  stateId: number;
  provinceId: number;
  provinceCapital: boolean;
  nationalCapital: boolean;
  port: boolean;
}

function saveBurg(session: ModalSession, values: BurgFormValues): void {
  const { map, burg, burgId, mapX, mapY, cell } = session;
  const state = findState(map, values.stateId);
  const province = findProvince(map, values.provinceId);

  const target: BurgItem = burg ?? {
    i: burgId,
    name: values.name,
    x: mapX,
    y: mapY,
    cell,
    state: values.stateId,
    province: values.provinceId,
    capital: 0,
    port: 0,
    tier: 'city',
    population: values.population,
    removed: false,
  };

  target.name = values.name;
  target.population = values.population;
  target.state = values.stateId;
  target.province = values.provinceId;
  target.port = values.port ? 1 : 0;

  if (!burg) map.burgs.push(target);

  if (values.provinceCapital && province) {
    for (const other of map.provinces) {
      if (other.burg === target.i && other.i !== province.i) other.burg = 0;
    }
    province.burg = target.i;
  } else {
    for (const other of map.provinces) {
      if (other.burg === target.i) other.burg = 0;
    }
  }

  if (values.nationalCapital && state) {
    for (const other of map.states) {
      if (other.capital === target.i && other.i !== state.i) other.capital = 0;
    }
    const previousCapitalId = state.capital;
    if (previousCapitalId !== undefined && previousCapitalId > 0 && previousCapitalId !== target.i) {
      const previous = map.burgs.find((item) => item.i === previousCapitalId);
      if (previous) previous.capital = 0;
    }
    state.capital = target.i;
    target.capital = 1;
  } else {
    for (const other of map.states) {
      if (other.capital === target.i) other.capital = 0;
    }
    target.capital = 0;
  }

  recomputeBurgTiers(map);
  closeModal();
  appStore.emit('entity:changed');
}

function deleteBurg(map: MapData, burg: BurgItem): void {
  for (const province of map.provinces) {
    if (province.burg === burg.i) province.burg = 0;
  }
  for (const state of map.states) {
    if (state.capital === burg.i) state.capital = 0;
  }
  burg.removed = true;
  recomputeBurgTiers(map);
  closeModal();
  appStore.emit('entity:changed');
}

// --- 表单辅助 --------------------------------------------------------------
function findState(map: MapData, stateId: number): StateItem | undefined {
  return map.states.find((state) => state.i > 0 && state.i === stateId && !state.removed);
}

function findProvince(map: MapData, provinceId: number): ProvinceItem | undefined {
  return map.provinces.find((province) => province.i > 0 && province.i === provinceId && !province.removed);
}

function tierName(tier: BurgItem['tier']): string {
  return tier === 'capital' ? '国家首都' : tier === 'provincial' ? '省首府' : '普通城市';
}

function appendOption(select: HTMLSelectElement, value: number, label: string): void {
  const option = document.createElement('option');
  option.value = String(value);
  option.textContent = label;
  select.appendChild(option);
}

function fillStates(select: HTMLSelectElement, map: MapData, selectedId: number): void {
  const states = map.states.filter((state) => state.i > 0 && !state.removed);
  select.innerHTML = '';
  appendOption(select, 0, '无国家 / 中立');
  for (const state of states) appendOption(select, state.i, `${state.i} · ${state.name}`);
  select.value = states.some((state) => state.i === selectedId) ? String(selectedId) : '0';
}

function fillProvinces(select: HTMLSelectElement, map: MapData, stateId: number, selectedId: number): void {
  const provinces = stateId > 0
    ? map.provinces.filter((province) => province.i > 0 && !province.removed && province.state === stateId)
    : [];
  select.innerHTML = '';
  appendOption(select, 0, '无省份');
  for (const province of provinces) appendOption(select, province.i, `${province.i} · ${province.name}`);
  select.value = provinces.some((province) => province.i === selectedId) ? String(selectedId) : '0';
  select.disabled = stateId === 0;
}

function buildField(text: string, control: HTMLElement, hint?: HTMLElement): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'be-field';
  const caption = document.createElement('span');
  caption.className = 'be-caption';
  caption.textContent = text;
  label.append(caption, control);
  if (hint) label.appendChild(hint);
  return label;
}

function buildCheckbox(text: string, checked: boolean): { row: HTMLLabelElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'be-check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const caption = document.createElement('span');
  caption.textContent = text;
  row.append(input, caption);
  return { row, input };
}

// --- 样式 ------------------------------------------------------------------
function injectStyles(doc: Document): void {
  if (doc.getElementById('wenyou-burg-editor-style')) return;
  const style = doc.createElement('style');
  style.id = 'wenyou-burg-editor-style';
  style.textContent = `
  #wenyou-burg-editor-overlay {
    position: fixed; inset: 0; z-index: 1000; display: flex;
    align-items: center; justify-content: center;
    background: rgba(2, 6, 23, 0.58); backdrop-filter: blur(3px);
  }
  #wenyou-burg-editor-overlay .be-dialog {
    width: 372px; padding: 18px 18px 14px;
    background: rgba(13, 19, 26, 0.97);
    border: 1px solid rgba(148, 163, 184, 0.32);
    border-radius: 14px; color: #e2e8f0;
    font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
    font-size: 12px; line-height: 1.45;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  }
  #wenyou-burg-editor-overlay .be-header { margin-bottom: 14px; }
  #wenyou-burg-editor-overlay .be-title { font-size: 15px; font-weight: 700; color: #f8fafc; letter-spacing: .5px; }
  #wenyou-burg-editor-overlay .be-subtitle { margin-top: 2px; font-size: 10px; color: #7f94ad; letter-spacing: .3px; }
  #wenyou-burg-editor-overlay .be-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
  #wenyou-burg-editor-overlay .be-caption { font-size: 10px; letter-spacing: 1px; text-transform: uppercase; color: #7f94ad; }
  #wenyou-burg-editor-overlay .be-row { display: flex; gap: 10px; }
  #wenyou-burg-editor-overlay .be-row .be-field { flex: 1; min-width: 0; }
  #wenyou-burg-editor-overlay input[type="text"],
  #wenyou-burg-editor-overlay input[type="number"],
  #wenyou-burg-editor-overlay select {
    width: 100%; padding: 6px 8px;
    background: rgba(30, 41, 59, 0.92); color: #e2e8f0;
    border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 7px;
    font-family: inherit; font-size: 12px; outline: none;
  }
  #wenyou-burg-editor-overlay input:focus,
  #wenyou-burg-editor-overlay select:focus { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, .22); }
  #wenyou-burg-editor-overlay select:disabled { opacity: .5; }
  #wenyou-burg-editor-overlay .be-hint { font-size: 10px; color: #64748b; }
  #wenyou-burg-editor-overlay .be-checks { display: flex; flex-direction: column; gap: 7px; margin: 4px 0 2px; padding: 10px 0 6px; border-top: 1px solid rgba(148, 163, 184, .16); }
  #wenyou-burg-editor-overlay .be-check { display: flex; align-items: center; gap: 7px; color: #a9b6c7; font-size: 11px; cursor: pointer; }
  #wenyou-burg-editor-overlay .be-check input { accent-color: #22c55e; width: 14px; height: 14px; }
  #wenyou-burg-editor-overlay .be-check input:disabled + span { opacity: .45; }
  #wenyou-burg-editor-overlay .be-footer { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  #wenyou-burg-editor-overlay .be-spacer { flex: 1; }
  #wenyou-burg-editor-overlay .be-btn {
    padding: 7px 12px; cursor: pointer;
    background: rgba(51, 65, 85, 0.6); color: #cbd5e1;
    border: 1px solid rgba(148, 163, 184, 0.26); border-radius: 8px;
    font-family: inherit; font-size: 12px; transition: all .12s ease;
  }
  #wenyou-burg-editor-overlay .be-btn:hover { background: rgba(71, 85, 105, 0.8); color: #f1f5f9; }
  #wenyou-burg-editor-overlay .be-btn-primary { background: #2563eb; border-color: #3b82f6; color: #f8fafc; }
  #wenyou-burg-editor-overlay .be-btn-primary:hover { background: #1d4ed8; }
  #wenyou-burg-editor-overlay .be-btn-danger { background: rgba(127, 29, 29, 0.4); border-color: rgba(248, 113, 113, 0.5); color: #fecaca; }
  #wenyou-burg-editor-overlay .be-btn-danger:hover { background: rgba(153, 27, 27, 0.6); }
  `;
  doc.head.appendChild(style);
}
