import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { applyPatch, parseHunks, sha256 } from "../bin/patch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(HERE, "..", "bin", "patch.mjs");

const PRISTINE = "alpha\nbeta\ngamma\n";
const PATCH = [
	"--- a/lib/client.js",
	"+++ b/lib/client.js",
	"@@ -1,3 +1,4 @@",
	" alpha",
	" beta",
	"+inserted",
	" gamma",
	""
].join("\n");
const PATCHED = "alpha\nbeta\ninserted\ngamma\n";

test("sha256 对 UTF-8 文本稳定", () => {
	assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("parseHunks 还原 hunk 新旧行", () => {
	const [hunk] = parseHunks(PATCH);
	assert.equal(hunk.oldStart, 1);
	assert.equal(hunk.newStart, 1);
	assert.deepEqual(hunk.oldLines, ["alpha", "beta", "gamma"]);
	assert.deepEqual(hunk.newLines, ["alpha", "beta", "inserted", "gamma"]);
});

test("applyPatch 多 hunk 的正向/反向均按各自行号基准定位", () => {
	const pristine = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "k", ""].join("\n");
	const patched = ["a", "b", "x", "c", "d", "e", "f", "g", "h", "i", "j", "k", ""].join("\n");
	const multi = [
		"--- a/lib/client.js",
		"+++ b/lib/client.js",
		"@@ -1,3 +1,4 @@",
		" a",
		" b",
		"+x",
		" c",
		"@@ -8,3 +9,4 @@",
		" h",
		" i",
		"+j",
		" k",
		""
	].join("\n");
	assert.equal(applyPatch(pristine, multi, false), patched);
	assert.equal(applyPatch(patched, multi, true), pristine);
});

test("applyPatch 正向与反向互为逆运算", () => {
	assert.equal(applyPatch(PRISTINE, PATCH, false), PATCHED);
	assert.equal(applyPatch(PATCHED, PATCH, true), PRISTINE);
});

test("applyPatch 上下文不匹配时报错而不是静默写坏", () => {
	assert.throws(() => applyPatch("alpha\nBET A\ngamma\n", PATCH, false), /上下文不匹配/);
});

test("applyPatch 拒绝乱序或重叠的 hunk", () => {
	const overlapping = [
		"--- a/lib/client.js",
		"+++ b/lib/client.js",
		"@@ -2,2 +2,2 @@",
		" beta",
		"-gamma",
		"+delta",
		"@@ -1,2 +1,2 @@",
		"-alpha",
		"+zeta",
		" beta",
		""
	].join("\n");
	assert.throws(() => applyPatch(PRISTINE, overlapping, false), /重叠或乱序/);
});

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "dsh-compat-patch-"));
	const profile = join(root, "profile");
	const pkgDir = join(profile, "node_modules", "@deepseek-ai", "dsh-client-modules", "lib");
	mkdirSync(pkgDir, { recursive: true });
	const file = join(pkgDir, "client.js");
	writeFileSync(file, PRISTINE, "utf8");
	const patchFile = join(root, "sample.patch");
	writeFileSync(patchFile, PATCH, "utf8");
	const manifest = join(root, "manifest.json");
	writeFileSync(
		manifest,
		JSON.stringify({
			schema: 1,
			targets: [
				{
					id: "sample",
					pkg: "@deepseek-ai/dsh-client-modules",
					rel: "lib/client.js",
					patch: patchFile,
					create: false,
					pristine_sha256: sha256(PRISTINE),
					patched_sha256: sha256(PATCHED)
				}
			]
		}),
		"utf8"
	);
	return { root, profile, file, manifest };
}

function run(args) {
	return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
}

test("CLI：check → apply → check → revert 全链路", () => {
	const fixture = makeFixture();
	try {
		let result = run(["--check", "--manifest", fixture.manifest, "--profile", fixture.profile]);
		assert.equal(result.status, 1, "未打补丁时 check 应退出 1");

		result = run(["--apply", "--manifest", fixture.manifest, "--profile", fixture.profile]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(fixture.file, "utf8"), PATCHED);
		assert.ok(existsSync(`${fixture.file}.orig`), "应留下 .orig 备份");

		result = run(["--check", "--manifest", fixture.manifest, "--profile", fixture.profile]);
		assert.equal(result.status, 0, "已打补丁时 check 应退出 0");

		result = run(["--revert", "--manifest", fixture.manifest, "--profile", fixture.profile]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(fixture.file, "utf8"), PRISTINE);
		assert.ok(!existsSync(`${fixture.file}.orig`), "回滚后应删除 .orig");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("CLI：漂移时 apply/revert 都拒绝且不改文件", () => {
	const fixture = makeFixture();
	try {
		writeFileSync(fixture.file, "tampered\n", "utf8");
		const result = run(["--apply", "--manifest", fixture.manifest, "--profile", fixture.profile]);
		assert.equal(result.status, 1);
		assert.match(result.stdout + result.stderr, /漂移/);
		assert.equal(readFileSync(fixture.file, "utf8"), "tampered\n");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("CLI：未安装该包时 skip 且 check 退出 0", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-compat-skip-"));
	try {
		const manifest = join(root, "manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				targets: [
					{
						id: "sample",
						pkg: "@deepseek-ai/dsh-client-modules",
						rel: "lib/client.js",
						patch: join(root, "missing.patch"),
						pristine_sha256: sha256(PRISTINE),
						patched_sha256: sha256(PATCHED)
					}
				]
			}),
			"utf8"
		);
		const profile = join(root, "empty-profile");
		const result = run(["--check", "--manifest", manifest, "--profile", profile]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /not installed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
