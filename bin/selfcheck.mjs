#!/usr/bin/env node
/**
 * dsh-compat · L2 启动自检（T7）
 *
 * 只告警、不改文件、不阻塞启动：把 manifest 里的补丁目标按 sha256 校验一遍，
 * 发现「未打补丁 / 漂移 / 目标缺失」就在 stderr 大声提示；退出码恒为 0。
 *
 * 设计取舍（2026-11-01 用户拍板）：自检只告警，不自动重打、不拒绝启动——
 * 升级 dsh 后全局树补丁会被覆盖，这里负责让人看见，重打仍由 `bin/patch.mjs --apply` 决定。
 *
 * 用法：
 *   node bin/selfcheck.mjs [--node-modules <dir> | --profile <name|path>] [--json]
 *
 *   --node-modules 直接指定 node_modules 根（Termux 全局树用）；与 --profile 同给时优先
 *   --profile      profile 名或绝对路径（默认 $DSH_HOME/profiles/web）
 *   --json         机读输出
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expandHome, inspect, readManifest, resolveProfile } from "./patch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_MANIFEST = join(ROOT, "patches", "compat", "manifest.json");

const args = process.argv.slice(2);
let nodeModulesArg;
let profileArg;
let manifestPath = DEFAULT_MANIFEST;
let json = false;
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--json") json = true;
	else if (arg === "--manifest") {
		manifestPath = args[++i];
		if (manifestPath === undefined) {
			process.stderr.write("[dsh-compat] --manifest 需要一个值\n");
			process.exit(0);
		}
	} else if (arg === "--profile") {
		profileArg = args[++i];
		if (profileArg === undefined) {
			process.stderr.write("[dsh-compat] --profile 需要一个值\n");
			process.exit(0);
		}
	} else if (arg === "--node-modules") {
		nodeModulesArg = args[++i];
		if (nodeModulesArg === undefined) {
			process.stderr.write("[dsh-compat] --node-modules 需要一个值\n");
			process.exit(0);
		}
	} else if (arg === "-h" || arg === "--help") {
		process.stdout.write(`dsh-compat · L2 启动自检（只告警）

用法：node bin/selfcheck.mjs [--node-modules <dir> | --profile <name|path>] [--json]
`);
		process.exit(0);
	} else {
		process.stderr.write(`[dsh-compat] 未知参数：${arg}\n`);
		process.exit(0);
	}
}

const nodeModules =
	nodeModulesArg === undefined
		? join(resolveProfile(profileArg), "node_modules")
		: resolve(expandHome(nodeModulesArg));

let manifest;
try {
	manifest = readManifest(manifestPath);
} catch (error) {
	process.stderr.write(`[dsh-compat] L2 自检读不了清单 ${manifestPath}：${error.message}\n`);
	process.exit(0);
}

const issues = [];
const rows = [];
for (const target of manifest.targets) {
	const info = inspect(target, nodeModules);
	rows.push({ id: target.id, pkg: target.pkg, rel: target.rel, state: info.state, why: info.why });
	if (info.state === "patched") continue;
	const label =
		info.state === "skip"
			? "找不到目标（该 node_modules 下没有这个包）"
			: info.state === "pristine"
				? "未打补丁"
				: info.why;
	issues.push(`${target.pkg}/${target.rel}  ${label}`);
}
const ready = issues.length === 0;

if (json) {
	process.stdout.write(`${JSON.stringify({ nodeModules, ready, rows }, null, "\t")}\n`);
} else if (!ready) {
	process.stderr.write("[dsh-compat] L2 补丁未就绪：\n");
	for (const issue of issues) process.stderr.write(`  - ${issue}\n`);
	process.stderr.write(`[dsh-compat] 查看：node ${join(ROOT, "bin", "patch.mjs")} --check --node-modules ${nodeModules}\n`);
	process.stderr.write(`[dsh-compat] 重打：node ${join(ROOT, "bin", "patch.mjs")} --apply --node-modules ${nodeModules}\n`);
}

// 只告警：永不返回非 0，避免把启动链拖死。
process.exit(0);
