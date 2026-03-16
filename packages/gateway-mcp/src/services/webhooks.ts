/**
 * Webhook service — fires HTTP POST when a check is BLOCK or PENDING.
 *
 * Config stored in DB table `webhooks`. Register via:
 *   POST /api/v1/webhooks  { url, events: ["block","pending"], secret? }
 *
 * Payload sent to webhook URL:
 *   {
 *     event:      "block" | "pending" | "approved" | "rejected",
 *     check_id:   string,
 *     agent_id:   string,
 *     tool_name:  string,
 *     category:   string,
 *     risk_level: string,
 *     reason?:    string,
 *     timestamp:  ISO string,
 *   }
 *
 * Slack-compatible: if the URL contains "hooks.slack.com", the payload is
 * wrapped in { text: "..." } for Slack incoming webhooks.
 */

import Database from 'better-sqlite3'
import { Logger } from 'pino'
import * as crypto from 'crypto'

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
  constructor(
    private db: Database.Database,
    private logger: Logger,
  ) {
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

  // ── Fire ────────────────────────────────────────────────────────────────

  fire(payload: WebhookPayload): void {
    const webhooks = this.list()
    for (const wh of webhooks) {
      const events = JSON.parse(wh.events) as string[]
      if (!events.includes(payload.event)) continue

      // Fire async, don't block the request path
      this._send(wh.url, payload, wh.secret ?? undefined).catch(err => {
        this.logger.warn({ url: wh.url, err }, 'Webhook delivery failed')
      })
    }
  }

  private async _send(url: string, payload: WebhookPayload, secret?: string): Promise<void> {
    const isSlack = url.includes('hooks.slack.com') || url.includes('slack.com/services')

    const body = isSlack
      ? JSON.stringify({ text: this._slackText(payload) })
      : JSON.stringify(payload)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent':   'AEGIS-Webhook/1.0',
    }

    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
      headers['X-AEGIS-Signature'] = `sha256=${sig}`
    }

    // Use built-in fetch (Node 18+) or fall back to http.request
    if (typeof fetch !== 'undefined') {
      const res = await fetch(url, { method: 'POST', headers, body })
      this.logger.info({ url, event: payload.event, status: res.status }, 'Webhook delivered')
      return
    }

    // Fallback: Node http/https
    await new Promise<void>((resolve, reject) => {
      const { request } = url.startsWith('https') ? require('https') : require('http')
      const parsed = new URL(url)
      const req = request({
        hostname: parsed.hostname,
        port:     parsed.port,
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  { ...headers, 'Content-Length': Buffer.byteLength(body) },
      }, (res: any) => {
        this.logger.info({ url, event: payload.event, status: res.statusCode }, 'Webhook delivered')
        res.resume()
        resolve()
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }

  private _slackText(p: WebhookPayload): string {
    const emoji = p.event === 'block' ? '🚫' : p.event === 'pending' ? '⏳' : p.event === 'approved' ? '✅' : '❌'
    return (
      `${emoji} *AEGIS ${p.event.toUpperCase()}*\n` +
      `Tool: \`${p.tool_name}\` | Risk: ${p.risk_level} | Category: ${p.category}\n` +
      `Agent: ${p.agent_id.substring(0, 12)}…\n` +
      (p.reason ? `Reason: ${p.reason}\n` : '') +
      `Check ID: \`${p.check_id}\``
    )
  }
}
