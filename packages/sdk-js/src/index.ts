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

/**
 * CodeShield helper — scan agent-generated code before dispatch, get
 * severity + findings, and have the verdict auto-attach to the next
 * /check call for the same agent so DSL rules can react on-hop.
 */
export {
  scan as codeShieldScan,
  consumeBuffer as codeShieldConsume,
  LANGUAGES as CODE_SHIELD_LANGUAGES,
} from './integrations/code-shield.js';
export type {
  CodeShieldResult,
  CodeShieldFinding,
  CodeShieldLanguage,
  ScanOptions as CodeShieldScanOptions,
} from './integrations/code-shield.js';

/**
 * Alignment helper — audit a proposed tool call against the agent's
 * declared goal via `/api/v1/alignment/check`. Same closed-loop
 * bridge as code_shield: verdict flows into the next /check payload
 * automatically.
 */
export {
  check as alignmentCheck,
  consumeBuffer as alignmentConsume,
  PROVIDERS as ALIGNMENT_PROVIDERS,
} from './integrations/alignment.js';
export type {
  AlignmentVerdict,
  AlignmentProvider,
  CheckOptions as AlignmentCheckOptions,
  ProposedAction as AlignmentProposedAction,
} from './integrations/alignment.js';

/** Internal transport export for reliability tests (underscore-prefixed). */
export { HttpTransport as _HttpTransport } from './transport/http.js';

/** Internal alignment buffer exports for tests (underscore-prefixed). */
export {
  record as _alignRecord,
  consume as _alignConsume,
  reset as _alignReset,
  toCheckPayload as _alignToCheckPayload,
  TTL_MS as _ALIGN_TTL_MS,
} from './integrations/alignment-state.js';

/**
 * Internal helpers re-exported only for the in-tree test suite. The
 * underscore prefix flags them as not part of the stable surface; do
 * not import these from user code. They may change shape between
 * minor releases.
 */
export {
  record as _csRecord,
  consume as _csConsume,
  reset as _csReset,
  toCheckPayload as _csToCheckPayload,
  TTL_MS as _CS_TTL_MS,
} from './integrations/code-shield-state.js';

// Default export: the `auto` function for zero-code setup
import { auto } from './interceptors/auto.js';
import { scan as codeShieldScan } from './integrations/code-shield.js';
export default { auto, codeShield: { scan: codeShieldScan } };
