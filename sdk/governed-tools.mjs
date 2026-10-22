import { GovernedToolError } from './governed-tools/contract.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new GovernedToolError('NODE_24_REQUIRED');
}

// Delay the SQLite import until after the explicit runtime compatibility check.
export const { createGovernedTools } = await import('./governed-tools/executor.mjs');
export const { wrapMcpClient } = await import('./governed-tools/mcp.mjs');
export { GovernedToolError };
