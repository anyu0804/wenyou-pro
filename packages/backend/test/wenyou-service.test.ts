import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WenyouCanvasEvent } from "@percho/shared";
import { afterEach, describe, expect, it } from "vitest";
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
});
