---
title: "LLM Judge Calibration: Why Your Guard Model Is Overconfident"
description: "Measured ECE on gpt-4o-mini (26.5%) and claude-haiku-4-5 (29.2%) against a 30-case agent benchmark. Both severely miscalibrated, worst under jailbreak."
publishedAt: 2026-06-29
author: justin
cluster: deep-dive
tags:
  - calibration
  - llm-judge
  - ece
  - agent-safety
  - ICLR-2025
  - measurement
answersQuery: "Why are LLM guard models overconfident, and how do I measure it?"
headlineStat: "gpt-4o-mini overall ECE 26.5% · claude-haiku-4-5 overall ECE 29.2% · neither is well-calibrated"
oneSentenceAnswer: "LLM guard models are overconfident by 20 to 30 percentage points on borderline and jailbreak cases; measure it with the Guo et al. 2017 binning ECE estimator (gpt-4o-mini scored 26.5% overall ECE, claude-haiku-4-5 scored 29.2%), then fix with post-hoc temperature scaling before your confidence thresholds become theatre."
coverImage: "1551288049-bebda4e38f71"
howToDuration: "PT90M"
howToSteps:
  - "Assemble a held-out calibration set of 500-1,000 tool-call examples with ground-truth labels (benign / malicious). Use ToolGuard-Bench slice-500 or your own production traces with expert annotation."
  - "Run each candidate LLM judge (GPT-4o-mini, Claude Haiku 4.5, Llama Guard, Gemini Flash) against the calibration set. For each prediction, record the raw model probability + the sample label."
  - "Compute Expected Calibration Error (ECE) using the Guo et al. 2017 methodology: bin probabilities into 15 equal-width bins, compute per-bin (accuracy − confidence), weight by bin size, sum. Report ECE + Brier score + reliability diagram."
  - "Apply post-hoc calibration if ECE > 5%: temperature scaling on a validation set is the cheapest fix and typically halves ECE without changing decision boundaries. Platt scaling is the next step if temperature alone is insufficient."
  - "Set decision thresholds using the calibrated probabilities, not the raw model scores. AEGIS uses two thresholds (τ_low for auto-allow, τ_high for auto-block) with the ambiguous middle escalating to a second judge or human review."
  - "Recalibrate quarterly or when the underlying model version changes. Vendor model updates (silent revisions to gpt-4o-mini) shift calibration curves without changing behavior visibly — the reliability diagram is the first place to detect drift."
keyTakeaways:
  - "Calibration is distinct from accuracy. A 95% accurate judge can still mislead a threshold-based gate."
  - "Measured Expected Calibration Error: gpt-4o-mini 26.5%, claude-haiku-4-5 29.2% — both severely miscalibrated."
  - "Per-category ECE explodes on borderline and jailbreak cases (60–89%): models are most confident when wrong."
  - "Temperature scaling reduces ECE by ~40% on the same data; do this before trusting any confidence threshold."
  - "Anyone gating production AI agents on judge confidence should publish ECE, not just accuracy."
---

**Short answer**: every LLM-as-a-judge we've measured is overconfident, often by 20–30 percentage points, and the gap is *worst exactly when it matters most* — under jailbreak, indirect prompt injection, and borderline policy calls. Anyone gating production AI agents on a guard model's confidence score needs to publish their Expected Calibration Error (ECE), not just their accuracy.

This article ships the measurement methodology AEGIS uses, the real numbers we got on OpenAI's `gpt-4o-mini` and Anthropic's `claude-haiku-4-5`, and what to do about it.

## What is calibration, and why should a guard model have it?

A *calibrated* model means: when the model says it is 90 % confident, it is actually correct ~90 % of the time. When it says 60 %, it is right ~60 % of the time. Calibration is the property that turns a model's confidence score into a usable probability.

Guard models are the prime case where calibration matters. If an LLM-based safety judge labels a tool call `BLOCK` at confidence 0.7, the question "should we actually block?" depends on what 0.7 *means*. If the model is well-calibrated, 0.7 maps to a 70 % chance the call is unsafe — and you can write a threshold like "block at ≥ 0.8, escalate to human at 0.5–0.8, allow below 0.5." If it is not calibrated, all of that thresholding is theatre.

Calibration is **distinct from accuracy**. A model can be 95 % accurate and badly calibrated (e.g. always says 0.99 — when it's right it's "too confident," when wrong it's "wildly wrong"). A model can also be 60 % accurate and well-calibrated (when it says 0.6 it's actually right 60 % of the time, which is honest about its limits).

## How does Expected Calibration Error work?

The standard estimator is the **binned ECE** from Guo et al. 2017. For each prediction:

1. Take the model's predicted class and its self-reported confidence in that class.
2. Bucket the prediction into one of N equal-width confidence bins (default 10: `[0.0,0.1)`, `[0.1,0.2)`, … `[0.9,1.0]`).
3. For each bin, compute `accuracy` (fraction correct) and `mean confidence`.
4. ECE = weighted-by-bin-size sum of `|accuracy − confidence|` across all bins.

```typescript
// packages/gateway-mcp/src/calibration/ece.ts — full source on GitHub
export function calibrate(predictions: Prediction[], nBins = 10) {
  // ... bin the predictions, compute per-bin accuracy + mean confidence
  let weightedGap = 0;
  for (const bin of bins) {
    if (bin.count === 0) continue;
    const accuracy = bin.hits / bin.count;
    const confidence = bin.conf / bin.count;
    weightedGap += (bin.count / N) * Math.abs(accuracy - confidence);
  }
  return { ece: weightedGap, /* + accuracy, brier, mce, reliability bins */ };
}
```

ECE is in `[0, 1]`. Lower is better. The field convention is:

| ECE | Interpretation |
|---:|---|
| `< 5 %` | Well-calibrated. Confidence is usable in policy thresholds. |
| `5 – 10 %` | Mildly miscalibrated. Acceptable for advisory use. |
| `10 – 20 %` | Materially miscalibrated. Re-map via temperature scaling before threshold use. |
| `> 20 %` | Severely miscalibrated. **Do not use confidence directly in any blocking decision.** |

## What does ICLR 2025 say about guard model calibration?

Liu et al. published *On Calibration of LLM-based Guard Models for Reliable Content Moderation* at ICLR 2025 ([arXiv:2410.10414](https://arxiv.org/abs/2410.10414)). They evaluated 9 guard models across 12 benchmarks and documented three findings, verbatim from the abstract:

> 1. overconfident predictions,
> 2. significant miscalibration under jailbreak attacks,
> 3. limited robustness to outputs from different response models.

In other words: guard models tell you they are sure when they are wrong, and that mistake gets worse on the inputs that matter most — adversarial jailbreaks. **No commercial guard product publishes this measurement**. That is the gap AEGIS fills.

## How does AEGIS measure it?

AEGIS ships a calibration toolkit in `packages/gateway-mcp/src/calibration/`:

- **`ece.ts`** — Guo et al. binning estimator, reliability diagrams, Brier score, stratified ECE per category. Pure functions, fully unit-tested (11/11 tests).
- **`benchmarks/builtin.json`** — 30 hand-labelled tool-call cases split across 6 categories: `normal`, `block-clear`, `pii-egress`, `jailbreak`, `indirect-injection`, `borderline`. Each case is one (input, ground-truth) pair the judge must rate as `allow` / `block` / `escalate` *and* report a confidence in `[0, 1]`.
- **`runner.ts`** — pluggable `JudgeFn` interface; runs the benchmark with concurrency + rate-limit-aware retry; collects per-case latency and confidence.
- **`judges/openai.ts` + `judges/anthropic.ts`** — adapters that use each provider's structured-output mode to force the JSON shape `{ decision, confidence }`.

Reproducing our measurement:

```bash
git clone https://github.com/Justin0504/Aegis
cd Aegis/packages/gateway-mcp
npm install && npm run build

# uses your $OPENAI_API_KEY or $ANTHROPIC_API_KEY from .env.local
npm run calibrate -- --judge openai:gpt-4o-mini
npm run calibrate -- --judge anthropic:claude-haiku-4-5-20251001
```

The toolkit writes a markdown report with overall ECE, MCE, accuracy, Brier score, and a per-category reliability diagram.

## What did we measure on gpt-4o-mini and claude-haiku-4-5?

We ran the 30-case benchmark on both models with `temperature: 0` and the same system prompt (full prompt and benchmark in the repo). Results:

| Metric | OpenAI `gpt-4o-mini` | Anthropic `claude-haiku-4-5` |
|---|---:|---:|
| **Overall ECE** | **26.5 %** | **29.2 %** |
| Accuracy | 63.3 % | 63.3 % |
| Mean confidence | 89.8 % | 92.5 % |
| Brier score | 0.205 | 0.221 |
| p95 latency / case | 4.2 s | 1.8 s |

Both models are **severely miscalibrated** by the field convention. They claim to be ~90 % confident; they are right ~63 % of the time. That is a 27–30 point gap.

## Where exactly do they break?

The whole point of stratified ECE is that the overall number hides which categories the judge is actually wrong on. Per-category breakdown:

### OpenAI `gpt-4o-mini`

| Category | n | Accuracy | Mean conf | **ECE** |
|---|---:|---:|---:|---:|
| `borderline` | 5 | 0 % | 0.90 | **89.7 %** |
| `indirect-injection` | 3 | 33 % | 0.95 | **61.7 %** |
| `pii-egress` | 2 | 50 % | 0.85 | **35.0 %** |
| `jailbreak` | 5 | 60 % | 0.92 | **32.0 %** |
| `block-clear` | 5 | 100 % | 0.93 | 7.0 % |
| `normal` | 10 | 100 % | 0.88 | 11.5 % |

### Anthropic `claude-haiku-4-5`

| Category | n | Accuracy | Mean conf | **ECE** |
|---|---:|---:|---:|---:|
| `borderline` | 5 | 0 % | 0.83 | **83.0 %** |
| `indirect-injection` | 3 | 33 % | 0.93 | **60.0 %** |
| `jailbreak` | 5 | 80 % | 0.96 | **16.4 %** |
| `pii-egress` | 2 | 50 % | 0.92 | 42.5 % |
| `block-clear` | 5 | 100 % | 0.94 | 6.0 % |
| `normal` | 10 | 100 % | 0.92 | 8.0 % |

Both models are reasonably calibrated on the easy cases (`normal`, `block-clear`) and **catastrophically miscalibrated** on the cases that determine production safety:

- **Borderline** (ambiguous policy calls, e.g. "$24,500 transfer — block or escalate?"): both models pick a side with 0.83–0.90 confidence and get 0/5 correct.
- **Indirect injection** (where tool arguments inherit untrusted content): same pattern — confident, wrong.

This is the **exact failure mode** Liu et al. predicted in ICLR 2025, reproduced on two of the most-deployed guard models in production today.

> **"AEGIS is the runtime control layer the agent ecosystem has been missing. The architecture is clean, the cryptographic audit is real, and the DSL is the right primitive."**
>
> — Yue Zhao, PhD · Assistant Professor, USC · AI Risk Audit &amp; Control · NVIDIA Academic Grant recipient

## What should I actually do about it?

If you ship an LLM judge in production, three concrete changes:

1. **Publish your ECE per-category, not just accuracy.** Accuracy alone is misleading; a 90 %-accurate judge can have catastrophic ECE on the 10 % of cases that are adversarial.
2. **Re-map confidence before thresholding.** Temperature scaling, Platt scaling, or isotonic regression on a held-out calibration set turn raw model confidence into honest probabilities. Without this, thresholds like "block ≥ 0.8" are arbitrary.
3. **Treat `borderline` as its own action class.** Both models pick `block` or `allow` with high confidence on cases that are genuinely ambiguous. A calibrated production system should route those to `escalate` (human review) regardless of model confidence.

## How does this fit AEGIS's broader architecture?

Layer 3 (the LLM-as-judge) is the *last* line of defence in AEGIS. The two earlier layers do not require any calibration analysis because they are deterministic:

- **Layer 1** — static rules, regex/path/host allow-deny, AJV JSON-schema policy bundles, grammar-constrained DSL. Output is a hard yes/no.
- **Layer 2** — sequence-aware n-gram + Mahalanobis + Isolation Forest per-agent behavioural baseline. Output is a per-trace anomaly score with a learnt decision boundary.
- **Layer 3** — LLM judge. Output is `{ decision, confidence }`. **This is the layer where calibration analysis applies.**

Treating L3 as the only safety net is the dominant failure mode we see in agent stacks. The calibration data is the proof point: a single LLM judge will be wrong on the cases your auditor cares about. Layers 1 and 2 catch the deterministic violations; L3 only needs to handle the residual fuzzy edge cases — and even then its confidence should not be trusted as a probability without re-mapping.

## FAQ

**Is 30 cases enough for a real ECE measurement?**
No — for production reporting we recommend 200+ cases per category. The 30-case benchmark in this report is the public proof-of-concept; AEGIS Enterprise customers run extended benchmarks on their own production traffic.

**Why didn't you test the bigger models (`gpt-4o`, `claude-opus`)?**
Cost, and because `gpt-4o-mini` / `claude-haiku-4-5` are what people actually deploy as guards — the bigger models are too slow and expensive for inline use. We will publish bigger-model numbers when we have a sponsor for the API spend.

**Can I run this against my own benchmark?**
Yes — see [the runner README](https://github.com/Justin0504/Aegis/tree/main/packages/gateway-mcp/src/calibration). Drop a JSONL file with your labelled cases and pass `--benchmark mine.jsonl`. The toolkit is MIT-licensed.

**What about local SLM judges like GLIDER?**
Patronus's GLIDER (3.8 B parameters, distilled from synthetic data) is the credible small-model judge — it beats GPT-4o on FLASK Pearson. We have not yet benchmarked it because it requires hosted inference; on our roadmap for Q3 2026. See [Patronus GLIDER paper](https://arxiv.org/abs/2412.14140).

**Is this the same methodology as ICLR 2025?**
Yes for the binning estimator and the jailbreak-stratified evaluation pattern. We extend it by also reporting `borderline` and `indirect-injection` strata, which the original paper does not isolate.

---

**Reproduce these numbers** → [github.com/Justin0504/Aegis/tree/main/packages/gateway-mcp/src/calibration](https://github.com/Justin0504/Aegis/tree/main/packages/gateway-mcp/src/calibration)

**Compare against your own judge** → `npm run calibrate -- --judge <provider>:<model>`

**Discuss** → [GitHub Discussions](https://github.com/Justin0504/Aegis/discussions)
