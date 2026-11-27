import assert from 'node:assert/strict';
import { test, after, before } from 'node:test';
import { createServer } from 'vite';

// 搭建 Node.js 极简测试 DOM 环境
function setupMockDom() {
  let docRef = null;

  class MockElement {
    constructor(tagName = 'div') {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.style = {};
      this._innerHTML = '';
      this._textContent = '';
      this.value = '';
      this.hidden = false;
      this.disabled = false;
      this.children = [];
      this.options = [];
      this.listeners = new Map();
      this.dataset = {};
      this.classList = {
        add: () => {},
        remove: () => {},
        contains: () => false,
        toggle: () => false,
      };
      this.ownerDocument = docRef;
    }
    reportValidity() { return true; }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(val) {
      this._innerHTML = val;
      // 解析 id 属性与 option 选项
      const idMatches = [...val.matchAll(/id="([^"]+)"/g)];
      for (const m of idMatches) {
        const child = new MockElement();
        child.id = m[1];
        this.children.push(child);
      }
      const optMatches = [...val.matchAll(/<option\s+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)];
      if (optMatches.length > 0) {
        this.options = optMatches.map(m => new MockOption(m[2], m[1]));
        if (!this.value && this.options.length > 0) {
          this.value = this.options[0].value;
          this.options[0].selected = true;
        }
      }
    }
    get textContent() { return this._textContent; }
    set textContent(val) { this._textContent = val; }
    get selectedOptions() {
      return this.options.filter(o => o.selected);
    }
    setAttribute(name, val) { this[name] = val; }
    getAttribute(name) { return this[name] ?? null; }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    append(...children) {
      for (const c of children) this.appendChild(c);
    }
    remove() {}
    replaceChildren(...children) {
      this.children = [...children];
      this.options = children.filter(c => c instanceof MockOption || c.tagName === 'OPTION');
      if (this.options.length > 0 && !this.value) {
        this.value = this.options[0].value;
      }
    }
    querySelector(selector) {
      const idMatch = selector.match(/^#([\w-]+)/);
      if (idMatch) {
        const id = idMatch[1];
        const search = (node) => {
          if (node.id === id) return node;
          for (const c of node.children) {
            const found = search(c);
            if (found) return found;
          }
          return null;
        };
        const found = search(this);
        if (found) return found;
        const placeholder = new MockElement();
        placeholder.id = id;
        this.children.push(placeholder);
        return placeholder;
      }
      return null;
    }
    addEventListener(event, listener) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(listener);
    }
    dispatchEvent(event) {
      const list = this.listeners.get(event.type) || [];
      for (const fn of list) fn(event);
      return true;
    }
    click() {
      if (this.onclick) this.onclick();
      this.dispatchEvent({ type: 'click' });
    }
    getContext() {
      return {
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
        fillText: () => {},
        translate: () => {},
      };
    }
  }

  class MockOption extends MockElement {
    constructor(text = '', value = '', defaultSelected = false, selected = false) {
      super('option');
      this.text = text;
      this.value = value;
      this.selected = selected || defaultSelected;
    }
  }

  const rootBody = new MockElement('body');
  const headEl = new MockElement('head');
  const doc = {
    body: rootBody,
    head: headEl,
    createElement: (tag) => {
      const el = new MockElement(tag);
      el.ownerDocument = doc;
      return el;
    },
    getElementById: (id) => {
      const search = (node) => {
        if (node.id === id) return node;
        for (const c of node.children) {
          const found = search(c);
          if (found) return found;
        }
        return null;
      };
      return search(rootBody) || search(headEl);
    },
  };
  docRef = doc;
  rootBody.ownerDocument = doc;
  headEl.ownerDocument = doc;
  global.document = doc;
  globalThis.document = doc;
  global.Option = MockOption;
  globalThis.Option = MockOption;
  global.HTMLElement = MockElement;
  globalThis.HTMLElement = MockElement;
  global.HTMLCanvasElement = MockElement;
  globalThis.HTMLCanvasElement = MockElement;
  global.HTMLSelectElement = MockElement;
  globalThis.HTMLSelectElement = MockElement;
  global.HTMLInputElement = MockElement;
  globalThis.HTMLInputElement = MockElement;
  global.HTMLButtonElement = MockElement;
  globalThis.HTMLButtonElement = MockElement;
  const win = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
  };
  global.window = win;
  globalThis.window = win;
}

setupMockDom();

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
after(() => server.close());

const { appStore, garrisonContainer } = await server.ssrLoadModule('/src/store.ts');
const { initBattlePanel } = await server.ssrLoadModule('/src/battle-panel.ts');
const { openGarrisonCustomModal, initGarrisonPanel } = await server.ssrLoadModule('/src/garrison-panel.ts');
const { syntheticWorkspace } = await server.ssrLoadModule('/work-packages/BATTLE-1/P0/samples/river-valley.ts');
const { Container, Graphics } = await server.ssrLoadModule('pixi.js');

test('initBattlePanel: 面板成功挂载，并包含 8 档军标联动与编制匹配按钮', () => {
  // 加载初始合成战役
  appStore.mapId = syntheticWorkspace.mapId;
  appStore.garrisons = structuredClone(syntheticWorkspace.garrisons);
  appStore.battle = structuredClone(syntheticWorkspace.battle);

  const root = document.createElement('div');
  const canvas = document.createElement('canvas');
  const world = new Container();

  initBattlePanel(root, canvas, world);

  // 验证战役按钮存在
  const battleOpen = root.querySelector('#battle-open');
  assert.ok(battleOpen);

  // 验证战役面板包含 8 档军标与自定义兵牌控件
  const panel = root.querySelector('#battle-panel');
  assert.ok(panel);
  assert.ok(panel.querySelector('#battle-selected-echelon-info'));
  assert.ok(panel.querySelector('#battle-auto-echelon'));
  assert.ok(panel.querySelector('#battle-open-custom-badge'));
});

test('openGarrisonCustomModal: 成功弹出兵牌设计器，实时计算 8 档/7 级军标并校验输入', () => {
  appStore.garrisons = structuredClone(syntheticWorkspace.garrisons);
  const targetUnit = appStore.garrisons[0]; // d1, 原编制: 师, 人数: 200

  const modal = openGarrisonCustomModal({ unitId: targetUnit.id });
  assert.ok(modal);

  const previewBadge = modal.querySelector('#modal-echelon-preview-badge');
  assert.ok(previewBadge);

  // 初始：人数 200 对应 0-500，原编制师对应 [x]，建议编制为连
  assert.ok(previewBadge.textContent.includes('0-500'));
  assert.ok(previewBadge.textContent.includes('[x]'));
  assert.ok(previewBadge.textContent.includes('连 (Tier 1)'));

  // 点击“自动匹配编制”：echelon 变为推导的连，军标变为 [|]
  const autoEchelonBtn = modal.querySelector('#modal-auto-echelon-btn');
  const echelonInput = modal.querySelector('#modal-echelon-input');
  autoEchelonBtn.click();
  assert.equal(echelonInput.value, '连');
  assert.ok(previewBadge.textContent.includes('[|]'));

  // 模拟切换人数到 4800（团级 2000-6000）并自动匹配
  const troopsInput = modal.querySelector('#modal-troops-input');
  troopsInput.value = '4800';
  troopsInput.dispatchEvent({ type: 'input' });
  autoEchelonBtn.click();
  assert.equal(echelonInput.value, '团');
  assert.ok(previewBadge.textContent.includes('2000-6000'));
  assert.ok(previewBadge.textContent.includes('[|||]'));

  // 模拟切换人数到 15000（师级 6000-18000）并自动匹配
  troopsInput.value = '15000';
  troopsInput.dispatchEvent({ type: 'input' });
  autoEchelonBtn.click();
  assert.equal(echelonInput.value, '师');
  assert.ok(previewBadge.textContent.includes('6000-18000'));
  assert.ok(previewBadge.textContent.includes('[x]'));

  // 验证外框颜色更换控件与保存
  const colorInput = modal.querySelector('#modal-color-input');
  assert.ok(colorInput, '外框颜色输入框必须存在');
  assert.equal(colorInput.value, targetUnit.color || '#2563eb');

  // 修改颜色为帝国红
  colorInput.value = '#dc2626';
  colorInput.dispatchEvent({ type: 'input' });

  // 模拟保存
  let savedUnit = null;
  const saveBtn = modal.querySelector('#modal-save-btn');
  const modalWithCallback = openGarrisonCustomModal({
    unitId: targetUnit.id,
    onSaved: (u) => { savedUnit = u; }
  });
  const colorInput2 = modalWithCallback.querySelector('#modal-color-input');
  colorInput2.value = '#dc2626';
  colorInput2.dispatchEvent({ type: 'input' });
  const saveBtn2 = modalWithCallback.querySelector('#modal-save-btn');
  saveBtn2.click();

  modal.remove();
  modalWithCallback.remove();
});

test('initGarrisonPanel: 挂载快速设计器按钮', () => {
  const root = document.createElement('div');
  const handle = initGarrisonPanel(root);
  assert.ok(typeof handle.openModal === 'function');
  const btn = root.querySelector('#btn-open-garrison-custom');
  assert.ok(btn);
});

test('Bug #8 回归：战役面板打开后切外部工具再回战役面板绘制/切换/提交时恢复 battle-runtime 图层可见', async () => {
  appStore.mapId = syntheticWorkspace.mapId;
  appStore.garrisons = structuredClone(syntheticWorkspace.garrisons);
  appStore.battle = structuredClone(syntheticWorkspace.battle);

  const root = document.createElement('div');
  const canvas = document.createElement('canvas');
  const world = new Container();

  initBattlePanel(root, canvas, world);
  const battleLayer = world.children.find(c => c.label === 'battle-runtime');
  assert.ok(battleLayer, 'world 下应挂载 battle-runtime 图层');

  const panel = root.querySelector('#battle-panel');
  const openBtn = root.querySelector('#battle-open');
  openBtn.click();
  assert.equal(panel.hidden, false);
  assert.equal(battleLayer.visible, true);
  assert.equal(garrisonContainer.visible, false);
  assert.equal(appStore.interactionMode, 'battle-select');

  // 1. 切换外部工具（如漫游 pan）隐藏战役图层，但面板保持打开
  appStore.interactionMode = 'pan';
  appStore.emit('tactical-mode-change', 'pan');
  assert.equal(panel.hidden, false);
  assert.equal(battleLayer.visible, false);
  assert.equal(garrisonContainer.visible, true);

  // 2. 回到战役面板点击「新建战场」触发 startDraw：必须恢复 battleLayer.visible 并切回 battle-draw
  panel.querySelector('#battlefield-create').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(battleLayer.visible, true);
  assert.equal(garrisonContainer.visible, false);
  assert.equal(appStore.interactionMode, 'battle-draw');
  assert.ok(battleLayer.children.length > 0, '恢复可见后应同步渲染战役图层');

  // 3. 再次切外部测距工具隐藏图层，再通过切换战场下拉框查看战役：应恢复可见
  appStore.interactionMode = 'tactical-measure';
  appStore.emit('tactical-mode-change', 'tactical-measure');
  assert.equal(battleLayer.visible, false);
  assert.equal(garrisonContainer.visible, true);

  const bfSelect = panel.querySelector('#battlefield-select');
  bfSelect.dispatchEvent({ type: 'change' });
  assert.equal(battleLayer.visible, true);
  assert.equal(garrisonContainer.visible, false);
  assert.equal(appStore.interactionMode, 'battle-select');

  // 4. 再次切外部工具，再通过「取消标定」触发 commit：应恢复可见
  appStore.interactionMode = 'pan';
  appStore.emit('brush:changed', 'pan');
  assert.equal(battleLayer.visible, false);

  panel.querySelector('#battle-note').value = '回归测试来源说明';
  panel.querySelector('#battle-uncalibrate').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(battleLayer.visible, true);
  assert.equal(garrisonContainer.visible, false);
});
