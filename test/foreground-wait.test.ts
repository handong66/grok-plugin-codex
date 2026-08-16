import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobStore } from "../plugins/grok-plugin-codex/src/job-store.js";
import { grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { ToolResult, envelope, fakeGrokScript, makeExecutable, tempDir, withEnv } from "./helpers.js";

/** A Grok that keeps the job running for `delayMs` before emitting its answer. */
function slowGrokScript(delayMs: number): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search --session-id"; exit 0; fi
sleep ${delayMs / 1000}
printf '%s\\n' '{"type":"text","data":"OK"}' '{"type":"end","stopReason":"end_turn","sessionId":"slow-session"}'
`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("foreground wait loop (GPC-09)", () => {
  it("polls the cheap status path and parses the result exactly once", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), slowGrokScript(900));
    const resultSpy = vi.spyOn(JobStore.prototype, "result");
    const statusSpy = vi.spyOn(JobStore.prototype, "status");

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "slow answer", background: false })
      )
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.data.finalText).toBe("OK");
    // The 50ms result() loop re-read up to 4MB and re-parsed up to 1M chars per tick; a ~900ms job
    // used to cost ~18 full re-parses. Exactly one parse is the contract now.
    expect(resultSpy).toHaveBeenCalledTimes(1);
    // 100ms start with 1.5x backoff reaches ~900ms in well under ten polls.
    expect(statusSpy.mock.calls.length).toBeLessThan(12);
  }, 20_000);

  it("stops waiting once the job budget plus grace is exhausted and hands back the job id", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    // Never terminates on its own; the record stays running past the wait deadline.
    const grokBin = await makeExecutable(join(dir, "grok"), slowGrokScript(60_000));
    const store = new JobStore({ stateDir });
    const realStatus = JobStore.prototype.status;
    // Freeze the record in `running` so the wait loop, not the worker, decides when to give up.
    vi.spyOn(JobStore.prototype, "status").mockImplementation(async function (this: JobStore, jobId: string) {
      const record = await realStatus.call(this, jobId);
      return record.status === "queued" ? record : { ...record, status: "running" as const };
    });

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "never ends", background: false, timeoutMs: 1_000 })
      )
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("foreground_wait_timeout");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.details.jobId).toMatch(/^job_/);
    expect(parsed.error.details.status).toBe("running");
    await store.cancel(parsed.error.details.jobId).catch(() => undefined);
  }, 30_000);

  it("keeps a fast job fast", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript({ stopReason: "end_turn" }));

    const startedAt = Date.now();
    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "fast answer", background: false })
      )
    );

    expect(parsed.ok).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 20_000);
});
