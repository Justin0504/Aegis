/**
 * Profile Manager — in-memory cache + periodic rebuild of agent behavior profiles
 *
 * Wraps BehaviorProfileService with:
 *   - In-memory LRU cache for O(1) profile lookups on hot path
 *   - Periodic background rebuild (EWMA-weighted)
 *   - Incremental counter updates on each new trace
 *   - Cold-start awareness (minTraces threshold)
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { BehaviorProfileService, AgentProfile } from './behavior-profile';

export interface ProfileManagerConfig {
  /** Minimum traces before anomaly detection activates */
  minTraces: number;
  /** Minimum traces before anomaly can block (not just flag) */
  graduationTraces: number;
  /** Rebuild interval in ms */
  rebuildIntervalMs: number;
  /** Profile window in days */
  windowDays: number;
}

const DEFAULT_CONFIG: ProfileManagerConfig = {
  minTraces: 50,
  graduationTraces: 200,
  windowDays: 14,
  rebuildIntervalMs: 6 * 3600 * 1000, // 6 hours
};

export type ColdStartPhase = 'learning' | 'graduated' | 'active';

export class ProfileManager {
  private profiles: Map<string, AgentProfile> = new Map();
  private profileService: BehaviorProfileService;
  private rebuildTimer: ReturnType<typeof setInterval> | null = null;
  private config: ProfileManagerConfig;
  /** Throttle DB writes: track per-agent update count + last persist time */
  private persistState: Map<string, { count: number; lastPersistMs: number }> = new Map();

  constructor(
    private db: Database.Database,
    private logger: Logger,
    config?: Partial<ProfileManagerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.profileService = new BehaviorProfileService(db, logger);
  }

  /** Load all existing profiles from DB into memory */
  async initialize(): Promise<void> {
    const rows = this.db.prepare(
      'SELECT agent_id, profile_json FROM agent_profiles'
    ).all() as { agent_id: string; profile_json: string }[];

    for (const row of rows) {
      try {
        const profile = JSON.parse(row.profile_json) as AgentProfile;
        this.profiles.set(row.agent_id, profile);
      } catch {
        this.logger.warn({ agent_id: row.agent_id }, 'Failed to parse cached profile');
      }
    }

    this.logger.info({ profiles_loaded: this.profiles.size }, 'ProfileManager initialized');

    // Start periodic rebuild
    this.rebuildTimer = setInterval(() => {
      this.rebuildAll().catch(err =>
        this.logger.error({ err }, 'Profile rebuild failed')
      );
    }, this.config.rebuildIntervalMs);
  }

  /** Get profile from memory cache (O(1)) */
  getProfile(agentId: string): AgentProfile | null {
    return this.profiles.get(agentId) ?? null;
  }

  /** Determine cold-start phase for an agent */
  getPhase(agentId: string): ColdStartPhase {
    const profile = this.profiles.get(agentId);
    if (!profile || profile.traceCount < this.config.minTraces) return 'learning';
    if (profile.traceCount < this.config.graduationTraces) return 'graduated';
    return 'active';
  }

  /** Rebuild profiles for all active agents */
  async rebuildAll(): Promise<number> {
    const count = this.profileService.rebuildAllProfiles(this.config.windowDays);
    // Reload from DB
    const rows = this.db.prepare(
      'SELECT agent_id, profile_json FROM agent_profiles'
    ).all() as { agent_id: string; profile_json: string }[];

    this.profiles.clear();
    for (const row of rows) {
      try {
        this.profiles.set(row.agent_id, JSON.parse(row.profile_json));
      } catch { /* skip corrupt */ }
    }
    this.logger.info({ rebuilt: count, cached: this.profiles.size }, 'Profiles rebuilt');
    return count;
  }

  /** Rebuild a single agent's profile (e.g., after significant new data) */
  async rebuildOne(agentId: string): Promise<AgentProfile | null> {
    const profile = this.profileService.buildProfile(agentId, this.config.windowDays);
    if (profile) {
      this.profiles.set(agentId, profile);
    }
    return profile;
  }

  /**
   * Incrementally update a profile with a new observation (EWMA).
   * This is the primary update path — called on every tool check.
   * DB persistence is throttled (every 10 updates or 60s).
   */
  onTrace(
    agentId: string,
    obs: {
      toolName: string;
      args: Record<string, unknown>;
      riskLevel: string;
      costUsd: number;
      tokens: number;
      timestampMs: number;
    },
  ): void {
    let profile = this.profiles.get(agentId);

    // No profile yet — can't do incremental update, trigger batch build
    if (!profile) {
      if (this.shouldRebuild(agentId)) {
        this.rebuildOne(agentId).catch(() => {});
      }
      return;
    }

    // Incremental EWMA update
    profile = this.profileService.updateIncremental(profile, obs);
    this.profiles.set(agentId, profile);

    // Throttled DB persistence
    let state = this.persistState.get(agentId);
    if (!state) {
      state = { count: 0, lastPersistMs: Date.now() };
      this.persistState.set(agentId, state);
    }
    state.count++;

    const shouldPersist = state.count >= 10 || (Date.now() - state.lastPersistMs) > 60_000;
    if (shouldPersist) {
      this.persistProfile(profile);
      state.count = 0;
      state.lastPersistMs = Date.now();
    }
  }

  /** Check if we should trigger a profile rebuild for this agent */
  shouldRebuild(agentId: string): boolean {
    const profile = this.profiles.get(agentId);
    if (!profile) return true;

    // Rebuild if EWMA state is missing (migration from old profiles)
    if (!profile.ewma) return true;

    // Rebuild if profile is older than rebuild interval
    const age = Date.now() - new Date(profile.updatedAt).getTime();
    return age > this.config.rebuildIntervalMs;
  }

  /** Persist profile to DB */
  private persistProfile(profile: AgentProfile): void {
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO agent_profiles (agent_id, profile_json, trace_count, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(
        profile.agentId,
        JSON.stringify(profile),
        profile.traceCount,
        profile.updatedAt,
      );
    } catch (err) {
      this.logger.error({ err, agent_id: profile.agentId }, 'Failed to persist profile');
    }
  }

  /** Shutdown — clear timers */
  shutdown(): void {
    if (this.rebuildTimer) {
      clearInterval(this.rebuildTimer);
      this.rebuildTimer = null;
    }
  }

  get size(): number {
    return this.profiles.size;
  }
}
