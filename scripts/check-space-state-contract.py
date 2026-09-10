#!/usr/bin/env python3
"""Validate D25 schema/examples; this does not test runtime authorization."""

import hashlib
import json
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:
    raise SystemExit(
        "Run: uv run --no-project --with jsonschema==4.26.0 "
        "python scripts/check-space-state-contract.py"
    )


ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures/contracts/v1/space-state"
CAPABILITIES = ["search", "read", "share", "receive", "manage"]


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def canonical_state(message):
    state = {
        key: message[key]
        for key in (
            "spaceId", "authorityKey", "recipientKey", "policyRevision",
            "projectionScope", "status",
        )
    }
    state["members"] = [
        {
            "memberId": member["memberId"],
            "deviceKeys": sorted(member["deviceKeys"]),
            "capabilities": sorted(member["capabilities"], key=CAPABILITIES.index),
        }
        for member in sorted(message["members"], key=lambda item: item["memberId"])
    ]
    return state


def main():
    schema = json.loads(
        (ROOT / "packages/contracts/schemas/space-state-v1.schema.json").read_text()
    )
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    cases = {
        "request.json": True, "active.json": True, "renewal.json": True,
        "denied.json": True, "invalid-extra-field.json": False,
        "invalid-lease.json": False, "invalid-denial.json": False,
        "invalid-capability.json": False,
    }
    actual = {path.name for path in FIXTURES.glob("*.json")} - {"digests.json"}
    require(actual == set(cases), "Every message fixture needs an explicit expectation")
    for name, expected in cases.items():
        message = json.loads((FIXTURES / name).read_text())
        require(validator.is_valid(message) == expected, f"Unexpected schema result: {name}")

    golden = json.loads((FIXTURES / "digests.json").read_text())
    require(set(golden) == {"active.json", "renewal.json", "denied.json"}, "Missing golden response")
    for name, expected in golden.items():
        message = json.loads((FIXTURES / name).read_text())
        body = compact(message)
        state_hash = hashlib.sha256(compact(canonical_state(message))).hexdigest()
        require(len(body) <= 32768, f"Frame too large: {name}")
        require(hashlib.sha256(body).hexdigest() == expected["wireBodySha256"], f"Body digest: {name}")
        require(state_hash == message["projectionDigest"] == expected["canonicalStateSha256"], f"State digest: {name}")
        require(len(body) == expected["wireBodyBytes"], f"Body size: {name}")
        require(len(body).to_bytes(4, "big").hex() == expected["framePrefixHex"], f"Frame prefix: {name}")
        members = message["members"]
        member_ids = [member["memberId"] for member in members]
        keys = [key for member in members for key in member["deviceKeys"]]
        require(len(set(member_ids)) == len(member_ids), f"Duplicate member ID: {name}")
        require(len(set(keys)) == len(keys), f"Repeated device key: {name}")
        if message["status"] == "ACTIVE":
            require(keys.count(message["recipientKey"]) == 1, f"Recipient missing/ambiguous: {name}")

    require(
        golden["active.json"]["canonicalStateSha256"] == golden["renewal.json"]["canonicalStateSha256"],
        "Unchanged renewal must preserve the state digest",
    )
    print(f"PASS: Draft 2020-12 schema, {len(cases)} structural cases, {len(golden)} golden responses.")
    print("Not tested: authenticated transport, persistence, replay handling, or permission expiry.")


if __name__ == "__main__":
    main()
