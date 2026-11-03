// 仅回环的 HTTP 接口：给平台桥接调用（与 memory-mcp 同一套安全边界）。
import http from 'node:http';
import { createRequire } from 'node:module';

// 健康检查要报版本号：直接读包自身的 package.json，避免再维护一份常量。
const PKG_VERSION = createRequire(import.meta.url)('../package.json').version ?? '0.0.0';

const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

export function createHttpApi({ role, token, host = '127.0.0.1', port = 7182, logger } = {}) {
  const log = logger ?? (() => {});
  const startedAt = Date.now();
  const routes = new Map([
    ['/api/roles', () => ({ roles: role.list(), current: role.current() })],
    ['/api/role/get', (args) => role.get(args)],
    ['/api/role/current', (args) => role.setCurrent(args)],
    ['/api/role/clear', () => role.clearCurrent()],
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
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/health') {
        // 与 memory-mcp 同一形状：版本、pid、端口、成活时长；不含业务内容，所以免令牌。
        json(res, 200, {
          ok: true,
          service: 'rolecard-mcp',
          version: PKG_VERSION,
          pid: process.pid,
          port: server.address()?.port ?? port,
          uptimeMs: Date.now() - startedAt,
          stats: role.stats(),
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
      const args = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      json(res, 200, await handler(args));
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
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
