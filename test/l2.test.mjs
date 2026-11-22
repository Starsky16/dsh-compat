import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { candidateNodeModules, defaultNodeModules, l2Status, hostVersion } from "../lib/l2.mjs";
import { sha256 } from "../bin/patch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 合成一棵宿主树 + 一份只含 retired 字段的清单。 */
function fixture(contents, retiredSha) {
	const nm = mkdtempSync(join(tmpdir(), "dsh-l2-"));
	const lib = join(nm, "@deepseek-ai", "dsh-client-modules", "lib");
	mkdirSync(lib, { recursive: true });
	writeFileSync(join(lib, "client.js"), contents);
	const manifestPath = join(nm, "manifest.json");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			schema: 1,
			targets: [
				{
					id: "t",
					pkg: "@deepseek-ai/dsh-client-modules",
					rel: "lib/client.js",
					patch: "p.patch",
					create: false,
					pristine_sha256: sha256("pristine"),
					patched_sha256: sha256("patched"),
					retired: { upstream: "0.2.2-rc.3", sha256: retiredSha ?? sha256("retired") },
				},
			],
		}),
	);
	return { nm, manifestPath };
}

test("l2Status：retired 哈希优先于 drift", () => {
	const { nm, manifestPath } = fixture("retired");
	try {
		const status = l2Status({ nodeModules: nm, manifestPath });
		assert.equal(status.state, "retired");
		assert.equal(status.retired, true);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("l2Status：未知哈希仍是 drift", () => {
	const { nm, manifestPath } = fixture("something-else");
	try {
		assert.equal(l2Status({ nodeModules: nm, manifestPath }).state, "drift");
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("l2Status：没有宿主树时 state=skip", () => {
	assert.equal(l2Status({ nodeModules: null }).state, "skip");
});

test("hostVersion：从 dsh-termux/package.json 读取", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-l2-host-"));
	try {
		const nm = join(root, "dsh-termux", "node_modules");
		mkdirSync(nm, { recursive: true });
		writeFileSync(join(root, "dsh-termux", "package.json"), JSON.stringify({ version: "0.2.2-rc.3-tdsh.2" }));
		assert.equal(hostVersion(nm), "0.2.2-rc.3-tdsh.2");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("hostVersion：也能从宿主树里的 @deepseek-ai/dsh 读（非 dsh-termux 布局）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-l2-host2-"));
	try {
		const nm = join(root, "node_modules");
		const pkg = join(nm, "@deepseek-ai", "dsh");
		mkdirSync(pkg, { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" }));
		assert.equal(hostVersion(nm), "0.2.2-rc.5");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─────────── 宿主树探测：任何 Linux/Termux 安装形态都要命中 ───────────

/** 造一棵「像真的」node_modules：只放判定用的标记包。 */
function fakeTree(root, { marker = "@deepseek-ai/dsh-client-modules", version = "0.2.2-rc.5" } = {}) {
	const nm = join(root, "node_modules");
	mkdirSync(join(nm, marker, "lib"), { recursive: true });
	writeFileSync(join(nm, marker, "lib", "client.js"), "// tree marker\n");
	writeFileSync(join(nm, marker, "package.json"), JSON.stringify({ name: marker, version }));
	return nm;
}

test("candidateNodeModules：DSH_INSTALL_DIR 指向宿主包目录时，推导其 node_modules", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-nm-install-"));
	try {
		// 布局：<root>/node_modules/@deepseek-ai/dsh/{package.json,lib/bin.js}
		const nm = fakeTree(root);
		const pkg = join(nm, "@deepseek-ai", "dsh");
		mkdirSync(join(pkg, "lib"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" }));
		writeFileSync(join(pkg, "lib", "bin.js"), "// entry\n");
		assert.equal(candidateNodeModules({ DSH_INSTALL_DIR: pkg }), nm);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidateNodeModules：DSH_INSTALL_DIR 直接给 node_modules 根也认", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-nm-install2-"));
	try {
		const nm = fakeTree(root);
		assert.equal(candidateNodeModules({ DSH_INSTALL_DIR: nm }), nm);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidateNodeModules：从 argv[1]（dsh 入口脚本）向上推导宿主树", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-nm-argv-"));
	try {
		const nm = fakeTree(root);
		const pkg = join(nm, "@deepseek-ai", "dsh");
		mkdirSync(join(pkg, "lib"), { recursive: true });
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@deepseek-ai", version: "0.2.2-rc.5" }));
		const bin = join(pkg, "lib", "bin.js");
		writeFileSync(bin, "// entry\n");
		assert.equal(candidateNodeModules({}, { argv: [process.execPath, bin] }), nm);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidateNodeModules：Termux 的 PREFIX 布局仍命中（dsh-termux/node_modules）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-nm-termux-"));
	try {
		const nm = fakeTree(join(root, "lib", "node_modules", "dsh-termux"));
		assert.equal(candidateNodeModules({ PREFIX: root }), nm);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidateNodeModules：只认真正含 @deepseek-ai/dsh-client-modules 的树（不猜空目录）", () => {
	const root = mkdtempSync(join(tmpdir(), "dsh-nm-empty-"));
	try {
		// 有 dsh-termux/node_modules 但里面没有目标包 ⇒ 不算命中
		mkdirSync(join(root, "lib", "node_modules", "dsh-termux", "node_modules"), { recursive: true });
		assert.equal(candidateNodeModules({ PREFIX: root }), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("candidateNodeModules：WIN 桌面端仍不探测（app.asar 不可写）", () => {
	assert.equal(candidateNodeModules({}, { platform: "win32" }), null);
});

test("defaultNodeModules：本进程环境能自动找到宿主树（DSHBox / Termux 实况）", () => {
	// 这条不 mock：跑在真机上时必须命中，否则 L2 自检与 doctor 会静默失效
	const nm = defaultNodeModules();
	if (process.env.DSH_COMPAT_DISABLE_L2_SELFCHECK === "1") return;
	assert.ok(nm, "必须自动探测到宿主 node_modules（DSH_INSTALL_DIR / PREFIX / argv / 标准根）");
	assert.ok(existsSync(join(nm, "@deepseek-ai", "dsh-client-modules")), `${nm} 下应有 @deepseek-ai/dsh-client-modules`);
});

test("selfcheck：retired 不计入 issue（CLI 退出 0 且 ready）", () => {
	const { nm, manifestPath } = fixture("retired");
	try {
		const out = spawnSync(
			process.execPath,
			[join(ROOT, "bin/selfcheck.mjs"), "--node-modules", nm, "--manifest", manifestPath, "--json"],
			{ encoding: "utf8" },
		);
		const report = JSON.parse(out.stdout);
		assert.equal(report.ready, true);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("CLI：patch --check 无参时自动探测宿主树（不再默认 profile 树）", () => {
	const { nm, manifestPath } = fixture("retired");
	try {
		const out = spawnSync(process.execPath, [join(ROOT, "bin/patch.mjs"), "--check", "--manifest", manifestPath], {
			encoding: "utf8",
			env: { ...process.env, DSH_COMPAT_NM: nm },
		});
		assert.equal(out.status, 0, out.stdout + out.stderr);
		assert.match(out.stdout, /retire/);
		assert.doesNotMatch(out.stdout, /not installed/);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("CLI：selfcheck 无参时自动探测宿主树（retired 时静默）", () => {
	const { nm, manifestPath } = fixture("retired");
	try {
		const out = spawnSync(process.execPath, [join(ROOT, "bin/selfcheck.mjs"), "--manifest", manifestPath], {
			encoding: "utf8",
			env: { ...process.env, DSH_COMPAT_NM: nm },
		});
		assert.equal(out.status, 0);
		assert.equal(out.stderr, "", `不应误报：${out.stderr}`);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});

test("CLI：探测不到宿主树时 selfcheck 明确说「未找到」而不是「找不到目标」", () => {
	const out = spawnSync(process.execPath, [join(ROOT, "bin/selfcheck.mjs")], {
		encoding: "utf8",
		env: { ...process.env, DSH_COMPAT_NM: "", DSH_INSTALL_DIR: "", PREFIX: "", DSH_COMPAT_DISABLE_L2_SELFCHECK: "" },
	});
	assert.equal(out.status, 0);
	// 找不到树时要么静默（真机有树），要么给出「未找到宿主 node_modules」的明确提示
	assert.ok(out.stderr === "" || /未找到宿主 node_modules/.test(out.stderr), out.stderr);
	assert.doesNotMatch(out.stderr, /找不到目标/, "不应把「没找到树」说成「找不到目标包」");
});

test("CLI：显式 --profile 优先于自动探测（不被宿主树抢走）", () => {
	const { nm, manifestPath } = fixture("retired");
	try {
		// 自动探测会命中 nm（DSH_COMPAT_NM），但显式 --profile 指向空 profile ⇒ 应报 not installed
		const out = spawnSync(
			process.execPath,
			[join(ROOT, "bin/patch.mjs"), "--check", "--manifest", manifestPath, "--profile", join(nm, "empty-profile")],
			{ encoding: "utf8", env: { ...process.env, DSH_COMPAT_NM: nm } },
		);
		assert.match(out.stdout, /not installed/, out.stdout);
		assert.doesNotMatch(out.stdout, /retire/);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});
