/**
 * dsh-compat · L3 客户端垫片（plans Task 3 / T3）
 *
 * 纯 host 注入、无 client 半区：
 *  - polyfill 脚本 prepend（抢在主题脚本之前执行）；
 *  - 全局 CSS 不 prepend（按 spike §5 实测结论落在 boot style 之后，后写覆盖主题 token）；
 *  - 激活时内嵌 T7 方案 C 的 L2 自检（只告警，与 bin/selfcheck.mjs 同判据），
 *    作为 T7B wrapper 之外的第二道兜底。
 *
 * ⚠️ 本包不得声明 `dsh.client`：宿主 client 入口读 `pkg.exports["./client"]`，
 * 声明 web 平台而没有该导出会在宿主服务端组合期抛 ClientPackageCompositionError
 * （spike 已实证，2026-10-28）。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, readManifest } from "../bin/patch.mjs";
import { POLYFILLS } from "./polyfills.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_MANIFEST = join(ROOT, "patches", "compat", "manifest.json");
const TAG = "[dsh-compat]";

const read = (name) => readFileSync(join(ROOT, "css", name), "utf8");

/**
 * 探测 L2 补丁的目标全局树（普适化：任何装了 dsh-termux 的环境都可用）。
 *
 * 候选根（按序）：
 *  1. `$PREFIX/lib/node_modules` —— Termux（android）与任何设了 PREFIX 的环境；
 *     Termux 的 npm 全局根正是这个位置，零配置命中。
 *  2. `/usr/local/lib/node_modules` —— macOS / 源码安装 Node 的 npm -g 默认根。
 *  3. `/usr/lib/node_modules` —— 发行版 Node 的 npm -g 默认根。
 *
 * 每个候选下找 `dsh-termux/node_modules` 目录；都不存在就返回 null
 * （静默跳过 L2 自检，不影响插件其余功能）。WIN 桌面端 dsh 核心在
 * app.asar 内不可写，L2 不适用，直接不探测。
 * `DSH_COMPAT_NM` 显式指定永远优先；`DSH_COMPAT_DISABLE_L2_SELFCHECK=1` 整体关闭。
 */
export function nodeModuleCandidateRoots(env = process.env, platform = process.platform) {
	if (platform === "win32") return [];
	const roots = [];
	if (env.PREFIX) roots.push(join(env.PREFIX, "lib", "node_modules"));
	if (platform !== "android") {
		// Termux 的候选已由 PREFIX 覆盖；其它平台补标准 npm -g 根
		roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
	}
	return [...new Set(roots)];
}

export function defaultNodeModules(env = process.env) {
	if (env.DSH_COMPAT_NM) return env.DSH_COMPAT_NM;
	if (env.DSH_COMPAT_DISABLE_L2_SELFCHECK === "1") return null;
	for (const root of nodeModuleCandidateRoots(env)) {
		const nm = join(root, "dsh-termux", "node_modules");
		try {
			if (statSync(nm).isDirectory()) return nm;
		} catch { /* 候选不存在，看下一个 */ }
	}
	return null;
}

/**
 * T7 方案 C：L2 自检（只告警，不改文件、不阻塞启动）。
 * 判据与 bin/selfcheck.mjs 完全一致：manifest 里的目标 sha256 不为 patched 就报。
 * @param {string} nodeModules
 * @param {string} [manifestPath] 默认用仓库内置清单；测试可传合成清单
 * @returns {{ issues: string[], nodeModules: string }}
 */
export function l2Selfcheck(nodeModules, manifestPath = DEFAULT_MANIFEST) {
	const manifest = readManifest(manifestPath);
	const issues = [];
	for (const target of manifest.targets) {
		const info = inspect(target, nodeModules);
		if (info.state === "patched") continue;
		const label =
			info.state === "skip"
				? "找不到目标（该 node_modules 下没有这个包）"
				: info.state === "pristine"
					? "未打补丁"
					: info.why;
		issues.push(`${target.pkg}/${target.rel}  ${label}`);
	}
	return { issues, nodeModules };
}

/** @param {import("@deepseek-ai/cordis").Context} ctx */
export function apply(ctx) {
	const style = [
		{ kind: "style", text: read("opaque.css") },
		{ kind: "style", text: read("perf.css") },
	];

	// 脚本要早：prepend 抢在主题脚本之前；样式要晚（覆盖主题）：不 prepend。
	// 顺序依据 spike §5：prepend 监听插到队首 ⇒ 脚本行排最前；
	// 普通 push 监听排在 host 注入之后 ⇒ 样式行排最后（后写覆盖）。
	ctx.on("webserver/index-inject", (table) => {
		table.push({ kind: "script", placement: "body", text: POLYFILLS });
	}, { prepend: true });
	ctx.on("webserver/index-inject", (table) => {
		table.push(...style);
	});

	// T7 方案 C：激活时自检一次 L2（只告警）。
	try {
		const nodeModules = defaultNodeModules();
		if (!nodeModules) return;
		const { issues } = l2Selfcheck(nodeModules);
		if (issues.length === 0) return;
		process.stderr.write(`${TAG} L2 补丁未就绪（L3 激活自检，只告警）：\n`);
		for (const issue of issues) process.stderr.write(`  - ${issue}\n`);
		process.stderr.write(`${TAG} 重打：node ${join(ROOT, "bin", "patch.mjs")} --apply --node-modules ${nodeModules}\n`);
	} catch (error) {
		process.stderr.write(`${TAG} L2 自检失败（忽略，不影响启动）：${error?.message ?? error}\n`);
	}
}
