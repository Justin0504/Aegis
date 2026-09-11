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
            "Include records that carry no concrete tool call (InjecAgent and "
            "ToolEmu both ship cases, not instantiated attacker calls). OFF by "
            "default: a per-call detector scores 0%% on them by construction, "
            "so including them deflates every recall number by a constant and "
            "makes cross-source comparisons meaningless. They are always "
            "written to a sidecar file regardless of this flag."
        ),
    )
    parser.add_argument(
        "--keep-duplicates", action="store_true",
        help=(
            "Keep byte-identical (tool_name, arguments, label) records. OFF by "
            "default. Upstream sources reuse the same attacker instruction "
            "across many cases: 3,196 InjecAgent malicious records collapse to "
            "94 unique tool calls (97.1%% duplicated) and 2,108 benign to 17 "
            "(99.2%%). Reporting n=5,381 when the effective sample is 186 "
            "overstates statistical power by ~29x and lets a detector that "
            "memorises one attack look like it generalises."
        ),
    )
    args = parser.parse_args()

    args.out.parent.mkdir(parents=True, exist_ok=True)
    intent_out = args.out.with_name(args.out.stem + "-intent.jsonl")

    written = 0
    per_source: dict[str, int] = {}
    quarantined: dict[str, int] = {}
    deduped: dict[str, int] = {}
    skipped: list[str] = []
    seen: set[tuple] = set()

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

                if not args.keep_duplicates:
                    sig = (
                        rec.tool_call.tool_name,
                        json.dumps(rec.tool_call.arguments, sort_keys=True),
                        rec.label,
                    )
                    if sig in seen:
                        deduped[name] = deduped.get(name, 0) + 1
                        continue
                    seen.add(sig)

                out.write(rec.model_dump_json() + "\n")
                count += 1
            per_source[name] = count
            written += count

    print(f"Wrote {written} evaluable records to {args.out}")
    for name, n in sorted(per_source.items()):
        print(f"  {name:>14}  {n:>7}")

    if deduped:
        total_d = sum(deduped.values())
        print(f"\nDuplicate records dropped: {total_d}")
        for name, n in sorted(deduped.items()):
            print(f"  {name:>14}  {n:>7}")
        print("  Identical (tool_name, arguments, label). Pass --keep-duplicates\n"
              "  to retain them, but do not report the inflated n as sample size.")

    if quarantined:
        total_q = sum(quarantined.values())
        state = "INCLUDED (--include-intent-only)" if args.include_intent_only else "EXCLUDED"
        print(f"\nIntent-only records [{state}] -> {intent_out}")
        for name, n in sorted(quarantined.items()):
            print(f"  {name:>14}  {n:>7}")
        print(
            f"  {'TOTAL':>14}  {total_q:>7}\n"
            "  These carry no tool_call arguments because the upstream source\n"
            "  never instantiated the attacker's call. Per-call detectors score\n"
            "  0% on them by construction; evaluate them with a conversation-\n"
            "  level judge instead, and report that separately."
        )

    if skipped:
        print("\nSkipped (raw data not present):")
        for s in skipped:
            print(f"  - {s}")
        print("\nRun `python -m benchmark.scripts.download_all` to fetch them.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
