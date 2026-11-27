import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parsePolicyParagraphs, renderPolicyInlineRichText, sanitizePolicyFileName } from "./PolicyDeskPanel";

describe("PolicyDeskPanel 纸面预览分段与富文本", () => {
	it("按条陈与列表项（一、/1、/1./- /冒号条目）独立分段，不再压成一行", () => {
		const content = [
			"# 河西经略方略",
			"一、整饬边防：增调步骑三千驻守凉州。",
			"二、兴修水利：疏浚河西灌渠。",
			"1. **粮草调拨**：由关中转运十万石。",
			"2. **军械补给**：优先配发弓弩。",
			"1、先遣斥候探明敌情。",
			"- 保持与吐谷浑通商",
			"- 严密监视北周动向",
			"外交策应：遣使通好西域诸城。",
			"财政纪律: 核减冗费三成。",
		].join("\n");

		const parsed = parsePolicyParagraphs(content);
		expect(parsed.heading).toBe("河西经略方略");
		expect(parsed.blocks).toHaveLength(9);
		expect(parsed.blocks[0]?.text).toBe("一、整饬边防：增调步骑三千驻守凉州。");
		expect(parsed.blocks[1]?.text).toBe("二、兴修水利：疏浚河西灌渠。");
		expect(parsed.blocks[5]).toMatchObject({ kind: "list-item", bullet: true, text: "保持与吐谷浑通商" });
		expect(parsed.blocks[6]).toMatchObject({ kind: "list-item", bullet: true, text: "严密监视北周动向" });
		expect(parsed.blocks[7]?.text).toBe("外交策应：遣使通好西域诸城。");
		expect(parsed.blocks[8]?.text).toBe("财政纪律: 核减冗费三成。");
	});

	it("将 **加粗** 与 *斜体* 渲染为真实富文本节点，不裸露星号且不误伤算式乘号", () => {
		const html = renderToStaticMarkup(
			React.createElement(
				"p",
				null,
				...renderPolicyInlineRichText("**粮草调拨**：优先保障 *河西走廊*，配额 3 * 4 = 12 万石。"),
			),
		);
		expect(html).toContain("<strong");
		expect(html).toContain("粮草调拨");
		expect(html).toContain("<em");
		expect(html).toContain("河西走廊");
		expect(html).toContain("3 * 4 = 12");
		expect(html).not.toContain("**");
	});

	it("清洗国策另存为 .docx 的非法文件名字符、尾随点空格与保留设备名", () => {
		expect(sanitizePolicyFileName("001-河西/北周: 停战协议?.docx")).toBe("001-河西-北周-停战协议.docx");
		expect(sanitizePolicyFileName('002-多行\n标题*<>|"...  ')).toBe("002-多行-标题.docx");
		expect(sanitizePolicyFileName("CON.docx")).toBe("CON-doc.docx");
		expect(sanitizePolicyFileName("   /:*?   ")).toBe("国策文书.docx");
	});
});
