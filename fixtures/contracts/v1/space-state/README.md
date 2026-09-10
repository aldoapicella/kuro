# Space-state protocol fixtures

These synthetic fixtures accompany [D25](../../../../docs/decisions/D25-shared-space-authority.md) and the [v1 JSON Schema](../../../../packages/contracts/schemas/space-state-v1.schema.json). Repeated hexadecimal strings are test identifiers, not usable cryptographic identities or keys. No runtime authority or network service is implemented here.

Run the development-only validator from the repository root:

```sh
uv run --no-project --with jsonschema==4.26.0 python scripts/check-space-state-contract.py
```

This uses an isolated validation dependency; it does not choose the application's TypeScript runtime validator or add an application lockfile. The script can also run with an existing Python environment containing that `jsonschema` version.

| File | Expected structural result | Meaning |
| --- | --- | --- |
| `request.json` | Accept | Ask the pinned authority for this authenticated device's projection |
| `active.json` | Accept | Current two-member projection at policy revision 7 / publication 11 |
| `renewal.json` | Accept | New request/publication, unchanged policy and state digest |
| `denied.json` | Accept | Revision 8 / publication 13 removes the recipient; empty projection and zero lease |
| `invalid-extra-field.json` | Reject | A requester attempts to choose another recipient |
| `invalid-lease.json` | Reject | Positive permission exceeds the 900,000 ms bound |
| `invalid-denial.json` | Reject | Denial attempts to carry a positive lease |
| `invalid-capability.json` | Reject | Unknown capability |

`digests.json` records the exact compact response-body and canonical-state SHA-256 digests for the three valid responses. Canonical state property order and array ordering are specified in D25. Framing prefixes are excluded. Whitespace in these readable fixture files is not part of the expected wire body: serialize their stored object order as compact UTF-8 JSON with no newline for the body fixture. All string values in this schema are ASCII.

The request ID in `request.json` correlates to `active.json`; renewal and denial represent later, separately initiated requests. Their identities/aliases are unchanged. Tests of live renewal must create the corresponding new outstanding request, not accept an unsolicited response from these files.

Structural acceptance is insufficient for authorization. Runtime conformance must also check authenticated authority/recipient, pinned bindings, outstanding request and original-send time, counters, state digest, unique member IDs/device keys across entries, recipient inclusion, complete projection replacement, durable installation, and expiry. JSON Schema cannot prove these conditions. See D25's acceptance criteria for required stateful and real-transport tests.

Do not use an already accepted fixture response to renew a lease. An exact duplicate preserves the old deadline; only a new correlated publication can establish new validity, anchored to that new request's original send time. If policy changed before an authority retry, D25 requires closure instead of resending obsolete state.
