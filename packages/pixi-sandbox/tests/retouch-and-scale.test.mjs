import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'vite';

// Node.js 极简 DOM / 动画兼容垫片
if (typeof globalThis.requestAnimationFrame !== 'function') {
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      style: {},
      getContext: () => ({
        measureText: (t) => ({ width: String(t).length * 8 }),
        fillText: () => {},
        clearRect: () => {},
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray(0) }),
        setTransform: () => {},
        resetTransform: () => {},
      }),
    }),
    querySelector: () => null,
    getElementById: () => null,
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
});
after(() => server.close());

const { appStore } = await server.ssrLoadModule('/src/store.ts');
const {
  rgbToHex,
  sampleColorFromRgbaBuffer,
  createRetouchStroke,
  appendRetouchPoint,
  pushRetouchStroke,
  popRetouchStroke,
  undoRetouch,
  clearRetouchStrokes,
  canUndoRetouch,
} = await server.ssrLoadModule('/src/retouch-layer.ts');
const {
  computeKmPerPixel,
  formatMeasureDistance,
  measurePolyline,
} = await server.ssrLoadModule('/src/tactical-drawer.ts');
const { computeFieldImageCropRect } = await server.ssrLoadModule('/src/field-battle-scene.ts');

function makeStubImageMap() {
  return {
    source: {
      mapId: 'img-test',
      name: '测试图片地图',
      coords: null,
      baseKind: 'image',
      imageUrl: 'data:image/png;base64,iVBORw0KGgo=',
      overlayAlpha: 0.38,
      retouchStrokes: [],
    },
    width: 1200,
    height: 800,
    cells: {
      count: 0,
      polygons: [],
      p: [],
      c: [],
      h: new Uint8Array(0),
      state: new Uint16Array(0),
      province: new Uint16Array(0),
      religion: new Uint16Array(0),
      r: new Uint16Array(0),
      g: new Uint32Array(0),
      fl: new Uint16Array(0),
      biome: new Uint8Array(0),
      t: new Int8Array(0),
    },
    states: [],
    provinces: [],
    religions: [],
    burgs: [],
    rivers: [],
    biomes: [],
    lakes: [],
  };
}

test('像素颜色采样与十六进制转换：单点、3x3 邻域均值、越界与透明像素处理', () => {
  assert.equal(rgbToHex(0, 128, 255), '#0080ff');
  assert.equal(rgbToHex(-10, 260, 15.6), '#00ff10');

  // 构造 3x3 RGBA 图像：中心 (1,1) 为纯红，其余 8 个不透明像素为纯蓝 (0, 0, 255)
  const width = 3;
  const height = 3;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x === 1 && y === 1) {
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      } else {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 255;
        data[i + 3] = 255;
      }
    }
  }

  // 1x1 精确命中中心红点
  assert.equal(sampleColorFromRgbaBuffer(data, width, height, 1, 1, 1), '#ff0000');

  // 3x3 邻域均值：R = 255/9 ≈ 28 (0x1c), G = 0, B = (255*8)/9 ≈ 227 (0xe3)
  assert.equal(sampleColorFromRgbaBuffer(data, width, height, 1, 1, 3), '#1c00e3');

  // 角落 (0,0) 3x3 邻域只含 4 像素：3 蓝 + 1 红 => R = 64 (0x40), B = 191 (0xbf)
  assert.equal(sampleColorFromRgbaBuffer(data, width, height, 0, 0, 3), '#4000bf');

  // 越界坐标返回 null
  assert.equal(sampleColorFromRgbaBuffer(data, width, height, -1, 0, 3), null);
  assert.equal(sampleColorFromRgbaBuffer(data, width, height, 3, 1, 3), null);
  assert.equal(sampleColorFromRgbaBuffer(data, width, height, Number.NaN, 1, 3), null);

  // 透明像素应被不透明像素覆盖（不稀释颜色）
  const partialAlpha = new Uint8ClampedArray(2 * 2 * 4);
  // (0,0) 绿色不透明，其余全透明黑色
  partialAlpha[0] = 34;
  partialAlpha[1] = 170;
  partialAlpha[2] = 68;
  partialAlpha[3] = 255;
  assert.equal(sampleColorFromRgbaBuffer(partialAlpha, 2, 2, 0, 0, 3), '#22aa44');
});

test('修补笔划创建、追加去抖、压入、撤销与清空', () => {
  const map = makeStubImageMap();
  appStore.mapData = map;

  const s1 = createRetouchStroke('#d4c9a8', 18, [100, 200], 'stroke-1');
  assert.equal(s1.width, 36);
  assert.deepEqual(s1.points, [[100, 200]]);

  // 距离过近 (< minDist) 忽略
  assert.equal(appendRetouchPoint(s1, [100.5, 200.5], 2), false);
  assert.equal(s1.points.length, 1);

  // 距离足够追加
  assert.equal(appendRetouchPoint(s1, [110, 205], 2), true);
  assert.equal(s1.points.length, 2);

  pushRetouchStroke(map, s1);
  const s2 = createRetouchStroke('#88aa99', 10, [300, 400], 'stroke-2');
  pushRetouchStroke(map, s2);
  assert.equal(map.source.retouchStrokes.length, 2);
  assert.equal(canUndoRetouch(), true);

  // 按指定 ID 弹出与普通 undoRetouch
  let retouchEvents = 0;
  const onRetouch = () => {
    retouchEvents += 1;
  };
  appStore.on('retouch:changed', onRetouch);

  assert.equal(undoRetouch(), true);
  assert.equal(map.source.retouchStrokes.length, 1);
  assert.equal(map.source.retouchStrokes[0].id, 'stroke-1');
  assert.equal(retouchEvents, 1);

  // popRetouchStroke 按 ID 删除
  const popped = popRetouchStroke(map, 'stroke-1');
  assert.equal(popped?.id, 'stroke-1');
  assert.equal(map.source.retouchStrokes.length, 0);
  assert.equal(canUndoRetouch(), false);

  // 重新压入后清空
  pushRetouchStroke(map, s1);
  pushRetouchStroke(map, s2);
  assert.equal(clearRetouchStrokes(), true);
  assert.equal(map.source.retouchStrokes.length, 0);
  assert.equal(clearRetouchStrokes(), false);

  appStore.off('retouch:changed', onRetouch);
  appStore.mapData = null;
});

test('比例尺 kmPerPixel 换算与折线公里/像素测距格式化', () => {
  // 全图宽 1200km / 2400px = 0.5 km/px
  const kpp = computeKmPerPixel(1200, 2400);
  assert.equal(kpp, 0.5);
  assert.equal(computeKmPerPixel(0, 2400), undefined);
  assert.equal(computeKmPerPixel(-50, 2400), undefined);
  assert.equal(computeKmPerPixel(undefined, 2400), undefined);
  assert.equal(computeKmPerPixel(1200, 0), undefined);

  // 3-4-5 直角折线：像素长 = 30 + 40 = 70 px；带比例尺 0.5 km/px => 35.0 km
  const pts = [
    [0, 0],
    [30, 0],
    [30, 40],
  ];
  const withScale = measurePolyline(pts, kpp);
  assert.ok(Math.abs(withScale.pixels - 70) < 1e-6);
  assert.ok(Math.abs(withScale.km - 35) < 1e-6);
  assert.equal(withScale.text, '35.0 km');

  // 未设比例尺回退像素整数显示
  const noScale = measurePolyline(pts, undefined);
  assert.equal(noScale.km, null);
  assert.equal(noScale.text, '70 px');

  // 浮点精度一位小数四舍五入
  assert.equal(formatMeasureDistance(123.4, 0.8333333), '102.8 km');
  assert.equal(formatMeasureDistance(123.6), '124 px');
});

test('野战局部底图裁剪框映射：世界坐标框正确映射到高清原图像素 frame', () => {
  // 地图逻辑尺寸 1200x800，原图实际分辨率 2400x1600 (2x)
  const crop = computeFieldImageCropRect(
    { minX: 150, minY: 100, maxX: 450, maxY: 300 },
    1200,
    800,
    2400,
    1600
  );
  assert.deepEqual(crop, {
    worldX: 150,
    worldY: 100,
    worldWidth: 300,
    worldHeight: 200,
    srcX: 300,
    srcY: 200,
    srcWidth: 600,
    srcHeight: 400,
  });

  // 超出边界时自动钳制到合法范围
  const clamped = computeFieldImageCropRect(
    { minX: -50, minY: 700, maxX: 200, maxY: 950 },
    1200,
    800,
    2400,
    1600
  );
  assert.deepEqual(clamped, {
    worldX: 0,
    worldY: 700,
    worldWidth: 200,
    worldHeight: 100,
    srcX: 0,
    srcY: 1400,
    srcWidth: 400,
    srcHeight: 200,
  });

  // 非法尺寸返回 null
  assert.equal(
    computeFieldImageCropRect({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 800, 2400, 1600),
    null
  );
});
