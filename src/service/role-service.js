// 角色卡服务：列出 / 读取 / 切换当前角色 / 小节报告 / 产出可直接拼接的【人格】段。
//
// 平台无关：不认识 QQ，也不认识任何仿真模式的内部协议；"模式"只是一个取用标记（一代 / 二代）。
// 没有当前角色时不报错、不编造，返回空段 —— 由调用方决定是否提示。
import {
  GEN1_ROLE_LINE_RE,
  ROLE_INJECT_MODES,
  roleCharStats,
  roleSectionReport,
  selectRoleText,
} from '../role-card.js';

export const DEFAULT_ROLE_CONFIG = {
  maxChars: 4000,
  defaultMode: 'v2',
};

export function createRoleService({ store, config = {} } = {}) {
  if (!store) throw new Error('createRoleService 需要 store');
  const cfg = { ...DEFAULT_ROLE_CONFIG, ...config };
  const normMode = (value) => (value === 'v1' ? 'v1' : 'v2');

  return {
    config: cfg,
    modes: [...ROLE_INJECT_MODES],
    legacyLinePattern: GEN1_ROLE_LINE_RE,

    list() {
      return store.listRoles();
    },

    current() {
      return store.current();
    },

    /** 取角色详情：默认取当前角色。 */
    get({ name } = {}) {
      const roleName = name ?? store.current();
      if (!roleName) return null;
      const content = store.readRole(roleName);
      if (!content) return null;
      return {
        name: roleName,
        content,
        chars: content.length,
        stats: roleCharStats(content),
      };
    },

    setCurrent({ name } = {}) {
      const roleName = String(name ?? '').trim();
      if (!roleName) throw new Error('角色名不能为空');
      if (!store.listRoles().includes(roleName)) {
        throw new Error(`角色不存在：${roleName}（可用角色：${store.listRoles().join('、') || '（空）'}）`);
      }
      return { current: store.setCurrent(roleName) };
    },

    clearCurrent() {
      return { current: store.clearCurrent() };
    },

    /** 小节级报告：控制台用它解释"为什么这一段没被注入"。 */
    sections({ name, mode = cfg.defaultMode } = {}) {
      const roleName = name ?? store.current();
      if (!roleName) return [];
      const content = store.readRole(roleName);
      if (!content) return [];
      return roleSectionReport(content, normMode(mode));
    },

    /** 产出可直接拼接的【人格】段。 */
    render({ mode = cfg.defaultMode, maxChars, name } = {}) {
      const roleName = name ?? store.current();
      if (!roleName) return { blocks: [], truncated: false };
      const raw = store.readRole(roleName);
      if (!raw) return { blocks: [], truncated: false };
      // 先按模式筛掉不适用的小节，再截断：否则另一模式的内容会白占本次的注入预算。
      const selected = selectRoleText(raw, normMode(mode));
      if (!selected) return { blocks: [], truncated: false };
      const limit = Math.max(1, Number(maxChars ?? cfg.maxChars));
      let text = `【人格】\n${selected}`;
      let truncated = false;
      if (text.length > limit) {
        text = `${text.slice(0, Math.max(0, limit - 12))}\n…（已截断）`;
        truncated = true;
      }
      return { blocks: [{ name: '人格', text, chars: text.length }], truncated };
    },

    stats() {
      return store.stats();
    },
  };
}
