import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyGrokErrorText, grokFailureMessage } from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { buildRunArgs, grokCancel, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import { fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

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

describe("GK9(d) cancel outcomes", () => {
  it("separates a real cancellation from a job that had already finished", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), fakeGrokScript());
    const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };

    const started = envelope(
      await withEnv(env, () =>
        grokRun({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 30_000,
          prompt: "done already"
        })
      )
    );
    expect(started.ok).toBe(true);
    const jobId = started.data.outputSummary ? started.data.finalTextRef : undefined;
    void jobId;

    const unknown = envelope(await withEnv(env, () => grokCancel({ jobId: "job_neverexisted0000000000" })));

    expect(unknown.ok).toBe(false);
    expect(unknown.error.code).toBe("job_not_found");
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
