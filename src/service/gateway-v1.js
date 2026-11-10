// 网关 V2 P3 接入面：POST /v1/service/call（装饰器契约）+ POST /v1/tools/call（工具调用契约）。
//
// rolecard-mcp 以「自主登记的装饰器服务」身份接入 agent-gateway 管线：人格块
// 注入走 service.call，模型侧的 chat_role_* 工具调用经网关 ToolHost 转发到
// tools.call。桥接（qq-bridge 等）继续走 /api/*。
//
// 鉴权：网关出站 HMAC（agent-gateway auth.mjs v1 格式，与 x-mcp-token 并存）：
//   x-adapter-id: <登记 hash id>
//   x-timestamp:  毫秒
//   x-nonce:      随机串（带 LRU 防重放缓存）
//   x-signature:  v1=<hex hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(rawBody))>
// 与 memory-mcp 的 service/gateway-v1.js 同构（两仓约定互持同形副本，不引共享包）。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class GatewayAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayAuthError';
  }
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createGatewayAuth({
  secret,
  serviceId,
  now = Date.now,
  windowMs = 5 * 60 * 1000,
  capacity = 100_000,
} = {}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createGatewayAuth 需要至少 16 字符的网关共享密钥（ROLECARD_MCP_GATEWAY_SECRET）');
  }
  // serviceId 可选（与 memory-mcp 同口径）：只配 secret 的部署仅验签名，不钉身份；
  // 配了就要求 `x-adapter-id` 完全一致。此前强制必填与 server.mjs 注释相反，
  // 按文档部署会直接起不来。
  const seen = new Map();
  const sha256Hex = (body) => createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const hmacHex = (payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  function prune(at) {
    for (const [, expiresAt] of seen) {
      if (expiresAt > at) break;
      seen.delete(seen.keys().next().value);
    }
    while (seen.size > capacity) seen.delete(seen.keys().next().value);
  }

  return {
    /** 抛 GatewayAuthError = 401；通过返回 { serviceId }。 */
    verify({ headers, rawBody }) {
      const id = headers['x-adapter-id'];
      const tsRaw = headers['x-timestamp'];
      const nonce = headers['x-nonce'];
      const sigRaw = headers['x-signature'];
      if (!id || !tsRaw || !nonce || !sigRaw) throw new GatewayAuthError('缺少网关签名头');
      if (serviceId && id !== serviceId) throw new GatewayAuthError('登记身份不匹配');
      const ts = Number(tsRaw);
      if (!Number.isSafeInteger(ts) || Math.abs(now() - ts) > windowMs) {
        throw new GatewayAuthError('时间戳超出重放窗口');
      }
      const expected = hmacHex(`${ts}\n${nonce}\n${sha256Hex(rawBody)}`);
      if (!sigRaw.startsWith('v1=') || !safeEqualHex(sigRaw.slice(3), expected)) {
        throw new GatewayAuthError('签名不匹配');
      }
      prune(now());
      const key = `${id}:${nonce}`;
      if (seen.has(key)) throw new GatewayAuthError('nonce 已使用（疑似重放）');
      seen.set(key, now() + windowMs);
      return { serviceId: id };
    },
  };
}

function requireText(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  if (value.length > max) throw new Error(`${field} 过长（上限 ${max}）`);
  return value;
}

export function createGatewayV1({ auth, role, logger } = {}) {
  const log = logger ?? (() => {});
  if (!role) throw new Error('createGatewayV1 需要 role service');

  const tools = {
    chat_role_list: () => ({ roles: role.list(), current: role.current() }),
    chat_role_get: (args) => role.get(args),
    chat_role_sections: (args) => ({ sections: role.sections(args) }),
    chat_role_render: (args) => role.render(args),
  };

  /** 装饰器：人格块注入。verdict 恒 pass，无当前角色 = 空 sections（不编造）。 */
  async function serviceCall(request) {
    if (request.v !== 1) throw new Error('service.call 只支持 v=1');
    requireText(request.callId, 'callId');
    requireText(request.sessionKey, 'sessionKey', 256);
    try {
      const rendered = role.render({
        mode: request.mode === 'v1' ? 'v1' : 'v2',
        maxChars: Number.isSafeInteger(request.maxChars) ? request.maxChars : undefined,
      });
      const sections = (rendered?.blocks ?? [])
        .filter((block) => typeof block?.text === 'string' && block.text.trim())
        .map((block) => ({ name: block.name, text: block.text, priority: 0 }));
      return { v: 1, callId: request.callId, verdict: 'pass', sections };
    } catch (error) {
      log(`service.call 装饰失败（放行）：${error?.message ?? error}`);
      return { v: 1, callId: request.callId, verdict: 'pass', sections: [] };
    }
  }

  async function toolsCall(request) {
    if (request.v !== 1) throw new Error('tools.call 只支持 v=1');
    requireText(request.callId, 'callId');
    const tool = requireText(request.tool, 'tool', 128);
    const handler = tools[tool];
    if (!handler) {
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_UNSUPPORTED', message: `未知工具：${tool}（支持：${Object.keys(tools).join('、')}）` },
      };
    }
    const args = request.args && typeof request.args === 'object' ? request.args : {};
    try {
      const data = await handler(args);
      return { v: 1, callId: request.callId, ok: true, data };
    } catch (error) {
      log(`tools.call ${tool} 业务失败：${error?.message ?? error}`);
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_ACTION', message: String(error?.message ?? error) },
      };
    }
  }

  const endpoints = new Map([
    ['/v1/service/call', (request) => serviceCall(request)],
    ['/v1/tools/call', (request) => toolsCall(request)],
  ]);

  /**
   * 分发（已鉴权的请求体）：HTTP 与 WS 两个入口共用。
   * 帧入口（ws-connector）不重复验签——握手即鉴权，且 secret 只有网关与本服务知道。
   */
  async function invoke({ path, request }) {
    const handler = endpoints.get(path);
    if (!handler) return { status: 404, body: { error: `未知路由：${path}` } };
    if (!request || typeof request !== 'object') return { status: 400, body: { error: '请求体必须是对象' } };
    try {
      return { status: 200, body: await handler(request) };
    } catch (error) {
      const callId = typeof request?.callId === 'string' ? request.callId : undefined;
      log(`gateway-v1 ${path} 契约错误：${error?.message ?? error}`);
      return { status: 400, body: { error: String(error?.message ?? error), ...(callId ? { callId } : {}) } };
    }
  }

  return {
    toolNames: () => Object.keys(tools),
    /** WS 帧入口：不验签（握手即鉴权），直接分发。 */
    invoke,
    async handle({ path, headers, rawBody }) {
      if (!auth) return { status: 503, body: { error: '网关接入未配置（ROLECARD_MCP_GATEWAY_SECRET 未设置）' } };
      try {
        auth.verify({ headers, rawBody });
      } catch (error) {
        return { status: 401, body: { error: String(error?.message ?? error) } };
      }
      let request;
      try {
        request = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return { status: 400, body: { error: '请求体不是合法 JSON' } };
      }
      return invoke({ path, request });
    },
  };
}
