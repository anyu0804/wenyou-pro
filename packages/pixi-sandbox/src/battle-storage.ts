import { knownField, unknownField } from './battle-contract';
import { JsonValidator, isText as text, isFiniteNumber as finite, isPoint as point } from './json-validation';
import type { GarrisonUnit } from './store';
import type { BattleEvidence, BattleField, BattleMultiPolygon, BattleState, BattleUnit, BattleWorkspace } from './battle-contract';
import { createUnplacedBattleDeployment } from './battle-orbat';
import { multiPolygonIsValid } from './battle-geometry';

export function emptyBattleState(): BattleState {
  return { schemaVersion: 1, sources: [], battlefields: [], deployments: [] };
}

/** 旧文件实际缺少统计口径和编制；保留旧值，只将明确 x/y 迁为点位置。 */
export function migrateLegacyBattle(mapId: string, units: GarrisonUnit[]): BattleWorkspace {
  json.check(Array.isArray(units), '旧版 garrisons');
  const ids = new Set<string>();
  for (const unit of units) {
    json.object(unit, '旧版 unit');
    json.check(text(unit.id) && unit.id.trim().length > 0 && !ids.has(unit.id) && text(unit.unitName) && count(unit.troops) &&
      count(unit.provinceId) && /^#[0-9a-f]{6}$/i.test(unit.color) && ['驻防', '行军', '被围'].includes(unit.status) &&
      ((unit.x === undefined && unit.y === undefined) || (finite(unit.x) && finite(unit.y))), '旧版 unit');
    if (unit.customBadge !== undefined) validateCustomBadge(unit.customBadge, '旧版 unit.customBadge');
    ids.add(unit.id);
  }
  const battle = emptyBattleState();
  if (units.length === 0) return { mapId, garrisons: [], battle };
  const sourceId = `legacy:${mapId}`;
  battle.sources.push({ id: sourceId, kind: 'legacy', title: '旧版兵牌存档',
    text: JSON.stringify(units), locator: mapId });
  const evidence: BattleEvidence[] = [{ sourceId, basis: 'quoted', excerpt: '旧兵牌已保存值',
    note: '旧 troops 无统计口径；省份排牌坐标不是位置资料' }];
  const known = <T>(value: T): BattleField<T> => (knownField(value, evidence));
  const unknown = <T>(reason: string): BattleField<T> => (unknownField(reason, evidence));
  const garrisons: BattleUnit[] = units.map(unit => ({
    id: unit.id, color: unit.color, assertion: 'reported', unitName: known(unit.unitName),
    provinceId: known(unit.provinceId === 0 ? null : unit.provinceId), status: known(unit.status),
    parentUnitId: unknown('旧兵牌没有上级资料'), echelon: unknown('旧兵牌没有层级资料'),
    branch: unknown('旧兵牌没有兵种资料'), side: unknown('旧兵牌没有阵营资料'),
    childrenCompleteness: unknown('旧兵牌没有下属完整性资料'),
    personnel: { scope: 'legacy-unspecified', count: known(unit.troops) },
    ...(unit.customBadge !== undefined ? { customBadge: structuredClone(unit.customBadge) } : {}),
  }));
  battle.deployments = units.map(unit => {
    const deployment = createUnplacedBattleDeployment(unit.id, 'reported', evidence, '旧存档没有该项资料');
    if (unit.x !== undefined && unit.y !== undefined) {
      deployment.placement = known({ anchor: [unit.x, unit.y], shape: { kind: 'point' } });
    }
    return deployment;
  });
  return { mapId, garrisons, battle };
}

const json: JsonValidator = new JsonValidator((path, detail) => `战役字段无效：${path}${detail === undefined ? '' : `（${detail}）`}`);
const count = (v: unknown): boolean => finite(v) && Number.isInteger(v) && v >= 0;
const positive = (v: unknown): boolean => finite(v) && v > 0;
const line = (v: unknown): boolean => Array.isArray(v) && v.length >= 2 && v.every(point);
const area = (v: unknown): boolean => Array.isArray(v) && v.length > 0 && v.every(poly =>
  Array.isArray(poly) && poly.length > 0 && poly.every(ring => Array.isArray(ring) && ring.length >= 4 &&
    ring.every(point) && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]))
  && multiPolygonIsValid(v as BattleMultiPolygon);
const assertion = (v: unknown): boolean => v === 'reported' || v === 'plan';
const badgeCultures = ['universal', 'nato', 'huaxia', 'western', 'nomad', 'arcane', 'custom'];

function validateCustomBadge(badge: unknown, path: string): void {
  json.object(badge, path);
  json.check(badgeCultures.includes(badge.culture), `${path}.culture`);
  json.check(badge.requirementTag === undefined || text(badge.requirementTag), `${path}.requirementTag`);
  json.check(badge.customGlyph === undefined || text(badge.customGlyph), `${path}.customGlyph`);
  json.check(badge.customIconDataUrl === undefined ||
    (text(badge.customIconDataUrl) && (badge.customIconDataUrl === '' || badge.customIconDataUrl.startsWith('data:image/'))),
    `${path}.customIconDataUrl`);
  json.check(badge.textColor === undefined ||
    (text(badge.textColor) && /^#[0-9a-f]{6}$/i.test(badge.textColor)),
    `${path}.textColor`);
}

/** 文件/缓存反序列化和用户批次提交的统一边界；内部图层不再解析。 */
export function validateBattleWorkspace(value: unknown): asserts value is BattleWorkspace {
  json.object(value, 'workspace');
  json.check(text(value.mapId) && Array.isArray(value.garrisons), 'mapId/garrisons');
  json.object(value.battle, 'battle');
  const battle = value.battle;
  json.check(battle.schemaVersion === 1 && Array.isArray(battle.sources) && Array.isArray(battle.battlefields) &&
    Array.isArray(battle.deployments), 'battle.schemaVersion/collections');
  const sourceIds = new Set<string>();
  for (const source of battle.sources) {
    json.object(source, 'source');
    json.check(text(source.id) && source.id.trim().length > 0 && !sourceIds.has(source.id) &&
      ['reference', 'manual', 'ai', 'legacy'].includes(source.kind) && text(source.title) && text(source.text) &&
      (source.locator === null || text(source.locator)), 'source');
    sourceIds.add(source.id);
  }
  const evidence = (items: unknown, path: string): void => {
    json.check(Array.isArray(items), path);
    for (const item of items) {
      json.object(item, path);
      json.check(sourceIds.has(item.sourceId) && ['quoted', 'assumption', 'inference'].includes(item.basis) &&
        text(item.excerpt) && text(item.note), path);
    }
  };
  const field = (item: unknown, predicate: (v: unknown) => boolean, path: string): void => {
    json.object(item, path);
    evidence(item.evidence, `${path}.evidence`);
    json.check(item.state === 'known' ? predicate(item.value) : item.state === 'unknown' &&
      !('value' in item) && text(item.reason) && item.reason.length > 0, path);
  };
  const ids = new Set<string>();
  for (const unit of value.garrisons) {
    json.object(unit, 'unit');
    json.check(text(unit.id) && unit.id.trim().length > 0 && !ids.has(unit.id) && assertion(unit.assertion) &&
      /^#[0-9a-f]{6}$/i.test(unit.color), 'unit.id/assertion/color');
    ids.add(unit.id);
    for (const name of ['unitName', 'echelon', 'branch', 'side']) field(unit[name], text, `unit.${name}`);
    field(unit.parentUnitId, v => v === null || text(v), 'unit.parentUnitId');
    field(unit.provinceId, v => v === null || count(v), 'unit.provinceId');
    field(unit.status, v => ['驻防', '行军', '被围'].includes(String(v)), 'unit.status');
    field(unit.childrenCompleteness, v => v === 'complete' || v === 'partial', 'unit.childrenCompleteness');
    json.object(unit.personnel, 'unit.personnel');
    json.check(['own', 'inclusive', 'legacy-unspecified'].includes(unit.personnel.scope), 'unit.personnel.scope');
    field(unit.personnel.count, count, 'unit.personnel.count');
    if (unit.customBadge !== undefined) validateCustomBadge(unit.customBadge, 'unit.customBadge');
  }
  const units = new Map<string, BattleUnit>(value.garrisons.map((u: BattleUnit) => [u.id, u]));
  for (const unit of units.values()) {
    const seen = new Set([unit.id]);
    let parent = unit.parentUnitId;
    while (parent.state === 'known' && parent.value !== null) {
      json.check(ids.has(parent.value) && !seen.has(parent.value), `unit.${unit.id}.parentUnitId（缺失或循环）`);
      seen.add(parent.value);
      parent = units.get(parent.value)!.parentUnitId;
    }
  }
  const battlefieldIds = new Set<string>();
  for (const bf of battle.battlefields) {
    json.object(bf, 'battlefield');
    json.check(text(bf.id) && bf.id.trim().length > 0 && !battlefieldIds.has(bf.id) && bf.mapId === value.mapId &&
      assertion(bf.assertion), 'battlefield.id/mapId/assertion');
    battlefieldIds.add(bf.id);
    field(bf.name, text, 'battlefield.name');
    field(bf.boundary, area, 'battlefield.boundary');
    json.object(bf.scale, 'battlefield.scale');
    if (bf.scale.state === 'calibrated') {
      json.check(Array.isArray(bf.scale.referenceSegment) && bf.scale.referenceSegment.length === 2 &&
        bf.scale.referenceSegment.every(point) && positive(bf.scale.distanceMeters) && area(bf.scale.appliesWithin), 'scale');
      json.check(Math.hypot(bf.scale.referenceSegment[1][0] - bf.scale.referenceSegment[0][0],
        bf.scale.referenceSegment[1][1] - bf.scale.referenceSegment[0][1]) > 0, 'scale.referenceSegment');
      evidence(bf.scale.evidence, 'scale.evidence');
    } else json.check(bf.scale.state === 'uncalibrated' && text(bf.scale.reason), 'scale');
    json.check(Array.isArray(bf.terrain), 'terrain');
    const terrainIds = new Set<string>();
    for (const feature of bf.terrain) {
      json.object(feature, 'terrain.feature');
      json.check(text(feature.id) && feature.id.trim().length > 0 && !terrainIds.has(feature.id) && assertion(feature.assertion), 'terrain.id/assertion');
      terrainIds.add(feature.id);
      field(feature.label, text, 'terrain.label');
      if (feature.kind === 'obstacle' || feature.kind === 'deployment-zone') field(feature.area, area, 'terrain.area');
      else if (feature.kind === 'passage-line') field(feature.line, line, 'terrain.line');
      else {
        json.check(feature.kind === 'passage' && ['bridge', 'ford', 'pass'].includes(feature.passageKind) &&
          Array.isArray(feature.obstacleIds), 'terrain.passage');
        field(feature.point, point, 'terrain.point');
        field(feature.widthMapUnits, positive, 'terrain.widthMapUnits');
      }
    }
    for (const feature of bf.terrain) if (feature.kind === 'passage') {
      json.check(feature.obstacleIds.every((id: string) => bf.terrain.some((f: any) => f.id === id && f.kind === 'obstacle')),
        'terrain.passage.obstacleIds');
    }
  }
  const placed = new Set<string>();
  for (const dep of battle.deployments) {
    json.object(dep, 'deployment');
    json.check(ids.has(dep.unitId) && !placed.has(dep.unitId) && assertion(dep.assertion), 'deployment.unitId/assertion');
    placed.add(dep.unitId);
    field(dep.battlefieldId, v => v === null || (text(v) && battlefieldIds.has(v)), 'deployment.battlefieldId');
    field(dep.placement, v => {
      if (v === null || typeof v !== 'object') return false;
      const p = v as Record<string, any>;
      return point(p.anchor) && p.shape !== null && typeof p.shape === 'object' &&
        (p.shape.kind === 'point' || (p.shape.kind === 'frontage' && line(p.shape.line)) ||
          (p.shape.kind === 'area' && area(p.shape.area)));
    }, 'deployment.placement');
    field(dep.facingDegrees, v => finite(v) && v >= 0 && v < 360, 'deployment.facingDegrees');
    field(dep.depthMapUnits, v => finite(v) && v >= 0, 'deployment.depthMapUnits');
    field(dep.formationLine, v => count(v) && Number(v) >= 1, 'deployment.formationLine');
    field(dep.role, v => ['line', 'reserve', 'headquarters'].includes(String(v)), 'deployment.role');
    field(dep.reserveForUnitId, v => v === null || (text(v) && ids.has(v) && v !== dep.unitId), 'deployment.reserveForUnitId');
  }
  json.check(placed.size === ids.size, '每单位必须有一条当前部署（可未知）');
}
