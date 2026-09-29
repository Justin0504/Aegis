"""Reproduce the construction audit of the as-reported benchmark.

    python -m benchmark.audit_construction

Every number in \S3 of the paper is printed by this script. It rebuilds
the corpus with the *pre-fix* InjecAgent loader, because the current
loader no longer produces the artifact being audited --- the fix is in
the repository, so `aegis-bench-asreported.jsonl` on disk is already
post-fix and cannot substantiate F2. The pre-fix loader is recovered
from git rather than vendored, so the reader can check the provenance:

    git show beb7fc5:research/benchmark/loaders/injecagent.py

A note on why this file exists at all. The paper's earlier draft quoted
AUC 0.9944 for the single-feature shortcut and 1.0000 for the 15-feature
model. Neither reproduced when we went back to regenerate them; the
reproducible values are 0.918 and 0.996. The claim is unchanged and the
corrected figures are still damning, but a paper whose thesis is that
unreproducible evaluation numbers mislead has no business carrying
unreproducible numbers of its own.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "benchmark" / "data" / "raw"
PREFIX_COMMIT = "beb7fc5"
LOADER_PATH = "research/benchmark/loaders/injecagent.py"

ROOTS = {
    "injecagent": RAW / "_clone_injecagent" / "data",
    "toolemu": RAW / "toolemu",
    "owasp": RAW / "owasp",
    "aegis_self": RAW / "aegis_self",
}


def _with_prefix_loader():
    """Swap in the pre-fix loader for the duration of the audit.

    Restored in a finally block: leaving the old loader in place would
    silently regenerate the degenerate corpus on the next build, which is
    the failure this whole exercise is about.
    """
    live = ROOT / "benchmark" / "loaders" / "injecagent.py"
    backup = live.read_bytes()
    old = subprocess.run(
        ["git", "-C", str(ROOT.parent), "show", f"{PREFIX_COMMIT}:{LOADER_PATH}"],
        capture_output=True, check=True).stdout
    live.write_bytes(old)
    return live, backup


def build_asreported() -> list:
    from benchmark.loaders.base import all_loaders, get_loader
    recs = []
    for name in all_loaders():
        root = ROOTS.get(name)
        if root is None or not root.exists():
            continue
        ld = get_loader(name, root)
        if not ld.is_available():
            continue
        got = list(ld.iter_records())
        recs += got
        print(f"  {name:12s} {len(got):5d}")
    return recs


def main() -> int:
    live, backup = _with_prefix_loader()
    try:
        for m in [k for k in sys.modules if k.startswith("benchmark.loaders")]:
            del sys.modules[m]
        print("Rebuilding the as-reported corpus with the pre-fix loader:")
        recs = build_asreported()
    finally:
        live.write_bytes(backup)

    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import cross_val_score
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    from cascade.features import BASE_FEATURE_NAMES, encode

    y = np.array([1 if "malicious" in str(r.label).lower() else 0 for r in recs])
    args = [r.tool_call.arguments or {} for r in recs]
    gran = [str(getattr(r, "granularity", "")).lower() for r in recs]

    print(f"\n{'=' * 70}\nCORPUS AS REPORTED\n{'=' * 70}")
    print(f"  records            {len(recs)}")
    print(f"    malicious        {int(y.sum())}")
    print(f"    benign           {int((1 - y).sum())}")

    # ---- F1: records with no arguments to inspect -----------------------
    empty = np.array([len(a) == 0 for a in args])
    print(f"\nF1  no arguments to inspect      {int(empty.sum())} "
          f"({empty.mean():.1%})")
    print(f"      of which malicious          {int((empty & (y == 1)).sum())}")
    print(f"      of which benign             {int((empty & (y == 0)).sum())}")
    print("      a per-call detector reads arguments; these records have none")

    # ---- F2: the label is in the input ----------------------------------
    key = np.array(["_attacker_instruction" in a for a in args])
    print(f"\nF2  _attacker_instruction key")
    print(f"      in malicious                {int((key & (y == 1)).sum())}"
          f"/{int(y.sum())}")
    print(f"      in benign                   {int((key & (y == 0)).sum())}"
          f"/{int((1 - y).sum())}")
    inj = np.array([r.source == "injecagent" for r in recs])
    print(f"      among InjecAgent records    "
          f"{int((key & inj & (y == 1)).sum())}/{int((inj & (y == 1)).sum())} "
          f"malicious, {int((key & inj & (y == 0)).sum())}/"
          f"{int((inj & (y == 0)).sum())} benign")

    chars = np.array([len(json.dumps(a)) for a in args], dtype=float)
    print(f"\n      argument character count alone   "
          f"AUC {roc_auc_score(y, chars):.4f}")
    print(f"        mean chars, malicious          {chars[y == 1].mean():.0f}")
    print(f"        mean chars, benign             {chars[y == 0].mean():.0f}")

    X = np.vstack([encode(r.tool_call).vector for r in recs])
    best, bestname = 0.0, ""
    for i, nm in enumerate(BASE_FEATURE_NAMES):
        col = X[:, i]
        if col.std() == 0:
            continue
        a = roc_auc_score(y, col)
        a = max(a, 1 - a)
        if a > best:
            best, bestname = a, nm
    print(f"      best single surface feature      AUC {best:.4f}  ({bestname})")
    s = cross_val_score(
        make_pipeline(StandardScaler(), GradientBoostingClassifier(n_estimators=100)),
        X, y, cv=5, scoring="roc_auc")
    print(f"      all 15 features, 5-fold CV       AUC {s.mean():.4f} "
          f"+/- {s.std():.4f}")

    # ---- F3: duplication -------------------------------------------------
    def dedup_key(r):
        return (r.tool_call.tool_name,
                json.dumps(r.tool_call.arguments or {}, sort_keys=True),
                str(r.label))

    scoreable = [r for r, e in zip(recs, empty) if not e]
    ys = np.array([1 if "malicious" in str(r.label).lower() else 0
                   for r in scoreable])
    uniq = {dedup_key(r) for r in scoreable}
    print(f"\nF3  duplication among the {len(scoreable)} records that have arguments")
    for lab, v in (("malicious", 1), ("benign", 0)):
        sub = [r for r, t in zip(scoreable, ys) if t == v]
        u = {dedup_key(r) for r in sub}
        print(f"      {lab:10s} {len(sub):5d} -> {len(u):4d} unique "
              f"({1 - len(u) / max(1, len(sub)):5.1%} duplicated)")

    print(f"\n{'=' * 70}\nNET\n{'=' * 70}")
    print(f"  {len(recs):5d}  records as reported")
    print(f"  -{int(empty.sum()):4d}  no arguments to inspect")
    print(f"  -{len(scoreable) - len(uniq):4d}  exact duplicates")
    print(f"  {'':5s}{'-' * 4}")
    print(f"  {len(uniq):5d}  unique evaluable calls")
    nb = len({dedup_key(r) for r, t in zip(scoreable, ys) if t == 0})
    nm = len(uniq) - nb
    print(f"         {nm} malicious, {nb} benign")
    print(f"\n  A benign class of {nb} cannot support the 0.09% false-positive")
    print(f"  rate we previously reported: the smallest non-zero FPR estimable")
    print(f"  from {nb} items is 1/{nb} = {1/nb:.1%}.")

    out = ROOT / "results" / "audit_construction.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "records": len(recs), "malicious": int(y.sum()),
        "benign": int((1 - y).sum()),
        "f1_no_arguments": int(empty.sum()),
        "f2_key_malicious": int((key & (y == 1)).sum()),
        "f2_key_benign": int((key & (y == 0)).sum()),
        "f2_charcount_auc": float(roc_auc_score(y, chars)),
        "f2_best_single_feature_auc": float(best),
        "f2_best_single_feature": bestname,
        "f2_all15_cv_auc": float(s.mean()), "f2_all15_cv_std": float(s.std()),
        "f3_scoreable": len(scoreable), "f3_unique": len(uniq),
        "net_unique_malicious": nm, "net_unique_benign": nb,
    }, indent=1))
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
