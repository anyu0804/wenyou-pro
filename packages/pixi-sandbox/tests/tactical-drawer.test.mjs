import assert from 'node:assert/strict';
import { test, after, beforeEach } from 'node:test';
import { createServer } from 'vite';

// 准备 Node.js 极简 DOM / 动画兼容环境
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => {
    return setTimeout(cb, 0);
  };
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: (tag) => {
      if (tag === 'canvas') {
        return {
          getContext: () => ({
            measureText: (text) => ({ width: text.length * 8 }),
            fillText: () => {},
            clearRect: () => {},
            getImageData: () => ({ data: [] }),
            putImageData: () => {},
            setTransform: () => {},
            resetTransform: () => {},
            drawImage: () => {},
          }),
          width: 100,
          height: 100,
          style: {},
        };
      }
      return { style: {} };
    },
    querySelector: () => null,
  };
}

const windowListeners = new Map();
if (typeof globalThis.window === 'undefined') {
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
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});
after(() => server.close());

const { appStore, tacticalContainer } = await server.ssrLoadModule('/src/store.ts');
const {
  initTacticalDrawer,
  invScale,
  polylineLength,
  resample,
  freehandCenterline,
  sanitizePoints,
  distanceToItem,
  canUndoTactical,
  undoTactical,
} = await server.ssrLoadModule('/src/tactical-drawer.ts');

function createMockCanvas() {
  const listeners = new Map();
  return {
    style: {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type);
      if (list) {
        const idx = list.indexOf(fn);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
    dispatch: (type, event) => {
      const list = listeners.get(type) || [];
      for (const fn of list) fn(event);
    },
  };
}

function makePointerEvent(type, x, y, pointerId = 1, button = 0) {
  return {
    type,
    clientX: x,
    clientY: y,
    pointerId,
    button,
    preventDefault: () => {},
  };
}

const canvas = createMockCanvas();
initTacticalDrawer(canvas);

test('取消战术拖动恢复坐标且不留下撤销记录', () => {
  for (const cancel of ['Escape', 'contextmenu', 'pointercancel', 'blur', 'tactical-mode-change', 'theater:leaving']) {
    appStore.emit('map:loaded');
    tacticalContainer.worldTransform.a = 1;
    appStore.toMapCoords = (x, y) => [x, y];
    appStore.interactionMode = 'tactical-select';
    const item = { id: 'cancel-drag', type: 'frontline', points: [[0, 0], [100, 0]], width: 4, color: '#ff0000' };
    appStore.tacticalItems = [item];
    canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 0, 0));
    canvas.dispatch('pointermove', makePointerEvent('pointermove', 20, 10));
    assert.deepEqual(item.points, [[20, 10], [120, 10]]);
    if (cancel === 'Escape') {
      for (const listener of windowListeners.get('keydown')) {
        listener({ key: 'Escape', target: { tagName: 'BODY', isContentEditable: false }, preventDefault() {} });
      }
    } else if (cancel === 'blur') {
      for (const listener of windowListeners.get('blur')) listener();
    } else if (cancel === 'contextmenu' || cancel === 'pointercancel') {
      canvas.dispatch(cancel, makePointerEvent(cancel, 20, 10));
    } else {
      appStore.emit(cancel);
    }
    assert.deepEqual(item.points, [[0, 0], [100, 0]], cancel);
    assert.equal(canUndoTactical(), false, cancel);
  }
});

test('确认战术拖动后可一次撤销回原坐标', () => {
  appStore.emit('map:loaded');
  tacticalContainer.worldTransform.a = 1;
  appStore.toMapCoords = (x, y) => [x, y];
  appStore.interactionMode = 'tactical-select';
  appStore.tacticalItems = [{ id: 'commit-drag', type: 'frontline', points: [[0, 0], [100, 0]], width: 4, color: '#ff0000' }];
  canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 0, 0));
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 20, 10));
  canvas.dispatch('pointerup', makePointerEvent('pointerup', 20, 10));
  assert.deepEqual(appStore.tacticalItems[0].points, [[20, 10], [120, 10]]);
  assert.equal(canUndoTactical(), true);
  undoTactical();
  assert.deepEqual(appStore.tacticalItems[0].points, [[0, 0], [100, 0]]);
  assert.equal(canUndoTactical(), false);
});

beforeEach(() => {
  appStore.tacticalItems = [];
  appStore.selectedTacticalId = null;
  appStore.interactionMode = 'tactical-frontline';
  appStore.tacticalWidth = 4;
  appStore.tacticalColor = '#ef4444';
  appStore.tacticalFlip = false;
  appStore.tacticalToothStyle = 'sawtooth';
  appStore.tacticalLabel = '';
});

test('包 F: 战线高倍缩放 (scale=1, scale=8, scale=32) 屏幕拖动 15px 一次成线且不丢失', () => {
  const scales = [1, 8, 32];

  for (const scale of scales) {
    appStore.tacticalItems = [];
    tacticalContainer.worldTransform.a = scale;
    // 地图坐标 = 屏幕坐标 / scale
    appStore.toMapCoords = (x, y) => [x / scale, y / scale];

    const currentInv = invScale();
    assert.ok(Math.abs(currentInv - 1 / scale) < 1e-6);

    // 屏幕拖动 15px：起点 (100, 100)，终点 (115, 100)
    canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 100, 100));
    // 中途移动一个采样点 108, 100 (移动 8px)
    canvas.dispatch('pointermove', makePointerEvent('pointermove', 108, 100));
    // 松手 115, 100 (累计移动 15px)
    canvas.dispatch('pointerup', makePointerEvent('pointerup', 115, 100));

    assert.equal(
      appStore.tacticalItems.length,
      1,
      `在 scale=${scale} 下，屏幕拖动 15px 应该一次成功生成 1 条战线`
    );

    const line = appStore.tacticalItems[0];
    assert.equal(line.type, 'frontline');
    assert.ok(line.points.length >= 2, '战线至少包含 2 个点');

    const expectedMapDist = 15 / scale;
    const actualLen = polylineLength(line.points);
    assert.ok(
      Math.abs(actualLen - expectedMapDist) < 1e-3,
      `scale=${scale} 下，战线长度应与屏幕 15px 对应的地图距离一致（期望: ${expectedMapDist}, 实测: ${actualLen}）`
    );
  }
});

test('包 F: 屏幕拖拽门禁验证（小于 8px 丢弃，大于等于 8px 一次成线）', () => {
  const scale = 16;
  tacticalContainer.worldTransform.a = scale;
  appStore.toMapCoords = (x, y) => [x / scale, y / scale];

  // 1. 拖动 5px (< 8px 门禁) 应该被丢弃
  appStore.tacticalItems = [];
  canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 200, 200));
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 203, 200));
  canvas.dispatch('pointerup', makePointerEvent('pointerup', 205, 200));
  assert.equal(appStore.tacticalItems.length, 0, '屏幕拖动 5px 未达 8px 门禁，应不产生战线');

  // 2. 拖动 9px (>= 8px 门禁) 应该一次成线
  appStore.tacticalItems = [];
  canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 200, 200));
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 205, 200));
  canvas.dispatch('pointerup', makePointerEvent('pointerup', 209, 200));
  assert.equal(appStore.tacticalItems.length, 1, '屏幕拖动 9px 满足门禁，应一次成功生成战线');
});

test('包 F: 松手时尾点补齐机制', () => {
  const scale = 8;
  tacticalContainer.worldTransform.a = scale;
  appStore.toMapCoords = (x, y) => [x / scale, y / scale];

  // 起点 (50, 50)，直接松手在 (65, 50)，中间无 move 事件
  appStore.tacticalItems = [];
  canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 50, 50));
  canvas.dispatch('pointerup', makePointerEvent('pointerup', 65, 50));

  assert.equal(appStore.tacticalItems.length, 1, '无 move 但松手达到 15px 时应自动补齐尾点成线');
  const pts = appStore.tacticalItems[0].points;
  assert.equal(pts.length, 2);
  assert.deepEqual(pts[0], [50 / 8, 50 / 8]);
  assert.deepEqual(pts[1], [65 / 8, 50 / 8]);
});

test('包 F: 战线选择命中阈值与锯齿覆盖', () => {
  appStore.interactionMode = 'tactical-select';
  const scale = 4;
  tacticalContainer.worldTransform.a = scale;
  const inv = 1 / scale;

  const item = {
    id: 'test-line-1',
    type: 'frontline',
    points: [[0, 0], [100, 0]],
    width: 4,
    color: '#ff0000',
  };
  appStore.tacticalItems = [item];

  // 判定距离：Math.max(12, item.width * 3.0) * inv = Math.max(12, 12) * 0.25 = 3
  // 在地图坐标系中，y = 2.5 距离线为 2.5 <= 3，应该能命中
  const d1 = distanceToItem([50, 2.5], item);
  assert.ok(d1 <= Math.max(12, item.width * 3.0) * inv, '距离在命中阈值内应被选中');

  // y = 3.5 距离为 3.5 > 3，应超出阈值
  const d2 = distanceToItem([50, 3.5], item);
  assert.ok(d2 > Math.max(12, item.width * 3.0) * inv, '距离超出命中阈值不应被选中');
});

test('包 F: 拖拽死区屏幕像素化 (1.2 * invScale())', () => {
  appStore.interactionMode = 'tactical-select';
  const scale = 8;
  tacticalContainer.worldTransform.a = scale;
  const inv = 1 / scale;
  appStore.toMapCoords = (x, y) => [x / scale, y / scale];

  const item = {
    id: 'drag-test-1',
    type: 'frontline',
    points: [[0, 0], [10, 0]],
    width: 4,
    color: '#ff0000',
  };
  appStore.tacticalItems = [item];

  // 1. 在 (0, 0) 按下，选中图形并准备拖拽
  canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 0, 0));
  assert.equal(appStore.selectedTacticalId, 'drag-test-1');

  // 2. 移动 0.8px 屏幕距离 (< 1.2px 死区)，对应地图位移 0.1
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 0.8, 0));
  // 点位置不应该改变
  assert.deepEqual(item.points, [[0, 0], [10, 0]], '屏幕微动 0.8px 应在死区内被忽略');

  // 3. 移动 3.0px 屏幕距离 (> 1.2px 死区)，对应地图位移 3/8 = 0.375
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 3.0, 0));
  assert.ok(Math.abs(item.points[0][0] - 0.375) < 1e-4, '屏幕移动 3px 超过死区后应平移点位');

  // 松手
  canvas.dispatch('pointerup', makePointerEvent('pointerup', 3.0, 0));
});

test('包 F: 采样距离随缩放自适应 (MIN_POINT_DISTANCE * invScale())', () => {
  const scale = 10;
  tacticalContainer.worldTransform.a = scale;
  const inv = 1 / scale;
  appStore.toMapCoords = (x, y) => [x / scale, y / scale];

  appStore.tacticalItems = [];
  // 起点 (100, 100)
  canvas.dispatch('pointerdown', makePointerEvent('pointerdown', 100, 100));

  // 移动 1.5px 屏幕距离：对应地图距离 0.15。
  // MIN_POINT_DISTANCE = 2.4，在 scale=10 下门禁是 2.4 * 0.1 = 0.24 地图距离 (即 2.4px 屏幕)。
  // 1.5px 未达到 2.4px 采样门禁，不应追加点
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 101.5, 100));

  // 移动到 103px (屏幕位移 3px > 2.4px)，达到采样门禁，应采集点
  canvas.dispatch('pointermove', makePointerEvent('pointermove', 103.0, 100));

  // 移动到 112px 松手 (总屏幕位移 12px >= 8px 门禁)
  canvas.dispatch('pointerup', makePointerEvent('pointerup', 112.0, 100));

  assert.equal(appStore.tacticalItems.length, 1);
  const pts = appStore.tacticalItems[0].points;
  // 包含起点、中途采集点 (103/10)、松手补齐点 (112/10)
  assert.ok(pts.length >= 3, `应该包含起点、中间采样点与终点（实测: ${pts.length} 个点）`);
});

test('包 F: 重采样与平滑中心线像素化适应', () => {
  const scale = 32;
  const inv = 1 / scale;
  // 模拟在高倍缩放下的 15 像素短战线
  const rawPoints = [
    [0, 0],
    [5 * inv, 0],
    [10 * inv, 0],
    [15 * inv, 0],
  ];

  // 平滑中心线
  const smoothed = freehandCenterline(rawPoints, Math.max(4, 4 * 2) * inv);
  assert.ok(smoothed.length >= 2, '高倍缩放下平滑中心线不被吞点');
  assert.deepEqual(smoothed[0], rawPoints[0], '首点保持一致');
  assert.deepEqual(smoothed[smoothed.length - 1], rawPoints[rawPoints.length - 1], '末点保持一致');

  // 重采样
  const step = Math.max(3, Math.min(9, 4 * 0.9)) * inv;
  const resampled = resample(smoothed, step);
  assert.ok(resampled.length >= 2, '重采样后保留足够点');
  const len = polylineLength(resampled);
  assert.ok(Math.abs(len - 15 * inv) < 1e-4, '总长度保持一致');
});

test('回归：高倍缩放 (scale=16/32) 下虚线箭头有实际绘制指令且选中高亮按屏幕宽度不双重缩放', () => {
  for (const scale of [16, 32]) {
    const inv = 1 / scale;
    tacticalContainer.worldTransform.a = scale;
    appStore.toMapCoords = (x, y) => [x / scale, y / scale];
    appStore.interactionMode = 'tactical-select';
    appStore.tacticalItems = [{
      id: `dashed-${scale}`,
      type: 'arrow',
      arrowStyle: 'dashed',
      points: [[0, 0], [30 * inv, 0]],
      width: 4,
      color: '#ef4444',
    }];
    appStore.selectedTacticalId = null;
    appStore.emit('tactical-change');

    const itemsLayer = tacticalContainer.children[0];
    const collectGfx = (node, out = []) => {
      if (node.context?.instructions?.length > 0) out.push(node);
      for (const child of node.children ?? []) collectGfx(child, out);
      return out;
    };
    const baseGfx = collectGfx(itemsLayer);
    assert.equal(baseGfx.length, 1);
    const baseActions = baseGfx[0].context.instructions.map((i) => i.action);
    assert.equal(baseActions.includes('fill'), true, `scale=${scale} 虚线箭头应产出 fill`);
    assert.equal(baseActions.includes('stroke'), true, `scale=${scale} 虚线箭头应产出 stroke`);
    const baseHeight = baseGfx[0].getLocalBounds().height;
    assert.ok(baseHeight > 0);

    appStore.selectedTacticalId = `dashed-${scale}`;
    appStore.emit('tactical-selection-change', appStore.selectedTacticalId);
    const selectedGfx = collectGfx(itemsLayer);
    assert.ok(selectedGfx.length >= 2, `scale=${scale} 选中后应新增高亮图元`);
    const highlightHeight = selectedGfx[0].getLocalBounds().height;
    // 未高亮 width=4 对应 +6 屏幕像素加宽后高度应显著大于 baseHeight（比例 > 1.3，避免 6*inv 缩没）
    assert.ok(
      highlightHeight > baseHeight * 1.3,
      `scale=${scale} 高亮高度 (${highlightHeight}) 应显著高于原图元 (${baseHeight})`,
    );
  }
});


