---
title: "HIPAA-Compliant AI Agents: 7 Requirements You Can't Skip"
description: "AI agents in healthcare touch PHI in 8 different ways. Here are the 7 HIPAA requirements that map directly to the agent's tool-call layer, with concrete controls."
publishedAt: 2026-06-29
author: justin
cluster: verticals
tags:
  - hipaa
  - healthcare
  - phi
  - agent-safety
  - compliance
answersQuery: "What does my AI agent need to do to be HIPAA-compliant?"
headlineStat: "HIPAA Security Rule §164.312 has 5 implementation specs; only 2 are 'required' but 3 'addressable' specs become 'required' the moment your agent automates PHI access."
oneSentenceAnswer: "HIPAA-compliant AI agents must satisfy seven Security Rule requirements at the tool-call layer — access control, audit controls, integrity, transmission security, minimum necessary, entity authentication, and breach notification readiness — and although the addressable specs are technically optional, they become effectively required the moment the agent automates PHI access."
coverImage: "1576091160550-2173dba999ef"
howToDuration: "PT2H"
howToSteps:
  - "Map every tool your AI agent can call against the 5 §164.312 implementation specs — access control, audit controls, integrity, person/entity authentication, transmission security — and identify which tools touch PHI."
  - "Deploy a tool-call gateway with per-agent Ed25519-signed audit trails so §164.312(b) audit controls have tamper-evident evidence that survives outside verification (plain DB logs fail covered-entity review)."
  - "Configure access control policies that enforce the HIPAA minimum-necessary standard — the gateway should refuse tool calls that request more PHI fields than the agent's task requires."
  - "Enable integrity controls via SHA-256 hash-chaining of every tool decision so §164.312(c) integrity requirement is satisfied without additional infrastructure."
  - "Set person / entity authentication (§164.312(d)) at the SDK layer by binding every tool_use to an agent_id and requiring an OIDC or SAML identity token for administrative operations."
  - "Encrypt PHI in transit using TLS 1.3 for every tool egress and record encryption metadata in the audit trail so §164.312(e) transmission security has evidence."
  - "Sign a Business Associate Agreement (BAA) with every downstream service the agent calls that touches PHI; the gateway's per-tool policy layer is where you enforce which endpoints are BAA-covered."
keyTakeaways:
  - "HIPAA Security Rule §164.312 has 5 implementation specs; 2 are required, 3 addressable."
  - "All 3 addressable specs become effectively required the moment your agent automates PHI access."
  - "Audit controls (§164.312(b)) need to be tamper-evident — plain DB logging fails in covered-entity review."
  - "PHI tokenisation at the gateway is the cheapest path to keep model inputs out of HIPAA scope."
  - "A BAA with your LLM provider is necessary but never sufficient; tool calls still need their own controls."
---

**Short answer**: a healthcare AI agent that reads, writes, or transmits Protected Health Information (PHI) must satisfy seven HIPAA Security Rule requirements at the tool-call layer — access control, audit controls, integrity, transmission security, minimum necessary, person-or-entity authentication, and breach notification readiness. The compliance question isn't *can* you, it's *how do you produce evidence the auditor will accept*. This article maps each requirement to a concrete control AEGIS enforces.

## What's the scope question — is my agent a Covered Entity or Business Associate?

You're a Covered Entity if you provide healthcare directly (hospital, clinic, provider). You're a Business Associate if you process PHI on behalf of a Covered Entity (AI scribe vendor, telehealth platform, RCM SaaS).

Either way, **if the agent touches PHI you're subject to the HIPAA Security Rule**. The difference matters for breach notification timing (CE 60 days, BA depends on BAA) but the controls are the same.

PHI definition is broader than people expect: "any individually identifiable health information transmitted or maintained in electronic form." That includes:

- Patient name + condition in an email
- Patient ID + visit date in a database query
- Anything the agent retrieves from an EHR
- Anything the agent posts back to an EHR
- Anything the agent sends to a third-party LLM API (yes, your tool call body is PHI transmission)

The last bullet trips up everyone. **An agent calling OpenAI with PHI in the prompt is HIPAA-regulated transmission**, and OpenAI needs a BAA (which they offer on Enterprise plans). Most consumer-tier LLM API usage with PHI is non-compliant.

## What are the 7 requirements that hit AI agents?

### 1. Access Control (§164.312(a)(1)) — Required

The agent must implement technical policies that allow only authorised users (or processes) access to PHI.

**Agent-layer mapping**: every agent has a unique identity. Each agent's scope explicitly lists which PHI-touching tools it can call. The gateway enforces — if the agent's LLM gets convinced to call `ehr.read_patient(unauthorized_id)`, the gateway rejects with `scope-violation` before the call hits the EHR.

```yaml
agent: clinical-scribe-agent
permitted_tools:
  - ehr.read_patient_notes      # scoped to current encounter
  - ehr.write_clinical_note
denied_tools_explicit:
  - ehr.read_patient_billing
  - ehr.read_family_history
  - ehr.export_full_record
```

The deny list is as important as the allow list — it documents what the agent *can't* do, which is what HIPAA auditors look for.

### 2. Audit Controls (§164.312(b)) — Required

Implement hardware, software, and procedural mechanisms that record and examine activity in systems that contain or use PHI.

**Agent-layer mapping**: AEGIS's [cryptographic audit log](/blog/cryptographic-audit-logs-merkle-sigstore) ties every PHI access to a specific agent, a specific policy decision, and a specific timestamp. The Merkle anchoring means a future breach investigation can prove what was accessed without trusting the breached system.

HIPAA doesn't specify *how* tamper-evidence is achieved — just that it's there. The OCR (HHS Office for Civil Rights) has cited "logs that could have been edited after the fact" as a deficiency in breach settlements. Cryptographic audit is the strongest available answer.

### 3. Integrity (§164.312(c)(1)) — Required

Implement policies and procedures to protect PHI from improper alteration or destruction.

**Agent-layer mapping**: every PHI write (e.g. an agent updating a patient note) is gated by policy and logged. AEGIS's policy `consent-must-be-structured` (from our [indirect prompt injection article](/blog/indirect-prompt-injection-examples)) is a concrete example — patient consent flags can only originate from structured consent forms, never from free-text the agent might be tricked into. This protects integrity of the PHI itself, not just the access log.

### 4. Person-or-Entity Authentication (§164.312(d)) — Required

Verify a person or entity seeking access is the one claimed.

**Agent-layer mapping**: every agent registers with a signed credential, rotated automatically. Service-to-service authentication, not "shared secret in a config file." The credential is verified on every tool call; revocation propagates instantly.

For human-in-the-loop steps (the 2-of-N approval pattern for high-stakes actions), the human authenticates via your IdP (Okta / Google Workspace / Azure AD) and the approval lands in the audit log.

### 5. Transmission Security (§164.312(e)(1)) — Required

Implement technical security measures to guard against unauthorised access to PHI being transmitted over a network.

**Agent-layer mapping**:
- All gateway ↔ tool ↔ EHR communications use TLS 1.3 minimum.
- Outbound calls to non-allowlisted hosts trigger `transmission-allowlist` policy → block.
- Outbound calls to third-party LLM APIs are scoped: only LLM endpoints that hold a current BAA are in the allowlist. New LLM providers go through BAA review before they hit the allowlist.

```yaml
config:
  llm_egress_allowlist:
    - host: "api.anthropic.com"
      baa_signed: true
      baa_expires: "2027-03-15"
    - host: "api.openai.com"
      baa_signed: true
      baa_expires: "2027-01-22"
      requires_data_residency: "us-east"
```

The BAA expiration date itself becomes a policy concern — 30 days before expiration, AEGIS emits a `baa-expiring` alert.

### 6. Minimum Necessary (§164.502(b)) — Required (Privacy Rule)

Use, disclose, and request only the minimum amount of PHI necessary to accomplish the intended purpose.

**Agent-layer mapping**: this is the hardest one because it's purpose-bound. AEGIS approximates it with **field-level scoping**:

```yaml
rule: "minimum-necessary-clinical-scribe"
when:
  - tool.name == "ehr.read_patient_notes"
require:
  args.fields IS_SUBSET_OF [
    "visit_date", "chief_complaint", "vitals",
    "current_medications", "allergies", "current_assessment"
  ]
on_violation: ESCALATE
```

The clinical-scribe agent gets the fields needed for note generation; it doesn't get billing codes, family history, or insurance information unless a separate tool call escalates with justification. The audit log captures both what was requested and what was approved.

### 7. Breach Notification Readiness (§164.404)

A breach involving PHI requires notification within 60 days of discovery. The clock starts at *discovery*, which means knowing what was accessed.

**Agent-layer mapping**: the cryptographic audit log makes "what was accessed" recoverable instantly. After a breach (e.g. compromised agent credentials), you query the audit log for all entries from that agent in the affected window, get a clean structured list, and produce the notification with confidence. Without a verified audit log, breach scope is hand-wavy and OCR penalties are higher.

## What are the addressable specs that effectively become required?

HIPAA distinguishes "required" (must implement) from "addressable" (must implement *or* document why an alternative is equivalent). Three addressable specs become effectively required when AI agents are involved:

| Addressable spec | Why it becomes required for agents |
|---|---|
| **§164.308(a)(1)(ii)(A) Risk Analysis** | Agents introduce new attack surfaces (prompt injection, jailbreak). Risk analysis must include them. |
| **§164.312(a)(2)(iii) Automatic Logoff** | Agents don't "log off" — but their credentials must auto-rotate (90 days max). |
| **§164.312(b) Audit Controls / Real-time** | Manual log review is insufficient when agents make 1000s of calls/day. Need automated anomaly detection. |

These are practical decisions, not letter-of-the-law — but OCR has expectations for "industry standard" and AI-mediated PHI access is unforgiving.

## What does the BAA situation look like for LLM providers?

As of mid-2026, the BAA landscape for major LLM providers:

| Provider | BAA available? | On which tier |
|---|---|---|
| **Anthropic** | Yes | Claude for Work + API (Enterprise) |
| **OpenAI** | Yes | ChatGPT Enterprise + API (Enterprise) |
| **Google Vertex AI** | Yes | All paid tiers |
| **AWS Bedrock** | Yes | Default (under AWS BAA) |
| **Azure OpenAI** | Yes | Default (under Microsoft BAA) |
| **Mistral La Plateforme** | Yes | Enterprise plan |
| **Cohere** | Yes | Enterprise plan |

A few quiet ones that **don't** have BAAs as of writing — open-router style aggregators, indie API resellers, some hobbyist endpoints. Send PHI through these and you've breached the moment the data leaves your network.

AEGIS's policy enforcement: the LLM API egress allowlist is the only allowed destination. New endpoints require BAA-tagged config entries; the gateway refuses traffic to non-BAA hosts.

## What evidence do I need in the HIPAA audit pack?

When OCR (or your client's HIPAA officer) walks in:

```bash
aegis export-evidence-pack --framework hipaa --period 2026-Q2
```

The pack includes:

- **Agent registry snapshot** as of audit period (agent identities + scopes)
- **Policy bundle** with version hashes for each policy that touched PHI
- **Audit log** stratified sample with Merkle inclusion proofs
- **BAA tracker** with current status for every LLM API in the allowlist
- **Risk analysis** auto-generated from the agents/tools/policies inventory
- **Breach notification readiness** — the SQL queries to reconstruct any breach window

The auditor verifies the Merkle proofs against the witness service; the rest is structured documentation.

## What are the most common HIPAA failure modes for AI agents?

Six patterns we've seen fail compliance review:

1. **Using ChatGPT consumer API to summarise patient notes**. No BAA — automatic breach.
2. **Storing PHI in the LLM provider's "memory" feature** (e.g. ChatGPT memories, Anthropic Projects). Often unclear whether BAA covers these.
3. **Sending entire patient records when only one field is needed** (§164.502(b) minimum necessary violation).
4. **Logging full prompts (with PHI) to Datadog / Splunk** without considering whether the logging vendor has a BAA.
5. **No procedure for credential rotation when an employee leaves**. Discovered during breach investigation.
6. **Patient consent extracted from free-text** ("the patient said it was OK on the phone"). HIPAA wants structured, auditable consent.

AEGIS's policy bundle addresses 1-6 explicitly. The policies are not magic — they're enforcement of practices that should already exist; they just make the enforcement deterministic and auditable.

## FAQ

**Does using AEGIS make my company HIPAA-compliant?**
No — compliance is your organisation's responsibility. AEGIS provides the technical controls and audit evidence that map to the Security Rule, but you still need administrative safeguards (workforce training, written policies, risk analysis) and physical safeguards (data center, device controls).

**What about HITRUST CSF?**
HITRUST is a superset — implements HIPAA + ISO 27001 + NIST CSF + PCI-DSS controls. AEGIS evidence packs include a HITRUST CSF mapping document; the controls overlap is ~70%.

**Can my agent run on-prem in a hospital network?**
Yes — that's actually the cleanest deployment. AEGIS Community + Pro both self-host. No PHI leaves the hospital's network; the LLM API calls go to the BAA-covered provider; the audit log lives on the hospital's storage.

**What if the LLM provider has a BAA but stores logs that include PHI?**
That's covered by the BAA — the provider is your business associate for those logs. You need to verify their retention and deletion policies are HIPAA-compliant (most enterprise tiers are).

**Is there a HIPAA-specific policy pack in AEGIS?**
Yes — `aegis policy install healthcare-hipaa-base`. It includes the 7 requirements above plus 12 derived controls. Customise from there.

---

**Install** → `curl -fsSL aegistraces.com/install | sh`

**HIPAA evidence pack** → `aegis export-evidence-pack --framework hipaa`

**OCR HIPAA guidance** → [hhs.gov/hipaa](https://www.hhs.gov/hipaa)
