#!/bin/sh
set -eu

MODE="--validate-only"
TASK_ID=""
if [ "$#" -gt 0 ]; then
  MODE="$1"
  shift
fi
if [ "$MODE" = "--prepare-task" ]; then
  if [ "$#" -ne 1 ]; then
    printf '%s\n' "usage: tools/zcode/g0-preflight.sh --prepare-task <task-id>" >&2
    exit 2
  fi
  TASK_ID="$1"
elif [ "$MODE" != "--validate-only" ] || [ "$#" -ne 0 ]; then
  printf '%s\n' "usage: tools/zcode/g0-preflight.sh [--validate-only|--prepare-task <task-id>]" >&2
  exit 2
fi

EXPECTED_REMOTE="git@github.com:quantm-zeus/chain-sieve.git"
EXPECTED_TAG_OBJECT="a3bc4476b270efe911da12a4d649e3e5ebcdf69c"
EXPECTED_RELEASE="1027664eb708b4c1249dda5f1c33f5129946ab3e"
EXPECTED_TREE="706e400d3eb5c41a95209523bb034f2e2c60bd34"
EXPECTED_BRANCH="cluster/g0"
EXPECTED_WORKTREE="/Users/quantm/Documents/My Projects/chain-sieve-worktrees/g0"

ROOT="$(git rev-parse --show-toplevel)"
if [ "$ROOT" != "$EXPECTED_WORKTREE" ]; then
  printf '%s\n' "FAIL:CANONICAL_WORKTREE_REQUIRED:$ROOT" >&2
  exit 1
fi
if [ "$(git remote get-url origin)" != "$EXPECTED_REMOTE" ]; then
  printf '%s\n' "FAIL:REPOSITORY_IDENTITY" >&2
  exit 1
fi
if [ "$(git rev-parse refs/tags/harness-v1.0.1)" != "$EXPECTED_TAG_OBJECT" ]; then
  printf '%s\n' "FAIL:RELEASE_TAG_OBJECT" >&2
  exit 1
fi
if [ "$(git rev-parse 'refs/tags/harness-v1.0.1^{}')" != "$EXPECTED_RELEASE" ]; then
  printf '%s\n' "FAIL:RELEASE_TARGET" >&2
  exit 1
fi
if [ "$(git show -s --format=%T "$EXPECTED_RELEASE")" != "$EXPECTED_TREE" ]; then
  printf '%s\n' "FAIL:RELEASE_TREE" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$EXPECTED_RELEASE" refs/remotes/origin/main; then
  printf '%s\n' "FAIL:RELEASE_NOT_IN_ORIGIN_MAIN" >&2
  exit 1
fi
if [ "$(git branch --show-current)" != "$EXPECTED_BRANCH" ]; then
  printf '%s\n' "FAIL:CANONICAL_BRANCH_REQUIRED" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  printf '%s\n' "FAIL:DIRTY_CANONICAL_WORKTREE" >&2
  exit 1
fi

STATE_PATH="$(git rev-parse --git-common-dir)/ciag-runtime/task-state.json"
STATE_BEFORE="$(shasum -a 256 "$STATE_PATH" | awk '{print $1}')"
HEAD_BEFORE="$(git rev-parse HEAD)"
TREE_BEFORE="$(git rev-parse HEAD^{tree})"
STATUS_BEFORE="$(git status --porcelain)"

pnpm spec:verify >/dev/null
pnpm cluster:ready >/dev/null
pnpm exec tsx tools/zcode/generate-g0-readiness.ts --validate-only >/dev/null

STATE_AFTER="$(shasum -a 256 "$STATE_PATH" | awk '{print $1}')"
if [ "$STATE_BEFORE" != "$STATE_AFTER" ]; then
  printf '%s\n' "FAIL:VALIDATE_ONLY_STATE_MUTATION" >&2
  exit 1
fi
if [ "$HEAD_BEFORE" != "$(git rev-parse HEAD)" ] || [ "$TREE_BEFORE" != "$(git rev-parse HEAD^{tree})" ]; then
  printf '%s\n' "FAIL:VALIDATE_ONLY_GIT_MUTATION" >&2
  exit 1
fi
if [ "$STATUS_BEFORE" != "$(git status --porcelain)" ]; then
  printf '%s\n' "FAIL:VALIDATE_ONLY_WORKTREE_MUTATION" >&2
  exit 1
fi

if [ "$MODE" = "--validate-only" ]; then
  printf '%s\n' "release baseline PASS"
  printf '%s\n' "canonical branch PASS"
  printf '%s\n' "worktree PASS"
  printf '%s\n' "task inventory PASS"
  printf '%s\n' "context hashes PASS"
  printf '%s\n' "goal hashes PASS"
  printf '%s\n' "command validation PASS"
  printf '%s\n' "lease preflight PASS"
  printf '%s\n' "path-lock preflight PASS"
  printf '%s\n' "no mutation PASS"
  exit 0
fi

if ! node -e "
const fs=require('fs');
const inventory=JSON.parse(fs.readFileSync('artifacts/handoff/G0/g0-task-inventory.json','utf8'));
const task=inventory.tasks.find((item)=>item.taskId===process.argv[1]);
if(!task||task.currentState!=='READY')process.exit(1);
" "$TASK_ID"; then
  printf '%s\n' "FAIL:TASK_NOT_READY:$TASK_ID" >&2
  exit 1
fi

WORKTREE_JSON="$(pnpm --silent worktree:create "$TASK_ID")"
TASK_WORKTREE="$(printf '%s' "$WORKTREE_JSON" | node -e "
let value='';
process.stdin.on('data',(chunk)=>value+=chunk).on('end',()=>process.stdout.write(JSON.parse(value).target));
")"
(
  cd "$TASK_WORKTREE"
  pnpm install --frozen-lockfile >/dev/null
  LEASE_JSON="$(pnpm --silent task:acquire "$TASK_ID" --holder zcode-g0)"
  printf '%s' "$LEASE_JSON" | node -e "
const fs=require('fs');
let value='';
process.stdin.on('data',(chunk)=>value+=chunk).on('end',()=>{
  const lease=JSON.parse(value);
  if(lease.fencingVersion<1||lease.state!=='ACTIVE')throw new Error('LEASE_FENCE_INVALID');
  const common=require('child_process').execFileSync('git',['rev-parse','--git-common-dir'],{encoding:'utf8'}).trim();
  const root=require('path').resolve(process.cwd(),common,'ciag-runtime','launch-receipts');
  fs.mkdirSync(root,{recursive:true});
  const receipt={
    schemaVersion:'1.0.0',
    clusterId:'C-G0-IMPLEMENTATION',
    canonicalBranch:'cluster/g0',
    taskId:lease.taskId,
    holder:lease.holder,
    leaseId:lease.leaseId,
    fencingVersion:lease.fencingVersion,
    expiresAt:lease.expiresAt,
    baseCommit:require('child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    baseTree:require('child_process').execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),
    taskBranch:require('child_process').execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),
    taskWorktree:process.cwd(),
    goalPath:require('path').join(process.cwd(),'artifacts/handoff/G0/goals',lease.taskId+'.zcode-goal.md'),
    pathLocks:'acquired atomically with the fenced task lease',
    zcodeStarted:false
  };
  const path=require('path').join(root,lease.taskId+'.launch-receipt.json');
  fs.writeFileSync(path,JSON.stringify(receipt,null,2)+'\\n',{mode:0o600});
  process.stdout.write(JSON.stringify({receiptPath:path,...receipt}));
});
" > /tmp/chainsieve-g0-launch-receipt.json
)

node -e "
const receipt=JSON.parse(require('fs').readFileSync('/tmp/chainsieve-g0-launch-receipt.json','utf8'));
console.log('TASK_WORKSPACE='+receipt.taskWorktree);
console.log('TASK_GOAL='+receipt.goalPath);
console.log('LAUNCH_RECEIPT='+receipt.receiptPath);
console.log('LEASE_ID='+receipt.leaseId);
console.log('FENCING_VERSION='+receipt.fencingVersion);
console.log('ZCODE_STARTED=false');
"
