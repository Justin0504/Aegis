/**
 * LicenseService — the gateway-side source of truth for the running
 * install's paid tier.
 *
 * On startup:
 *   1. Load persisted license from `license_state` (single-row table).
 *   2. If present + not obviously expired, override `config.license.tier`
 *      with the persisted `tier` so `requireFeature()` middleware
 *      enforces the paid tier immediately — before any UI round-trip.
 *   3. If absent, fall back to the AEGIS_LICENSE_TIER env var (which
 *      defaults to 'community').
 *
 * Activation flow (Cockpit → gateway):
 *   1. User pastes license key in Cockpit LicensePanel.
 *   2. Cockpit POSTs { key } to /api/v1/license/activate.
 *   3. Gateway validates against the marketing site's
 *      /api/desktop/validate-license (source of truth), which reads
 *      the Supabase license_keys row.
 *   4. On success, gateway persists the returned tier + metadata,
 *      updates config.license.tier in-memory, and returns the tier
 *      to Cockpit for its own UI gating.
 *
 * Periodic revalidation:
 *   Every 24h a background task re-validates the persisted key
 *   against the marketing site. If the row was revoked or expired,
 *   tier downgrades to 'community' immediately and Cockpit picks it
 *   up on next /license/status poll.
 *
 * Failure modes (all documented, none silent):
 *   - Marketing site unreachable during activation → 502 to Cockpit;
 *     nothing persisted. User retries.
 *   - Marketing site unreachable during revalidation → keep last-
 *     known-good state; log a warning. Only 7 consecutive failures
 *     over 7 days downgrade to 'community' — this is the "operator
 *     went offline" grace period.
 *   - Persisted key locally revoked (user pasted a fake key that
 *     validates once and later revokes) → picked up by the next
 *     revalidator run within 24h.
 */

import Database from 'better-sqlite3';
import { Logger } from 'pino';
import { LicenseTier, TIER_RANK } from '../config';

const VALIDATE_URL_DEFAULT = 'https://aegistraces.com/api/desktop/validate-license';
const REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const REVALIDATE_GRACE_FAILURES = 7;                // ~7 days of network flakes before downgrade

export interface LicenseSnapshot {
  key:               string | null;
  tier:              LicenseTier;
  plan:              string | null;
  email:             string | null;
  subscription_id:   string | null;
  expires_at:        string | null;
  last_validated_at: string | null;
  last_status:       'active' | 'revoked' | 'expired' | 'network_error';
  activated_at:      string | null;
  /** True when the source of tier is a real license row (not the env fallback). */
  from_license:      boolean;
}

export class LicenseService {
  /** Mutable — reflects the current effective tier. Reads should
   *  prefer this over config.license.tier so the values move
   *  together after activation. */
  private currentTier: LicenseTier;
  private consecutiveFailures = 0;
  private revalidateTimer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database.Database,
    private logger: Logger,
    private envFallbackTier: LicenseTier,
    private validateUrl: string = process.env.AEGIS_LICENSE_VALIDATE_URL ?? VALIDATE_URL_DEFAULT,
  ) {
    // Load persisted license on construction. If none, use env fallback.
    const row = this.readRow();
    if (row && row.last_status === 'active') {
      this.currentTier = row.tier as LicenseTier;
      this.logger.info(
        { tier: this.currentTier, email: row.email, expires_at: row.expires_at },
        'license loaded from local state',
      );
    } else {
      this.currentTier = envFallbackTier;
      this.logger.info({ tier: this.currentTier }, 'no license persisted; using env tier');
    }
  }

  /** Effective tier right now. Every runtime gate should call this,
   *  not read config.license.tier directly. */
  getTier(): LicenseTier {
    return this.currentTier;
  }

  /** Effective feature check: at-or-above the given minimum tier. */
  hasMinTier(min: LicenseTier): boolean {
    return TIER_RANK[this.currentTier] >= TIER_RANK[min];
  }

  /**
   * Cockpit-side activation: verify the key against the marketing
   * site and persist. Returns the resulting snapshot for the UI.
   * Throws on network failure OR invalid key.
   */
  async activate(key: string): Promise<LicenseSnapshot> {
    const trimmed = key.trim();
    if (!trimmed.startsWith('AEGIS-')) {
      throw new Error('license key must start with AEGIS-');
    }
    const remote = await this.validateRemote(trimmed);
    if (!remote.valid) {
      throw new Error(remote.error ?? 'license validation failed');
    }

    this.upsert({
      key:               trimmed,
      tier:              (remote.tier as LicenseTier) ?? this.mapPlanToTier(remote.plan),
      plan:              remote.plan ?? null,
      email:             remote.email ?? null,
      subscription_id:   remote.subscription_id ?? null,
      expires_at:        remote.expires_at ?? null,
      last_status:       'active',
    });

    // Hot-swap in memory so downstream requireFeature() sees new tier
    // on the very next request without a restart.
    const snap = this.snapshot()!;
    this.currentTier = snap.tier;
    this.consecutiveFailures = 0;
    this.logger.info({ tier: this.currentTier, email: snap.email }, 'license activated');
    return snap;
  }

  /**
   * Snapshot for /api/v1/license/status. Never throws — falls back
   * to a plain 'community' snapshot if nothing is persisted so the
   * UI always renders something.
   */
  snapshot(): LicenseSnapshot {
    const row = this.readRow();
    if (!row) {
      return {
        key: null, tier: this.currentTier, plan: null, email: null,
        subscription_id: null, expires_at: null,
        last_validated_at: null, last_status: 'active',
        activated_at: null, from_license: false,
      };
    }
    return { ...row, tier: this.currentTier, from_license: true };
  }

  /** Clear persisted license. In-memory tier reverts to the env fallback. */
  deactivate(): void {
    this.db.prepare('DELETE FROM license_state WHERE id = 1').run();
    this.currentTier = this.envFallbackTier;
    this.consecutiveFailures = 0;
    this.logger.info({ tier: this.currentTier }, 'license deactivated');
  }

  /**
   * Background revalidator. Called on startup + every 24h. Preserves
   * last-known-good state across transient network failures — only
   * downgrades after REVALIDATE_GRACE_FAILURES consecutive misses.
   */
  startRevalidator(): void {
    if (this.revalidateTimer) return;
    // First revalidation runs in 60s to avoid startup thundering herd.
    setTimeout(() => this.revalidateOnce(), 60_000);
    this.revalidateTimer = setInterval(() => this.revalidateOnce(), REVALIDATE_INTERVAL_MS);
  }

  stopRevalidator(): void {
    if (this.revalidateTimer) { clearInterval(this.revalidateTimer); this.revalidateTimer = null; }
  }

  private async revalidateOnce(): Promise<void> {
    const row = this.readRow();
    if (!row?.key) return; // no license persisted; nothing to revalidate

    try {
      const remote = await this.validateRemote(row.key);
      if (remote.valid) {
        this.upsert({
          key:               row.key,
          tier:              (remote.tier as LicenseTier) ?? this.mapPlanToTier(remote.plan),
          plan:              remote.plan ?? row.plan,
          email:             remote.email ?? row.email,
          subscription_id:   remote.subscription_id ?? row.subscription_id,
          expires_at:        remote.expires_at ?? row.expires_at,
          last_status:       'active',
        });
        const nextTier = (remote.tier as LicenseTier) ?? this.mapPlanToTier(remote.plan);
        if (nextTier !== this.currentTier) {
          this.logger.warn({ from: this.currentTier, to: nextTier }, 'license tier changed on revalidate');
          this.currentTier = nextTier;
        }
        this.consecutiveFailures = 0;
      } else {
        // Server said 'not valid' (revoked / expired). Downgrade now.
        this.db.prepare(
          `UPDATE license_state
             SET last_status = ?, last_validated_at = datetime('now')
             WHERE id = 1`,
        ).run(remote.status === 'expired' ? 'expired' : 'revoked');
        this.currentTier = this.envFallbackTier;
        this.logger.warn(
          { reason: remote.error, tier: this.currentTier },
          'license revoked/expired on revalidate; downgrading',
        );
      }
    } catch (err) {
      this.consecutiveFailures += 1;
      this.logger.warn(
        { err: (err as Error).message, consecutive_failures: this.consecutiveFailures },
        'license revalidation network error',
      );
      if (this.consecutiveFailures >= REVALIDATE_GRACE_FAILURES) {
        this.db.prepare(
          `UPDATE license_state SET last_status = 'network_error' WHERE id = 1`,
        ).run();
        this.currentTier = this.envFallbackTier;
        this.logger.warn(
          { tier: this.currentTier },
          'license revalidation offline past grace period; downgrading',
        );
      }
    }
  }

  private readRow(): LicenseSnapshot | null {
    const row = this.db.prepare(
      `SELECT key, tier, plan, email, subscription_id, expires_at,
              last_validated_at, last_status, activated_at
         FROM license_state WHERE id = 1`,
    ).get() as any;
    return row ? { ...row, from_license: true } : null;
  }

  private upsert(row: {
    key: string; tier: LicenseTier; plan: string | null; email: string | null;
    subscription_id: string | null; expires_at: string | null; last_status: string;
  }): void {
    this.db.prepare(
      `INSERT INTO license_state (id, key, tier, plan, email, subscription_id, expires_at, last_status, last_validated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         key = excluded.key,
         tier = excluded.tier,
         plan = excluded.plan,
         email = excluded.email,
         subscription_id = excluded.subscription_id,
         expires_at = excluded.expires_at,
         last_status = excluded.last_status,
         last_validated_at = datetime('now')`,
    ).run(row.key, row.tier, row.plan, row.email, row.subscription_id, row.expires_at, row.last_status);
  }

  private mapPlanToTier(plan: string | null | undefined): LicenseTier {
    const p = (plan ?? '').toLowerCase();
    if (p === 'pro' || p === 'team' || p === 'enterprise') return p as LicenseTier;
    return 'community';
  }

  private async validateRemote(key: string): Promise<{
    valid: boolean;
    tier?: string;
    plan?: string;
    email?: string;
    expires_at?: string;
    subscription_id?: string;
    status?: string;
    error?: string;
  }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(this.validateUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ license_key: key }),
        signal: controller.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
