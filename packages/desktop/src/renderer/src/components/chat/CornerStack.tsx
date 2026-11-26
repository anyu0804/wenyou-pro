import { type RefObject, useCallback, useEffect, useReducer, useRef } from "react";
import { useChannelTopics } from "../../stores/channel-subscriptions";
import { useSessionsStore } from "../../stores/sessions";
import { ChannelSubscriptionPill } from "./ChannelSubscriptionPill";
import {
	type ChannelPillPresence,
	HIDDEN_PRESENCE,
	presenceForSession,
	reduceChannelPill,
} from "./channel-pill-presence";
import { useTodoAnchor } from "./use-todo-anchor";

/**
 * 聊天区右上角堆叠：宿主自带的频道订阅胶囊。
 * 宿主测量 TodoPanel 渲染根的实际底边（`useTodoAnchor`，命令式写 `style.top`），避免重叠。
 */
export function CornerStack({ slotHostRef }: { slotHostRef: RefObject<HTMLElement | null> }) {
	const stackRef = useRef<HTMLDivElement | null>(null);
	const activeSessionId = useSessionsStore((s) => s.activeSessionId);
	const topics = useChannelTopics(activeSessionId);
	const [presence, dispatch] = useReducer(reduceChannelPill, HIDDEN_PRESENCE);
	useTodoAnchor({ slotHost: slotHostRef, stack: stackRef });

	const sessionRef = useRef(activeSessionId);
	useEffect(() => {
		const switched = sessionRef.current !== activeSessionId;
		sessionRef.current = activeSessionId;
		if (switched) dispatch({ type: "reset", sessionId: activeSessionId });
		dispatch({ type: "sync", sessionId: activeSessionId, topics });
	}, [activeSessionId, topics]);

	const handleExitFinished = useCallback((token: number) => {
		dispatch({ type: "exitFinished", token });
	}, []);

	const visible = presenceForSession(presence, activeSessionId);
	return (
		<div
			ref={stackRef}
			data-corner-stack=""
			style={{ width: "calc(100% - 32px)", maxWidth: 560 }}
			className="pointer-events-none absolute right-4 top-2 z-20 flex flex-col items-end gap-2"
		>
			<ChannelSubscriptionPill presence={visible} onExitFinished={handleExitFinished} />
		</div>
	);
}

/** 仅供测试/诊断：当前 presence 的形状（避免测试直接依赖 reducer 内部） */
export type { ChannelPillPresence };
