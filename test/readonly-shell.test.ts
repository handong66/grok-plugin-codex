import { describe, expect, test } from "vitest";
import {
  HEADLESS_PREAMBLE,
  READ_ONLY_SHELL_NOTICE,
  buildReadOnlyPreamble
} from "../plugins/grok-plugin-codex/src/tools.js";
import { summarizeGrokOutput } from "../plugins/grok-plugin-codex/src/result-parser.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_readonlyshell0000000000",
    kind: "adversarial_review",
    status: "succeeded",
    cwd: "/tmp/workspace",
    command: "/usr/bin/grok",
    args: [],
    createdAt: new Date().toISOString(),
    timeoutMs: 240_000,
    readOnly: true,
    ...overrides
  };
}

/** One denied shell call, exactly the shape recorded in 24 of the 56 plan-mode jobs. */
function deniedShellStream(): string {
  return [
    JSON.stringify({ type: "tool_call", toolCallId: "t1", name: "run_terminal_command", data: { command: "git diff" } }),
    JSON.stringify({
      type: "tool_call_update",
      toolCallId: "t1",
      name: "run_terminal_command",
      data: { status: "error", result: "User cancelled the execution for tool run_terminal_command" }
    }),
    JSON.stringify({ type: "text", data: "Verdict: FAIL. Diff was never loaded." }),
    JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "s-1" })
  ].join("\n");
}

describe("GPC-06 read-only shell notice", () => {
  test("every read-only prompt states that shell execution is unavailable", () => {
    const preamble = buildReadOnlyPreamble({ kind: "review", timeoutMs: 240_000 }).join("\n");

    expect(preamble).toContain(HEADLESS_PREAMBLE);
    expect(preamble).toContain("240 seconds");
    expect(preamble).toContain(READ_ONLY_SHELL_NOTICE);
    expect(READ_ONLY_SHELL_NOTICE).toContain("Shell/terminal execution is disabled in this session");
    expect(READ_ONLY_SHELL_NOTICE).toContain("Do not call run_terminal_command");
    expect(READ_ONLY_SHELL_NOTICE).toContain("do not report FAIL for evidence you were never given");
  });
});

describe("GPC-06 denied tool calls", () => {
  test("a denied run_terminal_command is counted, warned about, and named in the guidance", () => {
    const summary = summarizeGrokOutput(record(), deniedShellStream());

    expect(summary.deniedToolCalls).toEqual([{ name: "run_terminal_command", count: 1 }]);
    expect(summary.warnings.join("\n")).toContain("run_terminal_command");
    expect(summary.guidance).toContain("Inline the required command output");
  });

  test("repeat denials of the same tool are aggregated", () => {
    const stream = [deniedShellStream(), deniedShellStream()].join("\n");
    const summary = summarizeGrokOutput(record(), stream);

    expect(summary.deniedToolCalls).toEqual([{ name: "run_terminal_command", count: 2 }]);
  });

  test("a stream with no denial reports an empty list and keeps the normal guidance", () => {
    const stream = [
      JSON.stringify({ type: "tool_call", toolCallId: "t1", name: "read_file", data: { path: "/tmp/workspace/a.ts" } }),
      JSON.stringify({ type: "text", data: "x".repeat(500) }),
      JSON.stringify({ type: "end", stopReason: "end_turn" })
    ].join("\n");
    const summary = summarizeGrokOutput(record(), stream);

    expect(summary.deniedToolCalls).toEqual([]);
    expect(summary.guidance).not.toContain("Inline the required command output");
  });
});
