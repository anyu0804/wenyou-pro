import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import type {
	CardinalSector,
	MapBurgSummary,
	MapDistancePairKm,
	MapInspectResult,
	MapSnapshotDiffResult,
	MapSnapshotFormat,
	MapSnapshotSummary,
	MapStateDeltaItem,
	MapStateSummary,
	MapTheaterBrief,
	MapTransferredBurg,
	MapUnitSummary,
} from "@percho/shared";
import {
	assertPathInsideWorkspace,
	isPrivateVaultPath,
	normalizeVaultPath,
	resolveRealPathInsideWorkspace,
} from "./vault-paths";

const MAP_SEARCH_ROOTS = ["05-沙盘与图集", "maps", "assets/maps"] as const;
const SNAPSHOT_EXTS = new Set([".json", ".map"]);
const YEAR_LABEL_RE = /(?:^|[-_\s])([^\-_]*?(?:年|春|夏|秋|冬|纪|回合|T\d+)[^\-_]*)/;
const MAX_SAFE_CELL_COUNT = 2_000_000;

export interface PackedCellLayerV2 {
	readonly encoding: "rle-v1";
	readonly cellCount: number;
	readonly runs: readonly number[];
}

export interface MapInspectOptions {
	theaterId?: string;
	factionQuery?: string;
	maxBurgs?: number;
}

interface NormalizedState {
	id: number;
	name: string;
	color?: string;
	neighbors?: number[];
	capitalBurgId?: number;
}

interface NormalizedProvince {
	id: number;
	stateId: number;
}

interface NormalizedBurg {
	id: number;
	name: string;
	stateId: number;
	cell?: number;
	x: number;
	y: number;
	isCapital: boolean;
	isPort: boolean;
	population: number;
	removed: boolean;
}

interface NormalizedUnit {
	id: string;
	name: string;
	stateId?: number;
	provinceId?: number;
	side?: string;
	branch?: string;
	echelon?: string;
	personnel: number;
	personnelScope?: "exclusive" | "inclusive";
	parentUnitId?: string;
	status?: string;
	x?: number;
	y?: number;
}

interface NormalizedTheater {
	mapId: string;
	name: string;
	baseKind?: "fmg" | "image";
	imageAssetPath?: string;
	hexRadius?: number;
	kmPerPixel?: number;
	mapWidthKm?: number;
	width: number;
	height: number;
	heights: number[];
	statesByCell: number[];
	cellNeighbors?: number[][];
	states: NormalizedState[];
	provinces: NormalizedProvince[];
	burgs: NormalizedBurg[];
	units: NormalizedUnit[];
	frontlineCount: number;
	arrowCount: number;
	fieldBattleCount: number;
}

export interface NormalizedMapSnapshot {
	format: MapSnapshotFormat;
	version?: number;
	activeMapId?: string;
	theaters: NormalizedTheater[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 兼容 wenyou-pixi-app v0.9.1 的 BattleField<T>（{ state: "known", value: T } | { state: "unknown" }）、
 * 仅含 { value: T } 的旧结构以及直出原始值。
 */
function unwrapBattleField(raw: unknown): unknown {
	if (isRecord(raw) && "state" in raw) {
		return raw.state === "known" ? raw.value : undefined;
	}
	if (isRecord(raw) && "value" in raw) return raw.value;
	return raw;
}

function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function round4(n: number): number {
	return Math.round(n * 10000) / 10000;
}

function round6(n: number): number {
	return Math.round(n * 1000000) / 1000000;
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0.5;
	if (n < 0) return 0;
	if (n > 1) return 1;
	return n;
}

/**
 * 将画布坐标 (x, y) 换算为九宫格方位（Y 轴向下：上北下南、左西右东）。
 */
export function computeCardinalSector(x: number, y: number, width: number, height: number): CardinalSector {
	const normX = width > 0 ? clamp01(x / width) : 0.5;
	const normY = height > 0 ? clamp01(y / height) : 0.5;
	const col = normX < 1 / 3 ? 0 : normX > 2 / 3 ? 2 : 1;
	const row = normY < 1 / 3 ? 0 : normY > 2 / 3 ? 2 : 1;
	const table: readonly (readonly CardinalSector[])[] = [
		["西北", "正北", "东北"],
		["正西", "中枢", "正东"],
		["西南", "正南", "东南"],
	];
	return table[row]![col]!;
}

/**
 * RLE 游程编码（移植自 Stage 0 rle-layer，零外部依赖）。
 */
export function encodeCellLayerRle(cells: readonly number[], maxVal = 65535): PackedCellLayerV2 {
	if (!Array.isArray(cells)) {
		throw new Error("RLE 编码输入必须为整数数组");
	}
	const runs: number[] = [];
	if (cells.length === 0) {
		return { encoding: "rle-v1", cellCount: 0, runs };
	}
	let currentVal = -1;
	let currentLen = 0;
	for (let i = 0; i < cells.length; i += 1) {
		const cell = cells[i]!;
		if (!Number.isInteger(cell) || cell < 0 || cell > maxVal) {
			throw new Error(`RLE 编码地块值越界：index=${i}, value=${String(cell)}`);
		}
		if (cell === currentVal) {
			currentLen += 1;
		} else {
			if (currentLen > 0) runs.push(currentVal, currentLen);
			currentVal = cell;
			currentLen = 1;
		}
	}
	if (currentLen > 0) runs.push(currentVal, currentLen);
	return { encoding: "rle-v1", cellCount: cells.length, runs };
}

/**
 * RLE 游程解码（严格校验偶数长度、数值范围与游程总和边界，防溢出）。
 */
export function decodeCellLayerRle(packed: unknown, maxVal = 65535): number[] {
	if (!isRecord(packed)) {
		throw new Error("RLE 图层必须为对象");
	}
	if (packed.encoding !== "rle-v1") {
		throw new Error(`不支持的 RLE 编码格式：${String(packed.encoding)}`);
	}
	const cellCount = packed.cellCount;
	if (typeof cellCount !== "number" || !Number.isInteger(cellCount) || cellCount < 0) {
		throw new Error("RLE cellCount 必须为非负整数");
	}
	if (cellCount > MAX_SAFE_CELL_COUNT) {
		throw new Error(`RLE cellCount（${cellCount}）超出安全上限（${MAX_SAFE_CELL_COUNT}）`);
	}
	const rawRuns = packed.runs;
	if (!Array.isArray(rawRuns) || rawRuns.length % 2 !== 0) {
		throw new Error("RLE runs 必须为偶数长度数组");
	}
	const out = new Array<number>(cellCount);
	let offset = 0;
	for (let i = 0; i < rawRuns.length; i += 2) {
		const val = rawRuns[i];
		const len = rawRuns[i + 1];
		if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > maxVal) {
			throw new Error(`RLE runs[${i}] 地块值非法`);
		}
		if (typeof len !== "number" || !Number.isInteger(len) || len < 1 || len > cellCount) {
			throw new Error(`RLE runs[${i + 1}] 游程长度非法`);
		}
		if (offset + len > cellCount) {
			throw new Error("RLE 游程总和超出 cellCount");
		}
		for (let j = 0; j < len; j += 1) {
			out[offset] = val;
			offset += 1;
		}
	}
	if (offset !== cellCount) {
		throw new Error(`RLE 总长度（${offset}）与 cellCount（${cellCount}）不匹配`);
	}
	return out;
}

function unpackCellLayer(raw: unknown, maxVal = 65535): number[] {
	if (Array.isArray(raw)) {
		const out = new Array<number>(raw.length);
		for (let i = 0; i < raw.length; i += 1) {
			const n = toFiniteNumber(raw[i]);
			out[i] = n !== undefined && n >= 0 && n <= maxVal ? Math.trunc(n) : 0;
		}
		return out;
	}
	if (isRecord(raw) && raw.encoding === "rle-v1") {
		return decodeCellLayerRle(raw, maxVal);
	}
	return [];
}

function parseFmgHeaderDimensions(source: string | undefined): { width?: number; height?: number; seed?: string; mapIdToken?: string } {
	if (!source) return {};
	const firstNewline = source.indexOf("\n");
	const firstLine = (firstNewline === -1 ? source : source.slice(0, firstNewline)).replace(/\r$/, "");
	const parts = firstLine.split("|");
	if (parts.length < 6) return {};
	const width = toFiniteNumber(parts[4]);
	const height = toFiniteNumber(parts[5]);
	return {
		...(width && width > 0 ? { width } : {}),
		...(height && height > 0 ? { height } : {}),
		...(toNonEmptyString(parts[3]) ? { seed: parts[3]!.trim() } : {}),
		...(toNonEmptyString(parts[6]) ? { mapIdToken: parts[6]!.trim() } : {}),
	};
}

function parseMapIdDimensions(mapId: string): { width?: number; height?: number } {
	const match = mapId.match(/(\d+)x(\d+)$/);
	if (!match) return {};
	const w = Number(match[1]);
	const h = Number(match[2]);
	return w > 0 && h > 0 ? { width: w, height: h } : {};
}

function parseStatesArray(raw: unknown): NormalizedState[] {
	if (!Array.isArray(raw)) return [];
	const states: NormalizedState[] = [];
	for (let idx = 0; idx < raw.length; idx += 1) {
		const entry = raw[idx];
		if (!isRecord(entry)) continue;
		const id = toFiniteNumber(entry.i ?? entry.id);
		if (id === undefined || !Number.isInteger(id) || id <= 0) continue;
		if (entry.removed === true) continue;
		const name = toNonEmptyString(entry.name) ?? toNonEmptyString(entry.fullName) ?? `政权#${id}`;
		const color = toNonEmptyString(entry.color);
		const capitalBurgId = toFiniteNumber(entry.capital);
		const rawNeighbors = Array.isArray(entry.neighbors)
			? entry.neighbors
					.map((n) => toFiniteNumber(n))
					.filter((n): n is number => n !== undefined && Number.isInteger(n) && n > 0 && n !== id)
			: undefined;
		states.push({
			id,
			name,
			...(color ? { color } : {}),
			...(rawNeighbors && rawNeighbors.length > 0 ? { neighbors: [...new Set(rawNeighbors)] } : {}),
			...(capitalBurgId !== undefined && capitalBurgId > 0 ? { capitalBurgId: Math.trunc(capitalBurgId) } : {}),
		});
	}
	return states;
}

function parseProvincesArray(raw: unknown): NormalizedProvince[] {
	if (!Array.isArray(raw)) return [];
	const out: NormalizedProvince[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = toFiniteNumber(entry.i ?? entry.id);
		const stateId = toFiniteNumber(entry.state ?? entry.stateId);
		if (id !== undefined && id > 0 && stateId !== undefined && stateId >= 0) {
			out.push({ id: Math.trunc(id), stateId: Math.trunc(stateId) });
		}
	}
	return out;
}

function parseBurgsArray(raw: unknown, statesByCell: readonly number[]): NormalizedBurg[] {
	if (!Array.isArray(raw)) return [];
	const burgs: NormalizedBurg[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = toFiniteNumber(entry.i ?? entry.id);
		const name = toNonEmptyString(entry.name);
		if (id === undefined || !Number.isInteger(id) || id <= 0 || !name) continue;
		const x = toFiniteNumber(entry.x) ?? 0;
		const y = toFiniteNumber(entry.y) ?? 0;
		const cell = toFiniteNumber(entry.cell);
		const cellInt = cell !== undefined && Number.isInteger(cell) && cell >= 0 ? cell : undefined;
		const explicitState = toFiniteNumber(entry.state ?? entry.stateId);
		const cellState = cellInt !== undefined && cellInt < statesByCell.length ? statesByCell[cellInt] : undefined;
		let stateId = 0;
		if (explicitState !== undefined && explicitState > 0) {
			stateId = Math.trunc(explicitState);
		} else if (cellState !== undefined && cellState > 0) {
			stateId = cellState;
		} else if (explicitState !== undefined && explicitState >= 0) {
			stateId = Math.trunc(explicitState);
		}
		const isCapital =
			entry.capital === true ||
			entry.capital === 1 ||
			entry.tier === "capital" ||
			toFiniteNumber(entry.capital) === 1;
		const portNum = toFiniteNumber(entry.port);
		const isPort = entry.port === true || (portNum !== undefined && portNum > 0);
		const population = toFiniteNumber(entry.population) ?? 0;
		burgs.push({
			id,
			name,
			stateId,
			...(cellInt !== undefined ? { cell: cellInt } : {}),
			x,
			y,
			isCapital,
			isPort,
			population,
			removed: entry.removed === true,
		});
	}
	return burgs;
}

function parseDeploymentAnchors(battle: unknown): Map<string, { x: number; y: number }> {
	const anchors = new Map<string, { x: number; y: number }>();
	if (!isRecord(battle) || !Array.isArray(battle.deployments)) return anchors;
	for (const dep of battle.deployments) {
		if (!isRecord(dep)) continue;
		const unitId = toNonEmptyString(unwrapBattleField(dep.unitId));
		if (!unitId) continue;
		const unwrapped = unwrapBattleField(dep.placement);
		const placement = isRecord(unwrapped) ? unwrapped : undefined;
		const anchor = placement && Array.isArray(placement.anchor) ? placement.anchor : undefined;
		if (anchor && anchor.length >= 2) {
			const x = toFiniteNumber(anchor[0]);
			const y = toFiniteNumber(anchor[1]);
			if (x !== undefined && y !== undefined) {
				anchors.set(unitId, { x, y });
			}
		}
	}
	return anchors;
}

function parseUnits(rawGarrisons: unknown, battle: unknown): NormalizedUnit[] {
	if (!Array.isArray(rawGarrisons)) return [];
	const anchors = parseDeploymentAnchors(battle);
	const units: NormalizedUnit[] = [];
	for (let idx = 0; idx < rawGarrisons.length; idx += 1) {
		const entry = rawGarrisons[idx];
		if (!isRecord(entry)) continue;
		if (entry.removed === true) continue;
		const id = toNonEmptyString(entry.id) ?? `unit-${idx + 1}`;
		const name =
			toNonEmptyString(unwrapBattleField(entry.unitName)) ??
			toNonEmptyString(unwrapBattleField(entry.name)) ??
			id;
		const unwrappedPersonnel = unwrapBattleField(entry.personnel);
		const rawPersonnelCount =
			isRecord(unwrappedPersonnel) && "count" in unwrappedPersonnel
				? unwrapBattleField(unwrappedPersonnel.count)
				: unwrappedPersonnel;
		const rawScope = isRecord(unwrappedPersonnel)
			? unwrapBattleField(unwrappedPersonnel.scope)
			: unwrapBattleField(entry.personnelScope);
		const personnelScope: "exclusive" | "inclusive" | undefined =
			rawScope === "inclusive" || rawScope === "exclusive" ? rawScope : undefined;
		const parentUnitId = toNonEmptyString(unwrapBattleField(entry.parentUnitId ?? entry.parentId));
		const personnel =
			toFiniteNumber(rawPersonnelCount) ??
			toFiniteNumber(unwrapBattleField(entry.troops)) ??
			0;
		const side = toNonEmptyString(unwrapBattleField(entry.side));
		const branch = toNonEmptyString(unwrapBattleField(entry.branch));
		const echelon = toNonEmptyString(unwrapBattleField(entry.echelon));
		const status = toNonEmptyString(unwrapBattleField(entry.status));
		const stateId = toFiniteNumber(unwrapBattleField(entry.stateId ?? entry.state));
		const provinceId = toFiniteNumber(unwrapBattleField(entry.provinceId));
		const depAnchor = anchors.get(id);
		const x = depAnchor?.x ?? toFiniteNumber(entry.x);
		const y = depAnchor?.y ?? toFiniteNumber(entry.y);
		units.push({
			id,
			name,
			...(stateId !== undefined && stateId > 0 ? { stateId: Math.trunc(stateId) } : {}),
			...(provinceId !== undefined && provinceId > 0 ? { provinceId: Math.trunc(provinceId) } : {}),
			...(side ? { side } : {}),
			...(branch ? { branch } : {}),
			...(echelon ? { echelon } : {}),
			personnel: Math.max(0, Math.round(personnel)),
			...(personnelScope ? { personnelScope } : {}),
			...(parentUnitId ? { parentUnitId } : {}),
			...(status ? { status } : {}),
			...(x !== undefined && y !== undefined ? { x, y } : {}),
		});
	}
	return units;
}

/** 识别 scope === "inclusive" 且存在活跃子单位的父编制，避免在政权/全图统计中重复叠加兵力 */
function findInclusiveParentUnitIds(units: readonly NormalizedUnit[]): Set<string> {
	const parentsWithChildren = new Set<string>();
	for (const u of units) {
		if (u.parentUnitId) {
			parentsWithChildren.add(u.parentUnitId);
		}
	}
	const skip = new Set<string>();
	for (const u of units) {
		if (u.personnelScope === "inclusive" && parentsWithChildren.has(u.id)) {
			skip.add(u.id);
		}
	}
	return skip;
}

function countTacticalItems(raw: unknown): { frontlineCount: number; arrowCount: number } {
	if (!Array.isArray(raw)) return { frontlineCount: 0, arrowCount: 0 };
	let frontlineCount = 0;
	let arrowCount = 0;
	for (const item of raw) {
		if (!isRecord(item)) continue;
		if (item.type === "frontline") frontlineCount += 1;
		else if (item.type === "arrow") arrowCount += 1;
	}
	return { frontlineCount, arrowCount };
}

function inferDimensions(
	explicitWidth: number | undefined,
	explicitHeight: number | undefined,
	source: string | undefined,
	mapId: string,
	burgs: readonly NormalizedBurg[],
	units: readonly NormalizedUnit[],
): { width: number; height: number } {
	if (explicitWidth && explicitWidth > 0 && explicitHeight && explicitHeight > 0) {
		return { width: explicitWidth, height: explicitHeight };
	}
	const fromSource = parseFmgHeaderDimensions(source);
	if (fromSource.width && fromSource.height) {
		return { width: fromSource.width, height: fromSource.height };
	}
	const fromId = parseMapIdDimensions(mapId);
	if (fromId.width && fromId.height) {
		return { width: fromId.width, height: fromId.height };
	}
	let maxX = 0;
	let maxY = 0;
	for (const b of burgs) {
		if (!b.removed) {
			if (b.x > maxX) maxX = b.x;
			if (b.y > maxY) maxY = b.y;
		}
	}
	for (const u of units) {
		if (u.x !== undefined && u.x > maxX) maxX = u.x;
		if (u.y !== undefined && u.y > maxY) maxY = u.y;
	}
	if (maxX > 0 && maxY > 0) {
		return { width: Math.ceil(maxX * 1.05), height: Math.ceil(maxY * 1.05) };
	}
	return { width: 1000, height: 1000 };
}

/** 折合 FMG .map 内多行 <svg>...</svg> 中的裸换行，使 lines[14/15/18/25/30] 行号严格对齐 */
function splitFmgMapLines(content: string): string[] {
	const clean = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const collapsed = clean.replace(/<svg\b[\s\S]*?<\/svg>/gi, (block) => block.replace(/\n+/g, " "));
	return collapsed.split("\n");
}

function extractSourceStateNeighbors(source: string | undefined): Map<number, number[]> {
	const map = new Map<number, number[]>();
	if (!source) return map;
	const lines = splitFmgMapLines(source);
	if (lines.length <= 14 || !lines[14]) return map;
	try {
		const states = JSON.parse(lines[14]) as unknown;
		for (const st of parseStatesArray(states)) {
			if (st.neighbors && st.neighbors.length > 0) {
				map.set(st.id, st.neighbors);
			}
		}
	} catch {
		// source header/mock without full FMG JSON payload
	}
	return map;
}

function parseCellNeighbors(raw: unknown): number[][] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const out: number[][] = [];
	for (const row of raw) {
		if (!Array.isArray(row)) return undefined;
		const ints: number[] = [];
		for (const v of row) {
			const n = toFiniteNumber(v);
			if (n !== undefined && Number.isInteger(n) && n >= 0) ints.push(n);
		}
		out.push(ints);
	}
	return out;
}

interface ParsedImageBaseSource {
	width?: number;
	height?: number;
	hexRadius?: number;
	imageRelPath?: string;
	kmPerPixel?: number;
	mapWidthKm?: number;
}

function parseImageBaseSource(source: string | undefined): ParsedImageBaseSource | null {
	if (!source) return null;
	const trimmed = source.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const obj = JSON.parse(trimmed) as unknown;
		if (!isRecord(obj) || obj.wenyouImageBase !== 1) return null;
		const width = toFiniteNumber(obj.width);
		const height = toFiniteNumber(obj.height);
		const hexRadius = toFiniteNumber(obj.hexRadius);
		const imageRelPath = toNonEmptyString(obj.imageRelPath);
		const kmPerPixelRaw = toFiniteNumber(obj.kmPerPixel);
		const mapWidthKmRaw = toFiniteNumber(obj.mapWidthKm);
		const validWidth = width !== undefined && width > 0 ? width : undefined;
		const validHeight = height !== undefined && height > 0 ? height : undefined;
		const validHexRadius = hexRadius !== undefined && hexRadius > 0 ? hexRadius : undefined;
		const validKmPerPixel =
			kmPerPixelRaw !== undefined && kmPerPixelRaw > 0
				? kmPerPixelRaw
				: mapWidthKmRaw !== undefined && mapWidthKmRaw > 0 && validWidth
					? mapWidthKmRaw / validWidth
					: undefined;
		const validMapWidthKm =
			mapWidthKmRaw !== undefined && mapWidthKmRaw > 0
				? mapWidthKmRaw
				: validKmPerPixel !== undefined && validWidth
					? validKmPerPixel * validWidth
					: undefined;
		return {
			...(validWidth !== undefined ? { width: validWidth } : {}),
			...(validHeight !== undefined ? { height: validHeight } : {}),
			...(validHexRadius !== undefined ? { hexRadius: validHexRadius } : {}),
			...(imageRelPath ? { imageRelPath } : {}),
			...(validKmPerPixel !== undefined ? { kmPerPixel: validKmPerPixel } : {}),
			...(validMapWidthKm !== undefined ? { mapWidthKm: validMapWidthKm } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * 与 pixi-sandbox image-map-builder 完全一致的 Pointy-top Odd-R 六角网格邻接推导：
 * dx = Math.sqrt(3) * hexRadius, dy = 1.5 * hexRadius,
 * cols = Math.max(2, Math.ceil(width / dx)), rows = Math.max(2, Math.ceil(height / dy))。
 */
export function buildOddRHexNeighbors(width: number, height: number, hexRadius: number): number[][] {
	if (!(width > 0) || !(height > 0) || !(hexRadius > 0)) return [];
	const effectiveRadius = Math.max(4, Math.round(hexRadius));
	const dx = Math.sqrt(3) * effectiveRadius;
	const dy = 1.5 * effectiveRadius;
	const cols = Math.max(2, Math.ceil(width / dx));
	const rows = Math.max(2, Math.ceil(height / dy));
	const count = rows * cols;
	if (count > MAX_SAFE_CELL_COUNT) {
		throw new Error(`六角网格总数（${count}）超出安全上限（${MAX_SAFE_CELL_COUNT}）`);
	}
	const neighbors: number[][] = new Array(count);
	const evenOffsets: readonly (readonly [number, number])[] = [
		[-1, 0],
		[1, 0],
		[-1, -1],
		[0, -1],
		[-1, 1],
		[0, 1],
	];
	const oddOffsets: readonly (readonly [number, number])[] = [
		[-1, 0],
		[1, 0],
		[0, -1],
		[1, -1],
		[0, 1],
		[1, 1],
	];
	for (let row = 0; row < rows; row += 1) {
		const offsets = row % 2 === 1 ? oddOffsets : evenOffsets;
		for (let col = 0; col < cols; col += 1) {
			const idx = row * cols + col;
			const list: number[] = [];
			for (const [dc, dr] of offsets) {
				const nc = col + dc;
				const nr = row + dr;
				if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) {
					list.push(nr * cols + nc);
				}
			}
			neighbors[idx] = list;
		}
	}
	return neighbors;
}

function parseProjectTheater(raw: unknown, idx: number, fallbackName: string): NormalizedTheater | null {
	if (!isRecord(raw) || !isRecord(raw.map)) return null;
	const mapObj = raw.map;
	const source = typeof mapObj.source === "string" ? mapObj.source : undefined;
	const imageBase = parseImageBaseSource(source);
	const baseKind: "fmg" | "image" = imageBase ? "image" : "fmg";
	const mapId = toNonEmptyString(mapObj.mapId) ?? `theater-${idx + 1}`;
	const name = toNonEmptyString(mapObj.name) ?? fallbackName;
	const heights = unpackCellLayer(mapObj.heights, 100);
	const statesByCell = unpackCellLayer(mapObj.statesByCell, 65535);
	const states = parseStatesArray(mapObj.states);
	const sourceNeighbors = imageBase ? new Map<number, number[]>() : extractSourceStateNeighbors(source);
	for (const st of states) {
		if ((!st.neighbors || st.neighbors.length === 0) && sourceNeighbors.has(st.id)) {
			st.neighbors = sourceNeighbors.get(st.id);
		}
	}
	const provinces = parseProvincesArray(mapObj.provinces);
	const burgs = parseBurgsArray(mapObj.burgs, statesByCell);
	const units = parseUnits(raw.garrisons, raw.battle);
	const { frontlineCount, arrowCount } = countTacticalItems(raw.tacticalItems);
	const fieldBattleCount = Array.isArray(raw.fieldBattles) ? raw.fieldBattles.length : 0;
	const { width, height } = inferDimensions(
		toFiniteNumber(mapObj.width) ?? imageBase?.width,
		toFiniteNumber(mapObj.height) ?? imageBase?.height,
		imageBase ? undefined : source,
		mapId,
		burgs,
		units,
	);
	const hexRadius = imageBase?.hexRadius ?? toFiniteNumber(mapObj.hexRadius);
	let cellNeighbors = parseCellNeighbors(mapObj.cellNeighbors ?? mapObj.neighborsByCell);
	if (!cellNeighbors && imageBase && hexRadius && hexRadius > 0) {
		cellNeighbors = buildOddRHexNeighbors(width, height, hexRadius);
	}
	const rawKmPerPixel = imageBase?.kmPerPixel ?? toFiniteNumber(mapObj.kmPerPixel);
	const rawMapWidthKm = imageBase?.mapWidthKm ?? toFiniteNumber(mapObj.mapWidthKm);
	const kmPerPixel =
		rawKmPerPixel !== undefined && rawKmPerPixel > 0
			? rawKmPerPixel
			: rawMapWidthKm !== undefined && rawMapWidthKm > 0 && width > 0
				? rawMapWidthKm / width
				: undefined;
	const mapWidthKm =
		rawMapWidthKm !== undefined && rawMapWidthKm > 0
			? rawMapWidthKm
			: kmPerPixel !== undefined && width > 0
				? kmPerPixel * width
				: undefined;
	return {
		mapId,
		name,
		baseKind,
		...(imageBase?.imageRelPath ? { imageAssetPath: imageBase.imageRelPath } : {}),
		...(hexRadius && hexRadius > 0 ? { hexRadius } : {}),
		...(kmPerPixel !== undefined ? { kmPerPixel } : {}),
		...(mapWidthKm !== undefined ? { mapWidthKm } : {}),
		width,
		height,
		heights,
		statesByCell,
		...(cellNeighbors ? { cellNeighbors } : {}),
		states,
		provinces,
		burgs,
		units,
		frontlineCount,
		arrowCount,
		fieldBattleCount,
	};
}

function parseCommaIntLine(line: string | undefined, maxVal: number): number[] {
	if (!line) return [];
	const trimmed = line.trim();
	if (!trimmed) return [];
	const parts = trimmed.split(",");
	const out = new Array<number>(parts.length);
	for (let i = 0; i < parts.length; i += 1) {
		const n = Number(parts[i]);
		if (!Number.isInteger(n) || n < 0 || n > maxVal) return [];
		out[i] = n;
	}
	return out;
}

function parseFmgMapText(content: string, fallbackName: string): NormalizedMapSnapshot | null {
	const lines = splitFmgMapLines(content);
	if (lines.length < 16) return null;
	const headerParts = (lines[0] ?? "").split("|");
	if (headerParts.length < 6 || !/^\d+\.\d+/.test(headerParts[0]!.trim())) {
		return null;
	}
	const width = toFiniteNumber(headerParts[4]);
	const height = toFiniteNumber(headerParts[5]);
	if (!width || width <= 0 || !height || height <= 0) return null;

	let rawStates: unknown;
	let rawBurgs: unknown;
	let rawProvinces: unknown;
	try {
		rawStates = lines[14] ? JSON.parse(lines[14]) : [];
		rawBurgs = lines[15] ? JSON.parse(lines[15]) : [];
	} catch {
		return null;
	}
	if (!Array.isArray(rawStates) || !Array.isArray(rawBurgs)) return null;
	if (lines[30]) {
		try {
			rawProvinces = JSON.parse(lines[30]);
		} catch {
			rawProvinces = [];
		}
	}

	const statesByCell = parseCommaIntLine(lines[25], 65535);
	// FMG 标准格式：lines[18] 为 cells.h（高程 0..100），lines[20] 为 cells.fl（河流流量）；
	// 仅在 lines[18] 为空时向下兼容旧版测试 mock。
	const primaryHeights = parseCommaIntLine(lines[18], 100);
	const fallbackHeights = !lines[18]?.trim() ? parseCommaIntLine(lines[20], 100) : [];
	const heightsCandidate = primaryHeights.length > 0 ? primaryHeights : fallbackHeights;
	const heights =
		statesByCell.length === 0 || heightsCandidate.length === statesByCell.length ? heightsCandidate : [];
	const states = parseStatesArray(rawStates);
	const provinces = parseProvincesArray(rawProvinces);
	const burgs = parseBurgsArray(rawBurgs, statesByCell);
	const seed = toNonEmptyString(headerParts[3]) ?? "fmg";
	const mapToken = toNonEmptyString(headerParts[6]) ?? "0";
	const mapId = `${seed}-${mapToken}-${Math.trunc(width)}x${Math.trunc(height)}`;

	return {
		format: "fmg-map",
		activeMapId: mapId,
		theaters: [
			{
				mapId,
				name: fallbackName,
				baseKind: "fmg",
				width,
				height,
				heights,
				statesByCell,
				states,
				provinces,
				burgs,
				units: [],
				frontlineCount: 0,
				arrowCount: 0,
				fieldBattleCount: 0,
			},
		],
	};
}

/**
 * 解析地图快照原文（自动识别 wenyou-project v1-v4 / FMG .map）。
 * 非地图文件返回 null。
 */
export function parseMapSnapshotContent(
	content: string,
	ext: string,
	fallbackName: string,
): NormalizedMapSnapshot | null {
	const lowerExt = ext.toLowerCase();
	if (lowerExt === ".map") {
		return parseFmgMapText(content, fallbackName);
	}
	if (lowerExt !== ".json") return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(content.replace(/^\uFEFF/, ""));
	} catch {
		return null;
	}
	if (!isRecord(parsed)) return null;

	const isProjectFormat = parsed.format === "wenyou-project";
	const hasLegacySingleMap =
		!isProjectFormat &&
		isRecord(parsed.map) &&
		(Array.isArray(parsed.map.statesByCell) ||
			(isRecord(parsed.map.statesByCell) && parsed.map.statesByCell.encoding === "rle-v1")) &&
		(Array.isArray(parsed.map.states) || Array.isArray(parsed.map.burgs));

	if (isProjectFormat || hasLegacySingleMap) {
		const rawTheaters = Array.isArray(parsed.theaters)
			? parsed.theaters
			: isRecord(parsed.map)
				? [parsed]
				: [];
		if (rawTheaters.length === 0) return null;
		const theaters: NormalizedTheater[] = [];
		for (let i = 0; i < rawTheaters.length; i += 1) {
			const t = parseProjectTheater(rawTheaters[i], i, fallbackName);
			if (!t) return null;
			theaters.push(t);
		}
		const version = toFiniteNumber(parsed.version);
		return {
			format: "wenyou-project",
			...(version !== undefined ? { version: Math.trunc(version) } : {}),
			...(toNonEmptyString(parsed.activeMapId) ? { activeMapId: String(parsed.activeMapId).trim() } : {}),
			theaters,
		};
	}

	return null;
}

async function walkRelativeFiles(root: string, relPrefix = ""): Promise<string[]> {
	const dir = relPrefix ? join(root, relPrefix) : root;
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name === "node_modules" || entry.name === ".git") continue;
		const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			out.push(...(await walkRelativeFiles(root, rel)));
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out;
}

async function assertSafeSnapshotReadPath(cwd: string, relPath: string): Promise<{ normalized: string; absPath: string }> {
	const normalized = normalizeVaultPath(relPath);
	if (!normalized || normalized.split("/").includes("..")) {
		throw new Error(`非法地图快照路径：${relPath}`);
	}
	if (isPrivateVaultPath(normalized)) {
		throw new Error("禁止访问 private/ 或 .wenyou/ 受限目录");
	}
	const ext = extname(normalized).toLowerCase();
	if (!SNAPSHOT_EXTS.has(ext)) {
		throw new Error(`仅支持读取 .json 或 .map 地图快照（当前：${ext || "无扩展名"}）`);
	}
	const realTarget = await resolveRealPathInsideWorkspace(cwd, normalized);
	const realRoot = await realpath(resolve(cwd));
	const realRel = relative(realRoot, realTarget).split(sep).join("/");
	if (isPrivateVaultPath(realRel)) {
		throw new Error("符号链接目标落入受限目录，已拒绝读取");
	}
	const info = await stat(realTarget);
	if (!info.isFile()) {
		throw new Error(`目标不是常规文件：${normalized}`);
	}
	return { normalized, absPath: realTarget };
}

function buildSnapshotSummary(
	relPath: string,
	snapshot: NormalizedMapSnapshot,
	sizeBytes: number,
	modifiedAt: number,
): MapSnapshotSummary {
	const ext = extname(relPath);
	const name = basename(relPath, ext);
	const yearMatch = name.match(YEAR_LABEL_RE);
	const theaters: MapTheaterBrief[] = snapshot.theaters.map((t) => ({
		mapId: t.mapId,
		name: t.name,
		stateCount: t.states.length,
		burgCount: t.burgs.filter((b) => !b.removed).length,
		unitCount: t.units.length,
	}));
	return {
		id: relPath,
		name,
		relPath,
		format: snapshot.format,
		...(snapshot.version !== undefined ? { version: snapshot.version } : {}),
		...(yearMatch?.[1] ? { yearLabel: yearMatch[1].trim() } : {}),
		theaters,
		sizeBytes,
		modifiedAt,
	};
}

function selectTheater(snapshot: NormalizedMapSnapshot, theaterId?: string): NormalizedTheater {
	if (theaterId && theaterId.trim().length > 0) {
		const q = theaterId.trim().toLowerCase();
		const exact = snapshot.theaters.find(
			(t) => t.mapId.toLowerCase() === q || t.name.toLowerCase() === q,
		);
		if (exact) return exact;
		const partial = snapshot.theaters.find(
			(t) => t.mapId.toLowerCase().includes(q) || t.name.toLowerCase().includes(q),
		);
		if (partial) return partial;
		throw new Error(`未在快照中找到战区「${theaterId}」`);
	}
	if (snapshot.activeMapId) {
		const active = snapshot.theaters.find((t) => t.mapId === snapshot.activeMapId);
		if (active) return active;
	}
	return snapshot.theaters[0]!;
}

function buildStateNameMap(theater: NormalizedTheater): Map<number, string> {
	const map = new Map<number, string>();
	map.set(0, "无主/荒地");
	for (const st of theater.states) {
		map.set(st.id, st.name);
	}
	return map;
}

function resolveUnitStateId(
	unit: NormalizedUnit,
	theater: NormalizedTheater,
	provinceToState: ReadonlyMap<number, number>,
): number | undefined {
	if (unit.stateId !== undefined && unit.stateId > 0) return unit.stateId;
	if (unit.provinceId !== undefined) {
		const fromProv = provinceToState.get(unit.provinceId);
		if (fromProv && fromProv > 0) return fromProv;
	}
	if (unit.side) {
		const q = unit.side.trim().toLowerCase();
		const exact = theater.states.find((s) => s.name.trim().toLowerCase() === q);
		if (exact) return exact.id;
		const partial = theater.states.find(
			(s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()),
		);
		if (partial) return partial.id;
	}
	return undefined;
}

function computeNeighborStateIds(theater: NormalizedTheater): Map<number, Set<number>> {
	const adj = new Map<number, Set<number>>();
	const addEdge = (a: number, b: number) => {
		if (a <= 0 || b <= 0 || a === b) return;
		let setA = adj.get(a);
		if (!setA) {
			setA = new Set<number>();
			adj.set(a, setA);
		}
		setA.add(b);
	};

	// 1. 优先使用显式地块邻接拓扑（最精确，反映最新涂色边界；存在 cellNeighbors 时即使真实接壤为空也不回退陈旧 st.neighbors）
	if (theater.cellNeighbors && theater.cellNeighbors.length > 0 && theater.statesByCell.length > 0) {
		const len = Math.min(theater.cellNeighbors.length, theater.statesByCell.length);
		for (let i = 0; i < len; i += 1) {
			const sid = theater.statesByCell[i]!;
			if (sid <= 0) continue;
			const neighbors = theater.cellNeighbors[i]!;
			for (const nbCell of neighbors) {
				if (nbCell >= 0 && nbCell < theater.statesByCell.length) {
					const nbState = theater.statesByCell[nbCell]!;
					if (nbState > 0 && nbState !== sid) {
						addEdge(sid, nbState);
						addEdge(nbState, sid);
					}
				}
			}
		}
		return adj;
	}

	// 2. 次优使用 FMG states 自带的 Voronoi 邻国表（neighbors: number[]）
	for (const st of theater.states) {
		if (!st.neighbors || st.neighbors.length === 0) continue;
		for (const nbId of st.neighbors) {
			addEdge(st.id, nbId);
		}
	}
	return adj;
}

function findNearestBurg(
	x: number,
	y: number,
	burgs: readonly NormalizedBurg[],
): { name: string; distancePx: number } | undefined {
	let bestName: string | undefined;
	let bestDistSq = Number.POSITIVE_INFINITY;
	for (const b of burgs) {
		if (b.removed) continue;
		const dx = b.x - x;
		const dy = b.y - y;
		const distSq = dx * dx + dy * dy;
		if (distSq < bestDistSq) {
			bestDistSq = distSq;
			bestName = b.name;
		}
	}
	if (!bestName || !Number.isFinite(bestDistSq)) return undefined;
	return { name: bestName, distancePx: Math.sqrt(bestDistSq) };
}

function buildKeyDistancesKm(burgs: readonly NormalizedBurg[], kmPerPixel: number): MapDistancePairKm[] {
	if (!(kmPerPixel > 0) || burgs.length < 2) return [];
	const topBurgs = [...burgs]
		.sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || b.population - a.population || a.id - b.id)
		.slice(0, 8);
	const pairs: Array<MapDistancePairKm & { bothCapital: boolean }> = [];
	for (let i = 0; i < topBurgs.length; i += 1) {
		const a = topBurgs[i]!;
		for (let j = i + 1; j < topBurgs.length; j += 1) {
			const b = topBurgs[j]!;
			const distKm = round1(Math.hypot(a.x - b.x, a.y - b.y) * kmPerPixel);
			pairs.push({
				from: a.name,
				to: b.name,
				distanceKm: distKm,
				bothCapital: a.isCapital && b.isCapital,
			});
		}
	}
	pairs.sort((a, b) => Number(b.bothCapital) - Number(a.bothCapital) || a.distanceKm - b.distanceKm);
	return pairs.slice(0, 12).map(({ from, to, distanceKm }) => ({ from, to, distanceKm }));
}

/**
 * 扫描工作区 05-沙盘与图集/、maps/、assets/maps/ 下的结构化地图快照（.json / .map）。
 * 非地图普通 JSON 静默跳过。
 */
export async function listMapSnapshots(cwd: string): Promise<MapSnapshotSummary[]> {
	const results: MapSnapshotSummary[] = [];
	const seen = new Set<string>();
	for (const root of MAP_SEARCH_ROOTS) {
		const files = await walkRelativeFiles(cwd, root);
		for (const rel of files) {
			const normalized = normalizeVaultPath(rel);
			if (seen.has(normalized) || isPrivateVaultPath(normalized)) continue;
			const ext = extname(normalized).toLowerCase();
			if (!SNAPSHOT_EXTS.has(ext)) continue;
			seen.add(normalized);
			try {
				const abs = assertPathInsideWorkspace(cwd, normalized);
				const [info, content] = await Promise.all([stat(abs), readFile(abs, "utf8")]);
				if (!info.isFile()) continue;
				const parsed = parseMapSnapshotContent(content, ext, basename(normalized, ext));
				if (!parsed) continue;
				results.push(buildSnapshotSummary(normalized, parsed, info.size, info.mtimeMs));
			} catch {
				// 跳过无权限或不可读文件
			}
		}
	}
	return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function loadValidatedSnapshot(
	cwd: string,
	relPath: string,
): Promise<{ normalized: string; fileName: string; content: string; snapshot: NormalizedMapSnapshot }> {
	const { normalized, absPath } = await assertSafeSnapshotReadPath(cwd, relPath);
	const content = await readFile(absPath, "utf8");
	const ext = extname(normalized).toLowerCase();
	const snapshot = parseMapSnapshotContent(content, ext, basename(normalized, ext));
	if (!snapshot) {
		throw new Error(`文件不是有效的地图快照（wenyou-project / FMG .map）：${normalized}`);
	}
	return { normalized, fileName: basename(normalized), content, snapshot };
}

/**
 * 读取合法地图快照原文（供桥接导入沙盘用，强制校验工作区边界、非 private/ 与快照格式）。
 */
export async function readMapSnapshotRaw(
	cwd: string,
	relPath: string,
): Promise<{ relPath: string; fileName: string; content: string }> {
	const { normalized, fileName, content } = await loadValidatedSnapshot(cwd, relPath);
	return { relPath: normalized, fileName, content };
}

/**
 * 将沙盘导出的 wenyou-project JSON 校验后原子落盘至 05-沙盘与图集/。
 */
export async function saveMapSnapshot(
	cwd: string,
	fileName: string,
	content: string,
): Promise<MapSnapshotSummary> {
	const rawName = fileName.trim();
	if (
		!rawName ||
		rawName.includes("..") ||
		rawName.includes("/") ||
		rawName.includes("\\") ||
		rawName.includes("\0")
	) {
		throw new Error(`非法快照文件名（禁止路径穿越或包含目录分隔符）：${fileName}`);
	}
	const parsed = parseMapSnapshotContent(content, ".json", basename(rawName, ".json"));
	if (!parsed || parsed.format !== "wenyou-project") {
		throw new Error("保存失败：content 必须是合法的 wenyou-project JSON");
	}
	const stemRaw = rawName.toLowerCase().endsWith(".json") ? rawName.slice(0, -5) : rawName;
	const safeStem = stemRaw
		.replace(/[:*?"<>|]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	if (!safeStem || safeStem === "." || safeStem === "..") {
		throw new Error(`非法快照文件名：${fileName}`);
	}
	const relPath = normalizeVaultPath(`05-沙盘与图集/${safeStem}.json`);
	if (isPrivateVaultPath(relPath)) {
		throw new Error("快照写入路径不得落入受限目录");
	}
	const absPath = assertPathInsideWorkspace(cwd, relPath);
	await mkdir(dirname(absPath), { recursive: true });
	const tmpPath = `${absPath}.tmp-${randomUUID().slice(0, 8)}`;
	await writeFile(tmpPath, content, "utf8");
	await rename(tmpPath, absPath);
	const info = await stat(absPath);
	return buildSnapshotSummary(relPath, parsed, info.size, info.mtimeMs);
}

/**
 * 检视单份地图快照的政权、邻国、城邦方位/海港与部队兵力部署。
 */
export async function inspectMapSnapshot(
	cwd: string,
	relPath: string,
	opts?: MapInspectOptions,
): Promise<MapInspectResult> {
	const { normalized, snapshot } = await loadValidatedSnapshot(cwd, relPath);
	const theater = selectTheater(snapshot, opts?.theaterId);
	const stateNameById = buildStateNameMap(theater);
	const provinceToState = new Map(theater.provinces.map((p) => [p.id, p.stateId]));
	const activeBurgs = theater.burgs.filter((b) => !b.removed);

	// 1. 统计各国地块数
	const cellsByState = new Map<number, number>();
	for (const sid of theater.statesByCell) {
		if (sid > 0) {
			cellsByState.set(sid, (cellsByState.get(sid) ?? 0) + 1);
		}
	}

	// 2. 统计城邦归属、人口、首都与重心坐标
	const burgsByState = new Map<number, NormalizedBurg[]>();
	for (const b of activeBurgs) {
		const list = burgsByState.get(b.stateId) ?? [];
		list.push(b);
		burgsByState.set(b.stateId, list);
	}

	// 3. 统计部队兵力与位置（若配置了比例尺 kmPerPixel，一并计算距最近城邦直线公里数）
	const kmPerPixel =
		theater.kmPerPixel !== undefined && theater.kmPerPixel > 0
			? theater.kmPerPixel
			: theater.mapWidthKm !== undefined && theater.mapWidthKm > 0 && theater.width > 0
				? theater.mapWidthKm / theater.width
				: undefined;
	const mapWidthKm =
		theater.mapWidthKm !== undefined && theater.mapWidthKm > 0
			? round1(theater.mapWidthKm)
			: kmPerPixel !== undefined && theater.width > 0
				? round1(kmPerPixel * theater.width)
				: undefined;

	const personnelByState = new Map<number, number>();
	const unitCountByState = new Map<number, number>();
	const inclusiveParents = findInclusiveParentUnitIds(theater.units);
	const unitSummariesAll: Array<MapUnitSummary & { matchedStateId?: number }> = [];
	for (const u of theater.units) {
		const matchedStateId = resolveUnitStateId(u, theater, provinceToState);
		if (matchedStateId !== undefined) {
			if (!inclusiveParents.has(u.id)) {
				personnelByState.set(matchedStateId, (personnelByState.get(matchedStateId) ?? 0) + u.personnel);
			}
			unitCountByState.set(matchedStateId, (unitCountByState.get(matchedStateId) ?? 0) + 1);
		}
		const sector =
			u.x !== undefined && u.y !== undefined
				? computeCardinalSector(u.x, u.y, theater.width, theater.height)
				: undefined;
		const nearestBurg =
			u.x !== undefined && u.y !== undefined ? findNearestBurg(u.x, u.y, activeBurgs) : undefined;
		const nearestBurgDistanceKm =
			nearestBurg && kmPerPixel !== undefined ? round1(nearestBurg.distancePx * kmPerPixel) : undefined;
		unitSummariesAll.push({
			unitId: u.id,
			name: u.name,
			...(u.side ? { side: u.side } : {}),
			...(u.branch ? { branch: u.branch } : {}),
			...(u.echelon ? { echelon: u.echelon } : {}),
			personnel: u.personnel,
			...(u.status ? { status: u.status } : {}),
			...(u.x !== undefined && u.y !== undefined ? { x: round4(u.x), y: round4(u.y) } : {}),
			...(sector ? { sector } : {}),
			...(nearestBurg ? { nearestBurgName: nearestBurg.name } : {}),
			...(nearestBurgDistanceKm !== undefined ? { nearestBurgDistanceKm } : {}),
			...(matchedStateId !== undefined ? { matchedStateId } : {}),
		});
	}

	// 4. 构造政权摘要与邻国表
	const neighborMap = computeNeighborStateIds(theater);
	const allStateIds = new Set<number>([
		...theater.states.map((s) => s.id),
		...cellsByState.keys(),
		...burgsByState.keys(),
		...unitCountByState.keys(),
	]);
	allStateIds.delete(0);

	const stateMetaById = new Map(theater.states.map((s) => [s.id, s]));
	let stateSummaries: MapStateSummary[] = [...allStateIds].map((stateId) => {
		const meta = stateMetaById.get(stateId);
		const stBurgs = burgsByState.get(stateId) ?? [];
		const capital =
			stBurgs.find((b) => b.isCapital) ??
			(meta?.capitalBurgId ? stBurgs.find((b) => b.id === meta.capitalBurgId) : undefined);
		const totalPopulation = round4(stBurgs.reduce((sum, b) => sum + b.population, 0));
		let sector: CardinalSector | undefined;
		if (stBurgs.length > 0) {
			const avgX = stBurgs.reduce((sum, b) => sum + b.x, 0) / stBurgs.length;
			const avgY = stBurgs.reduce((sum, b) => sum + b.y, 0) / stBurgs.length;
			sector = computeCardinalSector(avgX, avgY, theater.width, theater.height);
		}
		const neighborIds = neighborMap.get(stateId);
		const neighborStateNames = neighborIds
			? [...neighborIds]
					.sort((a, b) => a - b)
					.map((nid) => stateNameById.get(nid))
					.filter((n): n is string => Boolean(n))
			: [];
		return {
			stateId,
			name: meta?.name ?? `政权#${stateId}`,
			...(meta?.color ? { color: meta.color } : {}),
			cellCount: cellsByState.get(stateId) ?? 0,
			burgCount: stBurgs.length,
			...(capital ? { capitalName: capital.name } : {}),
			totalPopulation,
			totalPersonnel: personnelByState.get(stateId) ?? 0,
			unitCount: unitCountByState.get(stateId) ?? 0,
			...(sector ? { sector } : {}),
			neighborStateNames,
		};
	});
	stateSummaries.sort((a, b) => b.cellCount - a.cellCount || b.burgCount - a.burgCount || a.stateId - b.stateId);

	// 5. 构造城邦摘要
	let burgSummaries: MapBurgSummary[] = activeBurgs.map((b) => {
		const normX = round4(theater.width > 0 ? clamp01(b.x / theater.width) : 0.5);
		const normY = round4(theater.height > 0 ? clamp01(b.y / theater.height) : 0.5);
		return {
			burgId: b.id,
			name: b.name,
			stateId: b.stateId,
			stateName: stateNameById.get(b.stateId) ?? `政权#${b.stateId}`,
			isCapital: b.isCapital,
			isPort: b.isPort,
			population: round4(b.population),
			x: round4(b.x),
			y: round4(b.y),
			normX,
			normY,
			sector: computeCardinalSector(b.x, b.y, theater.width, theater.height),
		};
	});
	burgSummaries.sort(
		(a, b) => Number(b.isCapital) - Number(a.isCapital) || b.population - a.population || a.burgId - b.burgId,
	);

	// 6. 按 factionQuery 过滤（若提供）
	let filteredUnits = unitSummariesAll;
	const factionQuery = opts?.factionQuery?.trim().toLowerCase();
	if (factionQuery) {
		const matchedStateIds = new Set<number>();
		stateSummaries = stateSummaries.filter((s) => {
			const hit = s.name.toLowerCase().includes(factionQuery) || String(s.stateId) === factionQuery;
			if (hit) matchedStateIds.add(s.stateId);
			return hit;
		});
		burgSummaries = burgSummaries.filter(
			(b) => matchedStateIds.has(b.stateId) || b.name.toLowerCase().includes(factionQuery),
		);
		filteredUnits = unitSummariesAll.filter(
			(u) =>
				(u.matchedStateId !== undefined && matchedStateIds.has(u.matchedStateId)) ||
				(u.side?.toLowerCase().includes(factionQuery) ?? false) ||
				u.name.toLowerCase().includes(factionQuery),
		);
	}

	const maxBurgs = opts?.maxBurgs ?? 50;
	if (maxBurgs >= 0 && burgSummaries.length > maxBurgs) {
		burgSummaries = burgSummaries.slice(0, maxBurgs);
	}

	const units: MapUnitSummary[] = filteredUnits
		.sort((a, b) => b.personnel - a.personnel || a.unitId.localeCompare(b.unitId))
		.map(({ matchedStateId: _ignored, ...rest }) => rest);

	const totalLandCells =
		theater.heights.length > 0
			? theater.heights.reduce((sum, h) => sum + (h >= 20 ? 1 : 0), 0)
			: theater.statesByCell.reduce((sum, s) => sum + (s > 0 ? 1 : 0), 0);

	const keyDistancesKm = kmPerPixel !== undefined ? buildKeyDistancesKm(activeBurgs, kmPerPixel) : [];

	return {
		relPath: normalized,
		format: snapshot.format,
		...(theater.baseKind ? { baseKind: theater.baseKind } : {}),
		...(theater.imageAssetPath ? { imageAssetPath: theater.imageAssetPath } : {}),
		...(kmPerPixel !== undefined ? { kmPerPixel: round6(kmPerPixel) } : {}),
		...(mapWidthKm !== undefined ? { mapWidthKm } : {}),
		theaterId: theater.mapId,
		theaterName: theater.name,
		availableTheaters: snapshot.theaters.map((t) => ({ mapId: t.mapId, name: t.name })),
		width: theater.width,
		height: theater.height,
		totalLandCells,
		states: stateSummaries,
		burgs: burgSummaries,
		units,
		...(keyDistancesKm.length > 0 ? { keyDistancesKm } : {}),
		frontlineCount: theater.frontlineCount,
		arrowCount: theater.arrowCount,
		fieldBattleCount: theater.fieldBattleCount,
	};
}

function selectTheaterPair(
	fromSnapshot: NormalizedMapSnapshot,
	toSnapshot: NormalizedMapSnapshot,
	theaterId?: string,
): { fromTheater: NormalizedTheater; toTheater: NormalizedTheater } {
	if (theaterId && theaterId.trim().length > 0) {
		return {
			fromTheater: selectTheater(fromSnapshot, theaterId),
			toTheater: selectTheater(toSnapshot, theaterId),
		};
	}
	if (toSnapshot.activeMapId) {
		const fromMatch = fromSnapshot.theaters.find((t) => t.mapId === toSnapshot.activeMapId);
		const toMatch = toSnapshot.theaters.find((t) => t.mapId === toSnapshot.activeMapId);
		if (fromMatch && toMatch) return { fromTheater: fromMatch, toTheater: toMatch };
	}
	for (const toT of toSnapshot.theaters) {
		const fromT = fromSnapshot.theaters.find((t) => t.mapId === toT.mapId);
		if (fromT) return { fromTheater: fromT, toTheater: toT };
	}
	if (fromSnapshot.theaters.length === 1 && toSnapshot.theaters.length === 1) {
		return { fromTheater: fromSnapshot.theaters[0]!, toTheater: toSnapshot.theaters[0]! };
	}
	throw new Error("两份快照之间未找到同 ID 战区，请通过 theaterId 显式指定");
}

function formatSigned(n: number): string {
	return n > 0 ? `+${n}` : String(n);
}

/**
 * 对比两份地图快照（支持 wenyou-project / FMG .map 任意组合），
 * 计算各国领土增减、易手城邦、新建/毁灭城邦、兵力与战线变动。
 */
export async function diffMapSnapshots(
	cwd: string,
	fromRelPath: string,
	toRelPath: string,
	theaterId?: string,
): Promise<MapSnapshotDiffResult> {
	const [fromLoaded, toLoaded] = await Promise.all([
		loadValidatedSnapshot(cwd, fromRelPath),
		loadValidatedSnapshot(cwd, toRelPath),
	]);
	const { fromTheater, toTheater } = selectTheaterPair(fromLoaded.snapshot, toLoaded.snapshot, theaterId);

	const prevNames = buildStateNameMap(fromTheater);
	const nextNames = buildStateNameMap(toTheater);
	const resolveStateName = (sid: number) => nextNames.get(sid) ?? prevNames.get(sid) ?? (sid === 0 ? "无主/荒地" : `政权#${sid}`);

	// 1. 地块归属差分（仅在两期网格长度一致时按格比对 changedCellCount）
	const prevCells = fromTheater.statesByCell;
	const nextCells = toTheater.statesByCell;
	let changedCellCount = 0;
	const beforeCellsByState = new Map<number, number>();
	const afterCellsByState = new Map<number, number>();
	const gainedByState = new Map<number, number>();
	const lostByState = new Map<number, number>();

	if (prevCells.length === nextCells.length) {
		for (let i = 0; i < prevCells.length; i += 1) {
			const p = prevCells[i]!;
			const n = nextCells[i]!;
			if (p > 0) beforeCellsByState.set(p, (beforeCellsByState.get(p) ?? 0) + 1);
			if (n > 0) afterCellsByState.set(n, (afterCellsByState.get(n) ?? 0) + 1);
			if (p !== n) {
				changedCellCount += 1;
				if (p > 0) lostByState.set(p, (lostByState.get(p) ?? 0) + 1);
				if (n > 0) gainedByState.set(n, (gainedByState.get(n) ?? 0) + 1);
			}
		}
	} else {
		for (const p of prevCells) {
			if (p > 0) beforeCellsByState.set(p, (beforeCellsByState.get(p) ?? 0) + 1);
		}
		for (const n of nextCells) {
			if (n > 0) afterCellsByState.set(n, (afterCellsByState.get(n) ?? 0) + 1);
		}
	}

	// 2. 兵力差分（跳过 scope="inclusive" 且已被子单位拆分承载的父编制，避免双倍计数）
	const prevProvMap = new Map(fromTheater.provinces.map((p) => [p.id, p.stateId]));
	const nextProvMap = new Map(toTheater.provinces.map((p) => [p.id, p.stateId]));
	const beforeInclusiveParents = findInclusiveParentUnitIds(fromTheater.units);
	const afterInclusiveParents = findInclusiveParentUnitIds(toTheater.units);
	const beforePersonnelByState = new Map<number, number>();
	const afterPersonnelByState = new Map<number, number>();
	let beforeTotalPersonnel = 0;
	let afterTotalPersonnel = 0;

	for (const u of fromTheater.units) {
		if (beforeInclusiveParents.has(u.id)) continue;
		beforeTotalPersonnel += u.personnel;
		const sid = resolveUnitStateId(u, fromTheater, prevProvMap);
		if (sid !== undefined) {
			beforePersonnelByState.set(sid, (beforePersonnelByState.get(sid) ?? 0) + u.personnel);
		}
	}
	for (const u of toTheater.units) {
		if (afterInclusiveParents.has(u.id)) continue;
		afterTotalPersonnel += u.personnel;
		const sid = resolveUnitStateId(u, toTheater, nextProvMap);
		if (sid !== undefined) {
			afterPersonnelByState.set(sid, (afterPersonnelByState.get(sid) ?? 0) + u.personnel);
		}
	}

	const allStateIds = new Set<number>([
		...fromTheater.states.map((s) => s.id),
		...toTheater.states.map((s) => s.id),
		...beforeCellsByState.keys(),
		...afterCellsByState.keys(),
		...beforePersonnelByState.keys(),
		...afterPersonnelByState.keys(),
	]);
	allStateIds.delete(0);

	const stateDeltas: MapStateDeltaItem[] = [...allStateIds]
		.map((stateId) => {
			const beforeCells = beforeCellsByState.get(stateId) ?? 0;
			const afterCells = afterCellsByState.get(stateId) ?? 0;
			const gainedCells = gainedByState.get(stateId) ?? 0;
			const lostCells = lostByState.get(stateId) ?? 0;
			const beforePersonnel = beforePersonnelByState.get(stateId) ?? 0;
			const afterPersonnel = afterPersonnelByState.get(stateId) ?? 0;
			return {
				stateId,
				stateName: resolveStateName(stateId),
				beforeCells,
				afterCells,
				netCells: afterCells - beforeCells,
				gainedCells,
				lostCells,
				beforePersonnel,
				afterPersonnel,
				netPersonnel: afterPersonnel - beforePersonnel,
			};
		})
		.filter((d) => d.beforeCells > 0 || d.afterCells > 0 || d.beforePersonnel > 0 || d.afterPersonnel > 0)
		.sort(
			(a, b) =>
				Math.abs(b.netCells) - Math.abs(a.netCells) ||
				Math.abs(b.netPersonnel) - Math.abs(a.netPersonnel) ||
				a.stateId - b.stateId,
		);

	// 3. 城邦易手与增减
	const prevBurgs = new Map(fromTheater.burgs.filter((b) => !b.removed).map((b) => [b.id, b]));
	const nextBurgs = new Map(toTheater.burgs.filter((b) => !b.removed).map((b) => [b.id, b]));
	const transferredBurgs: MapTransferredBurg[] = [];
	const addedBurgs: string[] = [];
	const removedBurgs: string[] = [];

	for (const [burgId, nextB] of nextBurgs.entries()) {
		const prevB = prevBurgs.get(burgId);
		if (!prevB) {
			addedBurgs.push(nextB.name);
			continue;
		}
		if (prevB.stateId !== nextB.stateId) {
			transferredBurgs.push({
				burgId,
				burgName: nextB.name,
				isCapital: nextB.isCapital || prevB.isCapital,
				isPort: nextB.isPort,
				fromStateId: prevB.stateId,
				fromStateName: prevNames.get(prevB.stateId) ?? resolveStateName(prevB.stateId),
				toStateId: nextB.stateId,
				toStateName: nextNames.get(nextB.stateId) ?? resolveStateName(nextB.stateId),
				sector: computeCardinalSector(nextB.x, nextB.y, toTheater.width, toTheater.height),
			});
		}
	}
	for (const [burgId, prevB] of prevBurgs.entries()) {
		if (!nextBurgs.has(burgId)) {
			removedBurgs.push(prevB.name);
		}
	}
	transferredBurgs.sort((a, b) => Number(b.isCapital) - Number(a.isCapital) || a.burgId - b.burgId);

	const netTotalPersonnel = afterTotalPersonnel - beforeTotalPersonnel;
	const frontlineDelta = toTheater.frontlineCount - fromTheater.frontlineCount;

	// 4. 拼装精炼中文摘要
	const parts: string[] = [];
	if (changedCellCount > 0) {
		const topMovers = stateDeltas
			.filter((d) => d.netCells !== 0)
			.slice(0, 4)
			.map((d) => `${d.stateName}${formatSigned(d.netCells)}`);
		parts.push(`领土变动 ${changedCellCount} 格${topMovers.length ? `（${topMovers.join("、")}）` : ""}`);
	}
	if (transferredBurgs.length > 0) {
		const preview = transferredBurgs
			.slice(0, 3)
			.map((b) => `${b.burgName}：${b.fromStateName}→${b.toStateName}`)
			.join("；");
		parts.push(`易手城池 ${transferredBurgs.length} 座（${preview}${transferredBurgs.length > 3 ? "等" : ""}）`);
	}
	if (addedBurgs.length > 0 || removedBurgs.length > 0) {
		parts.push(`城池新建 ${addedBurgs.length} / 毁弃 ${removedBurgs.length}`);
	}
	if (netTotalPersonnel !== 0 || beforeTotalPersonnel > 0 || afterTotalPersonnel > 0) {
		parts.push(`总兵力 ${beforeTotalPersonnel}→${afterTotalPersonnel}（${formatSigned(netTotalPersonnel)}）`);
	}
	if (frontlineDelta !== 0) {
		parts.push(`战线 ${formatSigned(frontlineDelta)}`);
	}
	const summaryText =
		parts.length > 0
			? `战区「${toTheater.name}」：${parts.join("；")}。`
			: `战区「${toTheater.name}」：领土、城池与兵力均无变化。`;

	return {
		fromRelPath: fromLoaded.normalized,
		toRelPath: toLoaded.normalized,
		theaterId: toTheater.mapId,
		theaterName: toTheater.name,
		changedCellCount,
		stateDeltas,
		transferredBurgs,
		addedBurgs,
		removedBurgs,
		beforeTotalPersonnel,
		afterTotalPersonnel,
		netTotalPersonnel,
		frontlineDelta,
		summaryText,
	};
}
