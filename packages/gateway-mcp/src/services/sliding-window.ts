/**
 * Sliding Window Statistics — in-memory ring buffer per agent
 *
 * Provides real-time aggregate stats over configurable time windows
 * for the anomaly detection engine. Uses LRU eviction to cap memory.
 */

export interface WindowEntry {
  timestamp: number;
  tool_name: string;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  cost_usd: number;
  arg_length: number;
}

interface AgentWindow {
  buffer: WindowEntry[];
  head: number;       // next write position (ring buffer)
  size: number;       // current filled count
  lastAccess: number; // for LRU eviction
  lastTool: string | null;
}

export class SlidingWindowStats {
  private windows: Map<string, AgentWindow> = new Map();

  constructor(
    private maxAgents: number = 10_000,
    private bufferSize: number = 300,
  ) {}

  /** Record a new entry for an agent */
  record(agentId: string, entry: WindowEntry): void {
    let win = this.windows.get(agentId);
    if (!win) {
      this.evictIfNeeded();
      win = {
        buffer: new Array(this.bufferSize),
        head: 0,
        size: 0,
        lastAccess: Date.now(),
        lastTool: null,
      };
      this.windows.set(agentId, win);
    }

    win.buffer[win.head] = entry;
    win.head = (win.head + 1) % this.bufferSize;
    if (win.size < this.bufferSize) win.size++;
    win.lastAccess = Date.now();
    win.lastTool = entry.tool_name;
  }

  /** Get call frequency for a specific tool within windowSec */
  getToolFrequency(agentId: string, tool: string, windowSec: number): number {
    const entries = this.getEntries(agentId, windowSec);
    if (entries.length === 0) return 0;
    const toolCount = entries.filter(e => e.tool_name === tool).length;
    const windowMin = windowSec / 60;
    return toolCount / windowMin; // calls per minute
  }

  /** Get total call count within windowSec */
  getCallCount(agentId: string, windowSec: number): number {
    return this.getEntries(agentId, windowSec).length;
  }

  /** Get fraction of HIGH/CRITICAL risk calls within windowSec */
  getHighRiskRate(agentId: string, windowSec: number): number {
    const entries = this.getEntries(agentId, windowSec);
    if (entries.length === 0) return 0;
    const high = entries.filter(e => e.risk_level === 'HIGH' || e.risk_level === 'CRITICAL').length;
    return high / entries.length;
  }

  /** Get last tool called by this agent */
  getLastTool(agentId: string): string | null {
    return this.windows.get(agentId)?.lastTool ?? null;
  }

  /** Get mean cost within windowSec */
  getMeanCost(agentId: string, windowSec: number): number {
    const entries = this.getEntries(agentId, windowSec);
    if (entries.length === 0) return 0;
    return entries.reduce((s, e) => s + e.cost_usd, 0) / entries.length;
  }

  /** Number of tracked agents */
  get agentCount(): number {
    return this.windows.size;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private getEntries(agentId: string, windowSec: number): WindowEntry[] {
    const win = this.windows.get(agentId);
    if (!win || win.size === 0) return [];

    win.lastAccess = Date.now();
    const cutoff = Date.now() - windowSec * 1000;
    const result: WindowEntry[] = [];

    // Walk backwards from most recent
    for (let i = 0; i < win.size; i++) {
      const idx = (win.head - 1 - i + this.bufferSize) % this.bufferSize;
      const entry = win.buffer[idx];
      if (!entry || entry.timestamp < cutoff) break;
      result.push(entry);
    }
    return result;
  }

  private evictIfNeeded(): void {
    if (this.windows.size < this.maxAgents) return;

    // Find LRU agent
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, win] of this.windows) {
      if (win.lastAccess < oldestTime) {
        oldestTime = win.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) this.windows.delete(oldestKey);
  }
}
