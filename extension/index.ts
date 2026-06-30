import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type NotifyCtx = Pick<ExtensionContext, "ui">;

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(EXTENSION_DIR, "..");
const COMPANION_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "codex-companion.mjs");
const SESSION_HOOK = path.join(PACKAGE_ROOT, "scripts", "session-lifecycle-hook.mjs");
const STOP_REVIEW_PROMPT_FILE = path.join(PACKAGE_ROOT, "prompts", "stop-review-gate.md");

const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const PLUGIN_ROOT_ENV = "PI_CODEX_ROOT";
const LEGACY_ROOT_ENV = "CLAUDE_PLUGIN_ROOT";

function generateSessionId(): string {
  return `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function applyRuntimeEnv(): void {
  process.env[PLUGIN_ROOT_ENV] = PACKAGE_ROOT;
  process.env[LEGACY_ROOT_ENV] = PACKAGE_ROOT;
  if (!process.env[PLUGIN_DATA_ENV]) {
    process.env[PLUGIN_DATA_ENV] = path.join(PACKAGE_ROOT, ".data");
  }
  if (!process.env[SESSION_ID_ENV]) {
    process.env[SESSION_ID_ENV] = generateSessionId();
  }
}

function splitArgs(raw: string): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parts;
}

type RunResult = { code: number; stdout: string; stderr: string };

function runCompanion(subcmd: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(process.execPath, [COMPANION_SCRIPT, subcmd, ...args], {
    cwd,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function runHook(scriptPath: string, eventName: string, input: Record<string, unknown>, cwd: string): RunResult {
  const result = spawnSync(process.execPath, [scriptPath, eventName], {
    cwd,
    env: process.env,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 16 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024
  });
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? "")
  };
}

function renderResult(ctx: NotifyCtx, label: string, result: RunResult): void {
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  if (out) {
    ctx.ui.notify(out, result.code === 0 ? "info" : "warning");
  }
  if (err && result.code !== 0) {
    ctx.ui.notify(`[${label}] ${err}`, "error");
  }
  if (!out && !err && result.code !== 0) {
    ctx.ui.notify(`[${label}] command exited with code ${result.code}`, "error");
  }
}

export default function (pi: ExtensionAPI): void {
  applyRuntimeEnv();

  pi.on("session_start", async (_event, ctx) => {
    applyRuntimeEnv();
    const sessionId = process.env[SESSION_ID_ENV] ?? generateSessionId();
    process.env[SESSION_ID_ENV] = sessionId;
    runHook(SESSION_HOOK, "SessionStart", {
      session_id: sessionId,
      cwd: ctx.cwd
    }, ctx.cwd);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = process.env[SESSION_ID_ENV] ?? "";
    runHook(SESSION_HOOK, "SessionEnd", {
      session_id: sessionId,
      cwd: ctx.cwd
    }, ctx.cwd);
  });

  pi.registerCommand("codex:status", {
    description: "Show running and recent Codex jobs for this repo",
    handler: async (args, ctx) => {
      const result = runCompanion("status", splitArgs(args ?? ""), ctx.cwd);
      renderResult(ctx, "codex:status", result);
    }
  });

  pi.registerCommand("codex:result", {
    description: "Display the final Codex output and session ID for a finished job",
    handler: async (args, ctx) => {
      const result = runCompanion("result", splitArgs(args ?? ""), ctx.cwd);
      renderResult(ctx, "codex:result", result);
    }
  });

  pi.registerCommand("codex:cancel", {
    description: "Cancel an active background Codex job",
    handler: async (args, ctx) => {
      const result = runCompanion("cancel", splitArgs(args ?? ""), ctx.cwd);
      renderResult(ctx, "codex:cancel", result);
    }
  });

  pi.registerCommand("codex:setup", {
    description: "Check Codex install/auth and toggle the optional review gate",
    handler: async (args, ctx) => {
      const setupArgs = ["--json", ...splitArgs(args ?? "")];
      const result = runCompanion("setup", setupArgs, ctx.cwd);
      renderResult(ctx, "codex:setup", result);
    }
  });

  pi.registerCommand("codex:gate", {
    description: "Run a Codex stop-time review of the current uncommitted work and emit ALLOW/BLOCK",
    handler: async (_args, ctx) => {
      applyRuntimeEnv();

      const setup = runCompanion("setup", ["--json"], ctx.cwd);
      if (setup.code !== 0) {
        ctx.ui.notify(
          `[codex:gate] Codex is not set up. Run /codex:setup. ${setup.stderr.trim() || setup.stdout.trim()}`,
          "error"
        );
        return;
      }
      let setupReady = false;
      try {
        setupReady = JSON.parse(setup.stdout)?.ready === true;
      } catch {
        setupReady = false;
      }
      if (!setupReady) {
        ctx.ui.notify(
          "[codex:gate] Codex is not ready. Run /codex:setup to authenticate before invoking the gate.",
          "error"
        );
        return;
      }

      let prompt: string;
      try {
        prompt = fs.readFileSync(STOP_REVIEW_PROMPT_FILE, "utf8")
          .replace(/\{\{CLAUDE_RESPONSE_BLOCK\}\}/g, "");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`[codex:gate] Failed to load stop-review prompt: ${message}`, "error");
        return;
      }

      const taskResult = runCompanion("task", ["--json", prompt], ctx.cwd);
      if (taskResult.code !== 0) {
        ctx.ui.notify(
          `[codex:gate] Codex task failed (exit ${taskResult.code}): ${taskResult.stderr.trim() || taskResult.stdout.trim()}`,
          "error"
        );
        return;
      }

      let rawOutput = "";
      try {
        rawOutput = String(JSON.parse(taskResult.stdout)?.rawOutput ?? "").trim();
      } catch {
        ctx.ui.notify(
          "[codex:gate] Codex returned invalid JSON. The gate cannot be verified — treat as a failure and run /codex:review --wait manually.",
          "error"
        );
        return;
      }

      if (!rawOutput) {
        ctx.ui.notify(
          "[codex:gate] Codex returned an empty review. The gate cannot be verified — run /codex:review --wait manually.",
          "error"
        );
        return;
      }

      const firstLine = rawOutput.split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (firstLine.startsWith("ALLOW:")) {
        ctx.ui.notify(`[codex:gate] ${firstLine}`, "info");
        return;
      }
      if (firstLine.startsWith("BLOCK:")) {
        ctx.ui.notify(`[codex:gate] ${rawOutput}`, "warning");
        return;
      }

      ctx.ui.notify(
        `[codex:gate] Unexpected gate output (no ALLOW/BLOCK prefix). Treat as a failure.\n${rawOutput}`,
        "error"
      );
    }
  });

  pi.registerTool({
    name: "codex_ask",
    label: "Codex ask",
    description:
      "Ask the user a single multiple-choice question. Use when a Codex command needs the user to pick wait-vs-background or resume-vs-fresh. Returns the chosen label.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to display to the user" }),
      options: Type.Array(Type.String(), {
        description: "Mutually exclusive choices. Put the recommended option first."
      })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const choice = await ctx.ui.select(params.question, params.options);
      const value = choice ?? params.options[0] ?? "";
      return {
        content: [{ type: "text", text: value }],
        details: { question: params.question, options: params.options, chosen: value }
      };
    }
  });
}

