// dsh-compat 测试 fixture：工厂内部 require 一个本版本不存在的模块（externals 漂移）。
// 预期运行行为：materialize 抛 client-modules: require("…") missed the module table →
// import 失败 → boot audit 未激活 → 前端整页 "Failed to load plugins"、应用不挂载。
window.__ModuleLoader__.load({
  id: "dsh-bad-plugin",
  factory: (require) => {
    const missing = require("@deepseek-ai/dsh-client-runtime/client");
    const module = { exports: {} };
    module.exports = { apply() { missing.noop(); } };
    return module.exports;
  },
});
