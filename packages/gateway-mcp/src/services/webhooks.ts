/**
 * Webhook service — fires HTTP POST on check events with retry + backoff.
 *
 * Config stored in DB table `webhooks`. Register via:
 *   POST /api/v1/webhooks  { url, events: ["block","pending"], secret? }
 *
 * Production features:
 *   - Exponential backoff with jitter (configurable max retries)
 *   - Request timeout (configurable)
 *   - Delivery status tracking in webhook_deliveries table
 *   - HMAC-SHA256 signature for payload verification
 *   - Slack / PagerDuty native formatting
 */

import Database from 'better-sqlite3'
import { Logger } from 'pino'
import * as crypto from 'crypto'
import { config } from '../config'

export type WebhookEvent = 'block' | 'pending' | 'approved' | 'rejected' | 'anomaly.escalate' | 'anomaly.block'

export interface WebhookPayload {
  event:          WebhookEvent
  check_id:       string
  agent_id:       string
  tool_name:      string
  category:       string
  risk_level:     string
  reason?:        string
  timestamp:      string
  anomaly_score?: number
  top_signal?:    string
  [key: string]:  unknown
}

interface WebhookRow {
  id:         string
  url:        string
  events:     string  // JSON array
  secret:     string | null
  enabled:    number
}

export class WebhookService {
  private maxRetries: number;
  private retryBaseMs: number;
  private timeoutMs: number;

  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
    this.maxRetries = config.webhook.maxRetries;
    this.retryBaseMs = config.webhook.retryBaseMs;
    this.timeoutMs = config.webhook.timeoutMs;
    this.initTable()
  }

  private initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id       TEXT PRIMARY KEY,
        url      TEXT NOT NULL,
        events   TEXT NOT NULL DEFAULT '["block","pending"]',
        secret   TEXT,
        enabled  INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Delivery tracking table (for retry audit + debugging)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id  TEXT NOT NULL,
        event       TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'pending',
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      )
    `)

    // Index for querying failed deliveries
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_delivery_status ON webhook_deliveries(status)`)
    } catch { /* exists */ }
  }

  // ── Registration ───────────────────────────────────────────────────────

  add(url: string, events: WebhookEvent[] = ['block', 'pending'], secret?: string): string {
    const id = crypto.randomUUID()
    this.db.prepare(`
      INSERT INTO webhooks (id, url, events, secret, enabled)
      VALUES (?, ?, ?, ?, 1)
    `).run(id, url, JSON.stringify(events), secret ?? null)
    this.logger.info({ id, url, events }, 'Webhook registered')
    return id
  }

  list(): WebhookRow[] {
    return this.db.prepare('SELECT * FROM webhooks WHERE enabled = 1').all() as WebhookRow[]
  }

  remove(id: string): boolean {
    const r = this.db.prepare('UPDATE webhooks SET enabled = 0 WHERE id = ?').run(id)
    return r.changes > 0
  }

  /** Get recent delivery attempts for debugging */
  getDeliveries(webhookId?: string, limit = 50): any[] {
    if (webhookId) {
      return this.db.prepare(
        'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ?'
      ).all(webhookId, limit);
    }
    return this.db.prepare(
      'SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }

  // ── Fire ────────────────────────────────────────────────────────────────

  fire(payload: WebhookPayload): void {
    const webhooks = this.list()
    for (const wh of webhooks) {
      const events = JSON.parse(wh.events) as string[]
      if (!events.includes(payload.event)) continue

      // Record delivery attempt
      const deliveryId = this.db.prepare(`
        INSERT INTO webhook_deliveries (webhook_id, event, payload) VALUES (?, ?, ?)
      `).run(wh.id, payload.event, JSON.stringify(payload)).lastInsertRowid;

      // Fire async with retry
      this._sendWithRetry(wh.url, wh.id, payload, wh.secret ?? undefined, Number(deliveryId)).catch(err => {
        this.logger.error({ url: wh.url, err, webhook_id: wh.id }, 'Webhook delivery failed after all retries')
      })
    }
  }

  private async _sendWithRetry(
    url: string, webhookId: string, payload: WebhookPayload,
    secret: string | undefined, deliveryId: number,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this._send(url, payload, secret);

        // Mark delivery as successful
        this.db.prepare(`
          UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, completed_at = datetime('now')
          WHERE id = ?
        `).run(attempt + 1, deliveryId);

        return;
      } catch (err: any) {
        lastError = err;
        this.logger.warn({
          url, webhook_id: webhookId, attempt: attempt + 1,
          max_retries: this.maxRetries, error: err.message,
        }, 'Webhook delivery attempt failed');

        // Update attempt count
        this.db.prepare(`
          UPDATE webhook_deliveries SET attempts = ?, last_error = ? WHERE id = ?
        `).run(attempt + 1, err.message, deliveryId);

        if (attempt < this.maxRetries) {
          // Exponential backoff with jitter: base * 2^attempt + random jitter
          const backoff = this.retryBaseMs * Math.pow(2, attempt);
          const jitter = Math.random() * this.retryBaseMs;
          await new Promise(r => setTimeout(r, backoff + jitter));
        }
      }
    }

    // All retries exhausted
    this.db.prepare(`
      UPDATE webhook_deliveries SET status = 'failed', completed_at = datetime('now') WHERE id = ?
    `).run(deliveryId);

    throw lastError;
  }

  private async _send(url: string, payload: WebhookPayload, secret?: string): Promise<void> {
    const isSlack = url.includes('hooks.slack.com') || url.includes('slack.com/services')
    const isPagerDuty = url.includes('events.pagerduty.com')

    let body: string;
    if (isSlack) {
      body = JSON.stringify({ text: this._slackText(payload) });
    } else if (isPagerDuty) {
      body = JSON.stringify(this._pagerDutyPayload(payload));
    } else {
      body = JSON.stringify(payload);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent':   'AEGIS-Webhook/2.0',
    }

    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
      headers['X-AEGIS-Signature'] = `sha256=${sig}`
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      this.logger.info({ url, event: payload.event, status: res.status }, 'Webhook delivered')
    } finally {
      clearTimeout(timeout);
    }
  }

  private _slackText(p: WebhookPayload): string {
    const emoji = p.event === 'block' ? ':no_entry:' : p.event === 'pending' ? ':hourglass:' : p.event === 'approved' ? ':white_check_mark:' : ':x:'
    return (
      `${emoji} *AEGIS ${p.event.toUpperCase()}*\n` +
      `Tool: \`${p.tool_name}\` | Risk: ${p.risk_level} | Category: ${p.category}\n` +
      `Agent: ${p.agent_id.substring(0, 12)}...\n` +
      (p.reason ? `Reason: ${p.reason}\n` : '') +
      `Check ID: \`${p.check_id}\``
    )
  }

  private _pagerDutyPayload(p: WebhookPayload): object {
    return {
      routing_key: '', // set via webhook secret field
      event_action: p.event === 'block' ? 'trigger' : 'acknowledge',
      payload: {
        summary: `AEGIS ${p.event.toUpperCase()}: ${p.tool_name} (${p.risk_level})`,
        source: `aegis-agent-${p.agent_id.substring(0, 12)}`,
        severity: p.risk_level === 'CRITICAL' ? 'critical' : p.risk_level === 'HIGH' ? 'error' : 'warning',
        custom_details: {
          agent_id: p.agent_id,
          tool_name: p.tool_name,
          category: p.category,
          check_id: p.check_id,
          reason: p.reason,
        },
      },
    };
  }
}
