import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildPolicyDocx, computeCrc32 } from "../src/wenyou/docx-builder";

/** 轻量 ZIP 解包验证器（直接校验 PKZIP 本地头、CRC32、DEFLATE 解压） */
function unzipEntries(buf: Buffer): Map<string, string> {
	const out = new Map<string, string>();
	let offset = 0;
	while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
		const method = buf.readUInt16LE(offset + 8);
		const crc = buf.readUInt32LE(offset + 14);
		const compSize = buf.readUInt32LE(offset + 18);
		const uncompSize = buf.readUInt32LE(offset + 22);
		const nameLen = buf.readUInt16LE(offset + 26);
		const extraLen = buf.readUInt16LE(offset + 28);
		const nameStart = offset + 30;
		const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
		const dataStart = nameStart + nameLen + extraLen;
		const compData = buf.subarray(dataStart, dataStart + compSize);
		const raw = method === 8 ? inflateRawSync(compData) : compData;
		expect(raw.length).toBe(uncompSize);
		expect(computeCrc32(raw)).toBe(crc);
		out.set(name, raw.toString("utf8"));
		offset = dataStart + compSize;
	}
	return out;
}

describe("纯 Node 原生 .docx 生成器", () => {
	it("生成合法 OOXML ZIP 包，包含固定署名安钰与中文排版规范", () => {
		const buf = buildPolicyDocx({
			title: "景平六年春北周整军理财疏",
			subtitle: "北周 · 景平六年春",
			bodyMarkdown: [
				"# 景平六年春北周整军理财疏",
				"",
				"## 一、固守清源与济水北岸",
				"",
				"南楚虽在南岸扩筑木栅，实到战船仅二十二艘。河阳镇当以**清源城**为枢轴，就近收拢三县常平仓春粮，不作无谓强渡。",
				"",
				"## 二、厚结西凉以牵制襄城",
				"",
				"按约交付官盐三万引，另从河东铁监匀拨精铁三千斤交西凉使节，换其夏初牵制南楚西翼。",
			].join("\n"),
			createdAt: "2026-11-26T00:00:00.000Z",
		});

		const entries = unzipEntries(buf);
		expect([...entries.keys()].sort()).toEqual([
			"[Content_Types].xml",
			"_rels/.rels",
			"docProps/app.xml",
			"docProps/core.xml",
			"word/_rels/document.xml.rels",
			"word/document.xml",
			"word/styles.xml",
		]);

		const core = entries.get("docProps/core.xml")!;
		expect(core).toContain("<dc:creator>安钰</dc:creator>");
		expect(core).toContain("<cp:lastModifiedBy>安钰</cp:lastModifiedBy>");
		expect(core).toContain("<dc:title>景平六年春北周整军理财疏</dc:title>");

		const styles = entries.get("word/styles.xml")!;
		expect(styles).toContain('w:eastAsia="SimSun"');
		expect(styles).toContain('w:sz w:val="21"');
		expect(styles).toContain('w:firstLineChars="200"');
		expect(styles).toContain('w:line="300"');

		const doc = entries.get("word/document.xml")!;
		// 居中 15pt (30 half-points) 标题
		expect(doc).toContain('<w:jc w:val="center"/>');
		expect(doc).toContain('<w:sz w:val="30"/>');
		// 行内粗体正确转换，不泄漏 ** 符号
		expect(doc).toContain("<w:b/><w:bCs/>");
		expect(doc).not.toContain("**清源城**");
		expect(doc).toContain("清源城");
	});

	it("单级有序列表独立分段保留序号，且剥离 XML 1.0 非法控制字符", () => {
		const buf = buildPolicyDocx({
			title: "清源军政条陈\x00\x07",
			bodyMarkdown: [
				"今春防务以稳守清源为主。",
				"1. 河阳镇收拢三县常平仓春粮八万石。",
				"2. 临河渡北岸增筑烽燧三座。",
				"一、官盐三万引按约发往凉州\x0B\x1F。",
			].join("\n"),
			createdAt: "2026-11-26T00:00:00.000Z",
		});

		const entries = unzipEntries(buf);
		const doc = entries.get("word/document.xml")!;
		const core = entries.get("docProps/core.xml")!;

		// 不含非法控制字符
		expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(doc)).toBe(false);
		expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(core)).toBe(false);

		// 每条有序列表均为独立 <w:p> 且保留原始序号，不粘连成同一段
		const paragraphs = [...doc.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);
		expect(paragraphs.some((p) => p.includes("今春防务以稳守清源为主。") && !p.includes("1. 河阳镇"))).toBe(true);
		expect(paragraphs.some((p) => p.includes("1. 河阳镇收拢三县常平仓春粮八万石。") && !p.includes("2. 临河渡"))).toBe(true);
		expect(paragraphs.some((p) => p.includes("2. 临河渡北岸增筑烽燧三座。"))).toBe(true);
		expect(paragraphs.some((p) => p.includes("一、官盐三万引按约发往凉州。"))).toBe(true);
	});
});
