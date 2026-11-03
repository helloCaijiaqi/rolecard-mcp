// 进程入口：stdio MCP（给 DSH）+ 回环 HTTP（给平台桥接）同时起。日志走 stderr，别污染 stdout。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoleStore } from './store.js';
import { createRoleService } from './service/role-service.js';
import { createHttpApi } from './http-api.js';
import { serveStdio } from './mcp-rolecard.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 可降级的端口错误：被占用 / 无权限。其余错误（参数非法等）仍然快速失败。 */
const PORT_CONFLICT_CODES = new Set(['EADDRINUSE', 'EACCES']);

export function resolveConfig(env = process.env) {
  const stateDir = path.resolve(env.ROLECARD_MCP_STATE_DIR ?? path.join(PKG_ROOT, 'state'));
  return {
    rolesDir: path.resolve(env.ROLECARD_MCP_ROLES_DIR ?? path.join(PKG_ROOT, 'roles')),
    stateDir,
    port: Number(env.ROLECARD_MCP_HTTP_PORT ?? 7182),
    host: '127.0.0.1',
    token: env.ROLECARD_MCP_TOKEN ?? '',
    tokenFile: path.join(stateDir, 'http-token'),
  };
}

function ensureToken(cfg) {
  if (cfg.token) return cfg.token;
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  try {
    const existing = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* 还没生成过 */
  }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(cfg.tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(cfg.tokenFile, 0o600);
  } catch {
    /* Windows 上可能不支持 */
  }
  return token;
}

export async function start({ env = process.env, stdio = true, http: withHttp = true, logger } = {}) {
  const cfg = resolveConfig(env);
  const log = logger ?? ((...args) => console.error('[rolecard-mcp]', ...args));
  const token = ensureToken(cfg);

  const store = createRoleStore({ rolesDir: cfg.rolesDir, stateDir: cfg.stateDir });
  const role = createRoleService({ store });

  const api = withHttp ? createHttpApi({ role, token, host: cfg.host, port: cfg.port, logger: log }) : null;
  // 与 memory-mcp 同一策略：端口抢不到只降级 HTTP，stdio（DSH 的工具面）照常接管。
  let httpError = null;
  if (api) {
    try {
      await api.listen();
      log(`回环 HTTP 已监听 http://${cfg.host}:${cfg.port}`);
    } catch (error) {
      if (!PORT_CONFLICT_CODES.has(error?.code)) throw error;
      httpError = error;
      log(`回环 HTTP 未启动（${error.code} ${cfg.host}:${cfg.port}）：已降级为 stdio-only，MCP 工具仍可用；qq-bridge 将回落本地人格卡`);
    }
  }
  if (stdio) {
    await serveStdio({ role });
    log('stdio MCP 已连接');
  }
  return { cfg, store, role, api: httpError ? null : api, token, httpError };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((error) => {
    console.error('[rolecard-mcp] 启动失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
