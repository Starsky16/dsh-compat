/**
 * dsh-compat · L3 host 半区。
 *
 *  - polyfill 脚本 prepend（抢在主题脚本之前执行）；
 *  - 全局 CSS 不 prepend；菜单材质用 !important 锁死为不透明（见 css/opaque.css）；
 *  - 激活时内嵌 T7 方案 C 的 L2 自检（只告警，与 bin/selfcheck.mjs 同判据）；
 *  - 把兼容性结论注入 `window.__DSH_COMPAT_STATUS__`，供 client 半区（lib/client.js）
 *    在插件页渲染「兼容性」tab 与详情 badge。
 *
 * ⚠️ `dsh.client` 与 `exports["./client"]` 必须成对出现：只声明前者会在宿主服务端
 * 组合期抛 ClientPackageCompositionError（spike 实证，2026-10-28）；两者都在才安全。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, readManifest } from "../bin/patch.mjs";
import { createDoctor, defaultProfileDir } from "./doctor-core.mjs";
import { defaultNodeModules, hostVersion, l2Status } from "./l2.mjs";
import { POLYFILLS } from "./polyfills.js";

// L2 宿主树探测与状态判定已搬到 lib/l2.mjs（doctor / selfcheck / host 半区共用）；
// 这里重导出，保持既有 import 调用点不变。
export { candidateNodeModules, candidateNodeModulesList, defaultNodeModules, l2Status } from "./l2.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_MANIFEST = join(ROOT, "patches", "compat", "manifest.json");
const TAG = "[dsh-compat]";

const read = (name) => readFileSync(join(ROOT, "css", name), "utf8");

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
		if (info.state === "patched" || info.state === "retired") continue;
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

/** 把值安全地嵌进内联 script（`<` 与行分隔符都要转义，否则能提前闭合标签）。 */
export function escapeForScript(value) {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/**
 * 兼容性结论：宿主版本、L2 状态、逐插件判定。client 半区只读不写。
 * @param {{env?:Record<string,string|undefined>, platform?:string, arch?:string, argv?:string[]}} [options]
 */
export function buildCompatStatus({ env = process.env, platform = process.platform, arch = process.arch, argv = process.argv } = {}) {
	const nodeModules = defaultNodeModules(env, { argv, platform });
	const base = {
		host: { version: hostVersion(nodeModules) },
		l2: l2Status({ nodeModules }),
		generatedAt: new Date().toISOString(),
		plugins: [],
	};
	try {
		const doctor = createDoctor({ profileDir: defaultProfileDir(env), repoRoot: ROOT, env, platform, arch, argv });
		base.plugins = doctor.audit().map(({ name, verdict, missing, notes }) => ({ name, verdict, missing, notes }));
	} catch (error) {
		base.error = `兼容性检查失败：${error?.message ?? error}`;
	}
	return base;
}

/** 注入用脚本行文本；任何异常都降级成一条可读错误，绝不拖垮页面启动。 */
export function compatStatusScript(options) {
	let status;
	try {
		status = buildCompatStatus(options);
	} catch (error) {
		status = { error: String(error?.message ?? error), plugins: [] };
	}
	return `window.__DSH_COMPAT_STATUS__ = ${escapeForScript(status)};`;
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
	// 兼容性结论：client 半区只读这个全局。
	ctx.on("webserver/index-inject", (table) => {
		table.push({ kind: "script", placement: "body", text: compatStatusScript() });
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
