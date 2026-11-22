# dsh-compat · 兼容性覆盖（COVERAGE）

> 覆盖范围与判据的单一事实源。✅ = 已验证；🟡 = 设计支持、未实测；❌ = 明确不支持。
> 「验证」指本仓工具在该环境实跑并通过判据，未验证项不标 ✅。

## 环境 × 组件矩阵

| 环境 | L2 加载器隔离补丁 | L3 客户端垫片 | L4 doctor | 备注 |
|---|---|---|---|---|
| **Linux（DSHBox）**（PRoot Debian 13 + 上游 dsh 0.2.2-rc.5，`/opt/dshapp/runtime`） | ✅ 宿主树自动探测命中；rc.5 与 rc.3 字节相同 ⇒ `retired`（2026-11-22 实测 `--check` 退出 0） | ✅ 真机：注入顺序、`__DSH_COMPAT_STATUS__`、client bundle 进组合 URL（2026-11-22） | ✅ 真机 12 插件 FAIL 0（2026-11-22） | 现役主环境；客户端 tab 已上线 |
| **Termux**（termux-dsh，已归档 2026-11-21） | ✅ 全局树 `--node-modules`；0.2.2 锚点已重生成并实测 apply/revert 字节一致（2026-11-07） | ✅ 真机冒烟：注入顺序、6 痕迹、selfcheck ready（2026-11-01） | ✅ android→linux 映射 PASS（2026-10-31） | 历史环境；termux-dsh 归档后仍可用（探测含 `dsh-termux/node_modules` 布局） |
| **Linux 桌面**（官方 dsh / npm 全局装） | ✅ 自动探测（`DSH_INSTALL_DIR` / `argv[1]` / 标准 npm -g 根）+ 合成树单测；无独立真机 | ✅ 纯 host 注入，与环境无关 | 🟡 doctor 本体跨平台，未在独立桌面 Linux 实跑 | 无 dsh 树时 L2 自检静默跳过 |
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
| 注入顺序：boot style → L3 style → body 起始 polyfill（宿主主题运行时 append，晚于 L3） | ✅ | 真机抓首页逐位置核对（2026-11-01）；主题运行时注入 2026-11-07 复核 |
| `script` 行带 `placement`、`style` 行不带（rc.5 契约） | ✅ | `dsh-host-webserver` 类型定义 + 真机 |
| 菜单材质锁定不透明（`body` + `!important`，含深色） | ✅ 注入已验证；🟡 视觉效果待人工浏览器确认 | 2026-11-07 复核：宿主 rc.5 / 0.2.2-rc.1 在 `body` 定义毛玻璃 token（alpha 58/45% → 70/64%，配 blur(40px)）且运行时后注入，darwin 还有 `html[data-platform=darwin] body` 高特异性覆盖 ⇒ 用 `!important` 锁死，顺序/特异性都不影响 |
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
- **dshmarket 适配方式**（2026-11-01 rc.5-tdsh.4 复核，2026-11-07 修正）：本仓**没有 dshmarket 专用代码路径**——市场可用性由通用机制覆盖（L2 隔离让市场盲装坏插件不连坐、L4 doctor 提供装后静态复检与 `--fix` 回滚、T7B 启动自检抓补丁丢失）。市场安装契约只产出 **pnpm spec**（`dsh-plugin-market/lib/typert.host.js` install.schema："Install spec accepted by `pnpm add`"；npm 源 `name@version` / git 源 `git+url#commit`），实际走 profile 目录的 `pnpm add`，rc.5 上未见 `dshArgv` 式 dsh CLI spawn。⇒ 市场安装依赖 PATH 有 pnpm；termux-dsh deb 的 `Depends` **已含 pnpm**（termux-dsh `b19df31`，2026-11-01；本机 tdsh.1 实测 `Depends: …, pnpm`）。
- **上游版本漂移**：补丁字节锚定 **0.2.2-rc.1**（`client.js` pristine `74e834b8…`，patched `37be3ba1…`）；**0.2.2-rc.3 起登记为 `retired`**（`fc491b97…`，rc.5 字节相同）——上游已内建逐条目 catch 且 audit/B2 迁出该包，命中即「无需补丁」。rc.5 之前的旧锚点（`426084f8…`）已退役。其他版本哈希不匹配即拒绝（`--allow-drift --force` 为显式逃生口，会跳过 patched 哈希校验）。T7 自检只在启动时告警，不自动重打。
- **宿主树探测（2026-11-22 重写）**：旧实现只认 `dsh-termux/node_modules`，在 DSHBox / 源码 / npm 全局装的环境里静默 `skip`，导致 L2 自检与 doctor 全部假阴性（实测 7 个插件误报 FAIL）。现按 `DSH_COMPAT_NM` → `DSH_INSTALL_DIR` → `argv[1]` → PREFIX / 标准 npm -g 根 → 自身位置探测，**判据是目录下真有 `@deepseek-ai/dsh-client-modules`**。
- **WIN 端 tgz 安装**：公开仓后匿名下载可用；WIN dsh CLI 载体（`dsh.cmd`）是否支持 `plugin add <tgz>` 未验证。
