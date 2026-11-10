// 进程入口：stdio MCP（给 DSH）+ 回环 HTTP（给平台桥接）同时起。日志走 stderr，别污染 stdout。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoleStore } from './store.js';
import { createRoleService } from './service/role-service.js';
import { createGatewayAuth, createGatewayV1 } from './service/gateway-v1.js';
import { createGatewayWsConnector } from './service/ws-connector.js';
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
    // 网关 V2 接入（/v1 端点）：secret 与网关登记文件的 secret 同源；gatewayId =
    // 登记文件 id（32 位 hash，可选——不设则只验签名不比对身份头）。
    gatewaySecret: env.ROLECARD_MCP_GATEWAY_SECRET ?? '',
    gatewayId: env.ROLECARD_MCP_GATEWAY_ID ?? '',
    // 网关 WS 长连接（V2 主线）：URL 非空即启用连接器（service.call / tool.call 走帧）。
    // transport 只允许 ws|auto（fail-closed：非法值启动即失败）；权威选路仍在网关
    // service-registry（登记文件 transport 字段），这里只是连接器口径。
    gatewayWsUrl: env.ROLECARD_MCP_GATEWAY_WS_URL ?? '',
    gatewayTransport: (() => {
      const value = env.ROLECARD_MCP_GATEWAY_TRANSPORT ?? 'auto';
      if (value !== 'ws' && value !== 'auto') {
        throw new Error(`ROLECARD_MCP_GATEWAY_TRANSPORT 只支持 ws|auto（got "${value}"）`);
      }
      return value;
    })(),
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

  // 网关 V2 接入面：配了密钥才创建（未配 = /v1 端点整体缺席）。
  const gateway = cfg.gatewaySecret
    ? createGatewayV1({
      auth: createGatewayAuth({ secret: cfg.gatewaySecret, serviceId: cfg.gatewayId || undefined }),
      role,
      logger: log,
    })
    : null;

  // 网关 WS 长连接：配置了 URL 就必须给齐 id/secret（fail-closed，不静默退回 HTTP）。
  // 连接器挂 `invoke`（免验签分发，与 HTTP 入口同一组处理函数）。
  if (cfg.gatewayWsUrl) {
    if (!cfg.gatewaySecret) throw new Error('ROLECARD_MCP_GATEWAY_WS_URL 已设置，但缺少 ROLECARD_MCP_GATEWAY_SECRET');
    if (!cfg.gatewayId) throw new Error('ROLECARD_MCP_GATEWAY_WS_URL 已设置，但缺少 ROLECARD_MCP_GATEWAY_ID（登记文件 id）');
    if (!gateway) throw new Error('网关 WS 连接器需要 /v1 接入面（gateway-v1）已装配');
  }
  const wsConnector = gateway && cfg.gatewayWsUrl
    ? createGatewayWsConnector({
      url: cfg.gatewayWsUrl,
      serviceId: cfg.gatewayId,
      secret: cfg.gatewaySecret,
      transport: cfg.gatewayTransport,
      invoke: gateway.invoke,
      logger: log,
    })
    : null;

  const api = withHttp ? createHttpApi({ role, token, gateway, host: cfg.host, port: cfg.port, logger: log }) : null;
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
  if (wsConnector) {
    // 与本地 HTTP 端口无关：端口冲突降级 stdio-only 时 WS 长连接仍可工作。
    wsConnector.start();
    const status = wsConnector.status();
    log(`网关 WS 连接器已启动：${status.endpoint}（service=${status.serviceId} transport=${status.transport}）`);
  }
  // 统一退出：停连接器 → 关 HTTP server。旧实现只 stop 连接器，stdio 的 stdin
  // 还开着导致进程不退出（Ctrl+C 后要再按一次）。
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭（ws/http）…`);
    try { wsConnector?.stop(); } catch { /* 已停 */ }
    try { if (api && !httpError) await api.close(); } catch { /* 已关 */ }
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  if (stdio) {
    await serveStdio({ role });
    log('stdio MCP 已连接');
  }
  return { cfg, store, role, api: httpError ? null : api, token, httpError, wsConnector };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((error) => {
    console.error('[rolecard-mcp] 启动失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
