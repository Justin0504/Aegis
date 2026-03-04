import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import { Logger } from 'pino';
import {
  AgentActionTraceSchema,
  CreateTraceRequestSchema,
  SafetyValidation,
  ApprovalStatus,
} from '@agentguard/core-schema';
import { PolicyEngine } from '../policies/policy-engine';
import { KillSwitchService } from '../services/kill-switch';

interface MCPMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

interface ToolCallRequest {
  tool: string;
  arguments: any;
}

export class MCPProxyService {
  private activeConnections = new Map<string, WebSocket>();
  private pendingApprovals = new Map<string, ToolCallRequest>();

  constructor(
    private db: Database.Database,
    private policyEngine: PolicyEngine,
    private killSwitch: KillSwitchService,
    private logger: Logger
  ) {}

  async handleConnection(ws: WebSocket) {
    const connectionId = uuidv4();
    this.activeConnections.set(connectionId, ws);

    ws.on('message', async (data) => {
      try {
        const message: MCPMessage = JSON.parse(data.toString());
        await this.handleMessage(connectionId, message, ws);
      } catch (error) {
        this.logger.error({ error, connectionId }, 'Failed to handle MCP message');
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32700,
              message: 'Parse error',
            },
          })
        );
      }
    });

    ws.on('close', () => {
      this.activeConnections.delete(connectionId);
      this.logger.info({ connectionId }, 'MCP client disconnected');
    });

    ws.on('error', (error) => {
      this.logger.error({ error, connectionId }, 'WebSocket error');
    });
  }

  private async handleMessage(connectionId: string, message: MCPMessage, ws: WebSocket) {
    // Intercept tool call requests
    if (message.method === 'tools/call') {
      await this.handleToolCall(connectionId, message, ws);
    } else {
      // Forward other messages directly
      // In production, this would forward to the actual tool server
      this.forwardToToolServer(message, ws);
    }
  }

  private async handleToolCall(connectionId: string, message: MCPMessage, ws: WebSocket) {
    const { id, params } = message;
    const toolRequest = params as ToolCallRequest;

    try {
      // Extract agent ID from connection context (in production, from auth)
      const agentId = this.getAgentIdFromConnection(connectionId);

      // Check if agent is blocked by kill switch
      if (await this.killSwitch.isAgentBlocked(agentId)) {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32001,
              message: 'Agent blocked due to policy violations',
            },
          })
        );
        return;
      }

      // Create trace for this tool call
      const traceId = uuidv4();
      const trace = {
        trace_id: traceId,
        agent_id: agentId,
        timestamp: new Date().toISOString(),
        sequence_number: 0, // Would be tracked per agent
        input_context: {
          prompt: JSON.stringify(toolRequest),
        },
        thought_chain: {
          raw_tokens: '',
        },
        tool_call: {
          tool_name: toolRequest.tool,
          function: toolRequest.tool,
          arguments: toolRequest.arguments,
          timestamp: new Date().toISOString(),
        },
        observation: {
          raw_output: null,
          duration_ms: 0,
        },
        environment: 'PRODUCTION',
        version: '1.0.0',
      };

      // Validate against policies
      const validation = await this.policyEngine.validateToolCall(toolRequest);

      // Store validation result
      trace['safety_validation'] = validation;

      // Handle based on validation result
      if (!validation.passed) {
        // Record violation
        await this.killSwitch.recordViolation(agentId, validation);

        // Store trace with rejection
        trace['approval_status'] = 'REJECTED';
        await this.storeTrace(trace);

        // Send error response
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32002,
              message: 'Tool call violates safety policy',
              data: {
                policy: validation.policy_name,
                violations: validation.violations,
                trace_id: traceId,
              },
            },
          })
        );
        return;
      }

      // Check if approval is needed
      if (validation.risk_level === 'HIGH' || validation.risk_level === 'CRITICAL') {
        // Store pending approval
        const approvalId = uuidv4();
        this.pendingApprovals.set(approvalId, toolRequest);

        // Store trace with pending status
        trace['approval_status'] = 'PENDING_APPROVAL';
        await this.storeTrace(trace);

        // Create approval request
        await this.createApprovalRequest(approvalId, traceId, agentId, toolRequest, validation);

        // Send pending response
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            result: {
              status: 'pending_approval',
              approval_id: approvalId,
              trace_id: traceId,
              message: 'High-risk operation requires approval',
            },
          })
        );
        return;
      }

      // Auto-approve low/medium risk operations
      trace['approval_status'] = 'AUTO_APPROVED';

      // Forward to actual tool server
      const startTime = Date.now();
      const toolResult = await this.executeToolCall(toolRequest);
      const duration = Date.now() - startTime;

      // Update trace with result
      trace.observation.raw_output = toolResult;
      trace.observation.duration_ms = duration;

      // Store completed trace
      await this.storeTrace(trace);

      // Send result
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: toolResult,
        })
      );

    } catch (error) {
      this.logger.error({ error, tool: toolRequest.tool }, 'Tool call failed');
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'Internal error',
          },
        })
      );
    }
  }

  private async storeTrace(trace: any) {
    const stmt = this.db.prepare(`
      INSERT INTO traces (
        trace_id, parent_trace_id, agent_id, timestamp, sequence_number,
        input_context, thought_chain, tool_call, observation,
        integrity_hash, previous_hash, signature,
        safety_validation, approval_status, approved_by,
        environment, version, tags
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?
      )
    `);

    // Calculate integrity hash
    const { calculate_trace_hash } = require('@agentguard/core-schema');
    const integrityHash = calculate_trace_hash(trace);

    stmt.run(
      trace.trace_id,
      trace.parent_trace_id || null,
      trace.agent_id,
      trace.timestamp,
      trace.sequence_number,
      JSON.stringify(trace.input_context),
      JSON.stringify(trace.thought_chain),
      JSON.stringify(trace.tool_call),
      JSON.stringify(trace.observation),
      integrityHash,
      trace.previous_hash || null,
      trace.signature || null,
      JSON.stringify(trace.safety_validation || null),
      trace.approval_status || null,
      trace.approved_by || null,
      trace.environment,
      trace.version,
      JSON.stringify(trace.tags || null)
    );
  }

  private async createApprovalRequest(
    approvalId: string,
    traceId: string,
    agentId: string,
    toolRequest: ToolCallRequest,
    validation: SafetyValidation
  ) {
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    const stmt = this.db.prepare(`
      INSERT INTO approvals (
        id, trace_id, agent_id, tool_name, risk_level,
        status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      approvalId,
      traceId,
      agentId,
      toolRequest.tool,
      validation.risk_level,
      'PENDING',
      expiresAt
    );
  }

  private getAgentIdFromConnection(connectionId: string): string {
    // In production, this would extract from auth token/headers
    return 'test-agent-001';
  }

  private async executeToolCall(toolRequest: ToolCallRequest): Promise<any> {
    // In production, this would forward to the actual tool server
    // For now, return a mock response
    return {
      success: true,
      output: `Executed ${toolRequest.tool} with args: ${JSON.stringify(toolRequest.arguments)}`,
    };
  }

  private forwardToToolServer(message: MCPMessage, ws: WebSocket) {
    // In production, this would forward to the actual tool server
    // For now, echo back
    ws.send(JSON.stringify(message));
  }
}