import type { ToolCore } from '@ciag/tool-core';
import { requireReadOnlyCapability } from '@ciag/security';

export interface McpToolDescriptor { name: string; description: string; readOnly: true }
export class McpAdapter {
  constructor(readonly toolCore: ToolCore) {}
  listTools(): McpToolDescriptor[] {
    const tools: McpToolDescriptor[] = [{ name: 'system_readiness', description: 'Returns synthetic bootstrap readiness only.', readOnly: true }];
    for (const tool of tools) {
      requireReadOnlyCapability(tool.name);
    }
    return tools;
  }
  systemReadiness(): ReturnType<ToolCore['systemReadiness']> { return this.toolCore.systemReadiness(); }
}
