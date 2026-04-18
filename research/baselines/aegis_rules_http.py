"""AEGIS-rules-only baseline that calls the production gateway over HTTP.

Assumes `packages/gateway-mcp` is running on AEGIS_GATEWAY_URL (default
http://localhost:8080) with the existing 22-pattern classifier. We hit the
existing /api/v1/check endpoint that the SDK uses in production, so the
measured latency includes the real wire path -- not a synthetic in-process
call.

This keeps the production system as the *exact* "rules" baseline; any
divergence between the paper and the running system is therefore impossible.
"""

from __future__ import annotations

import os
import time
from typing import Any

import requests

from benchmark.schema import BenchRecord, Decision, Prediction

from .base import Baseline, register_baseline

_DEFAULT_URL = os.environ.get("AEGIS_GATEWAY_URL", "http://localhost:8080")
_API_KEY = os.environ.get("AEGIS_API_KEY", "")


@register_baseline("aegis_rules")
class AegisRulesHttpBaseline(Baseline):
    def __init__(self, url: str = _DEFAULT_URL, api_key: str = _API_KEY,
                 timeout: float = 5.0):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self._session = requests.Session()

    def warmup(self) -> None:
        # Fail fast if the gateway is not reachable.
        try:
            r = self._session.get(f"{self.url}/health", timeout=2)
            r.raise_for_status()
        except Exception as e:
            raise RuntimeError(
                f"AEGIS gateway not reachable at {self.url} ({e}). "
                "Start it with `cd packages/gateway-mcp && node dist/server.js`."
            ) from e

    def predict(self, record: BenchRecord) -> Prediction:
        payload: dict[str, Any] = {
            "agent_id": "aegis-bench",
            "tool_name": record.tool_call.tool_name,
            "arguments": record.tool_call.arguments,
            "framework": record.tool_call.framework or "benchmark",
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key

        t0 = time.perf_counter()
        for attempt in range(5):
            resp = self._session.post(
                f"{self.url}/api/v1/check", json=payload, headers=headers,
                timeout=self.timeout,
            )
            if resp.status_code != 429:
                break
            time.sleep(0.1 * (2 ** attempt))
        latency = (time.perf_counter() - t0) * 1000
        resp.raise_for_status()
        body = resp.json()

        decision_str = (body.get("decision") or "allow").lower()
        try:
            decision = Decision(decision_str)
        except ValueError:
            decision = Decision.ALLOW

        signals = body.get("signals") or []
        risk_level = (body.get("risk_level") or "LOW").upper()
        risk_score = {"CRITICAL": 1.0, "HIGH": 0.8, "MEDIUM": 0.5, "LOW": 0.1}.get(risk_level, 0.0)
        return Prediction(
            record_id=record.id,
            decision=decision,
            risk_score=risk_score,
            latency_ms=latency,
            cost_usd=0.0,
            layer_fired="L1" if decision == Decision.BLOCK else "none",
            rationale=body.get("reason") or (",".join(signals) if signals else None),
            raw=body,
        )

    def shutdown(self) -> None:
        self._session.close()
