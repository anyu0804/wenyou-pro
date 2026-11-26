import { formatViewerScope, type ViewerScope } from "@percho/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPi } from "../../api";
import { getExecutionApi } from "../../environment-api";
import { pushExtensionToast } from "../../stores/toasts";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";
import { extractAvailableFactions, renderOfflineChronicleHtml } from "./wenyou-helpers";

/** Tab 4 — 可见档案速览与群友离线包泄密预检/发包面板 */
export function ProposalsExportPanel() {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);
	const viewerScope = useWenyouCanvasStore((s) => s.viewerScope);
	const preflightTargetViewer = useWenyouCanvasStore((s) => s.preflightTargetViewer);
	const setPreflightTargetViewer = useWenyouCanvasStore((s) => s.setPreflightTargetViewer);
	const preflightResult = useWenyouCanvasStore((s) => s.preflightResult);
	const preflightLoading = useWenyouCanvasStore((s) => s.preflightLoading);
	const runExportPreflight = useWenyouCanvasStore((s) => s.runExportPreflight);

	const [section, setSection] = useState<"canon" | "export">("canon");
	const [exportingFormat, setExportingFormat] = useState<"html" | "json" | null>(null);

	// 设定与编年史档案速览状态
	const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
	const [previewDocContent, setPreviewDocContent] = useState<{
		content: string;
		strippedSecretBlocks: number;
	} | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const previewRequestSeqRef = useRef(0);
	const previewDocPathRef = useRef<string | null>(null);
	previewDocPathRef.current = previewDocPath;
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;
	const viewerKey = formatViewerScope(viewerScope);

	const factions = useMemo(() => extractAvailableFactions(overview), [overview]);
	const canonDocs = overview?.canonDocs ?? [];

	const handleExportBundle = async (format: "html" | "json") => {
		const report = preflightResult ?? (await runExportPreflight(preflightTargetViewer));
		if (!report) return;
		setExportingFormat(format);
		try {
			const worldSlug = overview?.worldId || "wenyou-chronicle";
			const scopeSlug = preflightTargetViewer.replace(/[^a-zA-Z0-9_-]+/g, "-");
			const defaultName = `${worldSlug}-${scopeSlug}.${format}`;
			const content = format === "html" ? renderOfflineChronicleHtml(report) : report.bundleJson;
			const saved = await getPi().wenyouExportBundleDialog({
				defaultName,
				content,
				format,
			});
			if (saved) {
				pushExtensionToast(
					"info",
					`已安全导出${format === "html" ? "离线 HTML 图史包" : " JSON 归档包"}：${saved}`,
					"Wenyou Pro",
				);
			}
		} catch (error) {
			pushExtensionToast(
				"error",
				`导出离线包失败：${error instanceof Error ? error.message : String(error)}`,
				"Wenyou Pro",
			);
		} finally {
			setExportingFormat(null);
		}
	};

	const loadCanonDoc = useCallback(
		async (targetCwd: string, relPath: string, scope: ViewerScope, notifyOnError: boolean) => {
			const seq = ++previewRequestSeqRef.current;
			setPreviewLoading(true);
			setPreviewError(null);
			try {
				const viewer = formatViewerScope(scope);
				const res = await getExecutionApi(targetCwd).wenyouReadCanonDoc({
					cwd: targetCwd,
					relPath,
					viewer,
				});
				if (seq !== previewRequestSeqRef.current || cwdRef.current !== targetCwd) return;
				setPreviewDocContent({
					content: res.content,
					strippedSecretBlocks: res.strippedSecretBlocks,
				});
				setPreviewError(null);
			} catch (error) {
				if (seq !== previewRequestSeqRef.current || cwdRef.current !== targetCwd) return;
				const msg = error instanceof Error ? error.message : String(error);
				setPreviewDocContent(null);
				setPreviewError(msg);
				if (notifyOnError) {
					pushExtensionToast("error", `读取档案失败：${msg}`, "Wenyou Pro");
				}
			} finally {
				if (seq === previewRequestSeqRef.current) {
					setPreviewLoading(false);
				}
			}
		},
		[],
	);

	// 切换世界时清空档案预览与在途请求
	useEffect(() => {
		previewRequestSeqRef.current += 1;
		previewDocPathRef.current = null;
		setPreviewDocPath(null);
		setPreviewDocContent(null);
		setPreviewError(null);
		setPreviewLoading(false);
	}, [cwd]);

	// 切换视角时立即清除旧密文缓存并按新视角重拉当前打开的档案
	useEffect(() => {
		const openedPath = previewDocPathRef.current;
		if (!cwd || !openedPath) return;
		setPreviewDocContent(null);
		setPreviewError(null);
		void loadCanonDoc(cwd, openedPath, viewerScope, false);
	}, [cwd, viewerKey, viewerScope, loadCanonDoc]);

	const handleOpenCanonDoc = async (relPath: string) => {
		if (!cwd) return;
		previewDocPathRef.current = relPath;
		setPreviewDocPath(relPath);
		setPreviewDocContent(null);
		setPreviewError(null);
		await loadCanonDoc(cwd, relPath, viewerScope, true);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 子导航切换 */}
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-1 rounded-lg bg-hover p-0.5">
					<button
						type="button"
						onClick={() => setSection("canon")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							section === "canon"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						可见档案 ({canonDocs.length})
					</button>
					<button
						type="button"
						onClick={() => setSection("export")}
						className={`rounded-md px-2.5 py-1 text-ui-12 font-medium transition-colors ${
							section === "export"
								? "bg-canvas text-ink shadow-soft"
								: "text-ink-dim hover:text-ink"
						}`}
					>
						泄密预检与发包
					</button>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				{section === "export" && (
					<div className="space-y-4">
						<div className="space-y-2">
							<h3 className="text-ui-14 font-semibold text-ink">群友离线包泄密预检与发包</h3>
							<p className="text-ui-12 leading-relaxed text-ink-dim">
								系统会按选定视角强制物理拦截 <code className="font-mono">private/</code> 与{" "}
								<code className="font-mono">00-群聊收集/</code> 原始聊天记录，并自动剥离超出权限的{" "}
								<code className="font-mono">:::secret[...]</code> 暗线块。
							</p>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							<label htmlFor="wenyou-export-viewer" className="text-ui-12 text-ink-dim">
								发包视角
							</label>
							<select
								id="wenyou-export-viewer"
								value={preflightTargetViewer}
								onChange={(e) => setPreflightTargetViewer(e.target.value)}
								className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-ui-12 text-ink outline-none focus:border-accent"
							>
								<option value="public">公开视角（public · 群友通用）</option>
								{factions.map((f) => (
									<option key={f} value={`faction:${f}`}>
										阵营专属（faction:{f}）
									</option>
								))}
							</select>
							<button
								type="button"
								disabled={preflightLoading}
								onClick={() => void runExportPreflight(preflightTargetViewer)}
								className="rounded-lg bg-ink px-3 py-1.5 text-ui-12 font-medium text-on-ink transition-opacity hover:opacity-90 disabled:opacity-50"
							>
								{preflightLoading ? "预检中…" : "运行泄密预检"}
							</button>
						</div>

						{preflightResult && (
							<div className="space-y-4 border-t border-border pt-4">
								{/* 4 项预检指标 */}
								<div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">放行文件</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-ok">
											{preflightResult.allowedFiles.length}
										</p>
									</div>
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">物理拦截私有/群聊</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-warn">
											{preflightResult.blockedPrivateFiles.length}
										</p>
									</div>
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">可见性隔离</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-ink">
											{preflightResult.blockedVisibilityFiles.length}
										</p>
									</div>
									<div className="rounded-xl border border-border bg-surface px-3 py-2.5">
										<p className="text-ui-11 text-ink-dim">剥离暗线块</p>
										<p className="mt-0.5 font-mono text-ui-16 font-semibold text-accent">
											{preflightResult.strippedSecretBlockCount}
										</p>
									</div>
								</div>

								{preflightResult.warnings.length > 0 && (
									<div className="space-y-1 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-ui-12 text-emerald-700 dark:text-emerald-300">
										{preflightResult.warnings.map((w, idx) => (
											<p key={idx}>✓ {w}</p>
										))}
									</div>
								)}

								{/* 明确列出已拦截清单，让主持人直观核验绝不泄密 */}
								{preflightResult.blockedPrivateFiles.length > 0 && (
									<div className="space-y-1.5">
										<p className="text-ui-12 font-medium text-ink">
											已物理拦截清单（private/ 与 00-群聊收集/，绝不打包）：
										</p>
										<div className="max-h-36 overflow-y-auto rounded-xl border border-border bg-surface px-3 py-2 font-mono text-ui-11 text-ink-dim">
											{preflightResult.blockedPrivateFiles.map((file) => (
												<div key={file} className="truncate py-0.5">
													✕ {file}
												</div>
											))}
										</div>
									</div>
								)}

								{preflightResult.blockedVisibilityFiles.length > 0 && (
									<div className="space-y-1.5">
										<p className="text-ui-12 font-medium text-ink">
											已按可见性隔离清单（仅 GM 或其他阵营可见）：
										</p>
										<div className="max-h-32 overflow-y-auto rounded-xl border border-border bg-surface px-3 py-2 font-mono text-ui-11 text-ink-dim">
											{preflightResult.blockedVisibilityFiles.map((file) => (
												<div key={file} className="truncate py-0.5">
													⊘ {file}
												</div>
											))}
										</div>
									</div>
								)}

								<div className="flex flex-wrap items-center gap-2 pt-1">
									<button
										type="button"
										disabled={exportingFormat !== null}
										onClick={() => void handleExportBundle("html")}
										className="rounded-lg bg-accent px-3.5 py-1.5 text-ui-12 font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
									>
										{exportingFormat === "html" ? "导出中…" : "导出单文件离线 HTML 图史包"}
									</button>
									<button
										type="button"
										disabled={exportingFormat !== null}
										onClick={() => void handleExportBundle("json")}
										className="rounded-lg border border-border px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
									>
										{exportingFormat === "json" ? "导出中…" : "导出 JSON 归档包"}
									</button>
								</div>
							</div>
						)}
					</div>
				)}

				{section === "canon" && (
					<div className="space-y-3">
						<p className="text-ui-12 text-ink-dim">
							当前视角下可见的设定、国力实册与编年史（切换顶栏视角可即时验证暗线裁剪效果）：
						</p>
						{canonDocs.length === 0 ? (
							<div className="py-10 text-center text-ui-12 text-ink-faint">
								当前视角下暂无可见设定或编年史文档。
							</div>
						) : (
							<div className="divide-y divide-border rounded-xl border border-border bg-surface">
								{canonDocs.map((doc) => (
									<button
										key={doc.relPath}
										type="button"
										onClick={() => void handleOpenCanonDoc(doc.relPath)}
										className={`flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left transition-colors ${
											previewDocPath === doc.relPath ? "bg-accent/8" : "hover:bg-hover/70"
										}`}
									>
										<div className="min-w-0">
											<p className="truncate text-ui-13 font-medium text-ink">{doc.title}</p>
											<p className="truncate font-mono text-ui-11 text-ink-faint">{doc.relPath}</p>
										</div>
										<span className="shrink-0 rounded-full border border-border bg-hover px-2 py-0.5 text-ui-10 text-ink-dim">
											{doc.visibility}
										</span>
									</button>
								))}
							</div>
						)}

						{previewDocPath && (
							<div className="space-y-2 border-t border-border pt-3">
								<div className="flex items-center justify-between text-ui-11 text-ink-dim">
									<span className="font-mono">{previewDocPath}</span>
									{previewDocContent && previewDocContent.strippedSecretBlocks > 0 && (
										<span className="text-accent">
											已剥离 {previewDocContent.strippedSecretBlocks} 处受限暗线块
										</span>
									)}
								</div>
								{previewLoading ? (
									<p className="py-6 text-center text-ui-12 text-ink-faint">读取中…</p>
								) : previewError ? (
									<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-ui-12 text-amber-700 dark:text-amber-300">
										当前视角（{viewerKey}）无法查阅此档案：{previewError}
									</div>
								) : previewDocContent ? (
									<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3.5 text-ui-12 leading-relaxed text-ink select-text">
										{previewDocContent.content}
									</pre>
								) : null}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
