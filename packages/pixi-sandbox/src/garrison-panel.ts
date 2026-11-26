import { appStore } from './store';
import { createUnplacedBattleDeployment } from './battle-orbat';
import type {
  BadgeCultureStyle,
  CustomBadgeConfig,
  BattleUnit,
  BattleEvidence,
  BattleDeployment,
  BattleSource,
} from './battle-contract';
import type { UnitEditTarget, UnitEditBatch } from './field-battle-types';
import { createMapUnitEditTarget } from './map-unit-edit-target';
import {
  resolveTroopEchelon,
  getEchelonSymbol,
  renderUnitSymbolToContext,
} from './military-symbols';

export interface GarrisonCustomModalOptions {
  target: UnitEditTarget;
  unitId?: string;
  onSaved?: (unit: BattleUnit) => void;
  onClose?: () => void;
}

/**
 * 弹出兵牌生成与自定义弹窗
 * 支持 8 档人数联动推导、文化底板切换、需求特征关键词识别、自定义中心字/图标
 */
function ensureModalStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'garrison-custom-modal-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    #garrison-custom-modal {
      position: fixed;
      inset: 0;
      z-index: 1100;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(4, 7, 13, 0.75);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      animation: fb-modal-fade 0.15s ease-out;
    }
    @keyframes fb-modal-fade {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .gcm-box {
      max-height: 90vh;
      overflow-y: auto;
      width: min(540px, 94vw);
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.98) 0%, rgba(10, 15, 26, 0.99) 100%);
      color: #e2e8f0;
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 12px;
      padding: 22px;
      box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.85), 0 0 24px rgba(56, 189, 248, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.08);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
      box-sizing: border-box;
    }
    .gcm-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(56, 189, 248, 0.2);
      padding-bottom: 12px;
      margin-bottom: 16px;
      position: relative;
    }
    .gcm-title {
      margin: 0;
      font-size: 15px;
      color: #f8fafc;
      font-weight: 600;
      letter-spacing: 0.5px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .gcm-title-tag {
      font-size: 10px;
      font-weight: 700;
      color: #38bdf8;
      background: rgba(14, 165, 233, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .gcm-close-btn {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.2);
      color: #94a3b8;
      font-size: 14px;
      width: 26px;
      height: 26px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
    }
    .gcm-close-btn:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: rgba(239, 68, 68, 0.5);
      color: #fca5a5;
    }
    .gcm-field {
      display: flex;
      flex-direction: column;
      gap: 5px;
      margin-bottom: 12px;
    }
    .gcm-label {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      letter-spacing: 0.3px;
    }
    .gcm-input, .gcm-select {
      width: 100%;
      background: rgba(30, 41, 59, 0.7);
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 12px;
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .gcm-input:focus, .gcm-select:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.25);
    }
    .gcm-input::placeholder {
      color: #64748b;
    }
    .gcm-color-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .gcm-color-picker {
      -webkit-appearance: none;
      -moz-appearance: none;
      appearance: none;
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid rgba(148, 163, 184, 0.4);
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
      overflow: hidden;
      flex-shrink: 0;
    }
    .gcm-color-picker::-webkit-color-swatch-wrapper {
      padding: 0;
    }
    .gcm-color-picker::-webkit-color-swatch {
      border: none;
      border-radius: 5px;
    }
    .gcm-color-presets {
      display: flex;
      gap: 5px;
      align-items: center;
      flex-wrap: wrap;
    }
    .gcm-color-dot {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.35);
      cursor: pointer;
      padding: 0;
      transition: transform 0.15s, box-shadow 0.15s, outline 0.15s;
    }
    .gcm-color-dot:hover {
      transform: scale(1.15);
      box-shadow: 0 0 6px rgba(255, 255, 255, 0.6);
    }
    .gcm-color-dot.active {
      outline: 2px solid #38bdf8;
      outline-offset: 1px;
    }
    .gcm-card {
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 14px;
      background: rgba(15, 23, 42, 0.5);
    }
    .gcm-card-title {
      font-weight: 600;
      margin-bottom: 10px;
      color: #94a3b8;
      font-size: 11px;
      letter-spacing: 0.4px;
    }
    .gcm-preview-stage {
      display: flex;
      gap: 24px;
      align-items: center;
      justify-content: center;
      background: rgba(15, 23, 42, 0.85);
      padding: 14px;
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.15);
      background-image: radial-gradient(rgba(56, 189, 248, 0.12) 1px, transparent 1px);
      background-size: 12px 12px;
    }
    .gcm-canvas-wrap {
      text-align: center;
    }
    .gcm-canvas-label {
      font-size: 10px;
      color: #94a3b8;
      margin-bottom: 6px;
      letter-spacing: 0.3px;
    }
    .gcm-btn-cancel {
      background: rgba(51, 65, 85, 0.7);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 6px;
      padding: 7px 16px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: all 0.15s;
    }
    .gcm-btn-cancel:hover {
      background: rgba(71, 85, 105, 0.9);
      color: #ffffff;
    }
    .gcm-btn-save {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      color: white;
      border: 1px solid #38bdf8;
      border-radius: 6px;
      padding: 7px 20px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35);
      transition: all 0.15s;
    }
    .gcm-btn-save:hover {
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.5);
      transform: translateY(-1px);
    }
    .gcm-split-box {
      margin-top: 14px;
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 8px;
      padding: 12px 14px;
      background: rgba(15, 23, 42, 0.4);
    }
    .gcm-split-legend {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      padding: 0 6px;
    }
  `;
  document.head.appendChild(style);
}

export function openGarrisonCustomModal(options: GarrisonCustomModalOptions): HTMLElement {
  const target = options?.target ?? createMapUnitEditTarget();
  const existing = document.getElementById('garrison-custom-modal');
  if (existing) existing.remove();

  ensureModalStyles();

  const currentUnit = options?.unitId
    ? target.getUnits().find(u => u.id === options.unitId)
    : undefined;

  const modal = document.createElement('div');
  modal.id = 'garrison-custom-modal';

  const box = document.createElement('section');
  box.className = 'gcm-box';
  box.innerHTML = `
    <header class="gcm-header">
      <div class="gcm-title">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
        <span>兵牌生成与自定义设计器</span>
        <span class="gcm-title-tag">ORBAT</span>
      </div>
      <button id="modal-close-btn" class="gcm-close-btn" title="关闭">✕</button>
    </header>

    <div class="gcm-field">
      <label class="gcm-label" for="modal-name-input">单位名称（新建必填）</label>
      <input id="modal-name-input" class="gcm-input" type="text" placeholder="输入部队番号或名称">
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="gcm-field" style="margin-bottom:0;">
        <label class="gcm-label" for="modal-unit-select">目标部队</label>
        <select id="modal-unit-select" class="gcm-select"></select>
      </div>
      <div class="gcm-field" style="margin-bottom:0;">
        <label class="gcm-label" for="modal-color-input">外框颜色 (阵营/识别色)</label>
        <div class="gcm-color-row">
          <input id="modal-color-input" class="gcm-color-picker" type="color" value="#2563eb" title="点击自由选择外框颜色">
          <div id="modal-color-presets" class="gcm-color-presets">
            <button type="button" class="gcm-color-dot active" data-color="#2563eb" title="联邦蓝 (#2563eb)" style="background:#2563eb;"></button>
            <button type="button" class="gcm-color-dot" data-color="#dc2626" title="帝国红 (#dc2626)" style="background:#dc2626;"></button>
            <button type="button" class="gcm-color-dot" data-color="#16a34a" title="卫戍绿 (#16a34a)" style="background:#16a34a;"></button>
            <button type="button" class="gcm-color-dot" data-color="#d97706" title="近卫金 (#d97706)" style="background:#d97706;"></button>
            <button type="button" class="gcm-color-dot" data-color="#9333ea" title="王室紫 (#9333ea)" style="background:#9333ea;"></button>
            <button type="button" class="gcm-color-dot" data-color="#64748b" title="中立灰 (#64748b)" style="background:#64748b;"></button>
            <button type="button" class="gcm-color-dot" data-color="#0284c7" title="天蓝 (#0284c7)" style="background:#0284c7;"></button>
            <button type="button" class="gcm-color-dot" data-color="#334155" title="夜幕黑 (#334155)" style="background:#334155;"></button>
          </div>
        </div>
        <select id="modal-culture-select" class="gcm-select" style="display:none">
          <option value="universal">通用分档</option>
          <option value="nato">北约标准</option>
          <option value="huaxia">华夏旌旗</option>
          <option value="western">西式纹章</option>
          <option value="nomad">草原狼纛</option>
          <option value="arcane">奇幻奥术</option>
          <option value="custom">自由定制</option>
        </select>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="gcm-field" style="margin-bottom:0;">
        <label class="gcm-label" for="modal-troops-input">兵力人数 (实时联动编制)</label>
        <input id="modal-troops-input" class="gcm-input" type="number" min="0" step="1" placeholder="部队总人数">
      </div>
      <div class="gcm-field" style="margin-bottom:0;">
        <label class="gcm-label" for="modal-echelon-input">编制名称 (自动/手动)</label>
        <div style="display:flex;gap:6px;">
          <input id="modal-echelon-input" class="gcm-input" type="text" placeholder="连/营/团/师/军/集团军" style="flex:1;">
          <button id="modal-auto-echelon-btn" title="根据人数一键自动对齐 7 档编制" style="background:#0e7490;color:white;border:1px solid #38bdf8;border-radius:6px;padding:0 10px;cursor:pointer;font-size:11px;white-space:nowrap;">自动对齐</button>
        </div>
      </div>
    </div>

    <div id="modal-echelon-preview-badge" style="background:rgba(14, 165, 233, 0.08);border:1px solid rgba(56, 189, 248, 0.3);border-radius:6px;padding:8px 12px;margin-bottom:14px;color:#7dd3fc;font-size:12px;line-height:1.4;"></div>

    <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:12px;margin-bottom:12px;">
      <div class="gcm-field" style="margin-bottom:0;">
        <label class="gcm-label" for="modal-text-color-input">兵牌字体颜色</label>
        <div class="gcm-color-row">
          <input id="modal-text-color-input" class="gcm-color-picker" type="color" value="#f8fafc" title="点击自由选择兵牌字体颜色">
          <div id="modal-text-color-presets" class="gcm-color-presets">
            <button type="button" class="gcm-color-dot active" data-text-color="#f8fafc" title="雪白 (#f8fafc)" style="background:#f8fafc;"></button>
            <button type="button" class="gcm-color-dot" data-text-color="#fde047" title="鎏金 (#fde047)" style="background:#fde047;"></button>
            <button type="button" class="gcm-color-dot" data-text-color="#7dd3fc" title="冰青 (#7dd3fc)" style="background:#7dd3fc;"></button>
            <button type="button" class="gcm-color-dot" data-text-color="#fdba74" title="琥珀 (#fdba74)" style="background:#fdba74;"></button>
            <button type="button" class="gcm-color-dot" data-text-color="#86efac" title="翠绿 (#86efac)" style="background:#86efac;"></button>
            <button type="button" class="gcm-color-dot" data-text-color="#fca5a5" title="绯红 (#fca5a5)" style="background:#fca5a5;"></button>
          </div>
        </div>
      </div>
      <div class="gcm-field" style="margin-bottom:0;">
        <label class="gcm-label" for="modal-glyph-input">中心大字/自定义符号 (可选)</label>
        <input id="modal-glyph-input" class="gcm-input" type="text" maxlength="4" placeholder="留空仅显军标，最多2汉字">
      </div>
    </div>

    <div class="gcm-field">
      <label class="gcm-label" for="modal-dataurl-input">自定义图标 DataURL (可选，data:image/ 开头)</label>
      <input id="modal-dataurl-input" class="gcm-input" type="text" placeholder="data:image/png;base64,..." style="font-size:11px;margin-bottom:6px;">
      <input id="modal-icon-file" type="file" accept="image/*" style="font-size:11px;color:#94a3b8;">
      <span style="font-size:11px;color:#64748b;margin-top:4px;">新建单位保存后放在当前视野中心，可随意拖动部署。</span>
    </div>

    <div class="gcm-card">
      <div class="gcm-card-title">实时兵牌沙盘预览 (标准 96×30 · 纯军标 34×34)</div>
      <div class="gcm-preview-stage">
        <div class="gcm-canvas-wrap">
          <div class="gcm-canvas-label">标准兵牌 (96×30)</div>
          <canvas id="preview-standard-canvas" width="96" height="30" style="border:1px solid rgba(56, 189, 248, 0.4);border-radius:3px;background:#0d131a;box-shadow:0 2px 6px rgba(0,0,0,0.5);"></canvas>
        </div>
        <div class="gcm-canvas-wrap">
          <div class="gcm-canvas-label">纯军标模式 (34×34)</div>
          <canvas id="preview-minimal-canvas" width="34" height="34" style="border:1px solid rgba(56, 189, 248, 0.4);border-radius:3px;background:#0d131a;box-shadow:0 2px 6px rgba(0,0,0,0.5);"></canvas>
        </div>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:10px;margin-bottom:12px;">
      <button id="modal-cancel-btn" class="gcm-btn-cancel">取消</button>
      <button id="modal-save-btn" class="gcm-btn-save">保存并应用到沙盘</button>
    </div>

    <fieldset class="gcm-split-box">
      <legend class="gcm-split-legend">拆分已保存部队</legend>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <label style="font-size:11px;color:#cbd5e1;">均分为 <input id="modal-split-count" class="gcm-input" type="number" min="2" step="1" value="3" style="width:54px;display:inline-block;padding:3px 6px;"> 支下属</label>
        <button id="modal-split-btn" type="button" class="gcm-btn-cancel" style="padding:4px 10px;font-size:11px;">拆分所选部队</button>
      </div>
      <div style="font-size:10px;color:#64748b;line-height:1.4;">原单位保留为上级，总兵力不变；下属从原位置部署，可逐个拖动。未保存的表单修改不参与拆分。</div>
      <div id="modal-split-status" role="status" style="color:#fbbf24;font-size:11px;margin-top:4px;"></div>
    </fieldset>
  `;

  modal.appendChild(box);
  document.body.appendChild(modal);

  // 控件引用
  const unitSelect = box.querySelector<HTMLSelectElement>('#modal-unit-select')!;
  const nameInput = box.querySelector<HTMLInputElement>('#modal-name-input')!;
  const cultureSelect = box.querySelector<HTMLSelectElement>('#modal-culture-select')!;
  const colorInput = box.querySelector<HTMLInputElement>('#modal-color-input')!;
  const presetsContainer = box.querySelector<HTMLElement>('#modal-color-presets');
  const troopsInput = box.querySelector<HTMLInputElement>('#modal-troops-input')!;
  const echelonInput = box.querySelector<HTMLInputElement>('#modal-echelon-input')!;
  const autoEchelonBtn = box.querySelector<HTMLButtonElement>('#modal-auto-echelon-btn')!;
  const textColorInput = box.querySelector<HTMLInputElement>('#modal-text-color-input')!;
  const textColorPresets = box.querySelector<HTMLElement>('#modal-text-color-presets');
  const glyphInput = box.querySelector<HTMLInputElement>('#modal-glyph-input')!;
  const dataUrlInput = box.querySelector<HTMLInputElement>('#modal-dataurl-input')!;
  const previewBadge = box.querySelector<HTMLElement>('#modal-echelon-preview-badge')!;
  const standardCanvas = box.querySelector<HTMLCanvasElement>('#preview-standard-canvas')!;
  const minimalCanvas = box.querySelector<HTMLCanvasElement>('#preview-minimal-canvas')!;

  function selectColor(hex: string): void {
    if (!hex) return;
    colorInput.value = hex;
    if (presetsContainer && typeof presetsContainer.querySelectorAll === 'function') {
      presetsContainer.querySelectorAll<HTMLButtonElement>('.gcm-color-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.color?.toLowerCase() === hex.toLowerCase());
      });
    }
    updatePreview();
  }

  function selectTextColor(hex: string): void {
    if (!hex) return;
    textColorInput.value = hex;
    if (textColorPresets && typeof textColorPresets.querySelectorAll === 'function') {
      textColorPresets.querySelectorAll<HTMLButtonElement>('.gcm-color-dot').forEach(dot => {
        dot.classList.toggle('active', dot.dataset.textColor?.toLowerCase() === hex.toLowerCase());
      });
    }
    updatePreview();
  }

  // 填充部队列表
  unitSelect.append(new Option('新建部队（放在视野中心）', ''));
  for (const u of target.getUnits()) {
    const name = u.unitName.state === 'known' ? u.unitName.value : '未知部队';
    unitSelect.append(new Option(`${name} (${u.id})`, u.id));
  }

  if (currentUnit) {
    unitSelect.value = currentUnit.id;
  }

  function loadUnitData(unitId: string): void {
    const unit = target.getUnits().find(u => u.id === unitId);
    nameInput.value = unit?.unitName.state === 'known' ? unit.unitName.value : '';
    troopsInput.value = unit?.personnel.count.state === 'known' ? String(unit.personnel.count.value) : '';
    echelonInput.value = unit?.echelon.state === 'known' ? unit.echelon.value : '';
    const unitColor = unit?.color || '#2563eb';
    selectColor(unitColor);

    const badge = unit?.customBadge;
    cultureSelect.value = badge?.culture ?? 'universal';
    selectTextColor(badge?.textColor ?? '#f8fafc');
    glyphInput.value = badge?.customGlyph ?? '';
    dataUrlInput.value = badge?.customIconDataUrl ?? '';

    updatePreview();
  }

  function updatePreview(): void {
    const selectedUnit = target.getUnits().find(u => u.id === unitSelect.value);
    const branch = selectedUnit?.branch.state === 'known' ? selectedUnit.branch.value : undefined;
    const troopsVal = troopsInput.value.trim() === '' ? null : Number(troopsInput.value);
    const tier = resolveTroopEchelon(troopsVal);
    const sym = getEchelonSymbol(echelonInput.value.trim(), troopsVal);

    previewBadge.textContent = `人数分档：${tier.bracketLabel} ｜ 7档军标：[${sym}] ｜ 编制：${tier.echelonName} (Tier ${tier.tierIndex})`;

    const unitColor = colorInput.value || selectedUnit?.color || '#2563eb';
    const unitName = (nameInput.value.trim() || (selectedUnit?.unitName.state === 'known' ? selectedUnit.unitName.value : '示范部队'));
    const chosenTextColor = textColorInput.value.trim() || '#f8fafc';

    const customBadge: CustomBadgeConfig = {
      culture: cultureSelect.value as BadgeCultureStyle,
      customGlyph: glyphInput.value.trim() || undefined,
      customIconDataUrl: dataUrlInput.value.trim() || undefined,
      textColor: chosenTextColor,
    };

    // 渲染标准兵牌 Canvas (96x30)
    const stdCtx = standardCanvas.getContext('2d');
    if (stdCtx) {
      renderUnitSymbolToContext(stdCtx, {
        width: 96,
        height: 30,
        troops: troopsVal,
        echelon: echelonInput.value.trim() || sym,
        branch,
        unitName,
        color: unitColor,
        customBadge,
        isMinimal: false,
      });
    }

    // 渲染纯军标 Canvas (34x34)
    const minCtx = minimalCanvas.getContext('2d');
    if (minCtx) {
      renderUnitSymbolToContext(minCtx, {
        width: 34,
        height: 34,
        troops: troopsVal,
        echelon: echelonInput.value.trim() || sym,
        branch,
        unitName,
        color: unitColor,
        customBadge,
        isMinimal: true,
      });
    }
    const url = dataUrlInput.value.trim();
    if (url.startsWith('data:image/')) {
      const image = new Image();
      image.onload = () => {
        if (dataUrlInput.value.trim() !== url || !modal.isConnected) return;
        standardCanvas.getContext('2d')!.drawImage(image, 7, 13, 12, 12);
        minimalCanvas.getContext('2d')!.drawImage(image, 10, 12, 14, 14);
      };
      image.src = url;
    }
  }

  // 绑定事件
  unitSelect.onchange = () => loadUnitData(unitSelect.value);
  cultureSelect.onchange = updatePreview;
  colorInput.oninput = () => selectColor(colorInput.value);
  if (presetsContainer) {
    presetsContainer.onclick = event => {
      const target = (event.target as HTMLElement)?.closest?.('.gcm-color-dot') as HTMLButtonElement | null;
      if (target?.dataset?.color) selectColor(target.dataset.color);
    };
  }
  textColorInput.oninput = () => selectTextColor(textColorInput.value);
  if (textColorPresets) {
    textColorPresets.onclick = event => {
      const target = (event.target as HTMLElement)?.closest?.('.gcm-color-dot') as HTMLButtonElement | null;
      if (target?.dataset?.textColor) selectTextColor(target.dataset.textColor);
    };
  }
  nameInput.oninput = updatePreview;
  troopsInput.oninput = () => {
    const raw = troopsInput.value.trim();
    if (raw !== '') {
      const num = Number(raw);
      if (Number.isFinite(num) && num >= 0) {
        echelonInput.value = resolveTroopEchelon(num).echelonName;
      }
    }
    updatePreview();
  };
  echelonInput.oninput = updatePreview;
  glyphInput.oninput = updatePreview;
  dataUrlInput.oninput = updatePreview;
  box.querySelector<HTMLInputElement>('#modal-icon-file')!.onchange = event => {
    const file = (event.target as HTMLInputElement).files![0];
    if (!file) return; // 用户取消文件选择。
    const reader = new FileReader();
    reader.onload = () => { dataUrlInput.value = reader.result as string; updatePreview(); };
    reader.readAsDataURL(file);
  };

  autoEchelonBtn.onclick = () => {
    const troopsVal = troopsInput.value.trim() === '' ? null : Number(troopsInput.value);
    const tier = resolveTroopEchelon(troopsVal);
    echelonInput.value = tier.echelonName;
    updatePreview();
  };

  const closeModal = (): void => {
    appStore.off('theater:leaving', closeModal);
    appStore.off('map:loaded', closeModal);
    appStore.off('map:cleared', closeModal);
    modal.remove();
    options.onClose?.();
  };
  appStore.on('theater:leaving', closeModal);
  appStore.on('map:loaded', closeModal);
  appStore.on('map:cleared', closeModal);

  box.querySelector<HTMLButtonElement>('#modal-close-btn')!.onclick = closeModal;
  box.querySelector<HTMLButtonElement>('#modal-cancel-btn')!.onclick = closeModal;

  box.querySelector<HTMLButtonElement>('#modal-split-btn')!.onclick = () => {
    const status = box.querySelector<HTMLElement>('#modal-split-status')!;
    const unit = target.getUnits().find(u => u.id === unitSelect.value);
    if (!unit) { status.textContent = '请先保存新部队，再选择它进行拆分。'; return; }
    if (unit.personnel.count.state === 'unknown' || unit.personnel.scope === 'legacy-unspecified') {
      status.textContent = '人数或统计口径未明确，请先在编制详情中补充后再拆分。'; return;
    }
    if (target.getUnits().some(u => u.parentUnitId.state === 'known' && u.parentUnitId.value === unit.id)) {
      status.textContent = '该部队已有下属，请选择具体下属继续拆分，避免重复分配兵力。'; return;
    }
    const countInput = box.querySelector<HTMLInputElement>('#modal-split-count')!;
    if (typeof countInput.reportValidity === 'function' && !countInput.reportValidity()) return;
    const parts = Number(countInput.value);
    const total = unit.personnel.count.value;
    if (!Number.isInteger(parts) || parts < 2 || parts > total) {
      status.textContent = '拆分份数须为至少 2 的整数，且每支下属至少 1 人。'; return;
    }
    const name = unit.unitName.state === 'known' ? unit.unitName.value : unit.id;
    const source: BattleSource = { id: crypto.randomUUID(), kind: 'manual',
      title: `拆分 ${name}`, text: `玩家将 ${name} 的 ${total} 人均分为 ${parts} 支下属；原单位保留为上级，总数不变，位置沿用原部署。`,
      locator: '兵牌设计器/拆分部队' };
    const evidence: BattleEvidence[] = [{ sourceId: source.id, basis: 'assumption', excerpt: source.text, note: source.title }];
    const parent = structuredClone(unit);
    parent.assertion = 'plan';
    parent.personnel = { scope: 'inclusive', count: { state: 'known', value: total, evidence } };
    parent.childrenCompleteness = { state: 'known', value: 'complete', evidence };
    const originalDeployment = target.getDeployments().find(d => d.unitId === unit.id);
    const children: BattleUnit[] = [];
    const deployments: BattleDeployment[] = [];
    for (let i = 0; i < parts; i++) {
      const child = structuredClone(unit);
      child.id = crypto.randomUUID();
      child.assertion = 'plan';
      child.unitName = { state: 'known', value: `${name}·${i + 1}部`, evidence };
      child.parentUnitId = { state: 'known', value: unit.id, evidence };
      const troops = Math.floor(total / parts) + (i < total % parts ? 1 : 0);
      child.personnel = { scope: 'own', count: { state: 'known', value: troops, evidence } };
      child.echelon = { state: 'known', value: resolveTroopEchelon(troops).echelonName, evidence };
      child.childrenCompleteness = { state: 'known', value: 'complete', evidence };
      children.push(child);
      const deployment = createUnplacedBattleDeployment(child.id, 'plan', evidence, '原部队位置未知');
      if (originalDeployment) {
        deployment.battlefieldId = structuredClone(originalDeployment.battlefieldId);
        deployment.placement = originalDeployment.placement.state === 'known'
          ? { state: 'known', value: { anchor: [...originalDeployment.placement.value.anchor], shape: { kind: 'point' } }, evidence }
          : structuredClone(originalDeployment.placement);
        deployment.facingDegrees = structuredClone(originalDeployment.facingDegrees);
      }
      deployments.push(deployment);
    }
    try {
      target.commit({ units: { upsert: [parent, ...children], remove: [] },
        deployments: { upsert: deployments, removeByUnitId: [] }, sources: { upsert: [source] } });
    } catch (error) {
      status.textContent = `拆分失败：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    options.onSaved?.(parent);
    closeModal();
  };

  const notify = (msg: string): void => {
    if (typeof alert === 'function') alert(msg);
  };

  box.querySelector<HTMLButtonElement>('#modal-save-btn')!.onclick = async () => {
    const unit = target.getUnits().find(u => u.id === unitSelect.value);
    if (!unit && nameInput.value.trim() === '') { notify('新建部队请填写名称'); return; }
    if (typeof troopsInput.reportValidity === 'function' && !troopsInput.reportValidity()) return;
    const glyph = glyphInput.value.trim();
    if (Array.from(glyph).length > (/^[\x00-\x7f]*$/.test(glyph) ? 4 : 2)) {
      notify('中心字最多 2 个非 ASCII 字符或 4 个 ASCII 字符'); return;
    }

    const dataUrl = dataUrlInput.value.trim();
    if (dataUrl && !dataUrl.startsWith('data:image/')) {
      notify('自定义图标 DataURL 必须以 data:image/ 开头');
      return;
    }
    const chosenColor = colorInput.value.trim() || '#2563eb';
    const unknown = { state: 'unknown' as const, reason: '玩家未填写', evidence: [] };
    const updatedUnit: BattleUnit = unit ? structuredClone(unit) : {
      id: crypto.randomUUID(), color: chosenColor, assertion: 'plan',
      unitName: unknown, parentUnitId: unknown, provinceId: unknown, status: unknown,
      echelon: unknown, branch: unknown, side: unknown, childrenCompleteness: unknown,
      personnel: { scope: 'own', count: unknown },
    };
    updatedUnit.color = chosenColor;
    const chosenTextColor = textColorInput.value.trim();
    const customBadge: CustomBadgeConfig = {
      culture: cultureSelect.value as BadgeCultureStyle,
      customGlyph: glyphInput.value.trim() || undefined,
      customIconDataUrl: dataUrl || undefined,
      textColor: /^#[0-9a-f]{6}$/i.test(chosenTextColor) ? chosenTextColor : undefined,
    };
    updatedUnit.customBadge = customBadge;

    const label = `更新部队 [${updatedUnit.unitName.state === 'known' ? updatedUnit.unitName.value : updatedUnit.id}] 兵牌与编制`;
    const source: BattleSource = {
      id: crypto.randomUUID(),
      kind: 'manual',
      title: label,
      text: `玩家通过兵牌生成设计器自定义部队样式：外框颜色=${updatedUnit.color}，字体颜色=${customBadge.textColor ?? '默认'}`,
      locator: '兵牌设计器',
    };
    const evidence: BattleEvidence[] = [{
      sourceId: source.id,
      basis: 'assumption',
      excerpt: source.text,
      note: label,
    }];
    const nextName = nameInput.value.trim();
    const prevName = unit?.unitName.state === 'known' ? unit.unitName.value : '';
    if (nextName !== '' && (!unit || nextName !== prevName)) {
      updatedUnit.unitName = { state: 'known', value: nextName, evidence };
    }

    const nextEchelon = echelonInput.value.trim();
    const prevEchelon = unit?.echelon.state === 'known' ? unit.echelon.value : '';
    if (nextEchelon !== '' && (!unit || nextEchelon !== prevEchelon)) {
      updatedUnit.echelon = {
        state: 'known',
        value: nextEchelon,
        evidence,
      };
    }

    const troopsVal = troopsInput.value.trim();
    if (troopsVal !== '') {
      const num = Number(troopsVal);
      const prevTroops = unit?.personnel.count.state === 'known' ? unit.personnel.count.value : null;
      if (Number.isFinite(num) && num >= 0 && (!unit || num !== prevTroops)) {
        updatedUnit.personnel = {
          count: {
            state: 'known',
            value: num,
            evidence,
          },
          scope: updatedUnit.personnel.scope,
        };
      }
    } else if (unit && unit.personnel.count.state === 'known') {
      updatedUnit.personnel = {
        count: {
          state: 'unknown',
          reason: '玩家在兵牌设计器清空人数',
          evidence,
        },
        scope: updatedUnit.personnel.scope,
      };
    }

    const newDeployments: BattleDeployment[] = [];
    if (!unit) {
      const deployment = createUnplacedBattleDeployment(updatedUnit.id, 'plan', evidence, '新建');
      const [cx, cy] = target.newUnitCenter();
      deployment.placement = { state: 'known', value: { anchor: [cx, cy], shape: { kind: 'point' } }, evidence };
      newDeployments.push(deployment);
    }

    const batch: UnitEditBatch = {
      units: {
        upsert: [updatedUnit],
        remove: [],
      },
      deployments: {
        upsert: newDeployments,
        removeByUnitId: [],
      },
      sources: {
        upsert: [source],
      },
    };

    if (dataUrl) {
      const image = new Image();
      image.src = dataUrl;
      try { await image.decode(); }
      catch (error) {
        if (!(error instanceof DOMException)) throw error;
        notify('图片无法解码，请重新选择有效的图片');
        return;
      }
      // 解码期间可能取消、重开设计器，或已有另一轮保存完成并关闭弹窗。
      if (!modal.isConnected) return;
    }

    try {
      target.commit(batch);
    } catch (error) {
      notify(`保存失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    options.onSaved?.(updatedUnit);
    closeModal();
  };

  // 初始化加载当前部队
  loadUnitData(unitSelect.value);

  return modal;
}

/**
 * 初始化驻军面板挂载条（在主界面提供快速进入兵牌设计器的按钮）
 */
export function initGarrisonPanel(root: HTMLElement): { openModal: typeof openGarrisonCustomModal } {
  let quickBtn = document.getElementById('btn-open-garrison-custom');
  if (!quickBtn) {
    quickBtn = document.createElement('button');
    quickBtn.id = 'btn-open-garrison-custom';
    quickBtn.textContent = '🎨 兵牌设计器';
    quickBtn.style.cssText = 'position:fixed;right:296px;top:40px;z-index:82;padding:6px 12px;background:#0284c7;color:white;border:1px solid #38bdf8;border-radius:6px;font-size:12px;cursor:pointer;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    quickBtn.onclick = () => openGarrisonCustomModal({ target: createMapUnitEditTarget() });
    root.appendChild(quickBtn);
  }
  return { openModal: openGarrisonCustomModal };
}
