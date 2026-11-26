import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import { computeCrc32 } from "../src/wenyou/docx-builder";
import { ingestExternalMessages, pullQqGroupsIncremental } from "../src/wenyou/qq-ingest";
import { WenyouService } from "../src/wenyou/service";
import {
	assertPathInsideWorkspace,
	isPrivateVaultPath,
	normalizeVaultPath,
	parseMarkdownWithFrontmatter,
} from "../src/wenyou/vault-paths";

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

describe("WenyouService 端到端领域闭环", () => {
	it("完整覆盖建库、多群增量采集防重报、sourceId 上下文回查、局势书完整 headline 与游标推进、无静态门禁 .docx 生成、标准档案读取与路径保护", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-service-"));
		tempDirs.push(root);
		const events: WenyouCanvasEvent[] = [];
		const service = new WenyouService((ev) => events.push(ev));

		// 1. 初始化标准目录
		const init = await service.initCampaign(root, { worldTitle: "测试战役", currentEra: "景平六年春" });
		expect(init.initialized).toBe(true);
		expect(init.worldTitle).toBe("测试战役");
		expect("viewer" in init).toBe(false);
		expect("maxViewer" in init).toBe(false);

		// 2. 写入主群 .txt 与 骰子群 QCE .json
		const mainChat = Array.from({ length: 14 }, (_, idx) => {
			const n = String(idx + 1).padStart(2, "0");
			return `【北周】燕王(qq-demo-0002) 2026-11-25 19:${n}:00\n第${n}条战报：济水北岸哨骑巡防记录。`;
		}).join("\n\n");
		await writeFile(join(root, "00-群聊收集", "主群_group-main-1001.txt"), mainChat, "utf8");
		await writeFile(
			join(root, "00-群聊收集", "骰子群_group-dice-1002.json"),
			JSON.stringify({
				groupId: "group-dice-1002",
				groupName: "骰子群",
				messages: [
					{
						id: "dice-r1",
						sender: "【骰娘】青铜龟",
						timestamp: "2026-11-25 19:20:00",
						text: ".r 1d100 侦察检定 = 18/65 成功",
					},
				],
			}),
			"utf8",
		);

		const pull1 = await service.pullQq(root);
		expect(pull1.newlyIngested).toBe(15);
		expect(pull1.unreportedMessages).toHaveLength(15);
		expect("kind" in pull1.unreportedMessages[0]!).toBe(false);
		expect("visibility" in pull1.unreportedMessages[0]!).toBe(false);

		// 再次拉取必须幂等去重
		const pull2 = await service.pullQq(root);
		expect(pull2.newlyIngested).toBe(0);
		expect(pull2.skippedDuplicates).toBe(15);

		// 3. 按 sourceId 查前后 3 条上下文
		const target = pull1.unreportedMessages[7]!;
		const ctxWin = await service.lookupSource(root, target.sourceId, 3);
		expect(ctxWin).not.toBeNull();
		expect(ctxWin!.messages).toHaveLength(7); // 前3 + 自身 + 后3
		expect(ctxWin!.messages[ctxWin!.targetIndex]?.sourceId).toBe(target.sourceId);

		// 4. 发布局势简报（超过 160 字的完整 headline 绝不静默截断）并推进游标，同时写入 [未定案草案] 台账
		const longHeadline =
			"南楚前锋战船二十二艘与步卒水手一万一千人已进驻临河渡南岸新筑木栅水寨，但大型楼船受春汛水浅所限仍滞留广陵；经河阳镇斥候侦察检定与司历官正式裁定交叉核实，敌方主群宣称十万大军压境纯属心理威慑宣传。北周当下最忌自乱阵脚抽调白狼关朔北镇兵马冒险强渡，应以清源城为总枢收拢周边三县常平仓春粮八万石、沿济水北岸增筑烽燧三座，并按约交付河东官盐三万引以稳固西凉盟约。";
		expect(longHeadline.length).toBeGreaterThan(160);

		const pub = await service.publishBriefing({
			cwd: root,
			title: "景平六年春首次局势简报",
			turnLabel: "景平六年春",
			headline: `  ${longHeadline}  `,
			progressItems: [
				{ title: "南岸侦察落地", detail: "检定成功查明敌情", status: "settled", sourceRefs: ["dice-r1"] },
			],
			diplomacySummary: "南楚放话施压，西凉保持观望。",
			intelChecks: [
				{ claim: "南岸侦察结果", reliability: "gm_fact", verdict: "已由骰娘落地", sourceRefs: ["dice-r1"] },
			],
			strategicJudgment: "固守清源、加筑烽燧，不轻率强渡。",
			ledgerUpdates: [
				{ category: "unconfirmed_draft", faction: "北周", summary: "夜袭南岸方案尚在内阁争论", sourceRefs: [target.sourceId] },
			],
		});
		expect(pub.briefing.headline).toBe(longHeadline);
		expect(pub.advancedGroups.sort()).toEqual(["group-dice-1002", "group-main-1001"]);
		expect(events.some((e) => e.kind === "briefing_published")).toBe(true);

		// 游标推进后未汇报应归零
		const pullAfterReport = await service.pullQq(root);
		expect(pullAfterReport.unreportedMessages).toHaveLength(0);

		const overviewAfter = await service.getOverview(root);
		expect(overviewAfter.briefings[0]?.headline).toBe(longHeadline);
		expect(overviewAfter.rollingLedger[0]?.tag).toBe("[未定案草案]");
		expect(overviewAfter.rollingLedger[0]?.summary).toContain("[未定案草案]");

		// 5. writePolicyDocx 无静态门禁拦截，直接写出 .md 与 .docx；默认 creator 为空，传入 author 时写入 author
		const tablePolicy = await service.writePolicyDocx({
			cwd: root,
			title: "含表格群友归档国策",
			content: "我们要做好顶层设计。\n\n| A | B |\n| - | - |\n| 1 | 2 |",
		});
		expect(tablePolicy.ok).toBe(true);
		expect(tablePolicy.artifact?.docxPath).toBeTruthy();
		const defaultCoreXml = readDocxCoreXml(await readFile(join(root, tablePolicy.artifact!.docxPath!)));
		expect(defaultCoreXml).toContain("<dc:creator></dc:creator>");
		expect(defaultCoreXml).not.toContain("安钰");

		const authoredPolicy = await service.writePolicyDocx({
			cwd: root,
			title: "清源守备条陈",
			actor: "北周",
			turnLabel: "景平六年春",
			author: "河阳幕府",
			content:
				"河阳镇今春以守为先，清源城收拢周边三县常平仓春粮八万石入库，临河渡北岸增筑烽燧三座，严密监视南岸水寨动向。",
		});
		expect(authoredPolicy.ok).toBe(true);
		expect(authoredPolicy.artifact?.docxPath).toBeTruthy();
		expect(existsSync(join(root, authoredPolicy.artifact!.docxPath!))).toBe(true);
		const authoredCoreXml = readDocxCoreXml(await readFile(join(root, authoredPolicy.artifact!.docxPath!)));
		expect(authoredCoreXml).toContain("<dc:creator>河阳幕府</dc:creator>");
		expect(authoredCoreXml).toContain("<cp:lastModifiedBy>河阳幕府</cp:lastModifiedBy>");
		expect(events.some((e) => e.kind === "policy_written")).toBe(true);

		const mdRaw = await readFile(join(root, authoredPolicy.artifact!.markdownPath), "utf8");
		expect(mdRaw).not.toContain("visibility:");
		expect(mdRaw).not.toContain("visibleToFactions:");

		// 6. 标准目录档案索引仅扫描 01-设定与国力实册 与 04-编年史与条约，忽略旧版 wiki/ 与 chronicle/
		const canonRelPath = "04-编年史与条约/002-清源守备记.md";
		await writeFile(
			join(root, canonRelPath),
			"---\nid: ch-002\ntitle: 清源守备记\n---\n\n正文记录。",
			"utf8",
		);
		await mkdir(join(root, "wiki"), { recursive: true });
		await mkdir(join(root, "chronicle"), { recursive: true });
		await writeFile(join(root, "wiki", "legacy.md"), "# 旧版词条", "utf8");
		await writeFile(join(root, "chronicle", "legacy.md"), "# 旧版编年史", "utf8");

		const overviewWithCanon = await service.getOverview(root);
		expect(overviewWithCanon.canonDocs.some((d) => d.relPath === canonRelPath && d.kind === "chronicle")).toBe(true);
		expect(overviewWithCanon.canonDocs.some((d) => d.relPath.startsWith("wiki/"))).toBe(false);
		expect(overviewWithCanon.canonDocs.some((d) => d.relPath.startsWith("chronicle/"))).toBe(false);

		const canonRead = await service.readCanonDoc(root, canonRelPath);
		expect(canonRead).toEqual({ relPath: canonRelPath, content: "正文记录。" });

		// 7. readCanonDoc 拒绝路径穿越、00-群聊收集/ 与 private/
		await writeFile(join(root, "private", "secret.md"), "机密", "utf8");
		await expect(service.readCanonDoc(root, "00-群聊收集/主群_group-main-1001.txt")).rejects.toThrow("00-群聊收集");
		await expect(service.readCanonDoc(root, "private/secret.md")).rejects.toThrow("private/");
		await expect(service.readCanonDoc(root, "../escape.md")).rejects.toThrow("非法文档路径");
	});

	it("长程回溯突破旧 50 条上限、支持 earliest 追最早原话与时间线补抓不污染未汇报游标", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-long-lookback-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "传话溯源测试", currentEra: "景平七年" });

		const recentItems = Array.from({ length: 60 }, (_, idx) => {
			const seq = 101 + idx;
			const mm = String(Math.floor(idx / 60)).padStart(2, "0");
			const ss = String(idx % 60).padStart(2, "0");
			return {
				sourceId: `qq-900001-${seq}`,
				groupId: "900001",
				groupName: "文明不朽主群",
				role: "main" as const,
				sender: seq === 155 ? "传话玩家丙" : "群友",
				timestamp: `2026-11-26 12:${mm}:${ss}`,
				text: seq === 155 ? "听说盟约规定南境要割让三城" : `第${seq}条常规讨论`,
			};
		});
		await ingestExternalMessages(root, recentItems);

		await service.publishBriefing({
			cwd: root,
			title: "中期简报",
			turnLabel: "景平七年春",
			headline: "游标基线",
			progressItems: [],
			diplomacySummary: "平稳",
			intelChecks: [],
			strategicJudgment: "继续观察",
		});

		const olderItems = Array.from({ length: 100 }, (_, idx) => {
			const seq = 1 + idx;
			const hh = String(10 + Math.floor(idx / 60)).padStart(2, "0");
			const mm = String(idx % 60).padStart(2, "0");
			return {
				sourceId: `qq-900001-${seq}`,
				groupId: "900001",
				groupName: "文明不朽主群",
				role: "main" as const,
				sender: seq === 5 ? "GM艾露恩" : "群友",
				timestamp: `2026-11-20 ${hh}:${mm}:00`,
				text: seq === 5 ? "【裁定】盟约仅限通商互市，不涉及割让南境三城" : `早期第${seq}条记录`,
			};
		});
		const backfillRes = await ingestExternalMessages(root, [...olderItems, ...recentItems]);
		expect(backfillRes.newlyIngested).toBe(100);
		expect(backfillRes.skippedDuplicates).toBe(60);
		expect(backfillRes.totalEvidenceCount).toBe(160);
		expect(backfillRes.cursors[0]?.unreportedCount).toBe(0);

		const earliest = await service.searchSourcesWithStats(root, {
			keyword: "盟约",
			order: "earliest",
			limit: 1,
		});
		expect(earliest.totalScanned).toBe(160);
		expect(earliest.totalMatched).toBe(2);
		expect(earliest.records[0]?.sourceId).toBe("qq-900001-5");

		const latest = await service.searchSourcesWithStats(root, {
			keyword: "盟约",
			order: "latest",
			limit: 1,
		});
		expect(latest.records[0]?.sourceId).toBe("qq-900001-155");

		const ranged = await service.searchSourcesWithStats(root, {
			keyword: "盟约",
			since: "2026-11-20",
			until: "2026-11-21",
		});
		expect(ranged.totalMatched).toBe(1);
		expect(ranged.records[0]?.sourceId).toBe("qq-900001-5");

		const win = await service.lookupSource(root, "qq-900001-101", 80);
		expect(win).not.toBeNull();
		expect(win!.windowSize).toBe(80);
		expect(win!.totalGroupMessages).toBe(160);
		expect(win!.beforeRemaining).toBe(20);
		expect(win!.afterRemaining).toBe(0);
		expect(win!.messages).toHaveLength(140);
		expect(win!.messages[win!.targetIndex - 1]?.sourceId).toBe("qq-900001-100");
		expect(win!.messages[win!.targetIndex]?.sourceId).toBe("qq-900001-101");
	});

	it("serialNo 路径穿越拒绝仍严格生效", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-policy-sec-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "路径安全测试", currentEra: "景平六年春" });

		for (const badSerial of ["../escape", "a/b", "001\\evil", "..", "a".repeat(30)]) {
			await expect(
				service.writePolicyDocx({
					cwd: root,
					title: "测试",
					content: "清源城今春整顿常平仓春粮，按定额调配守军口粮，不作无谓轻进。",
					serialNo: badSerial,
				}),
			).rejects.toThrow("非法国策编号");
		}
	});

	it("publishBriefing 删旧不撞号、游标单调不倒退与未指定 coveredSourceIds 不卡死未报队列", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-briefing-seq-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "游标测试", currentEra: "T1" });

		await ingestExternalMessages(root, [
			{ sourceId: "m-1", groupId: "g1", groupName: "主群", sender: "甲", timestamp: "2026-11-26 10:00:00", text: "第一条" },
			{ sourceId: "m-2", groupId: "g1", groupName: "主群", sender: "乙", timestamp: "2026-11-26 10:01:00", text: "第二条" },
			{ sourceId: "m-3", groupId: "g1", groupName: "主群", sender: "丙", timestamp: "2026-11-26 10:02:00", text: "第三条" },
		]);

		const p1 = await service.publishBriefing({
			cwd: root,
			title: "首报",
			turnLabel: "T1",
			headline: "首报结论",
			progressItems: [{ title: "事项一", detail: "详述", status: "settled", sourceRefs: ["m-1"] }],
			diplomacySummary: "平稳",
			intelChecks: [],
			strategicJudgment: "稳守",
		});
		expect(p1.briefing.id).toBe("briefing-001");
		const ov1 = await service.getOverview(root);
		expect(ov1.cursors[0]?.lastReportedSourceId).toBe("m-3");
		expect(ov1.unreportedCount).toBe(0);

		const p2 = await service.publishBriefing({
			cwd: root,
			title: "回溯简报",
			turnLabel: "T1",
			headline: "回溯复盘",
			progressItems: [{ title: "复盘", detail: "回看旧条", status: "settled", sourceRefs: ["m-1"] }],
			diplomacySummary: "平稳",
			intelChecks: [],
			strategicJudgment: "保持",
			coveredSourceIds: ["m-1"],
		});
		expect(p2.briefing.id).toBe("briefing-002");
		const ov2 = await service.getOverview(root);
		expect(ov2.cursors[0]?.lastReportedSourceId).toBe("m-3");
		expect(ov2.unreportedCount).toBe(0);

		await rm(join(root, p1.briefing.jsonPath), { force: true });
		await rm(join(root, p1.briefing.markdownPath), { force: true });
		const p3 = await service.publishBriefing({
			cwd: root,
			title: "第三报",
			turnLabel: "T2",
			headline: "新局势",
			progressItems: [],
			diplomacySummary: "变动",
			intelChecks: [],
			strategicJudgment: "跟进",
		});
		expect(p3.briefing.id).toBe("briefing-003");
		expect(existsSync(join(root, p2.briefing.jsonPath))).toBe(true);
	});

	it("vault-paths 路径与 frontmatter 解析，以及 qq-ingest 保留空/纯时分秒时间戳（不伪造 2026-01-01）", async () => {
		const parsed = parseMarkdownWithFrontmatter(
			"---   \rtitle: \"含 # 号标题\" # 注释\rturn: 6\r---  \r正文",
		);
		expect(parsed.data.title).toBe("含 # 号标题");
		expect(parsed.data.turn).toBe(6);
		expect(parsed.body).toBe("正文");
		expect(normalizeVaultPath("\\01-设定与国力实册\\./北周.md")).toBe("01-设定与国力实册/北周.md");
		expect(isPrivateVaultPath("private/note.md")).toBe(true);
		expect(isPrivateVaultPath(".wenyou/cursors.json")).toBe(true);
		expect(isPrivateVaultPath("01-设定与国力实册/北周.md")).toBe(false);

		const root = await mkdtemp(join(tmpdir(), "wenyou-ingest-edge-"));
		tempDirs.push(root);
		expect(() => assertPathInsideWorkspace(root, "../outside.txt")).toThrow("路径越界");
		await mkdir(join(root, "00-群聊收集"), { recursive: true });

		// 1. 外部导入缺省时间戳保留空串 ""，且不伪造 2026-01-01
		const r1 = await ingestExternalMessages(root, [
			{ sourceId: "qq-900-10", groupId: "900", groupName: "主群", sender: "甲", timestamp: "2026-11-26 12:00:00", text: "收到" },
			{ sourceId: "qq-900-11", groupId: "900", groupName: "主群", sender: "甲", timestamp: "2026-11-26 12:00:00", text: "收到" },
			{ sourceId: "qq-900-12", groupId: "900", groupName: "主群", sender: "乙", timestamp: "   ", text: "无时间戳外部消息" },
		]);
		expect(r1.newlyIngested).toBe(3);
		const r2 = await ingestExternalMessages(root, [
			{ sourceId: "qq-900-10", groupId: "900", groupName: "主群", sender: "甲", timestamp: "2026-11-26 12:00:00", text: "收到（改文）" },
		]);
		expect(r2.newlyIngested).toBe(0);
		expect(r2.skippedDuplicates).toBe(1);

		// 2. 纯文本缺少前置日期时保留 HH:MM:SS，短时间不误拆正文比分/时间；JSON 缺失时间保留 ""
		await writeFile(
			join(root, "00-群聊收集", "主群_group-main-777.txt"),
			[
				"先遣哨 09:15:30",
				"无前置日期的纯时分秒消息",
				"燕王 2026-11-26 10:00:00",
				"我军兵力对比，目前为 25:80",
				"预计抵达时间，大约 12:30",
				"周相 10:05",
				"明白，按计划行事。",
			].join("\n"),
			"utf8",
		);
		await writeFile(
			join(root, "00-群聊收集", "外交群_group-dip-888.json"),
			JSON.stringify({
				groupId: "group-dip-888",
				groupName: "外交群",
				messages: [{ id: "dip-1", sender: "西凉使节", text: "无时间戳 JSON 照会" }],
			}),
			"utf8",
		);

		const pulled = await pullQqGroupsIncremental(root);
		expect(pulled.newlyIngested).toBe(4);

		const service = new WenyouService();
		const allSearch = await service.searchSourcesWithStats(root, { limit: 50 });
		const timeOnlyRec = allSearch.records.find((m) => m.sender === "先遣哨");
		expect(timeOnlyRec?.timestamp).toBe("09:15:30");
		expect(timeOnlyRec?.timestamp).not.toContain("2026-01-01");

		const emptyJsonRec = allSearch.records.find((m) => m.sourceId === "dip-1");
		expect(emptyJsonRec?.timestamp).toBe("");
		expect(emptyJsonRec?.timestamp).not.toContain("2026-01-01");

		const emptyExtRec = allSearch.records.find((m) => m.sourceId === "qq-900-12");
		expect(emptyExtRec?.timestamp).toBe("");

		const mainRec = allSearch.records.find((m) => m.sender === "燕王");
		expect(mainRec?.text).toContain("25:80");
		expect(mainRec?.text).toContain("12:30");

		// 指定完整日期 since/until 过滤时，不会因空字符串或纯时分秒报错或误命中
		const dateFiltered = await service.searchSourcesWithStats(root, {
			since: "2026-11-26",
			until: "2026-11-26",
		});
		expect(dateFiltered.records.every((m) => m.timestamp.startsWith("2026-11-26"))).toBe(true);
		expect(dateFiltered.records.some((m) => m.sourceId === "dip-1")).toBe(false);
		expect(dateFiltered.records.some((m) => m.sender === "先遣哨")).toBe(false);
	});
});
