#!/usr/bin/python3.12
from __future__ import annotations

import os
import sys
import argparse
from pathlib import Path

sys.path.insert(0, os.environ.get("CHAINSIEVE_REPO_PATH", "/srv/chainsieve/repo"))

from factory.controller.token_source import GitHubAppTokenSource


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--actor", action="store_true")
    args = parser.parse_args()
    source = GitHubAppTokenSource.from_environment()
    if source is None:
        raise SystemExit("GitHub App credentials are not configured")
    print(source.app_actor() if args.actor else source.token())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
