# dsh-compat：插件页「兼容性」tab + L4-B + engines.dsh + L2 退役 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 按任务顺序执行；每个任务先写失败测试，再实现，再跑测试，最后 commit。步骤用 `- [ ]` 跟踪。
> 计划文件：`docs/plans/2026-11-15-compat-tab-l2-retire.md`（本文件）。

**Goal:** 在插件页暴露 dsh-compat 的兼容性结论（tab + 详情 badge），把 L2 状态并入 doctor（L4-B），声明 `engines.dsh`，并让 L2 补丁在 dsh 0.2.2-rc.3 上正确退役（不再漂移告警）。

**Architecture:** 新增 `lib/l2.mjs` 与 `lib/doctor-core.mjs`（纯函数、可被 CLI 与 host 半区共用）；host 启动时算一份状态并通过 `webserver/index-inject` 注入 `window.__DSH_COMPAT_STATUS__`；新增 `lib/client.js`（手写 client 半区）只读该全局，注册 `plugins.tab` 与 `plugins.detail.badge`。L2 走「manifest 记录退役哈希」方案，`patch.mjs` / `selfcheck.mjs` / doctor 三处统一识别。

**Tech Stack:** Node ≥ 24.2（ESM）、node:test、零第三方依赖；宿主 client 半区为 `window.__ModuleLoader__.load({id,factory})` 形态，用 `require("react")` + `require("@deepseek-ai/dsh-client-ui-primitives")`（平台 seed 词）。

---

## 前置事实（2026-11-15 已核实）

| 项 | 值 |
|---|---|
| PR #12948 | **已合并**（awesome-dsh-plugin/awesome-dsh-plugin，2026-11-10T00:43:47Z）；本条无需再动 |
| 当前宿主 | `dsh 0.2.2-rc.3-tdsh.2` |
| rc.3 `client-modules/lib/client.js` | sha256 `fc491b97b5d923446faf9ebff238dba6d1f8a55b03e8bf71bea90355ee33bec6`，25,831 B，单行压缩 |
| rc.3 `start()` | 已内建逐条目 catch：`await this.create(loader,id).catch(error=>{loader.ctx.logger.error(error)})` |
| rc.3 `audit` / B2 目标 | `client.js` 内 **0 处** `audit`；`FAILED` 仍存在但只在 `reconcile()` 里处理重试 |
| rc.3 `makeRequire` | 未命中仍 `throw new Error(...)`（无上游毒化代理） |
| 宿主 `engines.dsh` | 安装/更新前置检查读取 `engines.dsh`（`dsh-plugin-manager` 的 requirements 记录） |
| 插件页 slot | `plugins.tab`（list）、`plugins.detail.badge`（list），第三方可注册；市场「发现」卡片不可注入 |
| 当前 L2 状态 | manifest 仍锚 0.2.2-rc.1 `74e834b8…`，在 rc.3 上 `--check` 报 **DRIFT** |

**L2 决策（本计划采纳）：退役。** 理由：A（逐条目 catch）已由上游吸收；B2 目标代码已不在该包；毒化代理的归因价值已被上游 `logger.error` 覆盖。保留旧锚点仅用于 0.2.2-rc.1/rc.2 的旧宿主；rc.3 通过 manifest 的 `retired` 哈希识别为「无需补丁」。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/l2.mjs` | 新增 | 统一 L2 状态（含 retired / drift / patched / skip）与宿主版本读取 |
| `lib/doctor-core.mjs` | 新增 | 从 `bin/doctor.mjs` 抽出的纯检查核心：`createDoctor({...}).audit()`、`defaultProfileDir()` |
| `bin/doctor.mjs` | 改造 | 变薄 CLI：参数、打印、`--fix`、`--json`、退出码 |
| `bin/patch.mjs` | 修改 | `inspect()` 识别 `target.retired.sha256`；apply/revert 对 retired 为 no-op |
| `bin/selfcheck.mjs` | 修改 | retired 不计入 issue |
| `lib/index.js` | 修改 | 计算状态、注入全局、L2 自检改用 `l2Status` |
| `lib/client.js` | 新增 | client 半区：兼容性 tab + 详情 badge |
| `patches/compat/manifest.json` | 修改 | target 增加 `retired` 字段 |
| `package.json` | 修改 | `exports["./client"]`、`dsh.client`、`engines.dsh` |
| `cordis.patch.yml` | 修改 | 去掉「不得声明 dsh.client」的旧注释 |
| `test/l2.test.mjs` | 新增 | retired/patched/drift/skip 四态 |
| `test/doctor-core.test.mjs` | 新增 | auditProfile 结果 + L2 段 + `--json` |
| `test/client.test.mjs` | 新增 | client bundle 契约、tab/badge 注册与渲染 |
| `test/l3.test.mjs` | 修改 | 反转「纯 host」断言；新增注入断言 |
| `README.md` / `CONTRIBUTING.md` / `docs/compat.md` | 修改 | 新能力、engines、L2 退役说明 |

---

### Task 1: L2 状态模块与 retired 识别

**Files:**
- Create: `lib/l2.mjs`
- Modify: `patches/compat/manifest.json`
- Modify: `bin/patch.mjs`
- Test: `test/l2.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/l2.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { l2Status, hostVersion } from "../lib/l2.mjs";
import { sha256, inspect } from "../bin/patch.mjs";

function fixture(contents, retiredSha) {
  const nm = mkdtempSync(join(tmpdir(), "dsh-l2-"));
  const lib = join(nm, "@deepseek-ai/dsh-client-modules", "lib");
  mkdirSync(lib, { recursive: true });
  const file = join(lib, "client.js");
  writeFileSync(file, contents);
  const manifestPath = join(nm, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    schema: 1,
    targets: [{
      id: "t", pkg: "@deepseek-ai/dsh-client-modules", rel: "lib/client.js",
      patch: "p.patch", create: false,
      pristine_sha256: sha256("pristine"),
      patched_sha256: sha256("patched"),
      retired: { upstream: "0.2.2-rc.3", sha256: retiredSha ?? sha256("retired") },
    }],
  }));
  return { nm, manifestPath };
}

test("l2Status：retired 哈希优先于 drift", () => {
  const { nm, manifestPath } = fixture("retired");
  try {
    const status = l2Status({ nodeModules: nm, manifestPath });
    assert.equal(status.state, "retired");
    assert.equal(status.retired, true);
  } finally { rmSync(nm, { recursive: true, force: true }); }
});

test("l2Status：未知哈希仍是 drift", () => {
  const { nm, manifestPath } = fixture("something-else");
  try {
    assert.equal(l2Status({ nodeModules: nm, manifestPath }).state, "drift");
  } finally { rmSync(nm, { recursive: true, force: true }); }
});

test("l2Status：没有宿主树时 state=skip", () => {
  assert.equal(l2Status({ nodeModules: null }).state, "skip");
});

test("hostVersion：从 dsh-termux/package.json 读取", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-l2-host-"));
  try {
    const nm = join(root, "dsh-termux", "node_modules");
    mkdirSync(nm, { recursive: true });
    writeFileSync(join(root, "dsh-termux", "package.json"), JSON.stringify({ version: "0.2.2-rc.3-tdsh.2" }));
    assert.equal(hostVersion(nm), "0.2.2-rc.3-tdsh.2");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/l2.test.mjs`
Expected: FAIL `Cannot find module '../lib/l2.mjs'`。

- [ ] **Step 3: 实现 `lib/l2.mjs`**

同时把 `lib/index.js` 里的 `nodeModuleCandidateRoots()` / `defaultNodeModules()` **搬入** `lib/l2.mjs`（实现原样），并在 `lib/index.js` 用 `export { defaultNodeModules, nodeModuleCandidateRoots } from "./l2.mjs";` 重导出（保持 `test/l3.test.mjs` 现有 import 不变）。doctor 侧因此可以 `import { defaultNodeModules } from "./l2.mjs"`，避免 `index → doctor-core → index` 循环。

```js
/**
 * dsh-compat · L2 状态（host 半区 / doctor / selfcheck 共用）。
 * 只读：不写文件、不执行补丁。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inspect, readManifest } from "../bin/patch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANIFEST = resolve(HERE, "..", "patches", "compat", "manifest.json");

/** dsh-termux 的版本（nodeModules 的父目录）；读不到返回 null。 */
export function hostVersion(nodeModules) {
  if (!nodeModules) return null;
  try {
    return JSON.parse(readFileSync(join(dirname(nodeModules), "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {{nodeModules?: string|null, manifestPath?: string}} options
 * @returns {{anchor:string|null, state:string, why:string, retired:boolean, sha256:string|null, file:string|null}}
 */
export function l2Status({ nodeModules, manifestPath } = {}) {
  const manifest = readManifest(manifestPath ?? DEFAULT_MANIFEST);
  const target = manifest.targets[0];
  const anchor = manifest.base?.upstream ?? null;
  if (!nodeModules) {
    return { anchor, state: "skip", why: "未找到宿主树", retired: false, sha256: null, file: null };
  }
  const info = inspect(target, nodeModules);
  const retired = info.state === "retired";
  return {
    anchor,
    state: retired ? "retired" : info.state,
    why: retired ? info.why : (info.why ?? ""),
    retired,
    sha256: info.got ?? null,
    file: info.file ?? null,
  };
}
```

- [ ] **Step 4: `manifest.json` 增加 retired 字段**

在 `targets[0]` 末尾追加：

```json
"retired": {
  "upstream": "0.2.2-rc.3",
  "sha256": "fc491b97b5d923446faf9ebff238dba6d1f8a55b03e8bf71bea90355ee33bec6",
  "note": "0.2.2-rc.3 的 dsh-client-modules 已内建 start() 逐条目 catch，且 audit/B2 目标代码已迁出该包 ⇒ 无需补丁；哈希命中即视为已退役（不判漂移）。"
}
```

同时把 `base.upstream` 改为 `0.2.2-rc.3`、`verified_against` 追加 `0.2.2-rc.3`，并更新 `note` 说明「旧 rc.1 锚点保留给旧宿主，rc.3 走 retired」。

- [ ] **Step 5: `bin/patch.mjs` 支持 retired**

1) `inspect()` 在计算 `got` 之后、比较 pristine 之前插入：

```js
if (target.retired !== undefined && got === target.retired.sha256) {
  return { state: "retired", why: `上游 ${target.retired.upstream} 已无需补丁（退役）`, file, got };
}
```

2) `applyOne()` 开头：`if (info.state === "retired") return info;`（放在 `patched` 判断之后）。
3) `revertOne()` 开头：`if (info.state === "retired") return info;`（retired 不是我们打的，不能 revert）。
4) `LABELS` 增加 `retired: "retire"`。
5) 统计：`if (info.state === "patched" || info.state === "retired") done++;`；`check` 的通过条件保持 `drifted === 0 && todo === 0`。

- [ ] **Step 6: 运行测试**

Run: `node --test test/l2.test.mjs test/patch.test.mjs`
Expected: 全部 PASS。

- [ ] **Step 7: 实机确认**

Run: `node bin/patch.mjs --check --node-modules /data/data/com.termux/files/usr/lib/node_modules/dsh-termux/node_modules`
Expected: `retire @deepseek-ai/dsh-client-modules/lib/client.js`，退出码 0，不再出现 DRIFT。

- [ ] **Step 8: Commit**

```bash
git add lib/l2.mjs test/l2.test.mjs patches/compat/manifest.json bin/patch.mjs
git commit -m "feat(l2): 识别 0.2.2-rc.3 退役哈希，L2 状态收口到 lib/l2.mjs"
```

---

### Task 2: selfcheck / L3 激活自检识别 retired

**Files:**
- Modify: `bin/selfcheck.mjs`
- Modify: `lib/index.js`（只改 `l2Selfcheck` 循环）
- Test: `test/l2.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test("selfcheck：retired 不计入 issue（CLI 退出 0 且 ready）", () => {
  const { nm, manifestPath } = fixture("retired");
  try {
    const out = spawnSync(process.execPath, [join(ROOT, "bin/selfcheck.mjs"),
      "--node-modules", nm, "--manifest", manifestPath, "--json"], { encoding: "utf8" });
    const report = JSON.parse(out.stdout);
    assert.equal(report.ready, true);
  } finally { rmSync(nm, { recursive: true, force: true }); }
});
```

（`spawnSync` 与 `ROOT` 在文件头导入：`import { spawnSync } from "node:child_process";`、`const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");`）

- [ ] **Step 2: 运行确认失败** — `node --test test/l2.test.mjs` → 新增用例 FAIL。

- [ ] **Step 3: 实现**

`bin/selfcheck.mjs` 循环内：

```js
if (info.state === "patched" || info.state === "retired") continue;
```

`lib/index.js` 的 `l2Selfcheck()`：

```js
if (info.state === "patched" || info.state === "retired") continue;
```

- [ ] **Step 4: 跑测试** — `node --test test/l2.test.mjs` → PASS。

- [ ] **Step 5: Commit**

```bash
git add bin/selfcheck.mjs lib/index.js test/l2.test.mjs
git commit -m "fix(l2): retired 视为就绪，启动自检不再误报"
```

---

### Task 3: 抽 doctor-core（L4-B：L2 并入 + --json）

**Files:**
- Create: `lib/doctor-core.mjs`
- Modify: `bin/doctor.mjs`
- Test: `test/doctor-core.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/doctor-core.test.mjs
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createDoctor, defaultProfileDir } from "../lib/doctor-core.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(ROOT, "test", "fixtures", "probe-profile");

test("createDoctor：fixture 四种判据（PASS / FAIL / WARN / os 映射）", () => {
  const doctor = createDoctor({ profileDir: PROBE, repoRoot: ROOT, platform: "linux", arch: "x64", env: {} });
  const rows = doctor.audit();
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.verdict]));
  assert.equal(byName["dsh-good-plugin"], "PASS");
  assert.equal(byName["dsh-bad-plugin"], "FAIL");
  assert.equal(byName["dsh-os-mismatch"], "FAIL");
  assert.equal(byName["dsh-os-linux"], "PASS");
  assert.equal(byName["dsh-nomanifest"], "WARN");
});

test("defaultProfileDir：优先 web，其次 desktop", () => {
  assert.match(defaultProfileDir({ DSH_HOME: "/tmp/x" }), /profiles\/web$/);
});
```

- [ ] **Step 2: 运行确认失败** — `node --test test/doctor-core.test.mjs` → `Cannot find module`。

- [ ] **Step 3: 新建 `lib/doctor-core.mjs`**

把 `bin/doctor.mjs` 中以下函数**原样**搬入 `createDoctor()` 闭包（实现不改，只把自由变量改为闭包变量）：`readPkgJson`、`clientExportOf`、`isClientHalf`、`asar`、`reachClientHalf`、`platformMatches`、`loadKnown`、`checkAll`（改名为 `audit`）。`SEED_WORDS` 提升到模块级。

模块骨架：

```js
import { readFileSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { bareName, scanSpecs } from "./specscan.mjs";

export const SEED_WORDS = [ /* 原样从 bin/doctor.mjs 复制 */ ];

export function defaultProfileDir(env = process.env) {
  const dshHome = env.DSH_HOME ?? join(env.HOME ?? env.USERPROFILE ?? "", ".dsh");
  for (const name of ["web", "desktop"]) {
    const dir = join(dshHome, "profiles", name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return join(dshHome, "profiles", "web");
}

export function createDoctor({ profileDir, repoRoot, env = process.env, platform = process.platform, arch = process.arch }) {
  const profile = resolve(profileDir);
  const profilePkg = JSON.parse(readFileSync(join(profile, "package.json"), "utf8"));
  const osWant = platform === "android" ? "linux" : platform;
  const cpuWant = arch;

  function hostTreeDirs() {
    if (env.DSH_GLOBAL_TREE) return [env.DSH_GLOBAL_TREE];
    if (platform === "android") return ["/data/data/com.termux/files/usr/lib/node_modules/dsh-termux/node_modules"];
    return [];
  }
  // …其余函数原样搬入（它们引用上面的闭包变量）…

  function audit() {
    // 原 checkAll() 函数体；把 `profilePkg` / `osWant` / `cpuWant` 等直接引用闭包变量
  }

  return { profile, profilePkg, audit };
}
```

注意：`loadKnown()` 里 `join(REPO_ROOT, "compat", "known.json")` 改为 `join(repoRoot, "compat", "known.json")`。

- [ ] **Step 4: 运行测试** — `node --test test/doctor-core.test.mjs` → PASS。

- [ ] **Step 5: 改造 `bin/doctor.mjs` 为薄 CLI**

保留参数解析、`printRows`、`removeCommandFor`、`runFix`、`main`；把顶部 `profile`/`profilePkg`/`profileName` 计算移入 `main()`，并改为：

```js
import { createDoctor, defaultProfileDir } from "../lib/doctor-core.mjs";
import { defaultNodeModules, l2Status } from "../lib/l2.mjs";

// 在 main() 里、参数解析之后：
const doctor = createDoctor({ profileDir: profile, repoRoot: REPO_ROOT });
const rows = doctor.audit();
const l2 = l2Status({ nodeModules: defaultNodeModules() });
```

- [ ] **Step 6: 增加 L2 输出与 `--json`**

`printRows` 之前先打印 L2 段（不算 FAIL）：

```js
function printL2(l2) {
  console.log(`L2  ${l2.state}${l2.anchor ? `（锚定 ${l2.anchor}）` : ""}${l2.why ? `  ${l2.why}` : ""}`);
}
```

`main()` 里 `--json` 分支输出：

```js
process.stdout.write(`${JSON.stringify({
  profile, generatedAt: new Date().toISOString(),
  l2: { anchor: l2.anchor, state: l2.state, why: l2.why, retired: l2.retired, sha256: l2.sha256 },
  plugins: rows.map(({ name, verdict, missing, notes }) => ({ name, verdict, missing, notes })),
  summary: {
    fail: rows.filter((r) => r.verdict === "FAIL").length,
    warn: rows.filter((r) => r.verdict === "WARN").length,
    known: rows.filter((r) => r.verdict === "KNOWN").length,
  },
}, null, "\t")}\n`);
```

退出码保持不变：L2 不参与退出码。

- [ ] **Step 7: 回归**

Run: `node --test test/doctor-core.test.mjs test/doctor-scan.test.mjs test/l3.test.mjs`
Expected: 全 PASS（`doctor-scan` 仍通过 CLI 断言）。

- [ ] **Step 8: 实机**

Run: `node bin/doctor.mjs` → 7 个插件 FAIL 0，且第一行 `L2  retired（锚定 0.2.2-rc.3）`。
Run: `node bin/doctor.mjs --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.l2.state, j.summary)})"` → `retired { fail: 0, … }`。

- [ ] **Step 9: Commit**

```bash
git add lib/doctor-core.mjs bin/doctor.mjs test/doctor-core.test.mjs
git commit -m "feat(doctor): 抽出 doctor-core 并并入 L2 状态与 --json（L4-B）"
```

---

### Task 4: host 半区注入状态

**Files:**
- Modify: `lib/index.js`
- Test: `test/l3.test.mjs`

- [ ] **Step 1: 写失败测试（追加到 `test/l3.test.mjs`）**

```js
test("apply：注入 __DSH_COMPAT_STATUS__（含 L2 与插件结论）且转义 </script>", () => {
  const handlers = [];
  const ctx = { on(event, fn) { handlers.push(fn); } };
  apply(ctx);
  const table = [];
  for (const handler of handlers) handler(table);
  const script = table.find((row) => row.kind === "script" && row.text.includes("__DSH_COMPAT_STATUS__"));
  assert.ok(script, "必须注入状态全局");
  assert.ok(!script.text.includes("</script>"), "注入内容不得提前闭合 script");
  assert.equal(script.placement, "body");
});
```

- [ ] **Step 2: 运行确认失败** — `node --test test/l3.test.mjs` → 找不到该 script 行。

- [ ] **Step 3: 实现（`lib/index.js`）**

新增导入与函数：

```js
import { createDoctor, defaultProfileDir } from "./doctor-core.mjs";
import { hostVersion, l2Status } from "./l2.mjs";

function escapeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildCompatStatus({ env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const nodeModules = defaultNodeModules(env);
  const doctor = createDoctor({ profileDir: defaultProfileDir(env), repoRoot: ROOT, env, platform, arch });
  return {
    host: { version: hostVersion(nodeModules) },
    l2: l2Status({ nodeModules }),
    plugins: doctor.audit().map(({ name, verdict, missing, notes }) => ({ name, verdict, missing, notes })),
    generatedAt: new Date().toISOString(),
  };
}

function compatStatusScript() {
  try {
    return `window.__DSH_COMPAT_STATUS__ = ${escapeForScript(buildCompatStatus())};`;
  } catch (error) {
    return `window.__DSH_COMPAT_STATUS__ = ${escapeForScript({ error: String(error?.message ?? error), plugins: [] })};`;
  }
}
```

在 `apply()` 的 style 注入监听之后追加：

```js
ctx.on("webserver/index-inject", (table) => {
  table.push({ kind: "script", placement: "body", text: compatStatusScript() });
});
```

- [ ] **Step 4: 运行测试** — `node --test test/l3.test.mjs` → PASS。若测试环境的 `DSH_HOME` 指向真实 profile 导致慢，测试前设置 `DSH_HOME` 到 `test/fixtures/probe-profile` 的父级临时目录（`auditProfile` 读 `profiles/<name>/package.json`，因此需临时建 `profiles/web` 并拷 fixture 内容；最小做法：测试内 `process.env.DSH_HOME = join(ROOT, "test/fixtures")` 并新建 `test/fixtures/profiles/web/package.json` → 不推荐入库；改为在测试里 `mkdtemp` + `cpSync`）。

- [ ] **Step 5: Commit**

```bash
git add lib/index.js test/l3.test.mjs
git commit -m "feat(l3): 启动时注入 __DSH_COMPAT_STATUS__ 供插件页读取"
```

---

### Task 5: client 半区（兼容性 tab + 详情 badge）

**Files:**
- Create: `lib/client.js`
- Modify: `package.json`（exports + dsh.client）
- Modify: `cordis.patch.yml`、`lib/index.js` 头注
- Modify: `test/l3.test.mjs`（反转旧断言）
- Test: `test/client.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// test/client.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadClient(status) {
  let registration;
  const sandbox = {
    window: { __ModuleLoader__: { load: (reg) => { registration = reg; } } },
    document: { head: { append() {} }, createElement: () => ({ dataset: {}, textContent: "", remove() {} }) },
    console,
  };
  if (status !== undefined) sandbox.__DSH_COMPAT_STATUS__ = status;
  vm.runInNewContext(readFileSync(join(ROOT, "lib", "client.js"), "utf8"), sandbox);
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  };
  const mod = registration.factory((spec) => {
    if (spec === "react") return React;
    throw new Error(`unexpected require ${spec}`);
  });
  return { registration, mod, React };
}

test("client bundle：id 正确，导出 apply 与 inject", () => {
  const { registration, mod } = loadClient();
  assert.equal(registration.id, "dsh-compat");
  assert.equal(typeof mod.apply, "function");
  assert.deepEqual(Array.from(mod.inject), ["slots"]);
});

test("client apply：注册 plugins.tab 与 plugins.detail.badge", () => {
  const { mod } = loadClient();
  const registered = [];
  const ctx = {
    effect: (fn) => { fn(); },
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, Component) => { registered.push({ options, Component }); },
    },
  };
  mod.apply(ctx);
  const names = registered.map((r) => r.options.name).sort();
  assert.deepEqual(names, ["plugins.detail.badge", "plugins.tab"]);
});

test("CompatBadge：非 bundle subject 返回 null，FAIL 行渲染文本", () => {
  const { mod, React } = loadClient({
    plugins: [{ name: "bad-plugin", verdict: "FAIL", missing: ["x"], notes: [] }],
  });
  const registered = [];
  mod.apply({ effect: (fn) => fn(), slots: { inject: (_n, cb) => cb(), register: (o, C) => registered.push({ o, C }) } });
  const badge = registered.find((r) => r.o.name === "plugins.detail.badge").C;
  assert.equal(badge({ subject: { kind: "item", id: "x" } }), null);
  const tree = badge({ subject: { kind: "bundle", pkg: { name: "bad-plugin" } } });
  assert.equal(tree.type, "span");
  assert.match(tree.children.join(""), /不可用/);
});
```

同时把 `test/l3.test.mjs` 的 `包保持纯 host…` 用例改为：

```js
test("client 半区声明成对：dsh.client 与 exports["./client"] 必须同时存在", () => {
  const pkg = JSON.parse(text(join(ROOT, "package.json")));
  assert.equal(pkg.dsh?.client?.platform, "web");
  assert.equal(pkg.exports?.["./client"]?.default, "./lib/client.js");
  assert.ok(existsSync(join(ROOT, "lib", "client.js")));
});
```

- [ ] **Step 2: 运行确认失败** — `node --test test/client.test.mjs` → 文件不存在。

- [ ] **Step 3: 新建 `lib/client.js`**

```js
/**
 * dsh-compat · client 半区：插件页「兼容性」tab + 详情 badge。
 * 数据只读宿主注入的 window.__DSH_COMPAT_STATUS__（见 lib/index.js）。
 */
window.__ModuleLoader__.load({
  id: "dsh-compat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var GLOBAL = "__DSH_COMPAT_STATUS__";
    var CSS = ".dsh-compat-section{padding:16px 0;display:flex;flex-direction:column;gap:12px}" +
      ".dsh-compat-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}" +
      ".dsh-compat-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
      ".dsh-compat-row{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:13px}" +
      ".dsh-compat-name{font-weight:600}" +
      ".dsh-compat-detail{color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".dsh-compat-tag{font-size:11px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}" +
      ".dsh-compat-tag[data-verdict=FAIL]{color:var(--dsw-alias-state-error-primary)}" +
      ".dsh-compat-tag[data-verdict=WARN]{color:var(--dsw-alias-state-warn-primary)}";

    function readStatus() {
      var value = globalThis[GLOBAL];
      return value !== null && typeof value === "object" ? value : null;
    }

    function verdictText(verdict) {
      if (verdict === "PASS") return "兼容";
      if (verdict === "WARN") return "注意";
      if (verdict === "KNOWN") return "已知例外";
      return "不可用";
    }

    function CompatSection() {
      var status = readStatus();
      if (status === null) return React.createElement("p", { className: "dsh-compat-meta" }, "兼容性报告尚未生成：重启 dsh 后可见。");
      var l2 = status.l2 || {};
      var rows = Array.isArray(status.plugins) ? status.plugins : [];
      return React.createElement("div", { className: "dsh-compat-section" },
        React.createElement("p", { className: "dsh-compat-meta" },
          "宿主 " + ((status.host && status.host.version) || "未知") +
          " · L2 " + (l2.state || "unknown") +
          (l2.anchor ? "（锚定 " + l2.anchor + "）" : "")),
        rows.length === 0
          ? React.createElement("p", { className: "dsh-compat-meta" }, "没有可检查的插件。")
          : React.createElement("ul", { className: "dsh-compat-list" },
            rows.map(function (row) {
              return React.createElement("li", { key: row.name, className: "dsh-compat-row" },
                React.createElement("span", { className: "dsh-compat-name" }, row.name),
                React.createElement("span", { className: "dsh-compat-tag", "data-verdict": row.verdict }, verdictText(row.verdict)),
                row.missing && row.missing.length
                  ? React.createElement("span", { className: "dsh-compat-detail" }, "缺失: " + row.missing.join(", "))
                  : null,
                row.notes && row.notes.length
                  ? React.createElement("span", { className: "dsh-compat-detail" }, row.notes.join("；"))
                  : null);
            })));
    }

    function CompatBadge(props) {
      var status = readStatus();
      var subject = props && props.subject;
      if (status === null || !subject || subject.kind !== "bundle") return null;
      var name = subject.pkg && subject.pkg.name;
      var row = (Array.isArray(status.plugins) ? status.plugins : []).find(function (item) { return item.name === name; });
      if (!row || row.verdict === "PASS") return null;
      return React.createElement("span", {
        className: "dsh-compat-tag",
        "data-verdict": row.verdict,
        title: (row.notes || []).join("；"),
      }, verdictText(row.verdict));
    }

    function apply(ctx) {
      ctx.effect(function () {
        if (typeof document === "undefined") return function () {};
        var style = document.createElement("style");
        style.dataset.plugin = "dsh-compat";
        style.textContent = CSS;
        document.head.append(style);
        return function () { style.remove(); };
      }, "dsh-compat: compatibility styles");
      ctx.slots.inject("plugins.tab", function () {
        return ctx.slots.register({ name: "plugins.tab", id: "compat", label: function () { return "兼容性"; }, order: 20 }, CompatSection);
      });
      ctx.slots.inject("plugins.detail.badge", function () {
        return ctx.slots.register({ name: "plugins.detail.badge", id: "compat", order: 20 }, CompatBadge);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
```

- [ ] **Step 4: `package.json`**

```json
"exports": {
  ".": { "default": "./lib/index.js" },
  "./client": { "default": "./lib/client.js" },
  "./package.json": "./package.json"
},
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

同时 `cordis.patch.yml` 与 `lib/index.js` 头注删掉「不得声明 dsh.client」旧说明，替换为「client 半区与 `exports["./client"]` 必须成对，见 CONTRIBUTING」。

- [ ] **Step 5: 跑测试**

Run: `node --test test/client.test.mjs test/l3.test.mjs`
Expected: PASS。

- [ ] **Step 6: 真实组合验证（隔离 profile）**

```bash
T="${TMPDIR:-${PREFIX:-/tmp}/tmp}"; rm -rf "$T/dsh-compat-verify"
dsh --profile compatverify --from-default-profile web --port 8099 --no-open --host 127.0.0.1 >"$T/compatverify.log" 2>&1 &
sleep 15; grep -o 'http://127.0.0.1:8099/?token=[^ ]*' "$T/compatverify.log" | tail -1
```

用 token 抓首页，断言 `__DSH_BOOT__` 里出现 `"id":"dsh-compat"`，且 `plugins/??dsh-compat/client.js` 可取到（200）。验证后 kill 实例、删 profile。

- [ ] **Step 7: Commit**

```bash
git add lib/client.js package.json cordis.patch.yml lib/index.js test/client.test.mjs test/l3.test.mjs
git commit -m "feat(client): 插件页兼容性 tab 与详情 badge（0.1.6）"
```

---

### Task 6: engines.dsh 与文档

**Files:**
- Modify: `package.json`（`engines.dsh`）
- Modify: `README.md`、`CONTRIBUTING.md`、`docs/compat.md`
- Test: `test/l3.test.mjs`（追加）

- [ ] **Step 1: 写失败测试**

```js
test("package：engines.dsh 声明 >=0.2.1-rc.3（不设上界）", () => {
  const pkg = JSON.parse(text(join(ROOT, "package.json")));
  assert.equal(pkg.engines?.dsh, ">=0.2.1-rc.3");
});
```

- [ ] **Step 2: 运行确认失败** → `node --test test/l3.test.mjs`。

- [ ] **Step 3: 修改 `package.json`**

```json
"engines": {
  "node": ">=24.2",
  "dsh": ">=0.2.1-rc.3"
}
```

- [ ] **Step 3b: 文档**

- `README.md`：安装段加一行「从插件市场搜索 `dsh-compat` 安装（已收录）」；「它解决什么问题」表加一行「想知道某个插件能不能加载 → 插件页 → 兼容性」；FAQ 加「兼容性 tab 显示不可用怎么办」。
- `CONTRIBUTING.md`：L4 节补 `doctor-core`/`--json`/L2 段；L2 节改为「0.2.2-rc.3 起退役（retired 哈希），旧锚点仅服务旧宿主」；L3 节补 client 半区与 slot。
- `docs/compat.md`：覆盖矩阵补「插件页兼容性 tab」「engines.dsh 门禁」，L2 行更新为 retired。

- [ ] **Step 4: 跑测试** — `node --test` 全绿。

- [ ] **Step 5: Commit**

```bash
git add package.json README.md CONTRIBUTING.md docs/compat.md test/l3.test.mjs
git commit -m "feat(pkg): 声明 engines.dsh，补兼容性 tab/L2 退役文档"
```

---

### Task 7: 发版 0.1.6 与生产换装（需用户确认）

**Files:** `package.json`（version 0.1.6）、`README.md`（版本示例）

- [ ] **Step 1: 全量回归** — `npm test` 全绿；`node bin/doctor.mjs` FAIL 0、L2 retired。
- [ ] **Step 2: 版本 0.1.6**，`node --check lib/client.js lib/index.js lib/doctor-core.mjs lib/l2.mjs`。
- [ ] **Step 3: commit + push dev → main**（`git push https://github.com/Starsky16/dsh-compat.git dev:dev`，`git ls-remote` 核对）。
- [ ] **Step 4: 触发 Release**：

```bash
gh workflow run release.yml --repo Starsky16/dsh-compat --ref main -f version=0.1.6 -F prerelease=false
sleep 8
RUN=$(gh run list --repo Starsky16/dsh-compat --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN" --repo Starsky16/dsh-compat --exit-status
```

- [ ] **Step 5: 换装**：`dl-asset Starsky16/dsh-compat v0.1.6 dsh-compat-0.1.6.tgz` → 拷入 `~/.dsh/plugins/compat/` → `dsh plugin --profile web add ./dsh-compat-0.1.6.tgz` → 用户重启后验证插件页出现「兼容性」tab 且 L2 显示 retired。
- [ ] **Step 6: 更新 `~/.dsh/plugins/compat/SHA256SUMS`**（只留 0.1.6），清理 0.1.5 tgz。

---

### Task 8: 交接回填与记忆

**Files:** `workflow-sync/handoff/20261114-dsh-compat-L2锚点适配dsh0.2.2-rc.3.md`、`workflow-sync/memory/repos/dsh-compat.md`、`dsh-compat.log.md`

- [ ] **Step 1: handoff**：状态改 `已完结`，抬头下补 `> 结论：`；追加 `## 执行结果`（rc.3 退役决策、证据、`--check` 输出、发布日期）。
- [ ] **Step 2: 记忆**：结论文件更新（0.1.6、engines.dsh、兼容性 tab、L2 retired、doctor-core/`--json`）；日志追加 2026-11-15 条目。
- [ ] **Step 3: 同轮 commit + push**（workflow-sync 直连 URL，`ls-remote` 核对）。

---

## 验收清单

- [ ] `node --test` 全绿（新增 l2/doctor-core/client 三组用例）。
- [ ] `node bin/patch.mjs --check --node-modules "$NM"` 退出 0，输出 `retire`（rc.3）。
- [ ] `node bin/doctor.mjs`：L2 retired + 7 插件 FAIL 0；`--json` 含 `l2` 与 `summary`。
- [ ] 临时 profile 页面 boot graph 含 `dsh-compat` client 行，client bundle 200。
- [ ] 生产重启后：插件页出现「兼容性」tab；dsh-compat 详情页显示「兼容」；L2 不再告警。
- [ ] `engines.dsh` 已声明；`dsh plugin add` 在 rc.3 上不被拒。
- [ ] handoff 已完结、记忆已推送。

## 风险与回滚

1. **client 半区导致页面异常**：rc.3 已内建逐条目 catch，坏 client 只会被隔离；若出现白屏，先用 `dsh plugin --profile web remove dsh-compat` 回滚，再查 `window.__DSH_COMPAT_STATUS__` 注入内容是否含 `</script>`。
2. **engines.dsh 过严**：当前选 `>=0.2.1-rc.3` 无上界；若未来 0.3 不兼容，再补上界。
3. **L2 retired 误判**：retired 以 sha256 精确匹配，不会误伤其他版本；旧宿主仍走原锚点。
4. **计划外的 rc.3 结构变化**：若 `client.js` 哈希变化（如 rc.4），`retired` 不匹配、退回 DRIFT，按原流程重锚或更新 retired 哈希。
