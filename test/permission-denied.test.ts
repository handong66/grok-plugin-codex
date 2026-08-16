import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokResult, grokReview, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { ToolResult, envelope, makeExecutable, tempDir, withEnv } from "./helpers.js";

/**
 * GK5: the recorded shape is an adversarial review that announces it will pull a diff, has the shell
 * call auto-refused by plan mode, and ends `Cancelled`. The guidance told the caller to narrow the
 * target, which has nothing to do with the cause.
 */
const DENIED_SHELL_STREAM = [
  `'{"type":"text","data":"Next I will pull the scoped main...HEAD diff."}'`,
  `'{"type":"tool_call","toolCallId":"t1","name":"run_terminal_command","data":{"command":"git diff"}}'`,
  `'{"type":"tool_call_update","toolCallId":"t1","name":"run_terminal_command","data":{"result":"User cancelled the execution for tool run_terminal_command"}}'`,
  `'{"type":"end","stopReason":"cancelled","sessionId":"denied-session"}'`
].join(" ");

function fakeGrokWithDeniedShell(): string {
  return `#!/bin/sh
	if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
	if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search -s, --session-id"; exit 0; fi
	previous=""; for arg in "$@"; do if [ "$previous" = "--prompt-file" ]; then cat "$arg" >/dev/null; fi; previous="$arg"; done
	printf '%s\\n' ${DENIED_SHELL_STREAM}
`;
}

async function settledResult(stateDir: string, jobId: string): Promise<Record<string, any>> {
  return await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const parsed = envelope(await grokResult({ jobId }));
      if (!["queued", "running"].includes(parsed.data?.job.status)) return parsed;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    throw new Error("Job never reached a terminal state.");
  });
}

describe("GK5 shell approval in plan mode", () => {
  it("reports a plan-mode shell refusal as permission_denied_headless, not as a wide target", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokWithDeniedShell());

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokReview({
        cwd: dir,
        _workspaceRoots: [dir],
        background: false,
        timeoutMs: 30_000,
        target: "the working tree diff"
      })
    );
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe("permission_denied_headless");
    expect(parsed.error.message).toContain("plan mode");
    expect(parsed.error.details.deniedToolCalls).toEqual([{ name: "run_terminal_command", count: 1 }]);
    expect(parsed.error.details.guidance).toContain("Inline the required command output");
    // The old advice must not survive anywhere on this envelope.
    expect(JSON.stringify(parsed)).not.toMatch(/narrower target/i);
  });

  it("carries the same code on the default background path, not only on a foreground wait", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokWithDeniedShell());

    // X2: review/adversarial_review/rescue default to background, and the worker stored a
    // cancelled_partial stream as `status: cancelled` with no `error` at all — so the code the
    // published contract and SKILL.md branch on existed only on the path nobody takes by default.
    const started = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokReview({ cwd: dir, _workspaceRoots: [dir], timeoutMs: 30_000, target: "the working tree diff" })
      )
    );
    expect(started.ok).toBe(true);
    expect(started.data.background).toBe(true);
    const finished = await settledResult(stateDir, started.data.job.id as string);

    expect(finished.data.job.status).toBe("cancelled");
    expect(finished.data.job.error.code).toBe("permission_denied_headless");
    expect(finished.data.job.error.retryable).toBe(false);
    expect(finished.data.job.error.details.deniedToolCalls).toEqual([{ name: "run_terminal_command", count: 1 }]);
    expect(finished.data.outputSummary.shellApprovalBlocked).toBe(true);
  }, 40_000);

  it("does not report a mutable run that used the shell and was cancelled as a permission denial", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    // A mutable `grok_run`: the shell call succeeds, and the turn ends with a vendor `cancelled`
    // stop reason (the shape the worker now stores as `cancelled` rather than `succeeded`). Plan mode
    // never entered into it, so the plan-mode remedy and the non-retryable permission code are both
    // wrong here — that is the inverse of what GK5 exists for.
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
	if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
	if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search -s, --session-id"; exit 0; fi
	previous=""; for arg in "$@"; do if [ "$previous" = "--prompt-file" ]; then cat "$arg" >/dev/null; fi; previous="$arg"; done
	printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","name":"run_terminal_command","data":{"command":"npm test"}}' '{"type":"tool_call_update","toolCallId":"t1","name":"run_terminal_command","data":{"result":"12 passing"}}' '{"type":"text","data":"partial progress"}' '{"type":"end","stopReason":"cancelled","sessionId":"mutable-cancel"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, _workspaceRoots: [dir], background: false, timeoutMs: 30_000, prompt: "run the tests" })
    );
    const parsed = envelope(result);
    const finished = await settledResult(stateDir, parsed.error.details.recovery.jobId as string);

    expect(parsed.error.code).toBe("cancelled_output");
    expect(parsed.error.details.guidance).not.toContain("plan mode");
    expect(finished.data.outputSummary.shellApprovalBlocked).toBe(false);
    expect(finished.data.job.error).toBeUndefined();
  }, 40_000);
});
