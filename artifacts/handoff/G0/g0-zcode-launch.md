# G0 desktop ZCode launch package

The canonical workspace is `/Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0` on `cluster/g0`.

Validation only:

```sh
tools/zcode/g0-preflight.sh --validate-only
```

After separate owner authorization, prepare one task:

```sh
tools/zcode/g0-preflight.sh --prepare-task T-G0-CORE
```

The preparation step creates the task worktree, acquires one bounded fenced lease with integrated path locks, writes a runtime launch receipt, and prints the exact task workspace and goal path. It does not start ZCode or enter `IMPLEMENTING`.
