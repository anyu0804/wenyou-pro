import { Container } from 'pixi.js';
import { appStore, garrisonContainer, terrainContainer, type GarrisonBadgeStyle } from './store';
import type { BattleDeployment } from './battle-contract';
import { summarizeBattlePersonnel } from './battle-orbat';
import { applyBattleEdits } from './battle-actions';
import { translateDeployment } from './battle-editor';
import { renderUnitBadge } from './battle-layer';
import { openGarrisonCustomModal } from './garrison-panel';
import { createMapUnitEditTarget } from './map-unit-edit-target';
import { setInputOwner } from './input-owner';

/** 主地图与战役图使用同一兵牌；位置唯一保存在部署中。 */
export function initGarrisonLayer(canvas: HTMLElement, root: HTMLElement): { renderGarrisons: () => void } {
  const units = new Container();
  garrisonContainer.addChild(units);
  let scale = terrainContainer.parent!.scale.x;
  let drag: {
    deployment: BattleDeployment;
    anchor: [number, number];
    card: Container;
    pointerId: number;
    x: number;
    y: number;
    startMap: [number, number];
    currentMap: [number, number];
    moved: boolean;
  } | null = null;
  const toMapCoords = (clientX: number, clientY: number): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return appStore.toMapCoords(clientX - rect.left, clientY - rect.top);
  };
  const cancelDrag = (): void => {
    if (!drag) return;
    const pid = drag.pointerId;
    drag = null;
    try {
      if (canvas.hasPointerCapture(pid)) canvas.releasePointerCapture(pid);
    } catch { /* ignore */ }
    renderGarrisons();
  };
  const bar = document.createElement('div');
  bar.id = 'wenyou-garrison-bar';
  bar.style.cssText = 'position:fixed;right:296px;top:76px;z-index:81;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;background:#0f172aee;color:#e2e8f0;border:1px solid #475569;border-radius:8px;font-size:12px';
  bar.innerHTML = `<span id="garrison-total-count"></span>
    <button id="btn-open-garrison-custom" style="background:#1e293b;color:#f8fafc;border:1px solid #64748b;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:12px">+ 快速部署/自定义兵牌</button>
    <button id="btn-quick-deploy" style="background:#1e293b;color:#f8fafc;border:1px solid #64748b;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:12px">战役面板</button>
    <select id="garrison-style" style="background:#1e293b;color:#f8fafc;border:1px solid #64748b;border-radius:4px;padding:3px 5px;font-size:12px"><option value="standard">标准</option><option value="compact" selected>紧凑</option><option value="minimal">军标</option></select>
    <label style="display:inline-flex;align-items:center;gap:4px;color:#cbd5e1;white-space:nowrap">兵牌大小<input id="garrison-scale" type="range" min="0.35" max="2.4" step="0.05" value="${appStore.garrisonScale}" aria-label="兵牌大小" style="width:76px;accent-color:#38bdf8"><span id="garrison-scale-val" style="min-width:34px;color:#38bdf8;font-variant-numeric:tabular-nums">${Math.round(appStore.garrisonScale * 100)}%</span></label>`;
  root.append(bar);
  bar.querySelector<HTMLButtonElement>('#btn-open-garrison-custom')!.onclick = () => {
    if (!appStore.mapData || !appStore.mapId) {
      window.alert('请先导入地图，再部署或自定义兵牌');
      return;
    }
    openGarrisonCustomModal({ target: createMapUnitEditTarget() });
  };
  bar.querySelector<HTMLButtonElement>('#btn-quick-deploy')!.onclick = () => appStore.emit('battle:open');
  bar.querySelector<HTMLSelectElement>('#garrison-style')!.onchange = event => {
    appStore.garrisonStyle = (event.target as HTMLSelectElement).value as GarrisonBadgeStyle;
    renderGarrisons();
  };
  const scaleValEl = bar.querySelector<HTMLSpanElement>('#garrison-scale-val')!;
  bar.querySelector<HTMLInputElement>('#garrison-scale')!.oninput = event => {
    const val = Number((event.target as HTMLInputElement).value);
    appStore.garrisonScale = val;
    scaleValEl.textContent = `${Math.round(val * 100)}%`;
    renderGarrisons();
  };
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const e = event as PointerEvent;
    if (e.pointerId !== drag.pointerId) return;
    const cur = toMapCoords(e.clientX, e.clientY);
    drag.currentMap = cur;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 3) drag.moved = true;
    if (!drag.card.destroyed) {
      drag.card.position.set(
        drag.anchor[0] + (cur[0] - drag.startMap[0]),
        drag.anchor[1] + (cur[1] - drag.startMap[1])
      );
    }
  });
  canvas.addEventListener('pointerup', event => {
    if (!drag) return;
    const e = event as PointerEvent;
    if (e.pointerId !== drag.pointerId) return;
    const current = drag;
    drag = null;
    try {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    if (appStore.isSwitchingMap || !appStore.mapData) {
      renderGarrisons();
      return;
    }
    if (Math.hypot(e.clientX - current.x, e.clientY - current.y) < 3) {
      renderGarrisons();
      appStore.emit('selection:unit', current.deployment.unitId);
      openGarrisonCustomModal({ target: createMapUnitEditTarget(), unitId: current.deployment.unitId });
    } else {
      const endMap = toMapCoords(e.clientX, e.clientY);
      applyBattleEdits({ label: '移动主地图兵牌', origin: 'manual', candidateItemIds: [],
        edits: [{ kind: 'set-deployment', deployment: translateDeployment(current.deployment,
          [endMap[0] - current.startMap[0], endMap[1] - current.startMap[1]]) }] });
    }
  });
  canvas.addEventListener('pointercancel', event => {
    if (drag && (event as PointerEvent).pointerId === drag.pointerId) cancelDrag();
  });
  window.addEventListener('blur', cancelDrag);
  function renderGarrisons(): void {
    units.removeChildren().forEach(child => child.destroy({ children: true, context: true }));
    const summary = summarizeBattlePersonnel(appStore.garrisons, appStore.garrisons.map(u => u.id));
    const unknownPositions = appStore.battle.deployments.filter(d => d.placement.state === 'unknown').length;
    bar.querySelector<HTMLElement>('#garrison-total-count')!.textContent = `${appStore.garrisons.length} 支部队 · ${summary.total.state === 'known' ? summary.total.value : `已知至少 ${summary.knownMinimum}`} 人 · ${unknownPositions} 未定位`;
    let matchedDragCard: Container | null = null;
    for (const unit of appStore.garrisons) {
      const deployment = appStore.battle.deployments.find(d => d.unitId === unit.id)!;
      if (deployment.placement.state === 'unknown') continue;
      const anchor = deployment.placement.value.anchor;
      renderUnitBadge(units, deployment, unit, false, undefined, scale,
        appStore.garrisonStyle, appStore.garrisonScale);
      const card = units.children[units.children.length - 1] as Container;
      card.eventMode = 'static'; card.cursor = 'pointer';
      if (drag && drag.deployment.unitId === unit.id) {
        matchedDragCard = card;
        if (drag.moved) {
          card.position.set(
            drag.anchor[0] + (drag.currentMap[0] - drag.startMap[0]),
            drag.anchor[1] + (drag.currentMap[1] - drag.startMap[1])
          );
        }
      }
      card.on('pointerdown', e => {
        if (e.button !== 0 || appStore.interactionMode !== 'pan') return;
        setInputOwner('map');
        e.stopPropagation();
        (e.nativeEvent as PointerEvent).stopImmediatePropagation();
        const startMap = toMapCoords(e.clientX, e.clientY);
        drag = {
          deployment, anchor, card, pointerId: e.pointerId,
          x: e.clientX, y: e.clientY, startMap, currentMap: startMap, moved: false,
        };
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch { /* ignore */ }
      });
    }
    if (drag) {
      if (matchedDragCard) drag.card = matchedDragCard;
      else drag = null;
    }
  }
  appStore.on('battle:changed', renderGarrisons);
  appStore.on('garrisons-change', renderGarrisons);
  appStore.on('theater:leaving', cancelDrag);
  appStore.on('map:loaded', () => { drag = null; renderGarrisons(); });
  appStore.on('map:cleared', () => { drag = null; renderGarrisons(); });
  appStore.on('viewport:zoom', value => { scale = value; renderGarrisons(); });
  renderGarrisons();
  return { renderGarrisons };
}
