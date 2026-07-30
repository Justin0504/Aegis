# AEGIS · Email Routing Setup

The marketing site references four business email aliases:

- `hello@aegistraces.com` — general inquiries, contact form, case studies
- `sales@aegistraces.com` — pricing / enterprise conversations
- `support@aegistraces.com` — customer help
- `security@aegistraces.com` — security disclosures + `security.txt`

**These aliases don't have real mailboxes.** They're routed via
Cloudflare Email Routing to Justin's personal inbox. Without the
routing configured, mail sent to any of them **silently disappears**.

This document is the one-time setup + verification.

---

## Prerequisites

- The `aegistraces.com` DNS zone is on Cloudflare (it is — the site
  deploys to Cloudflare Pages).
- Justin's personal / ops inbox address you want mail to land in
  (referred to below as `<destination>@gmail.com`).

---

## Setup (~5 minutes, done once)

### 1 · Enable Email Routing

1. Cloudflare Dashboard → select the `aegistraces.com` zone.
2. Sidebar → **Email** → **Email Routing**.
3. Click **Enable Email Routing**.
4. Cloudflare prompts to add MX records + SPF TXT record automatically —
   accept them. (`Enable Email Routing` button does this in one click
   if you're the zone admin.)

### 2 · Verify destination address

1. In the same Email Routing panel → **Destination addresses** tab.
2. **Add destination address** → paste `<destination>@gmail.com`.
3. Cloudflare sends a verification email. Click the link in Gmail.
4. The row status flips from "Pending" to "Verified".

### 3 · Create the four custom addresses

Email Routing → **Routes** tab → **Create address**. Add four rules:

| Custom address | Action | Destination |
|---|---|---|
| `hello@aegistraces.com` | Send to an email | `<destination>@gmail.com` |
| `sales@aegistraces.com` | Send to an email | `<destination>@gmail.com` |
| `support@aegistraces.com` | Send to an email | `<destination>@gmail.com` |
| `security@aegistraces.com` | Send to an email | `<destination>@gmail.com` |

Save each. All four should show status "Active".

### 4 · Catch-all (optional but recommended)

Same panel → toggle **Catch-all address** ON → route to the same
destination. Any typo (`hi@`, `contact@`, `info@`) still lands
instead of bouncing.

---

## Verification

From any external inbox (personal, phone):

```bash
# Send test emails
echo "test hello"    | mail -s "hello test"    hello@aegistraces.com
echo "test sales"    | mail -s "sales test"    sales@aegistraces.com
echo "test support"  | mail -s "support test"  support@aegistraces.com
echo "test security" | mail -s "security test" security@aegistraces.com
```

All four should hit your destination inbox within 60 seconds. If any
don't:

1. Cloudflare Dashboard → Email → Email Routing → **Overview** — look
   at "Recent activity" for delivery status per address.
2. Check the Gmail Spam folder (first-time deliveries from a new
   sender routing can land there — mark as "not spam" and it'll route
   to Inbox from then on).
3. Verify DKIM signature on the raw email header — Cloudflare's
   Email Routing signs outgoing forwards; if DKIM is missing your
   MX records didn't get set.

---

## What can go wrong (post-setup)

**Symptom**: contact form on `/contact` sends but you never see the mail.
- Most likely: catch-all is OFF AND the user's client encoded the
  address with a typo. Enable catch-all.

**Symptom**: emails to `hello@` bounce with "553 relay not permitted".
- MX records were removed or the domain moved off Cloudflare. Re-run
  Step 1.

**Symptom**: emails arrive but From: shows `Cloudflare Email Routing
<*.cloudflare.com>` instead of the original sender.
- Normal. Cloudflare forwards via its infrastructure so SPF/DKIM
  don't break. The original sender is in the `Reply-To` header —
  Gmail's Reply button uses it automatically.

**Symptom**: outbound mail from Justin's Gmail as `hello@aegistraces.com`.
- Cloudflare Email Routing is inbound-only. To SEND as `hello@…` you
  need either:
    a. **Google Workspace** on the domain (~$6/mo per mailbox), OR
    b. **Cloudflare Email Sending** (currently in beta; use the
       `wrangler` bindings for Workers-triggered mail; no interactive
       "reply from Gmail as hello@…" support yet).

For v1 we recommend replying from `aojieyua@usc.edu` (Justin's
professional address) with a signature line "Sent on behalf of
AEGIS · hello@aegistraces.com". Not ideal but zero-config.

---

## Follow-ups

- Once Stripe is set up: also route `billing@aegistraces.com`
  (Stripe emails receipts/webhooks from this canonical address by
  default).
- Add `security.txt` at `/.well-known/security.txt` referencing
  `security@aegistraces.com` for the responsible-disclosure workflow.
