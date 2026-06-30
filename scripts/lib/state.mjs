import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "PI_CODEX_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const STATE_BACKUP_FILE_NAME = "state.json.bak";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

export class CorruptStateError extends Error {
  constructor(message, { cause, statePath } = {}) {
    super(message);
    this.name = "CorruptStateError";
    this.code = "CODEX_CORRUPT_STATE";
    this.statePath = statePath ?? null;
    if (cause) {
      this.cause = cause;
    }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveStateBackupFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_BACKUP_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function normalizeParsedState(parsed) {
  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
  };
}

function tryReadParsed(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, missing: true };
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return { ok: false, missing: false, error: new Error("state file is empty") };
    }
    return { ok: true, value: normalizeParsedState(JSON.parse(raw)) };
  } catch (error) {
    return { ok: false, missing: false, error };
  }
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  const primary = tryReadParsed(stateFile);
  if (primary.ok) {
    return primary.value;
  }

  // Primary state is unreadable. Try the rotated backup the previous
  // saveState wrote before its atomic rename. Falling silently back to
  // defaults would reset stopReviewGate to false and drop active jobs from
  // /codex:status and /codex:cancel — a fail-open recovery path. Prefer the
  // backup, otherwise raise loud so callers can refuse to proceed.
  const backupFile = resolveStateBackupFile(cwd);
  const backup = tryReadParsed(backupFile);
  if (backup.ok) {
    return backup.value;
  }

  throw new CorruptStateError(
    `Codex companion state file is unreadable and no usable backup is available: ${stateFile}`,
    { cause: primary.error, statePath: stateFile }
  );
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  const stateFile = resolveStateFile(cwd);
  const backupFile = resolveStateBackupFile(cwd);
  const tempFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(nextState, null, 2)}\n`;

  // Write to a sibling temp file, then atomically rename into place so a
  // crash mid-write cannot leave a truncated state.json. Rotate the
  // previous good copy to state.json.bak first so loadState has a fallback
  // if the rename ever happens to coincide with another reader observing a
  // half-written file on a non-POSIX filesystem.
  fs.writeFileSync(tempFile, payload, "utf8");
  try {
    if (fs.existsSync(stateFile)) {
      try {
        fs.copyFileSync(stateFile, backupFile);
      } catch {
        // Backup is best-effort; do not block a successful state write
        // because a previous file could not be copied.
      }
    }
    fs.renameSync(tempFile, stateFile);
  } catch (error) {
    try {
      fs.unlinkSync(tempFile);
    } catch {
      // Temp file may already be gone; ignore.
    }
    throw error;
  }

  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
