import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isPathInsideRoot,
	isRmSegment,
	isTemporaryPath,
	rmSegmentExempt,
	temporaryRoots,
} from "../src/permissions/tmp-zone";

/** 模拟项目根：非临时区的绝对路径（判定纯词法，不要求存在） */
const PROJECT = resolve("/Users/dev/project");
const TMP_ROOT = process.platform === "win32" ? resolve(tmpdir()) : "/tmp";

describe("temporaryRoots", () => {
	it("包含 tmpdir 字面根（POSIX 另含 /tmp，Windows 绝不含裸 /tmp）；进程内缓存", () => {
		const roots = temporaryRoots();
		expect(roots).toContain(resolve(tmpdir()));
		if (process.platform === "win32") {
			expect(roots).not.toContain("/tmp");
		} else {
			expect(roots).toContain("/tmp");
		}
		// 缓存：同一数组引用
		expect(temporaryRoots()).toBe(roots);
		// 无重复
		expect(new Set(roots).size).toBe(roots.length);
		// 全部是绝对路径
		expect(roots.every((r) => isAbsolute(r))).toBe(true);
	});

	it("macOS：额外包含两处 realpath 拼写（/private 前缀形态）", () => {
		if (process.platform !== "darwin") return;
		expect(temporaryRoots()).toContain(realpathSync(tmpdir()));
		expect(temporaryRoots()).toContain("/private/tmp");
	});
});

describe("isTemporaryPath", () => {
	it("根本身与根下路径都算临时区（含尾斜杠、深层子目录、tmpdir 字面拼写、..notes.md 合法文件名）", () => {
		expect(isTemporaryPath(TMP_ROOT)).toBe(true);
		expect(isTemporaryPath(`${TMP_ROOT}/`)).toBe(true);
		expect(isTemporaryPath(join(TMP_ROOT, "x.ts"))).toBe(true);
		expect(isTemporaryPath(join(TMP_ROOT, "a", "b", "c"))).toBe(true);
		expect(isTemporaryPath(join(TMP_ROOT, "..notes.md"))).toBe(true);
		expect(isTemporaryPath(`${tmpdir()}/x`)).toBe(true);
		expect(isTemporaryPath(`${tmpdir()}/x/`)).toBe(true);
	});

	it("Windows 下裸 /tmp 与 <盘符>:\\tmp 不视作临时区", () => {
		if (process.platform !== "win32") return;
		expect(isTemporaryPath("/tmp")).toBe(false);
		expect(isTemporaryPath("/tmp/evil.ps1")).toBe(false);
		expect(isTemporaryPath("C:\\tmp\\evil.ps1")).toBe(false);
	});

	it("isPathInsideRoot 正确区分 ..notes.md（界内）与 ../escape（界外）", () => {
		const root = resolve("/workspace/proj");
		expect(isPathInsideRoot(root, join(root, "..notes.md"))).toBe(true);
		expect(isPathInsideRoot(root, join(root, "sub", "..file"))).toBe(true);
		expect(isPathInsideRoot(root, resolve(root, ".."))).toBe(false);
		expect(isPathInsideRoot(root, resolve(root, "../escape.md"))).toBe(false);
	});

	it("macOS：realpath 拼写（/private 前缀形态）同样命中", () => {
		if (process.platform !== "darwin") return;
		expect(isTemporaryPath("/private/tmp/x")).toBe(true);
		expect(isTemporaryPath(`${realpathSync(tmpdir())}/x`)).toBe(true);
	});

	it("形态相近但不在临时区的路径不算", () => {
		expect(isTemporaryPath("/tmpfoo")).toBe(false);
		expect(isTemporaryPath("/etc/passwd")).toBe(false);
		expect(isTemporaryPath("/private/etc/hosts")).toBe(false);
		expect(isTemporaryPath("/usr/bin/rm")).toBe(false);
		expect(isTemporaryPath(PROJECT)).toBe(false);
	});

	it("穿越在 resolve 后塌缩判定：临时区向上逃逸不豁免，内部往返仍在区", () => {
		expect(isTemporaryPath(`${TMP_ROOT}/../etc`)).toBe(false);
		expect(isTemporaryPath(`${TMP_ROOT}/a/../../etc`)).toBe(false);
		expect(isTemporaryPath(`${TMP_ROOT}/a/../b`)).toBe(true);
		expect(isTemporaryPath(join(resolve(tmpdir()), "..", basename(resolve(tmpdir())), "x"))).toBe(true);
	});
});

describe("isRmSegment", () => {
	it("首 token 为 rm（任意 flag 组合、多余空白）", () => {
		expect(isRmSegment("rm x")).toBe(true);
		expect(isRmSegment("rm")).toBe(true);
		expect(isRmSegment("rm -rf /x")).toBe(true);
		expect(isRmSegment("  rm   -f x")).toBe(true);
		expect(isRmSegment("rm\t-f\tx")).toBe(true);
	});

	it("首 token 不是 rm 的都不算（sudo/xargs/find -exec/大小写/空串）", () => {
		expect(isRmSegment("sudo rm -rf /x")).toBe(false);
		expect(isRmSegment("xargs rm")).toBe(false);
		expect(isRmSegment("find /x -exec rm {} ;")).toBe(false);
		expect(isRmSegment("rms")).toBe(false);
		expect(isRmSegment("RM x")).toBe(false);
		expect(isRmSegment("")).toBe(false);
	});
});

describe("rmSegmentExempt（spec §5.3 边界语义表）", () => {
	it("绝对路径直接判；flag 全跳过；尾斜杠", () => {
		expect(rmSegmentExempt(`rm ${TMP_ROOT}/a.ts`, PROJECT)).toBe(true);
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/dir/`, PROJECT)).toBe(true);
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/a ${TMP_ROOT}/b`, PROJECT)).toBe(true);
		expect(rmSegmentExempt(`rm ${resolve(tmpdir())}/x`, PROJECT)).toBe(true);
	});

	it("穿越不豁免（方案 D 的洞在此堵死）", () => {
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/../etc`, PROJECT)).toBe(false);
		expect(rmSegmentExempt(`rm -rf ${tmpdir()}/../../etc`, PROJECT)).toBe(false);
	});

	it("glob token 取 dirname 判定；加引号的按字面", () => {
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/foo-*`, PROJECT)).toBe(true);
		expect(rmSegmentExempt(`rm -rf "${TMP_ROOT}/foo-*"`, PROJECT)).toBe(true);
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/a-* /etc/b`, PROJECT)).toBe(false);
	});

	it("变量不展开：$HOME/$TMPDIR 字面按相对/界外处理 → 不豁免", () => {
		expect(rmSegmentExempt('rm -rf "$HOME/tmp/x"', PROJECT)).toBe(false);
		expect(rmSegmentExempt("rm -rf $TMPDIR/x", PROJECT)).toBe(false);
		expect(rmSegmentExempt("rm -rf ~/x", PROJECT)).toBe(false);
	});

	it("相对路径按 cwd resolve：项目内目标不豁免；cwd 在临时区则豁免（项目放 tmp 即接受 tmp 语义）", () => {
		expect(rmSegmentExempt("rm ./x", PROJECT)).toBe(false);
		expect(rmSegmentExempt("rm sub/x", PROJECT)).toBe(false);
		expect(rmSegmentExempt("rm ./*.ts", PROJECT)).toBe(false);
		expect(rmSegmentExempt("rm sub/x", tmpdir())).toBe(true);
	});

	it("无路径参数不豁免（fail-safe）", () => {
		expect(rmSegmentExempt("rm -f", PROJECT)).toBe(false);
		expect(rmSegmentExempt("rm", PROJECT)).toBe(false);
	});

	it("-- 之后全部当路径参数", () => {
		expect(rmSegmentExempt(`rm -- ${TMP_ROOT}/x`, PROJECT)).toBe(true);
		expect(rmSegmentExempt("rm -- -foo", PROJECT)).toBe(false); // -foo resolve 到 cwd，非临时区
	});

	it("赋值前缀跳过、后续 token 是参数", () => {
		expect(rmSegmentExempt("rm x=/1 y", PROJECT)).toBe(false); // y → 项目内
		expect(rmSegmentExempt(`rm x=/1 ${TMP_ROOT}/y`, PROJECT)).toBe(true);
	});

	it("混合目标任一在外即整体不豁免", () => {
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/a /etc/b`, PROJECT)).toBe(false);
		expect(rmSegmentExempt(`rm -rf /etc/b ${TMP_ROOT}/a`, PROJECT)).toBe(false);
	});

	it("首 token 不是 rm（sudo 等）不进判定", () => {
		expect(rmSegmentExempt(`sudo rm -rf ${TMP_ROOT}/x`, PROJECT)).toBe(false);
	});

	it("引号内的空格是路径的一部分", () => {
		expect(rmSegmentExempt(`rm "${TMP_ROOT}/a b.ts"`, PROJECT)).toBe(true);
		expect(rmSegmentExempt('rm "/etc/a b.ts"', PROJECT)).toBe(false);
	});

	it("加引号的 flag 不再按 flag 跳过 → 按路径判定 → fail-safe 不豁免", () => {
		expect(rmSegmentExempt(`rm "-rf" ${TMP_ROOT}/x`, PROJECT)).toBe(false);
	});

	it("cwd 缺省：相对路径无从证明 → 不豁免；全绝对路径目标仍可判", () => {
		expect(rmSegmentExempt("rm x", undefined)).toBe(false);
		expect(rmSegmentExempt("rm ./x", undefined)).toBe(false);
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/x`, undefined)).toBe(true);
		expect(rmSegmentExempt(`rm -rf ${TMP_ROOT}/x /etc/y`, undefined)).toBe(false);
	});
});
