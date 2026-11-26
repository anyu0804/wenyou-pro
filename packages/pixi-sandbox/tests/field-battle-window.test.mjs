import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
import { chromium } from 'playwright';

let server;
let browser;
let page;
const errors = [];

const sampleRaw = await readFile(
  new URL('./fixtures/field-battle/sample.json', import.meta.url),
  'utf8'
);

before(async () => {
  server = await createServer({
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [
      {
        name: 'field-battle-window-test-page',
        configureServer(vite) {
          vite.middlewares.use('/__fb_window_test__', (_req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>FB-W1 Window Test</title>
</head>
<body>
  <div id="main-app">
    <canvas id="main-map-canvas" width="1440" height="888"></canvas>
  </div>
</body>
</html>`);
          });
        },
      },
    ],
  });

  await server.listen();
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${server.resolvedUrls.local[0]}__fb_window_test__`);

  // 初始化环境与数据
  await page.evaluate((sampleData) => {
    window.__sampleData = sampleData;
  }, JSON.parse(sampleRaw));
});

after(async () => {
  if (browser) await browser.close();
  if (server) await server.close();
});

test('按键数量/文本/显隐；点击开窗', async () => {
  const result = await page.evaluate(async () => {
    const { appStore } = await import('/src/store.ts');
    const { initFieldBattleOverlay, renderFieldBattleButtons } = await import(
      '/src/field-battle-overlay.ts'
    );
    const {
      initFieldBattleWindow,
      isFieldBattleWindowOpen,
      getActiveFieldBattle,
    } = await import('/src/field-battle-window.ts');

    initFieldBattleOverlay(document.body);
    initFieldBattleWindow(document.body);

    const b1 = { ...window.__sampleData, id: 'fb-1', name: '萨尔浒', anchor: [200, 150] };
    const b2 = { ...window.__sampleData, id: 'fb-2', name: '浑河', anchor: [450, 300] };

    appStore.fieldBattles = [b1, b2];
    appStore.showFieldBattles = true;
    renderFieldBattleButtons();

    const buttonsInitial = Array.from(
      document.querySelectorAll('.fieldbattle-button')
    ).map((btn) => ({
      id: btn.dataset.battleId,
      text: btn.textContent,
      visible: btn.offsetParent !== null || btn.style.display !== 'none',
    }));

    // 测试关闭开关 fieldbattle:visibility = false
    appStore.showFieldBattles = false;
    appStore.emit('fieldbattle:visibility', false);
    const containerAfterHide = document.getElementById(
      'fieldbattle-overlay-container'
    );
    const hiddenWhenOff = containerAfterHide ? containerAfterHide.hidden : true;

    // 再次开启开关 fieldbattle:visibility = true
    appStore.showFieldBattles = true;
    appStore.emit('fieldbattle:visibility', true);
    const windowOpenBeforeClick = isFieldBattleWindowOpen();

    // 点击第一个按键
    const btn1 = document.querySelector(
      '.fieldbattle-button[data-battle-id="fb-1"]'
    );
    const opened = new Promise(resolve => appStore.on('fieldbattle:changed', resolve));
    btn1.click();
    await opened;

    const windowOpenAfterClick = isFieldBattleWindowOpen();
    const activeBattleAfterClick = getActiveFieldBattle()?.id;
    const btn1Active = btn1?.classList.contains('active');
    const btn1Aria = btn1?.getAttribute('aria-pressed');

    const titleEl = document.querySelector('#field-battle-title');
    const titleText = titleEl ? titleEl.textContent : '';

    return {
      buttonsInitial,
      hiddenWhenOff,
      windowOpenBeforeClick,
      windowOpenAfterClick,
      activeBattleAfterClick,
      btn1Active,
      btn1Aria,
      titleText,
    };
  });

  assert.equal(result.buttonsInitial.length, 2);
  assert.equal(result.buttonsInitial[0].text, '萨尔浒战场');
  assert.equal(result.buttonsInitial[1].text, '浑河战场');
  assert.equal(result.hiddenWhenOff, true);
  assert.equal(result.windowOpenBeforeClick, false);
  assert.equal(result.windowOpenAfterClick, true);
  assert.equal(result.activeBattleAfterClick, 'fb-1');
  assert.equal(result.btn1Active, true);
  assert.equal(result.btn1Aria, 'true');
  assert.equal(result.titleText, '萨尔浒');
});

test('20 次开/关/切换后窗口中 canvas 数量恒为 1（共用 app），主地图 canvas 仍在', async () => {
  const result = await page.evaluate(async () => {
    const { appStore } = await import('/src/store.ts');
    const {
      openFieldBattleWindow,
      closeFieldBattleWindow,
    } = await import('/src/field-battle-window.ts');

    const b1 = appStore.fieldBattles[0];
    const b2 = appStore.fieldBattles[1];

    const contentEl = document.querySelector('#field-battle-content');
    const mainCanvas = document.querySelector('#main-map-canvas');

    const canvasCounts = [];

    // 执行 20 次开/关/切换
    for (let i = 0; i < 20; i++) {
      if (i % 3 === 0) {
        await openFieldBattleWindow(b1);
      } else if (i % 3 === 1) {
        await openFieldBattleWindow(b2);
      } else {
        closeFieldBattleWindow();
      }
      const count = contentEl ? contentEl.querySelectorAll('canvas').length : 0;
      canvasCounts.push(count);
    }

    // 最后再打开一次，验证有且只有 1 个 canvas
    await openFieldBattleWindow(b1);
    const finalCount = contentEl ? contentEl.querySelectorAll('canvas').length : 0;
    const mainCanvasStillThere = !!mainCanvas && document.body.contains(mainCanvas);

    return {
      canvasCounts,
      finalCount,
      mainCanvasStillThere,
    };
  });

  assert.equal(result.finalCount, 1);
  assert.equal(result.mainCanvasStillThere, true);
  // 每次打开或关闭时，content 中的 canvas 数量在首次创建后恒为 1
  for (const c of result.canvasCounts) {
    assert.equal(c, 1);
  }
});

test('收起后按键恢复；再次打开恢复 battle.view', async () => {
  const result = await page.evaluate(async () => {
    const { appStore } = await import('/src/store.ts');
    const {
      openFieldBattleWindow,
      closeFieldBattleWindow,
      setFieldBattleSceneFactory,
      isFieldBattleWindowOpen,
    } = await import('/src/field-battle-window.ts');

    closeFieldBattleWindow();

    const b1 = appStore.fieldBattles[0];
    let customView = { scale: 5.25, x: 230, y: 140 };

    setFieldBattleSceneFactory((ctx) => {
      return {
        destroy: () => {},
        saveView: () => customView,
      };
    });

    await openFieldBattleWindow(b1);

    const btn1 = document.querySelector(
      '.fieldbattle-button[data-battle-id="fb-1"]'
    );
    const activeBeforeMinimize = btn1?.classList.contains('active');

    // 点击收起按钮 #field-battle-minimize
    const minimizeBtn = document.querySelector(
      '#field-battle-minimize'
    );
    minimizeBtn?.click();

    const openAfterMinimize = isFieldBattleWindowOpen();
    const activeAfterMinimize = btn1?.classList.contains('active');
    const ariaAfterMinimize = btn1?.getAttribute('aria-pressed');
    const savedViewOnBattle = b1.view;

    // 重新打开 b1，检查传递给场景的 battle.view
    let receivedViewAtInit = null;
    setFieldBattleSceneFactory((ctx) => {
      receivedViewAtInit = ctx.battle.view;
      return {
        destroy: () => {},
        saveView: () => ctx.battle.view,
      };
    });

    await openFieldBattleWindow(b1);
    const openAfterReopen = isFieldBattleWindowOpen();

    return {
      activeBeforeMinimize,
      openAfterMinimize,
      activeAfterMinimize,
      ariaAfterMinimize,
      savedViewOnBattle,
      receivedViewAtInit,
      openAfterReopen,
    };
  });

  assert.equal(result.activeBeforeMinimize, true);
  assert.equal(result.openAfterMinimize, false);
  assert.equal(result.activeAfterMinimize, false);
  assert.equal(result.ariaAfterMinimize, 'false');
  assert.deepEqual(result.savedViewOnBattle, { scale: 5.25, x: 230, y: 140 });
  assert.deepEqual(result.receivedViewAtInit, { scale: 5.25, x: 230, y: 140 });
  assert.equal(result.openAfterReopen, true);
});

test('切换战场释放旧 host，关闭后 stage 不残留 host', async () => {
  const result = await page.evaluate(async () => {
    const { appStore } = await import('/src/store.ts');
    const { openFieldBattleWindow, closeFieldBattleWindow, setFieldBattleSceneFactory } =
      await import('/src/field-battle-window.ts');
    closeFieldBattleWindow();
    const hosts = [];
    let stage;
    setFieldBattleSceneFactory(ctx => {
      hosts.push(ctx.host);
      stage = ctx.app.stage;
      return { destroy() {}, saveView: () => ctx.battle.view };
    });
    const counts = [];
    for (let i = 0; i < 6; i++) {
      await openFieldBattleWindow(appStore.fieldBattles[i % 2]);
      counts.push(stage.children.length);
    }
    closeFieldBattleWindow();
    return { counts, remaining: stage.children.length, destroyed: hosts.every(host => host.destroyed) };
  });
  assert.deepEqual(result.counts, [1, 1, 1, 1, 1, 1]);
  assert.equal(result.remaining, 0);
  assert.equal(result.destroyed, true);
});

test('删除当前战场时窗口关闭', async () => {
  const result = await page.evaluate(async () => {
    const { appStore } = await import('/src/store.ts');
    const {
      openFieldBattleWindow,
      isFieldBattleWindowOpen,
      getActiveFieldBattle,
    } = await import('/src/field-battle-window.ts');

    const b1 = appStore.fieldBattles[0];
    await openFieldBattleWindow(b1);

    const openBeforeDelete = isFieldBattleWindowOpen();
    const activeBeforeDelete = getActiveFieldBattle()?.id;

    // 触发删除当前战场
    const delId = b1.id;
    appStore.fieldBattles = appStore.fieldBattles.filter((b) => b.id !== delId);
    appStore.emit('fieldbattle:changed', { battleId: delId, kind: 'delete' });

    const openAfterDelete = isFieldBattleWindowOpen();
    const activeAfterDelete = getActiveFieldBattle();
    const btn1Remaining = document.querySelector(
      `.fieldbattle-button[data-battle-id="${delId}"]`
    );

    return {
      openBeforeDelete,
      activeBeforeDelete,
      openAfterDelete,
      activeAfterDelete,
      btn1Remaining: !!btn1Remaining,
    };
  });

  assert.equal(result.openBeforeDelete, true);
  assert.equal(result.activeBeforeDelete, 'fb-1');
  assert.equal(result.openAfterDelete, false);
  assert.equal(result.activeAfterDelete, null);
  assert.equal(result.btn1Remaining, false);
  assert.deepEqual(errors, []);
});

test('回归：openFieldBattleWindow 异步初始化 app 期间同步关闭窗口，取消挂载且不卡死 inputOwner', async () => {
  const freshPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const freshErrors = [];
  freshPage.on('pageerror', (err) => freshErrors.push(err.message));
  try {
    await freshPage.goto(`${server.resolvedUrls.local[0]}__fb_window_test__`);
    const result = await freshPage.evaluate(async (sampleData) => {
      const {
        initFieldBattleWindow,
        openFieldBattleWindow,
        closeFieldBattleWindow,
        isFieldBattleWindowOpen,
        getActiveFieldBattle,
      } = await import('/src/field-battle-window.ts');
      const { getInputOwner } = await import('/src/input-owner.ts');
      const { FIELD_BATTLE_DOM } = await import('/src/field-battle-types.ts');

      initFieldBattleWindow(document.body);
      const pending = openFieldBattleWindow(sampleData);
      closeFieldBattleWindow();
      await pending;

      const winEl = document.querySelector(FIELD_BATTLE_DOM.window);
      return {
        isOpen: isFieldBattleWindowOpen(),
        active: getActiveFieldBattle(),
        owner: getInputOwner(),
        display: winEl?.style.display ?? null,
      };
    }, JSON.parse(sampleRaw));

    assert.equal(result.isOpen, false);
    assert.equal(result.active, null);
    assert.equal(result.owner, 'map');
    assert.equal(result.display, 'none');
    assert.deepEqual(freshErrors, []);
  } finally {
    await freshPage.close();
  }
});
