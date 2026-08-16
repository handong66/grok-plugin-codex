import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  JobStore,
  STREAM_SUMMARY_VERSION,
  WORKER_HEARTBEAT_STALE_MS
} from "../plugins/grok-plugin-codex/src/job-store.js";
import { tempDir } from "./helpers.js";

const JOB_ID = "job_statushardening0000000";

function runningRecord() {
  return {
    id: JOB_ID,
    kind: "run" as const,
    status: "running" as const,
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    timeoutMs: 60_000,
    workerPid: 999_999_999
  };
}

async function writeSummary(store: JobStore, lastEventAt: string): Promise<void> {
  await writeFile(
    store.summaryPath(JOB_ID),
    JSON.stringify({ version: STREAM_SUMMARY_VERSION, eventCounts: { text: 1 }, textChars: 5, lastEventAt }),
    { mode: 0o600 }
  );
}

describe("GPC-M3 status() must not reap a job that is still producing", () => {
  it("keeps a stale-heartbeat job alive when the stream ledger advanced during the check", async () => {
    const store = new JobStore(await tempDir());
    await store.write(runningRecord());
    await writeSummary(store, new Date(Date.now() - 60_000).toISOString());

    // The heartbeat file never appears (the observation this item is about is a *healthy* worker
    // being killed by an observer), but the ledger moves while status is making up its mind.
    const advance = setTimeout(() => void writeSummary(store, new Date().toISOString()), 200);
    const observed = await store.status(JOB_ID);
    clearTimeout(advance);

    expect(observed.status).toBe("running");
    expect(observed.error).toBeUndefined();
  });

  it("still reconciles a worker that is gone and produced nothing", async () => {
    const store = new JobStore(await tempDir());
    await store.write(runningRecord());

    const observed = await store.status(JOB_ID);

    expect(observed.status).toBe("failed");
    expect(observed.error?.code).toBe("worker_unavailable");
  });

  it("gives a live worker more than the 250ms status poll interval to write a heartbeat", () => {
    // GPC-M3: the 5s threshold was two flush cycles away from a 20Hz observer under load.
    expect(WORKER_HEARTBEAT_STALE_MS).toBeGreaterThanOrEqual(10_000);
  });
});
