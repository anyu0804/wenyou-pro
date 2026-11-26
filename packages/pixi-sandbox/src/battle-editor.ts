import type {
  BattleDeployment,
  BattleEditBatch,
  BattleLine,
  BattleMultiPolygon,
  BattlePoint,
  BattleWorkspace,
} from './battle-contract';
import { Matrix } from 'pixi.js';

export interface BattleEditorOptions {
  /** 提交编辑批次的回调（接入统一编辑入口或 P0） */
  applyBatch: (batch: BattleEditBatch) => void;
  /** 获取当前工作区 */
  getWorkspace: () => BattleWorkspace;
  /** 触发视图重绘回调 */
  onRefresh?: () => void;
  /** 选中单位集合变化回调 */
  onSelectionChange?: (unitIds: string[]) => void;
}

/** 辅助：平移点坐标 */
export function translatePoint(pt: BattlePoint, delta: BattlePoint): BattlePoint {
  return [pt[0] + delta[0], pt[1] + delta[1]];
}

/** 辅助：平移折线坐标 */
export function translateLine(line: BattleLine, delta: BattlePoint): BattleLine {
  const translated = line.map((p) => translatePoint(p, delta)) as [BattlePoint, BattlePoint, ...BattlePoint[]];
  return translated;
}

/** 辅助：平移 MultiPolygon 所有环的所有顶点坐标 */
export function translateMultiPolygon(
  multiPoly: BattleMultiPolygon,
  delta: BattlePoint
): BattleMultiPolygon {
  return multiPoly.map((poly) =>
    poly.map((ring) => ring.map((pt) => translatePoint(pt, delta)))
  ) as BattleMultiPolygon;
}

/**
 * 核心几何变换：严格平移部署的 anchor 及其附属的 frontage 折线或 area 多边形
 * 严格保留地图原生二维平面绝对坐标（遵循 contract.md 第 4 节）
 */
export function translateDeployment(
  deployment: BattleDeployment,
  delta: BattlePoint
): BattleDeployment {
  if (deployment.placement.state !== 'known') {
    return deployment;
  }

  const origPlacement = deployment.placement.value;
  const newAnchor = translatePoint(origPlacement.anchor, delta);

  let newShape = origPlacement.shape;
  if (origPlacement.shape.kind === 'point') {
    newShape = { kind: 'point' };
  } else if (origPlacement.shape.kind === 'frontage') {
    newShape = {
      kind: 'frontage',
      line: translateLine(origPlacement.shape.line, delta),
    };
  } else if (origPlacement.shape.kind === 'area') {
    newShape = {
      kind: 'area',
      area: translateMultiPolygon(origPlacement.shape.area, delta),
    };
  }

  return {
    ...deployment,
    placement: {
      ...deployment.placement,
      value: {
        anchor: newAnchor,
        shape: newShape,
      },
    },
  };
}

/**
 * 核心朝向变换：旋转部署朝向度数，规范化区间为 [0, 360) 顺时针
 * （遵循 contract.md 第 4 节：0上、90右、180下、270左）
 */
export function rotateDeploymentFacing(
  deployment: BattleDeployment,
  deltaDeg: number
): BattleDeployment {
  if (deployment.facingDegrees.state !== 'known') {
    return deployment;
  }

  const curDeg = deployment.facingDegrees.value;
  let newDeg = ((curDeg + deltaDeg) % 360 + 360) % 360;
  if (newDeg >= 360) newDeg = 0;

  return {
    ...deployment,
    facingDegrees: {
      ...deployment.facingDegrees,
      value: newDeg,
    },
  };
}

/** 用 Pixi 原生矩阵旋转正式部署几何；pivot 为同组共同的地图坐标支点。 */
export function rotateDeployment(
  deployment: BattleDeployment, deltaDeg: number, pivot: BattlePoint,
): BattleDeployment {
  const rotated = rotateDeploymentFacing(deployment, deltaDeg);
  if (deployment.placement.state === 'unknown') return rotated;
  const matrix = new Matrix().translate(-pivot[0], -pivot[1])
    .rotate(deltaDeg * Math.PI / 180).translate(pivot[0], pivot[1]);
  const rotatePoint = (point: BattlePoint): BattlePoint => {
    const result = matrix.apply({ x: point[0], y: point[1] });
    return [result.x, result.y];
  };
  const placement = deployment.placement.value;
  let shape = placement.shape;
  if (shape.kind === 'frontage') {
    shape = { kind: 'frontage', line: shape.line.map(rotatePoint) as BattleLine };
  } else if (shape.kind === 'area') {
    shape = { kind: 'area', area: shape.area.map(polygon =>
      polygon.map(ring => ring.map(rotatePoint))) as BattleMultiPolygon };
  }
  return { ...rotated, placement: { ...deployment.placement,
    value: { anchor: rotatePoint(placement.anchor), shape } } };
}

/** 辅助：根据平移或修改后的部署列表构造合法的标准 BattleEditBatch */
export function createDeploymentEditBatch(
  label: string,
  deployments: BattleDeployment[]
): BattleEditBatch {
  return {
    label,
    origin: 'manual',
    candidateItemIds: [],
    edits: deployments.map((dep) => ({
      kind: 'set-deployment',
      deployment: dep,
    })),
  };
}

/**
 * 战役交互编辑器控制器
 * 管理选中单位、拖动平移绝对坐标计算、朝向旋转、临时标牌避让偏移
 */
export class BattleEditor {
  private options: BattleEditorOptions;
  public selectedUnitIds: Set<string> = new Set();
  /** 临时标牌避让偏移映射（unitId -> [offsetX, offsetY]），不写回实际部署坐标 */
  public badgeOffsets: Map<string, BattlePoint> = new Map();
  /** 拖动中的临时位移预览 */
  public dragPreviewDelta: BattlePoint | null = null;

  constructor(options: BattleEditorOptions) {
    this.options = options;
  }

  /** 获取当前选中的单位 ID 列表 */
  public getSelection(): string[] {
    return Array.from(this.selectedUnitIds);
  }

  /** 设置选中单位（可单选或多选） */
  public selectUnits(unitIds: string[], append = false): void {
    if (!append) {
      this.selectedUnitIds.clear();
    }
    for (const id of unitIds) {
      this.selectedUnitIds.add(id);
    }
    this.options.onRefresh?.();
    this.options.onSelectionChange?.(this.getSelection());
  }

  /** 清空选中 */
  public clearSelection(): void {
    this.selectedUnitIds.clear();
    this.dragPreviewDelta = null;
    this.options.onRefresh?.();
    this.options.onSelectionChange?.([]);
  }

  /** 开始拖动预览 */
  public startDrag(): void {
    this.dragPreviewDelta = [0, 0];
  }

  /** 更新拖动临时位移预览 */
  public updateDragPreview(delta: BattlePoint): void {
    this.dragPreviewDelta = delta;
    this.options.onRefresh?.();
  }

  /**
   * 提交拖动位移：将位移计算至选中部署的 anchor 与全部几何顶点
   * 生成标准 BattleEditBatch 提交，随后清空临时位移预览
   */
  public commitDrag(delta: BattlePoint): void {
    this.dragPreviewDelta = null;
    if (this.selectedUnitIds.size === 0 || (delta[0] === 0 && delta[1] === 0)) {
      this.options.onRefresh?.();
      return;
    }

    const workspace = this.options.getWorkspace();
    const updatedDeployments: BattleDeployment[] = [];

    for (const dep of workspace.battle.deployments) {
      if (this.selectedUnitIds.has(dep.unitId) && dep.placement.state === 'known') {
        const moved = translateDeployment(dep, delta);
        updatedDeployments.push(moved);
      }
    }

    if (updatedDeployments.length > 0) {
      const batch = createDeploymentEditBatch(
        `平移部署 (${updatedDeployments.length} 部队)`,
        updatedDeployments
      );
      this.options.applyBatch(batch);
    }

    this.options.onRefresh?.();
  }

  /**
   * 围绕已定位单位锚点的共同中心旋转整组部署，保留相对位置与占地。
   */
  public commitRotation(deltaDeg: number): void {
    if (this.selectedUnitIds.size === 0 || deltaDeg === 0) return;

    const workspace = this.options.getWorkspace();
    const anchors = workspace.battle.deployments.flatMap(dep =>
      this.selectedUnitIds.has(dep.unitId) && dep.placement.state === 'known'
        ? [dep.placement.value.anchor] : []);
    if (anchors.length === 0) return;
    const center = anchors.reduce<BattlePoint>(
      (sum, point) => [sum[0] + point[0], sum[1] + point[1]], [0, 0]);
    const pivot: BattlePoint = [center[0] / anchors.length, center[1] / anchors.length];
    const updatedDeployments: BattleDeployment[] = [];

    for (const dep of workspace.battle.deployments) {
      if (this.selectedUnitIds.has(dep.unitId) && dep.placement.state === 'known') {
        const rotated = rotateDeployment(dep, deltaDeg, pivot);
        updatedDeployments.push(rotated);
      }
    }

    if (updatedDeployments.length > 0) {
      const batch = createDeploymentEditBatch(
        `旋转部署 (${updatedDeployments.length} 部队)`,
        updatedDeployments
      );
      this.options.applyBatch(batch);
    }

    this.options.onRefresh?.();
  }

  /**
   * 设置标牌临时避让偏移（不改变实际部署坐标，仅用于视图微调）
   * 遵循 contract.md 第 4 节
   */
  public setBadgeOffset(unitId: string, offset: BattlePoint): void {
    this.badgeOffsets.set(unitId, offset);
    this.options.onRefresh?.();
  }

  /** 清空所有标牌避让偏移 */
  public clearBadgeOffsets(): void {
    this.badgeOffsets.clear();
    this.options.onRefresh?.();
  }
}
