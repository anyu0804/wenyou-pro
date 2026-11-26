import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ICO_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
export const LAN_ICON_SIZE = 512;
export const MAIN_PNG_SIZE = 1024;
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const DEFAULT_CHANNELS = Object.freeze({
	beta: { badge: "BETA", badgeColor: "#c47417" },
	dev: { badge: "DEV", badgeColor: "#5271c4" },
});

/**
 * 构建「司命 · 文游 Pro」1024×1024 极简书卷落笔风主图标 SVG。
 * 视觉结构：温润宣纸暖白圆角底板 + 现代几何展开双页书卷 + 45° 斜切毛笔 + 点睛朱砂小印。
 */
export function buildBaseIconSvg() {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
	<title>司命 · 文游 Pro</title>
	<defs>
		<linearGradient id="paper-bg" x1="128" y1="96" x2="896" y2="928" gradientUnits="userSpaceOnUse">
			<stop offset="0%" stop-color="#FAF8F3" />
			<stop offset="55%" stop-color="#F6F3EB" />
			<stop offset="100%" stop-color="#F2EFE7" />
		</linearGradient>
	</defs>
	<!-- 温润宣纸圆角底板与克制内描边 -->
	<rect x="64" y="64" width="896" height="896" rx="220" fill="url(#paper-bg)" />
	<rect x="68" y="68" width="888" height="888" rx="216" fill="none" stroke="#DDD8CC" stroke-width="8" />
	<!-- 展开双页书卷柔白纸面底衬 -->
	<path
		id="scroll-pages-fill"
		d="M 492 422 C 422 374 300 368 196 384 L 196 700 C 300 684 422 692 492 738 C 562 692 684 684 788 700 L 788 384 C 684 368 562 374 492 422 Z"
		fill="#FFFDF9"
		fill-opacity="0.78"
	/>
	<!-- 现代几何展开双页书卷主轮廓与书脊中轴（右页上沿为毛笔留出对称圆头负空间断点） -->
	<g id="scroll-book" fill="none" stroke="#1F2329" stroke-linecap="round" stroke-linejoin="round">
		<!-- 左页 + 下沿 + 右页外侧 + 右上肩（止于毛笔两侧对称圆头断点） -->
		<path
			d="M 564 389 C 538 396 512 408 492 422 C 422 374 300 368 196 384 L 196 700 C 300 684 422 692 492 738 C 562 692 684 684 788 700 L 788 384 C 774 382 758 380 742 379"
			stroke-width="38"
		/>
		<line x1="492" y1="422" x2="492" y2="738" stroke-width="34" />
	</g>
	<!-- 左页两道极简书简横纹 -->
	<g id="scroll-lines" fill="none" stroke="#7A7E87" stroke-width="22" stroke-linecap="round">
		<path d="M 272 486 C 324 478 380 480 424 492" />
		<path d="M 272 560 C 316 553 364 554 400 564" />
	</g>
	<!-- 点睛朱砂小印 -->
	<rect id="cinnabar-seal" x="648" y="574" width="62" height="62" rx="14" fill="#C83E37" />
	<!-- 45° 斜切现代几何毛笔（笔锋与笔杆间留干净负空间环槽） -->
	<g id="calligraphy-brush" transform="translate(544 514) rotate(-45)" fill="#1F2329">
		<!-- 饱满水滴锥形笔锋 -->
		<path d="M 0 0 C 32 -4 60 -42 96 -40 C 120 -39 134 -31 140 -25 Q 146 0 140 25 C 134 31 120 39 96 40 C 60 42 32 4 0 0 Z" />
		<!-- 极简微收几何笔杆（与笔头留 30px 负空间环槽） -->
		<path d="M 170 -25 Q 176 0 170 25 L 386 21 A 21 21 0 0 0 386 -21 Z" />
	</g>
</svg>
`;
}

/**
 * 基于主图标 SVG 叠加通道徽章（BETA / DEV）。
 */
export function buildChannelIconSvg(baseSvg, { badge, badgeColor }) {
	if (!badge || !badgeColor) {
		throw new Error("Channel icon requires non-empty badge and badgeColor");
	}
	if (!baseSvg.includes("</svg>")) {
		throw new Error("Base SVG does not contain closing </svg> tag");
	}
	const badgeMarkup = `\t<!-- ${badge} 通道徽章 -->
\t<g id="channel-badge">
\t\t<rect x="612" y="800" width="300" height="112" rx="38" fill="${badgeColor}" />
\t\t<text x="762" y="876" text-anchor="middle" font-family="Arial, sans-serif" font-size="64" font-weight="700" letter-spacing="2" fill="#FFFFFF">${badge}</text>
\t</g>
</svg>`;
	return baseSvg.replace("</svg>", badgeMarkup);
}

/**
 * 校验并解析 PNG 文件头与 IHDR 尺寸。
 */
export function parsePngHeader(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 33) {
		throw new Error("Invalid PNG buffer: too short");
	}
	if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		throw new Error("Invalid PNG buffer: signature mismatch");
	}
	const ihdrLength = buffer.readUInt32BE(8);
	const ihdrType = buffer.toString("ascii", 12, 16);
	if (ihdrLength !== 13 || ihdrType !== "IHDR") {
		throw new Error(`Invalid PNG buffer: expected 13-byte IHDR chunk, got ${ihdrType} (${ihdrLength})`);
	}
	return {
		width: buffer.readUInt32BE(16),
		height: buffer.readUInt32BE(20),
		bitDepth: buffer[24],
		colorType: buffer[25],
	};
}

/**
 * 将多尺寸 PNG 帧封装为标准 Windows 多图层 ICO 二进制文件。
 * 遵循规范：ICONDIR (reserved=0, type=1, count=N)，256px 条目宽高字节写 0x00, 0x00。
 */
export function encodeIco(frames) {
	if (!Array.isArray(frames) || frames.length === 0) {
		throw new Error("encodeIco requires at least one frame");
	}
	const normalized = frames.map((frame) => {
		if (!frame || !Number.isInteger(frame.size) || frame.size < 1 || frame.size > 256) {
			throw new Error(`Invalid ICO frame size: ${frame?.size}`);
		}
		const header = parsePngHeader(frame.png);
		if (header.width !== frame.size || header.height !== frame.size) {
			throw new Error(
				`ICO frame PNG dimensions (${header.width}x${header.height}) do not match declared size ${frame.size}`,
			);
		}
		return { size: frame.size, png: frame.png };
	});

	const count = normalized.length;
	const headerSize = 6 + count * 16;
	const headerBuffer = Buffer.alloc(headerSize);
	headerBuffer.writeUInt16LE(0, 0); // idReserved
	headerBuffer.writeUInt16LE(1, 2); // idType = 1 (ICON)
	headerBuffer.writeUInt16LE(count, 4); // idCount

	let offset = headerSize;
	for (let i = 0; i < count; i++) {
		const { size, png } = normalized[i];
		const entryOffset = 6 + i * 16;
		const dimByte = size === 256 ? 0 : size;
		headerBuffer[entryOffset] = dimByte; // bWidth (0 means 256)
		headerBuffer[entryOffset + 1] = dimByte; // bHeight (0 means 256)
		headerBuffer[entryOffset + 2] = 0; // bColorCount
		headerBuffer[entryOffset + 3] = 0; // bReserved
		headerBuffer.writeUInt16LE(1, entryOffset + 4); // wPlanes
		headerBuffer.writeUInt16LE(32, entryOffset + 6); // wBitCount (32-bit RGBA)
		headerBuffer.writeUInt32LE(png.length, entryOffset + 8); // dwBytesInRes
		headerBuffer.writeUInt32LE(offset, entryOffset + 12); // dwImageOffset
		offset += png.length;
	}

	return Buffer.concat([headerBuffer, ...normalized.map((item) => item.png)]);
}

/**
 * 解析并校验标准 Windows ICO 二进制结构。
 */
export function parseIco(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 6) {
		throw new Error("Invalid ICO buffer: shorter than 6-byte ICONDIR header");
	}
	const reserved = buffer.readUInt16LE(0);
	const type = buffer.readUInt16LE(2);
	const count = buffer.readUInt16LE(4);
	const dirEnd = 6 + count * 16;
	if (buffer.length < dirEnd) {
		throw new Error(`Invalid ICO buffer: truncated directory (need ${dirEnd} bytes, got ${buffer.length})`);
	}

	const entries = [];
	for (let i = 0; i < count; i++) {
		const entryOffset = 6 + i * 16;
		const rawWidth = buffer[entryOffset];
		const rawHeight = buffer[entryOffset + 1];
		const width = rawWidth === 0 ? 256 : rawWidth;
		const height = rawHeight === 0 ? 256 : rawHeight;
		const colorCount = buffer[entryOffset + 2];
		const entryReserved = buffer[entryOffset + 3];
		const planes = buffer.readUInt16LE(entryOffset + 4);
		const bitCount = buffer.readUInt16LE(entryOffset + 6);
		const bytesInRes = buffer.readUInt32LE(entryOffset + 8);
		const imageOffset = buffer.readUInt32LE(entryOffset + 12);

		if (imageOffset < dirEnd || imageOffset + bytesInRes > buffer.length) {
			throw new Error(
				`Invalid ICO entry #${i}: payload range [${imageOffset}, ${imageOffset + bytesInRes}) exceeds buffer length ${buffer.length}`,
			);
		}
		const payload = buffer.subarray(imageOffset, imageOffset + bytesInRes);
		const isPng = payload.length >= 8 && payload.subarray(0, 8).equals(PNG_SIGNATURE);
		const pngHeader = isPng ? parsePngHeader(payload) : null;

		entries.push({
			index: i,
			rawWidth,
			rawHeight,
			width,
			height,
			colorCount,
			reserved: entryReserved,
			planes,
			bitCount,
			bytesInRes,
			imageOffset,
			isPng,
			pngHeader,
		});
	}

	return { reserved, type, count, entries };
}

/**
 * 生成 `packages/desktop/src/main/lan-icon.ts` 源码内容。
 */
export function buildLanIconSource(pngBuffer) {
	parsePngHeader(pngBuffer);
	const b64 = pngBuffer.toString("base64");
	return `/** PWA 图标（司命 · 文游 Pro 应用图标 512px PNG），base64 内联避免 extraResources/dev-packaged 路径分叉。 */\nexport const LAN_ICON_PNG_BASE64 =\n\t"${b64}";\n`;
}

function resolveGitCommonRepoRoot(repoRoot) {
	const dotGitPath = join(repoRoot, ".git");
	if (!existsSync(dotGitPath)) return null;
	try {
		const raw = readFileSync(dotGitPath, "utf8").trim();
		const match = /^gitdir:\s*(.+)$/i.exec(raw);
		if (!match) return null;
		const gitDir = isAbsolute(match[1]) ? match[1] : resolve(repoRoot, match[1]);
		const commonDirFile = join(gitDir, "commondir");
		if (!existsSync(commonDirFile)) return null;
		const commonRel = readFileSync(commonDirFile, "utf8").trim();
		const commonDir = isAbsolute(commonRel) ? commonRel : resolve(gitDir, commonRel);
		return dirname(commonDir);
	} catch {
		return null;
	}
}

/**
 * 解析当前仓库或关联主仓库中的 Electron 可执行文件路径。
 */
export function resolveElectronBinary(repoRoot) {
	if (process.env.WENYOU_ELECTRON_BIN && existsSync(process.env.WENYOU_ELECTRON_BIN)) {
		return process.env.WENYOU_ELECTRON_BIN;
	}

	const exeRel =
		process.platform === "win32"
			? "electron/dist/electron.exe"
			: process.platform === "darwin"
				? "electron/dist/Electron.app/Contents/MacOS/Electron"
				: "electron/dist/electron";

	const searchNodeModules = [join(repoRoot, "node_modules"), join(repoRoot, "packages/desktop/node_modules")];

	const commonRepoRoot = resolveGitCommonRepoRoot(repoRoot);
	if (commonRepoRoot) {
		searchNodeModules.push(
			join(commonRepoRoot, "node_modules"),
			join(commonRepoRoot, "packages/desktop/node_modules"),
		);
	}

	if (process.env.NODE_PATH) {
		for (const dir of process.env.NODE_PATH.split(delimiter)) {
			if (dir) searchNodeModules.push(dir);
		}
	}

	for (const nmDir of searchNodeModules) {
		const directBin = join(nmDir, exeRel);
		if (existsSync(directBin)) return directBin;
	}

	try {
		const require = createRequire(import.meta.url);
		const electronPath = require("electron");
		if (typeof electronPath === "string" && existsSync(electronPath)) {
			return electronPath;
		}
	} catch {
		// fall through to error
	}

	throw new Error(
		"Unable to locate Electron executable for SVG rasterization. Set WENYOU_ELECTRON_BIN or install dependencies.",
	);
}

const ELECTRON_RENDERER_HELPER = `"use strict";
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const jobPath = process.argv[2];
const job = JSON.parse(readFileSync(jobPath, "utf8"));
app.setPath("userData", join(job.tempDir, "user-data"));
app.setPath("sessionData", join(job.tempDir, "session-data"));

app.whenReady().then(async () => {
	try {
		const win = new BrowserWindow({
			show: false,
			width: 1024,
			height: 1024,
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		await win.loadURL("data:text/html,<!doctype html><html><body style='margin:0;background:transparent'></body></html>");

		const outputs = {};
		for (const task of job.tasks) {
			const svgText = readFileSync(task.svgPath, "utf8");
			const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
			const resultMap = await win.webContents.executeJavaScript(\`(async () => {
				const img = new Image();
				img.src = \${JSON.stringify(svgUrl)};
				await img.decode();
				const results = {};
				for (const targetSize of \${JSON.stringify(task.sizes)}) {
					let currentSize = targetSize >= 512 ? 1024 : Math.min(1024, targetSize * 4);
					let canvas = document.createElement("canvas");
					canvas.width = currentSize;
					canvas.height = currentSize;
					const ctx = canvas.getContext("2d");
					ctx.clearRect(0, 0, currentSize, currentSize);
					ctx.imageSmoothingEnabled = true;
					ctx.imageSmoothingQuality = "high";
					ctx.drawImage(img, 0, 0, currentSize, currentSize);
					while (currentSize > targetSize) {
						const nextSize = Math.max(targetSize, Math.floor(currentSize / 2));
						const nextCanvas = document.createElement("canvas");
						nextCanvas.width = nextSize;
						nextCanvas.height = nextSize;
						const nextCtx = nextCanvas.getContext("2d");
						nextCtx.clearRect(0, 0, nextSize, nextSize);
						nextCtx.imageSmoothingEnabled = true;
						nextCtx.imageSmoothingQuality = "high";
						nextCtx.drawImage(canvas, 0, 0, currentSize, currentSize, 0, 0, nextSize, nextSize);
						canvas = nextCanvas;
						currentSize = nextSize;
					}
					results[String(targetSize)] = canvas.toDataURL("image/png").split(",")[1];
				}
				return results;
			})()\`);
			outputs[task.id] = resultMap;
		}

		writeFileSync(job.outputJsonPath, JSON.stringify(outputs), "utf8");
		win.destroy();
		app.exit(0);
	} catch (error) {
		console.error(error);
		app.exit(1);
	}
});
`;

async function rasterizeSvgsWithElectron({ electronBin, tasks }) {
	const tempDir = await mkdtemp(join(os.tmpdir(), "wenyou-icon-render-"));
	const helperPath = join(tempDir, "render-icons.cjs");
	const jobPath = join(tempDir, "job.json");
	const outputJsonPath = join(tempDir, "output.json");

	try {
		await writeFile(helperPath, ELECTRON_RENDERER_HELPER, "utf8");
		await writeFile(jobPath, JSON.stringify({ tempDir, tasks, outputJsonPath }), "utf8");

		const env = { ...process.env };
		delete env.ELECTRON_RUN_AS_NODE;

		const result = spawnSync(electronBin, [helperPath, jobPath], {
			env,
			encoding: "utf8",
			timeout: 60_000,
		});

		if (result.error) {
			throw result.error;
		}
		if (result.status !== 0) {
			const details = (result.stderr || result.stdout || "").trim();
			throw new Error(`Electron icon rasterizer exited with status ${result.status}: ${details}`);
		}

		const raw = JSON.parse(await readFile(outputJsonPath, "utf8"));
		const decoded = {};
		for (const [taskId, sizeMap] of Object.entries(raw)) {
			decoded[taskId] = {};
			for (const [sizeStr, b64] of Object.entries(sizeMap)) {
				decoded[taskId][Number(sizeStr)] = Buffer.from(b64, "base64");
			}
		}
		return decoded;
	} finally {
		await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 }).catch(() => {});
	}
}

async function readChannelMetadata(buildDir) {
	const channelsPath = join(buildDir, "app-channels.json");
	if (!existsSync(channelsPath)) {
		return DEFAULT_CHANNELS;
	}
	const parsed = JSON.parse(await readFile(channelsPath, "utf8"));
	return {
		beta: {
			badge: parsed?.beta?.badge || DEFAULT_CHANNELS.beta.badge,
			badgeColor: parsed?.beta?.badgeColor || DEFAULT_CHANNELS.beta.badgeColor,
		},
		dev: {
			badge: parsed?.dev?.badge || DEFAULT_CHANNELS.dev.badge,
			badgeColor: parsed?.dev?.badgeColor || DEFAULT_CHANNELS.dev.badgeColor,
		},
	};
}

/**
 * 完整执行图标重绘与多尺寸光栅化落盘流程。
 */
export async function generateWenyouIcons(options = {}) {
	const repoRoot = resolve(options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
	const buildDir = join(repoRoot, "packages/desktop/build");
	const lanIconPath = join(repoRoot, "packages/desktop/src/main/lan-icon.ts");
	const icoSizes = options.sizes ?? ICO_SIZES;

	const channels = await readChannelMetadata(buildDir);
	const baseSvg = buildBaseIconSvg();
	const betaSvg = buildChannelIconSvg(baseSvg, channels.beta);
	const devSvg = buildChannelIconSvg(baseSvg, channels.dev);

	const iconSvgPath = join(buildDir, "icon.svg");
	const betaSvgPath = join(buildDir, "icon-beta.svg");
	const devSvgPath = join(buildDir, "icon-dev.svg");

	await writeFile(iconSvgPath, baseSvg, "utf8");
	await writeFile(betaSvgPath, betaSvg, "utf8");
	await writeFile(devSvgPath, devSvg, "utf8");

	const electronBin = options.electronBin ?? resolveElectronBinary(repoRoot);
	const mainSizes = Array.from(new Set([...icoSizes, LAN_ICON_SIZE, MAIN_PNG_SIZE])).sort((a, b) => a - b);

	const rasterized = await rasterizeSvgsWithElectron({
		electronBin,
		tasks: [
			{ id: "main", svgPath: iconSvgPath, sizes: mainSizes },
			{ id: "beta", svgPath: betaSvgPath, sizes: [MAIN_PNG_SIZE] },
			{ id: "dev", svgPath: devSvgPath, sizes: [MAIN_PNG_SIZE] },
		],
	});

	const mainPng = rasterized.main[MAIN_PNG_SIZE];
	const betaPng = rasterized.beta[MAIN_PNG_SIZE];
	const devPng = rasterized.dev[MAIN_PNG_SIZE];
	const lanPng = rasterized.main[LAN_ICON_SIZE];

	const icoFrames = icoSizes.map((size) => ({
		size,
		png: rasterized.main[size],
	}));
	const icoBuffer = encodeIco(icoFrames);

	await writeFile(join(buildDir, "icon.png"), mainPng);
	await writeFile(join(buildDir, "icon-beta.png"), betaPng);
	await writeFile(join(buildDir, "icon-dev.png"), devPng);
	await writeFile(join(buildDir, "wenyou-pro.ico"), icoBuffer);
	await writeFile(lanIconPath, buildLanIconSource(lanPng), "utf8");

	return {
		icoSizes: [...icoSizes],
		icoBytes: icoBuffer.length,
		mainPngBytes: mainPng.length,
		lanPngBytes: lanPng.length,
		files: [
			"packages/desktop/build/icon.svg",
			"packages/desktop/build/icon-beta.svg",
			"packages/desktop/build/icon-dev.svg",
			"packages/desktop/build/icon.png",
			"packages/desktop/build/icon-beta.png",
			"packages/desktop/build/icon-dev.png",
			"packages/desktop/build/wenyou-pro.ico",
			"packages/desktop/src/main/lan-icon.ts",
		],
	};
}

/**
 * 判断当前模块是否为命令行直接入口。
 * Windows 路径大小写不敏感（如小写盘符 `d:\...` 与 `D:\...`），统一按小写比较防止静默空跑。
 */
export function isDirectScriptExecution(metaUrl, argv1, platform = process.platform) {
	if (!argv1) return false;
	const scriptPath = resolve(fileURLToPath(metaUrl));
	const entryPath = resolve(argv1);
	return platform === "win32"
		? scriptPath.toLowerCase() === entryPath.toLowerCase()
		: scriptPath === entryPath;
}

if (isDirectScriptExecution(import.meta.url, process.argv[1])) {
	const summary = await generateWenyouIcons();
	console.log(
		`Generated Wenyou Pro icons: ${summary.files.length} files, wenyou-pro.ico=${summary.icoBytes} bytes (${summary.icoSizes.join(",")}px)`,
	);
}
