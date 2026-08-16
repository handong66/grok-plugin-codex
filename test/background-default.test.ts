import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  grokAdversarialReview,
  grokContinue,
  grokRescue,
  grokReview,
  grokRun
} from "../plugins/grok-plugin-codex/src/tools.js";
import { makeExecutable, tempDir } from "./helpers.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
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

/** Emits nothing for a long time: a foreground call would block, a background one returns at once. */
const SILENT_GROK = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search --session-id"; exit 0; fi
sleep 30
`;

async function bed() {
  const dir = await tempDir();
  const stateDir = await tempDir();
  const grokBin = await makeExecutable(join(dir, "grok"), SILENT_GROK);
  return { dir, stateDir, env: { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, roots: [dir] };
}

describe("background default (GPC-M1)", () => {
  it.each([
    ["grok_run", (args: any) => grokRun({ ...args, prompt: "dispatch" })],
    ["grok_review", (args: any) => grokReview({ ...args, target: "src/index.ts" })],
    ["grok_adversarial_review", (args: any) => grokAdversarialReview({ ...args, target: "src/index.ts" })],
    ["grok_rescue", (args: any) => grokRescue({ ...args, problem: "diagnose" })]
  ])("%s dispatches in the background when the caller says nothing", async (_name, invoke) => {
    const { dir, env, roots } = await bed();
    const startedAt = Date.now();

    const parsed = envelope(
      await withEnv(env, () => invoke({ cwd: dir, _workspaceRoots: roots, timeoutMs: 30_000 }))
    );

    // 65% of observed execution calls omitted `background`, and each one blocked the MCP client for
    // up to the full 600s default budget.
    expect(parsed.ok).toBe(true);
    expect(parsed.data.background).toBe(true);
    expect(parsed.data.job.id).toMatch(/^job_/);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);

  it("keeps grok_continue in the foreground by default", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search --session-id"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"continued"}' '{"type":"end","stopReason":"end_turn","sessionId":"c1"}'
`
    );

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokContinue({ cwd: dir, _workspaceRoots: [dir], prompt: "finish", continueLatest: true })
      )
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.data.background).toBe(false);
    expect(parsed.data.finalText).toBe("continued");
  }, 30_000);

  it("warns when the caller explicitly blocks on a budget longer than two minutes", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search --session-id"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"OK"}' '{"type":"end","stopReason":"end_turn","sessionId":"b1"}'
`
    );
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const dispatched = envelope(
      await withEnv(env, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "dispatch", timeoutMs: 300_000 })
      )
    );
    const blocking = envelope(
      await withEnv(env, () =>
        grokRun({
          cwd: dir,
          _workspaceRoots: [dir],
          prompt: "dispatch",
          background: false,
          timeoutMs: 121_000
        })
      )
    );
    const short = envelope(
      await withEnv(env, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "dispatch", background: false, timeoutMs: 60_000 })
      )
    );

    expect(dispatched.warnings.join(" ")).not.toContain("blocks the MCP client");
    expect(blocking.warnings.join(" ")).toContain("blocks the MCP client");
    expect(short.warnings.join(" ")).not.toContain("blocks the MCP client");
  }, 60_000);
});
