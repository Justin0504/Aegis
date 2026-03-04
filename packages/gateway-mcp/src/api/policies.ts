import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { z } from 'zod';
import { PolicyEngine } from '../policies/policy-engine';

const CreatePolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  policy_schema: z.any(),
  risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
});

export class PolicyAPI {
  public readonly router: Router;

  constructor(
    private db: Database.Database,
    private policyEngine: PolicyEngine,
    private logger: Logger
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes() {
    // List all policies
    this.router.get('/', (req: Request, res: Response) => {
      try {
        const policies = this.policyEngine.getPolicies();
        res.json(policies);
      } catch (error) {
        this.logger.error({ error }, 'Failed to list policies');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Create new policy
    this.router.post('/', async (req: Request, res: Response) => {
      try {
        const policy = CreatePolicySchema.parse(req.body);
        await this.policyEngine.addPolicy(policy as any);
        res.status(201).json({ id: policy.id });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ error: 'Invalid policy format', details: error.errors });
        }
        this.logger.error({ error }, 'Failed to create policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Enable policy
    this.router.put('/:policyId/enable', async (req: Request, res: Response) => {
      try {
        await this.policyEngine.enablePolicy(req.params.policyId);
        res.json({ status: 'enabled' });
      } catch (error) {
        this.logger.error({ error }, 'Failed to enable policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Disable policy
    this.router.put('/:policyId/disable', async (req: Request, res: Response) => {
      try {
        await this.policyEngine.disablePolicy(req.params.policyId);
        res.json({ status: 'disabled' });
      } catch (error) {
        this.logger.error({ error }, 'Failed to disable policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // Test policy against tool call
    this.router.post('/test', async (req: Request, res: Response) => {
      try {
        const { tool, arguments: args } = req.body;
        const validation = await this.policyEngine.validateToolCall({
          tool,
          arguments: args,
        });
        res.json(validation);
      } catch (error) {
        this.logger.error({ error }, 'Failed to test policy');
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }
}