/**
 * Webhook management API
 *
 * POST   /api/v1/webhooks            — register a webhook
 * GET    /api/v1/webhooks            — list webhooks
 * DELETE /api/v1/webhooks/:id        — remove a webhook
 * POST   /api/v1/webhooks/test/:id   — send a test event
 */

import { Router, Request, Response } from 'express'
import { z } from 'zod'
import { WebhookService, WebhookEvent } from '../services/webhooks'

const RegisterSchema = z.object({
  url:    z.string().url(),
  events: z.array(z.enum(['block', 'pending', 'approved', 'rejected']))
             .default(['block', 'pending']),
  secret: z.string().optional(),
})

export class WebhookAPI {
  public readonly router: Router

  constructor(private svc: WebhookService) {
    this.router = Router()
    this.setupRoutes()
  }

  private setupRoutes() {
    // Register
    this.router.post('/', (req: Request, res: Response) => {
      try {
        const body = RegisterSchema.parse(req.body)
        const id   = this.svc.add(body.url, body.events as WebhookEvent[], body.secret)
        res.status(201).json({ id, url: body.url, events: body.events })
      } catch (e: any) {
        res.status(400).json({ error: e.message })
      }
    })

    // List
    this.router.get('/', (_req: Request, res: Response) => {
      const rows = this.svc.list().map(r => ({
        ...r,
        events: JSON.parse(r.events),
        secret: r.secret ? '***' : null,
      }))
      res.json({ webhooks: rows, total: rows.length })
    })

    // Remove
    this.router.delete('/:id', (req: Request, res: Response) => {
      const ok = this.svc.remove(req.params.id)
      if (!ok) return res.status(404).json({ error: 'Not found' })
      res.json({ deleted: req.params.id })
    })

    // Test
    this.router.post('/test/:id', (req: Request, res: Response) => {
      const rows = this.svc.list()
      const wh   = rows.find(r => r.id === req.params.id)
      if (!wh) return res.status(404).json({ error: 'Webhook not found' })

      this.svc.fire({
        event:      'block',
        check_id:   'test-' + Date.now(),
        agent_id:   'test-agent',
        tool_name:  'execute_sql',
        category:   'database',
        risk_level: 'HIGH',
        reason:     'Test webhook delivery from AEGIS',
        timestamp:  new Date().toISOString(),
      })

      res.json({ sent: true, url: wh.url })
    })
  }
}
