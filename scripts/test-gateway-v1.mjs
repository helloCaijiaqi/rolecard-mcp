// 网关 V2 接入面测试：/v1/service/call + /v1/tools/call（HMAC 鉴权、装饰器契约、
// 工具路由、业务失败透传、nonce 防重放）。全离线：role service 用内存假实现。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createGatewayAuth, createGatewayV1 } from '../src/service/gateway-v1.js';
import { createHttpApi } from '../src/http-api.js';

const SECRET = 'gateway-shared-secret-0123456789';
const REG_ID = crypto.randomUUID().replaceAll('-', '');
let passed = 0;
let failed = 0;

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  ✔ ${name}`); })
    .catch((error) => { failed += 1; console.error(`  ✖ ${name}\n    ${error?.stack ?? error}`); });
}

function signRequest({ secret, adapterId, body, timestamp = Date.now(), nonce = crypto.randomBytes(12).toString('hex') }) {
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}\n${nonce}\n${bodyHash}`).digest('hex');
  return {
    'x-adapter-id': adapterId,
    'x-timestamp': String(timestamp),
    'x-nonce': nonce,
    'x-signature': `v1=${signature}`,
  };
}

// 内存假 role service：覆盖 gateway-v1 用到的四个方法。
const fakeRole = {
  list() { return ['小红', '小明']; },
  current() { return '小红'; },
  get({ name } = {}) {
    if (name && name !== '小红') return null;
    return { name: '小红', content: '# 人格\n你是小红。', chars: 12, stats: {} };
  },
  sections({ name } = {}) {
    if (name && name !== '小红') return [];
    return [{ name: '人格', present: true }];
  },
  render() {
    const text = '【人格】\n你是小红。';
    return { blocks: [{ name: '人格', text, chars: text.length }], truncated: false };
  },
  stats() { return { roles: 2 }; },
};

function post(port, path, { headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const serviceCallBody = JSON.stringify({
  v: 1, callId: 'svc-1', service: REG_ID, step: 'chat_role_render', kind: 'decorator',
  sessionKey: 'qq:group:123', text: '',
});
const toolCallBody = JSON.stringify({
  v: 1, callId: 'tool-1', tool: 'chat_role_list', args: {},
});

const gateway = createGatewayV1({
  auth: createGatewayAuth({ secret: SECRET, serviceId: REG_ID }),
  role: fakeRole,
  logger: () => {},
});
const api = createHttpApi({ role: fakeRole, token: 'local-tok', gateway, port: 0 });
const { port } = await api.listen();

try {
  await check('未签名请求 → 401', async () => {
    const res = await post(port, '/v1/service/call', { body: serviceCallBody });
    assert.equal(res.status, 401);
  });

  await check('错误密钥 → 401；nonce 重放 → 401', async () => {
    const bad = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: 'wrong-secret-0123456789', adapterId: REG_ID, body: toolCallBody }),
      body: toolCallBody,
    });
    assert.equal(bad.status, 401);
    const headers = signRequest({ secret: SECRET, adapterId: REG_ID, body: serviceCallBody });
    assert.equal((await post(port, '/v1/service/call', { headers, body: serviceCallBody })).status, 200);
    assert.equal((await post(port, '/v1/service/call', { headers, body: serviceCallBody })).status, 401);
  });

  await check('service/call：人格块 sections（verdict=pass）', async () => {
    const res = await post(port, '/v1/service/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: serviceCallBody }),
      body: serviceCallBody,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.v, 1);
    assert.equal(res.body.callId, 'svc-1');
    assert.equal(res.body.verdict, 'pass');
    assert.equal(res.body.sections[0].name, '人格');
    assert.ok(res.body.sections[0].text.includes('你是小红'));
  });

  await check('tools/call：chat_role_list', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: toolCallBody }),
      body: toolCallBody,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { v: 1, callId: 'tool-1', ok: true, data: { roles: ['小红', '小明'], current: '小红' } });
  });

  await check('tools/call：chat_role_get / sections / render', async () => {
    for (const [tool, expect] of [
      ['chat_role_get', (data) => data.name === '小红'],
      ['chat_role_sections', (data) => Array.isArray(data.sections)],
      ['chat_role_render', (data) => data.blocks[0].name === '人格'],
    ]) {
      const body = JSON.stringify({ v: 1, callId: `t-${tool}`, tool, args: {} });
      const res = await post(port, '/v1/tools/call', {
        headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
        body,
      });
      assert.equal(res.status, 200, tool);
      assert.equal(res.body.ok, true, tool);
      assert.ok(expect(res.body.data), tool);
    }
  });

  await check('tools/call：未知工具 → ok:false E_UNSUPPORTED', async () => {
    const body = JSON.stringify({ v: 1, callId: 't-bad', tool: 'chat_role_nope', args: {} });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'E_UNSUPPORTED');
  });

  await check('契约错误（缺 callId）→ 400；坏 JSON → 400', async () => {
    const missing = JSON.stringify({ v: 1, tool: 'chat_role_get', args: {} });
    const a = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: missing }),
      body: missing,
    });
    assert.equal(a.status, 400);
    const b = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: '{broken' }),
      body: '{broken',
    });
    assert.equal(b.status, 400);
  });

  await check('/api/health 免令牌且不受影响；/api/* 令牌通道照常', async () => {
    const health = await post(port, '/api/health', { body: '' });
    assert.equal(health.status, 200);
    assert.equal(health.body.service, 'rolecard-mcp');
    const body = JSON.stringify({ name: '小红' });
    const res = await post(port, '/api/role/get', { headers: { 'x-mcp-token': 'local-tok' }, body });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, '小红');
  });

  await check('鉴权：serviceId 可选（只配 secret 仅验签名；配了就必须一致）', async () => {
    const body = JSON.stringify({ probe: true });
    const headers = signRequest({ secret: SECRET, adapterId: 'unregistered-service', body });
    // 只配 secret：不钉身份，验签通过即放行（与 server.mjs 注释/memory-mcp 同口径）。
    const loose = createGatewayAuth({ secret: SECRET });
    assert.equal(loose.verify({ headers, rawBody: body }).serviceId, 'unregistered-service');
    // 配了 id：身份头必须完全一致。
    const strict = createGatewayAuth({ secret: SECRET, serviceId: REG_ID });
    assert.throws(() => strict.verify({ headers, rawBody: body }), /登记身份不匹配/);
  });
} finally {
  await api.close();
}

console.log(`\nℹ tests ${passed + failed}\nℹ pass ${passed}\nℹ fail ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
