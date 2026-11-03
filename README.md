# rolecard-mcp

角色卡 / 人格管理。与 qq-bridge **平级部署**，是 memory-mcp 的兄弟包，与 QQ 无关。

- 角色卡读写（`roles/*.md`）、当前角色切换
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
```

## 接口

| 入口 | 说明 |
| --- | --- |
| stdio MCP | `role_list / role_get / role_set_current / role_clear_current / role_sections / role_context_render` |
| 回环 HTTP | 同上能力的 `/api/*` 路由；只监听 127.0.0.1，非回环 403，需本地令牌 |

段落契约：

```js
role_context_render({ mode: 'v1' | 'v2', maxChars })
  -> { blocks: [{ name: '人格', text, chars }], truncated }
```

## 角色卡

`roles/*.md` 是纯文本人格卡，文件名即角色名（`roles/我的角色.md` → `我的角色`）。仓库只带一张中性示例卡 `roles/example.md`：

1. 复制示例卡改成自己的卡：`cp roles/example.md roles/我的角色.md`；
2. 切到该角色：MCP 工具 `role_set_current({ role: '我的角色' })`，或直接在 `state/current-role.json` 写 `{"role":"我的角色"}`；
3. 以 `## 标题 〔一代〕` / `## 标题 〔二代〕` 结尾的小节只在该模式注入，无标记的小节两种模式都注入。

个人角色卡默认被 `.gitignore` 排除（`roles/*.md` + `!roles/example.md`），不会被误提交。

## 配置

| 变量 | 默认 |
| --- | --- |
| `ROLECARD_MCP_HTTP_PORT` | `7182` |
| `ROLECARD_MCP_TOKEN` | 自动生成并存 `state/http-token`（`0o600`） |
| `ROLECARD_MCP_DATA_DIR` | `<包>/roles` |

详见 qq-bridge 的 `docs/guides/ROLECARD_MCP.md`。

## 许可

MIT，见 [LICENSE](LICENSE)。
