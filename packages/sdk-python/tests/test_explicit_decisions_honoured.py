"""An explicit gateway decision is honoured whatever the risk tier.

`block_threshold` (default LOW since 2026-10-26; HIGH before) is a precision control over the
gateway's risk-level verdicts. It was applied before the decision was
read, so a policy hold at risk LOW returned as allow: the tool ran and
the agent never waited. Every S3 row of the compatibility matrix was
measured that way. These tests pin the real entry point, `_check_block`,
with the gateway stubbed at the HTTP boundary.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from agentguard.interceptors.auto import AgentGuardBlockedError, AutoInstrument


def _instrument():
    cfg = SimpleNamespace(gateway_url="http://gw.invalid", session_id=None, agent_id="agent-a",
                          api_key=None, agent_secret=None, agent_token=None, build_artifact=None,
                          source_commit=None, tool_categories={}, environment="DEVELOPMENT",
                          blocking_mode=True, blocking_timeout_ms=3000, fail_open=False, audit_only=False,
                          allow_tools=[], allow_categories=[], block_threshold="HIGH",
                          human_approval_timeout_s=5, poll_interval_s=0.01)
    guard = SimpleNamespace(config=cfg, _agent_uuid="uuid-a", _workflow_stack=[])
    return AutoInstrument(guard)


class _Resp:
    def __init__(self, body): self._b = json.dumps(body).encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _gateway(check_body, decision_body=None):
    """urlopen stub: POST /check → check_body; GET /check/:id/decision → decision_body."""
    calls = []
    def fake(req, timeout=None):
        url = req.full_url
        calls.append(url)
        if url.endswith("/api/v1/check"):
            return _Resp(check_body)
        if url.endswith("/decision"):
            return _Resp(decision_body or {"decision": "allow", "decided_by": "test"})
        raise AssertionError(url)
    return fake, calls


def test_low_risk_hold_is_waited_for_and_resolved():
    inst = _instrument()
    fake, calls = _gateway({"decision": "pending", "risk_level": "LOW", "check_id": "c1", "category": "shell",
                            "dsl": {"rule": "hold-kubectl-delete", "decision": "pending"}})
    with patch("urllib.request.urlopen", fake):
        inst._check_block("run_shell", {"command": "kubectl delete pod x"})
    assert any(u.endswith("/decision") for u in calls), "the SDK must poll for the person's decision"
    sv, approval = inst._pop_decision("run_shell", {"command": "kubectl delete pod x"})
    assert approval == "APPROVED" and sv.passed is True


def test_low_risk_hold_rejected_by_person_raises():
    inst = _instrument()
    fake, _ = _gateway({"decision": "pending", "risk_level": "LOW", "check_id": "c1"}, {"decision": "block"})
    with patch("urllib.request.urlopen", fake), pytest.raises(AgentGuardBlockedError):
        inst._check_block("run_shell", {"command": "kubectl delete pod x"})
    _, approval = inst._pop_decision("run_shell", {"command": "kubectl delete pod x"})
    assert approval == "REJECTED"


def test_low_risk_dsl_block_is_honoured():
    inst = _instrument()
    fake, _ = _gateway({"decision": "block", "risk_level": "LOW", "check_id": "c2", "reason": "operator rule",
                        "dsl": {"rule": "no-email-to-gmail", "decision": "block"}})
    with patch("urllib.request.urlopen", fake), pytest.raises(AgentGuardBlockedError):
        inst._check_block("send_email", {"to": "x@gmail.com"})


def test_low_risk_block_without_a_rule_is_still_audited_only():
    """The threshold keeps its original job: a risk-tier verdict below it is logged, not enforced."""
    inst = _instrument()
    fake, _ = _gateway({"decision": "block", "risk_level": "LOW", "check_id": "c3", "reason": "risk tier"})
    with patch("urllib.request.urlopen", fake):
        inst._check_block("read_file", {"path": "notes.txt"})   # no raise


def test_default_config_enforces_a_medium_risk_gateway_block():
    """The paper's runs enforce every gateway block, and so do the JS and
    Go SDKs; the Python default used to audit anything below HIGH."""
    from agentguard.core.config import AgentGuardConfig
    inst = _instrument()
    inst._guard.config.block_threshold = AgentGuardConfig(agent_id="a").block_threshold
    fake, _ = _gateway({"decision": "block", "risk_level": "MEDIUM", "check_id": "c2", "category": "network",
                        "reason": "plaintext URL"})
    with patch("urllib.request.urlopen", fake), pytest.raises(AgentGuardBlockedError):
        inst._check_block("fetch", {"url": "http://example.invalid"})
