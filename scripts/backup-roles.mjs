#!/usr/bin/env node
// 角色卡备份：把 roles/*.md 与 state/current-role.json 复制到 state/backups/roles-<时间>/，保留最近 7 份。
//
// 角色卡是纯文本、体量很小（十几 KB），所以不需要压缩，直接目录快照最直观，
// 恢复时把文件拷回去即可 —— 不需要任何解压工具参与灾难恢复。
//
// 令牌单独存一份 http-token.bak，不参与轮转：桥接只在启动时读一次，换令牌要重启才生效。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = 7;

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
    + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function prune(backupDir, keep) {
  const pattern = /^roles-\d{8}-\d{6}$/;
  const dirs = fs.readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(backupDir, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const stale = dirs.slice(keep);
  for (const dir of stale) fs.rmSync(path.join(backupDir, dir.name), { recursive: true, force: true });
  return stale.map((dir) => dir.name);
}

export function backupRoles({ rolesDir, stateDir, keep = KEEP, logger = console.log } = {}) {
  const roles = path.resolve(rolesDir ?? process.env.ROLECARD_MCP_ROLES_DIR ?? path.join(PKG_ROOT, 'roles'));
  const state = path.resolve(stateDir ?? process.env.ROLECARD_MCP_STATE_DIR ?? path.join(PKG_ROOT, 'state'));

  if (!fs.existsSync(roles)) {
    logger(`[backup] 没有角色卡目录（${roles}），无需备份`);
    return { skipped: true };
  }
  const cards = fs.readdirSync(roles)
    .filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md');
  if (!cards.length) {
    logger(`[backup] 角色卡目录为空（${roles}），无需备份`);
    return { skipped: true };
  }

  const backupDir = path.join(state, 'backups');
  const target = path.join(backupDir, `roles-${stamp()}`);
  fs.mkdirSync(target, { recursive: true });
  for (const name of cards) fs.copyFileSync(path.join(roles, name), path.join(target, name));

  const current = path.join(state, 'current-role.json');
  if (fs.existsSync(current)) fs.copyFileSync(current, path.join(target, 'current-role.json'));

  const tokenFile = path.join(state, 'http-token');
  if (fs.existsSync(tokenFile)) fs.copyFileSync(tokenFile, path.join(backupDir, 'http-token.bak'));

  const removed = prune(backupDir, keep);
  logger(`[backup] 已生成 ${target}（${cards.length} 张卡）${removed.length ? `，清理 ${removed.length} 份旧快照` : ''}`);
  return { target, cards, removed };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    backupRoles();
  } catch (error) {
    console.error('[backup] 失败：', error?.stack ?? error);
    process.exitCode = 1;
  }
}
