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
const SELFCHECK = resolve(HERE, "..", "bin", "selfcheck.mjs");

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

test("真实补丁含 B2：FAILED 条目在 audit 之前被清理", () => {
	const patch = readFileSync(resolve(HERE, "..", "patches", "compat", "client-modules-isolate.patch"), "utf8");
	const awaitIndex = patch.indexOf("await loader.await();");
	const b2Index = patch.indexOf("entry.fiber.state !== FAILED");
	assert.ok(awaitIndex >= 0, "补丁应包含 await loader.await()");
	assert.ok(b2Index > awaitIndex, "B2 清理必须位于 await loader.await() 之后（激活完成才会变 FAILED）");
	assert.match(patch, /failed to activate; isolating it/);
	assert.match(patch, /this\.desired\.plugins\.some\(\(row\) => row\.id === failedName\)/, "B2 必须只清理 desired.plugins 内的条目");
	assert.match(patch, /this\.managed\.delete\(failedName\)/);
});

test("CLI：--node-modules 直接指定 node_modules 根（Termux 全局树路径）", () => {
	const fixture = makeFixture();
	try {
		const nodeModules = join(fixture.profile, "node_modules");
		let result = run(["--check", "--manifest", fixture.manifest, "--node-modules", nodeModules]);
		assert.equal(result.status, 1, "未打补丁时 check 应退出 1");
		result = run(["--apply", "--manifest", fixture.manifest, "--node-modules", nodeModules]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(fixture.file, "utf8"), PATCHED);
		result = run(["--revert", "--manifest", fixture.manifest, "--node-modules", nodeModules]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(fixture.file, "utf8"), PRISTINE);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

function runSelfcheck(args) {
	return spawnSync(process.execPath, [SELFCHECK, ...args], { encoding: "utf8" });
}

test("CLI：--allow-drift 必须与 --force 同时使用", () => {
	const fixture = makeFixture();
	try {
		const result = run(["--apply", "--manifest", fixture.manifest, "--profile", fixture.profile, "--allow-drift"]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /必须与 --force 同时使用/);
		assert.equal(readFileSync(fixture.file, "utf8"), PRISTINE, "用法错时不得改文件");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("CLI：漂移 + --allow-drift --force 可强打，revert 用 .orig 原样恢复", () => {
	const fixture = makeFixture();
	const drift = `${PRISTINE}extra\n`; // hunk 区域外多一行：锚点可应用，但整文件哈希漂移
	try {
		writeFileSync(fixture.file, drift, "utf8");
		const args = ["--manifest", fixture.manifest, "--profile", fixture.profile, "--allow-drift", "--force"];

		let result = run(["--apply", ...args]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /强制打补丁/);
		assert.equal(readFileSync(fixture.file, "utf8"), `${PATCHED}extra\n`);
		assert.ok(existsSync(`${fixture.file}.orig`), "强打也应留 .orig");

		result = run(["--revert", ...args]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stderr, /从 \.orig 恢复/);
		assert.equal(readFileSync(fixture.file, "utf8"), drift);
		assert.ok(!existsSync(`${fixture.file}.orig`), "恢复后应删除 .orig");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("selfcheck：未打补丁只告警、退出 0、不改文件", () => {
	const fixture = makeFixture();
	try {
		const result = runSelfcheck(["--manifest", fixture.manifest, "--node-modules", join(fixture.profile, "node_modules")]);
		assert.equal(result.status, 0, "自检只告警，永不阻塞");
		assert.match(result.stderr, /L2 补丁未就绪/);
		assert.match(result.stderr, /未打补丁/);
		assert.match(result.stderr, /--apply/);
		assert.equal(readFileSync(fixture.file, "utf8"), PRISTINE);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("selfcheck：已打补丁时静默通过", () => {
	const fixture = makeFixture();
	try {
		const nodeModules = join(fixture.profile, "node_modules");
		const applied = run(["--apply", "--manifest", fixture.manifest, "--node-modules", nodeModules]);
		assert.equal(applied.status, 0, applied.stderr);

		const result = runSelfcheck(["--manifest", fixture.manifest, "--node-modules", nodeModules]);
		assert.equal(result.status, 0);
		assert.equal(result.stderr, "");
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
