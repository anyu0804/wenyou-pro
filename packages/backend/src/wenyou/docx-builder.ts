import { deflateRawSync } from "node:zlib";

export interface PolicyDocxInput {
	title: string;
	bodyMarkdown: string;
	subtitle?: string;
	createdAt?: string;
}

const DEFAULT_AUTHOR = "安钰";

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let j = 0; j < 8; j++) {
			c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
})();

export function computeCrc32(buf: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		const byte = buf[i] ?? 0;
		crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(text: string): string {
	return text
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function stripFrontmatter(markdown: string): string {
	const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	const openMatch = normalized.match(/^---[ \t]*\n/);
	if (!openMatch) return normalized;
	const rest = normalized.slice(openMatch[0].length);
	const closeMatch = rest.match(/(?:^|\n)---[ \t]*(?:\n|$)/);
	if (!closeMatch || closeMatch.index === undefined) return normalized;
	return rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\n+/, "");
}

interface InlineRun {
	text: string;
	bold?: boolean;
	italic?: boolean;
}

function parseInlineRuns(text: string): InlineRun[] {
	const runs: InlineRun[] = [];
	const tokenRe = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
	let cursor = 0;
	for (const match of text.matchAll(tokenRe)) {
		const idx = match.index ?? 0;
		if (idx > cursor) {
			runs.push({ text: text.slice(cursor, idx) });
		}
		const token = match[0];
		if (token.startsWith("**") && token.endsWith("**")) {
			runs.push({ text: token.slice(2, -2), bold: true });
		} else if (token.startsWith("*") && token.endsWith("*")) {
			runs.push({ text: token.slice(1, -1), italic: true });
		} else if (token.startsWith("`") && token.endsWith("`")) {
			runs.push({ text: token.slice(1, -1) });
		}
		cursor = idx + token.length;
	}
	if (cursor < text.length) {
		runs.push({ text: text.slice(cursor) });
	}
	return runs.length > 0 ? runs : [{ text }];
}

function renderRunsXml(
	runs: InlineRun[],
	opts: { szHalfPts?: number; bold?: boolean; font?: string; color?: string } = {},
): string {
	const font = opts.font ?? "SimSun";
	const sz = opts.szHalfPts ?? 21; // 10.5pt 五号
	return runs
		.map((run) => {
			const isBold = opts.bold || run.bold;
			const isItalic = run.italic;
			const rPr = [
				`<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
				isBold ? "<w:b/><w:bCs/>" : "",
				isItalic ? "<w:i/><w:iCs/>" : "",
				opts.color ? `<w:color w:val="${opts.color}"/>` : "",
				`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`,
			].join("");
			return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escapeXml(run.text)}</w:t></w:r>`;
		})
		.join("");
}

function buildBodyParagraphsXml(input: PolicyDocxInput): string {
	const blocks: string[] = [];

	// 标题段：居中 15pt (30 half-points)，粗体
	blocks.push(
		`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="200" w:line="300" w:lineRule="auto"/></w:pPr>${renderRunsXml(
			[{ text: input.title.trim() }],
			{ szHalfPts: 30, bold: true, font: "SimSun" },
		)}</w:p>`,
	);

	if (input.subtitle?.trim()) {
		blocks.push(
			`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="200" w:line="300" w:lineRule="auto"/></w:pPr>${renderRunsXml(
				[{ text: input.subtitle.trim() }],
				{ szHalfPts: 20, font: "SimSun", color: "555555" },
			)}</w:p>`,
		);
	}

	const rawLines = stripFrontmatter(input.bodyMarkdown).split("\n");
	let paragraphBuffer: string[] = [];
	let skippedDuplicateTitle = false;

	const flushParagraph = () => {
		const joined = paragraphBuffer.join("").trim();
		paragraphBuffer = [];
		if (!joined) return;
		blocks.push(
			`<w:p><w:pPr><w:spacing w:before="0" w:after="100" w:line="300" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr>${renderRunsXml(
				parseInlineRuns(joined),
				{ szHalfPts: 21, font: "SimSun" },
			)}</w:p>`,
		);
	};

	for (const rawLine of rawLines) {
		const trimmed = rawLine.trim();
		if (!trimmed) {
			flushParagraph();
			continue;
		}
		const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
		if (hMatch && hMatch[1] && hMatch[2]) {
			flushParagraph();
			const level = hMatch[1].length;
			const headingText = hMatch[2].trim();
			if (level === 1 && !skippedDuplicateTitle && headingText === input.title.trim()) {
				skippedDuplicateTitle = true;
				continue;
			}
			const sz = level <= 2 ? 24 : 21; // 小四 12pt 或 五号加粗 10.5pt
			blocks.push(
				`<w:p><w:pPr><w:spacing w:before="180" w:after="100" w:line="300" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr>${renderRunsXml(
					parseInlineRuns(headingText),
					{ szHalfPts: sz, bold: true, font: "SimSun" },
				)}</w:p>`,
			);
			continue;
		}
		// 单级无序列表项转为规范正文缩进段（不做 Word 乱缩进）
		const bulletMatch = trimmed.match(/^(?:[-*+]\s+)(.+)$/);
		if (bulletMatch && bulletMatch[1]) {
			flushParagraph();
			blocks.push(
				`<w:p><w:pPr><w:spacing w:before="0" w:after="80" w:line="300" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr>${renderRunsXml(
					parseInlineRuns(bulletMatch[1].trim()),
					{ szHalfPts: 21, font: "SimSun" },
				)}</w:p>`,
			);
			continue;
		}
		// 单级有序列表项独立分段并保留序号文本，不与前后段粘连
		const orderedMatch = trimmed.match(/^(?:\d+[.、)）]|[一二三四五六七八九十]+[、.）])\s+.+$/);
		if (orderedMatch) {
			flushParagraph();
			blocks.push(
				`<w:p><w:pPr><w:spacing w:before="0" w:after="80" w:line="300" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr>${renderRunsXml(
					parseInlineRuns(trimmed),
					{ szHalfPts: 21, font: "SimSun" },
				)}</w:p>`,
			);
			continue;
		}
		paragraphBuffer.push(trimmed);
	}
	flushParagraph();

	return blocks.join("");
}

function buildContentTypesXml(): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
		'<Default Extension="xml" ContentType="application/xml"/>',
		'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
		'<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
		'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
		'<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
		"</Types>",
	].join("");
}

function buildRootRelsXml(): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
		'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
		'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
		"</Relationships>",
	].join("");
}

function buildDocumentRelsXml(): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
		"</Relationships>",
	].join("");
}

function buildStylesXml(): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
		"<w:docDefaults>",
		"<w:rPrDefault><w:rPr>",
		'<w:rFonts w:ascii="SimSun" w:hAnsi="SimSun" w:eastAsia="SimSun" w:cs="SimSun"/>',
		'<w:sz w:val="21"/><w:szCs w:val="21"/>',
		'<w:lang w:val="en-US" w:eastAsia="zh-CN"/>',
		"</w:rPr></w:rPrDefault>",
		"<w:pPrDefault><w:pPr>",
		'<w:spacing w:line="300" w:lineRule="auto"/>',
		'<w:ind w:firstLineChars="200" w:firstLine="420"/>',
		"</w:pPr></w:pPrDefault>",
		"</w:docDefaults>",
		'<w:style w:type="paragraph" w:default="1" w:styleId="Normal">',
		'<w:name w:val="Normal"/>',
		'<w:pPr><w:spacing w:line="300" w:lineRule="auto"/><w:ind w:firstLineChars="200" w:firstLine="420"/></w:pPr>',
		'<w:rPr><w:rFonts w:ascii="SimSun" w:hAnsi="SimSun" w:eastAsia="SimSun" w:cs="SimSun"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>',
		"</w:style>",
		"</w:styles>",
	].join("");
}

function buildCorePropsXml(title: string, createdIso: string): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
		`<dc:title>${escapeXml(title)}</dc:title>`,
		`<dc:creator>${DEFAULT_AUTHOR}</dc:creator>`,
		`<cp:lastModifiedBy>${DEFAULT_AUTHOR}</cp:lastModifiedBy>`,
		`<dcterms:created xsi:type="dcterms:W3CDTF">${escapeXml(createdIso)}</dcterms:created>`,
		`<dcterms:modified xsi:type="dcterms:W3CDTF">${escapeXml(createdIso)}</dcterms:modified>`,
		"</cp:coreProperties>",
	].join("");
}

function buildAppPropsXml(): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">',
		"<Application>Wenyou Pro</Application>",
		"</Properties>",
	].join("");
}

function buildDocumentXml(input: PolicyDocxInput): string {
	return [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
		"<w:body>",
		buildBodyParagraphsXml(input),
		'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>',
		"</w:body>",
		"</w:document>",
	].join("");
}

interface ZipEntry {
	name: string;
	data: Buffer;
}

function toDosDateTime(date: Date): { time: number; dosDate: number } {
	const year = Math.max(1980, date.getUTCFullYear());
	const dosDate = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
	const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1);
	return { time, dosDate };
}

/** 零外部依赖 PKZIP 2.0 打包器（DEFLATE + CRC32 + UTF-8 flag），输出标准 .docx Buffer */
export function buildZipBuffer(entries: readonly ZipEntry[], date = new Date()): Buffer {
	const { time, dosDate } = toDosDateTime(date);
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const nameBuf = Buffer.from(entry.name, "utf8");
		const uncompressed = entry.data;
		const compressed = deflateRawSync(uncompressed);
		const crc = computeCrc32(uncompressed);

		const localHeader = Buffer.alloc(30 + nameBuf.length);
		localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
		localHeader.writeUInt16LE(20, 4); // version needed: 2.0
		localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
		localHeader.writeUInt16LE(8, 8); // compression method: DEFLATE
		localHeader.writeUInt16LE(time, 10);
		localHeader.writeUInt16LE(dosDate, 12);
		localHeader.writeUInt32LE(crc, 14);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(uncompressed.length, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28); // extra length
		nameBuf.copy(localHeader, 30);

		localParts.push(localHeader, compressed);

		const centralHeader = Buffer.alloc(46 + nameBuf.length);
		centralHeader.writeUInt32LE(0x02014b50, 0); // central dir signature
		centralHeader.writeUInt16LE(20, 4); // version made by
		centralHeader.writeUInt16LE(20, 6); // version needed
		centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
		centralHeader.writeUInt16LE(8, 10); // DEFLATE
		centralHeader.writeUInt16LE(time, 12);
		centralHeader.writeUInt16LE(dosDate, 14);
		centralHeader.writeUInt32LE(crc, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(uncompressed.length, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30); // extra length
		centralHeader.writeUInt16LE(0, 32); // comment length
		centralHeader.writeUInt16LE(0, 34); // disk number start
		centralHeader.writeUInt16LE(0, 36); // internal file attrs
		centralHeader.writeUInt32LE(0, 38); // external file attrs
		centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
		nameBuf.copy(centralHeader, 46);

		centralParts.push(centralHeader);
		offset += localHeader.length + compressed.length;
	}

	const centralDir = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
	eocd.writeUInt16LE(0, 4); // disk number
	eocd.writeUInt16LE(0, 6); // start disk
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20); // comment length

	return Buffer.concat([...localParts, centralDir, eocd]);
}

/**
 * 免 Python 纯 Node 生成中文国策规范 .docx：
 * - 标题居中 15pt
 * - 正文宋体 SimSun 10.5pt（五号）、首行缩进 2 字符（firstLineChars="200"）、1.25 倍行距（line="300"）
 * - docProps/core.xml creator 固定为「安钰」
 */
export function buildPolicyDocx(input: PolicyDocxInput): Buffer {
	const createdDate = input.createdAt ? new Date(input.createdAt) : new Date();
	const createdIso = Number.isNaN(createdDate.getTime())
		? new Date().toISOString()
		: createdDate.toISOString();

	const entries: ZipEntry[] = [
		{ name: "[Content_Types].xml", data: Buffer.from(buildContentTypesXml(), "utf8") },
		{ name: "_rels/.rels", data: Buffer.from(buildRootRelsXml(), "utf8") },
		{ name: "docProps/core.xml", data: Buffer.from(buildCorePropsXml(input.title.trim(), createdIso), "utf8") },
		{ name: "docProps/app.xml", data: Buffer.from(buildAppPropsXml(), "utf8") },
		{ name: "word/_rels/document.xml.rels", data: Buffer.from(buildDocumentRelsXml(), "utf8") },
		{ name: "word/styles.xml", data: Buffer.from(buildStylesXml(), "utf8") },
		{ name: "word/document.xml", data: Buffer.from(buildDocumentXml(input), "utf8") },
	];

	return buildZipBuffer(entries, Number.isNaN(createdDate.getTime()) ? new Date() : createdDate);
}
