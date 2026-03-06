/**
 * AgentGuard JavaScript/TypeScript SDK
 *
 * Cryptographic auditing and real-time control for AI agents.
 *
 * Quick start:
 *   import agentguard from 'agentguard'
 *   agentguard.auto('http://localhost:8080', { agentId: 'my-agent' })
 *
 * Manual usage:
 *   import { AgentGuard } from 'agentguard'
 *   const guard = new AgentGuard({ gatewayUrl: '...', agentId: '...' })
 *   const search = guard.wrap('web_search', async (query) => { ... })
 */

export { AgentGuard } from './core/tracer.js';
export { AgentGuardBlockedError } from './core/types.js';
export type {
  AgentGuardConfig,
  GatewayTrace,
  CheckRequest,
  CheckResponse,
  RiskLevel,
  Environment,
  ApprovalStatus,
} from './core/types.js';
export { auto, AutoInstrument } from './interceptors/auto.js';

// Default export: the `auto` function for zero-code setup
import { auto } from './interceptors/auto.js';
export default { auto };
