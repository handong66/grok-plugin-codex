import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../plugins/grok-plugin-codex/src/job-store.js";
import { runJobWorker } from "../plugins/grok-plugin-codex/src/job-worker.js";
import { createPathRedactor } from "../plugins/grok-plugin-codex/src/redact.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";
import { makeExecutable, tempDir } from "./helpers.js";

const JOB_ID = "job_1700000000000_abcdef12";

/** The store redacts against its own env, which inherits HOME from this process. */
function homeDir(): string {
  return process.env.HOME ?? homedir();
}

/** runJobWorker spawns its launcher as a child, so the state dir must travel through the env. */
function storeOptions(stateDir: string) {
  return { stateDir, env: { GROK_PLUGIN_STATE_DIR: stateDir } };
}

/** A Grok stand-in that streams until it is killed, so a wall-clock timeout is the only exit. */
async function streamingGrok(dir: string, name = "streaming-grok.mjs"): Promise<string> {
  return await makeExecutable(
    join(dir, name),
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('grok fake 1.0.3'); process.exit(0); }",
      "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
      "const chunk = 'x'.repeat(4096);",
      "setInterval(() => console.log(JSON.stringify({ type: 'text', data: chunk })), 5);"
    ].join("\n")
  );
}

async function seedJob(store: JobStore, command: string, cwd: string, timeoutMs: number): Promise<JobRecord> {
  const record: JobRecord = {
    id: JOB_ID,
    kind: "run",
    status: "queued",
    cwd,
    command,
    args: ["--cwd", cwd, "--output-format", "streaming-json"],
    createdAt: new Date().toISOString(),
    timeoutMs,
    processToken: randomUUID(),
    workerPid: process.pid
  };
  await store.write(record);
  await writeFile(store.inputPath(JOB_ID), "teardown probe", { mode: 0o600 });
  return record;
}

/** Breaks the log paths mid-run so the teardown block throws while flushing. */
class BrokenLogStore extends JobStore {
  breakLogs = false;

  override stdoutPath(jobId: string): string {
    const path = super.stdoutPath(jobId);
    return this.breakLogs ? join(path, "unwritable") : path;
  }
}

/** Fails the first terminal write, i.e. after classification has already decided the outcome. */
class FailingTerminalWriteStore extends JobStore {
  injected = false;

  override async write(next: JobRecord): Promise<void> {
    if (!this.injected && ["succeeded", "failed", "cancelled"].includes(next.status)) {
      this.injected = true;
      throw new Error("injected terminal write failure");
    }
    await super.write(next);
  }
}

describe("worker teardown classification", () => {
  it("records a timeout as timeout even when log teardown fails", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const store = new BrokenLogStore(storeOptions(stateDir));
    const grokBin = await streamingGrok(dir);
    await seedJob(store, grokBin, dir, 700);

    const breaker = setTimeout(() => {
      store.breakLogs = true;
    }, 250);
    try {
      await runJobWorker(JOB_ID, store);
    } finally {
      clearTimeout(breaker);
    }

    const record = await store.read(JOB_ID);
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("timeout");
    // GK4: the largest failure class names its recovery instead of restating the budget the caller
    // set; the budget itself stays machine-readable in details.
    expect(record.error?.message).toContain("grok_finalize");
    expect(record.error?.message).not.toMatch(/narrow/i);
    expect(record.error?.details?.timeoutMs).toBe(700);
    expect(String(record.error?.details?.teardownError)).toMatch(/ENOTDIR|ENOENT|EEXIST|not a directory/i);
    // docs/privacy.md promises public results carry no state-file paths; the errno and the artifact
    // name survive redaction, the location does not.
    expect(String(record.error?.details?.teardownError)).toContain("<state>/jobs/");
    expect(String(record.error?.details?.teardownError)).not.toContain(stateDir);
  }, 20_000);

  it("classifies a post-teardown failure by the timeout flag instead of worker_error", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const store = new FailingTerminalWriteStore(storeOptions(stateDir));
    const grokBin = await streamingGrok(dir);
    await seedJob(store, grokBin, dir, 500);

    await expect(runJobWorker(JOB_ID, store)).rejects.toThrow("injected terminal write failure");

    const record = await store.read(JOB_ID);
    expect(record.status).toBe("failed");
    expect(record.error?.code).toBe("timeout");
    // Teardown also failing is a diagnostic, not a different recovery: same remedy, and the
    // teardown fact moves into details where a caller can branch on it.
    expect(record.error?.message).toContain("grok_finalize");
    expect(record.error?.details?.teardownFailed).toBe(true);
    expect(record.error?.details?.phase).toBe("worker");
    expect(String(record.error?.details?.errorMessage)).toContain("injected terminal write failure");
    expect(record.error?.details?.errorName).toBe("Error");
    expect(String(record.error?.details?.stackTail)).toContain("Error");
    // The stack names local files; the caller must not learn where this machine keeps them.
    expect(String(record.error?.details?.stackTail)).not.toContain(homeDir());
  }, 20_000);

  it("classifies a post-teardown failure on a cancelled job as cancelled", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const store = new FailingTerminalWriteStore(storeOptions(stateDir));
    const grokBin = await streamingGrok(dir);
    await seedJob(store, grokBin, dir, 20_000);

    // Cancel through a separate store so the injected failure is spent on the worker's own write.
    const canceller = new JobStore(storeOptions(stateDir));
    const cancel = setTimeout(() => void canceller.cancel(JOB_ID).catch(() => undefined), 300);
    try {
      await expect(runJobWorker(JOB_ID, store)).rejects.toThrow("injected terminal write failure");
    } finally {
      clearTimeout(cancel);
    }

    const record = await store.read(JOB_ID);
    expect(record.status).toBe("cancelled");
  }, 25_000);
});

describe("worker stderr capture", () => {
  it("keeps a private per-job worker log in the strict layout and cleans it up", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const terminal: JobRecord = {
      id: JOB_ID,
      kind: "run",
      status: "failed",
      cwd: "/repo",
      command: "grok",
      args: [],
      createdAt: "2026-07-08T00:00:00.000Z",
      finishedAt: "2026-07-08T00:00:00.000Z",
      timeoutMs: 1_000
    };
    await store.write(terminal);
    await writeFile(store.workerLogPath(JOB_ID), "worker stderr line\n", { mode: 0o600 });

    expect((await stat(store.workerLogPath(JOB_ID))).mode & 0o777).toBe(0o600);

    await store.cleanupExpiredJobs(Date.parse("2026-08-08T00:00:00.000Z"));

    await expect(stat(store.workerLogPath(JOB_ID))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts a pre-marker layout that already contains a worker log", async () => {
    const stateDir = await tempDir();
    const jobsDir = join(stateDir, "jobs");
    await mkdir(jobsDir, { mode: 0o700 });
    const terminal = {
      id: JOB_ID,
      kind: "run",
      status: "succeeded",
      cwd: "/repo",
      command: "grok",
      args: [],
      createdAt: "2026-07-08T00:00:00.000Z",
      timeoutMs: 1_000
    };
    await writeFile(join(jobsDir, `${JOB_ID}.json`), `${JSON.stringify(terminal)}\n`, { mode: 0o600 });
    await writeFile(join(jobsDir, `${JOB_ID}.worker.log`), "stderr from a previous release\n", { mode: 0o600 });
    const store = new JobStore(stateDir);

    await store.ensure();

    expect((await store.read(JOB_ID)).status).toBe("succeeded");
  });

  it("surfaces the worker log tail when a worker dies without recording a result", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const running: JobRecord = {
      id: JOB_ID,
      kind: "run",
      status: "running",
      cwd: "/repo",
      command: "grok",
      args: [],
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 1_000,
      workerPid: 999_999_999
    };
    await store.write(running);
    await writeFile(store.workerLogPath(JOB_ID), "TypeError: the worker exploded here\n", { mode: 0o600 });

    const reconciled = await store.status(JOB_ID);

    expect(reconciled.status).toBe("failed");
    expect(reconciled.error?.code).toBe("worker_unavailable");
    expect(String(reconciled.error?.details?.workerLogTail)).toContain("the worker exploded here");
  });

  it("redacts state, install, and home paths out of the worker log tail", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const running: JobRecord = {
      id: JOB_ID,
      kind: "run",
      status: "running",
      cwd: "/repo",
      command: "grok",
      args: [],
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      timeoutMs: 1_000,
      workerPid: 999_999_999
    };
    await store.write(running);
    // Raw Node stderr, i.e. exactly the shape a crashing worker writes.
    await writeFile(
      store.workerLogPath(JOB_ID),
      [
        `Error: ENOENT: no such file or directory, open '${join(stateDir, "jobs", `${JOB_ID}.json`)}'`,
        `    at file://${store.workerPath}:1:1`,
        `    at ${homeDir()}/projects/thing.js:2:2`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    const reconciled = await store.status(JOB_ID);
    const tail = String(reconciled.error?.details?.workerLogTail);

    expect(tail).toContain("ENOENT: no such file or directory");
    expect(tail).toContain("<state>/jobs/");
    expect(tail).toContain("<home>/projects/thing.js");
    expect(tail).not.toContain(stateDir);
    expect(tail).not.toContain(homeDir());
    expect(tail).not.toContain(store.workerPath);
  });

  it("prefers the longest matching root and does not eat a sibling directory name", () => {
    const redact = createPathRedactor([
      { path: "/home/user", label: "<home>" },
      { path: "/home/user/.local/state/grok-plugin-codex/", label: "<state>" },
      { path: "/", label: "<ignored>" }
    ]);

    expect(redact("open '/home/user/.local/state/grok-plugin-codex/jobs/job_x.json'")).toBe(
      "open '<state>/jobs/job_x.json'"
    );
    expect(redact("at /home/user/projects/app.js:1:1")).toBe("at <home>/projects/app.js:1:1");
    // `/home/user` must not rewrite `/home/username`, and `/` must never rewrite everything.
    expect(redact("/home/username/other")).toBe("/home/username/other");
    expect(redact("/etc/hosts")).toBe("/etc/hosts");
  });

  it("does not delete a worker log that still belongs to an unfinished job", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    const running: JobRecord = {
      id: JOB_ID,
      kind: "run",
      status: "running",
      cwd: "/repo",
      command: "grok",
      args: [],
      createdAt: old.toISOString(),
      startedAt: old.toISOString(),
      timeoutMs: 1_000
    };
    await store.write(running);
    await writeFile(store.workerLogPath(JOB_ID), "still running\n", { mode: 0o600 });
    await writeFile(store.heartbeatPath(JOB_ID), new Date().toISOString(), { mode: 0o600 });
    await utimes(store.workerLogPath(JOB_ID), old, old);

    await store.cleanupExpiredJobs();

    expect(await readFile(store.workerLogPath(JOB_ID), "utf8")).toContain("still running");
  });
});
