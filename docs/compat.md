# dsh-compat · 兼容性覆盖（COVERAGE）

> 覆盖范围与判据的单一事实源。✅ = 已验证；🟡 = 设计支持、未实测；❌ = 明确不支持。
> 「验证」指本仓工具在该环境实跑并通过判据，未验证项不标 ✅。

## 环境 × 组件矩阵

| 环境 | L2 加载器隔离补丁 | L3 客户端垫片 | L4 doctor | 备注 |
|---|---|---|---|---|
| **Termux**（termux-dsh，dsh 0.2.1-rc.5） | ✅ 全局树 `--node-modules`；三态对照 + B2 真机实证（2026-10-31 / 11-01） | ✅ 真机冒烟：注入顺序、6 痕迹、selfcheck ready（2026-11-01） | ✅ android→linux 映射 PASS（2026-10-31） | 主目标环境；L2 补丁按生产状态保留 |
| **Linux 桌面**（官方 dsh / dsh-termux 全局树） | 🟡 候选根 `/usr/local`、`/usr/lib` 已实现并有合成树单测；无真机实跑 | ✅ 纯 host 注入，与环境无关 | 🟡 doctor 本体跨平台，未在桌面 Linux 实跑 | 无 dsh 树时 L2 自检静默跳过 |
| **macOS** | 🟡 同上（候选根一致） | ✅ | 🟡 同上 | 同 Linux 桌面 |
| **Windows 桌面**（DeepSeek Harness） | ❌ dsh 核心在 `app.asar` 内不可写，L2 不适用 | 🟡 纯 host 注入理论可用，未实测 | ✅ WIN 实跑 desktop profile 11 插件 10 PASS + 1 KNOWN（2026-10-28） | L2 补丁的归属按 2026-10-31 D8 归本仓，但平台不可写 |

## 插件生态覆盖（L4 doctor 判据）

| 插件形态 | 判定 | 实证 |
|---|---|---|
| 正常声明（`dsh.client` 平台匹配） | PASS | `dsh-good-plugin`、WIN 10 插件、本机 4 插件（2026-11-01） |
| os/cpu 声明不匹配 | FAIL | `dsh-os-mismatch` fixture；`dsh-os-linux` 在 Termux PASS / WIN FAIL |
| 缺依赖 | FAIL | fixture 矩阵 |
| 缺 manifest | WARN | `dsh-nomanifest` fixture |
| try/catch 回退 require（静态不可辨） | KNOWN + 归因 | `compat/known.json` 逃生口，首例 `dsh-at-file` |
| 无主入口只有 `exports["./client"]` | host 侧 ERR_PACKAGE_PATH_NOT_EXPORTED，不进扫描 | `bad-plugin` 旧版教训（已修，`5e1f993`） |

## L3 注入行为覆盖

| 行为 | 状态 | 判据来源 |
|---|---|---|
| 注入顺序：boot style → L3 style（后写覆盖）→ body 起始 polyfill | ✅ | 真机抓首页逐位置核对（2026-11-01） |
| `script` 行带 `placement`、`style` 行不带（rc.5 契约） | ✅ | `dsh-host-webserver` 类型定义 + 真机 |
| 弹层透底修复（补缺失 token，深浅色） | ✅ 注入已验证；🟡 视觉效果待人工浏览器确认 | 根因：两 token 在宿主 CSS 只有使用没有定义 |
| perf 开关（触屏 opt-in） | 🟡 属性设置逻辑有单测，实际视觉效果未验证 | `[data-dsh-compat-perf="1"]` |
| polyfill（randomUUID / AbortSignal.any，只补缺失） | 🟡 守卫逻辑有单测；rc.5 webview 原生已有二者，实际未触发 | — |
| L2 激活自检（方案 C，只告警） | ✅ | selfcheck ready:true；deb 装后场景由 T7B wrapper 抓获 |

## 安装通道覆盖

| 通道 | 状态 |
|---|---|
| git URL 直装（`dsh plugin add https://github.com/...`） | ✅ 2026-11-01 真机（bundle 栈自动登记） |
| Release tgz（`dsh plugin add ./dsh-compat-<版本>.tgz`） | ✅ 2026-11-01 真机（v0.1.0/v0.1.1 双验证） |
| 本地目录（开发态 link:） | ✅ 全部冒烟的基线方式 |
| npm 公网源 | ❌ 有意不发 |

## 已知不覆盖 / 未解

- **`/plugins/**` 的 curl 抓取**：三前缀 + A/B 对照均落 SPA 回退（404/HTML），与 L3 无关（对照实例同状）；浏览器请求特征不同，历史可抓到 client.js。人工浏览器复验未做。
- **dshmarket 安装路径**（2026-11-01 rc.5-tdsh.4 复核）：market 契约只产出 **pnpm spec**（`dsh-plugin-market/lib/typert.host.js` install.schema："Install spec accepted by `pnpm add`"；npm 源 `name@version` / git 源 `git+url#commit`），实际安装走 profile 目录的 `pnpm add`；rc.5 上未见 `dshArgv` 式 dsh CLI spawn（旧结论出自 rc.3 WIN asar 静态勘察，待复核）。⇒ 市场安装依赖 PATH 里有 pnpm；termux-dsh deb 的 `Depends` **不含 pnpm**，纯 deb 用户走市场会失败（缺口，记于 termux-dsh 侧）。
- **上游版本漂移**：L2 补丁锚定 rc.3 / rc.5（`client.js` 字节一致）；rc.6+ 哈希不匹配即拒绝（`--allow-drift --force` 为显式逃生口）。T7 自检只在启动时告警，不自动重打。
- **WIN 端 tgz 安装**：公开仓后匿名下载可用；WIN dsh CLI 载体（`dsh.cmd`）是否支持 `plugin add <tgz>` 未验证。
