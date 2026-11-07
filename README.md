# dsh-compat

让 DeepSeek Harness（dsh）的插件在 **Termux / Linux** 上「装得上、崩了不连坐、坏了看得见」的兼容层。

一个插件加载失败时，dsh 默认会**整页白屏**（应用完全起不来）；移动端弹层还可能整体透明。dsh-compat 解决这两个问题，外加一个装插件前的体检工具。

## 它解决什么问题

| 你遇到的症状 | 对应组件 | 效果 |
|---|---|---|
| 装了个坏插件，dsh 整页白屏起不来 | **L2 加载器隔离补丁** | 只有坏插件被停用并给出原因，其它插件和页面照常 |
| 弹出菜单/下拉是透明或半透明的，看不清 | **L3 客户端垫片** | 菜单/弹层改为不透明实色（自动适配深浅色），模糊一并关闭 |
| 手机上 UI 动画卡顿 | **L3 客户端垫片** | 触屏设备自动关闭高开销的模糊与动画 |
| 不知道一个插件能不能装 | **L4 doctor 体检** | 装前检查平台声明与依赖，装不了会告诉你为什么 |

## 安装

**环境要求**：dsh（官方版或 [termux-dsh](https://github.com/Starsky16/termux-dsh)）；Node ≥ 24.2。

三种方式任选其一（装完即生效，无需手工改配置）：

```bash
# ① 一行命令直装（推荐，自动跟随 GitHub 仓库）
dsh plugin --profile <你的profile名> add https://github.com/Starsky16/dsh-compat.git

# ② 锁定版本：从 https://github.com/Starsky16/dsh-compat/releases 下载 .tgz 后
dsh plugin --profile <你的profile名> add ./dsh-compat-0.1.4.tgz

# ③ 本地开发：clone 后指向目录
git clone https://github.com/Starsky16/dsh-compat.git
dsh plugin --profile <你的profile名> add ./dsh-compat
```

**体检工具（doctor）单独用**，不用装进 profile：

```bash
git clone https://github.com/Starsky16/dsh-compat.git
node dsh-compat/bin/doctor.mjs        # 逐个报告 profile 里插件的体检结果
```

## 各平台支持情况

| 平台 | 隔离补丁（L2） | 垫片（L3） | 体检（L4） |
|---|---|---|---|
| **Termux**（[termux-dsh](https://github.com/Starsky16/termux-dsh)） | ✅ 全部 | ✅ | ✅ |
| **Linux / macOS 桌面** | 自动探测，没找到相关组件就静默跳过 | ✅ | ✅ |
| **Windows 桌面** | ❌ 不支持（官方 dsh 的核心文件打包在 app.asar 内，不可修改） | ✅ | ✅ |

装完重启 dsh 即生效。之后**升级 dsh 后**如果看到「L2 补丁未就绪」的提示，按提示重跑一次补丁命令即可（见[进阶说明](CONTRIBUTING.md)）。

## 常见问题

**装完没有效果？** 重启 dsh（插件在启动时注入）。Termux 用户确认用的是 termux-dsh 的 dsh。

**「L2 补丁未就绪」警告是什么？** 你刚升级过 dsh，隔离补丁被覆盖了。警告不影响启动，按提示重打即可恢复隔离能力。

**想关掉某个功能？** 环境变量 `DSH_COMPAT_DISABLE_L2_SELFCHECK=1` 关闭补丁自检；L3 的弹层修复与性能开关随插件启停，卸载插件即全部还原（补丁用 `bin/patch.mjs --revert` 撤销）。

**菜单还是半透明的？** 0.1.3 起 L3 会把菜单材质**锁定为不透明**（不再跟随宿主主题，也没有开关）；如果仍是半透明，说明新版没加载——重启 dsh，并确认 profile 里的 dsh-compat 是 0.1.3 及以上。

**插件本身有 bug？** 本仓只管「装得上、崩了不连坐」，不修插件业务逻辑——那要找插件作者。

---

更多文档：

- **[CONTRIBUTING.md](CONTRIBUTING.md)** —— 补丁机制原理、doctor 判据、环境变量开关、仓库结构、参与开发
- [docs/compat.md](docs/compat.md) —— 各环境兼容性覆盖矩阵（已验证 / 未验证 / 不支持）
- [docs/spike-loader-isolation.md](docs/spike-loader-isolation.md) —— 加载器机制勘察报告

## AI 辅助声明

本仓库的代码与文档在 AI 辅助下编写，经人工审阅与测试。

## License

MIT，见 `LICENSE`。上游与第三方归属见 `NOTICE`。
