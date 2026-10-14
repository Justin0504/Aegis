"""
Standalone alignment helper — framework-agnostic /alignment/check
front-end with the same closed-loop semantics as the LangChain
callback.
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from agentguard.integrations import _alignment_state as als
from agentguard.integrations import alignment


@pytest.fixture(autouse=True)
def _reset_state():
    als.reset()
    yield
    als.reset()


def _fake_resp(status=200, body=None):
    class _R:
        status_code = status
        text = ""

        def json(self_):  # noqa: N805
            return body or {}

        def raise_for_status(self_):  # noqa: N805
            if status >= 400:
                import httpx
                raise httpx.HTTPStatusError(
                    f"HTTP {status}",
                    request=None,  # type: ignore[arg-type]
                    response=None,  # type: ignore[arg-type]
                )
    return _R()


class _FakeClient:
    def __init__(self, response):
        self._resp = response
        self.captured = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def post(self, url, headers=None, content=None):
        self.captured = {"url": url, "headers": headers, "content": content}
        return self._resp


def test_check_posts_full_body_and_returns_verdict():
    fake = _FakeClient(
        _fake_resp(body={"score": 0.32, "drifted": True, "signals": ["scope-expansion"]}),
    )
    with patch("agentguard.integrations.alignment.httpx.Client", return_value=fake):
        out = alignment.check(
            agent_id="agent-a",
            declared_goal="summarise the survey",
            thought_chain=["thought-1"],
            proposed_action={"tool_name": "exec_sql", "arguments": {"q": "SELECT 1"}},
            gateway_url="http://gw.test",
            api_key="test-key",
        )

    assert out["score"] == 0.32
    assert out["drifted"] is True

    body = json.loads(fake.captured["content"])
    assert body["agent_id"] == "agent-a"
    assert body["declared_goal"] == "summarise the survey"
    assert body["thought_chain"] == ["thought-1"]
    assert body["proposed_action"] == {
        "tool_name": "exec_sql",
        "arguments": {"q": "SELECT 1"},
    }
    assert fake.captured["headers"]["x-api-key"] == "test-key"
    assert fake.captured["url"].endswith("/api/v1/alignment/check")


def test_check_buffers_verdict_for_closed_loop():
    fake = _FakeClient(_fake_resp(body={"score": 0.42, "drifted": True}))
    with patch("agentguard.integrations.alignment.httpx.Client", return_value=fake):
        alignment.check(
            agent_id="agent-b",
            declared_goal="g",
            proposed_action={"tool_name": "t"},
            gateway_url="http://gw.test",
        )

    buffered = als.consume("agent-b")
    assert buffered is not None
    assert buffered["drifted"] is True


def test_check_skips_buffering_when_opted_out():
    fake = _FakeClient(_fake_resp(body={"score": 0.9, "drifted": False}))
    with patch("agentguard.integrations.alignment.httpx.Client", return_value=fake):
        alignment.check(
            agent_id="agent-c",
            declared_goal="g",
            proposed_action={"tool_name": "t"},
            gateway_url="http://gw.test",
            record_for_check=False,
        )

    assert als.consume("agent-c") is None


def test_check_accepts_optional_provider_and_model():
    fake = _FakeClient(_fake_resp(body={"score": 1.0}))
    with patch("agentguard.integrations.alignment.httpx.Client", return_value=fake):
        alignment.check(
            agent_id="agent-d",
            declared_goal="g",
            proposed_action={"tool_name": "t"},
            gateway_url="http://gw.test",
            provider="anthropic",
            model="claude-haiku-4-5",
        )
    body = json.loads(fake.captured["content"])
    assert body["provider"] == "anthropic"
    assert body["model"] == "claude-haiku-4-5"


def test_check_validates_inputs():
    with pytest.raises(ValueError, match="agent_id"):
        alignment.check(
            agent_id="",
            declared_goal="g",
            proposed_action={"tool_name": "t"},
        )
    with pytest.raises(ValueError, match="declared_goal"):
        alignment.check(
            agent_id="a",
            declared_goal="",
            proposed_action={"tool_name": "t"},
        )
    with pytest.raises(ValueError, match="proposed_action"):
        alignment.check(
            agent_id="a",
            declared_goal="g",
            proposed_action={},  # type: ignore[arg-type]
        )
    with pytest.raises(ValueError, match="provider"):
        alignment.check(
            agent_id="a",
            declared_goal="g",
            proposed_action={"tool_name": "t"},
            provider="bananas",
        )


def test_thought_chain_defaults_to_empty_list():
    fake = _FakeClient(_fake_resp(body={"score": 1.0}))
    with patch("agentguard.integrations.alignment.httpx.Client", return_value=fake):
        alignment.check(
            agent_id="agent-e",
            declared_goal="g",
            proposed_action={"tool_name": "t"},
        )
    body = json.loads(fake.captured["content"])
    assert body["thought_chain"] == []


def test_consume_proxies_state_consumer():
    als.record("agent-f", {"score": 0.7, "drifted": False})
    out = alignment.consume("agent-f")
    assert out == {"score": 0.7, "drifted": False}
    assert alignment.consume("agent-f") is None  # single-use


def test_check_forwards_session_id_so_the_auditor_sees_tool_output(monkeypatch):
    """The gateway shows the auditor what the agent read only if it knows
    the session; the helper defaults to the session auto() reports under."""
    monkeypatch.setenv("AEGIS_SESSION_ID", "sess-env")
    import agentguard
    monkeypatch.setattr(agentguard, "_default_guard", None)
    for explicit, expected in ((None, "sess-env"), ("sess-explicit", "sess-explicit")):
        fake = _FakeClient(_fake_resp(body={"score": 1, "drifted": False}))
        with patch("agentguard.integrations.alignment.httpx.Client", return_value=fake):
            alignment.check(agent_id="a", declared_goal="g", session_id=explicit,
                            proposed_action={"tool_name": "t", "arguments": {}}, gateway_url="http://gw.test")
        assert json.loads(fake.captured["content"])["session_id"] == expected
