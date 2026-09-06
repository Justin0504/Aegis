---
title: "Cryptographic Audit Logs for AI Agents: Merkle + Witness Co-signature"
description: "Most agent platforms log to plain Postgres. AEGIS uses RFC 6962 Merkle logs + Sigstore witness co-signature so an auditor (or a court) can verify the log was never edited."
publishedAt: 2026-06-29
author: justin
cluster: deep-dive
tags:
  - audit-log
  - merkle-tree
  - sigstore
  - RFC-6962
  - compliance
  - transparency-log
answersQuery: "How do I prove my AI agent's audit log was never edited after the fact?"
headlineStat: "RFC 6962 (Certificate Transparency) is the same standard browsers use to detect rogue SSL certificates. AEGIS applies it to every agent decision."
oneSentenceAnswer: "Store agent decisions in an RFC 6962 Merkle tree with each root co-signed by an independent witness (Sigstore pattern); auditors verify inclusion and consistency proofs against any witness without trusting the operator, using the same cryptographic standard browsers use to detect rogue SSL certificates."
coverImage: "1633265486064-086b219458ec"
howToDuration: "PT1H"
howToSteps:
  - "Model each agent decision as a leaf in a Merkle tree — the tuple (trace_id, agent_id, tool_call, timestamp, decision) canonicalised to a byte string and hashed with SHA-256."
  - "On every write, compute the new Merkle root and sign it with the operator's Ed25519 key. Publish the (root, signature, tree size) triple to an append-only public log."
  - "Bring in an independent witness (RFC 6962 pattern) that co-signs every root the operator publishes. The witness refuses to sign an inconsistent history — this closes the operator-rewind attack surface."
  - "Ship an offline verifier (245-line Node stdlib script in AEGIS) that any auditor can run air-gapped. The verifier accepts a Merkle inclusion proof + a consistency proof and returns pass/fail without contacting either operator or witness."
  - "Wire log-inclusion checks into every audit-export path: a signed evidence pack for SOC 2 / PCI-DSS / EU AI Act must include the Merkle proof for each cited trace."
  - "Rotate the witness quarterly and rotate operator keys yearly, publishing the cross-signature so historical proofs stay verifiable across the rotation."
keyTakeaways:
  - "RFC 6962 Merkle trees give O(log n) inclusion and consistency proofs over the full agent decision log."
  - "Sigstore-style witness co-signature stops the operator from silently rewinding the log."
  - "An auditor can verify the log was never edited without trusting the operator or rescanning the full chain."
  - "Same standard browsers use to detect rogue SSL certs — proven cryptography, not novel research."
---

**Short answer**: an audit log stored in a regular database can be edited by anyone with write access to that database, including (eventually) an attacker who breaches it. A *cryptographic* audit log uses the same Merkle-tree append-only structure as Certificate Transparency (RFC 6962). Each entry's hash chains into a tree whose root is co-signed by an independent witness service. Any post-hoc edit changes the root — and the discrepancy is detectable years later by anyone who saw the old root. This is what AEGIS ships; this article explains why it matters and how it works.

## Why isn't a Postgres `audit_log` table enough?

Most agent frameworks log decisions to a table like:

```sql
CREATE TABLE agent_audit (
  id          BIGSERIAL PRIMARY KEY,
  ts          TIMESTAMP NOT NULL,
  agent_id    TEXT,
  tool_call   JSONB,
  decision    TEXT,
  policy_id   TEXT
);
```

This satisfies the *letter* of "we have an audit log." It fails the *intent* in three ways:

1. **Anyone with `UPDATE` or `DELETE` permission can rewrite history.** That's not just attackers — it's also bugged migration scripts, drunken DBAs, and well-meaning "let's just fix this row" pattern.
2. **A breached database is a quiet liability.** Stuxnet-grade attackers re-write logs to hide their tracks. You may not notice until external evidence (HTTP referer logs, downstream customer records) contradicts your own audit table.
3. **An auditor cannot verify the log without trusting you.** They run a `SELECT` against your DB and trust that the rows came from real events. SOC 2 reviewers handle this with vendor-attestation paperwork; a courtroom doesn't.

A cryptographic audit log makes editing *detectable* even if the attacker has full DB access. You can no longer hide changes — you can only fail to publish them.

## What is RFC 6962, and why is it the right standard?

RFC 6962 is *Certificate Transparency* — the protocol that lets browsers detect when a Certificate Authority issues a rogue SSL cert. Every public CA must publish each cert it signs into a public *transparency log*. Domain owners (Google, Cloudflare, anyone) monitor those logs and raise alarms on certs they didn't ask for. The mechanism is:

1. The log is an **append-only Merkle tree**.
2. Each batch of new entries produces a new **signed tree head (STH)** — a hash of the current root plus a timestamp signed by the log operator.
3. **Independent witnesses** (other organisations) periodically download the STH and re-sign it, publishing their own attestation.
4. Anyone holding an old STH can later prove they saw the log at a particular size — and if the log operator ever publishes a smaller or inconsistent tree, the witness signatures expose the fraud.

This was designed for a problem AEGIS shares: *the entity running the log might be compromised, and we want third parties to detect that without trusting the operator*. Applied to AI agents: the team running AEGIS (or even the team's compromised employee) cannot quietly delete the audit entry for a $50,000 mistaken transfer. The Merkle root for that day was already co-signed by an external witness.

## How does AEGIS build the Merkle tree?

Every tool-call decision becomes a leaf:

```typescript
// packages/gateway-mcp/src/audit/leaf.ts (simplified)
function leafHash(decision: AgentDecision): Buffer {
  const canonical = canonicalize(decision);   // RFC 8785 JSON canonicalisation
  return sha256(Buffer.concat([Buffer.from([0x00]), canonical]));
  //                              ^ leaf prefix per RFC 6962 §2.1
}
```

Leaves are batched every minute (configurable). The batch is hashed into a Merkle tree where each internal node is `SHA-256(0x01 || left || right)` per RFC 6962 §2.1. The new tree root is the *signed tree head* — `SHA-256` of the root concatenated with the batch timestamp, signed with an Ed25519 key held in AEGIS's HSM (or in a `tauri-plugin-stronghold` keystore on self-host).

Every signed root is appended to a public-readable log file. Anyone can fetch `https://witness.aegistraces.com/log/<batch-id>` and verify the signature.

## What does the witness co-signature add?

A signed tree head signed by *us* alone is worth almost nothing — if our key is stolen, the attacker can forge any tree head. The witness model fixes this:

1. Once an hour, an independent witness service downloads the latest STH.
2. The witness verifies the tree is consistent with the previous STH (an old leaf still hashes the same way) by fetching a *consistency proof* from AEGIS.
3. If consistent, the witness re-signs the STH with its own key and publishes its attestation.
4. To rewrite history, an attacker must compromise both our key *and* every witness.

The economic security argument is the same one Certificate Transparency uses: a single compromise is bad; a coordinated compromise of N independent organisations is nearly impossible. AEGIS hosts the first witness; we encourage customers to run their own (or designate trusted third parties — auditors, regulators, design partners) to run additional witnesses.

The cost is real but small: one HTTP round-trip per hour, a signature, a log append. ~50 KB/day disk per witness.

## What about the leaves themselves — what's in each entry?

A single AEGIS audit leaf is a canonical JSON blob with these fields:

```json
{
  "v": 1,
  "ts": "2026-06-29T18:43:12.847Z",
  "trace_id": "01HKQ4RWZX5K6E7M9N0PVABY3F",
  "agent_id": "agent-data-pipeline",
  "tool": "stripe_transfer",
  "args_sha256": "a3f2...b819",
  "decision": "ESCALATE",
  "policy_id": "stablecoin-egress-2of2",
  "policy_version_sha256": "7f12...4ab9",
  "approvers": [],
  "latency_ms": 12
}
```

Three load-bearing details:

- **`args_sha256`** instead of raw arguments — we don't put PII / Stripe keys / SSNs in the public log. The hash binds the entry to the arguments without revealing them. The verifier produces a *zero-knowledge-style* proof: "I have an argument blob whose hash is X." For HIPAA / PCI you control whether full arguments go in a *private* log (your DB) while the *hash* goes in the public Merkle log.
- **`policy_version_sha256`** — pins the leaf to the *exact policy text* that decided it. If you later change the policy, the old leaves still verify against the old policy hash. Auditors love this because "what rule was in force at the time" is the most common question they ask.
- **`v: 1`** — protocol version. Lets us add fields (e.g. additional witness signatures) without invalidating old leaves.

## How does this fit with Sigstore and rekor.dev?

Sigstore is the broader ecosystem: a free public certificate authority for code-signing, a public transparency log (`rekor.dev`), and tooling (`cosign`) for verifying signatures. Many open-source projects sign every release artifact through Sigstore.

AEGIS uses Sigstore's `cosign` for **release artifact signing** (the .dmg / .deb / .exe binaries) but **not** for the runtime audit log itself, because the rekor log throughput isn't designed for one entry per agent tool call. Instead:

- **Agent decisions** → AEGIS's own Merkle log (one append per call, ~5k/sec throughput)
- **Release binaries** → Sigstore rekor (one append per release, public verifiability anyone can check)
- **Audit-log batch roots** → optionally also pushed to rekor as a "transparency log of transparency logs" (planned for Q4 2026)

The composition lets you tell an auditor: "Here's the binary we shipped, signed in rekor. Here's the audit log it produced, anchored in our Merkle log. Both are independently verifiable."

## What's the verification flow for an auditor?

Walk through what a SOC 2 Type II auditor actually does:

1. **Auditor**: "Show me every blocked tool call for `agent-coding-asst` in March."
2. **You**: SQL query against your private audit DB → 47 rows.
3. **Auditor**: "How do I know you didn't delete some?"
4. **You**: For each row, generate a Merkle inclusion proof: "Leaf #1234 is in the tree with root `a3f2...b819`, witnessed by `witness.aegistraces.com` on March 14 at 09:00 UTC." The auditor independently fetches the witness's attestation and the public log to verify each proof.
5. **Auditor**: "What if you and the witness colluded?"
6. **You**: Run the verification against a second witness (`witness.usc.edu`, run by Yue Zhao's lab, or any third-party witness you've designated). The proof must verify against every witness.

The auditor's tool to do step 4 is `aegis verify-leaf <trace_id>`. We ship it in the CLI. The audit log is *evidence*, not *trust*.

## Performance — does this make agents slow?

In a word: no.

The runtime path appends an entry to the in-memory buffer and ack's. The Merkle tree, signing, and witness publish happen asynchronously in a background batch process. Inline latency added: < 200 μs (a SHA-256 of a few hundred bytes plus a memcpy).

The full batch process — Merkle root, signature, witness round-trip — runs once a minute and stamps everything in that minute. Worst case latency-to-immutability is 60 seconds; the agent itself is unaffected.

Storage: ~50 bytes per leaf (sha256 + minimal metadata) in the public log; the private DB row is whatever shape you want. A medium agent fleet (10k calls/day) generates ~500 KB/day of public log — trivial.

## What's the threat model this actually defends against?

Be honest about what cryptographic audit *does not* defend against:

| Threat | Defended? |
|---|---|
| Insider deletes/edits old audit rows | ✅ Yes — root mismatch on next verification |
| Compromised DBA edits old audit rows | ✅ Yes — same mechanism |
| Attacker re-runs `aegis-gateway` with modified policy | ✅ Yes — `policy_version_sha256` in each leaf |
| Attacker forges new audit entries that look real | ⚠️ Partially — they'd need the signing key. Use HSM. |
| Attacker compromises both your key + every witness | ❌ Theoretical defeat. This is the same bound as CT. |
| Attacker just turns off the gateway | ❌ No — but then no decisions happen at all; outage is detectable |
| Attacker MITMs the witness HTTP requests | ✅ Yes — witness uses TLS + signature |

The honest summary: **post-hoc tampering is the threat this defends against.** It does not stop a fully-compromised live system from making bad decisions in real time. For that you need Layers 1-3 (policy, sequence anomaly, judge). Cryptographic audit is the *last layer*: when something does go wrong, you have un-fakeable evidence of what happened.

## FAQ

**Is this overkill for an early-stage product?**
Probably yes if you're pre-revenue. We ship it because audit verifiability is the headline feature enterprise buyers (fintech, healthcare) ask about in security review. Building it later is a major refactor.

**Can I use AEGIS without the cryptographic log?**
Yes — set `AEGIS_AUDIT_MODE=plain` and you get a regular SQLite/Postgres audit table without Merkle/witness. Pro+ tiers default to cryptographic.

**Does it slow down LLM judge calls?**
No — auditing is async and adds < 200 μs to the inline tool-call path. The LLM judge itself takes 500-3000 ms; the audit is rounding noise.

**Do I have to host my own witness?**
No — AEGIS runs a default witness at `witness.aegistraces.com`. For Enterprise tier we strongly recommend designating an internal or third-party second witness. Yue Zhao's lab at USC has agreed to host a free academic witness for AEGIS users — DM us if you want to be pointed at it.

**Can I prune old leaves to save storage?**
No, by definition. Once a leaf is in the tree, removing it breaks every inclusion proof for every later leaf. You can *summarise* (snapshot at year boundaries) but you can't *delete*.

---

**See the code** → [github.com/Justin0504/Aegis/tree/main/packages/gateway-mcp/src/audit](https://github.com/Justin0504/Aegis/tree/main/packages/gateway-mcp/src/audit)

**Discuss design choices** → [GitHub Discussions](https://github.com/Justin0504/Aegis/discussions)

**Verify a real audit leaf** → `aegis verify-leaf 01HKQ4RWZX5K6E7M9N0PVABY3F`
