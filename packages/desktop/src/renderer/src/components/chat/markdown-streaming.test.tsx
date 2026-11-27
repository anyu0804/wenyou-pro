// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";

const piMock = vi.hoisted(() => ({
	platform: "win32",
	openPath: vi.fn(async () => undefined),
	openExternal: vi.fn(async () => undefined),
}));
const toastMock = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.hoisted(() => {
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("../../api", () => ({ getPi: () => piMock }));
vi.mock("../../stores/toasts", () => ({ pushToast: toastMock.pushToast }));

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

	it("mermaid / d2 / infographic 图表块在裁剪依赖后走纯文本源码回退且零运行时报错", async () => {
		const spyErr = vi.spyOn(console, "error").mockImplementation(() => {});
		const md = [
			"```mermaid",
			"graph TD",
			"  A[北周] --> B[河西]",
			"```",
			"",
			"```d2",
			"长安 -> 洛阳: 粮道",
			"```",
			"",
			"```infographic",
			"title: 兵力对比",
			"```",
		].join("\n");
		await renderMessage(md, false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		const fallbacks = [...container.querySelectorAll("pre[data-diagram-fallback]")];
		expect(fallbacks.map((el) => el.getAttribute("data-diagram-fallback"))).toEqual([
			"mermaid",
			"d2",
			"infographic",
		]);
		expect(container.textContent).toContain("A[北周] --> B[河西]");
		expect(container.textContent).toContain("长安 -> 洛阳: 粮道");
		expect(container.textContent).toContain("title: 兵力对比");
		expect(container.textContent).not.toMatch(/not a function|not a constructor/i);
		expect(spyErr).not.toHaveBeenCalled();
	});

	it("行内与块级公式在无 KaTeX 时回退展示原始公式且不崩溃", async () => {
		const md = "兵力比 $E = mc^2$ 满足：\n\n$$\n\\sum_{i=1}^{n} x_i\n$$";
		await renderMessage(md, false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});
		expect(container.textContent).toContain("E = mc^2");
		expect(container.textContent).toContain("\\sum_{i=1}^{n} x_i");
	});

	it("普通代码块渲染带语言标识与复制按钮的卡片，点击后写入剪贴板并切换为已复制", async () => {
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		await renderMessage("```typescript\nconst era = 561;\n```", false);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500);
		});

		const card = container.querySelector('[data-code-block="typescript"]');
		expect(card).not.toBeNull();
		expect(card?.className).toContain("rounded-xl");
		expect(card?.className).toContain("border");
		expect(card?.textContent).toContain("typescript");
		expect(card?.textContent).toContain("const era = 561;");

		const copyBtn = card?.querySelector<HTMLButtonElement>("button[data-code-copy]");
		expect(copyBtn).not.toBeNull();
		expect(copyBtn?.textContent).toBe("复制");

		await act(async () => {
			copyBtn?.click();
			await Promise.resolve();
		});
		expect(writeText).toHaveBeenCalledWith("const era = 561;");
		expect(copyBtn?.textContent).toBe("已复制");
	});

	it("无活跃 cwd 时点击 Windows 盘符路径与 file:// 绝对链接仍可打开，仅相对路径拒绝提示", async () => {
		piMock.openPath.mockClear();
		toastMock.pushToast.mockClear();
		const md = [
			"[盘符](D:/vault/doc.md)",
			"[文件协议](file:///D:/vault/brief.md)",
			"[相对路径](docs/rel.md)",
		].join(" ");
		await act(async () => {
			root.render(<Markdown text={md} streaming={false} cwd={null} />);
		});

		const links = [...container.querySelectorAll<HTMLAnchorElement>("a[href]")];
		expect(links.length).toBeGreaterThanOrEqual(3);

		await act(async () => {
			links[0]?.click();
			await Promise.resolve();
		});
		expect(piMock.openPath).toHaveBeenCalledWith({ target: "D:/vault/doc.md", cwd: null });

		await act(async () => {
			links[1]?.click();
			await Promise.resolve();
		});
		expect(piMock.openPath).toHaveBeenCalledWith({ target: "file:///D:/vault/brief.md", cwd: null });

		await act(async () => {
			links[2]?.click();
			await Promise.resolve();
		});
		expect(piMock.openPath).toHaveBeenCalledTimes(2);
		expect(toastMock.pushToast).toHaveBeenCalledWith(
			"error",
			"toast.pathOpenFailed",
			expect.stringContaining("No session working directory"),
		);
	});
});
