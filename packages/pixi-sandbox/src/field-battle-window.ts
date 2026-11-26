import { Application, Container } from 'pixi.js';
import { appStore } from './store';
import { setInputOwner } from './input-owner';
import {
  FIELD_BATTLE_DOM,
  type FieldBattle,
  type FieldBattleSceneContext,
  type FieldBattleSceneHandle,
} from './field-battle-types';

export type FieldBattleSceneFactory = (ctx: FieldBattleSceneContext) => FieldBattleSceneHandle;

let sceneFactory: FieldBattleSceneFactory = (ctx) => {
  const container = new Container();
  ctx.host.addChild(container);
  return {
    destroy: () => {
      ctx.host.removeChild(container);
      container.destroy({ children: true });
    },
    saveView: () => ctx.battle.view,
  };
};

export function setFieldBattleSceneFactory(factory: FieldBattleSceneFactory): void {
  sceneFactory = factory;
}

export function createFieldBattleScene(ctx: FieldBattleSceneContext): FieldBattleSceneHandle {
  return sceneFactory(ctx);
}

// 单例状态
let sharedApp: Application | null = null;
let appInitPromise: Promise<Application> | null = null;
let windowInitialized = false;
let storeListenersRegistered = false;

// 激活状态
let currentBattle: FieldBattle | null = null;
let activeScene: FieldBattleSceneHandle | null = null;
let activeHost: Container | null = null;
let openToken = 0;

// DOM 元素引用
let windowEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let minimizeEl: HTMLElement | null = null;
let contentEl: HTMLElement | null = null;

export function getActiveFieldBattle(): FieldBattle | null {
  return currentBattle;
}

export function isFieldBattleWindowOpen(): boolean {
  return windowEl !== null && windowEl.style.display !== 'none';
}

function ensureStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'field-battle-window-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    #field-battle-window {
      position: fixed;
      width: 72vw;
      height: 72vh;
      min-width: 480px;
      min-height: 360px;
      z-index: 1000;
      background: linear-gradient(180deg, rgba(15, 23, 42, 0.96) 0%, rgba(9, 13, 22, 0.98) 100%);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 12px;
      box-shadow: 0 24px 64px -12px rgba(0, 0, 0, 0.85),
                  0 0 0 1px rgba(255, 255, 255, 0.05) inset,
                  0 0 32px rgba(56, 189, 248, 0.12);
      display: none;
      flex-direction: column;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
      box-sizing: border-box;
      transition: box-shadow 0.2s ease, border-color 0.2s ease;
    }
    #field-battle-window.maximized {
      top: 12px !important;
      left: 12px !important;
      width: calc(100vw - 24px) !important;
      height: calc(100vh - 24px) !important;
      border-radius: 10px;
    }
    #field-battle-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 42px;
      padding: 0 14px;
      background: linear-gradient(90deg, #1e293b 0%, #172338 60%, #0f172a 100%);
      border-bottom: 1px solid rgba(56, 189, 248, 0.25);
      user-select: none;
      flex-shrink: 0;
      cursor: grab;
      position: relative;
    }
    #field-battle-header:active {
      cursor: grabbing;
    }
    #field-battle-header::after {
      content: "";
      position: absolute;
      bottom: -1px;
      left: 0;
      width: 100%;
      height: 1px;
      background: linear-gradient(90deg, transparent 0%, rgba(56, 189, 248, 0.6) 30%, rgba(56, 189, 248, 0.2) 70%, transparent 100%);
      pointer-events: none;
    }
    .field-battle-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      overflow: hidden;
      margin-right: 12px;
      pointer-events: none;
    }
    .field-battle-header-icon {
      width: 18px;
      height: 18px;
      color: #38bdf8;
      flex-shrink: 0;
      filter: drop-shadow(0 0 6px rgba(56, 189, 248, 0.6));
    }
    #field-battle-title {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.5px;
      color: #f8fafc;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    }
    .field-battle-header-tag {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.8px;
      color: #38bdf8;
      background: rgba(14, 165, 233, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.35);
      border-radius: 4px;
      padding: 1px 6px;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .field-battle-header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .field-battle-win-btn {
      background: rgba(30, 41, 59, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.25);
      color: #94a3b8;
      font-size: 13px;
      line-height: 1;
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      outline: none;
    }
    .field-battle-win-btn:hover {
      background: rgba(56, 189, 248, 0.2);
      border-color: rgba(56, 189, 248, 0.5);
      color: #f8fafc;
      box-shadow: 0 0 10px rgba(56, 189, 248, 0.3);
    }
    .field-battle-win-btn.close:hover {
      background: rgba(239, 68, 68, 0.25);
      border-color: rgba(239, 68, 68, 0.6);
      color: #fca5a5;
      box-shadow: 0 0 10px rgba(239, 68, 68, 0.4);
    }
    #field-battle-content {
      position: relative;
      flex: 1;
      width: 100%;
      height: calc(100% - 42px);
      overflow: hidden;
      background: #090d16;
    }
    #field-battle-content canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    .field-battle-resize-handle {
      position: absolute;
      right: 2px;
      bottom: 2px;
      width: 16px;
      height: 16px;
      cursor: nwse-resize;
      z-index: 50;
      opacity: 0.6;
      transition: opacity 0.15s;
    }
    .field-battle-resize-handle:hover {
      opacity: 1;
    }
    .field-battle-resize-handle::before,
    .field-battle-resize-handle::after {
      content: "";
      position: absolute;
      background: rgba(56, 189, 248, 0.6);
      border-radius: 1px;
    }
    .field-battle-resize-handle::before {
      bottom: 3px;
      right: 3px;
      width: 8px;
      height: 2px;
      box-shadow: 0 -4px 0 rgba(56, 189, 248, 0.6);
    }
    .field-battle-resize-handle::after {
      bottom: 3px;
      right: 3px;
      width: 2px;
      height: 8px;
      box-shadow: -4px 0 0 rgba(56, 189, 248, 0.6);
    }
  `;
  document.head.appendChild(style);
}

function initDrag(header: HTMLElement, win: HTMLElement): void {
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = 0;
  let initialTop = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.field-battle-win-btn')) return;
    if (win.classList.contains('maximized')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = win.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    setInputOwner('fieldbattle');
    if (typeof header.setPointerCapture === 'function') {
      header.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const targetLeft = initialLeft + dx;
    const targetTop = initialTop + dy;
    const winW = win.offsetWidth || window.innerWidth * 0.72;
    const winH = win.offsetHeight || window.innerHeight * 0.72;
    const clampLeft = Math.max(0, Math.min(window.innerWidth - winW, targetLeft));
    const clampTop = Math.max(0, Math.min(window.innerHeight - winH, targetTop));
    win.style.left = `${Math.round(clampLeft)}px`;
    win.style.top = `${Math.round(clampTop)}px`;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!isDragging) return;
    isDragging = false;
    if (typeof header.releasePointerCapture === 'function' && header.hasPointerCapture?.(e.pointerId)) {
      header.releasePointerCapture(e.pointerId);
    }
  };

  header.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function initResize(handle: HTMLElement, win: HTMLElement): void {
  let isResizing = false;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (win.classList.contains('maximized')) return;
    isResizing = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = win.getBoundingClientRect();
    startW = rect.width;
    startH = rect.height;
    setInputOwner('fieldbattle');
    if (typeof handle.setPointerCapture === 'function') {
      handle.setPointerCapture(e.pointerId);
    }
    e.stopPropagation();
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxW = window.innerWidth - win.offsetLeft - 12;
    const maxH = window.innerHeight - win.offsetTop - 12;
    const targetW = Math.max(480, Math.min(maxW, startW + dx));
    const targetH = Math.max(360, Math.min(maxH, startH + dy));
    win.style.width = `${Math.round(targetW)}px`;
    win.style.height = `${Math.round(targetH)}px`;
    if (sharedApp) {
      sharedApp.resize();
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!isResizing) return;
    isResizing = false;
    if (typeof handle.releasePointerCapture === 'function' && handle.hasPointerCapture?.(e.pointerId)) {
      handle.releasePointerCapture(e.pointerId);
    }
    if (sharedApp) {
      sharedApp.resize();
    }
  };

  handle.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

export function initFieldBattleWindow(root?: HTMLElement): HTMLElement {
  if (windowInitialized && windowEl) return windowEl;

  ensureStyles();
  const targetRoot = root || document.body;

  let existing = document.querySelector<HTMLElement>(FIELD_BATTLE_DOM.window);
  if (!existing) {
    existing = document.createElement('div');
    existing.id = FIELD_BATTLE_DOM.window.slice(1);
    existing.className = 'field-battle-window';
    existing.style.display = 'none';

    const header = document.createElement('div');
    header.id = 'field-battle-header';

    const leftWrap = document.createElement('div');
    leftWrap.className = 'field-battle-header-left';

    const iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    iconSvg.setAttribute('class', 'field-battle-header-icon');
    iconSvg.setAttribute('viewBox', '0 0 24 24');
    iconSvg.setAttribute('fill', 'none');
    iconSvg.setAttribute('stroke', 'currentColor');
    iconSvg.setAttribute('stroke-width', '2');
    iconSvg.innerHTML = '<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6 2 2-6-4-4"/><path d="M9.5 6.5L18 15"/><path d="M19 9l2-6-6 2"/>';

    const title = document.createElement('span');
    title.id = FIELD_BATTLE_DOM.title.slice(1);
    title.textContent = '战场';

    const tag = document.createElement('span');
    tag.className = 'field-battle-header-tag';
    tag.textContent = 'TACTICAL SECTOR';

    leftWrap.append(iconSvg, title, tag);

    const actions = document.createElement('div');
    actions.className = 'field-battle-header-actions';

    const minimize = document.createElement('button');
    minimize.id = FIELD_BATTLE_DOM.minimize.slice(1);
    minimize.className = 'field-battle-win-btn';
    minimize.type = 'button';
    minimize.setAttribute('aria-label', '收起');
    minimize.title = '收起战场';
    minimize.textContent = '—';

    const maximize = document.createElement('button');
    maximize.id = 'field-battle-maximize';
    maximize.className = 'field-battle-win-btn';
    maximize.type = 'button';
    maximize.setAttribute('aria-label', '最大化');
    maximize.title = '全屏/还原视窗';
    maximize.textContent = '⛶';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'field-battle-close';
    closeBtn.className = 'field-battle-win-btn close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.title = '关闭战场';
    closeBtn.textContent = '✕';

    actions.append(minimize, maximize, closeBtn);
    header.append(leftWrap, actions);

    const content = document.createElement('div');
    content.id = FIELD_BATTLE_DOM.content.slice(1);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'field-battle-resize-handle';
    resizeHandle.title = '拖动缩放视窗大小';

    existing.append(header, content, resizeHandle);
    targetRoot.appendChild(existing);
  }

  windowEl = existing;
  titleEl = windowEl.querySelector(FIELD_BATTLE_DOM.title);
  minimizeEl = windowEl.querySelector(FIELD_BATTLE_DOM.minimize);
  contentEl = windowEl.querySelector(FIELD_BATTLE_DOM.content);

  const headerEl = windowEl.querySelector<HTMLElement>('#field-battle-header') || titleEl!;
  initDrag(headerEl, windowEl);

  const resizeHandleEl = windowEl.querySelector<HTMLElement>('.field-battle-resize-handle');
  if (resizeHandleEl) {
    initResize(resizeHandleEl, windowEl);
  }

  // 窗口控制逻辑：最大化与还原
  const maxBtn = windowEl.querySelector<HTMLElement>('#field-battle-maximize');
  const toggleMaximize = () => {
    if (!windowEl) return;
    const isMax = windowEl.classList.toggle('maximized');
    if (maxBtn) {
      maxBtn.textContent = isMax ? '❐' : '⛶';
      maxBtn.setAttribute('aria-label', isMax ? '还原' : '最大化');
    }
    if (sharedApp) {
      setTimeout(() => sharedApp?.resize(), 50);
    }
  };

  maxBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMaximize();
  });

  headerEl.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.field-battle-win-btn')) return;
    toggleMaximize();
  });

  const closeBtnEl = windowEl.querySelector<HTMLElement>('#field-battle-close');
  closeBtnEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFieldBattleWindow();
  });

  minimizeEl?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFieldBattleWindow();
  });

  windowEl.addEventListener('pointerdown', () => {
    setInputOwner('fieldbattle');
  });

  if (!storeListenersRegistered) {
    storeListenersRegistered = true;
    appStore.on('fieldbattle:visibility', (visible) => {
      if (!visible) closeFieldBattleWindow();
    });
    appStore.on('theater:leaving', () => {
      closeFieldBattleWindow();
    });
    appStore.on('fieldbattle:changed', (payload) => {
      if (payload.kind === 'delete' && currentBattle && payload.battleId === currentBattle.id) {
        closeFieldBattleWindow();
      } else if (payload.kind === 'rename' && currentBattle && payload.battleId === currentBattle.id) {
        const found = appStore.fieldBattles.find((b) => b.id === payload.battleId);
        if (found) {
          currentBattle.name = found.name;
          if (titleEl) titleEl.textContent = found.name;
        }
      }
    });
  }

  windowInitialized = true;
  return windowEl;
}

export async function getOrCreateSharedApp(): Promise<Application> {
  if (sharedApp) return sharedApp;
  if (appInitPromise) return appInitPromise;

  appInitPromise = (async () => {
    try {
      const app = new Application();
      await app.init({
        background: '#090d16',
        resizeTo: contentEl || undefined,
        autoDensity: true,
        resolution: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1,
        antialias: true,
      });
      sharedApp = app;
      return app;
    } catch (error) {
      appInitPromise = null;
      if (windowEl) {
        windowEl.style.display = 'none';
      }
      updateActiveButtonHighlight(null);
      setInputOwner('map');
      throw error;
    }
  })();

  return appInitPromise;
}

function positionWindow(origin?: { x: number; y: number }): void {
  if (!windowEl) return;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const winW = vw * 0.7;
  const winH = vh * 0.7;

  let targetX = (vw - winW) / 2;
  let targetY = (vh - winH) / 2;

  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    targetX = origin.x - winW / 2;
    targetY = origin.y - winH / 2;
  }

  const clampedX = Math.max(10, Math.min(vw - winW - 10, targetX));
  const clampedY = Math.max(10, Math.min(vh - winH - 10, targetY));

  windowEl.style.left = `${Math.round(clampedX)}px`;
  windowEl.style.top = `${Math.round(clampedY)}px`;
}

function updateActiveButtonHighlight(battleId: string | null): void {
  if (typeof document === 'undefined') return;
  const buttons = document.querySelectorAll<HTMLElement>(FIELD_BATTLE_DOM.button);
  buttons.forEach((btn) => {
    const isCurrent = battleId !== null && btn.dataset.battleId === battleId;
    btn.classList.toggle('active', isCurrent);
    btn.setAttribute('aria-pressed', String(isCurrent));
  });
}

export async function openFieldBattleWindow(
  battle: FieldBattle,
  origin?: { x: number; y: number }
): Promise<void> {
  initFieldBattleWindow();
  if (!windowEl || !contentEl) return;

  // 若重复打开同一战场且窗口已在展示，只需置顶并确保按键高亮
  if (currentBattle?.id === battle.id && windowEl.style.display !== 'none') {
    updateActiveButtonHighlight(battle.id);
    setInputOwner('fieldbattle');
    return;
  }

  // 切换战场：先保存旧视角并销毁旧 scene，不销毁 app
  if (activeScene) {
    const savedView = activeScene.saveView();
    if (savedView && currentBattle) {
      currentBattle.view = savedView;
    }
    activeScene.destroy();
    activeScene = null;
  }
  if (activeHost) {
    activeHost.destroy({ children: true, context: true });
    activeHost = null;
  }

  const token = ++openToken;
  positionWindow(origin);
  windowEl.style.display = 'flex';
  let app: Application;
  try {
    app = await getOrCreateSharedApp();
  } catch (error) {
    if (token === openToken && windowEl) {
      windowEl.style.display = 'none';
      updateActiveButtonHighlight(null);
      setInputOwner('map');
    }
    throw error;
  }
  if (token !== openToken || !windowEl || windowEl.style.display === 'none') return;
  app.resize();

  // 保证 app.canvas 在 contentEl 内部且仅此一份
  if (app.canvas && !contentEl.contains(app.canvas)) {
    contentEl.appendChild(app.canvas);
  }

  app.start();

  activeHost = new Container();
  app.stage.addChild(activeHost);

  currentBattle = battle;
  if (titleEl) titleEl.textContent = battle.name;

  activeScene = createFieldBattleScene({
    app,
    host: activeHost,
    battle,
    root: contentEl,
    onChange: (kind) => {
      appStore.emit('fieldbattle:changed', { battleId: battle.id, kind });
    },
    onRequestClose: () => {
      closeFieldBattleWindow();
    },
  });

  updateActiveButtonHighlight(battle.id);
  setInputOwner('fieldbattle');

  appStore.emit('fieldbattle:changed', { battleId: battle.id, kind: 'view' });
}

export function closeFieldBattleWindow(): void {
  openToken++;
  if (!windowEl || windowEl.style.display === 'none') return;

  if (activeScene) {
    const savedView = activeScene.saveView();
    if (savedView && currentBattle) {
      currentBattle.view = savedView;
    }
    activeScene.destroy();
    activeScene = null;
  }

  if (activeHost) {
    activeHost.destroy({ children: true, context: true });
    activeHost = null;
  }

  if (sharedApp) {
    sharedApp.stop();
  }

  if (windowEl.classList.contains('maximized')) {
    windowEl.classList.remove('maximized');
    const maxBtn = windowEl.querySelector<HTMLElement>('#field-battle-maximize');
    if (maxBtn) {
      maxBtn.textContent = '⛶';
      maxBtn.setAttribute('aria-label', '最大化');
    }
  }

  windowEl.style.display = 'none';
  const closedId = currentBattle?.id;
  currentBattle = null;

  updateActiveButtonHighlight(null);
  setInputOwner('map');

  if (closedId) {
    appStore.emit('fieldbattle:changed', { battleId: closedId, kind: 'view' });
  }
}
