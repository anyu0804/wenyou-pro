import type {
  BattleCandidateBatch, BattleDeployment, BattleDeploymentRequest, BattleDeploymentResult,
  BattleEditBatch, BattleField, BattleMultiPolygon, BattlePersonnelSummary, BattlePlacement,
  BattleUnit, BattleWorkspace, Battlefield,
} from '../../../../src/battle-contract';

/** 全部为合成设定；局部图幅 1000 × 800，不引用正式地图或世界事实。 */
export const syntheticMap = { mapId: 'synthetic-battle-valley', width: 1000, height: 800 };
const settingEvidence = [{ sourceId: 'setting', basis: 'assumption' as const, excerpt: '3 师、9 团的合成编制', note: '仅用于契约和功能样例' }];
const planEvidence = [{ sourceId: 'plan', basis: 'assumption' as const, excerpt: '第一梯队面向北，后置第二梯队及预备队', note: '演示假设，尚未执行' }];
const countEvidence = [{ sourceId: 'strength', basis: 'assumption' as const, excerpt: '师部各 200 人，各团 1000 人；第九团未报告', note: '人数来源独立于部署方案' }];
const named = { state: 'known' as const, evidence: settingEvidence };
const planned = { state: 'known' as const, evidence: planEvidence };
const counted = { state: 'known' as const, evidence: countEvidence };
const unitSettings = {
  assertion: 'reported' as const,
  color: '#2563eb',
  provinceId: { ...named, value: null },
  status: { ...named, value: '驻防' as const },
  branch: { ...named, value: '步兵' },
  side: { ...named, value: '蓝方' },
  childrenCompleteness: { ...named, value: 'complete' as const },
};

/** 师的 own 200 仅指师部；不再把包含各团的 3200 填入师部人数。 */
export const syntheticUnits: BattleUnit[] = [
  { ...unitSettings, id: 'd1', unitName: { ...named, value: '第一师' },
    parentUnitId: { ...named, value: null }, echelon: { ...named, value: '师' },
    personnel: { scope: 'own', count: { ...counted, value: 200 } } },
  { ...unitSettings, id: 'd2', unitName: { ...named, value: '第二师' },
    parentUnitId: { ...named, value: null }, echelon: { ...named, value: '师' },
    personnel: { scope: 'own', count: { ...counted, value: 200 } } },
  { ...unitSettings, id: 'd3', unitName: { ...named, value: '第三师' },
    parentUnitId: { ...named, value: null }, echelon: { ...named, value: '师' },
    personnel: { scope: 'own', count: { ...counted, value: 200 } } },
  { ...unitSettings, id: 'r11', unitName: { ...named, value: '第一团' },
    parentUnitId: { ...named, value: 'd1' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r12', unitName: { ...named, value: '第二团' },
    parentUnitId: { ...named, value: 'd1' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r13', unitName: { ...named, value: '第三团' },
    parentUnitId: { ...named, value: 'd1' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r21', unitName: { ...named, value: '第四团' },
    parentUnitId: { ...named, value: 'd2' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r22', unitName: { ...named, value: '第五团' },
    parentUnitId: { ...named, value: 'd2' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r23', unitName: { ...named, value: '第六团' },
    parentUnitId: { ...named, value: 'd2' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r31', unitName: { ...named, value: '第七团' },
    parentUnitId: { ...named, value: 'd3' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r32', unitName: { ...named, value: '第八团' },
    parentUnitId: { ...named, value: 'd3' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: { ...counted, value: 1000 } } },
  { ...unitSettings, id: 'r33', unitName: { ...named, value: '第九团' },
    parentUnitId: { ...named, value: 'd3' }, echelon: { ...named, value: '团' },
    personnel: { scope: 'own', count: {
      state: 'unknown', reason: '原文没有第九团人数', evidence: countEvidence,
    } } },
];

/** 第一块外边界含一处孔，第二块与其不连通；孔不能被当成可部署区。 */
export const valleyArea: BattleMultiPolygon = [
  [
    [[100, 100], [700, 100], [700, 700], [100, 700], [100, 100]],
    [[400, 300], [400, 400], [500, 400], [500, 300], [400, 300]],
  ],
  [[[800, 100], [950, 100], [950, 300], [800, 300], [800, 100]]],
];

export const syntheticBattlefield: Battlefield = {
  id: 'valley', mapId: syntheticMap.mapId, assertion: 'plan',
  name: { ...planned, value: '合成河谷战场' }, boundary: { ...planned, value: valleyArea },
  scale: {
    state: 'calibrated', referenceSegment: [[100, 650], [300, 650]], distanceMeters: 2000,
    appliesWithin: [[[[100, 100], [700, 100], [700, 700], [100, 700], [100, 100]]]],
    evidence: [{ sourceId: 'scale', basis: 'assumption', excerpt: '200 地图单位假设为 2000 米', note: '只适用于西侧主图幅；不是地图实测' }],
  },
  terrain: [
    { id: 'river', kind: 'obstacle', assertion: 'plan', label: { ...planned, value: '合成不可部署河段' },
      area: { ...planned, value: [[[[550, 100], [570, 100], [570, 650], [550, 650], [550, 100]]]] } },
    { id: 'deploy-west', kind: 'deployment-zone', assertion: 'plan',
      label: { ...planned, value: '河西展开区' },
      area: { ...planned, value: [[[[120, 150], [380, 150], [380, 620], [120, 620], [120, 150]]]] } },
    { id: 'road', kind: 'passage-line', assertion: 'plan', label: { ...planned, value: '通向桥口的道路标注' },
      line: { ...planned, value: [[300, 600], [530, 600], [560, 500], [620, 500]] } },
    { id: 'bridge', kind: 'passage', assertion: 'plan', label: { ...planned, value: '假设桥口' },
      point: { ...planned, value: [560, 500] }, passageKind: 'bridge', obstacleIds: ['river'],
      widthMapUnits: { ...planned, value: 8 } },
  ],
};

const deploymentSettings = {
  assertion: 'plan' as const,
  battlefieldId: { ...planned, value: 'valley' },
  facingDegrees: { ...planned, value: 0 },
  depthMapUnits: { ...planned, value: 40 },
  formationLine: { ...planned, value: 1 },
  role: { ...planned, value: 'line' as const },
  reserveForUnitId: { ...planned, value: null },
};
const pointAtHeadquarters: BattleField<BattlePlacement> = {
  ...planned, value: { anchor: [200, 600], shape: { kind: 'point' } },
};

/** 这些几何是人工合成示意；不是部署求解器输出或可行性验收结果。 */
export const syntheticDeployments: BattleDeployment[] = [
  { ...deploymentSettings, unitId: 'd1', role: { ...planned, value: 'headquarters' }, placement: pointAtHeadquarters },
  { ...deploymentSettings, unitId: 'd2', role: { ...planned, value: 'headquarters' },
    placement: { ...planned, value: { anchor: [300, 600], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'd3', role: { ...planned, value: 'headquarters' },
    placement: { ...planned, value: { anchor: [350, 600], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'r11', placement: { ...planned, value: {
    anchor: [160, 200], shape: { kind: 'area', area: [[[[130, 180], [190, 180], [190, 220], [130, 220], [130, 180]]]] },
  } } },
  { ...deploymentSettings, unitId: 'r12', placement: { ...planned, value: {
    anchor: [240, 200], shape: { kind: 'frontage', line: [[210, 180], [270, 180]] },
  } } },
  { ...deploymentSettings, unitId: 'r13', role: { ...planned, value: 'reserve' },
    formationLine: { ...planned, value: 2 }, reserveForUnitId: { ...planned, value: 'd1' },
    placement: { ...planned, value: { anchor: [200, 300], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'r21', placement: { ...planned, value: {
    anchor: [320, 200], shape: { kind: 'area', area: [[[[290, 180], [350, 180], [350, 220], [290, 220], [290, 180]]]] },
  } } },
  { ...deploymentSettings, unitId: 'r22', formationLine: { ...planned, value: 2 },
    placement: { ...planned, value: { anchor: [300, 300], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'r23', role: { ...planned, value: 'reserve' },
    formationLine: { ...planned, value: 3 }, reserveForUnitId: { ...planned, value: 'd2' },
    placement: { ...planned, value: { anchor: [300, 420], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'r31', formationLine: { ...planned, value: 2 },
    placement: { ...planned, value: { anchor: [160, 400], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'r32', role: { ...planned, value: 'reserve' },
    formationLine: { ...planned, value: 3 }, reserveForUnitId: { ...planned, value: 'd3' },
    placement: { ...planned, value: { anchor: [200, 500], shape: { kind: 'point' } } } },
  { ...deploymentSettings, unitId: 'r33',
    placement: { state: 'unknown', reason: '只知在河谷一带，未给出可定位范围', evidence: settingEvidence },
    facingDegrees: { state: 'unknown', reason: '没有朝向资料', evidence: settingEvidence },
    depthMapUnits: { state: 'unknown', reason: '没有纵深资料', evidence: settingEvidence },
    formationLine: { state: 'unknown', reason: '未分配梯队', evidence: settingEvidence },
    role: { state: 'unknown', reason: '未给出战术任务', evidence: settingEvidence },
    reserveForUnitId: { state: 'unknown', reason: '未给出预备队关系', evidence: settingEvidence } },
];

export const syntheticWorkspace: BattleWorkspace = {
  mapId: syntheticMap.mapId,
  garrisons: syntheticUnits,
  battle: {
    schemaVersion: 1,
    sources: [
      { id: 'setting', kind: 'manual', title: '合成编制设定', text: '3 师、9 团的合成编制；第九团仅知在河谷一带。', locator: null },
      { id: 'strength', kind: 'manual', title: '合成人数表', text: '师部各 200 人，各团 1000 人；第九团未报告。', locator: null },
      { id: 'plan', kind: 'manual', title: '合成部署方案', text: '第一梯队面向北，后置第二梯队及预备队。', locator: null },
      { id: 'scale', kind: 'manual', title: '局部尺度假设', text: '200 地图单位假设为 2000 米；只在西侧主图幅适用。', locator: null },
    ],
    battlefields: [syntheticBattlefield], deployments: syntheticDeployments,
  },
};

/** 预期统计值，尚无统计函数实现；不能把该对象当成一次测试运行。 */
export const expectedPersonnel: BattlePersonnelSummary = {
  total: { state: 'unknown', reason: '第九团人数未知，不能报三师完整总数', evidence: countEvidence },
  knownMinimum: 8600,
  countedUnitIds: ['d1', 'd2', 'd3', 'r11', 'r12', 'r13', 'r21', 'r22', 'r23', 'r31', 'r32'],
  unresolvedUnitIds: ['r33'], excludedUnitIds: [],
};

export const syntheticRequest: BattleDeploymentRequest = {
  battlefieldId: 'valley', assertion: 'plan', facingDegrees: 0,
  deploymentArea: [[[[120, 150], [380, 150], [380, 620], [120, 620], [120, 150]]]],
  lines: [
    { order: 1, front: [[130, 180], [350, 180]] },
    { order: 2, front: [[130, 280], [350, 280]] },
  ],
  allocations: [
    { unitId: 'r11', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40, role: 'line', reserveForUnitId: null },
    { unitId: 'r12', lineOrder: 1, frontageMapUnits: 60, depthMapUnits: 40, role: 'line', reserveForUnitId: null },
    { unitId: 'r13', lineOrder: 2, frontageMapUnits: 60, depthMapUnits: 40, role: 'reserve', reserveForUnitId: 'd1' },
  ], evidence: planEvidence,
};

/** 明示预期冲突结构，不声称已经执行几何运算。 */
export const syntheticConflict: BattleDeploymentResult = {
  outcome: 'conflict', issues: [{
    code: 'insufficient-frontage', unitIds: ['r11', 'r12'], terrainIds: [],
    message: '另一个狭口场景只给出 80 地图单位正面，两团各要求 60，不能满足。',
  }],
};

const aiEvidence = [{ sourceId: 'ai-draft', basis: 'inference' as const, excerpt: '建议把第三团预备位置移至 [220, 320]', note: 'AI 方案，待人审阅' }];
export const syntheticCandidate: BattleCandidateBatch = {
  format: 'wenyou-battle-candidates', version: 1, mapId: syntheticMap.mapId,
  sources: [{ id: 'ai-draft', kind: 'ai', title: '合成 AI 候选', locator: null,
    text: '建议把第三团预备位置移至 [220, 320]；第九团人数及确切位置仍未知。' }],
  items: [
    { id: 'candidate-r13', state: 'ready', instruction: '修改第三团的预备位置', evidence: aiEvidence,
      edits: [{ kind: 'set-deployment', deployment: {
        ...deploymentSettings, unitId: 'r13', role: { ...planned, value: 'reserve' },
        formationLine: { ...planned, value: 2 }, reserveForUnitId: { ...planned, value: 'd1' },
        placement: { state: 'known', evidence: aiEvidence, value: { anchor: [220, 320], shape: { kind: 'point' } } },
      } }] },
    { id: 'candidate-r33', state: 'unresolved', instruction: '定位第九团', evidence: aiEvidence,
      reason: '原文只有“河谷一带”，不能生成精确坐标；人数也未给出' },
  ],
};

/** 用户接受第一项后才会构造此批次；源记录与实际编辑同批提交。 */
export const acceptedCandidateBatch: BattleEditBatch = {
  label: '接受第三团预备位置建议', origin: 'candidate', candidateItemIds: ['candidate-r13'],
  edits: [
    { kind: 'upsert-source', source: syntheticCandidate.sources[0] },
    { kind: 'set-deployment', deployment: {
      ...deploymentSettings, unitId: 'r13', role: { ...planned, value: 'reserve' },
      formationLine: { ...planned, value: 2 }, reserveForUnitId: { ...planned, value: 'd1' },
      placement: { state: 'known', evidence: aiEvidence, value: { anchor: [220, 320], shape: { kind: 'point' } } },
    } },
  ],
};

/** 同图幅另一个战场没有尺度资料，不填米制比例。 */
export const uncalibratedBattlefield: Battlefield = {
  id: 'unmeasured-east', mapId: syntheticMap.mapId, assertion: 'plan',
  name: { ...planned, value: '未校准东侧区域' },
  boundary: { ...planned, value: [[[[800, 100], [950, 100], [950, 300], [800, 300], [800, 100]]]] },
  scale: { state: 'uncalibrated', reason: '没有该范围的距离资料，不能沿用西侧比例' }, terrain: [],
};
