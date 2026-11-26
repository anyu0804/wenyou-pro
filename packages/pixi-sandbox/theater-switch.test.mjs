import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright';

// 隔离浏览器 profile；不访问用户现有 IndexedDB，不写入任何原始 .map。
const browser = await chromium.launch({
  headless: true, args: ['--use-angle=d3d11'],
});
const server = await createServer({
  server: { hmr: false, host: '127.0.0.1', port: 5191, strictPort: true, watch: { ignored: ['**/.tmp-build/**'] } },
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(15000);
const failures = [];
page.on('pageerror', (error) => failures.push(error.message));
const source = await fs.readFile(new URL('./tests/fixtures/fmg-legacy-default.map', import.meta.url), 'utf8');
const fieldBattle = JSON.parse(await fs.readFile(new URL('./tests/fixtures/field-battle/sample.json', import.meta.url), 'utf8'));
const lines = source.split(/\r?\n/);
const header = lines[0].split('|');
const idA = `${header[3]}-${header[6]}-${header[4]}x${header[5]}`;
header[6] = String(Number(header[6]) + 1);
lines[0] = header.join('|');
const sourceB = lines.join('\r\n');
const idB = `${header[3]}-${header[6]}-${header[4]}x${header[5]}`;
const status = page.locator('#wenyou-theater-bar [role="status"]');
const results = [];

async function waitIdle(id) {
  await page.evaluate(async () => {
    window.theaterTestStore = (await import('/src/store.ts')).appStore;
  });
  await page.waitForFunction((expected) => {
    return window.theaterTestStore.mapId === expected && !window.theaterTestStore.isSwitchingMap;
  }, id);
}

async function snapshot() {
  return page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    return structuredClone({
      id: s.mapId, fieldBattles: s.fieldBattles,
      garrisons: s.garrisons, tacticalItems: s.tacticalItems,
      heights: Array.from(s.mapData.cells.h), states: Array.from(s.mapData.cells.state),
      provinces: Array.from(s.mapData.cells.province), religions: Array.from(s.mapData.cells.religion),
      burgs: s.mapData.burgs, stateEntities: s.mapData.states, provinceEntities: s.mapData.provinces,
    });
  });
}

async function drop(text, name = '同名大陆.map') {
  await page.evaluate(({ text, name }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([text], name, { type: 'text/plain' }));
    const over = new DragEvent('dragover', { dataTransfer: transfer, cancelable: true });
    window.dispatchEvent(over);
    if (!over.defaultPrevented) throw new Error('文件拖拽必须阻止浏览器默认行为');
    const event = new DragEvent('drop', { dataTransfer: transfer, cancelable: true });
    window.dispatchEvent(event);
    if (!event.defaultPrevented) throw new Error('文件落下必须阻止浏览器导航');
  }, { text, name });
}

try {
  await server.listen();
  await page.goto('http://127.0.0.1:5191/');
  await page.waitForSelector('#theater-select');
  // 空沙盘启动：无缓存时不加载任何底图，等待用户导入
  assert.match(await status.innerText(), /空沙盘/);
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).appStore.mapData), null);
  const placeholder = await page.evaluate(() => {
    const option = document.querySelector('#theater-select option');
    return option === null ? null : { text: option.textContent, disabled: option.disabled };
  });
  assert.deepEqual(placeholder, { text: '未加载地图 — 请导入 .map', disabled: true });
  await drop(source);
  await waitIdle(idA);
  results.push('空沙盘启动：无底图加载，拖入 .map 后建区');
  await page.evaluate(async (battle) => {
    const { appStore: s } = await import('/src/store.ts');
    const province = s.mapData.provinces[0];
    const migrated = (await import('/src/battle-storage.ts')).migrateLegacyBattle(s.mapId, [{ id: 'valuable-A', provinceId: province.i, unitName: '西北主力', troops: 34567,
      color: '#123456', status: '行军', x: province.x + 5, y: province.y + 7 }]);
    s.garrisons = migrated.garrisons; s.battle = migrated.battle;
    s.fieldBattles = [battle];
    s.tacticalItems = [{ id: 'line-A', type: 'frontline', points: [[100, 200], [300, 400]],
      color: '#ff0000', width: 9, label: '必须恢复', flipSide: true, toothStyle: 'semicircle' }];
    s.mapData.cells.h[s.mapData.cells.h.findIndex((h) => h >= 20)] = 51;
    s.mapData.burgs[0].name = '修改过的城市';
    s.mapData.states.find((state) => state.i > 0).name = '修改过的国家';
    s.mapData.provinces[0].name = '修改过的省';
    s.emit('tactical-change'); // 同时覆盖尚未到时的 500ms 延迟保存
    s.emit('garrisons-change');
    s.emit('fieldbattle:changed', { battleId: battle.id, kind: 'create' });
  }, fieldBattle);
  await drop(sourceB);
  await waitIdle(idB);
  assert.equal((await snapshot()).garrisons.length, 0, '新大陆不得带入旧大陆驻军');
  assert.equal((await snapshot()).tacticalItems.length, 0, '新大陆不得带入旧大陆战线');
  const aSaved = await page.evaluate(async (id) => (await import('/src/theater-cache.ts')).readTheater(id), idA);
  assert.equal(aSaved.garrisons[0].personnel.count.value, 34567);
  results.push('拖图前自动暂存；新大陆无旧兵牌/战线');

  await page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    const migrated = (await import('/src/battle-storage.ts')).migrateLegacyBattle(s.mapId, [{ id: 'valuable-B', provinceId: 0, unitName: '西南独立军', troops: 12345,
      color: '#00ff00', status: '驻防', x: 500, y: 300 }]);
    s.garrisons = migrated.garrisons; s.battle = migrated.battle;
    s.tacticalItems = [{ id: 'arrow-B', type: 'arrow', points: [[400, 200], [600, 300]],
      color: '#00ff00', width: 5, arrowStyle: 'dashed' }];
    s.emit('tactical-change');
    s.emit('garrisons-change');
  });
  await page.selectOption('#theater-select', idA);
  await waitIdle(idA);
  const restoredA = await snapshot();
  assert.equal(restoredA.garrisons[0].id, 'valuable-A');
  assert.equal(restoredA.garrisons[0].personnel.count.value, 34567);
  assert.equal(restoredA.tacticalItems[0].label, '必须恢复');
  assert.deepEqual(restoredA.fieldBattles, [fieldBattle]);
  assert.equal(restoredA.burgs[0].name, '修改过的城市');
  assert.ok(restoredA.heights.includes(51));
  results.push('A → B → A：兵力/位置/战线样式/地图修改恢复');

  const alteredA = source.replace(header[2], '2026-10-20');
  await drop(alteredA, '重命名大陆.map');
  await status.filter({ hasText: '已切换并恢复战区' }).waitFor();
  await waitIdle(idA);
  assert.deepEqual(await snapshot(), restoredA, '重命名/重存不覆盖缓存修改');
  results.push('重命名与保存日期变化仍恢复相同 mapId 的历史');

  await drop('不是合法的 FMG 文件', '损坏.map');
  await status.filter({ hasText: '操作失败' }).waitFor();
  assert.deepEqual(await snapshot(), restoredA, '损坏文件不得修改当前战区');
  results.push('损坏 .map：当前状态及数据完整保留');

  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === 'wenyou-theaters') {
        IDBObjectStore.prototype.put = put;
        throw new DOMException('测试：缓存空间不足', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  });
  await drop(sourceB);
  await status.filter({ hasText: 'QuotaExceededError' }).waitFor();
  assert.deepEqual(await snapshot(), restoredA, '暂存失败时不得切图或清场');
  results.push('真实 IndexedDB 写入边界注入 QuotaExceededError：停止切换且保留当前数据');

  await page.selectOption('#theater-select', idB);
  await waitIdle(idB);
  const restoredB = await snapshot();
  assert.equal(restoredB.garrisons[0].id, 'valuable-B');
  assert.equal(restoredB.tacticalItems[0].id, 'arrow-B');
  await page.reload();
  await page.waitForSelector('#theater-select');
  await page.selectOption('#theater-select', idB);
  await waitIdle(idB);
  assert.deepEqual(await snapshot(), restoredB, '刷新后仍从 IndexedDB 恢复 B');
  results.push('刷新页面后，通过战区下拉恢复另一大陆');

  await drop('not a map', 'readme.txt');
  await status.filter({ hasText: '请选择 FMG .map 文件' }).waitFor();
  assert.deepEqual(await snapshot(), restoredB);
  results.push('非 .map 拖入不导航、不改变当前战区');

  // 同 mapId 新版 .map 拖入并确认覆盖：应重建基底并载入新图内容，而非继续读旧缓存
  const updatedRecords = source.split('\r\n');
  const rawBurgsA = JSON.parse(updatedRecords[15]);
  const firstBurgIdx = rawBurgsA.findIndex((b) => b && typeof b === 'object' && b.i > 0);
  rawBurgsA[firstBurgIdx] = { ...rawBurgsA[firstBurgIdx], name: '新版重导城名' };
  updatedRecords[15] = JSON.stringify(rawBurgsA);
  const replacedSourceA = updatedRecords.join('\r\n');
  page.once('dialog', (dialog) => dialog.accept());
  await drop(replacedSourceA, '新版大陆A.map');
  await status.filter({ hasText: '已用新版 .map 覆盖并重建战区' }).waitFor();
  await waitIdle(idA);
  const afterReplaceA = await snapshot();
  assert.equal(afterReplaceA.burgs.some((b) => b.name === '新版重导城名'), true, '确认覆盖后应读取新版 .map 城市名');
  assert.equal(afterReplaceA.garrisons.length, 0, '覆盖重建战区后不应混入旧兵牌');
  results.push('同 mapId 新版 .map 确认覆盖后立即重建并载入新图');

  // 删除战区：先删 A 自动切到 B，再删 B 干净回到空沙盘
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#delete-theater');
  await status.filter({ hasText: '已删除战区' }).waitFor();
  await waitIdle(idB);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#theater-select option').length), 1);

  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#delete-theater');
  await status.filter({ hasText: '回到空沙盘' }).waitFor();
  await page.waitForFunction(() => window.theaterTestStore.mapData === null && !window.theaterTestStore.isSwitchingMap);
  assert.equal(await page.evaluate(async () => (await import('/src/theater-cache.ts')).listTheaters().then(l => l.length)), 0);
  results.push('删除战区：多战区自动切换，删光最后一个干净回到空沙盘');

  assert.deepEqual(failures, [], '无未处理浏览器异常');
  console.log(JSON.stringify({ passed: results.length, results, browser: 'Chromium headless / ANGLE d3d11' }, null, 2));
} finally {
  console.log('结束时界面状态:', await page.locator('#wenyou-theater-bar [role=status]').innerText());
  await browser.close();
  await server.close();
}
