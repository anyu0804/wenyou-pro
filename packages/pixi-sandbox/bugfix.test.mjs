import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { hmr: false, host: '127.0.0.1', port: 5196, strictPort: true,
  watch: { ignored: ['**/.tmp-build/**'] } } });
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('framenavigated',frame=>{if(frame===page.mainFrame()) console.log('导航',frame.url());});
const results = [];
const output = new URL('./.tmp-build/bugfix/', import.meta.url);
const status = page.locator('#wenyou-theater-bar [role=status]');
const saved = () => status.filter({ hasText: '当前战区已自动暂存' }).waitFor();
const cityName = () => page.evaluate(async () => (await import('/src/store.ts')).appStore.mapData.burgs[0].name);
const reload = async () => { await page.reload(); await page.waitForSelector('#theater-select'); };
const unloadPrevented = () => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});
async function paint() {
  const point = await page.evaluate(async () => {
    const { appStore: s, terrainContainer } = await import('/src/store.ts');
    s.interactionMode = 'brush-height';
    s.brushRadius = 6;
    s.heightDelta = 3;
    s.emit('brush:changed');
    const view = terrainContainer.parent;
    const cell = s.mapData.cells.p.findIndex(([x, y], i) => {
      const sx = x * view.scale.x + view.x, sy = y * view.scale.x + view.y;
      return s.mapData.cells.h[i] >= 20 && s.mapData.cells.h[i] < 90 && sx > 600 && sx < 950 && sy > 350 && sy < 750;
    });
    if (cell < 0) throw new Error('测试地图缺少画布可见陆地');
    const [x, y] = s.mapData.cells.p[cell];
    document.activeElement.blur();
    return { cell, before: s.mapData.cells.h[cell], x: x * view.scale.x + view.x, y: y * view.scale.x + view.y };
  });
  await page.mouse.click(point.x, point.y);
  await saved();
  return point;
}
const height = cell => page.evaluate(async cell => (await import('/src/store.ts')).appStore.mapData.cells.h[cell], cell);

try {
  await fs.mkdir(output, { recursive: true });
  await server.listen();
  await page.goto('http://127.0.0.1:5196/');
  await page.waitForSelector('#theater-select');
  // 空沙盘启动：先导入固定 fixture 建区
  await page.locator('input[type=file][accept=".map"]').setInputFiles({ name: '回归.map', mimeType: 'text/plain',
    buffer: Buffer.from(await fs.readFile(new URL('./tests/fixtures/fmg-legacy-default.map', import.meta.url), 'utf8')) });
  await page.locator('#wenyou-theater-bar [role="status"]').filter({ hasText: '已切换并恢复战区' }).waitFor();
  assert.equal(await unloadPrevented(), false);
  assert.equal((await page.request.get('http://127.0.0.1:5196/api/worlds/unknown')).status(), 404);

  const first = await paint();
  assert.ok(await height(first.cell) > first.before);
  await page.keyboard.press('Control+z');
  await saved();
  await reload();
  assert.equal(await height(first.cell), first.before);
  const second = await paint();
  const painted = await height(second.cell);
  await page.keyboard.press('Control+z');
  await saved();
  await page.keyboard.press('Control+y');
  await saved();
  await reload();
  assert.equal(await height(second.cell), painted);
  results.push('真实画布落笔、Ctrl+Z/Ctrl+Y 自动保存；分别刷新读回撤销和重做结果');
  console.log(results.at(-1));

  const leaving = page.waitForEvent('dialog');
  page.once('dialog', dialog => dialog.dismiss());
  await page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    s.mapData.burgs[0].name = '待保存离页确认';
    s.emit('entity:changed');
    window.realDialogRequested = true;
    location.reload();
  });
  const dialog = await leaving;
  assert.equal(dialog.type(), 'beforeunload');
  assert.equal(await cityName(), '待保存离页确认');
  await saved();
  assert.equal(await unloadPrevented(), false);
  results.push('500ms 暂存窗口内实际刷新出现离页确认；取消后保留编辑，提交完成后不再阻止离页');
  console.log(results.at(-1));

  await page.evaluate(async () => {
    window.cacheWrites = [];
    window.holdSave = true;
    window.originalTransaction = IDBDatabase.prototype.transaction;
    window.originalPut = IDBObjectStore.prototype.put;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = window.originalTransaction.apply(this, args);
      if (this.name === 'wenyou-theaters' && tx.mode === 'readwrite' && window.holdSave) {
        const keepOpen = () => {
          tx.objectStore('theaters').get('__test_pending__').onsuccess = () => { if (window.holdSave) keepOpen(); };
        };
        keepOpen();
      }
      return tx;
    };
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.transaction.db.name === 'wenyou-theaters') window.cacheWrites.push({ value, key });
      return window.originalPut.call(this, value, key);
    };
    const { appStore: s } = await import('/src/store.ts');
    const { captureTheater } = await import('/src/theater-cache.ts');
    const copy = captureTheater();
    if (copy.mapData.cells.polygons !== s.mapData.cells.polygons || copy.mapData.cells.h === s.mapData.cells.h) throw new Error('暂存复制范围不对');
    s.mapData.burgs[0].name = 'hidden立即保存';
    s.emit('entity:changed');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
  });
  await page.waitForFunction(() => window.cacheWrites.length >= 3);
  assert.equal(await unloadPrevented(), true);
  await page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    s.mapData.burgs[0].name = '写入期间的最后一步';
    s.emit('entity:changed');
    window.holdSave = false;
  });
  await saved();
  const writes = await page.evaluate(() => {
    IDBDatabase.prototype.transaction = window.originalTransaction;
    IDBObjectStore.prototype.put = window.originalPut;
    return window.cacheWrites.map(({ key, value }) => ({ key, version: value.version,
      hasOriginal: value.mapData?.source.originalMap !== undefined,
      hasGeometry: value.mapData?.cells.polygons !== undefined }));
  });
  assert.equal(writes.filter(w => w.version === 5).length, 2);
  assert.ok(writes.every(w => !w.hasOriginal && !w.hasGeometry && !String(w.key).startsWith('__base__')));
  assert.equal(await unloadPrevented(), false);
  await reload();
  assert.equal(await cityName(), '写入期间的最后一步');
  results.push('hidden 事件立即保存；真实 IDB 事务挂起时离页受保护；提交期间新编辑随后落盘；两次暂存均未写原文/几何');
  console.log(results.at(-1));

  const archive = await page.evaluate(async () => {
    const { captureTheater } = await import('/src/theater-cache.ts');
    const { serializeProject } = await import('/src/project-serializer.ts');
    const state = captureTheater();
    state.mapData.burgs[0].name = '文件里的旧版本';
    return serializeProject([state], state.mapData.source.mapId);
  });
  const upload = () => page.locator('#project-file').setInputFiles({ name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(archive) });
  const canceledDialog = page.waitForEvent('dialog');
  page.once('dialog', dialog => dialog.dismiss());
  await upload();
  const cancel = await canceledDialog;
  assert.ok(cancel.message().includes(JSON.parse(archive).activeMapId));
  assert.ok(cancel.message().includes(JSON.parse(archive).theaters[0].map.name));
  await status.filter({ hasText: '已取消工程导入' }).waitFor();
  assert.equal(await cityName(), '写入期间的最后一步');
  const acceptedDialog = page.waitForEvent('dialog');
  page.once('dialog', dialog => dialog.accept());
  await upload();
  assert.equal((await acceptedDialog).type(), 'confirm');
  await status.filter({ hasText: '工程已导入并恢复全部战区' }).waitFor();
  await reload();
  assert.equal(await cityName(), '文件里的旧版本');
  results.push('工程覆盖提示包含战区名称及身份；取消保留编辑，确认才替换且刷新持久化');
  console.log(results.at(-1));

  const view = () => page.evaluate(async () => {
    const { terrainContainer } = await import('/src/store.ts');
    const v = terrainContainer.parent;
    return { scale: v.scale.x, x: (innerWidth / 2 - v.x) / v.scale.x, y: (innerHeight / 2 - v.y) / v.scale.x };
  });
  const before = await view();
  await page.evaluate(async () => {
    window.resizeTestViewport = (await import('/src/store.ts')).terrainContainer.parent;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.waitForFunction(expected => {
    const v = window.resizeTestViewport;
    return innerWidth === 1400 && innerHeight === 900 &&
      Math.abs((innerWidth / 2 - v.x) / v.scale.x - expected.x) < 0.001 &&
      Math.abs((innerHeight / 2 - v.y) / v.scale.y - expected.y) < 0.001;
  }, before);
  const after = await view();
  console.log('resize 前后',JSON.stringify({before,after}));
  assert.equal(after.scale, before.scale);
  assert.ok(Math.abs(after.y - before.y) < 0.001);
  await page.screenshot({ path: fileURLToPath(new URL('resized.png', output)) });
  results.push('resize 保留缩放与地图中心');
  console.log(results.at(-1));

  const brokenTheaterId = await page.evaluate(async () => (await import('/src/store.ts')).appStore.mapId);
  await page.evaluate(async (id) => {
    const { createStore, set } = await import('/node_modules/.vite/deps/idb-keyval.js');
    await set(id, { version: 99, evidence: '保留损坏原始数据' }, createStore('wenyou-theaters', 'theaters'));
  }, brokenTheaterId);
  await page.reload();
  await page.waitForSelector('#startup-error');
  assert.ok((await page.locator('#startup-error').textContent()).includes('缓存结构无效'));
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-raw-cache').click();
  const raw = await downloaded;
  const rawPath = await raw.path();
  const data = JSON.parse(await fs.readFile(rawPath, 'utf8'));
  assert.ok(data.some(([, value]) => value?.evidence === '保留损坏原始数据'));
  await page.locator('#ignore-cache').click();
  await page.waitForSelector('#theater-select');
  assert.equal(await page.locator('#startup-error').count(), 0);
  // 忽略后进入空沙盘；损坏原记录在用户重新行动前保持原样
  assert.match(await status.innerText(), /空沙盘/);
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).appStore.mapData), null);
  assert.equal(await page.evaluate(async (id) => {
    const { get, createStore } = await import('/node_modules/.vite/deps/idb-keyval.js');
    return (await get(id, createStore('wenyou-theaters', 'theaters'))).version;
  }, brokenTheaterId), 99, '空沙盘启动不得直接覆盖原缓存');
  // 重新导入同一张图：重建缓存并可继续编辑
  await page.locator('input[type=file][accept=".map"]').setInputFiles({ name: '重建.map', mimeType: 'text/plain',
    buffer: Buffer.from(await fs.readFile(new URL('./tests/fixtures/fmg-legacy-default.map', import.meta.url), 'utf8')) });
  await status.filter({ hasText: '已切换并恢复战区' }).waitFor();
  await page.evaluate(async () => {
    const { appStore: s } = await import('/src/store.ts');
    s.mapData.burgs[0].name = '重建后的新编辑';
    s.emit('entity:changed');
  });
  await saved();
  await reload();
  assert.equal(await cityName(), '重建后的新编辑');
  results.push('损坏缓存显示可操作错误；原始缓存可下载；忽略后空沙盘启动不覆盖原记录，重新导入同图重建缓存并可刷新');
  assert.deepEqual(errors, []);
  await fs.writeFile(new URL('results.json', output), JSON.stringify({ passed: results.length, results,
    environment: 'Windows / Chromium headless / ANGLE d3d11 / isolated profile' }, null, 2));
  console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
  console.log('结束时界面状态:', await page.locator('#wenyou-theater-bar [role=status]').innerText());
  await browser.close();
  await server.close();
}
