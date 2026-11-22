// 网关接入面测试：/v1/tools/call（tool.call 唯一信封：HMAC 鉴权、decorator 契约
// {sections}、工具路由、业务失败透传、nonce 防重放）。全离线：role service 用内存假实现。
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

// decorator 形态的 tool.call：args 恒 {}，context.senderId 可选（本服务不消费）。
const decoratorCallBody = JSON.stringify({
  v: 1, callId: 'svc-1', tool: 'chat_role_render', args: {},
  sessionKey: 'qq:group:123', context: { senderId: 'u_1' },
});
const toolCallBody = JSON.stringify({
  v: 1, callId: 'tool-1', tool: 'chat_role_list', args: {}, sessionKey: 'qq:group:123',
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
    const res = await post(port, '/v1/tools/call', { body: decoratorCallBody });
    assert.equal(res.status, 401);
  });

  await check('错误密钥 → 401；nonce 重放 → 401', async () => {
    const bad = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: 'wrong-secret-0123456789', adapterId: REG_ID, body: toolCallBody }),
      body: toolCallBody,
    });
    assert.equal(bad.status, 401);
    const headers = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody });
    assert.equal((await post(port, '/v1/tools/call', { headers, body: decoratorCallBody })).status, 200);
    assert.equal((await post(port, '/v1/tools/call', { headers, body: decoratorCallBody })).status, 401);
  });

  await check('tools/call：decorator 契约（ok + sections，无 epoch）', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody }),
      body: decoratorCallBody,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.v, 1);
    assert.equal(res.body.callId, 'svc-1');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.sections[0].name, '人格');
    assert.ok(res.body.data.sections[0].text.includes('你是小红'));
    assert.equal('epoch' in res.body.data, false, 'rolecard 无会话纪元状态，不返回 epoch');
  });

  await check('tools/call：chat_role_list', async () => {
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: toolCallBody }),
      body: toolCallBody,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { v: 1, callId: 'tool-1', ok: true, data: { roles: ['小红', '小明'], current: '小红' } });
  });

  await check('tools/call：render（sessionKey 可选化后可不传）与已退役工具拒绝', async () => {
    // render：DSH 插件直调的唯一入口——不传 sessionKey（2026-11-21 可选化）。
    const body = JSON.stringify({ v: 1, callId: 't-render', tool: 'chat_role_render', args: {} });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.sections[0].name, '人格');
    // chat_role_get / sections / admin_* 已退役（2026-11-21 收敛）→ E_UNSUPPORTED。
    for (const gone of ['chat_role_get', 'chat_role_sections', 'chat_role_admin_list', 'chat_role_admin_switch']) {
      const goneBody = JSON.stringify({ v: 1, callId: `t-gone-${gone}`, tool: gone, args: {} });
      const goneRes = await post(port, '/v1/tools/call', {
        headers: signRequest({ secret: SECRET, adapterId: REG_ID, body: goneBody }),
        body: goneBody,
      });
      assert.equal(goneRes.body.ok, false, gone);
      assert.equal(goneRes.body.error.code, 'E_UNSUPPORTED', gone);
    }
  });

  await check('tools/call：未知工具 → ok:false E_UNSUPPORTED', async () => {
    const body = JSON.stringify({ v: 1, callId: 't-bad', tool: 'chat_role_nope', args: {}, sessionKey: 'qq:group:123' });
    const res = await post(port, '/v1/tools/call', {
      headers: signRequest({ secret: SECRET, adapterId: REG_ID, body }),
      body,
    });
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'E_UNSUPPORTED');
  });

  await check('契约错误（缺 callId）→ 400；坏 JSON → 400', async () => {
    const missing = JSON.stringify({ v: 1, tool: 'chat_role_list', args: {} });
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

// ── 热加载：auth.rotate 原地换密钥（gateway.json 热加载的地基，与 memory-mcp 同口径）──
await check('rotate：换密钥后旧签名 401、新签名通过', async () => {
  const auth = createGatewayAuth({ secret: SECRET, serviceId: REG_ID });
  const gateway = createGatewayV1({ auth, role: fakeRole });
  const oldSig = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: oldSig, rawBody: decoratorCallBody })).status, 200);

  const NEXT = 'rotated-shared-secret-0123456789';
  auth.rotate({ secret: NEXT, serviceId: REG_ID });
  // 旧密钥签名（换掉 secret 但换新 nonce）→ 401：密钥真的换掉了。
  const stale = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: stale, rawBody: decoratorCallBody })).status, 401);
  // 新密钥签名 → 200；业务 handler 未重建（同一个 gateway 实例继续工作）。
  const fresh = signRequest({ secret: NEXT, adapterId: REG_ID, body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: fresh, rawBody: decoratorCallBody })).status, 200);
});

await check('rotate：serviceId 一并轮换；过短密钥整体拒收（保留旧值）', async () => {
  const auth = createGatewayAuth({ secret: SECRET, serviceId: 'id-a' });
  const gateway = createGatewayV1({ auth, role: fakeRole });
  const wrongId = signRequest({ secret: SECRET, adapterId: 'id-b', body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: wrongId, rawBody: decoratorCallBody })).status, 401);

  assert.throws(() => auth.rotate({ secret: 'short' }), /至少 16 字符/);
  // 拒收后旧值仍在：id-a + 旧密钥照常通过。
  const stillOld = signRequest({ secret: SECRET, adapterId: 'id-a', body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: stillOld, rawBody: decoratorCallBody })).status, 200);

  auth.rotate({ secret: SECRET, serviceId: 'id-b' });
  const withNewId = signRequest({ secret: SECRET, adapterId: 'id-b', body: decoratorCallBody });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: withNewId, rawBody: decoratorCallBody })).status, 200);
});

await check('rotate：换密钥不重置防重放 nonce 窗口', async () => {
  const auth = createGatewayAuth({ secret: SECRET, serviceId: REG_ID });
  const gateway = createGatewayV1({ auth, role: fakeRole });
  const nonce = crypto.randomBytes(12).toString('hex');
  const headers = signRequest({ secret: SECRET, adapterId: REG_ID, body: decoratorCallBody, nonce });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers, rawBody: decoratorCallBody })).status, 200);
  auth.rotate({ secret: 'rotated-shared-secret-0123456789', serviceId: REG_ID });
  // 同一 nonce 用新密钥重签 → 依然 401：轮换不重置防重放窗口。
  const replay = signRequest({ secret: 'rotated-shared-secret-0123456789', adapterId: REG_ID, body: decoratorCallBody, nonce });
  assert.equal((await gateway.handle({ path: '/v1/tools/call', headers: replay, rawBody: decoratorCallBody })).status, 401);
});

console.log(`\nℹ tests ${passed + failed}\nℹ pass ${passed}\nℹ fail ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
