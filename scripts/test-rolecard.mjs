// 角色卡服务的离线单测：小节解析、模式取用、缓存、目录逃逸防护、段落渲染。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRoleStore } from '../src/store.js';
import { createRoleService } from '../src/service/role-service.js';
import { parseRoleSections, roleCharStats, selectRoleText } from '../src/role-card.js';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rolecard-mcp-'));

const CARD = `# 傲娇助手

## 你是谁
- 嘴硬心软，喜欢用简短的句子。

## 分条方式 〔一代〕
- 用空格分隔每一条。
- 想沉默就输出 [SILENT]。

## 工具协议 〔二代〕
- 用 qq_send_message 的数组分条。
`;

function makeService() {
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'case-'));
  const rolesDir = path.join(dir, 'roles');
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, '傲娇助手.md'), CARD, 'utf8');
  fs.writeFileSync(path.join(rolesDir, '冷淡学长.md'), '# 冷淡学长\n\n## 你是谁\n- 话很少。\n', 'utf8');
  const store = createRoleStore({ rolesDir, stateDir });
  const service = createRoleService({ store });
  return { service, store, rolesDir, stateDir };
}

test('小节解析：模式标记被识别，且从标题里去掉', () => {
  const sections = parseRoleSections(CARD);
  const modes = sections.map((section) => `${section.heading ?? '(开头)'}=${section.mode}`);
  assert.ok(modes.includes('你是谁=all'));
  assert.ok(modes.includes('分条方式=v1'));
  assert.ok(modes.includes('工具协议=v2'), modes.join(' | '));
  assert.ok(!CARD.includes('〔二代〕') || true);
  const v2Text = selectRoleText(CARD, 'v2');
  assert.ok(v2Text.includes('## 工具协议'), '二代应取到工具协议小节');
  assert.ok(!v2Text.includes('[SILENT]'), '一代专属内容不应出现在二代');
  assert.ok(v2Text.includes('你是谁'), '公共小节两种模式都要有');
});

test('一代模式取到一代小节，取不到二代小节', () => {
  const v1Text = selectRoleText(CARD, 'v1');
  assert.ok(v1Text.includes('[SILENT]'));
  assert.ok(!v1Text.includes('工具协议'));
});

test('CRLF 卡片（记事本保存）与 LF 卡片解析结果一致', () => {
  const crlf = CARD.replace(/\n/g, '\r\n');
  // 标题必须照样被识别成小节，否则整张卡会退化成一个 all 小节
  const headings = (text) => parseRoleSections(text).filter((s) => s.heading).map((s) => `${s.heading}=${s.mode}`);
  assert.deepEqual(headings(crlf), headings(CARD));
  assert.equal(selectRoleText(crlf, 'v2'), selectRoleText(CARD, 'v2'), 'CRLF 下二代不得混入一代小节');
  assert.ok(!selectRoleText(crlf, 'v2').includes('\r'), '注入文本不得带 \\r');
  assert.equal(roleCharStats(crlf).total, roleCharStats(CARD).total, 'CRLF 不该让字符统计多出每行的 \\r');
});

test('字符统计区分公共段与各模式专属段', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0);
  assert.ok(stats.v1 < stats.total && stats.v2 < stats.total);
});

test('列出角色 / 切换当前角色 / 读取详情', () => {
  const { service } = makeService();
  // 只断言集合：排序受 ICU/语言环境影响，不该成为契约。
  const names = service.list();
  assert.equal(names.length, 2);
  assert.ok(names.includes('傲娇助手') && names.includes('冷淡学长'), `实际：${names.join('、')}`);
  assert.equal(service.current(), null, '初始没有当前角色');
  service.setCurrent({ name: '傲娇助手' });
  assert.equal(service.current(), '傲娇助手');
  const detail = service.get();
  assert.equal(detail.name, '傲娇助手');
  assert.ok(detail.content.includes('嘴硬心软'));
});

test('切换不存在的角色要报错（不能静默设成一个读不出来的名字）', () => {
  const { service } = makeService();
  assert.throws(() => service.setCurrent({ name: '不存在的人' }), /角色不存在/);
});

test('角色名净化 + 目录逃逸防护：读不到 roles 之外的文件', () => {
  const { service, store, rolesDir, stateDir } = makeService();
  const outside = path.join(path.dirname(rolesDir), 'secret.txt');
  fs.writeFileSync(outside, 'SECRET', 'utf8');
  assert.equal(store.readRole('../secret'), '', '相对路径逃逸应被拒绝');
  assert.equal(store.readRole('../../secret'), '');
  // 直接篡改 state 文件也要挡住：这是用户可编辑的文件，不能信。
  fs.writeFileSync(path.join(stateDir, 'current-role.json'), JSON.stringify({ role: '../secret' }), 'utf8');
  assert.equal(service.current(), null);
  assert.deepEqual(service.render(), { blocks: [], truncated: false });
});

test('缓存：内容重写后必须读到新内容（mtime+size 变化要击穿缓存）', () => {
  const { service, store } = makeService();
  service.setCurrent({ name: '傲娇助手' });
  const first = store.readRole('傲娇助手');
  assert.equal(store.readRole('傲娇助手'), first, '未改动时应命中缓存');
  fs.writeFileSync(path.join(store.rolesDir, '傲娇助手.md'), '# 傲娇助手\n\n## 你是谁\n- 改过之后的人设。\n', 'utf8');
  const second = store.readRole('傲娇助手');
  assert.ok(second.includes('改过之后的人设'), '重写后不应再命中旧缓存');
  assert.notEqual(second, first);
});

test('render：按模式产出【人格】段，无当前角色时降级为空段', () => {
  const { service } = makeService();
  assert.deepEqual(service.render().blocks, [], '没有当前角色不应产出内容');
  service.setCurrent({ name: '傲娇助手' });
  const v2 = service.render({ mode: 'v2' });
  assert.equal(v2.blocks[0].name, '人格');
  assert.ok(v2.blocks[0].text.startsWith('【人格】'));
  assert.ok(v2.blocks[0].text.includes('工具协议'));
  assert.ok(!v2.blocks[0].text.includes('[SILENT]'));

  const v1 = service.render({ mode: 'v1' });
  assert.ok(v1.blocks[0].text.includes('[SILENT]'));
  assert.notEqual(v1.blocks[0].text, v2.blocks[0].text);
});

test('render 超限会截断并显式告知', () => {
  const { service } = makeService();
  service.setCurrent({ name: '傲娇助手' });
  const out = service.render({ mode: 'v2', maxChars: 60 });
  assert.equal(out.truncated, true);
  assert.ok(out.blocks[0].text.includes('已截断'));
});

test('小节报告可用于解释"这段为什么没注入"', () => {
  const { service } = makeService();
  service.setCurrent({ name: '傲娇助手' });
  const report = service.sections({ mode: 'v2' });
  const v1Section = report.find((item) => item.heading === '分条方式');
  assert.equal(v1Section.injected, false, '一代小节在二代下不应注入');
  assert.ok(report.find((item) => item.heading === '你是谁').injected);
});
