import { appStore } from './store';
import { worldViewport } from './map-viewport';
import { FIELD_BATTLE_DOM, type FieldBattle } from './field-battle-types';
import {
  openFieldBattleWindow,
  closeFieldBattleWindow,
  getActiveFieldBattle,
} from './field-battle-window';

let overlayContainer: HTMLElement | null = null;
let contextMenuEl: HTMLElement | null = null;
let overlayInitialized = false;
let updateScheduled = false;

function ensureOverlayStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'field-battle-overlay-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    #fieldbattle-overlay-container {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 40;
      overflow: hidden;
    }
    .fieldbattle-button {
      position: absolute;
      transform: translate(-50%, -50%);
      pointer-events: auto;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      background: linear-gradient(135deg, rgba(15, 23, 42, 0.94) 0%, rgba(30, 41, 59, 0.94) 100%);
      border: 1px solid rgba(56, 189, 248, 0.45);
      color: #f8fafc;
      font-size: 12px;
      font-weight: 500;
      padding: 5px 12px 5px 22px;
      border-radius: 9999px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6), 0 0 12px rgba(56, 189, 248, 0.15);
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      outline: none;
      display: inline-flex;
      align-items: center;
      font-family: inherit;
    }
    .fieldbattle-button::before {
      content: "";
      position: absolute;
      left: 8px;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #38bdf8;
      box-shadow: 0 0 8px #38bdf8;
      animation: fb-beacon-pulse 2s infinite ease-in-out;
    }
    @keyframes fb-beacon-pulse {
      0%, 100% { transform: scale(1); opacity: 0.9; }
      50% { transform: scale(1.4); opacity: 0.4; }
    }
    .fieldbattle-button:hover {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.98) 0%, rgba(15, 23, 42, 0.98) 100%);
      border-color: #38bdf8;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.7), 0 0 16px rgba(56, 189, 248, 0.4);
      transform: translate(-50%, -52%);
    }
    .fieldbattle-button.active,
    .fieldbattle-button[aria-pressed="true"] {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      border-color: #7dd3fc;
      color: #ffffff;
      font-weight: 600;
      box-shadow: 0 0 18px rgba(56, 189, 248, 0.8), 0 4px 12px rgba(0, 0, 0, 0.6);
    }
    .fieldbattle-button.active::before {
      background: #ffffff;
      box-shadow: 0 0 10px #ffffff;
    }
    #fieldbattle-menu {
      position: fixed;
      z-index: 1001;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(56, 189, 248, 0.3);
      border-radius: 8px;
      box-shadow: 0 12px 28px -4px rgba(0, 0, 0, 0.7), 0 0 16px rgba(56, 189, 248, 0.12);
      padding: 5px;
      min-width: 120px;
      display: none;
      flex-direction: column;
      gap: 2px;
      user-select: none;
      font-family: inherit;
    }
    .fieldbattle-menu-item {
      background: transparent;
      border: none;
      color: #e2e8f0;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      text-align: left;
      cursor: pointer;
      width: 100%;
      border-radius: 5px;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .fieldbattle-menu-item:hover {
      background: rgba(56, 189, 248, 0.2);
      color: #ffffff;
    }
    .fieldbattle-menu-item.delete {
      color: #f87171;
    }
    .fieldbattle-menu-item.delete:hover {
      background: rgba(239, 68, 68, 0.25);
      color: #fca5a5;
    }
  `;
  document.head.appendChild(style);
}

function updatePositions(): void {
  if (!overlayContainer) return;
  const scale = worldViewport.scale.x;
  const vx = worldViewport.position.x;
  const vy = worldViewport.position.y;

  for (const battle of appStore.fieldBattles) {
    const btn = overlayContainer.querySelector<HTMLElement>(
      `.fieldbattle-button[data-battle-id="${battle.id}"]`
    );
    if (!btn) continue;
    const sx = battle.anchor[0] * scale + vx;
    const sy = battle.anchor[1] * scale + vy;
    btn.style.left = `${Math.round(sx)}px`;
    btn.style.top = `${Math.round(sy)}px`;
  }
}

export function scheduleFieldBattleOverlayUpdate(): void {
  if (updateScheduled) return;
  updateScheduled = true;
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      updateScheduled = false;
      updatePositions();
    });
  } else {
    updateScheduled = false;
    updatePositions();
  }
}

function hideMenu(): void {
  if (contextMenuEl) {
    contextMenuEl.style.display = 'none';
  }
}

function triggerRename(battle: FieldBattle): void {
  const newName = window.prompt('请输入新的战场名称', battle.name);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === battle.name) return;

  battle.name = trimmed;
  appStore.emit('fieldbattle:changed', { battleId: battle.id, kind: 'rename' });
}

function triggerDelete(battle: FieldBattle): void {
  const confirmed = window.confirm(`确定要删除战场“${battle.name}”吗？此操作无法撤销。`);
  if (!confirmed) return;

  const idx = appStore.fieldBattles.findIndex((b) => b.id === battle.id);
  if (idx !== -1) {
    appStore.fieldBattles.splice(idx, 1);
  }

  if (getActiveFieldBattle()?.id === battle.id) {
    closeFieldBattleWindow();
  }

  appStore.emit('fieldbattle:changed', { battleId: battle.id, kind: 'delete' });
}

function showContextMenu(battle: FieldBattle, clientX: number, clientY: number): void {
  if (!contextMenuEl) return;
  contextMenuEl.replaceChildren();

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'fieldbattle-menu-item';
  renameBtn.innerHTML = '<span>✏️</span><span>重命名</span>';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideMenu();
    triggerRename(battle);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'fieldbattle-menu-item delete';
  deleteBtn.innerHTML = '<span>🗑️</span><span>删除战场</span>';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    hideMenu();
    triggerDelete(battle);
  });

  contextMenuEl.append(renameBtn, deleteBtn);

  const menuW = 120;
  const menuH = 70;
  const left = Math.max(5, Math.min(window.innerWidth - menuW - 5, clientX));
  const top = Math.max(5, Math.min(window.innerHeight - menuH - 5, clientY));

  contextMenuEl.style.left = `${left}px`;
  contextMenuEl.style.top = `${top}px`;
  contextMenuEl.style.display = 'flex';
}

export function renderFieldBattleButtons(): void {
  if (!overlayContainer) return;

  if (!appStore.showFieldBattles) {
    overlayContainer.hidden = true;
    overlayContainer.replaceChildren();
    return;
  }

  overlayContainer.hidden = false;
  const currentActiveId = getActiveFieldBattle()?.id ?? null;

  const existingButtons = new Map<string, HTMLButtonElement>();
  overlayContainer.querySelectorAll<HTMLButtonElement>('.fieldbattle-button').forEach((btn) => {
    if (btn.dataset.battleId) {
      existingButtons.set(btn.dataset.battleId, btn);
    }
  });

  const activeIds = new Set(appStore.fieldBattles.map((b) => b.id));

  // 移除失效按键
  existingButtons.forEach((btn, id) => {
    if (!activeIds.has(id)) {
      btn.remove();
      existingButtons.delete(id);
    }
  });

  // 更新或创建按键
  for (const battle of appStore.fieldBattles) {
    let btn = existingButtons.get(battle.id);
    const label = battle.name.includes('战场') ? battle.name : `${battle.name}战场`;
    const battleId = battle.id;

    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fieldbattle-button';
      btn.dataset.battleId = battleId;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideMenu();
        const current = appStore.fieldBattles.find((item) => item.id === battleId);
        if (!current) return;
        const rect = btn!.getBoundingClientRect();
        openFieldBattleWindow(current, {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        });
      });

      btn.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        hideMenu();
        const current = appStore.fieldBattles.find((item) => item.id === battleId);
        if (!current) return;
        triggerRename(current);
      });

      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const current = appStore.fieldBattles.find((item) => item.id === battleId);
        if (!current) return;
        showContextMenu(current, e.clientX, e.clientY);
      });

      overlayContainer.appendChild(btn);
    }

    if (btn.textContent !== label) {
      btn.textContent = label;
    }

    const isCurrent = currentActiveId === battle.id;
    btn.classList.toggle('active', isCurrent);
    btn.setAttribute('aria-pressed', String(isCurrent));
  }

  scheduleFieldBattleOverlayUpdate();
}

export function initFieldBattleOverlay(root?: HTMLElement): HTMLElement {
  if (overlayInitialized && overlayContainer) return overlayContainer;

  ensureOverlayStyles();
  const targetRoot = root || document.body;

  let container = document.getElementById('fieldbattle-overlay-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'fieldbattle-overlay-container';
    targetRoot.appendChild(container);
  }
  overlayContainer = container;

  let menu = document.querySelector<HTMLElement>(FIELD_BATTLE_DOM.menu);
  if (!menu) {
    menu = document.createElement('div');
    menu.id = FIELD_BATTLE_DOM.menu.slice(1);
    targetRoot.appendChild(menu);
  }
  contextMenuEl = menu;

  document.addEventListener('pointerdown', (e) => {
    if (contextMenuEl && contextMenuEl.style.display !== 'none') {
      if (!contextMenuEl.contains(e.target as Node)) {
        hideMenu();
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
    }
  });

  if (!overlayInitialized) {
    overlayInitialized = true;

    appStore.on('viewport:changed', () => {
      scheduleFieldBattleOverlayUpdate();
    });

    appStore.on('fieldbattle:visibility', (visible) => {
      if (!visible) {
        closeFieldBattleWindow();
      }
      renderFieldBattleButtons();
    });

    appStore.on('fieldbattle:changed', () => {
      renderFieldBattleButtons();
    });

    appStore.on('map:loaded', () => {
      hideMenu();
      renderFieldBattleButtons();
    });

    appStore.on('map:cleared', () => {
      closeFieldBattleWindow();
      hideMenu();
      renderFieldBattleButtons();
    });

    appStore.on('theater:leaving', () => {
      hideMenu();
    });

    window.addEventListener('resize', () => {
      scheduleFieldBattleOverlayUpdate();
    });
  }

  renderFieldBattleButtons();
  return overlayContainer;
}
