import type {
  BattleDeployment,
  BattleEvidence,
  BattleMultiPolygon,
  BattlePoint,
  BattleScale,
  BattleWorkspace,
  Battlefield,
} from './battle-contract';
import { getEchelonSymbol, getFacingVector } from './battle-layer';

export interface BattleExportOptions {
  /** 导出图像宽度，默认 1600 */
  width?: number;
  /** 导出图像高度，默认 1000 */
  height?: number;
  /** 内边距，默认 40 */
  padding?: number;
  /** 已有浏览器 Canvas；省略时通过 document 创建。 */
  canvas?: HTMLCanvasElement;
}

export interface LegendItem {
  kind: 'terrain' | 'unit' | 'assertion';
  label: string;
  color: string;
  style: 'solid' | 'dashed' | 'fill' | 'point';
}

export interface ScaleAnnotation {
  isCalibrated: boolean;
  title: string;
  detail: string;
  pixelsPerMeter?: number;
}

/** 辅助：计算战场和部署的整体二维平面包围盒 */
export function computeBattlefieldBounds(
  battlefield: Battlefield,
  deployments: BattleDeployment[]
): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const expandPoint = (p: BattlePoint) => {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  };

  // 1. 战场外边界
  if (battlefield.boundary.state === 'known') {
    for (const poly of battlefield.boundary.value) {
      for (const ring of poly) {
        for (const pt of ring) expandPoint(pt);
      }
    }
  }

  // 2. 地形要素
  for (const feat of battlefield.terrain) {
    if (feat.kind === 'obstacle' && feat.area.state === 'known') {
      for (const poly of feat.area.value) {
        for (const ring of poly) {
          for (const pt of ring) expandPoint(pt);
        }
      }
    } else if (feat.kind === 'deployment-zone' && feat.area.state === 'known') {
      for (const poly of feat.area.value) {
        for (const ring of poly) {
          for (const pt of ring) expandPoint(pt);
        }
      }
    } else if (feat.kind === 'passage-line' && feat.line.state === 'known') {
      for (const pt of feat.line.value) expandPoint(pt);
    } else if (feat.kind === 'passage' && feat.point.state === 'known') {
      expandPoint(feat.point.value);
    }
  }

  // 3. 部署要素
  for (const dep of deployments) {
    if (dep.placement.state === 'known') {
      const pl = dep.placement.value;
      expandPoint(pl.anchor);
      if (pl.shape.kind === 'frontage') {
        for (const pt of pl.shape.line) expandPoint(pt);
      } else if (pl.shape.kind === 'area') {
        for (const poly of pl.shape.area) {
          for (const ring of poly) {
            for (const pt of ring) expandPoint(pt);
          }
        }
      }
    }
  }

  // 容错：如果无几何点
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1000;
    maxY = 800;
  }

  // 保证最小跨度
  if (maxX - minX < 50) maxX = minX + 50;
  if (maxY - minY < 50) maxY = minY + 50;

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/** 辅助：提取战场及关联部队的所有依据与假设，重点突出 assumption */
export function collectBattlefieldEvidence(
  battlefield: Battlefield,
  workspace: BattleWorkspace,
  deployments: BattleDeployment[]
): {
  sources: { id: string; title: string; text: string }[];
  assumptions: BattleEvidence[];
  quotes: BattleEvidence[];
} {
  const assumptions: BattleEvidence[] = [];
  const quotes: BattleEvidence[] = [];
  const seenEvidence = new Set<string>();

  const addEv = (ev: BattleEvidence) => {
    const key = `${ev.sourceId}:${ev.basis}:${ev.excerpt}`;
    if (seenEvidence.has(key)) return;
    seenEvidence.add(key);
    if (ev.basis === 'assumption') {
      assumptions.push(ev);
    } else {
      quotes.push(ev);
    }
  };

  // 收集战场字段及地形要素的 evidence
  for (const ev of battlefield.name.evidence) addEv(ev);
  for (const ev of battlefield.boundary.evidence) addEv(ev);
  if (battlefield.scale.state === 'calibrated') {
    for (const ev of battlefield.scale.evidence) addEv(ev);
  }
  for (const feat of battlefield.terrain) {
    for (const ev of feat.label.evidence) addEv(ev);
    if (feat.kind === 'obstacle' || feat.kind === 'deployment-zone') {
      for (const ev of feat.area.evidence) addEv(ev);
    } else if (feat.kind === 'passage-line') {
      for (const ev of feat.line.evidence) addEv(ev);
    } else if (feat.kind === 'passage') {
      for (const ev of feat.point.evidence) addEv(ev);
      for (const ev of feat.widthMapUnits.evidence) addEv(ev);
    }
  }

  // 收集部署与单位各字段的 evidence
  const unitMap = new Map(workspace.garrisons.map((u) => [u.id, u]));
  for (const dep of deployments) {
    for (const ev of dep.battlefieldId.evidence) addEv(ev);
    for (const ev of dep.placement.evidence) addEv(ev);
    for (const ev of dep.facingDegrees.evidence) addEv(ev);
    for (const ev of dep.depthMapUnits.evidence) addEv(ev);
    for (const ev of dep.formationLine.evidence) addEv(ev);
    for (const ev of dep.role.evidence) addEv(ev);
    for (const ev of dep.reserveForUnitId.evidence) addEv(ev);
    const unit = unitMap.get(dep.unitId);
    if (unit) {
      for (const ev of unit.unitName.evidence) addEv(ev);
      for (const ev of unit.echelon.evidence) addEv(ev);
      for (const ev of unit.branch.evidence) addEv(ev);
      for (const ev of unit.side.evidence) addEv(ev);
      for (const ev of unit.parentUnitId.evidence) addEv(ev);
      for (const ev of unit.provinceId.evidence) addEv(ev);
      for (const ev of unit.status.evidence) addEv(ev);
      for (const ev of unit.childrenCompleteness.evidence) addEv(ev);
      for (const ev of unit.personnel.count.evidence) addEv(ev);
    }
  }

  // 关联来源
  const sourceIds = new Set([
    ...assumptions.map((a) => a.sourceId),
    ...quotes.map((q) => q.sourceId),
  ]);
  const matchedSources = workspace.battle.sources.filter((s) => sourceIds.has(s.id));

  return {
    sources: matchedSources,
    assumptions,
    quotes,
  };
}

/** 辅助：生成图例数据项 */
export function generateLegendItems(
  battlefield: Battlefield,
  deployments: BattleDeployment[],
  _workspace?: BattleWorkspace
): LegendItem[] {
  const items: LegendItem[] = [];

  // 地形图例
  items.push({ kind: 'terrain', label: '战场范围 (Boundary)', color: '#64748b', style: 'dashed' });

  const kinds = new Set(battlefield.terrain.map((t) => t.kind));
  if (kinds.has('obstacle')) {
    items.push({ kind: 'terrain', label: '障碍禁止区 (Obstacle)', color: '#ef4444', style: 'fill' });
  }
  if (kinds.has('deployment-zone')) {
    items.push({ kind: 'terrain', label: '允许部署区 (Zone)', color: '#10b981', style: 'fill' });
  }
  if (kinds.has('passage-line')) {
    items.push({ kind: 'terrain', label: '通行线路 (Road)', color: '#fbbf24', style: 'solid' });
  }
  if (kinds.has('passage')) {
    items.push({ kind: 'terrain', label: '通行桥口/隘口 (Passage)', color: '#38bdf8', style: 'point' });
  }

  // 部署形态与方案图例
  items.push({ kind: 'unit', label: '展开战线 (Frontage)', color: '#3b82f6', style: 'solid' });
  items.push({ kind: 'unit', label: '部署占地区 (Area)', color: '#3b82f6', style: 'fill' });

  const hasPlan = deployments.some((d) => d.assertion === 'plan');
  const hasReported = deployments.some((d) => d.assertion === 'reported');

  if (hasReported) {
    items.push({ kind: 'assertion', label: '既有实态 (Reported 实线)', color: '#38bdf8', style: 'solid' });
  }
  if (hasPlan) {
    items.push({ kind: 'assertion', label: '推演方案 (Plan 虚线)', color: '#f59e0b', style: 'dashed' });
  }

  return items;
}

/** 辅助：生成尺度说明文本（严格遵守 contract.md 第 5 节） */
export function generateScaleAnnotation(scale: BattleScale): ScaleAnnotation {
  if (scale.state === 'uncalibrated') {
    return {
      isCalibrated: false,
      title: '⚠️ 尺度未校准',
      detail: `${scale.reason}（严禁外推公里比例或武器射程）`,
    };
  }

  const [p1, p2] = scale.referenceSegment;
  const mapDist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const metersPerUnit = mapDist > 0 ? scale.distanceMeters / mapDist : 0;

  return {
    isCalibrated: true,
    title: '已标定尺度 (Calibrated Scale)',
    detail: `基准线段 ${mapDist.toFixed(0)} 地图单位 = ${scale.distanceMeters} 米 (1单位≈${metersPerUnit.toFixed(1)}m)；仅适用局部战场`,
    pixelsPerMeter: mapDist > 0 ? mapDist / scale.distanceMeters : undefined,
  };
}

/** 辅助：绘制 Canvas 战役简报 */
export function drawBattleToContext(
  ctx: CanvasRenderingContext2D,
  workspace: BattleWorkspace,
  battlefield: Battlefield,
  deployments: BattleDeployment[],
  width: number,
  height: number,
  padding: number
): void {
  // 1. 深色背景与战术坐标网格
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // 2. 视口映射计算（留出顶部 60px 标题区，底部 120px 尺度/注记区，右侧 260px 图例区）
  const mapAreaX = padding;
  const mapAreaY = padding + 50;
  const mapAreaW = width - padding * 2 - 260;
  const mapAreaH = height - mapAreaY - 120;

  const bounds = computeBattlefieldBounds(battlefield, deployments);
  const scaleRatio = Math.min(mapAreaW / bounds.width, mapAreaH / bounds.height);
  const offsetX = mapAreaX + (mapAreaW - bounds.width * scaleRatio) / 2 - bounds.minX * scaleRatio;
  const offsetY = mapAreaY + (mapAreaH - bounds.height * scaleRatio) / 2 - bounds.minY * scaleRatio;

  const toScreen = (pt: BattlePoint): [number, number] => [
    pt[0] * scaleRatio + offsetX,
    pt[1] * scaleRatio + offsetY,
  ];

  // 3. 顶部标题栏
  const bfName = battlefield.name.state === 'known' ? battlefield.name.value : '未命名战场';
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 20px "Segoe UI", sans-serif';
  ctx.fillText(`战役沙盘简报：${bfName}`, padding, padding + 24);

  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px "Segoe UI", sans-serif';
  ctx.fillText(
    `所属地图: ${battlefield.mapId} | 状态: ${battlefield.assertion === 'plan' ? '方案 (Plan)' : '实态 (Reported)'} | 部署单位数: ${deployments.length}`,
    padding,
    padding + 44
  );

  // 4. 地图主区裁切或画边框
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mapAreaX, mapAreaY, mapAreaW, mapAreaH);

  const traceMultiPolygon = (multi: BattleMultiPolygon) => {
    for (const poly of multi) {
      if (poly.length === 0) continue;
      ctx.beginPath();
      for (const ring of poly) {
        if (ring.length === 0) continue;
        const first = toScreen(ring[0]);
        ctx.moveTo(first[0], first[1]);
        for (let i = 1; i < ring.length; i++) {
          const pt = toScreen(ring[i]);
          ctx.lineTo(pt[0], pt[1]);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.stroke();
    }
  };

  // 5. 绘制战场边界（含孔洞）
  if (battlefield.boundary.state === 'known') {
    ctx.fillStyle = 'rgba(30, 41, 59, 0.4)';
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    traceMultiPolygon(battlefield.boundary.value);
    ctx.setLineDash([]);
  }

  // 6. 绘制地形特征
  for (const feat of battlefield.terrain) {
    if (feat.kind === 'obstacle' && feat.area.state === 'known') {
      ctx.fillStyle = 'rgba(239, 68, 68, 0.28)';
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.5;
      traceMultiPolygon(feat.area.value);
    } else if (feat.kind === 'deployment-zone' && feat.area.state === 'known') {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
      ctx.strokeStyle = '#059669';
      ctx.lineWidth = 1.5;
      traceMultiPolygon(feat.area.value);
    } else if (feat.kind === 'passage-line' && feat.line.state === 'known') {
      ctx.beginPath();
      const start = toScreen(feat.line.value[0]);
      ctx.moveTo(start[0], start[1]);
      for (let i = 1; i < feat.line.value.length; i++) {
        const pt = toScreen(feat.line.value[i]);
        ctx.lineTo(pt[0], pt[1]);
      }
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    } else if (feat.kind === 'passage' && feat.point.state === 'known') {
      const [px, py] = toScreen(feat.point.value);
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(px, py, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // 7. 绘制部队部署（占地面、正面折线、朝向箭头、标牌）
  const unitMap = new Map(workspace.garrisons.map((u) => [u.id, u]));

  for (const dep of deployments) {
    if (dep.placement.state !== 'known') continue;
    const pl = dep.placement.value;
    const isPlan = dep.assertion === 'plan';
    const unit = unitMap.get(dep.unitId);
    const unitColor = unit?.color || '#3b82f6';

    // 占地面：外环与所有孔洞放进同一条 even-odd 路径，孔洞不能重新填色
    if (pl.shape.kind === 'area') {
      for (const poly of pl.shape.area) {
        if (poly.length === 0) continue;
        ctx.beginPath();
        for (const ring of poly) {
          const start = toScreen(ring[0]);
          ctx.moveTo(start[0], start[1]);
          for (let i = 1; i < ring.length; i++) {
            const pt = toScreen(ring[i]);
            ctx.lineTo(pt[0], pt[1]);
          }
          ctx.closePath();
        }
        ctx.fillStyle = unitColor + '44';
        ctx.fill('evenodd');
        ctx.strokeStyle = unitColor;
        ctx.lineWidth = 2;
        if (isPlan) ctx.setLineDash([6, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 正面折线
    if (pl.shape.kind === 'frontage') {
      ctx.beginPath();
      const start = toScreen(pl.shape.line[0]);
      ctx.moveTo(start[0], start[1]);
      for (let i = 1; i < pl.shape.line.length; i++) {
        const pt = toScreen(pl.shape.line[i]);
        ctx.lineTo(pt[0], pt[1]);
      }
      ctx.strokeStyle = unitColor;
      ctx.lineWidth = 4;
      if (isPlan) ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 朝向箭头
    if (dep.facingDegrees.state === 'known') {
      const [anchorX, anchorY] = toScreen(pl.anchor);
      const [dirX, dirY] = getFacingVector(dep.facingDegrees.value);
      const arrowLen = 22;
      const targetX = anchorX + dirX * arrowLen;
      const targetY = anchorY + dirY * arrowLen;

      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(targetX, targetY);
      ctx.strokeStyle = unitColor;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // 兵牌标牌
    const [anchorX, anchorY] = toScreen(pl.anchor);
    const unitName = unit?.unitName.state === 'known' ? unit.unitName.value : dep.unitId;
    const echelonSym = getEchelonSymbol(unit?.echelon.state === 'known' ? unit.echelon.value : '');

    const badgeW = 76;
    const badgeH = 22;
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(anchorX - badgeW / 2, anchorY - badgeH / 2, badgeW, badgeH);
    ctx.strokeStyle = unitColor;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(anchorX - badgeW / 2, anchorY - badgeH / 2, badgeW, badgeH);

    ctx.fillStyle = unitColor;
    ctx.fillRect(anchorX - badgeW / 2, anchorY - badgeH / 2, badgeW, 3);

    ctx.fillStyle = '#f8fafc';
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${echelonSym ? `[${echelonSym}] ` : ''}${unitName}`, anchorX, anchorY + 4);
    ctx.textAlign = 'left';
  }

  // 8. 右侧图例面板 (Legend)
  const legendX = width - padding - 240;
  const legendY = mapAreaY;
  const legendW = 240;
  const legendH = mapAreaH;

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(legendX, legendY, legendW, legendH);
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  ctx.strokeRect(legendX, legendY, legendW, legendH);

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 13px "Segoe UI", sans-serif';
  ctx.fillText('战术图例 (Legend)', legendX + 14, legendY + 24);

  const legendItems = generateLegendItems(battlefield, deployments, workspace);
  let itemY = legendY + 50;

  for (const item of legendItems) {
    if (item.style === 'fill') {
      ctx.fillStyle = item.color + '66';
      ctx.fillRect(legendX + 14, itemY - 10, 18, 12);
      ctx.strokeStyle = item.color;
      ctx.strokeRect(legendX + 14, itemY - 10, 18, 12);
    } else if (item.style === 'solid') {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(legendX + 14, itemY - 4);
      ctx.lineTo(legendX + 32, itemY - 4);
      ctx.stroke();
    } else if (item.style === 'dashed') {
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(legendX + 14, itemY - 4);
      ctx.lineTo(legendX + 32, itemY - 4);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (item.style === 'point') {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(legendX + 23, itemY - 4, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '11px "Segoe UI", sans-serif';
    ctx.fillText(item.label, legendX + 40, itemY);
    itemY += 24;
  }

  // 9. 底部左侧：尺度状态栏 (Scale Status)
  const bottomY = height - 100;
  const scaleInfo = generateScaleAnnotation(battlefield.scale);

  ctx.fillStyle = scaleInfo.isCalibrated ? '#1e293b' : '#451a03';
  ctx.fillRect(padding, bottomY, mapAreaW / 2 - 10, 80);
  ctx.strokeStyle = scaleInfo.isCalibrated ? '#38bdf8' : '#f59e0b';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(padding, bottomY, mapAreaW / 2 - 10, 80);

  ctx.fillStyle = scaleInfo.isCalibrated ? '#38bdf8' : '#fbbf24';
  ctx.font = 'bold 12px "Segoe UI", sans-serif';
  ctx.fillText(scaleInfo.title, padding + 12, bottomY + 22);

  ctx.fillStyle = '#e2e8f0';
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.fillText(scaleInfo.detail, padding + 12, bottomY + 44);

  // 10. 底部右侧：情报与假设说明 (Assumptions & Sources Footnote)
  const evidenceX = padding + mapAreaW / 2 + 10;
  const evidenceW = mapAreaW / 2 + 250;
  const evSummary = collectBattlefieldEvidence(battlefield, workspace, deployments);

  ctx.fillStyle = '#1e293b';
  ctx.fillRect(evidenceX, bottomY, evidenceW, 80);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;
  ctx.strokeRect(evidenceX, bottomY, evidenceW, 80);

  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 11px "Segoe UI", sans-serif';
  ctx.fillText('情报依据与推演假设 (Intelligence Basis & Assumptions)', evidenceX + 12, bottomY + 20);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '10px "Segoe UI", sans-serif';
  const assumptionsText =
    evSummary.assumptions.length > 0
      ? `明确假设 (${evSummary.assumptions.length}项): ${evSummary.assumptions.map((a) => a.excerpt).join('；')}`
      : '无额外推演假设（全量依据既有战报记录）';
  ctx.fillText(assumptionsText.slice(0, 90), evidenceX + 12, bottomY + 40);

  const sourcesText = `引述文献来源: ${evSummary.sources.map((s) => s.title).join(', ') || '未引用外部文献'}`;
  ctx.fillText(sourcesText.slice(0, 90), evidenceX + 12, bottomY + 60);
}

/**
 * 战役沙盘图片导出公开签名：遵循 contract.md 第 6 节
 * 导出选定战场及图例、尺度状态、来源/假设说明为 PNG 图片 Blob
 */
export async function exportBattlePng(
  workspace: BattleWorkspace,
  battlefieldId: string,
  options?: BattleExportOptions
): Promise<Blob> {
  // 1. 入口参数校验
  const battlefield = workspace.battle.battlefields.find((b) => b.id === battlefieldId);
  if (!battlefield) {
    throw new Error(`无法导出战场：未在当前工作区中找到战场 ID "${battlefieldId}"`);
  }

  // 2. 收集属于该战场的部署
  const targetDeployments = workspace.battle.deployments.filter(
    (dep) =>
      dep.battlefieldId.state === 'known' && dep.battlefieldId.value === battlefieldId
  );

  const width = options?.width ?? 1600;
  const height = options?.height ?? 1000;
  const padding = options?.padding ?? 40;

  if (typeof document === 'undefined' && !options?.canvas) {
    throw new Error('PNG 导出需要浏览器 Canvas，当前环境不可用');
  }
  const canvas = options?.canvas ?? document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 上下文初始化失败');
  drawBattleToContext(ctx, workspace, battlefield, targetDeployments, width, height, padding);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) {
        reject(new Error('Canvas 转换为 PNG Blob 失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}
