import { check051 } from './v051-browser-checks.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const release = process.env.PACKAGED_RELEASE_DIR;
assert.ok(release, 'PACKAGED_RELEASE_DIR 必须是最终 ZIP 的全新解压目录');
const evidenceRoot = path.resolve('.tmp-build/v0.9.1/full-package');
await fs.mkdir(evidenceRoot, { recursive: true });
const webRoot = path.join(release, 'www');
const webFiles = [];
let references = 0;
for (const relative of await fs.readdir(webRoot, { recursive: true })) {
  const file = path.join(webRoot, relative);
  if (!(await fs.stat(file)).isFile()) continue;
  webFiles.push(relative);
  if (!/\.(js|html)$/.test(file)) continue;
  const source = await fs.readFile(file, 'utf8');
  assert.ok(!source.includes('__perf') && !source.includes('Local benchmark v3 ready'));
  if (file.endsWith('.js')) for (const match of source.matchAll(/(?:from|import\s*\(|import)\s*["'](\.[^"']+\.js)["']/g)) {
    await fs.access(path.resolve(path.dirname(file), match[1]));
    references++;
  }
}
const port = '5296';
const child = spawn(path.join(release, 'runtime/node.exe'), ['server.mjs'], {
  cwd: release, env: { ...process.env, PORT: port }, windowsHide: true,
});
let browser;
try {
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`发行服务器退出：${code}`)));
    child.stdout.once('data', data => {
      assert.ok(data.toString().includes('v0.9.1'));
      resolve();
    });
  });
  const base = `http://127.0.0.1:${port}`;
  for (const file of webFiles) {
    const response = await fetch(`${base}/${file.split(path.sep).join('/')}`);
    assert.equal(response.status, 200, file);
    await response.arrayBuffer();
  }
  console.log('磁盘闭包与全量 HTTP 200 通过');
  browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('浏览器错误:', message.text()); });
  page.on('download', download => console.log('下载事件:', download.suggestedFilename()));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(base);
  await page.locator('#battle-open').waitFor();
  assert.ok((await page.title()).includes('v0.9.1'));
  // 空沙盘启动：先导入固定 fixture 建区，合成演示与后续流程都在该图上进行
  await page.locator('input[type=file][accept=".map"]').setInputFiles({ name: '验收.map', mimeType: 'text/plain',
    buffer: Buffer.from(await fs.readFile(new URL('./fixtures/fmg-legacy-default.map', import.meta.url), 'utf8')) });
  await page.locator('#wenyou-theater-bar [role="status"]').filter({ hasText: '已切换并恢复战区' }).waitFor();
  await page.locator('#battle-open').click();
  await page.locator('#battle-demo').click();
  console.log('生产页与合成演示已装载');
  assert.equal(await page.locator('#battle-units option').count(), 12);
  await page.locator('#battle-tab-orbat').click();
  assert.match(await page.locator('#battle-orbat-mount').innerText(), /8600|8,600/);
  await page.locator('#battle-tab-map').click();

  const exportProject = async () => {
    if (await page.locator('#battle-panel').isVisible()) await page.locator('#battle-close').click();
    if (await page.locator('#battle-ai-panel').isVisible()) await page.locator('#battle-ai-close').click();
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.locator('#export-project').click(),
    ]);
    const archive = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(archive.version, 4);
    return archive;
  };
  const active = archive => archive.theaters.find(theater => theater.map.mapId === archive.activeMapId);
  const before = await exportProject();
  console.log('首次工程下载通过');
  const baseline = active(before);
  const ids = baseline.battle.deployments.filter(dep => dep.placement.state === 'known' &&
    dep.placement.value.shape.kind === 'area').slice(0, 2).map(dep => dep.unitId);
  assert.equal(ids.length, 2);
  await page.locator('#battle-open').click();
  await page.locator('#battle-units').selectOption(ids);
  await page.locator('#battle-rotate-right').click();
  const rotated = await exportProject();
  const deployments = active(rotated).battle.deployments;
  for (const id of ids) {
    const original = baseline.battle.deployments.find(dep => dep.unitId === id);
    const changed = deployments.find(dep => dep.unitId === id);
    assert.notDeepEqual(changed.placement, original.placement);
    assert.equal(changed.facingDegrees.value, 15);
  }
  await page.locator('#battle-open').click();
  await page.locator('#battle-units').selectOption(ids);
  const header = baseline.map.source.split('\r\n')[0].split('|');
  const width = Number(header[4]), height = Number(header[5]);
  const scale = Math.min((1600 - 560) / width, (1000 - 48) / height, 1.25);
  const anchor = deployments.find(dep => dep.unitId === ids[0]).placement.value.anchor;
  const screen = [800 + (anchor[0] - width / 2) * scale, 500 + (anchor[1] - height / 2) * scale];
  await page.mouse.move(...screen);
  await page.mouse.down();
  await page.mouse.move(screen[0] + 24, screen[1] + 18, { steps: 4 });
  await page.mouse.up();
  const moved = await exportProject();
  for (const id of ids) {
    assert.notDeepEqual(active(moved).battle.deployments.find(dep => dep.unitId === id).placement,
      deployments.find(dep => dep.unitId === id).placement);
  }
  await page.locator('#battle-open').click();
  await page.locator('#battle-undo').click();
  assert.deepEqual(active(await exportProject()).battle.deployments, deployments);
  await page.locator('#battle-open').click();
  await page.locator('#battle-redo').click();
  assert.deepEqual(active(await exportProject()).battle.deployments, active(moved).battle.deployments);

  const target = active(moved).garrisons.find(unit => unit.id === ids[0]);
  const evidence = [{ sourceId: 'browser-ai', basis: 'assumption', excerpt: '合成候选', note: '仅验收' }];
  const candidate = { format: 'wenyou-battle-candidates', version: 1, mapId: moved.activeMapId,
    sources: [{ id: 'browser-ai', kind: 'ai', title: '浏览器合成候选', text: '修改合成单位名称', locator: null }],
    items: [
      { id: 'ready', state: 'ready', instruction: '修改合成单位名称', evidence,
        edits: [{ kind: 'upsert-unit', unit: { ...target,
          unitName: { state: 'known', value: '验收合成团', evidence } } }] },
      { id: 'unknown', state: 'unresolved', instruction: '未知位置', evidence, reason: '资料未给出位置' },
    ] };
  await page.locator('#battle-ai-open').click();
  await page.locator('#battle-ai-json').fill(JSON.stringify(candidate));
  await page.locator('#battle-ai-parse').click();
  await page.locator('#battle-ai-panel input[type=checkbox]:enabled').first().check();
  await page.locator('#battle-ai-preview').click();
  await page.locator('#battle-ai-apply').click();
  const accepted = await exportProject();
  assert.equal(active(accepted).garrisons.find(unit => unit.id === target.id).unitName.value, '验收合成团');
  assert.ok(active(accepted).battle.sources.some(source => source.id === 'browser-ai'));
  await page.locator('#battle-open').click();
  await page.locator('#battle-undo').click();
  assert.equal(active(await exportProject()).garrisons.find(unit => unit.id === target.id).unitName.value, target.unitName.value);
  await page.locator('#battle-open').click();
  await page.locator('#battle-redo').click();

  const downloadPng = page.waitForEvent('download');
  await page.locator('#battle-export').click();
  const png = await fs.readFile(await (await downloadPng).path());
  assert.equal(png.readUInt32BE(16), 1600);
  assert.equal(png.readUInt32BE(20), 1000);
  assert.ok(png.length > 5000);
  await fs.writeFile(path.join(evidenceRoot, 'production-battle.png'), png);
  await page.locator('#battle-close').click();
  await page.locator('#wenyou-theater-bar [role=status]').filter({ hasText: '当前战区已自动暂存' }).waitFor();
  await page.reload();
  await page.locator('#battle-open').click();
  assert.equal(await page.locator('#battle-units option').count(), 12);
  const restored = await exportProject();
  assert.deepEqual(active(restored).garrisons, active(accepted).garrisons);
  assert.deepEqual(active(restored).battle, active(accepted).battle);
  const second = structuredClone(active(restored));
  const records = second.map.source.split('\r\n');
  const mapHeader = records[0].split('|');
  mapHeader[6] = 'battle-browser-second';
  records[0] = mapHeader.join('|');
  second.map.source = records.join('\r\n');
  second.map.mapId = `${mapHeader[3]}-${mapHeader[6]}-${mapHeader[4]}x${mapHeader[5]}`;
  second.map.name = '验收第二战区';
  second.garrisons = [];
  second.battle = { schemaVersion: 1, sources: [], battlefields: [], deployments: [] };
  second.tacticalItems = [];
  restored.theaters.push(second);
  const twoPath = path.join(evidenceRoot, 'two-theaters.json');
  await fs.writeFile(twoPath, JSON.stringify(restored));
  await page.locator('#project-file').setInputFiles(twoPath);
  const theaterStatus = page.locator('#wenyou-theater-bar [role=status]');
  await page.waitForFunction(() => {
    const element = document.querySelector('#wenyou-theater-bar [role=status]');
    return /工程已导入并恢复全部战区|操作失败/.test(element?.textContent ?? '');
  }, null, { timeout: 60_000 });
  assert.match(await theaterStatus.innerText(), /工程已导入并恢复全部战区/);
  await page.locator('#theater-select').selectOption(second.map.mapId);
  await page.locator('#battle-open').click();
  assert.equal(await page.locator('#battle-units option').count(), 0);
  await page.locator('#battle-close').click();
  await page.locator('#theater-select').selectOption(restored.activeMapId);
  await page.locator('#battle-open').click();
  assert.equal(await page.locator('#battle-units option').count(), 12);
  await page.screenshot({ path: path.join(evidenceRoot, 'production-ui.png') });
  assert.deepEqual(errors, []);
  const v051 = await check051(page, exportProject, active, evidenceRoot);
  await theaterStatus.filter({ hasText: '全部战区已导出为推演工程' }).waitFor();
  await page.reload();
  await page.locator('#battle-open').waitFor();
  const fieldBaseline = active(await exportProject());
  await page.locator('#tactical-add-fieldbattle').click();
  // working-map fixture 的 cell 361 中心；刷新后主地图恢复初始 fit。
  await page.mouse.click(800 + (899.8 - width / 2) * scale,
    500 + (183.6 - height / 2) * scale);
  assert.equal(await page.locator('#fieldbattle-paint-count').innerText(), '1');
  await page.locator('#fieldbattle-paint-name').fill('生产验收');
  await page.locator('#fieldbattle-generate').click();
  const createdField = active(await exportProject()).fieldBattles.at(-1);
  assert.equal(createdField.name, '生产验收');
  assert.equal(createdField.cellIds.length, 1);
  await page.locator('#view-toggle-field-battles').check();
  const fieldButton = page.locator(`.fieldbattle-button[data-battle-id="${createdField.id}"]`);
  await fieldButton.click();
  await page.locator('#field-battle-toolbar').waitFor();
  const canvasRect = await page.locator('#field-battle-content canvas').boundingBox();
  const contentRect = await page.locator('#field-battle-content').boundingBox();
  assert.ok(Math.abs(canvasRect.width - contentRect.width) < 2);
  assert.ok(Math.abs(canvasRect.height - contentRect.height) < 2);
  await page.locator('#field-battle-style').selectOption('compact');
  await page.locator('#field-battle-new-unit').click();
  assert.equal(await page.locator('#modal-unit-select').inputValue(), '');
  await page.locator('#modal-name-input').fill('战场新建团');
  await page.locator('#modal-troops-input').fill('777');
  await page.locator('#modal-save-btn').click();
  await page.locator('#garrison-custom-modal').waitFor({ state: 'detached' });
  await page.screenshot({ path: path.join(evidenceRoot, 'production-field-battle.png') });
  await page.locator('#field-battle-minimize').click();
  const fieldEditedArchive = await exportProject();
  const fieldEdited = active(fieldEditedArchive).fieldBattles.at(-1);
  assert.equal(fieldEdited.units.length, createdField.units.length + 1);
  assert.equal(fieldEdited.units.at(-1).unitName.value, '战场新建团');
  assert.equal(fieldEdited.units.at(-1).sourceUnitId, '');
  assert.equal(fieldEdited.badgeStyle, 'compact');
  for (const key of ['map', 'garrisons', 'battle', 'tacticalItems']) {
    assert.deepEqual(active(fieldEditedArchive)[key], fieldBaseline[key], `战场编辑隔离：${key}`);
  }
  await theaterStatus.filter({ hasText: '全部战区已导出为推演工程' }).waitFor();
  await page.reload();
  await page.locator('#battle-open').waitFor();
  assert.deepEqual(active(await exportProject()).fieldBattles.at(-1), fieldEdited);
  const fieldPath = path.join(evidenceRoot, 'field-battle-project.json');
  await fs.writeFile(fieldPath, JSON.stringify(fieldEditedArchive));
  const freshContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const freshPage = await freshContext.newPage();
  freshPage.on('dialog', dialog => dialog.accept());
  freshPage.on('pageerror', error => errors.push(error.message));
  await freshPage.goto(base);
  await freshPage.locator('#battle-open').waitFor();
  await freshPage.locator('#project-file').setInputFiles(fieldPath);
  await freshPage.locator('#wenyou-theater-bar [role=status]').filter({ hasText: '工程已导入并恢复全部战区' }).waitFor();
  const [freshDownload] = await Promise.all([
    freshPage.waitForEvent('download'), freshPage.locator('#export-project').click(),
  ]);
  const imported = JSON.parse(await fs.readFile(await freshDownload.path(), 'utf8'));
  assert.deepEqual(active(imported).fieldBattles, active(fieldEditedArchive).fieldBattles);
  await freshContext.close();
  assert.deepEqual(errors, []);
  const result = { v051, version: '0.9.1', webFiles: webFiles.length, references, http: 'all 200',
    browser: 'isolated Chromium Headless Shell', viewport: '1600x1000', gpu: 'ANGLE d3d11',
    sampleCount: 1, scenarios: ['编制面板', '实际成组旋转与拖动', '撤销重做',
      'AI部分候选应用及来源同批', 'AI撤销重做', '真实PNG下载', '自动保存刷新与工程逐值往返',
      '两战区工程导入与隔离切换', '战场真实涂选生成/按键/窗口/画布尺寸',
      '战场设计器新建/样式/主地图隔离', '战场刷新持久化/新profile工程导入逐值往返'], pageErrors: errors };
  await fs.writeFile(path.join(evidenceRoot, 'release-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await browser.close();
  child.kill();
}
