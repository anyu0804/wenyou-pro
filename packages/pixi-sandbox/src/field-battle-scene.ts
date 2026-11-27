import { Container, Graphics, ImageSource, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import * as PixiViewportModule from 'pixi-viewport';
import { appStore } from './store';
import {
  getBaseImageElement,
  getBaseImageTexture,
  renderRetouchStrokesInto,
} from './retouch-layer';

const ViewportClass: typeof import('pixi-viewport').Viewport =
  (PixiViewportModule as any).Viewport ??
  (PixiViewportModule as any).default?.Viewport ??
  (PixiViewportModule as any).default;
import {
  FIELD_BATTLE_DOM,
  type FieldBadgeStyle,
  type FieldBattle,
  type FieldBattleSceneContext,
  type FieldBattleSceneHandle,
  type FieldPolygonPart,
  type UnitEditBatch,
  type UnitEditTarget,
} from './field-battle-types';
import { isFieldBattleOwner, isTextInput, setInputOwner } from './input-owner';
import { renderUnitBadge } from './battle-layer';
import { translateDeployment } from './battle-editor';
import { openGarrisonCustomModal } from './garrison-panel';
import {
  applyFieldBattleBatch,
  redoFieldBattle,
  resetFieldBattleHistory,
  undoFieldBattle,
} from './field-battle-history';
import { setFieldBattleSceneFactory } from './field-battle-window';

/**
 * 计算 displayOutline 的二维 AABB 包围盒；若无有效环则回退至 bounds
 */
export function computeOutlineBounds(
  displayOutline: readonly FieldPolygonPart[],
  fallbackBounds: { x: number; y: number; width: number; height: number }
): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  if (displayOutline && displayOutline.length > 0) {
    for (const part of displayOutline) {
      if (!part?.outer) continue;
      for (const [x, y] of part.outer) {
        if (Number.isFinite(x) && Number.isFinite(y)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY)
  ) {
    minX = fallbackBounds.x;
    minY = fallbackBounds.y;
    maxX = fallbackBounds.x + fallbackBounds.width;
    maxY = fallbackBounds.y + fallbackBounds.height;
  }

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return { minX, minY, maxX, maxY, width, height };
}

export interface FieldImageCropRect {
  worldX: number;
  worldY: number;
  worldWidth: number;
  worldHeight: number;
  srcX: number;
  srcY: number;
  srcWidth: number;
  srcHeight: number;
}

/**
 * 将野战快照的世界坐标裁剪框（outlineBounds / frame）映射为原底图纹理的像素裁剪框与世界对齐尺寸。
 */
export function computeFieldImageCropRect(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  mapWidth: number,
  mapHeight: number,
  imgWidth: number,
  imgHeight: number
): FieldImageCropRect | null {
  if (
    !Number.isFinite(mapWidth) ||
    !Number.isFinite(mapHeight) ||
    !Number.isFinite(imgWidth) ||
    !Number.isFinite(imgHeight) ||
    mapWidth <= 0 ||
    mapHeight <= 0 ||
    imgWidth <= 0 ||
    imgHeight <= 0
  ) {
    return null;
  }
  const clampVal = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const worldX = clampVal(bounds.minX, 0, mapWidth);
  const worldY = clampVal(bounds.minY, 0, mapHeight);
  const worldMaxX = clampVal(bounds.maxX, 0, mapWidth);
  const worldMaxY = clampVal(bounds.maxY, 0, mapHeight);
  const worldWidth = worldMaxX - worldX;
  const worldHeight = worldMaxY - worldY;
  if (worldWidth <= 0 || worldHeight <= 0) return null;

  const sx = imgWidth / mapWidth;
  const sy = imgHeight / mapHeight;
  const srcX = clampVal(worldX * sx, 0, Math.max(0, imgWidth - 1));
  const srcY = clampVal(worldY * sy, 0, Math.max(0, imgHeight - 1));
  const srcWidth = Math.max(1, Math.min(imgWidth - srcX, worldWidth * sx));
  const srcHeight = Math.max(1, Math.min(imgHeight - srcY, worldHeight * sy));

  return {
    worldX,
    worldY,
    worldWidth,
    worldHeight,
    srcX,
    srcY,
    srcWidth,
    srcHeight,
  };
}

/**
 * 构造战场专用的 UnitEditTarget 适配器
 */
export function createFieldBattleTarget(
  battle: FieldBattle,
  options?: {
    getCameraCenter?: () => [number, number];
    onCommit?: (batch: UnitEditBatch) => void;
  }
): UnitEditTarget {
  return {
    getUnits: () => battle.units,
    getDeployments: () => battle.deployments,
    getSources: () => battle.sources,
    newUnitCenter: () => {
      if (options?.getCameraCenter) {
        return options.getCameraCenter();
      }
      return [
        battle.bounds.x + battle.bounds.width / 2,
        battle.bounds.y + battle.bounds.height / 2,
      ];
    },
    commit: (batch: UnitEditBatch) => {
      applyFieldBattleBatch(battle, batch);
      if (options?.onCommit) {
        options.onCommit(batch);
      }
    },
  };
}

/**
 * 创建战场内部场景：独立相机、按序渲染只读快照、兵牌交互与工具栏
 */
export function createFieldBattleScene(
  ctx: FieldBattleSceneContext
): FieldBattleSceneHandle {
  const { app, host, battle, root } = ctx;
  const terrain = battle.terrain;

  // 1. 计算展示范围与相机参数
  const outlineBounds = computeOutlineBounds(
    terrain?.displayOutline ?? [],
    battle.bounds
  );
  const worldW = outlineBounds.width;
  const worldH = outlineBounds.height;

  const screenW = Math.max(1, app.screen?.width || root?.clientWidth || 800);
  const screenH = Math.max(1, app.screen?.height || root?.clientHeight || 600);
  let fitScale = Math.min(32, screenW / worldW, screenH / worldH);

  // 2. 初始化独立相机 (pixi-viewport v6)
  const dummyEvents = {
    domElement: root ?? {
      addEventListener() {},
      removeEventListener() {},
    },
  };
  const viewport = new ViewportClass({
    screenWidth: screenW,
    screenHeight: screenH,
    worldWidth: worldW,
    worldHeight: worldH,
    events: (app.renderer?.events ?? dummyEvents) as any,
    noTicker: !app.ticker,
    threshold: 3,
  });

  host.addChild(viewport);

  // 相机缩放与展示范围约束：最大 scale = 32，最小 = 初始 fit；clamp 到展示范围
  // 快照沿用主地图坐标；小于画布时也须围绕 display 中心居中。
  function constrainPosition(): void {
    const scale = viewport.scale.x;
    viewport.x = worldW * scale <= viewport.screenWidth
      ? viewport.screenWidth / 2 - (outlineBounds.minX + outlineBounds.maxX) / 2 * scale
      : Math.max(viewport.screenWidth - outlineBounds.maxX * scale,
        Math.min(-outlineBounds.minX * scale, viewport.x));
    viewport.y = worldH * scale <= viewport.screenHeight
      ? viewport.screenHeight / 2 - (outlineBounds.minY + outlineBounds.maxY) / 2 * scale
      : Math.max(viewport.screenHeight - outlineBounds.maxY * scale,
        Math.min(-outlineBounds.minY * scale, viewport.y));
  }
  viewport.on('moved', constrainPosition);
  viewport.on('zoomed', constrainPosition);
  viewport.clampZoom({
    minScale: fitScale,
    maxScale: 32,
  });
  viewport.drag().wheel().pinch();

  // 视角恢复或初始 fit
  if (
    battle.view &&
    Number.isFinite(battle.view.scale) &&
    battle.view.scale > 0 &&
    Number.isFinite(battle.view.x) &&
    Number.isFinite(battle.view.y)
  ) {
    viewport.scale.set(Math.max(fitScale, Math.min(32, battle.view.scale)));
    viewport.position.set(battle.view.x, battle.view.y);
  } else {
    viewport.scale.set(fitScale);
    viewport.moveCenter(
      (outlineBounds.minX + outlineBounds.maxX) / 2,
      (outlineBounds.minY + outlineBounds.maxY) / 2
    );
    battle.view = {
      scale: viewport.scale.x,
      x: viewport.position.x,
      y: viewport.position.y,
    };
  }
  constrainPosition();

  const onResize = () => {
    viewport.resize(app.screen.width, app.screen.height);
    fitScale = Math.min(32, app.screen.width / worldW, app.screen.height / worldH);
    viewport.clampZoom({ minScale: fitScale, maxScale: 32 });
    constrainPosition();
    updateBurgScale();
  };
  app.renderer.on('resize', onResize);

  // 3. 构建渲染层（严格遵循 contract 绘制顺序）
  // [可选：图片底图局部裁剪层] -> cells -> coastBands -> lakes -> rivers -> contours -> coastlines -> burgs -> contextOutline 压暗 -> 兵牌
  const baseImageLayer = new Container();
  const cellsGfx = new Graphics();
  const coastBandsGfx = new Graphics();
  const lakesGfx = new Graphics();
  const riversGfx = new Graphics();
  const contoursGfx = new Graphics();
  const coastlinesGfx = new Graphics();
  const burgsContainer = new Container();
  const contextGfx = new Graphics();
  const badgesContainer = new Container();

  viewport.addChild(
    baseImageLayer,
    cellsGfx,
    coastBandsGfx,
    lakesGfx,
    riversGfx,
    contoursGfx,
    coastlinesGfx,
    burgsContainer,
    contextGfx,
    badgesContainer
  );

  // --- 0. 图片底图局部对齐垫底（仅当主地图为图片底图且纹理就绪） ---
  let localImageTexture: Texture | null = null;
  let ownsLocalImageSource = false;
  let hasImageBackdrop = false;

  const currentMap = appStore.mapData;
  if (currentMap?.source.baseKind === 'image') {
    const baseImg = getBaseImageElement();
    const baseTex = getBaseImageTexture();
    const imgW =
      baseImg && baseImg.naturalWidth > 0
        ? baseImg.naturalWidth
        : baseTex?.width ?? 0;
    const imgH =
      baseImg && baseImg.naturalHeight > 0
        ? baseImg.naturalHeight
        : baseTex?.height ?? 0;
    const crop = computeFieldImageCropRect(
      outlineBounds,
      currentMap.width,
      currentMap.height,
      imgW,
      imgH
    );

    if (crop && (baseImg || baseTex)) {
      const frame = new Rectangle(crop.srcX, crop.srcY, crop.srcWidth, crop.srcHeight);
      if (baseImg && baseImg.naturalWidth > 0) {
        const localSource = new ImageSource({ resource: baseImg });
        localImageTexture = new Texture({ source: localSource, frame });
        ownsLocalImageSource = true;
      } else if (baseTex) {
        localImageTexture = new Texture({ source: baseTex.source, frame });
        ownsLocalImageSource = false;
      }

      if (localImageTexture) {
        const bgSprite = new Sprite(localImageTexture);
        bgSprite.position.set(crop.worldX, crop.worldY);
        bgSprite.width = crop.worldWidth;
        bgSprite.height = crop.worldHeight;
        baseImageLayer.addChild(bgSprite);

        // 叠加主地图已擦除旧字的修补层
        if (currentMap.source.retouchStrokes?.length) {
          const retouchOverlay = new Graphics();
          renderRetouchStrokesInto(retouchOverlay, currentMap.source.retouchStrokes);
          baseImageLayer.addChild(retouchOverlay);
        }

        // 按 displayOutline 裁剪，使局部原图自然贴合战场六角边界
        if (terrain?.displayOutline?.length) {
          const maskGfx = new Graphics();
          for (const part of terrain.displayOutline) {
            if (!part.outer || part.outer.length < 3) continue;
            maskGfx
              .poly(part.outer.flatMap(([x, y]) => [x, y]), true)
              .fill({ color: 0xffffff });
            for (const hole of part.holes) {
              if (hole && hole.length >= 3) {
                maskGfx.poly(hole.flatMap(([x, y]) => [x, y]), true).cut();
              }
            }
          }
          viewport.addChild(maskGfx);
          baseImageLayer.mask = maskGfx;
        }

        hasImageBackdrop = true;
      }
    }
  }

  // --- A. cells 绘制 ---
  if (terrain?.cells && !hasImageBackdrop) {
    for (const cell of terrain.cells) {
      if (!cell.polygon || cell.polygon.length < 3) continue;
      const flat = cell.polygon.flatMap(([x, y]) => [x, y]);
      cellsGfx.poly(flat, true).fill({ color: cell.color });
    }
  }

  // --- B. coastBands (带孔多边形) ---
  if (terrain?.coastBands) {
    for (const band of terrain.coastBands) {
      for (const part of band.parts) {
        if (!part.outer || part.outer.length < 3) continue;
        coastBandsGfx
          .poly(part.outer.flatMap(([x, y]) => [x, y]), true)
          .fill({ color: band.color, alpha: band.alpha });
        for (const hole of part.holes) {
          if (hole && hole.length >= 3) {
            coastBandsGfx.poly(hole.flatMap(([x, y]) => [x, y]), true).cut();
          }
        }
      }
    }
  }

  // --- C. lakes (带孔多边形) ---
  if (terrain?.lakes) {
    for (const lake of terrain.lakes) {
      for (const part of lake.parts) {
        if (!part.outer || part.outer.length < 3) continue;
        lakesGfx
          .poly(part.outer.flatMap(([x, y]) => [x, y]), true)
          .fill({ color: lake.color });
        for (const hole of part.holes) {
          if (hole && hole.length >= 3) {
            lakesGfx.poly(hole.flatMap(([x, y]) => [x, y]), true).cut();
          }
        }
      }
    }
  }

  // --- D. rivers (带孔多边形) ---
  if (terrain?.rivers) {
    for (const river of terrain.rivers) {
      for (const part of river.parts) {
        if (!part.outer || part.outer.length < 3) continue;
        riversGfx
          .poly(part.outer.flatMap(([x, y]) => [x, y]), true)
          .fill({ color: river.color, alpha: river.alpha });
        for (const hole of part.holes) {
          if (hole && hole.length >= 3) {
            riversGfx.poly(hole.flatMap(([x, y]) => [x, y]), true).cut();
          }
        }
      }
    }
  }

  // --- E. contours (等高线折线) ---
  if (terrain?.contours) {
    for (const group of terrain.contours) {
      for (const line of group.lines) {
        if (!line.points || line.points.length < 2) continue;
        contoursGfx.moveTo(line.points[0][0], line.points[0][1]);
        for (let i = 1; i < line.points.length; i++) {
          contoursGfx.lineTo(line.points[i][0], line.points[i][1]);
        }
        if (line.closed) {
          contoursGfx.lineTo(line.points[0][0], line.points[0][1]);
        }
      }
      contoursGfx.stroke({
        color: group.style.color,
        width: group.style.width,
        alpha: group.style.alpha,
      });
    }
  }

  // --- F. coastlines (海岸线折线) ---
  if (terrain?.coastlines) {
    for (const group of terrain.coastlines) {
      for (const line of group.lines) {
        if (!line.points || line.points.length < 2) continue;
        coastlinesGfx.moveTo(line.points[0][0], line.points[0][1]);
        for (let i = 1; i < line.points.length; i++) {
          coastlinesGfx.lineTo(line.points[i][0], line.points[i][1]);
        }
        if (line.closed) {
          coastlinesGfx.lineTo(line.points[0][0], line.points[0][1]);
        }
      }
      coastlinesGfx.stroke({
        color: group.style.color,
        width: group.style.width,
        alpha: group.style.alpha,
      });
    }
  }

  // --- G. burgs (快照城市：点与名称) ---
  if (terrain?.burgs) {
    for (const burg of terrain.burgs) {
      const city = new Container();
      city.position.set(burg.x, burg.y);
      const burgsGfx = new Graphics();
      city.addChild(burgsGfx);
      const isCapital = burg.tier === 'capital';
      const isProv = burg.tier === 'provincial';
      const r = isCapital ? 4 : isProv ? 3 : 2;
      const color = isCapital ? 0xf59e0b : 0xffffff;
      burgsGfx.circle(0, 0, r).fill({ color }).stroke({ width: 1, color: 0x0f172a });

      const label = new Text({
        text: burg.name,
        style: new TextStyle({
          fontFamily: 'system-ui, sans-serif',
          fontSize: 10,
          fontWeight: isCapital ? 'bold' : 'normal',
          fill: '#f8fafc',
          stroke: { color: '#0f172a', width: 2 },
        }),
        resolution: 3,
      });
      label.anchor.set(0.5, 0);
      label.position.set(0, r + 2);
      city.addChild(label);
      burgsContainer.addChild(city);
    }
  }

  const tierPriority = { capital: 0, provincial: 1, city: 2 };
  const rankedCities = burgsContainer.children.map((city, index) => ({
    city, priority: tierPriority[terrain.burgs[index].tier],
  })).sort((a, b) => a.priority - b.priority);

  let cityLabelScale = 1;
  let cityLabelZoomBoost = false;
  let cityLabelDynamicLod = true;

  // 城市位置使用地图坐标；圆点、文字和间距使用屏幕像素。支持手动城名大小与动态避让/随缩放开关。
  function updateBurgScale(): void {
    const scale = viewport.scale.x;
    const zoomBoost = cityLabelZoomBoost
      ? Math.min(2.4, 1 + Math.max(0, (scale - fitScale) / Math.max(fitScale, 1)) * 0.45)
      : 1;
    const effectiveScale = cityLabelScale * zoomBoost;
    const occupied: Rectangle[] = [];
    for (const { city } of rankedCities) {
      city.scale.set(1 / scale);
      const label = city.children[1] as Text;
      label.scale.set(effectiveScale);
      if (!cityLabelDynamicLod) {
        label.visible = true;
        continue;
      }
      const bounds = label.getLocalBounds();
      const w = bounds.width * effectiveScale;
      const h = bounds.height * effectiveScale;
      const box = new Rectangle(
        city.x * scale + label.x + bounds.x * effectiveScale - 4,
        city.y * scale + label.y + bounds.y * effectiveScale - 4,
        w + 8,
        h + 8
      );
      label.visible = !occupied.some(other => other.intersects(box));
      if (label.visible) occupied.push(box);
    }
  }
  updateBurgScale();
  viewport.on('zoomed', updateBurgScale);

  // --- H. contextOutline 压暗 (带孔外围遮罩) ---
  if (terrain?.contextOutline) {
    for (const part of terrain.contextOutline) {
      if (!part.outer || part.outer.length < 3) continue;
      contextGfx
        .poly(part.outer.flatMap(([x, y]) => [x, y]), true)
        .fill({ color: '#090d16', alpha: 0.5 });
      for (const hole of part.holes) {
        if (hole && hole.length >= 3) {
          contextGfx.poly(hole.flatMap(([x, y]) => [x, y]), true).cut();
        }
      }
    }
  }

  // 4. 兵牌渲染与交互状态
  let selectedUnitId: string | null = null;
  let visualBadgeScale: number | null = null;
  let updateHudState: () => void = () => {};

  let isDraggingBadge = false;
  let dragUnitId: string | null = null;
  let dragStartWorld: [number, number] = [0, 0];
  let dragStartAnchor: [number, number] = [0, 0];

  function renderBadges(): void {
    badgesContainer.removeChildren().forEach((child) => child.destroy({ children: true, context: true }));

    const viewScale = viewport.scale?.x || 1;
    const badgeStyle = battle.badgeStyle || 'standard';
    const badgeScale = visualBadgeScale ?? battle.badgeScale ?? 1;

    for (const unit of battle.units) {
      const deployment = battle.deployments.find((d) => d.unitId === unit.id);
      if (!deployment) continue;
      // 勘误 2：未知位置兵牌不绘制
      if (deployment.placement.state !== 'known') continue;

      const isSelected = selectedUnitId === unit.id;
      const countBefore = badgesContainer.children.length;

      renderUnitBadge(
        badgesContainer,
        deployment,
        unit,
        isSelected,
        undefined,
        viewScale,
        badgeStyle,
        badgeScale
      );

      const badgeChild = badgesContainer.children[countBefore] as Container | undefined;
      if (badgeChild) {
        badgeChild.eventMode = 'static';
        badgeChild.cursor = 'pointer';

        const isMinimal = badgeStyle === 'minimal';
        const bw = isMinimal ? 34 : badgeStyle === 'compact' ? 76 : 96;
        const bh = isMinimal ? 34 : badgeStyle === 'compact' ? 28 : 30;
        badgeChild.hitArea = new Rectangle(-bw / 2 - 4, -bh / 2 - 4, bw + 8, bh + 8);

        badgeChild.on('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          setInputOwner('fieldbattle');
          selectedUnitId = unit.id;
          renderBadges();

          // 开始左键拖动兵牌
          isDraggingBadge = true;
          dragUnitId = unit.id;
          const world = viewport.toWorld(e.global.x, e.global.y);
          dragStartWorld = [world.x, world.y];
          if (deployment.placement.state === 'known') {
            const anchor = deployment.placement.value.anchor;
            dragStartAnchor = [anchor[0], anchor[1]];
          }
          viewport.plugins.pause('drag');
        });
      }
    }
    updateHudState();
  }

  // 初始渲染兵牌
  renderBadges();

  // 点击视口空白处取消选择
  viewport.on('pointerdown', () => {
    setInputOwner('fieldbattle');
    if (selectedUnitId !== null && !isDraggingBadge) {
      selectedUnitId = null;
      renderBadges();
    }
  });

  // 全局拖拽与释放处理（拖动中只改显示，松手 pointerup 提交 upsert）
  const onPointerMove = (e: PointerEvent) => {
    if (!isDraggingBadge || !dragUnitId) return;
    const canvas = app.canvas;
    const rect = canvas?.getBoundingClientRect() || root?.getBoundingClientRect();
    if (!rect) return;

    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const world = viewport.toWorld(screenX, screenY);
    const dx = world.x - dragStartWorld[0];
    const dy = world.y - dragStartWorld[1];

    const badgeChild = badgesContainer.children.find((c) => c.label === dragUnitId);
    if (badgeChild) {
      badgeChild.position.set(dragStartAnchor[0] + dx, dragStartAnchor[1] + dy);
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!isDraggingBadge || !dragUnitId) return;
    isDraggingBadge = false;
    viewport.plugins.resume('drag');

    const canvas = app.canvas;
    const rect = canvas?.getBoundingClientRect() || root?.getBoundingClientRect();
    if (rect) {
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const world = viewport.toWorld(screenX, screenY);
      const dx = world.x - dragStartWorld[0];
      const dy = world.y - dragStartWorld[1];

      if (Math.hypot(dx, dy) >= 1) {
        const dep = battle.deployments.find((d) => d.unitId === dragUnitId);
        if (dep && dep.placement.state === 'known') {
          const moved = translateDeployment(dep, [dx, dy]);
          const batch: UnitEditBatch = {
            units: { upsert: [], remove: [] },
            deployments: { upsert: [moved], removeByUnitId: [] },
            sources: { upsert: [] },
          };
          applyFieldBattleBatch(battle, batch);
          ctx.onChange('units');
        }
      }
    }
    dragUnitId = null;
    renderBadges();
  };

  const onPointerCancel = () => {
    if (!isDraggingBadge) return;
    isDraggingBadge = false;
    dragUnitId = null;
    viewport.plugins.resume('drag');
    renderBadges();
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  // 5. 视角手势防抖通知 (moved / zoomed 后 debounce 或 pointerup 写 battle.view 并 emit 'view')
  let viewDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleViewChange(): void {
    if (viewDebounceTimer) clearTimeout(viewDebounceTimer);
    viewDebounceTimer = setTimeout(() => {
      viewDebounceTimer = null;
      if (Number.isFinite(viewport.scale.x)) {
        battle.view = {
          scale: viewport.scale.x,
          x: viewport.position.x,
          y: viewport.position.y,
        };
        ctx.onChange('view');
      }
    }, 250);
  }

  function flushViewChange(): void {
    if (viewDebounceTimer) {
      clearTimeout(viewDebounceTimer);
      viewDebounceTimer = null;
      if (Number.isFinite(viewport.scale.x)) {
        battle.view = {
          scale: viewport.scale.x,
          x: viewport.position.x,
          y: viewport.position.y,
        };
        ctx.onChange('view');
      }
    }
  }

  viewport.on('moved', scheduleViewChange);
  viewport.on('zoomed', () => {
    renderBadges(); // 缩放时重绘以保持屏幕恒定尺寸
    scheduleViewChange();
    updateHudState();
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerup', flushViewChange);
  }

  // 6. Target 适配器绑定
  const fieldBattleTarget = createFieldBattleTarget(battle, {
    getCameraCenter: () => [viewport.center.x, viewport.center.y],
    onCommit: () => {
      ctx.onChange('units');
      renderBadges();
    },
  });

  // 删除选中单位
  function deleteSelected(): void {
    if (!selectedUnitId) return;
    if (!battle.units.some((u) => u.id === selectedUnitId)) {
      selectedUnitId = null;
      renderBadges();
      updateHudState();
      return;
    }
    const unitId = selectedUnitId;
    const batch: UnitEditBatch = {
      units: { upsert: [], remove: [unitId] },
      deployments: { upsert: [], removeByUnitId: [unitId] },
      sources: { upsert: [] },
    };
    applyFieldBattleBatch(battle, batch);
    selectedUnitId = null;
    ctx.onChange('units');
    renderBadges();
  }

function ensureSceneStyles(): void {
  if (typeof document === 'undefined') return;
  const styleId = 'field-battle-scene-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    #field-battle-toolbar {
      position: absolute;
      top: 10px;
      left: 12px;
      max-width: calc(100% - 24px);
      z-index: 20;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      background: rgba(15, 23, 42, 0.88);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid rgba(56, 189, 248, 0.3);
      color: #f1f5f9;
      font-size: 12px;
      user-select: none;
      box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.6), 0 0 16px rgba(56, 189, 248, 0.1);
      box-sizing: border-box;
    }
    .fb-tool-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .fb-tool-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.4px;
      color: #94a3b8;
      display: flex;
      align-items: center;
      gap: 5px;
      cursor: default;
    }
    #field-battle-style {
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 12px;
      cursor: pointer;
      outline: none;
      transition: all 0.15s ease;
    }
    #field-battle-style:hover, #field-battle-style:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
    }
    #field-battle-scale, #field-battle-city-scale {
      width: 68px;
      height: 4px;
      accent-color: #38bdf8;
      cursor: pointer;
      vertical-align: middle;
    }
    .fb-check-label {
      font-size: 11px;
      color: #cbd5e1;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      white-space: nowrap;
    }
    .fb-check-label input {
      accent-color: #38bdf8;
      cursor: pointer;
    }
    .fb-scale-badge {
      font-size: 11px;
      color: #38bdf8;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-weight: 600;
      min-width: 34px;
    }
    .fb-divider {
      width: 1px;
      height: 18px;
      background: rgba(148, 163, 184, 0.25);
      margin: 0 2px;
    }
    .fb-btn {
      border: none;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
      outline: none;
      line-height: 1.2;
    }
    #field-battle-new-unit {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      color: #ffffff;
      border: 1px solid #38bdf8;
      box-shadow: 0 2px 8px rgba(2, 132, 199, 0.35);
    }
    #field-battle-new-unit:hover {
      background: linear-gradient(135deg, #0369a1 0%, #0284c7 100%);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.5);
      transform: translateY(-1px);
    }
    #field-battle-new-unit:active {
      transform: translateY(0);
    }
    #field-battle-delete {
      background: linear-gradient(135deg, #991b1b 0%, #7f1d1d 100%);
      color: #ffffff;
      border: 1px solid #f87171;
      box-shadow: 0 2px 8px rgba(185, 28, 28, 0.3);
    }
    #field-battle-delete:hover {
      background: linear-gradient(135deg, #b91c1c 0%, #991b1b 100%);
      box-shadow: 0 0 12px rgba(248, 113, 113, 0.5);
      transform: translateY(-1px);
    }
    #field-battle-delete:active {
      transform: translateY(0);
    }
    .fb-icon-btn {
      background: rgba(30, 41, 59, 0.8);
      color: #cbd5e1;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 6px;
      width: 26px;
      height: 26px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.15s ease;
      outline: none;
    }
    .fb-icon-btn:hover {
      background: rgba(56, 189, 248, 0.2);
      border-color: #38bdf8;
      color: #ffffff;
      box-shadow: 0 0 8px rgba(56, 189, 248, 0.3);
    }
    .fb-icon-btn:active {
      transform: scale(0.95);
    }
    #field-battle-hud {
      position: absolute;
      bottom: 12px;
      left: 12px;
      right: 12px;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: space-between;
      pointer-events: none;
      font-size: 11px;
      color: #94a3b8;
      user-select: none;
    }
    .fb-hud-panel {
      pointer-events: auto;
      background: rgba(15, 23, 42, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(56, 189, 248, 0.25);
      border-radius: 6px;
      padding: 5px 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
    }
    .fb-hud-badge {
      color: #38bdf8;
      font-weight: 600;
      letter-spacing: 0.3px;
    }
    .fb-key {
      background: rgba(30, 41, 59, 0.9);
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 3px;
      padding: 1px 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10px;
      color: #f1f5f9;
      margin: 0 2px;
    }
  `;
  document.head.appendChild(style);
}

  // 7. 工具栏 DOM 构建与事件监听
  let toolbarEl = root?.querySelector<HTMLElement>(FIELD_BATTLE_DOM.toolbar);
  let toolbarCreatedHere = false;
  let hudEl: HTMLElement | null = null;
  let hudCreatedHere = false;

  if (root && typeof document !== 'undefined') {
    ensureSceneStyles();
  }

  if (!toolbarEl && root && typeof document !== 'undefined') {
    toolbarCreatedHere = true;
    toolbarEl = document.createElement('div');
    toolbarEl.id = FIELD_BATTLE_DOM.toolbar.slice(1);

    // 样式选择框
    const styleLabel = document.createElement('label');
    styleLabel.className = 'fb-tool-label';
    styleLabel.textContent = '样式:';

    const styleSelect = document.createElement('select');
    styleSelect.id = FIELD_BATTLE_DOM.style.slice(1);
    styleSelect.innerHTML = `
      <option value="standard">标准兵牌</option>
      <option value="compact">紧凑微标</option>
      <option value="minimal">纯军标</option>
    `;
    styleSelect.value = battle.badgeStyle || 'standard';
    styleLabel.appendChild(styleSelect);

    // 兵牌大小滑块
    const scaleLabel = document.createElement('label');
    scaleLabel.className = 'fb-tool-label';
    scaleLabel.textContent = '兵牌:';

    const scaleInput = document.createElement('input');
    scaleInput.id = FIELD_BATTLE_DOM.scale.slice(1);
    scaleInput.type = 'range';
    scaleInput.min = '0.35';
    scaleInput.max = '2.4';
    scaleInput.step = '0.05';
    const initScale = battle.badgeScale ?? 1;
    scaleInput.value = String(initScale);

    const scaleBadge = document.createElement('span');
    scaleBadge.className = 'fb-scale-badge';
    scaleBadge.textContent = `${Math.round(initScale * 100)}%`;

    scaleLabel.append(scaleInput, scaleBadge);

    // 城市名大小与动态开关
    const divCity = document.createElement('div');
    divCity.className = 'fb-divider';

    const cityScaleLabel = document.createElement('label');
    cityScaleLabel.className = 'fb-tool-label';
    cityScaleLabel.textContent = '城名:';

    const cityScaleInput = document.createElement('input');
    cityScaleInput.id = 'field-battle-city-scale';
    cityScaleInput.type = 'range';
    cityScaleInput.min = '0.5';
    cityScaleInput.max = '2.4';
    cityScaleInput.step = '0.05';
    cityScaleInput.value = String(cityLabelScale);

    const cityScaleBadge = document.createElement('span');
    cityScaleBadge.id = 'field-battle-city-scale-val';
    cityScaleBadge.className = 'fb-scale-badge';
    cityScaleBadge.textContent = `${Math.round(cityLabelScale * 100)}%`;
    cityScaleLabel.append(cityScaleInput, cityScaleBadge);

    const cityZoomLabel = document.createElement('label');
    cityZoomLabel.className = 'fb-check-label';
    const cityZoomInput = document.createElement('input');
    cityZoomInput.id = 'field-battle-city-zoom';
    cityZoomInput.type = 'checkbox';
    cityZoomInput.checked = cityLabelZoomBoost;
    const cityZoomText = document.createElement('span');
    cityZoomText.textContent = '随缩放';
    cityZoomLabel.append(cityZoomInput, cityZoomText);

    const cityLodLabel = document.createElement('label');
    cityLodLabel.className = 'fb-check-label';
    const cityLodInput = document.createElement('input');
    cityLodInput.id = 'field-battle-city-lod';
    cityLodInput.type = 'checkbox';
    cityLodInput.checked = cityLabelDynamicLod;
    const cityLodText = document.createElement('span');
    cityLodText.textContent = '分级避让';
    cityLodLabel.append(cityLodInput, cityLodText);

    // 分隔线
    const div1 = document.createElement('div');
    div1.className = 'fb-divider';

    // 新建兵牌按钮
    const newUnitBtn = document.createElement('button');
    newUnitBtn.id = FIELD_BATTLE_DOM.newUnit.slice(1);
    newUnitBtn.type = 'button';
    newUnitBtn.className = 'fb-btn';
    newUnitBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="12" y1="5" x2="12" y2="19"></line>
        <line x1="5" y1="12" x2="19" y2="12"></line>
      </svg>
      <span>新建兵牌</span>
    `;

    // 删除选中按钮
    const deleteBtn = document.createElement('button');
    deleteBtn.id = FIELD_BATTLE_DOM.delete.slice(1);
    deleteBtn.type = 'button';
    deleteBtn.className = 'fb-btn';
    deleteBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
      <span>删除选中</span>
    `;

    // 分隔线
    const div2 = document.createElement('div');
    div2.className = 'fb-divider';

    // 视角居中复位
    const fitBtn = document.createElement('button');
    fitBtn.id = 'field-battle-fit';
    fitBtn.type = 'button';
    fitBtn.className = 'fb-icon-btn';
    fitBtn.title = '视角居中复位';
    fitBtn.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="22" y1="12" x2="18" y2="12"></line>
        <line x1="6" y1="12" x2="2" y2="12"></line>
        <line x1="12" y1="6" x2="12" y2="2"></line>
        <line x1="12" y1="22" x2="12" y2="18"></line>
      </svg>
    `;

    // 撤销与重做
    const undoBtn = document.createElement('button');
    undoBtn.id = 'field-battle-undo';
    undoBtn.type = 'button';
    undoBtn.className = 'fb-icon-btn';
    undoBtn.title = '撤销 (Ctrl+Z)';
    undoBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="1 4 1 10 7 10"></polyline>
        <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
      </svg>
    `;

    const redoBtn = document.createElement('button');
    redoBtn.id = 'field-battle-redo';
    redoBtn.type = 'button';
    redoBtn.className = 'fb-icon-btn';
    redoBtn.title = '重做 (Ctrl+Y)';
    redoBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"></polyline>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
      </svg>
    `;

    toolbarEl.append(styleLabel, scaleLabel, divCity, cityScaleLabel, cityZoomLabel, cityLodLabel, div1, newUnitBtn, deleteBtn, div2, fitBtn, undoBtn, redoBtn);
    root.appendChild(toolbarEl);
  }

  // 底部战术 HUD 仪表条构建
  if (root && typeof document !== 'undefined') {
    hudCreatedHere = true;
    hudEl = document.createElement('div');
    hudEl.id = 'field-battle-hud';
    hudEl.innerHTML = `
      <div class="fb-hud-panel" id="fb-hud-left">
        <span class="fb-hud-badge">⚔️ 态势</span>
        <span id="fb-hud-info">编制: ${battle.units.length} 队</span>
      </div>
      <div class="fb-hud-panel" id="fb-hud-right">
        <span><span class="fb-key">滚轮</span> 缩放 · <span class="fb-key">Space</span> 漫游 · <span class="fb-key">拖拽</span> 部署 · <span class="fb-key">Del</span> 撤编 · <span class="fb-key">Ctrl+Z</span> 撤销</span>
        <span class="fb-divider" style="height: 12px; margin: 0 4px;"></span>
        <span id="fb-hud-zoom" style="color:#38bdf8;font-family:monospace;font-weight:600;">${Math.round(viewport.scale.x * 100)}%</span>
      </div>
    `;
    root.appendChild(hudEl);
  }

  updateHudState = () => {
    if (!hudEl) return;
    const infoEl = hudEl.querySelector<HTMLElement>('#fb-hud-info');
    if (infoEl) {
      if (selectedUnitId) {
        const found = battle.units.find(u => u.id === selectedUnitId);
        const name = found?.unitName?.state === 'known' ? found.unitName.value : selectedUnitId;
        const doc = infoEl.ownerDocument ?? document;
        const bold = doc.createElement('b');
        bold.style.color = '#f8fafc';
        bold.textContent = name;
        infoEl.replaceChildren(
          doc.createTextNode('已选中: '),
          bold,
          doc.createTextNode(' (按 Del 撤编)'),
        );
      } else {
        infoEl.textContent = `编制: ${battle.units.length} 队`;
      }
    }
    const zoomEl = hudEl.querySelector<HTMLElement>('#fb-hud-zoom');
    if (zoomEl && Number.isFinite(viewport.scale?.x)) {
      zoomEl.textContent = `${Math.round(viewport.scale.x * 100)}%`;
    }
  };

  // 绑定工具栏 DOM 事件
  let cleanupToolbarListeners: (() => void) | null = null;
  if (toolbarEl) {
    toolbarEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      setInputOwner('fieldbattle');
    });

    const styleSel = toolbarEl.querySelector<HTMLSelectElement>(FIELD_BATTLE_DOM.style);
    const scaleInp = toolbarEl.querySelector<HTMLInputElement>(FIELD_BATTLE_DOM.scale);
    const scaleBadgeEl = toolbarEl.querySelector<HTMLElement>('.fb-scale-badge');
    const cityScaleInp = toolbarEl.querySelector<HTMLInputElement>('#field-battle-city-scale');
    const cityScaleBadgeEl = toolbarEl.querySelector<HTMLElement>('#field-battle-city-scale-val');
    const cityZoomInp = toolbarEl.querySelector<HTMLInputElement>('#field-battle-city-zoom');
    const cityLodInp = toolbarEl.querySelector<HTMLInputElement>('#field-battle-city-lod');
    const newBtn = toolbarEl.querySelector<HTMLButtonElement>(FIELD_BATTLE_DOM.newUnit);
    const delBtn = toolbarEl.querySelector<HTMLButtonElement>(FIELD_BATTLE_DOM.delete);
    const fitBtnEl = toolbarEl.querySelector<HTMLButtonElement>('#field-battle-fit');
    const undoBtnEl = toolbarEl.querySelector<HTMLButtonElement>('#field-battle-undo');
    const redoBtnEl = toolbarEl.querySelector<HTMLButtonElement>('#field-battle-redo');

    const onStyleChange = () => {
      if (!styleSel) return;
      battle.badgeStyle = styleSel.value as FieldBadgeStyle;
      renderBadges();
      ctx.onChange('style');
    };

    const onScaleInput = () => {
      if (!scaleInp) return;
      const val = Number.parseFloat(scaleInp.value) || 1;
      visualBadgeScale = val;
      if (scaleBadgeEl) scaleBadgeEl.textContent = `${Math.round(val * 100)}%`;
      renderBadges(); // input 时只重绘
    };

    const onScaleChange = () => {
      if (!scaleInp) return;
      visualBadgeScale = null;
      const val = Number.parseFloat(scaleInp.value) || 1;
      battle.badgeScale = val;
      if (scaleBadgeEl) scaleBadgeEl.textContent = `${Math.round(val * 100)}%`;
      renderBadges();
      ctx.onChange('style'); // change 时写 battle.badgeScale 并 emit 'style'
    };

    const onNewUnitClick = () => {
      openGarrisonCustomModal({
        target: fieldBattleTarget,
        onSaved: () => {
          renderBadges();
          updateHudState();
        },
      });
    };

    const onDeleteClick = () => {
      deleteSelected();
      updateHudState();
    };

    const syncSelectedUnit = () => {
      if (selectedUnitId && !battle.units.some((u) => u.id === selectedUnitId)) {
        selectedUnitId = null;
      }
    };

    const onFitClick = () => {
      viewport.scale.set(fitScale);
      viewport.moveCenter(
        (outlineBounds.minX + outlineBounds.maxX) / 2,
        (outlineBounds.minY + outlineBounds.maxY) / 2
      );
      constrainPosition();
      updateBurgScale();
      renderBadges();
      scheduleViewChange();
      updateHudState();
    };

    const onUndoClick = () => {
      if (undoFieldBattle(battle)) {
        syncSelectedUnit();
        ctx.onChange('units');
        renderBadges();
        updateHudState();
      }
    };

    const onRedoClick = () => {
      if (redoFieldBattle(battle)) {
        syncSelectedUnit();
        ctx.onChange('units');
        renderBadges();
        updateHudState();
      }
    };

    const onCityScaleInput = () => {
      if (!cityScaleInp) return;
      const val = Math.max(0.5, Math.min(2.4, Number.parseFloat(cityScaleInp.value) || 1));
      cityLabelScale = val;
      if (cityScaleBadgeEl) cityScaleBadgeEl.textContent = `${Math.round(val * 100)}%`;
      updateBurgScale();
    };

    const onCityZoomChange = () => {
      if (!cityZoomInp) return;
      cityLabelZoomBoost = Boolean(cityZoomInp.checked);
      updateBurgScale();
    };

    const onCityLodChange = () => {
      if (!cityLodInp) return;
      cityLabelDynamicLod = Boolean(cityLodInp.checked);
      updateBurgScale();
    };

    styleSel?.addEventListener('change', onStyleChange);
    scaleInp?.addEventListener('input', onScaleInput);
    scaleInp?.addEventListener('change', onScaleChange);
    cityScaleInp?.addEventListener('input', onCityScaleInput);
    cityZoomInp?.addEventListener('change', onCityZoomChange);
    cityLodInp?.addEventListener('change', onCityLodChange);
    newBtn?.addEventListener('click', onNewUnitClick);
    delBtn?.addEventListener('click', onDeleteClick);
    fitBtnEl?.addEventListener('click', onFitClick);
    undoBtnEl?.addEventListener('click', onUndoClick);
    redoBtnEl?.addEventListener('click', onRedoClick);

    cleanupToolbarListeners = () => {
      styleSel?.removeEventListener('change', onStyleChange);
      scaleInp?.removeEventListener('input', onScaleInput);
      scaleInp?.removeEventListener('change', onScaleChange);
      cityScaleInp?.removeEventListener('input', onCityScaleInput);
      cityZoomInp?.removeEventListener('change', onCityZoomChange);
      cityLodInp?.removeEventListener('change', onCityLodChange);
      newBtn?.removeEventListener('click', onNewUnitClick);
      delBtn?.removeEventListener('click', onDeleteClick);
      fitBtnEl?.removeEventListener('click', onFitClick);
      undoBtnEl?.removeEventListener('click', onUndoClick);
      redoBtnEl?.removeEventListener('click', onRedoClick);
    };
  }

  const syncSelectedAfterHistory = () => {
    if (selectedUnitId && !battle.units.some((u) => u.id === selectedUnitId)) {
      selectedUnitId = null;
    }
  };
  const closeDesignerModal = (designerModal: Element): void => {
    const closeBtn = designerModal.querySelector<HTMLButtonElement>('#modal-close-btn');
    if (closeBtn) closeBtn.click();
    else designerModal.remove();
  };

  const isDesignerModalOpen = (): boolean => {
    if (typeof document === 'undefined') return false;
    const modal =
      document.getElementById('garrison-custom-modal') ||
      document.querySelector<HTMLElement>(FIELD_BATTLE_DOM.designer);
    if (!modal) return false;
    if ((modal as HTMLElement).hidden) return false;
    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(modal);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } else if ((modal as HTMLElement).style?.display === 'none') {
      return false;
    }
    return true;
  };

  // 8. 键盘交互（Delete, Ctrl+Z/Y, Esc, Space）
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isFieldBattleOwner()) return;
    if (isTextInput(e.target)) return;

    // Esc: 先取消设计器，否则清空选择
    if (e.key === 'Escape') {
      const designerModal =
        typeof document !== 'undefined'
          ? document.getElementById('garrison-custom-modal') ||
            document.querySelector(FIELD_BATTLE_DOM.designer)
          : null;
      if (designerModal) {
        closeDesignerModal(designerModal);
        return;
      }
      if (selectedUnitId !== null) {
        selectedUnitId = null;
        renderBadges();
        updateHudState();
        return;
      }
      return;
    }

    // Delete / Backspace: 删除选中兵牌（设计器打开且可见时跳过，防止误删背后兵牌）
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (isDesignerModalOpen()) return;
      if (selectedUnitId) {
        e.preventDefault();
        deleteSelected();
        updateHudState();
      }
      return;
    }

    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y: 独立撤销栈
    const isCtrl = e.ctrlKey || e.metaKey;
    if (isCtrl && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) {
        if (redoFieldBattle(battle)) {
          syncSelectedAfterHistory();
          ctx.onChange('units');
          renderBadges();
          updateHudState();
        }
      } else {
        if (undoFieldBattle(battle)) {
          syncSelectedAfterHistory();
          ctx.onChange('units');
          renderBadges();
          updateHudState();
        }
      }
      return;
    }
    if (isCtrl && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      if (redoFieldBattle(battle)) {
        syncSelectedAfterHistory();
        ctx.onChange('units');
        renderBadges();
        updateHudState();
      }
      return;
    }

    // Space: 由战场处理，不得触发主地图漫游
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
  }

  const onPointerDownRoot = () => {
    setInputOwner('fieldbattle');
  };
  root?.addEventListener('pointerdown', onPointerDownRoot);

  // 9. 销毁与保存视角句柄
  return {
    destroy(): void {
      app.renderer.off('resize', onResize);
      if (viewDebounceTimer) clearTimeout(viewDebounceTimer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        window.removeEventListener('pointercancel', onPointerCancel);
        window.removeEventListener('pointerup', flushViewChange);
        window.removeEventListener('keydown', onKeyDown);
      }
      root?.removeEventListener('pointerdown', onPointerDownRoot);

      // 关闭设计器（未保存按取消）
      const designerModal =
        typeof document !== 'undefined'
          ? document.getElementById('garrison-custom-modal') ||
            document.querySelector(FIELD_BATTLE_DOM.designer)
          : null;
      if (designerModal) {
        closeDesignerModal(designerModal);
      }

      // 重置本战场历史撤销栈
      resetFieldBattleHistory(battle.id);

      // 移除工具栏 DOM
      cleanupToolbarListeners?.();
      if (toolbarCreatedHere && toolbarEl?.parentElement) {
        toolbarEl.parentElement.removeChild(toolbarEl);
      }

      // 移除底部战术 HUD DOM
      if (hudCreatedHere && hudEl?.parentElement) {
        hudEl.parentElement.removeChild(hudEl);
      }

      // 仅销毁本场景自建的裁剪纹理句柄（不销毁主地图共享 TextureSource）
      if (localImageTexture) {
        localImageTexture.destroy(ownsLocalImageSource);
        localImageTexture = null;
      }

      // 从 host 移除并销毁相机容器（释放全部 GraphicsContext，但不销毁主地图共享纹理）
      baseImageLayer.mask = null;
      if (viewport.parent) {
        viewport.parent.removeChild(viewport);
      }
      viewport.destroy({ children: true, texture: false, textureSource: false, context: true });
    },

    saveView(): { scale: number; x: number; y: number } | undefined {
      if (
        Number.isFinite(viewport.scale?.x) &&
        Number.isFinite(viewport.position?.x) &&
        Number.isFinite(viewport.position?.y)
      ) {
        return {
          scale: viewport.scale.x,
          x: viewport.position.x,
          y: viewport.position.y,
        };
      }
      return battle.view;
    },
  };
}

// 自动向窗口包注册本场景工场
setFieldBattleSceneFactory(createFieldBattleScene);
