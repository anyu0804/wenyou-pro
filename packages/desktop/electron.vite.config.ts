import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

const emptyStub = resolve(__dirname, "src/renderer/src/empty-stub.ts");

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin({ exclude: ["@percho/backend", "@percho/shared"] })],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, "src/main/index.ts"),
					"session-media-worker": resolve(__dirname, "../backend/src/session/media-maintenance-worker.ts"),
					"session-catalog-worker": resolve(__dirname, "../backend/src/session/catalog-worker.ts"),
					"channels-worker": resolve(__dirname, "../backend/src/tools/channels/worker.ts"),
				},
				output: {
					entryFileNames: (chunk) => (chunk.name.endsWith("-worker") ? "[name].mjs" : "[name].js"),
				},
				external: ["@earendil-works/pi-coding-agent"],
			},
		},
		resolve: {
			alias: {
				"@percho/backend": resolve(__dirname, "../backend/src/index.ts"),
				"@percho/shared": resolve(__dirname, "../shared/src/index.ts"),
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin({ exclude: ["@percho/shared"] })],
		build: {
			rollupOptions: {
				output: {
					format: "cjs",
					entryFileNames: "index.cjs",
				},
			},
		},
		resolve: {
			alias: {
				"@percho/shared": resolve(__dirname, "../shared/src/index.ts"),
			},
		},
	},
	renderer: {
		resolve: {
			alias: [
				{ find: /^stream-monaco$/, replacement: emptyStub },
				{ find: /^monaco-editor(?:\/.*)?$/, replacement: emptyStub },
				{ find: /^mermaid$/, replacement: emptyStub },
				{ find: /^katex(?:\/.*)?$/, replacement: emptyStub },
				{ find: /^shiki(?:\/.*)?$/, replacement: emptyStub },
				{ find: /^@antv\/infographic$/, replacement: emptyStub },
				{ find: /^@terrastruct\/d2$/, replacement: emptyStub },
				{ find: "@percho/shared", replacement: resolve(__dirname, "../shared/src/index.ts") },
				{ find: "@renderer", replacement: resolve(__dirname, "src/renderer/src") },
			],
		},
		build: {
			rollupOptions: {
				onwarn(warning, warn) {
					if (warning.code === "INVALID_ANNOTATION") return;
					warn(warning);
				},
			},
		},
		plugins: [react(), tailwindcss()],
	},
});
