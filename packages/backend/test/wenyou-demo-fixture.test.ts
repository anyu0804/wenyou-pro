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
	it("具备三群证据、未汇报增量、可点击 sourceRefs 示范局势书、规范 .docx 国策、双年代 SVG 地图与待审提案", async () => {
		const service = new WenyouService();
		const overview = await service.getOverview(DEMO_DIR, "gm");

		expect(overview.initialized).toBe(true);
		expect(overview.worldTitle).toContain("沧澜纪元");
		expect(overview.cursors.length).toBe(3);
		expect(overview.totalEvidenceCount).toBeGreaterThanOrEqual(12);
		expect(overview.unreportedCount).toBeGreaterThan(0);

		// 局势书与所有 sourceRefs 均可点击回查
		expect(overview.briefings.length).toBeGreaterThanOrEqual(1);
		const briefing = overview.briefings[0]!;
		expect(briefing.headline.length).toBeLessThanOrEqual(120);
		expect(briefing.progressItems.length).toBeGreaterThanOrEqual(2);
		expect(briefing.intelChecks.some((c) => c.reliability === "propaganda")).toBe(true);
		expect(briefing.intelChecks.some((c) => c.reliability === "gm_fact")).toBe(true);
		for (const ref of briefing.coveredSourceIds) {
			const ctx = await service.lookupSource(DEMO_DIR, ref, 10, "gm");
			expect(ctx).not.toBeNull();
		}

		// 滚动台账含 [未定案草案] 隔离条目
		expect(overview.rollingLedger.some((e) => e.category === "unconfirmed_draft" && e.tag === "[未定案草案]")).toBe(
			true,
		);

		// 国策 .md 与 .docx 均存在且门禁通过、署名安钰
		expect(overview.policies.length).toBeGreaterThanOrEqual(1);
		const policy = overview.policies[0]!;
		expect(policy.lintReport.passed).toBe(true);
		expect(policy.docxPath).toBeTruthy();
		const docxAbs = resolve(DEMO_DIR, policy.docxPath!);
		expect(existsSync(docxAbs)).toBe(true);
		const coreXml = readDocxCoreXml(await readFile(docxAbs));
		expect(coreXml).toContain("<dc:creator>安钰</dc:creator>");

		// 两张不同年代高清 SVG 地图可供双屏比对
		expect(overview.maps.length).toBe(2);
		expect(overview.maps.every((m) => m.ext === ".svg" && m.assetUrl.startsWith("wenyou-asset://vault?"))).toBe(
			true,
		);

		// 待审提案就绪，且公开视角泄密预检拦截 private/ 与 00-群聊收集/ 并剥离 :::secret 块
		expect(overview.proposals.some((p) => p.proposalId === "prop-demo-001" && p.status === "pending")).toBe(true);
		const preflight = await service.exportPreflight(DEMO_DIR, "public");
		expect(preflight.blockedPrivateFiles.some((f) => f.includes("gm-secret-notes.md"))).toBe(true);
		expect(preflight.strippedSecretBlockCount).toBeGreaterThanOrEqual(2);
		expect(preflight.bundleJson).not.toContain("芦苇荡暗藏南楚水师斥候");
		expect(preflight.bundleJson).not.toContain("精铁三千斤");
	});
});
