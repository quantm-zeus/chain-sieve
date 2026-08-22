"""GitHub adapter — single owner for CREATE_ISSUE, MERGE_PR."""
from __future__ import annotations

from typing import Any
from ..commands import Command

# This module is the ONLY place that may call GitHub API for mutation.
# Architecture test enforces uniqueness.
