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
import { fakeGrokScript, makeExecutable, tempDir } from "./helpers.js";

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
    expect(parsed.data.authenticated).toBeNull();
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
printf '%s\n' '{"type":"text","data":"OK"}' '{"type":"end","sessionId":"s1"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRun({
        cwd: dir,
        ...roots(dir),
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
printf '%s\n' '{"type":"end","sessionId":"s1"}'
`
    );

    const result = await withEnv(
      {
        GROK_BIN: grokBin,
        GROK_PLUGIN_STATE_DIR: stateDir,
        GROK_PLUGIN_CODEX_SECRET_TEST: "should-not-leak"
      },
      () => grokRun({ cwd: dir, ...roots(dir), prompt: "env check" })
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
      grokRun({ cwd: dir, ...roots(dir), prompt: "quota probe" })
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
      grokRun({ cwd: dir, ...roots(dir), prompt: "x".repeat(250_000) })
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
    const result = await grokRun({ cwd: dir, ...roots(dir), prompt: "Read ~/.codex/config.toml." });
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
printf '%s\n' '{"type":"text","data":"diagnosis"}' '{"type":"end","sessionId":"s1"}'
`
    );

    const result = await withEnv({ GROK_BIN: grokBin, GROK_PLUGIN_STATE_DIR: stateDir }, () =>
      grokRescue({ cwd: dir, ...roots(dir), problem: "diagnose" })
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
    const result = await grokContinue({ cwd: dir, ...roots(dir), prompt: "continue" });
    const parsed = envelope(result);

    expect(parsed.error.code).toBe("continue_target_required");
  });

  it("rejects session identifiers that look like CLI flags", async () => {
    const dir = await tempDir();
    const continued = envelope(
      await grokContinue({ cwd: dir, ...roots(dir), prompt: "continue", sessionId: "--help" })
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
      grokRun({ cwd: dir, ...roots(dir), prompt: "state isolation probe" })
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
        grokRun({ cwd, ...roots(root), prompt: "root-wide state isolation probe" })
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
        grokRun({ cwd: root, ...roots(root), prompt: "ancestor state isolation probe" })
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
    expect(result.content[0].text).not.toContain("ENOTDIR");
  });
});
