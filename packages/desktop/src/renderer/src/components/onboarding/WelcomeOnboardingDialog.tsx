import { LOCAL_ENVIRONMENT, type NtqqStatusSnapshot, type ProviderInfo, type UpstreamModelInfo } from "@percho/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getPi } from "../../api";
import { EnvironmentContext } from "../../environment-context";
import { useProviderLoginStore } from "../../stores/provider-login";
import { useSessionsStore } from "../../stores/sessions";
import { useLocalSettingsStore } from "../../stores/settings";
import { useUiPreferencesStore } from "../../stores/ui-preferences";
import { LoginDialog } from "../settings/providers/LoginDialog";
import { NtqqConfigSection } from "./NtqqConfigSection";

type ModelAuthMode = "api" | "oauth" | "custom";

/** 精选常用模型服务商（按国内文游玩家与主流订阅使用频率排序，实际存在才展示） */
const FEATURED_API_PROVIDERS = [
	"deepseek",
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"kimi-coding",
	"moonshotai-cn",
	"minimax-cn",
	"zai",
	"qwen-token-plan-cn",
] as const;

const INPUT_CLASS =
	"w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-ui-12 text-ink outline-none focus:border-accent disabled:opacity-50";

function stripInvokePrefix(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err);
	return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

function shortHash6(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0").slice(0, 6);
}

/** 生成确定性、互不冲突的自定义中转站 providerId（纯中文或含非 ASCII 名称附加 6 位哈希，同名重编辑保持幂等） */
export function slugProviderId(raw: string): string {
	const normalized = raw.trim().normalize("NFKC");
	if (!normalized) return "custom-relay";
	const clean = normalized
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	const hasNonAscii = [...normalized].some((ch) => ch.charCodeAt(0) > 127);
	if (!hasNonAscii && clean.length >= 2) return clean;
	const suffix = shortHash6(normalized);
	return clean ? `${clean}-${suffix}` : `custom-relay-${suffix}`;
}

/**
 * Wenyou Pro 两步首次启动向导：
 *   第 1 步：选择填写 API Key / 自定义中转站 或 接入订阅账号（复用 Percho 原生认证与 OAuth）
 *   第 2 步：填写本人 QQ 号并探测本机 NTQQ 只读消息库与密钥
 *
 * 视觉严格沿用 SettingsDialog / StartupSheet 的配色、字号与浅嵌套规范（z-50，LoginDialog z-[60] 浮于其上）。
 */
export function WelcomeOnboardingDialog() {
	const onboardingCompleted = useUiPreferencesStore((s) => s.onboardingCompleted);
	const onboardingForceOpen = useUiPreferencesStore((s) => s.onboardingForceOpen);
	const initialStep = useUiPreferencesStore((s) => s.onboardingInitialStep);
	const closeOnboarding = useUiPreferencesStore((s) => s.closeOnboarding);
	const settingsOpen = useLocalSettingsStore((s) => s.open);

	const visible = onboardingForceOpen || !onboardingCompleted;
	if (!visible) return null;

	return (
		<EnvironmentContext.Provider value={LOCAL_ENVIRONMENT}>
			<WelcomeOnboardingBody
				initialStep={initialStep}
				mountLoginDialog={!settingsOpen}
				onClose={() => closeOnboarding(true)}
			/>
		</EnvironmentContext.Provider>
	);
}

function WelcomeOnboardingBody({
	initialStep,
	mountLoginDialog,
	onClose,
}: {
	initialStep: 1 | 2;
	mountLoginDialog: boolean;
	onClose: () => void;
}) {
	const providers = useLocalSettingsStore((s) => s.providers);
	const loadingProviders = useLocalSettingsStore((s) => s.loading);
	const refreshProviders = useLocalSettingsStore((s) => s.refresh);
	const setProviderBaseUrl = useLocalSettingsStore((s) => s.setProviderBaseUrl);
	const saveKey = useLocalSettingsStore((s) => s.saveKey);
	const addCustom = useLocalSettingsStore((s) => s.addCustom);
	const listUpstreamModels = useLocalSettingsStore((s) => s.listUpstreamModels);
	const testProvider = useLocalSettingsStore((s) => s.test);
	const testResults = useLocalSettingsStore((s) => s.testResults);
	const startProviderLogin = useProviderLoginStore((s) => s.startProviderLogin);
	const loginActive = useProviderLoginStore((s) => s.login !== null);

	const [step, setStep] = useState<1 | 2>(initialStep);
	const [authMode, setAuthMode] = useState<ModelAuthMode>("api");

	// Step 1A: 内置 API Key 表单
	const [selectedProviderId, setSelectedProviderId] = useState<string>("deepseek");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [savingApi, setSavingApi] = useState(false);
	const [apiFeedback, setApiFeedback] = useState<{ kind: "info" | "error"; text: string } | null>(null);

	// Step 1C: 自定义中转站表单
	const [customName, setCustomName] = useState("");
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [customApiKey, setCustomApiKey] = useState("");
	const [customModelId, setCustomModelId] = useState("");
	const [upstreamModels, setUpstreamModels] = useState<UpstreamModelInfo[]>([]);
	const [fetchingUpstream, setFetchingUpstream] = useState(false);
	const [savingCustom, setSavingCustom] = useState(false);
	const [customFeedback, setCustomFeedback] = useState<{ kind: "info" | "error"; text: string } | null>(null);

	// Step 2: QQ 号与 NTQQ 状态追踪（用于点「完成」时自动代存尚未点保存的 QQ 输入）
	const draftQqRef = useRef("");
	const [ntqqSnapshot, setNtqqSnapshot] = useState<NtqqStatusSnapshot | null>(null);
	const [finishing, setFinishing] = useState(false);

	useEffect(() => {
		setStep(initialStep);
	}, [initialStep]);

	useEffect(() => {
		void refreshProviders();
	}, [refreshProviders]);

	const configuredProviders = useMemo(() => providers.filter((p) => p.configured), [providers]);
	const configuredModelCount = useMemo(
		() => configuredProviders.reduce((sum, p) => sum + p.models.length, 0),
		[configuredProviders],
	);

	const featuredProviders = useMemo(() => {
		const byId = new Map(providers.map((p) => [p.id, p]));
		const list: ProviderInfo[] = [];
		for (const id of FEATURED_API_PROVIDERS) {
			const hit = byId.get(id);
			if (hit) list.push(hit);
		}
		if (list.length === 0) return providers.filter((p) => !p.custom).slice(0, 8);
		return list;
	}, [providers]);

	const otherBuiltinProviders = useMemo(() => {
		const featuredSet = new Set(featuredProviders.map((p) => p.id));
		return providers.filter((p) => !p.custom && !featuredSet.has(p.id));
	}, [providers, featuredProviders]);

	// 仅展示真正支持官方 OAuth / 订阅账号登录的服务商；
	// DeepSeek 等仅支持 API Key 的服务商虽带有 SDK 通用 apiKey.login 交互输 Key 钩子，但不属于订阅账号登录，归入「填写 API Key」页签。
	const oauthProviders = useMemo(
		() => providers.filter((p) => !p.custom && Boolean(p.oauth)),
		[providers],
	);

	const selectedProvider = useMemo(
		() => providers.find((p) => p.id === selectedProviderId) ?? featuredProviders[0] ?? providers[0] ?? null,
		[providers, selectedProviderId, featuredProviders],
	);

	useEffect(() => {
		if (!selectedProvider) return;
		if (selectedProvider.id !== selectedProviderId) {
			setSelectedProviderId(selectedProvider.id);
		}
		setBaseUrl(selectedProvider.baseUrl ?? "");
		setApiKey("");
		setApiFeedback(null);
	}, [selectedProvider?.id]);

	const handleSaveBuiltinApi = async () => {
		if (!selectedProvider) return;
		const trimmedKey = apiKey.trim();
		const trimmedUrl = baseUrl.trim();
		if (!trimmedKey && !trimmedUrl && !selectedProvider.configured) {
			setApiFeedback({ kind: "error", text: "请先粘贴 API Key" });
			return;
		}
		setSavingApi(true);
		setApiFeedback(null);
		try {
			if (trimmedUrl || selectedProvider.overridesBuiltin) {
				await setProviderBaseUrl(selectedProvider.id, trimmedUrl, trimmedKey || undefined);
			} else if (trimmedKey) {
				await saveKey(selectedProvider.id, trimmedKey);
			}
			await useSessionsStore.getState().loadModels(LOCAL_ENVIRONMENT);
			setApiKey("");
			setApiFeedback({ kind: "info", text: `已保存 ${selectedProvider.name} 配置，可点「测试连接」验证` });
		} catch (error) {
			setApiFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			setSavingApi(false);
		}
	};

	const handleFetchUpstreamModels = async () => {
		if (!customBaseUrl.trim()) {
			setCustomFeedback({ kind: "error", text: "请先填写中转站 API 地址" });
			return;
		}
		setFetchingUpstream(true);
		setCustomFeedback(null);
		try {
			const res = await listUpstreamModels({
				baseUrl: customBaseUrl.trim(),
				api: "openai-completions",
				apiKey: customApiKey.trim() || undefined,
			});
			setUpstreamModels(res.models);
			if (res.baseUrl && res.baseUrl !== customBaseUrl.trim()) {
				setCustomBaseUrl(res.baseUrl);
			}
			if (!customModelId.trim() && res.models[0]?.id) {
				setCustomModelId(res.models[0].id);
			}
			setCustomFeedback({ kind: "info", text: `已拉取 ${res.models.length} 个上游模型` });
		} catch (error) {
			setCustomFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			setFetchingUpstream(false);
		}
	};

	const handleSaveCustomRelay = async () => {
		const name = customName.trim() || "自定义中转站";
		const url = customBaseUrl.trim();
		const modelId = customModelId.trim();
		if (!url) {
			setCustomFeedback({ kind: "error", text: "请填写 API Base URL" });
			return;
		}
		if (!modelId) {
			setCustomFeedback({ kind: "error", text: "请填写至少一个模型 ID（或先点「拉取模型」）" });
			return;
		}
		setSavingCustom(true);
		setCustomFeedback(null);
		try {
			const matched = upstreamModels.find((m) => m.id === modelId);
			await addCustom({
				id: slugProviderId(name),
				name,
				baseUrl: url,
				api: "openai-completions",
				apiKey: customApiKey.trim() || undefined,
				models: [
					{
						id: modelId,
						name: matched?.name || modelId,
						...(matched?.reasoning ? { reasoning: true } : {}),
						...(matched?.contextWindow ? { contextWindow: matched.contextWindow } : {}),
						...(matched?.maxTokens ? { maxTokens: matched.maxTokens } : {}),
						...(matched?.imageInput !== undefined ? { imageInput: matched.imageInput } : {}),
					},
				],
			});
			await useSessionsStore.getState().loadModels(LOCAL_ENVIRONMENT);
			setCustomFeedback({ kind: "info", text: `已添加自定义中转站「${name}」` });
		} catch (error) {
			setCustomFeedback({ kind: "error", text: stripInvokePrefix(error) });
		} finally {
			setSavingCustom(false);
		}
	};

	const handleFinish = async () => {
		setFinishing(true);
		try {
			const draftQq = draftQqRef.current.trim();
			const savedQq = ntqqSnapshot?.config.qqUin ?? "";
			if (draftQq && draftQq !== savedQq && /^\d{5,12}$/.test(draftQq)) {
				await getPi().wenyouNtqqSaveConfig({ qqUin: draftQq });
			}
		} catch {
			// 非阻断：引导收口不卡死用户进入主界面
		} finally {
			setFinishing(false);
			onClose();
		}
	};

	const currentTestResult = selectedProvider ? testResults[selectedProvider.id] : undefined;

	return createPortal(
		<>
			<div
				className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 px-4"
				role="dialog"
				aria-modal="true"
				aria-label="Wenyou Pro 初次配置向导"
			>
				<div className="flex max-h-[min(86vh,680px)] w-[660px] max-w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-ink shadow-dialog">
					{/* 顶栏 */}
					<div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-6 pt-5 pb-4">
						<div>
							<h2 className="text-ui-16 font-semibold text-ink">欢迎使用 Wenyou Pro</h2>
							<p className="mt-1 text-ui-12 text-ink-dim">
								两步完成模型接入与 QQ 号绑定，随时可在「设置」中修改
							</p>
						</div>
						<button
							type="button"
							onClick={onClose}
							className="shrink-0 rounded-lg px-2.5 py-1 text-ui-12 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
						>
							先跳过
						</button>
					</div>

					{/* 两步导航条 */}
					<div className="flex shrink-0 items-center gap-2 border-b border-border bg-canvas/50 px-6 py-2.5 text-ui-12">
						<button
							type="button"
							onClick={() => setStep(1)}
							className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1 font-medium transition-colors ${
								step === 1 ? "bg-surface text-ink shadow-soft" : "text-ink-dim hover:text-ink"
							}`}
						>
							<span
								className={`inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-ui-10 ${
									configuredProviders.length > 0
										? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
										: step === 1
											? "bg-ink text-on-ink"
											: "bg-hover text-ink-dim"
								}`}
							>
								{configuredProviders.length > 0 ? "✓" : "1"}
							</span>
							<span>模型 API / 订阅账号</span>
						</button>
						<span className="text-ink-faint">/</span>
						<button
							type="button"
							onClick={() => setStep(2)}
							className={`inline-flex items-center gap-2 rounded-lg px-2.5 py-1 font-medium transition-colors ${
								step === 2 ? "bg-surface text-ink shadow-soft" : "text-ink-dim hover:text-ink"
							}`}
						>
							<span
								className={`inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-ui-10 ${
									ntqqSnapshot?.config.qqUin
										? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
										: step === 2
											? "bg-ink text-on-ink"
											: "bg-hover text-ink-dim"
								}`}
							>
								{ntqqSnapshot?.config.qqUin ? "✓" : "2"}
							</span>
							<span>绑定本人 QQ 号</span>
						</button>
					</div>

					{/* 主体内容区 */}
					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
						{step === 1 ? (
							<div className="space-y-4">
								{configuredProviders.length > 0 && (
									<div className="flex items-center justify-between gap-2 rounded-xl bg-emerald-500/10 px-3.5 py-2 text-ui-12 text-emerald-700 dark:text-emerald-300">
										<span className="truncate">
											已接入：{configuredProviders.map((p) => p.name).join("、")}（共 {configuredModelCount} 个模型）
										</span>
										<span className="shrink-0 text-ui-11">可直接下一步</span>
									</div>
								)}

								{/* 方式切换 */}
								<div className="inline-flex items-center gap-1 rounded-lg bg-hover p-0.5 text-ui-12">
									{(
										[
											{ id: "api", label: "填写 API Key" },
											{ id: "oauth", label: "接入订阅账号" },
											{ id: "custom", label: "自定义中转站" },
										] as const
									).map((tab) => (
										<button
											key={tab.id}
											type="button"
											onClick={() => setAuthMode(tab.id)}
											className={`rounded-md px-3 py-1 font-medium transition-colors ${
												authMode === tab.id
													? "bg-surface text-ink shadow-soft"
													: "text-ink-dim hover:text-ink"
											}`}
										>
											{tab.label}
										</button>
									))}
								</div>

								{loadingProviders && providers.length === 0 ? (
									<p className="py-10 text-center text-ui-12 text-ink-faint">正在加载可用模型服务商…</p>
								) : authMode === "api" ? (
									<div className="space-y-3.5">
										{/* 常用服务商快捷选择 */}
										<div className="flex flex-wrap items-center gap-1.5">
											{featuredProviders.map((p) => {
												const active = selectedProvider?.id === p.id;
												return (
													<button
														key={p.id}
														type="button"
														onClick={() => setSelectedProviderId(p.id)}
														className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-ui-12 transition-colors ${
															active
																? "border-ink bg-ink text-on-ink"
																: "border-border bg-canvas text-ink-2 hover:bg-hover hover:text-ink"
														}`}
													>
														{p.configured && (
															<span
																className={`h-1.5 w-1.5 rounded-full ${
																	active ? "bg-emerald-300" : "bg-emerald-500"
																}`}
															/>
														)}
														<span>{p.name}</span>
													</button>
												);
											})}
											{otherBuiltinProviders.length > 0 && (
												<select
													aria-label="选择其他内置模型服务商"
													value={
														otherBuiltinProviders.some((p) => p.id === selectedProvider?.id)
															? selectedProvider?.id
															: ""
													}
													onChange={(e) => {
														if (e.target.value) setSelectedProviderId(e.target.value);
													}}
													className="rounded-lg border border-border bg-canvas px-2.5 py-1 text-ui-12 text-ink-dim outline-none focus:border-accent"
												>
													<option value="">更多服务商…</option>
													{otherBuiltinProviders.map((p) => (
														<option key={p.id} value={p.id}>
															{p.name}
															{p.configured ? " (已配置)" : ""}
														</option>
													))}
												</select>
											)}
										</div>

										{selectedProvider && (
											<div className="space-y-3 rounded-xl border border-border bg-canvas/50 p-4">
												<div className="flex items-center justify-between gap-2">
													<div>
														<span className="text-ui-13 font-medium text-ink">
															{selectedProvider.name}
														</span>
														<span className="ml-2 text-ui-11 text-ink-faint">
															{selectedProvider.models.length} 个内置模型
														</span>
													</div>
													<span
														className={`rounded-full px-2 py-0.5 text-ui-10 ${
															selectedProvider.configured
																? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
																: "bg-hover text-ink-faint"
														}`}
													>
														{selectedProvider.configured ? "已配置" : "未配置"}
													</span>
												</div>

												<div className="space-y-2">
													<input
														type="password"
														value={apiKey}
														onChange={(e) => setApiKey(e.target.value)}
														onKeyDown={(e) => {
															if (e.key === "Enter") void handleSaveBuiltinApi();
														}}
														placeholder={
															selectedProvider.configured
																? "已保存密钥；留空保留原密钥，输入新 Key 可替换"
																: `粘贴 ${selectedProvider.name} 的 API Key`
														}
														className={INPUT_CLASS}
													/>
													<input
														type="url"
														value={baseUrl}
														onChange={(e) => setBaseUrl(e.target.value)}
														placeholder="可选：自定义 Base URL（中转站覆写地址，留空走官方）"
														className={`${INPUT_CLASS} font-mono`}
													/>
												</div>

												<div className="flex items-center gap-2">
													<button
														type="button"
														disabled={savingApi}
														onClick={() => void handleSaveBuiltinApi()}
														className="rounded-lg bg-ink px-3.5 py-1.5 text-ui-12 font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
													>
														{savingApi ? "保存中…" : "保存配置"}
													</button>
													{selectedProvider.configured && (
														<button
															type="button"
															disabled={currentTestResult === "testing"}
															onClick={() => void testProvider(selectedProvider.id)}
															className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
														>
															{currentTestResult === "testing" ? "测试中…" : "测试连接"}
														</button>
													)}
												</div>

												{currentTestResult && currentTestResult !== "testing" && (
													<p
														className={`rounded-lg px-3 py-1.5 text-ui-11 ${
															currentTestResult.ok
																? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
																: "bg-err/10 text-err"
														}`}
													>
														{currentTestResult.ok
															? `连接正常（响应模型：${currentTestResult.modelId ?? "OK"}）`
															: `测试失败：${currentTestResult.error ?? "未知错误"}`}
													</p>
												)}
												{apiFeedback && (
													<p
														className={`rounded-lg px-3 py-1.5 text-ui-11 ${
															apiFeedback.kind === "error"
																? "bg-err/10 text-err"
																: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
														}`}
													>
														{apiFeedback.text}
													</p>
												)}
											</div>
										)}
									</div>
								) : authMode === "oauth" ? (
									<div className="space-y-2.5">
										<p className="text-ui-12 text-ink-dim">
											仅列出支持官方 OAuth 浏览器授权或设备码登录的订阅服务商（如 ChatGPT、Claude、GitHub Copilot、Kimi Code）。DeepSeek 等未开放官方 OAuth 账号登录的服务商，请切换到「填写 API Key」页签接入。
										</p>
										{oauthProviders.length === 0 ? (
											<p className="rounded-xl border border-border bg-canvas/50 px-4 py-6 text-center text-ui-12 text-ink-faint">
												当前目录暂未检测到支持 OAuth 登录的服务商，可切换到「填写 API Key」或「自定义中转站」。
											</p>
										) : (
											<div
												data-oauth-provider-list=""
												className="divide-y divide-border rounded-xl border border-border bg-canvas/50"
											>
												{oauthProviders.map((provider) => (
													<div
														key={provider.id}
														className="flex items-center justify-between gap-3 px-4 py-3"
													>
														<div className="min-w-0">
															<div className="flex items-center gap-2">
																<span className="text-ui-13 font-medium text-ink">
																	{provider.name}
																</span>
																<span
																	className={`rounded-full px-2 py-0.5 text-ui-10 ${
																		provider.configured
																			? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
																			: "bg-hover text-ink-faint"
																	}`}
																>
																	{provider.configured ? "已接入" : "未登录"}
																</span>
															</div>
															<p className="mt-0.5 truncate text-ui-11 text-ink-faint">
																{provider.configured && provider.authLabel
																	? provider.authLabel
																	: (provider.oauth?.loginLabel ?? "官方账号交互登录")}
															</p>
														</div>
														<button
															type="button"
															disabled={loginActive}
															onClick={() => void startProviderLogin(provider)}
															className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40"
														>
															{provider.configured ? "重新登录" : "登录账号"}
														</button>
													</div>
												))}
											</div>
										)}
									</div>
								) : (
									<div className="space-y-3 rounded-xl border border-border bg-canvas/50 p-4">
										<p className="text-ui-12 text-ink-dim">
											支持任意 OpenAI 兼容接口（硅基流动、火山方舟、阿里百炼、自建 OneAPI/NewAPI 中转站等）。
										</p>
										<div className="grid grid-cols-2 gap-2.5">
											<input
												type="text"
												value={customName}
												onChange={(e) => setCustomName(e.target.value)}
												placeholder="名称，如 硅基流动 / 自建中转"
												className={INPUT_CLASS}
											/>
											<input
												type="password"
												value={customApiKey}
												onChange={(e) => setCustomApiKey(e.target.value)}
												placeholder="API Key (sk-...)"
												className={INPUT_CLASS}
											/>
											<input
												type="url"
												value={customBaseUrl}
												onChange={(e) => setCustomBaseUrl(e.target.value)}
												placeholder="接口地址，如 https://api.siliconflow.cn/v1"
												className={`${INPUT_CLASS} col-span-2 font-mono`}
											/>
											<div className="col-span-2 flex items-center gap-2">
												<input
													type="text"
													value={customModelId}
													onChange={(e) => setCustomModelId(e.target.value)}
													placeholder="模型 ID（手填或点右侧自动拉取）"
													className={`${INPUT_CLASS} font-mono`}
												/>
												<button
													type="button"
													disabled={fetchingUpstream || !customBaseUrl.trim()}
													onClick={() => void handleFetchUpstreamModels()}
													className="shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
												>
													{fetchingUpstream ? "拉取中…" : "拉取模型"}
												</button>
											</div>
										</div>

										{upstreamModels.length > 0 && (
											<div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pt-0.5">
												{upstreamModels.slice(0, 20).map((m) => (
													<button
														key={m.id}
														type="button"
														onClick={() => setCustomModelId(m.id)}
														className={`rounded-md border px-2 py-0.5 font-mono text-ui-11 transition-colors ${
															customModelId === m.id
																? "border-ink bg-ink text-on-ink"
																: "border-border bg-surface text-ink-dim hover:text-ink"
														}`}
													>
														{m.id}
													</button>
												))}
											</div>
										)}

										<div className="flex items-center gap-2">
											<button
												type="button"
												disabled={savingCustom}
												onClick={() => void handleSaveCustomRelay()}
												className="rounded-lg bg-ink px-3.5 py-1.5 text-ui-12 font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
											>
												{savingCustom ? "保存中…" : "保存中转站"}
											</button>
										</div>

										{customFeedback && (
											<p
												className={`rounded-lg px-3 py-1.5 text-ui-11 ${
													customFeedback.kind === "error"
														? "bg-err/10 text-err"
														: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
												}`}
											>
												{customFeedback.text}
											</p>
										)}
									</div>
								)}
							</div>
						) : (
							<NtqqConfigSection
								onDraftQqChange={(val) => {
									draftQqRef.current = val;
								}}
								onSnapshotChange={setNtqqSnapshot}
							/>
						)}
					</div>

					{/* 底栏操作 */}
					<div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-canvas/40 px-6 py-3.5">
						{step === 1 ? (
							<>
								<button
									type="button"
									onClick={onClose}
									className="rounded-lg px-2.5 py-1.5 text-ui-12 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
								>
									稍后在设置中配置
								</button>
								<button
									type="button"
									onClick={() => setStep(2)}
									className="rounded-lg bg-ink px-4 py-1.5 text-ui-12 font-medium text-on-ink transition-colors hover:bg-ink-2"
								>
									下一步：绑定 QQ 号
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									onClick={() => setStep(1)}
									className="rounded-lg border border-border bg-surface px-3 py-1.5 text-ui-12 text-ink-2 transition-colors hover:bg-hover hover:text-ink"
								>
									上一步
								</button>
								<div className="flex items-center gap-2">
									<button
										type="button"
										onClick={onClose}
										className="rounded-lg px-3 py-1.5 text-ui-12 text-ink-dim transition-colors hover:bg-hover hover:text-ink"
									>
										暂不绑定
									</button>
									<button
										type="button"
										disabled={finishing}
										onClick={() => void handleFinish()}
										className="rounded-lg bg-ink px-4 py-1.5 text-ui-12 font-medium text-on-ink transition-colors hover:bg-ink-2 disabled:opacity-40"
									>
										{finishing ? "保存中…" : "完成并进入工作台"}
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			</div>
			{mountLoginDialog && <LoginDialog />}
		</>,
		document.body,
	);
}
