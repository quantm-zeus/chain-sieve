#!/usr/bin/env python3
"""Report credential variable presence for a process without reading or printing values."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pid", type=int)
    parser.add_argument("--require", action="append", default=[])
    parser.add_argument("--forbid", action="append", default=[])
    args = parser.parse_args()
    names = {
        entry.split(b"=", 1)[0].decode("utf-8", errors="replace")
        for entry in Path(f"/proc/{args.pid}/environ").read_bytes().split(b"\0")
        if b"=" in entry
    }
    result = {
        "pid": args.pid,
        "required": {name: name in names for name in args.require},
        "forbidden": {name: name in names for name in args.forbid},
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if all(result["required"].values()) and not any(result["forbidden"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
