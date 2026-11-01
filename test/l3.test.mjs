import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readManifest, sha256 } from "../bin/patch.mjs";
import { apply, defaultNodeModules, l2Selfcheck, nodeModuleCandidateRoots } from "../lib/index.js";
import { POLYFILLS } from "../lib/polyfills.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MANIFEST = readManifest(join(ROOT, "patches", "compat", "manifest.json"));

const text = (p) => readFileSync(p, "utf8");

test("POLYFILLS 是非空脚本且不含 </script", () => {
	assert.equal(typeof POLYFILLS, "string");
	assert.ok(POLYFILLS.trim().length > 0);
	assert.ok(!POLYFILLS.includes("</script"), "script 行 text 不得包含 </script");
	assert.ok(POLYFILLS.includes("[dsh-compat]"));
});

test("POLYFILLS 只补缺失：randomUUID 与 AbortSignal.any 都有守卫", () => {
	assert.match(POLYFILLS, /typeof crypto\.randomUUID === "function"/);
	assert.match(POLYFILLS, /typeof AbortSignal\.any !== "function"/);
	// perf 开关走 matchMedia coarse pointer 判定
	assert.match(POLYFILLS, /pointer:\s*coarse/);
	assert.match(POLYFILLS, /dshCompatPerf/);
});

test("nodeModuleCandidateRoots：候选根按平台一般化（win 不探测 / PREFIX 优先 / 标准 npm -g 根）", () => {
	// WIN 桌面端 dsh 核心在 app.asar 内不可写，L2 不适用 → 不探测
	assert.deepEqual(nodeModuleCandidateRoots({}, "win32"), []);
	// Termux：PREFIX 即 npm -g 根，零配置命中
	assert.deepEqual(nodeModuleCandidateRoots({ PREFIX: "/x" }, "android"), ["/x/lib/node_modules"]);
	// 标准 Linux/macOS：无 PREFIX 时补两个标准根
	assert.deepEqual(nodeModuleCandidateRoots({}, "linux"), [
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	]);
	// 有 PREFIX 的非 android（如自设 PREFIX 的容器）：PREFIX 在前，标准根兜底
	assert.deepEqual(nodeModuleCandidateRoots({ PREFIX: "/x" }, "linux"), [
		"/x/lib/node_modules",
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
	]);
});

test("defaultNodeModules：显式 env 优先；合成 PREFIX 树命中；无任何 dsh 树时静默 null", () => {
	// DSH_COMPAT_NM 显式指定永远优先
	assert.equal(defaultNodeModules({ DSH_COMPAT_NM: "/data/local/tmp/nm" }), "/data/local/tmp/nm");
	// 禁用开关压过一切
	assert.equal(
		defaultNodeModules({ DSH_COMPAT_DISABLE_L2_SELFCHECK: "1", PREFIX: "/data/data/com.termux/files/usr" }),
		null,
	);

	// 合成 PREFIX 树：候选根下存在 dsh-termux/node_modules 就命中（任何平台）
	const fake = mkdtempSync(join(tmpdir(), "dsh-compat-nm-"));
	try {
		const fakeNm = join(fake, "lib", "node_modules", "dsh-termux", "node_modules");
		mkdirSync(fakeNm, { recursive: true });
		assert.equal(defaultNodeModules({ PREFIX: fake }), fakeNm);
	} finally {
		rmSync(fake, { recursive: true, force: true });
	}

	// 本机实况：android 无 PREFIX → 无候选根 → null（不猜）
	if (process.platform === "android") {
		assert.equal(defaultNodeModules({}), null);
		assert.equal(
			defaultNodeModules({ PREFIX: "/data/data/com.termux/files/usr" }),
			"/data/data/com.termux/files/usr/lib/node_modules/dsh-termux/node_modules",
		);
	}
});

test("apply 接线：脚本 prepend、样式不 prepend，行形态符合 rc.5 契约", () => {
	const calls = [];
	const handlers = [];
	const ctx = {
		on(event, fn, opts) {
			calls.push({ event, prepend: opts?.prepend === true });
			handlers.push(fn);
		},
	};
	apply(ctx);

	assert.deepEqual(
		calls.map((c) => c.event),
		["webserver/index-inject", "webserver/index-inject"],
	);
	assert.equal(calls[0].prepend, true, "polyfill 脚本要抢在主题脚本之前");
	assert.equal(calls[1].prepend, false, "样式要落在 boot style 之后（后写覆盖）");

	// 脚本行：kind=script + placement=body（rc.5 里 script 必须带 placement）
	const scriptTable = [];
	handlers[0](scriptTable);
	assert.equal(scriptTable.length, 1);
	assert.equal(scriptTable[0].kind, "script");
	assert.equal(scriptTable[0].placement, "body");
	assert.equal(scriptTable[0].text, POLYFILLS);

	// 样式行：kind=style 且不带 placement（rc.5 的 style 形态没有该字段）
	const styleTable = [];
	handlers[1](styleTable);
	assert.deepEqual(styleTable.map((r) => r.kind), ["style", "style"]);
	for (const row of styleTable) {
		assert.ok(!("placement" in row), "style 行不应带 placement 字段");
		assert.ok(!row.text.includes("</style"), "style 行 text 不得包含 </style");
	}
	assert.match(styleTable[0].text, /--dsw-specific-menu/, "第一行是 opaque.css");
	assert.match(styleTable[1].text, /data-dsh-compat-perf/, "第二行是 perf.css");
});

test("opaque.css 补齐缺失 token（两个都要定义）且不依赖 !important", () => {
	const css = text(join(ROOT, "css", "opaque.css")).replace(/\/\*[\s\S]*?\*\//g, "");
	// 真机核实（2026-11-01）：specific-menu 与 menu-surface-fill 在宿主 CSS 里只有使用、没有定义
	assert.match(css, /--dsw-menu-surface-fill:\s*#[0-9a-fA-F]+/);
	assert.match(css, /--dsw-specific-menu:\s*var\(--dsw-menu-surface-fill/);
	// 深色模式变体
	assert.match(css, /prefers-color-scheme:\s*dark/);
	assert.ok(!css.includes("!important"), "后写覆盖成立时不需要 !important");
});

test("perf.css 每条规则都限定在 perf 开关属性下", () => {
	const css = text(join(ROOT, "css", "perf.css"));
	const noComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const m of noComment.matchAll(/([^{}]+)\{/g)) {
		const selector = m[1].trim();
		assert.match(selector, /\[data-dsh-compat-perf="1"\]/, `选择器必须限定在开关属性下：${selector}`);
	}
});

test("包不得声明 client 半区（dsh.client / exports[\"./client\"]），否则宿主组合期抛 ClientPackageCompositionError", () => {
	const pkg = JSON.parse(text(join(ROOT, "package.json")));
	assert.equal(pkg.main, "lib/index.js");
	// bundle 层声明是必需的（否则 dsh plugin add 只当普通依赖、不进 loader）
	assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
	// 但 client 半区声明绝对不能有：无 ./client 导出却声明 web 平台 = 服务端组合期抛错
	assert.ok(pkg.dsh?.client === undefined, "不得声明 dsh.client");
	const exportsMap = pkg.exports ?? {};
	assert.ok(exportsMap["./client"] === undefined, "不得有 exports[\"./client\"]");
	// bundle patch 文件存在且是 - insert: 行（挂载 host 半区）
	const patchText = text(join(ROOT, pkg.dsh.bundle.patch.replace(/^\.\//, "")));
	assert.match(patchText, /- insert:/);
	assert.match(patchText, /id: dsh-compat/);
});

test("l2Selfcheck：缺失 / pristine / patched 三态（合成夹具）", () => {
	const target = MANIFEST.targets[0];
	const nm = mkdtempSync(join(tmpdir(), "dsh-compat-l3-"));
	const manifestPath = join(nm, "manifest.json");
	const clientFile = join(nm, target.pkg, target.rel);
	try {
		// 合成清单：rel 指向合成文件，哈希对换成合成字节的已知值
		const pristineBytes = "dsh-compat-fixture-pristine\n";
		const patchedBytes = "dsh-compat-fixture-patched\n";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				...MANIFEST,
				targets: [{
					...target,
					rel: "lib/dummy.js",
					pristine_sha256: sha256(pristineBytes),
					patched_sha256: sha256(patchedBytes),
				}],
			}),
		);
		const dummy = join(nm, target.pkg, "lib/dummy.js");

		// 缺失 → skip（找不到目标）
		let r = l2Selfcheck(nm, manifestPath);
		assert.equal(r.issues.length, 1);
		assert.match(r.issues[0], /找不到目标/);
		assert.equal(r.nodeModules, nm);

		// pristine → 未打补丁
		mkdirSync(dirname(dummy), { recursive: true });
		writeFileSync(dummy, pristineBytes);
		r = l2Selfcheck(nm, manifestPath);
		assert.equal(r.issues.length, 1);
		assert.match(r.issues[0], /未打补丁/);

		// patched → 无问题
		writeFileSync(dummy, patchedBytes);
		r = l2Selfcheck(nm, manifestPath);
		assert.deepEqual(r.issues, []);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});
