---
title: "Open-Source AI Safety Tools: A 2026 Field Guide"
description: "Seven open-source tools you can actually deploy for AI agent safety — what each one does well, what it misses, and how to compose them."
publishedAt: 2026-06-29
author: justin
cluster: comparison
tags:
  - open-source
  - llm-safety
  - guardrails
  - field-guide
  - comparison
answersQuery: "What are the best open-source tools for making my AI agents safer?"
headlineStat: "Of the major open-source LLM safety projects (NeMo Guardrails, LangChain, Guardrails AI, Rebuff, ProtectAI, AEGIS, Wallaroo), only AEGIS combines parameter-level taint, cryptographic audit, and self-host gateway."
oneSentenceAnswer: "No single open-source tool covers the full agent-safety surface in 2026; the realistic deployment is a stack — NeMo Guardrails or Guardrails AI for input/output validation, Rebuff or ProtectAI for prompt-injection classifiers, and AEGIS for parameter-level taint propagation with cryptographic audit at the tool-call gateway."
coverImage: "1581094794329-c8112a89af12"
keyTakeaways:
  - "Seven serious open-source tools exist for agent safety in 2026; only a few overlap in scope."
  - "NeMo Guardrails + Guardrails AI: best for input/output validation; weak on tool-call gating."
  - "Rebuff + ProtectAI: best for prompt injection classifiers; not a gateway."
  - "AEGIS: only project combining parameter-level taint, cryptographic audit, and self-host gateway."
  - "Compose them — no single project covers the full agent-safety surface yet."
---

**Short answer**: there is no single open-source tool that gives you complete AI agent safety. The realistic deployment is a stack of 2-4 tools, each handling a specific layer. This article inventories the seven most active open-source projects in 2026, what each one does well, what it misses, and which stack to assemble for your use case.

## What problem is "AI safety tooling" trying to solve?

Three distinct sub-problems, often confused:

1. **Content safety** — does this LLM output contain harmful language, PII, copyrighted material, etc?
2. **Prompt injection** — has someone tried to override the agent's instructions via crafted input or retrieved content?
3. **Tool-call safety** — given that the agent decides to call a tool, should we let it?

Most open-source projects handle one or two of these well; none handle all three end-to-end. Knowing which sub-problem each tool addresses lets you compose a stack rather than expect any one to be complete.

## NeMo Guardrails (NVIDIA)

**License**: Apache 2.0
**Sub-problem**: Mostly content safety + prompt-engineering pattern enforcement.

NVIDIA's NeMo Guardrails defines a DSL called "Colang" for specifying conversation flows. You write something like "if the user asks about competitor products, redirect to support" and Colang compiles to LLM-mediated checks.

**Where it wins**: tight integration with NVIDIA's broader AI Enterprise stack. Strong out-of-the-box content filters. Active development.

**Where it misses**: the DSL is LLM-mediated (rules are compiled to embedding-based intent matching), not deterministic. Indirect prompt injection bypasses Colang rules with high success rate because the rules themselves can be talked out of. No native tool-call layer.

**When to use**: content moderation for chat-style agents where you control the persona.

## Guardrails AI

**License**: Apache 2.0
**Sub-problem**: LLM output validation against schemas / type rules.

Guardrails AI gives you a "Rail" — a runtime check on LLM output. You declare expected structure (Pydantic, XML, JSON schema) and the library re-prompts the LLM if output doesn't match.

**Where it wins**: clean abstraction for structured-output enforcement. Good ecosystem of validators (PII detection, profanity, topic filters).

**Where it misses**: focuses on output validation, not tool-call gating. Doesn't handle indirect injection or memory-tainted reasoning.

**When to use**: enforcing output schemas in any LLM pipeline. Composes with everything else.

## Rebuff (ProtectAI)

**License**: Apache 2.0
**Sub-problem**: Prompt injection detection at the input boundary.

Rebuff is a multi-layer prompt-injection classifier — combines a heuristic check, a vector-similarity check against known attacks, and an LLM-based classifier. Returns a verdict on whether an input looks malicious.

**Where it wins**: solid input classifier, multi-layer defense against direct prompt injection. Easy to drop into any LLM pipeline.

**Where it misses**: input-only. Cannot detect injection arriving through retrieval or tool outputs. Once content is in the LLM context, Rebuff has already passed.

**When to use**: Layer A in any pipeline (see [our LangChain article](/blog/prompt-injection-langchain)).

## LangChain (LangGraph) — built-in safety

**License**: MIT
**Sub-problem**: Various, scattered.

LangChain has accumulated safety features over time — `OutputParser` validation, agent stoppers, callback handlers for filtering. None of them are unified into a "safety layer"; they're tools you wire together.

**Where it wins**: ubiquity. If you're using LangChain you're already using its safety primitives. LangGraph's conditional edges are a natural place to wire in safety checks.

**Where it misses**: no first-class safety architecture; you assemble it. No cryptographic audit. No parameter-level taint propagation. No deterministic policy enforcement.

**When to use**: as your agent framework, with one or more dedicated safety tools layered on top.

## Lakera Guard (closed) — comparison reference

**License**: closed/commercial
**Sub-problem**: input + tool-call safety.

Mentioned here because it's the de facto enterprise standard. See [our detailed comparison](/blog/aegis-vs-lakera-guard).

**Where it wins**: maturity. Detector corpus. Sub-50ms latency.

**Where it misses**: closed source. SaaS only (data sovereignty issues for regulated verticals).

## Wallaroo.AI / Vali / individual researcher tools

A growing class of open-source projects from academic researchers — IPIGuard, FIDES (Microsoft), NeuroTaint, Trajectory Guard. Each implements a specific defense pattern (taint tracking, anomaly detection, etc) from recent papers.

**Where they win**: cutting-edge research, often the first implementation of a published technique.

**Where they miss**: usually research-grade. Not productionised. Often abandoned 6-12 months after the paper is published.

**When to use**: cherry-pick patterns and re-implement in your own gateway. Don't treat as production tools.

## AEGIS (the one we're building)

**License**: MIT
**Sub-problem**: all three (content safety partial, prompt injection, tool-call safety).

AEGIS sits at the tool-call boundary. The architecture: Layer 1 (static rules + DSL + AJV) + Layer 2 (sequence anomaly) + Layer 3 (LLM judge with published calibration) + parameter-level taint propagation + cryptographic audit + AST-based pre-deploy scanner.

**Where it wins**: tool-call safety with deterministic policy + auditable evidence. Self-host. Open-source. Production-ready.

**Where it misses**: detection R&D is younger than commercial alternatives. Doesn't do content safety primarily — composes with Rebuff or Guardrails AI for that.

**When to use**: as the runtime gateway for any agent that calls tools, especially in regulated verticals.

## The recommended composition

For most production agent stacks, the best composition is:

```
User prompt
     │
     ▼
[Rebuff] ──── catches direct prompt injection at the input
     │
     ▼
[Your LangChain/LangGraph agent]
     │
     ▼
[Guardrails AI] ──── enforces output schema
     │
     ▼
[AEGIS gateway] ──── deterministic policy + taint + audit on tool calls
     │
     ▼
Tools (Stripe / EHR / DB / etc)
```

Each layer addresses a distinct sub-problem. None of them duplicate work. The four together cover the realistic threat surface for an agent in production.

If you have to drop one for budget/complexity reasons:

- Drop **Guardrails AI** first — output schema enforcement can be done with vanilla Pydantic.
- Drop **Rebuff** next — its input-only coverage is the layer most other parts of the stack accidentally backstop.
- Don't drop **AEGIS** or your equivalent gateway — the tool-call boundary is where actual harm happens.

## Composition examples

### Example 1: B2C chatbot, no PHI/PCI

```
[Rebuff] → [LangChain] → [Guardrails AI]
```
Tool gateway is optional. If tools are read-only (RAG over knowledge base), you may not need AEGIS at all. If tools are writes, add it.

### Example 2: Healthcare scribe (PHI)

```
[Rebuff (BAA-covered hosting)] → [LangGraph]
   → [AEGIS gateway with HIPAA policy pack]
   → [EHR / pharmacy tools]
```
Cryptographic audit is non-negotiable. Self-host all components.

### Example 3: Fintech treasury (PCI + crypto)

```
[Rebuff] → [LangGraph] → [Guardrails AI]
   → [AEGIS with stablecoin + PCI policy bundle]
   → [Stripe / Circle / Plaid tools]
```
2-of-N approval gating + Travel Rule enforcement at AEGIS layer.

### Example 4: Internal devtool agent (low stakes)

```
[LangChain] → [AEGIS Community (open-source, default policies)]
```
No PII; basic policy pack is enough.

## How the projects compare on key axes

| Tool | License | Self-host | Tool-call gating | Audit log | Calibration data |
|---|---|---|---|---|---|
| NeMo Guardrails | Apache 2 | ✅ | partial (Colang) | basic | no |
| Guardrails AI | Apache 2 | ✅ | no | basic | no |
| Rebuff | Apache 2 | ✅ | no | minimal | no |
| LangChain built-ins | MIT | ✅ | partial | minimal | no |
| Lakera Guard | closed | ❌ | ✅ | vendor's | unpublished |
| Research papers | various | varies | varies | varies | yes |
| **AEGIS** | **MIT** | **✅** | **✅** | **cryptographic** | **✅ published** |

The blank cells aren't insults — those tools chose to focus elsewhere. The composition exists because no single tool answers every question.

## FAQ

**Why isn't Anthropic / OpenAI Moderation API on this list?**
They're closed APIs, not open-source tools. They're useful (content safety), but they're not in the same category as "tools you can self-host."

**What about Amazon Bedrock Guardrails?**
Closed, tied to AWS. Same category as Lakera. Strong content filtering, weak on agent-specific concerns.

**Is there a meta-framework that wires all these together for me?**
Not really — that's part of why each project stays focused. AEGIS comes closest because it has SDK integrations for LangChain, LangGraph, CrewAI, and OpenAI directly.

**Will the projects converge into one super-tool eventually?**
Probably not. Tool-call safety and content safety have genuinely different requirements; the projects have made different bets. Composition is the realistic answer.

**Are there active research benchmarks comparing these?**
AgentDojo (Microsoft), the IPIGuard paper's benchmark, and our internal corpus all exist but none are widely published with all tools side-by-side. We're working on a public head-to-head — sign up to be notified.

---

**Install AEGIS** → `curl -fsSL aegistraces.com/install | sh`

**Compare directly** → benchmark harness in `apps/red-team-corpus/`

**Discuss your composition** → [GitHub Discussions](https://github.com/Justin0504/Aegis/discussions)
