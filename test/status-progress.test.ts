import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { grokResult, grokRun, grokStatus } from "../plugins/grok-plugin-codex/src/tools.js";
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

/** Emits a tool call and two text events after a short delay, then ends normally. */
function slowFakeGrok(): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","name":"read_file","data":{"path":"/tmp/a.ts"}}'
sleep 0.6
printf '%s\\n' '{"type":"text","data":"ABCDEFGHIJ"}' '{"type":"text","data":"KLMNOPQRST"}' '{"type":"end","stopReason":"end_turn","sessionId":"progress-session"}'
`;
}

async function startBackgroundJob(): Promise<{ jobId: string; env: Record<string, string> }> {
  const workspace = await tempDir();
  const stateDir = await tempDir();
  const grokBin = await makeExecutable(join(workspace, "grok"), slowFakeGrok());
  const env = { GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir };
  const started = envelope(
    await withEnv(env, () =>
      grokRun({ cwd: workspace, _workspaceRoots: [workspace], background: true, timeoutMs: 30_000, prompt: "go" })
    )
  );
  expect(started.ok).toBe(true);
  return { jobId: started.data.job.id, env };
}

describe("GPC-07 status progress and server-side wait", () => {
  it("blocks up to waitMs and reports that it waited", async () => {
    const { jobId, env } = await startBackgroundJob();

    const waited = envelope(await withEnv(env, () => grokStatus({ jobId, waitMs: 20_000 })));

    expect(waited.ok).toBe(true);
    expect(waited.data.waited).toBe(true);
    expect(["succeeded", "failed", "cancelled"]).toContain(waited.data.job.status);
  });

  it("returns cheap progress fields without a grok_result call", async () => {
    const { jobId, env } = await startBackgroundJob();
    await withEnv(env, () => grokStatus({ jobId, waitMs: 20_000 }));

    const parsed = envelope(await withEnv(env, () => grokStatus({ jobId })));

    expect(parsed.data.waited).toBe(false);
    expect(parsed.data.job.textChars).toBe(20);
    expect(parsed.data.job.eventCounts.text).toBe(2);
    expect(parsed.data.job.eventCounts.tool_call).toBe(1);
    expect(typeof parsed.data.job.lastEventAt).toBe("string");
    expect(parsed.data.job.deniedToolCalls).toEqual([]);
    expect(parsed.data.job.grokSessionId).toBe("progress-session");
    // The cheap path must stay cheap: no raw stream tail rides along.
    expect(parsed.data.job.stdoutTail).toBeUndefined();
  });
});

describe("GPC-07 result pagination", () => {
  it("returns a bounded window of finalText plus the offsets needed to page", async () => {
    const { jobId, env } = await startBackgroundJob();
    await withEnv(env, () => grokStatus({ jobId, waitMs: 20_000 }));

    const first = envelope(await withEnv(env, () => grokResult({ jobId, finalTextMaxChars: 5 })));
    const second = envelope(
      await withEnv(env, () => grokResult({ jobId, finalTextOffset: 5, finalTextMaxChars: 100 }))
    );

    expect(first.data.finalText).toBe("ABCDE");
    expect(first.data.finalTextChars).toBe(20);
    expect(first.data.finalTextOffset).toBe(0);
    expect(first.data.finalTextNextOffset).toBe(5);
    expect(first.data.outputSummary.finalText).toBe("ABCDE");
    expect(second.data.finalText).toBe("FGHIJKLMNOPQRST");
    expect(second.data.finalTextNextOffset).toBeUndefined();
  });

  it("returns the whole answer when no pagination is requested", async () => {
    const { jobId, env } = await startBackgroundJob();
    await withEnv(env, () => grokStatus({ jobId, waitMs: 20_000 }));

    const parsed = envelope(await withEnv(env, () => grokResult({ jobId })));

    expect(parsed.data.finalText).toBe("ABCDEFGHIJKLMNOPQRST");
    expect(parsed.data.finalTextChars).toBe(20);
  });
});
