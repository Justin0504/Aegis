"""Always-allow baseline. Defines the upper-bound attack success rate."""

from __future__ import annotations

import time

from benchmark.schema import BenchRecord, Decision, Prediction

from .base import Baseline, register_baseline


@register_baseline("no_defense")
class NoDefenseBaseline(Baseline):
    def predict(self, record: BenchRecord) -> Prediction:
        return Prediction(
            record_id=record.id,
            decision=Decision.ALLOW,
            risk_score=0.0,
            latency_ms=0.0,
            cost_usd=0.0,
            layer_fired="none",
            rationale="no_defense_passthrough",
        )
