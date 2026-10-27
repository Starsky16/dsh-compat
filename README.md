# dsh-compat

dsh 插件兼容层（L3 客户端垫片 + L4 安装门禁）。

**契约**：插件自己**声明**的平台（`dsh.client.platform`、`os`/`cpu`、原生可选依赖）为判据。声明支持 Linux/web 的插件，在本环境上必须做到**装得上、加载不连坐、失败可见可回滚**；**不承诺**插件业务逻辑本身正确（那是上游 bug）。

## 安装

```bash
git clone https://github.com/Starsky16/dsh-compat.git ~/dsh-compat
dsh plugin --profile web add ~/dsh-compat
```

## 分层

| 层 | 职责 | 归谁 |
|---|---|---|
| L1 平台层 | Android 宿主补丁（对任何插件生效） | [termux-dsh](https://github.com/Starsky16/termux-dsh) `patches/core/` |
| L2 加载器层 | 单插件加载失败不连坐整页 | termux-dsh `patches/compat/` |
| **L3 客户端垫片**（本仓） | polyfill + 全局 CSS（token 不透明、低功耗） | 本仓 `lib/index.js` + `css/` |
| **L4 安装门禁**（本仓） | 声明与依赖可达性检查 | 本仓 `bin/doctor.mjs` |

## 用法

```bash
# 门禁：装前/装后检查某 profile 的插件
node ~/dsh-compat/bin/doctor.mjs [DSH_HOME 的 profile 目录]
node ~/dsh-compat/bin/doctor.mjs --fix     # FAIL 项逐个给出并执行回滚
```

## License

MIT。上游与第三方归属见 `NOTICE`。
