// 角色卡迁移的离线单测：复制而非移动、README 不当角色、当前角色只对已导入的卡生效。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrate } from '../scripts/migrate-from-qq-bridge.mjs';

function makeSource({ withCurrent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-src-'));
  const roles = path.join(dir, 'roles');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(roles, { recursive: true });
  fs.writeFileSync(path.join(roles, '傲娇助手.md'), '# 傲娇助手\n\n## 你是谁\n- 嘴硬心软。\n', 'utf8');
  fs.writeFileSync(path.join(roles, '小鲸鱼.md'), '# 小鲸鱼\n\n## 你是谁\n- 爱用表情。\n', 'utf8');
  fs.writeFileSync(path.join(roles, 'README.md'), '# 说明\n不是人格卡。\n', 'utf8');
  if (withCurrent) {
    fs.writeFileSync(path.join(dir, 'state', 'current-role.json'), JSON.stringify({ role: '傲娇助手' }), 'utf8');
  }
  return dir;
}

function tmpDirs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'role-dst-'));
  return { rolesDir: path.join(dir, 'roles'), stateDir: path.join(dir, 'state') };
}

test('复制人格卡：README 不算角色，原件不动且留 .bak', () => {
  const src = makeSource();
  const sourceFile = path.join(src, 'roles', '傲娇助手.md');
  const before = fs.readFileSync(sourceFile, 'utf8');
  const { rolesDir, stateDir } = tmpDirs();

  const report = migrate({ source: src, rolesDir, stateDir });

  assert.deepEqual(report.roles.copied.sort(), ['傲娇助手.md', '小鲸鱼.md']);
  assert.ok(report.roles.skipped.some((reason) => reason.includes('README')), 'README 不应被当成角色');
  assert.equal(report.currentRole, '傲娇助手');
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), before, '原件不应被修改');
  assert.ok(fs.existsSync(`${sourceFile}.bak`), '原件应留备份');
  assert.ok(fs.existsSync(path.join(rolesDir, '傲娇助手.md')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'current-role.json'), 'utf8')).role, '傲娇助手');
});

test('已存在同名卡默认不覆盖（防误伤已有的修改）', () => {
  const src = makeSource();
  const { rolesDir, stateDir } = tmpDirs();
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(path.join(rolesDir, '傲娇助手.md'), '# 我已经被改过了\n', 'utf8');

  const report = migrate({ source: src, rolesDir, stateDir });
  assert.ok(report.roles.skipped.some((reason) => reason.includes('已存在')));
  assert.equal(fs.readFileSync(path.join(rolesDir, '傲娇助手.md'), 'utf8'), '# 我已经被改过了\n');
});

test('当前角色指向的卡不存在时不写入', () => {
  const src = makeSource();
  fs.writeFileSync(path.join(src, 'state', 'current-role.json'), JSON.stringify({ role: '查无此人' }), 'utf8');
  const { rolesDir, stateDir } = tmpDirs();
  const report = migrate({ source: src, rolesDir, stateDir });
  assert.equal(report.currentRole, null);
  assert.ok(report.roles.skipped.some((reason) => reason.includes('没有对应的卡')));
  assert.equal(fs.existsSync(path.join(stateDir, 'current-role.json')), false);
});

test('dry-run 不落任何文件', () => {
  const src = makeSource();
  const { rolesDir, stateDir } = tmpDirs();
  const report = migrate({ source: src, rolesDir, stateDir, dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(fs.existsSync(rolesDir), true, '目录会建（无害）');
  assert.equal(fs.existsSync(path.join(rolesDir, '傲娇助手.md')), false, 'dry-run 不应复制内容');
});
