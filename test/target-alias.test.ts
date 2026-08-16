import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokAdversarialReview, grokRescue, grokReview } from "../plugins/grok-plugin-codex/src/tools.js";
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

function promptRecordingGrok(promptCopy: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
for arg in "$@"; do
  if [ "$prev" = "--prompt-file" ]; then cat "$arg" > ${JSON.stringify(promptCopy)}; fi
  prev="$arg"
done
printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","name":"read_file","data":{"path":"/tmp/a.ts"}}' '{"type":"text","data":"reviewed"}' '{"type":"end","stopReason":"end_turn"}'
`;
}

async function setup() {
  const workspace = await tempDir();
  const stateDir = await tempDir();
  const promptCopy = join(stateDir, "prompt.txt");
  const grokBin = await makeExecutable(join(workspace, "grok"), promptRecordingGrok(promptCopy));
  return {
    workspace,
    promptCopy,
    env: { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir },
    common: { _workspaceRoots: [workspace], background: false as const, timeoutMs: 30_000 }
  };
}

describe("GPC-11 sibling-plugin argument name", () => {
  it("accepts the opencode spelling `prompt` for a review target", async () => {
    const { workspace, promptCopy, env, common } = await setup();

    const parsed = envelope(
      await withEnv(env, () => grokReview({ cwd: workspace, ...common, prompt: "review the diff in src/tools.ts" }))
    );
    const prompt = await readFile(promptCopy, "utf8");

    expect(parsed.ok).toBe(true);
    expect(prompt).toContain("review the diff in src/tools.ts");
  });

  it("accepts `prompt` for grok_rescue as well", async () => {
    const { workspace, promptCopy, env, common } = await setup();

    const parsed = envelope(
      await withEnv(env, () => grokRescue({ cwd: workspace, ...common, prompt: "the build hangs at link time" }))
    );

    expect(parsed.ok).toBe(true);
    expect(await readFile(promptCopy, "utf8")).toContain("the build hangs at link time");
  });

  it("rejects a call that names neither field, and one that names both", async () => {
    const { workspace, env, common } = await setup();

    const neither = envelope(await withEnv(env, () => grokReview({ cwd: workspace, ...common })));
    const both = envelope(
      await withEnv(env, () => grokReview({ cwd: workspace, ...common, target: "a", prompt: "b" }))
    );

    expect(neither.ok).toBe(false);
    expect(neither.error.code).toBe("target_required");
    expect(neither.error.message).toContain("prompt");
    expect(both.ok).toBe(false);
    expect(both.error.code).toBe("target_required");
  });

  it("joins an array target into a bulleted block", async () => {
    const { workspace, promptCopy, env, common } = await setup();

    await withEnv(env, () =>
      grokAdversarialReview({ cwd: workspace, ...common, target: ["src/a.ts", "src/b.ts"] })
    );
    const prompt = await readFile(promptCopy, "utf8");

    expect(prompt).toContain("- src/a.ts");
    expect(prompt).toContain("- src/b.ts");
  });
});

describe("GK9(b) target block", () => {
  it("does not prefix the target with a bare `Review `", async () => {
    const { workspace, promptCopy, env, common } = await setup();

    await withEnv(env, () => grokReview({ cwd: workspace, ...common, target: "Review the current working tree diff" }));
    const prompt = await readFile(promptCopy, "utf8");

    expect(prompt).not.toContain("Review Review the current working tree diff");
    expect(prompt).toContain("Target:\nReview the current working tree diff");
  });
});

describe("X3 threat model", () => {
  it("states the caller's scope and forbids out-of-model findings from blocking", async () => {
    const { workspace, promptCopy, env, common } = await setup();

    await withEnv(env, () =>
      grokAdversarialReview({
        cwd: workspace,
        ...common,
        target: "src/tools.ts",
        threatModel: "single-user local application; no network exposure"
      })
    );
    const prompt = await readFile(promptCopy, "utf8");

    expect(prompt).toContain("single-user local application; no network exposure");
    expect(prompt).toContain("out-of-model");
    expect(prompt).toContain("must never be a blocker");
    // Neutral engineering vocabulary only: the recorded run was cut off by a cybersecurity filter.
    expect(prompt).not.toMatch(/attacker|malicious|attack chain/i);
  });

  it("says the scope was not given rather than inventing one", async () => {
    const { workspace, promptCopy, env, common } = await setup();

    await withEnv(env, () => grokAdversarialReview({ cwd: workspace, ...common, target: "src/tools.ts" }));

    expect(await readFile(promptCopy, "utf8")).toContain("Not specified by the caller");
  });
});
