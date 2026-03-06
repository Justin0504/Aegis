/**
 * In-memory event bus for real-time block/pending alerts.
 * Ring buffer of last 200 events — clients poll via /api/v1/events?since=<iso>
 */

export interface BlockEvent {
  id:         string
  event:      'block' | 'pending'
  agent_id:   string
  tool_name:  string
  category:   string
  risk_level: string
  reason?:    string
  timestamp:  string  // ISO
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

  /** Return events newer than `since` ISO string (or all if omitted). */
  since(since?: string): BlockEvent[] {
    if (!since) return [...this.events]
    return this.events.filter(e => e.timestamp > since)
  }
}
