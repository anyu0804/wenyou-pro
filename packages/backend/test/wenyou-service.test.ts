import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import { computeCrc32 } from "../src/wenyou/docx-builder";
import { inferGroupMeta, ingestExternalMessages, pullQqGroupsIncremental } from "../src/wenyou/qq-ingest";
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

	it("无日期与纯时分秒消息不阻塞后续带日期消息的未汇报游标，且 .txt 时间顺序不反转", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-undated-cursor-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "游标无日期回归", currentEra: "T1" });

		// 1. 先入库含空时间戳与纯时分秒的记录，再发布简报推进 lastReportedSourceId
		await ingestExternalMessages(root, [
			{ sourceId: "g1-empty", groupId: "g1", groupName: "主群", sender: "甲", timestamp: "", text: "无时间戳开场" },
			{ sourceId: "g1-timeonly", groupId: "g1", groupName: "主群", sender: "乙", timestamp: "09:15:30", text: "纯时分秒消息" },
		]);
		await service.publishBriefing({
			cwd: root,
			title: "首报",
			turnLabel: "T1",
			headline: "首报覆盖无日期记录",
			progressItems: [],
			diplomacySummary: "平稳",
			intelChecks: [],
			strategicJudgment: "继续",
		});

		const ovAfterFirst = await service.getOverview(root);
		expect(ovAfterFirst.unreportedCount).toBe(0);
		expect(ovAfterFirst.cursors[0]?.lastReportedSourceId).toBe("g1-timeonly");

		// 2. 随后新到来带完整日期的消息（包含触发重排的乱序日期），必须全部落在新未汇报队列尾部，绝不被吞掉
		await ingestExternalMessages(root, [
			{ sourceId: "g1-d2", groupId: "g1", groupName: "主群", sender: "丙", timestamp: "2026-11-26 11:00:00", text: "后发带日期消息" },
			{ sourceId: "g1-d1", groupId: "g1", groupName: "主群", sender: "丁", timestamp: "2026-11-26 10:00:00", text: "较早带日期消息" },
		]);
		const pulled = await service.pullQq(root);
		expect(pulled.unreportedMessages.map((m) => m.sourceId)).toEqual(["g1-d1", "g1-d2"]);
		const g1Cursor = pulled.cursors.find((c) => c.groupId === "g1");
		expect(g1Cursor?.unreportedCount).toBe(2);
		expect(g1Cursor?.lastIngestedSourceId).toBe("g1-d2");
		expect(g1Cursor?.lastIngestedTimestamp).toBe("2026-11-26 11:00:00");

		// 3. .txt 中纯时分秒在前、带日期在后，触发排序后仍保持纯时分秒在前、完整日期在后
		await writeFile(
			join(root, "00-群聊收集", "外交群_group-dip-200.txt"),
			[
				"先遣哨 09:15:30",
				"无前置日期消息",
				"燕王 2026-11-26 11:00:00",
				"较晚消息",
				"周相 2026-11-26 10:00:00",
				"较早消息",
			].join("\n"),
			"utf8",
		);
		const pullTxt = await service.pullQq(root, "group-dip-200");
		expect(pullTxt.unreportedMessages.map((m) => m.sender)).toEqual(["先遣哨", "周相", "燕王"]);
	});

	it("until/since 边界补齐 HH:MM / ISO-T / 纯日期，且 pullQqGroupsIncremental 优先按显式 JSON id 去重", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-bounds-dedup-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "边界与去重测试", currentEra: "T1" });

		await writeFile(
			join(root, "00-群聊收集", "主群_group-main-300.json"),
			JSON.stringify({
				groupId: "group-main-300",
				groupName: "主群",
				messages: [
					{ id: "m-t1", sender: "哨兵", timestamp: "09:15:30", text: "准点回报" },
					{ id: "m-t2", sender: "哨兵", timestamp: "09:16:00", text: "超出一分钟" },
					{ id: "m-iso", sender: "使节", timestamp: "2026-11-26T09:30:00Z", text: "ISO 格式时间" },
					{ id: "m-dateonly", sender: "史官", timestamp: "2026-11-26", text: "纯日期记录" },
					{ id: "m-dup-a", sender: "甲", timestamp: "", text: "收到" },
					{ id: "m-dup-b", sender: "甲", timestamp: "", text: "收到" },
					{ id: "m-dup-a", sender: "甲", timestamp: "", text: "收到（重复ID改文）" },
				],
			}),
			"utf8",
		);

		const pulled = await pullQqGroupsIncremental(root);
		expect(pulled.newlyIngested).toBe(6);
		expect(pulled.skippedDuplicates).toBe(1);
		expect(pulled.unreportedMessages.some((m) => m.sourceId === "m-dup-a")).toBe(true);
		expect(pulled.unreportedMessages.some((m) => m.sourceId === "m-dup-b")).toBe(true);

		const untilMinute = await service.searchSourcesWithStats(root, { until: "09:15" });
		expect(untilMinute.records.map((m) => m.sourceId)).toEqual(["m-t1"]);

		const fullDateRange = await service.searchSourcesWithStats(root, {
			since: "2026-11-26",
			until: "2026-11-26",
		});
		expect(fullDateRange.records.map((m) => m.sourceId).sort()).toEqual(["m-dateonly", "m-iso"]);
	});

	it("writePolicyDocx 拒绝空白标题、并发写串行编号不冲突、.docx 失败回滚 .md，且 readCanonDoc 拒绝目录目标", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-policy-atomic-"));
		tempDirs.push(root);
		const events: WenyouCanvasEvent[] = [];
		const service = new WenyouService((ev) => events.push(ev));
		await service.initCampaign(root, { worldTitle: "原子性测试", currentEra: "T1" });

		// 1. 空白标题返回 ok: false 且不落盘
		const blankRes = await service.writePolicyDocx({
			cwd: root,
			title: "   \t  ",
			content: "正文",
		});
		expect(blankRes.ok).toBe(false);
		expect(blankRes.error).toContain("不能为空");
		expect(await service.listPolicies(root)).toHaveLength(0);

		// 2. 并发写两份无显式编号的国策，经 workspace lock 串行获得 001 / 002 互不撞号
		const [p1, p2] = await Promise.all([
			service.writePolicyDocx({ cwd: root, title: "并发国策甲", content: "正文甲" }),
			service.writePolicyDocx({ cwd: root, title: "并发国策乙", content: "正文乙" }),
		]);
		expect(p1.ok).toBe(true);
		expect(p2.ok).toBe(true);
		expect([p1.artifact?.serialNo, p2.artifact?.serialNo].sort()).toEqual(["001", "002"]);
		expect(existsSync(join(root, p1.artifact!.docxPath!))).toBe(true);
		expect(existsSync(join(root, p2.artifact!.docxPath!))).toBe(true);

		// 3. 在目标 .docx 路径预先占一个目录导致 .docx 写入失败，必须返回 ok: false 并回滚新建的 .md（且不触发 policy_written）
		const beforeEventCount = events.length;
		const occupiedDocxPath = join(root, "03-国策与文书", "099-回滚校验.docx");
		const orphanMdPath = join(root, "03-国策与文书", "099-回滚校验.md");
		await mkdir(occupiedDocxPath, { recursive: true });
		const failRes = await service.writePolicyDocx({
			cwd: root,
			serialNo: "099",
			title: "回滚校验",
			content: "应当被回滚的国策正文",
		});
		expect(failRes.ok).toBe(false);
		expect(failRes.error).toBeTruthy();
		expect(existsSync(orphanMdPath)).toBe(false);
		expect(events.length).toBe(beforeEventCount);

		// 4. readCanonDoc 指向目录时抛出清晰错误
		await expect(service.readCanonDoc(root, "01-设定与国力实册")).rejects.toThrow("目标不是常规文件");
	});

	it("Bug #3 & #4: 标准 PC QQ 日期在前 .txt、行末 HH:MM:SS 不误拆，以及第三方/QCE JSON 时区/Unix时间戳/数字ID与 groupIdFilter 兼容", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-qq-formats-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "格式兼容测试", currentEra: "T1" });

		// 1. 标准 PC QQ 导出「日期在前」.txt（含 QQ号、邮箱、纯昵称、/分隔与单位时分秒，以及正文含 总攻时间： 08:30:00）
		await writeFile(
			join(root, "00-群聊收集", "主群_group-pc-1001.txt"),
			[
				"消息记录（此消息记录为文本格式，不支持重新导入）",
				"================================================================",
				"消息对象:河朔主群(900001)",
				"================================================================",
				"",
				"2026-11-26 08:01:02 【北周】燕王(12345678)",
				"今晨传令各营，总攻时间： 08:30:00",
				"务须按时集结，不得延误。",
				"",
				"2026-11-26 08:02:05 西凉使节<xiliang@example.com>",
				"西凉骑兵已在渡口待命。",
				"",
				"2026/11/26 8:5:9 司历GM",
				"【裁定】北岸大雾已散。",
			].join("\n"),
			"utf8",
		);

		// 2. QCE 导出 JSON：文件名不含群号，但顶层 chatInfo.uin 声明群号，且含带偏移 ISO、+0800、毫秒、10位/13位 Unix 时间戳与数字型 ID
		await writeFile(
			join(root, "00-群聊收集", "export-qce-dump.json"),
			JSON.stringify({
				chatInfo: { uin: 888999, name: "河朔密议群" },
				messages: [
					{
						id: 9001,
						sender: "谋士甲",
						uin: 10001,
						timestamp: "2026-11-26T20:15:03+08:00",
						text: "ISO 冒号时区消息",
					},
					{
						id: 9002,
						sender: { name: "谋士乙", uin: 10002 },
						timestamp: "2026-11-26T20:16:04.123+0800",
						content: { text: "ISO 毫秒无冒号时区消息" },
					},
					{
						id: 9003,
						sender: "谋士丙",
						uid: 10003,
						time: 1795695420, // 2026-11-26 20:17:00 CST
						text: "10位秒级时间戳消息",
					},
					{
						id: 9004,
						sender: "谋士丁",
						senderId: 10004,
						timestamp: 1795695480000, // 2026-11-26 20:18:00 CST
						text: "13位毫秒时间戳消息",
					},
					{
						id: 9005,
						sender: "谋士戊",
						senderId: 10005,
						timestamp: "2026-11-26T18:30:00Z", // 跨午夜 UTC -> 2026-11-27 02:30:00 CST
						text: "跨午夜 UTC 消息",
					},
					{
						id: 9006,
						sender: "谋士己",
						senderId: 10006,
						timestamp: "2026-11-26T18:30:00-05:00", // -05:00 -> 2026-11-27 07:30:00 CST
						text: "西五区跨日消息",
					},
				],
			}),
			"utf8",
		);

		// 按内部群号 888999 精准过滤拉取，不得因文件名不匹配被提前跳过
		const qceOnly = await pullQqGroupsIncremental(root, "888999");
		expect(qceOnly.newlyIngested).toBe(6);
		expect(qceOnly.unreportedMessages.map((m) => m.sourceId)).toEqual(["9001", "9002", "9003", "9004", "9005", "9006"]);
		expect(qceOnly.unreportedMessages.every((m) => m.groupId === "888999" && m.groupName === "河朔密议群")).toBe(true);
		expect(qceOnly.unreportedMessages.every((m) => !m.timestamp.includes("T"))).toBe(true);
		expect(qceOnly.unreportedMessages[0]?.timestamp).toBe("2026-11-26 20:15:03");
		expect(qceOnly.unreportedMessages[1]?.timestamp).toBe("2026-11-26 20:16:04");
		expect(qceOnly.unreportedMessages[1]?.sender).toBe("谋士乙");
		expect(qceOnly.unreportedMessages[1]?.senderId).toBe("10002");
		expect(qceOnly.unreportedMessages[2]?.timestamp).toBe("2026-11-26 20:17:00");
		expect(qceOnly.unreportedMessages[3]?.timestamp).toBe("2026-11-26 20:18:00");
		expect(qceOnly.unreportedMessages[4]?.timestamp).toBe("2026-11-27 02:30:00");
		expect(qceOnly.unreportedMessages[5]?.timestamp).toBe("2026-11-27 07:30:00");

		// until 过滤不再被残留 T 破坏，且跨午夜 Z/时区换算后精确区分 11-26 与 11-27
		const untilSearch = await service.searchSourcesWithStats(root, {
			groupId: "888999",
			until: "2026-11-26",
		});
		expect(untilSearch.totalMatched).toBe(4);
		const utcBoundSearch = await service.searchSourcesWithStats(root, {
			groupId: "888999",
			since: "2026-11-26T18:00:00Z", // 2026-11-27 02:00:00 CST
			until: "2026-11-26T19:00:00Z", // 2026-11-27 03:00:00 CST
		});
		expect(utcBoundSearch.records.map((m) => m.sourceId)).toEqual(["9005"]);

		// inferGroupMeta 去除首尾短横线
		expect(inferGroupMeta("[主群] 战报.txt").groupId).toBe("主群-战报");

		// 空拉取 recordExposedPullWindow(cwd, []) 不应写入空 Set 阻塞后续正常发布推进游标
		service.recordExposedPullWindow(root, []);
		const pubAfterEmptyPull = await service.publishBriefing({
			cwd: root,
			title: "空窗口回退验证",
			turnLabel: "T1",
			headline: "验证空窗口不卡死游标",
			progressItems: [],
			diplomacySummary: "平稳",
			intelChecks: [],
			strategicJudgment: "正常推进",
		});
		expect(pubAfterEmptyPull.remainingUnreportedCount).toBe(0);

		// 拉取 PC QQ 日期在前 .txt：3 条完整消息，总攻时间： 08:30:00 未被误劈
		const pcPull = await pullQqGroupsIncremental(root, "group-pc-1001");
		expect(pcPull.newlyIngested).toBe(3);
		expect(pcPull.unreportedMessages[0]?.sender).toBe("【北周】燕王");
		expect(pcPull.unreportedMessages[0]?.senderId).toBe("12345678");
		expect(pcPull.unreportedMessages[0]?.text).toContain("总攻时间： 08:30:00");
		expect(pcPull.unreportedMessages[1]?.sender).toBe("西凉使节");
		expect(pcPull.unreportedMessages[1]?.senderId).toBe("xiliang@example.com");
		expect(pcPull.unreportedMessages[2]?.sender).toBe("司历GM");
		expect(pcPull.unreportedMessages[2]?.timestamp).toBe("2026-11-26 08:05:09");
	});

	it("Bug #7, #22 & #23: 双引号国策标题无反斜杠回显、去重双层 Frontmatter、损坏简报/台账容错与无日期补抓防游标回跳", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-robust-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "健壮性测试", currentEra: "T1" });

		// Bug #7: 英文双引号标题 + 含 Frontmatter 的正文写入与回读
		const pol = await service.writePolicyDocx({
			cwd: root,
			title: '论"河朔"防务与"常平"粮策',
			content: "---\ntitle: 旧头\nactor: 旧方\n---\n\n一、清源固守。\n二、粮秣入仓。",
		});
		expect(pol.ok).toBe(true);
		const mdRaw = await readFile(join(root, pol.artifact!.markdownPath), "utf8");
		expect(mdRaw.match(/^---$/gm)?.length).toBe(2); // 仅一层 Frontmatter，绝无双层 ---
		const listed = await service.listPolicies(root);
		expect(listed[0]?.title).toBe('论"河朔"防务与"常平"粮策');

		// Bug #22: 缺失 createdAt 的简报 JSON、语法损坏的简报 JSON 与缺失 sourceRefs 的台账条目不炸毁 getOverview
		await writeFile(
			join(root, "02-局势简报与台账", "briefings", "briefing-001-partial.json"),
			JSON.stringify({ id: "briefing-001", headline: "缺时间戳简报" }),
			"utf8",
		);
		await writeFile(
			join(root, "02-局势简报与台账", "briefings", "briefing-002-broken.json"),
			"{broken-json",
			"utf8",
		);
		await writeFile(
			join(root, "02-局势简报与台账", "rolling-ledger.json"),
			JSON.stringify({
				version: 1,
				entries: [null, { id: "l-1", category: "fact", summary: "缺 sourceRefs 条目" }],
			}),
			"utf8",
		);
		const overview = await service.getOverview(root);
		expect(overview.briefings).toHaveLength(1);
		expect(overview.briefings[0]?.createdAt).toBe("");
		expect(overview.rollingLedger).toHaveLength(1);
		expect(overview.rollingLedger[0]?.sourceRefs).toEqual([]);

		// Bug #23: 已有带日期消息后再入库无日期/纯时间消息必须触发排序，且乱序历史文件修复游标后不触发大面积重报
		await ingestExternalMessages(root, [
			{ sourceId: "m-d1", groupId: "g1", groupName: "主群", sender: "甲", timestamp: "2026-11-26 10:00:00", text: "带日期1" },
			{ sourceId: "m-d2", groupId: "g1", groupName: "主群", sender: "乙", timestamp: "2026-11-26 11:00:00", text: "带日期2" },
		]);
		await service.publishBriefing({
			cwd: root,
			title: "基线简报",
			turnLabel: "T1",
			headline: "已报至 d2",
			progressItems: [],
			diplomacySummary: "稳",
			intelChecks: [],
			strategicJudgment: "守",
		});
		// 新入库纯时间消息（应在时间桶 1，触发排序移到带日期消息之前，且不把已报游标顶乱重报 d1/d2）
		await ingestExternalMessages(root, [
			{ sourceId: "m-t1", groupId: "g1", groupName: "主群", sender: "丙", timestamp: "09:15:30", text: "补录纯时间消息" },
		]);
		const afterTimeOnly = await service.pullQq(root);
		expect(afterTimeOnly.unreportedMessages).toHaveLength(0);
		const orderedWin = await service.lookupSource(root, "m-d2", 5);
		expect(orderedWin?.messages.map((m) => m.sourceId)).toEqual(["m-t1", "m-d1", "m-d2"]);

		// 模拟旧盘面遗留的乱序 evidence.jsonl（带日期在前、无日期在后且游标停在末尾无日期条目）+ 新到历史补抓 + 新消息
		const legacyRecords = [
			{ sourceId: "leg-d1", groupId: "g2", groupName: "密群", sender: "甲", timestamp: "2026-11-26 10:00:00", text: "旧已报1", fingerprint: "fp1", lineIndex: 0 },
			{ sourceId: "leg-d2", groupId: "g2", groupName: "密群", sender: "乙", timestamp: "2026-11-26 11:00:00", text: "旧已报2", fingerprint: "fp2", lineIndex: 1 },
			{ sourceId: "leg-u1", groupId: "g2", groupName: "密群", sender: "丙", timestamp: "", text: "旧末尾无日期", fingerprint: "fp3", lineIndex: 2 },
		];
		await writeFile(
			join(root, ".wenyou", "evidence.jsonl"),
			`${legacyRecords.map((r) => JSON.stringify(r)).join("\n")}\n`,
			"utf8",
		);
		await writeFile(
			join(root, ".wenyou", "cursors.json"),
			JSON.stringify({
				version: 1,
				groups: {
					g2: {
						groupId: "g2",
						groupName: "密群",
						role: "cabinet",
						totalIngested: 3,
						lastIngestedSourceId: "leg-u1",
						lastIngestedTimestamp: null,
						lastReportedSourceId: "leg-u1",
						lastReportedAt: "2026-11-26T12:00:00.000Z",
						unreportedCount: 0,
						sourceFiles: [],
					},
				},
			}),
			"utf8",
		);
		// 乱序补抓早期历史 leg-d0 + 新消息 leg-d3：绝不重报旧已报 leg-d1/leg-d2，仅 leg-d3 待报
		await ingestExternalMessages(root, [
			{ sourceId: "leg-d0", groupId: "g2", groupName: "密群", sender: "丁", timestamp: "2026-11-25 09:00:00", text: "早期补抓" },
			{ sourceId: "leg-d3", groupId: "g2", groupName: "密群", sender: "戊", timestamp: "2026-11-26 12:00:00", text: "最新消息" },
		]);
		const afterRepair = await service.pullQq(root, "g2");
		expect(afterRepair.unreportedMessages.map((m) => m.sourceId)).toEqual(["leg-d3"]);
	});
});
