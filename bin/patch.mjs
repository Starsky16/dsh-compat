#!/usr/bin/env node
/**
 * dsh-compat · L2 兼容补丁管理器
 *
 * 给 `@deepseek-ai/dsh-client-modules/lib/client.js` 打上
 * 「单插件加载失败不连坐整页」补丁（毒化代理 + `start()` 逐条目 catch + audit 前清 FAILED）。
 *
 * 目标寻址：
 *   --profile <name|path>   <profile>/node_modules/...（默认 $DSH_HOME/profiles/web）
 *   --node-modules <dir>    直接指定 node_modules 根；Termux 用全局树：
 *     node bin/patch.mjs --apply --node-modules "$(npm root -g)/dsh-termux/node_modules"
 *   （Termux 实测全新 profile 不物化 @deepseek-ai/*，宿主直走全局树；见 README）
 *
 * 设计取舍：
 * - 补丁文件是标准 unified diff，供人审阅，也可用 `git apply` 兜底；
 * - 应用由本脚本自己解析 hunk 逐行替换，不依赖 `patch` / `git apply`——
 *   WIN 上实测 `git apply` 会按 `core.autocrlf` 把 LF 写成 CRLF，哈希漂移；
 * - 任何一步不匹配都拒绝，绝不产生半套补丁；
 * - 写文件走「同目录临时文件 + rename」，不写穿 pnpm 的硬链接/软链，
 *   也不污染共享 store；打补丁前留下 `<file>.orig`，回滚后删除。
 *
 * 用法：
 *   node bin/patch.mjs [--check|--apply|--revert] [--profile <name|path> | --node-modules <dir>] [--json]
 *
 *   --check        默认；只报告。有漂移、或补丁尚未应用时退出码 1
 *   --apply        打补丁；存在漂移时整体拒绝（不半套）
 *   --revert       回滚为 pristine；存在漂移时整体拒绝
 *   --profile      默认 $DSH_HOME/profiles/web；可给 profile 名或绝对路径
 *   --node-modules 直接指定 node_modules 根（与 --profile 同给时以它为准）
 *   --json         机读输出
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_MANIFEST = join(ROOT, "patches", "compat", "manifest.json");

export function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** 解析 unified diff 的 hunk（只处理本仓生成的规范格式，遇到未知行即停止）。 */
export function parseHunks(patchText) {
	const lines = patchText.split("\n");
	const hunks = [];
	let i = 0;
	while (i < lines.length) {
		const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
		if (header === null) {
			i++;
			continue;
		}
		const oldStart = Number(header[1]);
		const oldCount = header[2] === undefined ? 1 : Number(header[2]);
		const newStart = Number(header[3]);
		const newCount = header[4] === undefined ? 1 : Number(header[4]);
		i++;
		const oldLines = [];
		const newLines = [];
		while (i < lines.length && !lines[i].startsWith("@@")) {
			const line = lines[i];
			if (line === "\\ No newline at end of file") {
				i++;
				continue;
			}
			if (line.startsWith(" ")) {
				oldLines.push(line.slice(1));
				newLines.push(line.slice(1));
			} else if (line.startsWith("-")) {
				oldLines.push(line.slice(1));
			} else if (line.startsWith("+")) {
				newLines.push(line.slice(1));
			} else {
				break;
			}
			i++;
		}
		if (oldLines.length !== oldCount) throw new Error(`hunk @${oldStart} 的旧行数不符：声明 ${oldCount}，实际 ${oldLines.length}`);
		if (newLines.length !== newCount) throw new Error(`hunk @${oldStart} 的新行数不符：声明 ${newCount}，实际 ${newLines.length}`);
		hunks.push({ oldStart, newStart, oldLines, newLines });
	}
	if (hunks.length === 0) throw new Error("补丁里没有可应用的 hunk");
	return hunks;
}

/** 把 hunk 应用到文本；reverse=true 时反向应用（用于回滚）。 */
export function applyPatch(source, patchText, reverse = false) {
	const hunks = parseHunks(patchText);
	const sourceLines = source.split("\n");
	const out = [];
	let cursor = 0;
	for (const hunk of hunks) {
		const expect = reverse ? hunk.newLines : hunk.oldLines;
		const replacement = reverse ? hunk.oldLines : hunk.newLines;
		// 正向按源文件行号（oldStart）定位；反向时源文件已是 patched，必须用 newStart。
		const anchor = reverse ? hunk.newStart : hunk.oldStart;
		const start = anchor - 1;
		if (start < cursor) throw new Error(`hunk @${anchor} 与上一个 hunk 重叠或乱序`);
		out.push(...sourceLines.slice(cursor, start));
		for (let k = 0; k < expect.length; k++) {
			if (sourceLines[start + k] !== expect[k]) {
				throw new Error(`hunk @${anchor}+${k} 上下文不匹配：期望 ${JSON.stringify(expect[k])}，实际 ${JSON.stringify(sourceLines[start + k])}`);
			}
		}
		out.push(...replacement);
		cursor = start + expect.length;
	}
	out.push(...sourceLines.slice(cursor));
	return out.join("\n");
}

function readManifest(path) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) throw new Error(`${path} 里没有 targets`);
	return manifest;
}

function patchPath(target) {
	return isAbsolute(target.patch) ? target.patch : join(ROOT, target.patch);
}

function expandHome(value) {
	return value.replace(/^~(?=$|[\\/])/, homedir());
}

function resolveProfile(value) {
	const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	if (value === undefined) return join(dshHome, "profiles", "web");
	const expanded = expandHome(value);
	if (isAbsolute(expanded)) return expanded;
	return join(dshHome, "profiles", expanded);
}

/** 0 skip / 1 create / 2 pristine / 3 patched / 4 drift */
function inspect(target, nodeModules) {
	const pkgDir = join(nodeModules, target.pkg);
	const pkgFile = join(pkgDir, target.rel);
	if (!existsSync(pkgDir)) return { state: "skip", why: "not installed", file: pkgFile };
	if (!existsSync(pkgFile)) {
		if (target.create === true) return { state: "create", why: "missing (to be created)", file: pkgFile };
		return { state: "skip", why: "not installed", file: pkgFile };
	}
	const file = realpathSync(pkgFile);
	const got = sha256(readFileSync(file, "utf8"));
	if (got === target.pristine_sha256) return { state: "pristine", why: "pristine", file, got };
	if (got === target.patched_sha256) return { state: "patched", why: "patched", file, got };
	return { state: "drift", why: `drift (sha256=${got})`, file, got };
}

function writeAtomic(file, text) {
	const tmp = `${file}.dsh-compat.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}

function backupPath(file) {
	return `${file}.orig`;
}

function applyOne(target, nodeModules) {
	const info = inspect(target, nodeModules);
	if (info.state === "skip" || info.state === "patched") return info;
	if (info.state === "drift") throw new Error(`漂移，拒绝打补丁：${target.pkg}/${target.rel}（${info.why}）`);
	if (info.state === "create") throw new Error(`create 目标尚未支持：${target.pkg}/${target.rel}`);
	const patchText = readFileSync(patchPath(target), "utf8");
	const original = readFileSync(info.file, "utf8");
	const patched = applyPatch(original, patchText, false);
	const got = sha256(patched);
	if (got !== target.patched_sha256) throw new Error(`补丁后哈希不符：${target.pkg}/${target.rel}（得到 ${got}）`);
	if (!existsSync(backupPath(info.file))) copyFileSync(info.file, backupPath(info.file));
	writeAtomic(info.file, patched);
	if (sha256(readFileSync(info.file, "utf8")) !== target.patched_sha256) {
		copyFileSync(backupPath(info.file), info.file);
		throw new Error(`写入后校验失败，已恢复备份：${target.pkg}/${target.rel}`);
	}
	return { ...info, state: "patched", why: "patched" };
}

function revertOne(target, nodeModules) {
	const info = inspect(target, nodeModules);
	if (info.state === "skip" || info.state === "pristine") return info;
	if (info.state === "drift") throw new Error(`漂移，拒绝回滚：${target.pkg}/${target.rel}（${info.why}）`);
	if (info.state === "create") throw new Error(`create 目标尚未支持：${target.pkg}/${target.rel}`);
	const patchText = readFileSync(patchPath(target), "utf8");
	const patched = readFileSync(info.file, "utf8");
	const pristine = applyPatch(patched, patchText, true);
	const got = sha256(pristine);
	if (got !== target.pristine_sha256) throw new Error(`回滚后哈希不符：${target.pkg}/${target.rel}（得到 ${got}）`);
	writeAtomic(info.file, pristine);
	if (sha256(readFileSync(info.file, "utf8")) !== target.pristine_sha256) {
		throw new Error(`回滚写入后校验失败：${target.pkg}/${target.rel}`);
	}
	if (existsSync(backupPath(info.file))) rmSync(backupPath(info.file));
	return { ...info, state: "pristine", why: "pristine" };
}

const LABELS = {
	skip: "skip  ",
	create: "create",
	pristine: "patch ",
	patched: "ok    ",
	drift: "DRIFT "
};

function printHelp() {
	process.stdout.write(`dsh-compat · L2 兼容补丁管理器

用法：node bin/patch.mjs [--check|--apply|--revert] [--profile <name|path> | --node-modules <dir>] [--json]

  --check        默认；只报告。存在漂移或补丁未应用时退出码 1
  --apply        打补丁；存在漂移时整体拒绝
  --revert       回滚为 pristine；存在漂移时整体拒绝
  --profile      profile 名或绝对路径（默认 $DSH_HOME/profiles/web）
  --node-modules 直接指定 node_modules 根（Termux 全局树用；与 --profile 同给时优先）
  --json         机读输出
`);
}

function fail(message) {
	process.stderr.write(`[dsh-compat] ${message}\n`);
	process.exit(1);
}

function usage(message) {
	process.stderr.write(`[dsh-compat] ${message}\n\n`);
	printHelp();
	process.exit(2);
}

function main() {
	const args = process.argv.slice(2);
	let mode = "check";
	let profileArg;
	let nodeModulesArg;
	let manifestPath = DEFAULT_MANIFEST;
	let json = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--check") mode = "check";
		else if (arg === "--apply") mode = "apply";
		else if (arg === "--revert") mode = "revert";
		else if (arg === "--json") json = true;
		else if (arg === "--manifest") {
			manifestPath = args[++i];
			if (manifestPath === undefined) usage("--manifest 需要一个值");
		} else if (arg === "--profile") {
			profileArg = args[++i];
			if (profileArg === undefined) usage("--profile 需要一个值");
		} else if (arg === "--node-modules") {
			nodeModulesArg = args[++i];
			if (nodeModulesArg === undefined) usage("--node-modules 需要一个值");
		} else if (arg === "-h" || arg === "--help") {
			printHelp();
			return;
		} else usage(`未知参数：${arg}`);
	}

	let manifest;
	try {
		manifest = readManifest(manifestPath);
	} catch (error) {
		fail(`读不了补丁清单 ${manifestPath}：${error.message}`);
	}
	const nodeModules =
		nodeModulesArg === undefined
			? join(resolveProfile(profileArg), "node_modules")
			: resolve(expandHome(nodeModulesArg));
	const rows = [];
	let drifted = 0;
	let todo = 0;
	let done = 0;
	for (const target of manifest.targets) {
		try {
			const info = mode === "apply" ? applyOne(target, nodeModules) : mode === "revert" ? revertOne(target, nodeModules) : inspect(target, nodeModules);
			rows.push({ id: target.id, pkg: target.pkg, rel: target.rel, state: info.state, why: info.why });
			if (info.state === "drift") drifted++;
			if (info.state === "pristine" || info.state === "create") todo++;
			if (info.state === "patched") done++;
		} catch (error) {
			rows.push({ id: target.id, pkg: target.pkg, rel: target.rel, state: "error", why: error.message });
			drifted++;
		}
	}

	if (json) {
		process.stdout.write(`${JSON.stringify({ nodeModules, mode, ok: drifted === 0 && (mode !== "check" || todo === 0), rows }, null, "\t")}\n`);
	} else {
		process.stdout.write(`目标 node_modules：${nodeModules}\n`);
		for (const row of rows) {
			const label = row.state === "error" ? "ERROR " : LABELS[row.state];
			process.stdout.write(`${label} ${row.pkg}/${row.rel}  (${row.why})\n`);
		}
		process.stdout.write(`\n总计：需打 ${todo}，已打 ${done}，漂移/错误 ${drifted}\n`);
		if (mode === "check" && drifted === 0 && todo === 0) process.stdout.write("补丁状态正常。\n");
		if (mode === "apply" && drifted === 0) process.stdout.write("已应用；重启 dsh 后生效。\n");
		if (mode === "revert" && drifted === 0) process.stdout.write("已回滚为 pristine；重启 dsh 后生效。\n");
	}

	if (drifted > 0) process.exit(1);
	if (mode === "check" && todo > 0) process.exit(1);
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
