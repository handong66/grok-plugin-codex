import { access, chmod, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore, summarizeGrokOutput } from "../plugins/grok-plugin-codex/src/job-store.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";
import { STOP_REASON_SPELLINGS, tempDir } from "./helpers.js";

function record(status: JobRecord["status"]): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind: "run",
    status,
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    timeoutMs: 600_000
  };
}

describe("Grok job output summary", () => {
  it.each(STOP_REASON_SPELLINGS.endTurn)(
    "ignores warning lines, concatenates text events, and requires an end event (%s)",
    (stopReason) => {
      const stdout = [
        "2026 WARN non-json line",
        "{\"type\":\"thought\",\"data\":\"thinking\"}",
        "{\"type\":\"text\",\"data\":\"Hello\"}",
        "{\"type\":\"text\",\"data\":\" world\"}",
        `{"type":"end","stopReason":"${stopReason}","sessionId":"s1","requestId":"r1"}`
      ].join("\n");

      const summary = summarizeGrokOutput(record("succeeded"), stdout);

      expect(summary.resultComplete).toBe(true);
      expect(summary.state).toBe("succeeded_with_text");
      expect(summary.eventCounts).toEqual({ thought: 1, text: 2, end: 1 });
      expect(summary.finalText).toBe("Hello world");
      expect(summary.textPreview).toBe("Hello world");
      expect(summary.grokSessionId).toBe("s1");
      expect(summary.requestId).toBe("r1");
      expect(summary.stopReason).toBe(stopReason);
      expect(summary.stopReasonNormalized).toBe("endturn");
    }
  );

  it("marks succeeded output without an end event as incomplete", () => {
    const summary = summarizeGrokOutput(record("succeeded"), "{\"type\":\"text\",\"data\":\"partial\"}");

    expect(summary.resultComplete).toBe(false);
    expect(summary.state).toBe("succeeded_without_text");
    expect(summary.sawEnd).toBe(false);
  });

  it.each(STOP_REASON_SPELLINGS.cancelled)(
    "treats a %s end event as partial even when text was emitted",
    (stopReason) => {
      const stdout = [
        '{"type":"text","data":"I will review the diff."}',
        `{"type":"end","stopReason":"${stopReason}","sessionId":"cancelled-session","requestId":"cancelled-request"}`
      ].join("\n");

      const summary = summarizeGrokOutput(record("succeeded"), stdout);

      expect(summary.resultComplete).toBe(false);
      expect(summary.state).toBe("cancelled_partial");
      expect(summary.finalText).toBe("I will review the diff.");
      expect(summary.stopReason).toBe(stopReason);
      expect(summary.stopReasonNormalized).toBe("cancelled");
      expect(summary.guidance).toContain("cancelled");
    }
  );

  it("classifies max_turns_reached streaming output as a typed partial failure", () => {
    const stdout = [
      '{"type":"thought","data":"finding a problem"}',
      '{"type":"max_turns_reached"}',
      '{"type":"end","stopReason":"cancelled","sessionId":"max-turns-session"}'
    ].join("\n");

    const summary = summarizeGrokOutput(record("failed"), stdout, "Error: max turns reached");

    expect(summary.resultComplete).toBe(false);
    expect(summary.state).toBe("failed_partial");
    expect(summary.streamError?.code).toBe("max_turns_reached");
    expect(summary.grokSessionId).toBe("max-turns-session");
    expect(summary.guidance).toContain("do not use any tools");
  });

  it("never marks truncated streaming output as complete", () => {
    const stdout = [
      '{"type":"text","data":"looks complete"}',
      '{"type":"end","sessionId":"s1"}'
    ].join("\n");

    const summary = summarizeGrokOutput(record("succeeded"), stdout, "", true);

    expect(summary.outputTruncated).toBe(true);
    expect(summary.resultComplete).toBe(false);
  });

  it("marks running, cancelled, and failed jobs as partial", () => {
    expect(summarizeGrokOutput(record("running"), "").state).toBe("running_partial");
    expect(summarizeGrokOutput(record("cancelled"), "").state).toBe("cancelled_partial");
    expect(summarizeGrokOutput(record("failed"), "").state).toBe("failed_partial");
  });

  it("reads job files and returns parsed outputSummary", async () => {
    const dir = await tempDir();
    const store = new JobStore(dir);
    await store.write(record("succeeded"));
    await writeFile(store.stdoutPath("job_1700000000000_abcdef12"), "{\"type\":\"text\",\"data\":\"OK\"}\n{\"type\":\"end\",\"stopReason\":\"end_turn\",\"sessionId\":\"s1\"}\n");
    await writeFile(store.stderrPath("job_1700000000000_abcdef12"), "");

    const result = await store.result("job_1700000000000_abcdef12");

    expect(result.outputSummary.resultComplete).toBe(true);
    expect(result.outputSummary.textPreview).toBe("OK");
  });

  it("does not overwrite terminal job status when cancel is called late", async () => {
    const dir = await tempDir();
    const store = new JobStore(dir);
    await store.write({
      ...record("succeeded"),
      exitCode: 0,
      finishedAt: "2026-07-08T00:00:01.000Z"
    });

    const cancelled = await store.cancel("job_1700000000000_abcdef12");

    expect(cancelled.status).toBe("succeeded");
    expect(cancelled.exitCode).toBe(0);
    expect(cancelled.finishedAt).toBe("2026-07-08T00:00:01.000Z");
  });

  it("rejects malformed job IDs before resolving job paths", async () => {
    const dir = await tempDir();
    const store = new JobStore(dir);
    await writeFile(join(dir, "outside.json"), `${JSON.stringify(record("succeeded"))}\n`);

    await expect(store.read("../../../outside")).rejects.toThrow("Invalid background job ID");
    await expect(store.result("../../../outside")).rejects.toThrow("Invalid background job ID");
    await expect(store.cancel("../../../outside")).rejects.toThrow("Invalid background job ID");
  });

  it("stores records under a private central jobs directory", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const job = record("queued");

    await store.write(job);

    const recordPath = join(stateDir, "jobs", `${job.id}.json`);
    await expect(access(recordPath)).resolves.toBeUndefined();
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(stateDir, "jobs"))).mode & 0o777).toBe(0o700);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses to claim or chmod an existing non-plugin state directory", async () => {
    const parent = await tempDir();
    const stateDir = join(parent, "shared-directory");
    const sentinel = join(stateDir, "user-file.txt");
    await mkdir(stateDir, { mode: 0o755 });
    await chmod(stateDir, 0o755);
    await writeFile(sentinel, "belongs to the user");
    const store = new JobStore(stateDir);

    await expect(store.ensure()).rejects.toThrow("not an empty or plugin-owned state directory");

    expect((await stat(stateDir)).mode & 0o777).toBe(0o755);
    await expect(access(sentinel)).resolves.toBeUndefined();
    await expect(access(join(stateDir, "jobs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts a strict pre-marker plugin state layout without discarding jobs", async () => {
    const stateDir = await tempDir();
    const jobsDir = join(stateDir, "jobs");
    const job = record("succeeded");
    await mkdir(jobsDir, { mode: 0o700 });
    await writeFile(join(jobsDir, `${job.id}.json`), `${JSON.stringify(job)}\n`, { mode: 0o600 });
    const store = new JobStore(stateDir);

    await store.ensure();

    await expect(access(join(stateDir, ".grok-plugin-state-v2"))).resolves.toBeUndefined();
    expect((await store.read(job.id)).status).toBe("succeeded");
  });

  it("keeps cancellation terminal when a late worker write reports success", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const queued = { ...record("queued"), createdAt: new Date().toISOString() };
    await store.write(queued);
    await writeFile(store.inputPath(queued.id), "private prompt", { mode: 0o600 });

    const cancelled = await store.cancel(queued.id);
    await store.write({ ...queued, status: "succeeded", exitCode: 0, finishedAt: new Date().toISOString() });
    const finalRecord = await store.read(queued.id);

    expect(cancelled.status).toBe("cancelled");
    expect(finalRecord.status).toBe("cancelled");
    await expect(access(store.inputPath(queued.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps any terminal status when a late worker write attempts to resurrect the job", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const failed = {
      ...record("failed"),
      error: { code: "worker_unavailable", message: "Worker exited.", retryable: true },
      finishedAt: new Date().toISOString()
    };
    await store.write(failed);

    await store.write({
      ...failed,
      status: "succeeded",
      error: undefined,
      exitCode: 0,
      finishedAt: new Date(Date.now() + 1_000).toISOString()
    });

    const finalRecord = await store.read(failed.id);
    expect(finalRecord.status).toBe("failed");
    expect(finalRecord.error?.code).toBe("worker_unavailable");
    expect(finalRecord.exitCode).toBeUndefined();
  });

  it("returns persisted terminal truth when a worker wins the status reconciliation race", async () => {
    const stateDir = await tempDir();
    class RacingStore extends JobStore {
      injected = false;

      override async write(next: JobRecord): Promise<void> {
        if (!this.injected && next.error?.code === "worker_unavailable") {
          this.injected = true;
          await super.write({
            ...next,
            status: "succeeded",
            error: undefined,
            exitCode: 0,
            finishedAt: new Date().toISOString()
          });
        }
        await super.write(next);
      }
    }
    const store = new RacingStore(stateDir);
    await store.write({ ...record("running"), startedAt: new Date().toISOString() });

    const reconciled = await store.status(record("running").id);

    expect(reconciled.status).toBe("succeeded");
    expect(reconciled.error).toBeUndefined();
    expect(reconciled.exitCode).toBe(0);
  });

  it("does not steal an old lock while its owner process is still alive", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const job = record("queued");
    await store.ensure();
    const lockPath = join(stateDir, "jobs", `${job.id}.lock`);
    await writeFile(lockPath, `${process.pid}\nlive-owner-token\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    await expect(store.write(job)).rejects.toThrow("job state is busy");
    await expect(access(join(stateDir, "jobs", `${job.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  }, 7_000);

  it("reclaims an old lock only after its owner process is gone", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const job = record("queued");
    await store.ensure();
    const lockPath = join(stateDir, "jobs", `${job.id}.lock`);
    await writeFile(lockPath, "999999999\ndead-owner-token\n", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);

    await store.write(job);

    expect((await store.read(job.id)).status).toBe("queued");
    await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles a stale running worker to a typed failure and removes its prompt", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const running = { ...record("running"), workerPid: 999_999_999, startedAt: new Date().toISOString() };
    await store.write(running);
    await writeFile(store.inputPath(running.id), "private prompt", { mode: 0o600 });

    const reconciled = await store.status(running.id);

    expect(reconciled.status).toBe("failed");
    expect(reconciled.error?.code).toBe("worker_unavailable");
    await expect(access(store.inputPath(running.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects prompt-bearing arguments before persisting a job", async () => {
    const store = new JobStore(await tempDir());

    await expect(store.write({ ...record("queued"), args: ["--prompt-file", "/tmp/secret"] })).rejects.toThrow(
      "must not contain prompt sources"
    );
  });

  it("never removes an old prompt that still belongs to an active job", async () => {
    const stateDir = await tempDir();
    const store = new JobStore(stateDir);
    const running = { ...record("running"), createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000).toISOString() };
    await store.write(running);
    await writeFile(store.inputPath(running.id), "still active", { mode: 0o600 });
    await writeFile(store.heartbeatPath(running.id), new Date().toISOString(), { mode: 0o600 });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    await utimes(store.inputPath(running.id), old, old);

    await store.cleanupExpiredJobs();

    await expect(access(store.inputPath(running.id))).resolves.toBeUndefined();
  });
});

/**
 * N1 (external fix-round-1 re-review). A record with no `grokSessionId` costs one
 * `<id>.summary.json` read, and `findLatestSessionOrigin` asks `findSessionOrigin` about every
 * candidate session — each of which rescans every record. The lookup was therefore O(N²) small reads
 * on exactly the recovery path `continueLatest` and the degraded `grok_finalize({ cwd })` take.
 */
describe("session lookup cost", () => {
  it("reads each job's stream summary at most once per lookup", async () => {
    const stateDir = await tempDir();
    class CountingStore extends JobStore {
      summaryReads = 0;
      override async readStreamProgress(jobId: string) {
        this.summaryReads += 1;
        return await super.readStreamProgress(jobId);
      }
    }
    const store = new CountingStore({ stateDir });
    await store.ensure();
    const jobsDir = join(stateDir, "jobs");
    const jobCount = 6;
    for (let index = 0; index < jobCount; index += 1) {
      const jobId = `job_latencyprobe000000000${index}`;
      // Continuations only: none of them can be an origin, so the lookup walks every candidate.
      await writeFile(
        join(jobsDir, `${jobId}.json`),
        JSON.stringify({
          id: jobId,
          kind: "continue",
          status: "succeeded",
          cwd: "/repo",
          command: "grok",
          args: [],
          createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
          timeoutMs: 30_000
        }),
        { mode: 0o600 }
      );
      // `eventCounts` is what makes `readStreamProgress` accept the summary; without it the id is
      // never learned, the candidate list stays empty and the quadratic walk never even happens.
      await store.writeStreamSummary(
        jobId,
        JSON.stringify({ version: 1, grokSessionId: `session-${index}`, textChars: 1, eventCounts: { text: 1 } })
      );
    }

    const origin = await store.findLatestSessionOrigin("/repo");

    expect(origin).toBeUndefined();
    // One read per record. Without the per-lookup cache this was jobCount * (jobCount + 1) = 42.
    expect(store.summaryReads).toBeLessThanOrEqual(jobCount * 2);
  });
});
