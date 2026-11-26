import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { computeCrc32 } from "../src/wenyou/docx-builder";
import { WenyouService } from "../src/wenyou/service";

const DEMO_DIR = resolve(__dirname, "../../../fixtures/demo-campaign");

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

describe("开箱演示推演夹具 fixtures/demo-campaign 完整性验证", () => {
	it("具备三群证据、未汇报增量、可点击 sourceRefs 示范局势书、规范 .docx 国策、双年代 SVG 地图与干净档案", async () => {
		const service = new WenyouService();
		const overview = await service.getOverview(DEMO_DIR);

		expect(overview.initialized).toBe(true);
		expect(overview.worldTitle).toContain("沧澜纪元");
		expect(overview.cursors.length).toBe(3);
		expect(overview.totalEvidenceCount).toBeGreaterThanOrEqual(12);
		expect(overview.unreportedCount).toBeGreaterThan(0);

		// 局势书与所有 sourceRefs 均可点击回查
		expect(overview.briefings.length).toBeGreaterThanOrEqual(1);
		const briefing = overview.briefings[0]!;
		expect(briefing.headline.length).toBeGreaterThan(0);
		expect(briefing.progressItems.length).toBeGreaterThanOrEqual(2);
		expect(briefing.intelChecks.some((c) => c.reliability === "propaganda")).toBe(true);
		expect(briefing.intelChecks.some((c) => c.reliability === "gm_fact")).toBe(true);
		for (const ref of briefing.coveredSourceIds) {
			const ctx = await service.lookupSource(DEMO_DIR, ref, 10);
			expect(ctx).not.toBeNull();
		}

		// 滚动台账含 [未定案草案] 隔离条目
		expect(overview.rollingLedger.some((e) => e.category === "unconfirmed_draft" && e.tag === "[未定案草案]")).toBe(
			true,
		);

		// 国策 .md 与 .docx 均存在且不含硬编码个人署名
		expect(overview.policies.length).toBeGreaterThanOrEqual(1);
		const policy = overview.policies[0]!;
		expect("lintReport" in policy).toBe(false);
		expect(policy.docxPath).toBeTruthy();
		const docxAbs = resolve(DEMO_DIR, policy.docxPath!);
		expect(existsSync(docxAbs)).toBe(true);
		const coreXml = readDocxCoreXml(await readFile(docxAbs));
		expect(coreXml).toContain("<dc:creator></dc:creator>");
		expect(coreXml).not.toContain("安钰");

		// 两张不同年代高清 SVG 地图可供双屏比对
		expect(overview.maps.length).toBe(2);
		expect(overview.maps.every((m) => m.ext === ".svg" && m.assetUrl.startsWith("wenyou-asset://vault?"))).toBe(
			true,
		);

		// 设定与编年史档案就绪且不含 :::secret / visibility 元数据
		expect(overview.canonDocs.length).toBeGreaterThanOrEqual(3);
		for (const doc of overview.canonDocs) {
			expect(doc.kind === "setting" || doc.kind === "chronicle").toBe(true);
			const readRes = await service.readCanonDoc(DEMO_DIR, doc.relPath);
			expect(readRes.content).not.toContain(":::secret");
		}
		await expect(service.readCanonDoc(DEMO_DIR, "private/gm-secret-notes.md")).rejects.toThrow("private/");
		await expect(service.readCanonDoc(DEMO_DIR, "00-群聊收集/主群_group-main-1001.txt")).rejects.toThrow("00-群聊收集");
	});
});
