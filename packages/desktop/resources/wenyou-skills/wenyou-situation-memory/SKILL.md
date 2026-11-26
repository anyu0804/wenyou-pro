---
name: wenyou-situation-memory
description: 战略推演文游的局势判断、多群防重报采集与 L0/L1/L2 三层记忆维护指引。当用户要求拉取群聊、核实最新战况、写局势简报、区分敌方宣传与 GM 裁定或更新滚动台账时使用。
---

# 战略推演局势判断与三层记忆指引

## 1. 三层记忆架构与权责边界
- **L0 原始证据层（`.wenyou/evidence.jsonl` + `.wenyou/cursors.json`）**：全部 QQ 群（主群 / 骰子群 / 内阁群 / 外交群）只读归档与双游标（总入库游标 `lastIngestedSourceId` 与上次简报已汇报游标 `lastReportedSourceId`），保持原文不篡改。
- **L1 局势简报与跨群滚动台账（`02-局势简报与台账/`）**：每次增量采集后生成的三段式局势书（JSON + Markdown）与跨群台账。
  - **未定案区分**：内阁群/私聊里的试探、设想、尚未发往主群或未经 GM 落锤的草案，写入台账时应使用 `category: "unconfirmed_draft"` 并标明 `[未定案草案]`，避免与已成事实混淆。
- **L2 正式档案层（`01-设定与国力实册/`、`04-编年史与条约/`）**：存放世界设定、各国国力实册与编年史条约。Agent 可基于核实后的群聊原文与裁判裁定直接整理写入与修订，关键史实变动注明 `[sourceId]` 溯源，不将未定案草案或单方宣传口径当成定论写入。

## 2. 推荐执行流程
1. 调用 `wenyou_pull_qq` 扫描 `00-群聊收集/`，获取尚未进入简报的新消息与各群游标统计，避免重复汇报上次简报已覆盖的旧消息。
2. 调用 `wenyou_read_memory` 读取上一份局势简报、L1 滚动台账与 `01-设定与国力实册` 基线，保持前后连贯不断代。
3. 对存在争议的战报、外交通牒、玩家转述传闻或反常数据，先全库回查原文：
   - 追查「最初原话 → 传话曲解点」时，先调 `wenyou_lookup_source(keyword, order="earliest", limit=50)` 定位最早源头，再对比 `order="latest"` 看后续转述是否走样（全库最高覆盖 20,000 条/群；若群库记录较浅，可先调 `wenyou_pull_qq(historyLimit=5000..20000, backfill=true)` 按时间线补抓更早历史）；
   - 对关键发言调 `wenyou_lookup_source(sourceId, window=30)` 回查前后上下文，争议复杂时可将 `window` 扩至 `100～200` 或依据返回的首尾 `sourceId` 分段继续前溯，逐条甄别四类可信度：
   - `gm_fact`：裁判/司历官正式裁定或骰娘有效检定落锤的事实；
   - `propaganda`：敌我阵营在主群发布的对外宣传、心理战、虚张声势或片面战报；
   - `unconfirmed_draft`：内阁/参谋讨论中尚未正式提交的方案；
   - `player_ooc`：群友水群、玩梗、场外吐槽（过滤，不入正史）。
4. 调用 `wenyou_publish_briefing` 落盘三段式局势书并推进汇报游标：
   - `headline`：先讲结论，简明交代本轮最重要变局；
   - `progressItems`【进度】：区分 `settled` / `in_progress` / `pending_roll` / `blocked`，每条附真实 `sourceRefs`；
   - `diplomacySummary`【外交局势】：客观归纳各方阵营站队、停战/盟约松动与谈判底牌；
   - `intelChecks`【情报核查】：把可疑宣传与 GM 铁证并列拆解，附完整 `sourceRefs` 供用户一键点击右侧抽屉核对原文；
   - `strategicJudgment`：给出务实、克制的战略判断与下一步建议。
