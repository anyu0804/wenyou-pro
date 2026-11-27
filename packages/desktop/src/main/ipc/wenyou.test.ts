// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
	BrowserWindow: { getAllWindows: () => [] },
	dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
	shell: { showItemInFolder: vi.fn() },
}));

import { sanitizeDocxFileName } from "./wenyou";

describe("main/ipc/wenyou sanitizeDocxFileName", () => {
	it("清洗 Windows/macOS 非法路径字符、控制字符、尾随点空格与保留设备名", () => {
		expect(sanitizeDocxFileName("001-河西/北周: 停战协议?.docx")).toBe("001-河西-北周-停战协议.docx");
		expect(sanitizeDocxFileName('002-多行\r\n标题*<>|"...  ')).toBe("002-多行-标题.docx");
		expect(sanitizeDocxFileName("CON.docx")).toBe("CON-doc.docx");
		expect(sanitizeDocxFileName("   /:*?   ", "fallback.docx")).toBe("fallback.docx");
		expect(sanitizeDocxFileName(undefined, "003-默认国策.docx")).toBe("003-默认国策.docx");
	});
});
