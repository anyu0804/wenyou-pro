import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildBaseIconSvg,
	buildChannelIconSvg,
	encodeIco,
	ICO_SIZES,
	isDirectScriptExecution,
	MAIN_PNG_SIZE,
	PNG_SIGNATURE,
	parseIco,
	parsePngHeader,
} from "./generate-wenyou-icons.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD_DIR = join(REPO_ROOT, "packages/desktop/build");
const GENERATOR_PATH = join(REPO_ROOT, "scripts/wenyou-release/generate-wenyou-icons.mjs");

// 旧版 Percho 灰色正四棱锥图标指纹，用于防止回归
const LEGACY_ICO_SHA256 = "ae5f0d50aa8d59631673b0296985da03764af9d58b7e9e351eadf0682cfb76a6";
const LEGACY_PNG_SHA256 = "42b7694133630028db47f013e4ea8eb8a3dbd819c846f1288aba793ce327e9cb";

function sha256Hex(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

function makeFakePng(width, height) {
	const buf = Buffer.alloc(33);
	PNG_SIGNATURE.copy(buf, 0);
	buf.writeUInt32BE(13, 8);
	buf.write("IHDR", 12, 4, "ascii");
	buf.writeUInt32BE(width, 16);
	buf.writeUInt32BE(height, 20);
	buf[24] = 8; // bit depth
	buf[25] = 6; // RGBA
	return buf;
}

describe("SVG builders and binary ICO codec", () => {
	test("buildBaseIconSvg produces clean 1024x1024 Wenyou Pro scroll-and-brush artwork", () => {
		const svg = buildBaseIconSvg();
		assert.match(svg, /width="1024"/);
		assert.match(svg, /height="1024"/);
		assert.match(svg, /viewBox="0 0 1024 1024"/);
		assert.match(svg, /<title>司命 · 文游 Pro<\/title>/);
		assert.doesNotMatch(svg, /percho/i);
		assert.doesNotMatch(svg, /正四棱锥/);
		assert.match(svg, /#FAF8F3/i);
		assert.match(svg, /#F2EFE7/i);
		assert.match(svg, /#1F2329/i);
		assert.match(svg, /#C83E37/i);
	});

	test("buildChannelIconSvg appends channel badge cleanly", () => {
		const base = buildBaseIconSvg();
		const beta = buildChannelIconSvg(base, { badge: "BETA", badgeColor: "#c47417" });
		const dev = buildChannelIconSvg(base, { badge: "DEV", badgeColor: "#5271c4" });
		assert.match(beta, />BETA<\/text>/);
		assert.match(beta, /#c47417/i);
		assert.match(dev, />DEV<\/text>/);
		assert.match(dev, /#5271c4/i);
		assert.throws(() => buildChannelIconSvg("<svg>", { badge: "BETA", badgeColor: "#c47417" }));
		assert.throws(() => buildChannelIconSvg(base, { badge: "", badgeColor: "#c47417" }));
	});

	test("encodeIco and parseIco round-trip all 7 sizes including 256px 0x00 encoding", () => {
		const frames = ICO_SIZES.map((size) => ({ size, png: makeFakePng(size, size) }));
		const ico = encodeIco(frames);
		const parsed = parseIco(ico);

		assert.equal(parsed.reserved, 0);
		assert.equal(parsed.type, 1);
		assert.equal(parsed.count, 7);
		assert.deepEqual(
			parsed.entries.map((e) => e.width),
			[16, 24, 32, 48, 64, 128, 256],
		);
		const entry256 = parsed.entries.find((e) => e.width === 256);
		assert.ok(entry256);
		assert.equal(entry256.rawWidth, 0);
		assert.equal(entry256.rawHeight, 0);
		for (const entry of parsed.entries) {
			assert.equal(entry.isPng, true);
			assert.equal(entry.pngHeader.width, entry.width);
			assert.equal(entry.pngHeader.height, entry.height);
		}
	});

	test("encodeIco and parseIco reject malformed inputs", () => {
		assert.throws(() => encodeIco([]), /at least one frame/);
		assert.throws(() => encodeIco([{ size: 32, png: makeFakePng(64, 64) }]), /do not match declared size/);
		assert.throws(() => encodeIco([{ size: 512, png: makeFakePng(512, 512) }]), /Invalid ICO frame size/);
		assert.throws(() => parseIco(Buffer.alloc(4)), /shorter than 6-byte/);
		assert.throws(() => parsePngHeader(Buffer.from("not-a-png")), /too short/);
		assert.throws(() => parsePngHeader(Buffer.alloc(40, 0x41)), /signature mismatch/);
	});

	test("isDirectScriptExecution matches case-insensitively on Windows drive/path casing", () => {
		const metaUrl = pathToFileURL(GENERATOR_PATH).href;
		const flippedCasePath =
			process.platform === "win32"
				? GENERATOR_PATH.replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`).replace(
						"generate-wenyou-icons.mjs",
						"GENERATE-WENYOU-ICONS.MJS",
					)
				: GENERATOR_PATH.replace("generate-wenyou-icons.mjs", "GENERATE-WENYOU-ICONS.MJS");

		assert.equal(isDirectScriptExecution(metaUrl, GENERATOR_PATH, "win32"), true);
		assert.equal(isDirectScriptExecution(metaUrl, flippedCasePath, "win32"), true);
		assert.equal(isDirectScriptExecution(metaUrl, flippedCasePath, "linux"), false);
		assert.equal(isDirectScriptExecution(metaUrl, undefined, "win32"), false);
		assert.equal(isDirectScriptExecution(metaUrl, join(REPO_ROOT, "other.mjs"), "win32"), false);
	});
});

describe("Generated Wenyou Pro icon artifacts on disk", () => {
	test("packages/desktop/build/wenyou-pro.ico has 7 crisp PNG frames covering 16..256 and exceeds 20KB", async () => {
		const icoPath = join(BUILD_DIR, "wenyou-pro.ico");
		const icoBuffer = await readFile(icoPath);
		const info = await stat(icoPath);

		assert.ok(info.size > 20 * 1024, `Expected wenyou-pro.ico > 20KB, got ${info.size} bytes`);
		const digest = sha256Hex(icoBuffer);
		assert.notEqual(digest, LEGACY_ICO_SHA256, "wenyou-pro.ico must not match legacy Percho pyramid hash");

		const parsed = parseIco(icoBuffer);
		assert.equal(parsed.reserved, 0);
		assert.equal(parsed.type, 1);
		assert.equal(parsed.count, 7);
		assert.deepEqual(
			parsed.entries.map((entry) => entry.width),
			[16, 24, 32, 48, 64, 128, 256],
		);
		assert.deepEqual(
			parsed.entries.map((entry) => entry.height),
			[16, 24, 32, 48, 64, 128, 256],
		);

		const entry256 = parsed.entries[6];
		assert.equal(entry256.rawWidth, 0);
		assert.equal(entry256.rawHeight, 0);

		let prevEnd = 6 + parsed.count * 16;
		for (const entry of parsed.entries) {
			assert.ok(entry.imageOffset >= prevEnd, `ICO entry #${entry.index} overlaps previous payload`);
			assert.ok(entry.bytesInRes > 0, `ICO entry #${entry.index} has zero length`);
			assert.ok(entry.imageOffset + entry.bytesInRes <= icoBuffer.length);
			assert.deepEqual(
				icoBuffer.subarray(entry.imageOffset, entry.imageOffset + 4),
				Buffer.from([0x89, 0x50, 0x4e, 0x47]),
				`ICO entry #${entry.index} must start with PNG magic 89 50 4E 47`,
			);
			assert.equal(entry.isPng, true);
			assert.equal(entry.pngHeader.width, entry.width);
			assert.equal(entry.pngHeader.height, entry.height);
			prevEnd = entry.imageOffset + entry.bytesInRes;
		}
	});

	test("icon.svg, icon-beta.svg and icon-dev.svg contain zero Percho/pyramid remnants", async () => {
		const [mainSvg, betaSvg, devSvg] = await Promise.all([
			readFile(join(BUILD_DIR, "icon.svg"), "utf8"),
			readFile(join(BUILD_DIR, "icon-beta.svg"), "utf8"),
			readFile(join(BUILD_DIR, "icon-dev.svg"), "utf8"),
		]);

		for (const [name, content] of [
			["icon.svg", mainSvg],
			["icon-beta.svg", betaSvg],
			["icon-dev.svg", devSvg],
		]) {
			assert.doesNotMatch(content, /percho/i, `${name} must not mention Percho`);
			assert.doesNotMatch(content, /正四棱锥/, `${name} must not mention 正四棱锥`);
			assert.match(content, /<title>司命 · 文游 Pro<\/title>/, `${name} must carry Wenyou Pro title`);
		}
		assert.match(betaSvg, />BETA<\/text>/);
		assert.match(devSvg, />DEV<\/text>/);
	});

	test("icon.png, icon-beta.png and icon-dev.png are valid 1024x1024 PNGs", async () => {
		for (const fileName of ["icon.png", "icon-beta.png", "icon-dev.png"]) {
			const buf = await readFile(join(BUILD_DIR, fileName));
			const header = parsePngHeader(buf);
			assert.equal(header.width, MAIN_PNG_SIZE, `${fileName} width should be ${MAIN_PNG_SIZE}`);
			assert.equal(header.height, MAIN_PNG_SIZE, `${fileName} height should be ${MAIN_PNG_SIZE}`);
			if (fileName === "icon.png") {
				assert.notEqual(sha256Hex(buf), LEGACY_PNG_SHA256, "icon.png must differ from legacy pyramid PNG");
			}
		}
	});

	test("generated scripts and SVGs do not leak hardcoded personal user paths", async () => {
		const filesToCheck = [
			GENERATOR_PATH,
			join(BUILD_DIR, "icon.svg"),
			join(BUILD_DIR, "icon-beta.svg"),
			join(BUILD_DIR, "icon-dev.svg"),
		];
		for (const filePath of filesToCheck) {
			const text = await readFile(filePath, "utf8");
			assert.doesNotMatch(text, /[A-Za-z]:\\Users\\/i);
			assert.doesNotMatch(text, /\/Users\/[^/\s]+/i);
		}
	});
});
