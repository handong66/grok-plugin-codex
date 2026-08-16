import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizeGrokOutput } from "../plugins/grok-plugin-codex/src/result-parser.js";
import { grokAdversarialReview, grokResult, grokReview, grokRun } from "../plugins/grok-plugin-codex/src/tools.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";
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

function record(kind: JobRecord["kind"], status: JobRecord["status"] = "succeeded"): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind,
    status,
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    timeoutMs: 600_000
  };
}

const VERDICT = "GO. The change looks correct and I see no problems with it.";

function verdictStream(withEvidence: boolean): string {
  const lines: string[] = [];
  if (withEvidence) {
    lines.push(
      JSON.stringify({
        type: "tool_call",
        toolCallId: "tool-1",
        toolName: "read_file",
        kind: "read",
        rawInput: { path: "/repo/src/index.ts" }
      }),
      JSON.stringify({ type: "tool_call_update", toolCallId: "tool-1", status: "completed" })
    );
  }
  lines.push(
    JSON.stringify({ type: "text", data: `${VERDICT} `.repeat(20) }),
    JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "verdict", num_turns: 3 })
  );
  return lines.join("\n");
}

/** Answers immediately with a verdict and never touches a tool. */
const ZERO_EVIDENCE_GROK = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"GO. No issues found."}' '{"type":"end","stopReason":"end_turn","sessionId":"zero-evidence"}'
`;

describe("evidence contract (X2 / GK2)", () => {
  it("counts tool calls, inspected files, and turns", () => {
    const summary = summarizeGrokOutput(record("review"), verdictStream(true));

    expect(summary.toolCallCount).toBe(1);
    expect(summary.filesInspected).toEqual(["/repo/src/index.ts"]);
    expect(summary.turnsUsed).toBe(3);
    expect(summary.evidenceLevel).toBe("substantive");
    expect(summary.resultComplete).toBe(true);
  });

  it("refuses to call a zero-tool-call review verdict complete", () => {
    const summary = summarizeGrokOutput(record("review"), verdictStream(false));

    // 30/64 succeeded jobs opened nothing, and the orchestrator counted each as a vote.
    expect(summary.toolCallCount).toBe(0);
    expect(summary.evidenceLevel).toBe("none");
    expect(summary.state).toBe("succeeded_with_text");
    expect(summary.resultComplete).toBe(false);
    expect(summary.warnings).toContain("verdict produced with 0 tool calls — treat as opinion, not review");
    expect(summary.guidance).toContain("not count it as a review");
    // The answer itself is never destroyed.
    expect(summary.finalText).toContain("GO.");
  });

  it("leaves a plain run alone: only review kinds carry the evidence obligation", () => {
    const summary = summarizeGrokOutput(record("run"), verdictStream(false));

    expect(summary.evidenceLevel).toBe("none");
    expect(summary.resultComplete).toBe(true);
    expect(summary.warnings).toEqual([]);
  });

  it("marks a tool-using but very short answer thin without failing it", () => {
    const stream = [
      JSON.stringify({ type: "tool_call", toolCallId: "t1", rawInput: { path: "/repo/a.ts" } }),
      JSON.stringify({ type: "text", data: "LGTM" }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n");

    const summary = summarizeGrokOutput(record("adversarial_review"), stream);

    expect(summary.evidenceLevel).toBe("thin");
    expect(summary.resultComplete).toBe(true);
  });

  it("redacts the roots out of filesInspected, which holds paths Grok chose", () => {
    const home = process.env.HOME ?? "/home/nobody";
    const stream = [
      JSON.stringify({ type: "tool_call", toolCallId: "t1", rawInput: { path: `${home}/.grok/skills/pua/SKILL.md` } }),
      JSON.stringify({ type: "tool_call", toolCallId: "t2", rawInput: { path: "/repo/src/index.ts" } }),
      JSON.stringify({ type: "text", data: "x".repeat(500) }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n");

    const summary = summarizeGrokOutput(record("review"), stream);

    // 57 of 128 recorded runs opened a persona file under the home directory; those are not the
    // caller's locations, and this array reaches every public envelope.
    expect(summary.filesInspected).toContain("<home>/.grok/skills/pua/SKILL.md");
    expect(summary.filesInspected.join(" ")).not.toContain(home);
    // A path the caller chose — inside the reviewed workspace — is left alone.
    expect(summary.filesInspected).toContain("/repo/src/index.ts");
  });

  it("redacts the private state directory out of a public grok_result", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","toolName":"read_file","rawInput":{"path":"${stateDir}/jobs/leaked.json"}}' '{"type":"text","data":"read the job record"}' '{"type":"end","stopReason":"end_turn"}'
`
    );

    const started = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "peek at state", timeoutMs: 20_000 })
      )
    );
    const jobId = started.data.job.id as string;
    const finished = await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const parsed = envelope(await grokResult({ jobId }));
        if (!["queued", "running"].includes(parsed.data?.job.status)) return parsed;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error("Job never reached a terminal state.");
    });

    expect(finished.data.outputSummary.filesInspected).toEqual(["<state>/jobs/leaked.json"]);
  }, 30_000);

  it("counts tool calls in a real recorded capture", async () => {
    const fixture = await readFile(
      fileURLToPath(new URL("./fixtures/grok-1.0.x/end-turn-success.jsonl", import.meta.url)),
      "utf8"
    );

    const summary = summarizeGrokOutput(record("review"), fixture);

    expect(summary.toolCallCount).toBeGreaterThan(0);
    expect(summary.resultComplete).toBe(true);
  });

  it("returns a zero-evidence review as its own typed error that still exposes the text", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), ZERO_EVIDENCE_GROK);

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokReview({ cwd: dir, _workspaceRoots: [dir], target: "src/index.ts", background: false, timeoutMs: 20_000 })
      )
    );
    const jobId = parsed.error.details.recovery.jobId as string;
    const fetched = envelope(await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, () => grokResult({ jobId })));

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("no_evidence_review");
    expect(parsed.error.details.evidenceLevel).toBe("none");
    expect(parsed.error.details.toolCallCount).toBe(0);
    expect(fetched.data.finalText).toBe("GO. No issues found.");
  }, 30_000);

  it("does not store a vendor cancelled stop reason as a succeeded job", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\\n' '{"type":"text","data":"partial work"}' '{"type":"end","stopReason":"cancelled","sessionId":"vendor-cancel"}'
`
    );

    const started = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, _workspaceRoots: [dir], prompt: "cancelled run", timeoutMs: 20_000 })
      )
    );
    const jobId = started.data.job.id as string;
    const finished = await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const parsed = envelope(await grokResult({ jobId }));
        if (!["queued", "running"].includes(parsed.data?.job.status)) return parsed;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      throw new Error("Job never reached a terminal state.");
    });

    // 24 of 64 recorded jobs ended `stopReason: cancelled` and were stored as `succeeded`.
    expect(finished.data.job.status).toBe("cancelled");
    expect(finished.data.job.error).toBeUndefined();
    expect(finished.data.outputSummary.state).toBe("cancelled_partial");
    expect(finished.data.finalText).toBe("partial work");
  }, 30_000);

  it("stops capping adversarial findings at five and demands file:line evidence", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const promptPath = join(dir, "adversarial.prompt.txt");
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      [
        "#!/usr/bin/env node",
        "import { readFileSync, writeFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('grok fake 1.0.3'); process.exit(0); }",
        "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
        "const index = args.indexOf('--prompt-file');",
        `writeFileSync(${JSON.stringify(promptPath)}, readFileSync(args[index + 1], 'utf8'));`,
        "console.log(JSON.stringify({ type: 'tool_call', toolCallId: 't1', rawInput: { path: '/repo/src/index.ts' } }));",
        "console.log(JSON.stringify({ type: 'text', data: 'F'.repeat(500) }));",
        "console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn' }));"
      ].join("\n")
    );

    await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokAdversarialReview({
        cwd: dir,
        _workspaceRoots: [dir],
        target: "src/index.ts",
        background: false,
        timeoutMs: 20_000
      })
    );
    const prompt = await readFile(promptPath, "utf8");

    expect(prompt).not.toContain("at most 5 findings");
    expect(prompt).toContain("mark the first 5 as primary");
    expect(prompt).toContain("exact file:line evidence");
    expect(prompt).toContain("list exactly what you read or ran");
  }, 30_000);
});
