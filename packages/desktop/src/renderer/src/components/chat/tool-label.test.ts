import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 渲染端 vitest 默认跑在 node 环境（无 localStorage/navigator），而 tool-label 经 i18n 读它们。
 * 这里先打桩再**动态 import**（静态 import 会被提升到打桩之前），只为测显示名逻辑。
 */
type DisplayName = (name: string, t?: (key: string) => string) => string;
let displayName: DisplayName;

beforeAll(async () => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
	vi.stubGlobal("navigator", { language: "zh-CN" });
	({ displayName } = (await import("./tool-label")) as { displayName: DisplayName });
});

describe("工具显示名", () => {
	it("内置工具走翻译表", () => {
		expect(displayName("read", (key) => `[${key}]`)).toBe("[tool.names.read]");
	});

	it("MCP 工具保留命名空间：mcp__server__tool → server › tool", () => {
		expect(displayName("mcp__demo__echo")).toBe("demo › echo");
		// 不同 server 的同名工具不撞脸
		expect(displayName("mcp__docs__search")).not.toBe(displayName("mcp__web__search"));
	});

	it("其余扩展工具原名呈现；前缀不完整的不当 MCP 解析", () => {
		expect(displayName("third_party_tool")).toBe("third_party_tool");
		expect(displayName("mcp__broken")).toBe("mcp__broken");
		expect(displayName("mcp____tool")).toBe("mcp____tool");
	});

	it("全部 8 个文游工具均映射到友好中文显示名", () => {
		expect(displayName("wenyou_init_campaign")).toBe("初始化文游工作区");
		expect(displayName("wenyou_pull_qq")).toBe("拉取多群增量消息");
		expect(displayName("wenyou_lookup_source")).toBe("回查群聊原始上下文");
		expect(displayName("wenyou_read_memory")).toBe("读取三层记忆与实册");
		expect(displayName("wenyou_publish_briefing")).toBe("发布三段式局势书");
		expect(displayName("wenyou_write_policy_docx")).toBe("生成国策与 Word 文档");
		expect(displayName("wenyou_open_maps")).toBe("打开战略舆图比对");
		expect(displayName("wenyou_propose_canon")).toBe("提交正史修改提案");
	});
});
