import { describe, expect, it } from "vitest";
import { sanitizePixiSandboxUrl } from "./wenyou-helpers";

describe("sanitizePixiSandboxUrl", () => {
	it("preserves built-in wenyou-sandbox://app URL and rejects non-app hosts", () => {
		expect(sanitizePixiSandboxUrl("wenyou-sandbox://app")).toBe("wenyou-sandbox://app");
		expect(sanitizePixiSandboxUrl("wenyou-sandbox://app/index.html")).toBe("wenyou-sandbox://app/index.html");
		expect(sanitizePixiSandboxUrl("wenyou-sandbox://other/index.html")).toBeNull();
	});

	it("allows local and LAN http/https sandbox URLs", () => {
		expect(sanitizePixiSandboxUrl("http://127.0.0.1:4173/")).toBe("http://127.0.0.1:4173/");
		expect(sanitizePixiSandboxUrl("http://192.168.1.25:4173/campaign")).toBe("http://192.168.1.25:4173/campaign");
		expect(sanitizePixiSandboxUrl("https://sandbox.internal.example/map")).toBe(
			"https://sandbox.internal.example/map",
		);
	});

	it("rejects unsafe, non-http, or empty inputs", () => {
		expect(sanitizePixiSandboxUrl("javascript:alert(1)")).toBeNull();
		expect(sanitizePixiSandboxUrl("file:///etc/passwd")).toBeNull();
		expect(sanitizePixiSandboxUrl("ftp://192.168.1.25/map")).toBeNull();
		expect(sanitizePixiSandboxUrl("   ")).toBeNull();
		expect(sanitizePixiSandboxUrl(null)).toBeNull();
	});
});
