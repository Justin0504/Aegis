import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import { SafetyValidation, RiskLevel } from '@agentguard/core-schema';
import Ajv from 'ajv';

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

  async validateToolCall(request: ToolCallRequest): Promise<SafetyValidation> {
    const violations: string[] = [];
    let highestRiskLevel: RiskLevel = 'LOW';
    let failedPolicy: string | null = null;

    // Apply all relevant policies
    for (const [name, policy] of this.policies) {
      // Check if policy applies to this tool
      if (this.policyApplies(policy, request)) {
        const validate = this.ajv.compile(policy.policy_schema);
        const valid = validate(request.arguments);

        if (!valid) {
          failedPolicy = name;
          violations.push(...(validate.errors?.map(e => e.message || 'Unknown error') || []));

          // Update highest risk level
          if (this.compareRiskLevels(policy.risk_level, highestRiskLevel) > 0) {
            highestRiskLevel = policy.risk_level;
          }

          this.logger.warn(
            {
              policy: name,
              tool: request.tool,
              errors: validate.errors
            },
            'Policy validation failed'
          );
        }
      }
    }

    // Additional built-in validations
    const builtInValidation = this.performBuiltInValidations(request);
    if (!builtInValidation.passed) {
      violations.push(...(builtInValidation.violations || []));
      if (this.compareRiskLevels(builtInValidation.risk_level, highestRiskLevel) > 0) {
        highestRiskLevel = builtInValidation.risk_level;
      }
    }

    return {
      policy_name: failedPolicy || 'built-in',
      passed: violations.length === 0,
      violations: violations.length > 0 ? violations : undefined,
      risk_level: highestRiskLevel,
    };
  }

  private policyApplies(policy: Policy, request: ToolCallRequest): boolean {
    // Check if policy has tool-specific rules
    const toolPatterns = {
      'sql-injection': ['execute_sql', 'query_database', 'run_query'],
      'file-access': ['read_file', 'write_file', 'delete_file', 'list_directory'],
      'network-access': ['http_request', 'fetch_url', 'send_email'],
    };

    const patterns = toolPatterns[policy.id as keyof typeof toolPatterns];
    if (patterns) {
      return patterns.some(pattern => request.tool.toLowerCase().includes(pattern));
    }

    // Default: apply to all tools
    return true;
  }

  private performBuiltInValidations(request: ToolCallRequest): SafetyValidation {
    const violations: string[] = [];
    let riskLevel: RiskLevel = 'LOW';

    // Check for command injection patterns
    const commandInjectionPattern = /[;&|`$(){}[\]<>]/;
    const argString = JSON.stringify(request.arguments);

    if (commandInjectionPattern.test(argString)) {
      violations.push('Potential command injection detected');
      riskLevel = 'HIGH';
    }

    // Check for path traversal
    if (argString.includes('..') || argString.includes('~')) {
      violations.push('Potential path traversal detected');
      riskLevel = 'MEDIUM';
    }

    // Check for sensitive file access
    const sensitiveFiles = ['/etc/passwd', '/etc/shadow', '.ssh/', '.aws/', '.env'];
    for (const file of sensitiveFiles) {
      if (argString.includes(file)) {
        violations.push(`Access to sensitive file detected: ${file}`);
        riskLevel = 'CRITICAL';
      }
    }

    // Check for destructive operations
    const destructiveTools = ['delete', 'drop', 'truncate', 'remove', 'destroy'];
    for (const op of destructiveTools) {
      if (request.tool.toLowerCase().includes(op)) {
        violations.push(`Destructive operation: ${op}`);
        riskLevel = this.compareRiskLevels('HIGH', riskLevel) > 0 ? 'HIGH' : riskLevel;
      }
    }

    return {
      policy_name: 'built-in-security',
      passed: violations.length === 0,
      violations: violations.length > 0 ? violations : undefined,
      risk_level: riskLevel,
    };
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
}