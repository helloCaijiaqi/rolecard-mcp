// 进程入口：stdio MCP（给 DSH）+ 回环 HTTP（给平台桥接）同时起。日志走 stderr，别污染 stdout。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRoleStore } from './store.js';
import { createRoleService } from './service/role-service.js';
import { createGatewayAuth, createGatewayV1 } from './service/gateway-v1.js';
import { createGatewayWatcher } from './gateway-watch.js';
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
    // 网关接入：唯一来源是仓库根目录的 gateway.json——但不在 resolveConfig 里
    // 读取（启动期一次性绑定是「注册后必须重启」的根源）。改由 start() 里的
    // createGatewayWatcher 热加载：文件出现/修复/变更 ≤2s 自动生效。旧
    // *_GATEWAY_* 环境变量已退役，设置了会直接报错（检测挪进 watcher）。
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

  // 网关接入面（热加载）：gateway.json 出现/修复/变更 ≤2s 自动生效，无需重启。
  // /v1/tools/call 常挂载——未生效时返回 503 带文案，而不是端点整体缺席。
  const gatewayWatcher = createGatewayWatcher({ root: PKG_ROOT, env, envPrefix: 'ROLECARD_MCP_', logger: log });

  // 内部 handler 惰性装配：首个有效配置出现时创建（auth 持有 nonce 防重放表）；
  // 之后配置变更走 auth.rotate 原地换密钥——防重放窗口不重置，业务依赖不重建。
  let gatewayInner = null;
  let gatewayAuthHandle = null;
  const ensureGatewayHandler = (config) => {
    if (!gatewayInner) {
      gatewayAuthHandle = createGatewayAuth({ secret: config.secret, serviceId: config.id || undefined });
      gatewayInner = createGatewayV1({ auth: gatewayAuthHandle, role, logger: log });
    } else {
      gatewayAuthHandle.rotate({ secret: config.secret, serviceId: config.id || undefined });
    }
    return gatewayInner;
  };

  // 传输按角色非对称：资源服务纯被动（网关 → 本服务的 HTTP tool.call 是唯一
  // 通道，WS 能力已退役），接入生效就必须给齐 id/secret（tool.call 验签要）。
  // 读取器 + watcher 已保证 config 存在时字段齐全。
  const gateway = {
    async handle({ path, headers, rawBody }) {
      const { config, error } = gatewayWatcher.current();
      if (!config) {
        return {
          status: 503,
          body: {
            error: `网关接入未生效（${error ? `gateway.json 非法：${error}` : '未找到 gateway.json'}）。`
              + '把网关生成的 handoff/<id>.gateway.json 复制到本仓库根目录命名 gateway.json，'
              + '≤2s 自动热加载，无需重启。',
          },
        };
      }
      return ensureGatewayHandler(config).handle({ path, headers, rawBody });
    },

    /**
     * /v1/bootstrap（2026-11-20，免认证——鸡生蛋：调用方拿 secret 前无法签名）。
     * DSH persona 插件（rolecard-persona）启动时拉取连接配置：toolCallPath /
     * adapterId（验签必需的身份头）/ secret——全部 gateway.json 单源，热加载
     * 自动跟随。安全边界=回环 HTTP 守卫（LOOPBACK）；secret 明文经环回吐出
     * 与 gateway.json/密钥文件落盘同级（单用户主机本地可信模型）。
     */
    async bootstrap() {
      const { config, error } = gatewayWatcher.current();
      if (!config) {
        return {
          status: 503,
          body: { error: `网关接入未生效（${error ?? '未找到 gateway.json'}），bootstrap 不可用` },
        };
      }
      return {
        status: 200,
        body: { v: 1, toolCallPath: '/v1/tools/call', adapterId: config.id, secret: config.secret },
      };
    },
  };

  const initialGateway = gatewayWatcher.current();
  log(initialGateway.config
    ? `网关接入：${initialGateway.file}（id=${initialGateway.config.id} auth=${initialGateway.config.auth} `
      + `transport=${initialGateway.config.transport}；热加载 ≤2s，无需重启）`
    : `网关接入：未生效（${initialGateway.error ? `gateway.json 非法：${initialGateway.error}` : '未找到 gateway.json'}）；`
      + '放入/修复后自动热加载，无需重启；stdio MCP 照常可用');

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
  // 统一退出：关 HTTP server。旧实现只 stop 连接器，stdio 的 stdin
  // 还开着导致进程不退出（Ctrl+C 后要再按一次）。
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal}，正在关闭（http）…`);
    // 2026-11-21 审计修复：close 兜底超时——api.close() 理论上会因
    // closeIdleConnections 生效而快速返回，但任何 keep-alive 连接正处于
    // 中间态时仍可能卡住；3s 后强制退出，不让 shutdown 悬挂。
    try {
      await Promise.race([
        (async () => { if (api && !httpError) await api.close(); })(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch { /* 已关 */ }
    try { gatewayWatcher.stop(); } catch { /* 已关 */ }
    process.exit(0);
  };
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  if (stdio) {
    await serveStdio({ role });
    log('stdio MCP 已连接');
  }
  return { cfg, store, role, api: httpError ? null : api, token, httpError, gatewayWatcher };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  start().catch((error) => {
    console.error('[rolecard-mcp] 启动失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}
