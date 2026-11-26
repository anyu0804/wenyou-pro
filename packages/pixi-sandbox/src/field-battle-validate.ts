import { JsonValidator, isText, isFiniteNumber, isPoint } from './json-validation';
import type {
  BattleDeployment, BattleEvidence, BattleField, BattleSource,
} from './battle-contract';
import type {
  FieldBattle, FieldPolygonPart, FieldRing, FieldStrokeStyle, FieldTerrainSnapshot, FieldUnit,
} from './field-battle-types';

/**
 * FB-U 的战场快照验证器：只用于缓存/工程导入边界。
 * 失败直接抛错并带字段路径，不返回 false，也不修补数据。
 */

const json: JsonValidator = new JsonValidator((path, detail) => `战场字段无效：${path}${detail === undefined ? '' : `（${detail}）`}`, '应为对象');
const isNonEmptyText = (value: unknown): value is string => isText(value) && value.length > 0;
const isNonNegativeInteger = (value: unknown): boolean => Number.isInteger(value) && Number(value) >= 0;

const BADGE_STYLES = ['standard', 'compact', 'minimal'];
const STATUSES = ['驻防', '行军', '被围'];
const SCOPES = ['own', 'inclusive', 'legacy-unspecified'];
const ROLES = ['line', 'reserve', 'headquarters'];
const SOURCE_KINDS = ['reference', 'manual', 'ai', 'legacy'];
const EVIDENCE_BASES = ['quoted', 'assumption', 'inference'];
const TIERS = ['capital', 'provincial', 'city'];

function ring(value: unknown, path: string): asserts value is FieldRing {
  json.check(Array.isArray(value) && value.length >= 3, path, '环至少需要 3 个点');
  value.forEach((point, index) => json.check(isPoint(point), `${path}[${index}]`, '坐标必须是有限数对'));
}

function polygonPart(value: unknown, path: string): asserts value is FieldPolygonPart {
  json.object(value, path);
  ring(value.outer, `${path}.outer`);
  json.check(Array.isArray(value.holes), `${path}.holes`, '孔洞必须是数组');
  value.holes.forEach((hole, index) => ring(hole, `${path}.holes[${index}]`));
}

function polygonParts(value: unknown, path: string): void {
  json.check(Array.isArray(value), path, '多边形集合必须是数组');
  value.forEach((part, index) => polygonPart(part, `${path}[${index}]`));
}

function style(value: unknown, path: string): asserts value is FieldStrokeStyle {
  json.object(value, path);
  json.check(isNonEmptyText(value.color), `${path}.color`, '颜色必须是非空字符串');
  json.check(isFiniteNumber(value.width), `${path}.width`);
  json.check(isFiniteNumber(value.alpha), `${path}.alpha`);
}

function lines(value: unknown, path: string): void {
  json.check(Array.isArray(value), path, '折线集合必须是数组');
  value.forEach((line, index) => {
    json.object(line, `${path}[${index}]`);
    const points = line.points;
    json.check(Array.isArray(points) && points.length >= 2, `${path}[${index}].points`, '折线至少需要 2 个点');
    points.forEach((point, pointIndex) => json.check(isPoint(point), `${path}[${index}].points[${pointIndex}]`));
    json.check(typeof line.closed === 'boolean', `${path}[${index}].closed`);
  });
}

function terrain(value: unknown, path: string): asserts value is FieldTerrainSnapshot {
  json.object(value, path);
  polygonParts(value.displayOutline, `${path}.displayOutline`);
  polygonParts(value.battleOutline, `${path}.battleOutline`);
  polygonParts(value.contextOutline, `${path}.contextOutline`);

  json.check(Array.isArray(value.cells), `${path}.cells`, '地块集合必须是数组');
  value.cells.forEach((cell, index) => {
    json.object(cell, `${path}.cells[${index}]`);
    ring(cell.polygon, `${path}.cells[${index}].polygon`);
    json.check(isNonEmptyText(cell.color), `${path}.cells[${index}].color`);
    json.check(typeof cell.context === 'boolean', `${path}.cells[${index}].context`);
  });

  json.check(Array.isArray(value.coastBands), `${path}.coastBands`);
  value.coastBands.forEach((band, index) => {
    json.object(band, `${path}.coastBands[${index}]`);
    polygonParts(band.parts, `${path}.coastBands[${index}].parts`);
    json.check(isNonEmptyText(band.color), `${path}.coastBands[${index}].color`);
    json.check(isFiniteNumber(band.alpha), `${path}.coastBands[${index}].alpha`);
  });

  json.check(Array.isArray(value.lakes), `${path}.lakes`);
  value.lakes.forEach((lake, index) => {
    json.object(lake, `${path}.lakes[${index}]`);
    polygonParts(lake.parts, `${path}.lakes[${index}].parts`);
    json.check(isNonEmptyText(lake.color), `${path}.lakes[${index}].color`);
  });

  json.check(Array.isArray(value.rivers), `${path}.rivers`);
  value.rivers.forEach((river, index) => {
    json.object(river, `${path}.rivers[${index}]`);
    polygonParts(river.parts, `${path}.rivers[${index}].parts`);
    json.check(isNonEmptyText(river.color), `${path}.rivers[${index}].color`);
    json.check(isFiniteNumber(river.alpha), `${path}.rivers[${index}].alpha`);
  });

  for (const key of ['coastlines', 'contours'] as const) {
    json.check(Array.isArray(value[key]), `${path}.${key}`);
    value[key].forEach((group, index) => {
      json.object(group, `${path}.${key}[${index}]`);
      lines(group.lines, `${path}.${key}[${index}].lines`);
      style(group.style, `${path}.${key}[${index}].style`);
    });
  }

  json.check(Array.isArray(value.burgs), `${path}.burgs`);
  value.burgs.forEach((burg, index) => {
    json.object(burg, `${path}.burgs[${index}]`);
    json.check(isText(burg.name), `${path}.burgs[${index}].name`);
    json.check(isFiniteNumber(burg.x), `${path}.burgs[${index}].x`);
    json.check(isFiniteNumber(burg.y), `${path}.burgs[${index}].y`);
    json.check(TIERS.includes(burg.tier), `${path}.burgs[${index}].tier`);
  });
}

function evidenceItems(value: unknown, path: string, sourceIds: ReadonlySet<string>): asserts value is BattleEvidence[] {
  json.check(Array.isArray(value), path, '证据必须是数组');
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    json.object(item, itemPath);
    json.check(isNonEmptyText(item.sourceId), `${itemPath}.sourceId`);
    json.check(sourceIds.has(item.sourceId), `${itemPath}.sourceId`, `来源不存在：${item.sourceId}`);
    json.check(EVIDENCE_BASES.includes(item.basis), `${itemPath}.basis`);
    json.check(isText(item.excerpt), `${itemPath}.excerpt`);
    json.check(isText(item.note), `${itemPath}.note`);
  });
}

function battleField<T>(
  value: unknown,
  path: string,
  predicate: (fieldValue: unknown) => boolean,
  sourceIds: ReadonlySet<string>,
): asserts value is BattleField<T> {
  json.object(value, path);
  evidenceItems(value.evidence, `${path}.evidence`, sourceIds);
  if (value.state === 'known') {
    json.check('value' in value && predicate(value.value), path, 'known 值无效');
  } else if (value.state === 'unknown') {
    json.check(!('value' in value), path, 'unknown 不得携带 value');
    json.check(isNonEmptyText(value.reason), path, 'unknown 缺少原因');
  } else {
    json.fail(path, 'state 必须是 known 或 unknown');
  }
}

function battleMultiPolygon(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((polygon) => Array.isArray(polygon) && polygon.length > 0 && polygon.every((candidate) => {
    if (!Array.isArray(candidate) || candidate.length < 4) return false;
    if (!candidate.every(isPoint)) return false;
    const first = candidate[0];
    const last = candidate[candidate.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  }));
}

function battleLine(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && value.every(isPoint);
}

function placement(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, any>;
  if (!isPoint(candidate.anchor)) return false;
  const shape = candidate.shape;
  if (shape === null || typeof shape !== 'object') return false;
  if (shape.kind === 'point') return true;
  if (shape.kind === 'frontage') return battleLine(shape.line);
  if (shape.kind === 'area') return battleMultiPolygon(shape.area);
  return false;
}

function unit(value: unknown, path: string, sourceIds: ReadonlySet<string>): asserts value is FieldUnit {
  json.object(value, path);
  json.check(isNonEmptyText(value.id), `${path}.id`);
  json.check(isText(value.sourceUnitId), `${path}.sourceUnitId`);
  json.check(isNonEmptyText(value.color), `${path}.color`);
  json.check(value.assertion === 'reported' || value.assertion === 'plan', `${path}.assertion`);
  battleField<string>(value.unitName, `${path}.unitName`, isText, sourceIds);
  battleField<number | null>(value.provinceId, `${path}.provinceId`, (v) => v === null || isNonNegativeInteger(v), sourceIds);
  battleField<string>(value.status, `${path}.status`, (v) => STATUSES.includes(String(v)), sourceIds);
  battleField<string | null>(value.parentUnitId, `${path}.parentUnitId`,
    (v) => v === null || isNonEmptyText(v), sourceIds);
  battleField<string>(value.echelon, `${path}.echelon`, isText, sourceIds);
  battleField<string>(value.branch, `${path}.branch`, isText, sourceIds);
  battleField<string>(value.side, `${path}.side`, isText, sourceIds);
  battleField<'complete' | 'partial'>(value.childrenCompleteness, `${path}.childrenCompleteness`,
    (v) => v === 'complete' || v === 'partial', sourceIds);
  json.object(value.personnel, `${path}.personnel`);
  json.check(SCOPES.includes(value.personnel.scope), `${path}.personnel.scope`);
  battleField<number>(value.personnel.count, `${path}.personnel.count`, isNonNegativeInteger, sourceIds);
}

function deployment(
  value: unknown,
  path: string,
  unitIds: ReadonlySet<string>,
  sourceIds: ReadonlySet<string>,
): asserts value is BattleDeployment {
  json.object(value, path);
  json.check(isNonEmptyText(value.unitId), `${path}.unitId`);
  json.check(unitIds.has(value.unitId), `${path}.unitId`, `部署单位不在本战场：${value.unitId}`);
  json.check(value.assertion === 'reported' || value.assertion === 'plan', `${path}.assertion`);
  battleField<string | null>(value.battlefieldId, `${path}.battlefieldId`,
    (v) => v === null, sourceIds);
  battleField<unknown>(value.placement, `${path}.placement`, placement, sourceIds);
  battleField<number>(value.facingDegrees, `${path}.facingDegrees`,
    (v) => isFiniteNumber(v) && v >= 0 && v < 360, sourceIds);
  battleField<number>(value.depthMapUnits, `${path}.depthMapUnits`,
    (v) => isFiniteNumber(v) && v >= 0, sourceIds);
  battleField<number>(value.formationLine, `${path}.formationLine`,
    (v) => Number.isInteger(v) && Number(v) >= 1, sourceIds);
  battleField<string>(value.role, `${path}.role`, (v) => ROLES.includes(String(v)), sourceIds);
  battleField<string | null>(value.reserveForUnitId, `${path}.reserveForUnitId`,
    (v) => v === null || isNonEmptyText(v), sourceIds);
  if (value.reserveForUnitId.state === 'known' && value.reserveForUnitId.value !== null) {
    json.check(unitIds.has(value.reserveForUnitId.value), `${path}.reserveForUnitId`,
      `预备队单位不在本战场：${value.reserveForUnitId.value}`);
  }
}

function source(value: unknown, path: string): asserts value is BattleSource {
  json.object(value, path);
  json.check(isNonEmptyText(value.id), `${path}.id`);
  json.check(SOURCE_KINDS.includes(value.kind), `${path}.kind`);
  json.check(isText(value.title), `${path}.title`);
  json.check(isText(value.text), `${path}.text`);
  json.check(value.locator === null || isText(value.locator), `${path}.locator`);
}

function fieldBattle(value: unknown, path: string): asserts value is FieldBattle {
  json.object(value, path);
  json.check(isNonEmptyText(value.id), `${path}.id`);
  json.check(isNonEmptyText(value.name), `${path}.name`);
  json.check(isNonEmptyText(value.createdAt), `${path}.createdAt`);

  json.check(Array.isArray(value.cellIds), `${path}.cellIds`, '地块 ID 必须是数组');
  const cellIds = new Set<number>();
  value.cellIds.forEach((cellId, index) => {
    json.check(Number.isInteger(cellId), `${path}.cellIds[${index}]`);
    json.check(!cellIds.has(cellId), `${path}.cellIds[${index}]`, '地块 ID 重复');
    cellIds.add(cellId);
  });

  json.check(isPoint(value.anchor), `${path}.anchor`, '锚点必须是有限数对');
  json.object(value.bounds, `${path}.bounds`);
  for (const key of ['x', 'y', 'width', 'height']) {
    json.check(isFiniteNumber(value.bounds[key]), `${path}.bounds.${key}`);
  }

  json.check(BADGE_STYLES.includes(value.badgeStyle), `${path}.badgeStyle`);
  json.check(isFiniteNumber(value.badgeScale) && value.badgeScale > 0, `${path}.badgeScale`);

  if (value.view !== undefined) {
    json.object(value.view, `${path}.view`);
    json.check(isFiniteNumber(value.view.scale) && value.view.scale > 0, `${path}.view.scale`);
    for (const key of ['x', 'y']) json.check(isFiniteNumber(value.view[key]), `${path}.view.${key}`);
  }

  terrain(value.terrain, `${path}.terrain`);

  json.check(Array.isArray(value.sources), `${path}.sources`, '来源必须是数组');
  const sourceIds = new Set<string>();
  value.sources.forEach((item, index) => {
    source(item, `${path}.sources[${index}]`);
    json.check(!sourceIds.has(item.id), `${path}.sources[${index}].id`, `来源 ID 重复：${item.id}`);
    sourceIds.add(item.id);
  });

  json.check(Array.isArray(value.units), `${path}.units`, '单位必须是数组');
  const unitIds = new Set<string>();
  value.units.forEach((item, index) => {
    unit(item, `${path}.units[${index}]`, sourceIds);
    json.check(!unitIds.has(item.id), `${path}.units[${index}].id`, `单位 ID 重复：${item.id}`);
    unitIds.add(item.id);
  });
  value.units.forEach((item, index) => {
    if (item.parentUnitId.state === 'known' && item.parentUnitId.value !== null) {
      json.check(unitIds.has(item.parentUnitId.value), `${path}.units[${index}].parentUnitId`,
        `上级单位不在本战场：${item.parentUnitId.value}`);
    }
  });

  json.check(Array.isArray(value.deployments), `${path}.deployments`, '部署必须是数组');
  value.deployments.forEach((item, index) => {
    deployment(item, `${path}.deployments[${index}]`, unitIds, sourceIds);
  });
}

export function validateFieldBattle(value: unknown): asserts value is FieldBattle {
  fieldBattle(value, 'fieldBattle');
}

export function validateFieldBattles(value: unknown): asserts value is FieldBattle[] {
  json.check(Array.isArray(value), 'fieldBattles', '战场集合必须是数组');
  value.forEach((item, index) => fieldBattle(item, `fieldBattles[${index}]`));
}
