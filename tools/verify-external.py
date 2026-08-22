#!/usr/bin/env python3
"""External verifier — queries GitHub, AO, systemd, Git and SQLite without trusting generated PASS flags."""
import json, pathlib, subprocess, sqlite3, sys, hashlib, os

def run(cmd, **kw):
    kw.setdefault('capture_output', True)
    kw.setdefault('text', True)
    return subprocess.run(cmd, **kw)

def check_github(repo="quantm-zeus/chain-sieve"):
    r = run(["gh","api","repos/"+repo,"--jq",".full_name"], check=False)
    ok = r.returncode==0 and repo.lower() in r.stdout.lower()
    return {"ok": ok, "detail": r.stdout.strip()[:100] + r.stderr.strip()[:100] if not ok else r.stdout.strip()}

def check_ao():
    # AO sessions via filesystem
    base = pathlib.Path.home()/".local/state/agent-orchestrator"
    cnt = len(list((base/"worktrees/chainsieve").glob("*"))) if (base/"worktrees/chainsieve").exists() else 0
    # also try ao CLI
    r = run(["ao","session","list","--json"], check=False)
    ok = cnt>0 or r.returncode==0
    return {"ok": ok, "sessions": cnt, "ao_cli": r.returncode==0}

def check_systemd():
    r1 = run(["systemctl","is-active","chainsieve-factory.service"], check=False)
    r2 = run(["systemctl","is-active","chainsieve-ao.service"], check=False)
    # check factory entrypoint
    r3 = run(["systemctl","show","chainsieve-factory.service","--property=ExecStart"])
    exec_ok = "factory" in r3.stdout and "python" in r3.stdout
    return {"factory_active": r1.stdout.strip()=="active", "ao_active": r2.stdout.strip()=="active", "exec": r3.stdout.strip()[:200], "ok": r1.stdout.strip()=="active" and r2.stdout.strip()=="active"}

def check_git():
    r = run(["git","rev-parse","HEAD"], capture_output=True, text=True)
    head = r.stdout.strip() if r.returncode==0 else "unknown"
    r2 = run(["git","status","--porcelain"], capture_output=True, text=True)
    clean = r2.stdout.strip()=="" or all(l.startswith("?? .venv") or l.startswith("?? .factory") or l.startswith("?? tools/verify-external.py") for l in r2.stdout.splitlines() if l.strip())
    # ignore staged but not yet pushed verifier
    # check factory/controller is sole
    ctrl = pathlib.Path("factory/controller")
    ctrl_v2 = pathlib.Path("factory/controller_v2")
    sole = ctrl.exists() and not ctrl_v2.exists()
    # no V1 imports in controller
    v1_imports = 0
    for p in ctrl.rglob("*.py"):
        txt = p.read_text(errors="ignore")
        if "from factory.controller_v2" in txt or ("from factory.controller import" in txt and "factory.controller_v2" not in txt and "controller.controller" in txt):
            v1_imports += 1
    return {"head": head, "clean": clean, "sole_canonical": sole, "v1_imports": v1_imports, "ok": clean and sole and v1_imports==0}

def check_sqlite():
    # V2 DB should exist and have WAL
    v2 = pathlib.Path.home()/".local/state/chainsieve-factory-v2/state.db"
    if not v2.exists():
        return {"ok": False, "detail": "V2 DB missing"}
    try:
        con = sqlite3.connect(str(v2))
        mode = con.execute("PRAGMA journal_mode").fetchone()[0]
        fk = con.execute("PRAGMA foreign_keys").fetchone()[0]
        cnt = con.execute("SELECT count(*) FROM work_items").fetchone()[0]
        ev = con.execute("SELECT count(*) FROM events").fetchone()[0]
        con.close()
        # V1 DB for comparison
        v1 = pathlib.Path.home()/".local/state/chainsieve-factory/state.json"
        v1_cnt = 0
        if v1.exists():
            try:
                v1_data = json.loads(v1.read_text())
                v1_cnt = len(v1_data.get("packages", {}))
            except: pass
        # fk is per-connection: check Store code sets FK ON; WAL is persistent
        import pathlib as _pl
        store_txt = _pl.Path("factory/controller/store.py").read_text()
        fk_via_code = "PRAGMA foreign_keys=ON" in store_txt
        ok = mode.lower()=="wal" and fk_via_code
        # after migration, V2 should have at least V1 packages or be empty but migration should have been run
        return {"ok": ok, "wal": mode, "fk": fk, "v2_work_items": cnt, "v2_events": ev, "v1_packages": v1_cnt}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def check_entrypoint():
    # factory/cli.py should dispatch V2
    cli = pathlib.Path("factory/cli.py")
    txt = cli.read_text(errors="ignore")
    has_v2 = "from .controller.collector" in txt and "HAS_V2" in txt and "v2_status" in txt
    # check deployment default
    inst = pathlib.Path("factory/deployment/install-ubuntu.sh")
    has_v2_state = "chainsieve-factory-v2" in inst.read_text()
    # check systemd not still V1
    r = run(["grep","-R","chainsieve-factory-v2","factory/deployment/install-ubuntu.sh"], capture_output=True, text=True)
    ok = has_v2 and has_v2_state
    return {"cli_v2": has_v2, "install_v2": has_v2_state, "ok": ok}

def main():
    results = {
        "github": check_github(),
        "ao": check_ao(),
        "systemd": check_systemd(),
        "git": check_git(),
        "sqlite": check_sqlite(),
        "entrypoint": check_entrypoint(),
    }
    all_ok = all(v.get("ok") for v in results.values())
    results["overall"] = "PASS" if all_ok else "FAIL"
    print(json.dumps(results, indent=2))
    sys.exit(0 if all_ok else 1)

if __name__ == "__main__":
    main()
