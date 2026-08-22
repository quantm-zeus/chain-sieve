"""Invariant tests — sample of INV-01..25."""
from factory.controller_v2.domain import WorkItem, WorkStatus
from factory.controller_v2.observations import Observations, Clock, PROBS, CIObservation, ReviewObservation
from factory.controller_v2.reducer import reduce_state
from factory.controller_v2.identity import canonical_gap_key
from factory.controller_v2.review import validate_review
from factory.controller_v2.transitions import can_merge


def _obs(**kwargs):
    defaults = dict(clock=Clock(iso="2026-08-22T00:00:00Z"))
    defaults.update(kwargs)
    return Observations(**defaults)


def test_no_merge_without_ci_pass():
    w = WorkItem(workId="WORK-REQ-1-abc", gapKey="GAP-REQ-1-abc", status=WorkStatus.MERGE_READY, pr_number=1, head_sha="a"*40)
    obs = _obs(prs=(PROBS(pr=1, head_sha="a"*40, state="open", mergeable=True, base_branch="main"),), ci=(CIObservation(pr=1, head="a"*40, gate_set=("ci",), passed=False, classification="PRODUCT", has_evidence=True),))
    assert not can_merge(w, pr_state="open", pr_head="a"*40, pr_mergeable=True, ci_pass_for_head=False, review_evidence=None, expected_scope=None, expected_digest=None)


def test_stale_cointroduction_makes_ci_stale():
    from factory.controller_v2.ci import ci_is_stale
    assert ci_is_stale("a"*40, "b"*40)
    assert not ci_is_stale("a"*40, "a"*40)


def test_gap_identity_paraphrase_invariant():
    k1 = canonical_gap_key("M1", ["REQ-1"], ["AC-1"])
    k2 = canonical_gap_key("M1", ["REQ-1"], ["AC-1"])
    assert k1 == k2
    # paraphrasing objective must not create new key — we ignore objective entirely
    from factory.controller_v2.identity import assign_persistent_gap_key
    a = assign_persistent_gap_key("M1", ["REQ-1"], generated_objective="Fix the foo", acceptance_ids=["AC-1"])
    b = assign_persistent_gap_key("M1", ["REQ-1"], generated_objective="Totally different wording for same gap", acceptance_ids=["AC-1"])
    assert a == b == k1


def test_malformed_review_zero_effect():
    w = WorkItem(workId="W", gapKey="G", status=WorkStatus.REVIEW_BASELINE_WAIT, head_sha="a"*40, pr_number=1)
    obs = _obs(reviews=(ReviewObservation(workId="W", pr=1, targetHead="a"*40, reviewer="agy", implementationProvider="muse", mode="BASELINE", reviewScopeId="s", contextDigest="d", verdict="PASS", malformed=True),))
    nw, cmds = reduce_state(w, obs)
    assert nw.status == WorkStatus.REVIEW_BASELINE_WAIT  # no transition
    assert cmds == []


def test_stale_review_zero_effect():
    w = WorkItem(workId="W", gapKey="G", status=WorkStatus.REVIEW_BASELINE_WAIT, head_sha="a"*40, pr_number=1)
    # review for old head
    obs = _obs(reviews=(ReviewObservation(workId="W", pr=1, targetHead="b"*40, reviewer="agy", implementationProvider="muse", mode="BASELINE", reviewScopeId="s", contextDigest="d", verdict="PASS"),))
    nw, cmds = reduce_state(w, obs, review_scope="s", review_digest="d")
    assert nw.status == WorkStatus.REVIEW_BASELINE_WAIT


def test_deterministic_reducer():
    w = WorkItem(workId="W", gapKey="G", status=WorkStatus.PLANNED)
    obs = _obs()
    a1, c1 = reduce_state(w, obs)
    a2, c2 = reduce_state(w, obs)
    assert a1 == a2 and c1 == c2


def test_validate_review_strict():
    assert validate_review({"authority": {"workId": "W", "pr": 1, "targetHead": "a"*40, "reviewer": "agy", "implementationProvider": "muse", "mode": "BASELINE", "reviewScopeId": "s", "contextDigest": "d"}, "verdict": "PASS"}) is not None
    assert validate_review({"authority": {"workId": "W", "pr": 1, "targetHead": "bad", "reviewer": "agy", "implementationProvider": "muse", "mode": "BASELINE", "reviewScopeId": "s", "contextDigest": "d"}, "verdict": "PASS"}) is None
    assert validate_review({"authority": {"workId": "W", "pr": 1, "targetHead": "a"*40, "reviewer": "agy", "implementationProvider": "muse", "mode": "FINAL_CONFIRMATION", "reviewScopeId": "s", "contextDigest": "d"}, "verdict": "PASS"}) is None
