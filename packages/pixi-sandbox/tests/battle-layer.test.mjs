import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const {
  renderBattle,
  colorToHex,
  getFacingVector,
  getEchelonSymbol,
  resolveTroopEchelon,
} = await server.ssrLoadModule('/src/battle-layer.ts');

const {
  syntheticWorkspace,
} = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');

const { Container } = await server.ssrLoadModule('pixi.js');

test('colorToHex: 正确解析 6 位、3 位十六进制与默认回退', () => {
  assert.equal(colorToHex('#ff0000'), 0xff0000);
  assert.equal(colorToHex('2563eb'), 0x2563eb);
  assert.equal(colorToHex('#fff'), 0xffffff);
  assert.equal(colorToHex('', 0x123456), 0x123456);
  assert.equal(colorToHex(undefined, 0x123456), 0x123456);
});

test('getFacingVector: 遵循 contract 0度上、90度右、180度下、270度左', () => {
  const vUp = getFacingVector(0);
  assert.ok(Math.abs(vUp[0] - 0) < 1e-6);
  assert.ok(Math.abs(vUp[1] - (-1)) < 1e-6);

  const vRight = getFacingVector(90);
  assert.ok(Math.abs(vRight[0] - 1) < 1e-6);
  assert.ok(Math.abs(vRight[1] - 0) < 1e-6);

  const vDown = getFacingVector(180);
  assert.ok(Math.abs(vDown[0] - 0) < 1e-6);
  assert.ok(Math.abs(vDown[1] - 1) < 1e-6);

  const vLeft = getFacingVector(270);
  assert.ok(Math.abs(vLeft[0] - (-1)) < 1e-6);
  assert.ok(Math.abs(vLeft[1] - 0) < 1e-6);
});

test('getEchelonSymbol: 正确映射 7 档层级符号与人数推导', () => {
  assert.equal(getEchelonSymbol('连'), '|');
  assert.equal(getEchelonSymbol('营'), '||');
  assert.equal(getEchelonSymbol('团'), '|||');
  assert.equal(getEchelonSymbol('师'), 'x');
  assert.equal(getEchelonSymbol('第一师'), 'x');
  assert.equal(getEchelonSymbol('旅'), 'x');
  assert.equal(getEchelonSymbol('军'), 'xx');
  assert.equal(getEchelonSymbol('集团军'), 'xxx');
  assert.equal(getEchelonSymbol('方面军'), 'xxxx');

  // 人数自动推导 8 区间
  assert.equal(getEchelonSymbol('', 400), '|');
  assert.equal(getEchelonSymbol('', 1500), '||');
  assert.equal(getEchelonSymbol('', 4500), '|||');
  assert.equal(getEchelonSymbol('', 12000), 'x');
  assert.equal(getEchelonSymbol('', 35000), 'xx');
  assert.equal(getEchelonSymbol('', 80000), 'xxx');
  assert.equal(getEchelonSymbol('', 250000), 'xxxx');
  assert.equal(getEchelonSymbol('', 600000), 'xxxx');
});

test('resolveTroopEchelon: 8 区间推导编制与规格完整对应', () => {
  assert.equal(resolveTroopEchelon(200).bracketLabel, '0-500');
  assert.equal(resolveTroopEchelon(1200).bracketLabel, '500-2000');
  assert.equal(resolveTroopEchelon(5000).bracketLabel, '2000-6000');
  assert.equal(resolveTroopEchelon(15000).bracketLabel, '6000-18000');
  assert.equal(resolveTroopEchelon(40000).bracketLabel, '18000-54000');
  assert.equal(resolveTroopEchelon(100000).bracketLabel, '54000-150000');
  assert.equal(resolveTroopEchelon(300000).bracketLabel, '150000-450000');
  assert.equal(resolveTroopEchelon(800000).bracketLabel, '450000+');
});

test('renderBattle: 兵牌尺寸重构（标准 72x22 缩小、军标 34x34 加大）与自定义兵牌支持', () => {
  const workspace = structuredClone(syntheticWorkspace);
  const r11 = workspace.garrisons.find(g => g.id === 'r11');
  r11.customBadge = {
    culture: 'huaxia',
    customGlyph: '突骑',
    requirementTag: '铁骑',
  };

  // 1. 常规模式渲染 (scale = 1.0)：标准兵牌缩小
  const rootStd = new Container();
  renderBattle(workspace, rootStd, { scale: 1.0 });
  const badgeLayerStd = rootStd.children.find(c => c.label === 'battle-badges');
  assert.ok(badgeLayerStd.children.length > 0);

  // 2. 纯军标模式渲染 (scale = 0.4)：军标加大为 34x34
  const rootMin = new Container();
  renderBattle(workspace, rootMin, { scale: 0.4 });
  const badgeLayerMin = rootMin.children.find(c => c.label === 'battle-badges');
  assert.ok(badgeLayerMin.children.length > 0);
  for (const badge of badgeLayerMin.children) {
    assert.equal(badge.scale.x, 2.5); // 1 / 0.4 = 2.5
  }
});

test('renderBattle: 完整渲染河谷战役，包含地形、部署与标牌三层', () => {
  const rootContainer = new Container();
  renderBattle(syntheticWorkspace, rootContainer, {
    scale: 1.0,
    showTerrain: true,
    showDeployments: true,
    showBadges: true,
  });

  assert.equal(rootContainer.children.length, 3);
  const [terrainLayer, depLayer, badgeLayer] = rootContainer.children;
  assert.equal(terrainLayer.label, 'battle-terrain');
  assert.equal(depLayer.label, 'battle-deployments');
  assert.equal(badgeLayer.label, 'battle-badges');

  // 部署层包含若干子图元（正面、占地多边形、朝向）
  assert.ok(depLayer.children.length > 0);
  // 标牌层包含标牌背景与文字
  assert.ok(badgeLayer.children.length > 0);
});

test('renderBattle: 分级缩放 LOD 选项生效', () => {
  const rootMin = new Container();
  renderBattle(syntheticWorkspace, rootMin, { scale: 0.4 });
  assert.equal(rootMin.children.length, 3);

  const rootMax = new Container();
  renderBattle(syntheticWorkspace, rootMax, { scale: 1.8 });
  assert.equal(rootMax.children.length, 3);
});

test('renderBattle: 临时标牌避让偏移生效且不改变实际部署', () => {
  const offsets = new Map();
  offsets.set('d1', [25, -15]);

  const root = new Container();
  renderBattle(syntheticWorkspace, root, { badgeOffsets: offsets });

  // 原始 deployment 锚点保持未变
  const depD1 = syntheticWorkspace.battle.deployments.find((d) => d.unitId === 'd1');
  assert.deepEqual(depD1.placement.value.anchor, [200, 600]);
});

test('renderBattle: 位置未知的部队（如 r33）不生成地图图元与标牌', () => {
  const r33Dep = syntheticWorkspace.battle.deployments.find((d) => d.unitId === 'r33');
  assert.equal(r33Dep.placement.state, 'unknown');

  // 全量渲染检查无崩溃
  const root = new Container();
  renderBattle(syntheticWorkspace, root);
  assert.ok(root.children.length > 0);
});

test('renderBattle: 兵牌按屏幕尺寸绘制，不随地图缩放拉伸', () => {
  const root = new Container();
  renderBattle(syntheticWorkspace, root, { scale: 2 });

  const badgeLayer = root.children.find((child) => child.label === 'battle-badges');
  assert.ok(badgeLayer.children.length > 0);
  for (const badge of badgeLayer.children) assert.equal(badge.scale.x, 0.5);
});

test('renderBattle: 部署面孔洞用 cut() 挖空，不再被外环填色盖住', () => {
  const workspace = structuredClone(syntheticWorkspace);
  const deployment = workspace.battle.deployments.find((dep) => dep.unitId === 'r11');
  deployment.placement.value.shape.area[0].push([
    [150, 195], [170, 195], [170, 205], [150, 205], [150, 195],
  ]);

  const root = new Container();
  renderBattle(workspace, root);

  const deploymentLayer = root.children.find((child) => child.label === 'battle-deployments');
  const hasHole = (node) => {
    if (node.context?.instructions?.some((item) => item.action === 'fill' && item.data?.hole)) return true;
    return (node.children ?? []).some(hasHole);
  };
  assert.equal(hasHole(deploymentLayer), true);
});

test('回归：plan 虚线正面/纵深实际产出描边指令，地形与障碍孔洞挖空，legacy-unspecified 显示(旧档未明)', () => {
  const workspace = structuredClone(syntheticWorkspace);
  // 1. 仅保留 d1 为 plan frontage + depth，隔离检验 frontage 与 depth 虚线均产生非空 path 的 stroke 指令
  const d1 = workspace.battle.deployments.find((d) => d.unitId === 'd1');
  d1.assertion = 'plan';
  d1.depthMapUnits = { state: 'known', value: 30, evidence: [] };
  d1.placement = {
    state: 'known',
    evidence: [],
    value: { anchor: [200, 600], shape: { kind: 'frontage', line: [[160, 600], [240, 600]] } },
  };
  workspace.battle.deployments = [d1];

  // 2. 给河段障碍 river 增加内部孔洞（valleyArea 边界本身已有 1 个孔洞）
  const river = workspace.battle.battlefields[0].terrain.find((f) => f.id === 'river');
  river.area.value[0].push([[555, 200], [555, 240], [565, 240], [565, 200], [555, 200]]);

  // 3. 把 d1 人事口径设为 legacy-unspecified
  const d1Unit = workspace.garrisons.find((u) => u.id === 'd1');
  d1Unit.personnel = { scope: 'legacy-unspecified', count: { state: 'known', value: 1200, evidence: [] } };

  const root = new Container();
  renderBattle(workspace, root, { scale: 1.0, showTerrain: true, showDeployments: true, showBadges: true });

  const depLayer = root.children.find((c) => c.label === 'battle-deployments');
  const strokePaths = [];
  const collectStrokes = (node) => {
    for (const inst of node.context?.instructions ?? []) {
      if (inst.action === 'stroke') strokePaths.push(inst.data?.path?.instructions?.length ?? 0);
    }
    for (const child of node.children ?? []) collectStrokes(child);
  };
  collectStrokes(depLayer);
  assert.ok(strokePaths.length >= 2, `plan 正面虚线与纵深虚线应产生多个 stroke 指令，实测 ${strokePaths.length}`);
  assert.ok(strokePaths.every((len) => len > 0), '每条 stroke 指令必须在描边前写入有效路径');

  const terrainLayer = root.children.find((c) => c.label === 'battle-terrain');
  let holeFills = 0;
  const countHoles = (node) => {
    for (const inst of node.context?.instructions ?? []) {
      if (inst.action === 'fill' && inst.data?.hole) holeFills++;
    }
    for (const child of node.children ?? []) countHoles(child);
  };
  countHoles(terrainLayer);
  assert.ok(holeFills >= 2, `战场边界孔洞与障碍孔洞均应触发 hole fill，实测 ${holeFills}`);

  const badgeLayer = root.children.find((c) => c.label === 'battle-badges');
  const texts = [];
  const collectTexts = (node) => {
    if (typeof node.text === 'string' && node.text.length > 0) texts.push(node.text);
    for (const child of node.children ?? []) collectTexts(child);
  };
  collectTexts(badgeLayer);
  assert.equal(texts.some((t) => t.includes('(旧档未明)')), true);
  assert.equal(texts.some((t) => t.includes('(总数)')), false);
});

test('兵牌去除默认战术图腾并支持自定义字体颜色', () => {
  const workspace = structuredClone(syntheticWorkspace);
  const d1 = workspace.garrisons.find((u) => u.id === 'd1');
  d1.customBadge = { culture: 'universal', requirementTag: '草原铁骑', textColor: '#fde047' };

  const root = new Container();
  renderBattle(workspace, root, { scale: 1.0, badgeStyle: 'standard', badgeScale: 1.5 });
  const badgeLayer = root.children.find((c) => c.label === 'battle-badges');
  const d1Badge = badgeLayer.children.find((c) => c.label === 'd1');
  assert.ok(d1Badge);

  const textNodes = d1Badge.children.filter((c) => typeof c.text === 'string');
  assert.equal(textNodes.some((n) => n.text === '🐎' || n.text === '⚔️'), false, '不再默认渲染战术图腾 emoji');
  assert.ok(textNodes.some((n) => n.style?.fill === '#fde047'), '自定义字体颜色应应用到兵牌文字');
  assert.ok(textNodes.every((n) => n.resolution >= 2), '兵牌文字应开启高分辨率超采样');
});
