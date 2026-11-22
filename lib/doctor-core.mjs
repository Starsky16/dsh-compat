/**
 * dsh-compat · L4 安装门禁的核心检查（host 半区 / CLI 共用）。
 *
 * 纯函数式：只读文件、不执行任何插件代码、不打印、不退出。
 * `createDoctor()` 把 profile 路径与平台/架构环境固定成闭包，`audit()` 返回逐插件结论：
 *   PASS / FAIL / WARN / KNOWN（与 bin/doctor.mjs 的旧实现逐字等价，只是把自由变量收进闭包）。
 *
 * 可达性判据（对应 @deepseek-ai/dsh-client-modules 0.2.1-rc.3 的图语义）：
 *   client bundle 里的裸 specifier 只能命中 ① 平台 seed 词 ② 某个 client 半区
 *   （profile 树 / Termux 全局树 / WIN app.asar 模块表）；两处都没有即「externals 漂移」，
 *   运行时会以 `require("…") missed the module table` 崩掉（冷启动下连坐整页，见
 *   docs/spike-loader-isolation.md §2）。
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { join, resolve } from "node:path";

import { bareName, scanSpecs } from "./specscan.mjs";
import { candidateNodeModulesList } from "./l2.mjs";

/**
 * 平台 seed 词快照（取自 0.2.1-rc.3 dsh-web-frontend 的 staticModules 表）。
 * 这些 specifier 由前端启动块直接提供，不依赖任何插件包。dsh 升级后需复核。
 */
export const SEED_WORDS = [
	"react", "react/jsx-runtime", "react-dom", "react-dom/client",
	"@deepseek-ai/cordis", "zod", "@tanstack/react-virtual",
	"@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
	"@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit",
];

/**
 * 当前 profile 目录。信号按可靠度排序：
 *  ① `DSH_PROFILE_DIR`（宿主/CLI 直接给出，最准，自定义 profile 名也适用）
 *  ② `DSH_PROFILE` 名字 + `DSH_HOME`
 *  ③ `DSH_HOME` 下探测 web → desktop（Termux / WIN 桌面端惯例）
 *  ④ 都不可用就回落到 `<DSH_HOME>/profiles/web`（调用方自行处理不存在）
 */
export function defaultProfileDir(env = process.env) {
	const has = (dir) => existsSync(join(dir, "package.json"));
	if (env.DSH_PROFILE_DIR) {
		const dir = resolve(env.DSH_PROFILE_DIR);
		if (has(dir)) return dir;
	}
	const dshHome = env.DSH_HOME ?? join(env.HOME ?? env.USERPROFILE ?? "", ".dsh");
	if (env.DSH_PROFILE) {
		const dir = join(dshHome, "profiles", env.DSH_PROFILE);
		if (has(dir)) return dir;
	}
	for (const name of ["web", "desktop"]) {
		const dir = join(dshHome, "profiles", name);
		if (has(dir)) return dir;
	}
	return join(dshHome, "profiles", "web");
}

/**
 * @param {{profileDir:string, repoRoot:string, env?:Record<string,string|undefined>, platform?:string, arch?:string}} options
 */
export function createDoctor({ profileDir, repoRoot, env = process.env, platform = process.platform, arch = process.arch, argv = process.argv }) {
	const profile = resolve(profileDir);
	const profilePkg = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
	const osWant = platform === "android" ? "linux" : platform;
	const cpuWant = arch;

	/**
	 * 宿主 node_modules 候选（判定 client 半区可达性用）。
	 *
	 * 不再按平台硬编码：`DSH_GLOBAL_TREE` 显式覆盖排最前，其余交给 lib/l2.mjs 的
	 * 多信号探测（DSH_INSTALL_DIR → 进程入口 → PREFIX / 标准 npm -g 根 → 自身位置），
	 * 这样 Termux、DSHBox、npm 全局装、源码跑都能命中。
	 */
	const hostTrees = (() => {
		const list = [];
		const push = (dir) => {
			if (!dir) return;
			const abs = resolve(dir);
			if (!list.includes(abs)) list.push(abs);
		};
		push(env.DSH_GLOBAL_TREE);
		for (const dir of candidateNodeModulesList(env, { argv, platform })) push(dir);
		return list;
	})();

	function hostTreeDirs() {
		return hostTrees;
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
		if (env.DSH_ASAR) candidates.push(env.DSH_ASAR);
		if (env.LOCALAPPDATA) {
			candidates.push(join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "resources", "app.asar"));
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
				process.stderr.write(`doctor: 解析 ${asarPath} 失败，跳过（${error?.message ?? error}）\n`);
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

	/** npm os/cpu 判定（含 "!linux" 否定语义）。 */
	function platformMatches(list, want) {
		const neg = list.filter((o) => o.startsWith("!")).map((o) => o.slice(1));
		const pos = list.filter((o) => !o.startsWith("!"));
		if (neg.includes(want)) return false;
		return pos.length === 0 || pos.includes(want);
	}

	/** known 逃生口：compat/known.json。 */
	function loadKnown() {
		try {
			const json = JSON.parse(readFileSync(join(repoRoot, "compat", "known.json"), "utf8"));
			// 根下 plugins = 包名 → 例外；根级键直接是包名也兼容
			return { ...(json.plugins ?? {}), ...Object.fromEntries(Object.entries(json).filter(([k]) => k !== "plugins" && k !== "_comment")) };
		} catch {
			return {};
		}
	}

	function audit() {
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

	return { profile, profilePkg, hostTrees, audit };
}
