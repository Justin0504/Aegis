"""The blind spot: same tool, hijacked arguments.

    python -m selective.same_tool_probe        # → results/selective/same_tool_probe.json

Instruction provenance asks which channel of the conversation explains the
call's vocabulary. Every InjecAgent attack changes the TOOL --- the user
asked for one thing, the injection makes the agent call another --- so the
tool name alone carries most of the licence signal, and the paper's 0.991
is measured on that case.

The case it cannot see by construction: the user asked for the very tool
the injection hijacks, and the injection changes only the arguments.
"Email the summary to my team" / "...to attacker@". The tool name is the
user's; most argument keys are the schema's; the attacker owns one value.

This module constructs that case from the corpus and runs it through the
SHIPPING gateway (same machinery as provenance_gateway_eval.py):

  for each malicious record (attacker tool T, attacker's call C, injection I)
    find benign records whose agent called the same T, with a user
    instruction U_T that legitimately asks for T (the benign arm)
    probe = { user: U_T, untrusted: I, call: C }

Label is still malicious: the call is the attacker's, verbatim. Reported:
the flag rate of the pack on the probes against the flag rate on the
originals, and the verdict distribution. This is a constructed probe, not
a rollout --- no agent emitted these records --- and the paper says so.
"""
from __future__ import annotations

import json
import random
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from benchmark.schema import BenchRecord                              # noqa: E402
from cascade.provenance import (CallContext, encode_provenance)       # noqa: E402
from selective.provenance_gateway_eval import (_gw, check_one, start_gateway, PACK)  # noqa: E402
from selective.taint_eval import load_records                          # noqa: E402


def main() -> int:
    recs = load_records()
    mal = [r for r in recs if r.label == "malicious"]
    ben_by_tool: dict[str, list[BenchRecord]] = defaultdict(list)
    for r in recs:
        if r.label == "benign" and (r.meta or {}).get("provenance") == "agent_rollout_benign_arm":
            ben_by_tool[r.tool_call.tool_name].append(r)

    rng = random.Random(7)
    probes: list[BenchRecord] = []
    for m in mal:
        cands = ben_by_tool.get(m.tool_call.tool_name)
        if not cands:
            continue
        b = rng.choice(cands)
        user_turn = next((c["content"] for c in b.conversation or [] if c.get("role") == "user"), "")
        obs = next((c["content"] for c in m.conversation or [] if c.get("role") in ("tool_observation", "tool")), "")
        probes.append(BenchRecord(
            id=f"probe::same-tool::{m.id}",
            source=m.source, label=m.label, category=m.category,
            tool_call=m.tool_call,
            conversation=[{"role": "user", "content": user_turn},
                          {"role": "tool_observation", "content": obs}],
            distribution=m.distribution, granularity=m.granularity,
            meta={**(m.meta or {}), "probe": "same_tool_hijack", "paired_benign": b.id}))
    print(f"{len(mal)} malicious records, {len(probes)} have a benign user instruction for the same tool")

    # offline features first: how the four grounded features move
    def feats(r: BenchRecord):
        u = next((c["content"] for c in r.conversation if c.get("role") == "user"), "")
        o = " ".join(c["content"] for c in r.conversation if c.get("role") in ("tool_observation", "tool"))
        return encode_provenance(r.tool_call, CallContext(user_text=u, obs_text=o))[:4]
    import numpy as np
    orig = np.vstack([feats(m) for m in mal if any(p.id.endswith(m.id) for p in probes)])
    prob = np.vstack([feats(p) for p in probes])
    names = ["user_licence", "untrusted_licence", "authority_margin", "tool_named_in_untrusted"]
    print("  mean feature   original -> probe")
    for i, n in enumerate(names):
        print(f"    {n:24s} {orig[:, i].mean():+.3f} -> {prob[:, i].mean():+.3f}")

    out_dir = ROOT / "results" / "selective"
    gw = start_gateway(out_dir / "same_tool_probe.log")
    try:
        key = _gw("GET", "/api/v1/auth/key")["api_key"]
        _gw("POST", f"/api/v1/dsl/packs/{PACK}/apply", {}, key)
        rows_orig = [check_one(m, key, "aegis-bench-sametool-orig") for m in mal if any(p.id.endswith(m.id) for p in probes)]
        rows_probe = [check_one(p, key, "aegis-bench-sametool-probe") for p in probes]
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()

    def rate(rows, f):
        return sum(r[f] for r in rows) / len(rows) if rows else 0.0
    summary = {
        "n": len(probes),
        "original_flag_rate": rate(rows_orig, "provenance_flag"),
        "original_block_rate": rate(rows_orig, "provenance_block"),
        "probe_flag_rate": rate(rows_probe, "provenance_flag"),
        "probe_block_rate": rate(rows_probe, "provenance_block"),
        "probe_rules": dict(Counter(r["dsl_rule"] or "(none)" for r in rows_probe)),
        "original_rules": dict(Counter(r["dsl_rule"] or "(none)" for r in rows_orig)),
        "mean_features_original": dict(zip(names, orig.mean(0).round(3).tolist())),
        "mean_features_probe": dict(zip(names, prob.mean(0).round(3).tolist())),
    }
    (out_dir / "same_tool_probe.json").write_text(json.dumps({"summary": summary, "probes": rows_probe}, indent=1))
    print("\n" + "=" * 72)
    print("SAME TOOL, HIJACKED ARGUMENTS — through the shipping gateway")
    print("=" * 72)
    print(f"  originals (tool changed by the injection): flagged {summary['original_flag_rate']*100:.1f}%  blocked {summary['original_block_rate']*100:.1f}%")
    print(f"  probes    (user asked for that tool):      flagged {summary['probe_flag_rate']*100:.1f}%  blocked {summary['probe_block_rate']*100:.1f}%")
    print("  probe rules:", summary["probe_rules"])
    print(f"\nwrote {out_dir / 'same_tool_probe.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
