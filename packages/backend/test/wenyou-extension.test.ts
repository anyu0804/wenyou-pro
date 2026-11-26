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

describe("makeWenyouExtension 8 工具注册与画布事件闭环", () => {
	it("注册全部 8 个核心文游工具并联动发射画布事件", async () => {
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
	});
});
