/**
 * Compensator: slack.postMessage / slack.chat_postMessage
 *
 * Retracts a Slack message. If the message is still within Slack's
 * edit window (default 6h; depends on workspace settings), it is
 * deleted outright. Otherwise, we replace its body with a strikethrough
 * + audit note referencing the original message, since Slack's API
 * doesn't support delete after that window.
 *
 * Cost-estimate hint:
 *   magnitude: medium     — visible to recipients; can't be fully
 *                           silent even inside the edit window.
 */

import type { IncomingMessage, ServerResponse } from 'http';

interface RollbackWebhookBody {
  trace_id: string;
  agent_id: string;
  tool_name: string;
  arguments: { channel?: string; text?: string; ts?: string };
  observation?: { raw_output?: { channel?: string; ts?: string } };
  timestamp: string;
}

const SLACK_DELETE = 'https://slack.com/api/chat.delete';
const SLACK_UPDATE = 'https://slack.com/api/chat.update';

export async function handleSlackRetract(
  body: RollbackWebhookBody,
  idempotencyKey: string,
  slackBotToken: string,
  auditReason: string = 'Retracted by AEGIS rollback',
): Promise<{ status: 'ok' | 'no_op'; action: 'deleted' | 'edited' | 'unavailable' }> {
  const channel = body.observation?.raw_output?.channel ?? body.arguments.channel;
  const ts      = body.observation?.raw_output?.ts      ?? body.arguments.ts;
  if (!channel || !ts) {
    return { status: 'no_op', action: 'unavailable' };
  }

  // First attempt — hard delete. Slack returns { ok: false, error: 'message_too_old' }
  // once the message is past the workspace's edit window.
  const del = await fetch(SLACK_DELETE, {
    method: 'POST',
    headers: authHeaders(slackBotToken, idempotencyKey),
    body: JSON.stringify({ channel, ts }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>);

  if (del.ok) return { status: 'ok', action: 'deleted' };
  if (del.error !== 'message_too_old' && del.error !== 'cant_delete_message') {
    // Real failure (bad token, missing scope, channel not found). Bubble up.
    throw new Error(`slack.chat.delete failed: ${del.error}`);
  }

  // Fallback — replace the body with an audit note. Won't remove the
  // notification recipients already got, but future readers see the
  // retraction with the audit reason inline.
  const upd = await fetch(SLACK_UPDATE, {
    method: 'POST',
    headers: authHeaders(slackBotToken, idempotencyKey),
    body: JSON.stringify({
      channel, ts,
      text: `~[message retracted by AEGIS]~\n_${auditReason}_ · trace_id \`${body.trace_id}\``,
    }),
  }).then(r => r.json() as Promise<{ ok: boolean; error?: string }>);
  if (!upd.ok) {
    throw new Error(`slack.chat.update failed: ${upd.error}`);
  }
  return { status: 'ok', action: 'edited' };
}

function authHeaders(token: string, idempotencyKey: string): Record<string, string> {
  return {
    'Authorization':   `Bearer ${token}`,
    'Content-Type':    'application/json',
    // Slack doesn't natively honour Idempotency-Key, but many
    // proxies-in-between (Cloudflare, corp SIEM) do. Include it for
    // forensic replay.
    'X-Idempotency-Key': idempotencyKey,
  };
}

// ── Example Express handler ──────────────────────────────────────────

export function createExpressHandler(slackBotToken: string) {
  return async (req: IncomingMessage & { body: RollbackWebhookBody }, res: ServerResponse) => {
    try {
      const idempotencyKey = req.headers['idempotency-key'] as string
                          ?? (req.body?.trace_id ?? 'no-key');
      const result = await handleSlackRetract(req.body, idempotencyKey, slackBotToken);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (err: any) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err?.message ?? 'slack retract failed' }));
    }
  };
}
