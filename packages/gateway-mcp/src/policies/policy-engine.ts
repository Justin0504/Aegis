import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import { SafetyValidation, RiskLevel } from '@agentguard/core-schema';
import Ajv from 'ajv';
import { classifyToolCall, ClassificationResult, ToolCategory } from '../services/classifier';

interface Policy {
  id: string;
  name: string;
  description: string;
  policy_schema: any;
  risk_level: RiskLevel;
  enabled: boolean;
}

interface ToolCallRequest {
  tool: string;
  arguments: any;
  /** Optional user-declared overrides: { "my_tool": "database" } */
  userCategoryOverrides?: Record<string, ToolCategory>;
}

/** Which categories each built-in policy applies to (replaces hardcoded tool names) */
const POLICY_CATEGORIES: Record<string, ToolCategory[]> = {
  'sql-injection':    ['database'],
  'file-access':      ['file'],
  'network-access':   ['network'],
  'prompt-injection': [],         // empty = applies to all
  'data-exfiltration':['network', 'communication'],
}

export class PolicyEngine {
  private ajv: Ajv;
  private policies: Map<string, Policy> = new Map();

  constructor(
    private db: Database.Database,
    private logger: Logger
  ) {
    this.ajv = new Ajv({ allErrors: true });
    this.loadPolicies();
  }

  private loadPolicies() {
    const stmt = this.db.prepare('SELECT * FROM policies WHERE enabled = 1');
    const policies = stmt.all() as any[];

    for (const policy of policies) {
      try {
        const parsedPolicy: Policy = {
          ...policy,
          policy_schema: JSON.parse(policy.policy_schema),
        };
        this.policies.set(parsedPolicy.name, parsedPolicy);
        this.logger.info({ policy: parsedPolicy.name }, 'Loaded policy');
      } catch (error) {
        this.logger.error({ error, policy: policy.name }, 'Failed to load policy');
      }
    }
  }

  async validateToolCall(request: ToolCallRequest): Promise<SafetyValidation & { classification: ClassificationResult }> {
    // Run classifier first — feeds into policy matching
    const classification = classifyToolCall(
      request.tool,
      request.arguments,
      request.userCategoryOverrides ?? {},
    );

    this.logger.debug(
      { tool: request.tool, category: classification.category, source: classification.source },
      'Tool classified'
    );

    const violations: string[] = [];
    let highestRiskLevel: RiskLevel = 'LOW';
    let failedPolicy: string | null = null;

    // Promote any content-level risk signals into violations
    for (const risk of classification.risks) {
      violations.push(risk.detail);
      if (this.compareRiskLevels(risk.severity, highestRiskLevel) > 0) {
        highestRiskLevel = risk.severity;
      }
      if (!failedPolicy) failedPolicy = `content-scan:${risk.type}`;
    }

    // Apply all policies that match this tool's category
    for (const [name, policy] of this.policies) {
      if (this.policyApplies(policy, request, classification.category)) {
        const validate = this.ajv.compile(policy.policy_schema);
        const valid = validate(request.arguments);

        if (!valid) {
          failedPolicy = name;
          violations.push(...(validate.errors?.map(e => e.message || 'Unknown error') || []));

          if (this.compareRiskLevels(policy.risk_level, highestRiskLevel) > 0) {
            highestRiskLevel = policy.risk_level;
          }

          this.logger.warn(
            { policy: name, tool: request.tool, category: classification.category, errors: validate.errors },
            'Policy validation failed'
          );
        }
      }
    }

    return {
      policy_name: failedPolicy || 'none',
      passed: violations.length === 0,
      violations: violations.length > 0 ? violations : undefined,
      risk_level: highestRiskLevel,
      classification,
    };
  }

  private policyApplies(policy: Policy, request: ToolCallRequest, category: ToolCategory): boolean {
    const categories = POLICY_CATEGORIES[policy.id];

    // No category restriction defined → applies to all tools
    if (!categories || categories.length === 0) return true;

    // Apply if tool's category matches
    return categories.includes(category);
  }

  private performBuiltInValidations(request: ToolCallRequest): SafetyValidation {
    const violations: string[] = [];
    let riskLevel: RiskLevel = 'LOW';

    // Extract only string leaf values from arguments (avoid false positives from JSON structure)
    const stringValues = this.extractStringValues(request.arguments);
    const combinedValues = stringValues.join('\n');

    // Command injection: check string values only (not JSON keys/braces)
    const commandInjectionPattern = /[;&|`$]|\$\(|`[^`]*`/;
    if (commandInjectionPattern.test(combinedValues)) {
      violations.push('Potential command injection detected in arguments');
      riskLevel = 'HIGH';
    }

    // Path traversal: check string values
    if (stringValues.some(v => v.includes('../') || v.includes('..\\') || /^~\//.test(v))) {
      violations.push('Potential path traversal detected');
      if (this.compareRiskLevels('MEDIUM', riskLevel) > 0) riskLevel = 'MEDIUM';
    }

    // Sensitive file access: check string values
    const sensitiveFiles = ['/etc/passwd', '/etc/shadow', '.ssh/', '.aws/', '.env'];
    for (const file of sensitiveFiles) {
      if (stringValues.some(v => v.includes(file))) {
        violations.push(`Access to sensitive file detected: ${file}`);
        riskLevel = 'CRITICAL';
      }
    }

    // Destructive tool names
    const destructiveTools = ['delete', 'drop', 'truncate', 'remove', 'destroy'];
    for (const op of destructiveTools) {
      if (request.tool.toLowerCase().includes(op)) {
        violations.push(`Destructive operation in tool name: ${op}`);
        if (this.compareRiskLevels('HIGH', riskLevel) > 0) riskLevel = 'HIGH';
      }
    }

    return {
      policy_name: 'built-in-security',
      passed: violations.length === 0,
      violations: violations.length > 0 ? violations : undefined,
      risk_level: riskLevel,
    };
  }

  private extractStringValues(obj: unknown, depth = 0): string[] {
    if (depth > 10) return [];
    if (typeof obj === 'string') return [obj];
    if (Array.isArray(obj)) return obj.flatMap(v => this.extractStringValues(v, depth + 1));
    if (obj && typeof obj === 'object') {
      return Object.values(obj).flatMap(v => this.extractStringValues(v, depth + 1));
    }
    return [];
  }

  private compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
    const levels: Record<RiskLevel, number> = {
      LOW: 1,
      MEDIUM: 2,
      HIGH: 3,
      CRITICAL: 4,
    };
    return levels[a] - levels[b];
  }

  async addPolicy(policy: Omit<Policy, 'enabled'>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO policies (id, name, description, policy_schema, risk_level, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `);

    stmt.run(
      policy.id,
      policy.name,
      policy.description,
      JSON.stringify(policy.policy_schema),
      policy.risk_level
    );

    // Reload policies
    this.loadPolicies();
  }

  async disablePolicy(policyId: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE policies SET enabled = 0 WHERE id = ?');
    stmt.run(policyId);
    this.policies.delete(policyId);
  }

  async enablePolicy(policyId: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE policies SET enabled = 1 WHERE id = ?');
    stmt.run(policyId);
    this.loadPolicies();
  }

  getPolicies(): Policy[] {
    return Array.from(this.policies.values());
  }

  getAllPolicies(): Policy[] {
    const rows = this.db.prepare('SELECT * FROM policies ORDER BY created_at ASC').all() as any[];
    return rows.map(r => ({ ...r, policy_schema: JSON.parse(r.policy_schema), enabled: r.enabled === 1 }));
  }

  async deletePolicy(policyId: string): Promise<void> {
    this.db.prepare('DELETE FROM policies WHERE id = ?').run(policyId);
    this.policies.delete(policyId);
    // Also try deleting by name (since map is keyed by name)
    for (const [name, policy] of this.policies) {
      if (policy.id === policyId) {
        this.policies.delete(name);
        break;
      }
    }
  }
}