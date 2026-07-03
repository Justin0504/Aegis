---
title: "AI Agent Safety for Fintech: PCI-DSS + SOC 2 Checklist"
description: "If your AI agents touch cardholder data or move money, here's the concrete PCI-DSS v4.0 and SOC 2 Type II checklist with policy enforcement at the tool-call layer."
publishedAt: 2026-06-29
author: justin
cluster: verticals
tags:
  - pci-dss
  - soc2
  - fintech
  - compliance
  - agent-safety
answersQuery: "What PCI-DSS and SOC 2 requirements apply to AI agents that handle payments?"
headlineStat: "PCI-DSS v4.0 Req 10 (logging) + Req 8 (access control) + SOC 2 CC6.1/CC7.2/CC8.1 cover ~80% of what a fintech AI agent compliance review will ask for."
oneSentenceAnswer: "Fintech AI agents that touch cardholder data must satisfy PCI-DSS v4.0 Req 10 (tamper-evident logging), Req 8 (per-agent access control), and SOC 2 CC6.1 / CC7.2 / CC8.1, together covering about 80% of what a compliance review will ask for; tokenise cardholder data at the gateway to keep PCI scope tight."
coverImage: "1611974789855-9c2a0a7236a3"
keyTakeaways:
  - "PCI-DSS v4.0 Req 10 (logging) and Req 8 (access control) apply to every agent tool call that touches cardholder data."
  - "SOC 2 CC6.1 / CC7.2 / CC8.1 cover ~80% of what a fintech AI agent compliance review will ask for."
  - "The audit log must be tamper-evident; plain Postgres rows fail Req 10.5 under v4.0."
  - "Tokenise cardholder data at the gateway, not in the LLM prompt, to keep PCI scope tight."
---

**Short answer**: a fintech AI agent that touches cardholder data or initiates transfers must satisfy specific clauses of PCI-DSS v4.0 (logging, access control, change management) and SOC 2 Type II (security, availability, confidentiality). The hard part isn't finding the requirements — it's producing the evidence that maps each tool call to a controlled, auditable, policy-gated action. This article maps the requirements to concrete enforcement patterns and shows what evidence a reviewer accepts.

## What's the scope question — is my AI agent in PCI scope?

Three rules of thumb from QSA (Qualified Security Assessor) practice:

1. **If the agent processes, stores, or transmits PAN** (Primary Account Number) → **in scope**, full Cardholder Data Environment (CDE) applies.
2. **If the agent triggers transactions via tokenized references** (e.g. Stripe customer IDs) but never sees PAN → **out of scope for storage**, but in scope for **Req 12 (policy)** and the connected-system controls.
3. **If the agent only reads metadata** (transaction totals, last-4, status) → **out of scope** for PCI but still in scope for SOC 2 and your internal data-handling policy.

For most modern fintechs using Stripe/Adyen/Braintree, agents are case 2 — they trigger payments through tokenized APIs but never touch PAN. The audit focus shifts to: who/what triggered each transaction, was the policy followed, and is the log immutable.

## What PCI-DSS v4.0 requirements actually apply?

The requirements that hit AI agents the hardest:

| Req | Title | What the agent must do |
|---|---|---|
| **Req 7** | Restrict access by need-to-know | Each agent has narrowly scoped tool permissions — `refund-agent` can call `stripe.refund` but not `stripe.transfer` |
| **Req 8** | Identify and authenticate access | Each tool call carries an `agent_id` tied to an issued credential; service-to-service auth, not "service account" |
| **Req 10** | Track all access to system components and cardholder data | Tamper-evident logs for every decision; can be reconstructed years later |
| **Req 11** | Test security regularly | Automated red-team corpus runs against the agent's policy bundle; gaps surface as failing tests |
| **Req 12** | Maintain a policy addressing information security | Documented policy bundle + version-pinned references in the audit log |

The big shift in PCI v4.0 (effective March 2025) is the explicit requirement for **automated testing** and **continuous control validation** — exactly what an AI agent firewall enables.

## How does AEGIS map to each PCI-DSS + SOC 2 requirement?

### Req 7 — Need-to-know access

Each AEGIS agent registers with an `agent_id`, a scope, and a list of permitted tools. The gateway rejects any tool call not in the scope, regardless of what the LLM tries:

```yaml
agent: refund-agent
scope: production
permitted_tools:
  - stripe.refund
  - stripe.charge.retrieve
  - send_email
denied_tools_explicit:
  - stripe.transfer
  - stripe.charge.create
```

If the agent's LLM is convinced (via injection or hallucination) to call `stripe.transfer`, the gateway returns "tool not in agent scope," logs the attempt, and the call never reaches Stripe. The Req 7 control is enforced deterministically.

### Req 8 — Authenticate access

Each agent registers with a credential (issued by AEGIS's agent registry). The credential is a signed token; rotation is automatic on a schedule; revocation is immediate when the agent is decommissioned. Every tool call carries the credential; the gateway verifies on each request.

For Req 8.3 (multi-factor for non-console access): high-value tools (transfers >$10k, configuration changes, policy edits) require human approval via the **2-of-N pattern** described in our [stablecoin article](/blog/stablecoin-agent-security-travel-rule). The "MFA" is structural: the agent is one factor, the human approver is the second.

### Req 10 — Audit logs

PCI Req 10 is the longest section. The relevant subsections for agents:

- **10.2.1** — Log all access to cardholder data
- **10.2.2** — Log all actions by individuals with elevated privileges
- **10.2.4** — Log all failed access attempts
- **10.5** — Logs must be tamper-resistant and retained for 1 year (with 3 months immediately accessible)

AEGIS's [cryptographic audit log](/blog/cryptographic-audit-logs-merkle-sigstore) satisfies the tamper-resistance requirement structurally. Every decision (allow / block / escalate / failed-attempt) becomes a Merkle leaf. The witness co-signature gives independent verifiability — a QSA can verify the log was not edited after the fact, *without trusting you*.

The mapping to specific PCI requirements:

```
PCI Req 10.2.1 → AEGIS leaf {decision: "allow", tool: "stripe.charge.retrieve"}
PCI Req 10.2.2 → AEGIS leaf {decision: any, policy_id: "policy.privileged-tool-use"}
PCI Req 10.2.4 → AEGIS leaf {decision: "block", failure_class: "scope-violation"}
PCI Req 10.5   → Merkle root + witness signature
```

### Req 11 — Test security

A red-team corpus runs against the policy bundle on each release. The corpus includes:

- AgentDojo IPI scenarios (~120 cases)
- Prompt injection patterns from the OWASP LLM Top 10
- Customer-specific scenarios (provided by their security team)

Each scenario expects a specific allow/block/escalate decision. CI fails if the policy bundle's decisions don't match. The "automated testing" requirement of PCI v4.0 is satisfied by this pipeline.

### Req 12 — Policy

The agent's policy bundle is exportable as a JSON document with `policy_id`, `version_sha256`, `compiled_from_nl`, `last_modified_by`, `last_modified_at`. The same hashes appear in every audit-log entry, so a QSA can pivot from "this transaction was approved" to "here's the exact text of the rule that approved it."

## What about SOC 2 Type II?

SOC 2 is principle-based, not control-based — the auditor sets the bar based on the **Trust Services Criteria** the company claims. The criteria that hit AI agents:

| TSC | Name | AEGIS mapping |
|---|---|---|
| **CC6.1** | Logical access | Agent scope + per-tool permissions |
| **CC6.2** | New credentials | Agent registration is logged; auto-rotation |
| **CC6.6** | Boundary protection | Gateway sits at network boundary; egress policy |
| **CC7.2** | Anomaly detection | Layer 2 sequence model flags drift |
| **CC7.3** | Security events | Block/escalate decisions surface as alerts |
| **CC8.1** | Change management | Policy edits are logged; require approval |
| **C1.1** | Identify confidential info | PII detector in Layer 1 |
| **C1.2** | Disposal of confidential info | Retention policy enforces TTL |

Most SOC 2 auditors want **screenshots + documentation** for each control. AEGIS makes this easier by **exporting an evidence pack**:

```bash
aegis export-evidence-pack --framework soc2 --period 2026-Q2
```

The pack includes the policy bundle as-of-period, a stratified sample of audit-log entries with witness signatures, the detector list (with versions), and a per-control mapping document. The auditor verifies the witness signatures independently; the rest is structured evidence.

## What's the real audit experience?

Walk through what a SOC 2 Type II audit feels like for a fintech using AEGIS:

1. **Auditor**: "Show me your access-control policy for AI agents."
   You: `aegis export-policy-bundle --as-of 2026-Q1`. Hand them the YAML bundle.

2. **Auditor**: "Show me 10 random tool calls from March and prove they were policy-controlled."
   You: pick 10 from your private audit DB. Run `aegis verify-leaf <trace_id>` on each. The output shows the policy_id, the policy_version_sha256, and the Merkle inclusion proof. Auditor verifies the proofs against `witness.aegistraces.com`.

3. **Auditor**: "Show me one example where a privileged action was blocked."
   You: query the DB for `decision = "block"`. Pick a high-severity example. Walk them through what happened.

4. **Auditor**: "How do you detect anomalous agent behavior?"
   You: Layer 2 detector docs + a sample alert + the recovery action taken.

5. **Auditor**: "What happens when the policy is wrong?"
   You: change-management process — proposed policy edits go through review, dry-run against the red-team corpus, then merge. Show them an example PR.

Each step is **evidence**, not testimony. That's the difference between "we have audit logs" (which everyone says) and "we have *verifiable* audit logs" (which is what compliance buyers actually want).

## What concrete evidence do fintech reviewers always ask for?

If you're preparing for either certification:

- [ ] Documented list of agents, their scopes, and their permitted tools
- [ ] Each agent has a unique credential rotated at least every 90 days
- [ ] Every tool call produces a tamper-evident audit log entry
- [ ] Logs are retained 1+ year and queryable
- [ ] Policy changes are version-controlled and require multi-person approval
- [ ] Red-team test suite runs in CI on every release
- [ ] Anomaly alerts route to a security team with response SLAs
- [ ] Break-glass procedure documented and tested annually
- [ ] Vendor list includes the AEGIS SBOM with current versions
- [ ] Data residency confirmed for all in-scope components

AEGIS provides infrastructure for items 1-9; item 10 is operational discipline.

## FAQ

**Does using AEGIS make me PCI-compliant?**
No — compliance is your own. AEGIS provides the controls and the evidence; you still need policy documentation, training, vendor management, the works. AEGIS narrows the work; it doesn't eliminate it.

**What about the PCI Software Security Framework (SSF)?**
Out of scope for most AI agents (SSF applies to applications that *process* PAN). If your agent does process PAN, you're in CDE territory and the conversation gets much longer.

**Do I need a QSA to use AEGIS?**
For Level 1 merchants (>6M transactions/year) yes, that's required regardless of tooling. For lower levels, self-assessment is allowed; AEGIS's evidence pack makes the SAQ much faster.

**How does AEGIS handle PCI's encryption-at-rest requirements?**
AEGIS doesn't store PAN — it only sees tokenized references. The PAN never enters AEGIS's data path. For audit-log encryption-at-rest, that's a property of your underlying storage (Postgres TDE, S3 SSE) — AEGIS provides the data; you provide the encryption.

**What about emerging regulations like the EU AI Act?**
The Act's "high-risk AI system" requirements (Article 9 risk management, Article 12 record-keeping, Article 14 human oversight) map almost directly to AEGIS's policy bundle + audit log + 2-of-N approval pattern. We have a separate write-up coming on EU AI Act mapping.

---

**Try AEGIS** → `curl -fsSL aegistraces.com/install | sh`

**SOC 2 evidence pack** → `aegis export-evidence-pack --framework soc2`

**Discuss compliance patterns** → [GitHub Discussions](https://github.com/Justin0504/Aegis/discussions)
