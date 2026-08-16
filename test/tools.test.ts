import { access, mkdir, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContinueArgs,
  buildRunArgs,
  grokCheck,
  grokContinue,
  grokExport,
  grokModels,
  grokRescue,
  grokRun,
  grokSessions,
  grokStatus
} from "../plugins/grok-plugin-codex/src/tools.js";
import { STOP_REASON_SPELLINGS, fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function envelope(result: ToolResult): Record<string, any> {
  const parsed = JSON.parse(result.content[0].text) as Record<string, any>;
  expect(parsed).toEqual(result.structuredContent);
  expect(parsed).toHaveProperty("ok");
  expect(parsed).toHaveProperty("data");
  expect(parsed).toHaveProperty("error");
  expect(parsed).toHaveProperty("warnings");
  return parsed;
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

function roots(dir: string) {
  return { _workspaceRoots: [dir] };
}

describe("Grok tool handlers", () => {
  it("grok_check separates CLI discovery, authentication, model listing, and invocation evidence", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());

    const result = await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: dir, ...roots(dir) }));
    const parsed = envelope(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.cliDiscovered).toBe(true);
    expect(parsed.data.authenticated).toBe(true);
    expect(parsed.data.modelsListed).toBe(true);
    expect(parsed.data.modelInvocationTested).toBe(false);
    expect(parsed.data.callable).toBeNull();
    expect(parsed.data.contractVersion).toBe("2");
  });

  it("grok_check reports an authenticated-model probe failure as a typed business error", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"
  exit 0
fi
echo "not logged in" >&2
exit 7
`
    );

    const result = await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: dir, ...roots(dir) }));
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("auth_required");
    expect(parsed.error.retryable).toBe(true);
  });

  it("grok_check does not report an explicit unauthenticated response as logged in", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      fakeGrokScript({
        modelsOutput: [
          "You are not authenticated.",
          "",
          "Default model: grok-4.5",
          "",
          "Available models:",
          "  * grok-4.5 (default)"
        ].join("\n")
      })
    );

    const result = await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: dir, ...roots(dir) }));
    const parsed = envelope(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.authenticated).toBe(false);
    expect(parsed.data.models.loggedIn).toBe(false);
  });

  it.each(STOP_REASON_SPELLINGS.cancelled)(
    "returns %s output as a typed incomplete error with recovery metadata",
    async (stopReason) => {
      const dir = await tempDir();
      const stateDir = await tempDir();
      const grokBin = await makeExecutable(
        join(dir, "grok"),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\n' '{"type":"text","data":"I will review the diff."}' '{"type":"end","stopReason":"${stopReason}","sessionId":"cancelled-session","requestId":"cancelled-request"}'
`
      );

      const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "review" })
      );
      const parsed = envelope(result);

      expect(result.isError).toBe(true);
      expect(parsed.error.code).toBe("cancelled_output");
      expect(parsed.error.details.outputState).toBe("cancelled_partial");
      expect(parsed.error.details.stopReason).toBe(stopReason);
      expect(parsed.error.details.stopReasonNormalized).toBe("cancelled");
      expect(parsed.error.details.stopReasonRecognised).toBe(true);
      expect(parsed.error.details.grokSessionId).toBe("cancelled-session");
      expect(parsed.error.details.textPreview).toBe("I will review the diff.");
      // GK4: the remedy names the one-call primitive first, then the manual equivalent.
      expect(parsed.error.details.guidance).toContain("grok_finalize");
      expect(parsed.error.details.guidance).toContain("grok_continue, maxTurns: 1");
    }
  );

  it.each(STOP_REASON_SPELLINGS.endTurn)(
    "returns a complete foreground answer for a %s stream",
    async (stopReason) => {
      const dir = await tempDir();
      const stateDir = await tempDir();
      const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript({ stopReason }));

      const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        // An explicit short budget keeps this case free of the long-foreground-budget warning.
        grokRun({ cwd: dir, ...roots(dir), background: false, timeoutMs: 30_000, prompt: "review" })
      );
      const parsed = envelope(result);

      expect(parsed.ok).toBe(true);
      expect(parsed.data.finalText).toBe("OK");
      expect(parsed.data.outputSummary.resultComplete).toBe(true);
      expect(parsed.data.outputSummary.stopReason).toBe(stopReason);
      expect(parsed.data.outputSummary.stopReasonRecognised).toBe(true);
      expect(parsed.warnings).toEqual([]);
    }
  );

  it("accepts an unknown stop reason but reports it as an explicit warning", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript({ stopReason: "conversation_over" }));

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "review" })
    );
    const parsed = envelope(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.finalText).toBe("OK");
    expect(parsed.data.outputSummary.stopReasonRecognised).toBe(false);
    expect(parsed.data.outputSummary.stopReason).toBe("conversation_over");
    expect(parsed.warnings).toContain(
      'unrecognised stopReason "conversation_over"; treated as normal completion'
    );
  });

  it("returns max-turn exhaustion with bounded stderr and session metadata", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\n' '{"type":"max_turns_reached"}' '{"type":"end","stopReason":"cancelled","sessionId":"max-turns-session"}'
echo 'Error: max turns reached' >&2
exit 1
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "review" })
    );
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe("max_turns_reached");
    expect(parsed.error.details.stopReason).toBe("cancelled");
    expect(parsed.error.details.grokSessionId).toBe("max-turns-session");
    expect(parsed.error.details.stderrTail).toContain("max turns reached");
    expect(parsed.error.details.guidance).toContain("do not use any tools");
    expect(parsed.error.details.streamError.code).toBe("max_turns_reached");
  });

  it("grok_check can probe only discovery and capabilities", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"
  exit 0
fi
exit 99
`
    );

    const result = await withEnv({ GROK_BIN: grokBin }, () =>
      grokCheck({ cwd: dir, includeModels: false, ...roots(dir) })
    );
    const parsed = envelope(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.modelsListed).toBe(false);
    // GK1 third item / GPC-10.3: an undetermined fact is reported as "unknown", never as null —
    // a recorded gate decision read the null as "not authenticated" and let the next job start.
    expect(parsed.data.authenticated).toBe("unknown");
    expect(parsed.data.entitled).toBe("unknown");
  });

  it("grok_check proves callability only when the invocation probe is explicitly requested", async () => {
    const dir = await tempDir();
    const argsFile = join(dir, "probe-argv.log");
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"
  exit 0
fi
if { [ "$1" = "models" ]; } || { [ "$1" = "--cwd" ] && [ "$3" = "models" ]; }; then
  echo "You are logged in with grok.com."
  exit 0
fi
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\n' '{"type":"text","data":"OK"}' '{"type":"end","stopReason":"end_turn","sessionId":"probe"}'
`
    );

    const skipped = await withEnv({ GROK_BIN: grokBin }, () => grokCheck({ cwd: dir, ...roots(dir) }));
    const probed = await withEnv({ GROK_BIN: grokBin }, () =>
      grokCheck({ cwd: dir, ...roots(dir), probeInvocation: true })
    );
    const skippedParsed = envelope(skipped);
    const probedParsed = envelope(probed);
    const argv = await readFile(argsFile, "utf8");

    // Default stays off: the account behind this plugin hit its free limit ten times.
    expect(skippedParsed.data.modelInvocationTested).toBe(false);
    expect(skippedParsed.data.callable).toBeNull();
    expect(probedParsed.data.modelInvocationTested).toBe(true);
    expect(probedParsed.data.callable).toBe(true);
    expect(probedParsed.data.observedStopReason).toBe("end_turn");
    expect(probedParsed.data.observedStopReasonNormalized).toBe("endturn");
    expect(probedParsed.data.observedEventTypes).toEqual(["text", "end"]);
    expect(argv).toContain("--max-turns\n1\n");
    expect(argv).toContain("--permission-mode\nplan\n");
    expect(argv).toContain("--prompt-file\n");
    expect(argv).not.toContain("Reply with exactly");
  });

  it("grok_check reports an invocation probe that never reaches a normal end turn", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.0.3"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search"
  exit 0
fi
printf '%s\n' '{"type":"text","data":"OK"}' '{"type":"end","stopReason":"cancelled","sessionId":"probe"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin }, () =>
      grokCheck({ cwd: dir, includeModels: false, ...roots(dir), probeInvocation: true })
    );
    const parsed = envelope(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.modelInvocationTested).toBe(true);
    expect(parsed.data.callable).toBe(false);
    expect(parsed.data.observedStopReason).toBe("cancelled");
    expect(parsed.warnings.join(" ")).toContain("normal end turn");
  });

  it("grok_check refuses to spend quota on an invocation probe a CLI cannot run read-only", async () => {
    const dir = await tempDir();
    const argsFile = join(dir, "unreachable-probe-argv.log");
    // A Grok build that dropped `--permission-mode`: probing it would be an unconstrained live call.
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 1.1.0"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --no-subagents --disable-web-search"
  exit 0
fi
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\n' '{"type":"text","data":"OK"}' '{"type":"end","stopReason":"end_turn","sessionId":"probe"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin }, () =>
      grokCheck({ cwd: dir, includeModels: false, ...roots(dir), probeInvocation: true })
    );
    const parsed = envelope(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("cli_incompatible");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.details.missing).toEqual(["--permission-mode plan"]);
    expect(parsed.error.details.capabilities.permissionModePlan).toBe(false);
    await expect(access(argsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("grok_run sends prompt text through a private file descriptor instead of argv or retained state", async () => {
    const dir = await tempDir();
    const argsFile = join(dir, "argv.log");
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then
  echo "--prompt-file --output-format streaming-json --permission-mode plan --no-subagents --disable-web-search --reasoning-effort"
  exit 0
fi
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\n' '{"type":"text","data":"OK"}' '{"type":"end","stopReason":"end_turn","sessionId":"s1"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({
        cwd: dir,
        ...roots(dir),
        background: false,
        model: "grok-build",
        prompt: "review this diff",
        disableWebSearch: true,
        noSubagents: true,
        maxTurns: 1
      })
    );
    const parsed = envelope(result);
    const argv = await readFile(argsFile, "utf8");
    const argvLines = argv.trim().split("\n");
    const promptPath = argvLines[argvLines.indexOf("--prompt-file") + 1];

    expect(parsed.ok).toBe(true);
    expect(parsed.data.finalText).toBe("OK");
    expect(argv).toContain("--output-format\nstreaming-json\n");
    expect(argv).toContain("--prompt-file\n");
    expect(argv).not.toContain("review this diff");
    expect(promptPath).toBe("/dev/fd/3");
    expect((await readdir(join(stateDir, "jobs"))).filter((entry) => entry.endsWith(".input"))).toEqual([]);
  });

  it("does not forward unrelated environment variables to Grok", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
if [ "$GROK_PLUGIN_CODEX_SECRET_TEST" = "should-not-leak" ]; then value=LEAKED; else value=CLEAN; fi
printf '{"type":"text","data":"%s"}\n' "$value"
printf '%s\n' '{"type":"end","stopReason":"end_turn","sessionId":"s1"}'
`
    );

    const result = await withEnv(
      {
        GROK_BIN: grokBin,
        GROK_PLUGIN_STATE_DIR: stateDir,
        GROK_PLUGIN_CODEX_SECRET_TEST: "should-not-leak"
      },
      () => grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "env check" })
    );
    const parsed = envelope(result);

    expect(parsed.data.finalText).toBe("CLEAN");
  });

  it("returns an actionable non-retryable quota error", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
echo '{"type":"error","data":"HTTP 402 Payment Required: usage balance exhausted"}'
echo 'HTTP 402 Payment Required: usage balance exhausted' >&2
exit 1
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "quota probe" })
    );
    const parsed = envelope(result);

    expect(parsed.error.code).toBe("quota_exhausted");
    expect(parsed.error.retryable).toBe(false);
    expect(parsed.error.message).toContain("usage balance is exhausted");
  });

  it("fails when the Grok CLI closes the inherited prompt descriptor before full delivery", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/usr/bin/env node
import { closeSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("grok fake 0.2.93"); process.exit(0); }
if (args[0] === "--help") { console.log("--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"); process.exit(0); }
closeSync(3);
console.log(JSON.stringify({ type: "text", data: "invalid success" }));
console.log(JSON.stringify({ type: "end", sessionId: "s1" }));
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "x".repeat(250_000) })
    );
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe("prompt_delivery_error");
    expect(parsed.error.message).toContain("complete prompt");
  });

  it("passes --always-approve only for mutable runs when explicitly true", () => {
    const withoutApprove = buildRunArgs({ cwd: "/repo", alwaysApprove: false });
    const withApprove = buildRunArgs({ cwd: "/repo", alwaysApprove: true });
    const readOnly = buildRunArgs({ cwd: "/repo", alwaysApprove: true, readOnly: true });

    expect(withoutApprove.args).not.toContain("--always-approve");
    expect(withApprove.args).toContain("--always-approve");
    expect(readOnly.args).not.toContain("--always-approve");
    expect(readOnly.args).toContain("plan");
  });

  it("does not pass reasoningEffort for an omitted or known unsupported model", () => {
    const omitted = buildRunArgs({ cwd: "/repo", reasoningEffort: "high" });
    const unsupported = buildRunArgs({ cwd: "/repo", model: "grok-composer-2.5-fast", reasoningEffort: "high" });

    expect(omitted.args).not.toContain("--reasoning-effort");
    expect(unsupported.args).not.toContain("--reasoning-effort");
    expect(omitted.warnings).toHaveLength(1);
    expect(unsupported.warnings).toHaveLength(1);
  });

  it("blocks Codex private runtime paths as a typed business error", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const result = await grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "Read ~/.codex/config.toml." });
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe("private_path_blocked");
  });

  it("enforces read-only and no-subagents for rescue", async () => {
    const dir = await tempDir();
    const stateDir = await tempDir();
    const argsFile = join(dir, "rescue-argv.log");
    const grokBin = await makeExecutable(
      join(dir, "grok"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "grok fake 0.2.93"; exit 0; fi
if [ "$1" = "--help" ]; then echo "--prompt-file streaming-json --permission-mode plan --no-subagents --disable-web-search"; exit 0; fi
printf '%s\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\n' '{"type":"text","data":"diagnosis"}' '{"type":"end","stopReason":"end_turn","sessionId":"s1"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRescue({ cwd: dir, ...roots(dir), background: false, problem: "diagnose" })
    );
    const parsed = envelope(result);
    const argv = await readFile(argsFile, "utf8");

    expect(parsed.ok).toBe(true);
    expect(argv).toContain("--permission-mode\nplan\n");
    expect(argv).toContain("--no-subagents\n");
    expect(argv).not.toContain("diagnose");
  });

  it("requires an explicit continue target before probing the CLI", async () => {
    const dir = await tempDir();
    const result = await grokContinue({ cwd: dir, ...roots(dir), background: false, prompt: "continue" });
    const parsed = envelope(result);

    expect(parsed.error.code).toBe("continue_target_required");
  });

  it("rejects session identifiers that look like CLI flags", async () => {
    const dir = await tempDir();
    const continued = envelope(
      await grokContinue({ cwd: dir, ...roots(dir), background: false, prompt: "continue", sessionId: "--help" })
    );
    const exported = envelope(await grokExport({ cwd: dir, ...roots(dir), sessionId: "--help" }));

    expect(continued.error.code).toBe("invalid_session_id");
    expect(exported.error.code).toBe("invalid_session_id");
  });

  it("builds resume and explicit latest-session arguments without prompt text", () => {
    const resume = buildContinueArgs({ cwd: "/repo", sessionId: "session-1" });
    const latest = buildContinueArgs({ cwd: "/repo", continueLatest: true });

    expect(resume.args).toContain("--resume=session-1");
    expect(latest.args).toContain("--continue");
    expect(resume.args).not.toContain("-p");
  });

  it("returns session export as Markdown without a caller-selected output path", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());
    const result = await withEnv({ GROK_BIN: grokBin }, () =>
      grokExport({ cwd: dir, ...roots(dir), sessionId: "019f4258-2c1b-7960-ab1e-ca295e23533d" })
    );
    const parsed = envelope(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.data.markdown).toBe(
      `--cwd\n${await realpath(dir)}\nexport\n--\n019f4258-2c1b-7960-ab1e-ca295e23533d\n`
    );
  });

  it("separates session search queries from CLI flags", async () => {
    const dir = await tempDir();
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());
    const result = await withEnv({ GROK_BIN: grokBin }, () =>
      grokSessions({ cwd: dir, ...roots(dir), query: "--help" })
    );
    const parsed = envelope(result);

    expect(parsed.data.stdout).toContain("sessions\nsearch\n--\n--help\n");
  });

  it("rejects a cwd symlink that resolves outside the active workspace root", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const link = join(root, "outside-link");
    await symlink(outside, link);

    const parsed = envelope(await grokModels({ cwd: link, ...roots(root) }));

    expect(parsed.error.code).toBe("workspace_outside_roots");
  });

  it("rejects a configured state directory inside the active workspace", async () => {
    const dir = await tempDir();
    const stateDir = join(dir, ".private-state");
    const grokBin = await makeExecutable(join(dir, "grok"), fakeGrokScript());
    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({ cwd: dir, ...roots(dir), background: false, prompt: "state isolation probe" })
    );
    const parsed = envelope(result);

    expect(parsed.error.code).toBe("state_dir_in_workspace");
    await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects state storage anywhere inside an active workspace root, not only inside cwd", async () => {
    const root = await tempDir();
    const cwd = join(root, "subdirectory");
    const stateDir = join(root, ".private-state");
    await mkdir(cwd);
    const grokBin = await makeExecutable(join(root, "grok"), fakeGrokScript());

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd, ...roots(root), background: false, prompt: "root-wide state isolation probe" })
      )
    );

    expect(parsed.error.code).toBe("state_dir_in_workspace");
    await expect(access(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a state directory that contains an active workspace root", async () => {
    const stateDir = await tempDir();
    const root = join(stateDir, "workspace");
    await mkdir(root);
    const grokBin = await makeExecutable(join(root, "grok"), fakeGrokScript());

    const parsed = envelope(
      await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
        grokRun({ cwd: root, ...roots(root), background: false, prompt: "ancestor state isolation probe" })
      )
    );

    expect(parsed.error.code).toBe("state_dir_in_workspace");
  });

  it("returns a stable, non-leaking business error for an unknown job", async () => {
    const stateDir = await tempDir();
    const result = await withEnv({ GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokStatus({ jobId: "job_abcdefghijklmnop" })
    );
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe("job_not_found");
    expect(result.content[0].text).not.toContain(stateDir);
    expect(result.content[0].text).not.toContain("ENOENT");
  });

  it("sanitizes unexpected private state-store failures", async () => {
    const result = await withEnv({ GROK_PLUGIN_STATE_DIR: "/dev/null" }, () =>
      grokStatus({ jobId: "job_abcdefghijklmnop" })
    );
    const parsed = envelope(result);

    expect(result.isError).toBe(true);
    expect(parsed.error.code).toBe("internal_error");
    expect(parsed.error.message).toBe("The plugin encountered an internal error. Retry or run grok_check for diagnostics.");
    expect(result.content[0].text).not.toContain("/dev/null");
    // GK9(d): the errno is the one discriminator the caller gets — it names the failure class without
    // naming any path, message, or prompt text.
    expect(parsed.error.details).toEqual({ cause: "Error", errnoCode: "ENOTDIR" });
    expect(JSON.stringify(parsed.error.details)).not.toMatch(/\//);
  });
});
