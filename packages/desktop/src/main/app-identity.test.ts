import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import channels from "../../build/app-channels.json";

const fake = vi.hoisted(() => ({
	packaged: true,
	channel: undefined as unknown,
	disableAutoUpdate: undefined as unknown,
	custom: "",
	setName: vi.fn(),
	setPath: vi.fn(),
}));
vi.mock("node:fs", () => ({
	readFileSync: () => JSON.stringify({ releaseChannel: fake.channel, disableAutoUpdate: fake.disableAutoUpdate }),
}));
vi.mock("electron", () => ({
	app: {
		get isPackaged() {
			return fake.packaged;
		},
		getAppPath: () => "/isolated/app",
		getPath: (key: string) => (key === "appData" ? "/isolated/support" : "/isolated/support/old-profile"),
		commandLine: { getSwitchValue: () => fake.custom },
		setName: fake.setName,
		setPath: fake.setPath,
		setAppUserModelId: vi.fn(),
	},
}));
beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	fake.packaged = true;
	fake.channel = undefined;
	fake.disableAutoUpdate = undefined;
	fake.custom = "";
});

describe("application channel identity", () => {
	it("keeps the legacy stable identity and data path", async () => {
		const identity = await import("./app-identity");
		identity.configureAppIdentity();
		expect(identity.releaseChannel).toBe("stable");
		expect(identity.supportsUpdates).toBe(true);
		expect(identity.appIdentity.appId).toBe("io.github.anyu.wenyou-pro");
		expect(fake.setPath).not.toHaveBeenCalled();
	});
	it("isolates packaged beta data and disallows stable updates", async () => {
		fake.channel = "beta";
		const identity = await import("./app-identity");
		identity.configureAppIdentity();
		expect(identity.supportsUpdates).toBe(false);
		expect(fake.setName).toHaveBeenCalledWith("Wenyou Pro Beta");
		expect(fake.setPath).toHaveBeenCalledWith("userData", join("/isolated/support", "Wenyou Pro Beta"));
	});
	it("honors an explicit beta test profile", async () => {
		fake.channel = "beta";
		fake.custom = "/isolated/custom-profile";
		const identity = await import("./app-identity");
		identity.configureAppIdentity();
		expect(fake.setPath).toHaveBeenCalledWith("userData", fake.custom);
	});
	it("isolates dev profile under appData/appIdentity.name after setting app name", async () => {
		fake.packaged = false;
		const identity = await import("./app-identity");
		identity.configureAppIdentity();
		expect(identity.releaseChannel).toBe("dev");
		expect(identity.supportsUpdates).toBe(false);
		expect(fake.setName).toHaveBeenCalledWith("Wenyou Pro Dev");
		expect(fake.setPath).toHaveBeenCalledWith("userData", join("/isolated/support", "Wenyou Pro Dev"));
		expect(fake.setName.mock.invocationCallOrder[0]!).toBeLessThan(fake.setPath.mock.invocationCallOrder[0]!);
	});
	it("honors an explicit dev --user-data-dir override", async () => {
		fake.packaged = false;
		fake.custom = "/isolated/custom-dev-profile";
		const identity = await import("./app-identity");
		identity.configureAppIdentity();
		expect(fake.setName).toHaveBeenCalledWith("Wenyou Pro Dev");
		expect(fake.setPath).toHaveBeenCalledWith("userData", fake.custom);
	});
	it("rejects unknown packaged identities instead of silently selecting stable", async () => {
		fake.channel = "dev";
		await expect(import("./app-identity")).rejects.toThrow("Invalid packaged release channel");
	});
	it("disables auto-updates when packaged with disableAutoUpdate=true", async () => {
		fake.disableAutoUpdate = true;
		const identity = await import("./app-identity");
		expect(identity.releaseChannel).toBe("stable");
		expect(identity.supportsUpdates).toBe(false);
	});
	it("uses distinct system identities for all three channels", () => {
		expect(new Set(Object.values(channels).map((item) => item.appId)).size).toBe(3);
		expect(new Set(Object.values(channels).map((item) => item.name)).size).toBe(3);
	});
});
