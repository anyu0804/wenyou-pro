import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildOddRHexNeighbors,
	computeCardinalSector,
	decodeCellLayerRle,
	diffMapSnapshots,
	encodeCellLayerRle,
	inspectMapSnapshot,
	listMapSnapshots,
	readMapSnapshotRaw,
	saveMapSnapshot,
} from "../src/wenyou/map-state";
import { WenyouService } from "../src/wenyou/service";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeProjectV4Json(opts: {
	statesByCell: number[];
	burgs: Array<Record<string, unknown>>;
	garrisons: Array<Record<string, unknown>>;
	deployments?: Array<Record<string, unknown>>;
	tacticalItems?: Array<Record<string, unknown>>;
	fieldBattles?: Array<Record<string, unknown>>;
	cellNeighbors?: number[][];
}): string {
	return JSON.stringify(
		{
			format: "wenyou-project",
			version: 4,
			activeMapId: "hebei-1000x800",
			theaters: [
				{
					version: 4,
					map: {
						source: "1.154|fmg|2026-11-26|9876|1000|800|hebei",
						name: "河朔战区",
						mapId: "hebei-1000x800",
						heights: opts.statesByCell.map((s) => (s === 0 ? 10 : 30)),
						statesByCell: opts.statesByCell,
						provincesByCell: opts.statesByCell.map(() => 0),
						religionsByCell: opts.statesByCell.map(() => 0),
						...(opts.cellNeighbors ? { cellNeighbors: opts.cellNeighbors } : {}),
						states: [
							{ i: 0, name: "Neutrals" },
							{ i: 1, name: "北周", color: "#3366cc", neighbors: [2], capital: 1 },
							{ i: 2, name: "南楚", color: "#cc3344", neighbors: [1, 3], capital: 2 },
							{ i: 3, name: "西凉", color: "#cc9933", neighbors: [2], capital: 3 },
						],
						burgs: [{}, ...opts.burgs],
						provinces: [{ i: 1, state: 1 }],
					},
					garrisons: opts.garrisons,
					battle: {
						version: 1,
						deployments: opts.deployments ?? [],
					},
					fieldBattles: opts.fieldBattles ?? [],
					tacticalItems: opts.tacticalItems ?? [],
				},
			],
		},
		null,
		2,
	);
}

function makeDeltaV2Json(opts: {
	snapshotId: string;
	statesByCell: number[];
	burgs: Array<Record<string, unknown>>;
	garrisons: Array<Record<string, unknown>>;
	tacticalItems?: Array<Record<string, unknown>>;
}): string {
	const zeros = encodeCellLayerRle(opts.statesByCell.map(() => 0), 65535);
	const heights = encodeCellLayerRle(
		opts.statesByCell.map((s) => (s === 0 ? 10 : 30)),
		100,
	);
	return JSON.stringify({
		format: "wenyou-map-delta",
		version: 2,
		snapshotId: opts.snapshotId,
		label: "RLE V2 快照",
		createdAt: "2026-11-26T00:00:00Z",
		activeMapId: "hebei-1000x800",
		theaters: [
			{
				baseMapId: "hebei-1000x800",
				baseMapSha256: "a".repeat(64),
				mapName: "河朔战区",
				overlay: {
					heights,
					statesByCell: encodeCellLayerRle(opts.statesByCell, 65535),
					provincesByCell: zeros,
					religionsByCell: zeros,
					states: [
						{ i: 0, name: "Neutrals" },
						{ i: 1, name: "北周", color: "#3366cc", neighbors: [2], capital: 1 },
						{ i: 2, name: "南楚", color: "#cc3344", neighbors: [1], capital: 2 },
					],
					burgs: [{}, ...opts.burgs],
					provinces: [],
				},
				garrisons: opts.garrisons,
				battle: { deployments: [] },
				fieldBattles: [],
				tacticalItems: opts.tacticalItems ?? [],
			},
		],
	});
}

function makeFmgMapText(): string {
	const lines = new Array<string>(32).fill("");
	lines[0] = "1.108.0|FMG|2026|4242|1200|900|east-sea";
	lines[5] = "<svg>HUGE_SVG_SHOULD_NEVER_BE_RETURNED</svg>";
	lines[14] = JSON.stringify([
		{ i: 0, name: "Neutrals" },
		{ i: 1, name: "东吴", color: "#22aa88", neighbors: [2], capital: 1 },
		{ i: 2, name: "北魏", color: "#6644aa", neighbors: [1], capital: 2 },
	]);
	lines[15] = JSON.stringify([
		{},
		{ i: 1, name: "建康港", x: 1050, y: 720, cell: 1, state: 1, capital: 1, port: 2, population: 24.5 },
		{ i: 2, name: "洛阳", x: 580, y: 200, cell: 3, state: 2, capital: 1, port: 0, population: 31.0 },
	]);
	lines[20] = "12,28,32,40,35";
	lines[25] = "0,1,1,2,2";
	return lines.join("\r\n");
}

describe("map-state 纯算法与多格式解析/跨回合差分/安全边界", () => {
	it("RLE 编解码无损往返并拦截游程溢出与非法长度", () => {
		const cells = [0, 1, 1, 1, 2, 2, 0, 3, 3, 3, 3];
		const packed = encodeCellLayerRle(cells, 65535);
		expect(packed).toEqual({
			encoding: "rle-v1",
			cellCount: cells.length,
			runs: [0, 1, 1, 3, 2, 2, 0, 1, 3, 4],
		});
		expect(decodeCellLayerRle(packed, 65535)).toEqual(cells);
		expect(() => decodeCellLayerRle({ encoding: "rle-v1", cellCount: 3, runs: [1, 2, 2, 2] })).toThrow("超出 cellCount");
		expect(() => decodeCellLayerRle({ encoding: "rle-v1", cellCount: 3, runs: [1, 2, 2] })).toThrow("偶数");
	});

	it("九宫格方位换算覆盖全九区", () => {
		expect(computeCardinalSector(100, 100, 900, 900)).toBe("西北");
		expect(computeCardinalSector(450, 100, 900, 900)).toBe("正北");
		expect(computeCardinalSector(800, 100, 900, 900)).toBe("东北");
		expect(computeCardinalSector(100, 450, 900, 900)).toBe("正西");
		expect(computeCardinalSector(450, 450, 900, 900)).toBe("中枢");
		expect(computeCardinalSector(800, 450, 900, 900)).toBe("正东");
		expect(computeCardinalSector(100, 800, 900, 900)).toBe("西南");
		expect(computeCardinalSector(450, 800, 900, 900)).toBe("正南");
		expect(computeCardinalSector(800, 800, 900, 900)).toBe("东南");
	});

	it("扫描并解析 wenyou-project v4、RLE delta v2 与 FMG .map，静默跳过非地图 JSON 且不污染 listMaps 图片列表", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-map-state-"));
		tempDirs.push(root);
		await mkdir(join(root, "05-沙盘与图集"), { recursive: true });
		await mkdir(join(root, "maps"), { recursive: true });

		// 干扰文件：普通 JSON + 损坏 JSON + 图片
		await writeFile(join(root, "05-沙盘与图集", "notes.json"), JSON.stringify({ note: "not a map" }), "utf8");
		await writeFile(join(root, "05-沙盘与图集", "broken.json"), "{invalid-json", "utf8");
		await writeFile(join(root, "05-沙盘与图集", "景平五年秋-河朔图.svg"), "<svg/>", "utf8");

		// 3 类合法快照
		await writeFile(
			join(root, "05-沙盘与图集", "景平五年秋-河朔.json"),
			makeProjectV4Json({
				statesByCell: [0, 1, 1, 1, 2, 2, 3],
				burgs: [
					{ i: 1, name: "清源城", x: 500, y: 120, cell: 1, state: 1, capital: 1, port: 0, population: 15 },
					{ i: 2, name: "临河渡", x: 520, y: 400, cell: 2, state: 1, capital: 0, port: 1, population: 6 },
					{ i: 3, name: "江陵港", x: 850, y: 700, cell: 4, state: 2, capital: 1, port: 2, population: 22 },
					{ i: 4, name: "凉州", x: 120, y: 200, cell: 6, state: 3, capital: 1, port: 0, population: 9 },
				],
				garrisons: [
					{
						id: "u-north-1",
						unitName: { value: "河阳镇主力" },
						side: { value: "北周" },
						branch: { value: "步兵" },
						echelon: { value: "军" },
						status: { value: "驻防" },
						personnel: 12000,
					},
					{
						id: "u-south-1",
						unitName: { value: "南楚水师" },
						side: { value: "南楚" },
						branch: { value: "水师" },
						personnel: 8000,
					},
				],
				deployments: [
					{ unitId: "u-north-1", placement: { anchor: [515, 395] } },
					{ unitId: "u-south-1", placement: { anchor: [840, 690] } },
				],
				tacticalItems: [
					{ id: "fl-1", type: "frontline", points: [[400, 420], [620, 420]] },
					{ id: "ar-1", type: "arrow", points: [[840, 690], [520, 400]] },
				],
				fieldBattles: [{ id: "fb-1", name: "临河渡之战" }],
			}),
			"utf8",
		);
		await writeFile(
			join(root, "05-沙盘与图集", "景平六年春-河朔delta.json"),
			makeDeltaV2Json({
				snapshotId: "snap-t2",
				statesByCell: [0, 1, 2, 2, 2, 2, 3],
				burgs: [
					{ i: 1, name: "清源城", x: 500, y: 120, cell: 1, state: 1, capital: 1, port: 0, population: 15 },
					{ i: 2, name: "临河渡", x: 520, y: 400, cell: 2, state: 2, capital: 0, port: 1, population: 6 },
					{ i: 3, name: "江陵港", x: 850, y: 700, cell: 4, state: 2, capital: 1, port: 2, population: 22 },
					{ i: 5, name: "新筑寨", x: 600, y: 500, cell: 3, state: 2, capital: 0, port: 0, population: 2 },
				],
				garrisons: [
					{ id: "u-north-1", unitName: { value: "河阳镇主力" }, side: { value: "北周" }, personnel: 9500 },
					{ id: "u-south-1", unitName: { value: "南楚水师" }, side: { value: "南楚" }, personnel: 11000 },
				],
				tacticalItems: [
					{ id: "fl-1", type: "frontline", points: [[400, 350], [620, 350]] },
					{ id: "fl-2", type: "frontline", points: [[200, 300], [350, 300]] },
				],
			}),
			"utf8",
		);
		await writeFile(join(root, "maps", "东海古图.map"), makeFmgMapText(), "utf8");

		const service = new WenyouService();
		const images = await service.listMaps(root);
		expect(images).toHaveLength(1);
		expect(images[0]!.ext).toBe(".svg");
		expect(images[0]!.assetUrl).toMatch(/^wenyou-asset:\/\/vault\?.*&v=\d+$/);

		const snapshots = await listMapSnapshots(root);
		expect(snapshots).toHaveLength(3);
		expect(snapshots.map((s) => s.format).sort()).toEqual(["fmg-map", "wenyou-map-delta", "wenyou-project"]);

		// 1) inspect wenyou-project v4
		const inspV4 = await inspectMapSnapshot(root, "05-沙盘与图集/景平五年秋-河朔.json");
		expect(inspV4.width).toBe(1000);
		expect(inspV4.height).toBe(800);
		expect(inspV4.totalLandCells).toBe(6);
		expect(inspV4.frontlineCount).toBe(1);
		expect(inspV4.arrowCount).toBe(1);
		expect(inspV4.fieldBattleCount).toBe(1);

		const north = inspV4.states.find((s) => s.name === "北周")!;
		expect(north.cellCount).toBe(3);
		expect(north.burgCount).toBe(2);
		expect(north.capitalName).toBe("清源城");
		expect(north.totalPersonnel).toBe(12000);
		expect(north.neighborStateNames).toEqual(["南楚"]);

		const portBurg = inspV4.burgs.find((b) => b.name === "江陵港")!;
		expect(portBurg.isPort).toBe(true);
		expect(portBurg.isCapital).toBe(true);
		expect(portBurg.sector).toBe("东南");
		expect(portBurg.normX).toBe(0.85);
		expect(portBurg.normY).toBe(0.875);

		const northArmy = inspV4.units.find((u) => u.unitId === "u-north-1")!;
		expect(northArmy.nearestBurgName).toBe("临河渡");
		expect(northArmy.sector).toBe("中枢");

		// 2) inspect FMG .map（不泄出原始 SVG 大文本）
		const inspMap = await inspectMapSnapshot(root, "maps/东海古图.map");
		expect(inspMap.format).toBe("fmg-map");
		expect(inspMap.width).toBe(1200);
		expect(inspMap.height).toBe(900);
		expect(inspMap.totalLandCells).toBe(4);
		expect(JSON.stringify(inspMap)).not.toContain("HUGE_SVG_SHOULD_NEVER_BE_RETURNED");
		const wu = inspMap.states.find((s) => s.name === "东吴")!;
		expect(wu.cellCount).toBe(2);
		expect(wu.neighborStateNames).toEqual(["北魏"]);
		expect(inspMap.burgs.find((b) => b.name === "建康港")?.isPort).toBe(true);

		// 3) 跨格式差分（wenyou-project v4 → RLE wenyou-map-delta v2）
		const diff = await diffMapSnapshots(
			root,
			"05-沙盘与图集/景平五年秋-河朔.json",
			"05-沙盘与图集/景平六年春-河朔delta.json",
		);
		expect(diff.changedCellCount).toBe(2);
		const northDelta = diff.stateDeltas.find((d) => d.stateName === "北周")!;
		expect(northDelta).toMatchObject({
			beforeCells: 3,
			afterCells: 1,
			netCells: -2,
			gainedCells: 0,
			lostCells: 2,
			beforePersonnel: 12000,
			afterPersonnel: 9500,
			netPersonnel: -2500,
		});
		const southDelta = diff.stateDeltas.find((d) => d.stateName === "南楚")!;
		expect(southDelta).toMatchObject({
			beforeCells: 2,
			afterCells: 4,
			netCells: 2,
			gainedCells: 2,
			lostCells: 0,
			beforePersonnel: 8000,
			afterPersonnel: 11000,
			netPersonnel: 3000,
		});
		expect(diff.transferredBurgs).toHaveLength(1);
		expect(diff.transferredBurgs[0]).toMatchObject({
			burgName: "临河渡",
			isPort: true,
			fromStateName: "北周",
			toStateName: "南楚",
			sector: "中枢",
		});
		expect(diff.addedBurgs).toEqual(["新筑寨"]);
		expect(diff.removedBurgs).toEqual(["凉州"]);
		expect(diff.beforeTotalPersonnel).toBe(20000);
		expect(diff.afterTotalPersonnel).toBe(20500);
		expect(diff.netTotalPersonnel).toBe(500);
		expect(diff.frontlineDelta).toBe(1);
		expect(diff.summaryText).toContain("临河渡：北周→南楚");
	});

	it("saveMapSnapshot 拒绝非法 JSON 与路径穿越，合法快照原子落盘并发出 workspace_changed 事件", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-map-save-"));
		tempDirs.push(root);
		await mkdir(join(root, "private"), { recursive: true });
		await writeFile(join(root, "private", "secret.json"), JSON.stringify({ secret: true }), "utf8");

		const validJson = makeProjectV4Json({
			statesByCell: [1, 1, 2, 2],
			burgs: [{ i: 1, name: "清源城", x: 500, y: 200, cell: 0, state: 1, capital: 1, port: 0, population: 10 }],
			garrisons: [],
		});

		// 路径穿越与非法文件名拦截
		await expect(saveMapSnapshot(root, "../escape.json", validJson)).rejects.toThrow("非法快照文件名");
		await expect(saveMapSnapshot(root, "private/hack.json", validJson)).rejects.toThrow("非法快照文件名");
		await expect(saveMapSnapshot(root, "sub\\hack.json", validJson)).rejects.toThrow("非法快照文件名");

		// 非法 JSON / 普通非地图 JSON 拦截
		await expect(saveMapSnapshot(root, "bad.json", "{not-json")).rejects.toThrow("必须是合法的");
		await expect(saveMapSnapshot(root, "plain.json", JSON.stringify({ hello: "world" }))).rejects.toThrow("必须是合法的");

		// readMapSnapshotRaw 禁止读取 private/ 与路径穿越
		await expect(readMapSnapshotRaw(root, "private/secret.json")).rejects.toThrow("禁止访问");
		await expect(readMapSnapshotRaw(root, "../outside.json")).rejects.toThrow("非法地图快照路径");

		// 合法保存经 WenyouService 原子写盘并推送 workspace_changed
		const events: WenyouCanvasEvent[] = [];
		const service = new WenyouService((ev) => events.push(ev));
		const saved = await service.saveMapSnapshot(root, "景平七年春 沙盘快照", validJson);
		expect(saved.relPath).toBe("05-沙盘与图集/景平七年春-沙盘快照.json");
		expect(saved.format).toBe("wenyou-project");
		expect(saved.yearLabel).toBe("景平七年春");
		expect(existsSync(join(root, saved.relPath))).toBe(true);
		expect(events.some((e) => e.kind === "workspace_changed" && e.reason === "map_snapshot_saved")).toBe(true);

		const raw = await service.readMapSnapshotRaw(root, saved.relPath);
		expect(raw.fileName).toBe("景平七年春-沙盘快照.json");
		expect(raw.content).toBe(validJson);
		expect(await readFile(join(root, saved.relPath), "utf8")).toBe(validJson);
	});

	it("精确解析 wenyou-pixi-app v0.9.1 真实 BattleField 包装（known/unknown 兵力 count 与 placement 锚点）", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-map-v091-"));
		tempDirs.push(root);
		await mkdir(join(root, "05-沙盘与图集"), { recursive: true });

		const realV4Json = makeProjectV4Json({
			statesByCell: [0, 1, 1, 2, 2],
			burgs: [
				{ i: 1, name: "清源城", x: 500, y: 150, cell: 1, state: 1, capital: 1, port: 0, population: 15 },
				{ i: 2, name: "江陵港", x: 850, y: 700, cell: 3, state: 2, capital: 1, port: 1, population: 22 },
			],
			garrisons: [
				{
					id: "u-known",
					unitName: { state: "known", value: "禁军前锋" },
					side: { state: "known", value: "北周" },
					branch: { state: "known", value: "骑兵" },
					status: { state: "known", value: "行军" },
					personnel: { count: { state: "known", value: 4200 } },
				},
				{
					id: "u-unknown",
					unitName: { state: "known", value: "敌情未明偏师" },
					side: { state: "known", value: "南楚" },
					branch: { state: "unknown" },
					status: { state: "unknown", value: "不应泄露的旧值" },
					personnel: { count: { state: "unknown", value: 9999 } },
				},
			],
			deployments: [
				{
					unitId: "u-known",
					placement: { state: "known", value: { anchor: [512, 162], shape: "rect" } },
				},
				{
					unitId: "u-unknown",
					placement: { state: "unknown", value: { anchor: [850, 700], shape: "rect" } },
				},
			],
		});

		await writeFile(join(root, "05-沙盘与图集", "v091-real.json"), realV4Json, "utf8");
		const insp = await inspectMapSnapshot(root, "05-沙盘与图集/v091-real.json");

		const knownUnit = insp.units.find((u) => u.unitId === "u-known")!;
		expect(knownUnit).toMatchObject({
			name: "禁军前锋",
			side: "北周",
			branch: "骑兵",
			status: "行军",
			personnel: 4200,
			x: 512,
			y: 162,
			sector: "正北",
			nearestBurgName: "清源城",
		});

		const unknownUnit = insp.units.find((u) => u.unitId === "u-unknown")!;
		expect(unknownUnit.personnel).toBe(0);
		expect(unknownUnit.branch).toBeUndefined();
		expect(unknownUnit.status).toBeUndefined();
		expect(unknownUnit.x).toBeUndefined();
		expect(unknownUnit.y).toBeUndefined();
		expect(unknownUnit.nearestBurgName).toBeUndefined();

		const north = insp.states.find((s) => s.name === "北周")!;
		const south = insp.states.find((s) => s.name === "南楚")!;
		expect(north.totalPersonnel).toBe(4200);
		expect(south.totalPersonnel).toBe(0);
	});

	it("解析 wenyouImageBase 图片底图：按 Pointy-top Odd-R 动态推导六邻接邻国并计算真实公里里程", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-map-imgbase-"));
		tempDirs.push(root);
		await mkdir(join(root, "05-沙盘与图集"), { recursive: true });

		// hexRadius = 50 -> dx = 86.6025, dy = 75 -> width=300 => cols=4, height=200 => rows=3, 共 12 格
		const width = 300;
		const height = 200;
		const hexRadius = 50;
		const neighbors = buildOddRHexNeighbors(width, height, hexRadius);
		expect(neighbors).toHaveLength(12);
		// 验证对称性：若 j 在 neighbors[i] 中，则 i 必在 neighbors[j] 中
		for (let i = 0; i < neighbors.length; i += 1) {
			for (const nb of neighbors[i]!) {
				expect(neighbors[nb]).toContain(i);
			}
		}
		// 奇数行 row=1, col=1 (idx=5) 应与 row=0, col=1 (idx=1) 及 row=0, col=2 (idx=2) 相邻
		expect(neighbors[5]).toContain(1);
		expect(neighbors[5]).toContain(2);
		expect(neighbors[5]).not.toContain(0);

		// 涂色分布：state 1 占 (row=0,col=0)=0，state 2 占 (row=1,col=0)=4（与 0 相邻），state 3 占 (row=2,col=3)=11（与 1/2 均不接壤）
		const statesByCell = new Array<number>(12).fill(0);
		statesByCell[0] = 1;
		statesByCell[4] = 2;
		statesByCell[11] = 3;

		const imageSource = JSON.stringify({
			wenyouImageBase: 1,
			mapId: "img-guan-zhong-300x200-r50",
			name: "关中手绘图",
			width,
			height,
			hexRadius,
			imageUrl: "wenyou-asset://vault?cwd=demo&path=05-%E6%B2%99%E7%9B%98%E4%B8%8E%E5%9B%BE%E9%9B%86/guanzhong.png",
			imageRelPath: "05-沙盘与图集/guanzhong.png",
			mapWidthKm: 600, // kmPerPixel = 600 / 300 = 2 km/px
		});

		const imgProject = JSON.stringify({
			format: "wenyou-project",
			version: 4,
			activeMapId: "img-guan-zhong-300x200-r50",
			theaters: [
				{
					version: 4,
					map: {
						source: imageSource,
						name: "关中手绘图",
						mapId: "img-guan-zhong-300x200-r50",
						heights: new Array<number>(12).fill(25),
						statesByCell,
						provincesByCell: new Array<number>(12).fill(0),
						religionsByCell: new Array<number>(12).fill(0),
						// 注意：故意不存 states[].neighbors 也不存 cellNeighbors，检验后端动态六角推导
						states: [
							{ i: 0, name: "未划分" },
							{ i: 1, name: "秦军", color: "#ef4444" },
							{ i: 2, name: "晋军", color: "#3b82f6" },
							{ i: 3, name: "蜀军", color: "#22c55e" },
						],
						burgs: [
							{},
							{ i: 1, name: "长安", x: 50, y: 50, cell: 0, state: 1, capital: 1, port: 0, population: 30 },
							{ i: 2, name: "蒲坂", x: 150, y: 50, cell: 4, state: 2, capital: 1, port: 0, population: 20 },
							{ i: 3, name: "汉中", x: 50, y: 170, cell: 11, state: 3, capital: 1, port: 0, population: 15 },
						],
						provinces: [],
					},
					garrisons: [
						{
							id: "u-qin-1",
							unitName: { state: "known", value: "右扶风步卒" },
							side: { state: "known", value: "秦军" },
							personnel: { count: { state: "known", value: 6000 } },
						},
					],
					battle: {
						deployments: [
							{
								unitId: "u-qin-1",
								// 距长安 (50, 50) 恰好 3-4-5 三角形 25px -> 25 * 2 = 50.0 km
								placement: { state: "known", value: { anchor: [65, 70] } },
							},
						],
					},
					fieldBattles: [],
					tacticalItems: [],
				},
			],
		});

		await writeFile(join(root, "05-沙盘与图集", "active-sandbox.json"), imgProject, "utf8");
		const insp = await inspectMapSnapshot(root, "05-沙盘与图集/active-sandbox.json");

		expect(insp.baseKind).toBe("image");
		expect(insp.imageAssetPath).toBe("05-沙盘与图集/guanzhong.png");
		expect(insp.kmPerPixel).toBe(2);
		expect(insp.mapWidthKm).toBe(600);
		expect(insp.width).toBe(300);
		expect(insp.height).toBe(200);

		// 验证六角邻接推导出的精确邻国
		const qin = insp.states.find((s) => s.name === "秦军")!;
		const jin = insp.states.find((s) => s.name === "晋军")!;
		const shu = insp.states.find((s) => s.name === "蜀军")!;
		expect(qin.neighborStateNames).toEqual(["晋军"]);
		expect(jin.neighborStateNames).toEqual(["秦军"]);
		expect(shu.neighborStateNames).toEqual([]);

		// 验证部队距最近城池直线公里数
		const unit = insp.units.find((u) => u.unitId === "u-qin-1")!;
		expect(unit.nearestBurgName).toBe("长安");
		expect(unit.nearestBurgDistanceKm).toBe(50);

		// 验证关键城际直线距离表（长安↔蒲坂=100px*2=200km，长安↔汉中=120px*2=240km，蒲坂↔汉中=sqrt(100^2+120^2)*2=312.4km）
		expect(insp.keyDistancesKm).toEqual([
			{ from: "长安", to: "蒲坂", distanceKm: 200 },
			{ from: "长安", to: "汉中", distanceKm: 240 },
			{ from: "蒲坂", to: "汉中", distanceKm: 312.4 },
		]);
	});

	it("多行 SVG FMG .map 精准对齐 lines[18] 高程、inclusive 编制兵力不翻倍、安全上限与隔海邻国不回退", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-map-fixes-"));
		tempDirs.push(root);
		await mkdir(join(root, "05-沙盘与图集"), { recursive: true });

		// 1. 多行 <svg> + lines[18] 为真实高程（3 格陆地）、lines[20] 为河流流量（故意全为 0）
		const fmgLines = new Array<string>(32).fill("");
		fmgLines[0] = "1.108.0|FMG|2026|9999|1000|800|multiline-svg";
		fmgLines[5] = "<svg viewBox=\"0 0 1000 800\">\n  <g id=\"ocean\">\n    <rect width=\"1000\" height=\"800\"/>\n  </g>\n</svg>";
		fmgLines[14] = JSON.stringify([
			{ i: 0, name: "Neutrals" },
			{ i: 1, name: "齐国", neighbors: [2], capital: 1 },
			{ i: 2, name: "楚国", neighbors: [1], capital: 2 },
		]);
		fmgLines[15] = JSON.stringify([
			{},
			{ i: 1, name: "临淄", x: 700, y: 200, cell: 1, state: 1, capital: 1, port: 1, population: 20 },
			{ i: 2, name: "郢都", x: 500, y: 650, cell: 3, state: 2, capital: 1, port: 0, population: 25 },
		]);
		fmgLines[18] = "10,30,35,40,15"; // 3 格 >= 20 的陆地
		fmgLines[20] = "0,0,0,0,0"; // 河流流量，绝不应被误当成 heights
		fmgLines[25] = "0,1,1,2,0";
		await writeFile(join(root, "05-沙盘与图集", "multiline.map"), fmgLines.join("\n"), "utf8");

		const fmgInsp = await inspectMapSnapshot(root, "05-沙盘与图集/multiline.map");
		expect(fmgInsp.totalLandCells).toBe(3);
		expect(fmgInsp.states.find((s) => s.name === "齐国")?.cellCount).toBe(2);
		expect(fmgInsp.burgs.find((b) => b.name === "临淄")?.isPort).toBe(true);

		// 2. inclusive 父编制存在子编制时，政权 totalPersonnel 与 diff 总兵力不得双倍叠加；
		//    同时存在 cellNeighbors 但两国隔海不接壤时，neighborStateNames 必须为空，不回退陈旧 st.neighbors
		const projA = makeProjectV4Json({
			statesByCell: [1, 0, 2],
			cellNeighbors: [[1], [0, 2], [1]], // 1 与 2 被 0 隔开，互不接壤
			burgs: [{ i: 1, name: "清源城", x: 500, y: 120, cell: 0, state: 1, capital: 1, port: 0, population: 10 }],
			garrisons: [
				{
					id: "corp-1",
					unitName: { state: "known", value: "北周第一军团" },
					side: { state: "known", value: "北周" },
					personnel: { count: { state: "known", value: 10000 }, scope: "inclusive" },
				},
				{
					id: "div-1",
					parentUnitId: "corp-1",
					unitName: { state: "known", value: "第一师" },
					side: { state: "known", value: "北周" },
					personnel: { count: { state: "known", value: 6000 }, scope: "exclusive" },
				},
				{
					id: "div-2",
					parentUnitId: "corp-1",
					unitName: { state: "known", value: "第二师" },
					side: { state: "known", value: "北周" },
					personnel: { count: { state: "known", value: 4000 }, scope: "exclusive" },
				},
			],
		});
		const projB = makeProjectV4Json({
			statesByCell: [1, 0, 2, 2], // 故意改变网格长度（4 vs 3）测试 diff 不错位比对 changedCellCount
			burgs: [{ i: 1, name: "清源城", x: 500, y: 120, cell: 0, state: 1, capital: 1, port: 0, population: 10 }],
			garrisons: [
				{
					id: "corp-1",
					unitName: { state: "known", value: "北周第一军团" },
					side: { state: "known", value: "北周" },
					personnel: { count: { state: "known", value: 9000 }, scope: "inclusive" },
				},
				{
					id: "div-1",
					parentUnitId: "corp-1",
					unitName: { state: "known", value: "第一师" },
					side: { state: "known", value: "北周" },
					personnel: { count: { state: "known", value: 5000 }, scope: "exclusive" },
				},
				{
					id: "div-2",
					parentUnitId: "corp-1",
					unitName: { state: "known", value: "第二师" },
					side: { state: "known", value: "北周" },
					personnel: { count: { state: "known", value: 4000 }, scope: "exclusive" },
				},
			],
		});
		await writeFile(join(root, "05-沙盘与图集", "t1-inclusive.json"), projA, "utf8");
		await writeFile(join(root, "05-沙盘与图集", "t2-inclusive.json"), projB, "utf8");

		const inspA = await inspectMapSnapshot(root, "05-沙盘与图集/t1-inclusive.json");
		const northA = inspA.states.find((s) => s.name === "北周")!;
		expect(northA.totalPersonnel).toBe(10000); // 6000 + 4000，绝不是 20000
		expect(northA.neighborStateNames).toEqual([]); // 不回退 st.neighbors: [2]

		const diffAB = await diffMapSnapshots(root, "05-沙盘与图集/t1-inclusive.json", "05-沙盘与图集/t2-inclusive.json");
		expect(diffAB.beforeTotalPersonnel).toBe(10000);
		expect(diffAB.afterTotalPersonnel).toBe(9000);
		expect(diffAB.netTotalPersonnel).toBe(-1000);
		expect(diffAB.changedCellCount).toBe(0); // 网格长度不一致时不按格错位比对

		// 3. 安全上限与 hexRadius 钳制
		expect(() => decodeCellLayerRle({ encoding: "rle-v1", cellCount: 3_000_000, runs: [1, 3_000_000] })).toThrow("超出安全上限");
		expect(() => buildOddRHexNeighbors(50_000, 50_000, 4)).toThrow("超出安全上限");
		expect(buildOddRHexNeighbors(40, 30, 1)).toEqual(buildOddRHexNeighbors(40, 30, 4));

		// 4. wenyou-map-delta 支持 overlay.source 中的 wenyouImageBase 比例尺与 hexRadius
		const imgDelta = JSON.stringify({
			format: "wenyou-map-delta",
			version: 2,
			activeMapId: "img-delta-300x200",
			theaters: [
				{
					baseMapId: "img-delta-300x200",
					mapName: "江东图片增量",
					overlay: {
						source: JSON.stringify({
							wenyouImageBase: 1,
							width: 300,
							height: 200,
							hexRadius: 50,
							imageRelPath: "05-沙盘与图集/jd.png",
							mapWidthKm: 600,
						}),
						heights: encodeCellLayerRle(new Array<number>(12).fill(25), 100),
						statesByCell: encodeCellLayerRle([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0], 65535),
						states: [
							{ i: 1, name: "吴" },
							{ i: 2, name: "越" },
						],
						burgs: [{ i: 1, name: "吴郡", x: 50, y: 50, cell: 0, state: 1, capital: 1, port: 0, population: 10 }],
						provinces: [],
					},
					garrisons: [],
					battle: { deployments: [] },
					fieldBattles: [],
					tacticalItems: [],
				},
			],
		});
		await writeFile(join(root, "05-沙盘与图集", "img-delta.json"), imgDelta, "utf8");
		const deltaInsp = await inspectMapSnapshot(root, "05-沙盘与图集/img-delta.json");
		expect(deltaInsp.baseKind).toBe("image");
		expect(deltaInsp.mapWidthKm).toBe(600);
		expect(deltaInsp.kmPerPixel).toBe(2);
		expect(deltaInsp.states.find((s) => s.name === "吴")?.neighborStateNames).toEqual(["越"]);
	});
});
