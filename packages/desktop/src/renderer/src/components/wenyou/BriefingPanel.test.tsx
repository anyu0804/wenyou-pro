import { describe, expect, it } from "vitest";
import { isLikelySourceId, parseSourceLinkSegments } from "./BriefingPanel";

describe("BriefingPanel [sourceId] 溯源胶囊识别", () => {
	it("识别离线导入群号、group-main、英文 slug、中文群名、碰撞序号后缀与 NTQQ/旧前缀 sourceId", () => {
		for (const id of [
			"123456789-a1b2c3d4",
			"123456789-a1b2c3d4-2",
			"group-main-0f1e2d3c",
			"diplomacy-chat-deadbeef",
			"大唐主群-12345678",
			"大唐主群-deadbeef-12",
			"河西密议群-9a8b7c6d",
			"main-a1b2c3",
			"main-a1b2c3-2",
			"ntqq-10001-42",
			"qq-10001-42-1",
			"src-01",
			"msg_42",
			"ev-7",
		]) {
			expect(isLikelySourceId(id), `应识别 sourceId: ${id}`).toBe(true);
		}
	});

	it("结合 coveredSourceIds 精确命中任意显式 sourceId", () => {
		const known = new Set(["custom-archive-entry-1"]);
		expect(isLikelySourceId("custom-archive-entry-1", known)).toBe(true);
		const segs = parseSourceLinkSegments("详情见 [custom-archive-entry-1] 原始记录。", known);
		expect(segs).toEqual([
			{ kind: "text", text: "详情见 ", offset: 0 },
			{ kind: "source", id: "custom-archive-entry-1", raw: "[custom-archive-entry-1]", offset: 4 },
			{ kind: "text", text: " 原始记录。", offset: 28 },
		]);
	});

	it("绝不把普通中文方括号词、日期、Markdown 链接或普通英文词误判为 sourceId", () => {
		for (const nonId of [
			"未定案草案",
			"已核实",
			"2026-03-15",
			"next-decade",
			"next-decade-2",
			"event",
			"河西-北周",
		]) {
			expect(isLikelySourceId(nonId), `不应误判: ${nonId}`).toBe(false);
		}

		const text =
			"[未定案草案] 详见 [河西主群-a1b2c3d4]、[123456789-a1b2c3d4-2] 与 [点击查看](https://example.com) 以及 [123456789-0f1e2d3c](https://example.com) 还有 [ntqq-9988-12]。";
		const segs = parseSourceLinkSegments(text);
		const sources = segs.filter((s) => s.kind === "source").map((s) => s.id);
		expect(sources).toEqual(["河西主群-a1b2c3d4", "123456789-a1b2c3d4-2", "ntqq-9988-12"]);
	});
});
