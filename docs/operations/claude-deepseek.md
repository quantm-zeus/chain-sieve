# Claude Code with DeepSeek (legacy, superseded)

> This provider path is not part of the production OSS factory. Use `docs/operations/oss-factory.md` for the current Muse/Antigravity architecture.

ChainSieve supports Claude Code CLI as the explicit `claude-deepseek` agent provider. Antigravity remains the default provider.

## Install

Install Claude Code and confirm it is available:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

## Configure credentials

Set the DeepSeek API key in the shell that launches ChainSieve:

```bash
export DEEPSEEK_API_KEY='<DeepSeek API key>'
```

`ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are accepted as compatibility inputs. ChainSieve maps the credential only into the Claude Code child process and does not place it in prompts, launch receipts, command arguments, or logs.

The provider enforces the DeepSeek Anthropic endpoint:

```text
https://api.deepseek.com/anthropic
```

Default model routing follows DeepSeek's Claude Code integration guidance:

```text
ANTHROPIC_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
CLAUDE_CODE_EFFORT_LEVEL=max
```

Override the primary or fast model without changing source:

```bash
export CHAINSIEVE_CLAUDE_DEEPSEEK_MODEL='deepseek-v4-pro[1m]'
export CHAINSIEVE_CLAUDE_DEEPSEEK_FAST_MODEL='deepseek-v4-flash'
```

## Verify

Run the provider-aware preflight:

```bash
pnpm autopilot -- --doctor --provider claude-deepseek
```

The doctor verifies the Claude Code executable, required headless flags, and credential presence without printing the key.

## Run

Run the interactive agent launcher:

```bash
pnpm claude-deepseek
```

Run one bounded autopilot cycle:

```bash
pnpm autopilot -- --provider claude-deepseek --max-cycles 1
```

The provider uses Claude Code print mode with streamed JSON, bounded turns, explicit workspace-local instructions, and tool allow/deny rules. It permits repository reads, task-worktree edits, tests, and the single task commit. It denies remote push, merge, rebase, reset, clean, GitHub CLI, recursive removal, and sudo operations.

Do not use `--dangerously-skip-permissions`.
