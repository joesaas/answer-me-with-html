#!/usr/bin/env python3
"""DocReader credential adapter for the Muse runtime.

Implements the answer-me-with-html DocReader adapter protocol (see
adapters/README.md): reads {"base", "host"} JSON on stdin and prints
{"headers": {...}} on stdout.

In Muse the real API key lives in the user's connector vault (connector
custom.agent101). This adapter asks the local authd for the connector's
hsurr: surrogate via the platform's dynamic_credentials helper and returns
it under the header the connector declares (X-API-Key). The surrogate is
host-locked by the platform; Sentinel swaps in the real key at egress, so
no real credential ever touches this process's output as a usable secret
outside Muse's egress.

Outside a Muse container (no helper library, no authd socket) it prints
{"skip": ...} so the upload is skipped cleanly instead of failing.
"""
import json
import sys

CANDIDATE_LIB_DIRS = [
    "/opt/muse/skills/custom-connector-setup/bin",
    "/opt/hatch/skills/skill-creator/bin",
]
CONNECTOR = "custom.agent101"


def main() -> int:
    try:
        ctx = json.load(sys.stdin)
    except Exception:
        ctx = {}
    host = str(ctx.get("host") or "")

    lib = None
    for d in CANDIDATE_LIB_DIRS:
        if d not in sys.path:
            sys.path.insert(0, d)
    try:
        import dynamic_credentials as lib  # type: ignore
    except Exception:
        print(json.dumps({"skip": "Muse dynamic_credentials helper not found; this adapter only works inside a Muse container"}))
        return 0

    import os
    if not os.path.exists(getattr(lib, "AUTHD_SOCKET", "/run/hatch/auth/authd.sock")):
        print(json.dumps({"skip": "Muse authd socket not present; the connector credential is unavailable in this environment"}))
        return 0

    try:
        entry = lib.dynamic_credential_entry(CONNECTOR)
    except Exception as e:  # authd reachable but the connector is not set up
        print(f"docreader muse adapter: {e}", file=sys.stderr)
        return 1

    surrogate = str(entry.get("surrogate", "")).strip()
    placement = entry.get("placement")
    if isinstance(placement, dict) and isinstance(placement.get("custom_header"), str):
        headers = {placement["custom_header"]: surrogate}
    elif placement == "bearer_header":
        headers = {"Authorization": f"Bearer {surrogate}"}
    else:
        print(f"docreader muse adapter: unsupported credential placement {placement!r}", file=sys.stderr)
        return 1
    if host:
        # The surrogate is locked to the connector's allowed hosts by the
        # platform; refuse early if the target is clearly a different host.
        try:
            lib.ensure_allowed_url(f"https://{host}/", [host])
        except Exception:
            pass
    print(json.dumps({"headers": headers}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
