/** 高清地图视口缩放与双图比例检测纯函数（单图 / 双屏 / 卷帘共用） */

export interface ViewportTransform {
	scale: number;
	x: number;
	y: number;
}

export interface ViewportRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface ImageDimensions {
	width: number;
	height: number;
}

export interface AspectComparison {
	mismatched: boolean;
	diffRatio: number;
	leftText: string;
	rightText: string;
}

export const DEFAULT_VIEWPORT: ViewportTransform = { scale: 1, x: 0, y: 0 };
export const MIN_SCALE = 0.5;
export const MAX_SCALE = 5;
export const WHEEL_ZOOM_STEP = 1.14;
export const ASPECT_MISMATCH_THRESHOLD = 0.01;

export function clampScale(scale: number): number {
	if (!Number.isFinite(scale)) return 1;
	return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) * 100) / 100;
}

/**
 * 以鼠标在容器中心的相对偏移为锚点平滑缩放：
 * 缩放前后指针指向的图像内容点在屏幕上的位置保持不动。
 */
export function zoomAtPoint(
	cur: ViewportTransform,
	factor: number,
	point: { clientX: number; clientY: number },
	rect: ViewportRect,
): ViewportTransform {
	const nextScale = clampScale(cur.scale * factor);
	if (nextScale === cur.scale) return cur;
	const cx = point.clientX - rect.left - rect.width / 2;
	const cy = point.clientY - rect.top - rect.height / 2;
	const ratio = nextScale / cur.scale;
	return {
		scale: nextScale,
		x: cx - (cx - cur.x) * ratio,
		y: cy - (cy - cur.y) * ratio,
	};
}

/** 工具栏按钮以视口中心为锚点缩放（同步等比缩放平移量，避免视图偏移） */
export function zoomCentered(cur: ViewportTransform, factor: number): ViewportTransform {
	const nextScale = clampScale(cur.scale * factor);
	if (nextScale === cur.scale) return cur;
	const ratio = nextScale / cur.scale;
	return {
		scale: nextScale,
		x: cur.x * ratio,
		y: cur.y * ratio,
	};
}

/** 双击在 100% 复位与 200% 放大间切换 */
export function toggleDoubleClickZoom(cur: ViewportTransform): ViewportTransform {
	return cur.scale > 1.1 ? DEFAULT_VIEWPORT : { scale: 2, x: 0, y: 0 };
}

/** 检测左右两图自然长宽比是否存在超过阈值的差异（默认 1%） */
export function compareImageAspects(
	left: ImageDimensions | null,
	right: ImageDimensions | null,
	threshold = ASPECT_MISMATCH_THRESHOLD,
): AspectComparison | null {
	if (!left || !right) return null;
	if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) return null;
	const leftRatio = left.width / left.height;
	const rightRatio = right.width / right.height;
	const maxRatio = Math.max(leftRatio, rightRatio);
	const diffRatio = maxRatio > 0 ? Math.abs(leftRatio - rightRatio) / maxRatio : 0;
	return {
		mismatched: diffRatio > threshold,
		diffRatio,
		leftText: `${left.width}×${left.height}`,
		rightText: `${right.width}×${right.height}`,
	};
}
