import { useEffect } from "react";
import { subscribeExecutionEnvironments } from "../environment-api";
import { selectActiveCwd } from "../lib/active-cwd";
import { useSessionsStore } from "../stores/sessions";
import { useWenyouCanvasStore } from "../stores/wenyou-canvas";

/**
 * 文游实时事件桥（App 根层挂载）：
 * 1. 追踪当前活跃工作目录 activeCwd，静默刷新文游概览与未读角标；
 * 2. 全局订阅所有执行环境的 onWenyouCanvasEvent，让 Agent 调用 wenyou_* 工具时
 *    右侧 WenyouCanvas 自动展开、切换页签、刷新数据并聚焦刚生成的产物。
 */
export function useWenyouBridge(): void {
	const activeCwd = useSessionsStore(selectActiveCwd);

	useEffect(() => {
		void useWenyouCanvasStore.getState().syncActiveCwd(activeCwd);
	}, [activeCwd]);

	useEffect(() => {
		return subscribeExecutionEnvironments((api) =>
			api.onWenyouCanvasEvent((event) => {
				useWenyouCanvasStore.getState().handleCanvasEvent(event);
			}),
		);
	}, []);
}
