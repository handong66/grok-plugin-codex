import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokReview } from "../plugins/grok-plugin-codex/src/tools.js";
import { makeExecutable, tempDir } from "./helpers.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

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
printf '%s\\n' ${DENIED_SHELL_STREAM}
`;
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
});
