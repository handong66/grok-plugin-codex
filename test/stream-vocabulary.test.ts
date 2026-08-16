import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  normalizeStopReason,
  sessionIdFromStderr,
  summarizeGrokOutput
} from "../plugins/grok-plugin-codex/src/result-parser.js";
import type { JobRecord } from "../plugins/grok-plugin-codex/src/types.js";

function record(status: JobRecord["status"]): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind: "run",
    status,
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    timeoutMs: 600_000
  };
}

function stream(stopReason: string | undefined, text = "Final answer."): string {
  const end: Record<string, unknown> = { type: "end", sessionId: "s1", requestId: "r1" };
  if (stopReason !== undefined) end.stopReason = stopReason;
  return [JSON.stringify({ type: "text", data: text }), JSON.stringify(end)].join("\n");
}

async function fixture(name: string): Promise<string> {
  return await readFile(fileURLToPath(new URL(`./fixtures/grok-1.0.x/${name}`, import.meta.url)), "utf8");
}

describe("stop reason normalisation", () => {
  it("strips case and separators", () => {
    expect(normalizeStopReason("EndTurn")).toBe("endturn");
    expect(normalizeStopReason("end_turn")).toBe("endturn");
    expect(normalizeStopReason("END-TURN")).toBe("endturn");
    expect(normalizeStopReason("Cancelled")).toBe("cancelled");
    expect(normalizeStopReason(undefined)).toBe("");
  });

  // The 0.2.1 parser only matched the PascalCase spelling; Grok 1.0.x emits snake_case,
  // which made resultComplete false for every real completion.
  it.each(["EndTurn", "end_turn", "END_TURN", "endTurn"])(
    "accepts %s as a normal completion",
    (stopReason) => {
      const summary = summarizeGrokOutput(record("succeeded"), stream(stopReason));

      expect(summary.resultComplete).toBe(true);
      expect(summary.state).toBe("succeeded_with_text");
      expect(summary.stopReason).toBe(stopReason);
      expect(summary.stopReasonNormalized).toBe("endturn");
      expect(summary.stopReasonRecognised).toBe(true);
      expect(summary.warnings).toEqual([]);
    }
  );

  it.each(["Cancelled", "cancelled", "CANCELED", "canceled"])(
    "treats %s as partial output",
    (stopReason) => {
      const summary = summarizeGrokOutput(record("succeeded"), stream(stopReason));

      expect(summary.resultComplete).toBe(false);
      expect(summary.state).toBe("cancelled_partial");
      expect(summary.stopReason).toBe(stopReason);
      expect(summary.stopReasonRecognised).toBe(true);
      expect(summary.finalText).toBe("Final answer.");
    }
  );

  it("fails open on an unknown stop reason that still ended with text", () => {
    const summary = summarizeGrokOutput(record("succeeded"), stream("finished_normally"));

    expect(summary.resultComplete).toBe(true);
    expect(summary.state).toBe("succeeded_with_text");
    expect(summary.stopReason).toBe("finished_normally");
    expect(summary.stopReasonNormalized).toBe("finishednormally");
    expect(summary.stopReasonRecognised).toBe(false);
    expect(summary.warnings).toContain(
      'unrecognised stopReason "finished_normally"; treated as normal completion'
    );
  });

  it("fails open when the end event carries no stop reason at all", () => {
    const summary = summarizeGrokOutput(record("succeeded"), stream(undefined));

    expect(summary.resultComplete).toBe(true);
    expect(summary.stopReasonRecognised).toBe(false);
    expect(summary.warnings).toHaveLength(1);
  });

  it("does not fail open without an end event or without text", () => {
    const noEnd = summarizeGrokOutput(record("succeeded"), JSON.stringify({ type: "text", data: "partial" }));
    const noText = summarizeGrokOutput(record("succeeded"), stream("mystery", "   "));

    expect(noEnd.resultComplete).toBe(false);
    expect(noEnd.warnings).toEqual([]);
    expect(noText.resultComplete).toBe(false);
    expect(noText.state).toBe("succeeded_without_text");
  });

  it("keeps truncated output incomplete even when the stop reason is unknown", () => {
    const summary = summarizeGrokOutput(record("succeeded"), stream("mystery"), "", true);

    expect(summary.resultComplete).toBe(false);
    expect(summary.outputTruncated).toBe(true);
  });
});

describe("session id recovery from stderr", () => {
  // Recorded shape: `ERROR tool_error: tool_output_error session_id=<uuid> tool_name="Read" ...`
  const stderr =
    'ERROR tool_error: tool_output_error session_id=019f436e-b14c-7c23-b7f4-505e81ef1f3b tool_name="Read"';

  it("extracts the session id the CLI printed to stderr", () => {
    expect(sessionIdFromStderr(stderr)).toBe("019f436e-b14c-7c23-b7f4-505e81ef1f3b");
    expect(sessionIdFromStderr("no session here")).toBeUndefined();
  });

  it("recovers a session id for a run that never emitted an end event", () => {
    const summary = summarizeGrokOutput(
      record("failed"),
      JSON.stringify({ type: "text", data: "partial work" }),
      stderr
    );

    expect(summary.sawEnd).toBe(false);
    expect(summary.grokSessionId).toBe("019f436e-b14c-7c23-b7f4-505e81ef1f3b");
  });

  it("never overrides the session id reported by the end event", () => {
    const summary = summarizeGrokOutput(record("succeeded"), stream("end_turn"), stderr);

    expect(summary.grokSessionId).toBe("s1");
  });
});

describe("recorded Grok 1.0.x stream replay", () => {
  it("marks a real end_turn capture complete", async () => {
    const summary = summarizeGrokOutput(record("succeeded"), await fixture("end-turn-success.jsonl"));

    expect(summary.stopReason).toBe("end_turn");
    expect(summary.stopReasonNormalized).toBe("endturn");
    expect(summary.stopReasonRecognised).toBe(true);
    expect(summary.resultComplete).toBe(true);
    expect(summary.state).toBe("succeeded_with_text");
    expect(summary.grokSessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(summary.requestId).toBe("00000000-0000-4000-8000-000000000002");
    expect(summary.textEventCount).toBe(4);
    expect(summary.eventCounts.tool_call).toBe(2);
    expect(summary.warnings).toEqual([]);
  });

  it("marks a real cancelled capture partial without discarding its text", async () => {
    const summary = summarizeGrokOutput(record("succeeded"), await fixture("cancelled-with-text.jsonl"));

    expect(summary.stopReason).toBe("cancelled");
    expect(summary.stopReasonRecognised).toBe(true);
    expect(summary.resultComplete).toBe(false);
    expect(summary.state).toBe("cancelled_partial");
    expect(summary.finalText).toBeTruthy();
  });

  it("keeps a real max_turns_reached capture a typed partial failure", async () => {
    const summary = summarizeGrokOutput(
      record("failed"),
      await fixture("max-turns-reached.jsonl"),
      "Error: max turns reached"
    );

    expect(summary.resultComplete).toBe(false);
    expect(summary.state).toBe("failed_partial");
    expect(summary.streamError?.code).toBe("max_turns_reached");
  });

  it("keeps a real free-tier error capture a stream failure", async () => {
    const summary = summarizeGrokOutput(record("failed"), await fixture("free-tier-quota-error.jsonl"));

    expect(summary.resultComplete).toBe(false);
    expect(summary.state).toBe("failed_partial");
    expect(summary.streamError).toBeDefined();
  });
});
