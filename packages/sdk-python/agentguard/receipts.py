"""Decision receipts — verify that the AEGIS gateway allowed a call.

Every ``allow`` the gateway returns carries a ``receipt``: a compact token
``AEG1.<payload>.<signature>`` whose payload names the check, the agent,
the tool and a hash of the arguments, signed with the gateway's Ed25519
key. A tool executor that receives a call together with its receipt can
verify, offline, that this gateway allowed this call with these
arguments, without trusting the agent that relays it.

    from agentguard.receipts import verify_receipt
    r = verify_receipt(token, public_key_pem, tool_name="send_email", arguments=args)
    r["valid"], r["matches_call"], r["payload"]["id"]

The public key is ``GET /api/v1/check/receipt-key`` on the gateway, and
is stable for the life of its signing key; pin it on the executor.
"""
from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Optional


def canonical_json(v: Any) -> str:
    """Sorted keys, no whitespace; the gateway hashes the same bytes."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def args_hash(arguments: Any) -> str:
    return hashlib.sha256(canonical_json(arguments if arguments is not None else {}).encode("utf-8")).hexdigest()


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_receipt(token: str, public_key_pem: str, *, tool_name: Optional[str] = None,
                   arguments: Any = None, agent_id: Optional[str] = None) -> dict:
    """Returns ``{"valid": bool, "payload": dict | None, "reason": str | None,
    "matches_call": bool | None}``. ``matches_call`` is set when any of
    ``tool_name``, ``arguments`` or ``agent_id`` is given and says whether
    the receipt was issued for that call."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as e:  # pragma: no cover
        return {"valid": False, "payload": None, "reason": f"cryptography not installed: {e}", "matches_call": None}
    try:
        tag, p, s = token.split(".")
        if tag != "AEG1":
            return {"valid": False, "payload": None, "reason": "not a receipt", "matches_call": None}
        body, sig = _b64u_decode(p), _b64u_decode(s)
        pub = serialization.load_pem_public_key(public_key_pem.encode())
        if not isinstance(pub, Ed25519PublicKey):
            return {"valid": False, "payload": None, "reason": "not an Ed25519 key", "matches_call": None}
        pub.verify(sig, body)
        payload = json.loads(body)
        if payload.get("v") != 1 or payload.get("decision") != "allow":
            return {"valid": False, "payload": payload, "reason": "unsupported receipt", "matches_call": None}
        matches: Optional[bool] = None
        if tool_name is not None or arguments is not None or agent_id is not None:
            matches = ((tool_name is None or tool_name == payload.get("tool"))
                       and (arguments is None or args_hash(arguments) == payload.get("args"))
                       and (agent_id is None or agent_id == payload.get("agent")))
        return {"valid": True, "payload": payload, "reason": None, "matches_call": matches}
    except Exception as e:  # noqa: BLE001 — any failure is "not valid", never an exception to the caller
        return {"valid": False, "payload": None, "reason": f"signature does not verify ({type(e).__name__})", "matches_call": None}
