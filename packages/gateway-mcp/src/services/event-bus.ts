/**
 * In-memory event bus for real-time block/pending alerts.
 * Ring buffer of last 200 events — clients poll via /api/v1/events?since=<iso>
 */

export interface BlockEvent {
  id:              string
  event:           'block' | 'pending' | 'anomaly.escalate' | 'anomaly.block'
  agent_id:        string
  tool_name:       string
  category:        string
  risk_level:      string
  reason?:         string
  anomaly_score?:  number
  timestamp:       string  // ISO
  [key: string]:   unknown
}

const MAX_EVENTS = 200

export class EventBus {
  private events: BlockEvent[] = []

  push(event: BlockEvent) {
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) {
      this.events.shift()
    }
  }

  /** Return events newer than `since` ISO string.
   *  Without `since`, returns only the last 60 seconds (no history flood on page open). */
  since(since?: string): BlockEvent[] {
    const floor = since ?? new Date(Date.now() - 60_000).toISOString()
    return this.events.filter(e => e.timestamp > floor)
  }
}
