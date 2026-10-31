// host 半区：空实现，只负责让 loader entry 激活。
// 为什么必须有它（2026-10-31 Termux/rc.5 实测）：client-modules 只扫描「已激活」的
// entry（index.js:854-866 要求 entry.fiber 存在且未 disabled）。只有 exports["./client"]、
// 没有主入口的包会在 host 侧 ESM 导入报 ERR_PACKAGE_PATH_NOT_EXPORTED，entry 永不激活，
// client 半区永远不被扫描 ⇒ 页面照常、夹具假阴性。
export function apply() {}
