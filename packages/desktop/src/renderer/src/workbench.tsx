import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { QuitConfirmDialog } from "./components/ui/QuitConfirmDialog";
import { releaseSplash } from "./splash";
import { initEnvironmentUiState } from "./stores/environment-ui-restore";
import { useThemeStore } from "./stores/theme";
import { useUiPreferencesStore } from "./stores/ui-preferences";
import "./styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

// render 前先恢复主题/背景/UI 偏好（一次 IPC），避免深色模式启动闪白与轨道开关闪现
void Promise.all([useThemeStore.getState().init(), useUiPreferencesStore.getState().init()])
	.then(() => initEnvironmentUiState())
	.finally(() => {
		// The workbench can now mount. Data preparation never consumes this fallback timer.
		releaseSplash();
		createRoot(root).render(
			<StrictMode>
				{/* 全局边界：渲染期异常（含 #185 无限更新类）落到可恢复错误页而非整窗白屏 */}
				<AppErrorBoundary>
					<App />
				</AppErrorBoundary>
				{/* 退出确认弹窗挂在边界「外面」：App 崩成错误页时它仍要在场——
			    否则 Windows 上点 ✕ 会被拦下却没人弹窗，窗口从此关不掉（见 stores/app-quit.ts） */}
				<QuitConfirmDialog />
			</StrictMode>,
		);
	});
