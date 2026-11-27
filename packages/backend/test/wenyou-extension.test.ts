import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import { computeCrc32, makeWenyouExtension, WenyouService } from "../src/wenyou";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function readDocxCoreXml(buf: Buffer): string {
	let offset = 0;
	while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
		const method = buf.readUInt16LE(offset + 8);
		const crc = buf.readUInt32LE(offset + 14);
		const compSize = buf.readUInt32LE(offset + 18);
		const nameLen = buf.readUInt16LE(offset + 26);
		const extraLen = buf.readUInt16LE(offset + 28);
		const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
		const dataStart = offset + 30 + nameLen + extraLen;
		const comp = buf.subarray(dataStart, dataStart + compSize);
		const raw = method === 8 ? inflateRawSync(comp) : comp;
		expect(computeCrc32(raw)).toBe(crc);
		if (name === "docProps/core.xml") return raw.toString("utf8");
		offset = dataStart + compSize;
	}
	throw new Error("docProps/core.xml missing");
}

describe("makeWenyouExtension 8 工具注册与画布事件闭环", () => {
	it("注册全部 8 个核心文游工具、无静态门禁/无 kind 标签/无 headline 截断并联动发射画布事件", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-ext-"));
		tempDirs.push(root);
		const events: WenyouCanvasEvent[] = [];
		const service = new WenyouService((ev) => events.push(ev));
		const ext = makeWenyouExtension({ service, cwd: root });

		const tools = new Map<string, ToolDefinition<any, any, any>>();
		const hooks = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
		const fakePi = {
			registerTool: (tool: ToolDefinition<any, any, any>) => {
				tools.set(tool.name, tool);
			},
			on: (event: string, handler: any) => {
				hooks.set(event, handler);
				return () => {};
			},
		} as unknown as ExtensionAPI;

		if (typeof ext === "function") await ext(fakePi);
		else await ext.factory(fakePi);

		expect([...tools.keys()].sort()).toEqual([
			"wenyou_init_campaign",
			"wenyou_inspect_map",
			"wenyou_lookup_source",
			"wenyou_open_maps",
			"wenyou_publish_briefing",
			"wenyou_pull_qq",
			"wenyou_read_memory",
			"wenyou_write_policy_docx",
		]);

		// 不再注册 tool_call 阻断钩子（不拦截 private/ 或 .wenyou/）
		expect(hooks.has("tool_call")).toBe(false);

		// schema 校验：headline 无 maxLength 上限；write_policy_docx 无 force 参数且有 author
		const pubSchema = JSON.parse(JSON.stringify(tools.get("wenyou_publish_briefing")!.parameters));
		expect(pubSchema.properties.headline.maxLength).toBeUndefined();
		const policySchema = JSON.parse(JSON.stringify(tools.get("wenyou_write_policy_docx")!.parameters));
		expect(policySchema.properties.force).toBeUndefined();
		expect(policySchema.properties.author).toBeDefined();

		const ctx = { cwd: root } as never;

		await tools.get("wenyou_init_campaign")!.execute("c1", { worldTitle: "扩展测试世界" }, undefined, undefined, ctx);

		// 准备测试地图用于 wenyou_open_maps
		await writeFile(join(root, "05-沙盘与图集", "t1-map.svg"), "<svg/>", "utf8");
		await writeFile(join(root, "05-沙盘与图集", "t2-map.svg"), "<svg/>", "utf8");

		// 直接写出含表格与任意措辞的国策（无静态门禁拒稿），并透传可选 author
		const policyRes = await tools.get("wenyou_write_policy_docx")!.execute(
			"c2",
			{
				title: "清源守备疏",
				actor: "北周",
				turnLabel: "景平六年春",
				author: "北周史官",
				content: "| 项目 | 数额 |\n| --- | --- |\n| 春粮 | 八万石 |\n\n今春清源城以稳固漕粮与烽燧为首务，河阳镇按驻地分兵值守，不作轻进。",
			},
			undefined,
			undefined,
			ctx,
		);
		const policyText = (policyRes.content[0] as { text: string }).text;
		expect(policyText).toContain("03-国策与文书/");
		expect(policyText).not.toContain("国策门禁");
		expect(events.some((e) => e.kind === "policy_written")).toBe(true);
		const policyDocxPath = (policyRes.details as { docxPath: string }).docxPath;
		expect(readDocxCoreXml(await readFile(join(root, policyDocxPath)))).toContain("<dc:creator>北周史官</dc:creator>");

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

		// 验证 wenyou_pull_qq 与 wenyou_lookup_source 不输出 [kind] / (kind) 标签
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
		const pullRes = await tools.get("wenyou_pull_qq")!.execute("c9", {}, undefined, undefined, ctx);
		const pullText = (pullRes.content[0] as { text: string }).text;
		expect(pullText).not.toContain("[gm_ruling]");
		expect(pullText).not.toContain("[chat]");

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
		expect(wideText).not.toContain("(gm_ruling)");
		expect(wideText).not.toContain("(chat)");

		const focusEv = events.find((e) => e.kind === "focus_source");
		expect(focusEv).toMatchObject({
			kind: "focus_source",
			sourceId: earliestIdMatch![1],
			window: 60,
		});

		// 验证 wenyou_publish_briefing 完整保留超过 160 字的 headline
		const longHeadline =
			"南楚前锋战船二十二艘与步卒水手一万一千人已进驻临河渡南岸新筑木栅水寨，但大型楼船受春汛水浅所限仍滞留广陵；经河阳镇斥候侦察检定与司历官正式裁定交叉核实，敌方主群宣称十万大军压境纯属心理威慑宣传。北周当下最忌自乱阵脚抽调白狼关朔北镇兵马冒险强渡，应以清源城为总枢收拢周边三县常平仓春粮八万石、沿济水北岸增筑烽燧三座，并按约交付河东官盐三万引以稳固西凉盟约。";
		expect(longHeadline.length).toBeGreaterThan(160);
		await tools.get("wenyou_publish_briefing")!.execute(
			"c12",
			{
				title: "河朔长结论局势简报",
				turnLabel: "景平六年春",
				headline: longHeadline,
				progressItems: [],
				diplomacySummary: "平稳",
				intelChecks: [],
				strategicJudgment: "固守待变",
			},
			undefined,
			undefined,
			ctx,
		);
		const publishedBriefings = await service.listBriefings(root);
		expect(publishedBriefings[0]?.headline).toBe(longHeadline);

		// 验证 context_with_system 注入不含 ViewerScope / maxViewer / :::secret / force=true / 静态门禁
		const ctxHook = hooks.get("context_with_system")!;
		expect(ctxHook).toBeDefined();
		const injected = await ctxHook({ messages: [] }, ctx);
		const note = injected.messages[0].content as string;
		expect(note).toContain("扩展测试世界");
		expect(note).not.toMatch(/ViewerScope|maxViewer|:::secret|force=true|国策门禁/);
	});

	it("wenyou_read_memory 在超量档案与超长文档下附带全量索引与截断提示", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-ext-mem-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "记忆读取测试", currentEra: "景平六年春" });

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

		for (let idx = 1; idx <= 14; idx += 1) {
			const pad = String(idx).padStart(2, "0");
			const longText = idx === 1 ? "甲".repeat(2800) : `国家${pad}基础实册`;
			await writeFile(
				join(root, "01-设定与国力实册", `国${pad}.md`),
				`---\nid: state-${pad}\ntitle: 国家${pad}\n---\n\n${longText}`,
				"utf8",
			);
		}
		await writeFile(
			join(root, "04-编年史与条约", "001-盟约.md"),
			"---\nid: ch-001\ntitle: 济水盟约\n---\n\n盟约正文。",
			"utf8",
		);
		const ctx = { cwd: root } as never;
		const memRes = await tools.get("wenyou_read_memory")!.execute("m0", {}, undefined, undefined, ctx);
		const memText = (memRes.content[0] as { text: string }).text;
		expect(memText).toContain("已截断，原文共");
		expect(memText).toContain("全量设定与编年史档案索引");
		expect(memText).toContain("[未展开实册]");
		expect(memText).toContain("[编年史/条约] 济水盟约");
	});

	it("Bug #5 & #22: 未读 > 80 条时未传 coveredSourceIds 仅推进已拉取展示窗口，不吞掉 81..N 未见消息，且损坏台账/简报不炸毁 read_memory", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-ext-window-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "游标防吞回归", currentEra: "T1" });

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

		const chatLines = Array.from({ length: 110 }, (_, idx) => {
			const seq = idx + 1;
			const hh = String(10 + Math.floor(idx / 60)).padStart(2, "0");
			const mm = String(idx % 60).padStart(2, "0");
			return `2026-11-26 ${hh}:${mm}:00 成员${seq}(1000${seq})\n消息内容第${seq}条`;
		}).join("\n\n");
		await writeFile(join(root, "00-群聊收集", "主群_group-big-1001.txt"), chatLines, "utf8");

		const ctx = { cwd: root } as never;

		// 第 1 次 pull 默认仅暴露前 80/110 条
		const pull1 = await tools.get("wenyou_pull_qq")!.execute("p1", {}, undefined, undefined, ctx);
		const pull1Text = (pull1.content[0] as { text: string }).text;
		expect(pull1Text).toContain("展示 80/110 条");
		expect(pull1Text).toContain("尚有 30 条未展示消息");

		// 发布简报时不传 coveredSourceIds：游标只能推进到第 80 条，绝不能吞掉 81..110
		const pub1 = await tools.get("wenyou_publish_briefing")!.execute(
			"b1",
			{
				title: "第一批简报",
				turnLabel: "T1",
				headline: "覆盖前 80 条",
				progressItems: [],
				diplomacySummary: "平稳",
				intelChecks: [],
				strategicJudgment: "继续拉取剩余消息",
			},
			undefined,
			undefined,
			ctx,
		);
		expect((pub1.details as { remainingUnreportedCount: number }).remainingUnreportedCount).toBe(30);

		// 第 2 次 pull 必须原样拿到剩余 30 条（81..110）
		const pull2 = await tools.get("wenyou_pull_qq")!.execute("p2", {}, undefined, undefined, ctx);
		const pull2Text = (pull2.content[0] as { text: string }).text;
		expect(pull2Text).toContain("展示 30/30 条");
		expect(pull2Text).toContain("消息内容第81条");
		expect(pull2Text).toContain("消息内容第110条");

		// 第 2 次发布简报后剩余未汇报归零
		const pub2 = await tools.get("wenyou_publish_briefing")!.execute(
			"b2",
			{
				title: "第二批简报",
				turnLabel: "T1",
				headline: "覆盖后 30 条",
				progressItems: [],
				diplomacySummary: "平稳",
				intelChecks: [],
				strategicJudgment: "全部消化",
			},
			undefined,
			undefined,
			ctx,
		);
		expect((pub2.details as { remainingUnreportedCount: number }).remainingUnreportedCount).toBe(0);

		// Bug #22: 注入缺字段简报与台账，wenyou_read_memory 仍正常输出
		await writeFile(
			join(root, "02-局势简报与台账", "briefings", "briefing-999-partial.json"),
			JSON.stringify({ id: "briefing-999", headline: "无时间残缺简报" }),
			"utf8",
		);
		await writeFile(
			join(root, "02-局势简报与台账", "rolling-ledger.json"),
			JSON.stringify({ entries: [{ id: "bad-1", category: "fact", summary: "无 sourceRefs 台账" }] }),
			"utf8",
		);
		const memRes = await tools.get("wenyou_read_memory")!.execute("m1", { maxBriefings: 5 }, undefined, undefined, ctx);
		const memText = (memRes.content[0] as { text: string }).text;
		expect(memText).toContain("无时间残缺简报");
		expect(memText).toContain("无 sourceRefs 台账");
	});
});
