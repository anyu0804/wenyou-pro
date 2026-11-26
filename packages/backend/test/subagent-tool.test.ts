import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "../src/tools/subagent/agents";
import type { SingleResult } from "../src/tools/subagent/runner";
import { finalizeSubagentResult, resolveTaskAgent, subagentParams } from "../src/tools/subagent/tool";

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "scout",
		task: "t",
		exitCode: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: { tokens: 0 } },
		artifactPaths: {},
		...overrides,
	};
}

function makeAgent(name: string): SubagentDefinition {
	return {
		name,
		description: `${name} agent`,
		tools: ["read"],
		systemPrompt: `You are ${name}.`,
		source: "user",
	};
}

describe("subagentParams schema（provider 兼容，0.4.5 回归）", () => {
	const schema = JSON.parse(JSON.stringify(subagentParams)) as Record<string, unknown>;

	it("顶层必须是 type:object（DeepSeek 等 openai-completions 端点硬性要求）", () => {
		expect(schema.type).toBe("object");
	});

	it("顶层不使用 anyOf/allOf 组合器（anthropic convertTools 会剥掉它们，剩空 schema）", () => {
		expect(schema.anyOf).toBeUndefined();
		expect(schema.allOf).toBeUndefined();
	});

	it("完整 properties：agent/task/tasks/confirmProjectAgents 均带描述", () => {
		const props = schema.properties as Record<string, { description?: string }>;
		expect(Object.keys(props)).toEqual(
			expect.arrayContaining(["agent", "task", "tasks", "confirmProjectAgents"]),
		);
		expect(props.cwd).toBeUndefined();
		for (const key of ["agent", "task", "tasks"]) {
			expect(props[key]?.description, `${key} 缺 description`).toBeTruthy();
		}
	});

	it("所有字段 optional（互斥约束由 execute 运行时校验兜底）", () => {
		expect(schema.required).toBeUndefined();
	});
});

describe("resolveTaskAgent（无内置 worker 回退语义）", () => {
	it("未配置任何子代理时抛出明确提示", () => {
		expect(() => resolveTaskAgent([], undefined)).toThrow(/No subagents are configured/);
		expect(() => resolveTaskAgent([], "worker")).toThrow(/No subagents are configured/);
	});

	it("仅配置一个子代理且省略 agent 时自动选中该子代理", () => {
		const only = makeAgent("historian");
		expect(resolveTaskAgent([only], undefined)).toBe(only);
	});

	it("配置多个子代理且省略 agent 时抛出包含可用列表的错误", () => {
		const agents = [makeAgent("scout"), makeAgent("historian")];
		expect(() => resolveTaskAgent(agents, undefined)).toThrow(/scout, historian/);
		expect(resolveTaskAgent(agents, "historian").name).toBe("historian");
		expect(() => resolveTaskAgent(agents, "missing")).toThrow(/Available agents: scout, historian/);
	});
});

describe("finalizeSubagentResult（失败语义 spec §6）", () => {
	it("中止不会误导重试，事实块独立保留，长文本按每任务截断", () => {
		const summary = {
			changedFiles: Array.from({ length: 20 }, (_, i) => ({ path: `file-${i}`, added: 1, removed: 2 })),
			commands: [{ command: "private-command", isError: true }],
			failedCommands: 1,
			durationMs: 123,
		};
		const result = finalizeSubagentResult("parallel", [
			makeResult({ status: "aborted", content: "a".repeat(60000), summary }),
			makeResult({ status: "done", content: "b".repeat(60000), summary }),
		]);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("已由用户中止、不是任务失败");
		expect(text).toContain("a".repeat(50000));
		expect(text).toContain("b".repeat(50000));
		expect(text).not.toContain("a".repeat(50001));
		expect(text).toContain("5 more files");
		expect(text).toContain("Duration: 123 ms");
		expect(text).not.toContain("private-command");
		expect(result.isError).toBeUndefined();
		expect(finalizeSubagentResult("single", [makeResult({ status: "aborted" })]).isError).toBe(true);
	});

	it("single 成功：content 为结论，无 isError", () => {
		const result = finalizeSubagentResult("single", [makeResult({ content: "done" })]);
		expect(result.isError).toBeUndefined();
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("done\n\nChanged 0 files:"),
		});
	});

	it("single 失败：isError + content 带诊断（不给模型空字符串）", () => {
		const result = finalizeSubagentResult("single", [
			makeResult({ exitCode: 1, error: "model exploded", content: undefined }),
		]);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toEqual({
			type: "text",
			text: expect.stringContaining("Error: model exploded"),
		});
	});

	it("single 无错误消息的失败（abort）：回落 aborted 诊断", () => {
		const result = finalizeSubagentResult("single", [makeResult({ exitCode: 1 })]);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Error: subagent failed"),
		});
	});

	it("parallel 部分失败：不置 isError，Error 行在 content 里", () => {
		const result = finalizeSubagentResult("parallel", [
			makeResult({ content: "ok" }),
			makeResult({ agent: "scout2", exitCode: 1, error: "boom" }),
		]);
		expect(result.isError).toBeUndefined();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("## 1. scout\nok");
		expect(text).toContain("## 2. scout2\nError: boom");
	});

	it("parallel 全败：isError", () => {
		const result = finalizeSubagentResult("parallel", [
			makeResult({ exitCode: 1, error: "a" }),
			makeResult({ exitCode: 1, error: "b" }),
		]);
		expect(result.isError).toBe(true);
	});
});
