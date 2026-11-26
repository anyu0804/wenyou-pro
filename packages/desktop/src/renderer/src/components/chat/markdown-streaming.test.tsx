// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("../../api", () => ({ getPi: () => ({ platform: "darwin" }) }));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.useFakeTimers();
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 200));
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function renderMessage(text: string, streaming = true, session = "a") {
	await act(async () => {
		root.render(<Markdown key={session} text={text} streaming={streaming} />);
	});
}

describe("切换会话后的流式正文", () => {
	const existing = "切换之前已经显示过的正文。".repeat(30);
	const delta = "切回之后新增的正文。".repeat(30);

	it("切回仍在执行的会话时立即显示已有正文，只平滑输出新增内容", async () => {
		await renderMessage(existing);
		expect(container.textContent).toContain(existing);
		await renderMessage("另一个会话", false, "b");
		await renderMessage(existing);
		expect(container.textContent).toContain(existing);

		await renderMessage(existing + delta);
		expect(container.textContent).toContain(existing);
		expect(container.textContent).not.toContain(existing + delta);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(container.textContent).toContain(existing + delta);
	});

	it("输出结束后仍能平滑追完新增内容", async () => {
		await renderMessage(existing);
		await renderMessage(existing + delta, false);
		expect(container.textContent).toContain(existing);
		expect(container.textContent).not.toContain(existing + delta);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10000);
		});
		expect(container.textContent).toContain(existing + delta);
	});

	it("StrictMode 重跑挂载也不重播已有正文", async () => {
		await act(async () => {
			root.render(
				<StrictMode>
					<Markdown text={existing} streaming />
				</StrictMode>,
			);
		});
		expect(container.textContent).toContain(existing);
	});

	it("已完成的历史正文直接显示", async () => {
		await renderMessage(existing, false);
		expect(container.textContent).toContain(existing);
	});
});

describe("无 Monaco/Shiki 依赖下的表格与纯文本代码块回退", () => {
	it("完整渲染 Markdown 表格", async () => {
		const tableMd = [
			"| 阵营 | 兵力 | 粮草 |",
			"| --- | --- | --- |",
			"| 河西 | 12000 | 充足 |",
			"| 岭南 | 8000 | 偏紧 |",
		].join("\n");
		await renderMessage(tableMd, false);
		expect(container.querySelector("table")).not.toBeNull();
		expect(container.textContent).toContain("河西");
		expect(container.textContent).toContain("12000");
		expect(container.textContent).toContain("岭南");
	});

	it("流式代码块在无 stream-monaco / shiki 时通过纯文本回退渲染且保留正文", async () => {
		await renderMessage("```text\n第一行命令", true);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		await renderMessage("```text\n第一行命令\n第二行命令\n```", false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2000);
		});
		expect(container.textContent).toContain("第一行命令");
		expect(container.textContent).toContain("第二行命令");
		expect(container.querySelector(".shiki")).toBeNull();
	});
});
