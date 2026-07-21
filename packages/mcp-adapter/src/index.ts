import type { ToolCore } from '@ciag/tool-core';

export interface McpToolDescriptor { name: string; description: string; readOnly: true }
export class McpAdapter {
  constructor(readonly toolCore: ToolCore) {}
  listTools(): McpToolDescriptor[] { return [{ name: 'system_readiness', description: 'Returns synthetic bootstrap readiness only.', readOnly: true }]; }
  systemReadiness(): ReturnType<ToolCore['systemReadiness']> { return this.toolCore.systemReadiness(); }
}
