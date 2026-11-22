// 仅回环的 HTTP 接口：给平台桥接调用（与 memory-mcp 同一套安全边界）。
import http from 'node:http';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 健康检查要报版本号：直接读包自身的 package.json，避免再维护一份常量。
const PKG_VERSION = createRequire(import.meta.url)('../package.json').version ?? '0.0.0';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// 与 executor 表 admin_write 同口径（2026-11-21 管理面迁移）：写路径校验不丢。
const ROLE_NAME_RE = /^[\w\u4e00-\u9fa5-]{1,64}$/;
const MAX_ROLE_CHARS = 200_000;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
]);

function json(res, status, payload) {
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大（上限 1MB）');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/** /v1 端点专用：返回原始 body 文本（HMAC 签名必须对原始字节算）。 */
async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大（上限 1MB）');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createHttpApi({ role, token, gateway, host = '127.0.0.1', port = 7182, logger } = {}) {
  const log = logger ?? (() => {});
  const startedAt = Date.now();
  // 2026-11-21 审计修复（系统性问题 #2，与 memory-mcp 同步落地）：
  // DNS rebinding 防护——仅靠 remoteAddress 回环检查挡不住浏览器侧攻击：
  // 攻击者域名可先解析到外部 IP、再 rebind 到 127.0.0.1，浏览器发起的请求
  // remoteAddress 仍是回环，但 Host 是攻击者域名。免认证端点 /v1/bootstrap
  //（吐 gateway secret）与 /admin/api/*（读写角色卡）会被远程读取。
  // 因此回环请求还必须校验 Host 头只能是本机名（可带端口）。
  const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
  let lastHostWarnAt = 0;
  const routes = new Map([
    ['/api/roles', () => ({ roles: role.list(), current: role.current() })],
    ['/api/role/get', (args) => role.get(args)],
    // 状态变更端点 POST-only（2026-11-21 审计修复）：GET 带查询参数即可写当前
    // 角色，会被浏览器 link 预取/img 加载意外触发——状态变更必须显式 POST。
    ['/api/role/current', { post: true, handler: (args) => role.setCurrent(args) }],
    ['/api/role/clear', { post: true, handler: () => role.clearCurrent() }],
    ['/api/role/sections', (args) => ({ sections: role.sections(args) })],
    ['/api/blocks/render', (args) => role.render(args)],
    ['/api/stats', () => role.stats()],
  ]);

  const server = http.createServer(async (req, res) => {
    try {
      const remote = req.socket?.remoteAddress ?? '';
      if (!LOOPBACK.has(remote)) {
        json(res, 403, { error: '仅允许本机回环访问' });
        return;
      }
      // 2026-11-21 审计修复（系统性问题 #2）：Host 头校验，防 DNS rebinding
      // 远程读取 /v1/bootstrap（免认证吐 secret）与 /admin/api/*。
      // 缺 Host（HTTP/1.0 老客户端）同样拒绝——合法本机调用方（fetch/浏览器/
      // 桥接）都会带 Host，误伤面为零。
      const reqHost = req.headers.host ?? '';
      if (!LOOPBACK_HOST_RE.test(reqHost)) {
        // 节流日志：rebinding 探测往往高频轮询，逐条打会刷爆 stderr；
        // 10s 最多记一条，保留攻击取证线索即可。
        if (Date.now() - lastHostWarnAt > 10_000) {
          lastHostWarnAt = Date.now();
          log(`[rolecard-mcp] Host 校验拒绝（疑似 DNS rebinding）：remote=${remote} host=${reqHost}`);
        }
        json(res, 403, { error: '仅允许本机回环访问' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // /v1/bootstrap（2026-11-20）：免认证连接自描述（DSH persona 插件用）——
      // 必须在验签分支之前（调用方拿 secret 前无法签名）；gateway.bootstrap()
      // 内部处理未接入的 503。
      if (gateway && url.pathname === '/v1/bootstrap') {
        if (req.method !== 'GET') {
          json(res, 405, { error: `不支持的方法：${req.method}` });
          return;
        }
        const { status, body } = await gateway.bootstrap();
        json(res, status, body);
        return;
      }
      // 网关 V2 端点：验签要原始 body，先于通用 readBody 分支（不走 x-mcp-token 通道）。
      // /v1/tools（GET 只读清单，空 body 签名）与 /v1/tools/call（POST 调用信封）共用验签通道。
      if (gateway && (url.pathname === '/v1/tools/call' || url.pathname === '/v1/tools')) {
        if (req.method !== (url.pathname === '/v1/tools' ? 'GET' : 'POST')) {
          json(res, 405, { error: `不支持的方法：${req.method}` });
          return;
        }
        const rawBody = await readRawBody(req);
        const { status, body } = await gateway.handle({ path: url.pathname, headers: req.headers, rawBody });
        json(res, status, body);
        return;
      }
      // ── 管理面（2026-11-21，控制台「角色卡」编辑迁入服务本体）──────────────
      // 信任模型与 /v1/bootstrap 同级：全局回环守卫（上面 LOOPBACK）+ 单用户主机
      // 本地可信——角色卡文件本就落盘可改，token 不额外挡本机管理页。
      //   GET  /admin            → 单页 UI
      //   GET  /admin/admin.js   → UI 逻辑
      //   GET  /admin/api/roles      → { roles, current }
      //   GET  /admin/api/roles/:name → role.get
      //   PUT  /admin/api/roles/:name → writeRole（name 正则 + content ≤200k）
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        const file = path.join(PUBLIC_DIR, 'admin', 'index.html');
        try {
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        } catch {
          json(res, 404, { error: '管理页未找到' });
        }
        return;
      }
      if (url.pathname === '/admin/admin.js' && req.method === 'GET') {
        try {
          const body = fs.readFileSync(path.join(PUBLIC_DIR, 'admin', 'admin.js'));
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        } catch {
          json(res, 404, { error: 'admin.js 未找到' });
        }
        return;
      }
      if (url.pathname === '/admin/admin.css' && req.method === 'GET') {
        try {
          const body = fs.readFileSync(path.join(PUBLIC_DIR, 'admin', 'admin.css'));
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        } catch {
          json(res, 404, { error: 'admin.css 未找到' });
        }
        return;
      }
      const rolesMatch = /^\/admin\/api\/roles(?:\/([^/]+))?$/.exec(url.pathname);
      if (rolesMatch) {
        const roleName = rolesMatch[1] ? decodeURIComponent(rolesMatch[1]) : null;
        if (req.method === 'GET' && !roleName) {
          json(res, 200, { ok: true, roles: role.list(), current: role.current()?.name ?? role.current() });
          return;
        }
        if (roleName && !ROLE_NAME_RE.test(roleName)) {
          json(res, 400, { error: '角色名非法' });
          return;
        }
        if (req.method === 'GET' && roleName) {
          const detail = role.get({ name: roleName });
          if (!detail) json(res, 404, { error: `角色不存在：${roleName}` });
          else json(res, 200, { ok: true, ...detail });
          return;
        }
        if (req.method === 'PUT' && roleName) {
          const body = await readBody(req);
          const content = body?.content;
          if (typeof content !== 'string' || !content.trim() || content.length > MAX_ROLE_CHARS) {
            json(res, 400, { error: 'content 非空且 ≤200000 字符' });
            return;
          }
          json(res, 200, { ok: true, ...role.writeRole({ name: roleName, content }) });
          return;
        }
        json(res, 405, { error: `不支持的方法：${req.method}` });
        return;
      }
      if (url.pathname === '/api/health') {
        // 与 memory-mcp 同一形状：版本、pid、端口、成活时长；不含业务内容，所以免令牌。
        // 但 `stats.current` 是当前加载的角色名（用户内容）：免令牌端点不该回显
        // 「这个人现在在跟谁聊」。名字走带令牌的 /api/state。
        const { roles, cacheEntries } = role.stats();
        json(res, 200, {
          ok: true,
          service: 'rolecard-mcp',
          version: PKG_VERSION,
          pid: process.pid,
          port: server.address()?.port ?? port,
          uptimeMs: Date.now() - startedAt,
          stats: { roles, cacheEntries },
        });
        return;
      }
      if (token && req.headers['x-mcp-token'] !== token && req.headers.authorization !== `Bearer ${token}`) {
        json(res, 401, { error: '缺少或错误的本地令牌' });
        return;
      }
      const handler = routes.get(url.pathname);
      if (!handler) {
        json(res, 404, { error: `未知路由：${url.pathname}` });
        return;
      }
      if (req.method !== 'POST' && req.method !== 'GET') {
        json(res, 405, { error: `不支持的方法：${req.method}` });
        return;
      }
      // POST-only 端点（2026-11-21 审计修复）：状态变更（setCurrent/clearCurrent）
      // 不允许 GET 触发——见 routes 表中的 { post: true } 标记。
      const endpoint = typeof handler === 'function' ? { handler } : handler;
      if (endpoint.post && req.method !== 'POST') {
        json(res, 405, { error: '该端点仅支持 POST（状态变更不可用 GET 触发）' });
        return;
      }
      const args = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      json(res, 200, await endpoint.handler(args));
    } catch (error) {
      log(`[rolecard-mcp] HTTP 处理失败：${error?.message ?? error}`);
      json(res, 400, { error: String(error?.message ?? error) });
    }
  });

  const api = {
    port,
    host,
    address: null,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          api.address = server.address();
          resolve(api.address);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        // 2026-11-21 审计修复：close() 只等活跃连接结束，keep-alive 空闲连接
        // 会让它永不回调 → shutdown 卡死。先主动断开空闲连接（Node ≥18.2）。
        server.closeIdleConnections?.();
        server.close(() => resolve());
      });
    },
  };
  return api;
}
