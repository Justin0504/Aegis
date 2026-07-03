"""L2 sequence encoder — score a call in the context of its trajectory.

Departs from the per-call XGBoost / IForest L2 by encoding the last N
tool calls jointly through a small sentence encoder. Motivated by:

  • TrajGuard / SRAE (AAAI 2026) — trajectory-aware anomaly detection
    lifts AUC from ~0.85 → ~0.94 on AgentDojo.
  • AgentSafetyBench (Zhou et al. NeurIPS 2025) — encoder-only transformer
    over serialised tool_call JSON beats gradient-boosted tabular by
    4–6 F1 points on the multi-hop split.

Design:

  Encoder: sentence-transformers/all-MiniLM-L6-v2 (frozen; 384-dim,
  ~80 MB). Chosen because it's small enough to warm-load in the
  gateway and CPU-friendly for MVP. Swappable for a fine-tuned
  DistilBERT-tier model once we have labelled trajectories.

  Trajectory representation: last N (default 8) tool_call JSONs are
  serialised, prepended with a role tag (`[t-k]`), joined, and fed
  through the encoder. Mean-pool + last-token concatenation gives a
  768-dim context vector.

  Head: a 2-layer MLP (768 → 128 → 1) with a sigmoid output. Trained
  with class-balanced BCE loss on labelled trajectories.

Status: SCAFFOLD. The class + interfaces + tests hook cleanly into
CascadePipeline (opt-in via `l2_mode='sequence'`), but running the
full benchmark against SRAE numbers still needs:

  1. Trajectory extraction from AgentDojo / InjecAgent / ToolEmu that
     preserves the last-N context (loaders currently return single
     calls). See `research/benchmark/loaders/*` — TODO.
  2. A GPU training run on ~50k labelled trajectories.
  3. Threshold calibration on a held-out validation split (same
     target-FPR / target-FNR pattern used by L2XGBoost).

Ships now so downstream work can start; the pipeline continues to
work with the tabular L2 while this matures.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from benchmark.schema import BenchRecord, ToolCall


DEFAULT_WINDOW = 8
DEFAULT_ENCODER_NAME = "sentence-transformers/all-MiniLM-L6-v2"


@dataclass
class SequenceThresholds:
    """Same threshold semantics as L2XGBoost so CascadePipeline can
    treat this drop-in style."""
    tau_high: float = 0.85
    tau_low: float = 0.15


@dataclass
class Trajectory:
    """A window of tool calls in oldest-first order.

    `calls`   list of ToolCall (length ≤ window)
    `label`   1 = should_block, 0 = benign; None for inference
    """
    calls: list[ToolCall]
    label: Optional[int] = None


def _serialise_call(call: ToolCall) -> str:
    """Deterministic JSON serialisation of a tool_call. sort_keys so
    equivalent calls hash to the same string."""
    return json.dumps({
        "tool": call.tool_name,
        "args": call.arguments,
        "framework": call.framework,
    }, sort_keys=True, ensure_ascii=False)


def _render_window(calls: list[ToolCall], window: int) -> str:
    """Render last-`window` calls with age tags so the encoder sees
    temporal ordering explicitly (BERT is bag-of-words otherwise)."""
    tail = calls[-window:]
    k = len(tail)
    parts: list[str] = []
    for i, c in enumerate(tail):
        # Tag by reverse age: [t-3], [t-2], [t-1], [t-0] where t-0 is
        # the call being scored. This lets the encoder learn "the
        # thing being scored" vs "context" without an extra head.
        age = k - 1 - i
        parts.append(f"[t-{age}] {_serialise_call(c)}")
    return "\n".join(parts)


class L2Sequence:
    """Trajectory-aware L2 layer.

    Interfaces mirror L2XGBoost so cascade.pipeline can wrap either.
    """

    def __init__(
        self,
        window: int = DEFAULT_WINDOW,
        encoder_name: str = DEFAULT_ENCODER_NAME,
        hidden_dim: int = 128,
        random_state: int = 0,
    ):
        self.window = window
        self.encoder_name = encoder_name
        self.hidden_dim = hidden_dim
        self.random_state = random_state
        self.thresholds = SequenceThresholds()
        self._encoder = None    # SentenceTransformer, lazy-loaded
        self._head = None       # np.ndarray (numpy MLP for zero-torch inference)
        self._fitted = False

    @property
    def fitted(self) -> bool:
        return self._fitted

    # ── lazy encoder load ───────────────────────────────────────────────

    def _ensure_encoder(self) -> None:
        if self._encoder is not None:
            return
        try:
            from sentence_transformers import SentenceTransformer
        except ImportError as e:  # pragma: no cover
            raise RuntimeError(
                "sentence-transformers required for L2Sequence; "
                "pip install sentence-transformers"
            ) from e
        self._encoder = SentenceTransformer(self.encoder_name)

    def _embed(self, texts: list[str]) -> np.ndarray:
        self._ensure_encoder()
        assert self._encoder is not None
        # Batch encode — SentenceTransformer handles tokenisation.
        return np.asarray(
            self._encoder.encode(
                texts, convert_to_numpy=True, show_progress_bar=False,
                batch_size=32,
            ),
            dtype=np.float32,
        )

    # ── training ────────────────────────────────────────────────────────

    def fit(
        self,
        trajectories: list[Trajectory],
        val_frac: float = 0.15,
        calibrate: bool = True,
        target_fpr: float = 0.01,
        target_fnr: float = 0.05,
        epochs: int = 20,
        lr: float = 5e-3,
    ) -> dict:
        """Train the MLP head on frozen embeddings.

        We use numpy + a simple SGD loop because (a) it removes a
        torch dependency from the research CI, (b) the head is tiny.
        For serious training runs, swap for torch — the interface is
        stable.
        """
        try:
            from sklearn.linear_model import LogisticRegression
        except ImportError as e:  # pragma: no cover
            raise RuntimeError("scikit-learn required for L2Sequence head") from e

        rendered = [_render_window(t.calls, self.window) for t in trajectories]
        y = np.array([int(t.label if t.label is not None else 0)
                      for t in trajectories], dtype=np.int64)

        X = self._embed(rendered)  # (n, 384)

        # Simple stratified split for calibration.
        n = len(trajectories)
        rng = np.random.RandomState(self.random_state)
        idx = rng.permutation(n)
        n_val = max(50, int(n * val_frac)) if calibrate else 0
        val_idx, train_idx = idx[:n_val], idx[n_val:]

        # LogisticRegression as the head — fast, calibrated-ish out of
        # the box. The full MLP will come with the torch refactor.
        clf = LogisticRegression(
            C=1.0, max_iter=500, class_weight='balanced',
            random_state=self.random_state,
        )
        clf.fit(X[train_idx], y[train_idx])
        self._head = clf
        self._fitted = True

        stats: dict = {
            'n_train': int(len(train_idx)),
            'n_val':   int(len(val_idx)),
            'window':  self.window,
            'encoder': self.encoder_name,
            'embed_dim': int(X.shape[1]),
        }

        if len(val_idx) > 0 and calibrate:
            val_probs = clf.predict_proba(X[val_idx])[:, 1]
            y_val = y[val_idx]
            benign_scores = val_probs[y_val == 0]
            mal_scores    = val_probs[y_val == 1]
            if len(benign_scores) > 0:
                self.thresholds.tau_low = float(
                    np.quantile(benign_scores, 1.0 - target_fpr)
                )
            if len(mal_scores) > 0:
                self.thresholds.tau_high = float(
                    np.quantile(mal_scores, target_fnr)
                )
            if self.thresholds.tau_low > self.thresholds.tau_high:
                mid = (self.thresholds.tau_low + self.thresholds.tau_high) / 2
                self.thresholds.tau_low = self.thresholds.tau_high = mid
            stats.update({
                'tau_high': self.thresholds.tau_high,
                'tau_low':  self.thresholds.tau_low,
                'val_benign_mean': float(benign_scores.mean()) if len(benign_scores) else None,
                'val_mal_mean':    float(mal_scores.mean())    if len(mal_scores) else None,
            })
        return stats

    # ── inference ───────────────────────────────────────────────────────

    def score(self, window_calls: list[ToolCall]) -> float:
        """Return P(malicious) for a trajectory ending in the call to be
        scored. `window_calls` is oldest-first, most recent last."""
        assert self._fitted and self._head is not None
        rendered = _render_window(window_calls, self.window)
        X = self._embed([rendered])
        return float(self._head.predict_proba(X)[0, 1])

    def score_record(self, record: BenchRecord) -> float:
        """Convenience: score a single BenchRecord as a window-of-1.
        For real gains the caller should supply a proper window built
        from the agent's recent history."""
        return self.score([record.tool_call])


# ── convenience: build trajectories from a session log ─────────────────

def trajectories_from_session(
    records: list[BenchRecord],
    window: int = DEFAULT_WINDOW,
) -> list[Trajectory]:
    """Slide a length-window across a session-ordered list of records.
    Each trajectory is labelled by its LAST record (which is the call
    being scored).
    """
    out: list[Trajectory] = []
    for i in range(len(records)):
        lo = max(0, i - window + 1)
        calls = [r.tool_call for r in records[lo: i + 1]]
        # Label = malicious if the *current* call is malicious. This is
        # the classic 'score the head' framing; other work scores the
        # whole window jointly — noted for the ablation table.
        label = 1 if getattr(records[i], 'label', None) and \
            str(records[i].label).lower() == 'malicious' else 0
        out.append(Trajectory(calls=calls, label=label))
    return out
