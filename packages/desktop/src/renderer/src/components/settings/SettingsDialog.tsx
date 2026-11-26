import { LOCAL_ENVIRONMENT } from "@percho/shared";
import type { ComponentType, CSSProperties } from "react";
import { useEffect, useRef } from "react";
import { EnvironmentContext } from "../../environment-context";
import { useT } from "../../i18n";
import { useEdgeFade } from "../../lib/use-edge-fade";
import {
	type SettingsCategory,
	useLocalSettingsStore as useSettingsStore,
} from "../../stores/settings";
import { SettingsIcon } from "../icons/SettingsIcon";
import "./settings-dialog.css";
import { AboutPanel } from "./AboutPanel";
import { AppearancePanel } from "./AppearancePanel";
import { ArchivedChatsPanel } from "./ArchivedChatsPanel";
import { ExtensionsPanel } from "./extensions/ExtensionsPanel";
import { GeneralPanel } from "./GeneralPanel";
import { McpPanel } from "./mcp/McpPanel";
import { ProvidersPanel } from "./providers/ProvidersPanel";
import { SkillsPanel } from "./SkillsPanel";

const STATIC_CATEGORIES = [
	"general",
	"appearance",
	"archived",
	"models",
	"skills",
	"mcp",
	"extensions",
	"about",
] as const satisfies readonly SettingsCategory[];

const CATEGORY_ICONS = {
	general: "gear",
	appearance: "sun",
	archived: "archive",
	models: "sliders",
	skills: "file",
	mcp: "plug",
	extensions: "package",
	about: "info",
} as const;

/** 面板注册表：新增分类 = 写一个面板组件 + 在这里登记（未登记显示 coming soon） */
const PANELS: Partial<Record<SettingsCategory, ComponentType>> = {
	general: GeneralPanel,
	appearance: AppearancePanel,
	archived: ArchivedChatsPanel,
	models: ProvidersPanel,
	skills: SkillsPanel,
	mcp: McpPanel,
	extensions: ExtensionsPanel,
	about: AboutPanel,
};

/** 设置弹窗：只在打开时挂载（弹窗体里的滚动容器需要在挂载时就能拿到 ref —— useEdgeFade 不会因
    元素后出现而重跑） */
export function SettingsDialog() {
	const open = useSettingsStore((s) => s.open);
	if (!open) return null;
	return (
		<EnvironmentContext.Provider value={LOCAL_ENVIRONMENT}>
			<SettingsDialogBody />
		</EnvironmentContext.Provider>
	);
}

/** 弹窗体：左侧分类导航 + 右侧内容，两列均可独立滚动 */
function SettingsDialogBody() {
	const t = useT();
	const setOpen = useSettingsStore((s) => s.setOpen);
	const category = useSettingsStore((s) => s.category);
	const setCategory = useSettingsStore((s) => s.setCategory);

	// 两列各自是滚动容器：分割线只留左导航右缘那条（`.fade-rule-v`），内容区的边界改由滚动淡出表达
	const navRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	useEdgeFade(navRef);
	useEdgeFade(contentRef);

	const staticCategory = STATIC_CATEGORIES.find((id) => id === category) ?? "general";
	const Panel = PANELS[staticCategory];
	const dialogRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const dialog = dialogRef.current;
		dialog?.querySelector<HTMLButtonElement>('button[aria-current="page"]')?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (!dialog || event.defaultPrevented) return;
			const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
			if (dialogs[dialogs.length - 1] !== dialog) return;
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
			} else if (event.key === "Tab" && dialog.contains(document.activeElement)) {
				const items = [
					...dialog.querySelectorAll<HTMLElement>(
						'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
					),
				].filter((item) => item.getClientRects().length > 0);
				if (!items.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault();
					last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			previous?.focus();
		};
	}, [setOpen]);

	return (
		<div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/20">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={t("settings.title")}
				className="settings-dialog relative flex flex-col overflow-hidden bg-surface shadow-dialog"
			>
				<div className="settings-dialog-toolbar">
					<button
						type="button"
						className="settings-dialog-close flex items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-hover hover:text-ink-2 focus-visible:outline-2 focus-visible:outline-ink-faint"
						onClick={() => setOpen(false)}
						aria-label={t("common.close")}
					>
						<SettingsIcon name="close" />
					</button>
				</div>
				<div className="flex min-h-0 flex-1">
					{/* 与内容的分界：中段实、两头淡出的发丝线（`.fade-rule-v`，同左栏） */}
					<nav
						ref={navRef}
						className="settings-dialog-nav fade-rule-v edge-fade shrink-0 overflow-y-auto"
						style={{ "--edge-fade-size": "16px" } as CSSProperties}
					>
						<h2 className="settings-dialog-heading text-ui-16 font-semibold text-ink">
							{t("settings.title")}
						</h2>
						{STATIC_CATEGORIES.map((id) => (
							<button
								key={id}
								type="button"
								aria-current={staticCategory === id ? "page" : undefined}
								className={`mb-0.5 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-ui-13 transition-colors ${
									staticCategory === id
										? "bg-hover font-medium text-ink"
										: "text-ink-dim hover:bg-hover hover:text-ink"
								}`}
								onClick={() => setCategory(id)}
							>
								<span className="flex w-3.5 shrink-0 items-center justify-center">
									<SettingsIcon name={CATEGORY_ICONS[id]} />
								</span>
								<span className="min-w-0">{t(`settings.category.${id}`)}</span>
							</button>
						))}
					</nav>
					<div
						ref={contentRef}
						className="settings-dialog-content edge-fade min-w-0 flex-1 overflow-auto"
						style={{ "--edge-fade-size": "20px" } as CSSProperties}
					>
						<div
							className={
								staticCategory === "general" || staticCategory === "appearance"
									? "settings-dialog-form"
									: undefined
							}
						>
							<h1 className="text-ui-28 font-semibold text-ink">
								{t(`settings.category.${staticCategory}`)}
							</h1>
							<div className="settings-dialog-panel">
								{Panel ? (
									<Panel />
								) : (
									<p className="py-8 text-center text-ui-13 text-ink-faint">{t("settings.comingSoon")}</p>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
