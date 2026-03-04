import { z } from 'zod';

// Base schemas
export const AgentIdSchema = z.string().uuid();
export const TraceIdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime();
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/i);

// Tool call schema
export const ToolCallSchema = z.object({
  tool_name: z.string(),
  function: z.string(),
  arguments: z.record(z.any()),
  timestamp: TimestampSchema,
});

// Input context schema
export const InputContextSchema = z.object({
  prompt: z.string(),
  retrieved_snippets: z.array(z.object({
    source: z.string(),
    content: z.string(),
    relevance_score: z.number().min(0).max(1),
  })).optional(),
  system_context: z.record(z.any()).optional(),
});

// Thought chain schema
export const ThoughtChainSchema = z.object({
  raw_tokens: z.string(),
  parsed_steps: z.array(z.string()).optional(),
  confidence_score: z.number().min(0).max(1).optional(),
});

// Observation schema
export const ObservationSchema = z.object({
  raw_output: z.any(),
  error: z.string().optional(),
  duration_ms: z.number().positive(),
  metadata: z.record(z.any()).optional(),
});

// Safety policy validation
export const SafetyValidationSchema = z.object({
  policy_name: z.string(),
  passed: z.boolean(),
  violations: z.array(z.string()).optional(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});

// Main trace schema
export const AgentActionTraceSchema = z.object({
  trace_id: TraceIdSchema,
  parent_trace_id: TraceIdSchema.optional(),
  agent_id: AgentIdSchema,
  timestamp: TimestampSchema,
  sequence_number: z.number().int().nonnegative(),

  // Core fields
  input_context: InputContextSchema,
  thought_chain: ThoughtChainSchema,
  tool_call: ToolCallSchema,
  observation: ObservationSchema,

  // Security & Integrity
  integrity_hash: HashSchema,
  previous_hash: HashSchema.optional(),
  signature: z.string().optional(),

  // Safety & Compliance
  safety_validation: SafetyValidationSchema.optional(),
  approval_status: z.enum(['APPROVED', 'PENDING_APPROVAL', 'REJECTED', 'AUTO_APPROVED']).optional(),
  approved_by: z.string().optional(),

  // Metadata
  environment: z.enum(['DEVELOPMENT', 'STAGING', 'PRODUCTION']).default('DEVELOPMENT'),
  version: z.string().default('1.0.0'),
  tags: z.array(z.string()).optional(),
});

// Enum exports (for runtime use)
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type ApprovalStatus = 'APPROVED' | 'PENDING_APPROVAL' | 'REJECTED' | 'AUTO_APPROVED';

// Type exports
export type AgentActionTrace = z.infer<typeof AgentActionTraceSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type InputContext = z.infer<typeof InputContextSchema>;
export type ThoughtChain = z.infer<typeof ThoughtChainSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type SafetyValidation = z.infer<typeof SafetyValidationSchema>;

// Trace bundle schema (for export)
export const TraceBundleSchema = z.object({
  bundle_id: z.string().uuid(),
  created_at: TimestampSchema,
  traces: z.array(AgentActionTraceSchema),
  metadata: z.object({
    agent_id: AgentIdSchema,
    session_id: z.string().uuid(),
    export_reason: z.string(),
    total_traces: z.number().int().positive(),
    hash_chain_valid: z.boolean(),
    signature: z.string().optional(),
  }),
});

export type TraceBundle = z.infer<typeof TraceBundleSchema>;

// API request/response schemas
export const CreateTraceRequestSchema = AgentActionTraceSchema.omit({
  integrity_hash: true,
  signature: true,
});

export const TraceQuerySchema = z.object({
  agent_id: AgentIdSchema.optional(),
  start_time: TimestampSchema.optional(),
  end_time: TimestampSchema.optional(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  approval_status: z.enum(['APPROVED', 'PENDING_APPROVAL', 'REJECTED', 'AUTO_APPROVED']).optional(),
  limit: z.number().int().positive().max(1000).default(100),
  offset: z.number().int().nonnegative().default(0),
});

export type CreateTraceRequest = z.infer<typeof CreateTraceRequestSchema>;
export type TraceQuery = z.infer<typeof TraceQuerySchema>;

// Utility functions
export function validateTraceChain(traces: AgentActionTrace[]): boolean {
  if (traces.length === 0) return true;

  for (let i = 1; i < traces.length; i++) {
    if (traces[i].previous_hash !== traces[i - 1].integrity_hash) {
      return false;
    }
  }

  return true;
}

export function calculateTraceHash(trace: Omit<AgentActionTrace, 'integrity_hash' | 'signature'>): string {
  // This is a placeholder - in production, use proper crypto library
  const content = JSON.stringify({
    trace_id: trace.trace_id,
    agent_id: trace.agent_id,
    timestamp: trace.timestamp,
    input_context: trace.input_context,
    thought_chain: trace.thought_chain,
    tool_call: trace.tool_call,
    observation: trace.observation,
    previous_hash: trace.previous_hash || '',
  });

  // In real implementation, use crypto.createHash('sha256')
  return 'sha256_' + Buffer.from(content).toString('base64').replace(/[^a-f0-9]/gi, '').substring(0, 64);
}