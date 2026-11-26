import { describe, expect, it } from "vitest";
import {
	clampScale,
	compareImageAspects,
	DEFAULT_VIEWPORT,
	MAX_SCALE,
	MIN_SCALE,
	toggleDoubleClickZoom,
	WHEEL_ZOOM_STEP,
	zoomAtPoint,
	zoomCentered,
} from "./atlas-viewport";

describe("atlas-viewport", () => {
	it("clampScale 将缩放比限制在 50%~500% 且保留两位小数", () => {
		expect(clampScale(0.1)).toBe(MIN_SCALE);
		expect(clampScale(9.9)).toBe(MAX_SCALE);
		expect(clampScale(1.236)).toBe(1.24);
		expect(clampScale(Number.NaN)).toBe(1);
	});

	it("zoomAtPoint 以鼠标指针为锚点缩放，缩放前后指针下图像点保持不变", () => {
		const rect = { left: 100, top: 50, width: 800, height: 600 };
		const point = { clientX: 700, clientY: 200 }; // 相对中心 (+200, -150)
		const start = { scale: 1.5, x: 40, y: -25 };

		const zoomedIn = zoomAtPoint(start, WHEEL_ZOOM_STEP, point, rect);
		expect(zoomedIn.scale).toBeGreaterThan(start.scale);

		const cx = point.clientX - rect.left - rect.width / 2;
		const cy = point.clientY - rect.top - rect.height / 2;
		const contentXBefore = (cx - start.x) / start.scale;
		const contentYBefore = (cy - start.y) / start.scale;
		const contentXAfter = (cx - zoomedIn.x) / zoomedIn.scale;
		const contentYAfter = (cy - zoomedIn.y) / zoomedIn.scale;

		expect(contentXAfter).toBeCloseTo(contentXBefore, 6);
		expect(contentYAfter).toBeCloseTo(contentYBefore, 6);

		const zoomedOut = zoomAtPoint(zoomedIn, 1 / WHEEL_ZOOM_STEP, point, rect);
		expect((cx - zoomedOut.x) / zoomedOut.scale).toBeCloseTo(contentXBefore, 6);
		expect((cy - zoomedOut.y) / zoomedOut.scale).toBeCloseTo(contentYBefore, 6);
	});

	it("zoomAtPoint 达到上下限边界时直接返回原视口不漂移", () => {
		const rect = { left: 0, top: 0, width: 400, height: 300 };
		const atMax = { scale: MAX_SCALE, x: 12, y: -8 };
		expect(zoomAtPoint(atMax, 1.5, { clientX: 300, clientY: 200 }, rect)).toBe(atMax);

		const atMin = { scale: MIN_SCALE, x: -5, y: 10 };
		expect(zoomAtPoint(atMin, 0.5, { clientX: 50, clientY: 50 }, rect)).toBe(atMin);
	});

	it("zoomCentered 按缩放倍率等比调整偏移量，防止工具栏缩放视图漂移", () => {
		const next = zoomCentered({ scale: 1, x: 50, y: -30 }, 2);
		expect(next).toEqual({ scale: 2, x: 100, y: -60 });
	});

	it("toggleDoubleClickZoom 在 100% 复位与 200% 放大间切换", () => {
		expect(toggleDoubleClickZoom(DEFAULT_VIEWPORT)).toEqual({ scale: 2, x: 0, y: 0 });
		expect(toggleDoubleClickZoom({ scale: 2, x: 30, y: -20 })).toEqual(DEFAULT_VIEWPORT);
	});

	it("compareImageAspects 区分同比例不同分辨率与真实纵横比偏差", () => {
		const sameAspect = compareImageAspects({ width: 1600, height: 900 }, { width: 3200, height: 1800 });
		expect(sameAspect).not.toBeNull();
		expect(sameAspect?.mismatched).toBe(false);
		expect(sameAspect?.diffRatio).toBeCloseTo(0, 6);

		const mismatched = compareImageAspects({ width: 1600, height: 900 }, { width: 1600, height: 1000 });
		expect(mismatched?.mismatched).toBe(true);
		expect(mismatched?.leftText).toBe("1600×900");
		expect(mismatched?.rightText).toBe("1600×1000");

		expect(compareImageAspects(null, { width: 100, height: 100 })).toBeNull();
		expect(compareImageAspects({ width: 0, height: 100 }, { width: 100, height: 100 })).toBeNull();
	});
});
