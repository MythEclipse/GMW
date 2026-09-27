#!/usr/bin/env python3
"""Format pino JSON log lines from the moderation pipeline into a readable trace.

Reads journalctl output on stdin, writes a table on stdout. Kept as a separate
file rather than an inline heredoc so it can be linted and tested on its own.
"""
import json
import sys

# Fields worth showing, in the order an operator reads them.
HUMAN_FIELDS = ("waitHuman", "durationHuman", "elapsedHuman", "cycleHuman")
PLAIN_FIELDS = (
    "status",
    "count",
    "ok",
    "errored",
    "missing",
    "attempts",
    "model",
    "score",
    "reason",
    "batchError",
    "err",
)


def fmt(line: str) -> str | None:
    line = line.strip()
    if not line.startswith("{"):
        return None
    try:
        d = json.loads(line)
    except (ValueError, TypeError):
        return None

    stage = d.get("stage") or "-"
    trace = d.get("trace")
    if not trace:
        ids = d.get("ids")
        trace = ids[0] if isinstance(ids, list) and ids else "-"

    bits = [f"{d[k]}" for k in HUMAN_FIELDS if d.get(k)]
    for k in PLAIN_FIELDS:
        v = d.get(k)
        if v is not None:
            bits.append(f"{k}={str(v)[:70]}")

    ts = d.get("time", "")
    return f"{ts}  {stage:<16} {str(trace):<13} " + " ".join(bits)


def main() -> int:
    for line in sys.stdin:
        out = fmt(line)
        if out:
            print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
