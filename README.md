# dsh-compat

DeepSeek Harness 插件兼容层：**L2 加载器隔离补丁** + **L3 客户端垫片** + **L4 安装门禁（doctor）**。

**契约**：插件自己**声明**的平台（`dsh.client.platform`、`os`/`cpu`、原生可选依赖）为判据。声明支持 Linux/web 的插件，在本环境上必须做到**装得上、加载不连坐、失败可见可回滚**；**不承诺**插件业务逻辑本身正确（那是上游 bug）。

## 当前状态

| 组件 | 状态 | 说明 |
|---|---|---|
| L4 门禁 `bin/doctor.mjs` | ✅ 可用（2026-10-28） | WIN 实跑 desktop profile 全 PASS；fixture 矩阵全符合 |
| L2 隔离补丁 `patches/compat/` + `bin/patch.mjs` | ✅ 真机验证（2026-10-31） | A 毒化代理 + `start()` 逐条目 catch + **B2（audit 前清 FAILED 条目）**；三态对照实测通过。Termux 打全局树（`--node-modules`），升级覆盖由 `bin/selfcheck.mjs` 只告警兜底 |
| T1 加载器勘察（spike） | ✅ 静态 + 动态半场完成 | 报告 `docs/spike-loader-isolation.md`（rc.3 静态 + Termux rc.5 真机） |
| L3 垫片 `lib/index.js` + `css/` | ⬜ 未落地 | 文件尚未创建，**暂不要把本仓整包装进 profile**（见下方安装说明） |
| T7 启动自检 `bin/selfcheck.mjs` | 🟡 脚本落地（2026-11-01，只告警） | sha256 校验补丁目标；未打/漂移/缺失时 stderr 告警、退出码恒 0。接线（Termux 包装/启动脚本）待与 termux-dsh 对齐；市场路径仍靠 doctor 手动兜底 |
| Termux 动态半场验证 | ✅ 2026-10-31 | 整页崩复现、doctor 矩阵符合（android→linux PASS）、注入顺序 push；交接见 `workflow-sync/handoff/20261031-dsh-compat-Termux动态半场测试.md` |

> 平台边界：**WIN 只上 L3+L4**——dsh 核心在 `app.asar` 内不可写，L2 加载器补丁不适用。L2 补丁的**归属**按 2026-10-31 D8 结论归本仓（原「归 termux-dsh」是 D8 前旧口径）。**目标树已定**：Termux 打全局树（`--node-modules "$(npm root -g)/dsh-termux/node_modules"`）——实测全新 profile 不物化 `@deepseek-ai/*`，宿主直走全局树（见 `handoff/20261031-dsh-compat-L2补丁真机复验.md`）。

## 安装 / 使用

**doctor 不需要安装**，克隆后直接用 Node 运行（Node ≥ 24.2）：

```bash
git clone https://github.com/Starsky16/dsh-compat.git ~/code/dsh-compat
node ~/code/dsh-compat/bin/doctor.mjs            # 自动探测 $DSH_HOME/profiles/{web,desktop}
```

整包作为插件安装（`dsh plugin add`）**要等 L3 落地后**再做：当前 `package.json` 的 `main` 指向尚不存在的 `lib/index.js`，现在安装会得到加载错误。L3 完成后本文档会更新安装步骤。

## L2 加载器隔离补丁

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

- 目标：`<node-modules>/@deepseek-ai/dsh-client-modules/lib/client.js`。`--node-modules` 直接给根；`--profile` 等价于 `<profile>/node_modules`，两者同给时以 `--node-modules` 为准。
- Termux 实测：全新 profile 的 `node_modules/@deepseek-ai` 为空，宿主直走全局树；所以生产打全局树（`$(npm root -g)/dsh-termux/node_modules`）。代价是 **升级 dsh 后补丁被覆盖**，由 `bin/selfcheck.mjs` 只告警兜底（不自动重打、不拒绝启动）。
- `--allow-drift --force`：默认对 `pristine_sha256` / `patched_sha256` 硬拒绝；两参数同给时，只有 hunk 锚点仍能匹配才强打，跳过 patched 哈希校验，`--revert` 从 `.orig` 原样恢复。**只在确认上游只是小改、且事后会验页面时用。**
- 清单：`patches/compat/manifest.json` 锁 `pristine_sha256` / `patched_sha256`；`rc.3` 与 `rc.5` 的该文件字节一致，同一补丁锚定两版，其他版本哈希不匹配即拒绝。
- 补丁内容（A + 隔离 + B2）：
  - `makeRequire` 未命中返回**毒化代理**（使用即抛，带 `[dsh-compat]` 与缺失 spec 的归因），不再击穿整个 `start()`；
  - `start()` 的 `Promise.all` 改**逐条目 catch**，import 期失败就地移除并 `console.error`；
  - **B2**：`await loader.await()` 之后、boot audit 之前，把 `fiber.state === FAILED` 且属于 `this.desired.plugins` 的条目 `loader.remove()`——毒化代理把失败从 import 期推迟到激活期，`create()` 不抛，单靠 catch 捕不到，必须靠 B2 清掉，否则 audit 仍整页崩。
- 应用器由本仓 `bin/patch.mjs` 自己解析 unified diff，不依赖 `patch` / `git apply`（WIN 上 `git apply` 会按 `core.autocrlf` 把 LF 写成 CRLF）；写文件走临时文件 + rename，不写穿 pnpm 的硬链接。
- **真机结论（2026-10-31 Termux rc.5）**：pristine 整页崩 → L2 单独仍崩（`import failed: …` 变 `failed`）→ **L2 + B2 页面正常挂载**，插件页显示完整归因。三态对照见 `workflow-sync/handoff/20261031-dsh-compat-L2补丁真机复验.md`。

## 分层

| 层 | 职责 | 归谁 |
|---|---|---|
| L1 平台层 | Android 宿主补丁（对任何插件生效） | [termux-dsh](https://github.com/Starsky16/termux-dsh) `patches/core/` |
| L2 加载器层 | 单插件加载失败不连坐整页 | **本仓** `patches/compat/` + `bin/patch.mjs`（2026-10-31 D8 起；真机已验证，Termux 打全局树） |
| **L3 客户端垫片**（本仓） | polyfill + 全局 CSS（token 不透明、低功耗） | 本仓 `lib/index.js` + `css/`（待建） |
| **L4 安装门禁**（本仓） | 声明与依赖可达性检查、可回滚 | 本仓 `bin/doctor.mjs` |

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
4. client bundle 里的裸 specifier 只能命中：前端 staticModules seed 词 / 某个 `platform==="web"` 包的 client 半区（profile 树、Termux 全局树、WIN `app.asar` 模块表）。全部落空即「externals 漂移」，判 FAIL。
5. 已知例外走 `compat/known.json`（如 try/catch 包裹的旧版回退 require），显示为 `KNOWN` 并附归因。

### 测试 fixtures

```bash
# 判定矩阵（WIN 期望：bad FAIL / good PASS / os-mismatch FAIL / os-linux FAIL / nomanifest WARN）
node bin/doctor.mjs test/fixtures/probe-profile

# Termux 期望：dsh-os-linux PASS（android→linux 映射的关键断言）
```

`test/fixtures/` 另有 `bad-plugin`（复现冷启动整页失败）与 `injector-plugin`（核对 `webserver/index-inject` 顺序），供真机动态验证使用，用法见交接文档。`bad-plugin` **必须带 `main` + `exports["."]` + 空 `apply()`**：client-modules 只扫描已激活的 entry，无主入口的包在 host 侧导不进、client 半区永不扫描，会得到假阴性（2026-10-31 Termux/rc.5 实测）。

## 仓库结构

```
dsh-compat/
├─ bin/doctor.mjs              # L4 安装门禁（可执行）
├─ bin/patch.mjs               # L2 补丁管理：check / apply / revert
├─ bin/selfcheck.mjs           # L2 启动自检：只告警，不改文件
├─ patches/compat/             # L2 补丁 + manifest（锁 pristine/patched sha256）
├─ compat/known.json           # 逃生口：已核实的人工例外
├─ docs/spike-loader-isolation.md  # 0.2.1-rc.3 加载器/契约/市场路径勘察
├─ test/fixtures/              # doctor 矩阵 + 运行时 fixture
├─ test/patch.test.mjs         # 补丁应用器 / CLI / 自检的单元与端到端测试
└─ package.json
```

## 相关

- 计划：`workflow-sync` 仓 `plans/2026-10-27-dsh插件兼容层.md`
- 跨仓事实：`docs/spike-loader-isolation.md`（冷启动整页失败链路、注入顺序、dshmarket 安装路径）
- 姊妹仓：[termux-dsh](https://github.com/Starsky16/termux-dsh)（L1 平台补丁、dsh 本体分发）

## AI 辅助声明

本仓库的代码与文档在 AI 辅助下编写，经人工审阅与测试。

## License

MIT，见 `LICENSE`。上游与第三方归属见 `NOTICE`。
