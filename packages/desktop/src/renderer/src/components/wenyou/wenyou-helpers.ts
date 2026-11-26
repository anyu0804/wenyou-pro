import {
	environmentEntityRef,
	formatViewerScope,
	type WenyouExportPreflightResult,
	type WenyouWorkspaceOverview,
} from "@percho/shared";

/** 剥离 environmentEntityKey 前缀，拿到真实目录路径（local 直接原样返回） */
export function unwrapCwdPath(cwd: string | null | undefined): string | null {
	if (!cwd) return null;
	try {
		return environmentEntityRef(cwd).id;
	} catch {
		return cwd;
	}
}

export function isRemoteCwd(cwd: string | null | undefined): boolean {
	if (!cwd) return false;
	try {
		return environmentEntityRef(cwd).environment.kind === "ssh";
	} catch {
		return false;
	}
}

export function normalizeDirForCompare(raw: string): string {
	const unwrapped = unwrapCwdPath(raw) ?? raw;
	const slash = unwrapped.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-zA-Z]:\//.test(slash) || /^[a-zA-Z]:$/.test(slash) ? slash.toLowerCase() : slash;
}

export function sameDirectoryPath(a: string | null | undefined, b: string | null | undefined): boolean {
	if (!a || !b) return false;
	return normalizeDirForCompare(a) === normalizeDirForCompare(b);
}

/** 从当前战役概览中收集出现过的阵营 ID，供 ViewerScope 选择器与发包视角复用 */
export function extractAvailableFactions(overview: WenyouWorkspaceOverview | null): string[] {
	if (!overview) return [];
	const set = new Set<string>();
	for (const doc of overview.canonDocs) {
		for (const f of doc.visibleToFactions ?? []) {
			if (f.trim()) set.add(f.trim());
		}
	}
	for (const entry of overview.rollingLedger) {
		if (entry.faction?.trim()) set.add(entry.faction.trim());
	}
	for (const policy of overview.policies) {
		if (policy.actor?.trim()) set.add(policy.actor.trim());
	}
	for (const prop of overview.proposals) {
		if (prop.viewer?.kind === "faction" && prop.viewer.factionId.trim()) {
			set.add(prop.viewer.factionId.trim());
		}
	}
	if (overview.viewer.kind === "faction" && overview.viewer.factionId.trim()) {
		set.add(overview.viewer.factionId.trim());
	}
	return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function formatShortTime(iso: string | undefined): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface SimpleDiffLine {
	kind: "context" | "add" | "del";
	text: string;
	oldLine?: number;
	newLine?: number;
}

/** 轻量行级 Diff（LCS 回溯，超大文件优雅降级防卡顿） */
export function computeSimpleLineDiff(before: string | undefined, after: string): SimpleDiffLine[] {
	const oldLines = before === undefined ? [] : before.replace(/\r\n/g, "\n").split("\n");
	const newLines = after.replace(/\r\n/g, "\n").split("\n");

	if (oldLines.length === 0) {
		return newLines.map((text, idx) => ({ kind: "add", text, newLine: idx + 1 }));
	}
	if (oldLines.length * newLines.length > 250_000) {
		return [
			...oldLines.map((text, idx): SimpleDiffLine => ({ kind: "del", text, oldLine: idx + 1 })),
			...newLines.map((text, idx): SimpleDiffLine => ({ kind: "add", text, newLine: idx + 1 })),
		];
	}

	const m = oldLines.length;
	const n = newLines.length;
	const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
	for (let i = m - 1; i >= 0; i--) {
		const row = dp[i]!;
		const nextRow = dp[i + 1]!;
		const oldLine = oldLines[i]!;
		for (let j = n - 1; j >= 0; j--) {
			row[j] = oldLine === newLines[j]! ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
		}
	}

	const result: SimpleDiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (oldLines[i] === newLines[j]) {
			result.push({ kind: "context", text: oldLines[i]!, oldLine: i + 1, newLine: j + 1 });
			i += 1;
			j += 1;
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			result.push({ kind: "del", text: oldLines[i]!, oldLine: i + 1 });
			i += 1;
		} else {
			result.push({ kind: "add", text: newLines[j]!, newLine: j + 1 });
			j += 1;
		}
	}
	while (i < m) {
		result.push({ kind: "del", text: oldLines[i]!, oldLine: i + 1 });
		i += 1;
	}
	while (j < n) {
		result.push({ kind: "add", text: newLines[j]!, newLine: j + 1 });
		j += 1;
	}
	return result;
}

function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

interface ExportedBundleShape {
	worldTitle?: string;
	exportedAt?: string;
	documents?: Array<{ relPath: string; title: string; content: string }>;
	maps?: Array<{ name: string; relPath: string; yearLabel?: string }>;
}

/** 将泄密预检通过的 bundleJson 渲染为彻底离线、零外链的单文件群友编年史 HTML */
export function renderOfflineChronicleHtml(preflight: WenyouExportPreflightResult): string {
	let parsed: ExportedBundleShape = {};
	try {
		parsed = JSON.parse(preflight.bundleJson) as ExportedBundleShape;
	} catch {
		parsed = {};
	}
	const title = parsed.worldTitle || "文游世界离线图史包";
	const viewerLabel = formatViewerScope(preflight.targetViewer);
	const docs = parsed.documents ?? [];
	const maps = parsed.maps ?? [];

	const navItems = docs
		.map(
			(doc, idx) =>
				`<a class="nav-link" href="#doc-${idx}" data-title="${escapeHtml(doc.title.toLowerCase())}">${escapeHtml(doc.title)}<span>${escapeHtml(doc.relPath)}</span></a>`,
		)
		.join("\n");

	const articleBlocks = docs
		.map(
			(doc, idx) => `
		<article class="doc-card" id="doc-${idx}" data-search="${escapeHtml(`${doc.title} ${doc.relPath} ${doc.content}`.toLowerCase())}">
			<header class="doc-head">
				<h2>${escapeHtml(doc.title)}</h2>
				<code>${escapeHtml(doc.relPath)}</code>
			</header>
			<div class="doc-body">${escapeHtml(doc.content).replace(/\n/g, "<br/>")}</div>
		</article>`,
		)
		.join("\n");

	const mapList =
		maps.length > 0
			? `<section class="meta-section"><h3>收录地图索引（${maps.length}）</h3><ul>${maps
					.map(
						(m) =>
							`<li><strong>${escapeHtml(m.name)}</strong>${m.yearLabel ? ` · ${escapeHtml(m.yearLabel)}` : ""} <code>${escapeHtml(m.relPath)}</code></li>`,
					)
					.join("")}</ul></section>`
			: "";

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} · 离线档案包（${escapeHtml(viewerLabel)}）</title>
<style>
:root { --bg: #fafaf9; --card: #ffffff; --ink: #18181b; --dim: #71717a; --border: #e4e4e7; --accent: #6d28d9; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #141417; --card: #1d1d22; --ink: #e4e4e7; --dim: #9a9aa3; --border: #303038; --accent: #a78bfa; }
}
* { box-sizing: border-box; }
body { margin: 0; font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--ink); line-height: 1.75; }
.layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
aside { border-right: 1px solid var(--border); padding: 20px 16px; position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--card); }
h1 { font-size: 1.125rem; margin: 0 0 6px; }
.badge { display: inline-block; font-size: 0.75rem; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--dim); margin-bottom: 12px; }
input[type="search"] { width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--ink); font-size: 0.8125rem; margin-bottom: 12px; }
.nav-link { display: block; padding: 7px 9px; border-radius: 8px; text-decoration: none; color: var(--ink); font-size: 0.8125rem; margin-bottom: 2px; }
.nav-link:hover { background: var(--bg); }
.nav-link span { display: block; font-size: 0.6875rem; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
main { padding: 28px 36px; max-width: 920px; }
.doc-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 22px 24px; margin-bottom: 20px; }
.doc-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 14px; }
.doc-head h2 { margin: 0; font-size: 1.0625rem; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.75rem; color: var(--dim); }
.doc-body { font-size: 0.90625rem; white-space: normal; word-break: break-word; }
.meta-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 0.8125rem; color: var(--dim); }
footer { margin-top: 32px; font-size: 0.75rem; color: var(--dim); }
@media (max-width: 768px) { .layout { grid-template-columns: 1fr; } aside { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--border); } main { padding: 18px; } }
</style>
</head>
<body>
<div class="layout">
  <aside>
    <h1>${escapeHtml(title)}</h1>
    <div class="badge">导出视角：${escapeHtml(viewerLabel)} · 文档 ${docs.length} 篇</div>
    <input id="q" type="search" placeholder="筛选档案标题或正文…" />
    <nav id="nav">${navItems || '<p style="font-size:0.75rem;color:var(--dim)">无可导出公开文档</p>'}</nav>
  </aside>
  <main>
    ${articleBlocks || '<div class="doc-card">当前视角下暂无可导出的正史与设定文档。</div>'}
    ${mapList}
    <footer>由 Wenyou Pro 离线档案发包器导出 · 导出时间：${escapeHtml(parsed.exportedAt ?? new Date().toISOString())} · 已拦截私有/群聊文件 ${preflight.blockedPrivateFiles.length} 个，剥离受限暗线块 ${preflight.strippedSecretBlockCount} 处</footer>
  </main>
</div>
<script>
const input = document.getElementById('q');
const cards = Array.from(document.querySelectorAll('.doc-card'));
const links = Array.from(document.querySelectorAll('.nav-link'));
input && input.addEventListener('input', () => {
  const kw = input.value.trim().toLowerCase();
  cards.forEach((c) => { c.style.display = !kw || (c.dataset.search || '').includes(kw) ? '' : 'none'; });
  links.forEach((l) => { l.style.display = !kw || (l.dataset.title || '').includes(kw) ? '' : 'none'; });
});
</script>
</body>
</html>`;
}
