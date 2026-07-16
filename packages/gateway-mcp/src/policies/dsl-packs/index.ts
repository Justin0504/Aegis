/**
 * Preset DSL policy packs — regulation-aligned rulesets that operators
 * can apply as-is (or as a starting point) instead of authoring rules
 * from scratch.
 *
 * These are NOT deployment templates (see policies/templates/). A
 * deployment template is a whole TenantConfig; a pack is JUST the
 * DSL rules block, meant to be merged into whichever base template
 * (financial, healthcare, standard, …) the operator has chosen.
 *
 * Regulation coverage:
 *   · bfsi-glba        — Gramm-Leach-Bliley Safeguards Rule (US finance)
 *   · bfsi-pci-dss     — Payment Card Industry Data Security Standard
 *   · bfsi-sox         — Sarbanes-Oxley financial-reporting controls
 *   · bfsi-dora        — EU Digital Operational Resilience Act
 *   · healthcare-hipaa — HIPAA Security + Privacy Rules
 *   · gov-fedramp      — FedRAMP Moderate (NIST SP 800-53 Rev 5)
 *
 * Each pack:
 *   - is a valid PolicyDsl document (`version: 1`, up to 100 rules)
 *   - is validated at module-load time so a bad pack fails fast
 *   - carries a `description` explaining WHAT it blocks + WHY, and a
 *     `citation` pointing at the specific regulatory clause the pack
 *     addresses (so an auditor can cross-check)
 *
 * The rules are DELIBERATELY conservative — every pack skews toward
 * `pending` (human review) rather than outright `block` for anything
 * a well-behaved agent might do legitimately in a compliant workflow.
 * Operators can tighten to `block` once their agents' behavior baseline
 * is stable.
 */

import { PolicyDsl, PolicyDslSchema } from '@agentguard/core-schema';
import { bfsiGlbaPack } from './bfsi-glba';
import { bfsiPciDssPack } from './bfsi-pci-dss';
import { bfsiSoxPack } from './bfsi-sox';
import { doraPack } from './dora';
import { hipaaPack } from './hipaa';
import { fedrampPack } from './fedramp';

export interface PolicyPackMeta {
  name: PolicyPackName;
  description: string;
  citation: string;
  rule_count: number;
  dsl: PolicyDsl;
}

export type PolicyPackName =
  | 'bfsi-glba'
  | 'bfsi-pci-dss'
  | 'bfsi-sox'
  | 'bfsi-dora'
  | 'healthcare-hipaa'
  | 'gov-fedramp';

const RAW: Record<PolicyPackName, {
  description: string;
  citation: string;
  dsl: PolicyDsl;
}> = {
  'bfsi-glba':        bfsiGlbaPack,
  'bfsi-pci-dss':     bfsiPciDssPack,
  'bfsi-sox':         bfsiSoxPack,
  'bfsi-dora':        doraPack,
  'healthcare-hipaa': hipaaPack,
  'gov-fedramp':      fedrampPack,
};

// Fail-fast validation at module load. If a pack ever grows a bad
// rule shape, the gateway won't start rather than silently shipping
// a broken pack to prod.
for (const [name, { dsl }] of Object.entries(RAW)) {
  const parsed = PolicyDslSchema.safeParse(dsl);
  if (!parsed.success) {
    throw new Error(
      `Policy pack "${name}" failed schema validation: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
}

export function listPacks(): PolicyPackMeta[] {
  return (Object.keys(RAW) as PolicyPackName[]).map((name) => ({
    name,
    description: RAW[name].description,
    citation:    RAW[name].citation,
    rule_count:  RAW[name].dsl.rules.length,
    dsl:         RAW[name].dsl,
  }));
}

export function getPack(name: string): PolicyPackMeta | null {
  if (!(name in RAW)) return null;
  const n = name as PolicyPackName;
  return {
    name: n,
    description: RAW[n].description,
    citation:    RAW[n].citation,
    rule_count:  RAW[n].dsl.rules.length,
    dsl:         RAW[n].dsl,
  };
}

/**
 * Merge a pack's rules into an existing PolicyDsl.
 *
 * Semantics:
 *   · pack rules are APPENDED to the base document
 *   · duplicate rule names (by `name` field) are DE-DUPLICATED —
 *     the base document's rule wins, so an operator who has already
 *     customized a rule the pack ships doesn't get their edits
 *     overwritten
 *   · resulting rules[] is capped at 100 (PolicyDslSchema limit);
 *     overflow throws so the operator sees the ceiling instead of
 *     silently losing rules
 */
export function mergePack(base: PolicyDsl | undefined, pack: PolicyDsl): PolicyDsl {
  const baseDoc: PolicyDsl = base ?? { version: 1, rules: [] };
  const baseNames = new Set(baseDoc.rules.map((r) => r.name));
  const additions = pack.rules.filter((r) => !baseNames.has(r.name));
  const merged: PolicyDsl = {
    version: 1,
    rules: [...baseDoc.rules, ...additions],
  };
  if (merged.rules.length > 100) {
    throw new Error(
      `merging pack would exceed the 100-rule ceiling ` +
      `(base=${baseDoc.rules.length}, additions=${additions.length})`,
    );
  }
  // Re-validate for belt-and-suspenders.
  const parsed = PolicyDslSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`merged DSL failed validation: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}
