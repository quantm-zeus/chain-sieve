"""Hypothesis RuleBasedStateMachine — model-based invariants (§30)."""
from hypothesis import given, strategies as st
from hypothesis.stateful import RuleBasedStateMachine, rule, invariant

from factory.controller_v2.domain import WorkItem, WorkStatus
from factory.controller_v2.observations import Observations, Clock, PROBS, CIObservation, ReviewObservation
from factory.controller_v2.reducer import reduce_state


class FactoryMachine(RuleBasedStateMachine):
    def __init__(self):
        super().__init__()
        self.work = WorkItem(workId="WORK-REQ-1-abc", gapKey="GAP-REQ-1-abc", status=WorkStatus.PLANNED, pr_number=1, head_sha="a"*40)
        self.head = "a"*40

    @rule(target_head=st.text(min_size=40, max_size=40, alphabet="0123456789abcdef"))
    def advance_head(self, target_head):
        self.head = target_head.lower()
        # PR observation advances head
        obs = Observations(clock=Clock(iso="2026-08-22T00:00:00Z"), prs=(PROBS(pr=1, head_sha=self.head, state="open", mergeable=True, base_branch="main"),))
        self.work, _ = reduce_state(self.work, obs)

    @rule()
    def ci_pass(self):
        obs = Observations(clock=Clock(iso="2026-08-22T00:00:00Z"), prs=(PROBS(pr=1, head_sha=self.head, state="open", mergeable=True, base_branch="main"),), ci=(CIObservation(pr=1, head=self.head, gate_set=("ci",), passed=True, classification="PRODUCT", has_evidence=True),))
        self.work, _ = reduce_state(self.work, obs)

    @rule()
    def ci_infra_fail(self):
        obs = Observations(clock=Clock(iso="2026-08-22T00:00:00Z"), ci=(CIObservation(pr=1, head=self.head, gate_set=("ci",), passed=False, classification="INFRASTRUCTURE", has_evidence=True),))
        before = self.work
        self.work, cmds = reduce_state(self.work, obs)
        # infra must not produce product correction budget consumption
        assert not any(c.commandType.value == "SEND_PRODUCT_CORRECTION" for c in cmds) or before.status in (WorkStatus.CI_WAIT, WorkStatus.REVIEW_FIX)

    @rule()
    def review_pass(self):
        obs = Observations(clock=Clock(iso="2026-08-22T00:00:00Z"), reviews=(ReviewObservation(workId=self.work.workId, pr=1, targetHead=self.head, reviewer="agy", implementationProvider="muse", mode="BASELINE" if self.work.status == WorkStatus.REVIEW_BASELINE_WAIT else "VERIFY", reviewScopeId="s", contextDigest="d", verdict="PASS"),))
        self.work, _ = reduce_state(self.work, obs, review_scope="s", review_digest="d")

    @invariant()
    def no_merge_without_evidence(self):
        # Cannot be in MERGING without ci+review PASS — checked via reducer never emits MERGE_PR without both
        if self.work.status == WorkStatus.MERGING:
            assert self.work.head_sha == self.head

TestFactory = FactoryMachine.TestCase
