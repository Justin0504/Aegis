/**
 * BFSI DSL preset pack tests.
 *
 * Contracts pinned here:
 *   1. Every listed pack parses against the PolicyDslSchema.
 *   2. Every rule in every pack has a `tags` list including the
 *      framework slug (glba / pci / sox) — so the audit trail can
 *      filter "which pack fired this decision".
 *   3. mergePack:
 *        · appends non-conflicting rules
 *        · preserves the base document's version when a rule name
 *          collides (tenant edit wins)
 *        · caps at the 100-rule ceiling with a specific error
 *   4. Every pack has a non-empty citation string — auditors need
 *      to trace back to the specific regulation.
 */

import { PolicyDslSchema } from '@agentguard/core-schema';
import { listPacks, getPack, mergePack, type PolicyPackName } from '../policies/dsl-packs';

const ALL_PACKS: PolicyPackName[] = [
  'bfsi-glba', 'bfsi-pci-dss', 'bfsi-sox',
  'bfsi-dora', 'healthcare-hipaa', 'gov-fedramp',
];

describe('DSL packs · registry', () => {
  test('listPacks returns exactly the declared packs', () => {
    const names = listPacks().map((p) => p.name).sort();
    expect(names).toEqual([...ALL_PACKS].sort());
  });

  test.each(ALL_PACKS)('%s pack parses cleanly against PolicyDslSchema', (name) => {
    const pack = getPack(name)!;
    const result = PolicyDslSchema.safeParse(pack.dsl);
    if (!result.success) {
      throw new Error(`${name} failed: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(pack.dsl.version).toBe(1);
    expect(pack.dsl.rules.length).toBeGreaterThan(0);
  });

  test.each(ALL_PACKS)('%s pack has a non-empty citation', (name) => {
    const pack = getPack(name)!;
    expect(pack.citation).toBeTruthy();
    expect(pack.citation.length).toBeGreaterThan(10);
  });

  test('every rule carries a framework tag matching the pack slug', () => {
    // Slug used in tags — the FRAMEWORK part of the pack id, not the
    // industry prefix. e.g. bfsi-glba → 'glba', healthcare-hipaa → 'hipaa',
    // gov-fedramp → 'fedramp'.
    const TAG_BY_PACK: Record<PolicyPackName, string> = {
      'bfsi-glba':        'glba',
      'bfsi-pci-dss':     'pci',
      'bfsi-sox':         'sox',
      'bfsi-dora':        'dora',
      'healthcare-hipaa': 'hipaa',
      'gov-fedramp':      'fedramp',
    };
    for (const packName of ALL_PACKS) {
      const pack = getPack(packName)!;
      const tag = TAG_BY_PACK[packName];
      for (const rule of pack.dsl.rules) {
        expect(rule.then.tags).toBeDefined();
        expect(rule.then.tags!.some((t) => t === tag)).toBe(true);
      }
    }
  });

  test('getPack("unknown") returns null (no throw)', () => {
    expect(getPack('bogus')).toBeNull();
  });
});

describe('DSL packs · mergePack', () => {
  test('empty base + pack → pack rules verbatim', () => {
    const pack = getPack('bfsi-glba')!;
    const merged = mergePack(undefined, pack.dsl);
    expect(merged.rules.length).toBe(pack.dsl.rules.length);
    expect(merged.rules.map((r) => r.name).sort()).toEqual(
      pack.dsl.rules.map((r) => r.name).sort(),
    );
  });

  test('non-conflicting base + pack → union of rules', () => {
    const pack = getPack('bfsi-pci-dss')!;
    const base = {
      version: 1 as const,
      rules: [{
        name: 'tenant-custom-block-cron',
        when: { 'tool.name': 'run_cron' },
        then: { decision: 'block' as const, reason: 'tenant policy' },
      }],
    };
    const merged = mergePack(base, pack.dsl);
    expect(merged.rules.length).toBe(base.rules.length + pack.dsl.rules.length);
    // Tenant rule is preserved.
    expect(merged.rules.find((r) => r.name === 'tenant-custom-block-cron')).toBeDefined();
  });

  test('rule-name collision: base version wins (tenant edit preserved)', () => {
    // Tenant has "pci-block-pan-in-tool-args" with a customised
    // reason string. The pack ships a rule with the same name.
    // Post-merge, the tenant's reason MUST still be there.
    const pack = getPack('bfsi-pci-dss')!;
    const collisionName = 'pci-block-pan-in-tool-args';
    expect(pack.dsl.rules.find((r) => r.name === collisionName)).toBeDefined();
    const base = {
      version: 1 as const,
      rules: [{
        name: collisionName,
        when: { 'tool.name': 'my_custom_tool' },
        then: { decision: 'pending' as const, reason: 'tenant override — pending not block' },
      }],
    };
    const merged = mergePack(base, pack.dsl);
    const survivor = merged.rules.find((r) => r.name === collisionName)!;
    expect(survivor.then.decision).toBe('pending');
    expect(survivor.then.reason).toMatch(/tenant override/);
    // Every OTHER pack rule DID make it in.
    expect(merged.rules.length).toBe(base.rules.length + pack.dsl.rules.length - 1);
  });

  test('merging beyond 100-rule ceiling throws with a specific message', () => {
    const base = {
      version: 1 as const,
      rules: Array.from({ length: 98 }, (_, i) => ({
        name: `base-rule-${i}`,
        when: { 'tool.name': `t${i}` },
        then: { decision: 'block' as const, reason: 'x' },
      })),
    };
    const pack = getPack('bfsi-glba')!;   // has 5 rules → 98 + 5 = 103 > 100
    expect(() => mergePack(base, pack.dsl)).toThrow(/100-rule ceiling/);
  });
});
