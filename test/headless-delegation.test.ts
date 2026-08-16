import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeGrokOutput } from "../plugins/grok-plugin-codex/src/result-parser.js";
import {
  HEADLESS_PREAMBLE,
  grokAdversarialReview,
  grokRescue,
  grokReview
} from "../plugins/grok-plugin-codex/src/tools.js";
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

function record(kind: JobRecord["kind"]): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind,
    status: "succeeded",
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    timeoutMs: 600_000
  };
}

/** Copies the prompt it was handed so the test can read what the plugin actually sent. */
async function promptCapturingGrok(dir: string, name: string): Promise<{ bin: string; promptPath: string }> {
  const promptPath = join(dir, `${name}.prompt.txt`);
  const bin = await makeExecutable(
    join(dir, name),
    [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('grok fake 1.0.3'); process.exit(0); }",
      "if (args[0] === '--help') { console.log('--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search'); process.exit(0); }",
      "const index = args.indexOf('--prompt-file');",
      `writeFileSync(${JSON.stringify(promptPath)}, readFileSync(args[index + 1], 'utf8'));`,
      "console.log(JSON.stringify({ type: 'tool_call', toolCallId: 't1', toolName: 'read_file' }));",
      "console.log(JSON.stringify({ type: 'text', data: 'ANSWER '.repeat(80) }));",
      "console.log(JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'headless' }));"
    ].join("\n")
  );
  return { bin, promptPath };
}

describe("headless delegation preamble (X1)", () => {
  it.each([
    ["grok_review", "review", (args: any) => grokReview({ ...args, target: "src/index.ts" })],
    [
      "grok_adversarial_review",
      "adversarial",
      (args: any) => grokAdversarialReview({ ...args, target: "src/index.ts" })
    ],
    ["grok_rescue", "rescue", (args: any) => grokRescue({ ...args, problem: "diagnose" })]
  ])("%s tells Grok not to bootstrap interactive personas", async (_tool, name, invoke) => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grok = await promptCapturingGrok(dir, `grok-${name}`);

    const parsed = envelope(
      await withEnv({ GROK_BIN: grok.bin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        invoke({ cwd: dir, _workspaceRoots: [dir], background: false, timeoutMs: 30_000 })
      )
    );
    const prompt = await readFile(grok.promptPath, "utf8");

    expect(parsed.ok).toBe(true);
    expect(prompt).toContain(HEADLESS_PREAMBLE);
    expect(prompt).toContain("load pua first");
    expect(prompt).toContain("Your only text output is the final answer.");
  }, 40_000);

  it("surfaces skill files the delegate opened anyway", () => {
    const stream = [
      JSON.stringify({
        type: "tool_call",
        toolCallId: "t1",
        toolName: "read_file",
        rawInput: { path: "/Users/dev/.grok/skills/pua/SKILL.md" }
      }),
      JSON.stringify({
        type: "tool_call",
        toolCallId: "t2",
        toolName: "read_file",
        rawInput: { path: "/Users/dev/.claude/skills/using-superpowers/SKILL.md" }
      }),
      JSON.stringify({ type: "text", data: "answer" }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n");

    const summary = summarizeGrokOutput(record("run"), stream);

    expect(summary.skillsLoaded).toEqual(["pua", "using-superpowers"]);
    expect(summary.warnings.join(" ")).toContain("interactive skill file");
    expect(summary.resultComplete).toBe(true);
  });

  it("reports no skill loads for an ordinary stream", () => {
    const stream = [
      JSON.stringify({ type: "tool_call", toolCallId: "t1", rawInput: { path: "/repo/src/index.ts" } }),
      JSON.stringify({ type: "text", data: "answer" }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n");

    const summary = summarizeGrokOutput(record("run"), stream);

    expect(summary.skillsLoaded).toEqual([]);
    expect(summary.warnings).toEqual([]);
  });
});
