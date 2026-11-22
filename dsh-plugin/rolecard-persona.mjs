// DSH persona 插件：角色卡人格进 system prompt（终态架构 2026-11-20）。
//
// 角色卡的分层渲染逻辑在 rolecard-mcp（chat_role_render），本插件是薄集成层：
// 在 system-prompt/assemble waterfall（官方异步缝隙——section text provider 是
// 同步签名，HTTP 拉取只能走这里）里拉渲染，push 为独立
// section。设计要点：
//   · 每 step 重新装配 + 实时拉渲染 ⇒ 控制台改卡下一回合立即生效，零重启；
//   · 失败兜底 = 上次成功渲染缓存（人格短暂滞后远好于消失）；无缓存时注入
//     占位说明段，永不阻塞回合（超时 2s）；
//   · 渲染文本不变时 DSH project 层自动不重复提交 system 事件（KV 前缀稳定）。
//
// 拉取路径（2026-11-20 rootUrl 自描述直连）：**直调 rolecard-mcp 回环 HTTP**——
// config 零参数（回环约定地址内联，与 rolecard http-api.js 端口默认同源），
// 启动时 GET /v1/bootstrap 拉取连接配置（toolCallPath/adapterId/secret——
// gateway.json 单源，rolecard 热加载自动跟随），之后 HMAC 签名直调。
// env 逃生门：ROLECARD_ROOT_URL（rolecard 换端口又不想重装 bundle 时用）。
//
// 响应信封（rolecard gateway-v1.js）：{ v:1, callId, ok, data:{ sections:[{name,text,priority}] } }
// —— sections 按 priority 升序拼接为一个 section 文本（与网关管线 decorator 的
// 全量拼接语义一致）。

import { createHmac, createHash, randomBytes } from 'node:crypto'

export const name = 'rolecard-persona'

export const inject = ['systemPrompt']

const SECTION_NAME = 'rolecard-persona'

// 与 rolecard-mcp src/http-api.js 的硬编码端口默认同源（两仓共同约定）。
const DEFAULT_ROOT_URL = 'http://127.0.0.1:7182'

const PLACEHOLDER = [
  '【人格提示（降级）】',
  '角色卡服务暂不可达，本次无法载入完整人设。',
  '请保持礼貌、简洁与克制，不要编造角色细节，等待服务恢复。',
].join('\n')

/** HMAC 签名（与网关出站 tool.call 同源公式：v1 = hmac_sha256(secret, ts + "\n" + nonce + "\n" + sha256(body))）。 */
function sign(secret, body) {
  const ts = Date.now()
  const nonce = randomBytes(12).toString('hex')
  const bodyHash = createHash('sha256').update(body).digest('hex')
  return {
    'x-timestamp': String(ts),
    'x-nonce': nonce,
    'x-signature': `v1=${createHmac('sha256', secret).update(`${ts}\n${nonce}\n${bodyHash}`).digest('hex')}`,
  }
}

/**
 * 拉取 /v1/bootstrap（免认证——拿 secret 前无法签名；rolecard 回环守卫兜底）
 * 并返回 { toolCallPath, adapterId, secret }。失败抛错由调用方降级。
 */
async function fetchBootstrap({ rootUrl, timeoutMs }) {
  const res = await fetch(`${rootUrl.replace(/\/+$/, '')}/v1/bootstrap`, {
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`bootstrap HTTP ${res.status}`)
  const payload = await res.json()
  if (payload?.v !== 1 || typeof payload?.secret !== 'string' || !payload.secret
    || typeof payload?.adapterId !== 'string' || !payload.adapterId
    || typeof payload?.toolCallPath !== 'string') {
    throw new Error('bootstrap 响应形状不符')
  }
  return { toolCallPath: payload.toolCallPath, adapterId: payload.adapterId, secret: payload.secret }
}

/** 拉取渲染（HMAC 直调 rolecard tool.call——rolecard 侧纯 HMAC 鉴权，无 turnToken）→ sections 拼为一段文本。 */
async function fetchRendered({ rootUrl, boot, timeoutMs }) {
  const body = JSON.stringify({
    v: 1,
    callId: `dsh-persona-${Date.now()}-${randomBytes(4).toString('hex')}`,
    // rolecard tool.call 的 sessionKey 已可选化（角色卡工具与消息会话无关），
    // 插件无回合上下文，不传假值。
    tool: 'chat_role_render',
    args: {},
  })
  const res = await fetch(`${rootUrl.replace(/\/+$/, '')}${boot.toolCallPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-adapter-id': boot.adapterId,
      ...sign(boot.secret, body),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`rolecard HTTP ${res.status}`)
  const payload = await res.json()
  if (payload?.v !== 1 || payload?.ok !== true || !Array.isArray(payload?.data?.sections)) {
    throw new Error(`rolecard 响应形状不符（ok=${payload?.ok}）`)
  }
  const sections = payload.data.sections
    .filter((section) => typeof section?.text === 'string' && section.text.trim())
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
  const text = sections.map((section) => section.text.trim()).join('\n\n')
  // 业务空 ≠ 失败（2026-11-21 审计修复）：未设/已清空当前角色时返回 null 信号，
  // 调用方应跳过注入而非用 lastGood 旧人格兜底（否则清空后旧人格无限复活）。
  if (!text) return null
  return text
}

/**
 * 注册 assemble waterfall 监听器：拉渲染 → push 人格 section。
 * @param ctx - 顶层 entry 挂载的 scope 上下文。
 * @param config - 全部可选覆盖（yml 零 config 也能跑）：{ rootUrl?, timeoutMs?, order? }。
 */
export function apply(ctx, config) {
  const rootUrl = String(config?.rootUrl ?? process.env.ROLECARD_ROOT_URL ?? DEFAULT_ROOT_URL)
  const timeoutMs = Number(config?.timeoutMs ?? 2000)
  const order = Number.isFinite(config?.order) ? Number(config.order) : 1

  // bootstrap 缓存：apply 时尽力预拉（rolecard 未起则留空，waterfall 内每次重试——
  // 保证 rolecard 迟到场景最终自愈，而不是插件启动时判死）。
  let boot = null
  let lastGood = null
  let lastErrorStamp = 0

  ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    let text = null
    try {
      if (!boot) boot = await fetchBootstrap({ rootUrl, timeoutMs })
      text = await fetchRendered({ rootUrl, boot, timeoutMs })
      if (text === null) {
        // 业务空（未设/已清空角色）：这是正确状态——清掉 lastGood（旧人格已失效，
        // 不得兜底）并跳过注入。
        lastGood = null
        return next()
      }
      lastGood = text
    } catch (error) {
      const message = String(error?.message ?? error)
      // 凭据失效自愈（2026-11-21 审计修复）：gateway.json 热加载轮换 secret 后，
      // 旧 boot 缓存 401 永久失败——必须清缓存重拉 bootstrap。
      if (/HTTP 401|E_AUTH|签名/.test(message)) {
        boot = null
      }
      // 节流日志：同类错误每 60s 最多一条，避免每 step 刷屏。
      const now = Date.now()
      if (now - lastErrorStamp > 60_000) {
        lastErrorStamp = now
        console.error(`[rolecard-persona] 拉取失败（${lastGood ? '用缓存兜底' : '无缓存，占位'}）：${message}`)
      }
      text = lastGood ?? PLACEHOLDER
    }
    assembly.sections.push({ name: SECTION_NAME, order, text })
    return next()
  }), 'rolecard-persona.assemble()')
}
