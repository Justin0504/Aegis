# AEGIS · Auth + Billing Setup

End-to-end setup for the `aegistraces.com` login → checkout → license
issuance flow. Follow the sections in order.

**Stack**: Astro SSR (Cloudflare Pages) + Supabase Auth + Stripe.

---

## 1 · Supabase project

1. Create a new project at [supabase.com](https://supabase.com) — Free
   tier is fine for launch.
2. **Project Settings → API**: copy
   - `URL` → `PUBLIC_SUPABASE_URL`
   - `anon public` key → `PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`
3. **Database → SQL Editor**: paste the entire contents of
   `apps/marketing/supabase/migrations/0001_auth_billing.sql` and run.
   Creates `profiles`, `subscriptions`, `license_keys` with RLS.

---

## 2 · OAuth providers

For each of the three providers, you'll register an OAuth app + paste
its client id / secret into Supabase.

### 2.1 Google

1. [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create Credentials → OAuth client ID → Web application.
3. Authorized redirect URIs — add:
   `https://<project-ref>.supabase.co/auth/v1/callback`
4. Copy client id + secret.
5. Supabase Dashboard → Authentication → Providers → Google → enable +
   paste client id + secret.

### 2.2 GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Authorization callback URL: `https://<project-ref>.supabase.co/auth/v1/callback`
3. Copy client id + secret.
4. Supabase → Providers → GitHub → enable + paste.

### 2.3 LinkedIn (OIDC)

1. [LinkedIn Developer Portal → Create App](https://www.linkedin.com/developers/apps/new).
2. Products tab → request "Sign In with LinkedIn using OpenID Connect".
   Approval is instant.
3. Auth tab → Authorized redirect URLs:
   `https://<project-ref>.supabase.co/auth/v1/callback`
4. Copy client id + secret.
5. Supabase → Providers → LinkedIn (OIDC) → enable + paste.

### 2.4 Site URL + redirect URLs (once, in Supabase)

Authentication → URL Configuration:
- Site URL: `https://aegistraces.com`
- Additional redirect URLs (comma-separated):
  ```
  https://aegistraces.com/api/auth/callback,
  http://localhost:4321/api/auth/callback
  ```

---

## 3 · Stripe

1. [Stripe Dashboard](https://dashboard.stripe.com) → get `sk_test_…`
   + `pk_test_…` from Developers → API keys.
2. **Products → + Add product**, create:
   - **AEGIS Pro Monthly** (recurring, $19/mo) → copy the Price ID (`price_…`)
   - **AEGIS Pro Annual**  (recurring, $190/yr) → copy Price ID
   - **AEGIS Enterprise Monthly** (recurring, $99/mo) → copy Price ID
   - **AEGIS Enterprise Annual** (recurring, $990/yr) → copy Price ID
3. Feed the four Price IDs into your env:
   ```
   STRIPE_PRICE_PRO_MONTHLY=price_...
   STRIPE_PRICE_PRO_ANNUAL=price_...
   STRIPE_PRICE_ENTERPRISE_MONTHLY=price_...
   STRIPE_PRICE_ENTERPRISE_ANNUAL=price_...
   ```
4. **Webhook**: Developers → Webhooks → Add endpoint.
   - URL: `https://aegistraces.com/api/stripe-webhook`
   - Events to send:
     ```
     checkout.session.completed
     customer.subscription.updated
     customer.subscription.deleted
     invoice.payment_failed
     ```
   - Copy the Signing secret (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.

For local dev, use the Stripe CLI:
```bash
stripe listen --forward-to localhost:4321/api/stripe-webhook
```
The CLI prints a local `whsec_…` — set that as `STRIPE_WEBHOOK_SECRET`
in your `.env` for the dev session.

---

## 4 · Environment variables in Cloudflare Pages

**Settings → Environment variables** (create both Production and
Preview scopes; use test keys for Preview):

| Name                            | Type   | Notes |
|---------------------------------|--------|-------|
| `PUBLIC_SUPABASE_URL`           | Plain  | Prefixed PUBLIC_ so it ships to the browser bundle. |
| `PUBLIC_SUPABASE_ANON_KEY`      | Plain  | Anon key is safe to expose. |
| `SUPABASE_SERVICE_ROLE_KEY`     | **Secret** | Never PUBLIC_. Bypasses RLS. |
| `STRIPE_SECRET_KEY`             | Secret | `sk_live_…` for prod, `sk_test_…` for preview. |
| `STRIPE_PUBLISHABLE_KEY`        | Plain  | Currently unused by SSR; kept for future direct-embed use. |
| `STRIPE_WEBHOOK_SECRET`         | Secret | Match to the webhook endpoint's signing secret. |
| `STRIPE_PRICE_PRO_MONTHLY` etc. | Plain  | Price IDs — visible in Stripe Dashboard. |

Save + trigger a rebuild.

---

## 5 · Local dev

```bash
cd apps/marketing
cp .env.example .env      # fill in the values
npm install
npm run dev               # http://localhost:4321
# In another terminal:
stripe listen --forward-to localhost:4321/api/stripe-webhook
```

Sign in flow:
1. Visit http://localhost:4321/login
2. Use Magic Link (fastest) — Supabase emails a one-time link
3. Or click Google / GitHub / LinkedIn — provider round-trips through
   `https://<project-ref>.supabase.co/auth/v1/callback` → `/api/auth/callback`
4. Land on `/download` — shows your email in the header strip

Purchase flow:
1. `/pricing` → click **Upgrade to Pro**
2. Redirects to Stripe Checkout (test mode)
3. Fill card `4242 4242 4242 4242` / any future date / any CVC
4. Success → `/download?checkout=success` — banner + copyable license key

---

## 6 · Verifying it worked

**Supabase**: Table Editor → `profiles` should have a row for your
signup. After checkout: `subscriptions` + `license_keys` populate.

**Stripe**: Dashboard → Customers → your email → subscription is
active. Dashboard → Webhooks → your endpoint → recent deliveries all
`200 OK`.

**Cloudflare Pages** logs (Functions tab): every `/api/*` request
shows up. Look for `stripe webhook handler error` if entitlement
isn't landing.

---

## 7 · Troubleshooting

**Symptom**: login page shows "Auth not configured" banner.
* `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` missing. Set them
  in Cloudflare env AND redeploy — env changes require a rebuild.

**Symptom**: OAuth redirect lands at `/login?error=…invalid_grant…`.
* Redirect URL mismatch. In Supabase → URL Configuration, confirm
  `https://aegistraces.com/api/auth/callback` is on the allow-list.

**Symptom**: Stripe webhook returns 400 "signature verify failed".
* `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint. Copy the current
  signing secret from Stripe Dashboard → Webhooks → your endpoint.

**Symptom**: Purchase succeeds but no license key on `/download`.
* Webhook didn't fire. Check Stripe Dashboard → Webhooks → your
  endpoint → recent deliveries. Non-2xx? Look at Cloudflare Pages
  Functions logs for the exception.

**Symptom**: `SUPABASE_SERVICE_ROLE_KEY` accidentally exposed in
browser bundle.
* Variable name must NOT start with `PUBLIC_`. Cloudflare Pages
  respects that; Astro respects that. If you named it
  `PUBLIC_SUPABASE_SERVICE_ROLE_KEY` by mistake, ROTATE the key in
  Supabase immediately and re-set with the correct name.
