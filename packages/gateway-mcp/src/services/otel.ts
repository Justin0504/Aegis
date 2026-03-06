import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, SpanStatusCode, context } from '@opentelemetry/api';

let sdk: NodeSDK | null = null;
const TRACER_NAME = 'aegis-gateway';

export function initOtel(): void {
  if (process.env['OTEL_ENABLED'] !== 'true') return;

  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] || 'http://localhost:4318';
  const serviceName = process.env['OTEL_SERVICE_NAME'] || 'aegis-gateway';

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: '1.0.0',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  });

  sdk.start();
}

export function shutdownOtel(): Promise<void> {
  return sdk?.shutdown() ?? Promise.resolve();
}

export function emitTraceSpan(params: {
  traceId: string;
  agentId: string;
  toolName: string;
  riskLevel: string;
  blocked: boolean;
  costUsd: number;
  piiDetected: number;
  durationMs: number;
  error?: string | null;
}): void {
  if (process.env['OTEL_ENABLED'] !== 'true') return;

  try {
    const tracer = trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(`tool_call/${params.toolName}`, {}, context.active());

    span.setAttributes({
      'aegis.trace_id':     params.traceId,
      'aegis.agent_id':     params.agentId,
      'aegis.tool_name':    params.toolName,
      'aegis.risk_level':   params.riskLevel,
      'aegis.blocked':      params.blocked,
      'aegis.cost_usd':     params.costUsd,
      'aegis.pii_detected': params.piiDetected,
    });

    if (params.error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: params.error });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    // Simulate duration by ending with offset
    span.end(new Date(Date.now() - params.durationMs));
  } catch {
    // Never let OTEL errors break the trace flow
  }
}
