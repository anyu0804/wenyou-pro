import { Application, CullerPlugin, extensions } from 'pixi.js';
import { worldViewport, fieldBattleOverlay } from './map-viewport';
import { isFieldBattleOwner, isTextInput, setInputOwner } from './input-owner';
import {
  appStore,
  terrainContainer,
  tacticalContainer,
  garrisonContainer,
} from './store';
import { initTheaterSwitcher, restoreInitialTheater } from './theater-manager';
import { getRetouchContainer, initMapRenderer } from './map-renderer';
import { initRetouchLayer } from './retouch-layer';
import { initBrushPanel } from './brush-panel';
import { initBurgEditor } from './burg-editor';
import { initTacticalDrawer } from './tactical-drawer';
import { initTacticalToolbar } from './tactical-toolbar';
import { initGarrisonLayer } from './garrison-layer';
import { exportRawCache } from './theater-cache';
import { downloadText } from './map-serializer';
import { initBattlePanel } from './battle-panel';
import { setFieldBattlePaintDeps } from './field-battle-paint';
import { buildFieldTerrainSnapshot } from './field-battle-terrain';
import { copyBattleUnitsIntoField } from './field-battle-units';
import { initFieldBattleOverlay } from './field-battle-overlay';
import { initFieldBattleWindow, setFieldBattleSceneFactory } from './field-battle-window';
import { createFieldBattleScene } from './field-battle-scene';
import { initMapBridge, WENYOU_MAP_BRIDGE_PROTOCOL } from './bridge';

async function bootstrap() {
  // 在异步初始化期间提前缓冲宿主发来的桥接消息，防止启动阶段握手丢包
  const earlyBridgeMessages: MessageEvent[] = [];
  const captureEarlyBridgeMessage = (event: MessageEvent): void => {
    if (
      event.data &&
      typeof event.data === 'object' &&
      (event.data as { protocol?: unknown }).protocol === WENYOU_MAP_BRIDGE_PROTOCOL
    ) {
      earlyBridgeMessages.push(event);
    }
  };
  window.addEventListener('message', captureEarlyBridgeMessage);
  try {
  // 启用 Pixi 内置剔除器：配合 map-renderer 分块的 cullable，缩放平移时跳过离屏几何
  extensions.add(CullerPlugin);

  const rootEl = document.getElementById('app')!;
  const app = new Application();

  await app.init({
    resizeTo: window,
    background: 0x0d131a,
    antialias: true,
    // 高 DPR 屏（>2）填充率开销按平方增长，渲染分辨率封顶 2x
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });

  rootEl.appendChild(app.canvas);

  // 主视口容器：按顺序挂载地图、标绘、战场覆盖层和驻军
  worldViewport.addChild(terrainContainer);
  worldViewport.addChild(tacticalContainer);
  worldViewport.addChild(fieldBattleOverlay);
  worldViewport.addChild(garrisonContainer);
  app.stage.addChild(worldViewport);

  function emitViewportChanged(): void {
    appStore.emit('viewport:changed', {
      scale: worldViewport.scale.x, x: worldViewport.x, y: worldViewport.y,
      width: window.innerWidth, height: window.innerHeight,
    });
  }

  // 居中适配 1440x888 地图
  let fitScale = 1;
  let viewportWidth = window.innerWidth;
  let viewportHeight = window.innerHeight;
  const fitViewport = (reset = true) => {
    const centerX = (viewportWidth / 2 - worldViewport.x) / worldViewport.scale.x;
    const centerY = (viewportHeight / 2 - worldViewport.y) / worldViewport.scale.y;
    viewportWidth = window.innerWidth;
    viewportHeight = window.innerHeight;
    const mapW = appStore.mapData?.width || 1440;
    const mapH = appStore.mapData?.height || 888;
    const padX = 560; // 给左右工具栏留出舒适空间
    const padY = 48;
    const availW = Math.max(400, window.innerWidth - padX);
    const availH = Math.max(300, window.innerHeight - padY);
    const scale = Math.min(availW / mapW, availH / mapH, 1.25);
    fitScale = scale;
    if (!reset && worldViewport.scale.x >= fitScale) {
      worldViewport.position.set(viewportWidth / 2 - centerX * worldViewport.scale.x,
        viewportHeight / 2 - centerY * worldViewport.scale.y);
      emitViewportChanged();
      return;
    }
    worldViewport.scale.set(scale);
    worldViewport.position.set(
      (window.innerWidth - mapW * scale) / 2,
      (window.innerHeight - mapH * scale) / 2
    );
    appStore.emit('viewport:zoom', worldViewport.scale.x);
    emitViewportChanged();
  };
  fitViewport();
  // 拖动窗口/面板尺寸会连续触发 resize，rAF 合并避免每次事件都全量重建（标签重排 + 战术层重建）
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      fitViewport(false);
    });
  });

  // 画布漫游拖拽（在 pan 模式，或按住中键/右键/空格键时均可平滑平移地图）
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let viewStartX = 0;
  let viewStartY = 0;
  let spacePressed = false;

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    if (isFieldBattleOwner()) return;
    if (isTextInput(e.target)) return;
    // 阻止空格再次触发已聚焦按钮的 click，否则会边平移边切工具
    e.preventDefault();
    spacePressed = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spacePressed = false;
    }
  });

  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // 捕获阶段优先拦截中键/右键/空格+左键漫游，避免笔刷、城市编辑、标绘与野战涂选在漫游时同步落笔
  app.canvas.addEventListener(
    'pointerdown',
    (e: PointerEvent) => {
      setInputOwner('map');
      appStore.emit('viewport:interaction');
      const forcePan = e.button === 1 || e.button === 2 || (e.button === 0 && spacePressed);
      if (!forcePan) return;
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      viewStartX = worldViewport.position.x;
      viewStartY = worldViewport.position.y;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    { capture: true }
  );

  app.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const shouldPan = e.button === 0 && appStore.interactionMode === 'pan';
    if (!shouldPan) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    viewStartX = worldViewport.position.x;
    viewStartY = worldViewport.position.y;
  });

  window.addEventListener('pointermove', (e: PointerEvent) => {
    if (!isPanning) return;
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    worldViewport.position.set(viewStartX + dx, viewStartY + dy);
    emitViewportChanged();
  });

  window.addEventListener('pointerup', () => {
    isPanning = false;
  });
  // 触摸板/笔输入的 pointercancel 与窗口失焦也要收尾，否则平移状态会卡住
  window.addEventListener('pointercancel', () => {
    isPanning = false;
  });
  window.addEventListener('blur', () => {
    spacePressed = false;
    isPanning = false;
  });

  // 鼠标滚轮以光标为中心缩放
  app.canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      appStore.emit('viewport:interaction');
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const oldScale = worldViewport.scale.x;
      // 下限锁定在适配倍率（地图始终铺满可用区，不再缩出大片背景），
      // 上限 32 倍用于查看城市级细节；缩到底时回到居中适配视图
      const newScale = Math.max(fitScale, Math.min(32, oldScale * factor));
      if (newScale <= fitScale) {
        fitViewport();
        return;
      }
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      const localX = (mouseX - worldViewport.position.x) / oldScale;
      const localY = (mouseY - worldViewport.position.y) / oldScale;
      worldViewport.scale.set(newScale);
      worldViewport.position.set(
        mouseX - localX * newScale,
        mouseY - localY * newScale
      );
      appStore.emit('viewport:zoom', worldViewport.scale.x);
      emitViewportChanged();
    },
    { passive: false }
  );

  // 初始化三大模块渲染器与 UI 面板
  initMapRenderer(app, app.canvas);
  initRetouchLayer(app.canvas, getRetouchContainer());
  initBrushPanel(rootEl);
  initBurgEditor(app.canvas, rootEl);
  initTacticalDrawer(app.canvas);
  initTacticalToolbar(rootEl);
  setFieldBattlePaintDeps({ buildFieldTerrainSnapshot, copyBattleUnitsIntoField });
  setFieldBattleSceneFactory(createFieldBattleScene);
  initFieldBattleWindow(rootEl);
  initFieldBattleOverlay(rootEl);
  // 启动恢复已存战区；无缓存时进入空沙盘等待导入
  appStore.on('map:loaded', () => fitViewport());
  const ignoreCache = sessionStorage.getItem('wenyou-ignore-cache') === '1';
  sessionStorage.removeItem('wenyou-ignore-cache');
  await restoreInitialTheater(ignoreCache);
  initGarrisonLayer(app.canvas, rootEl);
  initBattlePanel(rootEl, app.canvas, worldViewport);
  initTheaterSwitcher(rootEl);
  window.removeEventListener('message', captureEarlyBridgeMessage);
  initMapBridge({ earlyMessages: earlyBridgeMessages });
  fitViewport();
  } catch (err) {
    window.removeEventListener('message', captureEarlyBridgeMessage);
    throw err;
  }
}

bootstrap().catch((err) => {
  console.error('[wenyou-pixi-app] Bootstrap error:', err);
  const panel = document.createElement('section');
  panel.id = 'startup-error';
  panel.style.cssText = 'position:fixed;inset:15%;z-index:20000;background:#0f172a;border:1px solid #f87171;border-radius:12px;padding:28px;overflow:auto;white-space:pre-wrap;user-select:text;';
  const title = document.createElement('h1');
  title.textContent = '沙盘启动失败';
  const message = document.createElement('p');
  message.textContent = `${String(err)}\n可先导出原始缓存保留数据，再选择从原图启动。后续保存会替换默认战区的损坏缓存。`;
  const exportButton = document.createElement('button');
  exportButton.id = 'export-raw-cache';
  exportButton.textContent = '导出原始缓存';
  exportButton.onclick = async () => {
    try {
      downloadText(await exportRawCache(), 'wenyou-raw-cache.json', 'application/json;charset=utf-8');
    } catch (error) {
      console.error('[wenyou-pixi-app] 缓存导出失败', error);
      message.textContent = `缓存导出失败：${String(error)}`;
    }
  };
  const ignoreButton = document.createElement('button');
  ignoreButton.id = 'ignore-cache';
  ignoreButton.textContent = '忽略缓存（空沙盘启动）';
  ignoreButton.onclick = () => {
    sessionStorage.setItem('wenyou-ignore-cache', '1');
    location.reload();
  };
  panel.append(title, message, exportButton, ignoreButton);
  document.body.append(panel);
});
