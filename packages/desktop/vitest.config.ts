import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const emptyStub = resolve(__dirname, "src/renderer/src/empty-stub.ts");

export default defineConfig({
	esbuild: { jsx: "automatic" },
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
	test: {
		// 客户端回归测试需拦截 markstream 动态加载的浏览器编辑器。
		server: { deps: { inline: [/markstream-react/] } },
	},
});
