// 网关接入面：POST /v1/tools/call（tool.call 统一改造后的唯一服务间信封）。
//
// rolecard-mcp 以「自主登记的装饰器服务」身份接入 agent-gateway 管线：人格块
// 注入（chat_role_render，decorator）与会话间的 chat_role_* 工具调用共用 tool.call
// 信封（service.call 已全链路下线）。桥接（qq-bridge 等）继续走 /api/*。
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
    throw new Error('createGatewayAuth 需要至少 16 字符的网关共享密钥（来自仓库根目录 gateway.json 的 secret / secretFile）');
  }
  // serviceId 可选（与 memory-mcp 同口径）：只配 secret 的部署仅验签名，不钉身份；
  // 配了就要求 `x-adapter-id` 完全一致。此前强制必填与 server.mjs 注释相反，
  // 按文档部署会直接起不来。
  const seen = new Map();
  // 密钥可热轮换（gateway.json 热加载，与 memory-mcp 同口径）：HMAC 与 id 比对
  // 都读当前值；rotate 时 fail-closed（非法密钥拒收，保留旧值）。
  let currentSecret = secret;
  let currentServiceId = serviceId;
  const sha256Hex = (body) => createHash('sha256').update(body ?? '', 'utf8').digest('hex');
  const hmacHex = (payload) => createHmac('sha256', currentSecret).update(payload, 'utf8').digest('hex');

  function prune(at) {
    // 2026-11-21 audit fix: while forward-scan (no monotonic assumption).
    while (seen.size > 0) {
      const [firstKey, firstExpires] = seen.entries().next().value;
      if (firstExpires > at) break;
      seen.delete(firstKey);
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
      if (currentServiceId && id !== currentServiceId) throw new GatewayAuthError('登记身份不匹配');
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

    /**
     * 原地轮换凭据（gateway.json 热加载用）：换 secret / serviceId，防重放
     * nonce 表保留（窗口内旧 nonce 依然不能重放）。非法新值整体拒收。
     */
    rotate({ secret: nextSecret, serviceId: nextServiceId }) {
      if (typeof nextSecret !== 'string' || nextSecret.length < 16) {
        throw new Error('rotate 需要至少 16 字符的网关共享密钥');
      }
      currentSecret = nextSecret;
      currentServiceId = nextServiceId;
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

  // ── 工具面（单值 role，tool.call 统一改造）────────────────────────────────
  // decorator 步骤：args 恒 {}（行为由 role 决定），context.senderId 当前无消费
  // （人格与对话对象无关；留作未来个性化接口）。tool 步骤：模型可调。
  const tools = {
    // decorator：人格块注入，结果契约 { sections }（无 epoch——rolecard 无会话
    // 纪元状态；缺 epoch = 网关按 sections 全量拼接）。verdict/改写职责归 filter，
    // 本服务不表达。无当前角色 = 空 sections（不编造）。失败 fail-safe 放行。
    chat_role_render: async (_args, ctx) => {
      try {
        const rendered = role.render({});
        const sections = (rendered?.blocks ?? [])
          .filter((block) => typeof block?.text === 'string' && block.text.trim())
          .map((block) => ({ name: block.name, text: block.text, priority: 0 }));
        return { sections };
      } catch (error) {
        // 宁放行不误杀：装饰失败等价于「本轮没有人格段」，网关管线同样 fail-safe。
        log(`chat_role_render 装饰失败（放行）${ctx?.senderId ? ` sender=${ctx.senderId}` : ''}：${error?.message ?? error}`);
        return { sections: [] };
      }
    },
    chat_role_list: () => ({ roles: role.list(), current: role.current() }),
    // 管理面唯一写工具（2026-11-21 收敛）：切当前角色。读（list/get）走 chat_role_list，
    // 编辑（写）已迁本服务 /admin 回环管理页——不再占用工具命名空间。
    chat_role_switch: (args) => {
      if (typeof args?.name !== 'string' || !/^[\w\u4e00-\u9fa5-]{1,64}$/.test(args.name)) throw new Error('name 非法');
      return role.setCurrent({ name: args.name });
    },
  };

  /** 工具调用（唯一信封）：业务失败以 ok:false 正常返回（HTTP 仍 200），网关原样透传。 */
  async function toolsCall(request) {
    if (request.v !== 1) throw new Error('tool.call 只支持 v=1');
    requireText(request.callId, 'callId');
    // sessionKey 可选（2026-11-21，与 memory-mcp 同形）：角色卡工具与消息会话
    // 无关，强制必填只会逼调用方造假值；有则限长校验，无则放行。
    if (request.sessionKey != null) requireText(request.sessionKey, 'sessionKey', 256); // != null：null 视为未传
    const tool = requireText(request.tool, 'tool', 128);
    const handler = tools[tool];
    if (!handler) {
      return {
        v: 1, callId: request.callId, ok: false,
        // 2026-11-21 审计修复：不回显支持的工具清单（内部能力面不泄漏给探测）。
        error: { code: 'E_UNSUPPORTED', message: `未知工具：${tool}` },
      };
    }
    const args = request.args && typeof request.args === 'object' ? request.args : {};
    const context = request.context && typeof request.context === 'object' ? request.context : {};
    const ctx = { sessionKey: request.sessionKey, senderId: context.senderId, text: context.text };
    try {
      const data = await handler(args, ctx);
      return { v: 1, callId: request.callId, ok: true, data };
    } catch (error) {
      log(`tools.call ${tool} 业务失败：${error?.message ?? error}`);
      return {
        v: 1, callId: request.callId, ok: false,
        error: { code: 'E_ACTION', message: String(error?.message ?? error) },
      };
    }
  }

  // ── 工具清单（GET /v1/tools；控制台「拉取清单预填」的数据源）────────────────
  // 与上方 tools 分发表同源：增删工具必须同步维护本清单。role 是网关视角的
  // 参考预填值（decorator=可进管线编排；登记文件里最终 role 由操作者确认）。
  const TOOL_MANIFEST = [
    // render 不在清单（2026-11-21）：DSH persona 插件 bootstrap+HMAC 直调，不经
    // 网关——列进清单只会让登记/管线把它当 decorator。清单 = 网关控制面板工具面。
    { name: 'chat_role_list', role: 'tool', description: '列出可用角色卡与当前角色', inputSchema: { type: 'object' } },
    { name: 'chat_role_switch', role: 'tool', description: '切换当前角色（调用方须自行处理会话退役）', inputSchema: { type: 'object' } },
  ];

  const endpoints = new Map([
    ['/v1/tools/call', (request) => toolsCall(request)],
    // GET /v1/tools：只读工具清单（rawBody 为空 → request={}，invoke 的对象检查天然通过）。
    ['/v1/tools', () => ({ ok: true, tools: TOOL_MANIFEST })],
  ]);

  /**
   * 分发（已鉴权的请求体）：HTTP 与 WS 两个入口共用。
   * WS 帧入口已退役（传输按角色非对称：资源服务只走 HTTP tool.call，验签见上）。
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
      if (!auth) return { status: 503, body: { error: '网关接入未配置（仓库根目录缺少 gateway.json）' } };
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
