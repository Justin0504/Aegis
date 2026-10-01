/**
 * POST /api/v1/context — the SDK reports what entered the agent's context.
 *
 * This is the one piece of telemetry instruction provenance needs that the
 * gateway cannot derive on its own. The gateway already sees every tool
 * call; it does not see the user's turns, and it does not see tool
 * *returns* unless told. Without those it can score a call's content and
 * cannot tell whether anything the principal said accounts for it.
 *
 * WHAT TO REPORT, AND WHAT NOT TO
 *
 *   channel: "user"       the principal's own turns
 *   channel: "untrusted"  anything that crossed the trust boundary —
 *                         tool returns, retrieved documents, web pages,
 *                         email bodies, file contents
 *   channel: "model"      the assistant's own output
 *
 * The distinction that matters is `user` versus everything else. A tool
 * return is untrusted even when the tool is one you wrote and the server
 * is one you run, because the *content* it returns may not be yours — an
 * email body, a row someone else wrote, a page you fetched. Classifying a
 * tool return as `user` because the tool is trusted is the mistake this
 * whole layer exists to prevent.
 *
 * PRIVACY
 *
 * Context text is held in memory only, bounded per session, dropped on an
 * idle TTL, and never written to the audit chain — only the derived facts
 * (a few numbers and a verdict) reach a trace. Operators who cannot send
 * context text to the gateway at all should leave this unreported; every
 * provenance rule is inert without it, and nothing else changes.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import type { Logger } from 'pino';
import { ContextChannelSchema } from '@agentguard/core-schema';
import { ContextLedgerStore } from '../services/context-ledger-store';

const EventSchema = z.object({
  channel: ContextChannelSchema,
  /** Capped per event; the ledger caps the session total separately. A
   *  tool that returns a 2 MB document contributes its first 32 KB, which
   *  is far more than a bag-of-tokens comparison needs. */
  text: z.string().max(32_000),
  source: z.string().max(200).optional(),
});

const ReportSchema = z.object({
  session_id: z.string().min(1).max(200),
  agent_id: z.string().max(128).optional(),
  events: z.array(EventSchema).min(1).max(64),
});

const ForgetSchema = z.object({
  session_id: z.string().min(1).max(200),
});

export class ContextAPI {
  public router: Router;

  constructor(
    private logger: Logger,
    private store: ContextLedgerStore,
  ) {
    this.router = Router();

    this.router.post('/', (req: Request, res: Response) => {
      const parsed = ReportSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid context report',
          details: parsed.error.issues,
        });
      }
      // Session ids are caller-supplied, so the store namespaces them by
      // org. Without that, one tenant could poison another's ledger — and
      // poisoning it with a `user` event is exactly how an attacker would
      // launder an injected instruction into an authority.
      const orgId = (req as any).orgId ?? 'default';
      const { session_id, events } = parsed.data;

      // Built field by field rather than spread: the inferred shape of a
      // parsed zod array widens its members to optional across package
      // boundaries, and a silently-optional `channel` would default a
      // tool return to something other than untrusted.
      this.store.record(
        orgId,
        session_id,
        events.map((e, seq) => ({
          seq,
          channel: e.channel,
          text: e.text,
          source: e.source,
        })),
      );

      res.json({ recorded: events.length, session_id });
    });

    /**
     * DELETE /api/v1/context — forget a finished session.
     *
     * Optional: ledgers expire on their own. Worth calling when a session
     * ends so a long-lived gateway is not holding conversation text for an
     * hour after it stopped being useful.
     */
    this.router.delete('/', (req: Request, res: Response) => {
      const parsed = ForgetSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request' });
      }
      const orgId = (req as any).orgId ?? 'default';
      this.store.forget(orgId, parsed.data.session_id);
      res.json({ forgotten: parsed.data.session_id });
    });

    /** GET /api/v1/context/stats — how many sessions are being tracked. */
    this.router.get('/stats', (_req: Request, res: Response) => {
      res.json({ sessions: this.store.size() });
    });
  }
}
