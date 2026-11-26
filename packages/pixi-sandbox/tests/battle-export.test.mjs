import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const {
  exportBattlePng,
  computeBattlefieldBounds,
  collectBattlefieldEvidence,
  generateLegendItems,
  generateScaleAnnotation,
  drawBattleToContext,
} = await server.ssrLoadModule('/src/battle-export.ts');

const {
  syntheticWorkspace,
  syntheticBattlefield,
  uncalibratedBattlefield,
} = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');

test('computeBattlefieldBounds: 正确计算河谷战场的整体平面包围盒', () => {
  const deps = syntheticWorkspace.battle.deployments;
  const bounds = computeBattlefieldBounds(syntheticBattlefield, deps);

  assert.ok(bounds.minX <= 100);
  assert.ok(bounds.maxX >= 700);
  assert.ok(bounds.minY <= 100);
  assert.ok(bounds.maxY >= 700);
  assert.ok(bounds.width >= 600);
  assert.ok(bounds.height >= 600);
});

test('collectBattlefieldEvidence: 提取证据，重点区分 assumption 与既有文献', () => {
  const deps = syntheticWorkspace.battle.deployments;
  const summary = collectBattlefieldEvidence(syntheticBattlefield, syntheticWorkspace, deps);

  // 必须识别出明确假设（basis: 'assumption'）
  assert.ok(summary.assumptions.length > 0);
  const scaleAssumption = summary.assumptions.find((a) => a.sourceId === 'scale');
  assert.ok(scaleAssumption !== undefined);
  assert.equal(scaleAssumption.basis, 'assumption');

  // 必须关联到对应的 source 元数据
  assert.ok(summary.sources.length > 0);
});

test('generateLegendItems: 生成包含边界、障碍、部署区、折线、占地与方案的完整图例', () => {
  const deps = syntheticWorkspace.battle.deployments;
  const items = generateLegendItems(syntheticBattlefield, deps, syntheticWorkspace);

  const labels = items.map((i) => i.label);
  assert.ok(labels.some((l) => l.includes('战场范围')));
  assert.ok(labels.some((l) => l.includes('障碍禁止区')));
  assert.ok(labels.some((l) => l.includes('允许部署区')));
  assert.ok(labels.some((l) => l.includes('展开战线')));
  assert.ok(labels.some((l) => l.includes('部署占地区')));
  assert.ok(labels.some((l) => l.includes('推演方案')));
});

test('generateScaleAnnotation: 严格区分已校准米制尺度与未校准警示', () => {
  // 1. 已校准尺度
  const calib = generateScaleAnnotation(syntheticBattlefield.scale);
  assert.equal(calib.isCalibrated, true);
  assert.ok(calib.detail.includes('2000 米'));
  assert.ok(calib.detail.includes('仅适用局部战场'));

  // 2. 未校准尺度（严禁生成虚假比例）
  const uncalib = generateScaleAnnotation(uncalibratedBattlefield.scale);
  assert.equal(uncalib.isCalibrated, false);
  assert.ok(uncalib.title.includes('尺度未校准'));
  assert.ok(uncalib.detail.includes('严禁外推公里比例'));
});

test('exportBattlePng: 未知战场 ID 明确报错（入口信任边界校验）', async () => {
  await assert.rejects(
    async () => {
      await exportBattlePng(syntheticWorkspace, 'non-existent-bf');
    },
    /未在当前工作区中找到战场 ID/
  );
});

test('exportBattlePng: 没有真实 Canvas 时明确失败，不能返回伪造的 1×1 PNG', async () => {
  await assert.rejects(exportBattlePng(syntheticWorkspace, 'valley'), /需要浏览器 Canvas/);
});

test('drawBattleToContext: 使用 Mock Canvas 上下文验证完整绘制流程被调用', () => {
  const drawCalls = [];
  const mockCtx = {
    fillRect: (...args) => drawCalls.push({ method: 'fillRect', args }),
    strokeRect: (...args) => drawCalls.push({ method: 'strokeRect', args }),
    beginPath: () => drawCalls.push({ method: 'beginPath' }),
    moveTo: (...args) => drawCalls.push({ method: 'moveTo', args }),
    lineTo: (...args) => drawCalls.push({ method: 'lineTo', args }),
    closePath: () => drawCalls.push({ method: 'closePath' }),
    fill: (...args) => drawCalls.push({ method: 'fill', args }),
    stroke: () => drawCalls.push({ method: 'stroke' }),
    arc: (...args) => drawCalls.push({ method: 'arc', args }),
    fillText: (...args) => drawCalls.push({ method: 'fillText', args }),
    setLineDash: (...args) => drawCalls.push({ method: 'setLineDash', args }),
    set strokeStyle(v) {},
    set fillStyle(v) {},
    set lineWidth(v) {},
    set font(v) {},
    set textAlign(v) {},
  };

  const deps = syntheticWorkspace.battle.deployments;
  drawBattleToContext(mockCtx, syntheticWorkspace, syntheticBattlefield, deps, 1600, 1000, 40);

  // 验证各层绘制均发生
  assert.ok(drawCalls.some((c) => c.method === 'fillRect'));
  assert.ok(drawCalls.some((c) => c.method === 'fillText' && String(c.args[0]).includes('战役沙盘简报')));
  assert.ok(drawCalls.some((c) => c.method === 'fillText' && String(c.args[0]).includes('战术图例')));
  assert.ok(drawCalls.some((c) => c.method === 'fillText' && String(c.args[0]).includes('情报依据与推演假设')));
  // 部署面必须用 even-odd 填充，孔洞才不会被外环颜色盖住
  assert.ok(drawCalls.some((c) => c.method === 'fill' && c.args[0] === 'evenodd'));
});

test('回归：PNG 导出对战场边界和障碍孔洞也使用 evenodd 填充，证据收集覆盖 terrain/echelon/facingDegrees', () => {
  const drawCalls = [];
  const mockCtx = {
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    fill: (...args) => drawCalls.push({ method: 'fill', args }),
    stroke: () => {},
    arc: () => {},
    fillText: () => {},
    setLineDash: () => {},
    set strokeStyle(v) {},
    set fillStyle(v) {},
    set lineWidth(v) {},
    set font(v) {},
    set textAlign(v) {},
  };

  // 移除部署占地面，仅保留带孔战场边界与带孔障碍，验证边界与障碍仍以 evenodd 填充
  const ws = structuredClone(syntheticWorkspace);
  const bf = structuredClone(syntheticBattlefield);
  bf.terrain[0].area.value[0].push([[555, 200], [555, 240], [565, 240], [565, 200], [555, 200]]);
  drawBattleToContext(mockCtx, ws, bf, [], 1600, 1000, 40);
  const evenOddCount = drawCalls.filter((c) => c.method === 'fill' && c.args[0] === 'evenodd').length;
  assert.ok(evenOddCount >= 2, `期望边界、障碍与部署区均使用 evenodd，实测 ${evenOddCount}`);

  // 为 terrain / echelon / facingDegrees 分别挂独立来源并检查 collectBattlefieldEvidence
  ws.battle.sources.push(
    { id: 'terrain-ev', kind: 'manual', title: '地形调查', text: '地形假设', locator: null },
    { id: 'echelon-ev', kind: 'manual', title: '编制假设', text: '层级假设', locator: null },
    { id: 'facing-ev', kind: 'manual', title: '朝向假设', text: '朝向假设', locator: null },
  );
  bf.terrain[0].label.evidence = [{ sourceId: 'terrain-ev', basis: 'assumption', excerpt: '河段地形假设', note: 'terrain' }];
  ws.garrisons[0].echelon.evidence = [{ sourceId: 'echelon-ev', basis: 'assumption', excerpt: '师级编制假设', note: 'echelon' }];
  ws.battle.deployments[0].facingDegrees.evidence = [{ sourceId: 'facing-ev', basis: 'assumption', excerpt: '朝向假设', note: 'facing' }];

  const summary = collectBattlefieldEvidence(bf, ws, ws.battle.deployments);
  const assumptionIds = new Set(summary.assumptions.map((a) => a.sourceId));
  assert.equal(assumptionIds.has('terrain-ev'), true);
  assert.equal(assumptionIds.has('echelon-ev'), true);
  assert.equal(assumptionIds.has('facing-ev'), true);
});
