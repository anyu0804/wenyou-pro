import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ingestExternalMessages, pullQqGroupsIncremental } from "../src/wenyou/qq-ingest";
import {
	parseMarkdownWithFrontmatter,
	parseVisibility,
	stripRestrictedMarkdownBlocks,
} from "../src/wenyou/secret-blocks";
import { WenyouService } from "../src/wenyou/service";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("WenyouService 端到端领域闭环", () => {
	it("完整覆盖建库、多群增量采集防重报、sourceId 上下文回查、局势书推进游标、国策门禁+.docx、提案审批与泄密预检", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-service-"));
		tempDirs.push(root);
		const events: WenyouCanvasEvent[] = [];
		const service = new WenyouService((ev) => events.push(ev));

		// 1. 初始化标准目录
		const init = await service.initCampaign(root, { worldTitle: "测试战役", currentEra: "景平六年春" });
		expect(init.initialized).toBe(true);
		expect(init.worldTitle).toBe("测试战役");

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

		// 4. 发布局势简报并推进游标，同时写入 [未定案草案] 台账
		const pub = await service.publishBriefing({
			cwd: root,
			title: "景平六年春首次局势简报",
			turnLabel: "景平六年春",
			headline: "南楚北上扩寨但主力楼船受阻，北周宜稳守清源。",
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
		expect(pub.advancedGroups.sort()).toEqual(["group-dice-1002", "group-main-1001"]);
		expect(events.some((e) => e.kind === "briefing_published")).toBe(true);

		// 游标推进后未汇报应归零
		const pullAfterReport = await service.pullQq(root);
		expect(pullAfterReport.unreportedMessages).toHaveLength(0);

		const overviewAfter = await service.getOverview(root);
		expect(overviewAfter.rollingLedger[0]?.tag).toBe("[未定案草案]");
		expect(overviewAfter.rollingLedger[0]?.summary).toContain("[未定案草案]");

		// 5. 国策门禁拦截坏稿，放行好稿并生成 .docx
		const badPolicy = await service.writePolicyDocx({
			cwd: root,
			title: "违规国策测试",
			content: "我们要做好顶层设计，打出一套组合拳。\n\n| A | B |\n| - | - |\n| 1 | 2 |",
		});
		expect(badPolicy.ok).toBe(false);
		expect(badPolicy.lintReport.passed).toBe(false);

		const goodPolicy = await service.writePolicyDocx({
			cwd: root,
			title: "清源守备条陈",
			actor: "北周",
			turnLabel: "景平六年春",
			content:
				"河阳镇今春以守为先，清源城收拢周边三县常平仓春粮八万石入库，临河渡北岸增筑烽燧三座，严密监视南岸水寨动向。",
		});
		expect(goodPolicy.ok).toBe(true);
		expect(goodPolicy.artifact?.docxPath).toBeTruthy();
		expect(existsSync(join(root, goodPolicy.artifact!.docxPath!))).toBe(true);
		expect(events.some((e) => e.kind === "policy_written")).toBe(true);

		// 6. 正史提案与 GM 批准原子落盘（非 GM 拒绝）
		const prop = await service.proposeCanon({
			cwd: root,
			targetPath: "04-编年史与条约/002-清源守备记.md",
			summary: "新增清源守备正史",
			afterContent:
				"---\nid: ch-002\ntitle: 清源守备记\nvisibility: public\n---\n\n正文公开。\n\n:::secret[gm]\n裁判私密内容绝不可外泄\n:::\n",
			sourceRefs: ["dice-r1"],
		});
		expect(existsSync(join(root, prop.targetPath))).toBe(false);
		await expect(service.decideProposal(root, prop.proposalId, "approved", "public")).rejects.toThrow("仅 GM");
		const approved = await service.decideProposal(root, prop.proposalId, "approved", "gm");
		expect(approved.status).toBe("approved");
		expect(existsSync(join(root, prop.targetPath))).toBe(true);

		// 7. 泄密预检拦截 private/ 与 00-群聊收集/ 并剥离 :::secret[gm]
		await writeFile(join(root, "private", "secret.md"), "机密", "utf8");
		const preflight = await service.exportPreflight(root, "public");
		expect(preflight.blockedPrivateFiles.some((f) => f.startsWith("private/"))).toBe(true);
		expect(preflight.blockedPrivateFiles.some((f) => f.startsWith("00-群聊收集/"))).toBe(true);
		expect(preflight.strippedSecretBlockCount).toBe(1);
		expect(preflight.bundleJson).not.toContain("裁判私密内容绝不可外泄");
		expect(await readFile(join(root, prop.targetPath), "utf8")).toContain("裁判私密内容绝不可外泄");
	});

	it("长程回溯突破旧 50 条上限、支持 earliest 追最早原话与时间线补抓不污染未汇报游标", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-long-lookback-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "传话溯源测试", currentEra: "景平七年" });

		// 先入库近期 60 条消息（第 101～160 条），模拟先按默认 500 抓取近期记录
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

		// 发布局势书推进汇报游标到最新第 160 条
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

		// 随后回溯补抓更早的 100 条历史（第 1～100 条，含第 5 条最早原话）
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
		// 历史补抓排在原已报游标之前，绝不产生 100 条虚假未汇报告警
		expect(backfillRes.cursors[0]?.unreportedCount).toBe(0);

		// 1) 全库按 earliest 追源应先找到 11-20 最早 GM 原话，按 latest 则先看到 11-26 走样转述
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

		// 2) 时间区间过滤可锁定早期阶段
		const ranged = await service.searchSourcesWithStats(root, {
			keyword: "盟约",
			since: "2026-11-20",
			until: "2026-11-21",
		});
		expect(ranged.totalMatched).toBe(1);
		expect(ranged.records[0]?.sourceId).toBe("qq-900001-5");

		// 3) 长程上下文窗口（window = 80）突破旧 50 上限，且按正确时间线衔接补抓前后的消息
		const win = await service.lookupSource(root, "qq-900001-101", 80);
		expect(win).not.toBeNull();
		expect(win!.windowSize).toBe(80);
		expect(win!.totalGroupMessages).toBe(160);
		expect(win!.beforeRemaining).toBe(20); // idx=100, start=20
		expect(win!.afterRemaining).toBe(0); // end=160
		expect(win!.messages).toHaveLength(140);
		expect(win!.messages[win!.targetIndex - 1]?.sourceId).toBe("qq-900001-100");
		expect(win!.messages[win!.targetIndex]?.sourceId).toBe("qq-900001-101");
	});

	it("视角强钳制、非 GM 简报/密群/台账/国策隔离、exportPreflight 防泄密与 readCanonDoc 路径隔离", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-scope-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "视角隔离战役", currentEra: "景平六年春" });

		// 在 manifest.json 写入硬上限 maxViewer: faction:north-zhou 与主线进度 order=2
		const manifestPath = join(root, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.maxViewer = "faction:north-zhou";
		manifest.branches = [{ id: "main", title: "主线", currentEra: "景平六年春", currentOrder: 2 }];
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

		// 请求提升到 gm 必须被强钳制回 faction:north-zhou
		const clamped = await service.setViewerScope(root, "gm");
		expect(clamped.viewer).toEqual({ kind: "faction", factionId: "north-zhou" });
		expect(clamped.maxViewer).toEqual({ kind: "faction", factionId: "north-zhou" });

		// 准备公开群 + 内阁密群（gm 可见）
		await ingestExternalMessages(root, [
			{
				sourceId: "qq-1001-1",
				groupId: "1001",
				groupName: "主群",
				role: "main",
				visibility: "public",
				sender: "燕王",
				timestamp: "2026-11-26 10:00:00",
				text: "公开宣诏：整饬边防。",
			},
			{
				sourceId: "qq-1002-1",
				groupId: "1002",
				groupName: "裁判密群",
				role: "cabinet",
				visibility: "gm",
				sender: "司历",
				timestamp: "2026-11-26 10:01:00",
				text: "绝密：南楚暗藏伏兵。",
			},
		]);

		// 发布一份默认 GM 内部简报 + 三类台账（本国、他国、未定案草案）
		await service.publishBriefing({
			cwd: root,
			title: "内部参谋简报",
			turnLabel: "景平六年春",
			headline: "GM 内部机密简报",
			progressItems: [],
			diplomacySummary: "暗中调停",
			intelChecks: [],
			strategicJudgment: "绝密推演",
			ledgerUpdates: [
				{ category: "military", faction: "north-zhou", summary: "北周河阳镇备粮完毕" },
				{ category: "military", faction: "south-chu", summary: "南楚水师暗渡计划" },
				{ category: "unconfirmed_draft", faction: "north-zhou", summary: "内阁未定案草案" },
				{ category: "treaty", summary: "济水停战界约生效" },
			],
		});

		// 准备一份未标 visibility 的他国国策、一份本国国策
		await writeFile(
			join(root, "03-国策与文书", "001-南楚密策.md"),
			"---\nid: chu-001\ntitle: 南楚密策\nactor: 南楚\n---\n\n南楚私密兵力部署。",
			"utf8",
		);
		await writeFile(
			join(root, "03-国策与文书", "002-北周国策.md"),
			"---\nid: zhou-002\ntitle: 北周国策\nvisibility: faction\nvisibleToFactions: [north-zhou]\n---\n\n北周守城方略。",
			"utf8",
		);

		// faction:north-zhou 视角下：密群游标/条数完全隐藏，GM 简报隐藏，他国台账与未定案草案隐藏，他国国策隐藏
		const ovFaction = await service.getOverview(root, "gm"); // 即使传 gm 也被 manifest.maxViewer 强钳制
		expect(ovFaction.viewer).toEqual({ kind: "faction", factionId: "north-zhou" });
		expect(ovFaction.maxViewer).toEqual({ kind: "faction", factionId: "north-zhou" });
		expect(ovFaction.cursors.map((c) => c.groupId)).toEqual(["1001"]);
		expect(ovFaction.totalEvidenceCount).toBe(1);
		expect(ovFaction.briefings).toHaveLength(0);
		expect(ovFaction.rollingLedger.map((e) => e.summary)).toEqual(["北周河阳镇备粮完毕", "济水停战界约生效"]);
		expect(ovFaction.policies.map((p) => p.title)).toEqual(["北周国策"]);

		// public 导出预检：隔离 GM 简报与未显式公开的各国国策（含北周 faction 国策与南楚无 visibility 国策）
		const pubPreflight = await service.exportPreflight(root, "public");
		expect(pubPreflight.blockedVisibilityFiles.some((f) => f.startsWith("02-局势简报与台账/"))).toBe(true);
		expect(pubPreflight.blockedVisibilityFiles).toContain("03-国策与文书/001-南楚密策.md");
		expect(pubPreflight.blockedVisibilityFiles).toContain("03-国策与文书/002-北周国策.md");
		expect(pubPreflight.bundleJson).not.toContain("南楚私密兵力部署");
		expect(pubPreflight.bundleJson).not.toContain("北周守城方略");
		expect(pubPreflight.bundleJson).not.toContain("GM 内部机密简报");

		// readCanonDoc 拦截 00-群聊收集/ 与 private/
		await writeFile(join(root, "00-群聊收集", "主群_1001.txt"), "原始群聊内容", "utf8");
		await expect(service.readCanonDoc(root, "00-群聊收集/主群_1001.txt", "gm")).rejects.toThrow("00-群聊收集");
		await writeFile(join(root, "private", "note.md"), "机密", "utf8");
		await expect(service.readCanonDoc(root, "private/note.md", "faction:north-zhou")).rejects.toThrow("无权");
	});

	it("serialNo 路径穿越拒绝、writePolicyDocx 自动补齐上下文拦截跨阵营/时间线穿帮，及 decideProposal 路径复检", async () => {
		const root = await mkdtemp(join(tmpdir(), "wenyou-policy-sec-"));
		tempDirs.push(root);
		const service = new WenyouService();
		await service.initCampaign(root, { worldTitle: "门禁安全测试", currentEra: "景平六年春" });

		// 设置主线 currentOrder=2
		const manifestPath = join(root, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.branches = [{ id: "main", title: "主线", currentEra: "景平六年春", currentOrder: 2 }];
		await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

		// 1. 恶意 serialNo 必须直接抛错拒绝
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

		// 2. 写入阵营实册、敌国暗线实体与未来时间线实体
		await writeFile(
			join(root, "01-设定与国力实册", "north-zhou.md"),
			"---\nid: north-zhou\ntitle: 北周国力实册\naliases: [北周]\nvisibility: public\n---\n北周基线。",
			"utf8",
		);
		await writeFile(
			join(root, "01-设定与国力实册", "chu-secret.md"),
			"---\nid: chu-secret\ntitle: 芦苇荡伏兵密计\nvisibility: gm\n---\n裁判机密。",
			"utf8",
		);
		await writeFile(
			join(root, "04-编年史与条约", "future-event.md"),
			"---\nid: future-01\ntitle: 景平九年北伐大捷\nvisibility: public\nbranch: main\norder: 9\n---\n未来事件。",
			"utf8",
		);

		// 即使在默认 GM 视角下，只要指定 actor="北周"，writePolicyDocx 自动匹配阵营并补齐 manifest 的 branch/currentOrder
		const leakedRes = await service.writePolicyDocx({
			cwd: root,
			title: "穿帮国策",
			actor: "北周",
			content: "我军先行清剿芦苇荡伏兵密计，并依景平九年北伐大捷旧例整训前锋。",
		});
		expect(leakedRes.ok).toBe(false);
		expect(leakedRes.lintReport.issues.map((i) => i.code)).toContain("CROSS_FACTION_LEAK");
		expect(leakedRes.lintReport.issues.map((i) => i.code)).toContain("TIMELINE_ANACHRONISM");

		// 3. decideProposal 批准前复检被篡改的 targetPath（禁止跳出 4 个允许前缀或非 .md）
		const prop = await service.proposeCanon({
			cwd: root,
			targetPath: "04-编年史与条约/001-正常.md",
			summary: "测试提案",
			afterContent: "# 正常",
		});
		const propFile = join(root, "private", "proposals", `${prop.proposalId}.json`);
		const tampered = JSON.parse(await readFile(propFile, "utf8")) as Record<string, unknown>;
		tampered.targetPath = "manifest.json";
		await writeFile(propFile, JSON.stringify(tampered, null, 2), "utf8");
		await expect(service.decideProposal(root, prop.proposalId, "approved", "gm")).rejects.toThrow("不合法");
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

		// 未显式传 coveredSourceIds，仅在 progressItems 点名引用 m-1，仍应把 g1 游标推进至末尾 m-3
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
		const ov1 = await service.getOverview(root, "gm");
		expect(ov1.cursors[0]?.lastReportedSourceId).toBe("m-3");
		expect(ov1.unreportedCount).toBe(0);

		// 再发一份简报，且仅显式引用旧消息 m-1：游标绝不可从 m-3 倒退回 m-1！
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
		const ov2 = await service.getOverview(root, "gm");
		expect(ov2.cursors[0]?.lastReportedSourceId).toBe("m-3");
		expect(ov2.unreportedCount).toBe(0);

		// 删除旧简报 briefing-001，再发新简报必须生成 briefing-003 而不是撞号 briefing-002！
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

	it("secret-blocks CommonMark 围栏/frontmatter Fail-Closed 与 qq-ingest 幂等去重/短时间不误拆", async () => {
		// 1. 行内 ```inline``` 不应误开启多行围栏，后续 :::secret[gm] 必须被剥离
		const md = "前言 ```inline``` 说明\n\n:::secret[gm]\n绝密内容绝不可见\n:::\n\n正文收尾";
		const stripped = stripRestrictedMarkdownBlocks(md, { kind: "public" });
		expect(stripped.strippedBlockCount).toBe(1);
		expect(stripped.visibleBody).not.toContain("绝密内容绝不可见");
		expect(stripped.visibleBody).toContain("前言 ```inline``` 说明");

		// 2. frontmatter 兼容 \r、--- 尾随空格与 # 注释，parseVisibility 对未知非空值 Fail-Closed 返回 gm
		const parsed = parseMarkdownWithFrontmatter(
			"---   \rvisibility: SECRET_UNKNOWN # 拼写错误\rtitle: \"含 # 号标题\" # 注释\r---  \r正文",
		);
		expect(parsed.data.visibility).toBe("SECRET_UNKNOWN");
		expect(parsed.data.title).toBe("含 # 号标题");
		expect(parseVisibility(parsed.data.visibility, "public")).toBe("gm");
		expect(parseVisibility("PUBLIC", "gm")).toBe("public");
		expect(parseVisibility(undefined, "public")).toBe("public");
		expect(parseVisibility(undefined, "gm")).toBe("gm");

		// 3. qq-ingest：不同显式 sourceId 同秒重句不误吞；相同 sourceId 幂等不生成 -2；短时间正则不误拆正文比分/时间
		const root = await mkdtemp(join(tmpdir(), "wenyou-ingest-edge-"));
		tempDirs.push(root);
		await mkdir(join(root, "00-群聊收集"), { recursive: true });
		const r1 = await ingestExternalMessages(root, [
			{ sourceId: "qq-900-10", groupId: "900", groupName: "主群", sender: "甲", timestamp: "2026-11-26 12:00:00", text: "收到" },
			{ sourceId: "qq-900-11", groupId: "900", groupName: "主群", sender: "甲", timestamp: "2026-11-26 12:00:00", text: "收到" },
		]);
		expect(r1.newlyIngested).toBe(2);
		const r2 = await ingestExternalMessages(root, [
			{ sourceId: "qq-900-10", groupId: "900", groupName: "主群", sender: "甲", timestamp: "2026-11-26 12:00:00", text: "收到（改文）" },
		]);
		expect(r2.newlyIngested).toBe(0);
		expect(r2.skippedDuplicates).toBe(1);

		await writeFile(
			join(root, "00-群聊收集", "主群_group-main-777.txt"),
			[
				"燕王 2026-11-26 10:00:00",
				"我军兵力对比，目前为 25:80",
				"预计抵达时间，大约 12:30",
				"周相 10:05",
				"明白，按计划行事。",
			].join("\n"),
			"utf8",
		);
		const pulled = await pullQqGroupsIncremental(root, "group-main-777");
		expect(pulled.newlyIngested).toBe(2);
		expect(pulled.unreportedMessages[0]?.sender).toBe("燕王");
		expect(pulled.unreportedMessages[0]?.text).toContain("25:80");
		expect(pulled.unreportedMessages[0]?.text).toContain("12:30");
		expect(pulled.unreportedMessages[1]?.sender).toBe("周相");
	});
});
