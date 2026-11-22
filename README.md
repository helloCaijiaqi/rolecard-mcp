# rolecard-mcp

角色卡 / 人格管理。与 qq-bridge **平级部署**，是 memory-mcp 的兄弟包，与 QQ 无关。

- 角色卡读写（`roles/*.md`）、当前角色（切换为部署期动作，见下）
- 〔一代〕/〔二代〕 小节解析：先按标记筛掉另一模式的专属小节，再按注入上限截断
- 产出可直接拼接的【人格】段
- 读缓存 key 含 **文件名 + mtime + size**：只看 mtime 会在"同一 tick 内重写角色卡"时命中旧值

## 用法

```bash
npm install
npm start          # stdio MCP（DSH）+ 回环 HTTP（127.0.0.1:7182）
npm test           # 全量单测
npm run migrate    # 从 qq-bridge/roles 复制式导入（原件不动，留 .bak）
npm run backup     # 目录快照到 state/backups/，保留最近 7 份
npm run install:dsh # 把 mcp-rolecard 登记进 DSH（--global / --check / --remove）
```

## 接口

| 入口 | 说明 |
| --- | --- |
| stdio MCP | `role_list / role_get / role_sections / role_context_render`（4 工具） |
| 回环 HTTP | 同上能力的 `/api/*` 路由 + 角色切换（`/api/role/current`、`/api/role/clear`）；只监听 127.0.0.1，非回环 403，需本地令牌 |
| 网关 tool.call | `chat_role_render / chat_role_list / chat_role_get / chat_role_sections`（4 工具，HMAC 签名） |

**两侧工具面 4 对 4 一致**（`chat_` 前缀映射 `role_*`；`chat_role_render` ≙ `role_context_render` 语义等价）：
模型可见的工具不包含角色切换——切换不注册进 MCP/网关工具面，属部署期/运维动作，经回环 HTTP
`POST /api/role/current`（`{"name":"角色名"}`）、`POST /api/role/clear` 或手改
`state/current-role.json`（写 `{"role":"角色名"}`）完成。

段落契约：

```js
role_context_render({ mode: 'v1' | 'v2', maxChars })
  -> { blocks: [{ name: '人格', text, chars }], truncated }
```

## 角色卡

`roles/*.md` 是纯文本人格卡，文件名即角色名（`roles/我的角色.md` → `我的角色`）。仓库只带一张中性示例卡 `roles/example.md`：

1. 复制示例卡改成自己的卡：`cp roles/example.md roles/我的角色.md`；
2. 切到该角色（部署期动作，不占模型工具位）：直接在 `state/current-role.json` 写 `{"role":"我的角色"}`，或回环 HTTP `POST /api/role/current`（body `{"name":"我的角色"}`）；清除当前角色用 `POST /api/role/clear` 或删掉该文件；
3. 以 `## 标题 〔一代〕` / `## 标题 〔二代〕` 结尾的小节只在该模式注入，无标记的小节两种模式都注入。

个人角色卡默认被 `.gitignore` 排除（`roles/*.md` + `!roles/example.md`），不会被误提交。

## 装进 DSH

本服务自己负责 DSH 侧的登记（`scripts/install-dsh.mjs`，与 memory-mcp 的同名脚本同构），不依赖 qq-bridge 的 `setup-dsh.mjs`：

```bash
npm run install:dsh              # web profile（默认）
npm run install:dsh -- work      # 指定 profile
npm run install:dsh -- --global  # home 层，所有 profile 生效
npm run install:dsh -- --check   # 只检查（未登记 / 路径不符时退出码 1）
npm run install:dsh -- --remove  # 卸载
```

- 只写自己那段 `# === rolecard-mcp MCP BEGIN/END ===` 区块，`cordis.patch.yml` 里其他内容一个字节不动；
- 写完**不用**重启 DSH（条目热加载），新建会话即可看到 `mcp__rolecard__*`；
- 换机 / 换目录后必须重跑——patch 里存的是绝对路径；
- 若曾跑过 `qq-bridge/scripts/setup-dsh.mjs`：它会整体重写 patch、把区块标记抹掉。条目仍在、工具照常可用（`--check` 也会通过），要让本脚本重新纳管就先删掉那条 `mcp-rolecard` 条目再重跑。

## 配置

| 变量 | 默认 |
| --- | --- |
| `ROLECARD_MCP_HTTP_PORT` | `7182` |
| `ROLECARD_MCP_TOKEN` | 自动生成并存 `state/http-token`（`0o600`） |
| `ROLECARD_MCP_DATA_DIR` | `<包>/roles` |

详见 qq-bridge 的 `docs/guides/ROLECARD_MCP.md`。

## 网关接入（`gateway.json`）

`tool.call`（唯一服务间信封；`service.call` 已全链路下线）的凭据与地址**只从仓库根目录的 `gateway.json` 读取**（不再读
`*_GATEWAY_*` 环境变量——设了会直接报错，避免「改了却不生效」）。传输按角色非对称：资源服务纯被动，
网关只经 HTTP `POST /v1/tools/call` 调用本服务（WS 能力已退役）。

网关侧登记（Agent-Gateway 控制台）：`kind=resource`、`transport=http`、`url` 填本服务地址
（如 `http://127.0.0.1:7182`，仅回环）；secret 可留空由网关自动生成，交接文件
`state/gateway/handoff/<登记id>.gateway.json` 直接拿去改名。登记文件禁止未知键
（strictObject，残留 `capability` 之类直接拒载）。

三步：

```bash
# ① 网关侧注册服务后生成（agent-gateway 仓库，控制台注册也会直接返回路径）
npm run handoff -- --service <登记id>        # 或注册响应里的 handoffFile
# ② 复制到本仓库根目录，保持文件名
cp <gateway>/state/gateway/handoff/<登记id>.gateway.json ./gateway.json
# ③ 启动（日志会打印读的是哪个文件、什么身份、密钥从哪来）
npm start
```

| 字段 | 说明 |
| --- | --- |
| `v` | 固定 `1` |
| `id` | 登记文件 id（32 位 hash 或可读 id）。与网关逐字一致，否则验签 401 |
| `url` | **网关基址**（如 `http://127.0.0.1:7190`）。⚠️ 不是本服务地址 |
| `transport` | 只支持 `http`（缺省同值）；资源服务纯被动，WS 已退役，配 `ws`/`auto` 启动即报错（带迁移文案） |
| `secretFile` | 网关侧密钥文件的路径；相对路径按 `gateway.json` 所在目录解析 |
| `secret` | 内联明文（跨机复制用）；与 `secretFile` 并存时以 `secretFile` 为准并告警 |

- **文件缺失 = 不接入网关**：`/v1` 不启用，stdio MCP（DSH 工具面）照常可用；启动日志与
  `npm run preflight` 都会给出提示。
- **热加载（2026-11-14 起）**：gateway.json 的出现、修复、换密钥 ≤2s 自动生效，**无需重启**。
  /v1/tools/call 常挂载——未生效时返回 503 带修复文案。文件非法或被移除 → 网关接入摘除
  （503）+ 告警日志；修复后自动恢复。变更检测按内容哈希轮询，网关重注册/换密钥重写文件即触发。
- 文件存在但字段非法（如 `transport` 非 `http`）→ /v1 返回 503 摘除并告警（不带着坏凭据服务）；
  修复后自动恢复，不再要求重启。
- 部署前提（缺一即验签 401）：登记目录里有本服务且 secret 与 `gateway.json` 一致；
  transport 须为 `http`（网关 → 本服务的 HTTP tool.call 是唯一通道）。
- `gateway.json` 含凭据：已加入 `.gitignore`，模板见 `gateway.example.json`。

## 许可

MIT，见 [LICENSE](LICENSE)。
