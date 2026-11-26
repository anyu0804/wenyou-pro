import type {
  BadgeCultureStyle,
  EchelonSymbolCode,
  EchelonTierName,
  EchelonTierSpec,
  CustomBadgeConfig,
} from './battle-contract';

export type {
  BadgeCultureStyle,
  EchelonSymbolCode,
  EchelonTierName,
  EchelonTierSpec,
  CustomBadgeConfig,
};

/**
 * 人数 8 区间对应 7 档军标与通用兵牌规格（方案 A）
 * 区间 1: 0–500 (连 |)
 * 区间 2: 500–2000 (营 ||)
 * 区间 3: 2000–6000 (团 |||)
 * 区间 4: 6000–18000 (师 x)
 * 区间 5: 18000–54000 (军 xx)
 * 区间 6: 54000–150000 (集团军 xxx)
 * 区间 7: 150000–450000 (方面军 xxxx)
 * 区间 8: 450000+ (重型方面军 xxxx，加冕双框与星芒)
 */
export const ECHELON_TIER_SPECS: readonly EchelonTierSpec[] = [
  { tierIndex: 1, symbol: '|', echelonName: '连', bracketLabel: '0-500', minTroops: 0, maxTroops: 500 },
  { tierIndex: 2, symbol: '||', echelonName: '营', bracketLabel: '500-2000', minTroops: 500, maxTroops: 2000 },
  { tierIndex: 3, symbol: '|||', echelonName: '团', bracketLabel: '2000-6000', minTroops: 2000, maxTroops: 6000 },
  { tierIndex: 4, symbol: 'x', echelonName: '师', bracketLabel: '6000-18000', minTroops: 6000, maxTroops: 18000 },
  { tierIndex: 5, symbol: 'xx', echelonName: '军', bracketLabel: '18000-54000', minTroops: 18000, maxTroops: 54000 },
  { tierIndex: 6, symbol: 'xxx', echelonName: '集团军', bracketLabel: '54000-150000', minTroops: 54000, maxTroops: 150000 },
  { tierIndex: 7, symbol: 'xxxx', echelonName: '方面军', bracketLabel: '150000-450000', minTroops: 150000, maxTroops: 450000 },
  { tierIndex: 8, symbol: 'xxxx', echelonName: '方面军', bracketLabel: '450000+', minTroops: 450000, maxTroops: null },
] as const;

/** 默认编制规格（用于无效/未知人数回退） */
const DEFAULT_TIER_SPEC = ECHELON_TIER_SPECS[2]; // 团级 (2000-6000, |||)

/**
 * 根据人数推导军标编制档位规格
 */
export function resolveTroopEchelon(troops?: number | null): EchelonTierSpec {
  if (typeof troops !== 'number' || Number.isNaN(troops) || troops < 0) {
    return DEFAULT_TIER_SPEC;
  }
  if (troops <= 500) return ECHELON_TIER_SPECS[0];
  if (troops <= 2000) return ECHELON_TIER_SPECS[1];
  if (troops <= 6000) return ECHELON_TIER_SPECS[2];
  if (troops <= 18000) return ECHELON_TIER_SPECS[3];
  if (troops <= 54000) return ECHELON_TIER_SPECS[4];
  if (troops <= 150000) return ECHELON_TIER_SPECS[5];
  if (troops <= 450000) return ECHELON_TIER_SPECS[6];
  return ECHELON_TIER_SPECS[7];
}

/**
 * 战术层级符号映射（群友 7 档规格与人数联动）
 * 连→|, 营→||, 团→|||, 师→x, 军→xx, 集团军→xxx, 方面军→xxxx
 */
export function getEchelonSymbol(echelon?: string, troops?: number | null): string {
  if (echelon) {
    const trimmed = echelon.trim();
    const lower = trimmed.toLowerCase();
    if (lower === '|' || lower === '||' || lower === '|||' || lower === 'x' || lower === 'xx' || lower === 'xxx' || lower === 'xxxx') {
      return lower;
    }
    if (trimmed.includes('方面军')) return 'xxxx';
    if (trimmed.includes('集团军') || trimmed.includes('兵团')) return 'xxx';
    if (trimmed.includes('军')) return 'xx';
    if (trimmed.includes('师') || trimmed.includes('旅')) return 'x';
    if (trimmed.includes('团')) return '|||';
    if (trimmed.includes('营')) return '||';
    if (trimmed.includes('连') || trimmed.includes('排')) return '|';
  }

  if (typeof troops === 'number' && !Number.isNaN(troops) && troops >= 0) {
    return resolveTroopEchelon(troops).symbol;
  }

  return echelon ? echelon.trim() : '';
}

/** 战术图腾推导结果 */
export interface TacticalTotemSpec {
  name: string;
  glyph: string;
  subType: string;
}

/**
 * 根据兵种关键词或玩家需求标签自动推导中心战术图腾
 */
export function resolveRequirementTotem(tag?: string, branch?: string): TacticalTotemSpec {
  const combined = `${tag ?? ''} ${branch ?? ''}`.trim();
  if (/空骑|狮鹫|飞龙|飞禽|羽林|天马|翼/.test(combined)) {
    return { name: '空骑', glyph: '🦅', subType: 'air' };
  }
  if (/水师|舟师|舰|水军|海|水战/.test(combined)) {
    return { name: '水师', glyph: '⚓', subType: 'naval' };
  }
  if (/重装|重甲|甲士|陷阵|盾|枪盾|卫士/.test(combined)) {
    return { name: '重装步兵', glyph: '🛡️', subType: 'heavy-infantry' };
  }
  if (/炮|火器|神机|弓|弩|射手|铳/.test(combined)) {
    return { name: '远程火器', glyph: '🏹', subType: 'artillery' };
  }
  if (/骑|马|骠|铁骑|游骑|骁骑/.test(combined)) {
    return { name: '骑兵', glyph: '🐎', subType: 'cavalry' };
  }
  if (/禁军|近卫|亲军|皇室|统帅|中军/.test(combined)) {
    return { name: '近卫禁军', glyph: '👑', subType: 'guard' };
  }
  if (/法|奥术|道士|术士|方士|法师/.test(combined)) {
    return { name: '法术奥术', glyph: '✨', subType: 'arcane' };
  }
  if (/工兵|后勤|辎重|械|粮草/.test(combined)) {
    return { name: '工兵后勤', glyph: '⚙️', subType: 'support' };
  }
  return { name: '主战步兵', glyph: '⚔️', subType: 'infantry' };
}

/** 兵牌 Canvas 渲染选项 */
export interface UnitSymbolRenderOptions {
  width?: number;
  height?: number;
  troops?: number | null;
  echelon?: string;
  branch?: string;
  unitName?: string;
  color?: string;
  customBadge?: CustomBadgeConfig;
  /** 是否为纯军标模式（34x34 强化军标） */
  isMinimal?: boolean;
}

/**
 * 绘制兵牌与军标到 2D Canvas 上下文
 */
export function renderUnitSymbolToContext(
  ctx: CanvasRenderingContext2D,
  options: UnitSymbolRenderOptions
): void {
  const {
    troops = null,
    echelon = '',
    unitName = '未知部队',
    color = '#2563eb',
    customBadge,
    isMinimal = false,
  } = options;

  const culture: BadgeCultureStyle = customBadge?.culture ?? 'universal';
  const validTroops = typeof troops === 'number' && Number.isFinite(troops) && troops >= 0 ? troops : null;
  const tierSpec = resolveTroopEchelon(validTroops);
  const echelonSym = getEchelonSymbol(echelon, validTroops);
  const hasCustomIcon = Boolean(customBadge?.customIconDataUrl?.trim().startsWith('data:image/'));
  const displayGlyph = hasCustomIcon ? '' : (customBadge?.customGlyph?.trim() || '');
  const textColor = customBadge?.textColor || '#f8fafc';

  if (isMinimal) {
    // 纯军标模式：34x34
    const w = options.width ?? 34;
    const h = options.height ?? 34;

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // 1. 底板外框渲染（按文化与分档）
    drawMinimalCultureFrame(ctx, w, h, culture, color, tierSpec.tierIndex);

    // 2. 顶部刻度栏 (| ~ xxxx)；无自定义中心字/图标时居中放大显示，不再绘战术图腾 emoji
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    if (displayGlyph || hasCustomIcon) {
      ctx.font = 'bold 9px "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(echelonSym, w / 2, 2.5);
    } else {
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(echelonSym, w / 2, h / 2 - 2);
    }

    // 3. 自定义中心大字（仅在玩家主动填写中心字时绘制）
    if (displayGlyph) {
      ctx.fillStyle = textColor;
      if (displayGlyph.length > 2) {
        ctx.font = '10px "Microsoft YaHei", sans-serif';
      } else {
        ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayGlyph, w / 2, h / 2 + 1);
    }

    // 4. 底部人数/编制标识
    ctx.fillStyle = customBadge?.textColor ? textColor : '#cbd5e1';
    ctx.font = '8px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const bottomLabel = validTroops !== null
      ? (validTroops >= 10000 ? `${(validTroops / 10000).toFixed(0)}万` : String(validTroops))
      : tierSpec.echelonName;
    ctx.fillText(bottomLabel, w / 2, h - 2);

    ctx.restore();
  } else {
    // 标准兵牌模式：96x30，避免双行番号与人数重叠或溢框
    const w = options.width ?? 96;
    const h = options.height ?? 30;

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // 1. 外框与半透明底色
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    drawStandardFrame(ctx, w, h, culture);

    // 2. 顶部阵营色标条
    ctx.fillStyle = color;
    ctx.fillRect(1, 1, w - 2, 2.5);

    // 3. 左侧内置军标图标 (20x20，垂直居中于色条下方)
    const iconSize = 20;
    const iconY = Math.round(2.5 + (h - 2.5 - iconSize) / 2);
    ctx.save();
    ctx.translate(3, iconY);
    drawMinimalCultureFrame(ctx, iconSize, iconSize, culture, color, tierSpec.tierIndex);

    // 图标内刻度与可选中心字
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    if (displayGlyph || hasCustomIcon) {
      ctx.font = 'bold 7px "Segoe UI", sans-serif';
      ctx.textBaseline = 'top';
      ctx.fillText(echelonSym, iconSize / 2, 1.5);
      if (displayGlyph) {
        ctx.font = '9px "Microsoft YaHei", sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayGlyph, iconSize / 2, 12.5);
      }
    } else {
      ctx.font = 'bold 9px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(echelonSym, iconSize / 2, iconSize / 2 + 0.5);
    }
    ctx.restore();

    // 4. 右侧双行文字（留出清晰行距）
    // 上行：番号
    ctx.fillStyle = textColor;
    ctx.font = 'bold 9.5px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const truncatedName = unitName.length > 7 ? `${unitName.slice(0, 6)}…` : unitName;
    ctx.fillText(truncatedName, 27, 5);

    // 下行：兵力副标题
    ctx.fillStyle = customBadge?.textColor ? textColor : '#94a3b8';
    ctx.font = '8px "Segoe UI", sans-serif';
    ctx.textBaseline = 'bottom';
    const troopsText = validTroops !== null
      ? (validTroops >= 10000 ? `${(validTroops / 10000).toFixed(1)}万` : `${validTroops}人`)
      : `${tierSpec.echelonName} (人数未定)`;
    ctx.fillText(troopsText, 27, h - 3);

    ctx.restore();
  }
}

/** 绘制纯军标模式文化底板 */
function drawMinimalCultureFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  culture: BadgeCultureStyle,
  color: string,
  tierIndex: number
): void {
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;

  if (culture === 'huaxia') {
    // 华夏旌旗方印框：带内折角和旌旗轮廓
    ctx.beginPath();
    ctx.rect(1.5, 1.5, w - 3, h - 3);
    ctx.fill();
    ctx.stroke();
    // 华夏内印边
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(3.5, 3.5, w - 7, h - 7);
  } else if (culture === 'western') {
    // 西式盾徽形底板（左右对称盾形）
    ctx.beginPath();
    ctx.moveTo(2, 2);
    ctx.lineTo(w - 2, 2);
    ctx.lineTo(w - 2, h * 0.58);
    ctx.quadraticCurveTo(w - 2, h * 0.85, w / 2, h - 1.5);
    ctx.quadraticCurveTo(2, h * 0.85, 2, h * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (culture === 'nomad') {
    // 草原游牧狼纛：折角战旗框
    ctx.beginPath();
    ctx.moveTo(1.5, 1.5);
    ctx.lineTo(w - 1.5, 1.5);
    ctx.lineTo(w - 1.5, h - 5);
    ctx.lineTo(w / 2, h - 1.5);
    ctx.lineTo(1.5, h - 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (culture === 'arcane') {
    // 奇幻奥术星轨：切角八边形
    const c = 5;
    ctx.beginPath();
    ctx.moveTo(c, 1.5);
    ctx.lineTo(w - c, 1.5);
    ctx.lineTo(w - 1.5, c);
    ctx.lineTo(w - 1.5, h - c);
    ctx.lineTo(w - c, h - 1.5);
    ctx.lineTo(c, h - 1.5);
    ctx.lineTo(1.5, h - c);
    ctx.lineTo(1.5, c);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // nato / universal / custom 通用分档战术框
    ctx.beginPath();
    ctx.rect(1.5, 1.5, w - 3, h - 3);
    ctx.fill();
    ctx.stroke();

    // 根据档位 (tierIndex) 增强视觉
    if (tierIndex === 8) {
      // Tier 8: 45万+ 重型方面军加冕双框与星芒角
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 1;
      ctx.strokeRect(3, 3, w - 6, h - 6);
    } else if (tierIndex >= 6) {
      // Tier 6~7: 集团军/方面军金色内衬
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(3, 3, w - 6, h - 6);
    } else if (tierIndex >= 4) {
      // Tier 4~5: 师/军级双线框
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(3, 3, w - 6, h - 6);
    }
  }
}

/** 绘制标准兵牌外框 */
function drawStandardFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  culture: BadgeCultureStyle
): void {
  ctx.beginPath();
  if (culture === 'huaxia') {
    ctx.rect(1, 1, w - 2, h - 2);
  } else if (culture === 'arcane') {
    const c = 3;
    ctx.moveTo(c, 1);
    ctx.lineTo(w - c, 1);
    ctx.lineTo(w - 1, c);
    ctx.lineTo(w - 1, h - c);
    ctx.lineTo(w - c, h - 1);
    ctx.lineTo(c, h - 1);
    ctx.lineTo(1, h - c);
    ctx.lineTo(1, c);
    ctx.closePath();
  } else {
    ctx.rect(1, 1, w - 2, h - 2);
  }
  ctx.fill();
  ctx.stroke();
}

