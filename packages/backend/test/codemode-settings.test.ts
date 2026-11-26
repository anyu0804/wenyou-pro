import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import {
	codemodeSessionOptions,
	readCodemodeConfig,
	readCodemodeEnabled,
	writeCodemodeEnabled,
	writeCodemodeOnly,
} from "../src/settings/codemode";

const roots: string[] = [];
function isolatedDir() {
	const base = resolve("../../.local/tmp/codemode-tests");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "run-"));
	roots.push(root);
	return root;
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("总开关与独占模式默认均关闭，两者独立保存；并发写入不互相覆盖", async () => {
	const dir = isolatedDir();
	expect(readCodemodeConfig(dir)).toEqual({ enabled: false, only: false });
	await Promise.all([writeCodemodeOnly(dir, true), writeCodemodeEnabled(dir, true)]);
	expect(readCodemodeConfig(dir)).toEqual({ enabled: true, only: true });
	await writeCodemodeEnabled(dir, false);
	expect(readCodemodeConfig(dir)).toEqual({ enabled: false, only: true });
	await writeCodemodeOnly(dir, false);
	expect(readCodemodeConfig(dir)).toEqual({ enabled: false, only: false });
});

it("缺省关闭，保存开启与重新关闭；不覆盖其他字段", async () => {
	const dir = isolatedDir();
	expect(readCodemodeEnabled(dir)).toBe(false);
	writeFileSync(join(dir, "codemode.json"), JSON.stringify({ extra: 1 }));
	expect(readCodemodeEnabled(dir)).toBe(false);
	await writeCodemodeEnabled(dir, true);
	expect(readCodemodeEnabled(dir)).toBe(true);
	expect(JSON.parse(readFileSync(join(dir, "codemode.json"), "utf8"))).toEqual({
		extra: 1,
		enabled: true,
	});
	await writeCodemodeEnabled(dir, false);
	expect(readCodemodeEnabled(dir)).toBe(false);
});

it.each(["{", "null", "[]"])("损坏配置拒绝保存：%s", async (raw) => {
	const dir = isolatedDir();
	writeFileSync(join(dir, "codemode.json"), raw);
	await expect(writeCodemodeEnabled(dir, false)).rejects.toThrow("配置文件损坏");
});

it.each([undefined, ["read", "tool_search"], ["+grep", "-write"]])(
	"默认关闭 Code Mode 时排除 codemode，显式开启后才激活：%j",
	async (defaultTools) => {
		const dir = isolatedDir();
		const settingsDisabled = SettingsManager.inMemory({ defaultTools });
		const beforeDisabled = settingsDisabled.getDefaultTools() ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
		const disabledOpts = codemodeSessionOptions(settingsDisabled, dir);
		expect(disabledOpts.excludeTools).toEqual(["codemode"]);
		expect(settingsDisabled.getDefaultTools()).toEqual(beforeDisabled.filter((n) => n !== "codemode"));

		await writeCodemodeEnabled(dir, true);
		const settingsEnabled = SettingsManager.inMemory({ defaultTools });
		const beforeEnabled = settingsEnabled.getDefaultTools() ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
		const enabledOpts = codemodeSessionOptions(settingsEnabled, dir);
		expect(enabledOpts.excludeTools).toBeUndefined();
		expect(settingsEnabled.getDefaultTools()).toEqual([...beforeEnabled, "codemode"]);
	},
);

it.each([true, false])("真实 SDK 的激活与排除行为：enabled=%s", async (enabled) => {
	const dir = isolatedDir();
	await writeCodemodeEnabled(dir, enabled);
	const settings = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [{ name: "codemode", builtin: true, factory: createCodemodeExtension() }],
	});
	await resourceLoader.reload();
	const options = codemodeSessionOptions(settings, dir);
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		...options,
	});
	try {
		expect(session.getActiveToolNames().includes("codemode")).toBe(enabled);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["grep", "find", "ls"]));
		if (!enabled) {
			// MCP 的自动激活也经这个公开入口，关闭后不能重新加入。
			session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
			expect(session.getActiveToolNames()).not.toContain("codemode");
		}
	} finally {
		session.dispose();
	}
});
