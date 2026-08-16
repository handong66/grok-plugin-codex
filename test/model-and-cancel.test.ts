import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyGrokErrorText, grokFailureMessage, signalPidTree } from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { buildRunArgs, cancelOutcome, grokCancel, grokRun, grokStatus } from "../plugins/grok-plugin-codex/src/tools.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";
import { fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

function record(overrides: Partial<JobRecord>): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind: "run",
    status: "running",
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    timeoutMs: 30_000,
    ...overrides
  };
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function envelope(result: ToolResult): Record<string, any> {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

async function withEnv<T>(values: Record<string, string | undefined>, operation: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("GK9(a) model_tool_incompatible", () => {
  it("classifies a tool_output_error as a model incompatibility, not a generic failure", () => {
    const code = classifyGrokErrorText(
      'ERROR tool_error: tool_output_error session_id=019f436e tool_name="Read" model_id="grok-composer-2.5-fast"'
    );

    expect(code).toBe("model_tool_incompatible");
    expect(grokFailureMessage(code)).toContain("could not consume its own tool output");
    expect(grokFailureMessage(code)).toContain("full model");
  });

  it("warns when a fast composer model is selected for read-only repository work", () => {
    const built = buildRunArgs({ cwd: "/repo", model: "grok-composer-2.5-fast", readOnly: true });

    expect(built.warnings.join("\n")).toContain("not suited to");
  });
});

describe("GK9(c) reasoning-effort support is derived, with the literal as fallback", () => {
  it("uses the advertised model list when one was collected", () => {
    const derived = buildRunArgs({
      cwd: "/repo",
      model: "grok-composer-3-fast",
      reasoningEffort: "high",
      reasoningEffortUnsupported: ["grok-composer-3-fast"],
      knownModels: ["grok-composer-3-fast", "grok-5"]
    });

    expect(derived.args).not.toContain("--reasoning-effort");
    expect(derived.warnings.join("\n")).toContain("grok-composer-3-fast does not support");
  });

  it("warns about a model the installed CLI does not list", () => {
    const built = buildRunArgs({ cwd: "/repo", model: "grok-typo-9", knownModels: ["grok-5"] });

    expect(built.warnings.join("\n")).toContain("is not in the model list");
  });
});

describe("GK9(d) signalling a process tree that is no longer ours", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function killThrows(code: string): void {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error(`kill ${code}`) as NodeJS.ErrnoException;
      error.code = code;
      error.errno = -1;
      error.syscall = "kill";
      throw error;
    });
  }

  // The recorded cancel flake: the owned group was already reaped, kill raised EPERM instead of
  // ESRCH, and the escaping error became a retryable internal_error on a cancel that had in fact
  // succeeded. EPERM and ESRCH are the same fact for this caller: nothing of ours is left to kill.
  it.each(["ESRCH", "EPERM"])("treats kill %s as already gone", (code) => {
    killThrows(code);

    expect(() => signalPidTree(4242, "SIGTERM")).not.toThrow();
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it("still surfaces any other kill errno", () => {
    killThrows("EINVAL");

    expect(() => signalPidTree(4242, "SIGKILL")).toThrow(/EINVAL/);
  });

  it("does not signal at all without a pid", () => {
    killThrows("EPERM");

    expect(() => signalPidTree(undefined, "SIGTERM")).not.toThrow();
    expect(process.kill).not.toHaveBeenCalled();
  });
});

describe("GK9(d) cancel outcomes", () => {
  /**
   * X15 / FINAL Review M11. This case used to derive a job id from a foreground envelope that does
   * not carry one (`started.data.finalTextRef` is undefined on success), discard the `undefined`,
   * and cancel an id that never existed — so the outcome it claimed to check was never asserted.
   */
  it("reports already_terminal for a job that had already finished", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrokScript());
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const started = envelope(
      await withEnv(env, () =>
        grokRun({
          cwd: workspace,
          _workspaceRoots: [workspace],
          timeoutMs: 30_000,
          prompt: "done already"
        })
      )
    );
    const jobId = started.data.job.id as string;
    const finished = await withEnv(env, async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const parsed = envelope(await grokStatus({ jobId }));
        if (!["queued", "running"].includes(parsed.data.job.status)) return parsed;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      throw new Error("Job never reached a terminal state.");
    });

    const cancelled = envelope(await withEnv(env, () => grokCancel({ jobId })));

    expect(finished.data.job.status).toBe("succeeded");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.data.outcome).toBe("already_terminal");
    // The finished job keeps its own terminal state; cancelling it must not rewrite it.
    expect(cancelled.data.job.status).toBe("succeeded");
  }, 30_000);

  it("reports job_not_found for an id that never existed", async () => {
    const stateDir = await tempDir();

    const unknown = envelope(
      await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokCancel({ jobId: "job_neverexisted0000000000" })
      )
    );

    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe("job_not_found");
  });

  /**
   * X15: the outcome used to be decided by the record read *before* the cancel, so a worker that
   * finished in the window between that read and `JobStore.cancel` — the common case for a job
   * cancelled because it looked stuck seconds before it completed — was still reported as
   * `cancel_requested`, and a caller obeying that verdict discarded a complete answer.
   */
  it("does not call a completed job cancelled when it finished during the cancel", () => {
    const running = record({ status: "running" });
    const cancelledAt = "2026-08-16T00:00:01.000Z";

    expect(cancelOutcome(running, record({ status: "cancelled", cancelRequestedAt: cancelledAt }))).toBe(
      "cancel_requested"
    );
    // The race: nothing was marked, because JobStore.cancel found the job already terminal.
    expect(cancelOutcome(running, record({ status: "succeeded" }))).toBe("already_terminal");
    expect(cancelOutcome(running, record({ status: "failed" }))).toBe("already_terminal");
    // Already terminal before the call: never a cancellation, whatever the second read says.
    expect(cancelOutcome(record({ status: "succeeded" }), record({ status: "succeeded" }))).toBe(
      "already_terminal"
    );
    expect(
      cancelOutcome(
        record({ status: "cancelled", cancelRequestedAt: cancelledAt }),
        record({ status: "cancelled", cancelRequestedAt: cancelledAt })
      )
    ).toBe("already_terminal");
  });

  it("reports cancel_requested for a live job", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(workspace, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
sleep 30
`
    );
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
    const started = envelope(
      await withEnv(env, () =>
        grokRun({ cwd: workspace, _workspaceRoots: [workspace], background: true, timeoutMs: 30_000, prompt: "slow" })
      )
    );

    const cancelled = envelope(await withEnv(env, () => grokCancel({ jobId: started.data.job.id })));
    const again = envelope(await withEnv(env, () => grokCancel({ jobId: started.data.job.id })));

    expect(cancelled.data.outcome).toBe("cancel_requested");
    expect(again.data.outcome).toBe("already_terminal");
  });
});
