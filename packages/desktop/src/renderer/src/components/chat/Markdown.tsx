import { environmentEntityRef } from "@percho/shared";
import MarkdownRender, { type SmoothMarkdownStreamOptions } from "markstream-react";
import "markstream-react/index.css";
import { type ComponentProps, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { getPi } from "../../api";
import { errText } from "../../lib/error-text";
import { useThemeStore } from "../../stores/theme";
import { pushToast } from "../../stores/toasts";
import { FilePathMenu } from "../ui/FilePathMenu";
import { anchorOfElement, type MenuAnchor } from "../ui/place-menu";
import { classifyMarkdownLink } from "./markdown-link";
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

const CODE_BLOCK_PROPS_BASE = {
	// 标题栏在视觉上被 CSS 悬浮化（见 globals.css），这里只裁掉多余按钮：字号三键/全屏/预览/折叠，
	// 保留复制。不能用 showHeader:false——它会连复制按钮一起去掉。
	showFontSizeButtons: false,
	showExpandButton: false,
	showPreviewButton: false,
	showCollapseButton: false,
} as const;

/** 减速动效偏好：关闭 pacing，直接输出 */
const REDUCED_MOTION =
	typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 首次直出已有正文，让库先 reset 到当前内容；挂载后只对新增 delta 启用 pacing。 */
function MarkdownContent({ smoothStreaming, ...props }: ComponentProps<typeof MarkdownRender>) {
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	return <MarkdownRender {...props} smoothStreaming={mounted && Boolean(smoothStreaming)} />;
}

/**
 * Markdown 渲染：markstream-react（增量解析，为流式 token 设计，避免 react-markdown 每帧全量 re-parse）。
 * 代码块走 markstream-react 轻量纯文本回退渲染，不引入 Monaco / Shiki / Mermaid / KaTeX。
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
		if (link.kind === "file" && cwd && environmentEntityRef(cwd).environment.kind === "ssh") {
			setMenu({ target: link.target, cwd, anchor: anchorOfElement(anchor) });
			return;
		}
		const operation =
			link.kind === "external"
				? getPi().openExternal({ url: link.url })
				: cwd
					? getPi().openPath({ target: link.target, cwd })
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
					codeBlockProps={CODE_BLOCK_PROPS_BASE}
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
