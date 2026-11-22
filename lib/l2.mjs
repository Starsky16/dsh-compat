import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, readManifest } from "../bin/patch.mjs";
import { candidateNodeModules, hostVersion } from "./host-tree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = resolve(HERE, "..", "patches", "compat", "manifest.json");

// 宿主树探测（candidateNodeModules / candidateNodeModulesList / defaultNodeModules /
// hostVersion / hasTargetPkg）在 lib/host-tree.mjs：CLI 也要用，且不能反向依赖本文件。
export {
	candidateNodeModules,
	candidateNodeModulesList,
	defaultNodeModules,
	hasTargetPkg,
	hostVersion,
	TARGET_PKG,
} from "./host-tree.mjs";

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
