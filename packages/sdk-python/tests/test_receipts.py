"""verify_receipt: an executor's offline check that the gateway allowed
this call with these arguments. Tokens here are built the way the
gateway builds them (canonical JSON, Ed25519, base64url)."""
from __future__ import annotations

import base64
import json

import pytest

from agentguard.receipts import args_hash, canonical_json, verify_receipt

cryptography = pytest.importorskip("cryptography")
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402


def _b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _mint(priv, payload: dict) -> str:
    body = canonical_json(payload).encode()
    return f"AEG1.{_b64u(body)}.{_b64u(priv.sign(body))}"


@pytest.fixture
def key():
    priv = Ed25519PrivateKey.generate()
    pem = priv.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    return priv, pem


ARGS = {"to": "bob@acme.example", "subject": "Q3", "amount": 1810}


def test_valid_receipt_matches_the_call_it_was_issued_for(key):
    priv, pem = key
    tok = _mint(priv, {"v": 1, "id": "c1", "org": "default", "agent": "billing", "tool": "send_email",
                       "args": args_hash(ARGS), "decision": "allow", "iat": 1, "kid": "k"})
    r = verify_receipt(tok, pem, tool_name="send_email", arguments=ARGS, agent_id="billing")
    assert r["valid"] and r["matches_call"] and r["payload"]["id"] == "c1"
    # same arguments in a different key order hash the same
    assert verify_receipt(tok, pem, arguments={"amount": 1810, "subject": "Q3", "to": "bob@acme.example"})["matches_call"]


def test_receipt_does_not_match_other_arguments_or_tools(key):
    priv, pem = key
    tok = _mint(priv, {"v": 1, "id": "c1", "org": "default", "agent": "billing", "tool": "send_email",
                       "args": args_hash(ARGS), "decision": "allow", "iat": 1, "kid": "k"})
    assert verify_receipt(tok, pem, arguments={**ARGS, "to": "attacker@evil.example"})["matches_call"] is False
    assert verify_receipt(tok, pem, tool_name="delete_file")["matches_call"] is False
    assert verify_receipt(tok, pem)["matches_call"] is None


def test_tampered_or_foreign_receipts_are_invalid(key):
    priv, pem = key
    tok = _mint(priv, {"v": 1, "id": "c1", "org": "default", "agent": "a", "tool": "t", "args": args_hash({}),
                       "decision": "allow", "iat": 1, "kid": "k"})
    tag, p, s = tok.split(".")
    forged = json.loads(base64.urlsafe_b64decode(p + "==")); forged["tool"] = "rm_rf"
    assert not verify_receipt(f"{tag}.{_b64u(canonical_json(forged).encode())}.{s}", pem)["valid"]
    other = Ed25519PrivateKey.generate()
    other_pem = other.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    assert not verify_receipt(tok, other_pem)["valid"]
    assert not verify_receipt("not.a.receipt", pem)["valid"]
    assert not verify_receipt(_mint(priv, {"v": 1, "decision": "block", "id": "x"}), pem)["valid"]


def test_canonical_json_matches_the_gateway_convention():
    assert canonical_json({"b": [1, {"d": None, "c": "é"}], "a": True}) == '{"a":true,"b":[1,{"c":"é","d":null}]}'
