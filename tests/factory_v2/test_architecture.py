import ast
import pathlib


def test_reducer_is_pure():
    """Pure reducer modules cannot import subprocess, GitHub adapter, AO adapter, requests."""
    forbidden = {"subprocess", "requests", "factory.controller.ao", "factory.controller.github", "factory.controller_v2.adapters.github", "factory.controller_v2.adapters.ao"}
    for path in pathlib.Path("factory/controller").glob("*.py"):
        if path.name in ("executor.py",):
            continue  # executor is allowed to use store
        tree = ast.parse(path.read_text())
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    imports.add(node.module)
        bad = imports & forbidden
        # reducer/domain/observations/commands/transitions/identity/review/ci/recovery must be pure
        if path.name in ("reducer.py", "domain.py", "observations.py", "commands.py", "transitions.py", "identity.py", "review.py", "ci.py", "recovery.py"):
            assert not bad, f"{path} imports forbidden {bad}"


def test_one_merge_pr_producer():
    """Exactly one MERGE_PR producer site — reducer only."""
    import pathlib
    count = pathlib.Path("factory/controller/reducer.py").read_text().count("Command.new(work.workId, CommandType.MERGE_PR")
    # fallback generic count if formatting differs
    if count == 0:
        count = pathlib.Path("factory/controller/reducer.py").read_text().count("MERGE_PR")
        # filter to Command.new lines only
        count = sum(1 for l in pathlib.Path("factory/controller/reducer.py").read_text().splitlines() if "MERGE_PR" in l and "Command.new" in l)
    assert count == 1, f"expected exactly 1 MERGE_PR producer in reducer, got {count}"


def test_no_legacy_import_in_runtime():
    for p in pathlib.Path("factory/controller").rglob("*.py"):
        text = p.read_text()
        assert "factory.controller " not in text or "factory.controller_v2" in text, f"legacy import in {p}"
        assert "from factory.controller import" not in text, f"legacy import in {p}"
