/**
 * Decision receipts — proof that the gateway allowed this call.
 *
 * In-process defenses share the attacker's trust domain: a model that was
 * talked into a call can be talked into skipping the check, and a tool
 * executor has no way to tell "the gateway allowed this" from "the agent
 * says the gateway allowed this". A receipt closes that gap. Every allow
 * returns one: the call's identity (agent, tool, a hash of the arguments),
 * the decision, when, and an Ed25519 signature by the gateway's key. An
 * executor, a downstream service or an auditor verifies it offline against
 * the gateway's public key, and the hash binds it to these arguments and
 * no others.
 *
 *   AEG1.<base64url(payload JSON)>.<base64url(signature)>
 *
 * The signing key is the gateway's existing one (SigningService), the same
 * key that signs agent ID cards and evidence packs; its public half is at
 * GET /api/v1/check/receipt-key. A receipt is not an authorization to call
 * again: it carries the check id and an issue time, and a verifier that
 * cares about replay checks both.
 */

import { createHash, sign as cryptoSign } from 'node:crypto';
import { SigningService } from './signing';

export interface ReceiptPayload {
  v: 1;
  id: string;          // check_id
  org: string;
  agent: string;
  tool: string;
  args: string;        // sha256 hex of canonical JSON of the arguments
  decision: 'allow';
  by?: string;         // who allowed a held call
  iat: number;         // unix seconds
  kid: string;
}

/** Canonical JSON: sorted keys, no whitespace. Mirrors the SDKs. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson((v as any)[k])).join(',') + '}';
}

export function argsHash(args: unknown): string {
  return createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
}

const b64u = (b: Buffer) => b.toString('base64url');

export class ReceiptService {
  constructor(private signing: SigningService) {}

  issue(f: { checkId: string; orgId: string; agentId: string; toolName: string; args: unknown; decidedBy?: string }): string {
    const { key_id } = this.signing.getPublicKey();
    const payload: ReceiptPayload = {
      v: 1, id: f.checkId, org: f.orgId, agent: f.agentId, tool: f.toolName, args: argsHash(f.args),
      decision: 'allow', ...(f.decidedBy ? { by: f.decidedBy } : {}), iat: Math.floor(Date.now() / 1000), kid: key_id,
    };
    const body = Buffer.from(canonicalJson(payload), 'utf8');
    const sig = cryptoSign(null, body, this.signing.privateKey());
    return `AEG1.${b64u(body)}.${b64u(sig)}`;
  }

  publicKey(): { key_id: string; public_key_pem: string; algorithm: 'ed25519' } {
    return { ...this.signing.getPublicKey(), algorithm: 'ed25519' };
  }

  /** Verify against this gateway's key. For other keys use verifyWith. */
  verify(token: string, call?: { toolName?: string; args?: unknown; agentId?: string }) {
    return ReceiptService.verifyWith(token, this.signing.publicKeyPem(), call);
  }

  static verifyWith(token: string, publicKeyPem: string, call?: { toolName?: string; args?: unknown; agentId?: string }):
    { valid: boolean; payload?: ReceiptPayload; reason?: string; matches_call?: boolean } {
    try {
      const [tag, p, s] = token.split('.');
      if (tag !== 'AEG1' || !p || !s) return { valid: false, reason: 'not a receipt' };
      const body = Buffer.from(p, 'base64url');
      const ok = SigningService.verify(body, { signature: Buffer.from(s, 'base64url').toString('base64'), public_key_pem: publicKeyPem });
      if (!ok) return { valid: false, reason: 'signature does not verify' };
      const payload = JSON.parse(body.toString('utf8')) as ReceiptPayload;
      if (payload.v !== 1 || payload.decision !== 'allow') return { valid: false, reason: 'unsupported receipt' };
      let matches: boolean | undefined;
      if (call) {
        matches = (call.toolName === undefined || call.toolName === payload.tool)
          && (call.args === undefined || argsHash(call.args) === payload.args)
          && (call.agentId === undefined || call.agentId === payload.agent);
      }
      return { valid: true, payload, ...(matches === undefined ? {} : { matches_call: matches }) };
    } catch {
      return { valid: false, reason: 'malformed receipt' };
    }
  }
}
