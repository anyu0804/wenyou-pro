# BATTLE-1 G 包验收样例索引

本目录是 G 包的验收入口说明，不复制业务样例，避免与 P0/A/D 的权威样例产生第二份数据。

## 权威样例

- 契约与合成工作区：`work-packages/BATTLE-1/P0/samples/river-valley.ts`（3 师 9 团，含河谷、障碍、桥口、未知项；全部为合成设定）。
- AI 固定原文与人工标注候选：`work-packages/BATTLE-1/A/samples/river-valley-candidates.json`（1 个 ready、1 个 unresolved）。
- D 包部署请求：`work-packages/BATTLE-1/D/samples/deployment-cases.ts`（成功、正面不足、压障碍、越界、不连通、孔洞等）。

以上样例均不引用正式地图、世界资料或已执行方案。G 验收直接读取这些文件，不修改它们。

## 场景与执行入口

| 场景 | 覆盖 | 执行 |
| --- | --- | --- |
| S1 开阔地 | 3 师 9 团树、两梯队/预备队、8600 人已知下限 | `tests/battle-1-acceptance.test.mjs` |
| S2 河谷狭口 | 正面不足报 `insufficient-frontage`；压障碍报 `obstacle-intersection`；桥口与河段语义分离 | 同上 |
| S3 缺项与往返 | 未知位置/人数保持未知；手工补齐后通过校验；JSON 往返不丢语义 | 同上 |
| 180 团规模 | 60 师 + 180 团 = 240 单位，编制树、唯一部署、兵力汇总 | 同上 |
| AI 候选 | 固定原文解析、部分选择、来源同批、只改选中对象 | 同上 |
| 发布包 E2E | 全新解压、HTTP 全量、真实浏览器装载/旋转/拖动/撤销/PNG/刷新/两战区 | `PACKAGED_RELEASE_DIR=... node tests/battle-release.test.mjs` |
| Canvas 导出 | 真实 Chromium Canvas 的 PNG 尺寸、颜色数与签名 | `node tests/battle-browser.test.mjs` |

## 边界

- 180 团是数据规模与编制一致性检查，不是容量上限或 FPS 基准。
- 浏览器视口可读性只覆盖 12 团合成演示；未覆盖 180 团的逐团视觉排布。
- 所有浏览器验收使用 Playwright 独立 Chromium Headless Shell 和测试 profile，禁止 Edge。
