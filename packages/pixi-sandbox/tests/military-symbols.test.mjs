import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const {
  ECHELON_TIER_SPECS,
  resolveTroopEchelon,
  getEchelonSymbol,
  resolveRequirementTotem,
  renderUnitSymbolToContext,
} = await server.ssrLoadModule('/src/military-symbols.ts');

test('resolveTroopEchelon: 8 个人数区间精确推导 7 档军标编制', () => {
  // 1. 0–500 (连 |)
  assert.equal(resolveTroopEchelon(0).symbol, '|');
  assert.equal(resolveTroopEchelon(0).tierIndex, 1);
  assert.equal(resolveTroopEchelon(0).echelonName, '连');
  assert.equal(resolveTroopEchelon(500).symbol, '|');

  // 2. 500–2000 (营 ||)
  assert.equal(resolveTroopEchelon(501).symbol, '||');
  assert.equal(resolveTroopEchelon(501).tierIndex, 2);
  assert.equal(resolveTroopEchelon(501).echelonName, '营');
  assert.equal(resolveTroopEchelon(2000).symbol, '||');

  // 3. 2000–6000 (团 |||)
  assert.equal(resolveTroopEchelon(2001).symbol, '|||');
  assert.equal(resolveTroopEchelon(2001).tierIndex, 3);
  assert.equal(resolveTroopEchelon(2001).echelonName, '团');
  assert.equal(resolveTroopEchelon(6000).symbol, '|||');

  // 4. 6000–18000 (师 x)
  assert.equal(resolveTroopEchelon(6001).symbol, 'x');
  assert.equal(resolveTroopEchelon(6001).tierIndex, 4);
  assert.equal(resolveTroopEchelon(6001).echelonName, '师');
  assert.equal(resolveTroopEchelon(18000).symbol, 'x');

  // 5. 18000–54000 (军 xx)
  assert.equal(resolveTroopEchelon(18001).symbol, 'xx');
  assert.equal(resolveTroopEchelon(18001).tierIndex, 5);
  assert.equal(resolveTroopEchelon(18001).echelonName, '军');
  assert.equal(resolveTroopEchelon(54000).symbol, 'xx');

  // 6. 54000–150000 (集团军 xxx)
  assert.equal(resolveTroopEchelon(54001).symbol, 'xxx');
  assert.equal(resolveTroopEchelon(54001).tierIndex, 6);
  assert.equal(resolveTroopEchelon(54001).echelonName, '集团军');
  assert.equal(resolveTroopEchelon(150000).symbol, 'xxx');

  // 7. 150000–450000 (方面军 xxxx)
  assert.equal(resolveTroopEchelon(150001).symbol, 'xxxx');
  assert.equal(resolveTroopEchelon(150001).tierIndex, 7);
  assert.equal(resolveTroopEchelon(150001).echelonName, '方面军');
  assert.equal(resolveTroopEchelon(450000).symbol, 'xxxx');

  // 8. 450000+ (重型方面军 xxxx，tierIndex: 8)
  assert.equal(resolveTroopEchelon(450001).symbol, 'xxxx');
  assert.equal(resolveTroopEchelon(450001).tierIndex, 8);
  assert.equal(resolveTroopEchelon(450001).bracketLabel, '450000+');
  assert.equal(resolveTroopEchelon(1000000).tierIndex, 8);

  // 无效与边界输入回退至团级 Tier 3
  assert.equal(resolveTroopEchelon(null).tierIndex, 3);
  assert.equal(resolveTroopEchelon(undefined).tierIndex, 3);
  assert.equal(resolveTroopEchelon(NaN).tierIndex, 3);
  assert.equal(resolveTroopEchelon(-10).tierIndex, 3);
});

test('getEchelonSymbol: 7 档层级符号映射与旧符号及人数联动', () => {
  // 7 档层级文本
  assert.equal(getEchelonSymbol('连'), '|');
  assert.equal(getEchelonSymbol('前锋营'), '||');
  assert.equal(getEchelonSymbol('主力团'), '|||');
  assert.equal(getEchelonSymbol('第一师'), 'x');
  assert.equal(getEchelonSymbol('独立旅'), 'x');
  assert.equal(getEchelonSymbol('禁卫军'), 'xx');
  assert.equal(getEchelonSymbol('集团军'), 'xxx');
  assert.equal(getEchelonSymbol('野战兵团'), 'xxx');
  assert.equal(getEchelonSymbol('西部方面军'), 'xxxx');

  // 7 档标准符号直接传入原样返回
  assert.equal(getEchelonSymbol('|'), '|');
  assert.equal(getEchelonSymbol('||'), '||');
  assert.equal(getEchelonSymbol('|||'), '|||');
  assert.equal(getEchelonSymbol('x'), 'x');
  assert.equal(getEchelonSymbol('xx'), 'xx');
  assert.equal(getEchelonSymbol('xxx'), 'xxx');
  assert.equal(getEchelonSymbol('xxxx'), 'xxxx');

  // 文本为空但提供人数时自动推导
  assert.equal(getEchelonSymbol('', 450), '|');
  assert.equal(getEchelonSymbol(undefined, 1500), '||');
  assert.equal(getEchelonSymbol(null, 5000), '|||');
  assert.equal(getEchelonSymbol('', 12000), 'x');
  assert.equal(getEchelonSymbol('', 35000), 'xx');
  assert.equal(getEchelonSymbol('', 80000), 'xxx');
  assert.equal(getEchelonSymbol('', 200000), 'xxxx');
  assert.equal(getEchelonSymbol('', 500000), 'xxxx');
});

test('resolveRequirementTotem: 兵种关键词与需求标签自动匹配图腾', () => {
  assert.equal(resolveRequirementTotem('重装步兵').subType, 'heavy-infantry');
  assert.equal(resolveRequirementTotem('铁骑突击').subType, 'cavalry');
  assert.equal(resolveRequirementTotem('神机营火炮').subType, 'artillery');
  assert.equal(resolveRequirementTotem('长江水师').subType, 'naval');
  assert.equal(resolveRequirementTotem('狮鹫空骑').subType, 'air');
  assert.equal(resolveRequirementTotem('皇家禁军').subType, 'guard');
  assert.equal(resolveRequirementTotem('奥术法师团').subType, 'arcane');
  assert.equal(resolveRequirementTotem('工兵工程队').subType, 'support');
  assert.equal(resolveRequirementTotem('').subType, 'infantry');
});

test('renderUnitSymbolToContext: 使用 Mock Context 验证通用分档与文化兵牌绘制', () => {
  const calls = [];
  const mockCtx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    clearRect: (...args) => calls.push(['clearRect', ...args]),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    rect: (...args) => calls.push(['rect', ...args]),
    strokeRect: (...args) => calls.push(['strokeRect', ...args]),
    fillRect: (...args) => calls.push(['fillRect', ...args]),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    moveTo: (...args) => calls.push(['moveTo', ...args]),
    lineTo: (...args) => calls.push(['lineTo', ...args]),
    quadraticCurveTo: (...args) => calls.push(['quadraticCurveTo', ...args]),
    fillText: (text, x, y) => calls.push(['fillText', text, x, y]),
    translate: (x, y) => calls.push(['translate', x, y]),
  };

  // 1. 验证纯军标模式 (34x34) 华夏文化 + 自定义大字
  calls.length = 0;
  renderUnitSymbolToContext(mockCtx, {
    troops: 4800,
    echelon: '团',
    unitName: '陷阵营',
    color: '#ef4444',
    isMinimal: true,
    customBadge: {
      culture: 'huaxia',
      customGlyph: '陷阵',
      requirementTag: '重甲步兵',
    },
  });
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillText' && c[1] === '|||'));
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillText' && c[1] === '陷阵'));
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillText' && c[1] === '4800'));

  // 2. 验证标准兵牌模式 (72x22) 奥术文化
  calls.length = 0;
  renderUnitSymbolToContext(mockCtx, {
    troops: 15000,
    echelon: '师',
    unitName: '星穹法师师',
    color: '#8b5cf6',
    isMinimal: false,
    customBadge: {
      culture: 'arcane',
      requirementTag: '奥术',
    },
  });
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillText' && c[1] === 'x'));
  assert.ok(calls.some(c => Array.isArray(c) && c[0] === 'fillText' && c[1] === '1.5万'));
});

test('回归：NaN/负兵力不打印畸形文本，带 data:image/ 自定义图标时抑制默认文字字形', () => {
  const printedTexts = [];
  const mockCtx = {
    save: () => {},
    restore: () => {},
    clearRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    rect: () => {},
    strokeRect: () => {},
    fillRect: () => {},
    fill: () => {},
    stroke: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    bezierCurveTo: () => {},
    arc: () => {},
    fillText: (text) => printedTexts.push(String(text)),
    translate: () => {},
  };

  for (const badTroops of [Number.NaN, -5]) {
    printedTexts.length = 0;
    renderUnitSymbolToContext(mockCtx, {
      troops: badTroops,
      echelon: '团',
      unitName: '测试军',
      color: '#ef4444',
      isMinimal: true,
      customBadge: {
        culture: 'huaxia',
        customGlyph: '陷阵',
        customIconDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
    });
    assert.equal(printedTexts.some((t) => t.includes('NaN') || t.includes('-5')), false);
    assert.equal(printedTexts.some((t) => t.includes('陷阵')), false);
  }
});
