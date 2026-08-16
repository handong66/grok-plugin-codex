import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTINUE_WITHOUT_TOOLS_REMEDY, grokFailureMessage } from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { FINALIZE_PROMPT, grokFinalize, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { envelope, makeExecutable, tempDir, withEnv } from "./helpers.js";

function argvLoggingGrok(argvLog: string, promptCopy: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents -s, --session-id"; exit 0; fi
for arg in "$@"; do
  printf '%s\\n' "$arg" >> ${JSON.stringify(argvLog)}
  if [ "$prev" = "--prompt-file" ]; then cat "$arg" > ${JSON.stringify(promptCopy)}; fi
  prev="$arg"
done
printf '%s\\n' '{"type":"text","data":"final answer"}' '{"type":"end","stopReason":"end_turn","sessionId":"finalize-session"}'
`;
}

async function setup() {
  const workspace = await tempDir();
  const stateDir = await tempDir();
  const argvLog = join(stateDir, "argv.log");
  const promptCopy = join(stateDir, "prompt.txt");
  const grokBin = await makeExecutable(join(workspace, "grok"), argvLoggingGrok(argvLog, promptCopy));
  return { workspace, env: { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, argvLog, promptCopy };
}

/** The only id such a run can learn: the `session_id=` the CLI prints on a tool error (SPEC §D M8). */
const LEARNED_SESSION_ID = "019f436e-b14c-7c23-b7f4-505e81ef1f3b";

/**
 * A CLI with no `--session-id` support, so the plugin cannot assign the handle up front and the
 * job's session id is whatever it learned from the stream — the shape GPC-05 exists to rescue, and
 * the one where `jobId` is the only target the caller can name.
 */
async function startJobWithLearnedSession(): Promise<{
  workspace: string;
  env: Record<string, string>;
  argvLog: string;
  jobId: string;
}> {
  const workspace = await tempDir();
  const stateDir = await tempDir();
  const argvLog = join(stateDir, "argv.log");
  const grokBin = await makeExecutable(
    join(workspace, "grok"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argvLog)}; done
case " $* " in
  *"--resume="*)
    printf '%s\\n' '{"type":"text","data":"the complete answer"}' '{"type":"end","stopReason":"end_turn"}'
    exit 0
    ;;
esac
printf '%s\\n' '{"type":"text","data":"partial"}'
echo 'ERROR tool_error: tool_output_error session_id=${LEARNED_SESSION_ID} tool_name="Read"' >&2
exit 0
`
  );
  const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
  const started = envelope(
    await withEnv(env, () =>
      grokRun({ cwd: workspace, _workspaceRoots: [workspace], background: false, timeoutMs: 30_000, prompt: "go" })
    )
  );
  if (started.ok) throw new Error("The partial run was expected to fail without an end event.");
  return { workspace, env, argvLog, jobId: started.error.details.recovery.jobId as string };
}

describe("GK4 grok_finalize", () => {
  it("resumes the session behind an explicit sessionId with one tool-free turn", async () => {
    const { workspace, env, argvLog, promptCopy } = await setup();
    const started = envelope(
      await withEnv(env, () =>
        grokRun({ cwd: workspace, _workspaceRoots: [workspace], background: false, timeoutMs: 30_000, prompt: "go" })
      )
    );
    expect(started.ok).toBe(true);

    const finalized = envelope(
      await withEnv(env, () =>
        grokFinalize({ cwd: workspace, _workspaceRoots: [workspace], sessionId: "finalize-session", timeoutMs: 30_000 })
      )
    );
    const argv = await readFile(argvLog, "utf8");
    const prompt = await readFile(promptCopy, "utf8");

    expect(finalized.ok).toBe(true);
    expect(argv).toContain("--resume=finalize-session");
    expect(argv).toContain("--max-turns");
    expect(prompt).toContain(FINALIZE_PROMPT);
    expect(prompt).toContain("UNVERIFIED");
    expect(finalized.data.effectiveMaxTurns).toBe(1);
  });

  it("falls back to the latest session in the workspace when no target is named", async () => {
    const { workspace, env, argvLog } = await setup();

    const finalized = envelope(
      await withEnv(env, () => grokFinalize({ cwd: workspace, _workspaceRoots: [workspace], timeoutMs: 30_000 }))
    );
    const argv = await readFile(argvLog, "utf8");

    expect(finalized.ok).toBe(true);
    expect(argv).toContain("--continue");
  });

  it("refuses a jobId that never learned a session id, instead of guessing", async () => {
    const { workspace, env } = await setup();

    const failed = envelope(
      await withEnv(env, () =>
        grokFinalize({ cwd: workspace, _workspaceRoots: [workspace], jobId: "job_missingfinalize0000000" })
      )
    );

    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe("job_not_found");
  });

  /**
   * X14. `jobId` was read only when `sessionId` was absent, so a call naming both finalized the
   * session and discarded the job without a word — two different targets, one silently dropped.
   */
  it("refuses a jobId and sessionId that name different sessions", async () => {
    const { workspace, env, argvLog, jobId } = await startJobWithLearnedSession();

    const conflicting = envelope(
      await withEnv(env, () =>
        grokFinalize({
          cwd: workspace,
          _workspaceRoots: [workspace],
          jobId,
          sessionId: "01a00152-52ee-7252-9e7c-9682d567a118",
          timeoutMs: 30_000
        })
      )
    );

    expect(conflicting.ok).toBe(false);
    expect(conflicting.error.code).toBe("invalid_finalize_target");
    expect(conflicting.error.retryable).toBe(false);
    expect(conflicting.error.details.jobSessionId).toBe(LEARNED_SESSION_ID);
    expect(conflicting.error.details.sessionId).toBe("01a00152-52ee-7252-9e7c-9682d567a118");
    // Nothing was resumed: the refusal happens before any Grok process is started.
    expect(await readFile(argvLog, "utf8")).not.toContain("--resume=01a00152");
  }, 40_000);

  it("accepts a jobId and sessionId that name the same session", async () => {
    const { workspace, env, argvLog, jobId } = await startJobWithLearnedSession();

    const finalized = envelope(
      await withEnv(env, () =>
        grokFinalize({
          cwd: workspace,
          _workspaceRoots: [workspace],
          jobId,
          sessionId: LEARNED_SESSION_ID,
          timeoutMs: 30_000
        })
      )
    );

    expect(finalized.ok).toBe(true);
    expect(await readFile(argvLog, "utf8")).toContain(`--resume=${LEARNED_SESSION_ID}`);
  }, 40_000);

  /**
   * M11. `finalize_target_unknown` is the code the contract promises for "this job has no session to
   * resume", and it had no test at all — the case that claimed to cover it asserted `job_not_found`.
   */
  it("reports finalize_target_unknown for a real job that never learned a session id", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    // No `--session-id` support, no `end` event, and no `session_id=` on stderr: there is no channel
    // left for the plugin to learn a resume handle from.
    const grokBin = await makeExecutable(
      join(workspace, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"partial"}'
exit 0
`
    );
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const started = envelope(
      await withEnv(env, () =>
        grokRun({ cwd: workspace, _workspaceRoots: [workspace], background: false, timeoutMs: 30_000, prompt: "go" })
      )
    );
    const jobId = started.error.details.recovery.jobId as string;
    const failed = envelope(
      await withEnv(env, () => grokFinalize({ cwd: workspace, _workspaceRoots: [workspace], jobId, timeoutMs: 30_000 }))
    );

    expect(started.ok).toBe(false);
    expect(failed.ok).toBe(false);
    expect(failed.error.code).toBe("finalize_target_unknown");
    expect(failed.error.retryable).toBe(false);
    expect(failed.error.details.jobId).toBe(jobId);
  }, 40_000);

  it("finalizes by jobId alone on a CLI that cannot be told the session id (X3)", async () => {
    const { workspace, env, argvLog, jobId } = await startJobWithLearnedSession();

    const finalized = envelope(
      await withEnv(env, () => grokFinalize({ cwd: workspace, _workspaceRoots: [workspace], jobId, timeoutMs: 30_000 }))
    );
    const argv = await readFile(argvLog, "utf8");

    // "Call grok_finalize with this jobId" is what every partial-result message says; before the
    // worker wrote the learned id back onto the record it threw finalize_target_unknown instead.
    expect(finalized.ok).toBe(true);
    expect(finalized.data.finalText).toBe("the complete answer");
    expect(argv).toContain(`--resume=${LEARNED_SESSION_ID}`);
  }, 40_000);
});

describe("GK4 discoverability", () => {
  it("names grok_finalize in every partial-result remedy", () => {
    expect(CONTINUE_WITHOUT_TOOLS_REMEDY("cause.")).toContain("grok_finalize");
    expect(grokFailureMessage("max_turns_reached")).toContain("grok_finalize");
    expect(grokFailureMessage("timeout")).toContain("grok_finalize");
  });
});
