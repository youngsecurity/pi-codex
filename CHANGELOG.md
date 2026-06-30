# Changelog

## 0.1.3-ys

### Fork maintenance — Pi terminology cleanup

Removed inherited harness-specific terminology from user-facing runtime output, prompts, docs, tests, and tracked paths so the package consistently describes Pi/current-session behavior.

#### Changes

- `/codex:setup` and `/codex:status` now describe the shared Codex runtime as the current session runtime.
- Stop-gate review prompts now refer to the previous assistant turn and previous assistant response.
- Runtime environment names now use Pi Codex names such as `PI_CODEX_DATA`, `PI_CODEX_ROOT`, `PI_CODEX_ENV_FILE`, and `PI_CODEX_PROJECT_DIR`.
- The app-server client identity is now `Pi Codex`.
- Documentation now reflects the maintained fork install path, maintained Pi package name, current dependency layout, and Pi-neutral runtime behavior.
- Removed the obsolete package metadata directory whose path referenced the source harness.

## 0.1.2-ys

### Fork maintenance — security patch

Patched the `youngsecurity/pi-codex` fork to stop declaring the deprecated `@mariozechner/pi-coding-agent` package as an install-time peer dependency, eliminating npm audit findings:

- **GHSA-jfgx-wxx8-mp94** (high): predictable temporary extension install paths allow local privilege escalation on shared Linux hosts.
- **GHSA-7v5m-pr3q-6453** (low): potential XSS in HTML session exports via Markdown URL sanitization bypass.
- **GHSA-r95r-rj6r-c39x** (low): auth.json write race could expose stored credentials.

Modern npm auto-installs peer dependencies at install time. The extension should not require npm to install a Pi harness at runtime because the host Pi runtime provides the extension API at load time, and the current `import type` is erased from emitted JavaScript.

#### Changes

- `extension/index.ts` now imports Pi extension types from `@earendil-works/pi-coding-agent` instead of the deprecated `@mariozechner/pi-coding-agent` package.
- `package.json` no longer declares any Pi harness package as a peer dependency; `@earendil-works/pi-coding-agent` is now a development-time dependency for typechecking only.
- `package.json` now declares `typebox` as a runtime dependency (moved from peer) and updates dev dependencies to `@types/node@26.0.1` and `typescript@6.0.3`.

Pi package behavior (extension, prompts, skills, Codex companion runtime) is unchanged.

## 0.1.0

- Initial port of the upstream OpenAI Codex package integration to the pi-coding-agent runtime.
- Reuses the upstream Node.js companion runtime (`scripts/codex-companion.mjs` and `scripts/lib/*.mjs`) with targeted fork patches.
- Adds a Pi extension (`extension/index.ts`) that wires `session_start` / `session_shutdown` lifecycle, registers the `codex_ask` interactive tool, and provides extension-native commands `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`, `/codex:gate`.
- Adds Pi prompt templates for the model-driven flows: `/codex:review`, `/codex:adversarial-review`, `/codex:rescue`.
- Adds three internal skills (`codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting`) tagged `disable-model-invocation: true`.
- Replaces the automatic stop hook with a manual `/codex:gate` command. The pi-codex gate **never fails open**: it always runs a real Codex task, errors out cleanly if Codex is not set up, and treats any non-`ALLOW:` / non-`BLOCK:` output as a failure rather than a pass.
- Sets `PI_CODEX_ROOT` to the package install directory so the companion runtime can locate prompts, schemas, scripts, and package data.

### Runtime patches (diverges from upstream codex-plugin-cc)

These fixes patch concurrency bugs flagged by an adversarial Codex review of the v0.1.0 port. The patched files are no longer byte-identical to upstream.

- `scripts/lib/codex.mjs` — `withAppServer` no longer falls back to a direct (broker-less) Codex runtime when the shared broker returns `BROKER_BUSY`. Direct fallback is now reserved for endpoints that are dead before any request is accepted (`ENOENT` / `ECONNREFUSED`). Concurrent `BROKER_BUSY` is surfaced as a `CODEX_BROKER_BUSY` error with a clear "wait or cancel" message instead of silently starting a parallel app-server that could race the active stream into the same worktree.
- `scripts/codex-companion.mjs` — `enqueueBackgroundTask` now persists the queued job record **before** spawning the detached worker, so the worker can never start before its job file exists. Spawn failures are caught synchronously and the asynchronous `error` event is also handled, marking the job as `failed` with a useful error message instead of leaving a permanently queued task with a dead pid.
- `scripts/lib/process.mjs` — `terminateProcessTree` on POSIX now falls back to a direct `kill(pid)` when the process-group `kill(-pid)` returns `ESRCH`. The recorded pid for a `nohup ... &` background launch may be a child rather than a process-group leader, in which case the previous code reported `delivered: false` and a write-capable Codex run could keep running and modifying the worktree after `/codex:cancel` thought it had stopped.
- `scripts/lib/state.mjs` — state writes are now atomic (temp file + rename) and rotate the previous good copy into `state.json.bak`. `loadState` falls back to the rotated backup when the live state file is unreadable, and raises a typed `CorruptStateError` instead of silently returning defaults when both copies are corrupt. The previous behavior would reset `stopReviewGate` to `false` and drop active jobs from `/codex:status` and `/codex:cancel` after any partial write or parse failure — a fail-open recovery path for the exact metadata used to enforce review and stop running work.
