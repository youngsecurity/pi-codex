# pi-codex

Use [Codex](https://github.com/openai/codex) from inside Pi to review code or delegate tasks. This fork packages the Codex companion runtime as a Pi extension with prompt templates, commands, and local job tracking.

Current fork package version: `0.1.3-ys`.

## What it adds

| Command | What it does |
|---|---|
| `/codex:review` | Run a Codex code review against local git state |
| `/codex:adversarial-review` | Run a Codex review that challenges design choices and assumptions |
| `/codex:rescue [task]` | Delegate a substantial debugging or implementation task to Codex |
| `/codex:status` | List running and recent Codex jobs for the current repo |
| `/codex:result <id>` | Print the final Codex output for a finished job |
| `/codex:cancel <id>` | Cancel an active background Codex job |
| `/codex:setup` | Check Codex install/auth status and toggle the optional review gate |
| `/codex:gate` | Run a stop-time Codex review of the previous assistant turn (opt-in) |

The review, adversarial review, and rescue commands are Pi prompt templates. They estimate review size, ask whether to wait or run in the background through the `codex_ask` interactive tool, and then forward the request to the companion runtime.

The status, result, cancel, setup, and gate commands are extension-registered commands. They run the companion runtime directly, without requiring an extra model turn.

## Requirements

- Node.js 18.18+
- A local `codex` binary on `PATH` and working Codex authentication; run `/codex:setup` to verify
- Pi installed from the maintained package, for example:

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

## Install

Install the maintained fork from GitHub:

```bash
pi install git:github.com/youngsecurity/pi-codex
```

Or install from a local checkout while developing:

```bash
pi install /path/to/pi-codex
```

After install, run any `/codex:*` command inside Pi.

## How it works

On `session_start`, the extension sets `PI_CODEX_ROOT` to the package directory and `PI_CODEX_DATA` to the package data directory if it is not already set. It then runs `scripts/session-lifecycle-hook.mjs SessionStart`. On `session_shutdown`, it runs the same lifecycle hook with `SessionEnd`.

The deterministic commands (`status`, `result`, `cancel`, `setup`, and `gate`) are registered with `pi.registerCommand(...)` and spawn `scripts/codex-companion.mjs` directly. The model-driven prompt templates (`review`, `adversarial-review`, and `rescue`) preserve raw slash-command arguments and forward to:

```bash
node "${PI_CODEX_ROOT}/scripts/codex-companion.mjs" <subcmd>
```

Job state is scoped to the current workspace and current Pi session. When a shared Codex runtime is available, setup/status output describes it as the current session runtime.

## Package notes

- The pre-ship review gate is opt-in via `/codex:gate`.
- Pi package prompts provide the rescue forwarding flow directly.
- `codex_ask` wraps Pi's interactive selection UI for wait-vs-background prompts.
- The maintained fork removes the deprecated Pi peer dependency that caused npm to auto-install the old harness package during Pi installs.
- Runtime patches keep brokered Codex runs from falling back to unsafe parallel app-server launches and make background job persistence/cancellation more reliable. See `CHANGELOG.md` for details.

## Development

```bash
npm install
npm run typecheck
npm test
npm audit
```

## License

Apache-2.0. Original work copyright OpenAI; Pi Codex fork modifications copyright diogo. See `LICENSE` and `NOTICE`.
