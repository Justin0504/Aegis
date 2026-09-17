# Reproducing the AEGIS / EMNLP 2026 results

End-to-end commands. Each step is independent and idempotent.

## 0. Environment

```bash
cd research
python -m venv .venv && source .venv/bin/activate
pip install -e .[llm,guard]
```

## 1. Build the benchmark (WS-1)

```bash
# Fetch all public datasets (git + huggingface hints printed if missing)
python -m benchmark.scripts.download_all

# Materialize OWASP and self-suite (no network)
python -m benchmark.scripts.build_owasp_payloads
python -m benchmark.scripts.extract_aegis_self

# Unify into one JSONL
python -m benchmark.build
python -m benchmark.stats
```

## 2. Run baselines (WS-2)

```bash
# Bring up the production gateway for the AEGIS-rules baseline
( cd ../packages/gateway-mcp && node dist/server.js ) &

# Cheap baselines (no API keys needed)
python -m baselines.run --baseline no_defense
python -m baselines.run --baseline keyword_blacklist
python -m baselines.run --baseline aegis_rules

# LLM judges (require keys)
export ANTHROPIC_API_KEY=sk-...
python -m baselines.run --baseline llm_judge_anthropic --model claude-haiku-4-5-20251001
python -m baselines.run --baseline llm_judge_anthropic --model claude-sonnet-4-6
export OPENAI_API_KEY=sk-...
python -m baselines.run --baseline llm_judge_openai --model gpt-4o-mini
python -m baselines.run --baseline llm_judge_openai --model gpt-4o

# Llama-Guard (requires a GPU; on Delta:
#   srun --account=bfsl-delta-gpu --gres=gpu:a100:1 --time=01:00:00 --pty bash )
python -m baselines.run --baseline llama_guard
```

## 3. Run the cascade method (WS-3)

```bash
# Full cascade (L1 + L2 + L3)
python -m cascade.run_cascade \
    --l1 aegis_rules \
    --l3 llm_judge_anthropic --l3-model claude-haiku-4-5-20251001 \
    --tau-high 0.7 --tau-low 0.4

# Ablation: L1 only
python -m cascade.run_cascade --l1 aegis_rules --no-l2 --no-l3 --tag ablate-L1
# L1 + L2
python -m cascade.run_cascade --l1 aegis_rules --no-l3 --tag ablate-L1L2
# L2 + L3 (no rules — shows recall ceiling without cheap layer)
python -m cascade.run_cascade --no-l1 \
    --l3 llm_judge_anthropic --l3-model claude-haiku-4-5-20251001 \
    --tag ablate-L2L3
```

## 4. Adaptive attack (WS-4)

```bash
# Deterministic obfuscation transforms (9 types)
python -m adaptive.obfuscate \
    --in benchmark/data/aegis-bench.jsonl \
    --out benchmark/data/aegis-bench-obfuscated.jsonl

# Re-run any baseline / cascade on the obfuscated set
python -m baselines.run --baseline aegis_rules \
    --in benchmark/data/aegis-bench-obfuscated.jsonl

# LLM red-team loop against a chosen defender
python -m adaptive.red_team \
    --seeds benchmark/data/aegis-bench.jsonl \
    --defender aegis_rules \
    --attacker-model claude-sonnet-4-6 \
    --rounds 5 \
    --out benchmark/data/adaptive-aegis_rules.jsonl
```

## 5. Granularity + sequence (WS-5)

```bash
PYTHONPATH=. python scripts/slice_by_granularity.py \
    --in benchmark/data/aegis-bench.jsonl \
    --out-dir benchmark/data/slices

# Then run any baseline on slice-coarse.jsonl / slice-fine.jsonl

PYTHONPATH=. python scripts/sequence_eval.py \
    --in benchmark/data/aegis-bench.jsonl
```

## 6. Aggregate results into paper tables/figures (WS-6)

```bash
# (To be added) python -m scripts.aggregate_results --out paper-emnlp/figures/
```

---

# The audit line (§3–§6 of the paper)

Sections 1–6 above describe the pipeline as it was **before** the audit.
Its headline numbers were produced on a corpus §3 of the paper shows is
degenerate, and they are withdrawn. Everything below supersedes them.
Steps 7–10 are the reproduction path for the paper as it now stands.

## 7. Reproduce the audit (§3)

The two build variants are the audit. Run both and compare:

```bash
cd research
python -m benchmark.build --keep-duplicates --include-intent-only   # 5,525 records
python -m benchmark.build                                           # 92 unique evaluable
```

The difference decomposes into three independent construction failures:

| | |
|---|---|
| F1 records with no tool call | 3,340 (ToolEmu ships `<intent_only>` cases, empty args) |
| F2 label encoded in the input | `_attacker_instruction` key in 3,196/3,196 malicious, 0/2,108 benign |
| F3 exact duplicates | 2,093 |

F2 is the one that invalidates results rather than merely shrinking the
set. Argument character count alone reaches AUC 0.9944; 15 surface
features reach 1.0000. Any detector scored on that corpus was scored on
a giveaway.

## 8. Rebuild by agent rollout (§4)

Requires an OpenAI-compatible endpoint. We used Qwen3-VL-32B-Instruct
(AWQ 4-bit) on vLLM; `--base-url` takes any equivalent. Tool calls are
prompt-rendered rather than served through the `tools` API, so a server
without `--enable-auto-tool-choice` works.

```bash
# Attack arm: replay every InjecAgent case, record what the model emits
python -m selective.instantiate --base-url http://localhost:8000/v1

# Control arm: identical, injection swapped for length-matched neutral prose
python -m selective.instantiate --control --base-url http://localhost:8000/v1

# Benign arm: legitimate requests over the attacked tools, generated from
# tool schemas alone (the generator is never shown an attack)
python -m selective.benign_arm --base-url http://localhost:8000/v1

# Two-step benign arm: legitimate calls whose arguments also come from a
# tool response. This is the control the provenance results require --
# without it, "was there a tool observation?" separates the classes for a
# construction reason and any provenance number is inflated.
python -m selective.benign_twostep --base-url http://localhost:8000/v1

# Emit the corrected benchmark
python -m selective.emit_instantiated
```

Expected: attack success 95.07% vs 0.285% in control (RR 334, Wilson 95%
CI [94.06, 95.91] and [0.13, 0.62]); final corpus 663 records, 237
malicious / 426 benign; best single surface feature AUC 0.5849; every
attacked tool also appears in the benign class.

## 9. Evaluate detectors on the corrected corpus (§5)

```bash
python -m baselines.run --baseline no_defense        --bench benchmark/data/aegis-bench-instantiated.jsonl
python -m baselines.run --baseline keyword_blacklist --bench benchmark/data/aegis-bench-instantiated.jsonl
python -m baselines.run --baseline aegis_rules       --bench benchmark/data/aegis-bench-instantiated.jsonl

# LLM judge. OPENAI_BASE_URL routes to any OpenAI-compatible endpoint;
# response_format is dropped automatically when it is set.
export OPENAI_BASE_URL=http://localhost:8000/v1 OPENAI_API_KEY=dummy
python -m baselines.llm_judge --bench benchmark/data/aegis-bench-instantiated.jsonl
```

Expected: patterns-only recall 0.4%, `aegis_rules` 84.4% recall at 73.9%
FPR (schema validation, not detection), LLM judge 78.9%/8.7% for
balanced accuracy 0.851 at 2,280 ms P50.

## 10. Provenance (§5–§6)

```bash
python -m selective.taint_eval          # data provenance, both controls
python -m selective.provenance_eval     # instruction provenance + stress tests
```

`taint_eval` prints the honest and inflated numbers side by side (0.7374
vs 0.8498); the difference is the single-step benign arm having no tool
observation at all.

`provenance_eval` prints four blocks. Read them in this order:

1. **Arm B** — grounded instruction provenance 0.9913 ± 0.0085 vs 0.7374
   for taint and 0.6866 for content.
2. **Adaptive attacker** — restating the user's request in the injection
   gains nothing (0.9941); echoing user vocabulary into the call's
   arguments drops it to 0.9329 ± 0.0236. That is the real failure mode.
3. **Generator artifact check** — `user_licence` on InjecAgent's own
   human-written instructions is 0.500, bootstrap 95% CI [0.425, 0.581],
   vs 0.550 schema-generated and 0.040 malicious. n=17; a larger
   human-written control is the obvious next thing to collect.
4. **The definitional pair**, printed but excluded from every claim.
   `imperative_density` and `directive_to_agent` detect "an instruction
   appeared in a data channel", which is what the attack *is*, so they
   cannot corroborate themselves.

### Not yet run: the arm that would falsify the definitional pair

Benign tool output carries imperative text constantly and legitimately —
forwarded email, tickets, documentation. A benign arm containing it is
the test that matters. Protocol is in the `selective/provenance_eval.py`
docstring; the essential constraint is that the label must come from what
the agent *did* (it performed the user's request and ignored the embedded
imperative), never from our intent in writing the prompt. Flows where the
agent follows the embedded text are discarded, not relabelled.

Prediction recorded in advance: the definitional pair collapses toward
chance, `authority_margin` holds. If `authority_margin` also collapses,
the abstraction proposed in §6 is wrong.
