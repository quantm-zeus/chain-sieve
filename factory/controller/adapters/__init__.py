"""Adapters — thin wrappers, one owner per side-effect type."""
from __future__ import annotations

# github adapter — only code path allowed to CREATE_ISSUE / MERGE_PR
# ao adapter — only code path allowed to START_WORKER / TRIGGER_REVIEW
# git adapter — local git queries

# Enforced by architecture test: only adapters/* may import network/github.
