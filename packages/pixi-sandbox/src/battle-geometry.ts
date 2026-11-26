import { rayCrossesRing } from './planar-geometry';
import type {
  BattleLine, BattleMultiPolygon, BattlePoint, BattlePolygon, BattleRing,
} from './battle-contract';
import { diff, intersection } from 'martinez-polygon-clipping';

/** 平面坐标比较容差；不是地理精度，也不用于把未知值当已知。 */
export const GEOMETRY_EPSILON = 1e-9;

function cross(a: BattlePoint, b: BattlePoint, c: BattlePoint): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function pointDistance(a: BattlePoint, b: BattlePoint): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function samePoint(a: BattlePoint, b: BattlePoint): boolean {
  return Math.abs(a[0] - b[0]) <= GEOMETRY_EPSILON && Math.abs(a[1] - b[1]) <= GEOMETRY_EPSILON;
}

function pointOnSegment(point: BattlePoint, a: BattlePoint, b: BattlePoint): boolean {
  if (Math.abs(cross(a, b, point)) > GEOMETRY_EPSILON) return false;
  return point[0] >= Math.min(a[0], b[0]) - GEOMETRY_EPSILON
    && point[0] <= Math.max(a[0], b[0]) + GEOMETRY_EPSILON
    && point[1] >= Math.min(a[1], b[1]) - GEOMETRY_EPSILON
    && point[1] <= Math.max(a[1], b[1]) + GEOMETRY_EPSILON;
}

function segmentsProperlyIntersect(
  a: BattlePoint, b: BattlePoint, c: BattlePoint, d: BattlePoint,
): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > GEOMETRY_EPSILON && d2 < -GEOMETRY_EPSILON)
    || (d1 < -GEOMETRY_EPSILON && d2 > GEOMETRY_EPSILON))
    && ((d3 > GEOMETRY_EPSILON && d4 < -GEOMETRY_EPSILON)
      || (d3 < -GEOMETRY_EPSILON && d4 > GEOMETRY_EPSILON));
}

function segmentsIntersect(
  a: BattlePoint, b: BattlePoint, c: BattlePoint, d: BattlePoint,
): boolean {
  if (segmentsProperlyIntersect(a, b, c, d)) return true;
  if (Math.abs(cross(a, b, c)) <= GEOMETRY_EPSILON && pointOnSegment(c, a, b)) return true;
  if (Math.abs(cross(a, b, d)) <= GEOMETRY_EPSILON && pointOnSegment(d, a, b)) return true;
  if (Math.abs(cross(c, d, a)) <= GEOMETRY_EPSILON && pointOnSegment(a, c, d)) return true;
  if (Math.abs(cross(c, d, b)) <= GEOMETRY_EPSILON && pointOnSegment(b, c, d)) return true;
  return false;
}

function segmentsOverlapPositively(
  a: BattlePoint, b: BattlePoint, c: BattlePoint, d: BattlePoint,
): boolean {
  const collinear = (Math.abs(cross(a, b, c)) <= GEOMETRY_EPSILON
    && Math.abs(cross(a, b, d)) <= GEOMETRY_EPSILON)
    || (Math.abs(cross(c, d, a)) <= GEOMETRY_EPSILON
      && Math.abs(cross(c, d, b)) <= GEOMETRY_EPSILON);
  if (!collinear) return false;
  const axis = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
  const aMin = Math.min(a[axis], b[axis]);
  const aMax = Math.max(a[axis], b[axis]);
  const cMin = Math.min(c[axis], d[axis]);
  const cMax = Math.max(c[axis], d[axis]);
  return Math.min(aMax, cMax) - Math.max(aMin, cMin) > GEOMETRY_EPSILON;
}

/** 平面鞋带面积；屏幕坐标 y 向下时，顺时针外环为正。 */
export function ringSignedArea(ring: BattleRing): number {
  const vertices = ring.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < vertices.length; i++) {
    const [x1, y1] = vertices[i];
    const [x2, y2] = vertices[(i + 1) % vertices.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function ringIsClockwise(ring: BattleRing): boolean {
  return ringSignedArea(ring) > 0;
}

/** 输出外环正向、孔反向；调用方保证输入是闭合环。 */
export function normalizeRing(ring: BattleRing): BattleRing {
  if (ringSignedArea(ring) >= 0) return ring;
  return closeRing(ring.slice(0, -1).reverse());
}

export function ringIsClosed(ring: BattleRing): boolean {
  return ring.length >= 4 && samePoint(ring[0], ring[ring.length - 1]);
}

export function ringIsSimple(ring: BattleRing): boolean {
  if (!ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return false;
  if (!ringIsClosed(ring)) return false;
  const vertices = ring.slice(0, -1);
  if (vertices.length < 3) return false;
  if (Math.abs(ringSignedArea(ring)) <= GEOMETRY_EPSILON) return false;
  for (let i = 0; i < vertices.length; i++) {
    if (samePoint(vertices[i], vertices[(i + 1) % vertices.length])) return false;
  }
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    for (let j = i + 1; j < vertices.length; j++) {
      const c = vertices[j];
      const d = vertices[(j + 1) % vertices.length];
      if (segmentsOverlapPositively(a, b, c, d)) return false;
      if (segmentsIntersect(a, b, c, d)) {
        const adjacent = j === i + 1 || (i === 0 && j === vertices.length - 1);
        if (!adjacent) return false;
      }
    }
  }
  return true;
}

export function ringIsValid(ring: BattleRing): boolean {
  return ringIsClosed(ring) && ringIsSimple(ring);
}

/** includeBoundary=false 时，落在环边上的点按“不在环内”处理。 */
export function pointInRing(
  point: BattlePoint, ring: BattleRing, includeBoundary: boolean,
): boolean {
  const vertices = ring.slice(0, -1);
  for (let i = 0; i < vertices.length; i++) {
    if (pointOnSegment(point, vertices[i], vertices[(i + 1) % vertices.length])) {
      return includeBoundary;
    }
  }
  return rayCrossesRing(point[0], point[1], vertices);
}

/** 外环边界算允许；孔边界也算允许，孔内部不算。 */
export function pointInPolygon(point: BattlePoint, polygon: BattlePolygon): boolean {
  if (!pointInRing(point, polygon[0], true)) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(point, polygon[i], false)) return false;
  }
  return true;
}

export function pointInMultiPolygon(point: BattlePoint, multi: BattleMultiPolygon): boolean {
  return multi.some((polygon) => pointInPolygon(point, polygon));
}

export function polylineLength(points: BattlePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += pointDistance(points[i - 1], points[i]);
  return total;
}

export function pointAtPolylineDistance(points: BattlePoint[], distanceAlong: number): BattlePoint {
  let remaining = Math.max(0, distanceAlong);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segmentLength = pointDistance(a, b);
    if (segmentLength === 0) continue;
    if (remaining <= segmentLength) {
      const t = remaining / segmentLength;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= segmentLength;
  }
  return points[points.length - 1];
}

/** 按弧长取折线段；超出折线总长返回 null，不缩水成剩余部分。 */
export function slicePolyline(
  points: BattlePoint[], start: number, length: number,
): BattleLine | null {
  if (length <= 0 || start < 0) return null;
  const result: BattlePoint[] = [];
  let traversed = 0;
  let remaining = length;
  let started = false;
  const push = (point: BattlePoint) => {
    const last = result[result.length - 1];
    if (last === undefined || !samePoint(last, point)) result.push(point);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segmentLength = pointDistance(a, b);
    if (segmentLength === 0) continue;
    const segmentStart = traversed;
    const segmentEnd = traversed + segmentLength;
    traversed = segmentEnd;
    if (segmentEnd <= start) continue;
    if (!started) {
      const offset = Math.max(0, start - segmentStart);
      const t = offset / segmentLength;
      push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      started = true;
    }
    const available = segmentEnd - Math.max(start, segmentStart);
    if (available + GEOMETRY_EPSILON >= remaining) {
      const t = (Math.max(start, segmentStart) - segmentStart + Math.min(remaining, available))
        / segmentLength;
      push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      return result.length >= 2 ? result as BattleLine : null;
    }
    remaining -= available;
    push(b);
  }
  return null;
}

/** 0 度向上、90 度向右、顺时针；返回单位向量。 */
export function facingDirection(facingDegrees: number): BattlePoint {
  const radians = (facingDegrees * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  return [
    Math.abs(sin) < 1e-12 ? 0 : sin,
    Math.abs(cos) < 1e-12 ? 0 : -cos,
  ];
}

/** 纵深方向与朝向相反。 */
export function depthVectorForFacing(facingDegrees: number): BattlePoint {
  const [x, y] = facingDirection(facingDegrees);
  return [x === 0 ? 0 : -x, y === 0 ? 0 : -y];
}

export function offsetPoints(points: BattlePoint[], offset: BattlePoint): BattlePoint[] {
  return points.map(([x, y]) => [x + offset[0], y + offset[1]]);
}

export function closeRing(points: BattlePoint[]): BattleRing {
  const first = points[0];
  const last = points[points.length - 1];
  const ring = samePoint(first, last) ? points : [...points, first];
  return ring as BattleRing;
}

/** 正面折线沿纵深方向平移后的单块占地面；出口外环规范为正向。 */
export function buildFootprintRing(
  front: BattleLine, depthMapUnits: number, facingDegrees: number,
): BattleRing {
  const [dx, dy] = depthVectorForFacing(facingDegrees);
  const offset: BattlePoint = [dx * depthMapUnits, dy * depthMapUnits];
  const back = offsetPoints([...front].reverse(), offset);
  return normalizeRing(closeRing([...front, ...back]));
}

function multiPolygonArea(multi: readonly number[][][][]): number {
  let total = 0;
  for (const poly of multi) {
    if (poly.length === 0) continue;
    let area = Math.abs(ringSignedArea(closeRing(poly[0] as BattlePoint[])));
    for (let i = 1; i < poly.length; i++) {
      area -= Math.abs(ringSignedArea(closeRing(poly[i] as BattlePoint[])));
    }
    total += Math.max(0, area);
  }
  return total;
}

function strictlyInsidePolygon(point: BattlePoint, polygon: BattlePolygon): boolean {
  if (!pointInRing(point, polygon[0], false)) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(point, polygon[i], true)) return false;
  }
  return true;
}

function pointInTriangle(p: BattlePoint, a: BattlePoint, b: BattlePoint, c: BattlePoint): boolean {
  const c1 = cross(a, b, p);
  const c2 = cross(b, c, p);
  const c3 = cross(c, a, p);
  const hasNeg = c1 < -GEOMETRY_EPSILON || c2 < -GEOMETRY_EPSILON || c3 < -GEOMETRY_EPSILON;
  const hasPos = c1 > GEOMETRY_EPSILON || c2 > GEOMETRY_EPSILON || c3 > GEOMETRY_EPSILON;
  return !(hasNeg && hasPos);
}

function interiorPointOfRing(ring: BattleRing): BattlePoint | null {
  const vertices = ring.slice(0, -1);
  const n = vertices.length;
  if (n < 3) return null;
  const sign = ringSignedArea(ring) >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a = vertices[(i + n - 1) % n];
    const b = vertices[i];
    const c = vertices[(i + 1) % n];
    const area2 = cross(a, b, c) * sign;
    if (area2 <= GEOMETRY_EPSILON) continue;
    let hasVertexInside = false;
    for (let k = 0; k < n; k++) {
      if (k === (i + n - 1) % n || k === i || k === (i + 1) % n) continue;
      if (pointInTriangle(vertices[k], a, b, c)) {
        hasVertexInside = true;
        break;
      }
    }
    if (!hasVertexInside) {
      const mid: BattlePoint = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      if (pointInRing(mid, ring, false)) return mid;
    }
  }
  return null;
}

function segmentSubMidpoints(a: BattlePoint, b: BattlePoint, rings: BattleRing[]): BattlePoint[] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cuts = [0, 1];
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const c = ring[i - 1];
      const ex = ring[i][0] - c[0];
      const ey = ring[i][1] - c[1];
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) <= 1e-18) continue;
      const cx = c[0] - a[0];
      const cy = c[1] - a[1];
      const t = (cx * ey - cy * ex) / denom;
      const u = (cx * dy - cy * dx) / denom;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
  }
  cuts.sort((l, r) => l - r);
  const mids: BattlePoint[] = [];
  for (let i = 1; i < cuts.length; i++) {
    if (cuts[i] - cuts[i - 1] <= 1e-12) continue;
    const mid = (cuts[i - 1] + cuts[i]) / 2;
    mids.push([a[0] + dx * mid, a[1] + dy * mid]);
  }
  return mids;
}

function analyticalPolygonContainsRing(polygon: BattlePolygon, ring: BattleRing): boolean {
  for (let i = 1; i < ring.length; i++) {
    if (!segmentWithinMultiPolygon([ring[i - 1], ring[i]], [polygon])) return false;
  }
  const innerPt = interiorPointOfRing(ring);
  if (innerPt && !strictlyInsidePolygon(innerPt, polygon)) return false;
  for (let h = 1; h < polygon.length; h++) {
    const hole = polygon[h];
    const hPt = interiorPointOfRing(hole);
    if (hPt && pointInRing(hPt, ring, false)) return false;
    for (let i = 1; i < hole.length; i++) {
      for (const mid of segmentSubMidpoints(hole[i - 1], hole[i], [ring])) {
        if (pointInRing(mid, ring, false)) return false;
      }
    }
  }
  return true;
}

function analyticalPolygonOverlapsRing(polygon: BattlePolygon, ring: BattleRing): boolean {
  const polyRings = polygon;
  for (const pt of ring.slice(0, -1)) {
    if (strictlyInsidePolygon(pt, polygon)) return true;
  }
  for (let i = 1; i < ring.length; i++) {
    for (const mid of segmentSubMidpoints(ring[i - 1], ring[i], polyRings)) {
      if (strictlyInsidePolygon(mid, polygon)) return true;
    }
  }
  for (const pRing of polyRings) {
    for (let i = 1; i < pRing.length; i++) {
      for (const mid of segmentSubMidpoints(pRing[i - 1], pRing[i], [ring])) {
        if (pointInRing(mid, ring, false)) return true;
      }
    }
  }
  const innerPt = interiorPointOfRing(ring);
  if (innerPt && strictlyInsidePolygon(innerPt, polygon)) return true;
  const outerPt = interiorPointOfRing(polygon[0]);
  if (outerPt && strictlyInsidePolygon(outerPt, polygon) && pointInRing(outerPt, ring, false)) return true;
  return false;
}

function polygonOverlapsRing(polygon: BattlePolygon, ring: BattleRing): boolean {
  try {
    return multiPolygonArea(intersection([ring], polygon)) > GEOMETRY_EPSILON;
  } catch {
    try {
      return multiPolygonArea(intersection(polygon, [ring])) > GEOMETRY_EPSILON;
    } catch {
      return analyticalPolygonOverlapsRing(polygon, ring);
    }
  }
}

/** 整块展开面必须在一个多边形内；孔和边界都按契约处理。 */
export function polygonContainsRing(polygon: BattlePolygon, ring: BattleRing): boolean {
  try {
    return multiPolygonArea(diff([ring], polygon)) <= GEOMETRY_EPSILON;
  } catch {
    return analyticalPolygonContainsRing(polygon, ring);
  }
}

/** 涉及区块包含面积相交与顶点贴边，保留既有冲突分类的边界语义。 */
export function ringComponentsWithVertices(
  multi: BattleMultiPolygon, ring: BattleRing,
): number[] {
  return multi.flatMap((polygon, index) =>
    polygonOverlapsRing(polygon, ring) || ring.some(point => pointInPolygon(point, polygon))
      ? [index] : []);
}

/** 展开面与障碍区域是否有正面积重叠；仅贴边不算。 */
export function multiPolygonOverlapsRing(
  multi: BattleMultiPolygon, ring: BattleRing,
): boolean {
  return multi.some((polygon) => polygonOverlapsRing(polygon, ring));
}

/** 在所有边界交点处分段，逐段检查；端点在域内不足以证明整段在域内。 */
export function segmentWithinMultiPolygon(
  segment: [BattlePoint, BattlePoint], multi: BattleMultiPolygon,
): boolean {
  const [a, b] = segment;
  if (!pointInMultiPolygon(a, multi) || !pointInMultiPolygon(b, multi)) return false;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const cuts = [0, 1];
  for (const polygon of multi) for (const ring of polygon) {
    for (let i = 1; i < ring.length; i++) {
      const c = ring[i - 1];
      const ex = ring[i][0] - c[0];
      const ey = ring[i][1] - c[1];
      const denominator = dx * ey - dy * ex;
      if (denominator === 0) continue;
      const cx = c[0] - a[0];
      const cy = c[1] - a[1];
      const t = (cx * ey - cy * ex) / denominator;
      const u = (cx * dy - cy * dx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
    }
  }
  cuts.sort((left, right) => left - right);
  return cuts.slice(1).every((end, index) => {
    const middle = (cuts[index] + end) / 2;
    return pointInMultiPolygon([a[0] + dx * middle, a[1] + dy * middle], multi);
  });
}

/** 闭合、简单、有面积；孔必须位于外环内由调用方契约保证。 */
export function multiPolygonIsValid(multi: BattleMultiPolygon): boolean {
  return multi.length > 0
    && multi.every((polygon) => polygon.length > 0 && polygon.every((ring) => ringIsValid(ring)));
}
