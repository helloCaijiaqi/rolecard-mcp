@echo off
rem rolecard-mcp 手动启动脚本。
rem 纯资源 HTTP 服务（端口 7182）：角色卡库与渲染，无 MCP 工具注册，
rem 由 DSH bundle 里的 persona 插件直调 HTTP（/v1/bootstrap）。
rem 鉴权 token 在 state\http-token（x-mcp-token 头）。
node "%~dp0src\server.mjs"
