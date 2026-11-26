import type { PiBackend } from "@percho/backend";
import { IpcChannels, LOCAL_ENVIRONMENT } from "@percho/shared";
import { setEnvironmentUiAuthorization } from "../environment-ui-state";
import { initializeNativeNotifications, nativeNotifications } from "../native-notifications";
import { initializeTaskNotifications, observeTaskNotification } from "../task-notifications";
import { loadUiState } from "../ui-state";
import { onUpdateState } from "../updater";
import { registerAppIpc } from "./app";
import { registerExtensionDialogIpc } from "./extension-dialogs";
import { registerPackagesIpc } from "./packages";
import { forward, sendToRenderer } from "./send";
import { registerSessionsIpc } from "./sessions";
import { registerSettingsIpc } from "./settings";
import { registerWenyouIpc } from "./wenyou";

/**
 * IPC 注册组合入口：按域拆在 ./sessions ./settings ./packages ./app ./extension-dialogs ./wenyou，
 * 这里只做拼装 + backend/updater 事件转发到 renderer。
 */
export function registerIpc(backend: PiBackend): void {
	initializeNativeNotifications();
	initializeTaskNotifications();
	nativeNotifications.restoreEnabled(async () => (await loadUiState())?.taskNotificationsEnabled ?? true);
	setEnvironmentUiAuthorization(async () => {});

	registerSessionsIpc(backend);
	registerSettingsIpc(backend);
	registerPackagesIpc(backend);
	registerAppIpc(backend);
	registerExtensionDialogIpc(backend);
	registerWenyouIpc(backend);

	// onEvent 载荷是 (sessionId, event) → 信封封装，不透明传，单行保留
	backend.onEvent((sessionId, event, sequence) => {
		observeTaskNotification(
			LOCAL_ENVIRONMENT,
			{ sessionId, event, sequence: sequence ?? backend.getSessionEventSequence(sessionId) },
			() => backend.getLoadedSessions().find((summary) => summary.meta.sessionId === sessionId)?.meta,
		);
		sendToRenderer(IpcChannels.Event, {
			sessionId,
			event,
			sequence: backend.getSessionEventSequence(sessionId),
		});
	});
	forward(backend.onPermissionRequest.bind(backend), IpcChannels.PermissionRequest);
	forward(backend.onPermissionResolved.bind(backend), IpcChannels.PermissionResolved);
	forward(backend.onTrustRequest.bind(backend), IpcChannels.TrustRequest);
	forward(backend.onTrustResolved.bind(backend), IpcChannels.TrustResolved);
	// 扩展对话框四事件：请求/结算/notify/草稿预填（issue #45）
	forward(backend.onExtensionDialogRequest.bind(backend), IpcChannels.ExtensionDialogRequest);
	forward(backend.onExtensionDialogResolved.bind(backend), IpcChannels.ExtensionDialogResolved);
	forward(backend.onExtensionNotify.bind(backend), IpcChannels.ExtensionNotify);
	forward(backend.onExtensionEditorText.bind(backend), IpcChannels.ExtensionEditorText);
	forward(backend.onLoginEvent.bind(backend), IpcChannels.SettingsLoginEvent);
	forward(backend.onMcpServersChanged.bind(backend), IpcChannels.McpServersChanged);
	// 频道订阅快照变化（spec D1）：payload 自带 generation+revision，renderer 自行判新旧
	forward(backend.onChannelSubscriptionsChanged.bind(backend), IpcChannels.ChannelSubscriptionsChanged);
	forward(backend.onSessionCatalogChanged.bind(backend), IpcChannels.SessionCatalogChanged);
	forward(backend.onWenyouCanvasEvent.bind(backend), IpcChannels.WenyouCanvasEvent);
	forward(onUpdateState, IpcChannels.UpdateEvent);
}
