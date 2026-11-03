// stdio MCP server：把角色卡能力暴露成工具，供 DSH（任何 MCP 客户端）调用。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value ?? null, null, 2) }] });

export function createMcpRolecardServer({ role }) {
  const server = new McpServer({ name: 'rolecard-mcp', version: '0.1.0' });

  server.tool('role_list', '列出可用的人格卡名称。', {}, async () => ok({ roles: role.list(), current: role.current() }));

  server.tool(
    'role_get',
    '读取一张人格卡的全文与统计；不给 name 时读当前角色。',
    { name: z.string().optional() },
    async (args) => ok(role.get(args)),
  );

  server.tool(
    'role_set_current',
    '切换当前人格卡（必须已存在）。',
    { name: z.string().min(1) },
    async (args) => ok(role.setCurrent(args)),
  );

  server.tool('role_clear_current', '清除当前人格卡（之后不再注入人格段）。', {}, async () => ok(role.clearCurrent()));

  server.tool(
    'role_sections',
    '报告各小节在当前模式下是否会被注入，用于解释「这段为什么没生效」。',
    { name: z.string().optional(), mode: z.enum(['v1', 'v2']).optional() },
    async (args) => ok({ sections: role.sections(args) }),
  );

  /** 段落渲染：平台桥接真正要用的入口，直接产出可拼接的【人格】段。 */
  server.tool(
    'role_context_render',
    '产出可直接拼接的提示词段落（【人格】），平台桥接拿去即用。',
    { mode: z.enum(['v1', 'v2']).optional(), maxChars: z.number().int().min(1).optional(), name: z.string().optional() },
    async (args) => ok(role.render(args)),
  );

  return server;
}

export async function serveStdio({ role }) {
  const server = createMcpRolecardServer({ role });
  await server.connect(new StdioServerTransport());
  return server;
}
