import { knownField, unknownField } from './battle-contract';
import { Container, Graphics } from 'pixi.js';
import { appStore, garrisonContainer } from './store';
import type { BattleDeployment, BattleEdit, BattleEvidence, BattleLine,
  BattleMultiPolygon, BattlePoint, Battlefield, BattleTerrainFeature } from './battle-contract';
import { applyBattleEdits, battleHistoryAvailability, getBattleWorkspace, redoBattleEdit,
  resetBattleHistory, undoBattleEdit } from './battle-actions';
import { BattleEditor, rotateDeployment, translateDeployment } from './battle-editor';
import { renderBattle } from './battle-layer';
import { initBattleOrbatEditor, type BattleOrbatEditorHandle } from './battle-orbat-editor';
import { calculateBattleDeployment } from './battle-deployment';
import { normalizeRing, pointInMultiPolygon } from './battle-geometry';
import { addTerrainFeature, updateTerrainFeature, removeTerrainFeature, setBattlefieldScale,
  setBattlefieldBoundary } from './battle-terrain-editor';
import { exportBattlePng } from './battle-export';
import { resolveTroopEchelon, getEchelonSymbol } from './military-symbols';
import { openGarrisonCustomModal } from './garrison-panel';
import { createMapUnitEditTarget } from './map-unit-edit-target';
import { isFieldBattleOwner, setInputOwner } from './input-owner';
import { syntheticWorkspace } from '../work-packages/BATTLE-1/P0/samples/river-valley';

type DrawPurpose = 'boundary' | 'terrain' | 'front' | 'placement' | 'calibration';

function ensureBattlePanelStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'battle-panel-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    #battle-panel {
      position: fixed;
      top: 110px;
      right: 14px;
      bottom: 20px;
      width: min(640px, 78vw);
      z-index: 120;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.96) 0%, rgba(10, 15, 26, 0.98) 100%);
      color: #e2e8f0;
      border: 1px solid rgba(56, 189, 248, 0.32);
      border-radius: 12px;
      box-shadow: 0 25px 60px -10px rgba(0, 0, 0, 0.85), 0 0 24px rgba(56, 189, 248, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      overflow-y: auto;
      padding: 16px 18px;
      font: 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
      box-sizing: border-box;
    }
    #battle-panel::-webkit-scrollbar {
      width: 6px;
    }
    #battle-panel::-webkit-scrollbar-track {
      background: rgba(15, 23, 42, 0.4);
    }
    #battle-panel::-webkit-scrollbar-thumb {
      background: rgba(56, 189, 248, 0.25);
      border-radius: 3px;
    }
    #battle-panel::-webkit-scrollbar-thumb:hover {
      background: rgba(56, 189, 248, 0.5);
    }

    /* 顶栏 */
    .bp-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(56, 189, 248, 0.2);
      padding-bottom: 10px;
      margin-bottom: 10px;
    }
    .bp-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .bp-title {
      font-size: 15px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: 0.5px;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .bp-title-tag {
      font-size: 10px;
      font-weight: 700;
      color: #38bdf8;
      background: rgba(14, 165, 233, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 4px;
      padding: 1px 6px;
    }
    .bp-header-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .bp-btn-icon {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid rgba(148, 163, 184, 0.25);
      color: #94a3b8;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      transition: all 0.15s;
    }
    .bp-btn-icon:hover:not(:disabled) {
      background: rgba(51, 65, 85, 0.9);
      color: #f8fafc;
      border-color: #38bdf8;
    }
    .bp-btn-icon:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .bp-btn-close {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.2);
      color: #94a3b8;
      font-size: 13px;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s;
    }
    .bp-btn-close:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: rgba(239, 68, 68, 0.5);
      color: #fca5a5;
    }

    /* 选项卡导航 */
    .bp-nav-tabs {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
      padding: 3px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.15);
      border-radius: 8px;
    }
    .bp-tab-btn {
      flex: 1;
      padding: 5px 12px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      color: #94a3b8;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-align: center;
      transition: all 0.15s;
    }
    .bp-tab-btn:hover {
      color: #f8fafc;
      background: rgba(30, 41, 59, 0.5);
    }
    .bp-tab-btn.active {
      background: linear-gradient(135deg, rgba(2, 132, 199, 0.35) 0%, rgba(14, 165, 233, 0.22) 100%);
      color: #38bdf8;
      border-color: rgba(56, 189, 248, 0.45);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    }
    .bp-tab-demo {
      flex: 0 0 auto;
      font-size: 11px;
      padding: 5px 10px;
      color: #cbd5e1;
      background: rgba(30, 41, 59, 0.4);
      border: 1px dashed rgba(148, 163, 184, 0.25);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .bp-tab-demo:hover {
      border-color: #38bdf8;
      color: #f8fafc;
    }

    /* 状态与交互提示 */
    .bp-tips-bar {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      background: rgba(14, 165, 233, 0.08);
      border: 1px solid rgba(56, 189, 248, 0.2);
      border-radius: 6px;
      padding: 7px 10px;
      font-size: 11px;
      color: #94a3b8;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .bp-tips-bar strong {
      color: #7dd3fc;
    }
    #battle-status {
      font-size: 11px;
      line-height: 1.4;
      color: #38bdf8;
      margin-bottom: 8px;
      padding: 0;
      transition: all 0.2s;
    }
    #battle-status:not(:empty) {
      padding: 6px 10px;
      background: rgba(14, 165, 233, 0.12);
      border-left: 3px solid #38bdf8;
      border-radius: 4px;
    }

    /* 模块卡片 */
    .bp-card {
      background: rgba(15, 23, 42, 0.45);
      border: 1px solid rgba(148, 163, 184, 0.16);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 10px;
      transition: border-color 0.15s;
    }
    .bp-card:hover {
      border-color: rgba(56, 189, 248, 0.25);
    }
    .bp-card-title {
      font-size: 11.5px;
      font-weight: 700;
      color: #7dd3fc;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: 0.3px;
    }

    /* 通用输入控件 */
    .bp-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 6px;
    }
    .bp-field-label {
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      letter-spacing: 0.2px;
    }
    .bp-input, .bp-select {
      background: rgba(30, 41, 59, 0.7);
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.25);
      border-radius: 6px;
      padding: 5px 8px;
      font-size: 11.5px;
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .bp-input:focus, .bp-select:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }
    .bp-input::placeholder {
      color: #64748b;
    }

    /* 按钮样式 */
    .bp-btn {
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      transition: all 0.15s;
      outline: none;
      box-sizing: border-box;
      white-space: nowrap;
    }
    .bp-btn-primary {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      color: #ffffff;
      border: 1px solid #38bdf8;
      box-shadow: 0 2px 5px rgba(2, 132, 199, 0.35);
      font-weight: 600;
    }
    .bp-btn-primary:hover {
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.5);
      transform: translateY(-1px);
    }
    .bp-btn-secondary {
      background: rgba(30, 41, 59, 0.75);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.28);
    }
    .bp-btn-secondary:hover {
      background: rgba(51, 65, 85, 0.9);
      color: #ffffff;
      border-color: rgba(148, 163, 184, 0.5);
    }
    .bp-btn-danger {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.35);
    }
    .bp-btn-danger:hover {
      background: rgba(239, 68, 68, 0.3);
      color: #ffffff;
      border-color: #ef4444;
    }

    /* 战役部队多选列表 */
    #battle-units {
      width: 100%;
      background: rgba(15, 23, 42, 0.75);
      color: #e2e8f0;
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 6px;
      padding: 4px;
      font-size: 11.5px;
      outline: none;
      box-sizing: border-box;
    }
    #battle-units option {
      padding: 4px 7px;
      border-radius: 4px;
      margin-bottom: 2px;
    }
    #battle-units option:checked {
      background: linear-gradient(90deg, #0284c7 0%, #0369a1 100%);
      color: #ffffff;
      font-weight: 600;
    }

    /* 浮动绘制控制条 */
    #battle-draw-controls {
      position: sticky;
      bottom: 0;
      background: linear-gradient(180deg, rgba(30, 58, 138, 0.95) 0%, rgba(15, 23, 42, 0.98) 100%);
      border: 1px solid #38bdf8;
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6), 0 0 12px rgba(56, 189, 248, 0.3);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #battle-draw-controls[hidden] {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
}

export function initBattlePanel(root: HTMLElement, canvas: HTMLCanvasElement, world: Container): void {
  const layer = new Container();
  layer.label = 'battle-runtime';
  layer.visible = false;
  const sketch = new Graphics();
  world.addChild(layer, sketch);

  ensureBattlePanelStyles();

  const entry = document.createElement('button');
  entry.id = 'battle-open';
  entry.textContent = '战役';
  entry.style.cssText = 'position:fixed;top:76px;left:282px;z-index:110;padding:8px 18px;background:linear-gradient(135deg,#0284c7 0%,#0369a1 100%);color:white;border:1px solid #38bdf8;border-radius:7px;cursor:pointer;font-weight:600;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
  const panel = document.createElement('section');
  panel.id = 'battle-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <header class="bp-header">
      <div class="bp-title-wrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"></polygon>
        </svg>
        <span class="bp-title">战役制图与战术标绘</span>
        <span class="bp-title-tag">HUD</span>
      </div>
      <div class="bp-header-actions">
        <button id="battle-undo" class="bp-btn-icon" title="撤销操作">↩ 撤销</button>
        <button id="battle-redo" class="bp-btn-icon" title="重做操作">↪ 重做</button>
        <button id="battle-close" class="bp-btn-close" title="收起战役面板">✕</button>
      </div>
    </header>

    <div class="bp-tips-bar">
      <span>💡</span>
      <div style="flex:1;">
        <div><strong>交互提示</strong>：地图点击选择部队，Shift 多选；拖动移动，Alt 旋转；中/右键漫游地图。</div>
        <div style="color:#64748b;font-size:10px;margin-top:2px;">拆分部队：选中部队 → 打开兵牌设计器 → 拆分已保存部队。</div>
      </div>
    </div>

    <div id="battle-status" role="status"></div>

    <div class="bp-nav-tabs">
      <button id="battle-tab-map" class="bp-tab-btn active">部署与地形</button>
      <button id="battle-tab-orbat" class="bp-tab-btn">编制与来源 (ORBAT)</button>
      <button id="battle-demo" class="bp-tab-demo" title="添加固定坐标的虚构示例，与现有部队无关，不会拆分部队">+ 虚构河谷示例</button>
    </div>

    <div id="battle-controls">
      <!-- 卡片 1: 战场与尺度 -->
      <div class="bp-card">
        <div class="bp-card-title">
          <span>📍 战场与空间尺度</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:8px;align-items:flex-end;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battlefield-select">当前战场</label>
            <select id="battlefield-select" class="bp-select"></select>
          </div>
          <button id="battle-export" class="bp-btn bp-btn-secondary" title="导出包含标定尺度与假设说明的战场高清 PNG">📸 导出战场 PNG</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:8px;align-items:flex-end;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battlefield-name">新战场名称</label>
            <input id="battlefield-name" class="bp-input" placeholder="输入战场名称">
          </div>
          <button id="battlefield-create" class="bp-btn bp-btn-primary">画新战场</button>
          <button id="battlefield-redraw" class="bp-btn bp-btn-secondary">重画边界</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-bottom:8px;align-items:flex-end;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-distance">已知距离 (米)</label>
            <input id="battle-distance" class="bp-input" type="number" min="0" placeholder="无资料则留空">
          </div>
          <button id="battle-calibrate" class="bp-btn bp-btn-secondary">选两点标定</button>
          <button id="battle-uncalibrate" class="bp-btn bp-btn-secondary">设为未校准</button>
        </div>
        <div id="battle-scale" style="font-size:11px;color:#7dd3fc;background:rgba(15,23,42,0.6);border:1px dashed rgba(56,189,248,0.25);border-radius:4px;padding:4px 8px;"></div>
      </div>

      <!-- 卡片 2: 方案与依据 -->
      <div class="bp-card">
        <div class="bp-card-title">
          <span>📜 作战方案与假设依据</span>
        </div>
        <div class="bp-field">
          <label class="bp-field-label" for="battle-note">来源或假设说明</label>
          <input id="battle-note" class="bp-input" placeholder="填写本次设置的依据或明确假设">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-basis">推导依据</label>
            <select id="battle-basis" class="bp-select">
              <option value="assumption">明确假设</option>
              <option value="quoted">原文记录</option>
              <option value="inference">推断</option>
            </select>
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-assertion">方案状态</label>
            <select id="battle-assertion" class="bp-select">
              <option value="plan">方案 (Plan)</option>
              <option value="reported">场景既有记录 (Reported)</option>
            </select>
          </div>
        </div>
      </div>

      <!-- 卡片 3: 战术地形 -->
      <div class="bp-card">
        <div class="bp-card-title">
          <span>🏔️ 战术地形标绘</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-feature">现有地形对象</label>
            <select id="battle-feature" class="bp-select"><option value="">新建对象</option></select>
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-feature-kind">地形类型</label>
            <select id="battle-feature-kind" class="bp-select">
              <option value="obstacle">部署障碍区</option>
              <option value="deployment-zone">允许部署区</option>
              <option value="passage-line">道路/通行线</option>
              <option value="bridge">桥</option>
              <option value="ford">渡口</option>
              <option value="pass">隘口</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:8px;margin-bottom:8px;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-feature-name">地形名称</label>
            <input id="battle-feature-name" class="bp-input" placeholder="输入地形标签">
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-obstacle">通行口关联障碍</label>
            <select id="battle-obstacle" class="bp-select"><option value="">无关联障碍</option></select>
          </div>
        </div>
        <div class="bp-field" style="margin-bottom:8px;">
          <label class="bp-field-label" for="battle-passage-width">通行口宽度 (地图单位，空白为未知)</label>
          <input id="battle-passage-width" class="bp-input" type="number" min="0" placeholder="通行口宽度">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="battle-feature-draw" class="bp-btn bp-btn-primary">在地图绘制/重画</button>
          <button id="battle-feature-remove" class="bp-btn bp-btn-danger">删除选中地形</button>
        </div>
      </div>

      <!-- 卡片 4: 部队部署与正面阵形 -->
      <div class="bp-card">
        <div class="bp-card-title">
          <span>⚔️ 部队部署与正面阵形</span>
        </div>
        <div class="bp-field">
          <label class="bp-field-label" for="battle-units">部队列表 (按住 Shift/Ctrl 多选)</label>
          <select id="battle-units" multiple size="5"></select>
        </div>
        <div style="margin-bottom:8px;">
          <button id="battle-place" class="bp-btn bp-btn-secondary" style="width:100%;">🎯 点击地图定位所选单个部队</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:8px;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-facing">朝向(0-360°)</label>
            <input id="battle-facing" class="bp-input" type="number" min="0" max="359.99" value="0">
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-frontage">正面宽度</label>
            <input id="battle-frontage" class="bp-input" type="number" min="0" value="60">
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-depth">纵深距离</label>
            <input id="battle-depth" class="bp-input" type="number" min="0" value="40">
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-line">梯队序号</label>
            <input id="battle-line" class="bp-input" type="number" min="1" step="1" value="1">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1.2fr 1.2fr;gap:6px;margin-bottom:8px;">
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-role">战术任务</label>
            <select id="battle-role" class="bp-select">
              <option value="line">战线</option>
              <option value="reserve">预备队</option>
            </select>
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-reserve">预备所属</label>
            <select id="battle-reserve" class="bp-select"><option value="">不专属某单位</option></select>
          </div>
          <div class="bp-field" style="margin-bottom:0;">
            <label class="bp-field-label" for="battle-zone">展开区域</label>
            <select id="battle-zone" class="bp-select"><option value="">当前战场边界</option></select>
          </div>
        </div>
        <div style="font-size:10.5px;color:#94a3b8;margin-bottom:8px;">正面与纵深为地图单位。布阵时沿所画正面线依次排列所选部队。</div>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <button id="battle-deploy" class="bp-btn bp-btn-primary" style="flex:1;">🚩 画正面并布阵</button>
          <button id="battle-rotate-left" class="bp-btn bp-btn-secondary" title="逆时针旋转 15 度">⟲ -15°</button>
          <button id="battle-rotate-right" class="bp-btn bp-btn-secondary" title="顺时针旋转 15 度">⟳ +15°</button>
        </div>

        <div id="battle-unit-badge-settings" style="background:rgba(15,23,42,0.6);border:1px solid rgba(56,189,248,0.2);border-radius:6px;padding:8px 10px;">
          <div style="font-weight:600;color:#38bdf8;font-size:11px;margin-bottom:3px;">兵牌分档与自定义 (v0.5.1)</div>
          <div id="battle-selected-echelon-info" style="color:#7dd3fc;margin-bottom:6px;font-size:11px;">未选中部队</div>
          <div style="display:flex;gap:6px;">
            <button id="battle-auto-echelon" type="button" class="bp-btn bp-btn-secondary" style="flex:1;font-size:11px;">按人数匹配编制</button>
            <button id="battle-open-custom-badge" type="button" class="bp-btn bp-btn-primary" style="flex:1;font-size:11px;">打开兵牌设计器</button>
          </div>
        </div>
      </div>

      <!-- 浮动绘制控制条 -->
      <div id="battle-draw-controls" hidden>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:14px;">✏️</span>
          <strong id="battle-draw-help" style="color:#f8fafc;font-size:12px;flex:1;"></strong>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button id="battle-draw-finish" class="bp-btn bp-btn-primary">✔ 完成绘制</button>
          <button id="battle-draw-cancel" class="bp-btn bp-btn-secondary">✕ 取消绘制</button>
        </div>
      </div>
    </div>
    <div id="battle-orbat-mount" hidden style="height:620px"></div>`;
  entry.addEventListener('pointerdown', () => setInputOwner('map'));
  panel.addEventListener('pointerdown', () => setInputOwner('map'));
  root.append(entry, panel);
  const el = <T extends HTMLElement>(id: string): T => panel.querySelector<T>(`#${id}`)!;
  const input = (id: string): HTMLInputElement => el<HTMLInputElement>(id);
  const select = (id: string): HTMLSelectElement => el<HTMLSelectElement>(id);
  const status = el('battle-status');
  const battlefieldSelect = select('battlefield-select');
  const unitSelect = select('battle-units');
  let viewScale = world.scale.x;
  let drawPurpose: DrawPurpose | null = null;
  let points: BattlePoint[] = [];
  let newBattlefield = false;
  let drag: { pointerId: number; start: BattlePoint; rotating: boolean; pivot: BattlePoint; angle: number } | null = null;
  const editor = new BattleEditor({
    getWorkspace: getBattleWorkspace,
    applyBatch: applyCanvasBatch,
    onRefresh: () => render(),
    onSelectionChange: ids => appStore.emit('selection:unit', ids.length > 0 ? ids[ids.length - 1] : null),
  });
  let orbat: BattleOrbatEditorHandle;
  const mountOrbat = (): void => {
    orbat = initBattleOrbatEditor(el('battle-orbat-mount'), {
      getWorkspace: getBattleWorkspace, applyBatch: batch => { applyBattleEdits(batch); },
      allocateUnitId: () => crypto.randomUUID(), allocateSourceId: () => crypto.randomUUID(),
      onSelectUnit: unitId => { editor.selectUnits(unitId === null ? [] : [unitId]); },
      onFocusSource: payload => appStore.emit('source:focus', payload),
    });
  };
  mountOrbat();

  /** 所有战役表单/画布回调共用一个 UI 错误出口，保留原错和堆栈。 */
  const run = (action: () => void | Promise<void>): void => {
    void Promise.resolve().then(action).catch(error => {
      console.error('[battle-panel] 用户操作失败', error);
      status.textContent = `操作失败：${String(error)}`;
    });
  };
  const button = (id: string, action: () => void | Promise<void>): void => {
    el<HTMLButtonElement>(id).addEventListener('click', () => run(action));
  };
  const numeric = (id: string, positive = true): number => {
    const raw = input(id).value.trim();
    const value = Number(raw);
    if (raw === '' || !Number.isFinite(value) || (positive && value <= 0)) throw new Error('请填写有效数值');
    return value;
  };
  const chosenBattlefield = (): Battlefield => {
    const bf = appStore.battle.battlefields.find(b => b.id === battlefieldSelect.value);
    if (!bf) throw new Error('请先选择或绘制战场');
    return bf;
  };
  const ensureBattleLayerActive = (mode: 'battle-select' | 'battle-draw' = 'battle-select'): void => {
    if (panel.hidden) return;
    const needLayerSync = !layer.visible || garrisonContainer.visible;
    const needModeSync = appStore.interactionMode !== mode;
    layer.visible = true;
    garrisonContainer.visible = false;
    if (needModeSync) {
      appStore.interactionMode = mode;
      appStore.emit('tactical-mode-change', mode);
      appStore.emit('brush:changed', mode);
    }
    if (needLayerSync) render();
  };
  const commit = (label: string, build: (evidence: BattleEvidence[]) => BattleEdit[]): void => {
    const note = input('battle-note').value.trim();
    if (note === '') throw new Error('请填写本次设置的来源或假设说明');
    const source = { id: crypto.randomUUID(), kind: 'manual' as const, title: label, text: note, locator: '战役制图' };
    const evidence: BattleEvidence[] = [{ sourceId: source.id,
      basis: select('battle-basis').value as BattleEvidence['basis'], excerpt: note, note: label }];
    ensureBattleLayerActive(drawPurpose !== null ? 'battle-draw' : 'battle-select');
    applyBattleEdits({ label, origin: 'manual', candidateItemIds: [],
      edits: [{ kind: 'upsert-source', source }, ...build(evidence)] });
    status.textContent = `已提交：${label}；可撤销`;
  };
  /** 拖动/旋转确实来自手工操作；仅替换被改位置/朝向的依据，不冒称原文精确坐标。 */
  function applyCanvasBatch(batch: import('./battle-contract').BattleEditBatch): void {
    const source = { id: crypto.randomUUID(), kind: 'manual' as const, title: batch.label,
      text: `用户在画布手工设置：${batch.label}；位置来自本次操作，不代表原文精确定位。`, locator: '战役画布' };
    const evidence: BattleEvidence[] = [{ sourceId: source.id, basis: 'assumption', excerpt: source.text, note: batch.label }];
    const edits = batch.edits.map(edit => {
      if (edit.kind !== 'set-deployment') return edit;
      const deployment = structuredClone(edit.deployment);
      const previous = appStore.battle.deployments.find(d => d.unitId === deployment.unitId)!;
      deployment.assertion = 'plan';
      if (deployment.placement.state === 'known') deployment.placement.evidence = evidence;
      if (deployment.facingDegrees.state === 'known' && previous.facingDegrees.state === 'known' &&
        deployment.facingDegrees.value !== previous.facingDegrees.value) deployment.facingDegrees.evidence = evidence;
      return { kind: 'set-deployment' as const, deployment };
    });
    applyBattleEdits({ ...batch, edits: [{ kind: 'upsert-source', source }, ...edits] });
    status.textContent = `已提交：${batch.label}；位置依据已标为本次手工操作，可撤销`;
  }
  const polygon = (): BattleMultiPolygon => {
    if (points.length < 3) throw new Error('区域至少需要三个顶点');
    const ring: BattleMultiPolygon[0][0] = [points[0], points[1], points[2], [...points[0]]];
    ring.splice(3, 0, ...points.slice(3));
    return [[normalizeRing(ring)]];
  };
  const drawnLine = (): BattleLine => {
    if (points.length < 2) throw new Error('线至少需要两个不同点');
    return [...points] as BattleLine;
  };
  function setOptions(target: HTMLSelectElement, values: [string, string][], empty: string | null = null): void {
    const previous = target.value;
    target.replaceChildren(...(empty === null ? [] : [new Option(empty, '')]), ...values.map(([id, label]) => new Option(label, id)));
    if ([...target.options].some(o => o.value === previous)) target.value = previous;
  }
  function syncSelectedEchelonInfo(workspace = getBattleWorkspace()): void {
    const selectedIds = editor.getSelection();
    const infoEl = el('battle-selected-echelon-info');
    if (!infoEl) return;
    if (selectedIds.length === 1) {
      const u = workspace.garrisons.find(g => g.id === selectedIds[0]);
      if (u) {
        const troops = u.personnel.count.state === 'known' ? u.personnel.count.value : null;
        const tier = resolveTroopEchelon(troops);
        const sym = getEchelonSymbol(u.echelon.state === 'known' ? u.echelon.value : undefined, troops);
        infoEl.textContent = `人数：${troops ?? '未定'} ｜ 8档区间：${tier.bracketLabel} ｜ 7档军标：[${sym}] ｜ 匹配编制：${tier.echelonName}`;
        return;
      }
    } else if (selectedIds.length > 1) {
      infoEl.textContent = `已多选 ${selectedIds.length} 个部队`;
      return;
    }
    infoEl.textContent = '未选中部队（在上方选择部队查看 8 档军标）';
  }
  function refresh(): void {
    const workspace = getBattleWorkspace();
    const validIds = new Set(workspace.garrisons.map(g => g.id));
    for (const id of [...editor.selectedUnitIds]) {
      if (!validIds.has(id)) editor.selectedUnitIds.delete(id);
    }
    setOptions(battlefieldSelect, workspace.battle.battlefields.map(b => [b.id, b.name.state === 'known' ? b.name.value : `名称未知 (${b.id})`]));
    const selected = new Set(editor.getSelection());
    unitSelect.replaceChildren(...workspace.garrisons.map(unit => {
      const dep = workspace.battle.deployments.find(d => d.unitId === unit.id)!;
      const option = new Option(`${unit.unitName.state === 'known' ? unit.unitName.value : '番号未知'}${dep.placement.state === 'unknown' ? ' · 未定位' : ''}`, unit.id);
      option.selected = selected.has(unit.id);
      return option;
    }));
    setOptions(select('battle-reserve'), workspace.garrisons.map(u => [u.id, u.unitName.state === 'known' ? u.unitName.value : u.id]), '不专属某单位');
    const bf = workspace.battle.battlefields.find(b => b.id === battlefieldSelect.value);
    setOptions(select('battle-feature'), bf ? bf.terrain.map(f => [f.id, f.label.state === 'known' ? f.label.value : f.id]) : [], '新建对象');
    setOptions(select('battle-obstacle'), bf ? bf.terrain.filter(f => f.kind === 'obstacle').map(f => [f.id, f.label.state === 'known' ? f.label.value : f.id]) : [], '无关联障碍');
    setOptions(select('battle-zone'), bf ? bf.terrain.filter(f => f.kind === 'deployment-zone').map(f => [f.id, f.label.state === 'known' ? f.label.value : f.id]) : [], '当前战场边界');
    el('battle-scale').textContent = bf ? (bf.scale.state === 'calibrated' ? `局部已标定：${bf.scale.distanceMeters} 米；仅适用标定范围` : `未校准：${bf.scale.reason}`) : '尚未创建战场';
    syncSelectedEchelonInfo(workspace);
    const history = battleHistoryAvailability();
    el<HTMLButtonElement>('battle-undo').disabled = !history.undo;
    el<HTMLButtonElement>('battle-redo').disabled = !history.redo;
    orbat.refresh();
    render();
  }
  function render(preview?: BattleDeployment[]): void {
    layer.removeChildren().forEach(child => child.destroy({ children: true, context: true }));
    const workspace = getBattleWorkspace();
    const selected = new Set(editor.getSelection());
    for (const option of unitSelect.options) option.selected = selected.has(option.value);
    syncSelectedEchelonInfo(workspace);
    renderBattle(preview ? { ...workspace, battle: { ...workspace.battle, deployments: preview } } : workspace,
      layer, { scale: viewScale, selectedUnitIds: editor.getSelection() });
  }
  const show = (): void => {
    panel.hidden = false; layer.visible = true; garrisonContainer.visible = false;
    appStore.interactionMode = 'battle-select';
    appStore.emit('tactical-mode-change', 'battle-select');
    appStore.emit('brush:changed', 'battle-select');
    refresh();
  };
  entry.onclick = show;
  appStore.on('battle:open', show);
  button('battle-close', () => {
    panel.hidden = true; layer.visible = false; garrisonContainer.visible = true;
    cancelDraw(); drag = null;
    appStore.interactionMode = 'pan';
    appStore.emit('tactical-mode-change', 'pan');
    appStore.emit('brush:changed', 'pan');
  });
  button('battle-tab-map', () => {
    el('battle-controls').hidden = false;
    el('battle-orbat-mount').hidden = true;
    el('battle-tab-map').classList.add('active');
    el('battle-tab-orbat').classList.remove('active');
    ensureBattleLayerActive('battle-select');
  });
  button('battle-tab-orbat', () => {
    el('battle-controls').hidden = true;
    el('battle-orbat-mount').hidden = false;
    el('battle-tab-orbat').classList.add('active');
    el('battle-tab-map').classList.remove('active');
    orbat.refresh();
  });
  button('battle-undo', () => { ensureBattleLayerActive('battle-select'); undoBattleEdit(); });
  button('battle-redo', () => { ensureBattleLayerActive('battle-select'); redoBattleEdit(); });
  button('battle-export', async () => {
    const bf = chosenBattlefield();
    const blob = await exportBattlePng(getBattleWorkspace(), bf.id);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url;
    anchor.download = `${bf.name.state === 'known' ? bf.name.value : bf.id}.png`;
    anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    status.textContent = '战场 PNG 已导出，包含尺度状态和假设说明';
  });
  battlefieldSelect.addEventListener('change', () => {
    ensureBattleLayerActive('battle-select');
    refresh();
  });
  unitSelect.addEventListener('change', () => {
    ensureBattleLayerActive('battle-select');
    const ids = [...unitSelect.selectedOptions].map(o => o.value);
    editor.selectUnits(ids);
    orbat.selectUnit(ids.length === 1 ? ids[0] : ids[ids.length - 1] ?? null);
  });
  button('battle-rotate-left', () => { ensureBattleLayerActive('battle-select'); editor.commitRotation(-15); });
  button('battle-rotate-right', () => { ensureBattleLayerActive('battle-select'); editor.commitRotation(15); });
  button('battle-auto-echelon', () => {
    const selectedIds = editor.getSelection();
    if (selectedIds.length === 0) throw new Error('请先在列表中选择部队');
    const workspace = getBattleWorkspace();
    const source = { id: crypto.randomUUID(), kind: 'manual' as const,
      title: '按人数匹配编制', text: '玩家按已知人数匹配编制', locator: '战役面板' };
    const edits: BattleEdit[] = [{ kind: 'upsert-source', source }];
    let matchedCount = 0;
    for (const id of selectedIds) {
      const u = workspace.garrisons.find(g => g.id === id);
      if (!u) continue;
      if (u.personnel.count.state === 'unknown') throw new Error('人数未知，请先填写人数再匹配编制');
      matchedCount++;
      const troops = u.personnel.count.state === 'known' ? u.personnel.count.value : null;
      const tier = resolveTroopEchelon(troops);
      const updated = structuredClone(u);
      updated.echelon = {
        state: 'known',
        value: tier.echelonName,
        evidence: [{
          sourceId: source.id,
          basis: 'assumption',
          excerpt: `按人数 (${troops}) 自动匹配 7 档编制为 ${tier.echelonName}`,
          note: `7档军标自动匹配 [${tier.symbol}]`,
        }],
      };
      edits.push({ kind: 'upsert-unit', unit: updated });
    }
    if (matchedCount === 0) throw new Error('所选部队已不存在，请重新选择');
    const label = `按人数自动匹配 ${matchedCount} 个部队编制`;
    ensureBattleLayerActive('battle-select');
    applyBattleEdits({ label, origin: 'manual', candidateItemIds: [], edits });
    status.textContent = `已自动匹配编制：${label}`;
    refresh();
  });
  button('battle-open-custom-badge', () => {
    const selectedIds = editor.getSelection();
    openGarrisonCustomModal({
      target: createMapUnitEditTarget(),
      unitId: selectedIds[0],
      onSaved: () => { ensureBattleLayerActive('battle-select'); refresh(); },
    });
  });
  const startDraw = (purpose: DrawPurpose): void => {
    drawPurpose = purpose; points = []; drag = null; sketch.clear();
    ensureBattleLayerActive('battle-draw');
    el('battle-draw-controls').hidden = false;
    el('battle-draw-help').textContent = '在地图依次点击顶点，然后点“完成绘制”；取消不会修改地图。';
    status.textContent = '正在绘制；中键/右键可漫游地图';
  };
  button('battlefield-create', () => { newBattlefield = true; startDraw('boundary'); });
  button('battlefield-redraw', () => { chosenBattlefield(); newBattlefield = false; startDraw('boundary'); });
  button('battle-feature-draw', () => { chosenBattlefield(); startDraw('terrain'); });
  button('battle-calibrate', () => { chosenBattlefield(); numeric('battle-distance'); startDraw('calibration'); });
  button('battle-place', () => {
    if (editor.getSelection().length !== 1) throw new Error('点击定位请只选择一个部队');
    chosenBattlefield(); startDraw('placement');
  });
  button('battle-deploy', () => {
    chosenBattlefield();
    if (editor.getSelection().length === 0) throw new Error('请先选择布阵部队');
    startDraw('front');
  });
  button('battle-uncalibrate', () => commit('取消距离标定', evidence => [{ kind: 'upsert-battlefield',
    battlefield: setBattlefieldScale(chosenBattlefield(), { state: 'uncalibrated', reason: evidence[0].excerpt }) }]));
  button('battle-feature-remove', () => {
    const id = select('battle-feature').value;
    if (id === '') throw new Error('请选中要删除的地形');
    commit('删除地形', () => [{ kind: 'upsert-battlefield', battlefield: removeTerrainFeature(chosenBattlefield(), id) }]);
  });
  const cancelDraw = (): void => {
    if (drawPurpose !== null) appStore.interactionMode = panel.hidden ? 'pan' : 'battle-select';
    points = []; drawPurpose = null; sketch.clear();
    el('battle-draw-controls').hidden = true;
  };
  button('battle-draw-cancel', () => { cancelDraw(); status.textContent = '已取消绘制'; });
  button('battle-draw-finish', () => {
    if (drawPurpose === null) throw new Error('没有正在绘制的对象');
    const purpose = drawPurpose;
    commit('战役地图手工编辑', evidence => {
      const assertion = select('battle-assertion').value as 'plan' | 'reported';
      if (purpose === 'boundary') {
        const boundary = knownField(polygon(), evidence);
        if (!newBattlefield) return [{ kind: 'upsert-battlefield', battlefield: setBattlefieldBoundary(chosenBattlefield(), boundary) }];
        const name = input('battlefield-name').value.trim();
        if (name === '') throw new Error('请填写战场名称');
        const battlefield: Battlefield = { id: crypto.randomUUID(), mapId: appStore.mapId, assertion,
          name: knownField(name, evidence), boundary, scale: { state: 'uncalibrated', reason: '尚未提供局部尺度资料' }, terrain: [] };
        return [{ kind: 'upsert-battlefield', battlefield }];
      }
      const battlefield = chosenBattlefield();
      if (purpose === 'calibration') {
        if (points.length !== 2) throw new Error('标定需要且只需要两个点');
        if (battlefield.boundary.state === 'unknown') throw new Error('战场范围未知，不能确定尺度适用范围');
        return [{ kind: 'upsert-battlefield', battlefield: setBattlefieldScale(battlefield, { state: 'calibrated',
          referenceSegment: [points[0], points[1]], distanceMeters: numeric('battle-distance'),
          appliesWithin: battlefield.boundary.value, evidence }) }];
      }
      if (purpose === 'placement') {
        if (points.length !== 1) throw new Error('点定位只需要一个地图点');
        const id = editor.getSelection()[0];
        const deployment = appStore.battle.deployments.find(d => d.unitId === id)!;
        return [{ kind: 'set-deployment', deployment: { ...deployment, assertion,
          battlefieldId: knownField(battlefield.id, evidence), placement: knownField({ anchor: points[0], shape: { kind: 'point' } }, evidence) } }];
      }
      if (purpose === 'terrain') {
        const label = input('battle-feature-name').value.trim();
        if (label === '') throw new Error('请填写地形名称');
        const selectedFeatureId = select('battle-feature').value;
        const id = selectedFeatureId === '' ? crypto.randomUUID() : selectedFeatureId;
        const base = { id, assertion, label: knownField(label, evidence) };
        const kind = select('battle-feature-kind').value;
        let feature: BattleTerrainFeature;
        if (kind === 'obstacle' || kind === 'deployment-zone') feature = { ...base, kind, area: knownField(polygon(), evidence) };
        else if (kind === 'passage-line') feature = { ...base, kind, line: knownField(drawnLine(), evidence) };
        else {
          if (points.length !== 1) throw new Error('通行口只需要一个地图点');
          const width = input('battle-passage-width').value.trim();
          const obstacleId = select('battle-obstacle').value;
          feature = { ...base, kind: 'passage', passageKind: kind as 'bridge' | 'ford' | 'pass',
            point: knownField(points[0], evidence), obstacleIds: obstacleId === '' ? [] : [obstacleId],
            widthMapUnits: width === '' ? unknownField('未提供通行口宽度', evidence) : knownField(numeric('battle-passage-width'), evidence) };
        }
        return [{ kind: 'upsert-battlefield', battlefield: select('battle-feature').value === ''
          ? addTerrainFeature(battlefield, feature) : updateTerrainFeature(battlefield, feature) }];
      }
      const zoneId = select('battle-zone').value;
      const feature = battlefield.terrain.find(f => f.id === zoneId && f.kind === 'deployment-zone');
      const allowed = zoneId === '' ? battlefield.boundary : (feature as Extract<BattleTerrainFeature, { kind: 'deployment-zone' }>).area;
      if (allowed.state === 'unknown') throw new Error('允许部署区未知，请先补充范围');
      const lineOrder = numeric('battle-line');
      const result = calculateBattleDeployment(getBattleWorkspace(), {
        battlefieldId: battlefield.id, assertion, facingDegrees: numeric('battle-facing', false),
        deploymentArea: allowed.value, lines: [{ order: lineOrder, front: drawnLine() }],
        allocations: editor.getSelection().map(unitId => ({ unitId, lineOrder,
          frontageMapUnits: numeric('battle-frontage'), depthMapUnits: numeric('battle-depth'),
          role: select('battle-role').value as 'line' | 'reserve', reserveForUnitId: select('battle-reserve').value === '' ? null : select('battle-reserve').value })), evidence,
      });
      if (result.outcome === 'conflict') throw new Error(result.issues.map(issue => `${issue.code}：${issue.message}`).join('\n'));
      return result.deployments.map(deployment => ({ kind: 'set-deployment', deployment }));
    });
    cancelDraw();
  });
  button('battle-demo', () => {
    const map = appStore.mapData;
    if (!map) throw new Error('请先导入地图，再添加示例演示');
    if (!window.confirm('将合成 3 师 9 团演示添加到当前图幅，保留已有部队。全部是演示假设，可一次撤销。继续？')) return;
    // 合成样例的固定坐标最远到 (950, 700)，按内容外扩 50px 设门槛
    if (map.width < 1000 || map.height < 750) throw new Error('此演示需要至少 1000×750 图幅；当前地图过小，请先手工绘制战场');
    const sample = structuredClone(syntheticWorkspace);
    const suffix = crypto.randomUUID();
    const unitIds = new Map(sample.garrisons.map(u => [u.id, `${u.id}:${suffix}`]));
    const sourceIds = new Map(sample.battle.sources.map(s => [s.id, `${s.id}:${suffix}`]));
    const battlefieldIds = new Map(sample.battle.battlefields.map(b => [b.id, `${b.id}:${suffix}`]));
    const rewriteEvidence = (value: any): void => {
      if (Array.isArray(value)) { value.forEach(rewriteEvidence); return; }
      if (value !== null && typeof value === 'object') {
        // 样例的 evidence 数组被多个字段共享；只映射原 ID，避免二次遍历把已映射值变成 undefined。
        if (typeof value.sourceId === 'string' && sourceIds.has(value.sourceId)) value.sourceId = sourceIds.get(value.sourceId)!;
        Object.values(value).forEach(rewriteEvidence);
      }
    };
    rewriteEvidence(sample);
    // structuredClone 保留了样例中部署字段的共享引用；重复映射时保持已替换值，避免二次查表得到 undefined。
    const remapped = (ids: Map<string, string>, value: string): string => ids.get(value) ?? value;
    for (const source of sample.battle.sources) source.id = remapped(sourceIds, source.id);
    for (const unit of sample.garrisons) {
      unit.id = remapped(unitIds, unit.id);
      if (unit.parentUnitId.state === 'known' && unit.parentUnitId.value !== null) unit.parentUnitId.value = remapped(unitIds, unit.parentUnitId.value);
    }
    for (const bf of sample.battle.battlefields) { bf.id = remapped(battlefieldIds, bf.id); bf.mapId = appStore.mapId; }
    for (const dep of sample.battle.deployments) {
      dep.unitId = remapped(unitIds, dep.unitId);
      if (dep.battlefieldId.state === 'known' && dep.battlefieldId.value !== null) dep.battlefieldId.value = remapped(battlefieldIds, dep.battlefieldId.value);
      if (dep.reserveForUnitId.state === 'known' && dep.reserveForUnitId.value !== null) dep.reserveForUnitId.value = remapped(unitIds, dep.reserveForUnitId.value);
    }
    ensureBattleLayerActive('battle-select');
    applyBattleEdits({ label: '添加合成河谷演示（非世界事实）', origin: 'manual', candidateItemIds: [], edits: [
      ...sample.battle.sources.map(source => ({ kind: 'upsert-source' as const, source })),
      ...sample.garrisons.map(unit => ({ kind: 'upsert-unit' as const, unit })),
      ...sample.battle.battlefields.map(battlefield => ({ kind: 'upsert-battlefield' as const, battlefield })),
      ...sample.battle.deployments.map(deployment => ({ kind: 'set-deployment' as const, deployment })),
    ] });
    status.textContent = '已添加合成演示：不是世界事实；三师已知至少 8600 人，第九团人数/位置未知。';
  });

  const mapPoint = (event: PointerEvent): BattlePoint => {
    const rect = canvas.getBoundingClientRect();
    return appStore.toMapCoords(event.clientX - rect.left, event.clientY - rect.top);
  };
  const distanceToSegment = (p: BattlePoint, a: BattlePoint, b: BattlePoint): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  };
  const distanceToLine = (p: BattlePoint, line: BattleLine): number => {
    let minimum = Infinity;
    for (let i = 1; i < line.length; i++) {
      minimum = Math.min(minimum, distanceToSegment(p, line[i - 1], line[i]));
    }
    return minimum;
  };
  const rotationDelta = (p: BattlePoint): number => {
    if (drag === null) return 0;
    const raw = (Math.atan2(p[1] - drag.pivot[1], p[0] - drag.pivot[0]) - drag.angle) * 180 / Math.PI;
    return ((raw + 180) % 360 + 360) % 360 - 180;
  };
  canvas.addEventListener('pointerdown', event => {
    if (panel.hidden || event.button !== 0 || !['battle-select', 'battle-draw'].includes(appStore.interactionMode)) return;
    setInputOwner('map');
    event.stopImmediatePropagation(); event.preventDefault();
    run(() => {
      const p = mapPoint(event);
      if (drawPurpose !== null) {
        points.push(p); sketch.clear().setStrokeStyle({ width: 2 / viewScale, color: 0xfbbf24 });
        sketch.moveTo(points[0][0], points[0][1]);
        for (const vertex of points) sketch.lineTo(vertex[0], vertex[1]);
        sketch.stroke();
        for (const vertex of points) sketch.circle(vertex[0], vertex[1], 3 / viewScale).fill(0xfbbf24);
        status.textContent = `已选 ${points.length} 个地图点；完成绘制后提交`;
        return;
      }
      const deployments = appStore.battle.deployments;
      const ranked = deployments.flatMap(dep => dep.placement.state === 'known'
        ? [{ dep, distance: Math.hypot(dep.placement.value.anchor[0] - p[0], dep.placement.value.anchor[1] - p[1]) }] : [])
        .sort((a, b) => a.distance - b.distance);
      const near = ranked.find(item => item.distance <= 45 / viewScale);
      const hit = near ? near.dep : [...deployments].reverse().find(dep => {
        if (dep.placement.state !== 'known') return false;
        const shape = dep.placement.value.shape;
        if (shape.kind === 'area') return pointInMultiPolygon(p, shape.area);
        if (shape.kind === 'frontage') return distanceToLine(p, shape.line) <= 8 / viewScale;
        return false;
      });
      if (!hit) {
        editor.clearSelection();
        orbat.selectUnit(null);
        refresh();
        return;
      }
      if (event.shiftKey) {
        if (editor.selectedUnitIds.has(hit.unitId)) {
          editor.selectUnits(editor.getSelection().filter(id => id !== hit.unitId));
        } else {
          editor.selectUnits([hit.unitId], true);
        }
      } else if (!editor.selectedUnitIds.has(hit.unitId)) {
        editor.selectUnits([hit.unitId]);
      }
      const selection = editor.getSelection();
      orbat.selectUnit(selection.includes(hit.unitId) ? hit.unitId : selection[0] ?? null);
      const anchors = deployments.flatMap(dep => selection.includes(dep.unitId) && dep.placement.state === 'known'
        ? [dep.placement.value.anchor] : []);
      if (anchors.length === 0) {
        drag = null;
        refresh();
        return;
      }
      const sum = anchors.reduce<BattlePoint>((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
      const pivot: BattlePoint = [sum[0] / anchors.length, sum[1] / anchors.length];
      drag = { pointerId: event.pointerId, start: p, rotating: event.altKey, pivot,
        angle: Math.atan2(p[1] - pivot[1], p[0] - pivot[0]) };
      canvas.setPointerCapture(event.pointerId);
      refresh();
    });
  }, true);
  canvas.addEventListener('pointermove', event => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const p = mapPoint(event);
    const delta: BattlePoint = [p[0] - drag.start[0], p[1] - drag.start[1]];
    const rotation = rotationDelta(p);
    render(appStore.battle.deployments.map(dep => editor.selectedUnitIds.has(dep.unitId)
      ? (drag!.rotating ? rotateDeployment(dep, rotation, drag!.pivot) : translateDeployment(dep, delta)) : dep));
  });
  canvas.addEventListener('pointerup', event => {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const p = mapPoint(event);
    const delta: BattlePoint = [p[0] - drag.start[0], p[1] - drag.start[1]];
    const rotation = rotationDelta(p);
    const rotating = drag.rotating;
    drag = null;
    run(() => { if (rotating) editor.commitRotation(rotation); else editor.commitDrag(delta); render(); });
  });
  canvas.addEventListener('pointercancel', () => { drag = null; render(); });
  window.addEventListener('keydown', event => {
    if (isFieldBattleOwner()) return;
    if (panel.hidden || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z' ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement).tagName)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    run(() => {
      ensureBattleLayerActive('battle-select');
      if (event.shiftKey) redoBattleEdit(); else undoBattleEdit();
    });
  }, true);
  const handleExternalToolSwitch = (): void => {
    const mode = appStore.interactionMode;
    if (mode === 'battle-select' || mode === 'battle-draw') return;
    if (drawPurpose !== null || points.length > 0) {
      points = [];
      drawPurpose = null;
      sketch.clear();
      el('battle-draw-controls').hidden = true;
    }
    drag = null;
    if (layer.visible) layer.visible = false;
    if (!garrisonContainer.visible) garrisonContainer.visible = true;
  };
  appStore.on('tactical-mode-change', handleExternalToolSwitch);
  appStore.on('brush:changed', handleExternalToolSwitch);
  appStore.on('battle:changed', refresh);
  appStore.on('viewport:zoom', scale => { viewScale = scale; if (!panel.hidden) render(); });
  appStore.on('map:loaded', () => {
    drag = null; cancelDraw(); editor.clearSelection(); resetBattleHistory();
    orbat.destroy(); mountOrbat();
    layer.visible = !panel.hidden;
    garrisonContainer.visible = panel.hidden;
    appStore.interactionMode = panel.hidden ? 'pan' : 'battle-select';
    refresh();
  });
  appStore.on('map:cleared', () => {
    drag = null; cancelDraw(); editor.clearSelection(); resetBattleHistory();
    panel.hidden = true; layer.visible = false; garrisonContainer.visible = true;
    orbat.destroy(); mountOrbat(); refresh();
  });
  appStore.on('theater:leaving', () => { drag = null; cancelDraw(); render(); });
  refresh();
}
