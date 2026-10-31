# Spike：加载器隔离与市场路径（Task 1）

> 状态：**静态半场（WIN asar，rc.3）与动态半场（Termux 真机，rc.5-tdsh.3）均已完成**；动态结论与夹具修正见 §8。
> 报告供 dsh-compat 与 termux-dsh 两个仓库共用；结论已按「证据 → 结论 → 影响」组织，未验证项显式标注。
> 证据来源：只读解析 WIN 桌面端 `app.asar`（2026-10-28，版本 0.2.1-rc.3）中的
> `@deepseek-ai/dsh-client-modules`（lib/client.js / lib/index.js）、`dsh-web-frontend`（dist/assets/index-BXV-oxvX.js）
> 与 desktop profile 树内 `dshmarket@1.70.2`（lib/dsh-cli.js 等）。行号以 0.2.1-rc.3 为锚，升级后需复核。

## 1. 版本锚点

| 组件 | 版本 | 位置 |
|---|---|---|
| dsh 桌面端核心 | 0.2.1-rc.3（app.asar 内不可写） | WIN |
| `@deepseek-ai/dsh-client-modules` | 0.2.1-rc.3 | app.asar `/dsh/node_modules/` |
| `@deepseek-ai/dsh-web-frontend` | 0.2.1-rc.3 | app.asar，boot 覆盖层与启动链在 `dist/assets/index-BXV-oxvX.js` |
| dshmarket | 1.70.2 | desktop profile 树（Termux 侧计划对齐 1.71.1，接口面需届时复核） |

## 2. 崩溃机制（冷启动整页失败的真实路径）

启动链（前端 bundle `index-BXV-oxvX.js`，minified 名按位对应）：

1. 入口块：`new RZ(e)` → `RZ.run()`，`catch` 走 `o7(e)` → `page.fail(String(e))`（全局失败文案）。
2. `RZ.run()` 主体：`__DSH_BOOT_READY__` → `__ModuleLoader__.create(...)` → `jZ({ctx, modules, manifest, onEntryState})` → **成功后才 `EZ(s, container)` 挂载应用**（`uiRenderer.mount`）。
3. `jZ` 内：
   - 先把 roster 全部条目标 `loading`，调 `modules.entries.start(n, r)`；
   - `entries.start()`（`client-modules/lib/client.js` 行 383–399）= `Promise.all(this.desired.plugins.map(create))` —— **单条目 import 抛错即整个 start reject，无逐条目捕获**；
   - 循环后对 `fiber === undefined` 的条目标 `failed`；
   - 尾部跑 boot audit `IZ`：**任何**条目 fiber 缺失或 state≠`active` 都会被收集，`r.length>0` 就 `throw new Error("web boot: N entries did not activate…")`（含 `pending` 条目）。
4. 该 throw 被 `RZ.run` 的 catch 捕获 → `page.fail` → 应用永不挂载。

**boot 覆盖层**（`zZ` 类，`data-dsh-boot`）：`render()` 在「任一条目 failed 或全局 failure 存在」时渲染 `Failed to load plugins` 卡片（列出失败条目 id）。
成功路径下应用挂载后**未见显式 dispose 调用点**（静态搜 `[data-dsh-boot]` 移除逻辑无命中）——动态半场需确认覆盖层是靠 CSS 层级被应用界面盖住，还是靠后续状态清理。**这不影响隔离结论，但影响 B2 后「假进度卡片」的观感评估**。

结论：**冷启动是「一坏全坏」**——`makeRequire` 未命中（client.js 行 840 throw）或 factory 抛错（`materialize` 行 826 `throw error`）向上传播 → `Promise.all` 全崩 → audit throw → 整页 fail。交接文档所述机制在 0.2.1-rc.3 上仍然成立，且定位更精确。

## 3. 现行代码已有的隔离要素（L2 设计的新输入）

`reconcile()`（client.js 行 526–546）——**热更新/图同步路径已经逐条目 try/catch**，失败 `failures.push({id, message})` 不中断循环；`sync()`/`retry()` 的返回注释明确「per-package failures remain available in state」。也就是说：

- **隔离的语义骨架上游已写好**（reconcile 路径），冷启动 `start()` 只是没走同样的 try/catch；
- `importErrors` Map（`recordingImportError`）已把每条目的失败原因记录在案，audit 已能读到 `importError(n).message`。

**对 L2 的直接影响（送给 termux-dsh）**：变体 B（`materialize` catch 内降级导出）大概率不是最优解了——更小的补丁是**给 `start()` 的 `Promise.all` 换成逐条目 catch + 把失败条目标 managed-failed**，或给 `jZ`/`IZ` 的 audit 降级（把「未激活条目」从 throw 改成 warn）。**变体 A（毒化代理）仍保留**：`makeRequire` 未命中返回可归因代理，能让「缺依赖」的插件在 factory 内部就地炸成普通异常（随后被上面的隔离接住），而不是当场击穿整个 start。
原 Task 2 的「变体 B + B2 跳过 degraded 条目」在真机上可以简化验证：先 A + start 逐条目 catch，跑 fixture 看页面是否照常挂载；audit throw 是否还拦（fixture 条目会以 fiber=undefined 出现在 audit 里）——**若 audit 仍 throw，则 B2 的落点从「跳过 degraded 包」改为「audit 容忍显式登记的降级条目」**。

## 4. dshmarket 装插件走不走 `dsh plugin` CLI（决定 Task 7 形态）

**结论：走 CLI，但走的是 `node <入口绝对路径>` 直调，不经过 shell 的 `dsh` 命令。**

证据（dshmarket 1.70.2 `lib/dsh-cli.js`）：

- `dshArgv()`：优先 `process.argv[1]`（宿主 CLI 入口，正则匹配 `@deepseek-ai/dsh-desktop-host/lib/cli.js`、`bin.js`、`dsh`），拼出 `{file: nodeExecutable(), args: [...process.execArgv, abs], cwd}`，经 `spawnShim` 以 `shell:false` spawn；fallback 才是 PATH 里的 `dsh`（WIN 下经 cmd shim）。
- `pnpm-compat.js` 的 `pluginArgsFor`：add/remove 在 pnpm workspace profile 下自动加 `-w`。
- spawn 环境还会注入 pnpm/git 配置（`spawnEnv`、`gitSshCommand` 等）。

**影响**：
- plans Task 7 预设的 Termux `bin/dsh-wrapper.sh`（包装 `$PREFIX/bin/dsh`）**罩不住市场安装路径**——市场 spawn 的是 `node …/cli.js` 或 PATH 直调，且 `pluginArgsFor` 可能改参数。包装钩子降级为「手动 CLI 用户」的增强，**L3 启动自检 + doctor `--fix` 成为市场盲装的主兜底**（与 plans 原判断相反，已在报告里改判）。
- Termux 侧若让 `node` 解析到包装（`~/bin/node` 垫片），反而可能影响其他进程行为，**不建议**；市场路径的兜底就交给启动自检。
- **好桥**：dshmarket 的 CLI spawn 链会继承宿主 env——若未来把 doctor 挂进 `dsh plugin` 的真实入口（上游/官方 CLI 层），市场与手动 CLI 可同治。这是 Termux 侧 wrapper 的另一条思路：包 `$PREFIX/bin/dsh`（人用）之外，再在 profile 层面提供启动自检（机用）。

**Termux 侧待动态确认**（真机，未验证）：Termux 上 dsh 的 argv[1] 是否仍指向可解析的绝对入口（`dsh-termux` 的 bin 形态可能不同）；若 market fallback 到 PATH `dsh`，则 wrapper 仍可截获 fallback 分支。Task 1 动态半场在 Termux 上补测。

## 5. 注入顺序（Task 1 Step 4 静态结论）

- **声明面**：`dsh.client` 支持 `platform` / `inject`（string[]）/ `external`（string[]）/ `immediately`（bool），由 `parseDshClient`（index.js 行 62–76）校验。这是 doctor 可依赖的稳定声明契约。
- **注入点**：host 侧 `clientModules` 服务构造时 `ctx.on("webserver/index-inject", (table) => table.push(...bootInjections(this.composed)))`（index.js 行 571–573）；webserver 按 index-inject 顺序组装首页。
- **顺序推论**：客户端插件的 index-inject 监听注册晚于 host 的监听（host 在核心服务构造时注册），cordis 事件按注册序分发 ⇒ **不 `prepend` 的 `table.push` 稳定排在 boot 注入（含主题 style）之后**——后写覆盖，L3 的 opaque.css 无需 `!important` 即可覆盖主题 token（前提：选择器特异性相同或更高）。**此推论是静态推的，动态半场用「装 L3 → curl 首页看 style 顺序 + 截屏」复核后再固化**。
- **脚本位置**：boot 脚本走 `table.push(...bootInjections(...))`，主题 `apply()` 用 `prepend: true`；L3 的 polyfill 脚本按 plans 用 `prepend: true` 抢在主题脚本之前，样式不 prepend 排在最后——**与 plans Task 3 Step 4 的设计一致**。

## 6. L4 doctor 的环境事实（影响判据设计）

1. **WIN 桌面端没有独立 Node CLI**（PATH 无 `dsh`），但存在 CLI 载体：`resources\runtime\cli\bin\dsh.cmd` = `ELECTRON_RUN_AS_NODE=1 + DeepSeek Harness.exe --expose-internals …\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js %*`。**doctor `--fix` 在 WIN 上可用它执行 `dsh plugin remove`**（直接 spawn 该 .cmd，或指引 PATH）。
2. **宿主依赖树对 WIN doctor 不可见**：`dsh-client-*`、react 等宿主包全在 app.asar 内，profile 树里没有。**doctor 判「插件 client.js 的 require 可达性」不能只 resolve 到 `node_modules/` —— 必须把 asar 模块表算进来**，否则所有插件误判 FAIL。本报告给出两段式判据（见 §7），doctor 已按此实现（`bin/doctor.mjs`）。
3. **profile 树是 pnpm workspace**：`pnpm-workspace.yaml` 存在，`node_modules/` 平铺目录多为 symlink/junction，`require.resolve(spec, {paths})` 在 Junction 上工作正常（实测见 §7 验证记录）。真实插件（`dsh-at-file@0.7.0`）client 半区用 `dsh.client.inject` 声明宿主 UI 模块，而非在 client.js 里裸 `require`——doctor 对 `inject` 声明的可达性只能以「宿主模块表是否含该 spec」为判据。
4. **dshmarket 自带 peer 门禁**（`lib/compatibility.js` + `discovery-compatibility.js`）：按 `engines`/peer 声明做 belowMin/aboveMax 判定，discovery 层还有 24h 缓存的 on-demand manifest 索引。**doctor 不重复造轮子**：doctor 的增量价值 = ① 装后静态复检（含 dsh.client.platform/os/cpu 与 client 依赖可达性）② `--fix` 回滚出口 ③ 独立于市场 UI 的 CLI 入口。
5. **`compatibility.json`**（profile 根，desktop 实例：`{"computer-user@0.3.7": ["0.2.1-rc.2"]}`）是宿主/另一插件声明的版本兼容例外表，doctor 读到即可（显示为 INFO），不作为判据。

## 7. doctor 判据设计（静态结论，实现在 bin/doctor.mjs）

每插件按序判定：

1. **host-only 插件**（无 `dsh.client` 声明）：只验 `main` 入口存在 → PASS/SKIP。
2. **platform 声明**：`dsh.client.platform` ∈ {web, all, unspecified} → 否则 FAIL（Termux/WEB 环境不加载桌面专属 client 半区）。已核实 `parseDshClient` 要求 platform 必为 string。
3. **os/cpu**：npm `os`/`cpu` 字段与 `process.platform`/`process.arch` 交叉（android→linux 宽容映射，doctor 本身跑在 Termux/Windows 的 node 上）→ 不匹配 FAIL。
4. **client 入口存在性**：`dsh.client.entry`（缺省 `lib/client.js`）存在 → 缺 WARN。
5. **client 依赖可达性**：扫 client.js 的 `require("x")` / `import("x")` / `from "x"`（压缩代码里的普通字符串由合法包名字符集过滤剔除，避免误报）：
   - 相对路径、`node:`、`cordis:` 等 scheme、非法包名字符 → 跳过；
   - **子路径语义对齐 `stripClientSuffix`**：只有裸名与 `裸名/client` 会归一到包行，其他子路径在模块表必然 miss；
   - 命中顺序：**seed 词**（前端 staticModules 表快照）→ **profile 树**（`dsh.client.platform==="web"` 的包）→ Termux 全局树 → WIN app.asar 模块表（只读解析头部目录）；
   - 全部未命中 → FAIL（「externals 漂移」的静态预测，与 client.js 行 840 的运行时错误文案对应）。
   - **已知限定 ①**：扫描是正则级，动态拼串的 require 覆盖不到；**已知限定 ②**：try/catch 包裹的旧版回退 require（如 `dsh-at-file` 的 `require("@deepseek-ai/dsh-client-runtime/client")`，是 `dsh-client-store` 失败时的兼容回退）**静态无法区分保护性引用**——这正是 `compat/known.json` 逃生口的用武之地，首个真实条目已登记（dsh-at-file → KNOWN 并附归因说明）。

## 8. 动态半场（2026-10-31 Termux 真机完成）

真机环境：`dsh 0.2.1-rc.5-tdsh.3` / Node v24.22.1 / `process.platform = android`；完整过程与日志在
`workflow-sync/handoff/20261031-dsh-compat-Termux动态半场测试.md`。三条核心结论全部得到证据：

1. **冷启动连坐成立**：坏插件 client 侧 `require` 未命中 → 页面只剩 `Failed to load plugins` + 插件名 + 错误详情，应用 UI 完全不挂载；错误发生在浏览器侧，服务端日志 `missed the module table` 计数 0（与 §2 预判一致）。
2. **doctor 平台判据正确**：`dsh-os-linux` 在 Termux **PASS**（`process.platform==="android"` → linux 映射生效；WIN 上同项 FAIL），`dsh-os-mismatch`（darwin）FAIL，bad-plugin FAIL，good-plugin PASS，nomanifest WARN，exit=1——逐项符合预期。
3. **注入顺序是 push**：injector 的 style 落在 boot style **之后**，`table.push` 后写覆盖语义成立。

### 关键修正：夹具必须 host 可激活（已修入仓库）

`dsh-client-modules` 只扫描**已激活**的 loader entry（`lib/index.js:854-866`：要求 `entry.fiber !== void 0 && !entry.disabled`）。
只有 `exports["./client"]`、**无主入口**的包会在 host 侧 ESM 导入报 `ERR_PACKAGE_PATH_NOT_EXPORTED`，entry 永不激活 ⇒ client 半区根本不被扫描 ⇒ 页面照常。

这不是 rc.5 缺陷，而是**「host 侧失败已被 reconcile 逐条目 catch 隔离、client 侧未隔离」的分界证据**——再次确认 L2 只需补冷启动 client 路径（`start()`），host 侧无需改动。
`test/fixtures/bad-plugin`（与 `probe-profile` 内同款）已补 `main` + `exports["."]` + 空 `apply()`，client 半区一字未改。

### rc.5 环境前提（复跑动态测试必读）

- `/tmp` 不可写 → 用 `$TMPDIR`。
- **`pnpm` 未预装**：`dsh plugin add` 报 `pnpm was not found`，需先 `npm i -g pnpm`。
- 非交互 shell `PREFIX` 为空 → 全局树用 `NM="$(npm root -g)/dsh-termux/node_modules"`。
- 全新 profile 必须先 `dsh --profile <名> --from-default-profile web` 初始化。
- **`dsh plugin add` 只写 `dependencies`，不会让插件进 loader**：要真正加载，必须手工在 profile 的 `cordis.patch.yml` 写 `- insert:` 块（单条 `- id: <name>` 会报 `entry not found`）。
- `--dsw-specific-menu` 在 rc.5 已移入客户端 CSS 资源（`assets/index-*.css`），不在首页 HTML；顺序判据用「injector 在 boot style 之后」即与版本无关。

### 尚未覆盖

- L2 补丁落地后的降级复验（A + `start()` 逐条目 catch）——补丁尚未实现。
- Termux 真实 profile 目前为空集，doctor 与 WIN 10 插件结果的对齐待其装插件后重跑。
- §4 的 dshmarket argv 形态复测（Termux 未装市场）。
- 成功 boot 后覆盖层消失机制（§2 末注）。

### doctor 已完成的 WIN 侧验证（2026-10-28）

- 真实 desktop profile：11 插件 → 10 PASS + 1 KNOWN（dsh-at-file 回退例外，退出码 0）。
- fixture 判定矩阵：缺依赖 FAIL（列缺失 spec）、正常 PASS、os 不匹配 FAIL、清单缺失 WARN——全部按预期。
- `--fix --dry-run` 输出 WIN CLI 载体回滚命令（`runtime\cli\bin\dsh.cmd plugin --profile probe remove <包>`，profile 名从 `dsh-profile-probe` 正确推导）；CLI 缺失时回滚失败给出手动命令、退出码 1。

## 9. Go/No-Go

**GO**：机制、落点、判据全部静态闭环，风险点已显式列出。L2 改动面比 plans 预估更小（reconcile 已有隔离骨架，主要补冷启动 start 路径）；L3/L4 可立即开工（本会话已先落 L4 doctor）。动态半场不阻塞 L3/L4，只阻塞 L2 补丁定稿。
