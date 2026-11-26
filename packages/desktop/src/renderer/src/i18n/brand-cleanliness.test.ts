import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDiagnosticsText } from "../lib/diagnostics";

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const AUDITED_FILES = [
	"src/renderer/src/components/startup/StorageStartup.tsx",
	"src/renderer/src/i18n/zh.ts",
	"src/renderer/src/i18n/en.ts",
	"src/renderer/src/lib/diagnostics.ts",
	"src/main/renderer-watchdog.ts",
	"src/main/ipc/app.ts",
	"src/renderer/src/components/settings/AboutPanel.tsx",
] as const;

const ALLOWED_PATTERNS: RegExp[] = [
	/https:\/\/github\.com\/Jaxton07\/percho/g,
	/Jaxton07\/percho/g,
	/@percho\//g,
	/\bPerchoUI\b/g,
	/\bperchoUi\b/g,
	/__percho[A-Za-z0-9_]*/g,
	/\bPERCHO_[A-Za-z0-9_]*/g,
	/name:\s*percho-ui-plugin/g,
	/\bpercho-ui\.d\.ts\b/g,
];

/**
 * Strip comments without touching string literals (so URLs like "https://..." inside strings stay intact)
 * and preserve line breaks so violation line numbers remain accurate.
 */
function stripComments(source: string, isHtml: boolean): string {
	if (isHtml) {
		return source.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));
	}

	let out = "";
	let i = 0;
	const len = source.length;
	let quote: "'" | '"' | "`" | null = null;

	while (i < len) {
		const ch = source[i];
		const next = source[i + 1];

		if (quote !== null) {
			out += ch;
			if (ch === "\\" && i + 1 < len) {
				out += next;
				i += 2;
				continue;
			}
			if (ch === quote || ((quote === "'" || quote === '"') && ch === "\n")) quote = null;
			i += 1;
			continue;
		}

		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			out += ch;
			i += 1;
			continue;
		}

		if (ch === "/" && next === "/") {
			out += "  ";
			i += 2;
			while (i < len && source[i] !== "\n") {
				out += " ";
				i += 1;
			}
			continue;
		}

		if (ch === "/" && next === "*") {
			out += "  ";
			i += 2;
			while (i < len && !(source[i] === "*" && source[i + 1] === "/")) {
				out += source[i] === "\n" ? "\n" : " ";
				i += 1;
			}
			if (i + 1 < len) {
				out += "  ";
				i += 2;
			}
			continue;
		}

		out += ch;
		i += 1;
	}

	return out;
}

function stripAllowedIdentifiers(source: string): string {
	let sanitized = source;
	for (const pattern of ALLOWED_PATTERNS) {
		sanitized = sanitized.replace(pattern, (match) => " ".repeat(match.length));
	}
	return sanitized;
}

interface BrandViolation {
	line: number;
	snippet: string;
}

function findDisallowedBrandHits(source: string, isHtml = false): BrandViolation[] {
	const cleaned = stripAllowedIdentifiers(stripComments(source, isHtml));
	const originalLines = source.split(/\r?\n/);
	const cleanedLines = cleaned.split(/\r?\n/);
	const violations: BrandViolation[] = [];

	for (let idx = 0; idx < cleanedLines.length; idx++) {
		const line = cleanedLines[idx] ?? "";
		if (/\bpercho\b/i.test(line) || /Percho/.test(line)) {
			violations.push({
				line: idx + 1,
				snippet: (originalLines[idx] ?? "").trim(),
			});
		}
	}

	return violations;
}

describe("brand cleanliness regression guard", () => {
	it("detects user-visible Percho leaks while allowing internal identifiers and MIT attribution", () => {
		const leakySample = [
			'import type { AppInfo } from "@percho/shared";',
			"// Percho comment should be ignored",
			'const attribution = "https://github.com/Jaxton07/percho";',
			'const notice = "Built on Jaxton07/percho (MIT License)";',
			"const runtime = [window.PerchoUI, perchoUi, __percho_flag, PERCHO_DEBUG];",
			'const bad1 = "如何开始使用 Percho？";',
			'const bad2 = "Ask percho (agent) to write a plugin";',
			'const bad3 = "percho-update-diagnostics-2026-01-01.json";',
			'const bad4 = "https://example.com/percho-leak";',
		].join("\n");

		const hits = findDisallowedBrandHits(leakySample);
		expect(hits.map((h) => h.line)).toEqual([6, 7, 8, 9]);
		const jsxApostropheSample = ["<p>It's ready</p>", "// Percho comment", "<p>Percho leak</p>"].join("\n");
		expect(findDisallowedBrandHits(jsxApostropheSample).map((h) => h.line)).toEqual([3]);
		const pluginDocsSample = [
			"name: percho-ui-plugin",
			"See percho-ui.d.ts and window.PerchoUI",
			"Percho 桌面端 UI 插件",
			"~/.percho/ui-plugins/SPEC.md",
		].join("\n");
		expect(findDisallowedBrandHits(pluginDocsSample, true).map((h) => h.line)).toEqual([3, 4]);
		expect(findDisallowedBrandHits("<!-- Percho --><title>Percho Remote</title>", true)).toHaveLength(1);
		expect(findDisallowedBrandHits("<!-- Percho --><title>Wenyou Pro Remote</title>", true)).toHaveLength(0);
	});

	for (const relPath of AUDITED_FILES) {
		it(`has zero disallowed Percho remnants in ${relPath}`, () => {
			const fullPath = resolve(DESKTOP_ROOT, relPath);
			const content = readFileSync(fullPath, "utf8");
			const violations = findDisallowedBrandHits(
				content,
				relPath.endsWith(".html") || relPath.endsWith(".md"),
			);
			expect(violations, `${relPath} still contains disallowed brand strings`).toEqual([]);
		});
	}

	it("preserves MIT open-source upstream attribution in i18n, AboutPanel, and app IPC", () => {
		const zhContent = readFileSync(resolve(DESKTOP_ROOT, "src/renderer/src/i18n/zh.ts"), "utf8");
		const enContent = readFileSync(resolve(DESKTOP_ROOT, "src/renderer/src/i18n/en.ts"), "utf8");
		const aboutContent = readFileSync(
			resolve(DESKTOP_ROOT, "src/renderer/src/components/settings/AboutPanel.tsx"),
			"utf8",
		);
		const appIpcContent = readFileSync(resolve(DESKTOP_ROOT, "src/main/ipc/app.ts"), "utf8");

		expect(zhContent).toContain("Jaxton07/percho（MIT License）");
		expect(enContent).toContain("Jaxton07/percho (MIT License)");
		expect(aboutContent).toContain("github.com/Jaxton07/percho (MIT License)");
		expect(aboutContent).toContain('const upstreamUrl = "https://github.com/Jaxton07/percho";');
		expect(appIpcContent).toContain('const REPO_URL = "https://github.com/Jaxton07/percho";');
	});

	it("updates key brand titles, diagnostics, and AboutPanel inline scroll-brush SVG", () => {
		const startupContent = readFileSync(
			resolve(DESKTOP_ROOT, "src/renderer/src/components/startup/StorageStartup.tsx"),
			"utf8",
		);
		const diagnosticsContent = readFileSync(
			resolve(DESKTOP_ROOT, "src/renderer/src/lib/diagnostics.ts"),
			"utf8",
		);
		const watchdogContent = readFileSync(resolve(DESKTOP_ROOT, "src/main/renderer-watchdog.ts"), "utf8");
		const appIpcContent = readFileSync(resolve(DESKTOP_ROOT, "src/main/ipc/app.ts"), "utf8");
		const aboutContent = readFileSync(
			resolve(DESKTOP_ROOT, "src/renderer/src/components/settings/AboutPanel.tsx"),
			"utf8",
		);

		expect(startupContent).toContain("司命 · 文游 Pro");
		expect(diagnosticsContent).toContain('"司命 · 文游 Pro 诊断信息"');
		expect(watchdogContent).toContain('title: "司命 · 文游 Pro"');
		expect(appIpcContent).toContain("wenyou-pro-update-diagnostics-");
		expect(aboutContent).toContain('"司命 · 文游 Pro"');
		expect(aboutContent).toContain("#c83e37");
		expect(aboutContent).toContain("<svg");
		expect(aboutContent).toContain("h-12 w-12");

		const diagText = buildDiagnosticsText(
			{ sessionId: "sess-1", sessionFile: undefined, name: "测试" },
			{ platform: "win32", appVersion: "0.2.4" },
		);
		expect(diagText.split("\n")[0]).toBe("司命 · 文游 Pro 诊断信息");
		expect(diagText).not.toMatch(/percho/i);
	});
});
