// 双接口契约测试：回环 HTTP + stdio MCP。不连 DSH、不连 QQ。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { start } from '../src/server.mjs';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(PKG_ROOT, 'src', 'server.mjs');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rolecard-mcp-iface-'));

const CARD = '# 傲娇助手\n\n## 你是谁\n- 嘴硬心软。\n\n## 工具协议 〔二代〕\n- 用工具数组分条。\n';

function tmpDirs() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'case-'));
  const rolesDir = path.join(dir, 'roles');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, '傲娇助手.md'), CARD, 'utf8');
  return { rolesDir, stateDir };
}

async function withApi(fn) {
  const { rolesDir, stateDir } = tmpDirs();
  const app = await start({
    env: { ROLECARD_MCP_ROLES_DIR: rolesDir, ROLECARD_MCP_STATE_DIR: stateDir, ROLECARD_MCP_HTTP_PORT: '0', ROLECARD_MCP_TOKEN: 't' },
    stdio: false,
    logger: () => {},
  });
  try {
    return await fn({ app, port: app.api.address.port, token: 't' });
  } finally {
    await app.api.close();
  }
}

const call = (port, route, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

test('HTTP：健康检查免令牌，业务路由要令牌', async () => {
  await withApi(async ({ port, token }) => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await call(port, '/api/roles', {})).status, 401);
    const okRes = await call(port, '/api/roles', {}, { 'x-mcp-token': token });
    assert.equal(okRes.status, 200);
    assert.ok(okRes.body.roles.includes('傲娇助手'));
  });
});

test('HTTP：切换当前角色并渲染【人格】段', async () => {
  await withApi(async ({ port, token }) => {
    const auth = { 'x-mcp-token': token };
    const set = await call(port, '/api/role/current', { name: '傲娇助手' }, auth);
    assert.equal(set.status, 200);
    const blocks = await call(port, '/api/blocks/render', { mode: 'v2' }, auth);
    assert.equal(blocks.status, 200);
    assert.equal(blocks.body.blocks[0].name, '人格');
    assert.ok(blocks.body.blocks[0].text.startsWith('【人格】'));
    assert.ok(blocks.body.blocks[0].text.includes('工具协议'));
  });
});

test('HTTP：切换不存在的角色返回明确错误', async () => {
  await withApi(async ({ port, token }) => {
    const res = await call(port, '/api/role/current', { name: '查无此人' }, { 'x-mcp-token': token });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.includes('角色不存在'));
  });
});

test('stdio MCP：能握手，且暴露约定的工具', async () => {
  const { rolesDir, stateDir } = tmpDirs();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ROLECARD_MCP_ROLES_DIR: rolesDir, ROLECARD_MCP_STATE_DIR: stateDir, ROLECARD_MCP_HTTP_PORT: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'iface-test', version: '1.0.0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

  const text = await new Promise((resolve) => {
    const deadline = Date.now() + 8000;
    const timer = setInterval(() => {
      const joined = stdout.join('');
      if (joined.includes('"id":2') || Date.now() > deadline) {
        clearInterval(timer);
        resolve(joined);
      }
    }, 100);
  });
  child.kill();

  const payloads = text
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  assert.ok(payloads.some((item) => item.result?.protocolVersion), '握手应返回协议版本');
  const listPayload = payloads.find((item) => Array.isArray(item.result?.tools));
  assert.ok(listPayload, '应返回工具列表');
  const names = listPayload.result.tools.map((tool) => tool.name);
  for (const expected of ['role_list', 'role_get', 'role_set_current', 'role_clear_current', 'role_sections', 'role_context_render']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}，实际：${names.join('、')}`);
  }
});
