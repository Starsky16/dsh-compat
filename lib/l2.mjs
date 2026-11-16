/**
 * dsh-compat · L2 状态（host 半区 / doctor / selfcheck 共用）。
 *
 * 只读：不写文件、不执行补丁，只根据 manifest 的哈希锚点判定目标当前处于
 * （pristine / patched / retired / drift / skip）哪一态，并探测宿主全局树位置。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, readManifest } from "../bin/patch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = resolve(HERE, "..", "patches", "compat", "manifest.json");

/** dsh-termux 的版本（nodeModules 的父目录）；读不到返回 null。 */
export function hostVersion(nodeModules) {
	if (!nodeModules) return null;
	try {
		return JSON.parse(readFileSync(join(dirname(nodeModules), "package.json"), "utf8")).version ?? null;
	} catch {
		return null;
	}
}

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
 * L2 补丁的当前状态。
 * @param {{nodeModules?: string|null, manifestPath?: string}} [options]
 * @returns {{anchor:string|null, state:string, why:string, retired:boolean, sha256:string|null, file:string|null}}
 */
export function l2Status({ nodeModules, manifestPath } = {}) {
	const manifest = readManifest(manifestPath ?? DEFAULT_MANIFEST);
	const target = manifest.targets[0];
	const anchor = manifest.base?.upstream ?? null;
	if (!nodeModules) {
		return { anchor, state: "skip", why: "未找到宿主树", retired: false, sha256: null, file: null };
	}
	const info = inspect(target, nodeModules);
	const retired = info.state === "retired";
	return {
		anchor,
		state: retired ? "retired" : info.state,
		why: retired ? info.why : (info.why ?? ""),
		retired,
		sha256: info.got ?? null,
		file: info.file ?? null,
	};
}
