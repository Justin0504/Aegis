/**
 * Agent registry — first-class agent identity for AEGIS.
 *
 * Before the registry, `agent_id` was a string anyone could pass. After the
 * registry it's a registered, scoped, status-checked identity that every
 * audit row and policy decision attributes against. Three trust levels:
 *
 *   unregistered  first sighting auto-records; AEGIS continues to serve
 *                 (backward compat) but audit rows are tagged 'weak'.
 *   active        operator completed registration; full trust, declared
 *                 tool scope enforced, per-agent budget honored.
 *   suspended     operator pause; AEGIS blocks ALL calls at the gate.
 *   deprecated    soft-deleted; behaves like suspended but excluded from
 *                 default list endpoints.
 */

import { z } from 'zod';

export const AgentStatusSchema = z.enum([
  'unregistered',
  'active',
  'suspended',
  'deprecated',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentEnvironmentSchema = z.enum(['dev', 'staging', 'prod']);
export type AgentEnvironment = z.infer<typeof AgentEnvironmentSchema>;

/** Data-classification ladder the agent may operate against. The ID card's
 *  `data_classes` claim says "this agent is allowed to TOUCH data at these
 *  classification levels". Used by DSL rules + detectors to refuse
 *  out-of-class data access. Order matters — `public` ⊂ `internal` ⊂
 *  `confidential` ⊂ `restricted`. */
export const DataClassSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type DataClass = z.infer<typeof DataClassSchema>;

/** Optional provenance — where the agent came from. SDKs auto-populate
 *  build_artifact + source_commit on first sighting from env vars; the
 *  ID card surfaces them so an auditor can trace the agent runtime back
 *  to a specific commit / image. */
export const AgentProvenanceSchema = z.object({
  /** Container image / binary SHA-256, e.g. "sha256:abc123…". */
  build_artifact: z.string().min(1).max(200).optional(),
  /** Source URI of the build, typically `git+<repo>@<commit-sha>`. */
  source_commit: z.string().min(1).max(300).optional(),
  /** Parent agent that spawned this agent. Null for top-level agents. */
  spawned_by: z.string().min(1).max(128).optional(),
}).strict();
export type AgentProvenance = z.infer<typeof AgentProvenanceSchema>;

/** Capability claims beyond declared_tools. Operator-controlled at
 *  registration time; ID card carries them; detectors and DSL can branch
 *  on them. Empty / absent = "no explicit limit from the registry". */
export const AgentCapabilitiesSchema = z.object({
  /** Data classifications the agent may operate against. Default empty
   *  → no claim made. Customer DSL rules can refuse anything not in this
   *  list. */
  data_classes: z.array(DataClassSchema).max(4).optional(),
  /** Per-minute hard ceiling on calls from this agent. */
  calls_per_minute: z.number().int().min(1).max(100_000).optional(),
  /** Max recursion depth for agent-spawn loops. Prevents runaway. */
  recursion_depth: z.number().int().min(1).max(20).optional(),
  /** Whether this agent is allowed to spawn sub-agents via the
   *  forthcoming /agents/spawn endpoint. Default false. */
  may_spawn_subagents: z.boolean().optional(),
}).strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** Payload that operators POST to /api/v1/agents to register a new agent.
 *  All optional — the only required identity is the auto-generated UUID. */
export const AgentRegistrationRequestSchema = z.object({
  /** Provide one to register a specific id (e.g. promote an unregistered
   *  agent the SDK has been calling in as). Omit to mint a fresh UUID. */
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  owner_email: z.string().email().optional(),
  declared_tools: z.array(z.string().min(1).max(120)).max(200).optional(),
  max_cost_daily_usd: z.number().min(0).optional(),
  environments: z.array(AgentEnvironmentSchema).max(5).optional(),
  /** Issue an agent secret on registration. Returned ONCE in the
   *  response; only SHA-256 hash is kept server-side. */
  issue_secret: z.boolean().default(false),
  /** Optional pinned Ed25519 public key (PEM) for agent-signed requests. */
  public_key_pem: z.string().optional(),
  /** Capability claims beyond tool scope — data classes, QPS,
   *  recursion depth, spawn rights. Surface on the ID card. */
  capabilities: AgentCapabilitiesSchema.optional(),
  /** Build artifact + source commit + parent agent. SDK can auto-fill
   *  build_artifact + source_commit from env vars on first sighting. */
  provenance: AgentProvenanceSchema.optional(),
  /**
   * Deterministic content hash of the agent's workflow graph
   * (WorkflowExtractorService's `content_hash`). When set, the gateway
   * binds this hash into the agent's registry row and — from L4
   * onwards — rejects incoming traffic whose sighted workflow hash
   * doesn't match. Opt-in per agent: legacy agents that register
   * without one keep working unchanged.
   *
   * 64 lowercase hex chars (SHA-256). Compute via
   * `graphContentHash()` from services/workflow/types.ts.
   */
  workflow_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type AgentRegistrationRequest = z.infer<typeof AgentRegistrationRequestSchema>;
/** Input shape — what callers actually pass (defaults not yet applied). */
export type AgentRegistrationInput = z.input<typeof AgentRegistrationRequestSchema>;

export const AgentUpdateRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  owner_email: z.string().email().optional(),
  declared_tools: z.array(z.string().min(1).max(120)).max(200).optional(),
  max_cost_daily_usd: z.number().min(0).nullable().optional(),
  environments: z.array(AgentEnvironmentSchema).max(5).optional(),
  status: AgentStatusSchema.exclude(['unregistered']).optional(),
  public_key_pem: z.string().nullable().optional(),
  capabilities: AgentCapabilitiesSchema.nullable().optional(),
  provenance: AgentProvenanceSchema.nullable().optional(),
  /** Rebind or clear the workflow attestation hash. `null` = clear.
   *  Same shape rules as AgentRegistrationRequestSchema.workflow_hash. */
  workflow_hash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
export type AgentUpdateRequest = z.infer<typeof AgentUpdateRequestSchema>;

/** The public shape of a registered agent. `secret` is only present on
 *  the registration response (and on rotate-secret). */
export interface RegisteredAgent {
  id: string;
  org_id: string;
  name?: string;
  description?: string;
  owner_email?: string;
  /** Workflow attestation hash. Present iff the agent registered with
   *  a workflow_hash. Downstream `authorize()` calls compare this
   *  against the incoming request's asserted hash and fail the check
   *  on mismatch. */
  workflow_hash?: string;
  declared_tools?: ReadonlyArray<string>;
  max_cost_daily_usd?: number;
  environments?: ReadonlyArray<AgentEnvironment>;
  status: AgentStatus;
  has_secret: boolean;
  has_public_key: boolean;
  capabilities?: AgentCapabilities;
  provenance?: AgentProvenance;
  created_at: string;
  updated_at: string;
  last_seen_at?: string;
}

/**
 * AEGIS Agent ID v1 — the canonical "agent identity card".
 *
 * Carried as a signed JWT (alg=EdDSA, kid=<gateway-key-id>). Customers
 * (operators, downstream services, auditors) can verify offline against
 * the AEGIS-published gateway public key — same key the transparency-log
 * roots use — and read out the agent's declared capability profile.
 *
 * Signing scope: the JWT signature covers every claim below except the
 * (separately-carried) signature itself.
 */
export interface AgentIdCardClaims {
  v: 1;
  /** Issuing AEGIS gateway, e.g. "aegis-gateway:default". */
  iss: string;
  /** Intended audience — typically same as iss; can be customer-set for
   *  multi-gateway federation. */
  aud: string;
  /** Subject — the agent id this card identifies. */
  sub: string;
  /** issued-at, seconds since epoch. */
  iat: number;
  /** expires-at, seconds since epoch. Default 24h post-iat. */
  exp: number;

  name?: string;
  owner_email?: string;
  org_id: string;
  scope: {
    tools: ReadonlyArray<string>;
    environments: ReadonlyArray<AgentEnvironment>;
    data_classes: ReadonlyArray<DataClass>;
  };
  limits: {
    cost_daily_usd?: number;
    calls_per_minute?: number;
    recursion_depth?: number;
    may_spawn_subagents?: boolean;
  };
  provenance: AgentProvenance;
  keys?: {
    alg: 'ed25519';
    pub: string;
    kid: string;
    rotated_count: number;
  };
  lifecycle: {
    status: AgentStatus;
    last_rotated_at?: string;
  };
}

export interface AgentRegistrationResponse {
  agent: RegisteredAgent;
  /** Plaintext secret returned ONCE on issue. */
  secret?: string;
}

/** Audit-side attribution strength. Stays loose for unregistered agents so
 *  legacy callers continue to work; tightens to 'strong' once promoted. */
export type AttributionStrength = 'strong' | 'weak' | 'unknown';
