#!/usr/bin/env node
/**
 * dsh-compat L4 安装门禁（doctor）· 薄 CLI 层。
 *
 * 检查逻辑在 lib/doctor-core.mjs（纯函数，host 半区与 CLI 共用）；L2 状态在 lib/l2.mjs。
 * 本层只负责：参数解析、打印、`--fix` 回滚、`--json`、退出码。
 *
 * 用法：
 *   node bin/doctor.mjs [profile目录] [--fix] [--dry-run] [--json]
 *     --fix      对 FAIL 项执行 `dsh plugin --profile <名> remove <包>`（可回滚）
 *     --dry-run  只打印将执行的命令，不动手
 *     --json     机读输出（含 L2 段与 summary）；退出码仍按 FAIL 计
 * 退出码：0 全过；1 有 FAIL；2 用法/环境错误。L2 状态只展示，不参与退出码。
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

import { createDoctor, defaultProfileDir } from "../lib/doctor-core.mjs";
import { defaultNodeModules, l2Status } from "../lib/l2.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** L2 段：只展示状态，不参与退出码。retired 的 why 与锚定版本重复，人读输出里省掉。 */
function printL2(l2) {
	const anchor = l2.anchor ? `（锚定 ${l2.anchor}）` : "";
	const why = l2.retired ? "" : (l2.why ? `  ${l2.why}` : "");
	console.log(`L2  ${l2.state}${anchor}${why}`);
}

function printRows(rows, profile) {
	for (const row of rows) {
		const tag = row.verdict.padEnd(5);
		const detail = row.missing.length > 0 ? `  缺失: ${row.missing.join(", ")}` : "";
		const extra = row.notes.length > 0 ? `  （${row.notes.join("；")}）` : "";
		console.log(`${tag}  ${row.name}${detail}${extra}`);
	}
	const fail = rows.filter((r) => r.verdict === "FAIL").length;
	const warn = rows.filter((r) => r.verdict === "WARN").length;
	const knownN = rows.filter((r) => r.verdict === "KNOWN").length;
	console.log(`\n${fail > 0 ? "有失败项" : "通过"}：${rows.length} 个插件（FAIL ${fail} / WARN ${warn} / KNOWN ${knownN}）`);
	console.log(`profile: ${profile}`);
	return fail;
}

function removeCommandFor(name) {
	if (process.platform === "win32") {
		// WIN 桌面端 CLI 载体：resources\runtime\cli\bin\dsh.cmd（ELECTRON_RUN_AS_NODE + asar 内 cli.js）
		const localAppData = process.env.LOCALAPPDATA;
		const cli = process.env.DSH_CLI
			?? (localAppData ? join(localAppData, "Programs", "DeepSeek Harness", "resources", "runtime", "cli", "bin", "dsh.cmd") : undefined);
		if (cli && existsSync(cli)) return { kind: "cmd", file: cli };
		return { kind: "cmd", file: "dsh" };
	}
	return { kind: "spawn", file: "dsh" };
}

function runFix(rows, profileName, dryRun) {
	const targets = rows.filter((r) => r.verdict === "FAIL");
	if (targets.length === 0) {
		console.log("doctor --fix：没有 FAIL 项。");
		return 0;
	}
	let rc = 0;
	for (const row of targets) {
		const cmd = removeCommandFor(row.name);
		const cmdArgs = ["plugin", "--profile", profileName, "remove", row.name];
		const printable = cmd.kind === "cmd"
			? `"${cmd.file}" ${cmdArgs.join(" ")}`
			: `${cmd.file} ${cmdArgs.join(" ")}`;
		if (dryRun) {
			console.log(`[dry-run] ${printable}`);
			continue;
		}
		console.log(`回滚：${printable}`);
		try {
			if (cmd.kind === "cmd") {
				// .cmd 只能经 shell 启动；字符串整体引号包住
				execSync(`"${cmd.file}" ${cmdArgs.join(" ")}`, { stdio: "inherit" });
			} else {
				const res = spawnSync(cmd.file, cmdArgs, { stdio: "inherit" });
				if (res.status !== 0) throw new Error(`退出码 ${res.status}`);
			}
		} catch (error) {
			console.error(`回滚失败（${row.name}）：${error?.message ?? error}`);
			console.error(`手动回滚：${printable}`);
			rc = 1;
		}
	}
	return rc;
}

function main() {
	const args = process.argv.slice(2);
	const wantFix = args.includes("--fix");
	const dryRun = args.includes("--dry-run") || args.includes("-n");
	const json = args.includes("--json");
	const profileArg = args.find((a) => !a.startsWith("-"));

	const profile = resolve(profileArg ?? defaultProfileDir());
	if (!existsSync(join(profile, "package.json"))) {
		console.error(`doctor: 找不到 ${join(profile, "package.json")}`);
		console.error("doctor: 用法 node bin/doctor.mjs [profile目录] [--fix] [--dry-run] [--json]");
		process.exit(2);
	}

	const doctor = createDoctor({ profileDir: profile, repoRoot: REPO_ROOT });
	// profile package.json 的 name 形如 "dsh-profile-desktop"；回滚命令要用 profile 名
	const profileName = String(doctor.profilePkg.name ?? basename(profile)).replace(/^dsh-profile-/, "");
	const l2 = l2Status({ nodeModules: defaultNodeModules() });
	const rows = doctor.audit();

	if (json) {
		process.stdout.write(`${JSON.stringify({
			profile,
			generatedAt: new Date().toISOString(),
			l2: { anchor: l2.anchor, state: l2.state, why: l2.why, retired: l2.retired, sha256: l2.sha256 },
			plugins: rows.map(({ name, verdict, missing, notes }) => ({ name, verdict, missing, notes })),
			summary: {
				fail: rows.filter((r) => r.verdict === "FAIL").length,
				warn: rows.filter((r) => r.verdict === "WARN").length,
				known: rows.filter((r) => r.verdict === "KNOWN").length,
			},
		}, null, "\t")}\n`);
		process.exit(rows.some((r) => r.verdict === "FAIL") ? 1 : 0);
	}

	printL2(l2);
	const fail = printRows(rows, profile);
	if (wantFix && fail > 0) {
		const fixRc = runFix(rows, profileName, dryRun);
		if (!dryRun) {
			console.log("\n──── 回滚后复查 ────");
			const afterFail = printRows(doctor.audit(), profile);
			process.exit(afterFail > 0 ? 1 : fixRc);
		}
	}
	process.exit(fail > 0 ? 1 : 0);
}

main();
