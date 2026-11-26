import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';

// 启动轻量 Vite SSR 服务以加载生产模块
const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});

after(() => server.close());

// 场景单测只校验布局与相机；字体宽度用逐字符等宽 mock，不测真实字体测量。
const { CanvasTextMetrics } = await import('pixi.js');
mock.method(CanvasTextMetrics, 'measureText', (text, style) => ({
  width: Array.from(text).length * style.fontSize, height: style.fontSize * 1.2,
}));
after(() => mock.restoreAll());

const {
  computeOutlineBounds,
  createFieldBattleTarget,
  createFieldBattleScene,
} = await server.ssrLoadModule('/src/field-battle-scene.ts');

const {
  undoFieldBattle,
  redoFieldBattle,
  resetFieldBattleHistory,
} = await server.ssrLoadModule('/src/field-battle-history.ts');

const { isTextInput, setInputOwner, getInputOwner } = await server.ssrLoadModule(
  '/src/input-owner.ts'
);

const { FIELD_BATTLE_DOM } = await server.ssrLoadModule(
  '/src/field-battle-types.ts'
);

const sampleRaw = await readFile(
  new URL('./fixtures/field-battle/sample.json', import.meta.url),
  'utf8'
);

function getSampleBattle() {
  return JSON.parse(sampleRaw);
}

test('target 适配器：读 battle 三数组，newUnitCenter 返回相机中心或包围盒中心', () => {
  const battle = getSampleBattle();
  let customCenterCalled = false;
  const target = createFieldBattleTarget(battle, {
    getCameraCenter: () => {
      customCenterCalled = true;
      return [350, 450];
    },
  });

  // 实时读 battle 三数组
  assert.equal(target.getUnits(), battle.units);
  assert.equal(target.getDeployments(), battle.deployments);
  assert.equal(target.getSources(), battle.sources);

  // newUnitCenter
  assert.deepEqual(target.newUnitCenter(), [350, 450]);
  assert.equal(customCenterCalled, true);

  // 默认 fallback newUnitCenter
  const defaultTarget = createFieldBattleTarget(battle);
  assert.deepEqual(defaultTarget.newUnitCenter(), [
    battle.bounds.x + battle.bounds.width / 2,
    battle.bounds.y + battle.bounds.height / 2,
  ]);
});

test('target 适配器：commit 新建单位自动补 sourceUnitId，commit 删除后引用解除，undo/redo 恢复整批', () => {
  const battle = getSampleBattle();
  resetFieldBattleHistory(battle.id);

  let commitCallbackCalled = false;
  const target = createFieldBattleTarget(battle, {
    onCommit: () => {
      commitCallbackCalled = true;
    },
  });

  // 1. 新建单位（设计器产出 BattleUnit，不带 sourceUnitId）
  const newUnit = {
    id: 'unit-test-new-1',
    color: '#2563eb',
    assertion: 'fact',
    unitName: { state: 'known', value: '先锋营', evidence: [] },
    provinceId: { state: 'known', value: null, evidence: [] },
    status: { state: 'known', value: '行军', evidence: [] },
    parentUnitId: { state: 'known', value: null, evidence: [] },
    echelon: { state: 'known', value: '营', evidence: [] },
    branch: { state: 'known', value: '步兵', evidence: [] },
    side: { state: 'known', value: '演示方', evidence: [] },
    childrenCompleteness: { state: 'known', value: 'complete', evidence: [] },
    personnel: { scope: 'own', count: { state: 'known', value: 450, evidence: [] } },
  };
  const newDeployment = {
    unitId: 'unit-test-new-1',
    assertion: 'fact',
    battlefieldId: { state: 'known', value: null, evidence: [] },
    placement: {
      state: 'known',
      value: { anchor: [45, 45], shape: { kind: 'point' } },
      evidence: [],
    },
    facingDegrees: { state: 'known', value: 0, evidence: [] },
    depthMapUnits: { state: 'known', value: 3, evidence: [] },
    formationLine: { state: 'known', value: 1, evidence: [] },
    role: { state: 'known', value: 'line', evidence: [] },
    reserveForUnitId: { state: 'known', value: null, evidence: [] },
  };

  target.commit({
    units: { upsert: [newUnit], remove: [] },
    deployments: { upsert: [newDeployment], removeByUnitId: [] },
    sources: { upsert: [] },
  });

  assert.equal(commitCallbackCalled, true);
  const foundNew = battle.units.find((u) => u.id === 'unit-test-new-1');
  assert.ok(foundNew, '新建单位已加入 battle.units');
  assert.equal(foundNew.sourceUnitId, '', '新建单位自动补空串 sourceUnitId');
  assert.ok(battle.deployments.some((d) => d.unitId === 'unit-test-new-1'));

  // 2. 删除单位并验证引用解除
  // field-unit-2 引用了 field-unit-1 (parentUnitId 与 reserveForUnitId)
  target.commit({
    units: { upsert: [], remove: ['field-unit-1'] },
    deployments: { upsert: [], removeByUnitId: ['field-unit-1'] },
    sources: { upsert: [] },
  });

  assert.equal(battle.units.some((u) => u.id === 'field-unit-1'), false);
  assert.equal(battle.deployments.some((d) => d.unitId === 'field-unit-1'), false);

  const unit2AfterDelete = battle.units.find((u) => u.id === 'field-unit-2');
  const dep2AfterDelete = battle.deployments.find((d) => d.unitId === 'field-unit-2');
  assert.equal(unit2AfterDelete.parentUnitId.state, 'unknown');
  assert.match(unit2AfterDelete.parentUnitId.reason, /引用单位已删除.*field-unit-1/);
  assert.equal(dep2AfterDelete.reserveForUnitId.state, 'unknown');
  assert.match(dep2AfterDelete.reserveForUnitId.reason, /引用单位已删除.*field-unit-1/);

  // 3. 撤销 (undo) 恢复整批：单位、部署与引用完整复原
  const undoResult = undoFieldBattle(battle);
  assert.equal(undoResult, true);
  assert.ok(battle.units.some((u) => u.id === 'field-unit-1'));
  assert.ok(battle.deployments.some((d) => d.unitId === 'field-unit-1'));

  const unit2Restored = battle.units.find((u) => u.id === 'field-unit-2');
  const dep2Restored = battle.deployments.find((d) => d.unitId === 'field-unit-2');
  assert.equal(unit2Restored.parentUnitId.state, 'known');
  assert.equal(unit2Restored.parentUnitId.value, 'field-unit-1');
  assert.equal(dep2Restored.reserveForUnitId.state, 'known');
  assert.equal(dep2Restored.reserveForUnitId.value, 'field-unit-1');

  // 4. 重做 (redo)
  const redoResult = redoFieldBattle(battle);
  assert.equal(redoResult, true);
  assert.equal(battle.units.some((u) => u.id === 'field-unit-1'), false);
});

test('视角：computeOutlineBounds 正确计算展示范围包围盒', () => {
  const battle = getSampleBattle();
  const bounds = computeOutlineBounds(battle.terrain.displayOutline, battle.bounds);
  assert.equal(bounds.minX, 0);
  assert.equal(bounds.minY, 0);
  assert.equal(bounds.maxX, 120);
  assert.equal(bounds.maxY, 100);
  assert.equal(bounds.width, 120);
  assert.equal(bounds.height, 100);

  // 空轮廓回退至 bounds
  const fallback = computeOutlineBounds([], { x: 10, y: 15, width: 200, height: 100 });
  assert.equal(fallback.minX, 10);
  assert.equal(fallback.minY, 15);
  assert.equal(fallback.width, 200);
  assert.equal(fallback.height, 100);
});

test('视角：saveView 返回 { scale, x, y } 且与恢复后一致', () => {
  const battle = getSampleBattle();
  delete battle.view;

  class FakeContainer {
    children = [];
    scale = { x: 1, y: 1, set(v) { this.x = v; this.y = v; } };
    position = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
    addChild(...items) { this.children.push(...items); }
    removeChild(item) { this.children = this.children.filter((c) => c !== item); }
    removeChildren() { this.children = []; }
    destroy() {}
  }

  const mockApp = {
    screen: { width: 1200, height: 800 },
    ticker: null,
    renderer: { on() {}, off() {} },
  };
  const mockHost = new FakeContainer();

  const handle = createFieldBattleScene({
    app: mockApp,
    host: mockHost,
    battle,
    root: null,
    onChange: () => {},
    onRequestClose: () => {},
  });

  const saved = handle.saveView();
  const viewport = mockHost.children[0];
  const bounds = computeOutlineBounds(battle.terrain.displayOutline, battle.bounds);
  assert.ok(saved.scale <= 32);
  assert.ok(Math.abs(viewport.center.x - (bounds.minX + bounds.maxX) / 2) < 1e-6);
  assert.ok(Math.abs(viewport.center.y - (bounds.minY + bounds.maxY) / 2) < 1e-6);

  handle.destroy();
  battle.view = saved;
  const restored = createFieldBattleScene({
    app: mockApp, host: mockHost, battle, root: null,
    onChange: () => {}, onRequestClose: () => {},
  });
  assert.deepEqual(restored.saveView(), saved);
  restored.destroy();
});

test('城市尺寸：初始 fit、32 倍恢复、缩放和 resize 均保持屏幕像素尺寸', () => {
  const battle = getSampleBattle();
  const originalTerrain = JSON.stringify(battle.terrain);
  const resizeListeners = new Map();
  const app = {
    screen: { width: 1200, height: 800 }, ticker: null,
    renderer: {
      on(name, fn) { resizeListeners.set(name, fn); },
      off(name) { resizeListeners.delete(name); },
    },
  };
  const host = { children: [], addChild(item) { this.children.push(item); } };
  const open = () => createFieldBattleScene({
    app, host, battle, root: null, onChange() {}, onRequestClose() {},
  });
  const check = viewport => {
    const cities = viewport.children[6].children;
    assert.equal(cities.length, battle.terrain.burgs.length);
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      const burg = battle.terrain.burgs[i];
      assert.equal(city.x, burg.x);
      assert.equal(city.y, burg.y);
      const [marker, label] = city.children;
      const scale = viewport.scale.x * city.scale.x;
      const radius = burg.tier === 'capital' ? 4 : burg.tier === 'provincial' ? 3 : 2;
      assert.ok(Math.abs(scale - 1) < 1e-6);
      assert.ok(Math.abs(label.style.fontSize * scale - 10) < 1e-6);
      assert.ok(Math.abs(label.y * scale - (radius + 2)) < 1e-6);
      assert.ok(Math.abs(marker.getLocalBounds().width * scale - (radius * 2 + 1)) < 1e-6);
    }
  };
  delete battle.view;
  let handle = open();
  check(host.children.at(-1));
  handle.destroy();
  battle.view = { scale: 32, x: 0, y: 0 };
  handle = open();
  const viewport = host.children.at(-1);
  assert.equal(viewport.scale.x, 32);
  check(viewport);
  for (const scale of [16, 8, 32]) {
    viewport.scale.set(scale);
    viewport.emit('zoomed', { viewport, type: 'wheel' });
    check(viewport);
  }
  app.screen = { width: 1600, height: 1000 };
  resizeListeners.get('resize')();
  check(viewport);
  handle.destroy();
  assert.equal(resizeListeners.size, 0);
  assert.equal(JSON.stringify(battle.terrain), originalTerrain);
});

test('快捷键判定与文本输入隔离：isTextInput 识别表单元素并放行', () => {
  class FakeElement extends EventTarget {
    constructor(tagName, isContentEditable = false) {
      super();
      this.tagName = tagName;
      this.isContentEditable = isContentEditable;
    }
  }

  const prevHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = FakeElement;

  try {
    const inputEl = new FakeElement('INPUT');
    const textareaEl = new FakeElement('TEXTAREA');
    const selectEl = new FakeElement('SELECT');
    const divEl = new FakeElement('DIV', false);
    const editableDiv = new FakeElement('DIV', true);

    // isTextInput 检查
    assert.equal(isTextInput(inputEl), true);
    assert.equal(isTextInput(textareaEl), true);
    assert.equal(isTextInput(selectEl), true);
    assert.equal(isTextInput(divEl), false);
    assert.equal(isTextInput(editableDiv), true);

    // 输入归属切换
    setInputOwner('map');
    assert.equal(getInputOwner(), 'map');
    setInputOwner('fieldbattle');
    assert.equal(getInputOwner(), 'fieldbattle');
  } finally {
    if (prevHTMLElement) {
      globalThis.HTMLElement = prevHTMLElement;
    } else {
      delete globalThis.HTMLElement;
    }
  }
});

test('勘误 2：未知位置兵牌不绘制，仅绘制已知位置单位', () => {
  const battle = getSampleBattle();
  assert.equal(battle.units.length, 2);
  const dep1 = battle.deployments.find((d) => d.unitId === 'field-unit-1');
  const dep2 = battle.deployments.find((d) => d.unitId === 'field-unit-2');
  assert.equal(dep1.placement.state, 'known');
  assert.equal(dep2.placement.state, 'unknown');

  class FakeContainer {
    children = [];
    scale = { x: 1, y: 1, set(v) { this.x = v; this.y = v; } };
    position = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
    addChild(...items) { this.children.push(...items); }
    removeChild(item) { this.children = this.children.filter((c) => c !== item); }
    removeChildren() { this.children = []; }
    destroy() {}
  }

  const mockApp = {
    screen: { width: 1200, height: 800 },
    ticker: null,
    renderer: { on() {}, off() {} },
  };
  const mockHost = new FakeContainer();

  const handle = createFieldBattleScene({
    app: mockApp,
    host: mockHost,
    battle,
    root: null,
    onChange: () => {},
    onRequestClose: () => {},
  });

  // viewport 是 mockHost 的第一个子元素
  const viewport = mockHost.children[0];
  // badgesContainer 是 viewport 的最后一个子容器 (index 8)
  const badgesContainer = viewport.children[8];
  // 仅 field-unit-1 被添加进 badgesContainer，field-unit-2 不绘制
  assert.equal(badgesContainer.children.length, 1);
  assert.equal(badgesContainer.children[0].label, 'field-unit-1');

  handle.destroy();
});

test('DOM 钩子常量与 FIELD_BATTLE_DOM 匹配', () => {
  assert.equal(FIELD_BATTLE_DOM.toolbar, '#field-battle-toolbar');
  assert.equal(FIELD_BATTLE_DOM.style, '#field-battle-style');
  assert.equal(FIELD_BATTLE_DOM.scale, '#field-battle-scale');
  assert.equal(FIELD_BATTLE_DOM.newUnit, '#field-battle-new-unit');
  assert.equal(FIELD_BATTLE_DOM.delete, '#field-battle-delete');
  assert.equal(FIELD_BATTLE_DOM.designer, '#garrison-custom-modal');
});

test('回归：HUD 对特殊部队名做文本转义无 HTML 注入；兵牌拖拽 pointercancel 不提交坐标变更', () => {
  const prevDocument = globalThis.document;
  const prevWindow = globalThis.window;

  const windowListeners = new Map();
  const dispatchWindow = (type, evt) => {
    for (const fn of [...(windowListeners.get(type) ?? [])]) fn(evt);
  };

  class FakeDomNode {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.id = '';
      this.className = '';
      this.style = {};
      this.children = [];
      this.childNodes = [];
      this._textContent = '';
      this._innerHTML = '';
      this.type = '';
      this.min = '';
      this.max = '';
      this.step = '';
      this.value = '';
      this.title = '';
      this.ownerDocument = null;
      this.forbidInnerHtml = false;
    }
    get textContent() {
      if (this.children.length > 0) return this.children.map((c) => c.textContent).join('');
      return this._textContent;
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
      this.children = [];
      this.childNodes = [];
    }
    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(v) {
      if (this.forbidInnerHtml) throw new Error('Forbidden innerHTML assignment on HUD text element');
      this._innerHTML = String(v);
      if (this.id === 'field-battle-hud') {
        const info = docMock.createElement('span');
        info.id = 'fb-hud-info';
        info.forbidInnerHtml = true;
        const zoom = docMock.createElement('span');
        zoom.id = 'fb-hud-zoom';
        zoom.forbidInnerHtml = true;
        this.append(info, zoom);
      }
    }
    appendChild(node) {
      this.children.push(node);
      this.childNodes.push(node);
      return node;
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }
    replaceChildren(...nodes) {
      this.children = nodes.filter((n) => n && n.tagName);
      this.childNodes = [...nodes];
      this._textContent = nodes.map((n) => n?.textContent ?? '').join('');
    }
    addEventListener(type, fn) {
      this._listeners ??= new Map();
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this._listeners?.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
    }
    dispatchEvent(type) {
      for (const fn of [...(this._listeners?.get(type) ?? [])]) fn({ target: this });
    }
    remove() {}
    querySelector(sel) {
      for (const child of this.children) {
        if (sel.startsWith('#') && child.id === sel.slice(1)) return child;
        if (sel.startsWith('.') && child.className.split(/\s+/).includes(sel.slice(1))) return child;
        const nested = child.querySelector?.(sel);
        if (nested) return nested;
      }
      return null;
    }
  }

  const docMock = {
    head: { appendChild() {} },
    getElementById: (id) => (id === 'field-battle-scene-styles' ? { id } : null),
    querySelector: () => null,
    createElement: (tag) => {
      const node = new FakeDomNode(tag);
      node.ownerDocument = docMock;
      return node;
    },
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  };

  globalThis.document = docMock;
  globalThis.window = {
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = windowListeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
  };

  class FakeContainer {
    children = [];
    scale = { x: 1, y: 1, set(v) { this.x = v; this.y = v; } };
    position = { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } };
    addChild(...items) { this.children.push(...items); }
    removeChild(item) { this.children = this.children.filter((c) => c !== item); }
    removeChildren() { this.children = []; }
    destroy() {}
  }

  const battle = getSampleBattle();
  const maliciousName = '<img src=x onerror=1> <第一军>';
  battle.units[0].unitName = { state: 'known', value: maliciousName, evidence: [] };
  const anchorBefore = structuredClone(battle.deployments[0].placement.value.anchor);
  const changes = [];
  const root = docMock.createElement('div');
  const mockApp = {
    screen: { width: 1200, height: 800 },
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) },
    ticker: null,
    renderer: { on() {}, off() {} },
  };
  const mockHost = new FakeContainer();

  let handle;
  try {
    setInputOwner('fieldbattle');
    handle = createFieldBattleScene({
      app: mockApp,
      host: mockHost,
      battle,
      root,
      onChange: (kind) => changes.push(kind),
      onRequestClose: () => {},
    });

    const viewport = mockHost.children[0];
    const badgesContainer = viewport.children[8];
    const badge = badgesContainer.children[0];
    assert.ok(badge);

    // 触发点击选中 + 开始拖拽
    badge.emit('pointerdown', { button: 0, global: { x: 10, y: 10 }, stopPropagation() {} });
    const infoEl = root.querySelector('#fb-hud-info');
    assert.ok(infoEl);
    assert.equal(infoEl.children.some((c) => c.tagName === 'IMG'), false);
    const bold = infoEl.children.find((c) => c.tagName === 'B');
    assert.ok(bold);
    assert.equal(bold.textContent, maliciousName);

    // 拖拽途中触发 pointercancel：恢复原位，不触发 units 提交，后续 pointerup 不误提交
    dispatchWindow('pointermove', { clientX: 80, clientY: 90 });
    dispatchWindow('pointercancel', { clientX: 80, clientY: 90 });
    dispatchWindow('pointerup', { clientX: 80, clientY: 90 });

    assert.deepEqual(battle.deployments[0].placement.value.anchor, anchorBefore);
    assert.equal(changes.includes('units'), false);

    // 战场窗口城名大小滑块与动态避让开关生效
    const cityScaleInput = root.querySelector('#field-battle-city-scale');
    const cityLodInput = root.querySelector('#field-battle-city-lod');
    const cityZoomInput = root.querySelector('#field-battle-city-zoom');
    assert.ok(cityScaleInput && cityLodInput && cityZoomInput);
    cityScaleInput.value = '1.8';
    cityScaleInput.dispatchEvent('input');
    const cities = viewport.children[6].children;
    assert.ok(cities.length > 0);
    assert.ok(Math.abs(cities[0].children[1].scale.x - 1.8) < 1e-6);
    cityLodInput.checked = false;
    cityLodInput.dispatchEvent('change');
    assert.equal(cities.every((c) => c.children[1].visible === true), true);
  } finally {
    handle?.destroy();
    resetFieldBattleHistory();
    if (prevDocument) globalThis.document = prevDocument;
    else delete globalThis.document;
    if (prevWindow) globalThis.window = prevWindow;
    else delete globalThis.window;
  }
});
