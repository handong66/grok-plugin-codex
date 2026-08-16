import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_MS_BY_KIND,
  effectiveTimeoutMs,
  grokAdversarialReview,
  grokReview,
  grokRun
} from "../plugins/grok-plugin-codex/src/tools.js";
import { envelope, makeExecutable, tempDir, withEnv } from "./helpers.js";

/** Records the prompt file contents so the constructed prompt can be asserted on. */
function promptRecordingGrok(promptCopy: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents"; exit 0; fi
for arg in "$@"; do
  if [ "$prev" = "--prompt-file" ]; then cat "$arg" > ${JSON.stringify(promptCopy)}; fi
  prev="$arg"
done
printf '%s\\n' '{"type":"tool_call","toolCallId":"t1","name":"read_file","data":{"path":"/tmp/a.ts"}}' '{"type":"text","data":"answer"}' '{"type":"end","stopReason":"end_turn"}'
`;
}

describe("GPC-08 budget is stated in the prompt and echoed in the envelope", () => {
  it("tells the delegate its turn and wall-clock budget", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const promptCopy = join(stateDir, "prompt.txt");
    const grokBin = await makeExecutable(join(workspace, "grok"), promptRecordingGrok(promptCopy));

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokReview({
        cwd: workspace,
        _workspaceRoots: [workspace],
        background: false,
        timeoutMs: 60_000,
        maxTurns: 4,
        target: "src/tools.ts"
      })
    );
    const parsed = envelope(result);
    const prompt = await readFile(promptCopy, "utf8");

    expect(prompt).toContain("at most 4 tool-using turns");
    expect(prompt).toContain("stop calling tools and output the complete answer");
    expect(prompt).toContain("60 seconds");
    expect(parsed.data.effectiveMaxTurns).toBe(4);
    expect(parsed.data.effectiveTimeoutMs).toBe(60_000);
  });

  it("omits the turn sentence when no turn budget was set", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const promptCopy = join(stateDir, "prompt.txt");
    const grokBin = await makeExecutable(join(workspace, "grok"), promptRecordingGrok(promptCopy));

    await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokAdversarialReview({
        cwd: workspace,
        _workspaceRoots: [workspace],
        background: false,
        timeoutMs: 60_000,
        target: "src/tools.ts"
      })
    );
    const prompt = await readFile(promptCopy, "utf8");

    expect(prompt).not.toContain("tool-using turns");
    expect(prompt).toContain("60 seconds");
  });
});

describe("GK3 / SPEC D-M3 kind defaults", () => {
  it("uses a per-kind default budget instead of one 600s budget for everything", () => {
    expect(DEFAULT_TIMEOUT_MS_BY_KIND.run).toBe(180_000);
    expect(DEFAULT_TIMEOUT_MS_BY_KIND.continue).toBe(180_000);
    expect(DEFAULT_TIMEOUT_MS_BY_KIND.review).toBe(240_000);
    expect(DEFAULT_TIMEOUT_MS_BY_KIND.adversarial_review).toBe(300_000);
  });

  it("never overrides an explicit value, in either direction", () => {
    expect(effectiveTimeoutMs("run", 900_000)).toBe(900_000);
    expect(effectiveTimeoutMs("adversarial_review", 1_000)).toBe(1_000);
    expect(effectiveTimeoutMs("review", undefined)).toBe(240_000);
  });
});

describe("GPC-08 warn-only budget checks", () => {
  it("warns about a sub-30s budget and still runs it unchanged", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), promptRecordingGrok(join(stateDir, "p.txt")));

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 1_000,
          prompt: "quick"
        })
      )
    );

    const warnings = (parsed.warnings as string[]).join("\n");
    expect(warnings).toContain("timeoutMs=1000");
    expect(warnings).toContain("median 31s");
    expect(parsed.data?.effectiveTimeoutMs ?? parsed.error?.details?.effectiveTimeoutMs).toBe(1_000);
  });

  it("warns when a multi-turn budget is paired with a very large target", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), promptRecordingGrok(join(stateDir, "p.txt")));

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokReview({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 60_000,
          maxTurns: 4,
          target: "x".repeat(9_000)
        })
      )
    );

    expect((parsed.warnings as string[]).join("\n")).toMatch(/maxTurns/);
    expect((parsed.warnings as string[]).join("\n")).toContain("9000-character target");
  });

  /**
   * FINAL Review M12. The threshold is about how much the caller inlined, but it was measured on the
   * whole prompt — which the plugin itself pads with roughly 1.5k characters of headless preface,
   * read-only rules, evidence requirements and the budget sentence. A target comfortably under the
   * 8000-character limit therefore drew a warning telling the caller to inline less, and the number
   * quoted back at them was not a number they had ever chosen.
   */
  it("measures the caller's target, not the preamble the plugin adds to it", async () => {
    const workspace = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(workspace, "grok"), promptRecordingGrok(join(stateDir, "p.txt")));
    const target = "x".repeat(7_600);

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokReview({
          cwd: workspace,
          _workspaceRoots: [workspace],
          background: false,
          timeoutMs: 60_000,
          maxTurns: 4,
          target
        })
      )
    );
    const prompt = await readFile(join(stateDir, "p.txt"), "utf8");

    // The prompt really is over the threshold; the target really is under it.
    expect(prompt.length).toBeGreaterThan(8_000);
    expect(target.length).toBeLessThan(8_000);
    expect((parsed.warnings as string[]).join("\n")).not.toMatch(/invites exploration/);
  });
});
