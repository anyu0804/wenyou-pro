import { useCallback, useEffect, useRef, useState } from "react";
import { getExecutionApi } from "../../environment-api";
import { pushExtensionToast } from "../../stores/toasts";
import { useWenyouCanvasStore } from "../../stores/wenyou-canvas";

/** Tab 4 — 设定与编年史只读浏览面板（01-设定与国力实册/ 与 04-编年史与条约/） */
export function ProposalsExportPanel() {
	const cwd = useWenyouCanvasStore((s) => s.cwd);
	const overview = useWenyouCanvasStore((s) => s.overview);

	const [previewDocPath, setPreviewDocPath] = useState<string | null>(null);
	const [previewDocContent, setPreviewDocContent] = useState<string | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [previewLoading, setPreviewLoading] = useState(false);
	const previewRequestSeqRef = useRef(0);
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;

	const canonDocs = overview?.canonDocs ?? [];

	const loadCanonDoc = useCallback(async (targetCwd: string, relPath: string) => {
		const seq = ++previewRequestSeqRef.current;
		setPreviewLoading(true);
		setPreviewError(null);
		try {
			const res = await getExecutionApi(targetCwd).wenyouReadCanonDoc({
				cwd: targetCwd,
				relPath,
			});
			if (seq !== previewRequestSeqRef.current || cwdRef.current !== targetCwd) return;
			setPreviewDocContent(res.content);
			setPreviewError(null);
		} catch (error) {
			if (seq !== previewRequestSeqRef.current || cwdRef.current !== targetCwd) return;
			const msg = error instanceof Error ? error.message : String(error);
			setPreviewDocContent(null);
			setPreviewError(msg);
			pushExtensionToast("error", `读取档案失败：${msg}`, "Wenyou Pro");
		} finally {
			if (seq === previewRequestSeqRef.current) {
				setPreviewLoading(false);
			}
		}
	}, []);

	// 切换世界时清空档案预览与在途请求
	useEffect(() => {
		previewRequestSeqRef.current += 1;
		setPreviewDocPath(null);
		setPreviewDocContent(null);
		setPreviewError(null);
		setPreviewLoading(false);
	}, [cwd]);

	const handleOpenCanonDoc = async (relPath: string) => {
		if (!cwd) return;
		setPreviewDocPath(relPath);
		setPreviewDocContent(null);
		setPreviewError(null);
		await loadCanonDoc(cwd, relPath);
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
				<span className="text-ui-12 font-medium text-ink">
					设定与编年史 ({canonDocs.length})
				</span>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
				<div className="space-y-3">
					<p className="text-ui-12 text-ink-dim">
						只读浏览 <code className="font-mono">01-设定与国力实册/</code> 与{" "}
						<code className="font-mono">04-编年史与条约/</code> 下的档案文档：
					</p>
					{canonDocs.length === 0 ? (
						<div className="py-10 text-center text-ui-12 text-ink-faint">
							当前工作区暂无设定实册或编年史文档。
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
										{doc.kind === "setting" ? "设定实册" : "编年史"}
									</span>
								</button>
							))}
						</div>
					)}

					{previewDocPath && (
						<div className="space-y-2 border-t border-border pt-3">
							<div className="flex items-center justify-between text-ui-11 text-ink-dim">
								<span className="font-mono">{previewDocPath}</span>
							</div>
							{previewLoading ? (
								<p className="py-6 text-center text-ui-12 text-ink-faint">读取中…</p>
							) : previewError ? (
								<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-ui-12 text-amber-700 dark:text-amber-300">
									读取档案失败：{previewError}
								</div>
							) : previewDocContent !== null ? (
								<pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3.5 text-ui-12 leading-relaxed text-ink select-text">
									{previewDocContent}
								</pre>
							) : null}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
