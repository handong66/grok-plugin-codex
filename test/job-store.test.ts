import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore, summarizeGrokOutput } from "../plugins/grok-plugin-codex/src/job-store.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";
import { tempDir } from "./helpers.js";

function record(status: JobRecord["status"]): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind: "run",
    status,
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    stdoutPath: "/tmp/stdout.log",
    stderrPath: "/tmp/stderr.log"
  };
}

describe("Grok job output summary", () => {
  it("ignores warning lines, concatenates text events, and requires an end event", () => {
    const stdout = [
      "2026 WARN non-json line",
      "{\"type\":\"thought\",\"data\":\"thinking\"}",
      "{\"type\":\"text\",\"data\":\"Hello\"}",
      "{\"type\":\"text\",\"data\":\" world\"}",
      "{\"type\":\"end\",\"stopReason\":\"EndTurn\",\"sessionId\":\"s1\",\"requestId\":\"r1\"}"
    ].join("\n");

    const summary = summarizeGrokOutput(record("succeeded"), stdout);

    expect(summary.resultComplete).toBe(true);
    expect(summary.state).toBe("succeeded_with_text");
    expect(summary.eventCounts).toEqual({ thought: 1, text: 2, end: 1 });
    expect(summary.textPreview).toBe("Hello world");
    expect(summary.grokSessionId).toBe("s1");
    expect(summary.requestId).toBe("r1");
    expect(summary.stopReason).toBe("EndTurn");
  });

  it("marks succeeded output without an end event as incomplete", () => {
    const summary = summarizeGrokOutput(record("succeeded"), "{\"type\":\"text\",\"data\":\"partial\"}");

    expect(summary.resultComplete).toBe(false);
    expect(summary.state).toBe("succeeded_without_text");
    expect(summary.sawEnd).toBe(false);
  });

  it("marks running, cancelled, and failed jobs as partial", () => {
    expect(summarizeGrokOutput(record("running"), "").state).toBe("running_partial");
    expect(summarizeGrokOutput(record("cancelled"), "").state).toBe("cancelled_partial");
    expect(summarizeGrokOutput(record("failed"), "").state).toBe("failed_partial");
  });

  it("reads job files and returns parsed outputSummary", async () => {
    const dir = await tempDir();
    const jobsDir = join(dir, ".grok-plugin-codex", "jobs");
    await mkdir(jobsDir, { recursive: true });
    const stdoutPath = join(jobsDir, "job_1700000000000_abcdef12.stdout.log");
    const stderrPath = join(jobsDir, "job_1700000000000_abcdef12.stderr.log");
    const store = new JobStore(dir);
    await store.write({ ...record("succeeded"), stdoutPath, stderrPath });
    await writeFile(stdoutPath, "{\"type\":\"text\",\"data\":\"OK\"}\n{\"type\":\"end\",\"sessionId\":\"s1\"}\n");
    await writeFile(stderrPath, "");

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

    await expect(store.read("../../../outside")).rejects.toThrow("jobId");
    await expect(store.result("../../../outside")).rejects.toThrow("jobId");
    await expect(store.cancel("../../../outside")).rejects.toThrow("jobId");
  });
});
