import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readManifest, sha256 } from "../bin/patch.mjs";
import { apply, buildCompatStatus, candidateNodeModules, candidateNodeModulesList, defaultNodeModules, l2Selfcheck } from "../lib/index.js";
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
	assert.ok(!POLYFILLS.includes("dshCompatMenu"), "菜单不透明是锁定行为，脚本不再落切换属性");
});

test("candidateNodeModulesList：候选根按信号排序（win 不探测 / 显式 env 优先 / PREFIX 与标准根兜底）", () => {
	// WIN 桌面端 dsh 核心在 app.asar 内不可写，L2 不适用 → 不探测
	assert.deepEqual(candidateNodeModulesList({}, { argv: [], platform: "win32" }), []);
	// Termux：PREFIX 即 npm -g 根，且 termux-dsh 布局的子树也在候选里
	const termux = candidateNodeModulesList({ PREFIX: "/x" }, { argv: [], platform: "android" });
	assert.equal(termux[0], "/x/lib/node_modules");
	assert.ok(termux.includes("/x/lib/node_modules/dsh-termux/node_modules"));
	// 标准 Linux/macOS：补两个标准根
	const linux = candidateNodeModulesList({}, { argv: [], platform: "linux" });
	assert.ok(linux.includes("/usr/local/lib/node_modules"));
	assert.ok(linux.includes("/usr/lib/lib/node_modules") === false);
	assert.ok(linux.includes("/usr/lib/node_modules"));
	// 显式 DSH_COMPAT_NM 永远排第一
	const explicit = candidateNodeModulesList({ DSH_COMPAT_NM: "/data/local/tmp/nm" }, { argv: [], platform: "linux" });
	assert.equal(explicit[0], "/data/local/tmp/nm");
});

test("candidateNodeModules：显式 env 优先；合成树命中；无目标包时静默 null", () => {
	// DSH_COMPAT_NM 显式指定永远优先（但要求该树下真有目标包）
	const fake = mkdtempSync(join(tmpdir(), "dsh-compat-nm-"));
	try {
		const fakeNm = join(fake, "lib", "node_modules", "dsh-termux", "node_modules");
		mkdirSync(join(fakeNm, "@deepseek-ai", "dsh-client-modules", "lib"), { recursive: true });
		assert.equal(candidateNodeModules({ PREFIX: fake }, { argv: [], platform: "linux" }), fakeNm);
		assert.equal(candidateNodeModules({ DSH_COMPAT_NM: fakeNm }, { argv: [], platform: "linux" }), fakeNm);
	} finally {
		rmSync(fake, { recursive: true, force: true });
	}
	// 禁用开关压过一切
	assert.equal(
		candidateNodeModules({ DSH_COMPAT_DISABLE_L2_SELFCHECK: "1", PREFIX: "/data/data/com.termux/files/usr" }),
		null,
	);
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
		["webserver/index-inject", "webserver/index-inject", "webserver/index-inject"],
	);
	assert.equal(calls[0].prepend, true, "polyfill 脚本要抢在主题脚本之前");
	assert.equal(calls[1].prepend, false, "样式要落在 boot style 之后（后写覆盖）");
	assert.equal(calls[2].prepend, false, "状态脚本按普通顺序追加即可");

	// 脚本行：kind=script + placement=body（rc.5 里 script 必须带 placement）
	const scriptTable = [];
	handlers[0](scriptTable);
	assert.equal(scriptTable.length, 1);
	assert.equal(scriptTable[0].kind, "script");
	assert.equal(scriptTable[0].placement, "body");
	assert.equal(scriptTable[0].text, POLYFILLS);

	// 状态脚本：第三条监听，只追加一行 script
	const statusTable = [];
	handlers[2](statusTable);
	assert.equal(statusTable.length, 1);
	assert.equal(statusTable[0].kind, "script");
	assert.equal(statusTable[0].placement, "body");
	assert.match(statusTable[0].text, /__DSH_COMPAT_STATUS__/);

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

test("opaque.css：用 !important 把菜单材质锁死为不透明（宿主后注入 / darwin 高特异性都压得住）", () => {
	const css = text(join(ROOT, "css", "opaque.css")).replace(/\/\*[\s\S]*?\*\//g, "");
	// 两个 token 都要给不透明值（含深色变体），且都是 !important
	assert.match(css, /--dsw-menu-surface-fill:\s*#[0-9a-fA-F]+\s*!important/);
	assert.match(css, /--dsw-specific-menu:\s*var\(--dsw-menu-surface-fill[^;]*!important/);
	assert.match(css, /body\[data-ds-dark-theme\]\s*\{[^}]*!important/);
	// 模糊一并关掉（不透明底色下没有意义，还费合成）
	assert.match(css, /--dsw-menu-backdrop-filter:\s*none\s*!important/);
	// 不再有属性门控 / :root / 客户端开关残留
	assert.doesNotMatch(css, /data-dsh-compat-menu/);
	assert.doesNotMatch(css, /html\[/);
	assert.doesNotMatch(css, /:root/);
});

test("perf.css 每条规则都限定在 perf 开关属性下", () => {
	const css = text(join(ROOT, "css", "perf.css"));
	const noComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const m of noComment.matchAll(/([^{}]+)\{/g)) {
		const selector = m[1].trim();
		assert.match(selector, /\[data-dsh-compat-perf="1"\]/, `选择器必须限定在开关属性下：${selector}`);
	}
});

test("client 半区声明成对：dsh.client 与 exports[\"./client\"] 必须同时存在", () => {
	const pkg = JSON.parse(text(join(ROOT, "package.json")));
	assert.equal(pkg.main, "lib/index.js");
	// bundle 层声明是必需的（否则 dsh plugin add 只当普通依赖、不进 loader）
	assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
	assert.equal(pkg.dsh?.client?.platform, "web");
	assert.equal(pkg.exports?.["./client"]?.default, "./lib/client.js");
	assert.ok(existsSync(join(ROOT, "lib", "client.js")), "client 半区文件必须存在");
	// bundle patch 文件存在且是 - insert: 行（挂载 host 半区）
	const patchText = text(join(ROOT, pkg.dsh.bundle.patch.replace(/^\.\//, "")));
	assert.match(patchText, /- insert:/);
	assert.match(patchText, /id: dsh-compat/);
});

test("package：engines.dsh 声明 >=0.2.1-rc.3（不设上界）", () => {
	const pkg = JSON.parse(text(join(ROOT, "package.json")));
	assert.equal(pkg.engines?.dsh, ">=0.2.1-rc.3");
});

test("l2Selfcheck：缺失 / pristine / patched / retired 四态（合成夹具）", () => {
	const target = MANIFEST.targets[0];
	const nm = mkdtempSync(join(tmpdir(), "dsh-compat-l3-"));
	const manifestPath = join(nm, "manifest.json");
	try {
		// 合成清单：rel 指向合成文件，哈希对换成合成字节的已知值
		const pristineBytes = "dsh-compat-fixture-pristine\n";
		const patchedBytes = "dsh-compat-fixture-patched\n";
		const retiredBytes = "dsh-compat-fixture-retired\n";
		writeFileSync(
			manifestPath,
			JSON.stringify({
				...MANIFEST,
				targets: [{
					...target,
					rel: "lib/dummy.js",
					pristine_sha256: sha256(pristineBytes),
					patched_sha256: sha256(patchedBytes),
					retired: { upstream: "0.2.2-rc.3", sha256: sha256(retiredBytes) },
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

		// retired → 无问题（上游已无需补丁）
		writeFileSync(dummy, retiredBytes);
		r = l2Selfcheck(nm, manifestPath);
		assert.deepEqual(r.issues, []);
	} finally {
		rmSync(nm, { recursive: true, force: true });
	}
});


test("apply：注入 __DSH_COMPAT_STATUS__（含 L2 与插件结论）且转义 </script>", () => {
	const handlers = [];
	const ctx = { on(event, fn) { handlers.push(fn); } };
	apply(ctx);
	const table = [];
	for (const handler of handlers) handler(table);
	const script = table.find((row) => row.kind === "script" && row.text.includes("__DSH_COMPAT_STATUS__"));
	assert.ok(script, "必须注入状态全局");
	assert.ok(!script.text.includes("</script>"), "注入内容不得提前闭合 script");
	assert.equal(script.placement, "body");
});

test("buildCompatStatus：结构含 host/l2/plugins，且 JSON 可序列化", () => {
	const status = buildCompatStatus();
	assert.equal(typeof status.host.version === "string" || status.host.version === null, true);
	assert.ok(["retired", "patched", "pristine", "drift", "skip"].includes(status.l2.state));
	assert.ok(Array.isArray(status.plugins));
	for (const row of status.plugins) {
		assert.equal(typeof row.name, "string");
		assert.equal(typeof row.verdict, "string");
	}
});
