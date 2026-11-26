import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import { makeWenyouExtension, WenyouService } from "../src/wenyou";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("makeWenyouExtension 9 工具注册与画布事件闭环", () => {
	it("注册全部 9 个核心文游工具并联动发射画布事件", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-ext-"));
		tempDirs.push(root);
		const events: WenyouCanvasEvent[] = [];
		const service = new WenyouService((ev) => events.push(ev));
		const ext = makeWenyouExtension({ service, cwd: root });

		const tools = new Map<string, ToolDefinition<any, any, any>>();
		const fakePi = {
			registerTool: (tool: ToolDefinition<any, any, any>) => {
				tools.set(tool.name, tool);
			},
			on: () => () => {},
		} as unknown as ExtensionAPI;

		if (typeof ext === "function") await ext(fakePi);
		else await ext.factory(fakePi);

		expect([...tools.keys()].sort()).toEqual([
			"wenyou_init_campaign",
			"wenyou_inspect_map",
			"wenyou_lookup_source",
			"wenyou_open_maps",
			"wenyou_propose_canon",
			"wenyou_publish_briefing",
			"wenyou_pull_qq",
			"wenyou_read_memory",
			"wenyou_write_policy_docx",
		]);

		const ctx = { cwd: root } as never;

		await tools.get("wenyou_init_campaign")!.execute("c1", { worldTitle: "扩展测试世界" }, undefined, undefined, ctx);

		// 准备一张测试地图用于 wenyou_open_maps
		await writeFile(join(root, "05-沙盘与图集", "t1-map.svg"), "<svg/>", "utf8");
		await writeFile(join(root, "05-沙盘与图集", "t2-map.svg"), "<svg/>", "utf8");

		// 坏国策被拦截并返回重写指令
		const badRes = await tools.get("wenyou_write_policy_docx")!.execute(
			"c2",
			{
				title: "测试疏",
				content: "先做好顶层设计并把规矩立住，让各方势力全面赋能，形成最强组合拳。",
			},
			undefined,
			undefined,
			ctx,
		);
		expect((badRes.content[0] as { text: string }).text).toContain("国策门禁未通过");

		// 改写后的干净国策放行并推画布事件
		const goodRes = await tools.get("wenyou_write_policy_docx")!.execute(
			"c3",
			{
				title: "清源守备疏",
				actor: "北周",
				turnLabel: "景平六年春",
				content: "今春清源城以稳固漕粮与烽燧为首务，河阳镇按驻地分兵值守，不作轻进。",
			},
			undefined,
			undefined,
			ctx,
		);
		expect((goodRes.content[0] as { text: string }).text).toContain("国策门禁全部通过");
		expect(events.some((e) => e.kind === "policy_written")).toBe(true);

		// 打开双图比对推画布事件
		await tools
			.get("wenyou_open_maps")!
			.execute("c4", { mode: "side-by-side", leftMap: "t1", rightMap: "t2" }, undefined, undefined, ctx);
		const mapEv = events.find((e) => e.kind === "open_maps");
		expect(mapEv).toMatchObject({
			kind: "open_maps",
			mode: "side-by-side",
			leftMapPath: "05-沙盘与图集/t1-map.svg",
			rightMapPath: "05-沙盘与图集/t2-map.svg",
		});

		// 准备两期推演快照，验证 wenyou_inspect_map 的 list / inspect / diff
		const makeSnapshot = (statesByCell: number[], burgState: number, troops: number) =>
			JSON.stringify({
				format: "wenyou-project",
				version: 4,
				activeMapId: "hebei-1000x1000",
				theaters: [
					{
						version: 4,
						map: {
							source: "1.154|fmg|2026|100|1000|1000|hebei",
							name: "河朔战区",
							mapId: "hebei-1000x1000",
							heights: [25, 25, 25, 25],
							statesByCell,
							provincesByCell: [0, 0, 0, 0],
							religionsByCell: [0, 0, 0, 0],
							states: [
								{ i: 0, name: "Neutrals" },
								{ i: 1, name: "北周", neighbors: [2], capital: 1 },
								{ i: 2, name: "南楚", neighbors: [1], capital: 2 },
							],
							burgs: [
								{},
								{ i: 1, name: "清源城", x: 500, y: 150, cell: 0, state: burgState, capital: 1, port: 0, population: 12 },
								{ i: 2, name: "江陵港", x: 820, y: 820, cell: 3, state: 2, capital: 1, port: 1, population: 18 },
							],
							provinces: [],
						},
						garrisons: [
							{
								id: "u-1",
								unitName: { value: "河阳镇步卒" },
								side: { value: "北周" },
								personnel: troops,
							},
						],
						battle: {
							deployments: [{ unitId: "u-1", placement: { anchor: [510, 160] } }],
						},
						fieldBattles: [],
						tacticalItems: [{ id: "fl-1", type: "frontline", points: [[400, 500], [600, 500]] }],
					},
				],
			});

		await writeFile(join(root, "05-沙盘与图集", "景平五年秋-河朔.json"), makeSnapshot([1, 1, 1, 2], 1, 12000), "utf8");
		await writeFile(join(root, "05-沙盘与图集", "景平六年春-河朔.json"), makeSnapshot([2, 1, 2, 2], 2, 9500), "utf8");

		const listRes = await tools.get("wenyou_inspect_map")!.execute("c5", { action: "list" }, undefined, undefined, ctx);
		expect((listRes.content[0] as { text: string }).text).toContain("共检出 2 份结构化地图快照");

		const inspectRes = await tools
			.get("wenyou_inspect_map")!
			.execute("c6", { action: "inspect", target: "景平五年秋", faction: "南楚" }, undefined, undefined, ctx);
		const inspectText = (inspectRes.content[0] as { text: string }).text;
		expect(inspectText).toContain("江陵港[首都][海港]");
		expect(inspectText).toContain("东南");
		expect(inspectText).toContain("北周");

		const diffRes = await tools
			.get("wenyou_inspect_map")!
			.execute("c7", { action: "diff", target: "景平五年秋", compareTo: "景平六年春" }, undefined, undefined, ctx);
		const diffText = (diffRes.content[0] as { text: string }).text;
		expect(diffText).toContain("变动地块：2 格");
		expect(diffText).toContain("清源城[首都]：北周 → 南楚");
		expect(diffText).toContain("12000→9500");

		// 验证 wenyou_inspect_map 对静态图片底图与比例尺公里数的格式化输出
		const imageSnapshot = JSON.stringify({
			format: "wenyou-project",
			version: 4,
			activeMapId: "img-demo-400x300-r50",
			theaters: [
				{
					version: 4,
					map: {
						source: JSON.stringify({
							wenyouImageBase: 1,
							mapId: "img-demo-400x300-r50",
							name: "江南战图",
							width: 400,
							height: 300,
							hexRadius: 50,
							imageUrl: "wenyou-asset://vault?cwd=demo&path=05/jn.png",
							imageRelPath: "05-沙盘与图集/jn.png",
							mapWidthKm: 800,
						}),
						name: "江南战图",
						mapId: "img-demo-400x300-r50",
						heights: new Array<number>(15).fill(25),
						statesByCell: [1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
						provincesByCell: new Array<number>(15).fill(0),
						religionsByCell: new Array<number>(15).fill(0),
						states: [
							{ i: 0, name: "未划分" },
							{ i: 1, name: "吴军" },
							{ i: 2, name: "越军" },
						],
						burgs: [
							{},
							{ i: 1, name: "姑苏", x: 100, y: 100, cell: 0, state: 1, capital: 1, port: 0, population: 25 },
							{ i: 2, name: "会稽", x: 200, y: 100, cell: 1, state: 2, capital: 1, port: 0, population: 18 },
						],
						provinces: [],
					},
					garrisons: [
						{ id: "u-wu", unitName: { state: "known", value: "吴郡水师" }, side: { state: "known", value: "吴军" }, personnel: { count: { state: "known", value: 5000 } } },
					],
					battle: {
						deployments: [{ unitId: "u-wu", placement: { state: "known", value: { anchor: [110, 100] } } }],
					},
					fieldBattles: [],
					tacticalItems: [],
				},
			],
		});
		await writeFile(join(root, "05-沙盘与图集", "active-sandbox.json"), imageSnapshot, "utf8");
		const imgInspectRes = await tools
			.get("wenyou_inspect_map")!
			.execute("c8", { action: "inspect", target: "active-sandbox" }, undefined, undefined, ctx);
		const imgInspectText = (imgInspectRes.content[0] as { text: string }).text;
		expect(imgInspectText).toContain("静态图片底图");
		expect(imgInspectText).toContain("比例尺：全图宽 800 km");
		expect(imgInspectText).toContain("近城 姑苏（约 20 km）");
		expect(imgInspectText).toContain("## 关键城际直线距离（km）");
		expect(imgInspectText).toContain("姑苏 ↔ 会稽：约 200 km");

		// 验证 wenyou_lookup_source 长程检索（order=earliest）与扩大窗口（window=60）联动 focus_source
		const chatLines = Array.from({ length: 130 }, (_, idx) => {
			const seq = idx + 1;
			const hh = String(10 + Math.floor(idx / 60)).padStart(2, "0");
			const mm = String(idx % 60).padStart(2, "0");
			const body =
				seq === 3
					? "【裁定】税率原话为十税一"
					: seq === 125
						? "听说税率涨到十税五了"
						: `常规议政第${seq}条`;
			return `发言人${seq}(qq-demo-${seq}) 2026-11-26 ${hh}:${mm}:00\n${body}`;
		}).join("\n\n");
		await writeFile(join(root, "00-群聊收集", "主群_group-main-2001.txt"), chatLines, "utf8");
		await tools.get("wenyou_pull_qq")!.execute("c9", {}, undefined, undefined, ctx);

		const earliestSearch = await tools.get("wenyou_lookup_source")!.execute(
			"c10",
			{ keyword: "税率", order: "earliest", limit: 1 },
			undefined,
			undefined,
			ctx,
		);
		const earliestText = (earliestSearch.content[0] as { text: string }).text;
		expect(earliestText).toContain("全库扫描 130 条，共命中 2 条（最早优先展示 1 条）");
		expect(earliestText).toContain("税率原话为十税一");

		const earliestIdMatch = earliestText.match(/\[(group-main-2001-[a-f0-9]+)\]/);
		expect(earliestIdMatch?.[1]).toBeTruthy();

		const wideCtx = await tools.get("wenyou_lookup_source")!.execute(
			"c11",
			{ sourceId: earliestIdMatch![1], window: 60 },
			undefined,
			undefined,
			ctx,
		);
		const wideText = (wideCtx.content[0] as { text: string }).text;
		expect(wideText).toContain("前后 ±60");
		expect(wideText).toContain("展示 63/130 条");
		expect(wideText).toContain("之后尚有 67 条");
		const focusEv = events.find((e) => e.kind === "focus_source");
		expect(focusEv).toMatchObject({
			kind: "focus_source",
			sourceId: earliestIdMatch![1],
			window: 60,
		});
	});

	it("tool_call 物理门控：所有视角阻断直改正史/国策，非 GM 视角阻断裸读密档/暗线块并走受控裁剪", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-ext-gate-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "物理门控测试", currentEra: "景平六年春" });

		await writeFile(
			join(root, "01-设定与国力实册", "北周.md"),
			"---\nid: north-zhou\ntitle: 北周实册\nvisibility: public\n---\n\n公开兵力三万。\n\n:::secret[gm]\nGM绝密伏兵情报\n:::\n",
			"utf8",
		);
		await writeFile(
			join(root, "01-设定与国力实册", "南楚密档.md"),
			"---\nid: chu-secret\ntitle: 南楚密档\nvisibility: faction\nvisibleToFactions: [south-chu]\n---\n\n南楚内部机密。",
			"utf8",
		);
		await writeFile(
			join(root, "01-设定与国力实册", "纯公开.md"),
			"---\nid: pub-only\ntitle: 纯公开\nvisibility: public\n---\n\n纯公开信息。",
			"utf8",
		);
		await writeFile(join(root, "private", "gm.md"), "裁判笔记", "utf8");
		await writeFile(join(root, "00-群聊收集", "密群_group-cabinet-1.txt"), "裁判 2026-11-26 10:00:00\n内部消息", "utf8");

		const ext = makeWenyouExtension({ service, cwd: root });
		const tools = new Map<string, ToolDefinition<any, any, any>>();
		let toolCallHandler: ((event: any, ctx: any) => Promise<any>) | undefined;
		const fakePi = {
			registerTool: (tool: ToolDefinition<any, any, any>) => {
				tools.set(tool.name, tool);
			},
			on: (event: string, handler: any) => {
				if (event === "tool_call") toolCallHandler = handler;
				return () => {};
			},
		} as unknown as ExtensionAPI;

		if (typeof ext === "function") await ext(fakePi);
		else await ext.factory(fakePi);
		expect(toolCallHandler).toBeDefined();

		const ctx = { cwd: root } as never;
		const fire = (toolName: string, input: Record<string, unknown>) =>
			toolCallHandler!({ type: "tool_call", toolCallId: "tc", toolName, input }, ctx);

		// 1. GM 视角下仍物理阻断 edit/write 直改正史、manifest.json 与 03-国策与文书/
		expect((await fire("write", { path: "01-设定与国力实册/北周.md", content: "篡改" }))?.block).toBe(true);
		expect((await fire("edit", { path: "04-编年史与条约/001.md" }))?.block).toBe(true);
		expect((await fire("write", { path: "manifest.json", content: "{}" }))?.block).toBe(true);
		expect((await fire("write", { path: "03-国策与文书/001-绕过门禁.md", content: "绕过" }))?.block).toBe(true);
		expect((await fire("bash", { command: "echo hack >> 01-设定与国力实册/北周.md" }))?.block).toBe(true);
		expect((await fire("bash", { command: "rm -rf private/proposals" }))?.block).toBe(true);
		// GM 视角读 private 放行
		expect(await fire("read", { path: "private/gm.md" })).toBeUndefined();

		// 2. 切到非 GM 视角（faction:north-zhou）
		await service.setViewerScope(root, "faction:north-zhou");

		// 物理阻断 read / ls / grep / find / show_image / bash 显式与隐式根路径、通配符绕过
		expect((await fire("read", { path: "private/gm.md" }))?.block).toBe(true);
		expect((await fire("ls", { path: ".wenyou" }))?.block).toBe(true);
		expect((await fire("ls", {}))?.block).toBe(true);
		expect((await fire("ls", { path: "." }))?.block).toBe(true);
		expect(await fire("ls", { path: "01-设定与国力实册" })).toBeUndefined();
		expect((await fire("grep", { pattern: "伏兵" }))?.block).toBe(true);
		expect((await fire("grep", { pattern: "伏兵", path: "." }))?.block).toBe(true);
		expect((await fire("find", {}))?.block).toBe(true);
		expect((await fire("read", { path: "00-群聊收集/密群_group-cabinet-1.txt" }))?.block).toBe(true);
		expect((await fire("ls", { path: "02-局势简报与台账" }))?.block).toBe(true);
		expect((await fire("show_image", { paths: ["private/map.png"] }))?.block).toBe(true);
		expect((await fire("bash", { command: "cat private/gm.md" }))?.block).toBe(true);
		expect((await fire("bash", { command: "grep -r 伏兵 ." }))?.block).toBe(true);
		expect((await fire("bash", { command: "cat 01*/北周.md" }))?.block).toBe(true);

		// 物理阻断裸 read 含 :::secret 的文档与不可见的他国文档；纯公开无暗线文档放行
		expect((await fire("read", { path: "01-设定与国力实册/北周.md" }))?.block).toBe(true);
		expect((await fire("read", { path: "01-设定与国力实册/南楚密档.md" }))?.block).toBe(true);
		expect(await fire("read", { path: "01-设定与国力实册/纯公开.md" })).toBeUndefined();

		// 3. wenyou_read_memory 必须走受控裁剪，绝不裸读泄密
		const memRes = await tools.get("wenyou_read_memory")!.execute("m1", {}, undefined, undefined, ctx);
		const memText = (memRes.content[0] as { text: string }).text;
		expect(memText).toContain("公开兵力三万");
		expect(memText).not.toContain("GM绝密伏兵情报");
		expect(memText).not.toContain("南楚内部机密");
	});
});
