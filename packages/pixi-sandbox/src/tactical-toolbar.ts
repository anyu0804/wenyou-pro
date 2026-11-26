import {
  appStore,
  type InteractionMode,
  type TacticalItem,
} from './store';
import {
  canUndoTactical,
  clearTacticalItems,
  computeKmPerPixel,
  deleteSelectedTactical,
  getLastMeasureSummary,
  pushTacticalSnapshot,
  subscribeMeasureUpdate,
  undoTactical,
} from './tactical-drawer';
import {
  enterFieldBattlePaint,
  exitFieldBattlePaint,
  getSelectedCellCount,
  initFieldBattlePaint,
} from './field-battle-paint';
import { FIELD_BATTLE_DOM } from './field-battle-types';
import { setInputOwner } from './input-owner';

const PANEL_ID = 'tactical-toolbar-panel';
const STYLE_ID = 'tactical-toolbar-style';

const PALETTE: { name: string; value: string }[] = [
  { name: '赤红', value: '#ef4444' },
  { name: '烈焰橙', value: '#f97316' },
  { name: '鎏金', value: '#eab308' },
  { name: '青碧', value: '#22d3ee' },
  { name: '苍穹蓝', value: '#3b82f6' },
  { name: '紫罗兰', value: '#a855f7' },
  { name: '雪白', value: '#f8fafc' },
  { name: '玄铁', value: '#334155' },
];

let panelEl: HTMLDivElement | null = null;
let widthEl: HTMLInputElement;
let widthValEl: HTMLSpanElement;
let labelEl: HTMLInputElement;
let frontOptsEl: HTMLDivElement;
let arrowOptsEl: HTMLDivElement;
let flipFrontEl: HTMLInputElement;
let flipArrowEl: HTMLInputElement;
let statusEl: HTMLDivElement;
let undoBtn: HTMLButtonElement;
let deleteBtn: HTMLButtonElement;
let clearBtn: HTMLButtonElement;
let scaleInputEl: HTMLInputElement;
let scaleReadoutEl: HTMLSpanElement;
let unsubscribeMeasure: (() => void) | null = null;
let modeBtns: HTMLButtonElement[] = [];
let toothBtns: HTMLButtonElement[] = [];
let arrowBtns: HTMLButtonElement[] = [];
let swatchBtns: HTMLButtonElement[] = [];
let pollTimer: number | undefined;
let lastSignature = '';
let lastSelectedId: string | null | undefined = undefined;

/**
 * 战术标绘工具栏（纯 DOM，浮在地图画布右侧）。
 * 所有控件直接读写 appStore；标绘层的重绘通过 store 事件与兜底轮询完成。
 */
export function initTacticalToolbar(rootEl: HTMLElement): void {
  ensureStyles();
  document.getElementById(PANEL_ID)?.remove();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.className = 'tac-panel';
  panel.addEventListener('pointerdown', () => setInputOwner('map'));
  panel.innerHTML = `
    <div class="tac-head">
      <div class="tac-title">战术标绘</div>
      <div class="tac-sub">左键手绘 · 右键 / 空格拖图 · Ctrl+Z 撤销</div>
    </div>

    <div class="tac-modes">
      <button type="button" class="tac-mode" data-mode="pan">✋ 漫游</button>
      <button type="button" class="tac-mode" data-mode="tactical-frontline">〰 手绘战线</button>
      <button type="button" class="tac-mode" data-mode="tactical-arrow">➤ 包抄箭头</button>
      <button type="button" class="tac-mode" data-mode="tactical-select">◈ 选择编辑</button>
      <button type="button" class="tac-mode" data-mode="tactical-measure">📏 测距尺</button>
      <button type="button" id="tactical-add-fieldbattle" class="tac-mode" data-mode="fieldbattle-paint">⚔ 涂选战场</button>
    </div>

    <div id="fieldbattle-paint-panel" class="tac-sec" style="display: none;">
      <div class="tac-sec-title">
        <span>战场涂选</span>
        <span class="tac-mini"><span id="fieldbattle-paint-count">0</span> 格已选</span>
      </div>
      <div style="margin-bottom: 8px;">
        <input id="fieldbattle-paint-name" class="tac-input" type="text" maxlength="32" placeholder="战场名称（留空默认）" />
      </div>
      <div class="tac-actions" style="margin-top: 8px;">
        <button type="button" id="fieldbattle-generate" class="primary" disabled>生成战场</button>
        <button type="button" id="fieldbattle-clear">清空</button>
        <button type="button" id="fieldbattle-cancel">取消</button>
      </div>
      <div class="tac-paint-tip">左键拖动连片涂选 · Alt+左键擦除 · 右键漫游</div>
    </div>

    <div class="tac-sec">
      <div class="tac-sec-title"><span>笔触</span><span class="tac-width-val" data-role="width-val">4</span></div>
      <div class="tac-swatches" data-role="swatches"></div>
      <input class="tac-range" data-role="width" type="range" min="1" max="20" step="1" value="4" />
      <input class="tac-input" data-role="label" type="text" maxlength="24" placeholder="标注文字，留空则不显示" />
    </div>

    <div class="tac-sec" data-role="frontline-opts">
      <div class="tac-sec-title"><span>战线样式</span><span class="tac-mini">齿朝一侧</span></div>
      <div class="tac-seg">
        <button type="button" data-tooth="sawtooth">锯齿</button>
        <button type="button" data-tooth="semicircle">半圆</button>
      </div>
      <label class="tac-check"><input type="checkbox" data-role="flip-frontline" /> 翻转齿向（另一侧）</label>
    </div>

    <div class="tac-sec" data-role="arrow-opts">
      <div class="tac-sec-title"><span>箭头样式</span><span class="tac-mini">弧形包抄</span></div>
      <div class="tac-seg tac-seg-3">
        <button type="button" data-arrow="solid">实心</button>
        <button type="button" data-arrow="dashed">虚线</button>
        <button type="button" data-arrow="double-retreat">双股后撤</button>
      </div>
      <label class="tac-check"><input type="checkbox" data-role="flip-arrow" /> 反向箭头</label>
    </div>

    <div class="tac-sec" data-role="scale-sec">
      <div class="tac-sec-title">
        <span>比例尺：全图宽 (km)</span>
        <span class="tac-mini" data-role="scale-readout">未设</span>
      </div>
      <input class="tac-input" data-role="map-width-km" type="number" min="0" step="any" placeholder="如 1200（留空按像素测距）" />
    </div>

    <div class="tac-actions">
      <button type="button" data-action="undo">撤销</button>
      <button type="button" data-action="delete">删除选中</button>
      <button type="button" data-action="clear" class="danger">清空</button>
    </div>

    <div class="tac-status" data-role="status"></div>
  `;
  rootEl.appendChild(panel);
  panelEl = panel;

  widthEl = get<HTMLInputElement>(panel, '[data-role="width"]');
  widthValEl = get<HTMLSpanElement>(panel, '[data-role="width-val"]');
  labelEl = get<HTMLInputElement>(panel, '[data-role="label"]');
  frontOptsEl = get<HTMLDivElement>(panel, '[data-role="frontline-opts"]');
  arrowOptsEl = get<HTMLDivElement>(panel, '[data-role="arrow-opts"]');
  flipFrontEl = get<HTMLInputElement>(panel, '[data-role="flip-frontline"]');
  flipArrowEl = get<HTMLInputElement>(panel, '[data-role="flip-arrow"]');
  statusEl = get<HTMLDivElement>(panel, '[data-role="status"]');
  undoBtn = get<HTMLButtonElement>(panel, '[data-action="undo"]');
  deleteBtn = get<HTMLButtonElement>(panel, '[data-action="delete"]');
  clearBtn = get<HTMLButtonElement>(panel, '[data-action="clear"]');
  scaleInputEl = get<HTMLInputElement>(panel, '[data-role="map-width-km"]');
  scaleReadoutEl = get<HTMLSpanElement>(panel, '[data-role="scale-readout"]');

  modeBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>('.tac-mode'));
  toothBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-tooth]'));
  arrowBtns = Array.from(panel.querySelectorAll<HTMLButtonElement>('[data-arrow]'));
  swatchBtns = [];

  buildSwatches(get<HTMLDivElement>(panel, '[data-role="swatches"]'));

  // ---------------------------------------------------------------------------
  // 控件事件
  // ---------------------------------------------------------------------------

  for (const btn of modeBtns) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode as InteractionMode;
      if (
        mode !== 'pan' &&
        mode !== 'tactical-frontline' &&
        mode !== 'tactical-arrow' &&
        mode !== 'tactical-measure' &&
        mode !== 'tactical-select' &&
        mode !== 'fieldbattle-paint'
      ) {
        return;
      }
      if (
        mode === 'tactical-frontline' ||
        mode === 'tactical-arrow' ||
        mode === 'tactical-measure' ||
        mode === 'fieldbattle-paint'
      ) {
        if (!appStore.mapData) {
          statusEl.textContent = mode === 'tactical-measure' ? '请先导入底图后再测距' : '请先导入 .map 底图后再标绘';
          return;
        }
        if (appStore.selectedTacticalId !== null) {
          appStore.selectedTacticalId = null;
          appStore.emit('tactical-selection-change', null);
        }
      }
      if (mode === 'fieldbattle-paint') {
        enterFieldBattlePaint();
      } else {
        if (appStore.interactionMode === 'fieldbattle-paint') {
          exitFieldBattlePaint();
        }
        appStore.interactionMode = mode;
        appStore.emit('tactical-mode-change', mode);
      }
      appStore.emit('brush:changed', mode);
      refreshUI();
    });
  }

  let inputSnapshotted = false;
  const resetInputSnapshot = () => {
    inputSnapshotted = false;
  };
  const snapshotBeforeEdit = () => {
    if (!inputSnapshotted) {
      pushTacticalSnapshot();
      inputSnapshotted = true;
    }
  };
  for (const el of [widthEl, labelEl]) {
    el.addEventListener('focus', resetInputSnapshot);
    el.addEventListener('blur', resetInputSnapshot);
    el.addEventListener('change', resetInputSnapshot);
  }

  widthEl.addEventListener('input', () => {
    const width = clamp(Number(widthEl.value) || 4, 1, 20);
    appStore.tacticalWidth = width;
    widthValEl.textContent = String(width);
    const item = getSelectedItem();
    if (item) {
      snapshotBeforeEdit();
      item.width = width;
      appStore.emit('tactical-change');
    }
  });

  labelEl.addEventListener('input', () => {
    const value = labelEl.value;
    appStore.tacticalLabel = value;
    const item = getSelectedItem();
    if (item) {
      snapshotBeforeEdit();
      item.label = value.trim() || undefined;
      appStore.emit('tactical-change');
    }
  });

  for (const btn of toothBtns) {
    btn.addEventListener('click', () => {
      const style = btn.dataset.tooth === 'semicircle' ? 'semicircle' : 'sawtooth';
      appStore.tacticalToothStyle = style;
      const item = getSelectedItem();
      if (item && item.type === 'frontline') {
        pushTacticalSnapshot();
        item.toothStyle = style;
        appStore.emit('tactical-change');
      }
      refreshUI();
    });
  }

  for (const btn of arrowBtns) {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.arrow;
      const style =
        raw === 'dashed' || raw === 'double-retreat' ? raw : 'solid';
      appStore.tacticalArrowStyle = style;
      const item = getSelectedItem();
      if (item && item.type === 'arrow') {
        pushTacticalSnapshot();
        item.arrowStyle = style;
        appStore.emit('tactical-change');
      }
      refreshUI();
    });
  }

  const onFlip = (checked: boolean, targetType: TacticalItem['type']) => {
    appStore.tacticalFlip = checked;
    const item = getSelectedItem();
    if (item && item.type === targetType) {
      pushTacticalSnapshot();
      item.flipSide = checked;
      appStore.emit('tactical-change');
    }
    refreshUI();
  };
  flipFrontEl.addEventListener('change', () => onFlip(flipFrontEl.checked, 'frontline'));
  flipArrowEl.addEventListener('change', () => onFlip(flipArrowEl.checked, 'arrow'));

  undoBtn.addEventListener('click', () => {
    undoTactical();
    refreshUI();
  });
  deleteBtn.addEventListener('click', () => {
    deleteSelectedTactical();
    refreshUI();
  });
  clearBtn.addEventListener('click', () => {
    if (!appStore.tacticalItems.length) return;
    const ok = window.confirm(
      '确定清空当前战区的全部战术标绘吗？此操作可用“撤销”恢复。'
    );
    if (!ok) return;
    clearTacticalItems();
    refreshUI();
  });

  scaleInputEl.addEventListener('input', () => {
    const mapData = appStore.mapData;
    if (!mapData) return;
    const trimmed = scaleInputEl.value.trim();
    const parsed = trimmed === '' ? NaN : Number(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) {
      const kmPerPixel = computeKmPerPixel(parsed, mapData.width);
      mapData.source.mapWidthKm = parsed;
      mapData.source.kmPerPixel = kmPerPixel;
      appStore.emit('scale:changed', kmPerPixel);
    } else {
      delete mapData.source.mapWidthKm;
      delete mapData.source.kmPerPixel;
      appStore.emit('scale:changed', undefined);
    }
    syncScaleInput();
    refreshUI();
  });

  // ---------------------------------------------------------------------------
  // store 同步
  // ---------------------------------------------------------------------------

  appStore.on('tactical-change', () => refreshUI());
  appStore.on('tactical-selection-change', () => {
    resetInputSnapshot();
    syncFromSelection();
    refreshUI();
  });
  appStore.on('tactical-history-change', () => refreshUI());
  appStore.on('tactical-mode-change', () => refreshUI());
  appStore.on('brush:changed', () => refreshUI());
  appStore.on('map:loaded', () => {
    syncScaleInput(true);
    refreshUI();
  });
  appStore.on('map:cleared', () => {
    syncScaleInput(true);
    refreshUI();
  });
  appStore.on('scale:changed', () => {
    syncScaleInput();
    refreshUI();
  });

  unsubscribeMeasure?.();
  unsubscribeMeasure = subscribeMeasureUpdate(() => {
    refreshUI();
  });

  if (pollTimer !== undefined) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    const selectedId = appStore.selectedTacticalId;
    const signature = [
      appStore.interactionMode,
      appStore.tacticalItems.length,
      selectedId,
      canUndoTactical(),
    ].join('|');
    if (signature === lastSignature) return;
    if (selectedId !== lastSelectedId) {
      lastSelectedId = selectedId;
      syncFromSelection();
    }
    lastSignature = signature;
    refreshUI();
  }, 500);

  const canvas = rootEl.querySelector('canvas') as HTMLCanvasElement | null;
  initFieldBattlePaint(rootEl, canvas);

  syncScaleInput(true);
  refreshUI();

  // ---------------------------------------------------------------------------
  // 内部函数
  // ---------------------------------------------------------------------------

  function syncScaleInput(force = false) {
    const mapData = appStore.mapData;
    if (!mapData) {
      if (force || document.activeElement !== scaleInputEl) scaleInputEl.value = '';
      scaleInputEl.disabled = true;
      scaleReadoutEl.textContent = '未设';
      return;
    }
    scaleInputEl.disabled = false;
    const widthKm = mapData.source.mapWidthKm;
    const kmPerPx =
      mapData.source.kmPerPixel ?? computeKmPerPixel(widthKm, mapData.width);
    if (force || document.activeElement !== scaleInputEl) {
      scaleInputEl.value =
        typeof widthKm === 'number' && Number.isFinite(widthKm) && widthKm > 0
          ? String(widthKm)
          : '';
    }
    scaleReadoutEl.textContent =
      typeof kmPerPx === 'number' && Number.isFinite(kmPerPx) && kmPerPx > 0
        ? `${kmPerPx.toFixed(2)} km/px`
        : '未设';
  }

  function buildSwatches(host: HTMLElement) {
    for (const color of PALETTE) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tac-swatch';
      btn.dataset.color = color.value;
      btn.title = color.name;
      btn.style.background = color.value;
      btn.addEventListener('click', () => {
        appStore.tacticalColor = color.value;
        const item = getSelectedItem();
        if (item) {
          pushTacticalSnapshot();
          item.color = color.value;
          appStore.emit('tactical-change');
        }
        refreshUI();
      });
      host.appendChild(btn);
      swatchBtns.push(btn);
    }
  }

  function getSelectedItem(): TacticalItem | undefined {
    const id = appStore.selectedTacticalId;
    if (!id) return undefined;
    return appStore.tacticalItems.find((item) => item.id === id);
  }

  function syncFromSelection() {
    const item = getSelectedItem();
    if (!item) return;
    appStore.tacticalColor = item.color || appStore.tacticalColor;
    appStore.tacticalWidth = clamp(Number(item.width) || 4, 1, 20);
    appStore.tacticalLabel = item.label || '';
    appStore.tacticalFlip = !!item.flipSide;
    if (item.type === 'frontline' && item.toothStyle) {
      appStore.tacticalToothStyle = item.toothStyle;
    }
    if (item.type === 'arrow' && item.arrowStyle) {
      appStore.tacticalArrowStyle = item.arrowStyle;
    }
  }

  function refreshUI() {
    if (!panelEl) return;
    const mode = appStore.interactionMode;
    const isPaint = mode === 'fieldbattle-paint';

    for (const btn of modeBtns) {
      if (isPaint) {
        btn.classList.toggle('active', btn.id === 'tactical-add-fieldbattle');
      } else {
        btn.classList.toggle('active', btn.dataset.mode === mode);
      }
    }

    const paintPanelEl = panelEl.querySelector<HTMLElement>(
      FIELD_BATTLE_DOM.paintPanel,
    );
    if (paintPanelEl) {
      paintPanelEl.style.display = isPaint ? '' : 'none';
    }
    const paintCountEl = panelEl.querySelector<HTMLElement>(
      FIELD_BATTLE_DOM.paintCount,
    );
    if (paintCountEl) {
      paintCountEl.textContent = String(getSelectedCellCount());
    }
    const generateBtn = panelEl.querySelector<HTMLButtonElement>(
      FIELD_BATTLE_DOM.generate,
    );
    if (generateBtn) {
      generateBtn.disabled = getSelectedCellCount() === 0;
    }

    const width = clamp(Number(appStore.tacticalWidth) || 4, 1, 20);
    if (document.activeElement !== widthEl) widthEl.value = String(width);
    widthValEl.textContent = String(Math.round(width));

    if (document.activeElement !== labelEl) {
      labelEl.value = appStore.tacticalLabel || '';
    }

    for (const btn of swatchBtns) {
      btn.classList.toggle('active', btn.dataset.color === appStore.tacticalColor);
    }

    for (const btn of toothBtns) {
      btn.classList.toggle(
        'active',
        (btn.dataset.tooth || 'sawtooth') === appStore.tacticalToothStyle
      );
    }
    for (const btn of arrowBtns) {
      btn.classList.toggle(
        'active',
        (btn.dataset.arrow || 'solid') === appStore.tacticalArrowStyle
      );
    }

    flipFrontEl.checked = !!appStore.tacticalFlip;
    flipArrowEl.checked = !!appStore.tacticalFlip;

    const selected = getSelectedItem();
    undoBtn.disabled = !canUndoTactical();
    deleteBtn.disabled = !selected;
    clearBtn.disabled = appStore.tacticalItems.length === 0;

    if (isPaint) {
      frontOptsEl.style.display = 'none';
      arrowOptsEl.style.display = 'none';
    } else {
      const showFront =
        mode === 'tactical-frontline' ||
        (mode === 'tactical-select' && selected?.type === 'frontline');
      const showArrow =
        mode === 'tactical-arrow' ||
        (mode === 'tactical-select' && selected?.type === 'arrow');
      frontOptsEl.style.display = showFront ? '' : 'none';
      arrowOptsEl.style.display = showArrow ? '' : 'none';

      const current = appStore.tacticalItems.length;
      if (mode === 'tactical-measure') {
        const measured = getLastMeasureSummary();
        statusEl.textContent = measured
          ? `测距结果：${measured} · 左键重测 / Shift 直线 / Esc 清除`
          : '测距尺：左键拖动测路线里程（按住 Shift 拉直线）';
      } else {
        let text = `当前战区 ${current} 条标绘`;
        if (selected) {
          const kind = selected.type === 'frontline' ? '战线' : '箭头';
          const name = (selected.label || '').trim();
          text += ` · 已选中${kind}${name ? `「${name}」` : ''}`;
        }
        statusEl.textContent = text;
      }
    }

    // 只管理 tactical-*、fieldbattle-paint 与 battle-select 光标；brush-* 归 map-renderer（brush:changed）管理
    const canvas = rootEl.querySelector('canvas') as HTMLElement | null;
    if (canvas) {
      if (
        mode === 'tactical-frontline' ||
        mode === 'tactical-arrow' ||
        mode === 'tactical-measure' ||
        mode === 'fieldbattle-paint'
      ) {
        canvas.style.cursor = 'crosshair';
      } else if (mode === 'tactical-select') {
        canvas.style.cursor = 'pointer';
      } else if (mode === 'battle-select') {
        canvas.style.cursor = 'default';
      } else if (mode === 'pan') {
        canvas.style.cursor = 'grab';
      }
    }
  }
}

function get<T extends Element>(host: ParentNode, selector: string): T {
  const el = host.querySelector(selector);
  if (!el) throw new Error(`[tactical-toolbar] 缺少元素: ${selector}`);
  return el as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .tac-panel {
      position: fixed;
      right: 14px;
      top: 76px;
      z-index: 80;
      width: 268px;
      max-height: calc(100vh - 156px);
      overflow-y: auto;
      padding: 14px 14px 12px;
      border-radius: 14px;
      background: linear-gradient(160deg, rgba(15, 23, 42, 0.96), rgba(9, 14, 24, 0.95));
      border: 1px solid rgba(148, 163, 184, 0.28);
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.48), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      color: #e2e8f0;
      font-family: "Microsoft YaHei", "PingFang SC", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      user-select: none;
    }
    .tac-panel * { box-sizing: border-box; }
    .tac-panel::-webkit-scrollbar { width: 5px; }
    .tac-panel::-webkit-scrollbar-track { background: transparent; }
    .tac-panel::-webkit-scrollbar-thumb {
      background: rgba(148, 163, 184, 0.3);
      border-radius: 3px;
    }
    .tac-head { padding-bottom: 2px; }
    .tac-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 3px;
      color: #f8fafc;
    }
    .tac-sub {
      margin-top: 4px;
      font-size: 10px;
      line-height: 1.5;
      color: #7c8ba1;
      letter-spacing: 0.2px;
    }
    .tac-modes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-top: 12px;
    }
    .tac-mode {
      height: 30px;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      background: rgba(30, 41, 59, 0.55);
      color: #cbd5e1;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.14s, border-color 0.14s, box-shadow 0.14s;
      white-space: nowrap;
    }
    .tac-mode:hover {
      background: rgba(51, 65, 85, 0.8);
      border-color: rgba(148, 163, 184, 0.48);
    }
    .tac-mode.active {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.96), rgba(185, 28, 28, 0.92));
      border-color: #f87171;
      color: #ffffff;
      box-shadow: 0 0 14px rgba(239, 68, 68, 0.34);
    }
    #tactical-add-fieldbattle.active {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.96), rgba(29, 78, 216, 0.92));
      border-color: #93c5fd;
      color: #ffffff;
      box-shadow: 0 0 14px rgba(59, 130, 246, 0.4);
    }
    #fieldbattle-paint-panel {
      background: rgba(14, 165, 233, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 8px;
      padding: 10px;
      margin-top: 10px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25), inset 0 0 12px rgba(56, 189, 248, 0.05);
    }
    #fieldbattle-paint-count {
      color: #38bdf8;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    #fieldbattle-paint-name:focus {
      border-color: rgba(56, 189, 248, 0.8) !important;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2) !important;
    }
    .tac-paint-tip {
      font-size: 10px;
      color: #94a3b8;
      margin-top: 6px;
      line-height: 1.4;
      text-align: center;
    }
    .tac-sec {
      margin-top: 11px;
      padding-top: 10px;
      border-top: 1px solid rgba(148, 163, 184, 0.13);
    }
    .tac-sec-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 7px;
      font-size: 10px;
      letter-spacing: 1.4px;
      color: #94a3b8;
    }
    .tac-mini {
      font-size: 9px;
      letter-spacing: 0.5px;
      color: #64748b;
    }
    .tac-width-val {
      color: #f8fafc;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
    .tac-swatches {
      display: grid;
      grid-template-columns: repeat(8, 24px);
      gap: 5px;
      margin-bottom: 9px;
    }
    .tac-swatch {
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 7px;
      border: 2px solid transparent;
      cursor: pointer;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.38);
      transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s;
    }
    .tac-swatch:hover { transform: translateY(-1px); }
    .tac-swatch.active {
      border-color: #f8fafc;
      box-shadow: 0 0 0 2px rgba(248, 250, 252, 0.18);
    }
    .tac-range {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 4px;
      margin: 3px 0 10px;
      border-radius: 2px;
      outline: none;
      background: linear-gradient(90deg, #ef4444, #f59e0b);
      cursor: pointer;
    }
    .tac-range::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: #f8fafc;
      border: 2px solid #ef4444;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
      cursor: pointer;
    }
    .tac-range::-moz-range-thumb {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #f8fafc;
      border: 2px solid #ef4444;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
      cursor: pointer;
    }
    .tac-input {
      width: 100%;
      height: 28px;
      padding: 0 9px;
      border-radius: 7px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(15, 23, 42, 0.72);
      color: #e2e8f0;
      font-size: 11px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.14s, box-shadow 0.14s;
    }
    .tac-input::placeholder { color: #64748b; }
    .tac-input:focus {
      border-color: rgba(239, 68, 68, 0.72);
      box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.14);
    }
    .tac-seg {
      display: flex;
      gap: 4px;
      padding: 3px;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.14);
      background: rgba(15, 23, 42, 0.62);
    }
    .tac-seg button {
      flex: 1;
      height: 26px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #94a3b8;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.14s, color 0.14s, box-shadow 0.14s;
      white-space: nowrap;
    }
    .tac-seg button:hover { color: #e2e8f0; }
    .tac-seg button.active {
      background: rgba(239, 68, 68, 0.22);
      color: #fecaca;
      box-shadow: inset 0 0 0 1px rgba(239, 68, 68, 0.45);
    }
    .tac-seg-3 button { font-size: 10px; }
    .tac-check {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-top: 8px;
      font-size: 11px;
      color: #cbd5e1;
      cursor: pointer;
    }
    .tac-check input {
      width: 13px;
      height: 13px;
      margin: 0;
      accent-color: #ef4444;
      cursor: pointer;
    }
    .tac-actions {
      display: grid;
      grid-template-columns: 1fr 1.2fr 1fr;
      gap: 6px;
      margin-top: 12px;
    }
    .tac-actions button {
      height: 30px;
      padding: 0;
      border-radius: 7px;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(30, 41, 59, 0.65);
      color: #cbd5e1;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.14s, opacity 0.14s;
    }
    .tac-actions button:hover:not(:disabled) { background: rgba(51, 65, 85, 0.88); }
    .tac-actions button:disabled { opacity: 0.34; cursor: not-allowed; }
    .tac-actions button.primary {
      background: linear-gradient(135deg, rgba(59, 130, 246, 0.95), rgba(37, 99, 235, 0.9));
      border-color: #60a5fa;
      color: #ffffff;
    }
    .tac-actions button.primary:hover:not(:disabled) {
      background: linear-gradient(135deg, rgba(96, 165, 250, 1), rgba(59, 130, 246, 0.95));
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.4);
    }
    .tac-actions button.danger {
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.3);
    }
    .tac-actions button.danger:hover:not(:disabled) {
      background: rgba(127, 29, 29, 0.35);
    }
    .tac-status {
      margin-top: 10px;
      font-size: 10px;
      line-height: 1.6;
      color: #7c8ba1;
      word-break: break-all;
    }
  `;
  document.head.appendChild(style);
}
