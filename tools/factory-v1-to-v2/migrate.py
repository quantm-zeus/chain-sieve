#!/usr/bin/env python3
"""Real V1->V2 migrator — deterministic canonical work mapping from actual production V1 state, no manual SQLite edits."""
import json, hashlib, pathlib, sys, datetime

V1_STATE = pathlib.Path.home() / ".local/state/chainsieve-factory/state.json"
OUT = pathlib.Path("artifacts/factory-v2/migrator-canonical.json")

def canonical_gap_key(milestone_id, requirement_ids, acceptance_ids=None):
    mid = (milestone_id or "").strip().upper()
    reqs = sorted({str(r).strip().upper() for r in (requirement_ids or []) if str(r).strip()})
    acc = sorted({str(a).strip().upper() for a in (acceptance_ids or []) if str(a).strip()})
    parts = [mid, ",".join(reqs), ",".join(acc), "", ""]
    raw = "|".join(parts)
    digest = hashlib.sha256(raw.encode()).hexdigest()[:12]
    return f"GAP-{reqs[0] if reqs else 'REQ'}-{digest}" if reqs else f"GAP-MIG-{digest}"

def work_id_for_gap(gap_key):
    return gap_key.replace("GAP-", "WORK-")

def main(dry_run=False):
    if not V1_STATE.exists():
        print(f"V1 state missing {V1_STATE}", file=sys.stderr)
        sys.exit(2)
    v1 = json.loads(V1_STATE.read_text())
    packages = v1.get("packages", {})
    milestone = v1.get("metadata", {}).get("milestoneId") or "g3-model-assisted-research"
    mapping = []
    for pkg_id, pkg in packages.items():
        # pkg_id like g3-model-assisted-research--g3-agent-runtime-core
        # derive requirement from pkg_id or use placeholder
        req = pkg_id.split("--")[-1].upper().replace("-", "_")
        # canonical gap from milestone + requirement
        gap = canonical_gap_key(milestone, [req], ["AC-1"])
        work = work_id_for_gap(gap)
        mapping.append({
            "package_id": pkg_id,
            "gapKey": gap,
            "workId": work,
            "issue_number": pkg.get("issue_number"),
            "pr_number": pkg.get("pr_number"),
            "branch": pkg.get("branch"),
            "head_sha": pkg.get("head_sha"),
            "ao_session": pkg.get("session",{}).get("id") if isinstance(pkg.get("session"), dict) else pkg.get("session"),
            "exact_head": pkg.get("head_sha"),
            "v1_status": pkg.get("pr_state") or pkg.get("ci_status"),
        })
    # sort deterministically for canonical output
    mapping_sorted = sorted(mapping, key=lambda x: x["package_id"])
    out_data = {
        "generated_at": datetime.datetime.utcnow().isoformat()+"Z",
        "source": str(V1_STATE),
        "source_hash": hashlib.sha256(V1_STATE.read_bytes()).hexdigest()[:16],
        "v1_event_count": len(open(pathlib.Path.home()/".local/state/chainsieve-factory/events.jsonl").read().splitlines()) if pathlib.Path.home().joinpath(".local/state/chainsieve-factory/events.jsonl").exists() else 0,
        "milestone": milestone,
        "packages_total": len(packages),
        "mapping": mapping_sorted,
        "dry_run": dry_run,
    }
    # canonical hash of mapping for determinism check
    canonical_hash = hashlib.sha256(json.dumps(mapping_sorted, sort_keys=True).encode()).hexdigest()[:16]
    out_data["canonical_hash"] = canonical_hash
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out_data, indent=2)+"\n")
    print(f"{'dry-run' if dry_run else 'migrate'} wrote {OUT} {len(mapping_sorted)} packages hash {canonical_hash}")
    return canonical_hash

if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    h = main(dry_run=dry)
    sys.exit(0)
