// 角色卡的读写与缓存。
//
// 两条从 qq-bridge 原样带来的经验，改动前先看懂：
//
// 1) 角色名必须净化 + 目录逃逸校验。state/current-role.json 是**用户可直接编辑**的文件，
//    没有这道校验时 {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来，
//    并注入到每一条提示词里（bridge.js 里的既有注释就是这么写的）。
//
// 2) 缓存 key 必须带上**文件名 + mtime + size**，不能只看 mtime：
//    ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
//       两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
//       带上名字后，切换角色（a.md → b.md）永远不会误命中。
//    ② 同名原地重写若长度变了（大多数编辑都会），size 变化也能击穿缓存。
//    代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
import fs from 'node:fs';
import path from 'node:path';

const FILE_MODE = 0o600;

export function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w一-龥-]/g, '');
}

function atomicWrite(filePath, text) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: FILE_MODE });
  fs.renameSync(tmp, filePath);
}

export function createRoleStore({ rolesDir, stateDir } = {}) {
  if (!rolesDir) throw new Error('createRoleStore 需要 rolesDir');
  if (!stateDir) throw new Error('createRoleStore 需要 stateDir');
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const stateFile = path.join(stateDir, 'current-role.json');
  const resolvedRolesDir = path.resolve(rolesDir);
  const prefix = resolvedRolesDir + path.sep;
  const cache = new Map();

  /** 角色名 → 绝对路径；不合法或越界一律返回 null。 */
  function rolePath(name) {
    const safe = sanitizeRoleName(name);
    if (!safe || safe.includes('..')) return null;
    const full = path.resolve(path.join(resolvedRolesDir, `${safe}.md`));
    if (!full.startsWith(prefix)) return null;
    return full;
  }

  function listRoles() {
    try {
      return fs
        .readdirSync(resolvedRolesDir)
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -3))
        .filter((name) => sanitizeRoleName(name) === name && name.length > 0)
        .sort((a, b) => a.localeCompare(b, 'zh'));
    } catch {
      return [];
    }
  }

  function readRole(name) {
    const full = rolePath(name);
    if (!full || !fs.existsSync(full)) return '';
    try {
      const stat = fs.statSync(full);
      const key = `${sanitizeRoleName(name)}:${stat.mtimeMs}:${stat.size}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const raw = fs.readFileSync(full, 'utf8');
      cache.set(key, raw);
      return raw;
    } catch {
      return '';
    }
  }

  function writeRole(name, content) {
    const full = rolePath(name);
    if (!full) throw new Error(`角色名不合法：${name}`);
    atomicWrite(full, String(content ?? ''));
    try {
      fs.chmodSync(full, FILE_MODE);
    } catch {
      /* Windows 上可能不支持 */
    }
    cache.clear();
    return { name: sanitizeRoleName(name), chars: String(content ?? '').length };
  }

  function removeRole(name) {
    const full = rolePath(name);
    if (!full || !fs.existsSync(full)) return false;
    fs.rmSync(full);
    cache.clear();
    return true;
  }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const role = sanitizeRoleName(parsed?.role ?? '') || null;
      // 当前角色必须指向一张真实存在的卡：state 文件是用户可编辑的，
      // 指向不存在/被改名的卡时按"未设置"处理，避免上层拿着空内容还以为注入成功了。
      const exists = role ? fs.existsSync(path.join(resolvedRolesDir, `${role}.md`)) : false;
      return { role: exists ? role : null, updatedAt: parsed?.updatedAt ?? null };
    } catch {
      return { role: null, updatedAt: null };
    }
  }

  function writeState(role) {
    const safe = role ? sanitizeRoleName(role) : '';
    atomicWrite(stateFile, `${JSON.stringify({ role: safe, updatedAt: Date.now() })}\n`);
    return { role: safe || null };
  }

  return {
    rolesDir: resolvedRolesDir,
    stateFile,
    listRoles,
    readRole,
    writeRole,
    removeRole,
    current: () => readState().role,
    setCurrent: (name) => writeState(name).role,
    clearCurrent: () => writeState('').role,
    state: readState,
    /** 给控制台 / 诊断用的快照。 */
    stats() {
      return { roles: listRoles().length, current: readState().role, cacheEntries: cache.size };
    },
  };
}
