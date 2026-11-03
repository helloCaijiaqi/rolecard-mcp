// 从 qq-bridge 复制式导入人格卡与当前角色。只复制不移动，原件留 .bak。
//
// 用法：
//   node scripts/migrate-from-qq-bridge.mjs [--source c:/qq-bridge] [--roles-dir <dir>] [--state-dir <dir>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// README 是说明文档，不是人格卡，不能当成角色导入。
const SKIP_FILES = new Set(['README.md', 'readme.md']);

function parseArgs(argv) {
  const args = {
    source: process.env.QQ_BRIDGE_DIR ?? 'c:/qq-bridge',
    rolesDir: path.join(PKG_ROOT, 'roles'),
    stateDir: path.join(PKG_ROOT, 'state'),
    dryRun: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const [key, inline] = argv[i].replace(/^--/, '').split('=');
    const value = inline ?? (['dry-run', 'force'].includes(key) ? true : argv[i + 1]);
    if (key === 'source') args.source = value;
    else if (key === 'roles-dir') args.rolesDir = value;
    else if (key === 'state-dir') args.stateDir = value;
    else if (key === 'dry-run') args.dryRun = true;
    else if (key === 'force') args.force = true;
  }
  return args;
}

export function migrate(args) {
  const sourceRoles = path.join(path.resolve(args.source), 'roles');
  const sourceState = path.join(path.resolve(args.source), 'state', 'current-role.json');
  const report = { sourceRoles, roles: { copied: [], skipped: [] }, currentRole: null, backups: [] };

  if (!fs.existsSync(sourceRoles)) {
    report.error = `源人格卡目录不存在：${sourceRoles}`;
    return report;
  }
  fs.mkdirSync(args.rolesDir, { recursive: true });
  fs.mkdirSync(args.stateDir, { recursive: true });

  for (const file of fs.readdirSync(sourceRoles).sort()) {
    if (!file.endsWith('.md') || SKIP_FILES.has(file)) {
      if (!file.endsWith('.md')) report.roles.skipped.push(`${file}（非 .md）`);
      else report.roles.skipped.push(`${file}（说明文档，不是人格卡）`);
      continue;
    }
    const from = path.join(sourceRoles, file);
    const to = path.join(args.rolesDir, file);
    if (fs.existsSync(to) && !args.force) {
      report.roles.skipped.push(`${file}（目标已存在，未覆盖；需要覆盖请加 --force）`);
      continue;
    }
    if (!args.dryRun) {
      fs.copyFileSync(from, to);
      const bak = `${from}.bak`;
      fs.copyFileSync(from, bak);
      report.backups.push(bak);
    }
    report.roles.copied.push(file);
  }

  // 当前角色：只有源文件存在且指向一张已导入的卡时才写入。
  if (fs.existsSync(sourceState)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sourceState, 'utf8'));
      const name = String(parsed?.role ?? '').trim();
      if (name && fs.existsSync(path.join(args.rolesDir, `${name}.md`))) {
        report.currentRole = name;
        if (!args.dryRun) {
          fs.writeFileSync(
            path.join(args.stateDir, 'current-role.json'),
            `${JSON.stringify({ role: name, updatedAt: Date.now() })}\n`,
            { encoding: 'utf8', mode: 0o600 },
          );
        }
      } else if (name) {
        report.roles.skipped.push(`当前角色「${name}」没有对应的卡，未写入`);
      }
    } catch (error) {
      report.roles.skipped.push(`current-role.json 解析失败：${error?.message ?? error}`);
    }
  } else {
    report.roles.skipped.push('源里没有 current-role.json（未设置过当前角色）');
  }

  report.dryRun = args.dryRun === true;
  return report;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = migrate(parseArgs(process.argv));
  console.log(JSON.stringify(report, null, 2));
  console.log(
    `\n导入完成：复制 ${report.roles.copied.length} 张（${report.roles.copied.join('、') || '无'}）` +
      `，跳过 ${report.roles.skipped.length} 项，当前角色：${report.currentRole ?? '（未设置）'}`,
  );
}
