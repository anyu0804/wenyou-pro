import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 隔离 profile、内存地图副本；不接触用户浏览器和原始 fixture。
const server = await createServer({ server: { hmr: false, host: '127.0.0.1', port: 5192, strictPort: true,
  watch: { ignored: ['**/.tmp-build/**'] } } });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.on('dialog', dialog => dialog.accept());
page.setDefaultTimeout(20000);
const results = [];
const output = new URL('./.tmp-build/export-import/', import.meta.url);
await fs.mkdir(output, { recursive: true });
// 冻结 FMG v1.139.2 验收链要求 v1.139 以前的底图；包内底图随版本更换，不再直接引用
const source = await fs.readFile(new URL('./tests/fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');
const fieldBattle = JSON.parse(await fs.readFile(new URL('./tests/fixtures/field-battle/sample.json', import.meta.url), 'utf8'));
const recordsB = source.split('\r\n');
const headerB = recordsB[0].split('|');
headerB[6] = String(Number(headerB[6]) + 200);
recordsB[0] = headerB.join('|');
const sourceB = recordsB.join('\r\n');
const status = page.locator('#wenyou-theater-bar [role="status"]');
const idle = () => page.waitForFunction(async () => !(await import('/src/store.ts')).appStore.isSwitchingMap);
const snapshot = target => target.evaluate(async () => {
  const { captureTheater } = await import('/src/theater-cache.ts');
  return JSON.stringify(captureTheater());
});
async function download(button, name) {
  const event = page.waitForEvent('download');
  await page.locator(button).click();
  const downloaded = await event;
  const dest = new URL(name, output);
  await downloaded.saveAs(fileURLToPath(dest));
  await idle();
  return fs.readFile(dest, 'utf8');
}

try {
  await server.listen();
  await page.goto('http://127.0.0.1:5192/');
  await page.waitForSelector('#download-map');
  // 空沙盘启动：先导入固定 fixture 建区，后续编辑与 edited.map 导出都在该图上进行
  await page.locator('input[type=file][accept=".map"]').setInputFiles({ name: 'A.map', mimeType: 'text/plain', buffer: Buffer.from(source) });
  await status.filter({ hasText: '已切换并恢复战区' }).waitFor();
  const metadata = await page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    const { serializeMap } = await import('/src/map-serializer.ts');
    const { parseWorkingMap } = await import('/src/map-loader.ts');
    const m = s.mapData;
    const original = m.source.originalMap.split('\r\n');
    const used = new Set(m.burgs.map(b => b.cell));
    const cell = m.cells.h.findIndex((h, i) => h >= 20 && !used.has(i) && m.cells.state[i] > 0 && m.cells.province[i] > 0);
    const city = m.burgs[0];
    city.name = '新名 | <城> & "双引号" 😀';
    const removed = m.burgs[1];
    removed.removed = true;
    const id = JSON.parse(original[15]).length + 2; // 验证 tombstone 和非连续 ID
    m.burgs.push({ i: id, name: '新增城 | 甲', cell, x: m.cells.p[cell][0], y: m.cells.p[cell][1],
      state: m.cells.state[cell], province: m.cells.province[cell], capital: 0, port: 0,
      population: 1.234, tier: 'city', removed: false });
    const target = m.states.find(st => st.i > 0 && !st.removed && st.i !== m.cells.state[cell]);
    m.cells.state[cell] = target.i;
    const province = m.provinces.find(p => p.i !== m.cells.province[cell]);
    m.cells.province[cell] = province.i;
    s.emit('entity:changed');
    const text = serializeMap(m);
    const serialized = text.split('\r\n');
    const loaded = parseWorkingMap(text);
    const svg = new DOMParser().parseFromString(serialized[5], 'image/svg+xml');
    const changed = new Set([5, 14, 15, 17, 25, 26, 27, 30]);
    if (!original.every((section, i) => changed.has(i) || section === serialized[i])) throw new Error('非编辑段发生变化');
    if (loaded.burgs.find(b => b.i === city.i).name !== city.name || loaded.burgs.find(b => b.i === id).name !== '新增城 | 甲') throw new Error('城市重载失败');
    if (loaded.burgs.some(b => b.i === removed.i)) throw new Error('删除城市复活');
    if (loaded.cells.state[cell] !== target.i || loaded.cells.province[cell] !== province.i) throw new Error('领土重载失败');
    if (Number(serialized[17].split(',')[cell]) !== id) throw new Error('cells.burg 索引错误');
    if (svg.querySelector('parsererror') || svg.getElementById(`burgLabel${city.i}`).textContent !== city.name ||
        !svg.getElementById(`burg${id}`) || svg.getElementById(`burg${removed.i}`)) throw new Error('SVG 图标/标签不一致');
    return { mapId: s.mapId, cell, city: city.i, added: id, removed: removed.i, sections: serialized.length };
  });
  results.push('标准 CRLF 结构；非编辑段保持；新增/改名/删除城市、转义、稀疏 ID、领土、cells.burg、SVG 往返');
  const mapText = await download('#download-map', 'edited.map');
  assert.equal(mapText.split('\r\n').length, metadata.sections);
  results.push('真实按钮触发 Blob .map 下载');
  await page.screenshot({ path: fileURLToPath(new URL('toolbar.png', output)) });
  await page.evaluate(async (snapshot) => {
    const { appStore: s } = await import('/src/store.ts');
    const land = s.mapData.cells.h.findIndex(h => h >= 20);
    s.mapData.cells.h[land] = 57;
    const migrated = (await import('/src/battle-storage.ts')).migrateLegacyBattle(s.mapId, [{ id: 'army-A', provinceId: 0, unitName: '甲战区', troops: 23456, color: '#123456', status: '行军', x: 200, y: 300 }]);
    s.garrisons = migrated.garrisons; s.battle = migrated.battle;
    s.fieldBattles = [snapshot];
    s.tacticalItems = [{ id: 'line-A', type: 'frontline', points: [[100, 100], [250, 200]], color: '#abcdef', width: 7, label: '西线', flipSide: true, toothStyle: 'semicircle' }];
    s.emit('tactical-change');
    s.emit('fieldbattle:changed', { battleId: snapshot.id, kind: 'create' });
  }, fieldBattle);
  await page.locator('#download-map').click();
  await status.filter({ hasText: '细地块高度修改' }).waitFor();
  results.push('.map 高度格式限制明确报错；不丢弃高度修改');
  await page.locator('input[type=file][accept=".map"]').setInputFiles({ name: 'B.map', mimeType: 'text/plain', buffer: Buffer.from(sourceB) });
  await status.filter({ hasText: '已切换并恢复战区' }).waitFor();
  await idle();
  await page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    const migrated = (await import('/src/battle-storage.ts')).migrateLegacyBattle(s.mapId, [{ id: 'army-B', provinceId: 0, unitName: '乙战区', troops: 9876, color: '#ff0000', status: '驻防', x: 400, y: 500 }]);
    s.garrisons = migrated.garrisons; s.battle = migrated.battle;
    s.tacticalItems = [{ id: 'arrow-B', type: 'arrow', points: [[400, 400], [500, 500]], color: '#ff0000', width: 3, arrowStyle: 'double-retreat' }];
    s.emit('tactical-change');
  });
  const json = await download('#export-project', 'project.json');
  const project = JSON.parse(json);
  assert.equal(project.theaters.length, 2);
  assert.equal(project.theaters.find(t => t.map.mapId === metadata.mapId).garrisons[0].personnel.count.value, 23456);
  const expected = JSON.parse(await snapshot(page));
  // 跨 profile 迁移按顺序验证；原 profile 缓存保留，暂停其整图渲染。
  await page.goto('about:blank');
  const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await fresh.route('**/api/worlds/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline-test"}' }));
  const restored = await fresh.newPage();
  restored.on('dialog', dialog => dialog.accept());
  restored.on('console', message => { if (message.type() === 'error') console.error('fresh profile:', message.text()); });
  await restored.goto('http://127.0.0.1:5192/');
  await restored.waitForSelector('#project-file', { state: 'attached' });
  await restored.locator('#project-file').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await restored.locator('[role=status]').filter({ hasText: '工程已导入并恢复全部战区' }).waitFor();
  assert.deepEqual(JSON.parse(await snapshot(restored)), expected);
  await restored.selectOption('#theater-select', metadata.mapId);
  await restored.locator('[role=status]').filter({ hasText: '已切换并恢复战区' }).waitFor();
  const restoredA = JSON.parse(await snapshot(restored));
  assert.equal(restoredA.garrisons[0].personnel.count.value, 23456);
  assert.equal(restoredA.tacticalItems[0].toothStyle, 'semicircle');
  assert.ok(Object.values(restoredA.mapData.cells.h).includes(57));
  assert.equal(restoredA.mapData.burgs[0].name, '新名 | <城> & "双引号" 😀');
  assert.deepEqual(restoredA.fieldBattles, [fieldBattle]);
  results.push('新浏览器 profile 导入单个 JSON，全部战区的地图修改/高度/兵牌/战线/战场快照完全恢复');
  await restored.reload();
  await restored.waitForSelector('#theater-select');
  await restored.selectOption('#theater-select', project.activeMapId);
  await restored.locator('[role=status]').filter({ hasText: '已切换并恢复战区' }).waitFor();
  assert.equal(JSON.parse(await snapshot(restored)).garrisons[0].id, 'army-B');
  results.push('工程导入已持久化，刷新后可再次恢复非默认战区');
  await fresh.close();
  await page.goto('http://127.0.0.1:5192/');
  await page.waitForSelector('#project-file', { state: 'attached' });
  const migration = await page.evaluate(async text => {
    const { parseProject, serializeProject } = await import('/src/project-serializer.ts');
    const old = JSON.parse(text);
    old.version = 1;
    for (const state of old.theaters) {
      state.version = 1;
      state.garrisons = state.garrisons.map(unit => {
        const placement = state.battle.deployments.find(d => d.unitId === unit.id).placement;
        return { id: unit.id, color: unit.color, unitName: unit.unitName.value,
          troops: unit.personnel.count.value, provinceId: unit.provinceId.value ?? 0,
          status: unit.status.value, x: placement.value.anchor[0], y: placement.value.anchor[1] };
      });
      delete state.battle;
      state.currentWorldId = 'immortal-game1';
      state.currentTurnIndex = 1;
      state.showGhost = true;
      state.ghostTacticalItems = [];
      state.turns = [{ title: '旧历史不得覆盖当前部署', garrisons: [] }];
    }
    const loaded = parseProject(JSON.stringify(old));
    return JSON.parse(serializeProject(loaded.theaters, loaded.activeMapId));
  }, json);
  assert.equal(migration.version, 4);
  assert.ok(migration.theaters.every(t => t.fieldBattles.length === 0));
  const activeTheater = theaters => theaters.find(t => t.map.mapId === project.activeMapId);
  assert.equal(activeTheater(migration.theaters).garrisons[0].personnel.count.value, activeTheater(project.theaters).garrisons[0].personnel.count.value);
  assert.ok(migration.theaters.every(t => !('turns' in t) && !('currentTurnIndex' in t)));
  results.push('旧 v1 工程迁移：保留当前地图/部署；v3 导出不挂载旧回合字段');
  const validation = await page.evaluate(async text => {
    const { parseProject } = await import('/src/project-serializer.ts');
    const archive = JSON.parse(text);
    const mutate = [
      p => { p.version = 99; },
      p => { p.activeMapId = 'missing'; },
      p => { p.theaters.push(p.theaters[0]); },
      p => { p.theaters[0].map.statesByCell.pop(); },
      p => { p.theaters[0].map.heights[0] = 256; },
      p => { p.theaters[0].tacticalItems[0].color = 'red'; },
      p => { p.theaters[0].tacticalItems[0].points = [[1, 'bad']]; },
      p => { p.theaters[0].garrisons[0].personnel.count.value = 'many'; },
    ];
    let rejected = 0;
    for (const change of mutate) {
      const p = structuredClone(archive);
      change(p);
      try { parseProject(JSON.stringify(p)); } catch (error) {
        if (!/工程文件字段无效|战役字段无效/.test(String(error))) throw error;
        rejected++;
      }
    }
    return rejected;
  }, json);
  assert.equal(validation, 8);
  const before = await snapshot(page);
  await page.locator('#project-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
  await status.filter({ hasText: '操作失败' }).waitFor();
  assert.deepEqual(JSON.parse(await snapshot(page)), JSON.parse(before));
  results.push('8 种结构损坏被拒绝；非法 JSON 通过 UI 提示且当前状态不变');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let puts = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (++puts === 5) { IDBObjectStore.prototype.put = original; throw new DOMException('injected', 'QuotaExceededError'); }
      return original.apply(this, args);
    };
  });
  const quotaProject = structuredClone(project);
  quotaProject.theaters[0].garrisons[0].personnel.count.value = 1;
  await page.locator('#project-file').setInputFiles({ name: 'quota.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(quotaProject)) });
  await status.filter({ hasText: 'QuotaExceededError' }).waitFor();
  assert.deepEqual(JSON.parse(await snapshot(page)), JSON.parse(before));
  const persisted = await page.evaluate(async id => (await import('/src/theater-cache.ts')).readTheater(id), project.activeMapId);
  assert.equal(persisted.garrisons[0].personnel.count.value, 9876);
  results.push('第二战区写入时注入 QuotaExceededError：事务回滚，目录/所有战区不发生半导入，当前画布保留');
  await fs.writeFile(new URL('results.json', output), JSON.stringify({ metadata, results, validation,
    environment: 'Windows, Chromium headless, ANGLE d3d11, 1600x1000; 空沙盘启动后导入 tests/fixtures/fmg-legacy-default.map', passed: results.length }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  console.log('结束时界面状态:', await page.locator('#wenyou-theater-bar [role=status]').innerText());
  await browser.close();
  await server.close();
}
