import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  CorruptStateError,
  loadState,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateBackupFile,
  resolveStateDir,
  resolveStateFile,
  saveState
} from "../scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const previousPluginDataDir = process.env.PI_CODEX_DATA;
  delete process.env.PI_CODEX_DATA;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.PI_CODEX_DATA;
    } else {
      process.env.PI_CODEX_DATA = previousPluginDataDir;
    }
  }
});

test("resolveStateDir uses PI_CODEX_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.PI_CODEX_DATA;
  process.env.PI_CODEX_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.PI_CODEX_DATA;
    } else {
      process.env.PI_CODEX_DATA = previousPluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("loadState throws CorruptStateError instead of resetting jobs and gate when state.json is unreadable", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [{ id: "job-1", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }]
  });
  const stateFile = resolveStateFile(workspace);
  fs.writeFileSync(stateFile, "{ this is not json", "utf8");
  // Wipe the rotated backup so loadState has no fallback.
  fs.rmSync(resolveStateBackupFile(workspace), { force: true });

  assert.throws(() => loadState(workspace), (error) => {
    return error instanceof CorruptStateError && error.code === "CODEX_CORRUPT_STATE";
  });
});

test("loadState falls back to state.json.bak when state.json is corrupt and the backup is intact", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [{ id: "job-1", status: "running", updatedAt: "2026-01-01T00:00:00.000Z" }]
  });
  // Mutate state so saveState rotates the previous good copy into state.json.bak.
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: [{ id: "job-2", status: "completed", updatedAt: "2026-01-02T00:00:00.000Z" }]
  });

  fs.writeFileSync(resolveStateFile(workspace), "<<truncated>>", "utf8");

  const recovered = loadState(workspace);
  assert.equal(recovered.config.stopReviewGate, true);
  assert.equal(recovered.jobs.length, 1);
  assert.equal(recovered.jobs[0].id, "job-1");
});

test("saveState writes via temp+rename so a crashed write cannot leave a partial state.json", () => {
  const workspace = makeTempDir();
  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: true },
    jobs: []
  });
  const stateDir = resolveStateDir(workspace);
  const leftover = fs.readdirSync(stateDir).filter((entry) => entry.endsWith(".tmp"));
  assert.deepEqual(leftover, [], "no leftover temp files after a successful save");
});
