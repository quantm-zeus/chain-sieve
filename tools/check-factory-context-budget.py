#!/usr/bin/env python3
"""Check factory context budget — fails if runtime grows unexpectedly."""
import pathlib

MAX_LOC = 12000
MAX_MODULES = 35

loc = sum(len(p.read_text().splitlines()) for p in pathlib.Path("factory/controller").rglob("*.py"))
mods = len(list(pathlib.Path("factory/controller").rglob("*.py")))
print(f"Runtime LOC: {loc} (limit {MAX_LOC})")
print(f"Modules: {mods} (limit {MAX_MODULES})")
if loc > MAX_LOC:
    print(f"FAIL: LOC {loc} exceeds budget {MAX_LOC}")
    raise SystemExit(1)
if mods > MAX_MODULES:
    print(f"FAIL: modules {mods} exceeds {MAX_MODULES}")
    raise SystemExit(1)
print("PASS: context budget")
