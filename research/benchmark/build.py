"""Unify per-source loaders into a single canonical JSONL.

Usage:
    python -m benchmark.build                       # build everything available
    python -m benchmark.build --sources injecagent toolbench
    python -m benchmark.build --out data/dev.jsonl  # custom output

The script never silently fabricates data: if a loader's raw root is missing,
it is reported as "skipped" with the path it expected.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .loaders import all_loaders, get_loader
from .schema import Granularity

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
DEFAULT_OUT = ROOT / "data" / "aegis-bench.jsonl"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", nargs="*", default=all_loaders())
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--raw-root", type=Path, default=RAW)
    parser.add_argument(
        "--include-intent-only", action="store_true",
        help=(
            "Include records that carry no concrete tool call (ToolEmu ships "
            "cases, not trajectories). OFF by default: a per-call detector "
            "scores 0%% on them by construction, so including them deflates "
            "every recall number by a constant and makes cross-source "
            "comparisons meaningless. They are always written to a sidecar "
            "file regardless of this flag."
        ),
    )
    args = parser.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    intent_out = args.out.with_name(args.out.stem + "-intent.jsonl")

    written = 0
    per_source: dict[str, int] = {}
    quarantined: dict[str, int] = {}
    skipped: list[str] = []

    with args.out.open("w") as out, intent_out.open("w") as iout:
        for name in args.sources:
            root = args.raw_root / name
            loader = get_loader(name, root)
            if not loader.is_available():
                skipped.append(f"{name} (expected raw at {root})")
                continue
            count = 0
            for rec in loader.iter_records():
                # A record is evaluable by a per-call detector only if it
                # actually carries a tool call to inspect. Two ways it can
                # fail: the loader marked it INTENT, or it has empty args
                # (belt and braces — a future loader could forget the enum).
                is_intent = (
                    rec.granularity == Granularity.INTENT
                    or not rec.tool_call.arguments
                )
                if is_intent:
                    iout.write(rec.model_dump_json() + "\n")
                    quarantined[name] = quarantined.get(name, 0) + 1
                    if not args.include_intent_only:
                        continue
                out.write(rec.model_dump_json() + "\n")
                count += 1
            per_source[name] = count
            written += count

    print(f"Wrote {written} evaluable records to {args.out}")
    for name, n in sorted(per_source.items()):
        print(f"  {name:>14}  {n:>7}")

    if quarantined:
        total_q = sum(quarantined.values())
        state = "INCLUDED (--include-intent-only)" if args.include_intent_only else "EXCLUDED"
        print(f"\nIntent-only records [{state}] -> {intent_out}")
        for name, n in sorted(quarantined.items()):
            print(f"  {name:>14}  {n:>7}")
        print(
            f"  {'TOTAL':>14}  {total_q:>7}\n"
            "  These carry no tool_call arguments. Per-call detectors score 0%\n"
            "  on them by construction; evaluate them with an LLM judge over\n"
            "  the conversation context instead, and report that separately."
        )

    if skipped:
        print("\nSkipped (raw data not present):")
        for s in skipped:
            print(f"  - {s}")
        print("\nRun `python -m benchmark.scripts.download_all` to fetch them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
