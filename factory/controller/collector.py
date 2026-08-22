"""Observation collector — pure data fetches, clock as observation."""
from __future__ import annotations

import datetime
from dataclasses import replace
from typing import Any

from .observations import Observations, Clock, GitHead, PROBS, CIObservation, ReviewObservation, WorkerObservation

class Collector:
    def __init__(self, github, ao, git, review_store=None) -> None:
        self.github = github
        self.ao = ao
        self.git = git
        self.review_store = review_store

    def collect(self, work_items: list[Any], required_checks: tuple[str,...]=()) -> Observations:
        clock = Clock(iso=datetime.datetime.utcnow().isoformat()+"Z")
        git_heads = []
        try:
            head = self.git.current_head("main")
            if head:
                git_heads.append(GitHead(branch="main", sha=head))
        except Exception:
            pass
        prs = []
        ci = []
        reviews = []
        workers = []
        # GitHub PRs
        try:
            pr_list = self.github.list_prs() if hasattr(self.github, "list_prs") else []
            for pr in pr_list[:20]:
                try:
                    prs.append(PROBS(pr=int(pr.get("number")), head_sha=str(pr.get("headRefOid") or pr.get("head_sha") or ""), state=str(pr.get("state","open")).lower(), mergeable=str(pr.get("mergeable","")).lower() in ("true","mergeable","clean"), base_branch=str(pr.get("baseRefName") or "main")))
                    # CI
                    checks = pr.get("statusCheckRollup") or pr.get("checks") or []
                    gate_set = tuple(c.get("name") or c.get("context") or "" for c in checks)
                    # determine passed: all required checks SUCCESS
                    passed = True
                    has_evidence = bool(checks)
                    if required_checks:
                        by_name = {(c.get("name") or c.get("context")): c for c in checks}
                        # simplified: if missing required, not passed
                        for rc in required_checks:
                            if rc not in [c.get("name") or c.get("context") for c in checks]:
                                passed = False
                                has_evidence = False
                            else:
                                # find conclusion
                                for c in checks:
                                    if (c.get("name") or c.get("context"))==rc:
                                        concl = str(c.get("conclusion") or c.get("state") or "").upper()
                                        if concl not in ("SUCCESS","PASS",""):
                                            passed=False
                    else:
                        # generic pass if any success
                        passed = any(str(c.get("conclusion") or c.get("state") or "").upper() in ("SUCCESS","PASS") for c in checks) if checks else False
                    classification = "UNKNOWN"
                    if has_evidence:
                        if passed:
                            classification = "PRODUCT" # passed is product success
                        else:
                            # naive infra signals check
                            infra_signals = ("runner_down","timeout","network","rate_limit")
                            if any(s in str(checks).lower() for s in infra_signals):
                                classification = "INFRASTRUCTURE"
                            else:
                                classification = "PRODUCT"
                    ci.append(CIObservation(pr=int(pr.get("number")), head=str(pr.get("headRefOid") or ""), gate_set=gate_set, passed=passed, classification=classification, has_evidence=has_evidence))
                except Exception:
                    continue
        except Exception:
            pass
        # AO workers
        try:
            sessions = self.ao.list_sessions() if hasattr(self.ao, "list_sessions") else []
            for s in sessions[:20]:
                try:
                    workers.append(WorkerObservation(workId=str(s.get("id") or s.get("workId") or ""), session_id=str(s.get("id") or ""), status=str(s.get("status") or "running")))
                except Exception:
                    continue
        except Exception:
            pass
        # Reviews — if review_store provided, load
        try:
            if self.review_store and hasattr(self.review_store, "list_reviews"):
                for rv in self.review_store.list_reviews()[:20]:
                    try:
                        reviews.append(ReviewObservation(workId=str(rv.get("workId")), pr=int(rv.get("pr")), targetHead=str(rv.get("targetHead")), reviewer=str(rv.get("reviewer")), implementationProvider=str(rv.get("implementationProvider") or "muse"), mode=str(rv.get("mode") or "BASELINE"), reviewScopeId=str(rv.get("reviewScopeId") or ""), contextDigest=str(rv.get("contextDigest") or ""), verdict=str(rv.get("verdict") or "PASS")))
                    except Exception:
                        continue
        except Exception:
            pass
        return Observations(clock=clock, git_heads=tuple(git_heads), prs=tuple(prs), ci=tuple(ci), reviews=tuple(reviews), workers=tuple(workers))
