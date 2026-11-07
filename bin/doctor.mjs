#!/usr/bin/env node
/**
 * dsh-compat L4 安装门禁（doctor）。
 *
 * 读 profile 里每个插件的声明（dsh.client.platform / exports["./client"] / npm os+cpu），
 * 并静态预测其 client 半区的模块表可达性。只读插件文件，绝不执行任何插件代码。
 *
 * 可达性判据（对应 @deepseek-ai/dsh-client-modules 0.2.1-rc.3 的图语义）：
 *   client bundle 里的裸 specifier 只能命中 ① 平台 seed 词 ② 某个 client 半区
 *   （profile 树 / Termux 全局树 / WIN app.asar 模块表）；两处都没有即「externals 漂移」，
 *   运行时会以 `require("…") missed the module table` 崩掉（冷启动下连坐整页，见
 *   docs/spike-loader-isolation.md §2）。
 *
 * 用法：
 *   node bin/doctor.mjs [profile目录] [--fix] [--dry-run]
 *     --fix      对 FAIL 项执行 `dsh plugin --profile <名> remove <包>`（可回滚）
 *     --dry-run  只打印将执行的命令，不动手
 * 退出码：0 全过；1 有 FAIL；2 用法/环境错误。
 */
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import { bareName, scanSpecs } from "../lib/specscan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─────────────────────────── 参数与环境 ───────────────────────────

const args = process.argv.slice(2);
const wantFix = args.includes("--fix");
const dryRun = args.includes("--dry-run") || args.includes("-n");
const profileArg = args.find((a) => !a.startsWith("-"));

function defaultProfileDir() {
	const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".dsh");
	// Termux 惯例 web、WIN 桌面端惯例 desktop；两个都探测
	for (const name of ["web", "desktop"]) {
		const dir = join(dshHome, "profiles", name);
		if (existsSync(join(dir, "package.json"))) return dir;
	}
	return join(dshHome, "profiles", "web");
}

const profile = resolve(profileArg ?? defaultProfileDir());
const profilePkgPath = join(profile, "package.json");
if (!existsSync(profilePkgPath)) {
	console.error(`doctor: 找不到 ${profilePkgPath}`);
	console.error("doctor: 用法 node bin/doctor.mjs [profile目录] [--fix] [--dry-run]");
	process.exit(2);
}
const profilePkg = JSON.parse(readFileSync(profilePkgPath, "utf8"));
// profile package.json 的 name 形如 "dsh-profile-desktop"；回滚命令要用 profile 名
const profileName = String(profilePkg.name ?? basename(profile)).replace(/^dsh-profile-/, "");

// ─────────────────────── host 侧可见性三源 ───────────────────────

/**
 * 平台 seed 词快照（取自 0.2.1-rc.3 dsh-web-frontend 的 staticModules 表）。
 * 这些 specifier 由前端启动块直接提供，不依赖任何插件包。dsh 升级后需复核。
 */
const SEED_WORDS = [
	"react", "react/jsx-runtime", "react-dom", "react-dom/client",
	"@deepseek-ai/cordis", "zod", "@tanstack/react-virtual",
	"@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit",
];

/** Termux 全局树（DSH_GLOBAL_TREE 可覆盖）。 */
function hostTreeDirs() {
	if (process.env.DSH_GLOBAL_TREE) return [process.env.DSH_GLOBAL_TREE];
	if (process.platform === "android") {
		return ["/data/data/com.termux/files/usr/lib/node_modules/dsh-termux/node_modules"];
	}
	return [];
}

/** 读 package.json，坏了返回 undefined。 */
function readPkgJson(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/** 解析 exports["./client"] → 相对路径（0.2.1-rc.3 clientExportOf 的只读复刻）。 */
function clientExportOf(pkg) {
	const exportsField = pkg?.exports;
	if (typeof exportsField !== "object" || exportsField === null) return undefined;
	const client = exportsField["./client"];
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null && typeof client.default === "string") return client.default;
	return undefined;
}

/** 该包是否构成一个 client 半区（宿主 resolveMeta 的判据：dsh.client.platform === "web"）。 */
function isClientHalf(pkg) {
	return pkg?.dsh?.client?.platform === "web";
}

// WIN 桌面端：宿主 client 半区在 app.asar 内。只读解析头部目录 + 定位读取 package.json。
let asarIndex;
function asar() {
	if (asarIndex !== undefined) return asarIndex;
	asarIndex = null;
	const candidates = [];
	if (process.env.DSH_ASAR) candidates.push(process.env.DSH_ASAR);
	if (process.env.LOCALAPPDATA) {
		candidates.push(join(process.env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar"));
	}
	for (const asarPath of candidates) {
		if (!existsSync(asarPath)) continue;
		try {
			const fd = openSync(asarPath, "r");
			const head = Buffer.alloc(8 * 1024 * 1024);
			const { bytesRead } = readSync(fd, head, 0, head.length, 0);
			const headerSize = head.readUInt32LE(4);
			const jsonLen = head.readUInt32LE(12);
			let json;
			if (16 + jsonLen <= bytesRead) {
				json = JSON.parse(head.toString("utf8", 16, 16 + jsonLen));
			} else {
				// 目录比 8MB 还大（罕见）：整体读入
				const whole = readFileSync(asarPath);
				json = JSON.parse(whole.toString("utf8", 16, 16 + jsonLen));
			}
			const dataBase = 8 + headerSize;
			asarIndex = {
				path: asarPath,
				/** 按 asar 内绝对路径读文件内容（/dsh/node_modules/<pkg>/package.json）。 */
				readPkg(pkgName) {
					const rel = `/dsh/node_modules/${pkgName}/package.json`;
					const parts = rel.split("/").filter(Boolean);
					let node = json;
					for (const p of parts) {
						node = node?.files?.[p];
						if (!node) return undefined;
					}
					if (node.size === undefined) return undefined;
					const buf = Buffer.alloc(node.size);
					const fd2 = openSync(asarPath, "r");
					try {
						readSync(fd2, buf, 0, node.size, dataBase + Number(node.offset));
					} finally {
						closeSync(fd2);
					}
					try {
						return JSON.parse(buf.toString("utf8"));
					} catch {
						return undefined;
					}
				},
			};
			break;
		} catch (error) {
			console.error(`doctor: 解析 ${asarPath} 失败，跳过（${error?.message ?? error}）`);
		}
	}
	return asarIndex;
}

/** client 半区可达性：seed ∪ profile 树 ∪ 全局树 ∪ asar 模块表。
 * 子路径语义对齐 0.2.1-rc.3 的 stripClientSuffix：只有裸名与 `裸名/client` 会归一到包行，
 * 其他子路径在模块表必然 miss（import() 对 graphRows 直接查完整 id）。 */
function reachClientHalf(spec) {
	if (SEED_WORDS.includes(spec)) return { ok: true, via: "seed" };
	const bare = bareName(spec);
	if (!bare) return { ok: false };
	if (spec !== bare && spec !== `${bare}/client`) return { ok: false };
	const profileHalf = readPkgJson(join(profile, "node_modules", bare));
	if (isClientHalf(profileHalf)) return { ok: true, via: "profile" };
	for (const tree of hostTreeDirs()) {
		const half = readPkgJson(join(tree, bare));
		if (isClientHalf(half)) return { ok: true, via: "host-tree" };
	}
	const asarIdx = asar();
	if (asarIdx) {
		if (isClientHalf(asarIdx.readPkg(bare))) return { ok: true, via: "asar" };
	}
	return { ok: false };
}

// ─────────────────────────── 静态扫描 ───────────────────────────

/** 扫描前先剥注释：specifier 扫描与注释剥离都在 lib/specscan.mjs（见该文件头注）。 */
/** npm os/cpu 判定（含 "!linux" 否定语义）。 */
function platformMatches(list, want) {
	const neg = list.filter((o) => o.startsWith("!")).map((o) => o.slice(1));
	const pos = list.filter((o) => !o.startsWith("!"));
	if (neg.includes(want)) return false;
	return pos.length === 0 || pos.includes(want);
}

// ─────────────────────────── known 逃生口 ───────────────────────────

function loadKnown() {
	try {
		const json = JSON.parse(readFileSync(join(REPO_ROOT, "compat", "known.json"), "utf8"));
		// 根下 plugins = 包名 → 例外；根级键直接是包名也兼容
		return { ...(json.plugins ?? {}), ...Object.fromEntries(Object.entries(json).filter(([k]) => k !== "plugins" && k !== "_comment")) };
	} catch {
		return {};
	}
}

// ─────────────────────────── 主检查 ───────────────────────────

const osWant = process.platform === "android" ? "linux" : process.platform;
const cpuWant = process.arch;

function checkAll() {
	const rows = [];
	for (const name of Object.keys(profilePkg.dependencies ?? {})) {
		const dir = join(profile, "node_modules", name);
		const pkg = readPkgJson(dir);
		const known = loadKnown()[name] ?? {};
		const row = { name, verdict: "PASS", notes: [], missing: [], known: false };

		if (!pkg) {
			row.verdict = "WARN";
			row.notes.push("package.json 不可读（可能安装中断或 pnpm 未完成）");
			rows.push(row);
			continue;
		}

		// ① npm os / cpu
		if (Array.isArray(pkg.os) && !platformMatches(pkg.os, osWant)) {
			row.verdict = "FAIL";
			row.notes.push(`os 声明不匹配（声明 [${pkg.os.join(", ")}]，本机 ${osWant}）`);
		}
		if (Array.isArray(pkg.cpu) && !platformMatches(pkg.cpu, cpuWant)) {
			row.verdict = "FAIL";
			row.notes.push(`cpu 声明不匹配（声明 [${pkg.cpu.join(", ")}]，本机 ${cpuWant}）`);
		}

		const decl = pkg.dsh?.client;
		if (decl === undefined) {
			if (row.verdict === "PASS") row.notes.push("host-only（无 dsh.client 声明）");
			rows.push(row);
			continue;
		}

		// ② platform 声明
		if (typeof decl.platform !== "string") {
			row.verdict = "FAIL";
			row.notes.push("dsh.client.platform 缺失或非字符串（宿主 parseDshClient 将抛错）");
			rows.push(row);
			continue;
		}
		if (decl.platform !== "web") {
			if (row.verdict === "PASS") row.verdict = "WARN";
			row.notes.push(`客户端半区不会被宿主加载（platform=${decl.platform}）；若插件期望 UI，本环境预期降级`);
			rows.push(row);
			continue;
		}

		// ③ exports["./client"] 与入口文件（宿主组合期就抛错的两种形态）
		const clientRel = clientExportOf(pkg);
		if (clientRel === undefined) {
			row.verdict = "FAIL";
			row.notes.push('声明了 dsh.client.platform=web 但 exports 缺 "./client" 子路径（宿主组合期抛 ClientPackageCompositionError）');
			rows.push(row);
			continue;
		}
		const clientFile = join(dir, clientRel);
		if (!existsSync(clientFile)) {
			row.verdict = "FAIL";
			row.notes.push(`client bundle 不存在：${clientRel}（宿主组合期抛 MissingClientBundleError）`);
			rows.push(row);
			continue;
		}

		// ④ dsh.client.inject 的每个 specifier 都必须是可达的 client 半区
		for (const injectSpec of Array.isArray(decl.inject) ? decl.inject : []) {
			if (!reachClientHalf(injectSpec).ok) {
				row.verdict = "FAIL";
				row.missing.push(`inject: ${injectSpec}`);
			}
		}

		// ⑤ client bundle 内裸 specifier 的可达性（模块表静态预测）
		let source = "";
		try {
			source = readFileSync(clientFile, "utf8");
		} catch {
			row.verdict = "FAIL";
			row.notes.push(`client bundle 不可读：${clientRel}`);
			rows.push(row);
			continue;
		}
		const ignoreMissing = Array.isArray(known.ignoreMissing) ? known.ignoreMissing : [];
		for (const spec of scanSpecs(source)) {
			if (reachClientHalf(spec).ok) continue;
			row.missing.push(spec);
		}
		if (row.missing.length > 0) {
			const allIgnored = row.missing.every((s) => ignoreMissing.includes(s) || ignoreMissing.includes(bareName(s)) || ignoreMissing.includes(s.replace(/\/client$/, "")));
			if (known.expectedFail === true || allIgnored) {
				row.verdict = "KNOWN";
				row.notes.push(known.note ?? "known.json 已登记的例外");
			} else {
				row.verdict = "FAIL";
			}
			row.notes.push("依赖不可达（externals 漂移，运行时将 missed the module table）");
		}
		rows.push(row);
	}
	return rows;
}

// ─────────────────────────── 输出与 --fix ───────────────────────────

function printRows(rows) {
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

function runFix(rows) {
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

// ─────────────────────────── main ───────────────────────────

const rows = checkAll();
let fail = printRows(rows);
if (wantFix && fail > 0) {
	const fixRc = runFix(rows);
	if (!dryRun) {
		console.log("\n──── 回滚后复查 ────");
		const after = checkAll();
		const afterFail = printRows(after);
		process.exit(afterFail > 0 ? 1 : fixRc);
	}
}
process.exit(fail > 0 ? 1 : 0);
