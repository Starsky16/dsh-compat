/**
 * dsh-compat · 宿主树探测（零依赖，CLI 与 host 半区共用）。
 *
 * 为什么单独成文件：`bin/patch.mjs` 与 `bin/selfcheck.mjs` 也要自动找宿主树，
 * 而 `lib/l2.mjs` 依赖 `bin/patch.mjs` 的 `inspect`——若反过来 import 会形成环。
 * 这里只做「目录长什么样」的判定，不碰 manifest、不读补丁。
 *
 * 探测原则（2026-11-22 重写，修 Termux-only 假设）：
 *  - dsh 的安装形态随环境而异：Termux 的 `dsh-termux/node_modules`、DSHBox 的
 *    `/opt/dshapp/runtime/node_modules`、npm 全局装的 `@deepseek-ai/*`、源码跑……
 *    旧实现只认第一种，其余环境一律 `skip`，L2 自检与 doctor 静默失效。
 *  - 判据不靠「目录长得像」，而是**该 node_modules 下真的有
 *    `@deepseek-ai/dsh-client-modules`**（L2 的唯一目标包）。命中即用，不命中换下一个。
 *  - 信号按可靠度排序：显式 env → 宿主安装目录 → 进程入口脚本 → 平台默认根 → 自身位置。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** L2 的唯一目标包；它的存在即「这是一棵可打补丁的宿主树」。 */
export const TARGET_PKG = "@deepseek-ai/dsh-client-modules";

/** 该目录下是否有 L2 目标包。 */
export function hasTargetPkg(nodeModules) {
	try {
		return statSync(join(nodeModules, TARGET_PKG)).isDirectory();
	} catch {
		return false;
	}
}

/** 从一个路径出发，向上找最近的名为 node_modules 的祖先（含自身）。 */
function nearestNodeModules(from) {
	let dir = resolve(from);
	try {
		if (!statSync(dir).isDirectory()) dir = dirname(dir);
	} catch {
		return null;
	}
	for (;;) {
		if (dir.endsWith(`${sep}node_modules`) || dir === "node_modules") return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 按优先级列出候选 node_modules 目录（**不判定是否存在**，便于调试与测试）。
 * @param {Record<string,string|undefined>} [env]
 * @param {{argv?: string[], platform?: string}} [opts]
 * @returns {string[]}
 */
export function candidateNodeModulesList(env = process.env, { argv = process.argv, platform = process.platform } = {}) {
	if (env.DSH_COMPAT_DISABLE_L2_SELFCHECK === "1") return [];
	const list = [];
	const push = (dir) => {
		if (!dir) return;
		const abs = resolve(dir);
		if (!list.includes(abs)) list.push(abs);
	};

	// ① 显式覆盖：DSH_COMPAT_NM 就是 node_modules 根
	push(env.DSH_COMPAT_NM);

	// ② 宿主安装目录：dsh 包目录 / 其 node_modules / 任意含 node_modules 的祖先
	if (env.DSH_INSTALL_DIR) {
		const install = resolve(env.DSH_INSTALL_DIR);
		push(install);
		push(nearestNodeModules(install));
		push(join(install, "node_modules"));
	}

	// ③ 进程入口脚本（dsh 的 lib/bin.js）向上推导
	const entry = argv?.[1];
	if (typeof entry === "string" && entry.length > 0) {
		push(nearestNodeModules(entry));
		push(join(dirname(resolve(entry)), "node_modules"));
	}

	// ④ 平台默认根：Termux 的 PREFIX 优先，其次标准 npm -g 根
	const roots = [];
	if (env.PREFIX) roots.push(join(env.PREFIX, "lib", "node_modules"));
	if (platform !== "android" && platform !== "win32") {
		roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
	}
	for (const root of roots) {
		// npm 全局直接装 @deepseek-ai/*：根本身即 node_modules
		push(root);
		// termux-dsh 的布局：根下 dsh-termux/node_modules
		push(join(root, "dsh-termux", "node_modules"));
	}

	// ⑤ 自身位置：本包若被装进某棵宿主树，向上就能找到它
	push(nearestNodeModules(HERE));

	return list;
}

/**
 * 探测实际可用的宿主 node_modules（含 L2 目标包）。找不到返回 null。
 * @param {Record<string,string|undefined>} [env]
 * @param {{argv?: string[], platform?: string}} [opts]
 */
export function candidateNodeModules(env = process.env, opts) {
	for (const dir of candidateNodeModulesList(env, opts)) {
		if (hasTargetPkg(dir)) return dir;
	}
	return null;
}

/** 旧名保留，语义 = candidateNodeModules。 */
export const defaultNodeModules = candidateNodeModules;

/**
 * 宿主版本：优先读 `@deepseek-ai/dsh`（任何安装形态），回退 dsh-termux 的产物版本。
 * @param {string|null} nodeModules
 * @returns {string|null}
 */
export function hostVersion(nodeModules) {
	if (!nodeModules) return null;
	const readVersion = (pkgDir) => {
		try {
			return JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? null;
		} catch {
			return null;
		}
	};
	// ① 宿主树里的 @deepseek-ai/dsh（官方 / DSHBox / npm 全局都适用）
	const official = readVersion(join(nodeModules, "@deepseek-ai", "dsh"));
	if (official) return official;
	// ② termux-dsh 的产物版本（nodeModules 的父目录）
	return readVersion(dirname(nodeModules));
}
