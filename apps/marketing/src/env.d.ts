/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: {
      id: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
    } | null;
    supabase?: import('@supabase/supabase-js').SupabaseClient;
    runtime?: {
      env: Record<string, string>;
    };
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
  readonly STRIPE_SECRET_KEY: string;
  readonly STRIPE_PUBLISHABLE_KEY: string;
  readonly STRIPE_WEBHOOK_SECRET: string;
  readonly STRIPE_PRICE_PRO_MONTHLY: string;
  readonly STRIPE_PRICE_PRO_ANNUAL: string;
  readonly STRIPE_PRICE_ENTERPRISE_MONTHLY: string;
  readonly STRIPE_PRICE_ENTERPRISE_ANNUAL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
