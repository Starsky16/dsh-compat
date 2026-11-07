/**
 * dsh-compat · L4 · 静态 specifier 扫描（doctor 用，零依赖）。
 *
 * 背景（2026-11-07）：doctor 用正则直接扫 client bundle，把 JSDoc 注释里的
 * 英文散文 `... look different from "nothing".` 当成 `from "nothing"`
 * ⇒ 误报「缺失: nothing」。修法是扫描前先剥掉 `//` 与 `/* *\/` 注释。
 *
 * 剥注释用一趟字符级扫描，而不是正则替换：必须原样保留字符串/模板字符串/
 * 正则字面量的内容，否则会把真正的 specifier（`require("react")`）也剥掉。
 *   - 字符串：'…'、"…"、`…`（含反斜杠转义；模板里的 `${…}` 不做嵌套解析，
 *     按字符串内容整体保留——注释写在 `${}` 里的极端情况不处理）；
 *   - 正则：用「前一个有效字符/关键字」启发式判断 `/` 是正则开头还是除号，
 *     避免把 `/a\//` 里转义斜杠后面的 `/` 误当行注释；
 *   - 注释替换为单个空格，代码其余部分逐字保留。
 *
 * 正则扫描找 specifier 本质是启发式：注释剥掉后仍有假阳性时，应继续收紧
 * SPEC_RE / SPEC_CHARS_RE，而不是加整段 JS parser 依赖（doctor 保持零依赖）。
 */

/** 从 specifier 取裸包名；相对/别名/带 scheme 的返回 undefined。 */
export function bareName(spec) {
	if (!spec || spec.startsWith(".") || spec.startsWith("#")) return undefined;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return undefined; // node: cordis: data: …
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined;
	}
	const slash = spec.indexOf("/");
	return slash === -1 ? spec : spec.slice(0, slash);
}

/** 覆盖压缩后形态：require("x") / import("x") / from"x" / from 'x'（引号可单可双）。 */
export const SPEC_RE = /(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*)(["'])([^"'\n]+)\1/g;

/** 合法裸 specifier 的字符集：npm 包名 + 子路径段。错误消息字符串（含空格/花括号/反斜杠等）在此被剔除。 */
export const SPEC_CHARS_RE = /^@?[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** `/` 前面出现这些「非操作数」结尾时，按正则开头理解；否则按除号。 */
const REGEX_PRECEDING_CHARS = new Set(["", "(", "[", "{", ",", ";", "=", ":", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">"]);
/** 同理的关键字（`return /re/` 这类）。 */
const REGEX_PRECEDING_WORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
	"throw", "case", "do", "else", "yield", "await",
]);

/** 当前 `/` 是否可能是正则字面量的开头（启发式，够用即可）。 */
function regexMayStart(prevChar, prevWord) {
	return REGEX_PRECEDING_CHARS.has(prevChar) || REGEX_PRECEDING_WORDS.has(prevWord);
}

/**
 * 剥掉 JS 注释，保留字符串/模板字符串/正则字面量原文。
 * @param {string} source
 * @returns {string} 去注释后的源码（长度可变，行号不再对应）
 */
export function stripComments(source) {
	const out = [];
	let i = 0;
	let prevChar = "";
	let prevWord = "";
	const n = source.length;

	const push = (text) => out.push(text);

	while (i < n) {
		const c = source[i];
		const next = source[i + 1];

		// 行注释
		if (c === "/" && next === "/") {
			i += 2;
			while (i < n && source[i] !== "\n") i++;
			push(" ");
			continue;
		}
		// 块注释
		if (c === "/" && next === "*") {
			i += 2;
			while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
			i = Math.min(n, i + 2);
			push(" ");
			continue;
		}
		// 字符串 / 模板字符串：整体保留
		if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			push(c);
			i++;
			while (i < n) {
				const ch = source[i];
				push(ch);
				if (ch === "\\") {
					if (i + 1 < n) {
						push(source[i + 1]);
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
				if (ch === quote) break;
			}
			prevChar = quote;
			prevWord = "";
			continue;
		}
		// 正则字面量：整体保留（含转义与字符类）
		if (c === "/" && regexMayStart(prevChar, prevWord)) {
			push(c);
			i++;
			let inClass = false;
			while (i < n) {
				const ch = source[i];
				push(ch);
				if (ch === "\\") {
					if (i + 1 < n) {
						push(source[i + 1]);
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
				if (ch === "[") inClass = true;
				else if (ch === "]") inClass = false;
				else if (ch === "/" && !inClass) break;
			}
			prevChar = "/";
			prevWord = "";
			continue;
		}

		push(c);
		if (!/\s/.test(c)) {
			prevChar = c;
			prevWord = /[A-Za-z_$]/.test(c) ? prevWord + c : "";
		}
		i++;
	}
	return out.join("");
}

/**
 * 扫出一段源码里引用的裸 specifier（已剥注释）。
 * @param {string} source
 * @returns {Set<string>}
 */
export function scanSpecs(source) {
	const found = new Set();
	for (const m of stripComments(source).matchAll(SPEC_RE)) {
		const spec = m[2];
		if (bareName(spec) === undefined) continue; // 相对路径 / node: / cordis: 等
		if (!SPEC_CHARS_RE.test(spec)) continue; // 压缩代码里的字符串不是 specifier
		found.add(spec);
	}
	return found;
}
