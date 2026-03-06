import { createHash } from 'crypto';
import type { GatewayTrace } from './types.js';

export function calculateTraceHash(trace: Omit<GatewayTrace, 'integrity_hash'>): string {
  const payload = {
    trace_id: trace.trace_id,
    agent_id: trace.agent_id,
    sequence_number: trace.sequence_number,
    tool_call: trace.tool_call,
    observation: {
      error: trace.observation.error,
      duration_ms: trace.observation.duration_ms,
    },
    previous_hash: trace.previous_hash ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex');
}

export function generateTraceId(): string {
  // UUID v4 using crypto.randomUUID if available (Node 14.17+), else fallback
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
