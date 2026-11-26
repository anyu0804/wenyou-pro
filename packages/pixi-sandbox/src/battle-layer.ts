import { Assets, Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type {
  Battlefield,
  BattlePoint,
  BattleWorkspace,
  BattleUnit,
  BattleDeployment,
} from './battle-contract';

export interface BattleRenderOptions {
  /** 视图缩放系数（用于 Level-of-Detail 分级显示），默认 1.0 */
  scale?: number;
  /** 当前选中的单位 ID 列表（高亮显示） */
  selectedUnitIds?: string[];
  /** 是否显示地形特征（障碍、部署区、道路、通行口），默认 true */
  showTerrain?: boolean;
  /** 是否显示部署几何（正面折线、占地多边形），默认 true */
  showDeployments?: boolean;
  /** 是否显示兵牌标牌，默认 true */
  showBadges?: boolean;
  /** 临时标牌避让偏移映射（unitId -> [offsetX, offsetY]），不修改实际部署锚点 */
  badgeOffsets?: Map<string, BattlePoint>;
  /** 只渲染特定战场 ID；若不指定则渲染全部战场 */
  battlefieldId?: string;
  badgeStyle?: 'standard' | 'compact' | 'minimal';
  badgeScale?: number;
}

/** 辅助：十六进制颜色字符串转换为数字 */
export function colorToHex(colorStr?: string, defaultHex = 0x3b82f6): number {
  if (!colorStr) return defaultHex;
  const cleaned = colorStr.replace('#', '').trim();
  if (cleaned.length === 6 || cleaned.length === 8) {
    const parsed = parseInt(cleaned.substring(0, 6), 16);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (cleaned.length === 3) {
    const expanded = cleaned.split('').map((c) => c + c).join('');
    const parsed = parseInt(expanded, 16);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return defaultHex;
}

/** 辅助：根据朝向度数（0上、90右、180下、270左，顺时针）计算朝向向量 (dirX, dirY) */
export function getFacingVector(degrees: number): BattlePoint {
  const rad = (degrees * Math.PI) / 180;
  // 0度向上 (0, -1), 90度向右 (1, 0), 180度向下 (0, 1), 270度向左 (-1, 0)
  return [Math.sin(rad), -Math.cos(rad)];
}

import {
  getEchelonSymbol,
  resolveTroopEchelon,
  resolveRequirementTotem,
} from './military-symbols';

export {
  getEchelonSymbol,
  resolveTroopEchelon,
  resolveRequirementTotem,
};

/** 辅助：绘制虚线段 */
function drawDashedLine(
  g: Graphics,
  p1: BattlePoint,
  p2: BattlePoint,
  dashLen = 6,
  gapLen = 4
): void {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return;

  const nx = dx / dist;
  const ny = dy / dist;
  let cursor = 0;
  let drawing = true;

  while (cursor < dist) {
    const seg = drawing ? dashLen : gapLen;
    const nextCursor = Math.min(cursor + seg, dist);
    const startX = p1[0] + nx * cursor;
    const startY = p1[1] + ny * cursor;
    const endX = p1[0] + nx * nextCursor;
    const endY = p1[1] + ny * nextCursor;

    if (drawing) {
      g.moveTo(startX, startY);
      g.lineTo(endX, endY);
    }
    cursor = nextCursor;
    drawing = !drawing;
  }
}

/** 辅助：绘制虚线折线 */
function drawDashedPolyline(
  g: Graphics,
  points: BattlePoint[],
  dashLen = 6,
  gapLen = 4
): void {
  for (let i = 0; i < points.length - 1; i++) {
    drawDashedLine(g, points[i], points[i + 1], dashLen, gapLen);
  }
}

/** 渲染战场与地形 */
function renderTerrainFeatures(
  container: Container,
  battlefield: Battlefield,
  isPlan: boolean
): void {
  const terrainGfx = new Graphics();
  container.addChild(terrainGfx);

  // 1. 战场外边界
  if (battlefield.boundary.state === 'known') {
    const boundary = battlefield.boundary.value;
    for (const polygon of boundary) {
      if (polygon.length === 0) continue;
      const outerRing = polygon[0];
      const holes = polygon.slice(1);
      const flatPoints = outerRing.flatMap(([x, y]) => [x, y]);

      terrainGfx.poly(flatPoints, true);
      terrainGfx.fill({ color: 0x1e293b, alpha: 0.12 });
      for (const holeRing of holes) {
        terrainGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true).cut();
      }
      if (isPlan) {
        // plan 采用虚线轮廓；Pixi v8 需先累积路径再 stroke
        drawDashedPolyline(terrainGfx, outerRing, 8, 5);
        for (const holeRing of holes) drawDashedPolyline(terrainGfx, holeRing, 8, 5);
        terrainGfx.stroke({ width: 1.5, color: 0x64748b, alpha: 0.8 });
      } else {
        terrainGfx.poly(flatPoints, true);
        for (const holeRing of holes) terrainGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true);
        terrainGfx.stroke({ width: 2, color: 0x475569, alpha: 0.9 });
      }
    }
  }

  // 2. 地形特征
  for (const feat of battlefield.terrain) {
    const featIsPlan = feat.assertion === 'plan';

    if (feat.kind === 'obstacle' && feat.area.state === 'known') {
      // 障碍：暗红警戒多边形
      for (const poly of feat.area.value) {
        if (poly.length === 0) continue;
        const outer = poly[0];
        const holes = poly.slice(1);
        const flat = outer.flatMap(([x, y]) => [x, y]);
        terrainGfx.poly(flat, true);
        terrainGfx.fill({ color: 0xef4444, alpha: 0.22 });
        for (const holeRing of holes) {
          terrainGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true).cut();
        }
        terrainGfx.poly(flat, true);
        for (const holeRing of holes) terrainGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true);
        terrainGfx.stroke({ width: 1.5, color: 0xdc2626, alpha: 0.85 });
      }
    } else if (feat.kind === 'deployment-zone' && feat.area.state === 'known') {
      // 部署容许区：青绿色半透明多边形
      for (const poly of feat.area.value) {
        if (poly.length === 0) continue;
        const outer = poly[0];
        const holes = poly.slice(1);
        const flat = outer.flatMap(([x, y]) => [x, y]);
        terrainGfx.poly(flat, true);
        terrainGfx.fill({ color: 0x10b981, alpha: 0.15 });
        for (const holeRing of holes) {
          terrainGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true).cut();
        }
        if (featIsPlan) {
          drawDashedPolyline(terrainGfx, outer, 6, 4);
          for (const holeRing of holes) drawDashedPolyline(terrainGfx, holeRing, 6, 4);
          terrainGfx.stroke({ width: 1.5, color: 0x059669, alpha: 0.8 });
        } else {
          terrainGfx.poly(flat, true);
          for (const holeRing of holes) terrainGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true);
          terrainGfx.stroke({ width: 1.5, color: 0x059669, alpha: 0.8 });
        }
      }
    } else if (feat.kind === 'passage-line' && feat.line.state === 'known') {
      // 通行线：黄色道路折线
      const line = feat.line.value;
      if (featIsPlan) {
        drawDashedPolyline(terrainGfx, line, 6, 4);
        terrainGfx.stroke({ width: 2, color: 0xfbbf24, alpha: 0.9 });
      } else {
        terrainGfx.poly(line.flatMap(([x, y]) => [x, y]), false);
        terrainGfx.stroke({ width: 2.5, color: 0xd97706, alpha: 0.95 });
      }
    } else if (feat.kind === 'passage' && feat.point.state === 'known') {
      // 通行口：桥梁/渡口/隘口专用图标
      const [px, py] = feat.point.value;
      terrainGfx.circle(px, py, 5);
      terrainGfx.fill({ color: 0x38bdf8, alpha: 0.9 });
      terrainGfx.stroke({ width: 1.5, color: 0x0284c7, alpha: 1 });

      if (feat.passageKind === 'bridge') {
        // 桥梁双杠标识
        terrainGfx.rect(px - 6, py - 3, 12, 6);
        terrainGfx.stroke({ width: 1.5, color: 0x0284c7 });
      }
    }
  }
}

/** 渲染部署几何（正面折线、占地多边形、朝向箭头、纵深指示） */
function renderDeploymentShapes(
  container: Container,
  deployment: BattleDeployment,
  unit: BattleUnit | undefined,
  isSelected: boolean,
  viewScale: number
): void {
  // 位置未知时严禁绘制地图几何（契约铁律）
  if (deployment.placement.state !== 'known') return;

  const placement = deployment.placement.value;
  const isPlan = deployment.assertion === 'plan';
  const unitColor = unit?.color ? colorToHex(unit.color) : 0x2563eb;
  const strokeColor = isSelected ? 0xffffff : unitColor;
  const shapeGfx = new Graphics();
  container.addChild(shapeGfx);

  // 1. 绘制正面折线 (frontage)
  if (placement.shape.kind === 'frontage') {
    const line = placement.shape.line;
    if (isPlan) {
      drawDashedPolyline(shapeGfx, line, 8, 4);
      shapeGfx.stroke({ width: 3.5, color: strokeColor, alpha: 0.95 });
    } else {
      shapeGfx.poly(line.flatMap(([x, y]) => [x, y]), false);
      shapeGfx.stroke({ width: 4, color: strokeColor, alpha: 1 });
    }

    // 正面端点标
    for (const pt of [line[0], line[line.length - 1]]) {
      shapeGfx.circle(pt[0], pt[1], 3.5);
      shapeGfx.fill({ color: strokeColor, alpha: 1 });
    }
  }

  // 2. 绘制占地区域 (area)
  if (placement.shape.kind === 'area') {
    const multiPoly = placement.shape.area;
    for (const polygon of multiPoly) {
      if (polygon.length === 0) continue;
      const outerRing = polygon[0];
      const flat = outerRing.flatMap(([x, y]) => [x, y]);
      const holes = polygon.slice(1);

      shapeGfx.poly(flat, true);
      shapeGfx.fill({ color: unitColor, alpha: isSelected ? 0.45 : 0.28 });
      for (const holeRing of holes) {
        shapeGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true).cut();
      }

      if (isPlan) {
        drawDashedPolyline(shapeGfx, outerRing, 7, 4);
        shapeGfx.stroke({ width: 2, color: strokeColor, alpha: 0.95 });
      } else {
        shapeGfx.poly(flat, true);
        shapeGfx.stroke({ width: 2.5, color: strokeColor, alpha: 1 });
      }

      // 孔洞边界单独描边；填充已由 cut() 挖空
      for (const holeRing of holes) {
        shapeGfx.poly(holeRing.flatMap(([x, y]) => [x, y]), true);
        shapeGfx.stroke({ width: 1.5, color: 0xef4444, alpha: 0.8 });
      }
    }
  }

  // 3. 绘制朝向指示箭头与军事纵深
  if (deployment.facingDegrees.state === 'known') {
    const deg = deployment.facingDegrees.value;
    const [dirX, dirY] = getFacingVector(deg);
    const anchor = placement.anchor;

    // 朝向箭头长度（根据视图缩放适当调整或保持战术固定长度）
    const arrowLen = Math.max(18, 26 / Math.sqrt(viewScale));
    const targetX = anchor[0] + dirX * arrowLen;
    const targetY = anchor[1] + dirY * arrowLen;

    shapeGfx.moveTo(anchor[0], anchor[1]);
    shapeGfx.lineTo(targetX, targetY);
    shapeGfx.stroke({ width: 2.5, color: strokeColor, alpha: 0.95 });

    // 箭头头部两侧张开标
    const headLen = 6;
    const orthoX = -dirY;
    const orthoY = dirX;
    shapeGfx.moveTo(targetX, targetY);
    shapeGfx.lineTo(targetX - dirX * headLen + orthoX * 4, targetY - dirY * headLen + orthoY * 4);
    shapeGfx.moveTo(targetX, targetY);
    shapeGfx.lineTo(targetX - dirX * headLen - orthoX * 4, targetY - dirY * headLen - orthoY * 4);
    shapeGfx.stroke({ width: 2, color: strokeColor, alpha: 0.95 });

    // 4. 纵深后沿参考线 (depthMapUnits)
    if (deployment.depthMapUnits.state === 'known' && deployment.depthMapUnits.value > 0) {
      const depth = deployment.depthMapUnits.value;
      const backX = anchor[0] - dirX * depth;
      const backY = anchor[1] - dirY * depth;
      const span = 16;
      const p1: BattlePoint = [backX + orthoX * span, backY + orthoY * span];
      const p2: BattlePoint = [backX - orthoX * span, backY - orthoY * span];

      drawDashedLine(shapeGfx, p1, p2, 4, 3);
      shapeGfx.stroke({ width: 1.5, color: strokeColor, alpha: 0.6 });
    }
  }
}

/** 渲染兵牌标牌（Badge），包含番号、层级、兵种、兵力、状态与临时避让 */
export function renderUnitBadge(
  container: Container,
  deployment: BattleDeployment,
  unit: BattleUnit | undefined,
  isSelected: boolean,
  badgeOffset: BattlePoint | undefined,
  viewScale: number,
  style?: 'standard' | 'compact' | 'minimal',
  size = 1
): void {
  // 位置未知时严禁绘制标牌（契约铁律）
  if (deployment.placement.state !== 'known') return;

  const anchor = deployment.placement.value.anchor;
  const offsetX = badgeOffset ? badgeOffset[0] : 0;
  const offsetY = badgeOffset ? badgeOffset[1] : 0;

  // 兵牌是屏幕图形：容器定位在锚点，内部尺寸用 1/viewScale 抵消地图缩放。
  const badgeContainer = new Container();
  badgeContainer.position.set(anchor[0] + offsetX, anchor[1] + offsetY);
  badgeContainer.scale.set(size / viewScale);
  badgeContainer.label = deployment.unitId;
  container.addChild(badgeContainer);

  const badgeGfx = new Graphics();
  badgeContainer.addChild(badgeGfx);

  const unitColor = unit?.color ? colorToHex(unit.color) : 0x2563eb;
  const isPlan = deployment.assertion === 'plan';
  const echelon = unit?.echelon.state === 'known' ? unit.echelon.value : '';
  const troops = unit?.personnel.count.state === 'known' ? unit.personnel.count.value : null;
  const echelonSym = getEchelonSymbol(echelon, troops);
  const tierSpec = resolveTroopEchelon(troops);
  const unitName = unit?.unitName.state === 'known' ? unit.unitName.value : '未知部队';
  const role = deployment.role.state === 'known' ? deployment.role.value : 'line';
  const culture = unit?.customBadge?.culture ?? 'universal';
  const hasCustomIcon = Boolean(unit?.customBadge?.customIconDataUrl?.trim().startsWith('data:image/'));
  const centerGlyph = hasCustomIcon ? '' : (unit?.customBadge?.customGlyph?.trim() || '');
  const customTextColor = unit?.customBadge?.textColor;
  const textResolution = Math.min(3, Math.max(2, size));

  // 人数格式化说明
  let strengthText = '';
  if (troops !== null) {
    const scopeTag = unit?.personnel.scope === 'own' ? '本部'
      : unit?.personnel.scope === 'inclusive' ? '总数' : '旧档未明';
    strengthText = `${troops >= 10000 ? (troops / 10000).toFixed(1) + '万' : troops} (${scopeTag})`;
  } else if (unit?.personnel.count.state === 'unknown') {
    strengthText = '人数未定';
  }

  // 分级缩放 (LOD) 与防重叠尺寸：
  // 纯军标 34×34；紧凑 76×28；标准 96×30（留足双行文字间距与右宽度，杜绝番号与人数重叠或溢框）
  const isMinimal = style ? style === 'minimal' : viewScale < 0.6;

  const badgeW = isMinimal ? 34 : style === 'compact' ? 76 : 96;
  const badgeH = isMinimal ? 34 : style === 'compact' ? 28 : 30;

  // 标牌外框与背景
  const left = -badgeW / 2, top = -badgeH / 2;
  if (culture === 'western') {
    badgeGfx.poly([left, top, -left, top, -left, 0, 0, -top, left, 0]);
  } else if (culture === 'nomad') {
    badgeGfx.poly([left, top, -left, top, -left, -top - 5, 0, -top, left, -top - 5]);
  } else if (culture === 'arcane') {
    badgeGfx.poly([left + 4, top, -left - 4, top, -left, top + 4,
      -left, -top - 4, -left - 4, -top, left + 4, -top, left, -top - 4, left, top + 4]);
  } else {
    badgeGfx.rect(left, top, badgeW, badgeH);
  }
  badgeGfx.fill({ color: 0x0f172a, alpha: 0.92 });
  badgeGfx.stroke({
    width: isSelected ? 2.5 : 1.5,
    color: isSelected ? 0xffffff : unitColor,
    alpha: 0.95,
  });
  if (culture === 'huaxia' || tierSpec.tierIndex >= 4) {
    badgeGfx.rect(left + 2, top + 2, badgeW - 4, badgeH - 4);
    badgeGfx.stroke({ width: tierSpec.tierIndex === 8 ? 1.5 : 0.7,
      color: culture === 'huaxia' || tierSpec.tierIndex >= 6 ? 0xf59e0b : unitColor });
  }
  if (tierSpec.tierIndex === 8) {
    for (const x of [left + 3, -left - 3]) {
      badgeGfx.star(x, 0, 4, 3, 1).fill(0xfacc15);
    }
  }

  let iconCenterX = 0;
  let iconCenterY = 1;

  if (isMinimal) {
    // 顶部军标刻度栏；无自定义中心字或图标时居中放大显示，不再绘制战术图腾
    const hasCenterVisual = Boolean(centerGlyph) || hasCustomIcon;
    const echelonText = new Text({
      text: echelonSym,
      style: new TextStyle({
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontSize: hasCenterVisual ? 9 : 11,
        fontWeight: 'bold',
        fill: customTextColor || '#f8fafc',
      }),
      resolution: textResolution,
    });
    if (hasCenterVisual) {
      echelonText.anchor.set(0.5, 0);
      echelonText.position.set(0, -badgeH / 2 + 2);
    } else {
      echelonText.anchor.set(0.5, 0.5);
      echelonText.position.set(0, -2);
    }
    badgeContainer.addChild(echelonText);

    // 自定义中心大字（仅在玩家主动填写时绘制）
    if (centerGlyph) {
      const centerText = new Text({
        text: centerGlyph,
        style: new TextStyle({
          fontFamily: 'Microsoft YaHei, sans-serif',
          fontSize: centerGlyph.length > 2 ? 10 : 12,
          fontWeight: 'bold',
          fill: customTextColor || '#ffffff',
        }),
        resolution: textResolution,
      });
      centerText.anchor.set(0.5, 0.5);
      centerText.position.set(0, 1);
      badgeContainer.addChild(centerText);
    }

    // 底部精简人数/编制标签
    const bottomLabel = troops !== null
      ? (troops >= 10000 ? `${(troops / 10000).toFixed(0)}万` : String(troops))
      : tierSpec.echelonName;
    const bottomText = new Text({
      text: bottomLabel,
      style: new TextStyle({
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
        fontSize: 8,
        fill: customTextColor || '#cbd5e1',
      }),
      resolution: textResolution,
    });
    bottomText.anchor.set(0.5, 1);
    bottomText.position.set(0, badgeH / 2 - 2);
    badgeContainer.addChild(bottomText);
  } else {
    // 标准/紧凑兵牌：顶部颜色条
    badgeGfx.rect(-badgeW / 2, -badgeH / 2, badgeW, 2.5);
    badgeGfx.fill({ color: unitColor, alpha: 1 });

    // 预备队边框提示
    if (role === 'reserve') {
      badgeGfx.rect(-badgeW / 2 + 1, -badgeH / 2 + 1, 3.5, badgeH - 2);
      badgeGfx.fill({ color: 0xf59e0b, alpha: 0.9 });
    }

    // 左侧内置军标框（在色条下方垂直居中）
    const iconSize = style === 'compact' ? 16 : 20;
    const iconLeft = -badgeW / 2 + 3;
    const iconTop = -badgeH / 2 + 2.5 + (badgeH - 2.5 - iconSize) / 2;
    iconCenterX = iconLeft + iconSize / 2;
    iconCenterY = iconTop + iconSize / 2;
    badgeGfx.rect(iconLeft, iconTop, iconSize, iconSize);
    badgeGfx.stroke({ width: 0.8, color: unitColor, alpha: 0.7 });
    badgeGfx.fill({ color: 0x1e293b, alpha: 0.85 });

    const hasCenterVisual = Boolean(centerGlyph) || hasCustomIcon;
    const iconEchelon = new Text({
      text: echelonSym,
      style: new TextStyle({
        fontFamily: 'Segoe UI, sans-serif',
        fontSize: hasCenterVisual ? 7 : (style === 'compact' ? 8 : 9),
        fontWeight: 'bold',
        fill: customTextColor || '#f8fafc',
      }),
      resolution: textResolution,
    });
    if (hasCenterVisual) {
      iconEchelon.anchor.set(0.5, 0);
      iconEchelon.position.set(iconCenterX, iconTop + 1);
    } else {
      iconEchelon.anchor.set(0.5, 0.5);
      iconEchelon.position.set(iconCenterX, iconCenterY);
    }
    badgeContainer.addChild(iconEchelon);

    // 仅玩家自定义中心字时绘制
    if (centerGlyph) {
      const iconGlyph = new Text({
        text: centerGlyph,
        style: new TextStyle({
          fontFamily: 'Microsoft YaHei, sans-serif',
          fontSize: centerGlyph.length > 2 ? 7.5 : 8.5,
          fill: customTextColor || '#ffffff',
        }),
        resolution: textResolution,
      });
      iconGlyph.anchor.set(0.5, 0.5);
      iconGlyph.position.set(iconCenterX, iconTop + iconSize / 2 + 3.5);
      badgeContainer.addChild(iconGlyph);
    }

    // 右侧文字区：上行番号（与下行人数拉开安全垂直间距，适配 96×30 / 76×28 宽度）
    const nameStr = `${unitName}${isPlan ? ' 方案' : ''}`;
    const nameText = new Text({
      text: style === 'compact'
        ? (nameStr.length > 5 ? `${nameStr.slice(0, 4)}…` : nameStr)
        : (nameStr.length > 7 ? `${nameStr.slice(0, 6)}…` : nameStr),
      style: new TextStyle({
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
        fontSize: 9.5,
        fontWeight: isSelected ? '700' : '600',
        fill: customTextColor || (isSelected ? '#ffffff' : '#f1f5f9'),
      }),
      resolution: textResolution,
    });
    nameText.anchor.set(0, 0);
    nameText.position.set(iconLeft + iconSize + 4, -badgeH / 2 + 4);
    badgeContainer.addChild(nameText);

    // 右侧文字区：下行兵力副标题
    const subText = new Text({
      text: strengthText || `${tierSpec.echelonName}`,
      style: new TextStyle({
        fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
        fontSize: style === 'compact' ? 7.5 : 8,
        fill: customTextColor || '#94a3b8',
      }),
      resolution: textResolution,
    });
    subText.anchor.set(0, 1);
    subText.position.set(iconLeft + iconSize + 4, badgeH / 2 - 2.5);
    badgeContainer.addChild(subText);
  }
  if (hasCustomIcon && unit?.customBadge?.customIconDataUrl) {
    const iconUrl = unit.customBadge.customIconDataUrl;
    void Assets.load<Texture>({ src: iconUrl, parser: 'texture' }).then(texture => {
      // 选择、缩放会销毁旧兵牌；异步图片只加入仍在场的图元。
      if (badgeContainer.destroyed || !badgeContainer.parent) return;
      const icon = new Sprite(texture);
      icon.anchor.set(0.5);
      icon.width = icon.height = isMinimal ? 14 : 11;
      icon.position.set(iconCenterX, isMinimal ? 1 : iconCenterY + 2);
      badgeContainer.addChild(icon);
    }).catch(() => {});
  }
}

/**
 * 战役图层公开签名：读取单一状态绘制战役沙盘图层，不修改军事几何
 * 遵循 contract.md 第 6 节
 */
export function renderBattle(
  workspace: BattleWorkspace,
  container: Container,
  options?: BattleRenderOptions
): void {
  // 清理容器旧子图元及其 Pixi GraphicsContext
  container.removeChildren().forEach(child => child.destroy({ children: true, context: true }));

  const viewScale = options?.scale ?? 1.0;
  const selectedSet = new Set(options?.selectedUnitIds ?? []);
  const showTerrain = options?.showTerrain ?? true;
  const showDeployments = options?.showDeployments ?? true;
  const showBadges = options?.showBadges ?? true;
  const badgeOffsets = options?.badgeOffsets;
  const targetBattlefieldId = options?.battlefieldId;

  // 建立单位查询字典
  const unitMap = new Map<string, BattleUnit>();
  for (const u of workspace.garrisons) {
    unitMap.set(u.id, u);
  }

  // 1. 地形与战场容器
  if (showTerrain) {
    const terrainContainer = new Container();
    terrainContainer.label = 'battle-terrain';
    container.addChild(terrainContainer);

    for (const bf of workspace.battle.battlefields) {
      if (targetBattlefieldId && bf.id !== targetBattlefieldId) continue;
      renderTerrainFeatures(terrainContainer, bf, bf.assertion === 'plan');
    }
  }

  // 2. 部署形态容器（折线、占地、朝向）
  if (showDeployments) {
    const deploymentContainer = new Container();
    deploymentContainer.label = 'battle-deployments';
    container.addChild(deploymentContainer);

    for (const dep of workspace.battle.deployments) {
      if (targetBattlefieldId && dep.battlefieldId.state === 'known') {
        if (dep.battlefieldId.value !== targetBattlefieldId) continue;
      }
      const unit = unitMap.get(dep.unitId);
      const isSelected = selectedSet.has(dep.unitId);
      renderDeploymentShapes(deploymentContainer, dep, unit, isSelected, viewScale);
    }
  }

  // 3. 兵牌标牌容器（最上层，方便交互与避让查看）
  if (showBadges) {
    const badgeContainer = new Container();
    badgeContainer.label = 'battle-badges';
    container.addChild(badgeContainer);

    for (const dep of workspace.battle.deployments) {
      if (targetBattlefieldId && dep.battlefieldId.state === 'known') {
        if (dep.battlefieldId.value !== targetBattlefieldId) continue;
      }
      const unit = unitMap.get(dep.unitId);
      const isSelected = selectedSet.has(dep.unitId);
      const offset = badgeOffsets?.get(dep.unitId);
      renderUnitBadge(badgeContainer, dep, unit, isSelected, offset, viewScale,
        options?.badgeStyle, options?.badgeScale);
    }
  }
}
