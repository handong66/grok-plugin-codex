import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTINUE_WITHOUT_TOOLS_REMEDY, grokFailureMessage } from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { FINALIZE_PROMPT, grokFinalize, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { makeExecutable, tempDir } from "./helpers.js";

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

  it("finalizes by jobId alone on a CLI that cannot be told the session id (X3)", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const argvLog = join(stateDir, "argv.log");
    // No `--session-id` in --help, so the plugin cannot assign the handle up front: this run's only
    // session id is the `session_id=<uuid>` the CLI prints to stderr on a tool error (SPEC §D M8),
    // and the stream never emits an `end` event at all — the exact shape GPC-05 exists to rescue.
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
echo 'ERROR tool_error: tool_output_error session_id=019f436e-b14c-7c23-b7f4-505e81ef1f3b tool_name="Read"' >&2
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
    const finalized = envelope(
      await withEnv(env, () => grokFinalize({ cwd: workspace, _workspaceRoots: [workspace], jobId, timeoutMs: 30_000 }))
    );
    const argv = await readFile(argvLog, "utf8");

    expect(started.ok).toBe(false);
    // "Call grok_finalize with this jobId" is what every partial-result message says; before the
    // worker wrote the learned id back onto the record it threw finalize_target_unknown instead.
    expect(finalized.ok).toBe(true);
    expect(finalized.data.finalText).toBe("the complete answer");
    expect(argv).toContain("--resume=019f436e-b14c-7c23-b7f4-505e81ef1f3b");
  }, 40_000);
});

describe("GK4 discoverability", () => {
  it("names grok_finalize in every partial-result remedy", () => {
    expect(CONTINUE_WITHOUT_TOOLS_REMEDY("cause.")).toContain("grok_finalize");
    expect(grokFailureMessage("max_turns_reached")).toContain("grok_finalize");
    expect(grokFailureMessage("timeout")).toContain("grok_finalize");
  });
});
