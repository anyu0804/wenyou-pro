import { environmentEntityRef } from "@percho/shared";
import MarkdownRender, {
	type MarkstreamCustomComponent,
	setCustomComponents,
	type SmoothMarkdownStreamOptions,
} from "markstream-react";
import "markstream-react/index.css";
import { type ComponentProps, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { getPi } from "../../api";
import { useT } from "../../i18n";
import { errText } from "../../lib/error-text";
import { useThemeStore } from "../../stores/theme";
import { pushToast } from "../../stores/toasts";
import { FilePathMenu } from "../ui/FilePathMenu";
import { anchorOfElement, type MenuAnchor } from "../ui/place-menu";
import { classifyMarkdownLink, isAbsoluteMarkdownFileTarget } from "./markdown-link";
import { markdownParseOptions } from "./markdown-parse-options";
import { plainParagraphNodes } from "./plain-paragraph";

/**
 * 平滑输出速率参数（markstream 内置 smooth streaming controller，grapheme 级 pacing）：
 * - min 80 cps：小 delta 时的基速（利落的打字机感，不拖沓）
 * - 自适应：backlog <600 字在 900ms 内追平；超过则切换到 350ms 快进（≤1000 cps、
 *   每次 commit ≤80 字、30fps）——大 trunk 变成连续滑出而非整块蹦现，且不会越积越多
 * - flushOnFinish 保持 false：final（turn_end 固化）后不跳变，继续平滑追完剩余 backlog
 */
const SMOOTH_OPTIONS: SmoothMarkdownStreamOptions = {
	minCharsPerSecond: 80,
};

/** 减速动效偏好：关闭 pacing，直接输出 */
const REDUCED_MOTION =
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function writeTextToClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// 剪贴板 API 不可用或被拒时走 execCommand 回退
		}
	}
	if (typeof document === "undefined") return false;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		textarea.remove();
	}
}

/**
 * 轻量纯文本代码块卡片（不引入 Monaco / Shiki）：
 * 圆角边框 + 浅底色 + 顶部语言栏与一键复制按钮（视觉容器嵌套 ≤ 2 层）。
 */
function PlainCodeBlock({
	node,
}: {
	node?: { code?: string; raw?: string; language?: string };
}) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | null>(null);
	const rawLang = (node?.language ?? "").trim();
	const lang = rawLang ? rawLang.split(/\s+/)[0]?.split(":")[0]?.toLowerCase() ?? "" : "";
	const code = node?.code ?? node?.raw ?? "";

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, []);

	const handleCopy = () => {
		void writeTextToClipboard(code).then((ok) => {
			if (!ok) return;
			setCopied(true);
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
			timerRef.current = window.setTimeout(() => {
				timerRef.current = null;
				setCopied(false);
			}, 1800);
		});
	};

	const copyLabel = copied ? t("message.copied") : t("message.copy");

	return (
		<div
			data-code-block={lang || "plain"}
			className="my-2.5 overflow-hidden rounded-xl border border-border bg-surface/75 shadow-soft"
		>
			<div className="flex items-center justify-between gap-2 border-b border-border/70 bg-hover/40 px-3 py-1.5 text-ui-11 text-ink-dim">
				<span className="truncate font-mono text-ui-11 text-ink-dim">{lang || "text"}</span>
				<button
					type="button"
					data-code-copy=""
					onClick={handleCopy}
					aria-label={copyLabel}
					className="shrink-0 rounded-md border border-border bg-canvas/80 px-2 py-0.5 text-ui-11 text-ink-2 transition-colors hover:border-border-strong hover:bg-hover hover:text-ink"
				>
					{copyLabel}
				</button>
			</div>
			<pre
				className="m-0 overflow-x-auto px-3.5 py-2.5 font-mono leading-relaxed text-ink"
				style={{ fontSize: "calc(12.5px * var(--fs-code-scale, 1))" }}
			>
				<code className={lang ? `language-${lang}` : undefined}>{code}</code>
			</pre>
		</div>
	);
}

/**
 * 图表代码块纯文本回退：mermaid / d2 / infographic 运行时包已裁剪，经 empty-stub 别名后
 * 若交由 markstream-react 默认渲染器会触发动态 import 解析出 `{}` 并报 render/constructor 异常；
 * 注册轻量 `<pre><code>` 兜底组件直接保留可读源码。
 */
function PlainDiagramCodeBlock({
	node,
}: {
	node?: { code?: string; raw?: string; language?: string };
}) {
	const lang = (node?.language ?? "").trim().toLowerCase();
	const code = node?.code ?? node?.raw ?? "";
	return (
		<pre
			data-diagram-fallback={lang || "diagram"}
			className="my-2 overflow-x-auto rounded-lg border border-border bg-surface/60 px-3 py-2 font-mono text-ui-12 leading-relaxed text-ink"
		>
			<code className={lang ? `language-${lang}` : undefined}>{code}</code>
		</pre>
	);
}

function PlainMathInline({
	node,
}: {
	node?: { raw?: string; content?: string };
}) {
	const text = node?.raw ?? (node?.content ? `$${node.content}$` : "");
	return (
		<code data-math-fallback="inline" className="font-mono text-ui-13">
			{text}
		</code>
	);
}

function PlainMathBlock({
	node,
}: {
	node?: { raw?: string; content?: string };
}) {
	const text = node?.raw ?? node?.content ?? "";
	return (
		<pre
			data-math-fallback="block"
			className="my-2 overflow-x-auto rounded-lg border border-border bg-surface/60 px-3 py-2 font-mono text-ui-12 leading-relaxed text-ink"
		>
			<code>{text}</code>
		</pre>
	);
}

setCustomComponents({
	code_block: PlainCodeBlock as MarkstreamCustomComponent,
	mermaid: PlainDiagramCodeBlock as MarkstreamCustomComponent,
	d2: PlainDiagramCodeBlock as MarkstreamCustomComponent,
	infographic: PlainDiagramCodeBlock as MarkstreamCustomComponent,
	math_inline: PlainMathInline as MarkstreamCustomComponent,
	math_block: PlainMathBlock as MarkstreamCustomComponent,
});

/** 首次直出已有正文，让库先 reset 到当前内容；挂载后只对新增 delta 启用 pacing。 */
function MarkdownContent({ smoothStreaming, ...props }: ComponentProps<typeof MarkdownRender>) {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	return <MarkdownRender {...props} smoothStreaming={mounted && Boolean(smoothStreaming)} />;
}

/**
 * Markdown 渲染：markstream-react（增量解析，为流式 token 设计，避免 react-markdown 每帧全量 re-parse）。
 * 代码块走轻量纯文本卡片组件（带语言栏与复制按钮），不引入 Monaco / Shiki / Mermaid / KaTeX。
 */
export function Markdown({
	text,
	streaming,
	cwd = null,
}: {
	text: string;
	streaming?: boolean;
	cwd?: string | null;
}) {
	const isDark = useThemeStore((s) => s.resolved === "dark");
	const [menu, setMenu] = useState<{ target: string; cwd: string; anchor: MenuAnchor } | null>(null);
	const onLinkClick = (event: MouseEvent<HTMLDivElement>) => {
		const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!anchor || !event.currentTarget.contains(anchor)) return;
		const href = anchor.getAttribute("href");
		if (!href) return;
		const link = classifyMarkdownLink(href);
		if (link.kind === "anchor") return;
		// 包括 Cmd/Ctrl 点击的默认行为都不应把应用页面导航走；主进程另有兜底拦截。
		event.preventDefault();
		if (link.kind === "unsupported") return;
		const activeCwd = cwd?.trim() ? cwd : null;
		if (link.kind === "file" && activeCwd && environmentEntityRef(activeCwd).environment.kind === "ssh") {
			setMenu({ target: link.target, cwd: activeCwd, anchor: anchorOfElement(anchor) });
			return;
		}
		const operation =
			link.kind === "external"
				? getPi().openExternal({ url: link.url })
				: activeCwd || isAbsoluteMarkdownFileTarget(link.target)
					? getPi().openPath({ target: link.target, cwd: activeCwd })
					: Promise.reject(new Error("No session working directory for relative link"));
		void operation.catch((error: unknown) => {
			pushToast("error", "toast.pathOpenFailed", errText(error));
		});
	};
	// 挂载初值锁定：流式中挂载 → 本次生命周期始终启用平滑（含固化后追平）；历史消息挂载 → 永不启用
	const smoothableRef = useRef<boolean>(Boolean(streaming) && !REDUCED_MOTION);
	const plainNodes = useMemo(
		() => plainParagraphNodes(text, { streaming, smoothStreaming: smoothableRef.current }),
		[text, streaming],
	);
	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: delegates native anchor clicks */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: native anchors dispatch keyboard clicks */}
			<div className="markdown-body text-ui-15 leading-[1.75] text-ink select-text" onClick={onLinkClick}>
				{/* deferNodesUntilVisible=false：避免 markstream 0.0.55 大消息停流后残留占位条 */}
				<MarkdownContent
					content={text}
					nodes={plainNodes}
					final={!streaming}
					parseOptions={markdownParseOptions}
					fade={false}
					smoothStreaming={smoothableRef.current}
					smoothStreamingOptions={SMOOTH_OPTIONS}
					isDark={isDark}
					deferNodesUntilVisible={false}
				/>
			</div>
			{menu && (
				<FilePathMenu
					target={menu.target}
					cwd={menu.cwd}
					fileUrl
					anchor={menu.anchor}
					onClose={() => setMenu(null)}
				/>
			)}
		</>
	);
}
