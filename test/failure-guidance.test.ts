import { describe, expect, it } from "vitest";
import { grokFailureMessage } from "../plugins/grok-plugin-codex/src/grok-cli.js";
import { summarizeGrokOutput } from "../plugins/grok-plugin-codex/src/result-parser.js";
import type { JobRecord, PluginErrorInfo } from "../plugins/grok-plugin-codex/src/types.js";

/**
 * GK4 / GPC-05.4 / X7. The envelope has two human-readable fields — `error.message` and
 * `outputSummary.guidance` — and a delegating agent reads the second one. Before this test both
 * fell through to the generic failed branch on a wall-clock timeout (29 of 64 recorded failures)
 * and told the caller to "rerun with a narrower prompt", the exact sentence both READMEs, the
 * SKILL and the typed error had already replaced with the one-turn tool-free continuation.
 */
function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job_1700000000000_abcdef12",
    kind: "run",
    status: "failed",
    cwd: "/repo",
    command: "grok",
    args: [],
    createdAt: "2026-08-16T00:00:00.000Z",
    timeoutMs: 600_000,
    ...overrides
  };
}

function failure(code: string): PluginErrorInfo {
  return { code, message: grokFailureMessage(code), retryable: true, details: { phase: "run" } };
}

/** A killed or timed-out run never emits `end`, so there is text and nothing else. */
const partialStream = JSON.stringify({ type: "text", data: "I have read the diff and I am about to" });

const NARROWING_ADVICE = /narrow(er|ing)?\b/i;

describe("guidance for a run that was still alive when it ended", () => {
  it.each(["timeout", "terminated", "max_turns_reached"])(
    "names grok_finalize for a %s with no stderr",
    (code) => {
      const summary = summarizeGrokOutput(record({ error: failure(code) }), partialStream);

      expect(summary.guidance).toBe(grokFailureMessage(code));
      expect(summary.guidance).toContain("grok_finalize");
      expect(summary.guidance).toContain("maxTurns: 1");
      expect(summary.guidance).not.toMatch(NARROWING_ADVICE);
      expect(summary.resultComplete).toBe(false);
      expect(summary.finalText).toContain("I have read the diff");
    }
  );

  it("keeps the same remedy when the run did leave stderr behind", () => {
    const summary = summarizeGrokOutput(
      record({ error: failure("timeout") }),
      partialStream,
      "session_id=0f4a2f3e-1111-4222-8333-444455556666 stream closed\n"
    );

    expect(summary.guidance).toContain("grok_finalize");
    expect(summary.guidance).not.toMatch(NARROWING_ADVICE);
    // The continuation handle the remedy depends on is still recovered from that stderr.
    expect(summary.grokSessionId).toBe("0f4a2f3e-1111-4222-8333-444455556666");
  });

  it("does not tell a caller to rerun narrower when the cause is unclassified", () => {
    const summary = summarizeGrokOutput(record({ error: failure("spawn_error") }), partialStream);

    expect(summary.guidance).not.toMatch(NARROWING_ADVICE);
    expect(summary.guidance).toContain("error.details");
  });
});

describe("guidance while a job is still in flight", () => {
  it.each(["running", "queued"] as const)("tells a %s caller when cancelling is warranted", (status) => {
    const summary = summarizeGrokOutput(record({ status, error: undefined }), partialStream);

    // X7: 26 of 43 recorded cancels fired before the median completion time for the kind.
    expect(summary.guidance).not.toMatch(NARROWING_ADVICE);
    expect(summary.guidance).toContain("Do not cancel before");
    expect(summary.guidance).toContain("waitingForAuth");
    expect(summary.guidance).toContain("45s");
    expect(summary.state).toBe(status === "running" ? "running_partial" : "queued_partial");
  });
});
