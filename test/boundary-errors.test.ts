import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configureWorkspaceRootsProvider,
  grokContinue,
  grokReview,
  grokRun
} from "../plugins/grok-plugin-codex/src/tools.js";
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

function fakeGrok(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
printf '%s\\n' '{"type":"tool_call","toolCallId":"t","name":"read_file","data":{"path":"/tmp/a"}}' '{"type":"text","data":"ok"}' '{"type":"end","stopReason":"end_turn"}'
`;
}

afterEach(() => {
  configureWorkspaceRootsProvider(async () => [process.cwd()]);
});

describe("GK6 private_path_blocked", () => {
  it("names the matched path and offers the Grok-native location", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrok());

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          prompt: "read ~/.codex/skills/codex-opencode-collaboration/SKILL.md and summarise it"
        })
      )
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("private_path_blocked");
    expect(parsed.error.details.blockedPath).toContain(".codex");
    // The remedy must name a usable alternative, as the sibling opencode plugin's message already does.
    expect(parsed.error.message).toContain("~/.grok/skills");
    // The prompt itself must not be echoed back.
    expect(JSON.stringify(parsed)).not.toContain("summarise it");
  });
});

describe("GK7 workspace_unavailable", () => {
  it("is retryable and says the roots arrive per turn", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();

    const parsed = envelope(
      await grokRun({ cwd: workspace, background: false, timeoutMs: 30_000, prompt: "hello" })
    );

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("workspace_unavailable");
    expect(parsed.error.retryable).toBe(true);
    expect(parsed.error.message).toMatch(/retry/i);
    expect(parsed.error.details.listRootsCount).toBe(0);
    expect(parsed.error.details.codexMetaRootsCount).toBe(0);
    expect(parsed.error.details.requestedCwd).toBe(workspace);
  });

  it("reuses the last non-empty root set for a turn that carries no metadata", async () => {
    configureWorkspaceRootsProvider(async () => []);
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrok());
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const first = envelope(
      await withEnv(env, () =>
        grokReview({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          target: "src"
        })
      )
    );
    const second = envelope(
      await withEnv(env, () =>
        grokReview({ cwd: workspace, background: false, timeoutMs: 30_000, target: "src" })
      )
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.warnings as string[]).join("\n")).toMatch(/earlier turn/i);
  });
});

describe("GK8 session_not_found", () => {
  it("falls back to the latest session once when the named one is gone", async () => {
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
    echo "Failed to restore session from remote: 404 Not Found" >&2
    exit 1
    ;;
esac
printf '%s\\n' '{"type":"text","data":"recovered"}' '{"type":"end","stopReason":"end_turn"}'
`
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          sessionId: "01a00152-52ee-7252-9e7c-9682d567a118",
          fallbackToLatest: true,
          prompt: "finish the review"
        })
      )
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.data.finalText).toBe("recovered");
    expect((parsed.warnings as string[]).join("\n")).toContain("fallbackToLatest");
  });
});
