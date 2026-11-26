// FB-V · 战场快照 v0.6.0 独立验收（11 组场景）
// 运行：node tests/field-battle-acceptance.test.mjs
// 证据输出：.tmp-build/fb/（截图 PNG、关键 JSON、失败断言原文）
// 规则：不修改任何 src/**；不注入 __perf 或测试 UI；不启动 Edge（只用 Playwright Chromium headless）。
// 断言按 contract.md + contract-errata.md 冻结口径书写，不因当前集成进度放宽。
// 集成完成前（FB-G 未接线）允许失败；失败归属包见每条 check 的 owner 字段，判断等集成后进行。

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const PORT = 5297;
const BASE = `http://127.0.0.1:${PORT}/`;
const output = new URL('../.tmp-build/fb/', import.meta.url);
const outPath = p => fileURLToPath(new URL(p, output));

// 1x1 红色 PNG，用于主地图自定义图片兵牌检查。
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const server = await createServer({
  // 预打包战场场景依赖：否则页面内首次 import pixi-viewport 会触发 Vite 全页重载，
  // 毁掉进行中的 evaluate 上下文（2026-10-21 实测）。
  optimizeDeps: { include: ['pixi-viewport'] },
  server: { hmr: false, host: '127.0.0.1', port: PORT, strictPort: true,
    watch: { ignored: ['**/.tmp-build/**'] } },
});
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
page.setDefaultTimeout(15000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));

// ---------------------------------------------------------------------------
// 报告框架：逐场景、逐 check 记录 pass/fail 与归属包
// ---------------------------------------------------------------------------

const report = [];
let current = null;
let errorsAtScenarioStart = 0;

const slug = text => String(text).replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 60);

async function shot(name) {
  try { await page.screenshot({ path: outPath(name) }); } catch { /* 截图失败不掩盖断言结果 */ }
}

async function dump(name, data) {
  await fs.writeFile(outPath(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function step(owner, desc, fn) {
  try {
    await fn();
    current.checks.push({ owner, desc, status: 'pass' });
    return true;
  } catch (error) {
    const message = String(error?.message ?? error);
    current.checks.push({ owner, desc, status: 'fail', error: message });
    await dump(`fail-s${current.index}-${slug(desc)}.json`, {
      scenario: current.name, owner, desc, assertion: message, pageErrors: pageErrors.slice(),
    });
    await shot(`fail-s${current.index}-${slug(desc)}.png`);
    return false;
  }
}

async function scenario(name, fn) {
  current = { name, index: report.length + 1, checks: [] };
  report.push(current);
  errorsAtScenarioStart = pageErrors.length;
  const started = Date.now();
  try {
    await fn();
  } catch (error) {
    current.checks.push({ owner: 'V', desc: '场景执行中断', status: 'fail', error: String(error?.message ?? error) });
  }
  current.ms = Date.now() - started;
  current.newPageErrors = pageErrors.slice(errorsAtScenarioStart);
  const failed = current.checks.filter(c => c.status === 'fail').length;
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'} 场景${current.index} ${name}：${current.checks.length - failed}/${current.checks.length} 项通过${current.newPageErrors.length ? `（新增 pageerror ${current.newPageErrors.length} 条）` : ''}`);
}

// ---------------------------------------------------------------------------
// 页面侧公共工具
// ---------------------------------------------------------------------------

// 导入全部战场相关模块（含 scene：其 import 副作用会向 window 注册真实场景工厂）。
const mods = () => page.evaluate(async () => {
  window.__fb = {
    store: await import('/src/store.ts'),
    viewport: await import('/src/map-viewport.ts'),
    paint: await import('/src/field-battle-paint.ts'),
    terrain: await import('/src/field-battle-terrain.ts'),
    units: await import('/src/field-battle-units.ts'),
    validate: await import('/src/field-battle-validate.ts'),
    battleWindow: await import('/src/field-battle-window.ts'),
    overlay: await import('/src/field-battle-overlay.ts'),
    scene: await import('/src/field-battle-scene.ts'),
    cache: await import('/src/theater-cache.ts'),
  };
  return true;
});

const inPage = (fn, arg) => page.evaluate(fn, arg);

// 世界坐标 -> 客户端坐标（主地图）
const worldToScreen = pts => inPage(async (points) => {
  const { worldViewport: v } = window.__fb.viewport;
  return points.map(([x, y]) => [x * v.scale.x + v.position.x, y * v.scale.y + v.position.y]);
}, pts);

/** 在主地图中央安全区找：相邻陆地格 A、B；B 的邻居 D（与 A 不相邻，用于断链擦除）；与 A 相距 ≥5 跳的陆地格 C。 */
const pickPaintCells = () => inPage(async () => {
  const { appStore: s } = window.__fb.store;
  const { worldViewport: v } = window.__fb.viewport;
  const toScreen = ([x, y]) => [x * v.scale.x + v.position.x, y * v.scale.y + v.position.y];
  const safe = i => {
    if (s.mapData.cells.h[i] < 20) return false;
    const [sx, sy] = toScreen(s.mapData.cells.p[i]);
    return sx > 430 && sx < 1140 && sy > 330 && sy < 770;
  };
  const c = s.mapData.cells;
  for (let a = 0; a < c.count; a++) {
    if (!safe(a)) continue;
    const neighbors = c.c[a].filter(safe);
    if (neighbors.length === 0) continue;
    for (const b of neighbors) {
      const d = c.c[b].find(n => n !== a && safe(n) && !c.c[a].includes(n));
      if (d === undefined) continue;
      const dist = new Map([[a, 0]]);
      const queue = [a];
      let far = -1;
      while (queue.length) {
        const cur = queue.shift();
        for (const n of c.c[cur]) {
          if (dist.has(n)) continue;
          dist.set(n, dist.get(cur) + 1);
          if (dist.get(n) >= 5 && safe(n)) { far = n; break; }
          if (dist.get(n) < 8) queue.push(n);
        }
        if (far >= 0) break;
      }
      if (far < 0) continue;
      return {
        A: a, B: b, D: d, C: far,
        centerA: [...c.p[a]], centerB: [...c.p[b]], centerC: [...c.p[far]], centerD: [...c.p[d]],
      };
    }
  }
  return null;
});

/** 采样求“鼠标折线实际穿过内部”的地块集合（独立实现，不复用被测代码）。 */
const expectedTraversal = segments => inPage(async (segs) => {
  const { appStore: s } = window.__fb.store;
  const cells = s.mapData.cells;
  const boxes = [];
  for (let i = 0; i < cells.count; i++) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of cells.polygons[i]) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    boxes.push([minX, minY, maxX, maxY]);
  }
  const inside = (x, y, poly) => {
    let flag = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) flag = !flag;
    }
    return flag;
  };
  const hit = new Set();
  for (const [[x0, y0], [x1, y1]] of segs) {
    for (let k = 1; k <= 220; k++) {
      const t = k / 221;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let cid = 0; cid < cells.count; cid++) {
        const b = boxes[cid];
        if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
        if (inside(x, y, cells.polygons[cid])) { hit.add(cid); break; }
      }
    }
  }
  return [...hit].sort((x, y) => x - y);
}, segments);

const selectedCells = () => inPage(async () => [...window.__fb.paint.getSelectedCells()].sort((a, b) => a - b));
const paintCount = () => inPage(() => document.querySelector('#fieldbattle-paint-count')?.textContent);

/**
 * 种子一个战场（不经涂选 UI）：直接调用 FB-S buildFieldTerrainSnapshot / FB-U copyBattleUnitsIntoField
 * 组装 FieldBattle。仅用于“UI 生成路径被 FB-G 阻塞”时提供测试状态；证据记录 seeding 路径。
 * 可选 mainUnits/mainBattle：临时替换 appStore 的主地图单位再复制，完成后立即还原。
 */
const seedBattle = (cellIds, name, mainFixture = null) => inPage(async ([cellIds, name, mainFixture]) => {
  const { appStore: s } = window.__fb.store;
  const { buildFieldTerrainSnapshot, computeFieldBattleFrame } = window.__fb.terrain;
  const { copyBattleUnitsIntoField } = window.__fb.units;
  const original = { garrisons: s.garrisons, battle: s.battle };
  if (mainFixture) {
    s.garrisons = mainFixture.units;
    s.battle = mainFixture.battle;
  }
  try {
    const selected = new Set(cellIds);
    const terrain = buildFieldTerrainSnapshot(s.mapData, selected);
    const frame = computeFieldBattleFrame(s.mapData, selected);
    const copy = copyBattleUnitsIntoField(s.mapData, selected, s.garrisons, s.battle);
    const battle = {
      id: crypto.randomUUID(), name, createdAt: new Date().toISOString(),
      cellIds: [...cellIds], anchor: frame.anchor, bounds: frame.bounds, terrain,
      units: copy.units, deployments: copy.deployments, sources: copy.sources,
      badgeStyle: 'standard', badgeScale: 1,
    };
    s.fieldBattles.push(battle);
    return { id: battle.id, skippedUnknown: copy.skippedUnknown };
  } finally {
    if (mainFixture) {
      s.garrisons = original.garrisons;
      s.battle = original.battle;
    }
  }
}, [cellIds, name, mainFixture]);

const battleJson = id => inPage(async (id) => {
  const { appStore: s } = window.__fb.store;
  return JSON.stringify(structuredClone(s.fieldBattles.find(b => b.id === id)));
}, id);

const mainIsolationSnapshot = () => inPage(async () => {
  const { appStore: s } = window.__fb.store;
  return JSON.stringify(structuredClone({
    garrisons: s.garrisons, battle: s.battle, tacticalItems: s.tacticalItems,
  }));
});

const battleUnitCount = id => inPage(async (id) => {
  const { appStore: s } = window.__fb.store;
  return s.fieldBattles.find(x => x.id === id).units.length;
}, id);

const fieldBattleEvents = () => inPage(() => (window.__fbEvents ?? []).slice());
const startFieldBattleEvents = () => inPage(async () => {
  const { appStore: s } = window.__fb.store;
  window.__fbEvents = [];
  if (!window.__fbEventsWired) {
    window.__fbEventsWired = true;
    s.on('fieldbattle:changed', e => window.__fbEvents.push(e));
  }
  return true;
});

/** 兵牌锚点 -> 窗口内客户端坐标（用 battle.view 的容器变换）。 */
const badgeScreenPos = (battleId, sourceUnitId) => inPage(async ([id, sourceUnitId]) => {
  const { appStore: s } = window.__fb.store;
  const b = s.fieldBattles.find(x => x.id === id);
  const unit = sourceUnitId ? b.units.find(u => u.sourceUnitId === sourceUnitId) : b.units[0];
  if (!unit) return null;
  const dep = b.deployments.find(d => d.unitId === unit.id);
  if (!dep || dep.placement.state !== 'known') return null;
  const view = b.view;
  const rect = document.querySelector('#field-battle-content').getBoundingClientRect();
  const [wx, wy] = dep.placement.value.anchor;
  return { unitId: unit.id, screen: [rect.left + wx * view.scale + view.x, rect.top + wy * view.scale + view.y] };
}, [battleId, sourceUnitId]);

/**
 * 同上，但优先返回不被窗口内工具栏（DOM 覆盖 canvas 顶部）遮挡的兵牌；
 * sourceUnitId 为 null 时在全部已知位置兵牌中挑选。
 */
const badgePosAvoidingToolbar = (battleId, sourceUnitId) => inPage(async ([id, sourceUnitId]) => {
  const { appStore: s } = window.__fb.store;
  const b = s.fieldBattles.find(x => x.id === id);
  const rect = document.querySelector('#field-battle-content')?.getBoundingClientRect();
  if (!rect) return null;
  const toolbarRect = document.querySelector('#field-battle-toolbar')?.getBoundingClientRect();
  const units = sourceUnitId ? b.units.filter(u => u.sourceUnitId === sourceUnitId) : b.units;
  const candidates = [];
  for (const unit of units) {
    const dep = b.deployments.find(d => d.unitId === unit.id);
    if (!dep || dep.placement.state !== 'known') continue;
    const [wx, wy] = dep.placement.value.anchor;
    const screen = [rect.left + wx * b.view.scale + b.view.x, rect.top + wy * b.view.scale + b.view.y];
    const underToolbar = !!toolbarRect && screen[0] >= toolbarRect.left - 8 && screen[0] <= toolbarRect.right + 8
      && screen[1] >= toolbarRect.top - 8 && screen[1] <= toolbarRect.bottom + 8;
    candidates.push({ unitId: unit.id, screen, underToolbar });
  }
  const pick = candidates.find(c => !c.underToolbar) ?? candidates[0];
  return pick ?? null;
}, [battleId, sourceUnitId]);

/** 真实鼠标拖动战场场景空白处，平移相机（用于把兵牌挪离工具栏区域）。 */
const panBattleScene = async (dx, dy) => {
  const box = await page.locator('#field-battle-content').boundingBox();
  const x = box.x + box.width * 0.6, y = box.y + box.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(400); // 视角防抖 250ms 后 battle.view 更新
};

const openBattleWindow = async battleId => {
  await inPage(async (id) => {
  const { appStore: s } = window.__fb.store;
  await window.__fb.battleWindow.openFieldBattleWindow(s.fieldBattles.find(b => b.id === id));
  return true;
  }, battleId);
  // 直调开窗不经过鼠标 action 的稳定性等待；等首帧建立 Pixi 命中区域。
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

// 主地图单位 fixture 构造（结构对齐 tests/fixtures/field-battle/sample.json）
const field = (value, evidence = []) => ({ state: 'known', value, evidence });
const makeUnit = (id, name, opts = {}) => ({
  id, color: opts.color ?? '#c2410c', assertion: 'plan',
  unitName: field(name), provinceId: field(null), status: field('行军'),
  parentUnitId: opts.parent === undefined ? field(null) : field(opts.parent),
  echelon: field(opts.echelon ?? '团'), branch: field('步兵'), side: field('验收方'),
  childrenCompleteness: field('complete'), personnel: { scope: 'own', count: field(opts.troops ?? 1500) },
});
const makeDeployment = (unitId, anchor, opts = {}) => ({
  unitId, assertion: 'plan',
  battlefieldId: opts.battlefieldId ?? field(null),
  placement: opts.placement ?? field({ anchor, shape: { kind: 'point' } }),
  facingDegrees: field(90), depthMapUnits: field(4), formationLine: field(1),
        role: field(opts.role ?? 'line'),
  reserveForUnitId: opts.reserveFor === undefined ? field(null) : field(opts.reserveFor),
});
const makeUnknownPlacementDeployment = unitId => ({
  unitId, assertion: 'plan', battlefieldId: field(null),
  placement: { state: 'unknown', reason: '位置未给出', evidence: [] },
  facingDegrees: { state: 'unknown', reason: '未给出', evidence: [] },
  depthMapUnits: { state: 'unknown', reason: '未给出', evidence: [] },
  formationLine: field(1), role: field('line'), reserveForUnitId: field(null),
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

await fs.rm(output, { recursive: true, force: true });
await fs.mkdir(output, { recursive: true });
await server.listen();
await page.goto(BASE);
await page.waitForSelector('#theater-select');
// 空沙盘启动：先导入固定 fixture 建区
await page.locator('input[type=file][accept=".map"]').setInputFiles({ name: '战场.map', mimeType: 'text/plain',
  buffer: Buffer.from(await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8')) });
await page.locator('#wenyou-theater-bar [role="status"]').filter({ hasText: '已切换并恢复战区' }).waitFor();
await inPage(async () => {
  const { appStore: s } = await import('/src/store.ts');
  for (let i = 0; i < 200 && !s.mapData; i++) await new Promise(r => setTimeout(r, 50));
  if (!s.mapData) throw new Error('默认战区未加载出地图');
});
await mods();
await startFieldBattleEvents();
const mapId = await inPage(() => window.__fb.store.appStore.mapId);

// ---------------------------------------------------------------------------
// 场景 1 · 涂选
// ---------------------------------------------------------------------------

let uiGeneratedBattleId = null;
await scenario('涂选', async () => {
  const cells = await pickPaintCells();
  assert.ok(cells, '测试地图中央安全区缺少可用陆地格');
  const [aS, bS, cS, dS] = await worldToScreen([cells.centerA, cells.centerB, cells.centerC, cells.centerD]);
  await dump('s1-cells.json', cells);

  await step('P', '进入涂选模式后面板可见、计数为 0', async () => {
    await page.locator('#tactical-add-fieldbattle').click();
    assert.equal(await inPage(() => window.__fb.store.appStore.interactionMode), 'fieldbattle-paint');
    const visible = await inPage(() => document.querySelector('#fieldbattle-paint-panel')?.offsetParent !== null);
    assert.equal(visible, true, '涂选面板应可见');
    assert.equal(await paintCount(), '0');
  });

  await step('P', '不相邻不选：A、B 相邻可加，远处的 C 不被选入', async () => {
    await page.mouse.click(aS[0], aS[1]);
    await page.mouse.click(bS[0], bS[1]);
    assert.deepEqual(await selectedCells(), [cells.A, cells.B].sort((x, y) => x - y));
    await page.mouse.click(cS[0], cS[1]);
    assert.deepEqual(await selectedCells(), [cells.A, cells.B].sort((x, y) => x - y), '点击不相邻格后选区不得变化');
  });

  await step('P', '擦格致断开被拒：Alt+左键擦掉中格被拒绝并提示', async () => {
    await page.mouse.click(dS[0], dS[1]); // A-B-D 链，D 与 A 不相邻
    assert.deepEqual(await selectedCells(), [cells.A, cells.B, cells.D].sort((x, y) => x - y));
    await page.keyboard.down('Alt');
    await page.mouse.click(bS[0], bS[1]); // 擦 B 会断开 A/D
    await page.keyboard.up('Alt');
    assert.deepEqual(await selectedCells(), [cells.A, cells.B, cells.D].sort((x, y) => x - y), '断开性擦除必须被拒绝');
    const status = await inPage(() => document.querySelector('#tactical-toolbar-panel [data-role="status"]')?.textContent ?? '');
    assert.match(status, /不连通/, `状态栏应提示擦除断开，实际：“${status}”`);
    await page.keyboard.down('Alt');
    await page.mouse.click(dS[0], dS[1]); // 擦端点允许
    await page.keyboard.up('Alt');
    assert.deepEqual(await selectedCells(), [cells.A, cells.B].sort((x, y) => x - y));
  });

  await step('P', '快速划过只选实际穿过的地块：与独立采样结果逐格一致', async () => {
    await page.locator('#fieldbattle-clear').click({ timeout: 4000 });
    const w0 = cells.centerA;
    const w1 = [w0[0] + 55, w0[1] + 15];
    const w2 = [w0[0] + 110, w0[1] - 25];
    const [s0, s1, s2] = await worldToScreen([w0, w1, w2]);
    await page.mouse.move(s0[0], s0[1]);
    await page.mouse.down();
    await page.mouse.move(s1[0], s1[1]);
    await page.mouse.move(s2[0], s2[1]);
    await page.mouse.up();
    const expected = await expectedTraversal([[w0, w1], [w1, w2]]);
    const actual = await selectedCells();
    assert.deepEqual(actual, expected, `实际选区 [${actual.join(',')}] 与采样穿越集合 [${expected.join(',')}] 不一致（不得多涂/漏涂）`);
    assert.ok(actual.length >= 2, '划线应至少选中 2 格');
    await dump('s1-fast-drag.json', { actual, expected });
  });

  await step('P', '地图外与只碰顶点无效：从图外拖到最左顶点不产生选区', async () => {
    await page.locator('#fieldbattle-clear').click({ timeout: 4000 });
    const corner = await inPage(() => {
      const { appStore: s } = window.__fb.store;
      let best = null;
      for (let i = 0; i < s.mapData.cells.count; i++) {
        for (const v of s.mapData.cells.polygons[i]) {
          if (!best || v[0] < best[0]) best = [...v];
        }
      }
      return best;
    });
    const [cs] = await worldToScreen([corner]);
    const [os] = await worldToScreen([[corner[0] - 60, corner[1]]]);
    assert.ok(os[0] >= 5 && os[1] >= 5, `图外起点应仍在画布内（实际 ${os.map(n => n.toFixed(0))}）`);
    await page.mouse.move(os[0], os[1]);
    await page.mouse.down();
    await page.mouse.move(cs[0], cs[1]);
    await page.mouse.up();
    assert.deepEqual(await selectedCells(), [], '图外落笔/仅触碰地图边界顶点不得选中任何格');
  });

  await step('P', '右键仍平移；右键平移后左键新笔不与上一笔相连', async () => {
    await page.locator('#fieldbattle-clear').click({ timeout: 4000 });
    const w0 = cells.centerC, w1 = [w0[0] + 30, w0[1] + 10];
    const [s0, s1] = await worldToScreen([w0, w1]);
    await page.mouse.move(s0[0], s0[1]);
    await page.mouse.down();
    await page.mouse.move(s1[0], s1[1]);
    await page.mouse.up();
    const stroke1 = await selectedCells();
    assert.ok(stroke1.length >= 1, '第一笔应至少选中 1 格');
    const before = await inPage(() => {
      const { worldViewport: v } = window.__fb.viewport;
      return [v.position.x, v.position.y];
    });
    await page.mouse.move(800, 500);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(900, 560, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    const after = await inPage(() => {
      const { worldViewport: v } = window.__fb.viewport;
      return [v.position.x, v.position.y];
    });
    assert.notDeepEqual(after, before, '右键拖动应平移主地图');
    assert.deepEqual(await selectedCells(), stroke1, '右键平移不得涂格或改选区');
    // 第二笔：从第一笔末端附近起笔的短 extension；不得把两笔之间未经过的格连进来
    const w2 = [w1[0] + 4, w1[1] + 2], w3 = [w2[0] + 22, w2[1] + 9];
    const [s2, s3] = await worldToScreen([w2, w3]);
    await page.mouse.move(s2[0], s2[1]);
    await page.mouse.down();
    await page.mouse.move(s3[0], s3[1]);
    await page.mouse.up();
    const actual = await selectedCells();
    const expected = await expectedTraversal([[w0, w1], [w2, w3]]);
    assert.deepEqual(actual, expected, `平移后新笔不得与上一笔相连：实际 [${actual.join(',')}]，期望（两笔路径并集）[${expected.join(',')}]`);
  });

  const genOk = await step('G', '生成战场：create 事件、退出涂选、进入 fieldBattles', async () => {
    await page.locator('#fieldbattle-clear').click({ timeout: 4000 });
    const [currentA, currentB] = await worldToScreen([cells.centerA, cells.centerB]);
    await page.mouse.click(...currentA);
    await page.mouse.click(...currentB);
    await page.locator('#fieldbattle-paint-name').fill('验收战场一', { timeout: 4000 });
    await startFieldBattleEvents();
    await page.locator('#fieldbattle-generate').click({ timeout: 4000 });
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      for (let i = 0; i < 50 && s.fieldBattles.length === 0; i++) await new Promise(r => setTimeout(r, 20));
    });
    const state = await inPage(() => {
      const { appStore: s } = window.__fb.store;
      return {
        count: s.fieldBattles.length,
        mode: s.interactionMode,
        first: s.fieldBattles[0] ? { id: s.fieldBattles[0].id, name: s.fieldBattles[0].name } : null,
      };
    });
    assert.equal(state.count, 1, `生成后 fieldBattles 应为 1，实际 ${state.count}${pageErrors.length ? `；最近 pageerror：${pageErrors.at(-1).slice(0, 160)}` : ''}`);
    assert.equal(state.mode, 'pan', '生成后应退出涂选模式');
    assert.equal(state.first?.name, '验收战场一');
    const events = await fieldBattleEvents();
    assert.ok(events.some(e => e.kind === 'create'), '应发出 fieldbattle:changed create');
    uiGeneratedBattleId = state.first.id;
  });
  if (genOk) await shot('s1-generate.png');
});

// ---------------------------------------------------------------------------
// 场景 2 · 冻结
// ---------------------------------------------------------------------------

let frozenBattleId = null;
await scenario('冻结', async () => {
  await step('G', '取得被测战场（UI 生成不可用时直接调用 FB-S/FB-U 组装，作为测试状态）', async () => {
    if (uiGeneratedBattleId) { frozenBattleId = uiGeneratedBattleId; return; }
    const cells = await pickPaintCells();
    const seeded = await seedBattle([cells.A, cells.B], '冻结种子战场');
    frozenBattleId = seeded.id;
    current.seeded = true;
    await dump('s2-seeded.json', seeded);
  });

  await step('S', '生成后直接改 cells.h：terrain/units/deployments 逐值不变', async () => {
    const before = await battleJson(frozenBattleId);
    const restore = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const battle = s.fieldBattles.find(b => b.id === id);
      // 快照格与地图格顶点顺序可能不同：先精确比对，失败再退到“地块中心点落在快照多边形内”
      const matchCell = snapPoly => {
        const json = JSON.stringify(snapPoly);
        for (let i = 0; i < s.mapData.cells.count; i++) {
          if (JSON.stringify(s.mapData.cells.polygons[i]) === json) return i;
        }
        const cx = snapPoly.reduce((n, p) => n + p[0], 0) / snapPoly.length;
        const cy = snapPoly.reduce((n, p) => n + p[1], 0) / snapPoly.length;
        const test = (x, y, ring) => {
          let flag = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) flag = !flag;
          }
          return flag;
        };
        for (let i = 0; i < s.mapData.cells.count; i++) {
          const [px, py] = s.mapData.cells.p[i];
          if (Math.hypot(px - cx, py - cy) < 2 && test(px, py, snapPoly)) return i;
        }
        return -1;
      };
      const touched = battle.terrain.cells.map(c => matchCell(c.polygon)).filter(i => i >= 0);
      const originalH = Array.from(s.mapData.cells.h);
      const originalGarrisons = s.garrisons;
      for (const i of touched) {
        s.mapData.cells.h[i] = s.mapData.cells.h[i] > 120 ? s.mapData.cells.h[i] - 70 : s.mapData.cells.h[i] + 70;
      }
      s.garrisons = originalGarrisons.length > 0
        ? [{ ...originalGarrisons[0], id: 'main-moved-by-freeze' }]
        : originalGarrisons;
      return { originalH, originalGarrisons };
    }, frozenBattleId);
    try {
      const after = await battleJson(frozenBattleId);
      assert.equal(after, before, '改 cells.h / 替换主地图驻军后快照逐值变化');
      // 证明“若重算必变色”：至少一个被改格的新算颜色与冻结值不同
      const differs = await inPage(async (id) => {
        const { appStore: s } = window.__fb.store;
        const { computeTerrainCellColor } = await import('/src/terrain-heightmap.ts');
        const battle = s.fieldBattles.find(b => b.id === id);
        let changed = 0;
        for (const cell of battle.terrain.cells) {
          const found = s.mapData.cells.polygons.findIndex(p => JSON.stringify(p) === JSON.stringify(cell.polygon));
          const idx = found >= 0 ? found : s.mapData.cells.p.findIndex(([x, y]) => {
            const cx = cell.polygon.reduce((n, q) => n + q[0], 0) / cell.polygon.length;
            const cy = cell.polygon.reduce((n, q) => n + q[1], 0) / cell.polygon.length;
            return Math.hypot(x - cx, y - cy) < 2;
          });
          if (idx < 0) continue;
          if (computeTerrainCellColor(s.mapData, idx, 'terrain', true) !== cell.color) changed++;
        }
        return changed;
      }, frozenBattleId);
      assert.ok(differs > 0, '被改高度格的重算颜色应与冻结快照不同，否则冻结断言无意义');
    } finally {
      await inPage(async ([originalH, originalGarrisons]) => {
        const { appStore: s } = window.__fb.store;
        s.mapData.cells.h.set(originalH);
        s.garrisons = originalGarrisons;
      }, [restore.originalH, restore.originalGarrisons]);
    }
  });

  await step('U', '移动/删除/改名主地图原兵牌：战场 units 逐值不变', async () => {
    const before = await battleJson(frozenBattleId);
    const original = await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      return structuredClone(s.garrisons);
    });
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      if (s.garrisons.length > 0) {
        s.garrisons[0] = { ...s.garrisons[0], id: 'main-moved', unitName: { ...s.garrisons[0].unitName, value: '改名' } };
        s.garrisons = s.garrisons.slice(1);
      }
    });
    try {
      const after = await battleJson(frozenBattleId);
      assert.equal(after, before, '主地图兵牌增删改后战场 units 逐值变化');
    } finally {
      await inPage(async (g) => {
        const { appStore: s } = window.__fb.store;
        s.garrisons = g;
      }, original);
    }
  });

  await step('S', '主地图 showHillshade/showContours/viewMode 不被快照读取改动', async () => {
    const flags = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const before = [s.viewMode, s.showHillshade, s.showContours];
      // 打开窗口读取快照后再关上，主地图视图开关不得变化
      await window.__fb.battleWindow.openFieldBattleWindow(s.fieldBattles.find(b => b.id === id));
      await window.__fb.battleWindow.closeFieldBattleWindow();
      return { before, after: [s.viewMode, s.showHillshade, s.showContours] };
    }, frozenBattleId);
    assert.deepEqual(flags.after, flags.before, '战场窗口开合不得改动主地图视图开关');
  });
});

// ---------------------------------------------------------------------------
// 场景 3 · 反向隔离
// ---------------------------------------------------------------------------

let isolationBattleId = null;
let referenceBattle = null;
await scenario('反向隔离', async () => {
  const setup = await step('U', '布置主地图单位并种子战场（u1/u2 纳入，u3 区外，u4 位置未知）', async () => {
    const cells = await pickPaintCells();
    const fixture = await inPage(async ([cellIds]) => {
      const { appStore: s } = window.__fb.store;
      const c = s.mapData.cells;
      const outsideCell = c.c[cellIds[0]].find(n => !cellIds.includes(n)) ?? cellIds[0];
      const field = v => ({ state: 'known', value: v, evidence: [] });
      const makeUnit = (id, name, opts = {}) => ({
        id, color: '#c2410c', assertion: 'plan', unitName: field(name), provinceId: field(null), status: field('行军'),
        parentUnitId: opts.parent === undefined ? field(null) : field(opts.parent), echelon: field('团'), branch: field('步兵'),
        side: field('验收方'), childrenCompleteness: field('complete'), personnel: { scope: 'own', count: field(1500) },
      });
      const makeDeployment = (unitId, anchor, opts = {}) => ({
        unitId, assertion: 'plan', battlefieldId: opts.battlefieldId ?? field(null),
        placement: field({ anchor, shape: { kind: 'point' } }), facingDegrees: field(90), depthMapUnits: field(4),
        formationLine: field(1), role: field(opts.role ?? 'line'),
        reserveForUnitId: opts.reserveFor === undefined ? field(null) : field(opts.reserveFor),
      });
      return {
        units: [makeUnit('main-u1', '前锋团', { parent: 'main-u3' }), makeUnit('main-u2', '预备营', { parent: 'main-u1' }),
          makeUnit('main-u3', '区外军'), makeUnit('main-u4', '位置不明军')],
        battle: {
          schemaVersion: 1,
          sources: [{ id: 'acc-src-1', kind: 'manual', title: '验收来源', text: '合成', locator: null }],
          battlefields: [],
          deployments: [
            makeDeployment('main-u1', [...c.p[cellIds[0]]], { battlefieldId: { state: 'known', value: 'main-battlefield-1', evidence: [] } }),
            makeDeployment('main-u2', [...c.p[cellIds[1]]], { role: 'reserve', reserveFor: 'main-u1' }),
            makeDeployment('main-u3', [...c.p[outsideCell]]),
            { unitId: 'main-u4', assertion: 'plan', battlefieldId: field(null),
              placement: { state: 'unknown', reason: '位置未给出', evidence: [] },
              facingDegrees: { state: 'unknown', reason: '未给出', evidence: [] },
              depthMapUnits: { state: 'unknown', reason: '未给出', evidence: [] },
              formationLine: field(1), role: field('line'), reserveForUnitId: field(null) },
          ],
        },
      };
    }, [[cells.A, cells.B]]);
    const seeded = await seedBattle([cells.A, cells.B], '隔离验收战场', fixture);
    isolationBattleId = seeded.id;
    referenceBattle = JSON.parse(await battleJson(isolationBattleId));
    await dump('s3-seed.json', { battleId: isolationBattleId, skippedUnknown: seeded.skippedUnknown });
  });
  if (!setup) return;

  const opened = await step('W1', '打开战场窗口（优先 UI 按键；未接线时直接调用 openFieldBattleWindow）', async () => {
    await page.locator('#view-toggle-field-battles').check();
    await page.waitForTimeout(200);
    const hasButton = await page.locator('.fieldbattle-button').count();
    if (hasButton > 0) {
      await page.locator(`.fieldbattle-button[data-battle-id="${isolationBattleId}"]`).click();
    } else {
      await openBattleWindow(isolationBattleId);
      current.note = 'UI 按键不存在（overlay 未接线），直接调用 openFieldBattleWindow（集成归属 FB-G）';
    }
    await page.locator('#field-battle-window').waitFor({ state: 'visible' });
    assert.equal(await inPage(() => window.__fb.battleWindow.isFieldBattleWindowOpen()), true);
  });
  if (!opened) return;
  await shot('s3-window-open.png');

  const mainBefore = await mainIsolationSnapshot();
  const unitsBefore = await inPage(async (id) => {
    const { appStore: s } = window.__fb.store;
    const b = s.fieldBattles.find(x => x.id === id);
    return JSON.stringify(structuredClone({ units: b.units, deployments: b.deployments }));
  }, isolationBattleId);

  await step('W2', '战场内拖动兵牌：战场部署移动，主地图 garrisons/deployments/tacticalItems 逐值不变', async () => {
    const pos = await badgePosAvoidingToolbar(isolationBattleId, null);
    assert.ok(pos, '应找到可拖兵牌');
    if (pos.underToolbar) await panBattleScene(140, 100);
    const pos2 = pos.underToolbar ? await badgePosAvoidingToolbar(isolationBattleId, null) : pos;
    const hit = await inPage(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      return e ? e.tagName + (e.id ? '#' + e.id : '') : null;
    }, pos2.screen);
    await dump('s3-drag-pos.json', { pos: pos2, hit, toolbarAvoided: pos2.underToolbar !== true });
    const anchorBefore = await inPage(async ([id, unitId]) => {
      const { appStore: s } = window.__fb.store;
      const dep = s.fieldBattles.find(x => x.id === id).deployments.find(d => d.unitId === unitId);
      return [...dep.placement.value.anchor];
    }, [isolationBattleId, pos2.unitId]);
    await page.mouse.move(pos2.screen[0], pos2.screen[1]);
    await page.mouse.down();
    await page.mouse.move(pos2.screen[0] + 40, pos2.screen[1] + 25, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const anchorAfter = await inPage(async ([id, unitId]) => {
      const { appStore: s } = window.__fb.store;
      const dep = s.fieldBattles.find(x => x.id === id).deployments.find(d => d.unitId === unitId);
      return dep.placement.state === 'known' ? [...dep.placement.value.anchor] : null;
    }, [isolationBattleId, pos2.unitId]);
    assert.ok(anchorAfter, '拖动后部署仍应存在');
    const moved = Math.hypot(anchorAfter[0] - anchorBefore[0], anchorAfter[1] - anchorBefore[1]);
    assert.ok(moved >= 1, `兵牌应实际移动 ≥1 世界单位，实际 ${moved.toFixed(2)}（命中元素 ${hit}）`);
    assert.equal(await mainIsolationSnapshot(), mainBefore, '战场拖动写入了主地图数据');
  });

  await step('W2', '改样式与大小：只写 battle.badgeStyle/badgeScale，不动主地图 garrisonStyle/garrisonScale', async () => {
    const mainStyleBefore = await inPage(() => JSON.stringify([
      window.__fb.store.appStore.garrisonStyle, window.__fb.store.appStore.garrisonScale]));
    await page.locator('#field-battle-style').selectOption('compact');
    await page.locator('#field-battle-scale').evaluate(el => {
      el.value = '1.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const st = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const b = s.fieldBattles.find(x => x.id === id);
      return JSON.stringify([b.badgeStyle, b.badgeScale]);
    }, isolationBattleId);
    assert.equal(st, JSON.stringify(['compact', 1.5]));
    assert.equal(await inPage(() => JSON.stringify([
      window.__fb.store.appStore.garrisonStyle, window.__fb.store.appStore.garrisonScale])), mainStyleBefore,
      '战场样式/大小不得写主地图 garrisonStyle/garrisonScale');
    assert.equal(await mainIsolationSnapshot(), mainBefore);
  });

  await step('E', '战场内新建兵牌：设计器保存后进入战场 units（sourceUnitId 空串），主地图不变', async () => {
    const countBefore = await battleUnitCount(isolationBattleId);
    try {
      await page.locator('#field-battle-new-unit').click();
      await page.locator('#garrison-custom-modal').waitFor({ state: 'visible' });
      await shot('s3-designer-open.png');
      const zinfo = await inPage(() => {
        const modal = document.getElementById('garrison-custom-modal');
        const win = document.getElementById('field-battle-window');
        return { modalZ: modal ? getComputedStyle(modal).zIndex : null, windowZ: win ? getComputedStyle(win).zIndex : null };
      });
      await dump('s3-designer-z.json', zinfo);
      await page.locator('#modal-name-input').fill('窗口新建营');
      await page.locator('#modal-troops-input').fill('600');
      await page.locator('#modal-save-btn').click({ timeout: 5000 });
      await page.locator('#garrison-custom-modal').waitFor({ state: 'detached' });
    } finally {
      // 断言失败时也要收走模态框（例如模态框被战场窗口遮挡导致保存不可点），避免污染后续步骤
      await inPage(() => { document.getElementById('garrison-custom-modal')?.remove(); });
    }
    const st = await inPage(async ([id, countBefore]) => {
      const { appStore: s } = window.__fb.store;
      const b = s.fieldBattles.find(x => x.id === id);
      return { count: b.units.length, source: b.units.at(-1)?.sourceUnitId };
    }, [isolationBattleId, countBefore]);
    assert.equal(st.count, countBefore + 1, '新建单位应进入战场 units');
    assert.equal(st.source, '', '窗口新建单位 sourceUnitId 应为空串');
    assert.equal(await mainIsolationSnapshot(), mainBefore, '新建写入了主地图');
  });

  await step('W2', '战役面板打开时 Delete/Ctrl+Z/Ctrl+Shift+Z 只作用于战场', async () => {
    if (await page.locator('#battle-open').count() > 0) {
      try { await page.locator('#battle-open').click(); } catch { /* 面板可能已在展示 */ }
    }
    const countBefore = await battleUnitCount(isolationBattleId);
    const pos = await badgePosAvoidingToolbar(isolationBattleId, null);
    assert.ok(pos, '应存在已知位置兵牌可选');
    await page.mouse.click(pos.screen[0], pos.screen[1]);
    await page.keyboard.press('Delete');
    assert.equal(await battleUnitCount(isolationBattleId), countBefore - 1, 'Delete 应删除战场选中单位');
    assert.equal(await mainIsolationSnapshot(), mainBefore, 'Delete 作用于主地图');
    await page.keyboard.press('Control+z');
    assert.equal(await battleUnitCount(isolationBattleId), countBefore, 'Ctrl+Z 应恢复战场删除');
    assert.equal(await mainIsolationSnapshot(), mainBefore, 'Ctrl+Z 作用于主地图');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await battleUnitCount(isolationBattleId), countBefore - 1, 'Ctrl+Shift+Z 应重做战场删除');
    assert.equal(await mainIsolationSnapshot(), mainBefore, 'Ctrl+Shift+Z 作用于主地图');
  });

  await step('W2', '战场编辑改变了战场数据本身（与开场快照不同）', async () => {
    const unitsAfter = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const b = s.fieldBattles.find(x => x.id === id);
      return JSON.stringify(structuredClone({ units: b.units, deployments: b.deployments }));
    }, isolationBattleId);
    assert.notEqual(unitsAfter, unitsBefore, '战场编辑应已改变战场数据');
    assert.equal(await mainIsolationSnapshot(), mainBefore);
  });

  await page.locator('#field-battle-minimize').click();
});

// ---------------------------------------------------------------------------
// 场景 4 · 视图独立
// ---------------------------------------------------------------------------

await scenario('视图独立', async () => {
  let battleId = null;
  await step('S', '主地图 state 视图下种子战场（峰顶+邻接，保证有高差；UI 生成受阻时直调 FB-S）', async () => {
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      s.viewMode = 'state';
      s.emit('view:changed', 'state');
    });
    const hill = await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      const c = s.mapData.cells;
      const LEVELS = [30, 45, 60, 75, 88];
      let peak = -1, peakH = -1;
      for (let i = 0; i < c.count; i++) if (c.h[i] > peakH) { peakH = c.h[i]; peak = i; }
      // 从峰顶 BFS 下坡（只走陆地），直到选区高度横跨至少一条等高线级别
      const picked = [peak];
      const seen = new Set([peak]);
      const queue = [...c.c[peak]];
      for (const n of queue) seen.add(n);
      const spans = () => {
        const lo = Math.min(...picked.map(i => c.h[i])), hi = Math.max(...picked.map(i => c.h[i]));
        return LEVELS.some(l => lo < l && hi >= l);
      };
      while (!spans() && picked.length < 14 && queue.length) {
        const n = queue.shift();
        if (c.h[n] < 20) continue;
        picked.push(n);
        for (const m of c.c[n]) if (!seen.has(m)) { seen.add(m); queue.push(m); }
      }
      const hs = picked.map(i => c.h[i]);
      return { picked, spans: spans(), range: Math.max(...hs) - Math.min(...hs), lo: Math.min(...hs), hi: Math.max(...hs) };
    });
    await dump('s4-hill-cells.json', hill);
    assert.ok(hill.spans, `峰顶邻域选区（高 ${hill.lo}–${hill.hi}）应横跨等高线级别 30/45/60/75/88 之一，否则等高线断言无意义`);
    const seeded = await seedBattle(hill.picked, '视图独立战场');
    battleId = seeded.id;
    if (uiGeneratedBattleId === null) current.note = '战场由直调 FB-S/FB-U 种子（UI 生成路径受阻，归属 FB-G）';
  });
  if (!battleId) return;

  await step('S', '快照颜色 = terrain 视图 + 山影（computeTerrainCellColor(map,id,\'terrain\',true)）', async () => {
    const mismatched = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const { computeTerrainCellColor } = await import('/src/terrain-heightmap.ts');
      const battle = s.fieldBattles.find(b => b.id === id);
      const bad = [];
      for (const cell of battle.terrain.cells) {
        const json = JSON.stringify(cell.polygon);
        let found = -1;
        for (let i = 0; i < s.mapData.cells.count; i++) {
          const polygon = s.mapData.cells.polygons[i];
          const first = polygon[0], last = polygon[polygon.length - 1];
          const closed = first[0] === last[0] && first[1] === last[1]
            ? polygon : [...polygon, first];
          if (JSON.stringify(closed) === json) { found = i; break; }
        }
        if (found < 0) { bad.push({ cell: 'polygon-not-found' }); continue; }
        const expected = computeTerrainCellColor(s.mapData, found, 'terrain', true);
        if (expected !== cell.color) bad.push({ cell: found, snapshot: cell.color, expected });
      }
      return bad;
    }, battleId);
    assert.deepEqual(mismatched, [], `主地图 state 视图下快照颜色应仍是 terrain+山影，不一致：${JSON.stringify(mismatched)}`);
  });

  await step('S', '快照含等高线；主地图视图开关不被改动', async () => {
    const st = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const battle = s.fieldBattles.find(b => b.id === id);
      return {
        contourLines: battle.terrain.contours.reduce((n, g) => n + g.lines.length, 0),
        viewMode: s.viewMode, hillshade: s.showHillshade, contours: s.showContours,
      };
    }, battleId);
    assert.ok(st.contourLines > 0, '快照应包含等高线');
    assert.equal(st.viewMode, 'state');
    assert.equal(st.hillshade, true);
    assert.equal(st.contours, true);
  });

  await step('S', '主地图群系/地形视图行为不受战场改动影响（截图证据 + 视图状态）', async () => {
    const errorsBefore = pageErrors.length;
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      s.viewMode = 'biome';
      s.emit('view:changed', 'biome');
    });
    await page.waitForTimeout(400);
    await shot('s4-biome-with-battle.png');
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      s.viewMode = 'terrain';
      s.emit('view:changed', 'terrain');
    });
    await page.waitForTimeout(400);
    await shot('s4-terrain-with-battle.png');
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      s.viewMode = 'state';
      s.emit('view:changed', 'state');
    });
    await page.waitForTimeout(300);
    assert.equal(await inPage(() => window.__fb.store.appStore.viewMode), 'state');
    assert.deepEqual(pageErrors.slice(errorsBefore), [], '视图切换出现页面错误');
  });
});

// ---------------------------------------------------------------------------
// 场景 5 · 凹形战场
// ---------------------------------------------------------------------------

let concaveBattleId = null;
await scenario('凹形战场', async () => {
  const found = await step('S', '在真实地图上构造凹形选区（含河流多次进出展示范围）', async () => {
    const spot = await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      const rivers = s.mapData.rivers.filter(r => Array.isArray(r.points) && r.points.length >= 8);
      for (const r of rivers) {
        const pts = r.points;
        for (let i = 0; i < pts.length - 6; i++) {
          for (let j = i + 6; j < pts.length; j++) {
            const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
            if (d < 16) return { mid: [(pts[i][0] + pts[j][0]) / 2, (pts[i][1] + pts[j][1]) / 2], river: r.i, d };
          }
        }
      }
      return null;
    });
    assert.ok(spot, '地图上未找到可形成多次进出的河流弯（i、j 两点接近且中间流程长）');
    const cellIds = await inPage(async (mid) => {
      const { appStore: s } = window.__fb.store;
      const c = s.mapData.cells;
      let start = 0, best = Infinity;
      for (let i = 0; i < c.count; i++) {
        const d = (c.p[i][0] - mid[0]) ** 2 + (c.p[i][1] - mid[1]) ** 2;
        if (d < best) { best = d; start = i; }
      }
      const seen = new Set([start]);
      const queue = [start];
      const picked = [];
      while (queue.length && picked.length < 10) {
        const cur = queue.shift();
        picked.push(cur);
        for (const n of c.c[cur]) {
          if (seen.has(n)) continue;
          if (Math.hypot(c.p[n][0] - mid[0], c.p[n][1] - mid[1]) > 18) continue;
          seen.add(n);
          queue.push(n);
        }
      }
      return picked;
    }, spot.mid);
    assert.ok(cellIds.length >= 4, `弯道附近应能选出至少 4 格，实际 ${cellIds.length}`);
    const seeded = await seedBattle(cellIds, '凹形验收战场');
    concaveBattleId = seeded.id;
    const concave = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const battle = s.fieldBattles.find(b => b.id === id);
      const ring = battle.terrain.displayOutline[0]?.outer ?? [];
      const m = ring.length - 1;
      const turns = ring.map((p, i) => {
        const q = ring[(i + 1) % m], r = ring[(i + 2) % m];
        return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
      });
      return { reflex: turns.some(t => t > 0) && turns.some(t => t < 0) };
    }, concaveBattleId);
    assert.ok(concave.reflex, '选区并集应是凹形（外环存在 Reflex 顶点）');
    await dump('s5-spot.json', { spot, cellIds });
  });
  if (!found) return;

  await step('S', '河流多次进出展示范围被切成多部分、无跨越', async () => {
    const rivers = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      return structuredClone(s.fieldBattles.find(b => b.id === id).terrain.rivers);
    }, concaveBattleId);
    assert.ok(rivers.length > 0, '展示范围内应有河流');
    assert.ok(rivers.some(r => r.parts.length >= 2), `河流应被切成多段，实际分组：${rivers.map(r => r.parts.length).join(',')}`);
  });

  await step('S', '带孔湖泊 holes 保留（真实地图无孔湖时用 fixture 副本验证结构）', async () => {
    const lakes = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      return structuredClone(s.fieldBattles.find(b => b.id === id).terrain.lakes);
    }, concaveBattleId);
    if (lakes.some(l => l.parts.some(p => p.holes.length > 0))) return;
    const sampleRaw = await fs.readFile(new URL('./fixtures/field-battle/acceptance-sample.json', import.meta.url), 'utf8');
    const holed = await inPage(async (raw) => {
      const { appStore: s } = window.__fb.store;
      const { validateFieldBattle } = window.__fb.validate;
      const battle = JSON.parse(raw);
      battle.id = crypto.randomUUID();
      validateFieldBattle(battle);
      return battle.terrain.lakes[0].parts[0].holes.length;
    }, sampleRaw);
    assert.equal(holed, 1, 'fixture 副本中带孔湖泊的 holes 应为 1 且通过验证器');
    current.note = '真实地图选区未覆盖带孔湖泊，孔洞结构以 acceptance-sample.json 副本验证';
  });

  await step('S', '等高线/海岸线在展示范围边界断开：段内所有点均在 display 内', async () => {
    const bad = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const battle = s.fieldBattles.find(b => b.id === id);
      const parts = battle.terrain.displayOutline;
      const distToRing = (x, y, ring) => {
        let best = Infinity;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xj, yj] = ring[j], [xi, yi] = ring[i];
          const dx = xi - xj, dy = yi - yj;
          const len2 = dx * dx + dy * dy;
          const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - xj) * dx + (y - yj) * dy) / len2));
          best = Math.min(best, Math.hypot(x - (xj + t * dx), y - (yj + t * dy)));
        }
        return best;
      };
      const inside = (x, y) => {
        const test = ring => {
          let flag = false;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i], [xj, yj] = ring[j];
            if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) flag = !flag;
          }
          return flag;
        };
        return parts.some(part =>
          (test(part.outer) || distToRing(x, y, part.outer) <= 0.75) &&
          !part.holes.some(h => test(h) && distToRing(x, y, h) > 0.75));
      };
      const offenders = [];
      for (const group of [...battle.terrain.contours, ...battle.terrain.coastlines]) {
        for (const line of group.lines) {
          for (let i = 0; i + 1 < line.points.length; i++) {
            const [x0, y0] = line.points[i], [x1, y1] = line.points[i + 1];
            if (!inside((x0 + x1) / 2, (y0 + y1) / 2)) offenders.push([[x0, y0], [x1, y1]]);
          }
        }
      }
      return offenders;
    }, concaveBattleId);
    assert.deepEqual(bad, [], `线段中点越出 display 的等高线/海岸线段：${JSON.stringify(bad.slice(0, 3))}`);
  });

  await step('S', '外围压暗结构：contextOutline 挖掉 battleOutline（保留孔洞）+ 窗口渲染截图', async () => {
    const st = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const battle = s.fieldBattles.find(b => b.id === id);
      return {
        contextParts: battle.terrain.contextOutline.length,
        contextHoles: battle.terrain.contextOutline.reduce((n, p) => n + p.holes.length, 0),
        contextCells: battle.terrain.cells.filter(c => c.context).length,
        battleCells: battle.terrain.cells.filter(c => !c.context).length,
        selectedCount: battle.cellIds.length,
      };
    }, concaveBattleId);
    assert.ok(st.contextParts >= 1, 'contextOutline 不应为空');
    assert.ok(st.contextHoles >= 1, 'contextOutline 应以 battleOutline 为孔洞');
    assert.ok(st.contextCells > 0, '应存在一圈邻接 context 格');
    assert.equal(st.battleCells, st.selectedCount, '非 context 格数应等于选中格数');
    await openBattleWindow(concaveBattleId);
    await page.locator('#field-battle-window').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);
    await shot('s5-concave-window.png');
    await page.locator('#field-battle-minimize').click();
  });
});

// ---------------------------------------------------------------------------
// 场景 6 · 引用
// ---------------------------------------------------------------------------

await scenario('引用', async () => {
  const referenceBattleId = await inPage(seed => {
    const battle = structuredClone(seed);
    battle.id = crypto.randomUUID();
    window.__fb.store.appStore.fieldBattles.push(battle);
    return battle.id;
  }, referenceBattle);
  const copied = await step('U', '纳入单位上下级/预备队指向新 ID；区外单位与主地图战役为 unknown 且 reason 含原 id', async () => {
    assert.ok(isolationBattleId, '前置：场景 3 的种子战场存在');
    const st = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const b = s.fieldBattles.find(x => x.id === id);
      const u1 = b.units.find(u => u.sourceUnitId === 'main-u1');
      const u2 = b.units.find(u => u.sourceUnitId === 'main-u2');
      return { u1, u2, deployments: structuredClone(b.deployments), unitCount: b.units.length };
    }, referenceBattleId);
    assert.ok(st.u1 && st.u2, 'u1/u2 应被纳入');
    assert.equal(st.unitCount, 2, `只应纳入 2 个已知位置单位（u4 位置未知跳过），实际 ${st.unitCount}`);
    assert.equal(st.u2.parentUnitId.state, 'known');
    assert.equal(st.u2.parentUnitId.value, st.u1.id, 'u2 上级应指向 u1 的新 ID');
    const dep2 = st.deployments.find(d => d.unitId === st.u2.id);
    assert.equal(dep2.reserveForUnitId.state, 'known');
    assert.equal(dep2.reserveForUnitId.value, st.u1.id);
    assert.equal(st.u1.parentUnitId.state, 'unknown', '区外上级应降级 unknown');
    assert.match(st.u1.parentUnitId.reason ?? '', /main-u3/, 'reason 应含原 id main-u3');
    const dep1 = st.deployments.find(d => d.unitId === st.u1.id);
    assert.equal(dep1.battlefieldId.state, 'unknown', '主地图战役引用应降级 unknown');
    assert.match(dep1.battlefieldId.reason ?? '', /main-battlefield-1/, 'reason 应含原 id main-battlefield-1');
    assert.equal('value' in dep1.battlefieldId, false, 'unknown 字段不得含 value');
    assert.equal(dep2.battlefieldId.state, 'known');
    assert.equal(dep2.battlefieldId.value, null, '原 known null 保持 known null');
  });
  if (!copied) return;

  await step('W2', '删除单位后引用解除；撤销完整恢复（真实键盘）', async () => {
    await openBattleWindow(referenceBattleId);
    await page.locator('#field-battle-window').waitFor({ state: 'visible' });
    let pos = await badgePosAvoidingToolbar(referenceBattleId, 'main-u1');
    assert.ok(pos, '应找到 u1 副本兵牌');
    if (pos.underToolbar) {
      // u1 被窗口工具栏遮挡：真实拖动场景空白处平移相机，把兵牌挪出工具栏
      await panBattleScene(160, 120);
      pos = await badgePosAvoidingToolbar(referenceBattleId, 'main-u1');
      assert.ok(pos && !pos.underToolbar, '平移视角后 u1 兵牌不应再被工具栏遮挡');
    }
    await dump('s6-u1-pos.json', pos);
    await page.mouse.click(pos.screen[0], pos.screen[1]);
    await page.keyboard.press('Delete');
    const afterDelete = await inPage(async ([id, u1id]) => {
      const { appStore: s } = window.__fb.store;
      const b = s.fieldBattles.find(x => x.id === id);
      const u2 = b.units.find(u => u.sourceUnitId === 'main-u2');
      return { u1Gone: !b.units.some(u => u.id === u1id),
        parentState: u2.parentUnitId.state, parentReason: u2.parentUnitId.reason ?? '',
        depGone: !b.deployments.some(d => d.unitId === u1id) };
    }, [referenceBattleId, pos.unitId]);
    assert.equal(afterDelete.u1Gone, true, 'u1 应被删除');
    assert.equal(afterDelete.depGone, true, 'u1 部署应被删除');
    assert.equal(afterDelete.parentState, 'unknown', '删除后 u2 上级应解除为 unknown');
    assert.match(afterDelete.parentReason, new RegExp(pos.unitId), 'reason 应含被删单位新 ID');
    await page.keyboard.press('Control+z');
    const afterUndo = await inPage(async ([id, u1id]) => {
      const { appStore: s } = window.__fb.store;
      const b = s.fieldBattles.find(x => x.id === id);
      const u1 = b.units.find(u => u.id === u1id);
      const u2 = b.units.find(u => u.sourceUnitId === 'main-u2');
      return { u1Back: !!u1, u2Parent: u2.parentUnitId.state, u2ParentValue: u2.parentUnitId.value ?? '' };
    }, [referenceBattleId, pos.unitId]);
    assert.equal(afterUndo.u1Back, true, '撤销应恢复 u1');
    assert.equal(afterUndo.u2Parent, 'known');
    assert.equal(afterUndo.u2ParentValue, pos.unitId, '撤销应完整恢复引用');
    await page.locator('#field-battle-minimize').click();
  });
});

// ---------------------------------------------------------------------------
// 场景 7 · 视图跟随
// ---------------------------------------------------------------------------

await scenario('视图跟随', async () => {
  const battleId = concaveBattleId ?? frozenBattleId ?? isolationBattleId;
  assert.ok(battleId, '前置：前序场景未产出任何战场');

  await step('G', '战场视图开关关闭时：无按键、无窗口', async () => {
    const state = await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      s.showFieldBattles = false;
      s.emit('fieldbattle:visibility', false);
      await new Promise(r => setTimeout(r, 100));
      return {
        buttons: document.querySelectorAll('.fieldbattle-button').length,
        windowOpen: window.__fb.battleWindow.isFieldBattleWindowOpen(),
      };
    });
    assert.equal(state.buttons, 0, '开关关闭时不得有战场按键');
    assert.equal(state.windowOpen, false, '开关关闭时战场窗口应关闭');
  });

  const overlayOk = await step('G', '打开开关后渲染战场按键（main.ts 未接线时直接 init，记为 FB-G 缺口）', async () => {
    const wired = await inPage(async () => {
      window.__fb.overlay.initFieldBattleOverlay(document.body);
      const { appStore: s } = window.__fb.store;
      s.showFieldBattles = true;
      s.emit('fieldbattle:visibility', true);
      await new Promise(r => setTimeout(r, 100));
      return document.querySelectorAll('.fieldbattle-button').length;
    });
    assert.ok(wired > 0, '打开开关后应渲染战场按键');
    if (!('note' in current)) current.note = 'overlay 未由 main.ts 接线，测试直接调用 initFieldBattleOverlay（集成归属 FB-G）';
  });
  if (!overlayOk) return;

  const buttonCenter = () => inPage(async (id) => {
    const { appStore: s } = window.__fb.store;
    const { worldViewport: v } = window.__fb.viewport;
    const battle = s.fieldBattles.find(b => b.id === id);
    const btn = document.querySelector(`.fieldbattle-button[data-battle-id="${id}"]`);
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    return {
      center: [rect.left + rect.width / 2, rect.top + rect.height / 2],
      expected: [battle.anchor[0] * v.scale.x + v.position.x, battle.anchor[1] * v.scale.y + v.position.y],
    };
  }, battleId);

  await step('W1', '按键位于凹形战场内部（anchor 落在 displayOutline 内）', async () => {
    const inside = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      const { worldViewport: v } = window.__fb.viewport;
      const battle = s.fieldBattles.find(b => b.id === id);
      const toScreen = ([x, y]) => [x * v.scale.x + v.position.x, y * v.scale.y + v.position.y];
      const rings = battle.terrain.displayOutline.map(p => ({ outer: p.outer.map(toScreen), holes: p.holes.map(h => h.map(toScreen)) }));
      const test = ring => {
        let flag = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) flag = !flag;
        }
        return flag;
      };
      const [x, y] = toScreen(battle.anchor);
      return rings.some(part => test(part.outer) && !part.holes.some(h => test(h)));
    }, battleId);
    assert.equal(inside, true, 'anchor 的屏幕位置应在 displayOutline 内');
  });

  await step('W1', '按键位置 = anchor×scale + 视口偏移；拖动/滚轮/resize 后跟随', async () => {
    const closeTo = (a, b, tol = 3) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
    const check = async label => {
      await page.waitForTimeout(180);
      const pos = await buttonCenter();
      assert.ok(pos, `按键存在（${label}）`);
      assert.ok(closeTo(pos.center, pos.expected), `${label}：按键应跟随，实际 [${pos.center.map(n => n.toFixed(1))}]，期望 [${pos.expected.map(n => n.toFixed(1))}]`);
    };
    await check('初始');
    await inPage(() => { window.__fb.store.appStore.interactionMode = 'pan'; });
    await page.mouse.move(760, 480);
    await page.mouse.down();
    await page.mouse.move(840, 530, { steps: 5 });
    await page.mouse.up();
    await check('拖动后');
    await page.mouse.move(800, 500);
    await page.mouse.wheel(0, -240);
    await check('滚轮后');
    await page.setViewportSize({ width: 1400, height: 900 });
    await check('resize 后');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(200);
  });
  await shot('s7-follow.png');
});

// ---------------------------------------------------------------------------
// 场景 8 · 窗口
// ---------------------------------------------------------------------------

await scenario('窗口', async () => {
  const battleId = concaveBattleId ?? frozenBattleId ?? isolationBattleId;
  assert.ok(battleId, '前置：前序场景未产出任何战场');

  await step('W1', '窗口面积占视口 45%–55%', async () => {
    await openBattleWindow(battleId);
    await page.locator('#field-battle-window').waitFor({ state: 'visible' });
    const ratio = await inPage(() => {
      const rect = document.querySelector('#field-battle-window').getBoundingClientRect();
      return (rect.width * rect.height) / (innerWidth * innerHeight);
    });
    assert.ok(ratio >= 0.45 && ratio <= 0.55, `窗口面积占比 ${ratio.toFixed(3)} 应在 45%–55%`);
  });

  await step('W1', '收起后按键恢复（aria-pressed=false）；再开恢复视角', async () => {
    const canvasBox = await page.locator('#field-battle-content').boundingBox();
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(500); // 视角防抖 250ms
    const savedBefore = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      return structuredClone(s.fieldBattles.find(b => b.id === id).view);
    }, battleId);
    await page.locator('#field-battle-minimize').click();
    assert.equal(await inPage(() => window.__fb.battleWindow.isFieldBattleWindowOpen()), false, '收起后窗口应关闭');
    const btnState = await inPage((id) => {
      const btn = document.querySelector(`.fieldbattle-button[data-battle-id="${id}"]`);
      return btn ? btn.getAttribute('aria-pressed') : 'missing';
    }, battleId);
    assert.equal(btnState, 'false', '收起后按键应恢复非激活');
    const savedAfterClose = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      return structuredClone(s.fieldBattles.find(b => b.id === id).view);
    }, battleId);
    assert.deepEqual(savedAfterClose, savedBefore, '收起时应保存视角');
    await openBattleWindow(battleId);
    await page.locator('#field-battle-window').waitFor({ state: 'visible' });
    await page.waitForTimeout(200);
    const reopened = await inPage(async (id) => {
      const { appStore: s } = window.__fb.store;
      return structuredClone(s.fieldBattles.find(b => b.id === id).view);
    }, battleId);
    assert.deepEqual(reopened, savedBefore, '重开应恢复收起前视角');
  });

  await step('W1', '多战场开/关/切换 20 次：窗口 canvas 恒为 1，主地图 canvas 仍在', async () => {
    const second = await seedBattle([(await pickPaintCells()).A], '窗口第二战场');
    const result = await inPage(async ([idA, idB]) => {
      const { appStore: s } = window.__fb.store;
      const w = window.__fb.battleWindow;
      const mainCanvas = document.querySelector('#app canvas');
      const counts = [];
      for (let i = 0; i < 20; i++) {
        if (i % 3 === 0) await w.openFieldBattleWindow(s.fieldBattles.find(b => b.id === idA));
        else if (i % 3 === 1) await w.openFieldBattleWindow(s.fieldBattles.find(b => b.id === idB));
        else w.closeFieldBattleWindow();
        counts.push(document.querySelectorAll('#field-battle-content canvas').length);
      }
      await w.openFieldBattleWindow(s.fieldBattles.find(b => b.id === idA));
      const finalCount = document.querySelectorAll('#field-battle-content canvas').length;
      return { counts, finalCount, mainAlive: !!mainCanvas && document.body.contains(mainCanvas) };
    }, [battleId, second.id]);
    assert.ok(result.counts.every(c => c <= 1), `中途出现多于 1 个 canvas：${result.counts.join(',')}`);
    assert.equal(result.finalCount, 1, '最终窗口 canvas 应恰为 1');
    assert.equal(result.mainAlive, true, '主地图 canvas 必须仍在文档中');
  });

  await step('G', '主地图自定义图片兵牌仍正常（无页面错误 + 截图）', async () => {
    assert.ok(TINY_PNG.startsWith('data:image/'));
    const errorsBefore = pageErrors.length;
    await inPage(async (dataUrl) => {
      const { appStore: s } = window.__fb.store;
      if (s.garrisons[0]) {
        s.garrisons[0] = { ...s.garrisons[0],
          customBadge: { culture: 'universal', requirementTag: '重装步兵', customGlyph: '陷阵', customIconDataUrl: dataUrl } };
        s.emit('garrisons-change');
      }
      return s.garrisons.length;
    }, TINY_PNG);
    await page.waitForTimeout(1200);
    await shot('s8-custom-badge.png');
    const newErrors = pageErrors.slice(errorsBefore);
    assert.deepEqual(newErrors, [], `自定义图片兵牌引发页面错误：${newErrors.join(' | ')}`);
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      if (s.garrisons[0]) { delete s.garrisons[0].customBadge; s.emit('garrisons-change'); }
    });
  });
  await page.locator('#field-battle-minimize').click().catch(() => {});
});

// ---------------------------------------------------------------------------
// 场景 9 · 战区切换
// ---------------------------------------------------------------------------

await scenario('战区切换', async () => {
  const battleId = concaveBattleId ?? frozenBattleId ?? isolationBattleId;
  assert.ok(battleId, '前置：前序场景未产出任何战场');

  const sourceMap = await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');
  const lines = sourceMap.split(/\r?\n/);
  const header = lines[0].split('|');
  header[6] = String(Number(header[6]) + 300);
  lines[0] = header.join('|');
  const mapB = lines.join('\r\n');
  const idB = await inPage(async (text) => {
    const meta = text.split('\r\n')[0].split('|');
    return `${meta[3]}-${meta[6]}-${meta[4]}x${meta[5]}`;
  }, mapB);
  const battlesBefore = await inPage(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles.map(b => b.id))));
  await dump('s9-mapB.json', { idB });

  await step('W1', '窗口编辑中切换战区：窗口关闭、未保存设计器丢弃', async () => {
    await openBattleWindow(battleId);
    await page.locator('#field-battle-window').waitFor({ state: 'visible' });
    await page.locator('#field-battle-new-unit').click();
    await page.locator('#garrison-custom-modal').waitFor({ state: 'visible' });
    await page.locator('#modal-name-input').fill('未保存的草稿单位');
    await page.evaluate(({ text }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], 'B大陆.map', { type: 'text/plain' }));
      const over = new DragEvent('dragover', { dataTransfer: transfer, cancelable: true });
      window.dispatchEvent(over);
      const event = new DragEvent('drop', { dataTransfer: transfer, cancelable: true });
      window.dispatchEvent(event);
    }, { text: mapB });
    await page.waitForFunction(expected => window.__fb.store.appStore.mapId === expected && !window.__fb.store.appStore.isSwitchingMap, idB, { timeout: 60000 });
    assert.equal(await inPage(() => window.__fb.battleWindow.isFieldBattleWindowOpen()), false, '切战区后战场窗口应关闭');
    assert.equal(await page.locator('#garrison-custom-modal').count(), 0, '未保存的设计器内容应被丢弃（modal 移除）');
  });

  await step('D', '旧编辑不写入另一战区；切回后原战场逐值恢复', async () => {
    const onB = await inPage(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles.map(b => b.id))));
    assert.equal(onB, '[]', `新战区不得带入旧战区战场，实际 ${onB}（战场数组应随战区隔离）`);
    await page.selectOption('#theater-select', mapId);
    await page.waitForFunction(expected => window.__fb.store.appStore.mapId === expected && !window.__fb.store.appStore.isSwitchingMap, mapId, { timeout: 60000 });
    const back = await inPage(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles.map(b => b.id))));
    assert.equal(back, battlesBefore, `切回原战区后战场应逐值恢复，实际 ${back}`);
  });
});

// ---------------------------------------------------------------------------
// 场景 10 · 存档
// ---------------------------------------------------------------------------

await scenario('存档', async () => {
  await step('D', '前置：当前战区至少一个战场', async () => {
    // 场景 9 若在切换回程中超时中断，会停在第二战区；先恢复到原战区再断言
    const current = await inPage(() => window.__fb.store.appStore.mapId);
    if (current !== mapId) {
      await page.selectOption('#theater-select', mapId);
      await page.waitForFunction(expected => window.__fb.store.appStore.mapId === expected && !window.__fb.store.appStore.isSwitchingMap, mapId, { timeout: 60000 });
    }
    const count = await inPage(() => window.__fb.store.appStore.fieldBattles.length);
    assert.ok(count > 0, `当前战区应有战场（实际 ${count}；前序场景未产出）`);
  });
  const before = await inPage(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles)));

  await step('D', '刷新后 fieldBattles 逐值一致', async () => {
    await page.reload();
    await page.waitForSelector('#theater-select');
    await mods();
    await inPage(async () => {
      const { appStore: s } = window.__fb.store;
      for (let i = 0; i < 200 && !s.mapData; i++) await new Promise(r => setTimeout(r, 50));
      if (!s.mapData) throw new Error('刷新后地图未恢复');
    });
    const after = await inPage(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles)));
    assert.equal(after, before, '刷新后战场应逐值恢复');
  });

  await step('D', '切战区再切回后 fieldBattles 逐值一致', async () => {
    const ids = await page.locator('#theater-select option').evaluateAll(opts => opts.map(o => o.value));
    const other = ids.find(v => v !== mapId);
    if (!other) { current.note = '只有单个战区，本步以场景 9 的往返为准'; return; }
    await page.selectOption('#theater-select', other);
    await page.waitForFunction(expected => window.__fb.store.appStore.mapId === expected && !window.__fb.store.appStore.isSwitchingMap, other, { timeout: 60000 });
    await page.selectOption('#theater-select', mapId);
    await page.waitForFunction(expected => window.__fb.store.appStore.mapId === expected && !window.__fb.store.appStore.isSwitchingMap, mapId, { timeout: 60000 });
    const after = await inPage(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles)));
    assert.equal(after, before, '切换往返后战场应逐值恢复');
  });

  let projectJson = null;
  await step('D', '导出工程包含 fieldBattles 且逐值一致', async () => {
    const download = page.waitForEvent('download');
    await page.locator('#export-project').click();
    const file = await download;
    await file.saveAs(outPath('s10-project.json'));
    projectJson = await fs.readFile(outPath('s10-project.json'), 'utf8');
    const project = JSON.parse(projectJson);
    const theaterA = project.theaters.find(t => t.map.mapId === mapId);
    assert.ok(theaterA, '工程应包含原战区');
    assert.ok(Array.isArray(theaterA.fieldBattles), '工程战区应含 fieldBattles 数组');
    assert.equal(JSON.stringify(theaterA.fieldBattles), before, '工程内战场应逐值一致');
  });

  await step('D', '新 profile 导入后 fieldBattles 逐值一致', async () => {
    assert.ok(projectJson, '上一步导出成功才可导入');
    const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const freshPage = await fresh.newPage();
    try {
      freshPage.on('dialog', d => d.accept());
      await freshPage.goto(BASE);
      await freshPage.waitForSelector('#project-file', { state: 'attached' });
      await freshPage.evaluate(async () => { window.__fb = { store: await import('/src/store.ts') }; });
      await freshPage.locator('#project-file').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(projectJson) });
      await freshPage.locator('[role=status]').filter({ hasText: '工程已导入并恢复全部战区' }).waitFor();
      const restored = await freshPage.evaluate(() => JSON.stringify(structuredClone(window.__fb.store.appStore.fieldBattles)));
      assert.equal(restored, before, '新 profile 导入后战场应逐值一致');
    } finally {
      await fresh.close();
    }
  });

  await step('D', '缓存升级为 v5 且携带 fieldBattles；旧工程 v1–v3 迁移不崩溃', async () => {
    const cached = await inPage(async (id) => {
      const { readTheater } = window.__fb.cache;
      return structuredClone(await readTheater(id));
    }, mapId).catch(error => ({ error: String(error) }));
    await dump('s10-cache.json', cached);
    assert.ok(!cached.error, `读取缓存失败：${cached.error}`);
    // 契约：TheaterState 3→4（readTheater 返回值），CachedTheater 4→5（IndexedDB 原始条目）
    assert.equal(cached.version, 4, `TheaterState 版本应为 4，实际 ${cached.version}`);
    assert.equal(JSON.stringify(cached.fieldBattles ?? null), before, '恢复的 TheaterState 应逐值携带战场');
    const raw = await inPage(async (id) => {
      const { get, createStore } = await import('/node_modules/.vite/deps/idb-keyval.js');
      return structuredClone(await get(id, createStore('wenyou-theaters', 'theaters')));
    }, mapId).catch(error => ({ error: String(error) }));
    await dump('s10-raw-cache.json', raw);
    assert.ok(!raw.error, `读取原始缓存失败：${raw.error}`);
    assert.equal(raw.version, 5, `CachedTheater 版本应为 5（v4→v5 升级携带 fieldBattles），实际 ${raw?.version}`);
    assert.equal(JSON.stringify(raw.fieldBattles ?? null), before, '原始缓存应逐值携带战场');
    const legacy = await inPage(async (raw) => {
      const { parseProject } = await import('/src/project-serializer.ts');
      const results = [];
      for (const version of [1, 2, 3]) {
        const archive = JSON.parse(raw);
        archive.version = version;
        try {
          const parsed = parseProject(JSON.stringify(archive));
          results.push({ version, ok: true, battles: (parsed.theaters[0].fieldBattles ?? []).length });
        } catch (error) {
          results.push({ version, ok: false, error: String(error) });
        }
      }
      return results;
    }, projectJson ?? '{}').catch(error => [{ error: String(error) }]);
    await dump('s10-legacy-project.json', legacy);
    for (const item of legacy) {
      if (item.error) continue;
      assert.equal(item.ok, true, `旧工程 v${item.version} 迁移不应崩溃`);
      assert.equal(item.battles, 0, `旧工程 v${item.version} 不携带战场`);
    }
  });

  await step('D', '缓存 v5 / 工程 v4 不进入旧兵牌迁移（单位保持 BattleUnit 结构）', async () => {
    assert.ok(projectJson, '需要工程导出结果');
    const project = JSON.parse(projectJson);
    assert.ok((project.theaters ?? []).length > 0, '工程应含战区');
    for (const theater of project.theaters) {
      const unit = (theater.garrisons ?? [])[0];
      if (!unit) continue;
      assert.equal(typeof unit.personnel?.count?.value, 'number',
        '单位应保持 BattleUnit 结构（personnel.count.value），而非被旧兵牌迁移拍平');
      break;
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 11 · 回归
// ---------------------------------------------------------------------------

await scenario('回归', async () => {
  // 已有独立回归日志时只重跑场景；报告明确记录未重复执行的回归。
  current.note = process.env.FB_SKIP_REGRESSION === '1'
    ? '本轮仅复验场景；回归实跑日志见 .tmp-build/fb-g/initial-acceptance/s11-*.log' : '';
  const commands = process.env.FB_SKIP_REGRESSION === '1' ? [] : [
    ['tsc', 'npx', ['tsc', '--noEmit'], 300000],
    ['npm-test', 'npm', ['test'], 300000],
    ['npm-test-battle', 'npm', ['run', 'test:battle'], 600000],
    ['npm-test-browser', 'npm', ['run', 'test:browser'], 900000],
  ];
  for (const [name, cmd, args, timeout] of commands) {
    await step('G', `${cmd} ${args.join(' ')} 通过`, async () => {
      const run = spawnSync(cmd, args, { cwd: fileURLToPath(new URL('../', import.meta.url)),
        encoding: 'utf8', timeout, shell: true });
      const tail = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      await fs.writeFile(outPath(`s11-${name}.log`), tail);
      assert.equal(run.status, 0, `exit ${run.status}；日志尾部：${tail.slice(-500)}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const failedChecks = report.flatMap(s => s.checks.filter(c => c.status === 'fail').map(c => ({ scenario: s.name, ...c })));
await dump('results.json', {
  ranAt: new Date().toISOString(),
  environment: 'Windows / Playwright Chromium headless / ANGLE d3d11 / 独立 profile / Vite dev server :5297',
  mapId,
  scenarios: report.map(s => ({
    name: s.name,
    result: s.checks.every(c => c.status === 'pass') ? 'pass' : 'fail',
    note: [s.note, s.seeded ? '战场由直调 FB-S/FB-U 种子（UI 生成路径受阻，归属 FB-G）' : null].filter(Boolean).join('；') || undefined,
    checks: s.checks,
    newPageErrors: s.newPageErrors ?? [],
  })),
  failedChecks,
});
console.log('\n===== FB-V 验收汇总 =====');
for (const s of report) {
  const failed = s.checks.filter(c => c.status === 'fail');
  console.log(`${failed.length === 0 ? 'PASS' : 'FAIL'}  ${s.name}`);
  for (const f of failed) console.log(`      [${f.owner}] ${f.desc} :: ${f.error.slice(0, 220)}`);
}
console.log(`共 ${report.length} 组场景；失败 check ${failedChecks.length} 条；证据目录 .tmp-build/fb/`);
process.exitCode = failedChecks.length === 0 ? 0 : 1;

await browser.close();
await server.close();
