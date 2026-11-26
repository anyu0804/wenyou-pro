import { describe, expect, it } from "vitest";
import { lintPolicyDraft } from "../src/wenyou/policy-lint";

describe("确定性国策静态门禁 lintPolicyDraft", () => {
	it("拦截 Markdown 表格、多层嵌套清单与 AI 公文套话，并产出修改指令", () => {
		const badDraft = [
			"## 预算表",
			"| 项目 | 金额 |",
			"| --- | --- |",
			"| 军费 | 十万两 |",
			"",
			"- 第一项措施",
			"  - 嵌套子项措施",
			"",
			"本轮改革要做好顶层设计，打出一套组合拳，先把规矩立住、攒下班底，既稳住了边防又激活了经济。",
		].join("\n");

		const report = lintPolicyDraft(badDraft);
		expect(report.passed).toBe(false);
		const codes = new Set(report.issues.map((i) => i.code));
		expect(codes.has("FORBIDDEN_MARKDOWN_TABLE")).toBe(true);
		expect(codes.has("NESTED_LIST_VIOLATION")).toBe(true);
		expect(codes.has("CLICHE_PHRASE")).toBe(true);
		expect(report.rewriteInstructions).toContain("重写要求");
	});

	it("拦截跨阵营超游透题与跨时间线穿帮", () => {
		const draft = "我军预先在芦苇荡水鬼营伏击，并援引景平八年冬大捷的旧例布置阵地。";
		const report = lintPolicyDraft(draft, {
			viewer: { kind: "faction", factionId: "north-zhou" },
			branchId: "main",
			currentOrder: 2,
			entities: [
				{
					id: "secret-ambush",
					title: "芦苇荡水鬼营",
					visibility: "gm",
				},
				{
					id: "future-battle",
					title: "景平八年冬大捷",
					visibility: "public",
					branch: "main",
					firstOrder: 8,
				},
			],
		});
		expect(report.passed).toBe(false);
		expect(report.issues.map((i) => i.code)).toContain("CROSS_FACTION_LEAK");
		expect(report.issues.map((i) => i.code)).toContain("TIMELINE_ANACHRONISM");
	});

	it("纯手写抓大放小自然段国策一次通过", () => {
		const cleanDraft = [
			"## 一、固守清源与济水北岸",
			"",
			"南楚水师前锋虽已进驻临河渡南岸，但大型楼船受春汛水浅阻隔，短期难成渡河强攻之势。河阳镇眼下不必抽调朔北镇北防兵马，只须在临河渡北岸增设三座烽燧，并命清源城驻军将周边三县常平仓春粮八万石悉数收入城库，备足六十日守城用度。",
			"",
			"## 二、盐铁结盟牵制南楚西翼",
			"",
			"户部按期筹措官盐三万引送往凉州，并由河东铁监另拨精铁三千斤赠予西凉督军，换取其夏初遣轻骑游弋襄城外围，迫使南楚分兵回顾。",
		].join("\n");

		const report = lintPolicyDraft(cleanDraft);
		expect(report.passed).toBe(true);
		expect(report.issues).toHaveLength(0);
	});
});
