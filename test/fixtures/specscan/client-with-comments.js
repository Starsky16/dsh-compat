// dsh-compat · test fixture：注释里的假 specifier 与真实 specifier 混排
// 行注释假阳性：from "line-comment-fake"
/* 块注释假阳性：require("block-comment-fake") */

/**
 * JSDoc 真实触发片段（2026-11-07 @mars-sea/dsh-commandcode-provider 的误报来源）：
 * "we were not told" has to look different from "nothing".
 */

const a = require("react");
const b = require("@deepseek-ai/dsh-client-ui-primitives");
const c = import("react/jsx-runtime");

// 正则字面量里有转义斜杠，注释剥离不得从 `/` 处截断后面的代码
const re = /a\//;
const d = require("@scope/after-regex/client");

export { a, b, c, d };
