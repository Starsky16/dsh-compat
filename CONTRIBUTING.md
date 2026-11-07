# CONTRIBUTING · dsh-compat 技术细节与开发指南

> 面向想理解/修改本仓的维护者。使用说明见 [README.md](README.md)；各环境验证状态见 [docs/compat.md](docs/compat.md)。

## 分层与归属

| 层 | 职责 | 归谁 |
|---|---|---|
| L1 平台层 | Android 宿主补丁（对任何插件生效） | [termux-dsh](https://github.com/Starsky16/termux-dsh) `patches/core/` |
| L2 加载器层 | 单插件加载失败不连坐整页 | **本仓** `patches/compat/` + `bin/patch.mjs`（2026-10-31 D8 起） |
| L3 客户端垫片 | polyfill + 全局 CSS（弹层实色、低功耗） | 本仓 `lib/index.js` + `css/` |
| L4 安装门禁 | 声明与依赖可达性检查、可回滚 | 本仓 `bin/doctor.mjs` |

**契约**：插件自己**声明**的平台（`dsh.client.platform`、`os`/`cpu`、原生可选依赖）为判据。声明支持 Linux/web 的插件必须「装得上、加载不连坐、失败可见可回滚」；**不承诺**插件业务逻辑本身正确（那是上游 bug）。

## 当前状态（2026-11-01）

| 组件 | 状态 | 说明 |
|---|---|---|
| L2 隔离补丁 `patches/compat/` + `bin/patch.mjs` | ✅ 真机验证 | A 毒化代理 + `start()` 逐条目 catch + **B2（audit 前清 FAILED 条目）**；三态对照实测通过。Termux 打全局树，升级覆盖由 `bin/selfcheck.mjs` 只告警兜底 |
| L3 垫片 `lib/index.js` + `css/` | ✅ 真机冒烟通过 | 纯 host 注入：polyfill 脚本 prepend + 全局 CSS 把菜单材质锁死为不透明；含激活自检（方案 C）。`dsh.bundle.patch` 已声明，`dsh plugin add` 即挂载 |
| L4 门禁 `bin/doctor.mjs` | ✅ 可用 | WIN 实跑 desktop profile 全 PASS；fixture 矩阵全符合；Termux 真实插件 4/4 PASS |
| T7 启动自检 `bin/selfcheck.mjs` | ✅ 接线完成 | sha256 校验补丁目标；未打/漂移/缺失时 stderr 告警、退出码恒 0。T7B wrapper（termux-dsh `~/bin/dsh`）已接线；方案 C 已并入 L3 激活路径 |
| 勘察报告 | ✅ | `docs/spike-loader-isolation.md`（rc.3 静态 + Termux rc.5 真机） |

## L2 加载器隔离补丁

### 命令

```bash
# Termux（生产）：打全局树——profile 里不物化 @deepseek-ai/*
NM="$(npm root -g)/dsh-termux/node_modules"
node bin/patch.mjs --check  --node-modules "$NM"
node bin/patch.mjs --apply  --node-modules "$NM"
node bin/patch.mjs --revert --node-modules "$NM"

# profile 树（将来若某版本把 @deepseek-ai/* 装进 profile 才用得上）
node bin/patch.mjs --check [--profile web]

# 启动自检（只告警，不改文件、不阻塞）：升级 dsh 后确认补丁还在
node bin/selfcheck.mjs --node-modules "$NM"

# 漂移逃生口：dsh 升级导致 client.js 哈希变化时，锚点仍匹配才允许强打
node bin/patch.mjs --apply --node-modules "$NM" --allow-drift --force
```

### 机制要点

- 目标：`<node-modules>/@deepseek-ai/dsh-client-modules/lib/client.js`。`--node-modules` 直接给根；`--profile` 等价于 `<profile>/node_modules`，两者同给时以 `--node-modules` 为准。
- Termux 实测：全新 profile 的 `node_modules/@deepseek-ai` 为空，宿主直走全局树；所以生产打全局树。代价是 **升级 dsh 后补丁被覆盖**，由 `bin/selfcheck.mjs` 只告警兜底（不自动重打、不拒绝启动）；termux-dsh 的 deb postinst 会 best-effort 重打（tdsh.5 起）。
- `--allow-drift --force`：默认对 `pristine_sha256` / `patched_sha256` 硬拒绝；两参数同给时，只有 hunk 锚点仍能匹配才强打，跳过 patched 哈希校验，`--revert` 从 `.orig` 原样恢复。**只在确认上游只是小改、且事后会验页面时用。**
- 清单：`patches/compat/manifest.json` 锁 `pristine_sha256` / `patched_sha256`；当前锚定 **0.2.2-rc.1**（pristine `74e834b8…`，patched `37be3ba1…`）。0.2.2 改写了 `makeRequire`（新增 seed 分支），rc.3/rc.5 的旧锚点（`426084f8…`）已退役，其他版本哈希不匹配即拒绝。
- 补丁内容（A + 隔离 + B2）：
  - `makeRequire` 未命中返回**毒化代理**（使用即抛，带 `[dsh-compat]` 与缺失 spec 的归因），不再击穿整个 `start()`；
  - `start()` 的 `Promise.all` 改**逐条目 catch**，import 期失败就地移除并 `console.error`；
  - **B2**：`await loader.await()` 之后、boot audit 之前，把 `fiber.state === FAILED` 且属于 `this.desired.plugins` 的条目 `loader.remove()`——毒化代理把失败从 import 期推迟到激活期，`create()` 不抛，单靠 catch 捕不到，必须靠 B2 清掉，否则 audit 仍整页崩。
- 应用器由本仓 `bin/patch.mjs` 自己解析 unified diff，不依赖 `patch` / `git apply`（WIN 上 `git apply` 会按 `core.autocrlf` 把 LF 写成 CRLF）；写文件走临时文件 + rename，不写穿 pnpm 的硬链接。
- 真机结论（2026-10-31 Termux rc.5）：pristine 整页崩 → L2 单独仍崩（`import failed: …` 变 `failed`）→ **L2 + B2 页面正常挂载**，插件页显示完整归因。三态对照见 `workflow-sync/handoff/20261031-dsh-compat-L2补丁真机复验.md`。
- 平台边界：**WIN 只上 L3+L4**——dsh 核心在 `app.asar` 内不可写。目标树已定：Termux 打全局树（全新 profile 不物化 `@deepseek-ai/*`，宿主直走全局树）。

### 环境变量开关（L3 激活自检）

| 变量 | 作用 |
|---|---|
| `DSH_COMPAT_NM` | 显式指定 L2 补丁目标 node_modules 根（优先于自动探测） |
| `DSH_COMPAT_DISABLE_L2_SELFCHECK=1` | 关闭 L3 激活时的自检告警 |

自动探测顺序（`lib/index.js` 的 `nodeModuleCandidateRoots`）：`$PREFIX/lib/node_modules`（Termux 与自设 PREFIX 的环境）→ `/usr/local/lib/node_modules` → `/usr/lib/node_modules`，任一处存在 `dsh-termux/node_modules` 即命中；都不存在则静默跳过、不影响 L3/L4。

## L3 客户端垫片（纯 host 注入）

组成（plans Task 3，按 2026-11-01 真机结论修订；2026-11-07 定稿：菜单锁定不透明，不做设置项）：

- **`lib/polyfills.js`** → `<script placement="body">`，`{ prepend: true }` 抢在主题脚本之前执行。只补缺失（randomUUID / `AbortSignal.any`，均有原生实现时不覆盖），触屏设备上设置 perf 开关属性。
- **`css/opaque.css`** → `kind: "style"` 不带 placement、不 prepend，对 `body` / `body[data-ds-dark-theme]` 用 `!important` 把菜单材质 token 锁死为不透明，并把 `--dsw-menu-backdrop-filter` 设为 none。必须 `!important`：宿主主题运行时 append（顺序在后），且 darwin 上还有更高特异性的 `html[data-platform=darwin] body` 覆盖；只靠特异性在 darwin 会被压回半透明。2026-11-07 复核：宿主 ui-theme 的 design-platform.css 在 `body` 定义这些 token，值是有意做成毛玻璃的带 alpha 色（rc.5 `#f8f9fa94` / `#43454a73`，0.2.2-rc.1 `#fcfdfeb3` / `#303136a3`，配 `blur(40px) saturate(150%)`）。⛔ 不要再写 `:root`（body 自己的声明永远压过继承值）。
- **`css/perf.css`** → opt-in：只在 `[data-dsh-compat-perf="1"]` 下生效（触屏才打开），关 backdrop-filter、动画时长归零。
- **L2 激活自检（T7 方案 C）**：插件 `apply()` 时按 manifest sha256 校验全局树补丁，未打/漂移只 stderr 告警（判据与 `bin/selfcheck.mjs` 一致）。

注入顺序契约（rc.5 实证）：boot style → L3 两段 style → `<body>` 起始处 polyfill。`script` 行必须带 `placement`（`'head'|'body'`），`style` 行不带（永远进 head 桶）；渲染分桶（head/body 各自保序）是宿主固有行为。注意宿主主题（ui-theme 的 design-platform.css 等）是客户端运行时 `document.head.appendChild` 注入的，**晚于** L3 两段 style ⇒ L3 样式只能做兜底，覆盖不了主题；要覆盖必须提高特异性或加 `!important`（会牺牲宿主设计，慎用）。

包形态：`package.json` 带 `files` 白名单（lib / css / bin / patches / compat / cordis.patch.yml），`npm pack` 出的 tgz 只含运行必需物；`patches/compat/manifest.json` 随包分发，L3 激活自检与 `bin/selfcheck.mjs` 在解包后直接可用。发布 tgz 由 CI 挂 GitHub Release（`.github/workflows/release.yml`，dispatch 触发，测试通过才打包，同版本重发先删后建），不发包到 npm 公网源。

## doctor（L4）

```bash
node bin/doctor.mjs [profile目录] [--fix] [--dry-run]
```

- 缺省 profile：`$DSH_HOME/profiles/web`，再退回 `…/profiles/desktop`（WIN 惯例）。
- `--fix`：对 FAIL 项执行 `dsh plugin --profile <名> remove <包>`；WIN 上自动使用 CLI 载体 `resources\runtime\cli\bin\dsh.cmd`，找不到 CLI 时打印手动命令。
- `--dry-run`：只打印将执行的回滚命令。
- 退出码：`0` 全过；`1` 有 FAIL；`2` 用法/环境错误。

判据（对齐宿主 `dsh-client-modules` 的图语义，0.2.1-rc.3 核实）：

1. `dsh.client.platform` 必须为 `"web"` 才会被宿主装配 client 半区；其他值给出 WARN（预期不加载，不拦）。
2. client 入口 = `pkg.exports["./client"]`（字符串或 `{default}`）；声明了 `dsh.client` 却缺该导出会在**宿主服务端组合期抛错**，doctor 直接 FAIL。
3. `os`/`cpu` 声明与当前平台交叉；Android 上 `process.platform === "android"` 按 `linux` 宽容映射。
4. client bundle 里的裸 specifier 只能命中：前端 staticModules seed 词 / 某个 `platform==="web"` 包的 client 半区（profile 树、Termux 全局树、WIN `app.asar` 模块表）。全部落空即「externals 漂移」，判 FAIL。扫描前先剥 `//` 与 `/* */` 注释（`lib/specscan.mjs`，字符级扫描并保留字符串/模板/正则字面量）：JSDoc 里 `from "nothing"` 这类散文不再被当成 specifier（2026-11-07 修复）。
5. 已知例外走 `compat/known.json`（如 try/catch 包裹的旧版回退 require），显示为 `KNOWN` 并附归因。

### 测试 fixtures

```bash
# 判定矩阵（WIN 期望：bad FAIL / good PASS / os-mismatch FAIL / os-linux FAIL / nomanifest WARN）
node bin/doctor.mjs test/fixtures/probe-profile

# Termux 期望：dsh-os-linux PASS（android→linux 映射的关键断言）
```

`test/fixtures/` 另有 `bad-plugin`（复现冷启动整页失败）与 `injector-plugin`（核对 `webserver/index-inject` 顺序），供真机动态验证使用。`bad-plugin` **必须带 `main` + `exports["."]` + 空 `apply()`**：client-modules 只扫描已激活的 entry，无主入口的包在 host 侧导不进、client 半区永不扫描，会得到假阴性（2026-10-31 Termux/rc.5 实测）。

## 开发流程

**分支约定**：`main` 是主分支（默认分支，GitHub 首页与文档链接都指向它，始终保持可用状态）；`dev` 是开发分支，日常提交与试验在这里做，验证通过后快进/合并到 `main`。Release 与 tag 以 `main` 为准。

```bash
npm test        # 24 项：补丁应用器 / CLI / 自检 / L3 注入契约 / polyfill / 包声明
node bin/doctor.mjs test/fixtures/probe-profile   # doctor 矩阵回归
```

发版：在 `main` 上 bump `package.json` 版本（唯一同步点）→ push → dispatch `.github/workflows/release.yml`（`gh workflow run release.yml`，ref 用 `main`）→ 核对 Release 资产与 sha256。版本习惯：兼容层小步走 `0.1.x`；dsh 上游大版本（rc.6+）出现时 L2 需重新勘察出新补丁版本。

## 仓库结构

```
dsh-compat/
├─ bin/doctor.mjs              # L4 安装门禁（可执行）
├─ bin/patch.mjs               # L2 补丁管理：check / apply / revert
├─ bin/selfcheck.mjs           # L2 启动自检：只告警，不改文件
├─ lib/index.js                # L3 插件入口：注入接线 + 激活自检（方案 C）
├─ lib/polyfills.js            # L3 注入脚本：randomUUID / AbortSignal.any / perf 开关
├─ css/opaque.css              # L3 菜单材质锁定为不透明（!important，含深色）
├─ css/perf.css                # L3 移动端性能开关（opt-in）
├─ cordis.patch.yml            # L3 的 dsh.bundle.patch 层（- insert: dsh-compat）
├─ patches/compat/             # L2 补丁 + manifest（锁 pristine/patched sha256）
├─ compat/known.json           # 逃生口：已核实的人工例外
├─ docs/spike-loader-isolation.md  # 0.2.1-rc.3 加载器/契约/市场路径勘察
├─ docs/compat.md              # 各环境兼容性覆盖矩阵
├─ test/fixtures/              # doctor 矩阵 + 运行时 fixture
├─ test/patch.test.mjs         # 补丁应用器 / CLI / 自检的单元与端到端测试
├─ test/l3.test.mjs            # L3 注入契约 / polyfill / 自检 / 包声明测试
└─ package.json
```

## 相关

- 计划：`workflow-sync` 仓 `plans/2026-10-27-dsh插件兼容层.md`
- 跨仓事实：`docs/spike-loader-isolation.md`（冷启动整页失败链路、注入顺序、dshmarket 安装路径）
- 姊妹仓：[termux-dsh](https://github.com/Starsky16/termux-dsh)（L1 平台补丁、dsh 本体分发）
