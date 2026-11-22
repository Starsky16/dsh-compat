// test/doctor-core.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createDoctor, defaultProfileDir } from "../lib/doctor-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(ROOT, "test", "fixtures", "probe-profile");

test("createDoctor：fixture 四种判据（PASS / FAIL / WARN / os 映射）", () => {
	const doctor = createDoctor({ profileDir: PROBE, repoRoot: ROOT, platform: "linux", arch: "x64", env: {} });
	const rows = doctor.audit();
	const byName = Object.fromEntries(rows.map((r) => [r.name, r.verdict]));
	assert.equal(byName["dsh-good-plugin"], "PASS");
	assert.equal(byName["dsh-bad-plugin"], "FAIL");
	assert.equal(byName["dsh-os-mismatch"], "FAIL");
	assert.equal(byName["dsh-os-linux"], "PASS");
	assert.equal(byName["dsh-nomanifest"], "WARN");
});

test("defaultProfileDir：优先 web，其次 desktop", () => {
	assert.match(defaultProfileDir({ DSH_HOME: "/tmp/x" }), /profiles\/web$/);
});

test("hostTreeDirs：自动覆盖宿主树（DSH_INSTALL_DIR 推导 / PREFIX / 标准根），不靠平台硬编码", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-doctor-tree-"));
	try {
		// 布局同 DSHBox：<root>/node_modules/@deepseek-ai/dsh{,-client-modules}
		const nm = join(root, "node_modules");
		mkdirSync(join(nm, "@deepseek-ai", "dsh", "lib"), { recursive: true });
		mkdirSync(join(nm, "@deepseek-ai", "dsh-client-modules", "lib"), { recursive: true });
		writeFileSync(join(nm, "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" }));
		writeFileSync(join(nm, "@deepseek-ai", "dsh-client-modules", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-client-modules" }));

		const doctor = createDoctor({
			profileDir: PROBE,
			repoRoot: ROOT,
			platform: "linux",
			arch: "x64",
			env: { DSH_INSTALL_DIR: join(nm, "@deepseek-ai", "dsh") },
			argv: [process.execPath, join(nm, "@deepseek-ai", "dsh", "lib", "bin.js")],
		});
		assert.ok(doctor.hostTrees.includes(nm), `hostTrees 应含 ${nm}，实际 ${JSON.stringify(doctor.hostTrees)}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hostTreeDirs：显式 DSH_GLOBAL_TREE 优先且仍保留自动探测结果", () => {
	const doctor = createDoctor({
		profileDir: PROBE,
		repoRoot: ROOT,
		platform: "linux",
		arch: "x64",
		env: { DSH_GLOBAL_TREE: "/custom/nm" },
		argv: [],
	});
	assert.equal(doctor.hostTrees[0], "/custom/nm");
});

test("defaultProfileDir：DSH_PROFILE_DIR 优先（非 web/desktop 的自定义 profile 名）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-prof-"));
	try {
		const dir = join(root, "profiles", "compatverify");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "dsh-profile-compatverify" }));
		assert.equal(defaultProfileDir({ DSH_PROFILE_DIR: dir }), dir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("defaultProfileDir：DSH_PROFILE 指定名字时优先用它（即使 web 也存在）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-prof2-"));
	try {
		for (const name of ["web", "tui"]) {
			const dir = join(root, "profiles", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `dsh-profile-${name}` }));
		}
		assert.equal(defaultProfileDir({ DSH_HOME: root, DSH_PROFILE: "tui" }), join(root, "profiles", "tui"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("defaultProfileDir：都不存在时回落到 DSH_HOME/profiles/web（不抛错）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-prof3-"));
	try {
		assert.equal(defaultProfileDir({ DSH_HOME: root }), join(root, "profiles", "web"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
